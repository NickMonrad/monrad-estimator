/**
 * classifyNeedsReplan.ts — Reviewed production maintenance path for issue #449.
 *
 * Classifies an explicitly supplied, reviewed set of projects as NEEDS_REPLAN
 * using the same atomic reset transaction body as the normal product action.
 *
 * Design constraints (issue #449 + review remediation):
 *   - dry-run by default; an explicit --apply flag is required to write;
 *   - accepts exact project identifiers from a reviewed input manifest —
 *     never invents selection rules on production;
 *   - dry-run emits a deterministic SHA-256 fingerprint over the
 *     reset-relevant state of the exact manifest set (`stateFingerprint`);
 *   - apply requires the reviewed fingerprint (`expectedFingerprint`) and
 *     verifies it INSIDE the batch transaction immediately before any write;
 *     any drift aborts with zero writes — a changed project can never be
 *     destructively reset on stale review evidence;
 *   - the complete manifest apply is ONE Prisma transaction: either every
 *     to-classify project is reset or none is (no partial batch);
 *   - reports intended projects/operations before applying;
 *   - fails closed when the target state changed unexpectedly (a manifest
 *     project no longer exists, or the manifest is malformed);
 *   - performs NO capacity inference, profile reconstruction, percentage,
 *     window or owner-kind decisions;
 *   - supports sanitized evidence output (operator-supplied IDs and hashes
 *     only, no project names, payloads or connection details).
 *
 * This is deliberately NOT a generic remediation framework: it is one focused
 * command for the reviewed #404 migration classification step.
 */

import { createHash } from 'node:crypto'
import { Prisma, type PrismaClient } from '@prisma/client'

import { resetProjectPlanningWithinTransaction } from './resetProjectPlanning.js'

/** Prisma client or an already-open transaction client (both work here). */
export type ClassifyDb = PrismaClient | Prisma.TransactionClient

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

/**
 * Raised when the recomputed reset-state fingerprint differs from the
 * reviewed fingerprint supplied for apply. Nothing has been written.
 */
export class ClassifyDriftError extends ClassifyAbortError {
  constructor(expected: string, actual: string) {
    super(
      'Classification aborted: reset-relevant state does not match the reviewed fingerprint ' +
      `(expected ${expected}, actual ${actual}). Rerun the dry-run and review the new state ` +
      'before retrying; nothing was changed.',
    )
    this.name = 'ClassifyDriftError'
  }
}

/**
 * Raised when the Serializable classification transaction is aborted by a
 * concurrent write to reset-relevant state (PostgreSQL serialization
 * conflict). The transaction rolled back with zero committed writes and the
 * apply attempt is invalidated — it is NEVER retried automatically, because
 * automatic retry could reuse the stale reviewed fingerprint after the
 * database changed.
 */
export class ClassifySerializationConflictError extends ClassifyAbortError {
  constructor() {
    super(
      'Classification aborted because project planning state changed concurrently. ' +
      'Rerun the dry-run and review the new fingerprint before retrying. Nothing was changed.',
    )
    this.name = 'ClassifySerializationConflictError'
  }
}

/**
 * Detect a PostgreSQL serialization failure surfaced by Prisma/adapter-pg:
 * Prisma P2034 ("transaction failed due to a write conflict or deadlock") or
 * the driver error cause with originalCode 40001 (serialization_failure).
 * Mirrors the detection used by the Squad Planner apply path.
 */
export function isSerializationConflict(err: unknown): boolean {
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2034') {
    return true
  }
  if (typeof err !== 'object' || err === null) return false
  const cause = (err as { cause?: unknown }).cause
  return typeof cause === 'object'
    && cause !== null
    && (cause as { originalCode?: unknown }).originalCode === '40001'
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
  /**
   * Deterministic SHA-256 over the reset-relevant state of the exact
   * manifest project set. Emitted by every dry-run; apply must reproduce it.
   */
  stateFingerprint: string
}

export interface ClassifyOptions {
  apply?: boolean
  /**
   * The reviewed fingerprint from a dry-run on unchanged state. Required for
   * apply; verified inside the batch transaction before any write.
   */
  expectedFingerprint?: string
  /**
   * Test-only seam: invoked inside the batch transaction after each project
   * reset. Throwing from it rolls the whole batch back.
   */
  afterProjectReset?: (tx: Prisma.TransactionClient, projectId: string) => Promise<void>
}

/**
 * Deterministic JSON stringify: object keys sorted recursively, array order
 * preserved. PostgreSQL jsonb does not preserve key order, so sorting is
 * required for stable fingerprints across reads.
 */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(v => stableStringify(v)).join(',')}]`
  }
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>
    const keys = Object.keys(obj).sort()
    return `{${keys.map(k => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

/** Sort rows by id so database return order never changes the fingerprint. */
function sortById<T extends { id: string }>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => a.id.localeCompare(b.id))
}

/**
 * Compute the deterministic SHA-256 fingerprint over the reset-relevant state
 * of the exact manifest project set.
 *
 * Covers exactly the state Reset Planning consumes or clears (issue #449
 * review remediation): manifest project IDs and existence, planningState,
 * weeklyDemandCache, CapacityProfile ownership/provenance fields,
 * CapacitySegments, CapacityPlans/Periods/Entries, TimelineEntries,
 * StoryTimelineEntries, and the NamedResource identity linkage that (together
 * with profile ownerKind) determines which rows qualify as proven
 * PLANNED_RESOURCE planner artefacts. Unrelated backlog/business fields are
 * deliberately not included.
 */
export async function computeClassificationFingerprint(
  db: ClassifyDb,
  manifest: ClassifyManifest,
): Promise<string> {
  const projectIds = [...manifest.projectIds].sort()

  const [
    projects,
    capacityProfiles,
    capacitySegments,
    capacityPlans,
    capacityPlanPeriods,
    capacityPlanEntries,
    timelineEntries,
    storyTimelineEntries,
    namedResources,
  ] = await Promise.all([
    db.project.findMany({
      where: { id: { in: projectIds } },
      select: { id: true, planningState: true, weeklyDemandCache: true },
    }),
    db.capacityProfile.findMany({
      where: { projectId: { in: projectIds } },
      select: {
        id: true,
        projectId: true,
        resourceTypeId: true,
        namedResourceId: true,
        ownerKind: true,
        planningBasis: true,
        source: true,
        defaultPercent: true,
        startWeek: true,
        endWeek: true,
      },
    }),
    db.capacitySegment.findMany({
      where: { capacityProfile: { projectId: { in: projectIds } } },
      select: { id: true, capacityProfileId: true, startWeek: true, endWeek: true, capacityPercent: true, source: true },
    }),
    db.capacityPlan.findMany({
      where: { projectId: { in: projectIds } },
      select: { id: true, projectId: true, name: true, targetWeeks: true, periodWeeks: true, maxDelta: true, isActive: true, totalCost: true, deliveryWeeks: true },
    }),
    db.capacityPlanPeriod.findMany({
      where: { plan: { projectId: { in: projectIds } } },
      select: { id: true, planId: true, periodIndex: true, startWeek: true, endWeek: true },
    }),
    db.capacityPlanEntry.findMany({
      where: { period: { plan: { projectId: { in: projectIds } } } },
      select: { id: true, periodId: true, resourceTypeId: true, headcount: true, demandFTE: true, utilisationPct: true },
    }),
    db.timelineEntry.findMany({
      where: { projectId: { in: projectIds } },
      select: { id: true, projectId: true, featureId: true, startWeek: true, durationWeeks: true, isManual: true },
    }),
    db.storyTimelineEntry.findMany({
      where: { projectId: { in: projectIds } },
      select: { id: true, projectId: true, storyId: true, startWeek: true, durationWeeks: true, isManual: true },
    }),
    db.namedResource.findMany({
      where: { resourceType: { projectId: { in: projectIds } } },
      select: { id: true, resourceTypeId: true },
    }),
  ])

  const payload = {
    manifestProjectIds: projectIds,
    projects: sortById(projects).map(p => ({
      id: p.id,
      planningState: p.planningState,
      weeklyDemandCache: p.weeklyDemandCache,
    })),
    capacityProfiles: sortById(capacityProfiles),
    capacitySegments: sortById(capacitySegments),
    capacityPlans: sortById(capacityPlans),
    capacityPlanPeriods: sortById(capacityPlanPeriods),
    capacityPlanEntries: sortById(capacityPlanEntries),
    timelineEntries: sortById(timelineEntries),
    storyTimelineEntries: sortById(storyTimelineEntries),
    namedResources: sortById(namedResources),
  }

  return createHash('sha256').update(stableStringify(payload)).digest('hex')
}

/**
 * Read-only classification plan. Never writes.
 *
 * Each manifest project is classified as:
 *   - `to-classify`          — exists and is CURRENT (or any non-NEEDS_REPLAN value);
 *   - `already-needs-replan` — already explicitly quarantined (idempotent skip);
 *   - `not-found`            — missing; the apply run must abort (fail closed).
 */
export async function planClassification(
  db: ClassifyDb,
  manifest: ClassifyManifest,
): Promise<Omit<ClassificationReport, 'stateFingerprint'>> {
  const projects = await db.project.findMany({
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

function summarizeClassification(entries: ClassificationEntry[]) {
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
 * Dry-run (default): read-only plan plus the deterministic `stateFingerprint`
 * of the reset-relevant state the operator reviews.
 *
 * Apply: requires `expectedFingerprint` (the reviewed dry-run value). The
 * whole manifest set runs in ONE Prisma transaction: the fingerprint is
 * recomputed inside that transaction immediately before any write, the plan
 * is re-derived, and every to-classify project goes through the same atomic
 * reset transaction body used by the product. Any drift, missing project or
 * failure rolls the entire batch back — no partial classification.
 *
 * Already-NEEDS_REPLAN projects are skipped (idempotent) only when their
 * state is part of the reviewed fingerprint; the drift check still refuses
 * any other unexpected change.
 */
export async function classifyNeedsReplan(
  db: ClassifyDb,
  manifest: ClassifyManifest,
  options: ClassifyOptions = {},
): Promise<ClassificationReport> {
  if (options.apply) {
    if (options.expectedFingerprint == null) {
      throw new ClassifyAbortError(
        'Apply requires the reviewed state fingerprint: pass --expected-fingerprint <sha256> ' +
        'from a dry-run on unchanged state. Nothing was changed.',
      )
    }
    const expectedFingerprint: string = options.expectedFingerprint

    // One atomic, SERIALIZABLE transaction for the complete reviewed set.
    //
    // Serializable isolation closes the review→write race: the fingerprint is
    // computed inside this transaction, so any concurrent commit that changes
    // reset-relevant state between the fingerprint reads and the destructive
    // writes forces a serialization conflict at the transaction boundary and
    // rolls the WHOLE batch back. A project changed after review can never be
    // destructively reset on stale review evidence.
    //
    // The destructive classification transaction is invoked on the root
    // client (the apply path is only ever entered with one); the dry-run and
    // fingerprint helpers accept transaction clients too, but only the root
    // client supports an explicit isolation level.
    const batchClient = db as PrismaClient
    try {
      return await batchClient.$transaction(async tx => {
        const stateFingerprint = await computeClassificationFingerprint(tx, manifest)
        if (stateFingerprint !== expectedFingerprint) {
          throw new ClassifyDriftError(expectedFingerprint, stateFingerprint)
        }

        const plan = await planClassification(tx, manifest)
        if (!plan.completed) {
          throw new ClassifyAbortError(
            `Classification aborted: ${plan.notFoundCount} manifest project(s) no longer exist. ` +
            'Re-review the manifest before retrying; nothing was changed.',
          )
        }

        for (const entry of plan.entries) {
          if (entry.status !== 'to-classify') continue
          await resetProjectPlanningWithinTransaction(tx, entry.projectId)
          if (options.afterProjectReset) {
            await options.afterProjectReset(tx, entry.projectId)
          }
        }

        return { ...plan, stateFingerprint }
      }, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      })
    } catch (error) {
      // Serialization conflict: the reviewed transaction raced a concurrent
      // write and was rolled back with zero committed writes. Invalidate the
      // apply attempt — never retry automatically with the stale fingerprint.
      if (isSerializationConflict(error)) {
        throw new ClassifySerializationConflictError()
      }
      throw error
    }
  }

  // Dry run (default): read-only plan plus the reviewed-state fingerprint.
  const plan = await planClassification(db, manifest)
  if (!plan.completed) {
    throw new ClassifyAbortError(
      `Classification aborted: ${plan.notFoundCount} manifest project(s) no longer exist. ` +
      'Re-review the manifest before retrying; nothing was changed.',
    )
  }
  const stateFingerprint = await computeClassificationFingerprint(db, manifest)
  return { ...plan, stateFingerprint }
}

/** Render the report as aggregate sanitized evidence (IDs are operator-supplied). */
export function formatClassificationReport(report: ClassificationReport, apply: boolean): string {
  const lines: string[] = []
  lines.push(apply
    ? 'Mode: APPLY — the reviewed set was classified NEEDS_REPLAN atomically (one transaction).'
    : 'Mode: DRY RUN (default) — zero writes.')
  lines.push(`stateFingerprint: ${report.stateFingerprint}`)
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
