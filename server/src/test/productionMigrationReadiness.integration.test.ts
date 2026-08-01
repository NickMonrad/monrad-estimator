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

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
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

beforeAll(async () => {
  if (!runIntegration) return
  prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
  })
  await prisma.$connect()
})

afterAll(async () => {
  if (!runIntegration) return
  await prisma.$disconnect()
})

// ─── Fixture helpers ─────────────────────────────────────────────────────────

let fixtureCounter = 0

async function createProject(name: string, ownerId: string): Promise<string> {
  const project = await prisma.project.create({
    data: { name: `${name}-${Date.now()}-${fixtureCounter++}`, ownerId },
  })
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
  })

  it('passes and reports a clean summary', async () => {
    const report = await runProductionMigrationReadiness(prisma)
    expect(report.passed).toBe(true)
    const text = formatReadinessReport(report)
    expect(text).toContain('READINESS PASSED')
    expect(text).toContain('READ-ONLY')
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

  it('malformed owner shape fails', async () => {
    const { projectId } = await createUserProjectPair()
    const rtId = await createRoleWithProfile(projectId, 'Malformed Role')
    await prisma.capacityProfile.create({
      data: {
        projectId,
        ownerKind: 'NAMED_PERSON',
        resourceTypeId: rtId,
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
    expect(text).toContain('must have exactly one owner FK')
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
    expect(text).toContain('does not match expected')
  })

  it('duplicate owner fails', async () => {
    const { projectId } = await createUserProjectPair()
    const rtId = await createRoleWithProfile(projectId, 'Duplicated Role')
    await prisma.capacityProfile.create({
      data: {
        projectId,
        ownerKind: 'ROLE',
        resourceTypeId: rtId,
        namedResourceId: null,
        planningBasis: 'DEMAND_FOLLOWING',
        source: 'FIXED',
        defaultPercent: 50,
        startWeek: null,
        endWeek: null,
      },
    })
    const report = await runProductionMigrationReadiness(prisma)
    expect(report.passed).toBe(false)
    const text = formatReadinessReport(report)
    expect(text).toContain('duplicate physical owner')
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
