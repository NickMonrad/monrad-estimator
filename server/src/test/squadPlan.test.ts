import { beforeEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import jwt from 'jsonwebtoken'

vi.mock('../routes/snapshots.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../routes/snapshots.js')>()
  return {
    ...actual,
    buildSnapshot: vi.fn().mockResolvedValue({}),
  }
})

vi.mock('../lib/snapshotUtils.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../lib/snapshotUtils.js')>()
  return {
    ...actual,
    pruneSnapshots: vi.fn().mockResolvedValue(undefined),
  }
})

import { app } from '../index.js'
import { prisma } from '../lib/prisma.js'
import {
  deriveFeatureSpanFromWeeklyAllocations,
  stripCapacityPlanMaterialization,
} from '../routes/squadPlan.js'
import type { SchedulerResourceType } from '../lib/scheduler.js'


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

const mockProject = {
  id: 'proj-1',
  ownerId: userId,
  hoursPerDay: 8,
  startDate: new Date('2026-03-01T00:00:00.000Z'),
  name: 'Test Project',
}

const futureCapacityPlanWindow = {
  id: 'nr-capacity-plan',
  name: 'Developer 1',
  startWeek: 700,
  endWeek: 704,
  allocationPct: 100,
  allocationMode: 'CAPACITY_PLAN',
  allocationPercent: 100,
  allocationStartWeek: null,
  allocationEndWeek: null,
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('stripCapacityPlanMaterialization', () => {
  it('removes CAPACITY_PLAN windows while preserving manual availability overlays', () => {
    const manualTimelineWindow = {
      id: 'nr-timeline',
      name: 'Developer 2',
      startWeek: 0,
      endWeek: 10,
      allocationPct: 50,
      allocationMode: 'TIMELINE',
      allocationPercent: 50,
      allocationStartWeek: 2,
      allocationEndWeek: 6,
    }

    const resourceTypes: SchedulerResourceType[] = [{
      id: 'rt-dev',
      name: 'Developer',
      count: 2,
      hoursPerDay: 8,
      namedResources: [
        futureCapacityPlanWindow,
        manualTimelineWindow,
      ],
    }]

    const sanitized = stripCapacityPlanMaterialization(resourceTypes)

    expect(sanitized[0].namedResources).toEqual([manualTimelineWindow])
    expect(sanitized[0].count).toBe(2)
  })
})

describe('deriveFeatureSpanFromWeeklyAllocations', () => {
  it('derives span from first allocated week to last allocated week', () => {
    const allocations = new Map<number, Map<string, number>>([
      [2, new Map([['rt-dev', 1]])],
      [5, new Map([['rt-dev', 0.5]])],
    ])

    expect(deriveFeatureSpanFromWeeklyAllocations(allocations, 0)).toEqual({
      startWeek: 2,
      durationWeeks: 4,
    })
  })

  it('falls back to provided start week when no allocations exist', () => {
    expect(deriveFeatureSpanFromWeeklyAllocations(new Map(), 7)).toEqual({
      startWeek: 7,
      durationWeeks: 1,
    })
  })
})

describe('POST /api/projects/:projectId/squad-plan', () => {
  it('ignores applied CAPACITY_PLAN windows when generating a fresh plan', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue(mockProject as never)
    vi.mocked(prisma.epic.findMany).mockResolvedValue([
      {
        id: 'epic-1',
        name: 'Epic 1',
        order: 0,
        isActive: true,
        featureMode: 'sequential',
        scheduleMode: 'sequential',
        timelineStartWeek: null,
        features: [
          {
            id: 'feature-1',
            order: 0,
            isActive: true,
            timelineStartWeek: null,
            userStories: [
              {
                id: 'story-1',
                order: 0,
                isActive: true,
                tasks: [
                  {
                    id: 'task-1',
                    resourceTypeId: 'rt-dev',
                    hoursEffort: 8,
                    durationDays: null,
                    resourceType: { id: 'rt-dev', name: 'Developer', hoursPerDay: 8 },
                  },
                ],
                dependencies: [],
              },
            ],
            dependencies: [],
          },
        ],
      },
    ] as never)
    vi.mocked(prisma.resourceType.findMany)
      .mockResolvedValueOnce([
        {
          id: 'rt-dev',
          name: 'Developer',
          count: 1,
          hoursPerDay: 8,
          allocationMode: 'CAPACITY_PLAN',
          namedResources: [futureCapacityPlanWindow],
        },
      ] as never)
      .mockResolvedValueOnce([] as never)
    vi.mocked(prisma.timelineEntry.findMany).mockResolvedValue([] as never)
    vi.mocked(prisma.storyTimelineEntry.findMany).mockResolvedValue([] as never)
    vi.mocked(prisma.epicDependency.findMany).mockResolvedValue([] as never)

    const res = await request(app)
      .post('/api/projects/proj-1/squad-plan')
      .set('Authorization', authHeader)
      .send({
        targetDurationWeeks: 60,
        periodWeeks: 4,
        maxDeltaPerPeriod: 1,
      })

    expect(res.status).toBe(200)
    expect(res.body.error).toBeUndefined()
    expect(res.body.deliveryWeeks).toBe(1)
    expect(res.body.plannedResourceTypeIds).toEqual(['rt-dev'])
    expect(res.body.periods[0].resources[0]).toMatchObject({
      resourceTypeId: 'rt-dev',
      headcount: 0.25,
    })
  })

  it('returns 400 for invalid minFloor payload values', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue(mockProject as never)
    vi.mocked(prisma.epic.findMany).mockResolvedValue([] as never)
    vi.mocked(prisma.resourceType.findMany)
      .mockResolvedValueOnce([
        {
          id: 'rt-dev',
          name: 'Developer',
          count: 1,
          hoursPerDay: 8,
          namedResources: [],
        },
      ] as never)
      .mockResolvedValueOnce([] as never)
    vi.mocked(prisma.timelineEntry.findMany).mockResolvedValue([] as never)
    vi.mocked(prisma.storyTimelineEntry.findMany).mockResolvedValue([] as never)
    vi.mocked(prisma.epicDependency.findMany).mockResolvedValue([] as never)

    const res = await request(app)
      .post('/api/projects/proj-1/squad-plan')
      .set('Authorization', authHeader)
      .send({
        targetDurationWeeks: 12,
        periodWeeks: 4,
        maxDeltaPerPeriod: 1,
        minFloor: { 'rt-dev': -1 },
      })

    expect(res.status).toBe(400)
    expect(res.body.error).toContain('minFloor')
  })
})

describe('POST /api/projects/:projectId/squad-plan/apply', () => {
  it('returns 400 when plan periods include resource types outside the project', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue(mockProject as never)
    vi.mocked(prisma.resourceType.findMany).mockResolvedValue([{ id: 'rt-dev' }] as never)

    const res = await request(app)
      .post('/api/projects/proj-1/squad-plan/apply')
      .set('Authorization', authHeader)
      .send({
        name: 'Test plan',
        targetWeeks: 10,
        periodWeeks: 4,
        maxDelta: 1,
        periods: [
          {
            periodIndex: 0,
            startWeek: 0,
            endWeek: 4,
            entries: [
              {
                resourceTypeId: 'rt-unknown',
                headcount: 1,
                demandFTE: 0.8,
                utilisationPct: 80,
              },
            ],
          },
        ],
      })

    // Mock $transaction once for the sync-wrapped plan+RT+NR writes
    vi.mocked(prisma.$transaction).mockImplementationOnce(async (fn: any) => fn({
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
    }))

    expect(res.status).toBe(400)
    expect(res.body.error).toContain('Unknown resourceTypeId')
    expect(prisma.backlogSnapshot.create).not.toHaveBeenCalled()
  })

  it('refreshes weeklyDemandCache from the applied planner output', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue(mockProject as never)
    vi.mocked(prisma.resourceType.findMany)
      .mockResolvedValueOnce([{ id: 'rt-dev' }] as never)
      .mockResolvedValueOnce([
        {
          id: 'rt-dev',
          name: 'Developer',
          count: 1,
          hoursPerDay: 8,
          allocationMode: 'CAPACITY_PLAN',
          namedResources: [
            {
              id: 'nr-dev',
              name: 'Developer 1',
              startWeek: 52,
              endWeek: 60,
              allocationPct: 100,
              allocationMode: 'CAPACITY_PLAN',
              allocationPercent: 100,
              allocationStartWeek: null,
              allocationEndWeek: null,
            },
          ],
        },
      ] as never)
    vi.mocked(prisma.epic.findMany).mockResolvedValue([
      {
        id: 'epic-1',
        name: 'Epic 1',
        order: 0,
        isActive: true,
        featureMode: 'sequential',
        scheduleMode: 'sequential',
        timelineStartWeek: null,
        features: [
          {
            id: 'feature-1',
            name: 'Feature 1',
            order: 0,
            isActive: true,
            timelineStartWeek: null,
            userStories: [
              {
                id: 'story-1',
                order: 0,
                isActive: true,
                tasks: [
                  {
                    id: 'task-1',
                    resourceTypeId: 'rt-dev',
                    hoursEffort: 16,
                    durationDays: null,
                    resourceType: { id: 'rt-dev', name: 'Developer', hoursPerDay: 8 },
                  },
                ],
                dependencies: [],
              },
            ],
            dependencies: [],
          },
        ],
      },
    ] as never)
    vi.mocked(prisma.timelineEntry.findMany).mockResolvedValue([] as never)
    vi.mocked(prisma.storyTimelineEntry.findMany).mockResolvedValue([] as never)
    vi.mocked(prisma.epicDependency.findMany).mockResolvedValue([] as never)
    vi.mocked(prisma.backlogSnapshot.create).mockResolvedValue({ id: 'snapshot-1' } as never)
    vi.mocked(prisma.capacityPlan.updateMany).mockResolvedValue({ count: 0 } as never)
    vi.mocked(prisma.capacityPlan.create).mockResolvedValue({
      id: 'plan-1',
      projectId: 'proj-1',
      isActive: true,
      periods: [],
    } as never)
    vi.mocked(prisma.resourceType.update).mockResolvedValue({} as never)
    vi.mocked(prisma.resourceType.updateMany).mockResolvedValue({ count: 0 } as never)
    vi.mocked(prisma.namedResource.updateMany).mockResolvedValue({ count: 1 } as never)
    vi.mocked(prisma.namedResource.findMany).mockResolvedValue([{ id: 'nr-dev' }] as never)
    vi.mocked(prisma.namedResource.update).mockResolvedValue({} as never)
    vi.mocked(prisma.epic.update).mockResolvedValue({} as never)
    vi.mocked(prisma.project.update).mockResolvedValue({
      ...mockProject,
      weeklyDemandCache: { 'rt-dev|0': 2 },
    } as never)

    // Mock $transaction once for the sync-wrapped plan+RT+NR writes
    vi.mocked(prisma.$transaction).mockImplementationOnce(async (fn: any) => fn({
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
    }))

    const res = await request(app)
      .post('/api/projects/proj-1/squad-plan/apply')
      .set('Authorization', authHeader)
      .send({
        name: 'Applied plan',
        targetWeeks: 4,
        periodWeeks: 4,
        maxDelta: 1,
        setActive: true,
        periods: [
          {
            periodIndex: 0,
            startWeek: 0,
            endWeek: 4,
            entries: [
              {
                resourceTypeId: 'rt-dev',
                headcount: 1,
                demandFTE: 0.5,
                utilisationPct: 50,
              },
            ],
          },
        ],
        levellingResult: {
          epicStartWeeks: { 'epic-1': 0 },
          featureStartWeeks: { 'feature-1': 0 },
          totalDeliveryWeeks: 1,
          peakUtilisationPct: 40,
        },
      })

    expect(res.status).toBe(201)
    expect(prisma.project.update).toHaveBeenCalledWith({
      where: { id: 'proj-1' },
      data: { weeklyDemandCache: { 'rt-dev|0': 2 } },
    })
  })

  it('replays applied reduced-period capacity into weeklyDemandCache', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue(mockProject as never)
    vi.mocked(prisma.resourceType.findMany)
      .mockResolvedValueOnce([{ id: 'rt-dev' }] as never)
      .mockResolvedValueOnce([
        {
          id: 'rt-dev',
          name: 'Developer',
          count: 1,
          hoursPerDay: 8,
          allocationMode: 'CAPACITY_PLAN',
          namedResources: [
            {
              id: 'nr-dev-1',
              name: 'Developer 1',
              startWeek: 52,
              endWeek: 60,
              allocationPct: 100,
              allocationMode: 'CAPACITY_PLAN',
              allocationPercent: 100,
              allocationStartWeek: null,
              allocationEndWeek: null,
            },
          ],
        },
      ] as never)
    vi.mocked(prisma.epic.findMany).mockResolvedValue([
      {
        id: 'epic-1',
        name: 'Epic 1',
        order: 0,
        isActive: true,
        featureMode: 'sequential',
        scheduleMode: 'sequential',
        timelineStartWeek: null,
        features: [
          {
            id: 'feature-1',
            name: 'Feature 1',
            order: 0,
            isActive: true,
            timelineStartWeek: null,
            userStories: [
              {
                id: 'story-1',
                order: 0,
                isActive: true,
                tasks: [
                  {
                    id: 'task-1',
                    resourceTypeId: 'rt-dev',
                    hoursEffort: 240,
                    durationDays: null,
                    resourceType: { id: 'rt-dev', name: 'Developer', hoursPerDay: 8 },
                  },
                ],
                dependencies: [],
              },
            ],
            dependencies: [],
          },
        ],
      },
    ] as never)
    vi.mocked(prisma.timelineEntry.findMany).mockResolvedValue([] as never)
    vi.mocked(prisma.storyTimelineEntry.findMany).mockResolvedValue([] as never)
    vi.mocked(prisma.epicDependency.findMany).mockResolvedValue([] as never)
    vi.mocked(prisma.backlogSnapshot.create).mockResolvedValue({ id: 'snapshot-1' } as never)
    vi.mocked(prisma.capacityPlan.updateMany).mockResolvedValue({ count: 0 } as never)
    vi.mocked(prisma.capacityPlan.create).mockResolvedValue({
      id: 'plan-1',
      projectId: 'proj-1',
      isActive: true,
      periods: [],
    } as never)
    vi.mocked(prisma.resourceType.update).mockResolvedValue({} as never)
    vi.mocked(prisma.resourceType.updateMany).mockResolvedValue({ count: 0 } as never)
    vi.mocked(prisma.namedResource.updateMany).mockResolvedValue({ count: 1 } as never)
    vi.mocked(prisma.namedResource.findMany)
      .mockResolvedValueOnce([{ id: 'nr-dev-1' }, { id: 'nr-dev-2' }] as never)
      .mockResolvedValueOnce([{ id: 'nr-dev-1' }, { id: 'nr-dev-2' }] as never)
    vi.mocked(prisma.namedResource.update).mockResolvedValue({} as never)
    vi.mocked(prisma.epic.update).mockResolvedValue({} as never)
    vi.mocked(prisma.project.update).mockResolvedValue({
      ...mockProject,
      weeklyDemandCache: {},
    } as never)

    // Mock $transaction once for the sync-wrapped plan+RT+NR writes
    vi.mocked(prisma.$transaction).mockImplementationOnce(async (fn: any) => fn({
      capacityPlan: { updateMany: vi.fn().mockResolvedValue({ count: 0 }), create: vi.fn().mockResolvedValue({ id: 'plan-1', projectId: 'proj-1', isActive: true, periods: [] }) },
      resourceType: { update: vi.fn().mockResolvedValue({}), updateMany: vi.fn().mockResolvedValue({ count: 0 }), findUnique: vi.fn().mockResolvedValue({ name: 'Developer' }) },
      namedResource: { updateMany: vi.fn().mockResolvedValue({ count: 1 }), findMany: vi.fn().mockResolvedValue([{ id: 'nr-dev-1' }, { id: 'nr-dev-2' }]), createMany: vi.fn().mockResolvedValue({ count: 0 }), update: vi.fn().mockResolvedValue({}), delete: vi.fn(), count: vi.fn().mockResolvedValue(0) },
      capacityProfile: { findMany: vi.fn().mockResolvedValue([]), create: vi.fn().mockResolvedValue({ id: 'cp-1' }), update: vi.fn(), deleteMany: vi.fn() },
      capacitySegment: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }), create: vi.fn() },
      project: { findFirst: vi.fn().mockResolvedValue({ id: 'proj-1', resourceTypes: [], capacityPlans: [] }), update: vi.fn() },
      timelineEntry: { deleteMany: vi.fn(), createMany: vi.fn() },
      storyTimelineEntry: { deleteMany: vi.fn(), createMany: vi.fn() },
      epic: { update: vi.fn(), findMany: vi.fn() },
      epicDependency: { findMany: vi.fn() },
      storyDependency: { findMany: vi.fn() },
    }))

    const res = await request(app)
      .post('/api/projects/proj-1/squad-plan/apply')
      .set('Authorization', authHeader)
      .send({
        name: 'Applied plan with taper',
        targetWeeks: 8,
        periodWeeks: 4,
        maxDelta: 1,
        setActive: true,
        periods: [
          {
            periodIndex: 0,
            startWeek: 0,
            endWeek: 4,
            entries: [
              {
                resourceTypeId: 'rt-dev',
                headcount: 1,
                demandFTE: 1,
                utilisationPct: 100,
              },
            ],
          },
          {
            periodIndex: 1,
            startWeek: 4,
            endWeek: 8,
            entries: [
              {
                resourceTypeId: 'rt-dev',
                headcount: 0.5,
                demandFTE: 0.5,
                utilisationPct: 100,
              },
            ],
          },
        ],
        levellingResult: {
          epicStartWeeks: { 'epic-1': 0 },
          featureStartWeeks: { 'feature-1': 0 },
          totalDeliveryWeeks: 8,
          peakUtilisationPct: 100,
        },
      })

    expect(res.status).toBe(201)
    const projectUpdateArg = vi.mocked(prisma.project.update).mock.calls.at(-1)?.[0]
    const weeklyDemandCache = projectUpdateArg?.data?.weeklyDemandCache as Record<string, number>
    expect(weeklyDemandCache['rt-dev|0']).toBeCloseTo(5, 6)
    expect(weeklyDemandCache['rt-dev|4']).toBeCloseTo(2.5, 6)
    expect(weeklyDemandCache['rt-dev|4']).toBeLessThan(5)
  })
})
