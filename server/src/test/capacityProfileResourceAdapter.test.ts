import { describe, it, expect } from 'vitest'
import { buildResourceCapacityProfileMap } from '../lib/capacityProfileResourceAdapter.js'

// ── Helper to create a minimal project-like object ────────────────────────────

function makeProject(overrides?: Record<string, unknown>) {
  return {
    id: 'proj-1',
    hoursPerDay: 8,
    resourceTypes: [],
    capacityPlans: [],
    capacityProfiles: [],
    ...overrides,
  }
}

function makeResourceType(overrides?: Record<string, unknown>) {
  return {
    id: 'rt-1',
    name: 'Engineer',
    allocationMode: 'EFFORT',
    allocationPercent: 100,
    allocationStartWeek: null,
    allocationEndWeek: null,
    count: 1,
    hoursPerDay: 8,
    synthetic: false,
    namedResources: [],
    ...overrides,
  }
}

function makeNamedResource(overrides?: Record<string, unknown>) {
  return {
    id: 'nr-1',
    name: 'Alice',
    allocationMode: 'EFFORT',
    allocationPercent: 100,
    allocationStartWeek: null,
    allocationEndWeek: null,
    startWeek: null,
    endWeek: null,
    pricingModel: 'ACTUAL_DAYS',
    synthetic: false,
    ...overrides,
  }
}


describe('buildResourceCapacityProfileMap', () => {
  it('returns empty map for project with no resource types', () => {
    const result = buildResourceCapacityProfileMap(makeProject())
    expect(result.size).toBe(0)
  })

  it('returns legacy-derived data for a role-level resource type (no persisted)', () => {
    const project = makeProject({
      resourceTypes: [
        makeResourceType({
          id: 'rt-1',
          name: 'Engineer',
          allocationMode: 'EFFORT',
          allocationPercent: 100,
        }),
      ],
    })
    const result = buildResourceCapacityProfileMap(project)
    expect(result.size).toBe(1)
    const data = result.get('rt-1')
    expect(data).toBeDefined()
    // EFFORT → planningBasis: demandFollowing, source: fixed
    expect(data!.planningBasis).toBe('demandFollowing')
    expect(data!.source).toBe('fixed')
    expect(data!.segments).toHaveLength(0)
  })

  it('returns legacy-derived data for a named person (no persisted)', () => {
    const project = makeProject({
      resourceTypes: [
        makeResourceType({
          id: 'rt-1',
          namedResources: [
            makeNamedResource({
              id: 'nr-1',
              name: 'Alice',
              allocationMode: 'EFFORT',
            }),
          ],
        }),
      ],
    })
    const result = buildResourceCapacityProfileMap(project)
    expect(result.size).toBe(1)
    // Named-person profiles are keyed by namedResourceId, not resourceTypeId
    expect(result.has('rt-1')).toBe(false)
    const nrData = result.get('nr-1')
    expect(nrData).toBeDefined()
    expect(nrData!.planningBasis).toBe('demandFollowing')
    expect(nrData!.source).toBe('fixed')
  })

  it('returns persisted profile data when profiles exist and reconcile', () => {
    // TIMELINE allocation → legacy produces planningBasis: availabilityWindow, source: availabilityWindow
    // Persisted AVAILABILITY_WINDOW → normalize → availabilityWindow → match
    const project = makeProject({
      resourceTypes: [
        makeResourceType({
          id: 'rt-1',
          name: 'Engineer',
          allocationMode: 'TIMELINE',
          allocationPercent: 75,
          allocationStartWeek: 2,
          allocationEndWeek: 10,
        }),
      ],
      capacityProfiles: [
        {
          id: 'cp-1',
          ownerKind: 'ROLE',
          resourceTypeId: 'rt-1',
          namedResourceId: null,
          planningBasis: 'AVAILABILITY_WINDOW',
          source: 'AVAILABILITY_WINDOW',
          defaultPercent: 75,
          startWeek: 2,
          endWeek: 10,
          segments: [],
        },
      ],
    })
    const result = buildResourceCapacityProfileMap(project)
    expect(result.size).toBe(1)
    const data = result.get('rt-1')
    expect(data).toBeDefined()
    expect(data!.planningBasis).toBe('availabilityWindow')
    expect(data!.source).toBe('availabilityWindow')
    expect(data!.segments).toHaveLength(0)
  })

  it('falls back to legacy when persisted profiles do not reconcile', () => {
    // EFFORT → planningBasis: demandFollowing, source: fixed
    // Persisted CAPACITY_PROFILE/SQUAD_PLANNER → mismatch
    const project = makeProject({
      resourceTypes: [
        makeResourceType({
          id: 'rt-1',
          name: 'Engineer',
          allocationMode: 'EFFORT',
          allocationPercent: 100,
        }),
      ],
      capacityProfiles: [
        {
          id: 'cp-1',
          ownerKind: 'ROLE',
          resourceTypeId: 'rt-1',
          namedResourceId: null,
          planningBasis: 'CAPACITY_PROFILE',
          source: 'SQUAD_PLANNER',
          defaultPercent: 100,
          startWeek: null,
          endWeek: null,
          segments: [
            {
              id: 'seg-1',
              capacityProfileId: 'cp-1',
              startWeek: 0,
              endWeek: 7,
              capacityPercent: 50,
              source: 'SQUAD_PLANNER',
            },
          ],
        },
      ],
    })
    const result = buildResourceCapacityProfileMap(project)
    expect(result.size).toBe(1)
    const data = result.get('rt-1')
    expect(data).toBeDefined()
    // Falls back to legacy
    expect(data!.planningBasis).toBe('demandFollowing')
    expect(data!.source).toBe('fixed')
  })

  it('named person with multiple capacity segments remains one entry', () => {
    const nrId = 'nr-1'
    const project = makeProject({
      resourceTypes: [
        makeResourceType({
          id: 'rt-1',
          name: 'Engineer',
          allocationMode: 'TIMELINE',
          allocationPercent: 100,
          count: 2,
          namedResources: [
            makeNamedResource({
              id: nrId,
              name: 'Alice',
              allocationMode: 'TIMELINE',
              allocationPercent: 100,
              startWeek: 0,
              endWeek: 7,
            }),
          ],
        }),
      ],
      capacityProfiles: [
        {
          id: 'cp-1',
          ownerKind: 'NAMED_PERSON',
          resourceTypeId: 'rt-1',
          namedResourceId: nrId,
          planningBasis: 'AVAILABILITY_WINDOW',
          source: 'AVAILABILITY_WINDOW',
          defaultPercent: 100,
          startWeek: 0,
          endWeek: 7,
          segments: [
            { id: 'seg-1', capacityProfileId: 'cp-1', startWeek: 0, endWeek: 3, capacityPercent: 50, source: 'AVAILABILITY_WINDOW' },
            { id: 'seg-2', capacityProfileId: 'cp-1', startWeek: 4, endWeek: 7, capacityPercent: 100, source: 'AVAILABILITY_WINDOW' },
          ],
        },
      ],
    })

    const result = buildResourceCapacityProfileMap(project)
    // Single entry keyed by nrId
    expect(result.size).toBe(1)
    expect(result.has(nrId)).toBe(true)
    expect(result.has('rt-1')).toBe(false)

    const data = result.get(nrId)!
    expect(data.planningBasis).toBe('availabilityWindow')
    // Legacy TIMELINE mapper produces 0 segments; persisted has 2 segments but
    // compareCapacityProfiles detects the mismatch and falls back to legacy.
    // The contract tested here is single-entry identity, not segment population.
    expect(data.segments).toHaveLength(0)
  })

  it('handles planned resource (synthetic) profile', () => {
    const nrId = 'nr-planned-1'
    const project = makeProject({
      resourceTypes: [
        makeResourceType({
          id: 'rt-1',
          name: 'Engineer',
          namedResources: [
            makeNamedResource({
              id: nrId,
              name: 'Resource 1',
              allocationMode: 'CAPACITY_PLAN',
              synthetic: true,
              allocationPercent: 100,
              startWeek: 0,
              endWeek: 7,
            }),
          ],
        }),
      ],
      capacityPlans: [
        {
          id: 'plan-1',
          isActive: true,
          periods: [
            {
              periodIndex: 0,
              startWeek: 0,
              endWeek: 7,
              entries: [
                { resourceTypeId: 'rt-1', headcount: 1, demandFTE: 1, utilisationPct: 100 },
              ],
            },
          ],
        },
      ],
      capacityProfiles: [
        {
          id: 'cp-1',
          ownerKind: 'PLANNED_RESOURCE',
          resourceTypeId: 'rt-1',
          namedResourceId: nrId,
          planningBasis: 'CAPACITY_PROFILE',
          source: 'SQUAD_PLANNER',
          defaultPercent: 100,
          startWeek: null,
          endWeek: null,
          segments: [
            { id: 'seg-1', capacityProfileId: 'cp-1', startWeek: 0, endWeek: 7, capacityPercent: 100, source: 'SQUAD_PLANNER' },
          ],
        },
      ],
    })

    const result = buildResourceCapacityProfileMap(project)
    expect(result.size).toBe(1)
    expect(result.has(nrId)).toBe(true)
    const data = result.get(nrId)!
    expect(data.planningBasis).toBe('capacityProfile')
    expect(data.source).toBe('squadPlanner')
    expect(data.segments).toHaveLength(1)
  })
})
