/**
 * capacityProfileTransfer.integration.test.ts — Real PostgreSQL integration tests
 * for issue #411 Squad Planner → manual capacity transfer.
 *
 * Tests the POST /api/projects/:id/capacity-profiles/transfer-to-manual endpoint
 * against the actual schema, asserting database state directly for:
 *
 *   - Successful transfer preserves profile IDs, segments, percentages, boundaries.
 *   - Effective weekly capacity is identical before and after transfer.
 *   - Profile source changes from SQUAD_PLANNER to MANUAL.
 *   - PLANNED_RESOURCE owners remain planned resources (no conversion to NAMED_PERSON).
 *   - Existing explicit/protected NAMED_PERSON profiles remain unchanged.
 *   - Unrelated roles remain unchanged.
 *   - Missing resource type returns 404.
 *   - Role not managed by Squad Planner returns 409.
 *   - Duplicate/malformed ownership returns 409.
 *   - Auth and project ownership checks.
 *   - Later Squad Planner apply cannot reclaim the transferred role.
 *   - Injected transactional failure rolls back all changes.
 *
 * All tests are skipped unless INTEGRATION_TEST=true.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '@prisma/client'
import type { $Enums } from '@prisma/client'
import { app } from '../app.js'
import { resolveSchedulerCapacity } from '../lib/schedulerCapacityResolver.js'
import { __setTransferFailureSeam } from '../lib/capacityProfileTransferService.js'

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
      email: `transfer-test-${Date.now()}@example.com`,
      name: 'Capacity Profile Transfer Integration Test',
      password: '$2b$10$placeholder',
    },
  })
  userId = user.id
  token = jwt.sign({ userId, role: 'USER' }, process.env.JWT_SECRET!)
  authHeader = `Bearer ${token}`
})

afterAll(async () => {
  if (!runIntegration) return

  // Cascade cleanup in dependency-safe order
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
    data: { name: `Transfer-Test-${Date.now()}`, ownerId: userId },
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

async function createNamedResource(
  _projectId: string,
  resourceTypeId: string,
  id: string,
  name: string,
  overrides: Partial<{
    allocationMode: $Enums.AllocationMode
    allocationPercent: number
    allocationPct: number
    allocationStartWeek: number | null
    allocationEndWeek: number | null
    startWeek: number | null
    endWeek: number | null
  }> = {},
): Promise<string> {
  await prisma.namedResource.create({
    data: {
      id,
      resourceTypeId,
      name,
      allocationMode: overrides.allocationMode ?? 'CAPACITY_PLAN',
      allocationPercent: overrides.allocationPercent ?? 100,
      allocationPct: overrides.allocationPct ?? 100,
      allocationStartWeek: overrides.allocationStartWeek ?? null,
      allocationEndWeek: overrides.allocationEndWeek ?? null,
      startWeek: overrides.startWeek ?? null,
      endWeek: overrides.endWeek ?? null,
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
      planningBasis: overrides.planningBasis ?? 'CAPACITY_PROFILE',
      source: overrides.source ?? 'SQUAD_PLANNER',
      defaultPercent: overrides.defaultPercent ?? null,
      startWeek: overrides.startWeek ?? null,
      endWeek: overrides.endWeek ?? null,
    },
  })
  return id
}

async function createSegment(
  capacityProfileId: string,
  startWeek: number,
  endWeek: number,
  capacityPercent: number,
  source: $Enums.CapacityProfileSource = 'SQUAD_PLANNER',
): Promise<void> {
  await prisma.capacitySegment.create({
    data: {
      capacityProfileId,
      startWeek,
      endWeek,
      capacityPercent,
      source,
    },
  })
}

async function createEpicBacklog(
  projectId: string,
  rtId: string,
): Promise<{ epicId: string; featureId: string; storyId: string }> {
  const epic = await prisma.epic.create({
    data: { name: 'Transfer Test Epic', projectId, order: 0 },
  })
  const feature = await prisma.feature.create({
    data: { name: 'Transfer Test Feature', epicId: epic.id, order: 0 },
  })
  const story = await prisma.userStory.create({
    data: { name: 'Transfer Test Story', featureId: feature.id, order: 0 },
  })
  await prisma.task.create({
    data: {
      name: 'Transfer Test Task',
      userStoryId: story.id,
      order: 0,
      hoursEffort: 8,
      resourceTypeId: rtId,
    },
  })
  return { epicId: epic.id, featureId: feature.id, storyId: story.id }
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

/**
 * Structural segment comparison — the fields the transfer must preserve exactly.
 * Excludes `source` (SQUAD_PLANNER → MANUAL) and `updatedAt` (row update) which
 * legitimately change during the transfer.
 */
function segmentStructuralFields(segments: SegmentRow[]) {
  return segments.map(({ id, capacityProfileId, startWeek, endWeek, capacityPercent }) => ({
    id,
    capacityProfileId,
    startWeek,
    endWeek,
    capacityPercent,
  }))
}

async function fetchNamedResources(resourceTypeId: string): Promise<Array<{
  id: string
  name: string
  allocationMode: string | null
  allocationPercent: number | null
  allocationStartWeek: number | null
  allocationEndWeek: number | null
}>> {
  return prisma.namedResource.findMany({
    where: { resourceTypeId },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: {
      id: true,
      name: true,
      allocationMode: true,
      allocationPercent: true,
      allocationStartWeek: true,
      allocationEndWeek: true,
    },
  })
}

/**
/**
 * Returns Map<week, totalPercent> for all segments across ROLE + PLANNED_RESOURCE profiles.
 */

// ═════════════════════════════════════════════════════════════════════════════
// Scenario 1 — Successful transfer of a planner-managed role
// ═════════════════════════════════════════════════════════════════════════════

describeIf('Scenario 1 — Successful transfer', () => {
  let projectId: string
  let rtId: string
  let nr1Id: string
  let nr2Id: string
  let roleProfileIdBefore: string
  let nrProfile1IdBefore: string
  let nrProfile2IdBefore: string
  let preTransferWeekly: Record<number, number>
  let preTransferRoleSegments: SegmentRow[]
  let preTransferNr1Segments: SegmentRow[]
  let preTransferNr2Segments: SegmentRow[]

  beforeAll(async () => {
    if (!runIntegration) return
    projectId = await createProject()
    rtId = await createResourceType(projectId, 'rt-transfer-s1', 'Transfer Engineer')

    // Create named resources (planner-created placeholders)
    nr1Id = await createNamedResource(projectId, rtId, 'nr-transfer-s1-1', 'Transfer Engineer 1')
    nr2Id = await createNamedResource(projectId, rtId, 'nr-transfer-s1-2', 'Transfer Engineer 2')

    // Create ROLE-level SQUAD_PLANNER profile with segments (profile-level windows are null for segmented CAPACITY_PROFILE)
    roleProfileIdBefore = await createProfile(
      projectId, 'cp-transfer-role-s1', 'ROLE', rtId, null,
      { planningBasis: 'CAPACITY_PROFILE', source: 'SQUAD_PLANNER', defaultPercent: 100, startWeek: null, endWeek: null },
    )
    await createSegment(roleProfileIdBefore, 0, 3, 100)
    await createSegment(roleProfileIdBefore, 4, 7, 100)
    await createSegment(roleProfileIdBefore, 8, 11, 25)

    // Create PLANNED_RESOURCE profiles with individual segments (profile-level windows are null)
    nrProfile1IdBefore = await createProfile(
      projectId, 'cp-transfer-nr1-s1', 'PLANNED_RESOURCE', null, nr1Id,
      { planningBasis: 'CAPACITY_PROFILE', source: 'SQUAD_PLANNER', defaultPercent: 100, startWeek: null, endWeek: null },
    )
    await createSegment(nrProfile1IdBefore, 0, 3, 100)
    await createSegment(nrProfile1IdBefore, 4, 7, 50)

    nrProfile2IdBefore = await createProfile(
      projectId, 'cp-transfer-nr2-s1', 'PLANNED_RESOURCE', null, nr2Id,
      { planningBasis: 'CAPACITY_PROFILE', source: 'SQUAD_PLANNER', defaultPercent: 50, startWeek: null, endWeek: null },
    )
    await createSegment(nrProfile2IdBefore, 4, 7, 50)
    await createSegment(nrProfile2IdBefore, 8, 11, 25)
  })

  it('transfers the role and preserves profile IDs', async () => {
    // ── Capture exact pre-transfer scheduler weekly capacity (hours) via the real resolver ──
    const { getWeeklyCapacity } = await import('../lib/scheduler.js')
    const resolvedBefore = await resolveSchedulerCapacity(prisma as any, projectId)
    const rtBefore = resolvedBefore.resourceTypes.find(rt => rt.id === rtId)
    expect(rtBefore).toBeDefined()
    preTransferWeekly = {}
    for (let w = 0; w <= 11; w++) {
      preTransferWeekly[w] = getWeeklyCapacity(rtBefore!, w, 8)
    }

    // Capture exact segment IDs/values before transfer for identity preservation
    preTransferRoleSegments = await fetchSegments(roleProfileIdBefore)
    preTransferNr1Segments = await fetchSegments(nrProfile1IdBefore)
    preTransferNr2Segments = await fetchSegments(nrProfile2IdBefore)

    const res = await request(app)
      .post(`/api/projects/${projectId}/capacity-profiles/transfer-to-manual`)
      .set('Authorization', authHeader)
      .send({ resourceTypeId: rtId })

    expect(res.status).toBe(200)
    expect(res.body.transferred).toBe(true)
    expect(res.body.result.roleProfileTransferred).toBe(true)
    expect(res.body.result.profilesTransferred).toBeGreaterThanOrEqual(2)
    expect(res.body.result.protectedProfileIds).toEqual([])
  })

  it('changes role profile source from SQUAD_PLANNER to MANUAL', async () => {
    const profiles = await fetchProfiles(projectId)
    const roleProfile = profiles.find(p => p.id === roleProfileIdBefore)
    expect(roleProfile).toBeDefined()
    expect(roleProfile!.source).toBe('MANUAL')
    expect(roleProfile!.ownerKind).toBe('ROLE')
    expect(roleProfile!.planningBasis).toBe('CAPACITY_PROFILE')
  })

  it('changes PLANNED_RESOURCE profile source from SQUAD_PLANNER to MANUAL and preserves profile data', async () => {
    const profiles = await fetchProfiles(projectId)
    const nr1Profile = profiles.find(p => p.id === nrProfile1IdBefore)
    expect(nr1Profile).toBeDefined()
    expect(nr1Profile!.source).toBe('MANUAL')
    expect(nr1Profile!.ownerKind).toBe('PLANNED_RESOURCE')
    // Profile defaultPercent and windows are preserved (not zeroed)
    expect(nr1Profile!.defaultPercent).toBe(100)
    expect(nr1Profile!.startWeek).toBeNull()
    expect(nr1Profile!.endWeek).toBeNull()

    const nr2Profile = profiles.find(p => p.id === nrProfile2IdBefore)
    expect(nr2Profile).toBeDefined()
    expect(nr2Profile!.source).toBe('MANUAL')
    expect(nr2Profile!.ownerKind).toBe('PLANNED_RESOURCE')
    expect(nr2Profile!.defaultPercent).toBe(50)
    expect(nr2Profile!.startWeek).toBeNull()
    expect(nr2Profile!.endWeek).toBeNull()
  })

  it('preserves ROLE and PLANNED_RESOURCE segment boundaries, percentages, and IDs', async () => {
    // ROLE segments are preserved
    const roleSegments = await fetchSegments(roleProfileIdBefore)
    expect(roleSegments).toHaveLength(3)
    expect(roleSegments[0]).toMatchObject({ startWeek: 0, endWeek: 3, capacityPercent: 100 })
    expect(roleSegments[1]).toMatchObject({ startWeek: 4, endWeek: 7, capacityPercent: 100 })
    expect(roleSegments[2]).toMatchObject({ startWeek: 8, endWeek: 11, capacityPercent: 25 })

    // PLANNED_RESOURCE segments are PRESERVED (not deleted)
    const nr1Segments = await fetchSegments(nrProfile1IdBefore)
    expect(nr1Segments).toHaveLength(2)
    expect(nr1Segments[0]).toMatchObject({ startWeek: 0, endWeek: 3, capacityPercent: 100 })
    expect(nr1Segments[1]).toMatchObject({ startWeek: 4, endWeek: 7, capacityPercent: 50 })

    const nr2Segments = await fetchSegments(nrProfile2IdBefore)
    expect(nr2Segments).toHaveLength(2)
    expect(nr2Segments[0]).toMatchObject({ startWeek: 4, endWeek: 7, capacityPercent: 50 })
    expect(nr2Segments[1]).toMatchObject({ startWeek: 8, endWeek: 11, capacityPercent: 25 })
  })

  it('preserves scheduler-visible effective weekly capacity via resolveSchedulerCapacity (exact parity)', async () => {
    const { getWeeklyCapacity } = await import('../lib/scheduler.js')
    const resolved = await resolveSchedulerCapacity(prisma as any, projectId)
    const rt = resolved.resourceTypes.find(rt => rt.id === rtId)
    expect(rt).toBeDefined()

    // Compute exact post-transfer weekly capacity
    const postTransferWeekly: Record<number, number> = {}
    for (let w = 0; w <= 11; w++) {
      postTransferWeekly[w] = getWeeklyCapacity(rt!, w, 8)
    }

    // EXACT equality for every tested week (including zero and transitions)
    expect(postTransferWeekly).toEqual(preTransferWeekly)

    // Verify the ROLE is the sole authority (roleSegments defined, not suppressed)
    expect(rt!.roleSegments).toBeDefined()
    expect(rt!.roleSegments!.length).toBeGreaterThan(0)

    // Transferred planned resources carry an explicit zero segment (issue
    // #418: zero capacity expressed through the DTO, never legacy fields),
    // so they cannot contribute independent capacity.
    for (const nr of rt!.namedResources) {
      if (nr.name.includes('Transfer Engineer')) {
        expect(nr.capacitySegments).toEqual([
          { startWeek: 0, endWeek: Infinity, allocationPercent: 0 },
        ])
      }
    }
  })

  it('preserves exact profile and segment IDs and boundaries after transfer', async () => {
    // Structural fields (id, capacityProfileId, startWeek, endWeek, capacityPercent,
    // ordering) must be exactly unchanged. `source` (SQUAD_PLANNER → MANUAL) and
    // `updatedAt` legitimately change during the transfer.
    expect(segmentStructuralFields(await fetchSegments(roleProfileIdBefore)))
      .toEqual(segmentStructuralFields(preTransferRoleSegments))
    expect(segmentStructuralFields(await fetchSegments(nrProfile1IdBefore)))
      .toEqual(segmentStructuralFields(preTransferNr1Segments))
    expect(segmentStructuralFields(await fetchSegments(nrProfile2IdBefore)))
      .toEqual(segmentStructuralFields(preTransferNr2Segments))

    // Every transferred segment source is now MANUAL
    for (const segments of [
      await fetchSegments(roleProfileIdBefore),
      await fetchSegments(nrProfile1IdBefore),
      await fetchSegments(nrProfile2IdBefore),
    ]) {
      for (const seg of segments) {
        expect(seg.source).toBe('MANUAL')
      }
    }

    // Profile IDs unchanged
    const profiles = await fetchProfiles(projectId)
    expect(profiles.some(p => p.id === roleProfileIdBefore)).toBe(true)
    expect(profiles.some(p => p.id === nrProfile1IdBefore)).toBe(true)
    expect(profiles.some(p => p.id === nrProfile2IdBefore)).toBe(true)
  })

  it('a role-level manual edit via the #363 path changes scheduler capacity exactly', async () => {
    // Perform a normal role-level manual edit through replaceCapacityProfile (the #363 path)
    const { replaceCapacityProfile } = await import('../lib/capacityProfileReplaceService.js')
    await prisma.$transaction(async tx => {
      await replaceCapacityProfile(
        tx as any,
        projectId,
        'ROLE',
        rtId,
        {
          planningBasis: 'CAPACITY_PROFILE',
          defaultPercent: 100,
          startWeek: null,
          endWeek: null,
          segments: [
            { startWeek: 0, endWeek: 3, capacityPercent: 50 }, // edited: 100 → 50
            { startWeek: 4, endWeek: 7, capacityPercent: 100 },
            { startWeek: 8, endWeek: 11, capacityPercent: 25 },
          ],
        },
        userId,
      )
    })

    // Resolve capacity again — the edited first segment must change exactly
    const { getWeeklyCapacity } = await import('../lib/scheduler.js')
    const resolved = await resolveSchedulerCapacity(prisma as any, projectId)
    const rt = resolved.resourceTypes.find(rt => rt.id === rtId)
    expect(rt).toBeDefined()

    const editedWeekly: Record<number, number> = {}
    for (let w = 0; w <= 11; w++) {
      editedWeekly[w] = getWeeklyCapacity(rt!, w, 8)
    }

    // Weeks 0-3 now at 50% of 8h × 5d = 20h (was 40h)
    for (let w = 0; w <= 3; w++) {
      expect(editedWeekly[w]).toBe(20)
      expect(editedWeekly[w]).not.toBe(preTransferWeekly[w])
    }
    // Weeks 4-7 and 8-11 unchanged
    for (let w = 4; w <= 11; w++) {
      expect(editedWeekly[w]).toBe(preTransferWeekly[w])
    }

    // Changed value survives another resolution (re-read)
    const resolvedAgain = await resolveSchedulerCapacity(prisma as any, projectId)
    const rtAgain = resolvedAgain.resourceTypes.find(rt => rt.id === rtId)
    for (let w = 0; w <= 3; w++) {
      expect(getWeeklyCapacity(rtAgain!, w, 8)).toBe(20)
    }
  })

  it('preserves planned-resource owner kinds (no conversion to NAMED_PERSON)', async () => {
    const profiles = await fetchProfiles(projectId)
    const nrProfiles = profiles.filter(p => p.namedResourceId !== null)
    for (const profile of nrProfiles) {
      expect(profile.ownerKind).toBe('PLANNED_RESOURCE')
    }
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// Scenario 2 — Protected NAMED_PERSON profiles remain unchanged
// ═════════════════════════════════════════════════════════════════════════════

describeIf('Scenario 2 — Protected named-person profiles unchanged', () => {
  let projectId: string
  let rtId: string
  let namedPersonNrId: string
  let namedPersonProfileId: string

  beforeAll(async () => {
    if (!runIntegration) return
    projectId = await createProject()
    rtId = await createResourceType(projectId, 'rt-transfer-s2', 'Named Person Role')

    // Create a named person (explicit, not planner)
    namedPersonNrId = await createNamedResource(
      projectId, rtId, 'nr-named-s2', 'Alice',
      { allocationMode: 'EFFORT', allocationPercent: 100, allocationPct: 100 },
    )

    // Create an explicit NAMED_PERSON profile (MANUAL source, DEMAND_FOLLOWING)
    namedPersonProfileId = await createProfile(
      projectId, 'cp-named-s2', 'NAMED_PERSON', null, namedPersonNrId,
      { planningBasis: 'DEMAND_FOLLOWING', source: 'MANUAL', defaultPercent: 100 },
    )

    // Create a planner-managed role profile WITH segments (null profile-level windows)
    await createProfile(
      projectId, 'cp-role-s2', 'ROLE', rtId, null,
      { planningBasis: 'CAPACITY_PROFILE', source: 'SQUAD_PLANNER', defaultPercent: 100, startWeek: null, endWeek: null },
    )
    await createSegment('cp-role-s2', 0, 5, 100)

    // Create a planner-managed PLANNED_RESOURCE profile WITH segments
    const plannerNrId = await createNamedResource(
      projectId, rtId, 'nr-planner-s2', 'Planned Resource 1',
      { allocationMode: 'CAPACITY_PLAN' },
    )
    await createProfile(
      projectId, 'cp-planned-s2', 'PLANNED_RESOURCE', null, plannerNrId,
      { planningBasis: 'CAPACITY_PROFILE', source: 'SQUAD_PLANNER', defaultPercent: 100, startWeek: null, endWeek: null },
    )
    await createSegment('cp-planned-s2', 0, 5, 100)
  })

  it('transfers planner profiles but leaves named-person profile unchanged', async () => {
    const res = await request(app)
      .post(`/api/projects/${projectId}/capacity-profiles/transfer-to-manual`)
      .set('Authorization', authHeader)
      .send({ resourceTypeId: rtId })

    expect(res.status).toBe(200)
    expect(res.body.result.protectedProfileIds).toContain('cp-named-s2')

    const profiles = await fetchProfiles(projectId)
    const namedPersonProfile = profiles.find(p => p.id === namedPersonProfileId)
    expect(namedPersonProfile).toBeDefined()
    expect(namedPersonProfile!.source).toBe('MANUAL')
    expect(namedPersonProfile!.ownerKind).toBe('NAMED_PERSON')

    // Planner profiles should have transferred
    const roleProfile = profiles.find(p => p.ownerKind === 'ROLE')
    expect(roleProfile).toBeDefined()
    expect(roleProfile!.source).toBe('MANUAL')
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// Scenario 3 — Unrelated roles remain unchanged
// ═════════════════════════════════════════════════════════════════════════════

describeIf('Scenario 3 — Unrelated roles unchanged', () => {
  let projectId: string
  let rtTransfer: string
  let rtUnrelated: string
  let unrelatedProfileId: string

  beforeAll(async () => {
    if (!runIntegration) return
    projectId = await createProject()
    rtTransfer = await createResourceType(projectId, 'rt-tx-s3', 'Transfer Role')
    rtUnrelated = await createResourceType(projectId, 'rt-ur-s3', 'Unrelated Role')

    // Create planner profile for transfer role with segments
    await createProfile(
      projectId, 'cp-tx-s3', 'ROLE', rtTransfer, null,
      { planningBasis: 'CAPACITY_PROFILE', source: 'SQUAD_PLANNER', defaultPercent: 100, startWeek: null, endWeek: null },
    )
    await createSegment('cp-tx-s3', 0, 5, 100)

    // Create a MANUAL profile for unrelated role (should stay MANUAL)
    unrelatedProfileId = await createProfile(
      projectId, 'cp-ur-s3', 'ROLE', rtUnrelated, null,
      { planningBasis: 'DEMAND_FOLLOWING', source: 'MANUAL', defaultPercent: 100 },
    )
  })

  it('transfers only the requested role', async () => {
    const res = await request(app)
      .post(`/api/projects/${projectId}/capacity-profiles/transfer-to-manual`)
      .set('Authorization', authHeader)
      .send({ resourceTypeId: rtTransfer })

    expect(res.status).toBe(200)

    const profiles = await fetchProfiles(projectId)
    const unrelatedProfile = profiles.find(p => p.id === unrelatedProfileId)
    expect(unrelatedProfile).toBeDefined()
    expect(unrelatedProfile!.source).toBe('MANUAL') // unchanged

    const transferRoleProfile = profiles.find(p => p.resourceTypeId === rtTransfer)
    expect(transferRoleProfile).toBeDefined()
    expect(transferRoleProfile!.source).toBe('MANUAL') // now manual
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// Scenario 4 — Role not planner-managed is rejected
// ═════════════════════════════════════════════════════════════════════════════

describeIf('Scenario 4 — Not planner-managed rejected', () => {
  let projectId: string
  let rtId: string

  beforeAll(async () => {
    if (!runIntegration) return
    projectId = await createProject()
    rtId = await createResourceType(projectId, 'rt-s4', 'Manual Role')

    // Create a MANUAL profile (not SQUAD_PLANNER)
    await createProfile(
      projectId, 'cp-s4', 'ROLE', rtId, null,
      { planningBasis: 'DEMAND_FOLLOWING', source: 'MANUAL', defaultPercent: 100 },
    )
  })

  it('returns 409 for non-planner-managed role', async () => {
    const res = await request(app)
      .post(`/api/projects/${projectId}/capacity-profiles/transfer-to-manual`)
      .set('Authorization', authHeader)
      .send({ resourceTypeId: rtId })

    expect(res.status).toBe(409)
    expect(res.body.error).toContain('not managed by Squad Planner')
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// Scenario 5 — Missing resource type returns 404
// ═════════════════════════════════════════════════════════════════════════════

describeIf('Scenario 5 — Missing resource type', () => {
  let projectId: string

  beforeAll(async () => {
    if (!runIntegration) return
    projectId = await createProject()
  })

  it('returns 404 for non-existent resource type', async () => {
    const res = await request(app)
      .post(`/api/projects/${projectId}/capacity-profiles/transfer-to-manual`)
      .set('Authorization', authHeader)
      .send({ resourceTypeId: 'non-existent-rt-id' })

    expect(res.status).toBe(404)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// Scenario 6 — Auth and project ownership checks
// ═════════════════════════════════════════════════════════════════════════════

describeIf('Scenario 6 — Auth and ownership', () => {
  let projectId: string
  let otherToken: string

  beforeAll(async () => {
    if (!runIntegration) return
    projectId = await createProject()

    // Create another user who does NOT own this project
    const otherUser = await prisma.user.create({
      data: {
        email: `other-transfer-${Date.now()}@example.com`,
        name: 'Other User',
        password: '$2b$10$placeholder',
      },
    })
    otherToken = jwt.sign({ userId: otherUser.id, role: 'USER' }, process.env.JWT_SECRET!)
  })

  afterAll(async () => {
    if (!runIntegration) return
    // Cleanup the other user
    await prisma.user.deleteMany({ where: { email: { startsWith: 'other-transfer-' } } })
  })

  it('rejects unauthenticated request', async () => {
    const res = await request(app)
      .post(`/api/projects/${projectId}/capacity-profiles/transfer-to-manual`)
      .send({ resourceTypeId: 'any' })

    expect(res.status).toBe(401)
  })

  it('rejects request from non-owner', async () => {
    const res = await request(app)
      .post(`/api/projects/${projectId}/capacity-profiles/transfer-to-manual`)
      .set('Authorization', `Bearer ${otherToken}`)
      .send({ resourceTypeId: 'any' })

    expect(res.status).toBe(404) // project not found for non-owner
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// Scenario 7 — Deterministic compatibility projection
// ═════════════════════════════════════════════════════════════════════════════

describeIf('Scenario 7 — Compatibility projection', () => {
  let projectId: string
  let rtId: string
  let nrId: string

  beforeAll(async () => {
    if (!runIntegration) return
    projectId = await createProject()
    rtId = await createResourceType(projectId, 'rt-s7', 'Projection Test Role')

    nrId = await createNamedResource(
      projectId, rtId, 'nr-s7', 'Projection Test 1',
      { allocationMode: 'CAPACITY_PLAN' },
    )

    await createProfile(
      projectId, 'cp-role-s7', 'ROLE', rtId, null,
      { planningBasis: 'CAPACITY_PROFILE', source: 'SQUAD_PLANNER', defaultPercent: 100, startWeek: null, endWeek: null },
    )
    await createSegment('cp-role-s7', 0, 3, 100)
    await createSegment('cp-role-s7', 4, 7, 50)

    await createProfile(
      projectId, 'cp-nr-s7', 'PLANNED_RESOURCE', null, nrId,
      { planningBasis: 'CAPACITY_PROFILE', source: 'SQUAD_PLANNER', defaultPercent: 100, startWeek: null, endWeek: null },
    )
    await createSegment('cp-nr-s7', 0, 3, 100)
    await createSegment('cp-nr-s7', 4, 7, 50)
  })

  it('freezes ResourceType candidate columns during transfer', async () => {
    const res = await request(app)
      .post(`/api/projects/${projectId}/capacity-profiles/transfer-to-manual`)
      .set('Authorization', authHeader)
      .send({ resourceTypeId: rtId })

    expect(res.status).toBe(200)

    // Issue #418: transfer never writes candidate columns — the seeded
    // defaults stay frozen; the transferred MANUAL profiles are authority.
    const rt = await prisma.resourceType.findUnique({
      where: { id: rtId },
      select: { allocationMode: true, allocationPercent: true, allocationStartWeek: true, allocationEndWeek: true },
    })
    expect(rt).toBeDefined()
    expect(rt!.allocationMode).toBe('TIMELINE')
    expect(rt!.allocationPercent).toBe(100)
    expect(rt!.allocationStartWeek).toBeNull()
    expect(rt!.allocationEndWeek).toBeNull()
  })

  it('freezes NamedResource candidate columns during transfer', async () => {
    // The NR was seeded with CAPACITY_PLAN — it stays frozen; the transferred
    // MANUAL PLANNED_RESOURCE profile carries the (now zeroed) capacity.
    const nrs = await fetchNamedResources(rtId)
    const nr = nrs.find(n => n.id === nrId)
    expect(nr).toBeDefined()
    expect(nr!.allocationMode).toBe('CAPACITY_PLAN')
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// Scenario 8 — Later Squad Planner apply cannot reclaim transferred role
// ═════════════════════════════════════════════════════════════════════════════

describeIf('Scenario 8 — Later Squad Planner apply blocked', () => {
  let projectId: string
  let rtId: string

  beforeAll(async () => {
    if (!runIntegration) return
    projectId = await createProject()
    rtId = await createResourceType(projectId, 'rt-s8', 'Protected After Transfer')

    // Set up a planner-managed role with backlog
    await createEpicBacklog(projectId, rtId)

    // Create planner profile with segments
    await createProfile(
      projectId, 'cp-role-s8', 'ROLE', rtId, null,
      { planningBasis: 'CAPACITY_PROFILE', source: 'SQUAD_PLANNER', defaultPercent: 100, startWeek: null, endWeek: null },
    )
    await createSegment('cp-role-s8', 0, 5, 100)

    // Create planner resource profile with segments
    const nrId = await createNamedResource(
      projectId, rtId, 'nr-s8', 'Planned 1',
      { allocationMode: 'CAPACITY_PLAN' },
    )
    await createProfile(
      projectId, 'cp-nr-s8', 'PLANNED_RESOURCE', null, nrId,
      { planningBasis: 'CAPACITY_PROFILE', source: 'SQUAD_PLANNER', defaultPercent: 100, startWeek: null, endWeek: null },
    )
    await createSegment('cp-nr-s8', 0, 5, 100)
  })

  it('blocks Squad Planner apply after transfer', async () => {
    // First, transfer to manual
    const transferRes = await request(app)
      .post(`/api/projects/${projectId}/capacity-profiles/transfer-to-manual`)
      .set('Authorization', authHeader)
      .send({ resourceTypeId: rtId })

    expect(transferRes.status).toBe(200)

    // Now try to apply Squad Planner for this role
    const applyRes = await request(app)
      .post(`/api/projects/${projectId}/squad-plan/apply`)
      .set('Authorization', authHeader)
      .send({
        name: 'Test Plan After Transfer',
        targetWeeks: 12,
        periodWeeks: 4,
        maxDelta: 1,
        setActive: true,
        periods: [{
          periodIndex: 0,
          startWeek: 0,
          endWeek: 4,
          entries: [{
            resourceTypeId: rtId,
            headcount: 2,
            demandFTE: 1,
            utilisationPct: 50,
          }],
        }],
      })

    // The planner apply should return 409 because the role now has MANUAL profiles
    expect(applyRes.status).toBe(409)
    expect(applyRes.body.error).toBeTruthy()

    // Verify the transferred role was NOT reclaimed by the planner
    const afterProfiles = await fetchProfiles(projectId)
    const roleProfile = afterProfiles.find(p => p.ownerKind === 'ROLE' && p.resourceTypeId === rtId)
    expect(roleProfile).toBeDefined()
    expect(roleProfile!.source).toBe('MANUAL')
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// Scenario 9 — Malformed planner-looking profile rejected
// ═════════════════════════════════════════════════════════════════════════════

describeIf('Scenario 9 — Malformed planner-looking profile', () => {
  let projectId: string
  let rtId: string

  beforeAll(async () => {
    if (!runIntegration) return
    projectId = await createProject()
    rtId = await createResourceType(projectId, 'rt-s9', 'Malformed Planner')

    // Create a profile that looks planner-owned but has an invalid source/basis combination
    await createProfile(
      projectId, 'cp-role-s9', 'ROLE', rtId, null,
      { planningBasis: 'CAPACITY_PROFILE', source: 'SQUAD_PLANNER', defaultPercent: 100, startWeek: null, endWeek: null },
    )
    await createSegment('cp-role-s9', 0, 5, 100)

    // Create a PLANNED_RESOURCE profile with invalid overlapping segments
    const nrId = await createNamedResource(projectId, rtId, 'nr-s9', 'Bad Planned 1')
    await createProfile(
      projectId, 'cp-nr-s9-1', 'PLANNED_RESOURCE', null, nrId,
      { planningBasis: 'CAPACITY_PROFILE', source: 'SQUAD_PLANNER', defaultPercent: 100, startWeek: null, endWeek: null },
    )
    await createSegment('cp-nr-s9-1', 0, 3, 100)
    await createSegment('cp-nr-s9-1', 2, 5, 50) // Overlaps with first segment
  })

  it('returns 409 and does not mutate state for overlapping segments', async () => {
    const res = await request(app)
      .post(`/api/projects/${projectId}/capacity-profiles/transfer-to-manual`)
      .set('Authorization', authHeader)
      .send({ resourceTypeId: rtId })

    expect(res.status).toBe(409)

    // Verify no mutations
    const profiles = await fetchProfiles(projectId)
    const roleProfile = profiles.find(p => p.id === 'cp-role-s9')
    expect(roleProfile).toBeDefined()
    expect(roleProfile!.source).toBe('SQUAD_PLANNER') // unchanged

    const segments = await fetchSegments('cp-role-s9')
    expect(segments.length).toBe(1) // unchanged
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// Scenario 9b — Missing resourceTypeId in request body
// ═════════════════════════════════════════════════════════════════════════════

describeIf('Scenario 9b — Missing resourceTypeId', () => {
  let projectId: string

  beforeAll(async () => {
    if (!runIntegration) return
    projectId = await createProject()
  })

  it('rejects request without resourceTypeId', async () => {
    const res = await request(app)
      .post(`/api/projects/${projectId}/capacity-profiles/transfer-to-manual`)
      .set('Authorization', authHeader)
      .send({})

    expect(res.status).toBe(400)
    expect(res.body.error).toContain('resourceTypeId')
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// Scenario 10 — No role profile fails closed
// ═════════════════════════════════════════════════════════════════════════════

describeIf('Scenario 10 — Missing role profile', () => {
  let projectId: string
  let rtId: string

  beforeAll(async () => {
    if (!runIntegration) return
    projectId = await createProject()
    rtId = await createResourceType(projectId, 'rt-s10', 'No Profile Role')

    // Create a resource type but NO profiles
    // (Just the resource type, no capacity profiles)
  })

  it('returns 409 when no role-level capacity profile exists', async () => {
    const res = await request(app)
      .post(`/api/projects/${projectId}/capacity-profiles/transfer-to-manual`)
      .set('Authorization', authHeader)
      .send({ resourceTypeId: rtId })

    expect(res.status).toBe(409)
    expect(res.body.error).toContain('No capacity profiles found')
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// Scenario 11 — Transfer rolls back atomically on injected failure
// ═════════════════════════════════════════════════════════════════════════════

describeIf('Scenario 11 — Atomic rollback on failure', () => {
  let projectId: string
  let rtId: string
  let nrId: string

  beforeAll(async () => {
    if (!runIntegration) return
    projectId = await createProject()
    rtId = await createResourceType(projectId, 'rt-s11', 'Rollback Role')

    nrId = await createNamedResource(projectId, rtId, 'nr-s11', 'Rollback Resource 1')

    await createProfile(
      projectId, 'cp-role-s11', 'ROLE', rtId, null,
      { planningBasis: 'CAPACITY_PROFILE', source: 'SQUAD_PLANNER', defaultPercent: 100, startWeek: null, endWeek: null },
    )
    await createSegment('cp-role-s11', 0, 5, 100)

    await createProfile(
      projectId, 'cp-nr-s11', 'PLANNED_RESOURCE', null, nrId,
      { planningBasis: 'CAPACITY_PROFILE', source: 'SQUAD_PLANNER', defaultPercent: 100, startWeek: null, endWeek: null },
    )
    await createSegment('cp-nr-s11', 0, 5, 100)
  })

  afterAll(async () => {
    if (!runIntegration) return
    __setTransferFailureSeam(null)
  })

  it('rolls back all writes when the failure seam fires after mutation', async () => {
    // Capture exact pre-transfer state
    const beforeProfiles = await fetchProfiles(projectId)
    const beforeRoleSegments = await fetchSegments('cp-role-s11')
    const beforeNRSegments = await fetchSegments('cp-nr-s11')
    const beforeNR = await fetchNamedResources(rtId)
    const beforeRT = await prisma.resourceType.findUnique({
      where: { id: rtId },
      select: { allocationMode: true, allocationPercent: true, allocationStartWeek: true, allocationEndWeek: true },
    })
    const beforeProject = await prisma.project.findUnique({
      where: { id: projectId },
      select: { weeklyDemandCache: true },
    })

    // Inject failure seam BEFORE the transfer (fires after writes)
    let seamReached = false
    __setTransferFailureSeam(() => {
      seamReached = true
      throw new Error('injected transfer failure')
    })

    try {
      const res = await request(app)
        .post(`/api/projects/${projectId}/capacity-profiles/transfer-to-manual`)
        .set('Authorization', authHeader)
        .send({ resourceTypeId: rtId })

      expect(res.status).toBe(500)
    } finally {
      __setTransferFailureSeam(null)
    }

    // Assert the seam was reached
    expect(seamReached).toBe(true)

    // Assert all persisted state matches pre-transfer exactly
    const afterProfiles = await fetchProfiles(projectId)
    expect(afterProfiles).toEqual(beforeProfiles)

    const afterRoleSegments = await fetchSegments('cp-role-s11')
    expect(afterRoleSegments).toEqual(beforeRoleSegments)

    const afterNRSegments = await fetchSegments('cp-nr-s11')
    expect(afterNRSegments).toEqual(beforeNRSegments)

    const afterNR = await fetchNamedResources(rtId)
    expect(afterNR).toEqual(beforeNR)

    const afterRT = await prisma.resourceType.findUnique({
      where: { id: rtId },
      select: { allocationMode: true, allocationPercent: true, allocationStartWeek: true, allocationEndWeek: true },
    })
    expect(afterRT).toEqual(beforeRT)

    // Verify weeklyDemandCache matches exact pre-transfer value
    const afterProject = await prisma.project.findUnique({
      where: { id: projectId },
      select: { weeklyDemandCache: true },
    })
    expect(afterProject?.weeklyDemandCache).toEqual(beforeProject?.weeklyDemandCache)
  })
})
