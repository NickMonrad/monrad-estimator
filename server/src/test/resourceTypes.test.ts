import { beforeEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { app } from '../index.js'
import { prisma } from '../lib/prisma.js'

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
      namedResource: {
        updateMany: vi.fn().mockResolvedValue({ count: 2 }),
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
        updateMany: vi.fn(),
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
      },
    })
    expect(tx.namedResource.updateMany).not.toHaveBeenCalled()
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
    expect(prisma.resourceType.update).toHaveBeenCalledWith({
      where: { id: 'rt-1' },
      data: { count: 1 },
    })
  })
})
