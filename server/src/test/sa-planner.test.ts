import { describe, expect, it } from 'vitest'
import { runSAPlanner, analyzeTargetMiss, type SAPlannerConfig } from '../lib/sa-planner.js'
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
  it('planner can use capacity above count=1 when no maxCap is set', () => {
    // count=1, no maxCap, target requires capacity above 1 FTE
    // maxParallelismPerFeature=4 allows up to 4 people per feature
    // At count=1: 300 days / 5 days/week = 60 weeks
    // At count=4: 300 days / 20 days/week = 15 weeks
    const input = makeInput()
    input.resourceTypes = [{
      id: 'rt-1', name: 'Dev', count: 1, hoursPerDay: 8,
      namedResources: [],
    }]
    const feature = makeFeature('feat-1', 1, 300)
    input.epics = [{
      id: 'epic-1', name: 'Epic 1', order: 1, isActive: true,
      featureMode: 'parallel', scheduleMode: null, timelineStartWeek: null,
      features: [feature],
    }]

    // At count=1 alone: 300 days / 5 days/week = 60 weeks
    const resultAt1 = runSAPlanner(input, { targetDurationWeeks: 60, maxParallelismPerFeature: 4 })
    const weeksAt1 = resultAt1.totalDeliveryWeeks

    // When route boosts count to 4, capacity = 4×5=20 days/week → 15 weeks
    input.resourceTypes[0].count = 4
    const resultAt4 = runSAPlanner(input, { targetDurationWeeks: 60, maxParallelismPerFeature: 4 })
    const weeksAt4 = resultAt4.totalDeliveryWeeks

    // Must complete faster with higher count — proving capacity growth works
    expect(weeksAt4).toBeLessThan(weeksAt1)
    // At count=4 with parallelism=4: 300/20 = 15 weeks
    expect(weeksAt4).toBeLessThanOrEqual(15)
    // At count=1: 300/5 = 60 weeks
    expect(weeksAt1).toBeGreaterThanOrEqual(55)
  })

  it('explicit maxCap prevents growth beyond cap', () => {
    const input = makeInput()
    input.resourceTypes = [{
      id: 'rt-1', name: 'Dev', count: 5, hoursPerDay: 8,
      namedResources: [],
    }]
    const feature = makeFeature('feat-1', 1, 200)
    input.epics = [{
      id: 'epic-1', name: 'Epic 1', order: 1, isActive: true,
      featureMode: 'parallel', scheduleMode: null, timelineStartWeek: null,
      features: [feature],
    }]

    // Without cap: count=5 → 200/(5×5)=8 weeks
    const uncapped = runSAPlanner(input, { targetDurationWeeks: 52 })
    // With cap=1: ratio=0.2, capacity=5 days/week → 200/5=40 weeks
    const capped = runSAPlanner(input, {
      targetDurationWeeks: 52,
      maxCap: new Map([['rt-1', 1]]),
    })

    expect(capped.totalDeliveryWeeks).toBeGreaterThan(uncapped.totalDeliveryWeeks)
    expect(capped.totalDeliveryWeeks).toBeGreaterThanOrEqual(40)
  })

  it('blank maxCap does not erase profile windows', () => {
    const input = makeInput()
    input.resourceTypes = [{
      id: 'rt-1', name: 'Data', count: 1, hoursPerDay: 8,
      namedResources: [],
      roleSegments: [
        { startWeek: 0, endWeek: 5, allocationPercent: 100 },
      ],
    }]
    const feature = makeFeature('feat-1', 1, 100)
    input.epics = [{
      id: 'epic-1', name: 'Epic 1', order: 1, isActive: true,
      featureMode: 'parallel', scheduleMode: null, timelineStartWeek: null,
      features: [feature],
    }]

    // Profile window constrains even without maxCap
    expect(() => {
      runSAPlanner(input, { targetDurationWeeks: 52 })
    }).toThrow('Fractional planner could not finish feature')
  })
})

describe('#480 post-completion diagnostics (analyzeTargetMiss)', () => {
  function makeConfig(overrides: Partial<SAPlannerConfig> = {}): SAPlannerConfig {
    return {
      targetDurationWeeks: 10,
      maxParallelismPerFeature: 2,
      ...overrides,
    }
  }

  it('ROLE_MAX_CAP diagnostic when explicit cap materially limits capacity', () => {
    const input = makeInput()
    input.resourceTypes = [{
      id: 'rt-1', name: 'Dev', count: 5, hoursPerDay: 8,
      namedResources: [],
    }]
    const feature = makeFeature('feat-1', 1, 2000)
    input.epics = [{
      id: 'epic-1', name: 'Epic 1', order: 1, isActive: true,
      featureMode: 'parallel', scheduleMode: null, timelineStartWeek: null,
      features: [feature],
    }]

    const config = makeConfig({ maxCap: new Map([['rt-1', 1]]) })
    const result = runSAPlanner(input, config)

    // Planner completes but delivery far exceeds target
    expect(result.totalDeliveryWeeks).toBeGreaterThan(config.targetDurationWeeks)

    const diagnostics = analyzeTargetMiss(result, input, config)
    expect(diagnostics.length).toBeGreaterThan(0)

    const roleCapDiag = diagnostics.find(d => d.blocker === 'ROLE_MAX_CAP')
    expect(roleCapDiag).toBeDefined()
    expect(roleCapDiag?.resourceTypeName).toBe('Dev')
    expect(roleCapDiag?.configuredLimit).toBe('1')
    expect(roleCapDiag?.explanation).toContain('capped at 1')
  })

  it('PROFILE_WINDOW diagnostic for thrown hard failure (capacity zero beyond window)', () => {
    // 3-week window, 100 days demand → planner cannot finish → throws
    // Diagnostics from SAPlannerInfeasibleError identify the profile window
    const input = makeInput()
    input.resourceTypes = [{
      id: 'rt-1', name: 'Data', count: 1, hoursPerDay: 8,
      namedResources: [],
      roleSegments: [
        { startWeek: 0, endWeek: 2, allocationPercent: 100 },
      ],
    }]
    const feature = makeFeature('feat-1', 1, 100)
    input.epics = [{
      id: 'epic-1', name: 'Epic 1', order: 1, isActive: true,
      featureMode: 'parallel', scheduleMode: null, timelineStartWeek: null,
      features: [feature],
    }]

    try {
      runSAPlanner(input, makeConfig())
      expect.fail('Should have thrown SAPlannerInfeasibleError')
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(Error)
      const msg = err instanceof Error ? err.message : ''
      expect(msg).toContain('Fractional planner could not finish feature')
      // SAPlannerInfeasibleError carries diagnostics
      expect(err).toHaveProperty('diagnostics')
      const diags = (err as { diagnostics: Array<{ blocker: string; resourceTypeName?: string }> }).diagnostics
      expect(Array.isArray(diags)).toBe(true)
      expect(diags.length).toBeGreaterThan(0)
      const windowDiag = diags.find(d => d.blocker === 'PROFILE_WINDOW')
      expect(windowDiag).toBeDefined()
      expect(windowDiag?.resourceTypeName).toBe('Data')
    }
  })

  it('no false PROFILE_WINDOW when demand fits within window', () => {
    // 20-week window (W0-W19), 40 days demand at 5 days/week = 8 weeks
    // All demand fits within window, target=5 weeks is missed but
    // not due to profile window — just insufficient capacity
    const input = makeInput()
    input.resourceTypes = [{
      id: 'rt-1', name: 'Data', count: 1, hoursPerDay: 8,
      namedResources: [],
      roleSegments: [
        { startWeek: 0, endWeek: 19, allocationPercent: 100 },
      ],
    }]
    const feature = makeFeature('feat-1', 1, 40)
    input.epics = [{
      id: 'epic-1', name: 'Epic 1', order: 1, isActive: true,
      featureMode: 'parallel', scheduleMode: null, timelineStartWeek: null,
      features: [feature],
    }]

    const config = makeConfig({ targetDurationWeeks: 5 })
    const result = runSAPlanner(input, config)

    expect(result.totalDeliveryWeeks).toBeGreaterThan(config.targetDurationWeeks)

    const diagnostics = analyzeTargetMiss(result, input, config)
    // All demand is within the window — no PROFILE_WINDOW diagnostic
    const windowDiags = diagnostics.filter(d => d.blocker === 'PROFILE_WINDOW')
    expect(windowDiags).toHaveLength(0)
  })

  it('DEPENDENCY_PATH diagnostic when feature starts after target', () => {
    const input = makeInput()
    input.resourceTypes = [{
      id: 'rt-1', name: 'Dev', count: 1, hoursPerDay: 8,
      namedResources: [],
    }]
    // feat-1 (100 days) → feat-2 (100 days) serial chain
    const feat1 = makeFeature('feat-1', 1, 100)
    const feat2 = makeFeature('feat-2', 2, 100, 'feat-1')
    input.epics = [{
      id: 'epic-1', name: 'Epic 1', order: 1, isActive: true,
      featureMode: 'parallel', scheduleMode: null, timelineStartWeek: null,
      features: [feat1, feat2],
    }]

    // At count=1: feat-1=20 weeks, feat-2 starts at 20 → 40 weeks total
    const config = makeConfig({ targetDurationWeeks: 10 })
    const result = runSAPlanner(input, config)

    expect(result.totalDeliveryWeeks).toBeGreaterThan(config.targetDurationWeeks)

    const diagnostics = analyzeTargetMiss(result, input, config)
    expect(diagnostics.length).toBeGreaterThan(0)

    const depDiag = diagnostics.find(d => d.blocker === 'DEPENDENCY_PATH')
    expect(depDiag).toBeDefined()
    expect(depDiag?.featureId).toBe('feat-2')
    expect(depDiag?.explanation).toContain('predecessor')

    // Should NOT claim role capacity is the problem
    const roleCapDiags = diagnostics.filter(d => d.blocker === 'ROLE_MAX_CAP')
    expect(roleCapDiags).toHaveLength(0)
  })

  it('CONCURRENT_EPICS diagnostic when configured limit constrains', () => {
    const input = makeInput()
    input.resourceTypes = [{
      id: 'rt-1', name: 'Dev', count: 10, hoursPerDay: 8,
      namedResources: [],
    }]
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

    // With maxConcurrentEpics=1: epics must run serially.
    // maxParallelismPerFeature=200 ensures per-feature cap does not interfere.
    const config = makeConfig({ targetDurationWeeks: 5, maxConcurrentEpics: 1, maxParallelismPerFeature: 200 })
    const result = runSAPlanner(input, config)

    expect(result.totalDeliveryWeeks).toBeGreaterThan(config.targetDurationWeeks)

    const diagnostics = analyzeTargetMiss(result, input, config)
    expect(diagnostics.length).toBeGreaterThan(0)

    // STRICT: only CONCURRENT_EPICS — no dependency or parallelism false positives
    const blockerTypes = new Set(diagnostics.map(d => d.blocker))
    expect(blockerTypes.has('CONCURRENT_EPICS')).toBe(true)
    expect(blockerTypes.has('DEPENDENCY_PATH')).toBe(false)
    expect(blockerTypes.has('FEATURE_PARALLELISM')).toBe(false)
    expect(blockerTypes.has('ROLE_MAX_CAP')).toBe(false)

    const epicDiag = diagnostics.find(d => d.blocker === 'CONCURRENT_EPICS')
    expect(epicDiag).toBeDefined()
    expect(epicDiag?.configuredLimit).toBe('1')
  })

  it('FEATURE_PARALLELISM diagnostic when per-feature cap limits throughput', () => {
    // Single feature, sufficient staffing (count=10), no dependencies,
    // no concurrent-epic limit — only maxParallelismPerFeature=1 restricts.
    // At maxParallelism=1: feature uses 1×8=8h/week = 1 day/week
    // 100 days / 1 day/week = 100 weeks. Target=10 weeks → target missed.
    const input = makeInput()
    input.resourceTypes = [{
      id: 'rt-1', name: 'Dev', count: 10, hoursPerDay: 8,
      namedResources: [],
    }]
    const feature = makeFeature('feat-1', 1, 100)
    input.epics = [{
      id: 'epic-1', name: 'Epic 1', order: 1, isActive: true,
      featureMode: 'parallel', scheduleMode: null, timelineStartWeek: null,
      features: [feature],
    }]

    const config = makeConfig({ targetDurationWeeks: 10, maxParallelismPerFeature: 1 })
    const result = runSAPlanner(input, config)

    expect(result.totalDeliveryWeeks).toBeGreaterThan(config.targetDurationWeeks)

    const diagnostics = analyzeTargetMiss(result, input, config)
    expect(diagnostics.length).toBeGreaterThan(0)

    // STRICT: only FEATURE_PARALLELISM — staffing is sufficient, no deps, no epic limit
    const blockerTypes = new Set(diagnostics.map(d => d.blocker))
    expect(blockerTypes.has('FEATURE_PARALLELISM')).toBe(true)
    expect(blockerTypes.has('DEPENDENCY_PATH')).toBe(false)
    expect(blockerTypes.has('CONCURRENT_EPICS')).toBe(false)
    expect(blockerTypes.has('ROLE_MAX_CAP')).toBe(false)

    const parallelDiag = diagnostics.find(d => d.blocker === 'FEATURE_PARALLELISM')
    expect(parallelDiag).toBeDefined()
    expect(parallelDiag?.configuredLimit).toBe('1')
    expect(parallelDiag?.featureId).toBe('feat-1')
  })

  it('returns empty diagnostics when target is met', () => {
    const input = makeInput()
    input.resourceTypes = [{
      id: 'rt-1', name: 'Dev', count: 10, hoursPerDay: 8,
      namedResources: [],
    }]
    const feature = makeFeature('feat-1', 1, 50)
    input.epics = [{
      id: 'epic-1', name: 'Epic 1', order: 1, isActive: true,
      featureMode: 'parallel', scheduleMode: null, timelineStartWeek: null,
      features: [feature],
    }]

    const config = makeConfig({ targetDurationWeeks: 52 })
    const result = runSAPlanner(input, config)

    // Target met — no diagnostics
    expect(result.totalDeliveryWeeks).toBeLessThanOrEqual(config.targetDurationWeeks)
    const diagnostics = analyzeTargetMiss(result, input, config)
    expect(diagnostics).toHaveLength(0)
  })
})

describe('#480 Starting Team Finder hand-off (route-level count boost)', () => {
  it('route boosts rt.count when maxCap > canonical count', () => {
    // This tests the route-level transformation: when maxCap=3 and count=1,
    // the route should boost count to 3 before calling the planner.
    // The SA planner itself sees the boosted count as phantom-slot capacity.
    const input = makeInput()
    input.resourceTypes = [{
      id: 'rt-1', name: 'Dev', count: 3, hoursPerDay: 8, // pre-boosted (simulates route behavior)
      namedResources: [],
    }]
    const feature = makeFeature('feat-1', 1, 60)
    input.epics = [{
      id: 'epic-1', name: 'Epic 1', order: 1, isActive: true,
      featureMode: 'parallel', scheduleMode: null, timelineStartWeek: null,
      features: [feature],
    }]

    const result = runSAPlanner(input, { targetDurationWeeks: 12 })

    // With count=3: 3×5=15 days/week → 60/15=4 weeks
    expect(result.totalDeliveryWeeks).toBeLessThanOrEqual(8)
    expect(result.featureStartWeeks.get('feat-1')).toBeDefined()
  })

  it('dynamic bound allows capacity above 12 when demand justifies it', () => {
    // count=1, no maxCap, 1000 days demand, target=10 weeks
    // Minimum FTEs needed: 1000/(10×5) = 20 FTEs — well above old ceiling of 12
    // The route derives planning bound from demand, not a fixed sentinel.
    // maxParallelismPerFeature=20 allows using the expanded capacity.
    const input = makeInput()
    input.resourceTypes = [{
      id: 'rt-1', name: 'Dev', count: 1, hoursPerDay: 8,
      namedResources: [],
    }]
    const feature = makeFeature('feat-1', 1, 1000)
    input.epics = [{
      id: 'epic-1', name: 'Epic 1', order: 1, isActive: true,
      featureMode: 'parallel', scheduleMode: null, timelineStartWeek: null,
      features: [feature],
    }]

    // Simulate route dynamic bound: totalDemand=1000, target=10, daysPerWeek=5
    // minFtes = ceil(1000/(10*5)) = 20, planningBound = max(1, ceil(20*2)) = 40
    input.resourceTypes[0].count = 40
    const result = runSAPlanner(input, { targetDurationWeeks: 10, maxParallelismPerFeature: 20 })

    // At count=40 with parallelism=20: 20×8=160h/week = 20 days/week → 1000/20=50 weeks
    // But with parallelism=20, only 20 people per feature → 1000/(20×5)=10 weeks
    expect(result.totalDeliveryWeeks).toBeLessThanOrEqual(10)
    // Proves capacity above 12 is actually used
    expect(result.totalDeliveryWeeks).toBeLessThan(20)
  })
})
