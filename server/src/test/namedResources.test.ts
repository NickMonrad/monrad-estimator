import { beforeEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { app } from '../index.js'
import { prisma } from '../lib/prisma.js'
import { syncCapacityProfilesForProject } from '../lib/syncCapacityProfiles.js'

vi.mock('../lib/syncCapacityProfiles.js', () => ({
  syncCapacityProfilesForProject: vi.fn().mockResolvedValue({
    profilesCreated: 0,
    profilesUpdated: 0,
    profilesDeleted: 0,
    segmentsCreated: 0,
    segmentsDeleted: 0,
  }),
}))

process.env.JWT_SECRET = 'test-secret'

const userId = 'user-1'
const token = jwt.sign({ userId }, 'test-secret')
const authHeader = `Bearer ${token}`

beforeEach(() => {
  vi.clearAllMocks()
})

describe('named-resource capacity profile sync', () => {
  it('PUT named-resource update calls sync inside the transaction', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue({ id: 'proj-1', ownerId: userId } as never)
    vi.mocked(prisma.resourceType.findFirst).mockResolvedValue({ id: 'rt-1', projectId: 'proj-1', allocationMode: 'EFFORT' } as never)
    vi.mocked(prisma.namedResource.findFirst).mockResolvedValue({ id: 'nr-1', resourceTypeId: 'rt-1' } as never)

    const tx = {
      namedResource: { update: vi.fn().mockResolvedValue({ id: 'nr-1', name: 'Updated' }) },
      project: { update: vi.fn() },
    }
    vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) => fn(tx))

    await request(app)
      .put('/api/projects/proj-1/resource-types/rt-1/named-resources/nr-1')
      .set('Authorization', authHeader)
      .send({ name: 'Updated' })

    expect(syncCapacityProfilesForProject).toHaveBeenCalledWith(tx, 'proj-1')
  })

  it('PATCH named-resource update calls sync inside the transaction', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue({ id: 'proj-1', ownerId: userId } as never)
    vi.mocked(prisma.resourceType.findFirst).mockResolvedValue({ id: 'rt-1', projectId: 'proj-1', allocationMode: 'EFFORT' } as never)
    vi.mocked(prisma.namedResource.findFirst).mockResolvedValue({ id: 'nr-1', resourceTypeId: 'rt-1' } as never)

    const tx = {
      namedResource: { update: vi.fn().mockResolvedValue({ id: 'nr-1' }) },
      project: { update: vi.fn() },
    }
    vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) => fn(tx))

    await request(app)
      .patch('/api/projects/proj-1/resource-types/rt-1/named-resources/nr-1')
      .set('Authorization', authHeader)
      .send({ allocationMode: 'TIMELINE' })

    expect(syncCapacityProfilesForProject).toHaveBeenCalledWith(tx, 'proj-1')
  })

  it('sync is called with tx object, not bare prisma, on PUT', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue({ id: 'proj-1', ownerId: userId } as never)
    vi.mocked(prisma.resourceType.findFirst).mockResolvedValue({ id: 'rt-1', projectId: 'proj-1', allocationMode: 'EFFORT' } as never)
    vi.mocked(prisma.namedResource.findFirst).mockResolvedValue({ id: 'nr-1', resourceTypeId: 'rt-1' } as never)

    const tx = {
      namedResource: { update: vi.fn().mockResolvedValue({ id: 'nr-1', name: 'Updated' }) },
      project: { update: vi.fn() },
    }
    vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) => fn(tx))

    await request(app)
      .put('/api/projects/proj-1/resource-types/rt-1/named-resources/nr-1')
      .set('Authorization', authHeader)
      .send({ name: 'Updated' })

    expect(syncCapacityProfilesForProject).toHaveBeenCalledWith(tx, 'proj-1')
    expect(syncCapacityProfilesForProject).not.toHaveBeenCalledWith(prisma, 'proj-1')
  })

  it('DELETE named-resource calls sync after delete and count update, in correct order', async () => {
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

    // Each operation happened
    expect(deleteFn).toHaveBeenCalledWith({ where: { id: 'nr-1' } })
    expect(countFn).toHaveBeenCalledWith({ where: { resourceTypeId: 'rt-1' } })
    expect(updateFn).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'rt-1' }, data: { count: 0 } }),
    )
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

  it('PUT sync failure propagates and route returns error', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue({ id: 'proj-1', ownerId: userId } as never)
    vi.mocked(prisma.resourceType.findFirst).mockResolvedValue({ id: 'rt-1', projectId: 'proj-1', allocationMode: 'EFFORT' } as never)
    vi.mocked(prisma.namedResource.findFirst).mockResolvedValue({ id: 'nr-1', resourceTypeId: 'rt-1' } as never)

    vi.mocked(syncCapacityProfilesForProject).mockRejectedValueOnce(new Error('sync failed'))

    const tx = {
      namedResource: { update: vi.fn().mockResolvedValue({ id: 'nr-1' }) },
      project: { update: vi.fn() },
    }
    vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) => fn(tx))

    const res = await request(app)
      .put('/api/projects/proj-1/resource-types/rt-1/named-resources/nr-1')
      .set('Authorization', authHeader)
      .send({ name: 'Updated' })

    // Sync failure should propagate — not a 200
    expect(res.status).not.toBe(200)
  })
})
