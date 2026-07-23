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
    expect(nr.capacitySegments![0]).toEqual({ startWeek: 0, endWeek: 5, capacityPercent: 100 })
    expect(nr.capacitySegments![1]).toEqual({ startWeek: 6, endWeek: 10, capacityPercent: 50 })
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
    expect(nr.capacitySegments![0].capacityPercent).toBe(25)
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

  it('deterministic ordering and repeated results', async () => {
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

  it('capacity plan is materialized and returned', async () => {
    const client = mockClient({
      resourceTypes: [
        {
          id: 'rt-1', name: 'Developer', count: 1, hoursPerDay: 8,
          allocationMode: 'CAPACITY_PLAN', allocationPercent: 100,
          allocationStartWeek: null, allocationEndWeek: null,
          namedResources: [],
        },
      ],
      activeCapacityPlan: {
        id: 'plan-1',
        periods: [
          {
            periodIndex: 0, startWeek: 0, endWeek: 4,
            entries: [{ resourceTypeId: 'rt-1', headcount: 2 }],
          },
          {
            periodIndex: 1, startWeek: 5, endWeek: 8,
            entries: [{ resourceTypeId: 'rt-1', headcount: 1 }],
          },
        ],
      },
    })

    const result = await resolveSchedulerCapacity(client as any, 'proj-1', 8)
    expect(result.capacityPlanByRt.has('rt-1')).toBe(true)
    const plan = result.capacityPlanByRt.get('rt-1')!
    expect(plan.weeklyHeadcount.get(0)).toBe(2)
    expect(plan.weeklyHeadcount.get(5)).toBe(1)
  })
})
