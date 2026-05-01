/**
 * optimiser.test.ts
 *
 * Unit tests for the pure optimiser library (lib/optimiser.ts).
 *
 * Because runOptimiser() is a pure function with no DB or I/O dependencies
 * (it only calls runScheduler() internally), no Prisma mocking is required.
 * We construct minimal SchedulerInput objects and assert on OptimiserResult.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { app } from '../index.js'
import { prisma } from '../lib/prisma.js'
import {
  runOptimiser,
  type OptimiserConfig,
} from '../lib/optimiser.js'
import {
  type SchedulerInput,
  type SchedulerEpic,
  type SchedulerFeature,
  type SchedulerStory,
  type SchedulerResourceType,
} from '../lib/scheduler.js'

// ─────────────────────────────────────────────────────────────────────────────
// Test helpers — mirrors scheduler.test.ts conventions
// ─────────────────────────────────────────────────────────────────────────────

function makeTask(hoursEffort: number, rtId: string, rtName = 'Dev', hpd = 8) {
  return {
    resourceTypeId: rtId,
    hoursEffort,
    durationDays: null as number | null,
    resourceType: { id: rtId, name: rtName, hoursPerDay: hpd },
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
  return { id, order, isActive: null, userStories: stories, dependencies: deps }
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

function baseConfig(overrides: Partial<OptimiserConfig> = {}): OptimiserConfig {
  return {
    mode: 'speed',
    constraints: {
      countRanges: [],
      allowRampUp: false,
    },
    topN: 5,
    ...overrides,
  }
}

/** Build a simple 2-RT, 1-feature input with tasks for each RT. */
function twoRtInput(): SchedulerInput {
  const rt1 = makeRt('rt-dev', 'Developer', 2)
  const rt2 = makeRt('rt-des', 'Designer', 1)

  // Each feature has tasks for both RTs
  const feature1 = makeFeature('f1', [
    makeStory('s1', [
      makeTask(80, 'rt-dev', 'Developer'),  // 10 days @ 8hpd
      makeTask(40, 'rt-des', 'Designer'),   // 5 days @ 8hpd
    ]),
  ], 0)

  const feature2 = makeFeature('f2', [
    makeStory('s2', [
      makeTask(160, 'rt-dev', 'Developer'), // 20 days
      makeTask(80, 'rt-des', 'Designer'),   // 10 days
    ]),
  ], 1)

  const epic = makeEpic('e1', [feature1, feature2])

  return {
    project: { hoursPerDay: 8 },
    epics: [epic],
    resourceTypes: [rt1, rt2],
    epicDeps: [],
    manualFeatureEntries: [],
    manualStoryEntries: [],
    resourceLevel: false,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('runOptimiser', () => {
  // ── Happy path: 2 RTs, 3×3 grid ─────────────────────────────────────────
  it('happy path: 3×3 grid evaluates 9 scenarios with valid scores', () => {
    const input = twoRtInput()
    const config = baseConfig({
      mode: 'speed',
      constraints: {
        countRanges: [
          { resourceTypeId: 'rt-dev', min: 1, max: 3 },
          { resourceTypeId: 'rt-des', min: 1, max: 3 },
        ],
        allowRampUp: false,
      },
      topN: 9,
    })

    const result = runOptimiser(input, config)

    // All 9 grid points should have been evaluated
    expect(result.searchStats.scenariosEvaluated).toBe(9)
    expect(result.searchStats.sampled).toBe(false)
    expect(result.candidates.length).toBeLessThanOrEqual(9)
    expect(result.candidates.length).toBeGreaterThan(0)

    // Each candidate should have valid numeric metrics
    for (const c of result.candidates) {
      expect(c.metrics.deliveryWeeks).toBeGreaterThan(0)
      expect(c.metrics.avgUtilisationPct).toBeGreaterThanOrEqual(0)
      expect(c.metrics.avgUtilisationPct).toBeLessThanOrEqual(100)
      expect(c.metrics.parallelWarningCount).toBeGreaterThanOrEqual(0)
      expect(typeof c.score).toBe('number')
    }

    // Baseline should carry the original RT counts
    expect(result.baseline.resourceTypes.find(r => r.resourceTypeId === 'rt-dev')!.count).toBe(2)
    expect(result.baseline.resourceTypes.find(r => r.resourceTypeId === 'rt-des')!.count).toBe(1)
  })

  // ── Mode comparison: speed vs utilisation vs balanced ────────────────────
  it('mode comparison: speed favours more resources, utilisation favours fewer', () => {
    const input = twoRtInput()

    const countRanges = [
      { resourceTypeId: 'rt-dev', min: 1, max: 4 },
      { resourceTypeId: 'rt-des', min: 1, max: 2 },
    ]

    const speedResult = runOptimiser(input, baseConfig({
      mode: 'speed',
      constraints: { countRanges, allowRampUp: false },
      topN: 1,
    }))

    const utilResult = runOptimiser(input, baseConfig({
      mode: 'utilisation',
      constraints: { countRanges, allowRampUp: false },
      topN: 1,
    }))

    const balancedResult = runOptimiser(input, baseConfig({
      mode: 'balanced',
      constraints: { countRanges, allowRampUp: false },
      topN: 1,
    }))

    // Speed: top candidate should minimise deliveryWeeks
    const speedTop = speedResult.candidates[0]
    const utilTop = utilResult.candidates[0]
    const balancedTop = balancedResult.candidates[0]

    expect(speedTop).toBeDefined()
    expect(utilTop).toBeDefined()
    expect(balancedTop).toBeDefined()

    // Speed mode should generally prefer more resources (lower delivery time).
    // Utilisation mode prefers fewer resources (less idle capacity).
    // Allow for equality when grid is flat, but assert they are valid candidates.
    expect(speedTop.metrics.deliveryWeeks).toBeLessThanOrEqual(
      utilTop.metrics.deliveryWeeks,
    )
    expect(utilTop.metrics.avgUtilisationPct).toBeGreaterThanOrEqual(
      speedTop.metrics.avgUtilisationPct,
    )

    // All three modes should return a valid score breakdown
    expect(Object.keys(speedTop.scoreBreakdown)).toContain('deliveryWeeksComponent')
    expect(Object.keys(utilTop.scoreBreakdown)).toContain('utilisationComponent')
    expect(Object.keys(balancedTop.scoreBreakdown)).toContain('speedComponent')
  })

  // ── Constraint: maxDurationWeeks ─────────────────────────────────────────
  it('constraint: maxDurationWeeks filters out long candidates', () => {
    const input = twoRtInput()

    // With 1 developer the project is very long; raise maxDurationWeeks low
    // enough that it should filter out the 1-dev scenarios.
    const baselineOutput = runOptimiser(input, baseConfig({
      constraints: {
        countRanges: [{ resourceTypeId: 'rt-dev', min: 2, max: 2 }],
        allowRampUp: false,
      },
      topN: 1,
    }))
    const baselineWeeks = baselineOutput.baseline.metrics.deliveryWeeks

    // Now filter any scenario that would take longer than the baseline
    const result = runOptimiser(input, baseConfig({
      mode: 'speed',
      constraints: {
        countRanges: [
          { resourceTypeId: 'rt-dev', min: 1, max: 4 },
          { resourceTypeId: 'rt-des', min: 1, max: 2 },
        ],
        allowRampUp: false,
        maxDurationWeeks: baselineWeeks,
      },
      topN: 10,
    }))

    // All surviving candidates must respect the cap
    for (const c of result.candidates) {
      expect(c.metrics.deliveryWeeks).toBeLessThanOrEqual(baselineWeeks)
    }
  })

  // ── Constraint: maxBudget ─────────────────────────────────────────────────
  it('constraint: maxBudget filters out expensive candidates', () => {
    const input = twoRtInput()
    const dayRates = new Map([['rt-dev', 100], ['rt-des', 80]])

    // Cost is demand-based (Σ task hours / hpd × dayRate), so it does NOT vary
    // with count. Verify the budget filter still functions:
    //   - generous budget → all scenarios pass
    //   - tight budget   → all scenarios filtered out
    const uncapped = runOptimiser(input, baseConfig({
      mode: 'balanced',
      constraints: {
        countRanges: [
          { resourceTypeId: 'rt-dev', min: 1, max: 4 },
          { resourceTypeId: 'rt-des', min: 1, max: 2 },
        ],
        allowRampUp: false,
      },
      dayRates,
      topN: 10,
    }))

    if (uncapped.candidates.length === 0) return // edge case guard
    const demandCost = uncapped.candidates[0].metrics.estimatedCost
    expect(demandCost).toBeGreaterThan(0)
    // All uncapped candidates should share the same demand-based cost.
    for (const c of uncapped.candidates) {
      expect(c.metrics.estimatedCost).toBe(demandCost)
    }

    // Budget tighter than demand cost → every scenario is filtered out.
    const tooTight = runOptimiser(input, baseConfig({
      mode: 'balanced',
      constraints: {
        countRanges: [
          { resourceTypeId: 'rt-dev', min: 1, max: 4 },
          { resourceTypeId: 'rt-des', min: 1, max: 2 },
        ],
        allowRampUp: false,
        maxBudget: demandCost - 1,
      },
      dayRates,
      topN: 10,
    }))
    expect(tooTight.candidates.length).toBe(0)

    // Budget == demand cost (with epsilon) → all candidates pass.
    const looseEnough = runOptimiser(input, baseConfig({
      mode: 'balanced',
      constraints: {
        countRanges: [
          { resourceTypeId: 'rt-dev', min: 1, max: 4 },
          { resourceTypeId: 'rt-des', min: 1, max: 2 },
        ],
        allowRampUp: false,
        maxBudget: demandCost + 0.01,
      },
      dayRates,
      topN: 10,
    }))
    for (const c of looseEnough.candidates) {
      expect(c.metrics.estimatedCost).toBeLessThanOrEqual(demandCost + 0.01)
    }
    expect(looseEnough.candidates.length).toBe(uncapped.candidates.length)
  })

  // ── Cost is demand-based (matches Effort Review) ─────────────────────────
  it('estimatedCost is demand-based: independent of count for a given dayRate', () => {
    const input = twoRtInput()
    const dayRates = new Map([['rt-dev', 100], ['rt-des', 80]])

    // Expected demand cost: Σ (hoursEffort / hpd) × dayRate, hpd=8
    //   dev tasks: 80 + 160 = 240h → 30 days × $100 = $3000
    //   des tasks: 40 + 80  = 120h → 15 days × $80  = $1200
    //   total = $4200
    const expected = 4200

    const result = runOptimiser(input, baseConfig({
      mode: 'balanced',
      constraints: {
        countRanges: [
          { resourceTypeId: 'rt-dev', min: 1, max: 5 },
          { resourceTypeId: 'rt-des', min: 1, max: 3 },
        ],
        allowRampUp: false,
      },
      dayRates,
      topN: 20,
    }))

    expect(result.baseline.metrics.estimatedCost).toBeCloseTo(expected, 2)
    for (const c of result.candidates) {
      expect(c.metrics.estimatedCost).toBeCloseTo(expected, 2)
    }
  })

  // ── Empty project: no epics ───────────────────────────────────────────────
  it('empty project: no epics returns baseline with 0 deliveryWeeks, no crash', () => {
    const emptyInput: SchedulerInput = {
      project: { hoursPerDay: 8 },
      epics: [],
      resourceTypes: [makeRt('rt-dev', 'Developer', 2)],
      epicDeps: [],
      manualFeatureEntries: [],
      manualStoryEntries: [],
      resourceLevel: false,
    }

    const config = baseConfig({
      mode: 'speed',
      constraints: {
        countRanges: [{ resourceTypeId: 'rt-dev', min: 1, max: 3 }],
        allowRampUp: false,
      },
      topN: 5,
    })

    const result = runOptimiser(emptyInput, config)

    expect(result.baseline.metrics.deliveryWeeks).toBe(0)
    // No crash — candidates may be empty or valid
    expect(Array.isArray(result.candidates)).toBe(true)
    expect(result.searchStats.scenariosEvaluated).toBeGreaterThanOrEqual(0)
  })

  // ── Sampling kicks in when search space > 5000 ────────────────────────────
  it('sampling: search space > 5000 triggers random sampling', () => {
    // 10^4 = 10,000 combinations > 5000 threshold
    // Use 4 RTs with 10 options each to easily exceed 5000
    const rts: SchedulerResourceType[] = [
      makeRt('rt-a', 'TypeA', 5),
      makeRt('rt-b', 'TypeB', 5),
      makeRt('rt-c', 'TypeC', 5),
      makeRt('rt-d', 'TypeD', 5),
    ]
    const story = makeStory('s', [makeTask(40, 'rt-a', 'TypeA')])
    const feature = makeFeature('f', [story])
    const epic = makeEpic('e', [feature])
    const input: SchedulerInput = {
      project: { hoursPerDay: 8 },
      epics: [epic],
      resourceTypes: rts,
      epicDeps: [],
      manualFeatureEntries: [],
      manualStoryEntries: [],
      resourceLevel: false,
    }

    const config = baseConfig({
      constraints: {
        countRanges: [
          { resourceTypeId: 'rt-a', min: 1, max: 10 },
          { resourceTypeId: 'rt-b', min: 1, max: 10 },
          { resourceTypeId: 'rt-c', min: 1, max: 10 },
          { resourceTypeId: 'rt-d', min: 1, max: 10 },
        ],
        allowRampUp: false,
      },
      topN: 5,
    })

    const result = runOptimiser(input, config)

    // 10^4 = 10,000 > 5000 → must sample
    expect(result.searchStats.sampled).toBe(true)
    // Must return at most 5 candidates
    expect(result.candidates.length).toBeLessThanOrEqual(5)
    // Must have evaluated a reasonable number
    expect(result.searchStats.scenariosEvaluated).toBeGreaterThan(0)
    expect(result.searchStats.scenariosEvaluated).toBeLessThanOrEqual(5000)
  })

  // ── allowRampUp sets suggestedStartWeek ───────────────────────────────────
  it('allowRampUp: suggestedStartWeek reflects first demand week from baseline', () => {
    // Feature 2 starts after feature 1 (sequential). Dev RT first has demand at week 0
    // (feature 1 starts at 0), so suggestedStartWeek should be 0 or the first demand week.
    const input = twoRtInput()

    const withRampUp = runOptimiser(input, baseConfig({
      constraints: {
        countRanges: [{ resourceTypeId: 'rt-dev', min: 2, max: 2 }],
        allowRampUp: true,
      },
      topN: 1,
    }))

    const withoutRampUp = runOptimiser(input, baseConfig({
      constraints: {
        countRanges: [{ resourceTypeId: 'rt-dev', min: 2, max: 2 }],
        allowRampUp: false,
      },
      topN: 1,
    }))

    // With rampUp enabled, suggestedStartWeek may be non-zero;
    // without rampUp, it must always be 0.
    for (const c of withoutRampUp.candidates) {
      for (const rt of c.resourceTypes) {
        expect(rt.suggestedStartWeek).toBe(0)
      }
    }

    // With rampUp, values must be non-negative integers
    for (const c of withRampUp.candidates) {
      for (const rt of c.resourceTypes) {
        expect(rt.suggestedStartWeek).toBeGreaterThanOrEqual(0)
        expect(Number.isInteger(rt.suggestedStartWeek)).toBe(true)
      }
    }
  })

  // ── topN is respected ─────────────────────────────────────────────────────
  it('topN: returns at most topN candidates', () => {
    const input = twoRtInput()
    const result = runOptimiser(input, baseConfig({
      constraints: {
        countRanges: [
          { resourceTypeId: 'rt-dev', min: 1, max: 3 },
          { resourceTypeId: 'rt-des', min: 1, max: 3 },
        ],
        allowRampUp: false,
      },
      topN: 3,
    }))

    expect(result.candidates.length).toBeLessThanOrEqual(3)
  })

  // ── Candidates are ranked by score descending ─────────────────────────────
  it('candidates are sorted by score descending', () => {
    const input = twoRtInput()
    const result = runOptimiser(input, baseConfig({
      mode: 'balanced',
      constraints: {
        countRanges: [
          { resourceTypeId: 'rt-dev', min: 1, max: 4 },
          { resourceTypeId: 'rt-des', min: 1, max: 3 },
        ],
        allowRampUp: false,
      },
      topN: 10,
    }))

    for (let i = 1; i < result.candidates.length; i++) {
      expect(result.candidates[i - 1].score).toBeGreaterThanOrEqual(result.candidates[i].score)
    }
  })

  // ── searchStats are returned ──────────────────────────────────────────────
  it('searchStats reports scenariosEvaluated and durationMs', () => {
    const input = twoRtInput()
    const result = runOptimiser(input, baseConfig({
      constraints: {
        countRanges: [{ resourceTypeId: 'rt-dev', min: 1, max: 2 }],
        allowRampUp: false,
      },
      topN: 2,
    }))

    expect(result.searchStats.scenariosEvaluated).toBeGreaterThanOrEqual(0)
    expect(result.searchStats.durationMs).toBeGreaterThanOrEqual(0)
    expect(typeof result.searchStats.sampled).toBe('boolean')
  })

  // ── Fix 7(a): topN > actual candidates — no padding ───────────────────────
  it('topN exceeding available scenarios returns only actual candidates (no padding)', () => {
    const input = twoRtInput()
    // 3×3 = 9 total scenarios in the grid
    const result = runOptimiser(input, baseConfig({
      mode: 'speed',
      constraints: {
        countRanges: [
          { resourceTypeId: 'rt-dev', min: 1, max: 3 },
          { resourceTypeId: 'rt-des', min: 1, max: 3 },
        ],
        allowRampUp: false,
      },
      topN: 20, // asks for more than available
    }))

    // 9 scenarios run, 9 found (no constraints to filter any out)
    expect(result.searchStats.scenariosEvaluated).toBe(9)
    expect(result.searchStats.candidatesFound).toBe(9)
    // Slice to topN but don't pad — must be exactly 9
    expect(result.candidates.length).toBe(9)
    // No NaN scores
    for (const c of result.candidates) {
      expect(isNaN(c.score)).toBe(false)
      expect(isFinite(c.score)).toBe(true)
    }
  })

  // ── Fix 7(b): single-scenario grid (all min===max===current) ─────────────
  it('single-scenario grid returns 1 candidate with metrics ≈ baseline, no NaN in balanced mode', () => {
    const input = twoRtInput() // rt-dev count=2, rt-des count=1

    const result = runOptimiser(input, baseConfig({
      mode: 'balanced',
      constraints: {
        countRanges: [
          { resourceTypeId: 'rt-dev', min: 2, max: 2 }, // locked to current
          { resourceTypeId: 'rt-des', min: 1, max: 1 }, // locked to current
        ],
        allowRampUp: false,
      },
      topN: 5,
    }))

    expect(result.searchStats.scenariosEvaluated).toBe(1)
    expect(result.searchStats.candidatesFound).toBe(1)
    expect(result.candidates.length).toBe(1)

    const c = result.candidates[0]
    // The single candidate is the current config — metrics must equal baseline
    expect(c.metrics.deliveryWeeks).toBe(result.baseline.metrics.deliveryWeeks)
    expect(c.metrics.avgUtilisationPct).toBeCloseTo(result.baseline.metrics.avgUtilisationPct, 5)
    // No NaN scores in balanced mode (single-point normalisation guard)
    expect(isNaN(c.score)).toBe(false)
    expect(isFinite(c.score)).toBe(true)
  })

  // ── Fix 7(c): manually pinned story — demand still counted ────────────────
  it('manually pinned story (via manualStoryEntries): task demand is counted in utilisation', () => {
    const rt = makeRt('rt-dev', 'Developer', 2)
    // Story will be pinned to startWeek: 5 via manualStoryEntries (simulating isManual=true)
    const story = makeStory('s-pinned', [makeTask(80, 'rt-dev', 'Developer')])
    const feature = makeFeature('f1', [story])
    const epic = makeEpic('e1', [feature])

    const input: SchedulerInput = {
      project: { hoursPerDay: 8 },
      epics: [epic],
      resourceTypes: [rt],
      epicDeps: [],
      manualFeatureEntries: [],
      // Pin the story to week 5 — simulates a story with isManual=true on its timeline entry
      manualStoryEntries: [{ storyId: 's-pinned', startWeek: 5 }],
      resourceLevel: false,
    }

    const result = runOptimiser(input, baseConfig({
      mode: 'balanced',
      constraints: {
        countRanges: [{ resourceTypeId: 'rt-dev', min: 2, max: 2 }],
        allowRampUp: false,
      },
      topN: 1,
    }))

    // computeMetrics must count the task's 80h demand even though the story is manually pinned
    expect(result.baseline.metrics.avgUtilisationPct).toBeGreaterThan(0)
    expect(isNaN(result.baseline.metrics.avgUtilisationPct)).toBe(false)

    // Candidates should not have NaN scores (verifies balanced-mode normalisation)
    if (result.candidates.length > 0) {
      expect(isNaN(result.candidates[0].score)).toBe(false)
      expect(isFinite(result.candidates[0].score)).toBe(true)
    }
  })

  // ── Fix 6: seeded PRNG produces deterministic samples ─────────────────────
  it('seeded PRNG: randomSample is deterministic when rng is injected', () => {
    // Tiny mulberry32 — fast, seedable, no external dep
    function mulberry32(seed: number): () => number {
      let s = seed
      return function () {
        s |= 0; s = (s + 0x6D2B79F5) | 0
        let t = Math.imul(s ^ (s >>> 15), 1 | s)
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296
      }
    }

    // 4 RTs with 10 options each → 10^4 = 10,000 > MAX_SCENARIOS → sampling triggered
    const rts: SchedulerResourceType[] = [
      makeRt('rt-a', 'TypeA', 5),
      makeRt('rt-b', 'TypeB', 5),
      makeRt('rt-c', 'TypeC', 5),
      makeRt('rt-d', 'TypeD', 5),
    ]
    const story = makeStory('s', [makeTask(40, 'rt-a', 'TypeA')])
    const feature = makeFeature('f', [story])
    const epic = makeEpic('e', [feature])
    const input: SchedulerInput = {
      project: { hoursPerDay: 8 },
      epics: [epic],
      resourceTypes: rts,
      epicDeps: [],
      manualFeatureEntries: [],
      manualStoryEntries: [],
      resourceLevel: false,
    }

    const countRanges = [
      { resourceTypeId: 'rt-a', min: 1, max: 10 },
      { resourceTypeId: 'rt-b', min: 1, max: 10 },
      { resourceTypeId: 'rt-c', min: 1, max: 10 },
      { resourceTypeId: 'rt-d', min: 1, max: 10 },
    ]

    const run1 = runOptimiser(input, baseConfig({
      constraints: { countRanges, allowRampUp: false },
      topN: 5,
      rng: mulberry32(42),
    }))

    const run2 = runOptimiser(input, baseConfig({
      constraints: { countRanges, allowRampUp: false },
      topN: 5,
      rng: mulberry32(42),
    }))

    // Both runs used sampling
    expect(run1.searchStats.sampled).toBe(true)
    expect(run2.searchStats.sampled).toBe(true)

    // Same seed → same candidates in same order
    expect(run1.candidates.length).toBe(run2.candidates.length)
    for (let i = 0; i < run1.candidates.length; i++) {
      expect(run1.candidates[i].resourceTypes).toEqual(run2.candidates[i].resourceTypes)
      expect(run1.candidates[i].score).toBe(run2.candidates[i].score)
    }
  })

  // ── Parallel-warning infeasibility filter ────────────────────────────────
  //
  // Design: need rt-dev count to affect feasibility but NOT the epic span.
  //
  // Setup:
  //   - rt-dev: the RT under test (count varies 1–3)
  //   - rt-fixed: anchor RT, count=1, NOT in the search range
  //   - Feature 1 (parallel): rt-fixed task durationDays=10  + rt-dev task durationDays=8
  //   - Feature 2 (parallel): rt-dev task durationDays=8 (no rt-fixed)
  //
  // featureDurationWeeks computes max(taskDays/count) per RT:
  //   Feature 1: max(8/count_dev, 10/1) → 10 days (rt-fixed dominates for count >= 1)
  //   Feature 2: 8/count_dev → < 10 days
  //   Epic span = max(10, 8/count_dev) = 10 days  → constant regardless of count_dev
  //
  // computeParallelWarnings uses task.durationDays (fixed):
  //   rt-fixed demand = 10 days, rt-fixed capacity = 1×10 = 10 → 10>10 false → no warning
  //   rt-dev demand = 8+8 = 16 days, rt-dev capacity = count × 10
  //     count=1: 16 > 10 → warning (infeasible)
  //     count=2: 16 > 20 → no warning (feasible)
  //     count=3: 16 > 30 → no warning (feasible)

  function makeDurationTask(durationDays: number, rtId: string, rtName: string, hpd = 8) {
    return {
      resourceTypeId: rtId,
      hoursEffort: durationDays * hpd,
      durationDays,
      resourceType: { id: rtId, name: rtName, hoursPerDay: hpd },
    }
  }

  /** Build a parallel over-load input where:
   *  - count=1 for rt-dev → infeasible (warning)
   *  - count=2 or 3 for rt-dev → feasible (no warning)
   */
  function parallelOverloadInput(devCount: number): SchedulerInput {
    const rtDev = makeRt('rt-dev', 'Developer', devCount, 8)
    const rtFixed = makeRt('rt-fixed', 'Anchor', 1, 8)

    const f1 = makeFeature('pf1', [makeStory('ps1', [
      makeDurationTask(10, 'rt-fixed', 'Anchor'),
      makeDurationTask(8, 'rt-dev', 'Developer'),
    ])])
    const f2 = makeFeature('pf2', [makeStory('ps2', [
      makeDurationTask(8, 'rt-dev', 'Developer'),
    ])])
    const parallelEpic = makeEpic('pe1', [f1, f2], { featureMode: 'parallel' })

    return {
      project: { hoursPerDay: 8 },
      epics: [parallelEpic],
      resourceTypes: [rtDev, rtFixed],
      epicDeps: [],
      manualFeatureEntries: [],
      manualStoryEntries: [],
      resourceLevel: false,
    }
  }

  it('parallel over-allocation: only feasible candidates returned (parallelWarningCount === 0)', () => {
    // Baseline has count=1 (over-allocated), search range 1–3.
    // count=1 → infeasible (1 scenario), counts 2 and 3 → feasible (2 scenarios).
    const input = parallelOverloadInput(1)
    const result = runOptimiser(input, baseConfig({
      mode: 'speed',
      constraints: {
        countRanges: [{ resourceTypeId: 'rt-dev', min: 1, max: 3 }],
        allowRampUp: false,
      },
      topN: 10,
    }))

    // All 3 scenarios evaluated
    expect(result.searchStats.scenariosEvaluated).toBe(3)

    // count=1 is infeasible; counts 2 and 3 are feasible
    expect(result.infeasibleCount).toBe(1)
    expect(result.candidates.length).toBe(2)

    // Every returned candidate must have no parallel warnings
    for (const c of result.candidates) {
      expect(c.metrics.parallelWarningCount).toBe(0)
    }

    // candidatesFound matches the feasible count
    expect(result.searchStats.candidatesFound).toBe(2)
  })

  it('parallel over-allocation: all infeasible → candidates empty, infeasibleCount > 0', () => {
    // 3 rt-dev features in parallel: rt-dev demand = 8+8+8 = 24 days.
    // Epic span = 10 days (rt-fixed anchor, in feature 1 only).
    // count=1: capacity=10 < 24 → warning; count=2: capacity=20 < 24 → warning.
    // All range 1–2 scenarios are infeasible.
    const rtDev = makeRt('rt-dev', 'Developer', 1, 8)
    const rtFixed = makeRt('rt-fixed', 'Anchor', 1, 8)
    const f1 = makeFeature('pf1', [makeStory('ps1', [
      makeDurationTask(10, 'rt-fixed', 'Anchor'),
      makeDurationTask(8, 'rt-dev', 'Developer'),
    ])])
    const f2 = makeFeature('pf2', [makeStory('ps2', [makeDurationTask(8, 'rt-dev', 'Developer')])])
    const f3 = makeFeature('pf3', [makeStory('ps3', [makeDurationTask(8, 'rt-dev', 'Developer')])])
    const parallelEpic = makeEpic('pe1', [f1, f2, f3], { featureMode: 'parallel' })
    const input: SchedulerInput = {
      project: { hoursPerDay: 8 },
      epics: [parallelEpic],
      resourceTypes: [rtDev, rtFixed],
      epicDeps: [],
      manualFeatureEntries: [],
      manualStoryEntries: [],
      resourceLevel: false,
    }

    const result = runOptimiser(input, baseConfig({
      mode: 'speed',
      constraints: {
        countRanges: [{ resourceTypeId: 'rt-dev', min: 1, max: 2 }],
        allowRampUp: false,
      },
      topN: 5,
    }))

    expect(result.candidates).toHaveLength(0)
    expect(result.infeasibleCount).toBeGreaterThan(0)
    expect(result.infeasibleCount).toBe(result.searchStats.scenariosEvaluated)
    // baseline is always present (represents current state — not filtered)
    expect(result.baseline).toBeDefined()
    expect(result.baseline.metrics.parallelWarningCount).toBeGreaterThan(0)
  })

  it('parallel over-allocation: baseline is always present even when it has warnings', () => {
    // Range locked to count=1 (infeasible). Only 1 scenario, it's filtered.
    // Baseline (also count=1) must still be returned.
    const input = parallelOverloadInput(1)

    const result = runOptimiser(input, baseConfig({
      mode: 'balanced',
      constraints: {
        countRanges: [{ resourceTypeId: 'rt-dev', min: 1, max: 1 }],
        allowRampUp: false,
      },
      topN: 5,
    }))

    // Baseline must always be returned regardless of its warning count
    expect(result.baseline).toBeDefined()
    expect(result.baseline.resourceTypes.find(r => r.resourceTypeId === 'rt-dev')!.count).toBe(1)
    // It has warnings (current state is infeasible)
    expect(result.baseline.metrics.parallelWarningCount).toBeGreaterThan(0)
    // But candidates array is empty (filter applied to search scenarios, not baseline)
    expect(result.candidates).toHaveLength(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Route-level tests: POST /api/projects/:projectId/optimise/apply
// ─────────────────────────────────────────────────────────────────────────────

process.env.JWT_SECRET = 'test-secret'

const userId = 'user-opt-1'
const token = jwt.sign({ userId }, 'test-secret')
const authHeader = `Bearer ${token}`
const projectId = 'proj-opt-1'
const mockProject = { id: projectId, ownerId: userId, hoursPerDay: 8 }

describe('POST /api/projects/:projectId/optimise/apply — element-level validation', () => {
  beforeEach(() => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue(mockProject as never)
  })

  it('returns 400 when count is not an integer (e.g. "three")', async () => {
    const res = await request(app)
      .post(`/api/projects/${projectId}/optimise/apply`)
      .set('Authorization', authHeader)
      .send({
        resourceTypes: [
          { resourceTypeId: 'rt-1', count: 'three', suggestedStartWeek: 0 },
        ],
      })

    expect(res.status).toBe(400)
    expect(res.body.error).toBe('Invalid resourceTypes element')
  })

  it('returns 400 when count < 1', async () => {
    const res = await request(app)
      .post(`/api/projects/${projectId}/optimise/apply`)
      .set('Authorization', authHeader)
      .send({
        resourceTypes: [
          { resourceTypeId: 'rt-1', count: 0, suggestedStartWeek: 0 },
        ],
      })

    expect(res.status).toBe(400)
    expect(res.body.error).toBe('Invalid resourceTypes element')
  })

  it('returns 400 when resourceTypeId is missing', async () => {
    const res = await request(app)
      .post(`/api/projects/${projectId}/optimise/apply`)
      .set('Authorization', authHeader)
      .send({
        resourceTypes: [
          { count: 2, suggestedStartWeek: 0 },
        ],
      })

    expect(res.status).toBe(400)
    expect(res.body.error).toBe('Invalid resourceTypes element')
  })

  it('returns 400 when suggestedStartWeek is negative', async () => {
    const res = await request(app)
      .post(`/api/projects/${projectId}/optimise/apply`)
      .set('Authorization', authHeader)
      .send({
        resourceTypes: [
          { resourceTypeId: 'rt-1', count: 2, suggestedStartWeek: -1 },
        ],
      })

    expect(res.status).toBe(400)
    expect(res.body.error).toBe('Invalid resourceTypes element')
  })
})
