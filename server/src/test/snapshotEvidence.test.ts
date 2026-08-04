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
  quarantinedEntries: 3,
  quarantinedSnapshots: 1,
  defectSnapshots: 2,
  windowlessDecisions: 39,
  singleMinusOneDecisions: 1,
  snapshotDecisions: 40,
  liveDecisions: 0,
  unsupported: 0,
  rewriteOperations: 0,
  topology11Snapshots: 1,
  topology7Snapshots: 1,
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

  it('Markdown carries every required Issue #432/#430 evidence category', () => {
    const report = buildReport(state, COMPOSITE_COUNTS)
    const markdown = renderSnapshotEvidenceMarkdown(report)
    // Topology snapshot and decision counts for both subgroups.
    expect(markdown).toContain('11-snapshot subgroup: 1 snapshots, 20 windowless decisions')
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
    const elevenRow = markdown.split('\n').find(line => line.includes('eleven-windowless-only'))!
    expect(elevenRow).toContain('alias-conflict:1')
    // Class A percentage evidence for every category (resourceType/explicit/inherited/other/unavailable).
    expect(markdown).toContain('### Class A percentage evidence (by owner kind / mode source)')
    expect(markdown).toContain('| Category | allocationPercent buckets | allocationPct buckets |')
    const resourceTypeRow = markdown.split('\n').find(line => line.startsWith('resourceType |'))!
    expect(resourceTypeRow).toContain('hundred:2')
    const inheritedRow = markdown.split('\n').find(line => line.startsWith('inherited |'))!
    expect(inheritedRow).toContain('hundred:1')
    expect(markdown).toContain('explicit |')
    expect(markdown).toContain('other |')
    expect(markdown).toContain('unavailable |')
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

  it('reports a clean single -1 shape as Class B quarantine, not an S record (no conflicts to report)', () => {
    // Classifier boundary: a single -1 with no populated alias on the -1 edge
    // and agreeing/absent aliases on the other edge matches the shared Class B
    // quarantine predicate, so the plan makes no single-negative decision and
    // the evidence command reports no S record and no alias conflicts.
    const state = makeState([{
      id: 'snap-class-b',
      projectId: PROJECT_ID,
      payload: makeV2Snapshot(
        [makeRt({ id: 'rt-o', allocationMode: 'TIMELINE', allocationStartWeek: 0, allocationEndWeek: 5 })],
        [makeNr({ resourceTypeId: 'rt-o', allocationMode: 'CAPACITY_PLAN', allocationStartWeek: -1, startWeek: null, allocationEndWeek: 5, endWeek: null })],
      ),
    }])
    const counts: Omit<SnapshotEvidenceExpected, 'fingerprint' | 'baselineStateHash'> = {
      quarantinedEntries: 1, quarantinedSnapshots: 1, defectSnapshots: 0,
      windowlessDecisions: 0, singleMinusOneDecisions: 0, snapshotDecisions: 0,
      liveDecisions: 0, unsupported: 0, rewriteOperations: 0,
      topology11Snapshots: 0, topology7Snapshots: 0,
      topology11WindowlessDecisions: 0, topology7WindowlessDecisions: 0,
      topology7SingleMinusOneDecisions: 0,
    }
    const report = buildReport(state, counts)
    // No single-negative decision exists for a clean Class B shape: the
    // evidence command reports no S record. The quarantined Class B entry is
    // outside the reviewed Class A invariant, so the run refuses (fail
    // closed) exactly as the production command would.
    expect(report.singleNegativeEntries).toHaveLength(0)
    expect(report.integrityResult.reconciliationPassed).toBe(false)
    const mismatches = report.reconciliation.details.filter(detail => detail.includes('MISMATCH'))
    expect(mismatches.map(m => m.split(':')[0])).toEqual(['class A entries reconcile', 'class A snapshots reconcile'])
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

describe('Class A affected-snapshot aggregates', () => {
  /** One Class A RT entry per snapshot with the given windows. */
  function rtOnlySnapshot(id: string, windowStart: number | null = null): StateSnapshot {
    return {
      id,
      projectId: PROJECT_ID,
      payload: makeV2Snapshot(
        [makeRt({ id: `rt-${id}`, allocationMode: 'CAPACITY_PLAN', allocationPercent: 100, allocationStartWeek: windowStart, allocationEndWeek: null })],
        [],
      ),
    }
  }

  /** One Class A NR entry (explicit CAPACITY_PLAN) with the given windows. */
  function nrOnlySnapshot(id: string): StateSnapshot {
    return {
      id,
      projectId: PROJECT_ID,
      payload: makeV2Snapshot(
        // Restorable windowed parent (not itself Class A).
        [makeRt({ id: `rt-${id}`, allocationMode: 'TIMELINE', allocationPercent: 100, allocationStartWeek: 0, allocationEndWeek: 5 })],
        [makeNr({ id: `nr-${id}`, resourceTypeId: `rt-${id}`, allocationMode: 'CAPACITY_PLAN', allocationPercent: 100, allocationPct: 100, allocationStartWeek: null, allocationEndWeek: null, startWeek: null, endWeek: null })],
      ),
    }
  }

  function countsFor(quarantinedEntries: number, quarantinedSnapshots: number): Omit<SnapshotEvidenceExpected, 'fingerprint' | 'baselineStateHash'> {
    return {
      quarantinedEntries, quarantinedSnapshots, defectSnapshots: 0,
      windowlessDecisions: 0, singleMinusOneDecisions: 0, snapshotDecisions: 0,
      liveDecisions: 0, unsupported: 0, rewriteOperations: 0,
      topology11Snapshots: 0, topology7Snapshots: 0,
      topology11WindowlessDecisions: 0, topology7WindowlessDecisions: 0,
      topology7SingleMinusOneDecisions: 0,
    }
  }

  it('counts a ResourceType-only Class A snapshot under resourceType and unavailable mode source', () => {
    const state = makeState([rtOnlySnapshot('rt-a')])
    const report = buildReport(state, countsFor(1, 1))
    expect(report.integrityResult.reconciliationPassed).toBe(true)
    expect(report.classAAggregates.affectedSnapshotsByOwnerKind).toEqual({ resourceType: 1, namedResource: 0, unavailable: 0 })
    // ResourceType-only snapshots contribute zero to every NamedResource
    // mode-source category.
    expect(report.classAAggregates.affectedSnapshotsByNamedModeSource).toEqual({ explicit: 0, inherited: 0, other: 0, unavailable: 0 })
    expect(report.classAAggregates.snapshotsByOwnerKindMix).toEqual({ resourceTypeOnly: 1, namedResourceOnly: 0, mixed: 0 })
  })

  it('counts a NamedResource-only Class A snapshot under namedResource and explicit mode source', () => {
    const state = makeState([nrOnlySnapshot('nr-a')])
    const report = buildReport(state, countsFor(1, 1))
    expect(report.integrityResult.reconciliationPassed).toBe(true)
    expect(report.classAAggregates.affectedSnapshotsByOwnerKind).toEqual({ resourceType: 0, namedResource: 1, unavailable: 0 })
    expect(report.classAAggregates.affectedSnapshotsByNamedModeSource).toEqual({ explicit: 1, inherited: 0, other: 0, unavailable: 0 })
    expect(report.classAAggregates.snapshotsByOwnerKindMix).toEqual({ resourceTypeOnly: 0, namedResourceOnly: 1, mixed: 0 })
  })

  it('counts a mixed ResourceType/NamedResource snapshot once in both owner-kind categories', () => {
    const state = makeState([{
      id: 'snap-mixed',
      projectId: PROJECT_ID,
      payload: makeV2Snapshot(
        [makeRt({ id: 'rt-mix', allocationMode: 'CAPACITY_PLAN', allocationPercent: 100, allocationStartWeek: null, allocationEndWeek: null })],
        [makeNr({ id: 'nr-mix', resourceTypeId: 'rt-mix', allocationMode: 'CAPACITY_PLAN', allocationPercent: 100, allocationPct: 100, allocationStartWeek: null, allocationEndWeek: null, startWeek: null, endWeek: null })],
      ),
    }])
    const report = buildReport(state, countsFor(2, 1))
    expect(report.integrityResult.reconciliationPassed).toBe(true)
    expect(report.classAAggregates.affectedSnapshotsByOwnerKind).toEqual({ resourceType: 1, namedResource: 1, unavailable: 0 })
    // The ResourceType entry contributes no mode-source category: only the
    // explicit NamedResource entry does.
    expect(report.classAAggregates.affectedSnapshotsByNamedModeSource).toEqual({ explicit: 1, inherited: 0, other: 0, unavailable: 0 })
    expect(report.classAAggregates.snapshotsByOwnerKindMix).toEqual({ resourceTypeOnly: 0, namedResourceOnly: 0, mixed: 1 })
  })

  it('counts a snapshot containing explicit and inherited NamedResource Class A entries once in both mode-source categories', () => {
    const state = makeState([{
      id: 'snap-both-modes',
      projectId: PROJECT_ID,
      payload: makeV2Snapshot(
        // CAPACITY_PLAN parent with absent windows: itself Class A (its
        // unavailable mode-source category) and the source of the inherited
        // mode for the raw-mode-null NamedResource.
        [makeRt({ id: 'rt-both', allocationMode: 'CAPACITY_PLAN', allocationPercent: 100, allocationStartWeek: null, allocationEndWeek: null })],
        [
          makeNr({ id: 'nr-explicit', resourceTypeId: 'rt-both', allocationMode: 'CAPACITY_PLAN', allocationPercent: 100, allocationPct: 100, allocationStartWeek: null, allocationEndWeek: null, startWeek: null, endWeek: null }),
          makeNr({ id: 'nr-inherited', resourceTypeId: 'rt-both', allocationMode: null, allocationPercent: 100, allocationPct: 100, allocationStartWeek: null, allocationEndWeek: null, startWeek: null, endWeek: null }),
        ],
      ),
    }])
    const report = buildReport(state, countsFor(3, 1))
    expect(report.integrityResult.reconciliationPassed).toBe(true)
    // byNamedModeSource counts NamedResource entries only; the ResourceType
    // entry contributes no mode-source category to either aggregate.
    expect(report.classAAggregates.byNamedModeSource).toEqual({ explicit: 1, inherited: 1, other: 0, unavailable: 0 })
    expect(report.classAAggregates.affectedSnapshotsByNamedModeSource).toEqual({ explicit: 1, inherited: 1, other: 0, unavailable: 0 })
  })

  it('counts a snapshot with genuine unavailable NamedResource provenance correctly (never Class A)', () => {
    // Shared predicate boundary: a NamedResource whose mode provenance is
    // genuinely unavailable (no explicit mode, no CAPACITY_PLAN parent)
    // resolves to a null effective mode and is therefore NOT Class A, so it
    // cannot contribute to the unavailable mode-source category. The
    // category is provably fed only by Class A NamedResource entries.
    const state = makeState([{
      id: 'snap-unavailable-provenance',
      projectId: PROJECT_ID,
      payload: makeV2Snapshot(
        [makeRt({ id: 'rt-u', allocationMode: null, allocationPercent: 100, allocationStartWeek: null, allocationEndWeek: null })],
        [makeNr({ id: 'nr-u', resourceTypeId: 'rt-u', allocationMode: null, allocationPercent: 100, allocationPct: 100, allocationStartWeek: null, allocationEndWeek: null, startWeek: null, endWeek: null })],
      ),
    }])
    const report = buildReport(state, countsFor(0, 0))
    expect(report.integrityResult.reconciliationPassed).toBe(true)
    expect(report.classAAggregates.totalEntries).toBe(0)
    expect(report.classAAggregates.affectedSnapshotsByNamedModeSource).toEqual({ explicit: 0, inherited: 0, other: 0, unavailable: 0 })
  })

  it('counts repeated Class A entries in one category as a single affected snapshot', () => {
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
    const report = buildReport(state, countsFor(2, 1))
    expect(report.integrityResult.reconciliationPassed).toBe(true)
    expect(report.classAAggregates.totalEntries).toBe(2)
    expect(report.classAAggregates.affectedSnapshotsByOwnerKind.resourceType).toBe(1)
    expect(report.classAAggregates.affectedSnapshotsByNamedModeSource).toEqual({ explicit: 0, inherited: 0, other: 0, unavailable: 0 })
  })

  it('renders both aggregates in JSON and Markdown in parity', () => {
    const state = makeState([
      rtOnlySnapshot('rt-parity'),
      nrOnlySnapshot('nr-parity'),
    ])
    const report = buildReport(state, countsFor(2, 2))
    const json = JSON.stringify(report)
    const markdown = renderSnapshotEvidenceMarkdown(report)
    expect(json).toContain('"affectedSnapshotsByOwnerKind":{"resourceType":1,"namedResource":1,"unavailable":0}')
    expect(markdown).toContain('affectedSnapshotsByOwnerKind: {"resourceType":1,"namedResource":1,"unavailable":0}')
    expect(markdown).toContain('affectedSnapshotsByNamedModeSource: {"explicit":1,"inherited":0,"other":0,"unavailable":0}')
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

  it('reproduces the production failure shape: dual-alias -1 is a plan decision that now emits one S record', () => {
    // Production regression: a raw payload holding -1 on both aliases of the
    // start edge (allocationStartWeek AND startWeek) is a plan single-negative
    // decision; the pre-fix independent raw-entry scan dropped it via the
    // one-minus-one prefilter and reported observed 0 against expected 7.
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
    // never a single-negative decision or S record. The entry instead matches
    // the shared Class B quarantine shape, so the run also refuses on the
    // reviewed Class A invariant (fail closed) exactly as on production.
    const state = makeState([{
      id: 'snap-inherited',
      projectId: PROJECT_ID,
      payload: makeV2Snapshot(
        [makeRt({ id: 'rt-parent', allocationMode: 'CAPACITY_PLAN', allocationStartWeek: 0, allocationEndWeek: 5 })],
        [makeNr({ id: 'nr-inherited', resourceTypeId: 'rt-parent', allocationMode: null, allocationPercent: 100, allocationPct: 100, allocationStartWeek: null, startWeek: -1, allocationEndWeek: 5, endWeek: null })],
      ),
    }])
    const counts: Omit<SnapshotEvidenceExpected, 'fingerprint' | 'baselineStateHash'> = {
      quarantinedEntries: 1, quarantinedSnapshots: 1, defectSnapshots: 0,
      windowlessDecisions: 0, singleMinusOneDecisions: 0, snapshotDecisions: 0,
      liveDecisions: 0, unsupported: 0, rewriteOperations: 0,
      topology11Snapshots: 0, topology7Snapshots: 0,
      topology11WindowlessDecisions: 0, topology7WindowlessDecisions: 0,
      topology7SingleMinusOneDecisions: 0,
    }
    const report = buildReport(state, counts)
    expect(report.singleNegativeEntries).toHaveLength(0)
    expect(report.integrityResult.reconciliationPassed).toBe(false)
    const mismatches = report.reconciliation.details.filter(detail => detail.includes('MISMATCH'))
    expect(mismatches.map(m => m.split(':')[0])).toEqual(['class A entries reconcile', 'class A snapshots reconcile'])
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

  it('reconciles the reviewed 18-snapshot topology shape (226 + 133/7 decisions)', () => {
    // Production-shaped topology: 10 eleven-subgroup snapshots with 21
    // windowless decisions, 1 with 16, and 7 seven-subgroup snapshots with 19
    // windowless + 1 single-negative decision each. 359 windowless + 7
    // single-negative = 366 snapshot decisions across 18 defect snapshots.
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
          [makeNr({ id: `nr-s-${i}`, resourceTypeId: rtId, allocationMode: 'CAPACITY_PLAN', allocationStartWeek: -1, startWeek: -1, allocationEndWeek: 5, endWeek: null })],
        ),
      })
    }
    const state = makeState(snapshots)
    const counts: Omit<SnapshotEvidenceExpected, 'fingerprint' | 'baselineStateHash'> = {
      quarantinedEntries: 0, quarantinedSnapshots: 0, defectSnapshots: 18,
      windowlessDecisions: 359, singleMinusOneDecisions: 7, snapshotDecisions: 366,
      liveDecisions: 0, unsupported: 0, rewriteOperations: 0,
      topology11Snapshots: 11, topology7Snapshots: 7,
      topology11WindowlessDecisions: 226, topology7WindowlessDecisions: 133,
      topology7SingleMinusOneDecisions: 7,
    }
    const report = buildReport(state, counts)
    expect(report.integrityResult.reconciliationPassed).toBe(true)
    expect(report.singleNegativeEntries).toHaveLength(7)
    expect(report.topology.elevenSnapshotSubgroup.snapshots).toBe(11)
    expect(report.topology.elevenSnapshotSubgroup.windowlessDecisions).toBe(226)
    expect(report.topology.sevenSnapshotSubgroup.windowlessDecisions).toBe(133)
    expect(report.topology.sevenSnapshotSubgroup.singleMinusOneDecisions).toBe(7)
    expect(report.topology.snapshotDecisions).toBe(366)
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
