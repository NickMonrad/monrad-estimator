/**
 * capacityProfileLegacyProjection.ts — Pure projection helpers that convert
 * CapacityProfile / CapacitySegment state back into legacy allocation field shapes.
 *
 * This is the inverse of mapProjectToCapacityProfiles in capacityProfileMapping.ts.
 * It prepares for Phase 3 (source-of-truth write migration) by providing
 * lossy-aware projection logic without writing to any table.
 *
 * @see docs/domain/capacity-profile-source-of-truth-migration-plan.md#phase-2
 */

// ─── Public types ────────────────────────────────────────────────────────────

export type LegacyAllocationMode = 'EFFORT' | 'TIMELINE' | 'FULL_PROJECT' | 'CAPACITY_PLAN'

export interface LegacyAllocationProjection {
  allocationMode: LegacyAllocationMode
  allocationPercent: number | null
  allocationStartWeek: number | null
  allocationEndWeek: number | null
  /** True when the projection is semantically lossy (e.g. multi-segment → single range). */
  lossy: boolean
  /** Human-readable explanation of why the projection is lossy, if applicable. */
  lossReason?: string
}

/** Minimal segment shape consumed by the projection helper. */
export interface SegmentLike {
  startWeek: number
  endWeek: number
  capacityPercent: number
}

/** Minimal profile shape consumed by the projection helper. */
export interface CapacityProfileLike {
  planningBasis: string
  source: string
  defaultPercent?: number | null
  /** Legacy fallback availability-window start week (e.g. TIMELINE without explicit segments). */
  startWeek?: number | null
  /** Legacy fallback availability-window end week. */
  endWeek?: number | null
  segments: SegmentLike[]
}

// ─── Mapping table: planning basis → allocation mode ─────────────────────────

const PLANNING_BASIS_TO_ALLOCATION_MODE: Record<string, LegacyAllocationMode> = {
  demandFollowing: 'EFFORT',
  availabilityWindow: 'TIMELINE',
  wholeProjectAllocation: 'FULL_PROJECT',
  capacityProfile: 'CAPACITY_PLAN',
}

function planningBasisToAllocationMode(basis: string): LegacyAllocationMode {
  return PLANNING_BASIS_TO_ALLOCATION_MODE[basis] ?? 'EFFORT'
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Compute the duration (in weeks) of an inclusive-week segment.
 * Duration = endWeek - startWeek + 1  (both ends inclusive).
 */
function segmentDuration(seg: SegmentLike): number {
  return Math.max(0, seg.endWeek - seg.startWeek + 1)
}

/**
 * Compute a duration-weighted average capacity percent across segments.
 * Weight = segment duration (inclusive weeks).
 */
function weightedAveragePercent(segments: SegmentLike[]): number {
  if (segments.length === 0) return 100
  let totalWeight = 0
  let weightedSum = 0
  for (const seg of segments) {
    const w = segmentDuration(seg)
    totalWeight += w
    weightedSum += w * seg.capacityPercent
  }
  if (totalWeight === 0) return 100
  return Math.round((weightedSum / totalWeight) * 100) / 100
}

// ─── Main projection function ────────────────────────────────────────────────

/**
 * Project a CapacityProfile back into legacy allocation field values.
 *
 * This is a pure, lossy-aware helper. It does NOT read or write any database.
 *
 * ## Projection rules
 *
 * | Profile shape | Legacy projection |
 * |---|---|
 * | `null` / `undefined` profile | Returns `null` — caller preserves existing legacy fields |
 * | Demand-following (no segments) | `EFFORT`, `defaultPercent`, no window |
 * | Single availability-window segment | `TIMELINE`, segment `capacityPercent`, `startWeek`/`endWeek` |
 * | Multi-segment | Merged range: `min(startWeek)`–`max(endWeek)`, duration-weighted avg `capacityPercent`, **lossy: true** |
 * | CAPACITY_PLAN / Squad Planner | `CAPACITY_PLAN`, merged range if multi-segment, **lossy: true** when lossy |
 *
 * @param profile - The capacity profile to project, or null/undefined.
 * @returns A `LegacyAllocationProjection` describing the best-effort legacy representation,
 *          or `null` if no projection is meaningful (caller should preserve existing fields).
 */
export function projectCapacityProfileToLegacyAllocation(
  profile: CapacityProfileLike | null | undefined,
): LegacyAllocationProjection | null {
  if (!profile) return null

  const allocationMode = planningBasisToAllocationMode(profile.planningBasis)
  const segments = profile.segments ?? []
  const defaultPercent = profile.defaultPercent ?? 100
  const profileStartWeek = profile.startWeek ?? null
  const profileEndWeek = profile.endWeek ?? null

  // ── No segments → effort / availability-window projection ────────────
  if (segments.length === 0) {
    // For availability-window / TIMELINE profiles, preserve the start/end range
    if (profileStartWeek != null || profileEndWeek != null) {
      return {
        allocationMode: 'TIMELINE',
        allocationPercent: defaultPercent,
        allocationStartWeek: profileStartWeek,
        allocationEndWeek: profileEndWeek,
        lossy: false,
      }
    }
    return {
      allocationMode,
      allocationPercent: defaultPercent,
      allocationStartWeek: null,
      allocationEndWeek: null,
      lossy: false,
    }
  }

  // ── Single segment → lossless projection ────────────────────────────────
  if (segments.length === 1) {
    const seg = segments[0]
    return {
      allocationMode: allocationMode === 'EFFORT' ? 'TIMELINE' : allocationMode,
      allocationPercent: seg.capacityPercent,
      allocationStartWeek: seg.startWeek,
      allocationEndWeek: seg.endWeek,
      lossy: false,
    }
  }

  // ── Multi-segment → lossy merged-range projection ───────────────────────
  const startWeek = Math.min(...segments.map(s => s.startWeek))
  const endWeek = Math.max(...segments.map(s => s.endWeek))
  const avgPercent = weightedAveragePercent(segments)

  const result: LegacyAllocationProjection = {
    allocationMode,
    allocationPercent: avgPercent,
    allocationStartWeek: startWeek,
    allocationEndWeek: endWeek,
    lossy: true,
    lossReason: `Multi-segment profile projected to merged range W${startWeek}–W${endWeek} at ${avgPercent}% (duration-weighted average). Individual segment granularity is lost.`,
  }

  return result
}
