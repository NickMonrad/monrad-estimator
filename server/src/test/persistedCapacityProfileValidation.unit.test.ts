/**
 * persistedCapacityProfileValidation.unit.test.ts — Focused unit tests for the
 * structural CapacityProfile/CapacitySegment validator.
 *
 * Tests the invariants that changed in the profile-first remediation
 * (PR #374 / issue #359): physical-owner duplicate detection, owner-aware
 * percentage bounds, integer/enumeration week checks, inclusive boundary
 * overlap rejection, and exact duplicate segment detection.
 */
import { describe, expect, it } from 'vitest'
import {
  validatePersistedCapacityProfiles,
  type ValidationContext,
} from '../lib/persistedCapacityProfileValidation.js'

// ─── Shared helpers ─────────────────────────────────────────────────────────

const defaultCtx: ValidationContext = {
  projectId: 'proj-1',
  resourceTypeIds: new Set(['rt-1', 'rt-2']),
  namedResourceIds: new Set(['nr-1', 'nr-2']),
}

function profile(overrides: Record<string, unknown> = {}) {
  return {
    id: 'p-1',
    projectId: 'proj-1',
    resourceTypeId: 'rt-1',
    namedResourceId: null,
    ownerKind: 'ROLE',
    // Segmented fixtures use CAPACITY_PROFILE: the authoritative rules
    // require segments on CAPACITY_PROFILE and forbid them on the scalar
    // bases (DEMAND_FOLLOWING / WHOLE_PROJECT_ALLOCATION / AVAILABILITY_WINDOW).
    planningBasis: 'CAPACITY_PROFILE',
    source: 'SQUAD_PLANNER',
    defaultPercent: null,
    startWeek: null,
    endWeek: null,
    segments: [{
      id: 'seg-1',
      startWeek: 0,
      endWeek: 8,
      capacityPercent: 100,
      source: 'SQUAD_PLANNER',
    }],
    ...overrides,
  }
}

function segment(overrides: Record<string, unknown> = {}) {
  return {
    id: 'seg-1',
    startWeek: 0,
    endWeek: 8,
    capacityPercent: 100,
    source: 'SQUAD_PLANNER',
    ...overrides,
  }
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('validatePersistedCapacityProfiles', () => {
  // ── Happy path: valid multi-owner set ──────────────────────────────────
  it('passes a valid multi-owner set', () => {
    const result = validatePersistedCapacityProfiles(
      [
        profile({ id: 'p-1', resourceTypeId: 'rt-1', ownerKind: 'ROLE' }),
        profile({
          id: 'p-2',
          resourceTypeId: null,
          namedResourceId: 'nr-1',
          ownerKind: 'NAMED_PERSON',
        }),
        profile({
          id: 'p-3',
          resourceTypeId: null,
          namedResourceId: 'nr-2',
          ownerKind: 'PLANNED_RESOURCE',
        }),
      ],
      defaultCtx,
    )
    expect(result).toEqual({ valid: true, errors: [] })
  })

  // ── ROLE >100% valid ──────────────────────────────────────────────────
  describe('owner-aware defaultPercent', () => {
    it('allows ROLE defaultPercent >100', () => {
      const result = validatePersistedCapacityProfiles(
        [profile({ id: 'p-1', defaultPercent: 150 })],
        defaultCtx,
      )
      expect(result.valid).toBe(true)
      expect(result.errors).toEqual([])
    })

    it('rejects NAMED_PERSON defaultPercent >100', () => {
      const result = validatePersistedCapacityProfiles(
        [
          profile({
            id: 'p-1',
            resourceTypeId: null,
            namedResourceId: 'nr-1',
            ownerKind: 'NAMED_PERSON',
            defaultPercent: 110,
          }),
        ],
        defaultCtx,
      )
      expect(result.valid).toBe(false)
      expect(result.errors[0]).toMatch(/defaultPercent 110.*range.*NAMED_PERSON/)
    })

    it('rejects PLANNED_RESOURCE defaultPercent >100', () => {
      const result = validatePersistedCapacityProfiles(
        [
          profile({
            id: 'p-1',
            resourceTypeId: null,
            namedResourceId: 'nr-1',
            ownerKind: 'PLANNED_RESOURCE',
            defaultPercent: 200,
          }),
        ],
        defaultCtx,
      )
      expect(result.valid).toBe(false)
      expect(result.errors[0]).toMatch(/defaultPercent 200.*range.*PLANNED_RESOURCE/)
    })

    it('rejects negative defaultPercent for any owner kind', () => {
      const result = validatePersistedCapacityProfiles(
        [profile({ id: 'p-1', defaultPercent: -10 })],
        defaultCtx,
      )
      expect(result.valid).toBe(false)
      expect(result.errors[0]).toMatch(/defaultPercent -10.*non-negative/)
    })
  })

  // ── Owner-aware segment capacityPercent ────────────────────────────────
  describe('owner-aware segment capacityPercent', () => {
    it('allows ROLE segment capacityPercent >100', () => {
      const result = validatePersistedCapacityProfiles(
        [profile({ id: 'p-1', segments: [segment({ capacityPercent: 200 })] })],
        defaultCtx,
      )
      expect(result.valid).toBe(true)
      expect(result.errors).toEqual([])
    })

    it('rejects NAMED_PERSON segment capacityPercent >100', () => {
      const result = validatePersistedCapacityProfiles(
        [
          profile({
            id: 'p-1',
            resourceTypeId: null,
            namedResourceId: 'nr-1',
            ownerKind: 'NAMED_PERSON',
            segments: [segment({ capacityPercent: 120 })],
          }),
        ],
        defaultCtx,
      )
      expect(result.valid).toBe(false)
      expect(result.errors[0]).toMatch(/capacityPercent 120.*range.*NAMED_PERSON/)
    })

    it('rejects PLANNED_RESOURCE segment capacityPercent >100', () => {
      const result = validatePersistedCapacityProfiles(
        [
          profile({
            id: 'p-1',
            resourceTypeId: null,
            namedResourceId: 'nr-1',
            ownerKind: 'PLANNED_RESOURCE',
            segments: [segment({ capacityPercent: 101 })],
          }),
        ],
        defaultCtx,
      )
      expect(result.valid).toBe(false)
      expect(result.errors[0]).toMatch(/capacityPercent 101.*range.*PLANNED_RESOURCE/)
    })
  })

  // ── Physical-owner duplicate detection ─────────────────────────────────
  describe('physical-owner duplicate detection', () => {
    it('rejects NAMED_PERSON + PLANNED_RESOURCE sharing one namedResourceId', () => {
      const result = validatePersistedCapacityProfiles(
        [
          profile({
            id: 'p-1',
            resourceTypeId: null,
            namedResourceId: 'nr-1',
            ownerKind: 'NAMED_PERSON',
          }),
          profile({
            id: 'p-2',
            resourceTypeId: null,
            namedResourceId: 'nr-1',
            ownerKind: 'PLANNED_RESOURCE',
          }),
        ],
        defaultCtx,
      )
      expect(result.valid).toBe(false)
      expect(result.errors.length).toBeGreaterThanOrEqual(1)
      expect(result.errors[0]).toMatch(/duplicate physical owner/)
      expect(result.errors[0]).toMatch(/namedResourceId::nr-1/)
    })

    it('rejects duplicate ROLE (same resourceTypeId)', () => {
      const result = validatePersistedCapacityProfiles(
        [
          profile({ id: 'p-1', resourceTypeId: 'rt-1' }),
          profile({ id: 'p-2', resourceTypeId: 'rt-1' }),
        ],
        defaultCtx,
      )
      expect(result.valid).toBe(false)
      expect(result.errors[0]).toMatch(/duplicate physical owner/)
      expect(result.errors[0]).toMatch(/resourceTypeId::rt-1/)
    })

    it('allows ROLE and NAMED_PERSON with different FK namespaces even if IDs look alike', () => {
      // resourceTypeId "rt-1" and namedResourceId "nr-1" are different namespaces
      const result = validatePersistedCapacityProfiles(
        [
          profile({ id: 'p-1', resourceTypeId: 'rt-1', ownerKind: 'ROLE' }),
          profile({
            id: 'p-2',
            resourceTypeId: null,
            namedResourceId: 'nr-1',
            ownerKind: 'NAMED_PERSON',
          }),
        ],
        defaultCtx,
      )
      expect(result.valid).toBe(true)
      expect(result.errors).toEqual([])
    })
  })

  // ── Week boundary validation ───────────────────────────────────────────
  describe('week boundary validation', () => {
    it('rejects non-integer segment startWeek', () => {
      const result = validatePersistedCapacityProfiles(
        [profile({ id: 'p-1', segments: [segment({ startWeek: 1.5 })] })],
        defaultCtx,
      )
      expect(result.valid).toBe(false)
      expect(result.errors[0]).toMatch(/invalid week range/)
    })

    it('rejects non-integer segment endWeek', () => {
      const result = validatePersistedCapacityProfiles(
        [profile({ id: 'p-1', segments: [segment({ endWeek: 7.9 })] })],
        defaultCtx,
      )
      expect(result.valid).toBe(false)
      expect(result.errors[0]).toMatch(/invalid week range/)
    })

    it('rejects negative segment startWeek', () => {
      const result = validatePersistedCapacityProfiles(
        [profile({ id: 'p-1', segments: [segment({ startWeek: -1 })] })],
        defaultCtx,
      )
      expect(result.valid).toBe(false)
      expect(result.errors[0]).toMatch(/invalid week range/)
    })

    it('rejects segment with startWeek > endWeek', () => {
      const result = validatePersistedCapacityProfiles(
        [profile({ id: 'p-1', segments: [segment({ startWeek: 10, endWeek: 5 })] })],
        defaultCtx,
      )
      expect(result.valid).toBe(false)
      expect(result.errors[0]).toMatch(/invalid week range/)
    })

    it('rejects non-integer profile startWeek', () => {
      const result = validatePersistedCapacityProfiles(
        [profile({ id: 'p-1', startWeek: 2.5 })],
        defaultCtx,
      )
      expect(result.valid).toBe(false)
      expect(result.errors[0]).toMatch(/non-negative finite integer/)
    })

    it('rejects non-integer profile endWeek', () => {
      const result = validatePersistedCapacityProfiles(
        [profile({ id: 'p-1', endWeek: 12.1 })],
        defaultCtx,
      )
      expect(result.valid).toBe(false)
      expect(result.errors[0]).toMatch(/non-negative finite integer/)
    })

    it('rejects profile startWeek > endWeek', () => {
      const result = validatePersistedCapacityProfiles(
        [profile({ id: 'p-1', startWeek: 8, endWeek: 3 })],
        defaultCtx,
      )
      expect(result.valid).toBe(false)
      expect(result.errors[0]).toMatch(/must not exceed/)
    })
  })

  // ── Inclusive boundary overlap rejection ───────────────────────────────
  describe('inclusive segment overlap rejection', () => {
    it('rejects segments sharing a boundary week (start <= prior end)', () => {
      const result = validatePersistedCapacityProfiles(
        [
          profile({
            id: 'p-1',
            segments: [
              segment({ id: 'seg-a', startWeek: 0, endWeek: 5 }),
              segment({ id: 'seg-b', startWeek: 5, endWeek: 10 }),
            ],
          }),
        ],
        defaultCtx,
      )
      expect(result.valid).toBe(false)
      expect(result.errors[0]).toMatch(/overlaps/)
    })

    it('rejects segments with interior overlap', () => {
      const result = validatePersistedCapacityProfiles(
        [
          profile({
            id: 'p-1',
            segments: [
              segment({ id: 'seg-a', startWeek: 0, endWeek: 8 }),
              segment({ id: 'seg-b', startWeek: 4, endWeek: 12 }),
            ],
          }),
        ],
        defaultCtx,
      )
      expect(result.valid).toBe(false)
      expect(result.errors[0]).toMatch(/overlaps/)
    })

    it('rejects a range nested inside an earlier non-adjacent range', () => {
      const result = validatePersistedCapacityProfiles(
        [
          profile({
            id: 'p-1',
            segments: [
              segment({ id: 'seg-a', startWeek: 0, endWeek: 20 }),
              segment({ id: 'seg-b', startWeek: 4, endWeek: 6 }),
              segment({ id: 'seg-c', startWeek: 7, endWeek: 8 }),
            ],
          }),
        ],
        defaultCtx,
      )
      expect(result.valid).toBe(false)
      expect(result.errors.some(error => error.includes('seg-c'))).toBe(true)
    })

    it('allows segments with a gap between them', () => {
      const result = validatePersistedCapacityProfiles(
        [
          profile({
            id: 'p-1',
            segments: [
              segment({ id: 'seg-a', startWeek: 0, endWeek: 4 }),
              segment({ id: 'seg-b', startWeek: 6, endWeek: 10 }),
            ],
          }),
        ],
        defaultCtx,
      )
      expect(result.valid).toBe(true)
      expect(result.errors).toEqual([])
    })

    it('allows non-overlapping segments with a one-week boundary gap', () => {
      // Inclusive ranges [0,3] and [4,8] do not share a claimed week.
      const result = validatePersistedCapacityProfiles(
        [
          profile({
            id: 'p-1',
            segments: [
              segment({ id: 'seg-a', startWeek: 0, endWeek: 3 }),
              segment({ id: 'seg-b', startWeek: 4, endWeek: 8 }),
            ],
          }),
        ],
        defaultCtx,
      )
      expect(result.valid).toBe(true)
      expect(result.errors).toEqual([])
    })
  })

  // ── Exact duplicate segment detection ──────────────────────────────────
  describe('exact duplicate segment detection', () => {
    it('rejects two segments with same startWeek and endWeek on the same profile', () => {
      const result = validatePersistedCapacityProfiles(
        [
          profile({
            id: 'p-1',
            segments: [
              segment({ id: 'seg-a', startWeek: 0, endWeek: 5 }),
              segment({ id: 'seg-b', startWeek: 0, endWeek: 5 }),
            ],
          }),
        ],
        defaultCtx,
      )
      expect(result.valid).toBe(false)
      expect(result.errors[0]).toMatch(/duplicate segment/)
      expect(result.errors[0]).toMatch(/seg-b/)
    })
  })

  // ── Existing invariant preservation ────────────────────────────────────
  describe('preserves existing invariants', () => {
    it('rejects invalid ownerKind', () => {
      const result = validatePersistedCapacityProfiles(
        [profile({ id: 'p-1', ownerKind: 'ALIEN' })],
        defaultCtx,
      )
      expect(result.valid).toBe(false)
      expect(result.errors[0]).toMatch(/invalid ownerKind/)
    })

    it('rejects invalid source', () => {
      const result = validatePersistedCapacityProfiles(
        [profile({ id: 'p-1', source: 'NONEXISTENT' })],
        defaultCtx,
      )
      expect(result.valid).toBe(false)
      expect(result.errors[0]).toMatch(/invalid source/)
    })

    it('rejects mismatch projectId', () => {
      const result = validatePersistedCapacityProfiles(
        [profile({ id: 'p-1', projectId: 'other-proj' })],
        defaultCtx,
      )
      expect(result.valid).toBe(false)
      expect(result.errors[0]).toMatch(/projectId/)
    })

    it('rejects orphan resourceTypeId', () => {
      const result = validatePersistedCapacityProfiles(
        [profile({ id: 'p-1', resourceTypeId: 'rt-missing' })],
        defaultCtx,
      )
      expect(result.valid).toBe(false)
      expect(result.errors[0]).toMatch(/not found in project/)
    })


    it('rejects invalid segment source', () => {
      const result = validatePersistedCapacityProfiles(
        [
          profile({
            id: 'p-1',
            segments: [segment({ source: 'BOGUS' })],
          }),
        ],
        defaultCtx,
      )
      expect(result.valid).toBe(false)
      expect(result.errors[0]).toMatch(/invalid source/)
    })
    it('rejects orphan namedResourceId', () => {
      const result = validatePersistedCapacityProfiles(
        [
          profile({
            id: 'p-1',
            resourceTypeId: null,
            namedResourceId: 'nr-missing',
            ownerKind: 'NAMED_PERSON',
          }),
        ],
        defaultCtx,
      )
      expect(result.valid).toBe(false)
      expect(result.errors[0]).toMatch(/not found in project/)
    })
  })
})
