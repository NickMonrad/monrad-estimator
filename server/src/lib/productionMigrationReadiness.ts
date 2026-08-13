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
 *  3. Snapshot version policy (issue #444/#405) — every stored BacklogSnapshot
 *     is classified by schema version only. Any V1/V2/V3 snapshot is a blocker
 *     (it must be deliberately purged before the destructive migration); any
 *     malformed/unsupported payload blocks; any structurally invalid V4 or V5
 *     payload blocks. Valid V4 and valid V5 snapshots pass. No historical
 *     translation, quarantine or decision analysis runs here.
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
import { classifySnapshotVersion } from './snapshotVersionClassification.js'

// ─── Report types ────────────────────────────────────────────────────────────

export interface ReadinessSection {
  name: string
  passed: boolean
  blockers: string[]
  /** Policy-accepted derived-quarantined records (never blockers). */
  notes?: string[]
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
      planningState: true,
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
  let quarantinedCount = 0
  for (const project of projects) {
    const prefix = `project "${project.name}" (${project.id})`
    if (project.planningState === 'NEEDS_REPLAN') {
      // Issue #449: a NEEDS_REPLAN project deliberately retired its planning
      // state (Reset Planning / the reviewed maintenance classification).
      // Expected missing planning state is allowed here ONLY because the
      // state is explicitly persisted and planning-dependent execution is
      // quarantined until the project is replanned. The global ownership
      // audit section still fails on cross-project ownership, impossible
      // FK/ownership relationships and duplicate owners where rows remain —
      // NEEDS_REPLAN is never a generic "ignore this project" switch.
      quarantinedCount++
      continue
    }
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
    notes: quarantinedCount > 0
      ? [`NEEDS_REPLAN projects (intentional planning quarantine): ${quarantinedCount}`]
      : undefined,
  }
}

async function checkSnapshots(prisma: PrismaClient): Promise<ReadinessSection> {
  // Only project snapshots can carry ResourceType/NamedResource/CapacityProfile
  // state. TemplateSnapshot rows store FeatureTemplate objects (raw template
  // state, not project snapshots) and are deliberately NOT inspected — a
  // normal template snapshot must never block the migration readiness check.
  const backlogSnapshots = await prisma.backlogSnapshot.findMany({
    select: { snapshot: true },
  })

  // Issue #444/#405: classify stored payloads by schema version only (V4 is
  // the minimum supported snapshot format; V5 is the current write format).
  // Aggregate counts, never identifiers. Any pre-V4 row is a blocker because
  // it must be purged before the destructive migration; malformed/unsupported
  // payloads and invalid V4 or V5 payloads also block. No historical
  // translation semantics are evaluated.
  let preV4Count = 0
  let malformedCount = 0
  let invalidV4Count = 0
  let validV4Count = 0
  let invalidV5Count = 0
  let validV5Count = 0
  for (const snapshot of backlogSnapshots) {
    const version = classifySnapshotVersion(snapshot.snapshot)
    switch (version.kind) {
      case 'v1':
      case 'v2':
      case 'v3':
        preV4Count++
        break
      case 'v4':
        if (version.valid) validV4Count++
        else invalidV4Count++
        break
      case 'v5':
        if (version.valid) validV5Count++
        else invalidV5Count++
        break
      case 'malformed':
        malformedCount++
        break
    }
  }

  const blockers: string[] = []
  if (preV4Count > 0) blockers.push(`pre-V4 BacklogSnapshots remain: ${preV4Count}`)
  if (malformedCount > 0) blockers.push(`malformed/unsupported BacklogSnapshots: ${malformedCount}`)
  if (invalidV4Count > 0) blockers.push(`invalid V4 BacklogSnapshots: ${invalidV4Count}`)
  if (invalidV5Count > 0) blockers.push(`invalid V5 BacklogSnapshots: ${invalidV5Count}`)

  const notes: string[] = []
  if (validV4Count > 0) notes.push(`valid V4 BacklogSnapshots: ${validV4Count}`)
  if (validV5Count > 0) notes.push(`valid V5 BacklogSnapshots: ${validV5Count}`)

  return {
    name: 'snapshot version policy (V4 minimum)',
    passed: blockers.length === 0,
    blockers,
    notes: notes.length > 0 ? notes : undefined,
  }
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
    for (const note of section.notes ?? []) {
      lines.push(`   · ${note}`)
    }
    lines.push('')
  }
  lines.push(report.passed
    ? '✅ READINESS PASSED — the migration prerequisites are satisfied.'
    : '❌ READINESS FAILED — resolve every blocker before migrating. Do not run the destructive migration.')
  return lines.join('\n')
}
