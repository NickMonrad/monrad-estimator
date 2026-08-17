import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { app } from '../index.js'
import { prisma } from '../lib/prisma.js'
import * as capacityProfileAdapter from '../lib/capacityProfileResourceAdapter.js'

// ─── Hoisted: shared context for adapter real-fn reference ─────────────────
const testCtx = vi.hoisted(() => {
  const shared: { realBuildFn?: (...args: unknown[]) => unknown } = {}
  return shared
})

// Mock the adapter by default with a synthesis that derives profile data from
// persisted capacityProfiles when present, else from the resource type's own
// legacy-shaped allocation fields. This mirrors the pre-#418 legacy-derived
// read behaviour for tests that don't assert on persisted profile state, while
// integration tests below exercise the real implementation via useRealAdapter().
vi.mock('../lib/capacityProfileResourceAdapter.js', async (importOriginal) => {
  const actual: Record<string, unknown> = await importOriginal()
  // Store reference so integration tests can exercise the real implementation
  testCtx.realBuildFn = actual.buildResourceCapacityProfileMap as (...args: unknown[]) => unknown

  function camelEnum(value: unknown): string {
    if (typeof value !== 'string') return 'fixed'
    return value.toLowerCase().replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())
  }

  function basisForMode(mode: unknown): string {
    if (mode === 'TIMELINE') return 'availabilityWindow'
    if (mode === 'FULL_PROJECT') return 'wholeProjectAllocation'
    if (mode === 'CAPACITY_PLAN') return 'capacityProfile'
    return 'demandFollowing'
  }

  function synthProfile(input: Record<string, unknown>) {
    const basis = basisForMode(input.allocationMode)
    const source = basis === 'availabilityWindow' ? 'availabilityWindow' : basis === 'capacityProfile' ? 'squadPlanner' : 'fixed'
    return {
      id: `synth-${String(input.id)}`,
      planningBasis: basis,
      source,
      defaultPercent: input.allocationPercent ?? input.allocationPct ?? 100,
      startWeek: input.allocationStartWeek ?? input.startWeek ?? null,
      endWeek: input.allocationEndWeek ?? input.endWeek ?? null,
      segments: [],
      resolutionSource: 'PROFILE',
      legacyWriter: null,
    }
  }

  function synthesizeCapacityMap(input: any) {
    const roleProfiles = new Map<string, Record<string, unknown>>()
    const namedResourceProfiles = new Map<string, Record<string, unknown>>()
    const persisted = Array.isArray(input?.capacityProfiles) ? input.capacityProfiles : []
    const persistedByRT = new Map<string, any>(
      persisted
        .filter((p: any) => p.ownerKind === 'ROLE' && p.resourceTypeId != null)
        .map((p: any) => [p.resourceTypeId, p] as [string, any]),
    )
    const persistedByNR = new Map<string, any>(
      persisted
        .filter((p: any) => p.namedResourceId != null)
        .map((p: any) => [p.namedResourceId, p] as [string, any]),
    )

    for (const rt of input?.resourceTypes ?? []) {
      const nrs = rt.namedResources ?? []
      for (const nr of nrs) {
        const persistedProfile = persistedByNR.get(nr.id)
        if (persistedProfile) {
          namedResourceProfiles.set(nr.id, {
            id: persistedProfile.id,
            planningBasis: camelEnum(persistedProfile.planningBasis),
            source: camelEnum(persistedProfile.source),
            defaultPercent: persistedProfile.defaultPercent ?? null,
            startWeek: persistedProfile.startWeek ?? null,
            endWeek: persistedProfile.endWeek ?? null,
            segments: (persistedProfile.segments ?? []).map((seg: any) => ({
              startWeek: seg.startWeek,
              endWeek: seg.endWeek,
              capacityPercent: seg.capacityPercent,
            })),
            resolutionSource: 'PROFILE',
            resourceIdentity: persistedProfile.ownerKind === 'PLANNED_RESOURCE' ? 'PLANNED_RESOURCE' : 'NAMED_PERSON',
            legacyWriter: persistedProfile.legacy?.writer ?? null,
          })
        } else {
          namedResourceProfiles.set(nr.id, { ...synthProfile(nr), resourceIdentity: 'NAMED_PERSON' })
        }
      }
      const persistedRole = persistedByRT.get(rt.id)
      if (persistedRole) {
        roleProfiles.set(rt.id, {
          id: persistedRole.id,
          planningBasis: camelEnum(persistedRole.planningBasis),
          source: camelEnum(persistedRole.source),
          defaultPercent: persistedRole.defaultPercent ?? null,
          startWeek: persistedRole.startWeek ?? null,
          endWeek: persistedRole.endWeek ?? null,
          segments: (persistedRole.segments ?? []).map((seg: any) => ({
            startWeek: seg.startWeek,
            endWeek: seg.endWeek,
            capacityPercent: seg.capacityPercent,
          })),
          resolutionSource: 'PROFILE',
          legacyWriter: persistedRole.legacy?.writer ?? null,
        })
      } else if (nrs.length === 0) {
        roleProfiles.set(rt.id, synthProfile(rt))
      }
    }
    return { roleProfiles, namedResourceProfiles }
  }

  return {
    ...actual,
    buildResourceCapacityProfileMap: vi.fn(synthesizeCapacityMap),
  }
})

process.env.JWT_SECRET = 'test-secret'

const userId = 'user-1'
const token = jwt.sign({ userId }, 'test-secret')
const authHeader = `Bearer ${token}`

beforeEach(() => {
  vi.clearAllMocks()
  // The real resolveSchedulerCapacity queries Prisma directly. Feed it from
  // the project fixture the route under test already mocked, so the resolver
  // sees exactly the same resource types / profiles / plan as the route.
  vi.mocked(prisma.resourceType.findMany).mockImplementation((async () => {
    const results = vi.mocked(prisma.project.findFirst).mock.results
    const last = results.length > 0 ? await results[results.length - 1].value : undefined
    return ((last as { resourceTypes?: unknown } | undefined)?.resourceTypes ?? []) as never[]
  }) as any)
  vi.mocked(prisma.capacityProfile.findMany).mockImplementation((async () => {
    const results = vi.mocked(prisma.project.findFirst).mock.results
    const last = results.length > 0 ? await results[results.length - 1].value : undefined
    return ((last as { capacityProfiles?: unknown } | undefined)?.capacityProfiles ?? []) as never[]
  }) as any)
  vi.mocked(prisma.capacityPlan.findFirst).mockImplementation((async () => {
    const results = vi.mocked(prisma.project.findFirst).mock.results
    const last = results.length > 0 ? await results[results.length - 1].value : undefined
    const plans = (last as { capacityPlans?: unknown[] } | undefined)?.capacityPlans
    return Array.isArray(plans) && plans.length > 0 ? (plans[0] as never) : null
  }) as any)
})

describe('GET /api/projects/:projectId/resource-profile', () => {
  it('uses task.hoursEffort for effort totals when durationDays is provided', async () => {
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
    expect(devRow.effortDays).toBe(1)
    expect(devRow.totalDays).toBe(1)
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
        { featureId: 'feat-1', feature: { id: 'feat-1', name: 'Feature', order: 0, isActive: true, timelineColour: null, epic: { id: 'epic-1', name: 'Epic', order: 0, isActive: true, featureMode: 'sequential', scheduleMode: 'auto', timelineStartWeek: null }, userStories: [] }, startWeek: 4, durationWeeks: 12 },
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
      // Profile-first: the plan's 0/1/0/1 windows are encoded as persisted
      // capacity segments (issue #418) — no plan-fallback derivation.
      capacityProfiles: [
        {
          id: 'cp-role-security', projectId: 'proj-1', ownerKind: 'ROLE',
          resourceTypeId: 'rt-security', namedResourceId: null,
          planningBasis: 'CAPACITY_PROFILE', source: 'SQUAD_PLANNER',
          defaultPercent: null, startWeek: null, endWeek: null, legacy: null,
          segments: [
            { id: 'seg-r1', capacityProfileId: 'cp-role-security', startWeek: 4, endWeek: 7, capacityPercent: 100, source: 'SQUAD_PLANNER' },
            { id: 'seg-r2', capacityProfileId: 'cp-role-security', startWeek: 12, endWeek: 15, capacityPercent: 100, source: 'SQUAD_PLANNER' },
          ],
        },
        {
          id: 'cp-nr-security', projectId: 'proj-1', ownerKind: 'NAMED_PERSON',
          resourceTypeId: null, namedResourceId: 'nr-security',
          planningBasis: 'CAPACITY_PROFILE', source: 'SQUAD_PLANNER',
          defaultPercent: null, startWeek: null, endWeek: null, legacy: null,
          segments: [
            { id: 'seg-n1', capacityProfileId: 'cp-nr-security', startWeek: 4, endWeek: 7, capacityPercent: 100, source: 'SQUAD_PLANNER' },
            { id: 'seg-n2', capacityProfileId: 'cp-nr-security', startWeek: 12, endWeek: 15, capacityPercent: 100, source: 'SQUAD_PLANNER' },
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
    // The profile-first row includes the persisted NR plus the synthetic
    // role aggregate (roleSegments authority) — match the persisted NR by content.
    expect(securityRow.namedResources).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'Principal Consultant - Security',
        allocationMode: 'CAPACITY_PLAN',
        startWeek: 4,
        endWeek: 15,
        allocatedDays: 40,
      }),
    ]))
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
        { featureId: 'feat-1', feature: { id: 'feat-1', name: 'Feature', order: 0, isActive: true, timelineColour: null, epic: { id: 'epic-1', name: 'Epic', order: 0, isActive: true, featureMode: 'sequential', scheduleMode: 'auto', timelineStartWeek: null }, userStories: [] }, startWeek: 0, durationWeeks: 16 },
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
      // ROLE profile carries the 25% plan capacity (profile-first, #418).
      capacityProfiles: [{
        id: 'cp-role-security', projectId: 'proj-1', ownerKind: 'ROLE',
        resourceTypeId: 'rt-security', namedResourceId: null,
        planningBasis: 'CAPACITY_PROFILE', source: 'SQUAD_PLANNER',
        defaultPercent: null, startWeek: null, endWeek: null, legacy: null,
        segments: [
          { id: 'seg-r1', capacityProfileId: 'cp-role-security', startWeek: 0, endWeek: 15, capacityPercent: 25, source: 'SQUAD_PLANNER' },
        ],
      }],
    } as any)

    const res = await request(app)
      .get('/api/projects/proj-1/resource-profile')
      .set('Authorization', authHeader)

    expect(res.status).toBe(200)

    const securityRow = res.body.resourceRows.find((row: any) => row.resourceTypeId === 'rt-security')
    expect(securityRow).toBeTruthy()
    expect(securityRow.allocatedDays).toBe(20)
    expect(securityRow.allocationMode).toBe('CAPACITY_PLAN')
    // No persisted named resources and no plan-fallback trajectories (issue
    // #418): the role-level row carries the capacity; there are no NR rows.
    expect(securityRow.namedResources).toEqual([])
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
        { featureId: 'feat-1', feature: { id: 'feat-1', name: 'Feature', order: 0, isActive: true, timelineColour: null, epic: { id: 'epic-1', name: 'Epic', order: 0, isActive: true, featureMode: 'sequential', scheduleMode: 'auto', timelineStartWeek: null }, userStories: [] }, startWeek: 12, durationWeeks: 1 },
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
        { featureId: 'feat-1', feature: { id: 'feat-1', name: 'Feature', order: 0, isActive: true, timelineColour: null, epic: { id: 'epic-1', name: 'Epic', order: 0, isActive: true, featureMode: 'sequential', scheduleMode: 'auto', timelineStartWeek: null }, userStories: [] }, startWeek: 4.327272727272727, durationWeeks: 8.072727272727272 },
      ],
      storyTimelineEntries: [],
      capacityPlans: [],
    } as any)

    const res = await request(app)
      .get('/api/projects/proj-1/resource-profile')
      .set('Authorization', authHeader)

    expect(res.status).toBe(200)

    const dataRow = res.body.resourceRows.find((row: any) => row.resourceTypeId === 'rt-data')
    // Explicit-only role (the NR's NAMED_PERSON profile is authoritative):
    // the aggregate row presents as EFFORT per the profile-first model.
    expect(dataRow).toMatchObject({
      allocationMode: 'EFFORT',
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
        { featureId: 'feat-1', feature: { id: 'feat-1', name: 'Feature', order: 0, isActive: true, timelineColour: null, epic: { id: 'epic-1', name: 'Epic', order: 0, isActive: true, featureMode: 'sequential', scheduleMode: 'auto', timelineStartWeek: null }, userStories: [] }, startWeek: 0, durationWeeks: 3 },
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
        { featureId: 'feat-1', feature: { id: 'feat-1', name: 'Feature', order: 0, isActive: true, timelineColour: null, epic: { id: 'epic-1', name: 'Epic', order: 0, isActive: true, featureMode: 'sequential', scheduleMode: 'auto', timelineStartWeek: null }, userStories: [{ id: 'story-1', isActive: true, tasks: [{ resourceTypeId: 'rt-dev', hoursEffort: 40, durationDays: 5, resourceType: { name: 'Developer', hoursPerDay: 8 } }, { resourceTypeId: 'rt-qa', hoursEffort: 40, durationDays: 5, resourceType: { name: 'QA', hoursPerDay: 8 } }] }] }, startWeek: 0, durationWeeks: 1 },
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

  it('suppresses all fallback when resource type has any cached data, regardless of horizon', async () => {
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
        { featureId: 'feat-1', feature: { id: 'feat-1', name: 'Feature', order: 0, isActive: true, timelineColour: null, epic: { id: 'epic-1', name: 'Epic', order: 0, isActive: true, featureMode: 'sequential', scheduleMode: 'auto', timelineStartWeek: null }, userStories: [] }, startWeek: 0, durationWeeks: 2 },
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
    // Developer is cached for weeks 0-1, so all Dev fallback suppressed
    expect(devRow.namedResources[0].actualAllocatedWeeks.map((w: any) => w.week)).toEqual([0, 1])

    // QA is only cached for week 0 — all QA fallback suppressed, so QA only appears for week 0
    expect(qaRow.namedResources[0].actualAllocatedWeeks.map((w: any) => w.week)).toEqual([0])
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
        { featureId: 'feat-1', feature: { id: 'feat-1', name: 'Feature', order: 0, isActive: true, timelineColour: null, epic: { id: 'epic-1', name: 'Epic', order: 0, isActive: true, featureMode: 'sequential', scheduleMode: 'auto', timelineStartWeek: null }, userStories: [] }, startWeek: 0, durationWeeks: 1 },
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

  it('does not append phantom synthetics when every named resource resolves a profile', async () => {
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
        { featureId: 'feat-1', feature: { id: 'feat-1', name: 'Feature', order: 0, isActive: true, timelineColour: null, epic: { id: 'epic-1', name: 'Epic', order: 0, isActive: true, featureMode: 'sequential', scheduleMode: 'auto', timelineStartWeek: null }, userStories: [] }, startWeek: 0, durationWeeks: 1 },
      ],
      storyTimelineEntries: [],
      capacityPlans: [],
    } as any)

    const res = await request(app)
      .get('/api/projects/proj-1/resource-profile')
      .set('Authorization', authHeader)

    expect(res.status).toBe(200)

    const devRow = res.body.resourceRows.find((row: any) => row.resourceTypeId === 'rt-dev')
    // Issue #418: the role carries no ROLE profile and its only named
    // resource resolves an explicit NAMED_PERSON profile — an explicit-only
    // role. The profile-derived NR capacity is the complete authority, so
    // count-based phantom synthetics must NOT be appended on top.
    expect(devRow.namedResources).toEqual([
      expect.objectContaining({
        id: 'nr-1',
        actualAllocatedDays: 5,
      }),
    ])
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
        { featureId: 'feat-1', feature: { id: 'feat-1', name: 'Feature', order: 0, isActive: true, timelineColour: null, epic: { id: 'epic-1', name: 'Epic', order: 0, isActive: true, featureMode: 'sequential', scheduleMode: 'auto', timelineStartWeek: null }, userStories: [] }, startWeek: 0, durationWeeks: 4 },
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
        { featureId: 'feat-active', feature: { id: 'feat-active', name: 'Feature', order: 0, isActive: true, timelineColour: null, epic: { id: 'epic-1', name: 'Epic', order: 0, isActive: true, featureMode: 'sequential', scheduleMode: 'auto', timelineStartWeek: null }, userStories: [] }, startWeek: 0, durationWeeks: 2 },
        { featureId: 'feat-inactive', feature: { id: 'feat-inactive', name: 'Feature', order: 0, isActive: true, timelineColour: null, epic: { id: 'epic-1', name: 'Epic', order: 0, isActive: true, featureMode: 'sequential', scheduleMode: 'auto', timelineStartWeek: null }, userStories: [] }, startWeek: 0, durationWeeks: 2 },
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
    expect(devRow.effortDays).toBe(10) // 80h / 8hpd; durationDays is elapsed scheduling data only
    expect(devRow.epics).toHaveLength(1)
    expect(devRow.epics[0].epicId).toBe('epic-active')
  })

  it('derives no demand from a story-only entry without a feature entry (canonical feature granularity)', async () => {
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
        { storyId: 'story-1', story: { name: 'Story', featureId: 'feat-story' }, startWeek: 4, durationWeeks: 2 },
      ],
      capacityPlans: [],
    } as any)

    const res = await request(app)
      .get('/api/projects/proj-1/resource-profile')
      .set('Authorization', authHeader)

    expect(res.status).toBe(200)

    const devRow = res.body.resourceRows.find((row: any) => row.resourceTypeId === 'rt-dev')
    expect(devRow).toBeTruthy()

    // Canonical weekly demand follows the feature timeline entries (issue #387):
    // with no feature entry, Resource Profile (like Timeline) derives no
    // planning demand — a story-only entry does not fabricate demand.
    const nr = devRow.namedResources[0]
    expect(nr.actualAllocatedDays).toBe(0)
    expect(nr.actualAllocationStartWeek).toBeNull()
    expect(nr.actualAllocationEndWeek).toBeNull()
    expect(nr.actualAllocatedWeeks).toEqual([])
  })

  it('ignores story timeline entries for demand without feature entries (canonical feature granularity)', async () => {
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
        { storyId: 'story-1', story: { name: 'Story', featureId: 'feat-story' }, startWeek: 2, durationWeeks: 2 },
        { storyId: 'story-2', story: { name: 'Story', featureId: 'feat-story' }, startWeek: 6, durationWeeks: 2 },
      ],
      capacityPlans: [],
    } as any)

    const res = await request(app)
      .get('/api/projects/proj-1/resource-profile')
      .set('Authorization', authHeader)

    expect(res.status).toBe(200)

    const devRow = res.body.resourceRows.find((row: any) => row.resourceTypeId === 'rt-dev')
    expect(devRow).toBeTruthy()

    // Canonical weekly demand follows the feature timeline entries (issue #387):
    // no feature entry → no planning demand, matching Timeline.
    const nr = devRow.namedResources[0]
    expect(nr.actualAllocatedDays).toBe(0)
    expect(nr.actualAllocationStartWeek).toBeNull()
    expect(nr.actualAllocationEndWeek).toBeNull()
    expect(nr.actualAllocatedWeeks).toEqual([])
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
        { featureId: 'feat-1', feature: { id: 'feat-1', name: 'Feature', order: 0, isActive: true, timelineColour: null, epic: { id: 'epic-1', name: 'Epic', order: 0, isActive: true, featureMode: 'sequential', scheduleMode: 'auto', timelineStartWeek: null }, userStories: [
          { id: 'story-1', isActive: true, tasks: [{ resourceTypeId: 'rt-dev', hoursEffort: 40, durationDays: 5, resourceType: { name: 'Developer', hoursPerDay: 8 } }] },
          { id: 'story-2', isActive: true, tasks: [{ resourceTypeId: 'rt-dev', hoursEffort: 40, durationDays: 5, resourceType: { name: 'Developer', hoursPerDay: 8 } }] },
        ] }, startWeek: 0, durationWeeks: 1 },
      ],
      storyTimelineEntries: [
        { storyId: 'story-1', story: { name: 'Story', featureId: 'feat-story' }, startWeek: 2, durationWeeks: 1 },
      ],
      capacityPlans: [],
    } as any)

    const res = await request(app)
      .get('/api/projects/proj-1/resource-profile')
      .set('Authorization', authHeader)

    expect(res.status).toBe(200)

    const devRow = res.body.resourceRows.find((row: any) => row.resourceTypeId === 'rt-dev')
    expect(devRow).toBeTruthy()

    // Canonical weekly demand follows the feature timeline entry (issue #387):
    // both stories' demand sits on the feature timing (week 0), regardless of
    // the story timeline entry — identical to the Timeline surface.
    const nr = devRow.namedResources[0]
    expect(nr.actualAllocationStartWeek).toBe(0)
    expect(nr.actualAllocationEndWeek).toBe(0)
    expect(nr.actualAllocatedWeeks).toHaveLength(1)
    // 10 demand days at week 0, capped by the single resource's 5-day weekly
    // capacity — the canonical feature-level demand, identical to Timeline.
    expect(nr.actualAllocatedWeeks[0]).toMatchObject({ week: 0, days: 5, capacityDays: 5 })
    expect(nr.actualAllocatedDays).toBe(5)
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
        { featureId: 'feat-active', feature: { id: 'feat-active', name: 'Feature', order: 0, isActive: true, timelineColour: null, epic: { id: 'epic-1', name: 'Epic', order: 0, isActive: true, featureMode: 'sequential', scheduleMode: 'auto', timelineStartWeek: null }, userStories: [{ id: 'story-active', isActive: true, tasks: [{ resourceTypeId: 'rt-dev', hoursEffort: 80, durationDays: 10, resourceType: { name: 'Developer', hoursPerDay: 8 } }] }] }, startWeek: 0, durationWeeks: 2 },
        { featureId: 'feat-inactive', feature: { id: 'feat-inactive', name: 'Feature', order: 0, isActive: true, timelineColour: null, epic: { id: 'epic-1', name: 'Epic', order: 0, isActive: true, featureMode: 'sequential', scheduleMode: 'auto', timelineStartWeek: null }, userStories: [] }, startWeek: 0, durationWeeks: 2 },
      ],
      storyTimelineEntries: [
        { storyId: 'story-inactive', story: { name: 'Story', featureId: 'feat-story' }, startWeek: 0, durationWeeks: 2 },
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


describe('overhead FTE scaling', () => {
  it('computes requiredFTE for percentage-based overhead linked to a resource type', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue({
      id: 'proj-1',
      ownerId: userId,
      name: 'FTE Test',
      startDate: new Date('2026-01-05T00:00:00.000Z'),
      hoursPerDay: 8,
      bufferWeeks: 0,
      onboardingWeeks: 0,
      weeklyDemandCache: null,
      resourceTypes: [{
        id: 'rt-dev',
        name: 'Developer',
        category: 'ENGINEERING',
        count: 3,
        hoursPerDay: 8,
        dayRate: 500,
        allocationMode: 'EFFORT',
        allocationPercent: 100,
        allocationStartWeek: null,
        allocationEndWeek: null,
        globalType: null,
        namedResources: [
          { id: 'nr-1', name: 'Dev 1', startWeek: null, endWeek: null, allocationPct: 100, allocationMode: 'EFFORT', allocationPercent: 100, allocationStartWeek: null, allocationEndWeek: null, pricingModel: 'ACTUAL_DAYS' },
        ],
      }],
      epics: [{
        id: 'epic-1',
        name: 'Platform',
        order: 0,
        isActive: true,
        featureMode: 'sequential',
        scheduleMode: 'auto',
        features: [{
          id: 'feat-1',
          name: 'Delivery',
          order: 0,
          isActive: true,
          featureMode: 'sequential',
          timelineStartWeek: null,
          userStories: [{
            isActive: true,
            tasks: [{
              resourceTypeId: 'rt-dev',
              hoursEffort: 800,
              durationDays: null,
              resourceType: { id: 'rt-dev', name: 'Developer', hoursPerDay: 8 },
            }],
          }],
        }],
      }],
      overheads: [{
        id: 'oh-1',
        name: 'Project Manager',
        resourceTypeId: 'rt-pm',
        type: 'PERCENTAGE',
        value: 22,
        order: 0,
        resourceType: {
          id: 'rt-pm',
          name: 'Project Manager',
          category: 'PROJECT_MANAGEMENT',
          count: 1,
          hoursPerDay: 8,
          dayRate: 600,
          allocationMode: 'EFFORT',
          allocationPercent: 100,
          allocationStartWeek: null,
          allocationEndWeek: null,
          globalType: null,
          namedResources: [],
        },
      }],
      timelineEntries: [{ featureId: 'feat-1', feature: { id: 'feat-1', name: 'Feature', order: 0, isActive: true, timelineColour: null, epic: { id: 'epic-1', name: 'Epic', order: 0, isActive: true, featureMode: 'sequential', scheduleMode: 'auto', timelineStartWeek: null }, userStories: [] }, startWeek: 0, durationWeeks: 10 }],
      storyTimelineEntries: [],
      capacityPlans: [],
    } as never)

    const res = await request(app)
      .get('/api/projects/proj-1/resource-profile')
      .set('Authorization', authHeader)

    expect(res.status).toBe(200)

    const pmRow = res.body.overheadRows.find((r: any) => r.overheadId === 'oh-1')
    expect(pmRow).toBeDefined()
    expect(pmRow.requiredFTE).toBeGreaterThan(0)
    expect(pmRow.currentCount).toBe(1)

    // requiredFTE = computedDays / (projectDurationWeeks * 5)
    // 800h / 8hpd = 100 days effort → 22% = 22 computed days
    // projectDurationWeeks = 10, so FTE = 22 / (10 * 5) = 0.44
    expect(pmRow.computedDays).toBe(22)
    expect(pmRow.requiredFTE).toBe(0.44)
  })

  it('sets requiredFTE to 0 when projectDurationWeeks is 0', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue({
      id: 'proj-1',
      ownerId: userId,
      name: 'Zero Weeks',
      startDate: new Date('2026-01-05T00:00:00.000Z'),
      hoursPerDay: 8,
      bufferWeeks: 0,
      onboardingWeeks: 0,
      weeklyDemandCache: null,
      resourceTypes: [{
        id: 'rt-dev', name: 'Developer', category: 'ENGINEERING', count: 1, hoursPerDay: 8,
        dayRate: 500, allocationMode: 'EFFORT', allocationPercent: 100,
        allocationStartWeek: null, allocationEndWeek: null, globalType: null,
        namedResources: [],
      }],
      epics: [{
        id: 'epic-1', name: 'E1', order: 0, isActive: true, featureMode: 'sequential',
        scheduleMode: 'auto', features: [{
          id: 'feat-1', name: 'F1', order: 0, isActive: true, featureMode: 'sequential',
          timelineStartWeek: null,
          userStories: [{ isActive: true, tasks: [] }],
        }],
      }],
      overheads: [{
        id: 'oh-1', name: 'PM', resourceTypeId: null, type: 'PERCENTAGE', value: 22, order: 0,
        resourceType: null,
      }],
      timelineEntries: [],
      storyTimelineEntries: [],
      capacityPlans: [],
    } as never)

    const res = await request(app)
      .get('/api/projects/proj-1/resource-profile')
      .set('Authorization', authHeader)

    expect(res.status).toBe(200)
    const pmRow = res.body.overheadRows.find((r: any) => r.overheadId === 'oh-1')
    expect(pmRow).toBeDefined()
    expect(pmRow.requiredFTE).toBe(0)
    expect(pmRow.currentCount).toBeNull()
  })

  it('FTE warning is triggered when requiredFTE exceeds currentCount', async () => {
    // Set count=1 for the PM RT but FTE > 1 (e.g. 60% overhead on 200 effort days over 10 weeks)
    vi.mocked(prisma.project.findFirst).mockResolvedValue({
      id: 'proj-1',
      ownerId: userId,
      name: 'FTE Warn',
      startDate: new Date('2026-01-05T00:00:00.000Z'),
      hoursPerDay: 8,
      bufferWeeks: 0,
      onboardingWeeks: 0,
      weeklyDemandCache: null,
      resourceTypes: [{
        id: 'rt-dev', name: 'Developer', category: 'ENGINEERING', count: 5, hoursPerDay: 8,
        dayRate: 500, allocationMode: 'EFFORT', allocationPercent: 100,
        allocationStartWeek: null, allocationEndWeek: null, globalType: null,
        namedResources: [],
      }],
      epics: [{
        id: 'epic-1', name: 'E1', order: 0, isActive: true, featureMode: 'sequential',
        scheduleMode: 'auto', features: [{
          id: 'feat-1', name: 'F1', order: 0, isActive: true, featureMode: 'sequential',
          timelineStartWeek: null,
          userStories: [{ isActive: true, tasks: [{ resourceTypeId: 'rt-dev', hoursEffort: 1600, durationDays: null, resourceType: { id: 'rt-dev', name: 'Developer', hoursPerDay: 8 } }] }],
        }],
      }],
      overheads: [{
        id: 'oh-1', name: 'PM', resourceTypeId: 'rt-pm', type: 'PERCENTAGE', value: 60, order: 0,
        resourceType: { id: 'rt-pm', name: 'Project Manager', category: 'PROJECT_MANAGEMENT', count: 1, hoursPerDay: 8, dayRate: 600, allocationMode: 'EFFORT', allocationPercent: 100, allocationStartWeek: null, allocationEndWeek: null, globalType: null, namedResources: [] },
      }],
      timelineEntries: [{ featureId: 'feat-1', feature: { id: 'feat-1', name: 'Feature', order: 0, isActive: true, timelineColour: null, epic: { id: 'epic-1', name: 'Epic', order: 0, isActive: true, featureMode: 'sequential', scheduleMode: 'auto', timelineStartWeek: null }, userStories: [] }, startWeek: 0, durationWeeks: 10 }],
      storyTimelineEntries: [],
      capacityPlans: [],
    } as never)

    const res = await request(app)
      .get('/api/projects/proj-1/resource-profile')
      .set('Authorization', authHeader)

    expect(res.status).toBe(200)
    const pmRow = res.body.overheadRows.find((r: any) => r.overheadId === 'oh-1')
    expect(pmRow).toBeDefined()

    // 1600h / 8hpd = 200 effort days, 60% = 120 computed days
    // 120 / (10 * 5) = 2.4 FTE
    expect(pmRow.requiredFTE).toBe(2.4)
    expect(pmRow.currentCount).toBe(1)
    expect(pmRow.requiredFTE).toBeGreaterThan(pmRow.currentCount)
  })
})

describe('capacity profile enrichment in resource profile', () => {
  const mockAdapterMap = vi.mocked(capacityProfileAdapter.buildResourceCapacityProfileMap)

  afterEach(() => {
    mockAdapterMap.mockImplementation(() => ({ roleProfiles: new Map(), namedResourceProfiles: new Map() }))
  })

  const BASE_PROJECT = {
    id: 'proj-1', ownerId: userId, name: 'Test',
    startDate: new Date('2026-01-05T00:00:00.000Z'),
    hoursPerDay: 8, bufferWeeks: 0, onboardingWeeks: 0,
    weeklyDemandCache: null,
    capacityPlans: [],
  }

  const BASE_EPIC = (rtId: string) => [{
    id: 'epic-1', name: 'E1', order: 0, isActive: true,
    featureMode: 'sequential', scheduleMode: 'auto',
    features: [{
      id: 'feat-1', name: 'F1', order: 0, isActive: true,
      featureMode: 'sequential', timelineStartWeek: null,
      userStories: [{
        isActive: true,
        tasks: [{ resourceTypeId: rtId, hoursEffort: 160, durationDays: null, resourceType: { id: rtId, name: 'Dev', hoursPerDay: 8 } }],
      }],
    }],
  }]

  it('returns capacityProfile on named-resource row when adapter provides enrichment', async () => {
    const rtId = 'rt-cap-test'
    const nrId = 'nr-cap-1'
    mockAdapterMap.mockReturnValue({
      roleProfiles: new Map(),
      namedResourceProfiles: new Map([
        [nrId, {
          planningBasis: 'availabilityWindow',
          source: 'availabilityWindow',
          defaultPercent: 100,
          startWeek: 0,
          endWeek: 4,
          segments: [{ startWeek: 0, endWeek: 4, capacityPercent: 100 }],
          resolutionSource: 'PROFILE',
        }],
      ]),
    })


    vi.mocked(prisma.project.findFirst).mockResolvedValue({
      ...BASE_PROJECT,
      resourceTypes: [{
        id: rtId, name: 'Dev', category: 'ENGINEERING',
        count: 1, hoursPerDay: 8, dayRate: 500,
        allocationMode: 'TIMELINE', allocationPercent: 100,
        allocationStartWeek: 0, allocationEndWeek: 8,
        globalType: null,
        namedResources: [{
          id: nrId, name: 'Cap Test', startWeek: null, endWeek: null,
          allocationPct: 100, allocationMode: 'TIMELINE', allocationPercent: 100,
          allocationStartWeek: 0, allocationEndWeek: 8,
          pricingModel: 'ACTUAL_DAYS',
        }],
      }],
      epics: BASE_EPIC(rtId),
      overheads: [],
      timelineEntries: [{ featureId: 'feat-1', feature: { id: 'feat-1', name: 'Feature', order: 0, isActive: true, timelineColour: null, epic: { id: 'epic-1', name: 'Epic', order: 0, isActive: true, featureMode: 'sequential', scheduleMode: 'auto', timelineStartWeek: null }, userStories: [] }, startWeek: 0, durationWeeks: 4 }],
      storyTimelineEntries: [],
    } as never)

    const res = await request(app)
      .get('/api/projects/proj-1/resource-profile')
      .set('Authorization', authHeader)

    expect(res.status).toBe(200)
    const row = res.body.resourceRows.find((r: any) => r.resourceTypeId === rtId)
    expect(row).toBeDefined()
    expect(row.namedResources).toHaveLength(1)

    const nr = row.namedResources[0]
    expect(nr.id).toBe(nrId)
    expect(nr.capacityProfile).toBeDefined()
    expect(nr.capacityProfile.planningBasis).toBe('availabilityWindow')
    expect(nr.capacityProfile.source).toBe('availabilityWindow')
    expect(nr.capacityProfile.segments).toHaveLength(1)
    expect(nr.capacityProfile.segments[0]).toMatchObject({ startWeek: 0, endWeek: 4, capacityPercent: 100 })

    // Legacy fields remain intact
    expect(nr.allocationMode).toBe('TIMELINE')
    expect(nr.allocationPercent).toBe(100)
    expect(nr.pricingModel).toBe('ACTUAL_DAYS')
  })

  it('includes capacityProfile on role-level row', async () => {
    const rtId = 'rt-role-cap'
    const nrId = 'nr-role-1'
    mockAdapterMap.mockReturnValue({
      roleProfiles: new Map([
        [rtId, {
          planningBasis: 'availabilityWindow',
          source: 'legacy',
          defaultPercent: 75,
          startWeek: 0,
          endWeek: 8,
          segments: [{ startWeek: 0, endWeek: 8, capacityPercent: 75 }],
          resolutionSource: 'PROFILE',
        }],
      ]),
      namedResourceProfiles: new Map([
        [nrId, {
          planningBasis: 'availabilityWindow',
          source: 'availabilityWindow',
          defaultPercent: 75,
          startWeek: 0,
          endWeek: 8,
          segments: [{ startWeek: 0, endWeek: 8, capacityPercent: 75 }],
          resolutionSource: 'PROFILE',
        }],
      ]),
    })

    vi.mocked(prisma.project.findFirst).mockResolvedValue({
      ...BASE_PROJECT,
      resourceTypes: [{
        id: rtId, name: 'Role Cap', category: 'ENGINEERING',
        count: 1, hoursPerDay: 8, dayRate: 500,
        allocationMode: 'TIMELINE', allocationPercent: 75,
        allocationStartWeek: 0, allocationEndWeek: 8,
        globalType: null,
        namedResources: [{
          id: nrId, name: 'Role NR', startWeek: null, endWeek: null,
          allocationPct: 75, allocationMode: 'TIMELINE', allocationPercent: 75,
          allocationStartWeek: 0, allocationEndWeek: 8,
          pricingModel: 'ACTUAL_DAYS',
        }],
      }],
      epics: BASE_EPIC(rtId),
      overheads: [],
      timelineEntries: [{ featureId: 'feat-1', feature: { id: 'feat-1', name: 'Feature', order: 0, isActive: true, timelineColour: null, epic: { id: 'epic-1', name: 'Epic', order: 0, isActive: true, featureMode: 'sequential', scheduleMode: 'auto', timelineStartWeek: null }, userStories: [] }, startWeek: 0, durationWeeks: 8 }],
      storyTimelineEntries: [],
    } as never)

    const res = await request(app)
      .get('/api/projects/proj-1/resource-profile')
      .set('Authorization', authHeader)

    expect(res.status).toBe(200)
    const row = res.body.resourceRows.find((r: any) => r.resourceTypeId === rtId)
    expect(row).toBeDefined()
    expect(row.capacityProfile).toBeDefined()
    expect(row.capacityProfile.planningBasis).toBe('availabilityWindow')
    expect(row.capacityProfile.segments).toHaveLength(1)
    expect(row.namedResources[0].capacityProfile).toBeDefined()
    expect(row.namedResources[0].capacityProfile.planningBasis).toBe('availabilityWindow')
  })

  it('multi-segment named person remains one entity in resource profile', async () => {
    const rtId = 'rt-multi'
    const nrId = 'nr-multi-1'
    mockAdapterMap.mockReturnValue({
      roleProfiles: new Map(),
      namedResourceProfiles: new Map([
        [nrId, {
          planningBasis: 'capacityProfile',
          source: 'squadPlanner',
          defaultPercent: 100,
          startWeek: 0,
          endWeek: 8,
          segments: [
            { startWeek: 0, endWeek: 4, capacityPercent: 50 },
            { startWeek: 4, endWeek: 8, capacityPercent: 100 },
          ],
          resolutionSource: 'PROFILE',
        }],
      ]),
    })


    vi.mocked(prisma.project.findFirst).mockResolvedValue({
      ...BASE_PROJECT,
      resourceTypes: [{
        id: rtId, name: 'Multi', category: 'ENGINEERING',
        count: 1, hoursPerDay: 8, dayRate: 500,
        allocationMode: 'EFFORT', allocationPercent: 100,
        allocationStartWeek: null, allocationEndWeek: null,
        globalType: null,
        namedResources: [{
          id: nrId, name: 'Multi Person', startWeek: null, endWeek: null,
          allocationPct: 100, allocationMode: 'EFFORT', allocationPercent: 100,
          allocationStartWeek: null, allocationEndWeek: null,
          pricingModel: 'PRO_RATA',
        }],
      }],
      epics: BASE_EPIC(rtId),
      overheads: [],
      timelineEntries: [{ featureId: 'feat-1', feature: { id: 'feat-1', name: 'Feature', order: 0, isActive: true, timelineColour: null, epic: { id: 'epic-1', name: 'Epic', order: 0, isActive: true, featureMode: 'sequential', scheduleMode: 'auto', timelineStartWeek: null }, userStories: [] }, startWeek: 0, durationWeeks: 8 }],
      storyTimelineEntries: [],
    } as never)

    const res = await request(app)
      .get('/api/projects/proj-1/resource-profile')
      .set('Authorization', authHeader)

    expect(res.status).toBe(200)
    const row = res.body.resourceRows.find((r: any) => r.resourceTypeId === rtId)
    expect(row).toBeDefined()

    // One named resource (not duplicated per segment)
    expect(row.namedResources).toHaveLength(1)

    const nr = row.namedResources[0]
    expect(nr.id).toBe(nrId)
    expect(nr.capacityProfile).toBeDefined()
    // Display fields projected from profile
    expect(nr.allocationMode).toBe('CAPACITY_PLAN')
    expect(nr.allocationPercent).toBe(75)
    // Billing basis is independent metadata
    expect(nr.pricingModel).toBe('PRO_RATA')
  })

  it('fails closed when no persisted profile exists for a named resource (issue #418)', async () => {
    const rtId = 'rt-no-cap'
    const nrId = 'nr-no-cap'

    vi.mocked(prisma.project.findFirst).mockResolvedValue({
      ...BASE_PROJECT,
      resourceTypes: [{
        id: rtId, name: 'NoCap', category: 'ENGINEERING',
        count: 1, hoursPerDay: 8, dayRate: 500,
        allocationMode: 'EFFORT', allocationPercent: 100,
        allocationStartWeek: null, allocationEndWeek: null,
        globalType: null,
        namedResources: [{
          id: nrId, name: 'NoCap NR', startWeek: null, endWeek: null,
          allocationPct: 100, allocationMode: 'EFFORT', allocationPercent: 100,
          allocationStartWeek: null, allocationEndWeek: null,
          pricingModel: 'ACTUAL_DAYS',
        }],
      }],
      epics: BASE_EPIC(rtId),
      overheads: [],
      timelineEntries: [{ featureId: 'feat-1', feature: { id: 'feat-1', name: 'Feature', order: 0, isActive: true, timelineColour: null, epic: { id: 'epic-1', name: 'Epic', order: 0, isActive: true, featureMode: 'sequential', scheduleMode: 'auto', timelineStartWeek: null }, userStories: [] }, startWeek: 0, durationWeeks: 4 }],
      storyTimelineEntries: [],
    } as never)

    // The adapter is mocked to return empty maps (afterEach default): the
    // profile-first resolver fails closed instead of falling back to legacy.
    const res = await request(app)
      .get('/api/projects/proj-1/resource-profile')
      .set('Authorization', authHeader)

    expect(res.status).toBe(409)
    expect(res.body.code).toBe('CAPACITY_INTEGRITY_ERROR')
  })

  it('capacity profile, assigned work, and billing basis remain separate', async () => {
    const rtId = 'rt-sep'
    const nrId = 'nr-sep-1'
    mockAdapterMap.mockReturnValue({
      roleProfiles: new Map(),
      namedResourceProfiles: new Map([
        [nrId, {
          planningBasis: 'capacityProfile',
          source: 'availabilityWindow',
          defaultPercent: 75,
          startWeek: 0,
          endWeek: 8,
          segments: [{ startWeek: 0, endWeek: 8, capacityPercent: 75 }],
          resolutionSource: 'PROFILE',
        }],
      ]),
    })

    vi.mocked(prisma.project.findFirst).mockResolvedValue({
      ...BASE_PROJECT,
      resourceTypes: [{
        id: rtId, name: 'Sep', category: 'ENGINEERING',
        count: 1, hoursPerDay: 8, dayRate: 500,
        allocationMode: 'TIMELINE', allocationPercent: 75,
        allocationStartWeek: 0, allocationEndWeek: 8,
        globalType: null,
        namedResources: [{
          id: nrId, name: 'Sep NR', startWeek: null, endWeek: null,
          allocationPct: 75, allocationMode: 'TIMELINE', allocationPercent: 75,
          allocationStartWeek: 0, allocationEndWeek: 8,
          pricingModel: 'ACTUAL_DAYS',
        }],
      }],
      epics: BASE_EPIC(rtId),
      overheads: [],
      timelineEntries: [{ featureId: 'feat-1', feature: { id: 'feat-1', name: 'Feature', order: 0, isActive: true, timelineColour: null, epic: { id: 'epic-1', name: 'Epic', order: 0, isActive: true, featureMode: 'sequential', scheduleMode: 'auto', timelineStartWeek: null }, userStories: [] }, startWeek: 0, durationWeeks: 8 }],
      storyTimelineEntries: [],
    } as never)

    const res = await request(app)
      .get('/api/projects/proj-1/resource-profile')
      .set('Authorization', authHeader)

    expect(res.status).toBe(200)
    const row = res.body.resourceRows.find((r: any) => r.resourceTypeId === rtId)
    expect(row).toBeDefined()
    const nr = row.namedResources[0]
    expect(nr.capacityProfile).toBeDefined()
    expect(nr.capacityProfile.planningBasis).toBe('capacityProfile')
    expect(nr.allocatedDays).toBeDefined()
    expect(nr.derivedStartWeek).toBeDefined()
    expect(nr.derivedEndWeek).toBeDefined()
    expect(nr.pricingModel).toBe('ACTUAL_DAYS')
  })
})

// ─── Integration Tests: Profile-First Read Adoption ──────────────────────────
// These tests exercise the real buildResourceCapacityProfileMap with data seeded
// through the Prisma mock.  They do NOT mock the adapter — it calls through to
// the real implementation stored in testCtx.realBuildFn.

describe('profile-first read adoption integration', () => {
  /** Restore adapter to empty-map default so existing tests are unaffected. */
  afterEach(() => {
    vi.mocked(capacityProfileAdapter.buildResourceCapacityProfileMap)
      .mockImplementation(() => ({ roleProfiles: new Map(), namedResourceProfiles: new Map() }))
  })

  /** Configure the adapter mock to call through to the real implementation. */
  function useRealAdapter(): void {
    const realFn = testCtx.realBuildFn
    if (!realFn) throw new Error('buildResourceCapacityProfileMap original unavailable')
    // Store the real implementation as the mock's implementation
    vi.mocked(capacityProfileAdapter.buildResourceCapacityProfileMap)
      .mockImplementation(realFn as (typeof capacityProfileAdapter.buildResourceCapacityProfileMap))
  }

  const EXPECTED_EFFORT_DAYS = 20 // 160 h ÷ 8 hpd

  // ─── 1. Profile-first role display drift ─────────────────────────────────
  describe('1. profile-first role display drift', () => {
    it('projects role-level display fields from persisted profile', async () => {
      const rtId = 'rt-drift-1'
      const epicId = 'epic-drift-1'
      const featId = 'feat-drift-1'
      const storyId = 'story-drift-1'

      vi.mocked(prisma.project.findFirst).mockResolvedValue({
        id: 'proj-drift', ownerId: userId, name: 'Drift Test',
        startDate: new Date('2026-01-05'), hoursPerDay: 8,
        bufferWeeks: 0, onboardingWeeks: 0, weeklyDemandCache: null,
        resourceTypes: [{
          id: rtId, name: 'Drift Dev', category: 'ENGINEERING',
          count: 1, hoursPerDay: 8, dayRate: 500,
          allocationMode: 'TIMELINE', allocationPercent: 100,
          allocationStartWeek: 0, allocationEndWeek: 8,
          globalType: null,
          namedResources: [],
        }],
        epics: [{
          id: epicId, name: 'E1', order: 0, isActive: true,
          featureMode: 'sequential', scheduleMode: 'auto',
          features: [{
            id: featId, name: 'F1', order: 0, isActive: true,
            featureMode: 'sequential', timelineStartWeek: null,
            userStories: [{
              id: storyId, name: 'US1', order: 0, isActive: true,
              tasks: [{
                resourceTypeId: rtId, hoursEffort: 160,
                durationDays: null,
                resourceType: { id: rtId, name: 'Drift Dev', hoursPerDay: 8 },
              }],
            }],
          }],
        }],
        overheads: [],
        timelineEntries: [{ featureId: featId, feature: { id: featId, name: 'Feature', order: 0, isActive: true, timelineColour: null, epic: { id: 'epic-1', name: 'Epic', order: 0, isActive: true, featureMode: 'sequential', scheduleMode: 'auto', timelineStartWeek: null }, userStories: [] }, startWeek: 0, durationWeeks: 4 }],
        storyTimelineEntries: [],
        capacityPlans: [],
        capacityProfiles: [{
          id: 'cp-drift-1',
          projectId: 'proj-drift',
          ownerKind: 'ROLE',
          resourceTypeId: rtId,
          namedResourceId: null,
          planningBasis: 'DEMAND_FOLLOWING',
          source: 'FIXED',
          defaultPercent: 70,
          startWeek: null,
          endWeek: null,
          segments: [],
        }],
      } as never)

      useRealAdapter()

      const res = await request(app)
        .get('/api/projects/proj-drift/resource-profile')
        .set('Authorization', authHeader)

      expect(res.status).toBe(200)
      const row = res.body.resourceRows.find((r: { resourceTypeId: string }) => r.resourceTypeId === rtId)
      expect(row).toBeDefined()

      // Profile-first display fields: demandFollowing → EFFORT, 70%
      expect(row.allocationMode).toBe('EFFORT')
      expect(row.allocationPercent).toBe(70)
      // Profile projection returns null for window, route now respects profile null as authoritative
      expect(row.allocationStartWeek).toBeNull()
      expect(row.allocationEndWeek).toBeNull()

      // Capacity profile enrichment
      expect(row.capacityProfile).toBeDefined()
      expect(row.capacityProfile.planningBasis).toBe('demandFollowing')
      expect(row.capacityProfile.source).toBe('fixed')
      expect(row.capacityProfile.defaultPercent).toBe(70)
      expect(row.capacityProfile.resolutionSource).toBe('PROFILE')

      // Commercial fields follow the profile-first allocation mode:
      // demandFollowing → EFFORT → allocatedDays = effortDays (160h / 8hpd)
      expect(row.effortDays).toBe(EXPECTED_EFFORT_DAYS)
      expect(row.totalDays).toBe(EXPECTED_EFFORT_DAYS)
      expect(row.estimatedCost).toBe(10000) // 20 * 500
    })
  })

  // ─── 2. Profile-first named person drift ─────────────────────────────────
  describe('2. profile-first named person drift', () => {
    it('projects named-resource display fields from persisted profile', async () => {
      const rtId = 'rt-nr-drift'
      const nrId = 'nr-nr-drift'
      const epicId = 'epic-nr-drift'
      const featId = 'feat-nr-drift'
      const storyId = 'story-nr-drift'

      vi.mocked(prisma.project.findFirst).mockResolvedValue({
        id: 'proj-nr-drift', ownerId: userId, name: 'NR Drift',
        startDate: new Date('2026-01-05'), hoursPerDay: 8,
        bufferWeeks: 0, onboardingWeeks: 0, weeklyDemandCache: null,
        resourceTypes: [{
          id: rtId, name: 'NR Drift RT', category: 'ENGINEERING',
          count: 1, hoursPerDay: 8, dayRate: 600,
          allocationMode: 'TIMELINE', allocationPercent: 100,
          allocationStartWeek: 0, allocationEndWeek: 8,
          globalType: null,
          namedResources: [{
            id: nrId, name: 'Drift Person', startWeek: null, endWeek: null,
            allocationPct: 100, allocationMode: 'EFFORT', allocationPercent: 100,
            allocationStartWeek: null, allocationEndWeek: null,
            pricingModel: 'PRO_RATA',
          }],
        }],
        epics: [{
          id: epicId, name: 'E1', order: 0, isActive: true,
          featureMode: 'sequential', scheduleMode: 'auto',
          features: [{
            id: featId, name: 'F1', order: 0, isActive: true,
            featureMode: 'sequential', timelineStartWeek: null,
            userStories: [{
              id: storyId, name: 'US1', order: 0, isActive: true,
              tasks: [{
                resourceTypeId: rtId, hoursEffort: 160,
                durationDays: null,
                resourceType: { id: rtId, name: 'NR Drift RT', hoursPerDay: 8 },
              }],
            }],
          }],
        }],
        overheads: [],
        timelineEntries: [{ featureId: featId, feature: { id: featId, name: 'Feature', order: 0, isActive: true, timelineColour: null, epic: { id: 'epic-1', name: 'Epic', order: 0, isActive: true, featureMode: 'sequential', scheduleMode: 'auto', timelineStartWeek: null }, userStories: [] }, startWeek: 0, durationWeeks: 4 }],
        storyTimelineEntries: [],
        capacityPlans: [],
        capacityProfiles: [{
          id: 'cp-nr-drift-1',
          projectId: 'proj-nr-drift',
          ownerKind: 'NAMED_PERSON',
          resourceTypeId: null,
          namedResourceId: nrId,
          planningBasis: 'AVAILABILITY_WINDOW',
          source: 'MANUAL',
          defaultPercent: 60,
          startWeek: 2,
          endWeek: 7,
          segments: [],
        }],
      } as never)

      useRealAdapter()

      const res = await request(app)
        .get('/api/projects/proj-nr-drift/resource-profile')
        .set('Authorization', authHeader)

      expect(res.status).toBe(200)
      const row = res.body.resourceRows.find((r: { resourceTypeId: string }) => r.resourceTypeId === rtId)
      expect(row).toBeDefined()
      expect(row.namedResources).toHaveLength(1)

      const nr = row.namedResources[0]
      expect(nr.id).toBe(nrId)

      // Profile-first display: availabilityWindow → TIMELINE, 60%, W3-W8
      expect(nr.allocationMode).toBe('TIMELINE')
      expect(nr.allocationPercent).toBe(60)
      expect(nr.allocationStartWeek).toBe(2)
      expect(nr.allocationEndWeek).toBe(7)

      // capacityProfile enrichment
      expect(nr.capacityProfile).toBeDefined()
      expect(nr.capacityProfile.planningBasis).toBe('availabilityWindow')
      expect(nr.capacityProfile.source).toBe('manual')
      expect(nr.capacityProfile.resolutionSource).toBe('PROFILE')

      // Profile-first: allocatedDays comes from the availability window
      // (weeks 2-7 at 60%) — (7-2) × 5 × 0.6 = 15
      expect(nr.allocatedDays).toBe(15)
    })
  })

  // ─── 3. Multi-segment single person ──────────────────────────────────────
  describe('3. multi-segment single person', () => {
    it('returns one named-resource row with three capacity segments', async () => {
      const rtId = 'rt-multi'
      const nrId = 'nr-multi'
      const epicId = 'epic-multi'
      const featId = 'feat-multi'
      const storyId = 'story-multi'

      const cpId = 'cp-multi-1'
      // Contiguous non-overlapping ranges (inclusive-overlap rule: a segment
      // starting at a prior segment's endWeek would share that week).
      const segments = [
        { id: 'cs-multi-1', capacityProfileId: cpId, startWeek: 0, endWeek: 3, capacityPercent: 50, source: 'MANUAL' },
        { id: 'cs-multi-2', capacityProfileId: cpId, startWeek: 4, endWeek: 7, capacityPercent: 100, source: 'MANUAL' },
        { id: 'cs-multi-3', capacityProfileId: cpId, startWeek: 8, endWeek: 11, capacityPercent: 75, source: 'MANUAL' },
      ]

      vi.mocked(prisma.project.findFirst).mockResolvedValue({
        id: 'proj-multi', ownerId: userId, name: 'Multi Seg',
        startDate: new Date('2026-01-05'), hoursPerDay: 8,
        bufferWeeks: 0, onboardingWeeks: 0, weeklyDemandCache: null,
        resourceTypes: [{
          id: rtId, name: 'Multi RT', category: 'ENGINEERING',
          count: 1, hoursPerDay: 8, dayRate: 500,
          allocationMode: 'EFFORT', allocationPercent: 100,
          allocationStartWeek: null, allocationEndWeek: null,
          globalType: null,
          namedResources: [{
            id: nrId, name: 'Multi Person', startWeek: null, endWeek: null,
            allocationPct: 100, allocationMode: 'EFFORT', allocationPercent: 100,
            allocationStartWeek: null, allocationEndWeek: null,
            pricingModel: 'PRO_RATA',
          }],
        }],
        epics: [{
          id: epicId, name: 'E1', order: 0, isActive: true,
          featureMode: 'sequential', scheduleMode: 'auto',
          features: [{
            id: featId, name: 'F1', order: 0, isActive: true,
            featureMode: 'sequential', timelineStartWeek: null,
            userStories: [{
              id: storyId, name: 'US1', order: 0, isActive: true,
              tasks: [{
                resourceTypeId: rtId, hoursEffort: 160,
                durationDays: null,
                resourceType: { id: rtId, name: 'Multi RT', hoursPerDay: 8 },
              }],
            }],
          }],
        }],
        overheads: [],
        timelineEntries: [{ featureId: featId, feature: { id: featId, name: 'Feature', order: 0, isActive: true, timelineColour: null, epic: { id: 'epic-1', name: 'Epic', order: 0, isActive: true, featureMode: 'sequential', scheduleMode: 'auto', timelineStartWeek: null }, userStories: [] }, startWeek: 0, durationWeeks: 12 }],
        storyTimelineEntries: [],
        capacityPlans: [],
        capacityProfiles: [{
          id: cpId,
          projectId: 'proj-multi',
          ownerKind: 'NAMED_PERSON',
          resourceTypeId: null,
          namedResourceId: nrId,
          planningBasis: 'CAPACITY_PROFILE',
          source: 'SQUAD_PLANNER',
          defaultPercent: null,
          startWeek: null,
          endWeek: null,
          segments,
        }],
      } as never)

      useRealAdapter()

      const res = await request(app)
        .get('/api/projects/proj-multi/resource-profile')
        .set('Authorization', authHeader)

      expect(res.status).toBe(200)
      const row = res.body.resourceRows.find((r: { resourceTypeId: string }) => r.resourceTypeId === rtId)
      expect(row).toBeDefined()

      // One named-resource row (not 3 — segments don't create duplicate NRs)
      expect(row.namedResources).toHaveLength(1)

      const nr = row.namedResources[0]
      expect(nr.id).toBe(nrId)
      expect(nr.capacityProfile).toBeDefined()
      expect(nr.capacityProfile.segments).toHaveLength(3)
      expect(nr.capacityProfile.segments[0]).toMatchObject({ startWeek: 0, endWeek: 3, capacityPercent: 50 })
      expect(nr.capacityProfile.segments[1]).toMatchObject({ startWeek: 4, endWeek: 7, capacityPercent: 100 })
      expect(nr.capacityProfile.segments[2]).toMatchObject({ startWeek: 8, endWeek: 11, capacityPercent: 75 })
    })
  })

  // ─── 4. Planned resource profile ─────────────────────────────────────────
  describe('4. planned resource profile', () => {
    it('includes capacity profile for planned (synthetic) resource', async () => {
      const rtId = 'rt-planned'
      const nrId = 'nr-planned'
      const epicId = 'epic-planned'
      const featId = 'feat-planned'
      const storyId = 'story-planned'

      vi.mocked(prisma.project.findFirst).mockResolvedValue({
        id: 'proj-planned', ownerId: userId, name: 'Planned',
        startDate: new Date('2026-01-05'), hoursPerDay: 8,
        bufferWeeks: 0, onboardingWeeks: 0, weeklyDemandCache: null,
        resourceTypes: [{
          id: rtId, name: 'Planned RT', category: 'ENGINEERING',
          count: 1, hoursPerDay: 8, dayRate: 500,
          allocationMode: 'EFFORT', allocationPercent: 100,
          allocationStartWeek: null, allocationEndWeek: null,
          globalType: null,
          namedResources: [{
            id: nrId, name: 'Planned Person', startWeek: null, endWeek: null,
            allocationPct: 100, allocationMode: 'EFFORT', allocationPercent: 100,
            allocationStartWeek: null, allocationEndWeek: null,
            pricingModel: 'ACTUAL_DAYS',
          }],
        }],
        epics: [{
          id: epicId, name: 'E1', order: 0, isActive: true,
          featureMode: 'sequential', scheduleMode: 'auto',
          features: [{
            id: featId, name: 'F1', order: 0, isActive: true,
            featureMode: 'sequential', timelineStartWeek: null,
            userStories: [{
              id: storyId, name: 'US1', order: 0, isActive: true,
              tasks: [{
                resourceTypeId: rtId, hoursEffort: 160,
                durationDays: null,
                resourceType: { id: rtId, name: 'Planned RT', hoursPerDay: 8 },
              }],
            }],
          }],
        }],
        overheads: [],
        timelineEntries: [{ featureId: featId, feature: { id: featId, name: 'Feature', order: 0, isActive: true, timelineColour: null, epic: { id: 'epic-1', name: 'Epic', order: 0, isActive: true, featureMode: 'sequential', scheduleMode: 'auto', timelineStartWeek: null }, userStories: [] }, startWeek: 0, durationWeeks: 4 }],
        storyTimelineEntries: [],
        capacityPlans: [],
        capacityProfiles: [
          {
            id: 'cp-role-planned',
            projectId: 'proj-planned',
            ownerKind: 'ROLE',
            resourceTypeId: rtId,
            namedResourceId: null,
            planningBasis: 'DEMAND_FOLLOWING',
            source: 'FIXED',
            defaultPercent: 100,
            startWeek: null,
            endWeek: null,
            segments: [],
          },
          {
            id: 'cp-planned-1',
            projectId: 'proj-planned',
            ownerKind: 'PLANNED_RESOURCE',
            resourceTypeId: null,
            namedResourceId: nrId,
            planningBasis: 'CAPACITY_PROFILE',
            source: 'SQUAD_PLANNER',
            defaultPercent: null,
            startWeek: null,
            endWeek: null,
            segments: [
              { id: 'cs-planned-1', capacityProfileId: 'cp-planned-1', startWeek: 0, endWeek: 3, capacityPercent: 50, source: 'SQUAD_PLANNER' },
              { id: 'cs-planned-2', capacityProfileId: 'cp-planned-1', startWeek: 4, endWeek: 7, capacityPercent: 100, source: 'SQUAD_PLANNER' },
            ],
          },
        ],
      } as never)

      useRealAdapter()

      const res = await request(app)
        .get('/api/projects/proj-planned/resource-profile')
        .set('Authorization', authHeader)

      expect(res.status).toBe(200)
      const row = res.body.resourceRows.find((r: { resourceTypeId: string }) => r.resourceTypeId === rtId)
      expect(row).toBeDefined()
      // The persisted planned resource plus the synthetic role aggregate
      expect(row.namedResources).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: nrId }),
      ]))

      const nr = row.namedResources.find((n: { id: string }) => n.id === nrId)
      expect(nr).toBeDefined()
      expect(nr.capacityProfile).toBeDefined()
      expect(nr.capacityProfile.planningBasis).toBe('capacityProfile')
      expect(nr.capacityProfile.source).toBe('squadPlanner')
      expect(nr.capacityProfile.resolutionSource).toBe('PROFILE')
      expect(nr.capacityProfile.segments).toHaveLength(2)
    })
  })

  // ─── 5. Role vs NR override coexistence ───────────────────────────────────
  describe('5. role vs NR override coexistence', () => {
    it('applies separate profiles to role and named-resource rows without collision', async () => {
      const rt1Id = 'rt-role-only'
      const nrRtId = 'rt-with-nr'
      const nrId = 'nr-5'
      const epicId = 'epic-5'
      const featId = 'feat-5'
      const storyId = 'story-5'

      vi.mocked(prisma.project.findFirst).mockResolvedValue({
        id: 'proj-5', ownerId: userId, name: 'Coexist',
        startDate: new Date('2026-01-05'), hoursPerDay: 8,
        bufferWeeks: 0, onboardingWeeks: 0, weeklyDemandCache: null,
        resourceTypes: [
          {
            id: rt1Id, name: 'Role Only RT', category: 'ENGINEERING',
            count: 1, hoursPerDay: 8, dayRate: 500,
            allocationMode: 'TIMELINE', allocationPercent: 100,
            allocationStartWeek: 0, allocationEndWeek: 8,
            globalType: null,
            namedResources: [],
          },
          {
            id: nrRtId, name: 'With NR RT', category: 'ENGINEERING',
            count: 1, hoursPerDay: 8, dayRate: 600,
            allocationMode: 'EFFORT', allocationPercent: 100,
            allocationStartWeek: null, allocationEndWeek: null,
            globalType: null,
            namedResources: [{
              id: nrId, name: 'Coexist Person', startWeek: null, endWeek: null,
              allocationPct: 100, allocationMode: 'EFFORT', allocationPercent: 100,
              allocationStartWeek: null, allocationEndWeek: null,
              pricingModel: 'PRO_RATA',
            }],
          },
        ],
        epics: [{
          id: epicId, name: 'E1', order: 0, isActive: true,
          featureMode: 'sequential', scheduleMode: 'auto',
          features: [{
            id: featId, name: 'F1', order: 0, isActive: true,
            featureMode: 'sequential', timelineStartWeek: null,
            userStories: [{
              id: storyId, name: 'US1', order: 0, isActive: true,
              tasks: [
                { resourceTypeId: rt1Id, hoursEffort: 80, durationDays: null, resourceType: { id: rt1Id, name: 'Role Only RT', hoursPerDay: 8 } },
                { resourceTypeId: nrRtId, hoursEffort: 160, durationDays: null, resourceType: { id: nrRtId, name: 'With NR RT', hoursPerDay: 8 } },
              ],
            }],
          }],
        }],
        overheads: [],
        timelineEntries: [{ featureId: featId, feature: { id: featId, name: 'Feature', order: 0, isActive: true, timelineColour: null, epic: { id: 'epic-1', name: 'Epic', order: 0, isActive: true, featureMode: 'sequential', scheduleMode: 'auto', timelineStartWeek: null }, userStories: [] }, startWeek: 0, durationWeeks: 8 }],
        storyTimelineEntries: [],
        capacityPlans: [],
        capacityProfiles: [
          {
            id: 'cp-role-5',
            projectId: 'proj-5',
            ownerKind: 'ROLE',
            resourceTypeId: rt1Id,
            namedResourceId: null,
            planningBasis: 'DEMAND_FOLLOWING',
            source: 'FIXED',
            defaultPercent: 70,
            startWeek: null,
            endWeek: null,
            segments: [],
          },
          {
            id: 'cp-nr-5',
            projectId: 'proj-5',
            ownerKind: 'NAMED_PERSON',
            resourceTypeId: null,
            namedResourceId: nrId,
            planningBasis: 'AVAILABILITY_WINDOW',
            source: 'MANUAL',
            defaultPercent: 60,
            startWeek: 2,
            endWeek: 7,
            segments: [],
          },
        ],
      } as never)

      useRealAdapter()

      const res = await request(app)
        .get('/api/projects/proj-5/resource-profile')
        .set('Authorization', authHeader)

      expect(res.status).toBe(200)
      expect(res.body.resourceRows).toHaveLength(2)

      // RT without NRs: role-level row uses its ROLE profile
      const roleRow = res.body.resourceRows.find((r: { resourceTypeId: string }) => r.resourceTypeId === rt1Id)
      expect(roleRow).toBeDefined()
      expect(roleRow.capacityProfile).toBeDefined()
      expect(roleRow.capacityProfile.planningBasis).toBe('demandFollowing')
      expect(roleRow.capacityProfile.source).toBe('fixed')
      expect(roleRow.capacityProfile.resolutionSource).toBe('PROFILE')
      expect(roleRow.allocationMode).toBe('EFFORT')    // demandFollowing → EFFORT
      expect(roleRow.allocationPercent).toBe(70)        // from defaultPercent

      // RT with NR: the NR uses its own profile
      const nrRow = res.body.resourceRows.find((r: { resourceTypeId: string }) => r.resourceTypeId === nrRtId)
      expect(nrRow).toBeDefined()
      expect(nrRow.namedResources).toHaveLength(1)

      const nr = nrRow.namedResources[0]
      expect(nr.id).toBe(nrId)
      expect(nr.capacityProfile).toBeDefined()
      expect(nr.capacityProfile.planningBasis).toBe('availabilityWindow')
      expect(nr.capacityProfile.source).toBe('manual')
      expect(nr.capacityProfile.resolutionSource).toBe('PROFILE')
      expect(nr.allocationMode).toBe('TIMELINE')        // availabilityWindow → TIMELINE
      expect(nr.allocationPercent).toBe(60)
    })
  })

  // ─── 6. Legacy fallback ──────────────────────────────────────────────────
  describe('6. legacy fallback', () => {
    it('returns LEGACY resolution when no persisted profiles exist', async () => {
      const rtId = 'rt-legacy'
      const nrId = 'nr-legacy'
      const epicId = 'epic-legacy'
      const featId = 'feat-legacy'
      const storyId = 'story-legacy'

      vi.mocked(prisma.project.findFirst).mockResolvedValue({
        id: 'proj-legacy', ownerId: userId, name: 'Legacy',
        startDate: new Date('2026-01-05'), hoursPerDay: 8,
        bufferWeeks: 0, onboardingWeeks: 0, weeklyDemandCache: null,
        resourceTypes: [{
          id: rtId, name: 'Legacy RT', category: 'ENGINEERING',
          count: 1, hoursPerDay: 8, dayRate: 500,
          allocationMode: 'TIMELINE', allocationPercent: 100,
          allocationStartWeek: 0, allocationEndWeek: 8,
          globalType: null,
          namedResources: [{
            id: nrId, name: 'Legacy Person', startWeek: null, endWeek: null,
            allocationPct: 100, allocationMode: 'TIMELINE', allocationPercent: 100,
            allocationStartWeek: 0, allocationEndWeek: 8,
            pricingModel: 'ACTUAL_DAYS',
          }],
        }],
        epics: [{
          id: epicId, name: 'E1', order: 0, isActive: true,
          featureMode: 'sequential', scheduleMode: 'auto',
          features: [{
            id: featId, name: 'F1', order: 0, isActive: true,
            featureMode: 'sequential', timelineStartWeek: null,
            userStories: [{
              id: storyId, name: 'US1', order: 0, isActive: true,
              tasks: [{
                resourceTypeId: rtId, hoursEffort: 160,
                durationDays: null,
                resourceType: { id: rtId, name: 'Legacy RT', hoursPerDay: 8 },
              }],
            }],
          }],
        }],
        overheads: [],
        timelineEntries: [{ featureId: featId, feature: { id: featId, name: 'Feature', order: 0, isActive: true, timelineColour: null, epic: { id: 'epic-1', name: 'Epic', order: 0, isActive: true, featureMode: 'sequential', scheduleMode: 'auto', timelineStartWeek: null }, userStories: [] }, startWeek: 0, durationWeeks: 4 }],
        storyTimelineEntries: [],
        capacityPlans: [],
        capacityProfiles: [],
      } as never)

      useRealAdapter()

      const res = await request(app)
        .get('/api/projects/proj-legacy/resource-profile')
        .set('Authorization', authHeader)

      // Issue #418: no legacy fallback exists — missing persisted profiles
      // fail closed with an actionable integrity error.
      expect(res.status).toBe(409)
      expect(res.body.code).toBe('CAPACITY_INTEGRITY_ERROR')
    })
  })

  // ─── 7. Commercial invariance ────────────────────────────────────────────
  describe('7. Commercial invariance', () => {
    it('keeps allocatedDays, totalDays, and estimatedCost unchanged with profiles', async () => {
      const rtId = 'rt-com-1'
      const epicId = 'epic-com-1'
      const featId = 'feat-com-1'
      const storyId = 'story-com-1'

      // RT without named resources so role-level profile works
      const projectBase = {
        id: 'proj-com-1', ownerId: userId, name: 'Commercial',
        startDate: new Date('2026-01-05'), hoursPerDay: 8,
        bufferWeeks: 0, onboardingWeeks: 0, weeklyDemandCache: null,
        resourceTypes: [{
          id: rtId, name: 'Comm RT', category: 'ENGINEERING',
          count: 1, hoursPerDay: 8, dayRate: 500,
          allocationMode: 'TIMELINE', allocationPercent: 75,
          allocationStartWeek: 0, allocationEndWeek: 8,
          globalType: null,
          namedResources: [],
        }],
        epics: [{
          id: epicId, name: 'E1', order: 0, isActive: true,
          featureMode: 'sequential', scheduleMode: 'auto',
          features: [{
            id: featId, name: 'F1', order: 0, isActive: true,
            featureMode: 'sequential', timelineStartWeek: null,
            userStories: [{
              id: storyId, name: 'US1', order: 0, isActive: true,
              tasks: [{
                resourceTypeId: rtId, hoursEffort: 160,
                durationDays: null,
                resourceType: { id: rtId, name: 'Comm RT', hoursPerDay: 8 },
              }],
            }],
          }],
        }],
        overheads: [],
        timelineEntries: [{ featureId: featId, feature: { id: featId, name: 'Feature', order: 0, isActive: true, timelineColour: null, epic: { id: 'epic-1', name: 'Epic', order: 0, isActive: true, featureMode: 'sequential', scheduleMode: 'auto', timelineStartWeek: null }, userStories: [] }, startWeek: 0, durationWeeks: 8 }],
        storyTimelineEntries: [],
        capacityPlans: [],
      }
      const projectWith = {
        ...(projectBase as unknown as Record<string, unknown>),
        capacityProfiles: [{
          id: 'cp-com-1',
          projectId: 'proj-com-1',
          ownerKind: 'ROLE',
          resourceTypeId: rtId,
          namedResourceId: null,
          planningBasis: 'DEMAND_FOLLOWING',
          source: 'FIXED',
          defaultPercent: 50,
          startWeek: null,
          endWeek: null,
          segments: [],
        }],
      }

      // Issue #418: the no-profile request fails closed (no legacy fallback),
      // so commercial invariance is verified against the profile-backed row.
      vi.mocked(prisma.project.findFirst).mockResolvedValue(projectWith as never)
      useRealAdapter()

      const res2 = await request(app)
        .get('/api/projects/proj-com-1/resource-profile')
        .set('Authorization', authHeader)
      expect(res2.status).toBe(200)

      const row2 = res2.body.resourceRows.find((r: { resourceTypeId: string }) => r.resourceTypeId === rtId)
      expect(row2).toBeDefined()

      // Commercial fields are computed from effort: 160h / 8hpd = 20 days
      expect(row2.effortDays).toBe(20)
      expect(row2.totalDays).toBe(20)
      expect(row2.estimatedCost).toBe(10000)

      // Display fields are projected from the persisted profile:
      // demandFollowing → EFFORT
      expect(row2.capacityProfile.resolutionSource).toBe('PROFILE')
      expect(row2.allocationMode).toBe('EFFORT')     // projected
    })
  })

  // ─── 8. Trajectory-based capacity invariance ───────────────────────────
  describe('8. trajectory-based capacity invariance', () => {
    const EXPECTED_EFFORT_DAYS_160 = 20 // 160 h ÷ 8 hpd
    const DAY_RATE = 500
    const HPD = 8
    const WEEKS_8 = 8
    const WEEKS_12 = 12

    /**
     * Build project data with CAPACITY_PLAN mode and the given periods.
     * Each test creates a project with:
     * - 1 resource type in CAPACITY_PLAN mode
     * - 1 epic → 1 feature → 1 story → 1 task (160 h unless overridden)
     * - A timeline entry spanning effort weeks
     * - The given capacity plan periods
     * - Optionally, a capacity profile
     */
    function buildTrajectoryProject(opts: {
      projectId: string
      rtId: string
      rtName: string
      taskHours?: number
      capacityPlanPeriods: Array<{ startWeek: number; endWeek: number; headcount: number }>
      timelineStartWeek: number
      timelineDurationWeeks: number
      capacityProfiles?: Array<Record<string, unknown>>
      namedResources?: Array<Record<string, unknown>>
      dayRate?: number | null
    }): Record<string, unknown> {
      const { projectId, rtId, rtName, taskHours = 160, capacityPlanPeriods, timelineStartWeek, timelineDurationWeeks, capacityProfiles = [], namedResources = [], dayRate = DAY_RATE } = opts
      return {
        id: projectId,
        ownerId: userId,
        name: rtName,
        startDate: new Date('2026-01-05'),
        hoursPerDay: HPD,
        bufferWeeks: 0,
        onboardingWeeks: 0,
        weeklyDemandCache: null,
        resourceTypes: [{
          id: rtId,
          name: rtName,
          category: 'ENGINEERING',
          count: 1,
          hoursPerDay: HPD,
          dayRate,
          allocationMode: 'CAPACITY_PLAN',
          allocationPercent: 100,
          allocationStartWeek: null,
          allocationEndWeek: null,
          globalType: null,
          namedResources,
        }],
        epics: [{
          id: `epic-${projectId}`,
          name: 'E1',
          order: 0,
          isActive: true,
          featureMode: 'sequential',
          scheduleMode: 'auto',
          features: [{
            id: `feat-${projectId}`,
            name: 'F1',
            order: 0,
            isActive: true,
            featureMode: 'sequential',
            timelineStartWeek: null,
            userStories: [{
              id: `story-${projectId}`,
              name: 'US1',
              order: 0,
              isActive: true,
              tasks: [{
                resourceTypeId: rtId,
                hoursEffort: taskHours,
                durationDays: null,
                resourceType: { id: rtId, name: rtName, hoursPerDay: HPD },
              }],
            }],
          }],
        }],
        overheads: [],
        timelineEntries: [{ featureId: `feat-${projectId}`, feature: { id: `feat-${projectId}`, name: 'Feature', order: 0, isActive: true, timelineColour: null, epic: { id: 'epic-1', name: 'Epic', order: 0, isActive: true, featureMode: 'sequential', scheduleMode: 'auto', timelineStartWeek: null }, userStories: [{ id: `story-${projectId}`, isActive: true, tasks: [{ resourceTypeId: rtId, hoursEffort: taskHours, durationDays: null, resourceType: { id: rtId, name: rtName, hoursPerDay: HPD } }] }] }, startWeek: timelineStartWeek, durationWeeks: timelineDurationWeeks }],
        storyTimelineEntries: [],
        capacityPlans: [{
          id: `plan-${projectId}`,
          isActive: true,
          periods: capacityPlanPeriods.map((p, i) => ({
            periodIndex: i,
            startWeek: p.startWeek,
            endWeek: p.endWeek,
            entries: [{ resourceTypeId: rtId, headcount: p.headcount, demandFTE: 0, utilisationPct: null }],
          })),
        }],
        capacityProfiles,
      }
    }

    // ─── Fixture 1: Constant 50% ──────────────────────────────────────────
    it('fixture 1: constant 50% capacity for 8 weeks', async () => {
      const rtId = 'rt-f1'
      const projectId = 'proj-f1'

      // Profile-first (issue #418): the 50% plan capacity is persisted as a
      // named-person CAPACITY_PROFILE with a single 50% segment.
      const project = buildTrajectoryProject({
        projectId,
        rtId,
        rtName: 'F1 RT',
        capacityPlanPeriods: [{ startWeek: 0, endWeek: 8, headcount: 0.5 }],
        timelineStartWeek: 0,
        timelineDurationWeeks: WEEKS_8,
        namedResources: [{
          id: 'nr-f1', name: 'F1 Person', startWeek: null, endWeek: null,
          allocationPct: 50, allocationMode: 'CAPACITY_PLAN', allocationPercent: 50,
          allocationStartWeek: null, allocationEndWeek: null,
          pricingModel: 'ACTUAL_DAYS',
        }],
        capacityProfiles: [{
          id: 'cp-f1-1',
          projectId,
          ownerKind: 'NAMED_PERSON',
          resourceTypeId: null,
          namedResourceId: 'nr-f1',
          planningBasis: 'CAPACITY_PROFILE',
          source: 'SQUAD_PLANNER',
          defaultPercent: null,
          startWeek: null,
          endWeek: null,
          segments: [{ id: 'cs-f1-1', capacityProfileId: 'cp-f1-1', startWeek: 0, endWeek: 7, capacityPercent: 50, source: 'SQUAD_PLANNER' }],
        }],
      })

      vi.mocked(prisma.project.findFirst).mockResolvedValue(project as never)
      useRealAdapter()

      const res = await request(app)
        .get(`/api/projects/${projectId}/resource-profile`)
        .set('Authorization', authHeader)
      expect(res.status).toBe(200)

      const row = res.body.resourceRows.find((r: { resourceTypeId: string }) => r.resourceTypeId === rtId)
      expect(row).toBeDefined()

      // Effort 160h / 8hpd = 20 days; allocatedDays from the 50% segment:
      // 8 weeks × 5 × 0.5 = 20
      expect(row.effortDays).toBe(EXPECTED_EFFORT_DAYS_160)
      expect(row.totalDays).toBe(20)
      expect(row.estimatedCost).toBe(10000)

      const nr = row.namedResources.find((n: { id: string }) => n.id === 'nr-f1')
      expect(nr).toBeDefined()
      expect(nr.allocatedDays).toBe(20)
      expect(nr.allocationMode).toBe('CAPACITY_PLAN')
      expect(nr.startWeek).toBe(0)
      expect(nr.endWeek).toBe(7)
      expect(nr.allocationPercent).toBe(50)
    })

    // ─── Fixture 2: Changing capacity 100% → 50% ──────────────────────────
    it('fixture 2: changing capacity from 100% to 50% at week 4', async () => {
      const rtId = 'rt-f2'
      const projectId = 'proj-f2'

      // Profile-first: the two plan periods become two capacity segments.
      const project = buildTrajectoryProject({
        projectId,
        rtId,
        rtName: 'F2 RT',
        capacityPlanPeriods: [
          { startWeek: 0, endWeek: 4, headcount: 1.0 },
          { startWeek: 4, endWeek: 8, headcount: 0.5 },
        ],
        timelineStartWeek: 0,
        timelineDurationWeeks: WEEKS_8,
        namedResources: [{
          id: 'nr-f2', name: 'F2 Person', startWeek: null, endWeek: null,
          allocationPct: 100, allocationMode: 'CAPACITY_PLAN', allocationPercent: 100,
          allocationStartWeek: null, allocationEndWeek: null,
          pricingModel: 'ACTUAL_DAYS',
        }],
        capacityProfiles: [{
          id: 'cp-f2-1',
          projectId,
          ownerKind: 'NAMED_PERSON',
          resourceTypeId: null,
          namedResourceId: 'nr-f2',
          planningBasis: 'CAPACITY_PROFILE',
          source: 'SQUAD_PLANNER',
          defaultPercent: null,
          startWeek: null,
          endWeek: null,
          segments: [
            { id: 'cs-f2-1', capacityProfileId: 'cp-f2-1', startWeek: 0, endWeek: 3, capacityPercent: 100, source: 'SQUAD_PLANNER' },
            { id: 'cs-f2-2', capacityProfileId: 'cp-f2-1', startWeek: 4, endWeek: 7, capacityPercent: 50, source: 'SQUAD_PLANNER' },
          ],
        }],
      })

      vi.mocked(prisma.project.findFirst).mockResolvedValue(project as never)
      useRealAdapter()

      const res = await request(app)
        .get(`/api/projects/${projectId}/resource-profile`)
        .set('Authorization', authHeader)
      expect(res.status).toBe(200)
      const row = res.body.resourceRows.find((r: { resourceTypeId: string }) => r.resourceTypeId === rtId)
      expect(row).toBeDefined()

      // 2 segments: W0-W3 at 100%, W4-W7 at 50%
      // Segment-aware total: 4×5×1.0 + 4×5×0.5 = 20 + 10 = 30
      const r = row as Record<string, unknown>
      expect(r.totalDays).toBe(30)
      const nr = r.namedResources as Array<Record<string, unknown>>
      expect(nr).toHaveLength(1)
      expect(nr[0].allocatedDays).toBe(30)
      expect(nr[0].allocationMode).toBe('CAPACITY_PLAN')
      expect(nr[0].startWeek).toBe(0)
      expect(nr[0].endWeek).toBe(7)
    })

    it('fixture 3: discontinuous capacity with gap', async () => {
      const rtId = 'rt-f3'
      const projectId = 'proj-f3'

      // Profile-first: the discontinuous plan periods become two segments
      // with an explicit gap (weeks 4-7 have no capacity).
      const project = buildTrajectoryProject({
        projectId,
        rtId,
        rtName: 'F3 RT',
        taskHours: 320,
        capacityPlanPeriods: [
          { startWeek: 0, endWeek: 4, headcount: 1.0 },
          { startWeek: 8, endWeek: 12, headcount: 1.0 },
        ],
        timelineStartWeek: 0,
        timelineDurationWeeks: WEEKS_12,
        namedResources: [{
          id: 'nr-f3', name: 'F3 Person', startWeek: null, endWeek: null,
          allocationPct: 100, allocationMode: 'CAPACITY_PLAN', allocationPercent: 100,
          allocationStartWeek: null, allocationEndWeek: null,
          pricingModel: 'ACTUAL_DAYS',
        }],
        capacityProfiles: [{
          id: 'cp-f3-1',
          projectId,
          ownerKind: 'NAMED_PERSON',
          resourceTypeId: null,
          namedResourceId: 'nr-f3',
          planningBasis: 'CAPACITY_PROFILE',
          source: 'SQUAD_PLANNER',
          defaultPercent: null,
          startWeek: null,
          endWeek: null,
          segments: [
            { id: 'cs-f3-1', capacityProfileId: 'cp-f3-1', startWeek: 0, endWeek: 3, capacityPercent: 100, source: 'SQUAD_PLANNER' },
            { id: 'cs-f3-2', capacityProfileId: 'cp-f3-1', startWeek: 8, endWeek: 11, capacityPercent: 100, source: 'SQUAD_PLANNER' },
          ],
        }],
      })

      vi.mocked(prisma.project.findFirst).mockResolvedValue(project as never)
      useRealAdapter()

      const res = await request(app)
        .get(`/api/projects/${projectId}/resource-profile`)
        .set('Authorization', authHeader)
      expect(res.status).toBe(200)

      const row = res.body.resourceRows.find((r: { resourceTypeId: string }) => r.resourceTypeId === rtId)
      expect(row).toBeDefined()

      // 2 segments: W0-W3 at 100%, W8-W11 at 100% (gap W4-W7)
      // Segment-aware total: 4×5×1.0 + 4×5×1.0 = 20+20 = 40 (gap not counted)
      const r = row as Record<string, unknown>
      expect(r.totalDays).toBe(40)
      const nr = r.namedResources as Array<Record<string, unknown>>
      expect(nr).toHaveLength(1)
      expect(nr[0].allocatedDays).toBe(40)

      // Gap assertions for discontinuous capacity
      const nrr = nr as Array<Record<string, unknown>>
      // actualAllocatedWeeks should NOT contain the gap weeks (4,5,6,7)
      const gapWeeks = [4, 5, 6, 7]
      const allocWeeks = (nrr[0].actualAllocatedWeeks as Array<{week: number; days: number; capacityDays: number}>)
      if (allocWeeks) {
        for (const gw of gapWeeks) {
          const found = allocWeeks.find((aw: {week: number}) => aw.week === gw)
          if (found) {
            expect(found.days).toBe(0)
            expect(found.capacityDays).toBe(0)
          } else {
            expect(allocWeeks.map((aw: {week: number}) => aw.week)).not.toContain(gw)
          }
        }

        // actualAllocationSegments should be two separated ranges
        const allocSegs = nrr[0].actualAllocationSegments as Array<{startWeek: number; endWeek: number; days: number}>
        if (allocSegs) {
          expect(allocSegs).toHaveLength(2)
          expect(allocSegs[0].endWeek).toBeLessThan(4)  // first segment ends before gap
          expect(allocSegs[1].startWeek).toBeGreaterThanOrEqual(8)  // second segment starts after gap
        }

        // actualAllocatedDays should not count gap
        expect(nrr[0].actualAllocatedDays).toBe(26.4)

        // actualAllocationStartWeek/EndWeek should not include gap
        expect(nrr[0].actualAllocationStartWeek).toBeLessThan(4)
        expect(nrr[0].actualAllocationEndWeek).toBeGreaterThanOrEqual(8)
      }
    })

    // ─── Fixture 4: 1.5 FTE for 8 weeks (2 trajectories) ──────────────────
    it('fixture 4: 1.5 FTE for 8 weeks produces 2 named resources', async () => {
      const rtId = 'rt-f4'
      const projectId = 'proj-f4'

      // Profile-first: the 1.5 FTE plan becomes two named resources at
      // 100% and 50% with persisted CAPACITY_PROFILE segments.
      const project = buildTrajectoryProject({
        projectId,
        rtId,
        rtName: 'F4 RT',
        capacityPlanPeriods: [{ startWeek: 0, endWeek: 8, headcount: 1.5 }],
        timelineStartWeek: 0,
        timelineDurationWeeks: WEEKS_8,
        namedResources: [
          {
            id: 'nr-f4-1', name: 'F4 Person 1', startWeek: null, endWeek: null,
            allocationPct: 100, allocationMode: 'CAPACITY_PLAN', allocationPercent: 100,
            allocationStartWeek: null, allocationEndWeek: null,
            pricingModel: 'ACTUAL_DAYS',
          },
          {
            id: 'nr-f4-2', name: 'F4 Person 2', startWeek: null, endWeek: null,
            allocationPct: 50, allocationMode: 'CAPACITY_PLAN', allocationPercent: 50,
            allocationStartWeek: null, allocationEndWeek: null,
            pricingModel: 'ACTUAL_DAYS',
          },
        ],
        capacityProfiles: [
          {
            id: 'cp-f4-1',
            projectId,
            ownerKind: 'NAMED_PERSON',
            resourceTypeId: null,
            namedResourceId: 'nr-f4-1',
            planningBasis: 'CAPACITY_PROFILE',
            source: 'SQUAD_PLANNER',
            defaultPercent: null,
            startWeek: null,
            endWeek: null,
            segments: [{ id: 'cs-f4-1', capacityProfileId: 'cp-f4-1', startWeek: 0, endWeek: 7, capacityPercent: 100, source: 'SQUAD_PLANNER' }],
          },
          {
            id: 'cp-f4-2',
            projectId,
            ownerKind: 'NAMED_PERSON',
            resourceTypeId: null,
            namedResourceId: 'nr-f4-2',
            planningBasis: 'CAPACITY_PROFILE',
            source: 'SQUAD_PLANNER',
            defaultPercent: null,
            startWeek: null,
            endWeek: null,
            segments: [{ id: 'cs-f4-2', capacityProfileId: 'cp-f4-2', startWeek: 0, endWeek: 7, capacityPercent: 50, source: 'SQUAD_PLANNER' }],
          },
        ],
      })

      vi.mocked(prisma.project.findFirst).mockResolvedValue(project as never)
      useRealAdapter()

      const res = await request(app)
        .get(`/api/projects/${projectId}/resource-profile`)
        .set('Authorization', authHeader)
      expect(res.status).toBe(200)
      const row = res.body.resourceRows.find((r: { resourceTypeId: string }) => r.resourceTypeId === rtId)
      expect(row).toBeDefined()

      // NR1: 8×5×1.0 = 40, NR2: 8×5×0.5 = 20 → totalDays = 60
      const r = row as Record<string, unknown>
      expect(r.totalDays).toBe(60)
      const nr = r.namedResources as Array<Record<string, unknown>>
      expect(nr).toHaveLength(2)
      const nr1 = nr.find((n: Record<string, unknown>) => n.id === 'nr-f4-1')
      const nr2 = nr.find((n: Record<string, unknown>) => n.id === 'nr-f4-2')
      expect(nr1).toBeDefined()
      expect(nr2).toBeDefined()
      expect(nr1!.allocatedDays).toBe(40)
      expect(nr1!.allocationPercent).toBe(100)
      expect(nr2!.allocatedDays).toBe(20)
      expect(nr2!.allocationPercent).toBe(50)

      // Billing basis unchanged
      expect(nr1!.pricingModel).toBe('ACTUAL_DAYS')
      expect(nr2!.pricingModel).toBe('ACTUAL_DAYS')

      // Assignment segments exist
      expect(nr1!.actualAllocationSegments).toBeDefined()
      expect(nr2!.actualAllocationSegments).toBeDefined()
    })
  })
})
// ═════════════════════════════════════════════════════════════════════════════
// Issue #438 — n=0 display branch for the restored Class A ROLE profile.
// The Class A translation is a null-window LEGACY ROLE profile carrying the
// AGGREGATE percent max(0, count − n) × 100. The display path must not
// count-scale the aggregate (that would double-count the headcount); the
// scheduler contract remains the acceptance authority.
// ═════════════════════════════════════════════════════════════════════════════

describe('GET /resource-profile — restored Class A n=0 display (issue #438)', () => {
  // The file-level adapter mock is left overridden by earlier describes; the
  // display tests exercise the REAL buildResourceCapacityProfileMap (the
  // production adapter path) so the gate under test sees authentic
  // camelCase profile data.
  beforeEach(() => {
    const realFn = testCtx.realBuildFn
    if (!realFn) throw new Error('buildResourceCapacityProfileMap original unavailable')
    vi.mocked(capacityProfileAdapter.buildResourceCapacityProfileMap)
      .mockImplementation(realFn as (typeof capacityProfileAdapter.buildResourceCapacityProfileMap))
  })

  afterEach(() => {
    vi.mocked(capacityProfileAdapter.buildResourceCapacityProfileMap)
      .mockImplementation(() => ({ roleProfiles: new Map(), namedResourceProfiles: new Map() }))
  })

  function classAProjectFixture(profileOverrides: Record<string, unknown> = {}) {
    return {
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
          count: 3,
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
      storyTimelineEntries: [{ storyId: 'story-1', story: { name: 'Story', featureId: 'feat-story' }, startWeek: 0, durationWeeks: 4 }],
      capacityPlans: [],
      capacityProfiles: [
        {
          id: 'cp-role-class-a',
          projectId: 'proj-1',
          resourceTypeId: 'rt-dev',
          namedResourceId: null,
          ownerKind: 'ROLE',
          planningBasis: 'AVAILABILITY_WINDOW',
          source: 'LEGACY',
          defaultPercent: 300,
          startWeek: null,
          endWeek: null,
          legacy: { kind: 'DB_NULL' },
          segments: [],
          ...profileOverrides,
        },
      ],
    }
  }

  it('does not count-scale the aggregate ROLE percent for a restored n=0 role', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue(classAProjectFixture() as any)

    const res = await request(app)
      .get('/api/projects/proj-1/resource-profile')
      .set('Authorization', authHeader)

    expect(res.status).toBe(200)
    const devRow = res.body.resourceRows.find((row: any) => row.resourceTypeId === 'rt-dev')
    expect(devRow).toBeTruthy()
    // Demand window W0..W3 (4 weeks): the aggregate 300% ROLE is 3 FTE, so the
    // display shows 4 × 5 × 3 = 60 days — NOT count-scaled (4 × 5 × 3 × 3 = 180).
    expect(devRow.allocatedDays).toBe(60)
    expect(devRow.effortDays).toBe(1) // 8h / 8hpd; durationDays does not change effort
    // The projected legacy shape is the availability-window (TIMELINE) mode
    // with the aggregate percent; the restored profile is surfaced faithfully.
    expect(devRow.allocationMode).toBe('TIMELINE')
    expect(devRow.allocationPercent).toBe(300)
    expect(devRow.capacityProfile.planningBasis).toBe('availabilityWindow')
    expect(devRow.capacityProfile.source).toBe('legacy')
    expect(devRow.capacityProfile.defaultPercent).toBe(300)
    // The persisted profile is never corrupted by the display path.
    expect(devRow.capacityProfile.startWeek).toBeNull()
    expect(devRow.capacityProfile.endWeek).toBeNull()

    // Scheduler capacity is the acceptance authority: 3 FTE × 8h × 5 days.
    const { resolveSchedulerCapacity } = await import('../lib/schedulerCapacityResolver.js')
    const { getWeeklyCapacity } = await import('../lib/scheduler.js')
    const resolved = await resolveSchedulerCapacity(prisma as any, 'proj-1')
    const rt = resolved.resourceTypes.find(r => r.id === 'rt-dev')!
    expect(getWeeklyCapacity(rt, 0, 8)).toBe(120)
    expect(getWeeklyCapacity(rt, 20, 8)).toBe(120)
  })

  it('keeps the existing count scaling for windowed per-slot LEGACY profiles (unchanged display)', async () => {
    // A windowed LEGACY ROLE (the windowed CAPACITY_PLAN translation) is
    // per-slot semantics: count scaling is correct and must stay untouched.
    vi.mocked(prisma.project.findFirst).mockResolvedValue(classAProjectFixture({
      defaultPercent: 100,
      startWeek: 0,
      endWeek: 3,
    }) as any)

    const res = await request(app)
      .get('/api/projects/proj-1/resource-profile')
      .set('Authorization', authHeader)

    expect(res.status).toBe(200)
    const devRow = res.body.resourceRows.find((row: any) => row.resourceTypeId === 'rt-dev')
    // Window W0..W3 = 3 demand weeks × 5 days × count 3 × 100% — the
    // pre-existing count-scaled per-slot display, untouched by the gate.
    expect(devRow.allocatedDays).toBe(45)
  })
})
