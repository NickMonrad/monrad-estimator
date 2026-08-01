import { describe, expect, it } from 'vitest'
import {
  RESOURCE_OPTIMISER_PROFILE_PROVENANCE,
  OptimiserApplyConflictError,
  buildOptimiserMutationIntent,
  buildOptimiserRampUpProfileWrite,
  classifyOptimiserRampUpOwner,
  isValidOptimiserScopeForApply,
  isValidNamedResourceMapperProvenance,
  type OptimiserNamedResourceState,
  type PersistedOptimiserProfile,
} from '../lib/optimiserApplyService.js'

function namedResource(overrides: Partial<OptimiserNamedResourceState> = {}): OptimiserNamedResourceState {
  return {
    id: 'nr-dev',
    name: 'Alice',
    resourceTypeId: 'rt-dev',
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
  it('fails closed for a named person without a persisted profile (issue #418)', () => {
    expect(classifyOptimiserRampUpOwner([], namedResource()).outcome).toBe('MISSING_PROFILE')
  })

  it('proves and allows a mapper-derived scalar profile (profile-internal check, issue #418)', () => {
    const mapped = profile({
      source: 'AVAILABILITY_WINDOW',
      legacy: mapperLegacy(),
    })

    // The provenance check is profile-internal: candidate NamedResource
    // columns are never consulted.
    expect(isValidNamedResourceMapperProvenance(mapped)).toBe(true)
    expect(classifyOptimiserRampUpOwner([mapped], namedResource()).outcome).toBe('LEGACY_MAPPER_SCALAR')

    const divergent = profile({
      source: 'AVAILABILITY_WINDOW',
      legacy: mapperLegacy(),
      defaultPercent: 80,
    })
    expect(isValidNamedResourceMapperProvenance(divergent)).toBe(false)
    expect(classifyOptimiserRampUpOwner([divergent], namedResource()).outcome).toBe('EXPLICIT_SCALAR_PROTECTED')
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

describe('buildOptimiserRampUpProfileWrite', () => {
  it('creates profile-first scalar availability and preserves EFFORT as 100 percent', () => {
    const persisted = profile({
      source: 'FIXED',
      planningBasis: 'DEMAND_FOLLOWING',
      legacy: mapperLegacy({ allocationMode: 'EFFORT', allocationPercent: null, allocationPct: null, allocationStartWeek: null, allocationEndWeek: null, startWeek: null, endWeek: null }),
      defaultPercent: 100,
      startWeek: null,
      endWeek: null,
    })
    const classification = classifyOptimiserRampUpOwner([persisted], namedResource())
    if (classification.outcome !== 'LEGACY_MAPPER_SCALAR') throw new Error('Expected eligible owner')

    const write = buildOptimiserRampUpProfileWrite(classification, namedResource(), persisted, 4)

    expect(write).toEqual({
      profileId: 'profile-1',
      namedResourceId: 'nr-dev',
      resourceTypeId: 'rt-dev',
      startWeek: 4,
      endWeek: null,
      defaultPercent: 100,
    })
  })

  it.each([
    ['TIMELINE', 'AVAILABILITY_WINDOW', 'AVAILABILITY_WINDOW'],
    ['FULL_PROJECT', 'FIXED', 'WHOLE_PROJECT_ALLOCATION'],
  ])('preserves %s scalar percent and end boundary', (allocationMode, source, planningBasis) => {
    const persisted = profile({
      source,
      planningBasis,
      legacy: mapperLegacy({ allocationMode, allocationPercent: 65, allocationPct: 65, allocationEndWeek: 12, endWeek: 12 }),
      defaultPercent: 65,
      endWeek: 12,
    })
    const classification = classifyOptimiserRampUpOwner([persisted], namedResource())
    if (classification.outcome !== 'LEGACY_MAPPER_SCALAR') throw new Error('Expected eligible owner')

    const write = buildOptimiserRampUpProfileWrite(classification, namedResource(), persisted, 5)

    expect(write.defaultPercent).toBe(65)
    expect(write.endWeek).toBe(12)
    expect(write.startWeek).toBe(5)
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
    const persisted = profile({
      source: 'AVAILABILITY_WINDOW',
      legacy: mapperLegacy({ allocationEndWeek: 3, endWeek: 3 }),
      defaultPercent: 60,
      startWeek: 2,
      endWeek: 3,
    })
    const classification = classifyOptimiserRampUpOwner([persisted], namedResource())
    if (classification.outcome !== 'LEGACY_MAPPER_SCALAR') throw new Error('Expected eligible owner')

    expect(() => buildOptimiserRampUpProfileWrite(
      classification,
      namedResource(),
      persisted,
      4,
    )).toThrow(OptimiserApplyConflictError)
  })
})

describe('buildOptimiserMutationIntent', () => {
  it('emits no writes for unchanged full-candidate entries', () => {
    const persisted = profile({
      source: 'AVAILABILITY_WINDOW',
      legacy: mapperLegacy({ allocationStartWeek: 3, startWeek: 3 }),
      startWeek: 3,
    })
    expect(buildOptimiserMutationIntent({
      candidate: [{ resourceTypeId: 'rt-dev', count: 2, suggestedStartWeek: 3 }],
      optimiserScopeResourceTypeIds: new Set(['rt-dev']),
      resourceTypes: [{ id: 'rt-dev', name: 'Developer', count: 2 }],
      namedResources: [namedResource()],
      profilesByNamedResourceId: new Map([['nr-dev', [persisted]]]),
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
      namedResources: [namedResource()],
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
