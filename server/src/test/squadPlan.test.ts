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
vi.mock('../lib/squadPlannerProfileWriter.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../lib/squadPlannerProfileWriter.js')>()
  return {
    ...actual,
    revalidatePlannerPlan: vi.fn().mockResolvedValue(undefined),
    capturePlannerAuthority: vi.fn().mockResolvedValue({ activePlanId: 'plan-previous', activePlanResourceTypeIds: new Set<string>(['rt-dev']), plannerRoleResourceTypeIds: new Set<string>(), allPlannerResourceTypeIds: new Set<string>() }),
  }
})

import * as writerModule from '../lib/squadPlannerProfileWriter.js'

import { app } from '../index.js'

import { prisma } from '../lib/prisma.js'
import {
  deriveFeatureSpanFromWeeklyAllocations,
  stripCapacityPlanMaterialization,
  buildReplayPlannerResourceTypes,
} from '../routes/squadPlan.js'
import { buildSnapshot } from '../routes/snapshots.js'
import type { CapacityPlanSlotWindow } from '../lib/capacityPlanMaterialisation.js'
import type { SchedulerResourceType } from '../lib/scheduler.js'
import { getWeeklyCapacity } from '../lib/scheduler.js'
import { pruneSnapshots } from '../lib/snapshotUtils.js'

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

const mockCapacityProfiles = (
  rtId = 'rt-dev',
  namedResourceId: string | null = 'nr-capacity-plan',
  roleSource: 'FIXED' | 'SQUAD_PLANNER' = 'FIXED',
) => [
  {
    id: 'cp-role',
    projectId: 'proj-1',
    resourceTypeId: rtId,
    namedResourceId: null,
    ownerKind: 'ROLE',
    planningBasis: roleSource === 'SQUAD_PLANNER' ? 'CAPACITY_PROFILE' : 'DEMAND_FOLLOWING',
    source: roleSource,
    defaultPercent: 100,
    startWeek: null,
    endWeek: null,
    legacy: null,
    createdAt: new Date(),
    segments: [],
  },
  ...(namedResourceId
    ? [{
        id: 'cp-nr',
        projectId: 'proj-1',
        resourceTypeId: null,
        namedResourceId,
        ownerKind: 'NAMED_PERSON',
        planningBasis: 'DEMAND_FOLLOWING',
        source: 'FIXED',
        defaultPercent: 100,
        startWeek: null,
        endWeek: null,
        legacy: null,
        createdAt: new Date(),
        segments: [],
      }]
    : []),
]

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
  vi.mocked(prisma.resourceType.findUnique).mockResolvedValue({ id: 'rt-dev', name: 'Developer', projectId: 'proj-1' } as never)
  vi.mocked(prisma.backlogSnapshot.delete).mockResolvedValue({} as never)
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
    vi.mocked(prisma.capacityProfile.findMany).mockResolvedValue(mockCapacityProfiles() as never)
    vi.mocked(prisma.capacityPlan.findFirst).mockResolvedValue(null as never)
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
    vi.mocked(prisma.capacityProfile.findMany).mockResolvedValue(mockCapacityProfiles('rt-dev', null) as never)
    vi.mocked(prisma.capacityPlan.findFirst).mockResolvedValue(null as never)
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
  beforeEach(() => {
    vi.mocked(prisma.resourceType.findUnique).mockResolvedValue({
      id: 'rt-dev',
      name: 'Developer',
      projectId: 'proj-1',
    } as never)
  })
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


    expect(res.status).toBe(400)
    expect(res.body.error).toContain('Unknown resourceTypeId')
    expect(prisma.backlogSnapshot.create).not.toHaveBeenCalled()
  })

/** Where-aware capacityProfile.findMany mock: role vs named-resource queries. */
function mockCapacityProfilesForApply(rtId = 'rt-dev', namedResourceIds: string[] | null = ['nr-dev']) {
  const profiles = mockCapacityProfiles(rtId, namedResourceIds?.[0] ?? null, 'SQUAD_PLANNER') as Array<Record<string, unknown>>
  vi.mocked(prisma.capacityProfile.findMany).mockImplementation((async (args: any) => {
    const where = args?.where ?? {}
    if (where.resourceTypeId) {
      return Promise.resolve(profiles.filter(p => p.resourceTypeId === where.resourceTypeId) as never)
    }
    if (where.namedResourceId) {
      const ids = Array.isArray(where.namedResourceId?.in) ? where.namedResourceId.in : [where.namedResourceId]
      return Promise.resolve(profiles.filter(p => ids.includes(p.namedResourceId)) as never)
    }
    return profiles as never
  }) as any)
}

  it('refreshes demand from effort and preserves duration-weighted story spans', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue(mockProject as never)
    mockCapacityProfilesForApply()
    vi.mocked(prisma.capacityPlan.findFirst).mockResolvedValue(null as never)
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
                    hoursEffort: 80,
                    durationDays: 20,
                    resourceType: { id: 'rt-dev', name: 'Developer', hoursPerDay: 8 },
                  },
                ],
                dependencies: [],
              },
              {
                id: 'story-2',
                order: 1,
                isActive: true,
                tasks: [
                  {
                    id: 'task-2',
                    resourceTypeId: 'rt-dev',
                    hoursEffort: 80,
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
    vi.mocked(prisma.namedResource.findMany).mockResolvedValue([{ id: 'nr-dev', name: 'Developer 1', createdAt: new Date('2026-01-01'), allocationMode: 'CAPACITY_PLAN' }] as never)
    vi.mocked(prisma.namedResource.update).mockResolvedValue({} as never)
    let capturedTx!: Record<string, any>
    vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) => {
      capturedTx = {
      capacityPlan: {
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        findFirst: vi.fn().mockResolvedValue({ id: 'plan-1', periods: [{ entries: [{ resourceTypeId: 'rt-dev' }] }] }),
        create: vi.fn().mockResolvedValue({ id: 'plan-1', projectId: 'proj-1', isActive: true, periods: [] }),
      },
      resourceType: {
        update: vi.fn().mockResolvedValue({}),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        findMany: vi.fn().mockResolvedValue([]),
        findUnique: vi.fn().mockResolvedValue({ id: 'rt-dev', name: 'Developer', projectId: 'proj-1' }),
      },
      namedResource: { updateMany: vi.fn().mockResolvedValue({ count: 1 }), findMany: vi.fn().mockResolvedValue([{ id: 'nr-dev', name: 'Developer 1', createdAt: new Date('2026-01-01'), allocationMode: 'CAPACITY_PLAN' }]), createMany: vi.fn().mockResolvedValue({ count: 0 }), update: vi.fn().mockResolvedValue({}), delete: vi.fn(), count: vi.fn().mockResolvedValue(0) },
      capacityProfile: { findMany: vi.fn().mockResolvedValue([]), findFirst: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue({ id: 'cp-1' }), update: vi.fn().mockResolvedValue({}), deleteMany: vi.fn() },
      capacitySegment: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }), create: vi.fn(), createMany: vi.fn().mockResolvedValue({ count: 0 }) },
      project: { findFirst: vi.fn().mockResolvedValue({ id: 'proj-1', resourceTypes: [], capacityPlans: [] }), update: vi.fn() },
      timelineEntry: { deleteMany: vi.fn(), createMany: vi.fn() },
      storyTimelineEntry: { deleteMany: vi.fn(), createMany: vi.fn() },
      epic: { update: vi.fn(), findMany: vi.fn() },
      epicDependency: { findMany: vi.fn() },
      storyDependency: { findMany: vi.fn() },
      }
      return fn(capturedTx)
    })

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
    const projectUpdateArg = capturedTx.project.update.mock.calls.at(-1)?.[0]
    const weeklyDemandCache = projectUpdateArg?.data?.weeklyDemandCache as Record<string, number>
    expect(Object.values(weeklyDemandCache).reduce((sum, days) => sum + days, 0)).toBeCloseTo(20, 6)
    expect(weeklyDemandCache['rt-dev|0']).toBeCloseTo(5, 6)

    const storyRows = capturedTx.storyTimelineEntry.createMany.mock.calls.at(-1)?.[0]?.data
    expect(storyRows).toEqual(expect.arrayContaining([
      expect.objectContaining({ storyId: 'story-1', durationWeeks: 3 }),
      expect.objectContaining({ storyId: 'story-2', durationWeeks: 2 }),
    ]))
  })

  it('replays applied reduced-period capacity into weeklyDemandCache', async () => {
    mockCapacityProfilesForApply('rt-dev', ['nr-dev-1', 'nr-dev-2'])
    vi.mocked(prisma.capacityPlan.findFirst).mockResolvedValue(null as never)
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
      .mockResolvedValueOnce([{ id: 'nr-dev-1', name: 'Developer 1', createdAt: new Date('2026-01-01'), allocationMode: 'CAPACITY_PLAN' }, { id: 'nr-dev-2', name: 'Developer 2', createdAt: new Date('2026-01-02'), allocationMode: 'CAPACITY_PLAN' }] as never)
      .mockResolvedValueOnce([{ id: 'nr-dev-1', name: 'Developer 1', createdAt: new Date('2026-01-01'), allocationMode: 'CAPACITY_PLAN' }, { id: 'nr-dev-2', name: 'Developer 2', createdAt: new Date('2026-01-02'), allocationMode: 'CAPACITY_PLAN' }] as never)
    vi.mocked(prisma.namedResource.update).mockResolvedValue({} as never)
    let capturedTx!: Record<string, any>
    vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) => {
      capturedTx = {
      capacityPlan: {
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        findFirst: vi.fn().mockResolvedValue({ id: 'plan-1', periods: [{ entries: [{ resourceTypeId: 'rt-dev' }] }] }),
        create: vi.fn().mockResolvedValue({ id: 'plan-1', projectId: 'proj-1', isActive: true, periods: [] }),
      },
      resourceType: {
        update: vi.fn().mockResolvedValue({}),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        findMany: vi.fn().mockResolvedValue([]),
        findUnique: vi.fn().mockResolvedValue({ id: 'rt-dev', name: 'Developer', projectId: 'proj-1' }),
      },
      namedResource: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findMany: vi.fn().mockImplementation(async (args: any) => {
          const ids = args?.where?.id?.in as string[] | undefined
          if (ids) return ids.map(id => ({ id, resourceTypeId: 'rt-dev', name: 'Developer ' + id.slice(-1), createdAt: new Date('2026-01-01'), allocationMode: 'CAPACITY_PLAN' }))
          return [
            { id: 'nr-dev-1', name: 'Developer 1', createdAt: new Date('2026-01-01'), allocationMode: 'CAPACITY_PLAN' },
            { id: 'nr-dev-2', name: 'Developer 2', createdAt: new Date('2026-01-02'), allocationMode: 'CAPACITY_PLAN' },
          ]
        }),
        createMany: vi.fn().mockResolvedValue({ count: 0 }),
        update: vi.fn().mockResolvedValue({}),
        delete: vi.fn(),
        count: vi.fn().mockResolvedValue(0),
      },
      capacityProfile: { findMany: vi.fn().mockResolvedValue([]), findFirst: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue({ id: 'cp-1' }), update: vi.fn().mockResolvedValue({}), deleteMany: vi.fn() },
      capacitySegment: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }), create: vi.fn(), createMany: vi.fn().mockResolvedValue({ count: 0 }) },
      project: { findFirst: vi.fn().mockResolvedValue({ id: 'proj-1', resourceTypes: [], capacityPlans: [] }), update: vi.fn() },
      timelineEntry: { deleteMany: vi.fn(), createMany: vi.fn() },
      storyTimelineEntry: { deleteMany: vi.fn(), createMany: vi.fn() },
      epic: { update: vi.fn(), findMany: vi.fn() },
      epicDependency: { findMany: vi.fn() },
      storyDependency: { findMany: vi.fn() },
      }
      return fn(capturedTx)
    })

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
    expect(capturedTx.project.update).toHaveBeenCalled()
    const projectUpdateArg = capturedTx.project.update.mock.calls.at(-1)?.[0]
    const weeklyDemandCache = projectUpdateArg?.data?.weeklyDemandCache as Record<string, number>
    expect(weeklyDemandCache['rt-dev|0']).toBeCloseTo(5, 6)
    expect(weeklyDemandCache['rt-dev|4']).toBeCloseTo(2.5, 6)
    expect(weeklyDemandCache['rt-dev|4']).toBeLessThan(5)
  })

  it('returns 500 when buildSnapshot rejects, preventing snapshot persistence and mutation', async () => {
    mockCapacityProfilesForApply()
    vi.mocked(prisma.capacityPlan.findFirst).mockResolvedValue(null as never)
    vi.mocked(prisma.project.findFirst).mockResolvedValue(mockProject as never)
    vi.mocked(prisma.resourceType.findMany).mockResolvedValue([{ id: 'rt-dev' }] as never)
    vi.mocked(buildSnapshot).mockRejectedValueOnce(new Error('Snapshot null-state rejection'))

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
                resourceTypeId: 'rt-dev',
                headcount: 1,
                demandFTE: 0.8,
                utilisationPct: 80,
              },
            ],
          },
        ],
      })

    expect(res.status).toBe(500)
    expect(prisma.backlogSnapshot.create).not.toHaveBeenCalled()
    expect(prisma.$transaction).not.toHaveBeenCalled()
  })

  it('does not create snapshot or prune when setActive is false', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue(mockProject as never)
    vi.mocked(prisma.resourceType.findMany).mockResolvedValue([{ id: 'rt-dev' }] as never)

    const res = await request(app)
      .post('/api/projects/proj-1/squad-plan/apply')
      .set('Authorization', authHeader)
      .send({
        name: 'Inactive plan',
        targetWeeks: 10,
        periodWeeks: 4,
        maxDelta: 1,
        setActive: false,
        periods: [
          {
            periodIndex: 0,
            startWeek: 0,
            endWeek: 4,
            entries: [
              {
                resourceTypeId: 'rt-dev',
                headcount: 1,
                demandFTE: 0.8,
                utilisationPct: 80,
              },
            ],
          },
        ],
      })

    expect(res.status).toBe(201)
    expect(prisma.backlogSnapshot.create).not.toHaveBeenCalled()
    expect(pruneSnapshots).not.toHaveBeenCalled()
  })

  it('returns 409 when revalidatePlannerPlan detects a transaction-time conflict, deletes new snapshot', async () => {
    const conflictError = new writerModule.PlannerConflictError('test conflict', [])
    vi.mocked(writerModule.revalidatePlannerPlan).mockRejectedValueOnce(conflictError)
    vi.mocked(prisma.project.findFirst).mockResolvedValue(mockProject as never)
    mockCapacityProfilesForApply('rt-dev', null)
    vi.mocked(prisma.capacityPlan.findFirst).mockResolvedValue(null as never)
    vi.mocked(prisma.resourceType.findMany).mockResolvedValue([{ id: 'rt-dev' }] as never)
    vi.mocked(prisma.backlogSnapshot.create).mockResolvedValue({ id: 'test-snapshot-id' } as never)
    vi.mocked(prisma.backlogSnapshot.delete).mockResolvedValue({ id: 'test-snapshot-id' } as never)

    const res = await request(app)
      .post('/api/projects/proj-1/squad-plan/apply')
      .set('Authorization', authHeader)
      .send({
        name: 'Race plan',
        targetWeeks: 10,
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
                demandFTE: 0.8,
                utilisationPct: 80,
              },
            ],
          },
        ],
      })

    expect(res.status).toBe(409)
    expect(prisma.backlogSnapshot.create).toHaveBeenCalled()
    expect(prisma.backlogSnapshot.delete).toHaveBeenCalledWith({ where: { id: 'test-snapshot-id' } })
  })
})

describe('buildReplayPlannerResourceTypes (fix 3)', () => {
  it('clears roleSegments when resource type is in the proposed plan', () => {
    const existingRT: SchedulerResourceType = {
      id: 'rt-dev',
      name: 'Developer',
      count: 3,
      hoursPerDay: 8,
      allocationMode: 'CAPACITY_PLAN',
      namedResources: [],
      roleSegments: [
        { startWeek: 0, endWeek: 10, allocationPercent: 100 },
      ],
    }

    const slotWindows = new Map<string, CapacityPlanSlotWindow[]>()
    slotWindows.set('rt-dev', [
      { startWeek: 2, endWeek: 6, allocationPercent: 100 },
      { startWeek: 2, endWeek: 6, allocationPercent: 50 },
    ])

    const maxHeadcount = new Map<string, number>()
    maxHeadcount.set('rt-dev', 2)

    const result = buildReplayPlannerResourceTypes(
      [existingRT],
      slotWindows,
      maxHeadcount,
    )

    const replayed = result.find(rt => rt.id === 'rt-dev')!
    // roleSegments must be cleared — the proposed plan IS the authority
    expect(replayed.roleSegments).toBeUndefined()
    // Named resources come from proposed plan, not old roleSegments
    expect(replayed.namedResources).toHaveLength(2)
  })

  it('replay capacity equals only the proposed plan, not old roleSegments', () => {
    // If roleSegments survived, getWeeklyCapacity would sum both
    const existingRT: SchedulerResourceType = {
      id: 'rt-dev',
      name: 'Developer',
      count: 3,
      hoursPerDay: 8,
      allocationMode: 'CAPACITY_PLAN',
      namedResources: [],
      roleSegments: [
        { startWeek: 0, endWeek: 10, allocationPercent: 100 },
      ],
    }

    const slotWindows = new Map<string, CapacityPlanSlotWindow[]>()
    slotWindows.set('rt-dev', [
      { startWeek: 0, endWeek: 10, allocationPercent: 50 },
    ])

    const maxHeadcount = new Map<string, number>()
    maxHeadcount.set('rt-dev', 1)

    const result = buildReplayPlannerResourceTypes(
      [existingRT],
      slotWindows,
      maxHeadcount,
    )

    const replayed = result.find(rt => rt.id === 'rt-dev')!
    expect(replayed.roleSegments).toBeUndefined()

    // Single NR at 50% = 20h/week (not role 100% = 40h)
    const capacity = getWeeklyCapacity(replayed, 5, 8)
    // 50% of 40h = 20h exactly (proposed plan only, no old roleSegments)
    expect(capacity).toBe(20)
  })

  it('unaffected resource types keep their roleSegments', () => {
    const existingRTs: SchedulerResourceType[] = [
      {
        id: 'rt-affected',
        name: 'Affected',
        count: 2,
        hoursPerDay: 8,
        allocationMode: 'EFFORT',
        namedResources: [],
        roleSegments: [
          { startWeek: 0, endWeek: 10, allocationPercent: 50 },
        ],
      },
      {
        id: 'rt-unaffected',
        name: 'Unaffected',
        count: 1,
        hoursPerDay: 8,
        allocationMode: 'EFFORT',
        namedResources: [],
        roleSegments: [
          { startWeek: 0, endWeek: 10, allocationPercent: 100 },
        ],
      },
    ]

    const slotWindows = new Map<string, CapacityPlanSlotWindow[]>()
    slotWindows.set('rt-affected', [
      { startWeek: 0, endWeek: 10, allocationPercent: 100 },
    ])

    const maxHeadcount = new Map<string, number>()
    maxHeadcount.set('rt-affected', 1)

    const result = buildReplayPlannerResourceTypes(
      existingRTs,
      slotWindows,
      maxHeadcount,
    )

    const affected = result.find(rt => rt.id === 'rt-affected')!
    expect(affected.roleSegments).toBeUndefined()

    const unaffected = result.find(rt => rt.id === 'rt-unaffected')!
    expect(unaffected.roleSegments).toBeDefined()
    expect(unaffected.roleSegments).toHaveLength(1)
  })

  it('reapplying the same plan produces deterministic results', () => {
    const existingRT: SchedulerResourceType = {
      id: 'rt-dev',
      name: 'Developer',
      count: 3,
      hoursPerDay: 8,
      allocationMode: 'CAPACITY_PLAN',
      namedResources: [],
      roleSegments: [
        { startWeek: 0, endWeek: 10, allocationPercent: 100 },
      ],
    }

    const slotWindows = new Map<string, CapacityPlanSlotWindow[]>()
    slotWindows.set('rt-dev', [
      { startWeek: 0, endWeek: 10, allocationPercent: 75 },
    ])

    const maxHeadcount = new Map<string, number>()
    maxHeadcount.set('rt-dev', 1)

    const result1 = buildReplayPlannerResourceTypes(
      [existingRT], slotWindows, maxHeadcount,
    )
    const result2 = buildReplayPlannerResourceTypes(
      [existingRT], slotWindows, maxHeadcount,
    )

    expect(result1).toEqual(result2)
  })
})

describe('generation roleSegments empty-array conversion (fix #362 regression)', () => {
  it('converts empty roleSegments to undefined (count-based capacity)', () => {
    // Simulates a resource type after a Squad Planner apply:
    // the resolver returns roleSegments=[] to suppress aggregate ROLE
    // capacity overlap. The generation boundary must convert this to
    // undefined so the SA planner uses count-based phantom-slot capacity.
    const rts: SchedulerResourceType[] = [
      {
        id: 'rt-dev', name: 'Developer', count: 3, hoursPerDay: 8,
        allocationMode: 'EFFORT',
        namedResources: [],
        roleSegments: [] as SchedulerResourceType['roleSegments'],
      },
    ]

    // Apply the same conversion the generation endpoint uses
    for (const rt of rts) {
      if (Array.isArray(rt.roleSegments) && rt.roleSegments.length === 0) {
        rt.roleSegments = undefined
      }
    }

    expect(rts[0].roleSegments).toBeUndefined()
    // count=3, no named resources → 3 × 40 = 120h (phantom slots, not 0)
    expect(getWeeklyCapacity(rts[0], 0, 8)).toBe(120)
  })

  it('preserves non-empty ROLE profile segments (profile-first authority)', () => {
    // A valid persisted ROLE profile with allocationPercent=50 must
    // survive the generation boundary unchanged — planner capacity stays
    // constrained to the profile, not replaced by count-based phantoms.
    const rts: SchedulerResourceType[] = [
      {
        id: 'rt-dev', name: 'Developer', count: 3, hoursPerDay: 8,
        allocationMode: 'EFFORT',
        namedResources: [],
        roleSegments: [
          { startWeek: 0, endWeek: 8, allocationPercent: 50 },
        ],
      },
    ]

    // Apply the same conversion the generation endpoint uses
    for (const rt of rts) {
      if (Array.isArray(rt.roleSegments) && rt.roleSegments.length === 0) {
        rt.roleSegments = undefined
      }
    }

    // Non-empty profile is preserved — segments unchanged
    expect(rts[0].roleSegments).toEqual([
      { startWeek: 0, endWeek: 8, allocationPercent: 50 },
    ])
    // 50% × 40h = 20h (NOT 3 × 40h = 120h count-based phantom)
    expect(getWeeklyCapacity(rts[0], 0, 8)).toBe(20)
  })
})
