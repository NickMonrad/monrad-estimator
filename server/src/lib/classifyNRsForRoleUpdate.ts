/**
 * classifyNRsForRoleUpdate.ts — Semantic classification of named resources
 * for the ResourceType capacity update path.
 *
 * Distinguishes inherited NRs (should follow role default) from explicit/custom
 * NRs (should preserve their own profiles) based on pre-update state, not just
 * the `legacy` field on persisted profiles.
 *
 * @see docs/domain/capacity-profile-source-of-truth-migration-plan.md#phase-4
 * @see classifyNRInheritance.test.ts
 */

// ─── Input types ─────────────────────────────────────────────────────────────

export interface NRToClassify {
  id: string
  allocationMode: string | null
  allocationPercent: number | null
  allocationPct: number | null
  allocationStartWeek: number | null
  allocationEndWeek: number | null
  startWeek: number | null
  endWeek: number | null
}

export interface NRProfileState {
  namedResourceId: string | null
  legacy: unknown
  ownerKind?: string
  segments?: unknown[]
}

export interface OldRoleDefault {
  allocationMode: string | null
  allocationPercent: number | null
  allocationStartWeek: number | null
  allocationEndWeek: number | null
}

export interface ClassificationResult {
  inheritedNRIds: string[]
  explicitNRIds: string[]
}

// ─── Field resolution (matches capacityProfileMapping.ts semantics) ──────────

function effectiveMode(
  nr: NRToClassify,
  oldRole: OldRoleDefault,
): string | null {
  return nr.allocationMode ?? oldRole.allocationMode ?? null
}

/** Epsilon for floating-point percent comparison — preserves Prisma/API JSON precision. */
const PCT_EPSILON = 1e-9

function effectivePercent(nr: NRToClassify): number {
  return nr.allocationPercent ?? nr.allocationPct ?? 100
}

function oldRolePercent(oldRole: OldRoleDefault): number {
  return oldRole.allocationPercent ?? 100
}

function percentsEqual(a: number, b: number): boolean {
  return Math.abs(a - b) < PCT_EPSILON
}

function effectiveStartWeek(nr: NRToClassify): number | null {
  return nr.allocationStartWeek ?? nr.startWeek ?? null
}

function effectiveEndWeek(nr: NRToClassify): number | null {
  return nr.allocationEndWeek ?? nr.endWeek ?? null
}

function nrMatchesOldRoleDefault(
  nr: NRToClassify,
  oldRole: OldRoleDefault,
): boolean {
  const modeMatches = effectiveMode(nr, oldRole) === oldRole.allocationMode
  const pctMatches = percentsEqual(effectivePercent(nr), oldRolePercent(oldRole))

  const nrStart = effectiveStartWeek(nr)
  const nrEnd = effectiveEndWeek(nr)
  const startMatches = nrStart === oldRole.allocationStartWeek
  const endMatches = nrEnd === oldRole.allocationEndWeek

  return modeMatches && pctMatches && startMatches && endMatches
}

// ─── Main helper ─────────────────────────────────────────────────────────────

/**
 * Classify named resources as inherited or explicit/custom for a role update.
 *
 * Priority order (first match wins):
 *
 * 1. Persisted profile with `ownerKind === 'PLANNED_RESOURCE'` → **explicit**
 *    Synthetic/planned resources must not retroactively inherit role default changes.
 *
 * 2. Persisted profile with non-empty `segments` → **explicit**
 *    Segments are always explicit profile state, regardless of `legacy` value.
 *
 * 3. Persisted profile with `legacy === null | undefined` → **explicit**
 *    Profile was created by a profile-first write (`upsertNRProfileAndProjectLegacy`),
 *    which never sets `legacy`. (Backfilled/sync-derived profiles always have `legacy`.)
 *
 * 4. Persisted profile with populated `legacy` (sync-derived):
 *    - Effective allocation matches old role default → **inherited**
 *    - Effective allocation differs → **explicit/custom**
 *
 * 5. **No persisted profile**: classification is based solely on semantic equality
 *    of the effective allocation against the old role default:
 *    - Effective allocation matches old role default → **inherited**
 *    - Effective allocation differs → **explicit/custom**
 *
 *    There is no value-pattern provenance inference (`isFreshNR`). The NR is never
 *    treated as "fresh by default shape" — only `nrMatchesOldRoleDefault` decides.
 *
 * Effective allocation uses the same resolution as `capacityProfileMapping.ts`:
 *   - Mode: `nr.allocationMode ?? oldRole.allocationMode ?? null`
 *   - Percent: `nr.allocationPercent ?? nr.allocationPct ?? 100` (epsilon comparison)
 *   - Start: `nr.allocationStartWeek ?? nr.startWeek ?? null`
 *   - End: `nr.allocationEndWeek ?? nr.endWeek ?? null`
 *
 * Percentages are compared with `Math.abs(a - b) < 1e-9` to preserve floating-point
 * precision from Prisma/API JSON without collapsing distinct values via rounding.
 *
 * When provenance is uncertain, the classifier prefers to preserve NR data.
 */
export function classifyNRsForRoleUpdate(
  nrs: NRToClassify[],
  nrProfiles: NRProfileState[],
  oldRoleDefault: OldRoleDefault,
): ClassificationResult {
  const profilesByNRId = new Map<string, NRProfileState[]>()
  for (const p of nrProfiles) {
    if (p.namedResourceId) {
      const list = profilesByNRId.get(p.namedResourceId)
      if (list) {
        list.push(p)
      } else {
        profilesByNRId.set(p.namedResourceId, [p])
      }
    }
  }

  const inheritedNRIds: string[] = []
  const explicitNRIds: string[] = []

  for (const nr of nrs) {
    const profiles = profilesByNRId.get(nr.id) ?? []

    if (profiles.length > 0) {
      let isExplicit = false
      for (const p of profiles) {
        // 1. Planned-resource owner → explicit
        if (p.ownerKind === 'PLANNED_RESOURCE') { isExplicit = true; break }
        // 2. Non-empty segments → explicit (segments are always explicit profile state)
        if (p.segments && p.segments.length > 0) { isExplicit = true; break }
        // 3. Profile-first explicit (legacy === null/undefined) → explicit
        if (p.legacy === null || p.legacy === undefined) { isExplicit = true; break }
      }

      if (isExplicit) {
        explicitNRIds.push(nr.id)
      } else {
        // 4. All profiles are sync-derived (populated legacy): compare once
        if (nrMatchesOldRoleDefault(nr, oldRoleDefault)) {
          inheritedNRIds.push(nr.id)
        } else {
          explicitNRIds.push(nr.id)
        }
      }
    } else {
      // No persisted profile: classify solely by semantic equality against old role default.
      if (nrMatchesOldRoleDefault(nr, oldRoleDefault)) {
        inheritedNRIds.push(nr.id)
      } else {
        explicitNRIds.push(nr.id)
      }
    }
  }

  return { inheritedNRIds, explicitNRIds }
}
// ─── Legacy Int projection ──────────────────────────────────────────────

/** Round a Float allocationPercent to the legacy Int allocationPct field.
 *  Never write a Float directly to the Int allocationPct column. */
export function toLegacyAllocationPct(pct: number | null | undefined): number | null | undefined {
  if (pct === null || pct === undefined) return pct
  return Math.round(pct)
}

// ─── Pre-mutation state loader ──────────────────────────────────────────

export interface PreMutationRTState {
  /** NamedResource records ordered by createdAt asc. */
  allNRs: Array<{ id: string; name: string }>
  /** CapacityProfile records (with segments) for the NRs above. */
  nrProfiles: Array<NRProfileState>
  /** Pre-update role default, null-normalised. */
  oldRoleDefault: OldRoleDefault
  /** Classification result: which NRs are inherited vs explicit. */
  classification: ClassificationResult
}

interface RTStateTxClient {
  namedResource: {
    findMany(args: {
      where: { resourceTypeId: string };
      orderBy: { createdAt: 'asc' };
    }): Promise<Array<{ id: string; name: string }>>;
  };
  capacityProfile: {
    findMany(args: {
      where: { namedResourceId: { in: string[] } };
      include: { segments: true };
    }): Promise<Array<NRProfileState>>;
  };
}

/**
 * Load all named resources with their capacity profiles, compute the
 * pre-update OldRoleDefault, and classify NRs as inherited/explicit.
 *
 * Call this ONCE before any mutations to get a stable snapshot of the
 * pre-mutation state.  Both PUT and PATCH use this to avoid duplicating
 * the query + classify logic.
 *
 * @param tx  Prisma transaction client (or compatible mock)
 * @param resourceTypeId  The ResourceType whose NRs to load
 * @param existingRT  Pre-update ResourceType row (allocation fields)
 */
export async function loadAndClassifyRTState(
  tx: RTStateTxClient,
  resourceTypeId: string,
  existingRT: {
    allocationMode: string | null
    allocationPercent: number | null
    allocationStartWeek: number | null
    allocationEndWeek: number | null
  },
): Promise<PreMutationRTState> {
  const oldRoleDefault: OldRoleDefault = {
    allocationMode: existingRT.allocationMode,
    allocationPercent: existingRT.allocationPercent ?? null,
    allocationStartWeek: existingRT.allocationStartWeek ?? null,
    allocationEndWeek: existingRT.allocationEndWeek ?? null,
  }

  const allNRs = await tx.namedResource.findMany({
    where: { resourceTypeId },
    orderBy: { createdAt: 'asc' },
  })

  const nrIds: string[] = allNRs.map((nr: { id: string }) => nr.id)
  const nrProfiles = nrIds.length > 0
    ? await tx.capacityProfile.findMany({
        where: { namedResourceId: { in: nrIds } },
        include: { segments: true },
      })
    : []

  const classification = classifyNRsForRoleUpdate(
    allNRs as unknown as NRToClassify[],
    nrProfiles,
    oldRoleDefault,
  )

  return { allNRs, nrProfiles, oldRoleDefault, classification }
}
