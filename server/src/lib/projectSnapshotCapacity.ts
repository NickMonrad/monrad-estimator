/**
 * projectSnapshotCapacity.ts — Pure legacy-v2 reconstruction and V3 persistence helpers
 * for snapshot rollback.
 *
 * These helpers are called inside a transaction during rollback and operate on
 * Prisma transaction clients (or any compatible client with the same model
 * method shapes). They never read the active CapacityPlan or call
 * syncCapacityProfilesForProject.
 *
 * @module projectSnapshotCapacity
 */

import { Prisma } from '@prisma/client'
import type { SnapshotV2, SnapshotV3, SnapshotV4, SnapshotResourceType, SnapshotNamedResource } from './projectSnapshotTypes.js'
import { snapshotJsonValueToPrisma } from './projectSnapshotTypes.js'
import { validatePersistedCapacityProfiles } from './persistedCapacityProfileValidation.js'

// ─── Narrow transaction interface ────────────────────────────────────────────
// Replaces `tx: any` with a minimal Prisma-compatible contract covering only
// the capacity profile/segment operations this module uses.

export interface CapacityProfileTxClient {
  capacityProfile: {
    deleteMany(args: { where: { projectId: string } }): Promise<{ count: number }>
    create(args: { data: Prisma.CapacityProfileCreateInput }): Promise<unknown>
  }
  capacitySegment: {
    deleteMany(args: { where: { capacityProfile: { projectId: string } } }): Promise<{ count: number }>
    create(args: { data: Prisma.CapacitySegmentCreateInput }): Promise<unknown>
  }
}

// ─── Retained post-snapshot role profiles (issue #418 PR 1 review) ────────────

/**
 * A post-snapshot ROLE profile that survives rollback together with its RT.
 * The established rollback contract retains resource types created after the
 * target snapshot (identity preserved) while replacing captured profiles
 * exactly. Since issue #418 every owner must carry authoritative capacity
 * state, so the retained role's valid ROLE profile is preserved atomically
 * inside the rollback transaction instead of being deleted and left to a
 * manual repair.
 */
export interface RetainedRoleProfile {
  id: string
  projectId: string
  resourceTypeId: string
  namedResourceId: null
  ownerKind: 'ROLE'
  planningBasis: string
  source: string
  defaultPercent: number | null
  startWeek: number | null
  endWeek: number | null
  /** Exact persisted legacy semantics (DB_NULL vs JSON_NULL vs VALUE). */
  legacyKind: 'DB_NULL' | 'JSON_NULL' | 'VALUE'
  legacy: unknown
  segments: Array<{
    id: string
    startWeek: number
    endWeek: number
    capacityPercent: number
    source: string
  }>
}

export interface RetainedRoleProfilesResult {
  /** Current project resource types that do NOT appear in the target snapshot. */
  retainedResourceTypeIds: string[]
  /** ROLE profiles of the retained resource types (current persisted rows). */
  profiles: RetainedRoleProfile[]
}

/**
 * Load the current ROLE profiles of post-snapshot resource types.
 * Read-only; call inside the rollback transaction before any destructive
 * write so malformed surviving ownership fails before state changes.
 */
export async function loadRetainedRoleProfiles(
  tx: Pick<Prisma.TransactionClient, 'resourceType' | 'capacityProfile' | '$queryRaw'>,
  projectId: string,
  snapshotResourceTypeIds: ReadonlySet<string>,
): Promise<RetainedRoleProfilesResult> {
  const currentResourceTypes = await tx.resourceType.findMany({
    where: { projectId },
    select: { id: true },
  })
  const retainedResourceTypeIds = currentResourceTypes
    .map(rt => rt.id)
    .filter(rtId => !snapshotResourceTypeIds.has(rtId))
  if (retainedResourceTypeIds.length === 0) {
    return { retainedResourceTypeIds, profiles: [] }
  }
  const rows = await tx.capacityProfile.findMany({
    where: {
      projectId,
      resourceTypeId: { in: retainedResourceTypeIds },
      ownerKind: 'ROLE',
      namedResourceId: null,
    },
    include: {
      segments: {
        orderBy: [{ startWeek: 'asc' as const }, { id: 'asc' as const }],
      },
    },
  })
  // Prisma collapses SQL NULL and jsonb 'null' to JS null; query the exact
  // persisted legacy semantics so the round-trip preserves DB_NULL vs
  // JSON_NULL vs VALUE (mirrors the ownership-audit null semantics).
  const legacyKindById = new Map<string, 'DB_NULL' | 'JSON_NULL' | 'VALUE'>()
  if (rows.length > 0) {
    const raw = await tx.$queryRaw<Array<{ id: string; legacy_is_null: boolean; legacy_json_null: boolean }>>(
      Prisma.sql`SELECT cp.id, cp.legacy IS NULL AS legacy_is_null, cp.legacy = 'null'::jsonb AS legacy_json_null FROM "CapacityProfile" cp WHERE cp.id IN (${Prisma.join(rows.map(row => row.id))})`,
    )
    for (const row of raw) {
      legacyKindById.set(
        row.id,
        row.legacy_is_null ? 'DB_NULL' : row.legacy_json_null ? 'JSON_NULL' : 'VALUE',
      )
    }
  }
  return {
    retainedResourceTypeIds,
    profiles: rows.map(row => ({
      id: row.id,
      projectId: row.projectId,
      resourceTypeId: row.resourceTypeId as string,
      namedResourceId: null,
      ownerKind: 'ROLE' as const,
      planningBasis: String(row.planningBasis),
      source: String(row.source),
      defaultPercent: row.defaultPercent,
      startWeek: row.startWeek,
      endWeek: row.endWeek,
      legacyKind: legacyKindById.get(row.id) ?? 'VALUE',
      legacy: row.legacy,
      segments: row.segments.map(seg => ({
        id: seg.id,
        startWeek: seg.startWeek,
        endWeek: seg.endWeek,
        capacityPercent: seg.capacityPercent,
        source: String(seg.source),
      })),
    })),
  }
}

/**
 * Validate that every retained post-snapshot resource type resolves exactly
 * one structurally valid ROLE profile. Returns human-readable errors; the
 * caller throws before any destructive write.
 */
export function validateRetainedRoleProfiles(
  retainedResourceTypeIds: string[],
  profiles: RetainedRoleProfile[],
  projectId: string,
): string[] {
  const errors: string[] = []
  const byResourceTypeId = new Map<string, RetainedRoleProfile[]>()
  for (const profile of profiles) {
    const list = byResourceTypeId.get(profile.resourceTypeId) ?? []
    list.push(profile)
    byResourceTypeId.set(profile.resourceTypeId, list)
  }
  for (const rtId of retainedResourceTypeIds) {
    const owned = byResourceTypeId.get(rtId) ?? []
    if (owned.length === 0) {
      errors.push(
        `post-snapshot resource type ${rtId} has no ROLE capacity profile; ` +
        'rollback cannot preserve valid ownership',
      )
    } else if (owned.length > 1) {
      errors.push(
        `post-snapshot resource type ${rtId} has ${owned.length} ROLE capacity profiles; ` +
        'rollback cannot preserve ambiguous ownership',
      )
    }
  }
  const shapeResult = validatePersistedCapacityProfiles(
    profiles.map(p => ({
      id: p.id,
      projectId: p.projectId,
      resourceTypeId: p.resourceTypeId,
      namedResourceId: p.namedResourceId,
      ownerKind: p.ownerKind,
      planningBasis: p.planningBasis,
      source: p.source,
      defaultPercent: p.defaultPercent,
      startWeek: p.startWeek,
      endWeek: p.endWeek,
      segments: p.segments.map(seg => ({
        id: seg.id,
        capacityProfileId: null,
        startWeek: seg.startWeek,
        endWeek: seg.endWeek,
        capacityPercent: seg.capacityPercent,
        source: seg.source,
      })),
    })),
    {
      projectId,
      resourceTypeIds: new Set(retainedResourceTypeIds),
      namedResourceIds: new Set(),
    },
  )
  errors.push(...shapeResult.errors)
  return errors
}

// ─── Shared v2 snapshot translation (issue #418 PR 1 review) ────────────────

const KNOWN_V2_MODES: ReadonlySet<string> = new Set([
  'EFFORT',
  'TIMELINE',
  'FULL_PROJECT',
  'CAPACITY_PLAN',
])

export interface TranslatedV2Profile {
  id: string
  projectId: string
  resourceTypeId: string | null
  namedResourceId: string | null
  ownerKind: 'ROLE' | 'NAMED_PERSON'
  planningBasis: 'DEMAND_FOLLOWING' | 'AVAILABILITY_WINDOW' | 'WHOLE_PROJECT_ALLOCATION'
  source: 'FIXED' | 'AVAILABILITY_WINDOW' | 'LEGACY'
  defaultPercent: number | null
  startWeek: number | null
  endWeek: number | null
  legacy: Record<string, unknown>
}

export interface V2TranslationResult {
  profiles: TranslatedV2Profile[]
  errors: string[]
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) && value >= 0
}

export { isNonNegativeInteger }

/** True when the mode is one of the known v2 allocation modes. */
export function isKnownV2Mode(mode: string | null | undefined): boolean {
  return mode != null && KNOWN_V2_MODES.has(mode)
}

/** True when a captured percent is absent or finite (the v2 translation rule). */
export function v2PercentIsValid(value: number | null | undefined): boolean {
  return value == null || Number.isFinite(value)
}

/**
 * Effective allocation mode of a v2 NamedResource entry — the exact rule the
 * authoritative translator and the restorability classifier share: an
 * explicit NamedResource mode overrides the parent ResourceType mode; a
 * missing/absent parent ResourceType resolves to null (the caller decides
 * orphan-ness separately).
 */
export function v2EffectiveNamedMode(
  nr: Pick<SnapshotNamedResource, 'allocationMode'>,
  parentRt: Pick<SnapshotResourceType, 'allocationMode'> | undefined,
): string | null {
  return nr.allocationMode ?? parentRt?.allocationMode ?? null
}

/**
 * Per-entry v2 ResourceType validation — the exact checks the authoritative
 * translator applies to one resource type. Shared with the restorability
 * classifier so translation rules exist in exactly one place.
 */
export function v2ResourceTypeEntryErrors(
  rt: SnapshotResourceType,
  prefix: string,
): string[] {
  const errors: string[] = []
  if (rt.allocationMode != null && !KNOWN_V2_MODES.has(rt.allocationMode)) {
    errors.push(`${prefix}: unknown allocationMode "${String(rt.allocationMode)}"`)
    return errors
  }
  if (rt.allocationPercent != null && !Number.isFinite(rt.allocationPercent)) {
    errors.push(`${prefix}: allocationPercent must be finite`)
  }
  const rtModeUsesWindows = rt.allocationMode === 'TIMELINE' || rt.allocationMode === 'CAPACITY_PLAN'
  // Issue #421 never-active policy: a captured (-1, -1) pair or an inverted
  // window (start > end) never contributed capacity; it translates to a
  // zero-capacity profile with a null window instead of failing.
  const rtNeverActive =
    rtModeUsesWindows &&
    isNeverActiveWindow(rt.allocationStartWeek, rt.allocationEndWeek)
  if (!rtNeverActive) {
    for (const [key, value] of [
      ['allocationStartWeek', rt.allocationStartWeek],
      ['allocationEndWeek', rt.allocationEndWeek],
    ] as const) {
      if (value != null && !isNonNegativeInteger(value)) {
        errors.push(`${prefix}: ${key} must be a non-negative integer or null`)
      }
    }
    // Window aliases are only meaningful for the modes that used them;
    // EFFORT/FULL_PROJECT stale aliases are discarded, never validated.
    if (
      rtModeUsesWindows &&
      rt.allocationStartWeek != null &&
      rt.allocationEndWeek != null &&
      rt.allocationStartWeek > rt.allocationEndWeek
    ) {
      errors.push(`${prefix}: allocationStartWeek must not exceed allocationEndWeek`)
    }
  }
  if (rt.allocationMode === 'CAPACITY_PLAN' && (rt.allocationStartWeek == null || rt.allocationEndWeek == null)) {
    errors.push(
      `${prefix}: CAPACITY_PLAN without a captured start/end window cannot be ` +
      'translated without guessing capacity',
    )
  }
  return errors
}

/**
 * Per-entry v2 NamedResource validation — the exact checks the authoritative
 * translator applies to one named resource (orphan rejection, effective-mode
 * rules, alias validation). Shared with the restorability classifier.
 */
export function v2NamedResourceEntryErrors(
  nr: SnapshotNamedResource,
  parentRt: SnapshotResourceType | undefined,
  prefix: string,
): string[] {
  const errors: string[] = []
  // ── Orphan-owner rejection: every NamedResource must reference a
  // ResourceType included in the same snapshot (issue #418 PR 1 review).
  if (!nr.resourceTypeId) {
    errors.push(
      `${prefix}: named resource "${nr.id}" has no resourceTypeId and cannot be ` +
      'translated into authoritative ownership',
    )
    return errors
  }
  if (!parentRt) {
    errors.push(
      `${prefix}: named resource "${nr.id}" references resource type "${nr.resourceTypeId}" ` +
      'which is absent from this snapshot — orphan ownership cannot be translated',
    )
    return errors
  }
  const mode = v2EffectiveNamedMode(nr, parentRt)
  if (mode != null && !KNOWN_V2_MODES.has(mode)) {
    errors.push(`${prefix}: unknown allocationMode "${String(mode)}"`)
    return errors
  }
  if (nr.allocationPercent != null && !Number.isFinite(nr.allocationPercent)) {
    errors.push(`${prefix}: allocationPercent must be finite`)
  }
  if (nr.allocationPct != null && !Number.isFinite(nr.allocationPct)) {
    errors.push(`${prefix}: allocationPct must be finite`)
  }
  const effectiveStart = nr.allocationStartWeek ?? nr.startWeek
  const effectiveEnd = nr.allocationEndWeek ?? nr.endWeek
  const nrModeUsesWindows = mode === 'TIMELINE' || mode === 'CAPACITY_PLAN'
  // Issue #421 never-active policy (same as the resource-type branch): a
  // captured (-1, -1) pair or inverted window never contributed capacity;
  // its window aliases are normalised instead of rejected.
  const nrNeverActive =
    nrModeUsesWindows && isNeverActiveWindow(effectiveStart, effectiveEnd)
  if (!nrNeverActive) {
    for (const [key, value] of [
      ['allocationStartWeek', nr.allocationStartWeek],
      ['allocationEndWeek', nr.allocationEndWeek],
      ['startWeek', nr.startWeek],
      ['endWeek', nr.endWeek],
    ] as const) {
      if (value != null && !isNonNegativeInteger(value)) {
        errors.push(`${prefix}: ${key} must be a non-negative integer or null`)
      }
    }
    if (nrModeUsesWindows && effectiveStart != null && effectiveEnd != null && effectiveStart > effectiveEnd) {
      errors.push(`${prefix}: allocation window start must not exceed end`)
    }
  }
  if (mode === 'CAPACITY_PLAN' && (effectiveStart == null || effectiveEnd == null)) {
    errors.push(
      `${prefix}: CAPACITY_PLAN without a captured start/end window cannot be ` +
      'translated without guessing capacity',
    )
  }
  return errors
}

/**
 * Map translated v2 profiles to the shared structural-validator input shape.
 * Used by the authoritative translator and the restorability classifier so
 * snapshot-level shape errors are computed identically.
 */
export function v2ProfilesToStructureInput(
  profiles: TranslatedV2Profile[],
): Parameters<typeof validatePersistedCapacityProfiles>[0] {
  return profiles.map(p => ({
    id: p.id,
    projectId: p.projectId,
    resourceTypeId: p.resourceTypeId,
    namedResourceId: p.namedResourceId,
    ownerKind: p.ownerKind,
    planningBasis: p.planningBasis,
    source: p.source,
    defaultPercent: p.defaultPercent,
    startWeek: p.startWeek,
    endWeek: p.endWeek,
    segments: [],
  }))
}

/**
 * Structural validation of a complete translated v2 profile set (duplicate
 * owners, enum values, windows, segments, segmentless-CAPACITY_PROFILE rule)
 * — the exact call the authoritative translator performs, shared with the
 * restorability classifier so snapshot-level shape errors are attributed the
 * same way.
 */
export function validateV2TranslatedProfiles(
  profiles: TranslatedV2Profile[],
  projectId: string,
  snapshot: SnapshotV2,
): string[] {
  return validatePersistedCapacityProfiles(
    v2ProfilesToStructureInput(profiles),
    {
      projectId,
      resourceTypeIds: new Set(snapshot.resourceTypes.map(rt => rt.id)),
      namedResourceIds: new Set(snapshot.namedResources.map(nr => nr.id)),
    },
  ).errors
}

/**
 * Issue #421 never-active window policy.
 *
 * A captured window is "never active" when no non-negative week can ever
 * match it under the legacy scheduler gate (`week >= start && week <= end`):
 *
 *  - both edges are the `-1` sentinel that the legacy Squad Planner apply
 *    path wrote for named resources without an assigned slot window
 *    (`routes/squadPlan.ts`, pre-#359: `slotWindows[idx] ?? { startWeek: -1,
 *    endWeek: -1, allocationPercent: 100 }`); or
 *  - the window is inverted (`start > end`), which the legacy scheduler
 *    tolerated without clamping — no week satisfies the gate, so the entry
 *    contributed zero capacity.
 *
 * Evidence: `server/src/test/scheduler.test.ts` ("slot never active →
 * endWeek=-1 → does not contribute capacity") and the pre-cutover
 * `scheduler.getWeeklyCapacity` window gate (`start = nr.startWeek ?? 0`,
 * `end = nr.endWeek ?? Infinity`, match only when `week >= start &&
 * week <= end`). `null`/`Infinity` meant unbounded; `-1` never meant
 * "unset" or "unbounded" — it meant "never active".
 *
 * The translated state is a zero-capacity profile (defaultPercent 0, null
 * window): the exact historical effective capacity, never a guess. A single
 * `-1` edge (or any other negative value) has no established meaning and is
 * NOT normalised here — callers treat it as requiring an explicit decision.
 */
export function isNeverActiveWindow(
  start: number | null | undefined,
  end: number | null | undefined,
): boolean {
  if (start === -1 && end === -1) return true
  // Inverted window with non-negative edges: the legacy scheduler tolerated it
  // without clamping and no week can ever match the gate.
  return (
    start != null &&
    end != null &&
    Number.isFinite(start) &&
    Number.isFinite(end) &&
    start >= 0 &&
    end >= 0 &&
    start > end
  )
}

/**
 * Deterministic translation of a historical v2 snapshot into authoritative
 * CapacityProfile rows, using ONLY the values captured in the v2 payload
 * (never the active CapacityPlan, never sync/reconciliation tooling).
 *
 * Mode mapping (shared by readiness and rollback — single source of truth):
 *   - null/undefined/EFFORT  → DEMAND_FOLLOWING / FIXED, windows DISCARDED
 *                              (EFFORT did not use them — stale aliases in the
 *                              captured payload are ignored)
 *   - FULL_PROJECT           → WHOLE_PROJECT_ALLOCATION / FIXED, windows
 *                              DISCARDED (FULL_PROJECT did not use them)
 *   - TIMELINE               → AVAILABILITY_WINDOW / AVAILABILITY_WINDOW,
 *                              preserving the captured window
 *   - CAPACITY_PLAN          → AVAILABILITY_WINDOW / LEGACY, preserving the
 *                              captured window (a segmentless CAPACITY_PROFILE
 *                              ROLE/NAMED_PERSON profile is invalid authority;
 *                              CAPACITY_PLAN without a captured start/end
 *                              window cannot be translated without guessing
 *                              and is rejected).
 *   - never-active windows    → (-1, -1) pairs (the legacy Squad Planner
 *                              "no slot window" sentinel) and inverted windows
 *                              (start > end, tolerated unclamped by the legacy
 *                              scheduler) translate to a zero-capacity
 *                              AVAILABILITY_WINDOW profile with a null window
 *                              (issue #421 policy, `isNeverActiveWindow`).
 *
 * Every NamedResource must reference a ResourceType included in the same
 * snapshot (orphan rows are rejected with a clear error before any write).
 *
 * The complete translated set is structurally validated through the single
 * authoritative validator; errors are returned for the caller to reject
 * before any destructive write.
 */
export function translateV2SnapshotProfiles(
  snapshot: SnapshotV2,
  projectId: string,
): V2TranslationResult {
  const errors: string[] = []
  const profiles: TranslatedV2Profile[] = []
  const rtById = new Map(snapshot.resourceTypes.map(rt => [rt.id, rt]))

  const modeBasisSource = (mode: string | null | undefined): {
    basis: TranslatedV2Profile['planningBasis']
    source: TranslatedV2Profile['source']
  } => {
    switch (mode) {
      case 'TIMELINE':
        return { basis: 'AVAILABILITY_WINDOW', source: 'AVAILABILITY_WINDOW' }
      case 'FULL_PROJECT':
        return { basis: 'WHOLE_PROJECT_ALLOCATION', source: 'FIXED' }
      case 'CAPACITY_PLAN':
        return { basis: 'AVAILABILITY_WINDOW', source: 'LEGACY' }
      case 'EFFORT':
      default:
        return { basis: 'DEMAND_FOLLOWING', source: 'FIXED' }
    }
  }

  for (let i = 0; i < snapshot.resourceTypes.length; i++) {
    const rt = snapshot.resourceTypes[i]
    const prefix = `v2 snapshot resourceTypes[${i}] (${rt.name})`
    if (rt.allocationMode != null && !KNOWN_V2_MODES.has(rt.allocationMode)) {
      errors.push(`${prefix}: unknown allocationMode "${String(rt.allocationMode)}"`)
      continue
    }
    errors.push(...v2ResourceTypeEntryErrors(rt, prefix))
    const rtModeUsesWindows = rt.allocationMode === 'TIMELINE' || rt.allocationMode === 'CAPACITY_PLAN'
    // Issue #421 never-active policy: a captured (-1, -1) pair or an inverted
    // window (start > end) never contributed capacity; it translates to a
    // zero-capacity profile with a null window instead of failing.
    const rtNeverActive =
      rtModeUsesWindows &&
      isNeverActiveWindow(rt.allocationStartWeek, rt.allocationEndWeek)
    const { basis, source } = modeBasisSource(rt.allocationMode)
    // EFFORT / FULL_PROJECT never used window aliases — deterministic
    // translation discards them so the resulting DEMAND_FOLLOWING /
    // WHOLE_PROJECT_ALLOCATION profile is structurally valid.
    const modeDiscardsWindows = rt.allocationMode === 'EFFORT' || rt.allocationMode === 'FULL_PROJECT' || rt.allocationMode == null
    const roleStartWeek = modeDiscardsWindows || rtNeverActive ? null : rt.allocationStartWeek
    const roleEndWeek = modeDiscardsWindows || rtNeverActive ? null : rt.allocationEndWeek
    profiles.push({
      id: `snapshot-v2-role-${rt.id}`,
      projectId,
      resourceTypeId: rt.id,
      namedResourceId: null,
      ownerKind: 'ROLE',
      planningBasis: basis,
      source,
      defaultPercent: rtNeverActive ? 0 : rt.allocationPercent,
      startWeek: roleStartWeek,
      endWeek: roleEndWeek,
      legacy: {
        allocationMode: rt.allocationMode,
        allocationPercent: rt.allocationPercent,
        allocationStartWeek: rt.allocationStartWeek,
        allocationEndWeek: rt.allocationEndWeek,
      },
    })
  }

  for (let i = 0; i < snapshot.namedResources.length; i++) {
    const nr = snapshot.namedResources[i]
    const prefix = `v2 snapshot namedResources[${i}] (${nr.name})`
    // ── Orphan-owner rejection: every NamedResource must reference a
    // ResourceType included in the same snapshot (issue #418 PR 1 review).
    if (!nr.resourceTypeId) {
      errors.push(
        `${prefix}: named resource "${nr.id}" has no resourceTypeId and cannot be ` +
        'translated into authoritative ownership',
      )
      continue
    }
    if (!rtById.has(nr.resourceTypeId)) {
      errors.push(
        `${prefix}: named resource "${nr.id}" references resource type "${nr.resourceTypeId}" ` +
        'which is absent from this snapshot — orphan ownership cannot be translated',
      )
      continue
    }
    const parentRt = rtById.get(nr.resourceTypeId)
    const mode = v2EffectiveNamedMode(nr, parentRt)
    if (mode != null && !KNOWN_V2_MODES.has(mode)) {
      errors.push(`${prefix}: unknown allocationMode "${String(mode)}"`)
      continue
    }
    errors.push(...v2NamedResourceEntryErrors(nr, parentRt, prefix))
    const effectiveStart = nr.allocationStartWeek ?? nr.startWeek
    const effectiveEnd = nr.allocationEndWeek ?? nr.endWeek
    const nrModeUsesWindows = mode === 'TIMELINE' || mode === 'CAPACITY_PLAN'
    // Issue #421 never-active policy (same as the resource-type branch): a
    // captured (-1, -1) pair or inverted window never contributed capacity;
    // its window aliases are normalised instead of rejected.
    const nrNeverActive =
      nrModeUsesWindows && isNeverActiveWindow(effectiveStart, effectiveEnd)
    const { basis, source } = modeBasisSource(mode)
    const effectivePercent = nr.allocationPercent ?? nr.allocationPct
    // EFFORT / FULL_PROJECT never used window aliases — discard them so the
    // resulting DEMAND_FOLLOWING / WHOLE_PROJECT_ALLOCATION profile is
    // structurally valid.
    const modeDiscardsWindows = mode === 'EFFORT' || mode === 'FULL_PROJECT' || mode == null
    const namedStartWeek = modeDiscardsWindows || nrNeverActive ? null : effectiveStart
    const namedEndWeek = modeDiscardsWindows || nrNeverActive ? null : effectiveEnd
    profiles.push({
      id: `snapshot-v2-named-${nr.id}`,
      projectId,
      resourceTypeId: null,
      namedResourceId: nr.id,
      ownerKind: 'NAMED_PERSON',
      planningBasis: basis,
      source,
      defaultPercent: nrNeverActive ? 0 : effectivePercent,
      startWeek: namedStartWeek,
      endWeek: namedEndWeek,
      legacy: {
        allocationMode: mode,
        allocationPct: nr.allocationPct,
        allocationPercent: nr.allocationPercent,
        allocationStartWeek: nr.allocationStartWeek,
        allocationEndWeek: nr.allocationEndWeek,
        startWeek: nr.startWeek,
        endWeek: nr.endWeek,
      },
    })
  }

  // Structural validation of the complete translated set (duplicate owners,
  // enum values, windows, segments, segmentless-CAPACITY_PROFILE rule).
  errors.push(...validateV2TranslatedProfiles(profiles, projectId, snapshot))

  return { profiles, errors }
}

// ─── V2 rollback: rebuild profiles from v2 compatibility fields ──────────────

/**
 * During V2 rollback, after restoring ResourceTypes, NamedResources, epics, and
 * other v2 state, delete all existing project capacity profiles/segments and
 * create deterministic profiles derived solely from the v2 payload via the
 * shared `translateV2SnapshotProfiles` helper (the same translation/validation
 * rules the readiness command uses — issue #418 PR 1 review).
 *
 * This never reads the active CapacityPlan or calls
 * syncCapacityProfilesForProject — it creates only what the v2 snapshot
 * captures. An untranslatable payload throws before any profile write.
 */
export async function recreateV2CapacityProfiles(
  tx: CapacityProfileTxClient,
  projectId: string,
  snapshot: SnapshotV2,
  retainedProfiles: RetainedRoleProfile[] = [],
): Promise<void> {
  const { profiles, errors } = translateV2SnapshotProfiles(snapshot, projectId)
  if (errors.length > 0) {
    throw new Error(`Cannot restore v2 snapshot capacity: ${errors.join('; ')}`)
  }

  // Delete all existing project profiles (segments cascade via onDelete: Cascade)
  await tx.capacitySegment.deleteMany({ where: { capacityProfile: { projectId } } })
  await tx.capacityProfile.deleteMany({ where: { projectId } })

  for (const profile of profiles) {
    await tx.capacityProfile.create({
      data: {
        id: profile.id,
        project: { connect: { id: projectId } },
        ownerKind: profile.ownerKind as never,
        resourceType: profile.resourceTypeId ? { connect: { id: profile.resourceTypeId } } : undefined,
        namedResource: profile.namedResourceId ? { connect: { id: profile.namedResourceId } } : undefined,
        planningBasis: profile.planningBasis as never,
        source: profile.source as never,
        defaultPercent: profile.defaultPercent,
        startWeek: profile.startWeek,
        endWeek: profile.endWeek,
        legacy: profile.legacy as never,
      },
    })
  }

  // Post-snapshot resource types survive rollback (established contract), so
  // their validated ROLE profiles are re-created atomically with exact IDs.
  await recreateRetainedRoleProfiles(tx, projectId, retainedProfiles)
}

// ─── V3 rollback: exact profile/segment replacement ──────────────────────────

/**
 * During V3/V4 rollback, after restoring all common v2 state (RTs, NRs, epics,
 * etc.), delete ALL current project capacity profiles/segments and recreate
 * each target profile with exact IDs, projectId forced to the route projectId,
 * owner IDs, enum values, nulls, and legacy. Every segment is recreated with
 * exact id, profile FK, values, and source.
 *
 * This is an exact replacement — no broad legacy sync afterward.
 */
export async function recreateV3CapacityProfiles(
  tx: CapacityProfileTxClient,
  projectId: string,
  v3: SnapshotV3 | SnapshotV4,
  retainedProfiles: RetainedRoleProfile[] = [],
): Promise<void> {
  // Delete existing segments then profiles (segments cascade but we delete both
  // explicitly for clarity; deleteMany on profile cascades segments but the
  // explicit segment delete ensures ordering)
  await tx.capacitySegment.deleteMany({ where: { capacityProfile: { projectId } } })
  await tx.capacityProfile.deleteMany({ where: { projectId } })

  for (const profile of v3.capacityProfiles) {
    await tx.capacityProfile.create({
      data: {
        id: profile.id,
        project: { connect: { id: projectId } },
        ownerKind: profile.ownerKind,
        resourceType: profile.resourceTypeId ? { connect: { id: profile.resourceTypeId } } : undefined,
        namedResource: profile.namedResourceId ? { connect: { id: profile.namedResourceId } } : undefined,
        planningBasis: profile.planningBasis,
        source: profile.source,
        defaultPercent: profile.defaultPercent,
        startWeek: profile.startWeek,
        endWeek: profile.endWeek,
        legacy: snapshotJsonValueToPrisma(profile.legacy),
      },
    })

    for (const seg of profile.segments) {
      await tx.capacitySegment.create({
        data: {
          id: seg.id,
          capacityProfile: { connect: { id: profile.id } },
          startWeek: seg.startWeek,
          endWeek: seg.endWeek,
          capacityPercent: seg.capacityPercent,
          source: seg.source,
        },
      })
    }
  }

  // Post-snapshot resource types survive rollback (established contract), so
  // their validated ROLE profiles are re-created atomically with exact IDs.
  await recreateRetainedRoleProfiles(tx, projectId, retainedProfiles)
}

/** Convert a retained profile's exact legacy semantics to the Prisma write value. */
function retainedLegacyToPrisma(
  profile: RetainedRoleProfile,
): Prisma.NullableJsonNullValueInput | Prisma.InputJsonValue {
  switch (profile.legacyKind) {
    case 'DB_NULL':
      return Prisma.DbNull
    case 'JSON_NULL':
      return Prisma.JsonNull
    default:
      return profile.legacy as Prisma.InputJsonValue
  }
}

/** Re-create retained post-snapshot ROLE profiles with exact IDs and segments. */
async function recreateRetainedRoleProfiles(
  tx: CapacityProfileTxClient,
  projectId: string,
  retainedProfiles: RetainedRoleProfile[],
): Promise<void> {
  for (const profile of retainedProfiles) {
    await tx.capacityProfile.create({
      data: {
        id: profile.id,
        project: { connect: { id: projectId } },
        ownerKind: 'ROLE' as const,
        resourceType: { connect: { id: profile.resourceTypeId } },
        namedResource: undefined,
        planningBasis: profile.planningBasis as never,
        source: profile.source as never,
        defaultPercent: profile.defaultPercent,
        startWeek: profile.startWeek,
        endWeek: profile.endWeek,
        legacy: retainedLegacyToPrisma(profile),
      },
    })
    for (const seg of profile.segments) {
      await tx.capacitySegment.create({
        data: {
          id: seg.id,
          capacityProfile: { connect: { id: profile.id } },
          startWeek: seg.startWeek,
          endWeek: seg.endWeek,
          capacityPercent: seg.capacityPercent,
          source: seg.source as never,
        },
      })
    }
  }
}
