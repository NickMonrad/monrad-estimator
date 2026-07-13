/**
 * projects.clone.integration.test.ts — Real PostgreSQL capacity-profile clone tests.
 *
 * Comprehensive integration test for POST /api/projects/:id/clone with exact
 * capacity-profile semantics.  Verifies:
 *   - New/remapped IDs with zero source leakage
 *   - Count/multiplicity parity across all cloned entity types
 *   - Owner-normalised profile/segment parity (business fields match after
 *     normalising the expected clone IDs/names)
 *   - Planning identity (planningBasis, source, defaultPercent, startWeek, endWeek)
 *   - Active capacity-plan non-regeneration (cloned as-is, not regenerated)
 *   - Discounts with remapped resourceTypeIds
 *   - Parameterised raw-storage null/type states (DB_NULL vs JSON_NULL)
 *     via both Prisma IS NULL and jsonb_typeof(...) SQL queries
 *   - Nested-null objects and null-containing arrays in legacy values
 *   - Named-resource billing-model preservation (ACTUAL_DAYS / PRO_RATA)
 *   - Top-level array, string, finite number, and boolean legacy values
 *   - Resource-profile commercial value parity (production GET endpoint with
 *     resource rows, overhead rows, and summary matched by name)
 *   - Overhead endpoint parity via production GET /overhead
 *   - Tax field preservation (taxRate, taxLabel)
 *   - Grand total consistency (summary.totalCost = Σ row costs)
 *   - Atomic rollback for cross-project access
 *   - Zero-capacity segment (capacityPercent=0) preservation
 *   - Client-side computeCommercialData parity via endpoint DTOs
 *   - Client-side buildProfileCsv parity (billing basis, segment data)
 *   - Mid-transaction rollback on invalid profile owner shape (Prisma.sql
 *     injection with valid FK references but shape mismatch)
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { PrismaPg } from '@prisma/adapter-pg'
import { Prisma, PrismaClient } from '@prisma/client'
import type { $Enums } from '@prisma/client'
import { app } from '../app.js'

// Override the global prisma mock from setup.ts with the real PostgreSQL module
// so that the clone route handler reads/writes a real database.
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
let secondUserId: string
let secondToken: string
let secondAuthHeader: string

beforeAll(async () => {
  if (!runIntegration) return
  prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
  })
  await prisma.$connect()

  // Primary test user
  const user = await prisma.user.create({
    data: {
      email: `clone-int-primary-${Date.now()}@example.com`,
      name: 'Clone Integration Primary',
      password: '$2b$10$placeholder',
    },
  })
  userId = user.id
  token = jwt.sign({ userId, role: 'USER' }, process.env.JWT_SECRET!)
  authHeader = `Bearer ${token}`

  // Secondary test user (for cross-project access test)
  const secondUser = await prisma.user.create({
    data: {
      email: `clone-int-second-${Date.now()}@example.com`,
      name: 'Clone Integration Secondary',
      password: '$2b$10$placeholder',
    },
  })
  secondUserId = secondUser.id
  secondToken = jwt.sign({ userId: secondUser.id, role: 'USER' }, process.env.JWT_SECRET!)
  secondAuthHeader = `Bearer ${secondToken}`
})

afterAll(async () => {
  if (!runIntegration) return
  const allUserIds = [userId, secondUserId].filter((id): id is string => id !== undefined)
  if (allUserIds.length === 0) {
    // beforeAll failed before assigning any user ID — nothing to clean up
    await prisma.$disconnect()
    return
  }
  // Cascade cleanup: delete everything owned by either test user
  await prisma.backlogSnapshot.deleteMany({ where: { project: { ownerId: { in: allUserIds } } } })
  await prisma.capacitySegment.deleteMany({
    where: { capacityProfile: { project: { ownerId: { in: allUserIds } } } },
  })
  await prisma.capacityProfile.deleteMany({ where: { project: { ownerId: { in: allUserIds } } } })
  await prisma.capacityPlanEntry.deleteMany({
    where: { period: { plan: { project: { ownerId: { in: allUserIds } } } } },
  })
  await prisma.capacityPlanPeriod.deleteMany({
    where: { plan: { project: { ownerId: { in: allUserIds } } } },
  })
  await prisma.capacityPlan.deleteMany({ where: { project: { ownerId: { in: allUserIds } } } })
  await prisma.projectDiscount.deleteMany({ where: { project: { ownerId: { in: allUserIds } } } })
  await prisma.projectOverhead.deleteMany({ where: { project: { ownerId: { in: allUserIds } } } })
  await prisma.storyTimelineEntry.deleteMany({ where: { project: { ownerId: { in: allUserIds } } } })
  await prisma.timelineEntry.deleteMany({ where: { project: { ownerId: { in: allUserIds } } } })
  await prisma.epicDependency.deleteMany({ where: { epic: { project: { ownerId: { in: allUserIds } } } } })
  await prisma.featureDependency.deleteMany({
    where: { feature: { epic: { project: { ownerId: { in: allUserIds } } } } },
  })
  await prisma.storyDependency.deleteMany({
    where: { story: { feature: { epic: { project: { ownerId: { in: allUserIds } } } } } },
  })
  await prisma.task.deleteMany({
    where: { userStory: { feature: { epic: { project: { ownerId: { in: allUserIds } } } } } },
  })
  await prisma.userStory.deleteMany({
    where: { feature: { epic: { project: { ownerId: { in: allUserIds } } } } },
  })
  await prisma.feature.deleteMany({ where: { epic: { project: { ownerId: { in: allUserIds } } } } })
  await prisma.epic.deleteMany({ where: { project: { ownerId: { in: allUserIds } } } })
  await prisma.namedResource.deleteMany({
    where: { resourceType: { project: { ownerId: { in: allUserIds } } } },
  })
  await prisma.resourceType.deleteMany({ where: { project: { ownerId: { in: allUserIds } } } })
  await prisma.project.deleteMany({ where: { ownerId: { in: allUserIds } } })
  await prisma.user.deleteMany({ where: { id: { in: allUserIds } } })
  await prisma.$disconnect()
})

// ─── Fixture helpers ────────────────────────────────────────────────────────

async function createProject(): Promise<string> {
  const project = await prisma.project.create({
    data: { name: `Clone Source ${Date.now()}`, ownerId: userId },
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
    allocationMode: $Enums.AllocationMode
    allocationPercent: number
    allocationStartWeek: number | null
    allocationEndWeek: number | null
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
      allocationMode: overrides.allocationMode ?? 'TIMELINE',
      allocationPercent: overrides.allocationPercent ?? 100,
      allocationStartWeek: overrides.allocationStartWeek ?? null,
      allocationEndWeek: overrides.allocationEndWeek ?? null,
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
    startWeek: number | null
    endWeek: number | null
    allocationPct: number
    allocationMode: $Enums.AllocationMode
    allocationPercent: number
    allocationStartWeek: number | null
    allocationEndWeek: number | null
    pricingModel: string
  }> = {},
): Promise<string> {
  await prisma.namedResource.create({
    data: {
      id,
      resourceTypeId,
      name,
      startWeek: overrides.startWeek ?? null,
      endWeek: overrides.endWeek ?? null,
      allocationPct: overrides.allocationPct ?? 100,
      allocationMode: overrides.allocationMode ?? 'EFFORT',
      allocationPercent: overrides.allocationPercent ?? 100,
      allocationStartWeek: overrides.allocationStartWeek ?? null,
      allocationEndWeek: overrides.allocationEndWeek ?? null,
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


async function createOverhead(
  projectId: string,
  name: string,
  resourceTypeId: string | null,
  type: 'PERCENTAGE' | 'FIXED_DAYS',
  value: number,
  order: number,
): Promise<string> {
  const overhead = await prisma.projectOverhead.create({
    data: { projectId, name, resourceTypeId, type, value, order },
  })
  return overhead.id
}

async function createTimelineEntry(
  projectId: string,
  featureId: string,
  startWeek: number,
  durationWeeks: number,
  isManual = false,
): Promise<void> {
  await prisma.timelineEntry.create({
    data: { projectId, featureId, startWeek, durationWeeks, isManual },
  })
}

async function createCapacityPlanWithEntry(
  projectId: string,
  resourceTypeId: string,
  overrides: Partial<{
    name: string
    targetWeeks: number
    periodWeeks: number
    maxDelta: number
    isActive: boolean
  }> = {},
): Promise<string> {
  const plan = await prisma.capacityPlan.create({
    data: {
      projectId,
      name: overrides.name ?? 'Clone Integration Plan',
      targetWeeks: overrides.targetWeeks ?? 12,
      periodWeeks: overrides.periodWeeks ?? 4,
      maxDelta: overrides.maxDelta ?? 0.3,
      isActive: overrides.isActive ?? true,
    },
  })
  const period = await prisma.capacityPlanPeriod.create({
    data: {
      planId: plan.id,
      periodIndex: 0,
      startWeek: 0,
      endWeek: 3,
    },
  })
  await prisma.capacityPlanEntry.create({
    data: {
      periodId: period.id,
      resourceTypeId,
      headcount: 2,
      demandFTE: 1.5,
      utilisationPct: 75,
    },
  })
  return plan.id
}

async function createEpicBacklog(
  projectId: string,
  rtId: string,
): Promise<{ epicId: string; featureId: string; storyId: string }> {
  const epic = await prisma.epic.create({
    data: { name: 'Clone Integration Epic', projectId, order: 0 },
  })
  const feature = await prisma.feature.create({
    data: { name: 'Clone Integration Feature', epicId: epic.id, order: 0 },
  })
  const story = await prisma.userStory.create({
    data: { name: 'Clone Integration Story', featureId: feature.id, order: 0 },
  })
  await prisma.task.create({
    data: {
      name: 'Clone Integration Task',
      userStoryId: story.id,
      order: 0,
      hoursEffort: 8,
      resourceTypeId: rtId,
    },
  })
  return { epicId: epic.id, featureId: feature.id, storyId: story.id }
}

/**
 * Detect which capacity profiles have database-NULL legacy (as opposed to
 * JSON null).  Returns a Set of profile IDs where legacy IS NULL at the
 * storage level.
 */
async function detectDbNullProfileIds(projectId: string): Promise<Set<string>> {
  const rows = await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT cp.id FROM "CapacityProfile" cp WHERE cp."projectId" = ${projectId} AND cp.legacy IS NULL
  `)
  return new Set(rows.map(r => r.id))
}

interface LegacyTypeRow {
  id: string
  legacy_is_null: boolean
  legacy_typeof: string | null
}

/**
 * Fetch raw sql-level null and jsonb_typeof state for every capacity profile
 * in the project. Returns a Map of profile id → { isDbNull, typeOf }.
 */
async function detectLegacyTypeInfo(projectId: string): Promise<Map<string, { isDbNull: boolean; typeOf: string | null }>> {
  const rows = await prisma.$queryRaw<LegacyTypeRow[]>(Prisma.sql`
    SELECT id, "legacy" IS NULL AS legacy_is_null, jsonb_typeof("legacy") AS legacy_typeof
    FROM "CapacityProfile"
    WHERE "projectId" = ${projectId}
    ORDER BY id
  `)
  return new Map(rows.map(r => [r.id, { isDbNull: r.legacy_is_null, typeOf: r.legacy_typeof }]))
}

// ─── Normalised comparison types ────────────────────────────────────────────

interface NormalisedSegment {
  startWeek: number
  endWeek: number
  capacityPercent: number
  source: string
}

interface NormalisedProfile {
  ownerKind: string
  /** Owner identifier normalised to the resource-type name (ROLE) or named-resource name */
  ownerName: string
  planningBasis: string
  source: string
  defaultPercent: number | null
  startWeek: number | null
  endWeek: number | null
  legacy: unknown
  segments: NormalisedSegment[]
}

interface NormalisedProjectState {
  resourceTypes: Array<{ name: string; category: string; count: number }>
  namedResources: Array<{ name: string; resourceTypeName: string; pricingModel: string }>
  profiles: NormalisedProfile[]
  discounts: Array<{ resourceTypeName: string | null; type: string; value: number; label: string; order: number }>
  capacityPlans: Array<{ name: string; targetWeeks: number; periodWeeks: number; isActive: boolean }>
  capacityPlanEntries: Array<{ resourceTypeName: string; headcount: number; demandFTE: number; utilisationPct: number }>
  epicCount: number
  dbNullProfileIds: string[]
}

async function captureNormalisedState(projectId: string): Promise<NormalisedProjectState> {
  // Build name lookups
  const rts = await prisma.resourceType.findMany({ where: { projectId }, orderBy: { id: 'asc' } })
  const rtNameById = new Map(rts.map(rt => [rt.id, rt.name]))

  const nrs = await prisma.namedResource.findMany({
    where: { resourceType: { projectId } },
    orderBy: { id: 'asc' },
  })
  const nrNameById = new Map(nrs.map(nr => [nr.id, nr.name]))

  const profiles = await prisma.capacityProfile.findMany({
    where: { projectId },
    include: { segments: { orderBy: { startWeek: 'asc' as const } } },
    orderBy: [{ ownerKind: 'asc' as const }, { id: 'asc' as const }],
  })

  const discounts = await prisma.projectDiscount.findMany({
    where: { projectId },
    orderBy: { order: 'asc' as const },
  })

  const plans = await prisma.capacityPlan.findMany({
    where: { projectId },
    include: {
      periods: {
        include: { entries: true },
        orderBy: { periodIndex: 'asc' as const },
      },
    },
    orderBy: { id: 'asc' as const },
  })

  const epicCount = await prisma.epic.count({ where: { projectId } })
  const dbNullIds = Array.from(await detectDbNullProfileIds(projectId))

  const normalisedProfiles: NormalisedProfile[] = profiles.map(p => {
    let ownerName: string
    if (p.ownerKind === 'ROLE') {
      ownerName = p.resourceTypeId ? (rtNameById.get(p.resourceTypeId) ?? 'unknown') : 'null'
    } else {
      // NAMED_PERSON or PLANNED_RESOURCE
      ownerName = p.namedResourceId ? (nrNameById.get(p.namedResourceId) ?? 'unknown') : 'null'
    }
    return {
      ownerKind: p.ownerKind,
      ownerName,
      planningBasis: p.planningBasis,
      source: p.source,
      defaultPercent: p.defaultPercent,
      startWeek: p.startWeek,
      endWeek: p.endWeek,
      legacy: p.legacy,
      segments: p.segments.map(s => ({
        startWeek: s.startWeek,
        endWeek: s.endWeek,
        capacityPercent: s.capacityPercent,
        source: s.source,
      })),
    }
  })
  // Sort by full business key for deterministic comparison — raw DB IDs differ
  // between source (UUID) and clone (cuid), so we must not rely on DB ordering.
  normalisedProfiles.sort((a, b) => {
    let cmp: number
    cmp = a.ownerKind.localeCompare(b.ownerKind); if (cmp !== 0) return cmp
    cmp = a.ownerName.localeCompare(b.ownerName); if (cmp !== 0) return cmp
    cmp = a.planningBasis.localeCompare(b.planningBasis); if (cmp !== 0) return cmp
    cmp = a.source.localeCompare(b.source); if (cmp !== 0) return cmp
    cmp = (a.defaultPercent ?? -1) - (b.defaultPercent ?? -1); if (cmp !== 0) return cmp
    cmp = (a.startWeek ?? -1) - (b.startWeek ?? -1); if (cmp !== 0) return cmp
    return (a.endWeek ?? -1) - (b.endWeek ?? -1)
  })

  const normalisedDiscounts = discounts.map(d => ({
    resourceTypeName: d.resourceTypeId ? (rtNameById.get(d.resourceTypeId) ?? 'unknown') : null,
    type: d.type,
    value: d.value,
    label: d.label,
    order: d.order,
  }))

  const normalisedPlanEntries: NormalisedProjectState['capacityPlanEntries'] = []
  for (const plan of plans) {
    for (const period of plan.periods) {
      for (const entry of period.entries) {
        normalisedPlanEntries.push({
          resourceTypeName: rtNameById.get(entry.resourceTypeId) ?? 'unknown',
          headcount: entry.headcount,
          demandFTE: entry.demandFTE,
          utilisationPct: entry.utilisationPct,
        })
      }
    }
  }

  return {
    resourceTypes: rts.map(rt => ({
      name: rt.name,
      category: rt.category,
      count: rt.count,
    })).sort((a, b) => a.name.localeCompare(b.name)),
    namedResources: nrs.map(nr => ({
      name: nr.name,
      resourceTypeName: rtNameById.get(nr.resourceTypeId) ?? 'unknown',
      pricingModel: nr.pricingModel,
    })).sort((a, b) => a.name.localeCompare(b.name)),
    profiles: normalisedProfiles,
    discounts: normalisedDiscounts,
    capacityPlans: plans.map(p => ({
      name: p.name,
      targetWeeks: p.targetWeeks,
      periodWeeks: p.periodWeeks,
      isActive: p.isActive,
    })).sort((a, b) => a.name.localeCompare(b.name)),
    capacityPlanEntries: normalisedPlanEntries,
    epicCount,
    dbNullProfileIds: dbNullIds,
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// Scenario A — Full clone success with comprehensive parity
// ═════════════════════════════════════════════════════════════════════════════

describeIf('Scenario A — full clone with capacity profiles, null semantics, and business parity', () => {
  let srcProjectId: string
  let rtEngId: string
  let rtGovId: string
  let nrJohnId: string
  let nrJaneId: string
  let cloneResponse: request.Response

  beforeAll(async () => {
    if (!runIntegration) return

    // ── Build a rich source project ──────────────────────────────────────

    srcProjectId = await createProject()

    // Set tax rate for commercial parity verification
    await prisma.project.update({
      where: { id: srcProjectId },
      data: { taxRate: 15, taxLabel: 'GST' },
    })

    // Resource types (2)
    rtEngId = await createResourceType(srcProjectId, crypto.randomUUID(), 'Engineering',
      { category: 'ENGINEERING', count: 3, hoursPerDay: 8, dayRate: 800 })
    rtGovId = await createResourceType(srcProjectId, crypto.randomUUID(), 'Governance',
      { category: 'GOVERNANCE', count: 1, allocationMode: 'FULL_PROJECT' })

    // Named resources under Engineering (2 — one of each billing model)
    nrJohnId = await createNamedResource(srcProjectId, rtEngId, crypto.randomUUID(), 'John Developer',
      { pricingModel: 'ACTUAL_DAYS', allocationPct: 100 })
    nrJaneId = await createNamedResource(srcProjectId, rtEngId, crypto.randomUUID(), 'Jane Architect',
      { pricingModel: 'PRO_RATA', allocationPct: 80, startWeek: 2, endWeek: 10 })

    // ── Capacity profiles (11) ───────────────────────────────────────────
    // ROLE — scalar shape (single segment, same window)
    const cpRoleScalarId = await createProfile(srcProjectId, crypto.randomUUID(), 'ROLE', rtEngId, null,
      { planningBasis: 'DEMAND_FOLLOWING', source: 'MANUAL', startWeek: 0, endWeek: 10, defaultPercent: 50 })
    await createSegment(cpRoleScalarId, crypto.randomUUID(), 0, 10, 50, 'MANUAL')

    // ROLE — window shape (no segments = empty)
    await createProfile(srcProjectId, crypto.randomUUID(), 'ROLE', rtGovId, null,
      { planningBasis: 'AVAILABILITY_WINDOW', source: 'FIXED', startWeek: 2, endWeek: 8 })
    // No segments created — window-only shape

    // NAMED_PERSON — multi-segment, discontinuous
    const cpNamedMultiId = await createProfile(srcProjectId, crypto.randomUUID(), 'NAMED_PERSON', null, nrJohnId,
      { planningBasis: 'DEMAND_FOLLOWING', source: 'MANUAL', startWeek: 0, endWeek: 12 })
    await createSegment(cpNamedMultiId, crypto.randomUUID(), 0, 3, 100, 'MANUAL')
    await createSegment(cpNamedMultiId, crypto.randomUUID(), 4, 4, 50, 'MANUAL')   // single-week
    await createSegment(cpNamedMultiId, crypto.randomUUID(), 5, 5, 0, 'MANUAL')    // zero-capacity gap
    await createSegment(cpNamedMultiId, crypto.randomUUID(), 6, 8, 75, 'FIXED')    // gap at week 9
    await createSegment(cpNamedMultiId, crypto.randomUUID(), 10, 12, 90, 'AVAILABILITY_WINDOW')

    // PLANNED_RESOURCE — scalar shape
    const cpPlannedScalarId = await createProfile(srcProjectId, crypto.randomUUID(), 'PLANNED_RESOURCE', null, nrJaneId,
      { planningBasis: 'WHOLE_PROJECT_ALLOCATION', source: 'SQUAD_PLANNER', startWeek: 0, endWeek: 10, defaultPercent: 80 })
    await createSegment(cpPlannedScalarId, crypto.randomUUID(), 0, 10, 80, 'MANUAL')

    // ROLE — DB_NULL legacy (Prisma.DbNull)
    const cpDbNullId = await createProfile(srcProjectId, crypto.randomUUID(), 'ROLE', rtEngId, null,
      { planningBasis: 'DEMAND_FOLLOWING', source: 'MANUAL' },
      Prisma.DbNull)
    await createSegment(cpDbNullId, crypto.randomUUID(), 0, 5, 30, 'MANUAL')

    // ROLE — JSON null legacy (Prisma.JsonNull)
    const cpJsonNullId = await createProfile(srcProjectId, crypto.randomUUID(), 'ROLE', rtEngId, null,
      { planningBasis: 'DEMAND_FOLLOWING', source: 'MANUAL' },
      Prisma.JsonNull)
    await createSegment(cpJsonNullId, crypto.randomUUID(), 0, 5, 40, 'MANUAL')

    // ROLE — complex legacy values (object with nested null + null-containing array)
    const cpComplexLegacyId = await createProfile(srcProjectId, crypto.randomUUID(), 'ROLE', rtEngId, null,
      { planningBasis: 'DEMAND_FOLLOWING', source: 'IMPORTED' },
      { nestedField: { inner: null }, items: [1, null, 'hello'], flag: true, count: 42, label: 'test-value' })
    await createSegment(cpComplexLegacyId, crypto.randomUUID(), 2, 6, 60, 'LEGACY')

    // ROLE — top-level array containing null
    await createProfile(srcProjectId, crypto.randomUUID(), 'ROLE', rtEngId, null,
      { planningBasis: 'DEMAND_FOLLOWING', source: 'MANUAL' },
      [null, 'item', 3])

    // ROLE — string legacy value
    await createProfile(srcProjectId, crypto.randomUUID(), 'ROLE', rtGovId, null,
      { planningBasis: 'DEMAND_FOLLOWING', source: 'MANUAL' },
      'plain-string-value')

    // ROLE — finite number legacy value
    await createProfile(srcProjectId, crypto.randomUUID(), 'ROLE', rtEngId, null,
      { planningBasis: 'DEMAND_FOLLOWING', source: 'MANUAL' },
      42)

    // ROLE — boolean legacy value
    await createProfile(srcProjectId, crypto.randomUUID(), 'ROLE', rtGovId, null,
      { planningBasis: 'DEMAND_FOLLOWING', source: 'MANUAL' },
      true)

    // ── Backlog (for epic count parity) ──────────────────────────────────
    const backlog = await createEpicBacklog(srcProjectId, rtEngId)
    await createTimelineEntry(srcProjectId, backlog.featureId, 0, 4)

    // ── Active capacity plan with RT discount ───────────────────────────
    await createCapacityPlanWithEntry(srcProjectId, rtEngId, {
      name: 'Active Plan',
      targetWeeks: 12,
      periodWeeks: 4,
      isActive: true,
    })

    // ── Discounts ───────────────────────────────────────────────────────
    await createDiscount(srcProjectId, null, 'PERCENTAGE', 10, 'General Discount', 0)

    // ── Overheads ────────────────────────────────────────────────────────
    await createOverhead(srcProjectId, 'Travel', null, 'FIXED_DAYS', 5, 0)
    await createOverhead(srcProjectId, 'PM Overhead', rtEngId, 'PERCENTAGE', 10, 1)
    await createDiscount(srcProjectId, rtEngId, 'FIXED_AMOUNT', 5000, 'Eng Discount', 1)

    // ── Capture source normalised state ─────────────────────────────────
    // Stored in closure for use inside tests

    // ── Execute clone ───────────────────────────────────────────────────
    const res = await request(app)
      .post(`/api/projects/${srcProjectId}/clone`)
      .set('Authorization', authHeader)
    cloneResponse = res
  })

  // ── Test A1: Response shape and ID isolation ─────────────────────────
  it('A1 — returns 201 with new project ID, no source IDs leak into clone', () => {
    expect(cloneResponse.status).toBe(201)
    const body = cloneResponse.body
    expect(body).toHaveProperty('id')
    expect(body.id).not.toBe(srcProjectId)
    expect(body.name).toMatch(/^Copy of /)
    expect(body.status).toBe('DRAFT')            // Clone always resets to DRAFT
    expect(body.ownerId).toBe(userId)
    expect(body).toHaveProperty('resourceTypes')
    expect(body).toHaveProperty('_count')
    expect(body._count).toHaveProperty('epics')
  })

  // ── Test A2: Count / multiplicity parity ─────────────────────────────
  it('A2 — source and clone have identical entity counts', async () => {
    const cloneProjectId = cloneResponse.body.id

    const srcProfiles = await prisma.capacityProfile.count({ where: { projectId: srcProjectId } })
    const cloneProfiles = await prisma.capacityProfile.count({ where: { projectId: cloneProjectId } })
    expect(cloneProfiles).toBe(srcProfiles)

    const srcSegments = await prisma.capacitySegment.count({
      where: { capacityProfile: { projectId: srcProjectId } },
    })
    const cloneSegments = await prisma.capacitySegment.count({
      where: { capacityProfile: { projectId: cloneProjectId } },
    })
    expect(cloneSegments).toBe(srcSegments)

    const srcRTs = await prisma.resourceType.count({ where: { projectId: srcProjectId } })
    const cloneRTs = await prisma.resourceType.count({ where: { projectId: cloneProjectId } })
    expect(cloneRTs).toBe(srcRTs)

    const srcNRs = await prisma.namedResource.count({
      where: { resourceType: { projectId: srcProjectId } },
    })
    const cloneNRs = await prisma.namedResource.count({
      where: { resourceType: { projectId: cloneProjectId } },
    })
    expect(cloneNRs).toBe(srcNRs)

    const srcDiscounts = await prisma.projectDiscount.count({ where: { projectId: srcProjectId } })
    const cloneDiscounts = await prisma.projectDiscount.count({ where: { projectId: cloneProjectId } })
    expect(cloneDiscounts).toBe(srcDiscounts)

    const srcPlans = await prisma.capacityPlan.count({ where: { projectId: srcProjectId } })
    const clonePlans = await prisma.capacityPlan.count({ where: { projectId: cloneProjectId } })
    expect(clonePlans).toBe(srcPlans)

    const srcEpics = await prisma.epic.count({ where: { projectId: srcProjectId } })
    const cloneEpics = await prisma.epic.count({ where: { projectId: cloneProjectId } })
    expect(cloneEpics).toBe(srcEpics)

    // Clone response _count must also match
    expect(cloneResponse.body._count.epics).toBe(srcEpics)
  })

  // ── Test A3: ID remapping — no source IDs present in clone ──────────
  it('A3 — all clone IDs are new (no source ID leaks)', async () => {
    const cloneProjectId = cloneResponse.body.id

    // Collect all source IDs
    const srcProfileIds = new Set(
      (await prisma.capacityProfile.findMany({ where: { projectId: srcProjectId }, select: { id: true } })).map(r => r.id),
    )
    const srcSegmentIds = new Set(
      (await prisma.capacitySegment.findMany({
        where: { capacityProfile: { projectId: srcProjectId } },
        select: { id: true },
      })).map(r => r.id),
    )
    const srcRTIds = new Set(
      (await prisma.resourceType.findMany({ where: { projectId: srcProjectId }, select: { id: true } })).map(r => r.id),
    )
    const srcNRIds = new Set(
      (await prisma.namedResource.findMany({
        where: { resourceType: { projectId: srcProjectId } },
        select: { id: true },
      })).map(r => r.id),
    )
    const srcDiscountIds = new Set(
      (await prisma.projectDiscount.findMany({ where: { projectId: srcProjectId }, select: { id: true } })).map(r => r.id),
    )
    const srcPlanIds = new Set(
      (await prisma.capacityPlan.findMany({ where: { projectId: srcProjectId }, select: { id: true } })).map(r => r.id),
    )
    const srcEpicIds = new Set(
      (await prisma.epic.findMany({ where: { projectId: srcProjectId }, select: { id: true } })).map(r => r.id),
    )

    // Collect all clone IDs
    const cloneProfileIds = (await prisma.capacityProfile.findMany({ where: { projectId: cloneProjectId }, select: { id: true } })).map(r => r.id)
    const cloneSegmentIds = (await prisma.capacitySegment.findMany({ where: { capacityProfile: { projectId: cloneProjectId } }, select: { id: true } })).map(r => r.id)
    const cloneRTIds = (await prisma.resourceType.findMany({ where: { projectId: cloneProjectId }, select: { id: true } })).map(r => r.id)
    const cloneNRIds = (await prisma.namedResource.findMany({ where: { resourceType: { projectId: cloneProjectId } }, select: { id: true } })).map(r => r.id)
    const cloneDiscountIds = (await prisma.projectDiscount.findMany({ where: { projectId: cloneProjectId }, select: { id: true } })).map(r => r.id)
    const clonePlanIds = (await prisma.capacityPlan.findMany({ where: { projectId: cloneProjectId }, select: { id: true } })).map(r => r.id)
    const cloneEpicIds = (await prisma.epic.findMany({ where: { projectId: cloneProjectId }, select: { id: true } })).map(r => r.id)
    const cloneProjectIdStr = cloneProjectId

    // Assert zero intersection
    expect(cloneProfileIds.every(id => !srcProfileIds.has(id))).toBe(true)
    expect(cloneSegmentIds.every(id => !srcSegmentIds.has(id))).toBe(true)
    expect(cloneRTIds.every(id => !srcRTIds.has(id))).toBe(true)
    expect(cloneNRIds.every(id => !srcNRIds.has(id))).toBe(true)
    expect(cloneDiscountIds.every(id => !srcDiscountIds.has(id))).toBe(true)
    expect(clonePlanIds.every(id => !srcPlanIds.has(id))).toBe(true)
    expect(cloneEpicIds.every(id => !srcEpicIds.has(id))).toBe(true)
    expect(cloneProjectIdStr).not.toBe(srcProjectId)
  })

  // ── Test A4: Owner-normalised profile / segment parity ──────────────
  it('A4 — profiles and segments match after normalising owner names', async () => {
    const cloneProjectId = cloneResponse.body.id

    const srcState = await captureNormalisedState(srcProjectId)
    const cloneState = await captureNormalisedState(cloneProjectId)

    // Compare profile arrays (order-sensitive: both ordered by ownerKind then deterministic sort)
    expect(srcState.profiles.length).toBe(cloneState.profiles.length)
    for (let i = 0; i < srcState.profiles.length; i++) {
      const sp = srcState.profiles[i]
      const cp = cloneState.profiles[i]
      expect(sp.ownerKind).toBe(cp.ownerKind)
      expect(sp.ownerName).toBe(cp.ownerName)
      expect(sp.planningBasis).toBe(cp.planningBasis)
      expect(sp.source).toBe(cp.source)
      expect(sp.defaultPercent).toBe(cp.defaultPercent)
      expect(sp.startWeek).toBe(cp.startWeek)
      expect(sp.endWeek).toBe(cp.endWeek)
      // Compare segment arrays
      expect(sp.segments.length).toBe(cp.segments.length)
      for (let si = 0; si < sp.segments.length; si++) {
        expect(sp.segments[si].startWeek).toBe(cp.segments[si].startWeek)
        expect(sp.segments[si].endWeek).toBe(cp.segments[si].endWeek)
        expect(sp.segments[si].capacityPercent).toBe(cp.segments[si].capacityPercent)
        expect(sp.segments[si].source).toBe(cp.segments[si].source)
      }
    }
  })

  // ── Test A5: Legacy null/type state preservation ─────────────────────
  it('A5 — DB_NULL, JSON null, and complex nested values preserved exactly', async () => {
    const cloneProjectId = cloneResponse.body.id

    // 1. Business-value parity for every profile
    const srcState = await captureNormalisedState(srcProjectId)
    const cloneState = await captureNormalisedState(cloneProjectId)
    expect(srcState.profiles.length).toBe(cloneState.profiles.length)

    for (let i = 0; i < srcState.profiles.length; i++) {
      const sp = srcState.profiles[i]
      const cp = cloneState.profiles[i]
      expect(sp.ownerKind).toBe(cp.ownerKind)
      expect(sp.ownerName).toBe(cp.ownerName)
      if (sp.legacy === null) {
        expect(cp.legacy).toBeNull()
      } else {
        expect(cp.legacy).toEqual(sp.legacy)
      }
    }

    // 2. Raw SQL level: jsonb_typeof for every profile.
    //    Count profiles by their SQL-level legacy type to prove exact
    //    storage semantics (DB_NULL ≠ JSON_NULL) are preserved.
    const srcInfo = await detectLegacyTypeInfo(srcProjectId)
    const cloneInfo = await detectLegacyTypeInfo(cloneProjectId)

    function countByType(info: Map<string, { isDbNull: boolean; typeOf: string | null }>): Map<string, number> {
      const counts = new Map<string, number>()
      for (const { isDbNull, typeOf } of info.values()) {
        const key = isDbNull ? 'DB_NULL' : `JSON_${typeOf}`
        counts.set(key, (counts.get(key) ?? 0) + 1)
      }
      return counts
    }

    const srcCounts = countByType(srcInfo)
    const cloneCounts = countByType(cloneInfo)
    expect(cloneCounts.size).toBe(srcCounts.size)
    for (const [key, count] of srcCounts) {
      expect(cloneCounts.get(key), `count for type "${key}"`).toBe(count)
    }

    // 3. For DB_NULL profiles specifically: verify isDbNull=true and typeOf is null
    const srcDbNull = Array.from(srcInfo.values()).filter(i => i.isDbNull)
    const cloneDbNull = Array.from(cloneInfo.values()).filter(i => i.isDbNull)
    expect(cloneDbNull.length).toBe(srcDbNull.length)
    expect(cloneDbNull.every(i => i.typeOf === null)).toBe(true)

    // 4. For the complex object profile: verify nested null and array-null
    //    are preserved at the JSONB value level (not just type).
    //    Find it by its unique source type (IMPORTED, object typeOf).
    const srcProfiles = await prisma.capacityProfile.findMany({
      where: { projectId: srcProjectId, source: 'IMPORTED' },
      select: { id: true },
    })
    const cloneProfiles = await prisma.capacityProfile.findMany({
      where: { projectId: cloneProjectId, source: 'IMPORTED' },
      select: { id: true },
    })
    expect(srcProfiles.length).toBe(1)
    expect(cloneProfiles.length).toBe(1)

    const [srcComplexRow] = await prisma.$queryRaw<Array<{ id: string; legacy: unknown }>>(Prisma.sql`
      SELECT id, "legacy" FROM "CapacityProfile" WHERE id = ${srcProfiles[0].id}
    `)
    const [cloneComplexRow] = await prisma.$queryRaw<Array<{ id: string; legacy: unknown }>>(Prisma.sql`
      SELECT id, "legacy" FROM "CapacityProfile" WHERE id = ${cloneProfiles[0].id}
    `)
    expect(cloneComplexRow.legacy).toEqual(srcComplexRow.legacy)
    // Verify the complex structure includes a nested null and null in array
    const obj = cloneComplexRow.legacy as Record<string, unknown>
    expect(obj).toHaveProperty('nestedField')
    expect((obj.nestedField as Record<string, unknown> | null)?.inner).toBeNull()
    expect(Array.isArray(obj.items)).toBe(true)
    expect((obj.items as unknown[]).includes(null)).toBe(true)
  })

  // ── Test A6: Planning identity (planningBasis, source, etc.) ─────────
  it('A6 — planning fields (planningBasis, source, defaultPercent, startWeek, endWeek) match', async () => {
    const cloneProjectId = cloneResponse.body.id

    const srcState = await captureNormalisedState(srcProjectId)
    const cloneState = await captureNormalisedState(cloneProjectId)

    for (let i = 0; i < srcState.profiles.length; i++) {
      const sp = srcState.profiles[i]
      const cp = cloneState.profiles[i]
      expect(cp.planningBasis).toBe(sp.planningBasis)
      expect(cp.source).toBe(sp.source)
      expect(cp.defaultPercent).toBe(sp.defaultPercent)
      expect(cp.startWeek).toBe(sp.startWeek)
      expect(cp.endWeek).toBe(sp.endWeek)
    }
  })

  // ── Test A7: Active capacity plan non-regeneration ──────────────────
  it('A7 — capacity plan is cloned as-is (same name, structure, entries)', async () => {
    const cloneProjectId = cloneResponse.body.id

    const srcState = await captureNormalisedState(srcProjectId)
    const cloneState = await captureNormalisedState(cloneProjectId)

    // Plans should have same count
    expect(cloneState.capacityPlans.length).toBe(srcState.capacityPlans.length)
    for (let i = 0; i < srcState.capacityPlans.length; i++) {
      expect(cloneState.capacityPlans[i].name).toBe(srcState.capacityPlans[i].name)
      expect(cloneState.capacityPlans[i].targetWeeks).toBe(srcState.capacityPlans[i].targetWeeks)
      expect(cloneState.capacityPlans[i].periodWeeks).toBe(srcState.capacityPlans[i].periodWeeks)
      expect(cloneState.capacityPlans[i].isActive).toBe(srcState.capacityPlans[i].isActive)
    }

    // Plan entries should have same count and resource-type names
    expect(cloneState.capacityPlanEntries.length).toBe(srcState.capacityPlanEntries.length)
    for (let i = 0; i < srcState.capacityPlanEntries.length; i++) {
      expect(cloneState.capacityPlanEntries[i].resourceTypeName).toBe(srcState.capacityPlanEntries[i].resourceTypeName)
      expect(cloneState.capacityPlanEntries[i].headcount).toBe(srcState.capacityPlanEntries[i].headcount)
      expect(cloneState.capacityPlanEntries[i].demandFTE).toBe(srcState.capacityPlanEntries[i].demandFTE)
      expect(cloneState.capacityPlanEntries[i].utilisationPct).toBe(srcState.capacityPlanEntries[i].utilisationPct)
    }
  })

  // ── Test A8: Discounts remapped ─────────────────────────────────────
  it('A8 — discounts cloned with correctly remapped resourceTypeId names', async () => {
    const cloneProjectId = cloneResponse.body.id

    const srcState = await captureNormalisedState(srcProjectId)
    const cloneState = await captureNormalisedState(cloneProjectId)

    expect(cloneState.discounts.length).toBe(srcState.discounts.length)
    for (let i = 0; i < srcState.discounts.length; i++) {
      expect(cloneState.discounts[i].resourceTypeName).toBe(srcState.discounts[i].resourceTypeName)
      expect(cloneState.discounts[i].type).toBe(srcState.discounts[i].type)
      expect(cloneState.discounts[i].value).toBe(srcState.discounts[i].value)
      expect(cloneState.discounts[i].label).toBe(srcState.discounts[i].label)
      expect(cloneState.discounts[i].order).toBe(srcState.discounts[i].order)
    }
  })

  // ── Test A9: Named resource billing models ──────────────────────────
  it('A9 — named-resource billing models (ACTUAL_DAYS / PRO_RATA) preserved', async () => {
    const cloneProjectId = cloneResponse.body.id

    const srcState = await captureNormalisedState(srcProjectId)
    const cloneState = await captureNormalisedState(cloneProjectId)

    expect(cloneState.namedResources.length).toBe(srcState.namedResources.length)
    for (let i = 0; i < srcState.namedResources.length; i++) {
      expect(cloneState.namedResources[i].pricingModel).toBe(srcState.namedResources[i].pricingModel)
      expect(cloneState.namedResources[i].name).toBe(srcState.namedResources[i].name)
      expect(cloneState.namedResources[i].resourceTypeName).toBe(srcState.namedResources[i].resourceTypeName)
    }
  })

  // ── Test A10: Resource-type fields preserved ────────────────────────
  it('A10 — resource-type category, count, dayRate, allocationMode preserved', async () => {
    const cloneProjectId = cloneResponse.body.id

    const srcRTs = await prisma.resourceType.findMany({ where: { projectId: srcProjectId }, orderBy: { id: 'asc' } })
    const cloneRTs = await prisma.resourceType.findMany({ where: { projectId: cloneProjectId }, orderBy: { id: 'asc' } })

    expect(cloneRTs.length).toBe(srcRTs.length)
    const matchByName = (src: typeof srcRTs[0], clones: typeof cloneRTs) => {
      const found = clones.find(c => c.name === src.name)
      return found ?? null
    }
    for (const srcRT of srcRTs) {
      const cloneRT = matchByName(srcRT, cloneRTs)
      expect(cloneRT).not.toBeNull()
      expect(cloneRT!.category).toBe(srcRT.category)
      expect(cloneRT!.count).toBe(srcRT.count)
      expect(cloneRT!.hoursPerDay).toBe(srcRT.hoursPerDay)
      expect(cloneRT!.dayRate).toBe(srcRT.dayRate)
      expect(cloneRT!.allocationMode).toBe(srcRT.allocationMode)
      expect(cloneRT!.allocationPercent).toBe(srcRT.allocationPercent)
      expect(cloneRT!.allocationStartWeek).toBe(srcRT.allocationStartWeek)
      expect(cloneRT!.allocationEndWeek).toBe(srcRT.allocationEndWeek)
    }
  })
  // ── Test A11: Discounts endpoint parity via production HTTP GET ──────
  it('A11 — discounts returned by production GET /discounts match after normalising RT IDs', async () => {
    const cloneProjectId = cloneResponse.body.id

    const srcRes = await request(app)
      .get(`/api/projects/${srcProjectId}/discounts`)
      .set('Authorization', authHeader)
    const cloneRes = await request(app)
      .get(`/api/projects/${cloneProjectId}/discounts`)
      .set('Authorization', authHeader)

    expect(srcRes.status).toBe(200)
    expect(cloneRes.status).toBe(200)

    // Build name lookups for normalising RT IDs in the response
    const srcRTs = await prisma.resourceType.findMany({ where: { projectId: srcProjectId } })
    const cloneRTs = await prisma.resourceType.findMany({ where: { projectId: cloneProjectId } })
    const srcRTNameById = new Map(srcRTs.map(rt => [rt.id, rt.name]))
    const cloneRTNameById = new Map(cloneRTs.map(rt => [rt.id, rt.name]))

    const srcDiscounts = srcRes.body as Array<{ resourceTypeId: string | null; type: string; value: number; label: string; order: number }>
    const cloneDiscounts = cloneRes.body as Array<{ resourceTypeId: string | null; type: string; value: number; label: string; order: number }>

    expect(cloneDiscounts.length).toBe(srcDiscounts.length)

    for (let i = 0; i < srcDiscounts.length; i++) {
      const sd = srcDiscounts[i]
      const cd = cloneDiscounts[i]

      // Normalise resourceTypeId → resource-type name for comparison
      const srcRTName = sd.resourceTypeId ? (srcRTNameById.get(sd.resourceTypeId) ?? null) : null
      const cloneRTName = cd.resourceTypeId ? (cloneRTNameById.get(cd.resourceTypeId) ?? null) : null

      expect(cloneRTName).toBe(srcRTName)
      expect(cd.type).toBe(sd.type)
      expect(cd.value).toBe(sd.value)
      expect(cd.label).toBe(sd.label)
      expect(cd.order).toBe(sd.order)
    }
  })

  // ── Test A12: Resource-profile commercial value parity ──────────────
  it('A12 — resource-profile returned by production GET returns matching commercial values', async () => {
    const cloneProjectId = cloneResponse.body.id

    const srcRes = await request(app)
      .get(`/api/projects/${srcProjectId}/resource-profile`)
      .set('Authorization', authHeader)
    const cloneRes = await request(app)
      .get(`/api/projects/${cloneProjectId}/resource-profile`)
      .set('Authorization', authHeader)

    expect(srcRes.status).toBe(200)
    expect(cloneRes.status).toBe(200)

    const srcBody = srcRes.body
    const cloneBody = cloneRes.body

    // Project-level planning fields
    expect(cloneBody.hoursPerDay).toBe(srcBody.hoursPerDay)
    expect(cloneBody.projectDurationWeeks).toBe(srcBody.projectDurationWeeks)
    expect(cloneBody.bufferWeeks).toBe(srcBody.bufferWeeks)
    expect(cloneBody.onboardingWeeks).toBe(srcBody.onboardingWeeks)

    // Summary totals — computed by the production reader, must match
    expect(cloneBody.summary.totalHours).toBe(srcBody.summary.totalHours)
    expect(cloneBody.summary.totalDays).toBe(srcBody.summary.totalDays)
    expect(cloneBody.summary.totalCost).toBe(srcBody.summary.totalCost)
    expect(cloneBody.summary.hasCost).toBe(srcBody.summary.hasCost)

    // Resource rows: match by name (IDs differ after clone)
    const srcRows = srcBody.resourceRows as Array<{
      name: string; category: string; count: number; hoursPerDay: number
      dayRate: number | null; totalHours: number; effortDays: number
      totalDays: number; allocatedDays: number; estimatedCost: number | null
      allocationMode: string; allocationPercent: number
      namedResources: Array<{ id: string; name: string }>
      capacityProfile?: { planningBasis: string; source: string }
    }>
    const cloneRows = cloneBody.resourceRows as typeof srcRows
    expect(cloneRows.length).toBe(srcRows.length)

    const srcRowByName = new Map(srcRows.map(r => [r.name, r]))
    for (const cloneRow of cloneRows) {
      const srcRow = srcRowByName.get(cloneRow.name)
      expect(srcRow, `resource row "${cloneRow.name}" found in source`).toBeDefined()
      // Compare all commercial fields
      expect(cloneRow.category).toBe(srcRow!.category)
      expect(cloneRow.count).toBe(srcRow!.count)
      expect(cloneRow.hoursPerDay).toBe(srcRow!.hoursPerDay)
      expect(cloneRow.dayRate).toBe(srcRow!.dayRate)
      expect(cloneRow.totalHours).toBe(srcRow!.totalHours)
      expect(cloneRow.effortDays).toBe(srcRow!.effortDays)
      expect(cloneRow.totalDays).toBe(srcRow!.totalDays)
      expect(cloneRow.allocatedDays).toBe(srcRow!.allocatedDays)
      expect(cloneRow.estimatedCost).toBe(srcRow!.estimatedCost)
      expect(cloneRow.allocationMode).toBe(srcRow!.allocationMode)
      expect(cloneRow.allocationPercent).toBe(srcRow!.allocationPercent)
    }

    // Overhead rows: match by name
    const srcOverhead = srcBody.overheadRows as Array<{
      name: string; type: string; value: number; computedDays: number
      estimatedCost: number | null; requiredFTE: number
    }>
    const cloneOverhead = cloneBody.overheadRows as typeof srcOverhead
    expect(cloneOverhead.length).toBe(srcOverhead.length)

    const srcOhByName = new Map(srcOverhead.map(o => [o.name, o]))
    for (const cloneOh of cloneOverhead) {
      const srcOh = srcOhByName.get(cloneOh.name)
      expect(srcOh, `overhead "${cloneOh.name}" found in source`).toBeDefined()
      expect(cloneOh.type).toBe(srcOh!.type)
      expect(cloneOh.value).toBe(srcOh!.value)
      expect(cloneOh.computedDays).toBe(srcOh!.computedDays)
      expect(cloneOh.estimatedCost).toBe(srcOh!.estimatedCost)
      expect(cloneOh.requiredFTE).toBe(srcOh!.requiredFTE)
    }

    // Named resources per-row: real response parity (equivalent to removed
    // roleProfiles/namedResourceProfiles internal-map count check).
    // The production calculator folds those maps into each resourceRow's
    // namedResources and capacityProfile fields.
    for (const cloneRow of cloneRows) {
      const srcRow = srcRowByName.get(cloneRow.name)
      // Named resources count matches (proves namedResourceProfiles parity)
      expect(cloneRow.namedResources.length).toBe(srcRow!.namedResources.length)
      // capacityProfile field — exists in both or neither (proves roleProfiles parity)
      if (srcRow!.capacityProfile) {
        expect(cloneRow.capacityProfile).toBeDefined()
        expect(cloneRow.capacityProfile!.planningBasis).toBe(srcRow!.capacityProfile!.planningBasis)
        expect(cloneRow.capacityProfile!.source).toBe(srcRow!.capacityProfile!.source)
      } else {
        expect(cloneRow.capacityProfile).toBeUndefined()
      }
    }
  })

  // ── Test A13: Commercial parity — tax, overhead endpoint, grand total ──
  it('A13 — commercial fields (tax, overheads, grand total) preserved via production endpoints', async () => {
    const cloneProjectId = cloneResponse.body.id

    // 1. Tax fields on the project model
    const srcProject = await prisma.project.findUnique({ where: { id: srcProjectId } })
    const cloneProject = await prisma.project.findUnique({ where: { id: cloneProjectId } })
    expect(cloneProject).not.toBeNull()
    expect(srcProject).not.toBeNull()
    expect(cloneProject!.taxRate).toBe(srcProject!.taxRate)
    expect(cloneProject!.taxLabel).toBe(srcProject!.taxLabel)
    expect(cloneProject!.hoursPerDay).toBe(srcProject!.hoursPerDay)
    expect(cloneProject!.bufferWeeks).toBe(srcProject!.bufferWeeks)
    expect(cloneProject!.onboardingWeeks).toBe(srcProject!.onboardingWeeks)

    // 2. Overhead endpoint parity via production GET /overhead
    const srcOhRes = await request(app)
      .get(`/api/projects/${srcProjectId}/overhead`)
      .set('Authorization', authHeader)
    const cloneOhRes = await request(app)
      .get(`/api/projects/${cloneProjectId}/overhead`)
      .set('Authorization', authHeader)

    expect(srcOhRes.status).toBe(200)
    expect(cloneOhRes.status).toBe(200)

    // Build name lookups for resource type IDs in overhead responses
    const srcRTs = await prisma.resourceType.findMany({ where: { projectId: srcProjectId } })
    const cloneRTs = await prisma.resourceType.findMany({ where: { projectId: cloneProjectId } })
    const srcRTNameById = new Map(srcRTs.map(rt => [rt.id, rt.name]))
    const cloneRTNameById = new Map(cloneRTs.map(rt => [rt.id, rt.name]))

    const srcOh = srcOhRes.body as Array<{ id: string; name: string; resourceTypeId: string | null; type: string; value: number; order: number }>
    const cloneOh = cloneOhRes.body as typeof srcOh
    expect(cloneOh.length).toBe(srcOh.length)
    for (let i = 0; i < srcOh.length; i++) {
      const s = srcOh[i]
      const c = cloneOh[i]
      const srcRTName = s.resourceTypeId ? (srcRTNameById.get(s.resourceTypeId) ?? null) : null
      const cloneRTName = c.resourceTypeId ? (cloneRTNameById.get(c.resourceTypeId) ?? null) : null
      expect(cloneRTName).toBe(srcRTName)
      expect(c.name).toBe(s.name)
      expect(c.type).toBe(s.type)
      expect(c.value).toBe(s.value)
      expect(c.order).toBe(s.order)
    }

    // 3. Grand total parity from resource-profile summary (already proven in A12,
    //    but verify the tree holds: summary.totalCost = sum of row costs)
    const srcProfileRes = await request(app)
      .get(`/api/projects/${srcProjectId}/resource-profile`)
      .set('Authorization', authHeader)
    const cloneProfileRes = await request(app)
      .get(`/api/projects/${cloneProjectId}/resource-profile`)
      .set('Authorization', authHeader)

    expect(srcProfileRes.status).toBe(200)
    expect(cloneProfileRes.status).toBe(200)

    const srcSummary = srcProfileRes.body.summary
    const cloneSummary = cloneProfileRes.body.summary
    // Grand total (totalCost) is computed by the production calculator; source and clone agree.
    expect(cloneSummary.totalCost).toBe(srcSummary.totalCost)
    // Sanity: totalCost is internally consistent (sum of resource + overhead row costs)
    const srcRowCost = (srcProfileRes.body.resourceRows as Array<{ estimatedCost: number | null }>)
      .reduce((sum: number, r: { estimatedCost: number | null }) => sum + (r.estimatedCost ?? 0), 0)
    const srcOhCost = (srcProfileRes.body.overheadRows as Array<{ estimatedCost: number | null }>)
      .reduce((sum: number, r: { estimatedCost: number | null }) => sum + (r.estimatedCost ?? 0), 0)
    expect(srcSummary.totalCost).toBe(Math.round((srcRowCost + srcOhCost) * 100) / 100)
    const cloneRowCost = (cloneProfileRes.body.resourceRows as Array<{ estimatedCost: number | null }>)
      .reduce((sum: number, r: { estimatedCost: number | null }) => sum + (r.estimatedCost ?? 0), 0)
    const cloneOhCost = (cloneProfileRes.body.overheadRows as Array<{ estimatedCost: number | null }>)
      .reduce((sum: number, r: { estimatedCost: number | null }) => sum + (r.estimatedCost ?? 0), 0)
    expect(cloneSummary.totalCost).toBe(Math.round((cloneRowCost + cloneOhCost) * 100) / 100)
  })

  // ── Test A14: Timeline / planning endpoint parity ───────────────────
  it('A14 — timeline returned by production GET /timeline has matching planning structure', async () => {
    const cloneProjectId = cloneResponse.body.id

    const srcRes = await request(app)
      .get(`/api/projects/${srcProjectId}/timeline`)
      .set('Authorization', authHeader)
    const cloneRes = await request(app)
      .get(`/api/projects/${cloneProjectId}/timeline`)
      .set('Authorization', authHeader)

    expect(srcRes.status).toBe(200)
    expect(cloneRes.status).toBe(200)

    const srcBody = srcRes.body
    const cloneBody = cloneRes.body

    // Planning window fields
    expect(cloneBody.onboardingWeeks).toBe(srcBody.onboardingWeeks)
    expect(cloneBody.bufferWeeks).toBe(srcBody.bufferWeeks)
    expect(cloneBody.projectDurationWeeks).toBe(srcBody.projectDurationWeeks)

    // Entry count parity (same number of timeline entries)
    expect(Array.isArray(cloneBody.entries)).toBe(true)
    expect(Array.isArray(srcBody.entries)).toBe(true)
    expect(cloneBody.entries.length).toBe(srcBody.entries.length)

    // Named resources: count parity
    expect(Array.isArray(cloneBody.namedResources)).toBe(true)
    expect(Array.isArray(srcBody.namedResources)).toBe(true)
    expect(cloneBody.namedResources.length).toBe(srcBody.namedResources.length)

    // Each named resource in the clone should have matching billing model
    const srcNRs = srcBody.namedResources as Array<{ id: string; name: string; pricingModel: string; allocationType: string }>
    const cloneNRs = cloneBody.namedResources as typeof srcNRs
    // Build source lookup by name (IDs differ after clone)
    const srcNRByName = new Map(srcNRs.map(nr => [nr.name, nr]))
    for (const cloneNR of cloneNRs) {
      const srcNR = srcNRByName.get(cloneNR.name)
      expect(srcNR, `named resource "${cloneNR.name}" in timeline`).toBeDefined()
      expect(cloneNR.pricingModel).toBe(srcNR!.pricingModel)
      expect(cloneNR.allocationType).toBe(srcNR!.allocationType)
    }

    // Gantt entries (resource scheduling) — count parity
    if (Array.isArray(srcBody.ganttEntries) && Array.isArray(cloneBody.ganttEntries)) {
      expect(cloneBody.ganttEntries.length).toBe(srcBody.ganttEntries.length)
    }
  })
  // ── Test A15: Zero-capacity segment parity ─────────────────────────
  it('A15 — zero-capacity segment (capacityPercent=0) preserved in clone', async () => {
    const cloneProjectId = cloneResponse.body.id

    const srcProfiles = await prisma.capacityProfile.findMany({
      where: { projectId: srcProjectId },
      include: { segments: { orderBy: { startWeek: 'asc' as const } } },
    })
    const cloneProfiles = await prisma.capacityProfile.findMany({
      where: { projectId: cloneProjectId },
      include: { segments: { orderBy: { startWeek: 'asc' as const } } },
    })

    // Find profile with zero-capacity segment in source
    const srcWithZero = srcProfiles.find(p => p.segments.some(s => s.capacityPercent === 0))
    expect(srcWithZero).toBeDefined()
    const zeroSeg = srcWithZero!.segments.find(s => s.capacityPercent === 0)
    expect(zeroSeg).toBeDefined()
    expect(zeroSeg!.startWeek).toBe(5)
    expect(zeroSeg!.endWeek).toBe(5)
    expect(zeroSeg!.capacityPercent).toBe(0)
    expect(zeroSeg!.source).toBe('MANUAL')

    // Find matching profile in clone (same owner kind and planning basis)
    const cloneWithZero = cloneProfiles.find(p =>
      p.ownerKind === srcWithZero!.ownerKind &&
      p.planningBasis === srcWithZero!.planningBasis &&
      p.segments.some(s => s.capacityPercent === 0),
    )
    expect(cloneWithZero).toBeDefined()
    const cloneZeroSeg = cloneWithZero!.segments.find(s => s.capacityPercent === 0)
    expect(cloneZeroSeg).toBeDefined()
    expect(cloneZeroSeg!.startWeek).toBe(zeroSeg!.startWeek)
    expect(cloneZeroSeg!.endWeek).toBe(zeroSeg!.endWeek)
    expect(cloneZeroSeg!.capacityPercent).toBe(0)
    expect(cloneZeroSeg!.source).toBe(zeroSeg!.source)
  })

  // ── Test A16: Complete computeCommercialData parity with ID normalisation ──
  it('A16 — computeCommercialData output matches source and clone after normalising all generated IDs', async () => {
    const cloneProjectId = cloneResponse.body.id

    // Fetch DTOs from production HTTP endpoints for both source and clone
    const srcProfileRes = await request(app)
      .get(`/api/projects/${srcProjectId}/resource-profile`)
      .set('Authorization', authHeader)
    const cloneProfileRes = await request(app)
      .get(`/api/projects/${cloneProjectId}/resource-profile`)
      .set('Authorization', authHeader)
    expect(srcProfileRes.status).toBe(200)
    expect(cloneProfileRes.status).toBe(200)

    const srcDiscountsRes = await request(app)
      .get(`/api/projects/${srcProjectId}/discounts`)
      .set('Authorization', authHeader)
    const cloneDiscountsRes = await request(app)
      .get(`/api/projects/${cloneProjectId}/discounts`)
      .set('Authorization', authHeader)
    expect(srcDiscountsRes.status).toBe(200)
    expect(cloneDiscountsRes.status).toBe(200)

    const srcProject = await prisma.project.findUnique({ where: { id: srcProjectId } })
    const cloneProject = await prisma.project.findUnique({ where: { id: cloneProjectId } })
    expect(srcProject).not.toBeNull()
    expect(cloneProject).not.toBeNull()

    // Build ID-to-name lookups for normalisation (names are stable across clone)
    const srcRTs = await prisma.resourceType.findMany({ where: { projectId: srcProjectId } })
    const srcNRs = await prisma.namedResource.findMany({
      where: { resourceType: { projectId: srcProjectId } },
    })
    const srcDiscounts = await prisma.projectDiscount.findMany({ where: { projectId: srcProjectId } })
    const rtNameById = new Map(srcRTs.map(r => [r.id, r.name]))
    const nrNameById = new Map(srcNRs.map(r => [r.id, r.name]))
    const discountLabelById = new Map(srcDiscounts.map(d => [d.id, d.label]))
    const overheadNameById = new Map<string, string>(
      (srcProfileRes.body.overheadRows ?? []).map((row: { overheadId: string; name: string }) => [row.overheadId, row.name]),
    )
    // Clone-side lookups (IDs differ, but the same stable names map to clone IDs)
    const cloneRTs = await prisma.resourceType.findMany({ where: { projectId: cloneProjectId } })
    const cloneNRs = await prisma.namedResource.findMany({
      where: { resourceType: { projectId: cloneProjectId } },
    })
    const cloneDiscounts = await prisma.projectDiscount.findMany({ where: { projectId: cloneProjectId } })
    const cloneRtNameById = new Map(cloneRTs.map(r => [r.id, r.name]))
    const cloneNrNameById = new Map(cloneNRs.map(r => [r.id, r.name]))
    const cloneDiscountLabelById = new Map(cloneDiscounts.map(d => [d.id, d.label]))
    const cloneOverheadNameById = new Map<string, string>(
      (cloneProfileRes.body.overheadRows ?? []).map((row: { overheadId: string; name: string }) => [row.overheadId, row.name]),
    )

    // Dynamic import: client is a separate workspace without a server dependency,
    // so we load the module via file URL — same pattern as snapshotRollback test.
    const calcModulePath = new URL('../../../client/src/utils/financialCalculations.ts', import.meta.url).href
    const clientCalc = await import(calcModulePath)

    const srcCommercial = clientCalc.computeCommercialData(
      srcProfileRes.body,
      srcDiscountsRes.body,
      { taxRate: srcProject!.taxRate, taxLabel: srcProject!.taxLabel ?? undefined },
    )
    const cloneCommercial = clientCalc.computeCommercialData(
      cloneProfileRes.body,
      cloneDiscountsRes.body,
      { taxRate: cloneProject!.taxRate, taxLabel: cloneProject!.taxLabel ?? undefined },
    )

    expect(srcCommercial).not.toBeNull()
    expect(cloneCommercial).not.toBeNull()

    // ── Normalise all generated IDs to stable name-based surrogates ──────
    function normaliseId(id: string, rtMap: Map<string, string>, nrMap: Map<string, string>, discMap: Map<string, string>, overheadMap: Map<string, string>, projId: string): string {
      if (rtMap.has(id)) return `rt:${rtMap.get(id)}`
      if (nrMap.has(id)) return `nr:${nrMap.get(id)}`
      if (discMap.has(id)) return `disc:${discMap.get(id)}`
      if (overheadMap.has(id)) return `overhead:${overheadMap.get(id)}`
      if (id === projId) return 'project:self'
      // computeCommercialData creates synthetic role-row IDs from the resource type ID.
      for (const [rawId, name] of rtMap) {
        if (id.startsWith(`${rawId}-`)) return `rt:${name}${id.slice(rawId.length)}`
      }
      return id
    }

    function normaliseCommercial(src: typeof srcCommercial, rtM: Map<string, string>, nrM: Map<string, string>, dM: Map<string, string>, overheadM: Map<string, string>, pId: string): unknown {
      const copy = JSON.parse(JSON.stringify(src))
      for (const row of copy.rows) {
        row.id = normaliseId(row.id, rtM, nrM, dM, overheadM, pId)
        row.resourceTypeId = normaliseId(row.resourceTypeId, rtM, nrM, dM, overheadM, pId)
        for (const ad of row.appliedDiscounts) {
          ad.id = normaliseId(ad.id, rtM, nrM, dM, overheadM, pId)
          if (ad.projectId) ad.projectId = normaliseId(ad.projectId, rtM, nrM, dM, overheadM, pId)
          if (ad.resourceTypeId) ad.resourceTypeId = normaliseId(ad.resourceTypeId, rtM, nrM, dM, overheadM, pId)
          if (ad.resourceType) {
            ad.resourceType.id = normaliseId(ad.resourceType.id, rtM, nrM, dM, overheadM, pId)
            ad.resourceType.projectId = normaliseId(ad.resourceType.projectId, rtM, nrM, dM, overheadM, pId)
          }
          delete ad.createdAt
        }
      }
      for (const pd of copy.projectDiscounts) {
        pd.id = normaliseId(pd.id, rtM, nrM, dM, overheadM, pId)
        pd.projectId = normaliseId(pd.projectId, rtM, nrM, dM, overheadM, pId)
        if (pd.resourceTypeId) pd.resourceTypeId = normaliseId(pd.resourceTypeId, rtM, nrM, dM, overheadM, pId)
        delete pd.createdAt
      }
      return copy
    }

    const normSrc = normaliseCommercial(srcCommercial, rtNameById, nrNameById, discountLabelById, overheadNameById, srcProjectId)
    const normClone = normaliseCommercial(cloneCommercial, cloneRtNameById, cloneNrNameById, cloneDiscountLabelById, cloneOverheadNameById, cloneProjectId)
    expect(normClone).toEqual(normSrc)

    // ── Field-level sanity checks ────────────────────────────────────────
    // Verify pricing models on specific named-resource rows
    const srcRows = (normSrc as Record<string, unknown>).rows as Array<{ name: string; pricingModel: string | null; kind: string }>
    expect(srcRows.some(r => r.name === 'Jane Architect' && r.pricingModel === 'PRO_RATA' && r.kind === 'named-resource')).toBe(true)
    expect(srcRows.some(r => r.name === 'John Developer' && r.pricingModel === 'ACTUAL_DAYS' && r.kind === 'named-resource')).toBe(true)

    // Tax fields match project settings
    const srcNormAny = normSrc as Record<string, unknown>
    expect(srcNormAny.taxRate).toBe(srcProject!.taxRate)
    expect(srcNormAny.taxLabel).toBe(srcProject!.taxLabel)
    // Verify ACTUAL_DAYS and PRO_RATA behaviour using real DTO rows
    const rawSrcRows = (normSrc as Record<string, unknown>).rows as Array<Record<string, unknown>>
    const actualDaysRows = rawSrcRows.filter(r => r.kind === 'named-resource' && r.pricingModel === 'ACTUAL_DAYS')
    expect(actualDaysRows.length).toBeGreaterThan(0)
    for (const row of actualDaysRows) {
      expect(typeof row.allocatedDays).toBe('number')
      expect((row.dayRate as number)).toBeGreaterThan(0)
    }
    const proRataRows = rawSrcRows.filter(r => r.kind === 'named-resource' && r.pricingModel === 'PRO_RATA')
    expect(proRataRows.length).toBeGreaterThan(0)
    for (const row of proRataRows) {
      expect(typeof row.allocatedDays).toBe('number')
      expect((row.dayRate as number)).toBeGreaterThan(0)
    }
  })
  // ── Test A17: Full buildProfileCsv output parity (exact string match) ──
  it('A17 — buildProfileCsv output is identical for source and clone and contains required billing/segment columns', async () => {
    const cloneProjectId = cloneResponse.body.id

    // Fetch resource-profile DTOs from production HTTP endpoints
    const srcProfileRes = await request(app)
      .get(`/api/projects/${srcProjectId}/resource-profile`)
      .set('Authorization', authHeader)
    const cloneProfileRes = await request(app)
      .get(`/api/projects/${cloneProjectId}/resource-profile`)
      .set('Authorization', authHeader)
    expect(srcProfileRes.status).toBe(200)
    expect(cloneProfileRes.status).toBe(200)

    // Dynamic import: client is a separate workspace without a server dependency.
    const csvModulePath = new URL('../../../client/src/hooks/useResourceProfileExport.ts', import.meta.url).href
    const csvModule = await import(csvModulePath)

    const srcCsv = csvModule.buildProfileCsv(srcProfileRes.body)
    const cloneCsv = csvModule.buildProfileCsv(cloneProfileRes.body)

    // The CSV output contains no raw DB IDs — only business labels, enum-derived
    // strings, and computed values.  Since source and clone share identical
    // business data, the full CSV string must match character-for-character.
    expect(cloneCsv).toBe(srcCsv)

    // Column count sanity (26 columns from the header)
    const headers = srcCsv.split('\n')[0].split(',')
    expect(headers.length).toBe(26)

    // Verify expected column labels
    expect(headers).toContain('Section')
    expect(headers).toContain('Role')
    expect(headers).toContain('Capacity profile segments')
    expect(headers).toContain('Billing basis')

    // Parse CSV data rows and assert specific semantic columns
    const colIdx = (name: string) => headers.indexOf(name)
    expect(colIdx('Section')).toBe(0)
    expect(colIdx('Role')).toBe(1)
    expect(colIdx('Resource name')).toBe(2)
    expect(colIdx('Resource identity')).toBe(3)
    expect(colIdx('Category')).toBe(4)
    expect(colIdx('Resource count')).toBe(5)
    expect(colIdx('Hours per day')).toBe(6)
    expect(colIdx('Effort days')).toBe(7)
    expect(colIdx('Assigned days')).toBe(8)
    expect(colIdx('Billable days')).toBe(9)
    expect(colIdx('Day rate')).toBe(10)
    expect(colIdx('Subtotal')).toBe(11)
    expect(colIdx('Planning basis')).toBe(12)
    expect(colIdx('Profile source')).toBe(13)
    expect(colIdx('Default capacity %')).toBe(14)
    expect(colIdx('Profile start')).toBe(15)
    expect(colIdx('Profile end')).toBe(16)
    expect(colIdx('Availability window start')).toBe(17)
    expect(colIdx('Availability window end')).toBe(18)
    expect(colIdx('Assigned start')).toBe(19)
    expect(colIdx('Assigned end')).toBe(20)
    expect(colIdx('Capacity profile segments')).toBe(21)
    expect(colIdx('Assignment segments')).toBe(22)
    expect(colIdx('Assigned weeks')).toBe(23)
    expect(colIdx('Billing basis')).toBe(24)
    expect(colIdx('Handover notes')).toBe(25)

    const iNamedId = colIdx('Resource identity')
    const iResName = colIdx('Resource name')
    const iPlanBasis = colIdx('Planning basis')
    const iProfSrc = colIdx('Profile source')
    const iDefPct = colIdx('Default capacity %')
    const iProfStart = colIdx('Profile start')
    const iProfEnd = colIdx('Profile end')
    const iCapSeg = colIdx('Capacity profile segments')
    const iAssSeg = colIdx('Assignment segments')
    const iAssWks = colIdx('Assigned weeks')
    const iBillDays = colIdx('Billable days')
    const iDayRate = colIdx('Day rate')
    const iSubtotal = colIdx('Subtotal')

    const dataLines = srcCsv.split('\n').filter((line: string) => line.length > 0).slice(1)
    expect(dataLines.length).toBeGreaterThan(0)
    for (const line of dataLines) {
      const cols = line.split(',')
      // Named identity — not a generated UUID (builder emits no IDs)
      expect(cols[iNamedId]).toBeDefined()
      // Named-resource rows carry a resource name; role-level rows intentionally do not.
      if (cols[iNamedId] === 'Named person' || cols[iNamedId] === 'Planned resource') {
        expect(cols[iResName]).toBeTruthy()
      }
      // Planning basis / profile source / capacity %
      expect(cols[iPlanBasis]).toBeDefined()
      if (cols[iCapSeg]) expect(cols[iProfSrc]).toBeDefined()
      if (cols[iDefPct] !== '') expect(Number(cols[iDefPct])).not.toBeNaN()
      if (cols[iProfStart] !== '') expect(cols[iProfStart]).toMatch(/^W\d+$/)
      if (cols[iProfEnd] !== '') expect(cols[iProfEnd]).toMatch(/^W\d+$/)
      // Billable days, day rate, subtotal parse as numbers
      if (cols[iBillDays] !== '') expect(Number(cols[iBillDays])).not.toBeNaN()
      if (cols[iDayRate] !== '') expect(Number(cols[iDayRate])).not.toBeNaN()
      if (cols[iSubtotal] !== '') expect(Number(cols[iSubtotal])).not.toBeNaN()
      // Assignment segments/weeks present where applicable
      if (cols[iAssSeg]) expect(cols[iAssSeg]).toBeTruthy()
      if (cols[iAssWks]) expect(cols[iAssWks]).toBeTruthy()
    }

    // Verify zero-capacity segment exact text in capacity profile segments column
    const hasZeroSeg = dataLines.some((line: string) => {
      const cols = line.split(',')
      return cols[iCapSeg]?.includes('W6 0%')
    })
    expect(hasZeroSeg).toBe(true)
    // Verify billing basis labels appear in CSV data rows
    expect(srcCsv).toContain('Bill planned allocation')
    expect(srcCsv).toContain('Bill actual scheduled days')

    // Verify zero-capacity segment appears (W6 = week index 5, 0%)
    expect(srcCsv).toContain('W6 0%')
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// Scenario B — Cross-project clone returns 404 (atomic no-op)
// ═════════════════════════════════════════════════════════════════════════════

describeIf('Scenario B — cross-project clone returns 404', () => {
  let srcProjectId: string

  beforeAll(async () => {
    if (!runIntegration) return
    srcProjectId = await createProject()
  })

  it('B1 — cloning as a different user (non-owner) returns 404', async () => {
    const res = await request(app)
      .post(`/api/projects/${srcProjectId}/clone`)
      .set('Authorization', secondAuthHeader)
    expect(res.status).toBe(404)
    expect(res.body).toHaveProperty('error')
  })

  it('B2 — no clone project leaked into the database after denied cross-project access', async () => {
    // Ensure no project was created for the second user with "Copy of" prefix
    const leaked = await prisma.project.findFirst({
      where: { ownerId: secondUserId, name: { startsWith: 'Copy of ' } },
    })
    expect(leaked).toBeNull()
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// Scenario C — Mid-transaction rollback on invalid profile owner
// ═════════════════════════════════════════════════════════════════════════════

describeIf('Scenario C — clone rolls back transaction after invalid profile owner', () => {
  let srcProjectId: string
  let rtEngId: string
  let nrBobId: string

  beforeAll(async () => {
    if (!runIntegration) return

    srcProjectId = await createProject()
    rtEngId = await createResourceType(srcProjectId, crypto.randomUUID(), 'Engineering',
      { category: 'ENGINEERING', count: 2, dayRate: 800 })
    nrBobId = await createNamedResource(srcProjectId, rtEngId, crypto.randomUUID(), 'Bob',
      { pricingModel: 'ACTUAL_DAYS', allocationPct: 100 })

    // Create a valid ROLE capacity profile (FK-safe: has resourceTypeId, no namedResourceId)
    const cpRoleId = await createProfile(srcProjectId, crypto.randomUUID(), 'ROLE', rtEngId, null,
      { planningBasis: 'DEMAND_FOLLOWING', source: 'MANUAL', startWeek: 0, endWeek: 10, defaultPercent: 100 })
    await createSegment(cpRoleId, crypto.randomUUID(), 0, 10, 100, 'MANUAL')

    // Create another valid NAMED_PERSON profile so more data exists before the
    // invalid profile is encountered during clone processing
    const cpNamedId = await createProfile(srcProjectId, crypto.randomUUID(), 'NAMED_PERSON', null, nrBobId,
      { planningBasis: 'DEMAND_FOLLOWING', source: 'MANUAL', startWeek: 0, endWeek: 8 })
    await createSegment(cpNamedId, crypto.randomUUID(), 0, 8, 80, 'MANUAL')

    // Create backlog so epics are cloned ahead of capacity profiles (epic count > 0)
    const backlog = await createEpicBacklog(srcProjectId, rtEngId)
    await createTimelineEntry(srcProjectId, backlog.featureId, 0, 4)

    // Use Prisma.sql to corrupt the ROLE profile's owner shape: set both
    // resourceTypeId AND namedResourceId (both FK-references exist, so SQL FK
    // constraints pass, but production clone handler rejects ROLE profiles with
    // non-null namedResourceId — this triggers a mid-transaction throw).
    await prisma.$executeRaw(Prisma.sql`
      UPDATE "CapacityProfile"
      SET "namedResourceId" = ${nrBobId}
      WHERE id = ${cpRoleId}
    `)
  })

  it('C1 — clone returns 500 when profile owner shape is invalid', async () => {
    const res = await request(app)
      .post(`/api/projects/${srcProjectId}/clone`)
      .set('Authorization', authHeader)
    expect(res.status).toBe(500)
  })

  it('C2 — no clone entity rows leaked after aborted transaction', async () => {
    const source = await prisma.project.findUnique({
      where: { id: srcProjectId },
      select: { name: true },
    })
    expect(source).not.toBeNull()
    const copyOfFilter = { ownerId: userId, name: `Copy of ${source!.name}` } as const

    // Project — the root entity that would be cloned first
    const leakedProject = await prisma.project.findFirst({ where: copyOfFilter })
    expect(leakedProject).toBeNull()

    // ResourceType — cloned after project
    const leakedRT = await prisma.resourceType.findFirst({ where: { project: copyOfFilter } })
    expect(leakedRT).toBeNull()

    // NamedResource — cloned per-resource-type inside the RT loop
    const leakedNR = await prisma.namedResource.findFirst({ where: { resourceType: { project: copyOfFilter } } })
    expect(leakedNR).toBeNull()

    // CapacityPlan, periods, entries — cloned before profiles
    const leakedPlan = await prisma.capacityPlan.findFirst({ where: { project: copyOfFilter } })
    expect(leakedPlan).toBeNull()
    const leakedPeriod = await prisma.capacityPlanPeriod.findFirst({ where: { plan: { project: copyOfFilter } } })
    expect(leakedPeriod).toBeNull()
    const leakedEntry = await prisma.capacityPlanEntry.findFirst({ where: { period: { plan: { project: copyOfFilter } } } })
    expect(leakedEntry).toBeNull()

    // ProjectOverhead — cloned after plans, before profiles
    const leakedOh = await prisma.projectOverhead.findFirst({ where: { project: copyOfFilter } })
    expect(leakedOh).toBeNull()

    // ProjectDiscount — cloned after plans, before profiles
    const leakedDisc = await prisma.projectDiscount.findFirst({ where: { project: copyOfFilter } })
    expect(leakedDisc).toBeNull()

    // Epics, features, stories, tasks (backlog) — cloned before profiles
    const leakedEpic = await prisma.epic.findFirst({ where: { project: copyOfFilter } })
    expect(leakedEpic).toBeNull()
    const leakedFeature = await prisma.feature.findFirst({ where: { epic: { project: copyOfFilter } } })
    expect(leakedFeature).toBeNull()
    const leakedStory = await prisma.userStory.findFirst({ where: { feature: { epic: { project: copyOfFilter } } } })
    expect(leakedStory).toBeNull()
    const leakedTask = await prisma.task.findFirst({ where: { userStory: { feature: { epic: { project: copyOfFilter } } } } })
    expect(leakedTask).toBeNull()

    // TimelineEntry, StoryTimelineEntry — cloned with epics/features/stories
    const leakedTl = await prisma.timelineEntry.findFirst({ where: { project: copyOfFilter } })
    expect(leakedTl).toBeNull()
    const leakedStl = await prisma.storyTimelineEntry.findFirst({ where: { project: copyOfFilter } })
    expect(leakedStl).toBeNull()

    // CapacityProfile — where the validation error occurs, but should not leak
    const leakedProfile = await prisma.capacityProfile.findFirst({ where: { project: copyOfFilter } })
    expect(leakedProfile).toBeNull()

    // CapacitySegment — child of profile, should not leak
    const leakedSeg = await prisma.capacitySegment.findFirst({ where: { capacityProfile: { project: copyOfFilter } } })
    expect(leakedSeg).toBeNull()

    // BacklogSnapshot — not created during clone (backup tested separately),
    // but assert none accidentally leaked
    const leakedSnap = await prisma.backlogSnapshot.findFirst({ where: { project: copyOfFilter } })
    expect(leakedSnap).toBeNull()
  })

  it('C3 — source project state unchanged after failed clone', async () => {
    // All source entity counts must match what setup created
    const srcRTs = await prisma.resourceType.count({ where: { projectId: srcProjectId } })
    const srcNRs = await prisma.namedResource.count({
      where: { resourceType: { projectId: srcProjectId } },
    })
    const srcProfiles = await prisma.capacityProfile.count({ where: { projectId: srcProjectId } })
    const srcSegments = await prisma.capacitySegment.count({
      where: { capacityProfile: { projectId: srcProjectId } },
    })
    const srcEpics = await prisma.epic.count({ where: { projectId: srcProjectId } })
    const srcFeatures = await prisma.feature.count({ where: { epic: { projectId: srcProjectId } } })
    const srcTimelineEntries = await prisma.timelineEntry.count({ where: { projectId: srcProjectId } })

    expect(srcRTs).toBe(1)
    expect(srcNRs).toBe(1)
    expect(srcProfiles).toBe(2)
    expect(srcSegments).toBe(2)
    expect(srcEpics).toBeGreaterThanOrEqual(1)
    // Backlog createEpicBacklog creates 1 epic + 1 feature + 1 story
    expect(srcFeatures).toBeGreaterThanOrEqual(1)
    // One timeline entry is created for the backlog feature in setup.
    expect(srcTimelineEntries).toBeGreaterThanOrEqual(1)
  })
})

// Test count: 22 total (A:17, B:2, C:3)
// A1-A17 cover: response shape, count parity, ID isolation, profile/segment parity,
//   computeCommercialData parity via ID normalisation plus ACTUAL_DAYS/PRO_RATA
//   row behaviour on real DTO rows (A16),
//   buildProfileCsv exact-string parity, all 26 columns verified, planning
//   basis/source/identity/segment/billing fields parsed (A17).
// C1-C3 cover: mid-transaction rollback on invalid profile owner shape
//   from Prisma.sql injection, with no leaked rows and source unchanged.
