import { describe, expect, it } from 'vitest'
import {
  computeCapacityPlan,
  computeJointPlan,
  materializeEnvelopeToResourceTypes,
  type CapacityPlanConfig,
} from '../lib/capacity-planner.js'
import { getWeeklyCapacity } from '../lib/scheduler.js'
import { runCapacityPlanSchedule } from '../lib/planning-benchmark.js'
import {
  explicitRoleMaximum,
  makeResourceType,
  parallelSameRole,
  serialCriticalPath,
} from './planningBenchmarkFixtures.js'

const HOURS_PER_DAY = 8
const EPSILON = 1e-8

function makeConfig(targetDurationWeeks = 4): CapacityPlanConfig {
  return {
    targetDurationWeeks,
    periodWeeks: 4,
    maxDeltaPerPeriod: 1,
    minFloor: new Map(),
    dayRates: new Map(),
    maxParallelismPerFeature: 2,
  }
}

function effectiveHeadcount(
  result: { periods: Array<{ startWeek: number; endWeek: number; resources: Array<{ resourceTypeId: string; headcount: number }> }> },
  resourceTypeId: string,
  week: number,
): number {
  const period = result.periods.find(candidate => week >= candidate.startWeek && week < candidate.endWeek)
  return period?.resources.find(resource => resource.resourceTypeId === resourceTypeId)?.headcount ?? 0
}

function maxEffectiveHeadcount(
  result: Parameters<typeof effectiveHeadcount>[0],
  resourceTypeId: string,
  horizon: number,
): number {
  return Math.max(...Array.from({ length: horizon }, (_, week) =>
    effectiveHeadcount(result, resourceTypeId, week)))
}

describe('editable draft planning', () => {
  it('preserves a feasible manual feature pin shorter than one day', () => {
    const input = serialCriticalPath()
    for (const feature of input.epics[0].features) {
      for (const story of feature.userStories) {
        for (const task of story.tasks) task.hoursEffort = 1
      }
    }
    const result = computeJointPlan(input, {
      ...makeConfig(4),
      draft: {
        capacityEdits: [],
        manualFeatureEntries: [{ featureId: 'serial-f0', startWeek: 0.25, durationWeeks: 0.1 }],
        manualStoryEntries: [],
      },
    })
    expect(result.targetAchieved).toBe(true)
    expect(result.schedule.features.find(feature => feature.featureId === 'serial-f0'))
      .toMatchObject({ startWeek: 0.25, durationWeeks: 0.1 })
  })

  it('treats an unlocked edit as a seed that the optimiser may change', () => {
    const unlocked = computeJointPlan(parallelSameRole(), {
      ...makeConfig(2),
      maxCap: new Map([['rt-dev', 2]]),
      draft: {
        capacityEdits: [{ resourceTypeId: 'rt-dev', startWeek: 0, endWeek: 4, headcount: 0, locked: false }],
        manualFeatureEntries: [],
        manualStoryEntries: [],
      },
    })
    const locked = computeJointPlan(parallelSameRole(), {
      ...makeConfig(2),
      maxCap: new Map([['rt-dev', 2]]),
      draft: {
        capacityEdits: [{ resourceTypeId: 'rt-dev', startWeek: 0, endWeek: 4, headcount: 0, locked: true }],
        manualFeatureEntries: [],
        manualStoryEntries: [],
      },
    })

    expect(unlocked.draft.capacityEdits[0]).toMatchObject({ headcount: 0, locked: false })
    expect(unlocked.targetAchieved).toBe(true)
    expect(maxEffectiveHeadcount(unlocked, 'rt-dev', 4)).toBeGreaterThan(0)
    expect(locked.targetAchieved).toBe(false)
  })

  it('supplies an exact fractional lock every week and replays that effective capacity', () => {
    const input = parallelSameRole()
    const config = {
      ...makeConfig(4),
      draft: {
        capacityEdits: [{ resourceTypeId: 'rt-dev', startWeek: 0, endWeek: 4, headcount: 0.37, locked: true }],
        manualFeatureEntries: [],
        manualStoryEntries: [],
      },
    }
    const result = computeJointPlan(input, config)

    for (let week = 0; week < 4; week++) {
      expect(effectiveHeadcount(result, 'rt-dev', week)).toBeCloseTo(0.37, 8)
    }

    const replayInput = {
      ...input,
      resourceTypes: materializeEnvelopeToResourceTypes(input.resourceTypes, result.periods, config.periodWeeks),
    }
    const replayed = replayInput.resourceTypes.find(resourceType => resourceType.id === 'rt-dev')!
    for (let week = 0; week < 4; week++) {
      expect(getWeeklyCapacity(replayed, week, HOURS_PER_DAY) / HOURS_PER_DAY / 5).toBeCloseTo(0.37, 8)
    }
  })
  it('adapts a finite lock on an open-ended role profile without truncating its tail', () => {
    const input = parallelSameRole()
    input.resourceTypes = [makeResourceType('rt-dev', 'Developer', 1, 8, {
      roleSegments: [{ startWeek: 0, endWeek: Infinity, allocationPercent: 100 }],
    })]
    const result = computeJointPlan(input, {
      ...makeConfig(2),
      draft: {
        capacityEdits: [{ resourceTypeId: 'rt-dev', startWeek: 0, endWeek: 1, headcount: 0.37, locked: true }],
        manualFeatureEntries: [],
        manualStoryEntries: [],
      },
    })

    expect(Number.isFinite(result.deliveryWeeks)).toBe(true)
    expect(effectiveHeadcount(result, 'rt-dev', 0)).toBeCloseTo(0.37, 8)
    expect(effectiveHeadcount(result, 'rt-dev', 1)).toBeGreaterThan(0.37)
  })

  it('represents a locked no-demand role by effective weekly capacity, not period shape', () => {
    const input = parallelSameRole()
    input.resourceTypes = [...input.resourceTypes, makeResourceType('rt-idle', 'Idle', 0)]
    const result = computeJointPlan(input, {
      ...makeConfig(4),
      draft: {
        capacityEdits: [
          { resourceTypeId: 'rt-idle', startWeek: 12, endWeek: 16, headcount: 0.37, locked: true },
          { resourceTypeId: 'rt-idle', startWeek: 16, endWeek: 20, headcount: 0, locked: true },
        ],
        manualFeatureEntries: [],
        manualStoryEntries: [],
      },
    })

    const weekly = Array.from({ length: 20 }, (_, week) => effectiveHeadcount(result, 'rt-idle', week))
    expect(weekly.slice(0, 12)).toEqual(new Array(12).fill(0))
    expect(weekly.slice(12, 16).every(value => Math.abs(value - 0.37) <= EPSILON)).toBe(true)
    expect(weekly.slice(16)).toEqual(new Array(4).fill(0))
    expect(weekly.reduce((sum, value) => sum + value, 0)).toBeCloseTo(1.48, 8)
  })

  it('removes unlocked no-demand staffing so optimisation can return to zero', () => {
    const input = parallelSameRole()
    input.resourceTypes = [
      ...input.resourceTypes,
      makeResourceType('rt-idle', 'Idle', 0),
    ]
    const unlocked = computeJointPlan(input, {
      ...makeConfig(4),
      draft: {
        capacityEdits: [{ resourceTypeId: 'rt-idle', startWeek: 12, endWeek: 16, headcount: 0.37, locked: false }],
        manualFeatureEntries: [],
        manualStoryEntries: [],
      },
    })

    expect(unlocked.draft.capacityEdits[0].locked).toBe(false)
    expect(unlocked.plannedResourceTypeIds).not.toContain('rt-idle')
    expect(maxEffectiveHeadcount(unlocked, 'rt-idle', 20)).toBe(0)
  })

  it('preserves pinned feature and story starts while retaining effort and dependencies', () => {
    const input = serialCriticalPath()
    const result = computeJointPlan(input, {
      ...makeConfig(8),
      draft: {
        capacityEdits: [],
        manualFeatureEntries: [{ featureId: 'serial-f0', startWeek: 3, durationWeeks: 2 }],
        manualStoryEntries: [{ storyId: 'serial-s0', startWeek: 3 }],
      },
    })

    const firstFeature = result.schedule.features.find(feature => feature.featureId === 'serial-f0')
    const firstStory = result.schedule.stories.find(story => story.storyId === 'serial-s0')
    const dependentFeature = result.schedule.features.find(feature => feature.featureId === 'serial-f1')
    const dependentStory = result.schedule.stories.find(story => story.storyId === 'serial-s1')
    expect(firstFeature).toMatchObject({ startWeek: 3, durationWeeks: 2 })
    expect(firstStory).toMatchObject({ startWeek: 3, durationWeeks: 2 })
    expect(dependentFeature?.startWeek).toBeGreaterThanOrEqual(5)
    expect(dependentStory?.startWeek).toBeGreaterThanOrEqual(dependentFeature?.startWeek ?? Infinity)
    expect(result.schedule.stories).toHaveLength(2)
  })

  it('retains an incompatible lock and diagnoses cap, profile-gap, and named-capacity conflicts', () => {
    const input = parallelSameRole()
    input.resourceTypes = [
      ...input.resourceTypes,
      makeResourceType('rt-idle', 'Idle', 0, 8, {
        roleSegments: [
          { startWeek: 0, endWeek: 1, allocationPercent: 100 },
          { startWeek: 3, endWeek: 4, allocationPercent: 100 },
        ],
        namedResources: [{
          id: 'named-idle',
          name: 'Named idle',
          startWeek: 1,
          endWeek: 1,
          allocationPct: 75,
          allocationMode: 'TIMELINE',
          allocationPercent: 75,
          allocationStartWeek: null,
          allocationEndWeek: null,
        }],
      }),
    ]
    const result = computeJointPlan(input, {
      ...makeConfig(4),
      maxCap: new Map([['rt-idle', 0.4]]),
      draft: {
        capacityEdits: [{ resourceTypeId: 'rt-idle', startWeek: 1, endWeek: 4, headcount: 0.5, locked: true }],
        manualFeatureEntries: [],
        manualStoryEntries: [],
      },
    })

    expect(effectiveHeadcount(result, 'rt-idle', 1)).toBeCloseTo(0.5, 8)
    const blockers = new Set((result.diagnostics ?? []).map(diagnostic => diagnostic.blocker))
    expect([...blockers]).toEqual(expect.arrayContaining(['ROLE_MAX_CAP', 'PROFILE_WINDOW', 'CONSTRAINT']))
    expect(result.targetAchieved).toBe(false)
  })

  it('replays the returned envelope into the same feature schedule', () => {
    const input = serialCriticalPath()
    const config = makeConfig(8)
    const result = computeJointPlan(input, config)
    const replay = runCapacityPlanSchedule({
      ...input,
      resourceTypes: materializeEnvelopeToResourceTypes(input.resourceTypes, result.periods, config.periodWeeks),
    }, config)

    expect(replay.totalDeliveryWeeks).toBeCloseTo(result.deliveryWeeks, 6)
    expect(replay.featureStartWeeks).toEqual(result.levellingResult.featureStartWeeks)
    for (const [resourceTypeId, demand] of replay.weeklyDemandByResourceType) {
      const resourceType = materializeEnvelopeToResourceTypes(input.resourceTypes, result.periods, config.periodWeeks)
        .find(candidate => candidate.id === resourceTypeId)!
      for (let week = 0; week < demand.length; week++) {
        expect(demand[week] ?? 0).toBeLessThanOrEqual(
          getWeeklyCapacity(resourceType, week, HOURS_PER_DAY) / HOURS_PER_DAY + EPSILON,
        )
      }
    }
  })

  it('distinguishes a finite missed target from an impossible locked profile', () => {
    const finiteMiss = explicitRoleMaximum()
    const finite = computeJointPlan(finiteMiss.input, {
      ...finiteMiss.config,
      targetDurationWeeks: 1,
    })
    expect(Number.isFinite(finite.deliveryWeeks)).toBe(true)
    expect(finite.deliveryWeeks).toBeGreaterThan(1)
    expect(finite.targetAchieved).toBe(false)
    expect(finite.diagnostics?.length).toBeGreaterThan(0)

    const impossibleInput = parallelSameRole()
    impossibleInput.resourceTypes = [makeResourceType('rt-dev', 'Developer', 1, 8, {
      roleSegments: [{ startWeek: 0, endWeek: 0, allocationPercent: 100 }],
    })]
    const impossible = computeJointPlan(impossibleInput, {
      ...makeConfig(4),
      draft: {
        capacityEdits: [{ resourceTypeId: 'rt-dev', startWeek: 4, endWeek: 8, headcount: 1, locked: true }],
        manualFeatureEntries: [],
        manualStoryEntries: [],
      },
    })
    expect(impossible.deliveryWeeks).toBe(Infinity)
    expect(impossible.targetAchieved).toBe(false)
    expect(impossible.diagnostics?.some(diagnostic => diagnostic.blocker === 'PROFILE_WINDOW')).toBe(true)
  })

  it('keeps no-draft post-target diagnostics on the single-shot planner result', () => {
    const scenario = explicitRoleMaximum()
    const result = computeCapacityPlan(scenario.input, {
      ...scenario.config,
      targetDurationWeeks: 1,
    })

    expect(result.deliveryWeeks).toBeGreaterThan(1)
    expect(result.diagnostics?.some(diagnostic => diagnostic.blocker === 'ROLE_MAX_CAP')).toBe(true)
  })
})
