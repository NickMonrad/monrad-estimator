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
import { resolveRoleDefaultForMutation } from '../lib/resolveRoleDefaultForMutation.js'
import { CapacityIntegrityError } from '../lib/capacityIntegrityError.js'
import type { RoleProfileLike } from '../lib/resolveRoleDefaultForMutation.js'

// ─── Fixture factories ────────────────────────────────────────────────────────

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

  describe('missing profile fails closed', () => {
    it('no role profile → CapacityIntegrityError (no legacy fallback, issue #418)', () => {
      expect(() => resolveRoleDefaultForMutation({
        roleProfiles: [],
      })).toThrow(CapacityIntegrityError)
    })
  })

  describe('scalar profile precedence', () => {
    it('RT TIMELINE/100, role DEMAND_FOLLOWING/70 → PROFILE EFFORT/70/null/null', () => {
      const result = resolveRoleDefaultForMutation({
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
    })
  })

  describe('availability profile', () => {
    it('role AVAILABILITY_WINDOW/60/W2-W8 → TIMELINE/60/W2-W8', () => {
      const result = resolveRoleDefaultForMutation({
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
        roleProfiles: [
          profile({ planningBasis: 'DEMAND_FOLLOWING', defaultPercent: 70 }),
          profile({ planningBasis: 'AVAILABILITY_WINDOW', defaultPercent: 100, startWeek: 1, endWeek: 10 }),
        ],
      })).toThrow('Conflicting role-owned CapacityProfiles found')
    })
  })
})
