/**
 * canonical-consistency.test.ts — Canonical regression fixture proving Timeline,
 * Resource Profile, Commercial, and exports agree on the same planning/commercial
 * facts after recent ownership-boundary and stale-label work.
 *
 * Fixture scenario:
 *   - 1 resource type (Developer, day rate $500), 2 named resources
 *   -   Alice (EFFORT, ACTUAL_DAYS billing)
 *   -   Bob (EFFORT, PRO_RATA billing)
 *   - 1 onboarding week, 2 buffer weeks
 *   - Cached weekly demand for weeks 0-3
 *   - 1 timeline entry for a feature with 160h of Developer task hours
 *
 * Invariants protected:
 *   1. Named-resource `actualAllocatedDays` is identical in Timeline and Resource Profile.
 *   2. Named-resource `name` uses the current DB label (not a stale cached label).
 *   3. Entry-level start dates are shifted by onboarding weeks.
 *   4. Buffer weeks extend the planning window end.
 *   5. CSV named-resource row pairs the correct name and resource type.
 *   6. Commercial billing-basis (pricingModel) is present on each named resource.
 *   7. PRO_RATA and ACTUAL_DAYS named resources coexist with correct pricingModel.
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
    resourceTypes: [],
    epics: [],
    overheads: [],
    timelineEntries: [],
    storyTimelineEntries: [],
    capacityPlans: [],
  }
}

/** Single resource type with two named resources exercising both billing bases. */
function resourceTypeWithNamedResources() {
  return [{
    id: 'rt-dev',
    name: 'Developer',
    category: 'ENGINEERING',
    count: 2,
    hoursPerDay: 8,
    dayRate: 500,
    allocationMode: 'EFFORT',
    allocationPercent: 100,
    allocationStartWeek: null,
    allocationEndWeek: null,
    globalType: null,
    namedResources: [
      {
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
      },
      {
        id: 'nr-bob',
        name: 'Bob',
        startWeek: null,
        endWeek: null,
        allocationPct: 100,
        allocationMode: 'EFFORT',
        allocationPercent: 100,
        allocationStartWeek: null,
        allocationEndWeek: null,
        pricingModel: 'PRO_RATA',
      },
    ],
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
  it('Timeline reports correct named-resource labels, allocation days, and onboarding-shifted dates', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValueOnce(baseProjectFixture() as never)
    vi.mocked(prisma.resourceType.findMany).mockResolvedValueOnce(resourceTypeWithNamedResources() as never)
    vi.mocked(prisma.timelineEntry.findMany).mockResolvedValueOnce(timelineEntryFixture() as never)
    vi.mocked(prisma.storyTimelineEntry.findMany).mockResolvedValueOnce([] as never)
    vi.mocked(prisma.capacityPlan.findFirst).mockResolvedValueOnce(null as never)
    vi.mocked(prisma.timelineEntry.findMany).mockResolvedValueOnce(timelineEntryFixture() as never)

    const res = await request(app)
      .get('/api/projects/proj-1/timeline')
      .set('Authorization', authHeader)

    expect(res.status).toBe(200)

    // Named-resource labels are the current DB values, not stale cached labels
    const nrs = res.body.namedResources
    expect(nrs.length).toBeGreaterThanOrEqual(2)
    expect(nrs[0].name).toBe('Alice')
    expect(nrs[0].resourceTypeName).toBe('Developer')
    expect(nrs[0].actualAllocatedDays).toBeGreaterThan(0)
    expect(nrs[1].name).toBe('Bob')
    expect(nrs[1].resourceTypeName).toBe('Developer')
    expect(typeof nrs[1].actualAllocatedDays).toBe('number')

    // Entry-level start date is shifted by onboarding weeks:
    // startWeek=0, 1 onboarding week → startDate = Jan 5 + 7 days = Jan 12
    expect(res.body.entries[0].startDate).toBe('2026-01-12T00:00:00.000Z')
    expect(res.body.entries[0].endDate).toBe('2026-02-09T00:00:00.000Z')

    // Planning window reflects onboarding + buffer weeks
    expect(res.body.onboardingWeeks).toBe(1)
    expect(res.body.bufferWeeks).toBe(2)
    // startWeek=0, duration=4, onboarding=1, buffer=2 => maxWeek = 0+4+1+2 = 7
    // Jan 5 + 7 weeks = Feb 23
    expect(res.body.projectedEndDate).toBe('2026-02-23T00:00:00.000Z')
  })

  it('Resource Profile reports the same named-resource labels and both billing bases', async () => {
    const projectFixture = {
      ...baseProjectFixture(),
      resourceTypes: resourceTypeWithNamedResources(),
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
    expect(nrs.length).toBeGreaterThanOrEqual(2)

    // Both billing bases are present
    const alice = nrs.find((nr: { id: string }) => nr.id === 'nr-alice')
    const bob = nrs.find((nr: { id: string }) => nr.id === 'nr-bob')
    expect(alice).toBeTruthy()
    expect(bob).toBeTruthy()
    expect(alice.name).toBe('Alice')
    expect(bob.name).toBe('Bob')
    expect(alice.pricingModel).toBe('ACTUAL_DAYS')
    expect(bob.pricingModel).toBe('PRO_RATA')
    expect(alice.actualAllocatedDays).toBeGreaterThan(0)

    expect(res.body.bufferWeeks).toBe(2)
  })

  it('Timeline and Resource Profile agree on actualAllocatedDays for the same NR', async () => {
    // Timeline
    vi.mocked(prisma.project.findFirst).mockResolvedValueOnce(baseProjectFixture() as never)
    vi.mocked(prisma.resourceType.findMany).mockResolvedValueOnce(resourceTypeWithNamedResources() as never)
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
      resourceTypes: resourceTypeWithNamedResources(),
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

    // Same cached demand produces the same allocated day count across both surfaces
    expect(timelineDays).toBe(profileDays)
  })

  it('Timeline CSV export pairs the correct name and resource type in the same row', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValueOnce({
      ...baseProjectFixture(),
      resourceTypes: resourceTypeWithNamedResources(),
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

    // Split CSV into sections by blank-line delimiters
    const sections = csv.split('\n\n')
    expect(sections.length).toBeGreaterThanOrEqual(3)

    // Section 3 is the Named Resources section
    const nrSection = sections[2]
    const nrRows = nrSection.split('\n')

    // Header: Name,ResourceType,AllocationType,AllocationPct,StartWeek,EndWeek
    expect(nrRows[0]).toBe('Name,ResourceType,AllocationType,AllocationPct,StartWeek,EndWeek')

    // Data row: Alice,Developer,T&M,100,,
    expect(nrRows[1]).toBe('Alice,Developer,T&M,100,,')

    // Section 2 is the Resource Demand section: ResourceType,Week,DemandDays,CapacityDays,Status
    const demandSection = sections[1]
    // The cached demand is for rt-dev|0..3, resolved to Developer|0..3
    expect(demandSection).toContain('Developer,0,5,')
  })
})
