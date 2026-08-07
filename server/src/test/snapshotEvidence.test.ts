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

import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { main } from '../scripts/generateSnapshotEvidence.js'
import {
  buildSnapshotEvidenceReport,
  buildSingleNegativeEvidenceEntry,
  classifyAllSnapshots,
  classifySnapshotEvidence,
  companionModeSourceCategory,
  correlateSingleNegativeDecisions,
  isExpectedBoundaryShape,
  percentCategory,
  renderSnapshotEvidenceMarkdown,
  sanitizeMode,
  snapshotEraCategory,
  SnapshotEvidenceError,
  type SnapshotEvidenceExpected,
} from '../lib/snapshotEvidence.js'
import { publishEvidenceOutputs } from '../lib/evidenceOutputPublication.js'
import {
  buildRemediationPlan,
  computePlanFingerprint,
  computeStateHash,
  type PlanDecisionEntry,
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
  // Issue #444: V2 snapshots are deliberately retired, so no snapshot is
  // classified quarantined and every V2 snapshot counts as non-restorable.
  quarantinedEntries: 0,
  quarantinedSnapshots: 0,
  defectSnapshots: 4,
  windowlessDecisions: 41,
  singleMinusOneDecisions: 1,
  snapshotDecisions: 42,
  liveDecisions: 0,
  unsupported: 0,
  rewriteOperations: 0,
  topology11Snapshots: 3,
  topology7Snapshots: 1,
  topology11WindowlessDecisions: 22,
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
    topology11Snapshots: 11, topology7Snapshots: 7,
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
    expect(isExpectedBoundaryShape({ ...base, topology11Snapshots: 11.5 })).toBe(false)
    expect(isExpectedBoundaryShape({ ...base, topology7Snapshots: -1 })).toBe(false)
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
    expect(report.formatVersion).toBe(2)
    expect(report.topology).toMatchObject({
      quarantinedSnapshots: 0,
      defectSnapshots: 4,
      windowlessDecisions: 41,
      singleMinusOneDecisions: 1,
      snapshotDecisions: 42,
      liveDecisions: 0,
      elevenSnapshotSubgroup: { snapshots: 3, windowlessDecisions: 22 },
      sevenSnapshotSubgroup: { snapshots: 1, windowlessDecisions: 19, singleMinusOneDecisions: 1, totalDecisions: 20 },
      quarantinedFindingsWithDecisionOrOperationIds: 0,
    })
    expect(report.observedBoundary.snapshotPopulation).toEqual({
      // Issue #444: all four fixture snapshots are V2 — deliberately retired
      // and therefore non-restorable (counted under defect here).
      totalSnapshots: 4, restorable: 0, quarantined: 0, defect: 4,
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
    // Issue #444: every V2 snapshot is retired/non-restorable, so all four
    // fixture snapshots appear as M records.
    expect(report.defectSnapshots).toHaveLength(4)
    const eleven = report.defectSnapshots.filter(m => m.subgroup === 'eleven-windowless-only')
    const seven = report.defectSnapshots.find(m => m.subgroup === 'seven-single-minus-one')!
    expect(eleven).toHaveLength(3)
    expect(eleven.map(m => m.windowlessDecisionCount).sort((a, b) => a - b)).toEqual([0, 2, 20])
    // The 20-windowless eleven record is snap-eleven with its alias-conflict
    // NamedResource as the independent entry-level defect.
    const snapEleven = eleven.find(m => m.windowlessDecisionCount === 20)!
    expect(snapEleven.singleMinusOneDecisionCount).toBe(0)
    expect(snapEleven.entryErrorCategories['alias-conflict']).toBe(1)
    expect(snapEleven.independentDefect).toBe('entry-level')
    expect(seven.windowlessDecisionCount).toBe(19)
    expect(seven.singleMinusOneDecisionCount).toBe(1)
    expect(seven.entryErrorCategories['negative-one-window-value']).toBe(1)
    // The translated profile carries the -1 window edge, so the snapshot has
    // BOTH entry-level and structural evidence of the same defect.
    expect(seven.independentDefect).toBe('both')
  })

  it('aggregates Class A entries by owner kind, mode source, era and alias shape', () => {
    const report = buildReport(state, COMPOSITE_COUNTS)
    // Issue #444: quarantine classification is retired, so every Class A
    // aggregate is zero while remaining structurally consistent.
    expect(report.classAAggregates.totalEntries).toBe(0)
    expect(report.classAAggregates.totalSnapshots).toBe(0)
    expect(report.classAAggregates.byOwnerKind).toEqual({ resourceType: 0, namedResource: 0, unavailable: 0 })
    expect(report.classAAggregates.byNamedModeSource).toEqual({ explicit: 0, inherited: 0, other: 0, unavailable: 0 })
    expect(report.classAAggregates.percentageByCategory.inherited.allocationPercent.hundred).toBe(0)
    expect(report.classAAggregates.percentageByCategory.resourceType.allocationPercent.hundred).toBe(0)
    expect(report.classAAggregates.aliasShapes).toEqual({
      primaryAbsentNull: 0, fallbackAbsentNull: 0, populatedAgreeing: 0, conflicting: 0, unavailable: 0,
    })
    expect(report.classAAggregates.snapshotsByOwnerKindMix).toEqual({ resourceTypeOnly: 0, namedResourceOnly: 0, mixed: 0 })
    expect(report.classAAggregates.entriesByEra['2026-05-05-to-2026-07-13']).toBe(0)
    expect(report.classAAggregates.snapshotsByEra['2026-05-05-to-2026-07-13']).toBe(0)
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
    expect(markdown).toContain('quarantinedSnapshots: 0')
    expect(markdown).toContain('defectSnapshots: 4')
    expect(markdown).toContain('windowlessDecisions: 41')
    expect(markdown).toContain('singleMinusOneDecisions: 1')
    expect(markdown).toContain('policyDecision: not-assessed')
    expect(markdown).toContain('M1')
    expect(markdown).toContain('S1')
    expect(markdown).toContain('This report is evidence only.')
  })

  it('Markdown carries every required Issue #432/#430 evidence category', () => {
    const report = buildReport(state, COMPOSITE_COUNTS)
    const markdown = renderSnapshotEvidenceMarkdown(report)
    // Topology snapshot and decision counts for both subgroups (issue #444:
    // all four V2 snapshots are retired/non-restorable).
    expect(markdown).toContain('11-snapshot subgroup: 3 snapshots, 22 windowless decisions')
    expect(markdown).toContain('7-snapshot subgroup: 1 snapshots, 19 windowless + 1 single-(-1) = 20 total decisions')
    // S records: entry errors AND structural errors, modes, percentages, defect class,
    // sanitized window-field states and per-edge conflict evidence.
    const sRow = markdown.split('\n').find(line => line.startsWith('S1 |'))!
    expect(sRow).toContain('negative-one-window-value')
    expect(sRow).toContain('profile-window')
    expect(sRow).toContain('CAPACITY_PLAN')
    expect(sRow).toContain('allocationStartWeek:minus-one')
    expect(sRow).toContain('allocationEndWeek:populated')
    expect(sRow).toContain('startWeek:populated')
    expect(sRow).toContain('endWeek:absent-null')
    expect(sRow).toContain('| yes | no |')
    expect(markdown).toContain('## Single-negative decision entries')
    expect(markdown).not.toContain('Single -1 + null')
    // Class A affected-snapshot aggregates render in Markdown.
    expect(markdown).toContain('affectedSnapshotsByOwnerKind:')
    expect(markdown).toContain('affectedSnapshotsByNamedModeSource:')
    expect(sRow).toContain('hundred')
    expect(sRow).toContain('both')
    // M records: other decision reasons column plus entry/structural categories.
    expect(markdown).toContain('Other decision reasons')
    expect(markdown).toContain('alias-conflict:1')
    // Class A percentage evidence section still renders every category row
    // (all buckets are zero under the retired-quarantine policy).
    expect(markdown).toContain('### Class A percentage evidence (by owner kind / mode source)')
    expect(markdown).toContain('| Category | allocationPercent buckets | allocationPct buckets |')
    for (const category of ['resourceType', 'explicit', 'inherited', 'other', 'unavailable']) {
      expect(markdown).toContain(`${category} |`)
    }
    // JSON carries the same categories (parity over the same evidence object).
    const json = JSON.stringify(report)
    expect(json).toContain('profile-window')
    expect(json).toContain('"windowFields"')
    expect(json).toContain('"aliasConflicts"')
    expect(json).toContain('"affectedSnapshotsByOwnerKind"')
    expect(json).toContain('"affectedSnapshotsByNamedModeSource"')
    expect(json).toContain('alias-conflict')
    expect(json).toContain('percentageByCategory')
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
  const orientationCases: Array<{
    name: string
    nr: ReturnType<typeof makeNr>
    field: string
    aliasState: string
    startEdge: boolean
    endEdge: boolean
    windowFields: Record<string, string>
  }> = [
    {
      name: 'startWeek',
      nr: makeNr({ resourceTypeId: 'rt-o', allocationMode: 'CAPACITY_PLAN', allocationStartWeek: null, startWeek: -1, allocationEndWeek: 4, endWeek: 5 }),
      field: 'startWeek',
      aliasState: 'conflicting',
      startEdge: false,
      endEdge: true,
      windowFields: { allocationStartWeek: 'absent-null', allocationEndWeek: 'populated', startWeek: 'minus-one', endWeek: 'populated' },
    },
    {
      name: 'endWeek',
      nr: makeNr({ resourceTypeId: 'rt-o', allocationMode: 'CAPACITY_PLAN', allocationStartWeek: 4, startWeek: 5, allocationEndWeek: null, endWeek: -1 }),
      field: 'endWeek',
      aliasState: 'conflicting',
      startEdge: true,
      endEdge: false,
      windowFields: { allocationStartWeek: 'populated', allocationEndWeek: 'absent-null', startWeek: 'populated', endWeek: 'minus-one' },
    },
    {
      name: 'allocationStartWeek',
      nr: makeNr({ resourceTypeId: 'rt-o', allocationMode: 'CAPACITY_PLAN', allocationStartWeek: -1, startWeek: 5, allocationEndWeek: 5, endWeek: null }),
      field: 'allocationStartWeek',
      aliasState: 'conflicting',
      startEdge: true,
      endEdge: false,
      windowFields: { allocationStartWeek: 'minus-one', allocationEndWeek: 'populated', startWeek: 'populated', endWeek: 'absent-null' },
    },
    {
      name: 'allocationEndWeek',
      nr: makeNr({ resourceTypeId: 'rt-o', allocationMode: 'CAPACITY_PLAN', allocationStartWeek: 5, startWeek: null, allocationEndWeek: -1, endWeek: 5 }),
      field: 'allocationEndWeek',
      aliasState: 'conflicting',
      startEdge: false,
      endEdge: true,
      windowFields: { allocationStartWeek: 'populated', allocationEndWeek: 'minus-one', startWeek: 'absent-null', endWeek: 'populated' },
    },
  ]

  for (const { name, nr, field, aliasState, startEdge, endEdge, windowFields } of orientationCases) {
    it(`reports the -1 field, all four field states and per-edge conflicts for orientation ${name}`, () => {
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
        topology11Snapshots: 0, topology7Snapshots: 1,
        topology11WindowlessDecisions: 0, topology7WindowlessDecisions: 0,
        topology7SingleMinusOneDecisions: 1,
      }
      const report = buildReport(state, counts)
      expect(report.integrityResult.reconciliationPassed).toBe(true)
      expect(report.singleNegativeEntries).toHaveLength(1)
      const s = report.singleNegativeEntries[0]!
      expect(s.minusOneField).toBe(field)
      expect(s.windowFields).toEqual(windowFields)
      expect(s.aliasConflicts).toEqual({ startEdge, endEdge })
      expect(s.alternateAliasState).toBe(aliasState)
      expect(s.modeSource).toBe('explicit')
      // The sanitized field-state object never carries raw numeric values.
      expect(JSON.stringify(s.windowFields)).not.toMatch(/\d/)
      expect(JSON.stringify(s.windowFields)).not.toContain('-1')
    })
  }

  it('reports a clean single -1 shape as a single-negative decision and S record (issue #444)', () => {
    // Issue #444: the quarantine gate is retired, so a clean single -1
    // shape (no populated alias on the -1 edge, agreeing/absent aliases on
    // the other edge) becomes a plan single-negative decision and the
    // evidence command emits one S record with no alias conflicts.
    const state = makeState([{
      id: 'snap-class-b',
      projectId: PROJECT_ID,
      payload: makeV2Snapshot(
        [makeRt({ id: 'rt-o', allocationMode: 'TIMELINE', allocationStartWeek: 0, allocationEndWeek: 5 })],
        [makeNr({ resourceTypeId: 'rt-o', allocationMode: 'CAPACITY_PLAN', allocationStartWeek: -1, startWeek: null, allocationEndWeek: 5, endWeek: null })],
      ),
    }])
    const counts: Omit<SnapshotEvidenceExpected, 'fingerprint' | 'baselineStateHash'> = {
      quarantinedEntries: 0, quarantinedSnapshots: 0, defectSnapshots: 1,
      windowlessDecisions: 0, singleMinusOneDecisions: 1, snapshotDecisions: 1,
      liveDecisions: 0, unsupported: 0, rewriteOperations: 0,
      topology11Snapshots: 0, topology7Snapshots: 1,
      topology11WindowlessDecisions: 0, topology7WindowlessDecisions: 0,
      topology7SingleMinusOneDecisions: 1,
    }
    const report = buildReport(state, counts)
    expect(report.integrityResult.reconciliationPassed).toBe(true)
    expect(report.singleNegativeEntries).toHaveLength(1)
    const s = report.singleNegativeEntries[0]!
    expect(s.minusOneField).toBe('allocationStartWeek')
    expect(s.windowFields).toEqual({
      allocationStartWeek: 'minus-one',
      allocationEndWeek: 'populated',
      startWeek: 'absent-null',
      endWeek: 'absent-null',
    })
    expect(s.aliasConflicts).toEqual({ startEdge: false, endEdge: false })
  })

  it('distinguishes a start-edge conflict from an end-edge conflict', () => {
    const state = makeState([{
      id: 'snap-edge-conflicts',
      projectId: PROJECT_ID,
      payload: makeV2Snapshot(
        [makeRt({ id: 'rt-o', allocationMode: 'TIMELINE', allocationStartWeek: 0, allocationEndWeek: 5 })],
        [
          // Start edge: primary -1 vs populated fallback 7 → start conflict.
          makeNr({ id: 'nr-start-conflict', resourceTypeId: 'rt-o', allocationMode: 'CAPACITY_PLAN', allocationStartWeek: -1, startWeek: 7, allocationEndWeek: 5, endWeek: null }),
          // End edge: populated primary 5 vs fallback 9 → end conflict.
          makeNr({ id: 'nr-end-conflict', resourceTypeId: 'rt-o', allocationMode: 'CAPACITY_PLAN', allocationStartWeek: -1, startWeek: null, allocationEndWeek: 5, endWeek: 9 }),
        ],
      ),
    }])
    const counts: Omit<SnapshotEvidenceExpected, 'fingerprint' | 'baselineStateHash'> = {
      quarantinedEntries: 0, quarantinedSnapshots: 0, defectSnapshots: 1,
      windowlessDecisions: 0, singleMinusOneDecisions: 2, snapshotDecisions: 2,
      liveDecisions: 0, unsupported: 0, rewriteOperations: 0,
      topology11Snapshots: 0, topology7Snapshots: 1,
      topology11WindowlessDecisions: 0, topology7WindowlessDecisions: 0,
      topology7SingleMinusOneDecisions: 2,
    }
    const report = buildReport(state, counts)
    expect(report.integrityResult.reconciliationPassed).toBe(true)
    expect(report.singleNegativeEntries).toHaveLength(2)
    const startConflict = report.singleNegativeEntries.find(s => s.windowFields.startWeek === 'populated')!
    const endConflict = report.singleNegativeEntries.find(s => s.windowFields.endWeek === 'populated')!
    expect(startConflict.aliasConflicts).toEqual({ startEdge: true, endEdge: false })
    expect(endConflict.aliasConflicts).toEqual({ startEdge: false, endEdge: true })
  })

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
      topology11Snapshots: 1, topology7Snapshots: 0,
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

describe('sanitizeMode', () => {
  it('passes known modes, nulls absent values, maps unknown strings to other', () => {
    expect(sanitizeMode('TIMELINE')).toBe('TIMELINE')
    expect(sanitizeMode('CAPACITY_PLAN')).toBe('CAPACITY_PLAN')
    expect(sanitizeMode('EFFORT')).toBe('EFFORT')
    expect(sanitizeMode('FULL_PROJECT')).toBe('FULL_PROJECT')
    expect(sanitizeMode(null)).toBe(null)
    expect(sanitizeMode(undefined)).toBe(null)
    expect(sanitizeMode('TOTALLY-BOGUS-MODE-SECRET-1')).toBe('other')
    expect(sanitizeMode('')).toBe('other')
  })
})

describe('subgroup snapshot-count gating', () => {
  function subgroupMismatchState(): RemediationDatabaseState {
    // 10 eleven-subgroup snapshots (1 windowless RT + 1 alias-conflict NR
    // each) + 8 seven-subgroup snapshots (1 windowless RT + 1 single-`-1`
    // NR each) = 18 defect snapshots.
    const snapshots: StateSnapshot[] = []
    for (let i = 0; i < 10; i++) {
      snapshots.push({
        id: `snap-eleven-${i}`,
        projectId: PROJECT_ID,
        payload: makeV2Snapshot(
          [makeRt({ id: `rt-e-${i}`, allocationMode: 'CAPACITY_PLAN' })],
          [makeNr({
            id: `nr-e-${i}`,
            resourceTypeId: `rt-e-${i}`,
            allocationMode: null,
            allocationStartWeek: 5,
            allocationEndWeek: 10,
            startWeek: 5,
            endWeek: 9,
          })],
        ),
      })
    }
    for (let i = 0; i < 8; i++) {
      snapshots.push({
        id: `snap-seven-${i}`,
        projectId: PROJECT_ID,
        payload: makeV2Snapshot(
          [makeRt({ id: `rt-s-${i}`, allocationMode: 'CAPACITY_PLAN' })],
          [makeNr({
            id: `nr-s-${i}`,
            resourceTypeId: `rt-s-${i}`,
            allocationMode: 'CAPACITY_PLAN',
            allocationStartWeek: -1,
            allocationEndWeek: 5,
            startWeek: 5,
            endWeek: null,
          })],
        ),
      })
    }
    return makeState(snapshots)
  }
  const SUBGROUP_COUNTS: Omit<SnapshotEvidenceExpected, 'fingerprint' | 'baselineStateHash'> = {
    quarantinedEntries: 0, quarantinedSnapshots: 0, defectSnapshots: 18,
    windowlessDecisions: 18, singleMinusOneDecisions: 8, snapshotDecisions: 26,
    liveDecisions: 0, unsupported: 0, rewriteOperations: 0,
    topology11Snapshots: 10, topology7Snapshots: 8,
    topology11WindowlessDecisions: 10, topology7WindowlessDecisions: 8,
    topology7SingleMinusOneDecisions: 8,
  }

  it('accepts matching subgroup snapshot counts', () => {
    const report = buildReport(subgroupMismatchState(), SUBGROUP_COUNTS)
    expect(report.integrityResult.reconciliationPassed).toBe(true)
    expect(report.topology.elevenSnapshotSubgroup.snapshots).toBe(10)
    expect(report.topology.sevenSnapshotSubgroup.snapshots).toBe(8)
  })

  it('refuses 10/8 observed subgroups against 11/7 expected snapshot counts even with matching decision totals', () => {
    const report = buildReport(subgroupMismatchState(), {
      ...SUBGROUP_COUNTS,
      topology11Snapshots: 11,
      topology7Snapshots: 7,
    })
    expect(report.integrityResult.reconciliationPassed).toBe(false)
    expect(report.reconciliation.details.some(d => d.includes('topology 11 subgroup snapshots') && d.includes('MISMATCH'))).toBe(true)
    expect(report.reconciliation.details.some(d => d.includes('topology 7 subgroup snapshots') && d.includes('MISMATCH'))).toBe(true)
  })

  it('refuses an expected subgroup snapshot sum inconsistent with defectSnapshots', () => {
    // Expected 10 + 9 = 19 while defectSnapshots = 18: refused even though
    // the observed 10 + 8 = 18 is internally consistent.
    const report = buildReport(subgroupMismatchState(), {
      ...SUBGROUP_COUNTS,
      topology11Snapshots: 10,
      topology7Snapshots: 9,
    })
    expect(report.integrityResult.reconciliationPassed).toBe(false)
    expect(report.reconciliation.details.some(d => d.includes('expected subgroup snapshot sum = expected defect snapshots') && d.includes('MISMATCH'))).toBe(true)
  })
})

describe('Class A affected-snapshot aggregates (issue #444 retired policy)', () => {
  /** One windowless CAPACITY_PLAN RT entry per snapshot. Under issue #444
   * the whole V2 snapshot is retired (non-restorable), so it appears as an
   * M record with a windowless decision while the Class A aggregates stay
   * zero (quarantine classification is retired). */
  function rtOnlySnapshot(id: string, windowStart: number | null = null, allocationPercent = 80): StateSnapshot {
    return {
      id,
      projectId: PROJECT_ID,
      payload: makeV2Snapshot(
        [makeRt({ id: `rt-${id}`, allocationMode: 'CAPACITY_PLAN', allocationPercent, allocationStartWeek: windowStart, allocationEndWeek: null })],
        [],
      ),
    }
  }

  /** One windowless CAPACITY_PLAN NR entry (explicit, 100/100) with a
   * windowed parent. */
  function nrOnlySnapshot(id: string): StateSnapshot {
    return {
      id,
      projectId: PROJECT_ID,
      payload: makeV2Snapshot(
        [makeRt({ id: `rt-${id}`, allocationMode: 'TIMELINE', allocationPercent: 100, allocationStartWeek: 0, allocationEndWeek: 5 })],
        [makeNr({ id: `nr-${id}`, resourceTypeId: `rt-${id}`, allocationMode: 'CAPACITY_PLAN', allocationPercent: 100, allocationPct: 100, allocationStartWeek: null, allocationEndWeek: null, startWeek: null, endWeek: null })],
      ),
    }
  }

  /** Every V2 snapshot is retired/non-restorable: one defect M record per
   * snapshot and one windowless decision per windowless entry. */
  function countsForRetired(snapshots: number, windowless: number): Omit<SnapshotEvidenceExpected, 'fingerprint' | 'baselineStateHash'> {
    return {
      quarantinedEntries: 0, quarantinedSnapshots: 0, defectSnapshots: snapshots,
      windowlessDecisions: windowless, singleMinusOneDecisions: 0, snapshotDecisions: windowless,
      liveDecisions: 0, unsupported: 0, rewriteOperations: 0,
      topology11Snapshots: snapshots, topology7Snapshots: 0,
      topology11WindowlessDecisions: windowless, topology7WindowlessDecisions: 0,
      topology7SingleMinusOneDecisions: 0,
    }
  }

  it('counts a ResourceType-only V2 snapshot as retired with zero Class A aggregates', () => {
    const state = makeState([rtOnlySnapshot('rt-a')])
    const report = buildReport(state, countsForRetired(1, 1))
    expect(report.integrityResult.reconciliationPassed).toBe(true)
    expect(report.classAAggregates.affectedSnapshotsByOwnerKind).toEqual({ resourceType: 0, namedResource: 0, unavailable: 0 })
    expect(report.classAAggregates.affectedSnapshotsByNamedModeSource).toEqual({ explicit: 0, inherited: 0, other: 0, unavailable: 0 })
    expect(report.classAAggregates.snapshotsByOwnerKindMix).toEqual({ resourceTypeOnly: 0, namedResourceOnly: 0, mixed: 0 })
    expect(report.observedBoundary.snapshotPopulation).toEqual({ totalSnapshots: 1, restorable: 0, quarantined: 0, defect: 1 })
  })

  it('treats an exact all-windowless-100% snapshot as retired, never restorable (issue #444)', () => {
    // Issue #438 previously made the EXACT all-windowless-100% shape
    // restorable. Issue #444 retires every V2 snapshot without analysis, so
    // the same payload is now non-restorable and its windowless entries are
    // plain decisions.
    const state = makeState([{
      id: 'snap-exact-a',
      projectId: PROJECT_ID,
      payload: makeV2Snapshot(
        [makeRt({ id: 'rt-a1', allocationMode: 'CAPACITY_PLAN', allocationPercent: 100, allocationStartWeek: null, allocationEndWeek: null })],
        [makeNr({ id: 'nr-a1', resourceTypeId: 'rt-a1', allocationMode: 'CAPACITY_PLAN', allocationPercent: 100, allocationPct: 100, allocationStartWeek: null, allocationEndWeek: null, startWeek: null, endWeek: null })],
      ),
    }])
    const report = buildReport(state, countsForRetired(1, 2))
    expect(report.integrityResult.reconciliationPassed).toBe(true)
    expect(report.observedBoundary.snapshotPopulation).toEqual({ totalSnapshots: 1, restorable: 0, quarantined: 0, defect: 1 })
    expect(report.classAAggregates.totalEntries).toBe(0)
    expect(report.classAAggregates.totalSnapshots).toBe(0)
    expect(report.topology.windowlessDecisions).toBe(2)
  })

  it('counts a NamedResource-only V2 snapshot as retired with zero Class A aggregates', () => {
    const state = makeState([nrOnlySnapshot('nr-a')])
    const report = buildReport(state, countsForRetired(1, 1))
    expect(report.integrityResult.reconciliationPassed).toBe(true)
    expect(report.classAAggregates.affectedSnapshotsByOwnerKind).toEqual({ resourceType: 0, namedResource: 0, unavailable: 0 })
    expect(report.classAAggregates.affectedSnapshotsByNamedModeSource).toEqual({ explicit: 0, inherited: 0, other: 0, unavailable: 0 })
    expect(report.classAAggregates.snapshotsByOwnerKindMix).toEqual({ resourceTypeOnly: 0, namedResourceOnly: 0, mixed: 0 })
  })

  it('counts a mixed ResourceType/NamedResource V2 snapshot with two windowless decisions', () => {
    const state = makeState([{
      id: 'snap-mixed',
      projectId: PROJECT_ID,
      payload: makeV2Snapshot(
        [makeRt({ id: 'rt-mix', allocationMode: 'CAPACITY_PLAN', allocationPercent: 100, allocationStartWeek: null, allocationEndWeek: null })],
        [makeNr({ id: 'nr-mix', resourceTypeId: 'rt-mix', allocationMode: 'CAPACITY_PLAN', allocationPercent: 100, allocationPct: 80, allocationStartWeek: null, allocationEndWeek: null, startWeek: null, endWeek: null })],
      ),
    }])
    const report = buildReport(state, countsForRetired(1, 2))
    expect(report.integrityResult.reconciliationPassed).toBe(true)
    expect(report.classAAggregates.affectedSnapshotsByOwnerKind).toEqual({ resourceType: 0, namedResource: 0, unavailable: 0 })
    expect(report.classAAggregates.affectedSnapshotsByNamedModeSource).toEqual({ explicit: 0, inherited: 0, other: 0, unavailable: 0 })
    expect(report.classAAggregates.snapshotsByOwnerKindMix).toEqual({ resourceTypeOnly: 0, namedResourceOnly: 0, mixed: 0 })
    expect(report.topology.windowlessDecisions).toBe(2)
  })

  it('counts a snapshot with explicit and inherited NamedResource entries: two windowless decisions, zero Class A', () => {
    const state = makeState([{
      id: 'snap-both-modes',
      projectId: PROJECT_ID,
      payload: makeV2Snapshot(
        [makeRt({ id: 'rt-both', allocationMode: 'CAPACITY_PLAN', allocationPercent: 100, allocationStartWeek: null, allocationEndWeek: null })],
        [
          makeNr({ id: 'nr-explicit', resourceTypeId: 'rt-both', allocationMode: 'CAPACITY_PLAN', allocationPercent: 100, allocationPct: 100, allocationStartWeek: null, allocationEndWeek: null, startWeek: null, endWeek: null }),
          makeNr({ id: 'nr-inherited', resourceTypeId: 'rt-both', allocationMode: null, allocationPercent: 100, allocationPct: 100, allocationStartWeek: null, allocationEndWeek: null, startWeek: null, endWeek: null }),
        ],
      ),
    }])
    const report = buildReport(state, countsForRetired(1, 2))
    expect(report.integrityResult.reconciliationPassed).toBe(true)
    expect(report.classAAggregates.byNamedModeSource).toEqual({ explicit: 0, inherited: 0, other: 0, unavailable: 0 })
    expect(report.classAAggregates.affectedSnapshotsByNamedModeSource).toEqual({ explicit: 0, inherited: 0, other: 0, unavailable: 0 })
    expect(report.topology.windowlessDecisions).toBe(2)
  })

  it('counts a snapshot with genuinely unavailable NamedResource provenance as retired with no decisions', () => {
    // Null effective mode is a valid/no-action entry, so the retired
    // snapshot produces no windowless decision.
    const state = makeState([{
      id: 'snap-unavailable-provenance',
      projectId: PROJECT_ID,
      payload: makeV2Snapshot(
        [makeRt({ id: 'rt-u', allocationMode: null, allocationPercent: 100, allocationStartWeek: null, allocationEndWeek: null })],
        [makeNr({ id: 'nr-u', resourceTypeId: 'rt-u', allocationMode: null, allocationPercent: 100, allocationPct: 100, allocationStartWeek: null, allocationEndWeek: null, startWeek: null, endWeek: null })],
      ),
    }])
    const report = buildReport(state, countsForRetired(1, 0))
    expect(report.integrityResult.reconciliationPassed).toBe(true)
    expect(report.classAAggregates.totalEntries).toBe(0)
    expect(report.classAAggregates.affectedSnapshotsByNamedModeSource).toEqual({ explicit: 0, inherited: 0, other: 0, unavailable: 0 })
  })

  it('counts repeated windowless entries in one retired snapshot as decisions', () => {
    const state = makeState([{
      id: 'snap-repeated',
      projectId: PROJECT_ID,
      payload: makeV2Snapshot(
        [
          makeRt({ id: 'rt-rep-1', allocationMode: 'CAPACITY_PLAN', allocationPercent: 100, allocationStartWeek: null, allocationEndWeek: null }),
          makeRt({ id: 'rt-rep-2', allocationMode: 'CAPACITY_PLAN', allocationPercent: 80, allocationStartWeek: null, allocationEndWeek: null }),
        ],
        [],
      ),
    }])
    const report = buildReport(state, countsForRetired(1, 2))
    expect(report.integrityResult.reconciliationPassed).toBe(true)
    expect(report.classAAggregates.totalEntries).toBe(0)
    expect(report.classAAggregates.affectedSnapshotsByOwnerKind.resourceType).toBe(0)
    expect(report.classAAggregates.affectedSnapshotsByNamedModeSource).toEqual({ explicit: 0, inherited: 0, other: 0, unavailable: 0 })
    expect(report.topology.windowlessDecisions).toBe(2)
  })

  it('renders both aggregates in JSON and Markdown in parity', () => {
    const state = makeState([
      rtOnlySnapshot('rt-parity'),
      nrOnlySnapshot('nr-parity'),
    ])
    const report = buildReport(state, countsForRetired(2, 2))
    const json = JSON.stringify(report)
    const markdown = renderSnapshotEvidenceMarkdown(report)
    expect(json).toContain('"affectedSnapshotsByOwnerKind":{"resourceType":0,"namedResource":0,"unavailable":0}')
    expect(markdown).toContain('affectedSnapshotsByOwnerKind: {"resourceType":0,"namedResource":0,"unavailable":0}')
    expect(markdown).toContain('affectedSnapshotsByNamedModeSource: {"explicit":0,"inherited":0,"other":0,"unavailable":0}')
  })
})

describe('Class A companion evidence (issue #444: retired population)', () => {
  /** Comprehensive fixture: one V2 snapshot containing entries that the
   * issue #438/#440 policy previously classified as exact Class A or
   * quarantine companions. Under issue #444 the whole V2 snapshot is
   * deliberately retired, so the companion population is empty and every
   * quarantine aggregate is zero. */
  function companionState(): RemediationDatabaseState {
    return makeState([
      {
        id: 'snap-companions',
        projectId: PROJECT_ID,
        payload: makeV2Snapshot(
          [
            // Previously exact Class A ResourceType entry.
            makeRt({ id: 'rt-a', name: 'Engineers Role', allocationMode: 'CAPACITY_PLAN', allocationStartWeek: null, allocationEndWeek: null }),
            // Previously quarantine-shaped companion at 80%.
            makeRt({ id: 'rt-b', name: 'Partial Role', allocationMode: 'CAPACITY_PLAN', allocationStartWeek: null, allocationEndWeek: null, allocationPercent: 80 }),
            // Companion: windowless EFFORT at 100% (alreadyValid).
            makeRt({ id: 'rt-c', name: 'Effort Role', allocationMode: 'EFFORT', allocationStartWeek: null, allocationEndWeek: null }),
          ],
          [
            // Previously exact S shape (raw (-1,-1) alias pair with populated
            // primary end) → deterministic zero classification.
            makeNr({ id: 'nr-s', resourceTypeId: 'rt-a', name: 'Shadowed Person', allocationMode: 'CAPACITY_PLAN', allocationPercent: 100, allocationPct: 100, allocationStartWeek: null, allocationEndWeek: 5, startWeek: -1, endWeek: -1 }),
            // Companion: explicit windowed TIMELINE at 100/100 (alreadyValid).
            makeNr({ id: 'nr-tl', resourceTypeId: 'rt-c', name: 'Timeline Person', allocationMode: 'TIMELINE', allocationPercent: 100, allocationPct: 100, allocationStartWeek: 2, allocationEndWeek: 9, startWeek: 2, endWeek: 9 }),
            // Companion: inherited CAPACITY_PLAN windowless 100/100.
            makeNr({ id: 'nr-inherited', resourceTypeId: 'rt-a', name: 'Inherited Person', allocationMode: null, allocationPercent: 100, allocationPct: 100, allocationStartWeek: null, allocationEndWeek: null, startWeek: null, endWeek: null }),
            // Companion: explicit EFFORT windowless 100/100 (alreadyValid).
            makeNr({ id: 'nr-effort', resourceTypeId: 'rt-c', name: 'Effort Person', allocationMode: 'EFFORT', allocationPercent: 100, allocationPct: 100, allocationStartWeek: null, allocationEndWeek: null, startWeek: null, endWeek: null }),
          ],
        ),
      },
    ])
  }

  const COMPANION_COUNTS: Omit<SnapshotEvidenceExpected, 'fingerprint' | 'baselineStateHash'> = {
    quarantinedEntries: 0,
    quarantinedSnapshots: 0,
    defectSnapshots: 1,
    windowlessDecisions: 2,
    singleMinusOneDecisions: 0,
    snapshotDecisions: 2,
    liveDecisions: 0,
    unsupported: 0,
    rewriteOperations: 0,
    topology11Snapshots: 1,
    topology7Snapshots: 0,
    topology11WindowlessDecisions: 2,
    topology7WindowlessDecisions: 0,
    topology7SingleMinusOneDecisions: 0,
  }

  it('reports an empty companion population under the retired policy', () => {
    const report = buildReport(companionState(), COMPANION_COUNTS)
    expect(report.integrityResult.reconciliationPassed).toBe(true)
    expect(report.formatVersion).toBe(2)
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
    // The snapshot itself is retired: no quarantine findings, no restorable
    // verdict — only the two windowless entries become decisions.
    expect(report.observedBoundary.summary.quarantined).toBe(0)
    expect(report.observedBoundary.snapshotPopulation).toEqual({ totalSnapshots: 1, restorable: 0, quarantined: 0, defect: 1 })
    expect(report.topology.windowlessDecisions).toBe(2)
  })

  it('emits no companion shape rows under the retired policy', () => {
    const report = buildReport(companionState(), COMPANION_COUNTS)
    expect(report.classACompanionEvidence.shapeRows).toEqual([])
  })

  it('reports zero plan classifications and snapshot-level flags', () => {
    const report = buildReport(companionState(), COMPANION_COUNTS)
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
  })

  it('reconciles every aggregate and refuses on any mismatch via the shared gate', () => {
    const report = buildReport(companionState(), COMPANION_COUNTS)
    expect(report.integrityResult.countsMatch).toBe(true)
    expect(report.reconciliation.passed).toBe(true)
    const details = report.reconciliation.details.join('\n')
    expect(details).toContain('exact Class A entries plus companions equal captured entries: observed 0, expected 0 — OK')
    expect(details).toContain('companion by-kind totals reconcile: observed 0, expected 0 — OK')
    expect(details).toContain('companion shape-row counts reconcile: observed 0, expected 0 — OK')
    expect(details).toContain('companion plan-classification totals reconcile: observed 0, expected 0 — OK')
    expect(details).toContain('companion entries are unique: observed 0, expected 0 — OK')
    expect(details).toContain('no selected entry is omitted: observed 0, expected 0 — OK')
    expect(details).toContain('snapshot flag pair: entries windowless: observed 0, expected 0 — OK')
    expect(details).toContain('snapshot flag pair: companion inherited mode: observed 0, expected 0 — OK')
  })

  it('is deterministic across repeated runs', () => {
    const first = buildReport(companionState(), COMPANION_COUNTS)
    const second = buildReport(companionState(), COMPANION_COUNTS)
    expect(JSON.stringify(first.classACompanionEvidence)).toBe(JSON.stringify(second.classACompanionEvidence))
  })

  it('excludes every snapshot from the companion population (no quarantine selection exists)', () => {
    const state = makeState([
      {
        id: 'snap-exact',
        projectId: PROJECT_ID,
        // Previously exact all-Class-A snapshot.
        payload: makeV2Snapshot(
          [makeRt({ id: 'rt-e1', allocationMode: 'CAPACITY_PLAN', allocationStartWeek: null, allocationEndWeek: null })],
          [makeNr({ id: 'nr-e1', resourceTypeId: 'rt-e1', allocationMode: 'CAPACITY_PLAN', allocationPercent: 100, allocationPct: 100, allocationStartWeek: null, allocationEndWeek: null, startWeek: null, endWeek: null })],
        ),
      },
      {
        id: 'snap-defect',
        projectId: PROJECT_ID,
        // Independent defect (partial window).
        payload: makeV2Snapshot(
          [makeRt({ id: 'rt-d1', allocationMode: 'CAPACITY_PLAN', allocationStartWeek: 3, allocationEndWeek: null })],
          [],
        ),
      },
      {
        id: 'snap-q',
        projectId: PROJECT_ID,
        // Previously selected Class-A-quarantined snapshot with one companion.
        payload: makeV2Snapshot(
          [
            makeRt({ id: 'rt-q1', allocationMode: 'CAPACITY_PLAN', allocationStartWeek: null, allocationEndWeek: null }),
            makeRt({ id: 'rt-q2', allocationMode: 'CAPACITY_PLAN', allocationStartWeek: null, allocationEndWeek: null, allocationPercent: 80 }),
          ],
          [],
        ),
      },
    ])
    const counts: Omit<SnapshotEvidenceExpected, 'fingerprint' | 'baselineStateHash'> = {
      quarantinedEntries: 0,
      quarantinedSnapshots: 0,
      defectSnapshots: 3,
      windowlessDecisions: 5, // 2 (exact) + 1 (defect partial) + 2 (q)
      singleMinusOneDecisions: 0,
      snapshotDecisions: 5,
      liveDecisions: 0,
      unsupported: 0,
      rewriteOperations: 0,
      topology11Snapshots: 3,
      topology7Snapshots: 0,
      topology11WindowlessDecisions: 5,
      topology7WindowlessDecisions: 0,
      topology7SingleMinusOneDecisions: 0,
    }
    const report = buildReport(state, counts)
    expect(report.integrityResult.reconciliationPassed).toBe(true)
    expect(report.observedBoundary.snapshotPopulation).toEqual({ totalSnapshots: 3, restorable: 0, quarantined: 0, defect: 3 })
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
  })

  it('excludes Class-B-only and mixed Class-A/Class-B snapshots from a population that is empty anyway', () => {
    const state = makeState([
      {
        id: 'snap-b',
        projectId: PROJECT_ID,
        // Single -1 edge with non-negative other edge.
        payload: makeV2Snapshot(
          [makeRt({ id: 'rt-b1', allocationMode: 'CAPACITY_PLAN', allocationStartWeek: -1, allocationEndWeek: 5 })],
          [],
        ),
      },
      {
        id: 'snap-mixed-ab',
        projectId: PROJECT_ID,
        // Windowless + single -1 entries.
        payload: makeV2Snapshot(
          [
            makeRt({ id: 'rt-m1', allocationMode: 'CAPACITY_PLAN', allocationStartWeek: null, allocationEndWeek: null }),
            makeRt({ id: 'rt-m2', allocationMode: 'CAPACITY_PLAN', allocationStartWeek: -1, allocationEndWeek: 5 }),
          ],
          [],
        ),
      },
    ])
    const counts: Omit<SnapshotEvidenceExpected, 'fingerprint' | 'baselineStateHash'> = {
      quarantinedEntries: 0,
      quarantinedSnapshots: 0,
      defectSnapshots: 2,
      windowlessDecisions: 1,
      singleMinusOneDecisions: 2,
      snapshotDecisions: 3,
      liveDecisions: 0,
      unsupported: 0,
      rewriteOperations: 0,
      topology11Snapshots: 0,
      topology7Snapshots: 2,
      topology11WindowlessDecisions: 0,
      topology7WindowlessDecisions: 1,
      topology7SingleMinusOneDecisions: 2,
    }
    const report = buildReport(state, counts)
    // The shared gate passes: quarantine reconciliation is retired, so the
    // Class A checks are zero-matched instead of refusing.
    expect(report.integrityResult.reconciliationPassed).toBe(true)
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
    expect(report.classACompanionEvidence.shapeRows).toEqual([])
  })

  it('never selects a snapshot, so the companion correlation never runs (no ambiguity possible)', () => {
    // The retired policy cannot construct a selected quarantined snapshot,
    // so the issue #440 ambiguity path is unreachable: the report builds and
    // reconciles with an empty companion population.
    const state = makeState([{
      id: 'snap-ambig',
      projectId: PROJECT_ID,
      payload: makeV2Snapshot(
        [makeRt({ id: 'same-id', allocationMode: 'CAPACITY_PLAN', allocationStartWeek: null, allocationEndWeek: null })],
        [
          makeNr({ id: 'same-id', resourceTypeId: 'same-id', allocationMode: null, allocationPercent: 100, allocationPct: 100, allocationStartWeek: null, allocationEndWeek: null, startWeek: null, endWeek: null }),
        ],
      ),
    }])
    const counts: Omit<SnapshotEvidenceExpected, 'fingerprint' | 'baselineStateHash'> = {
      quarantinedEntries: 0,
      quarantinedSnapshots: 0,
      defectSnapshots: 1,
      windowlessDecisions: 1,
      singleMinusOneDecisions: 0,
      snapshotDecisions: 1,
      liveDecisions: 0,
      unsupported: 0,
      rewriteOperations: 0,
      topology11Snapshots: 1,
      topology7Snapshots: 0,
      topology11WindowlessDecisions: 1,
      topology7WindowlessDecisions: 0,
      topology7SingleMinusOneDecisions: 0,
    }
    const report = buildReport(state, counts)
    expect(report.integrityResult.reconciliationPassed).toBe(true)
    expect(report.classACompanionEvidence.population.totalCompanionEntries).toBe(0)
  })

  it('never emits identifiers, names, raw week values or unknown mode strings', () => {
    const state = makeState([
      {
        id: 'snap-privacy',
        projectId: PROJECT_ID,
        payload: makeV2Snapshot(
          [
            makeRt({ id: 'rt-ALPHA-SECRET-ROLE', name: 'Project Aurora Confidential Role', allocationMode: 'CAPACITY_PLAN', allocationStartWeek: null, allocationEndWeek: null }),
            makeRt({ id: 'rt-windowed', name: 'Windowed Role', allocationMode: 'EFFORT', allocationStartWeek: 17, allocationEndWeek: 23 }),
          ],
          [
            makeNr({ id: 'nr-BETA-PRIVATE-PERSON', resourceTypeId: 'rt-ALPHA-SECRET-ROLE', name: 'Project Aurora Confidential Person', allocationMode: null, allocationPercent: 100, allocationPct: 100, allocationStartWeek: null, allocationEndWeek: null, startWeek: null, endWeek: null }),
          ],
        ),
      },
      {
        id: 'snap-bogus-mode',
        projectId: PROJECT_ID,
        // Unknown mode → defect snapshot; the arbitrary string must never
        // reach either output.
        payload: makeV2Snapshot(
          [makeRt({ id: 'rt-9', allocationMode: 'WARP_DRIVE-TOP-SECRET', allocationStartWeek: 2, allocationEndWeek: 9 })],
          [],
        ),
      },
    ])
    const counts: Omit<SnapshotEvidenceExpected, 'fingerprint' | 'baselineStateHash'> = {
      quarantinedEntries: 0,
      quarantinedSnapshots: 0,
      defectSnapshots: 2,
      windowlessDecisions: 1,
      singleMinusOneDecisions: 0,
      snapshotDecisions: 1,
      liveDecisions: 0,
      unsupported: 1,
      rewriteOperations: 0,
      topology11Snapshots: 2,
      topology7Snapshots: 0,
      topology11WindowlessDecisions: 1,
      topology7WindowlessDecisions: 0,
      topology7SingleMinusOneDecisions: 0,
    }
    const report = buildReport(state, counts)
    expect(report.integrityResult.reconciliationPassed).toBe(true)
    const json = JSON.stringify(report)
    const markdown = renderSnapshotEvidenceMarkdown(report)
    const sectionJson = JSON.stringify(report.classACompanionEvidence)
    for (const secret of [
      'rt-ALPHA-SECRET-ROLE', 'nr-BETA-PRIVATE-PERSON',
      'Project Aurora Confidential Role', 'Project Aurora Confidential Person',
      'snap-privacy', 'WARP_DRIVE-TOP-SECRET', 'snap-bogus-mode',
    ]) {
      expect(json).not.toContain(secret)
      expect(markdown).not.toContain(secret)
    }
    expect(sectionJson).not.toContain('-1')
    expect(sectionJson).not.toContain('17')
    expect(sectionJson).not.toContain('23')
    expect(report.classACompanionEvidence.shapeRows).toEqual([])
  })

  it('mirrors the companion evidence in Markdown (JSON/Markdown parity)', () => {
    const report = buildReport(companionState(), COMPANION_COUNTS)
    const markdown = renderSnapshotEvidenceMarkdown(report)
    expect(markdown).toContain('## Class A companion evidence')
    expect(markdown).toContain('### Population')
    expect(markdown).toContain('- classAQuarantinedSnapshots: 0')
    expect(markdown).toContain('- totalCompanionEntries: 0')
    expect(markdown).toContain('- excludedMixedClassABSnapshots: 0')
    expect(markdown).toContain('### Companion shape rows')
    expect(markdown).toContain('| Entry kind | Raw mode | Parent mode | Effective mode | Mode source | allocationStartWeek | allocationEndWeek | startWeek | endWeek | allocationPercent | allocationPct | Plan classification | Count |')
    expect(markdown).toContain('### Plan classifications')
    expect(markdown).toContain('- alreadyValid: 0')
    expect(markdown).toContain('- quarantined: 0')
    expect(markdown).toContain('### Snapshot-level flags')
    expect(markdown).toContain('- anyCompanionInheritedMode: 0')
    expect(markdown).toContain('- noCompanionInheritedMode: 0')
  })

  it('companionModeSourceCategory distinguishes explicit and inherited modes for all known modes', () => {
    // Explicit known raw modes.
    expect(companionModeSourceCategory('TIMELINE', null)).toBe('explicit')
    expect(companionModeSourceCategory('CAPACITY_PLAN', null)).toBe('explicit')
    expect(companionModeSourceCategory('EFFORT', null)).toBe('explicit')
    expect(companionModeSourceCategory('FULL_PROJECT', null)).toBe('explicit')
    expect(companionModeSourceCategory('TIMELINE', 'WARP_DRIVE')).toBe('explicit')
    // Inherited known parent modes (including the non-CAPACITY_PLAN case).
    expect(companionModeSourceCategory(null, 'TIMELINE')).toBe('inherited')
    expect(companionModeSourceCategory(null, 'CAPACITY_PLAN')).toBe('inherited')
    expect(companionModeSourceCategory(null, 'EFFORT')).toBe('inherited')
    expect(companionModeSourceCategory(null, 'FULL_PROJECT')).toBe('inherited')
    expect(companionModeSourceCategory(undefined, 'TIMELINE')).toBe('inherited')
    // Unknown/unsupported populated sources map to other.
    expect(companionModeSourceCategory('WARP_DRIVE', null)).toBe('other')
    expect(companionModeSourceCategory(null, 'WARP_DRIVE')).toBe('other')
    // Both raw and parent modes absent → unavailable.
    expect(companionModeSourceCategory(null, null)).toBe('unavailable')
    expect(companionModeSourceCategory(undefined, undefined)).toBe('unavailable')
  })

  it('reports no companion shape rows and zero inherited flags (no selection under the retired policy)', () => {
    const state = makeState([{
      id: 'snap-modes',
      projectId: PROJECT_ID,
      payload: makeV2Snapshot(
        [
          makeRt({ id: 'rt-q', allocationMode: 'CAPACITY_PLAN', allocationStartWeek: null, allocationEndWeek: null, allocationPercent: 80 }),
          makeRt({ id: 'rt-t', name: 'Timeline Role', allocationMode: 'TIMELINE', allocationStartWeek: null, allocationEndWeek: null }),
          makeRt({ id: 'rt-e', name: 'Effort Role', allocationMode: 'EFFORT', allocationStartWeek: null, allocationEndWeek: null }),
          makeRt({ id: 'rt-f', name: 'Full Project Role', allocationMode: 'FULL_PROJECT', allocationStartWeek: null, allocationEndWeek: null }),
          makeRt({ id: 'rt-null', name: 'Null Mode Role', allocationMode: null, allocationStartWeek: null, allocationEndWeek: null }),
        ],
        [
          makeNr({ id: 'nr-inh-tl', resourceTypeId: 'rt-t', allocationMode: null }),
          makeNr({ id: 'nr-inh-eff', resourceTypeId: 'rt-e', allocationMode: null }),
          makeNr({ id: 'nr-inh-fp', resourceTypeId: 'rt-f', allocationMode: null }),
          makeNr({ id: 'nr-inh-cp', resourceTypeId: 'rt-q', allocationMode: null }),
          makeNr({ id: 'nr-exp-tl', resourceTypeId: 'rt-t', allocationMode: 'TIMELINE' }),
          makeNr({ id: 'nr-none', resourceTypeId: 'rt-null', allocationMode: null }),
        ],
      ),
    }])
    const counts: Omit<SnapshotEvidenceExpected, 'fingerprint' | 'baselineStateHash'> = {
      quarantinedEntries: 0,
      quarantinedSnapshots: 0,
      defectSnapshots: 1,
      windowlessDecisions: 1,
      singleMinusOneDecisions: 0,
      snapshotDecisions: 1,
      liveDecisions: 0,
      unsupported: 0,
      rewriteOperations: 0,
      topology11Snapshots: 1,
      topology7Snapshots: 0,
      topology11WindowlessDecisions: 1,
      topology7WindowlessDecisions: 0,
      topology7SingleMinusOneDecisions: 0,
    }
    const report = buildReport(state, counts)
    expect(report.integrityResult.reconciliationPassed).toBe(true)
    expect(report.classACompanionEvidence.shapeRows).toEqual([])
    expect(report.classACompanionEvidence.snapshotFlags.anyCompanionInheritedMode).toBe(0)
    expect(report.classACompanionEvidence.snapshotFlags.noCompanionInheritedMode).toBe(0)
  })

  it('reports zero inherited flags for a snapshot without companions', () => {
    const state = makeState([{
      id: 'snap-no-inherited',
      projectId: PROJECT_ID,
      payload: makeV2Snapshot(
        [
          makeRt({ id: 'rt-q', allocationMode: 'CAPACITY_PLAN', allocationStartWeek: null, allocationEndWeek: null, allocationPercent: 80 }),
          makeRt({ id: 'rt-t', allocationMode: 'TIMELINE', allocationStartWeek: null, allocationEndWeek: null }),
        ],
        [
          // Explicit known mode only.
          makeNr({ id: 'nr-exp', resourceTypeId: 'rt-t', allocationMode: 'TIMELINE' }),
        ],
      ),
    }])
    const counts: Omit<SnapshotEvidenceExpected, 'fingerprint' | 'baselineStateHash'> = {
      quarantinedEntries: 0,
      quarantinedSnapshots: 0,
      defectSnapshots: 1,
      windowlessDecisions: 1,
      singleMinusOneDecisions: 0,
      snapshotDecisions: 1,
      liveDecisions: 0,
      unsupported: 0,
      rewriteOperations: 0,
      topology11Snapshots: 1,
      topology7Snapshots: 0,
      topology11WindowlessDecisions: 1,
      topology7WindowlessDecisions: 0,
      topology7SingleMinusOneDecisions: 0,
    }
    const report = buildReport(state, counts)
    expect(report.integrityResult.reconciliationPassed).toBe(true)
    expect(report.classACompanionEvidence.snapshotFlags.anyCompanionInheritedMode).toBe(0)
    expect(report.classACompanionEvidence.snapshotFlags.noCompanionInheritedMode).toBe(0)
    expect(report.classACompanionEvidence.shapeRows).toEqual([])
  })
})


describe('mode redaction', () => {
  it('never emits arbitrary historical mode strings in JSON or Markdown', () => {
    const BOGUS_NR = 'TOTALLY-BOGUS-MODE-SECRET-1'
    const BOGUS_PARENT = 'BOGUS-PARENT-SECRET-2'
    const state = makeState([{
      id: 'snap-bogus',
      projectId: PROJECT_ID,
      payload: makeV2Snapshot(
        [makeRt({ id: 'rt-1', allocationMode: BOGUS_PARENT })],
        [makeNr({ id: 'nr-1', resourceTypeId: 'rt-1', allocationMode: BOGUS_NR, startWeek: 0, endWeek: 5, allocationStartWeek: 0, allocationEndWeek: 5 })],
      ),
    }])
    const counts: Omit<SnapshotEvidenceExpected, 'fingerprint' | 'baselineStateHash'> = {
      quarantinedEntries: 0, quarantinedSnapshots: 0, defectSnapshots: 1,
      windowlessDecisions: 0, singleMinusOneDecisions: 0, snapshotDecisions: 0,
      liveDecisions: 0, unsupported: 2, rewriteOperations: 0,
      topology11Snapshots: 1, topology7Snapshots: 0,
      topology11WindowlessDecisions: 0, topology7WindowlessDecisions: 0,
      topology7SingleMinusOneDecisions: 0,
    }
    const report = buildReport(state, counts)
    expect(report.integrityResult.reconciliationPassed).toBe(true)
    expect(report.defectSnapshots[0]!.unsupportedCount).toBe(2)
    expect(report.defectSnapshots[0]!.entryErrorCategories['unknown-mode']).toBe(2)
    const json = JSON.stringify(report)
    const markdown = renderSnapshotEvidenceMarkdown(report)
    expect(json).not.toContain(BOGUS_NR)
    expect(json).not.toContain(BOGUS_PARENT)
    expect(markdown).not.toContain(BOGUS_NR)
    expect(markdown).not.toContain(BOGUS_PARENT)
  })

  it('sanitizes the S record parent mode (bogus parent string becomes other)', () => {
    const BOGUS_PARENT = 'BOGUS-PARENT-SECRET-2'
    const state = makeState([{
      id: 'snap-p',
      projectId: PROJECT_ID,
      payload: makeV2Snapshot(
        [makeRt({ id: 'rt-1', allocationMode: BOGUS_PARENT })],
        [makeNr({ id: 'nr-1', resourceTypeId: 'rt-1', allocationMode: 'CAPACITY_PLAN', allocationStartWeek: -1, allocationEndWeek: 5, startWeek: 5, endWeek: null })],
      ),
    }])
    const counts: Omit<SnapshotEvidenceExpected, 'fingerprint' | 'baselineStateHash'> = {
      quarantinedEntries: 0, quarantinedSnapshots: 0, defectSnapshots: 1,
      windowlessDecisions: 0, singleMinusOneDecisions: 1, snapshotDecisions: 1,
      liveDecisions: 0, unsupported: 1, rewriteOperations: 0,
      topology11Snapshots: 0, topology7Snapshots: 1,
      topology11WindowlessDecisions: 0, topology7WindowlessDecisions: 0,
      topology7SingleMinusOneDecisions: 1,
    }
    const report = buildReport(state, counts)
    expect(report.integrityResult.reconciliationPassed).toBe(true)
    const s = report.singleNegativeEntries[0]!
    expect(s.parentMode).toBe('other')
    expect(s.effectiveMode).toBe('CAPACITY_PLAN')
    expect(JSON.stringify(report)).not.toContain(BOGUS_PARENT)
  })
})

describe('publishEvidenceOutputs', () => {
  it('publishes both files with mode 0600 and leaves no temporaries', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'evidence-pub-'))
    try {
      const json = path.join(dir, 'out.json')
      const md = path.join(dir, 'out.md')
      publishEvidenceOutputs(json, md, '{"a":1}', '# markdown')
      expect(readFileSync(json, 'utf8')).toBe('{"a":1}')
      expect(readFileSync(md, 'utf8')).toBe('# markdown')
      if (process.platform !== 'win32') {
        expect(statSync(json).mode & 0o777).toBe(0o600)
        expect(statSync(md).mode & 0o777).toBe(0o600)
      }
      expect(readdirSync(dir).sort()).toEqual(['out.json', 'out.md'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('failure while staging the second output leaves neither final output and no temporaries', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'evidence-pub-'))
    try {
      const json = path.join(dir, 'out.json')
      const md = path.join(dir, 'out.md')
      expect(() => publishEvidenceOutputs(json, md, 'json', 'md', {
        failOn: phase => { if (phase === 'stage-markdown') throw new Error('injected staging failure') },
      })).toThrow('injected staging failure')
      expect(readdirSync(dir)).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('failure while publishing the first output removes it and all temporaries', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'evidence-pub-'))
    try {
      const json = path.join(dir, 'out.json')
      const md = path.join(dir, 'out.md')
      expect(() => publishEvidenceOutputs(json, md, 'json', 'md', {
        failOn: phase => { if (phase === 'publish-json') throw new Error('injected publish failure') },
      })).toThrow('injected publish failure')
      expect(readdirSync(dir)).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('failure while publishing the second output cleans up the first final output and all temporaries', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'evidence-pub-'))
    try {
      const json = path.join(dir, 'out.json')
      const md = path.join(dir, 'out.md')
      expect(() => publishEvidenceOutputs(json, md, 'json', 'md', {
        failOn: phase => { if (phase === 'publish-markdown') throw new Error('injected second publish failure') },
      })).toThrow('injected second publish failure')
      expect(readdirSync(dir)).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('never overwrites a destination created after preflight (first destination race)', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'evidence-pub-'))
    try {
      const json = path.join(dir, 'out.json')
      const md = path.join(dir, 'out.md')
      // Simulate another process creating the JSON destination between the
      // CLI preflight and the final publication step.
      writeFileSync(json, 'independently created')
      expect(() => publishEvidenceOutputs(json, md, 'json', 'md')).toThrow(/EEXIST/)
      // The independently created destination is preserved untouched.
      expect(readFileSync(json, 'utf8')).toBe('independently created')
      expect(readdirSync(dir).sort()).toEqual(['out.json'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('a second-destination no-clobber refusal removes the first final created by this run and preserves the independent file', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'evidence-pub-'))
    try {
      const json = path.join(dir, 'out.json')
      const md = path.join(dir, 'out.md')
      writeFileSync(md, 'independent markdown')
      expect(() => publishEvidenceOutputs(json, md, 'json', 'md')).toThrow(/EEXIST/)
      // First final (json) published by this run was removed; the
      // independently created markdown survives with its original content;
      // no temporaries remain.
      expect(readFileSync(md, 'utf8')).toBe('independent markdown')
      expect(readdirSync(dir).sort()).toEqual(['out.md'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('successful publication still produces two distinct 0600 files with no temporaries', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'evidence-pub-'))
    try {
      const json = path.join(dir, 'out.json')
      const md = path.join(dir, 'out.md')
      publishEvidenceOutputs(json, md, '{"a":1}', '# markdown')
      expect(readFileSync(json, 'utf8')).toBe('{"a":1}')
      expect(readFileSync(md, 'utf8')).toBe('# markdown')
      if (process.platform !== 'win32') {
        expect(statSync(json).mode & 0o777).toBe(0o600)
        expect(statSync(md).mode & 0o777).toBe(0o600)
      }
      expect(readdirSync(dir).sort()).toEqual(['out.json', 'out.md'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('CLI output-path safety (before database access)', () => {
  async function runMain(args: string[]): Promise<{ code: number; stderr: string }> {
    const errors: string[] = []
    const spy = vi.spyOn(console, 'error').mockImplementation(message => errors.push(String(message)))
    try {
      const code = await main(args)
      return { code, stderr: errors.join('\n') }
    } finally {
      spy.mockRestore()
    }
  }

  it('refuses identical JSON and Markdown output paths before reading the expected file or the database', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'evidence-cli-'))
    try {
      const same = path.join(dir, 'out.json')
      // The expected file does not exist: a same-path refusal that still
      // reaches the expectations read would surface the expectations error;
      // the observed refusal proves path validation precedes any file or
      // database access.
      const { code, stderr } = await runMain(['--json', same, '--markdown', same, '--expected', path.join(dir, 'missing-expected.json')])
      expect(code).toBe(1)
      expect(stderr).toContain('resolve to the same file')
      expect(stderr).not.toContain('expectations file')
      expect(readdirSync(dir).sort()).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('refuses normalized-equivalent JSON and Markdown output paths', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'evidence-cli-'))
    try {
      const direct = path.join(dir, 'out.json')
      const dotted = path.join(dir, '.', 'out.json')
      const { code, stderr } = await runMain(['--json', direct, '--markdown', dotted, '--expected', path.join(dir, 'missing-expected.json')])
      expect(code).toBe(1)
      expect(stderr).toContain('resolve to the same file')
      expect(readdirSync(dir).sort()).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('keeps the existing refusal when a final output path already exists', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'evidence-cli-'))
    try {
      const json = path.join(dir, 'out.json')
      writeFileSync(json, 'pre-existing')
      const md = path.join(dir, 'out.md')
      // Schema-valid expectations file so the run reaches the output
      // existence preflight (path validation happens even earlier).
      const expectedPath = path.join(dir, 'expected.json')
      writeFileSync(expectedPath, JSON.stringify({
        fingerprint: 'a'.repeat(64),
        baselineStateHash: 'b'.repeat(64),
        quarantinedEntries: 574, quarantinedSnapshots: 49, defectSnapshots: 18,
        windowlessDecisions: 359, singleMinusOneDecisions: 7, snapshotDecisions: 366,
        liveDecisions: 130, unsupported: 0, rewriteOperations: 0,
        topology11Snapshots: 11, topology7Snapshots: 7,
        topology11WindowlessDecisions: 226, topology7WindowlessDecisions: 133,
        topology7SingleMinusOneDecisions: 7,
      }))
      const { code, stderr } = await runMain(['--json', json, '--markdown', md, '--expected', expectedPath])
      expect(code).toBe(1)
      expect(stderr).toContain('already exists')
      expect(readFileSync(json, 'utf8')).toBe('pre-existing')
      expect(readdirSync(dir).sort()).toEqual(['expected.json', 'out.json'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('structural defect classification', () => {  it('classifies a duplicate-owner structural defect as structural', () => {
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
      topology11Snapshots: 1, topology7Snapshots: 0,
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

describe('plan-decision-anchored S-record correlation', () => {
  function fakeDecision(overrides: Partial<PlanDecisionEntry>): PlanDecisionEntry {
    return {
      id: 'decision-id',
      projectId: PROJECT_ID,
      ownerId: 'owner',
      ownerKind: 'namedPerson',
      profileId: null,
      snapshotId: 'snap-correlate',
      entryId: 'nr-1',
      legacyBase: null,
      evidenceHash: 'hash',
      allowedResolutions: ['snapshot-window-interpretation'],
      message: 'single -1/negative window edge without established meaning — explicit window interpretation required',
      ...overrides,
    }
  }

  function correlateFixtureState(): RemediationDatabaseState {
    return makeState([{
      id: 'snap-correlate',
      projectId: PROJECT_ID,
      payload: makeV2Snapshot(
        [makeRt({ id: 'rt-w', allocationMode: 'CAPACITY_PLAN' })],
        [makeNr({ id: 'nr-1', resourceTypeId: 'rt-w', allocationMode: 'CAPACITY_PLAN', allocationStartWeek: -1, startWeek: -1, allocationEndWeek: 5, endWeek: null })],
      ),
    }])
  }

  it('emits one S record for the sanitized dual-alias reproducer of the former selection divergence', () => {
    // Sanitized regression reproducer (NOT confirmed production evidence):
    // production observed zero S records against seven plan-derived
    // single-negative decisions, and the confirmed code defect is the
    // independent raw selection path (its one-minus-one prefilter could
    // diverge from the plan-authoritative set). This fixture — -1 on both
    // aliases of the start edge — is one concrete raw shape capable of
    // causing that mismatch; the corrected implementation emits its
    // sanitized evidence. The exact production raw layout remains unknown
    // until the corrected #404 run.
    const state = correlateFixtureState()
    const counts: Omit<SnapshotEvidenceExpected, 'fingerprint' | 'baselineStateHash'> = {
      quarantinedEntries: 0, quarantinedSnapshots: 0, defectSnapshots: 1,
      windowlessDecisions: 1, singleMinusOneDecisions: 1, snapshotDecisions: 2,
      liveDecisions: 0, unsupported: 0, rewriteOperations: 0,
      topology11Snapshots: 0, topology7Snapshots: 1,
      topology11WindowlessDecisions: 0, topology7WindowlessDecisions: 1,
      topology7SingleMinusOneDecisions: 1,
    }
    const report = buildReport(state, counts)
    expect(report.integrityResult.reconciliationPassed).toBe(true)
    expect(report.singleNegativeEntries).toHaveLength(1)
    const s = report.singleNegativeEntries[0]!
    expect(s.entryKind).toBe('namedResource')
    // The plan-relevant exact field is the primary of the negative edge; the
    // fallback alias is still reported truthfully as minus-one.
    expect(s.minusOneField).toBe('allocationStartWeek')
    expect(s.windowFields).toEqual({
      allocationStartWeek: 'minus-one',
      allocationEndWeek: 'populated',
      startWeek: 'minus-one',
      endWeek: 'absent-null',
    })
    expect(s.aliasConflicts).toEqual({ startEdge: false, endEdge: false })
    expect(s.modeSource).toBe('explicit')
    // JSON and Markdown parity for the sanitized field states.
    const json = JSON.stringify(report)
    const markdown = renderSnapshotEvidenceMarkdown(report)
    expect(json).toContain('"allocationStartWeek":"minus-one","allocationEndWeek":"populated","startWeek":"minus-one","endWeek":"absent-null"')
    expect(markdown).toContain('allocationStartWeek:minus-one')
    expect(markdown).toContain('startWeek:minus-one')
  })

  it('populates inherited effective-mode evidence (raw null / parent CAPACITY_PLAN / effective CAPACITY_PLAN / inherited)', () => {
    // The S schema must be capable of showing inherited provenance. This is
    // the pure population path; a real plan decision for such an entry cannot
    // exist because the plan classifies NamedResources by their own raw mode
    // (traced contract), so the capability is proven directly.
    const entry = buildSingleNegativeEvidenceEntry(
      makeNr({ id: 'nr-inherited', resourceTypeId: 'rt-parent', allocationMode: null, allocationPercent: 100, allocationPct: 100, allocationStartWeek: null, startWeek: -1, allocationEndWeek: 5, endWeek: null }) as unknown as Parameters<typeof buildSingleNegativeEvidenceEntry>[0],
      'namedResource',
      makeRt({ id: 'rt-parent', allocationMode: 'CAPACITY_PLAN', allocationStartWeek: 0, allocationEndWeek: 5 }) as unknown as Parameters<typeof buildSingleNegativeEvidenceEntry>[2],
      [],
      'startWeek',
    )
    expect(entry.rawMode).toBe(null)
    expect(entry.parentMode).toBe('CAPACITY_PLAN')
    expect(entry.effectiveMode).toBe('CAPACITY_PLAN')
    expect(entry.modeSource).toBe('inherited')
    expect(entry.windowFields).toEqual({
      allocationStartWeek: 'absent-null',
      allocationEndWeek: 'populated',
      startWeek: 'minus-one',
      endWeek: 'absent-null',
    })
  })

  it('keeps inherited-mode single-negative entries out of the S set (plan classifies by raw mode)', () => {
    // Plan-faithful boundary: the plan derives decisions from the raw own
    // mode, so an inherited CAPACITY_PLAN NamedResource (own mode null) is
    // never a single-negative decision or S record. Under issue #444 the
    // containing V2 snapshot is retired (one defect M record, no decisions)
    // and the run reconciles with zero quarantine counts.
    const state = makeState([{
      id: 'snap-inherited',
      projectId: PROJECT_ID,
      payload: makeV2Snapshot(
        [makeRt({ id: 'rt-parent', allocationMode: 'CAPACITY_PLAN', allocationStartWeek: 0, allocationEndWeek: 5 })],
        [makeNr({ id: 'nr-inherited', resourceTypeId: 'rt-parent', allocationMode: null, allocationPercent: 100, allocationPct: 100, allocationStartWeek: null, startWeek: -1, allocationEndWeek: 5, endWeek: null })],
      ),
    }])
    const counts: Omit<SnapshotEvidenceExpected, 'fingerprint' | 'baselineStateHash'> = {
      quarantinedEntries: 0, quarantinedSnapshots: 0, defectSnapshots: 1,
      windowlessDecisions: 0, singleMinusOneDecisions: 0, snapshotDecisions: 0,
      liveDecisions: 0, unsupported: 0, rewriteOperations: 0,
      topology11Snapshots: 1, topology7Snapshots: 0,
      topology11WindowlessDecisions: 0, topology7WindowlessDecisions: 0,
      topology7SingleMinusOneDecisions: 0,
    }
    const report = buildReport(state, counts)
    expect(report.singleNegativeEntries).toHaveLength(0)
    expect(report.integrityResult.reconciliationPassed).toBe(true)
  })

  it('emits exactly seven S records for seven synthetic defect snapshots', () => {
    const snapshots = Array.from({ length: 7 }, (_, i) => ({
      id: `snap-${i}`,
      projectId: PROJECT_ID,
      payload: makeV2Snapshot(
        [makeRt({ id: `rt-w-${i}`, allocationMode: 'CAPACITY_PLAN' })],
        [makeNr({ id: `nr-m-${i}`, resourceTypeId: `rt-w-${i}`, allocationMode: 'CAPACITY_PLAN', allocationStartWeek: -1, startWeek: -1, allocationEndWeek: 5, endWeek: null })],
      ),
    }))
    const state = makeState(snapshots)
    const counts: Omit<SnapshotEvidenceExpected, 'fingerprint' | 'baselineStateHash'> = {
      quarantinedEntries: 0, quarantinedSnapshots: 0, defectSnapshots: 7,
      windowlessDecisions: 7, singleMinusOneDecisions: 7, snapshotDecisions: 14,
      liveDecisions: 0, unsupported: 0, rewriteOperations: 0,
      topology11Snapshots: 0, topology7Snapshots: 7,
      topology11WindowlessDecisions: 0, topology7WindowlessDecisions: 7,
      topology7SingleMinusOneDecisions: 7,
    }
    const report = buildReport(state, counts)
    expect(report.integrityResult.reconciliationPassed).toBe(true)
    expect(report.singleNegativeEntries).toHaveLength(7)
    // Every seven-subgroup M record reports exactly one correlated S record.
    for (const m of report.defectSnapshots) {
      expect(m.singleMinusOneDecisionCount).toBe(1)
    }
    const seven = report.topology.sevenSnapshotSubgroup
    expect(seven.snapshots).toBe(7)
    expect(seven.singleMinusOneDecisions).toBe(7)
  })

  it('reconciles the reviewed 18-snapshot topology shape (359 windowless decisions, no S decisions)', () => {
    // Production-shaped topology post-issue-#438: 10 eleven-subgroup
    // snapshots with 21 windowless decisions, 1 with 16, and 7 seven-subgroup
    // snapshots with 19 windowless + 1 deterministic S entry each. The S
    // entries are deterministic findings (no single-negative decisions), and
    // each seven-subgroup snapshot carries a residual alias-conflict entry
    // (as in production M1–M6/M8) so it stays defect-classified. 359
    // windowless + 0 single-negative = 359 snapshot decisions across 18
    // defect snapshots.
    const conflictNr = (rtId: string, i: number) => makeNr({
      id: `nr-c-${i}`,
      resourceTypeId: rtId,
      allocationMode: null,
      allocationPercent: 100,
      allocationPct: 100,
      allocationStartWeek: 5,
      allocationEndWeek: 10,
      startWeek: 5,
      endWeek: 9,
    })
    const snapshots = []
    for (let i = 0; i < 10; i++) {
      const rtId = `rt-e-${i}-0`
      snapshots.push({
        id: `snap-eleven-${i}`,
        projectId: PROJECT_ID,
        payload: makeV2Snapshot(
          Array.from({ length: 21 }, (_, j) => makeRt({ id: `rt-e-${i}-${j}`, allocationMode: 'CAPACITY_PLAN' })),
          [conflictNr(rtId, i)],
        ),
      })
    }
    snapshots.push({
      id: 'snap-eleven-16',
      projectId: PROJECT_ID,
      payload: makeV2Snapshot(
        Array.from({ length: 16 }, (_, j) => makeRt({ id: `rt-e16-${j}`, allocationMode: 'CAPACITY_PLAN' })),
        [conflictNr('rt-e16-0', 99)],
      ),
    })
    for (let i = 0; i < 7; i++) {
      const rtId = `rt-s-${i}-0`
      snapshots.push({
        id: `snap-seven-${i}`,
        projectId: PROJECT_ID,
        payload: makeV2Snapshot(
          Array.from({ length: 19 }, (_, j) => makeRt({ id: `rt-s-${i}-${j}`, allocationMode: 'CAPACITY_PLAN' })),
          [
            makeNr({ id: `nr-s-${i}`, resourceTypeId: rtId, allocationMode: 'CAPACITY_PLAN', allocationStartWeek: null, startWeek: -1, allocationEndWeek: 5, endWeek: -1 }),
            conflictNr(rtId, 1000 + i),
          ],
        ),
      })
    }
    const state = makeState(snapshots)
    const counts: Omit<SnapshotEvidenceExpected, 'fingerprint' | 'baselineStateHash'> = {
      quarantinedEntries: 0, quarantinedSnapshots: 0, defectSnapshots: 18,
      windowlessDecisions: 359, singleMinusOneDecisions: 0, snapshotDecisions: 359,
      liveDecisions: 0, unsupported: 0, rewriteOperations: 0,
      topology11Snapshots: 18, topology7Snapshots: 0,
      topology11WindowlessDecisions: 359, topology7WindowlessDecisions: 0,
      topology7SingleMinusOneDecisions: 0,
    }
    const report = buildReport(state, counts)
    expect(report.integrityResult.reconciliationPassed).toBe(true)
    expect(report.singleNegativeEntries).toHaveLength(0)
    expect(report.topology.elevenSnapshotSubgroup.snapshots).toBe(18)
    expect(report.topology.elevenSnapshotSubgroup.windowlessDecisions).toBe(359)
    expect(report.topology.sevenSnapshotSubgroup.windowlessDecisions).toBe(0)
    expect(report.topology.sevenSnapshotSubgroup.singleMinusOneDecisions).toBe(0)
    expect(report.topology.snapshotDecisions).toBe(359)
    // The seven S entries are deterministic findings: every seven-subgroup
    // snapshot still reports 19 windowless decisions (the residual
    // alias-conflict entry is an already-valid finding, not a decision).
    const seven = report.defectSnapshots.filter(m => m.windowlessDecisionCount === 19)
    expect(seven).toHaveLength(7)
    for (const m of seven) {
      expect(m.singleMinusOneDecisionCount).toBe(0)
      expect(m.entryErrorCategories['alias-conflict']).toBeGreaterThanOrEqual(2)
    }
    // The S entries leave the decision set: 359 = 359 windowless + 0 single.
    expect(report.topology.snapshotDecisions).toBe(359)
  })

  it('fails closed on a missing stored snapshot', () => {
    const state = correlateFixtureState()
    const classified = classifyAllSnapshots(state)
    const plan = buildRemediationPlan(state, 'test-commit')
    const decisions = [fakeDecision({ snapshotId: 'ghost-snapshot' })]
    const fakePlan = { ...plan, decisions }
    expect(() => correlateSingleNegativeDecisions(fakePlan, state, classified))
      .toThrowError(SnapshotEvidenceError)
  })

  it('fails closed on a missing entry identifier and on a missing raw entry', () => {
    const state = correlateFixtureState()
    const classified = classifyAllSnapshots(state)
    const plan = buildRemediationPlan(state, 'test-commit')
    expect(() => correlateSingleNegativeDecisions({ ...plan, decisions: [fakeDecision({ entryId: null })] }, state, classified))
      .toThrowError(/carries no entry identifier/)
    expect(() => correlateSingleNegativeDecisions({ ...plan, decisions: [fakeDecision({ entryId: 'nr-ghost' })] }, state, classified))
      .toThrowError(/matched 0 raw entries/)
  })

  it('fails closed on duplicate raw entry IDs and on entry-kind mismatch', () => {
    const state = makeState([{
      id: 'snap-dupe',
      projectId: PROJECT_ID,
      payload: makeV2Snapshot(
        [
          makeRt({ id: 'rt-dupe', allocationMode: 'CAPACITY_PLAN', allocationStartWeek: -1, allocationEndWeek: 5 }),
          makeRt({ id: 'rt-dupe', allocationMode: 'CAPACITY_PLAN', allocationStartWeek: -1, allocationEndWeek: 5 }),
        ],
        [],
      ),
    }])
    const classified = classifyAllSnapshots(state)
    const plan = buildRemediationPlan(state, 'test-commit')
    expect(() => correlateSingleNegativeDecisions(
      { ...plan, decisions: [fakeDecision({ snapshotId: 'snap-dupe', ownerKind: 'role', entryId: 'rt-dupe' })] },
      state,
      classified,
    )).toThrowError(/matched 2 raw entries/)
    // Kind mismatch: a namedPerson decision for a ResourceType id matches no
    // NamedResource.
    expect(() => correlateSingleNegativeDecisions(
      { ...plan, decisions: [fakeDecision({ snapshotId: 'snap-dupe', ownerKind: 'namedPerson', entryId: 'rt-dupe' })] },
      state,
      classified,
    )).toThrowError(/matched 0 raw entries/)
  })

  it('fails closed when two selected decisions resolve to the same raw entry', () => {
    const state = correlateFixtureState()
    const classified = classifyAllSnapshots(state)
    const plan = buildRemediationPlan(state, 'test-commit')
    const decision = fakeDecision({})
    expect(() => correlateSingleNegativeDecisions(
      { ...plan, decisions: [decision, decision] },
      state,
      classified,
    )).toThrowError(/two selected decisions resolve to the same raw entry/)
  })

  it('fails closed when the matched raw entry does not re-derive the single-negative decision', () => {
    const state = makeState([{
      id: 'snap-windowless',
      projectId: PROJECT_ID,
      payload: makeV2Snapshot(
        [makeRt({ id: 'rt-w', allocationMode: 'CAPACITY_PLAN' })],
        [],
      ),
    }])
    const classified = classifyAllSnapshots(state)
    const plan = buildRemediationPlan(state, 'test-commit')
    expect(() => correlateSingleNegativeDecisions(
      { ...plan, decisions: [fakeDecision({ snapshotId: 'snap-windowless', ownerKind: 'role', entryId: 'rt-w' })] },
      state,
      classified,
    )).toThrowError(/does not re-derive the single-negative decision/)
  })

  it('correlates a NamedResource only when exactly one parent ResourceType matches', () => {
    const state = makeState([{
      id: 'snap-parent',
      projectId: PROJECT_ID,
      payload: makeV2Snapshot(
        [makeRt({ id: 'rt-p', allocationMode: 'CAPACITY_PLAN', allocationStartWeek: 0, allocationEndWeek: 5 })],
        [makeNr({ id: 'nr-child', resourceTypeId: 'rt-p', allocationMode: 'CAPACITY_PLAN', allocationStartWeek: -1, startWeek: 5, allocationEndWeek: 5, endWeek: null })],
      ),
    }])
    const counts: Omit<SnapshotEvidenceExpected, 'fingerprint' | 'baselineStateHash'> = {
      quarantinedEntries: 0, quarantinedSnapshots: 0, defectSnapshots: 1,
      windowlessDecisions: 0, singleMinusOneDecisions: 1, snapshotDecisions: 1,
      liveDecisions: 0, unsupported: 0, rewriteOperations: 0,
      topology11Snapshots: 0, topology7Snapshots: 1,
      topology11WindowlessDecisions: 0, topology7WindowlessDecisions: 0,
      topology7SingleMinusOneDecisions: 1,
    }
    const report = buildReport(state, counts)
    expect(report.integrityResult.reconciliationPassed).toBe(true)
    expect(report.singleNegativeEntries).toHaveLength(1)
    expect(report.singleNegativeEntries[0]!.modeSource).toBe('explicit')
  })

  it('fails closed on an absent parent reference', () => {
    const state = makeState([{
      id: 'snap-no-parent-ref',
      projectId: PROJECT_ID,
      payload: makeV2Snapshot(
        [makeRt({ id: 'rt-p', allocationMode: 'CAPACITY_PLAN', allocationStartWeek: 0, allocationEndWeek: 5 })],
        [{
          id: 'nr-orphan',
          resourceTypeId: null,
          name: 'Secret Person Name',
          startWeek: null,
          endWeek: null,
          allocationPct: 100,
          allocationMode: 'CAPACITY_PLAN',
          allocationPercent: 100,
          allocationStartWeek: -1,
          allocationEndWeek: 5,
          pricingModel: 'ACTUAL_DAYS',
        }],
      ),
    }])
    const classified = classifyAllSnapshots(state)
    const plan = buildRemediationPlan(state, 'test-commit')
    expect(() => correlateSingleNegativeDecisions(
      { ...plan, decisions: [fakeDecision({ snapshotId: 'snap-no-parent-ref', entryId: 'nr-orphan' })] },
      state,
      classified,
    )).toThrowError(/carries no parent reference/)
  })

  it('fails closed when no parent ResourceType matches', () => {
    const state = makeState([{
      id: 'snap-no-parent',
      projectId: PROJECT_ID,
      payload: makeV2Snapshot(
        [makeRt({ id: 'rt-other', allocationMode: 'CAPACITY_PLAN', allocationStartWeek: 0, allocationEndWeek: 5 })],
        [makeNr({ id: 'nr-child', resourceTypeId: 'rt-ghost', allocationMode: 'CAPACITY_PLAN', allocationStartWeek: -1, startWeek: null, allocationEndWeek: 5, endWeek: null })],
      ),
    }])
    const classified = classifyAllSnapshots(state)
    const plan = buildRemediationPlan(state, 'test-commit')
    expect(() => correlateSingleNegativeDecisions(
      { ...plan, decisions: [fakeDecision({ snapshotId: 'snap-no-parent', entryId: 'nr-child' })] },
      state,
      classified,
    )).toThrowError(/matched 0 resource types/)
  })

  it('fails closed on duplicate parents even with different allocation modes', () => {
    const state = makeState([{
      id: 'snap-dup-parents',
      projectId: PROJECT_ID,
      payload: makeV2Snapshot(
        [
          makeRt({ id: 'rt-p', allocationMode: 'CAPACITY_PLAN', allocationStartWeek: 0, allocationEndWeek: 5 }),
          makeRt({ id: 'rt-p', allocationMode: 'TIMELINE', allocationStartWeek: 0, allocationEndWeek: 5 }),
        ],
        [makeNr({ id: 'nr-child', resourceTypeId: 'rt-p', allocationMode: 'CAPACITY_PLAN', allocationStartWeek: -1, startWeek: null, allocationEndWeek: 5, endWeek: null })],
      ),
    }])
    const classified = classifyAllSnapshots(state)
    const plan = buildRemediationPlan(state, 'test-commit')
    try {
      correlateSingleNegativeDecisions(
        { ...plan, decisions: [fakeDecision({ snapshotId: 'snap-dup-parents', entryId: 'nr-child' })] },
        state,
        classified,
      )
      throw new Error('expected refusal')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      expect(message).toContain('matched multiple resource types')
      // Controlled messages expose no identifiers, names, modes or payload
      // values — the duplicate parents held different allocation modes and
      // neither may influence evidence.
      expect(message).not.toContain('rt-p')
      expect(message).not.toContain('nr-child')
      expect(message).not.toContain('CAPACITY_PLAN')
      expect(message).not.toContain('TIMELINE')
      expect(message).not.toContain('snap-dup-parents')
    }
  })

  it('correlation errors carry only fixed safe reasons and counts (no ids or payloads)', () => {
    const state = correlateFixtureState()
    const classified = classifyAllSnapshots(state)
    const plan = buildRemediationPlan(state, 'test-commit')
    try {
      correlateSingleNegativeDecisions(
        { ...plan, decisions: [fakeDecision({ snapshotId: 'ghost-snapshot', entryId: 'nr-1' })] },
        state,
        classified,
      )
      throw new Error('expected refusal')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      expect(message).toContain('cannot correlate snapshot decision 1 of 1')
      expect(message).not.toContain('ghost-snapshot')
      expect(message).not.toContain('nr-1')
      expect(message).not.toContain(PROJECT_ID)
      expect(message).not.toContain('Secret')
    }
  })
})

describe('effective-edge window reconciliation (shadowed minus-one)', () => {
  /** One explicit CAPACITY_PLAN NR with a unique parent in a defect snapshot. */
  function shadowState(nrOverrides: Parameters<typeof makeNr>[0], id = 'snap-shadow'): RemediationDatabaseState {
    return makeState([{
      id,
      projectId: PROJECT_ID,
      payload: makeV2Snapshot(
        [makeRt({ id: 'rt-p', allocationMode: 'CAPACITY_PLAN', allocationStartWeek: 0, allocationEndWeek: 5 })],
        [makeNr({ id: 'nr-shadow', resourceTypeId: 'rt-p', allocationMode: 'CAPACITY_PLAN', allocationPercent: 100, allocationPct: 100, ...nrOverrides })],
      ),
    }])
  }

  const SINGLE_COUNTS: Omit<SnapshotEvidenceExpected, 'fingerprint' | 'baselineStateHash'> = {
    quarantinedEntries: 0, quarantinedSnapshots: 0, defectSnapshots: 1,
    windowlessDecisions: 0, singleMinusOneDecisions: 1, snapshotDecisions: 1,
    liveDecisions: 0, unsupported: 0, rewriteOperations: 0,
    topology11Snapshots: 0, topology7Snapshots: 1,
    topology11WindowlessDecisions: 0, topology7WindowlessDecisions: 0,
    topology7SingleMinusOneDecisions: 1,
  }

  // Issue #444: the exact S shape is a deterministic finding, but the
  // containing V2 snapshot is deliberately retired — one non-restorable M
  // record, no decisions, no S record.
  const DETERMINISTIC_COUNTS: Omit<SnapshotEvidenceExpected, 'fingerprint' | 'baselineStateHash'> = {
    quarantinedEntries: 0, quarantinedSnapshots: 0, defectSnapshots: 1,
    windowlessDecisions: 0, singleMinusOneDecisions: 0, snapshotDecisions: 0,
    liveDecisions: 0, unsupported: 0, rewriteOperations: 0,
    topology11Snapshots: 1, topology7Snapshots: 0,
    topology11WindowlessDecisions: 0, topology7WindowlessDecisions: 0,
    topology7SingleMinusOneDecisions: 0,
  }

  it('classifies the exact production S shape as deterministic, retired, never an S record (issue #444)', () => {
    // Production shape: allocationStartWeek null, startWeek -1 (raw alias
    // start), allocationEndWeek 5 (populated primary end), endWeek -1 (raw
    // alias end). The raw (-1,-1) alias pair is the scheduler-consumed
    // never-active sentinel: the S entry stays a deterministic finding and no
    // single-negative decision or S record exists. The containing V2 snapshot
    // is retired under issue #444, so it is non-restorable.
    const state = shadowState({ allocationStartWeek: null, startWeek: -1, allocationEndWeek: 5, endWeek: -1 })
    const report = buildReport(state, DETERMINISTIC_COUNTS)
    expect(report.integrityResult.reconciliationPassed).toBe(true)
    expect(report.singleNegativeEntries).toHaveLength(0)
    expect(report.observedBoundary.snapshotPopulation).toEqual({ totalSnapshots: 1, restorable: 0, quarantined: 0, defect: 1 })
    expect(report.observedBoundary.summary.findings.deterministic).toBe(1)
    expect(report.topology.singleMinusOneDecisions).toBe(0)
  })

  it('accepts the effective-end mirror: populated primary start shadows a fallback -1', () => {
    // allocationStartWeek 5 (populated primary start), startWeek -1 (shadowed
    // fallback), allocationEndWeek null, endWeek -1 (effective negative end).
    const state = shadowState({ allocationStartWeek: 5, startWeek: -1, allocationEndWeek: null, endWeek: -1 })
    const report = buildReport(state, SINGLE_COUNTS)
    expect(report.integrityResult.reconciliationPassed).toBe(true)
    const s = report.singleNegativeEntries[0]!
    expect(s.minusOneField).toBe('endWeek')
    expect(s.windowFields).toEqual({
      allocationStartWeek: 'populated',
      allocationEndWeek: 'absent-null',
      startWeek: 'minus-one',
      endWeek: 'minus-one',
    })
  })

  it('accepts a primary -1 with an opposite-edge shadowed fallback -1', () => {
    const state = shadowState({ allocationStartWeek: -1, startWeek: null, allocationEndWeek: 5, endWeek: -1 })
    const report = buildReport(state, SINGLE_COUNTS)
    expect(report.integrityResult.reconciliationPassed).toBe(true)
    const s = report.singleNegativeEntries[0]!
    expect(s.minusOneField).toBe('allocationStartWeek')
    expect(s.windowFields.endWeek).toBe('minus-one')
    expect(s.windowFields.allocationEndWeek).toBe('populated')
  })

  it('keeps the same-edge dual-alias -1 fixture valid', () => {
    const state = shadowState({ allocationStartWeek: -1, startWeek: -1, allocationEndWeek: 5, endWeek: null })
    const report = buildReport(state, SINGLE_COUNTS)
    expect(report.integrityResult.reconciliationPassed).toBe(true)
    const s = report.singleNegativeEntries[0]!
    expect(s.minusOneField).toBe('allocationStartWeek')
    expect(s.windowFields).toEqual({
      allocationStartWeek: 'minus-one',
      allocationEndWeek: 'populated',
      startWeek: 'minus-one',
      endWeek: 'absent-null',
    })
  })

  it('keeps a ResourceType single-negative entry valid (no fallback aliases)', () => {
    const state = makeState([{
      id: 'snap-rt-single',
      projectId: PROJECT_ID,
      payload: makeV2Snapshot(
        [
          makeRt({ id: 'rt-a', allocationMode: 'CAPACITY_PLAN', allocationStartWeek: -1, allocationEndWeek: 5 }),
          makeRt({ id: 'rt-b', allocationMode: 'CAPACITY_PLAN', allocationStartWeek: -1, allocationEndWeek: 5 }),
          makeRt({ id: 'rt-conf', allocationMode: 'CAPACITY_PLAN', allocationStartWeek: 0, allocationEndWeek: 5 }),
        ],
        [
          // Defect-inducing conflicting-alias NamedResource (no decision of
          // its own; keeps the snapshot defect-classified so the RTs are
          // evaluated as decisions rather than Class B quarantines).
          makeNr({ id: 'nr-conf', resourceTypeId: 'rt-conf', allocationMode: null, allocationPercent: 100, allocationPct: 100, allocationStartWeek: 5, allocationEndWeek: 10, startWeek: 5, endWeek: 9 }),
        ],
      ),
    }])
    const counts: Omit<SnapshotEvidenceExpected, 'fingerprint' | 'baselineStateHash'> = {
      quarantinedEntries: 0, quarantinedSnapshots: 0, defectSnapshots: 1,
      windowlessDecisions: 0, singleMinusOneDecisions: 2, snapshotDecisions: 2,
      liveDecisions: 0, unsupported: 0, rewriteOperations: 0,
      topology11Snapshots: 0, topology7Snapshots: 1,
      topology11WindowlessDecisions: 0, topology7WindowlessDecisions: 0,
      topology7SingleMinusOneDecisions: 2,
    }
    const report = buildReport(state, counts)
    expect(report.integrityResult.reconciliationPassed).toBe(true)
    expect(report.singleNegativeEntries).toHaveLength(2)
    for (const s of report.singleNegativeEntries) {
      expect(s.entryKind).toBe('resourceType')
      expect(s.minusOneField).toBe('allocationStartWeek')
    }
  })

  it('does not select a both-effective-edges-negative entry (never-active class, no plan decision)', () => {
    const state = shadowState({ allocationStartWeek: null, startWeek: -1, allocationEndWeek: null, endWeek: -1 })
    const counts: Omit<SnapshotEvidenceExpected, 'fingerprint' | 'baselineStateHash'> = {
      quarantinedEntries: 0, quarantinedSnapshots: 0, defectSnapshots: 1,
      windowlessDecisions: 0, singleMinusOneDecisions: 0, snapshotDecisions: 0,
      liveDecisions: 0, unsupported: 0, rewriteOperations: 0,
      topology11Snapshots: 1, topology7Snapshots: 0,
      topology11WindowlessDecisions: 0, topology7WindowlessDecisions: 0,
      topology7SingleMinusOneDecisions: 0,
    }
    const report = buildReport(state, counts)
    expect(report.integrityResult.reconciliationPassed).toBe(true)
    expect(report.singleNegativeEntries).toHaveLength(0)
  })

  it('fails closed on an incoherent both-negative shape even with a supplied decision', () => {
    // (-2, -1): the shared classifier still emits the single-negative message,
    // but the fixed minus-one vocabulary cannot represent the -2 effective
    // start — the effective-window reconciliation refuses.
    const state = shadowState({ allocationStartWeek: -2, startWeek: null, allocationEndWeek: -1, endWeek: null })
    const classified = classifyAllSnapshots(state)
    const plan = buildRemediationPlan(state, 'test-commit')
    const decision = {
      id: 'd', projectId: PROJECT_ID, ownerId: 'o', ownerKind: 'namedPerson' as const,
      profileId: null, snapshotId: 'snap-shadow', entryId: 'nr-shadow', legacyBase: null,
      evidenceHash: 'h', allowedResolutions: ['snapshot-window-interpretation'],
      message: 'single -1/negative window edge without established meaning — explicit window interpretation required',
    }
    try {
      correlateSingleNegativeDecisions({ ...plan, decisions: [decision] }, state, classified)
      throw new Error('expected refusal')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      expect(message).toContain('does not have exactly one negative effective edge')
      expect(message).not.toContain('nr-shadow')
      expect(message).not.toContain('rt-p')
      expect(message).not.toContain('-2')
      expect(message).not.toContain('-1')
    }
  })

  it('emits no S records for seven exact S entries; the retired snapshots produce windowless decisions', () => {
    // Each snapshot: one windowless CAPACITY_PLAN RT and one exact S entry.
    // The S entry stays a deterministic finding (no single-negative decision,
    // no S record); the windowless RT becomes a windowless decision and the
    // whole V2 snapshot is retired (non-restorable).
    const snapshots = Array.from({ length: 7 }, (_, i) => ({
      id: `snap-${i}`,
      projectId: PROJECT_ID,
      payload: makeV2Snapshot(
        [makeRt({ id: `rt-w-${i}`, allocationMode: 'CAPACITY_PLAN' })],
        [makeNr({ id: `nr-m-${i}`, resourceTypeId: `rt-w-${i}`, allocationMode: 'CAPACITY_PLAN', allocationStartWeek: null, startWeek: -1, allocationEndWeek: 5, endWeek: -1 })],
      ),
    }))
    const state = makeState(snapshots)
    const counts: Omit<SnapshotEvidenceExpected, 'fingerprint' | 'baselineStateHash'> = {
      quarantinedEntries: 0, quarantinedSnapshots: 0, defectSnapshots: 7,
      windowlessDecisions: 7, singleMinusOneDecisions: 0, snapshotDecisions: 7,
      liveDecisions: 0, unsupported: 0, rewriteOperations: 0,
      topology11Snapshots: 7, topology7Snapshots: 0,
      topology11WindowlessDecisions: 7, topology7WindowlessDecisions: 0,
      topology7SingleMinusOneDecisions: 0,
    }
    const report = buildReport(state, counts)
    expect(report.integrityResult.reconciliationPassed).toBe(true)
    expect(report.singleNegativeEntries).toHaveLength(0)
    expect(report.observedBoundary.summary.findings.deterministic).toBe(7)
    expect(report.observedBoundary.summary.quarantined).toBe(0)
    expect(report.observedBoundary.snapshotPopulation.quarantined).toBe(0)
    expect(report.classAAggregates.totalEntries).toBe(0)
  })
})

describe('effective-source reconciliation (minusOneField must supply the effective value)', () => {
  const MISMATCH_COUNTS: Omit<SnapshotEvidenceExpected, 'fingerprint' | 'baselineStateHash'> = {
    quarantinedEntries: 0, quarantinedSnapshots: 0, defectSnapshots: 1,
    windowlessDecisions: 0, singleMinusOneDecisions: 1, snapshotDecisions: 1,
    liveDecisions: 0, unsupported: 0, rewriteOperations: 0,
    topology11Snapshots: 0, topology7Snapshots: 1,
    topology11WindowlessDecisions: 0, topology7WindowlessDecisions: 0,
    topology7SingleMinusOneDecisions: 1,
  }

  // Issue #444: the exact S shape is a deterministic finding, but the
  // containing V2 snapshot is deliberately retired — one non-restorable M
  // record, no decisions, no S record.
  const DETERMINISTIC_COUNTS: Omit<SnapshotEvidenceExpected, 'fingerprint' | 'baselineStateHash'> = {
    quarantinedEntries: 0, quarantinedSnapshots: 0, defectSnapshots: 1,
    windowlessDecisions: 0, singleMinusOneDecisions: 0, snapshotDecisions: 0,
    liveDecisions: 0, unsupported: 0, rewriteOperations: 0,
    topology11Snapshots: 1, topology7Snapshots: 0,
    topology11WindowlessDecisions: 0, topology7WindowlessDecisions: 0,
    topology7SingleMinusOneDecisions: 0,
  }

  it('fails closed when a negative effective source below -1 has a shadowed fallback -1 (start edge)', () => {
    // allocationStartWeek -2 supplies the effective start (below -1);
    // startWeek -1 is shadowed and must NOT be selected as minusOneField.
    const state = makeState([{
      id: 'snap-source-mismatch',
      projectId: PROJECT_ID,
      payload: makeV2Snapshot(
        [makeRt({ id: 'rt-p', allocationMode: 'CAPACITY_PLAN', allocationStartWeek: 0, allocationEndWeek: 5 })],
        [makeNr({ id: 'nr-mismatch', resourceTypeId: 'rt-p', allocationMode: 'CAPACITY_PLAN', allocationStartWeek: -2, startWeek: -1, allocationEndWeek: 5, endWeek: null })],
      ),
    }])
    try {
      buildReport(state, MISMATCH_COUNTS)
      throw new Error('expected refusal')
    } catch (error) {
      expect(error).toBeInstanceOf(SnapshotEvidenceError)
      const message = error instanceof Error ? error.message : String(error)
      expect(message).toContain('the negative effective value is not exactly minus one')
      expect(message).not.toContain('-2')
      expect(message).not.toContain('-1')
      expect(message).not.toContain('nr-mismatch')
      expect(message).not.toContain('rt-p')
      expect(message).not.toContain('snap-source-mismatch')
      expect(message).not.toContain('CAPACITY_PLAN')
    }
  })

  it('fails closed for the end-edge mirror (effective source below -1, shadowed fallback -1)', () => {
    const state = makeState([{
      id: 'snap-source-mismatch-end',
      projectId: PROJECT_ID,
      payload: makeV2Snapshot(
        [makeRt({ id: 'rt-p', allocationMode: 'CAPACITY_PLAN', allocationStartWeek: 0, allocationEndWeek: 5 })],
        [makeNr({ id: 'nr-mismatch-end', resourceTypeId: 'rt-p', allocationMode: 'CAPACITY_PLAN', allocationStartWeek: 0, startWeek: null, allocationEndWeek: -2, endWeek: -1 })],
      ),
    }])
    try {
      buildReport(state, MISMATCH_COUNTS)
      throw new Error('expected refusal')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      expect(message).toContain('the negative effective value is not exactly minus one')
      expect(message).not.toContain('-2')
      expect(message).not.toContain('-1')
      expect(message).not.toContain('nr-mismatch-end')
    }
  })

  it('a primary effective -1 with a same-edge fallback -1 selects the primary (source-based)', () => {
    const state = makeState([{
      id: 'snap-primary-fallback',
      projectId: PROJECT_ID,
      payload: makeV2Snapshot(
        [makeRt({ id: 'rt-p', allocationMode: 'CAPACITY_PLAN', allocationStartWeek: 0, allocationEndWeek: 5 })],
        [makeNr({ id: 'nr-pf', resourceTypeId: 'rt-p', allocationMode: 'CAPACITY_PLAN', allocationStartWeek: -1, startWeek: -1, allocationEndWeek: 5, endWeek: null })],
      ),
    }])
    const report = buildReport(state, MISMATCH_COUNTS)
    expect(report.integrityResult.reconciliationPassed).toBe(true)
    const s = report.singleNegativeEntries[0]!
    // The primary supplied the effective value; the fallback is shadowed.
    expect(s.minusOneField).toBe('allocationStartWeek')
    expect(s.windowFields.startWeek).toBe('minus-one')
  })

  it('a fallback effective -1 with a null primary selects the fallback (source-based)', () => {
    const state = makeState([{
      id: 'snap-fallback-effective',
      projectId: PROJECT_ID,
      payload: makeV2Snapshot(
        [makeRt({ id: 'rt-p', allocationMode: 'CAPACITY_PLAN', allocationStartWeek: 0, allocationEndWeek: 5 })],
        [makeNr({ id: 'nr-fe', resourceTypeId: 'rt-p', allocationMode: 'CAPACITY_PLAN', allocationStartWeek: null, startWeek: -1, allocationEndWeek: 4, endWeek: 5 })],
      ),
    }])
    const report = buildReport(state, MISMATCH_COUNTS)
    expect(report.integrityResult.reconciliationPassed).toBe(true)
    expect(report.singleNegativeEntries[0]!.minusOneField).toBe('startWeek')
  })

  it('classifies the exact production S shape as deterministic, retired (no S record)', () => {
    const state = makeState([{
      id: 'snap-shadow-valid',
      projectId: PROJECT_ID,
      payload: makeV2Snapshot(
        [makeRt({ id: 'rt-p', allocationMode: 'CAPACITY_PLAN', allocationStartWeek: 0, allocationEndWeek: 5 })],
        [makeNr({ id: 'nr-sv', resourceTypeId: 'rt-p', allocationMode: 'CAPACITY_PLAN', allocationStartWeek: null, startWeek: -1, allocationEndWeek: 5, endWeek: -1 })],
      ),
    }])
    const report = buildReport(state, DETERMINISTIC_COUNTS)
    expect(report.integrityResult.reconciliationPassed).toBe(true)
    expect(report.singleNegativeEntries).toHaveLength(0)
    expect(report.observedBoundary.summary.findings.deterministic).toBe(1)
    expect(report.observedBoundary.snapshotPopulation.restorable).toBe(0)
    expect(report.observedBoundary.snapshotPopulation.defect).toBe(1)
  })
})
