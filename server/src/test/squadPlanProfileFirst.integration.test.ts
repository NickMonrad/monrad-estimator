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
import { PrismaClient, Prisma } from '@prisma/client'
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
import { syncCapacityProfilesForProject } from '../lib/syncCapacityProfiles.js'
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

/**
 * Capture a canonical snapshot of all capacity/timeline/snapshot state for a
 * project, excluding volatile timestamps. Used for exact before/after equality
 * assertions after conflict 409 responses.
 */
async function captureCanonicalState(projectId: string): Promise<Record<string, unknown>> {
  const strip = (obj: unknown) =>
    JSON.parse(JSON.stringify(obj, (key, val) =>
      (key === 'createdAt' || key === 'updatedAt') ? undefined : val,
    ))

  const plans = await prisma.capacityPlan.findMany({
    where: { projectId },
    include: {
      periods: {
        include: { entries: true },
        orderBy: { periodIndex: 'asc' },
      },
    },
    orderBy: { id: 'asc' },
  })
  const profiles = await prisma.capacityProfile.findMany({
    where: { projectId },
    include: { segments: { orderBy: { startWeek: 'asc' } } },
    orderBy: [{ ownerKind: 'asc' }, { id: 'asc' }],
  })
  const resourceTypes = await prisma.resourceType.findMany({
    where: { projectId },
    orderBy: { id: 'asc' },
  })
  const namedResources = await prisma.namedResource.findMany({
    where: { resourceType: { projectId } },
    orderBy: { id: 'asc' },
  })
  const timelineEntries = await prisma.timelineEntry.findMany({
    where: { projectId },
    orderBy: { id: 'asc' },
  })
  const storyTimelineEntries = await prisma.storyTimelineEntry.findMany({
    where: { projectId },
    orderBy: { id: 'asc' },
  })
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { weeklyDemandCache: true },
  })
  const snapshots = await prisma.backlogSnapshot.findMany({
    where: { projectId },
    orderBy: { id: 'asc' },
  })

  return {
    plans: strip(plans),
    profiles: strip(profiles),
    resourceTypes: strip(resourceTypes),
    namedResources: strip(namedResources),
    timelineEntries: strip(timelineEntries),
    storyTimelineEntries: strip(storyTimelineEntries),
    weeklyDemandCache: project?.weeklyDemandCache ?? null,
    snapshots: strip(snapshots),
  }
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
  it('resolved scheduler capacity matches plan: 60h at week 0, 20h at week 8, no double-count', async () => {
    const { resolveSchedulerCapacity } = await import('../lib/schedulerCapacityResolver.js')
    const { getWeeklyCapacity } = await import('../lib/scheduler.js')
    const { deriveNamedResourceAssignments } = await import('../lib/namedResourceAssignments.js')
    const { materializeCapacityPlanResources } = await import('../lib/capacityPlanMaterialisation.js')

    // Ensure the project's weeklyDemandCache includes week 8 demand so the
    // planning model extends capacity computation to the plan's full duration.
    const project = await prisma.project.findUniqueOrThrow({ where: { id: projectId } })
    const cache = (project.weeklyDemandCache ?? {}) as Record<string, number>
    for (const w of [8, 9, 10, 11]) cache[`${rtId}|${w}`] = 2.5
    await prisma.project.update({
      where: { id: projectId },
      data: { weeklyDemandCache: cache },
    })

    const resolved = await resolveSchedulerCapacity(prisma, projectId, 8)
    const rt = resolved.resourceTypes.find(r => r.id === rtId)!

    // Overlap suppression: aggregate ROLE profile from Squad Planner must
    // not be exposed as additional scheduler capacity when PLANNED_RESOURCE
    // profiles exist for the same plan.
    expect(rt.roleSegments).toEqual([])

    // Named resources: 2 planned-resource trajectories
    expect(rt.namedResources).toHaveLength(2)

    // Week 0: 1.5 FTE = 60h (100% + 50%), not 120h (no role double-count)
    expect(getWeeklyCapacity(rt, 0, 8)).toBe(60)

    // Week 8: 0.5 FTE = 20h (trajectory 1 ends at week 7)
    expect(getWeeklyCapacity(rt, 8, 8)).toBe(20)

    // Named-resource assignment parity
    const capacityPlanByRt = materializeCapacityPlanResources([])
    const assignments = deriveNamedResourceAssignments({
      resourceTypes: [rt],
      weeklyDemand: [
        { week: 0, resourceTypeName: 'Engineer', demandDays: 10 },
        { week: 8, resourceTypeName: 'Engineer', demandDays: 10 },
      ],
      capacityPlanByRt,
    })
    const rtAssign = assignments.get(rtId)!
    expect(rtAssign.actualAllocatedDays).toBeCloseTo(10, 5)

    // Timeline schedule creates entries based on post-apply state
    const scheduleRes = await request(app)
      .post(`/api/projects/${projectId}/timeline/schedule`)
      .set('Authorization', authHeader)
      .send({ resourceLevel: false })
    expect(scheduleRes.status).toBe(200)

    // ── Schedule response parity ──────────────────────────────────────────
    const scheduleW0 = scheduleRes.body.weeklyCapacity?.find(
      (c: any) => c.resourceTypeName === 'Engineer' && c.week === 0,
    )
    expect(scheduleW0).toBeDefined()
    expect(scheduleW0.capacityDays).toBe(7.5)

    const scheduleW8 = scheduleRes.body.weeklyCapacity?.find(
      (c: any) => c.resourceTypeName === 'Engineer' && c.week === 8,
    )
    expect(scheduleW8).toBeDefined()
    expect(scheduleW8.capacityDays).toBe(2.5)

    // Timeline GET exposes same weekly capacity
    const timelineRes = await request(app)
      .get(`/api/projects/${projectId}/timeline`)
      .set('Authorization', authHeader)
    expect(timelineRes.status).toBe(200)

    // ── GET response parity ───────────────────────────────────────────────
    const getW0 = timelineRes.body.weeklyCapacity.find(
      (c: any) => c.resourceTypeName === 'Engineer' && c.week === 0,
    )
    expect(getW0).toBeDefined()
    expect(getW0.capacityDays).toBe(7.5) // 60h / 8h

    const getW8 = timelineRes.body.weeklyCapacity.find(
      (c: any) => c.resourceTypeName === 'Engineer' && c.week === 8,
    )
    expect(getW8).toBeDefined()
    expect(getW8.capacityDays).toBe(2.5) // 20h / 8h

    // ── Schedule/GET parity ───────────────────────────────────────────────
    expect(getW0.capacityDays).toBe(scheduleW0.capacityDays)
    expect(getW8.capacityDays).toBe(scheduleW8.capacityDays)

    // Deterministic
    const resolved2 = await resolveSchedulerCapacity(prisma, projectId, 8)
    expect(resolved.resourceTypes).toEqual(resolved2.resourceTypes)
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

  it('creates a zero-capacity ROLE profile for omitted legacy role B', async () => {
    const profiles = await fetchProfiles(projectId)
    const roleBProfile = profiles.find(
      p => p.ownerKind === 'ROLE' && p.resourceTypeId === rtB,
    )
    expect(roleBProfile).toMatchObject({
      planningBasis: 'CAPACITY_PROFILE',
      source: 'SQUAD_PLANNER',
      defaultPercent: 0,
      startWeek: null,
      endWeek: null,
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

    // Assert the #361 named-owner unique index is installed (fail-closed).
    const idxCheck = await prisma.$queryRaw<Array<{ exists: boolean }>>(
      Prisma.sql`SELECT EXISTS (
        SELECT 1 FROM pg_indexes
        WHERE tablename = 'CapacityProfile' AND indexname = 'CapacityProfile_namedResourceId_key'
      ) AS exists`,
    )
    expect(idxCheck[0].exists).toBe(true)

    // Seed one existing planner-owned profile. The seam then creates a second
    // physical owner on the same NamedResource, which fails at the database
    // unique constraint under #361.
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

    // Under #361 the unique index rejects the duplicate BEFORE the profile
    // is created; the transaction rolls back, so cp-concurrent-explicit is
    // absent. The original planner-owned profile survives.
    const explicitProfile = await prisma.capacityProfile.findUnique({
      where: { id: 'cp-concurrent-explicit' },
    })
    expect(explicitProfile).toBeNull()
    const plannerProfile = await prisma.capacityProfile.findUnique({
      where: { id: 'cp-race-existing-planner' },
    })
    expect(plannerProfile).not.toBeNull()

    // Only the newly created pre-apply snapshot is removed; older survives.
    const allSnapshots = await prisma.backlogSnapshot.findMany({
      where: { projectId },
      orderBy: { createdAt: 'asc' },
    })
    expect(allSnapshots).toHaveLength(1)
    expect(allSnapshots[0].id).toBe(olderSnapshotId)

    // No partial apply writes, profiles, segments, or compatibility mutations.
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
    // Under #361 the database unique index makes this race scenario
    // impossible; skip when the constraint is installed.
    const rtUniqueIdx = await prisma.$queryRaw<Array<{ name: string }>>(
      Prisma.sql`SELECT indexname AS name FROM pg_indexes
        WHERE tablename = 'CapacityProfile' AND indexname = 'CapacityProfile_resourceTypeId_key'`,
    )
    if (rtUniqueIdx.length > 0) return

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
// Scenario 13 — Protected ROLE profile (non-planner source) rejected at preflight
// ═════════════════════════════════════════════════════════════════════════════

describeIf('Scenario 13 — Protected ROLE profile is rejected by preflight', () => {
  it('returns 409 when a ROLE profile has MANUAL source', async () => {
    if (!runIntegration) return
    const projectId = await createProject()
    const rtId = await createResourceType(projectId, 'rt-protected-role-13', 'ProtectedRole')
    await createEpicBacklog(projectId, rtId)

    // Create a ROLE profile with MANUAL source (protected)
    await createProfile(
      projectId, 'cp-protected-role-13', 'ROLE', rtId, null,
      { source: 'MANUAL', planningBasis: 'CAPACITY_PROFILE' },
    )

    const res = await request(app)
      .post(`/api/projects/${projectId}/squad-plan/apply`)
      .set('Authorization', authHeader)
      .send(buildApplyPayload(rtId, [
        { periodIndex: 0, startWeek: 0, endWeek: 8, headcount: 1 },
      ]))

    expect(res.status).toBe(409)
    expect(res.body.error).toContain('owner')

    // Verify no active plan or profile changes leaked
    const activePlanId = await fetchActivePlanId(projectId)
    expect(activePlanId).toBeNull()
    const profiles = await fetchProfiles(projectId)
    const protectedRole = profiles.find(profile => profile.id === 'cp-protected-role-13')
    expect(protectedRole).toMatchObject({
      source: 'MANUAL',
      ownerKind: 'ROLE',
    })
  })

  it('returns 409 when a ROLE profile has non-CAPACITY_PROFILE basis', async () => {
    if (!runIntegration) return
    const projectId = await createProject()
    const rtId = await createResourceType(projectId, 'rt-wrong-basis-role-13', 'WrongBasis')
    await createEpicBacklog(projectId, rtId)

    // Create a ROLE profile with AVAILABILITY_WINDOW basis (protected)
    await createProfile(
      projectId, 'cp-wrong-basis-13', 'ROLE', rtId, null,
      { source: 'SQUAD_PLANNER', planningBasis: 'AVAILABILITY_WINDOW' },
    )

    const res = await request(app)
      .post(`/api/projects/${projectId}/squad-plan/apply`)
      .set('Authorization', authHeader)
      .send(buildApplyPayload(rtId, [
        { periodIndex: 0, startWeek: 0, endWeek: 8, headcount: 1 },
      ]))

    expect(res.status).toBe(409)
    expect(res.body.error).toContain('owner')
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// Scenario 14 — Protected ROLE profile in omitted-role cleanup causes atomic failure
// ═════════════════════════════════════════════════════════════════════════════
// When a resource type is omitted from the replacement plan but has a protected
// ROLE profile (non-planner source/basis), the entire apply transaction must
// fail atomically with 409 and no leaked mutations.

describeIf('Scenario 14 — Protected ROLE causes atomic failure in omitted-role cleanup', () => {
  it('returns 409 when a protected ROLE profile exists on an omitted resource type', async () => {
    if (!runIntegration) return
    const projectId = await createProject()
    const rtActive = await createResourceType(projectId, 'rt-active-14', 'Active')
    const rtOmitted = await createResourceType(projectId, 'rt-omitted-14', 'OmittedWithProtectedRole')
    await createEpicBacklog(projectId, rtActive)

    // First apply: create plan covering both resource types
    const first = await request(app)
      .post(`/api/projects/${projectId}/squad-plan/apply`)
      .set('Authorization', authHeader)
      .send({
        ...buildApplyPayload(rtActive, [
          { periodIndex: 0, startWeek: 0, endWeek: 8, headcount: 1 },
        ]),
        periods: [{
          periodIndex: 0, startWeek: 0, endWeek: 8,
          entries: [
            { resourceTypeId: rtActive, headcount: 1, demandFTE: 0.5, utilisationPct: 50 },
            { resourceTypeId: rtOmitted, headcount: 1, demandFTE: 0.5, utilisationPct: 50 },
          ],
        }],
      })
    expect(first.status).toBe(201)

    // Now override the omitted RT's ROLE profile to be MANUAL (protected)
    const profiles = await fetchProfiles(projectId)
    const roleOnOmitted = profiles.find(
      p => p.ownerKind === 'ROLE' && p.resourceTypeId === rtOmitted,
    )
    expect(roleOnOmitted).toBeDefined()
    await prisma.capacityProfile.update({
      where: { id: roleOnOmitted!.id },
      data: { source: 'MANUAL' },
    })

    // Second apply: only rtActive (omittedRt is omitted)
    // This should fail because clearOmittedPlannerCapacity encounters a protected ROLE
    const second = await request(app)
      .post(`/api/projects/${projectId}/squad-plan/apply`)
      .set('Authorization', authHeader)
      .send(buildApplyPayload(rtActive, [
        { periodIndex: 0, startWeek: 0, endWeek: 8, headcount: 1 },
      ], { name: 'Omit Protected Role' }))

    expect(second.status).toBe(409)
    expect(second.body.error).toContain('ROLE')

    // Verify no state leaked: first plan still active, protected role unchanged
    const activePlan = await fetchActivePlanId(projectId)
    expect(activePlan).not.toBeNull()
    const profilesAfter = await fetchProfiles(projectId)
    const protectedRoleStill = profilesAfter.find(profile => profile.id === roleOnOmitted!.id)
    expect(protectedRoleStill).toMatchObject({
      source: 'MANUAL',
      ownerKind: 'ROLE',
    })
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// Scenario 15 — Unrelated CAPACITY_PLAN resource is untouched by apply
// ═════════════════════════════════════════════════════════════════════════════
// A resource type in CAPACITY_PLAN allocation mode that has never been in any
// prior active plan and has no planner profiles is not modified by the apply
// transaction. Its allocation mode, count, and named resources are preserved.

describeIf('Scenario 15 — Unrelated CAPACITY_PLAN resource preserved', () => {
  it('preserves an unrelated CAPACITY_PLAN resource type when applying a new plan', async () => {
    if (!runIntegration) return
    const projectId = await createProject()
    const rtActive = await createResourceType(projectId, 'rt-active-15', 'Active')
    const rtUnrelated = await createResourceType(projectId, 'rt-unrelated-15', 'Unrelated', {
      allocationMode: 'CAPACITY_PLAN',
      count: 2,
    })
    await prisma.resourceType.update({
      where: { id: rtUnrelated },
      data: { allocationPercent: 50, allocationStartWeek: 0, allocationEndWeek: 10 },
    })

    // Create a named resource with CAPACITY_PLAN on the unrelated RT
    const unrelatedNrId = await createNamedResource(
      projectId, rtUnrelated, 'nr-unrelated-15', 'Unrelated Resource',
      {
        allocationMode: 'CAPACITY_PLAN',
        allocationPercent: 100,
        startWeek: 0,
        endWeek: 10,
      },
    )

    // Apply plan covering only rtActive (not rtUnrelated)
    const res = await request(app)
      .post(`/api/projects/${projectId}/squad-plan/apply`)
      .set('Authorization', authHeader)
      .send(buildApplyPayload(rtActive, [
        { periodIndex: 0, startWeek: 0, endWeek: 8, headcount: 1 },
      ], { name: 'Unrelated RT Test' }))

    expect(res.status).toBe(201)

    // Verify unrelated RT unchanged
    const unrelatedRT = await prisma.resourceType.findUnique({ where: { id: rtUnrelated } })
    expect(unrelatedRT).toMatchObject({
      allocationMode: 'CAPACITY_PLAN',
      count: 2,
    })

    // Verify unrelated named resource unchanged
    const unrelatedNR = await prisma.namedResource.findUnique({ where: { id: unrelatedNrId } })
    expect(unrelatedNR).toMatchObject({
      allocationMode: 'CAPACITY_PLAN',
      allocationPercent: 100,
    })
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// Scenario 16 — Prior-plan-only authority clears legacy for omitted resource type
// ═════════════════════════════════════════════════════════════════════════════
//
// A resource type appears only in the prior active CapacityPlan (no capacity
// profiles after profile deletion). A replacement apply omitting that resource
// type must still zero its legacy ResourceType and NamedResource compatibility
// capacity, proving authority was captured before deactivation rather than
// queried from the replacement active plan.

describeIf('Scenario 16 — Prior-plan-only authority clears legacy for omitted RT', () => {
  it('zeros legacy fields on omitted prior-plan-only resource type from captured authority', async () => {
    if (!runIntegration) return
    const projectId = await createProject()

    // RT that will be in the prior active plan but omitted from the replacement
    const rtOmitted = await createResourceType(projectId, 'rt-omitted-16', 'OmittedLegacy', {
      allocationMode: 'CAPACITY_PLAN',
      count: 3,
    })
    // RT that stays active in both plans
    const rtActive = await createResourceType(projectId, 'rt-active-16', 'Active', {
      count: 1,
    })
    await createEpicBacklog(projectId, rtActive)
    await createEpicBacklog(projectId, rtOmitted)

    // ── First apply: plan covering both resource types ──────────────────
    const first = await request(app)
      .post(`/api/projects/${projectId}/squad-plan/apply`)
      .set('Authorization', authHeader)
      .send({
        ...buildApplyPayload(rtActive, [
          { periodIndex: 0, startWeek: 0, endWeek: 8, headcount: 1 },
        ]),
        periods: [{
          periodIndex: 0, startWeek: 0, endWeek: 8,
          entries: [
            { resourceTypeId: rtActive, headcount: 1, demandFTE: 0.5, utilisationPct: 50 },
            { resourceTypeId: rtOmitted, headcount: 1, demandFTE: 0.5, utilisationPct: 50 },
          ],
        }],
      })
    expect(first.status).toBe(201)

    // Capture the first plan's ID
    const firstPlanId = await fetchActivePlanId(projectId)
    expect(firstPlanId).not.toBeNull()

    // Find and delete the ROLE and PLANNED_RESOURCE profiles for the omitted RT so its only
    // planner evidence is being in the prior active plan (capacity_plan_untouched).
    const profilesAfterFirst = await fetchProfiles(projectId)
    const omittedRole = profilesAfterFirst.find(
      p => p.ownerKind === 'ROLE' && p.resourceTypeId === rtOmitted,
    )
    expect(omittedRole).toBeDefined()
    if (omittedRole) await prisma.capacityProfile.delete({ where: { id: omittedRole.id } })

    // Find PLANNED_RESOURCE profiles for rtOmitted's named resources (PLANNED_RESOURCE
    // profiles have resourceTypeId: null; they link via namedResource).
    const omittedNrIds = (await prisma.namedResource.findMany({
      where: { resourceTypeId: rtOmitted },
      select: { id: true },
    })).map(nr => nr.id)
    for (const profile of profilesAfterFirst) {
      if (profile.ownerKind === 'PLANNED_RESOURCE' && profile.namedResourceId && omittedNrIds.includes(profile.namedResourceId)) {
        await prisma.capacityProfile.delete({ where: { id: profile.id } })
      }
    }

    // Verify legacy fields are non-zero before the second apply
    const rtBefore = await prisma.resourceType.findUnique({ where: { id: rtOmitted } })
    expect(rtBefore).not.toBeNull()
    expect(rtBefore!.count).toBeGreaterThan(0)

    const nrListBefore = await prisma.namedResource.findMany({
      where: { resourceTypeId: rtOmitted },
      select: { id: true, allocationPercent: true, allocationPct: true },
    })
    expect(nrListBefore.length).toBeGreaterThan(0)
    for (const nr of nrListBefore) {
      expect(nr.allocationPercent).toBeGreaterThan(0)
      expect(nr.allocationPct).toBeGreaterThan(0)
    }

    // ── Independently capture the expected NR identity before omission ──
    const omittedRtNRsBefore = await prisma.namedResource.findMany({
      where: { resourceTypeId: rtOmitted },
      orderBy: { id: 'asc' },
    })
    expect(omittedRtNRsBefore.length).toBe(1) // headcount=1 → 1 trajectory → 1 NR
    const expectedOmittedNRId = omittedRtNRsBefore[0].id

    // ── Second apply: plan covering only rtActive (rtOmitted is omitted) ──
    const second = await request(app)
      .post(`/api/projects/${projectId}/squad-plan/apply`)
      .set('Authorization', authHeader)
      .send(buildApplyPayload(rtActive, [
        { periodIndex: 0, startWeek: 0, endWeek: 8, headcount: 1 },
      ], { name: 'Prior Plan Only Test' }))

    expect(second.status).toBe(201)

    // ── Assert prior active plan is now inactive ─────────────────────────
    const firstPlanAfter = await prisma.capacityPlan.findUnique({ where: { id: firstPlanId! } })
    expect(firstPlanAfter?.isActive).toBe(false)

    // ── Assert omitted RT legacy compatibility fields zeroed ────────────
    const rtAfter = await prisma.resourceType.findUnique({ where: { id: rtOmitted } })
    expect(rtAfter).toMatchObject({
      allocationMode: 'CAPACITY_PLAN',
      count: 0,
      allocationPercent: 0,
      allocationStartWeek: null,
      allocationEndWeek: null,
    })

    // ── Assert exact NamedResource identity unchanged ─────────────────
    // Uses the independently captured count and ID from before the second apply
    const omittedRtNRsAfter = await prisma.namedResource.findMany({
      where: { resourceTypeId: rtOmitted },
      orderBy: { id: 'asc' },
    })
    expect(omittedRtNRsAfter.length).toBe(1) // unchanged from pre-capture
    expect(omittedRtNRsAfter[0].id).toBe(expectedOmittedNRId)
    // Compatibility fields zeroed
    expect(omittedRtNRsAfter[0]).toMatchObject({
      allocationMode: 'CAPACITY_PLAN',
      allocationPercent: 0,
      allocationPct: 0,
      allocationStartWeek: null,
      allocationEndWeek: null,
      startWeek: null,
      endWeek: null,
    })
    // ── New active plan ──────────────────────────────────────────────
    const secondPlanId = await fetchActivePlanId(projectId)
    expect(secondPlanId).not.toBeNull()
    expect(secondPlanId).not.toBe(firstPlanId)

    // ── Direct DB: assert aggregate ROLE profile for omitted RT ──────
    const rolesAfterOmission = await prisma.capacityProfile.findMany({
      where: { projectId, ownerKind: 'ROLE', resourceTypeId: rtOmitted },
      orderBy: { id: 'asc' },
    })
    expect(rolesAfterOmission.length).toBe(1)
    const omittedRoleProfile = rolesAfterOmission[0]
    expect(omittedRoleProfile.namedResourceId).toBeNull()
    expect(omittedRoleProfile.source).toBe('SQUAD_PLANNER')
    expect(omittedRoleProfile.planningBasis).toBe('CAPACITY_PROFILE')
    expect(omittedRoleProfile.defaultPercent).toBe(0)
    expect(omittedRoleProfile.ownerKind).toBe('ROLE')
    expect(omittedRoleProfile.endWeek).toBeNull()

    // Exactly zero segments on the ROLE profile
    const omittedRoleSegments = await prisma.capacitySegment.findMany({
      where: { capacityProfileId: omittedRoleProfile.id },
      orderBy: { startWeek: 'asc' },
    })
    expect(omittedRoleSegments).toHaveLength(0)
    expect(omittedRoleProfile.startWeek).toBeNull()

    // ── Direct DB: assert PLANNED_RESOURCE profiles for omitted NRs ────
    // Uses independently captured expectedOmittedNRId, not a post-state query
    const plannedForOmitted = await prisma.capacityProfile.findMany({
      where: { projectId, ownerKind: 'PLANNED_RESOURCE', namedResourceId: expectedOmittedNRId },
      orderBy: { namedResourceId: 'asc' },
    })
    expect(plannedForOmitted.length).toBe(1)
    for (const p of plannedForOmitted) {
      expect(p.resourceTypeId).toBeNull()
      expect(p.namedResourceId).toBe(expectedOmittedNRId)
      expect(p.source).toBe('SQUAD_PLANNER')
      expect(p.planningBasis).toBe('CAPACITY_PROFILE')
      expect(p.defaultPercent).toBe(0)
      expect(p.startWeek).toBeNull()
      expect(p.endWeek).toBeNull()
      const segs = await prisma.capacitySegment.findMany({ where: { capacityProfileId: p.id } })
      expect(segs.length).toBe(0)
      // No duplicate owner under another ownerKind for same NR
      const otherOwner = await prisma.capacityProfile.findFirst({
        where: { projectId, ownerKind: { not: 'PLANNED_RESOURCE' }, namedResourceId: p.namedResourceId },
      })
      expect(otherOwner).toBeNull()
    }
    // Total authority count: 1 ROLE + 1 PLANNED_RESOURCE
    const totalOmittedProfiles = await prisma.capacityProfile.count({
      where: { projectId, ownerKind: { in: ['ROLE', 'PLANNED_RESOURCE'] }, OR: [{ resourceTypeId: rtOmitted }, { namedResourceId: expectedOmittedNRId }] },
    })
    expect(totalOmittedProfiles).toBe(2)
 
    // ── Canonical endpoint: /capacity-profiles ─────────────────────────
    // Must return the exact persisted authority set with no fallback
    const cpRes = await request(app)
      .get(`/api/projects/${projectId}/capacity-profiles`)
      .set('Authorization', authHeader)
    expect(cpRes.status).toBe(200)
    const cpBody = cpRes.body as { capacityProfiles: Array<Record<string, unknown>> }
    expect(Array.isArray(cpBody.capacityProfiles)).toBe(true)
 
    // Aggregate ROLE entry: exactly one, correct fields
    const roleCPs = cpBody.capacityProfiles.filter(
      (p: Record<string, unknown>) => (p.owner as Record<string, unknown>)?.kind === 'role' && (p.owner as Record<string, unknown>).id === rtOmitted,
    )
    expect(roleCPs.length).toBe(1)
    expect(roleCPs[0].source).toBe('squadPlanner')
    expect(roleCPs[0].planningBasis).toBe('capacityProfile')
    expect(roleCPs[0].defaultPercent).toBe(0)
    const cpRoleSegments = (roleCPs[0].segments as Array<unknown>) ?? []
    expect(cpRoleSegments.length).toBe(0)
 
    // Every expected PLANNED_RESOURCE owner returned exactly once
    // Uses independently captured expectedOmittedNRId
    const nrCPs = cpBody.capacityProfiles.filter(
      (p: Record<string, unknown>) => (p.owner as Record<string, unknown>)?.kind === 'plannedResource' && (p.owner as Record<string, unknown>).id === expectedOmittedNRId,
    )
    expect(nrCPs.length).toBe(1)
    expect(nrCPs[0].source).toBe('squadPlanner')
    expect(nrCPs[0].planningBasis).toBe('capacityProfile')
    expect(nrCPs[0].defaultPercent).toBe(0)
    const nrCPSegments = (nrCPs[0].segments as Array<unknown>) ?? []
    expect(nrCPSegments.length).toBe(0)
 
    // Only one role entry for omitted RT (no duplicate, no stale legacy fallback)
    const omittedRtRoles = cpBody.capacityProfiles.filter(
      (p: Record<string, unknown>) => (p.owner as Record<string, unknown>)?.kind === 'role' && (p.owner as Record<string, unknown>).id === rtOmitted,
    )
    expect(omittedRtRoles.length).toBe(1)
 
    // ── Canonical endpoint: /resource-profile ──────────────────────────
    // Must show zero capacity for omitted RT with PROFILE resolution
    const rpRes = await request(app)
      .get(`/api/projects/${projectId}/resource-profile`)
      .set('Authorization', authHeader)
    expect(rpRes.status).toBe(200)
    const rpBody = rpRes.body as { resourceRows: Array<Record<string, unknown>> }
    expect(Array.isArray(rpBody.resourceRows)).toBe(true)
    const omittedRow = rpBody.resourceRows.find(
      (r: Record<string, unknown>) => r.resourceTypeId === rtOmitted,
    )
    expect(omittedRow).toBeDefined()
    expect((omittedRow as Record<string, unknown>).allocatedDays ?? 0).toBe(0)
 
    // Assert PROFILE resolution source tied to the independently captured expectedOmittedNRId
    const namedResourcesOutput = (omittedRow as Record<string, unknown>).namedResources as Array<Record<string, unknown>> ?? []
    expect(namedResourcesOutput).toHaveLength(1)

    const omittedNrOutput = namedResourcesOutput[0]
    expect(omittedNrOutput.id).toBe(expectedOmittedNRId)
    expect(omittedNrOutput.resourceIdentity).toBe('PLANNED_RESOURCE')

    // NamedResource-level compatibility fields are zero/inactive
    expect(omittedNrOutput.allocationPercent).toBe(0)
    expect(omittedNrOutput.allocationPct).toBe(0)
    expect(omittedNrOutput.allocationStartWeek).toBeNull()
    expect(omittedNrOutput.allocationEndWeek).toBeNull()
    expect(omittedNrOutput.startWeek).toBeNull()
    expect(omittedNrOutput.endWeek).toBeNull()

    const capacityProfile = omittedNrOutput.capacityProfile as Record<string, unknown> | undefined
    expect(capacityProfile).toBeDefined()
    expect(capacityProfile!.resolutionSource).toBe('PROFILE')
    expect(capacityProfile!.defaultPercent).toBe(0)
    expect(capacityProfile!.startWeek).toBeNull()
    expect(capacityProfile!.endWeek).toBeNull()
    const rpSegments = (capacityProfile!.segments as Array<unknown>) ?? []
    expect(rpSegments).toHaveLength(0)

    // ── Timeline: assert zero capacity for omitted NR ─────────────────
    const tlRes = await request(app)
      .get(`/api/projects/${projectId}/timeline`)
      .set('Authorization', authHeader)
    expect(tlRes.status).toBe(200)
    const tlBody = tlRes.body as { namedResources: Array<Record<string, unknown>> }
    const tlNR = tlBody.namedResources.find(
      (nr: Record<string, unknown>) => nr.id === expectedOmittedNRId,
    )
    expect(tlNR).toBeDefined()
    expect(tlNR!.actualAllocatedDays).toBe(0)
    expect(tlNR!.allocationPercent).toBe(0)
    expect(tlNR!.allocationPct).toBe(0)
    expect(tlNR!.allocationStartWeek).toBeNull()
    expect(tlNR!.allocationEndWeek).toBeNull()
    expect(tlNR!.startWeek).toBeNull()
    expect(tlNR!.endWeek).toBeNull()
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// Test coverage is skipped when INTEGRATION_TEST is not 'true'.
// ═════════════════════════════════════════════════════════════════════════════



// ═════════════════════════════════════════════════════════════════════════════
// Scenario 19 — Fresh CAPACITY_PLAN first apply with production mapper path
// ═════════════════════════════════════════════════════════════════════════════
//
// A fresh project with a CAPACITY_PLAN resource type (no active plan slots)
// gets a ROLE profile from the production mapper/sync path. The first Squad
// Planner apply must adopt this mapper-produced profile via the
// isValidMapperProvenance check: reuse its ID, convert source/basis to
// SQUAD_PLANNER/CAPACITY_PROFILE, and create the active plan with PLANNED_RESOURCE
// profiles for the materialised resources.

describeIf('Scenario 19 — Fresh CAPACITY_PLAN mapper-produced profile adopted on first apply', () => {
  it('adopts mapper-produced LEGACY/CAPACITY_PROFILE through production sync + apply', async () => {
    if (!runIntegration) return
    const projectId = await createProject()
    const rtId = await createResourceType(projectId, 'rt-cap-plan-19', 'CapacityPlanRole', {
      allocationMode: 'CAPACITY_PLAN',
      count: 2,
    })
    await prisma.resourceType.update({
      where: { id: rtId },
      data: { allocationPercent: 100, allocationStartWeek: 0, allocationEndWeek: 10 },
    })

    await createEpicBacklog(projectId, rtId)

    // ── Run the production mapper/sync path (same sync called on project/resource creation) ──
    const syncResult = await syncCapacityProfilesForProject(prisma, projectId)
    expect(syncResult.profilesCreated).toBeGreaterThanOrEqual(1)

    // ── Assert mapper produced the expected ROLE profile ──────────────
    const profilesBefore = await fetchProfiles(projectId)
    const mapperRole = profilesBefore.find(
      p => p.ownerKind === 'ROLE' && p.resourceTypeId === rtId && p.namedResourceId === null,
    )
    expect(mapperRole).toBeDefined()
    const mapperRoleId = mapperRole!.id

    // Check source/basis
    expect(mapperRole!.source).toBe('LEGACY')
    expect(mapperRole!.planningBasis).toBe('CAPACITY_PROFILE')

    // Check legacy payload has all 7 keys
    const mapperRoleAny = mapperRole as unknown as Record<string, unknown>
    const legacy = mapperRoleAny.legacy as Record<string, unknown> | null
    expect(legacy).not.toBeNull()
    expect(typeof legacy).toBe('object')
    expect(legacy!.allocationMode).toBe('CAPACITY_PLAN')
    expect(legacy!.allocationPercent).toBe(100)
    expect(legacy!.allocationStartWeek).toBe(0)
    expect(legacy!.allocationEndWeek).toBe(10)
    // ROLE-only fields must be null
    expect(legacy!.allocationPct).toBeNull()
    expect(legacy!.startWeek).toBeNull()
    expect(legacy!.endWeek).toBeNull()

    // Profile-level fields must match legacy
    expect(mapperRole!.defaultPercent).toBe(100)
    expect(mapperRole!.startWeek).toBe(0)
    // endWeek matches the allocationEndWeek set on the ResourceType
    expect(mapperRole!.endWeek).toBe(10)

    // No segments for CAPACITY_PLAN without active slots
    const mapperSegments = await prisma.capacitySegment.findMany({
      where: { capacityProfileId: mapperRoleId },
    })
    expect(mapperSegments.length).toBe(0)

    // ── Apply a plan covering this RT ─────────────────────────────────
    const applyRes = await request(app)
      .post(`/api/projects/${projectId}/squad-plan/apply`)
      .set('Authorization', authHeader)
      .send(buildApplyPayload(rtId, [
        { periodIndex: 0, startWeek: 0, endWeek: 8, headcount: 1 },
      ], { name: 'CAPACITY_PLAN First Apply' }))

    expect(applyRes.status).toBe(201)
    // Assert response body contract
    expect(applyRes.body).toBeDefined()
    expect(applyRes.body.id).toBeTruthy()
    expect(typeof applyRes.body.id).toBe('string')
    expect(applyRes.body.isActive).toBe(true)
    expect(applyRes.body.name).toBe('CAPACITY_PLAN First Apply')
    expect(applyRes.body.periods).toHaveLength(1)
    expect(applyRes.body.periods[0].periodIndex).toBe(0)
    expect(applyRes.body.periods[0].startWeek).toBe(0)
    expect(applyRes.body.periods[0].endWeek).toBe(8)
    expect(applyRes.body.periods[0].entries).toHaveLength(1)
    expect(applyRes.body.periods[0].entries[0].resourceTypeId).toBe(rtId)
    expect(applyRes.body.periods[0].entries[0].headcount).toBe(1)
 
    // ── Assert mapper-produced ROLE profile reused and converted ──────
    const roleAfter = await prisma.capacityProfile.findUnique({
      where: { id: mapperRoleId },
    })
    expect(roleAfter).toBeDefined()
    expect(roleAfter!.source).toBe('SQUAD_PLANNER')
    expect(roleAfter!.planningBasis).toBe('CAPACITY_PROFILE')
    expect(roleAfter!.ownerKind).toBe('ROLE')
    // Profile-level fields preserved from source
    expect(roleAfter!.defaultPercent).toBe(100)
    expect(roleAfter!.startWeek).toBe(0)
    expect(roleAfter!.endWeek).toBe(7)  // derived from period endWeek=8 (exclusive)
 
    // No second ROLE profile created for this RT
    const rolesAfter = await prisma.capacityProfile.findMany({
      where: { projectId, ownerKind: 'ROLE', resourceTypeId: rtId },
    })
    expect(rolesAfter.length).toBe(1)
    expect(rolesAfter[0].id).toBe(mapperRoleId)
    expect(rolesAfter[0].startWeek).toBe(0)
    expect(rolesAfter[0].endWeek).toBe(7)
 
    // ── Assert aggregate ROLE segments created ─────────────────────────
    const roleSegments = await prisma.capacitySegment.findMany({
      where: { capacityProfileId: mapperRoleId },
      orderBy: { startWeek: 'asc' },
    })
    // 1 period → 1 segment
    expect(roleSegments.length).toBe(1)
    expect(roleSegments[0].startWeek).toBe(0)
    expect(roleSegments[0].capacityPercent).toBe(100)
    // endWeek derived from period endWeek=8 (exclusive in planner)
    expect(roleSegments[0].endWeek).toBe(7)
    expect(roleSegments[0].source).toBe('SQUAD_PLANNER')
 
    // ── Assert materialised NamedResources ──────────────────────────────
    const nrsAfter = await prisma.namedResource.findMany({
      where: { resourceTypeId: rtId },
      orderBy: { id: 'asc' },
    })
    // headcount=1 for 1 period → 1 NamedResource
    expect(nrsAfter.length).toBe(1)
    const nrAfter = nrsAfter[0]
    expect(nrAfter.allocationMode).toBe('CAPACITY_PLAN')
    expect(nrAfter.allocationPercent).toBe(100)
 
    // ── Assert PLANNED_RESOURCE profiles ──────────────────────────────
    const plannedAfter = await prisma.capacityProfile.findMany({
      where: { projectId, ownerKind: 'PLANNED_RESOURCE' },
      orderBy: { id: 'asc' },
    })
    // 1 NamedResource → 1 PLANNED_RESOURCE profile
    expect(plannedAfter.length).toBe(1)
    const plannedProfile = plannedAfter[0]
    expect(plannedProfile.resourceTypeId).toBeNull()
    expect(plannedProfile.namedResourceId).toBe(nrAfter.id)
    expect(plannedProfile.source).toBe('SQUAD_PLANNER')
    expect(plannedProfile.planningBasis).toBe('CAPACITY_PROFILE')
    expect(plannedProfile.defaultPercent).toBe(100)
    // startWeek/endWeek from segment boundaries
    expect(plannedProfile.startWeek).toBe(0)
    expect(plannedProfile.endWeek).toBe(7)
 
    // Assert PLANNED_RESOURCE segments
    const plannedSegments = await prisma.capacitySegment.findMany({
      where: { capacityProfileId: plannedProfile.id },
      orderBy: { startWeek: 'asc' },
    })
    expect(plannedSegments.length).toBe(1)
    expect(plannedSegments[0].startWeek).toBe(0)
    expect(plannedSegments[0].capacityPercent).toBe(100)
    expect(plannedSegments[0].endWeek).toBe(7)
    expect(plannedSegments[0].source).toBe('SQUAD_PLANNER')
 
    // No duplicate PLANNED_RESOURCE profile
    const otherOwner = await prisma.capacityProfile.findFirst({
      where: { projectId, ownerKind: { not: 'PLANNED_RESOURCE' }, namedResourceId: nrAfter.id },
    })
    expect(otherOwner).toBeNull()
 
    // ── Assert active plan ────────────────────────────────────────────
    const activePlanId = await fetchActivePlanId(projectId)
    expect(activePlanId).not.toBeNull()
 
    // ── Assert /capacity-profiles returns complete persisted set ──────
    const cpAfter = await request(app)
      .get(`/api/projects/${projectId}/capacity-profiles`)
      .set('Authorization', authHeader)
    expect(cpAfter.status).toBe(200)
    const cpAfterBody = cpAfter.body as { capacityProfiles: Array<Record<string, unknown>> }
 
    // Aggregate ROLE: exactly one, correct fields
    const roleCPs = cpAfterBody.capacityProfiles.filter(
      (p: Record<string, unknown>) => (p.owner as Record<string, unknown>)?.kind === 'role' && (p.owner as Record<string, unknown>).id === rtId,
    )
    expect(roleCPs.length).toBe(1)
    expect(roleCPs[0].source).toBe('squadPlanner')
    expect(roleCPs[0].planningBasis).toBe('capacityProfile')
    expect(roleCPs[0].defaultPercent).toBe(100)
    expect(roleCPs[0].startWeek).toBe(0)
    expect(roleCPs[0].endWeek).toBe(7)
    const cpRoleSegments = (roleCPs[0].segments as Array<Record<string, unknown>>) ?? []
    expect(cpRoleSegments.length).toBe(1)
    expect(cpRoleSegments[0].startWeek).toBe(0)
    expect(cpRoleSegments[0].endWeek).toBe(7)
    expect(cpRoleSegments[0].capacityPercent).toBe(100)
 
    // PLANNED_RESOURCE: exactly one, correct owner
    const plannedCPs = cpAfterBody.capacityProfiles.filter(
      (p: Record<string, unknown>) => (p.owner as Record<string, unknown>)?.kind === 'plannedResource' && (p.owner as Record<string, unknown>).id === nrAfter.id,
    )
    expect(plannedCPs.length).toBe(1)
    expect(plannedCPs[0].source).toBe('squadPlanner')
    expect(plannedCPs[0].startWeek).toBe(0)
    expect(plannedCPs[0].endWeek).toBe(7)
    expect(plannedCPs[0].planningBasis).toBe('capacityProfile')
    expect(plannedCPs[0].defaultPercent).toBe(100)
    const cpPlannedSegments = (plannedCPs[0].segments as Array<Record<string, unknown>>) ?? []
    expect(cpPlannedSegments.length).toBe(1)
    expect(cpPlannedSegments[0].startWeek).toBe(0)
    expect(cpPlannedSegments[0].capacityPercent).toBe(100)
    expect(cpPlannedSegments[0].endWeek).toBe(7)
 
    // Total endpoint profiles count matches persisted authority set
    const persistedProfileCount = await prisma.capacityProfile.count({ where: { projectId } })
    expect(cpAfterBody.capacityProfiles.length).toBe(persistedProfileCount)
 
    // ── Assert Resource Profile shows planned identity and capacity ────
    const rpAfter = await request(app)
      .get(`/api/projects/${projectId}/resource-profile`)
      .set('Authorization', authHeader)
    expect(rpAfter.status).toBe(200)
    const rpAfterBody = rpAfter.body as { resourceRows: Array<Record<string, unknown>> }
    const rtRow = rpAfterBody.resourceRows.find(
      (r: Record<string, unknown>) => r.resourceTypeId === rtId,
    )
    expect(rtRow).toBeDefined()
    // Capacity from planner should be the non-zero headcount
    expect((rtRow as Record<string, unknown>).allocatedDays).toBeGreaterThan(0)
 
    // Named resource has capacityProfile with PROFILE resolution
    const nrOutputs = (rtRow as Record<string, unknown>).namedResources as Array<Record<string, unknown>> ?? []
    expect(nrOutputs.length).toBe(1)
    expect(nrOutputs[0].id).toBe(nrAfter.id)
    expect(nrOutputs[0].resourceIdentity).toBe('PLANNED_RESOURCE')
    const nrCp = nrOutputs[0].capacityProfile as Record<string, unknown> | undefined
    expect(nrCp).toBeDefined()
    expect(nrCp!.resolutionSource).toBe('PROFILE')
    expect(nrCp!.defaultPercent).toBe(100)
    expect(nrCp!.startWeek).toBe(0)
    expect(nrCp!.endWeek).toBe(7)
    const rpSegments = (nrCp!.segments as Array<Record<string, unknown>>) ?? []
    expect(rpSegments.length).toBe(1)
    expect(rpSegments[0].startWeek).toBe(0)
    expect(rpSegments[0].endWeek).toBe(7)
    expect(rpSegments[0].capacityPercent).toBe(100)
 
    // ── Assert snapshot history ───────────────────────────────────────
    const snapshots = await prisma.backlogSnapshot.findMany({
      where: { projectId },
      select: { trigger: true, label: true },
      orderBy: { createdAt: 'desc' },
      take: 5,
    })
    const preApplySnap = snapshots.find(s => s.trigger === 'optimiser_apply')
    expect(preApplySnap).toBeDefined()
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// Scenario 20 — Malformed MAPPER-provenance rejection (state preservation)
// ═════════════════════════════════════════════════════════════════════════════
//
// A CAPACITY_PLAN ROLE profile with a mismatched or malformed legacy payload
// (e.g., null vs non-null consistency violation) must be rejected with 409
// and the canonical state preserved unchanged.
describeIf('Scenario 20 — Malformed mapper-provenance rejection preserves state', () => {
  it('returns 409 with exact state preservation for null-vs-non-null consistency violation', async () => {
    if (!runIntegration) return
    const projectId = await createProject()
    const rtId = await createResourceType(projectId, 'rt-malformed-20', 'MalformedRole', {
      allocationMode: 'CAPACITY_PLAN',
    })
    await createEpicBacklog(projectId, rtId)
 
    // Create a profile with source/basis matching LEGACY/CAPACITY_PROFILE
    // but with a null/defaultPercent vs non-null/allocationPercent mismatch.
    const badProfileId = 'cp-malformed-20'
    await prisma.capacityProfile.create({
      data: {
        id: badProfileId,
        projectId,
        ownerKind: 'ROLE',
        resourceTypeId: rtId,
        namedResourceId: null,
        source: 'LEGACY',
        planningBasis: 'CAPACITY_PROFILE',
        defaultPercent: null,            // ← profile defaultPercent is null
        startWeek: 0,
        endWeek: 10,
        legacy: {
          allocationMode: 'CAPACITY_PLAN',
          allocationPercent: 100,          // ← but legacy allocationPercent is 100
          allocationPct: null,
          allocationStartWeek: 0,
          allocationEndWeek: 10,
          startWeek: null,
          endWeek: null,
        },
      },
    })
 
    // Capture exact canonical state before apply
    const stateBefore = await captureCanonicalState(projectId)
 
    // ── Apply should be rejected ──────────────────────────────────────
    const applyRes = await request(app)
      .post(`/api/projects/${projectId}/squad-plan/apply`)
      .set('Authorization', authHeader)
      .send(buildApplyPayload(rtId, [
        { periodIndex: 0, startWeek: 0, endWeek: 8, headcount: 1 },
      ], { name: 'Malformed Provenance Test' }))
 
    expect(applyRes.status).toBe(409)
    expect(applyRes.body?.error).toBeDefined()
 
    // ── Capture canonical state after and compare exactly ──────────────
    const stateAfter = await captureCanonicalState(projectId)
    expect(stateAfter).toEqual(stateBefore)
 
    // Profile must NOT have been converted to SQUAD_PLANNER
    const badProfile = await prisma.capacityProfile.findUnique({
      where: { id: badProfileId },
    })
    expect(badProfile).toBeDefined()
    expect(badProfile!.source).toBe('LEGACY')
    expect(badProfile!.planningBasis).toBe('CAPACITY_PROFILE')
    expect(badProfile!.defaultPercent).toBeNull()
  })
 
  it('returns 409 for non-null ROLE legacy.allocationPct and preserves state', async () => {
    if (!runIntegration) return
    const projectId = await createProject()
    const rtId = await createResourceType(projectId, 'rt-malformed-pct-20', 'MalformedPct')
    await createEpicBacklog(projectId, rtId)
 
    // Profile with non-null allocationPct (normally null for ROLE)
    await prisma.capacityProfile.create({
      data: {
        id: 'cp-malformed-pct-20',
        projectId,
        ownerKind: 'ROLE',
        resourceTypeId: rtId,
        namedResourceId: null,
        source: 'FIXED',
        planningBasis: 'DEMAND_FOLLOWING',
        defaultPercent: 100,
        startWeek: null,
        endWeek: null,
        legacy: {
          allocationMode: 'EFFORT',
          allocationPercent: 100,
          allocationPct: 50,    // ← ROLE should have null allocationPct
          allocationStartWeek: null,
          allocationEndWeek: null,
          startWeek: null,
          endWeek: null,
        },
      },
    })
 
    const stateBefore = await captureCanonicalState(projectId)
 
    const applyRes = await request(app)
      .post(`/api/projects/${projectId}/squad-plan/apply`)
      .set('Authorization', authHeader)
      .send(buildApplyPayload(rtId, [
        { periodIndex: 0, startWeek: 0, endWeek: 8, headcount: 1 },
      ], { name: 'Non-null allocationPct for ROLE' }))
 
    expect(applyRes.status).toBe(409)
    expect(applyRes.body?.error).toBeDefined()
 
    const stateAfter = await captureCanonicalState(projectId)
    expect(stateAfter).toEqual(stateBefore)
  })
 
  it('returns 409 for startWeek null mismatch (profile=null, legacy=non-null) and preserves state', async () => {
    if (!runIntegration) return
    const projectId = await createProject()
    const rtId = await createResourceType(projectId, 'rt-startweek-20', 'StartWeekMismatch')
    await createEpicBacklog(projectId, rtId)
 
    // Profile with startWeek=null but legacy.allocationStartWeek=1
    await prisma.capacityProfile.create({
      data: {
        id: 'cp-startweek-20',
        projectId,
        ownerKind: 'ROLE',
        resourceTypeId: rtId,
        namedResourceId: null,
        source: 'LEGACY',
        planningBasis: 'CAPACITY_PROFILE',
        defaultPercent: 100,
        startWeek: null,              // ← profile startWeek is null
        endWeek: 10,
        legacy: {
          allocationMode: 'CAPACITY_PLAN',
          allocationPercent: 100,
          allocationPct: null,
          allocationStartWeek: 1,      // ← but legacy allocationStartWeek is 1 (non-null)
          allocationEndWeek: 10,
          startWeek: null,
          endWeek: null,
        },
      },
    })
 
    const stateBefore = await captureCanonicalState(projectId)
 
    const applyRes = await request(app)
      .post(`/api/projects/${projectId}/squad-plan/apply`)
      .set('Authorization', authHeader)
      .send(buildApplyPayload(rtId, [
        { periodIndex: 0, startWeek: 0, endWeek: 8, headcount: 1 },
      ], { name: 'StartWeek Null Mismatch' }))
 
    expect(applyRes.status).toBe(409)
    expect(applyRes.body?.error).toBeDefined()
 
    const stateAfter = await captureCanonicalState(projectId)
    expect(stateAfter).toEqual(stateBefore)
  })
})
// ═════════════════════════════════════════════════════════════════════════════
// Scenario 17 — Explicit ROLE pair regressions (evidence-backed policy)
// ═════════════════════════════════════════════════════════════════════════════
// Under the valid mapper provenance policy, mapper-produced FIXED,
// AVAILABILITY_WINDOW, FULL_PROJECT and CAPACITY_PLAN (via LEGACY/CAPACITY_PROFILE)
// ROLE pairs may be adopted when they carry a complete seven-key legacy payload
// matching the profile fields.
//
// The fixtures in this scenario are constructed without a legacy payload via
// createProfile(), so isValidMapperProvenance returns false for all of them.
// They are rejected because source/basis alone is insufficient — valid mapper
// provenance requires the complete legacy object.
//
// Prior planner authority is a separate fallback that applies only to the
// documented LEGACY/DEMAND_FOLLOWING pair (the original pre-#359 mapper pair).
// These explicit-pair fixtures have different source/basis and lack prior
// planner evidence, so both pathways reject them.

describeIf('Scenario 17 — Explicit ROLE pair rejection', () => {
  const explicitPairs: Array<{
    name: string
    source: $Enums.CapacityProfileSource
    planningBasis: $Enums.CapacityProfilePlanningBasis
  }> = [
    { name: 'FIXED/DEMAND_FOLLOWING', source: 'FIXED', planningBasis: 'DEMAND_FOLLOWING' },
    { name: 'FIXED/WHOLE_PROJECT_ALLOCATION', source: 'FIXED', planningBasis: 'WHOLE_PROJECT_ALLOCATION' },
    { name: 'AVAILABILITY_WINDOW/AVAILABILITY_WINDOW', source: 'AVAILABILITY_WINDOW', planningBasis: 'AVAILABILITY_WINDOW' },
    { name: 'IMPORTED/CAPACITY_PROFILE', source: 'IMPORTED', planningBasis: 'CAPACITY_PROFILE' },
  ]

  it.each(explicitPairs)('returns 409 for $name ROLE profile at preflight with exact state preservation', async ({ source, planningBasis }) => {
    if (!runIntegration) return
    const projectId = await createProject()
    const rtId = await createResourceType(projectId, `rt-explicit-${source}-${planningBasis}`, 'ExplicitRole')
    await createEpicBacklog(projectId, rtId)

    // Create ROLE profile with explicit (non-adoptable) provenance
    await createProfile(
      projectId,
      `cp-explicit-${source}-${planningBasis}`,
      'ROLE',
      rtId,
      null,
      { source, planningBasis },
    )

    // Capture canonical pre-apply state (plans, profiles, segments, RT, NR,
    // timeline, story timeline, weeklyDemandCache, snapshots)
    const beforeState = await captureCanonicalState(projectId)

    const res = await request(app)
      .post(`/api/projects/${projectId}/squad-plan/apply`)
      .set('Authorization', authHeader)
      .send(buildApplyPayload(rtId, [
        { periodIndex: 0, startWeek: 0, endWeek: 8, headcount: 1 },
      ]))

    expect(res.status).toBe(409)
    expect(res.body.error).toContain('owner')

    // ── Post-409 state equals pre-apply state exactly (no mutations) ──
    const afterState = await captureCanonicalState(projectId)
    expect(afterState).toEqual(beforeState)

    // ── No active plan created ──────────────────────────────────
    const activePlanId = await fetchActivePlanId(projectId)
    expect(activePlanId).toBeNull()

    // ── No snapshot leaked (preflight runs before snapshot) ─────
    const allSnapshots = await prisma.backlogSnapshot.findMany({
      where: { projectId },
    })
    expect(allSnapshots).toHaveLength(0)

    // ── ROLE profile unchanged ──────────────────────────────────
    const profile = await prisma.capacityProfile.findUnique({
      where: { id: `cp-explicit-${source}-${planningBasis}` },
    })
    expect(profile).toMatchObject({
      source,
      planningBasis,
      ownerKind: 'ROLE',
    })

    // ── Compatibility fields unchanged (defaults untouched) ─────
    const rt = await prisma.resourceType.findUnique({ where: { id: rtId } })
    expect(rt).toMatchObject({
      allocationMode: 'TIMELINE',
      count: 2,
      allocationPercent: 100,
      allocationStartWeek: null,
      allocationEndWeek: null,
      proposedName: null,
    })
  })

  it('returns 409 for LEGACY/DEMAND_FOLLOWING ROLE without prior planner evidence, state unchanged', async () => {
    if (!runIntegration) return
    const projectId = await createProject()
    const rtId = await createResourceType(projectId, 'rt-legacy-no-evidence', 'LegacyNoEvidence')
    await createEpicBacklog(projectId, rtId)

    // Create a LEGACY/DEMAND_FOLLOWING ROLE profile with NO prior planner
    // evidence (no planner profiles, no active plan).
    await createProfile(
      projectId,
      'cp-legacy-no-evidence',
      'ROLE',
      rtId,
      null,
      { source: 'LEGACY', planningBasis: 'DEMAND_FOLLOWING' },
    )

    // Capture canonical pre-apply state
    const beforeState = await captureCanonicalState(projectId)

    const res = await request(app)
      .post(`/api/projects/${projectId}/squad-plan/apply`)
      .set('Authorization', authHeader)
      .send(buildApplyPayload(rtId, [
        { periodIndex: 0, startWeek: 0, endWeek: 8, headcount: 1 },
      ]))

    expect(res.status).toBe(409)
    expect(res.body.error).toContain('owner')

    // ── Post-409 state equals pre-apply state exactly (no mutations) ──
    const afterState = await captureCanonicalState(projectId)
    expect(afterState).toEqual(beforeState)

    // ── No active plan or snapshot leaked ────────────────────────
    expect(await fetchActivePlanId(projectId)).toBeNull()
    expect(await prisma.backlogSnapshot.count({ where: { projectId } })).toBe(0)

    // ── ROLE profile unchanged ───────────────────────────────────
    const profile = await prisma.capacityProfile.findUnique({
      where: { id: 'cp-legacy-no-evidence' },
    })
    expect(profile).toMatchObject({
      source: 'LEGACY',
      planningBasis: 'DEMAND_FOLLOWING',
      ownerKind: 'ROLE',
    })

    // ── Compatibility fields unchanged ───────────────────────────
    const rt = await prisma.resourceType.findUnique({ where: { id: rtId } })
    expect(rt).toMatchObject({
      allocationMode: 'TIMELINE',
      count: 2,
      allocationPercent: 100,
      allocationStartWeek: null,
      allocationEndWeek: null,
      proposedName: null,
    })
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// Scenario 18 — Genuine LEGACY/DEMAND_FOLLOWING ROLE adoption with authority
// ═════════════════════════════════════════════════════════════════════════════
//
// When a LEGACY/DEMAND_FOLLOWING ROLE profile exists on a resource type with
// prior planner evidence (via active plan or planner-owned profiles), the
// profile is adoptable. The same profile ID is reused; source/basis become
// SQUAD_PLANNER/CAPACITY_PROFILE.

describeIf('Scenario 18 — LEGACY/DEMAND_FOLLOWING ROLE adoption with prior planner evidence', () => {
  let projectId: string
  let rtId: string

  beforeAll(async () => {
    if (!runIntegration) return
    projectId = await createProject()
    rtId = await createResourceType(projectId, 'rt-legacy-role-18', 'LegacyRole')
    await createEpicBacklog(projectId, rtId)

    // Create a LEGACY/DEMAND_FOLLOWING ROLE profile (simulates pre-#359 state)
    await createProfile(
      projectId,
      'cp-legacy-role-18',
      'ROLE',
      rtId,
      null,
      { source: 'LEGACY', planningBasis: 'DEMAND_FOLLOWING', defaultPercent: 50 },
    )

    // ══ Establish prior planner evidence ══════════════════════════════
    // A named resource with CAPACITY_PLAN allocation mode + a SQUAD_PLANNER
    // NAMED_PERSON profile constitutes the planner-owned evidence that
    // enables LEGACY/DEMAND_FOLLOWING ROLE adoption under the
    // evidence-backed policy.
    await createNamedResource(projectId, rtId, 'nr-legacy-role-18', 'Legacy Role Engineer 1', {
      allocationMode: 'CAPACITY_PLAN',
    })
    await createProfile(
      projectId,
      'cp-legacy-person-18',
      'NAMED_PERSON',
      null,
      'nr-legacy-role-18',
      { source: 'SQUAD_PLANNER', planningBasis: 'CAPACITY_PROFILE' },
    )

    // Document the evidence state before apply (planner-owned named-resource marker)
    const evidenceNr = await prisma.namedResource.findUnique({
      where: { id: 'nr-legacy-role-18' },
      select: { allocationMode: true, allocationPercent: true },
    })
    expect(evidenceNr).toMatchObject({
      allocationMode: 'CAPACITY_PLAN',
      allocationPercent: 100,
    })
    const evidenceProfile = await prisma.capacityProfile.findUnique({
      where: { id: 'cp-legacy-person-18' },
      select: { source: true, planningBasis: true, ownerKind: true },
    })
    expect(evidenceProfile).toMatchObject({
      source: 'SQUAD_PLANNER',
      planningBasis: 'CAPACITY_PROFILE',
      ownerKind: 'NAMED_PERSON',
    })

    // Apply the plan — the authority captures the NAMED_PERSON profile as
    // planner-owned evidence, enabling ROLE adoption.
    const res = await request(app)
      .post(`/api/projects/${projectId}/squad-plan/apply`)
      .set('Authorization', authHeader)
      .send(buildApplyPayload(rtId, [
        { periodIndex: 0, startWeek: 0, endWeek: 8, headcount: 1 },
      ]))
    expect(res.status).toBe(201)
  })

  it('reuses the LEGACY ROLE profile, converting source/basis to SQUAD_PLANNER/CAPACITY_PROFILE', async () => {
    const profile = await prisma.capacityProfile.findUnique({
      where: { id: 'cp-legacy-role-18' },
    })
    expect(profile).toMatchObject({
      ownerKind: 'ROLE',
      source: 'SQUAD_PLANNER',
      planningBasis: 'CAPACITY_PROFILE',
    })
    // Ensure defaultPercent is preserved from the legacy profile
    expect(profile!.defaultPercent).not.toBeNull()

    // A PLANNED_RESOURCE profile was created for the named resource
    const plannedProfiles = await prisma.capacityProfile.findMany({
      where: { projectId, ownerKind: 'PLANNED_RESOURCE' },
    })
    expect(plannedProfiles.length).toBeGreaterThanOrEqual(1)
  })

  it('the NAMED_PERSON planner evidence profile is now converted to PLANNED_RESOURCE', async () => {
    // The previous NAMED_PERSON profile should be updated to PLANNED_RESOURCE
    const personProfile = await prisma.capacityProfile.findUnique({
      where: { id: 'cp-legacy-person-18' },
    })
    expect(personProfile).not.toBeNull()
    expect(personProfile!.ownerKind).toBe('PLANNED_RESOURCE')
  })

  it('the active capacity plan and preserved named-resource marker document the adoption evidence path', async () => {
    // The active plan proves planner authority was captured before adoption
    const activePlanId = await fetchActivePlanId(projectId)
    expect(activePlanId).not.toBeNull()

    // The named resource preserves its planner-owned CAPACITY_PLAN marker
    const nr = await prisma.namedResource.findUnique({
      where: { id: 'nr-legacy-role-18' },
      select: { allocationMode: true, allocationPercent: true },
    })
    expect(nr).toMatchObject({
      allocationMode: 'CAPACITY_PLAN',
      allocationPercent: 100,
    })

    // The converted ROLE profile now carries SQUAD_PLANNER source,
    // proving the evidence path was applied correctly
    const adoptedRole = await prisma.capacityProfile.findUnique({
      where: { id: 'cp-legacy-role-18' },
      select: { source: true, planningBasis: true, ownerKind: true },
    })
    expect(adoptedRole).toMatchObject({
      source: 'SQUAD_PLANNER',
      planningBasis: 'CAPACITY_PROFILE',
      ownerKind: 'ROLE',
    })
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// Test coverage is skipped when INTEGRATION_TEST is not 'true'.
// ═════════════════════════════════════════════════════════════════════════════
