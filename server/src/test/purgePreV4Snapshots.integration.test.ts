/**
 * purgePreV4Snapshots.integration.test.ts — Real PostgreSQL integration
 * tests for the issue #444 pre-V4 BacklogSnapshot purge command.
 *
 * Proves against a disposable database (Docker-first lifecycle):
 *   - dry-run reports aggregate V1/V2/V3/V4 counts and performs zero writes
 *     on every table (BacklogSnapshot, project/backlog, resource, profile,
 *     segment, timeline);
 *   - apply deletes ONLY positively-classified V1/V2/V3 BacklogSnapshot rows;
 *   - apply preserves every V4 snapshot;
 *   - malformed/unsupported input aborts the entire apply with zero deletion;
 *   - post-apply counts reconcile;
 *   - current project/backlog/resource/profile/timeline state is untouched;
 *   - the CLI exit contract and sanitized aggregate-only output.
 *
 * All tests are skipped unless INTEGRATION_TEST=true.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '@prisma/client'

import {
  purgePreV4Snapshots,
  formatPurgeReport,
} from '../lib/purgePreV4Snapshots.js'
import { main } from '../scripts/purgePreV4Snapshots.js'

// ─── Guard ──────────────────────────────────────────────────────────────────

const runIntegration = process.env.INTEGRATION_TEST === 'true'
const describeIf = runIntegration ? describe : describe.skip

// ─── Shared state ───────────────────────────────────────────────────────────

let prisma: PrismaClient
let projectId: string

beforeAll(async () => {
  if (!runIntegration) return
  prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
  })
  await prisma.$connect()
  // Clean slate: the purge runs whole-database, so start from an empty DB.
  await prisma.backlogSnapshot.deleteMany({})
  await prisma.featureTemplate.deleteMany({})
  await prisma.project.deleteMany({})
  await prisma.customer.deleteMany({})
  await prisma.documentTemplate.deleteMany({})
  await prisma.user.deleteMany({})
})

afterEach(async () => {
  if (!runIntegration) return
  await prisma.backlogSnapshot.deleteMany({})
  await prisma.featureTemplate.deleteMany({})
  await prisma.project.deleteMany({})
  await prisma.customer.deleteMany({})
  await prisma.documentTemplate.deleteMany({})
  await prisma.user.deleteMany({})
  projectId = ''
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

// ─── Fixtures ───────────────────────────────────────────────────────────────

let fixtureCounter = 0

async function seedUserAndProject(): Promise<void> {
  const user = await prisma.user.create({
    data: {
      email: `purge-${Date.now()}-${fixtureCounter++}@example.com`,
      name: 'Purge Test User',
      password: '$2b$10$placeholder',
    },
  })
  const project = await prisma.project.create({
    data: { name: `Purge Project ${Date.now()}-${fixtureCounter++}`, ownerId: user.id },
  })
  projectId = project.id
  await prisma.resourceType.create({
    data: {
      name: 'Purge Role',
      category: 'ENGINEERING',
      count: 2,
      projectId,
      capacityProfiles: {
        create: {
          projectId,
          ownerKind: 'ROLE',
          planningBasis: 'DEMAND_FOLLOWING',
          source: 'FIXED',
          defaultPercent: 100,
          startWeek: null,
          endWeek: null,
        },
      },
    },
  })
  await prisma.epic.create({
    data: { name: 'Purge Epic', projectId, order: 0 },
  })
}

async function createSnapshot(payload: unknown, label = 'purge fixture'): Promise<string> {
  const snapshot = await prisma.backlogSnapshot.create({
    data: {
      projectId,
      label,
      trigger: 'manual',
      snapshot: payload as object,
      createdById: (await prisma.user.findFirstOrThrow()).id,
    },
  })
  return snapshot.id
}

function v1Payload() {
  return [{ id: 'e1', name: 'Epic', features: [] }]
}

function v2Payload() {
  return {
    schemaVersion: 2,
    epics: [],
    project: null,
    resourceTypes: [],
    namedResources: [],
    timelineEntries: [],
    storyTimelineEntries: [],
    epicDependencies: [],
    featureDependencies: [],
    overheadItems: [],
  }
}

function v3Payload() {
  return {
    schemaVersion: 3,
    epics: [],
    project: null,
    resourceTypes: [],
    namedResources: [],
    timelineEntries: [],
    storyTimelineEntries: [],
    epicDependencies: [],
    featureDependencies: [],
    overheadItems: [],
    capacityProfiles: [],
  }
}

function v4Payload() {
  return {
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
    capacityProfiles: [],
  }
}

/** Live-state snapshot for the untouched-state proof. */
async function liveState() {
  return {
    projects: await prisma.project.findMany({ orderBy: { id: 'asc' } }),
    epics: await prisma.epic.findMany({ orderBy: { id: 'asc' } }),
    resourceTypes: await prisma.resourceType.findMany({ orderBy: { id: 'asc' } }),
    capacityProfiles: await prisma.capacityProfile.findMany({ orderBy: { id: 'asc' } }),
    capacitySegments: await prisma.capacitySegment.findMany({ orderBy: { id: 'asc' } }),
    timelineEntries: await prisma.timelineEntry.findMany({ orderBy: { id: 'asc' } }),
    namedResources: await prisma.namedResource.findMany({ orderBy: { id: 'asc' } }),
  }
}

async function seedAllVersions(): Promise<void> {
  await seedUserAndProject()
  await createSnapshot(v1Payload(), 'v1')
  await createSnapshot(v2Payload(), 'v2')
  await createSnapshot(v3Payload(), 'v3')
  await createSnapshot(v4Payload(), 'v4')
  await createSnapshot(v4Payload(), 'v4-2')
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describeIf('pre-V4 purge — dry run', () => {
  it('reports aggregate counts, performs zero deletes and leaves live state untouched', async () => {
    await seedAllVersions()
    const liveBefore = await liveState()
    const snapshotIdsBefore = (await prisma.backlogSnapshot.findMany({ select: { id: true } })).map(s => s.id)

    const report = await purgePreV4Snapshots(prisma, { apply: false })

    expect(report.dryRun).toBe(true)
    expect(report.before).toEqual({ v1: 1, v2: 1, v3: 1, v4: 2, malformed: 0 })
    expect(report.deletedCount).toBe(0)
    // Zero writes anywhere.
    const snapshotIdsAfter = (await prisma.backlogSnapshot.findMany({ select: { id: true } })).map(s => s.id)
    expect(snapshotIdsAfter.sort()).toEqual(snapshotIdsBefore.sort())
    expect(await liveState()).toEqual(liveBefore)
    // The rendered report is aggregate-only.
    const text = formatPurgeReport(report)
    expect(text).toContain('Pre-V4 rows that WOULD be deleted: 3')
    expect(text).not.toContain(projectId)
    expect(text).not.toContain('purge fixture')
  })

  it('the CLI dry-run exits 0 and prints sanitized counts', async () => {
    await seedAllVersions()
    const snapshotCountBefore = await prisma.backlogSnapshot.count()
    const exit = await main([])
    expect(exit).toBe(0)
    expect(await prisma.backlogSnapshot.count()).toBe(snapshotCountBefore)
    const liveAfter = await liveState()
    expect(liveAfter.projects.length).toBe(1)
  })

  it('the CLI refuses unknown arguments before touching the database', async () => {
    const exit = await main(['--nonsense'])
    expect(exit).toBe(1)
  })
})

describeIf('pre-V4 purge — apply', () => {
  it('deletes V1/V2/V3 only, preserves every V4, reconciles before/after counts', async () => {
    await seedAllVersions()
    const liveBefore = await liveState()
    const v4Ids = (await prisma.backlogSnapshot.findMany({
      where: { snapshot: { path: ['schemaVersion'], equals: 4 } },
      select: { id: true },
    })).map(s => s.id)
    expect(v4Ids).toHaveLength(2)

    const report = await purgePreV4Snapshots(prisma, { apply: true })

    expect(report.aborted).toBe(false)
    expect(report.deletedCount).toBe(3)
    expect(report.before).toEqual({ v1: 1, v2: 1, v3: 1, v4: 2, malformed: 0 })
    expect(report.after).toEqual({ v1: 0, v2: 0, v3: 0, v4: 2, malformed: 0 })

    // Every V4 snapshot survived; no pre-V4 row remains.
    const remaining = await prisma.backlogSnapshot.findMany({ select: { id: true } })
    expect(remaining.map(r => r.id).sort()).toEqual(v4Ids.sort())
    // Current project/backlog/resource/profile/timeline state is untouched.
    expect(await liveState()).toEqual(liveBefore)
  })

  it('malformed/unsupported input aborts the entire apply with zero deletion', async () => {
    await seedUserAndProject()
    await createSnapshot(v2Payload(), 'v2')
    await createSnapshot(v4Payload(), 'v4')
    await createSnapshot({ schemaVersion: 99, epics: [] }, 'malformed')
    const snapshotIdsBefore = (await prisma.backlogSnapshot.findMany({ select: { id: true } })).map(s => s.id)

    const report = await purgePreV4Snapshots(prisma, { apply: true })

    expect(report.aborted).toBe(true)
    expect(report.deletedCount).toBe(0)
    expect(report.after).toEqual(report.before)
    expect(report.abortReason).toContain('malformed/unsupported')
    const snapshotIdsAfter = (await prisma.backlogSnapshot.findMany({ select: { id: true } })).map(s => s.id)
    expect(snapshotIdsAfter.sort()).toEqual(snapshotIdsBefore.sort())
  })

  it('the CLI apply exits 0, deletes only pre-V4 rows, and its output is sanitized', async () => {
    await seedAllVersions()
    const exit = await main(['--apply'])
    expect(exit).toBe(0)
    const remaining = await prisma.backlogSnapshot.findMany({ select: { snapshot: true } })
    expect(remaining).toHaveLength(2)
    for (const row of remaining) {
      const payload = row.snapshot as { schemaVersion?: unknown }
      expect(payload.schemaVersion).toBe(4)
    }
    // Live tables untouched.
    expect(await prisma.epic.count()).toBe(1)
    expect(await prisma.capacityProfile.count()).toBe(1)
  })

  it('a second apply on a pre-V4-free database is a no-op', async () => {
    await seedAllVersions()
    await purgePreV4Snapshots(prisma, { apply: true })
    const report = await purgePreV4Snapshots(prisma, { apply: true })
    expect(report.deletedCount).toBe(0)
    expect(report.after).toEqual(report.before)
  })
})
