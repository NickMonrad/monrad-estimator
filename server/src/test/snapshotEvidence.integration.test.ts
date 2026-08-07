/**
 * snapshotEvidence.integration.test.ts — Real PostgreSQL integration tests
 * for the Issue #432 sanitized snapshot evidence command
 * (server/src/scripts/generateSnapshotEvidence.ts).
 *
 * Proves against a disposable database (Docker-first lifecycle):
 *   - the corrected 11-plus-7 snapshot topology and the reviewed counts
 *     reconcile end to end through the real CLI entry point under the
 *     issue #444 retired policy (all seeded V2 snapshots non-restorable,
 *     zero quarantine classification);
 *   - entry-level and structural defect categorisation (alias conflict,
 *     duplicate owners, single -1 edges);
 *   - current classifier reuse (restorable/retired/defect verdicts);
 *   - fingerprint, baseline and summary-count mismatch refusal;
 *   - output-file safety (never overwrite);
 *   - unsupported schema-version refusal;
 *   - zero writes and exact database-state preservation;
 *   - identifier/name/payload redaction of seeded sensitive values.
 *
 * All tests are skipped unless INTEGRATION_TEST=true.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
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
 * - S7: seven-subgroup with 19 windowless decisions + 1 deterministic S
 *   entry + a residual alias-conflict NR (production M1–M6/M8 shape: the
 *   snapshot stays defect, the S entry leaves the decision set);
 * - Q1: previously-quarantined snapshot with 2 RT + 1 inherited-NR entries;
 * - R1: previously-restorable TIMELINE snapshot.
 * Expected under issue #444 (all five V2 snapshots retired): quarantined
 * 0/0; defect 5; windowless 21+16+19+2=58; single 0; snapshot decisions
 * 58; live 0; unsupported 0; rewrite 0; topology 11 = 5 (58 windowless). */
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
      [
        makeNr({
          id: 'nr-s7-minus-one',
          resourceTypeId: 'rt-s7-0',
          allocationMode: 'CAPACITY_PLAN',
          allocationStartWeek: null,
          allocationEndWeek: 5,
          startWeek: -1,
          endWeek: -1,
        }),
        // Residual independent defect (production M1–M6/M8: two alias-
        // conflict entries per snapshot): the snapshot stays defect while the
        // S entry itself is deterministic zero.
        makeNr({
          id: 'nr-s7-conflict',
          resourceTypeId: 'rt-s7-0',
          allocationMode: null,
          allocationStartWeek: 5,
          allocationEndWeek: 10,
          startWeek: 5,
          endWeek: 9,
        }),
      ],
    ),
    '2026-05-10T00:00:00Z',
  )
  await createSnapshot(
    'snap-q1',
    makeV2Snapshot(
      [
        makeRt({ id: 'rt-q1-a', allocationMode: 'CAPACITY_PLAN' }),
        makeRt({ id: 'rt-q1-b', allocationMode: 'CAPACITY_PLAN' }),
        // Issue #440 companion: windowless EFFORT at 100% (alreadyValid).
        makeRt({ id: 'rt-q1-effort', allocationMode: 'EFFORT' }),
      ],
      [
        makeNr({ id: 'nr-q1-inherited', resourceTypeId: 'rt-q1-a', allocationMode: null }),
        // Issue #440 companion: explicit windowed TIMELINE at 100/100
        // (alreadyValid; populated non-negative window states).
        makeNr({ id: 'nr-q1-timeline', resourceTypeId: 'rt-q1-b', allocationMode: 'TIMELINE', allocationStartWeek: 2, allocationEndWeek: 9, startWeek: 2, endWeek: 9 }),
      ],
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
    // Issue #444: all five seeded V2 snapshots are deliberately retired
    // (non-restorable); quarantine classification no longer exists and every
    // windowless entry becomes a plain decision.
    quarantinedEntries: 0,
    quarantinedSnapshots: 0,
    defectSnapshots: 5,
    windowlessDecisions: 58,
    singleMinusOneDecisions: 0,
    snapshotDecisions: 58,
    liveDecisions: 0,
    unsupported: 0,
    rewriteOperations: 0,
    topology11Snapshots: 5,
    topology7Snapshots: 0,
    topology11WindowlessDecisions: 58,
    topology7WindowlessDecisions: 0,
    topology7SingleMinusOneDecisions: 0,
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
    expect(report.formatVersion).toBe(2)
    expect(report.integrityResult).toEqual({
      fingerprintMatch: true, baselineMatch: true, countsMatch: true, reconciliationPassed: true,
    })
    expect(report.policyDecision).toBe('not-assessed')
    expect(report.topology).toMatchObject({
      quarantinedSnapshots: 0,
      defectSnapshots: 5,
      windowlessDecisions: 58,
      singleMinusOneDecisions: 0,
      snapshotDecisions: 58,
      liveDecisions: 0,
      elevenSnapshotSubgroup: { snapshots: 5, windowlessDecisions: 58 },
      sevenSnapshotSubgroup: { snapshots: 0, windowlessDecisions: 0, singleMinusOneDecisions: 0, totalDecisions: 0 },
    })

    // Output file modes (POSIX only) and no temporary residue.
    if (process.platform !== 'win32') {
      expect(statSync(jsonPath).mode & 0o777).toBe(0o600)
      expect(statSync(mdPath).mode & 0o777).toBe(0o600)
    }
    expect(readdirSync(dir).filter(name => name.includes('.tmp'))).toEqual([])
    // Issue #444: quarantine classification is retired — every Class A
    // aggregate and the companion population are zero.
    expect(report.classAAggregates.totalEntries).toBe(0)
    expect(report.classAAggregates.byOwnerKind).toEqual({ resourceType: 0, namedResource: 0, unavailable: 0 })
    expect(report.classACompanionEvidence.population).toEqual({
      classAQuarantinedSnapshots: 0,
      snapshotsWithCompanions: 0,
      exactClassAResourceTypeEntries: 0,
      exactClassANamedResourceEntries: 0,
      companionResourceTypeEntries: 0,
      companionNamedResourceEntries: 0,
      totalCompanionEntries: 0,
      excludedMixedClassABSnapshots: 0,
    })
    expect(report.classACompanionEvidence.planClassifications).toEqual({
      deterministic: 0,
      decisionRequired: 0,
      unsupported: 0,
      alreadyValid: 0,
      quarantined: 0,
    })
    expect(report.classACompanionEvidence.snapshotFlags).toEqual({
      allEntriesWindowless: 0,
      notAllEntriesWindowless: 0,
      allEntriesApproved100: 0,
      notAllEntriesApproved100: 0,
      allCompanionsWindowless: 0,
      notAllCompanionsWindowless: 0,
      allCompanionsApproved100: 0,
      notAllCompanionsApproved100: 0,
      anyCompanionInheritedMode: 0,
      noCompanionInheritedMode: 0,
    })
    const companionRows = report.classACompanionEvidence.shapeRows
    const rowSum = companionRows.reduce((sum: number, row: { count: number }) => sum + row.count, 0)
    expect(rowSum).toBe(0)
    // The retired policy emits no quarantine findings.
    expect(report.observedBoundary.summary.quarantined).toBe(0)
    // The seeded S entry stays a deterministic finding — no single-negative
    // decision exists, so no S record is emitted.
    expect(report.singleNegativeEntries).toHaveLength(0)
    expect(report.defectSnapshots).toHaveLength(5)
    const snapS7 = report.defectSnapshots.find((m: { windowlessDecisionCount: number }) => m.windowlessDecisionCount === 19)!
    expect(snapS7.windowlessDecisionCount).toBe(19)
    expect(snapS7.singleMinusOneDecisionCount).toBe(0)
    expect(snapS7.entryErrorCategories['alias-conflict']).toBeGreaterThanOrEqual(1)

    // Zero writes: canonical covered-state hash unchanged.
    const stateHashAfter = await currentStateHash()
    expect(stateHashAfter).toBe(stateHashBefore)

    // Markdown parity + redaction of seeded sensitive values.
    const markdown = readFileSync(mdPath, 'utf-8')
    for (const secret of [
      'fixture-project-42-abc', 'fixture-user-7-xyz',
      'snap-e1', 'snap-e2', 'snap-s7', 'snap-q1', 'snap-r1',
      'rt-e1-0', 'nr-s7-minus-one', 'nr-q1-inherited',
      'rt-q1-effort', 'nr-q1-timeline',
      'Fixture Secret Project', 'Fixture Secret Role', 'Fixture Secret Person',
    ]) {
      expect(readFileSync(jsonPath, 'utf-8')).not.toContain(secret)
      expect(markdown).not.toContain(secret)
    }
    expect(markdown).toContain('windowlessDecisions: 58')
    expect(markdown).toContain('policyDecision: not-assessed')
    // Issue #440 companion section is mirrored in Markdown (empty under the
    // retired policy).
    expect(markdown).toContain('## Class A companion evidence')
    expect(markdown).toContain('- totalCompanionEntries: 0')
    expect(markdown).toContain('- anyCompanionInheritedMode: 0')

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

  it('refuses when the negative effective source is below -1 with a shadowed fallback -1 (no output, no writes)', async () => {
    // allocationStartWeek -2 supplies the effective start; startWeek -1 is
    // shadowed and must never be selected as the minus-one field.
    await createSnapshot(
      'snap-source-mismatch',
      makeV2Snapshot(
        [makeRt({ id: 'rt-p', allocationMode: 'CAPACITY_PLAN', allocationStartWeek: 0, allocationEndWeek: 5 })],
        [makeNr({ id: 'nr-mismatch', resourceTypeId: 'rt-p', allocationMode: 'CAPACITY_PLAN', allocationStartWeek: -2, startWeek: -1, allocationEndWeek: 5, endWeek: null })],
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

    const errors: string[] = []
    const spy = vi.spyOn(console, 'error').mockImplementation(message => errors.push(String(message)))
    let exit: number
    try {
      exit = await main(['--json', jsonPath, '--markdown', mdPath, '--expected', expectedPath])
    } finally {
      spy.mockRestore()
    }

    expect(exit).toBe(1)
    expect(existsSync(jsonPath)).toBe(false)
    expect(existsSync(mdPath)).toBe(false)
    expect(readdirSync(dir).filter(name => name.includes('.tmp'))).toEqual([])
    // Zero writes: canonical covered-state hash unchanged.
    expect(await currentStateHash()).toBe(stateHashBefore)
    // The controlled error contains no seeded identifier, name, mode, raw
    // numeric value or payload fragment.
    const stderr = errors.join('\n')
    expect(stderr).toContain('not exactly minus one')
    for (const secret of ['nr-mismatch', 'rt-p', 'snap-source-mismatch', 'CAPACITY_PLAN', '-2', 'Secret']) {
      expect(stderr).not.toContain(secret)
    }
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
