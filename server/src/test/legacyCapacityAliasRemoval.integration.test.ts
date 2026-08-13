/**
 * legacyCapacityAliasRemoval.integration.test.ts — Real PostgreSQL integration
 * tests for issue #403: legacy capacity API alias removal.
 *
 * Proves against the disposable PostgreSQL lifecycle:
 * - Planner-owned count/add/remove requests return 409 with NO partial
 *   mutation (profiles, segments, resources, count, weeklyDemandCache).
 * - Supported manual scalar ROLE profiles survive count/add/remove unchanged.
 * - Supported manual segmented ROLE profiles survive count/add/remove unchanged
 *   (profile ID, source, planning basis, percentage, window, segment
 *   IDs/order/boundaries/percentages all preserved).
 * - Explicit NamedResource profiles are never flattened or overwritten.
 * - Newly created or deleted owners leave complete, valid authoritative
 *   ownership (exactly one profile per owner).
 * - Injected transaction failure rolls back the complete identity/profile
 *   change (PATCH count increase via __setRTPatchFailureSeam).
 * - Legacy capacity request fields are rejected with 400 before any write
 *   and without clearing the weekly demand cache.
 *
 * Skipped unless INTEGRATION_TEST=true.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '@prisma/client'
import { app } from '../app.js'
import { __setRTPatchFailureSeam } from '../routes/resourceTypes.js'

vi.mock('../lib/prisma.js', async (importOriginal) => {
  return await importOriginal()
})

const runIntegration = process.env.INTEGRATION_TEST === 'true'
const describeIf = runIntegration ? describe : describe.skip

// ─── Shared state ───────────────────────────────────────────────────

let prisma: PrismaClient
let userId: string
let token: string
let authHeader: string

const USER_EMAIL = 'legacy-alias-403-integration@example.com'
const PROJ_NAME = 'Legacy Alias Removal #403'

let projectId: string

// ─── Setup ──────────────────────────────────────────────────────────

beforeAll(async () => {
  if (!runIntegration) return
  const adapter = new PrismaPg(process.env.DATABASE_URL!)
  prisma = new PrismaClient({ adapter })

  const user = await prisma.user.upsert({
    where: { email: USER_EMAIL },
    create: { email: USER_EMAIL, name: 'Test User', password: 'test-password' },
    update: {},
  })
  userId = user.id
  token = jwt.sign({ userId }, process.env.JWT_SECRET ?? 'test-secret')
  authHeader = `Bearer ${token}`
}, 30000)

afterAll(async () => {
  if (!runIntegration) return
  if (projectId) {
    await prisma.project.delete({ where: { id: projectId } }).catch(() => {})
  }
  await prisma.user.delete({ where: { email: USER_EMAIL } }).catch(() => {})
  await prisma.$disconnect()
}, 15000)

// ─── Helpers ────────────────────────────────────────────────────────

async function createProject() {
  const res = await request(app)
    .post('/api/projects')
    .set('Authorization', authHeader)
    .send({ name: PROJ_NAME })
  expect(res.status).toBe(201)
  return res.body.id as string
}

async function createRuntimeResourceType(name: string) {
  const response = await request(app)
    .post(`/api/projects/${projectId}/resource-types`)
    .set('Authorization', authHeader)
    .send({ name, category: 'ENGINEERING' })
  expect(response.status).toBe(201)
  return response.body
}

/** Seed a weeklyDemandCache value that cannot be mistaken for the default. */
async function seedDistinctCache() {
  await prisma.project.update({
    where: { id: projectId },
    data: { weeklyDemandCache: { [`403|${randomUUID()}`]: 123.75 } },
  })
}

async function readCache() {
  const project = await prisma.project.findUniqueOrThrow({
    where: { id: projectId },
    select: { weeklyDemandCache: true },
  })
  return project.weeklyDemandCache
}

async function snapshotRoleState(resourceTypeId: string) {
  const [resourceType, namedResources, profiles, project] = await Promise.all([
    prisma.resourceType.findUnique({ where: { id: resourceTypeId } }),
    prisma.namedResource.findMany({ where: { resourceTypeId }, orderBy: { id: 'asc' } }),
    prisma.capacityProfile.findMany({
      where: {
        projectId,
        OR: [
          { resourceTypeId },
          { namedResource: { resourceTypeId } },
        ],
      },
      include: { segments: { orderBy: [{ startWeek: 'asc' }, { id: 'asc' }] } },
      orderBy: { id: 'asc' },
    }),
    prisma.project.findUnique({ where: { id: projectId }, select: { weeklyDemandCache: true } }),
  ])
  return JSON.parse(JSON.stringify({
    resourceType,
    namedResources,
    profiles,
    weeklyDemandCache: project?.weeklyDemandCache,
  }))
}

async function profileCount(ownerKind: string, ownerId: string): Promise<number> {
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

async function everyOwnerHasExactlyOneProfile(resourceTypeId: string) {
  const nrs = await prisma.namedResource.findMany({ where: { resourceTypeId } })
  const roleCount = await profileCount('ROLE', resourceTypeId)
  if (roleCount !== 1) return `expected 1 ROLE profile, found ${roleCount}`
  for (const nr of nrs) {
    const count = await profileCount('NAMED_PERSON', nr.id)
    if (count !== 1) return `expected 1 NAMED_PERSON profile for ${nr.id}, found ${count}`
  }
  return null
}

// ─── Tests ──────────────────────────────────────────────────────────

describeIf('legacy capacity alias removal (#403)', () => {
  beforeAll(async () => {
    projectId = await createProject()
  })

  it('1. rejects legacy capacity fields on resource-type routes with 400, no write, no cache clear', async () => {
    const rt = await createRuntimeResourceType('Reject RT')
    await seedDistinctCache()
    const beforeCache = await readCache()
    const beforeState = await snapshotRoleState(rt.id)

    for (const method of ['put', 'patch'] as const) {
      const req = request(app)[method](`/api/projects/${projectId}/resource-types/${rt.id}`)
      const res = await req
        .set('Authorization', authHeader)
        .send({ allocationMode: 'EFFORT' })
      expect(res.status).toBe(400)
      expect(res.body.rejectedFields).toEqual(['allocationMode'])
      expect(res.body.error).toContain('capacity-profiles/:ownerKind/:ownerId')
    }

    const multi = await request(app)
      .put(`/api/projects/${projectId}/resource-types/${rt.id}`)
      .set('Authorization', authHeader)
      .send({ allocationPercent: null, startWeek: 3, endWeek: 9 })
    expect(multi.status).toBe(400)
    expect(multi.body.rejectedFields).toEqual(['allocationPercent', 'startWeek', 'endWeek'])

    const post = await request(app)
      .post(`/api/projects/${projectId}/resource-types`)
      .set('Authorization', authHeader)
      .send({ name: 'Reject POST', category: 'ENGINEERING', allocationPct: 100 })
    expect(post.status).toBe(400)
    expect(post.body.rejectedFields).toEqual(['allocationPct'])

    expect(await readCache()).toEqual(beforeCache)
    expect(await snapshotRoleState(rt.id)).toEqual(beforeState)
  })

  it('2. rejects legacy capacity fields on named-resource routes with 400, no write, no cache clear', async () => {
    const rt = await createRuntimeResourceType('Reject NR')
    const nr = await prisma.namedResource.findFirstOrThrow({ where: { resourceTypeId: rt.id } })
    await seedDistinctCache()
    const beforeCache = await readCache()
    const beforeState = await snapshotRoleState(rt.id)

    const put = await request(app)
      .put(`/api/projects/${projectId}/resource-types/${rt.id}/named-resources/${nr.id}`)
      .set('Authorization', authHeader)
      .send({ startWeek: null })
    expect(put.status).toBe(400)
    expect(put.body.rejectedFields).toEqual(['startWeek'])

    const post = await request(app)
      .post(`/api/projects/${projectId}/resource-types/${rt.id}/named-resources`)
      .set('Authorization', authHeader)
      .send({ name: 'New person', allocationPct: 80 })
    expect(post.status).toBe(400)
    expect(post.body.rejectedFields).toEqual(['allocationPct'])

    expect(await readCache()).toEqual(beforeCache)
    expect(await snapshotRoleState(rt.id)).toEqual(beforeState)
  })

  it('3. named-resource PATCH is rejection-only — structured 400, no write or cache clear', async () => {
    const rt = await createRuntimeResourceType('No Patch')
    const nr = await prisma.namedResource.findFirstOrThrow({ where: { resourceTypeId: rt.id } })
    await seedDistinctCache()
    const before = await snapshotRoleState(rt.id)
    const beforeCache = await readCache()

    const res = await request(app)
      .patch(`/api/projects/${projectId}/resource-types/${rt.id}/named-resources/${nr.id}`)
      .set('Authorization', authHeader)
      .send({ allocationMode: 'EFFORT' })
    expect(res.status).toBe(400)
    expect(res.body.rejectedFields).toEqual(['allocationMode'])
    expect(res.body.error).toContain('capacity-profiles/:ownerKind/:ownerId')

    // Explicit null also counts as a supplied legacy field
    const nullRes = await request(app)
      .patch(`/api/projects/${projectId}/resource-types/${rt.id}/named-resources/${nr.id}`)
      .set('Authorization', authHeader)
      .send({ startWeek: null, endWeek: null })
    expect(nullRes.status).toBe(400)
    expect(nullRes.body.rejectedFields).toEqual(['startWeek', 'endWeek'])

    // No legacy field → method/contract error, no mutation path
    const noField = await request(app)
      .patch(`/api/projects/${projectId}/resource-types/${rt.id}/named-resources/${nr.id}`)
      .set('Authorization', authHeader)
      .send({ name: 'ignored' })
    expect(noField.status).toBe(405)

    expect(await readCache()).toEqual(beforeCache)
    expect(await snapshotRoleState(rt.id)).toEqual(before)
  })

  it('4. planner-owned count/add/remove return 409 with complete state unchanged', async () => {
    const rt = await createRuntimeResourceType('Planner Owned')
    const nr = await prisma.namedResource.findFirstOrThrow({ where: { resourceTypeId: rt.id } })

    // Mimic Squad Planner ownership: SQUAD_PLANNER ROLE profile with segments
    // and a planner-created PLANNED_RESOURCE profile with segments.
    const roleProfile = await prisma.capacityProfile.findFirstOrThrow({
      where: { projectId, resourceTypeId: rt.id, namedResourceId: null },
    })
    await prisma.capacityProfile.update({
      where: { id: roleProfile.id },
      data: { planningBasis: 'CAPACITY_PROFILE', source: 'SQUAD_PLANNER', defaultPercent: 60, startWeek: null, endWeek: null },
    })
    await prisma.capacitySegment.createMany({
      data: [
        { capacityProfileId: roleProfile.id, startWeek: 0, endWeek: 3, capacityPercent: 100, source: 'SQUAD_PLANNER' },
        { capacityProfileId: roleProfile.id, startWeek: 4, endWeek: 5, capacityPercent: 0, source: 'SQUAD_PLANNER' },
        { capacityProfileId: roleProfile.id, startWeek: 6, endWeek: 11, capacityPercent: 50, source: 'SQUAD_PLANNER' },
      ],
    })
    const nrProfile = await prisma.capacityProfile.findFirstOrThrow({
      where: { projectId, namedResourceId: nr.id, resourceTypeId: null },
    })
    await prisma.capacityProfile.update({
      where: { id: nrProfile.id },
      data: {
        ownerKind: 'PLANNED_RESOURCE',
        planningBasis: 'CAPACITY_PROFILE',
        source: 'SQUAD_PLANNER',
        defaultPercent: 40,
        startWeek: null,
        endWeek: null,
      },
    })
    await prisma.capacitySegment.createMany({
      data: [
        { capacityProfileId: nrProfile.id, startWeek: 0, endWeek: 1, capacityPercent: 100, source: 'SQUAD_PLANNER' },
        { capacityProfileId: nrProfile.id, startWeek: 2, endWeek: 3, capacityPercent: 0, source: 'SQUAD_PLANNER' },
        { capacityProfileId: nrProfile.id, startWeek: 4, endWeek: 7, capacityPercent: 40, source: 'SQUAD_PLANNER' },
      ],
    })
    // Planner ownership is expressed exclusively through the SQUAD_PLANNER
    // profiles above (issue #418); the legacy columns no longer exist.
    await seedDistinctCache()
    const before = await snapshotRoleState(rt.id)

    // Count increase (PATCH) → 409
    const countRes = await request(app)
      .patch(`/api/projects/${projectId}/resource-types/${rt.id}`)
      .set('Authorization', authHeader)
      .send({ count: 3 })
    expect(countRes.status).toBe(409)
    expect(countRes.body.code).toBe('PLANNER_MANAGED_IDENTITY')
    expect(countRes.body.error).toContain('Switch to manual capacity')

    // Add (POST named-resource) → 409
    const addRes = await request(app)
      .post(`/api/projects/${projectId}/resource-types/${rt.id}/named-resources`)
      .set('Authorization', authHeader)
      .send({ name: 'Intruder' })
    expect(addRes.status).toBe(409)
    expect(addRes.body.code).toBe('PLANNER_MANAGED_IDENTITY')

    // Remove (DELETE named-resource) → 409
    const removeRes = await request(app)
      .delete(`/api/projects/${projectId}/resource-types/${rt.id}/named-resources/${nr.id}`)
      .set('Authorization', authHeader)
    expect(removeRes.status).toBe(409)
    expect(removeRes.body.code).toBe('PLANNER_MANAGED_IDENTITY')

    // Count PUT with count on planner-owned role → 409
    const putCount = await request(app)
      .put(`/api/projects/${projectId}/resource-types/${rt.id}`)
      .set('Authorization', authHeader)
      .send({ count: 5 })
    expect(putCount.status).toBe(409)
    expect(putCount.body.code).toBe('PLANNER_MANAGED_IDENTITY')

    // Complete state (profiles, segments, resources, count, cache) unchanged
    expect(await snapshotRoleState(rt.id)).toEqual(before)
  })

  it('5. manual scalar ROLE profile survives count increase, add, and removal unchanged', async () => {
    const rt = await createRuntimeResourceType('Manual Scalar')
    const roleProfile = await prisma.capacityProfile.findFirstOrThrow({
      where: { projectId, resourceTypeId: rt.id, namedResourceId: null },
    })
    await prisma.capacityProfile.update({
      where: { id: roleProfile.id },
      data: {
        planningBasis: 'AVAILABILITY_WINDOW',
        source: 'AVAILABILITY_WINDOW',
        defaultPercent: 75,
        startWeek: 4,
        endWeek: 12,
      },
    })
    await seedDistinctCache()
    const beforeRole = await prisma.capacityProfile.findUniqueOrThrow({
      where: { id: roleProfile.id },
      include: { segments: true },
    })
    const originalNr = await prisma.namedResource.findFirstOrThrow({ where: { resourceTypeId: rt.id } })

    // Count increase → new NR inherits role profile
    const increase = await request(app)
      .patch(`/api/projects/${projectId}/resource-types/${rt.id}`)
      .set('Authorization', authHeader)
      .send({ count: 2 })
    expect(increase.status).toBe(200)

    const nrsAfterIncrease = await prisma.namedResource.findMany({ where: { resourceTypeId: rt.id } })
    expect(nrsAfterIncrease).toHaveLength(2)
    // The system-created clone inherits the ROLE profile; the pre-existing
    // default NR keeps its own profile untouched.
    const clonedNr = nrsAfterIncrease.find(nr => nr.id !== originalNr.id)!
    const clonedProfile = await prisma.capacityProfile.findFirstOrThrow({
      where: { projectId, namedResourceId: clonedNr.id, resourceTypeId: null },
    })
    expect(clonedProfile).toMatchObject({
      planningBasis: 'AVAILABILITY_WINDOW',
      source: 'DERIVED',
      defaultPercent: 75,
      startWeek: 4,
      endWeek: 12,
      provenance: 'ROLE_DEFAULT',
    })
    expect(await prisma.capacityProfile.findUniqueOrThrow({ where: { id: roleProfile.id }, include: { segments: true } }))
      .toEqual(beforeRole)

    // Add via POST → new NR inherits role profile, count synced
    const added = await request(app)
      .post(`/api/projects/${projectId}/resource-types/${rt.id}/named-resources`)
      .set('Authorization', authHeader)
      .send({ name: 'Scalar Person' })
    expect(added.status).toBe(201)
    const addedProfile = await prisma.capacityProfile.findFirstOrThrow({
      where: { projectId, namedResourceId: added.body.id, resourceTypeId: null },
    })
    expect(addedProfile).toMatchObject({
      ownerKind: 'NAMED_PERSON',
      planningBasis: 'AVAILABILITY_WINDOW',
      source: 'DERIVED',
      defaultPercent: 75,
      startWeek: 4,
      endWeek: 12,
      provenance: 'ROLE_DEFAULT',
    })
    const rtAfterAdd = await prisma.resourceType.findUniqueOrThrow({ where: { id: rt.id } })
    expect(rtAfterAdd.count).toBe(3)
    expect(await prisma.capacityProfile.findUniqueOrThrow({ where: { id: roleProfile.id }, include: { segments: true } }))
      .toEqual(beforeRole)

    // Remove one via DELETE → role profile unchanged, ownership complete
    const remove = await request(app)
      .delete(`/api/projects/${projectId}/resource-types/${rt.id}/named-resources/${added.body.id}`)
      .set('Authorization', authHeader)
    expect(remove.status).toBe(204)
    expect(await prisma.namedResource.count({ where: { resourceTypeId: rt.id } })).toBe(2)
    expect(await prisma.capacityProfile.count({ where: { namedResourceId: added.body.id } })).toBe(0)
    expect(await prisma.capacityProfile.findUniqueOrThrow({ where: { id: roleProfile.id }, include: { segments: true } }))
      .toEqual(beforeRole)
    expect(await everyOwnerHasExactlyOneProfile(rt.id)).toBeNull()
  })

  it('6. manual segmented ROLE profile survives count increase and reduction with segments intact', async () => {
    const rt = await createRuntimeResourceType('Manual Segmented')
    const roleProfile = await prisma.capacityProfile.findFirstOrThrow({
      where: { projectId, resourceTypeId: rt.id, namedResourceId: null },
    })
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
        { capacityProfileId: roleProfile.id, startWeek: 3, endWeek: 5, capacityPercent: 50, source: 'MANUAL' },
        { capacityProfileId: roleProfile.id, startWeek: 6, endWeek: 9, capacityPercent: 0, source: 'MANUAL' },
      ],
    })
    await seedDistinctCache()
    const beforeRole = await prisma.capacityProfile.findUniqueOrThrow({
      where: { id: roleProfile.id },
      include: { segments: { orderBy: [{ startWeek: 'asc' }, { id: 'asc' }] } },
    })

    // Count increase → new NRs clone the segmented role profile
    const increase = await request(app)
      .patch(`/api/projects/${projectId}/resource-types/${rt.id}`)
      .set('Authorization', authHeader)
      .send({ count: 2 })
    expect(increase.status).toBe(200)

    const nrs = await prisma.namedResource.findMany({ where: { resourceTypeId: rt.id }, orderBy: { id: 'asc' } })
    expect(nrs).toHaveLength(2)
    const cloned = await prisma.capacityProfile.findFirstOrThrow({
      where: { projectId, namedResourceId: nrs[1].id, resourceTypeId: null },
      include: { segments: { orderBy: [{ startWeek: 'asc' }, { id: 'asc' }] } },
    })
    expect(cloned).toMatchObject({
      ownerKind: 'NAMED_PERSON',
      planningBasis: 'CAPACITY_PROFILE',
      source: 'DERIVED',
      defaultPercent: 60,
      startWeek: null,
      endWeek: null,
      provenance: 'ROLE_DEFAULT',
    })
    expect(cloned.segments.map(s => [s.startWeek, s.endWeek, s.capacityPercent, s.source])).toEqual([
      [0, 2, 100, 'MANUAL'],
      [3, 5, 50, 'MANUAL'],
      [6, 9, 0, 'MANUAL'],
    ])
    // The ROLE profile itself is byte-for-byte unchanged
    expect(await prisma.capacityProfile.findUniqueOrThrow({
      where: { id: roleProfile.id },
      include: { segments: { orderBy: [{ startWeek: 'asc' }, { id: 'asc' }] } },
    })).toEqual(beforeRole)

    // Count reduction back to 1 — the generated segmented clone carries the
    // ROLE_DEFAULT provenance marker, so the classifier treats it as inherited
    // and removes it (profile and segments), completing the 1 → 2 → 1 round
    // trip. The ROLE profile stays byte-for-byte identical.
    const reduction = await request(app)
      .patch(`/api/projects/${projectId}/resource-types/${rt.id}`)
      .set('Authorization', authHeader)
      .send({ count: 1 })
    expect(reduction.status).toBe(200)
    expect(await prisma.namedResource.count({ where: { resourceTypeId: rt.id } })).toBe(1)
    expect(await prisma.capacityProfile.count({ where: { namedResourceId: nrs[1].id } })).toBe(0)
    expect(await prisma.capacitySegment.count({ where: { capacityProfileId: cloned.id } })).toBe(0)
    // ROLE profile ID, fields and segment IDs/order/content are unchanged
    expect(await prisma.capacityProfile.findUniqueOrThrow({
      where: { id: roleProfile.id },
      include: { segments: { orderBy: [{ startWeek: 'asc' }, { id: 'asc' }] } },
    })).toEqual(beforeRole)
    expect(await everyOwnerHasExactlyOneProfile(rt.id)).toBeNull()
  })

  it('6b. a user-edited segmented named-resource profile stays protected from count reduction', async () => {
    const rt = await createRuntimeResourceType('Edited Segmented NR')
    const originalNr = await prisma.namedResource.findFirstOrThrow({ where: { resourceTypeId: rt.id } })
    const nrProfile = await prisma.capacityProfile.findFirstOrThrow({
      where: { projectId, namedResourceId: originalNr.id, resourceTypeId: null },
    })
    // Simulate a genuine user edit through the first-class endpoint: source
    // flips to MANUAL and the profile carries explicit segments.
    await prisma.capacityProfile.update({
      where: { id: nrProfile.id },
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
        { capacityProfileId: nrProfile.id, startWeek: 0, endWeek: 2, capacityPercent: 80, source: 'MANUAL' },
        { capacityProfileId: nrProfile.id, startWeek: 3, endWeek: 5, capacityPercent: 0, source: 'MANUAL' },
      ],
    })
    await seedDistinctCache()
    const before = await snapshotRoleState(rt.id)

    // Reduce count to 0 — the user-edited segmented profile must survive
    const reduction = await request(app)
      .patch(`/api/projects/${projectId}/resource-types/${rt.id}`)
      .set('Authorization', authHeader)
      .send({ count: 0 })
    expect(reduction.status).toBe(200)
    expect(reduction.body.warnings?.[0] ?? '').toContain('custom or protected capacity settings')
    expect(await prisma.namedResource.count({ where: { resourceTypeId: rt.id } })).toBe(1)
    expect(await prisma.capacityProfile.count({ where: { namedResourceId: originalNr.id } })).toBe(1)
    // Every persisted entity is unchanged (the reduction attempt clears the
    // weekly-demand cache by design, so exclude it from the comparison)
    const after = await snapshotRoleState(rt.id)
    const { weeklyDemandCache: _beforeCache, ...beforeRest } = before
    const { weeklyDemandCache: _afterCache, ...afterRest } = after
    expect(afterRest).toEqual(beforeRest)
  })

  it('6c. aggregate scalar ROLE capacity above 100 blocks count increase and NamedResource POST unchanged', async () => {
    const rt = await createRuntimeResourceType('Aggregate Scalar')
    const roleProfile = await prisma.capacityProfile.findFirstOrThrow({
      where: { projectId, resourceTypeId: rt.id, namedResourceId: null },
    })
    await prisma.capacityProfile.update({
      where: { id: roleProfile.id },
      data: {
        planningBasis: 'DEMAND_FOLLOWING',
        source: 'FIXED',
        defaultPercent: 150,
        startWeek: null,
        endWeek: null,
      },
    })
    await seedDistinctCache()
    const before = await snapshotRoleState(rt.id)

    // Count increase → 400 before any write
    const increase = await request(app)
      .patch(`/api/projects/${projectId}/resource-types/${rt.id}`)
      .set('Authorization', authHeader)
      .send({ count: 2 })
    expect(increase.status).toBe(400)
    expect(increase.body.code).toBe('AGGREGATE_ROLE_CAPACITY')
    expect(increase.body.error).toContain('150')

    // NamedResource POST → 400 before any write
    const post = await request(app)
      .post(`/api/projects/${projectId}/resource-types/${rt.id}/named-resources`)
      .set('Authorization', authHeader)
      .send({ name: 'Nobody' })
    expect(post.status).toBe(400)
    expect(post.body.code).toBe('AGGREGATE_ROLE_CAPACITY')

    // Complete state and cache unchanged
    expect(await snapshotRoleState(rt.id)).toEqual(before)
  })

  it('6d. aggregate segmented ROLE capacity above 100 blocks count increase unchanged', async () => {
    const rt = await createRuntimeResourceType('Aggregate Segmented')
    const roleProfile = await prisma.capacityProfile.findFirstOrThrow({
      where: { projectId, resourceTypeId: rt.id, namedResourceId: null },
    })
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
        { capacityProfileId: roleProfile.id, startWeek: 3, endWeek: 5, capacityPercent: 120, source: 'MANUAL' },
      ],
    })
    await seedDistinctCache()
    const before = await snapshotRoleState(rt.id)

    const increase = await request(app)
      .patch(`/api/projects/${projectId}/resource-types/${rt.id}`)
      .set('Authorization', authHeader)
      .send({ count: 2 })
    expect(increase.status).toBe(400)
    expect(increase.body.code).toBe('AGGREGATE_ROLE_CAPACITY')
    expect(increase.body.error).toContain('W3-W5')

    expect(await snapshotRoleState(rt.id)).toEqual(before)
  })

  it('7. explicit NamedResource profiles are not flattened or overwritten by count operations', async () => {
    const rt = await createRuntimeResourceType('Explicit NR')
    const originalNr = await prisma.namedResource.findFirstOrThrow({ where: { resourceTypeId: rt.id } })
    const roleProfile = await prisma.capacityProfile.findFirstOrThrow({
      where: { projectId, resourceTypeId: rt.id, namedResourceId: null },
    })
    // Role: DEMAND_FOLLOWING/100; explicit NR: WHOLE_PROJECT_ALLOCATION/35 (differs → explicit)
    await prisma.capacityProfile.update({
      where: { id: roleProfile.id },
      data: { planningBasis: 'DEMAND_FOLLOWING', source: 'FIXED', defaultPercent: 100, startWeek: null, endWeek: null },
    })
    const nrProfile = await prisma.capacityProfile.findFirstOrThrow({
      where: { projectId, namedResourceId: originalNr.id, resourceTypeId: null },
    })
    await prisma.capacityProfile.update({
      where: { id: nrProfile.id },
      data: {
        planningBasis: 'WHOLE_PROJECT_ALLOCATION',
        source: 'MANUAL',
        defaultPercent: 35,
        startWeek: null,
        endWeek: null,
      },
    })
    const beforeExplicit = await prisma.capacityProfile.findUniqueOrThrow({
      where: { id: nrProfile.id },
      include: { segments: true },
    })

    // Count increase → new inherited NR; explicit profile untouched
    const increase = await request(app)
      .patch(`/api/projects/${projectId}/resource-types/${rt.id}`)
      .set('Authorization', authHeader)
      .send({ count: 2 })
    expect(increase.status).toBe(200)
    expect(await prisma.capacityProfile.findUniqueOrThrow({ where: { id: nrProfile.id }, include: { segments: true } }))
      .toEqual(beforeExplicit)

    // Count reduction → explicit NR survives (warning), inherited removed
    const reduction = await request(app)
      .patch(`/api/projects/${projectId}/resource-types/${rt.id}`)
      .set('Authorization', authHeader)
      .send({ count: 1 })
    expect(reduction.status).toBe(200)
    expect(await prisma.namedResource.findUnique({ where: { id: originalNr.id } })).not.toBeNull()
    expect(await prisma.capacityProfile.findUniqueOrThrow({ where: { id: nrProfile.id }, include: { segments: true } }))
      .toEqual(beforeExplicit)
    expect(await prisma.namedResource.count({ where: { resourceTypeId: rt.id } })).toBe(1)
    expect(await everyOwnerHasExactlyOneProfile(rt.id)).toBeNull()
  })

  it('8. injected transaction failure rolls back the complete count/profile change', async () => {
    const rt = await createRuntimeResourceType('Rollback RT')
    await seedDistinctCache()
    const before = await snapshotRoleState(rt.id)

    __setRTPatchFailureSeam(() => {
      throw new Error('injected failure')
    })
    try {
      const res = await request(app)
        .patch(`/api/projects/${projectId}/resource-types/${rt.id}`)
        .set('Authorization', authHeader)
        .send({ count: 3 })
      expect(res.status).toBe(500)
    } finally {
      __setRTPatchFailureSeam(null)
    }

    // No partial mutation: NRs, profiles, segments, count and cache unchanged
    expect(await snapshotRoleState(rt.id)).toEqual(before)
    expect(await everyOwnerHasExactlyOneProfile(rt.id)).toBeNull()
  })

  it('9. supported non-capacity operations keep working', async () => {
    const rt = await createRuntimeResourceType('Non Capacity')
    const nr = await prisma.namedResource.findFirstOrThrow({ where: { resourceTypeId: rt.id } })

    // RT metadata PUT
    const rtPut = await request(app)
      .put(`/api/projects/${projectId}/resource-types/${rt.id}`)
      .set('Authorization', authHeader)
      .send({ name: 'Renamed Role', hoursPerDay: 7.5, dayRate: 950 })
    expect(rtPut.status).toBe(200)
    expect(rtPut.body.name).toBe('Renamed Role')
    expect(rtPut.body.hoursPerDay).toBe(7.5)
    expect(rtPut.body.dayRate).toBe(950)

    // NR name + pricingModel PUT
    const nrPut = await request(app)
      .put(`/api/projects/${projectId}/resource-types/${rt.id}/named-resources/${nr.id}`)
      .set('Authorization', authHeader)
      .send({ name: 'Alice', pricingModel: 'PRO_RATA' })
    expect(nrPut.status).toBe(200)
    expect(nrPut.body.name).toBe('Alice')
    expect(nrPut.body.pricingModel).toBe('PRO_RATA')

    // NR profile preserved through non-capacity updates
    const nrProfile = await prisma.capacityProfile.findFirstOrThrow({
      where: { projectId, namedResourceId: nr.id, resourceTypeId: null },
    })
    expect(nrProfile.planningBasis).toBe('DEMAND_FOLLOWING')
    expect(nrProfile.defaultPercent).toBe(100)
    expect(await everyOwnerHasExactlyOneProfile(rt.id)).toBeNull()
  })

  it('10. first-class capacity-profile endpoint remains the working capacity mutation contract', async () => {
    const rt = await createRuntimeResourceType('First Class')
    const nr = await prisma.namedResource.findFirstOrThrow({ where: { resourceTypeId: rt.id } })

    const res = await request(app)
      .put(`/api/projects/${projectId}/capacity-profiles/NAMED_PERSON/${nr.id}`)
      .set('Authorization', authHeader)
      .send({
        planningBasis: 'AVAILABILITY_WINDOW',
        defaultPercent: 80,
        startWeek: 2,
        endWeek: 10,
      })
    expect(res.status).toBe(200)

    const profile = await prisma.capacityProfile.findFirstOrThrow({
      where: { projectId, namedResourceId: nr.id, resourceTypeId: null },
    })
    expect(profile.planningBasis).toBe('AVAILABILITY_WINDOW')
    expect(profile.defaultPercent).toBe(80)
    expect(profile.startWeek).toBe(2)
    expect(profile.endWeek).toBe(10)
  })
})
