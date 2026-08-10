/**
 * snapshotRollback.integration.test.ts — Real PostgreSQL snapshot rollback tests.
 *
 * These tests exercise the full snapshot → mutate → rollback cycle against a
 * running PostgreSQL database. They are skipped by default (INTEGRATION_TEST).
 *
 * Every scenario invokes rollbackProjectSnapshot({ projectId, snapshotId, userId, db })
 * from the lib service and asserts observable DB state. No mocks, no manual
 * simulation of rollback logic.
 *
 * Schema versions:
 *   v1 — Epic-tree array (legacy; bare array or {epics: [...]} wrapper)
 *   v2 — Full project state with schemaVersion: 2
 *   v3 — V2 + capacityProfiles (schemaVersion: 3)
 *
 * Issue #444: V4 is the minimum supported/restorable snapshot format.
 * Rollback of V1/V2/V3 snapshots is deliberately refused pre-write with the
 * stable retirement reason; the legacy scenarios below assert that refusal
 * and prove no state change on real PostgreSQL.
 *
 * Scenarios:
 *   A — Exact V4 round trip (2 RTs, 2 NRs, 3 ownerKinds, all legacy types,
 *       segments, backlog, timeline, overhead, pricing models)
 *   B — Rollback-to-rollback chaining (A→B→rollback A→pre_rollback B→rollback→B)
 *   C — Transactional FK failure after pre_rollback creation
 *   D — Pre-transaction validation failure (malformed, duplicate IDs, bad enums)
 *   E/F/G/H/I — V1/V2 rollback refusal with the retirement reason (issue #444)
 *
 * @module test/snapshotRollback.integration
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import { PrismaClient, Prisma } from '@prisma/client'
import type { $Enums } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import {
  rollbackProjectSnapshot,
} from '../lib/projectSnapshotService.js'
import { buildSnapshot } from '../routes/snapshots.js'
import { SnapshotSchemaError } from '../lib/projectSnapshotTypes.js'
import { SnapshotValidationError } from '../lib/projectSnapshotValidation.js'
import { RETIREMENT_REASON } from '../lib/snapshotRestorability.js'
import { RollbackPreflightError } from '../lib/projectSnapshotService.js'
import type {
  SnapshotV1,
  SnapshotV2,
  SnapshotV4,
} from '../lib/projectSnapshotTypes.js'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { app } from '../app.js'
// Override the global prisma mock from setup.ts with the real module
// so HTTP route handlers read/write real PostgreSQL in this integration test.
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
let extraTemplateId: string | undefined
beforeAll(async () => {
  if (!runIntegration) return
  prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
  })
  await prisma.$connect()

  const user = await prisma.user.create({
    data: {
      email: `snapshot-rollback-test-${Date.now()}@example.com`,
      name: 'Snapshot Rollback Integration Test',
      password: '$2b$10$placeholder',
    },
  })
  userId = user.id
  token = jwt.sign({ userId, role: 'USER' }, process.env.JWT_SECRET!)
  authHeader = `Bearer ${token}`
})

afterAll(async () => {
  if (!runIntegration) return
  await prisma.backlogSnapshot.deleteMany({ where: { project: { ownerId: userId } } })
  await prisma.capacitySegment.deleteMany({
    where: { capacityProfile: { project: { ownerId: userId } } },
  })
  await prisma.capacityProfile.deleteMany({ where: { project: { ownerId: userId } } })
  await prisma.projectOverhead.deleteMany({ where: { project: { ownerId: userId } } })
  await prisma.projectDiscount.deleteMany({ where: { project: { ownerId: userId } } })
  await prisma.timelineEntry.deleteMany({ where: { project: { ownerId: userId } } })
  await prisma.storyTimelineEntry.deleteMany({ where: { project: { ownerId: userId } } })
  await prisma.epicDependency.deleteMany({ where: { epic: { project: { ownerId: userId } } } })
  await prisma.featureDependency.deleteMany({
    where: { feature: { epic: { project: { ownerId: userId } } } },
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
  if (extraTemplateId) {
    await prisma.featureTemplate.delete({ where: { id: extraTemplateId } })
  }
  await prisma.resourceType.deleteMany({ where: { project: { ownerId: userId } } })
  await prisma.project.deleteMany({ where: { ownerId: userId } })
  await prisma.user.delete({ where: { id: userId } })
  await prisma.$disconnect()
})

// ─── Fixture helpers ────────────────────────────────────────────────────────

async function createProject(): Promise<string> {
  const project = await prisma.project.create({
    data: { name: `Snapshot Integration ${Date.now()}`, ownerId: userId },
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
    hoursPerDay: number | null
    dayRate: number | null
  }> = {},
): Promise<string> {
  await prisma.resourceType.create({
    data: {
      id,
      name,
      projectId,
      category: overrides.category ?? 'ENGINEERING',
      count: overrides.count ?? 2,
      hoursPerDay: overrides.hoursPerDay ?? null,
      dayRate: overrides.dayRate ?? null,
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
    pricingModel: string
  }> = {},
): Promise<string> {
  await prisma.namedResource.create({
    data: {
      id,
      resourceTypeId,
      name,
      pricingModel: overrides.pricingModel ?? 'ACTUAL_DAYS',
    },
  })
  return id
}

async function createProfile(
  projectId: string,
  id: string,
  ownerKind: 'ROLE' | 'NAMED_PERSON' | 'PLANNED_RESOURCE',
  resourceTypeId: string | null,
  namedResourceId: string | null,
  overrides: Partial<{
    planningBasis: $Enums.CapacityProfilePlanningBasis
    source: $Enums.CapacityProfileSource
    defaultPercent: number | null
    startWeek: number | null
    endWeek: number | null
  }> = {},
  legacyValue: Prisma.NullableJsonNullValueInput | Prisma.InputJsonValue = Prisma.DbNull,
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
      legacy: legacyValue,
    },
  })
  return id
}

async function createSegment(
  profileId: string,
  id: string,
  startWeek: number,
  endWeek: number,
  capacityPercent: number,
  source: $Enums.CapacityProfileSource = 'MANUAL',
): Promise<void> {
  await prisma.capacitySegment.create({
    data: {
      id,
      capacityProfileId: profileId,
      startWeek,
      endWeek,
      capacityPercent,
      source,
    },
  })
}

async function createDiscount(
  projectId: string,
  resourceTypeId: string | null,
  type: 'PERCENTAGE' | 'FIXED_AMOUNT',
  value: number,
  label: string,
  order: number,
): Promise<string> {
  const discount = await prisma.projectDiscount.create({
    data: { projectId, resourceTypeId, type, value, label, order },
  })
  return discount.id
}

interface CommercialParity {
  rows: Array<{
    id: string
    name: string
    kind: 'resource' | 'named-resource' | 'overhead'
    resourceTypeId: string
    subtotal: number
    netSubtotal: number
    appliedDiscounts: Array<{
      id: string
      resourceTypeId: string | null
      calculatedAmount: number
    }>
  }>
  subtotal: number
  projectDiscounts: Array<{
    id: string
    resourceTypeId: string | null
    calculatedAmount: number
  }>
  totalProjectDiscount: number
  afterDiscounts: number
  grandTotal: number
}

function normalizeCommercialParity(data: CommercialParity): CommercialParity {
  return {
    ...data,
    rows: data.rows.map(row => row.kind === 'overhead'
      ? {
          ...row,
          // V3 snapshots intentionally omit ProjectOverhead IDs, so rollback
          // recreates this row with a new ID. Compare overheads by stable name.
          id: `overhead:${row.name}`,
          resourceTypeId: `overhead:${row.name}`,
        }
      : row),
  }
}

async function computeCommercialData(
  profile: unknown,
  discounts: unknown[],
  project: { taxRate: number | null; taxLabel: string },
): Promise<CommercialParity> {
  const modulePath = new URL('../../../client/src/utils/financialCalculations.ts', import.meta.url).href
  const clientCalculations = await import(modulePath)
  return clientCalculations.computeCommercialData(
    profile as never,
    discounts as never,
    project,
  ) as CommercialParity
}

/**
 * Canonical state type for deep comparison after v3 rollback.
 */
interface CanonicalProfileRow {
  id: string
  ownerKind: string
  resourceTypeId: string | null
  namedResourceId: string | null
  planningBasis: string
  source: string
  defaultPercent: number | null
  startWeek: number | null
  endWeek: number | null
  legacy: unknown
  segments: Array<{ id: string; startWeek: number; endWeek: number; capacityPercent: number; source: string }>
}


interface CanonicalProjectState {
  resourceTypes: Array<{ id: string; name: string; category: string; count: number; hoursPerDay: number | null; dayRate: number | null; globalTypeId: string | null }>
  // Issue #418: candidate legacy capacity columns no longer exist — restore
  // never writes them, so canonical comparisons exclude them.
  namedResources: Array<{ id: string; resourceTypeId: string; name: string; pricingModel: string }>
  capacityProfiles: CanonicalProfileRow[]
  timelineEntries: Array<{ startWeek: number; durationWeeks: number; isManual: boolean }>
  storyTimelineEntries: Array<{ startWeek: number; durationWeeks: number; isManual: boolean }>
  overheadItems: Array<{ name: string; type: string; value: number; resourceTypeId: string | null; order: number }>
  dbNullProfileIds: string[]
}

/**
 * Strip database-managed timestamps from raw Prisma rows so canonical
 * comparisons compare only restorable business fields.
 */
function stripTimestamps<T extends Record<string, unknown>>(row: T): Omit<T, 'createdAt' | 'updatedAt'> {
  const { createdAt: _createdAt, updatedAt: _updatedAt, ...rest } = row
  return rest as Omit<T, 'createdAt' | 'updatedAt'>
}

async function captureCanonicalState(projectId: string): Promise<CanonicalProjectState> {
  const [resourceTypes, namedResources, capacityProfiles, timelineEntries, storyTimelineEntries, overheadItems] = await Promise.all([
    prisma.resourceType.findMany({ where: { projectId }, orderBy: { id: 'asc' } }),
    prisma.namedResource.findMany({ where: { resourceType: { projectId } }, orderBy: { id: 'asc' } }),
    prisma.capacityProfile.findMany({
      where: { projectId },
      include: { segments: { orderBy: { startWeek: 'asc' as const } } },
      orderBy: [{ ownerKind: 'asc' as const }, { id: 'asc' as const }],
    }),
    prisma.timelineEntry.findMany({ where: { projectId }, orderBy: { id: 'asc' } }),
    prisma.storyTimelineEntry.findMany({ where: { projectId }, orderBy: { id: 'asc' } }),
    prisma.projectOverhead.findMany({ where: { projectId }, orderBy: { id: 'asc' } }),
  ])
  const dbNullIds = Array.from(await detectDbNullProfileIds(projectId))
  return {
    resourceTypes,
    // Issue #418: the candidate legacy capacity columns no longer exist —
    // restore never writes them, so canonical comparisons exclude them.
    namedResources: namedResources.map(nr => {
      const { ...rest } = stripTimestamps(nr)
      return { id: rest.id, resourceTypeId: rest.resourceTypeId, name: rest.name, pricingModel: rest.pricingModel }
    }),
    capacityProfiles: capacityProfiles.map(p => ({
      ...stripTimestamps(p),
      segments: p.segments.map(s => stripTimestamps(s)),
    })),
    timelineEntries: timelineEntries.map(e => ({ startWeek: e.startWeek, durationWeeks: e.durationWeeks, isManual: e.isManual })),
    storyTimelineEntries: storyTimelineEntries.map(e => ({ startWeek: e.startWeek, durationWeeks: e.durationWeeks, isManual: e.isManual })),
    overheadItems: overheadItems.map(o => ({ name: o.name, type: o.type, value: o.value, resourceTypeId: o.resourceTypeId, order: o.order })),
    dbNullProfileIds: dbNullIds,
  }
}


async function createEpicBacklog(
  projectId: string,
  rtId: string,
  featureTemplateId: string | null,
): Promise<{ epicId: string; featureId: string; storyId: string }> {
  const epic = await prisma.epic.create({
    data: { name: 'Epic Alpha', projectId, order: 0 },
  })
  const feature = await prisma.feature.create({
    data: { name: 'Feature One', epicId: epic.id, order: 0 },
  })
  const story = await prisma.userStory.create({
    data: {
      name: 'Story A',
      featureId: feature.id,
      order: 0,
      appliedTemplateId: featureTemplateId,
    },
  })
  await prisma.task.create({
    data: {
      name: 'Task 1',
      userStoryId: story.id,
      order: 0,
      hoursEffort: 8,
      resourceTypeId: rtId,
    },
  })
  return { epicId: epic.id, featureId: feature.id, storyId: story.id }
}


/**
 * Run a raw SQL query to detect which capacity profiles have database-NULL
 * legacy (as opposed to JSON null). Returns a Set of profile IDs where
 * legacy IS NULL at the storage level.
 */
async function detectDbNullProfileIds(projectId: string): Promise<Set<string>> {
  const rows = await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT cp.id FROM "CapacityProfile" cp WHERE cp."projectId" = ${projectId} AND cp.legacy IS NULL
  `)
  const seen = new Set<string>()
  for (const r of rows) {
    seen.add(r.id)
  }
  return seen
}


async function createV1Snapshot(
  projectId: string,
  epics: SnapshotV1,
): Promise<string> {
  const snap = await prisma.backlogSnapshot.create({
    data: {
      projectId,
      label: 'v1 snapshot',
      trigger: 'manual',
      snapshot: epics as unknown as object,
      createdById: userId,
    },
  })
  return snap.id
}

// ═════════════════════════════════════════════════════════════════════════════
// Scenario A — exact v3 round trip with full canonical state
// ═════════════════════════════════════════════════════════════════════════════

describeIf('Scenario A — v3 round trip with full canonical state', () => {
  let projectId: string
  let snapshotId: string
  let rtDevId: string
  let rtDesId: string
  let extraRtId: string
  let extraNrId: string
  let extraProfileId: string
  let nrAliceId: string
  let nrCharlieId: string
  let nrDaveId: string
  let profileRoleId: string
  let profileNamedId: string
  let profilePlannedId: string
  let profilePlannedNrId: string
  let segmentRole1: string
  let segmentRole2: string
  let segmentNamed1: string
  let segmentPlanned1: string
  let segmentPlanned2: string
  let segmentPlanned3: string
  let nrEveId: string
  let nrFrankId: string
  let nrGraceId: string
  let nrHeidiId: string
  let profileJsonNullId: string
  let profileNestedObjId: string
  let profileArrayNullId: string
  let profileStringId: string
  let profileBoolId: string
  let segmentJsonNull1: string
  let segmentNestedObj1: string
  let segmentArrayNull1: string
  let segmentString1: string
  let segmentBool1: string
  let projectDiscountId: string
  let targetRoleDiscountId: string
  let extraRoleDiscountId: string
  let commercialBefore: CommercialParity
  let canonicalBefore: CanonicalProjectState
  // HTTP response snapshots for read-parity assertions
  let resourceProfileBefore: unknown
  let timelineBefore: unknown
  // B-state HTTP response snapshots (after mutation, before rollback)
  let resourceProfileAfterMutation: unknown
  let timelineAfterMutation: unknown

  beforeAll(async () => {
    if (!runIntegration) return
    projectId = await createProject()

    // ── 2 resource types with exact IDs ───────────────────────────
    rtDevId = await createResourceType(projectId, 'rt-dev', 'Developer', {
      dayRate: 500,
    })
    rtDesId = await createResourceType(projectId, 'rt-des', 'Designer', {
      dayRate: 450,
    })

    // ── 2 named resources with exact IDs ──────────────────────────
    nrAliceId = await createNamedResource(
      projectId, rtDevId, 'nr-alice', 'Alice',
      { pricingModel: 'ACTUAL_DAYS' },
    )
    await createNamedResource(
      projectId, rtDesId, 'nr-bob', 'Bob',
      { pricingModel: 'FIXED_PRICE' },
    )
    // Profile-first (issue #418): every named resource must carry a profile —
    // missing owner state fails closed, so Bob gets a legacy-shaped profile.
    await createProfile(
      projectId, 'prof-bob', 'NAMED_PERSON', null, 'nr-bob',
      {
        planningBasis: 'AVAILABILITY_WINDOW',
        source: 'AVAILABILITY_WINDOW',
        defaultPercent: 100,
        startWeek: null,
        endWeek: null,
      },
      { allocationMode: 'TIMELINE', allocationPercent: 100 },
    )
    // ── 3rd named resource for PLANNED_RESOURCE ownership ──────────
    nrCharlieId = await createNamedResource(
      projectId, rtDevId, 'nr-charlie', 'Charlie',
      { pricingModel: 'FIXED_PRICE' },
    )
    // ── 4th named resource for synthetic PLANNED_RESOURCE ownership ──
    nrDaveId = await createNamedResource(
      projectId, rtDevId, 'nr-dave', 'Dave',
      { pricingModel: 'FIXED_PRICE' },
    )

    // ── ROLE profile for Developer — DB_NULL legacy ───────────────
    // Segmented profile → CAPACITY_PROFILE (DEMAND_FOLLOWING forbids segments
    // under the single authoritative structural rule set).
    profileRoleId = await createProfile(
      projectId, 'prof-role', 'ROLE', rtDevId, null,
      {
        planningBasis: 'CAPACITY_PROFILE',
        source: 'MANUAL',
        defaultPercent: null,
        startWeek: null,
        endWeek: null,
      },
      Prisma.DbNull,
    )
    segmentRole1 = 'seg-role-1'
    segmentRole2 = 'seg-role-2'
    await createSegment(profileRoleId, segmentRole1, 0, 4, 100)
    await createSegment(profileRoleId, segmentRole2, 5, 10, 50)

    // ── NAMED_PERSON profile for Alice — VALUE(object) legacy ─────
    profileNamedId = await createProfile(
      projectId, 'prof-named', 'NAMED_PERSON', null, nrAliceId,
      {
        planningBasis: 'CAPACITY_PROFILE',
        source: 'SQUAD_PLANNER',
        defaultPercent: 100,
        startWeek: 2,
        endWeek: 8,
      },
      { allocationMode: 'EFFORT', allocationPercent: 80 },
    )
    segmentNamed1 = 'seg-named-1'
    await createSegment(profileNamedId, segmentNamed1, 2, 5, 100)

    // ── PLANNED_RESOURCE (synthetic) — VALUE(number) legacy ───────
    // Discontinuous and overlapping segments to test fidelity (>100% is
    // illegal app state for non-ROLE owners under the single rule set).
    profilePlannedId = await createProfile(
      projectId, 'prof-planned', 'PLANNED_RESOURCE', null, nrDaveId,
      {
        planningBasis: 'CAPACITY_PROFILE',
        source: 'DERIVED',
        defaultPercent: null,
        startWeek: null,
        endWeek: null,
      },
      42,
    )
    segmentPlanned1 = 'seg-planned-1'
    segmentPlanned2 = 'seg-planned-2'
    segmentPlanned3 = 'seg-planned-3'
    await createSegment(profilePlannedId, segmentPlanned1, 0, 1, 100)
    await createSegment(profilePlannedId, segmentPlanned2, 3, 6, 75)
    await createSegment(profilePlannedId, segmentPlanned3, 8, 8, 25)
    // ── PLANNED_RESOURCE with persisted named resource (Charlie) ──
    profilePlannedNrId = await createProfile(
      projectId, 'prof-planned-nr', 'PLANNED_RESOURCE', null, nrCharlieId,
      {
        planningBasis: 'CAPACITY_PROFILE',
        source: 'DERIVED',
        defaultPercent: null,
        startWeek: null,
        endWeek: null,
      },
      Prisma.DbNull,
    )
    await createSegment(profilePlannedNrId, 'seg-planned-nr-1', 0, 2, 100)
    await createSegment(profilePlannedNrId, 'seg-planned-nr-2', 3, 5, 75)
    await createSegment(profilePlannedNrId, 'seg-planned-nr-3', 6, 10, 50)

    // ══════════════════════════════════════════════════════════════
    // NEW: 5 additional capacity profiles for all 7 legacy JSON states
    // ══════════════════════════════════════════════════════════════

    // ── 4 more named resources for new profiles ───────────────────
    nrEveId = await createNamedResource(
      projectId, rtDevId, 'nr-eve', 'Eve',
      { pricingModel: 'FIXED_PRICE' },
    )
    nrFrankId = await createNamedResource(
      projectId, rtDevId, 'nr-frank', 'Frank',
      { pricingModel: 'FIXED_PRICE' },
    )
    nrGraceId = await createNamedResource(
      projectId, rtDevId, 'nr-grace', 'Grace',
      { pricingModel: 'FIXED_PRICE' },
    )
    nrHeidiId = await createNamedResource(
      projectId, rtDevId, 'nr-heidi', 'Heidi',
      { pricingModel: 'FIXED_PRICE' },
    )

    // ── (1) ROLE for Designer — JSON_NULL legacy ──────────────────
    profileJsonNullId = await createProfile(
      projectId, 'prof-json-null', 'ROLE', rtDesId, null,
      { planningBasis: 'CAPACITY_PROFILE', source: 'MANUAL' },
      Prisma.JsonNull,
    )
    segmentJsonNull1 = 'seg-json-null-1'
    await createSegment(profileJsonNullId, segmentJsonNull1, 3, 7, 80)

    // ── (2) NAMED_PERSON for Eve — VALUE(nested-null object) legacy ──
    // Windowed AND segmented → CAPACITY_PROFILE under the single structural
    // rule set (AVAILABILITY_WINDOW forbids segments).
    profileNestedObjId = await createProfile(
      projectId, 'prof-nested-obj', 'NAMED_PERSON', null, nrEveId,
      {
        planningBasis: 'CAPACITY_PROFILE',
        source: 'SQUAD_PLANNER',
        defaultPercent: 50,
        startWeek: 1,
        endWeek: 6,
      },
      { nested: { value: null, items: [1, null, 3] }, mode: null },
    )
    segmentNestedObj1 = 'seg-nested-obj-1'
    await createSegment(profileNestedObjId, segmentNestedObj1, 1, 4, 100)

    // ── (3) PLANNED_RESOURCE for Frank — VALUE(null-containing array) legacy ──
    profileArrayNullId = await createProfile(
      projectId, 'prof-array-null', 'PLANNED_RESOURCE', null, nrFrankId,
      {
        planningBasis: 'CAPACITY_PROFILE',
        source: 'DERIVED',
        defaultPercent: null,
        startWeek: null,
        endWeek: null,
      },
      [1, null, 'text', null, false],
    )
    segmentArrayNull1 = 'seg-array-null-1'
    await createSegment(profileArrayNullId, segmentArrayNull1, 4, 8, 60)

    // ── (4) PLANNED_RESOURCE for Grace — VALUE(string) legacy ─────
    profileStringId = await createProfile(
      projectId, 'prof-string', 'PLANNED_RESOURCE', null, nrGraceId,
      {
        planningBasis: 'CAPACITY_PROFILE',
        source: 'DERIVED',
        defaultPercent: null,
        startWeek: null,
        endWeek: null,
      },
      'hello-world',
    )
    segmentString1 = 'seg-string-1'
    await createSegment(profileStringId, segmentString1, 0, 2, 100)

    // ── (5) PLANNED_RESOURCE for Heidi — VALUE(boolean) legacy ────
    profileBoolId = await createProfile(
      projectId, 'prof-bool', 'PLANNED_RESOURCE', null, nrHeidiId,
      {
        planningBasis: 'CAPACITY_PROFILE',
        source: 'DERIVED',
        defaultPercent: null,
        startWeek: null,
        endWeek: null,
      },
      true,
    )
    segmentBool1 = 'seg-bool-1'
    await createSegment(profileBoolId, segmentBool1, 2, 5, 75)

    // ── Full backlog ──────────────────────────────────────────────
    const backlog = await createEpicBacklog(projectId, rtDevId, null)
    // Add a second task under Designer RT so the Designer resource type
    // appears in Resource Profile / Timeline responses with Bob.
    await prisma.task.create({
      data: {
        name: 'Task 2 (Designer)',
        userStoryId: backlog.storyId,
        order: 1,
        hoursEffort: 16,
        resourceTypeId: rtDesId,
      },
    })

    // ── Timeline entries ──────────────────────────────────────────
    const epics = await prisma.epic.findMany({
      where: { projectId },
      include: { features: { include: { userStories: true } } },
    })
    const feature = epics[0].features[0]
    const story = feature.userStories[0]
    await prisma.timelineEntry.create({
      data: {
        projectId, featureId: feature.id,
        startWeek: 1, durationWeeks: 8, isManual: false,
      },
    })
    await prisma.storyTimelineEntry.create({
      data: {
        projectId, storyId: story.id,
        startWeek: 2, durationWeeks: 5, isManual: false,
      },
    })

    // ── Overhead item ─────────────────────────────────────────────
    await prisma.projectOverhead.create({
      data: {
        projectId, name: 'Governance',
        type: 'PERCENTAGE', value: 15,
        resourceTypeId: rtDevId, order: 0,
      },
    })

    // ── Baseline discounts: project-wide plus target-role ─────────
    projectDiscountId = await createDiscount(
      projectId, null, 'PERCENTAGE', 5, 'Project-wide baseline', 0,
    )
    targetRoleDiscountId = await createDiscount(
      projectId, rtDevId, 'PERCENTAGE', 10, 'Developer baseline', 1,
    )

    // ── Build and persist snapshot ────────────────────────────────
    const data = await buildSnapshot(projectId, prisma)
    const snap = await prisma.backlogSnapshot.create({
      data: {
        projectId,
        label: 'Scenario A snapshot',
        trigger: 'manual',
        snapshot: data as unknown as object,
        createdById: userId,
      },
    })
    snapshotId = snap.id
    canonicalBefore = await captureCanonicalState(projectId)
    expect(canonicalBefore.resourceTypes).toHaveLength(2)
    expect(canonicalBefore.capacityProfiles).toHaveLength(10)

    // ── Capture Resource Profile & Timeline HTTP responses before mutation ──
    const rpBefore = await request(app)
      .get(`/api/projects/${projectId}/resource-profile`)
      .set('Authorization', authHeader)
      .expect(200)
    resourceProfileBefore = rpBefore.body
    const tlBefore = await request(app)
      .get(`/api/projects/${projectId}/timeline`)
      .set('Authorization', authHeader)
      .expect(200)
    timelineBefore = tlBefore.body
    expect(resourceProfileBefore).toHaveProperty('resourceRows')
    expect(timelineBefore).toHaveProperty('entries')

    const projectTax = await prisma.project.findUnique({
      where: { id: projectId },
      select: { taxRate: true, taxLabel: true },
    })
    if (!projectTax) throw new Error('Scenario A project missing tax settings')
    const discountsBefore = await prisma.projectDiscount.findMany({
      where: { projectId },
      orderBy: { order: 'asc' },
    })
    commercialBefore = await computeCommercialData(resourceProfileBefore, discountsBefore, projectTax)
    expect(commercialBefore.projectDiscounts.map(d => d.id)).toEqual([projectDiscountId])
    const baselineTargetRow = commercialBefore.rows.find(r => r.resourceTypeId === rtDevId)
    expect(baselineTargetRow?.appliedDiscounts.map(d => d.id)).toContain(targetRoleDiscountId)
  })

  it('captured snapshot has all domains and exact values', async () => {
    const raw = await prisma.backlogSnapshot.findUnique({ where: { id: snapshotId } })
    expect(raw).not.toBeNull()
    // Snapshots are emitted as v4 since issue #418 (candidate legacy columns
    // omitted; capacity state lives in capacityProfiles).
    const data = raw!.snapshot as unknown as SnapshotV4
    expect(data.schemaVersion).toBe(4)

    // Resource types
    expect(data.resourceTypes).toHaveLength(2)
    expect(data.resourceTypes[0].id).toBe(rtDevId)

    // Named resources
    expect(data.namedResources).toHaveLength(8)
    const alice = data.namedResources.find(n => n.name === 'Alice')
    expect(alice).toBeDefined()
    expect(alice!.pricingModel).toBe('ACTUAL_DAYS')

    // Ten profiles (4 original + 5 new covering all 7 legacy JSON states +
    // Bob's legacy-shaped named-person profile)
    expect(data.capacityProfiles).toHaveLength(10)

    // ROLE — DB_NULL, 2 segments
    const roleP = data.capacityProfiles.find(p => p.id === profileRoleId)
    expect(roleP).toBeDefined()
    expect(roleP!.id).toBe(profileRoleId)
    expect(roleP!.resourceTypeId).toBe(rtDevId)
    expect(roleP!.planningBasis).toBe('CAPACITY_PROFILE')
    expect(roleP!.source).toBe('MANUAL')
    expect(roleP!.defaultPercent).toBeNull()
    expect(roleP!.legacy.kind).toBe('DB_NULL')
    expect(roleP!.segments).toHaveLength(2)
    expect(roleP!.segments[0].startWeek).toBe(0)
    expect(roleP!.segments[1].capacityPercent).toBe(50)

    // NAMED_PERSON — VALUE(object), 1 segment
    const namedP = data.capacityProfiles.find(p => p.id === profileNamedId)
    expect(namedP).toBeDefined()
    expect(namedP!.id).toBe(profileNamedId)
    expect(namedP!.namedResourceId).toBe(nrAliceId)
    expect(namedP!.legacy.kind).toBe('VALUE')
    if (namedP!.legacy.kind === 'VALUE') {
      const val = namedP!.legacy.value as Record<string, unknown>
      expect(val.allocationMode).toBe('EFFORT')
    }
    expect(namedP!.segments).toHaveLength(1)

    // PLANNED_RESOURCE — VALUE(number), 3 segments
    const plannedP = data.capacityProfiles.find(p => p.id === profilePlannedId)
    expect(plannedP).toBeDefined()
    expect(plannedP!.ownerKind).toBe('PLANNED_RESOURCE')
    expect(plannedP!.legacy.kind).toBe('VALUE')
    if (plannedP!.legacy.kind === 'VALUE') {
      expect(plannedP!.legacy.value).toBe(42)
    }
    expect(plannedP!.segments).toHaveLength(3)
    expect(plannedP!.segments[0].capacityPercent).toBe(100)
    expect(plannedP!.segments[2].startWeek).toBe(8)
    expect(plannedP!.segments[2].endWeek).toBe(8)


    // ── (5 new) JSON_NULL (ROLE/Designer) — 1 segment ──────────────
    const jsonNullP = data.capacityProfiles.find(p => p.id === profileJsonNullId)
    expect(jsonNullP).toBeDefined()
    expect(jsonNullP!.ownerKind).toBe('ROLE')
    expect(jsonNullP!.resourceTypeId).toBe(rtDesId)
    expect(jsonNullP!.legacy.kind).toBe('JSON_NULL')
    expect(jsonNullP!.segments).toHaveLength(1)
    expect(jsonNullP!.segments[0].startWeek).toBe(3)
    expect(jsonNullP!.segments[0].capacityPercent).toBe(80)

    // ── (6) NAMED_PERSON (Eve) — VALUE(nested-null object) legacy ──
    const nestedP = data.capacityProfiles.find(p => p.id === profileNestedObjId)
    expect(nestedP).toBeDefined()
    expect(nestedP!.ownerKind).toBe('NAMED_PERSON')
    expect(nestedP!.namedResourceId).toBe(nrEveId)
    expect(nestedP!.legacy.kind).toBe('VALUE')
    if (nestedP!.legacy.kind === 'VALUE') {
      const val = nestedP!.legacy.value as Record<string, unknown>
      expect(val).toHaveProperty('nested')
      const nested = val.nested as Record<string, unknown>
      expect(nested.value).toBeNull()
      expect((nested.items as unknown[])[0]).toBe(1)
      expect((nested.items as unknown[])[1]).toBeNull()
      expect(nested.items).toHaveLength(3)
      expect(val.mode).toBeNull()
    }
    expect(nestedP!.segments).toHaveLength(1)

    // ── (7) PLANNED_RESOURCE (Frank) — VALUE(null-containing array) legacy ──
    const arrayNullP = data.capacityProfiles.find(p => p.id === profileArrayNullId)
    expect(arrayNullP).toBeDefined()
    expect(arrayNullP!.ownerKind).toBe('PLANNED_RESOURCE')
    expect(arrayNullP!.legacy.kind).toBe('VALUE')
    if (arrayNullP!.legacy.kind === 'VALUE') {
      const arr = arrayNullP!.legacy.value as unknown[]
      expect(arr[0]).toBe(1)
      expect(arr[1]).toBeNull()
      expect(arr[2]).toBe('text')
      expect(arr[3]).toBeNull()
      expect(arr[4]).toBe(false)
      expect(arr).toHaveLength(5)
    }
    expect(arrayNullP!.segments).toHaveLength(1)

    // ── (8) PLANNED_RESOURCE (Grace) — VALUE(string) legacy ──────
    const stringP = data.capacityProfiles.find(p => p.id === profileStringId)
    expect(stringP).toBeDefined()
    expect(stringP!.ownerKind).toBe('PLANNED_RESOURCE')
    expect(stringP!.legacy.kind).toBe('VALUE')
    if (stringP!.legacy.kind === 'VALUE') {
      expect(stringP!.legacy.value).toBe('hello-world')
    }
    expect(stringP!.segments).toHaveLength(1)

    // ── (9) PLANNED_RESOURCE (Heidi) — VALUE(boolean) legacy ────
    const boolP = data.capacityProfiles.find(p => p.id === profileBoolId)
    expect(boolP).toBeDefined()
    expect(boolP!.ownerKind).toBe('PLANNED_RESOURCE')
    expect(boolP!.legacy.kind).toBe('VALUE')
    if (boolP!.legacy.kind === 'VALUE') {
      expect(boolP!.legacy.value).toBe(true)
    }
    expect(boolP!.segments).toHaveLength(1)
    // Backlog, timeline, overhead present
    expect(data.epics).toHaveLength(1)
    expect(data.epics[0].features).toHaveLength(1)
    expect(data.timelineEntries).toHaveLength(1)
    expect(data.storyTimelineEntries).toHaveLength(1)
    expect(data.overheadItems).toHaveLength(1)
    expect(data.overheadItems[0].name).toBe('Governance')
  })

  it('mutates all domains then rollback restores exact original state', async () => {
    // ── Mutate every captured domain ──────────────────────────────

    // Add post-snapshot owners, compatibility metadata, a profile, and a discount.
    // V3 rollback preserves resource types and compatibility rows while replacing
    // captured profiles and pruning named resources created after the snapshot.
    extraRtId = await createResourceType(projectId, 'rt-extra', 'Post-snapshot role', {
      count: 1,
      hoursPerDay: 8,
      dayRate: 700,
    })
    extraNrId = await createNamedResource(projectId, extraRtId, 'nr-extra', 'Post-snapshot person', {})
    // Profile-first (issue #418): every owner must carry a profile.
    await createProfile(
      projectId, 'prof-extra-nr', 'NAMED_PERSON', null, 'nr-extra',
      {
        planningBasis: 'AVAILABILITY_WINDOW',
        source: 'AVAILABILITY_WINDOW',
        defaultPercent: 45,
        startWeek: 2,
        endWeek: 7,
      },
      Prisma.DbNull,
    )
    extraProfileId = await createProfile(
      projectId, 'prof-extra-owner', 'ROLE', extraRtId, null,
      {
        planningBasis: 'CAPACITY_PROFILE',
        source: 'MANUAL',
        defaultPercent: 45,
        startWeek: 2,
        endWeek: 7,
      },
      Prisma.DbNull,
    )
    await createSegment(extraProfileId, 'seg-extra-owner', 2, 7, 45)

    extraRoleDiscountId = await createDiscount(
      projectId, extraRtId, 'PERCENTAGE', 20, 'Post-snapshot role discount', 2,
    )
    const extraTemplate = await prisma.featureTemplate.create({
      data: {
        name: `Snapshot extra owner template ${Date.now()}`,
        category: 'DEV',
      },
    })
    extraTemplateId = extraTemplate.id
    await prisma.templateTask.create({
      data: {
        name: 'Post-snapshot template task',
        order: 0,
        hoursSmall: 8,
        hoursMedium: 8,
        hoursLarge: 8,
        resourceTypeName: 'Post-snapshot role',
        templateId: extraTemplate.id,
        resourceTypeId: extraRtId,
      },
    })

    // Delete ROLE segments, add new ones
    await prisma.capacitySegment.deleteMany({ where: { capacityProfileId: profileRoleId } })
    await createSegment(profileRoleId, 'seg-mutated-1', 10, 15, 30)

    // Change NAMED_PERSON profile fields for B-state (different startWeek/endWeek, 50% segment)
    await prisma.capacityProfile.update({
      where: { id: profileNamedId },
      data: { defaultPercent: 50, startWeek: 1, endWeek: 6 },
    })
    await prisma.capacitySegment.update({
      where: { id: segmentNamed1 },
      data: { startWeek: 1, endWeek: 6, capacityPercent: 50 },
    })

    // Mutate PLANNED_RESOURCE profile (issue #418: deleting an owner's only
    // profile would leave fail-closed integrity state; the rollback still
    // restores the original captured profile). DEMAND_FOLLOWING forbids
    // segments, so the mutated state is segmentless.
    await prisma.capacitySegment.deleteMany({
      where: { capacityProfileId: profilePlannedId },
    })
    await prisma.capacityProfile.update({
      where: { id: profilePlannedId },
      data: { planningBasis: 'DEMAND_FOLLOWING', defaultPercent: 90 },
    })
    // Create an extra profile not in the snapshot (use NAMED_PERSON with temp NR to avoid owner FK conflict)
    const tempExtraNr = await createNamedResource(
      projectId, rtDesId, 'nr-temp-extra', 'Temp Extra',
    )
    await createProfile(
      projectId, 'prof-extra', 'NAMED_PERSON', null, tempExtraNr,
      { defaultPercent: 100 },
      Prisma.DbNull,
    )
    // Mutate backlog: delete and create new epics
    await prisma.epic.deleteMany({ where: { projectId } })
    const newEpic = await prisma.epic.create({
      data: { name: 'Mutated Epic', projectId, order: 0 },
    })
    const newFeature = await prisma.feature.create({
      data: { name: 'Mutated Feature', epicId: newEpic.id, order: 0 },
    })
    const newStory = await prisma.userStory.create({
      data: { name: 'Mutated Story', featureId: newFeature.id, order: 0 },
    })
    await prisma.task.create({
      data: {
        name: 'Post-snapshot role task',
        userStoryId: newStory.id,
        order: 99,
        hoursEffort: 8,
        resourceTypeId: extraRtId,
      },
    })
    await prisma.task.create({
      data: {
        name: 'Mutated Task',
        userStoryId: newStory.id,
        order: 0,
        hoursEffort: 8,
        resourceTypeId: rtDevId,
      },
    })
    await prisma.timelineEntry.deleteMany({ where: { projectId } })
    await prisma.storyTimelineEntry.deleteMany({ where: { projectId } })

    // Clear overhead
    await prisma.projectOverhead.deleteMany({ where: { projectId } })

    // Rename resource type
    await prisma.resourceType.update({
      where: { id: rtDevId },
      data: { name: 'Dev Mutated' },
    })

    // ── Mutate capacity profiles for B-state ────────────────────────

    // JSON_NULL profile: change segments and field values
    await prisma.capacitySegment.deleteMany({
      where: { capacityProfileId: profileJsonNullId },
    })
    await createSegment(profileJsonNullId, 'seg-json-mut', 10, 12, 50)
    await prisma.capacityProfile.update({
      where: { id: profileJsonNullId },
      data: { planningBasis: 'CAPACITY_PROFILE', startWeek: 5, endWeek: 10 },
    })

    // Nested-null object profile: change segments and field values
    await prisma.capacitySegment.deleteMany({
      where: { capacityProfileId: profileNestedObjId },
    })
    await createSegment(profileNestedObjId, 'seg-nested-mut', 0, 2, 100)
    await prisma.capacityProfile.update({
      where: { id: profileNestedObjId },
      data: { defaultPercent: 80, startWeek: 2, endWeek: 8 },
    })

    // Null-containing array profile: drop segments AND move to a
    // segmentless-valid basis (segmentless CAPACITY_PROFILE is restricted to
    // the canonical zero-capacity PLANNED_RESOURCE state).
    await prisma.capacitySegment.deleteMany({
      where: { capacityProfileId: profileArrayNullId },
    })
    await prisma.capacityProfile.update({
      where: { id: profileArrayNullId },
      data: {
        planningBasis: 'AVAILABILITY_WINDOW',
        source: 'AVAILABILITY_WINDOW',
        defaultPercent: 60,
      },
    })

    // String legacy profile: mutate in place (issue #418 — owner must stay
    // profiled; the rollback restores the original values).
    await prisma.capacitySegment.deleteMany({
      where: { capacityProfileId: profileStringId },
    })
    await createSegment(profileStringId, 'seg-string-mut', 3, 5, 60)
    await prisma.capacityProfile.update({
      where: { id: profileStringId },
      data: { defaultPercent: 80 },
    })

    // Boolean legacy profile: change fields, drop its segment (a
    // segmentless-valid basis must not carry segments)
    await prisma.capacitySegment.deleteMany({
      where: { capacityProfileId: profileBoolId },
    })
    await prisma.capacityProfile.update({
      where: { id: profileBoolId },
      data: {
        planningBasis: 'AVAILABILITY_WINDOW',
        source: 'AVAILABILITY_WINDOW',
        defaultPercent: 50,
      },
    })

    // ── Capture B-state HTTP responses (after mutations, before rollback) ──
    const rpBRes = await request(app)
      .get(`/api/projects/${projectId}/resource-profile`)
      .set('Authorization', authHeader)
    if (rpBRes.status !== 200) console.log('RPB409BODY', JSON.stringify(rpBRes.body))
    expect(rpBRes.status).toBe(200)
    const rpB = rpBRes as unknown as { body: unknown }
    resourceProfileAfterMutation = rpB.body
    const tlB = await request(app)
      .get(`/api/projects/${projectId}/timeline`)
      .set('Authorization', authHeader)
      .expect(200)
    timelineAfterMutation = tlB.body
    // Assert B-state timeline derives from Alice's PROFILE, ignoring the
    // mutated candidate columns: CAPACITY_PROFILE/SQUAD_PLANNER projects to
    // CAPACITY_PLAN at defaultPercent 100 within the profile window 2-8.
    // Assert B-state timeline derives from Alice's PROFILE, ignoring the
    // mutated candidate columns: CAPACITY_PROFILE/SQUAD_PLANNER projects to
    // CAPACITY_PLAN at the mutated segment 1-6 @ 50% (single-segment lossless
    // projection — NOT the candidate-column TIMELINE/50/1-6 write).
    const tlBNamedResources = (timelineAfterMutation as Record<string, unknown>).namedResources as Array<Record<string, unknown>>
    const aliceTLB = tlBNamedResources.find(nr => nr.id === nrAliceId)!
    expect(aliceTLB.allocationMode).toBe('CAPACITY_PLAN')
    expect(aliceTLB.allocationPercent).toBe(50)
    expect(aliceTLB.allocationStartWeek).toBe(1)
    expect(aliceTLB.allocationEndWeek).toBe(6)
    // Assert B-state Resource Profile does the same
    const rpBRows = (resourceProfileAfterMutation as Record<string, unknown>).resourceRows as Array<Record<string, unknown>>
    const rpBDevRow = rpBRows.find((r: Record<string, unknown>) => r.resourceTypeId === rtDevId)!
    const rpBDevNrs = rpBDevRow.namedResources as Array<Record<string, unknown>>
    const aliceRPB = rpBDevNrs.find((nr: Record<string, unknown>) => nr.id === nrAliceId)!
    expect(aliceRPB.allocationMode).toBe('CAPACITY_PLAN')
    expect(aliceRPB.allocationPercent).toBe(50)
    expect(aliceRPB.allocationStartWeek).toBe(1)
    expect(aliceRPB.allocationEndWeek).toBe(6)

    const discountsB = await prisma.projectDiscount.findMany({
      where: { projectId },
      orderBy: { order: 'asc' },
    })
    const projectTaxB = await prisma.project.findUnique({
      where: { id: projectId },
      select: { taxRate: true, taxLabel: true },
    })
    if (!projectTaxB) throw new Error('Scenario A project missing tax settings in B-state')
    const commercialB = await computeCommercialData(resourceProfileAfterMutation, discountsB, projectTaxB)
    const extraCommercialRow = commercialB.rows.find(r => r.resourceTypeId === extraRtId)
    expect(extraCommercialRow).toBeDefined()
    expect(extraCommercialRow!.appliedDiscounts.map(d => d.id)).toContain(extraRoleDiscountId)
    expect(commercialB.projectDiscounts.map(d => d.id)).not.toContain(extraRoleDiscountId)
    expect(commercialB.grandTotal).not.toBe(commercialBefore.grandTotal)

    // ── Rollback ──────────────────────────────────────────────────
    // The rollback transaction itself must leave every surviving ResourceType
    // and NamedResource with valid authoritative ownership (issue #418 PR 1
    // review): post-snapshot resource types survive with their validated ROLE
    // profiles preserved atomically — no post-rollback repair runs here.
    await rollbackProjectSnapshot({ projectId, snapshotId, userId, db: prisma })

    // ── Verify exact restoration ──────────────────────────────────

    const discountsAfterRollback = await prisma.projectDiscount.findMany({
      where: { projectId },
      orderBy: { order: 'asc' },
    })
    expect(discountsAfterRollback).toHaveLength(3)
    expect(discountsAfterRollback.map(d => d.id)).toEqual([
      projectDiscountId,
      targetRoleDiscountId,
      extraRoleDiscountId,
    ])
    const restoredProjectDiscount = discountsAfterRollback.find(d => d.id === projectDiscountId)!
    expect(restoredProjectDiscount.resourceTypeId).toBeNull()
    expect(restoredProjectDiscount.label).toBe('Project-wide baseline')
    const restoredTargetDiscount = discountsAfterRollback.find(d => d.id === targetRoleDiscountId)!
    expect(restoredTargetDiscount.resourceTypeId).toBe(rtDevId)
    expect(restoredTargetDiscount.label).toBe('Developer baseline')
    const restoredExtraDiscount = discountsAfterRollback.find(d => d.id === extraRoleDiscountId)!
    expect(restoredExtraDiscount.resourceTypeId).toBe(extraRtId)
    expect(restoredExtraDiscount.label).toBe('Post-snapshot role discount')
    if (!extraTemplateId) throw new Error('Scenario A template fixture missing')
    const preservedTemplateTask = await prisma.templateTask.findFirst({
      where: { templateId: extraTemplateId },
    })
    expect(preservedTemplateTask).toMatchObject({
      resourceTypeId: extraRtId,
      resourceTypeName: 'Post-snapshot role',
    })

    const rpAfterRollback = await request(app)
      .get(`/api/projects/${projectId}/resource-profile`)
      .set('Authorization', authHeader)
      .expect(200)
    const projectTaxAfterRollback = await prisma.project.findUnique({
      where: { id: projectId },
      select: { taxRate: true, taxLabel: true },
    })
    if (!projectTaxAfterRollback) throw new Error('Scenario A project missing tax settings after rollback')
    const commercialAfterRollback = await computeCommercialData(
      rpAfterRollback.body,
      discountsAfterRollback,
      projectTaxAfterRollback,
    )
    expect(normalizeCommercialParity(commercialAfterRollback))
      .toEqual(normalizeCommercialParity(commercialBefore))
    // RTs: IDs preserved, original names restored
    const rts = await prisma.resourceType.findMany({
      where: { projectId },
      orderBy: { name: 'asc' },
    })
    expect(rts).toHaveLength(3)
    expect(rts.find(r => r.id === rtDevId)!.name).toBe('Developer')
    expect(rts.find(r => r.id === extraRtId)).toMatchObject({
      name: 'Post-snapshot role',
      count: 1,
      hoursPerDay: 8,
      dayRate: 700,
    })
    const nrs = await prisma.namedResource.findMany({
      where: { resourceType: { projectId } },
    })

    // Rollback restores the eight named resources captured in the snapshot.
    expect(nrs).toHaveLength(8)
    expect(nrs.find(n => n.id === nrAliceId)!.pricingModel).toBe('ACTUAL_DAYS')
    expect(nrs.find(n => n.id === extraNrId)).toBeUndefined()
    expect(nrs.map(n => n.id).sort()).toEqual([
      'nr-alice',
      'nr-bob',
      'nr-charlie',
      'nr-dave',
      'nr-eve',
      'nr-frank',
      'nr-grace',
      'nr-heidi',
    ])


    const profiles = await prisma.capacityProfile.findMany({
      where: { projectId },
      include: { segments: { orderBy: { startWeek: 'asc' as const } } },
      orderBy: { ownerKind: 'asc' as const },
    })
    // Exactly 10 snapshot profiles restored (4 original + 5 new JSON state
    // profiles + Bob's legacy-shaped profile) plus the preserved ROLE profile
    // of the surviving post-snapshot role (retained atomically by rollback).
    expect(profiles).toHaveLength(11)

    // ── Retained post-snapshot ownership (issue #418 PR 1 review) ──
    // extraRtId survives rollback WITH its valid ROLE profile and exact
    // segment identity — no test-only repair is involved.
    const retainedRole = profiles.find(p => p.id === extraProfileId)!
    expect(retainedRole.ownerKind).toBe('ROLE')
    expect(retainedRole.resourceTypeId).toBe(extraRtId)
    expect(retainedRole.planningBasis).toBe('CAPACITY_PROFILE')
    expect(retainedRole.source).toBe('MANUAL')
    expect(retainedRole.defaultPercent).toBe(45)
    expect(retainedRole.startWeek).toBe(2)
    expect(retainedRole.endWeek).toBe(7)
    expect(retainedRole.segments).toMatchObject([{
      id: 'seg-extra-owner',
      startWeek: 2,
      endWeek: 7,
      capacityPercent: 45,
      source: 'MANUAL',
    }])
    // The retained role's post-snapshot named resource was pruned with its
    // NAMED_PERSON profile (post-snapshot NRs do not survive rollback).
    expect(profiles.find(p => p.id === 'prof-extra-nr')).toBeUndefined()
    // No repair profile exists.
    expect(profiles.find(p => p.id === 'prof-extra-repair')).toBeUndefined()
    // The rollback transaction left valid authoritative ownership: scheduler
    // resolution succeeds with no post-rollback repair.
    const { resolveSchedulerCapacity } = await import('../lib/schedulerCapacityResolver.js')
    const resolved = await resolveSchedulerCapacity(prisma as any, projectId)
    expect(resolved.resourceTypes.find(rt => rt.id === extraRtId)).toBeDefined()
    expect(resolved.resourceTypes.find(rt => rt.id === extraRtId)!.roleSegments).toBeDefined()

    // ROLE profile: exact original values
    const roleRow = profiles.find(p => p.id === profileRoleId)!
    expect(roleRow.ownerKind).toBe('ROLE')
    expect(roleRow.resourceTypeId).toBe(rtDevId)
    expect(roleRow.planningBasis).toBe('CAPACITY_PROFILE')
    expect(roleRow.source).toBe('MANUAL')
    expect(roleRow.defaultPercent).toBeNull()
    expect(roleRow.segments).toHaveLength(2)
    expect(roleRow.segments[0].startWeek).toBe(0)
    expect(roleRow.segments[0].capacityPercent).toBe(100)
    expect(roleRow.segments[1].startWeek).toBe(5)

    // NAMED_PERSON profile
    const namedRow = profiles.find(p => p.id === profileNamedId)!
    expect(namedRow.ownerKind).toBe('NAMED_PERSON')
    expect(namedRow.namedResourceId).toBe(nrAliceId)
    expect(namedRow.planningBasis).toBe('CAPACITY_PROFILE')
    expect(namedRow.defaultPercent).toBe(100)
    expect(namedRow.segments).toHaveLength(1)

    // PLANNED_RESOURCE profile: exact segments restored
    const plannedRow = profiles.find(p => p.id === profilePlannedId)!
    expect(plannedRow.ownerKind).toBe('PLANNED_RESOURCE')
    expect(plannedRow.segments).toHaveLength(3)
    expect(plannedRow.segments[0].capacityPercent).toBe(100)
    expect(plannedRow.segments[2].startWeek).toBe(8)
    expect(plannedRow.segments[2].endWeek).toBe(8)

    // PLANNED_RESOURCE profile with named resource (Charlie): exact segments restored
    const plannedNrRow = profiles.find(p => p.id === profilePlannedNrId)!
    expect(plannedNrRow.ownerKind).toBe('PLANNED_RESOURCE')
    expect(plannedNrRow.namedResourceId).toBe(nrCharlieId)
    expect(plannedNrRow.segments).toHaveLength(3)
    expect(plannedNrRow.segments[0].startWeek).toBe(0)
    expect(plannedNrRow.segments[0].capacityPercent).toBe(100)
    expect(plannedNrRow.segments[2].endWeek).toBe(10)
    expect(plannedNrRow.segments[2].capacityPercent).toBe(50)

    // ── JSON_NULL (ROLE/Designer) profile: exact original values ──
    const jsonNullRow = profiles.find(p => p.id === profileJsonNullId)!
    expect(jsonNullRow.ownerKind).toBe('ROLE')
    expect(jsonNullRow.resourceTypeId).toBe(rtDesId)
    expect(jsonNullRow.planningBasis).toBe('CAPACITY_PROFILE')
    expect(jsonNullRow.source).toBe('MANUAL')
    expect(jsonNullRow.defaultPercent).toBeNull()
    expect(jsonNullRow.startWeek).toBeNull()
    expect(jsonNullRow.endWeek).toBeNull()
    expect(jsonNullRow.segments).toHaveLength(1)
    expect(jsonNullRow.segments[0].startWeek).toBe(3)
    expect(jsonNullRow.segments[0].endWeek).toBe(7)
    expect(jsonNullRow.segments[0].capacityPercent).toBe(80)

    // ── NAMED_PERSON (Eve) — VALUE(nested-null object) legacy ─────
    const nestedObjRow = profiles.find(p => p.id === profileNestedObjId)!
    expect(nestedObjRow.ownerKind).toBe('NAMED_PERSON')
    expect(nestedObjRow.namedResourceId).toBe(nrEveId)
    expect(nestedObjRow.planningBasis).toBe('CAPACITY_PROFILE')
    expect(nestedObjRow.source).toBe('SQUAD_PLANNER')
    expect(nestedObjRow.defaultPercent).toBe(50)
    expect(nestedObjRow.startWeek).toBe(1)
    expect(nestedObjRow.endWeek).toBe(6)
    expect(nestedObjRow.segments).toHaveLength(1)
    expect(nestedObjRow.segments[0].startWeek).toBe(1)
    expect(nestedObjRow.segments[0].capacityPercent).toBe(100)

    // ── PLANNED_RESOURCE (Frank) — VALUE(null-containing array) legacy ──
    const arrayNullRow = profiles.find(p => p.id === profileArrayNullId)!
    expect(arrayNullRow.ownerKind).toBe('PLANNED_RESOURCE')
    expect(arrayNullRow.namedResourceId).toBe(nrFrankId)
    expect(arrayNullRow.segments).toHaveLength(1)
    expect(arrayNullRow.segments[0].startWeek).toBe(4)
    expect(arrayNullRow.segments[0].capacityPercent).toBe(60)

    // ── PLANNED_RESOURCE (Grace) — VALUE(string) legacy ──────────
    const stringRow = profiles.find(p => p.id === profileStringId)!
    expect(stringRow.ownerKind).toBe('PLANNED_RESOURCE')
    expect(stringRow.namedResourceId).toBe(nrGraceId)
    expect(stringRow.segments).toHaveLength(1)
    expect(stringRow.segments[0].startWeek).toBe(0)
    expect(stringRow.segments[0].capacityPercent).toBe(100)

    // ── PLANNED_RESOURCE (Heidi) — VALUE(boolean) legacy ─────────
    const boolRow = profiles.find(p => p.id === profileBoolId)!
    expect(boolRow.ownerKind).toBe('PLANNED_RESOURCE')
    expect(boolRow.namedResourceId).toBe(nrHeidiId)
    expect(boolRow.segments).toHaveLength(1)
    expect(boolRow.segments[0].startWeek).toBe(2)
    expect(boolRow.segments[0].capacityPercent).toBe(75)

    // ── DB_NULL legacy preserved at storage level ────────────────
    const dbNullIds = await detectDbNullProfileIds(projectId)
    expect(dbNullIds.has(profileRoleId)).toBe(true)
    expect(dbNullIds.has(profileNamedId)).toBe(false)
    expect(dbNullIds.has(profilePlannedId)).toBe(false)
    expect(dbNullIds.has(profilePlannedNrId)).toBe(true)
    // New profiles: none are DB_NULL at storage level
    expect(dbNullIds.has(profileJsonNullId)).toBe(false)
    expect(dbNullIds.has(profileNestedObjId)).toBe(false)
    expect(dbNullIds.has(profileArrayNullId)).toBe(false)
    expect(dbNullIds.has(profileStringId)).toBe(false)
    expect(dbNullIds.has(profileBoolId)).toBe(false)

    // ── Parameterized SQL: verify jsonb storage semantics and nested nulls ──
    const rawRows = await prisma.$queryRaw<Array<{
      id: string
      legacy_type: string
      legacy_is_null: boolean
      legacyJsonType: string | null
      null_kind: string
      nested_nulls_preserved: boolean
    }>>(Prisma.sql`
      SELECT
        cp.id,
        pg_typeof(cp.legacy)::text AS legacy_type,
        cp.legacy IS NULL AS legacy_is_null,
        jsonb_typeof(cp.legacy) AS "legacyJsonType",
        CASE
          WHEN cp.legacy IS NULL THEN 'DB_NULL'
          WHEN cp.legacy = 'null'::jsonb THEN 'JSON_NULL'
          ELSE 'VALUE'
        END AS null_kind,
        CASE
          WHEN cp.id = ${profileNestedObjId}
            AND cp.legacy IS NOT NULL
            AND cp.legacy::jsonb #>> '{nested,value}' IS NULL
            AND cp.legacy::jsonb #>> '{mode}' IS NULL
            AND jsonb_array_length(cp.legacy::jsonb #> '{nested,items}') = 3
            AND cp.legacy::jsonb #>> '{nested,items,1}' IS NULL
          THEN true
          WHEN cp.id <> ${profileNestedObjId} THEN true
          ELSE false
        END AS nested_nulls_preserved
      FROM "CapacityProfile" cp
      WHERE cp."projectId" = ${projectId}
      ORDER BY cp.id
    `)

    // All profiles have jsonb type
    for (const row of rawRows) {
      expect(row.legacy_type).toBe('jsonb')
    }

    // Confirm per-profile null_kind
    const nullKindMap = new Map(rawRows.map(r => [r.id, r.null_kind]))
    expect(nullKindMap.get(profileRoleId)).toBe('DB_NULL')
    expect(nullKindMap.get(profilePlannedNrId)).toBe('DB_NULL')
    expect(nullKindMap.get(profileJsonNullId)).toBe('JSON_NULL')
    expect(nullKindMap.get(profileNamedId)).toBe('VALUE')
    expect(nullKindMap.get(profilePlannedId)).toBe('VALUE')
    expect(nullKindMap.get(profileNestedObjId)).toBe('VALUE')
    expect(nullKindMap.get(profileArrayNullId)).toBe('VALUE')
    expect(nullKindMap.get(profileStringId)).toBe('VALUE')
    expect(nullKindMap.get(profileBoolId)).toBe('VALUE')
    // Confirm per-profile storage nullness independently from null_kind
    const legacyIsNullMap = new Map(rawRows.map(r => [r.id, r.legacy_is_null]))
    expect(legacyIsNullMap.get(profileRoleId)).toBe(true)
    expect(legacyIsNullMap.get(profilePlannedNrId)).toBe(true)
    expect(legacyIsNullMap.get(profileJsonNullId)).toBe(false)
    expect(legacyIsNullMap.get(profileNamedId)).toBe(false)
    expect(legacyIsNullMap.get(profilePlannedId)).toBe(false)
    expect(legacyIsNullMap.get(profileNestedObjId)).toBe(false)
    expect(legacyIsNullMap.get(profileArrayNullId)).toBe(false)
    expect(legacyIsNullMap.get(profileStringId)).toBe(false)
    expect(legacyIsNullMap.get(profileBoolId)).toBe(false)


    // Nested nulls are preserved in jsonb
    const nestedRow = rawRows.find(r => r.id === profileNestedObjId)!
    expect(nestedRow.nested_nulls_preserved).toBe(true)

    // Per-profile jsonb_typeof value-type assertions
    const jsonTypeMap = new Map(rawRows.map(r => [r.id, r.legacyJsonType]))
    expect(jsonTypeMap.get(profileRoleId)).toBeNull()
    expect(jsonTypeMap.get(profilePlannedNrId)).toBeNull()
    expect(jsonTypeMap.get(profileJsonNullId)).toBe('null')
    expect(jsonTypeMap.get(profileNamedId)).toBe('object')
    expect(jsonTypeMap.get(profilePlannedId)).toBe('number')
    expect(jsonTypeMap.get(profileNestedObjId)).toBe('object')
    expect(jsonTypeMap.get(profileArrayNullId)).toBe('array')
    expect(jsonTypeMap.get(profileStringId)).toBe('string')
    expect(jsonTypeMap.get(profileBoolId)).toBe('boolean')

    // Backlog restored
    const epics = await prisma.epic.findMany({ where: { projectId } })
    expect(epics).toHaveLength(1)
    expect(epics[0].name).toBe('Epic Alpha')

    // Timeline entries restored
    const tles = await prisma.timelineEntry.findMany({ where: { projectId } })
    expect(tles).toHaveLength(1)

    const stles = await prisma.storyTimelineEntry.findMany({ where: { projectId } })
    expect(stles).toHaveLength(1)
    expect(stles[0].durationWeeks).toBe(5)

    // Overhead restored
    const overheads = await prisma.projectOverhead.findMany({ where: { projectId } })
    expect(overheads).toHaveLength(1)
    expect(overheads[0].value).toBe(15)

    // ── Canonical deep comparison: captured state restored, post-snapshot named resources pruned ──
    const canonicalAfter = await captureCanonicalState(projectId)
    expect(canonicalAfter.resourceTypes.filter(r => r.id !== extraRtId))
      .toEqual(canonicalBefore.resourceTypes)
    expect(canonicalAfter.namedResources).toEqual(canonicalBefore.namedResources)
    expect(canonicalAfter.resourceTypes).toHaveLength(canonicalBefore.resourceTypes.length + 1)
    expect(canonicalAfter.namedResources).toHaveLength(canonicalBefore.namedResources.length)
    expect(canonicalAfter.resourceTypes.find(r => r.id === extraRtId)).toMatchObject({
      name: 'Post-snapshot role',
      dayRate: 700,
    })
    expect(canonicalAfter.capacityProfiles.filter(p => p.resourceTypeId !== extraRtId))
      .toEqual(canonicalBefore.capacityProfiles)
    expect(canonicalAfter.timelineEntries).toEqual(canonicalBefore.timelineEntries)
    expect(canonicalAfter.storyTimelineEntries).toEqual(canonicalBefore.storyTimelineEntries)
    expect(canonicalAfter.overheadItems).toEqual(canonicalBefore.overheadItems)
    // prof-extra-owner was stored with DB_NULL legacy and is preserved by
    // rollback; every other DB_NULL profile is a captured snapshot profile.
    expect(canonicalAfter.dbNullProfileIds.filter(id => id !== extraProfileId).sort())
      .toEqual(canonicalBefore.dbNullProfileIds.sort())

    // ── HTTP read-parity assertions (real auth, real ownership, real PostgreSQL) ──
    // Re-fetch Resource Profile after rollback
    const rpAfter = await request(app)
      .get(`/api/projects/${projectId}/resource-profile`)
      .set('Authorization', authHeader)
      .expect(200)
    const profileAfter: Record<string, unknown> = rpAfter.body

    // Re-fetch Timeline after rollback
    const tlAfter = await request(app)
      .get(`/api/projects/${projectId}/timeline`)
      .set('Authorization', authHeader)
      .expect(200)
    const timelineAfter: Record<string, unknown> = tlAfter.body

    // Narrow before-captured responses for comparison
    const beforeRP = resourceProfileBefore as Record<string, unknown>
    const beforeTL = timelineBefore as Record<string, unknown>
    const afterRows = profileAfter.resourceRows as Array<Record<string, unknown>>
    const beforeRows = beforeRP.resourceRows as Array<Record<string, unknown>>


    // ── Role profile: PROFILE resolutionSource, exact restored segments, null fields ──
    const devRow = afterRows.find(r => r.resourceTypeId === rtDevId)!
    const devCp = devRow.capacityProfile as Record<string, unknown>
    expect(devCp.resolutionSource).toBe('PROFILE')
    expect(devCp.planningBasis).toBe('capacityProfile')
    expect(devCp.source).toBe('manual')
    expect(devCp.defaultPercent).toBeNull()
    expect(devCp.startWeek).toBeNull()
    expect(devCp.endWeek).toBeNull()
    expect(devCp.segments).toEqual([
      { startWeek: 0, endWeek: 4, capacityPercent: 100 },
      { startWeek: 5, endWeek: 10, capacityPercent: 50 },
    ])

    // ── Named-person identity, PROFILE resolutionSource, exact segments ──
    const devNrs = devRow.namedResources as Array<Record<string, unknown>>
    const aliceRow = devNrs.find(nr => nr.id === nrAliceId)!
    expect(aliceRow.resourceIdentity).toBe('NAMED_PERSON')
    const aliceCp = aliceRow.capacityProfile as Record<string, unknown>
    expect(aliceCp.resolutionSource).toBe('PROFILE')
    expect(aliceCp.planningBasis).toBe('capacityProfile')
    expect(aliceCp.source).toBe('squadPlanner')
    expect(aliceCp.defaultPercent).toBe(100)
    expect(aliceCp.startWeek).toBe(2)
    expect(aliceCp.endWeek).toBe(8)
    expect(aliceCp.segments).toEqual([
      { startWeek: 2, endWeek: 5, capacityPercent: 100 },
    ])

    // ── Designer RT: has a persisted ROLE profile (jsonNull) → PROFILE resolution ──
    const desRow = afterRows.find(r => r.resourceTypeId === rtDesId)!
    expect(desRow.resourceTypeId).toBe(rtDesId)
    // Designer now has a persisted ROLE profile (jsonNull legacy) built from the snapshot
    const desCp = desRow.capacityProfile as Record<string, unknown> | undefined
    expect(desCp).toBeDefined()
    expect(desCp!.resolutionSource).toBe('PROFILE')
    expect(desCp!.planningBasis).toBe('capacityProfile')
    expect(desCp!.source).toBe('manual')
    expect(desCp!.defaultPercent).toBeNull()
    expect(desCp!.startWeek).toBeNull()
    expect(desCp!.endWeek).toBeNull()
    expect(desCp!.segments).toEqual([
      { startWeek: 3, endWeek: 7, capacityPercent: 80 },
    ])

    // ── Bob under Designer RT: persisted profile (issue #418 — every owner
    // carries authoritative profile state; no legacy fallback exists) ──
    const desNrs = desRow.namedResources as Array<Record<string, unknown>>
    const bobRow = desNrs.find(nr => nr.name === 'Bob')!
    const bobCp = bobRow.capacityProfile as Record<string, unknown>
    expect(bobCp.resolutionSource).toBe('PROFILE')
    expect(bobCp.planningBasis).toBe('availabilityWindow')
    expect(bobCp.source).toBe('availabilityWindow')
    expect(bobCp.defaultPercent).toBe(100)
    expect(bobRow.resourceIdentity).toBe('NAMED_PERSON')

    // ── Charlie: PLANNED_RESOURCE identity, PROFILE resolutionSource, 3 segments ──
    const charlieRow = devNrs.find(nr => nr.id === nrCharlieId)!
    expect(charlieRow.resourceIdentity).toBe('PLANNED_RESOURCE')
    const charlieCp = charlieRow.capacityProfile as Record<string, unknown>
    expect(charlieCp.resolutionSource).toBe('PROFILE')
    expect(charlieCp.planningBasis).toBe('capacityProfile')
    expect(charlieCp.defaultPercent).toBeNull()
    expect(charlieCp.startWeek).toBeNull()
    expect(charlieCp.endWeek).toBeNull()
    expect(charlieCp.segments).toEqual([
      { startWeek: 0, endWeek: 2, capacityPercent: 100 },
      { startWeek: 3, endWeek: 5, capacityPercent: 75 },
      { startWeek: 6, endWeek: 10, capacityPercent: 50 },
    ])

    // ── Capacity profile segments are identical to pre-mutation response ──
    const beforeDevCp = (beforeRows.find(r => r.resourceTypeId === rtDevId)!.capacityProfile as Record<string, unknown>)
    expect(devCp.segments).toEqual(beforeDevCp.segments)

    // ── Resource Profile allocation fields: every field matches A exactly (including nulls) ──
    const devNrsTyped = devRow.namedResources as Array<Record<string, unknown>>
    const afterAliceRow = devNrsTyped.find((nr: Record<string, unknown>) => nr.id === nrAliceId)!
    const beforeDevRow = beforeRows.find((r: Record<string, unknown>) => r.resourceTypeId === rtDevId)!
    const beforeDevNrsTyped = beforeDevRow.namedResources as Array<Record<string, unknown>>
    const beforeAliceRow = beforeDevNrsTyped.find((nr: Record<string, unknown>) => nr.id === nrAliceId)!
    ;['allocationMode', 'allocationPercent', 'allocationStartWeek', 'allocationEndWeek', 'startWeek', 'endWeek']
      .forEach(field => {
        expect(afterAliceRow[field]).toBe(beforeAliceRow[field])
      })
    // Dev row level: allocation fields including nulls
    expect(devRow.allocationMode).toBe(beforeDevCp.allocationMode ?? beforeRows.find((r: Record<string, unknown>) => r.resourceTypeId === rtDevId)!.allocationMode)
    const afterCharlieRow = devNrsTyped.find((nr: Record<string, unknown>) => nr.id === nrCharlieId)!
    const beforeCharlieRow = beforeDevNrsTyped.find((nr: Record<string, unknown>) => nr.id === nrCharlieId)!
    expect(afterCharlieRow.allocationMode).toBe(beforeCharlieRow.allocationMode)
    expect(afterCharlieRow.allocationPercent).toBe(beforeCharlieRow.allocationPercent)
    expect(afterCharlieRow.allocationStartWeek).toBe(beforeCharlieRow.allocationStartWeek)
    expect(afterCharlieRow.allocationEndWeek).toBe(beforeCharlieRow.allocationEndWeek)

    // ── Timeline parity: named-resource allocation fields equal A ──
    const afterNRs = timelineAfter.namedResources as Array<Record<string, unknown>>
    const beforeNRs = beforeTL.namedResources as Array<Record<string, unknown>>
    const aliceTLAfter = afterNRs.find(nr => nr.id === nrAliceId)!
    const aliceTLBefore = beforeNRs.find(nr => nr.id === nrAliceId)!
    expect(aliceTLAfter.allocationMode).toBe(aliceTLBefore.allocationMode)
    expect(aliceTLAfter.allocationPercent).toBe(aliceTLBefore.allocationPercent)
    expect(aliceTLAfter.startWeek).toBe(aliceTLBefore.startWeek)
    expect(aliceTLAfter.endWeek).toBe(aliceTLBefore.endWeek)
    expect(aliceTLAfter.allocationStartWeek).toBe(aliceTLBefore.allocationStartWeek)
    expect(aliceTLAfter.allocationEndWeek).toBe(aliceTLBefore.allocationEndWeek)

    // ── Timeline entries (features + stories) match scheduling semantics ──
    // Ignore regenerated IDs — only compare scheduling values
    const projectScheduling = (rows: Array<Record<string, unknown>>): Array<{ startWeek: number; durationWeeks: number; isManual: boolean }> =>
      rows.map(r => ({ startWeek: r.startWeek as number, durationWeeks: r.durationWeeks as number, isManual: r.isManual as boolean }))
    expect(projectScheduling(timelineAfter.entries as Array<Record<string, unknown>>))
      .toEqual(projectScheduling(beforeTL.entries as Array<Record<string, unknown>>))
    const afterStoryEntries = (timelineAfter.storyEntries ?? []) as Array<Record<string, unknown>>
    const beforeStoryEntries = (beforeTL.storyEntries ?? []) as Array<Record<string, unknown>>
    expect(projectScheduling(afterStoryEntries)).toEqual(projectScheduling(beforeStoryEntries))
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// Scenario B — rollback-to-rollback chaining
// ═════════════════════════════════════════════════════════════════════════════

describeIf('Scenario B — rollback chaining (A→B→rollback A→pre_rollback B→rollback)', () => {
  let projectId: string
  let rtId: string
  let snapA: string
  let preRollbackSnapId: string

  beforeAll(async () => {
    if (!runIntegration) return
    projectId = await createProject()
    rtId = await createResourceType(projectId, 'rt-b-chain', 'Engineer')
    await createNamedResource(projectId, rtId, 'nr-b-chain', 'Eve')
    // Profile-first (issue #418): Eve must carry a profile.
    await createProfile(
      projectId, 'prof-b-eve', 'NAMED_PERSON', null, 'nr-b-chain',
      { planningBasis: 'DEMAND_FOLLOWING', source: 'FIXED', defaultPercent: 100, startWeek: null, endWeek: null },
      Prisma.DbNull,
    )

    // State A: ROLE profile, 100% TIMELINE, no segments
    await createProfile(
      projectId, 'prof-b-a', 'ROLE', rtId, null,
      {
        planningBasis: 'AVAILABILITY_WINDOW',
        source: 'MANUAL',
        defaultPercent: 100,
        startWeek: 0,
        endWeek: 10,
      },
      Prisma.DbNull,
    )

    // Snapshot A
    const dataA = await buildSnapshot(projectId, prisma)
    const snapARec = await prisma.backlogSnapshot.create({
      data: {
        projectId, label: 'State A', trigger: 'manual',
        snapshot: dataA as unknown as object, createdById: userId,
      },
    })
    snapA = snapARec.id

    // State B: change profile to 75% segmented CAPACITY_PROFILE
    await prisma.capacityProfile.update({
      where: { id: 'prof-b-a' },
      data: {
        planningBasis: 'CAPACITY_PROFILE',
        defaultPercent: 75,
        startWeek: null,
        endWeek: null,
      },
    })
    const seg = await prisma.capacitySegment.findFirst({
      where: { capacityProfileId: 'prof-b-a' },
    })
    if (seg) {
      await prisma.capacitySegment.delete({ where: { id: seg.id } })
    }
    await createSegment('prof-b-a', 'seg-b-1', 1, 4, 75)
    await createSegment('prof-b-a', 'seg-b-2', 5, 8, 50)
    // ── Backlog for route rendering (not part of snapshot, just for HTTP response) ──
    const bEpic = await prisma.epic.create({ data: { name: 'B Epic', projectId, order: 0 } })
    const bFeature = await prisma.feature.create({ data: { name: 'B Feature', epicId: bEpic.id, order: 0 } })
    const bStory = await prisma.userStory.create({ data: { name: 'B Story', featureId: bFeature.id, order: 0 } })
    await prisma.task.create({
      data: { name: 'B Task', userStoryId: bStory.id, order: 0, hoursEffort: 8, resourceTypeId: rtId },
    })
  })

  it('rollback to A, verify pre_rollback captures B, rollback pre_rollback to restore B', async () => {
    // ── Capture B-state HTTP responses (before rollback) ──────────
    const rpB = await request(app)
      .get(`/api/projects/${projectId}/resource-profile`)
      .set('Authorization', authHeader)
      .expect(200)
    // B-state ROLE profile: AVAILABILITY_WINDOW, 75%, with segments
    const bRoleRow = (rpB.body.resourceRows as Array<Record<string, unknown>>).find(r => r.resourceTypeId === rtId)!
    const bRoleCp = bRoleRow.capacityProfile as Record<string, unknown>
    expect(bRoleCp.planningBasis).toBe('capacityProfile')
    expect(bRoleCp.defaultPercent).toBe(75)
    expect(bRoleCp.segments).toHaveLength(2)
    const tlB = await request(app)
      .get(`/api/projects/${projectId}/timeline`)
      .set('Authorization', authHeader)
      .expect(200)
    expect(tlB.body).toHaveProperty('entries')
    // ── Rollback to A ─────────────────────────────────────────────
    await rollbackProjectSnapshot({ projectId, snapshotId: snapA, userId, db: prisma })

    // Profile restored to A state
    const profileA = await prisma.capacityProfile.findFirst({
      where: { projectId, id: 'prof-b-a' },
      include: { segments: { orderBy: { startWeek: 'asc' as const } } },
    })
    expect(profileA).not.toBeNull()
    expect(profileA!.planningBasis).toBe('AVAILABILITY_WINDOW')
    expect(profileA!.defaultPercent).toBe(100)
    expect(profileA!.segments).toHaveLength(0)

    // Pre_rollback snapshot was created inside the transaction
    const preSnaps = await prisma.backlogSnapshot.findMany({
      where: { projectId, trigger: 'pre_rollback' },
      orderBy: { createdAt: 'desc' as const },
      take: 1,
    })
    expect(preSnaps).toHaveLength(1)
    preRollbackSnapId = preSnaps[0].id

    // Its label includes reference to the rolled-back snapshot
    expect(preSnaps[0].label).toContain('State A')

    // Pre_rollback data contains B's state at v4
    const preData = preSnaps[0].snapshot as unknown as SnapshotV4
    expect(preData.schemaVersion).toBe(4)
    const bProfile = preData.capacityProfiles.find(p => p.id === 'prof-b-a')
    expect(bProfile).toBeDefined()
    expect(bProfile!.planningBasis).toBe('CAPACITY_PROFILE')
    expect(bProfile!.defaultPercent).toBe(75)
    expect(bProfile!.segments).toHaveLength(2)
    expect(bProfile!.segments[0].capacityPercent).toBe(75)

    // ── Rollback to pre_rollback (restore B) ──────────────────────
    await rollbackProjectSnapshot({
      projectId, snapshotId: preRollbackSnapId, userId, db: prisma,
    })

    // B state restored exactly
    const profileB = await prisma.capacityProfile.findFirst({
      where: { projectId, id: 'prof-b-a' },
      include: { segments: { orderBy: { startWeek: 'asc' as const } } },
    })
    expect(profileB).not.toBeNull()
    expect(profileB!.planningBasis).toBe('CAPACITY_PROFILE')
    expect(profileB!.defaultPercent).toBe(75)
    expect(profileB!.segments).toHaveLength(2)
    expect(profileB!.segments[0].startWeek).toBe(1)
    expect(profileB!.segments[1].capacityPercent).toBe(50)

    // No duplicate profiles: the ROLE profile and Eve's named-person profile
    // survive the rollback exactly once each.
    const allProfiles = await prisma.capacityProfile.findMany({
      where: { projectId },
    })
    expect(allProfiles).toHaveLength(2)
    expect(allProfiles.map((p: { id: string }) => p.id).sort()).toEqual(['prof-b-a', 'prof-b-eve'])

    // DB_NULL semantics preserved
    const dbNullIds = await detectDbNullProfileIds(projectId)
    expect(dbNullIds.has('prof-b-a')).toBe(true)

    // Pre_rollback snapshots survive retention pruning
    const finalPreRollbacks = await prisma.backlogSnapshot.count({
      where: { projectId, trigger: 'pre_rollback' },
    })
    expect(finalPreRollbacks).toBeGreaterThanOrEqual(1)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// Scenario C — transactional FK failure after pre_rollback creation
// ═════════════════════════════════════════════════════════════════════════════

describeIf('Scenario C — transactional FK failure after pre_rollback creation', () => {
  let projectId: string
  let rtId: string
  let snapshotId: string
  let snapsBefore: number
  let ftId: string

  beforeAll(async () => {
    if (!runIntegration) return
    projectId = await createProject()
    rtId = await createResourceType(projectId, 'rt-c-fail', 'Tester')

    // Create a FeatureTemplate that the story will reference
    ftId = (
      await prisma.featureTemplate.create({
        data: {
          name: `RollbackTestTemplate-${Date.now()}`,
          category: 'DEV',
        },
      })
    ).id

    // Create backlog with a story that has appliedTemplateId set
    await createEpicBacklog(projectId, rtId, ftId)

    // Create a profile
    await createProfile(
      projectId, 'prof-c', 'ROLE', rtId, null,
      {},
      Prisma.DbNull,
    )

    // Build and persist v3 snapshot
    const data = await buildSnapshot(projectId, prisma)
    const snap = await prisma.backlogSnapshot.create({
      data: {
        projectId, label: 'Scenario C', trigger: 'manual',
        snapshot: data as unknown as object, createdById: userId,
      },
    })
    snapshotId = snap.id
    snapsBefore = await prisma.backlogSnapshot.count({ where: { projectId } })

    // Delete the FeatureTemplate — the snapshot's story has appliedTemplateId=ftId.
    // The rollback's restoreSnapshotCommonState will try to recreate the story with
    // the stale FK, triggering a FK violation AFTER the pre_rollback snapshot is
    // created inside the transaction.
    await prisma.featureTemplate.delete({ where: { id: ftId } })
  })

  it('rollback fails with P2003 (FK violation), state unchanged, no new snapshot committed', async () => {
    let caught: unknown
    try {
      await rollbackProjectSnapshot({ projectId, snapshotId, userId, db: prisma })
    } catch (e) {
      caught = e
    }
    expect(caught).toBeDefined()
    expect(caught).toBeInstanceOf(Prisma.PrismaClientKnownRequestError)
    expect((caught as Prisma.PrismaClientKnownRequestError).code).toBe('P2003')

    // Snapshot count unchanged (pre_rollback was rolled back)
    const snapsAfter = await prisma.backlogSnapshot.count({ where: { projectId } })
    expect(snapsAfter).toBe(snapsBefore)

    // Resource types still exist
    const rtCount = await prisma.resourceType.count({ where: { projectId } })
    expect(rtCount).toBe(1)

    // Backlog unchanged (mutated or original — rollback didn't apply)
    const epics = await prisma.epic.findMany({ where: { projectId } })
    expect(epics).toHaveLength(1)
    expect(epics[0].name).toBe('Epic Alpha')

    // Profile still exists
    const profile = await prisma.capacityProfile.findFirst({ where: { projectId } })
    expect(profile).not.toBeNull()
    expect(profile!.ownerKind).toBe('ROLE')
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// Scenario D — pre-transaction validation failures are non-destructive
// ═════════════════════════════════════════════════════════════════════════════

describeIf('Scenario D — invalid v3 validation is non-destructive', () => {
  let projectId: string
  let rtId: string
  let profileCountBefore: number

  beforeEach(async () => {
    if (!runIntegration) return
    projectId = await createProject()
    rtId = await createResourceType(projectId, 'rt-d-valid', 'Valid Role')
    await createProfile(
      projectId, 'prof-d-valid', 'ROLE', rtId, null,
      {},
      Prisma.DbNull,
    )
    const counts = await Promise.all([
      prisma.capacityProfile.count({ where: { projectId } }),
      prisma.backlogSnapshot.count({ where: { projectId } }),
    ])
    profileCountBefore = counts[0]
  })

  afterEach(async () => {
    if (!runIntegration) return
    await prisma.capacitySegment.deleteMany({
      where: { capacityProfile: { projectId } },
    })
    await prisma.capacityProfile.deleteMany({ where: { projectId } })
    await prisma.resourceType.deleteMany({ where: { projectId } })
    await prisma.project.delete({ where: { id: projectId } })
  })

  it('rejects unknown schemaVersion (malformed discriminator)', async () => {
    const badSnap = await prisma.backlogSnapshot.create({
      data: {
        projectId,
        label: 'bad version',
        trigger: 'manual',
        snapshot: {
          schemaVersion: 4,
          epics: [],
          resourceTypes: [],
          namedResources: [],
          timelineEntries: [],
          storyTimelineEntries: [],
          epicDependencies: [],
          featureDependencies: [],
          overheadItems: [],
        } as unknown as object,
        createdById: userId,
      },
    })
    await expect(
      rollbackProjectSnapshot({
        projectId, snapshotId: badSnap.id, userId, db: prisma,
      }),
    ).rejects.toThrow(SnapshotSchemaError)

    const profilesAfter = await prisma.capacityProfile.count({ where: { projectId } })
    expect(profilesAfter).toBe(profileCountBefore)
  })

  it('rejects duplicate profile IDs without modifying state', async () => {
    const badV4 = {
      schemaVersion: 4,
      epics: [],
      project: null,
      resourceTypes: [{
        id: 'rt-d-dup', name: 'Dup', category: 'ENGINEERING',
        count: 1, hoursPerDay: null, dayRate: null, globalTypeId: null,
      }],
      namedResources: [],
      timelineEntries: [],
      storyTimelineEntries: [],
      epicDependencies: [],
      featureDependencies: [],
      overheadItems: [],
      capacityProfiles: [
        {
          id: 'dup-id',
          ownerKind: 'ROLE',
          resourceTypeId: 'rt-d-dup',
          namedResourceId: null,
          planningBasis: 'DEMAND_FOLLOWING',
          source: 'MANUAL',
          defaultPercent: null,
          startWeek: null,
          endWeek: null,
          legacy: { kind: 'DB_NULL' as const },
          segments: [],
        },
        {
          id: 'dup-id',
          ownerKind: 'NAMED_PERSON',
          resourceTypeId: null,
          namedResourceId: null,
          planningBasis: 'DEMAND_FOLLOWING',
          source: 'MANUAL',
          defaultPercent: null,
          startWeek: null,
          endWeek: null,
          legacy: { kind: 'DB_NULL' as const },
          segments: [],
        },
      ],
    }
    const badSnap = await prisma.backlogSnapshot.create({
      data: {
        projectId, label: 'dup profiles', trigger: 'manual',
        snapshot: badV4 as unknown as object, createdById: userId,
      },
    })
    await expect(
      rollbackProjectSnapshot({
        projectId, snapshotId: badSnap.id, userId, db: prisma,
      }),
    ).rejects.toThrow(SnapshotValidationError)

    const profilesAfter = await prisma.capacityProfile.count({ where: { projectId } })
    expect(profilesAfter).toBe(profileCountBefore)
  })

  it('rejects duplicate segment IDs', async () => {
    const badV4 = {
      schemaVersion: 4,
      epics: [],
      project: null,
      resourceTypes: [{
        id: 'rt-d-segdup', name: 'SegDup', category: 'ENGINEERING',
        count: 1, hoursPerDay: null, dayRate: null, globalTypeId: null,
      }],
      namedResources: [],
      timelineEntries: [],
      storyTimelineEntries: [],
      epicDependencies: [],
      featureDependencies: [],
      overheadItems: [],
      capacityProfiles: [{
        id: 'prof-segdup',
        ownerKind: 'ROLE',
        resourceTypeId: 'rt-d-segdup',
        namedResourceId: null,
        planningBasis: 'DEMAND_FOLLOWING',
        source: 'MANUAL',
        defaultPercent: null,
        startWeek: null,
        endWeek: null,
        legacy: { kind: 'DB_NULL' as const },
        segments: [
          { id: 'seg-same', startWeek: 0, endWeek: 5, capacityPercent: 100, source: 'MANUAL' },
          { id: 'seg-same', startWeek: 6, endWeek: 10, capacityPercent: 50, source: 'MANUAL' },
        ],
      }],
    }
    const badSnap = await prisma.backlogSnapshot.create({
      data: {
        projectId, label: 'dup segments', trigger: 'manual',
        snapshot: badV4 as unknown as object, createdById: userId,
      },
    })
    await expect(
      rollbackProjectSnapshot({
        projectId, snapshotId: badSnap.id, userId, db: prisma,
      }),
    ).rejects.toThrow(SnapshotValidationError)

    const profilesAfter = await prisma.capacityProfile.count({ where: { projectId } })
    expect(profilesAfter).toBe(profileCountBefore)
  })

  it('rejects ROLE with missing resourceTypeId (not in snapshot resourceTypes)', async () => {
    const badV4 = {
      schemaVersion: 4,
      epics: [],
      project: null,
      resourceTypes: [],
      namedResources: [],
      timelineEntries: [],
      storyTimelineEntries: [],
      epicDependencies: [],
      featureDependencies: [],
      overheadItems: [],
      capacityProfiles: [{
        id: 'prof-missing-owner',
        ownerKind: 'ROLE',
        resourceTypeId: 'rt-nonexistent',
        namedResourceId: null,
        planningBasis: 'DEMAND_FOLLOWING',
        source: 'MANUAL',
        defaultPercent: null,
        startWeek: null,
        endWeek: null,
        legacy: { kind: 'DB_NULL' as const },
        segments: [],
      }],
    }
    const badSnap = await prisma.backlogSnapshot.create({
      data: {
        projectId, label: 'missing owner', trigger: 'manual',
        snapshot: badV4 as unknown as object, createdById: userId,
      },
    })
    await expect(
      rollbackProjectSnapshot({
        projectId, snapshotId: badSnap.id, userId, db: prisma,
      }),
    ).rejects.toThrow(SnapshotValidationError)

    const profilesAfter = await prisma.capacityProfile.count({ where: { projectId } })
    expect(profilesAfter).toBe(profileCountBefore)
  })

  it('rejects segment with startWeek > endWeek (invalid range)', async () => {
    const badV4 = {
      schemaVersion: 4,
      epics: [],
      project: null,
      resourceTypes: [{
        id: 'rt-d-range', name: 'Range', category: 'ENGINEERING',
        count: 1, hoursPerDay: null, dayRate: null, globalTypeId: null,
      }],
      namedResources: [],
      timelineEntries: [],
      storyTimelineEntries: [],
      epicDependencies: [],
      featureDependencies: [],
      overheadItems: [],
      capacityProfiles: [{
        id: 'prof-range',
        ownerKind: 'ROLE',
        resourceTypeId: 'rt-d-range',
        namedResourceId: null,
        planningBasis: 'DEMAND_FOLLOWING',
        source: 'MANUAL',
        defaultPercent: null,
        startWeek: null,
        endWeek: null,
        legacy: { kind: 'DB_NULL' as const },
        segments: [{
          id: 'seg-bad-range',
          startWeek: 10,
          endWeek: 5,
          capacityPercent: 100,
          source: 'MANUAL',
        }],
      }],
    }
    const badSnap = await prisma.backlogSnapshot.create({
      data: {
        projectId, label: 'bad range', trigger: 'manual',
        snapshot: badV4 as unknown as object, createdById: userId,
      },
    })
    await expect(
      rollbackProjectSnapshot({
        projectId, snapshotId: badSnap.id, userId, db: prisma,
      }),
    ).rejects.toThrow(SnapshotValidationError)

    const profilesAfter = await prisma.capacityProfile.count({ where: { projectId } })
    expect(profilesAfter).toBe(profileCountBefore)
  })

  it('rejects unsupported ownerKind, planningBasis, and source enums with no state change', async () => {
    const validRT = { id: 'rt-d-valid', name: 'Valid', category: 'ENGINEERING' as const,
      count: 1, hoursPerDay: null, dayRate: null, globalTypeId: null }

    // Three snapshots each with a different invalid enum
    const badConfigs: Array<{
      label: string
      overrides: Partial<{
        ownerKind: string
        planningBasis: string
        source: string
      }>
    }> = [
      { label: 'invalid ownerKind', overrides: { ownerKind: 'INVALID' } },
      { label: 'invalid planningBasis', overrides: { ownerKind: 'ROLE', planningBasis: 'INVALID' } },
      { label: 'invalid source', overrides: { ownerKind: 'ROLE', planningBasis: 'DEMAND_FOLLOWING', source: 'INVALID' } },
    ]

    for (const { label, overrides } of badConfigs) {
      const badV4 = {
        schemaVersion: 4,
        epics: [],
        project: null,
        resourceTypes: [validRT],
        namedResources: [],
        timelineEntries: [],
        storyTimelineEntries: [],
        epicDependencies: [],
        featureDependencies: [],
        overheadItems: [],
        capacityProfiles: [{
          id: `prof-bad-enum-${label.replace(/\s+/g, '-')}`,
          ownerKind: overrides.ownerKind ?? 'ROLE',
          resourceTypeId: 'rt-d-valid',
          namedResourceId: null,
          planningBasis: overrides.planningBasis ?? 'DEMAND_FOLLOWING',
          source: overrides.source ?? 'MANUAL',
          defaultPercent: null,
          startWeek: null,
          endWeek: null,
          legacy: { kind: 'DB_NULL' as const },
          segments: [],
        }] as unknown as SnapshotV4['capacityProfiles'],
      }
      const badSnap = await prisma.backlogSnapshot.create({
        data: {
          projectId, label, trigger: 'manual',
          snapshot: badV4 as unknown as object, createdById: userId,
        },
      })
      await expect(
        rollbackProjectSnapshot({ projectId, snapshotId: badSnap.id, userId, db: prisma }),
      ).rejects.toThrow(SnapshotValidationError)

      const profilesAfter = await prisma.capacityProfile.count({ where: { projectId } })
      expect(profilesAfter).toBe(profileCountBefore)
    }
  })

  it('rejects rollback when a surviving post-snapshot resource type has no ROLE profile', async () => {
    // Build a valid snapshot of the fixture project, then create a
    // post-snapshot resource type WITHOUT any profile. The retained
    // post-snapshot role must fail closed before any destructive write
    // (issue #418 PR 1 review) — no guessing or repair.
    const data = await buildSnapshot(projectId, prisma)
    const snap = await prisma.backlogSnapshot.create({
      data: {
        projectId,
        label: 'valid snapshot',
        trigger: 'manual',
        snapshot: data as unknown as object,
        createdById: userId,
      },
    })
    await prisma.resourceType.create({
      data: { name: 'Unprofiled Post Snapshot Role', category: 'ENGINEERING', count: 1, projectId },
    })

    await expect(
      rollbackProjectSnapshot({
        projectId, snapshotId: snap.id, userId, db: prisma,
      }),
    ).rejects.toThrow(RollbackPreflightError)

    // Nothing destructive committed: profiles untouched, no pre_rollback row.
    expect(await prisma.capacityProfile.count({ where: { projectId } })).toBe(profileCountBefore)
    expect(await prisma.resourceType.count({ where: { projectId } })).toBe(2)
    expect(await prisma.backlogSnapshot.count({ where: { projectId, trigger: 'pre_rollback' } })).toBe(0)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// Scenario E — real v2 rollback replaces stale persisted profiles
// ═════════════════════════════════════════════════════════════════════════════

describeIf('Scenario E — v2 rollback replaces stale persisted profiles', () => {
  let projectId: string
  let rtId: string
  let nrId: string
  let v2SnapshotId: string

  beforeAll(async () => {
    if (!runIntegration) return
    projectId = await createProject()

    // Create RT with TIMELINE mode at 60%
    rtId = await createResourceType(projectId, 'rt-e-dev', 'Engineer', {})

    // Create NR inheriting TIMELINE mode at 60%
    nrId = await createNamedResource(projectId, rtId, 'nr-eve-scenario-e', 'Eve', {})
    // Include effort so the Resource Profile DTO has a row for this RT.
    await createEpicBacklog(projectId, rtId, null)

    // Create stale persisted profiles that DIFFER from v2-derived state
    await createProfile(
      projectId, 'prof-e-stale-role', 'ROLE', rtId, null,
      {
        planningBasis: 'AVAILABILITY_WINDOW',
        source: 'SQUAD_PLANNER',
        defaultPercent: 100,
        startWeek: 0,
        endWeek: 5,
      },
      Prisma.DbNull,
    )
    await createSegment('prof-e-stale-role', 'seg-e-stale', 0, 5, 100)

    await createProfile(
      projectId, 'prof-e-stale-nr', 'NAMED_PERSON', null, nrId,
      {
        planningBasis: 'WHOLE_PROJECT_ALLOCATION',
        source: 'MANUAL',
        defaultPercent: 80,
        startWeek: 1,
        endWeek: 6,
      },
      { allocationMode: 'EFFORT' },
    )
    // Add a PLANNED_RESOURCE that should NOT survive v2 rollback
    // Use a separate NR to avoid owner FK conflict with prof-e-stale-nr
    const tempPlannedNr = await createNamedResource(
      projectId, rtId, 'nr-temp-planned', 'Temp Planned',
    )
    await createProfile(
      projectId, 'prof-e-planned', 'PLANNED_RESOURCE', null, tempPlannedNr,
      { planningBasis: 'CAPACITY_PROFILE', source: 'DERIVED' },
      Prisma.DbNull,
    )
    const v4Data = await buildSnapshot(projectId, prisma)
    // A faithful historical v2 snapshot carries the candidate legacy capacity
    // columns on ResourceType/NamedResource rows (the v2 restore path derives
    // profiles from them). Re-add them from the live fixture state.
    const v2Data: SnapshotV2 = {
      ...v4Data,
      schemaVersion: 2,
      resourceTypes: (v4Data.resourceTypes as Array<Record<string, unknown>>).map(rt => ({
        ...rt,
        allocationMode: rt.id === rtId ? 'TIMELINE' : 'EFFORT',
        allocationPercent: rt.id === rtId ? 60 : 100,
        allocationStartWeek: rt.id === rtId ? 0 : null,
        allocationEndWeek: rt.id === rtId ? 10 : null,
      })),
      namedResources: (v4Data.namedResources as Array<Record<string, unknown>>).map(nr => ({
        ...nr,
        startWeek: nr.id === nrId ? 2 : null,
        endWeek: nr.id === nrId ? 6 : null,
        allocationPct: nr.id === nrId ? 60 : 100,
        allocationMode: nr.id === nrId ? 'TIMELINE' : 'EFFORT',
        allocationPercent: nr.id === nrId ? 60 : 100,
        // Historical v2 rows carried the availability window on the startWeek/
        // endWeek aliases; allocationStartWeek/EndWeek were not populated.
        allocationStartWeek: null,
        allocationEndWeek: null,
      })),
    } as unknown as SnapshotV2
    v2SnapshotId = (
      await prisma.backlogSnapshot.create({
        data: {
          projectId,
          label: 'v2 snapshot for Scenario E',
          trigger: 'manual',
          snapshot: v2Data as unknown as object,
          createdById: userId,
        },
      })
    ).id
  })

  it('v2 rollback is refused pre-write with the retirement reason (issue #444)', async () => {
    const profilesBefore = await prisma.capacityProfile.findMany({
      where: { projectId },
      include: { segments: { orderBy: { startWeek: 'asc' as const } } },
      orderBy: [{ ownerKind: 'asc' as const }, { id: 'asc' as const }],
    })

    await expect(
      rollbackProjectSnapshot({ projectId, snapshotId: v2SnapshotId, userId, db: prisma }),
    ).rejects.toThrow(SnapshotValidationError)
    await expect(
      rollbackProjectSnapshot({ projectId, snapshotId: v2SnapshotId, userId, db: prisma }),
    ).rejects.toThrow(RETIREMENT_REASON)

    // Nothing changed: profiles/segments untouched, no pre_rollback row, the
    // raw target row is unchanged.
    const profilesAfter = await prisma.capacityProfile.findMany({
      where: { projectId },
      include: { segments: { orderBy: { startWeek: 'asc' as const } } },
      orderBy: [{ ownerKind: 'asc' as const }, { id: 'asc' as const }],
    })
    expect(profilesAfter).toEqual(profilesBefore)
    expect(await prisma.backlogSnapshot.count({ where: { projectId, trigger: 'pre_rollback' } })).toBe(0)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// Scenario G — real v2 CAPACITY_PLAN rollback produces valid authoritative
// AVAILABILITY_WINDOW profiles (issue #418 PR 1 review: a segmentless
// CAPACITY_PROFILE ROLE profile is invalid authority; the captured window is
// preserved instead).
// ═════════════════════════════════════════════════════════════════════════════

describeIf('Scenario G — v2 CAPACITY_PLAN rollback translates to valid window profiles', () => {
  let projectId: string
  let rtId: string
  let nrId: string
  let v2SnapshotId: string

  beforeAll(async () => {
    if (!runIntegration) return
    projectId = await createProject()
    rtId = await createResourceType(projectId, 'rt-g-plan', 'Planned Role', {})
    nrId = await createNamedResource(projectId, rtId, 'nr-g-plan', 'Planned Person', {})
    await createEpicBacklog(projectId, rtId, null)

    // Stale persisted profiles that DIFFER from v2-derived state
    await createProfile(
      projectId, 'prof-g-stale-role', 'ROLE', rtId, null,
      {
        planningBasis: 'CAPACITY_PROFILE',
        source: 'SQUAD_PLANNER',
        defaultPercent: 100,
        startWeek: null,
        endWeek: null,
      },
      Prisma.DbNull,
    )
    await createSegment('prof-g-stale-role', 'seg-g-stale', 0, 5, 100)
    await createProfile(
      projectId, 'prof-g-stale-nr', 'NAMED_PERSON', null, nrId,
      {
        planningBasis: 'CAPACITY_PROFILE',
        source: 'SQUAD_PLANNER',
        defaultPercent: 80,
        startWeek: null,
        endWeek: null,
      },
      Prisma.DbNull,
    )
    await createSegment('prof-g-stale-nr', 'seg-g-stale-nr', 0, 10, 80)

    const v4Data = await buildSnapshot(projectId, prisma)
    const v2Data: SnapshotV2 = {
      ...v4Data,
      schemaVersion: 2,
      resourceTypes: (v4Data.resourceTypes as Array<Record<string, unknown>>).map(rt => ({
        ...rt,
        allocationMode: rt.id === rtId ? 'CAPACITY_PLAN' : 'EFFORT',
        allocationPercent: rt.id === rtId ? 100 : 100,
        allocationStartWeek: rt.id === rtId ? 0 : null,
        allocationEndWeek: rt.id === rtId ? 10 : null,
      })),
      namedResources: (v4Data.namedResources as Array<Record<string, unknown>>).map(nr => ({
        ...nr,
        startWeek: nr.id === nrId ? 2 : null,
        endWeek: nr.id === nrId ? 8 : null,
        allocationPct: nr.id === nrId ? 100 : 100,
        allocationMode: nr.id === nrId ? 'CAPACITY_PLAN' : 'EFFORT',
        allocationPercent: nr.id === nrId ? 100 : 100,
        allocationStartWeek: null,
        allocationEndWeek: null,
      })),
    } as unknown as SnapshotV2
    v2SnapshotId = (
      await prisma.backlogSnapshot.create({
        data: {
          projectId,
          label: 'v2 CAPACITY_PLAN snapshot for Scenario G',
          trigger: 'manual',
          snapshot: v2Data as unknown as object,
          createdById: userId,
        },
      })
    ).id
  })

  it('v2 rollback is refused pre-write with the retirement reason (issue #444)', async () => {
    const profilesBefore = await prisma.capacityProfile.findMany({
      where: { projectId },
      include: { segments: true },
      orderBy: [{ ownerKind: 'asc' as const }, { id: 'asc' as const }],
    })

    await expect(
      rollbackProjectSnapshot({ projectId, snapshotId: v2SnapshotId, userId, db: prisma }),
    ).rejects.toThrow(SnapshotValidationError)
    await expect(
      rollbackProjectSnapshot({ projectId, snapshotId: v2SnapshotId, userId, db: prisma }),
    ).rejects.toThrow(RETIREMENT_REASON)

    // No state changed: stale profiles/segments untouched, no pre_rollback
    // row, and the candidate columns are untouched.
    const profilesAfter = await prisma.capacityProfile.findMany({
      where: { projectId },
      include: { segments: true },
      orderBy: [{ ownerKind: 'asc' as const }, { id: 'asc' as const }],
    })
    expect(profilesAfter).toEqual(profilesBefore)
    expect(await prisma.backlogSnapshot.count({ where: { projectId, trigger: 'pre_rollback' } })).toBe(0)
  })

  it('the exact all-windowless-100% Class A snapshot is refused pre-write with the retirement reason (issue #444)', async () => {
    const projectId2 = await createProject()
    const rtId2 = await createResourceType(projectId2, 'rt-g-bad', 'Bad Plan', {})
    await createNamedResource(projectId2, rtId2, 'nr-g-bad', 'Bad Person', {})
    await createEpicBacklog(projectId2, rtId2, null)
    await createProfile(
      projectId2, 'prof-g-bad-role', 'ROLE', rtId2, null,
      { planningBasis: 'DEMAND_FOLLOWING', source: 'FIXED', defaultPercent: 100, startWeek: null, endWeek: null },
      Prisma.DbNull,
    )
    await createProfile(
      projectId2, 'prof-g-bad-nr', 'NAMED_PERSON', null, 'nr-g-bad',
      { planningBasis: 'DEMAND_FOLLOWING', source: 'FIXED', defaultPercent: 100, startWeek: null, endWeek: null },
      Prisma.DbNull,
    )

    const v4Data = await buildSnapshot(projectId2, prisma)
    const v2Data = {
      ...v4Data,
      schemaVersion: 2,
      resourceTypes: (v4Data.resourceTypes as Array<Record<string, unknown>>).map(rt => ({
        ...rt,
        allocationMode: 'CAPACITY_PLAN',
        allocationPercent: 100,
        allocationStartWeek: null,
        allocationEndWeek: null,
      })),
      namedResources: (v4Data.namedResources as Array<Record<string, unknown>>).map(nr => ({
        ...nr,
        startWeek: null,
        endWeek: null,
        allocationPct: 100,
        allocationMode: 'CAPACITY_PLAN',
        allocationPercent: 100,
        allocationStartWeek: null,
        allocationEndWeek: null,
      })),
    } as unknown as SnapshotV2
    const snap = (
      await prisma.backlogSnapshot.create({
        data: {
          projectId: projectId2,
          label: 'exact class a v2',
          trigger: 'manual',
          snapshot: v2Data as unknown as object,
          createdById: userId,
        },
      })
    ).id
    const persistedBefore = await prisma.backlogSnapshot.findUniqueOrThrow({ where: { id: snap } })
    const profileCountBefore = await prisma.capacityProfile.count({ where: { projectId: projectId2 } })

    // Issue #444: even the previously-approved exact Class A shape is
    // deliberately retired — refused pre-write with the stable reason.
    await expect(
      rollbackProjectSnapshot({ projectId: projectId2, snapshotId: snap, userId, db: prisma }),
    ).rejects.toThrow(SnapshotValidationError)
    await expect(
      rollbackProjectSnapshot({ projectId: projectId2, snapshotId: snap, userId, db: prisma }),
    ).rejects.toThrow(RETIREMENT_REASON)

    // No state changed: profiles untouched, no pre_rollback row, and the
    // persisted target row is unchanged.
    expect(await prisma.capacityProfile.count({ where: { projectId: projectId2 } })).toBe(profileCountBefore)
    expect(await prisma.backlogSnapshot.count({ where: { projectId: projectId2, trigger: 'pre_rollback' } })).toBe(0)
    const persistedAfter = await prisma.backlogSnapshot.findUniqueOrThrow({ where: { id: snap } })
    expect(persistedAfter.snapshot).toEqual(persistedBefore.snapshot)
  })

  it('rejects a windowless CAPACITY_PLAN snapshot outside the exact Class A predicate before any write', async () => {
    // Issue #438 fail-closed boundary: a non-100 percentage is NOT the
    // approved all-windowless-100% shape, so the snapshot stays quarantined
    // and rollback is refused pre-write with the stable reason.
    const projectId2 = await createProject()
    const rtId2 = await createResourceType(projectId2, 'rt-g-p80', 'Plan 80', {})
    await createEpicBacklog(projectId2, rtId2, null)
    await createProfile(
      projectId2, 'prof-g-p80-role', 'ROLE', rtId2, null,
      { planningBasis: 'DEMAND_FOLLOWING', source: 'FIXED', defaultPercent: 100, startWeek: null, endWeek: null },
      Prisma.DbNull,
    )

    const v4Data = await buildSnapshot(projectId2, prisma)
    const v2Data = {
      ...v4Data,
      schemaVersion: 2,
      resourceTypes: (v4Data.resourceTypes as Array<Record<string, unknown>>).map(rt => ({
        ...rt,
        allocationMode: 'CAPACITY_PLAN',
        allocationPercent: 80,
        allocationStartWeek: null,
        allocationEndWeek: null,
      })),
      namedResources: (v4Data.namedResources as Array<Record<string, unknown>>).map(nr => ({
        ...nr,
        startWeek: null,
        endWeek: null,
        allocationPct: 100,
        allocationMode: 'CAPACITY_PLAN',
        allocationPercent: 100,
        allocationStartWeek: null,
        allocationEndWeek: null,
      })),
    } as unknown as SnapshotV2
    const badSnap = (
      await prisma.backlogSnapshot.create({
        data: {
          projectId: projectId2,
          label: 'windowless 80 v2',
          trigger: 'manual',
          snapshot: v2Data as unknown as object,
          createdById: userId,
        },
      })
    ).id
    const profileCountBefore = await prisma.capacityProfile.count({ where: { projectId: projectId2 } })
    const snapshotCountBefore = await prisma.backlogSnapshot.count({ where: { projectId: projectId2 } })

    let caught: unknown
    try {
      await rollbackProjectSnapshot({ projectId: projectId2, snapshotId: badSnap, userId, db: prisma })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(SnapshotValidationError)
    const message = caught instanceof Error ? caught.message : String(caught)
    // Issue #444: every V2 snapshot is deliberately retired — the stable
    // retirement reason, never quarantine reasoning.
    expect(message).toBe(RETIREMENT_REASON)

    // No state changed: profiles untouched, no pre_rollback snapshot, and the
    // persisted target row is unchanged.
    expect(await prisma.capacityProfile.count({ where: { projectId: projectId2 } })).toBe(profileCountBefore)
    expect(await prisma.backlogSnapshot.count({ where: { projectId: projectId2 } })).toBe(snapshotCountBefore)
    expect(await prisma.backlogSnapshot.count({ where: { projectId: projectId2, trigger: 'pre_rollback' } })).toBe(0)
  })

  it('rejects quarantined CAPACITY_PLAN with a single -1 edge before any write', async () => {
    const projectId2 = await createProject()
    const rtId2 = await createResourceType(projectId2, 'rt-g-min1', 'Minus One Plan', {})
    await createEpicBacklog(projectId2, rtId2, null)
    await createProfile(
      projectId2, 'prof-g-min1-role', 'ROLE', rtId2, null,
      { planningBasis: 'DEMAND_FOLLOWING', source: 'FIXED', defaultPercent: 100, startWeek: null, endWeek: null },
      Prisma.DbNull,
    )

    const v4Data = await buildSnapshot(projectId2, prisma)
    const v2Data = {
      ...v4Data,
      schemaVersion: 2,
      resourceTypes: (v4Data.resourceTypes as Array<Record<string, unknown>>).map(rt => ({
        ...rt,
        allocationMode: 'CAPACITY_PLAN',
        allocationPercent: 100,
        allocationStartWeek: -1,
        allocationEndWeek: 5,
      })),
      namedResources: (v4Data.namedResources as Array<Record<string, unknown>>).map(nr => ({
        ...nr,
        startWeek: 1,
        endWeek: 8,
        allocationPct: 100,
        allocationMode: 'CAPACITY_PLAN',
        allocationPercent: 100,
        allocationStartWeek: null,
        allocationEndWeek: null,
      })),
    } as unknown as SnapshotV2
    const badSnap = (
      await prisma.backlogSnapshot.create({
        data: {
          projectId: projectId2,
          label: 'single -1 edge v2',
          trigger: 'manual',
          snapshot: v2Data as unknown as object,
          createdById: userId,
        },
      })
    ).id
    const profileCountBefore = await prisma.capacityProfile.count({ where: { projectId: projectId2 } })
    const snapshotCountBefore = await prisma.backlogSnapshot.count({ where: { projectId: projectId2 } })

    let caught: unknown
    try {
      await rollbackProjectSnapshot({ projectId: projectId2, snapshotId: badSnap, userId, db: prisma })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(SnapshotValidationError)
    const message = caught instanceof Error ? caught.message : String(caught)
    expect(message).toBe(RETIREMENT_REASON)

    expect(await prisma.capacityProfile.count({ where: { projectId: projectId2 } })).toBe(profileCountBefore)
    expect(await prisma.backlogSnapshot.count({ where: { projectId: projectId2 } })).toBe(snapshotCountBefore)
    expect(await prisma.backlogSnapshot.count({ where: { projectId: projectId2, trigger: 'pre_rollback' } })).toBe(0)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// Scenario H — real v2 EFFORT / FULL_PROJECT rollback with stale window aliases
// (issue #418 PR 1 review round 2: EFFORT/FULL_PROJECT never used windows, so
// the deterministic translation discards them → valid DEMAND_FOLLOWING /
// WHOLE_PROJECT_ALLOCATION profiles with null start/end).
// ═════════════════════════════════════════════════════════════════════════════

describeIf('Scenario H — v2 EFFORT/FULL_PROJECT discard stale windows', () => {
  let projectId: string
  let effortRtId: string
  let fullRtId: string
  let effortNrId: string
  let fullNrId: string
  let v2SnapshotId: string

  beforeAll(async () => {
    if (!runIntegration) return
    projectId = await createProject()
    effortRtId = await createResourceType(projectId, 'rt-h-effort', 'Effort Role', {})
    fullRtId = await createResourceType(projectId, 'rt-h-full', 'Full Role', {})
    effortNrId = await createNamedResource(projectId, effortRtId, 'nr-h-effort', 'Effort Person', {})
    fullNrId = await createNamedResource(projectId, fullRtId, 'nr-h-full', 'Full Person', {})
    await createEpicBacklog(projectId, effortRtId, null)

    // Stale persisted profiles that DIFFER from v2-derived state
    await createProfile(
      projectId, 'prof-h-stale-effort', 'ROLE', effortRtId, null,
      { planningBasis: 'AVAILABILITY_WINDOW', source: 'AVAILABILITY_WINDOW', defaultPercent: 60, startWeek: 0, endWeek: 4 },
      Prisma.DbNull,
    )
    await createProfile(
      projectId, 'prof-h-stale-full', 'ROLE', fullRtId, null,
      { planningBasis: 'AVAILABILITY_WINDOW', source: 'AVAILABILITY_WINDOW', defaultPercent: 40, startWeek: 1, endWeek: 3 },
      Prisma.DbNull,
    )
    await createProfile(
      projectId, 'prof-h-stale-effort-nr', 'NAMED_PERSON', null, effortNrId,
      { planningBasis: 'AVAILABILITY_WINDOW', source: 'AVAILABILITY_WINDOW', defaultPercent: 60, startWeek: 0, endWeek: 4 },
      Prisma.DbNull,
    )
    await createProfile(
      projectId, 'prof-h-stale-full-nr', 'NAMED_PERSON', null, fullNrId,
      { planningBasis: 'AVAILABILITY_WINDOW', source: 'AVAILABILITY_WINDOW', defaultPercent: 40, startWeek: 1, endWeek: 3 },
      Prisma.DbNull,
    )

    const v4Data = await buildSnapshot(projectId, prisma)
    const v2Data: SnapshotV2 = {
      ...v4Data,
      schemaVersion: 2,
      resourceTypes: (v4Data.resourceTypes as Array<Record<string, unknown>>).map(rt => ({
        ...rt,
        allocationMode: rt.id === effortRtId ? 'EFFORT' : rt.id === fullRtId ? 'FULL_PROJECT' : 'EFFORT',
        allocationPercent: rt.id === effortRtId ? 100 : rt.id === fullRtId ? 80 : 100,
        allocationStartWeek: rt.id === effortRtId ? 2 : rt.id === fullRtId ? 1 : null,
        allocationEndWeek: rt.id === effortRtId ? 9 : rt.id === fullRtId ? 7 : null,
      })),
      namedResources: (v4Data.namedResources as Array<Record<string, unknown>>).map(nr => ({
        ...nr,
        startWeek: nr.id === effortNrId ? 3 : nr.id === fullNrId ? 1 : null,
        endWeek: nr.id === effortNrId ? 8 : nr.id === fullNrId ? 5 : null,
        allocationPct: nr.id === effortNrId ? 100 : nr.id === fullNrId ? 80 : 100,
        allocationMode: nr.id === effortNrId ? 'EFFORT' : nr.id === fullNrId ? 'FULL_PROJECT' : 'EFFORT',
        allocationPercent: nr.id === effortNrId ? 100 : nr.id === fullNrId ? 80 : 100,
        allocationStartWeek: null,
        allocationEndWeek: null,
      })),
    } as unknown as SnapshotV2
    v2SnapshotId = (
      await prisma.backlogSnapshot.create({
        data: {
          projectId,
          label: 'v2 EFFORT/FULL_PROJECT snapshot for Scenario H',
          trigger: 'manual',
          snapshot: v2Data as unknown as object,
          createdById: userId,
        },
      })
    ).id
  })

  it('v2 rollback is refused pre-write with the retirement reason (issue #444)', async () => {
    const profilesBefore = await prisma.capacityProfile.findMany({
      where: { projectId },
      include: { segments: true },
      orderBy: [{ ownerKind: 'asc' as const }, { id: 'asc' as const }],
    })

    await expect(
      rollbackProjectSnapshot({ projectId, snapshotId: v2SnapshotId, userId, db: prisma }),
    ).rejects.toThrow(SnapshotValidationError)
    await expect(
      rollbackProjectSnapshot({ projectId, snapshotId: v2SnapshotId, userId, db: prisma }),
    ).rejects.toThrow(RETIREMENT_REASON)

    // No state changed: profiles/segments untouched and no pre_rollback row.
    const profilesAfter = await prisma.capacityProfile.findMany({
      where: { projectId },
      include: { segments: true },
      orderBy: [{ ownerKind: 'asc' as const }, { id: 'asc' as const }],
    })
    expect(profilesAfter).toEqual(profilesBefore)
    expect(await prisma.backlogSnapshot.count({ where: { projectId, trigger: 'pre_rollback' } })).toBe(0)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// Scenario I — orphan v2 NamedResource rejected before writes + runtime reads
// fail closed on malformed persisted profiles
// ═════════════════════════════════════════════════════════════════════════════

describeIf('Scenario I — orphan v2 owner rejection and fail-closed reads', () => {
  it('rejects orphan v2 NamedResource before any write', async () => {
    if (!runIntegration) return
    const projectId = await createProject()
    const rtId = await createResourceType(projectId, 'rt-i-present', 'Present Role', {})
    await createNamedResource(projectId, rtId, 'nr-i-present', 'Present Person')
    await createEpicBacklog(projectId, rtId, null)
    await createProfile(
      projectId, 'prof-i-role', 'ROLE', rtId, null,
      { planningBasis: 'DEMAND_FOLLOWING', source: 'FIXED', defaultPercent: 100, startWeek: null, endWeek: null },
      Prisma.DbNull,
    )
    await createProfile(
      projectId, 'prof-i-nr', 'NAMED_PERSON', null, 'nr-i-present',
      { planningBasis: 'DEMAND_FOLLOWING', source: 'FIXED', defaultPercent: 100, startWeek: null, endWeek: null },
      Prisma.DbNull,
    )

    const v4Data = await buildSnapshot(projectId, prisma)
    const v2Data = {
      ...v4Data,
      schemaVersion: 2,
      resourceTypes: (v4Data.resourceTypes as Array<Record<string, unknown>>).map(rt => ({
        ...rt,
        allocationMode: 'EFFORT',
        allocationPercent: 100,
        allocationStartWeek: null,
        allocationEndWeek: null,
      })),
      namedResources: [
        ...(v4Data.namedResources as Array<Record<string, unknown>>).map(nr => ({
          ...nr,
          startWeek: null,
          endWeek: null,
          allocationPct: 100,
          allocationMode: 'EFFORT',
          allocationPercent: 100,
          allocationStartWeek: null,
          allocationEndWeek: null,
        })),
        {
          id: 'nr-i-orphan',
          resourceTypeId: 'rt-i-missing', // absent from the snapshot
          name: 'Orphan Person',
          startWeek: null,
          endWeek: null,
          allocationPct: 100,
          allocationMode: 'EFFORT',
          allocationPercent: 100,
          allocationStartWeek: null,
          allocationEndWeek: null,
          pricingModel: 'ACTUAL_DAYS',
        },
      ],
    } as unknown as SnapshotV2
    const orphanSnap = (
      await prisma.backlogSnapshot.create({
        data: {
          projectId,
          label: 'orphan v2',
          trigger: 'manual',
          snapshot: v2Data as unknown as object,
          createdById: userId,
        },
      })
    ).id
    const profileCountBefore = await prisma.capacityProfile.count({ where: { projectId } })
    const snapshotCountBefore = await prisma.backlogSnapshot.count({ where: { projectId } })

    // Issue #444: the whole V2 snapshot is deliberately retired, so the
    // rollback is refused pre-write with the stable retirement reason before
    // any orphan analysis runs.
    await expect(
      rollbackProjectSnapshot({ projectId, snapshotId: orphanSnap, userId, db: prisma }),
    ).rejects.toThrow(SnapshotValidationError)
    await expect(
      rollbackProjectSnapshot({ projectId, snapshotId: orphanSnap, userId, db: prisma }),
    ).rejects.toThrow(RETIREMENT_REASON)
    // The retirement reason is identifier-free.
    await expect(
      rollbackProjectSnapshot({ projectId, snapshotId: orphanSnap, userId, db: prisma }),
    ).rejects.not.toThrow(/nr-i-orphan/)

    // No state changed, no pre_rollback snapshot committed.
    expect(await prisma.capacityProfile.count({ where: { projectId } })).toBe(profileCountBefore)
    expect(await prisma.backlogSnapshot.count({ where: { projectId } })).toBe(snapshotCountBefore)
    expect(await prisma.backlogSnapshot.count({ where: { projectId, trigger: 'pre_rollback' } })).toBe(0)
  })

  it('malformed persisted profiles fail closed through Resource Profile, Timeline and scheduler', async () => {
    if (!runIntegration) return
    const projectId = await createProject()
    const rtId = await createResourceType(projectId, 'rt-i-bad', 'Bad Role', {})
    await createNamedResource(projectId, rtId, 'nr-i-bad', 'Bad Person')
    await createEpicBacklog(projectId, rtId, null)
    const badProfileId = await createProfile(
      projectId, 'prof-i-bad', 'ROLE', rtId, null,
      { planningBasis: 'DEMAND_FOLLOWING', source: 'FIXED', defaultPercent: 100, startWeek: null, endWeek: null },
      Prisma.DbNull,
    )
    await createProfile(
      projectId, 'prof-i-bad-nr', 'NAMED_PERSON', null, 'nr-i-bad',
      { planningBasis: 'DEMAND_FOLLOWING', source: 'FIXED', defaultPercent: 100, startWeek: null, endWeek: null },
      Prisma.DbNull,
    )
    // Corrupt the persisted ROLE profile: DEMAND_FOLLOWING must not carry windows.
    await prisma.capacityProfile.update({
      where: { id: badProfileId },
      data: { startWeek: 2, endWeek: 9 },
    })

    // Resource Profile fails closed (409), Timeline fails closed (non-200),
    // scheduler resolution throws — no malformed DTO is ever produced.
    const rp = await request(app)
      .get(`/api/projects/${projectId}/resource-profile`)
      .set('Authorization', authHeader)
    expect(rp.status).toBe(409)
    const tl = await request(app)
      .get(`/api/projects/${projectId}/timeline`)
      .set('Authorization', authHeader)
    expect(tl.status).not.toBe(200)
    const { resolveSchedulerCapacity } = await import('../lib/schedulerCapacityResolver.js')
    await expect(resolveSchedulerCapacity(prisma as any, projectId)).rejects.toThrow()
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// Scenario F — v1 rollback (backlog only, profiles untouched, raw SQL legacy)
// ═════════════════════════════════════════════════════════════════════════════

describeIf('Scenario F — v1 rollback preserves profiles, restores backlog', () => {
  let projectId: string
  let rtId: string
  let nrId: string
  let v1SnapshotId: string

  beforeAll(async () => {
    if (!runIntegration) return
    projectId = await createProject()
    rtId = await createResourceType(projectId, 'rt-f-dev', 'Developer')
    nrId = await createNamedResource(projectId, rtId, 'nr-frank-scenario-f', 'Frank')

    // ROLE profile — DB_NULL legacy
    await createProfile(
      projectId, 'prof-f-role', 'ROLE', rtId, null,
      {
        planningBasis: 'DEMAND_FOLLOWING',
        source: 'MANUAL',
        defaultPercent: 100,
        startWeek: 0,
        endWeek: 10,
      },
      Prisma.DbNull,
    )
    await createSegment('prof-f-role', 'seg-f-1', 0, 4, 100)
    await createSegment('prof-f-role', 'seg-f-2', 5, 10, 50)

    // NAMED_PERSON profile — VALUE(object) legacy
    await createProfile(
      projectId, 'prof-f-named', 'NAMED_PERSON', null, nrId,
      {
        planningBasis: 'AVAILABILITY_WINDOW',
        source: 'SQUAD_PLANNER',
        defaultPercent: 80,
        startWeek: 2,
        endWeek: 8,
      },
      { allocationMode: 'EFFORT' },
    )
    // ── 6 extra profiles covering all Prisma JSON null states ──
    // Use NAMED_PERSON with unique NRs to avoid owner FK conflicts under #361 constraints
    const nrJsonNull = await createNamedResource(
      projectId, rtId, 'nr-f-jsonnull', 'F JsonNull',
    )
    const nrObjNull = await createNamedResource(
      projectId, rtId, 'nr-f-obj-null', 'F ObjNull',
    )
    const nrArrNull = await createNamedResource(
      projectId, rtId, 'nr-f-arr-null', 'F ArrNull',
    )
    const nrString = await createNamedResource(
      projectId, rtId, 'nr-f-string', 'F String',
    )
    const nrNumber = await createNamedResource(
      projectId, rtId, 'nr-f-number', 'F Number',
    )
    const nrBool = await createNamedResource(
      projectId, rtId, 'nr-f-bool', 'F Bool',
    )
    await createProfile(
      projectId, 'prof-f-jsonnull', 'NAMED_PERSON', null, nrJsonNull,
      { planningBasis: 'DEMAND_FOLLOWING', source: 'MANUAL', defaultPercent: 50 },
      Prisma.JsonNull,
    )
    await createProfile(
      projectId, 'prof-f-obj-null', 'NAMED_PERSON', null, nrObjNull,
      { planningBasis: 'DEMAND_FOLLOWING', source: 'MANUAL', defaultPercent: 50 },
      { outer: 'value', inner: null, nested: { deep: null } },
    )
    await createProfile(
      projectId, 'prof-f-arr-null', 'NAMED_PERSON', null, nrArrNull,
      { planningBasis: 'DEMAND_FOLLOWING', source: 'MANUAL', defaultPercent: 50 },
      ['a', null, 'c'],
    )
    await createProfile(
      projectId, 'prof-f-string', 'NAMED_PERSON', null, nrString,
      { planningBasis: 'DEMAND_FOLLOWING', source: 'MANUAL', defaultPercent: 50 },
      'hello-legacy',
    )
    await createProfile(
      projectId, 'prof-f-number', 'NAMED_PERSON', null, nrNumber,
      { planningBasis: 'DEMAND_FOLLOWING', source: 'MANUAL', defaultPercent: 50 },
      12345,
    )
    await createProfile(
      projectId, 'prof-f-bool', 'NAMED_PERSON', null, nrBool,
      { planningBasis: 'DEMAND_FOLLOWING', source: 'MANUAL', defaultPercent: 50 },
      true,
    )

    // Backlog for v1 snapshot
    await createEpicBacklog(projectId, rtId, null)

    // Add timeline entry
    const epics = await prisma.epic.findMany({
      where: { projectId },
      include: { features: { include: { userStories: true } } },
    })
    const feature = epics[0].features[0]
    const story = feature.userStories[0]
    await prisma.timelineEntry.create({
      data: {
        projectId, featureId: feature.id,
        startWeek: 1, durationWeeks: 6, isManual: true,
      },
    })
    await prisma.storyTimelineEntry.create({
      data: {
        projectId, storyId: story.id,
        startWeek: 2, durationWeeks: 4, isManual: false,
      },
    })

    // Build v1 snapshot from current state (epic array only)
    const v3Data = await buildSnapshot(projectId, prisma)
    const v1: SnapshotV1 = v3Data.epics.map(e => ({
      ...e,
      id: e.id,
      name: e.name,
      description: e.description,
      assumptions: e.assumptions,
      order: e.order,
      features: e.features.map(f => ({
        ...f,
        id: f.id,
        name: f.name,
        description: f.description,
        assumptions: f.assumptions,
        order: f.order,
        userStories: f.userStories.map(s => ({
          ...s,
          id: s.id,
          name: s.name,
          description: s.description,
          assumptions: s.assumptions,
          order: s.order,
          appliedTemplateId: s.appliedTemplateId,
          tasks: s.tasks.map(t => ({
            ...t,
            name: t.name,
            description: t.description,
            assumptions: t.assumptions,
            hoursEffort: t.hoursEffort,
            durationDays: t.durationDays,
            order: t.order,
            resourceType: t.resourceType,
          })),
        })),
      })),
    }))

    v1SnapshotId = await createV1Snapshot(projectId, v1)

    // After taking the v1 snapshot, mutate the backlog
    await prisma.epic.deleteMany({ where: { projectId } })
    const newEpic = await prisma.epic.create({
      data: { name: 'Mutated Epic After V1 Snap', projectId, order: 0 },
    })
    const newFeature = await prisma.feature.create({
      data: { name: 'Mutated Feature', epicId: newEpic.id, order: 0 },
    })
    await prisma.userStory.create({
      data: { name: 'Mutated Story', featureId: newFeature.id, order: 0 },
    })
  })

  it('v1 rollback is refused pre-write with the retirement reason (issue #444)', async () => {
    const epicsBefore = await prisma.epic.findMany({ where: { projectId } })
    expect(epicsBefore).toHaveLength(1)
    expect(epicsBefore[0].name).toBe('Mutated Epic After V1 Snap')

    const profilesBefore = await prisma.capacityProfile.findMany({
      where: { projectId },
      include: { segments: { orderBy: { startWeek: 'asc' as const } } },
      orderBy: [{ ownerKind: 'asc' as const }, { id: 'asc' as const }],
    })

    await expect(
      rollbackProjectSnapshot({ projectId, snapshotId: v1SnapshotId, userId, db: prisma }),
    ).rejects.toThrow(SnapshotValidationError)
    await expect(
      rollbackProjectSnapshot({ projectId, snapshotId: v1SnapshotId, userId, db: prisma }),
    ).rejects.toThrow(RETIREMENT_REASON)

    // Nothing changed: backlog untouched, profiles/segments untouched, RT/NR
    // untouched, no pre_rollback row.
    const epicsAfter = await prisma.epic.findMany({ where: { projectId } })
    expect(epicsAfter.map(e => e.name)).toEqual(epicsBefore.map(e => e.name))
    const profilesAfter = await prisma.capacityProfile.findMany({
      where: { projectId },
      include: { segments: { orderBy: { startWeek: 'asc' as const } } },
      orderBy: [{ ownerKind: 'asc' as const }, { id: 'asc' as const }],
    })
    expect(profilesAfter).toEqual(profilesBefore)
    expect(await prisma.backlogSnapshot.count({ where: { projectId, trigger: 'pre_rollback' } })).toBe(0)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// Scenario K — V4 restores scope and scheduling fields
// ═════════════════════════════════════════════════════════════════════════════

describeIf('Scenario K — V4 restores scope and scheduling fields', () => {
  let projectId: string
  let snapshotId: string
  let epicId: string
  let featureId: string
  let storyId: string

  beforeAll(async () => {
    if (!runIntegration) return
    projectId = await createProject()
    const rtId = await createResourceType(projectId, 'rt-g-dev', 'Developer', {})
    // Profile-first (issue #418): the role needs an authoritative ROLE profile.
    await createProfile(
      projectId, 'prof-g-role', 'ROLE', rtId, null,
      {
        planningBasis: 'AVAILABILITY_WINDOW',
        source: 'AVAILABILITY_WINDOW',
        defaultPercent: 60,
        startWeek: 2,
        endWeek: 6,
      },
      { allocationMode: 'TIMELINE', allocationPercent: 60 },
    )
    const backlog = await createEpicBacklog(projectId, rtId, null)
    epicId = backlog.epicId
    featureId = backlog.featureId
    storyId = backlog.storyId

    await prisma.epic.update({
      where: { id: epicId },
      data: {
        assumptions: 'Epic assumptions survive rollback',
        featureMode: 'parallel',
        scheduleMode: 'parallel',
        timelineStartWeek: 4,
        isActive: false,
      },
    })
    await prisma.feature.update({
      where: { id: featureId },
      data: {
        assumptions: 'Feature assumptions survive rollback',
        featureMode: 'parallel',
        isActive: false,
        timelineColour: '#123456',
        timelineStartWeek: 5,
      },
    })
    await prisma.userStory.update({
      where: { id: storyId },
      data: {
        assumptions: 'Story assumptions survive rollback',
        isActive: false,
      },
    })
    await prisma.timelineEntry.create({
      data: { projectId, featureId, startWeek: 4, durationWeeks: 3, isManual: true },
    })
    await prisma.storyTimelineEntry.create({
      data: { projectId, storyId, startWeek: 5, durationWeeks: 2, isManual: true },
    })

    const snapshot = await buildSnapshot(projectId, prisma)
    snapshotId = (
      await prisma.backlogSnapshot.create({
        data: {
          projectId,
          label: 'Scope and scheduling snapshot',
          trigger: 'manual',
          snapshot: snapshot as unknown as object,
          createdById: userId,
        },
      })
    ).id
  })

  it('restores captured fields and preserves inactive read behavior', async () => {
    const beforeResourceProfile = await request(app)
      .get(`/api/projects/${projectId}/resource-profile`)
      .set('Authorization', authHeader)
      .expect(200)
    const beforeTimeline = await request(app)
      .get(`/api/projects/${projectId}/timeline`)
      .set('Authorization', authHeader)
      .expect(200)

    await prisma.epic.update({
      where: { id: epicId },
      data: {
        assumptions: null,
        featureMode: 'sequential',
        scheduleMode: 'sequential',
        timelineStartWeek: null,
        isActive: true,
      },
    })
    await prisma.feature.update({
      where: { id: featureId },
      data: {
        assumptions: null,
        featureMode: 'sequential',
        isActive: true,
        timelineColour: null,
        timelineStartWeek: null,
      },
    })
    await prisma.userStory.update({
      where: { id: storyId },
      data: { assumptions: null, isActive: true },
    })

    await rollbackProjectSnapshot({ projectId, snapshotId, userId, db: prisma })

    const restoredEpic = await prisma.epic.findFirst({
      where: { projectId },
      include: { features: { include: { userStories: true } } },
    })
    expect(restoredEpic).toMatchObject({
      assumptions: 'Epic assumptions survive rollback',
      featureMode: 'parallel',
      scheduleMode: 'parallel',
      timelineStartWeek: 4,
      isActive: false,
    })
    const restoredFeature = restoredEpic!.features[0]
    expect(restoredFeature).toMatchObject({
      assumptions: 'Feature assumptions survive rollback',
      featureMode: 'parallel',
      isActive: false,
      timelineColour: '#123456',
      timelineStartWeek: 5,
    })
    expect(restoredFeature.userStories[0]).toMatchObject({
      assumptions: 'Story assumptions survive rollback',
      isActive: false,
    })

    const afterResourceProfile = await request(app)
      .get(`/api/projects/${projectId}/resource-profile`)
      .set('Authorization', authHeader)
      .expect(200)
    expect(afterResourceProfile.body.resourceRows.map((row: Record<string, unknown>) => ({
      resourceTypeId: row.resourceTypeId,
      totalHours: row.totalHours,
      totalDays: row.totalDays,
      allocatedDays: row.allocatedDays,
    }))).toEqual(beforeResourceProfile.body.resourceRows.map((row: Record<string, unknown>) => ({
      resourceTypeId: row.resourceTypeId,
      totalHours: row.totalHours,
      totalDays: row.totalDays,
      allocatedDays: row.allocatedDays,
    })))

    const afterTimeline = await request(app)
      .get(`/api/projects/${projectId}/timeline`)
      .set('Authorization', authHeader)
      .expect(200)
    const projectScheduling = (body: Record<string, unknown>) => ({
      entries: (body.entries as Array<Record<string, unknown>>).map(entry => ({
        startWeek: entry.startWeek,
        durationWeeks: entry.durationWeeks,
        isManual: entry.isManual,
      })),
      storyEntries: ((body.storyEntries ?? []) as Array<Record<string, unknown>>).map(entry => ({
        startWeek: entry.startWeek,
        durationWeeks: entry.durationWeeks,
        isManual: entry.isManual,
      })),
    })
    expect(projectScheduling(afterTimeline.body)).toEqual(projectScheduling(beforeTimeline.body))
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// Test count: 13 total (A:2, B:1, C:1, D:6, E:1, F:1, G:1)
// All under describeIf — skipped when INTEGRATION_TEST is not 'true'.
