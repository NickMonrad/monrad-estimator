/**
 * leveller.test.ts
 *
 * Unit tests for the pure levelEpicStarts function (lib/leveller.ts).
 *
 * All tests construct minimal SchedulerInput objects — no mocks required
 * because levelEpicStarts is a pure function.
 */
import { describe, it, expect } from 'vitest'
import { levelEpicStarts } from '../lib/leveller.js'
import type {
  SchedulerInput,
  SchedulerEpic,
  SchedulerFeature,
  SchedulerStory,
  SchedulerResourceType,
} from '../lib/scheduler.js'

// ─────────────────────────────────────────────────────────────────────────────
// Builder helpers (mirrors scheduler.test.ts pattern)
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
): SchedulerFeature {
  return { id, order, isActive: null, userStories: stories, dependencies: [] }
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
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('levelEpicStarts', () => {
  it('single epic returns startWeek 0', () => {
    const rt = makeRt('rt1', 'Dev', 1)
    // Epic with 5 days of work = 1 week
    const epic = makeEpic('e1', [
      makeFeature('f1', [makeStory('s1', [makeTask(40, 'rt1')])]),
    ], { order: 0 })

    const result = levelEpicStarts(baseInput({
      epics: [epic],
      resourceTypes: [rt],
    }))

    expect(result.epicStartWeeks.get('e1')).toBe(0)
    expect(result.totalDeliveryWeeks).toBeGreaterThan(0)
  })

  it('3 competing epics all needing same RT (count=1) are staggered sequentially', () => {
    // RT count=1: only 5 days/week capacity (1 person × 8hpd × 5days = 40h/wk = 5 days/wk)
    // Each epic needs 40h = 5 days = 1 week.
    // With count=1 there is no room for overlap → they must be placed sequentially.
    const rt = makeRt('rt1', 'Dev', 1, 8)

    const epics = ['e1', 'e2', 'e3'].map((id, i) =>
      makeEpic(id, [
        makeFeature(`f${i}`, [makeStory(`s${i}`, [makeTask(40, 'rt1')])]),
      ], { order: i })
    )

    const result = levelEpicStarts(baseInput({
      epics,
      resourceTypes: [rt],
    }))

    const starts = ['e1', 'e2', 'e3'].map(id => result.epicStartWeeks.get(id)!)

    // Each start should be after the previous epic finishes (no overlap)
    expect(starts[0]).toBeLessThan(starts[1])
    expect(starts[1]).toBeLessThan(starts[2])

    // Specifically with 1-week epics they should be 0, 1, 2 (or similar sequential)
    expect(starts[1] - starts[0]).toBeGreaterThanOrEqual(1)
    expect(starts[2] - starts[1]).toBeGreaterThanOrEqual(1)
  })

  it('respects epic dependencies: dependent epic never starts before predecessor finishes', () => {
    const rt = makeRt('rt1', 'Dev', 2, 8) // 2 people — enough capacity to overlap if not for dep

    const epicA = makeEpic('eA', [
      makeFeature('fA', [makeStory('sA', [makeTask(40, 'rt1')])]),
    ], { order: 0 })

    const epicB = makeEpic('eB', [
      makeFeature('fB', [makeStory('sB', [makeTask(40, 'rt1')])]),
    ], { order: 1 })

    // B depends on A
    const epicDeps = [{ epicId: 'eB', dependsOnId: 'eA' }]

    const result = levelEpicStarts(baseInput({
      epics: [epicA, epicB],
      resourceTypes: [rt],
      epicDeps,
    }))

    const startA = result.epicStartWeeks.get('eA')!
    const startB = result.epicStartWeeks.get('eB')!

    // A's duration is 1 week (40h / 2 people = 20h = 2.5 days → ~0.5 weeks, but min is 0.2)
    // Either way B must start at or after A finishes
    // A starts at 0, duration ~0.5 weeks → A finishes ~0.5, B should start ≥ 1 (ceiled)
    expect(startB).toBeGreaterThanOrEqual(Math.ceil(startA))
    // B must start strictly after A (dependency)
    expect(startB).toBeGreaterThan(startA)
  })

  it('allows concurrent placement when epics use different RTs', () => {
    // Epic 1 uses rt1, Epic 2 uses rt2 — they don't compete, can run in parallel
    const rt1 = makeRt('rt1', 'Dev', 1, 8)
    const rt2 = makeRt('rt2', 'Design', 1, 8)

    const epicDev = makeEpic('e-dev', [
      makeFeature('f-dev', [makeStory('s-dev', [makeTask(40, 'rt1')])]),
    ], { order: 0 })

    const epicDesign = makeEpic('e-design', [
      makeFeature('f-design', [makeStory('s-design', [makeTask(40, 'rt2')])]),
    ], { order: 1 })

    const result = levelEpicStarts(baseInput({
      epics: [epicDev, epicDesign],
      resourceTypes: [rt1, rt2],
    }))

    const startDev = result.epicStartWeeks.get('e-dev')!
    const startDesign = result.epicStartWeeks.get('e-design')!

    // Both can start at week 0 — no resource contention
    expect(startDev).toBe(0)
    expect(startDesign).toBe(0)
  })
})
