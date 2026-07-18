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
      allocationMode: 'TIMELINE',
      allocationPercent: 100,
      hoursPerDay: 7.6,
      dayRate: 1200,
    },
  })
  rtId = rt.id
  // Second RT for segmentless CAPACITY_PROFILE test
  const defaultRt = await prisma.resourceType.create({
    data: {
      projectId,
      name: 'Default Engineer',
      category: 'ENGINEERING',
      count: 1,
      allocationMode: 'TIMELINE',
      allocationPercent: 100,
      hoursPerDay: 7.6,
      dayRate: 1000,
    },
  })
  defaultRtId = defaultRt.id

  // ── Fixture 1: Segmented NAMED_PERSON (for tests A, B, C, D) ──────────
  const segNr = await prisma.namedResource.create({
    data: {
      resourceTypeId: rtId,
      name: 'Segmented Alice',
      startWeek: 0,
      endWeek: 9,
      allocationPct: 75,
      allocationMode: 'TIMELINE',
      allocationPercent: 75,
      allocationStartWeek: 0,
      allocationEndWeek: 9,
      pricingModel: 'ACTUAL_DAYS',
    },
  })
  segmentedNrId = segNr.id

  const segProfile = await prisma.capacityProfile.create({
    data: {
      projectId,
      resourceTypeId: rtId,
      namedResourceId: segNr.id,
      ownerKind: 'NAMED_PERSON',
      planningBasis: 'AVAILABILITY_WINDOW',
      source: 'MANUAL',
      defaultPercent: 60,
      startWeek: 3,
      endWeek: 6,
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
      startWeek: 0,
      endWeek: 5,
      allocationPct: 100,
      allocationMode: 'TIMELINE',
      allocationPercent: 100,
      allocationStartWeek: 0,
      allocationEndWeek: 5,
      pricingModel: 'ACTUAL_DAYS',
    },
  })
  capProfileNrId = capNr.id

  const capProfile = await prisma.capacityProfile.create({
    data: {
      projectId,
      resourceTypeId: defaultRtId,
      namedResourceId: capNr.id,
      ownerKind: 'NAMED_PERSON',
      planningBasis: 'CAPACITY_PROFILE',
      source: 'MANUAL',
      defaultPercent: null,
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
      startWeek: null,
      endWeek: null,
      allocationPct: 50,
      allocationMode: 'TIMELINE',
      allocationPercent: 50,
      allocationStartWeek: null,
      allocationEndWeek: null,
      pricingModel: 'ACTUAL_DAYS',
    },
  })
  scalarNrId = scalarNr.id

  const scalarProfile = await prisma.capacityProfile.create({
    data: {
      projectId,
      resourceTypeId: rtId,
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

type CanonicalGuardState = {
  nr: {
    id: string
    name: string
    pricingModel: string
    allocationMode: string
    allocationPercent: number
    allocationPct: number
    allocationStartWeek: number | null
    allocationEndWeek: number | null
    startWeek: number | null
    endWeek: number | null
  } | null
  profile: {
    id: string
    namedResourceId: string | null
    resourceTypeId: string | null
    ownerKind: string | null
    planningBasis: string | null
    source: string | null
    defaultPercent: number | null
    startWeek: number | null
    endWeek: number | null
  } | null
  segments: Array<{
    id: string
    startWeek: number
    endWeek: number
    capacityPercent: number
    source: string
  }>
  cache: unknown
}

/** Read canonical DB state via Prisma for exact assertion. */
async function readCanonicalState(nrId: string, profileId: string): Promise<CanonicalGuardState> {
  const nr = await prisma.namedResource.findFirst({ where: { id: nrId } })
  const profile = await prisma.capacityProfile.findFirst({ where: { id: profileId } })
  const segments = await prisma.capacitySegment.findMany({
    where: { capacityProfileId: profileId },
    orderBy: [{ startWeek: 'asc' }, { endWeek: 'asc' }],
  })
  const cache = await prisma.project.findFirst({
    where: { id: projectId },
    select: { weeklyDemandCache: true },
  })
  return { nr, profile, segments, cache: cache?.weeklyDemandCache }
}
/** Assert exact state unchanged between before and after snapshots. */
function assertStateUnchanged(before: CanonicalGuardState, after: CanonicalGuardState) {
  expect(after.nr?.name).toBe(before.nr?.name)
  expect(after.nr?.pricingModel).toBe(before.nr?.pricingModel)
  expect(after.nr?.allocationMode).toBe(before.nr?.allocationMode)
  expect(after.nr?.allocationPercent).toBe(before.nr?.allocationPercent)
  expect(after.nr?.allocationPct).toBe(before.nr?.allocationPct)
  expect(after.nr?.allocationStartWeek).toBe(before.nr?.allocationStartWeek)
  expect(after.nr?.allocationEndWeek).toBe(before.nr?.allocationEndWeek)
  expect(after.nr?.startWeek).toBe(before.nr?.startWeek)
  expect(after.nr?.endWeek).toBe(before.nr?.endWeek)

  expect(after.profile?.id).toBe(before.profile?.id)
  expect(after.profile?.ownerKind).toBe(before.profile?.ownerKind)
  expect(after.profile?.planningBasis).toBe(before.profile?.planningBasis)
  expect(after.profile?.source).toBe(before.profile?.source)
  expect(after.profile?.defaultPercent).toBe(before.profile?.defaultPercent)
  expect(after.profile?.startWeek).toBe(before.profile?.startWeek)
  expect(after.profile?.endWeek).toBe(before.profile?.endWeek)

  expect(after.segments).toHaveLength(before.segments.length)
  for (let i = 0; i < before.segments.length; i++) {
    expect(after.segments[i].id).toBe(before.segments[i].id)
    expect(after.segments[i].startWeek).toBe(before.segments[i].startWeek)
    expect(after.segments[i].endWeek).toBe(before.segments[i].endWeek)
    expect(after.segments[i].capacityPercent).toBe(before.segments[i].capacityPercent)
    expect(after.segments[i].source).toBe(before.segments[i].source)
  }

  // Cache unchanged (deep equality on JSON)
  expect(JSON.stringify(after.cache)).toBe(JSON.stringify(before.cache))
}

/**
 * Assert that exactly one named-resource field changed and everything
 * else — profile, segments, cache — is preserved identically.
 */
function expectOnlyNamedResourceFieldChanged(
  before: CanonicalGuardState,
  after: CanonicalGuardState,
  field: 'name' | 'pricingModel',
  expectedValue: string,
) {
  // The specified field has the expected new value
  expect(after.nr?.[field]).toBe(expectedValue)

  // Every other named-resource field is unchanged: overwrite the
  // changed field with the original value, then compare full objects.
  const restored = { ...after.nr, [field]: before.nr?.[field] }
  expect(restored).toEqual(before.nr)

  // Profile, segments, and cache are completely unchanged
  expect(after.profile).toEqual(before.profile)
  expect(after.segments).toEqual(before.segments)
  expect(JSON.stringify(after.cache)).toBe(JSON.stringify(before.cache))
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describeIf('Named-resource guard (real PostgreSQL)', () => {
  const base = () => `/api/projects/${projectId}/resource-types/${rtId}/named-resources`
  const namedUrl = (nrId: string) => `${base()}/${nrId}`
  let initialSegState: CanonicalGuardState
  let initialCapProfileState: CanonicalGuardState

  // Snapshot initial state before any tests mutate
  beforeAll(async () => {
    initialSegState = await readCanonicalState(segmentedNrId, segmentedProfileId)
    initialCapProfileState = await readCanonicalState(capProfileNrId, capProfileProfileId)
  })

  // ── A. Rejected mixed-field PUT ─────────────────────────────────────────

  it('A: PUT with name + pricing + capacity fields → 409, exact state preserved (segmented NAMED_PERSON)', async () => {
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

    expect(res.status).toBe(409)
    expect(res.body.code).toBe('PROFILE_MANAGED_CAPACITY')

    const after = await readCanonicalState(segmentedNrId, segmentedProfileId)
    assertStateUnchanged(initialSegState, after)
  })

  // ── B. Rejected capacity PATCH ──────────────────────────────────────────

  it('B: PATCH with scalar capacity → 409, exact state preserved (segmented NAMED_PERSON)', async () => {
    const res = await request(app)
      .patch(namedUrl(segmentedNrId))
      .set('Authorization', authHeader)
      .send({
        startWeek: 5,
        allocationPercent: 80,
      })

    expect(res.status).toBe(409)
    expect(res.body.code).toBe('PROFILE_MANAGED_CAPACITY')

    const after = await readCanonicalState(segmentedNrId, segmentedProfileId)
    assertStateUnchanged(initialSegState, after)
  })

  // ── C. Safe name-only PUT ───────────────────────────────────────────────

  it('C: PUT with name only → 200, only name changes (segmented NAMED_PERSON)', async () => {
    const res = await request(app)
      .put(namedUrl(segmentedNrId))
      .set('Authorization', authHeader)
      .send({ name: 'Segmented Alice Renamed' })

    expect(res.status).toBe(200)
    expect(res.body.name).toBe('Segmented Alice Renamed')

    const after = await readCanonicalState(segmentedNrId, segmentedProfileId)
    // Only name changed — everything else exact
    expectOnlyNamedResourceFieldChanged(initialSegState, after, 'name', 'Segmented Alice Renamed')

    // Reset name for other tests
    await prisma.namedResource.update({
      where: { id: segmentedNrId },
      data: { name: 'Segmented Alice' },
    })
  })

  it('D: PUT with pricingModel only → 200, only pricingModel changes (segmented NAMED_PERSON)', async () => {
    const res = await request(app)
      .put(namedUrl(segmentedNrId))
      .set('Authorization', authHeader)
      .send({ pricingModel: 'PRO_RATA' })

    expect(res.status).toBe(200)
    expect(res.body.pricingModel).toBe('PRO_RATA')

    const after = await readCanonicalState(segmentedNrId, segmentedProfileId)
    // Only pricingModel changed — everything else exact
    expectOnlyNamedResourceFieldChanged(initialSegState, after, 'pricingModel', 'PRO_RATA')

    // Reset pricing for other tests
    await prisma.namedResource.update({
      where: { id: segmentedNrId },
      data: { pricingModel: 'ACTUAL_DAYS' },
    })
  })

  // ── E. Segmentless CAPACITY_PROFILE PUT/PATCH ───────────────────────────

  it('E1: PUT with capacity fields → 409 (segmentless CAPACITY_PROFILE)', async () => {
    const capBase = `/api/projects/${projectId}/resource-types/${defaultRtId}/named-resources`
    const res = await request(app)
      .put(`${capBase}/${capProfileNrId}`)
      .set('Authorization', authHeader)
      .send({
        startWeek: 2,
        allocationPercent: 80,
      })

    expect(res.status).toBe(409)
    expect(res.body.code).toBe('PROFILE_MANAGED_CAPACITY')

    const after = await readCanonicalState(capProfileNrId, capProfileProfileId)
    assertStateUnchanged(initialCapProfileState, after)
  })

  it('E2: PATCH with scalar capacity → 409 (segmentless CAPACITY_PROFILE)', async () => {
    const capBase = `/api/projects/${projectId}/resource-types/${defaultRtId}/named-resources`
    const res = await request(app)
      .patch(`${capBase}/${capProfileNrId}`)
      .set('Authorization', authHeader)
      .send({
        allocationPercent: 60,
      })

    expect(res.status).toBe(409)
    expect(res.body.code).toBe('PROFILE_MANAGED_CAPACITY')

    const after = await readCanonicalState(capProfileNrId, capProfileProfileId)
    assertStateUnchanged(initialCapProfileState, after)
  })

  // ── F. Scalar-safe segmentless profile ─────────────────────────────────

  it('F: PUT with capacity fields succeeds for normal segmentless profile', async () => {
    const res = await request(app)
      .put(namedUrl(scalarNrId))
      .set('Authorization', authHeader)
      .send({
        startWeek: 4,
        endWeek: 9,
        allocationPct: 70,
      })

    expect(res.status).toBe(200)

    const after = await readCanonicalState(scalarNrId, scalarProfileId)
    // The compatibility projection must be exact
    expect(after.nr?.allocationStartWeek).toBe(4)
    expect(after.nr?.allocationEndWeek).toBe(9)
    expect(after.nr?.startWeek).toBe(4)
    expect(after.nr?.endWeek).toBe(9)
    expect(after.nr?.allocationPercent).toBe(70)
    expect(after.nr?.allocationPct).toBe(70)
  })
})
