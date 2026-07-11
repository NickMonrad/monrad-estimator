import { describe, expect, it } from 'vitest'
import {
  formatPlanningBasis,
  formatCapacityProfileSource,
  formatResolutionSource,
  isPlanningBasis,
  isCapacityProfileSource,
  isResolutionSource,
} from '../lib/capacityProfileFormatting'

describe('formatPlanningBasis', () => {
  it('formats demandFollowing', () => {
    expect(formatPlanningBasis('demandFollowing')).toBe('Demand-following')
  })

  it('formats availabilityWindow', () => {
    expect(formatPlanningBasis('availabilityWindow')).toBe('Availability window')
  })

  it('formats wholeProjectAllocation', () => {
    expect(formatPlanningBasis('wholeProjectAllocation')).toBe('Whole-project allocation')
  })

  it('formats capacityProfile', () => {
    expect(formatPlanningBasis('capacityProfile')).toBe('Capacity profile')
  })

})

describe('formatCapacityProfileSource', () => {
  it('formats squadPlanner', () => {
    expect(formatCapacityProfileSource('squadPlanner')).toBe('Squad Planner')
  })

  it('formats fixed', () => {
    expect(formatCapacityProfileSource('fixed')).toBe('Fixed')
  })

  it('formats manual', () => {
    expect(formatCapacityProfileSource('manual')).toBe('Manual')
  })

  it('formats availabilityWindow', () => {
    expect(formatCapacityProfileSource('availabilityWindow')).toBe('Availability window')
  })

  it('formats imported', () => {
    expect(formatCapacityProfileSource('imported')).toBe('Imported')
  })

  it('formats derived', () => {
    expect(formatCapacityProfileSource('derived')).toBe('Derived')
  })

  it('formats legacy', () => {
    expect(formatCapacityProfileSource('legacy')).toBe('Legacy fallback')
  })

})

describe('formatResolutionSource', () => {
  it('formats PROFILE', () => {
    expect(formatResolutionSource('PROFILE')).toBe('Profile')
  })

  it('formats LEGACY', () => {
    expect(formatResolutionSource('LEGACY')).toBe('Legacy')
  })

  it('formats ACTIVE_CAPACITY_PLAN', () => {
    expect(formatResolutionSource('ACTIVE_CAPACITY_PLAN')).toBe('Active capacity plan')
  })

})

describe('isPlanningBasis type guard', () => {
  it('returns true for valid values', () => {
    expect(isPlanningBasis('demandFollowing')).toBe(true)
    expect(isPlanningBasis('availabilityWindow')).toBe(true)
    expect(isPlanningBasis('wholeProjectAllocation')).toBe(true)
    expect(isPlanningBasis('capacityProfile')).toBe(true)
  })

  it('returns false for invalid values', () => {
    expect(isPlanningBasis('invalid')).toBe(false)
    expect(isPlanningBasis('EFFORT')).toBe(false)
    expect(isPlanningBasis('')).toBe(false)
  })
})

describe('isCapacityProfileSource type guard', () => {
  it('returns true for valid values', () => {
    expect(isCapacityProfileSource('squadPlanner')).toBe(true)
    expect(isCapacityProfileSource('fixed')).toBe(true)
    expect(isCapacityProfileSource('manual')).toBe(true)
    expect(isCapacityProfileSource('availabilityWindow')).toBe(true)
    expect(isCapacityProfileSource('imported')).toBe(true)
    expect(isCapacityProfileSource('derived')).toBe(true)
    expect(isCapacityProfileSource('legacy')).toBe(true)
  })

  it('returns false for invalid values', () => {
    expect(isCapacityProfileSource('unknown')).toBe(false)
    expect(isCapacityProfileSource('')).toBe(false)
  })
})

describe('isResolutionSource type guard', () => {
  it('returns true for valid values', () => {
    expect(isResolutionSource('PROFILE')).toBe(true)
    expect(isResolutionSource('LEGACY')).toBe(true)
    expect(isResolutionSource('ACTIVE_CAPACITY_PLAN')).toBe(true)
  })

  it('returns false for invalid values', () => {
    expect(isResolutionSource('INVALID')).toBe(false)
    expect(isResolutionSource('')).toBe(false)
  })
})
