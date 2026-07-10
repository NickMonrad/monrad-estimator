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
  const profileByNRId = new Map<string, NRProfileState>()
  for (const p of nrProfiles) {
    if (p.namedResourceId) {
      if (!profileByNRId.has(p.namedResourceId)) {
        profileByNRId.set(p.namedResourceId, p)
      }
    }
  }

  const inheritedNRIds: string[] = []
  const explicitNRIds: string[] = []

  for (const nr of nrs) {
    const profile = profileByNRId.get(nr.id)

    if (profile) {
      // 1. Planned-resource owner → explicit
      if (profile.ownerKind === 'PLANNED_RESOURCE') {
        explicitNRIds.push(nr.id)
        continue
      }

      // 2. Non-empty segments → explicit (segments are always explicit profile state)
      if (profile.segments && profile.segments.length > 0) {
        explicitNRIds.push(nr.id)
        continue
      }

      // 3. Profile-first explicit (legacy === null/undefined) → explicit
      if (profile.legacy === null || profile.legacy === undefined) {
        explicitNRIds.push(nr.id)
        continue
      }

      // 4. Sync-derived (populated legacy): compare effective allocation with old role default
      if (nrMatchesOldRoleDefault(nr, oldRoleDefault)) {
        inheritedNRIds.push(nr.id)
      } else {
        explicitNRIds.push(nr.id)
      }
    } else {
      // No persisted profile: classify solely by semantic equality against old role default.
      // No value-pattern provenance inference — only nrMatchesOldRoleDefault decides.
      if (nrMatchesOldRoleDefault(nr, oldRoleDefault)) {
        inheritedNRIds.push(nr.id)
      } else {
        explicitNRIds.push(nr.id)
      }
    }
  }

  return { inheritedNRIds, explicitNRIds }
}
