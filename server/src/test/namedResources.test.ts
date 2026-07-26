/**
 * namedResources.test.ts — Route-level tests for named-resource capacity
 * profile write path.
 *
 * These tests verify that named-resource create/update uses the profile-first
 * write path (upsertNRProfileAndProjectLegacy) instead of the legacy sync.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { app } from '../index.js'
import { prisma } from '../lib/prisma.js'
import { syncCapacityProfilesForProject } from '../lib/syncCapacityProfiles.js'
import type { LegacyAllocationProjection } from '../lib/capacityProfileLegacyProjection.js'

// Mock the new profile-first write helper
vi.mock('../lib/namedResourceCapacityProfileWrites.js', () => ({
  upsertNRProfileAndProjectLegacy: vi.fn().mockResolvedValue({
    allocationMode: 'EFFORT',
    allocationPercent: 100,
    allocationStartWeek: null,
    allocationEndWeek: null,
    lossy: false,
  } as LegacyAllocationProjection),
}))

vi.mock('../lib/syncCapacityProfiles.js', () => ({
  syncCapacityProfilesForProject: vi.fn().mockResolvedValue({
    profilesCreated: 0,
    profilesUpdated: 0,
    profilesDeleted: 0,
    segmentsCreated: 0,
    segmentsDeleted: 0,
  }),
}))

import { upsertNRProfileAndProjectLegacy } from '../lib/namedResourceCapacityProfileWrites.js'

process.env.JWT_SECRET = 'test-secret'

const userId = 'user-1'
const token = jwt.sign({ userId }, 'test-secret')
const authHeader = `Bearer ${token}`

beforeEach(() => {
  vi.clearAllMocks()
  // Guard runs inside the transaction; default to no profiles (passes guard)
  vi.mocked(prisma.capacityProfile.findMany).mockResolvedValue([])
})

describe('named-resource capacity profile write', () => {
  it('PUT named-resource capacity update calls upsertNRProfileAndProjectLegacy', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue({ id: 'proj-1', ownerId: userId } as never)
    vi.mocked(prisma.resourceType.findFirst).mockResolvedValue({ id: 'rt-1', projectId: 'proj-1', allocationMode: 'EFFORT' } as never)
    vi.mocked(prisma.namedResource.findFirst).mockResolvedValue({
      id: 'nr-1',
      resourceTypeId: 'rt-1',
      allocationMode: 'EFFORT',
      allocationPercent: 100,
      allocationStartWeek: null,
      allocationEndWeek: null,
      startWeek: null,
      endWeek: null,
    } as never)

    const tx = {
      capacityProfile: {
        findMany: vi.fn().mockResolvedValue([]),
        update: vi.fn(),
      },
      namedResource: {
        update: vi.fn().mockResolvedValue({ id: 'nr-1' }),
      },
      project: { update: vi.fn() },
    }
    vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) => fn(tx))

    await request(app)
      .put('/api/projects/proj-1/resource-types/rt-1/named-resources/nr-1')
      .set('Authorization', authHeader)
      .send({ allocationMode: 'TIMELINE', allocationPercent: 80 })

    expect(upsertNRProfileAndProjectLegacy).toHaveBeenCalledWith(tx, 'proj-1', 'nr-1', 'rt-1', expect.objectContaining({
      allocationMode: 'TIMELINE',
    }))
    // Sync is NOT called after #364 cutover
    expect(syncCapacityProfilesForProject).not.toHaveBeenCalled()
  })
  it('PATCH named-resource update calls upsertNRProfileAndProjectLegacy inside the transaction', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue({ id: 'proj-1', ownerId: userId } as never)
    vi.mocked(prisma.resourceType.findFirst).mockResolvedValue({ id: 'rt-1', projectId: 'proj-1', allocationMode: 'EFFORT' } as never)
    vi.mocked(prisma.namedResource.findFirst).mockResolvedValue({
      id: 'nr-1',
      resourceTypeId: 'rt-1',
      allocationMode: 'EFFORT',
      allocationPercent: 100,
      allocationPct: 100,
      allocationStartWeek: null,
      allocationEndWeek: null,
      startWeek: null,
      endWeek: null,
    } as never)

    const tx = {
      capacityProfile: {
        findMany: vi.fn().mockResolvedValue([]),
        update: vi.fn(),
      },
      namedResource: { update: vi.fn().mockResolvedValue({ id: 'nr-1' }) },
      project: { update: vi.fn() },
    }
    vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) => fn(tx))

    await request(app)
      .patch('/api/projects/proj-1/resource-types/rt-1/named-resources/nr-1')
      .set('Authorization', authHeader)
      .send({ allocationMode: 'TIMELINE' })

    expect(upsertNRProfileAndProjectLegacy).toHaveBeenCalledWith(tx, 'proj-1', 'nr-1', 'rt-1', expect.objectContaining({
      allocationMode: 'TIMELINE',
    }))
    // Sync is NOT called after #364
    expect(syncCapacityProfilesForProject).not.toHaveBeenCalled()
  })
  it('PUT named-resource with existing profile does not call sync', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue({ id: 'proj-1', ownerId: userId } as never)
    vi.mocked(prisma.resourceType.findFirst).mockResolvedValue({ id: 'rt-1', projectId: 'proj-1', allocationMode: 'EFFORT' } as never)
    vi.mocked(prisma.namedResource.findFirst).mockResolvedValue({ id: 'nr-1', resourceTypeId: 'rt-1' } as never)

    const tx = {
      capacityProfile: {
        findMany: vi.fn().mockResolvedValue([{ id: 'cp-1' }]),
        update: vi.fn(),
      },
      namedResource: {
        update: vi.fn().mockResolvedValue({ id: 'nr-1', name: 'Updated' }),
        findFirst: vi.fn().mockResolvedValue({ id: 'nr-1', name: 'Updated' }),
      },
      project: { update: vi.fn() },
    }
    vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) => fn(tx))

    await request(app)
      .put('/api/projects/proj-1/resource-types/rt-1/named-resources/nr-1')
      .set('Authorization', authHeader)
      .send({ name: 'Updated' })

    // Non-capacity update writes name directly
    expect(tx.namedResource.update).toHaveBeenCalled()
    // Sync is NOT called after #364
    expect(syncCapacityProfilesForProject).not.toHaveBeenCalled()
  })
  it('DELETE named-resource does not call sync (cascade handles profiles)', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue({ id: 'proj-1', ownerId: userId } as never)
    vi.mocked(prisma.resourceType.findFirst).mockResolvedValue({ id: 'rt-1', projectId: 'proj-1', allocationMode: 'EFFORT' } as never)
    vi.mocked(prisma.namedResource.findFirst).mockResolvedValue({ id: 'nr-1', resourceTypeId: 'rt-1' } as never)

    const deleteFn = vi.fn().mockResolvedValue(undefined)
    const countFn = vi.fn().mockResolvedValue(0)
    const updateFn = vi.fn().mockResolvedValue({ id: 'rt-1' })
    const projectUpdateFn = vi.fn()

    const tx = {
      namedResource: { delete: deleteFn, count: countFn },
      resourceType: { update: updateFn },
      project: { update: projectUpdateFn },
    }
    vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) => fn(tx))

    const res = await request(app)
      .delete('/api/projects/proj-1/resource-types/rt-1/named-resources/nr-1')
      .set('Authorization', authHeader)

    expect(res.status).toBe(204)

    // DELETE relies on schema cascade; sync is NOT called
    expect(syncCapacityProfilesForProject).not.toHaveBeenCalled()
    // Call order: delete < count < update
    expect(deleteFn.mock.invocationCallOrder[0]).toBeLessThan(
      countFn.mock.invocationCallOrder[0],
    )
    expect(countFn.mock.invocationCallOrder[0]).toBeLessThan(
      updateFn.mock.invocationCallOrder[0],
    )
  })

  it('DELETE succeeds without sync (cascade handles profile cleanup)', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue({ id: 'proj-1', ownerId: userId } as never)
    vi.mocked(prisma.resourceType.findFirst).mockResolvedValue({ id: 'rt-1', projectId: 'proj-1', allocationMode: 'EFFORT' } as never)
    vi.mocked(prisma.namedResource.findFirst).mockResolvedValue({ id: 'nr-1', resourceTypeId: 'rt-1' } as never)

    const deleteFn = vi.fn().mockResolvedValue(undefined)
    const countFn = vi.fn().mockResolvedValue(0)
    const updateFn = vi.fn().mockResolvedValue({ id: 'rt-1' })

    const tx = {
      namedResource: { delete: deleteFn, count: countFn },
      resourceType: { update: updateFn },
      project: { update: vi.fn() },
    }
    vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) => fn(tx))

    const res = await request(app)
      .delete('/api/projects/proj-1/resource-types/rt-1/named-resources/nr-1')
      .set('Authorization', authHeader)

    expect(res.status).toBe(204)
    expect(syncCapacityProfilesForProject).not.toHaveBeenCalled()
    expect(deleteFn).toHaveBeenCalled()
    expect(countFn).toHaveBeenCalled()
    expect(updateFn).toHaveBeenCalled()
  })
  it('PUT non-capacity fails closed when no profile exists', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue({ id: 'proj-1', ownerId: userId } as never)
    vi.mocked(prisma.resourceType.findFirst).mockResolvedValue({ id: 'rt-1', projectId: 'proj-1', allocationMode: 'EFFORT' } as never)
    vi.mocked(prisma.namedResource.findFirst).mockResolvedValue({ id: 'nr-1', resourceTypeId: 'rt-1' } as never)

    const tx = {
      capacityProfile: {
        findMany: vi.fn().mockResolvedValue([]),
        update: vi.fn(),
      },
      namedResource: { update: vi.fn().mockResolvedValue({ id: 'nr-1' }) },
      project: { update: vi.fn() },
    }
    vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) => fn(tx))

    const res = await request(app)
      .put('/api/projects/proj-1/resource-types/rt-1/named-resources/nr-1')
      .set('Authorization', authHeader)
      .send({ name: 'Updated' })

    // Missing profile should fail closed with 409 via CapacityIntegrityError
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('CAPACITY_INTEGRITY_ERROR')
  })
})

describe('named-resource capacity guard', () => {
  async function setupProtectedProfile(profiles: any[]) {
    vi.mocked(prisma.project.findFirst).mockResolvedValue({ id: 'proj-1', ownerId: userId } as never)
    vi.mocked(prisma.resourceType.findFirst).mockResolvedValue({ id: 'rt-1', projectId: 'proj-1', allocationMode: 'EFFORT' } as never)
    vi.mocked(prisma.namedResource.findFirst).mockResolvedValue({
      id: 'nr-1',
      resourceTypeId: 'rt-1',
      allocationMode: 'TIMELINE',
      allocationPercent: 50,
      allocationPct: 50,
      allocationStartWeek: 2,
      allocationEndWeek: 8,
      startWeek: 2,
      endWeek: 8,
    } as never)
    // Global prisma guard path — not used since guard moved inside transaction.
    // Mock resolves [] by default (beforeEach), override for guard-path assertions.
    const tx = {
      capacityProfile: {
        findMany: vi.fn().mockResolvedValue(profiles),
        update: vi.fn(),
      },
      namedResource: {
        update: vi.fn().mockResolvedValue({ id: 'nr-1', name: 'Updated' }),
        findFirst: vi.fn().mockResolvedValue({ id: 'nr-1', name: 'Updated' }),
      },
      project: { update: vi.fn() },
    }
    vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) => fn(tx))
    return tx
  }

  describe('rejected PUT atomicity', () => {
    it('rejects with 409, no writes, guard inside transaction for segmented profile', async () => {
      const tx = await setupProtectedProfile([{
        id: 'cp-1', planningBasis: 'availabilityWindow', ownerKind: 'NAMED_PERSON',
        segments: [{ id: 'cs-1', startWeek: 0, endWeek: 5 }],
      }])

      const res = await request(app)
        .put('/api/projects/proj-1/resource-types/rt-1/named-resources/nr-1')
        .set('Authorization', authHeader)
        .send({ name: 'Should not persist', pricingModel: 'PRO_RATA', allocationPercent: 75, startWeek: 0, endWeek: 10 })

      expect(res.status).toBe(409)
      expect(res.body.code).toBe('PROFILE_MANAGED_CAPACITY')
      expect(res.body.error).toBeTruthy()
      // Transaction IS entered (guard runs inside it)
      expect(prisma.$transaction).toHaveBeenCalled()
      // Guard queried through the transaction client
      expect(tx.capacityProfile.findMany).toHaveBeenCalledWith({
        where: { namedResourceId: 'nr-1', projectId: 'proj-1' },
        include: { segments: { select: { id: true, startWeek: true, endWeek: true } } },
        orderBy: { createdAt: 'asc' },
      })
      // No write occurred before the guard — namedResource.update was never called
      expect(tx.namedResource.update).not.toHaveBeenCalled()
    })

    it('rejects PUT with 409 for CAPACITY_PROFILE planning basis (no segments)', async () => {
      const tx = await setupProtectedProfile([{
        id: 'cp-1', planningBasis: 'CAPACITY_PROFILE', ownerKind: 'NAMED_PERSON',
        segments: [],
      }])

      const res = await request(app)
        .put('/api/projects/proj-1/resource-types/rt-1/named-resources/nr-1')
        .set('Authorization', authHeader)
        .send({ allocationPercent: 75 })

      expect(res.status).toBe(409)
      expect(res.body.code).toBe('PROFILE_MANAGED_CAPACITY')
      expect(prisma.$transaction).toHaveBeenCalled()
      expect(tx.namedResource.update).not.toHaveBeenCalled()
    })

    it('rejects PUT with 409 for PLANNED_RESOURCE owner', async () => {
      const tx = await setupProtectedProfile([{
        id: 'cp-1', planningBasis: 'availabilityWindow', ownerKind: 'PLANNED_RESOURCE',
        segments: [],
      }])

      const res = await request(app)
        .put('/api/projects/proj-1/resource-types/rt-1/named-resources/nr-1')
        .set('Authorization', authHeader)
        .send({ allocationPercent: 75 })

      expect(res.status).toBe(409)
      expect(res.body.code).toBe('PROFILE_MANAGED_CAPACITY')
      expect(prisma.$transaction).toHaveBeenCalled()
      expect(tx.namedResource.update).not.toHaveBeenCalled()
    })

    it('rejects PUT with 409 for conflicting duplicate profiles', async () => {
      const tx = await setupProtectedProfile([
        { id: 'cp-1', planningBasis: 'availabilityWindow', ownerKind: 'NAMED_PERSON', segments: [] },
        { id: 'cp-2', planningBasis: 'demandFollowing', ownerKind: 'NAMED_PERSON', segments: [] },
      ])

      const res = await request(app)
        .put('/api/projects/proj-1/resource-types/rt-1/named-resources/nr-1')
        .set('Authorization', authHeader)
        .send({ allocationPercent: 75 })

      expect(res.status).toBe(409)
      expect(res.body.code).toBe('PROFILE_MANAGED_CAPACITY')
      expect(prisma.$transaction).toHaveBeenCalled()
      expect(tx.namedResource.update).not.toHaveBeenCalled()
    })
  })

  describe('rejected PATCH contract', () => {
    it('rejects PATCH with 409 and stable contract for segmented profile', async () => {
      const tx = await setupProtectedProfile([{
        id: 'cp-1', planningBasis: 'availabilityWindow', ownerKind: 'NAMED_PERSON',
        segments: [{ id: 'cs-1', startWeek: 0, endWeek: 5 }],
      }])

      const res = await request(app)
        .patch('/api/projects/proj-1/resource-types/rt-1/named-resources/nr-1')
        .set('Authorization', authHeader)
        .send({ allocationPercent: 75 })

      expect(res.status).toBe(409)
      expect(res.body.code).toBe('PROFILE_MANAGED_CAPACITY')
      expect(res.body.error).toBeTruthy()
      expect(prisma.$transaction).toHaveBeenCalled()
      expect(tx.namedResource.update).not.toHaveBeenCalled()
    })
  })

  describe('non-protection errors propagate', () => {
    it('does NOT convert non-ProfileManagedCapacityError to 409', async () => {
      vi.mocked(prisma.project.findFirst).mockResolvedValue({ id: 'proj-1', ownerId: userId } as never)
      vi.mocked(prisma.resourceType.findFirst).mockResolvedValue({ id: 'rt-1', projectId: 'proj-1', allocationMode: 'EFFORT' } as never)
      vi.mocked(prisma.namedResource.findFirst).mockResolvedValue({
        id: 'nr-1', resourceTypeId: 'rt-1',
        allocationMode: 'TIMELINE', allocationPercent: 50, allocationPct: 50,
        allocationStartWeek: 2, allocationEndWeek: 8, startWeek: 2, endWeek: 8,
      } as never)

      const tx = {
        capacityProfile: {
          findMany: vi.fn().mockRejectedValue(new Error('DB connection lost')),
          update: vi.fn(),
        },
        namedResource: {
          update: vi.fn(),
          findFirst: vi.fn(),
        },
        project: { update: vi.fn() },
      }
      vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) => fn(tx))

      const res = await request(app)
        .put('/api/projects/proj-1/resource-types/rt-1/named-resources/nr-1')
        .set('Authorization', authHeader)
        .send({ allocationPercent: 75 })

      // Generic Error is not ProfileManagedCapacityError — it is NOT converted to 409
      expect(res.status).not.toBe(409)
      expect(res.body.code).not.toBe('PROFILE_MANAGED_CAPACITY')
      // The error propagates: asyncHandler catches it, supertest surfaces as 500
      expect(res.status).toBe(500)
    })
  })

  describe('safe non-capacity requests', () => {
    async function setupSafeProfile(profiles: any[]) {
      vi.mocked(prisma.project.findFirst).mockResolvedValue({ id: 'proj-1', ownerId: userId } as never)
      vi.mocked(prisma.resourceType.findFirst).mockResolvedValue({ id: 'rt-1', projectId: 'proj-1', allocationMode: 'EFFORT' } as never)
      vi.mocked(prisma.namedResource.findFirst).mockResolvedValue({
        id: 'nr-1', resourceTypeId: 'rt-1',
        allocationMode: 'TIMELINE', allocationPercent: 50, allocationPct: 50,
        allocationStartWeek: 2, allocationEndWeek: 8, startWeek: 2, endWeek: 8,
      } as never)
      const tx = {
        capacityProfile: {
          // Return existing profiles so the non-capacity path skips missing-profile reconstruction
          findMany: vi.fn().mockResolvedValue(profiles),
          update: vi.fn(),
        },
        namedResource: {
          update: vi.fn().mockResolvedValue({ id: 'nr-1', name: 'Updated' }),
          findFirst: vi.fn().mockResolvedValue({ id: 'nr-1', name: 'Updated' }),
        },
        project: { update: vi.fn() },
      }
      vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) => fn(tx))
      return tx
    }

    it('allows name-only PUT for segmented profile (changes only name, preserves profile)', async () => {
      const tx = await setupSafeProfile([{
        id: 'cp-1', planningBasis: 'availabilityWindow', ownerKind: 'NAMED_PERSON',
        segments: [{ id: 'cs-1', startWeek: 0, endWeek: 5 }],
      }])

      const res = await request(app)
        .put('/api/projects/proj-1/resource-types/rt-1/named-resources/nr-1')
        .set('Authorization', authHeader)
        .send({ name: 'New Name' })

      expect(res.status).toBe(200)
      // Only name was updated on NamedResource
      expect(tx.namedResource.update).toHaveBeenCalledWith({
        where: { id: 'nr-1' },
        data: { name: 'New Name' },
      })
      expect(tx.namedResource.update).toHaveBeenCalledTimes(1)
      // upsertNRProfileAndProjectLegacy was NOT called (profile exists)
      expect(upsertNRProfileAndProjectLegacy).not.toHaveBeenCalled()
    })

    it('allows pricing-only PUT for segmented profile (changes only pricing)', async () => {
      const tx = await setupSafeProfile([{
        id: 'cp-1', planningBasis: 'availabilityWindow', ownerKind: 'NAMED_PERSON',
        segments: [{ id: 'cs-1', startWeek: 0, endWeek: 5 }],
      }])

      const res = await request(app)
        .put('/api/projects/proj-1/resource-types/rt-1/named-resources/nr-1')
        .set('Authorization', authHeader)
        .send({ pricingModel: 'PRO_RATA' })

      expect(res.status).toBe(200)
      expect(tx.namedResource.update).toHaveBeenCalledWith({
        where: { id: 'nr-1' },
        data: { pricingModel: 'PRO_RATA' },
      })
      expect(tx.namedResource.update).toHaveBeenCalledTimes(1)
      expect(upsertNRProfileAndProjectLegacy).not.toHaveBeenCalled()
    })

    it('allows segmentless scalar NAMED_PERSON capacity update with exact projection', async () => {
      const tx = await setupProtectedProfile([{
        id: 'cp-1', planningBasis: 'availabilityWindow', ownerKind: 'NAMED_PERSON',
        segments: [],
      }])

      const res = await request(app)
        .put('/api/projects/proj-1/resource-types/rt-1/named-resources/nr-1')
        .set('Authorization', authHeader)
        .send({ startWeek: 4, endWeek: 9, allocationPct: 70 })

      expect(res.status).toBe(200)
      expect(prisma.$transaction).toHaveBeenCalled()

      // Verify the capacity payload sent to the helper contains the intended values
      expect(upsertNRProfileAndProjectLegacy).toHaveBeenCalled()
      const payload = vi.mocked(upsertNRProfileAndProjectLegacy).mock.lastCall?.[4]
      expect(payload).toBeDefined()
      expect(payload!.startWeek).toBe(4)
      expect(payload!.endWeek).toBe(9)
      expect(payload!.allocationPct).toBe(70)
      // allocationStartWeek and allocationEndWeek resolved from startWeek/endWeek aliases
      expect(payload!.allocationStartWeek).toBe(4)
      expect(payload!.allocationEndWeek).toBe(9)

      // Compatibility projection received from helper is written back
      const updateCalls = vi.mocked(tx.namedResource.update).mock.calls
      const compatUpdate = updateCalls.find(c => {
        const d = c[0] as any
        return d.data && d.data.startWeek !== undefined
      })
      expect(compatUpdate).toBeDefined()
      const data = (compatUpdate![0] as any).data
      // The mock helper returns {allocationMode: 'EFFORT', allocationPercent: 100, ...}
      expect(data.allocationMode).toBe('EFFORT')
      expect(data.allocationPercent).toBe(100)
      expect(data.allocationPct).toBe(100)
      expect(data.startWeek).toBeNull()
      expect(data.endWeek).toBeNull()
      expect(data.allocationStartWeek).toBeNull()
      expect(data.allocationEndWeek).toBeNull()
    })
  })
})

