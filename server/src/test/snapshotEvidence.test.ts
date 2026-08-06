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
  canonicalJson,
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
    expect(report.formatVersion).toBe(2)
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
  /** One windowless CAPACITY_PLAN RT entry per snapshot that remains
   * quarantined as Class A. Issue #438: the EXACT all-windowless-100% shape
   * is now restorable, so these fixtures use a non-100 percentage — outside
   * the approved predicate, still quarantined (fail closed). */
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
   * windowed parent: the snapshot stays quarantined (mixed). */
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

  it('treats an exact all-windowless-100% snapshot as restorable, never quarantined (issue #438)', () => {
    // The EXACT approved Class A shape (windowless CAPACITY_PLAN 100/100,
    // explicit modes, all entries matching) is deterministic full capacity:
    // the shared classifier verdicts it restorable, so it contributes zero
    // entries/snapshots to the quarantine Class A aggregates and produces no
    // windowless decisions.
    const state = makeState([{
      id: 'snap-exact-a',
      projectId: PROJECT_ID,
      payload: makeV2Snapshot(
        [makeRt({ id: 'rt-a1', allocationMode: 'CAPACITY_PLAN', allocationPercent: 100, allocationStartWeek: null, allocationEndWeek: null })],
        [makeNr({ id: 'nr-a1', resourceTypeId: 'rt-a1', allocationMode: 'CAPACITY_PLAN', allocationPercent: 100, allocationPct: 100, allocationStartWeek: null, allocationEndWeek: null, startWeek: null, endWeek: null })],
      ),
    }])
    const report = buildReport(state, countsFor(0, 0))
    expect(report.integrityResult.reconciliationPassed).toBe(true)
    expect(report.observedBoundary.snapshotPopulation).toEqual({ totalSnapshots: 1, restorable: 1, quarantined: 0, defect: 0 })
    expect(report.classAAggregates.totalEntries).toBe(0)
    expect(report.classAAggregates.totalSnapshots).toBe(0)
    expect(report.topology.windowlessDecisions).toBe(0)
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
    // The NamedResource carries a non-100 allocationPct so the snapshot is
    // outside the exact all-windowless-100% predicate and stays quarantined
    // (both entries remain Class A quarantine candidates).
    const state = makeState([{
      id: 'snap-mixed',
      projectId: PROJECT_ID,
      payload: makeV2Snapshot(
        [makeRt({ id: 'rt-mix', allocationMode: 'CAPACITY_PLAN', allocationPercent: 100, allocationStartWeek: null, allocationEndWeek: null })],
        [makeNr({ id: 'nr-mix', resourceTypeId: 'rt-mix', allocationMode: 'CAPACITY_PLAN', allocationPercent: 100, allocationPct: 80, allocationStartWeek: null, allocationEndWeek: null, startWeek: null, endWeek: null })],
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

// ═════════════════════════════════════════════════════════════════════════════
// Issue #440 — sanitized Class A companion evidence (evidence for the #438
// companion-rule review; never a predicate implementation)
// ═════════════════════════════════════════════════════════════════════════════

describe('Class A companion evidence (issue #440)', () => {
  /** Comprehensive selected fixture: one Class-A-quarantined snapshot
   * containing one exact Class A RT and six companions covering the
   * reachable shape categories (windowless/populated/minus-one fields,
   * explicit/inherited/absent modes, 100% and finite non-100%). */
  function companionState(): RemediationDatabaseState {
    return makeState([
      {
        id: 'snap-companions',
        projectId: PROJECT_ID,
        payload: makeV2Snapshot(
          [
            // Exact Class A ResourceType entry.
            makeRt({ id: 'rt-a', name: 'Engineers Role', allocationMode: 'CAPACITY_PLAN', allocationStartWeek: null, allocationEndWeek: null }),
            // Companion: windowless CAPACITY_PLAN at 80% (quarantine-shaped,
            // non-exact → current plan classification quarantined).
            makeRt({ id: 'rt-b', name: 'Partial Role', allocationMode: 'CAPACITY_PLAN', allocationStartWeek: null, allocationEndWeek: null, allocationPercent: 80 }),
            // Companion: windowless EFFORT at 100% (alreadyValid).
            makeRt({ id: 'rt-c', name: 'Effort Role', allocationMode: 'EFFORT', allocationStartWeek: null, allocationEndWeek: null }),
          ],
          [
            // Companion: exact S shape (raw (-1,-1) alias pair with populated
            // primary end) → deterministic zero classification.
            makeNr({ id: 'nr-s', resourceTypeId: 'rt-a', name: 'Shadowed Person', allocationMode: 'CAPACITY_PLAN', allocationPercent: 100, allocationPct: 100, allocationStartWeek: null, allocationEndWeek: 5, startWeek: -1, endWeek: -1 }),
            // Companion: explicit windowed TIMELINE at 100/100 (alreadyValid).
            makeNr({ id: 'nr-tl', resourceTypeId: 'rt-c', name: 'Timeline Person', allocationMode: 'TIMELINE', allocationPercent: 100, allocationPct: 100, allocationStartWeek: 2, allocationEndWeek: 9, startWeek: 2, endWeek: 9 }),
            // Companion: inherited CAPACITY_PLAN windowless 100/100
            // (quarantine-shaped, non-exact → quarantined).
            makeNr({ id: 'nr-inherited', resourceTypeId: 'rt-a', name: 'Inherited Person', allocationMode: null, allocationPercent: 100, allocationPct: 100, allocationStartWeek: null, allocationEndWeek: null, startWeek: null, endWeek: null }),
            // Companion: explicit EFFORT windowless 100/100 (alreadyValid).
            makeNr({ id: 'nr-effort', resourceTypeId: 'rt-c', name: 'Effort Person', allocationMode: 'EFFORT', allocationPercent: 100, allocationPct: 100, allocationStartWeek: null, allocationEndWeek: null, startWeek: null, endWeek: null }),
          ],
        ),
      },
    ])
  }

  const COMPANION_COUNTS: Omit<SnapshotEvidenceExpected, 'fingerprint' | 'baselineStateHash'> = {
    quarantinedEntries: 3,
    quarantinedSnapshots: 1,
    defectSnapshots: 0,
    windowlessDecisions: 0,
    singleMinusOneDecisions: 0,
    snapshotDecisions: 0,
    liveDecisions: 0,
    unsupported: 0,
    rewriteOperations: 0,
    topology11Snapshots: 0,
    topology7Snapshots: 0,
    topology11WindowlessDecisions: 0,
    topology7WindowlessDecisions: 0,
    topology7SingleMinusOneDecisions: 0,
  }

  it('selects the mixed Class-A-quarantined snapshot and reports population totals', () => {
    const report = buildReport(companionState(), COMPANION_COUNTS)
    expect(report.integrityResult.reconciliationPassed).toBe(true)
    expect(report.formatVersion).toBe(2)
    expect(report.classACompanionEvidence.population).toEqual({
      classAQuarantinedSnapshots: 1,
      snapshotsWithCompanions: 1,
      exactClassAResourceTypeEntries: 1,
      exactClassANamedResourceEntries: 0,
      companionResourceTypeEntries: 2,
      companionNamedResourceEntries: 4,
      totalCompanionEntries: 6,
      excludedMixedClassABSnapshots: 0,
    })
    // The current quarantine boundary of the fixture is unchanged by the
    // tooling: the same 3 entries / 1 snapshot stay quarantined.
    expect(report.observedBoundary.summary.quarantined).toBe(3)
    expect(report.observedBoundary.snapshotPopulation).toEqual({ totalSnapshots: 1, restorable: 0, quarantined: 1, defect: 0 })
  })

  it('emits deterministic sorted shape rows with fixed sanitized categories only', () => {
    const report = buildReport(companionState(), COMPANION_COUNTS)
    const rows = report.classACompanionEvidence.shapeRows
    expect(rows).toHaveLength(6)
    const rowByKind = (kind: 'resourceType' | 'namedResource', rawMode: unknown, classification: string) =>
      rows.find(row => row.entryKind === kind && (row.rawMode ?? 'null') === (rawMode ?? 'null') && row.currentPlanClassification === classification)

    // RT companion: windowless CAPACITY_PLAN at 80% → quarantined, unavailable aliases/pct.
    const rt80 = rowByKind('resourceType', 'CAPACITY_PLAN', 'quarantined')!
    expect(rt80).toMatchObject({
      parentMode: 'unavailable',
      effectiveMode: 'CAPACITY_PLAN',
      modeSource: 'unavailable',
      allocationStartWeekState: 'absent-null',
      allocationEndWeekState: 'absent-null',
      startWeekState: 'unavailable',
      endWeekState: 'unavailable',
      allocationPercentCategory: 'one-to-ninety-nine',
      allocationPctCategory: 'unavailable',
      count: 1,
    })
    // RT companion: windowless EFFORT at 100% → alreadyValid.
    const rtEffort = rowByKind('resourceType', 'EFFORT', 'alreadyValid')!
    expect(rtEffort.allocationPercentCategory).toBe('hundred')
    // NR companion: exact S shape → minus-one aliases, populated non-negative
    // primary end, explicit mode, deterministic.
    const nrS = rowByKind('namedResource', 'CAPACITY_PLAN', 'deterministic')!
    expect(nrS).toMatchObject({
      parentMode: 'CAPACITY_PLAN',
      effectiveMode: 'CAPACITY_PLAN',
      modeSource: 'explicit',
      allocationStartWeekState: 'absent-null',
      allocationEndWeekState: 'populated-nonnegative-integer',
      startWeekState: 'minus-one',
      endWeekState: 'minus-one',
      allocationPercentCategory: 'hundred',
      allocationPctCategory: 'hundred',
    })
    // NR companion: explicit windowed TIMELINE → populated non-negative
    // states, modeSource explicit (raw known mode), alreadyValid.
    const nrTl = rowByKind('namedResource', 'TIMELINE', 'alreadyValid')!
    expect(nrTl).toMatchObject({
      parentMode: 'EFFORT',
      effectiveMode: 'TIMELINE',
      modeSource: 'explicit',
      allocationStartWeekState: 'populated-nonnegative-integer',
      allocationEndWeekState: 'populated-nonnegative-integer',
      startWeekState: 'populated-nonnegative-integer',
      endWeekState: 'populated-nonnegative-integer',
      allocationPercentCategory: 'hundred',
      allocationPctCategory: 'hundred',
    })
    // NR companion: inherited CAPACITY_PLAN windowless → inherited source, quarantined.
    const nrInherited = rows.find(row => row.modeSource === 'inherited')!
    expect(nrInherited).toMatchObject({
      entryKind: 'namedResource',
      rawMode: null,
      parentMode: 'CAPACITY_PLAN',
      effectiveMode: 'CAPACITY_PLAN',
      allocationStartWeekState: 'absent-null',
      allocationEndWeekState: 'absent-null',
      startWeekState: 'absent-null',
      endWeekState: 'absent-null',
      allocationPercentCategory: 'hundred',
      allocationPctCategory: 'hundred',
      currentPlanClassification: 'quarantined',
    })
    // NR companion: explicit EFFORT windowless → modeSource explicit.
    const nrEffort = rowByKind('namedResource', 'EFFORT', 'alreadyValid')!
    expect(nrEffort.modeSource).toBe('explicit')

    // Deterministic ordering: sorted by the same canonical fixed-category
    // key the builder uses.
    const keyOf = (row: (typeof rows)[number]): string => canonicalJson({
      entryKind: row.entryKind,
      rawMode: row.rawMode,
      parentMode: row.parentMode,
      effectiveMode: row.effectiveMode,
      modeSource: row.modeSource,
      allocationStartWeekState: row.allocationStartWeekState,
      allocationEndWeekState: row.allocationEndWeekState,
      startWeekState: row.startWeekState,
      endWeekState: row.endWeekState,
      allocationPercentCategory: row.allocationPercentCategory,
      allocationPctCategory: row.allocationPctCategory,
      currentPlanClassification: row.currentPlanClassification,
    })
    const keys = rows.map(keyOf)
    expect([...keys].sort()).toEqual(keys)
    expect(rows.every(row => row.count === 1)).toBe(true)
  })

  it('reports plan classifications and snapshot-level flags', () => {
    const report = buildReport(companionState(), COMPANION_COUNTS)
    expect(report.classACompanionEvidence.planClassifications).toEqual({
      deterministic: 1,
      decisionRequired: 0,
      unsupported: 0,
      alreadyValid: 3,
      quarantined: 2,
    })
    expect(report.classACompanionEvidence.snapshotFlags).toEqual({
      allEntriesWindowless: 0,
      notAllEntriesWindowless: 1,
      allEntriesApproved100: 0,
      notAllEntriesApproved100: 1,
      allCompanionsWindowless: 0,
      notAllCompanionsWindowless: 1,
      allCompanionsApproved100: 0,
      notAllCompanionsApproved100: 1,
      anyCompanionInheritedMode: 1,
      noCompanionInheritedMode: 0,
    })
  })

  it('reconciles every aggregate and refuses on any mismatch via the shared gate', () => {
    const report = buildReport(companionState(), COMPANION_COUNTS)
    expect(report.integrityResult.countsMatch).toBe(true)
    expect(report.reconciliation.passed).toBe(true)
    const details = report.reconciliation.details.join('\n')
    expect(details).toContain('exact Class A entries plus companions equal captured entries: observed 7, expected 7 — OK')
    expect(details).toContain('companion by-kind totals reconcile: observed 6, expected 6 — OK')
    expect(details).toContain('companion shape-row counts reconcile: observed 6, expected 6 — OK')
    expect(details).toContain('companion plan-classification totals reconcile: observed 6, expected 6 — OK')
    expect(details).toContain('companion entries are unique: observed 6, expected 6 — OK')
    expect(details).toContain('no selected entry is omitted: observed 6, expected 6 — OK')
    expect(details).toContain('snapshot flag pair: entries windowless: observed 1, expected 1 — OK')
    expect(details).toContain('snapshot flag pair: companion inherited mode: observed 1, expected 1 — OK')
  })

  it('is deterministic across repeated runs', () => {
    const first = buildReport(companionState(), COMPANION_COUNTS)
    const second = buildReport(companionState(), COMPANION_COUNTS)
    expect(JSON.stringify(first.classACompanionEvidence)).toBe(JSON.stringify(second.classACompanionEvidence))
  })

  it('excludes restorable and defect snapshots from the companion population', () => {
    const state = makeState([
      {
        id: 'snap-exact',
        projectId: PROJECT_ID,
        // Exact all-Class-A snapshot → restorable under current policy, never
        // a companion population member.
        payload: makeV2Snapshot(
          [makeRt({ id: 'rt-e1', allocationMode: 'CAPACITY_PLAN', allocationStartWeek: null, allocationEndWeek: null })],
          [makeNr({ id: 'nr-e1', resourceTypeId: 'rt-e1', allocationMode: 'CAPACITY_PLAN', allocationPercent: 100, allocationPct: 100, allocationStartWeek: null, allocationEndWeek: null, startWeek: null, endWeek: null })],
        ),
      },
      {
        id: 'snap-defect',
        projectId: PROJECT_ID,
        // Independent defect (partial window) → defect snapshot, excluded.
        payload: makeV2Snapshot(
          [makeRt({ id: 'rt-d1', allocationMode: 'CAPACITY_PLAN', allocationStartWeek: 3, allocationEndWeek: null })],
          [],
        ),
      },
      {
        id: 'snap-q',
        projectId: PROJECT_ID,
        // Selected Class-A-quarantined snapshot with one companion.
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
      quarantinedEntries: 2,
      quarantinedSnapshots: 1,
      defectSnapshots: 1,
      windowlessDecisions: 1, // snap-defect partial-window RT
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
    expect(report.observedBoundary.snapshotPopulation).toEqual({ totalSnapshots: 3, restorable: 1, quarantined: 1, defect: 1 })
    expect(report.classACompanionEvidence.population).toEqual({
      classAQuarantinedSnapshots: 1,
      snapshotsWithCompanions: 1,
      exactClassAResourceTypeEntries: 1,
      exactClassANamedResourceEntries: 0,
      companionResourceTypeEntries: 1,
      companionNamedResourceEntries: 0,
      totalCompanionEntries: 1,
      excludedMixedClassABSnapshots: 0,
    })
  })

  it('excludes Class-B-only and mixed Class-A/Class-B quarantined snapshots and reports the mixed count separately', () => {
    const state = makeState([
      {
        id: 'snap-b',
        projectId: PROJECT_ID,
        // Class-B-only quarantine (single -1 edge with non-negative other).
        payload: makeV2Snapshot(
          [makeRt({ id: 'rt-b1', allocationMode: 'CAPACITY_PLAN', allocationStartWeek: -1, allocationEndWeek: 5 })],
          [],
        ),
      },
      {
        id: 'snap-mixed-ab',
        projectId: PROJECT_ID,
        // Mixed Class A + Class B quarantine: reported separately, excluded
        // from the companion population.
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
      quarantinedEntries: 3,
      quarantinedSnapshots: 2,
      defectSnapshots: 0,
      windowlessDecisions: 0,
      singleMinusOneDecisions: 0,
      snapshotDecisions: 0,
      liveDecisions: 0,
      unsupported: 0,
      rewriteOperations: 0,
      topology11Snapshots: 0,
      topology7Snapshots: 0,
      topology11WindowlessDecisions: 0,
      topology7WindowlessDecisions: 0,
      topology7SingleMinusOneDecisions: 0,
    }
    const report = buildReport(state, counts)
    // The reviewed Class A invariant (class A entries/snapshots reconcile to
    // the expected quarantine totals) intentionally refuses when quarantined
    // Class-B entries exist — the companion section is observational and must
    // not mask that refusal (mirrors the existing Class-B fixture contract).
    expect(report.integrityResult.reconciliationPassed).toBe(false)
    const mismatches = report.reconciliation.details.filter(detail => detail.includes('MISMATCH'))
    expect(mismatches.map(m => m.split(':')[0])).toEqual(['class A entries reconcile', 'class A snapshots reconcile'])
    expect(report.classACompanionEvidence.population).toEqual({
      classAQuarantinedSnapshots: 0,
      snapshotsWithCompanions: 0,
      exactClassAResourceTypeEntries: 0,
      exactClassANamedResourceEntries: 0,
      companionResourceTypeEntries: 0,
      companionNamedResourceEntries: 0,
      totalCompanionEntries: 0,
      excludedMixedClassABSnapshots: 1,
    })
    expect(report.classACompanionEvidence.shapeRows).toEqual([])
  })

  it('selects a Class-A-quarantined snapshot while excluding a restorable one', () => {
    const state = makeState([
      {
        id: 'snap-q',
        projectId: PROJECT_ID,
        payload: makeV2Snapshot(
          [
            makeRt({ id: 'rt-q1', allocationMode: 'CAPACITY_PLAN', allocationStartWeek: null, allocationEndWeek: null }),
            makeRt({ id: 'rt-q2', allocationMode: 'CAPACITY_PLAN', allocationStartWeek: null, allocationEndWeek: null, allocationPercent: 80 }),
          ],
          [],
        ),
      },
      {
        id: 'snap-r',
        projectId: PROJECT_ID,
        payload: makeV2Snapshot(
          [makeRt({ id: 'rt-r1', allocationMode: 'CAPACITY_PLAN', allocationStartWeek: null, allocationEndWeek: null })],
          [],
        ),
      },
    ])
    const counts: Omit<SnapshotEvidenceExpected, 'fingerprint' | 'baselineStateHash'> = {
      quarantinedEntries: 2,
      quarantinedSnapshots: 1,
      defectSnapshots: 0,
      windowlessDecisions: 0,
      singleMinusOneDecisions: 0,
      snapshotDecisions: 0,
      liveDecisions: 0,
      unsupported: 0,
      rewriteOperations: 0,
      topology11Snapshots: 0,
      topology7Snapshots: 0,
      topology11WindowlessDecisions: 0,
      topology7WindowlessDecisions: 0,
      topology7SingleMinusOneDecisions: 0,
    }
    const report = buildReport(state, counts)
    expect(report.integrityResult.reconciliationPassed).toBe(true)
    expect(report.classACompanionEvidence.population).toEqual({
      classAQuarantinedSnapshots: 1,
      snapshotsWithCompanions: 1,
      exactClassAResourceTypeEntries: 1,
      exactClassANamedResourceEntries: 0,
      companionResourceTypeEntries: 1,
      companionNamedResourceEntries: 0,
      totalCompanionEntries: 1,
      excludedMixedClassABSnapshots: 0,
    })
    expect(report.observedBoundary.snapshotPopulation).toEqual({ totalSnapshots: 2, restorable: 1, quarantined: 1, defect: 0 })
  })

  it('fails closed when companion correlation is ambiguous (shared id across kinds)', () => {
    const state = makeState([{
      id: 'snap-ambig',
      projectId: PROJECT_ID,
      payload: makeV2Snapshot(
        [makeRt({ id: 'same-id', allocationMode: 'CAPACITY_PLAN', allocationStartWeek: null, allocationEndWeek: null })],
        [
          // Companion whose entryId collides with the exact RT entry's id:
          // two snapshot-entry findings match the same entryId → ambiguous.
          makeNr({ id: 'same-id', resourceTypeId: 'same-id', allocationMode: null, allocationPercent: 100, allocationPct: 100, allocationStartWeek: null, allocationEndWeek: null, startWeek: null, endWeek: null }),
        ],
      ),
    }])
    const counts: Omit<SnapshotEvidenceExpected, 'fingerprint' | 'baselineStateHash'> = {
      quarantinedEntries: 2,
      quarantinedSnapshots: 1,
      defectSnapshots: 0,
      windowlessDecisions: 0,
      singleMinusOneDecisions: 0,
      snapshotDecisions: 0,
      liveDecisions: 0,
      unsupported: 0,
      rewriteOperations: 0,
      topology11Snapshots: 0,
      topology7Snapshots: 0,
      topology11WindowlessDecisions: 0,
      topology7WindowlessDecisions: 0,
      topology7SingleMinusOneDecisions: 0,
    }
    expect(() => buildReport(state, counts)).toThrowError(SnapshotEvidenceError)
    try {
      buildReport(state, counts)
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(SnapshotEvidenceError)
      expect((error as SnapshotEvidenceError).code).toBe('companion-correlation-failure')
      expect(String((error as SnapshotEvidenceError).message)).not.toContain('same-id')
    }
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
        // Unknown mode → defect snapshot (excluded population); the arbitrary
        // string must never reach either output.
        payload: makeV2Snapshot(
          [makeRt({ id: 'rt-9', allocationMode: 'WARP_DRIVE-TOP-SECRET', allocationStartWeek: 2, allocationEndWeek: 9 })],
          [],
        ),
      },
    ])
    const counts: Omit<SnapshotEvidenceExpected, 'fingerprint' | 'baselineStateHash'> = {
      quarantinedEntries: 2,
      quarantinedSnapshots: 1,
      defectSnapshots: 1,
      windowlessDecisions: 0,
      singleMinusOneDecisions: 0,
      snapshotDecisions: 0,
      liveDecisions: 0,
      unsupported: 1,
      rewriteOperations: 0,
      topology11Snapshots: 1,
      topology7Snapshots: 0,
      topology11WindowlessDecisions: 0,
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
    // Populated week numbers are reduced to sanitized categories: the raw -1
    // sentinel and the populated weeks never appear in the companion section.
    expect(sectionJson).not.toContain('-1')
    expect(sectionJson).not.toContain('17')
    expect(sectionJson).not.toContain('23')
    // Every shape-row category uses the fixed vocabularies only.
    const windowStates = ['unavailable', 'absent-null', 'minus-one', 'populated-nonnegative-integer', 'populated-other']
    const percentCategories = ['unavailable', 'absent-null', 'zero', 'one-to-ninety-nine', 'hundred', 'above-hundred', 'invalid-non-finite']
    const modes = ['TIMELINE', 'CAPACITY_PLAN', 'EFFORT', 'FULL_PROJECT', null, 'other', 'unavailable']
    const classifications = ['deterministic', 'decisionRequired', 'unsupported', 'alreadyValid', 'quarantined']
    for (const row of report.classACompanionEvidence.shapeRows) {
      expect(['resourceType', 'namedResource']).toContain(row.entryKind)
      expect(modes).toContain(row.rawMode)
      expect(modes).toContain(row.parentMode)
      expect(modes).toContain(row.effectiveMode)
      expect(['explicit', 'inherited', 'other', 'unavailable']).toContain(row.modeSource)
      expect(windowStates).toContain(row.allocationStartWeekState)
      expect(windowStates).toContain(row.allocationEndWeekState)
      expect(windowStates).toContain(row.startWeekState)
      expect(windowStates).toContain(row.endWeekState)
      expect(percentCategories).toContain(row.allocationPercentCategory)
      expect(percentCategories).toContain(row.allocationPctCategory)
      expect(classifications).toContain(row.currentPlanClassification)
      expect(Number.isInteger(row.count) && row.count >= 0).toBe(true)
    }
  })

  it('mirrors the companion evidence in Markdown (JSON/Markdown parity)', () => {
    const report = buildReport(companionState(), COMPANION_COUNTS)
    const markdown = renderSnapshotEvidenceMarkdown(report)
    expect(markdown).toContain('## Class A companion evidence')
    expect(markdown).toContain('### Population')
    expect(markdown).toContain('- classAQuarantinedSnapshots: 1')
    expect(markdown).toContain('- totalCompanionEntries: 6')
    expect(markdown).toContain('- excludedMixedClassABSnapshots: 0')
    expect(markdown).toContain('### Companion shape rows')
    expect(markdown).toContain('| Entry kind | Raw mode | Parent mode | Effective mode | Mode source | allocationStartWeek | allocationEndWeek | startWeek | endWeek | allocationPercent | allocationPct | Plan classification | Count |')
    expect(markdown).toContain('namedResource | CAPACITY_PLAN | CAPACITY_PLAN | CAPACITY_PLAN | explicit | absent-null | populated-nonnegative-integer | minus-one | minus-one | hundred | hundred | deterministic | 1')
    expect(markdown).toContain('### Plan classifications')
    expect(markdown).toContain('- alreadyValid: 3')
    expect(markdown).toContain('- quarantined: 2')
    expect(markdown).toContain('### Snapshot-level flags')
    expect(markdown).toContain('- anyCompanionInheritedMode: 1')
    expect(markdown).toContain('- noCompanionInheritedMode: 0')
  })

  it('companionModeSourceCategory distinguishes explicit and inherited modes for all known modes', () => {
    // Explicit known raw modes (issue #440 review: the companion evidence
    // must not reuse the CAPACITY_PLAN-specific namedModeSourceCategory).
    expect(companionModeSourceCategory('TIMELINE', null)).toBe('explicit')
    expect(companionModeSourceCategory('CAPACITY_PLAN', null)).toBe('explicit')
    expect(companionModeSourceCategory('EFFORT', null)).toBe('explicit')
    expect(companionModeSourceCategory('FULL_PROJECT', null)).toBe('explicit')
    expect(companionModeSourceCategory('TIMELINE', 'WARP_DRIVE')).toBe('explicit')
    // Inherited known parent modes (including the missed non-CAPACITY_PLAN
    // regression).
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

  it('reports explicit and inherited mode sources through the builder, including non-CAPACITY_PLAN inheritance', () => {
    // One selected Class-A-quarantined snapshot whose companions cover the
    // reachable mode-source categories. No classifier or predicate is
    // weakened: every entry is valid under the current policy and the
    // snapshot stays quarantined via the non-100 windowless RT.
    const state = makeState([{
      id: 'snap-modes',
      projectId: PROJECT_ID,
      payload: makeV2Snapshot(
        [
          // Quarantine Class A shape (non-exact: 80%) keeps the snapshot
          // selected; this RT companion itself reports modeSource unavailable.
          makeRt({ id: 'rt-q', allocationMode: 'CAPACITY_PLAN', allocationStartWeek: null, allocationEndWeek: null, allocationPercent: 80 }),
          makeRt({ id: 'rt-t', name: 'Timeline Role', allocationMode: 'TIMELINE', allocationStartWeek: null, allocationEndWeek: null }),
          makeRt({ id: 'rt-e', name: 'Effort Role', allocationMode: 'EFFORT', allocationStartWeek: null, allocationEndWeek: null }),
          makeRt({ id: 'rt-f', name: 'Full Project Role', allocationMode: 'FULL_PROJECT', allocationStartWeek: null, allocationEndWeek: null }),
          makeRt({ id: 'rt-null', name: 'Null Mode Role', allocationMode: null, allocationStartWeek: null, allocationEndWeek: null }),
        ],
        [
          // Inherited known modes with raw allocationMode absent.
          makeNr({ id: 'nr-inh-tl', resourceTypeId: 'rt-t', allocationMode: null }),
          makeNr({ id: 'nr-inh-eff', resourceTypeId: 'rt-e', allocationMode: null }),
          makeNr({ id: 'nr-inh-fp', resourceTypeId: 'rt-f', allocationMode: null }),
          makeNr({ id: 'nr-inh-cp', resourceTypeId: 'rt-q', allocationMode: null }),
          // Explicit known raw mode.
          makeNr({ id: 'nr-exp-tl', resourceTypeId: 'rt-t', allocationMode: 'TIMELINE' }),
          // Absent raw and absent parent mode → unavailable.
          makeNr({ id: 'nr-none', resourceTypeId: 'rt-null', allocationMode: null }),
        ],
      ),
    }])
    const counts: Omit<SnapshotEvidenceExpected, 'fingerprint' | 'baselineStateHash'> = {
      quarantinedEntries: 2,
      quarantinedSnapshots: 1,
      defectSnapshots: 0,
      windowlessDecisions: 0,
      singleMinusOneDecisions: 0,
      snapshotDecisions: 0,
      liveDecisions: 0,
      unsupported: 0,
      rewriteOperations: 0,
      topology11Snapshots: 0,
      topology7Snapshots: 0,
      topology11WindowlessDecisions: 0,
      topology7WindowlessDecisions: 0,
      topology7SingleMinusOneDecisions: 0,
    }
    const report = buildReport(state, counts)
    expect(report.integrityResult.reconciliationPassed).toBe(true)
    const rows = report.classACompanionEvidence.shapeRows
    const inheritedRow = (parentMode: 'TIMELINE' | 'EFFORT' | 'FULL_PROJECT' | 'CAPACITY_PLAN' | null, effectiveMode: string | null) =>
      rows.find(row => row.entryKind === 'namedResource' && row.modeSource === 'inherited' && row.parentMode === parentMode && row.effectiveMode === effectiveMode)
    // Inherited known modes from non-CAPACITY_PLAN parents (the missed
    // regression) and from CAPACITY_PLAN.
    expect(inheritedRow('TIMELINE', 'TIMELINE')).toMatchObject({ modeSource: 'inherited', rawMode: null })
    expect(inheritedRow('EFFORT', 'EFFORT')).toMatchObject({ modeSource: 'inherited', rawMode: null })
    expect(inheritedRow('FULL_PROJECT', 'FULL_PROJECT')).toMatchObject({ modeSource: 'inherited', rawMode: null })
    expect(inheritedRow('CAPACITY_PLAN', 'CAPACITY_PLAN')).toMatchObject({ modeSource: 'inherited', rawMode: null })
    // Explicit known raw mode.
    const explicitTimeline = rows.find(row => row.entryKind === 'namedResource' && row.rawMode === 'TIMELINE' && row.modeSource === 'explicit')!
    expect(explicitTimeline).toMatchObject({ effectiveMode: 'TIMELINE', parentMode: 'TIMELINE' })
    // Absent raw + absent parent → unavailable (fixture-reachable state).
    const unavailable = rows.find(row => row.entryKind === 'namedResource' && row.modeSource === 'unavailable')!
    expect(unavailable).toMatchObject({ rawMode: null, parentMode: null, effectiveMode: null })
    // ResourceType companions keep modeSource unavailable.
    const rtCompanion = rows.find(row => row.entryKind === 'resourceType')!
    expect(rtCompanion.modeSource).toBe('unavailable')
    // Snapshot-level flag: inheritance from non-CAPACITY_PLAN parents counts.
    expect(report.classACompanionEvidence.snapshotFlags.anyCompanionInheritedMode).toBe(1)
    expect(report.classACompanionEvidence.snapshotFlags.noCompanionInheritedMode).toBe(0)
  })

  it('reports the complementary no-inherited flag for a snapshot without inherited companions', () => {
    const state = makeState([{
      id: 'snap-no-inherited',
      projectId: PROJECT_ID,
      payload: makeV2Snapshot(
        [
          makeRt({ id: 'rt-q', allocationMode: 'CAPACITY_PLAN', allocationStartWeek: null, allocationEndWeek: null, allocationPercent: 80 }),
          makeRt({ id: 'rt-t', allocationMode: 'TIMELINE', allocationStartWeek: null, allocationEndWeek: null }),
        ],
        [
          // Explicit known mode only — no inherited companion in this snapshot.
          makeNr({ id: 'nr-exp', resourceTypeId: 'rt-t', allocationMode: 'TIMELINE' }),
        ],
      ),
    }])
    const counts: Omit<SnapshotEvidenceExpected, 'fingerprint' | 'baselineStateHash'> = {
      quarantinedEntries: 1,
      quarantinedSnapshots: 1,
      defectSnapshots: 0,
      windowlessDecisions: 0,
      singleMinusOneDecisions: 0,
      snapshotDecisions: 0,
      liveDecisions: 0,
      unsupported: 0,
      rewriteOperations: 0,
      topology11Snapshots: 0,
      topology7Snapshots: 0,
      topology11WindowlessDecisions: 0,
      topology7WindowlessDecisions: 0,
      topology7SingleMinusOneDecisions: 0,
    }
    const report = buildReport(state, counts)
    expect(report.integrityResult.reconciliationPassed).toBe(true)
    expect(report.classACompanionEvidence.snapshotFlags.anyCompanionInheritedMode).toBe(0)
    expect(report.classACompanionEvidence.snapshotFlags.noCompanionInheritedMode).toBe(1)
    const explicit = report.classACompanionEvidence.shapeRows.find(
      row => row.entryKind === 'namedResource' && row.rawMode === 'TIMELINE',
    )!
    expect(explicit.modeSource).toBe('explicit')
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

  // Issue #438: the exact S shape is deterministic zero, so the containing
  // windowed-parent snapshot is restorable — no defect, no decision, no S
  // record.
  const DETERMINISTIC_COUNTS: Omit<SnapshotEvidenceExpected, 'fingerprint' | 'baselineStateHash'> = {
    quarantinedEntries: 0, quarantinedSnapshots: 0, defectSnapshots: 0,
    windowlessDecisions: 0, singleMinusOneDecisions: 0, snapshotDecisions: 0,
    liveDecisions: 0, unsupported: 0, rewriteOperations: 0,
    topology11Snapshots: 0, topology7Snapshots: 0,
    topology11WindowlessDecisions: 0, topology7WindowlessDecisions: 0,
    topology7SingleMinusOneDecisions: 0,
  }

  it('classifies the exact production S shape as deterministic zero, never an S record (issue #438)', () => {
    // Production shape: allocationStartWeek null, startWeek -1 (raw alias
    // start), allocationEndWeek 5 (populated primary end), endWeek -1 (raw
    // alias end). The raw (-1,-1) alias pair is the scheduler-consumed
    // never-active sentinel: deterministic zero capacity. The containing
    // snapshot (windowed CAPACITY_PLAN parent + S entry) is restorable; no
    // single-negative decision exists and no S record is emitted.
    const state = shadowState({ allocationStartWeek: null, startWeek: -1, allocationEndWeek: 5, endWeek: -1 })
    const report = buildReport(state, DETERMINISTIC_COUNTS)
    expect(report.integrityResult.reconciliationPassed).toBe(true)
    expect(report.singleNegativeEntries).toHaveLength(0)
    expect(report.observedBoundary.snapshotPopulation).toEqual({ totalSnapshots: 1, restorable: 1, quarantined: 0, defect: 0 })
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
      quarantinedEntries: 0, quarantinedSnapshots: 0, defectSnapshots: 0,
      windowlessDecisions: 0, singleMinusOneDecisions: 0, snapshotDecisions: 0,
      liveDecisions: 0, unsupported: 0, rewriteOperations: 0,
      topology11Snapshots: 0, topology7Snapshots: 0,
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

  it('emits no S records for seven exact S entries; the windowless companions keep the snapshots quarantined', () => {
    // Each snapshot: one windowless CAPACITY_PLAN RT (outside the exact
    // snapshot-wide Class A condition — the S entry is not windowless) and
    // one exact S entry. Issue #438: the S entry is a deterministic finding
    // (no single-negative decision, no S record) while the windowless RT
    // keeps the snapshot quarantined Class A.
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
      quarantinedEntries: 7, quarantinedSnapshots: 7, defectSnapshots: 0,
      windowlessDecisions: 0, singleMinusOneDecisions: 0, snapshotDecisions: 0,
      liveDecisions: 0, unsupported: 0, rewriteOperations: 0,
      topology11Snapshots: 0, topology7Snapshots: 0,
      topology11WindowlessDecisions: 0, topology7WindowlessDecisions: 0,
      topology7SingleMinusOneDecisions: 0,
    }
    const report = buildReport(state, counts)
    expect(report.integrityResult.reconciliationPassed).toBe(true)
    expect(report.singleNegativeEntries).toHaveLength(0)
    expect(report.observedBoundary.summary.findings.deterministic).toBe(7)
    expect(report.observedBoundary.summary.quarantined).toBe(7)
    expect(report.observedBoundary.snapshotPopulation.quarantined).toBe(7)
    expect(report.classAAggregates.totalEntries).toBe(7)
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

  // Issue #438: the exact S shape is deterministic zero — the containing
  // windowed-parent snapshot is restorable, no single-negative decision
  // exists and no S record is emitted.
  const DETERMINISTIC_COUNTS: Omit<SnapshotEvidenceExpected, 'fingerprint' | 'baselineStateHash'> = {
    quarantinedEntries: 0, quarantinedSnapshots: 0, defectSnapshots: 0,
    windowlessDecisions: 0, singleMinusOneDecisions: 0, snapshotDecisions: 0,
    liveDecisions: 0, unsupported: 0, rewriteOperations: 0,
    topology11Snapshots: 0, topology7Snapshots: 0,
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

  it('classifies the exact production S shape as deterministic (no S record)', () => {
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
    expect(report.observedBoundary.snapshotPopulation.restorable).toBe(1)
  })
})
