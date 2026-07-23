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

  it('role profile is tracked in roleProfileRTIds metadata', async () => {
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
            { startWeek: 0, endWeek: 10, capacityPercent: 100, source: 'MANUAL' },
          ],
        },
      ],
    })

    const result = await resolveSchedulerCapacity(client as any, 'proj-1', 8)
    expect(result.meta.roleProfileRTIds).toContain('rt-1')
    expect(result.resourceTypes[0].namedResources).toHaveLength(0)
    // Phantom slots still apply when no named resources exist
    expect(result.meta.legacyCount).toBe(0)
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
