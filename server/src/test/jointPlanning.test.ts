import { describe, expect, it } from 'vitest'
import {
  computeJointPlan,
  materializeEnvelopeToResourceTypes,
  type CapacityPlanConfig,
  type JointPlanResult,
} from '../lib/capacity-planner.js'
import {
  measureCapacityPlanQuality,
  runCapacityPlanSchedule,
} from '../lib/planning-benchmark.js'
import { getWeeklyCapacity } from '../lib/scheduler.js'
import {
  parallelSameRole,
  serialCriticalPath,
  explicitRoleMaximum,
  roleHandoff,
  sparseSpecialist,
  mixedProgramme,
  factorySupplyChainBenchmark,
} from './planningBenchmarkFixtures.js'

const TOLERANCE = 1e-6
const HOURS_PER_DAY = 8

function makeConfig(targetDurationWeeks: number): CapacityPlanConfig {
  return {
    targetDurationWeeks,
    periodWeeks: 4,
    maxDeltaPerPeriod: 1,
    minFloor: new Map(),
    dayRates: new Map(),
    maxParallelismPerFeature: 2,
  }
}

function replayReturnedPlan(
  input: Parameters<typeof computeJointPlan>[0],
  result: JointPlanResult,
  config: CapacityPlanConfig,
) {
  const replayInput = {
    ...input,
    resourceTypes: materializeEnvelopeToResourceTypes(input.resourceTypes, result.periods, config.periodWeeks),
  }
  const schedule = runCapacityPlanSchedule(replayInput, config)
  return { replayInput, schedule }
}

function expectReturnedPlanReplays(
  input: Parameters<typeof computeJointPlan>[0],
  result: JointPlanResult,
  config: CapacityPlanConfig,
) {
  const { replayInput, schedule } = replayReturnedPlan(input, result, config)
  expect(schedule.totalDeliveryWeeks).toBeCloseTo(result.deliveryWeeks, 6)
  expect(schedule.featureStartWeeks).toEqual(result.levellingResult.featureStartWeeks)

  const metrics = measureCapacityPlanQuality(input, config.targetDurationWeeks, result, schedule)
  expect(metrics.scheduledEffortByRole).toEqual(metrics.effortByRole)
  expect(metrics.dependencyViolations).toEqual([])
  for (const epic of input.epics) {
    for (const feature of epic.features) {
      expect(schedule.featureStartWeeks.has(feature.id)).toBe(true)
      expect(schedule.weeklyAllocationsByFeature.has(feature.id)).toBe(true)
    }
  }
  for (const rt of replayInput.resourceTypes) {
    const demand = schedule.weeklyDemandByResourceType.get(rt.id) ?? []
    for (let week = 0; week < demand.length; week++) {
      expect(demand[week] ?? 0).toBeLessThanOrEqual(getWeeklyCapacity(rt, week, HOURS_PER_DAY) / HOURS_PER_DAY + TOLERANCE)
    }
  }
  return { replayInput, schedule, metrics }
}

describe('joint planning loop — scenario A: parallel same-role workload', () => {
  it('grows a role when additional staffing improves delivery', () => {
    const input = parallelSameRole()
    const config = makeConfig(2)
    const result = computeJointPlan(input, config)
    const { metrics } = expectReturnedPlanReplays(input, result, config)

    expect(result.targetAchieved).toBe(true)
    expect(result.deliveryWeeks).toBeCloseTo(2, 6)
    expect(result.iterations).toBeGreaterThanOrEqual(1)

    // Capacity should have grown from 1 to >= 1.5 FTE
    const peakDev = Math.max(...result.periods.flatMap(p =>
      p.resources.filter(r => r.resourceTypeId === 'rt-dev').map(r => r.headcount)))
    expect(peakDev).toBeGreaterThanOrEqual(1.5)

    expect(metrics.capacityViolations).toEqual([])
    expect(metrics.dependencyViolations).toEqual([])
  })
})

describe('joint planning loop — scenario B: serial critical path', () => {
  it('does not increase capacity when dependency chain is the bottleneck', () => {
    const input = serialCriticalPath()
    const config = makeConfig(4)
    const result = computeJointPlan(input, config)

    expect(result.targetAchieved).toBe(true)
    expect(result.deliveryWeeks).toBeLessThanOrEqual(config.targetDurationWeeks)

    const peakDev = Math.max(...result.periods.flatMap(p =>
      p.resources.filter(r => r.resourceTypeId === 'rt-dev').map(r => r.headcount)))
    // The initial one-FTE role is sufficient for this dependency-bound workload;
    // the joint loop must not add capacity that the target does not need.
    expect(peakDev).toBeLessThanOrEqual(input.resourceTypes[0].count + TOLERANCE)

    const { metrics } = expectReturnedPlanReplays(input, result, config)
    expect(metrics.dependencyViolations).toEqual([])
    expect(metrics.effortByRole['rt-dev']).toBeCloseTo(10, 6)

  })
})

describe('joint planning loop — scenario C: explicit role maximum', () => {
  it('respects explicit max and reports blocker when target needs more', () => {
    const { input, config } = explicitRoleMaximum()
    const result = computeJointPlan(input, config)

    const cappedRole = result.periods.flatMap(p => p.resources)
      .filter(r => r.resourceTypeId === 'rt-dev')
    expect(cappedRole.every(r => r.headcount <= 1 + TOLERANCE)).toBe(true)

    expect(result.targetAchieved).toBe(false)
    expect(result.deliveryWeeks).toBeGreaterThan(config.targetDurationWeeks)

    const maxCapDiag = result.loopDiagnostics.find(d => d.blocker === 'ROLE_MAX_CAP')
    expect(maxCapDiag).toBeDefined()
    expect(maxCapDiag?.resourceTypeId).toBe('rt-dev')
  })
})

describe('joint planning loop — scenario D: role hand-off', () => {
  it('ramps roles in when their phase needs them and ramps down after', () => {
    const input = roleHandoff()
    const config = makeConfig(2)
    const result = computeJointPlan(input, config)
    const { metrics } = expectReturnedPlanReplays(input, result, config)

    expect(result.targetAchieved).toBe(true)

    // Dev and QA should have distinct ramp shapes
    const devShape = metrics.rampShapeByRole['rt-dev']
    const qaShape = metrics.rampShapeByRole['rt-qa']
    expect(devShape.startTransitions).toBe(1)
    expect(devShape.endTransitions).toBe(1)
    expect(qaShape.startTransitions).toBe(1)
    expect(qaShape.endTransitions).toBe(1)
  })
})

describe('joint planning loop — scenario E: sparse specialist', () => {
  it('preserves fractional specialist capacity', () => {
    const input = sparseSpecialist()
    const config = makeConfig(4)
    const result = computeJointPlan(input, config)
    const { metrics } = expectReturnedPlanReplays(input, result, config)

    expect(result.targetAchieved).toBe(true)
    expect(metrics.effortByRole['rt-specialist']).toBeCloseTo(1, 6)

    const specialist = metrics.rampShapeByRole['rt-specialist']
    expect(specialist.peakDemandFte).toBeLessThanOrEqual(0.5)
    expect(metrics.utilisationPctByRole['rt-specialist']).toBeGreaterThan(0)
    expect(metrics.utilisationPctByRole['rt-specialist']).toBeLessThan(50)
  })
})

describe('joint planning loop — scenario F: mixed programme', () => {
  it('meets target where feasible with valid dependencies and effort conservation', () => {
    const input = mixedProgramme()
    const config = makeConfig(6)
    const result = computeJointPlan(input, config)
    const { metrics } = expectReturnedPlanReplays(input, result, config)

    expect(result.targetAchieved).toBe(true)
    expect(metrics.capacityViolations).toEqual([])
    expect(metrics.dependencyViolations).toEqual([])
    expect(Object.keys(metrics.staffedFteWeeksByRole)).toEqual(['rt-dev', 'rt-qa'])
    expect(metrics.peakStaffingFte).toBeGreaterThan(0)
  })
})

describe('joint planning loop — scenario G: capacity minimisation', () => {
  it('reduces removable capacity while maintaining target', () => {
    const input = parallelSameRole()
    input.resourceTypes[0].count = 10
    const config = makeConfig(2)
    const result = computeJointPlan(input, config)

    expect(result.targetAchieved).toBe(true)

    const peakDev = Math.max(...result.periods.flatMap(p =>
      p.resources.filter(r => r.resourceTypeId === 'rt-dev').map(r => r.headcount)))
    expect(peakDev).toBeLessThan(10)
    expect(peakDev).toBeLessThanOrEqual(5)
    expect(peakDev).toBeGreaterThanOrEqual(1.5)
  })
})

describe('joint planning loop — scenario H: determinism', () => {
  it('produces identical results for identical inputs', () => {
    const input = mixedProgramme()
    const config = makeConfig(6)

    const first = computeJointPlan(input, config)
    const second = computeJointPlan(input, config)

    expect(second.deliveryWeeks).toBe(first.deliveryWeeks)
    expect(second.periods).toEqual(first.periods)
    expect(second.loopDiagnostics).toEqual(first.loopDiagnostics)
    expect(second.iterations).toBe(first.iterations)
    expect(second.targetAchieved).toBe(first.targetAchieved)
  })
})

describe('Factory / Supply Chain benchmark through joint planning loop', () => {
  it('achieves material improvement or reports hard-constraint evidence', () => {
    const benchmark = factorySupplyChainBenchmark()
    const { input, config, facts } = benchmark

    const jointResult = computeJointPlan(input, config)

    if (jointResult.targetAchieved) {
      expect(jointResult.deliveryWeeks).toBeLessThanOrEqual(facts.targetDurationWeeks)
      expect(jointResult.iterations).toBeGreaterThanOrEqual(1)
      expectReturnedPlanReplays(input, jointResult, config)
      console.log(`Factory/Supply Chain: target=${facts.targetDurationWeeks}w, achieved=${jointResult.deliveryWeeks}w, iterations=${jointResult.iterations}`)
      console.log(`  peak headcount: ${jointResult.peakHeadcount}, cost: ${jointResult.totalCost}`)
    } else {
      expect(jointResult.loopDiagnostics.length).toBeGreaterThan(0)
      expect(jointResult.diagnostics?.length).toBeGreaterThan(0)
      expect(jointResult.deliveryWeeks).toBeGreaterThan(facts.targetDurationWeeks)
      console.log(`Factory/Supply Chain: target=${facts.targetDurationWeeks}w NOT met, diagnostics:`)
      for (const d of jointResult.loopDiagnostics) {
        console.log(`  ${d.blocker}: ${d.explanation}`)
      }
    }

    // Determinism check
    const second = computeJointPlan(input, config)
    expect(second.deliveryWeeks).toBe(jointResult.deliveryWeeks)
    expect(second.periods).toEqual(jointResult.periods)
  })
})
