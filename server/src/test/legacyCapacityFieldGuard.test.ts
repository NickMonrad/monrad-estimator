/**
 * legacyCapacityFieldGuard.test.ts — Unit tests for the shared legacy
 * capacity field rejection guard (issue #403).
 *
 * Verifies field presence detection (including explicit null), the stable
 * 400 response shape with endpoint guidance, and the planner-owned profile
 * classification used by the 409 identity-conflict guard.
 */
import { describe, expect, it, vi } from 'vitest'
import type { Response } from 'express'
import {
  LEGACY_CAPACITY_FIELDS,
  findRejectedLegacyCapacityFields,
  legacyCapacityRejection,
  rejectLegacyCapacityFields,
  isPlannerOwnedProfile,
  CAPACITY_PROFILE_ENDPOINT,
  PlannerManagedIdentityError,
  isPlannerManagedIdentityError,
  plannerOwnedIdentityConflict,
} from '../lib/legacyCapacityFieldGuard.js'

describe('findRejectedLegacyCapacityFields', () => {
  it('lists every legacy capacity field present in the body', () => {
    expect(findRejectedLegacyCapacityFields({
      name: 'Renamed',
      allocationMode: 'EFFORT',
      startWeek: 3,
    })).toEqual(['allocationMode', 'startWeek'])
  })

  it('treats explicit null values as supplied', () => {
    expect(findRejectedLegacyCapacityFields({
      allocationPercent: null,
      endWeek: null,
    })).toEqual(['allocationPercent', 'endWeek'])
  })

  it('returns an empty list when no legacy capacity field is present', () => {
    expect(findRejectedLegacyCapacityFields({
      name: 'Renamed',
      pricingModel: 'PRO_RATA',
      count: 2,
    })).toEqual([])
  })

  it('returns an empty list for non-object bodies', () => {
    expect(findRejectedLegacyCapacityFields(null)).toEqual([])
    expect(findRejectedLegacyCapacityFields('allocationMode')).toEqual([])
    expect(findRejectedLegacyCapacityFields(undefined)).toEqual([])
  })

  it('covers exactly the seven documented legacy fields', () => {
    expect(LEGACY_CAPACITY_FIELDS).toEqual([
      'allocationMode',
      'allocationPercent',
      'allocationPct',
      'allocationStartWeek',
      'allocationEndWeek',
      'startWeek',
      'endWeek',
    ])
  })
})

describe('legacyCapacityRejection', () => {
  it('produces a stable 400 body identifying rejected fields and the endpoint', () => {
    const rejection = legacyCapacityRejection(['allocationPercent', 'startWeek'])

    expect(rejection.status).toBe(400)
    expect(rejection.body.rejectedFields).toEqual(['allocationPercent', 'startWeek'])
    expect(rejection.body.capacityProfileEndpoint).toBe(CAPACITY_PROFILE_ENDPOINT)
    expect(rejection.body.error).toContain('allocationPercent')
    expect(rejection.body.error).toContain('startWeek')
    expect(rejection.body.error).toContain(CAPACITY_PROFILE_ENDPOINT)
  })
})

describe('rejectLegacyCapacityFields', () => {
  it('writes the 400 response and returns true when fields are supplied', () => {
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    } as unknown as Response

    const rejected = rejectLegacyCapacityFields({ allocationPct: null }, res)

    expect(rejected).toBe(true)
    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      rejectedFields: ['allocationPct'],
    }))
  })

  it('returns false without writing a response when no fields are supplied', () => {
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    } as unknown as Response

    const rejected = rejectLegacyCapacityFields({ name: 'Renamed' }, res)

    expect(rejected).toBe(false)
    expect(res.status).not.toHaveBeenCalled()
    expect(res.json).not.toHaveBeenCalled()
  })
})

describe('isPlannerOwnedProfile', () => {
  it('classifies SQUAD_PLANNER source profiles as planner-owned', () => {
    expect(isPlannerOwnedProfile({ source: 'SQUAD_PLANNER' })).toBe(true)
  })

  it('does not classify transferred or manual profiles as planner-owned', () => {
    expect(isPlannerOwnedProfile({ source: 'MANUAL' })).toBe(false)
    expect(isPlannerOwnedProfile({ source: 'FIXED' })).toBe(false)
    expect(isPlannerOwnedProfile({ source: 'AVAILABILITY_WINDOW' })).toBe(false)
    expect(isPlannerOwnedProfile({ source: 'IMPORTED' })).toBe(false)
    expect(isPlannerOwnedProfile({ source: null })).toBe(false)
    expect(isPlannerOwnedProfile({})).toBe(false)
  })
})

describe('PlannerManagedIdentityError', () => {
  it('carries the stable code and actionable message', () => {
    const conflict = plannerOwnedIdentityConflict('Resource type "Developer"')

    expect(conflict.code).toBe('PLANNER_MANAGED_IDENTITY')
    expect(conflict.error).toContain('Resource type "Developer"')
    expect(conflict.error).toContain('Switch to manual capacity')

    const error = new PlannerManagedIdentityError('Resource type "Developer"')
    expect(error.code).toBe('PLANNER_MANAGED_IDENTITY')
    expect(error.message).toBe(conflict.error)
    expect(isPlannerManagedIdentityError(error)).toBe(true)
    expect(isPlannerManagedIdentityError(new Error('other'))).toBe(false)
  })
})
