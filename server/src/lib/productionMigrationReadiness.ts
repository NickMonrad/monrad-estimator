/**
 * productionMigrationReadiness.ts — Standalone read-only production-readiness
 * check for the legacy capacity-column migration (issue #418, executed later
 * by the production machine under #404).
 *
 * Guarantees:
 *  - NEVER runs during application startup or from an HTTP request; it is
 *    invoked explicitly by the CLI script only.
 *  - Performs NO writes, repair, reconciliation or cache clearing.
 *  - Connects only through the explicitly supplied database configuration.
 *
 * Checks:
 *  1. Ownership audit — every CapacityProfile has exactly one valid owner FK
 *     with matching ownerKind, existing in-project owner, no duplicates and
 *     no cross-project ownership (reuses runOwnershipAudit).
 *  2. Per-project profile completeness and shape — every named resource has
 *     exactly one valid profile; every role has a ROLE profile unless all of
 *     its named resources are explicit NAMED_PERSON profiles; profile and
 *     segment shapes follow the authoritative validation rules (reuses
 *     validatePersistedCapacityProfiles + checkPersistedCompleteness).
 *  3. Historical snapshot translatability — every stored BacklogSnapshot and
 *     TemplateSnapshot parses as v1/v2/v3/v4; v2 legacy capacity values are
 *     structurally translatable to profiles; v3/v4 payloads validate against
 *     the authoritative snapshot rules.
 *
 * Exit contract: the CLI exits 0 only when every section passes. Any blocker
 * yields a non-zero exit with an actionable human-readable report.
 */

import type { PrismaClient } from '@prisma/client'
import {
  runOwnershipAudit,
} from './capacityProfileOwnershipAudit.js'
import {
  validatePersistedCapacityProfiles,
  checkPersistedCompleteness,
} from './persistedCapacityProfileValidation.js'
import {
  parseSnapshotData,
  isLegacyV1Snapshot,
  isSnapshotV2,
  type SnapshotV2,
} from './projectSnapshotTypes.js'
import { validateSnapshotV3 } from './projectSnapshotValidation.js'

// ─── Report types ────────────────────────────────────────────────────────────

export interface ReadinessSection {
  name: string
  passed: boolean
  blockers: string[]
}

export interface ReadinessReport {
  passed: boolean
  sections: ReadinessSection[]
}

export class ReadinessError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ReadinessError'
  }
}

// ─── Historical v2 snapshot translation validation (read-only) ───────────────

/**
 * Validate that a historical v2 snapshot's legacy capacity values are
 * structurally translatable to authoritative profiles (the same input
 * recreateV2CapacityProfiles consumes). Read-only: nothing is written.
 *
 * The v2→profile mapping is total for known enum values; translatability
 * fails only when the captured values are structurally unusable.
 */
export function validateV2SnapshotTranslation(v2: SnapshotV2): string[] {
  const errors: string[] = []
  const KNOWN_MODES = new Set(['EFFORT', 'TIMELINE', 'FULL_PROJECT', 'CAPACITY_PLAN'])

  for (let i = 0; i < v2.resourceTypes.length; i++) {
    const rt = v2.resourceTypes[i]
    const pfx = `v2 snapshot resourceTypes[${i}] (${rt.name})`
    if (rt.allocationMode != null && !KNOWN_MODES.has(rt.allocationMode)) {
      errors.push(`${pfx}: unknown allocationMode "${String(rt.allocationMode)}"`)
    }
    if (rt.allocationPercent != null && !Number.isFinite(rt.allocationPercent)) {
      errors.push(`${pfx}: allocationPercent must be finite`)
    }
    for (const [key, value] of [
      ['allocationStartWeek', rt.allocationStartWeek],
      ['allocationEndWeek', rt.allocationEndWeek],
    ] as const) {
      if (value != null && (!Number.isFinite(value) || !Number.isInteger(value) || value < 0)) {
        errors.push(`${pfx}: ${key} must be a non-negative integer or null`)
      }
    }
  }

  for (let i = 0; i < v2.namedResources.length; i++) {
    const nr = v2.namedResources[i]
    const pfx = `v2 snapshot namedResources[${i}] (${nr.name})`
    if (nr.allocationMode != null && !KNOWN_MODES.has(nr.allocationMode)) {
      errors.push(`${pfx}: unknown allocationMode "${String(nr.allocationMode)}"`)
    }
    for (const [key, value] of [
      ['allocationPercent', nr.allocationPercent],
      ['allocationPct', nr.allocationPct],
    ] as const) {
      if (value != null && !Number.isFinite(value)) {
        errors.push(`${pfx}: ${key} must be finite`)
      }
    }
    for (const [key, value] of [
      ['allocationStartWeek', nr.allocationStartWeek],
      ['allocationEndWeek', nr.allocationEndWeek],
      ['startWeek', nr.startWeek],
      ['endWeek', nr.endWeek],
    ] as const) {
      if (value != null && (!Number.isFinite(value) || !Number.isInteger(value) || value < 0)) {
        errors.push(`${pfx}: ${key} must be a non-negative integer or null`)
      }
    }
  }

  return errors
}

// ─── Section checks ──────────────────────────────────────────────────────────

async function checkOwnership(prisma: PrismaClient): Promise<ReadinessSection> {
  const audit = await runOwnershipAudit(prisma)
  const blockers = audit.findings
    .filter(f => f.severity === 'error')
    .map(f => f.message)
  return {
    name: 'capacity-profile ownership audit',
    passed: audit.isClean && blockers.length === 0,
    blockers,
  }
}

async function checkProjectCompleteness(prisma: PrismaClient): Promise<ReadinessSection> {
  const projects = await prisma.project.findMany({
    select: {
      id: true,
      name: true,
      resourceTypes: {
        include: { namedResources: { orderBy: { createdAt: 'asc' as const } } },
      },
      capacityProfiles: {
        include: {
          segments: {
            orderBy: [{ startWeek: 'asc' as const }, { endWeek: 'asc' as const }],
          },
        },
      },
    },
  })

  const blockers: string[] = []
  for (const project of projects) {
    const prefix = `project "${project.name}" (${project.id})`
    const resourceTypeIds = new Set(project.resourceTypes.map(rt => rt.id))
    const namedResourceIds = new Set(
      project.resourceTypes.flatMap(rt => rt.namedResources.map(nr => nr.id)),
    )
    const validation = validatePersistedCapacityProfiles(
      project.capacityProfiles as Parameters<typeof validatePersistedCapacityProfiles>[0],
      { projectId: project.id, resourceTypeIds, namedResourceIds },
    )
    for (const error of validation.errors) {
      blockers.push(`${prefix}: ${error}`)
    }
    const completenessErrors = checkPersistedCompleteness({
      resourceTypes: project.resourceTypes.map(rt => ({
        id: rt.id,
        name: rt.name,
        namedResources: rt.namedResources.map(nr => ({ id: nr.id, name: nr.name })),
      })),
      capacityProfiles: project.capacityProfiles.map(profile => ({
        resourceTypeId: profile.resourceTypeId,
        namedResourceId: profile.namedResourceId,
        ownerKind: String(profile.ownerKind),
        source: String(profile.source),
        planningBasis: String(profile.planningBasis),
      })),
    })
    for (const error of completenessErrors) {
      blockers.push(`${prefix}: ${error}`)
    }
  }

  return {
    name: 'per-project profile completeness and shape',
    passed: blockers.length === 0,
    blockers,
  }
}

async function checkSnapshots(prisma: PrismaClient): Promise<ReadinessSection> {
  const [backlogSnapshots, templateSnapshots] = await Promise.all([
    prisma.backlogSnapshot.findMany({ select: { id: true, projectId: true } }),
    prisma.templateSnapshot.findMany({ select: { id: true, templateId: true } }),
  ])

  const blockers: string[] = []
  for (const snapshot of backlogSnapshots) {
    const raw = await prisma.backlogSnapshot.findUnique({
      where: { id: snapshot.id },
      select: { snapshot: true },
    })
    if (!raw) {
      blockers.push(`backlog snapshot ${snapshot.id}: row vanished during check`)
      continue
    }
    blockers.push(...validateStoredSnapshot(raw.snapshot, `backlog snapshot ${snapshot.id} (project ${snapshot.projectId})`))
  }
  for (const snapshot of templateSnapshots) {
    const raw = await prisma.templateSnapshot.findUnique({
      where: { id: snapshot.id },
      select: { snapshot: true },
    })
    if (!raw) {
      blockers.push(`template snapshot ${snapshot.id}: row vanished during check`)
      continue
    }
    blockers.push(...validateStoredSnapshot(raw.snapshot, `template snapshot ${snapshot.id} (template ${snapshot.templateId})`))
  }

  return {
    name: 'historical snapshot parseability and translatability',
    passed: blockers.length === 0,
    blockers,
  }
}

function validateStoredSnapshot(raw: unknown, label: string): string[] {
  let parsed: unknown
  try {
    parsed = parseSnapshotData(raw)
  } catch (error) {
    return [
      `${label}: unsupported or malformed snapshot data — ${error instanceof Error ? error.message : String(error)}`,
    ]
  }

  if (isLegacyV1Snapshot(parsed)) return []
  if (isSnapshotV2(parsed)) {
    return validateV2SnapshotTranslation(parsed).map(error => `${label}: ${error}`)
  }
  try {
    validateSnapshotV3(parsed as Parameters<typeof validateSnapshotV3>[0])
  } catch (error) {
    return [
      `${label}: invalid payload — ${error instanceof Error ? error.message : String(error)}`,
    ]
  }
  return []
}

// ─── Main check ──────────────────────────────────────────────────────────────

/**
 * Run the complete read-only readiness check.
 *
 * @param prisma Connected PrismaClient (never disconnected here).
 * @returns Structured report; callers decide the exit code.
 */
export async function runProductionMigrationReadiness(
  prisma: PrismaClient,
): Promise<ReadinessReport> {
  const sections = await Promise.all([
    checkOwnership(prisma),
    checkProjectCompleteness(prisma),
    checkSnapshots(prisma),
  ])
  return {
    passed: sections.every(section => section.passed),
    sections,
  }
}

/** Render the report as a clear human-readable summary. */
export function formatReadinessReport(report: ReadinessReport): string {
  const lines: string[] = []
  lines.push('═══ Production Migration Readiness Check ═══')
  lines.push('')
  lines.push('Mode: READ-ONLY — no writes, no repair, no reconciliation.')
  lines.push('')
  for (const section of report.sections) {
    lines.push(section.passed ? `✅ ${section.name}: PASS` : `❌ ${section.name}: FAIL`)
    for (const blocker of section.blockers) {
      lines.push(`   - ${blocker}`)
    }
    lines.push('')
  }
  lines.push(report.passed
    ? '✅ READINESS PASSED — the migration prerequisites are satisfied.'
    : '❌ READINESS FAILED — resolve every blocker before migrating. Do not run the destructive migration.')
  return lines.join('\n')
}
