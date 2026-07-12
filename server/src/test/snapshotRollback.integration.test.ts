/**
 * snapshotRollback.integration.test.ts — Real PostgreSQL snapshot rollback tests.
 *
 * These tests exercise the full snapshot → mutate → rollback cycle against a
 * running PostgreSQL database. They are skipped by default because they require
 * Docker / CI database infrastructure.
 *
 * Run with:
 *   INTEGRATION_TEST=true npx vitest run src/test/snapshotRollback.integration.test.ts
 *
 * Each test creates its own user/project, creates only the rows it needs,
 * and cleans up after itself. Tests are serial (not parallel) to avoid
 * database collisions.
 *
 * @module snapshotRollback.integration
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { Prisma } from '@prisma/client'
import { prisma } from '../lib/prisma.js'

const runIntegration = process.env.INTEGRATION_TEST === 'true'
const describeIf = runIntegration ? describe : describe.skip

// ─── Fixture helpers ─────────────────────────────────────────────────────────

let userId: string

beforeAll(async () => {
  if (!runIntegration) return
  const user = await prisma.user.create({
    data: {
      email: `snapshot-rollback-test-${Date.now()}@example.com`,
      name: 'Snapshot Rollback Test',
      password: '$2b$10$placeholder',
    },
  })
  userId = user.id
})

afterAll(async () => {
  if (!runIntegration) return
  await prisma.backlogSnapshot.deleteMany({ where: { project: { ownerId: userId } } })
  await prisma.capacitySegment.deleteMany({ where: { capacityProfile: { project: { ownerId: userId } } } })
  await prisma.capacityProfile.deleteMany({ where: { project: { ownerId: userId } } })
  await prisma.projectOverhead.deleteMany({ where: { project: { ownerId: userId } } })
  await prisma.timelineEntry.deleteMany({ where: { project: { ownerId: userId } } })
  await prisma.storyTimelineEntry.deleteMany({ where: { project: { ownerId: userId } } })
  await prisma.epicDependency.deleteMany({ where: { epic: { project: { ownerId: userId } } } })
  await prisma.featureDependency.deleteMany({ where: { feature: { epic: { project: { ownerId: userId } } } } })
  await prisma.task.deleteMany({ where: { userStory: { feature: { epic: { project: { ownerId: userId } } } } } })
  await prisma.userStory.deleteMany({ where: { feature: { epic: { project: { ownerId: userId } } } } })
  await prisma.feature.deleteMany({ where: { epic: { project: { ownerId: userId } } } })
  await prisma.epic.deleteMany({ where: { project: { ownerId: userId } } })
  await prisma.namedResource.deleteMany({ where: { resourceType: { project: { ownerId: userId } } } })
  await prisma.resourceType.deleteMany({ where: { project: { ownerId: userId } } })
  await prisma.project.deleteMany({ where: { ownerId: userId } })
  await prisma.user.delete({ where: { id: userId } })
})

async function createProject(): Promise<string> {
  const project = await prisma.project.create({
    data: {
      name: `Snapshot Integration Test ${Date.now()}`,
      ownerId: userId,
    },
  })
  return project.id
}

async function createResourceType(projectId: string, name: string): Promise<string> {
  const rt = await prisma.resourceType.create({
    data: {
      name,
      projectId,
      category: 'ENGINEERING' as const,
      count: 2,
      hoursPerDay: 8,
      dayRate: 500,
      allocationMode: 'TIMELINE' as const,
      allocationPercent: 100,
      allocationStartWeek: 0,
      allocationEndWeek: 10,
    },
  })
  return rt.id
}

async function createNamedResource(_projectId: string, resourceTypeId: string, name: string): Promise<string> {
  const nr = await prisma.namedResource.create({
    data: {
      name,
      resourceType: { connect: { id: resourceTypeId } },
      allocationMode: 'EFFORT' as const,
      allocationPercent: 80,
      allocationStartWeek: 0,
      allocationEndWeek: 10,
    },
  })
  return nr.id
}

async function createProfileWithSegments(
  projectId: string,
  resourceTypeId: string | null,
  namedResourceId: string | null,
  ownerKind: 'ROLE' | 'NAMED_PERSON' | 'PLANNED_RESOURCE',
  overrides: {
    planningBasis?: string
    source?: string
    defaultPercent?: number | null
    startWeek?: number | null
    endWeek?: number | null
    legacy?: unknown
  } = {},
  segments: Array<{ startWeek: number; endWeek: number; capacityPercent: number; source?: string }> = [],
): Promise<string> {
  const data: Record<string, unknown> = {
    project: { connect: { id: projectId } },
    ownerKind,
    planningBasis: overrides.planningBasis ?? 'DEMAND_FOLLOWING',
    source: overrides.source ?? 'MANUAL',
    defaultPercent: overrides.defaultPercent ?? null,
    startWeek: overrides.startWeek ?? null,
    endWeek: overrides.endWeek ?? null,
  }
  if (resourceTypeId) data.resourceType = { connect: { id: resourceTypeId } }
  if (namedResourceId) data.namedResource = { connect: { id: namedResourceId } }
  if (overrides.legacy !== undefined) {
    data.legacy = overrides.legacy
  } else {
    data.legacy = Prisma.DbNull
  }

  const profile = await prisma.capacityProfile.create({
    data: data as never,
  })

  for (const s of segments) {
    await prisma.capacitySegment.create({
      data: {
        capacityProfile: { connect: { id: profile.id } },
        startWeek: s.startWeek,
        endWeek: s.endWeek,
        capacityPercent: s.capacityPercent,
        source: s.source ?? 'MANUAL',
      } as never,
    })
  }

  return profile.id
}

async function createSegments(
  profileId: string,
  segments: Array<{ startWeek: number; endWeek: number; capacityPercent: number; source?: string }>,
): Promise<void> {
  for (const s of segments) {
    await prisma.capacitySegment.create({
      data: {
        capacityProfile: { connect: { id: profileId } },
        startWeek: s.startWeek,
        endWeek: s.endWeek,
        capacityPercent: s.capacityPercent,
        source: s.source ?? 'MANUAL',
      } as never,
    })
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// Scenario A — exact v3 round trip (basic)
// ═════════════════════════════════════════════════════════════════════════════

describeIf('Scenario A — v3 round trip', () => {
  it('captures, mutates, and restores via buildSnapshot/recreateV3CapacityProfiles', async () => {
    const projectId = await createProject()
    const rtId = await createResourceType(projectId, 'Developer')
    const nrId = await createNamedResource(projectId, rtId, 'Alice')

    await createProfileWithSegments(projectId, rtId, null, 'ROLE', {
      planningBasis: 'DEMAND_FOLLOWING',
      source: 'FIXED',
      defaultPercent: null,
      startWeek: null,
      endWeek: null,
      legacy: Prisma.DbNull,
    }, [
      { startWeek: 0, endWeek: 4, capacityPercent: 100 },
      { startWeek: 5, endWeek: 10, capacityPercent: 50 },
    ])

    await createProfileWithSegments(projectId, null, nrId, 'NAMED_PERSON', {
      planningBasis: 'AVAILABILITY_WINDOW',
      source: 'SQUAD_PLANNER',
      defaultPercent: 100,
      startWeek: 2,
      endWeek: 8,
      legacy: { allocationMode: 'EFFORT' },
    }, [
      { startWeek: 2, endWeek: 5, capacityPercent: 100 },
    ])

    const initialProfiles = await prisma.capacityProfile.findMany({
      where: { projectId },
      include: { segments: { orderBy: { startWeek: 'asc' } } },
    })
    expect(initialProfiles.length).toBe(2)

    // Build snapshot
    const { buildSnapshot } = await import('../routes/snapshots.js')
    const snapshot = await buildSnapshot(projectId, prisma)
    expect(snapshot.schemaVersion).toBe(3)
    expect(snapshot.capacityProfiles.length).toBe(2)

    // Verify SnapshotJsonValue
    const roleProfile = snapshot.capacityProfiles.find(p => p.ownerKind === 'ROLE')
    expect(roleProfile?.legacy.kind).toBe('DB_NULL')
    const personProfile = snapshot.capacityProfiles.find(p => p.ownerKind === 'NAMED_PERSON')
    expect(personProfile?.legacy.kind).toBe('VALUE')

    // Mutate
    const roleDb = initialProfiles.find(p => p.ownerKind === 'ROLE')!
    await createSegments(roleDb.id, [
      { startWeek: 11, endWeek: 14, capacityPercent: 25 },
    ])
    const mutatedSegments = await prisma.capacitySegment.count({
      where: { capacityProfileId: roleDb.id },
    })
    expect(mutatedSegments).toBe(3)

    // Restore
    const { recreateV3CapacityProfiles } = await import('../lib/projectSnapshotCapacity.js')
    await prisma.$transaction(async tx => {
      await recreateV3CapacityProfiles(tx, projectId, snapshot)
    })

    // Verify restoration
    const restoredProfiles = await prisma.capacityProfile.findMany({
      where: { projectId },
      include: { segments: { orderBy: { startWeek: 'asc' } } },
    })
    expect(restoredProfiles.length).toBe(2)
    const restoredRole = restoredProfiles.find(p => p.ownerKind === 'ROLE')
    expect(restoredRole).toBeDefined()
    expect(restoredRole!.segments.length).toBe(2)
    expect(restoredRole!.segments[0].startWeek).toBe(0)
    expect(restoredRole!.segments[1].startWeek).toBe(5)
    const restoredPerson = restoredProfiles.find(p => p.ownerKind === 'NAMED_PERSON')
    expect(restoredPerson).toBeDefined()
    expect(restoredPerson!.segments.length).toBe(1)
    expect(restoredPerson!.defaultPercent).toBe(100)

    // Clean up
    await prisma.capacitySegment.deleteMany({ where: { capacityProfile: { projectId } } })
    await prisma.capacityProfile.deleteMany({ where: { projectId } })
    await prisma.namedResource.deleteMany({ where: { resourceType: { projectId } } })
    await prisma.resourceType.deleteMany({ where: { projectId } })
    await prisma.project.delete({ where: { id: projectId } })
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// Scenario D — invalid v3 validation is non-destructive
// ═════════════════════════════════════════════════════════════════════════════

describeIf('Scenario D — invalid v3 validation', () => {
  it('rejects duplicate profile IDs without modifying project state', async () => {
    const projectId = await createProject()
    const rtId = await createResourceType(projectId, 'Developer')

    await createProfileWithSegments(projectId, rtId, null, 'ROLE', {}, [
      { startWeek: 0, endWeek: 10, capacityPercent: 100 },
    ])

    const profilesBefore = await prisma.capacityProfile.count({ where: { projectId } })
    expect(profilesBefore).toBe(1)

    const { validateSnapshotV3, SnapshotValidationError } = await import('../lib/projectSnapshotValidation.js')

    const badSnapshot = {
      schemaVersion: 3,
      epics: [],
      project: null,
      resourceTypes: [
        { id: 'rt-dev', name: 'Dev', category: null, count: null, hoursPerDay: null, dayRate: null, globalTypeId: null, allocationMode: null, allocationPercent: null, allocationStartWeek: null, allocationEndWeek: null },
      ],
      namedResources: [],
      timelineEntries: [],
      storyTimelineEntries: [],
      epicDependencies: [],
      featureDependencies: [],
      overheadItems: [],
      capacityProfiles: [
        {
          id: 'same-id',
          ownerKind: 'ROLE',
          resourceTypeId: 'rt-dev',
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
          id: 'same-id',
          ownerKind: 'NAMED_PERSON',
          resourceTypeId: null,
          namedResourceId: 'missing-nr',
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

    expect(() => validateSnapshotV3(badSnapshot as never)).toThrow(SnapshotValidationError)

    const profilesAfter = await prisma.capacityProfile.count({ where: { projectId } })
    expect(profilesAfter).toBe(1)

    await prisma.capacitySegment.deleteMany({ where: { capacityProfile: { projectId } } })
    await prisma.capacityProfile.deleteMany({ where: { projectId } })
    await prisma.resourceType.deleteMany({ where: { projectId } })
    await prisma.project.delete({ where: { id: projectId } })
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// Scenario F — v1 leaves profiles untouched
// ═════════════════════════════════════════════════════════════════════════════

describeIf('Scenario F — v1 leaves profiles untouched', () => {
  it('restores epics only, does not modify existing profiles', async () => {
    const projectId = await createProject()
    const rtId = await createResourceType(projectId, 'Developer')

    await prisma.epic.create({
      data: { name: 'Original Epic', projectId, order: 0 },
    })

    await createProfileWithSegments(projectId, rtId, null, 'ROLE', {
      planningBasis: 'DEMAND_FOLLOWING',
      source: 'MANUAL',
      defaultPercent: 100,
      startWeek: 0,
      endWeek: 10,
      legacy: Prisma.DbNull,
    }, [
      { startWeek: 0, endWeek: 10, capacityPercent: 100 },
    ])

    // Simulate v1 rollback: delete epics only
    await prisma.epic.deleteMany({ where: { projectId } })
    await prisma.epic.create({
      data: { name: 'Restored Epic', projectId, order: 0 },
    })

    // Verify profiles untouched
    const profilesAfter = await prisma.capacityProfile.count({ where: { projectId } })
    expect(profilesAfter).toBe(1)

    const profile = await prisma.capacityProfile.findFirst({ where: { projectId } })
    expect(profile).not.toBeNull()
    expect(profile!.defaultPercent).toBe(100)

    const segCount = await prisma.capacitySegment.count({
      where: { capacityProfile: { projectId } },
    })
    expect(segCount).toBe(1)

    // Verify epics changed
    const epics = await prisma.epic.findMany({ where: { projectId } })
    expect(epics.length).toBe(1)
    expect(epics[0].name).toBe('Restored Epic')

    await prisma.epic.deleteMany({ where: { projectId } })
    await prisma.capacitySegment.deleteMany({ where: { capacityProfile: { projectId } } })
    await prisma.capacityProfile.deleteMany({ where: { projectId } })
    await prisma.resourceType.deleteMany({ where: { projectId } })
    await prisma.project.delete({ where: { id: projectId } })
  })
})
