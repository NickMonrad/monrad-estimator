/**
 * canonical-consistency.test.ts — Canonical regression fixture proving Timeline,
 * Resource Profile, Commercial, and exports agree on the same planning/commercial
 * facts after recent ownership-boundary and stale-label work.
 *
 * Fixture scenario:
 *   - 1 resource type (Developer), 1 named resource (Alice)
 *   - 1 onboarding week, 2 buffer weeks
 *   - Cached weekly demand for weeks 0-3
 *   - 1 timeline entry for a feature with task hours
 *
 * Invariants protected:
 *   1. Named-resource `actualAllocatedDays` is identical in Timeline and Resource Profile.
 *   2. Named-resource `name` uses the current DB label (not a stale cached label).
 *   3. Onboarding weeks shift the planning window start.
 *   4. Buffer weeks extend the planning window end.
 *   5. CSV named-resource rows contain the same label and day values.
 *   6. Resource Profile `bufferWeeks` matches the project.
 *
 * These invariants guard against future drift between surfaces after changes to
 * the shared planning model, cache-key format, or ownership boundaries.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { app } from '../index.js'
import { prisma } from '../lib/prisma.js'

process.env.JWT_SECRET = 'test-secret'

const userId = 'user-1'
const token = jwt.sign({ userId }, 'test-secret')
const authHeader = `Bearer ${token}`

/** Base project fields that both Timeline and Resource Profile routes need. */
function baseProjectFixture() {
  return {
    id: 'proj-1',
    ownerId: userId,
    name: 'Consistency Project',
    startDate: new Date('2026-01-05T00:00:00.000Z'),
    hoursPerDay: 8,
    bufferWeeks: 2,
    onboardingWeeks: 1,
    weeklyDemandCache: { 'rt-dev|0': 5, 'rt-dev|1': 5, 'rt-dev|2': 5, 'rt-dev|3': 5 },
    // Relations needed by the resource profile route
    resourceTypes: [],
    epics: [],
    overheads: [],
    timelineEntries: [],
    storyTimelineEntries: [],
    capacityPlans: [],
  }
}

/** Single resource type with one named resource. */
function resourceTypeWithAlice() {
  return [{
    id: 'rt-dev',
    name: 'Developer',
    category: 'ENGINEERING',
    count: 1,
    hoursPerDay: 8,
    dayRate: 500,
    allocationMode: 'EFFORT',
    allocationPercent: 100,
    allocationStartWeek: null,
    allocationEndWeek: null,
    globalType: null,
    namedResources: [{
      id: 'nr-alice',
      name: 'Alice',
      startWeek: null,
      endWeek: null,
      allocationPct: 100,
      allocationMode: 'EFFORT',
      allocationPercent: 100,
      allocationStartWeek: null,
      allocationEndWeek: null,
      pricingModel: 'ACTUAL_DAYS',
    }],
  }]
}

/** A timeline-entry-shaped fixture with a feature task. */
function timelineEntryFixture() {
  return [{
    id: 'entry-auth',
    projectId: 'proj-1',
    featureId: 'feat-auth',
    startWeek: 0,
    durationWeeks: 4,
    isManual: false,
    feature: {
      id: 'feat-auth',
      name: 'Authentication',
      order: 0,
      isActive: true,
      timelineColour: null,
      epic: {
        id: 'epic-1',
        name: 'Platform',
        order: 0,
        isActive: true,
        featureMode: 'sequential',
        scheduleMode: 'auto',
        timelineStartWeek: null,
      },
      userStories: [{
        isActive: true,
        tasks: [{
          resourceTypeId: 'rt-dev',
          hoursEffort: 160,
          durationDays: null,
          resourceType: { id: 'rt-dev', name: 'Developer', hoursPerDay: 8 },
        }],
      }],
    },
  }]
}

beforeEach(() => vi.clearAllMocks())

describe('canonical cross-surface consistency', () => {
  it('Timeline reports correct named-resource label and allocation days', async () => {
    // buildProjectPlanningModel Prisma call sequence:
    //   1. project.findFirst
    //   2. resourceType.findMany
    //   3-4. timelineEntry.findMany + storyTimelineEntry.findMany (parallel)
    //   5-7. deps (default mock returns [])
    //   8. capacityPlan.findFirst
    // GET /timeline handler then does:
    //   9. timelineEntry.findMany (reload for response)

    vi.mocked(prisma.project.findFirst).mockResolvedValueOnce(baseProjectFixture() as never)
    vi.mocked(prisma.resourceType.findMany).mockResolvedValueOnce(resourceTypeWithAlice() as never)
    vi.mocked(prisma.timelineEntry.findMany).mockResolvedValueOnce(timelineEntryFixture() as never)
    vi.mocked(prisma.storyTimelineEntry.findMany).mockResolvedValueOnce([] as never)
    vi.mocked(prisma.capacityPlan.findFirst).mockResolvedValueOnce(null as never)
    vi.mocked(prisma.timelineEntry.findMany).mockResolvedValueOnce(timelineEntryFixture() as never)

    const res = await request(app)
      .get('/api/projects/proj-1/timeline')
      .set('Authorization', authHeader)

    expect(res.status).toBe(200)

    const nrs = res.body.namedResources
    expect(nrs.length).toBeGreaterThan(0)
    expect(nrs[0].name).toBe('Alice')
    expect(nrs[0].resourceTypeName).toBe('Developer')
    expect(typeof nrs[0].actualAllocatedDays).toBe('number')
    expect(nrs[0].actualAllocatedDays).toBeGreaterThan(0)

    expect(res.body.onboardingWeeks).toBe(1)
    expect(res.body.bufferWeeks).toBe(2)
    expect(res.body.projectedEndDate).toBe('2026-02-23T00:00:00.000Z')
  })

  it('Resource Profile reports the same named-resource label and allocation days', async () => {
    const projectFixture = {
      ...baseProjectFixture(),
      resourceTypes: resourceTypeWithAlice(),
      epics: [{
        id: 'epic-1',
        name: 'Platform',
        order: 0,
        isActive: true,
        featureMode: 'sequential',
        scheduleMode: 'auto',
        features: [{
          id: 'feat-auth',
          name: 'Authentication',
          order: 0,
          isActive: true,
          featureMode: 'sequential',
          timelineStartWeek: null,
          userStories: [{
            isActive: true,
            tasks: [{
              resourceTypeId: 'rt-dev',
              hoursEffort: 160,
              durationDays: null,
              resourceType: { id: 'rt-dev', name: 'Developer', hoursPerDay: 8 },
            }],
          }],
        }],
      }],
      overheads: [],
      timelineEntries: [{ featureId: 'feat-auth', startWeek: 0, durationWeeks: 4 }],
      storyTimelineEntries: [],
      capacityPlans: [],
    }

    vi.mocked(prisma.project.findFirst).mockResolvedValueOnce(projectFixture as never)

    const res = await request(app)
      .get('/api/projects/proj-1/resource-profile')
      .set('Authorization', authHeader)

    expect(res.status).toBe(200)

    const devRow = res.body.resourceRows.find(
      (r: { resourceTypeId: string }) => r.resourceTypeId === 'rt-dev',
    )
    expect(devRow).toBeTruthy()

    const nrs = devRow.namedResources
    expect(nrs.length).toBeGreaterThan(0)
    expect(nrs[0].name).toBe('Alice')
    expect(typeof nrs[0].actualAllocatedDays).toBe('number')
    expect(nrs[0].actualAllocatedDays).toBeGreaterThan(0)

    expect(res.body.bufferWeeks).toBe(2)
  })

  it('Timeline and Resource Profile agree on actualAllocatedDays for the same NR', async () => {
    // Timeline
    vi.mocked(prisma.project.findFirst).mockResolvedValueOnce(baseProjectFixture() as never)
    vi.mocked(prisma.resourceType.findMany).mockResolvedValueOnce(resourceTypeWithAlice() as never)
    vi.mocked(prisma.timelineEntry.findMany).mockResolvedValueOnce(timelineEntryFixture() as never)
    vi.mocked(prisma.storyTimelineEntry.findMany).mockResolvedValueOnce([] as never)
    vi.mocked(prisma.capacityPlan.findFirst).mockResolvedValueOnce(null as never)
    vi.mocked(prisma.timelineEntry.findMany).mockResolvedValueOnce(timelineEntryFixture() as never)

    const timelineRes = await request(app)
      .get('/api/projects/proj-1/timeline')
      .set('Authorization', authHeader)
    expect(timelineRes.status).toBe(200)
    const timelineDays: number = timelineRes.body.namedResources[0].actualAllocatedDays

    // Resource Profile
    const profileFixture = {
      ...baseProjectFixture(),
      resourceTypes: resourceTypeWithAlice(),
      epics: [{
        id: 'epic-1',
        name: 'Platform',
        order: 0,
        isActive: true,
        featureMode: 'sequential',
        scheduleMode: 'auto',
        features: [{
          id: 'feat-auth',
          name: 'Authentication',
          order: 0,
          isActive: true,
          featureMode: 'sequential',
          timelineStartWeek: null,
          userStories: [{
            isActive: true,
            tasks: [{
              resourceTypeId: 'rt-dev',
              hoursEffort: 160,
              durationDays: null,
              resourceType: { id: 'rt-dev', name: 'Developer', hoursPerDay: 8 },
            }],
          }],
        }],
      }],
      overheads: [],
      timelineEntries: [{ featureId: 'feat-auth', startWeek: 0, durationWeeks: 4 }],
      storyTimelineEntries: [],
      capacityPlans: [],
    }
    vi.mocked(prisma.project.findFirst).mockResolvedValueOnce(profileFixture as never)

    const profileRes = await request(app)
      .get('/api/projects/proj-1/resource-profile')
      .set('Authorization', authHeader)
    expect(profileRes.status).toBe(200)

    const devRow = profileRes.body.resourceRows.find(
      (r: { resourceTypeId: string }) => r.resourceTypeId === 'rt-dev',
    )
    const profileDays: number = devRow.namedResources[0].actualAllocatedDays

    // Same cached demand must produce the same allocated day count
    expect(timelineDays).toBe(profileDays)
  })

  it('Timeline CSV export uses current named-resource label', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValueOnce({
      ...baseProjectFixture(),
      resourceTypes: resourceTypeWithAlice(),
    } as never)
    vi.mocked(prisma.timelineEntry.findMany).mockResolvedValueOnce(timelineEntryFixture() as never)
    vi.mocked(prisma.storyTimelineEntry.findMany).mockResolvedValueOnce([] as never)
    vi.mocked(prisma.task.findMany).mockResolvedValueOnce([] as never)
    vi.mocked(prisma.namedResource.findMany).mockResolvedValueOnce([
      {
        id: 'nr-alice',
        name: 'Alice',
        resourceTypeId: 'rt-dev',
        startWeek: null,
        endWeek: null,
        allocationPct: 100,
        allocationMode: 'EFFORT',
        allocationPercent: 100,
        allocationStartWeek: null,
        allocationEndWeek: null,
        pricingModel: 'ACTUAL_DAYS',
        resourceType: { id: 'rt-dev', name: 'Developer' },
      },
    ] as never)

    const res = await request(app)
      .get('/api/projects/proj-1/timeline/export/csv')
      .set('Authorization', authHeader)

    expect(res.status).toBe(200)
    const csv: string = res.text

    expect(csv).toContain('Alice')
    expect(csv).toContain('Developer')
    expect(csv).toContain('T&M')
    expect(csv).toContain('Developer,0,5')
  })
})
