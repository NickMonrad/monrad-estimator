/**
 * capacityProfileMapping.test.ts — Parity tests for read-only mapping helpers.
 *
 * Validates that the mapping preserves current behaviour for all allocation
 * modes, field precedence rules, owner kinds, and capacity plan integration.
 *
 * Pure unit tests — no database required.
 */
import { describe, it, expect } from 'vitest'
import {
  allocationModeToPlanningBasis,
  mapResourceTypeToCapacityProfile,
  mapNamedResourceToCapacityProfile,
  mapProjectToCapacityProfiles,
  resolveNamedResourcePercent,
  resolveNamedResourceStartWeek,
  resolveNamedResourceEndWeek,
} from '../lib/capacityProfileMapping.js'
import type {
  CapacityProfileResourceTypeLike,
  CapacityProfileNamedResourceLike,
  CapacityPlanSlotInput,
} from '../lib/capacityProfileMapping.js'

// ─── Helper: build minimal RT with defaults ─────────────────────────────────
const defaultRt = (
  overrides: Partial<CapacityProfileResourceTypeLike> = {},
): CapacityProfileResourceTypeLike => ({
  id: 'rt-1',
  name: 'Engineer',
  count: 1,
  allocationMode: 'EFFORT',
  allocationPercent: 100,
  allocationStartWeek: null,
  allocationEndWeek: null,
  ...overrides,
})

// ─── Helper: build minimal NR with defaults ─────────────────────────────────
const defaultNr = (
  overrides: Partial<CapacityProfileNamedResourceLike> = {},
): CapacityProfileNamedResourceLike => ({
  id: 'nr-1',
  name: 'Alice',
  startWeek: null,
  endWeek: null,
  allocationPct: 100,
  allocationMode: 'EFFORT',
  allocationPercent: 100,
  allocationStartWeek: null,
  allocationEndWeek: null,
  synthetic: false,
  ...overrides,
})

// ─── allocationModeToPlanningBasis ─────────────────────────────────────────

describe('allocationModeToPlanningBasis', () => {
  it('maps EFFORT to demandFollowing', () => {
    expect(allocationModeToPlanningBasis('EFFORT')).toBe('demandFollowing')
  })

  it('maps TIMELINE to availabilityWindow', () => {
    expect(allocationModeToPlanningBasis('TIMELINE')).toBe('availabilityWindow')
  })

  it('maps FULL_PROJECT to wholeProjectAllocation', () => {
    expect(allocationModeToPlanningBasis('FULL_PROJECT')).toBe('wholeProjectAllocation')
  })

  it('maps CAPACITY_PLAN to capacityProfile', () => {
    expect(allocationModeToPlanningBasis('CAPACITY_PLAN')).toBe('capacityProfile')
  })

  it('falls back to demandFollowing for null/undefined/unknown', () => {
    expect(allocationModeToPlanningBasis(null)).toBe('demandFollowing')
    expect(allocationModeToPlanningBasis(undefined)).toBe('demandFollowing')
    expect(allocationModeToPlanningBasis('OLD_MODE')).toBe('demandFollowing')
  })
})

// ─── resolveNamedResourcePercent (field precedence) ────────────────────────

describe('resolveNamedResourcePercent', () => {
  it('returns allocationPercent when allocationPercent is set', () => {
    const nr = defaultNr({ allocationPercent: 75, allocationPct: 50 })
    expect(resolveNamedResourcePercent(nr)).toBe(75)
  })

  it('falls back to allocationPct when allocationPercent is null', () => {
    const nr = defaultNr({ allocationPercent: null, allocationPct: 60 })
    expect(resolveNamedResourcePercent(nr)).toBe(60)
  })

  it('defaults to 100 when both are null', () => {
    const nr = defaultNr({ allocationPercent: null, allocationPct: null })
    expect(resolveNamedResourcePercent(nr)).toBe(100)
  })

  it('defaults to 100 when both are undefined', () => {
    const nr = defaultNr({ allocationPercent: undefined, allocationPct: undefined })
    expect(resolveNamedResourcePercent(nr)).toBe(100)
  })
})

// ─── resolveNamedResourceStartWeek/EndWeek (field precedence) ──────────────

describe('resolveNamedResourceStartWeek', () => {
  it('returns allocationStartWeek when set', () => {
    const nr = defaultNr({ allocationStartWeek: 3, startWeek: 1 })
    expect(resolveNamedResourceStartWeek(nr)).toBe(3)
  })

  it('falls back to startWeek when allocationStartWeek is null', () => {
    const nr = defaultNr({ allocationStartWeek: null, startWeek: 5 })
    expect(resolveNamedResourceStartWeek(nr)).toBe(5)
  })

  it('returns null when both are null', () => {
    const nr = defaultNr({ allocationStartWeek: null, startWeek: null })
    expect(resolveNamedResourceStartWeek(nr)).toBeNull()
  })
})

describe('resolveNamedResourceEndWeek', () => {
  it('returns allocationEndWeek when set', () => {
    const nr = defaultNr({ allocationEndWeek: 10, endWeek: 8 })
    expect(resolveNamedResourceEndWeek(nr)).toBe(10)
  })

  it('falls back to endWeek when allocationEndWeek is null', () => {
    const nr = defaultNr({ allocationEndWeek: null, endWeek: 12 })
    expect(resolveNamedResourceEndWeek(nr)).toBe(12)
  })

  it('returns null when both are null', () => {
    const nr = defaultNr({ allocationEndWeek: null, endWeek: null })
    expect(resolveNamedResourceEndWeek(nr)).toBeNull()
  })
})

// ─── mapResourceTypeToCapacityProfile ──────────────────────────────────────

describe('mapResourceTypeToCapacityProfile', () => {
  it('maps EFFORT to demandFollowing with defaultPercent=100', () => {
    const rt = defaultRt({ allocationMode: 'EFFORT', allocationPercent: 100 })
    const result = mapResourceTypeToCapacityProfile({ projectId: 'p1', resourceType: rt })

    expect(result.planningBasis).toBe('demandFollowing')
    expect(result.defaultPercent).toBe(100)
    expect(result.source).toBe('fixed')
    expect(result.owner.kind).toBe('role')
    expect(result.owner.id).toBe(rt.id)
    expect(result.owner.name).toBe(rt.name)
  })

  it('maps TIMELINE preserving percent/start/end', () => {
    const rt = defaultRt({
      allocationMode: 'TIMELINE',
      allocationPercent: 75,
      allocationStartWeek: 2,
      allocationEndWeek: 10,
    })
    const result = mapResourceTypeToCapacityProfile({ projectId: 'p1', resourceType: rt })

    expect(result.planningBasis).toBe('availabilityWindow')
    expect(result.defaultPercent).toBe(75)
    expect(result.startWeek).toBe(2)
    expect(result.endWeek).toBe(10)
    expect(result.source).toBe('availabilityWindow')
  })

  it('maps FULL_PROJECT to wholeProjectAllocation', () => {
    const rt = defaultRt({ allocationMode: 'FULL_PROJECT' })
    const result = mapResourceTypeToCapacityProfile({ projectId: 'p1', resourceType: rt })

    expect(result.planningBasis).toBe('wholeProjectAllocation')
    expect(result.source).toBe('fixed')
  })

  it('maps CAPACITY_PLAN to capacityProfile without plan slots → source=legacy', () => {
    const rt = defaultRt({ allocationMode: 'CAPACITY_PLAN' })
    const result = mapResourceTypeToCapacityProfile({ projectId: 'p1', resourceType: rt })

    expect(result.planningBasis).toBe('capacityProfile')
    expect(result.segments).toEqual([])
    expect(result.source).toBe('legacy')
  })

  it('maps CAPACITY_PLAN with slot windows → source=squadPlanner with segments', () => {
    const rt = defaultRt({ allocationMode: 'CAPACITY_PLAN' })
    const slots: CapacityPlanSlotInput[] = [
      { startWeek: 0, endWeek: 3, allocationPercent: 100 },
      { startWeek: 4, endWeek: 9, allocationPercent: 50 },
    ]
    const result = mapResourceTypeToCapacityProfile({
      projectId: 'p1',
      resourceType: rt,
      capacityPlanSlots: slots,
    })

    expect(result.planningBasis).toBe('capacityProfile')
    expect(result.segments).toHaveLength(2)
    expect(result.source).toBe('squadPlanner')
    expect(result.segments[0]).toMatchObject({
      startWeek: 0,
      endWeek: 3,
      capacityPercent: 100,
      source: 'squadPlanner',
    })
    expect(result.segments[1]).toMatchObject({
      startWeek: 4,
      endWeek: 9,
      capacityPercent: 50,
      source: 'squadPlanner',
    })
  })

  it('preserves legacy fields in the legacy snapshot', () => {
    const rt = defaultRt({
      allocationMode: 'TIMELINE',
      allocationPercent: 80,
      allocationStartWeek: 1,
      allocationEndWeek: 8,
    })
    const result = mapResourceTypeToCapacityProfile({ projectId: 'p1', resourceType: rt })

    expect(result.legacy.allocationMode).toBe('TIMELINE')
    expect(result.legacy.allocationPercent).toBe(80)
    expect(result.legacy.allocationStartWeek).toBe(1)
    expect(result.legacy.allocationEndWeek).toBe(8)
    expect(result.legacy.allocationPct).toBeNull()
    expect(result.legacy.startWeek).toBeNull()
    expect(result.legacy.endWeek).toBeNull()
  })

  it('uses null fallback when RT fields are null/missing', () => {
    const rt = defaultRt({
      allocationMode: null,
      allocationPercent: null,
      allocationStartWeek: null,
      allocationEndWeek: null,
    })
    const result = mapResourceTypeToCapacityProfile({ projectId: 'p1', resourceType: rt })

    expect(result.planningBasis).toBe('demandFollowing')
    expect(result.defaultPercent).toBeNull()
    expect(result.startWeek).toBeNull()
    expect(result.endWeek).toBeNull()
    expect(result.source).toBe('legacy')
  })
})

// ─── mapNamedResourceToCapacityProfile ─────────────────────────────────────

describe('mapNamedResourceToCapacityProfile', () => {
  it('maps persisted named resource to owner kind namedPerson', () => {
    const rt = defaultRt()
    const nr = defaultNr({ synthetic: false })
    const result = mapNamedResourceToCapacityProfile({
      projectId: 'p1',
      resourceType: rt,
      namedResource: nr,
    })

    expect(result.owner.kind).toBe('namedPerson')
    expect(result.owner.id).toBe(nr.id)
    expect(result.owner.name).toBe(nr.name)
    expect(result.owner.roleId).toBe(rt.id)
    expect(result.owner.roleName).toBe(rt.name)
  })

  it('maps synthetic (planned) resource to owner kind plannedResource', () => {
    const rt = defaultRt()
    const nr = defaultNr({ synthetic: true })
    const result = mapNamedResourceToCapacityProfile({
      projectId: 'p1',
      resourceType: rt,
      namedResource: nr,
    })

    expect(result.owner.kind).toBe('plannedResource')
  })

  it('falls back to RT allocationMode when NR mode is null', () => {
    const rt = defaultRt({ allocationMode: 'FULL_PROJECT' })
    const nr = defaultNr({ allocationMode: null })
    const result = mapNamedResourceToCapacityProfile({
      projectId: 'p1',
      resourceType: rt,
      namedResource: nr,
    })

    expect(result.planningBasis).toBe('wholeProjectAllocation')
  })

  it('uses NR allocationMode when set (overrides RT mode)', () => {
    const rt = defaultRt({ allocationMode: 'TIMELINE' })
    const nr = defaultNr({ allocationMode: 'EFFORT' })
    const result = mapNamedResourceToCapacityProfile({
      projectId: 'p1',
      resourceType: rt,
      namedResource: nr,
    })

    expect(result.planningBasis).toBe('demandFollowing')
  })

  it('preserves NR allocationPercent over allocationPct', () => {
    const rt = defaultRt()
    const nr = defaultNr({ allocationPercent: 85, allocationPct: 70 })
    const result = mapNamedResourceToCapacityProfile({
      projectId: 'p1',
      resourceType: rt,
      namedResource: nr,
    })

    expect(result.defaultPercent).toBe(85)
  })

  it('preserves allocationStartWeek over startWeek', () => {
    const rt = defaultRt()
    const nr = defaultNr({ allocationStartWeek: 3, startWeek: 1 })
    const result = mapNamedResourceToCapacityProfile({
      projectId: 'p1',
      resourceType: rt,
      namedResource: nr,
    })

    expect(result.startWeek).toBe(3)
  })

  it('preserves allocationEndWeek over endWeek', () => {
    const rt = defaultRt()
    const nr = defaultNr({ allocationEndWeek: 10, endWeek: 8 })
    const result = mapNamedResourceToCapacityProfile({
      projectId: 'p1',
      resourceType: rt,
      namedResource: nr,
    })

    expect(result.endWeek).toBe(10)
  })

  it('includes all legacy source fields on a named resource', () => {
    const rt = defaultRt()
    const nr = defaultNr({
      allocationMode: 'TIMELINE',
      allocationPercent: 90,
      allocationPct: 80,
      allocationStartWeek: 2,
      allocationEndWeek: 9,
      startWeek: 1,
      endWeek: 10,
    })
    const result = mapNamedResourceToCapacityProfile({
      projectId: 'p1',
      resourceType: rt,
      namedResource: nr,
    })

    expect(result.legacy.allocationMode).toBe('TIMELINE')
    expect(result.legacy.allocationPercent).toBe(90)
    expect(result.legacy.allocationPct).toBe(80)
    expect(result.legacy.allocationStartWeek).toBe(2)
    expect(result.legacy.allocationEndWeek).toBe(9)
    expect(result.legacy.startWeek).toBe(1)
    expect(result.legacy.endWeek).toBe(10)
  })

  it('handles null/missing fields with same fallback as current app', () => {
    const rt = defaultRt({ allocationMode: null })
    const nr = defaultNr({
      allocationMode: null,
      allocationPercent: null,
      allocationPct: null,
      startWeek: null,
      endWeek: null,
      allocationStartWeek: null,
      allocationEndWeek: null,
    })
    const result = mapNamedResourceToCapacityProfile({
      projectId: 'p1',
      resourceType: rt,
      namedResource: nr,
    })

    expect(result.planningBasis).toBe('demandFollowing')
    expect(result.defaultPercent).toBe(100)
    expect(result.startWeek).toBeNull()
    expect(result.endWeek).toBeNull()
  })
})

// ─── mapProjectToCapacityProfiles ─────────────────────────────────────────

describe('mapProjectToCapacityProfiles', () => {
  it('returns role-level profiles when resource type has no named resources', () => {
    const rts: CapacityProfileResourceTypeLike[] = [
      defaultRt({ id: 'rt-1', name: 'Engineer', allocationMode: 'EFFORT' }),
      defaultRt({ id: 'rt-2', name: 'PM', allocationMode: 'FULL_PROJECT' }),
    ]
    const results = mapProjectToCapacityProfiles({ projectId: 'p1', resourceTypes: rts })

    expect(results).toHaveLength(2)
    expect(results[0].owner.kind).toBe('role')
    expect(results[0].owner.id).toBe('rt-1')
    expect(results[1].owner.kind).toBe('role')
    expect(results[1].owner.id).toBe('rt-2')
  })

  it('returns one profile per named resource when NRs exist', () => {
    const rt = defaultRt({ id: 'rt-1', name: 'Engineer' })
    const nrs: CapacityProfileNamedResourceLike[] = [
      defaultNr({ id: 'nr-1', name: 'Alice' }),
      defaultNr({ id: 'nr-2', name: 'Bob' }),
    ]
    const nrMap = new Map<string, CapacityProfileNamedResourceLike[]>([['rt-1', nrs]])
    const results = mapProjectToCapacityProfiles({
      projectId: 'p1',
      resourceTypes: [rt],
      namedResourcesByResourceTypeId: nrMap,
    })

    expect(results).toHaveLength(2)
    expect(results[0].owner.id).toBe('nr-1')
    expect(results[0].owner.name).toBe('Alice')
    expect(results[1].owner.id).toBe('nr-2')
    expect(results[1].owner.name).toBe('Bob')
  })

  it('does NOT create fake named people for count > 1 without NRs', () => {
    // A role with count=3 and no named resources should produce ONE role-level profile
    const rt = defaultRt({ id: 'rt-1', name: 'Engineer', count: 3 })
    const results = mapProjectToCapacityProfiles({
      projectId: 'p1',
      resourceTypes: [rt],
    })

    expect(results).toHaveLength(1)
    expect(results[0].owner.kind).toBe('role')
    expect(results[0].owner.id).toBe('rt-1')
  })

  it('passes capacityPlanSlots through to NR and RT profiles', () => {
    const rt = defaultRt({ id: 'rt-1', name: 'Engineer', allocationMode: 'CAPACITY_PLAN' })
    const nr = defaultNr({ id: 'nr-1', name: 'Alice', allocationMode: 'CAPACITY_PLAN' })
    const nrMap = new Map<string, CapacityProfileNamedResourceLike[]>([['rt-1', [nr]]])
    const slots: CapacityPlanSlotInput[] = [
      { startWeek: 0, endWeek: 3, allocationPercent: 100 },
    ]
    const slotsMap = new Map<string, CapacityPlanSlotInput[]>([['rt-1', slots]])
    const results = mapProjectToCapacityProfiles({
      projectId: 'p1',
      resourceTypes: [rt],
      namedResourcesByResourceTypeId: nrMap,
      capacityPlanSlotsByResourceTypeId: slotsMap,
    })

    expect(results).toHaveLength(1)
    expect(results[0].segments).toHaveLength(1)
    expect(results[0].segments[0].capacityPercent).toBe(100)
    expect(results[0].source).toBe('squadPlanner')
  })

  it('returns empty array for empty resource type list', () => {
    const results = mapProjectToCapacityProfiles({
      projectId: 'p1',
      resourceTypes: [],
    })
    expect(results).toEqual([])
  })
})
