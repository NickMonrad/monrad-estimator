import { describe, expect, it } from 'vitest'
import {
  RESOURCE_OPTIMISER_PROFILE_PROVENANCE,
  OptimiserApplyConflictError,
  buildOptimiserMutationIntent,
  buildOptimiserRampUpProfileWrite,
  classifyOptimiserRampUpOwner,
  isValidOptimiserScopeForApply,
  validateNoProfileScalarState,
  isValidNamedResourceMapperProvenance,
  type OptimiserNamedResourceState,
  type PersistedOptimiserProfile,
} from '../lib/optimiserApplyService.js'

function namedResource(overrides: Partial<OptimiserNamedResourceState> = {}): OptimiserNamedResourceState {
  return {
    id: 'nr-dev',
    name: 'Alice',
    resourceTypeId: 'rt-dev',
    startWeek: null,
    endWeek: null,
    allocationPct: 100,
    allocationMode: 'EFFORT',
    allocationPercent: 100,
    allocationStartWeek: null,
    allocationEndWeek: null,
    ...overrides,
  }
}

function profile(overrides: Partial<PersistedOptimiserProfile> = {}): PersistedOptimiserProfile {
  return {
    id: 'profile-1',
    ownerKind: 'NAMED_PERSON',
    planningBasis: 'AVAILABILITY_WINDOW',
    source: 'MANUAL',
    namedResourceId: 'nr-dev',
    resourceTypeId: null,
    defaultPercent: 60,
    startWeek: 2,
    endWeek: 10,
    legacy: null,
    segments: [],
    ...overrides,
  }
}

function mapperLegacy(overrides: Record<string, unknown> = {}) {
  return {
    allocationMode: 'TIMELINE',
    allocationPercent: 60,
    allocationPct: 60,
    allocationStartWeek: 2,
    allocationEndWeek: 10,
    startWeek: 2,
    endWeek: 10,
    ...overrides,
  }
}

describe('classifyOptimiserRampUpOwner', () => {
  it('allows a named person without a persisted profile', () => {
    expect(classifyOptimiserRampUpOwner([], namedResource()).outcome).toBe('NO_PROFILE')
  })

  it('proves and allows a mapper-derived scalar profile only while legacy fields match', () => {
    const mappedOwner = namedResource({
      allocationMode: 'TIMELINE',
      allocationPercent: 60,
      allocationPct: 60,
      allocationStartWeek: 2,
      allocationEndWeek: 10,
      startWeek: 2,
      endWeek: 10,
    })
    const mapped = profile({
      source: 'AVAILABILITY_WINDOW',
      legacy: mapperLegacy(),
    })

    expect(isValidNamedResourceMapperProvenance(mapped, mappedOwner)).toBe(true)
    expect(classifyOptimiserRampUpOwner([mapped], mappedOwner).outcome).toBe('LEGACY_MAPPER_SCALAR')
    expect(isValidNamedResourceMapperProvenance(mapped, namedResource())).toBe(false)
    expect(classifyOptimiserRampUpOwner([mapped], namedResource()).outcome).toBe('EXPLICIT_SCALAR_PROTECTED')
  })

  it('allows only marked optimiser-derived scalar profiles', () => {
    const derived = profile({
      source: 'DERIVED',
      legacy: RESOURCE_OPTIMISER_PROFILE_PROVENANCE,
    })

    expect(classifyOptimiserRampUpOwner([derived], namedResource())).toEqual({
      outcome: 'OPTIMISER_DERIVED_SCALAR',
      profileId: 'profile-1',
    })
    expect(classifyOptimiserRampUpOwner([
      { ...derived, legacy: null },
    ], namedResource()).outcome).toBe('EXPLICIT_SCALAR_PROTECTED')
  })

  it.each([
    ['missing scalar percentage', profile({ source: 'DERIVED', legacy: RESOURCE_OPTIMISER_PROFILE_PROVENANCE, defaultPercent: null }), 'EXPLICIT_SCALAR_PROTECTED'],
    ['reversed availability window', profile({ source: 'DERIVED', legacy: RESOURCE_OPTIMISER_PROFILE_PROVENANCE, startWeek: 10, endWeek: 2 }), 'EXPLICIT_SCALAR_PROTECTED'],
    ['reversed mapper availability window', profile({ source: 'AVAILABILITY_WINDOW', legacy: mapperLegacy({ allocationStartWeek: 10, startWeek: 10, allocationEndWeek: 2, endWeek: 2 }), startWeek: 10, endWeek: 2 }), 'EXPLICIT_SCALAR_PROTECTED'],
  ])('does not adopt malformed %s', (_label, persisted, outcome) => {
    expect(classifyOptimiserRampUpOwner([persisted as PersistedOptimiserProfile], namedResource()).outcome).toBe(outcome)
  })

  it.each([
    ['explicit scalar', profile(), 'EXPLICIT_SCALAR_PROTECTED'],
    ['segmented scalar', profile({ source: 'DERIVED', legacy: RESOURCE_OPTIMISER_PROFILE_PROVENANCE, segments: [{ id: 'segment-1' }] }), 'SEGMENTED_PROTECTED'],
    ['capacity profile', profile({ planningBasis: 'CAPACITY_PROFILE' }), 'CAPACITY_PROFILE_PROTECTED'],
    ['planned resource', profile({ ownerKind: 'PLANNED_RESOURCE', source: 'SQUAD_PLANNER' }), 'PLANNER_MANAGED_PROTECTED'],
    ['squad planner source', profile({ source: 'SQUAD_PLANNER' }), 'PLANNER_MANAGED_PROTECTED'],
  ])('protects %s ownership', (_label, persisted, outcome) => {
    expect(classifyOptimiserRampUpOwner([persisted as PersistedOptimiserProfile], namedResource()).outcome).toBe(outcome)
  })

  it('fails closed for duplicate owner profiles', () => {
    expect(classifyOptimiserRampUpOwner([
      profile(),
      profile({ id: 'profile-2' }),
    ], namedResource()).outcome).toBe('AMBIGUOUS_OR_DUPLICATE')
  })
})
describe('isValidOptimiserScopeForApply', () => {
  it('accepts positive ramp-up entries that are in scope', () => {
    const candidate = [
      { resourceTypeId: 'rt-dev', count: 2, suggestedStartWeek: 4 },
    ]
    expect(isValidOptimiserScopeForApply(candidate, ['rt-dev'])).toBe(true)
  })

  it('rejects a positive ramp-up whose resource type is not in scope', () => {
    const candidate = [
      { resourceTypeId: 'rt-dev', count: 2, suggestedStartWeek: 4 },
    ]
    expect(isValidOptimiserScopeForApply(candidate, [])).toBe(false)
    expect(isValidOptimiserScopeForApply(candidate, ['rt-other'])).toBe(false)
  })

  it('allows scope to contain resource types with zero start week', () => {
    const candidate = [
      { resourceTypeId: 'rt-dev', count: 2, suggestedStartWeek: 0 },
      { resourceTypeId: 'rt-test', count: 1, suggestedStartWeek: 0 },
    ]
    expect(isValidOptimiserScopeForApply(candidate, ['rt-dev'])).toBe(true)
    expect(isValidOptimiserScopeForApply(candidate, ['rt-dev', 'rt-test'])).toBe(true)
    expect(isValidOptimiserScopeForApply(candidate, [])).toBe(true)
  })

  it('rejects non-array scope', () => {
    const candidate = [{ resourceTypeId: 'rt-dev', count: 2, suggestedStartWeek: 4 }]
    expect(isValidOptimiserScopeForApply(candidate, null as unknown as string[])).toBe(false)
    expect(isValidOptimiserScopeForApply(candidate, undefined as unknown as string[])).toBe(false)
  })

  it('rejects scope with duplicates', () => {
    const candidate = [{ resourceTypeId: 'rt-dev', count: 2, suggestedStartWeek: 4 }]
    expect(isValidOptimiserScopeForApply(candidate, ['rt-dev', 'rt-dev'])).toBe(false)
  })

  it('rejects scope with non-string elements', () => {
    const candidate = [{ resourceTypeId: 'rt-dev', count: 2, suggestedStartWeek: 4 }]
    expect(isValidOptimiserScopeForApply(candidate, [42 as unknown as string])).toBe(false)
  })
})

describe('validateNoProfileScalarState', () => {
  it('accepts valid EFFORT state', () => {
    expect(validateNoProfileScalarState(namedResource({ allocationMode: 'EFFORT' }))).toEqual({ valid: true })
  })

  it('accepts EFFORT with null percentage fields', () => {
    // TypeScript cast: dynamically test null/undefined runtime values that
    // could reach the service via deserialised API payloads.
    const nr = namedResource() as unknown as Record<string, unknown>
    nr.allocationMode = 'EFFORT'
    nr.allocationPercent = null
    nr.allocationPct = null
    expect(validateNoProfileScalarState(nr as unknown as OptimiserNamedResourceState)).toEqual({ valid: true })
  })

  it('rejects EFFORT with negative start week', () => {
    expect(validateNoProfileScalarState(namedResource({
      allocationMode: 'EFFORT',
      startWeek: -1,
    }))).toEqual({ valid: false, reason: expect.stringContaining('startWeek') })
  })

  it('rejects EFFORT with fractional start week', () => {
    expect(validateNoProfileScalarState(namedResource({
      allocationMode: 'EFFORT',
      startWeek: 2.5,
    }))).toEqual({ valid: false, reason: expect.stringContaining('startWeek') })
  })

  it('rejects EFFORT with start after end week', () => {
    expect(validateNoProfileScalarState(namedResource({
      allocationMode: 'EFFORT',
      allocationStartWeek: 10,
      allocationEndWeek: 5,
    }))).toEqual({ valid: false, reason: expect.stringContaining('after') })
  })

  it('rejects EFFORT with contradictory start aliases', () => {
    expect(validateNoProfileScalarState(namedResource({
      allocationMode: 'EFFORT',
      startWeek: 1,
      allocationStartWeek: 3,
    }))).toEqual({ valid: false, reason: expect.stringContaining('Contradictory') })
  })

  it('rejects EFFORT with contradictory end aliases', () => {
    expect(validateNoProfileScalarState(namedResource({
      allocationMode: 'EFFORT',
      endWeek: 10,
      allocationEndWeek: 12,
    }))).toEqual({ valid: false, reason: expect.stringContaining('Contradictory') })
  })

  it('rejects EFFORT with negative allocationEndWeek', () => {
    expect(validateNoProfileScalarState(namedResource({
      allocationMode: 'EFFORT',
      allocationEndWeek: -5,
    }))).toEqual({ valid: false, reason: expect.stringContaining('allocationEndWeek') })
  })

  it('accepts valid TIMELINE with allocationPercent', () => {
    expect(validateNoProfileScalarState(namedResource({
      allocationMode: 'TIMELINE',
      allocationPercent: 80,
      allocationPct: 80,
    }))).toEqual({ valid: true })
  })
  it('accepts valid TIMELINE with allocationPct only', () => {
    const nr = namedResource() as unknown as Record<string, unknown>
    nr.allocationMode = 'TIMELINE'
    nr.allocationPercent = null
    nr.allocationPct = 75
    expect(validateNoProfileScalarState(nr as unknown as OptimiserNamedResourceState)).toEqual({ valid: true })
  })

  it('accepts valid FULL_PROJECT with allocationPercent only', () => {
    const nr = namedResource() as unknown as Record<string, unknown>
    nr.allocationMode = 'FULL_PROJECT'
    nr.allocationPercent = 100
    nr.allocationPct = null
    expect(validateNoProfileScalarState(nr as unknown as OptimiserNamedResourceState)).toEqual({ valid: true })
  })

  it('rejects CAPACITY_PLAN mode', () => {
    const result = validateNoProfileScalarState(namedResource({ allocationMode: 'CAPACITY_PLAN' }))
    expect(result).toEqual({ valid: false, reason: expect.stringContaining('CAPACITY_PLAN') })
  })

  it('rejects unsupported mode XYZ', () => {
    const result = validateNoProfileScalarState(namedResource({ allocationMode: 'XYZ' as never }))
    expect(result).toEqual({ valid: false, reason: expect.stringContaining('XYZ') })
  })

  it('rejects missing allocation percent for TIMELINE', () => {
    const nr = namedResource() as unknown as Record<string, unknown>
    nr.allocationMode = 'TIMELINE'
    nr.allocationPercent = null
    nr.allocationPct = null
    const result = validateNoProfileScalarState(nr as unknown as OptimiserNamedResourceState)
    expect(result).toEqual({ valid: false, reason: expect.stringContaining('Missing allocation percent') })
  })

  it('rejects contradictory allocationPercent and allocationPct', () => {
    const result = validateNoProfileScalarState(namedResource({
      allocationMode: 'TIMELINE',
      allocationPercent: 80,
      allocationPct: 50,
    }))
    expect(result).toEqual({ valid: false, reason: expect.stringContaining('Contradictory') })
  })

  it('rejects start week after end week', () => {
    const result = validateNoProfileScalarState(namedResource({
      allocationMode: 'TIMELINE',
      allocationPercent: 80,
      allocationPct: 80,
      startWeek: 10,
      endWeek: 5,
      allocationStartWeek: 10,
      allocationEndWeek: 5,
    }))
    expect(result).toEqual({ valid: false, reason: expect.stringContaining('after') })
  })

  it('rejects contradictory startWeek and allocationStartWeek', () => {
    const result = validateNoProfileScalarState(namedResource({
      allocationMode: 'TIMELINE',
      allocationPercent: 80,
      allocationPct: 80,
      startWeek: 1,
      allocationStartWeek: 3,
    }))
    expect(result).toEqual({ valid: false, reason: expect.stringContaining('Contradictory') })
  })

  it('rejects negative start week', () => {
    const result = validateNoProfileScalarState(namedResource({
      allocationMode: 'TIMELINE',
      allocationPercent: 80,
      allocationPct: 80,
      allocationStartWeek: -1,
    }))
    expect(result).toEqual({ valid: false, reason: expect.stringContaining('-1') })
  })

  it('rejects percentage over 100', () => {
    const result = validateNoProfileScalarState(namedResource({
      allocationMode: 'TIMELINE',
      allocationPercent: 150,
      allocationPct: 150,
    }))
    expect(result).toEqual({ valid: false, reason: expect.stringContaining('150') })
  })

  it('rejects non-finite percentage', () => {
    const result = validateNoProfileScalarState(namedResource({
      allocationMode: 'TIMELINE',
      allocationPercent: Infinity,
      allocationPct: Infinity,
    }))
    expect(result).toEqual({ valid: false, reason: expect.stringContaining('Infinity') })
  })
})

describe('buildOptimiserRampUpProfileWrite', () => {
  it('creates profile-first scalar availability and preserves EFFORT as 100 percent', () => {
    const classification = classifyOptimiserRampUpOwner([], namedResource())
    if (classification.outcome !== 'NO_PROFILE') throw new Error('Expected eligible owner')

    const write = buildOptimiserRampUpProfileWrite(
      classification,
      namedResource({ allocationPercent: 35, allocationPct: 35 }),
      undefined,
      4,
    )

    expect(write).toMatchObject({
      profileId: null,
      startWeek: 4,
      endWeek: null,
      defaultPercent: 100,
      projection: {
        allocationMode: 'TIMELINE',
        allocationPercent: 100,
        allocationStartWeek: 4,
        allocationEndWeek: null,
        lossy: false,
      },
    })
  })

  it.each(['TIMELINE', 'FULL_PROJECT'])('preserves %s scalar percent and end boundary', allocationMode => {
    const classification = classifyOptimiserRampUpOwner([], namedResource({ allocationMode }))
    if (classification.outcome !== 'NO_PROFILE') throw new Error('Expected eligible owner')

    const write = buildOptimiserRampUpProfileWrite(
      classification,
      namedResource({ allocationMode, allocationPercent: 65, allocationEndWeek: 12 }),
      undefined,
      5,
    )

    expect(write.defaultPercent).toBe(65)
    expect(write.endWeek).toBe(12)
    expect(write.projection.allocationStartWeek).toBe(5)
    expect(write.projection.allocationEndWeek).toBe(12)
  })

  it('retains the profile ID on optimiser reapply', () => {
    const persisted = profile({
      source: 'DERIVED',
      legacy: RESOURCE_OPTIMISER_PROFILE_PROVENANCE,
    })
    const classification = classifyOptimiserRampUpOwner([persisted], namedResource())
    if (classification.outcome !== 'OPTIMISER_DERIVED_SCALAR') throw new Error('Expected eligible owner')

    expect(buildOptimiserRampUpProfileWrite(
      classification,
      namedResource(),
      persisted,
      6,
    ).profileId).toBe('profile-1')
  })

  it('rejects a ramp-up week after the preserved end boundary', () => {
    const classification = classifyOptimiserRampUpOwner([], namedResource())
    if (classification.outcome !== 'NO_PROFILE') throw new Error('Expected eligible owner')

    expect(() => buildOptimiserRampUpProfileWrite(
      classification,
      namedResource({ allocationEndWeek: 3 }),
      undefined,
      4,
    )).toThrow(OptimiserApplyConflictError)
  })
})

describe('buildOptimiserMutationIntent', () => {
  it('emits no writes for unchanged full-candidate entries', () => {
    expect(buildOptimiserMutationIntent({
      candidate: [{ resourceTypeId: 'rt-dev', count: 2, suggestedStartWeek: 3 }],
      optimiserScopeResourceTypeIds: new Set(['rt-dev']),
      resourceTypes: [{ id: 'rt-dev', name: 'Developer', count: 2 }],
      namedResources: [namedResource({ allocationStartWeek: 3 })],
      profilesByNamedResourceId: new Map(),
      plannerManagedResourceTypeIds: new Set(),
    }).intents).toEqual([])
  })

  it('does not let an inert planner role block an unrelated count change', () => {
    const plan = buildOptimiserMutationIntent({
      candidate: [
        { resourceTypeId: 'rt-dev', count: 2, suggestedStartWeek: 0 },
        { resourceTypeId: 'rt-test', count: 3, suggestedStartWeek: 0 },
      ],
      resourceTypes: [
        { id: 'rt-dev', name: 'Developer', count: 2 },
        { id: 'rt-test', name: 'Tester', count: 1 },
      ],
      namedResources: [namedResource({ allocationMode: 'CAPACITY_PLAN', allocationStartWeek: 3 })],
      optimiserScopeResourceTypeIds: new Set(),
      profilesByNamedResourceId: new Map(),
      plannerManagedResourceTypeIds: new Set(['rt-dev']),
    })

    expect(plan.intents).toEqual([{ kind: 'count', resourceTypeId: 'rt-test', count: 3 }])
  })

  it('rejects a changed planner-managed role with Squad Planner guidance', () => {
    expect(() => buildOptimiserMutationIntent({
      candidate: [{ resourceTypeId: 'rt-dev', count: 3, suggestedStartWeek: 0 }],
      resourceTypes: [{ id: 'rt-dev', name: 'Developer', count: 2 }],
      namedResources: [],
      optimiserScopeResourceTypeIds: new Set(),
      profilesByNamedResourceId: new Map(),
      plannerManagedResourceTypeIds: new Set(['rt-dev']),
    })).toThrow('Refine in Squad Planner')
  })

  it('fails closed before writes when a changed owner is explicit', () => {
    expect(() => buildOptimiserMutationIntent({
      candidate: [{ resourceTypeId: 'rt-dev', count: 2, suggestedStartWeek: 5 }],
      resourceTypes: [{ id: 'rt-dev', name: 'Developer', count: 2 }],
      namedResources: [namedResource()],
      optimiserScopeResourceTypeIds: new Set(['rt-dev']),
      profilesByNamedResourceId: new Map([['nr-dev', [profile()]]]),
      plannerManagedResourceTypeIds: new Set(),
    })).toThrow(OptimiserApplyConflictError)
  })

  it('does not mutate protected owners outside the ramp-up scope', () => {
    expect(buildOptimiserMutationIntent({
      candidate: [{ resourceTypeId: 'rt-dev', count: 2, suggestedStartWeek: 0 }],
      optimiserScopeResourceTypeIds: new Set(),
      resourceTypes: [{ id: 'rt-dev', name: 'Developer', count: 2 }],
      namedResources: [namedResource()],
      profilesByNamedResourceId: new Map([['nr-dev', [profile()]]]),
      plannerManagedResourceTypeIds: new Set(),
    }).intents).toEqual([])
  })
})
