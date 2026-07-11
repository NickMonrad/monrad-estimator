/**
 * resolveRoleDefaultForMutation.test.ts — Pure unit tests for the
 * role-default resolution helper used by the PATCH count route.
 *
 * These test the projection and precedence rules without any route,
 * database, or sync involvement.
 *
 * @see resolveRoleDefaultForMutation.ts
 */
import { describe, expect, it } from 'vitest'
import { resolveRoleDefaultForMutation, toLegacyAllocationPct } from '../lib/resolveRoleDefaultForMutation.js'
import type { RoleDefaultResourceTypeLike, RoleProfileLike } from '../lib/resolveRoleDefaultForMutation.js'

// ─── Fixture factories ────────────────────────────────────────────────────────

function resourceType(overrides: Partial<RoleDefaultResourceTypeLike> = {}): RoleDefaultResourceTypeLike {
  return {
    allocationMode: 'TIMELINE',
    allocationPercent: 100,
    allocationStartWeek: null,
    allocationEndWeek: null,
    ...overrides,
  }
}

function profile(overrides: Partial<RoleProfileLike> = {}): RoleProfileLike {
  return {
    planningBasis: 'DEMAND_FOLLOWING',
    defaultPercent: 70,
    startWeek: null,
    endWeek: null,
    segments: [],
    ...overrides,
  }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('resolveRoleDefaultForMutation', () => {

  describe('no profile fallback', () => {
    it('no role profile, RT TIMELINE/60/W2-W8 → LEGACY TIMELINE/60/W2-W8', () => {
      const result = resolveRoleDefaultForMutation({
        resourceType: resourceType({
          allocationMode: 'TIMELINE',
          allocationPercent: 60,
          allocationStartWeek: 2,
          allocationEndWeek: 8,
        }),
        roleProfiles: [],
      })

      expect(result.source).toBe('LEGACY')
      expect(result.allocationMode).toBe('TIMELINE')
      expect(result.allocationPercent).toBe(60)
      expect(result.allocationStartWeek).toBe(2)
      expect(result.allocationEndWeek).toBe(8)
      expect(result.lossy).toBe(false)
      expect(toLegacyAllocationPct(result.allocationPercent!)).toBe(60)
    })
  })

  describe('scalar profile precedence', () => {
    it('RT TIMELINE/100, role DEMAND_FOLLOWING/70 → PROFILE EFFORT/70/null/null', () => {
      const result = resolveRoleDefaultForMutation({
        resourceType: resourceType({ allocationMode: 'TIMELINE', allocationPercent: 100 }),
        roleProfiles: [profile({
          planningBasis: 'DEMAND_FOLLOWING',
          defaultPercent: 70,
        })],
      })

      expect(result.source).toBe('PROFILE')
      // DEMAND_FOLLOWING maps to EFFORT in legacy
      expect(result.allocationMode).toBe('EFFORT')
      expect(result.allocationPercent).toBe(70)
      expect(result.allocationStartWeek).toBeNull()
      expect(result.allocationEndWeek).toBeNull()
      expect(toLegacyAllocationPct(result.allocationPercent!)).toBe(70)
    })
  })

  describe('availability profile', () => {
    it('role AVAILABILITY_WINDOW/60/W2-W8 → TIMELINE/60/W2-W8', () => {
      const result = resolveRoleDefaultForMutation({
        resourceType: resourceType({ allocationMode: 'TIMELINE', allocationPercent: 100 }),
        roleProfiles: [profile({
          planningBasis: 'AVAILABILITY_WINDOW',
          defaultPercent: 60,
          startWeek: 2,
          endWeek: 8,
        })],
      })

      expect(result.source).toBe('PROFILE')
      expect(result.allocationMode).toBe('TIMELINE')
      expect(result.allocationPercent).toBe(60)
      expect(result.allocationStartWeek).toBe(2)
      expect(result.allocationEndWeek).toBe(8)
    })
  })

  describe('whole-project profile', () => {
    it('role WHOLE_PROJECT_ALLOCATION/80 → FULL_PROJECT/80/null/null', () => {
      const result = resolveRoleDefaultForMutation({
        resourceType: resourceType({ allocationMode: 'TIMELINE', allocationPercent: 100 }),
        roleProfiles: [profile({
          planningBasis: 'WHOLE_PROJECT_ALLOCATION',
          defaultPercent: 80,
        })],
      })

      expect(result.source).toBe('PROFILE')
      expect(result.allocationMode).toBe('FULL_PROJECT')
      expect(result.allocationPercent).toBe(80)
      expect(result.allocationStartWeek).toBeNull()
      expect(result.allocationEndWeek).toBeNull()
    })
  })

  describe('multi-segment projection', () => {
    it('segmented AVAILABILITY_WINDOW projects deterministically with lossy=true', () => {
      const result = resolveRoleDefaultForMutation({
        resourceType: resourceType({ allocationMode: 'TIMELINE', allocationPercent: 100 }),
        roleProfiles: [profile({
          planningBasis: 'AVAILABILITY_WINDOW',
          defaultPercent: 75,
          startWeek: 2,
          endWeek: 10,
          segments: [
            { startWeek: 2, endWeek: 5, capacityPercent: 100 },
            { startWeek: 6, endWeek: 10, capacityPercent: 50 },
          ],
        })],
      })

      expect(result.source).toBe('PROFILE')
      expect(result.lossy).toBe(true)
      // Duration-weighted: (4×100 + 5×50)/9 ≈ 72%
      expect(result.allocationPercent).toBeCloseTo(72.22, 0)
      expect(result.allocationMode).toBe('TIMELINE')
      expect(result.allocationStartWeek).toBe(2)
      expect(result.allocationEndWeek).toBe(10)
    })
  })
  describe('duplicate identical role profiles', () => {
    it('semantically identical duplicates resolve deterministically', () => {
      const result = resolveRoleDefaultForMutation({
        resourceType: resourceType({ allocationMode: 'TIMELINE', allocationPercent: 100 }),
        roleProfiles: [
          profile({ planningBasis: 'DEMAND_FOLLOWING', defaultPercent: 70 }),
          profile({ planningBasis: 'DEMAND_FOLLOWING', defaultPercent: 70 }),
        ],
      })

      expect(result.source).toBe('PROFILE')
      expect(result.allocationMode).toBe('EFFORT')
      expect(result.allocationPercent).toBe(70)
    })
  })

  describe('duplicate conflicting role profiles', () => {
    it('conflicting duplicates throw', () => {
      expect(() => resolveRoleDefaultForMutation({
        resourceType: resourceType({ allocationMode: 'TIMELINE', allocationPercent: 100 }),
        roleProfiles: [
          profile({ planningBasis: 'DEMAND_FOLLOWING', defaultPercent: 70 }),
          profile({ planningBasis: 'AVAILABILITY_WINDOW', defaultPercent: 100, startWeek: 1, endWeek: 10 }),
        ],
      })).toThrow('Conflicting role-owned CapacityProfiles found')
    })
  })
})
