import { describe, expect, it } from 'vitest'
import { computeCapacityPlan } from '../lib/capacity-planner.js'
import {
  measurePlanningQuality,
  totalConsumedEffortDays,
  totalExpectedEffortDays,
} from '../lib/planning-benchmark.js'
import { runSAPlanner } from '../lib/sa-planner.js'
import { runScheduler } from '../lib/scheduler.js'
import {
  epicDependencyViolation,
  explicitRoleMaximum,
  factorySupplyChainBenchmark,
  manualCapacityAndScheduleLock,
  mixedProgramme,
  parallelSameRole,
  roleHandoff,
  serialCriticalPath,
  sparseSpecialist,
} from './planningBenchmarkFixtures.js'

const TOLERANCE = 1e-6

function evaluate(input: ReturnType<typeof serialCriticalPath>, targetDurationWeeks: number) {
  const output = runScheduler(input)
  const metrics = measurePlanningQuality(input, output, targetDurationWeeks)
  const repeatMetrics = measurePlanningQuality(input, runScheduler(input), targetDurationWeeks)
  expect(repeatMetrics).toEqual(metrics)
  expect(totalConsumedEffortDays(output)).toBeCloseTo(totalExpectedEffortDays(input), 6)
  expect(metrics.capacityViolations).toEqual([])
  expect(metrics.dependencyViolations).toEqual([])
  return { output, metrics }
}

describe('deterministic planning-quality scenarios', () => {
  it('serial critical path is unchanged by extra capacity when task duration is irreducible', () => {
    const onePerson = serialCriticalPath()
    const fourPeople = serialCriticalPath()
    fourPeople.resourceTypes[0].count = 4

    const onePersonResult = evaluate(onePerson, 4)
    const fourPeopleResult = evaluate(fourPeople, 4)

    expect(onePersonResult.metrics.achievedDurationWeeks).toBeCloseTo(4, 6)
    expect(fourPeopleResult.metrics.achievedDurationWeeks).toBeCloseTo(4, 6)
    expect(onePersonResult.metrics.effortByRole['rt-dev']).toBeCloseTo(10, 6)
    expect(fourPeopleResult.metrics.effortByRole['rt-dev']).toBeCloseTo(10, 6)
  })

  it('parallel same-role demand improves delivery when capacity is increased', () => {
    const onePerson = parallelSameRole()
    const twoPeople = parallelSameRole()
    twoPeople.resourceTypes[0].count = 2

    const onePersonResult = evaluate(onePerson, 4)
    const twoPeopleResult = evaluate(twoPeople, 2)

    expect(onePersonResult.metrics.achievedDurationWeeks).toBeCloseTo(4, 6)
    expect(twoPeopleResult.metrics.achievedDurationWeeks).toBeCloseTo(2, 6)
    expect(twoPeopleResult.metrics.achievedDurationWeeks).toBeLessThan(onePersonResult.metrics.achievedDurationWeeks)
    expect(twoPeopleResult.metrics.effortByRole['rt-dev']).toBeCloseTo(20, 6)
  })

  it('records role hand-off demand as distinct ramp-up and ramp-down phases', () => {
    const { output, metrics } = evaluate(roleHandoff(), 2)
    const devShape = metrics.rampShapeByRole['rt-dev']
    const qaShape = metrics.rampShapeByRole['rt-qa']

    expect(output.featureSchedule[0].durationWeeks).toBeCloseTo(2, 6)
    expect(metrics.demandWeeksByRole['rt-dev']).toEqual([0])
    expect(metrics.demandWeeksByRole['rt-qa']).toEqual([1])
    expect(devShape).toMatchObject({ firstDemandWeek: 0, lastDemandWeek: 0, activeWeeks: 1 })
    expect(qaShape).toMatchObject({ firstDemandWeek: 1, lastDemandWeek: 1, activeWeeks: 1 })
    expect(devShape.startTransitions).toBe(1)
    expect(devShape.endTransitions).toBe(1)
  })

  it('preserves sparse specialist effort as fractional demand', () => {
    const { metrics } = evaluate(sparseSpecialist(), 4)
    const specialist = metrics.rampShapeByRole['rt-specialist']

    expect(metrics.effortByRole['rt-specialist']).toBeCloseTo(1, 6)
    expect(specialist.peakDemandFte).toBeLessThanOrEqual(0.1)
    expect(metrics.utilisationPctByRole['rt-specialist']).toBeGreaterThan(0)
    expect(metrics.utilisationPctByRole['rt-specialist']).toBeLessThan(10)
  })

  it('records an explicit role maximum as the concrete reason a target is not reached', () => {
    const { input, config } = explicitRoleMaximum()
    const result = computeCapacityPlan(input, config)
    const repeatResult = computeCapacityPlan(input, config)
    expect(repeatResult.periods).toEqual(result.periods)
    expect(repeatResult.deliveryWeeks).toBe(result.deliveryWeeks)
    const cappedRole = result.periods.flatMap(period => period.resources)
      .filter(resource => resource.resourceTypeId === 'rt-dev')

    expect(config.maxCap?.get('rt-dev')).toBe(1)
    expect(result.deliveryWeeks).toBeGreaterThan(config.targetDurationWeeks)
    expect(cappedRole.every(resource => resource.headcount <= 1 + TOLERANCE)).toBe(true)

    const uncapped = runSAPlanner({
      ...input,
      resourceTypes: input.resourceTypes.map(resourceType => ({ ...resourceType, count: 4 })),
    }, {
      targetDurationWeeks: config.targetDurationWeeks,
      maxParallelismPerFeature: config.maxParallelismPerFeature,
    })
    expect(uncapped.totalDeliveryWeeks).toBeLessThan(result.deliveryWeeks)
  })

  it('respects a manual capacity and schedule lock before scheduling dependent work', () => {
    const { output, metrics } = evaluate(manualCapacityAndScheduleLock(), 6)
    const locked = output.featureSchedule.find(entry => entry.featureId === 'locked-f')!
    const following = output.featureSchedule.find(entry => entry.featureId === 'following-f')!

    expect(locked).toMatchObject({ startWeek: 3, durationWeeks: 2, isManual: true })
    expect(following.startWeek).toBeGreaterThanOrEqual(5 - TOLERANCE)
    expect(metrics.demandWeeksByRole['rt-dev']).toEqual([3, 4, 5])
    expect(metrics.effortByRole['rt-dev']).toBeCloseTo(15, 6)
  })

  it('proves effort and dependency invariants for a mixed sequential/parallel programme', () => {
    const { metrics } = evaluate(mixedProgramme(), 6)
    expect(metrics.achievedDurationWeeks).toBeGreaterThan(0)
    expect(metrics.peakStaffingFte).toBeGreaterThan(0)
    expect(Object.keys(metrics.staffedFteWeeksByRole)).toEqual(['rt-dev', 'rt-qa'])
  })

  it('is repeatable for identical inputs, including weekly demand and ramp shape', () => {
    const input = mixedProgramme()
    const first = measurePlanningQuality(input, runScheduler(input), 6)
    const second = measurePlanningQuality(input, runScheduler(input), 6)

    expect(second.deterministicFingerprint).toBe(first.deterministicFingerprint)
    expect(second).toEqual(first)
  })

  it('reports violations in explicit epic dependencies', () => {
    const input = epicDependencyViolation()
    const output = runScheduler(input)
    const metrics = measurePlanningQuality(input, output, 2)

    expect(metrics.dependencyViolations).toContainEqual({
      featureId: 'dependency-dependent',
      dependsOnId: 'dependency-predecessor',
    })
  })
})

describe('Factory / Supply Chain representative benchmark', () => {
  it('reproduces the current failure mode on the sanitised Factory/Supply Chain proxy', () => {
    const benchmark = factorySupplyChainBenchmark()
    const { input, config, facts } = benchmark
    const runFailure = () => {
      try {
        computeCapacityPlan(input, config)
        return null
      } catch (error) {
        return error instanceof Error ? error.message : String(error)
      }
    }
    const failure = runFailure()
    expect(runFailure()).toBe(failure)
    expect(facts.epicCount).toBe(23)
    expect(facts.featureCount).toBe(248)
    const totalEffortHours = input.epics
      .flatMap(epic => epic.features)
      .flatMap(feature => feature.userStories)
      .flatMap(story => story.tasks)
      .reduce((sum, task) => sum + task.hoursEffort, 0)
    expect(totalEffortHours).toBe(facts.sanitizedEffortHours)
    expect(input.epics.reduce((sum, epic) => sum + epic.features.length, 0)).toBe(facts.featureCount)
    expect(input.resourceTypes).toHaveLength(facts.roleCount)
    expect(config.maxCap).toBeUndefined()
    expect(config.maxParallelismPerFeature).toBe(2)
    expect(config.maxConcurrentEpics).toBe(6)
    expect(failure).toContain('Fractional planner could not finish feature')
    expect(failure).toMatch(/within \d+ weeks$/)

    const constrainedRole = input.resourceTypes.find(rt => rt.id === facts.constrainedRoleId)!
    expect(constrainedRole.count).toBe(3)
    expect(constrainedRole.roleSegments).toEqual([{
      startWeek: 0,
      endWeek: facts.constrainedProfileEndWeek,
      allocationPercent: 100,
    }])
  })

  it('succeeds on the same topology when the profile window is removed', () => {
    const benchmark = factorySupplyChainBenchmark()
    const unconstrainedInput = {
      ...benchmark.input,
      resourceTypes: benchmark.input.resourceTypes.map(resourceType => ({
        ...resourceType,
        roleSegments: undefined,
      })),
    }
    const result = computeCapacityPlan(unconstrainedInput, benchmark.config)
    const repeatResult = computeCapacityPlan(unconstrainedInput, benchmark.config)
    expect(repeatResult.periods).toEqual(result.periods)
    expect(repeatResult.deliveryWeeks).toBe(result.deliveryWeeks)

    expect(result.deliveryWeeks).toBeGreaterThan(0)
    expect(result.levellingResult.totalDeliveryWeeks).toBe(result.deliveryWeeks)
    expect(result.plannedResourceTypeIds).toHaveLength(benchmark.facts.roleCount)
  })
})
