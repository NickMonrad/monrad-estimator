import { describe, expect, it } from 'vitest'
import {
  buildRoleProfileData,
  buildPlannedResourceProfileData,
  buildZeroCapacityProfileData,
  classifyProfileConflicts,
  determineSurplusResourceIds,
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

  it('skips trajectories beyond available named resources', () => {
    const trajectories = [
      {
        trajectoryIndex: 0,
        segments: [{ startWeek: 0, endWeek: 3, allocationPercent: 100 }],
      },
    ]
    const namedResources: Array<{ id: string; name: string }> = []

    const result = buildPlannedResourceProfileData(trajectories, namedResources)

    // When no NRs exist, the function receives an empty array and returns no profiles
    // because the caller (materializeProfilesForResourceType) needs NRs first
    expect(result).toHaveLength(0)
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
