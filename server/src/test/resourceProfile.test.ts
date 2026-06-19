import { beforeEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { app } from '../index.js'
import { prisma } from '../lib/prisma.js'

process.env.JWT_SECRET = 'test-secret'

const userId = 'user-1'
const token = jwt.sign({ userId }, 'test-secret')
const authHeader = `Bearer ${token}`

beforeEach(() => vi.clearAllMocks())

describe('GET /api/projects/:projectId/resource-profile', () => {
  it('uses task.durationDays when provided', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue({
      id: 'proj-1',
      ownerId: userId,
      hoursPerDay: 8,
      bufferWeeks: 0,
      onboardingWeeks: 0,
      resourceTypes: [
        {
          id: 'rt-dev',
          name: 'Developer',
          category: 'ENGINEERING',
          count: 1,
          hoursPerDay: 8,
          allocationMode: 'EFFORT',
          allocationPercent: 100,
          allocationStartWeek: null,
          allocationEndWeek: null,
          dayRate: null,
          globalType: null,
          namedResources: [],
        },
      ],
      epics: [
        {
          id: 'epic-1',
          name: 'Delivery',
          order: 0,
          isActive: true,
          features: [
            {
              id: 'feat-1',
              name: 'Build',
              order: 0,
              isActive: true,
              userStories: [
                {
                  id: 'story-1',
                  name: 'Implement',
                  order: 0,
                  isActive: true,
                  tasks: [
                    {
                      id: 'task-1',
                      hoursEffort: 8,
                      durationDays: 3,
                      resourceTypeId: 'rt-dev',
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
      overheads: [],
      timelineEntries: [],
      storyTimelineEntries: [],
      capacityPlans: [],
    } as any)

    const res = await request(app)
      .get('/api/projects/proj-1/resource-profile')
      .set('Authorization', authHeader)

    expect(res.status).toBe(200)
    const devRow = res.body.resourceRows.find((row: any) => row.resourceTypeId === 'rt-dev')
    expect(devRow).toBeTruthy()
    expect(devRow.effortDays).toBe(3)
    expect(devRow.totalDays).toBe(3)
  })

  it('falls back to active CAPACITY_PLAN periods when persisted named-resource windows are stale', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue({
      id: 'proj-1',
      ownerId: userId,
      hoursPerDay: 8,
      bufferWeeks: 0,
      onboardingWeeks: 0,
      resourceTypes: [
        {
          id: 'rt-security',
          name: 'Security',
          category: 'ENGINEERING',
          count: 1,
          hoursPerDay: 8,
          allocationMode: 'CAPACITY_PLAN',
          allocationPercent: 100,
          allocationStartWeek: null,
          allocationEndWeek: null,
          dayRate: null,
          globalType: null,
          namedResources: [
            {
              id: 'nr-security',
              name: 'Principal Consultant - Security',
              allocationMode: 'CAPACITY_PLAN',
              allocationPercent: 100,
              allocationStartWeek: null,
              allocationEndWeek: null,
              startWeek: null,
              endWeek: null,
            },
          ],
        },
      ],
      epics: [
        {
          id: 'epic-1',
          name: 'Security',
          order: 0,
          isActive: true,
          features: [
            {
              id: 'feat-1',
              name: 'Security Design',
              order: 0,
              isActive: true,
              userStories: [
                {
                  id: 'story-1',
                  name: 'Threat model',
                  order: 0,
                  isActive: true,
                  tasks: [
                    {
                      id: 'task-1',
                      hoursEffort: 80,
                      resourceTypeId: 'rt-security',
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
      overheads: [],
      timelineEntries: [
        { featureId: 'feat-1', startWeek: 4, durationWeeks: 12 },
      ],
      storyTimelineEntries: [],
      capacityPlans: [
        {
          id: 'plan-1',
          isActive: true,
          periods: [
            { periodIndex: 0, startWeek: 0, endWeek: 4, entries: [{ resourceTypeId: 'rt-security', headcount: 0 }] },
            { periodIndex: 1, startWeek: 4, endWeek: 8, entries: [{ resourceTypeId: 'rt-security', headcount: 1 }] },
            { periodIndex: 2, startWeek: 8, endWeek: 12, entries: [{ resourceTypeId: 'rt-security', headcount: 0 }] },
            { periodIndex: 3, startWeek: 12, endWeek: 16, entries: [{ resourceTypeId: 'rt-security', headcount: 1 }] },
          ],
        },
      ],
    } as any)

    const res = await request(app)
      .get('/api/projects/proj-1/resource-profile')
      .set('Authorization', authHeader)

    expect(res.status).toBe(200)

    const securityRow = res.body.resourceRows.find((row: any) => row.resourceTypeId === 'rt-security')
    expect(securityRow).toBeTruthy()
    expect(securityRow.allocatedDays).toBe(40)
    expect(securityRow.namedResources).toEqual([
      expect.objectContaining({
        name: 'Principal Consultant - Security',
        allocationMode: 'CAPACITY_PLAN',
        startWeek: 4,
        endWeek: 7,
        allocatedDays: 20,
      }),
      expect.objectContaining({
        name: 'Security 2',
        allocationMode: 'CAPACITY_PLAN',
        startWeek: 12,
        endWeek: 15,
        allocatedDays: 20,
      }),
    ])
  })

  it('uses fractional CAPACITY_PLAN headcount for low-demand roles without inflating allocated days', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue({
      id: 'proj-1',
      ownerId: userId,
      hoursPerDay: 8,
      bufferWeeks: 0,
      onboardingWeeks: 0,
      resourceTypes: [
        {
          id: 'rt-security',
          name: 'Security',
          category: 'ENGINEERING',
          count: 1,
          hoursPerDay: 8,
          allocationMode: 'CAPACITY_PLAN',
          allocationPercent: 100,
          allocationStartWeek: null,
          allocationEndWeek: null,
          dayRate: null,
          globalType: null,
          namedResources: [],
        },
      ],
      epics: [
        {
          id: 'epic-1',
          name: 'Security',
          order: 0,
          isActive: true,
          features: [
            {
              id: 'feat-1',
              name: 'Security Design',
              order: 0,
              isActive: true,
              userStories: [
                {
                  id: 'story-1',
                  name: 'Threat model',
                  order: 0,
                  isActive: true,
                  tasks: [
                    {
                      id: 'task-1',
                      hoursEffort: 166,
                      resourceTypeId: 'rt-security',
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
      overheads: [],
      timelineEntries: [
        { featureId: 'feat-1', startWeek: 0, durationWeeks: 16 },
      ],
      storyTimelineEntries: [],
      capacityPlans: [
        {
          id: 'plan-1',
          isActive: true,
          periods: [
            { periodIndex: 0, startWeek: 0, endWeek: 16, entries: [{ resourceTypeId: 'rt-security', headcount: 0.25 }] },
          ],
        },
      ],
    } as any)

    const res = await request(app)
      .get('/api/projects/proj-1/resource-profile')
      .set('Authorization', authHeader)

    expect(res.status).toBe(200)

    const securityRow = res.body.resourceRows.find((row: any) => row.resourceTypeId === 'rt-security')
    expect(securityRow).toBeTruthy()
    expect(securityRow.allocatedDays).toBe(20)
    expect(securityRow.namedResources).toEqual([
      expect.objectContaining({
        allocationMode: 'CAPACITY_PLAN',
        allocationPercent: 25,
        startWeek: 0,
        endWeek: 15,
        allocatedDays: 20,
      }),
    ])
  })

  it('includes derived actual assignment weeks for named resources', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue({
      id: 'proj-1',
      ownerId: userId,
      hoursPerDay: 8,
      bufferWeeks: 0,
      onboardingWeeks: 0,
      weeklyDemandCache: {
        'Security|12': 3.6,
      },
      resourceTypes: [
        {
          id: 'rt-security',
          name: 'Security',
          category: 'ENGINEERING',
          count: 1,
          hoursPerDay: 8,
          allocationMode: 'EFFORT',
          allocationPercent: 100,
          allocationStartWeek: null,
          allocationEndWeek: null,
          dayRate: null,
          globalType: null,
          namedResources: [
            {
              id: 'nr-security',
              name: 'Principal Consultant - Security',
              allocationMode: 'EFFORT',
              allocationPercent: 100,
              allocationStartWeek: null,
              allocationEndWeek: null,
              startWeek: null,
              endWeek: null,
              pricingModel: 'PRO_RATA',
            },
          ],
        },
      ],
      epics: [
        {
          id: 'epic-1',
          name: 'Security',
          order: 0,
          isActive: true,
          features: [
            {
              id: 'feat-1',
              name: 'Security Design',
              order: 0,
              isActive: true,
              userStories: [
                {
                  id: 'story-1',
                  name: 'Threat model',
                  order: 0,
                  isActive: true,
                  tasks: [
                    {
                      id: 'task-1',
                      hoursEffort: 28.8,
                      resourceTypeId: 'rt-security',
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
      overheads: [],
      timelineEntries: [
        { featureId: 'feat-1', startWeek: 12, durationWeeks: 1 },
      ],
      storyTimelineEntries: [],
      capacityPlans: [],
    } as any)

    const res = await request(app)
      .get('/api/projects/proj-1/resource-profile')
      .set('Authorization', authHeader)

    expect(res.status).toBe(200)

    const securityRow = res.body.resourceRows.find((row: any) => row.resourceTypeId === 'rt-security')
    expect(securityRow.namedResources).toEqual([
      expect.objectContaining({
        name: 'Principal Consultant - Security',
        pricingModel: 'PRO_RATA',
        actualAllocatedDays: 3.6,
        actualAllocationStartWeek: 12,
        actualAllocationEndWeek: 12,
        actualAllocatedWeeks: [
          expect.objectContaining({
            week: 12,
            days: 3.6,
            capacityDays: 5,
          }),
        ],
      }),
    ])
  })

  it('uses actual named-resource assignment coverage when it exceeds the derived timeline window', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue({
      id: 'proj-1',
      ownerId: userId,
      hoursPerDay: 8,
      bufferWeeks: 0,
      onboardingWeeks: 0,
      weeklyDemandCache: {
        'Data, AI & IoT|0': 5,
        'Data, AI & IoT|1': 5,
        'Data, AI & IoT|2': 5,
        'Data, AI & IoT|3': 5,
        'Data, AI & IoT|4': 5,
        'Data, AI & IoT|5': 5,
        'Data, AI & IoT|6': 5,
        'Data, AI & IoT|7': 5,
        'Data, AI & IoT|8': 5,
        'Data, AI & IoT|9': 5,
        'Data, AI & IoT|10': 5,
        'Data, AI & IoT|11': 5,
        'Data, AI & IoT|12': 1,
      },
      resourceTypes: [
        {
          id: 'rt-data',
          name: 'Data, AI & IoT',
          category: 'ENGINEERING',
          count: 1,
          hoursPerDay: 8,
          allocationMode: 'TIMELINE',
          allocationPercent: 100,
          allocationStartWeek: null,
          allocationEndWeek: null,
          dayRate: null,
          globalType: null,
          namedResources: [
            {
              id: 'nr-data',
              name: 'Senior Engineer - Data, AI & IoT',
              allocationMode: 'TIMELINE',
              allocationPercent: 100,
              allocationStartWeek: null,
              allocationEndWeek: null,
              startWeek: null,
              endWeek: null,
            },
          ],
        },
      ],
      epics: [
        {
          id: 'epic-1',
          name: 'Platform',
          order: 0,
          isActive: true,
          features: [
            {
              id: 'feat-1',
              name: 'Delivery',
              order: 0,
              isActive: true,
              userStories: [
                {
                  id: 'story-1',
                  name: 'Implement',
                  order: 0,
                  isActive: true,
                  tasks: [
                    {
                      id: 'task-1',
                      hoursEffort: 488,
                      durationDays: 61,
                      resourceTypeId: 'rt-data',
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
      overheads: [],
      timelineEntries: [
        { featureId: 'feat-1', startWeek: 4.327272727272727, durationWeeks: 8.072727272727272 },
      ],
      storyTimelineEntries: [],
      capacityPlans: [],
    } as any)

    const res = await request(app)
      .get('/api/projects/proj-1/resource-profile')
      .set('Authorization', authHeader)

    expect(res.status).toBe(200)

    const dataRow = res.body.resourceRows.find((row: any) => row.resourceTypeId === 'rt-data')
    expect(dataRow).toMatchObject({
      allocationMode: 'TIMELINE',
      allocatedDays: 61,
      derivedStartWeek: 0,
      derivedEndWeek: 12,
    })
    expect(dataRow.namedResources).toEqual([
      expect.objectContaining({
        name: 'Senior Engineer - Data, AI & IoT',
        allocatedDays: 40.36,
        actualAllocatedDays: 61,
        actualAllocationStartWeek: 0,
        actualAllocationEndWeek: 12,
      }),
    ])
  })

  it('treats cached demand as authoritative for the same resource type within the cached horizon', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue({
      id: 'proj-1',
      ownerId: userId,
      hoursPerDay: 8,
      bufferWeeks: 0,
      onboardingWeeks: 0,
      weeklyDemandCache: {
        'Developer|0': 5,
        'Developer|2': 5,
      },
      resourceTypes: [
        {
          id: 'rt-dev',
          name: 'Developer',
          category: 'ENGINEERING',
          count: 1,
          hoursPerDay: 8,
          allocationMode: 'EFFORT',
          allocationPercent: 100,
          allocationStartWeek: null,
          allocationEndWeek: null,
          dayRate: null,
          globalType: null,
          namedResources: [
            {
              id: 'nr-dev',
              name: 'Taylor',
              allocationMode: 'EFFORT',
              allocationPercent: 100,
              allocationStartWeek: null,
              allocationEndWeek: null,
              startWeek: null,
              endWeek: null,
            },
          ],
        },
      ],
      epics: [
        {
          id: 'epic-1',
          name: 'Delivery',
          order: 0,
          isActive: true,
          features: [
            {
              id: 'feat-1',
              name: 'Build',
              order: 0,
              isActive: true,
              userStories: [
                {
                  id: 'story-1',
                  name: 'Implement',
                  order: 0,
                  isActive: true,
                  tasks: [
                    {
                      id: 'task-1',
                      hoursEffort: 120,
                      durationDays: 15,
                      resourceTypeId: 'rt-dev',
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
      overheads: [],
      timelineEntries: [
        { featureId: 'feat-1', startWeek: 0, durationWeeks: 3 },
      ],
      storyTimelineEntries: [],
      capacityPlans: [],
    } as any)

    const res = await request(app)
      .get('/api/projects/proj-1/resource-profile')
      .set('Authorization', authHeader)

    expect(res.status).toBe(200)

    const devRow = res.body.resourceRows.find((row: any) => row.resourceTypeId === 'rt-dev')
    expect(devRow.namedResources).toEqual([
      expect.objectContaining({
        id: 'nr-dev',
        actualAllocatedDays: 10,
        actualAllocatedWeeks: [
          expect.objectContaining({ week: 0, days: 5 }),
          expect.objectContaining({ week: 2, days: 5 }),
        ],
      }),
    ])
    expect(devRow.namedResources[0].actualAllocatedWeeks.map((week: any) => week.week)).toEqual([0, 2])
  })

  it('keeps fallback demand for resource types that are absent from cache', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue({
      id: 'proj-1',
      ownerId: userId,
      hoursPerDay: 8,
      bufferWeeks: 0,
      onboardingWeeks: 0,
      weeklyDemandCache: {
        'Developer|0': 5,
      },
      resourceTypes: [
        {
          id: 'rt-dev',
          name: 'Developer',
          category: 'ENGINEERING',
          count: 1,
          hoursPerDay: 8,
          allocationMode: 'EFFORT',
          allocationPercent: 100,
          allocationStartWeek: null,
          allocationEndWeek: null,
          dayRate: null,
          globalType: null,
          namedResources: [
            {
              id: 'nr-dev',
              name: 'Taylor',
              allocationMode: 'EFFORT',
              allocationPercent: 100,
              allocationStartWeek: null,
              allocationEndWeek: null,
              startWeek: null,
              endWeek: null,
            },
          ],
        },
        {
          id: 'rt-qa',
          name: 'QA',
          category: 'ENGINEERING',
          count: 1,
          hoursPerDay: 8,
          allocationMode: 'EFFORT',
          allocationPercent: 100,
          allocationStartWeek: null,
          allocationEndWeek: null,
          dayRate: null,
          globalType: null,
          namedResources: [
            {
              id: 'nr-qa',
              name: 'Morgan',
              allocationMode: 'EFFORT',
              allocationPercent: 100,
              allocationStartWeek: null,
              allocationEndWeek: null,
              startWeek: null,
              endWeek: null,
            },
          ],
        },
      ],
      epics: [
        {
          id: 'epic-1',
          name: 'Delivery',
          order: 0,
          isActive: true,
          features: [
            {
              id: 'feat-1',
              name: 'Build',
              order: 0,
              isActive: true,
              userStories: [
                {
                  id: 'story-1',
                  name: 'Implement',
                  order: 0,
                  isActive: true,
                  tasks: [
                    {
                      id: 'task-1',
                      hoursEffort: 40,
                      durationDays: 5,
                      resourceTypeId: 'rt-dev',
                    },
                    {
                      id: 'task-2',
                      hoursEffort: 40,
                      durationDays: 5,
                      resourceTypeId: 'rt-qa',
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
      overheads: [],
      timelineEntries: [
        { featureId: 'feat-1', startWeek: 0, durationWeeks: 1 },
      ],
      storyTimelineEntries: [],
      capacityPlans: [],
    } as any)

    const res = await request(app)
      .get('/api/projects/proj-1/resource-profile')
      .set('Authorization', authHeader)

    expect(res.status).toBe(200)

    const qaRow = res.body.resourceRows.find((row: any) => row.resourceTypeId === 'rt-qa')
    expect(qaRow.namedResources).toEqual([
      expect.objectContaining({
        id: 'nr-qa',
        actualAllocatedDays: 5,
        actualAllocatedWeeks: [
          expect.objectContaining({ week: 0, days: 5 }),
        ],
      }),
    ])
  })

  it('uses per-resource-type cached horizon: fallback re-emerges for an RT after its own cache max week, even when another RT has a longer horizon', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue({
      id: 'proj-1',
      ownerId: userId,
      hoursPerDay: 8,
      bufferWeeks: 0,
      onboardingWeeks: 0,
      weeklyDemandCache: {
        'Developer|0': 5,
        'Developer|1': 5,
        'QA|0': 5,
      },
      resourceTypes: [
        {
          id: 'rt-dev',
          name: 'Developer',
          category: 'ENGINEERING',
          count: 1,
          hoursPerDay: 8,
          allocationMode: 'EFFORT',
          allocationPercent: 100,
          allocationStartWeek: null,
          allocationEndWeek: null,
          dayRate: null,
          globalType: null,
          namedResources: [
            {
              id: 'nr-dev',
              name: 'Taylor',
              allocationMode: 'EFFORT',
              allocationPercent: 100,
              allocationStartWeek: null,
              allocationEndWeek: null,
              startWeek: null,
              endWeek: null,
            },
          ],
        },
        {
          id: 'rt-qa',
          name: 'QA',
          category: 'ENGINEERING',
          count: 1,
          hoursPerDay: 8,
          allocationMode: 'EFFORT',
          allocationPercent: 100,
          allocationStartWeek: null,
          allocationEndWeek: null,
          dayRate: null,
          globalType: null,
          namedResources: [
            {
              id: 'nr-qa',
              name: 'Morgan',
              allocationMode: 'EFFORT',
              allocationPercent: 100,
              allocationStartWeek: null,
              allocationEndWeek: null,
              startWeek: null,
              endWeek: null,
            },
          ],
        },
      ],
      epics: [
        {
          id: 'epic-1',
          name: 'Delivery',
          order: 0,
          isActive: true,
          features: [
            {
              id: 'feat-1',
              name: 'Build',
              order: 0,
              isActive: true,
              userStories: [
                {
                  id: 'story-1',
                  name: 'Implement',
                  order: 0,
                  isActive: true,
                  tasks: [
                    {
                      id: 'task-1',
                      hoursEffort: 40,
                      durationDays: 5,
                      resourceTypeId: 'rt-dev',
                    },
                    {
                      id: 'task-2',
                      hoursEffort: 80,
                      durationDays: 10,
                      resourceTypeId: 'rt-qa',
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
      overheads: [],
      timelineEntries: [
        { featureId: 'feat-1', startWeek: 0, durationWeeks: 2 },
      ],
      storyTimelineEntries: [],
      capacityPlans: [],
    } as any)

    const res = await request(app)
      .get('/api/projects/proj-1/resource-profile')
      .set('Authorization', authHeader)

    expect(res.status).toBe(200)

    const devRow = res.body.resourceRows.find((row: any) => row.resourceTypeId === 'rt-dev')
    const qaRow = res.body.resourceRows.find((row: any) => row.resourceTypeId === 'rt-qa')

    // Developer is cached for weeks 0-1, so fallback at week 0-1 is suppressed
    expect(devRow.namedResources[0].actualAllocatedWeeks.map((w: any) => w.week)).toEqual([0, 1])

    // QA is only cached for week 0, so fallback at week 1 is NOT suppressed
    // (per-RT max is 0, so week 1 > 0 and fallback re-emerges)
    expect(qaRow.namedResources[0].actualAllocatedWeeks.map((w: any) => w.week)).toEqual([0, 1])
  })

  it('does not cross-bind actual allocations when named resources share the same name', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue({
      id: 'proj-1',
      ownerId: userId,
      hoursPerDay: 8,
      bufferWeeks: 0,
      onboardingWeeks: 0,
      weeklyDemandCache: {
        'Developer|0': 5,
      },
      resourceTypes: [
        {
          id: 'rt-dev',
          name: 'Developer',
          category: 'ENGINEERING',
          count: 2,
          hoursPerDay: 8,
          allocationMode: 'EFFORT',
          allocationPercent: 100,
          allocationStartWeek: null,
          allocationEndWeek: null,
          dayRate: null,
          globalType: null,
          namedResources: [
            {
              id: 'nr-1',
              name: 'Alex',
              allocationMode: 'EFFORT',
              allocationPercent: 100,
              allocationStartWeek: null,
              allocationEndWeek: null,
              startWeek: null,
              endWeek: null,
            },
            {
              id: 'nr-2',
              name: 'Alex',
              allocationMode: 'EFFORT',
              allocationPercent: 100,
              allocationStartWeek: null,
              allocationEndWeek: null,
              startWeek: null,
              endWeek: null,
            },
          ],
        },
      ],
      epics: [
        {
          id: 'epic-1',
          name: 'Delivery',
          order: 0,
          isActive: true,
          features: [
            {
              id: 'feat-1',
              name: 'Build',
              order: 0,
              isActive: true,
              userStories: [
                {
                  id: 'story-1',
                  name: 'Implement',
                  order: 0,
                  isActive: true,
                  tasks: [
                    {
                      id: 'task-1',
                      hoursEffort: 40,
                      durationDays: 5,
                      resourceTypeId: 'rt-dev',
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
      overheads: [],
      timelineEntries: [
        { featureId: 'feat-1', startWeek: 0, durationWeeks: 1 },
      ],
      storyTimelineEntries: [],
      capacityPlans: [],
    } as any)

    const res = await request(app)
      .get('/api/projects/proj-1/resource-profile')
      .set('Authorization', authHeader)

    expect(res.status).toBe(200)

    const devRow = res.body.resourceRows.find((row: any) => row.resourceTypeId === 'rt-dev')
    const byId = Object.fromEntries(devRow.namedResources.map((nr: any) => [nr.id, nr]))
    expect(byId['nr-1']).toMatchObject({
      name: 'Alex',
      actualAllocatedDays: 5,
    })
    expect(byId['nr-2']).toMatchObject({
      name: 'Alex',
      actualAllocatedDays: 0,
      actualAllocatedWeeks: [],
    })
  })

  it('still appends synthetic actual assignments that have no persisted named resource', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue({
      id: 'proj-1',
      ownerId: userId,
      hoursPerDay: 8,
      bufferWeeks: 0,
      onboardingWeeks: 0,
      weeklyDemandCache: {
        'Developer|0': 10,
      },
      resourceTypes: [
        {
          id: 'rt-dev',
          name: 'Developer',
          category: 'ENGINEERING',
          count: 2,
          hoursPerDay: 8,
          allocationMode: 'EFFORT',
          allocationPercent: 100,
          allocationStartWeek: null,
          allocationEndWeek: null,
          dayRate: null,
          globalType: null,
          namedResources: [
            {
              id: 'nr-1',
              name: 'Taylor',
              allocationMode: 'EFFORT',
              allocationPercent: 100,
              allocationStartWeek: null,
              allocationEndWeek: null,
              startWeek: null,
              endWeek: null,
            },
          ],
        },
      ],
      epics: [
        {
          id: 'epic-1',
          name: 'Delivery',
          order: 0,
          isActive: true,
          features: [
            {
              id: 'feat-1',
              name: 'Build',
              order: 0,
              isActive: true,
              userStories: [
                {
                  id: 'story-1',
                  name: 'Implement',
                  order: 0,
                  isActive: true,
                  tasks: [
                    {
                      id: 'task-1',
                      hoursEffort: 80,
                      durationDays: 10,
                      resourceTypeId: 'rt-dev',
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
      overheads: [],
      timelineEntries: [
        { featureId: 'feat-1', startWeek: 0, durationWeeks: 1 },
      ],
      storyTimelineEntries: [],
      capacityPlans: [],
    } as any)

    const res = await request(app)
      .get('/api/projects/proj-1/resource-profile')
      .set('Authorization', authHeader)

    expect(res.status).toBe(200)

    const devRow = res.body.resourceRows.find((row: any) => row.resourceTypeId === 'rt-dev')
    expect(devRow.namedResources).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'nr-1',
        actualAllocatedDays: 5,
      }),
      expect.objectContaining({
        id: 'rt-dev-synthetic-2',
        name: 'Developer 2',
        synthetic: true,
        actualAllocatedDays: 5,
      }),
    ]))
  })
})
