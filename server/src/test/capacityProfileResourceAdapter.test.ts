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
    expect(result.roleProfiles.size + result.namedResourceProfiles.size).toBe(0)
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
    expect(result.roleProfiles.size + result.namedResourceProfiles.size).toBe(1)
    const data = result.roleProfiles.get('rt-1')
    expect(data).toBeDefined()
    // EFFORT → planningBasis: demandFollowing, source: fixed
    expect(data!.planningBasis).toBe('demandFollowing')
    expect(data!.source).toBe('fixed')
    expect(data!.segments).toHaveLength(0)
    expect(data!.resolutionSource).toBe('LEGACY')
  })

  it('returns legacy-derived data for role AND named person independently (no persisted)', () => {
    const project = makeProject({
      resourceTypes: [
        makeResourceType({
          id: 'rt-1',
          name: 'Engineer',
          allocationMode: 'EFFORT',
          allocationPercent: 100,
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
    // New behavior: produces BOTH role entry keyed by rt-1 AND NR entry keyed by nr-1
    expect(result.roleProfiles.size + result.namedResourceProfiles.size).toBe(2)
    expect(result.roleProfiles.has('rt-1')).toBe(true)
    expect(result.namedResourceProfiles.has('nr-1')).toBe(true)

    const roleData = result.roleProfiles.get('rt-1')!
    expect(roleData.planningBasis).toBe('demandFollowing')
    expect(roleData.source).toBe('fixed')
    expect(roleData.resolutionSource).toBe('LEGACY')

    const nrData = result.namedResourceProfiles.get('nr-1')!
    expect(nrData.planningBasis).toBe('demandFollowing')
    expect(nrData.source).toBe('fixed')
    expect(nrData.resolutionSource).toBe('LEGACY')
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
    // Only role entry — no named resources
    expect(result.roleProfiles.size + result.namedResourceProfiles.size).toBe(1)
    const data = result.roleProfiles.get('rt-1')
    expect(data).toBeDefined()
    expect(data!.planningBasis).toBe('availabilityWindow')
    expect(data!.source).toBe('availabilityWindow')
    expect(data!.segments).toHaveLength(0)
  })

  it('returns persisted profile data even when legacy fields differ (profile-first)', () => {
    // EFFORT → legacy: planningBasis: demandFollowing, source: fixed
    // Persisted CAPACITY_PROFILE/SQUAD_PLANNER → authoritative
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
    expect(result.roleProfiles.size + result.namedResourceProfiles.size).toBe(1)
    const data = result.roleProfiles.get('rt-1')
    expect(data).toBeDefined()
    // Profile-first: returns persisted profile, not legacy
    expect(data!.planningBasis).toBe('capacityProfile')
    expect(data!.source).toBe('squadPlanner')
    expect(data!.resolutionSource).toBe('PROFILE')
    expect(data!.segments).toHaveLength(1)
    expect(data!.segments[0].capacityPercent).toBe(50)
  })

  it('named person with multiple capacity segments — also includes role entry', () => {
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
    // Now includes BOTH role entry and NR entry
    expect(result.roleProfiles.size + result.namedResourceProfiles.size).toBe(2)
    expect(result.namedResourceProfiles.has(nrId)).toBe(true)
    expect(result.roleProfiles.has('rt-1')).toBe(true)

    // Role entry is legacy-derived
    const roleData = result.roleProfiles.get('rt-1')!
    expect(roleData.resolutionSource).toBe('LEGACY')

    // NR entry is profile-first
    const data = result.namedResourceProfiles.get(nrId)!
    expect(data.planningBasis).toBe('availabilityWindow')
    expect(data.segments).toHaveLength(2)
    expect(data.segments[0].capacityPercent).toBe(50)
    expect(data.segments[1].capacityPercent).toBe(100)
    expect(data.resolutionSource).toBe('PROFILE')
  })

  it('handles planned resource (synthetic) profile — role entry also present', () => {
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
    // Now includes BOTH role and NR entry
    expect(result.roleProfiles.size + result.namedResourceProfiles.size).toBe(2)
    expect(result.namedResourceProfiles.has(nrId)).toBe(true)
    expect(result.roleProfiles.has('rt-1')).toBe(true)

    const data = result.namedResourceProfiles.get(nrId)!
    expect(data.planningBasis).toBe('capacityProfile')
    expect(data.source).toBe('squadPlanner')
    expect(data.segments).toHaveLength(1)
    expect(data.resolutionSource).toBe('PROFILE')
  })

  // ─── Null-window role profile ──────────────────────────────────────────

  it('role profile with null window (demandFollowing) preserves null authoritative data', () => {
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
    const data = result.roleProfiles.get('rt-1')!
    // Demand-following: startWeek and endWeek should be null
    expect(data.planningBasis).toBe('demandFollowing')
    expect(data.startWeek).toBeNull()
    expect(data.endWeek).toBeNull()
    expect(data.resolutionSource).toBe('LEGACY')
  })

  it('named resource with null window (demandFollowing) preserves null authoritative data', () => {
    const project = makeProject({
      resourceTypes: [
        makeResourceType({
          id: 'rt-1',
          name: 'Engineer',
          namedResources: [
            makeNamedResource({
              id: 'nr-1',
              name: 'Alice',
              allocationMode: 'EFFORT',
              allocationStartWeek: null,
              allocationEndWeek: null,
              startWeek: null,
              endWeek: null,
            }),
          ],
        }),
      ],
    })
    const result = buildResourceCapacityProfileMap(project)
    const nrData = result.namedResourceProfiles.get('nr-1')!
    // Demand-following from EFFORT mode → null windows
    expect(nrData.planningBasis).toBe('demandFollowing')
    expect(nrData.startWeek).toBeNull()
    expect(nrData.endWeek).toBeNull()
    expect(nrData.resolutionSource).toBe('LEGACY')
  })

  // ─── Role + NR coexistence ─────────────────────────────────────────────

  it('keeps same-resource-type role, inherited NR, and explicit NR profile ownership separate', () => {
    const rtId = 'rt-coexist'
    const nrInherited = 'nr-inherit'
    const nrExplicit = 'nr-explicit'

    const project = makeProject({
      resourceTypes: [
        makeResourceType({
          id: rtId,
          name: 'Coexist RT',
          allocationMode: 'CAPACITY_PLAN',
          allocationPercent: 70,
          namedResources: [
            makeNamedResource({
              id: nrInherited,
              name: 'Inherited NR',
              allocationMode: 'CAPACITY_PLAN',
              allocationPercent: 70,
            }),
            makeNamedResource({
              id: nrExplicit,
              name: 'Explicit NR',
              allocationMode: 'CAPACITY_PLAN',
              allocationPercent: 75,
            }),
          ],
        }),
      ],
      capacityProfiles: [
        {
          id: 'cp-role',
          ownerKind: 'ROLE',
          resourceTypeId: rtId,
          namedResourceId: null,
          planningBasis: 'CAPACITY_PROFILE',
          source: 'SQUAD_PLANNER',
          defaultPercent: 70,
          startWeek: null,
          endWeek: null,
          segments: [
            { id: 'role-seg-a', capacityProfileId: 'cp-role', startWeek: 0, endWeek: 3, capacityPercent: 50, source: 'SQUAD_PLANNER' },
            { id: 'role-seg-b', capacityProfileId: 'cp-role', startWeek: 6, endWeek: 9, capacityPercent: 100, source: 'SQUAD_PLANNER' },
          ],
        },
        {
          id: 'cp-explicit',
          ownerKind: 'NAMED_PERSON',
          resourceTypeId: null,
          namedResourceId: nrExplicit,
          planningBasis: 'CAPACITY_PROFILE',
          source: 'MANUAL',
          defaultPercent: 75,
          startWeek: null,
          endWeek: null,
          segments: [
            { id: 'nr-seg-a', capacityProfileId: 'cp-explicit', startWeek: 1, endWeek: 2, capacityPercent: 25, source: 'MANUAL' },
            { id: 'nr-seg-b', capacityProfileId: 'cp-explicit', startWeek: 4, endWeek: 7, capacityPercent: 75, source: 'MANUAL' },
          ],
        },
      ],
    })

    const result = buildResourceCapacityProfileMap(project)
    expect(result.roleProfiles.size + result.namedResourceProfiles.size).toBe(3)

    const roleData = result.roleProfiles.get(rtId)!
    expect(roleData.resolutionSource).toBe('PROFILE')
    expect(roleData.segments).toEqual([
      { startWeek: 0, endWeek: 3, capacityPercent: 50 },
      { startWeek: 6, endWeek: 9, capacityPercent: 100 },
    ])

    const inheritedData = result.namedResourceProfiles.get(nrInherited)!
    expect(inheritedData.resolutionSource).toBe('LEGACY')
    expect(inheritedData.planningBasis).toBe('capacityProfile')
    expect(inheritedData.defaultPercent).toBe(70)
    expect(inheritedData.segments).toEqual([])

    const explicitData = result.namedResourceProfiles.get(nrExplicit)!
    expect(explicitData.resolutionSource).toBe('PROFILE')
    expect(explicitData.defaultPercent).toBe(75)
    expect(explicitData.segments).toEqual([
      { startWeek: 1, endWeek: 2, capacityPercent: 25 },
      { startWeek: 4, endWeek: 7, capacityPercent: 75 },
    ])
  })

  // ─── Active plan fallback ──────────────────────────────────────────────

  it('active capacity plan fallback: produces ACTIVE_CAPACITY_PLAN when NR windows are stale', () => {
    const rtId = 'rt-plan'
    const nrId = 'nr-plan-1'

    const project = makeProject({
      resourceTypes: [
        makeResourceType({
          id: rtId,
          name: 'Plan RT',
          allocationMode: 'CAPACITY_PLAN',
          allocationPercent: 100,
          allocationStartWeek: null,
          allocationEndWeek: null,
          namedResources: [
            makeNamedResource({
              id: nrId,
              name: 'Plan NR',
              allocationMode: 'CAPACITY_PLAN',
              allocationPercent: 100,
              startWeek: null,  // stale — no window set
              endWeek: null,
            }),
          ],
        }),
      ],
      capacityPlans: [
        {
          id: 'plan-act-1',
          isActive: true,
          periods: [
            {
              periodIndex: 0,
              startWeek: 0,
              endWeek: 4,
              entries: [{ resourceTypeId: rtId, headcount: 1, demandFTE: 1, utilisationPct: 100 }],
            },
            {
              periodIndex: 1,
              startWeek: 4,
              endWeek: 8,
              entries: [{ resourceTypeId: rtId, headcount: 0.5, demandFTE: 0.5, utilisationPct: 100 }],
            },
          ],
        },
      ],
    })
    const result = buildResourceCapacityProfileMap(project)
    // RT has stale windows → shouldFallbackToActiveCapacityPlan returns true
    // Entries: role aggregate + existing NR mapped to its trajectory (1 trajectory with 2 segments)
    expect(result.roleProfiles.size + result.namedResourceProfiles.size).toBe(2)

    const roleData = result.roleProfiles.get(rtId)!
    expect(roleData.resolutionSource).toBe('ACTIVE_CAPACITY_PLAN')
    expect(roleData.planningBasis).toBe('capacityProfile')
    expect(roleData.source).toBe('squadPlanner')
    // Role gets non-overlapping aggregate role capacity: 1.0 FTE (100%) then 0.5 FTE (50%)
    expect(roleData.segments).toHaveLength(2)
    expect(roleData.segments[0]).toMatchObject({ startWeek: 0, endWeek: 3, capacityPercent: 100 })
    expect(roleData.segments[1]).toMatchObject({ startWeek: 4, endWeek: 7, capacityPercent: 50 })
    expect(roleData.defaultPercent).toBeNull()
    expect(roleData.startWeek).toBe(0)
    expect(roleData.endWeek).toBe(7)
    // Existing NR gets its trajectory segments (capacity changes from 100% to 50% at week 4)
    const nrData = result.namedResourceProfiles.get(nrId)!
    expect(nrData.resolutionSource).toBe('ACTIVE_CAPACITY_PLAN')
    expect(nrData.segments).toHaveLength(2)
    expect(nrData.segments[0]).toMatchObject({ startWeek: 0, endWeek: 3, capacityPercent: 100 })
    expect(nrData.segments[1]).toMatchObject({ startWeek: 4, endWeek: 7, capacityPercent: 50 })
    // No extra generated planned resource — single trajectory maps to existing NR
  })

  it('active capacity plan fallback: preserves persisted profile when present', () => {
    const rtId = 'rt-plan-persist'
    const nrId = 'nr-plan-persist'

    const project = makeProject({
      resourceTypes: [
        makeResourceType({
          id: rtId,
          name: 'Persist RT',
          allocationMode: 'CAPACITY_PLAN',
          allocationPercent: 100,
          allocationStartWeek: null,
          allocationEndWeek: null,
          namedResources: [
            makeNamedResource({
              id: nrId,
              name: 'Persist NR',
              allocationMode: 'CAPACITY_PLAN',
              allocationPercent: 100,
              startWeek: null,
              endWeek: null,
            }),
          ],
        }),
      ],
      capacityPlans: [
        {
          id: 'plan-act-2',
          isActive: true,
          periods: [
            {
              periodIndex: 0,
              startWeek: 0,
              endWeek: 8,
              entries: [{ resourceTypeId: rtId, headcount: 1, demandFTE: 1, utilisationPct: 100 }],
            },
          ],
        },
      ],
      // Persisted profile for the NR — should win over ACTIVE_CAPACITY_PLAN
      capacityProfiles: [
        {
          id: 'cp-persist-1',
          ownerKind: 'NAMED_PERSON',
          resourceTypeId: null,
          namedResourceId: nrId,
          planningBasis: 'AVAILABILITY_WINDOW',
          source: 'MANUAL',
          defaultPercent: 50,
          startWeek: 0,
          endWeek: 8,
          segments: [],
        },
      ],
    })

    const result = buildResourceCapacityProfileMap(project)
    // Role entry gets ACTIVE_CAPACITY_PLAN (stale), NR gets PROFILE (persisted wins)
    expect(result.roleProfiles.size + result.namedResourceProfiles.size).toBe(2)

    const roleData = result.roleProfiles.get(rtId)!
    expect(roleData.resolutionSource).toBe('ACTIVE_CAPACITY_PLAN')

    const nrData = result.namedResourceProfiles.get(nrId)!
    expect(nrData.resolutionSource).toBe('PROFILE')
    expect(nrData.planningBasis).toBe('availabilityWindow')
    expect(nrData.source).toBe('manual')
    expect(nrData.defaultPercent).toBe(50)
  })

  it('active capacity plan fallback: not triggered when shouldFallbackToActiveCapacityPlan returns false', () => {
    const rtId = 'rt-no-fallback'
    const nrId = 'nr-no-fallback'

    const project = makeProject({
      resourceTypes: [
        makeResourceType({
          id: rtId,
          name: 'NoFallback RT',
          allocationMode: 'CAPACITY_PLAN',
          allocationPercent: 100,
          allocationStartWeek: null,
          allocationEndWeek: null,
          count: 2,
          namedResources: [
            makeNamedResource({
              id: nrId,
              name: 'NoFallback NR',
              allocationMode: 'CAPACITY_PLAN',
              allocationPercent: 100,
              startWeek: 0,  // valid window matches plan
              endWeek: 7,
            }),
          ],
        }),
      ],
      capacityPlans: [
        {
          id: 'plan-ok',
          isActive: true,
          periods: [
            {
              periodIndex: 0,
              startWeek: 0,
              endWeek: 8,
              entries: [{ resourceTypeId: rtId, headcount: 1, demandFTE: 1, utilisationPct: 100 }],
            },
          ],
        },
      ],
    })

    const result = buildResourceCapacityProfileMap(project)
    // shouldFallbackToActiveCapacityPlan returns false (NR windows match plan)
    // Entries remain LEGACY (not overridden by ACTIVE_CAPACITY_PLAN)
    expect(result.roleProfiles.size + result.namedResourceProfiles.size).toBe(2)
    expect(result.roleProfiles.get(rtId)!.resolutionSource).toBe('LEGACY')
    expect(result.namedResourceProfiles.get(nrId)!.resolutionSource).toBe('LEGACY')
  })

  // ─── Duplicate handling ───────────────────────────────────────────────

  it('duplicate identical role profiles: sorted by ID, first wins', () => {
    const project = makeProject({
      resourceTypes: [
        makeResourceType({
          id: 'rt-dup',
          name: 'Dup RT',
          allocationMode: 'TIMELINE',
          allocationPercent: 75,
          allocationStartWeek: 0,
          allocationEndWeek: 8,
        }),
      ],
      capacityProfiles: [
        {
          id: 'cp-b',
          ownerKind: 'ROLE',
          resourceTypeId: 'rt-dup',
          namedResourceId: null,
          planningBasis: 'AVAILABILITY_WINDOW',
          source: 'MANUAL',
          defaultPercent: 75,
          startWeek: 0,
          endWeek: 8,
          segments: [],
        },
        {
          id: 'cp-a',
          ownerKind: 'ROLE',
          resourceTypeId: 'rt-dup',
          namedResourceId: null,
          planningBasis: 'AVAILABILITY_WINDOW',
          source: 'MANUAL',
          defaultPercent: 75,
          startWeek: 0,
          endWeek: 8,
          segments: [],
        },
      ],
    })

    const result = buildResourceCapacityProfileMap(project)
    expect(result.roleProfiles.size + result.namedResourceProfiles.size).toBe(1)
    const data = result.roleProfiles.get('rt-dup')!
    // Both are exact duplicates → smallest ID (cp-a) wins
    expect(data.resolutionSource).toBe('PROFILE')
    expect(data.defaultPercent).toBe(75)
  })

  it('duplicate conflicting role profiles: fall back to legacy with warning', () => {
    const project = makeProject({
      resourceTypes: [
        makeResourceType({
          id: 'rt-conflict',
          name: 'Conflict RT',
          allocationMode: 'TIMELINE',
          allocationPercent: 100,
          allocationStartWeek: 0,
          allocationEndWeek: 10,
        }),
      ],
      capacityProfiles: [
        {
          id: 'cp-x',
          ownerKind: 'ROLE',
          resourceTypeId: 'rt-conflict',
          namedResourceId: null,
          planningBasis: 'AVAILABILITY_WINDOW',
          source: 'MANUAL',
          defaultPercent: 75,
          startWeek: 0,
          endWeek: 8,
          segments: [],
        },
        {
          id: 'cp-y',
          ownerKind: 'ROLE',
          resourceTypeId: 'rt-conflict',
          namedResourceId: null,
          planningBasis: 'DEMAND_FOLLOWING',  // different — conflict
          source: 'FIXED',
          defaultPercent: 50,
          startWeek: null,
          endWeek: null,
          segments: [],
        },
      ],
    })

    const result = buildResourceCapacityProfileMap(project)
    expect(result.roleProfiles.size + result.namedResourceProfiles.size).toBe(1)
    const data = result.roleProfiles.get('rt-conflict')!
    // Conflict → fallback to legacy
    expect(data.resolutionSource).toBe('LEGACY')
    // Legacy has TIMELINE/100%/0-10
    expect(data.planningBasis).toBe('availabilityWindow')
    expect(data.source).toBe('availabilityWindow')
  })

  it('duplicate identical named resource profiles: sorted by ID, first wins', () => {
    const nrId = 'nr-dup'
    const project = makeProject({
      resourceTypes: [
        makeResourceType({
          id: 'rt-1',
          name: 'Engineer',
          namedResources: [
            makeNamedResource({
              id: nrId,
              name: 'Dup NR',
              allocationMode: 'TIMELINE',
              allocationPercent: 100,
              startWeek: 0,
              endWeek: 4,
            }),
          ],
        }),
      ],
      capacityProfiles: [
        {
          id: 'cp-nr-b',
          ownerKind: 'NAMED_PERSON',
          resourceTypeId: null,
          namedResourceId: nrId,
          planningBasis: 'AVAILABILITY_WINDOW',
          source: 'MANUAL',
          defaultPercent: 100,
          startWeek: 0,
          endWeek: 4,
          segments: [],
        },
        {
          id: 'cp-nr-a',
          ownerKind: 'NAMED_PERSON',
          resourceTypeId: null,
          namedResourceId: nrId,
          planningBasis: 'AVAILABILITY_WINDOW',
          source: 'MANUAL',
          defaultPercent: 100,
          startWeek: 0,
          endWeek: 4,
          segments: [],
        },
      ],
    })

    const result = buildResourceCapacityProfileMap(project)
    expect(result.roleProfiles.size + result.namedResourceProfiles.size).toBe(2) // role + NR
    const nrData = result.namedResourceProfiles.get(nrId)!
    expect(nrData.resolutionSource).toBe('PROFILE')
    // cp-nr-a wins (smaller ID)
  })

  it('duplicate conflicting named resource profiles: fall back to legacy with warning', () => {
    const nrId = 'nr-conflict'
    const project = makeProject({
      resourceTypes: [
        makeResourceType({
          id: 'rt-1',
          name: 'Engineer',
          namedResources: [
            makeNamedResource({
              id: nrId,
              name: 'Conflict NR',
              allocationMode: 'EFFORT',
              allocationPercent: 100,
            }),
          ],
        }),
      ],
      capacityProfiles: [
        {
          id: 'cp-nr-x',
          ownerKind: 'NAMED_PERSON',
          resourceTypeId: null,
          namedResourceId: nrId,
          planningBasis: 'AVAILABILITY_WINDOW',
          source: 'MANUAL',
          defaultPercent: 100,
          startWeek: 0,
          endWeek: 4,
          segments: [],
        },
        {
          id: 'cp-nr-y',
          ownerKind: 'NAMED_PERSON',
          resourceTypeId: null,
          namedResourceId: nrId,
          planningBasis: 'DEMAND_FOLLOWING',  // different — conflict
          source: 'FIXED',
          defaultPercent: 50,
          startWeek: null,
          endWeek: null,
          segments: [],
        },
      ],
    })

    const result = buildResourceCapacityProfileMap(project)
    expect(result.roleProfiles.size + result.namedResourceProfiles.size).toBe(2) // role + NR
    const nrData = result.namedResourceProfiles.get(nrId)!
    expect(nrData.resolutionSource).toBe('LEGACY')
    // Legacy has demandFollowing from EFFORT mode
    expect(nrData.planningBasis).toBe('demandFollowing')
  })

  // ─── Owner kind mismatch handling ────────────────────────────────────

  function makeOwnerKindProject(nrId: string, profiles: Record<string, unknown>[]) {
    return makeProject({
      resourceTypes: [
        makeResourceType({
          id: 'rt-1',
          name: 'Engineer',
          namedResources: [
            makeNamedResource({
              id: nrId,
              name: 'OwnerKind NR',
              allocationMode: 'EFFORT',
              allocationPercent: 100,
            }),
          ],
        }),
      ],
      capacityProfiles: profiles,
    })
  }

  it('ownerKind mismatch between duplicate profiles produces CONFLICT — order A then B', () => {
    const nrId = 'nr-ok-mismatch'
    const project = makeOwnerKindProject(nrId, [
      {
        id: 'cp-a',
        ownerKind: 'NAMED_PERSON',
        resourceTypeId: null,
        namedResourceId: nrId,
        planningBasis: 'AVAILABILITY_WINDOW',
        source: 'MANUAL',
        defaultPercent: 100,
        startWeek: 0,
        endWeek: 4,
        segments: [],
      },
      {
        id: 'cp-b',
        ownerKind: 'PLANNED_RESOURCE',
        resourceTypeId: null,
        namedResourceId: nrId,
        planningBasis: 'AVAILABILITY_WINDOW',
        source: 'MANUAL',
        defaultPercent: 100,
        startWeek: 0,
        endWeek: 4,
        segments: [],
      },
    ])

    const result = buildResourceCapacityProfileMap(project)
    expect(result.roleProfiles.size + result.namedResourceProfiles.size).toBe(2) // role + NR
    const nrData = result.namedResourceProfiles.get(nrId)!
    expect(nrData.resolutionSource).toBe('LEGACY')
    expect(nrData.resourceIdentity).toBe('NAMED_PERSON')
  })

  it('ownerKind mismatch between duplicate profiles produces CONFLICT — reverse order B then A', () => {
    const nrId = 'nr-ok-mismatch-rev'
    const project = makeOwnerKindProject(nrId, [
      {
        id: 'cp-b',
        ownerKind: 'PLANNED_RESOURCE',
        resourceTypeId: null,
        namedResourceId: nrId,
        planningBasis: 'AVAILABILITY_WINDOW',
        source: 'MANUAL',
        defaultPercent: 100,
        startWeek: 0,
        endWeek: 4,
        segments: [],
      },
      {
        id: 'cp-a',
        ownerKind: 'NAMED_PERSON',
        resourceTypeId: null,
        namedResourceId: nrId,
        planningBasis: 'AVAILABILITY_WINDOW',
        source: 'MANUAL',
        defaultPercent: 100,
        startWeek: 0,
        endWeek: 4,
        segments: [],
      },
    ])

    const result = buildResourceCapacityProfileMap(project)
    expect(result.roleProfiles.size + result.namedResourceProfiles.size).toBe(2) // role + NR
    const nrData = result.namedResourceProfiles.get(nrId)!
    expect(nrData.resolutionSource).toBe('LEGACY')
    expect(nrData.resourceIdentity).toBe('NAMED_PERSON')
  })

  it('identical duplicates with same ownerKind resolve deterministically (smallest ID wins)', () => {
    const nrId = 'nr-dup-same-kind'
    const project = makeProject({
      resourceTypes: [
        makeResourceType({
          id: 'rt-1',
          name: 'Engineer',
          namedResources: [
            makeNamedResource({
              id: nrId,
              name: 'Same Kind NR',
              allocationMode: 'TIMELINE',
              allocationPercent: 100,
              startWeek: 0,
              endWeek: 4,
            }),
          ],
        }),
      ],
      capacityProfiles: [
        {
          id: 'cp-b',  // larger ID — should lose
          ownerKind: 'NAMED_PERSON',
          resourceTypeId: null,
          namedResourceId: nrId,
          planningBasis: 'AVAILABILITY_WINDOW',
          source: 'MANUAL',
          defaultPercent: 100,
          startWeek: 0,
          endWeek: 4,
          segments: [],
        },
        {
          id: 'cp-a',  // smaller ID — wins
          ownerKind: 'NAMED_PERSON',
          resourceTypeId: null,
          namedResourceId: nrId,
          planningBasis: 'AVAILABILITY_WINDOW',
          source: 'MANUAL',
          defaultPercent: 100,
          startWeek: 0,
          endWeek: 4,
          segments: [],
        },
      ],
    })

    const result = buildResourceCapacityProfileMap(project)
    expect(result.roleProfiles.size + result.namedResourceProfiles.size).toBe(2) // role + NR
    const nrData = result.namedResourceProfiles.get(nrId)!
    expect(nrData.resolutionSource).toBe('PROFILE')
    expect(nrData.resourceIdentity).toBe('NAMED_PERSON')
    // cp-a wins (smaller ID)
  })

  it('identical duplicates with same ownerKind PLANNED_RESOURCE resolve deterministically', () => {
    const nrId = 'nr-dup-planned'
    const project = makeProject({
      resourceTypes: [
        makeResourceType({
          id: 'rt-1',
          name: 'Engineer',
          namedResources: [
            makeNamedResource({
              id: nrId,
              name: 'Planned NR',
              allocationMode: 'TIMELINE',
              allocationPercent: 100,
              startWeek: 0,
              endWeek: 4,
              synthetic: true,
            }),
          ],
        }),
      ],
      capacityProfiles: [
        {
          id: 'cp-y',  // larger ID — should lose
          ownerKind: 'PLANNED_RESOURCE',
          resourceTypeId: null,
          namedResourceId: nrId,
          planningBasis: 'AVAILABILITY_WINDOW',
          source: 'MANUAL',
          defaultPercent: 100,
          startWeek: 0,
          endWeek: 4,
          segments: [],
        },
        {
          id: 'cp-a',  // smaller ID — wins
          ownerKind: 'PLANNED_RESOURCE',
          resourceTypeId: null,
          namedResourceId: nrId,
          planningBasis: 'AVAILABILITY_WINDOW',
          source: 'MANUAL',
          defaultPercent: 100,
          startWeek: 0,
          endWeek: 4,
          segments: [],
        },
      ],
    })

    const result = buildResourceCapacityProfileMap(project)
    expect(result.roleProfiles.size + result.namedResourceProfiles.size).toBe(2) // role + NR
    const nrData = result.namedResourceProfiles.get(nrId)!
    expect(nrData.resolutionSource).toBe('PROFILE')
    expect(nrData.resourceIdentity).toBe('PLANNED_RESOURCE')
    // cp-a wins (smaller ID)
  })

  // ─── Key collision detection ──────────────────────────────────────────
  it('separate maps prevent resourceTypeId and namedResourceId collisions', () => {
    const collidingId = 'same-id-1'
    const warnings: string[] = []
    const origWarn = console.warn
    console.warn = (msg: string) => { warnings.push(msg) }

    try {
      const project = makeProject({
        resourceTypes: [
          makeResourceType({
            id: collidingId,
            name: 'Collide RT',
            allocationMode: 'EFFORT',
            namedResources: [
              makeNamedResource({
                id: collidingId,
                name: 'Collide NR',
                allocationMode: 'EFFORT',
              }),
            ],
          }),
        ],
      })
      const result = buildResourceCapacityProfileMap(project)
      // With separate role/NR maps, both entries coexist — no collision
      expect(result.roleProfiles.size + result.namedResourceProfiles.size).toBe(2)
      expect(result.roleProfiles.has(collidingId)).toBe(true)
      expect(result.namedResourceProfiles.has(collidingId)).toBe(true)
      const roleData = result.roleProfiles.get(collidingId)!
      expect(roleData.resolutionSource).toBe('LEGACY')
      const nrData = result.namedResourceProfiles.get(collidingId)!
      expect(nrData.resolutionSource).toBe('LEGACY')
      // No warnings emitted — separate maps avoid collision
      expect(warnings.some(w => w.includes('Key collision'))).toBe(false)
    } finally {
      console.warn = origWarn
    }
  })

  // ─── Commercial invariance (adapter level) ────────────────────────────

  it('commercial fields are not computed by adapter — adapter only enriches', () => {
    // The adapter returns profile enrichment data.
    // It does NOT compute commercial fields — that's the route's job.
    const project = makeProject({
      resourceTypes: [
        makeResourceType({
          id: 'rt-com',
          name: 'Commercial RT',
          allocationMode: 'TIMELINE',
          allocationPercent: 75,
          allocationStartWeek: 0,
          allocationEndWeek: 10,
          namedResources: [
            makeNamedResource({
              id: 'nr-com',
              name: 'Commercial NR',
              allocationMode: 'TIMELINE',
              allocationPercent: 75,
              allocationStartWeek: 0,
              allocationEndWeek: 10,
              startWeek: 0,
              endWeek: 10,
            }),
          ],
        }),
      ],
      capacityProfiles: [
        {
          id: 'cp-com-role',
          ownerKind: 'ROLE',
          resourceTypeId: 'rt-com',
          namedResourceId: null,
          planningBasis: 'AVAILABILITY_WINDOW',
          source: 'MANUAL',
          defaultPercent: 75,
          startWeek: 0,
          endWeek: 10,
          segments: [],
        },
        {
          id: 'cp-com-nr',
          ownerKind: 'NAMED_PERSON',
          resourceTypeId: null,
          namedResourceId: 'nr-com',
          planningBasis: 'AVAILABILITY_WINDOW',
          source: 'MANUAL',
          defaultPercent: 50,
          startWeek: 2,
          endWeek: 8,
          segments: [],
        },
      ],
    })

    const result = buildResourceCapacityProfileMap(project)
    // 2 entries: role + NR
    expect(result.roleProfiles.size + result.namedResourceProfiles.size).toBe(2)

    // Both are PROFILE resolution
    expect(result.roleProfiles.get('rt-com')!.resolutionSource).toBe('PROFILE')
    expect(result.namedResourceProfiles.get('nr-com')!.resolutionSource).toBe('PROFILE')

    // The adapter enriches with profile data — no commercial fields exist
    // (commercial computation is the route's domain)
    const keys = Object.keys(result.roleProfiles.get('rt-com')!).sort()
    expect(keys).toEqual(['defaultPercent', 'endWeek', 'legacyWriter', 'planningBasis', 'resolutionSource', 'segments', 'source', 'startWeek'])
  })
})
