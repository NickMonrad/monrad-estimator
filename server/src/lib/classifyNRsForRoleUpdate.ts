/**
 * classifyNRsForRoleUpdate.ts — Semantic classification of named resources
 * for the ResourceType capacity update path.
 *
 * Distinguishes inherited NRs (should follow role default) from explicit/custom
 * NRs (should preserve their own profiles) based on pre-update state, not just
 * the `legacy` field on persisted profiles.
 *
 * @see docs/domain/capacity-profile-source-of-truth-migration-plan.md#phase-4
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
 * An NR is **explicit** (protected from inheritance) when ANY of its associated
 * persisted profiles has authoritative evidence:
 *
 * 1. `ownerKind === 'PLANNED_RESOURCE'` — synthetic/planned resource.
 * 2. Non-empty `segments` — fine-grained explicit allocation.
 * 3. `legacy === null | undefined` — profile-first write, never sync-derived.
 *
 * When ALL profiles are sync-derived (populated legacy) the semantic equality
 * of the NR's effective allocation against the old role default decides:
 *
 * - Effective allocation matches old role default → **inherited**
 * - Effective allocation differs → **explicit/custom**
 *
 * An NR with **no persisted profile** also follows semantic equality.
 *
 * Unlike the earlier first-profile-wins approach, this groups profiles by NR
 * and inspects every associated row. A single authoritative profile among
 * duplicates or mixed-origin rows is sufficient to protect the NR.
 *
 * This prevents data loss during PATCH safe reduction when sync-derived
 * (populated-legacy) duplicates coexist with authoritative profiles.
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
  nrs = nrs ?? []
  nrProfiles = nrProfiles ?? []
  // Group ALL profiles by namedResourceId — an NR may have multiple rows
  const profilesByNRId = new Map<string, NRProfileState[]>()
  for (const p of nrProfiles) {
    if (p.namedResourceId) {
      let arr = profilesByNRId.get(p.namedResourceId)
      if (!arr) {
        arr = []
        profilesByNRId.set(p.namedResourceId, arr)
      }
      arr.push(p)
    }
  }

  const inheritedNRIds: string[] = []
  const explicitNRIds: string[] = []

  for (const nr of nrs) {
    const profiles = profilesByNRId.get(nr.id)

    if (profiles && profiles.length > 0) {
      let hasProtectedEvidence = false
      for (const profile of profiles) {
        if (profile.ownerKind === 'PLANNED_RESOURCE') {
          hasProtectedEvidence = true
          break
        }

        if (profile.segments && profile.segments.length > 0) {
          hasProtectedEvidence = true
          break
        }

        if (profile.legacy === null || profile.legacy === undefined) {
          hasProtectedEvidence = true
          break
        }
      }

      if (hasProtectedEvidence) {
        explicitNRIds.push(nr.id)
      } else {
        if (nrMatchesOldRoleDefault(nr, oldRoleDefault)) {
          inheritedNRIds.push(nr.id)
        } else {
          explicitNRIds.push(nr.id)
        }
      }
    } else {
      if (nrMatchesOldRoleDefault(nr, oldRoleDefault)) {
        inheritedNRIds.push(nr.id)
      } else {
        explicitNRIds.push(nr.id)
      }
    }
  }

  return { inheritedNRIds, explicitNRIds }
}
