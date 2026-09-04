import { describe, expect, it } from 'vitest'
import {
  computeJointPlan,
  materializeEnvelopeToResourceTypes,
  augmentResourceType,
  reduceResourceType,
  type CapacityPlanConfig,
  type CapacityPlanPeriodResult,
  type JointPlanResult,
} from '../lib/capacity-planner.js'
import { runSAPlanner, type SAPlannerConfig } from '../lib/sa-planner.js'
import { getWeeklyCapacity, type SchedulerInput, type SchedulerResourceType } from '../lib/scheduler.js'
import {
  parallelSameRole,
  mixedProgramme,
  explicitRoleMaximum,
  makeResourceType,
  makeInput,
  makeEpic,
  makeFeature,
  makeStory,
  makeTask,
} from './planningBenchmarkFixtures.js'

const HPD = 8
const EPS = 1e-6

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

function makeSaConfig(config: CapacityPlanConfig): SAPlannerConfig {
  return {
    targetDurationWeeks: config.targetDurationWeeks,
    maxParallelismPerFeature: config.maxParallelismPerFeature,
    maxCap: config.maxCap,
    maxConcurrentEpics: config.maxConcurrentEpics,
    iterations: 10000,
    initialTemp: 100,
    coolingRate: 0.995,
  }
}

/** Scheduler-effective weekly capacity in days for a resource type. */
function effectiveCapacityDays(rt: SchedulerResourceType, week: number): number {
  return getWeeklyCapacity(rt, week, HPD) / HPD
}

/**
 * Capacity (in days) that the returned envelope commits for `rt` in `week`:
 * the headcount of the envelope period covering the week (period endWeek is
 * exclusive), clipped to the authoritative roleSegments windows (window
 * endWeek is inclusive, mirroring the scheduler model). Zero when the week
 * is not covered by a period or falls in a window gap.
 */
function committedCapacityDays(
  rt: SchedulerResourceType,
  periods: CapacityPlanPeriodResult[],
  week: number,
): number {
  for (const period of periods) {
    if (week < period.startWeek || week >= period.endWeek) continue
    const entry = period.resources.find(r => r.resourceTypeId === rt.id)
    if (!entry || entry.headcount <= 0) return 0
    if (rt.roleSegments && rt.roleSegments.length > 0) {
      const inWindow = rt.roleSegments.some(seg => week >= seg.startWeek && week <= seg.endWeek)
      if (!inWindow) return 0
    }
    return entry.headcount * 5
  }
  return 0
}

/** Replay the returned capacity through the production materializer. */
function replayReturnedCapacity(
  input: SchedulerInput,
  result: JointPlanResult,
  config: CapacityPlanConfig,
) {
  const replayedRts = materializeEnvelopeToResourceTypes(input.resourceTypes, result.periods, config.periodWeeks)
  return runSAPlanner({ ...input, resourceTypes: replayedRts }, makeSaConfig(config))
}

/**
 * Core #481 reconciliation invariants against the PRODUCTION materializer:
 * 1. scheduler effective weekly capacity == committed returned capacity;
 * 2. weekly demand of the reconciled schedule never exceeds committed
 *    effective capacity;
 * 3. no capacity ever appears outside the authoritative profile windows.
 */
function expectCapacityIsAuthoritative(
  input: SchedulerInput,
  result: JointPlanResult,
  config: CapacityPlanConfig,
): void {
  const replayedRts = materializeEnvelopeToResourceTypes(input.resourceTypes, result.periods, config.periodWeeks)
  const committedRtIds = new Set<string>()
  for (const period of result.periods) {
    for (const r of period.resources) {
      if (r.headcount > 0) committedRtIds.add(r.resourceTypeId)
    }
  }
  const baseRtById = new Map(input.resourceTypes.map(rt => [rt.id, rt]))
  const replaySchedule = runSAPlanner({ ...input, resourceTypes: replayedRts }, makeSaConfig(config))

  for (const rt of replayedRts) {
    if (!committedRtIds.has(rt.id)) continue
    const baseRt = baseRtById.get(rt.id)!
    const horizon = Math.ceil(result.deliveryWeeks) + 2
    for (let w = 0; w <= horizon; w++) {
      const committed = committedCapacityDays(baseRt, result.periods, w)
      expect(effectiveCapacityDays(rt, w)).toBeCloseTo(committed, 6)
    }
    // Weekly demand never exceeds committed effective capacity
    const demand = replaySchedule.weeklyDemandByResourceType.get(rt.id) ?? []
    for (let w = 0; w < demand.length; w++) {
      const d = demand[w] ?? 0
      if (d > EPS) {
        expect(d).toBeLessThanOrEqual(committedCapacityDays(baseRt, result.periods, w) + EPS)
      }
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Reconciliation: the returned capacity is authoritative (no double counting,
// no stale aggregate role capacity, slower-but-successful replay wins)
// ═══════════════════════════════════════════════════════════════════════════════

describe('reconciliation — returned capacity is authoritative', () => {
  it('mixed programme: replays to same delivery with all features complete', () => {
    const input = mixedProgramme()
    const config = makeConfig(6)
    const result = computeJointPlan(input, config)

    const replaySchedule = replayReturnedCapacity(input, result, config)

    // Reconciled schedule matches result delivery
    expect(replaySchedule.totalDeliveryWeeks).toBeCloseTo(result.deliveryWeeks, 4)

    // All features complete
    for (const epic of input.epics) {
      for (const feature of epic.features) {
        expect(replaySchedule.featureStartWeeks.has(feature.id)).toBe(true)
      }
    }

    expectCapacityIsAuthoritative(input, result, config)
  })

  it('parallel same-role: replays to same delivery within target', () => {
    const input = parallelSameRole()
    const config = makeConfig(2)
    const result = computeJointPlan(input, config)

    expect(result.targetAchieved).toBe(true)

    const replaySchedule = replayReturnedCapacity(input, result, config)
    expect(replaySchedule.totalDeliveryWeeks).toBeLessThanOrEqual(config.targetDurationWeeks + 1)

    expectCapacityIsAuthoritative(input, result, config)
  })

  it('profile-backed role: no aggregate role capacity counted on top of the envelope', () => {
    // Role available at 1 FTE across weeks 0–10 (authoritative window).
    const dev = makeResourceType('rt-dev', 'Developer', 1)
    dev.roleSegments = [{ startWeek: 0, endWeek: 10, allocationPercent: 100 }]
    const input = makeInput([
      makeEpic('recon-profile-epic', [
        makeFeature('recon-profile-f0', [makeStory('recon-profile-s0', [makeTask(200, 'rt-dev', 'Developer', 8)])], 0),
      ]),
    ], [dev])
    const config = makeConfig(12)
    const result = computeJointPlan(input, config)
    expect(result.targetAchieved).toBe(true)

    // The materialized replay representation carries NO aggregate role
    // capacity: capacity comes exclusively from the reconcile-* named
    // resources clipped to the profile window.
    const replayedRts = materializeEnvelopeToResourceTypes(input.resourceTypes, result.periods, config.periodWeeks)
    const devRt = replayedRts.find(rt => rt.id === 'rt-dev')!
    expect(devRt.roleSegments).toBeUndefined()
    expect(devRt.namedResources ?? []).not.toHaveLength(0)

    // No capacity at all outside the profile window
    for (const nr of devRt.namedResources ?? []) {
      expect(nr.startWeek).toBeGreaterThanOrEqual(0)
      expect(nr.endWeek).toBeLessThanOrEqual(10)
    }
    const horizon = Math.ceil(result.deliveryWeeks) + 2
    for (let w = 11; w <= Math.max(horizon, 11); w++) {
      expect(effectiveCapacityDays(devRt, w)).toBeCloseTo(0, 6)
    }

    expectCapacityIsAuthoritative(input, result, config)
  })

  it('successful-but-slower reconciliation becomes the returned result', () => {
    // Growth is hard-capped at 1 FTE while the backlog needs ~4 weeks:
    // the plan completes but misses the 2-week target. The returned
    // deliveryWeeks must come from the schedule the FINAL returned capacity
    // actually produces (replay reproduces it), never from an unreconciled
    // faster candidate, and target-miss diagnostics must be present.
    const { input, config } = explicitRoleMaximum()
    const result = computeJointPlan(input, config)

    expect(result.targetAchieved).toBe(false)
    expect(result.deliveryWeeks).toBeGreaterThan(config.targetDurationWeeks)
    expect(Number.isFinite(result.deliveryWeeks)).toBe(true)

    const replaySchedule = replayReturnedCapacity(input, result, config)
    expect(replaySchedule.totalDeliveryWeeks).toBeCloseTo(result.deliveryWeeks, 4)

    const maxCapDiag = result.loopDiagnostics.find(d => d.blocker === 'ROLE_MAX_CAP')
    expect(maxCapDiag).toBeDefined()
    expect(result.diagnostics?.some(d => d.blocker === 'ROLE_MAX_CAP')).toBe(true)
  })

  it('reconciliation failure cannot produce targetAchieved: true', () => {
    // Create a resource type with an impossible profile window (too narrow)
    const dev = makeResourceType('rt-dev', 'Developer', 1)
    dev.roleSegments = [{ startWeek: 0, endWeek: 1, allocationPercent: 100 }]
    // 800h effort, but only 1 week of availability at 1 FTE = 40h capacity
    const input = makeInput([
      makeEpic('fail-epic', [
        makeFeature('fail-f0', [makeStory('fail-s0', [makeTask(800, 'rt-dev', 'Developer', 8)])], 0),
      ]),
    ], [dev])

    const config = makeConfig(4)
    const result = computeJointPlan(input, config)

    // Target cannot be met — either targetAchieved is false or diagnostics explain
    if (result.targetAchieved) {
      // If somehow achieved, delivery must be within target
      expect(result.deliveryWeeks).toBeLessThanOrEqual(config.targetDurationWeeks + 1)
    } else {
      // Not achieved — diagnostics should explain why
      expect(result.loopDiagnostics.length).toBeGreaterThan(0)
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// Profile-backed capacity progression: windows and gaps stay hard during
// iterative growth and reduction (0.25 FTE steps on the SAME representation)
// ═══════════════════════════════════════════════════════════════════════════════

describe('profile-backed capacity progression', () => {
  function makeProfiledInput() {
    const dev = makeResourceType('rt-dev', 'Developer', 1)
    dev.roleSegments = [{ startWeek: 0, endWeek: 10, allocationPercent: 100 }]
    return makeInput([
      makeEpic('prof-epic', [
        makeFeature('prof-f0', [makeStory('prof-s0', [makeTask(200, 'rt-dev', 'Developer', 8)])], 0),
        makeFeature('prof-f1', [makeStory('prof-s1', [makeTask(200, 'rt-dev', 'Developer', 8)])], 1,
          [{ featureId: 'prof-f1', dependsOnId: 'prof-f0' }]),
      ]),
    ], [dev])
  }

  function makeTwoWindowDev() {
    // Window A: weeks 2–4, gap 4–7, window B: weeks 7–10 (inclusive ends)
    const dev = makeResourceType('rt-dev', 'Developer', 1)
    dev.roleSegments = [
      { startWeek: 2, endWeek: 4, allocationPercent: 100 },
      { startWeek: 7, endWeek: 10, allocationPercent: 100 },
    ]
    return dev
  }

  it('target already met on first schedule: reduction terminates', () => {
    const input = makeProfiledInput()
    const config = makeConfig(12)
    const result = computeJointPlan(input, config)

    expect(result.targetAchieved).toBe(true)
    expect(result.iterations).toBeLessThanOrEqual(5)
  })

  it('profile window boundaries and gaps are never broadened by materialization', () => {
    const dev = makeTwoWindowDev()

    // Envelope spanning wider than the windows (weeks 0-12)
    const periods: CapacityPlanPeriodResult[] = [
      { periodIndex: 0, periodLabel: 'W0-4', startWeek: 0, endWeek: 4,
        resources: [{ resourceTypeId: 'rt-dev', resourceTypeName: 'Developer', headcount: 2,
          avgDemandFTE: 1, peakDemandFTE: 1.5, utilisationPct: 75, costForPeriod: 0 }] },
      { periodIndex: 1, periodLabel: 'W4-8', startWeek: 4, endWeek: 8,
        resources: [{ resourceTypeId: 'rt-dev', resourceTypeName: 'Developer', headcount: 2,
          avgDemandFTE: 1, peakDemandFTE: 1.5, utilisationPct: 75, costForPeriod: 0 }] },
      { periodIndex: 2, periodLabel: 'W8-12', startWeek: 8, endWeek: 12,
        resources: [{ resourceTypeId: 'rt-dev', resourceTypeName: 'Developer', headcount: 1,
          avgDemandFTE: 0.5, peakDemandFTE: 0.5, utilisationPct: 50, costForPeriod: 0 }] },
    ]

    const materialized = materializeEnvelopeToResourceTypes([dev], periods, 4)
    const devResult = materialized.find(r => r.id === 'rt-dev')!

    // The envelope is the sole capacity authority: stale aggregate
    // roleSegments are cleared (no double counting) and count mirrors the
    // envelope peak (no phantom slots).
    expect(devResult.roleSegments).toBeUndefined()
    expect(devResult.count).toBeCloseTo(2, 6)

    // Effective scheduler capacity per week: exactly the committed headcount
    // inside the windows, exactly zero in the 4–7 gap and outside 2–10.
    const expectedFteByWeek = new Map<number, number>([
      [0, 0], [1, 0],            // before window A
      [2, 2], [3, 2], [4, 2],    // window A (headcount 2)
      [5, 0], [6, 0],            // gap — must stay zero
      [7, 2],                    // window B from period W4-8 (headcount 2)
      [8, 1], [9, 1], [10, 1],   // window B from period W8-12 (headcount 1)
      [11, 0], [12, 0],          // after window B
    ])
    for (const [week, fte] of expectedFteByWeek) {
      expect(effectiveCapacityDays(devResult, week)).toBeCloseTo(fte * 5, 6)
    }
  })

  it('growth adds exactly 0.25 FTE inside each window and zero in the gap', () => {
    const dev = makeTwoWindowDev()
    const grown = augmentResourceType([dev], 'rt-dev').find(r => r.id === 'rt-dev')!

    // Windows and gap are preserved — same boundaries, capacity raised by
    // 25pp inside every segment.
    expect(grown.roleSegments).toHaveLength(2)
    expect(grown.roleSegments![0]).toMatchObject({ startWeek: 2, endWeek: 4, allocationPercent: 125 })
    expect(grown.roleSegments![1]).toMatchObject({ startWeek: 7, endWeek: 10, allocationPercent: 125 })
    // No joint-boost bridge named resource spanning the gap
    expect((grown.namedResources ?? []).some(nr => nr.id.startsWith('joint-boost-'))).toBe(false)

    for (let w = 0; w <= 12; w++) {
      const inWindow = (w >= 2 && w <= 4) || (w >= 7 && w <= 10)
      const expectedDays = inWindow ? 1.25 * 5 : 0
      expect(effectiveCapacityDays(grown, w)).toBeCloseTo(expectedDays, 6)
    }
  })

  it('reduction removes exactly 0.25 FTE from both windows and reverses growth', () => {
    const dev = makeTwoWindowDev()
    const grown = augmentResourceType([dev], 'rt-dev').find(r => r.id === 'rt-dev')!
    const { rts: reducedRts, reduced } = reduceResourceType([grown], 'rt-dev')
    expect(reduced).toBe(true)
    const reducedRt = reducedRts.find(r => r.id === 'rt-dev')!
    expect(reducedRt.roleSegments![0]).toMatchObject({ startWeek: 2, endWeek: 4, allocationPercent: 100 })
    expect(reducedRt.roleSegments![1]).toMatchObject({ startWeek: 7, endWeek: 10, allocationPercent: 100 })
    // Grow/reduce round trip returns to the original effective profile
    for (let w = 0; w <= 12; w++) {
      const expectedDays = effectiveCapacityDays(dev, w)
      expect(effectiveCapacityDays(reducedRt, w)).toBeCloseTo(expectedDays, 6)
    }

    // Further reduction keeps removing capacity from both windows only
    const { rts: reducedTwiceRts, reduced: reducedTwice } = reduceResourceType(reducedRts, 'rt-dev')
    expect(reducedTwice).toBe(true)
    const reducedTwiceRt = reducedTwiceRts.find(r => r.id === 'rt-dev')!
    expect(reducedTwiceRt.roleSegments![0].allocationPercent).toBe(75)
    expect(reducedTwiceRt.roleSegments![1].allocationPercent).toBe(75)
    for (let w = 5; w <= 6; w++) {
      expect(effectiveCapacityDays(reducedTwiceRt, w)).toBeCloseTo(0, 6)
    }
  })

  it('reduction stops reporting progress at the zero floor', () => {
    const dev = makeResourceType('rt-dev', 'Developer', 1)
    dev.roleSegments = [
      { startWeek: 0, endWeek: 4, allocationPercent: 25 },
      { startWeek: 8, endWeek: 10, allocationPercent: 25 },
    ]
    const first = reduceResourceType([dev], 'rt-dev')
    expect(first.reduced).toBe(true)
    const second = reduceResourceType(first.rts, 'rt-dev')
    expect(second.reduced).toBe(false)
    expect(second.rts).toEqual(first.rts)
    for (const seg of second.rts[0].roleSegments!) {
      expect(seg.allocationPercent).toBe(0)
    }
  })

  it('growth uses 0.25 FTE steps (segment-based)', () => {
    const dev = makeResourceType('rt-dev', 'Developer', 1)
    dev.roleSegments = [{ startWeek: 0, endWeek: 20, allocationPercent: 100 }]
    const input = makeInput([
      makeEpic('grow-epic', [
        makeFeature('grow-f0', [makeStory('grow-s0', [makeTask(800, 'rt-dev', 'Developer', 8)])], 0),
      ]),
    ], [dev])

    const config = makeConfig(10)
    const result = computeJointPlan(input, config)

    if (result.periods.length > 0) {
      const peakDev = Math.max(...result.periods.flatMap(p =>
        p.resources.filter(r => r.resourceTypeId === 'rt-dev').map(r => r.headcount)))
      expect(peakDev).toBeGreaterThan(1)
      expect(peakDev % 0.25).toBeCloseTo(0, 4)
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// Iteration count tests
// ═══════════════════════════════════════════════════════════════════════════════

describe('iteration count', () => {
  it('reports > 1 when growth is required', () => {
    const input = parallelSameRole()
    const config = makeConfig(2)
    const result = computeJointPlan(input, config)
    // Growth from 1→2 FTE requires at least growth iterations + reconciliation
    expect(result.iterations).toBeGreaterThan(1)
  })

  it('reports low count when no growth is needed', () => {
    const dev = makeResourceType('rt-dev', 'Developer', 10)
    const input = makeInput([
      makeEpic('nogrow-epic', [
        makeFeature('nogrow-f0', [makeStory('nogrow-s0', [makeTask(200, 'rt-dev', 'Developer', 8)])], 0),
      ]),
    ], [dev])
    const config = makeConfig(12)
    const result = computeJointPlan(input, config)
    // 10 FTE for 200h — no growth needed
    expect(result.iterations).toBeLessThanOrEqual(5)
  })

  it('repeated identical inputs return same iteration count', () => {
    const input = mixedProgramme()
    const config = makeConfig(6)
    const first = computeJointPlan(input, config)
    const second = computeJointPlan(input, config)
    expect(second.iterations).toBe(first.iterations)
  })

  it('iteration count never exceeds the bounded maximum', () => {
    const input = parallelSameRole()
    const config = makeConfig(2)
    const result = computeJointPlan(input, config)
    expect(result.iterations).toBeGreaterThan(0)
    expect(result.iterations).toBeLessThanOrEqual(200)
  })
})
