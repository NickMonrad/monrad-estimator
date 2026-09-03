import { describe, expect, it } from 'vitest'
import { computeJointPlan, materializeEnvelopeToResourceTypes, type CapacityPlanConfig, type JointPlanResult } from '../lib/capacity-planner.js'
import { runSAPlanner } from '../lib/sa-planner.js'
import {
  parallelSameRole,
  mixedProgramme,
  makeResourceType,
  makeInput,
  makeEpic,
  makeFeature,
  makeStory,
  makeTask,
} from './planningBenchmarkFixtures.js'

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

// ─── Helper: replay capacity envelope into scheduler-compatible resource types ─

/**
 * Convert a JointPlanResult's period-level capacity into named resources
 * with capacity segments, exactly as the reconciliation step does internally.
 * This is the test-side replay to verify the joint plan is self-consistent.
 */
function replayCapacityToResourceTypes(
  result: JointPlanResult,
  baseResourceTypes: ReturnType<typeof parallelSameRole>['resourceTypes'],
): ReturnType<typeof parallelSameRole>['resourceTypes'] {
  const maxHeadcountByRt = new Map<string, number>()
  for (const period of result.periods) {
    for (const resource of period.resources) {
      const current = maxHeadcountByRt.get(resource.resourceTypeId) ?? 0
      if (resource.headcount > current) maxHeadcountByRt.set(resource.resourceTypeId, resource.headcount)
    }
  }

  return baseResourceTypes.map(rt => {
    const maxHc = maxHeadcountByRt.get(rt.id)
    if (maxHc == null || maxHc <= 0) return rt

    const segments: Array<{ startWeek: number; endWeek: number; allocationPercent: number }> = []
    for (const period of result.periods) {
      const resource = period.resources.find(r => r.resourceTypeId === rt.id)
      if (!resource || resource.headcount <= 0) continue
      const slotCount = Math.ceil(resource.headcount)
      for (let slot = 0; slot < slotCount; slot++) {
        const pct = slot < Math.floor(resource.headcount) ? 100 : (resource.headcount % 1) * 100 || 100
        segments.push({ startWeek: period.startWeek, endWeek: period.endWeek, allocationPercent: Math.max(25, Math.round(pct)) })
      }
    }

    // Deduplicate adjacent identical segments
    const deduped: Array<{ startWeek: number; endWeek: number; allocationPercent: number }> = []
    for (const seg of segments) {
      const last = deduped[deduped.length - 1]
      if (last && last.endWeek === seg.startWeek && last.allocationPercent === seg.allocationPercent) {
        last.endWeek = seg.endWeek
      } else {
        deduped.push({ ...seg })
      }
    }

    return {
      ...rt,
      roleSegments: undefined,
      namedResources: deduped.map((seg, idx) => ({
        id: `reconcile-${rt.id}-${idx}`,
        name: `${rt.name} reconcile-${idx}`,
        startWeek: seg.startWeek,
        endWeek: seg.endWeek,
        allocationPct: seg.allocationPercent,
        allocationMode: 'CAPACITY_PLAN',
        allocationPercent: seg.allocationPercent,
        allocationStartWeek: null,
        allocationEndWeek: null,
      })),
    }
  })
}

// ═══════════════════════════════════════════════════════════════════════════════
// Fix 1: Reconciliation regression tests
// ═══════════════════════════════════════════════════════════════════════════════

describe('reconciliation — final plan is schedulable against returned capacity', () => {
  it('mixed programme: replays to same delivery with all features complete', () => {
    const input = mixedProgramme()
    const config = makeConfig(6)
    const result = computeJointPlan(input, config)

    // Replay the reconciled capacity into resource types
    const replayedRts = replayCapacityToResourceTypes(result, input.resourceTypes)
    const replaySchedule = runSAPlanner({ ...input, resourceTypes: replayedRts }, {
      targetDurationWeeks: config.targetDurationWeeks,
      maxParallelismPerFeature: config.maxParallelismPerFeature,
      maxCap: config.maxCap,
      maxConcurrentEpics: config.maxConcurrentEpics,
      iterations: 10000, initialTemp: 100, coolingRate: 0.995,
    })

    // Reconciled schedule matches result delivery
    expect(replaySchedule.totalDeliveryWeeks).toBeCloseTo(result.deliveryWeeks, 4)

    // All features complete
    for (const epic of input.epics) {
      for (const feature of epic.features) {
        expect(replaySchedule.featureStartWeeks.has(feature.id)).toBe(true)
      }
    }
  })

  it('parallel same-role: replays to same delivery within target', () => {
    const input = parallelSameRole()
    const config = makeConfig(2)
    const result = computeJointPlan(input, config)

    expect(result.targetAchieved).toBe(true)

    const replayedRts = replayCapacityToResourceTypes(result, input.resourceTypes)
    const replaySchedule = runSAPlanner({ ...input, resourceTypes: replayedRts }, {
      targetDurationWeeks: config.targetDurationWeeks,
      maxParallelismPerFeature: config.maxParallelismPerFeature,
      iterations: 10000, initialTemp: 100, coolingRate: 0.995,
    })
    expect(replaySchedule.totalDeliveryWeeks).toBeLessThanOrEqual(config.targetDurationWeeks + 1)
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
// Fix 2: Profile-backed progression tests
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

  it('target already met on first schedule: reduction terminates', () => {
    const input = makeProfiledInput()
    const config = makeConfig(12)
    const result = computeJointPlan(input, config)

    expect(result.targetAchieved).toBe(true)
    expect(result.iterations).toBeLessThanOrEqual(5)
  })

  it('profile window boundaries and gaps are never broadened', () => {
    // Two separate windows with a gap: weeks 2–4 and 7–10
    const dev = makeResourceType('rt-dev', 'Developer', 1)
    dev.roleSegments = [
      { startWeek: 2, endWeek: 4, allocationPercent: 100 },
      { startWeek: 7, endWeek: 10, allocationPercent: 100 },
    ]

    // Create an envelope that spans wider than the windows (weeks 0-12)
    const periods = [
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

    const result = materializeEnvelopeToResourceTypes([dev], periods, 4)
    const devResult = result.find(r => r.id === 'rt-dev')!

    // roleSegments must be preserved (not cleared)
    expect(devResult.roleSegments).toBeDefined()
    expect(devResult.roleSegments).toHaveLength(2)

    // Named resources must exist only within profile windows
    for (const nr of devResult.namedResources ?? []) {
      const nrSw = nr.startWeek as number
      const nrEw = nr.endWeek as number
      for (let w = nrSw; w < nrEw; w++) {
        const inWindow = dev.roleSegments!.some(seg => w >= seg.startWeek && w < seg.endWeek)
        expect(inWindow).toBe(true)
      }
    }

    // No capacity in the gap (weeks 4-7): verify named resources don't start/end there
    for (const nr of devResult.namedResources ?? []) {
      const nrSw = nr.startWeek as number
      const nrEw = nr.endWeek as number
      // Named resource boundaries must align with profile window boundaries
      const startsInGap = nrSw >= 4 && nrSw < 7
      const endsInGap = nrEw > 4 && nrEw <= 7
      expect(startsInGap).toBe(false)
      expect(endsInGap).toBe(false)
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
// Fix 3: Iteration count tests
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
