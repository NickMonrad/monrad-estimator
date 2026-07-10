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

function effectivePercent(nr: NRToClassify): number {
  return Math.round(nr.allocationPercent ?? nr.allocationPct ?? 100)
}

function effectiveStartWeek(nr: NRToClassify): number | null {
  return nr.allocationStartWeek ?? nr.startWeek ?? null
}

function effectiveEndWeek(nr: NRToClassify): number | null {
  return nr.allocationEndWeek ?? nr.endWeek ?? null
}

function oldRolePercent(oldRole: OldRoleDefault): number {
  return Math.round(oldRole.allocationPercent ?? 100)
}

function nrMatchesOldRoleDefault(
  nr: NRToClassify,
  oldRole: OldRoleDefault,
): boolean {
  const modeMatches = effectiveMode(nr, oldRole) === oldRole.allocationMode
  const pctMatches = effectivePercent(nr) === oldRolePercent(oldRole)

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
 * Rules:
 *
 * 1. NRs WITHOUT any persisted profile are always **inherited** — they are
 *    fresh/auto-created (e.g. from POST) and have never been through capacity
 *    sync. Their values are Prisma defaults or route-set, not user customisation.
 *
 * 2. NRs WITH a persisted profile where `legacy === null | undefined` are
 *    **explicit** — the profile was created by a profile-first write route
 *    (`upsertNRProfileAndProjectLegacy`), which never sets `legacy`.
 *
 * 3. NRs WITH a persisted profile where `ownerKind === 'PLANNED_RESOURCE'` are
 *    **explicit** — synthetic/planned resources must not retroactively inherit
 *    role default changes.
 *
 * 4. NRs WITH a persisted profile that has populated `legacy` (sync-derived)
 *    are classified by comparing their effective pre-update allocation against
 *    the old role default:
 *      - Effective allocation matches old role default → **inherited**
 *      - Effective allocation differs → **explicit/custom**
 *
 *    Effective allocation uses the same resolution as `capacityProfileMapping.ts`:
 *      - Mode: `nr.allocationMode ?? oldRole.allocationMode ?? null`
 *      - Percent: `nr.allocationPercent ?? nr.allocationPct ?? 100`
 *      - Start: `nr.allocationStartWeek ?? nr.startWeek ?? null`
 *      - End: `nr.allocationEndWeek ?? nr.endWeek ?? null`
 *
 * This ensures that backfilled NR profiles (populated `legacy` from sync) are
 * correctly distinguished: those whose allocation matched the original role
 * default are inherited; those whose allocation differed are preserved.
 */
export function classifyNRsForRoleUpdate(
  nrs: NRToClassify[],
  nrProfiles: NRProfileState[],
  oldRoleDefault: OldRoleDefault,
): ClassificationResult {
  const profileByNRId = new Map<string, NRProfileState>()
  for (const p of nrProfiles) {
    if (p.namedResourceId) {
      // Only keep the first profile per NR (there should be exactly one)
      if (!profileByNRId.has(p.namedResourceId)) {
        profileByNRId.set(p.namedResourceId, p)
      }
    }
  }

  const inheritedNRIds: string[] = []
  const explicitNRIds: string[] = []

  for (const nr of nrs) {
    const profile = profileByNRId.get(nr.id)

    // No profile at all → fresh/auto-created NR, never sync'd → inherited
    if (!profile) {
      inheritedNRIds.push(nr.id)
      continue
    }

    // Profile-first explicit profile (legacy === null/undefined) → explicit
    if (profile.legacy === null || profile.legacy === undefined) {
      explicitNRIds.push(nr.id)
      continue
    }

    // Planned resource → explicit
    if (profile.ownerKind === 'PLANNED_RESOURCE') {
      explicitNRIds.push(nr.id)
      continue
    }

    // Sync-derived profile: compare effective allocation with old role default
    if (nrMatchesOldRoleDefault(nr, oldRoleDefault)) {
      inheritedNRIds.push(nr.id)
    } else {
      explicitNRIds.push(nr.id)
    }
  }

  return { inheritedNRIds, explicitNRIds }
}
