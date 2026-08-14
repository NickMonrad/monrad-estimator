import { describe, it, expect, vi, beforeEach } from 'vitest'
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
import { buildSnapshot } from '../routes/snapshots.js'
import { getWeeklyCapacity } from '../routes/timeline.js'

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

const mockEpicsWithFeatures = [
  {
    id: 'epic-1',
    name: 'Authentication',
    order: 0,
    features: [
      {
        id: 'feat-1',
        name: 'Login',
        order: 0,
        userStories: [
          {
            id: 'story-1',
            tasks: [
              {
                id: 'task-1',
                hoursEffort: 16,
                durationDays: null,
                resourceTypeId: 'rt-1',
                resourceType: { id: 'rt-1', name: 'Developer', category: 'ENGINEERING', count: 1 },
              },
            ],
          },
        ],
      },
      {
        id: 'feat-2',
        name: 'Registration',
        order: 1,
        userStories: [
          {
            id: 'story-2',
            tasks: [
              {
                id: 'task-2',
                hoursEffort: 8,
                durationDays: null,
                resourceTypeId: 'rt-1',
                resourceType: { id: 'rt-1', name: 'Developer', category: 'ENGINEERING', count: 1 },
              },
            ],
          },
        ],
      },
    ],
  },
]

const mockResourceTypes = [
  { id: 'rt-1', name: 'Developer', category: 'ENGINEERING', count: 1, projectId: 'proj-1' },
]

const mockEntries = [
  {
    id: 'entry-1',
    projectId: 'proj-1',
    featureId: 'feat-1',
    startWeek: 0,
    durationWeeks: 2,
    isManual: false,
    feature: { name: 'Login', epic: { id: 'epic-1', name: 'Authentication' }, userStories: [] },
  },
]

// Profile-first fixtures (issue #418): capacity resolution reads ONLY
// persisted CapacityProfile state, so every test exercising the resolver
// must provide ROLE and/or NAMED_PERSON profiles.
function roleProfile(overrides: Record<string, unknown> = {}) {
  return {
    id: 'cp-role-1', projectId: 'proj-1', ownerKind: 'ROLE', resourceTypeId: 'rt-1',
    namedResourceId: null, planningBasis: 'DEMAND_FOLLOWING', source: 'FIXED',
    defaultPercent: 100, startWeek: null, endWeek: null, legacy: null,
    segments: [],
    ...overrides,
  }
}
function namedPersonProfile(overrides: Record<string, unknown> = {}) {
  return {
    id: 'cp-nr-1', projectId: 'proj-1', ownerKind: 'NAMED_PERSON', resourceTypeId: null,
    namedResourceId: 'nr-1', planningBasis: 'DEMAND_FOLLOWING', source: 'FIXED',
    defaultPercent: 100, startWeek: null, endWeek: null, legacy: null,
    segments: [],
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  // Default: no persisted capacity profiles. Profile-first resolution fails
  // closed, so tests that exercise the resolver provide their own fixtures.
  vi.mocked(prisma.capacityProfile.findMany).mockResolvedValue([])
})

describe('GET /api/projects/:projectId/timeline', () => {
  it('returns 401 without auth', async () => {
    const res = await request(app).get('/api/projects/proj-1/timeline')
    expect(res.status).toBe(401)
  })

  it('returns 404 for project not owned by user', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue(null)
    const res = await request(app)
      .get('/api/projects/proj-1/timeline')
      .set('Authorization', authHeader)
    expect(res.status).toBe(404)
  })

  it('returns empty entries when no timeline scheduled', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue(mockProject as any)
    vi.mocked(prisma.timelineEntry.findMany).mockResolvedValue([])
    vi.mocked(prisma.resourceType.findMany).mockResolvedValue([])

    const res = await request(app)
      .get('/api/projects/proj-1/timeline')
      .set('Authorization', authHeader)

    expect(res.status).toBe(200)
    expect(res.body.projectId).toBe('proj-1')
    expect(res.body.entries).toHaveLength(0)
    expect(res.body.hoursPerDay).toBe(8)
  })

  it('returns computed startDate and endDate based on project.startDate', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue(mockProject as any)
    vi.mocked(prisma.timelineEntry.findMany).mockResolvedValue(mockEntries as any)
    vi.mocked(prisma.resourceType.findMany).mockResolvedValue([])

    const res = await request(app)
      .get('/api/projects/proj-1/timeline')
      .set('Authorization', authHeader)

    expect(res.status).toBe(200)
    const entry = res.body.entries[0]
    // startWeek=0 => startDate = project.startDate
    expect(entry.startDate).toBe('2026-03-01T00:00:00.000Z')
    // durationWeeks=2 => endDate = +14 days
    expect(entry.endDate).toBe('2026-03-15T00:00:00.000Z')
  })
  it('handles null startDate gracefully without throwing', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue({
      ...mockProject,
      startDate: null,
    } as any)
    vi.mocked(prisma.timelineEntry.findMany).mockResolvedValue(mockEntries as any)
    vi.mocked(prisma.resourceType.findMany).mockResolvedValue([])

    const res = await request(app)
      .get('/api/projects/proj-1/timeline')
      .set('Authorization', authHeader)

    expect(res.status).toBe(200)
    const entry = res.body.entries[0]
    expect(entry.startDate).toBeNull()
    expect(entry.endDate).toBeNull()
    expect(res.body.projectedEndDate).toBeNull()
  })

  it('derives CAPACITY_PLAN weekly capacity and named-resource windows from the active plan when persisted windows are stale', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue({
      ...mockProject,
      bufferWeeks: 4,
      weeklyDemandCache: {
        'rt-security|4': 2,
        'rt-security|5': 2,
      },
    } as any)
    vi.mocked(prisma.timelineEntry.findMany).mockResolvedValue([{
      id: 'entry-security',
      projectId: 'proj-1',
      featureId: 'feat-security',
      startWeek: 4,
      durationWeeks: 8,
      isManual: false,
      feature: {
        id: 'feat-security',
        name: 'Security Work',
        order: 0,
        isActive: true,
        epic: {
          id: 'epic-1',
          name: 'Security',
          order: 0,
          isActive: true,
          featureMode: 'SEQUENTIAL',
          scheduleMode: 'AUTO',
          timelineStartWeek: null,
        },
        userStories: [],
      },
    }] as any)
    vi.mocked(prisma.resourceType.findMany).mockResolvedValue([{
      id: 'rt-security',
      name: 'Security',
      category: 'ENGINEERING',
      count: 1,
      hoursPerDay: 8,
      allocationMode: 'CAPACITY_PLAN',
      namedResources: [
        {
          id: 'nr-security',
          name: 'Principal Consultant - Security',
          startWeek: null,
          endWeek: null,
          allocationPct: 100,
          allocationMode: 'CAPACITY_PLAN',
          allocationPercent: 100,
          allocationStartWeek: null,
          allocationEndWeek: null,
        },
      ],
    }] as any)
    vi.mocked(prisma.capacityPlan.findFirst).mockResolvedValue({
      id: 'plan-1',
      periods: [
        { periodIndex: 0, startWeek: 0, endWeek: 4, entries: [{ resourceTypeId: 'rt-security', headcount: 0 }] },
        { periodIndex: 1, startWeek: 4, endWeek: 8, entries: [{ resourceTypeId: 'rt-security', headcount: 1 }] },
        { periodIndex: 2, startWeek: 8, endWeek: 12, entries: [{ resourceTypeId: 'rt-security', headcount: 1 }] },
        { periodIndex: 3, startWeek: 12, endWeek: 16, entries: [{ resourceTypeId: 'rt-security', headcount: 0 }] },
      ],
    } as any)
    // Explicit-only role: the single NR's profile encodes the plan-shaped
    // window (weeks 4-11 at 100%) with zero capacity elsewhere.
    vi.mocked(prisma.capacityProfile.findMany).mockResolvedValue([namedPersonProfile({
      id: 'cp-nr-security', namedResourceId: 'nr-security',
      planningBasis: 'CAPACITY_PROFILE', source: 'MANUAL', defaultPercent: null,
      segments: [{ id: 'seg-1', capacityProfileId: 'cp-nr-security', startWeek: 4, endWeek: 11, capacityPercent: 100, source: 'MANUAL' }],
    })] as never)

    const res = await request(app)
      .get('/api/projects/proj-1/timeline')
      .set('Authorization', authHeader)

    expect(res.status).toBe(200)

    const securityCapacity = res.body.weeklyCapacity
      .filter((row: any) => row.resourceTypeName === 'Security')
      .reduce((acc: Record<number, number>, row: any) => ({ ...acc, [row.week]: row.capacityDays }), {})

    expect(securityCapacity[0]).toBe(0)
    expect(securityCapacity[4]).toBe(5)
    expect(securityCapacity[11]).toBe(5)
    expect(securityCapacity[12]).toBe(0)

    expect(res.body.namedResources).toEqual(expect.arrayContaining([
      expect.objectContaining({
        resourceTypeName: 'Security',
        name: 'Principal Consultant - Security',
        allocationMode: 'CAPACITY_PLAN',
        startWeek: 4,
        endWeek: 11,
      }),
    ]))
  })

  it('derives fractional weekly capacity from active CAPACITY_PLAN periods for low-demand roles', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue({
      ...mockProject,
      bufferWeeks: 0,
      weeklyDemandCache: {
        'rt-security|0': 1.04,
        'rt-security|15': 1.04,
      },
    } as any)
    vi.mocked(prisma.timelineEntry.findMany).mockResolvedValue([{
      id: 'entry-security',
      projectId: 'proj-1',
      featureId: 'feat-security',
      startWeek: 0,
      durationWeeks: 16,
      isManual: false,
      feature: {
        id: 'feat-security',
        name: 'Security Work',
        order: 0,
        isActive: true,
        epic: {
          id: 'epic-1',
          name: 'Security',
          order: 0,
          isActive: true,
          featureMode: 'SEQUENTIAL',
          scheduleMode: 'AUTO',
          timelineStartWeek: null,
        },
        userStories: [],
      },
    }] as any)
    vi.mocked(prisma.resourceType.findMany).mockResolvedValue([{
      id: 'rt-security',
      name: 'Security',
      category: 'ENGINEERING',
      count: 1,
      hoursPerDay: 8,
      allocationMode: 'CAPACITY_PLAN',
      namedResources: [],
    }] as any)
    vi.mocked(prisma.capacityPlan.findFirst).mockResolvedValue({
      id: 'plan-1',
      periods: [
        { periodIndex: 0, startWeek: 0, endWeek: 16, entries: [{ resourceTypeId: 'rt-security', headcount: 0.25 }] },
      ],
    } as any)
    // ROLE profile carries the 25% plan capacity; the display materialisation
    // of the plan still produces the synthetic named resource.
    vi.mocked(prisma.capacityProfile.findMany).mockResolvedValue([roleProfile({
      id: 'cp-role-security', resourceTypeId: 'rt-security',
      planningBasis: 'CAPACITY_PROFILE', source: 'SQUAD_PLANNER', defaultPercent: 25,
      segments: [{ id: 'seg-1', capacityProfileId: 'cp-role-security', startWeek: 0, endWeek: 15, capacityPercent: 25, source: 'SQUAD_PLANNER' }],
    })] as never)

    const res = await request(app)
      .get('/api/projects/proj-1/timeline')
      .set('Authorization', authHeader)

    expect(res.status).toBe(200)

    const securityCapacity = res.body.weeklyCapacity
      .filter((row: any) => row.resourceTypeName === 'Security')
      .reduce((acc: Record<number, number>, row: any) => ({ ...acc, [row.week]: row.capacityDays }), {})

    expect(securityCapacity[0]).toBe(1.3)
    expect(securityCapacity[15]).toBe(1.3)

    // Profile-first: the ROLE profile (25%) is represented by the synthetic
    // aggregate role resource; the plan is only materialised for display.
    expect(res.body.namedResources).toEqual(expect.arrayContaining([
      expect.objectContaining({
        resourceTypeName: 'Security',
        name: 'Security (Role)',
        synthetic: true,
        allocationMode: 'EFFORT',
        allocationPct: 100,
      }),
    ]))
  })

  it('derives actual named-resource assignment weeks from role demand without exceeding weekly capacity', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue({
      ...mockProject,
      weeklyDemandCache: {
        'rt-cloud|56': 5.9,
      },
    } as any)
    vi.mocked(prisma.timelineEntry.findMany).mockResolvedValue([{
      id: 'entry-cloud',
      projectId: 'proj-1',
      featureId: 'feat-cloud',
      startWeek: 56,
      durationWeeks: 1,
      isManual: false,
      feature: {
        id: 'feat-cloud',
        name: 'Cloud Work',
        order: 0,
        isActive: true,
        epic: {
          id: 'epic-1',
          name: 'Cloud',
          order: 0,
          isActive: true,
          featureMode: 'SEQUENTIAL',
          scheduleMode: 'AUTO',
          timelineStartWeek: null,
        },
        userStories: [],
      },
    }] as any)
    vi.mocked(prisma.resourceType.findMany).mockResolvedValue([{
      id: 'rt-cloud',
      name: 'Senior Engineer - Cloud & DevOps',
      category: 'ENGINEERING',
      count: 1,
      hoursPerDay: 8,
      allocationMode: 'EFFORT',
      namedResources: [
        {
          id: 'nr-cloud',
          name: 'Taylor',
          startWeek: null,
          endWeek: null,
          allocationPct: 100,
          allocationMode: 'EFFORT',
          allocationPercent: 100,
          allocationStartWeek: null,
          allocationEndWeek: null,
        },
      ],
    }] as any)
    vi.mocked(prisma.capacityPlan.findFirst).mockResolvedValue(null as any)
    // Explicit-only role: Taylor's NAMED_PERSON profile (100%, demand-following).
    vi.mocked(prisma.capacityProfile.findMany).mockResolvedValue([namedPersonProfile({
      id: 'cp-nr-cloud', namedResourceId: 'nr-cloud',
    })] as never)

    const res = await request(app)
      .get('/api/projects/proj-1/timeline')
      .set('Authorization', authHeader)

    expect(res.status).toBe(200)

    expect(res.body.namedResources).toEqual(expect.arrayContaining([
      expect.objectContaining({
        resourceTypeName: 'Senior Engineer - Cloud & DevOps',
        name: 'Taylor',
        actualAllocatedDays: 5,
        actualAllocationStartWeek: 56,
        actualAllocationEndWeek: 56,
        actualAllocatedWeeks: [
          expect.objectContaining({
            week: 56,
            days: 5,
            capacityDays: 5,
          }),
        ],
      }),
    ]))
  })

  it('suppresses all fallback when resource type has any cached data, regardless of horizon', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue({
      ...mockProject,
      weeklyDemandCache: {
        'rt-1|0': 1.25,
      },
    } as any)
    vi.mocked(prisma.timelineEntry.findMany).mockResolvedValue([{
      id: 'entry-long-tail',
      projectId: 'proj-1',
      featureId: 'feat-long-tail',
      startWeek: 60,
      durationWeeks: 10,
      isManual: false,
      feature: {
        id: 'feat-long-tail',
        name: 'Long Tail Work',
        order: 0,
        isActive: true,
        epic: {
          id: 'epic-1',
          name: 'Late Epic',
          order: 0,
          isActive: true,
          featureMode: 'SEQUENTIAL',
          scheduleMode: 'AUTO',
          timelineStartWeek: null,
        },
        userStories: [{
          isActive: true,
          tasks: [{
            resourceTypeId: 'rt-1',
            hoursEffort: 400,
            durationDays: null,
            resourceType: { id: 'rt-1', name: 'Developer', hoursPerDay: 8 },
          }],
        }],
      },
    }] as any)
    vi.mocked(prisma.resourceType.findMany).mockResolvedValue([{
      id: 'rt-1',
      name: 'Developer',
      category: 'ENGINEERING',
      count: 2,
      hoursPerDay: 8,
      allocationMode: 'EFFORT',
      namedResources: [],
    }] as any)
    vi.mocked(prisma.capacityProfile.findMany).mockResolvedValue([roleProfile()] as never)

    const res = await request(app)
      .get('/api/projects/proj-1/timeline')
      .set('Authorization', authHeader)

    expect(res.status).toBe(200)

    // Developer has cached data (week 0) → all Developer fallback suppressed,
    // including weeks 60-70 from the long-tail entry
    const developerDemand = res.body.weeklyDemand.filter((row: any) => row.resourceTypeName === 'Developer')
    expect(developerDemand).toHaveLength(1)
    expect(developerDemand[0].week).toBe(0)
    expect(developerDemand[0].demandDays).toBe(1.25)
  })

  it('suppresses all fallback when resource type has cached data, including weeks beyond cached horizon', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue({
      ...mockProject,
      weeklyDemandCache: {
        'rt-1|55': 2.5,
        'rt-1|57': 2.5,
      },
    } as any)
    vi.mocked(prisma.timelineEntry.findMany).mockResolvedValue([{
      id: 'entry-cached-gap',
      projectId: 'proj-1',
      featureId: 'feat-cached-gap',
      startWeek: 55,
      durationWeeks: 5,
      isManual: false,
      feature: {
        id: 'feat-cached-gap',
        name: 'Cached Gap Work',
        order: 0,
        isActive: true,
        epic: {
          id: 'epic-1',
          name: 'Delivery',
          order: 0,
          isActive: true,
          featureMode: 'SEQUENTIAL',
          scheduleMode: 'AUTO',
          timelineStartWeek: null,
        },
        userStories: [{
          isActive: true,
          tasks: [{
            resourceTypeId: 'rt-1',
            hoursEffort: 200,
            durationDays: null,
            resourceType: { id: 'rt-1', name: 'Developer', hoursPerDay: 8 },
          }],
        }],
      },
    }] as any)
    vi.mocked(prisma.resourceType.findMany).mockResolvedValue([{
      id: 'rt-1',
      name: 'Developer',
      category: 'ENGINEERING',
      count: 1,
      hoursPerDay: 8,
      allocationMode: 'EFFORT',
      namedResources: [],
    }] as any)
    vi.mocked(prisma.capacityProfile.findMany).mockResolvedValue([roleProfile()] as never)

    const res = await request(app)
      .get('/api/projects/proj-1/timeline')
      .set('Authorization', authHeader)

    expect(res.status).toBe(200)

    const developerDemand = res.body.weeklyDemand
      .filter((row: any) => row.resourceTypeName === 'Developer')
      .reduce((acc: Record<number, number>, row: any) => ({ ...acc, [row.week]: row.demandDays }), {})

    // Developer has cache → all fallback suppressed. Only cached weeks survive.
    expect(developerDemand[55]).toBe(2.5)
    expect(developerDemand[56]).toBeUndefined()
    expect(developerDemand[57]).toBe(2.5)
    expect(developerDemand[58]).toBeUndefined()
    expect(developerDemand[59]).toBeUndefined()
  })
  it('suppresses all fallback when resource type has any cached data: Security only in cache weeks', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue({
      ...mockProject,
      weeklyDemandCache: {
        'rt-security|10': 2.5,
        'rt-security|11': 2.5,
        'rt-1|10': 1.5,
        'rt-1|14': 1.5,
      },
    } as any)
    vi.mocked(prisma.timelineEntry.findMany).mockResolvedValue([
      {
        id: 'entry-security-tail',
        projectId: 'proj-1',
        featureId: 'feat-security-tail',
        startWeek: 10,
        durationWeeks: 7,
        isManual: false,
        feature: {
          id: 'feat-security-tail',
          name: 'Security Tail Work',
          order: 0,
          isActive: true,
          epic: {
            id: 'epic-1',
            name: 'Security',
            order: 0,
            isActive: true,
            featureMode: 'SEQUENTIAL',
            scheduleMode: 'AUTO',
            timelineStartWeek: null,
          },
          userStories: [{
            isActive: true,
            tasks: [{
              resourceTypeId: 'rt-security',
              hoursEffort: 280,
              durationDays: null,
              resourceType: { id: 'rt-security', name: 'Principal Consultant - Security', hoursPerDay: 8 },
            }],
          }],
        },
      },
      {
        id: 'entry-cache-anchor',
        projectId: 'proj-1',
        featureId: 'feat-cache-anchor',
        startWeek: 10,
        durationWeeks: 5,
        isManual: false,
        feature: {
          id: 'feat-cache-anchor',
          name: 'Developer Cache Anchor',
          order: 1,
          isActive: true,
          epic: {
            id: 'epic-1',
            name: 'Platform',
            order: 1,
            isActive: true,
            featureMode: 'SEQUENTIAL',
            scheduleMode: 'AUTO',
            timelineStartWeek: null,
          },
          userStories: [{
            isActive: true,
            tasks: [{
              resourceTypeId: 'rt-1',
              hoursEffort: 200,
              durationDays: null,
              resourceType: { id: 'rt-1', name: 'Developer', hoursPerDay: 8 },
            }],
          }],
        },
      },
    ] as any)
    vi.mocked(prisma.resourceType.findMany).mockResolvedValue([
      {
        id: 'rt-security',
        name: 'Principal Consultant - Security',
        category: 'ENGINEERING',
        count: 1,
        hoursPerDay: 8,
        allocationMode: 'EFFORT',
        namedResources: [],
      },
      {
        id: 'rt-1',
        name: 'Developer',
        category: 'ENGINEERING',
        count: 1,
        hoursPerDay: 8,
        allocationMode: 'EFFORT',
        namedResources: [],
      },
    ] as any)
    vi.mocked(prisma.capacityPlan.findFirst).mockResolvedValue(null as any)
    vi.mocked(prisma.capacityProfile.findMany).mockResolvedValue([
      roleProfile({ id: 'cp-role-security', resourceTypeId: 'rt-security' }),
      roleProfile({ id: 'cp-role-dev', resourceTypeId: 'rt-1' }),
    ] as never)

    const res = await request(app)
      .get('/api/projects/proj-1/timeline')
      .set('Authorization', authHeader)

    expect(res.status).toBe(200)

    const securityDemand = res.body.weeklyDemand
      .filter((row: any) => row.resourceTypeName === 'Principal Consultant - Security')
      .reduce((acc: Record<number, number>, row: any) => ({ ...acc, [row.week]: row.demandDays }), {})

    // Security has cached data (weeks 10-11) → all Security fallback suppressed.
    // Only cached weeks survive; weeks 12-16 are absent (no fallback re-emergence).
    expect(securityDemand[10]).toBe(2.5)
    expect(securityDemand[11]).toBe(2.5)
    expect(securityDemand[12]).toBeUndefined()
    expect(securityDemand[13]).toBeUndefined()
    expect(securityDemand[14]).toBeUndefined()
    expect(securityDemand[15]).toBeUndefined()
    expect(securityDemand[16]).toBeUndefined()
  })

  it('cross-surface: schedule cache produces 5.0 PE days in timeline response', async () => {
    // Simulate scheduler output for the 17.5d Security + 5.0d PE fixture (hpd=7.6)
    // Security: 133h / 7.6 = 17.5 person-days, spread over 4+ weeks = 3.5-4.5 d/wk
    // PE: 38h / 7.6 = 5.0 person-days
    vi.mocked(prisma.project.findFirst).mockResolvedValue({
      ...mockProject,
      hoursPerDay: 7.6,
      weeklyDemandCache: {
        'rt-sec|0': 3.5,
        'rt-sec|1': 3.5,
        'rt-sec|2': 3.5,
        'rt-sec|3': 3.5,
        'rt-sec|4': 3.5,
        'rt-pe|5': 5.0,
      },
    } as any)
    vi.mocked(prisma.timelineEntry.findMany).mockResolvedValue([
      {
        id: 'entry-1',
        projectId: 'proj-1',
        featureId: 'feat-1',
        startWeek: 0,
        durationWeeks: 6,
        isManual: false,
        feature: {
          id: 'feat-1',
          name: 'Security & Engineering',
          order: 0,
          isActive: true,
          epic: {
            id: 'epic-1',
            name: 'Delivery',
            order: 0,
            isActive: true,
            featureMode: 'SEQUENTIAL',
            scheduleMode: 'AUTO',
            timelineStartWeek: null,
          },
          userStories: [{
            isActive: true,
            tasks: [{
              resourceTypeId: 'rt-sec',
              hoursEffort: 133,
              durationDays: null,
              resourceType: { id: 'rt-sec', name: 'Principal Consultant - Security', hoursPerDay: 7.6 },
            }],
          }],
        },
      },
    ] as any)
    vi.mocked(prisma.resourceType.findMany).mockResolvedValue([
      { id: 'rt-sec', name: 'Principal Consultant - Security', category: 'ENGINEERING', count: 1, hoursPerDay: 7.6, allocationMode: 'EFFORT', namedResources: [] },
      { id: 'rt-pe', name: 'Principal Engineer - Cloud & DevOps', category: 'ENGINEERING', count: 1, hoursPerDay: 7.6, allocationMode: 'EFFORT', namedResources: [] },
    ] as any)
    vi.mocked(prisma.capacityPlan.findFirst).mockResolvedValue(null as any)
    vi.mocked(prisma.capacityProfile.findMany).mockResolvedValue([
      roleProfile({ id: 'cp-role-sec', resourceTypeId: 'rt-sec' }),
      roleProfile({ id: 'cp-role-pe', resourceTypeId: 'rt-pe' }),
    ] as never)

    const res = await request(app)
      .get('/api/projects/proj-1/timeline')
      .set('Authorization', authHeader)

    expect(res.status).toBe(200)

    // PE demand in weeklyDemand = exactly 5.0 days (from cache, no fallback)
    const peDemand = res.body.weeklyDemand
      .filter((row: any) => row.resourceTypeName === 'Principal Engineer - Cloud & DevOps')
      .reduce((sum: number, row: any) => sum + row.demandDays, 0)
    expect(peDemand).toBeCloseTo(5.0, 1)

    // Security demand = 17.5 days (from cache, no fallback)
    const secDemand = res.body.weeklyDemand
      .filter((row: any) => row.resourceTypeName === 'Principal Consultant - Security')
      .reduce((sum: number, row: any) => sum + row.demandDays, 0)
    expect(secDemand).toBeCloseTo(17.5, 1)

    // Re-fetch (simulate second GET) — same totals
    vi.mocked(prisma.project.findFirst).mockResolvedValue({
      ...mockProject,
      hoursPerDay: 7.6,
      weeklyDemandCache: {
        'rt-sec|0': 3.5,
        'rt-sec|1': 3.5,
        'rt-sec|2': 3.5,
        'rt-sec|3': 3.5,
        'rt-sec|4': 3.5,
        'rt-pe|5': 5.0,
      },
    } as any)
    const res2 = await request(app)
      .get('/api/projects/proj-1/timeline')
      .set('Authorization', authHeader)
    const peDemand2 = res2.body.weeklyDemand
      .filter((row: any) => row.resourceTypeName === 'Principal Engineer - Cloud & DevOps')
      .reduce((sum: number, row: any) => sum + row.demandDays, 0)
    expect(peDemand2).toBeCloseTo(5.0, 1)
  })

  it('cross-surface: resource type absent from cache still receives fallback demand', async () => {
    // Developer in cache, QA absent from cache
    vi.mocked(prisma.project.findFirst).mockResolvedValue({
      ...mockProject,
      weeklyDemandCache: {
        'rt-dev|0': 5,
      },
    } as any)
    vi.mocked(prisma.timelineEntry.findMany).mockResolvedValue([{
      id: 'entry-1',
      projectId: 'proj-1',
      featureId: 'feat-1',
      startWeek: 0,
      durationWeeks: 2,
      isManual: false,
      feature: {
        id: 'feat-1',
        name: 'Dev Work',
        order: 0,
        isActive: true,
        epic: {
          id: 'epic-1',
          name: 'Delivery',
          order: 0,
          isActive: true,
          featureMode: 'SEQUENTIAL',
          scheduleMode: 'AUTO',
          timelineStartWeek: null,
        },
        userStories: [{
          isActive: true,
          tasks: [
            { resourceTypeId: 'rt-dev', hoursEffort: 40, durationDays: null, resourceType: { id: 'rt-dev', name: 'Developer', hoursPerDay: 8 } },
            { resourceTypeId: 'rt-qa', hoursEffort: 20, durationDays: null, resourceType: { id: 'rt-qa', name: 'QA', hoursPerDay: 8 } },
          ],
        }],
      },
    }] as any)
    vi.mocked(prisma.resourceType.findMany).mockResolvedValue([
      { id: 'rt-dev', name: 'Developer', category: 'ENGINEERING', count: 1, hoursPerDay: 8, allocationMode: 'EFFORT', namedResources: [] },
      { id: 'rt-qa', name: 'QA', category: 'ENGINEERING', count: 1, hoursPerDay: 8, allocationMode: 'EFFORT', namedResources: [] },
    ] as any)
    vi.mocked(prisma.capacityPlan.findFirst).mockResolvedValue(null as any)
    vi.mocked(prisma.capacityProfile.findMany).mockResolvedValue([
      roleProfile({ id: 'cp-role-dev', resourceTypeId: 'rt-dev' }),
      roleProfile({ id: 'cp-role-qa', resourceTypeId: 'rt-qa' }),
    ] as never)

    const res = await request(app)
      .get('/api/projects/proj-1/timeline')
      .set('Authorization', authHeader)

    expect(res.status).toBe(200)

    // Developer has cached demand — all Dev fallback suppressed (only week 0 from cache)
    const devDemand = res.body.weeklyDemand.filter((row: any) => row.resourceTypeName === 'Developer')
    expect(devDemand).toHaveLength(1)

    // QA has no cached demand — QA fallback retained
    const qaDemand = res.body.weeklyDemand.filter((row: any) => row.resourceTypeName === 'QA')
    expect(qaDemand.length).toBeGreaterThan(0)
  })

  it('uses materialized CAPACITY_PLAN split capacity for parallel warnings', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue({
      ...mockProject,
      bufferWeeks: 0,
    } as any)
    vi.mocked(prisma.timelineEntry.findMany).mockResolvedValue([
      {
        id: 'entry-security-1',
        projectId: 'proj-1',
        featureId: 'feat-security-1',
        startWeek: 0,
        durationWeeks: 5,
        isManual: false,
        feature: {
          id: 'feat-security-1',
          name: 'Security Stream A',
          order: 0,
          isActive: true,
          epic: {
            id: 'epic-security',
            name: 'Security',
            order: 0,
            isActive: true,
            featureMode: 'parallel',
            scheduleMode: 'AUTO',
            timelineStartWeek: null,
          },
          userStories: [
            {
              isActive: true,
              tasks: [
                {
                  resourceTypeId: 'rt-security',
                  hoursEffort: 140,
                  durationDays: null,
                  resourceType: { id: 'rt-security', name: 'Security', hoursPerDay: 8 },
                },
              ],
            },
          ],
        },
      },
      {
        id: 'entry-security-2',
        projectId: 'proj-1',
        featureId: 'feat-security-2',
        startWeek: 0,
        durationWeeks: 5,
        isManual: false,
        feature: {
          id: 'feat-security-2',
          name: 'Security Stream B',
          order: 1,
          isActive: true,
          epic: {
            id: 'epic-security',
            name: 'Security',
            order: 0,
            isActive: true,
            featureMode: 'parallel',
            scheduleMode: 'AUTO',
            timelineStartWeek: null,
          },
          userStories: [
            {
              isActive: true,
              tasks: [
                {
                  resourceTypeId: 'rt-security',
                  hoursEffort: 140,
                  durationDays: null,
                  resourceType: { id: 'rt-security', name: 'Security', hoursPerDay: 8 },
                },
              ],
            },
          ],
        },
      },
    ] as any)
    vi.mocked(prisma.resourceType.findMany).mockResolvedValue([{
      id: 'rt-security',
      name: 'Security',
      category: 'ENGINEERING',
      count: 1,
      hoursPerDay: 8,
      allocationMode: 'CAPACITY_PLAN',
      namedResources: [],
    }] as any)
    vi.mocked(prisma.capacityPlan.findFirst).mockResolvedValue({
      id: 'plan-1',
      periods: [
        { periodIndex: 0, startWeek: 0, endWeek: 5, entries: [{ resourceTypeId: 'rt-security', headcount: 1.5 }] },
      ],
    } as any)
    vi.mocked(prisma.storyTimelineEntry.findMany).mockResolvedValue([])
    vi.mocked(prisma.featureDependency.findMany).mockResolvedValue([])
    vi.mocked(prisma.epicDependency.findMany).mockResolvedValue([])
    vi.mocked(prisma.storyDependency.findMany).mockResolvedValue([])
    // ROLE profile carries the 1.5 FTE plan capacity (weeks 0-4).
    vi.mocked(prisma.capacityProfile.findMany).mockResolvedValue([roleProfile({
      id: 'cp-role-security', resourceTypeId: 'rt-security',
      planningBasis: 'CAPACITY_PROFILE', source: 'SQUAD_PLANNER', defaultPercent: 150,
      segments: [{ id: 'seg-1', capacityProfileId: 'cp-role-security', startWeek: 0, endWeek: 4, capacityPercent: 150, source: 'SQUAD_PLANNER' }],
    })] as never)

    const res = await request(app)
      .get('/api/projects/proj-1/timeline')
      .set('Authorization', authHeader)

    expect(res.status).toBe(200)
    expect(res.body.parallelWarnings).toEqual([])

    const securityCapacity = res.body.weeklyCapacity
      .filter((row: any) => row.resourceTypeName === 'Security')
      .reduce((acc: Record<number, number>, row: any) => ({ ...acc, [row.week]: row.capacityDays }), {})

    expect(securityCapacity[0]).toBe(7.5)
    expect(securityCapacity[4]).toBe(7.5)
    // Profile-first: the ROLE profile (150%) is the scheduling authority and
    // appears as the synthetic aggregate role resource; plan trajectories are
    // not duplicated into the response.
    expect(res.body.namedResources).toEqual(expect.arrayContaining([
      expect.objectContaining({
        resourceTypeName: 'Security',
        name: 'Security (Role)',
        synthetic: true,
        allocationMode: 'EFFORT',
        allocationPct: 100,
      }),
    ]))
  })
  it('excludes story entries for inactive features from storyEntries', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue(mockProject as any)
    vi.mocked(prisma.timelineEntry.findMany).mockResolvedValue([
      {
        id: 'entry-active',
        projectId: 'proj-1',
        featureId: 'feat-active',
        startWeek: 0,
        durationWeeks: 2,
        isManual: false,
        feature: {
          id: 'feat-active',
          name: 'Active Feature',
          order: 0,
          isActive: true,
          epic: { id: 'epic-1', name: 'Main Epic', isActive: true, order: 0, featureMode: 'SEQUENTIAL', scheduleMode: 'AUTO', timelineStartWeek: null },
          userStories: [],
        },
      },
      {
        id: 'entry-inactive',
        projectId: 'proj-1',
        featureId: 'feat-inactive',
        startWeek: 3,
        durationWeeks: 2,
        isManual: false,
        feature: {
          id: 'feat-inactive',
          name: 'Inactive Feature',
          order: 1,
          isActive: false,
          epic: { id: 'epic-1', name: 'Main Epic', isActive: true, order: 0, featureMode: 'SEQUENTIAL', scheduleMode: 'AUTO', timelineStartWeek: null },
          userStories: [],
        },
      },
    ] as any)
    vi.mocked(prisma.resourceType.findMany).mockResolvedValue([])
    vi.mocked(prisma.storyTimelineEntry.findMany).mockResolvedValue([
      {
        storyId: 'story-active',
        startWeek: 0,
        durationWeeks: 2,
        isManual: false,
        story: { name: 'Active Story', featureId: 'feat-active' },
      },
      {
        storyId: 'story-inactive',
        startWeek: 3,
        durationWeeks: 2,
        isManual: false,
        story: { name: 'Inactive Story', featureId: 'feat-inactive' },
      },
    ] as any)

    const res = await request(app)
      .get('/api/projects/proj-1/timeline')
      .set('Authorization', authHeader)

    expect(res.status).toBe(200)
    expect(res.body.storyEntries).toHaveLength(1)
    expect(res.body.storyEntries[0].storyName).toBe('Active Story')
    expect(res.body.storyEntries[0].featureId).toBe('feat-active')
  })
  it('excludes story entries for inactive epic from storyEntries', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue(mockProject as any)
    vi.mocked(prisma.timelineEntry.findMany).mockResolvedValue([
      {
        id: 'entry-active-epic',
        projectId: 'proj-1',
        featureId: 'feat-active-epic',
        startWeek: 0,
        durationWeeks: 2,
        isManual: false,
        feature: {
          id: 'feat-active-epic',
          name: 'Feature in Active Epic',
          order: 0,
          isActive: true,
          epic: { id: 'epic-active', name: 'Active Epic', isActive: true, order: 0, featureMode: 'SEQUENTIAL', scheduleMode: 'AUTO', timelineStartWeek: null },
          userStories: [],
        },
      },
      {
        id: 'entry-inactive-epic',
        projectId: 'proj-1',
        featureId: 'feat-inactive-epic',
        startWeek: 3,
        durationWeeks: 2,
        isManual: false,
        feature: {
          id: 'feat-inactive-epic',
          name: 'Feature in Inactive Epic',
          order: 1,
          isActive: true,
          epic: { id: 'epic-inactive', name: 'Inactive Epic', isActive: false, order: 1, featureMode: 'SEQUENTIAL', scheduleMode: 'AUTO', timelineStartWeek: null },
          userStories: [],
        },
      },
    ] as any)
    vi.mocked(prisma.resourceType.findMany).mockResolvedValue([])
    vi.mocked(prisma.storyTimelineEntry.findMany).mockResolvedValue([
      {
        storyId: 'story-active-epic',
        startWeek: 0,
        durationWeeks: 2,
        isManual: false,
        story: { name: 'Active Epic Story', featureId: 'feat-active-epic' },
      },
      {
        storyId: 'story-inactive-epic',
        startWeek: 3,
        durationWeeks: 2,
        isManual: false,
        story: { name: 'Inactive Epic Story', featureId: 'feat-inactive-epic' },
      },
    ] as any)

    const res = await request(app)
      .get('/api/projects/proj-1/timeline')
      .set('Authorization', authHeader)

    expect(res.status).toBe(200)
    expect(res.body.storyEntries).toHaveLength(1)
    expect(res.body.storyEntries[0].storyName).toBe('Active Epic Story')
    expect(res.body.storyEntries[0].featureId).toBe('feat-active-epic')
  })
})

describe('POST /api/projects/:projectId/timeline/schedule', () => {
  it('returns 401 without auth', async () => {
    const res = await request(app).post('/api/projects/proj-1/timeline/schedule')
    expect(res.status).toBe(401)
  })

  it('returns 404 for project not owned by user', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue(null)
    const res = await request(app)
      .post('/api/projects/proj-1/timeline/schedule')
      .set('Authorization', authHeader)
    expect(res.status).toBe(404)
  })

  it('calculates duration correctly: 16h, 1 resource, 8h/day = 2 days = 1 week', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue(mockProject as any)
    vi.mocked(prisma.capacityProfile.findMany).mockResolvedValue([roleProfile()] as never)
    vi.mocked(prisma.epic.findMany).mockResolvedValue([
      {
        id: 'epic-1',
        name: 'Auth',
        order: 0,
        features: [
          {
            id: 'feat-1',
            name: 'Login',
            order: 0,
            userStories: [
              {
                id: 'story-1',
                tasks: [
                  {
                    id: 'task-1',
                    hoursEffort: 16,
                    durationDays: null,
                    resourceTypeId: 'rt-1',
                    resourceType: { id: 'rt-1', count: 1 },
                  },
                ],
              },
            ],
          },
        ],
      },
    ] as any)
    vi.mocked(prisma.resourceType.findMany).mockResolvedValue(mockResourceTypes as any)
    vi.mocked(prisma.timelineEntry.upsert).mockResolvedValue({} as any)
    vi.mocked(prisma.timelineEntry.findMany).mockResolvedValue([
      {
        id: 'entry-1',
        projectId: 'proj-1',
        featureId: 'feat-1',
        startWeek: 0,
        durationWeeks: 1,  // ceil(2 days / 5) = 1 week
        isManual: false,
        feature: { name: 'Login', epic: { id: 'epic-1', name: 'Auth' }, userStories: [] },
      },
    ] as any)

    const res = await request(app)
      .post('/api/projects/proj-1/timeline/schedule')
      .set('Authorization', authHeader)
      .send({})

    expect(res.status).toBe(200)
    expect(res.body.entries).toHaveLength(1)
    expect(res.body.entries[0].durationWeeks).toBe(1)
    expect(res.body.entries[0].startWeek).toBe(0)
  })

  it('returns entries for a project with tasks and updates startDate if provided', async () => {
    const updatedProject = { ...mockProject, startDate: new Date('2026-04-01T00:00:00.000Z') }
    vi.mocked(prisma.project.findFirst).mockResolvedValue(mockProject as any)
    vi.mocked(prisma.capacityProfile.findMany).mockResolvedValue([roleProfile()] as never)
    vi.mocked(prisma.project.update).mockResolvedValue(updatedProject as any)
    vi.mocked(prisma.epic.findMany).mockResolvedValue(mockEpicsWithFeatures as any)
    vi.mocked(prisma.resourceType.findMany).mockResolvedValue(mockResourceTypes as any)
    vi.mocked(prisma.timelineEntry.upsert).mockResolvedValue({} as any)
    vi.mocked(prisma.timelineEntry.findMany).mockResolvedValue([
      {
        id: 'entry-1',
        projectId: 'proj-1',
        featureId: 'feat-1',
        startWeek: 0,
        durationWeeks: 1,
        isManual: false,
        feature: { name: 'Login', epic: { id: 'epic-1', name: 'Authentication' }, userStories: [] },
      },
      {
        id: 'entry-2',
        projectId: 'proj-1',
        featureId: 'feat-2',
        startWeek: 1,
        durationWeeks: 1,
        isManual: false,
        feature: { name: 'Registration', epic: { id: 'epic-1', name: 'Authentication' }, userStories: [] },
      },
    ] as any)

    const res = await request(app)
      .post('/api/projects/proj-1/timeline/schedule')
      .set('Authorization', authHeader)
      .send({ startDate: '2026-04-01' })

    expect(res.status).toBe(200)
    expect(res.body.entries).toHaveLength(2)
    // feat-2 should start after feat-1
    expect(res.body.entries[1].startWeek).toBeGreaterThanOrEqual(res.body.entries[0].startWeek)
  })
})

describe('PUT /api/projects/:projectId/timeline/:featureId', () => {
  it('returns 401 without auth', async () => {
    const res = await request(app).put('/api/projects/proj-1/timeline/feat-1')
    expect(res.status).toBe(401)
  })

  it('returns 404 for project not owned by user', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue(null)
    const res = await request(app)
      .put('/api/projects/proj-1/timeline/feat-1')
      .set('Authorization', authHeader)
      .send({ startWeek: 2, durationWeeks: 3 })
    expect(res.status).toBe(404)
  })

  it('overrides a feature startWeek and durationWeeks with isManual=true', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue(mockProject as any)
    vi.mocked(prisma.feature.findFirst).mockResolvedValue({ id: 'feat-1', epicId: 'epic-1' } as any)
    vi.mocked(prisma.timelineEntry.upsert).mockResolvedValue({
      id: 'entry-1',
      projectId: 'proj-1',
      featureId: 'feat-1',
      startWeek: 2,
      durationWeeks: 3,
      isManual: true,
      feature: { name: 'Login', epic: { id: 'epic-1', name: 'Authentication' } },
    } as any)

    const res = await request(app)
      .put('/api/projects/proj-1/timeline/feat-1')
      .set('Authorization', authHeader)
      .send({ startWeek: 2, durationWeeks: 3 })

    expect(res.status).toBe(200)
    expect(res.body.startWeek).toBe(2)
    expect(res.body.durationWeeks).toBe(3)
    expect(res.body.isManual).toBe(true)
  })

  it('returns 404 when the feature belongs to another project (cross-tenant write)', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue(mockProject as any)
    // Feature ownership scoped to the authorised project — foreign feature not found
    vi.mocked(prisma.feature.findFirst).mockResolvedValue(null)

    const res = await request(app)
      .put('/api/projects/proj-1/timeline/feat-foreign')
      .set('Authorization', authHeader)
      .send({ startWeek: 2, durationWeeks: 3 })

    expect(res.status).toBe(404)
    expect(prisma.timelineEntry.upsert).not.toHaveBeenCalled()
  })

  it('returns 400 when startWeek or durationWeeks missing', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue(mockProject as any)
    const res = await request(app)
      .put('/api/projects/proj-1/timeline/feat-1')
      .set('Authorization', authHeader)
      .send({ startWeek: 2 })
    expect(res.status).toBe(400)
  })

  it('clears weeklyDemandCache on manual feature timeline override', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue(mockProject as any)
    vi.mocked(prisma.feature.findFirst).mockResolvedValue({ id: 'feat-1', epicId: 'epic-1' } as any)
    vi.mocked(prisma.timelineEntry.upsert).mockResolvedValue({
      id: 'entry-1',
      projectId: 'proj-1',
      featureId: 'feat-1',
      startWeek: 5,
      durationWeeks: 2,
      isManual: true,
      feature: { name: 'Login', epic: { id: 'epic-1', name: 'Authentication' } },
    } as any)

    const res = await request(app)
      .put('/api/projects/proj-1/timeline/feat-1')
      .set('Authorization', authHeader)
      .send({ startWeek: 5, durationWeeks: 2 })

    expect(res.status).toBe(200)
    const updateCalls = vi.mocked(prisma.project.update).mock.calls
    const cacheClearCall = updateCalls.find(c => {
      const args = c[0] as { where: { id: string }; data: { weeklyDemandCache: unknown } }
      return args?.where?.id === 'proj-1' && args?.data && typeof args.data.weeklyDemandCache === 'object'
    })
    expect(cacheClearCall).toBeTruthy()
  })
})

describe('POST /schedule — DAG algorithm', () => {
  const makeEpic = (overrides: Record<string, any> = {}) => ({
    id: 'epic-1',
    name: 'Auth',
    order: 0,
    featureMode: 'sequential',
    timelineStartWeek: null,
    ...overrides,
  })

  const makeFeature = (id: string, name: string, order: number, tasks: any[] = [], deps: any[] = []) => ({
    id,
    name,
    order,
    dependencies: deps,
    userStories: tasks.length > 0 ? [{ id: `story-${id}`, tasks }] : [],
  })

  const makeTask = (id: string, hours: number) => ({
    id,
    hoursEffort: hours,
    durationDays: null,
    resourceTypeId: 'rt-1',
    resourceType: { id: 'rt-1', hoursPerDay: 8, count: 1 },
  })

  const makeEntries = (entries: Array<{ featureId: string; featureName: string; startWeek: number; durationWeeks: number }>) =>
    entries.map((e, i) => ({
      id: `entry-${i}`,
      projectId: 'proj-1',
      featureId: e.featureId,
      startWeek: e.startWeek,
      durationWeeks: e.durationWeeks,
      isManual: false,
      feature: {
        name: e.featureName,
        epic: { id: 'epic-1', name: 'Auth', featureMode: 'sequential', timelineStartWeek: null },
        userStories: [],
      },
    }))

  it('sequential mode: feat-B starts after feat-A finishes', async () => {
    const featA = makeFeature('feat-a', 'Feature A', 0, [makeTask('t1', 40)])  // 40h / 8hpd = 5 days = 1 week
    const featB = makeFeature('feat-b', 'Feature B', 1, [makeTask('t2', 40)])

    vi.mocked(prisma.project.findFirst).mockResolvedValue(mockProject as any)
    vi.mocked(prisma.capacityProfile.findMany).mockResolvedValue([roleProfile()] as never)
    vi.mocked(prisma.epic.findMany).mockResolvedValue([makeEpic({ features: [featA, featB] })] as any)
    vi.mocked(prisma.resourceType.findMany).mockResolvedValue(mockResourceTypes as any)
    vi.mocked(prisma.timelineEntry.findMany)
      .mockResolvedValueOnce([])  // for manualStartWeeks
      .mockResolvedValueOnce(makeEntries([
        { featureId: 'feat-a', featureName: 'Feature A', startWeek: 0, durationWeeks: 1 },
        { featureId: 'feat-b', featureName: 'Feature B', startWeek: 1, durationWeeks: 1 },
      ]) as any)
    vi.mocked(prisma.timelineEntry.upsert).mockResolvedValue({} as any)

    const res = await request(app)
      .post('/api/projects/proj-1/timeline/schedule')
      .set('Authorization', authHeader)
      .send({})

    expect(res.status).toBe(200)
    const entries = res.body.entries
    const a = entries.find((e: any) => e.featureId === 'feat-a')
    const b = entries.find((e: any) => e.featureId === 'feat-b')
    expect(a.startWeek).toBe(0)
    expect(b.startWeek).toBe(1)  // B starts after A finishes
  })

  it('parallel mode: two features both start at week 0', async () => {
    const featA = makeFeature('feat-a', 'Feature A', 0, [makeTask('t1', 40)])
    const featB = makeFeature('feat-b', 'Feature B', 1, [makeTask('t2', 40)])

    vi.mocked(prisma.project.findFirst).mockResolvedValue(mockProject as any)
    vi.mocked(prisma.capacityProfile.findMany).mockResolvedValue([roleProfile()] as never)
    vi.mocked(prisma.epic.findMany).mockResolvedValue([makeEpic({ featureMode: 'parallel', features: [featA, featB] })] as any)
    vi.mocked(prisma.resourceType.findMany).mockResolvedValue(mockResourceTypes as any)
    vi.mocked(prisma.timelineEntry.findMany)
      .mockResolvedValueOnce([])  // for manualStartWeeks
      .mockResolvedValueOnce(makeEntries([
        { featureId: 'feat-a', featureName: 'Feature A', startWeek: 0, durationWeeks: 1 },
        { featureId: 'feat-b', featureName: 'Feature B', startWeek: 0, durationWeeks: 1 },
      ]) as any)
    vi.mocked(prisma.timelineEntry.upsert).mockResolvedValue({} as any)

    const res = await request(app)
      .post('/api/projects/proj-1/timeline/schedule')
      .set('Authorization', authHeader)
      .send({})

    expect(res.status).toBe(200)
    const entries = res.body.entries
    const a = entries.find((e: any) => e.featureId === 'feat-a')
    const b = entries.find((e: any) => e.featureId === 'feat-b')
    expect(a.startWeek).toBe(0)
    expect(b.startWeek).toBe(0)  // Both start at same week (parallel)
  })

  it('epic anchor: timelineStartWeek=4 pushes all features to start at week 4+', async () => {
    const featA = makeFeature('feat-a', 'Feature A', 0, [makeTask('t1', 40)])

    vi.mocked(prisma.project.findFirst).mockResolvedValue(mockProject as any)
    vi.mocked(prisma.capacityProfile.findMany).mockResolvedValue([roleProfile()] as never)
    vi.mocked(prisma.epic.findMany).mockResolvedValue([makeEpic({ timelineStartWeek: 4, features: [featA] })] as any)
    vi.mocked(prisma.resourceType.findMany).mockResolvedValue(mockResourceTypes as any)
    vi.mocked(prisma.timelineEntry.findMany)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(makeEntries([
        { featureId: 'feat-a', featureName: 'Feature A', startWeek: 4, durationWeeks: 1 },
      ]) as any)
    vi.mocked(prisma.timelineEntry.upsert).mockResolvedValue({} as any)

    const res = await request(app)
      .post('/api/projects/proj-1/timeline/schedule')
      .set('Authorization', authHeader)
      .send({})

    expect(res.status).toBe(200)
    const a = res.body.entries[0]
    expect(a.startWeek).toBeGreaterThanOrEqual(4)
  })

  it('cross-epic dependency: feat-B in epic-2 starts after feat-A in epic-1 finishes', async () => {
    const featA = makeFeature('feat-a', 'Feature A', 0, [makeTask('t1', 40)])
    const featB = makeFeature('feat-b', 'Feature B', 0, [makeTask('t2', 40)], [{ featureId: 'feat-b', dependsOnId: 'feat-a' }])

    vi.mocked(prisma.project.findFirst).mockResolvedValue(mockProject as any)
    vi.mocked(prisma.capacityProfile.findMany).mockResolvedValue([roleProfile()] as never)
    vi.mocked(prisma.epic.findMany).mockResolvedValue([
      makeEpic({ id: 'epic-1', name: 'Epic 1', features: [featA] }),
      makeEpic({ id: 'epic-2', name: 'Epic 2', order: 1, featureMode: 'parallel', features: [featB] }),
    ] as any)
    vi.mocked(prisma.resourceType.findMany).mockResolvedValue(mockResourceTypes as any)
    vi.mocked(prisma.timelineEntry.findMany)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        ...makeEntries([{ featureId: 'feat-a', featureName: 'Feature A', startWeek: 0, durationWeeks: 1 }]),
        ...makeEntries([{ featureId: 'feat-b', featureName: 'Feature B', startWeek: 1, durationWeeks: 1 }]),
      ] as any)
    vi.mocked(prisma.timelineEntry.upsert).mockResolvedValue({} as any)

    const res = await request(app)
      .post('/api/projects/proj-1/timeline/schedule')
      .set('Authorization', authHeader)
      .send({})

    expect(res.status).toBe(200)
    const entries = res.body.entries
    const a = entries.find((e: any) => e.featureId === 'feat-a')
    const b = entries.find((e: any) => e.featureId === 'feat-b')
    expect(b.startWeek).toBeGreaterThanOrEqual(a.startWeek + a.durationWeeks)
  })

  it('manual override preserved: isManual=true feature keeps startWeek after re-scheduling', async () => {
    const featA = makeFeature('feat-a', 'Feature A', 0, [makeTask('t1', 40)])

    vi.mocked(prisma.project.findFirst).mockResolvedValue(mockProject as any)
    vi.mocked(prisma.capacityProfile.findMany).mockResolvedValue([roleProfile()] as never)
    vi.mocked(prisma.epic.findMany).mockResolvedValue([makeEpic({ features: [featA] })] as any)
    vi.mocked(prisma.resourceType.findMany).mockResolvedValue(mockResourceTypes as any)
    // Return a manual entry for feat-a
    vi.mocked(prisma.timelineEntry.findMany)
      .mockResolvedValueOnce([{ featureId: 'feat-a', startWeek: 5, isManual: true }] as any)
      .mockResolvedValueOnce([{
        id: 'entry-1',
        projectId: 'proj-1',
        featureId: 'feat-a',
        startWeek: 5,
        durationWeeks: 1,
        isManual: true,
        feature: { name: 'Feature A', epic: { id: 'epic-1', name: 'Auth', featureMode: 'sequential', timelineStartWeek: null }, userStories: [] },
      }] as any)
    vi.mocked(prisma.timelineEntry.upsert).mockResolvedValue({} as any)

    const res = await request(app)
      .post('/api/projects/proj-1/timeline/schedule')
      .set('Authorization', authHeader)
      .send({})

    expect(res.status).toBe(200)
    const a = res.body.entries[0]
    expect(a.startWeek).toBe(5)
    expect(a.isManual).toBe(true)
  })
})

describe('getWeeklyCapacity', () => {
  const makeNR = (overrides: Record<string, any> = {}) => ({
    id: 'nr-1',
    name: 'Dev 1',
    startWeek: null as number | null,
    endWeek: null as number | null,
    allocationPct: 100,
    allocationMode: 'EFFORT',
    allocationPercent: 100,
    allocationStartWeek: null as number | null,
    allocationEndWeek: null as number | null,
    ...overrides,
  })
  const makeRT = (overrides: Record<string, any> = {}) => ({
    id: 'rt-1',
    name: 'Developer',
    count: 1,
    hoursPerDay: null as number | null,
    namedResources: [] as ReturnType<typeof makeNR>[],
    ...overrides,
  })

  it('no named resources — uses aggregate count', () => {
    const rt = makeRT({ count: 3, namedResources: [] })
    // 3 people * 8 h/day * 5 days = 120
    expect(getWeeklyCapacity(rt, 0, 8)).toBe(120)
    expect(getWeeklyCapacity(rt, 10, 8)).toBe(120)
  })

  it('named resources — all active (null start/end)', () => {
    const rt = makeRT({
      namedResources: [
        makeNR({ id: 'nr1', name: 'Dev 1' }),
        makeNR({ id: 'nr2', name: 'Dev 2' }),
      ],
    })
    // 2 people * 8 h/day * 5 days = 80
    expect(getWeeklyCapacity(rt, 0, 8)).toBe(80)
    expect(getWeeklyCapacity(rt, 99, 8)).toBe(80)
  })

  it('named resources — staggered start', () => {
    const rt = makeRT({
      namedResources: [
        makeNR({ id: 'nr1', name: 'Dev 1', startWeek: 0 }),
        makeNR({ id: 'nr2', name: 'Dev 2', startWeek: 4 }),
      ],
    })
    // Week 0: only NR1 → 1 * 7.6 * 5 = 38
    expect(getWeeklyCapacity(rt, 0, 7.6)).toBe(38)
    // Week 4: both active → 2 * 7.6 * 5 = 76
    expect(getWeeklyCapacity(rt, 4, 7.6)).toBe(76)
  })

  it('named resources — partial allocation (FULL_PROJECT mode)', () => {
    const rt = makeRT({
      namedResources: [
        makeNR({ id: 'nr1', name: 'Dev 1', allocationMode: 'FULL_PROJECT', allocationPercent: 50 }),
      ],
    })
    // 0.5 * 8 * 5 = 20
    expect(getWeeklyCapacity(rt, 0, 8)).toBe(20)
  })

  it('named resources — TIMELINE mode respects allocationPercent', () => {
    const rt = makeRT({
      namedResources: [
        makeNR({ id: 'nr1', name: 'Dev 1', allocationMode: 'TIMELINE', allocationPercent: 80, allocationStartWeek: 2, allocationEndWeek: 6 }),
      ],
    })
    // Week 1: outside window → 0
    expect(getWeeklyCapacity(rt, 1, 8)).toBe(0)
    // Week 4: inside window at 80% → 0.8 * 8 * 5 = 32
    expect(getWeeklyCapacity(rt, 4, 8)).toBe(32)
    // Week 7: outside window → 0
    expect(getWeeklyCapacity(rt, 7, 8)).toBe(0)
  })

  it('named resources — EFFORT (T&M) mode always 100% capacity', () => {
    const rt = makeRT({
      namedResources: [
        makeNR({ id: 'nr1', name: 'Dev 1', allocationMode: 'EFFORT', allocationPercent: 50 }),
      ],
    })
    // EFFORT ignores allocationPercent for capacity → 1 * 8 * 5 = 40
    expect(getWeeklyCapacity(rt, 0, 8)).toBe(40)
  })

  it('named resources — person leaves early', () => {
    const rt = makeRT({
      namedResources: [
        makeNR({ id: 'nr1', name: 'Dev 1', startWeek: 0, endWeek: 3 }),
        makeNR({ id: 'nr2', name: 'Dev 2', startWeek: 0 }),
      ],
    })
    // Week 2: both active → 2 * 8 * 5 = 80
    expect(getWeeklyCapacity(rt, 2, 8)).toBe(80)
    // Week 4: only NR2 → 1 * 8 * 5 = 40
    expect(getWeeklyCapacity(rt, 4, 8)).toBe(40)
  })

  it('count > namedResources.length: phantom slots fill the remainder', () => {
    const rt = makeRT({
      count: 5,
      namedResources: [
        makeNR({ id: 'nr1', name: 'Dev 1' }),
        makeNR({ id: 'nr2', name: 'Dev 2' }),
      ],
    })
    // 2 named (100%) + 3 phantom slots → effective headcount = 5 = count
    // Total = 5 * 8 * 5 = 200
    expect(getWeeklyCapacity(rt, 0, 8)).toBe(200)
  })
})

describe('POST /api/projects/:projectId/timeline/level — buildSnapshot rejection', () => {
  it('returns 500 when buildSnapshot rejects, preventing snapshot persistence and mutation', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue(mockProject as never)
    vi.mocked(prisma.epic.findMany).mockResolvedValue([] as never)
    vi.mocked(prisma.resourceType.findMany).mockResolvedValue([] as never)
    vi.mocked(prisma.timelineEntry.findMany).mockResolvedValue([] as never)
    vi.mocked(prisma.storyTimelineEntry.findMany).mockResolvedValue([] as never)
    vi.mocked(prisma.epicDependency.findMany).mockResolvedValue([] as never)
    vi.mocked(buildSnapshot).mockRejectedValueOnce(new Error('Snapshot null-state rejection'))

    const res = await request(app)
      .post('/api/projects/proj-1/timeline/level')
      .set('Authorization', authHeader)
      .send({})

    expect(res.status).toBe(500)
    expect(prisma.backlogSnapshot.create).not.toHaveBeenCalled()
    expect(prisma.$transaction).not.toHaveBeenCalled()
  })
})

describe('error classification (issue #387)', () => {
  it('unexpected planning derivation failure reaches the central error handler (500, not 404)', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue(mockProject as never)
    vi.mocked(prisma.timelineEntry.findMany).mockRejectedValue(new Error('boom'))

    const res = await request(app)
      .get('/api/projects/proj-1/timeline')
      .set('Authorization', authHeader)

    expect(res.status).toBe(500)
    expect(res.body.error).toContain('boom')
  })

  it('malformed startDate on schedule returns an actionable 400', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue(mockProject as never)

    const res = await request(app)
      .post('/api/projects/proj-1/timeline/schedule')
      .set('Authorization', authHeader)
      .send({ startDate: 'not-a-real-date' })

    expect(res.status).toBe(400)
    expect(res.body.error).toContain('startDate')
  })
})
