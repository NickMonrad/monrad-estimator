/**
 * classifyNRsForRoleUpdate.ts — Semantic classification of named resources
 * for the ResourceType capacity update path.
 *
 * Distinguishes inherited NRs (should follow role default) from explicit/custom
 * NRs (should preserve their own profiles) based on the authoritative profile
 * state and persisted provenance. Candidate ResourceType/NamedResource legacy
 * columns are never consulted (issue #418): the "matches the role default"
 * comparison is a profile-shape comparison against the validated old role
 * profile.
 *
 * @see docs/domain/capacity-profile-source-of-truth-migration-plan.md#phase-4
 */

import { isRoleDefaultClone } from './roleProfileClonePolicy.js'

// ─── Input types ─────────────────────────────────────────────────────────────

/** Minimal named-resource identity (no legacy capacity columns). */
export interface NRToClassify {
  id: string
}

export interface NRProfileState {
  namedResourceId: string | null
  provenance?: unknown
  ownerKind?: string
  source?: string | null
  segments?: unknown[]
  planningBasis?: string | null
  defaultPercent?: number | null
  startWeek?: number | null
  endWeek?: number | null
}

/** Authoritative old role profile shape used for inherited-vs-explicit comparison. */
export interface OldRoleProfileShape {
  planningBasis: string
  defaultPercent: number | null
  startWeek: number | null
  endWeek: number | null
  segments: Array<{ startWeek: number; endWeek: number; capacityPercent: number }>
}

export interface ClassificationResult {
  inheritedNRIds: string[]
  explicitNRIds: string[]
}

// ─── Comparison helpers ──────────────────────────────────────────────────────

/** Epsilon for floating-point percent comparison — preserves Prisma/API JSON precision. */
const PCT_EPSILON = 1e-9

function percentsEqual(a: number | null | undefined, b: number | null | undefined): boolean {
  if (a == null && b == null) return true
  if (a == null || b == null) return false
  return Math.abs(a - b) < PCT_EPSILON
}

function segmentFieldsEqual(
  a: { startWeek: number; endWeek: number; capacityPercent: number },
  b: { startWeek: number; endWeek: number; capacityPercent: number },
): boolean {
  return a.startWeek === b.startWeek && a.endWeek === b.endWeek && percentsEqual(a.capacityPercent, b.capacityPercent)
}

function sortSegments<T extends { startWeek: number; endWeek: number; capacityPercent: number }>(segs: T[]): T[] {
  return [...segs].sort(
    (a, b) => a.startWeek - b.startWeek || a.endWeek - b.endWeek || a.capacityPercent - b.capacityPercent,
  )
}

/**
 * Whether a named-resource profile mirrors the old role profile shape —
 * the authoritative equivalent of the former legacy-column equality check.
 */
function profileMatchesOldRoleDefault(
  profile: NRProfileState,
  oldRole: OldRoleProfileShape,
): boolean {
  const nrSegments = (profile.segments ?? []) as Array<{ startWeek: number; endWeek: number; capacityPercent: number }>
  const sortedNrSegments = sortSegments(nrSegments)
  const sortedRoleSegments = sortSegments(oldRole.segments)

  if (sortedNrSegments.length !== sortedRoleSegments.length) return false
  for (let i = 0; i < sortedNrSegments.length; i++) {
    if (!segmentFieldsEqual(sortedNrSegments[i], sortedRoleSegments[i])) return false
  }

  return (
    (profile.planningBasis ?? null) === oldRole.planningBasis &&
    percentsEqual(profile.defaultPercent ?? null, oldRole.defaultPercent) &&
    (profile.startWeek ?? null) === oldRole.startWeek &&
    (profile.endWeek ?? null) === oldRole.endWeek
  )
}

// ─── Main helper ─────────────────────────────────────────────────────────────

/**
 * Classify named resources as inherited or explicit/custom for a role update.
 *
 * An NR is **explicit** (protected from inheritance) when ANY of its associated
 * persisted profiles has authoritative evidence:
 *
 * 1. `ownerKind === 'PLANNED_RESOURCE'` — synthetic/planned resource.
 * 2. `source === 'MANUAL'` — user-authored or transferred.
 * 3. `source === 'SQUAD_PLANNER'` — planner-owned (defensive; routes guard earlier).
 * 4. `provenance === null | undefined` — ordinary profile-first write with no
 *    special behavioural provenance, never a system-derived clone.
 * 5. Non-empty `segments` — fine-grained explicit allocation, UNLESS the
 *    profile is a system-generated role-default clone (`provenance ===
 *    'ROLE_DEFAULT'`): generated segmented resources must remain removable
 *    by a later count reduction, so they fall through to profile-shape
 *    comparison instead.
 *
 * When ALL profiles lack protective evidence (system-derived clones with
 * ROLE_DEFAULT provenance, or legacy mapper-derived rows) the profile-shape
 * equality of the NR's authoritative profile against the old role profile
 * decides:
 *
 * - Profile shape matches the old role profile → **inherited**
 * - Profile shape differs → **explicit/custom**
 *
 * An NR with **no persisted profile** is treated as explicit (defensive;
 * callers validate every NR profile before invoking this helper and fail
 * closed on missing state).
 *
 * Unlike the earlier first-profile-wins approach, this groups profiles by NR
 * and inspects every associated row. A single authoritative profile among
 * duplicates or mixed-origin rows is sufficient to protect the NR.
 *
 * This prevents data loss during PATCH safe reduction when sync-derived
 * duplicates coexist with authoritative profiles.
 *
 * When provenance is uncertain, the classifier prefers to preserve NR data.
 */
export function classifyNRsForRoleUpdate(
  nrs: NRToClassify[],
  nrProfiles: NRProfileState[],
  oldRoleProfile: OldRoleProfileShape,
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

        // Manual/transferred profiles are protected
        if (profile.source === 'MANUAL' || profile.source === 'SQUAD_PLANNER') {
          hasProtectedEvidence = true
          break
        }

        // Ordinary profile-first writes carry no behavioural provenance and
        // are never sync-derived clones.
        if (profile.provenance === null || profile.provenance === undefined) {
          hasProtectedEvidence = true
          break
        }

        // Segments protect unless the profile is a system-generated
        // role-default clone (count increase / NamedResource POST), which
        // must stay removable by count reduction.
        if (profile.segments && profile.segments.length > 0 && !isRoleDefaultClone(profile)) {
          hasProtectedEvidence = true
          break
        }
      }

      if (hasProtectedEvidence) {
        explicitNRIds.push(nr.id)
      } else {
        // System-derived clone / mapper-derived state: authoritative profile
        // shape decides inherited vs explicit.
        if (profiles.some(profile => profileMatchesOldRoleDefault(profile, oldRoleProfile))) {
          inheritedNRIds.push(nr.id)
        } else {
          explicitNRIds.push(nr.id)
        }
      }
    } else {
      // Defensive: no profile — never delete an NR without authoritative state.
      explicitNRIds.push(nr.id)
    }
  }

  return { inheritedNRIds, explicitNRIds }
}
