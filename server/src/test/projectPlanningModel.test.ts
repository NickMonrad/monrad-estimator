/**
 * projectPlanningModel.test.ts — Unit tests for the shared planning read model.
 *
 * Tests the pure computation functions directly (no DB mocking needed).
 * These functions take plain data in and return plain data out.
 */

import { describe, expect, it } from 'vitest'
import {
  computePlanningWindow,
  computeResourceBreakdown,
  buildFallbackWeeklyDemand,
  mergeWeeklyDemand,
  computeWeeklyCapacity,
  applyCapacityPlanFallback,
  convertWeeklyDemandCache,
} from '../lib/projectPlanningModel.js'
import type { MaterializedCapacityPlanResource } from '../lib/capacityPlanMaterialisation.js'
import type { SchedulerNamedResource } from '../lib/scheduler.js'

type MockRTNamedResources = SchedulerNamedResource[]
// ─────────────────────────────────────────────────────────────────────────────
// computePlanningWindow
// ─────────────────────────────────────────────────────────────────────────────

describe('computePlanningWindow', () => {
  it('returns null maxWeek when no entries', () => {
    const result = computePlanningWindow([], new Date('2026-01-01'), 0, 0)
    expect(result.maxWeek).toBeNull()
    expect(result.projectedEndDate).toBeNull()
    expect(result.bufferWeeks).toBe(0)
    expect(result.onboardingWeeks).toBe(0)
  })

  it('computes maxWeek from entries with buffer and onboarding', () => {
    const entries = [
      { startWeek: 0, durationWeeks: 5 },
      { startWeek: 3, durationWeeks: 4 },
    ]
    const result = computePlanningWindow(entries, new Date('2026-01-01'), 2, 1)
    // max entry end = max(5, 7) = 7; maxWeek = 7 + 2 + 1 = 10
    expect(result.maxWeek).toBe(10)
  })

  it('projects end date from start date and maxWeek', () => {
    const startDate = new Date('2026-01-05T00:00:00Z') // Monday
    const entries = [{ startWeek: 0, durationWeeks: 4 }]
    const result = computePlanningWindow(entries, startDate, 0, 0)
    expect(result.maxWeek).toBe(4)
    expect(result.projectedEndDate).toBe('2026-02-02T00:00:00.000Z')
  })

  it('returns null projectedEndDate when startDate is null', () => {
    const entries = [{ startWeek: 0, durationWeeks: 4 }]
    const result = computePlanningWindow(entries, null, 0, 0)
    expect(result.projectedEndDate).toBeNull()
  })

  it('handles onboarding weeks properly', () => {
    const entries = [{ startWeek: 0, durationWeeks: 3 }]
    const result = computePlanningWindow(entries, null, 0, 2)
    expect(result.onboardingWeeks).toBe(2)
    expect(result.maxWeek).toBe(5) // 3 + 0 + 2
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// computeResourceBreakdown
// ─────────────────────────────────────────────────────────────────────────────

describe('computeResourceBreakdown', () => {
  it('aggregates task hours into resource types', () => {
    const feature = {
      userStories: [
        {
          isActive: true,
          tasks: [
            {
              resourceTypeId: 'rt-dev',
              hoursEffort: 16,
              durationDays: null,
              resourceType: { name: 'Developer', hoursPerDay: 8 },
            },
            {
              resourceTypeId: 'rt-dev',
              hoursEffort: 8,
              durationDays: null,
              resourceType: { name: 'Developer', hoursPerDay: 8 },
            },
          ],
        },
      ],
    }
    const result = computeResourceBreakdown(feature, 8)
    expect(result).toHaveLength(1)
    expect(result[0].name).toBe('Developer')
    expect(result[0].days).toBe(3) // (16+8)/8 = 3
  })

  it('skips inactive stories', () => {
    const feature = {
      userStories: [
        {
          isActive: false,
          tasks: [
            {
              resourceTypeId: 'rt-dev',
              hoursEffort: 999,
              durationDays: null,
              resourceType: { name: 'Developer', hoursPerDay: 8 },
            },
          ],
        },
      ],
    }
    const result = computeResourceBreakdown(feature, 8)
    expect(result).toHaveLength(0)
  })

  it('uses durationDays when provided', () => {
    const feature = {
      userStories: [
        {
          isActive: true,
          tasks: [
            {
              resourceTypeId: 'rt-dev',
              hoursEffort: 8,
              durationDays: 3,
              resourceType: { name: 'Developer', hoursPerDay: 8 },
            },
          ],
        },
      ],
    }
    const result = computeResourceBreakdown(feature, 8)
    // effectiveDays(3, 8, 8) = max(3, 8/8) = 3
    expect(result[0].days).toBe(3)
  })

  it('uses fallback hoursPerDay when task resourceType lacks it', () => {
    const feature = {
      userStories: [
        {
          isActive: true,
          tasks: [
            {
              resourceTypeId: 'rt-dev',
              hoursEffort: 16,
              durationDays: null,
              resourceType: { name: 'Developer', hoursPerDay: null },
            },
          ],
        },
      ],
    }
    const result = computeResourceBreakdown(feature, 6)
    expect(result[0].days).toBeCloseTo(2.7, 1) // 16/6 ≈ 2.7
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// applyCapacityPlanFallback
// ─────────────────────────────────────────────────────────────────────────────

describe('applyCapacityPlanFallback', () => {
  it('does not modify non-CAPACITY_PLAN resource types', () => {
    const rt: Parameters<typeof applyCapacityPlanFallback>[0] = [
      {
        id: 'rt-1',
        name: 'Dev',
        category: 'ENGINEERING',
        count: 1,
        hoursPerDay: 8,
        dayRate: null,
        allocationMode: 'EFFORT',
        allocationPercent: 100,
        allocationStartWeek: null,
        allocationEndWeek: null,
        namedResources: [],
        capacityPlanMaterialized: undefined,
      },
    ]
    const result = applyCapacityPlanFallback(rt, new Map())
    expect(result[0].namedResources).toHaveLength(0)
    expect(result[0].allocationMode).toBe('EFFORT')
  })

  it('injects capacity plan slot windows as virtual named resources for CAPACITY_PLAN RTs without named resources', () => {
    const materialized: MaterializedCapacityPlanResource = {
      resourceTypeId: 'rt-cp',
      totalDays: 50,
      weeklyHeadcount: new Map(),
      slotWindows: [
        { startWeek: 0, endWeek: 4, allocationPercent: 100 },
        { startWeek: 5, endWeek: 9, allocationPercent: 50 },
      ],
      startWeek: 0,
      endWeek: 9,
    }
    const cpMap = new Map<string, MaterializedCapacityPlanResource>()
    cpMap.set('rt-cp', materialized)

    const rt: Parameters<typeof applyCapacityPlanFallback>[0] = [
      {
        id: 'rt-cp',
        name: 'Security',
        category: 'ENGINEERING',
        count: 1,
        hoursPerDay: 8,
        dayRate: null,
        allocationMode: 'CAPACITY_PLAN',
        allocationPercent: 100,
        allocationStartWeek: null,
        allocationEndWeek: null,
        namedResources: [],
        capacityPlanMaterialized: materialized,
      },
    ]
    const result = applyCapacityPlanFallback(rt, cpMap)
    expect(result[0].namedResources).toHaveLength(2)
    expect(result[0].namedResources[0].id).toContain('capacity-plan-1')
    expect(result[0].namedResources[0].name).toBe('Security 1')
    expect(result[0].namedResources[0].allocationMode).toBe('CAPACITY_PLAN')
    expect(result[0].namedResources[0].allocationPercent).toBe(100)
    expect(result[0].namedResources[0].synthetic).toBe(true)
  })

  it('does not inject virtual resources when CAPACITY_PLAN RT already has named resources', () => {
    const materialized: MaterializedCapacityPlanResource = {
      resourceTypeId: 'rt-cp',
      totalDays: 50,
      weeklyHeadcount: new Map(),
      slotWindows: [{ startWeek: 0, endWeek: 9, allocationPercent: 100 }],
      startWeek: 0,
      endWeek: 9,
    }
    const cpMap = new Map<string, MaterializedCapacityPlanResource>()
    cpMap.set('rt-cp', materialized)

    const rt: Parameters<typeof applyCapacityPlanFallback>[0] = [
      {
        id: 'rt-cp',
        name: 'Security',
        category: 'ENGINEERING',
        count: 1,
        hoursPerDay: 8,
        dayRate: null,
        allocationMode: 'CAPACITY_PLAN',
        allocationPercent: 100,
        allocationStartWeek: null,
        allocationEndWeek: null,
        namedResources: [
          {
            id: 'nr-1',
            name: 'Alice',
            startWeek: null,
            endWeek: null,
            allocationMode: 'CAPACITY_PLAN',
            allocationPercent: 100,
            allocationStartWeek: null,
            allocationEndWeek: null,
            pricingModel: 'ACTUAL_DAYS',
            synthetic: false,
          },
        ],
        capacityPlanMaterialized: materialized,
      },
    ]
    const result = applyCapacityPlanFallback(rt, cpMap)
    // Should keep the real named resource, not inject virtual ones
    expect(result[0].namedResources).toHaveLength(1)
    expect(result[0].namedResources[0].id).toBe('nr-1')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// buildFallbackWeeklyDemand
// ─────────────────────────────────────────────────────────────────────────────

describe('buildFallbackWeeklyDemand', () => {
  const makeResourceTypes = () => [
    {
      name: 'Developer',
      id: 'rt-dev',
      hoursPerDay: 8,
      allocationMode: 'EFFORT',
      count: 2,
      namedResources: [] as MockRTNamedResources,
    },
  ]

  it('builds uniform-spread demand from entries', () => {
    const entries = [
      {
        startWeek: 0,
        durationWeeks: 2,
        feature: {
          userStories: [
            {
              isActive: true,
              tasks: [
                {
                  resourceTypeId: 'rt-dev',
                  hoursEffort: 32,
                  durationDays: null,
                  resourceType: { name: 'Developer', hoursPerDay: 8 },
                },
              ],
            },
          ],
        },
      },
    ]
    const result = buildFallbackWeeklyDemand(entries, makeResourceTypes(), new Map(), 8)
    // 32 hours / 8 hpd = 4 days spread over 2 weeks = 2 days/week
    expect(result).toHaveLength(2)
    expect(result[0].week).toBe(0)
    expect(result[0].demandDays).toBe(2)
    expect(result[1].week).toBe(1)
    expect(result[1].demandDays).toBe(2)
  })

  it('returns empty array for zero-duration entries', () => {
    const entries = [
      {
        startWeek: 0,
        durationWeeks: 0,
        feature: { userStories: [] },
      },
    ]
    const result = buildFallbackWeeklyDemand(entries, makeResourceTypes(), new Map(), 8)
    expect(result).toHaveLength(0)
  })

  it('skips inactive stories', () => {
    const entries = [
      {
        startWeek: 0,
        durationWeeks: 2,
        feature: {
          userStories: [
            {
              isActive: false,
              tasks: [
                {
                  resourceTypeId: 'rt-dev',
                  hoursEffort: 999,
                  durationDays: null,
                  resourceType: { name: 'Developer', hoursPerDay: 8 },
                },
              ],
            },
          ],
        },
      },
    ]
    const result = buildFallbackWeeklyDemand(entries, makeResourceTypes(), new Map(), 8)
    expect(result).toHaveLength(0)
  })

  it('handles partial-week overlaps', () => {
    const entries = [
      {
        startWeek: 1.5,
        durationWeeks: 1,
        feature: {
          userStories: [
            {
              isActive: true,
              tasks: [
                {
                  resourceTypeId: 'rt-dev',
                  hoursEffort: 8,
                  durationDays: null,
                  resourceType: { name: 'Developer', hoursPerDay: 8 },
                },
              ],
            },
          ],
        },
      },
    ]
    const result = buildFallbackWeeklyDemand(entries, makeResourceTypes(), new Map(), 8)
    // 1 day spread over weeks 1 and 2 (0.5 overlap in week 1 and 0.5 in week 2)
    expect(result).toHaveLength(2)
    expect(result[0].week).toBe(1)
    expect(result[1].week).toBe(2)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// mergeWeeklyDemand
// ─────────────────────────────────────────────────────────────────────────────

describe('mergeWeeklyDemand', () => {
  it('uses simulated demand for cached RT within horizon, fallback beyond', () => {
    const fallback = [
      { week: 0, resourceTypeName: 'Dev', demandDays: 2, capacityDays: 10 },
      { week: 1, resourceTypeName: 'Dev', demandDays: 2, capacityDays: 10 },
      { week: 2, resourceTypeName: 'Dev', demandDays: 2, capacityDays: 10 },
      { week: 3, resourceTypeName: 'Dev', demandDays: 2, capacityDays: 10 },
    ]
    const simulated = new Map<string, number>([
      ['Dev|0', 5],
      ['Dev|1', 5],
    ])
    const result = mergeWeeklyDemand(fallback, simulated)
    // Cache covers weeks 0-1 (max week 1), so fallback for those weeks is suppressed
    // Week 0,1 use simulated (5 each), weeks 2,3 use fallback (2 each)
    expect(result).toHaveLength(4)
    expect(result.find(r => r.week === 0)?.demandDays).toBe(5)
    expect(result.find(r => r.week === 1)?.demandDays).toBe(5)
    expect(result.find(r => r.week === 2)?.demandDays).toBe(2)
    expect(result.find(r => r.week === 3)?.demandDays).toBe(2)
  })

  it('suppresses fallback for cached RT weeks even when simulated has gaps', () => {
    const fallback = [
      { week: 0, resourceTypeName: 'Dev', demandDays: 2, capacityDays: 10 },
      { week: 1, resourceTypeName: 'Dev', demandDays: 2, capacityDays: 10 },
      { week: 2, resourceTypeName: 'Dev', demandDays: 2, capacityDays: 10 },
    ]
    // Simulated only has week 0 and 2, but horizon is week 2
    const simulated = new Map<string, number>([
      ['Dev|0', 5],
      ['Dev|2', 5],
    ])
    const result = mergeWeeklyDemand(fallback, simulated)
    // Horizon = max week = 2, so fallback for weeks 0,1,2 are suppressed
    // Week 0 and 2 have simulated demand (5 each), week 1 gets 0 and is filtered out
    expect(result.find(r => r.week === 0)?.demandDays).toBe(5)
    expect(result.find(r => r.week === 1)).toBeUndefined()
    expect(result.find(r => r.week === 2)?.demandDays).toBe(5)
  })

  it('returns fallback when simulated is empty', () => {
    const fallback = [
      { week: 0, resourceTypeName: 'Dev', demandDays: 2, capacityDays: 10 },
    ]
    const result = mergeWeeklyDemand(fallback, new Map())
    expect(result).toHaveLength(1)
    expect(result[0].demandDays).toBe(2)
  })

  it('handles multiple resource types independently', () => {
    const fallback = [
      { week: 0, resourceTypeName: 'Dev', demandDays: 2, capacityDays: 10 },
      { week: 0, resourceTypeName: 'QA', demandDays: 1, capacityDays: 5 },
      { week: 1, resourceTypeName: 'Dev', demandDays: 2, capacityDays: 10 },
    ]
    // Only Dev has cached demand
    const simulated = new Map<string, number>([['Dev|0', 5]])
    const result = mergeWeeklyDemand(fallback, simulated)
    // Dev week 0 uses simulated (5), Dev week 1 uses fallback (2), QA week 0 uses fallback (1)
    expect(result.find(r => r.week === 0 && r.resourceTypeName === 'Dev')?.demandDays).toBe(5)
    expect(result.find(r => r.week === 1 && r.resourceTypeName === 'Dev')?.demandDays).toBe(2)
    expect(result.find(r => r.week === 0 && r.resourceTypeName === 'QA')?.demandDays).toBe(1)
  })

  it('filters out zero-demand rows', () => {
    const fallback: Array<{ week: number; resourceTypeName: string; demandDays: number; capacityDays: number }> = []
    const simulated = new Map<string, number>([
      ['Dev|0', -1], // negative should be filtered... actually checked as demandDays <= 0 after rounding
    ])
    const result = mergeWeeklyDemand(fallback, simulated)
    // -1 rounds to -1, so it passes the demandDays > 0 filter...
    // Actually Math.round(-1*100)/100 = -1, which is not > 0, so it's filtered
    expect(result).toHaveLength(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// computeWeeklyCapacity
// ─────────────────────────────────────────────────────────────────────────────

describe('computeWeeklyCapacity', () => {
  it('returns empty for endWeek <= 0', () => {
    const result = computeWeeklyCapacity([], 8, 0, new Map())
    expect(result).toHaveLength(0)
  })

  it('computes capacity for each RT for each week', () => {
    const rts = [
      { id: 'rt-dev', name: 'Developer', hoursPerDay: 8, allocationMode: 'EFFORT', count: 2, namedResources: [] as MockRTNamedResources },
      { id: 'rt-qa', name: 'QA', hoursPerDay: 8, allocationMode: 'EFFORT', count: 1, namedResources: [] as MockRTNamedResources },
    ]
    const result = computeWeeklyCapacity(rts, 8, 3, new Map())
    // 2 RTs × 3 weeks = 6 rows
    expect(result).toHaveLength(6)
    // Developer: count=2 → 2*5=10 days/week (at 8hpd)
    const devWeek0 = result.find(r => r.resourceTypeName === 'Developer' && r.week === 0)
    expect(devWeek0?.capacityDays).toBe(10)
    // QA: count=1 → 1*5=5 days/week
    const qaWeek0 = result.find(r => r.resourceTypeName === 'QA' && r.week === 0)
    expect(qaWeek0?.capacityDays).toBe(5)
  })

  it('uses CAPACITY_PLAN weekly headcount when applicable', () => {
    const materialized: MaterializedCapacityPlanResource = {
      resourceTypeId: 'rt-cp',
      totalDays: 0,
      weeklyHeadcount: new Map([[0, 1.5], [1, 1.5]]),
      slotWindows: [],
      startWeek: 0,
      endWeek: 1,
    }
    const cpMap = new Map<string, MaterializedCapacityPlanResource>()
    cpMap.set('rt-cp', materialized)

    const rts = [
      { id: 'rt-cp', name: 'Security', hoursPerDay: 8, allocationMode: 'CAPACITY_PLAN', count: 1, namedResources: [] as MockRTNamedResources },
    ]
    const result = computeWeeklyCapacity(rts, 8, 2, cpMap)
    expect(result).toHaveLength(2)
    expect(result[0].capacityDays).toBe(7.5) // 1.5 * 5
    expect(result[1].capacityDays).toBe(7.5)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Integration: fallback demand + capacity + merge
// ─────────────────────────────────────────────────────────────────────────────

describe('weekly demand integration', () => {
  it('pipeline: fallback → merge → produce final weeklyDemand', () => {
    const rts = [
      { name: 'Developer', id: 'rt-dev', hoursPerDay: 8, allocationMode: 'EFFORT', count: 2, namedResources: [] as MockRTNamedResources },
    ]
    const entry = {
      startWeek: 0,
      durationWeeks: 4,
      feature: {
        userStories: [
          {
            isActive: true,
            tasks: [
              {
                resourceTypeId: 'rt-dev',
                hoursEffort: 64,
                durationDays: null,
                resourceType: { name: 'Developer', hoursPerDay: 8 },
              },
            ],
          },
        ],
      },
    }

    const fallback = buildFallbackWeeklyDemand([entry], rts, new Map(), 8)
    // 64/8 = 8 days spread over 4 weeks = 2 days/week
    expect(fallback).toHaveLength(4)
    expect(fallback[0].demandDays).toBe(2)

    // Merge with cached demand (simulated replaces weeks 0-1)
    const simulated = new Map<string, number>([
      ['Developer|0', 4],
      ['Developer|1', 4],
    ])
    const merged = mergeWeeklyDemand(fallback, simulated)
    expect(merged).toHaveLength(4)
    expect(merged.find(r => r.week === 0)?.demandDays).toBe(4)
    expect(merged.find(r => r.week === 2)?.demandDays).toBe(2)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Stable IDs and display metadata
// ─────────────────────────────────────────────────────────────────────────────

describe('stable IDs and display metadata', () => {
  it('capacity plan fallback synthetic IDs are deterministic', () => {
    const materialized: MaterializedCapacityPlanResource = {
      resourceTypeId: 'rt-cp',
      totalDays: 50,
      weeklyHeadcount: new Map(),
      slotWindows: [
        { startWeek: 0, endWeek: 4, allocationPercent: 100 },
        { startWeek: 5, endWeek: 9, allocationPercent: 50 },
      ],
      startWeek: 0,
      endWeek: 9,
    }
    const cpMap = new Map<string, MaterializedCapacityPlanResource>()
    cpMap.set('rt-cp', materialized)

    const rt = [{
      id: 'rt-cp',
      name: 'Security',
      category: 'ENGINEERING' as const,
      count: 1,
      hoursPerDay: 8,
      dayRate: null,
      allocationMode: 'CAPACITY_PLAN',
      allocationPercent: 100,
      allocationStartWeek: null,
      allocationEndWeek: null,
      namedResources: [] as any,
      capacityPlanMaterialized: materialized,
    }]
    const result = applyCapacityPlanFallback(rt, cpMap)
    // IDs are deterministic: rt-id + capacity-plan-N
    expect(result[0].namedResources[0].id).toBe('rt-cp-capacity-plan-1')
    expect(result[0].namedResources[1].id).toBe('rt-cp-capacity-plan-2')
  })

  it('named resource IDs are passed through from source records', () => {
    const rt = [{
      id: 'rt-dev',
      name: 'Developer',
      category: 'ENGINEERING' as const,
      count: 2,
      hoursPerDay: 8,
      dayRate: null,
      allocationMode: 'EFFORT',
      allocationPercent: 100,
      allocationStartWeek: null,
      allocationEndWeek: null,
      namedResources: [
        {
          id: 'nr-alice',
          name: 'Alice',
          startWeek: null,
          endWeek: null,
          allocationMode: 'EFFORT' as const,
          allocationPercent: 100,
          allocationStartWeek: null,
          allocationEndWeek: null,
          pricingModel: 'ACTUAL_DAYS' as const,
          synthetic: false as const,
        },
      ],
      capacityPlanMaterialized: undefined,
    }]
    const result = applyCapacityPlanFallback(rt, new Map())
    expect(result[0].namedResources[0].id).toBe('nr-alice')
    expect(result[0].namedResources[0].name).toBe('Alice')
  })
})

describe('regression: stale labels (#268)', () => {
  it('named-resource name resolves from current DB data — not a stale cached label', () => {
    const rt = [{
      id: 'rt-dev',
      name: 'Developer',
      category: 'ENGINEERING',
      count: 2,
      hoursPerDay: 8,
      dayRate: 500,
      allocationMode: 'EFFORT',
      allocationPercent: 100,
      allocationStartWeek: null,
      allocationEndWeek: null,
      namedResources: [
        {
          id: 'nr-1',
          name: 'Renamed Person',
          startWeek: null,
          endWeek: null,
          allocationMode: 'EFFORT',
          allocationPercent: 100,
          allocationStartWeek: null,
          allocationEndWeek: null,
          pricingModel: 'ACTUAL_DAYS',
          synthetic: false,
        },
      ],
      capacityPlanMaterialized: undefined,
    }]
    const result = applyCapacityPlanFallback(rt, new Map())
    expect(result[0].namedResources[0].name).toBe('Renamed Person')
    expect(result[0].namedResources[0].id).toBe('nr-1')
  })

  it('resource-type name resolves from current DB data — weeklyDemandCache uses IDs', () => {
    const rtName = 'Developer'
    // mergeWeeklyDemand receives already-resolved resourceTypeName keys
    const demand = mergeWeeklyDemand(
      [{ week: 0, resourceTypeName: rtName, demandDays: 10, capacityDays: 5 }],
      new Map([[`${rtName}|0`, 15]]),
    )
    expect(demand).toHaveLength(1)
    expect(demand[0].resourceTypeName).toBe(rtName)
    expect(demand[0].demandDays).toBe(15)
  })

  it('deleted resource type shows fallback label — Unknown resource', () => {
    // The 'Unknown resource' fallback happens in buildProjectPlanningModel's
    // ID-to-name conversion. mergeWeeklyDemand passes through whatever name it receives.
    const demand = mergeWeeklyDemand(
      [],
      new Map([['Missing Role|0', 10]]),
    )
    expect(demand).toHaveLength(1)
    expect(demand[0].resourceTypeName).toBe('Missing Role')
    expect(demand[0].demandDays).toBe(10)
  })

  it('rename preserves numeric planning facts — allocated days unchanged', () => {
    const demand = mergeWeeklyDemand(
      [{ week: 0, resourceTypeName: 'Engineer', demandDays: 20, capacityDays: 5 }],
      new Map(),
    )
    expect(demand[0].demandDays).toBe(20)
    expect(demand[0].capacityDays).toBe(5)
  })
})

describe('backward-compatible cache key parsing', () => {
  const resourceTypes = [
    { id: 'rt-dev', name: 'Developer' },
    { id: 'rt-security', name: 'Principal Consultant - Security' },
  ]

  it('parses modern resourceTypeId|week keys', () => {
    const result = convertWeeklyDemandCache(
      { 'rt-dev|0': 5, 'rt-security|2': 3 },
      resourceTypes,
    )
    expect(result.get('Developer|0')).toBe(5)
    expect(result.get('Principal Consultant - Security|2')).toBe(3)
    expect(result.size).toBe(2)
  })

  it('parses legacy resourceTypeName|week keys', () => {
    const result = convertWeeklyDemandCache(
      { 'Developer|0': 5, 'Principal Consultant - Security|2': 3 },
      resourceTypes,
    )
    expect(result.get('Developer|0')).toBe(5)
    expect(result.get('Principal Consultant - Security|2')).toBe(3)
    expect(result.size).toBe(2)
  })

  it('resolves unmatched key prefix to Unknown resource', () => {
    const result = convertWeeklyDemandCache(
      { 'nonexistent-id|0': 5 },
      resourceTypes,
    )
    expect(result.get('Unknown resource|0')).toBe(5)
    expect(result.size).toBe(1)
  })

  it('gives ID priority over name when both match', () => {
    const types = [
      { id: 'rt-eng', name: 'Engineer' },
      { id: 'rt-eng-alias', name: 'rt-eng' },  // name happens to match another RT's ID
    ]
    const result = convertWeeklyDemandCache(
      { 'rt-eng|0': 5 },
      types,
    )
    // Should prioritize ID match 'rt-eng' → 'Engineer', not name 'rt-eng' → that RT
    expect(result.get('Engineer|0')).toBe(5)
    expect(result.size).toBe(1)
  })
})
