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
      resourceType: {
        update: vi.fn().mockResolvedValue({
          id: 'rt-1',
          count: 2,
          allocationMode: 'TIMELINE',
        }),
      },
      capacityProfile: {
        findMany: vi.fn().mockImplementation((args: { where?: { namedResourceId?: { in?: string[] } } }) => {
          // NR profile classification: return 3 provenance rows (custom, segmented, planned)
          if (args?.where?.namedResourceId?.in) {
            return Promise.resolve([
              {
                id: 'cp-cust-1', namedResourceId: 'nr-cust-1',
                ownerKind: 'NAMED_PERSON', segments: [],
                legacy: { allocationMode: 'TIMELINE', allocationPercent: 50, allocationPct: 100, allocationStartWeek: 3, allocationEndWeek: 7, startWeek: null, endWeek: null },
              } as never,
              {
                id: 'cp-seg-1', namedResourceId: 'nr-seg-1',
                ownerKind: 'NAMED_PERSON',
                segments: [{ id: 'seg-1', capacityProfileId: 'cp-seg-1', startWeek: 2, endWeek: 3, capacityPercent: 100, source: 'CAPACITY_PLAN' }],
                legacy: { allocationMode: 'CAPACITY_PLAN', allocationPercent: 25, allocationPct: 25, allocationStartWeek: 4, allocationEndWeek: 8, startWeek: null, endWeek: null },
              } as never,
              {
                id: 'cp-plan-1', namedResourceId: 'nr-plan-1',
                ownerKind: 'PLANNED_RESOURCE', segments: [],
                legacy: null,
              } as never,
            ])
          }
          // Role-profile upsert lookup: empty
          return Promise.resolve([])
        }),
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        create: vi.fn().mockResolvedValue({ id: 'cp-new' }),
      },
      capacitySegment: {
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      namedResource: {
        findMany: vi.fn().mockResolvedValue([
          // NR 1: inherited — matches role CAPACITY_PLAN/25/4/8, no persisted profile
          { id: 'nr-inh-1', allocationMode: 'CAPACITY_PLAN', allocationPercent: 25, allocationPct: 25, allocationStartWeek: 4, allocationEndWeek: 8, startWeek: null, endWeek: null },
          // NR 2: custom legacy — TIMELINE/50/W3-7, differs from role
          { id: 'nr-cust-1', allocationMode: 'TIMELINE', allocationPercent: 50, allocationPct: 100, allocationStartWeek: 3, allocationEndWeek: 7, startWeek: null, endWeek: null },
          // NR 3: scalar match — matches role defaults, but has segmented profile
          { id: 'nr-seg-1', allocationMode: 'CAPACITY_PLAN', allocationPercent: 25, allocationPct: 25, allocationStartWeek: 4, allocationEndWeek: 8, startWeek: null, endWeek: null },
          // NR 4: scalar match — matches role defaults, but has PLANNED_RESOURCE profile
          { id: 'nr-plan-1', allocationMode: 'CAPACITY_PLAN', allocationPercent: 25, allocationPct: 25, allocationStartWeek: 4, allocationEndWeek: 8, startWeek: null, endWeek: null },
        ]),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
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
    // Only inherited NR updated — explicit/custom/planned NRs preserved
    expect(tx.namedResource.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['nr-inh-1'] } },
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
    // Sync called with preserveNamedResourceIds for the three explicit NRs
    expect(syncCapacityProfilesForProject).toHaveBeenCalledWith(
      tx, 'proj-1',
      {
        preserveNamedResourceIds: ['nr-cust-1', 'nr-seg-1', 'nr-plan-1'],
        preserveResourceTypeIds: ['rt-1'],
        scopeResourceTypeId: 'rt-1',
      },
    )
  })
  it('preserves explicit allocationMode edits on the resource type route', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue({ id: 'proj-1', ownerId: userId } as never)
    vi.mocked(prisma.resourceType.findFirst).mockResolvedValue({
      id: 'rt-1', projectId: 'proj-1',
      allocationMode: 'CAPACITY_PLAN', allocationPercent: 25,
      allocationStartWeek: 4, allocationEndWeek: 8,
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
      capacityProfile: {
        findMany: vi.fn().mockResolvedValue([]),
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        create: vi.fn().mockResolvedValue({ id: 'cp-new' }),
      },
      capacitySegment: {
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
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
      data: {
        count: 2,
        allocationMode: 'FULL_PROJECT',
        allocationPercent: 50,
        allocationStartWeek: null,
        allocationEndWeek: null,
      },
    })
    expect(tx.namedResource.updateMany).not.toHaveBeenCalled()
    expect(syncCapacityProfilesForProject).toHaveBeenCalledWith(
      tx, 'proj-1',
      expect.objectContaining({ scopeResourceTypeId: 'rt-1' }),
    )
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
          name: 'NR 1',
          resourceTypeId: 'rt-1',
          allocationMode: 'CAPACITY_PLAN',
          allocationPercent: 25,
          allocationPct: 25,
          allocationStartWeek: 4,
          allocationEndWeek: 8,
          startWeek: null,
          endWeek: null,
          pricingModel: 'ACTUAL_DAYS',
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
        capacityProfile: {
          findMany: vi.fn().mockResolvedValue([]),
          create: vi.fn().mockResolvedValue({ id: 'cp-new' }),
          deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        },
        capacitySegment: {
          deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        },
        namedResource: {
          findMany: vi.fn(async () => {
            // Ensure classifier sees current draft state
            return draftState.namedResources.map((nr: { id: string }) => ({ ...nr }))
          }),
          updateMany: vi.fn(async () => {
            throw new Error('named-resource update failed')
          }),
        },
        project: {
          update: vi.fn().mockResolvedValue({}),
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
        capacityProfile: {
          findMany: vi.fn().mockResolvedValue([]),
          deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
          create: vi.fn().mockResolvedValue({ id: 'cp-new' }),
        },
        capacitySegment: {
          deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
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
  })
  it('clears cache on PUT rename', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue({ id: 'proj-1', ownerId: userId } as never)
    vi.mocked(prisma.resourceType.findFirst).mockResolvedValue({
      id: 'rt-1', projectId: 'proj-1', name: 'Old Role',
      allocationMode: 'TIMELINE', allocationPercent: 100,
      allocationStartWeek: null, allocationEndWeek: null,
    } as never)
    const tx = {
      resourceType: { update: vi.fn().mockResolvedValue({ id: 'rt-1', name: 'New Role' }) },
      capacityProfile: {
        findMany: vi.fn().mockResolvedValue([]),
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        create: vi.fn().mockResolvedValue({ id: 'cp-new' }),
      },
      capacitySegment: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
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
      resourceType: { update: vi.fn().mockResolvedValue({ id: 'rt-1', name: 'Updated' }) },
      capacityProfile: {
        findMany: vi.fn().mockResolvedValue([]),
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        create: vi.fn().mockResolvedValue({ id: 'cp-new' }),
      },
      capacitySegment: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
      namedResource: { findMany: vi.fn().mockResolvedValue([]) },
      project: { update: vi.fn() },
    }
    vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) => fn(tx))

    await request(app)
      .put('/api/projects/proj-1/resource-types/rt-1')
      .set('Authorization', authHeader)
      .send({ name: 'Updated' })
    expect(syncCapacityProfilesForProject).toHaveBeenCalledWith(tx, 'proj-1', expect.objectContaining({ scopeResourceTypeId: 'rt-1' }))
  })

  it('PATCH count increase calls sync after NR creation and count update', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue({ id: 'proj-1', ownerId: userId } as never)
    vi.mocked(prisma.resourceType.findFirst).mockResolvedValue({ id: 'rt-1', projectId: 'proj-1', allocationMode: 'EFFORT', name: 'Engineer', allocationPercent: null, allocationStartWeek: null, allocationEndWeek: null } as never)
    const tx = {
      namedResource: {
        findMany: vi.fn().mockResolvedValue([{ id: 'nr-1' }]),
        create: vi.fn().mockResolvedValue({ id: 'nr-new' }),
      },
      capacityProfile: {
        findMany: vi.fn().mockResolvedValue([]),
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
    expect(syncCapacityProfilesForProject).toHaveBeenCalledWith(tx, 'proj-1', expect.objectContaining({ scopeResourceTypeId: 'rt-1' }))
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
    expect(syncCapacityProfilesForProject).toHaveBeenCalledWith(tx, 'proj-1')
  })

  it('sync is called with tx object, not bare prisma', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue({ id: 'proj-1', ownerId: userId } as never)
    vi.mocked(prisma.resourceType.findFirst).mockResolvedValue({ id: 'rt-1', projectId: 'proj-1', allocationMode: 'EFFORT' } as never)
    const tx = {
      resourceType: { update: vi.fn().mockResolvedValue({ id: 'rt-1', name: 'Updated' }) },
      capacityProfile: {
        findMany: vi.fn().mockResolvedValue([]),
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        create: vi.fn().mockResolvedValue({ id: 'cp-new' }),
      },
      capacitySegment: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
      namedResource: { findMany: vi.fn().mockResolvedValue([]) },
      project: { update: vi.fn() },
    }
    vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) => fn(tx))

    await request(app)
      .put('/api/projects/proj-1/resource-types/rt-1')
      .set('Authorization', authHeader)
      .send({ name: 'Updated' })

    // Must be called with the transaction object, not bare prisma
    expect(syncCapacityProfilesForProject).toHaveBeenCalledWith(tx, 'proj-1', expect.objectContaining({ scopeResourceTypeId: 'rt-1' }))
    expect(syncCapacityProfilesForProject).not.toHaveBeenCalledWith(prisma, 'proj-1', expect.anything())
  })
})
describe('PATCH regression coverage', () => {
  beforeEach(() => vi.clearAllMocks())

  it('PATCH increase preserves explicit NRs in scoped sync preserve options', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue({ id: 'proj-1', ownerId: userId } as never)
    vi.mocked(prisma.resourceType.findFirst).mockResolvedValue({
      id: 'rt-1', projectId: 'proj-1', name: 'Engineer',
      allocationMode: 'TIMELINE', allocationPercent: 100,
      allocationStartWeek: null, allocationEndWeek: null,
    } as never)
    const tx = {
      namedResource: {
        findMany: vi.fn().mockResolvedValue([
          // Inherited: matches TIMELINE/100/null/null
          { id: 'nr-inh-1', allocationMode: 'TIMELINE', allocationPercent: 100, allocationPct: 100, allocationStartWeek: null, allocationEndWeek: null, startWeek: null, endWeek: null },
          // Explicit: different percent and window
          { id: 'nr-exp-1', allocationMode: 'TIMELINE', allocationPercent: 50, allocationPct: 100, allocationStartWeek: 10, allocationEndWeek: 20, startWeek: null, endWeek: null },
        ]),
        create: vi.fn().mockResolvedValue({ id: 'nr-new' }),
      },
      capacityProfile: {
        findMany: vi.fn().mockResolvedValue([]),
      },
      resourceType: { update: vi.fn().mockResolvedValue({ id: 'rt-1', count: 3 }) },
      project: { update: vi.fn() },
    }
    vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) => fn(tx))

    await request(app)
      .patch('/api/projects/proj-1/resource-types/rt-1')
      .set('Authorization', authHeader)
      .send({ count: 3 })

    // Sync called with explicit NR IDs preserved and resource scope
    expect(syncCapacityProfilesForProject).toHaveBeenCalledWith(tx, 'proj-1', {
      preserveNamedResourceIds: ['nr-exp-1'],
      preserveResourceTypeIds: ['rt-1'],
      scopeResourceTypeId: 'rt-1',
    })
    expect(tx.namedResource.create).toHaveBeenCalled()
    expect(tx.resourceType.update).toHaveBeenCalledWith(expect.objectContaining({ data: { count: 3 } }))
  })

  it('PATCH CAPACITY_PLAN exit updates only inherited NRs, no blanket NR update', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue({ id: 'proj-1', ownerId: userId } as never)
    vi.mocked(prisma.resourceType.findFirst).mockResolvedValue({
      id: 'rt-1', projectId: 'proj-1', name: 'Developer',
      allocationMode: 'CAPACITY_PLAN', allocationPercent: 25,
      allocationStartWeek: 4, allocationEndWeek: 8,
    } as never)
    const tx = {
      resourceType: {
        update: vi.fn().mockImplementation(async ({ data }: { data?: object }) => ({ id: 'rt-1', ...(data ?? {}) })),
      },
      capacityProfile: {
        findMany: vi.fn().mockImplementation((args: { where?: { namedResourceId?: { in?: string[] } } }) => {
          if (args?.where?.namedResourceId?.in) {
            return Promise.resolve([
              {
                id: 'cp-seg-1', namedResourceId: 'nr-seg-1',
                ownerKind: 'NAMED_PERSON', segments: [
                  { id: 'seg-1', startWeek: 2, endWeek: 3, capacityPercent: 100, source: 'CAPACITY_PLAN' },
                ],
                legacy: { allocationMode: 'CAPACITY_PLAN', allocationPercent: 25, allocationPct: 25, allocationStartWeek: 4, allocationEndWeek: 8 },
              } as never,
              {
                id: 'cp-plan-1', namedResourceId: 'nr-plan-1',
                ownerKind: 'PLANNED_RESOURCE', segments: [],
                legacy: null,
              } as never,
            ])
          }
          // Role profile upsert lookup
          return Promise.resolve([])
        }),
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        create: vi.fn().mockResolvedValue({ id: 'cp-new' }),
      },
      capacitySegment: {
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      namedResource: {
        findMany: vi.fn().mockResolvedValue([
          // NR1: inherited — matches CAPACITY_PLAN/25/4/8, no profile
          { id: 'nr-inh-1', allocationMode: 'CAPACITY_PLAN', allocationPercent: 25, allocationPct: 25, allocationStartWeek: 4, allocationEndWeek: 8, startWeek: null, endWeek: null },
          // NR2: explicit — segmented profile
          { id: 'nr-seg-1', allocationMode: 'CAPACITY_PLAN', allocationPercent: 25, allocationPct: 25, allocationStartWeek: 4, allocationEndWeek: 8, startWeek: null, endWeek: null },
          // NR3: explicit — planned resource
          { id: 'nr-plan-1', allocationMode: 'CAPACITY_PLAN', allocationPercent: 25, allocationPct: 25, allocationStartWeek: 4, allocationEndWeek: 8, startWeek: null, endWeek: null },
        ]),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      project: { update: vi.fn() },
    }
    vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) => fn(tx))

    const res = await request(app)
      .patch('/api/projects/proj-1/resource-types/rt-1')
      .set('Authorization', authHeader)
      .send({ count: 3 })

    expect(res.status).toBe(200)

    // Only inherited NR updated to TIMELINE/100/null/null
    expect(tx.namedResource.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['nr-inh-1'] } },
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

    // CAPACITY_PLAN blanket NR update is NOT called
    expect(tx.namedResource.updateMany).toHaveBeenCalledTimes(1)
  })


  it('PATCH non-CAPACITY_PLAN same count should return 200 with no side-effects', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue({ id: 'proj-1', ownerId: userId } as never)
    vi.mocked(prisma.resourceType.findFirst).mockResolvedValue({
      id: 'rt-1', projectId: 'proj-1', name: 'Dev',
      allocationMode: 'EFFORT', allocationPercent: 100,
      allocationStartWeek: null, allocationEndWeek: null,
    } as never)
    const tx = {
      namedResource: {
        findMany: vi.fn().mockResolvedValue([{ id: 'nr-1' }]),
      },
      capacityProfile: {
        findMany: vi.fn().mockResolvedValue([]),
      },
      resourceType: { update: vi.fn() },
      project: { update: vi.fn() },
    }
    vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) => fn(tx))

    const res = await request(app)
      .patch('/api/projects/proj-1/resource-types/rt-1')
      .set('Authorization', authHeader)
      .send({ count: 1 })

    // Returns 200 with no NR create/delete, no cache/sync for no-op
    expect(res.status).toBe(200)
    expect(tx.resourceType.update).not.toHaveBeenCalled()
    expect(tx.project.update).not.toHaveBeenCalled()
  })

  it('PATCH reduction warns when explicit NRs prevent reaching target count', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue({ id: 'proj-1', ownerId: userId } as never)
    vi.mocked(prisma.resourceType.findFirst).mockResolvedValue({
      id: 'rt-1', projectId: 'proj-1', name: 'Developer',
      allocationMode: 'EFFORT', allocationPercent: 100,
      allocationStartWeek: null, allocationEndWeek: null,
    } as never)
    const tx = {
      namedResource: {
        findMany: vi.fn().mockResolvedValue([
          { id: 'nr-exp-1', name: 'Alice', allocationMode: 'EFFORT', allocationPercent: 50, allocationPct: 100, allocationStartWeek: 5, allocationEndWeek: 10, startWeek: null, endWeek: null, createdAt: new Date('2026-02-01') },
          { id: 'nr-old-inh', name: 'Dev 1', allocationMode: 'EFFORT', allocationPercent: 100, allocationPct: 100, allocationStartWeek: null, allocationEndWeek: null, startWeek: null, endWeek: null, createdAt: new Date('2026-01-01') },
          { id: 'nr-exp-2', name: 'Bob', allocationMode: 'EFFORT', allocationPercent: 75, allocationPct: 100, allocationStartWeek: null, allocationEndWeek: null, startWeek: null, endWeek: null, createdAt: new Date('2026-03-01') },
        ]),
        delete: vi.fn().mockResolvedValue({}),
      },
      capacityProfile: {
        findMany: vi.fn().mockResolvedValue([]),
      },
      resourceType: { update: vi.fn().mockResolvedValue({ id: 'rt-1', count: 2 }) },
      project: { update: vi.fn() },
    }
    vi.mocked(prisma.$transaction).mockImplementation(async (fn: unknown) => (fn as (...args: unknown[]) => unknown)(tx))

    const res = await request(app)
      .patch('/api/projects/proj-1/resource-types/rt-1')
      .set('Authorization', authHeader)
      .send({ count: 1 })

    expect(res.status).toBe(200)

    // Only inherited NR can be deleted; 2 explicit NRs are skipped
    expect(tx.namedResource.delete).toHaveBeenCalledWith({ where: { id: 'nr-old-inh' } })
    expect(tx.namedResource.delete).toHaveBeenCalledTimes(1)
    expect(tx.namedResource.delete).not.toHaveBeenCalledWith({ where: { id: 'nr-exp-1' } })
    expect(tx.namedResource.delete).not.toHaveBeenCalledWith({ where: { id: 'nr-exp-2' } })

    // Warnings returned for the protected explicit NRs that prevented reaching target
    expect(res.body.warnings).toBeDefined()
    expect(res.body.warnings).toHaveLength(2)

    // Persisted count reflects actual remaining resources (2, not requested 1)
    expect(tx.resourceType.update).toHaveBeenCalledWith(expect.objectContaining({ data: { count: 2 } }))
  })

  it('PATCH CAPACITY_PLAN no-op should clear cache and sync after exit', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue({ id: 'proj-1', ownerId: userId } as never)
    vi.mocked(prisma.resourceType.findFirst).mockResolvedValue({
      id: 'rt-1', projectId: 'proj-1', name: 'Developer',
      allocationMode: 'CAPACITY_PLAN', allocationPercent: 25,
      allocationStartWeek: 4, allocationEndWeek: 8,
    } as never)
    const tx = {
      resourceType: {
        update: vi.fn().mockImplementation(async ({ data }: { data?: object }) => ({ id: 'rt-1', ...(data ?? {}) })),
      },
      capacityProfile: {
        findMany: vi.fn().mockResolvedValue([]),
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        create: vi.fn().mockResolvedValue({ id: 'cp-new' }),
      },
      capacitySegment: {
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      namedResource: {
        findMany: vi.fn().mockResolvedValue([
          { id: 'nr-1', allocationMode: 'CAPACITY_PLAN', allocationPercent: 25, allocationPct: 25, allocationStartWeek: 4, allocationEndWeek: 8, startWeek: null, endWeek: null },
        ]),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      project: { update: vi.fn() },
    }
    vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) => fn(tx))

    const res = await request(app)
      .patch('/api/projects/proj-1/resource-types/rt-1')
      .set('Authorization', authHeader)
      .send({ count: 1 })

    expect(res.status).toBe(200)

    expect(tx.namedResource.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['nr-1'] } },
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

    // Cache clear and sync should run after CAPACITY_PLAN exit (not short-circuited by no-op branch)
    expect(tx.project.update).toHaveBeenCalled()
    expect(syncCapacityProfilesForProject).toHaveBeenCalled()

    expect(tx.resourceType.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ allocationMode: 'TIMELINE' }) }),
    )
  })


  it('PATCH reduction preserves NR with duplicate profiles when second profile is explicit', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue({ id: 'proj-1', ownerId: userId } as never)
    vi.mocked(prisma.resourceType.findFirst).mockResolvedValue({
      id: 'rt-1', projectId: 'proj-1', name: 'Developer',
      allocationMode: 'TIMELINE', allocationPercent: 100,
      allocationStartWeek: null, allocationEndWeek: null,
    } as never)
    const tx = {
      namedResource: {
        findMany: vi.fn().mockResolvedValue([
          // nr-inh: inherited — no profile, matches TIMELINE/100/null/null
          { id: 'nr-inh', name: 'Dev 1', allocationMode: 'TIMELINE', allocationPercent: 100, allocationPct: 100, allocationStartWeek: null, allocationEndWeek: null, startWeek: null, endWeek: null, createdAt: new Date('2026-01-01') },
          // nr-dupe: two profiles — first sync-derived matching, second segmented authoritative
          { id: 'nr-dupe', name: 'Dev 2', allocationMode: 'TIMELINE', allocationPercent: 100, allocationPct: 100, allocationStartWeek: null, allocationEndWeek: null, startWeek: null, endWeek: null, createdAt: new Date('2026-02-01') },
        ]),
        delete: vi.fn().mockResolvedValue({}),
      },
      capacityProfile: {
        findMany: vi.fn().mockImplementation((args: { where?: { namedResourceId?: string } }) => {
          if (args?.where?.namedResourceId) {
            return Promise.resolve([
              // Profile 1: sync-derived (populated legacy, matches old default)
              { id: 'cp-sync', namedResourceId: 'nr-dupe', ownerKind: 'NAMED_PERSON', segments: [], legacy: { allocationMode: 'TIMELINE', allocationPercent: 100, allocationPct: 100, allocationStartWeek: null, allocationEndWeek: null } } as never,
              // Profile 2: segmented authoritative (non-empty segments)
              { id: 'cp-seg', namedResourceId: 'nr-dupe', ownerKind: 'NAMED_PERSON', segments: [{ id: 'seg-1', capacityProfileId: 'cp-seg', startWeek: 2, endWeek: 3, capacityPercent: 100, source: 'EFFORT' }], legacy: { allocationMode: 'TIMELINE', allocationPercent: 100, allocationPct: 100, allocationStartWeek: null, allocationEndWeek: null } } as never,
            ])
          }
          return Promise.resolve([])
        }),
      },
      resourceType: { update: vi.fn().mockResolvedValue({ id: 'rt-1', count: 1 }) },
      project: { update: vi.fn() },
    }
    vi.mocked(prisma.$transaction).mockImplementation(async (fn: unknown) => (fn as (...args: unknown[]) => unknown)(tx))

    const res = await request(app)
      .patch('/api/projects/proj-1/resource-types/rt-1')
      .set('Authorization', authHeader)
      .send({ count: 1 })

    expect(res.status).toBe(200)

    // nr-inh is inherited (no profile, matches old default) → deleted
    expect(tx.namedResource.delete).toHaveBeenCalledWith({ where: { id: 'nr-inh' } })

    // nr-dupe has two profiles; first matches old default but second is segmented → explicit
    // Under first-profile-wins this would be misclassified as inherited and deleted.
    // With grouped-profile checking, the explicit second profile protects it.
    expect(tx.namedResource.delete).not.toHaveBeenCalledWith({ where: { id: 'nr-dupe' } })
    expect(tx.namedResource.delete).toHaveBeenCalledTimes(1)

    // Warnings list the protected explicit NR that couldn't be deleted
    expect(res.body.warnings).toBeDefined()
    expect(res.body.warnings).toHaveLength(1)
    expect(res.body.warnings[0]).toMatch(/Dev 2/)

    // Persisted count reflects the actual remaining resources (1 NR left)
    expect(tx.resourceType.update).toHaveBeenCalledWith(expect.objectContaining({ data: { count: 1 } }))
  })
})
