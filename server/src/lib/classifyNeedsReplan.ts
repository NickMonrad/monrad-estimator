/**
 * classifyNeedsReplan.ts — Reviewed production maintenance path for issue #449.
 *
 * Classifies an explicitly supplied, reviewed set of projects as NEEDS_REPLAN
 * using the same atomic reset transaction as the normal product action.
 *
 * Design constraints (issue #449):
 *   - dry-run by default; an explicit --apply flag is required to write;
 *   - accepts exact project identifiers from a reviewed input manifest —
 *     never invents selection rules on production;
 *   - reports intended projects/operations before applying;
 *   - fails closed when the target state changed unexpectedly (a manifest
 *     project no longer exists, or the manifest is malformed);
 *   - performs NO capacity inference, profile reconstruction, percentage,
 *     window or owner-kind decisions;
 *   - supports sanitized evidence output (operator-supplied IDs only, no
 *     project names, payloads or connection details).
 *
 * This is deliberately NOT a generic remediation framework: it is one focused
 * command for the reviewed #404 migration classification step.
 */

import type { PrismaClient } from '@prisma/client'

import { resetProjectPlanning } from './resetProjectPlanning.js'

export class ClassifyManifestError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ClassifyManifestError'
  }
}

export class ClassifyAbortError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ClassifyAbortError'
  }
}

export interface ClassifyManifest {
  projectIds: string[]
}

/**
 * Parse and validate a reviewed classification manifest.
 *
 * Accepts `{ "projectIds": ["<id>", ...] }` with non-empty, unique string
 * identifiers. Anything else fails closed with an actionable error.
 */
export function parseClassifyManifest(raw: unknown): ClassifyManifest {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ClassifyManifestError('manifest must be a JSON object with a "projectIds" array')
  }
  const obj = raw as Record<string, unknown>
  if (!Array.isArray(obj.projectIds)) {
    throw new ClassifyManifestError('manifest must include a "projectIds" array')
  }
  const seen = new Set<string>()
  const projectIds: string[] = []
  for (const id of obj.projectIds) {
    if (typeof id !== 'string' || id.trim() === '') {
      throw new ClassifyManifestError('every manifest projectId must be a non-empty string')
    }
    if (seen.has(id)) {
      throw new ClassifyManifestError(`manifest contains a duplicate projectId: ${id}`)
    }
    seen.add(id)
    projectIds.push(id)
  }
  if (projectIds.length === 0) {
    throw new ClassifyManifestError('manifest "projectIds" must not be empty')
  }
  return { projectIds }
}

export type ClassificationStatus = 'to-classify' | 'already-needs-replan' | 'not-found'

export interface ClassificationEntry {
  projectId: string
  status: ClassificationStatus
}

export interface ClassificationReport {
  /** True when every manifest project is classified (or already classified). */
  completed: boolean
  entries: ClassificationEntry[]
  classifiedCount: number
  alreadyCount: number
  notFoundCount: number
}

/**
 * Read-only classification plan. Never writes.
 *
 * Each manifest project is classified as:
 *   - `to-classify`         — exists and is CURRENT (or any non-NEEDS_REPLAN value);
 *   - `already-needs-replan`— already explicitly quarantined (idempotent skip);
 *   - `not-found`           — missing; the apply run must abort (fail closed).
 */
export async function planClassification(
  prisma: PrismaClient,
  manifest: ClassifyManifest,
): Promise<ClassificationReport> {
  const projects = await prisma.project.findMany({
    where: { id: { in: manifest.projectIds } },
    select: { id: true, planningState: true },
  })
  const byId = new Map(projects.map(p => [p.id, p]))

  const entries: ClassificationEntry[] = manifest.projectIds.map(projectId => {
    const project = byId.get(projectId)
    if (!project) return { projectId, status: 'not-found' }
    return {
      projectId,
      status: project.planningState === 'NEEDS_REPLAN' ? 'already-needs-replan' : 'to-classify',
    }
  })

  return summarizeClassification(entries)
}

function summarizeClassification(entries: ClassificationEntry[]): ClassificationReport {
  return {
    completed: entries.every(e => e.status !== 'not-found'),
    entries,
    classifiedCount: entries.filter(e => e.status === 'to-classify').length,
    alreadyCount: entries.filter(e => e.status === 'already-needs-replan').length,
    notFoundCount: entries.filter(e => e.status === 'not-found').length,
  }
}

/**
 * Classify the reviewed project set as NEEDS_REPLAN.
 *
 * In dry-run mode (`apply: false`, the default) this only plans and reports.
 * In apply mode every `to-classify` project goes through the same atomic
 * reset service transaction the product uses — planning state is discarded,
 * business data preserved, and the project marked NEEDS_REPLAN. No capacity
 * is inferred or reconstructed anywhere in this command.
 *
 * Fails closed (throws {@link ClassifyAbortError}) when any manifest project
 * is missing, so an unexpected state change between review and apply never
 * classifies silently.
 */
export async function classifyNeedsReplan(
  prisma: PrismaClient,
  manifest: ClassifyManifest,
  options: { apply?: boolean } = {},
): Promise<ClassificationReport> {
  const plan = await planClassification(prisma, manifest)
  if (!plan.completed) {
    throw new ClassifyAbortError(
      `Classification aborted: ${plan.notFoundCount} manifest project(s) no longer exist. ` +
      'Re-review the manifest before retrying; nothing was changed.',
    )
  }
  if (!options.apply) {
    return plan
  }

  for (const entry of plan.entries) {
    if (entry.status !== 'to-classify') continue
    await resetProjectPlanning(prisma, entry.projectId)
  }
  return plan
}

/** Render the report as aggregate sanitized evidence (IDs are operator-supplied). */
export function formatClassificationReport(report: ClassificationReport, apply: boolean): string {
  const lines: string[] = []
  lines.push(apply
    ? 'Mode: APPLY — each listed project was classified NEEDS_REPLAN via the atomic reset transaction.'
    : 'Mode: DRY RUN (default) — zero writes.')
  lines.push(`Manifest projects: ${report.entries.length}`)
  lines.push(`Will classify / classified: ${report.classifiedCount}`)
  lines.push(`Already NEEDS_REPLAN (skipped): ${report.alreadyCount}`)
  lines.push(`Not found (fail closed): ${report.notFoundCount}`)
  if (report.classifiedCount > 0) {
    lines.push('Project IDs:')
    for (const entry of report.entries) {
      if (entry.status === 'to-classify') lines.push(`  - ${entry.projectId}`)
    }
  }
  return lines.join('\n')
}
