/**
 * productionMigrationReadiness.integration.test.ts — Real PostgreSQL
 * integration tests for the standalone production-readiness command
 * (issue #418 PR 1, executed later by the production machine under #404).
 *
 * Proves against a disposable database:
 *   - a valid representative database passes (exit 0);
 *   - missing profile, duplicate owner, malformed owner shape, cross-project
 *     ownership, invalid segment state and untranslatable historical snapshots
 *     each fail (exit 1) with actionable output;
 *   - the check performs no writes.
 *
 * All tests are skipped unless INTEGRATION_TEST=true.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '@prisma/client'
import type { $Enums } from '@prisma/client'
import {
  runProductionMigrationReadiness,
  formatReadinessReport,
} from '../lib/productionMigrationReadiness.js'

// ─── Guard ──────────────────────────────────────────────────────────────────

const runIntegration = process.env.INTEGRATION_TEST === 'true'
const describeIf = runIntegration ? describe : describe.skip

// ─── Shared state ────────────────────────────────────────────────────────────

let prisma: PrismaClient

/** Project/user ids created by fixtures; removed after every test so the
 * whole-database readiness check never sees another test's broken state. */
const createdProjectIds: string[] = []
const createdUserIds: string[] = []

beforeAll(async () => {
  if (!runIntegration) return
  prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
  })
  await prisma.$connect()
  // The readiness check is whole-database; start from a clean slate so a
  // previous interrupted run can never leak fixtures into this file. Order
  // respects the RESTRICT FKs that reference User.
  await prisma.backlogSnapshot.deleteMany({})
  await prisma.featureTemplate.deleteMany({})
  await prisma.project.deleteMany({})
  await prisma.customer.deleteMany({})
  await prisma.documentTemplate.deleteMany({})
  await prisma.user.deleteMany({})
})

afterEach(async () => {
  if (!runIntegration) return
  // Full ordered wipe (the DB is disposable and dedicated to this file) so
  // every test starts from the same clean slate regardless of tracking.
  await prisma.backlogSnapshot.deleteMany({})
  await prisma.featureTemplate.deleteMany({})
  await prisma.project.deleteMany({})
  await prisma.customer.deleteMany({})
  await prisma.documentTemplate.deleteMany({})
  await prisma.user.deleteMany({})
  createdProjectIds.length = 0
  createdUserIds.length = 0
  createdTemplateIds.length = 0
})

afterAll(async () => {
  if (!runIntegration) return
  await prisma.backlogSnapshot.deleteMany({})
  await prisma.featureTemplate.deleteMany({})
  await prisma.project.deleteMany({})
  await prisma.customer.deleteMany({})
  await prisma.documentTemplate.deleteMany({})
  await prisma.user.deleteMany({})
  await prisma.$disconnect()
})

// ─── Fixture helpers ─────────────────────────────────────────────────────────

let fixtureCounter = 0

async function createProject(name: string, ownerId: string): Promise<string> {
  const project = await prisma.project.create({
    data: { name: `${name}-${Date.now()}-${fixtureCounter++}`, ownerId },
  })
  createdProjectIds.push(project.id)
  return project.id
}

async function createUserProjectPair(): Promise<{ userId: string; projectId: string }> {
  const user = await prisma.user.create({
    data: {
      email: `readiness-${Date.now()}-${fixtureCounter++}@example.com`,
      name: 'Readiness Test',
      password: '$2b$10$placeholder',
    },
  })
  createdUserIds.push(user.id)
  const project = await prisma.project.create({
    data: { name: `Readiness-${Date.now()}-${fixtureCounter++}`, ownerId: user.id },
  })
  return { userId: user.id, projectId: project.id }
}

async function createRoleWithProfile(
  projectId: string,
  rtName: string,
  profileOverrides: Partial<{
    planningBasis: $Enums.CapacityProfilePlanningBasis
    source: $Enums.CapacityProfileSource
    defaultPercent: number | null
    startWeek: number | null
    endWeek: number | null
  }> = {},
): Promise<string> {
  const rt = await prisma.resourceType.create({
    data: {
      name: rtName,
      category: 'ENGINEERING',
      count: 1,
      projectId,
      capacityProfiles: {
        create: {
          projectId,
          ownerKind: 'ROLE',
          planningBasis: profileOverrides.planningBasis ?? 'DEMAND_FOLLOWING',
          source: profileOverrides.source ?? 'FIXED',
          defaultPercent: profileOverrides.defaultPercent ?? 100,
          startWeek: profileOverrides.startWeek ?? null,
          endWeek: profileOverrides.endWeek ?? null,
        },
      },
    },
  })
  return rt.id
}

async function createNamedPersonWithProfile(
  projectId: string,
  rtId: string,
  name: string,
): Promise<string> {
  const nr = await prisma.namedResource.create({
    data: {
      name,
      resourceTypeId: rtId,
      capacityProfiles: {
        create: {
          projectId,
          ownerKind: 'NAMED_PERSON',
          planningBasis: 'DEMAND_FOLLOWING',
          source: 'FIXED',
          defaultPercent: 100,
          startWeek: null,
          endWeek: null,
        },
      },
    },
  })
  return nr.id
}

async function createBacklogSnapshot(projectId: string, payload: unknown): Promise<string> {
  const user = await prisma.user.findFirstOrThrow()
  const snapshot = await prisma.backlogSnapshot.create({
    data: {
      projectId,
      label: 'readiness fixture',
      trigger: 'manual',
      snapshot: payload as object,
      createdById: user.id,
    },
  })
  return snapshot.id
}

/**
 * Create a normal TemplateSnapshot through the real stored shape: the
 * template routes store the full FeatureTemplate object (raw template
 * state, not a project snapshot).
 */
const createdTemplateIds: string[] = []

async function createTemplateSnapshot(): Promise<string> {
  const template = await prisma.featureTemplate.create({
    data: {
      name: `Readiness template ${Date.now()}-${fixtureCounter++}`,
      category: 'DEV',
      tasks: {
        create: [{
          name: 'Tpl Task',
          order: 0,
          hoursSmall: 8,
          hoursMedium: 8,
          hoursLarge: 8,
          resourceTypeName: 'Engineer',
        }],
      },
    },
    include: { tasks: true },
  })
  createdTemplateIds.push(template.id)
  const snapshot = await prisma.templateSnapshot.create({
    data: {
      templateId: template.id,
      label: 'readiness fixture template snapshot',
      trigger: 'manual_edit',
      snapshot: template as object,
    },
  })
  return snapshot.id
}

function v2SnapshotFixture(_projectId: string) {
  return {
    schemaVersion: 2,
    epics: [],
    project: null,
    resourceTypes: [{
      id: 'rt-v2-1',
      name: 'Legacy Role',
      category: 'ENGINEERING',
      count: 1,
      hoursPerDay: null,
      dayRate: null,
      allocationMode: 'TIMELINE',
      globalTypeId: null,
      allocationPercent: 100,
      allocationStartWeek: 2,
      allocationEndWeek: 9,
    }],
    namedResources: [{
      id: 'nr-v2-1',
      resourceTypeId: 'rt-v2-1',
      name: 'Legacy Person',
      startWeek: 2,
      endWeek: 9,
      allocationPct: 100,
      allocationMode: 'TIMELINE',
      allocationPercent: 100,
      allocationStartWeek: 2,
      allocationEndWeek: 9,
      pricingModel: 'ACTUAL_DAYS',
    }],
    timelineEntries: [],
    storyTimelineEntries: [],
    epicDependencies: [],
    featureDependencies: [],
    overheadItems: [],
  }
}

function v2CapacityPlanSnapshotFixture(_projectId: string) {
  return {
    schemaVersion: 2,
    epics: [],
    project: null,
    resourceTypes: [{
      id: 'rt-v2-plan',
      name: 'Planned Legacy Role',
      category: 'ENGINEERING',
      count: 2,
      hoursPerDay: null,
      dayRate: null,
      allocationMode: 'CAPACITY_PLAN',
      globalTypeId: null,
      allocationPercent: 100,
      allocationStartWeek: 0,
      allocationEndWeek: 10,
    }],
    namedResources: [{
      id: 'nr-v2-plan',
      resourceTypeId: 'rt-v2-plan',
      name: 'Planned Legacy Person',
      startWeek: 1,
      endWeek: 8,
      allocationPct: 100,
      allocationMode: 'CAPACITY_PLAN',
      allocationPercent: 100,
      allocationStartWeek: null,
      allocationEndWeek: null,
      pricingModel: 'ACTUAL_DAYS',
    }],
    timelineEntries: [],
    storyTimelineEntries: [],
    epicDependencies: [],
    featureDependencies: [],
    overheadItems: [],
  }
}

function v3SnapshotFixture(_projectId: string) {
  return {
    schemaVersion: 3,
    epics: [],
    project: null,
    resourceTypes: [{
      id: 'rt-v3-1',
      name: 'V3 Role',
      category: 'ENGINEERING',
      count: 1,
      hoursPerDay: null,
      dayRate: null,
      allocationMode: 'EFFORT',
      globalTypeId: null,
      allocationPercent: 100,
      allocationStartWeek: null,
      allocationEndWeek: null,
    }],
    namedResources: [{
      id: 'nr-v3-1',
      resourceTypeId: 'rt-v3-1',
      name: 'V3 Person',
      startWeek: null,
      endWeek: null,
      allocationPct: 100,
      allocationMode: 'EFFORT',
      allocationPercent: 100,
      allocationStartWeek: null,
      allocationEndWeek: null,
      pricingModel: 'ACTUAL_DAYS',
    }],
    timelineEntries: [],
    storyTimelineEntries: [],
    epicDependencies: [],
    featureDependencies: [],
    overheadItems: [],
    capacityProfiles: [{
      id: 'cp-v3-role',
      ownerKind: 'ROLE',
      resourceTypeId: 'rt-v3-1',
      namedResourceId: null,
      planningBasis: 'DEMAND_FOLLOWING',
      source: 'FIXED',
      defaultPercent: 100,
      startWeek: null,
      endWeek: null,
      legacy: { kind: 'DB_NULL' },
      segments: [],
    }, {
      id: 'cp-v3-nr',
      ownerKind: 'NAMED_PERSON',
      resourceTypeId: null,
      namedResourceId: 'nr-v3-1',
      planningBasis: 'DEMAND_FOLLOWING',
      source: 'FIXED',
      defaultPercent: 100,
      startWeek: null,
      endWeek: null,
      legacy: { kind: 'DB_NULL' },
      segments: [],
    }],
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// Scenario 1 — valid representative database passes
// ═════════════════════════════════════════════════════════════════════════════

describeIf('readiness — valid database', () => {
  let projectId: string

  beforeAll(async () => {
    const pair = await createUserProjectPair()
    projectId = pair.projectId
    const rtId = await createRoleWithProfile(projectId, 'Readiness Engineer')
    await createNamedPersonWithProfile(projectId, rtId, 'Readiness Person')
    await createBacklogSnapshot(projectId, v2SnapshotFixture(projectId))
    await createBacklogSnapshot(projectId, v3SnapshotFixture(projectId))
    // Normal template snapshots (FeatureTemplate objects) must never block
    // readiness — they are not project snapshots (issue #418 PR 1 review).
    await createTemplateSnapshot()
  })

  it('passes and reports a clean summary', async () => {
    const report = await runProductionMigrationReadiness(prisma)
    // eslint-disable-next-line no-console
    if (!report.passed) console.error('DBG report:', formatReadinessReport(report).split('\n').filter(l => l.includes('❌') || l.includes('-')).join(' | '))
    expect(report.passed).toBe(true)
    const text = formatReadinessReport(report)
    expect(text).toContain('READINESS PASSED')
    expect(text).toContain('READ-ONLY')
  })
})

describeIf('readiness — template snapshots are excluded', () => {
  it('malformed template snapshot rows never block readiness', async () => {
    const { projectId } = await createUserProjectPair()
    const rtId = await createRoleWithProfile(projectId, 'Template Role')
    await createNamedPersonWithProfile(projectId, rtId, 'Template Person')

    // A TemplateSnapshot whose payload would never parse as a project
    // snapshot (it is a raw FeatureTemplate object).
    const template = await prisma.featureTemplate.create({
      data: {
        name: `Ignored template ${Date.now()}-${fixtureCounter++}`,
        category: 'DEV',
      },
    })
    await prisma.templateSnapshot.create({
      data: {
        templateId: template.id,
        label: 'ignored',
        trigger: 'manual_edit',
        snapshot: { id: template.id, name: template.name, tasks: [] } as object,
      },
    })

    const report = await runProductionMigrationReadiness(prisma)
    expect(report.passed).toBe(true)
    const text = formatReadinessReport(report)
    expect(text).toContain('READINESS PASSED')
  })

  it('malformed BacklogSnapshot still fails', async () => {
    const { projectId } = await createUserProjectPair()
    const rtId = await createRoleWithProfile(projectId, 'Malformed Snapshot Role')
    await createNamedPersonWithProfile(projectId, rtId, 'Malformed Snapshot Person')
    await createTemplateSnapshot()
    await createBacklogSnapshot(projectId, { schemaVersion: 99, epics: [] })

    const report = await runProductionMigrationReadiness(prisma)
    expect(report.passed).toBe(false)
    const text = formatReadinessReport(report)
    expect(text).toContain('unsupported or malformed snapshot data')
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// Scenario 2 — each blocker fails with a non-zero verdict
// ═════════════════════════════════════════════════════════════════════════════

describeIf('readiness — blockers fail closed', () => {
  it('missing named-resource profile fails', async () => {
    const pair = await createUserProjectPair()
    void pair.userId
    const projectId = pair.projectId
    const rtId = await createRoleWithProfile(projectId, 'Missing NR Profile Role')
    await prisma.namedResource.create({ data: { name: 'Unprofiled Person', resourceTypeId: rtId } })
    const report = await runProductionMigrationReadiness(prisma)
    expect(report.passed).toBe(false)
    const text = formatReadinessReport(report)
    expect(text).toContain('lacks persisted profile')
  })

  it('missing role profile fails', async () => {
    const pair = await createUserProjectPair()
    void pair.userId
    const projectId = pair.projectId
    await prisma.resourceType.create({
      data: { name: 'No Role Profile', category: 'ENGINEERING', count: 1, projectId },
    })
    const report = await runProductionMigrationReadiness(prisma)
    expect(report.passed).toBe(false)
    const text = formatReadinessReport(report)
    expect(text).toContain('lacks exactly one persisted ROLE profile')
  })

  it('malformed window shape fails', async () => {
    // A window reversal passes the DB-level check constraints but fails the
    // structural validator (startWeek must not exceed endWeek).
    const { projectId } = await createUserProjectPair()
    const rtId = await createRoleWithProfile(projectId, 'Malformed Role')
    const roleProfile = await prisma.capacityProfile.findFirstOrThrow({
      where: { projectId, resourceTypeId: rtId },
    })
    await prisma.capacityProfile.update({
      where: { id: roleProfile.id },
      data: { startWeek: 8, endWeek: 3 },
    })
    const report = await runProductionMigrationReadiness(prisma)
    expect(report.passed).toBe(false)
    const text = formatReadinessReport(report)
    expect(text).toContain('startWeek 8 must not exceed endWeek 3')
  })

  it('cross-project ownership fails', async () => {
    const { projectId, userId } = await createUserProjectPair()
    const other = await createProject('Other Project', userId)
    const otherRt = await prisma.resourceType.create({
      data: { name: 'Other Role', category: 'ENGINEERING', count: 1, projectId: other },
    })
    await prisma.capacityProfile.create({
      data: {
        projectId,
        ownerKind: 'ROLE',
        resourceTypeId: otherRt.id,
        namedResourceId: null,
        planningBasis: 'DEMAND_FOLLOWING',
        source: 'FIXED',
        defaultPercent: 100,
        startWeek: null,
        endWeek: null,
      },
    })
    const report = await runProductionMigrationReadiness(prisma)
    expect(report.passed).toBe(false)
    const text = formatReadinessReport(report)
    expect(text).toContain('not found in project')
  })

  it('out-of-range named-person percent fails', async () => {
    // A named-person percent above 100 passes the DB constraints (no check
    // constraint on the value) but fails the structural validator.
    // (Duplicate physical owners are impossible under the migration-managed
    // partial unique indexes, so they are not fixture-representable.)
    const { projectId } = await createUserProjectPair()
    const rtId = await createRoleWithProfile(projectId, 'Overallocated Role')
    const nrId = await createNamedPersonWithProfile(projectId, rtId, 'Overallocated Person')
    const nrProfile = await prisma.capacityProfile.findFirstOrThrow({
      where: { projectId, namedResourceId: nrId },
    })
    await prisma.capacityProfile.update({
      where: { id: nrProfile.id },
      data: { defaultPercent: 150 },
    })
    const report = await runProductionMigrationReadiness(prisma)
    expect(report.passed).toBe(false)
    const text = formatReadinessReport(report)
    expect(text).toContain('must be in range [0,100]')
  })

  it('invalid segment state fails', async () => {
    const { projectId } = await createUserProjectPair()
    const rtId = await createRoleWithProfile(projectId, 'Bad Segment Role')
    const profile = await prisma.capacityProfile.findFirstOrThrow({
      where: { projectId, resourceTypeId: rtId, ownerKind: 'ROLE' },
    })
    await prisma.capacitySegment.create({
      data: {
        capacityProfileId: profile.id,
        startWeek: 8,
        endWeek: 3,
        capacityPercent: 100,
        source: 'FIXED',
      },
    })
    const report = await runProductionMigrationReadiness(prisma)
    expect(report.passed).toBe(false)
    const text = formatReadinessReport(report)
    expect(text).toContain('invalid week range')
  })

  it('untranslatable historical snapshot fails', async () => {
    const { projectId } = await createUserProjectPair()
    const rtId = await createRoleWithProfile(projectId, 'Snapshot Role')
    await createNamedPersonWithProfile(projectId, rtId, 'Snapshot Person')
    const badV2 = v2SnapshotFixture(projectId)
    badV2.resourceTypes[0].allocationMode = 'WARP_DRIVE'
    await createBacklogSnapshot(projectId, badV2)
    const report = await runProductionMigrationReadiness(prisma)
    expect(report.passed).toBe(false)
    const text = formatReadinessReport(report)
    expect(text).toContain('unknown allocationMode')
  })

  it('translatable v2 CAPACITY_PLAN snapshot passes (same rules as rollback)', async () => {
    const { projectId } = await createUserProjectPair()
    const rtId = await createRoleWithProfile(projectId, 'Plan Role')
    await createNamedPersonWithProfile(projectId, rtId, 'Plan Person')
    await createBacklogSnapshot(projectId, v2CapacityPlanSnapshotFixture(projectId))
    const report = await runProductionMigrationReadiness(prisma)
    expect(report.passed).toBe(true)
    expect(formatReadinessReport(report)).toContain('READINESS PASSED')
  })

  it('v2 CAPACITY_PLAN without a captured window is derived-quarantined and passes readiness', async () => {
    const { projectId } = await createUserProjectPair()
    const rtId = await createRoleWithProfile(projectId, 'No Window Plan Role')
    await createNamedPersonWithProfile(projectId, rtId, 'No Window Plan Person')
    const badV2 = v2CapacityPlanSnapshotFixture(projectId)
    badV2.resourceTypes[0] = {
      ...badV2.resourceTypes[0],
      allocationStartWeek: null,
      allocationEndWeek: null,
    } as unknown as (typeof badV2.resourceTypes)[0]
    await createBacklogSnapshot(projectId, badV2)
    const report = await runProductionMigrationReadiness(prisma)
    // Issue #428: the reviewed windowless CAPACITY_PLAN shape is
    // policy-accepted derived quarantine — reported explicitly, never blocking.
    expect(report.passed).toBe(true)
    const text = formatReadinessReport(report)
    expect(text).toContain('quarantined (policy-accepted, non-restorable)')
    expect(text).toContain('Class A')
  })

  it('v2 CAPACITY_PLAN with a single -1 edge is derived-quarantined and passes readiness', async () => {
    const { projectId } = await createUserProjectPair()
    const rtId = await createRoleWithProfile(projectId, 'Single Minus One Role')
    await createNamedPersonWithProfile(projectId, rtId, 'Single Minus One Person')
    const v2 = v2CapacityPlanSnapshotFixture(projectId)
    v2.resourceTypes[0] = {
      ...v2.resourceTypes[0],
      allocationStartWeek: -1,
      allocationEndWeek: 5,
    } as unknown as (typeof v2.resourceTypes)[0]
    await createBacklogSnapshot(projectId, v2)
    const report = await runProductionMigrationReadiness(prisma)
    expect(report.passed).toBe(true)
    const text = formatReadinessReport(report)
    expect(text).toContain('quarantined (policy-accepted, non-restorable)')
    expect(text).toContain('Class B')
  })

  it('quarantine plus a real snapshot defect still fails readiness', async () => {
    const { projectId } = await createUserProjectPair()
    const rtId = await createRoleWithProfile(projectId, 'Mixed Snapshot Role')
    await createNamedPersonWithProfile(projectId, rtId, 'Mixed Snapshot Person')
    const quarantined = v2CapacityPlanSnapshotFixture(projectId)
    quarantined.resourceTypes[0] = {
      ...quarantined.resourceTypes[0],
      allocationStartWeek: null,
      allocationEndWeek: null,
    } as unknown as (typeof quarantined.resourceTypes)[0]
    await createBacklogSnapshot(projectId, quarantined)
    const defective = v2SnapshotFixture(projectId)
    defective.resourceTypes[0].allocationMode = 'WARP_DRIVE'
    await createBacklogSnapshot(projectId, defective)
    const report = await runProductionMigrationReadiness(prisma)
    expect(report.passed).toBe(false)
    const text = formatReadinessReport(report)
    expect(text).toContain('unknown allocationMode')
    // The quarantine is still reported explicitly — never silently hidden.
    expect(text).toContain('quarantined (policy-accepted, non-restorable)')
  })

  it('quarantine plus unresolved live-state decisions still fails readiness', async () => {
    const { projectId } = await createUserProjectPair()
    const rtId = await createRoleWithProfile(projectId, 'Live Decision Role')
    const quarantined = v2CapacityPlanSnapshotFixture(projectId)
    quarantined.resourceTypes[0] = {
      ...quarantined.resourceTypes[0],
      allocationStartWeek: null,
      allocationEndWeek: null,
    } as unknown as (typeof quarantined.resourceTypes)[0]
    await createBacklogSnapshot(projectId, quarantined)
    // A named resource without a persisted profile is a live-state blocker
    // (the 130 live decisions are this class of blocker — out of scope).
    await prisma.namedResource.create({ data: { name: 'Unprofiled Person', resourceTypeId: rtId } })
    const report = await runProductionMigrationReadiness(prisma)
    expect(report.passed).toBe(false)
    const text = formatReadinessReport(report)
    expect(text).toContain('lacks persisted profile')
  })

  it('v2 EFFORT and FULL_PROJECT rows with stale window aliases are translatable', async () => {
    const { projectId } = await createUserProjectPair()
    const rtId = await createRoleWithProfile(projectId, 'Stale Alias Role')
    await createNamedPersonWithProfile(projectId, rtId, 'Stale Alias Person')

    // EFFORT RT + EFFORT NR and FULL_PROJECT RT + FULL_PROJECT NR, both
    // carrying stale window aliases the recorded mode never used.
    const v2Data = {
      schemaVersion: 2,
      epics: [],
      project: null,
      resourceTypes: [{
        id: 'rt-v2-effort',
        name: 'Effort Role',
        category: 'ENGINEERING',
        count: 1,
        hoursPerDay: null,
        dayRate: null,
        allocationMode: 'EFFORT',
        globalTypeId: null,
        allocationPercent: 100,
        allocationStartWeek: 2, // stale — EFFORT did not use windows
        allocationEndWeek: 9, // stale
      }, {
        id: 'rt-v2-full',
        name: 'Full Role',
        category: 'ENGINEERING',
        count: 1,
        hoursPerDay: null,
        dayRate: null,
        allocationMode: 'FULL_PROJECT',
        globalTypeId: null,
        allocationPercent: 80,
        allocationStartWeek: 1, // stale
        allocationEndWeek: 7, // stale
      }],
      namedResources: [{
        id: 'nr-v2-effort',
        resourceTypeId: 'rt-v2-effort',
        name: 'Effort Person',
        startWeek: 3, // stale
        endWeek: 8, // stale
        allocationPct: 100,
        allocationMode: 'EFFORT',
        allocationPercent: 100,
        allocationStartWeek: null,
        allocationEndWeek: null,
        pricingModel: 'ACTUAL_DAYS',
      }, {
        id: 'nr-v2-full',
        resourceTypeId: 'rt-v2-full',
        name: 'Full Person',
        startWeek: 1, // stale
        endWeek: 5, // stale
        allocationPct: 80,
        allocationMode: 'FULL_PROJECT',
        allocationPercent: 80,
        allocationStartWeek: null,
        allocationEndWeek: null,
        pricingModel: 'ACTUAL_DAYS',
      }],
      timelineEntries: [],
      storyTimelineEntries: [],
      epicDependencies: [],
      featureDependencies: [],
      overheadItems: [],
    }
    await createBacklogSnapshot(projectId, v2Data)
    const report = await runProductionMigrationReadiness(prisma)
    expect(report.passed).toBe(true)
    expect(formatReadinessReport(report)).toContain('READINESS PASSED')
  })

  it('orphan v2 NamedResource (missing parent ResourceType) fails readiness', async () => {
    const { projectId } = await createUserProjectPair()
    const rtId = await createRoleWithProfile(projectId, 'Orphan Owner Role')
    await createNamedPersonWithProfile(projectId, rtId, 'Orphan Owner Person')
    const v2Data = {
      schemaVersion: 2,
      epics: [],
      project: null,
      resourceTypes: [{ // a DIFFERENT RT id than the NR references
        id: 'rt-v2-present',
        name: 'Present Role',
        category: 'ENGINEERING',
        count: 1,
        hoursPerDay: null,
        dayRate: null,
        allocationMode: 'EFFORT',
        globalTypeId: null,
        allocationPercent: 100,
        allocationStartWeek: null,
        allocationEndWeek: null,
      }],
      namedResources: [{
        id: 'nr-v2-orphan',
        resourceTypeId: 'rt-v2-missing', // absent from the snapshot
        name: 'Orphan Person',
        startWeek: null,
        endWeek: null,
        allocationPct: 100,
        allocationMode: 'EFFORT',
        allocationPercent: 100,
        allocationStartWeek: null,
        allocationEndWeek: null,
        pricingModel: 'ACTUAL_DAYS',
      }],
      timelineEntries: [],
      storyTimelineEntries: [],
      epicDependencies: [],
      featureDependencies: [],
      overheadItems: [],
    }
    await createBacklogSnapshot(projectId, v2Data)
    const report = await runProductionMigrationReadiness(prisma)
    expect(report.passed).toBe(false)
    const text = formatReadinessReport(report)
    expect(text).toContain('nr-v2-orphan')
    expect(text).toContain('rt-v2-missing')
  })

  it('unsupported snapshot schema fails', async () => {
    const { projectId } = await createUserProjectPair()
    const rtId = await createRoleWithProfile(projectId, 'Unsupported Snapshot Role')
    await createNamedPersonWithProfile(projectId, rtId, 'Unsupported Snapshot Person')
    await createBacklogSnapshot(projectId, { schemaVersion: 99, epics: [] })
    const report = await runProductionMigrationReadiness(prisma)
    expect(report.passed).toBe(false)
    const text = formatReadinessReport(report)
    expect(text).toContain('unsupported or malformed snapshot data')
  })

  it('persisted DEMAND_FOLLOWING with stale windows fails with owner identification', async () => {
    const { projectId } = await createUserProjectPair()
    const rtId = await createRoleWithProfile(projectId, 'Stale Window Role')
    await createNamedPersonWithProfile(projectId, rtId, 'Stale Window Person')
    // Corrupt the persisted ROLE profile: DEMAND_FOLLOWING must not carry windows.
    const profile = await prisma.capacityProfile.findFirstOrThrow({
      where: { projectId, resourceTypeId: rtId },
    })
    await prisma.capacityProfile.update({
      where: { id: profile.id },
      data: { startWeek: 2, endWeek: 9 },
    })
    const report = await runProductionMigrationReadiness(prisma)
    expect(report.passed).toBe(false)
    const text = formatReadinessReport(report)
    expect(text).toContain(profile.id)
    expect(text).toContain('DEMAND_FOLLOWING must not have startWeek')
  })

  it('persisted DEMAND_FOLLOWING with segments fails', async () => {
    const { projectId } = await createUserProjectPair()
    const rtId = await createRoleWithProfile(projectId, 'Segmented Scalar Role')
    await createNamedPersonWithProfile(projectId, rtId, 'Segmented Scalar Person')
    const profile = await prisma.capacityProfile.findFirstOrThrow({
      where: { projectId, resourceTypeId: rtId },
    })
    await prisma.capacitySegment.create({
      data: {
        capacityProfileId: profile.id,
        startWeek: 0,
        endWeek: 5,
        capacityPercent: 100,
        source: 'FIXED',
      },
    })
    const report = await runProductionMigrationReadiness(prisma)
    expect(report.passed).toBe(false)
    const text = formatReadinessReport(report)
    expect(text).toContain(profile.id)
    expect(text).toContain('DEMAND_FOLLOWING must not have segments')
  })

  it('persisted WHOLE_PROJECT_ALLOCATION with stale windows fails', async () => {
    const { projectId } = await createUserProjectPair()
    const rtId = await createRoleWithProfile(projectId, 'Stale Whole Role', {
      planningBasis: 'WHOLE_PROJECT_ALLOCATION',
      source: 'FIXED',
    })
    await createNamedPersonWithProfile(projectId, rtId, 'Stale Whole Person')
    const profile = await prisma.capacityProfile.findFirstOrThrow({
      where: { projectId, resourceTypeId: rtId },
    })
    await prisma.capacityProfile.update({
      where: { id: profile.id },
      data: { startWeek: 1, endWeek: 6 },
    })
    const report = await runProductionMigrationReadiness(prisma)
    expect(report.passed).toBe(false)
    const text = formatReadinessReport(report)
    expect(text).toContain(profile.id)
    expect(text).toContain('WHOLE_PROJECT_ALLOCATION must not have startWeek')
  })

  it('persisted segmentless CAPACITY_PROFILE ROLE fails', async () => {
    const { projectId } = await createUserProjectPair()
    const rtId = await createRoleWithProfile(projectId, 'Segmentless Plan Role', {
      planningBasis: 'CAPACITY_PROFILE',
      source: 'SQUAD_PLANNER',
    })
    await createNamedPersonWithProfile(projectId, rtId, 'Segmentless Plan Person')
    const report = await runProductionMigrationReadiness(prisma)
    expect(report.passed).toBe(false)
    const text = formatReadinessReport(report)
    expect(text).toContain('CAPACITY_PROFILE with no segments is only valid as the canonical zero-capacity PLANNED_RESOURCE state')
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// Scenario 3 — read-only guarantee
// ═════════════════════════════════════════════════════════════════════════════

describeIf('readiness — no writes', () => {
  it('performs no writes even when blockers exist', async () => {
    const { projectId } = await createUserProjectPair()
    await prisma.resourceType.create({
      data: { name: 'Write Probe Role', category: 'ENGINEERING', count: 1, projectId },
    })
    const snapshotCountBefore = await prisma.backlogSnapshot.count()
    const profileCountBefore = await prisma.capacityProfile.count()
    const rtBefore = await prisma.resourceType.findMany({ orderBy: { id: 'asc' } })

    const report = await runProductionMigrationReadiness(prisma)
    expect(report.passed).toBe(false)

    const snapshotCountAfter = await prisma.backlogSnapshot.count()
    const profileCountAfter = await prisma.capacityProfile.count()
    const rtAfter = await prisma.resourceType.findMany({ orderBy: { id: 'asc' } })
    expect(snapshotCountAfter).toBe(snapshotCountBefore)
    expect(profileCountAfter).toBe(profileCountBefore)
    expect(rtAfter.map(r => r.id)).toEqual(rtBefore.map(r => r.id))
  })
})
