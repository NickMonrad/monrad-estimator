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
                      resourceType: { name: 'Developer', hoursPerDay: 8 },
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
                      resourceType: { name: 'Security', hoursPerDay: 8 },
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
                      resourceType: { name: 'Security', hoursPerDay: 8 },
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
        'rt-security|12': 3.6,
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
                      resourceType: { name: 'Security', hoursPerDay: 8 },
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
        'rt-data|0': 5,
        'rt-data|1': 5,
        'rt-data|2': 5,
        'rt-data|3': 5,
        'rt-data|4': 5,
        'rt-data|5': 5,
        'rt-data|6': 5,
        'rt-data|7': 5,
        'rt-data|8': 5,
        'rt-data|9': 5,
        'rt-data|10': 5,
        'rt-data|11': 5,
        'rt-data|12': 1,
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
                      resourceType: { name: 'Data', hoursPerDay: 8 },
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
        actualAllocatedDays: 61,
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
        'rt-dev|0': 5,
        'rt-dev|2': 5,
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
                      resourceType: { name: 'Developer', hoursPerDay: 8 },
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
        'rt-dev|0': 5,
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
                      resourceType: { name: 'Developer', hoursPerDay: 8 },
                    },
                    {
                      id: 'task-2',
                      hoursEffort: 40,
                      durationDays: 5,
                      resourceTypeId: 'rt-qa',
                      resourceType: { name: 'QA', hoursPerDay: 8 },
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
        'rt-dev|0': 5,
        'rt-dev|1': 5,
        'rt-qa|0': 5,
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
                      resourceType: { name: 'Developer', hoursPerDay: 8 },
                    },
                    {
                      id: 'task-2',
                      hoursEffort: 80,
                      durationDays: 10,
                      resourceTypeId: 'rt-qa',
                      resourceType: { name: 'QA', hoursPerDay: 8 },
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
        'rt-dev|0': 5,
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
                      resourceType: { name: 'Developer', hoursPerDay: 8 },
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
        'rt-dev|0': 10,
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
                      resourceType: { name: 'Developer', hoursPerDay: 8 },
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
  it('uses shared computePlanningWindow and handles null startDate', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue({
      id: 'proj-1',
      ownerId: userId,
      hoursPerDay: 8,
      startDate: null,
      name: 'Test Project',
      weeklyDemandCache: null,
      bufferWeeks: 2,
      onboardingWeeks: 1,
      resourceTypes: [],
      epics: [],
      overheads: [],
      timelineEntries: [
        { featureId: 'feat-1', startWeek: 0, durationWeeks: 4 },
      ],
      storyTimelineEntries: [],
      capacityPlans: [],
    } as any)

    const res = await request(app)
      .get('/api/projects/proj-1/resource-profile')
      .set('Authorization', authHeader)

    expect(res.status).toBe(200)
    // max entry end = 4, maxWeek = 4 + 2 + 1 = 7
    expect(res.body.projectDurationWeeks).toBe(7)
    expect(res.body.bufferWeeks).toBe(2)
    expect(res.body.onboardingWeeks).toBe(1)
  })
  it('excludes inactive epics and features from effort summary', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue({
      id: 'proj-1',
      ownerId: userId,
      hoursPerDay: 8,
      startDate: null,
      name: 'Test Project',
      weeklyDemandCache: null,
      bufferWeeks: 0,
      onboardingWeeks: 0,
      resourceTypes: [
        { id: 'rt-dev', name: 'Developer', category: 'ENGINEERING', count: 1, hoursPerDay: 8, dayRate: null, allocationMode: 'EFFORT', allocationPercent: 100, allocationStartWeek: null, allocationEndWeek: null, globalType: null, namedResources: [] },
      ],
      epics: [
        {
          id: 'epic-active', name: 'Active Epic', order: 0, isActive: true,
          features: [
            {
              id: 'feat-active', name: 'Active Feature', order: 0, isActive: true,
              userStories: [
                {
                  id: 'story-active', name: 'Active Story', order: 0, isActive: true,
                  tasks: [
                    { id: 'task-active', resourceTypeId: 'rt-dev', hoursEffort: 80, durationDays: 5, order: 0, resourceType: { name: 'Developer', hoursPerDay: 8 } },
                  ],
                },
              ],
            },
          ],
        },
        {
          id: 'epic-inactive', name: 'Inactive Epic', order: 1, isActive: false,
          features: [
            {
              id: 'feat-inactive', name: 'Inactive Feature', order: 0, isActive: true,
              userStories: [
                {
                  id: 'story-inactive', name: 'Inactive Story', order: 0, isActive: true,
                  tasks: [
                    { id: 'task-inactive', resourceTypeId: 'rt-dev', hoursEffort: 80, durationDays: 5, order: 0, resourceType: { name: 'Developer', hoursPerDay: 8 } },
                  ],
                },
              ],
            },
          ],
        },
      ],
      overheads: [],
      timelineEntries: [
        { featureId: 'feat-active', startWeek: 0, durationWeeks: 2 },
        { featureId: 'feat-inactive', startWeek: 0, durationWeeks: 2 },
      ],
      storyTimelineEntries: [],
      capacityPlans: [],
    } as any)

    const res = await request(app)
      .get('/api/projects/proj-1/resource-profile')
      .set('Authorization', authHeader)

    expect(res.status).toBe(200)
    // Only active epic's effort should appear
    const devRow = res.body.resourceRows.find((row: any) => row.resourceTypeId === 'rt-dev')
    expect(devRow).toBeTruthy()
    expect(devRow.effortDays).toBe(5) // effectiveDays(5, 80, 8) = 5 — positive durationDays used directly
    expect(devRow.epics).toHaveLength(1)
    expect(devRow.epics[0].epicId).toBe('epic-active')
  })

  it('uses story timeline entry for fallback demand when feature has no timeline entry', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue({
      id: 'proj-1',
      ownerId: userId,
      hoursPerDay: 8,
      startDate: null,
      name: 'Test Project',
      weeklyDemandCache: null,
      bufferWeeks: 0,
      onboardingWeeks: 0,
      resourceTypes: [
        {
          id: 'rt-dev',
          name: 'Developer',
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
              id: 'nr-dev',
              name: 'Dev 1',
              allocationMode: 'TIMELINE',
              allocationPercent: 100,
              allocationStartWeek: null,
              allocationEndWeek: null,
              startWeek: null,
              endWeek: null,
              pricingModel: 'ACTUAL_DAYS',
            },
          ],
        },
      ],
      epics: [
        {
          id: 'epic-1',
          name: 'Epic',
          order: 0,
          isActive: true,
          features: [
            {
              id: 'feat-1',
              name: 'Feature',
              order: 0,
              isActive: true,
              userStories: [
                {
                  id: 'story-1',
                  name: 'Story',
                  order: 0,
                  isActive: true,
                  tasks: [
                    {
                      id: 'task-1',
                      resourceTypeId: 'rt-dev',
                      hoursEffort: 80,
                      durationDays: 10,
                      order: 0,
                      resourceType: { name: 'Developer', hoursPerDay: 8 },
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
      overheads: [],
      timelineEntries: [],  // No feature-level entry
      storyTimelineEntries: [
        { storyId: 'story-1', startWeek: 4, durationWeeks: 2 },
      ],
      capacityPlans: [],
    } as any)

    const res = await request(app)
      .get('/api/projects/proj-1/resource-profile')
      .set('Authorization', authHeader)

    expect(res.status).toBe(200)

    const devRow = res.body.resourceRows.find((row: any) => row.resourceTypeId === 'rt-dev')
    expect(devRow).toBeTruthy()

    // Fallback demand should be driven by the story timeline entry (startWeek=4, durationWeeks=2)
    // not by an absent feature entry. Named-resource actual weeks reflect the story timing.
    const nr = devRow.namedResources[0]
    expect(nr.actualAllocationStartWeek).toBe(4)
    expect(nr.actualAllocationEndWeek).toBe(5)
    expect(nr.actualAllocatedWeeks).toEqual([
      expect.objectContaining({ week: 4, days: 5, capacityDays: 5 }),
      expect.objectContaining({ week: 5, days: 5, capacityDays: 5 }),
    ])
    expect(nr.actualAllocatedDays).toBe(10)
  })

  it('reflects two different story timeline entries under the same feature', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue({
      id: 'proj-1',
      ownerId: userId,
      hoursPerDay: 8,
      startDate: null,
      name: 'Test Project',
      weeklyDemandCache: null,
      bufferWeeks: 0,
      onboardingWeeks: 0,
      resourceTypes: [
        {
          id: 'rt-dev',
          name: 'Developer',
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
              id: 'nr-dev',
              name: 'Dev 1',
              allocationMode: 'TIMELINE',
              allocationPercent: 100,
              allocationStartWeek: null,
              allocationEndWeek: null,
              startWeek: null,
              endWeek: null,
              pricingModel: 'ACTUAL_DAYS',
            },
          ],
        },
      ],
      epics: [
        {
          id: 'epic-1',
          name: 'Epic',
          order: 0,
          isActive: true,
          features: [
            {
              id: 'feat-1',
              name: 'Feature',
              order: 0,
              isActive: true,
              userStories: [
                {
                  id: 'story-1',
                  name: 'Story 1',
                  order: 0,
                  isActive: true,
                  tasks: [
                    {
                      id: 'task-1',
                      resourceTypeId: 'rt-dev',
                      hoursEffort: 80,
                      durationDays: 10,
                      order: 0,
                      resourceType: { name: 'Developer', hoursPerDay: 8 },
                    },
                  ],
                },
                {
                  id: 'story-2',
                  name: 'Story 2',
                  order: 1,
                  isActive: true,
                  tasks: [
                    {
                      id: 'task-2',
                      resourceTypeId: 'rt-dev',
                      hoursEffort: 80,
                      durationDays: 10,
                      order: 0,
                      resourceType: { name: 'Developer', hoursPerDay: 8 },
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
      overheads: [],
      timelineEntries: [],  // No feature entry
      storyTimelineEntries: [
        { storyId: 'story-1', startWeek: 2, durationWeeks: 2 },
        { storyId: 'story-2', startWeek: 6, durationWeeks: 2 },
      ],
      capacityPlans: [],
    } as any)

    const res = await request(app)
      .get('/api/projects/proj-1/resource-profile')
      .set('Authorization', authHeader)

    expect(res.status).toBe(200)

    const devRow = res.body.resourceRows.find((row: any) => row.resourceTypeId === 'rt-dev')
    expect(devRow).toBeTruthy()

    // Two stories with different story entries should produce two demand blocks
    const nr = devRow.namedResources[0]
    expect(nr.actualAllocationStartWeek).toBe(2)
    expect(nr.actualAllocationEndWeek).toBe(7)
    expect(nr.actualAllocatedWeeks).toHaveLength(4)
    expect(nr.actualAllocationSegments).toEqual([
      { startWeek: 2, endWeek: 3, days: 10 },
      { startWeek: 6, endWeek: 7, days: 10 },
    ])
    expect(nr.actualAllocatedDays).toBe(20)
  })

  it('uses story timeline entry for story-timed stories and feature entry for others', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue({
      id: 'proj-1',
      ownerId: userId,
      hoursPerDay: 8,
      startDate: null,
      name: 'Test Project',
      weeklyDemandCache: null,
      bufferWeeks: 0,
      onboardingWeeks: 0,
      resourceTypes: [
        {
          id: 'rt-dev',
          name: 'Developer',
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
              id: 'nr-dev',
              name: 'Dev 1',
              allocationMode: 'TIMELINE',
              allocationPercent: 100,
              allocationStartWeek: null,
              allocationEndWeek: null,
              startWeek: null,
              endWeek: null,
              pricingModel: 'ACTUAL_DAYS',
            },
          ],
        },
      ],
      epics: [
        {
          id: 'epic-1',
          name: 'Epic',
          order: 0,
          isActive: true,
          features: [
            {
              id: 'feat-1',
              name: 'Feature',
              order: 0,
              isActive: true,
              userStories: [
                {
                  id: 'story-1',
                  name: 'Story Timed',
                  order: 0,
                  isActive: true,
                  tasks: [
                    {
                      id: 'task-1',
                      resourceTypeId: 'rt-dev',
                      hoursEffort: 40,
                      durationDays: 5,
                      order: 0,
                      resourceType: { name: 'Developer', hoursPerDay: 8 },
                    },
                  ],
                },
                {
                  id: 'story-2',
                  name: 'Feature Timed',
                  order: 1,
                  isActive: true,
                  tasks: [
                    {
                      id: 'task-2',
                      resourceTypeId: 'rt-dev',
                      hoursEffort: 40,
                      durationDays: 5,
                      order: 0,
                      resourceType: { name: 'Developer', hoursPerDay: 8 },
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
      storyTimelineEntries: [
        { storyId: 'story-1', startWeek: 2, durationWeeks: 1 },
      ],
      capacityPlans: [],
    } as any)

    const res = await request(app)
      .get('/api/projects/proj-1/resource-profile')
      .set('Authorization', authHeader)

    expect(res.status).toBe(200)

    const devRow = res.body.resourceRows.find((row: any) => row.resourceTypeId === 'rt-dev')
    expect(devRow).toBeTruthy()

    // story-1 (timed at week 2) contributes demand at week 2
    // story-2 (no story entry, feature timed at week 0) contributes demand at week 0
    const nr = devRow.namedResources[0]
    expect(nr.actualAllocationStartWeek).toBe(0)
    expect(nr.actualAllocationEndWeek).toBe(2)
    expect(nr.actualAllocatedWeeks).toHaveLength(2)
    // Two separate segments since weeks 0 and 2 are not consecutive
    expect(nr.actualAllocationSegments).toHaveLength(2)
    const seg0 = nr.actualAllocationSegments[0]
    expect(seg0.startWeek).toBe(0)
    expect(seg0.endWeek).toBe(0)
    const seg1 = nr.actualAllocationSegments[1]
    expect(seg1.startWeek).toBe(2)
    expect(seg1.endWeek).toBe(2)
    expect(nr.actualAllocatedDays).toBe(10)
  })

  it('excludes inactive stories and features from fallback demand', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue({
      id: 'proj-1',
      ownerId: userId,
      hoursPerDay: 8,
      startDate: null,
      name: 'Test Project',
      weeklyDemandCache: null,
      bufferWeeks: 0,
      onboardingWeeks: 0,
      resourceTypes: [
        {
          id: 'rt-dev',
          name: 'Developer',
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
              id: 'nr-dev',
              name: 'Dev 1',
              allocationMode: 'TIMELINE',
              allocationPercent: 100,
              allocationStartWeek: null,
              allocationEndWeek: null,
              startWeek: null,
              endWeek: null,
              pricingModel: 'ACTUAL_DAYS',
            },
          ],
        },
      ],
      epics: [
        {
          id: 'epic-active',
          name: 'Active Epic',
          order: 0,
          isActive: true,
          features: [
            {
              id: 'feat-active',
              name: 'Active Feature',
              order: 0,
              isActive: true,
              userStories: [
                {
                  id: 'story-active',
                  name: 'Active Story',
                  order: 0,
                  isActive: true,
                  tasks: [
                    {
                      id: 'task-active',
                      resourceTypeId: 'rt-dev',
                      hoursEffort: 80,
                      durationDays: 10,
                      order: 0,
                      resourceType: { name: 'Developer', hoursPerDay: 8 },
                    },
                  ],
                },
              ],
            },
          ],
        },
        {
          id: 'epic-inactive',
          name: 'Inactive Epic',
          order: 1,
          isActive: false,
          features: [
            {
              id: 'feat-inactive',
              name: 'Inactive Feature',
              order: 0,
              isActive: true,
              userStories: [
                {
                  id: 'story-inactive',
                  name: 'Inactive Story',
                  order: 0,
                  isActive: true,
                  tasks: [
                    {
                      id: 'task-inactive',
                      resourceTypeId: 'rt-dev',
                      hoursEffort: 80,
                      durationDays: 10,
                      order: 0,
                      resourceType: { name: 'Developer', hoursPerDay: 8 },
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
        { featureId: 'feat-active', startWeek: 0, durationWeeks: 2 },
        { featureId: 'feat-inactive', startWeek: 0, durationWeeks: 2 },
      ],
      storyTimelineEntries: [
        { storyId: 'story-inactive', startWeek: 0, durationWeeks: 2 },
      ],
      capacityPlans: [],
    } as any)

    const res = await request(app)
      .get('/api/projects/proj-1/resource-profile')
      .set('Authorization', authHeader)

    expect(res.status).toBe(200)

    const devRow = res.body.resourceRows.find((row: any) => row.resourceTypeId === 'rt-dev')
    expect(devRow).toBeTruthy()

    // Inactive epic's story should NOT contribute to fallback demand despite having a story entry
    const nr = devRow.namedResources[0]
    // Only the active story (feature-timed at week 0) contributes demand
    expect(nr.actualAllocationStartWeek).toBe(0)
    expect(nr.actualAllocationEndWeek).toBe(1)
    expect(nr.actualAllocatedWeeks).toHaveLength(2)
    expect(nr.actualAllocatedDays).toBe(10)
  })
})
