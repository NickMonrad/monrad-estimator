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

  it('PUT with legacy capacity fields is rejected with 400 before any write', async () => {
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

    const res = await request(app)
      .put('/api/projects/proj-1/resource-types/rt-1/named-resources/nr-1')
      .set('Authorization', authHeader)
      .send({ allocationMode: 'TIMELINE', allocationPercent: 80 })

    // Legacy capacity request fields are rejected before the transaction runs
    expect(res.status).toBe(400)
    expect(res.body.rejectedFields).toEqual(['allocationMode', 'allocationPercent'])
    expect(res.body.error).toContain('capacity-profiles/:ownerKind/:ownerId')
    expect(tx.capacityProfile.update).not.toHaveBeenCalled()
    expect(tx.namedResource.update).not.toHaveBeenCalled()
    expect(tx.project.update).not.toHaveBeenCalled()
    // Sync is NOT called after #364 cutover
  })
  it('PATCH named-resource route is rejection-only — structured 400 for capacity fields, 405 otherwise', async () => {
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

    // Legacy capacity field → structured 400, no write, no transaction
    const res = await request(app)
      .patch('/api/projects/proj-1/resource-types/rt-1/named-resources/nr-1')
      .set('Authorization', authHeader)
      .send({ allocationMode: 'TIMELINE' })

    expect(res.status).toBe(400)
    expect(res.body.rejectedFields).toEqual(['allocationMode'])
    expect(res.body.error).toContain('capacity-profiles/:ownerKind/:ownerId')
    expect(tx.capacityProfile.update).not.toHaveBeenCalled()
    expect(tx.namedResource.update).not.toHaveBeenCalled()
    expect(prisma.$transaction).not.toHaveBeenCalled()
    // Sync is NOT called after #364

    // No legacy field → method/contract error, still no mutation path
    const noField = await request(app)
      .patch('/api/projects/proj-1/resource-types/rt-1/named-resources/nr-1')
      .set('Authorization', authHeader)
      .send({ name: 'ignored' })

    expect(noField.status).toBe(405)
    expect(prisma.$transaction).not.toHaveBeenCalled()
    expect(tx.namedResource.update).not.toHaveBeenCalled()
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
    it('rejects legacy capacity fields on a segmented profile with 400, no write', async () => {
      const tx = await setupTx([makeNRProfile({
        planningBasis: 'CAPACITY_PROFILE',
        segments: [{ id: 'cs-1', capacityProfileId: 'cp-1', startWeek: 0, endWeek: 5, capacityPercent: 100, source: 'FIXED' }],
      })])

      const res = await request(app)
        .put('/api/projects/proj-1/resource-types/rt-1/named-resources/nr-1')
        .set('Authorization', authHeader)
        .send({ name: 'Should not persist', pricingModel: 'PRO_RATA', allocationPercent: 75, startWeek: 0, endWeek: 10 })

      // The capacity fields are rejected as legacy request fields — no 409
      // guard is ever reached because the request never enters the transaction
      expect(res.status).toBe(400)
      expect(res.body.rejectedFields).toEqual(['allocationPercent', 'startWeek', 'endWeek'])
      expect(tx.namedResource.update).not.toHaveBeenCalled()
      expect(tx.capacityProfile.update).not.toHaveBeenCalled()
    })

    it('rejects PUT with allocationPercent with 400 and no write', async () => {
      const tx = await setupTx([makeNRProfile({
        planningBasis: 'CAPACITY_PROFILE',
        segments: [{ id: 'cs-1', capacityProfileId: 'cp-1', startWeek: 0, endWeek: 5, capacityPercent: 100, source: 'FIXED' }],
      })])

      const res = await request(app)
        .put('/api/projects/proj-1/resource-types/rt-1/named-resources/nr-1')
        .set('Authorization', authHeader)
        .send({ allocationPercent: 75 })

      expect(res.status).toBe(400)
      expect(res.body.rejectedFields).toEqual(['allocationPercent'])
      expect(tx.namedResource.update).not.toHaveBeenCalled()
      expect(tx.capacityProfile.update).not.toHaveBeenCalled()
    })
  })
  describe('rejected PATCH contract', () => {
    it('PATCH rejects capacity requests with the structured 400 and performs no write', async () => {
      const tx = await setupTx([makeNRProfile({
        planningBasis: 'CAPACITY_PROFILE',
        segments: [{ id: 'cs-1', capacityProfileId: 'cp-1', startWeek: 0, endWeek: 5, capacityPercent: 100, source: 'FIXED' }],
      })])

      const res = await request(app)
        .patch('/api/projects/proj-1/resource-types/rt-1/named-resources/nr-1')
        .set('Authorization', authHeader)
        .send({ allocationPercent: 75 })

      expect(res.status).toBe(400)
      expect(res.body.rejectedFields).toEqual(['allocationPercent'])
      expect(prisma.$transaction).not.toHaveBeenCalled()
      expect(tx.namedResource.update).not.toHaveBeenCalled()
    })
  })

  describe('rejection before transaction', () => {
    it('legacy capacity fields are rejected before any database call', async () => {
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

      // The guard rejects the supplied legacy field before the transaction
      // runs, so the failing DB mock is never reached.
      expect(res.status).toBe(400)
      expect(res.body.rejectedFields).toEqual(['allocationPercent'])
      expect(prisma.$transaction).not.toHaveBeenCalled()
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

    it('allows name-only PUT for PLANNED_RESOURCE profile', async () => {
      const tx = await setupTx([makeNRProfile({ ownerKind: 'PLANNED_RESOURCE' })])

      const res = await request(app)
        .put('/api/projects/proj-1/resource-types/rt-1/named-resources/nr-1')
        .set('Authorization', authHeader)
        .send({ name: 'Planned Resource Renamed' })

      expect(res.status).toBe(200)
      expect(tx.capacityProfile.update).not.toHaveBeenCalled()
      expect(tx.namedResource.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { name: 'Planned Resource Renamed' } }),
      )
    })

    it('allows pricing-only PUT for PLANNED_RESOURCE profile', async () => {
      const tx = await setupTx([makeNRProfile({ ownerKind: 'PLANNED_RESOURCE' })])

      const res = await request(app)
        .put('/api/projects/proj-1/resource-types/rt-1/named-resources/nr-1')
        .set('Authorization', authHeader)
        .send({ pricingModel: 'PRO_RATA' })

      expect(res.status).toBe(200)
      expect(tx.capacityProfile.update).not.toHaveBeenCalled()
      expect(tx.namedResource.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ pricingModel: 'PRO_RATA' }) }),
      )
    })
  it('PATCH is rejection-only — allocationPct-only requests return the structured 400', async () => {
    const tx = await setupTx([makeNRProfile({ defaultPercent: 25 })])

    const res = await request(app)
      .patch('/api/projects/proj-1/resource-types/rt-1/named-resources/nr-1')
      .set('Authorization', authHeader)
      .send({ allocationPct: 40 })

    expect(res.status).toBe(400)
    expect(res.body.rejectedFields).toEqual(['allocationPct'])
    expect(prisma.$transaction).not.toHaveBeenCalled()
    expect(tx.capacityProfile.update).not.toHaveBeenCalled()
    expect(tx.namedResource.update).not.toHaveBeenCalled()
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

  it('rejects scalar capacity fields on a PLANNED_RESOURCE profile with 400', async () => {
    const tx = await setupTx([makeNRProfile({ ownerKind: 'PLANNED_RESOURCE' })])

    const res = await request(app)
      .put('/api/projects/proj-1/resource-types/rt-1/named-resources/nr-1')
      .set('Authorization', authHeader)
      .send({ allocationPercent: 40 })

    expect(res.status).toBe(400)
    expect(res.body.rejectedFields).toEqual(['allocationPercent'])
    expect(tx.capacityProfile.update).not.toHaveBeenCalled()
    expect(tx.namedResource.update).not.toHaveBeenCalled()
    expect(tx.project.update).not.toHaveBeenCalled()
  })
  })
})

describe('legacy capacity request rejection (#403)', () => {
  const LEGACY_FIELDS = [
    'allocationMode',
    'allocationPercent',
    'allocationPct',
    'allocationStartWeek',
    'allocationEndWeek',
    'startWeek',
    'endWeek',
  ] as const

  function stubLookups() {
    vi.mocked(prisma.project.findFirst).mockResolvedValue({ id: 'proj-1', ownerId: userId } as never)
    vi.mocked(prisma.resourceType.findFirst).mockResolvedValue({ id: 'rt-1', projectId: 'proj-1', allocationMode: 'EFFORT' } as never)
    vi.mocked(prisma.namedResource.findFirst).mockResolvedValue({
      id: 'nr-1', resourceTypeId: 'rt-1',
      allocationMode: 'EFFORT', allocationPercent: 100, allocationPct: 100,
      allocationStartWeek: null, allocationEndWeek: null, startWeek: null, endWeek: null,
    } as never)
  }

  it.each(LEGACY_FIELDS)('POST rejects supplied legacy capacity field "%s" with 400, no write, no cache clear', async (field) => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue({ id: 'proj-1', ownerId: userId } as never)
    vi.mocked(prisma.resourceType.findFirst).mockResolvedValue({ id: 'rt-1', projectId: 'proj-1', allocationMode: 'EFFORT' } as never)
    const res = await request(app)
      .post('/api/projects/proj-1/resource-types/rt-1/named-resources')
      .set('Authorization', authHeader)
      .send({ name: 'New person', [field]: field === 'allocationMode' ? 'EFFORT' : null })

    expect(res.status).toBe(400)
    expect(res.body.rejectedFields).toEqual([field])
    expect(res.body.error).toContain('capacity-profiles/:ownerKind/:ownerId')
    expect(prisma.$transaction).not.toHaveBeenCalled()
    expect(prisma.project.update).not.toHaveBeenCalled()
  })

  it.each(LEGACY_FIELDS)('PUT rejects supplied legacy capacity field "%s" with 400, no write, no cache clear', async (field) => {
    stubLookups()
    const res = await request(app)
      .put('/api/projects/proj-1/resource-types/rt-1/named-resources/nr-1')
      .set('Authorization', authHeader)
      .send({ name: 'Renamed', [field]: field === 'allocationMode' ? 'EFFORT' : null })

    expect(res.status).toBe(400)
    expect(res.body.rejectedFields).toEqual([field])
    expect(prisma.$transaction).not.toHaveBeenCalled()
    expect(prisma.project.update).not.toHaveBeenCalled()
  })

  it('reports multiple rejected fields together with endpoint guidance', async () => {
    stubLookups()
    const res = await request(app)
      .put('/api/projects/proj-1/resource-types/rt-1/named-resources/nr-1')
      .set('Authorization', authHeader)
      .send({ allocationPercent: 80, startWeek: 2, endWeek: null, allocationPct: 80 })

    expect(res.status).toBe(400)
    expect(res.body.rejectedFields).toEqual(['allocationPercent', 'allocationPct', 'startWeek', 'endWeek'])
    expect(res.body.capacityProfileEndpoint).toBe('/api/projects/:projectId/capacity-profiles/:ownerKind/:ownerId')
    expect(prisma.$transaction).not.toHaveBeenCalled()
    expect(prisma.project.update).not.toHaveBeenCalled()
  })
})

describe('planner-owned named-resource identity conflicts (#403)', () => {
  const plannerRoleProfile = () => ({
    id: 'cp-role-1',
    projectId: 'proj-1',
    resourceTypeId: 'rt-1',
    namedResourceId: null,
    ownerKind: 'ROLE',
    planningBasis: 'CAPACITY_PROFILE',
    source: 'SQUAD_PLANNER',
    defaultPercent: 25,
    startWeek: null,
    endWeek: null,
    segments: [{
      id: 'seg-role-1',
      capacityProfileId: 'cp-role-1',
      startWeek: 0,
      endWeek: 10,
      capacityPercent: 25,
      source: 'SQUAD_PLANNER',
    }],
  })

  function profileMock(role: any, named: any[] = []) {
    return vi.fn().mockImplementation((args: any) => {
      const where = args?.where ?? {}
      if (where.resourceTypeId && where.namedResourceId === null) return Promise.resolve([role])
      if (typeof where.namedResourceId === 'string') {
        return Promise.resolve(named.filter((p: any) => p.namedResourceId === where.namedResourceId))
      }
      return Promise.resolve([])
    })
  }

  it('POST returns 409 before any write when the role is planner-owned', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue({ id: 'proj-1', ownerId: userId } as never)
    vi.mocked(prisma.resourceType.findFirst).mockResolvedValue({ id: 'rt-1', projectId: 'proj-1', name: 'Developer', allocationMode: 'CAPACITY_PLAN' } as never)
    const tx = {
      capacityProfile: { findMany: profileMock(plannerRoleProfile()) },
      namedResource: {
        create: vi.fn(),
        update: vi.fn(),
        count: vi.fn(),
      },
      resourceType: { update: vi.fn() },
      project: { update: vi.fn() },
    }
    vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) => fn(tx))

    const res = await request(app)
      .post('/api/projects/proj-1/resource-types/rt-1/named-resources')
      .set('Authorization', authHeader)
      .send({ name: 'New person' })

    expect(res.status).toBe(409)
    expect(res.body.code).toBe('PLANNER_MANAGED_IDENTITY')
    expect(res.body.error).toContain('Switch to manual capacity')
    expect(tx.namedResource.create).not.toHaveBeenCalled()
    expect(tx.resourceType.update).not.toHaveBeenCalled()
    expect(tx.project.update).not.toHaveBeenCalled()
  })

  it('DELETE returns 409 before any write when the resource is planner-owned', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue({ id: 'proj-1', ownerId: userId } as never)
    vi.mocked(prisma.resourceType.findFirst).mockResolvedValue({ id: 'rt-1', projectId: 'proj-1', name: 'Developer', allocationMode: 'EFFORT' } as never)
    vi.mocked(prisma.namedResource.findFirst).mockResolvedValue({ id: 'nr-1', name: 'Planned Dev', resourceTypeId: 'rt-1' } as never)
    const plannerNrProfile = {
      id: 'cp-nr-plan-1',
      projectId: 'proj-1',
      resourceTypeId: null,
      namedResourceId: 'nr-1',
      ownerKind: 'PLANNED_RESOURCE',
      planningBasis: 'CAPACITY_PROFILE',
      source: 'SQUAD_PLANNER',
      defaultPercent: 40,
      startWeek: null,
      endWeek: null,
      segments: [{
        id: 'seg-1',
        capacityProfileId: 'cp-nr-plan-1',
        startWeek: 0,
        endWeek: 7,
        capacityPercent: 40,
        source: 'SQUAD_PLANNER',
      }],
    }
    const manualRole = {
      id: 'cp-role-1',
      projectId: 'proj-1',
      resourceTypeId: 'rt-1',
      namedResourceId: null,
      ownerKind: 'ROLE',
      planningBasis: 'AVAILABILITY_WINDOW',
      source: 'AVAILABILITY_WINDOW',
      defaultPercent: 100,
      startWeek: null,
      endWeek: null,
      segments: [],
    }
    const tx = {
      capacityProfile: {
        findMany: profileMock(manualRole, [plannerNrProfile]),
      },
      namedResource: { delete: vi.fn(), count: vi.fn() },
      resourceType: { update: vi.fn() },
      project: { update: vi.fn() },
    }
    vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) => fn(tx))

    const res = await request(app)
      .delete('/api/projects/proj-1/resource-types/rt-1/named-resources/nr-1')
      .set('Authorization', authHeader)

    expect(res.status).toBe(409)
    expect(res.body.code).toBe('PLANNER_MANAGED_IDENTITY')
    expect(tx.namedResource.delete).not.toHaveBeenCalled()
    expect(tx.resourceType.update).not.toHaveBeenCalled()
    expect(tx.project.update).not.toHaveBeenCalled()
  })

  it('POST rejects an aggregate ROLE profile above 100 before any write', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue({ id: 'proj-1', ownerId: userId } as never)
    vi.mocked(prisma.resourceType.findFirst).mockResolvedValue({ id: 'rt-1', projectId: 'proj-1', name: 'Developer', allocationMode: 'TIMELINE' } as never)
    const aggregateRole = {
      id: 'cp-role-1',
      projectId: 'proj-1',
      resourceTypeId: 'rt-1',
      namedResourceId: null,
      ownerKind: 'ROLE',
      planningBasis: 'CAPACITY_PROFILE',
      source: 'MANUAL',
      defaultPercent: 60,
      startWeek: null,
      endWeek: null,
      segments: [
        { id: 'cs-1', capacityProfileId: 'cp-role-1', startWeek: 0, endWeek: 4, capacityPercent: 100, source: 'MANUAL' },
        { id: 'cs-2', capacityProfileId: 'cp-role-1', startWeek: 5, endWeek: 8, capacityPercent: 120, source: 'MANUAL' },
      ],
    }
    const tx = {
      capacityProfile: {
        findMany: profileMock(aggregateRole),
        create: vi.fn().mockResolvedValue({ id: 'cp-new' }),
      },
      namedResource: {
        create: vi.fn().mockResolvedValue({ id: 'nr-new' }),
        update: vi.fn().mockResolvedValue({ id: 'nr-new' }),
        count: vi.fn().mockResolvedValue(2),
      },
      resourceType: { update: vi.fn() },
      project: { update: vi.fn() },
    }
    vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) => fn(tx))

    const res = await request(app)
      .post('/api/projects/proj-1/resource-types/rt-1/named-resources')
      .set('Authorization', authHeader)
      .send({ name: 'Alice' })

    expect(res.status).toBe(400)
    expect(res.body.code).toBe('AGGREGATE_ROLE_CAPACITY')
    expect(res.body.error).toContain('W5-W8')
    expect(tx.namedResource.create).not.toHaveBeenCalled()
    expect(tx.capacityProfile.create).not.toHaveBeenCalled()
    expect(tx.resourceType.update).not.toHaveBeenCalled()
    expect(tx.project.update).not.toHaveBeenCalled()
  })

  it('POST clones the manual ROLE profile into the new NAMED_PERSON profile', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue({ id: 'proj-1', ownerId: userId } as never)
    vi.mocked(prisma.resourceType.findFirst).mockResolvedValue({ id: 'rt-1', projectId: 'proj-1', name: 'Developer', allocationMode: 'TIMELINE' } as never)
    const manualRole = {
      id: 'cp-role-1',
      projectId: 'proj-1',
      resourceTypeId: 'rt-1',
      namedResourceId: null,
      ownerKind: 'ROLE',
      planningBasis: 'AVAILABILITY_WINDOW',
      source: 'AVAILABILITY_WINDOW',
      defaultPercent: 75,
      startWeek: 4,
      endWeek: 12,
      segments: [],
    }
    const tx = {
      capacityProfile: {
        findMany: profileMock(manualRole),
        create: vi.fn().mockResolvedValue({ id: 'cp-new' }),
      },
      namedResource: {
        create: vi.fn().mockResolvedValue({ id: 'nr-new', name: 'New person', resourceTypeId: 'rt-1' }),
        update: vi.fn().mockResolvedValue({ id: 'nr-new' }),
        count: vi.fn().mockResolvedValue(2),
      },
      resourceType: { update: vi.fn() },
      project: { update: vi.fn() },
    }
    vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) => fn(tx))

    const res = await request(app)
      .post('/api/projects/proj-1/resource-types/rt-1/named-resources')
      .set('Authorization', authHeader)
      .send({ name: 'Alice' })

    expect(res.status).toBe(201)
    expect(tx.namedResource.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ name: 'Alice', resourceTypeId: 'rt-1' }),
    }))
    // The new owner profile inherits the ROLE profile with the shared
    // generation provenance policy (DERIVED source + ROLE_DEFAULT marker)
    expect(tx.capacityProfile.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        ownerKind: 'NAMED_PERSON',
        namedResourceId: 'nr-new',
        planningBasis: 'AVAILABILITY_WINDOW',
        source: 'DERIVED',
        defaultPercent: 75,
        startWeek: 4,
        endWeek: 12,
        legacy: { version: 1, writer: 'ROLE_DEFAULT' },
      }),
    }))
    // Count synced to the new total
    expect(tx.resourceType.update).toHaveBeenCalledWith(expect.objectContaining({
      data: { count: 2 },
    }))
  })
})
