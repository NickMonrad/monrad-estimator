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
})
