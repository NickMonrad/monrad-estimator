/**
 * snapshotEvidence.test.ts — Unit tests for the Issue #432 sanitized snapshot
 * evidence aggregation module (server/src/lib/snapshotEvidence.ts).
 *
 * Covers: the four raw `-1` orientations, null/populated/conflicting
 * alternate aliases, explicit vs inherited NamedResource modes, percentage
 * bucket boundaries, era categories, ResourceType vs NamedResource Class A
 * aggregation, deterministic sanitized labelling, deterministic output
 * ordering, JSON/Markdown parity, identifier/name redaction, controlled safe
 * errors, and expectation/mismatch handling.
 */

import { describe, it, expect } from 'vitest'

import {
  buildSnapshotEvidenceReport,
  classifySnapshotEvidence,
  isExpectedBoundaryShape,
  percentCategory,
  renderSnapshotEvidenceMarkdown,
  snapshotEraCategory,
  SnapshotEvidenceError,
  type SnapshotEvidenceExpected,
} from '../lib/snapshotEvidence.js'
import {
  buildRemediationPlan,
  computePlanFingerprint,
  computeStateHash,
  type RemediationDatabaseState,
} from '../lib/productionRemediationPlan.js'

// ─── Fixtures ───────────────────────────────────────────────────────────────

const PROJECT_ID = 'project-secret-42'

interface RtOverrides {
  id?: string
  name?: string
  allocationMode?: string | null
  allocationPercent?: number | null
  allocationStartWeek?: number | null
  allocationEndWeek?: number | null
}

function makeRt(overrides: RtOverrides = {}) {
  return {
    id: overrides.id ?? 'rt-1',
    name: overrides.name ?? 'Secret Role Name',
    category: 'ENGINEERING',
    count: 1,
    hoursPerDay: null,
    dayRate: null,
    allocationMode: 'allocationMode' in overrides ? overrides.allocationMode : 'TIMELINE',
    globalTypeId: null,
    allocationPercent: overrides.allocationPercent ?? 100,
    allocationStartWeek: overrides.allocationStartWeek ?? null,
    allocationEndWeek: overrides.allocationEndWeek ?? null,
  }
}

interface NrOverrides {
  id?: string
  name?: string
  resourceTypeId?: string
  allocationMode?: string | null
  allocationPercent?: number | null
  allocationPct?: number | null
  allocationStartWeek?: number | null
  allocationEndWeek?: number | null
  startWeek?: number | null
  endWeek?: number | null
}

function makeNr(overrides: NrOverrides = {}) {
  return {
    id: overrides.id ?? 'nr-1',
    resourceTypeId: overrides.resourceTypeId ?? 'rt-1',
    name: overrides.name ?? 'Secret Person Name',
    startWeek: overrides.startWeek ?? null,
    endWeek: overrides.endWeek ?? null,
    allocationPct: overrides.allocationPct ?? 100,
    allocationMode: 'allocationMode' in overrides ? overrides.allocationMode : 'TIMELINE',
    allocationPercent: overrides.allocationPercent ?? 100,
    allocationStartWeek: overrides.allocationStartWeek ?? null,
    allocationEndWeek: overrides.allocationEndWeek ?? null,
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

interface StateSnapshot {
  id: string
  projectId: string
  payload: unknown
}

function makeState(snapshots: StateSnapshot[]): RemediationDatabaseState {
  return { projects: [], snapshots: snapshots.map(s => ({ id: s.id, projectId: s.projectId, snapshot: s.payload })) }
}

/** Compute the plan's own fingerprint/baseline for the fixture state and
 * combine them with the caller's reviewed counts. */
function expectedFor(state: RemediationDatabaseState, counts: Omit<SnapshotEvidenceExpected, 'fingerprint' | 'baselineStateHash'>): SnapshotEvidenceExpected {
  const plan = buildRemediationPlan(state, 'test-commit')
  return {
    fingerprint: computePlanFingerprint(plan),
    baselineStateHash: computeStateHash(state),
    ...counts,
  }
}

const CREATED_AT: Record<string, string> = {
  'snap-quarantined': '2026-06-01T00:00:00Z',
  'snap-eleven': '2026-05-20T00:00:00Z',
  'snap-seven': '2026-05-10T00:00:00Z',
  'snap-restorable': '2026-04-01T00:00:00Z',
}

function createdAtMap(state: RemediationDatabaseState): Map<string, string> {
  const map = new Map<string, string>()
  for (const snapshot of state.snapshots) {
    const iso = CREATED_AT[snapshot.id]
    if (iso) map.set(snapshot.id, iso)
  }
  return map
}

function buildReport(state: RemediationDatabaseState, counts: Omit<SnapshotEvidenceExpected, 'fingerprint' | 'baselineStateHash'>, generatedAt = '2026-08-04T00:00:00.000Z') {
  return buildSnapshotEvidenceReport({
    state,
    snapshotCreatedAtById: createdAtMap(state),
    applicationCommit: 'test-commit',
    generatedAt,
    expected: expectedFor(state, counts),
  })
}

// ─── Shared composite fixture ───────────────────────────────────────────────

function compositeState(): RemediationDatabaseState {
  return makeState([
    {
      id: 'snap-quarantined',
      projectId: PROJECT_ID,
      payload: makeV2Snapshot(
        [
          makeRt({ id: 'rt-a', allocationMode: 'CAPACITY_PLAN', allocationStartWeek: null, allocationEndWeek: null }),
          makeRt({ id: 'rt-b', allocationMode: 'CAPACITY_PLAN', allocationStartWeek: null, allocationEndWeek: null }),
        ],
        [
          // Inherited-mode windowless NamedResource Class A entry.
          makeNr({
            id: 'nr-inherited',
            resourceTypeId: 'rt-a',
            allocationMode: null,
            allocationPercent: 100,
            allocationPct: 100,
          }),
          // Valid explicit TIMELINE companion (restorable, not quarantined).
          makeNr({
            id: 'nr-timeline',
            resourceTypeId: 'rt-b',
            allocationMode: 'TIMELINE',
            allocationStartWeek: 2,
            allocationEndWeek: 9,
            startWeek: 2,
            endWeek: 9,
          }),
        ],
      ),
    },
    {
      id: 'snap-eleven',
      projectId: PROJECT_ID,
      payload: makeV2Snapshot(
        Array.from({ length: 20 }, (_, i) =>
          makeRt({ id: `rt-w-${i}`, name: `Windowless Role ${i}`, allocationMode: 'CAPACITY_PLAN' })),
        [
          // Independent defect invisible to translation errors: conflicting
          // end aliases on an inherited CAPACITY_PLAN NamedResource.
          makeNr({
            id: 'nr-conflict',
            resourceTypeId: 'rt-w-0',
            allocationMode: null,
            allocationPercent: 100,
            allocationPct: 100,
            allocationStartWeek: 5,
            allocationEndWeek: 10,
            startWeek: 5,
            endWeek: 9,
          }),
        ],
      ),
    },
    {
      id: 'snap-seven',
      projectId: PROJECT_ID,
      payload: makeV2Snapshot(
        Array.from({ length: 19 }, (_, i) =>
          makeRt({ id: `rt-s-${i}`, name: `Windowless Role ${i}`, allocationMode: 'CAPACITY_PLAN' })),
        [
          // Single -1 edge (allocationStartWeek), other edge populated with a
          // conflicting fallback alias on the -1 edge — excluded from Class B
          // by the shared predicate, decision message "single -1/negative…".
          makeNr({
            id: 'nr-minus-one',
            resourceTypeId: 'rt-s-0',
            allocationMode: 'CAPACITY_PLAN',
            allocationPercent: 100,
            allocationPct: 100,
            allocationStartWeek: -1,
            allocationEndWeek: 5,
            startWeek: 5,
            endWeek: null,
          }),
        ],
      ),
    },
    {
      id: 'snap-restorable',
      projectId: PROJECT_ID,
      payload: makeV2Snapshot(
        [makeRt({ id: 'rt-t', allocationMode: 'TIMELINE', allocationStartWeek: 0, allocationEndWeek: 10 })],
        [],
      ),
    },
  ])
}

const COMPOSITE_COUNTS: Omit<SnapshotEvidenceExpected, 'fingerprint' | 'baselineStateHash'> = {
  quarantinedEntries: 3,
  quarantinedSnapshots: 1,
  defectSnapshots: 2,
  windowlessDecisions: 39,
  singleMinusOneDecisions: 1,
  snapshotDecisions: 40,
  liveDecisions: 0,
  unsupported: 0,
  rewriteOperations: 0,
  topology11WindowlessDecisions: 20,
  topology7WindowlessDecisions: 19,
  topology7SingleMinusOneDecisions: 1,
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('percentCategory buckets', () => {
  it('maps every bucket boundary', () => {
    expect(percentCategory(null)).toBe('absent-null')
    expect(percentCategory(undefined)).toBe('absent-null')
    expect(percentCategory(0)).toBe('zero')
    expect(percentCategory(1)).toBe('one-to-ninety-nine')
    expect(percentCategory(50)).toBe('one-to-ninety-nine')
    expect(percentCategory(99)).toBe('one-to-ninety-nine')
    expect(percentCategory(100)).toBe('hundred')
    expect(percentCategory(101)).toBe('above-hundred')
    expect(percentCategory(Number.NaN)).toBe('invalid-non-finite')
    expect(percentCategory(Number.POSITIVE_INFINITY)).toBe('invalid-non-finite')
  })
})

describe('snapshotEraCategory', () => {
  it('groups by the reviewed writer-era boundaries and unavailable', () => {
    expect(snapshotEraCategory('2026-05-04T23:59:59Z')).toBe('before-2026-05-05')
    expect(snapshotEraCategory('2026-05-05T00:00:00Z')).toBe('2026-05-05-to-2026-07-13')
    expect(snapshotEraCategory('2026-07-13T23:59:59Z')).toBe('2026-05-05-to-2026-07-13')
    expect(snapshotEraCategory('2026-07-14T00:00:00Z')).toBe('2026-07-14-or-later')
    expect(snapshotEraCategory(null)).toBe('unavailable')
    expect(snapshotEraCategory('not-a-date')).toBe('unavailable')
  })
})

describe('isExpectedBoundaryShape', () => {
  const base: SnapshotEvidenceExpected = {
    fingerprint: 'a'.repeat(64),
    baselineStateHash: 'b'.repeat(64),
    quarantinedEntries: 574, quarantinedSnapshots: 49, defectSnapshots: 18,
    windowlessDecisions: 359, singleMinusOneDecisions: 7, snapshotDecisions: 366,
    liveDecisions: 130, unsupported: 0, rewriteOperations: 0,
    topology11WindowlessDecisions: 226, topology7WindowlessDecisions: 133,
    topology7SingleMinusOneDecisions: 7,
  }
  it('accepts the reviewed shape', () => {
    expect(isExpectedBoundaryShape(base)).toBe(true)
  })
  it('rejects bad hashes, missing fields and non-integers', () => {
    expect(isExpectedBoundaryShape({ ...base, fingerprint: 'zz' })).toBe(false)
    expect(isExpectedBoundaryShape({ ...base, baselineStateHash: 'Z'.repeat(64) })).toBe(false)
    expect(isExpectedBoundaryShape({ ...base, quarantinedEntries: 574.5 })).toBe(false)
    const missing = { ...base }
    delete (missing as Partial<SnapshotEvidenceExpected>).fingerprint
    expect(isExpectedBoundaryShape(missing)).toBe(false)
    expect(isExpectedBoundaryShape(null)).toBe(false)
    expect(isExpectedBoundaryShape('nope')).toBe(false)
  })
})

describe('classifySnapshotEvidence', () => {
  it('throws controlled errors for unsupported versions and malformed payloads', () => {
    expect(() => classifySnapshotEvidence({ schemaVersion: 99, epics: [] }, PROJECT_ID))
      .toThrowError(SnapshotEvidenceError)
    expect(() => classifySnapshotEvidence('not-an-object', PROJECT_ID))
      .toThrowError(SnapshotEvidenceError)
  })
})

describe('buildSnapshotEvidenceReport — composite fixture', () => {
  const state = compositeState()

  it('reconciles the reviewed boundary, topology and policyDecision', () => {
    const report = buildReport(state, COMPOSITE_COUNTS)
    expect(report.integrityResult.reconciliationPassed).toBe(true)
    expect(report.integrityResult.fingerprintMatch).toBe(true)
    expect(report.integrityResult.baselineMatch).toBe(true)
    expect(report.policyDecision).toBe('not-assessed')
    expect(report.formatVersion).toBe(1)
    expect(report.topology).toMatchObject({
      quarantinedSnapshots: 1,
      defectSnapshots: 2,
      windowlessDecisions: 39,
      singleMinusOneDecisions: 1,
      snapshotDecisions: 40,
      liveDecisions: 0,
      elevenSnapshotSubgroup: { snapshots: 1, windowlessDecisions: 20 },
      sevenSnapshotSubgroup: { snapshots: 1, windowlessDecisions: 19, singleMinusOneDecisions: 1, totalDecisions: 20 },
      quarantinedFindingsWithDecisionOrOperationIds: 0,
    })
    expect(report.observedBoundary.snapshotPopulation).toEqual({
      totalSnapshots: 4, restorable: 1, quarantined: 1, defect: 2,
    })
  })

  it('reports the S entry with the raw -1 field, alias state and mode source', () => {
    const report = buildReport(state, COMPOSITE_COUNTS)
    expect(report.singleNegativeEntries).toHaveLength(1)
    const s = report.singleNegativeEntries[0]!
    expect(s.label).toBe('S1')
    expect(s.entryKind).toBe('namedResource')
    expect(s.minusOneField).toBe('allocationStartWeek')
    expect(s.alternateAliasState).toBe('conflicting')
    expect(s.rawMode).toBe('CAPACITY_PLAN')
    expect(s.parentMode).toBe('CAPACITY_PLAN')
    expect(s.effectiveMode).toBe('CAPACITY_PLAN')
    expect(s.modeSource).toBe('explicit')
    expect(s.allocationPercentCategory).toBe('hundred')
    expect(s.allocationPctCategory).toBe('hundred')
    expect(s.entryErrorCategories).toContain('negative-one-window-value')
    // The translated profile carries the -1 window edge, so the defect has
    // both entry-level and structural evidence.
    expect(s.independentDefect).toBe('both')
  })

  it('reports the M records with subgroup, decision counts and defect categories', () => {
    const report = buildReport(state, COMPOSITE_COUNTS)
    expect(report.defectSnapshots).toHaveLength(2)
    const eleven = report.defectSnapshots.find(m => m.subgroup === 'eleven-windowless-only')!
    const seven = report.defectSnapshots.find(m => m.subgroup === 'seven-single-minus-one')!
    expect(eleven.windowlessDecisionCount).toBe(20)
    expect(eleven.singleMinusOneDecisionCount).toBe(0)
    expect(eleven.entryErrorCategories['alias-conflict']).toBe(1)
    expect(eleven.independentDefect).toBe('entry-level')
    expect(seven.windowlessDecisionCount).toBe(19)
    expect(seven.singleMinusOneDecisionCount).toBe(1)
    expect(seven.entryErrorCategories['negative-one-window-value']).toBe(1)
    // The translated profile carries the -1 window edge, so the snapshot has
    // BOTH entry-level and structural evidence of the same defect.
    expect(seven.independentDefect).toBe('both')
  })

  it('aggregates Class A entries by owner kind, mode source, era and alias shape', () => {
    const report = buildReport(state, COMPOSITE_COUNTS)
    expect(report.classAAggregates.totalEntries).toBe(3)
    expect(report.classAAggregates.totalSnapshots).toBe(1)
    expect(report.classAAggregates.byOwnerKind).toEqual({ resourceType: 2, namedResource: 1, unavailable: 0 })
    expect(report.classAAggregates.byNamedModeSource).toEqual({ explicit: 0, inherited: 1, other: 0, unavailable: 0 })
    expect(report.classAAggregates.percentageByCategory.inherited.allocationPercent.hundred).toBe(1)
    expect(report.classAAggregates.percentageByCategory.resourceType.allocationPercent.hundred).toBe(2)
    expect(report.classAAggregates.aliasShapes).toEqual({
      primaryAbsentNull: 3, fallbackAbsentNull: 1, populatedAgreeing: 0, conflicting: 0, unavailable: 0,
    })
    expect(report.classAAggregates.snapshotsByOwnerKindMix).toEqual({ resourceTypeOnly: 0, namedResourceOnly: 0, mixed: 1 })
    expect(report.classAAggregates.entriesByEra['2026-05-05-to-2026-07-13']).toBe(3)
    expect(report.classAAggregates.snapshotsByEra['2026-05-05-to-2026-07-13']).toBe(1)
  })

  it('redacts every seeded identifier, name and payload', () => {
    const report = buildReport(state, COMPOSITE_COUNTS)
    const json = JSON.stringify(report)
    const markdown = renderSnapshotEvidenceMarkdown(report)
    for (const secret of [
      'project-secret-42',
      'snap-quarantined',
      'snap-eleven',
      'snap-seven',
      'rt-a', 'rt-b', 'rt-w-0', 'rt-s-0', 'rt-t',
      'nr-inherited', 'nr-timeline', 'nr-conflict', 'nr-minus-one',
      'Secret Role Name', 'Secret Person Name', 'Windowless Role',
      'snapshot-v2-role', 'snapshot-v2-named',
    ]) {
      expect(json).not.toContain(secret)
      expect(markdown).not.toContain(secret)
    }
    expect(json).not.toContain('"snapshotId"')
    expect(json).not.toContain('"projectId"')
    expect(json).not.toContain('"ownerId"')
    expect(json).not.toContain('"entryId"')
  })

  it('is deterministic: identical runs produce identical JSON and Markdown', () => {
    const first = buildReport(state, COMPOSITE_COUNTS)
    const second = buildReport(state, COMPOSITE_COUNTS)
    expect(JSON.stringify(first)).toBe(JSON.stringify(second))
    expect(renderSnapshotEvidenceMarkdown(first)).toBe(renderSnapshotEvidenceMarkdown(second))
  })

  it('keeps JSON and Markdown in parity (Markdown renders the same object)', () => {
    const report = buildReport(state, COMPOSITE_COUNTS)
    const markdown = renderSnapshotEvidenceMarkdown(report)
    expect(markdown).toContain('quarantinedSnapshots: 1')
    expect(markdown).toContain('defectSnapshots: 2')
    expect(markdown).toContain('windowlessDecisions: 39')
    expect(markdown).toContain('singleMinusOneDecisions: 1')
    expect(markdown).toContain('policyDecision: not-assessed')
    expect(markdown).toContain('M1')
    expect(markdown).toContain('S1')
    expect(markdown).toContain('This report is evidence only.')
  })

  it('fails closed on fingerprint mismatch without policy involvement', () => {
    const counts = { ...COMPOSITE_COUNTS }
    const plan = buildRemediationPlan(state, 'test-commit')
    const report = buildSnapshotEvidenceReport({
      state,
      snapshotCreatedAtById: createdAtMap(state),
      applicationCommit: 'test-commit',
      generatedAt: '2026-08-04T00:00:00.000Z',
      expected: {
        fingerprint: 'f'.repeat(64),
        baselineStateHash: computeStateHash(state),
        ...counts,
      },
    })
    expect(report.integrityResult.fingerprintMatch).toBe(false)
    expect(report.integrityResult.reconciliationPassed).toBe(false)
    void plan
  })

  it('fails closed on baseline mismatch', () => {
    const report = buildSnapshotEvidenceReport({
      state,
      snapshotCreatedAtById: createdAtMap(state),
      applicationCommit: 'test-commit',
      generatedAt: '2026-08-04T00:00:00.000Z',
      expected: {
        fingerprint: computePlanFingerprint(buildRemediationPlan(state, 'test-commit')),
        baselineStateHash: '0'.repeat(64),
        ...COMPOSITE_COUNTS,
      },
    })
    expect(report.integrityResult.baselineMatch).toBe(false)
    expect(report.integrityResult.reconciliationPassed).toBe(false)
  })

  it('fails closed on count mismatch', () => {
    const report = buildReport(state, { ...COMPOSITE_COUNTS, windowlessDecisions: 999 })
    expect(report.integrityResult.countsMatch).toBe(false)
    expect(report.integrityResult.reconciliationPassed).toBe(false)
  })
})

describe('all four raw -1 orientations', () => {
  const orientationCases: Array<{ name: string; nr: ReturnType<typeof makeNr>; field: string; aliasState: string }> = [
    {
      name: 'startWeek',
      nr: makeNr({ resourceTypeId: 'rt-o', allocationMode: 'CAPACITY_PLAN', allocationStartWeek: null, startWeek: -1, allocationEndWeek: 4, endWeek: 5 }),
      field: 'startWeek',
      aliasState: 'conflicting',
    },
    {
      name: 'endWeek',
      nr: makeNr({ resourceTypeId: 'rt-o', allocationMode: 'CAPACITY_PLAN', allocationStartWeek: 4, startWeek: 5, allocationEndWeek: null, endWeek: -1 }),
      field: 'endWeek',
      aliasState: 'conflicting',
    },
    {
      name: 'allocationStartWeek',
      nr: makeNr({ resourceTypeId: 'rt-o', allocationMode: 'CAPACITY_PLAN', allocationStartWeek: -1, startWeek: 5, allocationEndWeek: 5, endWeek: null }),
      field: 'allocationStartWeek',
      aliasState: 'conflicting',
    },
    {
      name: 'allocationEndWeek',
      nr: makeNr({ resourceTypeId: 'rt-o', allocationMode: 'CAPACITY_PLAN', allocationStartWeek: 5, startWeek: null, allocationEndWeek: -1, endWeek: 5 }),
      field: 'allocationEndWeek',
      aliasState: 'conflicting',
    },
  ]

  for (const { name, nr, field, aliasState } of orientationCases) {
    it(`reports the -1 field for orientation ${name}`, () => {
      const state = makeState([{
        id: `snap-${name}`,
        projectId: PROJECT_ID,
        payload: makeV2Snapshot(
          // Valid windowed parent (no windowless decision of its own).
          [makeRt({ id: 'rt-o', allocationMode: 'TIMELINE', allocationStartWeek: 0, allocationEndWeek: 5 })],
          [nr],
        ),
      }])
      const counts: Omit<SnapshotEvidenceExpected, 'fingerprint' | 'baselineStateHash'> = {
        quarantinedEntries: 0, quarantinedSnapshots: 0, defectSnapshots: 1,
        windowlessDecisions: 0, singleMinusOneDecisions: 1, snapshotDecisions: 1,
        liveDecisions: 0, unsupported: 0, rewriteOperations: 0,
        topology11WindowlessDecisions: 0, topology7WindowlessDecisions: 0,
        topology7SingleMinusOneDecisions: 1,
      }
      const report = buildReport(state, counts)
      expect(report.integrityResult.reconciliationPassed).toBe(true)
      expect(report.singleNegativeEntries).toHaveLength(1)
      const s = report.singleNegativeEntries[0]!
      expect(s.minusOneField).toBe(field)
      expect(s.alternateAliasState).toBe(aliasState)
      expect(s.modeSource).toBe('explicit')
    })
  }

  it('a clean -1+null shape is a windowless decision, not a single-negative decision', () => {
    // Empirical contract: the plan-level classifier checks the null edge
    // before the negative edge, so a -1+null entry carries the windowless
    // message. The evidence command must report it as such.
    const state = makeState([{
      id: 'snap-minus-one-null',
      projectId: PROJECT_ID,
      payload: makeV2Snapshot(
        // Valid windowed parent so the NamedResource is not an orphan.
        [makeRt({ id: 'rt-1', allocationMode: 'TIMELINE', allocationStartWeek: 0, allocationEndWeek: 5 })],
        [makeNr({ allocationMode: 'CAPACITY_PLAN', allocationStartWeek: null, startWeek: -1, allocationEndWeek: null, endWeek: null })],
      ),
    }])
    const counts: Omit<SnapshotEvidenceExpected, 'fingerprint' | 'baselineStateHash'> = {
      quarantinedEntries: 0, quarantinedSnapshots: 0, defectSnapshots: 1,
      windowlessDecisions: 1, singleMinusOneDecisions: 0, snapshotDecisions: 1,
      liveDecisions: 0, unsupported: 0, rewriteOperations: 0,
      topology11WindowlessDecisions: 1, topology7WindowlessDecisions: 0,
      topology7SingleMinusOneDecisions: 0,
    }
    const report = buildReport(state, counts)
    expect(report.integrityResult.reconciliationPassed).toBe(true)
    expect(report.singleNegativeEntries).toHaveLength(0)
    expect(report.topology.windowlessDecisions).toBe(1)
    expect(report.defectSnapshots[0]!.windowlessDecisionCount).toBe(1)
  })
})

describe('structural defect classification', () => {
  it('classifies a duplicate-owner structural defect as structural', () => {
    const state = makeState([{
      id: 'snap-dup',
      projectId: PROJECT_ID,
      payload: makeV2Snapshot(
        [
          makeRt({ id: 'rt-dupe', allocationMode: 'CAPACITY_PLAN', allocationStartWeek: 0, allocationEndWeek: 5 }),
          makeRt({ id: 'rt-dupe', allocationMode: 'CAPACITY_PLAN', allocationStartWeek: 1, allocationEndWeek: 6 }),
        ],
        [],
      ),
    }])
    const counts: Omit<SnapshotEvidenceExpected, 'fingerprint' | 'baselineStateHash'> = {
      quarantinedEntries: 0, quarantinedSnapshots: 0, defectSnapshots: 1,
      windowlessDecisions: 0, singleMinusOneDecisions: 0, snapshotDecisions: 0,
      liveDecisions: 0, unsupported: 0, rewriteOperations: 0,
      topology11WindowlessDecisions: 0, topology7WindowlessDecisions: 0,
      topology7SingleMinusOneDecisions: 0,
    }
    const report = buildReport(state, counts)
    expect(report.integrityResult.reconciliationPassed).toBe(true)
    const m = report.defectSnapshots[0]!
    expect(m.independentDefect).toBe('structural')
    expect(m.structuralErrorCategories['duplicate-owner']).toBe(1)
  })
})
