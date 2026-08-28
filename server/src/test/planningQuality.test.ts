import { describe, expect, it } from 'vitest'
import { computeCapacityPlan } from '../lib/capacity-planner.js'
import {
  measurePlanningQuality,
  measureCapacityPlanQuality,
  totalConsumedEffortDays,
  totalExpectedEffortDays,
} from '../lib/planning-benchmark.js'
import { runSAPlanner } from '../lib/sa-planner.js'
import { runScheduler } from '../lib/scheduler.js'
import {
  epicDependencyViolation,
  implicitEpicDependencyViolation,
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
  it('reports total peak staffing as simultaneous demand across overlapping roles', () => {
    const { metrics } = evaluate(mixedProgramme(), 6)

    expect(metrics.peakStaffingFteByRole).toEqual({ 'rt-dev': 1, 'rt-qa': 1 })
    expect(metrics.peakStaffingFte).toBe(1.5)
    expect(metrics.peakStaffingFte).toBeGreaterThan(metrics.peakStaffingFteByRole['rt-dev'])
    expect(metrics.peakStaffingFte).toBeGreaterThan(metrics.peakStaffingFteByRole['rt-qa'])
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
    const metrics = measureCapacityPlanQuality(input, config.targetDurationWeeks, result)
    expect(repeatResult.periods).toEqual(result.periods)
    expect(repeatResult.deliveryWeeks).toBe(result.deliveryWeeks)
    const cappedRole = result.periods.flatMap(period => period.resources)
      .filter(resource => resource.resourceTypeId === 'rt-dev')

    expect(config.maxCap?.get('rt-dev')).toBe(1)
    expect(result.deliveryWeeks).toBeGreaterThan(config.targetDurationWeeks)
    expect(metrics.achievedDurationWeeks).toBe(result.deliveryWeeks)
    expect(metrics.effortHoursByRole).toEqual({ 'rt-dev': 160 })
    expect(Object.values(metrics.staffedCapacityHoursByRole).every(hours => hours > 0)).toBe(true)
    expect(metrics.peakStaffingFteByRole['rt-dev']).toBeLessThanOrEqual(1 + TOLERANCE)
    expect(metrics.peakStaffingFte).toBeLessThanOrEqual(1 + TOLERANCE)
    expect(metrics.capacityViolations).toEqual([])
    expect(metrics.dependencyViolations).toEqual([])
    expect(metrics.failureReason).toBeNull()
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
  it('reports violations in implicit sequential epic chaining', () => {
    const input = implicitEpicDependencyViolation()
    const output = runScheduler(input)
    const metrics = measurePlanningQuality(input, output, 2)

    expect(metrics.dependencyViolations).toContainEqual({
      featureId: 'implicit-dependency-dependent',
      dependsOnId: 'implicit-dependency-predecessor',
    })
  })
})

describe('Factory / Supply Chain representative benchmark', () => {
  function runCapacityPlan(input: ReturnType<typeof factorySupplyChainBenchmark>['input'], config: ReturnType<typeof factorySupplyChainBenchmark>['config']) {
    try {
      return { result: computeCapacityPlan(input, config), error: null }
    } catch (error) {
      return { result: null, error: error instanceof Error ? error.message : String(error) }
    }
  }

  it('reproduces the current failure mode on the sanitised Factory/Supply Chain fixture', () => {
    const benchmark = factorySupplyChainBenchmark()
    const { input, config, facts } = benchmark
    const failure = runCapacityPlan(input, config)
    const repeatFailure = runCapacityPlan(input, config)
    const metrics = measureCapacityPlanQuality(input, facts.targetDurationWeeks, failure.result, failure.error)

    expect(repeatFailure).toEqual(failure)
    expect(facts.epicCount).toBe(18)
    expect(facts.featureCount).toBe(222)
    expect(facts.totalEffortHours).toBe(16_989.8)
    expect(facts.effortHoursByRole).toEqual({ pc: 4_062.2, data: 10_024.4, cloud: 2_903.2 })
    expect(input.epics.reduce((sum, epic) => sum + epic.features.length, 0)).toBe(facts.featureCount)
    expect(input.resourceTypes).toHaveLength(facts.roleCount)
    expect(config.maxCap).toBeUndefined()
    expect(config.maxParallelismPerFeature).toBe(2)
    expect(config.maxConcurrentEpics).toBe(6)
    expect(failure.result).toBeNull()
    expect(failure.error).toContain('Fractional planner could not finish feature')
    expect(failure.error).toMatch(/within \d+ weeks$/)
    expect(metrics.achievedDurationWeeks).toBeNull()
    expect(metrics.failureReason).toBe(failure.error)
    expect(metrics.staffedCapacityHoursByRole).toEqual({})
    expect(metrics.peakStaffingFte).toBeNull()
    expect(metrics.utilisationPctByRole).toEqual({})

    const constrainedRole = input.resourceTypes.find(rt => rt.id === facts.constrainedRoleId)!
    expect(constrainedRole.count).toBe(6)
    expect(constrainedRole.roleSegments).toEqual([{
      startWeek: 0,
      endWeek: facts.constrainedProfileEndWeek,
      allocationPercent: 100,
    }])
  })

  it('captures a complete deterministic baseline for the profile-window control', () => {
    const benchmark = factorySupplyChainBenchmark()
    const controlInput = {
      ...benchmark.input,
      resourceTypes: benchmark.input.resourceTypes.map(resourceType => ({
        ...resourceType,
        roleSegments: undefined,
      })),
    }
    const first = runCapacityPlan(controlInput, benchmark.config)
    const second = runCapacityPlan(controlInput, benchmark.config)
    const metrics = measureCapacityPlanQuality(controlInput, benchmark.facts.targetDurationWeeks, first.result)
    const repeatMetrics = measureCapacityPlanQuality(controlInput, benchmark.facts.targetDurationWeeks, second.result)

    expect(first.error).toBeNull()
    expect(second).toEqual(first)
    expect(metrics.achievedDurationWeeks).toBe(53)
    expect(metrics).toEqual(repeatMetrics)
    expect(metrics.effortHoursByRole).toEqual({
      'factory-role-cloud': 2_903.2,
      'factory-role-data': 10_024.4,
      'factory-role-pc': 4_062.2,
    })
    expect(Object.values(metrics.staffedCapacityHoursByRole).every(hours => hours > 0)).toBe(true)
    expect(Object.values(metrics.staffedFteWeeksByRole).every(weeks => weeks > 0)).toBe(true)
    expect(metrics.peakStaffingFte).toBe(first.result?.peakHeadcount)
    expect(Object.values(metrics.peakStaffingFteByRole).every(peak => peak > 0)).toBe(true)
    expect(Object.values(metrics.utilisationPctByRole).every(value => value != null && value > 0 && value <= 100)).toBe(true)
    expect(metrics.capacityViolations).toEqual([])
    expect(metrics.dependencyViolations).toEqual([])
    expect(Object.values(metrics.rampShapeByRole).every(shape => shape.activePeriods > 0 && shape.peakDemandFte > 0)).toBe(true)
    expect(metrics.failureReason).toBeNull()
    expect(metrics.deterministicFingerprint).toBeTruthy()
  })
})
