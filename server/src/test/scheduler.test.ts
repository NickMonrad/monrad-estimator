/**
 * scheduler.test.ts
 *
 * Unit tests for the pure scheduling engine (lib/scheduler.ts).
 *
 * Because runScheduler() is a pure function with no DB or I/O dependencies,
 * there is nothing to mock — we just construct minimal SchedulerInput objects
 * and assert on SchedulerOutput.
 */
import { describe, it, expect } from 'vitest'
import {
  runScheduler,
  getWeeklyCapacity,
  effectiveAllocationPct,
  computeParallelWarnings,
  type SchedulerInput,
  type SchedulerEpic,
  type SchedulerFeature,
  type SchedulerStory,
  type SchedulerResourceType,
} from '../lib/scheduler.js'
import { deriveSlotSegments } from '../routes/squadPlan.js'

// ─────────────────────────────────────────────────────────────────────────────
// Helpers to build minimal input objects
// ─────────────────────────────────────────────────────────────────────────────

function makeTask(hoursEffort: number, rtId: string | null = null, rtName = 'Dev', hpd = 8) {
  return {
    resourceTypeId: rtId,
    hoursEffort,
    durationDays: null as null,
    resourceType: rtId ? { id: rtId, name: rtName, hoursPerDay: hpd } : null,
  }
}

function makeStory(id: string, tasks: ReturnType<typeof makeTask>[], order = 0): SchedulerStory {
  return { id, order, isActive: null, tasks }
}

function makeFeature(
  id: string,
  stories: SchedulerStory[],
  order = 0,
  deps: Array<{ featureId: string; dependsOnId: string }> = [],
): SchedulerFeature {
  return { id, order, isActive: null, timelineStartWeek: null, userStories: stories, dependencies: deps }
}

function makeEpic(
  id: string,
  features: SchedulerFeature[],
  opts: Partial<Omit<SchedulerEpic, 'id' | 'features'>> = {},
): SchedulerEpic {
  return {
    id,
    name: id,
    order: 0,
    isActive: null,
    featureMode: 'sequential',
    scheduleMode: 'sequential',
    timelineStartWeek: null,
    features,
    ...opts,
  }
}

function makeRt(id: string, name: string, count: number, hpd = 8): SchedulerResourceType {
  return { id, name, count, hoursPerDay: hpd, namedResources: [] }
}

function baseInput(overrides: Partial<SchedulerInput> = {}): SchedulerInput {
  return {
    project: { hoursPerDay: 8 },
    epics: [],
    resourceTypes: [],
    epicDeps: [],
    manualFeatureEntries: [],
    manualStoryEntries: [],
    resourceLevel: false,
    ...overrides,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper tests (pure utility functions)
// ─────────────────────────────────────────────────────────────────────────────

describe('effectiveAllocationPct', () => {
  it('FULL_PROJECT: returns allocationPercent for any week', () => {
    const nr = { id: 'nr1', name: 'Dev 1', startWeek: null, endWeek: null, allocationPct: 100, allocationMode: 'FULL_PROJECT', allocationPercent: 80, allocationStartWeek: null, allocationEndWeek: null }
    expect(effectiveAllocationPct(nr, 0)).toBe(80)
    expect(effectiveAllocationPct(nr, 99)).toBe(80)
  })

  it('TIMELINE: returns allocationPercent only within window', () => {
    const nr = { id: 'nr1', name: 'Dev 1', startWeek: 2, endWeek: 5, allocationPct: 100, allocationMode: 'TIMELINE', allocationPercent: 100, allocationStartWeek: 2, allocationEndWeek: 5 }
    expect(effectiveAllocationPct(nr, 1)).toBe(0)
    expect(effectiveAllocationPct(nr, 2)).toBe(100)
    expect(effectiveAllocationPct(nr, 5)).toBe(100)
    expect(effectiveAllocationPct(nr, 6)).toBe(0)
  })

  it('EFFORT: always returns 100', () => {
    const nr = { id: 'nr1', name: 'Dev 1', startWeek: 1, endWeek: 3, allocationPct: 50, allocationMode: 'EFFORT', allocationPercent: 50, allocationStartWeek: null, allocationEndWeek: null }
    expect(effectiveAllocationPct(nr, 0)).toBe(100)
    expect(effectiveAllocationPct(nr, 10)).toBe(100)
  })
})

describe('getWeeklyCapacity', () => {
  it('no named resources: count × hpd × 5', () => {
    const rt = makeRt('rt1', 'Dev', 3, 8)
    expect(getWeeklyCapacity(rt, 0, 8)).toBe(3 * 8 * 5)
  })

  it('named resources: sums capacity from active members + phantom slots from count', () => {
    const rt: SchedulerResourceType = {
      id: 'rt1', name: 'Dev', count: 2, hoursPerDay: 8,
      namedResources: [
        { id: 'nr1', name: 'Alice', startWeek: 0, endWeek: 10, allocationPct: 100, allocationMode: 'FULL_PROJECT', allocationPercent: 100, allocationStartWeek: null, allocationEndWeek: null },
        { id: 'nr2', name: 'Bob', startWeek: 5, endWeek: 10, allocationPct: 100, allocationMode: 'FULL_PROJECT', allocationPercent: 100, allocationStartWeek: null, allocationEndWeek: null },
      ],
    }
    // count=2, namedResources.length=2 → 0 phantom slots; only named contribute.
    expect(getWeeklyCapacity(rt, 4, 8)).toBe(1 * 8 * 5)   // only Alice active
    expect(getWeeklyCapacity(rt, 5, 8)).toBe(2 * 8 * 5)   // both active
  })

  it('count > namedResources.length: phantom slots fill the remainder', () => {
    // 2 named @ 100%, count=4 → 2 named + 2 phantom = 4 × hpd × 5 hours/week
    const rt: SchedulerResourceType = {
      id: 'rt1', name: 'Dev', count: 4, hoursPerDay: 8,
      namedResources: [
        { id: 'nr1', name: 'Alice', startWeek: 0, endWeek: null, allocationPct: 100, allocationMode: 'FULL_PROJECT', allocationPercent: 100, allocationStartWeek: null, allocationEndWeek: null },
        { id: 'nr2', name: 'Bob',   startWeek: 0, endWeek: null, allocationPct: 100, allocationMode: 'FULL_PROJECT', allocationPercent: 100, allocationStartWeek: null, allocationEndWeek: null },
      ],
    }
    expect(getWeeklyCapacity(rt, 0, 8)).toBe(4 * 8 * 5)
  })

  it('count < namedResources.length: phantom slots clamp at 0; all named still contribute', () => {
    // 3 named @ 100%, count=2 → no negative phantom; capacity = 3 named × hpd × 5
    const rt: SchedulerResourceType = {
      id: 'rt1', name: 'Dev', count: 2, hoursPerDay: 8,
      namedResources: [
        { id: 'nr1', name: 'Alice',   startWeek: 0, endWeek: null, allocationPct: 100, allocationMode: 'FULL_PROJECT', allocationPercent: 100, allocationStartWeek: null, allocationEndWeek: null },
        { id: 'nr2', name: 'Bob',     startWeek: 0, endWeek: null, allocationPct: 100, allocationMode: 'FULL_PROJECT', allocationPercent: 100, allocationStartWeek: null, allocationEndWeek: null },
        { id: 'nr3', name: 'Charlie', startWeek: 0, endWeek: null, allocationPct: 100, allocationMode: 'FULL_PROJECT', allocationPercent: 100, allocationStartWeek: null, allocationEndWeek: null },
      ],
    }
    expect(getWeeklyCapacity(rt, 0, 8)).toBe(3 * 8 * 5)
  })

  it('mixed allocation: 2 named at 50% + 1 phantom from count=3, hpd=8', () => {
    // Named: 2 × 0.5 × 8 × 5 = 40; Phantom: max(0, 3-2) × 8 × 5 = 40 → total 80
    const rt: SchedulerResourceType = {
      id: 'rt1', name: 'Dev', count: 3, hoursPerDay: 8,
      namedResources: [
        { id: 'nr1', name: 'Alice', startWeek: 0, endWeek: null, allocationPct: 50, allocationMode: 'FULL_PROJECT', allocationPercent: 50, allocationStartWeek: null, allocationEndWeek: null },
        { id: 'nr2', name: 'Bob',   startWeek: 0, endWeek: null, allocationPct: 50, allocationMode: 'FULL_PROJECT', allocationPercent: 50, allocationStartWeek: null, allocationEndWeek: null },
      ],
    }
    expect(getWeeklyCapacity(rt, 0, 8)).toBe(80)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// runScheduler tests
// ─────────────────────────────────────────────────────────────────────────────

describe('runScheduler', () => {
  // ── Happy path ──────────────────────────────────────────────────────────────
  it('single epic, single feature, single task → schedules at week 0', () => {
    const rt = makeRt('rt1', 'Dev', 1)
    const story = makeStory('s1', [makeTask(40, 'rt1', 'Dev')])  // 40h = 5 days = 1 week
    const feature = makeFeature('f1', [story])
    const epic = makeEpic('e1', [feature])

    const result = runScheduler(baseInput({ epics: [epic], resourceTypes: [rt] }))

    const fEntry = result.featureSchedule.find(e => e.featureId === 'f1')
    expect(fEntry).toBeDefined()
    expect(fEntry!.startWeek).toBe(0)
    expect(fEntry!.durationWeeks).toBeCloseTo(1, 1)
    expect(fEntry!.isManual).toBe(false)

    const sEntry = result.storySchedule.find(e => e.storyId === 's1')
    expect(sEntry).toBeDefined()
    expect(sEntry!.startWeek).toBe(0)
    expect(sEntry!.isManual).toBe(false)
  })

  // ── Parallel features ───────────────────────────────────────────────────────
  it('parallel featureMode: both features start at the same week', () => {
    const rt = makeRt('rt1', 'Dev', 2)
    const f1 = makeFeature('f1', [makeStory('s1', [makeTask(40, 'rt1', 'Dev')])], 0)
    const f2 = makeFeature('f2', [makeStory('s2', [makeTask(40, 'rt1', 'Dev')])], 1)
    const epic = makeEpic('e1', [f1, f2], { featureMode: 'parallel' })

    const result = runScheduler(baseInput({ epics: [epic], resourceTypes: [rt] }))

    const sw1 = result.featureSchedule.find(e => e.featureId === 'f1')!.startWeek
    const sw2 = result.featureSchedule.find(e => e.featureId === 'f2')!.startWeek
    expect(sw1).toBe(sw2)  // both start at week 0 in parallel mode
  })

  // ── Sequential features ─────────────────────────────────────────────────────
  it('sequential featureMode: feature 2 starts after feature 1 finishes', () => {
    const rt = makeRt('rt1', 'Dev', 1)
    const f1 = makeFeature('f1', [makeStory('s1', [makeTask(40, 'rt1', 'Dev')])], 0)
    const f2 = makeFeature('f2', [makeStory('s2', [makeTask(40, 'rt1', 'Dev')])], 1)
    const epic = makeEpic('e1', [f1, f2], { featureMode: 'sequential' })

    const result = runScheduler(baseInput({ epics: [epic], resourceTypes: [rt] }))

    const e1 = result.featureSchedule.find(e => e.featureId === 'f1')!
    const e2 = result.featureSchedule.find(e => e.featureId === 'f2')!
    expect(e2.startWeek).toBeCloseTo(e1.startWeek + e1.durationWeeks, 5)
  })

  // ── Epic dependency ─────────────────────────────────────────────────────────
  it('epicDependency: dependent epic starts after parent finishes', () => {
    const rt = makeRt('rt1', 'Dev', 1)
    const f1 = makeFeature('f1', [makeStory('s1', [makeTask(40, 'rt1', 'Dev')])])
    const f2 = makeFeature('f2', [makeStory('s2', [makeTask(40, 'rt1', 'Dev')])])
    const epicA = makeEpic('epicA', [f1], { order: 0 })
    const epicB = makeEpic('epicB', [f2], { order: 1 })

    const result = runScheduler(baseInput({
      epics: [epicA, epicB],
      resourceTypes: [rt],
      epicDeps: [{ epicId: 'epicB', dependsOnId: 'epicA' }],
    }))

    const eA = result.featureSchedule.find(e => e.featureId === 'f1')!
    const eB = result.featureSchedule.find(e => e.featureId === 'f2')!
    expect(eB.startWeek).toBeGreaterThanOrEqual(eA.startWeek + eA.durationWeeks - 0.001)
  })

  // ── Resource constraint ─────────────────────────────────────────────────────
  it('resource-level=true, count=1: single RT serialises features even in parallel epic', () => {
    const rt = makeRt('rt1', 'Dev', 1)  // only 1 developer
    const f1 = makeFeature('f1', [makeStory('s1', [makeTask(40, 'rt1', 'Dev')])], 0)
    const f2 = makeFeature('f2', [makeStory('s2', [makeTask(40, 'rt1', 'Dev')])], 1)
    const epic = makeEpic('e1', [f1, f2], { featureMode: 'parallel' })

    const result = runScheduler(baseInput({
      epics: [epic],
      resourceTypes: [rt],
      resourceLevel: true,
    }))

    const e1 = result.featureSchedule.find(e => e.featureId === 'f1')!
    const e2 = result.featureSchedule.find(e => e.featureId === 'f2')!
    // With 1 Dev, features cannot truly run in parallel — total duration must be ~2 weeks
    const totalDuration = Math.max(e1.startWeek + e1.durationWeeks, e2.startWeek + e2.durationWeeks)
    expect(totalDuration).toBeGreaterThanOrEqual(1.8)  // at least ~2 weeks
    expect(result.weeklyConsumptionMap.size).toBeGreaterThan(0)  // consumption tracked
  })

  // ── Named resource start/end constraint ─────────────────────────────────────
  it('named resource with startWeek=2: feature cannot start before week 2', () => {
    const rt: SchedulerResourceType = {
      id: 'rt1', name: 'Dev', count: 1, hoursPerDay: 8,
      namedResources: [
        { id: 'nr1', name: 'Alice', startWeek: 2, endWeek: null, allocationPct: 100, allocationMode: 'TIMELINE', allocationPercent: 100, allocationStartWeek: 2, allocationEndWeek: null },
      ],
    }
    const f1 = makeFeature('f1', [makeStory('s1', [makeTask(40, 'rt1', 'Dev')])])
    const epic = makeEpic('e1', [f1])

    const result = runScheduler(baseInput({
      epics: [epic],
      resourceTypes: [rt],
      resourceLevel: true,
    }))

    const entry = result.featureSchedule.find(e => e.featureId === 'f1')!
    // Feature must wait until the named resource is available (week 2)
    expect(entry.startWeek).toBeGreaterThanOrEqual(2)
  })

  // ── Manual override on a story ───────────────────────────────────────────────
  it('manual story override: story keeps its pinned startWeek, isManual=true', () => {
    const rt = makeRt('rt1', 'Dev', 1)
    const story = makeStory('s1', [makeTask(40, 'rt1', 'Dev')])
    const feature = makeFeature('f1', [story])
    const epic = makeEpic('e1', [feature])

    const result = runScheduler(baseInput({
      epics: [epic],
      resourceTypes: [rt],
      manualStoryEntries: [{ storyId: 's1', startWeek: 5 }],
    }))

    const sEntry = result.storySchedule.find(e => e.storyId === 's1')!
    expect(sEntry.startWeek).toBe(5)
    expect(sEntry.isManual).toBe(true)
  })

  // ── Manual override on a feature ────────────────────────────────────────────
  it('manual feature override: feature keeps its pinned startWeek, isManual=true', () => {
    const rt = makeRt('rt1', 'Dev', 1)
    const feature = makeFeature('f1', [makeStory('s1', [makeTask(40, 'rt1', 'Dev')])])
    const epic = makeEpic('e1', [feature])

    const result = runScheduler(baseInput({
      epics: [epic],
      resourceTypes: [rt],
      manualFeatureEntries: [{ featureId: 'f1', startWeek: 10, durationWeeks: 2 }],
    }))

    const fEntry = result.featureSchedule.find(e => e.featureId === 'f1')!
    expect(fEntry.startWeek).toBe(10)
    expect(fEntry.isManual).toBe(true)
  })

  // ── Empty input ──────────────────────────────────────────────────────────────
  it('empty input (no epics): returns empty arrays, no crash', () => {
    const result = runScheduler(baseInput())

    expect(result.featureSchedule).toEqual([])
    expect(result.storySchedule).toEqual([])
    expect(result.parallelWarnings).toEqual([])
    expect(result.weeklyConsumptionMap.size).toBe(0)
  })

  // ── Feature with 0 hours / no tasks ─────────────────────────────────────────
  it('feature with no tasks: scheduled with default 1-week duration, no crash', () => {
    const f1 = makeFeature('f1', [makeStory('s1', [])])  // story with no tasks
    const epic = makeEpic('e1', [f1])

    const result = runScheduler(baseInput({ epics: [epic] }))

    const fEntry = result.featureSchedule.find(e => e.featureId === 'f1')
    expect(fEntry).toBeDefined()
    expect(fEntry!.durationWeeks).toBeGreaterThanOrEqual(0.2)
    // Story has 0 hours: still gets an entry (proportional of 0 gets safeDur=0.2)
    const sEntry = result.storySchedule.find(e => e.storyId === 's1')
    expect(sEntry).toBeDefined()
  })

  // ── Feature with explicitly 0 tasks (empty story list) ──────────────────────
  it('feature with empty userStories array: scheduled with default duration', () => {
    const f1 = makeFeature('f1', [])  // no stories at all
    const epic = makeEpic('e1', [f1])

    const result = runScheduler(baseInput({ epics: [epic] }))

    const fEntry = result.featureSchedule.find(e => e.featureId === 'f1')
    expect(fEntry).toBeDefined()
    expect(fEntry!.startWeek).toBe(0)
    // featureDurationWeeks returns 1 when allTasks is empty
    expect(fEntry!.durationWeeks).toBe(1)
  })

  // ── Explicit feature dependency ──────────────────────────────────────────────
  it('explicit featureDependency: f2 starts after f1 even in parallel epic', () => {
    const rt = makeRt('rt1', 'Dev', 2)
    const f1 = makeFeature('f1', [makeStory('s1', [makeTask(40, 'rt1', 'Dev')])], 0)
    // f2 explicitly depends on f1
    const f2 = makeFeature('f2', [makeStory('s2', [makeTask(40, 'rt1', 'Dev')])], 1, [
      { featureId: 'f2', dependsOnId: 'f1' },
    ])
    const epic = makeEpic('e1', [f1, f2], { featureMode: 'parallel' })

    const result = runScheduler(baseInput({ epics: [epic], resourceTypes: [rt] }))

    const e1 = result.featureSchedule.find(e => e.featureId === 'f1')!
    const e2 = result.featureSchedule.find(e => e.featureId === 'f2')!
    expect(e2.startWeek).toBeGreaterThanOrEqual(e1.startWeek + e1.durationWeeks - 0.001)
  })

  // ── Two epics sequential (default) ──────────────────────────────────────────
  it('two sequential epics: epic 2 starts after epic 1 completes', () => {
    const rt = makeRt('rt1', 'Dev', 1)
    const f1 = makeFeature('f1', [makeStory('s1', [makeTask(40, 'rt1', 'Dev')])])
    const f2 = makeFeature('f2', [makeStory('s2', [makeTask(40, 'rt1', 'Dev')])])
    const epic1 = makeEpic('e1', [f1], { order: 0 })
    const epic2 = makeEpic('e2', [f2], { order: 1 })

    const result = runScheduler(baseInput({ epics: [epic1, epic2], resourceTypes: [rt] }))

    const e1 = result.featureSchedule.find(e => e.featureId === 'f1')!
    const e2 = result.featureSchedule.find(e => e.featureId === 'f2')!
    expect(e2.startWeek).toBeGreaterThanOrEqual(e1.startWeek + e1.durationWeeks - 0.001)
  })

  // ── Parallel warnings ────────────────────────────────────────────────────────
  it('parallel epic with shared RT: floor extends feature durations instead of warning', () => {
    // With the demand floor, the scheduler extends feature durations to accommodate
    // shared resource contention rather than generating a warning.
    const rt = makeRt('rt1', 'Dev', 1)  // only 1 dev
    // Two features in a parallel epic: total demand = 5+5 = 10 days @ count=1
    // floor = 10/(1×5) = 2 weeks; individual = 1 week → floored to 2 weeks
    const f1 = makeFeature('f1', [makeStory('s1', [makeTask(40, 'rt1', 'Dev')])], 0)
    const f2 = makeFeature('f2', [makeStory('s2', [makeTask(40, 'rt1', 'Dev')])], 1)
    const epic = makeEpic('e1', [f1, f2], { featureMode: 'parallel' })

    const result = runScheduler(baseInput({ epics: [epic], resourceTypes: [rt] }))

    // Floor ensures each feature is at least 2 weeks
    for (const entry of result.featureSchedule) {
      expect(entry.durationWeeks).toBeGreaterThanOrEqual(2)
    }
    // No parallel warning because floor guarantees capacity ≥ demand
    expect(result.parallelWarnings.length).toBe(0)
  })

  // ── Parallel warnings honour count beyond namedResources (Bug 1 follow-up) ─
  it('computeParallelWarnings: increasing count past namedResources.length reduces capacity shortfall', () => {
    // Build inputs for computeParallelWarnings directly so we control the span.
    const taskRT = { id: 'rt1', name: 'Dev', hoursPerDay: 8 }
    const allFeatures = [
      { id: 'f1', userStories: [{ isActive: null as boolean | null, tasks: [{ resourceTypeId: 'rt1', resourceType: taskRT, hoursEffort: 40, durationDays: null as number | null }] }] },
      { id: 'f2', userStories: [{ isActive: null as boolean | null, tasks: [{ resourceTypeId: 'rt1', resourceType: taskRT, hoursEffort: 40, durationDays: null as number | null }] }] },
    ]
    // Both features run in parallel from week 0 to week 1 (1-week span pinned).
    const epicMeta = { id: 'e1', name: 'e1', featureMode: 'parallel' }
    const entries = [
      { featureId: 'f1', startWeek: 0, durationWeeks: 1, feature: { epic: epicMeta } },
      { featureId: 'f2', startWeek: 0, durationWeeks: 1, feature: { epic: epicMeta } },
    ]

    // 1 named resource only, count=1 → capacity = 1 × 8 × 5 = 40h = 5 days over 1-week span.
    // Demand = 10 days → warning expected.
    const tightRt: SchedulerResourceType = {
      id: 'rt1', name: 'Dev', count: 1, hoursPerDay: 8,
      namedResources: [
        { id: 'nr1', name: 'Alice', startWeek: 0, endWeek: null, allocationPct: 100, allocationMode: 'FULL_PROJECT', allocationPercent: 100, allocationStartWeek: null, allocationEndWeek: null },
      ],
    }
    const tightWarnings = computeParallelWarnings(8, entries, allFeatures, [tightRt])
    expect(tightWarnings.length).toBe(1)
    expect(tightWarnings[0].demandDays).toBe(10)
    expect(tightWarnings[0].capacityDays).toBe(5)

    // Same RT, count=2 → 1 named + 1 phantom → 80h/week = 10 days over span. Demand = 10 days. No warning.
    const widerRt: SchedulerResourceType = { ...tightRt, count: 2 }
    expect(getWeeklyCapacity(widerRt, 0, 8)).toBe(80)
    const widerWarnings = computeParallelWarnings(8, entries, allFeatures, [widerRt])
    expect(widerWarnings.length).toBe(0)
  })

  it('computeParallelWarnings: ignores floating-point residue when demand matches partial-week capacity', () => {
    const taskRT = { id: 'rt-security', name: 'Security', hoursPerDay: 8 }
    const allFeatures = [
      { id: 'f1', userStories: [{ isActive: true as boolean | null, tasks: [{ resourceTypeId: 'rt-security', resourceType: taskRT, hoursEffort: 78, durationDays: null as number | null }] }] },
      { id: 'f2', userStories: [{ isActive: true as boolean | null, tasks: [{ resourceTypeId: 'rt-security', resourceType: taskRT, hoursEffort: 78, durationDays: null as number | null }] }] },
    ]
    const epicMeta = { id: 'e-security', name: 'Security', featureMode: 'parallel' }
    const entries = [
      { featureId: 'f1', startWeek: 14.8, durationWeeks: 7.8, feature: { epic: epicMeta } },
      { featureId: 'f2', startWeek: 14.8, durationWeeks: 7.8, feature: { epic: epicMeta } },
    ]
    const rt: SchedulerResourceType = {
      id: 'rt-security',
      name: 'Security',
      count: 1,
      hoursPerDay: 8,
      namedResources: [
        {
          id: 'nr-security',
          name: 'Principal Consultant - Security',
          startWeek: 0,
          endWeek: null,
          allocationPct: 100,
          allocationMode: 'FULL_PROJECT',
          allocationPercent: 50,
          allocationStartWeek: null,
          allocationEndWeek: null,
        },
      ],
    }

    const warnings = computeParallelWarnings(8, entries, allFeatures, [rt])

    expect(warnings).toEqual([])
  })

  // ── Resource-levelling: consumption map populated ────────────────────────────
  it('resourceLevel=true: weeklyConsumptionMap is populated', () => {
    const rt = makeRt('rt1', 'Dev', 1)
    const feature = makeFeature('f1', [makeStory('s1', [makeTask(40, 'rt1', 'Dev')])])
    const epic = makeEpic('e1', [feature])

    const result = runScheduler(baseInput({
      epics: [epic],
      resourceTypes: [rt],
      resourceLevel: true,
    }))

    expect(result.weeklyConsumptionMap.size).toBeGreaterThan(0)
    const totalDays = [...result.weeklyConsumptionMap.values()].reduce((a, b) => a + b, 0)
    expect(totalDays).toBeCloseTo(5, 0)  // 40h / 8hpd = 5 days
  })

  it('resourceLevel=true: small feature finishes promptly regardless of feature iteration order', () => {
    // Large feature A (152h) and small feature B (8h) compete for the same RT.
    // The small feature must finish within 1-2 weeks even when it appears
    // after the large feature in the input array.
    function runScenario(featureA: ReturnType<typeof makeFeature>, featureB: ReturnType<typeof makeFeature>) {
      const rt = makeRt('rt1', 'Dev', 1)
      const epic = makeEpic('e1', [featureA, featureB], { featureMode: 'parallel' })
      return runScheduler(baseInput({ epics: [epic], resourceTypes: [rt], resourceLevel: true }))
    }

    const fLarge = makeFeature('f-large', [makeStory('sA', [makeTask(152, 'rt1', 'Dev')])])
    const fSmall = makeFeature('f-small', [makeStory('sB', [makeTask(8, 'rt1', 'Dev')])])

    // Run with small feature first, then reversed
    const resultForward = runScenario(fLarge, fSmall)
    const resultReversed = runScenario(fSmall, fLarge)

    for (const result of [resultForward, resultReversed]) {
      // Small feature must finish within 2 weeks regardless of input order
      const entrySmall = result.featureSchedule.find(e => e.featureId === 'f-small')
      expect(entrySmall).toBeDefined()
      expect(entrySmall!.durationWeeks).toBeLessThanOrEqual(2)

      // Large feature must have the same duration in both orderings (±1 week tolerance)
      const entryLarge = result.featureSchedule.find(e => e.featureId === 'f-large')
      expect(entryLarge).toBeDefined()
    }

    // Both orderings must produce the same large-feature schedule (within tolerance)
    const largeFwd = resultForward.featureSchedule.find(e => e.featureId === 'f-large')!
    const largeRev = resultReversed.featureSchedule.find(e => e.featureId === 'f-large')!
    expect(Math.abs(largeFwd.startWeek - largeRev.startWeek)).toBeLessThanOrEqual(1)
    expect(Math.abs(largeFwd.durationWeeks - largeRev.durationWeeks)).toBeLessThanOrEqual(1)

    // Total allocated days unchanged in both orderings
    for (const result of [resultForward, resultReversed]) {
      const totalDays = [...result.weeklyConsumptionMap.values()].reduce((a, b) => a + b, 0)
      expect(totalDays).toBeCloseTo(20, 0)
    }
  })

  it('resourceLevel=true: multiple small competing features do not exceed step capacity', () => {
    // Three parallel features each with 4h on a single-resource RT.
    // Capacity per step = 8h/day × 5 days/week × 0.2 step = 8h per step.
    // Greedy smallest-first allocation must not let the sum exceed capacity.
    const rt = makeRt('rt1', 'Dev', 1)
    const f1 = makeFeature('f1', [makeStory('s1', [makeTask(4, 'rt1', 'Dev')])])
    const f2 = makeFeature('f2', [makeStory('s2', [makeTask(4, 'rt1', 'Dev')])])
    const f3 = makeFeature('f3', [makeStory('s3', [makeTask(4, 'rt1', 'Dev')])])
    const epic = makeEpic('e1', [f1, f2, f3], { featureMode: 'parallel' })

    const result = runScheduler(baseInput({
      epics: [epic],
      resourceTypes: [rt],
      resourceLevel: true,
    }))

    const byWeek = new Map<number, number>()
    for (const [key, days] of result.weeklyConsumptionMap) {
      const sep = key.lastIndexOf('|')
      const week = parseInt(key.substring(sep + 1), 10)
      byWeek.set(week, (byWeek.get(week) ?? 0) + days)
    }
    for (const [, days] of byWeek) {
      expect(days).toBeLessThanOrEqual(5 + 0.01)
    }

    // Total = 12h / 8hpd = 1.5 days
    const totalDays = [...result.weeklyConsumptionMap.values()].reduce((a, b) => a + b, 0)
    expect(totalDays).toBeCloseTo(1.5, 1)

    // All three features finish within 2 weeks
    for (const fId of ['f1', 'f2', 'f3']) {
      const entry = result.featureSchedule.find(e => e.featureId === fId)
      expect(entry).toBeDefined()
      expect(entry!.durationWeeks).toBeLessThanOrEqual(2)
    }
  })

  // ── Cross-epic dep anti-cycle (hasCrossEpicDep skip logic) ──────────────────
  it('hasCrossEpicDep: skips inter-epic chaining edge to avoid cycle, both features scheduled', () => {
    const rt = makeRt('rt1', 'Dev', 1)
    // fA (in epicA) explicitly depends on fB (in epicB).
    // Without the hasCrossEpicDep guard the inter-epic chain would add fA→fB
    // while the explicit dep adds fB→fA, creating a cycle.
    const fB = makeFeature('fB', [makeStory('sB', [makeTask(40, 'rt1', 'Dev')])], 0)
    const fA = makeFeature(
      'fA',
      [makeStory('sA', [makeTask(40, 'rt1', 'Dev')])],
      0,
      [{ featureId: 'fA', dependsOnId: 'fB' }], // fA depends on fB
    )
    const epicA = makeEpic('epicA', [fA], { order: 0 })
    const epicB = makeEpic('epicB', [fB], { order: 1 })

    // Should complete without an infinite loop or thrown error
    const result = runScheduler(baseInput({ epics: [epicA, epicB], resourceTypes: [rt] }))

    const entryA = result.featureSchedule.find(e => e.featureId === 'fA')
    const entryB = result.featureSchedule.find(e => e.featureId === 'fB')
    expect(entryA).toBeDefined()
    expect(entryB).toBeDefined()
    // fA depends on fB so fA must start no earlier than fB finishes
    expect(entryA!.startWeek).toBeGreaterThanOrEqual(entryB!.startWeek + entryB!.durationWeeks - 0.001)
  })

  // ── Epic timelineStartWeek anchor ────────────────────────────────────────────
  it('timelineStartWeek: epic2 feature starts at the pinned week regardless of epic1 end', () => {
    const rt = makeRt('rt1', 'Dev', 1)
    const f1 = makeFeature('f1', [makeStory('s1', [makeTask(40, 'rt1', 'Dev')])])
    const f2 = makeFeature('f2', [makeStory('s2', [makeTask(40, 'rt1', 'Dev')])])
    const epic1 = makeEpic('e1', [f1], { order: 0 })
    const epic2 = makeEpic('e2', [f2], { order: 1, timelineStartWeek: 5 })

    const result = runScheduler(baseInput({ epics: [epic1, epic2], resourceTypes: [rt] }))

    const entry2 = result.featureSchedule.find(e => e.featureId === 'f2')!
    // The timelineStartWeek anchor must be respected; inter-epic chaining is skipped
    expect(entry2.startWeek).toBe(5)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Sequential story-phase scheduling (#394)
// ─────────────────────────────────────────────────────────────────────────────

describe('sequential story phases', () => {
  it('stories with different resource types do not overlap within a feature', () => {
    // Story 1: 40 Dev hours (5 days → 1 week)
    // Story 2: 40 QA hours (5 days → 1 week)
    // Sequential phases → feature = 2 weeks, story 1 starts week 0, story 2 starts week 1
    const dev = makeRt('rt-dev', 'Dev', 1, 8)
    const qa = makeRt('rt-qa', 'QA', 1, 8)
    const s1 = makeStory('s1', [makeTask(40, 'rt-dev', 'Dev')], 0)
    const s2 = makeStory('s2', [makeTask(40, 'rt-qa', 'QA')], 1)
    const f1 = makeFeature('f1', [s1, s2])
    const epic = makeEpic('ep1', [f1])
    const result = runScheduler(baseInput({ epics: [epic], resourceTypes: [dev, qa] }))

    const featureEntry = result.featureSchedule.find(e => e.featureId === 'f1')!
    expect(featureEntry.durationWeeks).toBeCloseTo(2, 1)
    expect(featureEntry.startWeek).toBe(0)

    const bar1 = result.storySchedule.find(s => s.storyId === 's1')!
    const bar2 = result.storySchedule.find(s => s.storyId === 's2')!
    expect(bar1.startWeek).toBe(0)
    expect(bar1.durationWeeks).toBeCloseTo(1, 1)
    expect(bar2.startWeek).toBeGreaterThanOrEqual(bar1.startWeek + bar1.durationWeeks - 0.01)
    expect(bar2.durationWeeks).toBeCloseTo(1, 1)
  })

  it('within-story tasks with different RTs overlap (same story start)', () => {
    // Single story with both Dev (40h) and QA (40h) tasks
    // Both run concurrently within the same story phase
    // Bottleneck: 5 days → 1 week
    const dev = makeRt('rt-dev', 'Dev', 1, 8)
    const qa = makeRt('rt-qa', 'QA', 1, 8)
    const s1 = makeStory('s1', [
      makeTask(40, 'rt-dev', 'Dev'),
      makeTask(40, 'rt-qa', 'QA'),
    ], 0)
    const f1 = makeFeature('f1', [s1])
    const epic = makeEpic('ep1', [f1])
    const result = runScheduler(baseInput({ epics: [epic], resourceTypes: [dev, qa] }))

    const bar = result.storySchedule.find(s => s.storyId === 's1')!
    expect(bar.durationWeeks).toBeCloseTo(1, 1)
    expect(bar.startWeek).toBe(0)
  })

  it('feature duration equals sum of story-phase bottleneck weeks', () => {
    // Story 1: 80 Dev hours (10 days → 2 weeks bottleneck)
    // Story 2: 40 QA hours (5 days → 1 week bottleneck)
    // Sequential phases → feature = 3 weeks
    const dev = makeRt('rt-dev', 'Dev', 1, 8)
    const qa = makeRt('rt-qa', 'QA', 1, 8)
    const s1 = makeStory('s1', [makeTask(80, 'rt-dev', 'Dev')], 0)
    const s2 = makeStory('s2', [makeTask(40, 'rt-qa', 'QA')], 1)
    const f1 = makeFeature('f1', [s1, s2])
    const epic = makeEpic('ep1', [f1])
    const result = runScheduler(baseInput({ epics: [epic], resourceTypes: [dev, qa] }))

    const featureEntry = result.featureSchedule.find(e => e.featureId === 'f1')!
    expect(featureEntry.durationWeeks).toBeCloseTo(3, 1)
  })

  it('parallel epic features are unaffected by story-phase ordering', () => {
    // Two features in a parallel epic, each with 2 stories
    // Parallel epic means features run simultaneously
    // Story phasing only affects intra-feature ordering
    const dev = makeRt('rt-dev', 'Dev', 1, 8)
    const f1 = makeFeature('f1', [
      makeStory('s1a', [makeTask(40, 'rt-dev', 'Dev')], 0),
      makeStory('s1b', [makeTask(40, 'rt-dev', 'Dev')], 1),
    ])
    const f2 = makeFeature('f2', [
      makeStory('s2a', [makeTask(40, 'rt-dev', 'Dev')], 0),
      makeStory('s2b', [makeTask(40, 'rt-dev', 'Dev')], 1),
    ])
    const epic = makeEpic('ep1', [f1, f2], { featureMode: 'parallel' })
    const result = runScheduler(baseInput({ epics: [epic], resourceTypes: [dev] }))

    // Both features start at week 0 (parallel)
    const entry1 = result.featureSchedule.find(e => e.featureId === 'f1')!
    const entry2 = result.featureSchedule.find(e => e.featureId === 'f2')!
    expect(entry1.startWeek).toBe(0)
    expect(entry2.startWeek).toBe(0)
    // Parallel demand floor: total demand = 160h = 20 person-days over 1 Dev (5d/wk)
    // MinSpan = 20/5 = 4 weeks. Feature duration = max(2, 4) = 4 weeks.
    expect(entry1.durationWeeks).toBeCloseTo(4, 1)
    expect(entry2.durationWeeks).toBeCloseTo(4, 1)
  })

  it('resource levelling preserves story-phase ordering under genuine capacity contention', () => {
    // Two features in a PARALLEL epic share one Dev (count=1).
    // Feature 1: f1s1 (80 Dev hours = ~2 wk), f1s2 (80 Dev hours = ~2 wk)
    // Feature 2: f2s1 (40 Dev hours = ~1 wk), f2s2 (40 Dev hours = ~1 wk)
    // With resourceLevel=true and parallel epic, both features are eligible
    // concurrently and compete for the same Dev capacity.
    const dev = makeRt('rt-dev', 'Dev', 1, 8)

    const f1 = makeFeature('f1', [
      makeStory('f1s1', [makeTask(80, 'rt-dev', 'Dev')], 0),
      makeStory('f1s2', [makeTask(80, 'rt-dev', 'Dev')], 1),
    ])
    const f2 = makeFeature('f2', [
      makeStory('f2s1', [makeTask(40, 'rt-dev', 'Dev')], 0),
      makeStory('f2s2', [makeTask(40, 'rt-dev', 'Dev')], 1),
    ])
    const epic = makeEpic('ep1', [f1, f2], { featureMode: 'parallel' })
    const result = runScheduler(baseInput({
      epics: [epic],
      resourceTypes: [dev],
      resourceLevel: true,
    }))

    const f1s1 = result.storySchedule.find(s => s.storyId === 'f1s1')!
    const f1s2 = result.storySchedule.find(s => s.storyId === 'f1s2')!
    const f2s1 = result.storySchedule.find(s => s.storyId === 'f2s1')!
    const f2s2 = result.storySchedule.find(s => s.storyId === 'f2s2')!

    // Both features in a parallel epic start concurrently (week 0)
    const f1Entry = result.featureSchedule.find(e => e.featureId === 'f1')!
    const f2Entry = result.featureSchedule.find(e => e.featureId === 'f2')!
    expect(f1Entry.startWeek).toBe(0)
    expect(f2Entry.startWeek).toBe(0)

    // Each feature's stories are sequential (start week increases)
    expect(f1s2.startWeek).toBeGreaterThanOrEqual(f1s1.startWeek + f1s1.durationWeeks - 0.01)
    expect(f2s2.startWeek).toBeGreaterThanOrEqual(f2s1.startWeek + f2s1.durationWeeks - 0.01)

    // No story from feature 2 precedes the previous phase within feature 2
    // (intra-feature ordering is preserved regardless of inter-feature contention)
  })

  it('empty feature with one taskless story retains 1-week default', () => {
    const dev = makeRt('rt-dev', 'Dev', 1, 8)
    const s1 = makeStory('s1', [], 0)
    const f1 = makeFeature('f1', [s1])
    const epic = makeEpic('ep1', [f1])
    const result = runScheduler(baseInput({ epics: [epic], resourceTypes: [dev] }))
    const entry = result.featureSchedule.find(e => e.featureId === 'f1')!
    expect(entry.durationWeeks).toBeCloseTo(1, 1)
  })

  it('empty feature with multiple taskless stories retains 1-week default', () => {
    const dev = makeRt('rt-dev', 'Dev', 1, 8)
    const s1 = makeStory('s1', [], 0)
    const s2 = makeStory('s2', [], 1)
    const s3 = makeStory('s3', [], 2)
    const f1 = makeFeature('f1', [s1, s2, s3])
    const epic = makeEpic('ep1', [f1])
    const result = runScheduler(baseInput({ epics: [epic], resourceTypes: [dev] }))
    const entry = result.featureSchedule.find(e => e.featureId === 'f1')!
    // Number of empty stories does not stretch feature duration
    expect(entry.durationWeeks).toBeCloseTo(1, 1)
  })

  it('manually pinned story is not consumed as an automatic phase', () => {
    // Story 1 is manual (pinned at week 0), story 2 is automatic
    // The automatic phase should only include story 2's duration.
    // Feature duration should be story 2's bottleneck (1 week), plus the
    // manual story's existence should not affect automatic duration.
    const dev = makeRt('rt-dev', 'Dev', 1, 8)
    const s1 = makeStory('s1', [makeTask(80, 'rt-dev', 'Dev')], 0)  // manual
    const s2 = makeStory('s2', [makeTask(40, 'rt-dev', 'Dev')], 1)  // auto
    const f1 = makeFeature('f1', [s1, s2])
    const epic = makeEpic('ep1', [f1])
    const result = runScheduler(baseInput({
      epics: [epic],
      resourceTypes: [dev],
      manualStoryEntries: [{ storyId: 's1', startWeek: 0 }],
    }))

    const featureEntry = result.featureSchedule.find(e => e.featureId === 'f1')!
    // Automatic phase is only story 2 (1 week bottleneck), so feature = ~1 week
    // Manual story does not extend or shrink automatic duration
    expect(featureEntry.durationWeeks).toBeCloseTo(1, 1)

    const s1Bar = result.storySchedule.find(s => s.storyId === 's1')!
    expect(s1Bar.startWeek).toBe(0)
    expect(s1Bar.isManual).toBe(true)

    const s2Bar = result.storySchedule.find(s => s.storyId === 's2')!
    expect(s2Bar.startWeek).toBe(0)
    expect(s2Bar.isManual).toBe(false)
  })

  it('non-levelled does not emit partial pinned-only cache', () => {
    // Pinned and automatic stories share the same resource type (Dev).
    // Non-levelled must NOT produce a partial scheduler cache that would
    // suppress fallback demand for the automatic portion downstream.
    const dev = makeRt('rt-dev', 'Dev', 1, 8)
    const s1 = makeStory('s1', [makeTask(40, 'rt-dev', 'Dev')], 0)
    const s2 = makeStory('s2', [makeTask(40, 'rt-dev', 'Dev')], 1)
    const f1 = makeFeature('f1', [s1, s2])
    const epic = makeEpic('ep1', [f1])
    const result = runScheduler(baseInput({
      epics: [epic],
      resourceTypes: [dev],
      manualStoryEntries: [{ storyId: 's1', startWeek: 0 }],
    }))
    expect(result.weeklyConsumptionMap.size).toBe(0)
  })

  it('pinned story demand appears in weeklyConsumptionMap (resource-levelled)', () => {
    const dev = makeRt('rt-dev', 'Dev', 1, 8)
    const qa = makeRt('rt-qa', 'QA', 1, 8)
    const s1 = makeStory('s1', [makeTask(40, 'rt-dev', 'Dev')], 0)
    const s2 = makeStory('s2', [makeTask(40, 'rt-qa', 'QA')], 1)
    const f1 = makeFeature('f1', [s1, s2])
    const epic = makeEpic('ep1', [f1])
    const result = runScheduler(baseInput({
      epics: [epic],
      resourceTypes: [dev, qa],
      manualStoryEntries: [{ storyId: 's1', startWeek: 0 }],
      resourceLevel: true,
    }))

    const devTotal = [...result.weeklyConsumptionMap.entries()]
      .filter(([k]) => k.startsWith('rt-dev|'))
      .reduce((sum, [, v]) => sum + v, 0)
    expect(devTotal).toBeCloseTo(5.0, 1)

    const qaTotal = [...result.weeklyConsumptionMap.entries()]
      .filter(([k]) => k.startsWith('rt-qa|'))
      .reduce((sum, [, v]) => sum + v, 0)
    expect(qaTotal).toBeCloseTo(5.0, 1)
  })

  it('pinned demand reserves capacity; auto story does not consume pinned slot', () => {
    // One Dev (count=1), one feature: s1 manual (80h), s2 auto (80h), same RT
    // Pinned s1 at week 0 consumes all Dev capacity for ~2 weeks.
    // Auto s2 must wait until pinned story completes.
    const dev = makeRt('rt-dev', 'Dev', 1, 8)
    const s1 = makeStory('s1', [makeTask(80, 'rt-dev', 'Dev')], 0)
    const s2 = makeStory('s2', [makeTask(80, 'rt-dev', 'Dev')], 1)
    const f1 = makeFeature('f1', [s1, s2])
    const epic = makeEpic('ep1', [f1])
    const result = runScheduler(baseInput({
      epics: [epic],
      resourceTypes: [dev],
      manualStoryEntries: [{ storyId: 's1', startWeek: 0 }],
      resourceLevel: true,
    }))

    // Total Dev demand = 160h / 8 = 20 person-days (pinned 10pd + auto 10pd)
    const devTotal = [...result.weeklyConsumptionMap.entries()]
      .filter(([k]) => k.startsWith('rt-dev|'))
      .reduce((sum, [, v]) => sum + v, 0)
    expect(devTotal).toBeCloseTo(20.0, 1)

    // Pinned story bar is at week 0
    const s1Bar = result.storySchedule.find(s => s.storyId === 's1')!
    expect(s1Bar.startWeek).toBe(0)
    expect(s1Bar.isManual).toBe(true)

    // Auto story placement is not distorted by the manual story
    const s2Bar = result.storySchedule.find(s => s.storyId === 's2')!
    expect(s2Bar.isManual).toBe(false)
  })

  it('manual feature + manual story: pinned demand is not double-counted', () => {
    const dev = makeRt('rt-dev', 'Dev', 1, 8)
    const s1 = makeStory('s1', [makeTask(40, 'rt-dev', 'Dev')], 0)
    const f1 = makeFeature('f1', [s1])
    const epic = makeEpic('ep1', [f1])
    const result = runScheduler(baseInput({
      epics: [epic],
      resourceTypes: [dev],
      manualFeatureEntries: [{ featureId: 'f1', startWeek: 0, durationWeeks: 4 }],
      manualStoryEntries: [{ storyId: 's1', startWeek: 0 }],
      resourceLevel: true,
    }))
    const devTotal = [...result.weeklyConsumptionMap.entries()]
      .filter(([k]) => k.startsWith('rt-dev|'))
      .reduce((sum, [, v]) => sum + v, 0)
    expect(devTotal).toBeCloseTo(5.0, 1)
  })

  it('pinned story spans week where auto work is only partially active', () => {
    // Pinned s1 at week 0 with 80 Dev hours → spans weeks 0-1.
    // Auto feature f1 finishes in week 0.1 (< 1 step → still within week 0).
    // Pinned weekly demand for Dev must be the full 5pd, not just the fraction
    // coincident with the auto feature's active simulation steps.
    const dev = makeRt('rt-dev', 'Dev', 1, 8)
    const s1 = makeStory('s1', [makeTask(80, 'rt-dev', 'Dev')], 0)
    const s2 = makeStory('s2', [makeTask(8, 'rt-dev', 'Dev')], 1)
    const f1 = makeFeature('f1', [s1, s2])
    const epic = makeEpic('ep1', [f1])
    const result = runScheduler(baseInput({
      epics: [epic],
      resourceTypes: [dev],
      manualStoryEntries: [{ storyId: 's1', startWeek: 0 }],
      resourceLevel: true,
    }))

    // Pinned Dev: 80h/8hpd = 10 person-days over dur = 80/8/5 = 2 weeks → 5pd/week
    const pinnedDevWeeks = [...result.weeklyConsumptionMap.entries()]
      .filter(([k]) => k.startsWith('rt-dev|'))
      .map(([k, v]) => ({ week: parseInt(k.split('|')[1], 10), days: v }))
      .filter(({ days }) => days > 0)
    // Week 0 should have exactly the pinned share (~5pd) plus any auto share
    const wk0 = pinnedDevWeeks.find(w => w.week === 0)
    expect(wk0).toBeDefined()
    expect(wk0!.days).toBeGreaterThan(4)
  })

  it('pinned-only week with no active automatic features', () => {
    // Single feature with a single pinned story at week 5.
    // No automatic features or stories — pinned demand must still appear.
    const dev = makeRt('rt-dev', 'Dev', 1, 8)
    const s1 = makeStory('s1', [makeTask(40, 'rt-dev', 'Dev')], 0)
    const f1 = makeFeature('f1', [s1])
    const epic = makeEpic('ep1', [f1])
    const result = runScheduler(baseInput({
      epics: [epic],
      resourceTypes: [dev],
      manualStoryEntries: [{ storyId: 's1', startWeek: 5 }],
      resourceLevel: true,
    }))
    // Pinned: 40h/8hpd = 5pd, all in week 5 (pinned story duration = 1 week)
    const devWk5 = [...result.weeklyConsumptionMap.entries()]
      .filter(([k]) => k === 'rt-dev|5')
      .reduce((sum, [, v]) => sum + v, 0)
    expect(devWk5).toBeCloseTo(5.0, 1)
  })
  it('acceptance: 17.5d Security + 5.0d Principal Engineer (non-levelled)', () => {
    const hpd = 7.6
    const security = makeRt('rt-sec', 'Principal Consultant - Security', 1, hpd)
    const engineer = makeRt('rt-pe', 'Principal Engineer - Cloud & DevOps', 1, hpd)
    // 17.5 days of Security effort → 17.5 * 7.6 = 133 hours
    const s1 = makeStory('s1', [makeTask(133, 'rt-sec', 'Principal Consultant - Security', hpd)], 0)
    // 38 hours / 5.0 days of Principal Engineer effort → 38 hours
    const s2 = makeStory('s2', [makeTask(38, 'rt-pe', 'Principal Engineer - Cloud & DevOps', hpd)], 1)
    const f1 = makeFeature('f1', [s1, s2])
    const epic = makeEpic('ep1', [f1])

    const result = runScheduler(baseInput({ epics: [epic], resourceTypes: [security, engineer] }))

    const fEntry = result.featureSchedule.find(e => e.featureId === 'f1')!
    // Feature duration >= 4.5 weeks (17.5d + 5.0d = 22.5 working days / 5 = 4.5 weeks)
    expect(fEntry.durationWeeks).toBeGreaterThanOrEqual(4.5)

    const s1Bar = result.storySchedule.find(s => s.storyId === 's1')!
    const s2Bar = result.storySchedule.find(s => s.storyId === 's2')!

    // Stories follow story order
    expect(s1Bar.startWeek).toBe(0)
    expect(s2Bar.startWeek).toBeGreaterThanOrEqual(s1Bar.startWeek + s1Bar.durationWeeks - 0.01)

    // (weeklyConsumptionMap is only populated with resourceLevel=true,
    //  so total-demand assertions are in the levelled variant below)
    expect(fEntry.durationWeeks).toBeGreaterThanOrEqual(4.5)
  })

  it('acceptance: 17.5d Security + 5.0d Principal Engineer (resource-levelled)', () => {
    const hpd = 7.6
    const security = makeRt('rt-sec', 'Principal Consultant - Security', 1, hpd)
    const engineer = makeRt('rt-pe', 'Principal Engineer - Cloud & DevOps', 1, hpd)

    const s1 = makeStory('s1', [makeTask(133, 'rt-sec', 'Principal Consultant - Security', hpd)], 0)
    const s2 = makeStory('s2', [makeTask(38, 'rt-pe', 'Principal Engineer - Cloud & DevOps', hpd)], 1)
    const f1 = makeFeature('f1', [s1, s2])
    const epic = makeEpic('ep1', [f1])

    const result = runScheduler(baseInput({
      epics: [epic],
      resourceTypes: [security, engineer],
      resourceLevel: true,
    }))

    const fEntry = result.featureSchedule.find(e => e.featureId === 'f1')!
    // Feature duration >= 4.5 weeks
    expect(fEntry.durationWeeks).toBeGreaterThanOrEqual(4.5)

    const s1Bar = result.storySchedule.find(s => s.storyId === 's1')!
    const s2Bar = result.storySchedule.find(s => s.storyId === 's2')!

    // Stories follow story order and do not overlap
    expect(s1Bar.startWeek).toBe(0)
    expect(s2Bar.startWeek).toBeGreaterThanOrEqual(s1Bar.startWeek + s1Bar.durationWeeks - 0.01)

    // Principal Engineer total = exactly 5.0 days
    const peTotal = [...result.weeklyConsumptionMap.entries()]
      .filter(([key]) => key.startsWith('rt-pe|'))
      .reduce((sum, [, days]) => sum + days, 0)
    expect(peTotal).toBeCloseTo(5.0, 1)

    // PE consumption starts only after Security phase completes
    const peWeeks = [...result.weeklyConsumptionMap.entries()]
      .filter(([key]) => key.startsWith('rt-pe|'))
      .map(([key]) => parseInt(key.split('|')[1], 10))
    const minPeWeek = Math.min(...peWeeks)
    const secDoneWeek = Math.floor(s1Bar.startWeek + s1Bar.durationWeeks)
    expect(minPeWeek).toBeGreaterThanOrEqual(secDoneWeek - 1) // within scheduler precision

    // Security total = exactly 17.5 days
    const secTotal = [...result.weeklyConsumptionMap.entries()]
      .filter(([key]) => key.startsWith('rt-sec|'))
      .reduce((sum, [, days]) => sum + days, 0)
    expect(secTotal).toBeCloseTo(17.5, 1)

    // Idempotency: re-running produces the same totals
    const result2 = runScheduler(baseInput({
      epics: [epic],
      resourceTypes: [security, engineer],
      resourceLevel: true,
    }))
    const peTotal2 = [...result2.weeklyConsumptionMap.entries()]
      .filter(([key]) => key.startsWith('rt-pe|'))
      .reduce((sum, [, days]) => sum + days, 0)
    expect(peTotal2).toBeCloseTo(5.0, 1)

    const fEntry2 = result2.featureSchedule.find(e => e.featureId === 'f1')!
    expect(fEntry2.durationWeeks).toBe(fEntry.durationWeeks)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Parallel demand floor tests
// ─────────────────────────────────────────────────────────────────────────────

describe('parallel demand floor', () => {
  it('3 features sharing one RT produce durations floored to the shared demand span', () => {
    // 3 features, each with 30 person-days of effort for rt1 (count=2, hpd=8)
    // Individual duration without floor: 30/2/5 = 3 weeks each
    // Floor: totalDemand=90, weeklyCapacity=2×5=10 days/week → floor=9 weeks
    // Each feature duration should be floored to 9 weeks
    const rt = makeRt('rt1', 'Dev', 2)

    function makeParallelFeature(id: string) {
      // 30 person-days = 30 × 8 = 240 hours
      return makeFeature(id, [makeStory(`s-${id}`, [makeTask(240, 'rt1', 'Dev')])])
    }

    const epic = makeEpic('e1', [
      makeParallelFeature('f1'),
      makeParallelFeature('f2'),
      makeParallelFeature('f3'),
    ], { featureMode: 'parallel' })

    const result = runScheduler(baseInput({ epics: [epic], resourceTypes: [rt] }))

    for (const entry of result.featureSchedule) {
      expect(entry.durationWeeks).toBeGreaterThanOrEqual(9)
    }
    // Epic span (all features run in parallel from same start) should be >= 9 weeks
    const maxEnd = Math.max(...result.featureSchedule.map(e => e.startWeek + e.durationWeeks))
    const minStart = Math.min(...result.featureSchedule.map(e => e.startWeek))
    expect(maxEnd - minStart).toBeGreaterThanOrEqual(9)
  })

  it('higher count reduces the floor proportionally', () => {
    // Same 3×30 person-days setup but count=3
    // Floor: totalDemand=90, weeklyCapacity=3×5=15 days/week → floor=6 weeks
    const rt = makeRt('rt1', 'Dev', 3)

    function makeParallelFeature(id: string) {
      return makeFeature(id, [makeStory(`s-${id}`, [makeTask(240, 'rt1', 'Dev')])])
    }

    const epic = makeEpic('e1', [
      makeParallelFeature('f1'),
      makeParallelFeature('f2'),
      makeParallelFeature('f3'),
    ], { featureMode: 'parallel' })

    const result = runScheduler(baseInput({ epics: [epic], resourceTypes: [rt] }))

    for (const entry of result.featureSchedule) {
      expect(entry.durationWeeks).toBeGreaterThanOrEqual(6)
    }
  })

  it('single feature parallel epic has no floor adjustment', () => {
    // Only 1 feature — no contention, so no floor should be applied
    // count=2, demand=30 person-days → individual: 30/2/5 = 3 weeks
    const rt = makeRt('rt1', 'Dev', 2)
    const feature = makeFeature('f1', [makeStory('s1', [makeTask(240, 'rt1', 'Dev')])])
    const epic = makeEpic('e1', [feature], { featureMode: 'parallel' })

    const result = runScheduler(baseInput({ epics: [epic], resourceTypes: [rt] }))

    const entry = result.featureSchedule.find(e => e.featureId === 'f1')!
    // Individual calc: 30 days / 2 / 5 = 3 weeks; no floor boost expected
    expect(entry.durationWeeks).toBeCloseTo(3, 1)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Squad-plan slot-segment logic (mirrors the apply-route algorithm)
//
// These tests validate that the segmented derivation used in the apply route
// produces the correct startWeek/endWeek per named resource, and that
// getWeeklyCapacity then reflects per-period headcount changes.
// ─────────────────────────────────────────────────────────────────────────────

/** Build a SchedulerResourceType with NRs whose windows match the given segments. */
function rtFromSlotSegments(
  id: string,
  name: string,
  count: number,
   slotSegments: Array<{ startWeek: number; endWeek: number }>,
  hpd = 8,
): SchedulerResourceType {
  return {
    id, name, count, hoursPerDay: hpd,
    namedResources: slotSegments.map((w, i) => ({
      id: `nr-${i + 1}`,
      name: `${name} ${i + 1}`,
      startWeek: w.startWeek,
      endWeek:   w.endWeek,
      allocationPct: 100,
      allocationMode: 'CAPACITY_PLAN',
      allocationPercent: 100,
      allocationStartWeek: null,
      allocationEndWeek: null,
    })),
  }
}

function toWindows(segments: ReturnType<typeof deriveSlotSegments>) {
  return segments.map(({ startWeek, endWeek }) => ({ startWeek, endWeek }))
}

describe('squad-plan slot-segment derivation → getWeeklyCapacity', () => {
  // Ramp-up scenario: 2 → 3 → 4 headcount across 3 periods (weeks 0-3, 4-7, 8-11)
  it('monotonic ramp-up: capacity increases each period', () => {
    const periods = [
      { periodIndex: 0, startWeek: 0, endWeek: 3,  headcount: 2 },
      { periodIndex: 1, startWeek: 4, endWeek: 7,  headcount: 3 },
      { periodIndex: 2, startWeek: 8, endWeek: 11, headcount: 4 },
    ]
    const windows = toWindows(deriveSlotSegments(periods))
    // Slot 1 & 2 start at week 0 (always active)
    expect(windows[0]).toEqual({ startWeek: 0, endWeek: 11 })
    expect(windows[1]).toEqual({ startWeek: 0, endWeek: 11 })
    // Slot 3 only starts at period 1 (week 4)
    expect(windows[2]).toEqual({ startWeek: 4, endWeek: 11 })
    // Slot 4 only starts at period 2 (week 8)
    expect(windows[3]).toEqual({ startWeek: 8, endWeek: 11 })

    const rt = rtFromSlotSegments('rt1', 'Dev', 4, windows)
    // count=4, namedResources.length=4 → no phantom slots
    expect(getWeeklyCapacity(rt, 0,  8)).toBe(2 * 8 * 5)  // P0: slots 1-2 active
    expect(getWeeklyCapacity(rt, 4,  8)).toBe(3 * 8 * 5)  // P1: slots 1-3 active
    expect(getWeeklyCapacity(rt, 8,  8)).toBe(4 * 8 * 5)  // P2: slots 1-4 active
    expect(getWeeklyCapacity(rt, 11, 8)).toBe(4 * 8 * 5)  // P2 end: still 4 active
  })

  // Ramp-down scenario: 4 → 2 → 1 headcount
  it('monotonic ramp-down: capacity decreases each period', () => {
    const periods = [
      { periodIndex: 0, startWeek: 0, endWeek: 3,  headcount: 4 },
      { periodIndex: 1, startWeek: 4, endWeek: 7,  headcount: 2 },
      { periodIndex: 2, startWeek: 8, endWeek: 11, headcount: 1 },
    ]
    const windows = toWindows(deriveSlotSegments(periods))
    // Slot 1 is active through all periods
    expect(windows[0]).toEqual({ startWeek: 0, endWeek: 11 })
    // Slot 2: active P0 + P1 → endWeek = 7
    expect(windows[1]).toEqual({ startWeek: 0, endWeek: 7 })
    // Slots 3 & 4: only P0 → endWeek = 3
    expect(windows[2]).toEqual({ startWeek: 0, endWeek: 3 })
    expect(windows[3]).toEqual({ startWeek: 0, endWeek: 3 })

    const rt = rtFromSlotSegments('rt1', 'Dev', 4, windows)
    expect(getWeeklyCapacity(rt, 0,  8)).toBe(4 * 8 * 5)  // P0: all 4
    expect(getWeeklyCapacity(rt, 4,  8)).toBe(2 * 8 * 5)  // P1: slots 1-2
    expect(getWeeklyCapacity(rt, 8,  8)).toBe(1 * 8 * 5)  // P2: slot 1 only
  })

  it('non-contiguous 2 → 4 → 2 → 4 plan splits slots into separate segments', () => {
    const periods = [
      { periodIndex: 0, startWeek: 0, endWeek: 3,  headcount: 2 },
      { periodIndex: 1, startWeek: 4, endWeek: 7,  headcount: 4 },
      { periodIndex: 2, startWeek: 8, endWeek: 11, headcount: 2 },
      { periodIndex: 3, startWeek: 12, endWeek: 15, headcount: 4 },
    ]
    const windows = toWindows(deriveSlotSegments(periods))
    expect(windows).toEqual([
      { startWeek: 0, endWeek: 15 },
      { startWeek: 0, endWeek: 15 },
      { startWeek: 4, endWeek: 7 },
      { startWeek: 12, endWeek: 15 },
      { startWeek: 4, endWeek: 7 },
      { startWeek: 12, endWeek: 15 },
    ])

    const rt = rtFromSlotSegments('rt1', 'Dev', 4, windows)
    expect(getWeeklyCapacity(rt, 0,  8)).toBe(2 * 8 * 5)
    expect(getWeeklyCapacity(rt, 4,  8)).toBe(4 * 8 * 5)
    expect(getWeeklyCapacity(rt, 8,  8)).toBe(2 * 8 * 5)
    expect(getWeeklyCapacity(rt, 12, 8)).toBe(4 * 8 * 5)
  })

  it('non-contiguous 1 → 0 → 1 plan drops to zero in the gap', () => {
    const periods = [
      { periodIndex: 0, startWeek: 0, endWeek: 3, headcount: 1 },
      { periodIndex: 1, startWeek: 4, endWeek: 7, headcount: 0 },
      { periodIndex: 2, startWeek: 8, endWeek: 11, headcount: 1 },
    ]
    const windows = toWindows(deriveSlotSegments(periods))
    expect(windows).toEqual([
      { startWeek: 0, endWeek: 3 },
      { startWeek: 8, endWeek: 11 },
    ])

    const rt = rtFromSlotSegments('rt1', 'Dev', 1, windows)
    expect(getWeeklyCapacity(rt, 0, 8)).toBe(1 * 8 * 5)
    expect(getWeeklyCapacity(rt, 4, 8)).toBe(0)
    expect(getWeeklyCapacity(rt, 8, 8)).toBe(1 * 8 * 5)
  })

  it('step-up then step-down: contiguous extra slots stay as one segment', () => {
    const periods = [
      { periodIndex: 0, startWeek: 0, endWeek: 3,  headcount: 2 },
      { periodIndex: 1, startWeek: 4, endWeek: 7,  headcount: 4 },
      { periodIndex: 2, startWeek: 8, endWeek: 11, headcount: 2 },
    ]
    const windows = toWindows(deriveSlotSegments(periods))
    // Slots 1-2 active in all 3 periods → full span 0..11
    expect(windows[0]).toEqual({ startWeek: 0, endWeek: 11 })
    expect(windows[1]).toEqual({ startWeek: 0, endWeek: 11 })
    // Slots 3-4 only active in P1 → 4..7
    expect(windows[2]).toEqual({ startWeek: 4, endWeek: 7 })
    expect(windows[3]).toEqual({ startWeek: 4, endWeek: 7 })

    const rt = rtFromSlotSegments('rt1', 'Dev', 4, windows)
    expect(getWeeklyCapacity(rt, 0,  8)).toBe(2 * 8 * 5)  // P0
    expect(getWeeklyCapacity(rt, 4,  8)).toBe(4 * 8 * 5)  // P1 peak
    expect(getWeeklyCapacity(rt, 7,  8)).toBe(4 * 8 * 5)  // P1 end
    expect(getWeeklyCapacity(rt, 8,  8)).toBe(2 * 8 * 5)  // P2 back down
  })

  // Slot entirely inactive in all periods → endWeek = -1 → contributes nothing
  it('slot never active → endWeek=-1 → does not contribute capacity', () => {
    const periods = [
      { periodIndex: 0, startWeek: 0, endWeek: 7, headcount: 0 },
    ]
    const windows = deriveSlotSegments(periods)
    expect(windows).toHaveLength(0)  // maxSlots=0, no windows

    // Verify directly: a NR with startWeek=-1, endWeek=-1 never contributes
    const rt: SchedulerResourceType = {
      id: 'rt1', name: 'Dev', count: 1, hoursPerDay: 8,
      namedResources: [
        { id: 'nr1', name: 'Dev 1', startWeek: -1, endWeek: -1,
          allocationPct: 100, allocationMode: 'CAPACITY_PLAN', allocationPercent: 100,
          allocationStartWeek: null, allocationEndWeek: null },
      ],
    }
    // NR has endWeek=-1 so week >= -1 but week <= -1 only at week=-1 which never occurs.
    // count=1 namedResources.length=1 → 0 phantom slots.
    expect(getWeeklyCapacity(rt, 0, 8)).toBe(0)
    expect(getWeeklyCapacity(rt, 5, 8)).toBe(0)
  })

  // Single period flat plan: all slots active the whole period
  it('single flat period: all slots span full period', () => {
    const periods = [
      { periodIndex: 0, startWeek: 0, endWeek: 12, headcount: 3 },
    ]
    const windows = toWindows(deriveSlotSegments(periods))
    expect(windows).toHaveLength(3)
    for (const w of windows) {
      expect(w).toEqual({ startWeek: 0, endWeek: 12 })
    }
    const rt = rtFromSlotSegments('rt1', 'Dev', 3, windows)
    expect(getWeeklyCapacity(rt, 0,  8)).toBe(3 * 8 * 5)
    expect(getWeeklyCapacity(rt, 12, 8)).toBe(3 * 8 * 5)
    expect(getWeeklyCapacity(rt, 13, 8)).toBe(0)  // beyond endWeek
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Fractional CAPACITY_PLAN apply materialisation
// Tests that deriveSlotWindowsByResourceType + effectiveAllocationPct produce
// correct per-NR windows/allocationPercent for fractional headcount.
// ─────────────────────────────────────────────────────────────────────────────
import { materializeCapacityPlanResources } from '../lib/capacityPlanMaterialisation.js'

/**
 * Build a SchedulerResourceType with NRs whose startWeek, endWeek and
 * allocationPercent come from the materialisation library's slotWindows.
 */
function rtFromSlotWindows(
  id: string,
  name: string,
  count: number,
  slotWindows: Array<{ startWeek: number; endWeek: number; allocationPercent: number }>,
  hpd = 8,
): SchedulerResourceType {
  return {
    id, name, count, hoursPerDay: hpd,
    namedResources: slotWindows.map((w, i) => ({
      id: `nr-${i + 1}`,
      name: `${name} ${i + 1}`,
      startWeek: w.startWeek,
      endWeek: w.endWeek,
      allocationPct: w.allocationPercent,
      allocationMode: 'CAPACITY_PLAN',
      allocationPercent: w.allocationPercent,
      allocationStartWeek: null,
      allocationEndWeek: null,
    })),
  }
}

/** Derive slot windows for a single RT from a list of simple flat periods. */
function windowsForSingleRT(
  periods: Array<{ periodIndex: number; startWeek: number; endWeek: number; headcount: number }>,
  rtId = 'rt1',
) {
  const matPeriods = periods.map(p => ({
    periodIndex: p.periodIndex,
    startWeek: p.startWeek,
    endWeek: p.endWeek,
    entries: [{ resourceTypeId: rtId, headcount: p.headcount }],
  }))
  const mat = materializeCapacityPlanResources(matPeriods)
  return mat.get(rtId)?.slotWindows ?? []
}

describe('fractional CAPACITY_PLAN apply materialisation', () => {
  it('0.25 HC → one window at allocationPercent=25', () => {
    const windows = windowsForSingleRT([
      { periodIndex: 0, startWeek: 0, endWeek: 4, headcount: 0.25 },
    ])
    expect(windows).toHaveLength(1)
    expect(windows[0].allocationPercent).toBe(25)
    expect(windows[0].startWeek).toBe(0)
    expect(windows[0].endWeek).toBe(3)   // inclusive (endWeek - 1)
  })

  it('0.5 HC → one window at allocationPercent=50', () => {
    const windows = windowsForSingleRT([
      { periodIndex: 0, startWeek: 0, endWeek: 4, headcount: 0.5 },
    ])
    expect(windows).toHaveLength(1)
    expect(windows[0].allocationPercent).toBe(50)
  })

  it('1.25 HC → one 100% window + one 25% window, same span', () => {
    const windows = windowsForSingleRT([
      { periodIndex: 0, startWeek: 0, endWeek: 4, headcount: 1.25 },
    ])
    expect(windows).toHaveLength(2)
    // Sorted: 100% first (descending allocationPercent), then 25%
    expect(windows[0].allocationPercent).toBe(100)
    expect(windows[1].allocationPercent).toBe(25)
    expect(windows[0].startWeek).toBe(windows[1].startWeek)
    expect(windows[0].endWeek).toBe(windows[1].endWeek)
  })

  it('effectiveAllocationPct returns allocationPercent for CAPACITY_PLAN', () => {
    const nr25 = {
      id: 'nr1', name: 'Dev 1',
      startWeek: 0, endWeek: 4,
      allocationPct: 25, allocationMode: 'CAPACITY_PLAN' as const,
      allocationPercent: 25,
      allocationStartWeek: null, allocationEndWeek: null,
    }
    expect(effectiveAllocationPct(nr25, 2)).toBe(25)

    const nr100 = { ...nr25, allocationPercent: 100, allocationPct: 100 }
    expect(effectiveAllocationPct(nr100, 2)).toBe(100)
  })

  it('getWeeklyCapacity respects fractional allocationPercent via CAPACITY_PLAN NRs', () => {
    const windows = windowsForSingleRT([
      { periodIndex: 0, startWeek: 0, endWeek: 4, headcount: 0.25 },
    ])
    const rt = rtFromSlotWindows('rt1', 'Dev', 1, windows)
    // 25% * 8 hpd * 5 days = 10 hours
    expect(getWeeklyCapacity(rt, 0, 8)).toBeCloseTo(10)
    expect(getWeeklyCapacity(rt, 3, 8)).toBeCloseTo(10)
    expect(getWeeklyCapacity(rt, 4, 8)).toBe(0)  // beyond inclusive endWeek=3
  })

  it('getWeeklyCapacity: 1.25 HC → 1.25 × hpd × 5 hours per active week', () => {
    const windows = windowsForSingleRT([
      { periodIndex: 0, startWeek: 0, endWeek: 4, headcount: 1.25 },
    ])
    const rt = rtFromSlotWindows('rt1', 'Dev', 2, windows)
    // 100% + 25% = 125% → 1.25 × 8 × 5 = 50 hours
    expect(getWeeklyCapacity(rt, 0, 8)).toBeCloseTo(50)
  })

  it('fractional HC that drops to 0 mid-plan → NR becomes inactive', () => {
    const windows = windowsForSingleRT([
      { periodIndex: 0, startWeek: 0, endWeek: 4,  headcount: 0.5 },
      { periodIndex: 1, startWeek: 4, endWeek: 8,  headcount: 0 },
      { periodIndex: 2, startWeek: 8, endWeek: 12, headcount: 0.5 },
    ])
    expect(windows).toHaveLength(2)
    expect(windows[0]).toMatchObject({ startWeek: 0, endWeek: 3, allocationPercent: 50 })
    expect(windows[1]).toMatchObject({ startWeek: 8, endWeek: 11, allocationPercent: 50 })

    const rt = rtFromSlotWindows('rt1', 'Dev', 1, windows)
    expect(getWeeklyCapacity(rt, 0, 8)).toBeCloseTo(20)  // 50% × 8 × 5
    expect(getWeeklyCapacity(rt, 4, 8)).toBe(0)
    expect(getWeeklyCapacity(rt, 8, 8)).toBeCloseTo(20)
  })

  it('integer 2 HC still works correctly via new path', () => {
    const windows = windowsForSingleRT([
      { periodIndex: 0, startWeek: 0, endWeek: 4, headcount: 2 },
    ])
    expect(windows).toHaveLength(2)
    expect(windows[0].allocationPercent).toBe(100)
    expect(windows[1].allocationPercent).toBe(100)

    const rt = rtFromSlotWindows('rt1', 'Dev', 2, windows)
    expect(getWeeklyCapacity(rt, 0, 8)).toBe(2 * 8 * 5)
  })
})
