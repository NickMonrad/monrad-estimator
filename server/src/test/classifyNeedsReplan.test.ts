/**
 * classifyNeedsReplan.test.ts — Unit tests for the reviewed production
 * maintenance path (issue #449 / #404): classifying an explicitly supplied
 * project set as NEEDS_REPLAN via the same atomic reset transaction body.
 *
 * Covers manifest parsing (fail closed), the deterministic reset-state
 * fingerprint (stability, ordering, per-state-change sensitivity, exclusion
 * of unrelated backlog state), the dry-run/apply fingerprint contract
 * (refusal without/with wrong fingerprint, zero writes), the atomic batch
 * apply, and the CLI argument contract.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Prisma } from '@prisma/client'

import {
  parseClassifyManifest,
  planClassification,
  classifyNeedsReplan,
  computeClassificationFingerprint,
  ClassifyManifestError,
  ClassifyAbortError,
  ClassifyDriftError,
  ClassifySerializationConflictError,
  type ClassifyManifest,
  type ClassifyDb,
} from '../lib/classifyNeedsReplan.js'
import { parseClassifyCliArgs } from '../scripts/classifyNeedsReplan.js'
import { resetProjectPlanningWithinTransaction } from '../lib/resetProjectPlanning.js'

vi.mock('../lib/resetProjectPlanning.js', () => ({
  resetProjectPlanningWithinTransaction: vi.fn().mockResolvedValue({ projectId: 'x', planningState: 'NEEDS_REPLAN' }),
}))

beforeEach(() => vi.clearAllMocks())

// ─── Fake database ──────────────────────────────────────────────────────────

interface FakeState {
  projects?: Array<{ id: string; planningState: string; weeklyDemandCache?: unknown }>
  capacityProfiles?: Array<Record<string, unknown>>
  capacitySegments?: Array<Record<string, unknown>>
  capacityPlans?: Array<Record<string, unknown>>
  capacityPlanPeriods?: Array<Record<string, unknown>>
  capacityPlanEntries?: Array<Record<string, unknown>>
  timelineEntries?: Array<Record<string, unknown>>
  storyTimelineEntries?: Array<Record<string, unknown>>
  namedResources?: Array<Record<string, unknown>>
}

/**
 * Build a fake db/tx whose query methods serve the given state. The same
 * object serves as both the outer client and the transaction client.
 */
function makeDb(state: FakeState, opts: { transactionError?: unknown } = {}) {
  const queries = {
    project: {
      findMany: vi.fn().mockResolvedValue(state.projects ?? []),
      findUnique: vi.fn().mockImplementation(async ({ where }: { where: { id: string } }) =>
        (state.projects ?? []).find(p => p.id === where.id) ?? null),
      update: vi.fn(),
    },
    capacityProfile: {
      findMany: vi.fn().mockResolvedValue(state.capacityProfiles ?? []),
      deleteMany: vi.fn(),
    },
    capacitySegment: { findMany: vi.fn().mockResolvedValue(state.capacitySegments ?? []) },
    capacityPlan: { findMany: vi.fn().mockResolvedValue(state.capacityPlans ?? []), deleteMany: vi.fn() },
    capacityPlanPeriod: { findMany: vi.fn().mockResolvedValue(state.capacityPlanPeriods ?? []) },
    capacityPlanEntry: { findMany: vi.fn().mockResolvedValue(state.capacityPlanEntries ?? []) },
    timelineEntry: { findMany: vi.fn().mockResolvedValue(state.timelineEntries ?? []), deleteMany: vi.fn() },
    storyTimelineEntry: { findMany: vi.fn().mockResolvedValue(state.storyTimelineEntries ?? []), deleteMany: vi.fn() },
    namedResource: { findMany: vi.fn().mockResolvedValue(state.namedResources ?? []), deleteMany: vi.fn() },
    epic: { findMany: vi.fn().mockResolvedValue([]) },
    task: { findMany: vi.fn().mockResolvedValue([]) },
  }
  const db = {
    ...queries,
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
      const result = await fn(queries)
      // Simulated commit-time failure (e.g. a serialization conflict).
      if (opts.transactionError) throw opts.transactionError
      return result
    }),
  } as unknown as ClassifyDb
  return { db, queries }
}

const manifest: ClassifyManifest = { projectIds: ['p1', 'p2'] }

const defaultState: FakeState = {
  projects: [
    { id: 'p1', planningState: 'CURRENT', weeklyDemandCache: { 'rt-1|1': 5 } },
    { id: 'p2', planningState: 'CURRENT', weeklyDemandCache: null },
  ],
  capacityProfiles: [
    { id: 'cp-1', projectId: 'p1', resourceTypeId: 'rt-1', namedResourceId: null, ownerKind: 'ROLE', planningBasis: 'DEMAND_FOLLOWING', source: 'MANUAL', defaultPercent: 100, startWeek: null, endWeek: null },
  ],
  capacitySegments: [
    { id: 'seg-1', capacityProfileId: 'cp-1', startWeek: 0, endWeek: 4, capacityPercent: 100, source: 'MANUAL' },
  ],
  capacityPlans: [
    { id: 'plan-1', projectId: 'p1', name: 'Plan A', targetWeeks: 8, periodWeeks: 4, maxDelta: 1, isActive: true, totalCost: 1000, deliveryWeeks: 8 },
  ],
  capacityPlanPeriods: [
    { id: 'per-1', planId: 'plan-1', periodIndex: 0, startWeek: 0, endWeek: 4 },
  ],
  capacityPlanEntries: [
    { id: 'ent-1', periodId: 'per-1', resourceTypeId: 'rt-1', headcount: 2, demandFTE: 1.5, utilisationPct: 75 },
  ],
  timelineEntries: [
    { id: 'tl-1', projectId: 'p1', featureId: 'f-1', startWeek: 0, durationWeeks: 6, isManual: false },
  ],
  storyTimelineEntries: [
    { id: 'stl-1', projectId: 'p1', storyId: 's-1', startWeek: 0, durationWeeks: 6, isManual: false },
  ],
  namedResources: [
    { id: 'nr-1', resourceTypeId: 'rt-1' },
  ],
}

async function fingerprintFor(state: FakeState): Promise<string> {
  const { db } = makeDb(state)
  return computeClassificationFingerprint(db, manifest)
}

// ─── Manifest parsing ───────────────────────────────────────────────────────

describe('parseClassifyManifest', () => {
  it('accepts a valid reviewed manifest', () => {
    expect(parseClassifyManifest({ projectIds: ['p1', 'p2'] })).toEqual({ projectIds: ['p1', 'p2'] })
  })

  it.each([
    [null, 'object'],
    ['nope', 'object'],
    [{}, 'projectIds'],
    [{ projectIds: 'p1' }, 'projectIds'],
    [{ projectIds: [] }, 'not be empty'],
    [{ projectIds: ['p1', 42] }, 'non-empty string'],
    [{ projectIds: ['p1', 'p1'] }, 'duplicate'],
  ])('fails closed on malformed manifest %#', (raw, expected) => {
    expect(() => parseClassifyManifest(raw)).toThrow(ClassifyManifestError)
    expect(() => parseClassifyManifest(raw)).toThrow(expected)
  })
})

// ─── Fingerprint ────────────────────────────────────────────────────────────

describe('computeClassificationFingerprint', () => {
  it('is identical across repeated dry-runs on unchanged state', async () => {
    const a = await fingerprintFor(defaultState)
    const b = await fingerprintFor(defaultState)
    expect(a).toMatch(/^[0-9a-f]{64}$/)
    expect(a).toBe(b)
  })

  it('is independent of database return order', async () => {
    const reversed: FakeState = {
      ...defaultState,
      projects: [...defaultState.projects!].reverse(),
      capacityProfiles: [...defaultState.capacityProfiles!].reverse(),
      capacitySegments: [...defaultState.capacitySegments!].reverse(),
      capacityPlans: [...defaultState.capacityPlans!].reverse(),
      capacityPlanPeriods: [...defaultState.capacityPlanPeriods!].reverse(),
      capacityPlanEntries: [...defaultState.capacityPlanEntries!].reverse(),
      timelineEntries: [...defaultState.timelineEntries!].reverse(),
      storyTimelineEntries: [...defaultState.storyTimelineEntries!].reverse(),
      namedResources: [...defaultState.namedResources!].reverse(),
    }
    expect(await fingerprintFor(reversed)).toBe(await fingerprintFor(defaultState))
  })

  it('changes when a manifest project is missing (existence drift)', async () => {
    const missing: FakeState = { ...defaultState, projects: [defaultState.projects![0]] }
    expect(await fingerprintFor(missing)).not.toBe(await fingerprintFor(defaultState))
  })

  it('changes when project planningState or weeklyDemandCache changes', async () => {
    const stateChanged: FakeState = {
      ...defaultState,
      projects: [{ ...defaultState.projects![0], planningState: 'NEEDS_REPLAN' }, defaultState.projects![1]],
    }
    expect(await fingerprintFor(stateChanged)).not.toBe(await fingerprintFor(defaultState))

    const cacheChanged: FakeState = {
      ...defaultState,
      projects: [{ ...defaultState.projects![0], weeklyDemandCache: { 'rt-1|2': 9 } }, defaultState.projects![1]],
    }
    expect(await fingerprintFor(cacheChanged)).not.toBe(await fingerprintFor(defaultState))
  })

  it('changes when any reset-relevant CapacityProfile field changes', async () => {
    const changed: FakeState = {
      ...defaultState,
      capacityProfiles: [{ ...defaultState.capacityProfiles![0], ownerKind: 'NAMED_PERSON' }],
    }
    expect(await fingerprintFor(changed)).not.toBe(await fingerprintFor(defaultState))
  })

  it('changes when a CapacitySegment changes', async () => {
    const changed: FakeState = {
      ...defaultState,
      capacitySegments: [{ ...defaultState.capacitySegments![0], capacityPercent: 50 }],
    }
    expect(await fingerprintFor(changed)).not.toBe(await fingerprintFor(defaultState))
  })

  it('changes when CapacityPlan/period/entry state changes', async () => {
    const planChanged: FakeState = { ...defaultState, capacityPlans: [{ ...defaultState.capacityPlans![0], isActive: false }] }
    expect(await fingerprintFor(planChanged)).not.toBe(await fingerprintFor(defaultState))

    const periodChanged: FakeState = { ...defaultState, capacityPlanPeriods: [{ ...defaultState.capacityPlanPeriods![0], endWeek: 5 }] }
    expect(await fingerprintFor(periodChanged)).not.toBe(await fingerprintFor(defaultState))

    const entryChanged: FakeState = { ...defaultState, capacityPlanEntries: [{ ...defaultState.capacityPlanEntries![0], headcount: 3 }] }
    expect(await fingerprintFor(entryChanged)).not.toBe(await fingerprintFor(defaultState))
  })

  it('changes when Timeline or StoryTimeline state changes', async () => {
    const tlChanged: FakeState = { ...defaultState, timelineEntries: [{ ...defaultState.timelineEntries![0], durationWeeks: 8 }] }
    expect(await fingerprintFor(tlChanged)).not.toBe(await fingerprintFor(defaultState))

    const stlChanged: FakeState = { ...defaultState, storyTimelineEntries: [{ ...defaultState.storyTimelineEntries![0], startWeek: 2 }] }
    expect(await fingerprintFor(stlChanged)).not.toBe(await fingerprintFor(defaultState))
  })

  it('changes when planner provenance (profile ownerKind) changes', async () => {
    // A named resource becomes a proven PLANNED_RESOURCE planner artefact only
    // via its profile ownerKind — that change must alter the fingerprint.
    const changed: FakeState = {
      ...defaultState,
      capacityProfiles: [{
        ...defaultState.capacityProfiles![0],
        namedResourceId: 'nr-1',
        resourceTypeId: null,
        ownerKind: 'PLANNED_RESOURCE',
        source: 'SQUAD_PLANNER',
        planningBasis: 'CAPACITY_PROFILE',
      }],
    }
    expect(await fingerprintFor(changed)).not.toBe(await fingerprintFor(defaultState))
  })

  it('does not read unrelated backlog/business state', async () => {
    const { db, queries } = makeDb(defaultState)
    await computeClassificationFingerprint(db, manifest)
    // Fingerprint input is exactly the reset-relevant state: epic/task queries
    // are never issued, so backlog changes cannot invalidate the fingerprint.
    expect(queries.epic.findMany).not.toHaveBeenCalled()
    expect(queries.task.findMany).not.toHaveBeenCalled()
  })
})

// ─── Plan classification ────────────────────────────────────────────────────

describe('planClassification', () => {
  it('classifies CURRENT projects as to-classify and NEEDS_REPLAN ones as already', async () => {
    const { db } = makeDb({
      projects: [
        { id: 'p1', planningState: 'CURRENT' },
        { id: 'p2', planningState: 'NEEDS_REPLAN' },
      ],
    })
    const report = await planClassification(db, { projectIds: ['p1', 'p2'] })

    expect(report.completed).toBe(true)
    expect(report.classifiedCount).toBe(1)
    expect(report.alreadyCount).toBe(1)
    expect(report.entries).toEqual([
      { projectId: 'p1', status: 'to-classify' },
      { projectId: 'p2', status: 'already-needs-replan' },
    ])
  })

  it('reports not-found projects (fail closed)', async () => {
    const { db } = makeDb({ projects: [{ id: 'p1', planningState: 'CURRENT' }] })
    const report = await planClassification(db, { projectIds: ['p1', 'p-missing'] })

    expect(report.completed).toBe(false)
    expect(report.notFoundCount).toBe(1)
    expect(report.entries.find(e => e.projectId === 'p-missing')?.status).toBe('not-found')
  })
})

// ─── classifyNeedsReplan ────────────────────────────────────────────────────

describe('classifyNeedsReplan', () => {
  it('is a zero-write dry run by default: one repeatable-read snapshot for report + fingerprint', async () => {
    const { db } = makeDb(defaultState)
    const report = await classifyNeedsReplan(db, manifest)

    expect(report.classifiedCount).toBe(2)
    expect(report.stateFingerprint).toMatch(/^[0-9a-f]{64}$/)
    expect(report.stateFingerprint).toBe(await computeClassificationFingerprint(db, manifest))
    // Dry-run report and fingerprint are generated inside ONE transaction
    // with repeatable-read isolation — one consistent snapshot.
    expect(db.$transaction).toHaveBeenCalledTimes(1)
    expect(db.$transaction).toHaveBeenCalledWith(
      expect.any(Function),
      { isolationLevel: 'RepeatableRead' },
    )
    expect(resetProjectPlanningWithinTransaction).not.toHaveBeenCalled()
  })

  it('runs classification and fingerprint reads through one transaction body', async () => {
    const { db } = makeDb(defaultState)
    await classifyNeedsReplan(db, manifest)

    // The report path is fully enclosed in the repeatable-read transaction
    // body — the root client is never used for the review reads. In the fake
    // the transaction client and root client share query objects, so the
    // ordering of classification → fingerprint inside ONE body is what this
    // asserts.
    const txBody = vi.mocked(db.$transaction).mock.calls[0][0] as (
      tx: unknown,
    ) => Promise<unknown>
    const result = await txBody(db)
    expect(result).toHaveProperty('stateFingerprint')
  })

  it('invokes the afterPlanRead seam inside the snapshot before the fingerprint read', async () => {
    const { db } = makeDb(defaultState)
    const afterPlanRead = vi.fn(async () => { /* test seam */ })
    await classifyNeedsReplan(db, manifest, { afterPlanRead })

    expect(afterPlanRead).toHaveBeenCalledTimes(1)
    const txBody = vi.mocked(db.$transaction).mock.calls[0][0] as (
      tx: unknown,
    ) => Promise<unknown>
    const result = await txBody(db)
    expect(afterPlanRead).toHaveBeenCalledTimes(2)
    expect(result).toHaveProperty('stateFingerprint')
  })

  it('refuses apply without the reviewed fingerprint, with zero writes', async () => {
    const { db, queries } = makeDb(defaultState)
    await expect(
      classifyNeedsReplan(db, manifest, { apply: true }),
    ).rejects.toThrow(ClassifyAbortError)
    expect(resetProjectPlanningWithinTransaction).not.toHaveBeenCalled()
    expect(queries.project.update).not.toHaveBeenCalled()
  })

  it('refuses apply on fingerprint drift, with zero reset calls', async () => {
    const { db } = makeDb(defaultState)
    const reviewed = await computeClassificationFingerprint(db, manifest)

    // One reset-relevant field changes after review.
    const drifted = makeDb({
      ...defaultState,
      capacityProfiles: [{ ...defaultState.capacityProfiles![0], defaultPercent: 80 }],
    })

    await expect(
      classifyNeedsReplan(drifted.db, manifest, { apply: true, expectedFingerprint: reviewed }),
    ).rejects.toThrow(ClassifyDriftError)
    expect(resetProjectPlanningWithinTransaction).not.toHaveBeenCalled()
    expect(drifted.queries.project.update).not.toHaveBeenCalled()
    expect(drifted.queries.capacityProfile.deleteMany).not.toHaveBeenCalled()
  })

  it('applies the reviewed set atomically in one transaction via the reset body', async () => {
    const { db } = makeDb(defaultState)
    const reviewed = await computeClassificationFingerprint(db, manifest)

    const report = await classifyNeedsReplan(db, manifest, {
      apply: true,
      expectedFingerprint: reviewed,
    })

    expect(report.classifiedCount).toBe(2)
    expect(report.stateFingerprint).toBe(reviewed)
    expect(db.$transaction).toHaveBeenCalledTimes(1)
    // Every to-classify project goes through the same reset body.
    expect(resetProjectPlanningWithinTransaction).toHaveBeenCalledTimes(2)
    expect(vi.mocked(resetProjectPlanningWithinTransaction).mock.calls.map(c => c[1])).toEqual(['p1', 'p2'])
  })

  it('requests Serializable isolation for the destructive apply transaction', async () => {
    const { db } = makeDb(defaultState)
    const reviewed = await computeClassificationFingerprint(db, manifest)

    await classifyNeedsReplan(db, manifest, {
      apply: true,
      expectedFingerprint: reviewed,
    })

    expect(db.$transaction).toHaveBeenCalledWith(
      expect.any(Function),
      { isolationLevel: 'Serializable' },
    )
  })

  it('maps a Prisma P2034 serialization conflict to the actionable fail-closed error without retry', async () => {
    const conflict = new Prisma.PrismaClientKnownRequestError('Transaction failed', {
      code: 'P2034',
      clientVersion: '7.8.0',
    })
    const { db, queries } = makeDb(defaultState, { transactionError: conflict })
    const reviewed = await computeClassificationFingerprint(db, manifest)

    const attempt = classifyNeedsReplan(db, manifest, { apply: true, expectedFingerprint: reviewed })
    await expect(attempt).rejects.toThrow(ClassifySerializationConflictError)
    await expect(attempt).rejects.toThrow(/changed concurrently/)
    // The apply attempt is invalidated — the destructive transaction is NEVER
    // retried automatically with the stale reviewed fingerprint.
    expect(db.$transaction).toHaveBeenCalledTimes(1)
    expect(queries.project.update).not.toHaveBeenCalled()
  })

  it('maps a driver-level 40001 serialization conflict to the actionable fail-closed error', async () => {
    const conflict = new Error('serialization_failure') as Error & { cause?: unknown }
    conflict.cause = { originalCode: '40001' }
    const { db } = makeDb(defaultState, { transactionError: conflict })
    const reviewed = await computeClassificationFingerprint(db, manifest)

    await expect(
      classifyNeedsReplan(db, manifest, { apply: true, expectedFingerprint: reviewed }),
    ).rejects.toThrow(ClassifySerializationConflictError)
    expect(db.$transaction).toHaveBeenCalledTimes(1)
  })

  it('leaves unrelated transaction failures unmodified (no retry, no masking)', async () => {
    const { db } = makeDb(defaultState, { transactionError: new Error('disk full') })
    const reviewed = await computeClassificationFingerprint(db, manifest)

    await expect(
      classifyNeedsReplan(db, manifest, { apply: true, expectedFingerprint: reviewed }),
    ).rejects.toThrow('disk full')
    expect(db.$transaction).toHaveBeenCalledTimes(1)
  })

  it('skips already-NEEDS_REPLAN projects and still runs in one transaction', async () => {
    const state: FakeState = {
      ...defaultState,
      projects: [
        { id: 'p1', planningState: 'CURRENT' },
        { id: 'p2', planningState: 'NEEDS_REPLAN' },
      ],
    }
    const { db } = makeDb(state)
    const reviewed = await computeClassificationFingerprint(db, manifest)

    const report = await classifyNeedsReplan(db, manifest, {
      apply: true,
      expectedFingerprint: reviewed,
    })

    expect(report.classifiedCount).toBe(1)
    expect(report.alreadyCount).toBe(1)
    expect(db.$transaction).toHaveBeenCalledTimes(1)
    expect(resetProjectPlanningWithinTransaction).toHaveBeenCalledTimes(1)
    expect(vi.mocked(resetProjectPlanningWithinTransaction).mock.calls[0][1]).toBe('p1')
  })

  it('aborts when a manifest project no longer exists', async () => {
    const { db } = makeDb({ projects: [{ id: 'p1', planningState: 'CURRENT' }] })
    await expect(
      classifyNeedsReplan(db, { projectIds: ['p1', 'p-gone'] }),
    ).rejects.toThrow(ClassifyAbortError)

    await expect(
      classifyNeedsReplan(db, { projectIds: ['p1', 'p-gone'] }, { apply: true, expectedFingerprint: '0'.repeat(64) }),
    ).rejects.toThrow(ClassifyAbortError)
  })
})

// ─── CLI argument contract ──────────────────────────────────────────────────

describe('parseClassifyCliArgs', () => {
  it('parses a valid dry-run invocation', () => {
    expect(parseClassifyCliArgs(['--manifest', 'm.json'])).toEqual({
      apply: false,
      manifestPath: 'm.json',
      expectedFingerprint: null,
      error: null,
    })
  })

  it('parses a valid apply invocation with the reviewed fingerprint', () => {
    const args = parseClassifyCliArgs(['--manifest', 'm.json', '--apply', '--expected-fingerprint', 'a'.repeat(64)])
    expect(args.error).toBeNull()
    expect(args.apply).toBe(true)
    expect(args.expectedFingerprint).toBe('a'.repeat(64))
  })

  it('rejects apply without the reviewed fingerprint', () => {
    const args = parseClassifyCliArgs(['--manifest', 'm.json', '--apply'])
    expect(args.error).toContain('--expected-fingerprint')
  })

  it('rejects a malformed fingerprint', () => {
    const args = parseClassifyCliArgs(['--manifest', 'm.json', '--apply', '--expected-fingerprint', 'not-a-hash'])
    expect(args.error).toContain('SHA-256')
  })

  it('rejects missing manifest and unknown arguments', () => {
    expect(parseClassifyCliArgs([]).error).toContain('usage')
    expect(parseClassifyCliArgs(['--bogus']).error).toContain('usage')
    expect(parseClassifyCliArgs(['--manifest']).error).toContain('usage')
  })
})
