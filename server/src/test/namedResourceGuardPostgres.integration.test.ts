/**
 * namedResourceGuardPostgres.integration.test.ts — Real PostgreSQL integration tests
 * for issue #388 segmented named-resource profile protection.
 *
 * Tests the PUT/PATCH /api/projects/:projectId/resource-types/:rtId/named-resources/:id
 * guard against scalar capacity flattening for segmented or CAPACITY_PROFILE profiles.
 *
 * All tests assert:
 *   - HTTP status and code for protected/capacity writes
 *   - Exact database state preservation via Prisma queries
 *   - Exact segment ordering and identity
 *   - Weekly demand cache unchanged on rejection
 *
 * Skipped unless INTEGRATION_TEST=true. Uses the disposable test database
 * created by the monrad-estimator lifecycle module.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '@prisma/client'
import { app } from '../app.js'
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

// Stable deterministic IDs for reproducibility
const USER_EMAIL = 'named-resource-guard-388-integration@example.com'
const PROJ_NAME = 'NR Guard Integration #388'
let projectId: string
let rtId: string
let defaultRtId: string

// Named resource IDs — created in order below
let segmentedNrId: string
let segmentedProfileId: string
let capProfileNrId: string
let capProfileProfileId: string
let scalarNrId: string
let scalarProfileId: string

beforeAll(async () => {
  if (!runIntegration) return
  prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
  })
  await prisma.$connect()

  // Create test user
  const user = await prisma.user.upsert({
    where: { email: USER_EMAIL },
    create: {
      email: USER_EMAIL,
      name: 'NR Guard Integration',
      password: '$2b$10$placeholder',
    },
    update: {},
  })
  userId = user.id
  token = jwt.sign({ userId, role: 'USER' }, process.env.JWT_SECRET!)
  authHeader = `Bearer ${token}`

  // Create project
  const project = await prisma.project.create({
    data: {
      name: PROJ_NAME,
      ownerId: userId,
      hoursPerDay: 7.6,
      status: 'DRAFT',
    },
  })
  projectId = project.id

  // Create resource types — need one for default/role-level and one for named
  const rt = await prisma.resourceType.create({
    data: {
      projectId,
      name: 'Engineer',
      category: 'ENGINEERING',
      count: 1,
      hoursPerDay: 7.6,
      dayRate: 1200,
    },
  })
  rtId = rt.id
  const defaultRt = await prisma.resourceType.create({
    data: {
      projectId,
      name: 'Default Engineer',
      category: 'ENGINEERING',
      count: 1,
      hoursPerDay: 7.6,
      dayRate: 1000,
    },
  })
  defaultRtId = defaultRt.id

  // Keep both ResourceTypes in valid profile-first state. The second row's
  // compatibility mode is deliberately stale and is not runtime authority.
  await prisma.capacityProfile.createMany({
    data: [
      {
        projectId,
        resourceTypeId: rtId,
        namedResourceId: null,
        ownerKind: 'ROLE',
        planningBasis: 'AVAILABILITY_WINDOW',
        source: 'AVAILABILITY_WINDOW',
        defaultPercent: 100,
        startWeek: null,
        endWeek: null,
      },
      {
        projectId,
        resourceTypeId: defaultRtId,
        namedResourceId: null,
        ownerKind: 'ROLE',
        planningBasis: 'AVAILABILITY_WINDOW',
        source: 'AVAILABILITY_WINDOW',
        defaultPercent: 100,
        startWeek: null,
        endWeek: null,
      },
    ],
  })

  // Seed a distinguishable weeklyDemandCache value that cannot be mistaken
  // for the default empty object — proves rejected requests preserve it exactly.
  await prisma.project.update({
    where: { id: projectId },
    data: { weeklyDemandCache: { [`${rtId}|99`]: 42.5 } },
  })

  // ── Fixture 1: Segmented NAMED_PERSON (for tests A, B, C, D) ──────────
  const segNr = await prisma.namedResource.create({
    data: {
      resourceTypeId: rtId,
      name: 'Segmented Alice',
      pricingModel: 'ACTUAL_DAYS',
    },
  })
  segmentedNrId = segNr.id

  const segProfile = await prisma.capacityProfile.create({
    data: {
      projectId,
      resourceTypeId: null,
      namedResourceId: segNr.id,
      ownerKind: 'NAMED_PERSON',
      planningBasis: 'CAPACITY_PROFILE',
      source: 'MANUAL',
      defaultPercent: 60,
      startWeek: null,
      endWeek: null,
    },
  })
  segmentedProfileId = segProfile.id


  await prisma.capacitySegment.create({
    data: {
      capacityProfileId: segProfile.id,
      startWeek: 0,
      endWeek: 3,
      capacityPercent: 50,
      source: 'MANUAL',
    },
  })
  await prisma.capacitySegment.create({
    data: {
      capacityProfileId: segProfile.id,
      startWeek: 4,
      endWeek: 8,
      capacityPercent: 100,
      source: 'MANUAL',
    },
  })
  // ── Fixture 2: Segmentless CAPACITY_PROFILE NAMED_PERSON (for test E) ──
  const capNr = await prisma.namedResource.create({
    data: {
      resourceTypeId: defaultRtId,
      name: 'CapProfile Bob',
      pricingModel: 'ACTUAL_DAYS',
    },
  })
  capProfileNrId = capNr.id
  const capProfile = await prisma.capacityProfile.create({
    data: {
      projectId,
      resourceTypeId: null,
      namedResourceId: capNr.id,
      ownerKind: 'NAMED_PERSON',
      planningBasis: 'CAPACITY_PROFILE',
      source: 'LEGACY',
      defaultPercent: 100,
      startWeek: null,
      endWeek: null,
    },
  })
  capProfileProfileId = capProfile.id

  // ── Fixture 3: Normal scalar segmentless (for test F) ────────────────
  const scalarNr = await prisma.namedResource.create({
    data: {
      resourceTypeId: rtId,
      name: 'Scalar Charlie',
      pricingModel: 'ACTUAL_DAYS',
    },
  })
  scalarNrId = scalarNr.id

  const scalarProfile = await prisma.capacityProfile.create({
    data: {
      projectId,
      resourceTypeId: null,
      namedResourceId: scalarNr.id,
      ownerKind: 'NAMED_PERSON',
      planningBasis: 'AVAILABILITY_WINDOW',
      source: 'MANUAL',
      defaultPercent: 50,
      startWeek: null,
      endWeek: null,
    },
  })
  scalarProfileId = scalarProfile.id
})

afterAll(async () => {
  if (!runIntegration) return
  await prisma.project.deleteMany({ where: { ownerId: userId } })
  await prisma.user.deleteMany({ where: { email: USER_EMAIL } })
  await prisma.$disconnect()
})

// ─── Helpers ────────────────────────────────────────────────────────────────

function canonicalize<T>(value: T): T {
  return JSON.parse(JSON.stringify(value))
}

type CanonicalGuardState = {
  nr: Record<string, unknown> | null
  profile: Record<string, unknown> | null
  segments: Record<string, unknown>[]
  cache: unknown
}

/** Read canonical DB state via Prisma for exact assertion. */
async function readCanonicalState(nrId: string, profileId: string): Promise<CanonicalGuardState> {
  const nr = await prisma.namedResource.findFirst({ where: { id: nrId } })
  const profile = await prisma.capacityProfile.findFirst({ where: { id: profileId } })
  const segments = await prisma.capacitySegment.findMany({
    where: { capacityProfileId: profileId },
    orderBy: [{ startWeek: 'asc' }, { endWeek: 'asc' }, { id: 'asc' }],
  })
  const cacheRow = await prisma.project.findFirst({
    where: { id: projectId },
    select: { weeklyDemandCache: true },
  })
  return {
    nr: canonicalize(nr ?? null),
    profile: canonicalize(profile ?? null),
    segments: canonicalize(segments),
    cache: cacheRow?.weeklyDemandCache ?? null,
  }
}

/**
 * Write a deterministic non-empty weeklyDemandCache value keyed by a
 * per-test marker, so each rejected test independently proves the cache
 * was preserved.
 */
async function seedDistinctWeeklyDemandCache(marker: string) {
  const value = { [`${rtId}|${marker}`]: 42.5 }
  await prisma.project.update({
    where: { id: projectId },
    data: { weeklyDemandCache: value },
  })
  return value
}

/**
 * Assert that a rejected (409) request preserved the FULL canonical state.
 * Every persisted field — including createdAt, updatedAt, projectId,
 * resourceTypeId, namedResourceId — must be identical after a rejected
 * request, because the guard rejects before any writes or cache invalidation.
 */
function expectRejectedStateUnchanged(before: CanonicalGuardState, after: CanonicalGuardState) {
  expect(after).toEqual(before)
}

/**
 * Assert that a successful named-resource update changed exactly the
 * intended field. The named-resource updatedAt may legitimately change;
 * all other records (profile, segments) must be untouched. Cache is
 * project-wide and may be invalidated by sync side effects.
 */
function expectOnlyNamedResourceFieldChanged(
  before: CanonicalGuardState,
  after: CanonicalGuardState,
  field: 'name' | 'pricingModel',
  expectedValue: string,
) {
  // The specified field has the expected new value
  expect((after.nr as any)?.[field]).toBe(expectedValue)

  // Compare named-resource fields excluding volatile updatedAt
  if (before.nr && after.nr) {
    const { updatedAt: _bu, ...beforeClean } = before.nr as any
    const { updatedAt: _au, ...afterClean } = after.nr as any
    // Reset the changed field to its before value so we can assert
    // that nothing else changed.
    afterClean[field] = (before.nr as any)[field]
    expect(afterClean).toEqual(beforeClean)
  }

  // Profile and segments are completely unchanged
  expect(after.profile).toEqual(before.profile)
  expect(after.segments).toEqual(before.segments)
  // NOTE: Cache is project-wide and may be invalidated by successful
  // writes; the caller may optionally verify cache separately.
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describeIf('Named-resource guard (real PostgreSQL)', () => {
  const base = () => `/api/projects/${projectId}/resource-types/${rtId}/named-resources`
  const namedUrl = (nrId: string) => `${base()}/${nrId}`

  // ── A. Rejected mixed-field PUT ─────────────────────────────────────────

  it('A: PUT with name + pricing + legacy capacity fields → 400, exact state preserved (segmented NAMED_PERSON)', async () => {
    await seedDistinctWeeklyDemandCache('A')
    const before = await readCanonicalState(segmentedNrId, segmentedProfileId)
    // Verify the cache is non-empty
    expect(before.cache).toEqual({ [`${rtId}|A`]: 42.5 })

    const res = await request(app)
      .put(namedUrl(segmentedNrId))
      .set('Authorization', authHeader)
      .send({
        name: 'Must Not Persist',
        pricingModel: 'PRO_RATA',
        allocationPercent: 75,
        startWeek: 2,
        endWeek: 10,
      })

    // Issue #403: supplied legacy capacity fields are rejected with 400
    expect(res.status).toBe(400)
    expect(res.body.rejectedFields).toEqual(['allocationPercent', 'startWeek', 'endWeek'])

    const after = await readCanonicalState(segmentedNrId, segmentedProfileId)
    expectRejectedStateUnchanged(before, after)
  })
  it('B: PATCH is rejection-only → structured 400, state and cache unchanged (segmented NAMED_PERSON)', async () => {
    await seedDistinctWeeklyDemandCache('B')
    const before = await readCanonicalState(segmentedNrId, segmentedProfileId)
    expect(before.cache).toEqual({ [`${rtId}|B`]: 42.5 })

    const res = await request(app)
      .patch(namedUrl(segmentedNrId))
      .set('Authorization', authHeader)
      .send({
        startWeek: 5,
        allocationPercent: 80,
      })

    expect(res.status).toBe(400)
    expect(res.body.rejectedFields).toEqual(['allocationPercent', 'startWeek'])
    expect(res.body.error).toContain('capacity-profiles/:ownerKind/:ownerId')

    const after = await readCanonicalState(segmentedNrId, segmentedProfileId)
    expectRejectedStateUnchanged(before, after)
  })
  it('C: PUT with name only → 200, only name changes (segmented NAMED_PERSON)', async () => {
    const before = await readCanonicalState(segmentedNrId, segmentedProfileId)

    const res = await request(app)
      .put(namedUrl(segmentedNrId))
      .set('Authorization', authHeader)
      .send({ name: 'Segmented Alice Renamed' })

    expect(res.status).toBe(200)
    expect(res.body.name).toBe('Segmented Alice Renamed')

    const after = await readCanonicalState(segmentedNrId, segmentedProfileId)
    expectOnlyNamedResourceFieldChanged(before, after, 'name', 'Segmented Alice Renamed')

    // Reset name for other tests
    await prisma.namedResource.update({
      where: { id: segmentedNrId },
      data: { name: 'Segmented Alice' },
    })
  })

  it('D: PUT with pricingModel only → 200, only pricingModel changes (segmented NAMED_PERSON)', async () => {
    const before = await readCanonicalState(segmentedNrId, segmentedProfileId)

    const res = await request(app)
      .put(namedUrl(segmentedNrId))
      .set('Authorization', authHeader)
      .send({ pricingModel: 'PRO_RATA' })
    expect(res.status).toBe(200)
    expect(res.body.pricingModel).toBe('PRO_RATA')

    const after = await readCanonicalState(segmentedNrId, segmentedProfileId)
    expectOnlyNamedResourceFieldChanged(before, after, 'pricingModel', 'PRO_RATA')

    // Reset pricing for other tests
    await prisma.namedResource.update({
      where: { id: segmentedNrId },
      data: { pricingModel: 'ACTUAL_DAYS' },
    })
  })

  // ── E. Segmentless CAPACITY_PROFILE PUT/PATCH ───────────────────────────

  it('E1: PUT with legacy capacity fields → 400, cache preserved (segmentless CAPACITY_PROFILE)', async () => {
    // Reseed with a distinct marker so this test proves cache preservation
    // independently — it does not rely on cache state left by earlier tests.
    await seedDistinctWeeklyDemandCache('E1')
    const capBase = `/api/projects/${projectId}/resource-types/${defaultRtId}/named-resources`
    const before = await readCanonicalState(capProfileNrId, capProfileProfileId)
    expect(before.cache).toEqual({ [`${rtId}|E1`]: 42.5 })

    const res = await request(app)
      .put(`${capBase}/${capProfileNrId}`)
      .set('Authorization', authHeader)
      .send({
        startWeek: 2,
        allocationPercent: 80,
      })
    expect(res.status).toBe(400)
    expect(res.body.rejectedFields).toEqual(['allocationPercent', 'startWeek'])

    const after = await readCanonicalState(capProfileNrId, capProfileProfileId)
    expectRejectedStateUnchanged(before, after)
  })
  it('E2: PATCH is rejection-only → structured 400, state and cache unchanged (segmentless CAPACITY_PROFILE)', async () => {
    await seedDistinctWeeklyDemandCache('E2')
    const capBase = `/api/projects/${projectId}/resource-types/${defaultRtId}/named-resources`
    const before = await readCanonicalState(capProfileNrId, capProfileProfileId)
    expect(before.cache).toEqual({ [`${rtId}|E2`]: 42.5 })

    const res = await request(app)
      .patch(`${capBase}/${capProfileNrId}`)
      .set('Authorization', authHeader)
      .send({
        allocationPercent: 60,
      })

    expect(res.status).toBe(400)
    expect(res.body.rejectedFields).toEqual(['allocationPercent'])

    const after = await readCanonicalState(capProfileNrId, capProfileProfileId)
    expectRejectedStateUnchanged(before, after)
  })
  it('F: scalar-safe window edits use the first-class capacity-profile endpoint', async () => {
    // Legacy capacity request fields are rejected on the NamedResource route
    const rejected = await request(app)
      .put(namedUrl(scalarNrId))
      .set('Authorization', authHeader)
      .send({
        startWeek: 4,
        endWeek: 9,
        allocationPct: 70,
      })
    expect(rejected.status).toBe(400)
    expect(rejected.body.rejectedFields).toEqual(['allocationPct', 'startWeek', 'endWeek'])

    // The same edit succeeds through the owner-scoped capacity-profile endpoint
    const res = await request(app)
      .put(`/api/projects/${projectId}/capacity-profiles/NAMED_PERSON/${scalarNrId}`)
      .set('Authorization', authHeader)
      .send({
        planningBasis: 'AVAILABILITY_WINDOW',
        defaultPercent: 70,
        startWeek: 4,
        endWeek: 9,
      })
    expect(res.status).toBe(200)

    const after = await readCanonicalState(scalarNrId, scalarProfileId)
    // Issue #418: the legacy columns no longer exist; the capacity lives in
    // the profile, asserted below.
    expect(after.nr).toBeDefined()
    expect(after.profile?.planningBasis).toBe('AVAILABILITY_WINDOW')
    expect(after.profile?.defaultPercent).toBe(70)
    expect(after.profile?.startWeek).toBe(4)
    expect(after.profile?.endWeek).toBe(9)
  })})
