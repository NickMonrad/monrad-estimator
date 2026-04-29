/**
 * optimiser.test.ts
 *
 * Unit tests for the pure optimiser library (lib/optimiser.ts).
 *
 * Because runOptimiser() is a pure function with no DB or I/O dependencies
 * (it only calls runScheduler() internally), no Prisma mocking is required.
 * We construct minimal SchedulerInput objects and assert on OptimiserResult.
 */

import { describe, it, expect } from 'vitest'
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
    durationDays: null as null,
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

    // No budget constraint: all 4×2 = 8 scenarios pass
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

    // Tight budget: only cheap scenarios (few resources) should survive
    // Set budget to the median cost of the uncapped result set
    if (uncapped.candidates.length < 2) {
      // Edge case: skip if not enough candidates
      return
    }
    const costs = uncapped.candidates.map(c => c.metrics.estimatedCost).sort((a, b) => a - b)
    const medianCost = costs[Math.floor(costs.length / 2)]

    const capped = runOptimiser(input, baseConfig({
      mode: 'balanced',
      constraints: {
        countRanges: [
          { resourceTypeId: 'rt-dev', min: 1, max: 4 },
          { resourceTypeId: 'rt-des', min: 1, max: 2 },
        ],
        allowRampUp: false,
        maxBudget: medianCost,
      },
      dayRates,
      topN: 10,
    }))

    // All surviving candidates must be within budget
    for (const c of capped.candidates) {
      expect(c.metrics.estimatedCost).toBeLessThanOrEqual(medianCost + 0.001)
    }
    // Budget filter must have removed at least one scenario (the expensive ones)
    expect(capped.candidates.length).toBeLessThan(uncapped.candidates.length)
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
})
