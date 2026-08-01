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


/** Profiles for the two named resources (DEMAND_FOLLOWING scalars). */
function capacityProfileFixture() {
  return [
    {
      id: 'cp-role-dev',
      projectId: 'proj-1',
      resourceTypeId: 'rt-dev',
      namedResourceId: null,
      ownerKind: 'ROLE',
      planningBasis: 'DEMAND_FOLLOWING',
      source: 'FIXED',
      defaultPercent: 100,
      startWeek: null,
      endWeek: null,
      legacy: null,
      createdAt: new Date(),
      segments: [],
    },
    {
      id: 'cp-alice',
      projectId: 'proj-1',
      resourceTypeId: null,
      namedResourceId: 'nr-alice',
      ownerKind: 'NAMED_PERSON',
      planningBasis: 'DEMAND_FOLLOWING',
      source: 'FIXED',
      defaultPercent: 100,
      startWeek: null,
      endWeek: null,
      legacy: null,
      createdAt: new Date(),
      segments: [],
    },
    {
      id: 'cp-bob',
      projectId: 'proj-1',
      resourceTypeId: null,
      namedResourceId: 'nr-bob',
      ownerKind: 'NAMED_PERSON',
      planningBasis: 'DEMAND_FOLLOWING',
      source: 'FIXED',
      defaultPercent: 100,
      startWeek: null,
      endWeek: null,
      legacy: null,
      createdAt: new Date(),
      segments: [],
    },
  ]
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
    // resolveSchedulerCapacity also queries resourceType and capacityProfile
    vi.mocked(prisma.resourceType.findMany).mockResolvedValueOnce(resourceTypeWithNamedResources() as never)
    vi.mocked(prisma.capacityProfile.findMany).mockResolvedValueOnce(capacityProfileFixture() as never)
    vi.mocked(prisma.timelineEntry.findMany).mockResolvedValueOnce(timelineEntryFixture() as never)

    const res = await request(app)
      .get('/api/projects/proj-1/timeline')
      .set('Authorization', authHeader)

    expect(res.status).toBe(200)

    // Named-resource labels are the current DB values, not stale cached labels.
    // Find by stable ID rather than assuming array ordering.
    const alice = res.body.namedResources.find((nr: { id: string }) => nr.id === 'nr-alice')
    const bob = res.body.namedResources.find((nr: { id: string }) => nr.id === 'nr-bob')
    expect(alice).toBeTruthy()
    expect(bob).toBeTruthy()
    expect(alice.name).toBe('Alice')
    expect(alice.resourceTypeName).toBe('Developer')
    expect(alice.actualAllocatedDays).toBeGreaterThan(0)
    expect(bob.name).toBe('Bob')
    expect(bob.resourceTypeName).toBe('Developer')
    expect(typeof bob.actualAllocatedDays).toBe('number')

    // Entry-level start date is shifted by onboarding weeks:
    // startWeek=0, 1 onboarding week → startDate = Jan 5 + 7 days = Jan 12
    expect(res.body.entries.length).toBe(1)
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
      capacityProfiles: capacityProfileFixture(),
    }

    vi.mocked(prisma.project.findFirst).mockResolvedValueOnce(projectFixture as never)
    // resolveSchedulerCapacity queries (profile-first, issue #418)
    vi.mocked(prisma.resourceType.findMany).mockResolvedValueOnce(resourceTypeWithNamedResources() as never)
    vi.mocked(prisma.capacityProfile.findMany).mockResolvedValueOnce(capacityProfileFixture() as never)
    vi.mocked(prisma.capacityPlan.findFirst).mockResolvedValueOnce(null as never)

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
    // Commercial-relevant fields on the resource row.
    // estimatedCost must be internally consistent with day rate and allocated days.
    expect(devRow.dayRate).toBe(500)
    expect(devRow.estimatedCost).toBeGreaterThan(0)
    expect(devRow.estimatedCost).toBe(devRow.allocatedDays * devRow.dayRate)

    // Summary proves commercial totals are computed from shared facts.
    // totalCost should equal row estimatedCost when there are no overheads.
    expect(res.body.summary.hasCost).toBe(true)
    expect(res.body.summary.totalCost).toBeGreaterThan(0)
    const rowCostSum = res.body.resourceRows.reduce(
      (sum: number, r: { estimatedCost: number | null }) => sum + (r.estimatedCost ?? 0), 0,
    )
    const overheadCostSum = res.body.overheadRows.reduce(
      (sum: number, r: { estimatedCost: number | null }) => sum + (r.estimatedCost ?? 0), 0,
    )
    expect(res.body.summary.totalCost).toBe(rowCostSum + overheadCostSum)
  })
  it('Timeline and Resource Profile agree on actualAllocatedDays for the same NR', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValueOnce(baseProjectFixture() as never)
    vi.mocked(prisma.resourceType.findMany).mockResolvedValueOnce(resourceTypeWithNamedResources() as never)
    vi.mocked(prisma.timelineEntry.findMany).mockResolvedValueOnce(timelineEntryFixture() as never)
    vi.mocked(prisma.storyTimelineEntry.findMany).mockResolvedValueOnce([] as never)
    vi.mocked(prisma.capacityPlan.findFirst).mockResolvedValueOnce(null as never)
    // resolveSchedulerCapacity also queries resourceType and capacityProfile
    vi.mocked(prisma.resourceType.findMany).mockResolvedValueOnce(resourceTypeWithNamedResources() as never)
    vi.mocked(prisma.capacityProfile.findMany).mockResolvedValueOnce(capacityProfileFixture() as never)
    vi.mocked(prisma.timelineEntry.findMany).mockResolvedValueOnce(timelineEntryFixture() as never)

    const timelineRes = await request(app)
      .get('/api/projects/proj-1/timeline')
      .set('Authorization', authHeader)
    expect(timelineRes.status).toBe(200)
    const timelineAlice = timelineRes.body.namedResources.find(
      (nr: { id: string }) => nr.id === 'nr-alice',
    )
    expect(timelineAlice).toBeTruthy()
    const timelineDays: number = timelineAlice.actualAllocatedDays
    expect(timelineDays).toBeGreaterThan(0)

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
      capacityProfiles: capacityProfileFixture(),
    }
    vi.mocked(prisma.project.findFirst).mockResolvedValueOnce(profileFixture as never)
    // resolveSchedulerCapacity queries (profile-first, issue #418)
    vi.mocked(prisma.resourceType.findMany).mockResolvedValueOnce(resourceTypeWithNamedResources() as never)
    vi.mocked(prisma.capacityProfile.findMany).mockResolvedValueOnce(capacityProfileFixture() as never)
    vi.mocked(prisma.capacityPlan.findFirst).mockResolvedValueOnce(null as never)

    const profileRes = await request(app)
      .get('/api/projects/proj-1/resource-profile')
      .set('Authorization', authHeader)
    expect(profileRes.status).toBe(200)

    const devRow = profileRes.body.resourceRows.find(
      (r: { resourceTypeId: string }) => r.resourceTypeId === 'rt-dev',
    )
    const profileAlice = devRow.namedResources.find(
      (nr: { id: string }) => nr.id === 'nr-alice',
    )
    expect(profileAlice).toBeTruthy()
    const profileDays: number = profileAlice.actualAllocatedDays

    expect(profileDays).toBeGreaterThan(0)
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
    // resolveSchedulerCapacity queries (profile-first, issue #418)
    vi.mocked(prisma.resourceType.findMany).mockResolvedValueOnce(resourceTypeWithNamedResources() as never)
    vi.mocked(prisma.capacityProfile.findMany).mockResolvedValueOnce(capacityProfileFixture() as never)
    vi.mocked(prisma.capacityPlan.findFirst).mockResolvedValueOnce(null as never)

    const res = await request(app)
      .get('/api/projects/proj-1/timeline/export/csv')
      .set('Authorization', authHeader)
    expect(res.status).toBe(200)
    const csv: string = res.text

    // Split CSV into sections by blank-line delimiters
    const sections = csv.split('\n\n')
    expect(sections.length).toBeGreaterThanOrEqual(3)

    // Section 3 is the Named Resources section. Find the Alice row by content.
    const nrSection = sections[2]
    const nrRows = nrSection.split('\n').filter((r: string) => r.length > 0)
    const aliceRow = nrRows.find((r: string) => r.startsWith('Alice,'))
    expect(aliceRow).toBeTruthy()
    expect(aliceRow).toBe('Alice,Developer,T&M,100,,')

    // Section 2 is the Resource Demand section: ResourceType,Week,DemandDays,CapacityDays,Status
    const demandSection = sections[1]
    expect(demandSection).toContain('Developer,0,5,')
  })
})
