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
