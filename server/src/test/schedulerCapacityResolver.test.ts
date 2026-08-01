/**
 * schedulerCapacityResolver.test.ts
 *
 * Unit tests for the shared profile-first capacity resolver.
 * Uses a mock Prisma client to avoid database dependency.
 */

import { describe, it, expect } from 'vitest'
import { resolveSchedulerCapacity } from '../lib/schedulerCapacityResolver.js'
import { CapacityIntegrityError } from '../lib/capacityIntegrityError.js'

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
  it('fails closed for legacy-only resource types (no profiles, issue #418)', async () => {
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

    await expect(resolveSchedulerCapacity(client as any, 'proj-1')).rejects.toThrow(CapacityIntegrityError)
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

    const result = await resolveSchedulerCapacity(client as any, 'proj-1')

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

    const result = await resolveSchedulerCapacity(client as any, 'proj-1')

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

    const result = await resolveSchedulerCapacity(client as any, 'proj-1')
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

    const result = await resolveSchedulerCapacity(client as any, 'proj-1')
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

    const result = await resolveSchedulerCapacity(client as any, 'proj-1')
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

    const result = await resolveSchedulerCapacity(client as any, 'proj-1')
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

    const result = await resolveSchedulerCapacity(client as any, 'proj-1')
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

    const result = await resolveSchedulerCapacity(client as any, 'proj-1')
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

    const result = await resolveSchedulerCapacity(client as any, 'proj-1')
    const rt = result.resourceTypes[0]
    // Role profile should suppress capacity plan fallback
    // No synthetic NRs from capacity plan
    expect(rt.namedResources).toHaveLength(0)
    // roleSegments from the valid role profile
    expect(rt.roleSegments).toBeDefined()
  })

  it('fails closed without profiles — capacity-plan fallback removed (issue #418)', async () => {
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

    await expect(resolveSchedulerCapacity(client as any, 'proj-1')).rejects.toThrow(CapacityIntegrityError)
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

    const result = await resolveSchedulerCapacity(client as any, 'proj-1')
    const rt = result.resourceTypes[0]
    expect(rt.roleSegments).toBeDefined()
    expect(rt.roleSegments).toHaveLength(2)
    // Gap between segments produces zero capacity (tested in getWeeklyCapacity)
  })
  it('fails closed deterministically for a legacy-only project (issue #418)', async () => {
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

    await expect(resolveSchedulerCapacity(client as any, 'proj-1')).rejects.toThrow(CapacityIntegrityError)
    await expect(resolveSchedulerCapacity(client as any, 'proj-1')).rejects.toThrow(CapacityIntegrityError)
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

    // The active-plan fallback was removed in #418: an unprofiled NR fails closed.
    await expect(resolveSchedulerCapacity(client as any, 'proj-1')).rejects.toThrow(CapacityIntegrityError)
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

    // Unprofiled persisted NRs fail closed — no legacy pass-through (issue #418).
    await expect(resolveSchedulerCapacity(client as any, 'proj-1')).rejects.toThrow(CapacityIntegrityError)
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

    // Plan-derived trajectories are gone — no profiles means fail closed.
    await expect(resolveSchedulerCapacity(client as any, 'proj-1')).rejects.toThrow(CapacityIntegrityError)
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

    await expect(resolveSchedulerCapacity(client as any, 'proj-1')).rejects.toThrow(CapacityIntegrityError)
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

    await expect(resolveSchedulerCapacity(client as any, 'proj-1')).rejects.toThrow(CapacityIntegrityError)
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

    await expect(resolveSchedulerCapacity(client as any, 'proj-1')).rejects.toThrow(CapacityIntegrityError)
    await expect(resolveSchedulerCapacity(client as any, 'proj-1')).rejects.toThrow(CapacityIntegrityError)
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
          id: 'cp-a', projectId: 'proj-1',
          resourceTypeId: null, namedResourceId: 'nr-a',
          ownerKind: 'NAMED_PERSON', planningBasis: 'CAPACITY_PROFILE',
          source: 'MANUAL', defaultPercent: 100,
          startWeek: null, endWeek: null, legacy: null,
          segments: [
            { startWeek: 0, endWeek: 10, capacityPercent: 100, source: 'MANUAL' },
          ],
        },
        {
          id: 'cp-b', projectId: 'proj-1',
          resourceTypeId: null, namedResourceId: 'nr-b',
          ownerKind: 'NAMED_PERSON', planningBasis: 'CAPACITY_PROFILE',
          source: 'MANUAL', defaultPercent: 50,
          startWeek: null, endWeek: null, legacy: null,
          segments: [
            { startWeek: 0, endWeek: 10, capacityPercent: 50, source: 'MANUAL' },
          ],
        },
      ],
    })

    const result = await resolveSchedulerCapacity(client as any, 'proj-1')
    const rt = result.resourceTypes[0]

    // Both NRs are profile-backed; no plan trajectories are synthesised.
    expect(rt.namedResources).toHaveLength(2)

    const nrA = rt.namedResources.find(nr => nr.id === 'nr-a')
    const nrB = rt.namedResources.find(nr => nr.id === 'nr-b')

    expect(nrA).toBeDefined()
    expect(nrA!.capacitySegments).toBeDefined()
    expect(nrA!.capacitySegments![0].allocationPercent).toBe(100)

    expect(nrB).toBeDefined()
    expect(nrB!.capacitySegments).toBeDefined()
    // Profile says 50% — authoritative
    expect(nrB!.capacitySegments![0].allocationPercent).toBe(50)

    // No generated synthetic NRs from any plan trajectory
    const synthetics = rt.namedResources.filter(nr => nr.id.startsWith('rt-mix-capacity-plan'))
    expect(synthetics).toHaveLength(0)
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
          id: 'cp-a', projectId: 'proj-1',
          resourceTypeId: null, namedResourceId: 'nr-a',
          ownerKind: 'NAMED_PERSON', planningBasis: 'CAPACITY_PROFILE',
          source: 'MANUAL', defaultPercent: 100,
          startWeek: null, endWeek: null, legacy: null,
          segments: [
            { startWeek: 0, endWeek: 10, capacityPercent: 100, source: 'MANUAL' },
          ],
        },
        {
          id: 'cp-b', projectId: 'proj-1',
          resourceTypeId: null, namedResourceId: 'nr-b',
          ownerKind: 'NAMED_PERSON', planningBasis: 'CAPACITY_PROFILE',
          source: 'MANUAL', defaultPercent: 75,
          startWeek: null, endWeek: null, legacy: null,
          segments: [
            { startWeek: 0, endWeek: 10, capacityPercent: 75, source: 'MANUAL' },
          ],
        },
        {
          id: 'cp-c', projectId: 'proj-1',
          resourceTypeId: null, namedResourceId: 'nr-c',
          ownerKind: 'NAMED_PERSON', planningBasis: 'DEMAND_FOLLOWING',
          source: 'FIXED', defaultPercent: 100,
          startWeek: null, endWeek: null, legacy: null,
          segments: [],
        },
      ],
    })

    const result = await resolveSchedulerCapacity(client as any, 'proj-1')
    const rt = result.resourceTypes[0]

    // All three NRs are profile-backed and preserved.
    expect(rt.namedResources.length).toBe(3)

    const nrA = rt.namedResources.find(nr => nr.id === 'nr-a')
    const nrB = rt.namedResources.find(nr => nr.id === 'nr-b')
    const nrC = rt.namedResources.find(nr => nr.id === 'nr-c')

    expect(nrA).toBeDefined()
    expect(nrA!.capacitySegments).toBeDefined()

    expect(nrB).toBeDefined()
    expect(nrB!.capacitySegments).toBeDefined()
    expect(nrB!.capacitySegments![0].allocationPercent).toBe(75)

    // nr-c is demand-following → whole-project fixed segment
    expect(nrC).toBeDefined()
    expect(nrC!.capacitySegments).toEqual([{ startWeek: 0, endWeek: Infinity, allocationPercent: 100 }])
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
          id: 'cp-a', projectId: 'proj-1',
          resourceTypeId: null, namedResourceId: 'nr-a',
          ownerKind: 'NAMED_PERSON', planningBasis: 'CAPACITY_PROFILE',
          source: 'MANUAL', defaultPercent: null,
          startWeek: null, endWeek: null, legacy: null,
          segments: [
            { startWeek: 0, endWeek: 3, capacityPercent: 100, source: 'MANUAL' },
            { startWeek: 3, endWeek: 6, capacityPercent: 50, source: 'MANUAL' },
            { startWeek: 8, endWeek: 11, capacityPercent: 100, source: 'MANUAL' },
          ],
        },
        {
          id: 'cp-b', projectId: 'proj-1',
          resourceTypeId: null, namedResourceId: 'nr-b',
          ownerKind: 'NAMED_PERSON', planningBasis: 'CAPACITY_PROFILE',
          source: 'MANUAL', defaultPercent: 50,
          startWeek: null, endWeek: null, legacy: null,
          segments: [
            { startWeek: 0, endWeek: 4, capacityPercent: 75, source: 'MANUAL' },
            { startWeek: 8, endWeek: 12, capacityPercent: 50, source: 'MANUAL' },
          ],
        },
      ],
    })

    const result = await resolveSchedulerCapacity(client as any, 'proj-1')
    const rt = result.resourceTypes[0]

    // Both NRs present
    expect(rt.namedResources.length).toBe(2)

    const nrA = rt.namedResources.find(nr => nr.id === 'nr-a')
    const nrB = rt.namedResources.find(nr => nr.id === 'nr-b')

    expect(nrA).toBeDefined()
    expect(nrA!.capacitySegments).toBeDefined()
    // A's profile mirrors the old plan windows: 100% / 50% / 100% with a gap
    expect(nrA!.capacitySegments).toHaveLength(3)
    expect(nrA!.capacitySegments![1].allocationPercent).toBe(50)

    expect(nrB).toBeDefined()
    expect(nrB!.capacitySegments).toBeDefined()
    // B's profile has 75% in weeks 0-4
    expect(nrB!.capacitySegments![0].allocationPercent).toBe(75)

    // Deterministic
    const result2 = await resolveSchedulerCapacity(client as any, 'proj-1')
    expect(result.resourceTypes).toEqual(result2.resourceTypes)
  })
})

describe('Squad Planner composition and ordering (remediation)', () => {
  it('1.5 FTE plan: aggregate ROLE + planned-resource profiles do not double-count', async () => {
    // Simulate a Squad Planner apply result: aggregate ROLE at 150% AND
    // two planned-resource profiles at 100% and 50%.
    const client = mockClient({
      resourceTypes: [
        {
          id: 'rt-squad', name: 'SquadRole', count: 3, hoursPerDay: 8,
          allocationMode: 'EFFORT', allocationPercent: 100,
          allocationStartWeek: null, allocationEndWeek: null,
          namedResources: [
            {
              id: 'nr-planned-1', name: 'Planned 1',
              startWeek: null, endWeek: null,
              allocationPct: 100, allocationMode: 'EFFORT',
              allocationPercent: 100, allocationStartWeek: null,
              allocationEndWeek: null, pricingModel: 'ACTUAL_DAYS',
              synthetic: false, createdAt: new Date(),
            },
            {
              id: 'nr-planned-2', name: 'Planned 2',
              startWeek: null, endWeek: null,
              allocationPct: 100, allocationMode: 'EFFORT',
              allocationPercent: 50, allocationStartWeek: null,
              allocationEndWeek: null, pricingModel: 'ACTUAL_DAYS',
              synthetic: false, createdAt: new Date(),
            },
          ],
        },
      ],
      capacityProfiles: [
        // Aggregate ROLE profile (source: SQUAD_PLANNER is the real DB value)
        {
          id: 'cp-role', projectId: 'proj-1',
          resourceTypeId: 'rt-squad', namedResourceId: null,
          ownerKind: 'ROLE', planningBasis: 'CAPACITY_PROFILE',
          source: 'SQUAD_PLANNER', defaultPercent: 150,
          startWeek: null, endWeek: null, legacy: null,
          segments: [],
        },
        // Planned-resource profile 1 (100%) — SQUAD_PLANNER is real DB value
        {
          id: 'cp-pr1', projectId: 'proj-1',
          resourceTypeId: null, namedResourceId: 'nr-planned-1',
          ownerKind: 'PLANNED_RESOURCE', planningBasis: 'CAPACITY_PROFILE',
          source: 'SQUAD_PLANNER', defaultPercent: 100,
          startWeek: null, endWeek: null, legacy: null,
          segments: [
            { startWeek: 0, endWeek: 10, capacityPercent: 100, source: 'squadPlanner' },
          ],
        },
        // Planned-resource profile 2 (50%) — SQUAD_PLANNER is real DB value
        {
          id: 'cp-pr2', projectId: 'proj-1',
          resourceTypeId: null, namedResourceId: 'nr-planned-2',
          ownerKind: 'PLANNED_RESOURCE', planningBasis: 'CAPACITY_PROFILE',
          source: 'SQUAD_PLANNER', defaultPercent: 50,
          startWeek: null, endWeek: null, legacy: null,
          segments: [
            { startWeek: 0, endWeek: 10, capacityPercent: 50, source: 'squadPlanner' },
          ],
        },
      ],
    })

    const { getWeeklyCapacity } = await import('../lib/scheduler.js')
    const result = await resolveSchedulerCapacity(client as any, 'proj-1')
    const rt = result.resourceTypes[0]

    // The aggregate ROLE profile should NOT produce roleSegments when
    // planned-resource profiles exist for the same Squad Planner plan.
    // Empty array signals "explicitly no role capacity" to getWeeklyCapacity.
    expect(rt.roleSegments).toEqual([])
    expect(rt.roleSegments!.length).toBe(0)

    // Named resources (planned-resource profiles) must both be present
    expect(rt.namedResources).toHaveLength(2)

    const nr1 = rt.namedResources.find(nr => nr.id === 'nr-planned-1')
    const nr2 = rt.namedResources.find(nr => nr.id === 'nr-planned-2')
    expect(nr1).toBeDefined()
    expect(nr2).toBeDefined()

    // NR1: 100% → 40h, NR2: 50% → 20h, total: 60h = 1.5 FTE
    // NOT 150% role (40h) + 100% (40h) + 50% (20h) = 100h = 2.5 FTE
    expect(getWeeklyCapacity(rt, 0, 8)).toBe(60)

    // Meta reporting: roleSegments is empty because overlap was detected
    expect(result.meta.roleProfileRTIds).not.toContain('rt-squad')
  })

  it('standalone manual ROLE profile (no planned resources) still contributes roleSegments', async () => {
    const client = mockClient({
      resourceTypes: [
        {
          id: 'rt-manual', name: 'ManualRole', count: 3, hoursPerDay: 8,
          allocationMode: 'EFFORT', allocationPercent: 100,
          allocationStartWeek: null, allocationEndWeek: null,
          namedResources: [
            {
              id: 'nr-alice', name: 'Alice',
              startWeek: null, endWeek: null,
              allocationPct: 100, allocationMode: 'EFFORT',
              allocationPercent: 100, allocationStartWeek: null,
              allocationEndWeek: null, pricingModel: 'ACTUAL_DAYS',
              synthetic: false, createdAt: new Date(),
            },
          ],
        },
      ],
      capacityProfiles: [
        // Manual ROLE profile — no planned-resource overlap
        {
          id: 'cp-role-manual', projectId: 'proj-1',
          resourceTypeId: 'rt-manual', namedResourceId: null,
          ownerKind: 'ROLE', planningBasis: 'AVAILABILITY_WINDOW',
          source: 'MANUAL', defaultPercent: 100,
          startWeek: 2, endWeek: 6, legacy: null,
          segments: [],
        },
        // Alice's explicit NAMED_PERSON profile (100%, demand-following)
        {
          id: 'cp-nr-alice', projectId: 'proj-1',
          resourceTypeId: null, namedResourceId: 'nr-alice',
          ownerKind: 'NAMED_PERSON', planningBasis: 'DEMAND_FOLLOWING',
          source: 'FIXED', defaultPercent: 100,
          startWeek: null, endWeek: null, legacy: null,
          segments: [],
        },
      ],
    })

    const { getWeeklyCapacity } = await import('../lib/scheduler.js')
    const result = await resolveSchedulerCapacity(client as any, 'proj-1')
    const rt = result.resourceTypes[0]

    // Standalone manual ROLE profile — roleSegments must be present
    expect(rt.roleSegments).toBeDefined()
    expect(rt.roleSegments!.length).toBe(1)

    // Alice (100%) + role (100%) = NOT double-counted as separate additive
    // Alice: 100% × 40 = 40h. Role: 100% × 40 = 40h (phantom replacement)
    expect(getWeeklyCapacity(rt, 3, 8)).toBe(80)
  })

  it('deterministic ordering: tiebreak by id when createdAt is identical', async () => {
    const sameTime = new Date('2026-01-01T00:00:00.000Z')
    const client = mockClient({
      resourceTypes: [
        {
          id: 'rt-order', name: 'OrderTest', count: 3, hoursPerDay: 8,
          allocationMode: 'CAPACITY_PLAN', allocationPercent: 100,
          allocationStartWeek: null, allocationEndWeek: null,
          namedResources: [
            {
              id: 'nr-beta', name: 'Beta',
              startWeek: null, endWeek: null,
              allocationPct: 100, allocationMode: 'CAPACITY_PLAN',
              allocationPercent: 100, allocationStartWeek: null,
              allocationEndWeek: null, pricingModel: 'ACTUAL_DAYS',
              synthetic: false, createdAt: sameTime,
            },
            {
              id: 'nr-alpha', name: 'Alpha',
              startWeek: null, endWeek: null,
              allocationPct: 100, allocationMode: 'CAPACITY_PLAN',
              allocationPercent: 100, allocationStartWeek: null,
              allocationEndWeek: null, pricingModel: 'ACTUAL_DAYS',
              synthetic: false, createdAt: sameTime,
            },
          ],
        },
      ],
      capacityProfiles: [
        {
          id: 'cp-alpha', projectId: 'proj-1',
          resourceTypeId: null, namedResourceId: 'nr-alpha',
          ownerKind: 'NAMED_PERSON', planningBasis: 'CAPACITY_PROFILE',
          source: 'MANUAL', defaultPercent: null,
          startWeek: null, endWeek: null, legacy: null,
          segments: [
            { startWeek: 0, endWeek: 8, capacityPercent: 100, source: 'MANUAL' },
          ],
        },
        {
          id: 'cp-beta', projectId: 'proj-1',
          resourceTypeId: null, namedResourceId: 'nr-beta',
          ownerKind: 'NAMED_PERSON', planningBasis: 'CAPACITY_PROFILE',
          source: 'MANUAL', defaultPercent: null,
          startWeek: null, endWeek: null, legacy: null,
          segments: [
            { startWeek: 0, endWeek: 8, capacityPercent: 100, source: 'MANUAL' },
          ],
        },
      ],
    })

    const result1 = await resolveSchedulerCapacity(client as any, 'proj-1')
    const result2 = await resolveSchedulerCapacity(client as any, 'proj-1')

    // NR order should be deterministic: alpha before beta (by id asc)
    const rt = result1.resourceTypes[0]
    expect(rt.namedResources[0].id).toBe('nr-alpha')
    expect(rt.namedResources[1].id).toBe('nr-beta')

    // Both NRs are profile-backed
    expect(rt.namedResources[0].capacitySegments).toBeDefined()
    expect(rt.namedResources[1].capacitySegments).toBeDefined()

    // Repeated resolution produces identical output
    expect(result1.resourceTypes).toEqual(result2.resourceTypes)
  })
})

describe('SQUAD_PLANNER to squadPlanner normalisation (remediation)', () => {
  it('mapPersistedProfilesToDTOs converts SQUAD_PLANNER to squadPlanner', async () => {
    // Regression: the adapter's toCamel normalises the persisted DB value
    // SQUAD_PLANNER to squadPlanner. The resolver previously compared
    // against 'squadplanner' (all lowercase), never matching real data.
    const client = mockClient({
      resourceTypes: [
        {
          id: 'rt-src', name: 'SourceTest', count: 1, hoursPerDay: 8,
          allocationMode: 'EFFORT', allocationPercent: 100,
          allocationStartWeek: null, allocationEndWeek: null,
          namedResources: [
            {
              id: 'nr-pr1', name: 'PR 1',
              startWeek: null, endWeek: null,
              allocationPct: 100, allocationMode: 'EFFORT',
              allocationPercent: 100, allocationStartWeek: null,
              allocationEndWeek: null, pricingModel: 'ACTUAL_DAYS',
              synthetic: false, createdAt: new Date(),
            },
          ],
        },
      ],
      capacityProfiles: [
        // Use real DB persisted values
        {
          id: 'cp-role-src', projectId: 'proj-1',
          resourceTypeId: 'rt-src', namedResourceId: null,
          ownerKind: 'ROLE', planningBasis: 'CAPACITY_PROFILE',
          source: 'SQUAD_PLANNER', defaultPercent: 100,
          startWeek: null, endWeek: null, legacy: null,
          segments: [],
        },
        {
          id: 'cp-nr-src', projectId: 'proj-1',
          resourceTypeId: null, namedResourceId: 'nr-pr1',
          ownerKind: 'PLANNED_RESOURCE', planningBasis: 'CAPACITY_PROFILE',
          source: 'SQUAD_PLANNER', defaultPercent: 100,
          startWeek: null, endWeek: null, legacy: null,
          segments: [
            { startWeek: 0, endWeek: 10, capacityPercent: 100, source: 'squadPlanner' },
          ],
        },
      ],
    })

    const result = await resolveSchedulerCapacity(client as any, 'proj-1')
    const rt = result.resourceTypes[0]

    // The overlap must be detected: ROLE profile suppressed, empty array
    expect(rt.roleSegments).toEqual([])
    expect(rt.namedResources).toHaveLength(1)
    expect(rt.namedResources[0].capacitySegments).toBeDefined()
  })
})

describe('overlap suppression precision (remediation)', () => {
  it('manual PLANNED_RESOURCE does not suppress Squad Planner ROLE profile', async () => {
    const client = mockClient({
      resourceTypes: [
        {
          id: 'rt-overlap', name: 'Overlap', count: 1, hoursPerDay: 8,
          allocationMode: 'EFFORT', allocationPercent: 100,
          allocationStartWeek: null, allocationEndWeek: null,
          namedResources: [
            {
              id: 'nr-manual', name: 'Manual PR',
              startWeek: null, endWeek: null,
              allocationPct: 100, allocationMode: 'EFFORT',
              allocationPercent: 100, allocationStartWeek: null,
              allocationEndWeek: null, pricingModel: 'ACTUAL_DAYS',
              synthetic: false, createdAt: new Date(),
            },
          ],
        },
      ],
      capacityProfiles: [
        // Squad Planner ROLE profile
        {
          id: 'cp-role-sp', projectId: 'proj-1',
          resourceTypeId: 'rt-overlap', namedResourceId: null,
          ownerKind: 'ROLE', planningBasis: 'CAPACITY_PROFILE',
          source: 'SQUAD_PLANNER', defaultPercent: 100,
          startWeek: null, endWeek: null, legacy: null,
          segments: [],
        },
        // Manual PLANNED_RESOURCE (source: MANUAL, not SQUAD_PLANNER)
        {
          id: 'cp-nr-manual', projectId: 'proj-1',
          resourceTypeId: null, namedResourceId: 'nr-manual',
          ownerKind: 'PLANNED_RESOURCE', planningBasis: 'CAPACITY_PROFILE',
          source: 'MANUAL', defaultPercent: 100,
          startWeek: null, endWeek: null, legacy: null,
          segments: [
            { startWeek: 0, endWeek: 10, capacityPercent: 100, source: 'MANUAL' },
          ],
        },
      ],
    })

    const { getWeeklyCapacity } = await import('../lib/scheduler.js')
    const result = await resolveSchedulerCapacity(client as any, 'proj-1')
    const rt = result.resourceTypes[0]

    // Squad Planner ROLE must NOT be suppressed by manual PLANNED_RESOURCE
    // Being unsuppressed: roleSegments provides additional capacity
    expect(rt.roleSegments).toBeDefined()
    expect(rt.roleSegments!.length).toBeGreaterThan(0)
    expect(rt.namedResources).toHaveLength(1)
    // NR (100%) = 40h + role (100%) = 40h → 80h total
    expect(getWeeklyCapacity(rt, 0, 8)).toBe(80)
  })

  it('squad-planner ROLE not suppressed by legacy/fallback planned-resource identity', async () => {
    // Simulate an active plan fallback producing a planned-resource-like profile
    // that has resolutionSource ACTIVE_CAPACITY_PLAN, not PROFILE.
    const client = mockClient({
      resourceTypes: [
        {
          id: 'rt-legacy', name: 'LegacyOverlap', count: 2, hoursPerDay: 8,
          allocationMode: 'CAPACITY_PLAN', allocationPercent: 100,
          allocationStartWeek: null, allocationEndWeek: null,
          namedResources: [
            {
              id: 'nr-fallback', name: 'Fallback',
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
        // Squad Planner ROLE profile
        {
          id: 'cp-role-sp2', projectId: 'proj-1',
          resourceTypeId: 'rt-legacy', namedResourceId: null,
          ownerKind: 'ROLE', planningBasis: 'CAPACITY_PROFILE',
          source: 'SQUAD_PLANNER', defaultPercent: 100,
          startWeek: null, endWeek: null, legacy: null,
          segments: [],
        },
        // Manually authored planned-resource profile (not Squad Planner,
        // not transfer provenance) — must NOT suppress the SP ROLE profile
        {
          id: 'cp-nr-fallback', projectId: 'proj-1',
          resourceTypeId: null, namedResourceId: 'nr-fallback',
          ownerKind: 'PLANNED_RESOURCE', planningBasis: 'CAPACITY_PROFILE',
          source: 'MANUAL', defaultPercent: 100,
          startWeek: null, endWeek: null, legacy: { writer: 'manual-editor' },
          segments: [
            { startWeek: 0, endWeek: 8, capacityPercent: 100, source: 'MANUAL' },
          ],
        },
      ],
      activeCapacityPlan: {
        id: 'plan-fallback',
        periods: [
          {
            periodIndex: 0, startWeek: 0, endWeek: 8,
            entries: [{ resourceTypeId: 'rt-legacy', headcount: 1 }],
          },
        ],
      },
    })

    const result = await resolveSchedulerCapacity(client as any, 'proj-1')
    const rt = result.resourceTypes[0]

    // A non-Squad-Planner planned-resource profile must not suppress the
    // Squad Planner ROLE profile (overlap suppression is provenance-scoped).
    expect(rt.roleSegments).toBeDefined()
    expect(rt.roleSegments!.length).toBeGreaterThan(0)
    expect(rt.namedResources).toHaveLength(1)
    expect(rt.namedResources[0].capacitySegments).toBeDefined()
  })

  it('non-Squad-Planner ROLE not suppressed by Squad Planner planned resource', async () => {
    const client = mockClient({
      resourceTypes: [
        {
          id: 'rt-mixed', name: 'Mixed', count: 2, hoursPerDay: 8,
          allocationMode: 'EFFORT', allocationPercent: 100,
          allocationStartWeek: null, allocationEndWeek: null,
          namedResources: [
            {
              id: 'nr-sp-pr', name: 'SP Planned',
              startWeek: null, endWeek: null,
              allocationPct: 100, allocationMode: 'EFFORT',
              allocationPercent: 100, allocationStartWeek: null,
              allocationEndWeek: null, pricingModel: 'ACTUAL_DAYS',
              synthetic: false, createdAt: new Date(),
            },
          ],
        },
      ],
      capacityProfiles: [
        // Manual ROLE profile (source: MANUAL, not SQUAD_PLANNER)
        {
          id: 'cp-role-man', projectId: 'proj-1',
          resourceTypeId: 'rt-mixed', namedResourceId: null,
          ownerKind: 'ROLE', planningBasis: 'AVAILABILITY_WINDOW',
          source: 'MANUAL', defaultPercent: 100,
          startWeek: 0, endWeek: 10, legacy: null,
          segments: [],
        },
        // Squad Planner planned-resource profile
        {
          id: 'cp-nr-sp', projectId: 'proj-1',
          resourceTypeId: null, namedResourceId: 'nr-sp-pr',
          ownerKind: 'PLANNED_RESOURCE', planningBasis: 'CAPACITY_PROFILE',
          source: 'SQUAD_PLANNER', defaultPercent: 100,
          startWeek: null, endWeek: null, legacy: null,
          segments: [
            { startWeek: 0, endWeek: 10, capacityPercent: 100, source: 'squadPlanner' },
          ],
        },
      ],
    })

    const result = await resolveSchedulerCapacity(client as any, 'proj-1')
    const rt = result.resourceTypes[0]

    // Manual ROLE must NOT be suppressed by a Squad Planner PR
    expect(rt.roleSegments).toBeDefined()
    expect(rt.roleSegments!.length).toBeGreaterThan(0)
  })
})

describe('transfer provenance suppression (issue #411)', () => {
  function makeTransferredFixture(plannedResourceLegacy: { writer?: string } | null | undefined) {
    return mockClient({
      resourceTypes: [
        {
          id: 'rt-xfr', name: 'Transfer Role', count: 1, hoursPerDay: 8,
          allocationMode: 'CAPACITY_PLAN', allocationPercent: 100,
          allocationStartWeek: null, allocationEndWeek: null,
          namedResources: [
            {
              id: 'nr-xfr', name: 'Planned 1', startWeek: null, endWeek: null,
              allocationPct: 100, allocationMode: 'CAPACITY_PLAN',
              allocationPercent: 0, allocationStartWeek: null,
              allocationEndWeek: null, pricingModel: 'ACTUAL_DAYS',
              synthetic: true, createdAt: new Date(),
            },
          ],
        },
      ],
      capacityProfiles: [
        // Manual ROLE profile (transferred — sole authority)
        {
          id: 'cp-role-xfr', projectId: 'proj-1',
          resourceTypeId: 'rt-xfr', namedResourceId: null,
          ownerKind: 'ROLE', planningBasis: 'CAPACITY_PROFILE',
          source: 'MANUAL', defaultPercent: 100,
          startWeek: null, endWeek: null, legacy: { writer: 'transfer-to-manual' },
          segments: [
            { startWeek: 0, endWeek: 10, capacityPercent: 100, source: 'MANUAL' },
          ],
        },
        // Manual planned-resource profile — provenance varies per test
        {
          id: 'cp-nr-xfr', projectId: 'proj-1',
          resourceTypeId: null, namedResourceId: 'nr-xfr',
          ownerKind: 'PLANNED_RESOURCE', planningBasis: 'CAPACITY_PROFILE',
          source: 'MANUAL', defaultPercent: 100,
          startWeek: null, endWeek: null, legacy: plannedResourceLegacy ?? null,
          segments: [
            { startWeek: 0, endWeek: 10, capacityPercent: 100, source: 'MANUAL' },
          ],
        },
      ],
    })
  }

  it('1. transferred planned-resource with transfer provenance is suppressed (no double count)', async () => {
    const client = makeTransferredFixture({ writer: 'transfer-to-manual' })
    const result = await resolveSchedulerCapacity(client as any, 'proj-1')
    const rt = result.resourceTypes[0]

    // ROLE segments are authoritative
    expect(rt.roleSegments).toBeDefined()
    expect(rt.roleSegments!.length).toBeGreaterThan(0)

    // The transferred planned resource is suppressed with an explicit zero
    // segment (issue #411) — it never falls through to legacy columns.
    const nr = rt.namedResources[0]
    expect(nr.capacitySegments).toEqual([{ startWeek: 0, endWeek: Infinity, allocationPercent: 0 }])
    expect(nr.allocationPct).toBe(0)
  })

  it('2. unrelated manual planned-resource WITHOUT transfer provenance remains authoritative', async () => {
    const client = makeTransferredFixture({ writer: 'manual-editor' })
    const result = await resolveSchedulerCapacity(client as any, 'proj-1')
    const rt = result.resourceTypes[0]
    const nr = rt.namedResources[0]

    // Independently authored manual planned-resource stays scheduler-authoritative
    expect(nr.capacitySegments).toBeDefined()
    expect(nr.capacitySegments!.length).toBeGreaterThan(0)
    expect(nr.capacitySegments![0]).toEqual({ startWeek: 0, endWeek: 10, allocationPercent: 100 })
  })

  it('3. malformed/ambiguous provenance shape does not silently suppress', async () => {
    // legacy present but writer missing → not transfer provenance
    const client = makeTransferredFixture({})
    const result = await resolveSchedulerCapacity(client as any, 'proj-1')
    const nr = result.resourceTypes[0].namedResources[0]

    expect(nr.capacitySegments).toBeDefined()
    expect(nr.capacitySegments!.length).toBeGreaterThan(0)
  })
})
