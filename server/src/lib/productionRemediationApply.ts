/**
 * productionRemediationApply.ts — Issue #421: transactional apply of the
 * reviewed readiness-remediation plan.
 *
 * Apply guarantees (mirrored by the CLI contract):
 *  - requires an explicit `--apply` invocation with the exact reviewed plan
 *    (and optional approved manifest);
 *  - refuses a missing, malformed, fingerprint-mismatched or unresolved plan;
 *  - re-reads every affected row before writing and verifies the exact
 *    current-state evidence hash from the plan (drift protection);
 *  - performs no best-effort guessing — every write is either a deterministic
 *    operation from the plan or an explicit manifest-resolved operation;
 *  - runs inside ONE database transaction; any failure rolls back all writes;
 *  - is idempotent — operations whose proposed state is already persisted are
 *    reported as skipped/no-op;
 *  - never writes ResourceType/NamedResource candidate columns, never touches
 *    `CapacityProfile.legacy` on updates, never deletes snapshots and never
 *    weakens the permanent readiness command.
 *
 * Exit contract (shared with the CLI):
 *   0 — every plan operation applied or already applied, and post-apply
 *       readiness + planner checks are clean;
 *   1 — operational, structural or drift failure (nothing was written in
 *       pre-write failures; a committed run that fails post-apply reports
 *       loudly);
 *   2 — plan valid but explicit decisions remain unresolved (refused).
 */

import type { Prisma, PrismaClient } from '@prisma/client'

import {
  canonicalJson,
  evidenceHash,
  classifyPlanExit,
  resolvePlanWithManifest,
  parsePlanJson,
  computeStateHash,
  buildRtEvidence,
  buildNrEvidence,
  buildProfileEvidence,
  buildSnapshotEntryEvidence,
  loadRemediationState,
  buildRemediationPlan,
  type RemediationOperation,
  type RemediationPlan,
  type RemediationManifest,
  type ProposedProfile,
  type ProposedSnapshotRewrite,
  type FindingClassification,
  type RemediationProfile,
} from './productionRemediationPlan.js'
import { runProductionMigrationReadiness } from './productionMigrationReadiness.js'
import {
  isSnapshotV2,
  parseSnapshotData,
  type SnapshotV2,
} from './projectSnapshotTypes.js'
import { translateV2SnapshotProfiles } from './projectSnapshotCapacity.js'
import { validateProfileStructure } from './capacityProfileStructureValidation.js'

// ─── Errors ─────────────────────────────────────────────────────────────────

export class RemediationApplyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RemediationApplyError'
  }
}

export class RemediationDriftError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RemediationDriftError'
  }
}

// ─── Outcome ────────────────────────────────────────────────────────────────

export interface PostApplyCheck {
  planFindings: Record<FindingClassification, number>
  readinessPassed: boolean
  readinessBlockers: string[]
}

export interface ApplyOutcome {
  exitCode: 0 | 1 | 2
  applied: number
  skipped: number
  errors: string[]
  postApply: PostApplyCheck | null
  report: string
}

// ─── Test seam (mirrors squadPlannerProfileWriter conventions) ──────────────

let applyFailureSeam: (() => void | Promise<void>) | null = null

/** Test-only: inject a failure between pre-flight verification and the first write. */
export function __setRemediationApplyFailureSeam(fn: (() => void | Promise<void>) | null): void {
  applyFailureSeam = fn
}

// ─── Current-state re-read (drift protection) ───────────────────────────────

interface OperationCurrentState {
  rt: Awaited<ReturnType<typeof loadResourceType>> | null
  nr: Awaited<ReturnType<typeof loadNamedResource>> | null
  profile: RemediationProfile | null
  snapshotRaw: { snapshot: unknown; projectId: string } | null
  activePlanPeriods: Awaited<ReturnType<typeof loadActivePlanPeriods>>
  /** Persisted profiles currently owned by the operation's owner (create ops). */
  existingProfiles: RemediationProfile[]
}

async function loadResourceType(client: PrismaClient | Prisma.TransactionClient, id: string) {
  return client.resourceType.findUnique({
    where: { id },
    select: {
      id: true,
      name: true,
      count: true,
      allocationMode: true,
      allocationPercent: true,
      allocationStartWeek: true,
      allocationEndWeek: true,
      projectId: true,
      namedResources: {
        orderBy: { id: 'asc' },
        select: {
          id: true,
          name: true,
          allocationMode: true,
          allocationPercent: true,
          allocationPct: true,
          allocationStartWeek: true,
          allocationEndWeek: true,
          startWeek: true,
          endWeek: true,
        },
      },
    },
  })
}

async function loadNamedResource(client: PrismaClient | Prisma.TransactionClient, id: string) {
  return client.namedResource.findUnique({
    where: { id },
    select: {
      id: true,
      name: true,
      resourceTypeId: true,
      resourceType: { select: { projectId: true } },
      allocationMode: true,
      allocationPercent: true,
      allocationPct: true,
      allocationStartWeek: true,
      allocationEndWeek: true,
      startWeek: true,
      endWeek: true,
    },
  })
}

async function loadActivePlanPeriods(client: PrismaClient | Prisma.TransactionClient, projectId: string) {
  const activePlan = await client.capacityPlan.findFirst({
    where: { projectId, isActive: true },
    select: {
      periods: {
        orderBy: { periodIndex: 'asc' },
        select: {
          periodIndex: true,
          startWeek: true,
          endWeek: true,
          entries: {
            orderBy: { resourceTypeId: 'asc' },
            select: { resourceTypeId: true, headcount: true },
          },
        },
      },
    },
  })
  return (activePlan?.periods ?? []).map(period => ({
    periodIndex: period.periodIndex,
    startWeek: period.startWeek,
    endWeek: period.endWeek,
    entries: period.entries.map(entry => ({
      resourceTypeId: entry.resourceTypeId,
      headcount: entry.headcount,
    })),
  }))
}

async function loadCurrentState(
  client: PrismaClient | Prisma.TransactionClient,
  op: RemediationOperation,
): Promise<OperationCurrentState> {
  const [rt, nr, profile, snapshotRaw, activePlanPeriods, existingProfiles] = await Promise.all([
    op.kind === 'create-role-profile' ? loadResourceType(client, op.ownerId) : Promise.resolve(null),
    op.kind === 'create-named-profile' ? loadNamedResource(client, op.ownerId) : Promise.resolve(null),
    op.kind === 'update-profile' && typeof op.proposed === 'object' && 'profileId' in op.proposed
      ? loadPersistedProfile(client, (op.proposed as ProposedProfile).profileId)
      : Promise.resolve(null),
    op.kind === 'rewrite-snapshot-entry'
      ? client.backlogSnapshot.findUnique({ where: { id: (op.proposed as ProposedSnapshotRewrite).snapshotId }, select: { snapshot: true, projectId: true } })
      : Promise.resolve(null),
    op.kind === 'create-role-profile'
      ? loadActivePlanPeriods(client, op.projectId)
      : Promise.resolve([]),
    op.kind === 'create-role-profile' || op.kind === 'create-named-profile'
      ? client.capacityProfile.findMany({
          where: op.kind === 'create-role-profile'
            ? { projectId: op.projectId, resourceTypeId: op.ownerId, ownerKind: 'ROLE' }
            : { projectId: op.projectId, namedResourceId: op.ownerId },
          include: { segments: { orderBy: [{ startWeek: 'asc' }, { id: 'asc' }] } },
        })
      : Promise.resolve([]),
  ])
  return {
    rt,
    nr,
    profile,
    snapshotRaw,
    activePlanPeriods,
    existingProfiles: existingProfiles.map(row => ({
      id: row.id,
      projectId: row.projectId,
      resourceTypeId: row.resourceTypeId,
      namedResourceId: row.namedResourceId,
      ownerKind: row.ownerKind,
      planningBasis: row.planningBasis,
      source: row.source,
      defaultPercent: row.defaultPercent,
      startWeek: row.startWeek,
      endWeek: row.endWeek,
      legacy: row.legacy,
      segments: row.segments.map(segment => ({
        id: segment.id,
        startWeek: segment.startWeek,
        endWeek: segment.endWeek,
        capacityPercent: segment.capacityPercent,
        source: segment.source,
      })),
    })),
  }
}

async function loadPersistedProfile(
  client: PrismaClient | Prisma.TransactionClient,
  profileId: string,
): Promise<RemediationProfile | null> {
  const row = await client.capacityProfile.findUnique({
    where: { id: profileId },
    include: {
      segments: { orderBy: [{ startWeek: 'asc' }, { id: 'asc' }] },
    },
  })
  if (!row) return null
  return {
    id: row.id,
    projectId: row.projectId,
    resourceTypeId: row.resourceTypeId,
    namedResourceId: row.namedResourceId,
    ownerKind: row.ownerKind,
    planningBasis: row.planningBasis,
    source: row.source,
    defaultPercent: row.defaultPercent,
    startWeek: row.startWeek,
    endWeek: row.endWeek,
    legacy: row.legacy,
    segments: row.segments.map(segment => ({
      id: segment.id,
      startWeek: segment.startWeek,
      endWeek: segment.endWeek,
      capacityPercent: segment.capacityPercent,
      source: segment.source,
    })),
  }
}

/** Recompute the operation's evidence from current state (mirrors the planner). */
function recomputeOperationEvidence(
  op: RemediationOperation,
  current: OperationCurrentState,
): { evidence: Record<string, unknown>; ownerMissing: boolean } | null {
  if (op.kind === 'create-role-profile') {
    if (!current.rt) return null
    return {
      evidence: buildRtEvidence({
        id: current.rt.id,
        name: current.rt.name,
        count: current.rt.count,
        allocationMode: current.rt.allocationMode,
        allocationPercent: current.rt.allocationPercent,
        allocationStartWeek: current.rt.allocationStartWeek,
        allocationEndWeek: current.rt.allocationEndWeek,
        namedResources: current.rt.namedResources.map(nr => ({
          id: nr.id,
          name: nr.name,
          allocationMode: nr.allocationMode,
          allocationPercent: nr.allocationPercent,
          allocationPct: nr.allocationPct,
          allocationStartWeek: nr.allocationStartWeek,
          allocationEndWeek: nr.allocationEndWeek,
          startWeek: nr.startWeek,
          endWeek: nr.endWeek,
        })),
      }, current.activePlanPeriods),
      ownerMissing: false,
    }
  }
  if (op.kind === 'create-named-profile') {
    if (!current.nr) return null
    return {
      evidence: buildNrEvidence({
        id: current.nr.id,
        name: current.nr.name,
        allocationMode: current.nr.allocationMode,
        allocationPercent: current.nr.allocationPercent,
        allocationPct: current.nr.allocationPct,
        allocationStartWeek: current.nr.allocationStartWeek,
        allocationEndWeek: current.nr.allocationEndWeek,
        startWeek: current.nr.startWeek,
        endWeek: current.nr.endWeek,
      }),
      ownerMissing: false,
    }
  }
  if (op.kind === 'update-profile') {
    if (!current.profile) return null
    return { evidence: buildProfileEvidence(current.profile), ownerMissing: false }
  }
  if (op.kind === 'rewrite-snapshot-entry') {
    if (!current.snapshotRaw) return null
    const rewrite = op.proposed as ProposedSnapshotRewrite
    const captured = extractCapturedSnapshotEntry(current.snapshotRaw.snapshot, rewrite)
    if (!captured) return null
    return {
      evidence: buildSnapshotEntryEvidence(rewrite.snapshotId, rewrite.entryType, rewrite.entryId, captured),
      ownerMissing: false,
    }
  }
  return null
}

/** Extract the captured capacity fields of one v2 entry (mirrors the planner). */
function extractCapturedSnapshotEntry(
  snapshot: unknown,
  rewrite: ProposedSnapshotRewrite,
): Record<string, unknown> | null {
  let parsed: unknown
  try {
    parsed = parseSnapshotData(snapshot)
  } catch {
    return null
  }
  if (!isSnapshotV2(parsed)) return null
  const v2 = parsed as SnapshotV2
  if (rewrite.entryType === 'resourceType') {
    const entry = v2.resourceTypes.find(rt => rt.id === rewrite.entryId)
    if (!entry) return null
    return {
      allocationMode: entry.allocationMode ?? null,
      allocationPercent: entry.allocationPercent ?? null,
      allocationStartWeek: entry.allocationStartWeek ?? null,
      allocationEndWeek: entry.allocationEndWeek ?? null,
    }
  }
  const entry = v2.namedResources.find(nr => nr.id === rewrite.entryId)
  if (!entry) return null
  return {
    allocationMode: entry.allocationMode ?? null,
    allocationPercent: entry.allocationPercent ?? null,
    allocationPct: entry.allocationPct ?? null,
    allocationStartWeek: entry.allocationStartWeek ?? null,
    allocationEndWeek: entry.allocationEndWeek ?? null,
    startWeek: entry.startWeek ?? null,
    endWeek: entry.endWeek ?? null,
  }
}

// ─── Proposed-state comparison (idempotency + post-write verification) ──────

function proposedProfileCore(proposed: ProposedProfile): Record<string, unknown> {
  return {
    profileId: proposed.profileId,
    ownerKind: proposed.ownerKind,
    planningBasis: proposed.planningBasis,
    source: proposed.source,
    defaultPercent: proposed.defaultPercent,
    startWeek: proposed.startWeek,
    endWeek: proposed.endWeek,
    segments: proposed.segments.map(segment => ({
      id: segment.id,
      startWeek: segment.startWeek,
      endWeek: segment.endWeek,
      capacityPercent: segment.capacityPercent,
      source: segment.source,
    })),
  }
}

function persistedProfileMatchesProposed(profile: RemediationProfile, proposed: ProposedProfile): boolean {
  const persisted: Record<string, unknown> = {
    profileId: profile.id,
    ownerKind: profile.ownerKind,
    planningBasis: profile.planningBasis,
    source: profile.source,
    defaultPercent: profile.defaultPercent,
    startWeek: profile.startWeek,
    endWeek: profile.endWeek,
    segments: profile.segments.map(segment => ({
      id: segment.id,
      startWeek: segment.startWeek,
      endWeek: segment.endWeek,
      capacityPercent: segment.capacityPercent,
      source: segment.source,
    })),
  }
  const coreMatch = canonicalJson(persisted) === canonicalJson(proposedProfileCore(proposed))
  if (!coreMatch) return false
  if (proposed.legacy == null) return true
  return canonicalJson(profile.legacy ?? null) === canonicalJson(proposed.legacy)
}

function snapshotAlreadyRewritten(snapshot: unknown, rewrite: ProposedSnapshotRewrite): boolean {
  const captured = extractCapturedSnapshotEntry(snapshot, rewrite)
  if (!captured) return false
  return captured.allocationStartWeek === rewrite.startWeek && captured.allocationEndWeek === rewrite.endWeek
}

// ─── Operation verification (drift + idempotency) ───────────────────────────

type VerificationResult =
  | { verdict: 'write' }
  | { verdict: 'skip' }
  | { verdict: 'refuse'; reason: string }

function verifyOperation(
  op: RemediationOperation,
  current: OperationCurrentState,
): VerificationResult {
  const recomputed = recomputeOperationEvidence(op, current)
  if (!recomputed) {
    return { verdict: 'refuse', reason: `owner/snapshot row vanished since dry-run (${op.ownerId})` }
  }
  const matchesEvidence = evidenceHash(recomputed.evidence) === op.evidenceHash

  if (op.kind === 'create-role-profile' || op.kind === 'create-named-profile') {
    const proposed = op.proposed as ProposedProfile
    if (op.kind === 'create-role-profile' && current.rt && current.rt.projectId !== op.projectId) {
      return { verdict: 'refuse', reason: `resource type ${op.ownerId} moved to another project since dry-run` }
    }
    if (op.kind === 'create-named-profile' && current.nr && current.nr.resourceType?.projectId !== op.projectId) {
      return { verdict: 'refuse', reason: `named resource ${op.ownerId} moved to another project since dry-run` }
    }
    if (current.existingProfiles.length === 0) {
      if (matchesEvidence) return { verdict: 'write' }
      return { verdict: 'refuse', reason: `current state of ${op.ownerId} differs from the reviewed plan evidence` }
    }
    if (
      current.existingProfiles.length === 1 &&
      persistedProfileMatchesProposed(current.existingProfiles[0]!, proposed)
    ) {
      return { verdict: 'skip' }
    }
    return { verdict: 'refuse', reason: `owner ${op.ownerId} now has a different persisted profile than the reviewed plan expects` }
  }

  if (op.kind === 'update-profile') {
    const proposed = op.proposed as ProposedProfile
    if (matchesEvidence) return { verdict: 'write' }
    if (current.profile && persistedProfileMatchesProposed(current.profile, proposed)) {
      return { verdict: 'skip' }
    }
    return { verdict: 'refuse', reason: `profile ${proposed.profileId} state differs from the reviewed plan evidence` }
  }

  if (op.kind === 'rewrite-snapshot-entry') {
    const rewrite = op.proposed as ProposedSnapshotRewrite
    if (matchesEvidence) return { verdict: 'write' }
    if (current.snapshotRaw && snapshotAlreadyRewritten(current.snapshotRaw.snapshot, rewrite)) {
      return { verdict: 'skip' }
    }
    return { verdict: 'refuse', reason: `snapshot ${rewrite.snapshotId} entry ${rewrite.entryId} differs from the reviewed plan evidence` }
  }

  return { verdict: 'refuse', reason: `unknown operation kind ${op.kind}` }
}

// ─── Writes (inside the transaction) ────────────────────────────────────────

async function writeOperation(
  tx: Prisma.TransactionClient,
  op: RemediationOperation,
): Promise<void> {
  if (op.kind === 'create-role-profile' || op.kind === 'create-named-profile') {
    const proposed = op.proposed as ProposedProfile
    await tx.capacityProfile.create({
      data: {
        id: proposed.profileId,
        projectId: op.projectId,
        ownerKind: proposed.ownerKind,
        resourceTypeId: op.kind === 'create-role-profile' ? op.ownerId : null,
        namedResourceId: op.kind === 'create-named-profile' ? op.ownerId : null,
        planningBasis: proposed.planningBasis,
        source: proposed.source,
        defaultPercent: proposed.defaultPercent,
        startWeek: proposed.startWeek,
        endWeek: proposed.endWeek,
        legacy: proposed.legacy as Prisma.InputJsonValue | undefined,
        segments: {
          create: proposed.segments.map(segment => ({
            id: segment.id,
            startWeek: segment.startWeek,
            endWeek: segment.endWeek,
            capacityPercent: segment.capacityPercent,
            source: segment.source as never,
          })),
        },
      },
    })
    return
  }

  if (op.kind === 'update-profile') {
    const proposed = op.proposed as ProposedProfile
    await tx.capacityProfile.update({
      where: { id: proposed.profileId },
      data: {
        ownerKind: proposed.ownerKind,
        planningBasis: proposed.planningBasis,
        source: proposed.source,
        defaultPercent: proposed.defaultPercent,
        startWeek: proposed.startWeek,
        endWeek: proposed.endWeek,
      },
    })
    await tx.capacitySegment.deleteMany({ where: { capacityProfileId: proposed.profileId } })
    for (const segment of proposed.segments) {
      await tx.capacitySegment.create({
        data: {
          id: segment.id,
          capacityProfileId: proposed.profileId,
          startWeek: segment.startWeek,
          endWeek: segment.endWeek,
          capacityPercent: segment.capacityPercent,
          source: segment.source as never,
        },
      })
    }
    return
  }

  if (op.kind === 'rewrite-snapshot-entry') {
    const rewrite = op.proposed as ProposedSnapshotRewrite
    const row = await tx.backlogSnapshot.findUnique({
      where: { id: rewrite.snapshotId },
      select: { snapshot: true, projectId: true },
    })
    if (!row) {
      throw new RemediationDriftError(`snapshot ${rewrite.snapshotId} vanished before write`)
    }
    if (row.projectId !== op.projectId) {
      throw new RemediationDriftError(`snapshot ${rewrite.snapshotId} moved to another project since dry-run`)
    }
    let parsed: unknown
    try {
      parsed = parseSnapshotData(row.snapshot)
    } catch (error) {
      throw new RemediationApplyError(
        `snapshot ${rewrite.snapshotId} is no longer parseable: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    if (!isSnapshotV2(parsed)) {
      throw new RemediationApplyError(`snapshot ${rewrite.snapshotId} is no longer a v2 snapshot`)
    }
    const rewritten = structuredClone(row.snapshot) as Record<string, unknown>
    const resourceTypes = Array.isArray(rewritten.resourceTypes) ? rewritten.resourceTypes : []
    const namedResources = Array.isArray(rewritten.namedResources) ? rewritten.namedResources : []
    const target = rewrite.entryType === 'resourceType'
      ? resourceTypes.find((entry: Record<string, unknown>) => entry.id === rewrite.entryId)
      : namedResources.find((entry: Record<string, unknown>) => entry.id === rewrite.entryId)
    if (!target) {
      throw new RemediationDriftError(`snapshot ${rewrite.snapshotId} no longer contains entry ${rewrite.entryId}`)
    }
    // Minimal capacity-field update: only the two primary window aliases are
    // written; any negative fallback alias (startWeek/endWeek) is cleared to
    // null so the single -1 sentinel edge cannot break translation after the
    // approved interpretation is recorded.
    target.allocationStartWeek = rewrite.startWeek
    target.allocationEndWeek = rewrite.endWeek
    if (typeof target.startWeek === 'number' && target.startWeek < 0) target.startWeek = null
    if (typeof target.endWeek === 'number' && target.endWeek < 0) target.endWeek = null

    // Validate the complete resulting snapshot before writing.
    let validated: unknown
    try {
      validated = parseSnapshotData(rewritten)
    } catch (error) {
      throw new RemediationApplyError(
        `rewritten snapshot ${rewrite.snapshotId} is malformed: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    if (!isSnapshotV2(validated)) {
      throw new RemediationApplyError(`rewritten snapshot ${rewrite.snapshotId} is no longer a v2 snapshot`)
    }
    const translation = translateV2SnapshotProfiles(validated, row.projectId)
    if (translation.errors.length > 0) {
      throw new RemediationApplyError(
        `rewritten snapshot ${rewrite.snapshotId} is not translatable: ${translation.errors.join('; ')}`,
      )
    }
    await tx.backlogSnapshot.update({
      where: { id: rewrite.snapshotId },
      data: { snapshot: rewritten as Prisma.InputJsonValue },
    })
    return
  }

  throw new RemediationApplyError(`unknown operation kind ${op.kind}`)
}

// ─── Main apply ─────────────────────────────────────────────────────────────

export interface ApplyOptions {
  plan: RemediationPlan
  manifest?: RemediationManifest | null
}

/**
 * Apply the reviewed remediation plan inside one transaction.
 *
 * @param prisma Connected PrismaClient (never disconnected here).
 * @param options Plan (already parsed and fingerprint-validated) and optional manifest.
 * @returns Outcome with exit code, applied/skipped counts and post-apply checks.
 */
export async function applyRemediationPlan(
  prisma: PrismaClient,
  options: ApplyOptions,
): Promise<ApplyOutcome> {
  const errors: string[] = []

  let plan = options.plan
  if (options.manifest) {
    const resolved = resolvePlanWithManifest(plan, options.manifest)
    if (resolved.errors.length > 0) {
      errors.push(...resolved.errors.map(error => `manifest: ${error}`))
      return {
        exitCode: 1,
        applied: 0,
        skipped: 0,
        errors,
        postApply: null,
        report: formatApplyReport(errors, 0, 0, null),
      }
    }
    plan = resolved.plan
  }

  const exit = classifyPlanExit(plan)
  if (exit !== 0) {
    const message = exit === 2
      ? 'plan has unresolved explicit decisions — apply is refused until every decision is resolved by an approved manifest'
      : 'plan contains unsupported or structurally invalid findings — apply is refused'
    errors.push(message)
    return {
      exitCode: exit as 1 | 2,
      applied: 0,
      skipped: 0,
      errors,
      postApply: null,
      report: formatApplyReport(errors, 0, 0, null),
    }
  }

  if (plan.operations.length === 0) {
    return {
      exitCode: 0,
      applied: 0,
      skipped: 0,
      errors: [],
      postApply: null,
      report: formatApplyReport([], 0, 0, null) + '\nNo operations in plan — nothing to apply.',
    }
  }

  let applied = 0
  let skipped = 0
  const refused: string[] = []

  try {
    await prisma.$transaction(async tx => {
      // ── Full-scope drift check: the COMPLETE remediation state must match
      // the reviewed dry-run baseline before any write (issue #421 review
      // round 2). The state hash covers projects, resource types, named
      // resources, profiles, segments, active plan periods/entries and all
      // backlog snapshots — anything outside the per-operation evidence.
      const currentState = await loadRemediationState(tx)
      const currentStateHash = computeStateHash(currentState)
      const baselineIntact = currentStateHash === plan.baselineStateHash

      if (!baselineIntact) {
        // ── Exact-rerun acceptance ───────────────────────────────────────
        // A rerun after a fully successful application must be a no-op: every
        // reviewed operation already matches its exact proposed state, and
        // the complete current planner contains no remaining operations,
        // unresolved decisions or unsupported findings. Any mixed, partially
        // applied or otherwise different state is refused BEFORE the first
        // write.
        const rerunVerdicts: VerificationResult[] = []
        let rerunRefusals = 0
        let rerunWrites = 0
        for (const op of plan.operations) {
          const current = await loadCurrentState(tx, op)
          const verdict = verifyOperation(op, current)
          rerunVerdicts.push(verdict)
          if (verdict.verdict === 'write') rerunWrites++
          if (verdict.verdict === 'refuse') rerunRefusals++
        }
        const rerunPlan = buildRemediationPlan(currentState, plan.applicationCommit)
        const fullyRemediated =
          rerunPlan.summary.operations === 0 &&
          rerunPlan.summary.decisionsRequired === 0 &&
          rerunPlan.summary.findings.unsupported === 0
        if (rerunWrites === 0 && rerunRefusals === 0 && fullyRemediated) {
          // Exact rerun: every operation already in proposed state; nothing
          // to write. The post-commit readiness check still runs as defence
          // in depth.
          skipped = plan.operations.length
          return
        }
        throw new RemediationDriftError(
          'complete remediation state changed since dry-run — the reviewed baseline no longer matches. ' +
          'No write was performed. Regenerate the plan with a fresh dry-run and re-review before applying.',
        )
      }

      // ── Pre-flight: re-read every affected row and verify evidence ──────
      const verdicts: VerificationResult[] = []
      for (const op of plan.operations) {
        const current = await loadCurrentState(tx, op)
        const verdict = verifyOperation(op, current)
        verdicts.push(verdict)
        if (verdict.verdict === 'refuse') {
          refused.push(`${op.id} (${op.ownerId}): ${verdict.reason}`)
        }
      }
      if (refused.length > 0) {
        throw new RemediationDriftError(
          `state changed since dry-run — ${refused.length} operation(s) refused: ${refused.join('; ')}`,
        )
      }

      // ── Structural validation of every proposed profile against current owner sets ──
      for (const op of plan.operations) {
        if (op.kind === 'rewrite-snapshot-entry') continue
        const proposed = op.proposed as ProposedProfile
        const current = await loadCurrentState(tx, op)
        // Owner FKs come from the current owner row (create ops) or the
        // existing profile row (update ops) — never from the plan alone.
        const ownerResourceTypeId = op.kind === 'create-role-profile'
          ? op.ownerId
          : op.kind === 'update-profile'
            ? (current.profile?.resourceTypeId ?? null)
            : null
        const ownerNamedResourceId = op.kind === 'create-named-profile'
          ? op.ownerId
          : op.kind === 'update-profile'
            ? (current.profile?.namedResourceId ?? null)
            : null
        const rtIds = new Set<string>()
        const nrIds = new Set<string>()
        if (op.kind === 'create-role-profile' && current.rt) {
          rtIds.add(current.rt.id)
          for (const nr of current.rt.namedResources) nrIds.add(nr.id)
        }
        if (op.kind === 'create-named-profile' && current.nr) {
          nrIds.add(current.nr.id)
        }
        if (ownerResourceTypeId) rtIds.add(ownerResourceTypeId)
        if (ownerNamedResourceId) nrIds.add(ownerNamedResourceId)
        const structureErrors = validateProfileStructure(
          {
            id: proposed.profileId,
            projectId: op.projectId,
            resourceTypeId: ownerResourceTypeId,
            namedResourceId: ownerNamedResourceId,
            ownerKind: proposed.ownerKind,
            planningBasis: proposed.planningBasis,
            source: proposed.source,
            defaultPercent: proposed.defaultPercent,
            startWeek: proposed.startWeek,
            endWeek: proposed.endWeek,
            segments: proposed.segments.map(segment => ({
              id: segment.id,
              startWeek: segment.startWeek,
              endWeek: segment.endWeek,
              capacityPercent: segment.capacityPercent,
              source: segment.source,
            })),
          },
          { projectId: op.projectId, resourceTypeIds: rtIds, namedResourceIds: nrIds },
        )
        if (structureErrors.length > 0) {
          throw new RemediationApplyError(
            `proposed profile ${proposed.profileId} is structurally invalid: ${structureErrors.join('; ')}`,
          )
        }
      }

      // ── Test seam: injected failure before the first write ─────────────
      if (applyFailureSeam) {
        await applyFailureSeam()
      }

      // ── Write every operation ──────────────────────────────────────────
      for (let i = 0; i < plan.operations.length; i++) {
        const op = plan.operations[i]
        const verdict = verdicts[i]
        if (verdict.verdict === 'skip') {
          skipped++
          continue
        }
        await writeOperation(tx, op)
        applied++
      }

      // ── Post-write verification per operation ──────────────────────────
      for (const op of plan.operations) {
        const current = await loadCurrentState(tx, op)
        if (op.kind === 'rewrite-snapshot-entry') {
          const rewrite = op.proposed as ProposedSnapshotRewrite
          if (!current.snapshotRaw || !snapshotAlreadyRewritten(current.snapshotRaw.snapshot, rewrite)) {
            throw new RemediationApplyError(`post-write verification failed for ${op.id} (snapshot rewrite)`)
          }
          continue
        }
        const proposed = op.proposed as ProposedProfile
        if (op.kind === 'create-role-profile' || op.kind === 'create-named-profile') {
          if (!current.rt && !current.nr) {
            throw new RemediationApplyError(`post-write verification failed for ${op.id} (owner vanished)`)
          }
        }
        if (op.kind === 'update-profile' || op.kind === 'create-role-profile' || op.kind === 'create-named-profile') {
          const persisted = await loadPersistedProfile(tx, proposed.profileId)
          if (!persisted || !persistedProfileMatchesProposed(persisted, proposed)) {
            throw new RemediationApplyError(`post-write verification failed for ${op.id} (profile mismatch)`)
          }
        }
      }
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    errors.push(message)
    return {
      exitCode: 1,
      applied: 0,
      skipped: 0,
      errors,
      postApply: null,
      report: formatApplyReport(errors, 0, 0, null),
    }
  }

  // ── Post-apply: re-run planner + permanent readiness (outside tx) ──────
  let postApply: PostApplyCheck
  try {
    const state = await loadRemediationState(prisma)
    const freshPlan = buildRemediationPlan(state, plan.applicationCommit)
    const readiness = await runProductionMigrationReadiness(prisma)
    postApply = {
      planFindings: freshPlan.summary.findings,
      readinessPassed: readiness.passed,
      readinessBlockers: readiness.sections.flatMap(section => section.blockers),
    }
    const unexpectedFindings =
      freshPlan.summary.findings.decisionRequired +
      freshPlan.summary.findings.unsupported +
      freshPlan.summary.operations
    if (unexpectedFindings > 0) {
      errors.push(
        `post-apply planner found ${unexpectedFindings} unresolved finding(s)/operation(s) that should have been remediated — review the report`,
      )
    }
    if (!readiness.passed) {
      errors.push(
        `post-apply readiness FAILED with ${postApply.readinessBlockers.length} blocker(s) — review the report`,
      )
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    errors.push(`post-apply verification error: ${message}`)
    postApply = {
      planFindings: { deterministic: 0, decisionRequired: 0, unsupported: 0, alreadyValid: 0, quarantined: 0 },
      readinessPassed: false,
      readinessBlockers: [message],
    }
  }

  const exitCode = errors.length > 0 ? 1 : 0
  return {
    exitCode: exitCode as 0 | 1,
    applied,
    skipped,
    errors,
    postApply,
    report: formatApplyReport(errors, applied, skipped, postApply),
  }
}

function formatApplyReport(
  errors: string[],
  applied: number,
  skipped: number,
  postApply: PostApplyCheck | null,
): string {
  const lines: string[] = []
  lines.push('═══ Capacity-Profile Readiness Remediation Apply ═══')
  lines.push('')
  lines.push(`Operations applied: ${applied}`)
  lines.push(`Operations skipped (already applied): ${skipped}`)
  if (errors.length > 0) {
    lines.push('')
    lines.push('❌ Errors:')
    for (const error of errors) lines.push(`   - ${error}`)
  }
  if (postApply) {
    lines.push('')
    lines.push('Post-apply verification:')
    lines.push(`  planner findings remaining: ${JSON.stringify(postApply.planFindings)}`)
    lines.push(`  permanent readiness: ${postApply.readinessPassed ? 'PASS' : 'FAIL'}`)
    for (const blocker of postApply.readinessBlockers.slice(0, 20)) {
      lines.push(`     - ${blocker}`)
    }
    if (postApply.readinessBlockers.length > 20) {
      lines.push(`     … and ${postApply.readinessBlockers.length - 20} more`)
    }
  }
  if (errors.length === 0) {
    lines.push('')
    lines.push('✅ APPLY COMPLETED — every planned operation applied or already applied; readiness clean.')
  }
  return lines.join('\n')
}

// Re-export for the CLI
export { parsePlanJson }
