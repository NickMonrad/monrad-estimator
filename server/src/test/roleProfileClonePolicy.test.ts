import { describe, it, expect } from 'vitest'
import {
  ROLE_DEFAULT_CLONE_LEGACY,
  isRoleDefaultClone,
  AggregateRoleCloneError,
  assertRoleProfileCloneableAsNamedPerson,
} from '../lib/roleProfileClonePolicy.js'
import { classifyNRsForRoleUpdate } from '../lib/classifyNRsForRoleUpdate.js'

describe('roleProfileClonePolicy', () => {
  describe('isRoleDefaultClone', () => {
    it('recognises the persisted ROLE_DEFAULT writer marker', () => {
      expect(isRoleDefaultClone({ legacy: ROLE_DEFAULT_CLONE_LEGACY })).toBe(true)
    })
    it('rejects empty, null, and absent legacy', () => {
      expect(isRoleDefaultClone({ legacy: {} })).toBe(false)
      expect(isRoleDefaultClone({ legacy: null })).toBe(false)
      expect(isRoleDefaultClone({ legacy: undefined })).toBe(false)
    })
    it('rejects other writers (e.g. optimiser-derived profiles)', () => {
      expect(isRoleDefaultClone({ legacy: { version: 1, writer: 'RESOURCE_OPTIMISER' } })).toBe(false)
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
        legacy: ROLE_DEFAULT_CLONE_LEGACY,
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
        legacy: ROLE_DEFAULT_CLONE_LEGACY,
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
        legacy: { version: 1, writer: 'RESOURCE_OPTIMISER' },
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
      { namedResourceId: 'nr-1', ownerKind: 'PLANNED_RESOURCE', source: 'SQUAD_PLANNER', legacy: {}, segments: [], planningBasis: 'CAPACITY_PROFILE' },
      { namedResourceId: 'nr-1', ownerKind: 'NAMED_PERSON', source: 'SQUAD_PLANNER', legacy: {}, segments: [], planningBasis: 'CAPACITY_PROFILE' },
      { namedResourceId: 'nr-1', ownerKind: 'NAMED_PERSON', source: 'DERIVED', legacy: null, segments: [], planningBasis: 'DEMAND_FOLLOWING' },
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
        legacy: ROLE_DEFAULT_CLONE_LEGACY,
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
