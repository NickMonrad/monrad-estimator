/**
 * runtimeCutoverProfileFirst.integration.test.ts — Real PostgreSQL integration
 * tests for the profile-first runtime cutover (issue #364).
 *
 * Tests that:
 * - Project creation atomically creates profiles for seeded resource types
 * - Created owners have valid unique ROLE and NAMED_PERSON profiles
 * - Profile IDs remain stable across scalar capacity updates
 * - Count increase after CAPACITY_PLAN exit creates NRs with post-exit state
 * - Protected segmented and planner-owned profiles remain unchanged
 * - Missing or malformed authoritative state blocks writes
 * - No partial state changes after failure
 * - Deletion cascades remove only the intended profile/segments
 *
 * Skipped unless INTEGRATION_TEST=true.
 */

vi.mock('../lib/prisma.js', async (importOriginal) => {
  return await importOriginal()
})

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '@prisma/client'
import { app } from '../app.js'
import { __setRTPatchFailureSeam } from '../routes/resourceTypes.js'

// ─── Guard ──────────────────────────────────────────────────────────

const runIntegration = process.env.INTEGRATION_TEST === 'true'
const describeIf = runIntegration ? describe : describe.skip

// ─── Shared state ───────────────────────────────────────────────────

let prisma: PrismaClient
let userId: string
let token: string
let authHeader: string

const USER_EMAIL = 'runtime-cutover-364-integration@example.com'
const PROJ_NAME = 'Runtime Cutover #364'

let projectId: string
let nrId: string
let globalTypeId: string

// ─── Setup ──────────────────────────────────────────────────────────

beforeAll(async () => {
  const adapter = new PrismaPg(process.env.DATABASE_URL!)
  prisma = new PrismaClient({ adapter })

  const user = await prisma.user.upsert({
    where: { email: USER_EMAIL },
    create: { email: USER_EMAIL, name: 'Test User', password: 'test-password' },
    update: {},
  })
  const globalType = await prisma.globalResourceType.create({
    data: {
      name: `Runtime Cutover Role ${randomUUID()}`,
      category: 'ENGINEERING',
      defaultHoursPerDay: 7.6,
    },
  })
  globalTypeId = globalType.id
  userId = user.id
  token = jwt.sign({ userId }, process.env.JWT_SECRET ?? 'test-secret')
  authHeader = `Bearer ${token}`
}, 30000)

afterAll(async () => {
  if (projectId) {
    await prisma.project.delete({ where: { id: projectId } }).catch(() => {})
  }
  if (globalTypeId) {
    await prisma.globalResourceType.delete({ where: { id: globalTypeId } }).catch(() => {})
  }
  await prisma.user.delete({ where: { email: USER_EMAIL } }).catch(() => {})
  await prisma.$disconnect()
}, 15000)

// ─── Helpers ────────────────────────────────────────────────────────

async function countProfiles(ownerKind: string, ownerId: string): Promise<number> {
  const where: Record<string, unknown> = { projectId }
  if (ownerKind === 'ROLE') {
    where.resourceTypeId = ownerId
    where.namedResourceId = null
  } else {
    where.namedResourceId = ownerId
    where.resourceTypeId = null
  }
  return prisma.capacityProfile.count({ where: where as any })
}

async function getProfileId(ownerKind: string, ownerId: string): Promise<string | null> {
  const where: Record<string, unknown> = { projectId }
  if (ownerKind === 'ROLE') {
    where.resourceTypeId = ownerId
    where.namedResourceId = null
  } else {
    where.namedResourceId = ownerId
    where.resourceTypeId = null
  }
  const profile = await prisma.capacityProfile.findFirst({ where: where as any, orderBy: { id: 'asc' } })
  return profile?.id ?? null
}

async function snapshotRuntimeState(resourceTypeId: string) {
  const [resourceType, namedResources, profiles, project, capacityPlans] = await Promise.all([
    prisma.resourceType.findUnique({ where: { id: resourceTypeId } }),
    prisma.namedResource.findMany({ where: { resourceTypeId }, orderBy: { id: 'asc' } }),
    prisma.capacityProfile.findMany({
      where: { projectId, OR: [{ resourceTypeId }, { namedResource: { resourceTypeId } }] },
      include: { segments: { orderBy: [{ startWeek: 'asc' }, { id: 'asc' }] } },
      orderBy: { id: 'asc' },
    }),
    prisma.project.findUnique({ where: { id: projectId }, select: { weeklyDemandCache: true } }),
    prisma.capacityPlan.findMany({
      where: { projectId },
      include: { periods: { include: { entries: true }, orderBy: { periodIndex: 'asc' } } },
      orderBy: { id: 'asc' },
    }),
  ])

  return JSON.parse(JSON.stringify({
    resourceType,
    namedResources,
    profiles,
    weeklyDemandCache: project?.weeklyDemandCache,
    capacityPlans,
  }))
}

async function seedDistinctCache() {
  await prisma.project.update({
    where: { id: projectId },
    data: { weeklyDemandCache: { [`403|${randomUUID()}`]: 123.75 } },
  })
}

async function createRuntimeResourceType(name: string) {
  const response = await request(app)
    .post(`/api/projects/${projectId}/resource-types`)
    .set('Authorization', authHeader)
    .send({ name, category: 'ENGINEERING' })
  // eslint-disable-next-line no-console
  if (response.status !== 201) console.error('DBG rt:', response.status, JSON.stringify(response.body).slice(0, 200), 'projectId=', projectId)
  expect(response.status).toBe(201)
  return response.body
}


// ─── Tests ──────────────────────────────────────────────────────────

describeIf('profile-first runtime cutover (#364)', () => {
  it('1. creates project with seeded resource types and valid ROLE profiles', async () => {
    const res = await request(app)
      .post('/api/projects')
      .set('Authorization', authHeader)
      .send({ name: PROJ_NAME })

    expect(res.status).toBe(201)
    projectId = res.body.id
    expect(projectId).toBeTruthy()
    expect(res.body.resourceTypes).toBeDefined()
    expect(res.body.resourceTypes.length).toBeGreaterThan(0)

    for (const rt of res.body.resourceTypes) {
      const profileCount = await countProfiles('ROLE', rt.id)
      expect(profileCount).toBe(1)

      const profile = await prisma.capacityProfile.findFirst({
        where: { resourceTypeId: rt.id, namedResourceId: null, projectId },
      })
      expect(profile).toBeDefined()
      expect(profile!.ownerKind).toBe('ROLE')
      expect(profile!.planningBasis).toBe('AVAILABILITY_WINDOW')
      expect(profile!.source).toBe('AVAILABILITY_WINDOW')
      expect(profile!.defaultPercent).toBe(100)
      expect(profile!.startWeek).toBeNull()
      expect(profile!.endWeek).toBeNull()
      expect(profile!.namedResourceId).toBeNull()
    }
  })

  it('2. creates RT with valid ROLE and NAMED_PERSON profiles', async () => {
    const res = await request(app)
      .post(`/api/projects/${projectId}/resource-types`)
      .set('Authorization', authHeader)
      .send({ name: 'Developer', category: 'ENGINEERING' })

    expect(res.status).toBe(201)
    const newRtId = res.body.id

    const roleCount = await countProfiles('ROLE', newRtId)
    expect(roleCount).toBe(1)
    const roleProfile = await prisma.capacityProfile.findFirst({
      where: { resourceTypeId: newRtId, namedResourceId: null, projectId },
    })
    expect(roleProfile!.ownerKind).toBe('ROLE')
    expect(roleProfile!.source).toBe('AVAILABILITY_WINDOW')
    expect(roleProfile!.planningBasis).toBe('AVAILABILITY_WINDOW')
    expect(roleProfile!.defaultPercent).toBe(100)
    expect(roleProfile!.startWeek).toBeNull()
    expect(roleProfile!.endWeek).toBeNull()
    const nrs = await prisma.namedResource.findMany({ where: { resourceTypeId: newRtId } })
    expect(nrs.length).toBe(1)
    const nrProfileCount = await countProfiles('NAMED_PERSON', nrs[0].id)
    expect(nrProfileCount).toBe(1)
    const nrProfile = await prisma.capacityProfile.findFirst({
      where: { namedResourceId: nrs[0].id, projectId },
    })
    expect(nrProfile).toBeDefined()
    expect(nrProfile!.ownerKind).toBe('NAMED_PERSON')
    expect(nrProfile!.planningBasis).toBe('DEMAND_FOLLOWING')
    expect(nrProfile!.source).toBe('FIXED')
    expect(nrProfile!.defaultPercent).toBe(100)
    expect(nrProfile!.startWeek).toBeNull()
    expect(nrProfile!.endWeek).toBeNull()
    expect(nrProfile!.resourceTypeId).toBeNull()
  })

  it('3. rejects legacy capacity fields on PUT and preserves the profile exactly', async () => {
    const firstRt = await prisma.resourceType.findFirst({ where: { projectId }, orderBy: { id: 'asc' } })
    const firstRtId = firstRt!.id
    const beforeId = await getProfileId('ROLE', firstRtId)
    expect(beforeId).toBeTruthy()
    const beforeProfile = await prisma.capacityProfile.findUniqueOrThrow({
      where: { id: beforeId! },
      include: { segments: { orderBy: [{ startWeek: 'asc' }, { id: 'asc' }] } },
    })

    const res = await request(app)
      .put(`/api/projects/${projectId}/resource-types/${firstRtId}`)
      .set('Authorization', authHeader)
      .send({ allocationMode: 'EFFORT', allocationPercent: 75 })

    // Legacy capacity request fields are rejected before any write (#403)
    expect(res.status).toBe(400)
    expect(res.body.rejectedFields).toEqual(['allocationMode', 'allocationPercent'])

    const afterId = await getProfileId('ROLE', firstRtId)
    expect(afterId).toBe(beforeId)
    expect(await countProfiles('ROLE', firstRtId)).toBe(1)
    expect(await prisma.capacityProfile.findUniqueOrThrow({
      where: { id: beforeId! },
      include: { segments: { orderBy: [{ startWeek: 'asc' }, { id: 'asc' }] } },
    })).toEqual(beforeProfile)
  })
  it('4. rejects legacy capacity fields on named-resource routes and preserves the profile', async () => {
    const nr = await prisma.namedResource.findFirst({
      where: { resourceType: { projectId } },
      orderBy: { id: 'asc' },
    })
    expect(nr).toBeDefined()
    nrId = nr!.id

    const beforeId = await getProfileId('NAMED_PERSON', nrId)
    expect(beforeId).toBeTruthy()
    const beforeProfile = await prisma.capacityProfile.findUniqueOrThrow({
      where: { id: beforeId! },
      include: { segments: { orderBy: [{ startWeek: 'asc' }, { id: 'asc' }] } },
    })

    const res = await request(app)
      .put(`/api/projects/${projectId}/resource-types/${nr!.resourceTypeId}/named-resources/${nrId}`)
      .set('Authorization', authHeader)
      .send({ allocationMode: 'EFFORT', allocationPercent: 50 })

    expect(res.status).toBe(400)
    expect(res.body.rejectedFields).toEqual(['allocationMode', 'allocationPercent'])

    // The legacy PATCH capacity route is removed (#403)
    const patchRes = await request(app)
      .patch(`/api/projects/${projectId}/resource-types/${nr!.resourceTypeId}/named-resources/${nrId}`)
      .set('Authorization', authHeader)
      .send({ allocationMode: 'EFFORT' })
    expect(patchRes.status).toBe(400)
    expect(patchRes.body.rejectedFields).toEqual(['allocationMode'])

    const afterId = await getProfileId('NAMED_PERSON', nrId)
    expect(afterId).toBe(beforeId)
    expect(await countProfiles('NAMED_PERSON', nrId)).toBe(1)
    expect(await prisma.capacityProfile.findUniqueOrThrow({
      where: { id: beforeId! },
      include: { segments: { orderBy: [{ startWeek: 'asc' }, { id: 'asc' }] } },
    })).toEqual(beforeProfile)
  })
  it('5. rejects supplied legacy capacity fields with 400 and preserves the profile', async () => {
    const testRt = await prisma.resourceType.findFirst({ where: { projectId }, orderBy: { id: 'desc' } })
    const testRtId = testRt!.id
    const beforeId = await getProfileId('ROLE', testRtId)
    expect(beforeId).toBeTruthy()

    const beforeProfile = await prisma.capacityProfile.findFirst({
      where: { id: beforeId! },
    })

    const res = await request(app)
      .put(`/api/projects/${projectId}/resource-types/${testRtId}`)
      .set('Authorization', authHeader)
      .send({ allocationMode: 'INVALID_MODE' })

    // The field is rejected as a legacy capacity request field — no validation
    // of its value ever runs because the request never enters the transaction
    expect(res.status).toBe(400)
    expect(res.body.rejectedFields).toEqual(['allocationMode'])

    const afterProfile = await prisma.capacityProfile.findFirst({
      where: { id: beforeId! },
    })
    expect(afterProfile).toBeDefined()
    expect(afterProfile).toEqual(beforeProfile)
    expect(await countProfiles('ROLE', testRtId)).toBe(1)
  })
  it('6. missing profile blocks non-capacity update', async () => {
    const testRt = await prisma.resourceType.create({
      data: { name: 'Test-Orphan', category: 'ENGINEERING', projectId, count: 0 },
    })

    const res = await request(app)
      .put(`/api/projects/${projectId}/resource-types/${testRt.id}`)
      .set('Authorization', authHeader)
      .send({ name: 'Renamed' })

    expect(res.status).toBe(409)

    await prisma.resourceType.delete({ where: { id: testRt.id } }).catch(() => {})
  })
  it('7. cross-project profile blocks update on wrong project', async () => {
    // Create a profile belonging to a different project
    const otherProject = await prisma.project.create({
      data: { name: 'Other Project', ownerId: userId },
    })
    const otherRt = await prisma.resourceType.create({
      data: { name: 'Other-RT', category: 'ENGINEERING', projectId: otherProject.id, count: 0 },
    })
    // Other RT's profile belongs to otherProject, not our test project
    await prisma.capacityProfile.create({
      data: {
        ownerKind: 'ROLE',
        projectId: otherProject.id,
        resourceTypeId: otherRt.id,
        namedResourceId: null,
        planningBasis: 'DEMAND_FOLLOWING',
        source: 'FIXED',
        defaultPercent: 100,
      },
    })

    // Try updating our test RT's profile with capacity change using our project's RT
    const testRt = await prisma.resourceType.findFirst({ where: { projectId }, orderBy: { id: 'asc' } })
    const testRtId = testRt!.id

    // Capacity mutations go through the first-class capacity-profiles endpoint;
    // the other project's ROLE profile must not block updates to our RT.
    const res = await request(app)
      .put(`/api/projects/${projectId}/capacity-profiles/ROLE/${testRtId}`)
      .set('Authorization', authHeader)
      .send({ planningBasis: 'DEMAND_FOLLOWING', defaultPercent: 80, startWeek: null, endWeek: null })

    // Should succeed — our RT has its own profile
    expect(res.status).toBe(200)

    await prisma.resourceType.deleteMany({ where: { id: otherRt.id } }).catch(() => {})
    await prisma.project.deleteMany({ where: { id: otherProject.id } }).catch(() => {})
  })


  it('8. deletion cascade removes only the intended profiles', async () => {
    const res = await request(app)
      .post(`/api/projects/${projectId}/resource-types`)
      .set('Authorization', authHeader)
      .send({ name: 'Temp-Role', category: 'ENGINEERING' })

    expect(res.status).toBe(201)
    const tempRtId = res.body.id

    const nrs = await prisma.namedResource.findMany({ where: { resourceTypeId: tempRtId } })
    expect(nrs.length).toBe(1)
    const tempNrId = nrs[0].id

    expect(await countProfiles('ROLE', tempRtId)).toBe(1)
    expect(await countProfiles('NAMED_PERSON', tempNrId)).toBe(1)

    const delRes = await request(app)
      .delete(`/api/projects/${projectId}/resource-types/${tempRtId}`)
      .set('Authorization', authHeader)

    expect(delRes.status).toBe(200)

    expect(await countProfiles('ROLE', tempRtId)).toBe(0)
    expect(await countProfiles('NAMED_PERSON', tempNrId)).toBe(0)
    const remainingNr = await prisma.namedResource.findFirst({ where: { id: tempNrId } })
    expect(remainingNr).toBeNull()
  })

  it('9. count increase creates NAMED_PERSON profiles from authoritative ROLE state', async () => {
    const testRt = await createRuntimeResourceType('Count Increase RT')
    const testRtId = testRt.id as string
    const existingNrs = await prisma.namedResource.findMany({
      where: { resourceTypeId: testRtId },
      select: { id: true },
    })
    const existingNrIds = new Set(existingNrs.map(nr => nr.id))
    const roleProfile = await prisma.capacityProfile.findFirstOrThrow({
      where: { resourceTypeId: testRtId, namedResourceId: null, projectId },
    })

    const res = await request(app)
      .patch(`/api/projects/${projectId}/resource-types/${testRtId}`)
      .set('Authorization', authHeader)
      .send({ count: 3 })

    expect(res.status).toBe(200)

    const nrs = await prisma.namedResource.findMany({
      where: { resourceTypeId: testRtId },
      orderBy: { id: 'asc' },
    })
    expect(nrs.length).toBe(3)

    const createdNrs = nrs.filter(nr => !existingNrIds.has(nr.id))
    expect(createdNrs).toHaveLength(3 - existingNrs.length)

    for (const nr of createdNrs) {
      const nrProfile = await prisma.capacityProfile.findFirst({
        where: { namedResourceId: nr.id, resourceTypeId: null, projectId },
      })
      expect(nrProfile).toBeDefined()
      expect(nrProfile!.ownerKind).toBe('NAMED_PERSON')
      expect(nrProfile!.planningBasis).toBe(roleProfile.planningBasis)
      // Generated profiles carry the shared generation provenance (#403 finding 1)
      expect(nrProfile!.source).toBe('DERIVED')
      expect(nrProfile!.legacy).toMatchObject({ version: 1, writer: 'ROLE_DEFAULT' })
      expect(nrProfile!.defaultPercent).toBe(roleProfile.defaultPercent)
      expect(nrProfile!.startWeek).toBe(roleProfile.startWeek)
      expect(nrProfile!.endWeek).toBe(roleProfile.endWeek)
    }
  })

  it('10. authoritative profiles override stale compatibility for first-class writes and count changes', async () => {
    const createdRt = await createRuntimeResourceType('Stale Authority RT')
    const resourceTypeId = createdRt.id as string
    const initialNr = await prisma.namedResource.findFirstOrThrow({ where: { resourceTypeId } })
    const roleProfile = await prisma.capacityProfile.findFirstOrThrow({
      where: { projectId, resourceTypeId, namedResourceId: null },
    })
    const nrProfile = await prisma.capacityProfile.findFirstOrThrow({
      where: { projectId, namedResourceId: initialNr.id, resourceTypeId: null },
    })

    // First-class ROLE write — the profile is authoritative, compatibility follows
    const rtPut = await request(app)
      .put(`/api/projects/${projectId}/capacity-profiles/ROLE/${resourceTypeId}`)
      .set('Authorization', authHeader)
      .send({ planningBasis: 'AVAILABILITY_WINDOW', defaultPercent: 75, startWeek: 4, endWeek: 12 })
    expect(rtPut.status).toBe(200)
    expect(await getProfileId('ROLE', resourceTypeId)).toBe(roleProfile.id)

    // First-class NAMED_PERSON write
    const nrPut = await request(app)
      .put(`/api/projects/${projectId}/capacity-profiles/NAMED_PERSON/${initialNr.id}`)
      .set('Authorization', authHeader)
      .send({ planningBasis: 'AVAILABILITY_WINDOW', defaultPercent: 85, startWeek: 4, endWeek: 12 })
    expect(nrPut.status).toBe(200)
    expect(await getProfileId('NAMED_PERSON', initialNr.id)).toBe(nrProfile.id)

    // Legacy capacity request fields are rejected on the non-capacity routes (#403)
    const legacyRt = await request(app)
      .put(`/api/projects/${projectId}/resource-types/${resourceTypeId}`)
      .set('Authorization', authHeader)
      .send({ allocationPercent: 80 })
    expect(legacyRt.status).toBe(400)
    expect(legacyRt.body.rejectedFields).toEqual(['allocationPercent'])

    const legacyNr = await request(app)
      .put(`/api/projects/${projectId}/resource-types/${resourceTypeId}/named-resources/${initialNr.id}`)
      .set('Authorization', authHeader)
      .send({ allocationStartWeek: 5 })
    expect(legacyNr.status).toBe(400)
    expect(legacyNr.body.rejectedFields).toEqual(['allocationStartWeek'])

    const legacyPatch = await request(app)
      .patch(`/api/projects/${projectId}/resource-types/${resourceTypeId}/named-resources/${initialNr.id}`)
      .set('Authorization', authHeader)
      .send({ allocationStartWeek: 5 })
    expect(legacyPatch.status).toBe(400)
    expect(legacyPatch.body.rejectedFields).toEqual(['allocationStartWeek'])

    // POST derives the new NR profile from the authoritative ROLE profile
    const createNr = await request(app)
      .post(`/api/projects/${projectId}/resource-types/${resourceTypeId}/named-resources`)
      .set('Authorization', authHeader)
      .send({ name: 'Profile-derived creation' })
    expect(createNr.status).toBe(201)
    // Issue #418: identity creation returns the raw row — the legacy
    // columns no longer exist; the inherited capacity lives in the profile.
    expect(createNr.body).toMatchObject({
      name: 'Profile-derived creation',
    })

    // Count increase derives the inherited NR from the authoritative ROLE profile
    const existingIds = new Set(
      (await prisma.namedResource.findMany({ where: { resourceTypeId }, select: { id: true } }))
        .map(resource => resource.id),
    )
    const increase = await request(app)
      .patch(`/api/projects/${projectId}/resource-types/${resourceTypeId}`)
      .set('Authorization', authHeader)
      .send({ count: existingIds.size + 1 })
    expect(increase.status).toBe(200)

    const increasedResources = await prisma.namedResource.findMany({ where: { resourceTypeId } })
    const inherited = increasedResources.find(resource => !existingIds.has(resource.id))
    // Issue #418: count-increase NR creation writes identity only — capacity
    // is expressed through the inherited profile asserted below.
    expect(inherited).not.toBeNull()
    const inheritedProfile = await prisma.capacityProfile.findFirstOrThrow({
      where: { projectId, namedResourceId: inherited!.id, resourceTypeId: null },
    })
    expect(inheritedProfile).toMatchObject({
      planningBasis: 'AVAILABILITY_WINDOW',
      source: 'DERIVED',
      defaultPercent: 75,
      startWeek: 4,
      endWeek: 12,
    })

    // Count reduction removes the inherited NR and its profile
    const reduction = await request(app)
      .patch(`/api/projects/${projectId}/resource-types/${resourceTypeId}`)
      .set('Authorization', authHeader)
      .send({ count: existingIds.size })
    expect(reduction.status).toBe(200)
    expect(await prisma.namedResource.findUnique({ where: { id: inherited!.id } })).toBeNull()
    expect(await prisma.capacityProfile.findUnique({ where: { id: inheritedProfile.id } })).toBeNull()
  })
  it('11. count changes on a planner-owned role are rejected with 409 and no partial mutation', async () => {
    const createdRt = await createRuntimeResourceType('Capacity Exit RT')
    const resourceTypeId = createdRt.id as string
    const protectedNr = await prisma.namedResource.findFirstOrThrow({ where: { resourceTypeId } })
    const roleProfile = await prisma.capacityProfile.findFirstOrThrow({
      where: { projectId, resourceTypeId, namedResourceId: null },
    })
    const protectedProfile = await prisma.capacityProfile.findFirstOrThrow({
      where: { projectId, namedResourceId: protectedNr.id, resourceTypeId: null },
    })

    await prisma.capacityProfile.update({
      where: { id: roleProfile.id },
      data: {
        planningBasis: 'CAPACITY_PROFILE',
        source: 'SQUAD_PLANNER',
        defaultPercent: 60,
        startWeek: null,
        endWeek: null,
      },
    })
    await prisma.capacitySegment.createMany({
      data: [
        { capacityProfileId: roleProfile.id, startWeek: 0, endWeek: 3, capacityPercent: 100, source: 'SQUAD_PLANNER' },
        { capacityProfileId: roleProfile.id, startWeek: 4, endWeek: 5, capacityPercent: 0, source: 'SQUAD_PLANNER' },
        { capacityProfileId: roleProfile.id, startWeek: 6, endWeek: 11, capacityPercent: 50, source: 'SQUAD_PLANNER' },
      ],
    })
    await prisma.capacityProfile.update({
      where: { id: protectedProfile.id },
      data: {
        planningBasis: 'CAPACITY_PROFILE',
        source: 'SQUAD_PLANNER',
        defaultPercent: 40,
        startWeek: null,
        endWeek: null,
      },
    })
    await prisma.capacitySegment.createMany({
      data: [
        { capacityProfileId: protectedProfile.id, startWeek: 0, endWeek: 1, capacityPercent: 100, source: 'SQUAD_PLANNER' },
        { capacityProfileId: protectedProfile.id, startWeek: 2, endWeek: 3, capacityPercent: 0, source: 'SQUAD_PLANNER' },
        { capacityProfileId: protectedProfile.id, startWeek: 4, endWeek: 7, capacityPercent: 40, source: 'SQUAD_PLANNER' },
      ],
    })
    await seedDistinctCache()
    const before = await snapshotRuntimeState(resourceTypeId)

    const response = await request(app)
      .patch(`/api/projects/${projectId}/resource-types/${resourceTypeId}`)
      .set('Authorization', authHeader)
      .send({ count: 2 })
    expect(response.status).toBe(409)
    expect(response.body.code).toBe('PLANNER_MANAGED_IDENTITY')
    expect(response.body.error).toContain('Switch to manual capacity')

    // Complete state — profiles, segments, resources, cache — unchanged
    expect(await snapshotRuntimeState(resourceTypeId)).toEqual(before)
  })
  it('12. count reduction deletes only inherited resources and preserves protected state exactly', async () => {
    const createdRt = await createRuntimeResourceType('Protected Reduction RT')
    const resourceTypeId = createdRt.id as string
    const explicitNr = await prisma.namedResource.findFirstOrThrow({ where: { resourceTypeId } })
    const initialIds = new Set([explicitNr.id])

    const increase = await request(app)
      .patch(`/api/projects/${projectId}/resource-types/${resourceTypeId}`)
      .set('Authorization', authHeader)
      .send({ count: 2 })
    expect(increase.status).toBe(200)
    const inheritedNr = (await prisma.namedResource.findMany({ where: { resourceTypeId } }))
      .find(resource => !initialIds.has(resource.id))!
    const inheritedProfile = await prisma.capacityProfile.findFirstOrThrow({
      where: { projectId, namedResourceId: inheritedNr.id, resourceTypeId: null },
    })

    const segmentedResponse = await request(app)
      .post(`/api/projects/${projectId}/resource-types/${resourceTypeId}/named-resources`)
      .set('Authorization', authHeader)
      .send({ name: 'Segmented protected resource' })
    expect(segmentedResponse.status).toBe(201)
    const segmentedNrId = segmentedResponse.body.id as string
    const segmentedProfile = await prisma.capacityProfile.findFirstOrThrow({
      where: { projectId, namedResourceId: segmentedNrId, resourceTypeId: null },
    })
    await prisma.capacityProfile.update({
      where: { id: segmentedProfile.id },
      data: {
        planningBasis: 'CAPACITY_PROFILE',
        source: 'MANUAL',
        defaultPercent: 50,
        startWeek: null,
        endWeek: null,
      },
    })
    await prisma.capacitySegment.createMany({
      data: [
        { capacityProfileId: segmentedProfile.id, startWeek: 0, endWeek: 2, capacityPercent: 80, source: 'MANUAL' },
        { capacityProfileId: segmentedProfile.id, startWeek: 3, endWeek: 4, capacityPercent: 0, source: 'MANUAL' },
        { capacityProfileId: segmentedProfile.id, startWeek: 5, endWeek: 8, capacityPercent: 50, source: 'MANUAL' },
      ],
    })

    // Planner-owned resources block count changes outright (covered by
    // tests 11 and the legacy-alias-removal suite); the protected set here is
    // the explicitly created resource and a manually segmented resource,
    // both of which must survive a count reduction untouched.
    const protectedNrIds = [explicitNr.id, segmentedNrId]
    const protectedResourcesBefore = await prisma.namedResource.findMany({
      where: { id: { in: protectedNrIds } },
      orderBy: { id: 'asc' },
    })
    const protectedProfilesBefore = await prisma.capacityProfile.findMany({
      where: { namedResourceId: { in: protectedNrIds } },
      include: { segments: { orderBy: [{ startWeek: 'asc' }, { id: 'asc' }] } },
      orderBy: { id: 'asc' },
    })
    expect(protectedProfilesBefore).toHaveLength(2)
    expect(protectedProfilesBefore.every(profile => profile.startWeek === null && profile.endWeek === null)).toBe(true)
    expect(protectedProfilesBefore
      .filter(profile => profile.segments.length > 0)
      .every(profile => profile.segments.some(segment => segment.capacityPercent === 0))).toBe(true)

    // Current count is 3 (explicit + inherited + segmented); reducing to 2
    // must remove exactly the system-created inherited resource.
    const reduction = await request(app)
      .patch(`/api/projects/${projectId}/resource-types/${resourceTypeId}`)
      .set('Authorization', authHeader)
      .send({ count: 2 })
    expect(reduction.status).toBe(200)

    expect(await prisma.namedResource.findUnique({ where: { id: inheritedNr.id } })).toBeNull()
    expect(await prisma.capacityProfile.findUnique({ where: { id: inheritedProfile.id } })).toBeNull()
    expect(await prisma.namedResource.findMany({
      where: { id: { in: protectedNrIds } },
      orderBy: { id: 'asc' },
    })).toEqual(protectedResourcesBefore)
    expect(await prisma.capacityProfile.findMany({
      where: { namedResourceId: { in: protectedNrIds } },
      include: { segments: { orderBy: [{ startWeek: 'asc' }, { id: 'asc' }] } },
      orderBy: { id: 'asc' },
    })).toEqual(protectedProfilesBefore)
  })

  it('13. rolls back the complete count/profile change after transactional writes begin', async () => {
    const createdRt = await createRuntimeResourceType('Rollback RT')
    const resourceTypeId = createdRt.id as string
    const roleProfile = await prisma.capacityProfile.findFirstOrThrow({
      where: { projectId, resourceTypeId, namedResourceId: null },
    })
    // Transferred-style manual segmented role: count operations are allowed
    // and the injected seam must roll back everything.
    await prisma.capacityProfile.update({
      where: { id: roleProfile.id },
      data: {
        planningBasis: 'CAPACITY_PROFILE',
        source: 'MANUAL',
        defaultPercent: 60,
        startWeek: null,
        endWeek: null,
      },
    })
    await prisma.capacitySegment.createMany({
      data: [
        { capacityProfileId: roleProfile.id, startWeek: 0, endWeek: 2, capacityPercent: 100, source: 'MANUAL' },
        { capacityProfileId: roleProfile.id, startWeek: 3, endWeek: 4, capacityPercent: 0, source: 'MANUAL' },
        { capacityProfileId: roleProfile.id, startWeek: 5, endWeek: 8, capacityPercent: 50, source: 'MANUAL' },
      ],
    })
    await prisma.project.update({
      where: { id: projectId },
      data: { weeklyDemandCache: { rollbackMarker: 'unchanged' } },
    })
    await prisma.capacityPlan.create({
      data: {
        projectId,
        name: 'Rollback active plan',
        targetWeeks: 9,
        periodWeeks: 4,
        isActive: true,
        periods: {
          create: [{
            periodIndex: 0,
            startWeek: 0,
            endWeek: 3,
            entries: {
              create: [{
                resourceTypeId,
                headcount: 1,
                demandFTE: 0.8,
                utilisationPct: 80,
              }],
            },
          }],
        },
      },
    })

    const before = await snapshotRuntimeState(resourceTypeId)
    __setRTPatchFailureSeam(() => {
      throw new Error('deterministic rollback seam')
    })
    try {
      const response = await request(app)
        .patch(`/api/projects/${projectId}/resource-types/${resourceTypeId}`)
        .set('Authorization', authHeader)
        .send({ count: 2 })
      expect(response.status).toBe(500)
    } finally {
      __setRTPatchFailureSeam(null)
    }

    expect(await snapshotRuntimeState(resourceTypeId)).toEqual(before)
  })
  it('14. rejects missing and malformed ROLE authority before scalar writes', async () => {
    const cases = [
      { name: 'missing', profile: null, segments: [] },
      {
        name: 'segmentless capacity profile',
        profile: {
          planningBasis: 'CAPACITY_PROFILE' as const,
          source: 'SQUAD_PLANNER' as const,
          defaultPercent: 50,
          startWeek: null,
          endWeek: null,
        },
        segments: [],
      },
      {
        name: 'invalid window',
        profile: {
          planningBasis: 'AVAILABILITY_WINDOW' as const,
          source: 'AVAILABILITY_WINDOW' as const,
          defaultPercent: 50,
          startWeek: 9,
          endWeek: 3,
        },
        segments: [],
      },
      {
        name: 'overlapping segments',
        profile: {
          planningBasis: 'CAPACITY_PROFILE' as const,
          source: 'SQUAD_PLANNER' as const,
          defaultPercent: 50,
          startWeek: null,
          endWeek: null,
        },
        segments: [
          { startWeek: 0, endWeek: 4, capacityPercent: 100, source: 'SQUAD_PLANNER' as const },
          { startWeek: 4, endWeek: 8, capacityPercent: 50, source: 'SQUAD_PLANNER' as const },
        ],
      },
      {
        name: 'duplicate segments',
        profile: {
          planningBasis: 'CAPACITY_PROFILE' as const,
          source: 'SQUAD_PLANNER' as const,
          defaultPercent: 50,
          startWeek: null,
          endWeek: null,
        },
        segments: [
          { startWeek: 0, endWeek: 4, capacityPercent: 100, source: 'SQUAD_PLANNER' as const },
          { startWeek: 0, endWeek: 4, capacityPercent: 100, source: 'SQUAD_PLANNER' as const },
        ],
      },
    ]

    for (const testCase of cases) {
      const resourceType = await prisma.resourceType.create({
        data: {
          projectId,
          name: `Invalid authority: ${testCase.name}`,
          category: 'ENGINEERING',
          count: 0,
        },
      })
      if (testCase.profile) {
        await prisma.capacityProfile.create({
          data: {
            projectId,
            resourceTypeId: resourceType.id,
            namedResourceId: null,
            ownerKind: 'ROLE',
            ...testCase.profile,
            segments: testCase.segments.length > 0
              ? { create: testCase.segments }
              : undefined,
          },
        })
      }

      const response = await request(app)
        .put(`/api/projects/${projectId}/resource-types/${resourceType.id}`)
        .set('Authorization', authHeader)
        .send({ name: 'must not be written' })
      expect(response.status, testCase.name).toBe(409)
      expect(response.body.code, testCase.name).toBe('CAPACITY_INTEGRITY_ERROR')
      expect(await prisma.resourceType.findUniqueOrThrow({ where: { id: resourceType.id } }))
        .toMatchObject({ name: `Invalid authority: ${testCase.name}`, count: 0 })
    }
  })

  it('15. enforces duplicate-owner constraints in PostgreSQL', async () => {
    const resourceType = await prisma.resourceType.create({
      data: { projectId, name: 'Duplicate owner constraint', category: 'ENGINEERING', count: 0 },
    })
    await prisma.capacityProfile.create({
      data: {
        projectId,
        resourceTypeId: resourceType.id,
        namedResourceId: null,
        ownerKind: 'ROLE',
        planningBasis: 'AVAILABILITY_WINDOW',
        source: 'AVAILABILITY_WINDOW',
        defaultPercent: 100,
        startWeek: null,
        endWeek: null,
      },
    })
    await expect(prisma.capacityProfile.create({
      data: {
        projectId,
        resourceTypeId: resourceType.id,
        namedResourceId: null,
        ownerKind: 'ROLE',
        planningBasis: 'DEMAND_FOLLOWING',
        source: 'FIXED',
        defaultPercent: 100,
        startWeek: null,
        endWeek: null,
      },
    })).rejects.toMatchObject({ code: 'P2002' })
  })

  it('16. rejects cross-project NamedResource authority before non-capacity writes', async () => {
    const createdRt = await createRuntimeResourceType('NamedResource authority RT')
    const resourceTypeId = createdRt.id as string
    const namedResource = await prisma.namedResource.findFirstOrThrow({ where: { resourceTypeId } })
    const profile = await prisma.capacityProfile.findFirstOrThrow({
      where: { projectId, namedResourceId: namedResource.id, resourceTypeId: null },
    })

    const otherProject = await prisma.project.create({
      data: { name: 'Cross-project authority owner', ownerId: userId },
    })
    await prisma.capacityProfile.delete({ where: { id: profile.id } })
    const crossProjectProfile = await prisma.capacityProfile.create({
      data: {
        projectId: otherProject.id,
        resourceTypeId: null,
        namedResourceId: namedResource.id,
        ownerKind: 'NAMED_PERSON',
        planningBasis: 'DEMAND_FOLLOWING',
        source: 'FIXED',
        defaultPercent: 100,
        startWeek: null,
        endWeek: null,
      },
    })
    try {
      const crossProject = await request(app)
        .put(`/api/projects/${projectId}/resource-types/${resourceTypeId}/named-resources/${namedResource.id}`)
        .set('Authorization', authHeader)
        .send({ pricingModel: 'PRO_RATA' })
      expect(crossProject.status).toBe(409)
      expect(crossProject.body.code).toBe('CAPACITY_INTEGRITY_ERROR')
      expect(await prisma.namedResource.findUniqueOrThrow({ where: { id: namedResource.id } }))
        .toMatchObject({ pricingModel: namedResource.pricingModel })
      expect(await prisma.capacityProfile.findUnique({ where: { id: profile.id } })).toBeNull()
      expect(await prisma.capacityProfile.findUniqueOrThrow({ where: { id: crossProjectProfile.id } }))
        .toMatchObject({ projectId: otherProject.id, namedResourceId: namedResource.id })
    } finally {
      await prisma.project.delete({ where: { id: otherProject.id } })
    }
  })

  it('17. scoped NamedResource and ResourceType deletion leave unrelated owners unchanged', async () => {
    const survivorRt = await createRuntimeResourceType('Deletion survivor RT')
    const targetRt = await createRuntimeResourceType('Deletion target RT')
    const survivorRole = await prisma.capacityProfile.findFirstOrThrow({
      where: { projectId, resourceTypeId: survivorRt.id, namedResourceId: null },
    })
    await prisma.capacityProfile.update({
      where: { id: survivorRole.id },
      data: {
        planningBasis: 'CAPACITY_PROFILE',
        source: 'MANUAL',
        defaultPercent: 70,
        startWeek: null,
        endWeek: null,
      },
    })
    await prisma.capacitySegment.createMany({
      data: [
        { capacityProfileId: survivorRole.id, startWeek: 0, endWeek: 2, capacityPercent: 70, source: 'MANUAL' },
        { capacityProfileId: survivorRole.id, startWeek: 3, endWeek: 4, capacityPercent: 0, source: 'MANUAL' },
      ],
    })
    const survivorResourcesBefore = await prisma.namedResource.findMany({
      where: { resourceTypeId: survivorRt.id },
      orderBy: { id: 'asc' },
    })
    const survivorProfilesBefore = await prisma.capacityProfile.findMany({
      where: {
        projectId,
        OR: [{ resourceTypeId: survivorRt.id }, { namedResource: { resourceTypeId: survivorRt.id } }],
      },
      include: { segments: { orderBy: [{ startWeek: 'asc' }, { id: 'asc' }] } },
      orderBy: { id: 'asc' },
    })

    const targetNr = await prisma.namedResource.findFirstOrThrow({
      where: { resourceTypeId: targetRt.id },
    })
    const targetNrProfile = await prisma.capacityProfile.findFirstOrThrow({
      where: { projectId, namedResourceId: targetNr.id, resourceTypeId: null },
    })
    await prisma.capacityProfile.update({
      where: { id: targetNrProfile.id },
      data: {
        planningBasis: 'CAPACITY_PROFILE',
        source: 'MANUAL',
        defaultPercent: 50,
        startWeek: null,
        endWeek: null,
      },
    })
    const targetNrSegment = await prisma.capacitySegment.create({
      data: {
        capacityProfileId: targetNrProfile.id,
        startWeek: 2,
        endWeek: 5,
        capacityPercent: 50,
        source: 'MANUAL',
      },
    })

    const deleteNr = await request(app)
      .delete(`/api/projects/${projectId}/resource-types/${targetRt.id}/named-resources/${targetNr.id}`)
      .set('Authorization', authHeader)
    expect(deleteNr.status).toBe(204)
    expect(await prisma.namedResource.findUnique({ where: { id: targetNr.id } })).toBeNull()
    expect(await prisma.capacityProfile.findUnique({ where: { id: targetNrProfile.id } })).toBeNull()
    expect(await prisma.capacitySegment.findUnique({ where: { id: targetNrSegment.id } })).toBeNull()
    expect(await prisma.capacityProfile.findMany({
      where: {
        projectId,
        OR: [{ resourceTypeId: survivorRt.id }, { namedResource: { resourceTypeId: survivorRt.id } }],
      },
      include: { segments: { orderBy: [{ startWeek: 'asc' }, { id: 'asc' }] } },
      orderBy: { id: 'asc' },
    })).toEqual(survivorProfilesBefore)

    const replacementNrResponse = await request(app)
      .post(`/api/projects/${projectId}/resource-types/${targetRt.id}/named-resources`)
      .set('Authorization', authHeader)
      .send({ name: 'Target replacement' })
    expect(replacementNrResponse.status).toBe(201)
    const targetRole = await prisma.capacityProfile.findFirstOrThrow({
      where: { projectId, resourceTypeId: targetRt.id, namedResourceId: null },
    })
    await prisma.capacityProfile.update({
      where: { id: targetRole.id },
      data: {
        planningBasis: 'CAPACITY_PROFILE',
        source: 'SQUAD_PLANNER',
        defaultPercent: 100,
        startWeek: null,
        endWeek: null,
      },
    })
    const targetRoleSegment = await prisma.capacitySegment.create({
      data: {
        capacityProfileId: targetRole.id,
        startWeek: 0,
        endWeek: 8,
        capacityPercent: 100,
        source: 'SQUAD_PLANNER',
      },
    })
    const targetProfileIds = (await prisma.capacityProfile.findMany({
      where: {
        projectId,
        OR: [{ resourceTypeId: targetRt.id }, { namedResource: { resourceTypeId: targetRt.id } }],
      },
      select: { id: true },
    })).map(profile => profile.id)

    const deleteRt = await request(app)
      .delete(`/api/projects/${projectId}/resource-types/${targetRt.id}`)
      .set('Authorization', authHeader)
    expect(deleteRt.status).toBe(200)
    expect(await prisma.resourceType.findUnique({ where: { id: targetRt.id } })).toBeNull()
    expect(await prisma.capacityProfile.count({ where: { id: { in: targetProfileIds } } })).toBe(0)
    expect(await prisma.capacitySegment.findUnique({ where: { id: targetRoleSegment.id } })).toBeNull()
    expect(await prisma.namedResource.findMany({
      where: { resourceTypeId: survivorRt.id },
      orderBy: { id: 'asc' },
    })).toEqual(survivorResourcesBefore)
    expect(await prisma.capacityProfile.findMany({
      where: {
        projectId,
        OR: [{ resourceTypeId: survivorRt.id }, { namedResource: { resourceTypeId: survivorRt.id } }],
      },
      include: { segments: { orderBy: [{ startWeek: 'asc' }, { id: 'asc' }] } },
      orderBy: { id: 'asc' },
    })).toEqual(survivorProfilesBefore)
  })

  it('18. named-resource POST on a planner-owned role returns 409 with complete state unchanged', async () => {
    const createdRt = await createRuntimeResourceType('POST CAPACITY_PLAN Exit RT')
    const resourceTypeId = createdRt.id as string
    const protectedNr = await prisma.namedResource.findFirstOrThrow({ where: { resourceTypeId } })
    const roleProfile = await prisma.capacityProfile.findFirstOrThrow({
      where: { projectId, resourceTypeId, namedResourceId: null },
    })

    await prisma.capacityProfile.update({
      where: { id: roleProfile.id },
      data: {
        planningBasis: 'CAPACITY_PROFILE',
        source: 'SQUAD_PLANNER',
        defaultPercent: 60,
        startWeek: null,
        endWeek: null,
      },
    })
    await prisma.capacitySegment.createMany({
      data: [
        { capacityProfileId: roleProfile.id, startWeek: 0, endWeek: 3, capacityPercent: 100, source: 'SQUAD_PLANNER' },
        { capacityProfileId: roleProfile.id, startWeek: 4, endWeek: 5, capacityPercent: 0, source: 'SQUAD_PLANNER' },
      ],
    })
    const protectedProfile = await prisma.capacityProfile.findFirstOrThrow({
      where: { projectId, namedResourceId: protectedNr.id, resourceTypeId: null },
    })
    await prisma.capacityProfile.update({
      where: { id: protectedProfile.id },
      data: {
        planningBasis: 'CAPACITY_PROFILE',
        source: 'SQUAD_PLANNER',
        defaultPercent: 40,
        startWeek: null,
        endWeek: null,
      },
    })
    await prisma.capacitySegment.createMany({
      data: [
        { capacityProfileId: protectedProfile.id, startWeek: 0, endWeek: 1, capacityPercent: 100, source: 'SQUAD_PLANNER' },
        { capacityProfileId: protectedProfile.id, startWeek: 2, endWeek: 3, capacityPercent: 0, source: 'SQUAD_PLANNER' },
      ],
    })
    await seedDistinctCache()
    const before = await snapshotRuntimeState(resourceTypeId)

    // POST a new named resource — the planner-owned role rejects the identity
    // change before any write and directs the user to the transfer workflow
    const postResponse = await request(app)
      .post(`/api/projects/${projectId}/resource-types/${resourceTypeId}/named-resources`)
      .set('Authorization', authHeader)
      .send({ name: 'Post Exit Person' })
    expect(postResponse.status).toBe(409)
    expect(postResponse.body.code).toBe('PLANNER_MANAGED_IDENTITY')
    expect(postResponse.body.error).toContain('Switch to manual capacity')

    // Complete state — role profile, segments, NRs, count and cache — unchanged
    expect(await snapshotRuntimeState(resourceTypeId)).toEqual(before)
    expect(await prisma.namedResource.count({ where: { resourceTypeId } })).toBe(1)
  }, 30000)
  it('19. named-resource DELETE on a planner-owned role returns 409 with complete state unchanged', async () => {
    const createdRt = await createRuntimeResourceType('DELETE CAPACITY_PLAN Exit RT')
    const resourceTypeId = createdRt.id as string
    const targetNr = await prisma.namedResource.findFirstOrThrow({ where: { resourceTypeId } })
    const roleProfile = await prisma.capacityProfile.findFirstOrThrow({
      where: { projectId, resourceTypeId, namedResourceId: null },
    })

    await prisma.capacityProfile.update({
      where: { id: roleProfile.id },
      data: {
        planningBasis: 'CAPACITY_PROFILE',
        source: 'SQUAD_PLANNER',
        defaultPercent: 60,
        startWeek: null,
        endWeek: null,
      },
    })
    await prisma.capacitySegment.createMany({
      data: [
        { capacityProfileId: roleProfile.id, startWeek: 0, endWeek: 3, capacityPercent: 100, source: 'SQUAD_PLANNER' },
      ],
    })
    await seedDistinctCache()
    const before = await snapshotRuntimeState(resourceTypeId)

    const deleteResponse = await request(app)
      .delete(`/api/projects/${projectId}/resource-types/${resourceTypeId}/named-resources/${targetNr.id}`)
      .set('Authorization', authHeader)
    expect(deleteResponse.status).toBe(409)
    expect(deleteResponse.body.code).toBe('PLANNER_MANAGED_IDENTITY')
    expect(deleteResponse.body.error).toContain('Switch to manual capacity')

    // Complete state — role profile, segments, NRs, count and cache — unchanged
    expect(await snapshotRuntimeState(resourceTypeId)).toEqual(before)
  }, 30000)
  it('21. name-only PUT preserves canonical zero-capacity planner profile', async () => {
    const createdRt = await createRuntimeResourceType('ZeroCap PUT RT')
    const resourceTypeId = createdRt.id as string

    // Add a surplus PLANNED_RESOURCE with canonical zero-capacity profile
    const surplus = await prisma.namedResource.create({
      data: { name: 'Surplus Zero', resourceTypeId },
    })
    await prisma.capacityProfile.create({
      data: {
        projectId,
        ownerKind: 'PLANNED_RESOURCE',
        source: 'SQUAD_PLANNER',
        planningBasis: 'CAPACITY_PROFILE',
        defaultPercent: 0,
        startWeek: null,
        endWeek: null,
        namedResourceId: surplus.id,
        resourceTypeId: null,
      },
    })

    const beforeProfile = await prisma.capacityProfile.findFirstOrThrow({
      where: { namedResourceId: surplus.id, projectId },
    })
    const beforeNr = await prisma.namedResource.findUniqueOrThrow({ where: { id: surplus.id } })
    const beforeCache = await prisma.project.findUniqueOrThrow({
      where: { id: projectId },
      select: { weeklyDemandCache: true },
    })

    const response = await request(app)
      .put(`/api/projects/${projectId}/resource-types/${resourceTypeId}/named-resources/${surplus.id}`)
      .set('Authorization', authHeader)
      .send({ name: 'Renamed Surplus' })
    expect(response.status).toBe(200)

    const afterNr = await prisma.namedResource.findUniqueOrThrow({ where: { id: surplus.id } })
    expect(afterNr.name).toBe('Renamed Surplus')

    const afterProfile = await prisma.capacityProfile.findUniqueOrThrow({
      where: { id: beforeProfile.id },
    })
    expect(afterProfile.id).toBe(beforeProfile.id)
    expect(afterProfile.ownerKind).toBe('PLANNED_RESOURCE')
    expect(afterProfile.source).toBe('SQUAD_PLANNER')
    expect(afterProfile.planningBasis).toBe('CAPACITY_PROFILE')
    expect(afterProfile.defaultPercent).toBe(0)
    expect(afterProfile.startWeek).toBeNull()
    expect(afterProfile.endWeek).toBeNull()

    const segments = await prisma.capacitySegment.findMany({
      where: { capacityProfileId: beforeProfile.id },
    })
    expect(segments).toHaveLength(0)

    expect(afterNr.pricingModel).toBe(beforeNr.pricingModel)

    const afterCache = await prisma.project.findUniqueOrThrow({
      where: { id: projectId },
      select: { weeklyDemandCache: true },
    })
    expect(afterCache).toEqual(beforeCache)
  }, 30000)

  it('22. pricing-only PUT preserves canonical zero-capacity planner profile', async () => {
    const createdRt = await createRuntimeResourceType('ZeroCap Pricing RT')
    const resourceTypeId = createdRt.id as string

    const surplus = await prisma.namedResource.create({
      data: { name: 'Pricing Surplus', resourceTypeId, pricingModel: 'ACTUAL_DAYS' },
    })
    await prisma.capacityProfile.create({
      data: {
        projectId,
        ownerKind: 'PLANNED_RESOURCE',
        source: 'SQUAD_PLANNER',
        planningBasis: 'CAPACITY_PROFILE',
        defaultPercent: 0,
        startWeek: null,
        endWeek: null,
        namedResourceId: surplus.id,
        resourceTypeId: null,
      },
    })

    const beforeProfile = await prisma.capacityProfile.findFirstOrThrow({
      where: { namedResourceId: surplus.id, projectId },
    })

    const response = await request(app)
      .put(`/api/projects/${projectId}/resource-types/${resourceTypeId}/named-resources/${surplus.id}`)
      .set('Authorization', authHeader)
      .send({ pricingModel: 'PRO_RATA' })
    expect(response.status).toBe(200)

    const afterNr = await prisma.namedResource.findUniqueOrThrow({ where: { id: surplus.id } })
    expect(afterNr.pricingModel).toBe('PRO_RATA')
    expect(afterNr.name).toBe('Pricing Surplus')

    const afterProfile = await prisma.capacityProfile.findUniqueOrThrow({
      where: { id: beforeProfile.id },
    })
    expect(afterProfile.id).toBe(beforeProfile.id)
    expect(afterProfile.ownerKind).toBe('PLANNED_RESOURCE')
    expect(afterProfile.source).toBe('SQUAD_PLANNER')
    expect(afterProfile.planningBasis).toBe('CAPACITY_PROFILE')
    expect(afterProfile.defaultPercent).toBe(0)
    expect(afterProfile.startWeek).toBeNull()
    expect(afterProfile.endWeek).toBeNull()

    const segments = await prisma.capacitySegment.findMany({
      where: { capacityProfileId: beforeProfile.id },
    })
    expect(segments).toHaveLength(0)
  }, 30000)

  it('23. scalar capacity change on zero-capacity planner resource is rejected with 400', async () => {
    const createdRt = await createRuntimeResourceType('ZeroCap Reject RT')
    const resourceTypeId = createdRt.id as string

    const surplus = await prisma.namedResource.create({
      data: { name: 'Protected Zero', resourceTypeId, pricingModel: 'ACTUAL_DAYS' },
    })
    await prisma.capacityProfile.create({
      data: {
        projectId,
        ownerKind: 'PLANNED_RESOURCE',
        source: 'SQUAD_PLANNER',
        planningBasis: 'CAPACITY_PROFILE',
        defaultPercent: 0,
        startWeek: null,
        endWeek: null,
        namedResourceId: surplus.id,
        resourceTypeId: null,
      },
    })

    const beforeNr = await prisma.namedResource.findUniqueOrThrow({ where: { id: surplus.id } })
    const beforeProfile = await prisma.capacityProfile.findFirstOrThrow({
      where: { namedResourceId: surplus.id, projectId },
    })
    const beforeRt = await prisma.resourceType.findUniqueOrThrow({ where: { id: resourceTypeId } })
    const beforeCache = await prisma.project.findUniqueOrThrow({
      where: { id: projectId },
      select: { weeklyDemandCache: true },
    })

    const response = await request(app)
      .put(`/api/projects/${projectId}/resource-types/${resourceTypeId}/named-resources/${surplus.id}`)
      .set('Authorization', authHeader)
      .send({ allocationPercent: 50 })
    // The supplied legacy capacity field is rejected before any write
    expect(response.status).toBe(400)
    expect(response.body.rejectedFields).toEqual(['allocationPercent'])

    // State unchanged
    expect(await prisma.namedResource.findUniqueOrThrow({ where: { id: surplus.id } })).toEqual(beforeNr)
    expect(await prisma.capacityProfile.findUniqueOrThrow({
      where: { id: beforeProfile.id },
    })).toEqual(beforeProfile)
    expect(await prisma.resourceType.findUniqueOrThrow({ where: { id: resourceTypeId } })).toEqual(beforeRt)
    expect(await prisma.project.findUniqueOrThrow({
      where: { id: projectId },
      select: { weeklyDemandCache: true },
    })).toEqual(beforeCache)

    const segments = await prisma.capacitySegment.findMany({
      where: { capacityProfileId: beforeProfile.id },
    })
    expect(segments).toHaveLength(0)
  }, 30000)
  it('24. ResourceType count changes on a role with a planner-owned resource return 409', async () => {
    const createdRt = await createRuntimeResourceType('ZeroCap Count RT')
    const resourceTypeId = createdRt.id as string

    const surplus = await prisma.namedResource.create({
      data: { name: 'Count Surplus', resourceTypeId },
    })
    await prisma.capacityProfile.create({
      data: {
        projectId,
        ownerKind: 'PLANNED_RESOURCE',
        source: 'SQUAD_PLANNER',
        planningBasis: 'CAPACITY_PROFILE',
        defaultPercent: 0,
        startWeek: null,
        endWeek: null,
        namedResourceId: surplus.id,
        resourceTypeId: null,
      },
    })

    await seedDistinctCache()
    const before = await snapshotRuntimeState(resourceTypeId)

    // Increase count — the planner-owned resource makes the role's identity
    // immutable until the user switches to manual capacity
    const increase = await request(app)
      .patch(`/api/projects/${projectId}/resource-types/${resourceTypeId}`)
      .set('Authorization', authHeader)
      .send({ count: 3 })
    expect(increase.status).toBe(409)
    expect(increase.body.code).toBe('PLANNER_MANAGED_IDENTITY')

    // Complete state unchanged
    expect(await snapshotRuntimeState(resourceTypeId)).toEqual(before)
  }, 30000)
  it('25. DELETE of a planner-owned resource returns 409 with complete state unchanged', async () => {
    const createdRt = await createRuntimeResourceType('ZeroCap DELETE RT')
    const resourceTypeId = createdRt.id as string
    const surplus = await prisma.namedResource.create({
      data: { name: 'Delete Surplus', resourceTypeId },
    })
    await prisma.capacityProfile.create({
      data: {
        projectId,
        ownerKind: 'PLANNED_RESOURCE',
        source: 'SQUAD_PLANNER',
        planningBasis: 'CAPACITY_PROFILE',
        defaultPercent: 0,
        startWeek: null,
        endWeek: null,
        namedResourceId: surplus.id,
        resourceTypeId: null,
      },
    })

    await seedDistinctCache()
    const before = await snapshotRuntimeState(resourceTypeId)

    const response = await request(app)
      .delete(`/api/projects/${projectId}/resource-types/${resourceTypeId}/named-resources/${surplus.id}`)
      .set('Authorization', authHeader)
    expect(response.status).toBe(409)
    expect(response.body.code).toBe('PLANNER_MANAGED_IDENTITY')
    expect(response.body.error).toContain('Switch to manual capacity')

    // Complete state unchanged
    expect(await snapshotRuntimeState(resourceTypeId)).toEqual(before)
    expect(await prisma.namedResource.count({ where: { resourceTypeId } })).toBe(2)
  }, 30000)
  it('26. malformed zero-capacity-like profile (defaultPercent=1) fails before writes', async () => {
    const createdRt = await createRuntimeResourceType('ZeroCap Malformed RT')
    const resourceTypeId = createdRt.id as string

    const malformed = await prisma.namedResource.create({
      data: { name: 'Malformed Surplus', resourceTypeId, pricingModel: 'ACTUAL_DAYS' },
    })
    await prisma.capacityProfile.create({
      data: {
        projectId,
        ownerKind: 'PLANNED_RESOURCE',
        source: 'SQUAD_PLANNER',
        planningBasis: 'CAPACITY_PROFILE',
        defaultPercent: 1,  // not zero — non-canonical
        startWeek: null,
        endWeek: null,
        namedResourceId: malformed.id,
        resourceTypeId: null,
      },
    })

    const beforeNr = await prisma.namedResource.findUniqueOrThrow({ where: { id: malformed.id } })
    const beforeProfile = await prisma.capacityProfile.findFirstOrThrow({
      where: { namedResourceId: malformed.id, projectId },
    })
    const beforeRt = await prisma.resourceType.findUniqueOrThrow({ where: { id: resourceTypeId } })
    const beforeCache = await prisma.project.findUniqueOrThrow({
      where: { id: projectId },
      select: { weeklyDemandCache: true },
    })

    const response = await request(app)
      .put(`/api/projects/${projectId}/resource-types/${resourceTypeId}/named-resources/${malformed.id}`)
      .set('Authorization', authHeader)
      .send({ name: 'Should Not Rename' })
    expect(response.status).toBe(409)
    // The non-canonical profile (defaultPercent=1, zero segments) is rejected by
    // strict validation because it does not match the canonical zero-capacity
    // PLANNED_RESOURCE exception (requires defaultPercent === 0).

    // State unchanged
    expect(await prisma.namedResource.findUniqueOrThrow({ where: { id: malformed.id } })).toEqual(beforeNr)
    expect(await prisma.capacityProfile.findUniqueOrThrow({
      where: { id: beforeProfile.id },
    })).toEqual(beforeProfile)
    expect(await prisma.resourceType.findUniqueOrThrow({ where: { id: resourceTypeId } })).toEqual(beforeRt)
    expect(await prisma.project.findUniqueOrThrow({
      where: { id: projectId },
      select: { weeklyDemandCache: true },
    })).toEqual(beforeCache)
  }, 30000)

  it('27. CSV-created ResourceType accepted by Squad Planner adoption', async () => {
    // Create a fresh project to isolate from pre-existing profile pollution
    const cleanProject = await request(app)
      .post('/api/projects')
      .set('Authorization', authHeader)
      .send({ name: 'CSV Planner Adoption Project' })
    expect(cleanProject.status).toBe(201)
    const csvProjectId = cleanProject.body.id

    // Import CSV to create a new ResourceType with correct ROLE provenance
    const importResponse = await request(app)
      .post(`/api/projects/${csvProjectId}/backlog/import-csv`)
      .set('Authorization', authHeader)
      .send({
        rows: [
          { type: 'Epic', epic: 'CSV Planner Epic', errors: [], epicStatus: true },
          { type: 'Feature', epic: 'CSV Planner Epic', feature: 'CSV Planner Feature', errors: [] },
          { type: 'Story', epic: 'CSV Planner Epic', feature: 'CSV Planner Feature', story: 'CSV Planner Story', errors: [], storyStatus: true },
          { type: 'Task', epic: 'CSV Planner Epic', feature: 'CSV Planner Feature', story: 'CSV Planner Story', task: 'CSV Planner Task', resourceType: 'PlannerAdoptRT', hoursEffort: 8, durationDays: 1, errors: [] },
        ],
      })
    expect(importResponse.status).toBe(200)

    // Find the CSV-created ResourceType
    const csvRt = await prisma.resourceType.findFirstOrThrow({
      where: { projectId: csvProjectId, name: 'PlannerAdoptRT' },
    })
    const csvRtId = csvRt.id

    // Prove complete legacy provenance payload
    const roleProfile = await prisma.capacityProfile.findFirstOrThrow({
      where: { projectId: csvProjectId, resourceTypeId: csvRtId, namedResourceId: null },
    })
    expect(roleProfile.ownerKind).toBe('ROLE')
    expect(roleProfile.planningBasis).toBe('AVAILABILITY_WINDOW')
    expect(roleProfile.source).toBe('AVAILABILITY_WINDOW')
    expect(roleProfile.defaultPercent).toBe(100)
    expect(roleProfile.startWeek).toBeNull()
    expect(roleProfile.endWeek).toBeNull()

    // Verify legacy JSON field
    const rawProfile = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
      'SELECT legacy FROM "CapacityProfile" WHERE id = $1',
      roleProfile.id,
    )
    const legacy = rawProfile[0]?.legacy as Record<string, unknown> | null
    expect(legacy).not.toBeNull()
    expect(legacy).toMatchObject({
      allocationMode: 'TIMELINE',
      allocationPercent: 100,
      allocationPct: null,
      allocationStartWeek: null,
      allocationEndWeek: null,
      startWeek: null,
      endWeek: null,
    })

    // Create a NR for the CSV-created RT (CSV import does not auto-create one)
    const nrResponse = await request(app)
      .post(`/api/projects/${csvProjectId}/resource-types/${csvRtId}/named-resources`)
      .set('Authorization', authHeader)
      .send({})
    expect(nrResponse.status).toBe(201)

    // Apply Squad Planner — in a clean project with no pre-existing profile pollution
    const applyResponse = await request(app)
      .post(`/api/projects/${csvProjectId}/squad-plan/apply`)
      .set('Authorization', authHeader)
      .send({
        name: 'CSV Adoption Test Plan',
        targetWeeks: 12,
        periodWeeks: 4,
        maxDelta: 1,
        setActive: true,
        periods: [
          {
            periodIndex: 0,
            startWeek: 0,
            endWeek: 8,
            entries: [{
              resourceTypeId: csvRtId,
              headcount: 1,
              demandFTE: 0.5,
              utilisationPct: 100,
            }],
          },
        ],
      })
    expect(applyResponse.status).toBe(201)

    // Planner apply succeeded — ROLE profile now planner-owned with segments
    const postApplyRole = await prisma.capacityProfile.findUniqueOrThrow({
      where: { id: roleProfile.id },
      include: { segments: { orderBy: [{ startWeek: 'asc' }, { id: 'asc' }] } },
    })
    expect(postApplyRole.ownerKind).toBe('ROLE')
    expect(postApplyRole.planningBasis).toBe('CAPACITY_PROFILE')
    expect(postApplyRole.source).toBe('SQUAD_PLANNER')
    expect(postApplyRole.segments.length).toBeGreaterThan(0)

    // Clean up the isolated project
    await prisma.project.delete({ where: { id: csvProjectId } }).catch(() => {})
  }, 30000)
})