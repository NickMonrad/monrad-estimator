/**
 * reconcileCapacityProfiles.ts — Reconciliation/parity helper for capacity profiles.
 *
 * Compares legacy mapper-derived profiles against persisted CapacityProfile/CapacitySegment
 * rows to detect mismatches. Used by the backfill runner and diagnostic tooling to verify
 * data integrity; the read-only capacity-profile endpoint uses structural validation and
 * no longer uses this helper as a lossy persisted-read gate.
 */
import type { PrismaClient } from '@prisma/client'

import { mapProjectToCapacityProfiles } from './capacityProfileMapping.js'
import type {
  CapacityProfileResourceTypeLike,
  CapacityProfileNamedResourceLike,
  CapacityPlanSlotInput,
  CapacityProfileDTO,
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

/** Per-project slice returned by compareCapacityProfiles. */
export interface PerProjectComparison {
  expectedProfiles: number
  actualProfiles: number
  matchedProfiles: number
  mismatches: CapacityProfileMismatch[]
}

// ─── Helpers (exported for reuse by endpoint and mapper) ────────────────────

/**
 * Build a stable key for a profile based on owner semantics.
 * Uses projectId + ownerKind + resourceTypeId for role-owned profiles,
 * and projectId + ownerKind + namedResourceId for named/planned-resource profiles.
 */
export function profileKey(
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
export function normalizeEnum(value: string): string {
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

// ─── Pure comparison (no DB access) ────────────────────────────────────────

/**
 * Compare expected (mapper-derived) profiles against persisted profiles
 * for a single project. This is a pure function — no database access.
 *
 * The caller is responsible for fetching the persisted profiles and segments
 * (with included segments) and deriving the expected profiles via mapProjectToCapacityProfiles.
 */
export function compareCapacityProfiles(
  projectId: string,
  expectedProfiles: CapacityProfileDTO[],
  persistedProfiles: ReadonlyArray<{
    id: string
    resourceTypeId: string | null
    namedResourceId: string | null
    ownerKind: string
    planningBasis: string
    source: string
    defaultPercent: number | null
    startWeek: number | null
    endWeek: number | null
    segments: ReadonlyArray<{
      startWeek: number
      endWeek: number
      capacityPercent: number
      source: string
    }>
  }>,
): PerProjectComparison {
  const mismatches: CapacityProfileMismatch[] = []
  let matchedProfiles = 0

  // Build map of persisted profiles by owner key (first per key is canonical)
  const persistedByKey = new Map<string, (typeof persistedProfiles)[number]>()
  const duplicateKeys = new Set<string>()
  for (const pp of persistedProfiles) {
    const kind = normalizeEnum(pp.ownerKind)
    const ownerId = pp.resourceTypeId ?? pp.namedResourceId ?? ''
    const key = profileKey(projectId, kind, ownerId)
    if (persistedByKey.has(key)) {
      duplicateKeys.add(key)
      mismatches.push({
        projectId,
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

  // Track keys where an expected profile found a persisted row
  const comparedPersistedKeys = new Set<string>()

  // Compare each expected profile against persisted
  for (const expected of expectedProfiles) {
    const kind = expected.owner.kind
    const ownerId = expected.owner.id
    const key = profileKey(projectId, kind, ownerId)

    const persisted = persistedByKey.get(key)
      ?? (kind === 'namedPerson'
        ? persistedByKey.get(profileKey(projectId, 'plannedResource', ownerId))
        : undefined)

    if (!persisted) {
      mismatches.push({
        projectId,
        ownerKind: kind,
        ownerId,
        type: 'missingPersistedProfile',
        message: `No persisted profile found for ${kind} owner ${ownerId}`,
        expected: { ownerKind: kind, ownerId },
      })
      continue
    }

    // Record the actual persisted key, including planned-resource aliases.
    const persistedKey = profileKey(projectId, normalizeEnum(persisted.ownerKind), persisted.resourceTypeId ?? persisted.namedResourceId ?? '')
    comparedPersistedKeys.add(persistedKey)

    // Compare profile fields
    const mismatchesBefore = mismatches.length

    const fieldMismatches = [
      compareField(
        projectId,
        kind,
        ownerId,
        'ownerKind',
        kind,
        kind === 'namedPerson' && normalizeEnum(persisted.ownerKind) === 'plannedResource'
          ? kind
          : normalizeEnum(persisted.ownerKind),
      ),
      compareField(projectId, kind, ownerId, 'planningBasis', expected.planningBasis, normalizeEnum(persisted.planningBasis)),
      compareField(projectId, kind, ownerId, 'source', expected.source, normalizeEnum(persisted.source)),
      compareField(projectId, kind, ownerId, 'defaultPercent', expected.defaultPercent ?? null, persisted.defaultPercent),
      compareField(projectId, kind, ownerId, 'startWeek', expected.startWeek ?? null, persisted.startWeek),
      compareField(projectId, kind, ownerId, 'endWeek', expected.endWeek ?? null, persisted.endWeek),
    ].filter(Boolean) as CapacityProfileMismatch[]

    mismatches.push(...fieldMismatches)

    // Compare segments
    const expectedSegments = [...expected.segments].sort((a, b) => a.startWeek - b.startWeek)
    const actualSegments = [...persisted.segments].sort((a, b) => a.startWeek - b.startWeek)

    if (expectedSegments.length !== actualSegments.length) {
      mismatches.push({
        projectId,
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
        compareField(projectId, kind, ownerId, `segment[${i}].startWeek`, exp.startWeek, act.startWeek),
        compareField(projectId, kind, ownerId, `segment[${i}].endWeek`, exp.endWeek, act.endWeek),
        compareField(projectId, kind, ownerId, `segment[${i}].capacityPercent`, exp.capacityPercent, act.capacityPercent),
        compareField(projectId, kind, ownerId, `segment[${i}].source`, exp.source, normalizeEnum(act.source)),
      ].filter(Boolean) as CapacityProfileMismatch[]

      mismatches.push(...segMismatches)
    }

    // Only count as fully matched if no mismatches were added for this profile
    // AND no duplicate key exists for this owner (duplicate means data is inconsistent)
    if (mismatches.length === mismatchesBefore && !duplicateKeys.has(key)) {
      matchedProfiles++
    }
  }

  // Detect extra persisted profiles (not found by any expected profile)
  for (const [key, pp] of persistedByKey) {
    if (!comparedPersistedKeys.has(key)) {
      const kind = normalizeEnum(pp.ownerKind)
      const ownerId = pp.resourceTypeId ?? pp.namedResourceId ?? ''
      mismatches.push({
        projectId,
        ownerKind: kind,
        ownerId,
        type: 'extraPersistedProfile',
        message: `Persisted profile found with no corresponding expected profile for ${kind} owner ${ownerId}`,
        actual: { ownerKind: kind, ownerId },
      })
    }
  }

  return {
    expectedProfiles: expectedProfiles.length,
    actualProfiles: persistedProfiles.length,
    matchedProfiles,
    mismatches,
  }
}

// ─── Main reconciliation function (all projects, DB) ───────────────────────

/**
 * Reconcile mapper-derived profiles against persisted CapacityProfile/CapacitySegment rows
 * for all projects. Uses the pure compareCapacityProfiles per project.
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

    const comparison = compareCapacityProfiles(
      project.id,
      expectedProfiles,
      project.capacityProfiles,
    )

    report.expectedProfiles += comparison.expectedProfiles
    report.actualProfiles += comparison.actualProfiles
    report.matchedProfiles += comparison.matchedProfiles
    report.mismatches.push(...comparison.mismatches)
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
