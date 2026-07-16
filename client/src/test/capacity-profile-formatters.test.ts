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
  deriveEffectiveAvailabilityState,
  getEffectiveAvailabilityDisplay,
  getEffectiveAvailabilityBadge,
  getEffectiveAvailabilityPeriod,
  formatEffectiveAvailabilityPeriod,
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
      'Availability varies by week. Open the Resource Profile tab to review or configure the weekly pattern.'
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

describe('deriveEffectiveAvailabilityState', () => {
  it('handles legacy EFFORT with no profile', () => {
    const result = deriveEffectiveAvailabilityState({ allocationMode: 'EFFORT' })
    expect(result.effectiveMode).toBe('EFFORT')
    expect(result.isProfileManaged).toBe(false)
    expect(result.hasAuthoritativeProfile).toBe(false)
    expect(result.hasMeaningfulSegments).toBe(false)
    expect(result.resolutionSource).toBeUndefined()
  })

  it('handles legacy TIMELINE with no profile', () => {
    const result = deriveEffectiveAvailabilityState({ allocationMode: 'TIMELINE' })
    expect(result.effectiveMode).toBe('TIMELINE')
    expect(result.isProfileManaged).toBe(false)
  })

  it('marks ACTIVE_CAPACITY_PLAN as profile-managed', () => {
    const result = deriveEffectiveAvailabilityState({
      allocationMode: 'EFFORT',
      capacityProfile: {
        resolutionSource: 'ACTIVE_CAPACITY_PLAN',
        planningBasis: 'wholeProjectAllocation',
        segments: [{ startWeek: 0, endWeek: 3, capacityPercent: 50 }],
      },
    })
    expect(result.effectiveMode).toBe('CAPACITY_PLAN')
    expect(result.isProfileManaged).toBe(true)
    expect(result.hasAuthoritativeProfile).toBe(true)
    expect(result.hasMeaningfulSegments).toBe(true)
    expect(result.resolutionSource).toBe('ACTIVE_CAPACITY_PLAN')
  })

  it('marks PROFILE + capacityProfile + stale EFFORT as profile-managed', () => {
    const result = deriveEffectiveAvailabilityState({
      allocationMode: 'EFFORT',
      capacityProfile: {
        resolutionSource: 'PROFILE',
        planningBasis: 'capacityProfile',
        segments: [],
      },
    })
    expect(result.effectiveMode).toBe('CAPACITY_PLAN')
    expect(result.isProfileManaged).toBe(true)
    expect(result.hasAuthoritativeProfile).toBe(true)
  })

  it('marks PROFILE + availabilityWindow + segments as profile-managed even with stale TIMELINE', () => {
    const result = deriveEffectiveAvailabilityState({
      allocationMode: 'TIMELINE',
      capacityProfile: {
        resolutionSource: 'PROFILE',
        planningBasis: 'availabilityWindow',
        segments: [{ startWeek: 0, endWeek: 2, capacityPercent: 50 }, { startWeek: 3, endWeek: 5, capacityPercent: 75 }],
      },
    })
    expect(result.effectiveMode).toBe('CAPACITY_PLAN')
    expect(result.isProfileManaged).toBe(true)
    expect(result.hasMeaningfulSegments).toBe(true)
    expect(result.resolutionSource).toBe('PROFILE')
  })

  it('marks PROFILE + wholeProjectAllocation + segments as profile-managed even with stale FULL_PROJECT', () => {
    const result = deriveEffectiveAvailabilityState({
      allocationMode: 'FULL_PROJECT',
      capacityProfile: {
        resolutionSource: 'PROFILE',
        planningBasis: 'wholeProjectAllocation',
        segments: [{ startWeek: 0, endWeek: 12, capacityPercent: 100 }],
      },
    })
    expect(result.effectiveMode).toBe('CAPACITY_PLAN')
    expect(result.isProfileManaged).toBe(true)
    expect(result.hasMeaningfulSegments).toBe(true)
  })

  it('marks PROFILE + capacityProfile + segments as profile-managed', () => {
    const result = deriveEffectiveAvailabilityState({
      allocationMode: 'EFFORT',
      capacityProfile: {
        resolutionSource: 'PROFILE',
        planningBasis: 'capacityProfile',
        segments: [{ startWeek: 0, endWeek: 3, capacityPercent: 100 }],
      },
    })
    expect(result.effectiveMode).toBe('CAPACITY_PLAN')
    expect(result.isProfileManaged).toBe(true)
    expect(result.hasMeaningfulSegments).toBe(true)
  })

  it('allows editing for authoritative availabilityWindow with NO segments (maps to TIMELINE)', () => {
    const result = deriveEffectiveAvailabilityState({
      allocationMode: 'TIMELINE',
      capacityProfile: {
        resolutionSource: 'PROFILE',
        planningBasis: 'availabilityWindow',
        segments: [],
      },
    })
    expect(result.effectiveMode).toBe('TIMELINE')
    expect(result.isProfileManaged).toBe(false)
    expect(result.hasAuthoritativeProfile).toBe(true)
    expect(result.hasMeaningfulSegments).toBe(false)
  })

  it('allows editing for authoritative wholeProjectAllocation with NO segments (maps to FULL_PROJECT)', () => {
    const result = deriveEffectiveAvailabilityState({
      allocationMode: 'EFFORT',
      capacityProfile: {
        resolutionSource: 'PROFILE',
        planningBasis: 'wholeProjectAllocation',
        segments: [],
      },
    })
    expect(result.effectiveMode).toBe('FULL_PROJECT')
    expect(result.isProfileManaged).toBe(false)
    expect(result.hasAuthoritativeProfile).toBe(true)
  })

  it('allows editing for authoritative demandFollowing with NO segments (maps to EFFORT)', () => {
    const result = deriveEffectiveAvailabilityState({
      allocationMode: 'TIMELINE',
      capacityProfile: {
        resolutionSource: 'PROFILE',
        planningBasis: 'demandFollowing',
        segments: [],
      },
    })
    expect(result.effectiveMode).toBe('EFFORT')
    expect(result.isProfileManaged).toBe(false)
  })
})


describe('getEffectiveAvailabilityDisplay', () => {
  const staleTimeline = {
    allocationMode: 'TIMELINE',
    allocationPercent: 25,
    allocationStartWeek: 2,
    allocationEndWeek: 6,
    derivedStartWeek: 3,
    derivedEndWeek: 7,
  }

  it.each([
    ['demandFollowing', 'EFFORT', false],
    ['wholeProjectAllocation', 'FULL_PROJECT', false],
    ['availabilityWindow', 'TIMELINE', false],
    ['capacityProfile', 'CAPACITY_PLAN', true],
  ] as const)('keeps PROFILE %s null bounds authoritative over stale legacy dates', (planningBasis, mode, managed) => {
    const result = getEffectiveAvailabilityDisplay({
      ...staleTimeline,
      capacityProfile: {
        resolutionSource: 'PROFILE', planningBasis, defaultPercent: 75,
        startWeek: null, endWeek: null, segments: [],
      },
    })

    expect(result.effectiveMode).toBe(mode)
    expect(result.isProfileManaged).toBe(managed)
    expect(result.percentage).toBe(75)
    expect(result.startWeek).toBeNull()
    expect(result.endWeek).toBeNull()
    expect(result.periodLabel).toBe(managed ? 'Varies by week' : null)
  })

  it('keeps ACTIVE_CAPACITY_PLAN null bounds authoritative over stale legacy dates', () => {
    const result = getEffectiveAvailabilityDisplay({
      ...staleTimeline,
      capacityProfile: {
        resolutionSource: 'ACTIVE_CAPACITY_PLAN', planningBasis: 'availabilityWindow',
        defaultPercent: 50, startWeek: null, endWeek: null, segments: [],
      },
    })

    expect(result.effectiveMode).toBe('CAPACITY_PLAN')
    expect(result.isProfileManaged).toBe(true)
    expect(result.percentage).toBe(50)
    expect(result.startWeek).toBeNull()
    expect(result.endWeek).toBeNull()
    expect(result.periodLabel).toBe('Varies by week')
  })

  it('uses legacy fields only when no authoritative profile resolves', () => {
    const result = getEffectiveAvailabilityDisplay(staleTimeline)
    expect(result.startWeek).toBe(2)
    expect(result.endWeek).toBe(6)
    expect(result.percentage).toBe(25)
    expect(result.periodLabel).toBeNull()
  })
})

describe('effective availability period formatter', () => {
  const format = (row: Parameters<typeof getEffectiveAvailabilityDisplay>[0], projectDurationWeeks = 12) =>
    formatEffectiveAvailabilityPeriod(
      getEffectiveAvailabilityPeriod(getEffectiveAvailabilityDisplay(row), projectDurationWeeks),
    )

  it('uses project boundaries for authoritative whole-project profiles with null bounds', () => {
    expect(format({
      allocationMode: 'TIMELINE',
      allocationStartWeek: 3,
      allocationEndWeek: 7,
      capacityProfile: {
        resolutionSource: 'PROFILE',
        planningBasis: 'wholeProjectAllocation',
        defaultPercent: 75,
        startWeek: null,
        endWeek: null,
      },
    })).toBe('Wk 0 – Wk 12')
  })

  it('uses project boundaries for legacy whole-project rows', () => {
    expect(format({
      allocationMode: 'FULL_PROJECT',
      allocationStartWeek: 3,
      allocationEndWeek: 7,
    })).toBe('Wk 0 – Wk 12')
  })

  it.each([
    ['selected-week range', { allocationMode: 'TIMELINE', allocationStartWeek: 3, allocationEndWeek: 7 }, 'Wk 3 – Wk 7'],
    ['selected-week start only', { allocationMode: 'TIMELINE', allocationStartWeek: 3 }, 'From Wk 3'],
    ['selected-week end only', { allocationMode: 'TIMELINE', allocationEndWeek: 7 }, 'Until Wk 7'],
    ['selected-week null bounds', { allocationMode: 'TIMELINE' }, '—'],
    ['demand following with stale dates', { allocationMode: 'EFFORT', allocationStartWeek: 3, allocationEndWeek: 7 }, '—'],
  ] as const)('formats %s', (_case, row, expected) => {
    expect(format(row)).toBe(expected)
  })

  it('keeps authoritative null selected-week bounds empty despite stale legacy and derived dates', () => {
    expect(format({
      allocationMode: 'TIMELINE',
      allocationStartWeek: 3,
      allocationEndWeek: 7,
      derivedStartWeek: 4,
      derivedEndWeek: 8,
      capacityProfile: {
        resolutionSource: 'PROFILE',
        planningBasis: 'availabilityWindow',
        startWeek: null,
        endWeek: null,
      },
    })).toBe('—')
  })

  it.each([
    ['segmented profile', {
      allocationMode: 'TIMELINE',
      capacityProfile: {
        resolutionSource: 'PROFILE',
        planningBasis: 'availabilityWindow',
        segments: [{ startWeek: 0, endWeek: 2, capacityPercent: 50 }],
      },
    }],
    ['active capacity plan', {
      allocationMode: 'TIMELINE',
      capacityProfile: {
        resolutionSource: 'ACTIVE_CAPACITY_PLAN',
        planningBasis: 'wholeProjectAllocation',
      },
    }],
  ] as const)('formats %s as varying by week', (_case, row) => {
    expect(format(row)).toBe('Varies by week')
  })
})

describe('getEffectiveAvailabilityBadge', () => {
  it.each([
    ['effort', { allocationMode: 'EFFORT' }, 'As needed'],
    ['whole project', { allocationMode: 'FULL_PROJECT', allocationPercent: 75 }, 'Fixed for whole project · 75%'],
    ['selected weeks', { allocationMode: 'TIMELINE', allocationPercent: 75 }, 'Fixed for selected weeks · 75%'],
    ['weekly profile', {
      allocationMode: 'TIMELINE',
      capacityProfile: { resolutionSource: 'ACTIVE_CAPACITY_PLAN', planningBasis: 'capacityProfile', defaultPercent: 75 },
    }, 'Varies by week'],
  ] as const)('uses the canonical %s label', (_case, row, label) => {
    expect(getEffectiveAvailabilityBadge(getEffectiveAvailabilityDisplay(row)).label).toBe(label)
  })
})
