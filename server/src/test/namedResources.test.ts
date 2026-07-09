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
})

describe('named-resource capacity profile write', () => {
  it('PUT named-resource update calls upsertNRProfileAndProjectLegacy inside the transaction', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue({ id: 'proj-1', ownerId: userId } as never)
    vi.mocked(prisma.resourceType.findFirst).mockResolvedValue({ id: 'rt-1', projectId: 'proj-1', allocationMode: 'EFFORT' } as never)
    vi.mocked(prisma.namedResource.findFirst).mockResolvedValue({ id: 'nr-1', resourceTypeId: 'rt-1' } as never)

    const tx = {
      capacityProfile: {
        findMany: vi.fn().mockResolvedValue([]),
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

    // Helper still called to ensure a profile exists
    expect(upsertNRProfileAndProjectLegacy).toHaveBeenCalledWith(tx, 'proj-1', 'nr-1', 'rt-1', expect.any(Object))
    // Non-capacity update always happens (name field)
    expect(tx.namedResource.update).toHaveBeenCalledWith({
      where: { id: 'nr-1' },
      data: { name: 'Updated' },
    })
    // No capacity-input → route does NOT update legacy fields via a second update
    expect(tx.namedResource.update).toHaveBeenCalledTimes(1)
    // Route re-reads the NR after creating the profile
    expect(tx.namedResource.findFirst).toHaveBeenCalledWith({ where: { id: 'nr-1' } })
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
    // Sync called with preserveNamedResourceIds
    expect(syncCapacityProfilesForProject).toHaveBeenCalledWith(tx, 'proj-1', { preserveNamedResourceIds: ['nr-1'] })
  })

  it('PUT calls both upsertNRProfileAndProjectLegacy (profile-first) and sync (role-level fill)', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue({ id: 'proj-1', ownerId: userId } as never)
    vi.mocked(prisma.resourceType.findFirst).mockResolvedValue({ id: 'rt-1', projectId: 'proj-1', allocationMode: 'EFFORT' } as never)
    vi.mocked(prisma.namedResource.findFirst).mockResolvedValue({ id: 'nr-1', resourceTypeId: 'rt-1' } as never)

    const tx = {
      capacityProfile: {
        findMany: vi.fn().mockResolvedValue([]),
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

    // Profile-first write is called
    expect(upsertNRProfileAndProjectLegacy).toHaveBeenCalled()
    // Sync also called to create role-level and other profiles
    expect(syncCapacityProfilesForProject).toHaveBeenCalledWith(tx, 'proj-1', { preserveNamedResourceIds: ['nr-1'] })
  })

  it('DELETE named-resource still calls sync for full project reconciliation', async () => {
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

    // DELETE still uses full sync (profile cleanup)
    expect(syncCapacityProfilesForProject).toHaveBeenCalledWith(tx, 'proj-1')

    // Call order: delete < count < update < sync
    expect(deleteFn.mock.invocationCallOrder[0]).toBeLessThan(
      countFn.mock.invocationCallOrder[0],
    )
    expect(countFn.mock.invocationCallOrder[0]).toBeLessThan(
      updateFn.mock.invocationCallOrder[0],
    )
    expect(updateFn.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(syncCapacityProfilesForProject).mock.invocationCallOrder[0],
    )
  })

  it('DELETE sync failure propagates and route returns error', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue({ id: 'proj-1', ownerId: userId } as never)
    vi.mocked(prisma.resourceType.findFirst).mockResolvedValue({ id: 'rt-1', projectId: 'proj-1', allocationMode: 'EFFORT' } as never)
    vi.mocked(prisma.namedResource.findFirst).mockResolvedValue({ id: 'nr-1', resourceTypeId: 'rt-1' } as never)

    vi.mocked(syncCapacityProfilesForProject).mockRejectedValueOnce(new Error('sync failed'))

    const tx = {
      namedResource: { delete: vi.fn().mockResolvedValue(undefined), count: vi.fn().mockResolvedValue(0) },
      resourceType: { update: vi.fn().mockResolvedValue({ id: 'rt-1' }) },
      project: { update: vi.fn() },
    }
    vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) => fn(tx))

    const res = await request(app)
      .delete('/api/projects/proj-1/resource-types/rt-1/named-resources/nr-1')
      .set('Authorization', authHeader)

    // Sync failure should propagate — not a 204
    expect(res.status).not.toBe(204)
  })

  it('PUT upsertNRProfileAndProjectLegacy failure propagates and route returns error', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue({ id: 'proj-1', ownerId: userId } as never)
    vi.mocked(prisma.resourceType.findFirst).mockResolvedValue({ id: 'rt-1', projectId: 'proj-1', allocationMode: 'EFFORT' } as never)
    vi.mocked(prisma.namedResource.findFirst).mockResolvedValue({ id: 'nr-1', resourceTypeId: 'rt-1' } as never)

    vi.mocked(upsertNRProfileAndProjectLegacy).mockRejectedValueOnce(new Error('profile write failed'))

    const tx = {
      capacityProfile: {
        findMany: vi.fn().mockResolvedValue([]),
      },
      namedResource: { update: vi.fn().mockResolvedValue({ id: 'nr-1' }) },
      project: { update: vi.fn() },
    }
    vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) => fn(tx))

    const res = await request(app)
      .put('/api/projects/proj-1/resource-types/rt-1/named-resources/nr-1')
      .set('Authorization', authHeader)
      .send({ name: 'Updated' })

    // Helper failure should propagate — not a 200
    expect(res.status).not.toBe(200)
  })
})
