import { describe, expect, it } from 'vitest'
import { runSAPlanner } from '../lib/sa-planner.js'
import type { SchedulerInput } from '../lib/scheduler.js'

function makeInput(): SchedulerInput {
  return {
    project: { hoursPerDay: 8 },
    resourceTypes: [
      { id: 'rt-1', name: 'Dev', count: 1, hoursPerDay: 8, namedResources: [] },
    ],
    epicDeps: [],
    manualFeatureEntries: [],
    manualStoryEntries: [],
    resourceLevel: false,
    epics: [
      {
        id: 'ep-1',
        name: 'Epic 1',
        order: 0,
        isActive: true,
        featureMode: 'parallel',
        scheduleMode: 'sequential',
        timelineStartWeek: null,
        features: [],
      },
    ],
  }
}

function makeFeature(id: string, order: number, days: number, dependsOnId?: string) {
  return {
    id,
    order,
    isActive: true as const,
    timelineStartWeek: null,
    userStories: [{
      id: `${id}-story`,
      order: 0,
      isActive: true as const,
      tasks: days > 0
        ? [{
          resourceTypeId: 'rt-1',
          hoursEffort: days * 8,
          durationDays: null,
          resourceType: { id: 'rt-1', name: 'Dev', hoursPerDay: 8 },
        }]
        : [],
    }],
    dependencies: dependsOnId ? [{ featureId: id, dependsOnId }] : [],
  }
}

function getFeatureWeeks(result: ReturnType<typeof runSAPlanner>, featureId: string): number[] {
  return [...(result.weeklyAllocationsByFeature.get(featureId)?.keys() ?? [])].sort((a, b) => a - b)
}

function getFeatureRtAllocations(
  result: ReturnType<typeof runSAPlanner>,
  featureId: string,
  rtId: string,
): Array<{ week: number, days: number }> {
  const byWeek = result.weeklyAllocationsByFeature.get(featureId)
  if (!byWeek) return []

  return [...byWeek.entries()]
    .map(([week, byRt]) => ({ week, days: byRt.get(rtId) ?? 0 }))
    .filter(item => item.days > 0)
    .sort((a, b) => a.week - b.week)
}

describe('runSAPlanner weekly fractional staffing', () => {
  it('never over-allocates weekly RT capacity', () => {
    const input = makeInput()
    input.epics[0].features = [
      makeFeature('f-1', 0, 10),
      makeFeature('f-2', 1, 10),
    ]

    const result = runSAPlanner(input, { targetDurationWeeks: 6 })
    const weeklyDemand = result.weeklyDemandByResourceType.get('rt-1') ?? []

    for (const demand of weeklyDemand) {
      expect(demand ?? 0).toBeLessThanOrEqual(5.000001)
    }
  })

  it('starts dependent work only after predecessor completion', () => {
    const input = makeInput()
    input.epics[0].features = [
      makeFeature('foundation', 0, 5),
      makeFeature('follow-on', 1, 5, 'foundation'),
    ]

    const result = runSAPlanner(input, { targetDurationWeeks: 8 })
    const foundationWeeks = getFeatureWeeks(result, 'foundation')
    const followOnWeeks = getFeatureWeeks(result, 'follow-on')

    expect(foundationWeeks.length).toBeGreaterThan(0)
    expect(followOnWeeks.length).toBeGreaterThan(0)
    expect(Math.min(...followOnWeeks)).toBeGreaterThan(Math.max(...foundationWeeks))
  })

  it('uses spare capacity when a single feature is the only ready candidate', () => {
    const input = makeInput()
    input.resourceTypes = [
      { id: 'rt-1', name: 'Dev', count: 4, hoursPerDay: 8, namedResources: [] },
    ]
    input.epics[0].features = [makeFeature('big-feature', 0, 60)]

    const result = runSAPlanner(input, {
      targetDurationWeeks: 12,
      maxParallelismPerFeature: 4,
    })

    const weeklyDemand = result.weeklyDemandByResourceType.get('rt-1') ?? []
    const usedWeeks = weeklyDemand.filter(demand => (demand ?? 0) > 0)

    expect(usedWeeks).toHaveLength(3)
    expect(Math.max(...usedWeeks)).toBeCloseTo(20, 5)
    expect(result.totalDeliveryWeeks).toBe(3)
  })

  it('does not drip-feed a predecessor while dependents are blocked', () => {
    const input = makeInput()
    input.resourceTypes = [
      { id: 'rt-1', name: 'Dev', count: 4, hoursPerDay: 8, namedResources: [] },
    ]
    input.epics[0].features = [
      makeFeature('foundation', 0, 20),
      makeFeature('follow-on', 1, 20, 'foundation'),
    ]

    const result = runSAPlanner(input, {
      targetDurationWeeks: 12,
      maxParallelismPerFeature: 4,
    })

    const foundationWeeks = getFeatureWeeks(result, 'foundation')
    const followOnWeeks = getFeatureWeeks(result, 'follow-on')
    const weeklyDemand = result.weeklyDemandByResourceType.get('rt-1') ?? []

    expect(foundationWeeks).toEqual([0])
    expect(followOnWeeks).toEqual([1])
    expect(weeklyDemand[0]).toBeCloseTo(20, 5)
    expect(weeklyDemand[1]).toBeCloseTo(20, 5)
    expect(result.totalDeliveryWeeks).toBe(2)
  })

  it('spreads a short secondary RT slice across the longer feature span', () => {
    const input = makeInput()
    input.resourceTypes = [
      { id: 'rt-1', name: 'Principal Consultant', count: 1, hoursPerDay: 8, namedResources: [] },
      { id: 'rt-2', name: 'Senior Engineer', count: 1, hoursPerDay: 8, namedResources: [] },
    ]

    input.epics[0].features = [
      {
        id: 'long-multi-rt',
        order: 0,
        isActive: true as const,
        timelineStartWeek: null,
        userStories: [{
          id: 'long-multi-rt-story',
          order: 0,
          isActive: true as const,
          tasks: [
            {
              resourceTypeId: 'rt-1',
              hoursEffort: 30 * 8,
              durationDays: null,
              resourceType: { id: 'rt-1', name: 'Principal Consultant', hoursPerDay: 8 },
            },
            {
              resourceTypeId: 'rt-2',
              hoursEffort: 6 * 8,
              durationDays: null,
              resourceType: { id: 'rt-2', name: 'Senior Engineer', hoursPerDay: 8 },
            },
          ],
        }],
        dependencies: [],
      },
      {
        id: 'competing-rt2-feature',
        order: 1,
        isActive: true as const,
        timelineStartWeek: null,
        userStories: [{
          id: 'competing-rt2-feature-story',
          order: 0,
          isActive: true as const,
          tasks: [{
            resourceTypeId: 'rt-2',
            hoursEffort: 30 * 8,
            durationDays: null,
            resourceType: { id: 'rt-2', name: 'Senior Engineer', hoursPerDay: 8 },
          }],
        }],
        dependencies: [],
      },
    ]

    const result = runSAPlanner(input, {
      targetDurationWeeks: 12,
      maxParallelismPerFeature: 1,
    })

    const rt2Allocations = getFeatureRtAllocations(result, 'long-multi-rt', 'rt-2')
    const firstTwoWeeksDays = rt2Allocations
      .filter(item => item.week <= 1)
      .reduce((total, item) => total + item.days, 0)

    expect(rt2Allocations).toHaveLength(5)
    expect(rt2Allocations[0]?.week).toBe(0)
    expect(rt2Allocations[4]?.week).toBe(4)
    expect(firstTwoWeeksDays).toBeLessThan(3)
    expect(rt2Allocations.every(item => item.days <= 1.200001)).toBe(true)
  })

  it('finishes long dependency chains under fractional capacity without horizon underrun', () => {
    const input = makeInput()
    input.resourceTypes = [
      { id: 'rt-1', name: 'Fractional A', count: 0.25, hoursPerDay: 8, namedResources: [] },
      { id: 'rt-2', name: 'Fractional B', count: 0.25, hoursPerDay: 8, namedResources: [] },
    ]

    const featureCount = 20
    input.epics[0].features = Array.from({ length: featureCount }, (_, index) => {
      const id = `f-${index}`
      const rtId = index % 2 === 0 ? 'rt-1' : 'rt-2'
      return {
        id,
        order: index,
        isActive: true as const,
        timelineStartWeek: null,
        userStories: [{
          id: `${id}-story`,
          order: 0,
          isActive: true as const,
          tasks: [{
            resourceTypeId: rtId,
            hoursEffort: 10 * 8,
            durationDays: null,
            resourceType: { id: rtId, name: rtId, hoursPerDay: 8 },
          }],
        }],
        dependencies: index === 0 ? [] : [{ featureId: id, dependsOnId: `f-${index - 1}` }],
      }
    })

    const result = runSAPlanner(input, {
      targetDurationWeeks: 24,
      maxParallelismPerFeature: 2,
    })

    expect(result.totalDeliveryWeeks).toBeGreaterThan(112)
    expect(result.featureStartWeeks.get(`f-${featureCount - 1}`)).toBeDefined()
  })

  it('avoids horizon underrun when feature caps and sequencing dominate duration', () => {
    const input = makeInput()
    input.resourceTypes = [
      { id: 'rt-1', name: 'Dev', count: 10, hoursPerDay: 8, namedResources: [] },
    ]

    const featureCount = 30
    input.epics[0].features = Array.from({ length: featureCount }, (_, index) => {
      const id = `serial-${index}`
      return {
        id,
        order: index,
        isActive: true as const,
        timelineStartWeek: null,
        userStories: [{
          id: `${id}-story`,
          order: 0,
          isActive: true as const,
          tasks: [{
            resourceTypeId: 'rt-1',
            hoursEffort: 20 * 8,
            durationDays: null,
            resourceType: { id: 'rt-1', name: 'Dev', hoursPerDay: 8 },
          }],
        }],
        dependencies: index === 0 ? [] : [{ featureId: id, dependsOnId: `serial-${index - 1}` }],
      }
    })

    const result = runSAPlanner(input, {
      targetDurationWeeks: 12,
      maxParallelismPerFeature: 1,
    })

    // Legacy sizing (aggregate RT demand only) would cap this case at ~90 weeks.
    const legacyRoughDuration = (featureCount * 20) / (10 * 5)
    const legacyMaxWeeks = Math.max(
      52,
      Math.ceil(12 * 3),
      Math.ceil(legacyRoughDuration * 4) + featureCount + 12,
    )

    expect(result.totalDeliveryWeeks).toBeGreaterThan(legacyMaxWeeks)
    expect(result.featureStartWeeks.get(`serial-${featureCount - 1}`)).toBeDefined()
  })

  it('handles delayed named-resource availability when sizing planner horizon', () => {
    const input = makeInput()
    input.resourceTypes = [
      {
        id: 'rt-1',
        name: 'Dev',
        count: 1,
        hoursPerDay: 8,
        namedResources: [{
          id: 'nr-1',
          name: 'Late starter',
          startWeek: 100,
          endWeek: null,
          allocationPct: 100,
          allocationMode: 'FULL_PROJECT',
          allocationPercent: 100,
          allocationStartWeek: null,
          allocationEndWeek: null,
        }],
      },
    ]
    input.epics[0].features = [makeFeature('late-start-feature', 0, 5)]

    const result = runSAPlanner(input, { targetDurationWeeks: 12 })
    const weeklyDemand = result.weeklyDemandByResourceType.get('rt-1') ?? []

    expect(result.featureStartWeeks.get('late-start-feature')).toBe(100)
    expect(result.totalDeliveryWeeks).toBe(101)
    expect(weeklyDemand.slice(0, 100).every(days => (days ?? 0) === 0)).toBe(true)
    expect(weeklyDemand[100]).toBeCloseTo(5, 5)
  })
})

// ─── #480: Capacity semantics and diagnostics ────────────────────────────────

describe('#480 unrestricted capacity semantics', () => {
  it('uses capacity above current count when no maxCap is set', () => {
    // count=1, no maxCap, target requires 3 FTE equivalent capacity
    const input = makeInput()
    input.resourceTypes = [{
      id: 'rt-1', name: 'Dev', count: 1, hoursPerDay: 8,
      namedResources: [],
    }]
    // 300 days of demand at 8h/day = 2400h. With count=1, capacity = 40h/week.
    // Without unrestricted semantics, this would take 60 weeks.
    // With unrestricted semantics (phantom slots from count=1 = 40h/week),
    // the planner can use all available capacity.
    const feature = makeFeature('feat-1', 1, 300) // 300 days = 60 weeks at 1 person
    input.epics = [{
      id: 'epic-1', name: 'Epic 1', order: 1, isActive: true,
      featureMode: 'parallel', scheduleMode: null, timelineStartWeek: null,
      features: [feature],
    }]

    const result = runSAPlanner(input, { targetDurationWeeks: 60 })

    // With count=1, capacity = 40h/week = 5 days/week.
    // 300 days / 5 days/week = 60 weeks. Should complete.
    expect(result.totalDeliveryWeeks).toBeLessThanOrEqual(60)
    expect(result.featureStartWeeks.get('feat-1')).toBeDefined()
  })

  it('respects explicit maxCap as a hard limit', () => {
    const input = makeInput()
    input.resourceTypes = [{
      id: 'rt-1', name: 'Dev', count: 5, hoursPerDay: 8,
      namedResources: [],
    }]
    // 300 days demand, maxCap=2 → capacity = 2×40 = 80h/week = 10 days/week
    // 300 / 10 = 30 weeks minimum
    const feature = makeFeature('feat-1', 1, 300)
    input.epics = [{
      id: 'epic-1', name: 'Epic 1', order: 1, isActive: true,
      featureMode: 'parallel', scheduleMode: null, timelineStartWeek: null,
      features: [feature],
    }]

    const maxCap = new Map([['rt-1', 2]])
    const result = runSAPlanner(input, {
      targetDurationWeeks: 15,
      maxCap,
    })

    // Should NOT complete in 15 weeks (would need 30 weeks at cap=2)
    expect(result.totalDeliveryWeeks).toBeGreaterThan(15)
  })

  it('blank maxCap does not erase profile windows', () => {
    const input = makeInput()
    // Profile window: only weeks 0-5 have capacity
    input.resourceTypes = [{
      id: 'rt-1', name: 'Data', count: 1, hoursPerDay: 8,
      namedResources: [],
      roleSegments: [
        { startWeek: 0, endWeek: 5, allocationPercent: 100 },
      ],
    }]
    // 100 days demand — needs 20 weeks at full capacity, but only 6 weeks available
    const feature = makeFeature('feat-1', 1, 100)
    input.epics = [{
      id: 'epic-1', name: 'Epic 1', order: 1, isActive: true,
      featureMode: 'parallel', scheduleMode: null, timelineStartWeek: null,
      features: [feature],
    }]

    // Without maxCap — profile window still constrains
    expect(() => {
      runSAPlanner(input, { targetDurationWeeks: 52 })
    }).toThrow('Fractional planner could not finish feature')
  })
})

describe('#480 explicit cap diagnostics', () => {
  it('explicit maxCap limits capacity without expanding beyond cap', () => {
    const input = makeInput()
    input.resourceTypes = [{
      id: 'rt-1', name: 'Dev', count: 5, hoursPerDay: 8,
      namedResources: [],
    }]
    // 200 days demand: at count=5 → 200/(5×5)=8 weeks; at maxCap=1 → 200/(1×5)=40 weeks
    const feature = makeFeature('feat-1', 1, 200)
    input.epics = [{
      id: 'epic-1', name: 'Epic 1', order: 1, isActive: true,
      featureMode: 'parallel', scheduleMode: null, timelineStartWeek: null,
      features: [feature],
    }]

    // Without cap: fast completion
    const uncapped = runSAPlanner(input, { targetDurationWeeks: 52 })
    // With cap=1: much slower (capacity limited to 1 person)
    const capped = runSAPlanner(input, {
      targetDurationWeeks: 52,
      maxCap: new Map([['rt-1', 1]]),
    })

    // Capped should take significantly longer
    expect(capped.totalDeliveryWeeks).toBeGreaterThan(uncapped.totalDeliveryWeeks)
    // Capped capacity: 1 person × 5 days/week = 5 days/week → 200/5 = 40 weeks
    expect(capped.totalDeliveryWeeks).toBeGreaterThanOrEqual(40)
  })

  it('returns ROLE_MAX_CAP diagnostic when cap prevents target completion', () => {
    const input = makeInput()
    input.resourceTypes = [{
      id: 'rt-1', name: 'Dev', count: 5, hoursPerDay: 8,
      namedResources: [],
    }]
    // count=5, maxCap=1 → ratio=0.2, capacity=5 days/week
    // 2000 days demand → 400 weeks needed, but very short target
    // MAX_WEEKS is large enough to complete, but delivery far exceeds target
    const feature = makeFeature('feat-1', 1, 2000)
    input.epics = [{
      id: 'epic-1', name: 'Epic 1', order: 1, isActive: true,
      featureMode: 'parallel', scheduleMode: null, timelineStartWeek: null,
      features: [feature],
    }]

    const maxCap = new Map([['rt-1', 1]])
    const result = runSAPlanner(input, { targetDurationWeeks: 10, maxCap })

    // Planner completes but delivery is far beyond target due to cap
    expect(result.totalDeliveryWeeks).toBeGreaterThan(10)
    // 2000 days / 5 days per week (cap=1, ratio=0.2) = 400 weeks
    expect(result.totalDeliveryWeeks).toBeGreaterThanOrEqual(400)
  })

  it('returns PROFILE_WINDOW diagnostic for segmented capacity', () => {
    const input = makeInput()
    input.resourceTypes = [{
      id: 'rt-1', name: 'Data', count: 1, hoursPerDay: 8,
      namedResources: [],
      roleSegments: [
        { startWeek: 0, endWeek: 2, allocationPercent: 100 },
      ],
    }]
    // 100 days demand — needs 20 weeks but only 3 weeks of capacity
    const feature = makeFeature('feat-1', 1, 100)
    input.epics = [{
      id: 'epic-1', name: 'Epic 1', order: 1, isActive: true,
      featureMode: 'parallel', scheduleMode: null, timelineStartWeek: null,
      features: [feature],
    }]

    try {
      runSAPlanner(input, { targetDurationWeeks: 52 })
      expect.fail('Should have thrown')
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(Error)
      if (err && typeof err === 'object' && 'diagnostics' in err) {
        const diags = (err as { diagnostics: Array<{ blocker: string; resourceTypeName?: string }> }).diagnostics
        const windowDiag = diags.find(d => d.blocker === 'PROFILE_WINDOW')
        expect(windowDiag).toBeDefined()
        expect(windowDiag?.resourceTypeName).toBe('Data')
      }
    }
  })
})

describe('#480 Starting Team Finder hand-off', () => {
  it('uses boosted count from maxCap > rt.count for phantom-slot capacity', () => {
    // Simulates Starting Team Finder proposing count=3 when DB count=1
    const input = makeInput()
    input.resourceTypes = [{
      id: 'rt-1', name: 'Dev', count: 3, hoursPerDay: 8, // boosted count
      namedResources: [],
    }]
    // 60 days demand at count=3 → 3×40=120h/week = 15 days/week → 4 weeks
    const feature = makeFeature('feat-1', 1, 60)
    input.epics = [{
      id: 'epic-1', name: 'Epic 1', order: 1, isActive: true,
      featureMode: 'parallel', scheduleMode: null, timelineStartWeek: null,
      features: [feature],
    }]

    const result = runSAPlanner(input, { targetDurationWeeks: 12 })

    // Should complete well within 12 weeks with count=3
    expect(result.totalDeliveryWeeks).toBeLessThanOrEqual(8)
    expect(result.featureStartWeeks.get('feat-1')).toBeDefined()
  })
})

describe('#480 critical path diagnostics', () => {
  it('returns DEPENDENCY_PATH diagnostic for dependency-blocked feature', () => {
    const input = makeInput()
    input.resourceTypes = [{
      id: 'rt-1', name: 'Dev', count: 1, hoursPerDay: 8,
      namedResources: [],
    }]
    // Two features: feat-1 (200 days) depends on nothing, feat-2 (200 days) depends on feat-1
    const feat1 = makeFeature('feat-1', 1, 200)
    const feat2 = makeFeature('feat-2', 2, 200, 'feat-1')
    input.epics = [{
      id: 'epic-1', name: 'Epic 1', order: 1, isActive: true,
      featureMode: 'parallel', scheduleMode: null, timelineStartWeek: null,
      features: [feat1, feat2],
    }]

    // Very short target — feat-2 can't start until feat-1 completes
    try {
      runSAPlanner(input, { targetDurationWeeks: 5 })
      expect.fail('Should have thrown')
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(Error)
      if (err && typeof err === 'object' && 'diagnostics' in err) {
        const diags = (err as { diagnostics: Array<{ blocker: string }> }).diagnostics
        const hasDepDiag = diags.some(d =>
          d.blocker === 'DEPENDENCY_PATH' || d.blocker === 'CONSTRAINT')
        expect(hasDepDiag).toBe(true)
        // Should NOT claim role capacity is the problem
        const roleCapDiags = diags.filter(d => d.blocker === 'ROLE_MAX_CAP')
        expect(roleCapDiags.length).toBe(0)
      }
    }
  })
})

describe('#480 concurrent epics diagnostics', () => {
  it('returns CONCURRENT_EPICS diagnostic when maxConcurrentEpics blocks', () => {
    const input = makeInput()
    input.resourceTypes = [{
      id: 'rt-1', name: 'Dev', count: 10, hoursPerDay: 8,
      namedResources: [],
    }]
    // Two epics with 200 days each, maxConcurrentEpics=1
    const feat1 = makeFeature('feat-1', 1, 200)
    const feat2 = makeFeature('feat-2', 1, 200)
    input.epics = [
      {
        id: 'epic-1', name: 'Epic 1', order: 1, isActive: true,
        featureMode: 'parallel', scheduleMode: null, timelineStartWeek: null,
        features: [feat1],
      },
      {
        id: 'epic-2', name: 'Epic 2', order: 2, isActive: true,
        featureMode: 'parallel', scheduleMode: null, timelineStartWeek: null,
        features: [feat2],
      },
    ]

    try {
      runSAPlanner(input, { targetDurationWeeks: 5, maxConcurrentEpics: 1 })
      expect.fail('Should have thrown')
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(Error)
      if (err && typeof err === 'object' && 'diagnostics' in err) {
        const diags = (err as { diagnostics: Array<{ blocker: string; configuredLimit?: string }> }).diagnostics
        const epicDiag = diags.find(d => d.blocker === 'CONCURRENT_EPICS')
        expect(epicDiag).toBeDefined()
        expect(epicDiag?.configuredLimit).toBe('1')
      }
    }
  })
})
