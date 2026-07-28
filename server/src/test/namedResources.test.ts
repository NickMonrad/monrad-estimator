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

vi.mock('../lib/syncCapacityProfiles.js', () => ({
  syncCapacityProfilesForProject: vi.fn().mockResolvedValue({
    profilesCreated: 0,
    profilesUpdated: 0,
    profilesDeleted: 0,
    segmentsCreated: 0,
    segmentsDeleted: 0,
  }),
}))

import { syncCapacityProfilesForProject } from '../lib/syncCapacityProfiles.js'
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
  const validNRProfile = {
    id: 'cp-nr-1',
    projectId: 'proj-1',
    resourceTypeId: null,
    namedResourceId: 'nr-1',
    ownerKind: 'NAMED_PERSON',
    planningBasis: 'DEMAND_FOLLOWING',
    source: 'FIXED',
    defaultPercent: 100,
    startWeek: null,
    endWeek: null,
    segments: [],
  }

  it('PUT named-resource capacity update uses direct profile writes', async () => {
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
        findMany: vi.fn().mockResolvedValue([validNRProfile]),
        update: vi.fn(),
      },
      capacitySegment: {
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      namedResource: {
        update: vi.fn().mockResolvedValue({ id: 'nr-1', allocationMode: 'TIMELINE', allocationPercent: 80 }),
        findFirst: vi.fn().mockResolvedValue({ id: 'nr-1' }),
      },
      project: { update: vi.fn() },
    }
    vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) => fn(tx))

    await request(app)
      .put('/api/projects/proj-1/resource-types/rt-1/named-resources/nr-1')
      .set('Authorization', authHeader)
      .send({ allocationMode: 'TIMELINE', allocationPercent: 80 })

    // Profile-first write updates the profile directly
    expect(tx.capacityProfile.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'cp-nr-1' },
        data: expect.objectContaining({ defaultPercent: 80 }),
      }),
    )
    expect(tx.namedResource.update).toHaveBeenCalled()
    // Sync is NOT called after #364 cutover
    expect(syncCapacityProfilesForProject).not.toHaveBeenCalled()
  })
  it('PATCH named-resource update uses direct profile writes inside the transaction', async () => {
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
        findMany: vi.fn().mockResolvedValue([validNRProfile]),
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

    // Profile-first write updates the profile directly
    expect(tx.capacityProfile.update).toHaveBeenCalled()
    expect(tx.namedResource.update).toHaveBeenCalled()
    // Sync is NOT called after #364
    expect(syncCapacityProfilesForProject).not.toHaveBeenCalled()
  })
  it('PUT named-resource with existing profile does not call sync', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue({ id: 'proj-1', ownerId: userId } as never)
    vi.mocked(prisma.resourceType.findFirst).mockResolvedValue({ id: 'rt-1', projectId: 'proj-1', allocationMode: 'EFFORT' } as never)
    vi.mocked(prisma.namedResource.findFirst).mockResolvedValue({ id: 'nr-1', resourceTypeId: 'rt-1' } as never)

    const tx = {
      capacityProfile: {
        findMany: vi.fn().mockResolvedValue([validNRProfile]),
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

  it('DELETE succeeds without sync (cascade handles profile cleanup)', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue({ id: 'proj-1', ownerId: userId } as never)
    vi.mocked(prisma.resourceType.findFirst).mockResolvedValue({ id: 'rt-1', projectId: 'proj-1', allocationMode: 'EFFORT' } as never)
    vi.mocked(prisma.namedResource.findFirst).mockResolvedValue({ id: 'nr-1', resourceTypeId: 'rt-1' } as never)

    const deleteFn = vi.fn().mockResolvedValue(undefined)
    const countFn = vi.fn().mockResolvedValue(0)
    const updateFn = vi.fn().mockResolvedValue({ id: 'rt-1' })

    const tx = {
      capacityProfile: {
        findMany: vi.fn().mockImplementation((args: any) => {
          const where = args?.where ?? {}
          // ROLE profile query
          if (where.resourceTypeId === 'rt-1' && where.namedResourceId === null) {
            return Promise.resolve([{
              id: 'cp-role-1', ownerKind: 'ROLE', resourceTypeId: 'rt-1',
              namedResourceId: null, planningBasis: 'AVAILABILITY_WINDOW',
              source: 'AVAILABILITY_WINDOW', defaultPercent: 100,
              startWeek: null, endWeek: null, projectId: 'proj-1', segments: [],
            } as never])
          }
          // NR profile query: match by namedResourceId string
          const nrId = where.namedResourceId
          if (nrId && typeof nrId === 'string' && nrId === 'nr-1') {
            return Promise.resolve([{
              id: 'cp-nr-1', ownerKind: 'NAMED_PERSON', resourceTypeId: null,
              namedResourceId: 'nr-1', planningBasis: 'DEMAND_FOLLOWING',
              source: 'FIXED', defaultPercent: 100,
              startWeek: null, endWeek: null, projectId: 'proj-1', segments: [],
            } as never])
          }
          if (where.namedResourceId?.in?.includes?.('nr-1')) {
            return Promise.resolve([{
              id: 'cp-nr-1', ownerKind: 'NAMED_PERSON', resourceTypeId: null,
              namedResourceId: 'nr-1', planningBasis: 'DEMAND_FOLLOWING',
              source: 'FIXED', defaultPercent: 100,
              startWeek: null, endWeek: null, projectId: 'proj-1', segments: [],
            } as never])
          }
          return Promise.resolve([])
        }),
      },
      namedResource: { delete: deleteFn, count: countFn },
      resourceType: { update: updateFn },
      project: { update: vi.fn() },
    }
    vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) => fn(tx))

    const res = await request(app)
      .delete('/api/projects/proj-1/resource-types/rt-1/named-resources/nr-1')
      .set('Authorization', authHeader)

    console.log('DELETE status:', res.status, 'body:', JSON.stringify(res.body))
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
  const makeNRProfile = (overrides: Record<string, any> = {}) => ({
    id: 'cp-1',
    projectId: 'proj-1',
    resourceTypeId: null,
    namedResourceId: 'nr-1',
    ownerKind: 'NAMED_PERSON',
    planningBasis: 'AVAILABILITY_WINDOW',
    source: 'FIXED',
    defaultPercent: 50,
    startWeek: null,
    endWeek: null,
    segments: [],
    ...overrides,
  })

  async function setupTx(profiles: any[]) {
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
    const tx = {
      capacityProfile: {
        findMany: vi.fn().mockImplementation(() => {
          // `loadAndValidateOwnerProfile` queries with { projectId, namedResourceId, resourceTypeId: null }
          // Return the configured profiles
          return Promise.resolve(profiles)
        }),
        update: vi.fn(),
      },
      capacitySegment: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
      namedResource: {
        update: vi.fn().mockResolvedValue({ id: 'nr-1' }),
        findFirst: vi.fn().mockResolvedValue({ id: 'nr-1', name: 'Updated' }),
      },
      project: { update: vi.fn() },
    }
    vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) => fn(tx))
    return tx
  }

  describe('rejected PUT atomicity', () => {
    it('rejects with 409 for segmented CAPACITY_PROFILE profile', async () => {
      const tx = await setupTx([makeNRProfile({
        planningBasis: 'CAPACITY_PROFILE',
        segments: [{ id: 'cs-1', capacityProfileId: 'cp-1', startWeek: 0, endWeek: 5, capacityPercent: 100, source: 'FIXED' }],
      })])

      const res = await request(app)
        .put('/api/projects/proj-1/resource-types/rt-1/named-resources/nr-1')
        .set('Authorization', authHeader)
        .send({ name: 'Should not persist', pricingModel: 'PRO_RATA', allocationPercent: 75, startWeek: 0, endWeek: 10 })

      expect(res.status).toBe(409)
      expect(res.body.code).toBe('PROFILE_MANAGED_CAPACITY')
      expect(tx.namedResource.update).not.toHaveBeenCalled()
    })

    it('rejects PUT with 409 for CAPACITY_PROFILE with segments', async () => {
      const tx = await setupTx([makeNRProfile({
        planningBasis: 'CAPACITY_PROFILE',
        segments: [{ id: 'cs-1', capacityProfileId: 'cp-1', startWeek: 0, endWeek: 5, capacityPercent: 100, source: 'FIXED' }],
      })])

      const res = await request(app)
        .put('/api/projects/proj-1/resource-types/rt-1/named-resources/nr-1')
        .set('Authorization', authHeader)
        .send({ allocationPercent: 75 })

      expect(res.status).toBe(409)
      expect(res.body.code).toBe('PROFILE_MANAGED_CAPACITY')
      expect(tx.namedResource.update).not.toHaveBeenCalled()
    })
  })
  describe('rejected PATCH contract', () => {
    it('rejects PATCH with 409 for segmented CAPACITY_PROFILE profile', async () => {
      const tx = await setupTx([makeNRProfile({
        planningBasis: 'CAPACITY_PROFILE',
        segments: [{ id: 'cs-1', capacityProfileId: 'cp-1', startWeek: 0, endWeek: 5, capacityPercent: 100, source: 'FIXED' }],
      })])

      const res = await request(app)
        .patch('/api/projects/proj-1/resource-types/rt-1/named-resources/nr-1')
        .set('Authorization', authHeader)
        .send({ allocationPercent: 75 })

      expect(res.status).toBe(409)
      expect(res.body.code).toBe('PROFILE_MANAGED_CAPACITY')
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
        capacitySegment: { deleteMany: vi.fn() },
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

      expect(res.status).toBe(500)
    })
  })

  describe('safe non-capacity requests', () => {
    it('allows name-only PUT for segmented CAPACITY_PROFILE profile (changes only name, preserves profile)', async () => {
      const tx = await setupTx([makeNRProfile({
        planningBasis: 'CAPACITY_PROFILE',
        segments: [{ id: 'cs-1', capacityProfileId: 'cp-1', startWeek: 0, endWeek: 5, capacityPercent: 100, source: 'FIXED' }],
      })])

      const res = await request(app)
        .put('/api/projects/proj-1/resource-types/rt-1/named-resources/nr-1')
        .set('Authorization', authHeader)
        .send({ name: 'New Name' })

      expect(res.status).toBe(200)
      expect(tx.namedResource.update).toHaveBeenCalled()
    })

    it('allows pricing-only PUT for segmented CAPACITY_PROFILE profile (changes only pricing)', async () => {
      const tx = await setupTx([makeNRProfile({
        planningBasis: 'CAPACITY_PROFILE',
        segments: [{ id: 'cs-1', capacityProfileId: 'cp-1', startWeek: 0, endWeek: 5, capacityPercent: 100, source: 'FIXED' }],
      })])

      const res = await request(app)
        .put('/api/projects/proj-1/resource-types/rt-1/named-resources/nr-1')
        .set('Authorization', authHeader)
        .send({ pricingModel: 'PRO_RATA' })

      expect(res.status).toBe(200)
      expect(tx.namedResource.update).toHaveBeenCalled()
    })
  it('PATCH applies allocationPct-only updates to the authoritative profile', async () => {
    const tx = await setupTx([makeNRProfile({ defaultPercent: 25 })])

    const res = await request(app)
      .patch('/api/projects/proj-1/resource-types/rt-1/named-resources/nr-1')
      .set('Authorization', authHeader)
      .send({ allocationPct: 40 })

    expect(res.status).toBe(200)
    expect(tx.capacityProfile.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'cp-1' },
        data: expect.objectContaining({ defaultPercent: 40 }),
      }),
    )
    expect(tx.namedResource.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          allocationPercent: 40,
          allocationPct: 40,
        }),
      }),
    )
  })

  it.each(['ACTUAL_DAYS', 'PRO_RATA'])('accepts PUT pricing model %s', async pricingModel => {
    const tx = await setupTx([makeNRProfile()])

    const res = await request(app)
      .put('/api/projects/proj-1/resource-types/rt-1/named-resources/nr-1')
      .set('Authorization', authHeader)
      .send({ pricingModel })

    expect(res.status).toBe(200)
    expect(tx.namedResource.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ pricingModel }) }),
    )
  })

  it('rejects unsupported PUT pricing models before any transaction write', async () => {
    const tx = await setupTx([makeNRProfile()])

    const res = await request(app)
      .put('/api/projects/proj-1/resource-types/rt-1/named-resources/nr-1')
      .set('Authorization', authHeader)
      .send({ pricingModel: 'MONTHLY' })

    expect(res.status).toBe(400)
    expect(tx.capacityProfile.update).not.toHaveBeenCalled()
    expect(tx.namedResource.update).not.toHaveBeenCalled()
    expect(tx.project.update).not.toHaveBeenCalled()
  })

  it('rejects scalar PUT updates for PLANNED_RESOURCE profiles', async () => {
    const tx = await setupTx([makeNRProfile({ ownerKind: 'PLANNED_RESOURCE' })])

    const res = await request(app)
      .put('/api/projects/proj-1/resource-types/rt-1/named-resources/nr-1')
      .set('Authorization', authHeader)
      .send({ allocationPercent: 40 })

    expect(res.status).toBe(409)
    expect(res.body.code).toBe('PROFILE_MANAGED_CAPACITY')
    expect(tx.capacityProfile.update).not.toHaveBeenCalled()
    expect(tx.namedResource.update).not.toHaveBeenCalled()
    expect(tx.project.update).not.toHaveBeenCalled()
  })
  })
})

