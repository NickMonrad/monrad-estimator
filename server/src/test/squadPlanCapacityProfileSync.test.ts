import { beforeEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { app } from '../index.js'
import { prisma } from '../lib/prisma.js'
import { syncCapacityProfilesForProject } from '../lib/syncCapacityProfiles.js'

vi.mock('../routes/snapshots.js', async (importOriginal: () => Promise<any>) => {
  const actual = await importOriginal()
  return {
    ...actual,
    buildSnapshot: vi.fn().mockResolvedValue({}),
  }
})

vi.mock('../lib/snapshotUtils.js', () => ({
  pruneSnapshots: vi.fn().mockResolvedValue(undefined),
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

process.env.JWT_SECRET = 'test-secret'

const userId = 'user-1'
const token = jwt.sign({ userId }, 'test-secret')
const authHeader = `Bearer ${token}`

// Minimal project stub for squad-plan apply route
const mockProject = {
  id: 'proj-1',
  ownerId: userId,
  name: 'Test Project',
  hoursPerDay: 8,
  weeklyDemandCache: {},
} as never

beforeEach(() => {
  vi.clearAllMocks()
})

function validPeriod() {
  return [
    {
      periodIndex: 0,
      startWeek: 0,
      endWeek: 4,
      entries: [
        { resourceTypeId: 'rt-dev', headcount: 1, demandFTE: 0.5, utilisationPct: 50 },
      ],
    },
  ]
}

function makeValidRequest(overrides: Record<string, unknown> = {}) {
  return {
    name: 'Plan',
    targetWeeks: 4,
    periodWeeks: 4,
    maxDelta: 1,
    setActive: true,
    periods: validPeriod(),
    ...overrides,
  }
}

describe('squad-plan apply capacity profile sync', () => {
  it('calls syncCapacityProfilesForProject(tx, projectId) with transaction object', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue(mockProject)
    vi.mocked(prisma.resourceType.findMany).mockResolvedValue([{ id: 'rt-dev' }] as never)

    // Mock the main transaction so sync receives the tx object
    const tx = {
      capacityPlan: { updateMany: vi.fn().mockResolvedValue({ count: 0 }), create: vi.fn().mockResolvedValue({ id: 'plan-1', projectId: 'proj-1', isActive: true, periods: [] }) },
      resourceType: { update: vi.fn().mockResolvedValue({}), updateMany: vi.fn().mockResolvedValue({ count: 0 }), findUnique: vi.fn().mockResolvedValue({ name: 'Developer' }) },
      namedResource: { updateMany: vi.fn().mockResolvedValue({ count: 1 }), findMany: vi.fn().mockResolvedValue([{ id: 'nr-dev' }]), createMany: vi.fn().mockResolvedValue({ count: 0 }), update: vi.fn().mockResolvedValue({}), delete: vi.fn(), count: vi.fn().mockResolvedValue(0) },
      capacityProfile: { findMany: vi.fn().mockResolvedValue([]), create: vi.fn().mockResolvedValue({ id: 'cp-1' }), update: vi.fn(), deleteMany: vi.fn() },
      capacitySegment: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }), create: vi.fn() },
      project: { findFirst: vi.fn().mockResolvedValue({ id: 'proj-1', resourceTypes: [], capacityPlans: [] }), update: vi.fn() },
      timelineEntry: { deleteMany: vi.fn(), createMany: vi.fn() },
      storyTimelineEntry: { deleteMany: vi.fn(), createMany: vi.fn() },
      epic: { update: vi.fn(), findMany: vi.fn() },
      epicDependency: { findMany: vi.fn() },
      storyDependency: { findMany: vi.fn() },
    }
    vi.mocked(prisma.$transaction).mockImplementationOnce(async (fn: any) => fn(tx))

    await request(app)
      .post('/api/projects/proj-1/squad-plan/apply')
      .set('Authorization', authHeader)
      .send(makeValidRequest())

    // Must be called with tx object, not bare prisma
    expect(syncCapacityProfilesForProject).toHaveBeenCalledWith(tx, 'proj-1')
    expect(syncCapacityProfilesForProject).not.toHaveBeenCalledWith(prisma, 'proj-1')
  })

  it('does not call sync with bare prisma (best-effort path absent)', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue(mockProject)
    vi.mocked(prisma.resourceType.findMany).mockResolvedValue([{ id: 'rt-dev' }] as never)
    const tx = {
      capacityPlan: { updateMany: vi.fn().mockResolvedValue({ count: 0 }), create: vi.fn().mockResolvedValue({ id: 'plan-1', projectId: 'proj-1', isActive: true, periods: [] }) },
      resourceType: { update: vi.fn().mockResolvedValue({}), updateMany: vi.fn().mockResolvedValue({ count: 0 }), findUnique: vi.fn().mockResolvedValue({ name: 'Developer' }) },
      namedResource: { updateMany: vi.fn().mockResolvedValue({ count: 1 }), findMany: vi.fn().mockResolvedValue([{ id: 'nr-dev' }]), createMany: vi.fn().mockResolvedValue({ count: 0 }), update: vi.fn().mockResolvedValue({}), delete: vi.fn(), count: vi.fn().mockResolvedValue(0) },
      capacityProfile: { findMany: vi.fn().mockResolvedValue([]), create: vi.fn().mockResolvedValue({ id: 'cp-1' }), update: vi.fn(), deleteMany: vi.fn() },
      capacitySegment: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }), create: vi.fn() },
      project: { findFirst: vi.fn().mockResolvedValue({ id: 'proj-1', resourceTypes: [], capacityPlans: [] }), update: vi.fn() },
      timelineEntry: { deleteMany: vi.fn(), createMany: vi.fn() },
      storyTimelineEntry: { deleteMany: vi.fn(), createMany: vi.fn() },
      epic: { update: vi.fn(), findMany: vi.fn() },
      epicDependency: { findMany: vi.fn() },
      storyDependency: { findMany: vi.fn() },
    }
    vi.mocked(prisma.$transaction).mockImplementationOnce(async (fn: any) => fn(tx))

    await request(app)
      .post('/api/projects/proj-1/squad-plan/apply')
      .set('Authorization', authHeader)
      .send(makeValidRequest())

    expect(syncCapacityProfilesForProject).toHaveBeenCalledWith(tx, 'proj-1')
    expect(syncCapacityProfilesForProject).not.toHaveBeenCalledWith(prisma, 'proj-1')
  })

  it('returns 201 on successful apply with sync', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue(mockProject)
    vi.mocked(prisma.resourceType.findMany)
      .mockResolvedValueOnce([{ id: 'rt-dev' }] as never)
      .mockResolvedValueOnce([
        { id: 'rt-dev', name: 'Developer', count: 1, hoursPerDay: 8, allocationMode: 'CAPACITY_PLAN', namedResources: [] },
      ] as never)
    vi.mocked(prisma.epic.findMany).mockResolvedValue([] as never)
    vi.mocked(prisma.timelineEntry.findMany).mockResolvedValue([] as never)
    vi.mocked(prisma.storyTimelineEntry.findMany).mockResolvedValue([] as never)
    vi.mocked(prisma.epicDependency.findMany).mockResolvedValue([] as never)
    vi.mocked(prisma.backlogSnapshot.create).mockResolvedValue({ id: 'snap-1' } as never)
    vi.mocked(prisma.project.update).mockResolvedValue(mockProject)

    const tx = {
      capacityPlan: { updateMany: vi.fn().mockResolvedValue({ count: 0 }), create: vi.fn().mockResolvedValue({ id: 'plan-1', projectId: 'proj-1', isActive: true, periods: [] }) },
      resourceType: { update: vi.fn().mockResolvedValue({}), updateMany: vi.fn().mockResolvedValue({ count: 0 }), findUnique: vi.fn().mockResolvedValue({ name: 'Developer' }) },
      namedResource: { updateMany: vi.fn().mockResolvedValue({ count: 1 }), findMany: vi.fn().mockResolvedValue([{ id: 'nr-dev' }]), createMany: vi.fn().mockResolvedValue({ count: 0 }), update: vi.fn().mockResolvedValue({}), delete: vi.fn(), count: vi.fn().mockResolvedValue(0) },
      capacityProfile: { findMany: vi.fn().mockResolvedValue([]), create: vi.fn().mockResolvedValue({ id: 'cp-1' }), update: vi.fn(), deleteMany: vi.fn() },
      capacitySegment: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }), create: vi.fn() },
      project: { findFirst: vi.fn().mockResolvedValue({ id: 'proj-1', resourceTypes: [], capacityPlans: [] }), update: vi.fn() },
      timelineEntry: { deleteMany: vi.fn(), createMany: vi.fn() },
      storyTimelineEntry: { deleteMany: vi.fn(), createMany: vi.fn() },
      epic: { update: vi.fn(), findMany: vi.fn() },
      epicDependency: { findMany: vi.fn() },
      storyDependency: { findMany: vi.fn() },
    }
    vi.mocked(prisma.$transaction).mockImplementationOnce(async (fn: any) => fn(tx))

    const res = await request(app)
      .post('/api/projects/proj-1/squad-plan/apply')
      .set('Authorization', authHeader)
      .send(makeValidRequest())

    expect(res.status).toBe(201)
    expect(res.body).toMatchObject({ id: 'plan-1' })
  })

  it('returns error when sync fails (sync failure propagates)', async () => {
    vi.mocked(syncCapacityProfilesForProject).mockRejectedValueOnce(new Error('sync failed'))
    vi.mocked(prisma.project.findFirst).mockResolvedValue(mockProject)
    vi.mocked(prisma.resourceType.findMany).mockResolvedValue([{ id: 'rt-dev' }] as never)

    const tx = {
      capacityPlan: { updateMany: vi.fn().mockResolvedValue({ count: 0 }), create: vi.fn().mockResolvedValue({ id: 'plan-1', projectId: 'proj-1', isActive: true, periods: [] }) },
      resourceType: { update: vi.fn().mockResolvedValue({}), updateMany: vi.fn().mockResolvedValue({ count: 0 }), findUnique: vi.fn().mockResolvedValue({ name: 'Developer' }) },
      namedResource: { updateMany: vi.fn().mockResolvedValue({ count: 1 }), findMany: vi.fn().mockResolvedValue([{ id: 'nr-dev' }]), createMany: vi.fn().mockResolvedValue({ count: 0 }), update: vi.fn().mockResolvedValue({}), delete: vi.fn(), count: vi.fn().mockResolvedValue(0) },
      capacityProfile: { findMany: vi.fn().mockResolvedValue([]), create: vi.fn().mockResolvedValue({ id: 'cp-1' }), update: vi.fn(), deleteMany: vi.fn() },
      capacitySegment: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }), create: vi.fn() },
      project: { findFirst: vi.fn().mockResolvedValue({ id: 'proj-1', resourceTypes: [], capacityPlans: [] }), update: vi.fn() },
      timelineEntry: { deleteMany: vi.fn(), createMany: vi.fn() },
      storyTimelineEntry: { deleteMany: vi.fn(), createMany: vi.fn() },
      epic: { update: vi.fn(), findMany: vi.fn() },
      epicDependency: { findMany: vi.fn() },
      storyDependency: { findMany: vi.fn() },
    }
    vi.mocked(prisma.$transaction).mockImplementationOnce(async (fn: any) => fn(tx))

    const res = await request(app)
      .post('/api/projects/proj-1/squad-plan/apply')
      .set('Authorization', authHeader)
      .send(makeValidRequest())

    // Sync failure should propagate — not a 201
    expect(res.status).not.toBe(201)
  })

  it('sync runs after capacity-plan and named-resource writes', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue(mockProject)
    vi.mocked(prisma.resourceType.findMany).mockResolvedValue([{ id: 'rt-dev' }] as never)

    const capacityPlanCreateFn = vi.fn().mockResolvedValue({ id: 'plan-1', projectId: 'proj-1', isActive: true, periods: [] })
    const resourceTypeUpdateFn = vi.fn().mockResolvedValue({})
    const namedResourceUpdateFn = vi.fn().mockResolvedValue({})

    const tx = {
      capacityPlan: { updateMany: vi.fn().mockResolvedValue({ count: 0 }), create: capacityPlanCreateFn },
      resourceType: { update: resourceTypeUpdateFn, updateMany: vi.fn().mockResolvedValue({ count: 0 }), findUnique: vi.fn().mockResolvedValue({ name: 'Developer' }) },
      namedResource: { updateMany: vi.fn().mockResolvedValue({ count: 1 }), findMany: vi.fn().mockResolvedValue([{ id: 'nr-dev' }]), createMany: vi.fn().mockResolvedValue({ count: 0 }), update: namedResourceUpdateFn, delete: vi.fn(), count: vi.fn().mockResolvedValue(0) },
      capacityProfile: { findMany: vi.fn().mockResolvedValue([]), create: vi.fn().mockResolvedValue({ id: 'cp-1' }), update: vi.fn(), deleteMany: vi.fn() },
      capacitySegment: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }), create: vi.fn() },
      project: { findFirst: vi.fn().mockResolvedValue({ id: 'proj-1', resourceTypes: [], capacityPlans: [] }), update: vi.fn() },
      timelineEntry: { deleteMany: vi.fn(), createMany: vi.fn() },
      storyTimelineEntry: { deleteMany: vi.fn(), createMany: vi.fn() },
      epic: { update: vi.fn(), findMany: vi.fn() },
      epicDependency: { findMany: vi.fn() },
      storyDependency: { findMany: vi.fn() },
    }
    vi.mocked(prisma.$transaction).mockImplementationOnce(async (fn: any) => fn(tx))

    await request(app)
      .post('/api/projects/proj-1/squad-plan/apply')
      .set('Authorization', authHeader)
      .send(makeValidRequest())

    // Plan creation and resource updates happen before sync
    expect(capacityPlanCreateFn.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(syncCapacityProfilesForProject).mock.invocationCallOrder[0],
    )
    expect(resourceTypeUpdateFn.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(syncCapacityProfilesForProject).mock.invocationCallOrder[0],
    )
    expect(namedResourceUpdateFn.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(syncCapacityProfilesForProject).mock.invocationCallOrder[0],
    )
  })

  it('existing apply behaviour and response shape are preserved', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue(mockProject)
    vi.mocked(prisma.resourceType.findMany)
      .mockResolvedValueOnce([{ id: 'rt-dev' }] as never)
      .mockResolvedValueOnce([
        { id: 'rt-dev', name: 'Developer', count: 1, hoursPerDay: 8, allocationMode: 'CAPACITY_PLAN', namedResources: [] },
      ] as never)
    vi.mocked(prisma.epic.findMany).mockResolvedValue([] as never)
    vi.mocked(prisma.timelineEntry.findMany).mockResolvedValue([] as never)
    vi.mocked(prisma.storyTimelineEntry.findMany).mockResolvedValue([] as never)
    vi.mocked(prisma.epicDependency.findMany).mockResolvedValue([] as never)
    vi.mocked(prisma.backlogSnapshot.create).mockResolvedValue({ id: 'snap-1' } as never)
    vi.mocked(prisma.project.update).mockResolvedValue(mockProject)

    const tx = {
      capacityPlan: { updateMany: vi.fn().mockResolvedValue({ count: 0 }), create: vi.fn().mockResolvedValue({ id: 'plan-1', projectId: 'proj-1', isActive: true, periods: [] }) },
      resourceType: { update: vi.fn().mockResolvedValue({}), updateMany: vi.fn().mockResolvedValue({ count: 0 }), findUnique: vi.fn().mockResolvedValue({ name: 'Developer' }) },
      namedResource: { updateMany: vi.fn().mockResolvedValue({ count: 1 }), findMany: vi.fn().mockResolvedValue([{ id: 'nr-dev' }]), createMany: vi.fn().mockResolvedValue({ count: 0 }), update: vi.fn().mockResolvedValue({}), delete: vi.fn(), count: vi.fn().mockResolvedValue(0) },
      capacityProfile: { findMany: vi.fn().mockResolvedValue([]), create: vi.fn().mockResolvedValue({ id: 'cp-1' }), update: vi.fn(), deleteMany: vi.fn() },
      capacitySegment: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }), create: vi.fn() },
      project: { findFirst: vi.fn().mockResolvedValue({ id: 'proj-1', resourceTypes: [], capacityPlans: [] }), update: vi.fn() },
      timelineEntry: { deleteMany: vi.fn(), createMany: vi.fn() },
      storyTimelineEntry: { deleteMany: vi.fn(), createMany: vi.fn() },
      epic: { update: vi.fn(), findMany: vi.fn() },
      epicDependency: { findMany: vi.fn() },
      storyDependency: { findMany: vi.fn() },
    }
    vi.mocked(prisma.$transaction).mockImplementationOnce(async (fn: any) => fn(tx))

    const res = await request(app)
      .post('/api/projects/proj-1/squad-plan/apply')
      .set('Authorization', authHeader)
      .send(makeValidRequest())

    // Response shape preserved: plan object with id
    expect(res.status).toBe(201)
    expect(res.body).toHaveProperty('id')
    expect(res.body).toHaveProperty('projectId', 'proj-1')
  })
})
