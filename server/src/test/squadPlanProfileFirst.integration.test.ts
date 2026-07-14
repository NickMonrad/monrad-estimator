/**
 * squadPlanProfileFirst.integration.test.ts — Real PostgreSQL integration tests
 * for issue #359 profile-first Squad Planner apply behaviour.
 *
 * Tests the authenticated POST /api/projects/:id/squad-plan/apply endpoint
 * against the actual schema, asserting database state directly for:
 *
 *   - Activated apply writes one ROLE profile per affected resource type with
 *     exact aggregate segments and planningBasis=CAPACITY_PROFILE, source=SQUAD_PLANNER.
 *   - One PLANNED_RESOURCE profile per materialised trajectory, each with
 *     a stable named-resource identity.
 *   - Equivalent reapply preserves named-resource IDs and does not duplicate
 *     profiles or segments (idempotent).
 *   - Shrink reapply clears surplus planner capacity by replacing the surplus
 *     profile with a zero-capacity / inactive representation.
 *   - Explicit NAMED_PERSON / MANUAL / FIXED profile conflict returns 409
 *     before the pre-apply snapshot or any capacity writes, leaving state
 *     unchanged.
 *   - setActive:false saves the plan only and does not mutate any capacity
 *     profiles, resource types, or named resources.
 *
 * All tests are skipped unless INTEGRATION_TEST=true.  Follows the same
 * isolation and cleanup pattern as snapshotRollback.integration.test.ts and
 * projects.clone.integration.test.ts.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '@prisma/client'
import type { $Enums } from '@prisma/client'
import { app } from '../app.js'
import { getWeeklyCapacity } from '../lib/scheduler.js'
import {
  writePlannerProfiles,
  __setApplyFailureSeam,
  type RoleProfileWriteSet,
} from '../lib/squadPlannerProfileWriter.js'
// Override the global prisma mock so route handlers use real PostgreSQL.
vi.mock('../lib/prisma.js', async (importOriginal) => {
  return await importOriginal()
})

// ─── Guard ──────────────────────────────────────────────────────────────────

const runIntegration = process.env.INTEGRATION_TEST === 'true'
const describeIf = runIntegration ? describe : describe.skip

// ─── Shared state ───────────────────────────────────────────────────────────

let prisma: PrismaClient
let userId: string
let token: string
let authHeader: string

beforeAll(async () => {
  if (!runIntegration) return
  prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
  })
  await prisma.$connect()

  const user = await prisma.user.create({
    data: {
      email: `squadplan-profile-first-${Date.now()}@example.com`,
      name: 'Squad Plan Profile First Integration Test',
      password: '$2b$10$placeholder',
    },
  })
  userId = user.id
  token = jwt.sign({ userId, role: 'USER' }, process.env.JWT_SECRET!)
  authHeader = `Bearer ${token}`
})

afterAll(async () => {
  if (!runIntegration) return

  // Cascade cleanup: delete everything owned by test user in dependency-safe order
  await prisma.backlogSnapshot.deleteMany({ where: { project: { ownerId: userId } } })
  await prisma.capacitySegment.deleteMany({
    where: { capacityProfile: { project: { ownerId: userId } } },
  })
  await prisma.capacityProfile.deleteMany({ where: { project: { ownerId: userId } } })
  await prisma.capacityPlanEntry.deleteMany({
    where: { period: { plan: { project: { ownerId: userId } } } },
  })
  await prisma.capacityPlanPeriod.deleteMany({
    where: { plan: { project: { ownerId: userId } } },
  })
  await prisma.capacityPlan.deleteMany({ where: { project: { ownerId: userId } } })
  await prisma.projectDiscount.deleteMany({ where: { project: { ownerId: userId } } })
  await prisma.projectOverhead.deleteMany({ where: { project: { ownerId: userId } } })
  await prisma.storyTimelineEntry.deleteMany({ where: { project: { ownerId: userId } } })
  await prisma.timelineEntry.deleteMany({ where: { project: { ownerId: userId } } })
  await prisma.epicDependency.deleteMany({ where: { epic: { project: { ownerId: userId } } } })
  await prisma.featureDependency.deleteMany({
    where: { feature: { epic: { project: { ownerId: userId } } } },
  })
  await prisma.storyDependency.deleteMany({
    where: { story: { feature: { epic: { project: { ownerId: userId } } } } },
  })
  await prisma.task.deleteMany({
    where: { userStory: { feature: { epic: { project: { ownerId: userId } } } } },
  })
  await prisma.userStory.deleteMany({
    where: { feature: { epic: { project: { ownerId: userId } } } },
  })
  await prisma.feature.deleteMany({ where: { epic: { project: { ownerId: userId } } } })
  await prisma.epic.deleteMany({ where: { project: { ownerId: userId } } })
  await prisma.namedResource.deleteMany({
    where: { resourceType: { project: { ownerId: userId } } },
  })
  await prisma.resourceType.deleteMany({ where: { project: { ownerId: userId } } })
  await prisma.project.deleteMany({ where: { ownerId: userId } })
  await prisma.user.delete({ where: { id: userId } })
  await prisma.$disconnect()
})

// ─── Fixture helpers ────────────────────────────────────────────────────────

async function createProject(): Promise<string> {
  const project = await prisma.project.create({
    data: { name: `SquadPlan-Profile-First-${Date.now()}`, ownerId: userId },
  })
  return project.id
}

async function createResourceType(
  projectId: string,
  id: string,
  name: string,
  overrides: Partial<{
    category: $Enums.ResourceCategory
    count: number
    allocationMode: $Enums.AllocationMode
  }> = {},
): Promise<string> {
  await prisma.resourceType.create({
    data: {
      id,
      name,
      projectId,
      category: overrides.category ?? 'ENGINEERING',
      count: overrides.count ?? 2,
      allocationMode: overrides.allocationMode ?? 'TIMELINE',
    },
  })
  return id
}

async function createEpicBacklog(
  projectId: string,
  rtId: string,
): Promise<{ epicId: string; featureId: string; storyId: string }> {
  const epic = await prisma.epic.create({
    data: { name: 'Profile First Test Epic', projectId, order: 0 },
  })
  const feature = await prisma.feature.create({
    data: { name: 'Profile First Test Feature', epicId: epic.id, order: 0 },
  })
  const story = await prisma.userStory.create({
    data: { name: 'Profile First Test Story', featureId: feature.id, order: 0 },
  })
  await prisma.task.create({
    data: {
      name: 'Profile First Test Task',
      userStoryId: story.id,
      order: 0,
      hoursEffort: 8,
      resourceTypeId: rtId,
    },
  })
  return { epicId: epic.id, featureId: feature.id, storyId: story.id }
}

async function createNamedResource(
  _projectId: string,
  resourceTypeId: string,
  id: string,
  name: string,
  overrides: Partial<{
    startWeek: number | null
    endWeek: number | null
    allocationPercent: number
    allocationMode: $Enums.AllocationMode
  }> = {},
): Promise<string> {
  await prisma.namedResource.create({
    data: {
      id,
      resourceTypeId,
      name,
      startWeek: overrides.startWeek ?? null,
      endWeek: overrides.endWeek ?? null,
      allocationPercent: overrides.allocationPercent ?? 100,
      allocationMode: overrides.allocationMode ?? 'EFFORT',
    },
  })
  return id
}

async function createProfile(
  projectId: string,
  id: string,
  ownerKind: $Enums.CapacityProfileOwnerKind,
  resourceTypeId: string | null,
  namedResourceId: string | null,
  overrides: Partial<{
    planningBasis: $Enums.CapacityProfilePlanningBasis
    source: $Enums.CapacityProfileSource
    defaultPercent: number | null
    startWeek: number | null
    endWeek: number | null
  }> = {},
): Promise<string> {
  await prisma.capacityProfile.create({
    data: {
      id,
      projectId,
      ownerKind,
      resourceTypeId,
      namedResourceId,
      planningBasis: overrides.planningBasis ?? 'DEMAND_FOLLOWING',
      source: overrides.source ?? 'MANUAL',
      defaultPercent: overrides.defaultPercent ?? null,
      startWeek: overrides.startWeek ?? null,
      endWeek: overrides.endWeek ?? null,
    },
  })
  return id
}

/**
 * Build a standard /squad-plan/apply request body for a single resource type.
 */
function buildApplyPayload(
  rtId: string,
  periods: Array<{ periodIndex: number; startWeek: number; endWeek: number; headcount: number }>,
  overrides: Partial<{
    name: string
    targetWeeks: number
    periodWeeks: number
    maxDelta: number
    setActive: boolean
    totalCost: number
    deliveryWeeks: number
  }> = {},
) {
  return {
    name: overrides.name ?? 'Profile First Test Plan',
    targetWeeks: overrides.targetWeeks ?? 12,
    periodWeeks: overrides.periodWeeks ?? 4,
    maxDelta: overrides.maxDelta ?? 1,
    setActive: overrides.setActive ?? true,
    totalCost: overrides.totalCost,
    deliveryWeeks: overrides.deliveryWeeks,
    periods: periods.map(p => ({
      periodIndex: p.periodIndex,
      startWeek: p.startWeek,
      endWeek: p.endWeek,
      entries: [{
        resourceTypeId: rtId,
        headcount: p.headcount,
        demandFTE: p.headcount * 0.5,
        utilisationPct: 50,
      }],
    })),
  }
}

// ─── Query helpers ───────────────────────────────────────────────────────────

interface ProfileRow {
  id: string
  ownerKind: string
  resourceTypeId: string | null
  namedResourceId: string | null
  planningBasis: string
  source: string
  defaultPercent: number | null
  startWeek: number | null
  endWeek: number | null
}

interface SegmentRow {
  id: string
  capacityProfileId: string
  startWeek: number
  endWeek: number
  capacityPercent: number
  source: string
}

async function fetchProfiles(projectId: string): Promise<ProfileRow[]> {
  return prisma.capacityProfile.findMany({
    where: { projectId },
    orderBy: [{ ownerKind: 'asc' }, { id: 'asc' }],
  }) as unknown as ProfileRow[]
}

async function fetchSegments(profileId: string): Promise<SegmentRow[]> {
  return prisma.capacitySegment.findMany({
    where: { capacityProfileId: profileId },
    orderBy: { startWeek: 'asc' },
  }) as unknown as SegmentRow[]
}

async function fetchActivePlanId(projectId: string): Promise<string | null> {
  const plan = await prisma.capacityPlan.findFirst({
    where: { projectId, isActive: true },
  })
  return plan?.id ?? null
}

// ═════════════════════════════════════════════════════════════════════════════
// Scenario 1 — Activated apply writes ROLE + PLANNED_RESOURCE profiles
// ═════════════════════════════════════════════════════════════════════════════

describeIf('Scenario 1 — Activated apply writes ROLE and PLANNED_RESOURCE profiles', () => {
  let projectId: string
  let rtId: string

  beforeAll(async () => {
    if (!runIntegration) return
    projectId = await createProject()
    rtId = await createResourceType(projectId, 'rt-eng-s1', 'Engineer')
    await createEpicBacklog(projectId, rtId)

    // Apply a plan with fractional, changing headcount: 1.5 then 0.5
    const applyRes = await request(app)
      .post(`/api/projects/${projectId}/squad-plan/apply`)
      .set('Authorization', authHeader)
      .send(buildApplyPayload(rtId, [
        { periodIndex: 0, startWeek: 0, endWeek: 8, headcount: 1.5 },
        { periodIndex: 1, startWeek: 8, endWeek: 12, headcount: 0.5 },
      ]))

    expect(applyRes.status).toBe(201)
  })

  it('creates exactly one ROLE profile for the affected resource type', async () => {
    const profiles = await fetchProfiles(projectId)
    const roleProfiles = profiles.filter(p => p.ownerKind === 'ROLE')
    expect(roleProfiles).toHaveLength(1)
    const rp = roleProfiles[0]
    expect(rp.resourceTypeId).toBe(rtId)
    expect(rp.namedResourceId).toBeNull()
  })

  it('creates at least one PLANNED_RESOURCE profile per trajectory with persisted owner shape', async () => {
    const profiles = await fetchProfiles(projectId)
    const prProfiles = profiles.filter(p => p.ownerKind === 'PLANNED_RESOURCE')
    expect(prProfiles).toHaveLength(2)
    prProfiles.forEach(p => {
      expect(p.resourceTypeId).toBeNull()
      expect(p.namedResourceId).not.toBeNull()
      expect(p.planningBasis).toBe('CAPACITY_PROFILE')
      expect(p.source).toBe('SQUAD_PLANNER')
    })
  })

  it('writes exact role and trajectory segments', async () => {
    const profiles = await fetchProfiles(projectId)
    const roleProfile = profiles.find(p => p.ownerKind === 'ROLE')
    expect(roleProfile).toBeDefined()
    expect(await fetchSegments(roleProfile!.id)).toEqual([
      expect.objectContaining({ startWeek: 0, endWeek: 7, capacityPercent: 150, source: 'SQUAD_PLANNER' }),
      expect.objectContaining({ startWeek: 8, endWeek: 11, capacityPercent: 50, source: 'SQUAD_PLANNER' }),
    ])

    const prProfiles = profiles
      .filter(p => p.ownerKind === 'PLANNED_RESOURCE')
      .sort((a, b) => (a.namedResourceId ?? '').localeCompare(b.namedResourceId ?? ''))
    expect(await fetchSegments(prProfiles[0].id)).toEqual([
      expect.objectContaining({ startWeek: 0, endWeek: 7, capacityPercent: 100, source: 'SQUAD_PLANNER' }),
      expect.objectContaining({ startWeek: 8, endWeek: 11, capacityPercent: 50, source: 'SQUAD_PLANNER' }),
    ])
    expect(await fetchSegments(prProfiles[1].id)).toEqual([
      expect.objectContaining({ startWeek: 0, endWeek: 7, capacityPercent: 50, source: 'SQUAD_PLANNER' }),
    ])
  })

  it('keeps resource-profile and timeline allocation fields in parity', async () => {
    const [resourceProfileRes, timelineRes] = await Promise.all([
      request(app)
        .get(`/api/projects/${projectId}/resource-profile`)
        .set('Authorization', authHeader),
      request(app)
        .get(`/api/projects/${projectId}/timeline`)
        .set('Authorization', authHeader),
    ])
    expect(resourceProfileRes.status).toBe(200)
    expect(timelineRes.status).toBe(200)

    const resourceRow = resourceProfileRes.body.resourceRows.find(
      (row: { resourceTypeId: string }) => row.resourceTypeId === rtId,
    )
    const profileResource = resourceRow.namedResources[0]
    const timelineResource = timelineRes.body.namedResources.find(
      (resource: { id: string }) => resource.id === profileResource.id,
    )
    expect(timelineResource).toBeDefined()
    for (const field of [
      'allocationMode',
      'allocationPercent',
      'allocationPct',
      'allocationStartWeek',
      'allocationEndWeek',
      'startWeek',
      'endWeek',
    ]) {
      expect(timelineResource[field]).toBe(profileResource[field])
    }
  })

  it('writes non-empty segments on the ROLE profile', async () => {
    const profiles = await fetchProfiles(projectId)
    const roleProfile = profiles.find(p => p.ownerKind === 'ROLE')
    expect(roleProfile).toBeDefined()
    const segments = await fetchSegments(roleProfile!.id)
    expect(segments.length).toBeGreaterThan(0)
    // Segments should not bridge zero-capacity periods (discontinuity preserved)
    // Exact segment content is asserted above.
  })

  it('writes segments on each PLANNED_RESOURCE profile', async () => {
    const profiles = await fetchProfiles(projectId)
    const prProfiles = profiles.filter(p => p.ownerKind === 'PLANNED_RESOURCE')
    for (const p of prProfiles) {
      const segments = await fetchSegments(p.id)
      expect(segments.length).toBeGreaterThan(0)
    }
  })

  it('sets the capacity plan as active', async () => {
    const activePlanId = await fetchActivePlanId(projectId)
    expect(activePlanId).not.toBeNull()
  })

  it('derives profile startWeek and endWeek from segments', async () => {
    const profiles = await fetchProfiles(projectId)
    const roleProfile = profiles.find(p => p.ownerKind === 'ROLE')
    expect(roleProfile).toBeDefined()
    expect(roleProfile!.startWeek).not.toBeNull()
    expect(roleProfile!.endWeek).not.toBeNull()
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// Scenario 2 — Equivalent reapply is idempotent (stable IDs, no duplicates)
// ═════════════════════════════════════════════════════════════════════════════

describeIf('Scenario 2 — Equivalent reapply is idempotent', () => {
  let projectId: string
  let rtId: string
  let firstNrs: string[]
  let firstSegmentCount: number

  beforeAll(async () => {
    if (!runIntegration) return
    projectId = await createProject()
    rtId = await createResourceType(projectId, 'rt-eng-s2', 'Engineer')
    await createEpicBacklog(projectId, rtId)

    // First apply: 2 headcount steady
    const res1 = await request(app)
      .post(`/api/projects/${projectId}/squad-plan/apply`)
      .set('Authorization', authHeader)
      .send(buildApplyPayload(rtId, [
        { periodIndex: 0, startWeek: 0, endWeek: 12, headcount: 2 },
      ], { name: 'Apply A', setActive: true }))
    expect(res1.status).toBe(201)

    // Snapshot state after first apply
    firstNrs = (await prisma.namedResource.findMany({
      where: { resourceType: { projectId } },
      orderBy: { id: 'asc' },
    })).map(nr => nr.id)

    const profiles1 = await fetchProfiles(projectId)
    const allSegments = await Promise.all(profiles1.map(p => fetchSegments(p.id)))
    firstSegmentCount = allSegments.flat().length

    // Second apply: same headcount
    const res2 = await request(app)
      .post(`/api/projects/${projectId}/squad-plan/apply`)
      .set('Authorization', authHeader)
      .send(buildApplyPayload(rtId, [
        { periodIndex: 0, startWeek: 0, endWeek: 12, headcount: 2 },
      ], { name: 'Apply B', setActive: true }))
    expect(res2.status).toBe(201)
  })

  it('preserves named-resource IDs across reapplies', async () => {
    const nrsAfter = (await prisma.namedResource.findMany({
      where: { resourceType: { projectId } },
      orderBy: { id: 'asc' },
    })).map(nr => nr.id)
    expect(nrsAfter).toEqual(firstNrs)
  })

  it('preserves profile count (no duplicates) after reapply', async () => {
    const profiles = await fetchProfiles(projectId)
    const roleProfiles = profiles.filter(p => p.ownerKind === 'ROLE')
    const prProfiles = profiles.filter(p => p.ownerKind === 'PLANNED_RESOURCE')
    expect(roleProfiles).toHaveLength(1)
    expect(prProfiles.length).toBeGreaterThanOrEqual(1)
  })

  it('preserves total segment count after reapply', async () => {
    const profiles = await fetchProfiles(projectId)
    const allSegments = await Promise.all(profiles.map(p => fetchSegments(p.id)))
    const segmentCount2 = allSegments.flat().length
    expect(segmentCount2).toBe(firstSegmentCount)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// Scenario 3 — Shrink clears surplus planner capacity
// ═════════════════════════════════════════════════════════════════════════════

describeIf('Scenario 3 — Shrink clears surplus planner capacity', () => {
  let projectId: string
  let rtId: string

  beforeAll(async () => {
    if (!runIntegration) return
    projectId = await createProject()
    rtId = await createResourceType(projectId, 'rt-eng-s3', 'Engineer')
    await createEpicBacklog(projectId, rtId)

    // Apply with 2 headcount → 2 trajectories
    const res1 = await request(app)
      .post(`/api/projects/${projectId}/squad-plan/apply`)
      .set('Authorization', authHeader)
      .send(buildApplyPayload(rtId, [
        { periodIndex: 0, startWeek: 0, endWeek: 12, headcount: 2 },
      ], { name: 'Pre-shrink', setActive: true }))
    expect(res1.status).toBe(201)

    // Re-apply with 1 headcount → 1 trajectory (surplus planner resource exists)
    const res2 = await request(app)
      .post(`/api/projects/${projectId}/squad-plan/apply`)
      .set('Authorization', authHeader)
      .send(buildApplyPayload(rtId, [
        { periodIndex: 0, startWeek: 0, endWeek: 12, headcount: 1 },
      ], { name: 'Post-shrink', setActive: true }))
    expect(res2.status).toBe(201)
  })

  it('writes exactly one active trajectory and one zero-capacity surplus profile', async () => {
    const profiles = await fetchProfiles(projectId)
    const prProfiles = profiles.filter(p => p.ownerKind === 'PLANNED_RESOURCE')
    expect(prProfiles).toHaveLength(2)

    const surplusProfile = prProfiles.find(p => p.defaultPercent === 0)
    expect(surplusProfile).toBeDefined()
    expect(surplusProfile!.resourceTypeId).toBeNull()
    expect(surplusProfile!.namedResourceId).not.toBeNull()
    expect(surplusProfile!.planningBasis).toBe('CAPACITY_PROFILE')
    expect(surplusProfile!.source).toBe('SQUAD_PLANNER')
    expect(surplusProfile!.startWeek).toBeNull()
    expect(surplusProfile!.endWeek).toBeNull()
    expect(await fetchSegments(surplusProfile!.id)).toHaveLength(0)
  })

  it('does not delete the surplus named resource entity', async () => {
    const nrs = await prisma.namedResource.findMany({
      where: { resourceType: { projectId } },
      orderBy: { name: 'asc' },
    })
    expect(nrs).toHaveLength(2)
  })

  it('zeroes every named-resource compatibility alias and production capacity', async () => {
    const profiles = await fetchProfiles(projectId)
    const surplusProfile = profiles.find(
      p => p.ownerKind === 'PLANNED_RESOURCE' && p.defaultPercent === 0,
    )
    expect(surplusProfile?.namedResourceId).toBeDefined()

    const surplus = await prisma.namedResource.findUnique({
      where: { id: surplusProfile!.namedResourceId! },
    })
    expect(surplus).toMatchObject({
      allocationMode: 'CAPACITY_PLAN',
      allocationPercent: 0,
      allocationPct: 0,
      allocationStartWeek: null,
      allocationEndWeek: null,
      startWeek: null,
      endWeek: null,
    })

    const resourceProfileRes = await request(app)
      .get(`/api/projects/${projectId}/resource-profile`)
      .set('Authorization', authHeader)
    expect(resourceProfileRes.status).toBe(200)
    const resourceRow = resourceProfileRes.body.resourceRows.find(
      (row: { resourceTypeId: string }) => row.resourceTypeId === rtId,
    )
    const projectedSurplus = resourceRow.namedResources.find(
      (resource: { id: string }) => resource.id === surplus!.id,
    )
    expect(projectedSurplus).toMatchObject({
      allocationMode: 'CAPACITY_PLAN',
      allocationPercent: 0,
      allocationPct: 0,
    })
    expect(projectedSurplus.actualAllocatedDays).toBe(0)

    expect(getWeeklyCapacity({
      id: rtId,
      name: 'Engineer',
      count: 1,
      hoursPerDay: 8,
      namedResources: [{
        id: surplus!.id,
        name: surplus!.name,
        startWeek: surplus!.startWeek,
        endWeek: surplus!.endWeek,
        allocationPct: surplus!.allocationPct,
        allocationMode: surplus!.allocationMode,
        allocationPercent: surplus!.allocationPercent,
        allocationStartWeek: surplus!.allocationStartWeek,
        allocationEndWeek: surplus!.allocationEndWeek,
      }],
    }, 0, 8)).toBe(0)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// Scenario 4 — setActive:false saves plan only, no profile mutation
// ═════════════════════════════════════════════════════════════════════════════

describeIf('Scenario 4 — setActive:false does not mutate capacity profiles', () => {
  let projectId: string
  let rtId: string

  beforeAll(async () => {
    if (!runIntegration) return
    projectId = await createProject()
    rtId = await createResourceType(projectId, 'rt-eng-s4', 'Engineer')
    await createEpicBacklog(projectId, rtId)

    const res = await request(app)
      .post(`/api/projects/${projectId}/squad-plan/apply`)
      .set('Authorization', authHeader)
      .send(buildApplyPayload(rtId, [
        { periodIndex: 0, startWeek: 0, endWeek: 8, headcount: 2 },
      ], { setActive: false }))
    expect(res.status).toBe(201)
  })
  it('does not create a pre-apply snapshot', async () => {
    const snapshots = await prisma.backlogSnapshot.findMany({ where: { projectId } })
    expect(snapshots).toHaveLength(0)
  })

  it('saves a capacity plan with isActive=false', async () => {
    const plan = await prisma.capacityPlan.findFirst({
      where: { projectId },
      orderBy: { createdAt: 'desc' },
    })
    expect(plan).not.toBeNull()
    expect(plan!.isActive).toBe(false)
  })

  it('does not create any capacity profiles', async () => {
    const profiles = await fetchProfiles(projectId)
    expect(profiles).toHaveLength(0)
  })

  it('does not modify resource type allocation mode', async () => {
    const rt = await prisma.resourceType.findUnique({ where: { id: rtId } })
    expect(rt!.allocationMode).toBe('TIMELINE')
  })

  it('does not create named resources', async () => {
    const nrs = await prisma.namedResource.findMany({
      where: { resourceType: { projectId } },
    })
    expect(nrs).toHaveLength(0)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// Scenario 5 — Explicit NAMED_PERSON conflict returns 409
// ═════════════════════════════════════════════════════════════════════════════

describeIf('Scenario 5 — Explicit NAMED_PERSON conflict returns 409 before snapshot', () => {
  let projectId: string
  let rtId: string

  beforeAll(async () => {
    if (!runIntegration) return
    projectId = await createProject()
    rtId = await createResourceType(projectId, 'rt-eng-s5', 'Engineer')
    await createEpicBacklog(projectId, rtId)

    // Create a named resource with an explicit NAMED_PERSON profile
    await createNamedResource(projectId, rtId, 'nr-alice', 'Alice')
    await createProfile(
      projectId,
      'cp-alice',
      'NAMED_PERSON',
      null,
      'nr-alice',
      { planningBasis: 'CAPACITY_PROFILE', source: 'MANUAL' },
    )
  })

  it('returns 409 when a NAMED_PERSON profile conflicts with planner scope', async () => {
    const res = await request(app)
      .post(`/api/projects/${projectId}/squad-plan/apply`)
      .set('Authorization', authHeader)
      .send(buildApplyPayload(rtId, [
        { periodIndex: 0, startWeek: 0, endWeek: 8, headcount: 2 },
      ], { setActive: true }))

    expect(res.status).toBe(409)
    // Response should include a descriptive error
    expect(res.body.error ?? res.body.message).toBeDefined()
  })

  it('does not create a pre-apply snapshot on conflict', async () => {
    const snapshots = await prisma.backlogSnapshot.findMany({
      where: { project: { id: projectId } },
    })
    expect(snapshots).toHaveLength(0)
  })

  it('leaves existing profiles unchanged', async () => {
    const profiles = await fetchProfiles(projectId)
    expect(profiles).toHaveLength(1)
    expect(profiles[0].id).toBe('cp-alice')
    expect(profiles[0].ownerKind).toBe('NAMED_PERSON')
  })

  it('does not activate any capacity plan', async () => {
    const activePlanId = await fetchActivePlanId(projectId)
    expect(activePlanId).toBeNull()
  })

  it('does not change resource type allocation mode', async () => {
    const rt = await prisma.resourceType.findUnique({ where: { id: rtId } })
    expect(rt!.allocationMode).toBe('TIMELINE')
  })

  it('does not create additional named resources', async () => {
    const nrs = await prisma.namedResource.findMany({
      where: { resourceType: { projectId } },
    })
    expect(nrs).toHaveLength(1)
    expect(nrs[0].id).toBe('nr-alice')
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// Scenario 6 — Evidence-based adoption of legacy planner profiles
// ═════════════════════════════════════════════════════════════════════════════

describeIf('Scenario 6 — Legacy planner profiles are adopted only with all markers', () => {
  let projectId: string
  let rtId: string

  beforeAll(async () => {
    if (!runIntegration) return
    projectId = await createProject()
    rtId = await createResourceType(projectId, 'rt-eng-s6', 'Engineer')
    await createEpicBacklog(projectId, rtId)
    await createNamedResource(projectId, rtId, 'nr-legacy', 'Engineer 1', {
      allocationMode: 'CAPACITY_PLAN',
    })
    await createProfile(
      projectId,
      'cp-legacy',
      'NAMED_PERSON',
      null,
      'nr-legacy',
      { planningBasis: 'CAPACITY_PROFILE', source: 'SQUAD_PLANNER' },
    )

    const res = await request(app)
      .post(`/api/projects/${projectId}/squad-plan/apply`)
      .set('Authorization', authHeader)
      .send(buildApplyPayload(rtId, [
        { periodIndex: 0, startWeek: 0, endWeek: 8, headcount: 1 },
      ]))
    expect(res.status).toBe(201)
  })

  it('reuses the legacy profile and converts it to the persisted owner shape', async () => {
    const profiles = await fetchProfiles(projectId)
    const planned = profiles.filter(p => p.ownerKind === 'PLANNED_RESOURCE')
    expect(planned).toHaveLength(1)
    expect(planned[0]).toMatchObject({
      id: 'cp-legacy',
      resourceTypeId: null,
      namedResourceId: 'nr-legacy',
      planningBasis: 'CAPACITY_PROFILE',
      source: 'SQUAD_PLANNER',
    })
    expect(profiles.some(p => p.ownerKind === 'NAMED_PERSON')).toBe(false)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// Scenario 7 — Omitted roles are cleared without touching explicit profiles
// ═════════════════════════════════════════════════════════════════════════════

describeIf('Scenario 7 — Omitted planner roles lose capacity on replacement', () => {
  let projectId: string
  let firstRtId: string
  let omittedRtId: string

  beforeAll(async () => {
    if (!runIntegration) return
    projectId = await createProject()
    firstRtId = await createResourceType(projectId, 'rt-eng-s7', 'Engineer')
    omittedRtId = await createResourceType(projectId, 'rt-qa-s7', 'QA')
    await createEpicBacklog(projectId, firstRtId)

    const first = await request(app)
      .post(`/api/projects/${projectId}/squad-plan/apply`)
      .set('Authorization', authHeader)
      .send({
        ...buildApplyPayload(firstRtId, [
          { periodIndex: 0, startWeek: 0, endWeek: 8, headcount: 1 },
        ]),
        periods: [{
          periodIndex: 0,
          startWeek: 0,
          endWeek: 8,
          entries: [
            { resourceTypeId: firstRtId, headcount: 1, demandFTE: 0.5, utilisationPct: 50 },
            { resourceTypeId: omittedRtId, headcount: 1, demandFTE: 0.5, utilisationPct: 50 },
          ],
        }],
      })
    expect(first.status).toBe(201)

    const second = await request(app)
      .post(`/api/projects/${projectId}/squad-plan/apply`)
      .set('Authorization', authHeader)
      .send(buildApplyPayload(firstRtId, [
        { periodIndex: 0, startWeek: 0, endWeek: 8, headcount: 1 },
      ]))
    expect(second.status).toBe(201)
  })

  it('keeps omitted role and planned-resource profiles with zero capacity', async () => {
    const profiles = await fetchProfiles(projectId)
    const omittedRole = profiles.find(
      p => p.ownerKind === 'ROLE' && p.resourceTypeId === omittedRtId,
    )
    expect(omittedRole).toMatchObject({
      defaultPercent: 0,
      startWeek: null,
      endWeek: null,
      planningBasis: 'CAPACITY_PROFILE',
      source: 'SQUAD_PLANNER',
    })
    expect(await fetchSegments(omittedRole!.id)).toHaveLength(0)

    const omittedResourceType = await prisma.resourceType.findUnique({
      where: { id: omittedRtId },
    })
    expect(omittedResourceType).toMatchObject({
      count: 0,
      allocationMode: 'CAPACITY_PLAN',
      allocationPercent: 0,
      allocationStartWeek: null,
      allocationEndWeek: null,
    })

    const omittedNamedResources = await prisma.namedResource.findMany({
      where: { resourceTypeId: omittedRtId },
    })
    expect(omittedNamedResources).toHaveLength(1)
    expect(omittedNamedResources[0]).toMatchObject({
      allocationMode: 'CAPACITY_PLAN',
      allocationPercent: 0,
      allocationPct: 0,
      allocationStartWeek: null,
      allocationEndWeek: null,
      startWeek: null,
      endWeek: null,
    })
    const omittedProfile = profiles.find(
      p => p.ownerKind === 'PLANNED_RESOURCE'
        && p.namedResourceId === omittedNamedResources[0].id,
    )
    expect(omittedProfile).toMatchObject({ defaultPercent: 0, startWeek: null, endWeek: null })
    expect(await fetchSegments(omittedProfile!.id)).toHaveLength(0)
    expect(getWeeklyCapacity({
      id: omittedRtId,
      name: 'QA',
      count: 0,
      hoursPerDay: 8,
      namedResources: omittedNamedResources.map(nr => ({
        ...nr,
        allocationPct: nr.allocationPct,
      })),
    }, 0, 8)).toBe(0)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// Scenario 8 — Capacity writes roll back atomically on a failure seam
// ═════════════════════════════════════════════════════════════════════════════

describeIf('Scenario 8 — Profile writes roll back atomically', () => {
  it('does not leak profile or segment rows when the transaction fails', async () => {
    if (!runIntegration) return
    const projectId = await createProject()
    const rtId = await createResourceType(projectId, 'rt-eng-s8', 'Engineer')
    const roleProfile: RoleProfileWriteSet = {
      resourceTypeId: rtId,
      defaultPercent: 100,
      startWeek: 0,
      endWeek: 7,
      segments: [{ startWeek: 0, endWeek: 7, capacityPercent: 100 }],
    }

    await expect(prisma.$transaction(async tx => {
      await writePlannerProfiles(tx, projectId, [roleProfile], [], [])
      throw new Error('injected capacity write failure')
    })).rejects.toThrow('injected capacity write failure')

    expect(await fetchProfiles(projectId)).toHaveLength(0)
    expect(await prisma.capacitySegment.count({
      where: { capacityProfile: { projectId } },
    })).toBe(0)
    expect(await prisma.resourceType.findUnique({ where: { id: rtId } }))
      .toMatchObject({ allocationMode: 'TIMELINE' })
  })

  it('applies atomic rollback when the __applyFailureSeam fires inside the route transaction', async () => {
    if (!runIntegration) return
    const projectId = await createProject()
    const rtId = await createResourceType(projectId, 'rt-eng-s8b', 'Engineer')
    await createEpicBacklog(projectId, rtId)

    // Inject the failure seam — it fires after profile, timeline, and cache
    // writes inside the route transaction.
    __setApplyFailureSeam(() => { throw new Error('route seam failure') })

    try {
      const res = await request(app)
        .post(`/api/projects/${projectId}/squad-plan/apply`)
        .set('Authorization', authHeader)
        .send(buildApplyPayload(rtId, [
          { periodIndex: 0, startWeek: 0, endWeek: 8, headcount: 1 },
        ], { name: 'Seam Test' }))

      // Should fail with 500 (uncaught transaction error → asyncHandler → 500)
      expect(res.status).toBe(500)
    } finally {
      // Always clean up the seam
      __setApplyFailureSeam(null)
    }

    // No profiles or segments should have leaked
    expect(await fetchProfiles(projectId)).toHaveLength(0)
    expect(await prisma.capacitySegment.count({
      where: { capacityProfile: { projectId } },
    })).toBe(0)

    // Resource type should still have its original allocation mode
    const rt = await prisma.resourceType.findUnique({ where: { id: rtId } })
    expect(rt).toMatchObject({ allocationMode: 'TIMELINE' })

    // Snapshot was created before the transaction — it exists but the plan does not
    const snapshots = await prisma.backlogSnapshot.findMany({ where: { projectId } })
    expect(snapshots.length).toBeGreaterThanOrEqual(1)

    // No active capacity plan
    const activePlanId = await fetchActivePlanId(projectId)
    expect(activePlanId).toBeNull()
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// Scenario 9 — Pre-#359 legacy role A/B omission scenario
// ═════════════════════════════════════════════════════════════════════════════
// Simulates a pre-#359 state where both role A and role B have only legacy
// compatibility markers and NAMED_PERSON planner profiles (no ROLE profile
// rows). A new plan covering only role A should create A's role profile,
// clear B's legacy capacity, and preserve explicit named-person metadata on B.
//
// The pre-apply snapshot is created outside the transaction. If the apply
// transaction rolls back (failure seam), the snapshot survives but represents
// the correct pre-apply state — no orphan results.

describeIf('Scenario 9 — Pre-#359 legacy role A/B omission', () => {
  let projectId: string
  let rtA: string
  let rtB: string
  let nrA: string
  let nrB: string
  let nrExplicitB: string

  beforeAll(async () => {
    if (!runIntegration) return
    projectId = await createProject()
    rtA = await createResourceType(projectId, 'rt-legacy-a', 'Engineer', { allocationMode: 'CAPACITY_PLAN' })
    rtB = await createResourceType(projectId, 'rt-legacy-b', 'QA', { allocationMode: 'CAPACITY_PLAN' })
    await prisma.resourceType.update({
      where: { id: rtA },
      data: { allocationPercent: 100, allocationStartWeek: 0, allocationEndWeek: 8 },
    })
    await prisma.resourceType.update({
      where: { id: rtB },
      data: { allocationPercent: 100, allocationStartWeek: 0, allocationEndWeek: 8 },
    })

    // Create backlog so planner has work to schedule
    await createEpicBacklog(projectId, rtA)

    // Create named resources with CAPACITY_PLAN (legacy evidence)
    nrA = await createNamedResource(projectId, rtA, 'nr-legacy-a-1', 'Engineer 1', {
      allocationMode: 'CAPACITY_PLAN',
    })
    nrB = await createNamedResource(projectId, rtB, 'nr-legacy-b-1', 'QA 1', {
      allocationMode: 'CAPACITY_PLAN',
    })
    nrExplicitB = await createNamedResource(projectId, rtB, 'nr-legacy-b-explicit', 'QA Explicit', {
      allocationMode: 'EFFORT',
    })

    // Create pre-#359 legacy NAMED_PERSON profiles (both resources)
    await createProfile(
      projectId, 'cp-legacy-a-1', 'NAMED_PERSON', null, nrA,
      { planningBasis: 'CAPACITY_PROFILE', source: 'SQUAD_PLANNER' },
    )
    await createProfile(
      projectId, 'cp-legacy-b-1', 'NAMED_PERSON', null, nrB,
      { planningBasis: 'CAPACITY_PROFILE', source: 'SQUAD_PLANNER' },
    )

    // Create an explicit MANUAL NAMED_PERSON profile on nrExplicitB (must be preserved)
    await createProfile(
      projectId, 'cp-explicit-b', 'NAMED_PERSON', null, nrExplicitB,
      { planningBasis: 'CAPACITY_PROFILE', source: 'MANUAL' },
    )

    // Apply plan covering only rtA (role A), 1 headcount
    const res = await request(app)
      .post(`/api/projects/${projectId}/squad-plan/apply`)
      .set('Authorization', authHeader)
      .send(buildApplyPayload(rtA, [
        { periodIndex: 0, startWeek: 0, endWeek: 8, headcount: 1 },
      ], { name: 'Legacy A/B Omission Test' }))

    expect(res.status).toBe(201)
  })

  it('creates role A profile while omitting legacy role B without a role profile row', async () => {
    const profiles = await fetchProfiles(projectId)
    const roleAProfile = profiles.find(
      p => p.ownerKind === 'ROLE' && p.resourceTypeId === rtA,
    )
    expect(roleAProfile).toMatchObject({
      planningBasis: 'CAPACITY_PROFILE',
      source: 'SQUAD_PLANNER',
    })
    // Default should be non-zero (not cleared)
    expect(roleAProfile!.defaultPercent).toBeGreaterThan(0)
    const segments = await fetchSegments(roleAProfile!.id)
    expect(segments.length).toBeGreaterThan(0)
  })

  it('converts role As legacy NAMED_PERSON to PLANNED_RESOURCE with segments', async () => {
    const profiles = await fetchProfiles(projectId)
    const plannedA = profiles.find(
      p => p.ownerKind === 'PLANNED_RESOURCE' && p.namedResourceId === nrA,
    )
    expect(plannedA).toMatchObject({
      resourceTypeId: null,
      namedResourceId: nrA,
      planningBasis: 'CAPACITY_PROFILE',
      source: 'SQUAD_PLANNER',
    })
    expect(plannedA!.defaultPercent).toBeGreaterThan(0)
    const segments = await fetchSegments(plannedA!.id)
    expect(segments.length).toBeGreaterThan(0)
    // Verify no NAMED_PERSON profile remains for nrA
    expect(profiles.filter(p => p.ownerKind === 'NAMED_PERSON' && p.namedResourceId === nrA))
      .toHaveLength(0)
  })

  it('clears role B legacy ROLE profile to zero capacity', async () => {
    const profiles = await fetchProfiles(projectId)
    const roleBProfile = profiles.find(
      p => p.ownerKind === 'ROLE' && p.resourceTypeId === rtB,
    )
    expect(roleBProfile).toMatchObject({
      defaultPercent: 0,
      startWeek: null,
      endWeek: null,
      planningBasis: 'CAPACITY_PROFILE',
      source: 'SQUAD_PLANNER',
    })
    expect(await fetchSegments(roleBProfile!.id)).toHaveLength(0)
  })

  it('clears role B legacy named resource to zero-capacity PLANNED_RESOURCE', async () => {
    const profiles = await fetchProfiles(projectId)
    const plannedB = profiles.find(
      p => p.ownerKind === 'PLANNED_RESOURCE' && p.namedResourceId === nrB,
    )
    expect(plannedB).toMatchObject({
      defaultPercent: 0,
      startWeek: null,
      endWeek: null,
      planningBasis: 'CAPACITY_PROFILE',
      source: 'SQUAD_PLANNER',
    })
    expect(await fetchSegments(plannedB!.id)).toHaveLength(0)
  })

  it('clears role B named resource compatibility aliases', async () => {
    const nr = await prisma.namedResource.findUnique({ where: { id: nrB } })
    expect(nr).toMatchObject({
      allocationMode: 'CAPACITY_PLAN',
      allocationPercent: 0,
      allocationPct: 0,
      allocationStartWeek: null,
      allocationEndWeek: null,
      startWeek: null,
      endWeek: null,
    })
  })

  it('preserves explicit named-person metadata on B unchanged', async () => {
    const profiles = await fetchProfiles(projectId)
    const explicitProfile = profiles.find(p => p.id === 'cp-explicit-b')
    expect(explicitProfile).toMatchObject({
      ownerKind: 'NAMED_PERSON',
      source: 'MANUAL',
      namedResourceId: nrExplicitB,
      planningBasis: 'CAPACITY_PROFILE',
    })
    // Verify the explicit nr was NOT touched by the planner
    const nr = await prisma.namedResource.findUnique({ where: { id: nrExplicitB } })
    expect(nr).toMatchObject({
      allocationMode: 'EFFORT',
      allocationPercent: 100,
    })
    // Should not have a PLANNED_RESOURCE profile
    expect(profiles.filter(p => p.ownerKind === 'PLANNED_RESOURCE' && p.namedResourceId === nrExplicitB))
      .toHaveLength(0)
    // Should have exactly one profile (the explicit MANUAL one)
    expect(profiles.filter(p => p.namedResourceId === nrExplicitB))
      .toHaveLength(1)
  })

  it('clears role B resource type compatibility fields', async () => {
    const rt = await prisma.resourceType.findUnique({ where: { id: rtB } })
    expect(rt).toMatchObject({
      count: 0,
      allocationMode: 'CAPACITY_PLAN',
      allocationPercent: 0,
      allocationStartWeek: null,
      allocationEndWeek: null,
    })
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// Test coverage is skipped when INTEGRATION_TEST is not 'true'.
// ═════════════════════════════════════════════════════════════════════════════
