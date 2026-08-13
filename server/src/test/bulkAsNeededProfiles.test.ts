/**
 * bulkAsNeededProfiles.test.ts — Unit tests for the explicit bulk
 * "Use role counts as As needed" action (issue #456).
 *
 * Proves the eligibility boundary (role-only + missing ROLE profile only),
 * the exact-one-canonical-profile contract via the authoritative writer,
 * the NEEDS_REPLAN guard, idempotence, and atomic failure propagation.
 * Real-PostgreSQL atomicity/rollback is covered by the integration suite.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

import {
  applyRoleCountsAsNeeded,
  BulkAsNeededError,
} from '../lib/bulkAsNeededProfiles.js'

const replaceCapacityProfile = vi.fn()
const collectReplanningFindings = vi.fn()

vi.mock('../lib/capacityProfileReplaceService.js', () => ({
  replaceCapacityProfile: (...args: unknown[]) => replaceCapacityProfile(...args),
}))

vi.mock('../lib/completeReplanning.js', () => ({
  collectReplanningFindings: (...args: unknown[]) => collectReplanningFindings(...args),
}))

/** Minimal fake transaction — the service reads everything via findFirst. */
function makeDb(projectRow: unknown) {
  const tx = {
    project: {
      findFirst: vi.fn().mockResolvedValue(projectRow),
    },
  }
  const db = {
    $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
  }
  return { db, tx }
}

beforeEach(() => {
  vi.clearAllMocks()
  replaceCapacityProfile.mockResolvedValue({ id: 'profile-created' })
  collectReplanningFindings.mockResolvedValue([])
})

const NEEDS_REPLAN_PROJECT = (overrides: Record<string, unknown> = {}) => ({
  id: 'proj-1',
  planningState: 'NEEDS_REPLAN',
  resourceTypes: [
    // Role-only, no profile → eligible.
    { id: 'rt-1', namedResources: [] },
    // Role-only with an existing persisted ROLE profile → never overwritten.
    { id: 'rt-2', namedResources: [] },
    // Role with named resources → never guessed.
    { id: 'rt-3', namedResources: [{ id: 'nr-1' }] },
  ],
  capacityProfiles: [
    { resourceTypeId: 'rt-2', namedResourceId: null, ownerKind: 'ROLE', source: 'MANUAL' },
    { resourceTypeId: null, namedResourceId: 'nr-1', ownerKind: 'NAMED_PERSON', source: 'MANUAL' },
  ],
  ...overrides,
})

describe('applyRoleCountsAsNeeded', () => {
  it('creates exactly one canonical As-needed ROLE profile per eligible missing role-only type', async () => {
    const { db } = makeDb(NEEDS_REPLAN_PROJECT())

    const result = await applyRoleCountsAsNeeded(db as never, 'proj-1', 'user-1')

    expect(result).toEqual({
      projectId: 'proj-1',
      planningState: 'NEEDS_REPLAN',
      created: 1,
      remainingFindings: [],
    })
    // Only rt-1 (role-only + missing) is written; rt-2 has a profile and
    // rt-3 has named-resource authority — neither is touched.
    expect(replaceCapacityProfile).toHaveBeenCalledTimes(1)
    expect(replaceCapacityProfile).toHaveBeenCalledWith(
      expect.anything(),
      'proj-1',
      'ROLE',
      'rt-1',
      { planningBasis: 'DEMAND_FOLLOWING', defaultPercent: 100 },
      'user-1',
    )
  })

  it('never overwrites an existing persisted ROLE profile', async () => {
    const { db } = makeDb(NEEDS_REPLAN_PROJECT({ resourceTypes: [{ id: 'rt-2', namedResources: [] }] }))

    const result = await applyRoleCountsAsNeeded(db as never, 'proj-1', 'user-1')

    expect(result.created).toBe(0)
    expect(replaceCapacityProfile).not.toHaveBeenCalled()
  })

  it('never guesses named-resource or planned-resource ownership', async () => {
    const { db } = makeDb(NEEDS_REPLAN_PROJECT({
      resourceTypes: [
        { id: 'rt-3', namedResources: [{ id: 'nr-1' }] },
      ],
    }))

    const result = await applyRoleCountsAsNeeded(db as never, 'proj-1', 'user-1')

    expect(result.created).toBe(0)
    expect(replaceCapacityProfile).not.toHaveBeenCalled()
  })

  it('reports remaining completeness findings from the authoritative validation', async () => {
    collectReplanningFindings.mockResolvedValue([
      'Named resource "Alice" lacks persisted profile (named resource nr-1, resource type rt-3)',
    ])
    const { db } = makeDb(NEEDS_REPLAN_PROJECT())

    const result = await applyRoleCountsAsNeeded(db as never, 'proj-1', 'user-1')

    expect(result.created).toBe(1)
    expect(result.remainingFindings).toEqual([
      'Named resource "Alice" lacks persisted profile (named resource nr-1, resource type rt-3)',
    ])
    expect(collectReplanningFindings).toHaveBeenCalledWith(expect.anything(), 'proj-1')
  })

  it('is idempotent when every eligible role already has a profile', async () => {
    const { db } = makeDb(NEEDS_REPLAN_PROJECT({
      resourceTypes: [{ id: 'rt-1', namedResources: [] }],
      capacityProfiles: [
        { resourceTypeId: 'rt-1', namedResourceId: null, ownerKind: 'ROLE', source: 'MANUAL' },
      ],
    }))

    const first = await applyRoleCountsAsNeeded(db as never, 'proj-1', 'user-1')
    const second = await applyRoleCountsAsNeeded(db as never, 'proj-1', 'user-1')

    expect(first.created).toBe(0)
    expect(second.created).toBe(0)
    expect(replaceCapacityProfile).not.toHaveBeenCalled()
  })

  it('refuses to run unless the project NEEDS_REPLAN (409 stable code)', async () => {
    const { db } = makeDb({ id: 'proj-1', planningState: 'CURRENT', resourceTypes: [], capacityProfiles: [] })

    await expect(applyRoleCountsAsNeeded(db as never, 'proj-1', 'user-1')).rejects.toMatchObject({
      name: 'BulkAsNeededError',
      status: 409,
      code: 'REPLAN_ACTION_UNAVAILABLE',
    } as Partial<BulkAsNeededError>)
    expect(replaceCapacityProfile).not.toHaveBeenCalled()
  })

  it('throws 404 when the project is not found or not owned', async () => {
    const { db } = makeDb(null)

    await expect(applyRoleCountsAsNeeded(db as never, 'proj-1', 'user-1')).rejects.toMatchObject({
      name: 'BulkAsNeededError',
      status: 404,
      code: 'PROJECT_NOT_FOUND',
    } as Partial<BulkAsNeededError>)
  })

  it('aborts the whole batch when a profile write fails mid-way', async () => {
    replaceCapacityProfile
      .mockResolvedValueOnce({ id: 'created-1' })
      .mockRejectedValueOnce(new Error('unique constraint violation (concurrent create)'))
    const { db } = makeDb(NEEDS_REPLAN_PROJECT({
      resourceTypes: [
        { id: 'rt-1', namedResources: [] },
        { id: 'rt-4', namedResources: [] },
        { id: 'rt-5', namedResources: [] },
      ],
    }))

    await expect(applyRoleCountsAsNeeded(db as never, 'proj-1', 'user-1')).rejects.toThrow(
      'unique constraint violation',
    )
    // The transaction promise rejects — no partial result is ever returned
    // and no state transition occurs (real rollback is proven in the
    // PostgreSQL integration suite).
    expect(replaceCapacityProfile).toHaveBeenCalledTimes(2)
  })

  it('keeps the project NEEDS_REPLAN — completion owns the state transition', async () => {
    const { db } = makeDb(NEEDS_REPLAN_PROJECT())
    const result = await applyRoleCountsAsNeeded(db as never, 'proj-1', 'user-1')
    expect(result.planningState).toBe('NEEDS_REPLAN')
  })
})
