/**
 * productionRemediation.integration.test.ts — Real PostgreSQL 15 integration
 * tests for the Issue #421 capacity-profile readiness remediation command.
 *
 * Proves against a disposable database:
 *   - dry-run performs zero writes, classifies every production blocker class
 *     and produces stable fingerprints/counts;
 *   - deterministic apply creates/corrects profiles while preserving exact
 *     effective capacity, profile/segment identity and candidate columns;
 *   - manifest decisions resolve ambiguous owners exactly and block apply
 *     when unresolved, malformed or fingerprint-mismatched;
 *   - the apply transaction rolls back on any failure (no partial success);
 *   - historical v2 snapshot policy (never-active normalisation, windowless
 *     CAPACITY_PLAN decisions, minimal rewrites) is shared by readiness and
 *     rollback;
 *   - end-to-end: readiness fails → dry-run → approved plan applies → audit
 *     passes → readiness passes → runtime resolver loads → representative
 *     snapshot restoration succeeds → candidate columns remain.
 *
 * Requires INTEGRATION_TEST=true and a disposable PostgreSQL 15 Docker
 * container (see scripts/run-integration-local.mjs).
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient, Prisma } from '@prisma/client'
import type { $Enums } from '@prisma/client'

import {
  buildRemediationPlan,
  classifyPlanExit,
  loadRemediationState,
  parsePlanJson,
  planToJson,
  resolvePlanWithManifest,
  type RemediationManifest,
  type RemediationPlan,
} from '../lib/productionRemediationPlan.js'
import {
  applyRemediationPlan,
  __setRemediationApplyFailureSeam,
} from '../lib/productionRemediationApply.js'
import {
  runProductionMigrationReadiness,
  formatReadinessReport,
} from '../lib/productionMigrationReadiness.js'
import { runOwnershipAudit } from '../lib/capacityProfileOwnershipAudit.js'
import { resolveSchedulerCapacity } from '../lib/schedulerCapacityResolver.js'
import { rollbackProjectSnapshot } from '../lib/projectSnapshotService.js'
import { translateV2SnapshotProfiles } from '../lib/projectSnapshotCapacity.js'
import { parseSnapshotData, isSnapshotV2 } from '../lib/projectSnapshotTypes.js'

// ─── Guard ──────────────────────────────────────────────────────────────────

const runIntegration = process.env.INTEGRATION_TEST === 'true'
const describeIf = runIntegration ? describe : describe.skip

// ─── Shared state ───────────────────────────────────────────────────────────

let prisma: PrismaClient
let ownerId: string

const createdProjectIds: string[] = []

beforeAll(async () => {
  if (!runIntegration) return
  prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
  })
  await prisma.$connect()
  await prisma.backlogSnapshot.deleteMany({})
  await prisma.featureTemplate.deleteMany({})
  await prisma.project.deleteMany({})
  await prisma.customer.deleteMany({})
  await prisma.documentTemplate.deleteMany({})
  await prisma.user.deleteMany({})
  const user = await prisma.user.create({
    data: {
      email: `remediation-${Date.now()}@example.com`,
      name: 'Remediation Test',
      password: '$2b$10$placeholder',
    },
  })
  ownerId = user.id
})

afterEach(async () => {
  if (!runIntegration) return
  __setRemediationApplyFailureSeam(null)
  await prisma.backlogSnapshot.deleteMany({})
  await prisma.capacitySegment.deleteMany({})
  await prisma.capacityProfile.deleteMany({})
  await prisma.capacityPlanEntry.deleteMany({})
  await prisma.capacityPlanPeriod.deleteMany({})
  await prisma.capacityPlan.deleteMany({})
  await prisma.namedResource.deleteMany({})
  await prisma.resourceType.deleteMany({})
  await prisma.featureTemplate.deleteMany({})
  await prisma.project.deleteMany({})
  await prisma.customer.deleteMany({})
  await prisma.documentTemplate.deleteMany({})
  await prisma.user.deleteMany({})
  createdProjectIds.length = 0
  // Recreate the owner user wiped above so the next test can create projects.
  const user = await prisma.user.create({
    data: {
      email: `remediation-${Date.now()}@example.com`,
      name: 'Remediation Test',
      password: '$2b$10$placeholder',
    },
  })
  ownerId = user.id
})

afterAll(async () => {
  if (!runIntegration) return
  await prisma.backlogSnapshot.deleteMany({})
  await prisma.capacitySegment.deleteMany({})
  await prisma.capacityProfile.deleteMany({})
  await prisma.capacityPlanEntry.deleteMany({})
  await prisma.capacityPlanPeriod.deleteMany({})
  await prisma.capacityPlan.deleteMany({})
  await prisma.namedResource.deleteMany({})
  await prisma.resourceType.deleteMany({})
  await prisma.project.deleteMany({})
  await prisma.customer.deleteMany({})
  await prisma.documentTemplate.deleteMany({})
  await prisma.user.deleteMany({})
  await prisma.$disconnect()
})

// ─── Fixture helpers ────────────────────────────────────────────────────────

let fixtureCounter = 0

async function createProject(name = 'Remediation Project'): Promise<string> {
  const project = await prisma.project.create({
    data: { name: `${name} ${Date.now()}-${fixtureCounter++}`, ownerId },
  })
  createdProjectIds.push(project.id)
  return project.id
}

async function createRole(
  projectId: string,
  overrides: Partial<{
    name: string
    allocationMode: $Enums.AllocationMode | null
    allocationPercent: number | null
    allocationStartWeek: number | null
    allocationEndWeek: number | null
    count: number
  }> = {},
): Promise<string> {
  const rt = await prisma.resourceType.create({
    data: {
      name: overrides.name ?? `Role ${fixtureCounter++}`,
      category: 'ENGINEERING',
      count: overrides.count ?? 1,
      projectId,
      allocationMode: overrides.allocationMode ?? 'TIMELINE',
      allocationPercent: overrides.allocationPercent ?? 100,
      allocationStartWeek: overrides.allocationStartWeek ?? null,
      allocationEndWeek: overrides.allocationEndWeek ?? null,
    },
  })
  return rt.id
}

async function createNamedPerson(
  projectId: string,
  rtId: string,
  overrides: Partial<{
    name: string
    allocationMode: $Enums.AllocationMode | null
    allocationPercent: number | null
    allocationPct: number | null
    allocationStartWeek: number | null
    allocationEndWeek: number | null
    startWeek: number | null
    endWeek: number | null
  }> = {},
): Promise<string> {
  void projectId
  const nr = await prisma.namedResource.create({
    data: {
      name: overrides.name ?? `Person ${fixtureCounter++}`,
      resourceTypeId: rtId,
      allocationMode: overrides.allocationMode ?? 'EFFORT',
      allocationPercent: overrides.allocationPercent ?? 100,
      allocationPct: overrides.allocationPct ?? 100,
      allocationStartWeek: overrides.allocationStartWeek ?? null,
      allocationEndWeek: overrides.allocationEndWeek ?? null,
      startWeek: overrides.startWeek ?? null,
      endWeek: overrides.endWeek ?? null,
    },
  })
  return nr.id
}

async function createProfile(
  projectId: string,
  data: {
    resourceTypeId?: string | null
    namedResourceId?: string | null
    ownerKind: $Enums.CapacityProfileOwnerKind
    planningBasis: $Enums.CapacityProfilePlanningBasis
    source: $Enums.CapacityProfileSource
    defaultPercent?: number | null
    startWeek?: number | null
    endWeek?: number | null
    legacy?: unknown
    segments?: Array<{ id?: string; startWeek: number; endWeek: number; capacityPercent: number; source: $Enums.CapacityProfileSource }>
    id?: string
  },
): Promise<string> {
  const profile = await prisma.capacityProfile.create({
    data: {
      ...(data.id ? { id: data.id } : {}),
      projectId,
      resourceTypeId: data.resourceTypeId ?? null,
      namedResourceId: data.namedResourceId ?? null,
      ownerKind: data.ownerKind,
      planningBasis: data.planningBasis,
      source: data.source,
      defaultPercent: data.defaultPercent ?? null,
      startWeek: data.startWeek ?? null,
      endWeek: data.endWeek ?? null,
      legacy: data.legacy as never,
      segments: data.segments
        ? { create: data.segments.map(segment => ({
            ...(segment.id ? { id: segment.id } : {}),
            startWeek: segment.startWeek,
            endWeek: segment.endWeek,
            capacityPercent: segment.capacityPercent,
            source: segment.source,
          })) }
        : undefined,
    },
  })
  return profile.id
}

async function createActivePlan(
  projectId: string,
  periods: Array<{ periodIndex: number; startWeek: number; endWeek: number; entries: Array<{ resourceTypeId: string; headcount: number }> }>,
): Promise<void> {
  await prisma.capacityPlan.create({
    data: {
      projectId,
      name: `Plan ${fixtureCounter++}`,
      targetWeeks: 52,
      periodWeeks: 4,
      isActive: true,
      periods: {
        create: periods.map(period => ({
          periodIndex: period.periodIndex,
          startWeek: period.startWeek,
          endWeek: period.endWeek,
          entries: {
            create: period.entries.map(entry => ({
              resourceTypeId: entry.resourceTypeId,
              headcount: entry.headcount,
              demandFTE: entry.headcount,
              utilisationPct: 100,
            })),
          },
        })),
      },
    },
  })
}

async function createBacklogSnapshot(projectId: string, payload: unknown): Promise<string> {
  const snapshot = await prisma.backlogSnapshot.create({
    data: {
      projectId,
      label: `remediation fixture ${fixtureCounter++}`,
      trigger: 'manual',
      snapshot: payload as object,
      createdById: ownerId,
    },
  })
  return snapshot.id
}

function v2Snapshot(payload: {
  resourceTypes?: Array<Record<string, unknown>>
  namedResources?: Array<Record<string, unknown>>
  sentinel?: Record<string, unknown>
}): Record<string, unknown> {
  return {
    schemaVersion: 2,
    epics: [],
    project: null,
    resourceTypes: payload.resourceTypes ?? [],
    namedResources: payload.namedResources ?? [],
    timelineEntries: [],
    storyTimelineEntries: [],
    epicDependencies: [],
    featureDependencies: [],
    overheadItems: [],
    ...payload.sentinel,
  }
}

function v2Role(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'rt-snap-1',
    name: 'Snapshot Role',
    category: 'ENGINEERING',
    count: 1,
    hoursPerDay: null,
    dayRate: null,
    allocationMode: 'EFFORT',
    globalTypeId: null,
    allocationPercent: 100,
    allocationStartWeek: null,
    allocationEndWeek: null,
    ...overrides,
  }
}

function v2Person(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'nr-snap-1',
    resourceTypeId: 'rt-snap-1',
    name: 'Snapshot Person',
    startWeek: null,
    endWeek: null,
    allocationPct: 100,
    allocationMode: 'EFFORT',
    allocationPercent: 100,
    allocationStartWeek: null,
    allocationEndWeek: null,
    pricingModel: 'ACTUAL_DAYS',
    ...overrides,
  }
}

async function runDryRun(): Promise<{ plan: RemediationPlan; exit: number }> {
  const state = await loadRemediationState(prisma)
  const plan = buildRemediationPlan(state, 'test-commit')
  return { plan, exit: classifyPlanExit(plan) }
}

async function buildManifest(plan: RemediationPlan, resolutions: Array<{ decisionId: string; resolution: RemediationManifest['decisions'][number]['resolution'] }>): Promise<RemediationManifest> {
  return {
    formatVersion: 1,
    applicationCommit: 'test-commit',
    planFingerprint: plan.fingerprint,
    decisions: resolutions.map(({ decisionId, resolution }) => {
      const entry = plan.decisions.find(d => d.id === decisionId)!
      return {
        decisionId,
        projectId: entry.projectId,
        ownerId: entry.ownerId,
        snapshotId: entry.snapshotId,
        resolution,
        rationale: 'integration test',
      }
    }),
  }
}

async function candidateColumnsPresent(): Promise<boolean> {
  const rows = await prisma.$queryRaw<Array<{ column_name: string }>>(
    Prisma.sql`SELECT column_name FROM information_schema.columns
      WHERE table_name IN ('ResourceType', 'NamedResource')
        AND column_name IN ('allocationMode','allocationPercent','allocationPct','allocationStartWeek','allocationEndWeek','startWeek','endWeek')`,
  )
  return rows.length === 11
}

// ════════════════════════════════════════════════════════════════════════════
// 1. Planning and dry-run
// ════════════════════════════════════════════════════════════════════════════

describeIf('remediation dry-run', () => {
  it('performs zero writes and classifies deterministic + decision-required owners', async () => {
    const projectId = await createProject()
    await createRole(projectId, { allocationMode: 'TIMELINE' })
    await createRole(projectId, { allocationMode: 'EFFORT' })
    await createRole(projectId, { allocationMode: 'FULL_PROJECT' })
    await createRole(projectId, { allocationMode: 'CAPACITY_PLAN' })

    const profilesBefore = await prisma.capacityProfile.count()
    const segmentsBefore = await prisma.capacitySegment.count()

    const { plan, exit } = await runDryRun()
    expect(exit).toBe(2) // decisions remain
    expect(profilesBefore).toBe(await prisma.capacityProfile.count())
    expect(segmentsBefore).toBe(await prisma.capacitySegment.count())
    expect(plan.summary.findings.deterministic).toBe(3)
    expect(plan.summary.findings.decisionRequired).toBe(1)
    expect(plan.operations).toHaveLength(3)
    expect(plan.operations.every(op => op.classification === 'deterministic')).toBe(true)
    expect(plan.decisions).toHaveLength(1)
  })

  it('produces stable fingerprints across repeated dry-runs', async () => {
    const projectId = await createProject()
    await createRole(projectId, { allocationMode: 'TIMELINE', allocationPercent: 80 })
    await createNamedPerson(projectId, await createRole(projectId, { allocationMode: 'TIMELINE' }), {
      allocationMode: 'TIMELINE',
      startWeek: 0,
      endWeek: 8,
    })

    const first = await runDryRun()
    const second = await runDryRun()
    expect(first.plan.fingerprint).toBe(second.plan.fingerprint)
    // generatedAt is intentionally volatile; the fingerprint is the stability
    // contract, and the rest of the JSON content must be identical.
    const stripGeneratedAt = (plan: typeof first.plan) => {
      const { generatedAt, ...rest } = plan
      void generatedAt
      return JSON.stringify(rest)
    }
    expect(stripGeneratedAt(first.plan)).toBe(stripGeneratedAt(second.plan))
    // Round-trip through the file contract keeps the fingerprint valid.
    const parsed = parsePlanJson(planToJson(first.plan))
    expect(parsed.errors).toEqual([])
    expect(parsed.plan!.fingerprint).toBe(first.plan.fingerprint)
  })

  it('never prints credentials or database URLs in plan output', async () => {
    const projectId = await createProject()
    await createRole(projectId, { allocationMode: 'TIMELINE' })
    const { plan } = await runDryRun()
    const json = planToJson(plan)
    expect(json).not.toContain('postgres://')
    expect(json).not.toContain('postgresql://')
    expect(json).not.toContain('DATABASE_URL')
    expect(json).not.toContain('password')
    expect(formatReadinessReport(await runProductionMigrationReadiness(prisma)))
      .not.toContain('postgres://')
  })

  it('handles production-scale fixture counts without speculative infrastructure', async () => {
    const projectId = await createProject('Scale Project')
    for (let i = 0; i < 2000; i++) {
      await createRole(projectId, {
        allocationMode: i % 10 === 0 ? 'EFFORT' : 'TIMELINE',
        allocationPercent: null,
      })
    }
    const { plan } = await runDryRun()
    expect(plan.summary.findings.deterministic).toBe(2000)
    expect(plan.operations).toHaveLength(2000)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 2. Deterministic apply
// ════════════════════════════════════════════════════════════════════════════

describeIf('remediation deterministic apply', () => {
  it('creates missing deterministic ROLE profiles (TIMELINE/EFFORT/FULL_PROJECT) and preserves capacity', async () => {
    const projectId = await createProject()
    const timelineRt = await createRole(projectId, { allocationMode: 'TIMELINE', allocationPercent: 75, allocationStartWeek: 2, allocationEndWeek: 10 })
    const effortRt = await createRole(projectId, { allocationMode: 'EFFORT' })
    const fullProjectRt = await createRole(projectId, { allocationMode: 'FULL_PROJECT', allocationPercent: 40 })

    const { plan } = await runDryRun()
    expect(classifyPlanExit(plan)).toBe(0)
    const outcome = await applyRemediationPlan(prisma, { plan })
    expect(outcome.exitCode).toBe(0)
    expect(outcome.applied).toBe(3)
    expect(outcome.errors).toEqual([])
    expect(outcome.postApply!.readinessPassed).toBe(true)

    const timelineProfile = await prisma.capacityProfile.findFirstOrThrow({ where: { resourceTypeId: timelineRt } })
    expect(timelineProfile).toMatchObject({
      ownerKind: 'ROLE',
      planningBasis: 'AVAILABILITY_WINDOW',
      source: 'AVAILABILITY_WINDOW',
      defaultPercent: 75,
      startWeek: 2,
      endWeek: 10,
    })
    const effortProfile = await prisma.capacityProfile.findFirstOrThrow({ where: { resourceTypeId: effortRt } })
    expect(effortProfile).toMatchObject({ planningBasis: 'DEMAND_FOLLOWING', source: 'FIXED', startWeek: null, endWeek: null })
    const fullProfile = await prisma.capacityProfile.findFirstOrThrow({ where: { resourceTypeId: fullProjectRt } })
    expect(fullProfile).toMatchObject({ planningBasis: 'WHOLE_PROJECT_ALLOCATION', source: 'FIXED', defaultPercent: 40 })

    // Legacy provenance captured in the mapper shape.
    const legacy = timelineProfile.legacy as Record<string, unknown>
    expect(legacy.allocationMode).toBe('TIMELINE')
    expect(legacy.allocationPercent).toBe(75)
  })

  it('creates missing NAMED_PERSON profiles (TIMELINE/FULL_PROJECT/EFFORT/CAPACITY_PLAN-with-window)', async () => {
    const projectId = await createProject()
    const parent = await createRole(projectId, { allocationMode: 'EFFORT' })
    await createNamedPerson(projectId, parent, {
      allocationMode: 'TIMELINE', allocationPercent: 50, startWeek: 0, endWeek: 8,
    })
    await createNamedPerson(projectId, parent, { allocationMode: 'FULL_PROJECT', allocationPercent: 80 })
    await createNamedPerson(projectId, parent, { allocationMode: 'EFFORT' })
    await createNamedPerson(projectId, parent, { allocationMode: 'CAPACITY_PLAN', allocationPercent: 100, startWeek: 1, endWeek: 6 })

    const { plan } = await runDryRun()
    expect(classifyPlanExit(plan)).toBe(0)
    const outcome = await applyRemediationPlan(prisma, { plan })
    expect(outcome.exitCode).toBe(0)
    expect(outcome.applied).toBe(4)

    const profiles = await prisma.capacityProfile.findMany({
      where: { projectId, ownerKind: 'NAMED_PERSON' },
      orderBy: { namedResourceId: 'asc' },
    })
    expect(profiles).toHaveLength(4)
    // TIMELINE person: AVAILABILITY_WINDOW/AVAILABILITY_WINDOW at 50% 0-8.
    const timelinePerson = profiles.find(p => p.source === 'AVAILABILITY_WINDOW')
    expect(timelinePerson).toMatchObject({ planningBasis: 'AVAILABILITY_WINDOW', defaultPercent: 50, startWeek: 0, endWeek: 8 })
    // FULL_PROJECT person.
    const fullPerson = profiles.find(p => p.planningBasis === 'WHOLE_PROJECT_ALLOCATION')
    expect(fullPerson).toMatchObject({ source: 'FIXED', defaultPercent: 80, startWeek: null, endWeek: null })
    // EFFORT person.
    const effortPerson = profiles.find(p => p.planningBasis === 'DEMAND_FOLLOWING')
    expect(effortPerson).toMatchObject({ source: 'FIXED', defaultPercent: 100, startWeek: null, endWeek: null })
    // CAPACITY_PLAN with captured window follows the v2 policy.
    const windowPerson = profiles.find(p => p.source === 'LEGACY')
    expect(windowPerson).toMatchObject({ planningBasis: 'AVAILABILITY_WINDOW', defaultPercent: 100, startWeek: 1, endWeek: 6 })
  })

  it('reconstructs planner-owned ROLE profiles only from exact captured plan evidence', async () => {
    const projectId = await createProject()
    const plannerRt = await createRole(projectId, { allocationMode: 'CAPACITY_PLAN', count: 2 })
    await createActivePlan(projectId, [
      { periodIndex: 0, startWeek: 0, endWeek: 8, entries: [{ resourceTypeId: plannerRt, headcount: 2 }] },
      { periodIndex: 1, startWeek: 8, endWeek: 16, entries: [{ resourceTypeId: plannerRt, headcount: 1 }] },
    ])

    const { plan } = await runDryRun()
    const roleOps = plan.operations.filter(op => op.ownerId === plannerRt)
    expect(roleOps).toHaveLength(1)
    expect(roleOps[0]!.kind).toBe('create-role-profile')
    const outcome = await applyRemediationPlan(prisma, { plan })
    expect(outcome.exitCode).toBe(0)

    const profile = await prisma.capacityProfile.findFirstOrThrow({ where: { resourceTypeId: plannerRt } })
    expect(profile).toMatchObject({ planningBasis: 'CAPACITY_PROFILE', source: 'SQUAD_PLANNER' })
    const segments = await prisma.capacitySegment.findMany({ where: { capacityProfileId: profile.id }, orderBy: { startWeek: 'asc' } })
    expect(segments.length).toBeGreaterThan(0)
    expect(segments[0]).toMatchObject({ startWeek: 0, endWeek: 7, capacityPercent: 200, source: 'SQUAD_PLANNER' })
  })

  it('normalises stale DEMAND_FOLLOWING windows and fixes the contained overlap preserving IDs', async () => {
    const projectId = await createProject()
    const personRt = await createRole(projectId, { allocationMode: 'TIMELINE' })
    const nrId = await createNamedPerson(projectId, personRt, { allocationMode: 'EFFORT' })

    // Stale DEMAND_FOLLOWING window profile (production blocker D).
    const staleProfileId = await createProfile(projectId, {
      namedResourceId: nrId,
      ownerKind: 'NAMED_PERSON',
      planningBasis: 'DEMAND_FOLLOWING',
      source: 'FIXED',
      defaultPercent: 100,
      startWeek: 0,
      endWeek: 29,
      legacy: { allocationMode: 'EFFORT', allocationPercent: 100, allocationStartWeek: 0, allocationEndWeek: 29 },
    })

    // Overlapping segments profile (production blocker D).
    const overlapRt = await createRole(projectId, { allocationMode: 'CAPACITY_PLAN', count: 1 })
    const overlapProfileId = await createProfile(projectId, {
      resourceTypeId: overlapRt,
      ownerKind: 'ROLE',
      planningBasis: 'CAPACITY_PROFILE',
      source: 'SQUAD_PLANNER',
      defaultPercent: 25,
      startWeek: 39,
      endWeek: 64,
      segments: [
        { id: 'seg-overlap-a', startWeek: 39, endWeek: 64, capacityPercent: 25, source: 'SQUAD_PLANNER' },
        { id: 'seg-overlap-b', startWeek: 52, endWeek: 64, capacityPercent: 25, source: 'SQUAD_PLANNER' },
      ],
    })

    const { plan } = await runDryRun()
    const staleOp = plan.operations.find(op => op.proposed !== null && 'profileId' in op.proposed && (op.proposed as { profileId: string }).profileId === staleProfileId)
    expect(staleOp?.kind).toBe('update-profile')
    const overlapOp = plan.operations.find(op => 'proposed' in op && op.proposed !== null && 'profileId' in op.proposed && (op.proposed as { profileId: string }).profileId === overlapProfileId)
    expect(overlapOp?.kind).toBe('update-profile')

    const outcome = await applyRemediationPlan(prisma, { plan })
    expect(outcome.exitCode).toBe(0)
    expect(outcome.postApply!.readinessPassed).toBe(true)

    const staleProfile = await prisma.capacityProfile.findUniqueOrThrow({ where: { id: staleProfileId } })
    expect(staleProfile.startWeek).toBeNull()
    expect(staleProfile.endWeek).toBeNull()
    expect(staleProfile.defaultPercent).toBe(100)
    // Legacy provenance untouched.
    expect((staleProfile.legacy as Record<string, unknown>).allocationMode).toBe('EFFORT')

    const overlapSegments = await prisma.capacitySegment.findMany({
      where: { capacityProfileId: overlapProfileId },
      orderBy: { startWeek: 'asc' },
    })
    expect(overlapSegments).toHaveLength(2)
    expect(overlapSegments[0]).toMatchObject({ id: 'seg-overlap-a', startWeek: 39, endWeek: 51, capacityPercent: 25 })
    expect(overlapSegments[1]).toMatchObject({ id: 'seg-overlap-b', startWeek: 52, endWeek: 64, capacityPercent: 50 })
  })

  it('preserves candidate columns and leaves normal runtime profile-first', async () => {
    const projectId = await createProject()
    const rtId = await createRole(projectId, { allocationMode: 'TIMELINE', allocationPercent: 90 })
    const nrId = await createNamedPerson(projectId, rtId, { allocationMode: 'TIMELINE', startWeek: 0, endWeek: 4 })

    const beforeRt = await prisma.resourceType.findUniqueOrThrow({ where: { id: rtId } })
    const beforeNr = await prisma.namedResource.findUniqueOrThrow({ where: { id: nrId } })

    const { plan } = await runDryRun()
    const outcome = await applyRemediationPlan(prisma, { plan })
    expect(outcome.exitCode).toBe(0)

    const afterRt = await prisma.resourceType.findUniqueOrThrow({ where: { id: rtId } })
    const afterNr = await prisma.namedResource.findUniqueOrThrow({ where: { id: nrId } })
    expect(afterRt.allocationMode).toBe(beforeRt.allocationMode)
    expect(afterRt.allocationPercent).toBe(beforeRt.allocationPercent)
    expect(afterRt.allocationStartWeek).toBe(beforeRt.allocationStartWeek)
    expect(afterRt.allocationEndWeek).toBe(beforeRt.allocationEndWeek)
    expect(afterNr.startWeek).toBe(beforeNr.startWeek)
    expect(afterNr.endWeek).toBe(beforeNr.endWeek)
    expect(afterNr.allocationPercent).toBe(beforeNr.allocationPercent)
    expect(await candidateColumnsPresent()).toBe(true)

    // Normal runtime: scheduler capacity resolves exclusively from profiles.
    const resolved = await resolveSchedulerCapacity(prisma, projectId)
    expect(resolved.resourceTypes).toHaveLength(1)
    const rt = resolved.resourceTypes[0]!
    expect(rt.namedResources).toHaveLength(1)
    const week0 = (rt.namedResources[0]!.capacitySegments ?? []).length
    expect(week0).toBeGreaterThan(0)
    expect(resolved.meta.profileBackedCount).toBe(1)
    expect(resolved.meta.legacyCount).toBe(0)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 3. Manifest decisions
// ════════════════════════════════════════════════════════════════════════════

describeIf('remediation manifest decisions', () => {
  it('blocks apply while decisions remain unresolved (no writes, exit 2)', async () => {
    const projectId = await createProject()
    await createRole(projectId, { allocationMode: 'CAPACITY_PLAN' })
    const { plan } = await runDryRun()
    expect(classifyPlanExit(plan)).toBe(2)

    const profilesBefore = await prisma.capacityProfile.count()
    const outcome = await applyRemediationPlan(prisma, { plan })
    expect(outcome.exitCode).toBe(2)
    expect(outcome.errors.join(' ')).toContain('unresolved')
    expect(await prisma.capacityProfile.count()).toBe(profilesBefore)
  })

  it('applies an explicit valid resolution exactly and touches no unrelated owner', async () => {
    const projectId = await createProject()
    const ambiguous = await createRole(projectId, { allocationMode: 'CAPACITY_PLAN' })
    const unrelated = await createRole(projectId, { allocationMode: 'TIMELINE', allocationPercent: 60 })

    const { plan } = await runDryRun()
    const manifest = await buildManifest(plan, [{
      decisionId: plan.decisions.find(d => d.ownerId === ambiguous)!.id,
      resolution: { shape: 'availability-window', defaultPercent: 100, startWeek: 0, endWeek: 20 },
    }])
    const merged = resolvePlanWithManifest(plan, manifest)
    expect(merged.errors).toEqual([])

    const outcome = await applyRemediationPlan(prisma, { plan, manifest })
    expect(outcome.exitCode).toBe(0)
    expect(outcome.applied).toBe(2) // ambiguous + unrelated deterministic

    const ambiguousProfile = await prisma.capacityProfile.findFirstOrThrow({ where: { resourceTypeId: ambiguous } })
    expect(ambiguousProfile).toMatchObject({
      planningBasis: 'AVAILABILITY_WINDOW',
      source: 'AVAILABILITY_WINDOW',
      defaultPercent: 100,
      startWeek: 0,
      endWeek: 20,
    })
    const unrelatedProfile = await prisma.capacityProfile.findFirstOrThrow({ where: { resourceTypeId: unrelated } })
    expect(unrelatedProfile).toMatchObject({ defaultPercent: 60 })
    expect(await prisma.capacityProfile.count()).toBe(2)
  })

  it('rejects a malformed resolution shape (allowed-shape violation)', async () => {
    const projectId = await createProject()
    await createRole(projectId, { allocationMode: 'CAPACITY_PLAN' })
    const { plan } = await runDryRun()
    const manifest = await buildManifest(plan, [{
      decisionId: plan.decisions[0]!.id,
      resolution: { shape: 'snapshot-window-interpretation', startWeek: 0, endWeek: 5 },
    }])
    const profilesBefore = await prisma.capacityProfile.count()
    const outcome = await applyRemediationPlan(prisma, { plan, manifest })
    expect(outcome.exitCode).toBe(1)
    expect(outcome.errors.join(' ')).toContain('not allowed')
    expect(await prisma.capacityProfile.count()).toBe(profilesBefore)
  })

  it('refuses apply when the manifest fingerprint does not match the plan', async () => {
    const projectId = await createProject()
    await createRole(projectId, { allocationMode: 'CAPACITY_PLAN' })
    const { plan } = await runDryRun()
    const manifest: RemediationManifest = {
      formatVersion: 1,
      applicationCommit: 'test-commit',
      planFingerprint: 'deadbeef',
      decisions: [],
    }
    const outcome = await applyRemediationPlan(prisma, { plan, manifest })
    expect(outcome.exitCode).toBe(1)
    expect(outcome.errors.join(' ')).toContain('planFingerprint')
  })

  it('refuses when data changed between dry-run and apply', async () => {
    const projectId = await createProject()
    const rtId = await createRole(projectId, { allocationMode: 'TIMELINE', allocationPercent: 90 })
    const { plan } = await runDryRun()
    expect(classifyPlanExit(plan)).toBe(0)

    // Drift: legacy state changes after the dry-run.
    await prisma.resourceType.update({ where: { id: rtId }, data: { allocationPercent: 50 } })

    const profilesBefore = await prisma.capacityProfile.count()
    const outcome = await applyRemediationPlan(prisma, { plan })
    expect(outcome.exitCode).toBe(1)
    expect(outcome.errors.join(' ')).toContain('changed since dry-run')
    expect(await prisma.capacityProfile.count()).toBe(profilesBefore)
  })

  it('is a no-op on rerun (apply followed by apply is safe)', async () => {
    const projectId = await createProject()
    await createRole(projectId, { allocationMode: 'TIMELINE' })
    await createRole(projectId, { allocationMode: 'CAPACITY_PLAN' })
    const { plan } = await runDryRun()
    const manifest = await buildManifest(plan, [{
      decisionId: plan.decisions[0]!.id,
      resolution: { shape: 'scalar-profile', planningBasis: 'DEMAND_FOLLOWING', defaultPercent: 100 },
    }])

    const first = await applyRemediationPlan(prisma, { plan, manifest })
    expect(first.exitCode).toBe(0)
    expect(first.applied).toBe(2)

    const second = await applyRemediationPlan(prisma, { plan, manifest })
    expect(second.exitCode).toBe(0)
    expect(second.applied).toBe(0)
    expect(second.skipped).toBe(2)
    expect(await prisma.capacityProfile.count()).toBe(2)
  })

  it('rejects a tampered plan file (fingerprint invalid)', async () => {
    const projectId = await createProject()
    await createRole(projectId, { allocationMode: 'TIMELINE', allocationPercent: 90 })
    const { plan } = await runDryRun()
    const json = JSON.parse(planToJson(plan)) as unknown as Record<string, unknown>
    const operations = json.operations as Array<Record<string, unknown>>
    operations[0]!.proposed = {
      ...(operations[0]!.proposed as Record<string, unknown>),
      defaultPercent: 5,
    }
    const parsed = parsePlanJson(JSON.stringify(json))
    expect(parsed.plan).toBeNull()
    expect(parsed.errors.join(' ')).toContain('fingerprint mismatch')
  })

  it('resolves a segmentless ROLE CAPACITY_PROFILE via explicit segments', async () => {
    const projectId = await createProject()
    const rtId = await createRole(projectId, { allocationMode: 'CAPACITY_PLAN' })
    const profileId = await createProfile(projectId, {
      resourceTypeId: rtId,
      ownerKind: 'ROLE',
      planningBasis: 'CAPACITY_PROFILE',
      source: 'LEGACY',
      defaultPercent: 100,
      legacy: { allocationMode: 'CAPACITY_PLAN', allocationPercent: null, allocationStartWeek: null, allocationEndWeek: null },
    })

    const { plan } = await runDryRun()
    const decision = plan.decisions.find(d => d.profileId === profileId)
    expect(decision).toBeDefined()
    const manifest = await buildManifest(plan, [{
      decisionId: decision!.id,
      resolution: {
        shape: 'segmented-capacity-profile',
        defaultPercent: 50,
        segments: [
          { startWeek: 0, endWeek: 10, capacityPercent: 50 },
          { startWeek: 11, endWeek: 20, capacityPercent: 25 },
        ],
      },
    }])
    const outcome = await applyRemediationPlan(prisma, { plan, manifest })
    expect(outcome.exitCode).toBe(0)

    const profile = await prisma.capacityProfile.findUniqueOrThrow({ where: { id: profileId } })
    expect(profile.planningBasis).toBe('CAPACITY_PROFILE')
    expect(profile.defaultPercent).toBe(50)
    // Legacy provenance preserved on updates.
    expect((profile.legacy as Record<string, unknown>).allocationMode).toBe('CAPACITY_PLAN')
    const segments = await prisma.capacitySegment.findMany({ where: { capacityProfileId: profileId }, orderBy: { startWeek: 'asc' } })
    expect(segments).toHaveLength(2)
    expect(segments[0]).toMatchObject({ startWeek: 0, endWeek: 10, capacityPercent: 50 })
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 4. Transaction safety
// ════════════════════════════════════════════════════════════════════════════

describeIf('remediation transaction safety', () => {
  it('rolls back everything when a failure occurs mid-transaction', async () => {
    const projectId = await createProject()
    await createRole(projectId, { allocationMode: 'TIMELINE' })
    await createRole(projectId, { allocationMode: 'EFFORT' })
    await createRole(projectId, { allocationMode: 'FULL_PROJECT' })

    const { plan } = await runDryRun()
    expect(plan.operations).toHaveLength(3)

    __setRemediationApplyFailureSeam(() => {
      throw new Error('injected mid-transaction failure')
    })
    const outcome = await applyRemediationPlan(prisma, { plan })
    expect(outcome.exitCode).toBe(1)
    expect(outcome.errors.join(' ')).toContain('injected mid-transaction failure')

    // Nothing partially applied.
    expect(await prisma.capacityProfile.count()).toBe(0)
    expect(await prisma.capacitySegment.count()).toBe(0)
  })

  it('refuses before the first write when any operation drifted', async () => {
    const projectId = await createProject()
    const rtA = await createRole(projectId, { allocationMode: 'TIMELINE' })
    await createRole(projectId, { allocationMode: 'EFFORT' })
    const { plan } = await runDryRun()
    expect(plan.operations).toHaveLength(2)

    await prisma.resourceType.update({ where: { id: rtA }, data: { allocationMode: 'FULL_PROJECT' } })
    const outcome = await applyRemediationPlan(prisma, { plan })
    expect(outcome.exitCode).toBe(1)
    expect(await prisma.capacityProfile.count()).toBe(0)
  })

  it('reports complete applied counts and no partial success', async () => {
    const projectId = await createProject()
    await createRole(projectId, { allocationMode: 'TIMELINE' })
    await createRole(projectId, { allocationMode: 'CAPACITY_PLAN' })
    const { plan } = await runDryRun()

    // Unresolved: nothing applied, nothing reported as success.
    const outcome = await applyRemediationPlan(prisma, { plan })
    expect(outcome.exitCode).toBe(2)
    expect(outcome.applied).toBe(0)
    expect(outcome.skipped).toBe(0)
    expect(await prisma.capacityProfile.count()).toBe(0)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 5. Historical snapshots
// ════════════════════════════════════════════════════════════════════════════

describeIf('remediation historical v2 snapshot policy', () => {
  it('translates v2 EFFORT / FULL_PROJECT / TIMELINE / windowed CAPACITY_PLAN entries', async () => {
    const projectId = await createProject()
    const snapshotId = await createBacklogSnapshot(projectId, v2Snapshot({
      resourceTypes: [
        v2Role({ id: 'rt-1', allocationMode: 'EFFORT', allocationStartWeek: 2, allocationEndWeek: 9 }),
        v2Role({ id: 'rt-2', allocationMode: 'FULL_PROJECT', allocationPercent: 60 }),
        v2Role({ id: 'rt-3', allocationMode: 'TIMELINE', allocationStartWeek: 0, allocationEndWeek: 10 }),
        v2Role({ id: 'rt-4', allocationMode: 'CAPACITY_PLAN', allocationStartWeek: 3, allocationEndWeek: 12 }),
      ],
      namedResources: [
        v2Person({ id: 'nr-1', resourceTypeId: 'rt-1', allocationMode: 'EFFORT' }),
        v2Person({ id: 'nr-2', resourceTypeId: 'rt-4', allocationMode: 'CAPACITY_PLAN', allocationStartWeek: 3, allocationEndWeek: 12 }),
      ],
    }))

    const readiness = await runProductionMigrationReadiness(prisma)
    expect(readiness.passed).toBe(true)

    const { plan } = await runDryRun()
    expect(plan.summary.findings.deterministic).toBe(0)
    expect(plan.summary.findings.decisionRequired).toBe(0)
    expect(classifyPlanExit(plan)).toBe(0)
    void snapshotId
  })

  it('applies the never-active policy to (-1,-1) pairs and inverted windows', async () => {
    const projectId = await createProject()
    await createBacklogSnapshot(projectId, v2Snapshot({
      resourceTypes: [v2Role({ id: 'rt-snap-1', allocationMode: 'EFFORT' })],
      namedResources: [
        v2Person({ id: 'nr-neg', allocationMode: 'CAPACITY_PLAN', allocationPercent: 100, startWeek: -1, endWeek: -1 }),
        v2Person({ id: 'nr-inv', allocationMode: 'CAPACITY_PLAN', allocationPercent: 100, startWeek: 4, endWeek: 3 }),
      ],
    }))

    const readiness = await runProductionMigrationReadiness(prisma)
    expect(readiness.passed).toBe(true)

    const { plan } = await runDryRun()
    expect(plan.summary.findings.deterministic).toBe(2)
    expect(plan.summary.findings.decisionRequired).toBe(0)
    expect(classifyPlanExit(plan)).toBe(0)

    // Rollback agrees with readiness: the same translation produces
    // zero-capacity profiles with null windows.
    const row = await prisma.backlogSnapshot.findFirstOrThrow()
    const parsed = parseSnapshotData(row.snapshot)
    expect(isSnapshotV2(parsed)).toBe(true)
    const translation = translateV2SnapshotProfiles(parsed as never, projectId)
    expect(translation.errors).toEqual([])
    const zeroProfiles = translation.profiles.filter(p => p.defaultPercent === 0)
    expect(zeroProfiles).toHaveLength(2)
    for (const profile of zeroProfiles) {
      expect(profile.startWeek).toBeNull()
      expect(profile.endWeek).toBeNull()
    }
  })

  it('classifies windowless CAPACITY_PLAN entries as decisions and rewrites only the minimum fields', async () => {
    const projectId = await createProject()
    const snapshotId = await createBacklogSnapshot(projectId, v2Snapshot({
      resourceTypes: [v2Role({ id: 'rt-snap-1', allocationMode: 'EFFORT' })],
      namedResources: [
        v2Person({
          id: 'nr-windowless',
          allocationMode: 'CAPACITY_PLAN',
          allocationPercent: 100,
          startWeek: null,
          endWeek: null,
          allocationStartWeek: null,
          allocationEndWeek: null,
        }),
      ],
      sentinel: { marker: 'preserve-me', nested: { a: [1, 2, 3], b: 'x' } },
    }))

    const readiness = await runProductionMigrationReadiness(prisma)
    expect(readiness.passed).toBe(false)
    expect(formatReadinessReport(readiness)).toContain('cannot be translated without guessing')

    const { plan } = await runDryRun()
    expect(classifyPlanExit(plan)).toBe(2)
    expect(plan.summary.findings.decisionRequired).toBe(1)

    const manifest = await buildManifest(plan, [{
      decisionId: plan.decisions[0]!.id,
      resolution: { shape: 'snapshot-window-interpretation', startWeek: 0, endWeek: 10 },
    }])
    const outcome = await applyRemediationPlan(prisma, { plan, manifest })
    expect(outcome.exitCode).toBe(0)
    expect(outcome.applied).toBe(1)

    // Minimum fields changed; unrelated content preserved.
    const row = await prisma.backlogSnapshot.findUniqueOrThrow({ where: { id: snapshotId } })
    const snap = row.snapshot as Record<string, unknown>
    expect((snap as { marker?: string }).marker).toBe('preserve-me')
    expect((snap as { nested?: unknown }).nested).toEqual({ a: [1, 2, 3], b: 'x' })
    const nrs = snap.namedResources as Array<Record<string, unknown>>
    const entry = nrs.find(e => e.id === 'nr-windowless')!
    expect(entry.allocationStartWeek).toBe(0)
    expect(entry.allocationEndWeek).toBe(10)
    expect(entry.startWeek).toBeNull()
    expect(entry.endWeek).toBeNull()
    expect(entry.allocationMode).toBe('CAPACITY_PLAN')

    // Readiness passes after the rewrite.
    const after = await runProductionMigrationReadiness(prisma)
    expect(after.passed).toBe(true)

    // Rollback of the rewritten snapshot succeeds (readiness/rollback agree).
    await rollbackProjectSnapshot({ projectId, snapshotId, userId: ownerId, db: prisma })
    const profiles = await prisma.capacityProfile.findMany({ where: { projectId } })
    const windowed = profiles.find(p => p.namedResourceId === 'nr-windowless')
    expect(windowed).toMatchObject({ planningBasis: 'AVAILABILITY_WINDOW', source: 'LEGACY', startWeek: 0, endWeek: 10 })
  })

  it('classifies a single -1 edge as decision-required', async () => {
    const projectId = await createProject()
    await createBacklogSnapshot(projectId, v2Snapshot({
      resourceTypes: [v2Role({ id: 'rt-snap-1', allocationMode: 'EFFORT' })],
      namedResources: [
        v2Person({ id: 'nr-single-neg', allocationMode: 'CAPACITY_PLAN', allocationPercent: 100, startWeek: 0, endWeek: -1 }),
      ],
    }))
    const { plan } = await runDryRun()
    expect(plan.summary.findings.decisionRequired).toBe(1)
    expect(classifyPlanExit(plan)).toBe(2)
    expect(plan.decisions[0]!.allowedResolutions).toEqual(['snapshot-window-interpretation'])
  })

  it('refuses malformed snapshots as unsupported (never deleted)', async () => {
    const projectId = await createProject()
    const snapshotId = await createBacklogSnapshot(projectId, { schemaVersion: 2, epics: 'not-an-array' })
    const { plan } = await runDryRun()
    expect(plan.summary.findings.unsupported).toBeGreaterThan(0)
    expect(classifyPlanExit(plan)).toBe(1)

    // A malformed snapshot is never deleted to pass readiness.
    const row = await prisma.backlogSnapshot.findUnique({ where: { id: snapshotId } })
    expect(row).not.toBeNull()
    const outcome = await applyRemediationPlan(prisma, { plan })
    expect(outcome.exitCode).toBe(1)
    expect(await prisma.backlogSnapshot.count()).toBe(1)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 5b. Owner-kind decisions for ambiguous NamedResources (review round 2)
// ════════════════════════════════════════════════════════════════════════════

describeIf('remediation owner-kind decisions', () => {
  async function seedAmbiguousNr(): Promise<{ projectId: string; parentRt: string; nrId: string }> {
    const projectId = await createProject()
    const parentRt = await createRole(projectId, { allocationMode: 'EFFORT' })
    const nrId = await createNamedPerson(projectId, parentRt, { allocationMode: 'CAPACITY_PLAN' })
    return { projectId, parentRt, nrId }
  }

  it('emits an owner-kind-required decision and rejects a direct capacity-only resolution', async () => {
    const { projectId, nrId } = await seedAmbiguousNr()
    const { plan } = await runDryRun()
    const decision = plan.decisions.find(d => d.ownerId === nrId)!
    expect(decision.allowedResolutions).toEqual(['owner-kind-decision'])

    const directManifest = await buildManifest(plan, [{
      decisionId: decision.id,
      resolution: { shape: 'availability-window', defaultPercent: 100, startWeek: 0, endWeek: 10 },
    }])
    const profilesBefore = await prisma.capacityProfile.count()
    const outcome = await applyRemediationPlan(prisma, { plan, manifest: directManifest })
    expect(outcome.exitCode).toBe(1)
    expect(outcome.errors.join(' ')).toContain('not allowed for this entry')
    expect(await prisma.capacityProfile.count()).toBe(profilesBefore)
    void projectId
  })

  it('creates the exact reviewed NAMED_PERSON profile from an explicit owner-kind decision', async () => {
    const { projectId, nrId } = await seedAmbiguousNr()
    const { plan } = await runDryRun()
    const manifest = await buildManifest(plan, [{
      decisionId: plan.decisions.find(d => d.ownerId === nrId)!.id,
      resolution: {
        shape: 'owner-kind-decision',
        ownerKind: 'NAMED_PERSON',
        capacity: { shape: 'availability-window', defaultPercent: 100, startWeek: 0, endWeek: 10 },
      },
    }])
    const outcome = await applyRemediationPlan(prisma, { plan, manifest })
    expect(outcome.exitCode).toBe(0)
    const profile = await prisma.capacityProfile.findFirstOrThrow({ where: { namedResourceId: nrId } })
    expect(profile).toMatchObject({
      ownerKind: 'NAMED_PERSON',
      planningBasis: 'AVAILABILITY_WINDOW',
      source: 'AVAILABILITY_WINDOW',
      defaultPercent: 100,
      startWeek: 0,
      endWeek: 10,
    })
    // The profile passes structural validation, ownership audit, readiness
    // and the runtime resolver.
    const audit = await runOwnershipAudit(prisma)
    expect(audit.isClean).toBe(true)
    const readiness = await runProductionMigrationReadiness(prisma)
    expect(readiness.passed).toBe(true)
    const resolved = await resolveSchedulerCapacity(prisma, projectId)
    expect(resolved.meta.legacyCount).toBe(0)
    expect(resolved.meta.profileBackedCount).toBe(1)
  })

  it('creates the exact reviewed PLANNED_RESOURCE profile from an explicit owner-kind decision', async () => {
    const { projectId, nrId } = await seedAmbiguousNr()
    const { plan } = await runDryRun()
    const manifest = await buildManifest(plan, [{
      decisionId: plan.decisions.find(d => d.ownerId === nrId)!.id,
      resolution: {
        shape: 'owner-kind-decision',
        ownerKind: 'PLANNED_RESOURCE',
        capacity: {
          shape: 'segmented-capacity-profile',
          defaultPercent: 50,
          segments: [
            { startWeek: 5, endWeek: 10, capacityPercent: 25 },
            { startWeek: 0, endWeek: 4, capacityPercent: 50 },
          ],
        },
      },
    }])
    const outcome = await applyRemediationPlan(prisma, { plan, manifest })
    expect(outcome.exitCode).toBe(0)
    const profile = await prisma.capacityProfile.findFirstOrThrow({ where: { namedResourceId: nrId } })
    expect(profile).toMatchObject({
      ownerKind: 'PLANNED_RESOURCE',
      planningBasis: 'CAPACITY_PROFILE',
      source: 'LEGACY',
      defaultPercent: 50,
    })
    const segments = await prisma.capacitySegment.findMany({
      where: { capacityProfileId: profile.id },
      orderBy: { startWeek: 'asc' },
    })
    expect(segments).toEqual([
      expect.objectContaining({ startWeek: 0, endWeek: 4, capacityPercent: 50 }),
      expect.objectContaining({ startWeek: 5, endWeek: 10, capacityPercent: 25 }),
    ])
    const audit = await runOwnershipAudit(prisma)
    expect(audit.isClean).toBe(true)
    const readiness = await runProductionMigrationReadiness(prisma)
    expect(readiness.passed).toBe(true)
    const resolved = await resolveSchedulerCapacity(prisma, projectId)
    expect(resolved.meta.legacyCount).toBe(0)
    expect(resolved.meta.profileBackedCount).toBe(1)
  })

  it('rejects an unknown or structurally invalid nested capacity resolution before writes', async () => {
    const { nrId } = await seedAmbiguousNr()
    const { plan } = await runDryRun()

    // Unknown nested shape.
    const unknownManifest = await buildManifest(plan, [{
      decisionId: plan.decisions.find(d => d.ownerId === nrId)!.id,
      resolution: {
        shape: 'owner-kind-decision',
        ownerKind: 'NAMED_PERSON',
        capacity: { shape: 'mystery-shape' } as never,
      },
    }])
    const profilesBefore = await prisma.capacityProfile.count()
    const unknownOutcome = await applyRemediationPlan(prisma, { plan, manifest: unknownManifest })
    expect(unknownOutcome.exitCode).toBe(1)
    expect(unknownOutcome.errors.join(' ')).toContain('unknown nested capacity shape')
    expect(await prisma.capacityProfile.count()).toBe(profilesBefore)

    // Structurally invalid nested window (inverted) is refused before writes.
    const invalidManifest = await buildManifest(plan, [{
      decisionId: plan.decisions.find(d => d.ownerId === nrId)!.id,
      resolution: {
        shape: 'owner-kind-decision',
        ownerKind: 'NAMED_PERSON',
        capacity: { shape: 'availability-window', defaultPercent: 100, startWeek: 9, endWeek: 3 },
      },
    }])
    const invalidOutcome = await applyRemediationPlan(prisma, { plan, manifest: invalidManifest })
    expect(invalidOutcome.exitCode).toBe(1)
    expect(invalidOutcome.errors.join(' ')).toContain('structurally invalid')
    expect(await prisma.capacityProfile.count()).toBe(profilesBefore)
  })

  it('keeps deterministic NamedResource mappings unchanged', async () => {
    const projectId = await createProject()
    const parentRt = await createRole(projectId, { allocationMode: 'EFFORT' })
    const detNr = await createNamedPerson(projectId, parentRt, { allocationMode: 'TIMELINE', startWeek: 0, endWeek: 8 })
    const { plan } = await runDryRun()
    expect(plan.decisions).toHaveLength(0)
    expect(plan.operations).toHaveLength(1)
    expect(plan.operations[0]!.proposed).toMatchObject({ ownerKind: 'NAMED_PERSON' })
    const outcome = await applyRemediationPlan(prisma, { plan })
    expect(outcome.exitCode).toBe(0)
    const profile = await prisma.capacityProfile.findFirstOrThrow({ where: { namedResourceId: detNr } })
    expect(profile.ownerKind).toBe('NAMED_PERSON')
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 5c. Full-scope drift refusal before writes (review round 2)
// ════════════════════════════════════════════════════════════════════════════

describeIf('remediation full-scope drift', () => {
  async function assertZeroWrites(baseline: { profiles: number; segments: number; snapshots: number }): Promise<void> {
    expect(await prisma.capacityProfile.count()).toBe(baseline.profiles)
    expect(await prisma.capacitySegment.count()).toBe(baseline.segments)
    expect(await prisma.backlogSnapshot.count()).toBe(baseline.snapshots)
  }

  async function snapshotCounts(): Promise<{ profiles: number; segments: number; snapshots: number }> {
    return {
      profiles: await prisma.capacityProfile.count(),
      segments: await prisma.capacitySegment.count(),
      snapshots: await prisma.backlogSnapshot.count(),
    }
  }

  it('refuses before writes when a new unprofiled ResourceType is added after dry-run', async () => {
    const projectId = await createProject()
    await createRole(projectId, { allocationMode: 'TIMELINE' })
    const { plan } = await runDryRun()
    expect(plan.operations).toHaveLength(1)

    await createRole(projectId, { allocationMode: 'EFFORT' })
    const baseline = await snapshotCounts()
    const outcome = await applyRemediationPlan(prisma, { plan })
    expect(outcome.exitCode).toBe(1)
    expect(outcome.errors.join(' ')).toContain('complete remediation state changed since dry-run')
    await assertZeroWrites(baseline)
  })

  it('refuses before writes when a new unprofiled NamedResource is added after dry-run', async () => {
    const projectId = await createProject()
    const rtId = await createRole(projectId, { allocationMode: 'TIMELINE' })
    const { plan } = await runDryRun()
    expect(plan.operations).toHaveLength(1)

    await createNamedPerson(projectId, rtId, { allocationMode: 'EFFORT' })
    const baseline = await snapshotCounts()
    const outcome = await applyRemediationPlan(prisma, { plan })
    expect(outcome.exitCode).toBe(1)
    await assertZeroWrites(baseline)
  })

  it('refuses before writes when a previously valid profile becomes malformed', async () => {
    const projectId = await createProject()
    const validRt = await createRole(projectId, { allocationMode: 'EFFORT' })
    const validProfileId = await createProfile(projectId, {
      resourceTypeId: validRt,
      ownerKind: 'ROLE',
      planningBasis: 'DEMAND_FOLLOWING',
      source: 'FIXED',
      defaultPercent: 100,
    })
    const unprofiledRt = await createRole(projectId, { allocationMode: 'TIMELINE' })
    const { plan } = await runDryRun()
    expect(plan.operations).toHaveLength(1) // only the unprofiled RT

    // The previously valid profile becomes structurally invalid.
    await prisma.capacityProfile.update({
      where: { id: validProfileId },
      data: { startWeek: 5, endWeek: 10 },
    })
    const baseline = await snapshotCounts()
    const outcome = await applyRemediationPlan(prisma, { plan })
    expect(outcome.exitCode).toBe(1)
    expect(outcome.errors.join(' ')).toContain('complete remediation state changed since dry-run')
    await assertZeroWrites(baseline)
    void unprofiledRt
  })

  it('refuses before writes when a new untranslatable BacklogSnapshot is inserted', async () => {
    const projectId = await createProject()
    await createRole(projectId, { allocationMode: 'TIMELINE' })
    const { plan } = await runDryRun()
    expect(plan.operations).toHaveLength(1)

    await createBacklogSnapshot(projectId, v2Snapshot({
      resourceTypes: [v2Role({ id: 'rt-drift-snap', allocationMode: 'EFFORT' })],
      namedResources: [
        v2Person({ id: 'nr-drift', resourceTypeId: 'rt-drift-snap', allocationMode: 'CAPACITY_PLAN' }),
      ],
    }))
    const baseline = await snapshotCounts()
    const outcome = await applyRemediationPlan(prisma, { plan })
    expect(outcome.exitCode).toBe(1)
    await assertZeroWrites(baseline)
  })

  it('refuses before writes when an existing unplanned snapshot entry changes', async () => {
    const projectId = await createProject()
    await createRole(projectId, { allocationMode: 'TIMELINE' })
    const snapshotId = await createBacklogSnapshot(projectId, v2Snapshot({
      resourceTypes: [v2Role({ id: 'rt-snap-e', allocationMode: 'EFFORT' })],
      namedResources: [
        v2Person({ id: 'nr-snap-e', resourceTypeId: 'rt-snap-e', allocationMode: 'CAPACITY_PLAN', allocationStartWeek: 0, allocationEndWeek: 10 }),
      ],
    }))
    const { plan } = await runDryRun()
    expect(plan.operations).toHaveLength(1)

    // Change the already-valid unplanned entry (stays translatable).
    const row = await prisma.backlogSnapshot.findUniqueOrThrow({ where: { id: snapshotId } })
    const snap = structuredClone(row.snapshot) as Record<string, unknown>
    const nrs = snap.namedResources as Array<Record<string, unknown>>
    nrs.find(e => e.id === 'nr-snap-e')!.allocationPercent = 90
    await prisma.backlogSnapshot.update({ where: { id: snapshotId }, data: { snapshot: snap as never } })

    const baseline = await snapshotCounts()
    const outcome = await applyRemediationPlan(prisma, { plan })
    expect(outcome.exitCode).toBe(1)
    expect(outcome.errors.join(' ')).toContain('complete remediation state changed since dry-run')
    await assertZeroWrites(baseline)
  })

  it('refuses before writes when an active CapacityPlan changes outside operation evidence', async () => {
    const projectId = await createProject()
    // A planner-owned RT with a valid ROLE profile (no operation for it).
    const plannerRt = await createRole(projectId, { allocationMode: 'CAPACITY_PLAN', count: 1 })
    await createActivePlan(projectId, [
      { periodIndex: 0, startWeek: 0, endWeek: 8, entries: [{ resourceTypeId: plannerRt, headcount: 1 }] },
    ])
    const plannerProfileId = await createProfile(projectId, {
      resourceTypeId: plannerRt,
      ownerKind: 'ROLE',
      planningBasis: 'CAPACITY_PROFILE',
      source: 'SQUAD_PLANNER',
      defaultPercent: 100,
      segments: [{ id: 'seg-planner', startWeek: 0, endWeek: 7, capacityPercent: 100, source: 'SQUAD_PLANNER' }],
    })
    // An unprofiled RT produces the operation.
    await createRole(projectId, { allocationMode: 'TIMELINE' })
    const { plan } = await runDryRun()
    expect(plan.operations).toHaveLength(1)

    // Change the plan entry for the ALREADY VALID planner RT (outside the
    // operation's local evidence).
    await prisma.capacityPlanEntry.updateMany({
      where: { resourceTypeId: plannerRt },
      data: { headcount: 2 },
    })
    const baseline = await snapshotCounts()
    const outcome = await applyRemediationPlan(prisma, { plan })
    expect(outcome.exitCode).toBe(1)
    expect(outcome.errors.join(' ')).toContain('complete remediation state changed since dry-run')
    await assertZeroWrites(baseline)
    void plannerProfileId
  })

  it('refuses before writes when a cross-project ownership defect appears', async () => {
    const projectId = await createProject()
    await createRole(projectId, { allocationMode: 'TIMELINE' })
    const { plan } = await runDryRun()
    expect(plan.operations).toHaveLength(1)

    // A profile in this project referencing a ResourceType owned by another
    // project (cross-project ownership — the partial unique indexes still
    // allow the FK, so this row is insertable).
    const otherProjectId = await createProject('Other Project')
    const otherRt = await createRole(otherProjectId, { allocationMode: 'EFFORT' })
    await prisma.capacityProfile.create({
      data: {
        projectId,
        resourceTypeId: otherRt,
        ownerKind: 'ROLE',
        planningBasis: 'DEMAND_FOLLOWING',
        source: 'FIXED',
        defaultPercent: 100,
      },
    })
    const baseline = await snapshotCounts()
    const outcome = await applyRemediationPlan(prisma, { plan })
    expect(outcome.exitCode).toBe(1)
    await assertZeroWrites(baseline)
  })

  it('refuses before writes on mixed partial state (one op manually applied)', async () => {
    const projectId = await createProject()
    const rtA = await createRole(projectId, { allocationMode: 'TIMELINE' })
    const rtB = await createRole(projectId, { allocationMode: 'EFFORT' })
    const { plan } = await runDryRun()
    expect(plan.operations).toHaveLength(2)

    // Manually apply exactly one of the two proposed profiles.
    const opA = plan.operations.find(op => op.ownerId === rtA)!
    const proposed = opA.proposed as { profileId: string; planningBasis: string; source: string; defaultPercent: number | null; startWeek: number | null; endWeek: number | null; legacy?: unknown }
    await prisma.capacityProfile.create({
      data: {
        id: proposed.profileId,
        projectId,
        resourceTypeId: rtA,
        ownerKind: 'ROLE',
        planningBasis: proposed.planningBasis as $Enums.CapacityProfilePlanningBasis,
        source: proposed.source as $Enums.CapacityProfileSource,
        defaultPercent: proposed.defaultPercent,
        startWeek: proposed.startWeek,
        endWeek: proposed.endWeek,
        legacy: proposed.legacy as never,
      },
    })

    const baseline = await snapshotCounts()
    const outcome = await applyRemediationPlan(prisma, { plan })
    expect(outcome.exitCode).toBe(1)
    expect(outcome.errors.join(' ')).toContain('complete remediation state changed since dry-run')
    await assertZeroWrites(baseline)
    void rtB
  })

  it('exact post-apply rerun is a no-op for both invocation forms', async () => {
    const projectId = await createProject()
    await createRole(projectId, { allocationMode: 'TIMELINE' })
    await createRole(projectId, { allocationMode: 'CAPACITY_PLAN' })
    const { plan } = await runDryRun()
    const manifest = await buildManifest(plan, [{
      decisionId: plan.decisions.find(d => d.ownerKind === 'role')!.id,
      resolution: { shape: 'scalar-profile', planningBasis: 'DEMAND_FOLLOWING', defaultPercent: 100 },
    }])

    // Resolved-plan form (as saved by dry-run with a manifest).
    const resolved = resolvePlanWithManifest(plan, manifest)
    expect(resolved.errors).toEqual([])
    const first = await applyRemediationPlan(prisma, { plan: resolved.plan })
    expect(first.exitCode).toBe(0)
    expect(first.applied).toBe(2)
    const rerun = await applyRemediationPlan(prisma, { plan: resolved.plan })
    expect(rerun.exitCode).toBe(0)
    expect(rerun.applied).toBe(0)
    expect(rerun.skipped).toBe(2)

    // Baseline-plan-plus-manifest form: first apply and rerun both work.
    const secondFirst = await applyRemediationPlan(prisma, { plan, manifest })
    expect(secondFirst.exitCode).toBe(0)
    expect(secondFirst.skipped).toBe(2)
    const secondRerun = await applyRemediationPlan(prisma, { plan, manifest })
    expect(secondRerun.exitCode).toBe(0)
    expect(secondRerun.applied).toBe(0)
    expect(secondRerun.skipped).toBe(2)
    expect(await prisma.capacityProfile.count()).toBe(2)
  })

  it('baseline-plan-plus-manifest and resolved-plan forms enforce the same full-scope drift contract', async () => {
    const projectId = await createProject()
    await createRole(projectId, { allocationMode: 'TIMELINE' })
    const { plan } = await runDryRun()
    const manifest = await buildManifest(plan, [])
    const resolved = resolvePlanWithManifest(plan, manifest)
    expect(resolved.errors).toEqual([])

    await createRole(projectId, { allocationMode: 'EFFORT' })
    const baseline = await snapshotCounts()
    const baseOutcome = await applyRemediationPlan(prisma, { plan, manifest })
    expect(baseOutcome.exitCode).toBe(1)
    const resolvedOutcome = await applyRemediationPlan(prisma, { plan: resolved.plan })
    expect(resolvedOutcome.exitCode).toBe(1)
    await assertZeroWrites(baseline)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 6. End-to-end readiness on a database with every production blocker class
// ════════════════════════════════════════════════════════════════════════════

describeIf('remediation end-to-end', () => {
  it('fails readiness → dry-runs → applies approved plan → audit + readiness pass → runtime + rollback work', async () => {
    const projectId = await createProject('Blocker Zoo')

    // A. Missing ROLE profiles (deterministic + decision).
    const timelineRt = await createRole(projectId, { allocationMode: 'TIMELINE', allocationPercent: 75 })
    const effortRt = await createRole(projectId, { allocationMode: 'EFFORT' })
    const fullRt = await createRole(projectId, { allocationMode: 'FULL_PROJECT' })
    const capPlanRt = await createRole(projectId, { allocationMode: 'CAPACITY_PLAN' })

    // B. Missing NAMED_PERSON profiles (deterministic + decision).
    const personRt = await createRole(projectId, { allocationMode: 'TIMELINE' })
    const timelineNr = await createNamedPerson(projectId, personRt, { allocationMode: 'TIMELINE', startWeek: 0, endWeek: 6 })
    const capNr = await createNamedPerson(projectId, personRt, { allocationMode: 'CAPACITY_PLAN' })

    // C. Planner-owned RT without ROLE profile (deterministic reconstruction).
    const plannerRt = await createRole(projectId, { allocationMode: 'CAPACITY_PLAN', count: 1 })
    await createActivePlan(projectId, [
      { periodIndex: 0, startWeek: 0, endWeek: 8, entries: [{ resourceTypeId: plannerRt, headcount: 1 }] },
    ])

    // D. Invalid persisted profiles.
    await createProfile(projectId, {
      namedResourceId: timelineNr,
      ownerKind: 'NAMED_PERSON',
      planningBasis: 'DEMAND_FOLLOWING',
      source: 'FIXED',
      defaultPercent: 100,
      startWeek: 0,
      endWeek: 29,
      legacy: { allocationMode: 'EFFORT' },
    })
    await createProfile(projectId, {
      resourceTypeId: effortRt,
      ownerKind: 'ROLE',
      planningBasis: 'CAPACITY_PROFILE',
      source: 'LEGACY',
      defaultPercent: 100,
      legacy: { allocationMode: 'CAPACITY_PLAN', allocationStartWeek: null, allocationEndWeek: null },
    })

    // E. Historical v2 snapshots: valid + never-active + windowless + single -1.
    const neverActiveSnapshotId = await createBacklogSnapshot(projectId, v2Snapshot({
      resourceTypes: [v2Role({ id: 'rt-e2e-snap', allocationMode: 'EFFORT' })],
      namedResources: [
        v2Person({ id: 'nr-e2e-neg', resourceTypeId: 'rt-e2e-snap', allocationMode: 'CAPACITY_PLAN', allocationPercent: 100, startWeek: -1, endWeek: -1 }),
      ],
    }))
    const windowlessSnapshotId = await createBacklogSnapshot(projectId, v2Snapshot({
      resourceTypes: [v2Role({ id: 'rt-e2e-snap2', allocationMode: 'EFFORT' })],
      namedResources: [
        v2Person({ id: 'nr-e2e-windowless', resourceTypeId: 'rt-e2e-snap2', allocationMode: 'CAPACITY_PLAN', allocationPercent: 100, startWeek: null, endWeek: null }),
      ],
    }))
    await createBacklogSnapshot(projectId, v2Snapshot({
      resourceTypes: [v2Role({ id: 'rt-e2e-snap3', allocationMode: 'EFFORT' })],
      namedResources: [
        v2Person({ id: 'nr-e2e-single', resourceTypeId: 'rt-e2e-snap3', allocationMode: 'CAPACITY_PLAN', allocationPercent: 100, startWeek: 0, endWeek: -1 }),
      ],
    }))

    // 1. Readiness fails before remediation.
    const before = await runProductionMigrationReadiness(prisma)
    expect(before.passed).toBe(false)

    // 2. Dry-run reports the expected classes.
    const { plan } = await runDryRun()
    expect(plan.summary.findings.deterministic).toBeGreaterThanOrEqual(5)
    expect(plan.summary.findings.decisionRequired).toBeGreaterThanOrEqual(4)
    expect(classifyPlanExit(plan)).toBe(2)

    // 3. Approved plan applies (all decisions supplied).
    const decisions = plan.decisions.filter(d => d.snapshotId === windowlessSnapshotId)
    const manifest = await buildManifest(plan, [
      ...decisions.map(d => ({
        decisionId: d.id,
        resolution: { shape: 'snapshot-window-interpretation' as const, startWeek: 0, endWeek: 10 },
      })),
      {
        decisionId: plan.decisions.find(d => d.ownerId === capPlanRt)!.id,
        resolution: { shape: 'scalar-profile' as const, planningBasis: 'DEMAND_FOLLOWING' as const, defaultPercent: 100 },
      },
      {
        decisionId: plan.decisions.find(d => d.ownerId === capNr)!.id,
        resolution: {
          shape: 'owner-kind-decision' as const,
          ownerKind: 'NAMED_PERSON' as const,
          capacity: { shape: 'availability-window' as const, defaultPercent: 100, startWeek: 0, endWeek: 12 },
        },
      },
      {
        decisionId: plan.decisions.find(d => d.profileId !== null && d.ownerId === effortRt)!.id,
        resolution: { shape: 'segmented-capacity-profile' as const, defaultPercent: 100, segments: [{ startWeek: 0, endWeek: 20, capacityPercent: 100 }] },
      },
    ])

    // The single -1 snapshot entry remains unresolved → apply refused.
    const unresolvedOutcome = await applyRemediationPlan(prisma, { plan, manifest })
    expect(unresolvedOutcome.exitCode).toBe(2)
    expect(await prisma.capacityProfile.count()).toBe(2) // only the two seeded profiles

    // Resolve the single -1 entry as well.
    const singleNegDecisions = plan.decisions.filter(d => d.snapshotId !== null && d.snapshotId !== windowlessSnapshotId)
    const fullManifest = await buildManifest(plan, [
      ...manifest.decisions.map(d => ({ decisionId: d.decisionId, resolution: d.resolution })),
      ...singleNegDecisions.map(d => ({
        decisionId: d.id,
        resolution: { shape: 'snapshot-window-interpretation' as const, startWeek: 0, endWeek: 5 },
      })),
    ])
    const outcome = await applyRemediationPlan(prisma, { plan, manifest: fullManifest })
    expect(outcome.errors).toEqual([])
    expect(outcome.exitCode).toBe(0)
    expect(outcome.postApply!.readinessPassed).toBe(true)
    // Deterministic findings may remain only for policy-normalised snapshot
    // entries (never-active windows) that require no write.
    expect(outcome.postApply!.planFindings.deterministic).toBeGreaterThanOrEqual(1)
    expect(outcome.postApply!.planFindings.decisionRequired).toBe(0)
    expect(outcome.postApply!.planFindings.unsupported).toBe(0)

    // 4. Permanent audit passes.
    const audit = await runOwnershipAudit(prisma)
    expect(audit.isClean).toBe(true)

    // 5. Readiness passes.
    const after = await runProductionMigrationReadiness(prisma)
    expect(after.passed).toBe(true)

    // 6. Resource Profile / Timeline / scheduler load successfully (profile-first).
    const resolved = await resolveSchedulerCapacity(prisma, projectId)
    expect(resolved.resourceTypes.length).toBeGreaterThanOrEqual(4)
    expect(resolved.meta.legacyCount).toBe(0)
    const timelineProfile = await prisma.capacityProfile.findFirstOrThrow({ where: { resourceTypeId: timelineRt } })
    expect(timelineProfile.planningBasis).toBe('AVAILABILITY_WINDOW')

    // 7. Representative snapshot restoration succeeds (v2 rollback) — proven
    // in a dedicated self-contained project below.
    void neverActiveSnapshotId
    void fullRt

    // 8. No legacy candidate column removed.
    expect(await candidateColumnsPresent()).toBe(true)
  })

  it('restores a representative v2 snapshot after remediation (readiness/rollback agreement)', async () => {
    const projectId = await createProject('Rollback Project')
    const rt = await createRole(projectId, { allocationMode: 'TIMELINE', allocationStartWeek: 0, allocationEndWeek: 10 })
    const nr = await createNamedPerson(projectId, rt, { allocationMode: 'CAPACITY_PLAN', startWeek: 0, endWeek: 10 })
    const snapshotId = await createBacklogSnapshot(projectId, v2Snapshot({
      resourceTypes: [v2Role({ id: rt, allocationMode: 'TIMELINE', allocationStartWeek: 0, allocationEndWeek: 10 })],
      namedResources: [
        v2Person({ id: nr, resourceTypeId: rt, allocationMode: 'CAPACITY_PLAN', allocationStartWeek: 0, allocationEndWeek: 10 }),
      ],
    }))

    const { plan } = await runDryRun()
    const outcome = await applyRemediationPlan(prisma, { plan })
    expect(outcome.exitCode).toBe(0)

    await rollbackProjectSnapshot({ projectId, snapshotId, userId: ownerId, db: prisma })
    const profiles = await prisma.capacityProfile.findMany({ where: { projectId } })
    expect(profiles).toHaveLength(2)
    const roleProfile = profiles.find(p => p.ownerKind === 'ROLE')
    expect(roleProfile).toMatchObject({ planningBasis: 'AVAILABILITY_WINDOW', startWeek: 0, endWeek: 10 })
    const namedProfile = profiles.find(p => p.ownerKind === 'NAMED_PERSON')
    expect(namedProfile).toMatchObject({ planningBasis: 'AVAILABILITY_WINDOW', source: 'LEGACY', startWeek: 0, endWeek: 10 })

    const readiness = await runProductionMigrationReadiness(prisma)
    expect(readiness.passed).toBe(true)
  })
})
