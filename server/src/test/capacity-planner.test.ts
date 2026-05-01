import { describe, it, expect } from 'vitest'
import { computeCapacityPlan, type CapacityPlanConfig } from '../lib/capacity-planner.js'
import type { SchedulerInput } from '../lib/scheduler.js'

// ─── Minimal fixture helper ─────────────────────────────────────────────────

function makeInput(opts: {
  numEpics?: number
  featuresPerEpic?: number
  hoursPerFeature?: number
  numRTs?: number
  countPerRT?: number
  featureMode?: string
  /** If provided, only the first N RTs get tasks (rest have no demand) */
  rtsWithDemand?: number
}): SchedulerInput {
  const {
    numEpics = 2,
    featuresPerEpic = 2,
    hoursPerFeature = 40,
    numRTs = 2,
    countPerRT = 2,
    featureMode = 'parallel',
    rtsWithDemand,
  } = opts

  const resourceTypes = Array.from({ length: numRTs }, (_, i) => ({
    id: `rt-${i}`,
    name: `RT ${i}`,
    count: countPerRT,
    hoursPerDay: 8,
    namedResources: [],
  }))

  const demandRTs = rtsWithDemand != null
    ? resourceTypes.slice(0, rtsWithDemand)
    : resourceTypes

  const epics = Array.from({ length: numEpics }, (_, ei) => ({
    id: `epic-${ei}`,
    name: `Epic ${ei}`,
    order: ei,
    isActive: true,
    featureMode,
    scheduleMode: 'sequential',
    timelineStartWeek: null,
    features: Array.from({ length: featuresPerEpic }, (_, fi) => ({
      id: `epic-${ei}-feat-${fi}`,
      order: fi,
      isActive: true,
      timelineStartWeek: null,
      userStories: [{
        id: `epic-${ei}-feat-${fi}-story`,
        order: 0,
        isActive: true,
        tasks: demandRTs.map(rt => ({
          resourceTypeId: rt.id,
          hoursEffort: hoursPerFeature / demandRTs.length,
          durationDays: null,
          resourceType: { id: rt.id, name: rt.name, hoursPerDay: 8 },
        })),
      }],
      dependencies: [],
    })),
  }))

  return {
    project: { hoursPerDay: 8 },
    epics,
    resourceTypes,
    epicDeps: [],
    manualFeatureEntries: [],
    manualStoryEntries: [],
    resourceLevel: false,
  }
}

function makeConfig(overrides?: Partial<CapacityPlanConfig>): CapacityPlanConfig {
  return {
    targetDurationWeeks: 26,
    periodWeeks: 13,
    maxDeltaPerPeriod: 10,  // permissive default
    minFloor: new Map(),
    dayRates: new Map(),
    ...overrides,
  }
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('computeCapacityPlan', () => {
  it('returns a capacity plan with correct period count', () => {
    const input = makeInput({ numEpics: 2, featuresPerEpic: 2 })
    const config = makeConfig({ targetDurationWeeks: 26, periodWeeks: 13 })

    const result = computeCapacityPlan(input, config)

    expect(result.periods.length).toBeGreaterThanOrEqual(1)
    expect(result.deliveryWeeks).toBeGreaterThan(0)
    expect(result.totalCost).toBeGreaterThanOrEqual(0)
    // Each period should have the expected structure
    for (const period of result.periods) {
      expect(period.periodIndex).toBeGreaterThanOrEqual(0)
      expect(period.periodLabel).toBeTruthy()
      expect(period.resources).toBeInstanceOf(Array)
    }
  })

  it('monthly periods produce more granular output than quarterly', () => {
    // Need enough work to span multiple quarters so period count differs
    const input = makeInput({ numEpics: 4, featuresPerEpic: 4, hoursPerFeature: 160, countPerRT: 1 })

    const monthly = computeCapacityPlan(input, makeConfig({ targetDurationWeeks: 104, periodWeeks: 4 }))
    const quarterly = computeCapacityPlan(input, makeConfig({ targetDurationWeeks: 104, periodWeeks: 13 }))

    expect(monthly.periods.length).toBeGreaterThan(quarterly.periods.length)
    // Monthly should label with "Month X"
    expect(monthly.periods[0].periodLabel).toMatch(/^Month /)
    // Quarterly should label with "QX"
    expect(quarterly.periods[0].periodLabel).toMatch(/^Q/)
  })

  it('min floor is respected', () => {
    const input = makeInput({ numEpics: 1, featuresPerEpic: 1, hoursPerFeature: 8, countPerRT: 1 })
    const minFloor = new Map([['rt-0', 2]])
    const config = makeConfig({ minFloor })

    const result = computeCapacityPlan(input, config)

    // Every period where rt-0 appears must have headcount >= 2
    for (const period of result.periods) {
      const rt0 = period.resources.find(r => r.resourceTypeId === 'rt-0')
      if (rt0) {
        expect(rt0.headcount).toBeGreaterThanOrEqual(2)
      }
    }
  })

  it('max delta smoothing constrains headcount changes', () => {
    // Create a backlog with uneven demand: first epic is huge, second is tiny
    // This should create demand that varies across periods
    const input = makeInput({ numEpics: 1, featuresPerEpic: 1, numRTs: 1, countPerRT: 1 })
    // Add features with varying demand by manipulating directly
    const bigFeature = {
      id: 'big-feat',
      order: 0,
      isActive: true as const,
      timelineStartWeek: null,
      userStories: [{
        id: 'big-story',
        order: 0,
        isActive: true as const,
        tasks: [{
          resourceTypeId: 'rt-0',
          hoursEffort: 400,  // 50 person-days → large demand
          durationDays: null,
          resourceType: { id: 'rt-0', name: 'RT 0', hoursPerDay: 8 },
        }],
      }],
      dependencies: [],
    }
    const smallFeature = {
      id: 'small-feat',
      order: 1,
      isActive: true as const,
      timelineStartWeek: null,
      userStories: [{
        id: 'small-story',
        order: 0,
        isActive: true as const,
        tasks: [{
          resourceTypeId: 'rt-0',
          hoursEffort: 8,  // 1 person-day → tiny demand
          durationDays: null,
          resourceType: { id: 'rt-0', name: 'RT 0', hoursPerDay: 8 },
        }],
      }],
      dependencies: [],
    }
    input.epics = [{
      id: 'epic-0',
      name: 'Epic 0',
      order: 0,
      isActive: true,
      featureMode: 'sequential',
      scheduleMode: 'sequential',
      timelineStartWeek: null,
      features: [bigFeature, smallFeature],
    }]

    const config = makeConfig({
      targetDurationWeeks: 52,
      periodWeeks: 4,
      maxDeltaPerPeriod: 1,
    })

    const result = computeCapacityPlan(input, config)

    // Adjacent periods for rt-0 should differ by at most maxDeltaPerPeriod
    for (let i = 1; i < result.periods.length; i++) {
      const prev = result.periods[i - 1].resources.find(r => r.resourceTypeId === 'rt-0')
      const curr = result.periods[i].resources.find(r => r.resourceTypeId === 'rt-0')
      if (prev && curr) {
        const delta = Math.abs(curr.headcount - prev.headcount)
        expect(delta).toBeLessThanOrEqual(1)
      }
    }
  })

  it('only RTs with task demand are planned', () => {
    const input = makeInput({ numRTs: 3, rtsWithDemand: 2 })
    const config = makeConfig()

    const result = computeCapacityPlan(input, config)

    expect(result.plannedResourceTypeIds).toHaveLength(2)
    expect(result.plannedResourceTypeIds).toContain('rt-0')
    expect(result.plannedResourceTypeIds).toContain('rt-1')
    expect(result.plannedResourceTypeIds).not.toContain('rt-2')
  })

  it('cost computation uses dayRates correctly', () => {
    // 1 epic, 1 feature, 1 RT with count=1 → predictable headcount
    const input = makeInput({
      numEpics: 1,
      featuresPerEpic: 1,
      hoursPerFeature: 40,
      numRTs: 1,
      countPerRT: 1,
    })
    const dayRate = 500
    const dayRates = new Map([['rt-0', dayRate]])
    const config = makeConfig({ dayRates, periodWeeks: 13 })

    const result = computeCapacityPlan(input, config)

    // Verify totalCost equals sum of per-period costs
    const sumPeriodCosts = result.periods.reduce((sum, p) => {
      return sum + p.resources.reduce((s, r) => s + r.costForPeriod, 0)
    }, 0)
    expect(result.totalCost).toBe(Math.round(sumPeriodCosts))

    // Verify individual period cost formula: headcount × dayRate × weeksInPeriod × 5
    for (const period of result.periods) {
      const weeksInPeriod = period.endWeek - period.startWeek
      for (const r of period.resources) {
        const expectedCost = r.headcount * dayRate * weeksInPeriod * 5
        expect(r.costForPeriod).toBe(Math.round(expectedCost))
      }
    }
  })

  it('handles large backlog with constrained capacity', () => {
    // Large backlog: 4 epics × 5 features × 80 hours each = 1600 hours
    // With 1 person per RT doing 40h/week, that's ~40 weeks of work
    // SA planner optimises scheduling order within existing capacity,
    // it doesn't scale resources. Delivery should reflect actual capacity.
    const input = makeInput({
      numEpics: 4,
      featuresPerEpic: 5,
      hoursPerFeature: 80,
      numRTs: 1,
      countPerRT: 1,
    })
    const config = makeConfig({ targetDurationWeeks: 20, periodWeeks: 4 })

    const result = computeCapacityPlan(input, config)

    // Planner should still produce a valid plan with positive delivery weeks
    expect(result.deliveryWeeks).toBeGreaterThan(0)
    expect(result.periods.length).toBeGreaterThan(0)
  })
})
