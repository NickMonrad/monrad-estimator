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
    provenance: null,
    segments: [],
    ...overrides,
  }
}

/** A strict-mapper-shaped scalar NAMED_PERSON profile (issue #405). */
function mapperProfile(overrides: Partial<PersistedOptimiserProfile> = {}): PersistedOptimiserProfile {
  return profile({
    provenance: 'LEGACY_MAPPER',
    ...overrides,
  })
}

describe('classifyOptimiserRampUpOwner', () => {
  it('fails closed for a named person without a persisted profile (issue #418)', () => {
    expect(classifyOptimiserRampUpOwner([], namedResource()).outcome).toBe('MISSING_PROFILE')
  })

  it('proves and allows a mapper-derived scalar profile (explicit provenance, issue #405)', () => {
    const mapped = mapperProfile({
      source: 'AVAILABILITY_WINDOW',
    })

    // The provenance check is profile-internal: candidate NamedResource
    // columns are never consulted.
    expect(isValidNamedResourceMapperProvenance(mapped)).toBe(true)
    expect(classifyOptimiserRampUpOwner([mapped], namedResource()).outcome).toBe('LEGACY_MAPPER_SCALAR')

    const divergent = mapperProfile({
      source: 'AVAILABILITY_WINDOW',
      defaultPercent: 80,
    })
    // Issue #405: the legacy payload's percent-agreement check is gone — the
    // persisted defaultPercent is authoritative. A mapper-provenance profile
    // whose percent was changed without a source/provenance write stays
    // mapper-owned; user edits through the replace path change source to
    // MANUAL and clear provenance, which is what protects them.
    expect(isValidNamedResourceMapperProvenance(divergent)).toBe(true)
    expect(classifyOptimiserRampUpOwner([divergent], namedResource()).outcome).toBe('LEGACY_MAPPER_SCALAR')

    // A user-edited profile (source MANUAL) is protected even when it once
    // carried mapper provenance: the pair check rejects it, and the
    // CAPACITY_PROFILE basis classifies it as protected before scalar checks.
    const edited = mapperProfile({
      source: 'MANUAL',
      planningBasis: 'CAPACITY_PROFILE',
    })
    expect(isValidNamedResourceMapperProvenance(edited)).toBe(false)
    expect(classifyOptimiserRampUpOwner([edited], namedResource()).outcome).toBe('CAPACITY_PROFILE_PROTECTED')

    const unmarked = profile({
      source: 'AVAILABILITY_WINDOW',
    })
    expect(isValidNamedResourceMapperProvenance(unmarked)).toBe(false)
    expect(classifyOptimiserRampUpOwner([unmarked], namedResource()).outcome).toBe('EXPLICIT_SCALAR_PROTECTED')
  })

  it('allows only marked optimiser-derived scalar profiles', () => {
    const derived = profile({
      source: 'DERIVED',
      provenance: RESOURCE_OPTIMISER_PROFILE_PROVENANCE,
    })

    expect(classifyOptimiserRampUpOwner([derived], namedResource())).toEqual({
      outcome: 'OPTIMISER_DERIVED_SCALAR',
      profileId: 'profile-1',
    })
    expect(classifyOptimiserRampUpOwner([
      { ...derived, provenance: null },
    ], namedResource()).outcome).toBe('EXPLICIT_SCALAR_PROTECTED')
  })

  it.each([
    ['missing scalar percentage', profile({ source: 'DERIVED', provenance: RESOURCE_OPTIMISER_PROFILE_PROVENANCE, defaultPercent: null }), 'EXPLICIT_SCALAR_PROTECTED'],
    ['reversed availability window', profile({ source: 'DERIVED', provenance: RESOURCE_OPTIMISER_PROFILE_PROVENANCE, startWeek: 10, endWeek: 2 }), 'EXPLICIT_SCALAR_PROTECTED'],
    ['reversed mapper availability window', profile({ source: 'AVAILABILITY_WINDOW', provenance: 'LEGACY_MAPPER', startWeek: 10, endWeek: 2 }), 'EXPLICIT_SCALAR_PROTECTED'],
  ])('does not adopt malformed %s', (_label, persisted, outcome) => {
    expect(classifyOptimiserRampUpOwner([persisted as PersistedOptimiserProfile], namedResource()).outcome).toBe(outcome)
  })

  it.each([
    ['explicit scalar', profile(), 'EXPLICIT_SCALAR_PROTECTED'],
    ['segmented scalar', profile({ source: 'DERIVED', provenance: RESOURCE_OPTIMISER_PROFILE_PROVENANCE, segments: [{ id: 'segment-1' }] }), 'SEGMENTED_PROTECTED'],
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
      provenance: 'LEGACY_MAPPER',
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

  it('ramps EFFORT-mode mapper profiles at a fixed 100% even when the persisted percent differs', () => {
    // Issue #405: a migrated strict mapper EFFORT profile may persist a
    // non-100 defaultPercent (the legacy mapper accepted any finite percent).
    // The old runtime mapped allocationMode==='EFFORT' to 100 regardless, and
    // the EFFORT pair (FIXED/DEMAND_FOLLOWING) is its authoritative shape
    // evidence — the ramp-up write must keep the 100% behaviour.
    const persisted = profile({
      source: 'FIXED',
      planningBasis: 'DEMAND_FOLLOWING',
      provenance: 'LEGACY_MAPPER',
      defaultPercent: 60,
      startWeek: null,
      endWeek: null,
    })
    const classification = classifyOptimiserRampUpOwner([persisted], namedResource())
    if (classification.outcome !== 'LEGACY_MAPPER_SCALAR') throw new Error('Expected eligible owner')

    const write = buildOptimiserRampUpProfileWrite(classification, namedResource(), persisted, 4)

    expect(write.defaultPercent).toBe(100)
  })

  it.each([
    ['TIMELINE', 'AVAILABILITY_WINDOW', 'AVAILABILITY_WINDOW'],
    ['FULL_PROJECT', 'FIXED', 'WHOLE_PROJECT_ALLOCATION'],
  ])('preserves %s scalar percent and end boundary', (_allocationMode, source, planningBasis) => {
    const persisted = profile({
      source,
      planningBasis,
      provenance: 'LEGACY_MAPPER',
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
      provenance: RESOURCE_OPTIMISER_PROFILE_PROVENANCE,
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
      provenance: 'LEGACY_MAPPER',
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
      provenance: 'LEGACY_MAPPER',
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
