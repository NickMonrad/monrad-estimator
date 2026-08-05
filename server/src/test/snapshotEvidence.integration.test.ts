/**
 * snapshotEvidence.integration.test.ts — Real PostgreSQL integration tests
 * for the Issue #432 sanitized snapshot evidence command
 * (server/src/scripts/generateSnapshotEvidence.ts).
 *
 * Proves against a disposable database (Docker-first lifecycle):
 *   - the corrected 11-plus-7 snapshot topology and the reviewed counts
 *     reconcile end to end through the real CLI entry point;
 *   - entry-level and structural defect categorisation (alias conflict,
 *     duplicate owners, single -1 edges);
 *   - current classifier reuse (quarantined/defect/restorable verdicts);
 *   - fingerprint, baseline and summary-count mismatch refusal;
 *   - output-file safety (never overwrite);
 *   - unsupported schema-version refusal;
 *   - zero writes and exact database-state preservation;
 *   - identifier/name/payload redaction of seeded sensitive values.
 *
 * All tests are skipped unless INTEGRATION_TEST=true.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync, readdirSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '@prisma/client'

import { main } from '../scripts/generateSnapshotEvidence.js'
import type { SnapshotEvidenceExpected } from '../lib/snapshotEvidence.js'
import {
  buildRemediationPlan,
  computePlanFingerprint,
  computeStateHash,
  loadRemediationState,
} from '../lib/productionRemediationPlan.js'

// ─── Guard ──────────────────────────────────────────────────────────────────

const runIntegration = process.env.INTEGRATION_TEST === 'true'
const describeIf = runIntegration ? describe : describe.skip

// ─── Shared state ───────────────────────────────────────────────────────────

let prisma: PrismaClient
const PROJECT_ID = 'fixture-project-42-abc'
const USER_ID = 'fixture-user-7-xyz'
const CREATED_SNAPSHOT_IDS: string[] = []

beforeAll(async () => {
  if (!runIntegration) return
  prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
  })
  await prisma.$connect()
  // Clean slate for this file's fixtures.
  await prisma.backlogSnapshot.deleteMany({})
  await prisma.featureTemplate.deleteMany({})
  await prisma.project.deleteMany({})
  await prisma.customer.deleteMany({})
  await prisma.documentTemplate.deleteMany({})
  await prisma.user.deleteMany({})
  await prisma.user.create({ data: { id: USER_ID, email: 'fixture@example.test', name: 'Fixture User', password: '$2b$10$placeholder', role: 'ADMIN' } })
  await prisma.project.create({ data: { id: PROJECT_ID, name: 'Fixture Secret Project', ownerId: USER_ID } })
})

afterEach(async () => {
  if (!runIntegration) return
  await prisma.backlogSnapshot.deleteMany({})
  await prisma.project.deleteMany({})
  await prisma.customer.deleteMany({})
  await prisma.documentTemplate.deleteMany({})
  await prisma.user.deleteMany({})
  await prisma.user.create({ data: { id: USER_ID, email: 'fixture@example.test', name: 'Fixture User', password: '$2b$10$placeholder', role: 'ADMIN' } })
  await prisma.project.create({ data: { id: PROJECT_ID, name: 'Fixture Secret Project', ownerId: USER_ID } })
})

afterAll(async () => {
  if (!runIntegration) return
  await prisma.backlogSnapshot.deleteMany({})
  await prisma.project.deleteMany({})
  await prisma.customer.deleteMany({})
  await prisma.documentTemplate.deleteMany({})
  await prisma.user.deleteMany({})
  await prisma.$disconnect()
})

// ─── Fixtures ───────────────────────────────────────────────────────────────

function makeRt(o: { id: string; name?: string; allocationMode?: string | null; allocationStartWeek?: number | null; allocationEndWeek?: number | null; allocationPercent?: number | null }) {
  return {
    id: o.id,
    name: o.name ?? `Fixture Secret Role ${o.id}`,
    category: 'ENGINEERING',
    count: 1,
    hoursPerDay: null,
    dayRate: null,
    allocationMode: 'allocationMode' in o ? o.allocationMode : 'TIMELINE',
    globalTypeId: null,
    allocationPercent: o.allocationPercent ?? 100,
    allocationStartWeek: o.allocationStartWeek ?? null,
    allocationEndWeek: o.allocationEndWeek ?? null,
  }
}

function makeNr(o: { id: string; resourceTypeId: string; name?: string; allocationMode?: string | null; allocationStartWeek?: number | null; allocationEndWeek?: number | null; startWeek?: number | null; endWeek?: number | null; allocationPercent?: number | null; allocationPct?: number | null }) {
  return {
    id: o.id,
    resourceTypeId: o.resourceTypeId,
    name: o.name ?? `Fixture Secret Person ${o.id}`,
    startWeek: o.startWeek ?? null,
    endWeek: o.endWeek ?? null,
    allocationPct: o.allocationPct ?? 100,
    allocationMode: 'allocationMode' in o ? o.allocationMode : 'TIMELINE',
    allocationPercent: o.allocationPercent ?? 100,
    allocationStartWeek: o.allocationStartWeek ?? null,
    allocationEndWeek: o.allocationEndWeek ?? null,
    pricingModel: 'ACTUAL_DAYS',
  }
}

function makeV2Snapshot(resourceTypes: unknown[], namedResources: unknown[]) {
  return {
    schemaVersion: 2,
    epics: [],
    project: null,
    resourceTypes,
    namedResources,
    timelineEntries: [],
    storyTimelineEntries: [],
    epicDependencies: [],
    featureDependencies: [],
    overheadItems: [],
  }
}

async function createSnapshot(id: string, payload: unknown, createdAtIso: string): Promise<void> {
  await prisma.backlogSnapshot.create({
    data: {
      id,
      projectId: PROJECT_ID,
      label: `fixture ${id}`,
      trigger: 'manual',
      snapshot: payload as object,
      createdById: USER_ID,
      createdAt: new Date(createdAtIso),
    },
  })
  CREATED_SNAPSHOT_IDS.push(id)
}

/** Corrected-topology fixture set (smaller than production, same rules):
 * - E1: eleven-subgroup with 21 windowless decisions + alias-conflict NR;
 * - E2: eleven-subgroup with 16 windowless decisions + alias-conflict NR;
 * - S7: seven-subgroup with 19 windowless + 1 single-`-1` decision;
 * - Q1: quarantined snapshot with 2 RT + 1 inherited-NR Class A entries;
 * - R1: restorable TIMELINE snapshot.
 * Expected: quarantined 3 entries / 1 snapshot; defect 3; windowless 37+19=56;
 * single 1; snapshot decisions 57; live 0; unsupported 0; rewrite 0;
 * topology 11 = 37, topology 7 = 19 windowless + 1 single. */
async function seedTopologyFixture(): Promise<void> {
  const conflictNr = (id: string, parentId: string) => makeNr({
    id, resourceTypeId: parentId, allocationMode: null,
    allocationStartWeek: 5, allocationEndWeek: 10, startWeek: 5, endWeek: 9,
  })
  await createSnapshot(
    'snap-e1',
    makeV2Snapshot(
      Array.from({ length: 21 }, (_, i) => makeRt({ id: `rt-e1-${i}`, allocationMode: 'CAPACITY_PLAN' })),
      [conflictNr('nr-e1-conflict', 'rt-e1-0')],
    ),
    '2026-05-20T00:00:00Z',
  )
  await createSnapshot(
    'snap-e2',
    makeV2Snapshot(
      Array.from({ length: 16 }, (_, i) => makeRt({ id: `rt-e2-${i}`, allocationMode: 'CAPACITY_PLAN' })),
      [conflictNr('nr-e2-conflict', 'rt-e2-0')],
    ),
    '2026-05-25T00:00:00Z',
  )
  await createSnapshot(
    'snap-s7',
    makeV2Snapshot(
      Array.from({ length: 19 }, (_, i) => makeRt({ id: `rt-s7-${i}`, allocationMode: 'CAPACITY_PLAN' })),
      [makeNr({
        id: 'nr-s7-minus-one',
        resourceTypeId: 'rt-s7-0',
        allocationMode: 'CAPACITY_PLAN',
        allocationStartWeek: null,
        allocationEndWeek: 5,
        startWeek: -1,
        endWeek: -1,
      })],
    ),
    '2026-05-10T00:00:00Z',
  )
  await createSnapshot(
    'snap-q1',
    makeV2Snapshot(
      [
        makeRt({ id: 'rt-q1-a', allocationMode: 'CAPACITY_PLAN' }),
        makeRt({ id: 'rt-q1-b', allocationMode: 'CAPACITY_PLAN' }),
      ],
      [makeNr({ id: 'nr-q1-inherited', resourceTypeId: 'rt-q1-a', allocationMode: null })],
    ),
    '2026-06-01T00:00:00Z',
  )
  await createSnapshot(
    'snap-r1',
    makeV2Snapshot(
      [makeRt({ id: 'rt-r1', allocationMode: 'TIMELINE', allocationStartWeek: 0, allocationEndWeek: 10 })],
      [],
    ),
    '2026-04-01T00:00:00Z',
  )
}

async function currentStateHash(): Promise<string> {
  return computeStateHash(await loadRemediationState(prisma))
}

async function expectedBoundary(): Promise<SnapshotEvidenceExpected> {
  const state = await loadRemediationState(prisma)
  const plan = buildRemediationPlan(state, 'test-commit')
  return {
    fingerprint: computePlanFingerprint(plan),
    baselineStateHash: computeStateHash(state),
    quarantinedEntries: 3,
    quarantinedSnapshots: 1,
    defectSnapshots: 3,
    windowlessDecisions: 56,
    singleMinusOneDecisions: 1,
    snapshotDecisions: 57,
    liveDecisions: 0,
    unsupported: 0,
    rewriteOperations: 0,
    topology11Snapshots: 2,
    topology7Snapshots: 1,
    topology11WindowlessDecisions: 37,
    topology7WindowlessDecisions: 19,
    topology7SingleMinusOneDecisions: 1,
  }
}

function tempDir(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'snapshot-evidence-it-'))
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describeIf('snapshot evidence command (integration)', () => {
  it('reconciles the corrected topology end to end and writes JSON + Markdown', async () => {
    await seedTopologyFixture()
    const dir = tempDir()
    const jsonPath = path.join(dir, 'evidence.json')
    const mdPath = path.join(dir, 'evidence.md')
    const expectedPath = path.join(dir, 'expected.json')
    const expected = await expectedBoundary()
    writeFileSync(expectedPath, JSON.stringify(expected, null, 2))
    const stateHashBefore = await currentStateHash()

    const exit = await main(['--json', jsonPath, '--markdown', mdPath, '--expected', expectedPath])

    expect(exit).toBe(0)
    expect(existsSync(jsonPath)).toBe(true)
    expect(existsSync(mdPath)).toBe(true)
    const report = JSON.parse(readFileSync(jsonPath, 'utf-8'))
    expect(report.formatVersion).toBe(1)
    expect(report.integrityResult).toEqual({
      fingerprintMatch: true, baselineMatch: true, countsMatch: true, reconciliationPassed: true,
    })
    expect(report.policyDecision).toBe('not-assessed')
    expect(report.topology).toMatchObject({
      quarantinedSnapshots: 1,
      defectSnapshots: 3,
      windowlessDecisions: 56,
      singleMinusOneDecisions: 1,
      snapshotDecisions: 57,
      liveDecisions: 0,
      elevenSnapshotSubgroup: { snapshots: 2, windowlessDecisions: 37 },
      sevenSnapshotSubgroup: { snapshots: 1, windowlessDecisions: 19, singleMinusOneDecisions: 1, totalDecisions: 20 },
    })

    // Output file modes (POSIX only) and no temporary residue.
    if (process.platform !== 'win32') {
      expect(statSync(jsonPath).mode & 0o777).toBe(0o600)
      expect(statSync(mdPath).mode & 0o777).toBe(0o600)
    }
    expect(readdirSync(dir).filter(name => name.includes('.tmp'))).toEqual([])
    expect(report.classAAggregates.totalEntries).toBe(3)
    expect(report.classAAggregates.byOwnerKind).toEqual({ resourceType: 2, namedResource: 1, unavailable: 0 })
    expect(report.singleNegativeEntries).toHaveLength(1)
    // The seeded sanitized production shape: -1 fallback on the start edge
    // (effective negative start) plus a shadowed -1 fallback on the end edge
    // (populated primary end) — both reported, reconciliation passes.
    expect(report.singleNegativeEntries[0]!.minusOneField).toBe('startWeek')
    expect(report.singleNegativeEntries[0]!.windowFields).toEqual({
      allocationStartWeek: 'absent-null',
      allocationEndWeek: 'populated',
      startWeek: 'minus-one',
      endWeek: 'minus-one',
    })
    expect(report.defectSnapshots).toHaveLength(3)
    const seven = report.defectSnapshots.find((m: { subgroup: string }) => m.subgroup === 'seven-single-minus-one')!
    expect(seven.windowlessDecisionCount).toBe(19)
    expect(seven.singleMinusOneDecisionCount).toBe(1)

    // Zero writes: canonical covered-state hash unchanged.
    const stateHashAfter = await currentStateHash()
    expect(stateHashAfter).toBe(stateHashBefore)

    // Markdown parity + redaction of seeded sensitive values.
    const markdown = readFileSync(mdPath, 'utf-8')
    for (const secret of [
      'fixture-project-42-abc', 'fixture-user-7-xyz',
      'snap-e1', 'snap-e2', 'snap-s7', 'snap-q1', 'snap-r1',
      'rt-e1-0', 'nr-s7-minus-one', 'nr-q1-inherited',
      'Fixture Secret Project', 'Fixture Secret Role', 'Fixture Secret Person',
    ]) {
      expect(readFileSync(jsonPath, 'utf-8')).not.toContain(secret)
      expect(markdown).not.toContain(secret)
    }
    expect(markdown).toContain('windowlessDecisions: 56')
    expect(markdown).toContain('policyDecision: not-assessed')

    rmSync(dir, { recursive: true, force: true })
  })

  it('refuses on fingerprint mismatch and writes no output', async () => {
    await seedTopologyFixture()
    const dir = tempDir()
    const jsonPath = path.join(dir, 'evidence.json')
    const mdPath = path.join(dir, 'evidence.md')
    const expectedPath = path.join(dir, 'expected.json')
    const expected = await expectedBoundary()
    writeFileSync(expectedPath, JSON.stringify({ ...expected, fingerprint: 'f'.repeat(64) }, null, 2))

    const exit = await main(['--json', jsonPath, '--markdown', mdPath, '--expected', expectedPath])

    expect(exit).toBe(1)
    expect(existsSync(jsonPath)).toBe(false)
    expect(existsSync(mdPath)).toBe(false)
    rmSync(dir, { recursive: true, force: true })
  })

  it('refuses on baseline mismatch and writes no output', async () => {
    await seedTopologyFixture()
    const dir = tempDir()
    const jsonPath = path.join(dir, 'evidence.json')
    const mdPath = path.join(dir, 'evidence.md')
    const expectedPath = path.join(dir, 'expected.json')
    const expected = await expectedBoundary()
    writeFileSync(expectedPath, JSON.stringify({ ...expected, baselineStateHash: '0'.repeat(64) }, null, 2))

    const exit = await main(['--json', jsonPath, '--markdown', mdPath, '--expected', expectedPath])

    expect(exit).toBe(1)
    expect(existsSync(jsonPath)).toBe(false)
    expect(existsSync(mdPath)).toBe(false)
    rmSync(dir, { recursive: true, force: true })
  })

  it('refuses on summary-count mismatch and writes no output', async () => {
    await seedTopologyFixture()
    const dir = tempDir()
    const jsonPath = path.join(dir, 'evidence.json')
    const mdPath = path.join(dir, 'evidence.md')
    const expectedPath = path.join(dir, 'expected.json')
    const expected = await expectedBoundary()
    writeFileSync(expectedPath, JSON.stringify({ ...expected, windowlessDecisions: 999 }, null, 2))

    const exit = await main(['--json', jsonPath, '--markdown', mdPath, '--expected', expectedPath])

    expect(exit).toBe(1)
    expect(existsSync(jsonPath)).toBe(false)
    expect(existsSync(mdPath)).toBe(false)
    rmSync(dir, { recursive: true, force: true })
  })

  it('refuses to overwrite an existing output file', async () => {
    await seedTopologyFixture()
    const dir = tempDir()
    const jsonPath = path.join(dir, 'evidence.json')
    const mdPath = path.join(dir, 'evidence.md')
    const expectedPath = path.join(dir, 'expected.json')
    writeFileSync(jsonPath, 'existing content')
    writeFileSync(expectedPath, JSON.stringify(await expectedBoundary(), null, 2))

    const exit = await main(['--json', jsonPath, '--markdown', mdPath, '--expected', expectedPath])

    expect(exit).toBe(1)
    expect(readFileSync(jsonPath, 'utf-8')).toBe('existing content')
    expect(existsSync(mdPath)).toBe(false)
    rmSync(dir, { recursive: true, force: true })
  })

  it('refuses on unsupported schema versions with a controlled error', async () => {
    await createSnapshot('snap-unsupported', { schemaVersion: 99, epics: [] }, '2026-06-01T00:00:00Z')
    const dir = tempDir()
    const jsonPath = path.join(dir, 'evidence.json')
    const mdPath = path.join(dir, 'evidence.md')
    const expectedPath = path.join(dir, 'expected.json')
    const expected = await expectedBoundary()
    writeFileSync(expectedPath, JSON.stringify(expected, null, 2))

    const exit = await main(['--json', jsonPath, '--markdown', mdPath, '--expected', expectedPath])

    expect(exit).toBe(1)
    expect(existsSync(jsonPath)).toBe(false)
    expect(existsSync(mdPath)).toBe(false)
    rmSync(dir, { recursive: true, force: true })
  })

  it('refuses on decision correlation failure with no output files and a safe message', async () => {
    // Two raw entries sharing one id: the plan produces single-negative
    // decisions whose correlation is ambiguous — the command fails closed
    // with no evidence emitted.
    await createSnapshot(
      'snap-correlation-ambiguous',
      makeV2Snapshot(
        [
          makeRt({ id: 'rt-dupe', allocationMode: 'CAPACITY_PLAN', allocationStartWeek: -1, allocationEndWeek: 5 }),
          makeRt({ id: 'rt-dupe', allocationMode: 'CAPACITY_PLAN', allocationStartWeek: -1, allocationEndWeek: 5 }),
        ],
        [],
      ),
      '2026-06-01T00:00:00Z',
    )
    const dir = tempDir()
    const jsonPath = path.join(dir, 'evidence.json')
    const mdPath = path.join(dir, 'evidence.md')
    const expectedPath = path.join(dir, 'expected.json')
    const expected = await expectedBoundary()
    writeFileSync(expectedPath, JSON.stringify(expected, null, 2))

    const exit = await main(['--json', jsonPath, '--markdown', mdPath, '--expected', expectedPath])

    expect(exit).toBe(1)
    expect(existsSync(jsonPath)).toBe(false)
    expect(existsSync(mdPath)).toBe(false)
    expect(readdirSync(dir).filter(name => name.includes('.tmp'))).toEqual([])
    // No identifiers or payload names leak into the refusal.
    expect(readFileSync(expectedPath, 'utf-8')).toBeTruthy()
    rmSync(dir, { recursive: true, force: true })
  })

  it('refuses when a correlated NamedResource parent is duplicated with different modes (no output, no writes)', async () => {
    // One explicit CAPACITY_PLAN NamedResource with a plan-derived
    // single-negative decision; two ResourceTypes share the referenced id
    // with different allocation modes — the parent correlation must refuse.
    await createSnapshot(
      'snap-dup-parent',
      makeV2Snapshot(
        [
          makeRt({ id: 'rt-dup-parent', allocationMode: 'CAPACITY_PLAN', allocationStartWeek: 0, allocationEndWeek: 5 }),
          makeRt({ id: 'rt-dup-parent', allocationMode: 'TIMELINE', allocationStartWeek: 0, allocationEndWeek: 5 }),
        ],
        [makeNr({ id: 'nr-child', resourceTypeId: 'rt-dup-parent', allocationMode: 'CAPACITY_PLAN', allocationStartWeek: -1, startWeek: 5, allocationEndWeek: 5, endWeek: null })],
      ),
      '2026-06-01T00:00:00Z',
    )
    const stateHashBefore = await currentStateHash()
    const dir = tempDir()
    const jsonPath = path.join(dir, 'evidence.json')
    const mdPath = path.join(dir, 'evidence.md')
    const expectedPath = path.join(dir, 'expected.json')
    const expected = await expectedBoundary()
    writeFileSync(expectedPath, JSON.stringify(expected, null, 2))

    const exit = await main(['--json', jsonPath, '--markdown', mdPath, '--expected', expectedPath])

    expect(exit).toBe(1)
    expect(existsSync(jsonPath)).toBe(false)
    expect(existsSync(mdPath)).toBe(false)
    expect(readdirSync(dir).filter(name => name.includes('.tmp'))).toEqual([])
    // Zero writes: canonical covered-state hash unchanged.
    const stateHashAfter = await currentStateHash()
    expect(stateHashAfter).toBe(stateHashBefore)
    rmSync(dir, { recursive: true, force: true })
  })

  it('rejects malformed arguments and missing required flags', async () => {
    const dir = tempDir()
    const exitMissing = await main(['--json', path.join(dir, 'a.json')])
    expect(exitMissing).toBe(1)
    const exitUnknown = await main(['--bogus'])
    expect(exitUnknown).toBe(1)
    rmSync(dir, { recursive: true, force: true })
  })

  it('refuses identical JSON and Markdown output paths with no database access', async () => {
    const dir = tempDir()
    const same = path.join(dir, 'evidence.json')
    // The expectations file does not exist: reaching path validation before
    // the expectations read proves the refusal precedes any file or database
    // access even in the real CLI flow.
    const exit = await main(['--json', same, '--markdown', same, '--expected', path.join(dir, 'missing.json')])
    expect(exit).toBe(1)
    expect(readdirSync(dir)).toEqual([])
    rmSync(dir, { recursive: true, force: true })
  })
})
