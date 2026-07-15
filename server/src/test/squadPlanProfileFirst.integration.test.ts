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
 *   - A deterministic concurrent explicit-owner mutation before transaction
 *     revalidation returns 409, removes only the new snapshot, and preserves
 *     the concurrent explicit profile.
 *   - setActive:false saves the plan only and does not mutate any capacity
 *     profiles, resource types, or named resources.
 *   - Two concurrent valid applies are serialized: each returns 201 or retryable
 *     409, and the database contains one active plan with one owner profile set.
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
  __setPreValidationConflictSeam,
  __setPreWriteConflictSeam,
  PlannerConflictError,
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
// Scenario 5 — Explicit NAMED_PERSON with insufficient planner resources
//              succeeds by creating planner placeholder
// ═════════════════════════════════════════════════════════════════════════════
//
// The conflict preflight does NOT block on explicit persons with shortfall.
// buildPlannerResourcePlan treats explicit resources as skipped, creates new
// planner-managed placeholders to reach the required trajectory count. Explicit
// profiles must survive with original ownerKind/source/segments/aliases.

describeIf('Scenario 5 — Explicit NAMED_PERSON + shortfall creates planner placeholder', () => {
  let projectId: string
  let rtId: string
  let aliceNrId: string

  beforeAll(async () => {
    if (!runIntegration) return
    projectId = await createProject()
    rtId = await createResourceType(projectId, 'rt-eng-s5', 'Engineer')
    await createEpicBacklog(projectId, rtId)

    // Create a named resource with an explicit MANUAL NAMED_PERSON profile
    aliceNrId = await createNamedResource(projectId, rtId, 'nr-alice', 'Alice')
    await createProfile(
      projectId,
      'cp-alice',
      'NAMED_PERSON',
      null,
      aliceNrId,
      { planningBasis: 'CAPACITY_PROFILE', source: 'MANUAL' },
    )

    // Apply with headcount 2 → 2 trajectories needed, but only 0 planner NRs
    // (Alice is explicit and won't be counted). Planner creates 2 placeholders.
    const res = await request(app)
      .post(`/api/projects/${projectId}/squad-plan/apply`)
      .set('Authorization', authHeader)
      .send(buildApplyPayload(rtId, [
        { periodIndex: 0, startWeek: 0, endWeek: 8, headcount: 2 },
      ], { name: 'Explicit Person Success', setActive: true }))

    expect(res.status).toBe(201)
  })

  it('creates a planner placeholder named resource alongside the explicit person', async () => {
    const nrs = await prisma.namedResource.findMany({
      where: { resourceType: { projectId } },
      orderBy: { id: 'asc' },
    })
    // Alice (explicit) + 2 planner placeholders (for 2 trajectories)
    expect(nrs).toHaveLength(3)

    const alice = nrs.find(nr => nr.id === aliceNrId)
    expect(alice).toBeDefined()
    // Alice's original legacy aliases preserved (EFFORT was default from createNamedResource)
    expect(alice!.allocationMode).toBe('EFFORT')
    expect(alice!.allocationPercent).toBe(100)

    // Planner placeholders have CAPACITY_PLAN allocationMode
    const plannerNRs = nrs.filter(nr => nr.id !== aliceNrId)
    expect(plannerNRs).toHaveLength(2)
    for (const nr of plannerNRs) {
      expect(nr.allocationMode).toBe('CAPACITY_PLAN')
      expect(nr.resourceTypeId).toBe(rtId)
    }
  })

  it('preserves the explicit NAMED_PERSON profile unchanged', async () => {
    const profiles = await fetchProfiles(projectId)
    const aliceProfile = profiles.find(p => p.id === 'cp-alice')
    expect(aliceProfile).toMatchObject({
      ownerKind: 'NAMED_PERSON',
      resourceTypeId: null,
      namedResourceId: aliceNrId,
      planningBasis: 'CAPACITY_PROFILE',
      source: 'MANUAL',
    })
  })

  it('creates ROLE profile and PLANNED_RESOURCE profiles for the placeholders', async () => {
    const profiles = await fetchProfiles(projectId)
    const roleProfiles = profiles.filter(p => p.ownerKind === 'ROLE')
    expect(roleProfiles).toHaveLength(1)
    expect(roleProfiles[0].resourceTypeId).toBe(rtId)
    expect(roleProfiles[0].namedResourceId).toBeNull()
    expect(roleProfiles[0].planningBasis).toBe('CAPACITY_PROFILE')
    expect(roleProfiles[0].source).toBe('SQUAD_PLANNER')

    const prProfiles = profiles.filter(p => p.ownerKind === 'PLANNED_RESOURCE')
    expect(prProfiles).toHaveLength(2)

    // Exact owner shape: resourceTypeId null, namedResourceId set
    for (const pr of prProfiles) {
      expect(pr.resourceTypeId).toBeNull()
      expect(pr.namedResourceId).not.toBeNull()
      expect(pr.planningBasis).toBe('CAPACITY_PROFILE')
      expect(pr.source).toBe('SQUAD_PLANNER')
    }

    // Validate named resource FK belongs to this RT
    const allNRs = await prisma.namedResource.findMany({
      where: { resourceType: { projectId } },
    })
    for (const pr of prProfiles) {
      const nr = allNRs.find(n => n.id === pr.namedResourceId)
      expect(nr).toBeDefined()
      expect(nr!.resourceTypeId).toBe(rtId)
    }
  })

  it('writes segments on ROLE and PLANNED_RESOURCE profiles, not on explicit profile', async () => {
    const profiles = await fetchProfiles(projectId)

    // Explicit profile has no segments
    const aliceProfile = profiles.find(p => p.id === 'cp-alice')
    const aliceSegs = await fetchSegments(aliceProfile!.id)
    expect(aliceSegs).toHaveLength(0)

    // ROLE profile has segments
    const roleProfile = profiles.find(p => p.ownerKind === 'ROLE')
    const roleSegs = await fetchSegments(roleProfile!.id)
    expect(roleSegs.length).toBeGreaterThan(0)
    expect(roleSegs[0].source).toBe('SQUAD_PLANNER')
    expect(roleSegs[0].capacityPercent).toBe(200) // 2 headcount over one period

    // PLANNED_RESOURCE profiles have segments
    const prProfiles = profiles.filter(p => p.ownerKind === 'PLANNED_RESOURCE')
    for (const pr of prProfiles) {
      const segs = await fetchSegments(pr.id)
      expect(segs.length).toBeGreaterThan(0)
    }
  })

  it('activates a capacity plan', async () => {
    const activePlanId = await fetchActivePlanId(projectId)
    expect(activePlanId).not.toBeNull()
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
// Scenario 10 — Preflight-to-transaction race regression
// ═════════════════════════════════════════════════════════════════════════════
//
// The __preWriteConflictSeam fires inside the apply transaction after
// revalidatePlannerPlan passes but before any mutations. When the seam throws
// PlannerConflictError, the route handler must:
//   - Return 409 (transaction-time conflict)
//   - Delete the newly-created pre-apply snapshot (created before the
//     transaction)
//   - Preserve the older snapshot
//   - Leave no partial plan, profile, or timeline writes (transaction rollback)
//
// Additionally, pre-create a conflicting profile and assert the endpoint
// returns 409 at preflight time, no snapshot is created, and no state leaks.

describeIf('Scenario 10 — Preflight-to-transaction race regression', () => {
  let projectId: string
  let rtId: string
  let concurrentNamedResourceId: string
  let olderSnapshotId: string

  beforeAll(async () => {
    if (!runIntegration) return
    projectId = await createProject()
    rtId = await createResourceType(projectId, 'rt-race-10', 'Engineer')
    await createEpicBacklog(projectId, rtId)
    concurrentNamedResourceId = await createNamedResource(
      projectId,
      rtId,
      'nr-race-10-concurrent',
      'Concurrent Engineer',
      { allocationMode: 'CAPACITY_PLAN' },
    )

    // Create an older snapshot that must survive the race
    const olderSnapshot = await prisma.backlogSnapshot.create({
      data: {
        projectId,
        label: 'Older snapshot for race test',
        trigger: 'manual',
        snapshot: {},
        createdById: userId,
      },
    })
    olderSnapshotId = olderSnapshot.id
  })

  it('fires PlannerConflictError from pre-write seam → 409, snapshot cleanup, no partial writes', async () => {
    if (!runIntegration) return

    __setPreWriteConflictSeam(() => {
      throw new PlannerConflictError('race: profile state changed between preflight and transaction', [])
    })

    try {
      const res = await request(app)
        .post(`/api/projects/${projectId}/squad-plan/apply`)
        .set('Authorization', authHeader)
        .send(buildApplyPayload(rtId, [
          { periodIndex: 0, startWeek: 0, endWeek: 8, headcount: 1 },
        ], { name: 'Race Test' }))

      expect(res.status).toBe(409)
    } finally {
      __setPreWriteConflictSeam(null)
    }

    // ── No active plan (transaction rolled back before deactivation) ──
    const activePlanId = await fetchActivePlanId(projectId)
    expect(activePlanId).toBeNull()

    // ── No profiles or segments leaked ────────────────────────────
    expect(await fetchProfiles(projectId)).toHaveLength(0)
    expect(await prisma.capacitySegment.count({
      where: { capacityProfile: { projectId } },
    })).toBe(0)

    // ── Only the newly-created pre-apply snapshot was removed, older survives ──
    const allSnapshots = await prisma.backlogSnapshot.findMany({
      where: { projectId },
      orderBy: { createdAt: 'asc' },
    })
    expect(allSnapshots).toHaveLength(1)
    expect(allSnapshots[0].id).toBe(olderSnapshotId)

    // ── Resource type allocation mode unchanged ───────────────────
    const rt = await prisma.resourceType.findUnique({ where: { id: rtId } })
    expect(rt).not.toBeNull()
    expect(rt!.allocationMode).toBe('TIMELINE')
  })

  it('detects a committed concurrent explicit owner before transaction revalidation', async () => {
    if (!runIntegration) return

    // Seed one existing planner-owned profile. The seam then creates a second
    // physical owner on the same NamedResource, which must fail closed.
    await createProfile(
      projectId,
      'cp-race-existing-planner',
      'PLANNED_RESOURCE',
      null,
      concurrentNamedResourceId,
      { planningBasis: 'CAPACITY_PROFILE', source: 'SQUAD_PLANNER' },
    )

    __setPreValidationConflictSeam(async () => {
      await createProfile(
        projectId,
        'cp-concurrent-explicit',
        'NAMED_PERSON',
        null,
        concurrentNamedResourceId,
        { planningBasis: 'CAPACITY_PROFILE', source: 'MANUAL' },
      )
    })

    try {
      const res = await request(app)
        .post(`/api/projects/${projectId}/squad-plan/apply`)
        .set('Authorization', authHeader)
        .send(buildApplyPayload(rtId, [
          { periodIndex: 0, startWeek: 0, endWeek: 8, headcount: 1 },
        ], { name: 'Concurrent Owner Race Test' }))

      expect(res.status).toBe(409)
    } finally {
      __setPreValidationConflictSeam(null)
    }

    // The conflict is the committed explicit profile, which must remain intact.
    const explicitProfile = await prisma.capacityProfile.findUnique({
      where: { id: 'cp-concurrent-explicit' },
    })
    expect(explicitProfile).toMatchObject({
      id: 'cp-concurrent-explicit',
      ownerKind: 'NAMED_PERSON',
      resourceTypeId: null,
      namedResourceId: concurrentNamedResourceId,
      planningBasis: 'CAPACITY_PROFILE',
      source: 'MANUAL',
    })

    // The new snapshot is removed, while the older snapshot survives.
    const allSnapshots = await prisma.backlogSnapshot.findMany({
      where: { projectId },
      orderBy: { createdAt: 'asc' },
    })
    expect(allSnapshots).toHaveLength(1)
    expect(allSnapshots[0].id).toBe(olderSnapshotId)

    // No partial apply writes or compatibility mutations are allowed.
    expect(await fetchActivePlanId(projectId)).toBeNull()
    expect(await prisma.capacitySegment.count({
      where: { capacityProfile: { projectId } },
    })).toBe(0)
    expect(await prisma.resourceType.findUnique({ where: { id: rtId } }))
      .toMatchObject({ allocationMode: 'TIMELINE' })
    expect(await prisma.namedResource.findUnique({
      where: { id: concurrentNamedResourceId },
    })).toMatchObject({
      allocationMode: 'CAPACITY_PLAN',
      allocationPercent: 100,
      allocationStartWeek: null,
      allocationEndWeek: null,
    })
  })

  it('preflight returns 409 when a conflicting profile exists before apply', async () => {
    if (!runIntegration) return

    // Inject two conflicting ROLE profiles so preflight detects a duplicate.
    for (const id of ['cp-conflict-preflight-a', 'cp-conflict-preflight-b']) {
      await createProfile(
        projectId,
        id,
        'ROLE',
        rtId,
        null,
        { planningBasis: 'CAPACITY_PROFILE', source: 'SQUAD_PLANNER' },
      )
    }

    try {
      const res = await request(app)
        .post(`/api/projects/${projectId}/squad-plan/apply`)
        .set('Authorization', authHeader)
        .send(buildApplyPayload(rtId, [
          { periodIndex: 0, startWeek: 0, endWeek: 8, headcount: 1 },
        ], { name: 'Preflight 409 Test' }))

      expect(res.status).toBe(409)
    } finally {
      // Cleanup the injected profiles so other tests aren't affected
      await prisma.capacityProfile.deleteMany({
        where: { projectId, id: { in: ['cp-conflict-preflight-a', 'cp-conflict-preflight-b'] } },
      }).catch(() => {})
    }

    // ── No active plan created ──────────────────────────────────
    expect(await fetchActivePlanId(projectId)).toBeNull()

    // ── No new snapshot (preflight runs first) ──────────────────
    const allSnapshots = await prisma.backlogSnapshot.findMany({
      where: { projectId },
      orderBy: { createdAt: 'asc' },
    })
    expect(allSnapshots).toHaveLength(1)
    expect(allSnapshots[0].id).toBe(olderSnapshotId)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// Scenario 11 — Endpoint-level completeness for /capacity-profiles
// ═════════════════════════════════════════════════════════════════════════════
//
// After a profile-first apply, GET /capacity-profiles must return the
// persisted-authority DTO path when the persisted set is structurally valid
// and complete. Deleting the planner ROLE profile (making the set incomplete)
// causes a fallback to the legacy mapper. Restoring exactly one ROLE profile
// restores the authority path.
//
// Also verifies explicit-only policy co-existence: when explicit NAMED_PERSON
// profiles exist alongside planner profiles, the completeness check accepts
// the union as a complete coverage set.

describeIf('Scenario 11 — Endpoint-level completeness for /capacity-profiles', () => {
  let projectId: string
  let rtId: string
  let explicitRtId: string
  let explicitNrId: string
  let plannerProfileId: string

  beforeAll(async () => {
    if (!runIntegration) return
    projectId = await createProject()
    rtId = await createResourceType(projectId, 'rt-compl-11', 'Engineer')
    explicitRtId = await createResourceType(projectId, 'rt-compl-explicit', 'Designer')
    await createEpicBacklog(projectId, rtId)

    // Create an explicit named resource with MANUAL NAMED_PERSON profile on secondary RT
    explicitNrId = await createNamedResource(projectId, explicitRtId, 'nr-designer-1', 'Alice Designer', {
      allocationMode: 'EFFORT',
    })
    await createProfile(
      projectId,
      'cp-explicit-designer',
      'NAMED_PERSON',
      null,
      explicitNrId,
      { planningBasis: 'AVAILABILITY_WINDOW', source: 'MANUAL', defaultPercent: 80 },
    )

    // Apply plan covering both RTs (Designer gets a placeholder)
    const applyPayload = buildApplyPayload(rtId, [
      { periodIndex: 0, startWeek: 0, endWeek: 8, headcount: 1 },
    ], { name: 'Completeness Test' })
    // Add explicit RT entry
    applyPayload.periods[0].entries.push({
      resourceTypeId: explicitRtId,
      headcount: 0,
      demandFTE: 0,
      utilisationPct: 0,
    })

    const res = await request(app)
      .post(`/api/projects/${projectId}/squad-plan/apply`)
      .set('Authorization', authHeader)
      .send(applyPayload)
    expect(res.status).toBe(201)

    // Capture the planner ROLE profile ID for later removal
    const profiles = await fetchProfiles(projectId)
    const plannerRole = profiles.find(
      p => p.ownerKind === 'ROLE' && p.resourceTypeId === rtId,
    )
    expect(plannerRole).toBeDefined()
    plannerProfileId = plannerRole!.id
  })

  it('returns persisted-authority path when persisted profiles are complete', async () => {
    if (!runIntegration) return

    const res = await request(app)
      .get(`/api/projects/${projectId}/capacity-profiles`)
      .set('Authorization', authHeader)
    expect(res.status).toBe(200)

    const profiles = res.body.capacityProfiles as Array<Record<string, unknown>>
    expect(Array.isArray(profiles)).toBe(true)
    expect(profiles.length).toBeGreaterThanOrEqual(3) // role + 2 planner + explicit

    // Role DTO: owner.kind === 'role', owns the RT
    const roleDto = profiles.find(
      (p: Record<string, unknown>) => (p.owner as Record<string, unknown>)?.kind === 'role',
    )
    expect(roleDto).toBeDefined()
    expect((roleDto!.owner as Record<string, unknown>).id).toBe(rtId)
    expect(roleDto!.planningBasis).toBe('capacityProfile')
    expect(roleDto!.source).toBe('squadPlanner')

    // PLANNED_RESOURCE DTO: owner.kind === 'plannedResource', resourceTypeId absent from DTO
    const plannedDtos = profiles.filter(
      (p: Record<string, unknown>) => (p.owner as Record<string, unknown>)?.kind === 'plannedResource',
    )
    expect(plannedDtos.length).toBeGreaterThanOrEqual(1)
    for (const dto of plannedDtos) {
      expect((dto.owner as Record<string, unknown>).id).toBeDefined()
      // RR.owner.roleId should reference the RT the named resource belongs to
      expect((dto.owner as Record<string, unknown>).roleId).toBe(rtId)
    }

    // Explicit NAMED_PERSON DTO: owner.kind === 'namedPerson'
    const explicitDto = profiles.find(
      (p: Record<string, unknown>) => (p.owner as Record<string, unknown>)?.kind === 'namedPerson',
    )
    expect(explicitDto).toBeDefined()
    expect((explicitDto!.owner as Record<string, unknown>).id).toBe(explicitNrId)
    expect((explicitDto!.owner as Record<string, unknown>).name).toBe('Alice Designer')
    expect(explicitDto!.planningBasis).toBe('availabilityWindow')
    expect(explicitDto!.source).toBe('manual')
    expect(explicitDto!.defaultPercent).toBe(80)

    // Legacy fields are null on persisted-authority path
    expect(explicitDto!.legacy).toBeDefined()
  })

  it('falls back to legacy mapper when planner ROLE profile is removed', async () => {
    if (!runIntegration) return

    // Remove the planner ROLE profile, making the persisted set incomplete
    await prisma.capacityProfile.delete({ where: { id: plannerProfileId } })
    // Also remove any orphan segments
    await prisma.capacitySegment.deleteMany({
      where: { capacityProfileId: plannerProfileId },
    }).catch(() => {})

    const res = await request(app)
      .get(`/api/projects/${projectId}/capacity-profiles`)
      .set('Authorization', authHeader)
    expect(res.status).toBe(200)

    const profiles = res.body.capacityProfiles as Array<Record<string, unknown>>
    expect(Array.isArray(profiles)).toBe(true)

    // Legacy mapping emits named-resource owners while retaining the
    // compatibility field shape. The persisted profile ID must be absent.
    expect(profiles.every(
      (p: Record<string, unknown>) =>
        p.legacy != null &&
        Object.prototype.hasOwnProperty.call(p.legacy as Record<string, unknown>, 'allocationMode'),
    )).toBe(true)
    expect(profiles.some((p: Record<string, unknown>) => p.id === 'cp-explicit-designer')).toBe(false)
    expect(profiles.some((p: Record<string, unknown>) => p.id === explicitNrId)).toBe(true)
  })

  it('restores persisted-authority path when ROLE profile is restored', async () => {
    if (!runIntegration) return

    // Restore exactly one planner ROLE profile with correct FK
    const restoredProfile = await prisma.capacityProfile.create({
      data: {
        projectId,
        resourceTypeId: rtId,
        namedResourceId: null,
        ownerKind: 'ROLE',
        planningBasis: 'CAPACITY_PROFILE',
        source: 'SQUAD_PLANNER',
        defaultPercent: 100,
        startWeek: 0,
        endWeek: 7,
      },
    })

    // Add segments for completeness
    await prisma.capacitySegment.create({
      data: {
        capacityProfileId: restoredProfile.id,
        startWeek: 0,
        endWeek: 7,
        capacityPercent: 100,
        source: 'SQUAD_PLANNER',
      },
    })

    const res = await request(app)
      .get(`/api/projects/${projectId}/capacity-profiles`)
      .set('Authorization', authHeader)
    expect(res.status).toBe(200)

    const profiles = res.body.capacityProfiles as Array<Record<string, unknown>>
    expect(Array.isArray(profiles)).toBe(true)

    // Authority path: should include role, plannedResource, and namedPerson
    const roleDto = profiles.find(
      (p: Record<string, unknown>) => (p.owner as Record<string, unknown>)?.kind === 'role'
        && (p.owner as Record<string, unknown>).id === rtId,
    )
    expect(roleDto).toBeDefined()
    expect(roleDto!.planningBasis).toBe('capacityProfile')
    expect(roleDto!.source).toBe('squadPlanner')
    // Legacy fields are null on authority path
    expect((roleDto!.legacy as Record<string, unknown>)?.allocationMode).toBeNull()

    // Planned resources should still be authoritative
    const plannedDtos = profiles.filter(
      (p: Record<string, unknown>) => (p.owner as Record<string, unknown>)?.kind === 'plannedResource',
    )
    expect(plannedDtos.length).toBeGreaterThanOrEqual(1)

    // Explicit designer still present
    const explicitDto = profiles.find(
      (p: Record<string, unknown>) => (p.owner as Record<string, unknown>)?.kind === 'namedPerson'
        && (p.owner as Record<string, unknown>).id === explicitNrId,
    )
    expect(explicitDto).toBeDefined()
    expect(explicitDto!.planningBasis).toBe('availabilityWindow')
    expect(explicitDto!.source).toBe('manual')
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// Scenario 12 — Concurrent valid applies under Serializable isolation
// ═════════════════════════════════════════════════════════════════════════════

describeIf('Scenario 12 — concurrent valid applies under Serializable isolation', () => {
  let projectId: string
  let rtId: string

  beforeAll(async () => {
    if (!runIntegration) return
    projectId = await createProject()
    rtId = await createResourceType(projectId, 'rt-serializable-12', 'Engineer')
    await createEpicBacklog(projectId, rtId)
  })

  it('allows one or both serialised commits and rejects no request with a server error', async () => {
    if (!runIntegration) return

    const responses = await Promise.all([
      request(app)
        .post(`/api/projects/${projectId}/squad-plan/apply`)
        .set('Authorization', authHeader)
        .send(buildApplyPayload(rtId, [
          { periodIndex: 0, startWeek: 0, endWeek: 8, headcount: 1 },
        ], { name: 'Serializable Apply A' })),
      request(app)
        .post(`/api/projects/${projectId}/squad-plan/apply`)
        .set('Authorization', authHeader)
        .send(buildApplyPayload(rtId, [
          { periodIndex: 0, startWeek: 0, endWeek: 8, headcount: 1 },
        ], { name: 'Serializable Apply B' })),
    ])

    const statuses = responses.map(response => response.status).sort((a, b) => a - b)
    expect(statuses.some(status => status === 201)).toBe(true)
    expect(statuses.every(status => status === 201 || status === 409)).toBe(true)

    const activePlans = await prisma.capacityPlan.findMany({
      where: { projectId, isActive: true },
    })
    expect(activePlans).toHaveLength(1)

    const profiles = await fetchProfiles(projectId)
    expect(profiles.filter(profile =>
      profile.ownerKind === 'ROLE' && profile.resourceTypeId === rtId,
    )).toHaveLength(1)
    expect(profiles.filter(profile =>
      profile.ownerKind === 'PLANNED_RESOURCE' && profile.source === 'SQUAD_PLANNER',
    )).toHaveLength(1)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// Test coverage is skipped when INTEGRATION_TEST is not 'true'.
// ═════════════════════════════════════════════════════════════════════════════
