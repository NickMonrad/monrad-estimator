/**
 * capacityProfileStructureValidation.unit.test.ts — Focused tests for the
 * single authoritative structural rule set (issue #418 PR 1 review round 2).
 *
 * Proves each planning-basis-specific rule and proves that equivalent
 * fixtures receive the SAME verdict through every consumer:
 *   - persisted-profile validation (`validatePersistedCapacityProfiles`)
 *   - owner-profile loading (`loadAndValidateOwnerProfile`)
 *   - runtime profile mapping (`buildResourceCapacityProfileMap`)
 */
import { describe, expect, it } from 'vitest'
import { validateProfileStructure } from '../lib/capacityProfileStructureValidation.js'
import { validatePersistedCapacityProfiles } from '../lib/persistedCapacityProfileValidation.js'
import { loadAndValidateOwnerProfile } from '../lib/ownerProfileLoader.js'
import { buildResourceCapacityProfileMap } from '../lib/capacityProfileResourceAdapter.js'
import { CapacityIntegrityError } from '../lib/capacityIntegrityError.js'

// ─── Shared fixtures ─────────────────────────────────────────────────────────

const PROJECT_ID = 'proj-1'
const RT_ID = 'rt-1'
const NR_ID = 'nr-1'

const context = {
  projectId: PROJECT_ID,
  resourceTypeIds: new Set([RT_ID]),
  namedResourceIds: new Set([NR_ID]),
}

function roleProfile(overrides: Record<string, unknown> = {}) {
  return {
    id: 'cp-role',
    projectId: PROJECT_ID,
    resourceTypeId: RT_ID,
    namedResourceId: null,
    ownerKind: 'ROLE',
    planningBasis: 'DEMAND_FOLLOWING',
    source: 'FIXED',
    defaultPercent: 100,
    startWeek: null,
    endWeek: null,
    segments: [],
    ...overrides,
  }
}

function personProfile(overrides: Record<string, unknown> = {}) {
  return {
    id: 'cp-nr',
    projectId: PROJECT_ID,
    resourceTypeId: null,
    namedResourceId: NR_ID,
    ownerKind: 'NAMED_PERSON',
    planningBasis: 'DEMAND_FOLLOWING',
    source: 'FIXED',
    defaultPercent: 100,
    startWeek: null,
    endWeek: null,
    segments: [],
    ...overrides,
  }
}

function segment(overrides: Record<string, unknown> = {}) {
  return {
    id: 'seg-1',
    capacityProfileId: 'cp-role',
    startWeek: 0,
    endWeek: 5,
    capacityPercent: 100,
    source: 'MANUAL',
    ...overrides,
  }
}

// ─── Consumer wrappers ───────────────────────────────────────────────────────

function persistedErrors(profileLike: Record<string, unknown>): string[] {
  return validatePersistedCapacityProfiles([profileLike as never], context).errors
}

function loaderVerdict(profileLike: Record<string, unknown>): Promise<'valid' | 'invalid'> {
  const profile = profileLike as Record<string, any>
  const ownerKind = profile.ownerKind === 'ROLE' ? 'ROLE' : profile.ownerKind === 'PLANNED_RESOURCE' ? 'PLANNED_RESOURCE' : 'NAMED_PERSON'
  const tx = {
    capacityProfile: {
      findMany: async () => [profile],
    },
  }
  return loadAndValidateOwnerProfile({
    tx: tx as never,
    projectId: PROJECT_ID,
    ownerKind,
    ownerId: ownerKind === 'ROLE' ? RT_ID : NR_ID,
  }).then(
    () => 'valid',
    () => 'invalid',
  )
}

function adapterVerdict(profileLike: Record<string, unknown>): 'valid' | 'invalid' {
  const profile = profileLike as Record<string, any>
  const isRole = profile.ownerKind === 'ROLE'
  const project = {
    id: PROJECT_ID,
    hoursPerDay: 8,
    resourceTypes: [{
      id: RT_ID,
      name: 'Engineer',
      allocationMode: 'EFFORT',
      allocationPercent: 100,
      allocationStartWeek: null,
      allocationEndWeek: null,
      count: 1,
      hoursPerDay: 8,
      namedResources: isRole ? [] : [{
        id: NR_ID,
        name: 'Alice',
        allocationMode: 'EFFORT',
        allocationPercent: 100,
        allocationStartWeek: null,
        allocationEndWeek: null,
        startWeek: null,
        endWeek: null,
      }],
    }],
    capacityProfiles: isRole
      ? [profile]
      : [
          // Planner RTs carry a ROLE profile; the adapter's completeness gate
          // requires it alongside planned-resource / named-person profiles.
          {
            id: 'cp-role',
            projectId: PROJECT_ID,
            resourceTypeId: RT_ID,
            namedResourceId: null,
            ownerKind: 'ROLE',
            planningBasis: 'DEMAND_FOLLOWING',
            source: 'FIXED',
            defaultPercent: 100,
            startWeek: null,
            endWeek: null,
            segments: [],
          },
          profile,
        ],
  }
  try {
    buildResourceCapacityProfileMap(project as never)
    return 'valid'
  } catch (error) {
    if (error instanceof CapacityIntegrityError) return 'invalid'
    throw error
  }
}

/**
 * Prove the SAME verdict through every consumer: the direct shared helper,
 * persisted validation, owner-profile loading and runtime profile mapping.
 */
async function expectUniformVerdict(profileLike: Record<string, unknown>, expected: 'valid' | 'invalid') {
  const direct = validateProfileStructure(profileLike as never, context)
  expect(direct.length === 0 ? 'valid' : 'invalid').toBe(expected)
  expect(persistedErrors(profileLike).length === 0 ? 'valid' : 'invalid').toBe(expected)
  await expect(loaderVerdict(profileLike)).resolves.toBe(expected)
  expect(adapterVerdict(profileLike)).toBe(expected)
}

// ─── Rules ───────────────────────────────────────────────────────────────────

describe('shared structural rule set (single authoritative validator)', () => {
  it('accepts a valid DEMAND_FOLLOWING scalar profile', async () => {
    await expectUniformVerdict(personProfile(), 'valid')
  })

  it('rejects DEMAND_FOLLOWING with a window', async () => {
    const fixture = personProfile({ startWeek: 2, endWeek: 9 })
    await expectUniformVerdict(fixture, 'invalid')
    expect(persistedErrors(fixture).join(' ')).toMatch(/DEMAND_FOLLOWING must not have startWeek/)
  })

  it('rejects DEMAND_FOLLOWING with segments', async () => {
    const fixture = personProfile({ segments: [segment()] })
    await expectUniformVerdict(fixture, 'invalid')
    expect(persistedErrors(fixture).join(' ')).toMatch(/DEMAND_FOLLOWING must not have segments/)
  })

  it('accepts a valid WHOLE_PROJECT_ALLOCATION scalar profile', async () => {
    await expectUniformVerdict(
      personProfile({ planningBasis: 'WHOLE_PROJECT_ALLOCATION', source: 'FIXED' }),
      'valid',
    )
  })

  it('rejects WHOLE_PROJECT_ALLOCATION with a window', async () => {
    const fixture = personProfile({
      planningBasis: 'WHOLE_PROJECT_ALLOCATION',
      source: 'FIXED',
      startWeek: 3,
      endWeek: 6,
    })
    await expectUniformVerdict(fixture, 'invalid')
    expect(persistedErrors(fixture).join(' ')).toMatch(/WHOLE_PROJECT_ALLOCATION must not have startWeek/)
  })

  it('rejects WHOLE_PROJECT_ALLOCATION with segments', async () => {
    const fixture = personProfile({
      planningBasis: 'WHOLE_PROJECT_ALLOCATION',
      source: 'FIXED',
      segments: [segment()],
    })
    await expectUniformVerdict(fixture, 'invalid')
    expect(persistedErrors(fixture).join(' ')).toMatch(/WHOLE_PROJECT_ALLOCATION must not have segments/)
  })

  it('accepts a valid AVAILABILITY_WINDOW with a window', async () => {
    await expectUniformVerdict(
      personProfile({
        planningBasis: 'AVAILABILITY_WINDOW',
        source: 'AVAILABILITY_WINDOW',
        startWeek: 2,
        endWeek: 9,
      }),
      'valid',
    )
  })

  it('rejects AVAILABILITY_WINDOW with segments', async () => {
    const fixture = personProfile({
      planningBasis: 'AVAILABILITY_WINDOW',
      source: 'AVAILABILITY_WINDOW',
      segments: [segment()],
    })
    await expectUniformVerdict(fixture, 'invalid')
    expect(persistedErrors(fixture).join(' ')).toMatch(/AVAILABILITY_WINDOW must not have segments/)
  })

  it('accepts a valid segmented CAPACITY_PROFILE', async () => {
    await expectUniformVerdict(
      roleProfile({
        planningBasis: 'CAPACITY_PROFILE',
        source: 'SQUAD_PLANNER',
        segments: [
          segment({ id: 'seg-a', capacityProfileId: 'cp-role', startWeek: 0, endWeek: 3 }),
          segment({ id: 'seg-b', capacityProfileId: 'cp-role', startWeek: 4, endWeek: 7 }),
        ],
      }),
      'valid',
    )
  })

  it('rejects an ordinary segmentless CAPACITY_PROFILE', async () => {
    const fixture = roleProfile({
      planningBasis: 'CAPACITY_PROFILE',
      source: 'SQUAD_PLANNER',
      segments: [],
    })
    await expectUniformVerdict(fixture, 'invalid')
    expect(persistedErrors(fixture).join(' '))
      .toMatch(/CAPACITY_PROFILE with no segments is only valid as the canonical zero-capacity PLANNED_RESOURCE state/)
  })

  it('accepts the canonical zero-capacity PLANNED_RESOURCE exception', async () => {
    const fixture = personProfile({
      ownerKind: 'PLANNED_RESOURCE',
      planningBasis: 'CAPACITY_PROFILE',
      source: 'SQUAD_PLANNER',
      defaultPercent: 0,
      startWeek: null,
      endWeek: null,
      segments: [],
    })
    await expectUniformVerdict(fixture, 'valid')
  })

  it('rejects the canonical shape for ROLE (exception is PLANNED_RESOURCE only)', async () => {
    const fixture = roleProfile({
      planningBasis: 'CAPACITY_PROFILE',
      source: 'SQUAD_PLANNER',
      defaultPercent: 0,
      segments: [],
    })
    await expectUniformVerdict(fixture, 'invalid')
  })

  it('rejects the canonical shape with a non-zero defaultPercent', async () => {
    const fixture = personProfile({
      ownerKind: 'PLANNED_RESOURCE',
      planningBasis: 'CAPACITY_PROFILE',
      source: 'SQUAD_PLANNER',
      defaultPercent: 50,
      segments: [],
    })
    await expectUniformVerdict(fixture, 'invalid')
  })

  it('rejects the canonical shape with a window', async () => {
    const fixture = personProfile({
      ownerKind: 'PLANNED_RESOURCE',
      planningBasis: 'CAPACITY_PROFILE',
      source: 'SQUAD_PLANNER',
      defaultPercent: 0,
      startWeek: 1,
      endWeek: 4,
      segments: [],
    })
    await expectUniformVerdict(fixture, 'invalid')
  })

  it('accepts the canonical zero PLANNED_RESOURCE with MANUAL source (transferred)', async () => {
    await expectUniformVerdict(
      personProfile({
        ownerKind: 'PLANNED_RESOURCE',
        planningBasis: 'CAPACITY_PROFILE',
        source: 'MANUAL',
        defaultPercent: 0,
        segments: [],
      }),
      'valid',
    )
  })
})
