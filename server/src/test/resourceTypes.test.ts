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

vi.mock('../lib/resourceTypeCapacityProfileWrites.js', () => ({
  upsertRTProfileAndProjectLegacy: vi.fn().mockImplementation(
    async (_tx: any, _projectId: string, _rtId: string, payload: any) => ({
      allocationMode: payload.allocationMode ?? 'EFFORT',
      allocationPercent: payload.allocationPercent ?? 100,
      allocationStartWeek: null,
      allocationEndWeek: null,
      lossy: false,
    }),
  ),
  buildMissingRTProfilePayload: vi.fn().mockImplementation((existing: any) => ({
    allocationMode: existing.allocationMode ?? 'EFFORT',
    allocationPercent: existing.allocationPercent ?? 100,
    allocationStartWeek: null,
    allocationEndWeek: null,
  })),
}))
process.env.JWT_SECRET = 'test-secret'

const userId = 'user-1'
const token = jwt.sign({ userId }, 'test-secret')
const authHeader = `Bearer ${token}`

beforeEach(() => {
  vi.clearAllMocks()
})

describe('resource type manual scheduling regression', () => {
  it('exits CAPACITY_PLAN when count is manually updated through the resource type route', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue({ id: 'proj-1', ownerId: userId } as never)
    vi.mocked(prisma.resourceType.findFirst).mockResolvedValue({
      id: 'rt-1',
      projectId: 'proj-1',
      allocationMode: 'CAPACITY_PLAN',
      allocationPercent: 25,
      allocationStartWeek: 4,
      allocationEndWeek: 8,
    } as never)
    const tx = {
      capacityProfile: {
        findMany: vi.fn().mockResolvedValue([]),
      },
      resourceType: {
        update: vi.fn().mockResolvedValue({
          id: 'rt-1',
          count: 2,
          allocationMode: 'TIMELINE',
        }),
      },
      namedResource: {
        findMany: vi.fn().mockResolvedValue([]),
        updateMany: vi.fn().mockResolvedValue({ count: 2 }),
      },
      project: {
        update: vi.fn().mockResolvedValue({}),
      },
    }
    vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) => fn(tx))

    const res = await request(app)
      .put('/api/projects/proj-1/resource-types/rt-1')
      .set('Authorization', authHeader)
      .send({ count: 2 })

    expect(res.status).toBe(200)
    expect(tx.resourceType.update).toHaveBeenCalledWith({
      where: { id: 'rt-1' },
      data: {
        count: 2,
        allocationMode: 'TIMELINE',
        allocationPercent: 100,
        allocationStartWeek: null,
        allocationEndWeek: null,
      },
    })
    expect(tx.namedResource.updateMany).toHaveBeenCalledWith({
      where: {
        resourceTypeId: 'rt-1',
        allocationMode: 'CAPACITY_PLAN',
      },
      data: {
        allocationMode: 'TIMELINE',
        allocationPercent: 100,
        allocationStartWeek: null,
        allocationEndWeek: null,
        allocationPct: 100,
        startWeek: null,
        endWeek: null,
      },
    })
  })

  it('preserves explicit allocationMode edits on the resource type route', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue({ id: 'proj-1', ownerId: userId } as never)
    vi.mocked(prisma.resourceType.findFirst).mockResolvedValue({
      id: 'rt-1',
      projectId: 'proj-1',
      allocationMode: 'CAPACITY_PLAN',
    } as never)
    const tx = {
      resourceType: {
        update: vi.fn().mockResolvedValue({
          id: 'rt-1',
          count: 2,
          allocationMode: 'FULL_PROJECT',
          allocationPercent: 50,
        }),
      },
      namedResource: {
        findMany: vi.fn().mockResolvedValue([]),
        updateMany: vi.fn(),
      },
      project: {
        update: vi.fn().mockResolvedValue({}),
      },
    }
    vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) => fn(tx))

    const res = await request(app)
      .put('/api/projects/proj-1/resource-types/rt-1')
      .set('Authorization', authHeader)
      .send({ count: 2, allocationMode: 'FULL_PROJECT', allocationPercent: 50 })

    expect(res.status).toBe(200)
    expect(tx.resourceType.update).toHaveBeenCalledWith({
      where: { id: 'rt-1' },
      data: expect.objectContaining({
        count: 2,
        allocationMode: 'FULL_PROJECT',
        allocationPercent: 50,
      }),
    })
  })

  it('rolls back PUT capacity-plan exit when named-resource updates fail', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue({ id: 'proj-1', ownerId: userId } as never)
    vi.mocked(prisma.resourceType.findFirst).mockResolvedValue({
      id: 'rt-1',
      projectId: 'proj-1',
      allocationMode: 'CAPACITY_PLAN',
      allocationPercent: 25,
      allocationStartWeek: 4,
      allocationEndWeek: 8,
    } as never)
    const committedState = {
      resourceType: {
        id: 'rt-1',
        allocationMode: 'CAPACITY_PLAN',
        allocationPercent: 25,
        allocationStartWeek: 4,
        allocationEndWeek: 8,
        count: 1,
      },
      namedResources: [
        {
          id: 'nr-1',
          allocationMode: 'CAPACITY_PLAN',
          allocationPercent: 25,
        },
      ],
    }
    vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) => {
      const draftState = JSON.parse(JSON.stringify(committedState))
      const tx = {
        capacityProfile: {
          findMany: vi.fn().mockResolvedValue([]),
        },
        resourceType: {
          update: vi.fn(async ({ data }: any) => {
            Object.assign(draftState.resourceType, data)
            return draftState.resourceType
          }),
        },
        namedResource: {
          updateMany: vi.fn(async () => {
            throw new Error('named-resource update failed')
          }),
        },
      }

      const result = await fn(tx)
      Object.assign(committedState.resourceType, draftState.resourceType)
      committedState.namedResources.splice(0, committedState.namedResources.length, ...draftState.namedResources)
      return result
    })

    const res = await request(app)
      .put('/api/projects/proj-1/resource-types/rt-1')
      .set('Authorization', authHeader)
      .send({ count: 2 })

    expect(res.status).toBe(500)
    expect(committedState.resourceType).toMatchObject({
      allocationMode: 'CAPACITY_PLAN',
      allocationPercent: 25,
      allocationStartWeek: 4,
      allocationEndWeek: 8,
      count: 1,
    })
    expect(committedState.namedResources).toEqual([
      expect.objectContaining({
        id: 'nr-1',
        allocationMode: 'CAPACITY_PLAN',
        allocationPercent: 25,
      }),
    ])
  })

  it('rolls back PATCH count sync when capacity-plan exit cannot complete the full operation', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue({ id: 'proj-1', ownerId: userId } as never)
    vi.mocked(prisma.resourceType.findFirst).mockResolvedValue({
      id: 'rt-1',
      projectId: 'proj-1',
      name: 'Developer',
      count: 1,
      allocationMode: 'CAPACITY_PLAN',
      allocationPercent: 25,
      allocationStartWeek: 4,
      allocationEndWeek: 8,
    } as never)
    const committedState = {
      resourceType: {
        id: 'rt-1',
        count: 1,
        allocationMode: 'CAPACITY_PLAN',
        allocationPercent: 25,
        allocationStartWeek: 4,
        allocationEndWeek: 8,
      },
      namedResources: [
        {
          id: 'nr-1',
          name: 'Developer 1',
          resourceTypeId: 'rt-1',
          allocationMode: 'CAPACITY_PLAN',
          allocationPercent: 25,
          allocationPct: 25,
          allocationStartWeek: 4,
          allocationEndWeek: 8,
          startWeek: 4,
          endWeek: 8,
        },
      ],
    }
    vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) => {
      const draftState = JSON.parse(JSON.stringify(committedState))
      const tx = {
        resourceType: {
          update: vi.fn(async ({ data }: any) => {
            Object.assign(draftState.resourceType, data)
            return draftState.resourceType
          }),
        },
        namedResource: {
          findMany: vi.fn(async () => draftState.namedResources),
          updateMany: vi.fn(async ({ data }: any) => {
            draftState.namedResources = draftState.namedResources.map((nr: any) => ({ ...nr, ...data }))
            return { count: draftState.namedResources.length }
          }),
          create: vi.fn(async () => {
            throw new Error('count sync failed')
          }),
          delete: vi.fn(),
        },
      }

      const result = await fn(tx)
      Object.assign(committedState.resourceType, draftState.resourceType)
      committedState.namedResources.splice(0, committedState.namedResources.length, ...draftState.namedResources)
      return result
    })

    const res = await request(app)
      .patch('/api/projects/proj-1/resource-types/rt-1')
      .set('Authorization', authHeader)
      .send({ count: 2 })

    expect(res.status).toBe(500)
    expect(committedState.resourceType).toMatchObject({
      count: 1,
      allocationMode: 'CAPACITY_PLAN',
      allocationPercent: 25,
      allocationStartWeek: 4,
      allocationEndWeek: 8,
    })
    expect(committedState.namedResources).toEqual([
      expect.objectContaining({
        id: 'nr-1',
        allocationMode: 'CAPACITY_PLAN',
        allocationPercent: 25,
        allocationPct: 25,
        allocationStartWeek: 4,
        allocationEndWeek: 8,
        startWeek: 4,
        endWeek: 8,
      }),
    ])
  })

  it('exits CAPACITY_PLAN when a person is manually removed from Resource Profile', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue({ id: 'proj-1', ownerId: userId } as never)
    vi.mocked(prisma.resourceType.findFirst).mockResolvedValue({
      id: 'rt-1',
      projectId: 'proj-1',
      name: 'Developer',
      allocationMode: 'CAPACITY_PLAN',
      allocationPercent: 100,
      allocationStartWeek: null,
      allocationEndWeek: null,
    } as never)
    vi.mocked(prisma.namedResource.findFirst).mockResolvedValue({
      id: 'nr-2',
      resourceTypeId: 'rt-1',
    } as never)
    const exitTx = {
      resourceType: {
        update: vi.fn().mockResolvedValue({ id: 'rt-1', allocationMode: 'TIMELINE' }),
      },
      namedResource: {
        updateMany: vi.fn().mockResolvedValue({ count: 2 }),
        delete: vi.fn().mockResolvedValue({}),
        count: vi.fn().mockResolvedValue(1),
      },
      project: {
        update: vi.fn().mockResolvedValue({}),
      },
    }
    vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) => fn(exitTx))
    vi.mocked(prisma.resourceType.update)
      .mockResolvedValue({ id: 'rt-1', count: 1, allocationMode: 'TIMELINE' } as never)
    vi.mocked(prisma.namedResource.delete).mockResolvedValue({} as never)
    vi.mocked(prisma.namedResource.count).mockResolvedValue(1)

    const res = await request(app)
      .delete('/api/projects/proj-1/resource-types/rt-1/named-resources/nr-2')
      .set('Authorization', authHeader)

    expect(res.status).toBe(204)
    expect(exitTx.resourceType.update).toHaveBeenCalledWith({
      where: { id: 'rt-1' },
      data: {
        allocationMode: 'TIMELINE',
        allocationPercent: 100,
        allocationStartWeek: null,
        allocationEndWeek: null,
      },
    })
    expect(exitTx.namedResource.updateMany).toHaveBeenCalledWith({
      where: {
        resourceTypeId: 'rt-1',
        allocationMode: 'CAPACITY_PLAN',
      },
      data: {
        allocationMode: 'TIMELINE',
        allocationPercent: 100,
        allocationStartWeek: null,
        allocationEndWeek: null,
        allocationPct: 100,
        startWeek: null,
        endWeek: null,
      },
    })
    expect(exitTx.namedResource.delete).toHaveBeenCalledWith({ where: { id: 'nr-2' } })
    expect(exitTx.resourceType.update).toHaveBeenCalledWith({
      where: { id: 'rt-1' },
      data: { count: 1 },
    })
  })
})

describe('DELETE /api/projects/:projectId/resource-types/:id', () => {
  it('deletes a resource type scoped to the project', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue({ id: 'proj-1', ownerId: userId } as never)
    const tx = {
      resourceType: { deleteMany: vi.fn().mockResolvedValue({ count: 1 }) },
      project: { update: vi.fn().mockResolvedValue({}) },
    }
    vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) => fn(tx))

    const res = await request(app)
      .delete('/api/projects/proj-1/resource-types/rt-1')
      .set('Authorization', authHeader)

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ message: 'Deleted' })
    // Delete must be scoped to the project, not a bare primary-key delete
    expect(tx.resourceType.deleteMany).toHaveBeenCalledWith({
      where: { id: 'rt-1', projectId: 'proj-1' },
    })
  })

  it('returns 404 when the resource type belongs to another project (cross-tenant delete)', async () => {
    // Caller owns proj-1, but rt-99 lives in another tenant's project, so the
    // project-scoped deleteMany affects 0 rows.
    vi.mocked(prisma.project.findFirst).mockResolvedValue({ id: 'proj-1', ownerId: userId } as never)
    const tx = {
      resourceType: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
      project: { update: vi.fn() },
    }
    vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) => fn(tx))

    const res = await request(app)
      .delete('/api/projects/proj-1/resource-types/rt-99')
      .set('Authorization', authHeader)

    expect(res.status).toBe(404)
    expect(res.body).toEqual({ error: 'Resource type not found' })
    expect(tx.resourceType.deleteMany).toHaveBeenCalledWith({
      where: { id: 'rt-99', projectId: 'proj-1' },
    })
  })
})

describe('weeklyDemandCache invalidation', () => {

  it('clears cache on POST resource type creation', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue({ id: 'proj-1', ownerId: userId } as never)
    const createdRt = { id: 'rt-new', projectId: 'proj-1', name: 'Tester', category: 'DEV' }
    const tx = {
      resourceType: {
        create: vi.fn().mockResolvedValue(createdRt),
        update: vi.fn().mockResolvedValue({ ...createdRt, count: 1 }),
      },
      namedResource: { create: vi.fn().mockResolvedValue({}) },
      project: { update: vi.fn().mockResolvedValue({}) },
    }
    vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) => fn(tx))

    const res = await request(app)
      .post('/api/projects/proj-1/resource-types')
      .set('Authorization', authHeader)
      .send({ name: 'Tester', category: 'DEV' })

    expect(res.status).toBe(201)
    expect(res.body).toEqual(createdRt)
    // Should create resource type + default named resource + update count + clear cache in one transaction
    expect(tx.resourceType.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ name: 'Tester', category: 'DEV', projectId: 'proj-1' }),
    })
    expect(tx.namedResource.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ name: 'Tester 1', resourceTypeId: 'rt-new' }),
    })
    expect(tx.project.update).toHaveBeenCalledWith({
      where: { id: 'proj-1' },
      data: { weeklyDemandCache: {} },
    })
  })
  it('clears cache on PUT rename', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue({ id: 'proj-1', ownerId: userId } as never)
    vi.mocked(prisma.resourceType.findFirst).mockResolvedValue({
      id: 'rt-1', projectId: 'proj-1', name: 'Old Role',
      allocationMode: 'TIMELINE', allocationPercent: 100,
      allocationStartWeek: null, allocationEndWeek: null,
    } as never)
    const tx = {
      capacityProfile: {
        findMany: vi.fn().mockResolvedValue([]),
      },
      resourceType: { update: vi.fn().mockResolvedValue({ id: 'rt-1', name: 'New Role' }) },
      namedResource: { findMany: vi.fn().mockResolvedValue([]) },
      project: { update: vi.fn().mockResolvedValue({}) },
    }
    vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) => fn(tx))

    const res = await request(app)
      .put('/api/projects/proj-1/resource-types/rt-1')
      .set('Authorization', authHeader)
      .send({ name: 'New Role' })

    expect(res.status).toBe(200)
    expect(tx.resourceType.update).toHaveBeenCalledWith({
      where: { id: 'rt-1' },
      data: { name: 'New Role' },
    })
    expect(tx.project.update).toHaveBeenCalledWith({
      where: { id: 'proj-1' },
      data: { weeklyDemandCache: {} },
    })
  })

  it('clears cache on PATCH count sync', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue({ id: 'proj-1', ownerId: userId } as never)
    vi.mocked(prisma.resourceType.findFirst).mockResolvedValue({
      id: 'rt-1', projectId: 'proj-1', name: 'Developer',
      allocationMode: 'TIMELINE', allocationPercent: 100,
      allocationStartWeek: null, allocationEndWeek: null,
    } as never)
    const tx = {
      namedResource: {
        findMany: vi.fn().mockResolvedValue([]),
        create: vi.fn().mockResolvedValue({}),
      },
      resourceType: { update: vi.fn().mockResolvedValue({ id: 'rt-1', count: 2 }) },
      project: { update: vi.fn().mockResolvedValue({}) },
    }
    vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) => fn(tx))

    const res = await request(app)
      .patch('/api/projects/proj-1/resource-types/rt-1')
      .set('Authorization', authHeader)
      .send({ count: 2 })

    expect(res.status).toBe(200)
    expect(tx.project.update).toHaveBeenCalledWith({
      where: { id: 'proj-1' },
      data: { weeklyDemandCache: {} },
    })
  })

  it('clears cache on DELETE after successful scoped delete', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue({ id: 'proj-1', ownerId: userId } as never)
    const tx = {
      resourceType: { deleteMany: vi.fn().mockResolvedValue({ count: 1 }) },
      project: { update: vi.fn().mockResolvedValue({}) },
    }
    vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) => fn(tx))

    const res = await request(app)
      .delete('/api/projects/proj-1/resource-types/rt-1')
      .set('Authorization', authHeader)

    expect(res.status).toBe(200)
    expect(tx.resourceType.deleteMany).toHaveBeenCalledWith({
      where: { id: 'rt-1', projectId: 'proj-1' },
    })
    expect(tx.project.update).toHaveBeenCalledWith({
      where: { id: 'proj-1' },
      data: { weeklyDemandCache: {} },
    })
  })

  it('does not clear cache when DELETE returns 404 (wrong project)', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue({ id: 'proj-1', ownerId: userId } as never)
    const tx = {
      resourceType: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
      project: { update: vi.fn() },
    }
    vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) => fn(tx))

    const res = await request(app)
      .delete('/api/projects/proj-1/resource-types/rt-99')
      .set('Authorization', authHeader)

    expect(res.status).toBe(404)
    expect(tx.project.update).not.toHaveBeenCalled()
  })
})

describe('named-resource auto-name race safety', () => {
  const rtId = 'rt-1'
  const projectId = 'proj-1'

  beforeEach(() => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue({ id: projectId, ownerId: userId } as never)
    vi.mocked(prisma.resourceType.findFirst).mockResolvedValue({
      id: rtId,
      projectId,
      name: 'Developer',
      allocationMode: 'EFFORT',
      count: 0,
    } as never)
    vi.mocked(prisma.namedResource.count).mockResolvedValue(0)
    let createdName = 'Unknown'
    const mockCreate = vi.fn().mockImplementation(async ({ data }: any) => {
      createdName = data.name
      return { id: 'nr-new', name: data.name, ...data }
    })
    const mockUpdate = vi.fn().mockImplementation(async ({ data }: any) => ({ id: 'nr-new', name: createdName, ...data }))

    vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) =>
      fn({
        namedResource: {
          count: vi.fn().mockResolvedValue(1),
          create: mockCreate,
          update: mockUpdate,
        },
        resourceType: { update: vi.fn().mockResolvedValue({}) },
        project: { update: vi.fn().mockResolvedValue({}) },
        capacityProfile: {
          findMany: vi.fn().mockResolvedValue([]),
          deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
          create: vi.fn().mockResolvedValue({ id: 'cp-new' }),
        },
        capacitySegment: {
          deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        },
      }),
    )
  })

  it('creates a named resource with auto-generated random suffix when name is null', async () => {
    const res = await request(app)
      .post(`/api/projects/${projectId}/resource-types/${rtId}/named-resources`)
      .set('Authorization', authHeader)
      .send({ name: 'New person' })

    expect(res.status).toBe(201)
    expect(res.body.name).toMatch(/^Developer [a-f0-9]{8}$/)
  })

  it('creates a named resource with the provided name when specified', async () => {
    const res = await request(app)
      .post(`/api/projects/${projectId}/resource-types/${rtId}/named-resources`)
      .set('Authorization', authHeader)
      .send({ name: 'Alice' })

    expect(res.status).toBe(201)
    expect(res.body.name).toBe('Alice')
  })

  it('two concurrent generic creates produce distinct names and both succeed', async () => {
    // The old "count + 1" approach would race: both requests read count=0
    // and both create "Developer 1".  The random UUID suffix eliminates the
    // shared-counter race entirely.  This test proves concurrency safety
    // by firing two POSTs simultaneously and asserting both succeed with
    // distinct auto-generated names.
    const [res1, res2] = await Promise.all([
      request(app)
        .post(`/api/projects/${projectId}/resource-types/${rtId}/named-resources`)
        .set('Authorization', authHeader)
        .send({ name: 'New person' }),
      request(app)
        .post(`/api/projects/${projectId}/resource-types/${rtId}/named-resources`)
        .set('Authorization', authHeader)
        .send({ name: 'New person' }),
    ])

    expect(res1.status).toBe(201)
    expect(res2.status).toBe(201)

    const name1: string = res1.body.name
    const name2: string = res2.body.name

    // Both names are "Developer <8-hex-chars>" format
    expect(name1).toMatch(/^Developer [a-f0-9]{8}$/)
    expect(name2).toMatch(/^Developer [a-f0-9]{8}$/)

    // Names are distinct — the random suffix makes collision astronomically
    // unlikely (one in 2^32 ≈ 4 billion).
    expect(name1).not.toBe(name2)
  })
})

describe('capacity profile sync integration', () => {
  beforeEach(() => vi.clearAllMocks())

  it('PUT calls syncCapacityProfilesForProject inside the transaction', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue({ id: 'proj-1', ownerId: userId } as never)
    vi.mocked(prisma.resourceType.findFirst).mockResolvedValue({ id: 'rt-1', projectId: 'proj-1', allocationMode: 'EFFORT' } as never)
    const tx = {
      capacityProfile: {
        findMany: vi.fn().mockResolvedValue([]),
      },
      resourceType: { update: vi.fn().mockResolvedValue({ id: 'rt-1', name: 'Updated' }) },
      namedResource: {
        findMany: vi.fn().mockResolvedValue([]),
        updateMany: vi.fn(),
      },
      project: { update: vi.fn() },
    }
    vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) => fn(tx))

    await request(app)
      .put('/api/projects/proj-1/resource-types/rt-1')
      .set('Authorization', authHeader)
      .send({ name: 'Updated' })

    expect(syncCapacityProfilesForProject).toHaveBeenCalledWith(tx, 'proj-1')
  })

  it('PATCH count increase calls sync after NR creation and count update', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue({ id: 'proj-1', ownerId: userId } as never)
    vi.mocked(prisma.resourceType.findFirst).mockResolvedValue({ id: 'rt-1', projectId: 'proj-1', allocationMode: 'EFFORT', name: 'Engineer', allocationPercent: null, allocationStartWeek: null, allocationEndWeek: null } as never)
    const tx = {
      namedResource: {
        findMany: vi.fn().mockResolvedValue([{ id: 'nr-1' }]),
        create: vi.fn().mockResolvedValue({ id: 'nr-new' }),
      },
      resourceType: { update: vi.fn().mockResolvedValue({ id: 'rt-1', count: 2 }) },
      project: { update: vi.fn() },
    }
    vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) => fn(tx))

    await request(app)
      .patch('/api/projects/proj-1/resource-types/rt-1')
      .set('Authorization', authHeader)
      .send({ count: 2 })

    expect(tx.namedResource.create).toHaveBeenCalled()
    expect(tx.resourceType.update).toHaveBeenCalledWith(expect.objectContaining({ data: { count: 2 } }))
    expect(syncCapacityProfilesForProject).toHaveBeenCalledWith(tx, 'proj-1')
  })

  it('DELETE calls sync inside transaction after scoped delete', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue({ id: 'proj-1', ownerId: userId } as never)
    const tx = {
      resourceType: {
        deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      project: { update: vi.fn() },
    }
    vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) => fn(tx))

    await request(app)
      .delete('/api/projects/proj-1/resource-types/rt-1')
      .set('Authorization', authHeader)

    expect(tx.resourceType.deleteMany).toHaveBeenCalledWith({
      where: { id: 'rt-1', projectId: 'proj-1' },
    })
    const tx = {
      capacityProfile: {
        findMany: vi.fn().mockResolvedValue([]),
      },
      resourceType: { update: vi.fn().mockResolvedValue({ id: 'rt-1', name: 'Updated' }) },
      namedResource: {
        findMany: vi.fn().mockResolvedValue([]),
        updateMany: vi.fn(),
      },
      project: { update: vi.fn() },
    }
    vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) => fn(tx))

    await request(app)
      .put('/api/projects/proj-1/resource-types/rt-1')
      .set('Authorization', authHeader)
      .send({ name: 'Updated' })

    // Must be called with the transaction object, not bare prisma
    expect(syncCapacityProfilesForProject).toHaveBeenCalledWith(tx, 'proj-1')
    expect(syncCapacityProfilesForProject).not.toHaveBeenCalledWith(prisma, 'proj-1')
  })
})
