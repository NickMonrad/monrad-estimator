/**
 * capacityProfileReplacePostgres.integration.test.ts — Real PostgreSQL integration
 * tests for the capacity-profile PUT replace endpoint (issue #363).
 *
 * Tests that the transaction-based replace service correctly persists segments,
 * preserves profile identity, rejects conflicting/overlapping input, writes
 * backward-compatible legacy fields, maintains owner uniqueness constraints,
 * recovers cleanly from mid-transaction failures, and guards planner-owned
 * profiles from manual overwrite.
 *
 * Skipped unless INTEGRATION_TEST=true.
 *
 * Endpoint: PUT /api/projects/:projectId/capacity-profiles/:ownerKind/:ownerId
 *   ownerKind: "ROLE" | "NAMED_PERSON"
 */

// ─── Prisma pass-through: route handlers see real PostgreSQL ────────

vi.mock('../lib/prisma.js', async (importOriginal) => {
  return await importOriginal()
})


import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '@prisma/client'
import { app } from '../app.js'
import { replaceCapacityProfile } from '../lib/capacityProfileReplaceService.js'


// ─── Guard ──────────────────────────────────────────────────────────

const runIntegration = process.env.INTEGRATION_TEST === 'true'
const describeIf = runIntegration ? describe : describe.skip

// ─── Shared state ───────────────────────────────────────────────────

let prisma: PrismaClient
let userId: string
let token: string
let authHeader: string

const USER_EMAIL = 'capacity-replace-363-integration@example.com'
const PROJ_NAME = 'Capacity Profile Replace #363'

let projectId: string

/** Resource type (ROLE) for tests 1, 3, 4, 5, 6, 7 */
let roleRtId: string
/** Existing profile ID for the role RT (created in beforeAll) */
let roleProfileId: string

/** Inherited named resource whose compatibility fields must roll back with ROLE edits */
let inheritedNrId: string
/** Named resource for tests 2, 5, 6, 7 */
let nrId: string
/** Existing profile ID for the named resource (created in beforeAll) */
let nrProfileId: string

/** A second resource type (for test 6 cross-owner isolation checks) */
let otherRtId: string

/** Resource type whose capacity profile has source='SQUAD_PLANNER' (test 8) */
let squadRtId: string

// ─── Helpers ────────────────────────────────────────────────────────

function canonicalize<T>(value: T): T {
  return JSON.parse(JSON.stringify(value))
}

/**
 * Snapshot the full DB state relevant to a capacity-profile replace operation
 * for a given owner (role Rt or named resource).
 */
async function snapshotDbState(): Promise<{
  profiles: Array<Record<string, unknown>>
  segments: Array<Record<string, unknown>>
  rt: Record<string, unknown> | null
  cache: unknown
}> {
  const profiles = canonicalize(
    await prisma.capacityProfile.findMany({
      where: { projectId },
      orderBy: { createdAt: 'asc' },
    }) ?? [],
  )
  const allProfileIds = profiles.map((p: any) => p.id)
  const segments = allProfileIds.length > 0
    ? canonicalize(
        await prisma.capacitySegment.findMany({
          where: { capacityProfileId: { in: allProfileIds } },
          orderBy: [{ startWeek: 'asc' }, { endWeek: 'asc' }, { capacityPercent: 'asc' }],
        }) ?? [],
      )
    : []

  const cacheRow = await prisma.project.findFirst({
    where: { id: projectId },
    select: { weeklyDemandCache: true },
  })

  return { profiles, segments, rt: null, cache: cacheRow?.weeklyDemandCache ?? null }
}

/**
 * Snapshot state for a specific resource type (role-owner profile).
 */
async function snapshotRoleState(rtId: string): Promise<{
  profiles: Array<Record<string, unknown>>
  segments: Array<Record<string, unknown>>
  rt: Record<string, unknown> | null
  cache: unknown
}> {
  const profiles = canonicalize(
    await prisma.capacityProfile.findMany({
      where: { projectId, resourceTypeId: rtId },
      orderBy: { createdAt: 'asc' },
    }) ?? [],
  )
  const allProfileIds = profiles.map((p: any) => p.id)
  const segments = allProfileIds.length > 0
    ? canonicalize(
        await prisma.capacitySegment.findMany({
          where: { capacityProfileId: { in: allProfileIds } },
          orderBy: [{ startWeek: 'asc' }, { endWeek: 'asc' }, { capacityPercent: 'asc' }],
        }) ?? [],
      )
    : []

  const rt = canonicalize(
    await prisma.resourceType.findFirst({
      where: { id: rtId },
      select: {
        id: true,
        allocationMode: true,
        allocationPercent: true,
        allocationStartWeek: true,
        allocationEndWeek: true,
      },
    }),
  )

  const cacheRow = await prisma.project.findFirst({
    where: { id: projectId },
    select: { weeklyDemandCache: true },
  })

  return { profiles, segments, rt, cache: cacheRow?.weeklyDemandCache ?? null }
}


// ─── Lifecycle ──────────────────────────────────────────────────────

beforeAll(async () => {
  if (!runIntegration) return
  prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
  })
  await prisma.$connect()

  // User
  const user = await prisma.user.upsert({
    where: { email: USER_EMAIL },
    create: { email: USER_EMAIL, name: 'CP Replace Integration', password: '$2b$10$placeholder' },
    update: {},
  })
  userId = user.id
  token = jwt.sign({ userId, role: 'USER' }, process.env.JWT_SECRET!)
  authHeader = `Bearer ${token}`

  // Project
  const project = await prisma.project.create({
    data: { name: PROJ_NAME, hoursPerDay: 8, ownerId: userId },
  })
  projectId = project.id

  // ── Fixture 1: Role resource type with initial AVAILABILITY_WINDOW profile ──
  const roleRt = await prisma.resourceType.create({
    data: {
      name: 'ReplaceRole',
      category: 'ENGINEERING',
      count: 2,
      hoursPerDay: 8,
      allocationMode: 'EFFORT',
      allocationPercent: 100,
      allocationStartWeek: 0,
      allocationEndWeek: 4,
      projectId,
    },
  })
  roleRtId = roleRt.id

  // Create initial role profile (AVAILABILITY_WINDOW)
  const roleProfile = await prisma.capacityProfile.create({
    data: {
      projectId,
      resourceTypeId: roleRt.id,
      namedResourceId: null,
      ownerKind: 'ROLE',
      planningBasis: 'AVAILABILITY_WINDOW',
      source: 'MANUAL',
      defaultPercent: 75,
      startWeek: 0,
      endWeek: 6,
    },
  })
  roleProfileId = roleProfile.id

  // One segment on the role profile
  await prisma.capacitySegment.create({
    data: {
      capacityProfileId: roleProfile.id,
      startWeek: 0,
      endWeek: 6,
      capacityPercent: 75,
      source: 'MANUAL',
    },
  })
  const inheritedNr = await prisma.namedResource.create({
    data: {
      resourceTypeId: roleRt.id,
      name: 'InheritedRoleDefault',
      allocationPct: 100,
      allocationPercent: 100,
      allocationMode: 'EFFORT',
      allocationStartWeek: 0,
      allocationEndWeek: 4,
      startWeek: 0,
      endWeek: 4,
    },
  })
  inheritedNrId = inheritedNr.id

  // ── Fixture 2: Named resource with initial profile ────────────────
  const nrRt = await prisma.resourceType.create({
    data: {
      name: 'ReplaceNRRole',
      category: 'ENGINEERING',
      count: 1,
      hoursPerDay: 8,
      allocationMode: 'TIMELINE',
      allocationPercent: 100,
      projectId,
    },
  })
  const nr = await prisma.namedResource.create({
    data: {
      resourceTypeId: nrRt.id,
      name: 'ReplaceableNR',
      allocationPct: 100,
      allocationPercent: 100,
      allocationMode: 'TIMELINE',
      allocationStartWeek: 0,
      allocationEndWeek: 4,
      startWeek: 0,
      endWeek: 4,
    },
  })
  nrId = nr.id

  const nrProfile = await prisma.capacityProfile.create({
    data: {
      projectId,
      resourceTypeId: null,
      namedResourceId: nr.id,
      ownerKind: 'NAMED_PERSON',
      planningBasis: 'AVAILABILITY_WINDOW',
      source: 'MANUAL',
      defaultPercent: 80,
      startWeek: 0,
      endWeek: 4,
    },
  })
  nrProfileId = nrProfile.id

  // One segment on the NR profile
  await prisma.capacitySegment.create({
    data: {
      capacityProfileId: nrProfile.id,
      startWeek: 0,
      endWeek: 4,
      capacityPercent: 80,
      source: 'MANUAL',
    },
  })

  // ── Fixture 3: Second resource type (for cross-owner isolation checks) ──
  const otherRt = await prisma.resourceType.create({
    data: {
      name: 'OtherRole',
      category: 'ENGINEERING',
      count: 1,
      hoursPerDay: 8,
      allocationMode: 'EFFORT',
      allocationPercent: 100,
      projectId,
    },
  })
  otherRtId = otherRt.id

  // ── Fixture 4: Squad Planner-owned resource type (test 8) ─────────
  const squadRt = await prisma.resourceType.create({
    data: {
      name: 'SquadPlannerProtected',
      category: 'ENGINEERING',
      count: 3,
      hoursPerDay: 8,
      allocationMode: 'EFFORT',
      projectId,
    },
  })
  squadRtId = squadRt.id
  // Create profile with SQUAD_PLANNER source
  await prisma.capacityProfile.create({
    data: {
      projectId,
      resourceTypeId: squadRt.id,
      namedResourceId: null,
      ownerKind: 'ROLE',
      planningBasis: 'CAPACITY_PROFILE',
      source: 'SQUAD_PLANNER',
      defaultPercent: 150,
    },
  })

  // Seed a deterministic weeklyDemandCache so test 7 can prove it
  // was cleared on success or preserved on failure.
  await prisma.project.update({
    where: { id: projectId },
    data: { weeklyDemandCache: { 'seed-before-tests': 42 } },
  })
})

afterAll(async () => {
  if (!runIntegration) return
  // Delete in dependency order
  await prisma.capacitySegment.deleteMany({
    where: { capacityProfile: { projectId } },
  })
  await prisma.capacityProfile.deleteMany({ where: { projectId } })
  await prisma.namedResource.deleteMany({
    where: { resourceType: { projectId } },
  })
  await prisma.resourceType.deleteMany({ where: { projectId } })
  await prisma.project.delete({ where: { id: projectId } })
  await prisma.user.delete({ where: { id: userId } })
  await prisma.$disconnect()
})

// ═════════════════════════════════════════════════════════════════════
// Tests
// ═════════════════════════════════════════════════════════════════════

describeIf('Capacity profile replace (real PostgreSQL)', () => {
  // ── Test 1: Replace role profile with multiple segments ─────────

  it('1. Replaces a role profile with multiple segments while preserving profile ID', async () => {
    const body = {
      planningBasis: 'CAPACITY_PROFILE',
      segments: [
        { startWeek: 0, endWeek: 3, capacityPercent: 100 },
        { startWeek: 5, endWeek: 8, capacityPercent: 50 },
      ],
    }

    const res = await request(app)
      .put(`/api/projects/${projectId}/capacity-profiles/ROLE/${roleRtId}`)
      .set('Authorization', authHeader)
      .send(body)

    expect(res.status).toBe(200)
    expect(res.body.capacityProfile).toBeDefined()

    const profile = res.body.capacityProfile
    // Profile ID must be preserved from the original fixture
    expect(profile.id).toBe(roleProfileId)
    expect(profile.planningBasis).toBe('capacityProfile')
    expect(profile.source).toBe('manual')
    expect(profile.owner.kind).toBe('role')
    expect(profile.owner.id).toBe(roleRtId)

    // Segments must match the request in sorted order
    expect(profile.segments).toHaveLength(2)
    expect(profile.segments[0]).toMatchObject({
      startWeek: 0,
      endWeek: 3,
      capacityPercent: 100,
      source: 'manual',
    })
    expect(profile.segments[1]).toMatchObject({
      startWeek: 5,
      endWeek: 8,
      capacityPercent: 50,
      source: 'manual',
    })
    // Both segments must have real UUIDs
    expect(profile.segments[0].id).toBeDefined()
    expect(profile.segments[1].id).toBeDefined()

    // Verify profile was NOT duplicated (only 1 profile for this owner)
    const dbProfiles = await prisma.capacityProfile.findMany({
      where: { projectId, resourceTypeId: roleRtId },
    })
    expect(dbProfiles).toHaveLength(1)
    expect(dbProfiles[0].id).toBe(roleProfileId)
    expect(dbProfiles[0].planningBasis).toBe('CAPACITY_PROFILE')
    expect(dbProfiles[0].source).toBe('MANUAL')

    // Verify segments in DB
    const dbSegments = await prisma.capacitySegment.findMany({
      where: { capacityProfileId: roleProfileId },
      orderBy: [{ startWeek: 'asc' }, { endWeek: 'asc' }],
    })
    expect(dbSegments).toHaveLength(2)
    expect(dbSegments[0].startWeek).toBe(0)
    expect(dbSegments[0].endWeek).toBe(3)
    expect(dbSegments[0].capacityPercent).toBe(100)
    expect(dbSegments[1].startWeek).toBe(5)
    expect(dbSegments[1].endWeek).toBe(8)
    expect(dbSegments[1].capacityPercent).toBe(50)

    // Legacy projection: duration-weighted average = (4*100 + 4*50)/8 = 75
    expect(dbProfiles[0].defaultPercent).toBeNull()  // no defaultPercent sent
    expect(profile.defaultPercent).toBeNull()
  })

  // ── Test 2: Replace named-person profile with multiple segments ─

  it('2. Replaces a named-person profile with multiple segments', async () => {
    const body = {
      planningBasis: 'CAPACITY_PROFILE',
      segments: [
        { startWeek: 1, endWeek: 2, capacityPercent: 50 },
        { startWeek: 3, endWeek: 6, capacityPercent: 100 },
      ],
    }

    const res = await request(app)
      .put(`/api/projects/${projectId}/capacity-profiles/NAMED_PERSON/${nrId}`)
      .set('Authorization', authHeader)
      .send(body)

    expect(res.status).toBe(200)
    expect(res.body.capacityProfile).toBeDefined()

    const profile = res.body.capacityProfile
    expect(profile.id).toBe(nrProfileId)
    expect(profile.planningBasis).toBe('capacityProfile')
    expect(profile.source).toBe('manual')
    expect(profile.owner.kind).toBe('namedPerson')
    expect(profile.owner.id).toBe(nrId)

    // Segments must match sorted order
    expect(profile.segments).toHaveLength(2)
    expect(profile.segments[0]).toMatchObject({
      startWeek: 1,
      endWeek: 2,
      capacityPercent: 50,
      source: 'manual',
    })
    expect(profile.segments[1]).toMatchObject({
      startWeek: 3,
      endWeek: 6,
      capacityPercent: 100,
      source: 'manual',
    })

    // Verify DB state
    const dbProfiles = await prisma.capacityProfile.findMany({
      where: { projectId, namedResourceId: nrId },
    })
    expect(dbProfiles).toHaveLength(1)
    expect(dbProfiles[0].id).toBe(nrProfileId)

    const dbSegments = await prisma.capacitySegment.findMany({
      where: { capacityProfileId: nrProfileId },
      orderBy: [{ startWeek: 'asc' }, { endWeek: 'asc' }],
    })
    expect(dbSegments).toHaveLength(2)
    expect(dbSegments[0].startWeek).toBe(1)
    expect(dbSegments[0].endWeek).toBe(2)
    expect(dbSegments[0].capacityPercent).toBe(50)
    expect(dbSegments[1].startWeek).toBe(3)
    expect(dbSegments[1].endWeek).toBe(6)
    expect(dbSegments[1].capacityPercent).toBe(100)
  })

  // ── Test 3: Zero-capacity gap survives write, read and scheduler ─

  it('3. Zero-capacity gap survives write, read and scheduler resolution', async () => {
    // Replace role profile with segmented profile that has zero-capacity gap
    const body = {
      planningBasis: 'CAPACITY_PROFILE',
      segments: [
        { startWeek: 0, endWeek: 2, capacityPercent: 100 },
        { startWeek: 5, endWeek: 7, capacityPercent: 50 },
      ],
    }

    const res = await request(app)
      .put(`/api/projects/${projectId}/capacity-profiles/ROLE/${roleRtId}`)
      .set('Authorization', authHeader)
      .send(body)

    expect(res.status).toBe(200)
    expect(res.body.capacityProfile.segments).toHaveLength(2)

    // Verify the gap (weeks 3-4 are zero) via direct DB read
    const dbSegments = await prisma.capacitySegment.findMany({
      where: { capacityProfile: { projectId, resourceTypeId: roleRtId } },
      orderBy: [{ startWeek: 'asc' }, { endWeek: 'asc' }],
    })
    expect(dbSegments).toHaveLength(2)
    // Segments preserve the gap: no synthetic filler segments
    expect(dbSegments[0].startWeek).toBe(0)
    expect(dbSegments[0].endWeek).toBe(2)
    expect(dbSegments[0].capacityPercent).toBe(100)
    expect(dbSegments[1].startWeek).toBe(5)
    expect(dbSegments[1].endWeek).toBe(7)
    expect(dbSegments[1].capacityPercent).toBe(50)
    // Verify scheduler resolution respects the gap
    const { resolveSchedulerCapacity } = await import('../lib/schedulerCapacityResolver.js')
    const { getWeeklyCapacity } = await import('../lib/scheduler.js')

    const resolved = await resolveSchedulerCapacity(prisma, projectId, 8)
    const rt = resolved.resourceTypes.find(r => r.id === roleRtId)!
    expect(rt).toBeDefined()

    // roleSegments-based capacity: (allocationPercent/100) × hoursPerDay × 5
    // Segment 1: 100% × 8h × 5d = 40h (aggregate role segment, not per-person)
    expect(getWeeklyCapacity(rt, 1, 8)).toBe(40)
    // Gap: 0h/week
    expect(getWeeklyCapacity(rt, 3, 8)).toBe(0)
    expect(getWeeklyCapacity(rt, 4, 8)).toBe(0)
    // Segment 2: 50% × 8h × 5d = 20h
    expect(getWeeklyCapacity(rt, 6, 8)).toBe(20)
  })

  // ── Test 4: Overlapping segments rejected with no DB changes ───

  it('4. Overlapping segments request is rejected with no database changes', async () => {
    // Read state before the request
    const before = await snapshotRoleState(roleRtId)

    const body = {
      planningBasis: 'CAPACITY_PROFILE',
      segments: [
        { startWeek: 0, endWeek: 4, capacityPercent: 100 },
        { startWeek: 3, endWeek: 7, capacityPercent: 50 }, // overlaps with first segment
      ],
    }

    const res = await request(app)
      .put(`/api/projects/${projectId}/capacity-profiles/ROLE/${roleRtId}`)
      .set('Authorization', authHeader)
      .send(body)

    // Validator rejects overlapping segments → 400
    expect(res.status).toBe(400)

    // Read state after the rejection
    const after = await snapshotRoleState(roleRtId)
    // Profiles and segments must be identical
    expect(after.profiles).toEqual(before.profiles)
    expect(after.segments).toEqual(before.segments)
    expect(after.rt).toEqual(before.rt)
    // Cache must also be preserved (no write occurred)
    expect(after.cache).toEqual(before.cache)
  })

  // ── Test 5: Compatibility fields match projection ──────────────

  it('5. Compatibility fields match projection (legacy fields)', async () => {
    // Replace the role profile with segments and assert legacy projection
    const body = {
      planningBasis: 'CAPACITY_PROFILE',
      segments: [
        { startWeek: 0, endWeek: 5, capacityPercent: 80 },
        { startWeek: 6, endWeek: 9, capacityPercent: 40 },
      ],
    }

    const res = await request(app)
      .put(`/api/projects/${projectId}/capacity-profiles/ROLE/${roleRtId}`)
      .set('Authorization', authHeader)
      .send(body)

    expect(res.status).toBe(200)

    // The DTO legacy field is null in the persisted-authority path;
    // the actual legacy values are written to the database. Assert DB fields.

    // Verify persisted legacy fields on the resource type
    const dbRt = await prisma.resourceType.findFirst({
      where: { id: roleRtId },
    })
    expect(dbRt!.allocationMode).toBe('CAPACITY_PLAN')
    expect(dbRt!.allocationPercent).toBe(64)
    // Cap-window: start = min segment start, end = max segment end
    expect(dbRt!.allocationStartWeek).toBe(0)
    expect(dbRt!.allocationEndWeek).toBe(9)

    // Now replace a named-person profile
    const nrBody = {
      planningBasis: 'CAPACITY_PROFILE',
      segments: [
        { startWeek: 2, endWeek: 7, capacityPercent: 90 },
        { startWeek: 8, endWeek: 10, capacityPercent: 30 },
      ],
    }

    const nrRes = await request(app)
      .put(`/api/projects/${projectId}/capacity-profiles/NAMED_PERSON/${nrId}`)
      .set('Authorization', authHeader)
      .send(nrBody)

    expect(nrRes.status).toBe(200)

    // Verify persisted legacy fields on named resource
    const dbNr = await prisma.namedResource.findFirst({
      where: { id: nrId },
    })
    expect(dbNr).toBeDefined()
    expect(dbNr!.allocationMode).toBe('CAPACITY_PLAN')
    // DWA: (6*90 + 3*30)/9 = 70
    expect(dbNr!.allocationPercent).toBe(70)
    expect(dbNr!.allocationPct).toBe(70)
    expect(dbNr!.allocationStartWeek).toBe(2)
    expect(dbNr!.allocationEndWeek).toBe(10)
    expect(dbNr!.startWeek).toBe(2)
    expect(dbNr!.endWeek).toBe(10)
  })

  // ── Test 6: Owner uniqueness constraints remain satisfied ─────

  it('6. Existing owner uniqueness constraints remain satisfied', async () => {
    // After tests 1-5, each owner should have exactly one profile.
    // Verify the invariant for the role RT.
    const roleProfiles = await prisma.capacityProfile.findMany({
      where: { projectId, resourceTypeId: roleRtId },
    })
    expect(roleProfiles).toHaveLength(1)

    const nrProfiles = await prisma.capacityProfile.findMany({
      where: { projectId, namedResourceId: nrId },
    })
    expect(nrProfiles).toHaveLength(1)

    // Creating a second profile for the same owner directly via Prisma
    // should be rejected by the DB schema constraints.
    // (The service maintains this by finding existing profiles first.)
    await expect(
      prisma.capacityProfile.create({
        data: {
          projectId,
          resourceTypeId: roleRtId,
          namedResourceId: null,
          ownerKind: 'ROLE',
          planningBasis: 'AVAILABILITY_WINDOW',
          source: 'MANUAL',
          defaultPercent: 50,
          startWeek: 0,
          endWeek: 10,
        },
      }),
    ).rejects.toThrow()

    // PUT replacing the same profile must succeed (updates, not duplicates)
    const res = await request(app)
      .put(`/api/projects/${projectId}/capacity-profiles/ROLE/${roleRtId}`)
      .set('Authorization', authHeader)
      .send({
        planningBasis: 'CAPACITY_PROFILE',
        segments: [
          { startWeek: 0, endWeek: 5, capacityPercent: 100 },
        ],
      })

    expect(res.status).toBe(200)

    // Still exactly one profile
    const afterRoleProfiles = await prisma.capacityProfile.findMany({
      where: { projectId, resourceTypeId: roleRtId },
    })
    expect(afterRoleProfiles).toHaveLength(1)
    expect(afterRoleProfiles[0].id).toBe(roleProfileId)

    // PUT replacing a different owner (otherRtId) must work independently
    const otherRes = await request(app)
      .put(`/api/projects/${projectId}/capacity-profiles/ROLE/${otherRtId}`)
      .set('Authorization', authHeader)
      .send({
        planningBasis: 'CAPACITY_PROFILE',
        segments: [
          { startWeek: 1, endWeek: 3, capacityPercent: 50 },
        ],
      })

    expect(otherRes.status).toBe(200)

    // Other RT now has exactly 1 profile
    const otherProfiles = await prisma.capacityProfile.findMany({
      where: { projectId, resourceTypeId: otherRtId },
    })
    expect(otherProfiles).toHaveLength(1)

    // Original role RT still has exactly 1 profile
    const finalRoleProfiles = await prisma.capacityProfile.findMany({
      where: { projectId, resourceTypeId: roleRtId },
    })
    expect(finalRoleProfiles).toHaveLength(1)
  })

  // ── Test 7: Injected mid-transaction failure ──────────────────

  it('7. Injected mid-transaction failure: profile, segments, compatibility and cache remain unchanged', async () => {
    const beforeRole = await snapshotRoleState(roleRtId)
    const beforeInherited = canonicalize(await prisma.namedResource.findUniqueOrThrow({
      where: { id: inheritedNrId },
    }))
    const beforeAll = await snapshotDbState()

    expect(beforeRole.cache).toBeDefined()

    await expect(prisma.$transaction(async (tx) => {
      const failingTx = new Proxy(tx, {
        get(target, property, receiver) {
          if (property !== 'project') return Reflect.get(target, property, receiver)

          return new Proxy(target.project, {
            get(projectTarget, projectProperty, projectReceiver) {
              if (projectProperty === 'update') {
                return async () => {
                  throw new Error('Simulated cache invalidation failure')
                }
              }
              return Reflect.get(projectTarget, projectProperty, projectReceiver)
            },
          })
        },
      })

      return replaceCapacityProfile(
        failingTx,
        projectId,
        'ROLE',
        roleRtId,
        {
          planningBasis: 'CAPACITY_PROFILE',
          segments: [
            { startWeek: 0, endWeek: 3, capacityPercent: 90 },
            { startWeek: 6, endWeek: 10, capacityPercent: 40 },
          ],
        },
        userId,
      )
    })).rejects.toThrow('Simulated cache invalidation failure')

    const afterRole = await snapshotRoleState(roleRtId)
    expect(afterRole.profiles).toEqual(beforeRole.profiles)
    expect(afterRole.segments).toEqual(beforeRole.segments)
    expect(afterRole.rt).toEqual(beforeRole.rt)
    expect(afterRole.cache).toEqual(beforeRole.cache)

    const afterInherited = canonicalize(await prisma.namedResource.findUniqueOrThrow({
      where: { id: inheritedNrId },
    }))
    expect(afterInherited).toEqual(beforeInherited)

    const afterAll = await snapshotDbState()
    expect(afterAll.profiles).toEqual(beforeAll.profiles)
    expect(afterAll.segments).toEqual(beforeAll.segments)
    expect(afterAll.cache).toEqual(beforeAll.cache)
  })

  // ── Test 8: Planner-owned SQUAD_PLANNER profile returns 409 ──

  it('8. Planner-owned SQUAD_PLANNER profile returns 409', async () => {
    // Read before state
    const beforeProfiles = canonicalize(
      await prisma.capacityProfile.findMany({
        where: { projectId, resourceTypeId: squadRtId },
      }),
    )
    const beforeSegments = await prisma.capacitySegment.findMany({
      where: { capacityProfile: { projectId, resourceTypeId: squadRtId } },
    })
    const beforeCache = await prisma.project.findFirst({
      where: { id: projectId },
      select: { weeklyDemandCache: true },
    })

    // Attempt to replace via the API
    const res = await request(app)
      .put(`/api/projects/${projectId}/capacity-profiles/ROLE/${squadRtId}`)
      .set('Authorization', authHeader)
      .send({
        planningBasis: 'CAPACITY_PROFILE',
        segments: [
          { startWeek: 0, endWeek: 10, capacityPercent: 100 },
        ],
      })

    expect(res.status).toBe(409)
    expect(res.body.error).toBe('Cannot overwrite a SQUAD_PLANNER profile manually')

    // Verify state unchanged
    const afterProfiles = canonicalize(
      await prisma.capacityProfile.findMany({
        where: { projectId, resourceTypeId: squadRtId },
      }),
    )
    expect(afterProfiles).toEqual(beforeProfiles)

    const afterSegments = await prisma.capacitySegment.findMany({
      where: { capacityProfile: { projectId, resourceTypeId: squadRtId } },
    })
    expect(afterSegments).toEqual(beforeSegments)

    const afterCache = await prisma.project.findFirst({
      where: { id: projectId },
      select: { weeklyDemandCache: true },
    })
    expect(afterCache?.weeklyDemandCache).toEqual(beforeCache?.weeklyDemandCache)
  })

  it('9. ROLE edits preserve explicit named profiles while inherited compatibility follows twice', async () => {
    const inheritanceRole = await prisma.resourceType.create({
      data: {
        projectId,
        name: 'InheritanceRegressionRole',
        category: 'ENGINEERING',
        count: 5,
        hoursPerDay: 8,
        allocationMode: 'EFFORT',
        allocationPercent: 60,
      },
    })

    const [inherited, manualScalar, manualSegmented, planned, squadOwned] = await Promise.all(
      ['Inherited', 'ManualScalar', 'ManualSegmented', 'Planned', 'SquadOwned'].map(name =>
        prisma.namedResource.create({
          data: {
            resourceTypeId: inheritanceRole.id,
            name,
            allocationMode: 'EFFORT',
            allocationPercent: 60,
            allocationPct: 60,
          },
        }),
      ),
    )

    const scalarCreate = await request(app)
      .put(`/api/projects/${projectId}/capacity-profiles/NAMED_PERSON/${manualScalar.id}`)
      .set('Authorization', authHeader)
      .send({ planningBasis: 'DEMAND_FOLLOWING', defaultPercent: 60 })
    expect(scalarCreate.status).toBe(200)

    const segmentedCreate = await request(app)
      .put(`/api/projects/${projectId}/capacity-profiles/NAMED_PERSON/${manualSegmented.id}`)
      .set('Authorization', authHeader)
      .send({
        planningBasis: 'CAPACITY_PROFILE',
        segments: [
          { startWeek: 0, endWeek: 3, capacityPercent: 50 },
          { startWeek: 6, endWeek: 9, capacityPercent: 80 },
        ],
      })
    expect(segmentedCreate.status).toBe(200)

    await prisma.capacityProfile.create({
      data: {
        projectId,
        namedResourceId: planned.id,
        ownerKind: 'PLANNED_RESOURCE',
        planningBasis: 'WHOLE_PROJECT_ALLOCATION',
        source: 'MANUAL',
        defaultPercent: 60,
      },
    })
    await prisma.capacityProfile.create({
      data: {
        projectId,
        namedResourceId: squadOwned.id,
        ownerKind: 'NAMED_PERSON',
        planningBasis: 'WHOLE_PROJECT_ALLOCATION',
        source: 'SQUAD_PLANNER',
        defaultPercent: 60,
      },
    })

    const explicitIds = [manualScalar.id, manualSegmented.id, planned.id, squadOwned.id]
    const beforeExplicitProfiles = canonicalize(await prisma.capacityProfile.findMany({
      where: { namedResourceId: { in: explicitIds } },
      include: { segments: { orderBy: [{ startWeek: 'asc' }, { endWeek: 'asc' }] } },
      orderBy: { namedResourceId: 'asc' },
    }))
    const beforeExplicitResources = canonicalize(await prisma.namedResource.findMany({
      where: { id: { in: explicitIds } },
      orderBy: { id: 'asc' },
    }))
    const scalarProfile = beforeExplicitProfiles.find(profile => profile.namedResourceId === manualScalar.id)
    expect(scalarProfile?.legacy).toMatchObject({
      version: 1,
      writer: 'manual-editor',
      allocationMode: 'EFFORT',
      allocationPercent: 60,
    })
    expect(beforeExplicitResources.find(resource => resource.id === manualScalar.id)).toMatchObject({
      allocationMode: 'EFFORT',
      allocationPercent: 60,
      allocationPct: 60,
    })

    await prisma.project.update({
      where: { id: projectId },
      data: { weeklyDemandCache: { sentinel: 'first-role-edit' } },
    })
    const firstEdit = await request(app)
      .put(`/api/projects/${projectId}/capacity-profiles/ROLE/${inheritanceRole.id}`)
      .set('Authorization', authHeader)
      .send({ planningBasis: 'WHOLE_PROJECT_ALLOCATION', defaultPercent: 80 })
    expect(firstEdit.status).toBe(200)
    expect(await prisma.namedResource.findUniqueOrThrow({ where: { id: inherited.id } })).toMatchObject({
      allocationMode: 'FULL_PROJECT',
      allocationPercent: 80,
      allocationPct: 80,
    })
    expect((await prisma.project.findUniqueOrThrow({
      where: { id: projectId },
      select: { weeklyDemandCache: true },
    })).weeklyDemandCache).toEqual({})

    await prisma.project.update({
      where: { id: projectId },
      data: { weeklyDemandCache: { sentinel: 'second-role-edit' } },
    })
    const secondEdit = await request(app)
      .put(`/api/projects/${projectId}/capacity-profiles/ROLE/${inheritanceRole.id}`)
      .set('Authorization', authHeader)
      .send({
        planningBasis: 'AVAILABILITY_WINDOW',
        defaultPercent: 70,
        startWeek: 2,
        endWeek: 8,
      })
    expect(secondEdit.status).toBe(200)
    expect(await prisma.namedResource.findUniqueOrThrow({ where: { id: inherited.id } })).toMatchObject({
      allocationMode: 'TIMELINE',
      allocationPercent: 70,
      allocationPct: 70,
      allocationStartWeek: 2,
      allocationEndWeek: 8,
      startWeek: 2,
      endWeek: 8,
    })
    expect(await prisma.capacityProfile.findMany({
      where: { namedResourceId: inherited.id },
    })).toEqual([])

    expect(canonicalize(await prisma.capacityProfile.findMany({
      where: { namedResourceId: { in: explicitIds } },
      include: { segments: { orderBy: [{ startWeek: 'asc' }, { endWeek: 'asc' }] } },
      orderBy: { namedResourceId: 'asc' },
    }))).toEqual(beforeExplicitProfiles)
    expect(canonicalize(await prisma.namedResource.findMany({
      where: { id: { in: explicitIds } },
      orderBy: { id: 'asc' },
    }))).toEqual(beforeExplicitResources)
    expect((await prisma.project.findUniqueOrThrow({
      where: { id: projectId },
      select: { weeklyDemandCache: true },
    })).weeklyDemandCache).toEqual({})
  })

  it('10. Representable persisted ownership conflicts fail closed without writes', async () => {
    const carrierRole = await prisma.resourceType.create({
      data: {
        projectId,
        name: 'ConflictCarrierRole',
        category: 'ENGINEERING',
        count: 1,
        hoursPerDay: 8,
      },
    })

    async function expectConflictWithoutWrites(
      ownerKind: 'ROLE' | 'NAMED_PERSON',
      ownerId: string,
    ) {
      await prisma.project.update({
        where: { id: projectId },
        data: { weeklyDemandCache: { conflictOwnerId: ownerId } },
      })
      const before = await snapshotDbState()
      const response = await request(app)
        .put(`/api/projects/${projectId}/capacity-profiles/${ownerKind}/${ownerId}`)
        .set('Authorization', authHeader)
        .send({ planningBasis: 'WHOLE_PROJECT_ALLOCATION', defaultPercent: 77 })
      expect(response.status).toBe(409)
      expect(await snapshotDbState()).toEqual(before)
    }

    const sharedId = `shared-${Date.now()}`
    await prisma.resourceType.create({
      data: {
        id: sharedId,
        projectId,
        name: 'MultipleCandidateRole',
        category: 'ENGINEERING',
        count: 1,
        hoursPerDay: 8,
      },
    })
    await prisma.namedResource.create({
      data: {
        id: sharedId,
        resourceTypeId: carrierRole.id,
        name: 'MultipleCandidatePerson',
      },
    })
    await prisma.capacityProfile.create({
      data: {
        projectId,
        resourceTypeId: sharedId,
        ownerKind: 'ROLE',
        planningBasis: 'CAPACITY_PROFILE',
        source: 'MANUAL',
        segments: {
          create: [{ startWeek: 0, endWeek: 2, capacityPercent: 50, source: 'MANUAL' }],
        },
      },
    })
    await prisma.capacityProfile.create({
      data: {
        projectId,
        namedResourceId: sharedId,
        ownerKind: 'NAMED_PERSON',
        planningBasis: 'CAPACITY_PROFILE',
        source: 'MANUAL',
        segments: {
          create: [{ startWeek: 4, endWeek: 6, capacityPercent: 60, source: 'MANUAL' }],
        },
      },
    })
    await expectConflictWithoutWrites('ROLE', sharedId)

    const mismatchedId = `mismatched-${Date.now()}`
    await prisma.resourceType.create({
      data: {
        id: mismatchedId,
        projectId,
        name: 'MismatchedCandidateRole',
        category: 'ENGINEERING',
        count: 1,
        hoursPerDay: 8,
      },
    })
    await prisma.namedResource.create({
      data: {
        id: mismatchedId,
        resourceTypeId: carrierRole.id,
        name: 'MismatchedCandidatePerson',
      },
    })
    await prisma.capacityProfile.create({
      data: {
        projectId,
        namedResourceId: mismatchedId,
        ownerKind: 'NAMED_PERSON',
        planningBasis: 'CAPACITY_PROFILE',
        source: 'MANUAL',
        segments: {
          create: [{ startWeek: 1, endWeek: 3, capacityPercent: 65, source: 'MANUAL' }],
        },
      },
    })
    await expectConflictWithoutWrites('ROLE', mismatchedId)

    const plannedResource = await prisma.namedResource.create({
      data: {
        resourceTypeId: carrierRole.id,
        name: 'PlannedOwnershipConflict',
      },
    })
    await prisma.capacityProfile.create({
      data: {
        projectId,
        namedResourceId: plannedResource.id,
        ownerKind: 'PLANNED_RESOURCE',
        planningBasis: 'CAPACITY_PROFILE',
        source: 'MANUAL',
        segments: {
          create: [{ startWeek: 2, endWeek: 5, capacityPercent: 70, source: 'MANUAL' }],
        },
      },
    })
    await expectConflictWithoutWrites('NAMED_PERSON', plannedResource.id)

    const squadRole = await prisma.resourceType.create({
      data: {
        projectId,
        name: 'SquadOwnershipConflict',
        category: 'ENGINEERING',
        count: 1,
        hoursPerDay: 8,
      },
    })
    await prisma.capacityProfile.create({
      data: {
        projectId,
        resourceTypeId: squadRole.id,
        ownerKind: 'ROLE',
        planningBasis: 'CAPACITY_PROFILE',
        source: 'SQUAD_PLANNER',
        segments: {
          create: [{ startWeek: 3, endWeek: 7, capacityPercent: 75, source: 'SQUAD_PLANNER' }],
        },
      },
    })
    await expectConflictWithoutWrites('ROLE', squadRole.id)
  })
})
