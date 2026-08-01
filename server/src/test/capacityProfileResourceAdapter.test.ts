import { describe, it, expect } from 'vitest'
import { buildResourceCapacityProfileMap } from '../lib/capacityProfileResourceAdapter.js'
import { CapacityIntegrityError } from '../lib/capacityIntegrityError.js'

// ── Helper to create a minimal project-like object ────────────────────────────

function makeProject(overrides?: Record<string, unknown>) {
  return {
    id: 'proj-1',
    projectId: 'proj-1',
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
    projectId: 'proj-1',
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
    projectId: 'proj-1',
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

  it('fails closed when a role has no persisted profile (no legacy fallback, issue #418)', () => {
    const project = makeProject({
      resourceTypes: [
        makeResourceType({
          id: 'rt-1',
          projectId: 'proj-1',
          name: 'Engineer',
          allocationMode: 'EFFORT',
          allocationPercent: 100,
        }),
      ],
    })
    expect(() => buildResourceCapacityProfileMap(project)).toThrow(CapacityIntegrityError)
  })

  it('fails closed when a named resource has no persisted profile (issue #418)', () => {
    const project = makeProject({
      resourceTypes: [
        makeResourceType({
          id: 'rt-1',
          projectId: 'proj-1',
          name: 'Engineer',
          allocationMode: 'EFFORT',
          allocationPercent: 100,
          namedResources: [
            makeNamedResource({
              id: 'nr-1',
              projectId: 'proj-1',
              name: 'Alice',
              allocationMode: 'EFFORT',
            }),
          ],
        }),
      ],
    })
    expect(() => buildResourceCapacityProfileMap(project)).toThrow(CapacityIntegrityError)
  })

  it('returns persisted profile data when profiles exist and reconcile', () => {
    // TIMELINE allocation → legacy produces planningBasis: availabilityWindow, source: availabilityWindow
    // Persisted AVAILABILITY_WINDOW → normalize → availabilityWindow → match
    const project = makeProject({
      resourceTypes: [
        makeResourceType({
          id: 'rt-1',
          projectId: 'proj-1',
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
          projectId: 'proj-1',
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
          projectId: 'proj-1',
          name: 'Engineer',
          allocationMode: 'EFFORT',
          allocationPercent: 100,
        }),
      ],
      capacityProfiles: [
        {
          id: 'cp-1',
          projectId: 'proj-1',
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
              projectId: 'proj-1',
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
          projectId: 'proj-1',
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
          projectId: 'proj-1',
          ownerKind: 'NAMED_PERSON',
          resourceTypeId: null,
          namedResourceId: nrId,
          planningBasis: 'CAPACITY_PROFILE',
          source: 'MANUAL',
          defaultPercent: 100,
          startWeek: 0,
          endWeek: 7,
          segments: [
            { id: 'seg-1', capacityProfileId: 'cp-1', startWeek: 0, endWeek: 3, capacityPercent: 50, source: 'MANUAL' },
            { id: 'seg-2', capacityProfileId: 'cp-1', startWeek: 4, endWeek: 7, capacityPercent: 100, source: 'MANUAL' },
          ],
        },
      ],
    })
    const result = buildResourceCapacityProfileMap(project)
    // Explicit-only role: every NR carries a NAMED_PERSON profile, so no ROLE
    // profile is required — there is no role entry (issue #418).
    expect(result.roleProfiles.size + result.namedResourceProfiles.size).toBe(1)
    expect(result.namedResourceProfiles.has(nrId)).toBe(true)
    expect(result.roleProfiles.has('rt-1')).toBe(false)

    // NR entry is profile-first (segmented CAPACITY_PROFILE)
    const data = result.namedResourceProfiles.get(nrId)!
    expect(data.planningBasis).toBe('capacityProfile')
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
          projectId: 'proj-1',
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
      capacityProfiles: [
        {
          id: 'cp-role',
          projectId: 'proj-1',
          ownerKind: 'ROLE',
          resourceTypeId: 'rt-1',
          namedResourceId: null,
          planningBasis: 'CAPACITY_PROFILE',
          source: 'SQUAD_PLANNER',
          defaultPercent: 100,
          startWeek: null,
          endWeek: null,
          segments: [
            { id: 'role-seg-1', capacityProfileId: 'cp-role', startWeek: 0, endWeek: 7, capacityPercent: 100, source: 'SQUAD_PLANNER' },
          ],
        },
        {
          id: 'cp-1',
          projectId: 'proj-1',
          ownerKind: 'PLANNED_RESOURCE',
          resourceTypeId: null,
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
          projectId: 'proj-1',
          name: 'Engineer',
          allocationMode: 'EFFORT',
          allocationPercent: 100,
        }),
      ],
      capacityProfiles: [
        {
          id: 'cp-1',
          projectId: 'proj-1',
          ownerKind: 'ROLE',
          resourceTypeId: 'rt-1',
          namedResourceId: null,
          planningBasis: 'DEMAND_FOLLOWING',
          source: 'FIXED',
          defaultPercent: 100,
          startWeek: null,
          endWeek: null,
          segments: [],
        },
      ],
    })
    const result = buildResourceCapacityProfileMap(project)
    const data = result.roleProfiles.get('rt-1')!
    // Demand-following: startWeek and endWeek should be null
    expect(data.planningBasis).toBe('demandFollowing')
    expect(data.startWeek).toBeNull()
    expect(data.endWeek).toBeNull()
    expect(data.resolutionSource).toBe('PROFILE')
  })

  it('named resource with null window (demandFollowing) preserves null authoritative data', () => {
    const project = makeProject({
      resourceTypes: [
        makeResourceType({
          id: 'rt-1',
          projectId: 'proj-1',
          name: 'Engineer',
          namedResources: [
            makeNamedResource({
              id: 'nr-1',
              projectId: 'proj-1',
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
      capacityProfiles: [
        {
          id: 'cp-role',
          projectId: 'proj-1',
          ownerKind: 'ROLE',
          resourceTypeId: 'rt-1',
          namedResourceId: null,
          planningBasis: 'DEMAND_FOLLOWING',
          source: 'FIXED',
          defaultPercent: 100,
          startWeek: null,
          endWeek: null,
          segments: [],
        },
        {
          id: 'cp-nr',
          projectId: 'proj-1',
          ownerKind: 'NAMED_PERSON',
          resourceTypeId: null,
          namedResourceId: 'nr-1',
          planningBasis: 'DEMAND_FOLLOWING',
          source: 'FIXED',
          defaultPercent: 100,
          startWeek: null,
          endWeek: null,
          segments: [],
        },
      ],
    })
    const result = buildResourceCapacityProfileMap(project)
    const nrData = result.namedResourceProfiles.get('nr-1')!
    // Demand-following from EFFORT mode → null windows
    expect(nrData.planningBasis).toBe('demandFollowing')
    expect(nrData.startWeek).toBeNull()
    expect(nrData.endWeek).toBeNull()
    expect(nrData.resolutionSource).toBe('PROFILE')
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
          projectId: 'proj-1',
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
          id: 'cp-inherited',
          projectId: 'proj-1',
          ownerKind: 'NAMED_PERSON',
          resourceTypeId: null,
          namedResourceId: nrInherited,
          planningBasis: 'DEMAND_FOLLOWING',
          source: 'FIXED',
          defaultPercent: 70,
          startWeek: null,
          endWeek: null,
          segments: [],
        },
        {
          id: 'cp-explicit',
          projectId: 'proj-1',
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
    expect(inheritedData.resolutionSource).toBe('PROFILE')
    expect(inheritedData.planningBasis).toBe('demandFollowing')
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

  it('fails closed when role and NR have no persisted profiles — plan fallback removed (issue #418)', () => {
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
              startWeek: null,
              endWeek: null,
            }),
          ],
        }),
      ],
      capacityPlans: [
        {
          id: 'plan-act-1',
          projectId: 'proj-1',
          isActive: true,
          periods: [
            {
              periodIndex: 0,
              startWeek: 0,
              endWeek: 4,
              entries: [{ resourceTypeId: rtId, headcount: 1, demandFTE: 1, utilisationPct: 100 }],
            },
          ],
        },
      ],
    })
    // The active-capacity-plan fallback was removed in #418: missing profiles
    // fail closed instead of synthesising trajectories from the plan.
    expect(() => buildResourceCapacityProfileMap(project)).toThrow(CapacityIntegrityError)
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
          projectId: 'proj-1',
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
          projectId: 'proj-1',
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
    // Explicit-only role: the single NR has a NAMED_PERSON profile, so no
    // ROLE profile is required and no plan fallback is attempted (issue #418).
    expect(result.roleProfiles.size + result.namedResourceProfiles.size).toBe(1)
    expect(result.roleProfiles.has(rtId)).toBe(false)

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
          projectId: 'proj-1',
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

    // With no persisted profiles the adapter fails closed — no legacy or
    // plan-fallback path exists anymore (issue #418).
    expect(() => buildResourceCapacityProfileMap(project)).toThrow(CapacityIntegrityError)
  })

  // ─── Duplicate handling ───────────────────────────────────────────────

  it('duplicate identical role profiles fail closed (no smallest-ID selection)', () => {
    const project = makeProject({
      resourceTypes: [
        makeResourceType({
          id: 'rt-dup',
          projectId: 'proj-1',
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
          projectId: 'proj-1',
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
          projectId: 'proj-1',
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

    // Semantically identical duplicate rows are an integrity conflict too
    // (issue #418 PR 1 review round 3): no canonical row is selected.
    expect(() => buildResourceCapacityProfileMap(project)).toThrow(CapacityIntegrityError)
    expect(() => buildResourceCapacityProfileMap(project)).toThrow(/rt-dup/)
    expect(() => buildResourceCapacityProfileMap(project)).toThrow(/cp-a/)
    expect(() => buildResourceCapacityProfileMap(project)).toThrow(/cp-b/)
  })

  it('duplicate conflicting role profiles: fall back to legacy with warning', () => {
    const project = makeProject({
      resourceTypes: [
        makeResourceType({
          id: 'rt-conflict',
          projectId: 'proj-1',
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
          projectId: 'proj-1',
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
          projectId: 'proj-1',
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

    // Conflicting duplicate role profiles fail closed instead of falling
    // back to legacy columns (issue #418).
    expect(() => buildResourceCapacityProfileMap(project)).toThrow(CapacityIntegrityError)
  })

  it('duplicate identical named resource profiles fail closed (no smallest-ID selection)', () => {
    const nrId = 'nr-dup'
    const project = makeProject({
      resourceTypes: [
        makeResourceType({
          id: 'rt-1',
          projectId: 'proj-1',
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
          projectId: 'proj-1',
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
          projectId: 'proj-1',
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

    // Semantically identical duplicate rows are an integrity conflict too
    // (issue #418 PR 1 review round 3): no canonical row is selected.
    expect(() => buildResourceCapacityProfileMap(project)).toThrow(CapacityIntegrityError)
    expect(() => buildResourceCapacityProfileMap(project)).toThrow(new RegExp(nrId))
    expect(() => buildResourceCapacityProfileMap(project)).toThrow(/cp-nr-a/)
    expect(() => buildResourceCapacityProfileMap(project)).toThrow(/cp-nr-b/)
  })

  it('duplicate conflicting named resource profiles: fall back to legacy with warning', () => {
    const nrId = 'nr-conflict'
    const project = makeProject({
      resourceTypes: [
        makeResourceType({
          id: 'rt-1',
          projectId: 'proj-1',
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
          projectId: 'proj-1',
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
          projectId: 'proj-1',
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

    // Conflicting duplicate named-resource profiles fail closed (issue #418).
    expect(() => buildResourceCapacityProfileMap(project)).toThrow(CapacityIntegrityError)
  })

  // ─── Owner kind mismatch handling ────────────────────────────────────

  function makeOwnerKindProject(nrId: string, profiles: Record<string, unknown>[]) {
    return makeProject({
      resourceTypes: [
        makeResourceType({
          id: 'rt-1',
          projectId: 'proj-1',
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
        projectId: 'proj-1',
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
        projectId: 'proj-1',
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

    // Owner-kind mismatch between duplicate profiles is a hard integrity
    // conflict — fail closed (issue #418).
    expect(() => buildResourceCapacityProfileMap(project)).toThrow(CapacityIntegrityError)
  })

  it('ownerKind mismatch between duplicate profiles produces CONFLICT — reverse order B then A', () => {
    const nrId = 'nr-ok-mismatch-rev'
    const project = makeOwnerKindProject(nrId, [
      {
        id: 'cp-b',
        projectId: 'proj-1',
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
        projectId: 'proj-1',
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

    // Owner-kind mismatch between duplicate profiles is a hard integrity
    // conflict — fail closed regardless of order (issue #418).
    expect(() => buildResourceCapacityProfileMap(project)).toThrow(CapacityIntegrityError)
  })

  it('identical duplicates with same ownerKind fail closed', () => {
    const nrId = 'nr-dup-same-kind'
    const project = makeProject({
      resourceTypes: [
        makeResourceType({
          id: 'rt-1',
          projectId: 'proj-1',
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
          projectId: 'proj-1',
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
          projectId: 'proj-1',
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

    // Semantically identical duplicate rows are an integrity conflict too
    // (issue #418 PR 1 review round 3): no canonical row is selected.
    expect(() => buildResourceCapacityProfileMap(project)).toThrow(CapacityIntegrityError)
    expect(() => buildResourceCapacityProfileMap(project)).toThrow(new RegExp(nrId))
    expect(() => buildResourceCapacityProfileMap(project)).toThrow(/cp-a/)
    expect(() => buildResourceCapacityProfileMap(project)).toThrow(/cp-b/)
  })

  it('identical duplicates with same ownerKind PLANNED_RESOURCE fail closed', () => {
    const nrId = 'nr-dup-planned'
    const project = makeProject({
      resourceTypes: [
        makeResourceType({
          id: 'rt-1',
          projectId: 'proj-1',
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
          id: 'cp-role',
          projectId: 'proj-1',
          ownerKind: 'ROLE',
          resourceTypeId: 'rt-1',
          namedResourceId: null,
          planningBasis: 'AVAILABILITY_WINDOW',
          source: 'MANUAL',
          defaultPercent: 100,
          startWeek: 0,
          endWeek: 4,
          segments: [],
        },
        {
          id: 'cp-y',  // larger ID — should lose
          projectId: 'proj-1',
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
          projectId: 'proj-1',
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

    // Semantically identical duplicate rows are an integrity conflict too
    // (issue #418 PR 1 review round 3): no canonical row is selected.
    expect(() => buildResourceCapacityProfileMap(project)).toThrow(CapacityIntegrityError)
    expect(() => buildResourceCapacityProfileMap(project)).toThrow(new RegExp(nrId))
    expect(() => buildResourceCapacityProfileMap(project)).toThrow(/cp-a/)
    expect(() => buildResourceCapacityProfileMap(project)).toThrow(/cp-y/)
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
        capacityProfiles: [
          {
            id: 'cp-role',
            projectId: 'proj-1',
            ownerKind: 'ROLE',
            resourceTypeId: collidingId,
            namedResourceId: null,
            planningBasis: 'DEMAND_FOLLOWING',
            source: 'FIXED',
            defaultPercent: 100,
            startWeek: null,
            endWeek: null,
            segments: [],
          },
          {
            id: 'cp-nr',
            projectId: 'proj-1',
            ownerKind: 'NAMED_PERSON',
            resourceTypeId: null,
            namedResourceId: collidingId,
            planningBasis: 'DEMAND_FOLLOWING',
            source: 'FIXED',
            defaultPercent: 100,
            startWeek: null,
            endWeek: null,
            segments: [],
          },
        ],
      })
      const result = buildResourceCapacityProfileMap(project)
      // With separate role/NR maps, both entries coexist — no collision
      expect(result.roleProfiles.size + result.namedResourceProfiles.size).toBe(2)
      expect(result.roleProfiles.has(collidingId)).toBe(true)
      expect(result.namedResourceProfiles.has(collidingId)).toBe(true)
      const roleData = result.roleProfiles.get(collidingId)!
      expect(roleData.resolutionSource).toBe('PROFILE')
      const nrData = result.namedResourceProfiles.get(collidingId)!
      expect(nrData.resolutionSource).toBe('PROFILE')
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
          projectId: 'proj-1',
          name: 'Commercial RT',
          allocationMode: 'TIMELINE',
          allocationPercent: 75,
          allocationStartWeek: 0,
          allocationEndWeek: 10,
          namedResources: [
            makeNamedResource({
              id: 'nr-com',
              projectId: 'proj-1',
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
          projectId: 'proj-1',
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
          projectId: 'proj-1',
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
