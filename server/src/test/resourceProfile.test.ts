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
})
