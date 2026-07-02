/**
 * reconcileCapacityProfiles.ts — Reconciliation/parity helper for capacity profiles.
 *
 * Compares legacy mapper-derived profiles against persisted CapacityProfile/CapacitySegment
 * rows to detect mismatches. Used by the backfill runner to verify data integrity.
 */
import type { PrismaClient } from '@prisma/client'

import { mapProjectToCapacityProfiles } from './capacityProfileMapping.js'
import type {
  CapacityProfileResourceTypeLike,
  CapacityProfileNamedResourceLike,
  CapacityPlanSlotInput,
} from './capacityProfileMapping.js'
import { materializeCapacityPlanResources } from './capacityPlanMaterialisation.js'

// ─── Report types ──────────────────────────────────────────────────────────

export type CapacityProfileMismatchType =
  | 'missingPersistedProfile'
  | 'extraPersistedProfile'
  | 'duplicatePersistedProfile'
  | 'profileFieldMismatch'
  | 'segmentMismatch'

export interface CapacityProfileMismatch {
  projectId: string
  ownerKind: string
  ownerId: string
  type: CapacityProfileMismatchType
  message: string
  expected?: unknown
  actual?: unknown
}

export interface CapacityProfileReconciliationReport {
  projectsChecked: number
  expectedProfiles: number
  actualProfiles: number
  matchedProfiles: number
  mismatches: CapacityProfileMismatch[]
}

// ─── Helpers ───────────────────────────────────────────────────────────────

/**
 * Build a stable key for a profile based on owner semantics.
 * Uses projectId + ownerKind + resourceTypeId for role-owned profiles,
 * and projectId + ownerKind + namedResourceId for named/planned-resource profiles.
 */
function profileKey(
  projectId: string,
  ownerKind: string,
  ownerId: string,
): string {
  return `${projectId}::${ownerKind}::${ownerId}`
}

/**
 * Normalize Prisma enum value (UPPER_SNAKE_CASE) to camelCase for comparison.
 * E.g., DEMAND_FOLLOWING → demandFollowing, SQUAD_PLANNER → squadPlanner
 */
function normalizeEnum(value: string): string {
  return value
    .toLowerCase()
    .replace(/_([a-z])/g, (_, c) => c.toUpperCase())
}
/**

 * Compare two values, treating null and undefined as equivalent.
 */
function valuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a == null && b == null) return true
  return false
}

/**
 * Compare two values and return a mismatch if they differ.
 */
function compareField(
  projectId: string,
  ownerKind: string,
  ownerId: string,
  fieldName: string,
  expected: unknown,
  actual: unknown,
): CapacityProfileMismatch | null {
  if (valuesEqual(expected, actual)) return null

  return {
    projectId,
    ownerKind,
    ownerId,
    type: 'profileFieldMismatch',
    message: `${fieldName} mismatch`,
    expected,
    actual,
  }
}

// ─── Main reconciliation function ─────────────────────────────────────────

/**
 * Reconcile mapper-derived profiles against persisted CapacityProfile/CapacitySegment rows.
 *
 * @param prisma - PrismaClient instance
 * @returns Reconciliation report with any mismatches found
 */
export async function reconcileCapacityProfiles(
  prisma: PrismaClient,
): Promise<CapacityProfileReconciliationReport> {
  const report: CapacityProfileReconciliationReport = {
    projectsChecked: 0,
    expectedProfiles: 0,
    actualProfiles: 0,
    matchedProfiles: 0,
    mismatches: [],
  }

  // Fetch all projects with their resource types, named resources, and active capacity plans
  const projects = await prisma.project.findMany({
    include: {
      resourceTypes: {
        include: {
          namedResources: { orderBy: { createdAt: 'asc' as const } },
        },
      },
      capacityPlans: {
        where: { isActive: true },
        take: 1,
        include: {
          periods: {
            include: { entries: true },
            orderBy: { periodIndex: 'asc' as const },
          },
        },
      },
      capacityProfiles: {
        include: {
          segments: { orderBy: { startWeek: 'asc' as const } },
        },
      },
    },
  })

  for (const project of projects) {
    report.projectsChecked++

    // Materialize active capacity plan into slot windows
    const activePlan = project.capacityPlans?.[0] ?? null
    const capacityPlanByRt = materializeCapacityPlanResources(
      activePlan?.periods ?? [],
    )

    const capacityPlanSlotsByResourceTypeId = new Map<string, CapacityPlanSlotInput[]>(
      Array.from(capacityPlanByRt.entries()).map(([rtId, materialized]) => [
        rtId,
        materialized.slotWindows,
      ]),
    )

    // Build named resources lookup
    const namedResourcesByResourceTypeId = new Map<
      string,
      CapacityProfileNamedResourceLike[]
    >()
    for (const rt of project.resourceTypes) {
      namedResourcesByResourceTypeId.set(
        rt.id,
        rt.namedResources as unknown as CapacityProfileNamedResourceLike[],
      )
    }

    // Derive expected capacity profiles using the existing mapper
    const expectedProfiles = mapProjectToCapacityProfiles({
      projectId: project.id,
      resourceTypes:
        project.resourceTypes as unknown as CapacityProfileResourceTypeLike[],
      namedResourcesByResourceTypeId,
      capacityPlanSlotsByResourceTypeId,
    })

    report.expectedProfiles += expectedProfiles.length

    // Build map of persisted profiles by owner key (first per key is canonical)
    const persistedProfiles = project.capacityProfiles
    report.actualProfiles += persistedProfiles.length

    const persistedByKey = new Map<string, typeof persistedProfiles[number]>()
    const duplicateKeys = new Set<string>()
    for (const pp of persistedProfiles) {
      const kind = normalizeEnum(pp.ownerKind)
      const ownerId = pp.resourceTypeId ?? pp.namedResourceId ?? ''
      const key = profileKey(project.id, kind, ownerId)
      if (persistedByKey.has(key)) {
        // Duplicate persisted profile for same owner — record mismatch
        duplicateKeys.add(key)
        report.mismatches.push({
          projectId: project.id,
          ownerKind: kind,
          ownerId,
          type: 'duplicatePersistedProfile',
          message: `Duplicate persisted profile for ${kind} owner ${ownerId} (id: ${pp.id})`,
          expected: persistedByKey.get(key)!.id,
          actual: pp.id,
        })
      } else {
        persistedByKey.set(key, pp)
      }
    }

    // Track key sets for extra detection vs fully-matched counting:
    //   comparedPersistedKeys — every key where an expected profile found a persisted row
    //   duplicateKeys — keys where >1 persisted row existed (from duplicate detection above)
    const comparedPersistedKeys = new Set<string>()

    // Compare each expected profile against persisted
    for (const expected of expectedProfiles) {
      const kind = expected.owner.kind
      const ownerId = expected.owner.id
      const key = profileKey(project.id, kind, ownerId)

      const persisted = persistedByKey.get(key)

      if (!persisted) {
        report.mismatches.push({
          projectId: project.id,
          ownerKind: kind,
          ownerId,
          type: 'missingPersistedProfile',
          message: `No persisted profile found for ${kind} owner ${ownerId}`,
          expected: { ownerKind: kind, ownerId },
        })
        continue
      }

      // Record that we found a persisted row for this key (regardless of field match quality)
      comparedPersistedKeys.add(key)

      // Compare profile fields
      const mismatchesBefore = report.mismatches.length

      const fieldMismatches = [
        compareField(project.id, kind, ownerId, 'ownerKind', kind, normalizeEnum(persisted.ownerKind)),
        compareField(project.id, kind, ownerId, 'planningBasis', expected.planningBasis, normalizeEnum(persisted.planningBasis)),
        compareField(project.id, kind, ownerId, 'source', expected.source, normalizeEnum(persisted.source)),
        compareField(project.id, kind, ownerId, 'defaultPercent', expected.defaultPercent ?? null, persisted.defaultPercent),
        compareField(project.id, kind, ownerId, 'startWeek', expected.startWeek ?? null, persisted.startWeek),
        compareField(project.id, kind, ownerId, 'endWeek', expected.endWeek ?? null, persisted.endWeek),
      ].filter(Boolean) as CapacityProfileMismatch[]

      report.mismatches.push(...fieldMismatches)

      // Compare segments
      const expectedSegments = [...expected.segments].sort((a, b) => a.startWeek - b.startWeek)
      const actualSegments = [...persisted.segments].sort((a, b) => a.startWeek - b.startWeek)

      if (expectedSegments.length !== actualSegments.length) {
        report.mismatches.push({
          projectId: project.id,
          ownerKind: kind,
          ownerId,
          type: 'segmentMismatch',
          message: `Segment count mismatch: expected ${expectedSegments.length}, got ${actualSegments.length}`,
          expected: expectedSegments.length,
          actual: actualSegments.length,
        })
      }

      // Compare segments pairwise (up to the minimum count)
      const minSegmentCount = Math.min(expectedSegments.length, actualSegments.length)
      for (let i = 0; i < minSegmentCount; i++) {
        const exp = expectedSegments[i]
        const act = actualSegments[i]

        const segMismatches = [
          compareField(project.id, kind, ownerId, `segment[${i}].startWeek`, exp.startWeek, act.startWeek),
          compareField(project.id, kind, ownerId, `segment[${i}].endWeek`, exp.endWeek, act.endWeek),
          compareField(project.id, kind, ownerId, `segment[${i}].capacityPercent`, exp.capacityPercent, act.capacityPercent),
          compareField(project.id, kind, ownerId, `segment[${i}].source`, exp.source, normalizeEnum(act.source)),
        ].filter(Boolean) as CapacityProfileMismatch[]

        report.mismatches.push(...segMismatches)
      }

      // Only count as fully matched if no mismatches were added for this profile
      // AND no duplicate key exists for this owner (duplicate means data is inconsistent)
      if (report.mismatches.length === mismatchesBefore && !duplicateKeys.has(key)) {
        report.matchedProfiles++
      }
    }

    // Detect extra persisted profiles (not found by any expected profile)
    for (const [key, pp] of persistedByKey) {
      if (!comparedPersistedKeys.has(key)) {
        const kind = normalizeEnum(pp.ownerKind)
        const ownerId = pp.resourceTypeId ?? pp.namedResourceId ?? ''
        report.mismatches.push({
          projectId: project.id,
          ownerKind: kind,
          ownerId,
          type: 'extraPersistedProfile',
          message: `Persisted profile found with no corresponding expected profile for ${kind} owner ${ownerId}`,
          actual: { ownerKind: kind, ownerId },
        })
      }
    }
  }

  return report
}

// ─── Report formatting ─────────────────────────────────────────────────────

/**
 * Format a reconciliation report as a human-readable string.
 */
export function formatReconciliationReport(
  report: CapacityProfileReconciliationReport,
): string {
  const lines = [
    `Projects checked:     ${report.projectsChecked}`,
    `Expected profiles:    ${report.expectedProfiles}`,
    `Actual profiles:      ${report.actualProfiles}`,
    `Matched profiles:     ${report.matchedProfiles}`,
    `Mismatches:           ${report.mismatches.length}`,
  ]

  if (report.mismatches.length > 0) {
    lines.push('')
    lines.push('Mismatches:')
    for (const m of report.mismatches) {
      lines.push(`  - [${m.type}] ${m.message}`)
      if (m.expected !== undefined) lines.push(`    expected: ${JSON.stringify(m.expected)}`)
      if (m.actual !== undefined) lines.push(`    actual:   ${JSON.stringify(m.actual)}`)
    }
  }

  return lines.join('\n')
}
