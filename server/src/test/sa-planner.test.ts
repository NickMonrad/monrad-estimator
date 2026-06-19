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
