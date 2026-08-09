/**
 * planningGuards.test.ts — NEEDS_REPLAN quarantine behaviour (issue #449).
 *
 * Capacity-dependent operations return an actionable 409 REPLAN_REQUIRED
 * instead of running legacy fallback or surfacing opaque integrity errors,
 * while the surfaces the user needs to replan (project shell, backlog,
 * resource inputs, profile writes) stay accessible with an explicit
 * NEEDS_REPLAN marker.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import request from 'supertest'
import jwt from 'jsonwebtoken'

import { app } from '../index.js'
import { prisma } from '../lib/prisma.js'

const userId = 'user-1'
process.env.JWT_SECRET = 'test-secret'
const token = jwt.sign({ userId }, 'test-secret')
const authHeader = `Bearer ${token}`

const NEEDS_REPLAN_PROJECT = {
  id: 'proj-1',
  ownerId: userId,
  planningState: 'NEEDS_REPLAN',
  hoursPerDay: 7.6,
  startDate: null,
  bufferWeeks: 0,
  onboardingWeeks: 0,
}

beforeEach(() => vi.clearAllMocks())

describe('planning-dependent guards while NEEDS_REPLAN', () => {
  it('POST /timeline/schedule returns 409 REPLAN_REQUIRED without scheduling', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue(NEEDS_REPLAN_PROJECT as never)

    const res = await request(app)
      .post('/api/projects/proj-1/timeline/schedule')
      .set('Authorization', authHeader)
      .send({})

    expect(res.status).toBe(409)
    expect(res.body.code).toBe('REPLAN_REQUIRED')
    expect(res.body.error).toContain('needs replanning')
    // No scheduler/data loads ran.
    expect(prisma.epic.findMany).not.toHaveBeenCalled()
  })

  it('POST /timeline/level returns 409 REPLAN_REQUIRED', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue(NEEDS_REPLAN_PROJECT as never)

    const res = await request(app)
      .post('/api/projects/proj-1/timeline/level')
      .set('Authorization', authHeader)
      .send({})

    expect(res.status).toBe(409)
    expect(res.body.code).toBe('REPLAN_REQUIRED')
  })

  it('GET /timeline/export/csv returns 409 REPLAN_REQUIRED', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue(NEEDS_REPLAN_PROJECT as never)

    const res = await request(app)
      .get('/api/projects/proj-1/timeline/export/csv')
      .set('Authorization', authHeader)

    expect(res.status).toBe(409)
    expect(res.body.code).toBe('REPLAN_REQUIRED')
  })

  it('manual timeline override PUT returns 409 REPLAN_REQUIRED', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue(NEEDS_REPLAN_PROJECT as never)

    const res = await request(app)
      .put('/api/projects/proj-1/timeline/feature-1')
      .set('Authorization', authHeader)
      .send({ startWeek: 1, durationWeeks: 2 })

    expect(res.status).toBe(409)
    expect(res.body.code).toBe('REPLAN_REQUIRED')
  })

  it('POST /optimise returns 409 REPLAN_REQUIRED', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue(NEEDS_REPLAN_PROJECT as never)

    const res = await request(app)
      .post('/api/projects/proj-1/optimise')
      .set('Authorization', authHeader)
      .send({})

    expect(res.status).toBe(409)
    expect(res.body.code).toBe('REPLAN_REQUIRED')
  })
})

describe('accessible surfaces while NEEDS_REPLAN', () => {
  it('GET /timeline returns an explicit neutral empty payload (no stale schedule)', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue(NEEDS_REPLAN_PROJECT as never)

    const res = await request(app)
      .get('/api/projects/proj-1/timeline')
      .set('Authorization', authHeader)

    expect(res.status).toBe(200)
    expect(res.body.planningState).toBe('NEEDS_REPLAN')
    expect(res.body.entries).toEqual([])
    expect(res.body.weeklyDemand).toEqual([])
    expect(res.body.weeklyCapacity).toEqual([])
    expect(res.body.namedResources).toEqual([])
  })

  it('GET /capacity-profiles serves the persisted (empty) set instead of failing completeness', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue({
      ...NEEDS_REPLAN_PROJECT,
      resourceTypes: [{ id: 'rt-1', name: 'Engineer', namedResources: [] }],
      capacityPlans: [],
      capacityProfiles: [],
    } as never)

    const res = await request(app)
      .get('/api/projects/proj-1/capacity-profiles')
      .set('Authorization', authHeader)

    expect(res.status).toBe(200)
    expect(res.body.capacityProfiles).toEqual([])
  })

  it('GET /capacity-profiles still fails closed on genuinely malformed rows while NEEDS_REPLAN', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue({
      ...NEEDS_REPLAN_PROJECT,
      resourceTypes: [{ id: 'rt-1', name: 'Engineer', namedResources: [] }],
      capacityPlans: [],
      capacityProfiles: [{
        id: 'cp-bad',
        projectId: 'proj-1',
        resourceTypeId: 'rt-1',
        namedResourceId: null,
        ownerKind: 'ROLE',
        source: 'MANUAL',
        planningBasis: 'DEMAND_FOLLOWING',
        defaultPercent: 100,
        startWeek: 8,
        endWeek: 3,
        segments: [],
      }],
    } as never)

    const res = await request(app)
      .get('/api/projects/proj-1/capacity-profiles')
      .set('Authorization', authHeader)

    expect(res.status).toBe(409)
    expect(res.body.code).toBe('CAPACITY_INTEGRITY_ERROR')
  })

  it('GET /resource-profile returns effort/inputs with neutral planning values and the marker', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue({
      ...NEEDS_REPLAN_PROJECT,
      resourceTypes: [{
        id: 'rt-1',
        name: 'Engineer',
        category: 'ENGINEERING',
        count: 2,
        hoursPerDay: 7.6,
        dayRate: 500,
        globalType: null,
        namedResources: [{
          id: 'nr-1',
          resourceTypeId: 'rt-1',
          name: 'Alice',
          pricingModel: 'ACTUAL_DAYS',
        }],
      }],
      epics: [{
        id: 'epic-1',
        name: 'Epic 1',
        order: 0,
        isActive: true,
        features: [{
          id: 'feat-1',
          name: 'Feature 1',
          order: 0,
          isActive: true,
          userStories: [{
            id: 'story-1',
            name: 'Story 1',
            order: 0,
            isActive: true,
            tasks: [{
              id: 'task-1',
              name: 'Task 1',
              hoursEffort: 10,
              durationDays: null,
              resourceTypeId: 'rt-1',
              resourceType: { id: 'rt-1', name: 'Engineer', hoursPerDay: 7.6 },
            }],
          }],
        }],
      }],
      overheads: [],
      timelineEntries: [],
      storyTimelineEntries: [],
      capacityPlans: [],
      capacityProfiles: [],
    } as never)

    const res = await request(app)
      .get('/api/projects/proj-1/resource-profile')
      .set('Authorization', authHeader)

    expect(res.status).toBe(200)
    expect(res.body.planningState).toBe('NEEDS_REPLAN')
    expect(res.body.resourceRows).toHaveLength(1)
    const row = res.body.resourceRows[0]
    // Effort and identity survive…
    expect(row.totalHours).toBe(10)
    expect(row.effortDays).toBeGreaterThan(0)
    expect(row.name).toBe('Engineer')
    expect(row.count).toBe(2)
    expect(row.dayRate).toBe(500)
    // …but no planning/commercial values are fabricated.
    expect(row.allocatedDays).toBe(0)
    expect(row.totalDays).toBe(0)
    expect(row.estimatedCost).toBeNull()
    expect(row.capacityProfile).toBeUndefined()
    // User-authored named resource identity is preserved.
    expect(row.namedResources).toHaveLength(1)
    expect(row.namedResources[0].name).toBe('Alice')
    expect(row.namedResources[0].pricingModel).toBe('ACTUAL_DAYS')
    // Summary carries no invented totals.
    expect(res.body.summary.totalCost).toBeNull()
    expect(res.body.summary.hasCost).toBe(false)
    expect(res.body.summary.totalDays).toBe(0)
  })

  it('GET /resource-profile exposes preserved zero-demand roles while NEEDS_REPLAN', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue({
      ...NEEDS_REPLAN_PROJECT,
      resourceTypes: [{
        id: 'rt-1',
        name: 'Engineer',
        category: 'ENGINEERING',
        count: 2,
        hoursPerDay: 7.6,
        dayRate: 500,
        globalType: null,
        namedResources: [{
          id: 'nr-1',
          resourceTypeId: 'rt-1',
          name: 'Alice',
          pricingModel: 'ACTUAL_DAYS',
        }],
      }, {
        // Preserved role with NO task demand (no tasks reference it).
        id: 'rt-2',
        name: 'Designer',
        category: 'DESIGN',
        count: 1,
        hoursPerDay: 7.6,
        dayRate: 400,
        globalType: null,
        namedResources: [],
      }],
      epics: [{
        id: 'epic-1',
        name: 'Epic 1',
        order: 0,
        isActive: true,
        features: [{
          id: 'feat-1',
          name: 'Feature 1',
          order: 0,
          isActive: true,
          userStories: [{
            id: 'story-1',
            name: 'Story 1',
            order: 0,
            isActive: true,
            tasks: [{
              id: 'task-1',
              name: 'Task 1',
              hoursEffort: 10,
              durationDays: null,
              resourceTypeId: 'rt-1',
              resourceType: { id: 'rt-1', name: 'Engineer', hoursPerDay: 7.6 },
            }],
          }],
        }],
      }],
      overheads: [],
      timelineEntries: [],
      storyTimelineEntries: [],
      capacityPlans: [],
      capacityProfiles: [],
    } as never)

    const res = await request(app)
      .get('/api/projects/proj-1/resource-profile')
      .set('Authorization', authHeader)

    expect(res.status).toBe(200)
    expect(res.body.planningState).toBe('NEEDS_REPLAN')
    // Every preserved role is visible — including the zero-demand one — so
    // the user can create its profile before completing replanning.
    expect(res.body.resourceRows).toHaveLength(2)
    const zeroRow = res.body.resourceRows.find((r: { resourceTypeId: string }) => r.resourceTypeId === 'rt-2')
    expect(zeroRow).toBeDefined()
    // Real identity and non-planning metadata…
    expect(zeroRow.name).toBe('Designer')
    expect(zeroRow.count).toBe(1)
    expect(zeroRow.hoursPerDay).toBe(7.6)
    expect(zeroRow.dayRate).toBe(400)
    // …zero effort/demand and NO fabricated capacity.
    expect(zeroRow.totalHours).toBe(0)
    expect(zeroRow.effortDays).toBe(0)
    expect(zeroRow.totalDays).toBe(0)
    expect(zeroRow.allocatedDays).toBe(0)
    expect(zeroRow.estimatedCost).toBeNull()
    // Editor-usable default shape (same draft a normal project gets).
    expect(zeroRow.allocationMode).toBe('EFFORT')
    expect(zeroRow.allocationPercent).toBe(100)
    expect(zeroRow.capacityProfile).toBeUndefined()
    // A named resource on the zero-demand role keeps its identity.
    const rt2Named = res.body.resourceRows.find((r: { resourceTypeId: string }) => r.resourceTypeId === 'rt-2')
    expect(rt2Named.namedResources).toEqual([])
  })
})
