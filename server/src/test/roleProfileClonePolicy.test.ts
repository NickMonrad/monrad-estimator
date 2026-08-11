import { describe, it, expect } from 'vitest'
import {
  ROLE_DEFAULT_CLONE_PROVENANCE,
  isRoleDefaultClone,
  AggregateRoleCloneError,
  assertRoleProfileCloneableAsNamedPerson,
} from '../lib/roleProfileClonePolicy.js'
import { classifyNRsForRoleUpdate } from '../lib/classifyNRsForRoleUpdate.js'

describe('roleProfileClonePolicy', () => {
  describe('isRoleDefaultClone', () => {
    it('recognises the explicit ROLE_DEFAULT provenance (issue #405)', () => {
      expect(isRoleDefaultClone({ provenance: ROLE_DEFAULT_CLONE_PROVENANCE })).toBe(true)
    })
    it('rejects null, absent, and other provenance values', () => {
      expect(isRoleDefaultClone({ provenance: null })).toBe(false)
      expect(isRoleDefaultClone({ provenance: undefined })).toBe(false)
      expect(isRoleDefaultClone({})).toBe(false)
    })
    it('rejects other provenance values (e.g. optimiser-derived profiles)', () => {
      expect(isRoleDefaultClone({ provenance: 'RESOURCE_OPTIMISER' })).toBe(false)
      expect(isRoleDefaultClone({ provenance: 'LEGACY_MAPPER' })).toBe(false)
      expect(isRoleDefaultClone({ provenance: 'TRANSFERRED_FROM_SQUAD_PLANNER' })).toBe(false)
    })
  })

  describe('assertRoleProfileCloneableAsNamedPerson', () => {
    it('accepts per-person-safe ROLE shapes at the 100 boundary', () => {
      expect(() => assertRoleProfileCloneableAsNamedPerson({
        defaultPercent: 100,
        segments: [
          { startWeek: 0, endWeek: 4, capacityPercent: 100 },
          { startWeek: 5, endWeek: 8, capacityPercent: 0 },
        ],
      })).not.toThrow()
    })
    it('rejects aggregate defaultPercent above 100 with an actionable message', () => {
      try {
        assertRoleProfileCloneableAsNamedPerson({ defaultPercent: 150, segments: [] })
        throw new Error('expected rejection')
      } catch (error) {
        expect(error).toBeInstanceOf(AggregateRoleCloneError)
        expect((error as AggregateRoleCloneError).code).toBe('AGGREGATE_ROLE_CAPACITY')
        expect((error as AggregateRoleCloneError).message).toContain('150')
        expect((error as AggregateRoleCloneError).message).toContain('100%')
      }
    })
    it('rejects a segment above 100 and names the week range', () => {
      try {
        assertRoleProfileCloneableAsNamedPerson({
          defaultPercent: 60,
          segments: [
            { startWeek: 2, endWeek: 4, capacityPercent: 80 },
            { startWeek: 5, endWeek: 7, capacityPercent: 120 },
          ],
        })
        throw new Error('expected rejection')
      } catch (error) {
        expect(error).toBeInstanceOf(AggregateRoleCloneError)
        expect((error as AggregateRoleCloneError).message).toContain('W5-W7')
        expect((error as AggregateRoleCloneError).message).toContain('120')
      }
    })
  })
})

describe('classifyNRsForRoleUpdate — generated segmented profiles (#403 finding 1)', () => {
  // The old role default is now the authoritative old role PROFILE shape
  // (issue #418): classification compares profile shapes, never candidate
  // ResourceType/NamedResource columns.
  const oldRoleProfile = {
    planningBasis: 'AVAILABILITY_WINDOW',
    defaultPercent: 75,
    startWeek: 4,
    endWeek: 12,
    segments: [{ startWeek: 0, endWeek: 4, capacityPercent: 100 }],
  }

  it('classifies a generated segmented clone (DERIVED + ROLE_DEFAULT) as inherited', () => {
    const result = classifyNRsForRoleUpdate(
      [{ id: 'nr-1' }],
      [{
        namedResourceId: 'nr-1',
        ownerKind: 'NAMED_PERSON',
        source: 'DERIVED',
        provenance: ROLE_DEFAULT_CLONE_PROVENANCE,
        planningBasis: 'AVAILABILITY_WINDOW',
        defaultPercent: 75,
        startWeek: 4,
        endWeek: 12,
        segments: [{ startWeek: 0, endWeek: 4, capacityPercent: 100 }],
      }],
      oldRoleProfile,
    )
    expect(result.inheritedNRIds).toEqual(['nr-1'])
    expect(result.explicitNRIds).toEqual([])
  })

  it('still protects a user-edited segmented profile (source MANUAL)', () => {
    const result = classifyNRsForRoleUpdate(
      [{ id: 'nr-1' }],
      [{
        namedResourceId: 'nr-1',
        ownerKind: 'NAMED_PERSON',
        source: 'MANUAL',
        provenance: ROLE_DEFAULT_CLONE_PROVENANCE,
        planningBasis: 'AVAILABILITY_WINDOW',
        defaultPercent: 75,
        startWeek: 4,
        endWeek: 12,
        segments: [{ startWeek: 0, endWeek: 4, capacityPercent: 100 }],
      }],
      oldRoleProfile,
    )
    expect(result.explicitNRIds).toEqual(['nr-1'])
    expect(result.inheritedNRIds).toEqual([])
  })

  it('still protects optimiser-derived segmented profiles', () => {
    const result = classifyNRsForRoleUpdate(
      [{ id: 'nr-1' }],
      [{
        namedResourceId: 'nr-1',
        ownerKind: 'NAMED_PERSON',
        source: 'DERIVED',
        provenance: 'RESOURCE_OPTIMISER',
        planningBasis: 'AVAILABILITY_WINDOW',
        defaultPercent: 75,
        startWeek: 4,
        endWeek: 12,
        segments: [{ startWeek: 0, endWeek: 4, capacityPercent: 100 }],
      }],
      oldRoleProfile,
    )
    expect(result.explicitNRIds).toEqual(['nr-1'])
    expect(result.inheritedNRIds).toEqual([])
  })

  it('still protects planner-owned and ambiguous profiles', () => {
    for (const profile of [
      { namedResourceId: 'nr-1', ownerKind: 'PLANNED_RESOURCE', source: 'SQUAD_PLANNER', provenance: null, segments: [], planningBasis: 'CAPACITY_PROFILE' },
      { namedResourceId: 'nr-1', ownerKind: 'NAMED_PERSON', source: 'SQUAD_PLANNER', provenance: null, segments: [], planningBasis: 'CAPACITY_PROFILE' },
      { namedResourceId: 'nr-1', ownerKind: 'NAMED_PERSON', source: 'DERIVED', provenance: null, segments: [], planningBasis: 'DEMAND_FOLLOWING' },
    ]) {
      const result = classifyNRsForRoleUpdate(
        [{ id: 'nr-1' }],
        [profile],
        oldRoleProfile,
      )
      expect(result.explicitNRIds).toEqual(['nr-1'])
      expect(result.inheritedNRIds).toEqual([])
    }
  })

  it('keeps a generated segmented clone protected once its profile shape diverges from the role default', () => {
    // The clone's authoritative profile shape differs from the old role
    // profile shape (defaultPercent 40 vs 75) — profile-shape comparison
    // classifies it explicit, exactly as the former legacy-column equality
    // did for a diverged NR.
    const result = classifyNRsForRoleUpdate(
      [{ id: 'nr-1' }],
      [{
        namedResourceId: 'nr-1',
        ownerKind: 'NAMED_PERSON',
        source: 'DERIVED',
        provenance: ROLE_DEFAULT_CLONE_PROVENANCE,
        planningBasis: 'AVAILABILITY_WINDOW',
        defaultPercent: 40,
        startWeek: 4,
        endWeek: 12,
        segments: [{ startWeek: 0, endWeek: 4, capacityPercent: 100 }],
      }],
      oldRoleProfile,
    )
    expect(result.explicitNRIds).toEqual(['nr-1'])
    expect(result.inheritedNRIds).toEqual([])
  })
})
