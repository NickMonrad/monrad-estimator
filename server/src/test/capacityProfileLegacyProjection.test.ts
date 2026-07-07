/**
 * capacityProfileLegacyProjection.test.ts — Unit tests for the legacy
 * allocation projection helper.
 *
 * These tests verify that CapacityProfile → legacy field conversion is
 * correct, lossy-aware, and does not mutate inputs.
 *
 * @see server/src/lib/capacityProfileLegacyProjection.ts
 */

import { describe, expect, it } from 'vitest'
import {
  projectCapacityProfileToLegacyAllocation,
  type CapacityProfileLike,
} from '../lib/capacityProfileLegacyProjection.js'

// ─── Helpers ─────────────────────────────────────────────────────────────────

function profile(overrides: Partial<CapacityProfileLike> = {}): CapacityProfileLike {
  return {
    planningBasis: 'demandFollowing',
    source: 'fixed',
    defaultPercent: 100,
    segments: [],
    ...overrides,
  }
}

function seg(startWeek: number, endWeek: number, capacityPercent: number) {
  return { startWeek, endWeek, capacityPercent }
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('projectCapacityProfileToLegacyAllocation', () => {
  it('returns null for a null/undefined profile', () => {
    expect(projectCapacityProfileToLegacyAllocation(null)).toBeNull()
    expect(projectCapacityProfileToLegacyAllocation(undefined)).toBeNull()
  })

  it('projects demand-following profile to EFFORT with defaultPercent', () => {
    const result = projectCapacityProfileToLegacyAllocation(
      profile({ planningBasis: 'demandFollowing', source: 'fixed', defaultPercent: 100 }),
    )

    expect(result).not.toBeNull()
    expect(result!.allocationMode).toBe('EFFORT')
    expect(result!.allocationPercent).toBe(100)
    expect(result!.allocationStartWeek).toBeNull()
    expect(result!.allocationEndWeek).toBeNull()
    expect(result!.lossy).toBe(false)
  })

  it('projects demand-following with non-default percent', () => {
    const result = projectCapacityProfileToLegacyAllocation(
      profile({ planningBasis: 'demandFollowing', source: 'fixed', defaultPercent: 75 }),
    )

    expect(result!.allocationMode).toBe('EFFORT')
    expect(result!.allocationPercent).toBe(75)
    expect(result!.lossy).toBe(false)
  })

  it('projects legacy-sourced demand-following profile to EFFORT', () => {
    // Legacy source is a valid demand-following variant that maps to EFFORT
    const result = projectCapacityProfileToLegacyAllocation(
      profile({ planningBasis: 'demandFollowing', source: 'legacy', defaultPercent: 100 }),
    )

    expect(result!.allocationMode).toBe('EFFORT')
    expect(result!.allocationPercent).toBe(100)
    expect(result!.lossy).toBe(false)
  })

  it('projects single availability-window segment losslessly', () => {
    const result = projectCapacityProfileToLegacyAllocation(
      profile({
        planningBasis: 'availabilityWindow',
        source: 'availabilityWindow',
        segments: [seg(2, 10, 75)],
      }),
    )

    expect(result).not.toBeNull()
    expect(result!.allocationMode).toBe('TIMELINE')
    expect(result!.allocationPercent).toBe(75)
    expect(result!.allocationStartWeek).toBe(2)
    expect(result!.allocationEndWeek).toBe(10)
    expect(result!.lossy).toBe(false)
  })

  it('projects single demand-following segment as TIMELINE (segment presence overrides EFFORT)', () => {
    // When a demand-following profile has a segment, it behaves like an
    // availability window — projection uses TIMELINE mode.
    const result = projectCapacityProfileToLegacyAllocation(
      profile({
        planningBasis: 'demandFollowing',
        source: 'fixed',
        segments: [seg(0, 4, 100)],
      }),
    )

    expect(result!.allocationMode).toBe('TIMELINE')
    expect(result!.allocationPercent).toBe(100)
    expect(result!.allocationStartWeek).toBe(0)
    expect(result!.allocationEndWeek).toBe(4)
    expect(result!.lossy).toBe(false)
  })

  it('projects multi-segment profile to merged range and marks lossy', () => {
    const result = projectCapacityProfileToLegacyAllocation(
      profile({
        planningBasis: 'availabilityWindow',
        source: 'fixed',
        segments: [seg(0, 3, 50), seg(4, 7, 100)],
      }),
    )

    expect(result).not.toBeNull()
    expect(result!.allocationMode).toBe('TIMELINE')
    expect(result!.allocationStartWeek).toBe(0)
    expect(result!.allocationEndWeek).toBe(7)
    expect(result!.lossy).toBe(true)
    expect(result!.lossReason).toBeDefined()
    expect(result!.lossReason).toContain('merged range')
  })

  it('computes duration-weighted average percent for unequal segment durations', () => {
    // Segment A: W1-W4 (4 weeks) at 50%  → weight = 4
    // Segment B: W5-W10 (6 weeks) at 100% → weight = 6
    // Weighted avg: (4*50 + 6*100) / (4 + 6) = (200 + 600) / 10 = 80%
    const result = projectCapacityProfileToLegacyAllocation(
      profile({
        planningBasis: 'availabilityWindow',
        segments: [seg(1, 4, 50), seg(5, 10, 100)],
      }),
    )

    expect(result!.allocationPercent).toBe(80)
    expect(result!.lossy).toBe(true)
  })

  it('projects CAPACITY_PLAN / squadPlanner profile preserving CAPACITY_PLAN mode', () => {
    const result = projectCapacityProfileToLegacyAllocation(
      profile({
        planningBasis: 'capacityProfile',
        source: 'squadPlanner',
        defaultPercent: 100,
        segments: [],
      }),
    )

    expect(result).not.toBeNull()
    expect(result!.allocationMode).toBe('CAPACITY_PLAN')
    expect(result!.allocationPercent).toBe(100)
    expect(result!.allocationStartWeek).toBeNull()
    expect(result!.allocationEndWeek).toBeNull()
    expect(result!.lossy).toBe(false)
  })

  it('projects multi-segment CAPACITY_PLAN profile as lossy', () => {
    const result = projectCapacityProfileToLegacyAllocation(
      profile({
        planningBasis: 'capacityProfile',
        source: 'squadPlanner',
        segments: [seg(0, 7, 50), seg(8, 15, 100)],
      }),
    )

    expect(result!.allocationMode).toBe('CAPACITY_PLAN')
    expect(result!.allocationStartWeek).toBe(0)
    expect(result!.allocationEndWeek).toBe(15)
    expect(result!.lossy).toBe(true)
    expect(result!.lossReason).toBeDefined()
  })

  it('does not mutate the input profile or segment array', () => {
    const input: CapacityProfileLike = {
      planningBasis: 'availabilityWindow',
      source: 'fixed',
      defaultPercent: 100,
      segments: [
        { startWeek: 0, endWeek: 3, capacityPercent: 50 },
        { startWeek: 4, endWeek: 7, capacityPercent: 100 },
      ],
    }
    const frozenSegments = [...input.segments]

    projectCapacityProfileToLegacyAllocation(input)

    expect(input.segments).toHaveLength(2)
    expect(input.segments[0]).toEqual(frozenSegments[0])
    expect(input.segments[1]).toEqual(frozenSegments[1])
    expect(input.planningBasis).toBe('availabilityWindow')
  })

  it('projects wholeProjectAllocation to FULL_PROJECT', () => {
    const result = projectCapacityProfileToLegacyAllocation(
      profile({ planningBasis: 'wholeProjectAllocation', source: 'fixed' }),
    )

    expect(result!.allocationMode).toBe('FULL_PROJECT')
    expect(result!.allocationPercent).toBe(100)
    expect(result!.lossy).toBe(false)
  })
})
