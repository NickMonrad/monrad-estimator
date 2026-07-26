/**
 * capacityProfileReplaceValidator.test.ts — Unit tests for the
 * ReplaceCapacityProfileRequest validator.
 *
 * Covers all structural and semantic validation rules for the
 * capacity-profile PUT endpoint (issue #363).
 *
 * Rules under test:
 *  - All 4 planningBasis types accepted
 *  - Planning-basis-specific segment/window constraints
 *  - NAMED_PERSON percent capped at 100; ROLE may exceed
 *  - Week bounds: non-negative, startWeek ≤ endWeek
 *  - Segment overlap and duplicate detection
 *  - Gaps between segments accepted
 *  - Non-finite values rejected
 */
import { describe, expect, it } from 'vitest'
import {
  validateReplaceCapacityProfileRequest,
} from '../lib/capacityProfileReplaceValidator.js'

// ─── Helpers ─────────────────────────────────────────────────────────────────

function validDemandFollowing(overrides: Record<string, unknown> = {}) {
  return {
    planningBasis: 'DEMAND_FOLLOWING',
    defaultPercent: 100,
    ...overrides,
  }
}

function validAvailabilityWindow(overrides: Record<string, unknown> = {}) {
  return {
    planningBasis: 'AVAILABILITY_WINDOW',
    defaultPercent: 75,
    startWeek: 2,
    endWeek: 10,
    ...overrides,
  }
}

function validWholeProjectAllocation(overrides: Record<string, unknown> = {}) {
  return {
    planningBasis: 'WHOLE_PROJECT_ALLOCATION',
    defaultPercent: 100,
    ...overrides,
  }
}

function validCapacityProfile(overrides: Record<string, unknown> = {}) {
  return {
    planningBasis: 'CAPACITY_PROFILE',
    defaultPercent: null,
    startWeek: null,
    endWeek: null,
    segments: [
      { startWeek: 0, endWeek: 4, capacityPercent: 100 },
      { startWeek: 5, endWeek: 8, capacityPercent: 50 },
    ],
    ...overrides,
  }
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('validateReplaceCapacityProfileRequest', () => {
  // ── All 4 planningBasis types accepted ──────────────────────────────────
  it('accepts DEMAND_FOLLOWING for ROLE', () => {
    const errors = validateReplaceCapacityProfileRequest(
      validDemandFollowing(),
      'ROLE',
    )
    expect(errors).toEqual([])
  })

  it('accepts DEMAND_FOLLOWING for NAMED_PERSON', () => {
    const errors = validateReplaceCapacityProfileRequest(
      validDemandFollowing(),
      'NAMED_PERSON',
    )
    expect(errors).toEqual([])
  })

  it('accepts AVAILABILITY_WINDOW for ROLE', () => {
    const errors = validateReplaceCapacityProfileRequest(
      validAvailabilityWindow(),
      'ROLE',
    )
    expect(errors).toEqual([])
  })

  it('accepts AVAILABILITY_WINDOW for NAMED_PERSON', () => {
    const errors = validateReplaceCapacityProfileRequest(
      validAvailabilityWindow(),
      'NAMED_PERSON',
    )
    expect(errors).toEqual([])
  })

  it('accepts WHOLE_PROJECT_ALLOCATION for ROLE', () => {
    const errors = validateReplaceCapacityProfileRequest(
      validWholeProjectAllocation(),
      'ROLE',
    )
    expect(errors).toEqual([])
  })

  it('accepts WHOLE_PROJECT_ALLOCATION for NAMED_PERSON', () => {
    const errors = validateReplaceCapacityProfileRequest(
      validWholeProjectAllocation(),
      'NAMED_PERSON',
    )
    expect(errors).toEqual([])
  })

  it('accepts CAPACITY_PROFILE with segments for ROLE', () => {
    const errors = validateReplaceCapacityProfileRequest(
      validCapacityProfile(),
      'ROLE',
    )
    expect(errors).toEqual([])
  })

  it('accepts CAPACITY_PROFILE with segments for NAMED_PERSON', () => {
    const errors = validateReplaceCapacityProfileRequest(
      validCapacityProfile(),
      'NAMED_PERSON',
    )
    expect(errors).toEqual([])
  })

  // ── Planning-basis-specific segment constraints ─────────────────────────

  it('rejects DEMAND_FOLLOWING with segments', () => {
    const errors = validateReplaceCapacityProfileRequest(
      validDemandFollowing({ segments: [{ startWeek: 0, endWeek: 4, capacityPercent: 100 }] }),
      'ROLE',
    )
    expect(errors.length).toBeGreaterThan(0)
    expect(errors[0]).toMatch(/DEMAND_FOLLOWING.*must not have segments/i)
  })

  it('rejects DEMAND_FOLLOWING with startWeek', () => {
    const errors = validateReplaceCapacityProfileRequest(
      validDemandFollowing({ startWeek: 0 }),
      'ROLE',
    )
    expect(errors.length).toBeGreaterThan(0)
    expect(errors.some(e => /DEMAND_FOLLOWING.*must not have startWeek/i.test(e))).toBe(true)
  })

  it('rejects DEMAND_FOLLOWING with endWeek', () => {
    const errors = validateReplaceCapacityProfileRequest(
      validDemandFollowing({ endWeek: 10 }),
      'ROLE',
    )
    expect(errors.length).toBeGreaterThan(0)
    expect(errors.some(e => /DEMAND_FOLLOWING.*must not have endWeek/i.test(e))).toBe(true)
  })

  it('rejects WHOLE_PROJECT_ALLOCATION with segments', () => {
    const errors = validateReplaceCapacityProfileRequest(
      validWholeProjectAllocation({ segments: [{ startWeek: 0, endWeek: 4, capacityPercent: 100 }] }),
      'ROLE',
    )
    expect(errors.length).toBeGreaterThan(0)
    expect(errors[0]).toMatch(/WHOLE_PROJECT_ALLOCATION.*must not have segments/i)
  })

  it('rejects WHOLE_PROJECT_ALLOCATION with startWeek', () => {
    const errors = validateReplaceCapacityProfileRequest(
      validWholeProjectAllocation({ startWeek: 0 }),
      'ROLE',
    )
    expect(errors.length).toBeGreaterThan(0)
    expect(errors.some(e => /WHOLE_PROJECT_ALLOCATION.*must not have startWeek/i.test(e))).toBe(true)
  })

  it('rejects WHOLE_PROJECT_ALLOCATION with endWeek', () => {
    const errors = validateReplaceCapacityProfileRequest(
      validWholeProjectAllocation({ endWeek: 10 }),
      'ROLE',
    )
    expect(errors.length).toBeGreaterThan(0)
    expect(errors.some(e => /WHOLE_PROJECT_ALLOCATION.*must not have endWeek/i.test(e))).toBe(true)
  })

  it('rejects AVAILABILITY_WINDOW with segments', () => {
    const errors = validateReplaceCapacityProfileRequest(
      validAvailabilityWindow({ segments: [{ startWeek: 0, endWeek: 4, capacityPercent: 100 }] }),
      'ROLE',
    )
    expect(errors.length).toBeGreaterThan(0)
    expect(errors[0]).toMatch(/AVAILABILITY_WINDOW.*must not have segments/i)
  })

  it.each([
    ['DEMAND_FOLLOWING', 'invalid'],
    ['WHOLE_PROJECT_ALLOCATION', { startWeek: 0 }],
    ['AVAILABILITY_WINDOW', 42],
  ])('rejects malformed scalar segments for %s', (planningBasis, segments) => {
    const errors = validateReplaceCapacityProfileRequest({
      planningBasis,
      defaultPercent: 75,
      startWeek: planningBasis === 'AVAILABILITY_WINDOW' ? 0 : null,
      endWeek: planningBasis === 'AVAILABILITY_WINDOW' ? 2 : null,
      segments,
    }, 'ROLE')
    expect(errors.some(error => error.includes('must not have segments'))).toBe(true)
  })

  it.each([
    ['omitted', undefined],
    ['null', null],
    ['empty array', []],
  ])('accepts %s scalar segments', (_label, segments) => {
    const body: Record<string, unknown> = validDemandFollowing()
    if (segments !== undefined) body.segments = segments
    expect(validateReplaceCapacityProfileRequest(body, 'ROLE')).toEqual([])
  })

  it('accepts AVAILABILITY_WINDOW with startWeek and endWeek', () => {
    const errors = validateReplaceCapacityProfileRequest(
      validAvailabilityWindow({ startWeek: 2, endWeek: 10 }),
      'ROLE',
    )
    expect(errors).toEqual([])
  })

  it('rejects CAPACITY_PROFILE without segments (empty array)', () => {
    const errors = validateReplaceCapacityProfileRequest(
      { planningBasis: 'CAPACITY_PROFILE', segments: [] },
      'ROLE',
    )
    expect(errors.length).toBeGreaterThan(0)
    expect(errors[0]).toMatch(/CAPACITY_PROFILE.*must have at least one segment/i)
  })

  it('rejects CAPACITY_PROFILE without segments (undefined)', () => {
    const errors = validateReplaceCapacityProfileRequest(
      { planningBasis: 'CAPACITY_PROFILE' },
      'ROLE',
    )
    expect(errors.length).toBeGreaterThan(0)
    expect(errors[0]).toMatch(/CAPACITY_PROFILE.*must have at least one segment/i)
  })

  it('rejects CAPACITY_PROFILE with startWeek', () => {
    const errors = validateReplaceCapacityProfileRequest(
      { planningBasis: 'CAPACITY_PROFILE', startWeek: 0, segments: [{ startWeek: 0, endWeek: 4, capacityPercent: 100 }] },
      'ROLE',
    )
    expect(errors.some(e => /CAPACITY_PROFILE.*must not have startWeek/i.test(e))).toBe(true)
  })

  it('rejects CAPACITY_PROFILE with endWeek', () => {
    const errors = validateReplaceCapacityProfileRequest(
      { planningBasis: 'CAPACITY_PROFILE', endWeek: 10, segments: [{ startWeek: 0, endWeek: 4, capacityPercent: 100 }] },
      'ROLE',
    )
    expect(errors.some(e => /CAPACITY_PROFILE.*must not have endWeek/i.test(e))).toBe(true)
  })

  // ── Percent bounds: NAMED_PERSON ≤ 100, ROLE unlimited ─────────────────

  describe('defaultPercent bounds', () => {
    it('accepts ROLE defaultPercent > 100', () => {
      const errors = validateReplaceCapacityProfileRequest(
        validDemandFollowing({ defaultPercent: 200 }),
        'ROLE',
      )
      expect(errors).toEqual([])
    })

    it('rejects NAMED_PERSON defaultPercent > 100', () => {
      const errors = validateReplaceCapacityProfileRequest(
        validDemandFollowing({ defaultPercent: 150 }),
        'NAMED_PERSON',
      )
      expect(errors.length).toBeGreaterThan(0)
      expect(errors[0]).toMatch(/defaultPercent.*must be in range.*NAMED_PERSON/i)
    })

    it('accepts NAMED_PERSON defaultPercent === 100', () => {
      const errors = validateReplaceCapacityProfileRequest(
        validDemandFollowing({ defaultPercent: 100 }),
        'NAMED_PERSON',
      )
      expect(errors).toEqual([])
    })

    it('accepts NAMED_PERSON defaultPercent === 0', () => {
      const errors = validateReplaceCapacityProfileRequest(
        validDemandFollowing({ defaultPercent: 0 }),
        'NAMED_PERSON',
      )
      expect(errors).toEqual([])
    })

    it('accepts null defaultPercent', () => {
      const errors = validateReplaceCapacityProfileRequest(
        validDemandFollowing({ defaultPercent: null }),
        'NAMED_PERSON',
      )
      expect(errors).toEqual([])
    })
  })

  // ── Negative weeks rejected ─────────────────────────────────────────────

  it('rejects negative startWeek', () => {
    const errors = validateReplaceCapacityProfileRequest(
      validAvailabilityWindow({ startWeek: -1 }),
      'ROLE',
    )
    expect(errors.length).toBeGreaterThan(0)
    expect(errors[0]).toMatch(/startWeek.*must be a non-negative integer/i)
  })

  it('rejects negative endWeek', () => {
    const errors = validateReplaceCapacityProfileRequest(
      validAvailabilityWindow({ endWeek: -1 }),
      'ROLE',
    )
    expect(errors.length).toBeGreaterThan(0)
    expect(errors[0]).toMatch(/endWeek.*must be a non-negative integer/i)
  })

  it('rejects negative segment startWeek', () => {
    const errors = validateReplaceCapacityProfileRequest(
      validCapacityProfile({
        segments: [{ startWeek: -1, endWeek: 4, capacityPercent: 100 }],
      }),
      'ROLE',
    )
    expect(errors.length).toBeGreaterThan(0)
    expect(errors.some(e => /startWeek must be a non-negative integer/i.test(e))).toBe(true)
  })

  it('rejects negative segment endWeek', () => {
    const errors = validateReplaceCapacityProfileRequest(
      validCapacityProfile({
        segments: [{ startWeek: 0, endWeek: -1, capacityPercent: 100 }],
      }),
      'ROLE',
    )
    expect(errors.length).toBeGreaterThan(0)
    expect(errors.some(e => /endWeek must be a non-negative integer/i.test(e))).toBe(true)
  })

  // ── startWeek > endWeek rejected (profile level) ────────────────────────

  it('rejects startWeek > endWeek at profile level', () => {
    const errors = validateReplaceCapacityProfileRequest(
      validAvailabilityWindow({ startWeek: 10, endWeek: 5 }),
      'ROLE',
    )
    expect(errors.length).toBeGreaterThan(0)
    expect(errors[0]).toMatch(/startWeek must not exceed endWeek/i)
  })

  it('rejects segment startWeek > endWeek', () => {
    const errors = validateReplaceCapacityProfileRequest(
      validCapacityProfile({
        segments: [{ startWeek: 8, endWeek: 3, capacityPercent: 100 }],
      }),
      'ROLE',
    )
    expect(errors.length).toBeGreaterThan(0)
    expect(errors.some(e => /startWeek must not exceed endWeek/i.test(e))).toBe(true)
  })

  // ── Overlapping segments rejected ───────────────────────────────────────

  it('rejects segments that share a boundary week (inclusive overlap)', () => {
    const errors = validateReplaceCapacityProfileRequest(
      {
        planningBasis: 'CAPACITY_PROFILE',
        segments: [
          { startWeek: 0, endWeek: 5, capacityPercent: 100 },
          { startWeek: 5, endWeek: 10, capacityPercent: 100 },
        ],
      },
      'ROLE',
    )
    expect(errors.length).toBeGreaterThan(0)
    expect(errors.some(e => /overlaps/i.test(e))).toBe(true)
  })

  it('rejects segments with interior overlap', () => {
    const errors = validateReplaceCapacityProfileRequest(
      {
        planningBasis: 'CAPACITY_PROFILE',
        segments: [
          { startWeek: 0, endWeek: 8, capacityPercent: 100 },
          { startWeek: 4, endWeek: 12, capacityPercent: 100 },
        ],
      },
      'ROLE',
    )
    expect(errors.length).toBeGreaterThan(0)
    expect(errors.some(e => /overlaps/i.test(e))).toBe(true)
  })

  it('rejects a segment nested inside a wider segment', () => {
    const errors = validateReplaceCapacityProfileRequest(
      {
        planningBasis: 'CAPACITY_PROFILE',
        segments: [
          { startWeek: 0, endWeek: 20, capacityPercent: 100 },
          { startWeek: 4, endWeek: 6, capacityPercent: 50 },
        ],
      },
      'ROLE',
    )
    expect(errors.length).toBeGreaterThan(0)
    expect(errors.some(e => /overlaps/i.test(e))).toBe(true)
  })

  // ── Duplicate ranges rejected ───────────────────────────────────────────

  it('rejects duplicate segments with same week range', () => {
    const errors = validateReplaceCapacityProfileRequest(
      {
        planningBasis: 'CAPACITY_PROFILE',
        segments: [
          { startWeek: 0, endWeek: 5, capacityPercent: 100 },
          { startWeek: 0, endWeek: 5, capacityPercent: 100 },
        ],
      },
      'ROLE',
    )
    expect(errors.length).toBeGreaterThan(0)
    expect(errors.some(e => /duplicate segment/i.test(e))).toBe(true)
  })

  it('rejects segments with same week range but different percent (still duplicate range)', () => {
    const errors = validateReplaceCapacityProfileRequest(
      {
        planningBasis: 'CAPACITY_PROFILE',
        segments: [
          { startWeek: 0, endWeek: 5, capacityPercent: 100 },
          { startWeek: 0, endWeek: 5, capacityPercent: 50 },
        ],
      },
      'ROLE',
    )
    expect(errors.length).toBeGreaterThan(0)
    expect(errors.some(e => /duplicate segment/i.test(e))).toBe(true)
  })

  // ── Gaps accepted ───────────────────────────────────────────────────────

  it('accepts segments with a gap between them', () => {
    const errors = validateReplaceCapacityProfileRequest(
      {
        planningBasis: 'CAPACITY_PROFILE',
        segments: [
          { startWeek: 0, endWeek: 4, capacityPercent: 100 },
          { startWeek: 6, endWeek: 10, capacityPercent: 50 },
        ],
      },
      'ROLE',
    )
    expect(errors).toEqual([])
  })

  it('accepts non-overlapping segments with a one-week boundary gap', () => {
    // Inclusive ranges [0,3] and [4,8] do not share a claimed week.
    const errors = validateReplaceCapacityProfileRequest(
      {
        planningBasis: 'CAPACITY_PROFILE',
        segments: [
          { startWeek: 0, endWeek: 3, capacityPercent: 100 },
          { startWeek: 4, endWeek: 8, capacityPercent: 50 },
        ],
      },
      'ROLE',
    )
    expect(errors).toEqual([])
  })

  // ── Single segment is valid ─────────────────────────────────────────────

  it('accepts CAPACITY_PROFILE with exactly one segment', () => {
    const errors = validateReplaceCapacityProfileRequest(
      {
        planningBasis: 'CAPACITY_PROFILE',
        segments: [
          { startWeek: 2, endWeek: 6, capacityPercent: 80 },
        ],
      },
      'ROLE',
    )
    expect(errors).toEqual([])
  })

  // ── Non-finite values rejected ──────────────────────────────────────────

  it('rejects NaN defaultPercent', () => {
    const errors = validateReplaceCapacityProfileRequest(
      validDemandFollowing({ defaultPercent: NaN }),
      'ROLE',
    )
    expect(errors.length).toBeGreaterThan(0)
    expect(errors[0]).toMatch(/defaultPercent.*finite/i)
  })

  it('rejects Infinity defaultPercent', () => {
    const errors = validateReplaceCapacityProfileRequest(
      validDemandFollowing({ defaultPercent: Infinity }),
      'ROLE',
    )
    expect(errors.length).toBeGreaterThan(0)
    expect(errors[0]).toMatch(/defaultPercent.*finite/i)
  })

  it('rejects NaN segment capacityPercent', () => {
    const errors = validateReplaceCapacityProfileRequest(
      validCapacityProfile({
        segments: [{ startWeek: 0, endWeek: 4, capacityPercent: NaN }],
      }),
      'ROLE',
    )
    expect(errors.length).toBeGreaterThan(0)
    expect(errors.some(e => /capacityPercent.*finite/i.test(e))).toBe(true)
  })

  it('rejects Infinity segment capacityPercent', () => {
    const errors = validateReplaceCapacityProfileRequest(
      validCapacityProfile({
        segments: [{ startWeek: 0, endWeek: 4, capacityPercent: Infinity }],
      }),
      'ROLE',
    )
    expect(errors.length).toBeGreaterThan(0)
    expect(errors.some(e => /capacityPercent.*finite/i.test(e))).toBe(true)
  })

  it('rejects NaN startWeek', () => {
    const errors = validateReplaceCapacityProfileRequest(
      validDemandFollowing({ startWeek: NaN }),
      'ROLE',
    )
    expect(errors.length).toBeGreaterThan(0)
    expect(errors.some(e => /startWeek.*non-negative integer/i.test(e))).toBe(true)
  })

  it('accepts non-integer defaultPercent', () => {
    const errors = validateReplaceCapacityProfileRequest(
      validDemandFollowing({ defaultPercent: 99.5 }),
      'ROLE',
    )
    expect(errors).toHaveLength(0)
  })

  it('rejects negative defaultPercent', () => {
    const errors = validateReplaceCapacityProfileRequest(
      validDemandFollowing({ defaultPercent: -10 }),
      'ROLE',
    )
    expect(errors.length).toBeGreaterThan(0)
    expect(errors[0]).toMatch(/defaultPercent.*finite non-negative/i)
  })

  // ── Invalid object shape ─────────────────────────────────────────────────

  it('rejects null body', () => {
    const errors = validateReplaceCapacityProfileRequest(null, 'ROLE')
    expect(errors[0]).toMatch(/must be a JSON object/i)
  })

  it('rejects non-object body', () => {
    const errors = validateReplaceCapacityProfileRequest('not-an-object', 'ROLE')
    expect(errors[0]).toMatch(/must be a JSON object/i)
  })

  it('rejects invalid planningBasis', () => {
    const errors = validateReplaceCapacityProfileRequest(
      { planningBasis: 'INVALID' },
      'ROLE',
    )
    expect(errors[0]).toMatch(/planningBasis must be one of/i)
  })

  // ── Segment-level object validation ──────────────────────────────────────

  it('rejects segment that is not an object', () => {
    const errors = validateReplaceCapacityProfileRequest(
      {
        planningBasis: 'CAPACITY_PROFILE',
        segments: ['not-an-object'],
      },
      'ROLE',
    )
    expect(errors.some(e => /Segment 1 must be an object/i.test(e))).toBe(true)
  })

  it('rejects segment with missing capacityPercent', () => {
    const errors = validateReplaceCapacityProfileRequest(
      {
        planningBasis: 'CAPACITY_PROFILE',
        segments: [{ startWeek: 0, endWeek: 4 }],
      },
      'ROLE',
    )
    expect(errors.some(e => /capacityPercent.*finite/i.test(e))).toBe(true)
  })

  it('rejects segment with missing startWeek', () => {
    const errors = validateReplaceCapacityProfileRequest(
      {
        planningBasis: 'CAPACITY_PROFILE',
        segments: [{ endWeek: 4, capacityPercent: 100 }],
      },
      'ROLE',
    )
    expect(errors.some(e => /startWeek must be a non-negative integer/i.test(e))).toBe(true)
  })

  it('rejects segment with missing endWeek', () => {
    const errors = validateReplaceCapacityProfileRequest(
      {
        planningBasis: 'CAPACITY_PROFILE',
        segments: [{ startWeek: 0, capacityPercent: 100 }],
      },
      'ROLE',
    )
    expect(errors.some(e => /endWeek must be a non-negative integer/i.test(e))).toBe(true)
  })
})
