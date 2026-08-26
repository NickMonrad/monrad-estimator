/**
 * bulkAsNeededProfiles.test.ts — Unit tests for the explicit bulk
 * "Use role counts as As needed" action (issue #456).
 *
 * Proves the eligibility boundary (role-only + missing ROLE profile only),
 * the exact-one-canonical-profile CREATE-ONLY contract (never update or
 * replace), the NEEDS_REPLAN guard, idempotence, atomic failure
 * propagation, and the race-safe skip behaviour for profiles that appear
 * after the eligibility read. Real-PostgreSQL concurrency/atomicity is
 * covered by replanProfileRepair.integration.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Prisma } from '@prisma/client'

import {
  applyRoleCountsAsNeeded,
  applyNamedPeopleAsNeeded,
  BulkAsNeededError,
} from '../lib/bulkAsNeededProfiles.js'

const collectReplanningFindings = vi.fn()

vi.mock('../lib/completeReplanning.js', () => ({
  collectReplanningFindings: (...args: unknown[]) => collectReplanningFindings(...args),
}))

/** Minimal fake transaction — the service reads via findFirst and creates rows. */
function makeDb(projectRow: unknown) {
  const tx = {
    project: {
      findFirst: vi.fn().mockResolvedValue(projectRow),
      update: vi.fn().mockResolvedValue({ id: 'proj-1' }),
    },
    capacityProfile: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: 'profile-created' }),
      createMany: vi.fn().mockResolvedValue({ count: 1 }),
      // The bulk action is strictly create-only — never called; present so
      // tests can assert the update path is never taken.
      update: vi.fn(),
    },
  }
  const db = {
    $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
  }
  return { db, tx }
}

/** A P2002 for the partial unique index on CapacityProfile.resourceTypeId. */
function p2002RoleProfileDuplicate(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(
    'Unique constraint failed on the fields: (`resourceTypeId`)',
    {
      code: 'P2002',
      clientVersion: '7.8.0',
      meta: {
        modelName: 'CapacityProfile',
        driverAdapterError: {
          cause: {
            originalMessage:
              'insert into "CapacityProfile" ... violates unique constraint "CapacityProfile_resourceTypeId_key"',
          },
        },
      },
    },
  )
}


beforeEach(() => {
  vi.clearAllMocks()
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
    const { db, tx } = makeDb(NEEDS_REPLAN_PROJECT())

    const result = await applyRoleCountsAsNeeded(db as never, 'proj-1', 'user-1')

    expect(result).toEqual({
      projectId: 'proj-1',
      planningState: 'NEEDS_REPLAN',
      created: 1,
      remainingFindings: [],
    })
    // Only rt-1 (role-only + missing) is written; rt-2 has a profile and
    // rt-3 has named-resource authority — neither is touched.
    expect(tx.capacityProfile.create).toHaveBeenCalledTimes(1)
    expect(tx.capacityProfile.create).toHaveBeenCalledWith({
      data: {
        projectId: 'proj-1',
        ownerKind: 'ROLE',
        resourceTypeId: 'rt-1',
        namedResourceId: null,
        planningBasis: 'DEMAND_FOLLOWING',
        source: 'MANUAL',
        defaultPercent: 100,
        startWeek: null,
        endWeek: null,
        provenance: null,
      },
    })
    // Derived demand cache invalidated once for the created profiles.
    expect(tx.project.update).toHaveBeenCalledWith({
      where: { id: 'proj-1' },
      data: { weeklyDemandCache: {} },
    })
  })

  it('never overwrites an existing persisted ROLE profile', async () => {
    const { db, tx } = makeDb(NEEDS_REPLAN_PROJECT({ resourceTypes: [{ id: 'rt-2', namedResources: [] }] }))

    const result = await applyRoleCountsAsNeeded(db as never, 'proj-1', 'user-1')

    expect(result.created).toBe(0)
    expect(tx.capacityProfile.create).not.toHaveBeenCalled()
    expect(tx.capacityProfile.update).not.toHaveBeenCalled()
    expect(tx.project.update).not.toHaveBeenCalled()
  })

  it('never guesses named-resource or planned-resource ownership', async () => {
    const { db, tx } = makeDb(NEEDS_REPLAN_PROJECT({
      resourceTypes: [
        { id: 'rt-3', namedResources: [{ id: 'nr-1' }] },
      ],
    }))

    const result = await applyRoleCountsAsNeeded(db as never, 'proj-1', 'user-1')

    expect(result.created).toBe(0)
    expect(tx.capacityProfile.create).not.toHaveBeenCalled()
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
    const { db, tx } = makeDb(NEEDS_REPLAN_PROJECT({
      resourceTypes: [{ id: 'rt-1', namedResources: [] }],
      capacityProfiles: [
        { resourceTypeId: 'rt-1', namedResourceId: null, ownerKind: 'ROLE', source: 'MANUAL' },
      ],
    }))

    const first = await applyRoleCountsAsNeeded(db as never, 'proj-1', 'user-1')
    const second = await applyRoleCountsAsNeeded(db as never, 'proj-1', 'user-1')

    expect(first.created).toBe(0)
    expect(second.created).toBe(0)
    expect(tx.capacityProfile.create).not.toHaveBeenCalled()
  })

  it('skips a role whose profile appeared after the eligibility read (never updates it)', async () => {
    // Two eligible role-only roles. The per-role re-check discovers that
    // rt-4 gained a ROLE profile after the batch started → rt-4 is skipped,
    // its profile is never updated, and the other eligible role still
    // proceeds.
    const { db, tx } = makeDb(NEEDS_REPLAN_PROJECT({
      resourceTypes: [
        { id: 'rt-1', namedResources: [] },
        { id: 'rt-4', namedResources: [] },
      ],
      capacityProfiles: [],
    }))
    tx.capacityProfile.findFirst
      .mockResolvedValueOnce(null) // re-check rt-1 → missing → create
      .mockResolvedValueOnce({ id: 'concurrent-profile' }) // re-check rt-4 → exists → skip

    const result = await applyRoleCountsAsNeeded(db as never, 'proj-1', 'user-1')

    expect(result.created).toBe(1)
    expect(tx.capacityProfile.create).toHaveBeenCalledTimes(1)
    expect(tx.capacityProfile.create.mock.calls[0][0].data.resourceTypeId).toBe('rt-1')
    // No update/delete path is ever taken by the bulk action.
    expect(tx.capacityProfile.update).not.toHaveBeenCalled()
  })

  it('treats a P2002 resourceTypeId duplicate as already-exists and skips without aborting', async () => {
    // rt-1 and rt-4 are eligible. rt-4's insert races a concurrent commit
    // that wins the partial unique index → the create fails with P2002 on
    // the resourceTypeId key → the bulk treats it as "already exists" and
    // continues; the concurrent profile is untouched.
    const { db, tx } = makeDb(NEEDS_REPLAN_PROJECT({
      resourceTypes: [
        { id: 'rt-1', namedResources: [] },
        { id: 'rt-4', namedResources: [] },
      ],
      capacityProfiles: [],
    }))
    tx.capacityProfile.findFirst.mockResolvedValue(null) // both re-checks see nothing
    tx.capacityProfile.create
      .mockResolvedValueOnce({ id: 'created-rt-1' })
      .mockRejectedValueOnce(p2002RoleProfileDuplicate())

    const result = await applyRoleCountsAsNeeded(db as never, 'proj-1', 'user-1')

    expect(result.created).toBe(1)
    expect(tx.capacityProfile.create).toHaveBeenCalledTimes(2)
    expect(tx.capacityProfile.create.mock.calls[0][0].data.resourceTypeId).toBe('rt-1')
    expect(tx.capacityProfile.create.mock.calls[1][0].data.resourceTypeId).toBe('rt-4')
  })

  it('aborts the whole batch when a profile write fails mid-way', async () => {
    const { db, tx } = makeDb(NEEDS_REPLAN_PROJECT({
      resourceTypes: [
        { id: 'rt-1', namedResources: [] },
        { id: 'rt-4', namedResources: [] },
        { id: 'rt-5', namedResources: [] },
      ],
      capacityProfiles: [],
    }))
    tx.capacityProfile.findFirst.mockResolvedValue(null)
    tx.capacityProfile.create
      .mockResolvedValueOnce({ id: 'created-1' })
      .mockRejectedValueOnce(new Error('unexpected database failure'))
      .mockResolvedValueOnce({ id: 'created-2' })

    await expect(applyRoleCountsAsNeeded(db as never, 'proj-1', 'user-1')).rejects.toThrow(
      'unexpected database failure',
    )
    // The transaction promise rejects — no partial result is ever returned
    // and no state transition occurs (real rollback is proven in the
    // PostgreSQL integration suite).
    expect(tx.capacityProfile.create).toHaveBeenCalledTimes(2)
  })

  it('refuses to run unless the project NEEDS_REPLAN (409 stable code)', async () => {
    const { db, tx } = makeDb({ id: 'proj-1', planningState: 'CURRENT', resourceTypes: [], capacityProfiles: [] })

    await expect(applyRoleCountsAsNeeded(db as never, 'proj-1', 'user-1')).rejects.toMatchObject({
      name: 'BulkAsNeededError',
      status: 409,
      code: 'REPLAN_ACTION_UNAVAILABLE',
    } as Partial<BulkAsNeededError>)
    expect(tx.capacityProfile.create).not.toHaveBeenCalled()
  })

  it('throws 404 when the project is not found or not owned', async () => {
    const { db, tx } = makeDb(null)

    await expect(applyRoleCountsAsNeeded(db as never, 'proj-1', 'user-1')).rejects.toMatchObject({
      name: 'BulkAsNeededError',
      status: 404,
      code: 'PROJECT_NOT_FOUND',
    } as Partial<BulkAsNeededError>)
    expect(tx.capacityProfile.create).not.toHaveBeenCalled()
  })

  it('keeps the project NEEDS_REPLAN — completion owns the state transition', async () => {
    const { db } = makeDb(NEEDS_REPLAN_PROJECT())
    const result = await applyRoleCountsAsNeeded(db as never, 'proj-1', 'user-1')
    expect(result.planningState).toBe('NEEDS_REPLAN')
  })
})

const NAMED_PEOPLE_PROJECT = (overrides: Record<string, unknown> = {}) => ({
  id: 'proj-1',
  planningState: 'NEEDS_REPLAN',
  resourceTypes: [
    { id: 'rt-engineering', namedResources: [{ id: 'nr-alice' }, { id: 'nr-bob' }] },
    { id: 'rt-planner', namedResources: [{ id: 'nr-planner' }] },
  ],
  capacityProfiles: [
    { resourceTypeId: 'rt-planner', namedResourceId: null, ownerKind: 'ROLE', source: 'SQUAD_PLANNER' },
    { resourceTypeId: null, namedResourceId: 'nr-bob', ownerKind: 'NAMED_PERSON', source: 'MANUAL' },
  ],
  ...overrides,
})

describe('applyNamedPeopleAsNeeded', () => {
  it('creates canonical profiles only for eligible missing named people', async () => {
    const { db, tx } = makeDb(NAMED_PEOPLE_PROJECT())

    const result = await applyNamedPeopleAsNeeded(db as never, 'proj-1', 'user-1')

    expect(result).toMatchObject({ projectId: 'proj-1', planningState: 'NEEDS_REPLAN', created: 1 })
    expect(tx.capacityProfile.createMany).toHaveBeenCalledWith({
      data: [{
        projectId: 'proj-1',
        ownerKind: 'NAMED_PERSON',
        resourceTypeId: null,
        namedResourceId: 'nr-alice',
        planningBasis: 'DEMAND_FOLLOWING',
        source: 'MANUAL',
        defaultPercent: 100,
        startWeek: null,
        endWeek: null,
        provenance: null,
      }],
      skipDuplicates: true,
    })
    expect(tx.capacityProfile.create).not.toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ namedResourceId: 'nr-planner' }),
    }))
  })

  it('is create-only and idempotent for existing named profiles', async () => {
    const { db, tx } = makeDb(NAMED_PEOPLE_PROJECT({
      resourceTypes: [{ id: 'rt-engineering', namedResources: [{ id: 'nr-alice' }] }],
      capacityProfiles: [{ resourceTypeId: null, namedResourceId: 'nr-alice', ownerKind: 'NAMED_PERSON', source: 'AVAILABILITY_WINDOW' }],
    }))

    const first = await applyNamedPeopleAsNeeded(db as never, 'proj-1', 'user-1')
    const second = await applyNamedPeopleAsNeeded(db as never, 'proj-1', 'user-1')

    expect(first.created).toBe(0)
    expect(second.created).toBe(0)
    expect(tx.capacityProfile.create).not.toHaveBeenCalled()
    expect(tx.capacityProfile.update).not.toHaveBeenCalled()
  })

  it('rolls back the batch when a later named profile write fails', async () => {
    const { db, tx } = makeDb(NAMED_PEOPLE_PROJECT({
      resourceTypes: [{ id: 'rt-engineering', namedResources: [{ id: 'nr-alice' }, { id: 'nr-charlie' }] }],
      capacityProfiles: [],
    }))
    tx.capacityProfile.findFirst.mockResolvedValue(null)
    tx.capacityProfile.createMany
      .mockResolvedValueOnce({ count: 1 })
      .mockRejectedValueOnce(new Error('unexpected database failure'))

    await expect(applyNamedPeopleAsNeeded(db as never, 'proj-1', 'user-1')).rejects.toThrow('unexpected database failure')
    expect(tx.capacityProfile.createMany).toHaveBeenCalledTimes(2)
  })

  it('treats a concurrent named-owner unique conflict as an unchanged skip', async () => {
    const { db, tx } = makeDb(NAMED_PEOPLE_PROJECT({
      resourceTypes: [{ id: 'rt-engineering', namedResources: [{ id: 'nr-alice' }, { id: 'nr-charlie' }] }],
      capacityProfiles: [],
    }))
    tx.capacityProfile.findFirst.mockResolvedValue(null)
    tx.capacityProfile.createMany
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 1 })

    const result = await applyNamedPeopleAsNeeded(db as never, 'proj-1', 'user-1')

    expect(result.created).toBe(1)
    expect(tx.capacityProfile.update).not.toHaveBeenCalled()
  })
})
