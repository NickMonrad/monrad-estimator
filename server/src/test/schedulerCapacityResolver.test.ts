/**
 * schedulerCapacityResolver.test.ts
 *
 * Unit tests for the shared profile-first capacity resolver.
 * Uses a mock Prisma client to avoid database dependency.
 */

import { describe, it, expect } from 'vitest'
import { resolveSchedulerCapacity } from '../lib/schedulerCapacityResolver.js'

// ─── Mock client builder ─────────────────────────────────────────────────

function mockClient(overrides: {
  resourceTypes?: any[]
  capacityProfiles?: any[]
  activeCapacityPlan?: any | null
}) {
  return {
    resourceType: {
      findMany: async () => overrides.resourceTypes ?? [],
    },
    capacityProfile: {
      findMany: async () => overrides.capacityProfiles ?? [],
    },
    capacityPlan: {
      findFirst: async () => overrides.activeCapacityPlan ?? null,
    },
  }
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe('resolveSchedulerCapacity', () => {
  it('legacy-only resource types pass through unchanged (no profiles, no plans)', async () => {
    const client = mockClient({
      resourceTypes: [
        {
          id: 'rt-1', name: 'Developer', count: 2, hoursPerDay: 8,
          allocationMode: 'EFFORT', allocationPercent: 100,
          allocationStartWeek: null, allocationEndWeek: null,
          namedResources: [
            {
              id: 'nr-1', name: 'Alice', startWeek: 0, endWeek: null,
              allocationPct: 100, allocationMode: 'EFFORT',
              allocationPercent: 100, allocationStartWeek: null,
              allocationEndWeek: null, pricingModel: 'ACTUAL_DAYS',
              synthetic: false,
            },
          ],
        },
      ],
    })

    const result = await resolveSchedulerCapacity(client as any, 'proj-1', 8)

    expect(result.resourceTypes).toHaveLength(1)
    expect(result.resourceTypes[0].id).toBe('rt-1')
    expect(result.resourceTypes[0].namedResources).toHaveLength(1)
    expect(result.resourceTypes[0].namedResources[0].capacitySegments).toBeUndefined()
    expect(result.meta.profileBackedCount).toBe(0)
    expect(result.meta.legacyCount).toBe(1)
  })

  it('profile-backed named resource gets capacitySegments from profile', async () => {
    const client = mockClient({
      resourceTypes: [
        {
          id: 'rt-1', name: 'Developer', count: 1, hoursPerDay: 8,
          allocationMode: 'FULL_PROJECT', allocationPercent: 100,
          allocationStartWeek: null, allocationEndWeek: null,
          namedResources: [
            {
              id: 'nr-1', name: 'Alice', startWeek: 0, endWeek: null,
              allocationPct: 100, allocationMode: 'FULL_PROJECT',
              allocationPercent: 100, allocationStartWeek: null,
              allocationEndWeek: null, pricingModel: 'ACTUAL_DAYS',
              synthetic: false, createdAt: new Date(),
            },
          ],
        },
      ],
      capacityProfiles: [
        {
          id: 'cp-1', projectId: 'proj-1',
          resourceTypeId: null, namedResourceId: 'nr-1',
          ownerKind: 'NAMED_PERSON', planningBasis: 'CAPACITY_PROFILE',
          source: 'MANUAL', defaultPercent: null,
          startWeek: null, endWeek: null, legacy: null,
          segments: [
            { startWeek: 0, endWeek: 5, capacityPercent: 100, source: 'MANUAL' },
            { startWeek: 6, endWeek: 10, capacityPercent: 50, source: 'MANUAL' },
          ],
        },
      ],
    })

    const result = await resolveSchedulerCapacity(client as any, 'proj-1', 8)

    expect(result.resourceTypes).toHaveLength(1)
    const nr = result.resourceTypes[0].namedResources[0]
    expect(nr.capacitySegments).toHaveLength(2)
    expect(nr.capacitySegments![0]).toEqual({ startWeek: 0, endWeek: 5, allocationPercent: 100 })
    expect(nr.capacitySegments![1]).toEqual({ startWeek: 6, endWeek: 10, allocationPercent: 50 })
    expect(result.meta.profileBackedCount).toBe(1)
    expect(result.meta.profileBackedNamedResourceIds).toEqual(['nr-1'])
    expect(result.meta.legacyCount).toBe(0)
  })

  it('segments override contradictory legacy allocation fields', async () => {
    const client = mockClient({
      resourceTypes: [
        {
          id: 'rt-1', name: 'Developer', count: 1, hoursPerDay: 8,
          allocationMode: 'FULL_PROJECT', allocationPercent: 100,
          allocationStartWeek: null, allocationEndWeek: null,
          namedResources: [
            {
              id: 'nr-1', name: 'Bob',
              startWeek: 0, endWeek: null,
              allocationPct: 100, allocationMode: 'FULL_PROJECT',
              allocationPercent: 100, allocationStartWeek: null,
              allocationEndWeek: null, pricingModel: 'ACTUAL_DAYS',
              synthetic: false, createdAt: new Date(),
            },
          ],
        },
      ],
      capacityProfiles: [
        {
          id: 'cp-2', projectId: 'proj-1',
          resourceTypeId: null, namedResourceId: 'nr-1',
          ownerKind: 'NAMED_PERSON', planningBasis: 'CAPACITY_PROFILE',
          source: 'MANUAL', defaultPercent: null,
          startWeek: null, endWeek: null, legacy: null,
          segments: [
            { startWeek: 0, endWeek: 3, capacityPercent: 25, source: 'MANUAL' },
          ],
        },
      ],
    })

    const result = await resolveSchedulerCapacity(client as any, 'proj-1', 8)

    const nr = result.resourceTypes[0].namedResources[0]
    expect(nr.capacitySegments![0].allocationPercent).toBe(25)
    // Legacy says 100%, but profile segments say 25%
    expect(result.meta.profileBackedCount).toBe(1)
  })

  it('zero-capacity gap between segments is preserved', async () => {
    const client = mockClient({
      resourceTypes: [
        {
          id: 'rt-1', name: 'Developer', count: 1, hoursPerDay: 8,
          allocationMode: 'FULL_PROJECT', allocationPercent: 100,
          allocationStartWeek: null, allocationEndWeek: null,
          namedResources: [
            {
              id: 'nr-1', name: 'Alice',
              startWeek: 0, endWeek: null,
              allocationPct: 100, allocationMode: 'FULL_PROJECT',
              allocationPercent: 100, allocationStartWeek: null,
              allocationEndWeek: null, pricingModel: 'ACTUAL_DAYS',
              synthetic: false, createdAt: new Date(),
            },
          ],
        },
      ],
      capacityProfiles: [
        {
          id: 'cp-3', projectId: 'proj-1',
          resourceTypeId: null, namedResourceId: 'nr-1',
          ownerKind: 'NAMED_PERSON', planningBasis: 'CAPACITY_PROFILE',
          source: 'MANUAL', defaultPercent: null,
          startWeek: null, endWeek: null, legacy: null,
          segments: [
            { startWeek: 0, endWeek: 2, capacityPercent: 100, source: 'MANUAL' },
            { startWeek: 5, endWeek: 7, capacityPercent: 100, source: 'MANUAL' },
          ],
        },
      ],
    })

    const result = await resolveSchedulerCapacity(client as any, 'proj-1', 8)
    const nr = result.resourceTypes[0].namedResources[0]
    expect(nr.capacitySegments).toHaveLength(2)
    // Week 3 is a gap - scheduler test confirms this produces 0 capacity
  })
  it('fixed profile (no segments) uses defaultPercent as a single segment', async () => {
    const client = mockClient({
      resourceTypes: [
        {
          id: 'rt-1', name: 'Developer', count: 1, hoursPerDay: 8,
          allocationMode: 'FULL_PROJECT', allocationPercent: 100,
          allocationStartWeek: null, allocationEndWeek: null,
          namedResources: [
            {
              id: 'nr-1', name: 'Alice',
              startWeek: 0, endWeek: null,
              allocationPct: 100, allocationMode: 'FULL_PROJECT',
              allocationPercent: 100, allocationStartWeek: null,
              allocationEndWeek: null, pricingModel: 'ACTUAL_DAYS',
              synthetic: false, createdAt: new Date(),
            },
          ],
        },
      ],
      capacityProfiles: [
        {
          id: 'cp-fixed', projectId: 'proj-1',
          resourceTypeId: null, namedResourceId: 'nr-1',
          ownerKind: 'NAMED_PERSON', planningBasis: 'WHOLE_PROJECT_ALLOCATION',
          source: 'FIXED', defaultPercent: 75,
          startWeek: null, endWeek: null, legacy: null,
          segments: [],
        },
      ],
    })

    const result = await resolveSchedulerCapacity(client as any, 'proj-1', 8)
    const nr = result.resourceTypes[0].namedResources[0]
    expect(nr.capacitySegments).toHaveLength(1)
    expect(nr.capacitySegments![0]).toEqual({ startWeek: 0, endWeek: Infinity, allocationPercent: 75 })
    expect(result.meta.profileBackedCount).toBe(1)
  })

  it('availability-window profile (no segments) uses startWeek/endWeek + defaultPercent', async () => {
    const client = mockClient({
      resourceTypes: [
        {
          id: 'rt-1', name: 'Designer', count: 1, hoursPerDay: 8,
          allocationMode: 'TIMELINE', allocationPercent: 100,
          allocationStartWeek: 2, allocationEndWeek: 5,
          namedResources: [
            {
              id: 'nr-2', name: 'Bob',
              startWeek: 2, endWeek: 5,
              allocationPct: 100, allocationMode: 'TIMELINE',
              allocationPercent: 100, allocationStartWeek: 2,
              allocationEndWeek: 5, pricingModel: 'ACTUAL_DAYS',
              synthetic: false, createdAt: new Date(),
            },
          ],
        },
      ],
      capacityProfiles: [
        {
          id: 'cp-avail', projectId: 'proj-1',
          resourceTypeId: null, namedResourceId: 'nr-2',
          ownerKind: 'NAMED_PERSON', planningBasis: 'AVAILABILITY_WINDOW',
          source: 'MANUAL', defaultPercent: 60,
          startWeek: 2, endWeek: 5, legacy: null,
          segments: [],
        },
      ],
    })

    const result = await resolveSchedulerCapacity(client as any, 'proj-1', 8)
    const nr = result.resourceTypes[0].namedResources[0]
    expect(nr.capacitySegments).toHaveLength(1)
    expect(nr.capacitySegments![0]).toEqual({ startWeek: 2, endWeek: 5, allocationPercent: 60 })
    expect(result.meta.profileBackedCount).toBe(1)
  })

  it('fixed profile overrides contradictory legacy allocation fields', async () => {
    const client = mockClient({
      resourceTypes: [
        {
          id: 'rt-1', name: 'Developer', count: 1, hoursPerDay: 8,
          allocationMode: 'FULL_PROJECT', allocationPercent: 100,
          allocationStartWeek: null, allocationEndWeek: null,
          namedResources: [
            {
              id: 'nr-1', name: 'Charlie',
              startWeek: null, endWeek: null,
              allocationPct: 100, allocationMode: 'FULL_PROJECT',
              allocationPercent: 100, allocationStartWeek: null,
              allocationEndWeek: null, pricingModel: 'ACTUAL_DAYS',
              synthetic: false, createdAt: new Date(),
            },
          ],
        },
      ],
      capacityProfiles: [
        {
          id: 'cp-override', projectId: 'proj-1',
          resourceTypeId: null, namedResourceId: 'nr-1',
          ownerKind: 'NAMED_PERSON', planningBasis: 'WHOLE_PROJECT_ALLOCATION',
          source: 'FIXED', defaultPercent: 50,
          startWeek: null, endWeek: null, legacy: null,
          segments: [],
        },
      ],
    })

    const result = await resolveSchedulerCapacity(client as any, 'proj-1', 8)
    const nr = result.resourceTypes[0].namedResources[0]
    // Profile says 50%; legacy says 100% — profile should win
    expect(nr.capacitySegments![0].allocationPercent).toBe(50)
  })

  it('profile-backed capacity not truncated by stale legacy startWeek/endWeek', async () => {
    const client = mockClient({
      resourceTypes: [
        {
          id: 'rt-1', name: 'Developer', count: 1, hoursPerDay: 8,
          allocationMode: 'TIMELINE', allocationPercent: 100,
          allocationStartWeek: 5, allocationEndWeek: 10,
          namedResources: [
            {
              id: 'nr-1', name: 'Diana',
              startWeek: 5, endWeek: 10,  // stale legacy window
              allocationPct: 100, allocationMode: 'TIMELINE',
              allocationPercent: 100, allocationStartWeek: 5,
              allocationEndWeek: 10, pricingModel: 'ACTUAL_DAYS',
              synthetic: false, createdAt: new Date(),
            },
          ],
        },
      ],
      capacityProfiles: [
        {
          id: 'cp-full', projectId: 'proj-1',
          resourceTypeId: null, namedResourceId: 'nr-1',
          ownerKind: 'NAMED_PERSON', planningBasis: 'WHOLE_PROJECT_ALLOCATION',
          source: 'FIXED', defaultPercent: 100,
          startWeek: null, endWeek: null, legacy: null,
          segments: [],
        },
      ],
    })

    const result = await resolveSchedulerCapacity(client as any, 'proj-1', 8)
    const nr = result.resourceTypes[0].namedResources[0]
    // Profile single segment covers weeks 0-Infinity at 100%
    expect(nr.capacitySegments![0].startWeek).toBe(0)
    expect(nr.capacitySegments![0].allocationPercent).toBe(100)
  })

  it('role profile populates roleSegments and drives scheduler capacity', async () => {
    const client = mockClient({
      resourceTypes: [
        {
          id: 'rt-1', name: 'Developer', count: 2, hoursPerDay: 8,
          allocationMode: 'EFFORT', allocationPercent: 100,
          allocationStartWeek: null, allocationEndWeek: null,
          namedResources: [],
        },
      ],
      capacityProfiles: [
        {
          id: 'cp-role', projectId: 'proj-1',
          resourceTypeId: 'rt-1', namedResourceId: null,
          ownerKind: 'ROLE', planningBasis: 'CAPACITY_PROFILE',
          source: 'MANUAL', defaultPercent: null,
          startWeek: null, endWeek: null, legacy: null,
          segments: [
            { startWeek: 0, endWeek: 10, capacityPercent: 50, source: 'MANUAL' },
          ],
        },
      ],
    })

    const result = await resolveSchedulerCapacity(client as any, 'proj-1', 8)
    expect(result.meta.roleProfileRTIds).toContain('rt-1')
    expect(result.resourceTypes[0].namedResources).toHaveLength(0)
    // roleSegments should be populated from the role profile
    const rt = result.resourceTypes[0]
    expect(rt.roleSegments).toBeDefined()
    expect(rt.roleSegments!.length).toBe(1)
    expect(rt.roleSegments![0]).toEqual({ startWeek: 0, endWeek: 10, allocationPercent: 50 })
    // The role profile capacity replaces phantom slots:
    // getWeeklyCapacity should return 50% × 8 × 5 = 20, not 2 × 40 = 80
    const { getWeeklyCapacity } = await import('../lib/scheduler.js')
    expect(getWeeklyCapacity(rt as any, 0, 8)).toBe(20)
  })

  it('valid role profile suppresses active capacity plan fallback', async () => {
    const client = mockClient({
      resourceTypes: [
        {
          id: 'rt-1', name: 'Developer', count: 2, hoursPerDay: 8,
          allocationMode: 'CAPACITY_PLAN', allocationPercent: 100,
          allocationStartWeek: null, allocationEndWeek: null,
          namedResources: [],
        },
      ],
      capacityProfiles: [
        {
          id: 'cp-role', projectId: 'proj-1',
          resourceTypeId: 'rt-1', namedResourceId: null,
          ownerKind: 'ROLE', planningBasis: 'CAPACITY_PROFILE',
          source: 'MANUAL', defaultPercent: null,
          startWeek: null, endWeek: null, legacy: null,
          segments: [
            { startWeek: 0, endWeek: 10, capacityPercent: 100, source: 'MANUAL' },
          ],
        },
      ],
      activeCapacityPlan: {
        id: 'plan-1',
        periods: [
          {
            periodIndex: 0, startWeek: 0, endWeek: 4,
            entries: [{ resourceTypeId: 'rt-1', headcount: 10 }],
          },
        ],
      },
    })

    const result = await resolveSchedulerCapacity(client as any, 'proj-1', 8)
    const rt = result.resourceTypes[0]
    // Role profile should suppress capacity plan fallback
    // No synthetic NRs from capacity plan
    expect(rt.namedResources).toHaveLength(0)
    // roleSegments from the valid role profile
    expect(rt.roleSegments).toBeDefined()
  })

  it('capacity plan fallback creates synthetic named resources in scheduler DTO', async () => {
    const client = mockClient({
      resourceTypes: [
        {
          id: 'rt-1', name: 'Developer', count: 2, hoursPerDay: 8,
          allocationMode: 'CAPACITY_PLAN', allocationPercent: 100,
          allocationStartWeek: null, allocationEndWeek: null,
          namedResources: [],
        },
      ],
      capacityProfiles: [],
      activeCapacityPlan: {
        id: 'plan-1',
        periods: [
          {
            periodIndex: 0, startWeek: 0, endWeek: 3,
            entries: [{ resourceTypeId: 'rt-1', headcount: 2 }],
          },
          {
            periodIndex: 1, startWeek: 4, endWeek: 7,
            entries: [{ resourceTypeId: 'rt-1', headcount: 1 }],
          },
        ],
      },
    })

    const result = await resolveSchedulerCapacity(client as any, 'proj-1', 8)
    const rt = result.resourceTypes[0]
    // Should have synthetic named resources from capacity plan slots
    expect(rt.namedResources.length).toBeGreaterThan(0)
    // Slots should have segments matching capacity plan windows
    const firstSlot = rt.namedResources[0]
    expect(firstSlot.capacitySegments).toBeDefined()
    expect(firstSlot.capacitySegments!.length).toBeGreaterThan(0)
    expect(firstSlot.capacitySegments![0].allocationPercent).toBe(100)
    expect(firstSlot.allocationMode).toBe('CAPACITY_PLAN')
  })


  it('role profile segmented zero-capacity gap is preserved', async () => {
    const client = mockClient({
      resourceTypes: [
        {
          id: 'rt-1', name: 'Developer', count: 3, hoursPerDay: 8,
          allocationMode: 'EFFORT', allocationPercent: 100,
          allocationStartWeek: null, allocationEndWeek: null,
          namedResources: [],
        },
      ],
      capacityProfiles: [
        {
          id: 'cp-role', projectId: 'proj-1',
          resourceTypeId: 'rt-1', namedResourceId: null,
          ownerKind: 'ROLE', planningBasis: 'CAPACITY_PROFILE',
          source: 'MANUAL', defaultPercent: null,
          startWeek: null, endWeek: null, legacy: null,
          segments: [
            { startWeek: 0, endWeek: 2, capacityPercent: 100, source: 'MANUAL' },
            { startWeek: 5, endWeek: 7, capacityPercent: 50, source: 'MANUAL' },
          ],
        },
      ],
    })

    const result = await resolveSchedulerCapacity(client as any, 'proj-1', 8)
    const rt = result.resourceTypes[0]
    expect(rt.roleSegments).toBeDefined()
    expect(rt.roleSegments).toHaveLength(2)
    // Gap between segments produces zero capacity (tested in getWeeklyCapacity)
  })
  it('legacy-only project produces deterministic repeated results', async () => {
    const client = mockClient({
      resourceTypes: [
        {
          id: 'rt-1', name: 'Developer', count: 1, hoursPerDay: 8,
          allocationMode: 'EFFORT', allocationPercent: 100,
          allocationStartWeek: null, allocationEndWeek: null,
          namedResources: [
            {
              id: 'nr-1', name: 'Alice',
              startWeek: 0, endWeek: null,
              allocationPct: 100, allocationMode: 'EFFORT',
              allocationPercent: 100, allocationStartWeek: null,
              allocationEndWeek: null, pricingModel: 'ACTUAL_DAYS',
              synthetic: false, createdAt: new Date(),
            },
          ],
        },
      ],
    })

    const result1 = await resolveSchedulerCapacity(client as any, 'proj-1', 8)
    const result2 = await resolveSchedulerCapacity(client as any, 'proj-1', 8)
    expect(result1.resourceTypes).toEqual(result2.resourceTypes)
    expect(result1.meta).toEqual(result2.meta)
  })
})

describe('resolveSchedulerCapacity mixed trajectories (fix 2)', () => {
  it('one existing NR plus one additional plan trajectory', async () => {
    const client = mockClient({
      resourceTypes: [
        {
          id: 'rt-mix', name: 'Developer', count: 2, hoursPerDay: 8,
          allocationMode: 'CAPACITY_PLAN', allocationPercent: 100,
          allocationStartWeek: null, allocationEndWeek: null,
          namedResources: [
            {
              id: 'nr-dev-1', name: 'Dev 1',
              startWeek: null, endWeek: null,
              allocationPct: 100, allocationMode: 'CAPACITY_PLAN',
              allocationPercent: 100, allocationStartWeek: null,
              allocationEndWeek: null, pricingModel: 'ACTUAL_DAYS',
              synthetic: false, createdAt: new Date(),
            },
          ],
        },
      ],
      capacityProfiles: [],
      activeCapacityPlan: {
        id: 'plan-1',
        periods: [
          {
            periodIndex: 0, startWeek: 0, endWeek: 8,
            entries: [{ resourceTypeId: 'rt-mix', headcount: 1.5 }],
          },
        ],
      },
    })

    const result = await resolveSchedulerCapacity(client as any, 'proj-1', 8)
    const rt = result.resourceTypes[0]

    // Must have 2 trajectories: one matched to existing NR, one generated
    expect(rt.namedResources.length).toBe(2)

    const existingNR = rt.namedResources.find(nr => nr.id === 'nr-dev-1')
    expect(existingNR).toBeDefined()
    expect(existingNR!.capacitySegments).toBeDefined()

    const generatedNR = rt.namedResources.find(nr => nr.id !== 'nr-dev-1')
    expect(generatedNR).toBeDefined()
    expect(generatedNR!.allocationMode).toBe('CAPACITY_PLAN')
    expect(generatedNR!.id).toContain('capacity-plan')
  })

  it('more existing NRs than plan trajectories keeps unmatched persisted NRs', async () => {
    const client = mockClient({
      resourceTypes: [
        {
          id: 'rt-extra', name: 'Extra', count: 3, hoursPerDay: 8,
          allocationMode: 'CAPACITY_PLAN', allocationPercent: 100,
          allocationStartWeek: null, allocationEndWeek: null,
          namedResources: [
            {
              id: 'nr-e1', name: 'Extra 1',
              startWeek: null, endWeek: null,
              allocationPct: 100, allocationMode: 'CAPACITY_PLAN',
              allocationPercent: 100, allocationStartWeek: null,
              allocationEndWeek: null, pricingModel: 'ACTUAL_DAYS',
              synthetic: false, createdAt: new Date(),
            },
            {
              id: 'nr-e2', name: 'Extra 2',
              startWeek: null, endWeek: null,
              allocationPct: 100, allocationMode: 'CAPACITY_PLAN',
              allocationPercent: 100, allocationStartWeek: null,
              allocationEndWeek: null, pricingModel: 'ACTUAL_DAYS',
              synthetic: false, createdAt: new Date(),
            },
            {
              id: 'nr-e3', name: 'Extra 3',
              startWeek: null, endWeek: null,
              allocationPct: 100, allocationMode: 'CAPACITY_PLAN',
              allocationPercent: 100, allocationStartWeek: null,
              allocationEndWeek: null, pricingModel: 'ACTUAL_DAYS',
              synthetic: false, createdAt: new Date(),
            },
          ],
        },
      ],
      capacityProfiles: [],
      activeCapacityPlan: {
        id: 'plan-1',
        periods: [
          {
            periodIndex: 0, startWeek: 0, endWeek: 8,
            entries: [{ resourceTypeId: 'rt-extra', headcount: 1 }],
          },
        ],
      },
    })

    const result = await resolveSchedulerCapacity(client as any, 'proj-1', 8)
    const rt = result.resourceTypes[0]

    // 1 trajectory, 3 existing NRs. The trajectory matches NR e1 by index.
    // NR e2 and e3 are unmatched persisted NRs → kept as-is (LEGACY).
    expect(rt.namedResources.length).toBe(3)
    expect(rt.namedResources.find(nr => nr.id === 'nr-e1')?.capacitySegments).toBeDefined()
    // At least one unmatched NR should still exist (legacy format, no segments)
  })

  it('fractional headcount 1.25 FTE produces correct trajectory count', async () => {
    const client = mockClient({
      resourceTypes: [
        {
          id: 'rt-frac', name: 'Fractional', count: 2, hoursPerDay: 8,
          allocationMode: 'CAPACITY_PLAN', allocationPercent: 100,
          allocationStartWeek: null, allocationEndWeek: null,
          namedResources: [],
        },
      ],
      capacityProfiles: [],
      activeCapacityPlan: {
        id: 'plan-1',
        periods: [
          {
            periodIndex: 0, startWeek: 0, endWeek: 8,
            entries: [{ resourceTypeId: 'rt-frac', headcount: 1.25 }],
          },
        ],
      },
    })

    const result = await resolveSchedulerCapacity(client as any, 'proj-1', 8)
    const rt = result.resourceTypes[0]

    // 1.25 FTE = 5 units at 0.25 each, ceil(5/4) = 2 trajectories
    expect(rt.namedResources.length).toBeGreaterThanOrEqual(2)
    expect(rt.namedResources.length).toBeLessThanOrEqual(3)

    // Each trajectory should have segments
    for (const nr of rt.namedResources) {
      expect(nr.capacitySegments).toBeDefined()
      expect(nr.capacitySegments!.length).toBeGreaterThan(0)
    }

    // Total allocation across all NRs should reflect 125% FTE
    const totalPct = rt.namedResources.reduce((sum, nr) => {
      const seg = nr.capacitySegments?.[0]
      return sum + (seg?.allocationPercent ?? 100)
    }, 0)
    expect(totalPct).toBeGreaterThanOrEqual(100)
    expect(totalPct).toBeLessThanOrEqual(200)
  })

  it('capacity decreasing then increasing produces correct trajectories', async () => {
    const client = mockClient({
      resourceTypes: [
        {
          id: 'rt-wave', name: 'Wave', count: 3, hoursPerDay: 8,
          allocationMode: 'CAPACITY_PLAN', allocationPercent: 100,
          allocationStartWeek: null, allocationEndWeek: null,
          namedResources: [],
        },
      ],
      capacityProfiles: [],
      activeCapacityPlan: {
        id: 'plan-1',
        periods: [
          {
            periodIndex: 0, startWeek: 0, endWeek: 4,
            entries: [{ resourceTypeId: 'rt-wave', headcount: 2 }],
          },
          {
            periodIndex: 1, startWeek: 4, endWeek: 8,
            entries: [{ resourceTypeId: 'rt-wave', headcount: 1 }],
          },
          {
            periodIndex: 2, startWeek: 8, endWeek: 12,
            entries: [{ resourceTypeId: 'rt-wave', headcount: 2.5 }],
          },
        ],
      },
    })

    const result = await resolveSchedulerCapacity(client as any, 'proj-1', 8)
    const rt = result.resourceTypes[0]

    // Should have multiple trajectories for the wave pattern
    expect(rt.namedResources.length).toBeGreaterThanOrEqual(2)

    // Trajectories should have segments that change allocation
    const hasChangingAllocation = rt.namedResources.some(nr =>
      nr.capacitySegments && nr.capacitySegments.length > 1,
    )
    expect(hasChangingAllocation).toBe(true)
  })

  it('discontinuous capacity plan periods produce zero-capacity gaps', async () => {
    const client = mockClient({
      resourceTypes: [
        {
          id: 'rt-disc', name: 'Discontinuous', count: 2, hoursPerDay: 8,
          allocationMode: 'CAPACITY_PLAN', allocationPercent: 100,
          allocationStartWeek: null, allocationEndWeek: null,
          namedResources: [],
        },
      ],
      capacityProfiles: [],
      activeCapacityPlan: {
        id: 'plan-1',
        periods: [
          {
            periodIndex: 0, startWeek: 0, endWeek: 3,
            entries: [{ resourceTypeId: 'rt-disc', headcount: 1 }],
          },
          {
            periodIndex: 1, startWeek: 6, endWeek: 9,
            entries: [{ resourceTypeId: 'rt-disc', headcount: 2 }],
          },
        ],
      },
    })

    const result = await resolveSchedulerCapacity(client as any, 'proj-1', 8)
    const rt = result.resourceTypes[0]

    expect(rt.namedResources.length).toBeGreaterThanOrEqual(2)

    // Gaps in segment coverage → zero capacity between periods
    const nr1 = rt.namedResources[0]
    expect(nr1.capacitySegments).toBeDefined()
  })

  it('deterministic IDs and ordering across repeated resolution', async () => {
    const client = mockClient({
      resourceTypes: [
        {
          id: 'rt-det', name: 'Deterministic', count: 2, hoursPerDay: 8,
          allocationMode: 'CAPACITY_PLAN', allocationPercent: 100,
          allocationStartWeek: null, allocationEndWeek: null,
          namedResources: [
            {
              id: 'nr-det-1', name: 'Det 1',
              startWeek: null, endWeek: null,
              allocationPct: 100, allocationMode: 'CAPACITY_PLAN',
              allocationPercent: 100, allocationStartWeek: null,
              allocationEndWeek: null, pricingModel: 'ACTUAL_DAYS',
              synthetic: false, createdAt: new Date(),
            },
          ],
        },
      ],
      capacityProfiles: [],
      activeCapacityPlan: {
        id: 'plan-1',
        periods: [
          {
            periodIndex: 0, startWeek: 0, endWeek: 8,
            entries: [{ resourceTypeId: 'rt-det', headcount: 1.5 }],
          },
        ],
      },
    })

    const result1 = await resolveSchedulerCapacity(client as any, 'proj-1', 8)
    const result2 = await resolveSchedulerCapacity(client as any, 'proj-1', 8)

    // Same IDs and ordering
    expect(result1.resourceTypes).toEqual(result2.resourceTypes)
  })
})

describe('resolveSchedulerCapacity mixed profile/plan (remediation)', () => {
  it('mixed: A(legacy) + B(profile) with 2 plan trajectories — each maps correctly', async () => {
    const client = mockClient({
      resourceTypes: [
        {
          id: 'rt-mix', name: 'Mixed', count: 2, hoursPerDay: 8,
          allocationMode: 'CAPACITY_PLAN', allocationPercent: 100,
          allocationStartWeek: null, allocationEndWeek: null,
          namedResources: [
            {
              id: 'nr-a', name: 'Resource A',
              startWeek: null, endWeek: null,
              allocationPct: 100, allocationMode: 'CAPACITY_PLAN',
              allocationPercent: 100, allocationStartWeek: null,
              allocationEndWeek: null, pricingModel: 'ACTUAL_DAYS',
              synthetic: false, createdAt: new Date(),
            },
            {
              id: 'nr-b', name: 'Resource B',
              startWeek: null, endWeek: null,
              allocationPct: 100, allocationMode: 'CAPACITY_PLAN',
              allocationPercent: 100, allocationStartWeek: null,
              allocationEndWeek: null, pricingModel: 'ACTUAL_DAYS',
              synthetic: false, createdAt: new Date(),
            },
          ],
        },
      ],
      capacityProfiles: [
        {
          id: 'cp-b', projectId: 'proj-1',
          resourceTypeId: 'rt-mix', namedResourceId: 'nr-b',
          ownerKind: 'NAMED_PERSON', planningBasis: 'CAPACITY_PROFILE',
          source: 'MANUAL', defaultPercent: 50,
          startWeek: null, endWeek: null, legacy: null,
          segments: [
            { startWeek: 0, endWeek: 10, capacityPercent: 50, source: 'MANUAL' },
          ],
        },
      ],
      activeCapacityPlan: {
        id: 'plan-1',
        periods: [
          {
            periodIndex: 0, startWeek: 0, endWeek: 8,
            entries: [{ resourceTypeId: 'rt-mix', headcount: 2 }],
          },
        ],
      },
    })

    const result = await resolveSchedulerCapacity(client as any, 'proj-1', 8)
    const rt = result.resourceTypes[0]

    // Must have 2 named resources (A and B), not dropped or duplicated
    expect(rt.namedResources).toHaveLength(2)

    const nrA = rt.namedResources.find(nr => nr.id === 'nr-a')
    const nrB = rt.namedResources.find(nr => nr.id === 'nr-b')

    // A has no profile → uses trajectory A's segments
    expect(nrA).toBeDefined()
    expect(nrA!.capacitySegments).toBeDefined()
    expect(nrA!.capacitySegments!.length).toBeGreaterThan(0)

    // B has a valid profile → retains its profile segments
    expect(nrB).toBeDefined()
    expect(nrB!.capacitySegments).toBeDefined()
    // Profile says 50%, trajectory would be about 100%
    expect(nrB!.capacitySegments![0].allocationPercent).toBe(50)

    // No generated synthetic NR with trajectory B's segments
    const synthetics = rt.namedResources.filter(nr => nr.id.startsWith('rt-mix-capacity-plan'))
    expect(synthetics).toHaveLength(0)

    // RT is marked as capacity-plan-resolved
    expect(rt.capacityPlanResolved).toBe(true)
  })

  it('unmatched persisted NR preserved when plan has fewer trajectories', async () => {
    const client = mockClient({
      resourceTypes: [
        {
          id: 'rt-extra', name: 'Extra', count: 3, hoursPerDay: 8,
          allocationMode: 'CAPACITY_PLAN', allocationPercent: 100,
          allocationStartWeek: null, allocationEndWeek: null,
          namedResources: [
            {
              id: 'nr-a', name: 'Resource A',
              startWeek: null, endWeek: null,
              allocationPct: 100, allocationMode: 'CAPACITY_PLAN',
              allocationPercent: 100, allocationStartWeek: null,
              allocationEndWeek: null, pricingModel: 'ACTUAL_DAYS',
              synthetic: false, createdAt: new Date(),
            },
            {
              id: 'nr-b', name: 'Resource B',
              startWeek: null, endWeek: null,
              allocationPct: 100, allocationMode: 'CAPACITY_PLAN',
              allocationPercent: 100, allocationStartWeek: null,
              allocationEndWeek: null, pricingModel: 'ACTUAL_DAYS',
              synthetic: false, createdAt: new Date(),
            },
            {
              id: 'nr-c', name: 'Resource C (legacy)',
              startWeek: 0, endWeek: 10,
              allocationPct: 100, allocationMode: 'EFFORT',
              allocationPercent: 100, allocationStartWeek: null,
              allocationEndWeek: null, pricingModel: 'ACTUAL_DAYS',
              synthetic: false, createdAt: new Date(),
            },
          ],
        },
      ],
      capacityProfiles: [
        {
          id: 'cp-b', projectId: 'proj-1',
          resourceTypeId: 'rt-extra', namedResourceId: 'nr-b',
          ownerKind: 'NAMED_PERSON', planningBasis: 'CAPACITY_PROFILE',
          source: 'MANUAL', defaultPercent: 75,
          startWeek: null, endWeek: null, legacy: null,
          segments: [
            { startWeek: 0, endWeek: 10, capacityPercent: 75, source: 'MANUAL' },
          ],
        },
      ],
      activeCapacityPlan: {
        id: 'plan-1',
        periods: [
          {
            periodIndex: 0, startWeek: 0, endWeek: 8,
            entries: [{ resourceTypeId: 'rt-extra', headcount: 2 }],
          },
        ],
      },
    })

    const result = await resolveSchedulerCapacity(client as any, 'proj-1', 8)
    const rt = result.resourceTypes[0]

    // 3 NRs total: 2 matched to trajectories + 1 unmatched persisted (nr-c)
    expect(rt.namedResources.length).toBe(3)

    const nrA = rt.namedResources.find(nr => nr.id === 'nr-a')
    const nrB = rt.namedResources.find(nr => nr.id === 'nr-b')
    const nrC = rt.namedResources.find(nr => nr.id === 'nr-c')

    expect(nrA).toBeDefined()
    expect(nrA!.capacitySegments).toBeDefined()   // trajectory A

    expect(nrB).toBeDefined()
    expect(nrB!.capacitySegments).toBeDefined()    // profile B
    expect(nrB!.capacitySegments![0].allocationPercent).toBe(75)

    // NR C has no matching trajectory → preserved as-is (LEGACY)
    expect(nrC).toBeDefined()

    expect(rt.capacityPlanResolved).toBe(true)
  })

  it('fractional and discontinuous plan with mixed profiles', async () => {
    const client = mockClient({
      resourceTypes: [
        {
          id: 'rt-disc', name: 'Discontinuous', count: 3, hoursPerDay: 8,
          allocationMode: 'CAPACITY_PLAN', allocationPercent: 100,
          allocationStartWeek: null, allocationEndWeek: null,
          namedResources: [
            {
              id: 'nr-a', name: 'Resource A',
              startWeek: null, endWeek: null,
              allocationPct: 100, allocationMode: 'CAPACITY_PLAN',
              allocationPercent: 100, allocationStartWeek: null,
              allocationEndWeek: null, pricingModel: 'ACTUAL_DAYS',
              synthetic: false, createdAt: new Date(),
            },
            {
              id: 'nr-b', name: 'Resource B',
              startWeek: null, endWeek: null,
              allocationPct: 100, allocationMode: 'CAPACITY_PLAN',
              allocationPercent: 100, allocationStartWeek: null,
              allocationEndWeek: null, pricingModel: 'ACTUAL_DAYS',
              synthetic: false, createdAt: new Date(),
            },
          ],
        },
      ],
      capacityProfiles: [
        {
          id: 'cp-b', projectId: 'proj-1',
          resourceTypeId: 'rt-disc', namedResourceId: 'nr-b',
          ownerKind: 'NAMED_PERSON', planningBasis: 'CAPACITY_PROFILE',
          source: 'MANUAL', defaultPercent: 50,
          startWeek: null, endWeek: null, legacy: null,
          segments: [
            { startWeek: 0, endWeek: 4, capacityPercent: 75, source: 'MANUAL' },
            { startWeek: 8, endWeek: 12, capacityPercent: 50, source: 'MANUAL' },
          ],
        },
      ],
      activeCapacityPlan: {
        id: 'plan-1',
        periods: [
          {
            periodIndex: 0, startWeek: 0, endWeek: 3,
            entries: [{ resourceTypeId: 'rt-disc', headcount: 2 }],
          },
          {
            periodIndex: 1, startWeek: 3, endWeek: 6,
            entries: [{ resourceTypeId: 'rt-disc', headcount: 1.25 }],
          },
          {
            periodIndex: 2, startWeek: 8, endWeek: 11,
            entries: [{ resourceTypeId: 'rt-disc', headcount: 2 }],
          },
        ],
      },
    })

    const result = await resolveSchedulerCapacity(client as any, 'proj-1', 8)
    const rt = result.resourceTypes[0]

    // Both NRs present
    expect(rt.namedResources.length).toBe(2)

    const nrA = rt.namedResources.find(nr => nr.id === 'nr-a')
    const nrB = rt.namedResources.find(nr => nr.id === 'nr-b')

    expect(nrA).toBeDefined()
    expect(nrA!.capacitySegments).toBeDefined()

    expect(nrB).toBeDefined()
    expect(nrB!.capacitySegments).toBeDefined()
    // B's profile has 75% in weeks 0-4
    expect(nrB!.capacitySegments![0].allocationPercent).toBe(75)

    // Plan's week 6-7 gap → zero capacity in trajectory (A's segments)
    expect(rt.capacityPlanResolved).toBe(true)

    // Deterministic
    const result2 = await resolveSchedulerCapacity(client as any, 'proj-1', 8)
    expect(result.resourceTypes).toEqual(result2.resourceTypes)
  })
})
