import { describe, expect, it } from 'vitest'
import { computeCapacityPlan } from '../lib/capacity-planner.js'
import {
  capacityDependencyViolations,
  measurePlanningQuality,
  measureCapacityPlanQuality,
  runCapacityPlanSchedule,
  totalConsumedEffortDays,
  totalExpectedEffortDays,
} from '../lib/planning-benchmark.js'
import { runSAPlanner, type SAPlannerResult } from '../lib/sa-planner.js'
import { runScheduler } from '../lib/scheduler.js'
import {
  epicDependencyViolation,
  implicitEpicDependencyViolation,
  explicitRoleMaximum,
  syntheticLargeProgrammeBenchmark,
  manualCapacityAndScheduleLock,
  mixedProgramme,
  parallelSameRole,
  roleHandoff,
  serialCriticalPath,
  sparseSpecialist,
} from './planningBenchmarkFixtures.js'
import type { SyntheticLargeProgrammeBenchmark } from './planningBenchmarkFixtures.js'

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
    const schedule = runCapacityPlanSchedule(input, config)
    const repeatResult = computeCapacityPlan(input, config)
    const metrics = measureCapacityPlanQuality(input, config.targetDurationWeeks, result, schedule)
    expect(repeatResult.periods).toEqual(result.periods)
    expect(repeatResult.deliveryWeeks).toBe(result.deliveryWeeks)
    expect(schedule.featureStartWeeks).toEqual(result.levellingResult.featureStartWeeks)
    const cappedRole = result.periods.flatMap(period => period.resources)
      .filter(resource => resource.resourceTypeId === 'rt-dev')

    expect(config.maxCap?.get('rt-dev')).toBe(1)
    expect(result.deliveryWeeks).toBeGreaterThan(config.targetDurationWeeks)
    expect(metrics.achievedDurationWeeks).toBe(result.deliveryWeeks)
    expect(metrics.effortHoursByRole).toEqual({ 'rt-dev': 160 })
    expect(metrics.scheduledEffortHoursByRole).toEqual(metrics.effortHoursByRole)
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

  it('reports a dependent allocation that starts before its predecessor completes', () => {
    const schedule: Pick<SAPlannerResult, 'weeklyAllocationsByFeature'> = {
      weeklyAllocationsByFeature: new Map([
        ['mixed-foundation', new Map([
          [0, new Map([['rt-dev', 5]])],
          [1, new Map([['rt-dev', 5]])],
        ])],
        ['mixed-parallel-a', new Map([[1, new Map([['rt-dev', 5]])]])],
      ]),
    }

    expect(capacityDependencyViolations(mixedProgramme(), schedule)).toContainEqual({
      featureId: 'mixed-parallel-a',
      dependsOnId: 'mixed-foundation',
    })
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
describe('deterministic synthetic large-programme benchmark', () => {
  function runCapacityPlan(
    input: SyntheticLargeProgrammeBenchmark['input'],
    config: SyntheticLargeProgrammeBenchmark['config'],
  ) {
    try {
      return { result: computeCapacityPlan(input, config), error: null }
    } catch (error) {
      return { result: null, error: error instanceof Error ? error.message : String(error) }
    }
  }

  it('reports the constrained synthetic benchmark with actionable diagnostics', () => {
    const benchmark = syntheticLargeProgrammeBenchmark()
    const { input, config, facts } = benchmark
    const failure = runCapacityPlan(input, config)
    const repeatFailure = runCapacityPlan(input, config)
    const metrics = measureCapacityPlanQuality(input, facts.targetDurationWeeks, failure.result, null, failure.error)
    const expectedEffortHoursByRole = Object.fromEntries(input.resourceTypes.map(resourceType => [
      resourceType.id,
      input.epics
        .flatMap(epic => epic.features)
        .flatMap(feature => feature.userStories)
        .flatMap(story => story.tasks)
        .filter(task => task.resourceTypeId === resourceType.id)
        .reduce((total, task) => total + task.hoursEffort, 0),
    ]))
    const expectedTaskCountByRole = Object.fromEntries(input.resourceTypes.map(resourceType => [
      resourceType.id,
      input.epics
        .flatMap(epic => epic.features)
        .flatMap(feature => feature.userStories)
        .flatMap(story => story.tasks)
        .filter(task => task.resourceTypeId === resourceType.id)
        .length,
    ]))

    expect(repeatFailure).toEqual(failure)
    expect(facts.epicCount).toBe(14)
    expect(facts.featureCount).toBe(210)
    expect(facts.roleCount).toBe(3)
    expect(facts.totalEffortHours).toBe(
      Object.values(expectedEffortHoursByRole).reduce((total, effort) => total + effort, 0),
    )
    expect(facts.effortHoursByRole).toEqual(expectedEffortHoursByRole)
    expect(facts.taskCountByRole).toEqual(expectedTaskCountByRole)
    expect(input.epics.reduce((sum, epic) => sum + epic.features.length, 0)).toBe(facts.featureCount)
    expect(input.resourceTypes).toHaveLength(facts.roleCount)
    expect(new Set(input.epics.map(epic => epic.featureMode))).toEqual(new Set(['parallel', 'sequential']))
    expect(input.epicDeps).toHaveLength(3)
    expect(input.epics.flatMap(epic => epic.features).flatMap(feature => feature.dependencies).length).toBeGreaterThan(100)
    expect(config.maxCap).toBeUndefined()
    expect(config.maxParallelismPerFeature).toBe(facts.maxParallelismPerFeature)
    expect(config.maxConcurrentEpics).toBe(facts.maxConcurrentEpics)
    expect(failure.result).toBeNull()
    expect(failure.error).toContain('Fractional planner could not finish feature')
    expect(failure.error).toMatch(/within \d+ weeks$/)
    expect(metrics.achievedDurationWeeks).toBeNull()
    expect(metrics.failureReason).toBe(failure.error)
    expect(metrics.staffedCapacityHoursByRole).toEqual({})
    expect(metrics.peakStaffingFte).toBeNull()
    expect(metrics.utilisationPctByRole).toEqual({})

    const constrainedRole = input.resourceTypes.find(rt => rt.id === facts.constrainedRoleId)!
    expect(constrainedRole.count).toBe(facts.roleCounts.data)
    expect(constrainedRole.roleSegments).toEqual([{
      startWeek: 0,
      endWeek: facts.constrainedProfileEndWeek,
      allocationPercent: facts.constrainedAllocationPercent,
    }])
  })

  it('captures a repeatable control baseline without customer-derived values', () => {
    const benchmark = syntheticLargeProgrammeBenchmark()
    const controlInput = {
      ...benchmark.input,
      resourceTypes: benchmark.input.resourceTypes.map(resourceType => ({
        ...resourceType,
        roleSegments: undefined,
      })),
    }
    const first = runCapacityPlan(controlInput, benchmark.config)
    const second = runCapacityPlan(controlInput, benchmark.config)
    const firstSchedule = runCapacityPlanSchedule(controlInput, benchmark.config)
    const secondSchedule = runCapacityPlanSchedule(controlInput, benchmark.config)
    const metrics = measureCapacityPlanQuality(controlInput, benchmark.facts.targetDurationWeeks, first.result, firstSchedule)
    const repeatMetrics = measureCapacityPlanQuality(controlInput, benchmark.facts.targetDurationWeeks, second.result, secondSchedule)

    expect(first.error).toBeNull()
    expect(second).toEqual(first)
    expect(metrics.achievedDurationWeeks).toBeGreaterThan(0)
    expect(metrics).toEqual(repeatMetrics)
    expect(firstSchedule).toEqual(secondSchedule)
    expect(firstSchedule.featureStartWeeks).toEqual(first.result?.levellingResult.featureStartWeeks)
    expect(metrics.effortHoursByRole).toEqual(benchmark.facts.effortHoursByRole)
    expect(metrics.scheduledEffortHoursByRole).toEqual(metrics.effortHoursByRole)
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
