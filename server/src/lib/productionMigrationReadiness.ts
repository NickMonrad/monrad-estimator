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
 *  3. Historical snapshot restorability — every stored BacklogSnapshot and
 *     TemplateSnapshot is classified by the shared restorability classifier
 *     (issue #428): v2 legacy capacity values must be structurally
 *     translatable or match an approved derived-quarantine shape (Class A/B,
 *     policy-accepted and never blocking); v3/v4 payloads validate against
 *     the authoritative snapshot rules; every other failure class blocks.
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
import { classifySnapshotRestorability } from './snapshotRestorability.js'

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
  // Only project snapshots can carry ResourceType/NamedResource/CapacityProfile
  // state. TemplateSnapshot rows store FeatureTemplate objects (raw template
  // state, not project snapshots) and are deliberately NOT inspected — a
  // normal template snapshot must never block the migration readiness check.
  const backlogSnapshots = await prisma.backlogSnapshot.findMany({
    select: { id: true, projectId: true, snapshot: true },
  })

  const blockers: string[] = []
  const notes: string[] = []
  for (const snapshot of backlogSnapshots) {
    const label = `backlog snapshot ${snapshot.id} (project ${snapshot.projectId})`
    // Issue #428: the shared classifier derives the verdict from the stored
    // content — approved historical quarantine is policy-accepted and never
    // blocks; every defect class (malformed, unsupported, any other
    // validation failure) stays a blocker.
    const restorability = classifySnapshotRestorability(snapshot.snapshot, snapshot.projectId)
    if (restorability.kind === 'quarantined') {
      notes.push(`${label}: quarantined (policy-accepted, non-restorable) — ${restorability.restoreReason}`)
    } else if (restorability.kind === 'defect') {
      blockers.push(`${label}: ${restorability.restoreReason}`)
    }
  }

  return {
    name: 'historical snapshot parseability and translatability',
    passed: blockers.length === 0,
    blockers,
    notes,
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
