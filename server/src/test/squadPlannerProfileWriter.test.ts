import { describe, expect, it } from 'vitest'
import {
  buildRoleProfileData,
  buildPlannedResourceProfileData,
  buildZeroCapacityProfileData,
  buildPlannerResourcePlan,
  classifyNamedResource,
  classifyProfileConflicts,
  determineSurplusResourceIds,
  isLegacyPlannerProfile,
  isPlannerManaged,
  materializeProfilesForResourceType,
} from '../lib/squadPlannerProfileWriter.js'
import type { CapacityPlanPeriodInput } from '../lib/capacityPlanMaterialisation.js'

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makePeriod(
  periodIndex: number,
  startWeek: number,
  endWeek: number,
  entries: Array<{ resourceTypeId: string; headcount: number }>,
): CapacityPlanPeriodInput {
  return { periodIndex, startWeek, endWeek, entries }
}

// ─── Role profile data tests ─────────────────────────────────────────────────

describe('buildRoleProfileData', () => {
  it('creates aggregate role segments for uniform headcount', () => {
    const periods = [
      makePeriod(0, 0, 4, [{ resourceTypeId: 'rt-dev', headcount: 1 }]),
    ]
    const result = buildRoleProfileData('rt-dev', periods)

    expect(result.resourceTypeId).toBe('rt-dev')
    expect(result.segments).toHaveLength(1)
    expect(result.segments[0]).toEqual({
      startWeek: 0,
      endWeek: 3,
      capacityPercent: 100,
    })
    expect(result.defaultPercent).toBe(100)
    expect(result.startWeek).toBe(0)
    expect(result.endWeek).toBe(3)
  })

  it('materialises aggregate role capacity across multiple periods', () => {
    const periods = [
      makePeriod(0, 0, 4, [{ resourceTypeId: 'rt-dev', headcount: 1 }]),
      makePeriod(1, 4, 8, [{ resourceTypeId: 'rt-dev', headcount: 2 }]),
    ]
    const result = buildRoleProfileData('rt-dev', periods)

    expect(result.segments).toHaveLength(2)
    expect(result.segments[0]).toEqual({ startWeek: 0, endWeek: 3, capacityPercent: 100 })
    expect(result.segments[1]).toEqual({ startWeek: 4, endWeek: 7, capacityPercent: 200 })
    expect(result.defaultPercent).toBeNull() // Non-uniform across segments
    expect(result.startWeek).toBe(0)
    expect(result.endWeek).toBe(7)
  })

  it('handles fractional headcount', () => {
    const periods = [
      makePeriod(0, 0, 4, [{ resourceTypeId: 'rt-dev', headcount: 0.5 }]),
    ]
    const result = buildRoleProfileData('rt-dev', periods)

    expect(result.segments).toHaveLength(1)
    // 0.5 headcount = 50%
    expect(result.segments[0].capacityPercent).toBeGreaterThanOrEqual(49)
    expect(result.segments[0].capacityPercent).toBeLessThanOrEqual(51)
    expect(result.defaultPercent).toBe(result.segments[0].capacityPercent)
  })

  it('preserves zero-capacity discontinuities without bridging segments', () => {
    const periods = [
      makePeriod(0, 0, 4, [{ resourceTypeId: 'rt-dev', headcount: 1 }]),
      // gap: period 1 (weeks 4-8) has 0 headcount — entries can be omitted or explicit 0
      makePeriod(2, 8, 12, [{ resourceTypeId: 'rt-dev', headcount: 1 }]),
    ]
    const result = buildRoleProfileData('rt-dev', periods)

    // Should produce two segments separated by a gap
    expect(result.segments).toHaveLength(2)
    expect(result.segments[0]).toEqual({ startWeek: 0, endWeek: 3, capacityPercent: 100 })
    expect(result.segments[1]).toEqual({ startWeek: 8, endWeek: 11, capacityPercent: 100 })
    expect(result.startWeek).toBe(0)
    expect(result.endWeek).toBe(11)
  })

  it('returns empty segments for zero headcount', () => {
    const periods = [
      makePeriod(0, 0, 4, [{ resourceTypeId: 'rt-dev', headcount: 0 }]),
    ]
    const result = buildRoleProfileData('rt-dev', periods)

    expect(result.segments).toHaveLength(0)
    expect(result.defaultPercent).toBeNull()
    expect(result.startWeek).toBeNull()
    expect(result.endWeek).toBeNull()
  })
})

// ─── Planned resource profile data tests ────────────────────────────────────

describe('buildPlannedResourceProfileData', () => {
  it('creates one profile per trajectory mapping to named resources by index', () => {
    const trajectories = [
      {
        trajectoryIndex: 0,
        segments: [
          { startWeek: 0, endWeek: 3, allocationPercent: 100 },
        ],
      },
      {
        trajectoryIndex: 1,
        segments: [
          { startWeek: 4, endWeek: 7, allocationPercent: 50 },
        ],
      },
    ]
    const namedResources = [
      { id: 'nr-1', name: 'Dev 1' },
      { id: 'nr-2', name: 'Dev 2' },
    ]

    const result = buildPlannedResourceProfileData(trajectories, namedResources)

    expect(result).toHaveLength(2)
    expect(result[0].namedResourceId).toBe('nr-1')
    expect(result[0].trajectoryIndex).toBe(0)
    expect(result[0].segments).toHaveLength(1)
    expect(result[0].segments[0].capacityPercent).toBe(100)

    expect(result[1].namedResourceId).toBe('nr-2')
    expect(result[1].trajectoryIndex).toBe(1)
    expect(result[1].segments[0].capacityPercent).toBe(50)
  })

  it('handles single trajectory with multiple segments as one resource', () => {
    const trajectories = [
      {
        trajectoryIndex: 0,
        segments: [
          { startWeek: 0, endWeek: 3, allocationPercent: 100 },
          { startWeek: 8, endWeek: 11, allocationPercent: 50 },
        ],
      },
    ]
    const namedResources = [{ id: 'nr-1', name: 'Dev 1' }]

    const result = buildPlannedResourceProfileData(trajectories, namedResources)

    expect(result).toHaveLength(1)
    expect(result[0].namedResourceId).toBe('nr-1')
    expect(result[0].segments).toHaveLength(2)
    expect(result[0].defaultPercent).toBeNull() // Non-uniform
  })

  it('throws when named resources are missing for required trajectories', () => {
    const trajectories = [
      {
        trajectoryIndex: 0,
        segments: [{ startWeek: 0, endWeek: 3, allocationPercent: 100 }],
      },
    ]
    const namedResources: Array<{ id: string; name: string }> = []

    expect(() => buildPlannedResourceProfileData(trajectories, namedResources))
      .toThrow(/Trajectory index 0 has no matching named resource/)
  })
})

// ─── Zero-capacity profile tests ────────────────────────────────────────────

describe('buildZeroCapacityProfileData', () => {
  it('creates a profile with zero capacity and no segments', () => {
    const result = buildZeroCapacityProfileData('nr-surplus')

    expect(result.namedResourceId).toBe('nr-surplus')
    expect(result.defaultPercent).toBe(0)
    expect(result.startWeek).toBeNull()
    expect(result.endWeek).toBeNull()
    expect(result.segments).toHaveLength(0)
    expect(result.trajectoryIndex).toBe(-1)
  })
})

// ─── Conflict classification tests ──────────────────────────────────────────
describe('isLegacyPlannerProfile', () => {
  const legacyProfile = {
    ownerKind: 'NAMED_PERSON',
    source: 'SQUAD_PLANNER',
    planningBasis: 'CAPACITY_PROFILE',
  }

  it('requires every legacy planner marker and CAPACITY_PLAN allocation', () => {
    expect(isLegacyPlannerProfile(legacyProfile, { allocationMode: 'CAPACITY_PLAN' })).toBe(true)
    expect(isLegacyPlannerProfile(legacyProfile, { allocationMode: 'EFFORT' })).toBe(false)
    expect(isLegacyPlannerProfile({ ...legacyProfile, source: 'MANUAL' }, { allocationMode: 'CAPACITY_PLAN' })).toBe(false)
    expect(isLegacyPlannerProfile({ ...legacyProfile, planningBasis: 'DEMAND_FOLLOWING' }, { allocationMode: 'CAPACITY_PLAN' })).toBe(false)
    expect(isLegacyPlannerProfile({ ...legacyProfile, ownerKind: 'PLANNED_RESOURCE' }, { allocationMode: 'CAPACITY_PLAN' })).toBe(false)
  })
})

// ─── Shared resource classification tests ──────────────────────────────────

describe('classifyNamedResource', () => {
  const resource = { allocationMode: 'CAPACITY_PLAN' }
  const legacyProfile = { ownerKind: 'NAMED_PERSON' as const, source: 'SQUAD_PLANNER' as const, planningBasis: 'CAPACITY_PROFILE' as const }
  const plannerProfile = { ownerKind: 'PLANNED_RESOURCE' as const, source: 'SQUAD_PLANNER' as const, planningBasis: 'CAPACITY_PROFILE' as const }
  const manualProfile = { ownerKind: 'NAMED_PERSON' as const, source: 'MANUAL' as const, planningBasis: 'CAPACITY_PROFILE' as const }
  const fixedProfile = { ownerKind: 'ROLE' as const, source: 'FIXED' as const, planningBasis: 'CAPACITY_PROFILE' as const }
  const importedProfile = { ownerKind: 'NAMED_PERSON' as const, source: 'IMPORTED' as const, planningBasis: 'CAPACITY_PROFILE' as const }
  const namedPersonNonLegacy = { ownerKind: 'NAMED_PERSON' as const, source: 'SQUAD_PLANNER' as const, planningBasis: 'DEMAND_FOLLOWING' as const }

  it('classifies explicit manual person as explicit_person', () => {
    expect(classifyNamedResource(resource, [manualProfile])).toBe('explicit_person')
  })

  it('classifies legacy adoptable profile as legacy_adoptable', () => {
    expect(classifyNamedResource(resource, [legacyProfile])).toBe('legacy_adoptable')
  })

  it('classifies planned-resource profile as planner_managed', () => {
    expect(classifyNamedResource(resource, [plannerProfile])).toBe('planner_managed')
  })

  it('classifies no profiles with CAPACITY_PLAN mode as capacity_plan_untouched', () => {
    expect(classifyNamedResource({ allocationMode: 'CAPACITY_PLAN' }, [])).toBe('capacity_plan_untouched')
  })

  it('classifies EFFORT allocation with no profiles as other', () => {
    expect(classifyNamedResource({ allocationMode: 'EFFORT' }, [])).toBe('other')
  })

  it('explicit person wins over legacy when both profiles exist', () => {
    expect(classifyNamedResource(resource, [legacyProfile, manualProfile])).toBe('explicit_person')
  })

  it('named-person non-legacy is explicit_person', () => {
    expect(classifyNamedResource(resource, [namedPersonNonLegacy])).toBe('explicit_person')
  })

  it('FIXED source is explicit_person', () => {
    expect(classifyNamedResource(resource, [fixedProfile])).toBe('explicit_person')
  })

  it('IMPORTED source is explicit_person', () => {
    expect(classifyNamedResource(resource, [importedProfile])).toBe('explicit_person')
  })

  it('non-legacy NAMED_PERSON without CAPACITY_PLAN allocation is explicit_person', () => {
    expect(classifyNamedResource({ allocationMode: 'EFFORT' }, [legacyProfile])).toBe('explicit_person')
  })
})

describe('isPlannerManaged', () => {
  it('returns true for legacy_adoptable resources', () => {
    expect(isPlannerManaged(
      { allocationMode: 'CAPACITY_PLAN' },
      [{ ownerKind: 'NAMED_PERSON', source: 'SQUAD_PLANNER', planningBasis: 'CAPACITY_PROFILE' }],
    )).toBe(true)
  })

  it('returns true for planner_managed resources', () => {
    expect(isPlannerManaged(
      { allocationMode: 'CAPACITY_PLAN' },
      [{ ownerKind: 'PLANNED_RESOURCE', source: 'SQUAD_PLANNER', planningBasis: 'CAPACITY_PROFILE' }],
    )).toBe(true)
  })

  it('returns true for capacity_plan_untouched resources', () => {
    expect(isPlannerManaged({ allocationMode: 'CAPACITY_PLAN' }, [])).toBe(true)
  })

  it('returns false for explicit_person resources', () => {
    expect(isPlannerManaged(
      { allocationMode: 'EFFORT' },
      [{ ownerKind: 'NAMED_PERSON', source: 'MANUAL', planningBasis: 'CAPACITY_PROFILE' }],
    )).toBe(false)
  })

  it('returns false for other resources', () => {
    expect(isPlannerManaged({ allocationMode: 'EFFORT' }, [])).toBe(false)
  })
})


describe('classifyProfileConflicts', () => {
  it('returns no conflict for clean state', () => {
    const result = classifyProfileConflicts(
      [],
      [],
      2,
      [
        { id: 'nr-1', name: 'Dev 1', createdAt: new Date() },
        { id: 'nr-2', name: 'Dev 2', createdAt: new Date() },
      ],
    )

    expect(result.hasConflict).toBe(false)
    expect(result.duplicateOwnerProfiles).toHaveLength(0)
    expect(result.protectedNamedPersonProfiles).toHaveLength(0)
  })

  it('flags duplicate ROLE profiles as conflict', () => {
    const result = classifyProfileConflicts(
      [
        { id: 'cp-1', projectId: 'p1', resourceTypeId: 'rt-dev', namedResourceId: null, ownerKind: 'ROLE', source: 'SQUAD_PLANNER' },
        { id: 'cp-2', projectId: 'p1', resourceTypeId: 'rt-dev', namedResourceId: null, ownerKind: 'ROLE', source: 'MANUAL' },
      ],
      [],
      1,
      [{ id: 'nr-1', name: 'Dev 1', createdAt: new Date() }],
    )

    expect(result.hasConflict).toBe(true)
    expect(result.duplicateOwnerProfiles).toHaveLength(1)
    expect(result.protectedNamedPersonProfiles).toHaveLength(0)
  })

  it('flags NAMED_PERSON profiles for trajectory-used resources as protected', () => {
    const result = classifyProfileConflicts(
      [],
      [
        { id: 'cp-1', projectId: 'p1', resourceTypeId: 'rt-dev', namedResourceId: 'nr-1', ownerKind: 'NAMED_PERSON', source: 'MANUAL' },
      ],
      2,
      [
        { id: 'nr-1', name: 'Alice', createdAt: new Date() },
        { id: 'nr-2', name: 'Bob', createdAt: new Date() },
      ],
    )

    expect(result.hasConflict).toBe(true)
    expect(result.duplicateOwnerProfiles).toHaveLength(0)
    expect(result.protectedNamedPersonProfiles).toHaveLength(1)
    expect(result.protectedNamedPersonProfiles[0].namedResourceName).toBe('Alice')
  })

  it('adopts an evidence-based legacy planner NAMED_PERSON profile', () => {
    const result = classifyProfileConflicts(
      [],
      [{
        id: 'cp-legacy',
        projectId: 'p1',
        resourceTypeId: null,
        namedResourceId: 'nr-1',
        ownerKind: 'NAMED_PERSON',
        source: 'SQUAD_PLANNER',
        planningBasis: 'CAPACITY_PROFILE',
      }],
      1,
      [{ id: 'nr-1', name: 'Planner 1', createdAt: new Date(), allocationMode: 'CAPACITY_PLAN' }],
    )

    expect(result.hasConflict).toBe(false)
    expect(result.protectedNamedPersonProfiles).toHaveLength(0)
  })

  it('ignores NAMED_PERSON profiles for resources beyond trajectory range', () => {
    const result = classifyProfileConflicts(
      [],
      [
        { id: 'cp-1', projectId: 'p1', resourceTypeId: 'rt-dev', namedResourceId: 'nr-3', ownerKind: 'NAMED_PERSON', source: 'MANUAL' },
      ],
      2,
      [
        { id: 'nr-1', name: 'Dev 1', createdAt: new Date() },
        { id: 'nr-2', name: 'Dev 2', createdAt: new Date() },
        { id: 'nr-3', name: 'Alice', createdAt: new Date() },
      ],
    )

    // nr-3 is beyond trajectory count 2, so it should not be flagged
    expect(result.hasConflict).toBe(false)
  })
})

// ─── Surplus resource tests ─────────────────────────────────────────────────

describe('determineSurplusResourceIds', () => {
  it('returns empty when resources match trajectory count', () => {
    const result = determineSurplusResourceIds(
      [{ id: 'nr-1' }, { id: 'nr-2' }],
      2,
    )
    expect(result).toHaveLength(0)
  })

  it('returns surplus IDs when trajectories require fewer resources', () => {
    const result = determineSurplusResourceIds(
      [{ id: 'nr-1' }, { id: 'nr-2' }, { id: 'nr-3' }],
      1,
    )
    expect(result).toEqual(['nr-2', 'nr-3'])
  })

  it('returns empty when no resources exist', () => {
    const result = determineSurplusResourceIds([], 0)
    expect(result).toHaveLength(0)
  })
})

// ─── Shared planner resource plan tests ───────────────────────────────────

describe('buildPlannerResourcePlan', () => {
  const rtDev = 'rt-dev'
  const rtName = 'Developer'
  const baseDate = new Date('2026-01-01')

  it('returns planner resources in deterministic order, excluding explicit people', () => {
    const namedResources = [
      { id: 'nr-alice', name: 'Alice', createdAt: new Date('2026-01-01'), allocationMode: 'MANUAL' },
      { id: 'nr-bob', name: 'Bob', createdAt: new Date('2026-01-02'), allocationMode: 'CAPACITY_PLAN' },
    ]
    const profiles = [
      { namedResourceId: 'nr-alice', ownerKind: 'NAMED_PERSON', source: 'MANUAL', planningBasis: 'CAPACITY_PROFILE' },
    ]

    const result = buildPlannerResourcePlan(namedResources, profiles, rtDev, rtName, 1)

    expect(result.hasConflict).toBe(false)
    expect(result.plannerResources).toHaveLength(1)
    expect(result.plannerResources[0].id).toBe('nr-bob')
    expect(result.explicitResources).toHaveLength(1)
    expect(result.explicitResources[0].id).toBe('nr-alice')
    expect(result.shortfall).toBe(0)
  })

  it('returns shortfall when no planner resources exist despite explicit people present', () => {
    // Explicit people are NOT treated as a conflict — shortfall creates new placeholders
    const namedResources = [
      { id: 'nr-alice', name: 'Alice', createdAt: new Date('2026-01-01'), allocationMode: 'MANUAL' },
    ]
    const profiles = [
      { namedResourceId: 'nr-alice', ownerKind: 'NAMED_PERSON', source: 'MANUAL', planningBasis: 'CAPACITY_PROFILE' },
    ]

    const result = buildPlannerResourcePlan(namedResources, profiles, rtDev, rtName, 2)

    expect(result.hasConflict).toBe(false)
    expect(result.plannerResources).toHaveLength(0)
    expect(result.shortfall).toBe(2)
    expect(result.explicitResources).toHaveLength(1)
  })

  it('includes legacy-adoptable and capacity-plan-untouched resources as planner-managed', () => {
    const namedResources = [
      { id: 'nr-legacy', name: 'Legacy', createdAt: baseDate, allocationMode: 'CAPACITY_PLAN' },
      { id: 'nr-untouched', name: 'Untouched', createdAt: new Date('2026-01-02'), allocationMode: 'CAPACITY_PLAN' },
    ]
    const profiles = [
      { namedResourceId: 'nr-legacy', ownerKind: 'NAMED_PERSON', source: 'SQUAD_PLANNER', planningBasis: 'CAPACITY_PROFILE' },
    ]

    const result = buildPlannerResourcePlan(namedResources, profiles, rtDev, rtName, 2)

    expect(result.hasConflict).toBe(false)
    expect(result.plannerResources).toHaveLength(2)
    expect(result.plannerResources[0].id).toBe('nr-legacy')
    expect(result.plannerResources[1].id).toBe('nr-untouched')
    expect(result.shortfall).toBe(0)
  })

  it('flags duplicate ROLE profiles as conflict', () => {
    const profiles = [
      { namedResourceId: null, ownerKind: 'ROLE', source: 'SQUAD_PLANNER', planningBasis: 'CAPACITY_PROFILE' },
      { namedResourceId: null, ownerKind: 'ROLE', source: 'MANUAL', planningBasis: 'CAPACITY_PROFILE' },
    ]

    const result = buildPlannerResourcePlan([], profiles, rtDev, rtName, 1)

    expect(result.hasConflict).toBe(true)
    expect(result.conflicts).toHaveLength(1)
  })

  it('flags duplicate profiles on a planner-managed resource as conflict', () => {
    const namedResources = [
      { id: 'nr-dupe', name: 'Dupe', createdAt: baseDate, allocationMode: 'CAPACITY_PLAN' },
    ]
    const profiles = [
      { namedResourceId: 'nr-dupe', ownerKind: 'PLANNED_RESOURCE', source: 'SQUAD_PLANNER', planningBasis: 'CAPACITY_PROFILE' },
      { namedResourceId: 'nr-dupe', ownerKind: 'PLANNED_RESOURCE', source: 'MANUAL', planningBasis: 'CAPACITY_PROFILE' },
    ]

    const result = buildPlannerResourcePlan(namedResources, profiles, rtDev, rtName, 1)

    expect(result.hasConflict).toBe(true)
    expect(result.conflicts).toHaveLength(1)
  })

  it('slices planner resources to required count, ignoring surplus', () => {
    const namedResources = [
      { id: 'nr-1', name: 'First', createdAt: baseDate, allocationMode: 'CAPACITY_PLAN' },
      { id: 'nr-2', name: 'Second', createdAt: new Date('2026-01-02'), allocationMode: 'CAPACITY_PLAN' },
      { id: 'nr-3', name: 'Third', createdAt: new Date('2026-01-03'), allocationMode: 'CAPACITY_PLAN' },
    ]
    const profiles: Array<{ namedResourceId: string | null; ownerKind: string; source: string; planningBasis?: string }> = []

    const result = buildPlannerResourcePlan(namedResources, profiles, rtDev, rtName, 2)

    expect(result.hasConflict).toBe(false)
    expect(result.plannerResources).toHaveLength(2)
    expect(result.plannerResources[0].id).toBe('nr-1')
    expect(result.plannerResources[1].id).toBe('nr-2')
    // Surplus resources are tracked separately via determineSurplusResourceIds
  })

  it('does not flag explicit people as conflict when placeholders are needed', () => {
    // This is the core behavioral change: explicit people should NOT block planning
    const namedResources = [
      { id: 'nr-manual', name: 'Manual Alice', createdAt: baseDate, allocationMode: 'MANUAL' },
      { id: 'nr-legacy', name: 'Legacy Bob', createdAt: new Date('2026-01-02'), allocationMode: 'CAPACITY_PLAN' },
    ]
    const profiles = [
      { namedResourceId: 'nr-manual', ownerKind: 'NAMED_PERSON', source: 'MANUAL', planningBasis: 'CAPACITY_PROFILE' },
      { namedResourceId: 'nr-legacy', ownerKind: 'NAMED_PERSON', source: 'SQUAD_PLANNER', planningBasis: 'CAPACITY_PROFILE' },
    ]

    const result = buildPlannerResourcePlan(namedResources, profiles, rtDev, rtName, 3)

    // Should NOT conflict: explicit people are ignored for headcount purposes
    expect(result.hasConflict).toBe(false)
    expect(result.plannerResources).toHaveLength(1) // Only legacy Bob
    expect(result.explicitResources).toHaveLength(1) // Manual Alice
    expect(result.shortfall).toBe(2) // Need 2 more placeholders
  })
})

// ─── Materialize profiles for resource type tests ───────────────────────────

describe('materializeProfilesForResourceType', () => {
  it('materialises role and per-resource profiles for a simple case', () => {
    const periods = [
      makePeriod(0, 0, 4, [{ resourceTypeId: 'rt-dev', headcount: 1 }]),
    ]
    const namedResources = [{ id: 'nr-1', name: 'Dev 1' }]

    const result = materializeProfilesForResourceType(
      'rt-dev',
      'Developer',
      periods,
      namedResources,
    )

    // Role profile
    expect(result.roleProfile.resourceTypeId).toBe('rt-dev')
    expect(result.roleProfile.segments).toHaveLength(1)
    expect(result.roleProfile.segments[0].capacityPercent).toBe(100)

    // Per-resource profiles
    expect(result.plannedProfiles).toHaveLength(1)
    expect(result.plannedProfiles[0].namedResourceId).toBe('nr-1')
    expect(result.plannedProfiles[0].segments[0].capacityPercent).toBe(100)

    // No surplus
    expect(result.surplusResources).toHaveLength(0)
  })

  it('handles multiple resources with identity preserved', () => {
    const periods = [
      makePeriod(0, 0, 8, [{ resourceTypeId: 'rt-dev', headcount: 2 }]),
    ]
    const namedResources = [
      { id: 'nr-1', name: 'Dev 1' },
      { id: 'nr-2', name: 'Dev 2' },
    ]

    const result = materializeProfilesForResourceType(
      'rt-dev',
      'Developer',
      periods,
      namedResources,
    )

    expect(result.plannedProfiles).toHaveLength(2)
    expect(result.plannedProfiles[0].namedResourceId).toBe('nr-1')
    expect(result.plannedProfiles[1].namedResourceId).toBe('nr-2')
    expect(result.surplusResources).toHaveLength(0)
  })

  it('identifies surplus resources when trajectories shrink', () => {
    const periods = [
      makePeriod(0, 0, 4, [{ resourceTypeId: 'rt-dev', headcount: 1 }]),
    ]
    const namedResources = [
      { id: 'nr-1', name: 'Dev 1' },
      { id: 'nr-2', name: 'Dev 2' }, // surplus - only 1 trajectory needed
      { id: 'nr-3', name: 'Dev 3' }, // surplus
    ]

    const result = materializeProfilesForResourceType(
      'rt-dev',
      'Developer',
      periods,
      namedResources,
    )

    expect(result.plannedProfiles).toHaveLength(1)
    expect(result.plannedProfiles[0].namedResourceId).toBe('nr-1')
    expect(result.surplusResources).toEqual(['nr-2', 'nr-3'])
  })
})
