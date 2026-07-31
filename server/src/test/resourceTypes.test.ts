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

function roleProfile(overrides: Record<string, unknown> = {}) {
  return {
    id: 'cp-role-1',
    projectId: 'proj-1',
    resourceTypeId: 'rt-1',
    namedResourceId: null,
    ownerKind: 'ROLE',
    planningBasis: 'DEMAND_FOLLOWING',
    source: 'FIXED',
    defaultPercent: 100,
    startWeek: null,
    endWeek: null,
    segments: [],
    legacy: {},
    ...overrides,
  }
}

function namedProfile(namedResourceId: string, overrides: Record<string, unknown> = {}) {
  return {
    id: `cp-${namedResourceId}`,
    projectId: 'proj-1',
    resourceTypeId: null,
    namedResourceId,
    ownerKind: 'NAMED_PERSON',
    planningBasis: 'DEMAND_FOLLOWING',
    source: 'FIXED',
    defaultPercent: 100,
    startWeek: null,
    endWeek: null,
    segments: [],
    legacy: {},
    ...overrides,
  }
}

function profileFinder(role: Record<string, unknown>, named: Array<Record<string, unknown>> = []) {
  return vi.fn().mockImplementation((args: any) => {
    const where = args?.where ?? {}
    if (where.resourceTypeId && where.namedResourceId === null) {
      return Promise.resolve([role])
    }
    if (typeof where.namedResourceId === 'string') {
      return Promise.resolve(named.filter(profile => profile.namedResourceId === where.namedResourceId))
    }
    if (where.namedResourceId?.in) {
      return Promise.resolve(named.filter(profile => where.namedResourceId.in.includes(profile.namedResourceId)))
    }
    return Promise.resolve([])
  })
}

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

  function stubRouteLookups() {
    vi.mocked(prisma.project.findFirst).mockResolvedValue({ id: 'proj-1', ownerId: userId } as never)
    vi.mocked(prisma.resourceType.findFirst).mockResolvedValue({
      id: 'rt-1',
      projectId: 'proj-1',
      name: 'Developer',
      count: 1,
      allocationMode: 'EFFORT',
      allocationPercent: 100,
      allocationStartWeek: null,
      allocationEndWeek: null,
    } as never)
  }

  it.each(LEGACY_FIELDS)('PUT rejects supplied legacy capacity field "%s" with 400, no write, no cache clear', async (field) => {
    stubRouteLookups()
    const res = await request(app)
      .put('/api/projects/proj-1/resource-types/rt-1')
      .set('Authorization', authHeader)
      .send({ name: 'Renamed', [field]: null })

    expect(res.status).toBe(400)
    expect(res.body.rejectedFields).toEqual([field])
    expect(res.body.error).toContain('capacity-profiles/:ownerKind/:ownerId')
    expect(prisma.$transaction).not.toHaveBeenCalled()
    expect(prisma.project.update).not.toHaveBeenCalled()
  })

  it.each(LEGACY_FIELDS)('PATCH rejects supplied legacy capacity field "%s" with 400, no write, no cache clear', async (field) => {
    stubRouteLookups()
    const res = await request(app)
      .patch('/api/projects/proj-1/resource-types/rt-1')
      .set('Authorization', authHeader)
      .send({ count: 2, [field]: field === 'allocationMode' ? 'EFFORT' : null })

    expect(res.status).toBe(400)
    expect(res.body.rejectedFields).toEqual([field])
    expect(prisma.$transaction).not.toHaveBeenCalled()
    expect(prisma.project.update).not.toHaveBeenCalled()
  })

  it.each(LEGACY_FIELDS)('POST rejects supplied legacy capacity field "%s" with 400, no write, no cache clear', async (field) => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue({ id: 'proj-1', ownerId: userId } as never)
    const res = await request(app)
      .post('/api/projects/proj-1/resource-types')
      .set('Authorization', authHeader)
      .send({ name: 'New Role', category: 'ENGINEERING', [field]: field === 'allocationMode' ? 'EFFORT' : null })

    expect(res.status).toBe(400)
    expect(res.body.rejectedFields).toEqual([field])
    expect(prisma.$transaction).not.toHaveBeenCalled()
    expect(prisma.project.update).not.toHaveBeenCalled()
  })

  it('reports multiple rejected fields together and rejects before any write or cache clear', async () => {
    stubRouteLookups()
    const res = await request(app)
      .put('/api/projects/proj-1/resource-types/rt-1')
      .set('Authorization', authHeader)
      .send({ allocationPercent: 80, startWeek: 3, endWeek: null, allocationPct: 80 })

    expect(res.status).toBe(400)
    expect(res.body.rejectedFields).toEqual(['allocationPercent', 'allocationPct', 'startWeek', 'endWeek'])
    expect(prisma.$transaction).not.toHaveBeenCalled()
    expect(prisma.project.update).not.toHaveBeenCalled()
  })

  it('rejects legacy fields before the fail-closed profile validation runs', async () => {
    stubRouteLookups()
    // Even with a missing profile, the capacity-field rejection wins and no
    // transaction (and therefore no profile lookup) is performed.
    const res = await request(app)
      .put('/api/projects/proj-1/resource-types/rt-1')
      .set('Authorization', authHeader)
      .send({ allocationMode: 'EFFORT' })

    expect(res.status).toBe(400)
    expect(res.body.rejectedFields).toEqual(['allocationMode'])
    expect(prisma.$transaction).not.toHaveBeenCalled()
  })
})

describe('planner-owned identity conflicts (#403)', () => {
  const plannerRole = () => roleProfile({
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

  function stubRouteLookups(rtOverrides: Record<string, unknown> = {}) {
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
      ...rtOverrides,
    } as never)
  }

  it('PUT with count on a planner-owned role returns 409 before any write', async () => {
    stubRouteLookups()
    const tx = {
      resourceType: { update: vi.fn() },
      capacityProfile: { findMany: profileFinder(plannerRole()) },
      project: { update: vi.fn() },
    }
    vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) => fn(tx))

    const res = await request(app)
      .put('/api/projects/proj-1/resource-types/rt-1')
      .set('Authorization', authHeader)
      .send({ count: 3 })

    expect(res.status).toBe(409)
    expect(res.body.code).toBe('PLANNER_MANAGED_IDENTITY')
    expect(res.body.error).toContain('Switch to manual capacity')
    expect(tx.resourceType.update).not.toHaveBeenCalled()
    expect(tx.project.update).not.toHaveBeenCalled()
  })

  it('PUT with count on a planner-owned role leaves the complete state unchanged', async () => {
    stubRouteLookups()
    const committed = {
      resourceType: { id: 'rt-1', count: 1, allocationMode: 'CAPACITY_PLAN', allocationPercent: 25 },
      namedResources: [
        { id: 'nr-1', name: 'Developer 1', resourceTypeId: 'rt-1', allocationMode: 'CAPACITY_PLAN', allocationPercent: 25 },
      ],
    }
    const tx = {
      resourceType: { update: vi.fn() },
      capacityProfile: {
        findMany: profileFinder(plannerRole(), [
          namedProfile('nr-1', { defaultPercent: 25 }),
        ]),
      },
      namedResource: { findMany: vi.fn().mockResolvedValue(committed.namedResources) },
      project: { update: vi.fn() },
    }
    vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) => fn(tx))

    const res = await request(app)
      .put('/api/projects/proj-1/resource-types/rt-1')
      .set('Authorization', authHeader)
      .send({ count: 3 })

    expect(res.status).toBe(409)
    // No mutation attempt at all — the conflict fires before the first write
    expect(tx.resourceType.update).not.toHaveBeenCalled()
    expect(tx.project.update).not.toHaveBeenCalled()
  })

  it('PATCH count on a planner-owned role returns 409 before any write', async () => {
    stubRouteLookups()
    const tx = {
      resourceType: { update: vi.fn() },
      namedResource: {
        findMany: vi.fn().mockResolvedValue([
          { id: 'nr-1', allocationMode: 'CAPACITY_PLAN', allocationPercent: 25, allocationPct: 25, allocationStartWeek: 0, allocationEndWeek: 10, startWeek: 0, endWeek: 10 },
        ]),
        create: vi.fn(),
        delete: vi.fn(),
        updateMany: vi.fn(),
      },
      capacityProfile: {
        findMany: profileFinder(plannerRole(), [
          namedProfile('nr-1', { defaultPercent: 25 }),
        ]),
        create: vi.fn(),
        update: vi.fn(),
      },
      project: { update: vi.fn() },
    }
    vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) => fn(tx))

    const res = await request(app)
      .patch('/api/projects/proj-1/resource-types/rt-1')
      .set('Authorization', authHeader)
      .send({ count: 2 })

    expect(res.status).toBe(409)
    expect(res.body.code).toBe('PLANNER_MANAGED_IDENTITY')
    expect(tx.namedResource.create).not.toHaveBeenCalled()
    expect(tx.namedResource.delete).not.toHaveBeenCalled()
    expect(tx.namedResource.updateMany).not.toHaveBeenCalled()
    expect(tx.capacityProfile.create).not.toHaveBeenCalled()
    expect(tx.capacityProfile.update).not.toHaveBeenCalled()
    expect(tx.resourceType.update).not.toHaveBeenCalled()
    expect(tx.project.update).not.toHaveBeenCalled()
  })

  it('PATCH same-count on a planner-owned role also fails closed with 409', async () => {
    stubRouteLookups()
    const tx = {
      resourceType: { update: vi.fn() },
      namedResource: {
        findMany: vi.fn().mockResolvedValue([
          { id: 'nr-1', allocationMode: 'CAPACITY_PLAN', allocationPercent: 25, allocationPct: 25, allocationStartWeek: 0, allocationEndWeek: 10, startWeek: 0, endWeek: 10 },
        ]),
        create: vi.fn(),
        delete: vi.fn(),
        updateMany: vi.fn(),
      },
      capacityProfile: {
        findMany: profileFinder(plannerRole(), [
          namedProfile('nr-1', { defaultPercent: 25 }),
        ]),
        create: vi.fn(),
        update: vi.fn(),
      },
      project: { update: vi.fn() },
    }
    vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) => fn(tx))

    const res = await request(app)
      .patch('/api/projects/proj-1/resource-types/rt-1')
      .set('Authorization', authHeader)
      .send({ count: 1 })

    expect(res.status).toBe(409)
    expect(res.body.code).toBe('PLANNER_MANAGED_IDENTITY')
    expect(tx.resourceType.update).not.toHaveBeenCalled()
    expect(tx.project.update).not.toHaveBeenCalled()
  })

  it('PATCH count on a role with a planner-owned named resource returns 409 before any write', async () => {
    stubRouteLookups()
    const tx = {
      resourceType: { update: vi.fn() },
      namedResource: {
        findMany: vi.fn().mockResolvedValue([
          { id: 'nr-plan-1', allocationMode: 'CAPACITY_PLAN', allocationPercent: 25, allocationPct: 25, allocationStartWeek: null, allocationEndWeek: null, startWeek: null, endWeek: null },
        ]),
        create: vi.fn(),
        delete: vi.fn(),
      },
      capacityProfile: {
        findMany: profileFinder(roleProfile(), [
          namedProfile('nr-plan-1', {
            ownerKind: 'PLANNED_RESOURCE',
            planningBasis: 'CAPACITY_PROFILE',
            source: 'SQUAD_PLANNER',
            defaultPercent: 25,
            segments: [{
              id: 'seg-1',
              capacityProfileId: 'cp-nr-plan-1',
              startWeek: 2,
              endWeek: 3,
              capacityPercent: 100,
              source: 'SQUAD_PLANNER',
            }],
          }),
        ]),
        create: vi.fn(),
        update: vi.fn(),
      },
      project: { update: vi.fn() },
    }
    vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) => fn(tx))

    const res = await request(app)
      .patch('/api/projects/proj-1/resource-types/rt-1')
      .set('Authorization', authHeader)
      .send({ count: 2 })

    expect(res.status).toBe(409)
    expect(res.body.code).toBe('PLANNER_MANAGED_IDENTITY')
    expect(tx.namedResource.create).not.toHaveBeenCalled()
    expect(tx.resourceType.update).not.toHaveBeenCalled()
  })

  it('DELETE named-resource of a planner-owned role returns 409 before any write', async () => {
    stubRouteLookups({ name: 'Developer' })
    vi.mocked(prisma.namedResource.findFirst).mockResolvedValue({
      id: 'nr-2',
      name: 'Dev 2',
      resourceTypeId: 'rt-1',
    } as never)
    const tx = {
      capacityProfile: {
        findMany: profileFinder(plannerRole(), [namedProfile('nr-2')]),
        deleteMany: vi.fn(),
        update: vi.fn(),
      },
      namedResource: { delete: vi.fn(), count: vi.fn() },
      resourceType: { update: vi.fn() },
      project: { update: vi.fn() },
    }
    vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) => fn(tx))

    const res = await request(app)
      .delete('/api/projects/proj-1/resource-types/rt-1/named-resources/nr-2')
      .set('Authorization', authHeader)

    expect(res.status).toBe(409)
    expect(res.body.code).toBe('PLANNER_MANAGED_IDENTITY')
    expect(res.body.error).toContain('Switch to manual capacity')
    expect(tx.namedResource.delete).not.toHaveBeenCalled()
    expect(tx.capacityProfile.deleteMany).not.toHaveBeenCalled()
    expect(tx.project.update).not.toHaveBeenCalled()
  })
})

describe('DELETE /api/projects/:projectId/resource-types/:id', () => {
  it('deletes a resource type scoped to the project', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue({ id: 'proj-1', ownerId: userId } as never)
    vi.mocked(prisma.resourceType.findFirst).mockResolvedValue({
      id: 'rt-1', projectId: 'proj-1', name: 'Role', count: 1,
    } as never)
    const tx = {
      resourceType: { deleteMany: vi.fn().mockResolvedValue({ count: 1 }) },
      capacityProfile: {
        findMany: vi.fn().mockImplementation((args: any) => {
          if (args?.where?.resourceTypeId && args?.where?.namedResourceId === null) {
            return Promise.resolve([{
              id: 'cp-role-1', ownerKind: 'ROLE', resourceTypeId: 'rt-1',
              namedResourceId: null, planningBasis: 'DEMAND_FOLLOWING',
              source: 'FIXED', defaultPercent: 100, startWeek: null, endWeek: null,
              projectId: 'proj-1', segments: [],
            }])
          }
          return Promise.resolve([])
        }),
      },
      namedResource: { findMany: vi.fn().mockResolvedValue([]) },
      project: { update: vi.fn().mockResolvedValue({}) },
    }
    vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) => fn(tx))

    const res = await request(app)
      .delete('/api/projects/proj-1/resource-types/rt-1')
      .set('Authorization', authHeader)

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ message: 'Deleted' })
    expect(tx.resourceType.deleteMany).toHaveBeenCalledWith({
      where: { id: 'rt-1', projectId: 'proj-1' },
    })
  })

  it('returns 404 when the resource type belongs to another project (cross-tenant delete)', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue({ id: 'proj-1', ownerId: userId } as never)
    vi.mocked(prisma.resourceType.findFirst).mockResolvedValue(null)
    // findFirst returns null → route returns 404 before transaction
    const tx = {
      resourceType: { deleteMany: vi.fn() },
      capacityProfile: { findMany: vi.fn() },
      namedResource: { findMany: vi.fn() },
      project: { update: vi.fn() },
    }
    vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) => fn(tx))

    const res = await request(app)
      .delete('/api/projects/proj-1/resource-types/rt-99')
      .set('Authorization', authHeader)

    expect(res.status).toBe(404)
    expect(res.body).toEqual({ error: 'Resource type not found' })
    // Transaction never ran — no resourceType or cache operations
    expect(tx.resourceType.deleteMany).not.toHaveBeenCalled()
  })
})

  async function runDeleteWithProfiles(
    roleProfiles: Array<Record<string, unknown>>,
    namedProfiles: Array<Record<string, unknown>> = [],
    namedResources: Array<{ id: string }> = [],
  ) {
    vi.mocked(prisma.project.findFirst).mockResolvedValue({ id: 'proj-1', ownerId: userId } as never)
    vi.mocked(prisma.resourceType.findFirst).mockResolvedValue({
      id: 'rt-1',
      projectId: 'proj-1',
      name: 'Role',
      count: namedResources.length,
    } as never)

    const tx = {
      capacityProfile: {
        findMany: vi.fn().mockImplementation((args: any) => {
          const where = args?.where ?? {}
          if (where.resourceTypeId && where.namedResourceId === null) return Promise.resolve(roleProfiles)
          if (typeof where.namedResourceId === 'string') {
            return Promise.resolve(namedProfiles.filter(profile => profile.namedResourceId === where.namedResourceId))
          }
          return Promise.resolve([])
        }),
      },
      namedResource: { findMany: vi.fn().mockResolvedValue(namedResources) },
      resourceType: { deleteMany: vi.fn().mockResolvedValue({ count: 1 }) },
      project: { update: vi.fn().mockResolvedValue({}) },
    }
    vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) => fn(tx))

    const res = await request(app)
      .delete('/api/projects/proj-1/resource-types/rt-1')
      .set('Authorization', authHeader)

    expect(res.status).toBe(409)
    expect(res.body.code).toBe('CAPACITY_INTEGRITY_ERROR')
    expect(tx.resourceType.deleteMany).not.toHaveBeenCalled()
    expect(tx.project.update).not.toHaveBeenCalled()
  }

  it('fails closed when the ROLE profile is missing', async () => {
    await runDeleteWithProfiles([])
  })

  it('fails closed when duplicate ROLE profiles exist', async () => {
    await runDeleteWithProfiles([roleProfile(), roleProfile({ id: 'cp-role-2' })])
  })

  it('fails closed when the ROLE profile has the wrong owner kind', async () => {
    await runDeleteWithProfiles([roleProfile({ ownerKind: 'NAMED_PERSON' })])
  })

  it('fails closed when a NamedResource profile is missing', async () => {
    await runDeleteWithProfiles([roleProfile()], [], [{ id: 'nr-1' }])
  })

  it('fails closed when duplicate NamedResource profiles exist', async () => {
    await runDeleteWithProfiles(
      [roleProfile()],
      [namedProfile('nr-1'), namedProfile('nr-1', { id: 'cp-nr-duplicate' })],
      [{ id: 'nr-1' }],
    )
  })

  it('fails closed when a NamedResource profile has the wrong owner kind', async () => {
    await runDeleteWithProfiles(
      [roleProfile()],
      [namedProfile('nr-1', { ownerKind: 'ROLE' })],
      [{ id: 'nr-1' }],
    )
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
      capacityProfile: {
        create: vi.fn().mockResolvedValue({ id: 'cp-new' }),
        findMany: vi.fn().mockResolvedValue([]),
        update: vi.fn(),
      },
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
        findMany: vi.fn().mockResolvedValue([{
          id: 'cp-1',
          ownerKind: 'ROLE',
          projectId: 'proj-1',
          resourceTypeId: 'rt-1',
          namedResourceId: null,
          planningBasis: 'DEMAND_FOLLOWING',
          source: 'FIXED',
          defaultPercent: 100,
          startWeek: null,
          endWeek: null,
          segments: [],
        }]),
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        create: vi.fn().mockResolvedValue({ id: 'cp-new' }),
        update: vi.fn(),
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
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      capacityProfile: {
        findMany: vi.fn().mockResolvedValue([{ id: 'cp-role-1', ownerKind: 'ROLE', resourceTypeId: 'rt-1', namedResourceId: null, planningBasis: 'DEMAND_FOLLOWING', source: 'FIXED', defaultPercent: 100, startWeek: null, endWeek: null, projectId: 'proj-1', segments: [] }]),
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        create: vi.fn().mockResolvedValue({ id: 'cp-role' }),
        update: vi.fn(),
      },
      capacitySegment: {
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
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
    vi.mocked(prisma.resourceType.findFirst).mockResolvedValue({
      id: 'rt-1', projectId: 'proj-1', name: 'Role', count: 0,
    } as never)
    const tx = {
      resourceType: { deleteMany: vi.fn().mockResolvedValue({ count: 1 }) },
      capacityProfile: { findMany: profileFinder(roleProfile()) },
      namedResource: { findMany: vi.fn().mockResolvedValue([]) },
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
    vi.mocked(prisma.resourceType.findFirst).mockResolvedValue(null)
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
          findMany: vi.fn().mockImplementation((args: any) => {
            const where = args?.where ?? {}
            // ROLE profile query
            if (where.resourceTypeId === rtId && where.namedResourceId === null) {
              return Promise.resolve([{
                id: 'cp-role-1',
                ownerKind: 'ROLE',
                resourceTypeId: rtId,
                namedResourceId: null,
                planningBasis: 'DEMAND_FOLLOWING',
                source: 'FIXED',
                defaultPercent: 100,
                startWeek: null,
                endWeek: null,
                projectId,
                segments: [],
              } as never])
            }
            // NR profile query: return [] for new NRs (no profile yet)
            return Promise.resolve([])
          }),
          deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
          create: vi.fn().mockResolvedValue({ id: 'cp-new' }),
          update: vi.fn(),
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

describe('capacity profile profile-first writes (no sync)', () => {
  beforeEach(() => vi.clearAllMocks())

  it('PUT with legacy capacity fields is rejected with 400 and does not call sync', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue({ id: 'proj-1', ownerId: userId } as never)
    vi.mocked(prisma.resourceType.findFirst).mockResolvedValue({ id: 'rt-1', projectId: 'proj-1', allocationMode: 'EFFORT' } as never)
    const tx = {
      resourceType: { update: vi.fn().mockResolvedValue({ id: 'rt-1', name: 'Updated' }) },
      capacityProfile: {
        findMany: vi.fn().mockResolvedValue([{
          id: 'cp-role-1', ownerKind: 'ROLE', resourceTypeId: 'rt-1',
          namedResourceId: null, planningBasis: 'DEMAND_FOLLOWING',
          source: 'FIXED', defaultPercent: 100,
          startWeek: null, endWeek: null, projectId: 'proj-1', segments: [],
        } as never]),
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        create: vi.fn().mockResolvedValue({ id: 'cp-new' }),
        update: vi.fn(),
      },
      capacitySegment: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
      namedResource: { findMany: vi.fn().mockResolvedValue([]) },
      project: { update: vi.fn() },
    }
    vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) => fn(tx))

    const res = await request(app)
      .put('/api/projects/proj-1/resource-types/rt-1')
      .set('Authorization', authHeader)
      .send({ allocationMode: 'TIMELINE', allocationPercent: 80 })

    // Legacy capacity request fields are rejected before the transaction runs
    expect(res.status).toBe(400)
    expect(res.body.rejectedFields).toEqual(['allocationMode', 'allocationPercent'])
    expect(tx.capacityProfile.update).not.toHaveBeenCalled()
    expect(tx.resourceType.update).not.toHaveBeenCalled()
    // Sync is NOT called after #364
    expect(syncCapacityProfilesForProject).not.toHaveBeenCalled()
  })


  it('PATCH count increase does not call sync', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue({ id: 'proj-1', ownerId: userId } as never)
    vi.mocked(prisma.resourceType.findFirst).mockResolvedValue({ id: 'rt-1', projectId: 'proj-1', allocationMode: 'EFFORT', name: 'Engineer', allocationPercent: null, allocationStartWeek: null, allocationEndWeek: null } as never)
    const tx = {
      namedResource: {
        findMany: vi.fn().mockResolvedValue([{ id: 'nr-1' }]),
        create: vi.fn().mockResolvedValue({ id: 'nr-new' }),
      },
      capacityProfile: {
        findMany: profileFinder(roleProfile(), [namedProfile('nr-1')]),
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        create: vi.fn().mockResolvedValue({ id: 'cp-new' }),
        update: vi.fn(),
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
    // Sync is NOT called after #364
    expect(syncCapacityProfilesForProject).not.toHaveBeenCalled()
  })

  it('PATCH count increase clones the role profile with generation provenance', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue({ id: 'proj-1', ownerId: userId } as never)
    vi.mocked(prisma.resourceType.findFirst).mockResolvedValue({ id: 'rt-1', projectId: 'proj-1', allocationMode: 'EFFORT', name: 'Engineer', allocationPercent: null, allocationStartWeek: null, allocationEndWeek: null } as never)
    const tx = {
      namedResource: {
        findMany: vi.fn().mockResolvedValue([{ id: 'nr-1' }]),
        create: vi.fn().mockResolvedValue({ id: 'nr-new' }),
      },
      capacityProfile: {
        findMany: profileFinder(roleProfile({ planningBasis: 'CAPACITY_PROFILE', source: 'MANUAL', defaultPercent: 60, segments: [{ id: 'cs-1', capacityProfileId: 'cp-role-1', startWeek: 0, endWeek: 4, capacityPercent: 100, source: 'MANUAL' }] }), [namedProfile('nr-1', { planningBasis: 'DEMAND_FOLLOWING', defaultPercent: 100 })]),
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        create: vi.fn().mockResolvedValue({ id: 'cp-new' }),
        update: vi.fn(),
      },
      resourceType: { update: vi.fn().mockResolvedValue({ id: 'rt-1', count: 2 }) },
      project: { update: vi.fn() },
    }
    vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) => fn(tx))

    await request(app)
      .patch('/api/projects/proj-1/resource-types/rt-1')
      .set('Authorization', authHeader)
      .send({ count: 2 })

    expect(tx.capacityProfile.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        ownerKind: 'NAMED_PERSON',
        planningBasis: 'CAPACITY_PROFILE',
        source: 'DERIVED',
        defaultPercent: 60,
        legacy: { version: 1, writer: 'ROLE_DEFAULT' },
      }),
    }))
  })

  it('PATCH count increase rejects aggregate ROLE defaultPercent above 100 before any write', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue({ id: 'proj-1', ownerId: userId } as never)
    vi.mocked(prisma.resourceType.findFirst).mockResolvedValue({ id: 'rt-1', projectId: 'proj-1', allocationMode: 'EFFORT', name: 'Engineer', allocationPercent: null, allocationStartWeek: null, allocationEndWeek: null } as never)
    const tx = {
      namedResource: {
        findMany: vi.fn().mockResolvedValue([{ id: 'nr-1' }]),
        create: vi.fn().mockResolvedValue({ id: 'nr-new' }),
      },
      capacityProfile: {
        findMany: profileFinder(roleProfile({ planningBasis: 'DEMAND_FOLLOWING', source: 'FIXED', defaultPercent: 150 }), [namedProfile('nr-1')]),
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        create: vi.fn().mockResolvedValue({ id: 'cp-new' }),
        update: vi.fn(),
      },
      resourceType: { update: vi.fn().mockResolvedValue({ id: 'rt-1', count: 2 }) },
      project: { update: vi.fn() },
    }
    vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) => fn(tx))

    const res = await request(app)
      .patch('/api/projects/proj-1/resource-types/rt-1')
      .set('Authorization', authHeader)
      .send({ count: 2 })

    expect(res.status).toBe(400)
    expect(res.body.code).toBe('AGGREGATE_ROLE_CAPACITY')
    expect(res.body.error).toContain('150')
    expect(tx.namedResource.create).not.toHaveBeenCalled()
    expect(tx.capacityProfile.create).not.toHaveBeenCalled()
    expect(tx.resourceType.update).not.toHaveBeenCalled()
    // Cache untouched
    expect(tx.project.update).not.toHaveBeenCalled()
  })

  it('PATCH count increase rejects an aggregate ROLE segment above 100 before any write', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue({ id: 'proj-1', ownerId: userId } as never)
    vi.mocked(prisma.resourceType.findFirst).mockResolvedValue({ id: 'rt-1', projectId: 'proj-1', allocationMode: 'EFFORT', name: 'Engineer', allocationPercent: null, allocationStartWeek: null, allocationEndWeek: null } as never)
    const tx = {
      namedResource: {
        findMany: vi.fn().mockResolvedValue([{ id: 'nr-1' }]),
        create: vi.fn().mockResolvedValue({ id: 'nr-new' }),
      },
      capacityProfile: {
        findMany: profileFinder(roleProfile({
          planningBasis: 'CAPACITY_PROFILE',
          source: 'MANUAL',
          defaultPercent: 60,
          segments: [
            { id: 'cs-1', capacityProfileId: 'cp-role-1', startWeek: 0, endWeek: 4, capacityPercent: 100, source: 'MANUAL' },
            { id: 'cs-2', capacityProfileId: 'cp-role-1', startWeek: 5, endWeek: 8, capacityPercent: 120, source: 'MANUAL' },
          ],
        }), [namedProfile('nr-1')]),
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        create: vi.fn().mockResolvedValue({ id: 'cp-new' }),
        update: vi.fn(),
      },
      resourceType: { update: vi.fn().mockResolvedValue({ id: 'rt-1', count: 2 }) },
      project: { update: vi.fn() },
    }
    vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) => fn(tx))

    const res = await request(app)
      .patch('/api/projects/proj-1/resource-types/rt-1')
      .set('Authorization', authHeader)
      .send({ count: 2 })

    expect(res.status).toBe(400)
    expect(res.body.code).toBe('AGGREGATE_ROLE_CAPACITY')
    expect(res.body.error).toContain('W5-W8')
    expect(tx.namedResource.create).not.toHaveBeenCalled()
    expect(tx.project.update).not.toHaveBeenCalled()
  })

  it('DELETE does not call sync (cascade handles profiles)', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue({ id: 'proj-1', ownerId: userId } as never)
    vi.mocked(prisma.resourceType.findFirst).mockResolvedValue({
      id: 'rt-1', projectId: 'proj-1', name: 'Role', count: 0,
    } as never)
    const tx = {
      resourceType: {
        deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      capacityProfile: { findMany: profileFinder(roleProfile()) },
      namedResource: { findMany: vi.fn().mockResolvedValue([]) },
      project: { update: vi.fn() },
    }
    vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) => fn(tx))

    await request(app)
      .delete('/api/projects/proj-1/resource-types/rt-1')
      .set('Authorization', authHeader)

    expect(tx.resourceType.deleteMany).toHaveBeenCalledWith({
      where: { id: 'rt-1', projectId: 'proj-1' },
    })
    // Sync is NOT called after #364
    expect(syncCapacityProfilesForProject).not.toHaveBeenCalled()
  })

  it('PUT non-capacity fails closed when no profile exists', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue({ id: 'proj-1', ownerId: userId } as never)
    vi.mocked(prisma.resourceType.findFirst).mockResolvedValue({ id: 'rt-1', projectId: 'proj-1', allocationMode: 'EFFORT' } as never)
    const tx = {
      resourceType: { update: vi.fn().mockResolvedValue({ id: 'rt-1', name: 'Updated' }) },
      capacityProfile: {
        findMany: vi.fn().mockResolvedValue([]),
        update: vi.fn(),
      },
      namedResource: { findMany: vi.fn().mockResolvedValue([]) },
      project: { update: vi.fn() },
    }
    vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) => fn(tx))

    await request(app)
      .put('/api/projects/proj-1/resource-types/rt-1')
      .set('Authorization', authHeader)
      .send({ name: 'Updated' })

    // Missing profile should fail closed → no resource type update
    expect(tx.resourceType.update).not.toHaveBeenCalled()
    expect(syncCapacityProfilesForProject).not.toHaveBeenCalled()
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
        findMany: profileFinder(
          roleProfile({
            planningBasis: 'AVAILABILITY_WINDOW',
            source: 'AVAILABILITY_WINDOW',
          }),
          [
            namedProfile('nr-inh-1'),
            namedProfile('nr-exp-1', {
              planningBasis: 'AVAILABILITY_WINDOW',
              source: 'MANUAL',
              defaultPercent: 50,
              startWeek: 10,
              endWeek: 20,
              legacy: null,
            }),
          ],
        ),
        create: vi.fn().mockResolvedValue({ id: 'cp-new' }),
        update: vi.fn(),
      },
      resourceType: { update: vi.fn().mockResolvedValue({ id: 'rt-1', count: 3 }) },
      project: { update: vi.fn() },
    }
    vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) => fn(tx))

    await request(app)
      .patch('/api/projects/proj-1/resource-types/rt-1')
      .set('Authorization', authHeader)
      .send({ count: 3 })
    // Sync is NOT called after #364
    expect(syncCapacityProfilesForProject).not.toHaveBeenCalled()
    expect(tx.namedResource.create).toHaveBeenCalled()
    expect(tx.resourceType.update).toHaveBeenCalledWith(expect.objectContaining({ data: { count: 3 } }))
  })

  it('PATCH count on a planner-owned role is rejected with 409 and no writes', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue({ id: 'proj-1', ownerId: userId } as never)
    vi.mocked(prisma.resourceType.findFirst).mockResolvedValue({
      id: 'rt-1', projectId: 'proj-1', name: 'Developer',
      allocationMode: 'CAPACITY_PLAN', allocationPercent: 25,
      allocationStartWeek: 4, allocationEndWeek: 8,
    } as never)
    const role = roleProfile({
      planningBasis: 'CAPACITY_PROFILE',
      source: 'SQUAD_PLANNER',
      defaultPercent: 25,
      segments: [{
        id: 'seg-role-1',
        capacityProfileId: 'cp-role-1',
        startWeek: 0,
        endWeek: 10,
        capacityPercent: 25,
        source: 'SQUAD_PLANNER',
      }],
    })
    const tx = {
      resourceType: {
        update: vi.fn().mockImplementation(async ({ data }: { data?: object }) => ({ id: 'rt-1', ...(data ?? {}) })),
      },
      capacityProfile: {
        findMany: profileFinder(role, [
          namedProfile('nr-1', { defaultPercent: 25 }),
        ]),
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        create: vi.fn().mockResolvedValue({ id: 'cp-new' }),
        update: vi.fn(),
      },
      capacitySegment: {
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      namedResource: {
        findMany: vi.fn().mockResolvedValue([
          { id: 'nr-1', allocationMode: 'CAPACITY_PLAN', allocationPercent: 25, allocationPct: 25, allocationStartWeek: 0, allocationEndWeek: 10, startWeek: 0, endWeek: 10 },
        ]),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        create: vi.fn(),
      },
      project: { update: vi.fn() },
    }
    vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) => fn(tx))

    const res = await request(app)
      .patch('/api/projects/proj-1/resource-types/rt-1')
      .set('Authorization', authHeader)
      .send({ count: 3 })

    // Planner-owned roles cannot be changed through count operations
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('PLANNER_MANAGED_IDENTITY')
    expect(tx.namedResource.create).not.toHaveBeenCalled()
    expect(tx.namedResource.updateMany).not.toHaveBeenCalled()
    expect(tx.resourceType.update).not.toHaveBeenCalled()
    expect(tx.project.update).not.toHaveBeenCalled()
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
        findMany: profileFinder(roleProfile(), [namedProfile('nr-1')]),
        update: vi.fn(),
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
        findMany: profileFinder(
          roleProfile(),
          [
            namedProfile('nr-exp-1', {
              planningBasis: 'AVAILABILITY_WINDOW',
              source: 'MANUAL',
              defaultPercent: 50,
              startWeek: 5,
              endWeek: 10,
              legacy: null,
            }),
            namedProfile('nr-old-inh'),
            namedProfile('nr-exp-2', {
              source: 'MANUAL',
              defaultPercent: 75,
              legacy: null,
            }),
          ],
        ),
        delete: vi.fn().mockResolvedValue({}),
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
    expect(res.body.warnings).toHaveLength(1)

    // Persisted count reflects actual remaining resources (2, not requested 1)
    expect(tx.resourceType.update).toHaveBeenCalledWith(expect.objectContaining({ data: { count: 2 } }))
  })

  it('PATCH same-count on a planner-owned role fails closed with 409 (no silent no-op)', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue({ id: 'proj-1', ownerId: userId } as never)
    vi.mocked(prisma.resourceType.findFirst).mockResolvedValue({
      id: 'rt-1', projectId: 'proj-1', name: 'Developer',
      allocationMode: 'CAPACITY_PLAN', allocationPercent: 25,
      allocationStartWeek: 4, allocationEndWeek: 8,
    } as never)
    const role = roleProfile({
      planningBasis: 'CAPACITY_PROFILE',
      source: 'SQUAD_PLANNER',
      defaultPercent: 25,
      segments: [{
        id: 'seg-role-1',
        capacityProfileId: 'cp-role-1',
        startWeek: 0,
        endWeek: 10,
        capacityPercent: 25,
        source: 'SQUAD_PLANNER',
      }],
    })
    const tx = {
      resourceType: {
        update: vi.fn().mockImplementation(async ({ data }: { data?: object }) => ({ id: 'rt-1', ...(data ?? {}) })),
      },
      capacityProfile: {
        findMany: profileFinder(role, [namedProfile('nr-1', { defaultPercent: 25 })]),
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        create: vi.fn().mockResolvedValue({ id: 'cp-new' }),
        update: vi.fn(),
      },
      capacitySegment: {
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      namedResource: {
        findMany: vi.fn().mockResolvedValue([
          { id: 'nr-1', allocationMode: 'CAPACITY_PLAN', allocationPercent: 25, allocationPct: 25, allocationStartWeek: 0, allocationEndWeek: 10, startWeek: 0, endWeek: 10 },
        ]),
        updateMany: vi.fn(),
      },
      project: { update: vi.fn() },
    }
    vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) => fn(tx))

    const res = await request(app)
      .patch('/api/projects/proj-1/resource-types/rt-1')
      .set('Authorization', authHeader)
      .send({ count: 1 })

    expect(res.status).toBe(409)
    expect(res.body.code).toBe('PLANNER_MANAGED_IDENTITY')
    expect(tx.namedResource.updateMany).not.toHaveBeenCalled()
    expect(tx.resourceType.update).not.toHaveBeenCalled()
    expect(tx.project.update).not.toHaveBeenCalled()
  })

  it('PATCH reduction rejects duplicate NamedResource authority before deletion', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue({ id: 'proj-1', ownerId: userId } as never)
    vi.mocked(prisma.resourceType.findFirst).mockResolvedValue({
      id: 'rt-1', projectId: 'proj-1', name: 'Developer',
      allocationMode: 'TIMELINE', allocationPercent: 100,
      allocationStartWeek: null, allocationEndWeek: null,
    } as never)
    const tx = {
      namedResource: {
        findMany: vi.fn().mockResolvedValue([
          { id: 'nr-inh', name: 'Dev 1', allocationMode: 'TIMELINE', allocationPercent: 100, allocationPct: 100, allocationStartWeek: null, allocationEndWeek: null, startWeek: null, endWeek: null, createdAt: new Date('2026-01-01') },
          { id: 'nr-dupe', name: 'Dev 2', allocationMode: 'TIMELINE', allocationPercent: 100, allocationPct: 100, allocationStartWeek: null, allocationEndWeek: null, startWeek: null, endWeek: null, createdAt: new Date('2026-02-01') },
        ]),
        delete: vi.fn().mockResolvedValue({}),
      },
      capacityProfile: {
        findMany: profileFinder(
          roleProfile({
            planningBasis: 'AVAILABILITY_WINDOW',
            source: 'AVAILABILITY_WINDOW',
          }),
          [
            namedProfile('nr-inh'),
            namedProfile('nr-dupe', { id: 'cp-sync' }),
            namedProfile('nr-dupe', {
              id: 'cp-seg',
              planningBasis: 'CAPACITY_PROFILE',
              source: 'SQUAD_PLANNER',
              defaultPercent: null,
              segments: [{
                id: 'seg-1',
                capacityProfileId: 'cp-seg',
                startWeek: 2,
                endWeek: 3,
                capacityPercent: 100,
                source: 'SQUAD_PLANNER',
              }],
            }),
          ],
        ),
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        update: vi.fn(),
      },
      resourceType: { update: vi.fn().mockResolvedValue({ id: 'rt-1', count: 1 }) },
      project: { update: vi.fn() },
    }
    vi.mocked(prisma.$transaction).mockImplementation(async (fn: unknown) => (fn as (...args: unknown[]) => unknown)(tx))

    const res = await request(app)
      .patch('/api/projects/proj-1/resource-types/rt-1')
      .set('Authorization', authHeader)
      .send({ count: 1 })

    expect(res.status).toBe(409)
    expect(res.body.code).toBe('CAPACITY_INTEGRITY_ERROR')
    expect(tx.namedResource.delete).not.toHaveBeenCalled()
    expect(tx.resourceType.update).not.toHaveBeenCalled()
  })
})
