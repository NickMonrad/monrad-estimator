import { describe, expect, it } from 'vitest'
import {
  formatAllocationMode,
  formatAllocationModeDescription,
  formatPlanningBasis,
  formatCapacityProfileSource,
  formatResolutionSource,
  isPlanningBasis,
  isCapacityProfileSource,
  isResolutionSource,
} from '../lib/capacityProfileFormatting'

describe('formatPlanningBasis', () => {
  it('formats demandFollowing', () => {
    expect(formatPlanningBasis('demandFollowing')).toBe('As needed')
  })

  it('formats availabilityWindow', () => {
    expect(formatPlanningBasis('availabilityWindow')).toBe('Fixed for selected weeks')
  })

  it('formats wholeProjectAllocation', () => {
    expect(formatPlanningBasis('wholeProjectAllocation')).toBe('Fixed for whole project')
  })

  it('formats capacityProfile', () => {
    expect(formatPlanningBasis('capacityProfile')).toBe('Varies by week')
  })


describe('formatAllocationMode', () => {
  it('formats EFFORT', () => {
    expect(formatAllocationMode('EFFORT')).toBe('As needed')
  })

  it('formats FULL_PROJECT', () => {
    expect(formatAllocationMode('FULL_PROJECT')).toBe('Fixed for whole project')
  })

  it('formats TIMELINE', () => {
    expect(formatAllocationMode('TIMELINE')).toBe('Fixed for selected weeks')
  })

  it('formats CAPACITY_PLAN', () => {
    expect(formatAllocationMode('CAPACITY_PLAN')).toBe('Varies by week')
  })

  it('passes through unrecognised values', () => {
    expect(formatAllocationMode('UNKNOWN')).toBe('UNKNOWN')
  })

  it('passes through empty string', () => {
    expect(formatAllocationMode('')).toBe('')
  })
})

describe('formatAllocationModeDescription', () => {
  it('describes EFFORT', () => {
    expect(formatAllocationModeDescription('EFFORT')).toBe(
      'Assigned only when scheduled work requires this resource.'
    )
  })

  it('describes FULL_PROJECT', () => {
    expect(formatAllocationModeDescription('FULL_PROJECT')).toBe(
      'Available at the selected percentage from the beginning to the end of the project. Work is assigned only when demand exists.'
    )
  })

  it('describes TIMELINE', () => {
    expect(formatAllocationModeDescription('TIMELINE')).toBe(
      'Available at the selected percentage only between the selected start and end weeks. Work is assigned only when demand exists.'
    )
  })

  it('describes CAPACITY_PLAN', () => {
    expect(formatAllocationModeDescription('CAPACITY_PLAN')).toBe(
      'Availability follows the saved capacity profile. Work is assigned only when demand exists.'
    )
  })

  it('returns empty for unrecognised values', () => {
    expect(formatAllocationModeDescription('UNKNOWN')).toBe('')
  })
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
