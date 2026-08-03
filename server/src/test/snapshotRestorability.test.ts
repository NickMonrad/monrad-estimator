/**
 * snapshotRestorability.test.ts — Pure unit tests for the issue #428
 * derived-quarantine classifier (no database).
 *
 * Coverage (policy #426, Sections 3–4):
 *   - Class A (windowless CAPACITY_PLAN) and Class B (single -1 edge) for
 *     ResourceType and NamedResource entries, including explicit-mode
 *     overrides and inherited modes;
 *   - snapshot-level at-least-one/mixed rules;
 *   - deterministic restorable shapes (never-active windows, valid
 *     non-CAPACITY_PLAN modes, V1/V3/V4);
 *   - blocking defects (partial windows, negative/fractional values, alias
 *     conflicts, orphan owners, unknown modes, malformed payloads, mixed
 *     quarantine-and-defect snapshots).
 */
import { describe, expect, it } from 'vitest'
import {
  classifySnapshotRestorability,
  classifyV2QuarantineShape,
  QUARANTINE_CLASS_A_REASON,
  QUARANTINE_CLASS_B_REASON,
  type V2QuarantineWindowFields,
} from '../lib/snapshotRestorability.js'

// ─── Fixture helpers ────────────────────────────────────────────────────────

interface RtFixture {
  id?: string
  name?: string
  allocationMode?: string | null
  allocationPercent?: number | null
  allocationStartWeek?: number | null
  allocationEndWeek?: number | null
}

interface NrFixture {
  id?: string
  name?: string
  resourceTypeId?: string | null
  allocationMode?: string | null
  allocationPercent?: number | null
  allocationPct?: number | null
  allocationStartWeek?: number | null
  allocationEndWeek?: number | null
  startWeek?: number | null
  endWeek?: number | null
}

function makeResourceType(overrides: RtFixture = {}) {
  return {
    id: 'rt-1',
    name: 'Engineer',
    category: 'ENGINEERING',
    count: 1,
    hoursPerDay: null,
    dayRate: null,
    globalTypeId: null,
    allocationMode: 'EFFORT',
    allocationPercent: 100,
    allocationStartWeek: null,
    allocationEndWeek: null,
    ...overrides,
  }
}

function makeNamedResource(overrides: NrFixture = {}) {
  return {
    id: 'nr-1',
    resourceTypeId: 'rt-1',
    name: 'Alice',
    startWeek: null,
    endWeek: null,
    allocationPct: null,
    allocationMode: 'EFFORT',
    allocationPercent: 100,
    allocationStartWeek: null,
    allocationEndWeek: null,
    pricingModel: 'ACTUAL_DAYS',
    ...overrides,
  }
}

function makeV2(resourceTypes: Array<ReturnType<typeof makeResourceType>>, namedResources: Array<ReturnType<typeof makeNamedResource>> = []) {
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

const CAPACITY_PLAN_RT_A = makeResourceType({ allocationMode: 'CAPACITY_PLAN', allocationStartWeek: null, allocationEndWeek: null })
const CAPACITY_PLAN_RT_B_START = makeResourceType({ allocationMode: 'CAPACITY_PLAN', allocationStartWeek: -1, allocationEndWeek: 5 })
const CAPACITY_PLAN_RT_B_END = makeResourceType({ allocationMode: 'CAPACITY_PLAN', allocationStartWeek: 0, allocationEndWeek: -1 })

// ─── Raw shape predicate ────────────────────────────────────────────────────

describe('classifyV2QuarantineShape', () => {
  const fields = (overrides: Partial<V2QuarantineWindowFields> = {}): V2QuarantineWindowFields => ({
    primaryStart: null,
    aliasStart: null,
    primaryEnd: null,
    aliasEnd: null,
    ...overrides,
  })

  it('Class A: both effective edges absent', () => {
    expect(classifyV2QuarantineShape(fields())).toBe('A')
    expect(classifyV2QuarantineShape(fields({ primaryStart: null, aliasStart: null }))).toBe('A')
  })

  it('Class B: single -1 on either edge with non-negative other edge', () => {
    expect(classifyV2QuarantineShape(fields({ primaryStart: -1, primaryEnd: 5 }))).toBe('B')
    expect(classifyV2QuarantineShape(fields({ primaryStart: 0, primaryEnd: -1 }))).toBe('B')
  })

  it('Class B: -1 supplied through the fallback alias', () => {
    expect(classifyV2QuarantineShape(fields({ aliasStart: -1, primaryEnd: 5 }))).toBe('B')
    expect(classifyV2QuarantineShape(fields({ primaryStart: -1, aliasEnd: 8 }))).toBe('B')
  })

  it('never Class B: (-1, -1), -1 plus null, values below -1, fractional, double -1 aliases', () => {
    expect(classifyV2QuarantineShape(fields({ primaryStart: -1, primaryEnd: -1 }))).toBeNull()
    expect(classifyV2QuarantineShape(fields({ primaryStart: -1, primaryEnd: null }))).toBeNull()
    expect(classifyV2QuarantineShape(fields({ primaryStart: -1, primaryEnd: 0, aliasEnd: null }))).toBe('B')
    expect(classifyV2QuarantineShape(fields({ primaryStart: -2, primaryEnd: 5 }))).toBeNull()
    expect(classifyV2QuarantineShape(fields({ primaryStart: 1.5, primaryEnd: 5 }))).toBeNull()
    expect(classifyV2QuarantineShape(fields({ primaryStart: -1, aliasStart: -1, primaryEnd: 5 }))).toBeNull()
  })

  it('never Class B: conflicting or negative aliases', () => {
    // The -1 edge's other alias carries a conflicting value.
    expect(classifyV2QuarantineShape(fields({ primaryStart: -1, aliasStart: 3, primaryEnd: 5 }))).toBeNull()
    // A negative non--1 populated alias on the other edge.
    expect(classifyV2QuarantineShape(fields({ primaryStart: -1, primaryEnd: 5, aliasEnd: -1 }))).toBeNull()
    // The non-negative edge's aliases disagree.
    expect(classifyV2QuarantineShape(fields({ primaryStart: -1, primaryEnd: 5, aliasEnd: 9 }))).toBeNull()
    // A -1 in a non-effective alias: effective start is the primary value.
    expect(classifyV2QuarantineShape(fields({ primaryStart: 3, aliasStart: -1, primaryEnd: 9 }))).toBeNull()
  })

  it('Class B: agreeing duplicate aliases on the non-negative edge are accepted', () => {
    expect(classifyV2QuarantineShape(fields({ primaryStart: -1, primaryEnd: 5, aliasEnd: 5 }))).toBe('B')
  })
})

// ─── Quarantined (Class A / Class B) ────────────────────────────────────────

describe('classifySnapshotRestorability — quarantined', () => {
  const classify = (snapshot: unknown) => classifySnapshotRestorability(snapshot, 'proj-1')

  it('ResourceType Class A — windowless CAPACITY_PLAN', () => {
    const verdict = classify(makeV2([CAPACITY_PLAN_RT_A]))
    expect(verdict.kind).toBe('quarantined')
    expect(verdict.restoreStatus).toBe('non-restorable')
    expect(verdict.restoreReason).toBe(QUARANTINE_CLASS_A_REASON)
    if (verdict.kind === 'quarantined') {
      expect(verdict.quarantineClasses).toEqual(['A'])
    }
  })

  it('ResourceType Class B — -1 on either edge', () => {
    expect(classify(makeV2([CAPACITY_PLAN_RT_B_START])).kind).toBe('quarantined')
    expect(classify(makeV2([CAPACITY_PLAN_RT_B_END])).kind).toBe('quarantined')
    const verdict = classify(makeV2([CAPACITY_PLAN_RT_B_START]))
    expect(verdict.kind).toBe('quarantined')
    if (verdict.kind === 'quarantined') {
      expect(verdict.restoreReason).toBe(QUARANTINE_CLASS_B_REASON)
    }
  })

  it('NamedResource Class A — explicit CAPACITY_PLAN, all aliases absent', () => {
    const nr = makeNamedResource({
      allocationMode: 'CAPACITY_PLAN',
      allocationStartWeek: null,
      allocationEndWeek: null,
      startWeek: null,
      endWeek: null,
    })
    const verdict = classify(makeV2([makeResourceType({ allocationMode: 'EFFORT' })], [nr]))
    expect(verdict.kind).toBe('quarantined')
  })

  it('NamedResource Class A — mode inherited from parent CAPACITY_PLAN', () => {
    const nr = makeNamedResource({
      allocationMode: null,
      allocationStartWeek: null,
      allocationEndWeek: null,
      startWeek: null,
      endWeek: null,
    })
    const verdict = classify(makeV2([CAPACITY_PLAN_RT_A], [nr]))
    expect(verdict.kind).toBe('quarantined')
  })

  it('NamedResource Class B — mode inherited from parent CAPACITY_PLAN, -1 edge', () => {
    const nr = makeNamedResource({
      allocationMode: null,
      allocationStartWeek: -1,
      allocationEndWeek: 5,
    })
    const verdict = classify(makeV2([CAPACITY_PLAN_RT_A], [nr]))
    expect(verdict.kind).toBe('quarantined')
    if (verdict.kind === 'quarantined') {
      expect(verdict.quarantineClasses).toEqual(['A', 'B'])
    }
  })

  it('NamedResource Class B — single -1 through the fallback alias', () => {
    const nr = makeNamedResource({
      allocationMode: 'CAPACITY_PLAN',
      allocationStartWeek: null,
      allocationEndWeek: null,
      startWeek: -1,
      endWeek: 8,
    })
    expect(classify(makeV2([makeResourceType()], [nr])).kind).toBe('quarantined')
  })

  it('NamedResource explicit CAPACITY_PLAN overrides a non-capacity parent', () => {
    const parent = makeResourceType({ allocationMode: 'TIMELINE', allocationStartWeek: 0, allocationEndWeek: 9 })
    const nr = makeNamedResource({
      allocationMode: 'CAPACITY_PLAN',
      allocationStartWeek: null,
      allocationEndWeek: null,
      startWeek: null,
      endWeek: null,
    })
    expect(classify(makeV2([parent], [nr])).kind).toBe('quarantined')
  })

  it('multiple quarantine entries in one snapshot', () => {
    const snapshot = makeV2([
      CAPACITY_PLAN_RT_A,
      makeResourceType({ id: 'rt-2', name: 'Designer', allocationMode: 'CAPACITY_PLAN', allocationStartWeek: null, allocationEndWeek: null }),
    ])
    const verdict = classify(snapshot)
    expect(verdict.kind).toBe('quarantined')
    expect(verdict.kind === 'quarantined' && verdict.quarantineClasses).toEqual(['A', 'A'])
  })

  it('quarantine entries mixed with valid entries', () => {
    const validRt = makeResourceType({ id: 'rt-2', name: 'Valid', allocationMode: 'TIMELINE', allocationStartWeek: 2, allocationEndWeek: 9 })
    const validNr = makeNamedResource({ id: 'nr-2', resourceTypeId: 'rt-2', allocationMode: 'TIMELINE', allocationStartWeek: 2, allocationEndWeek: 9 })
    const verdict = classify(makeV2([CAPACITY_PLAN_RT_A, validRt], [validNr]))
    expect(verdict.kind).toBe('quarantined')
  })

  it('quarantine is deterministic and idempotent', () => {
    const snapshot = makeV2([CAPACITY_PLAN_RT_A])
    const first = classify(snapshot)
    const second = classify(JSON.parse(JSON.stringify(snapshot)))
    expect(second).toEqual(first)
  })
})

// ─── Restorable ─────────────────────────────────────────────────────────────

describe('classifySnapshotRestorability — restorable', () => {
  const classify = (snapshot: unknown) => classifySnapshotRestorability(snapshot, 'proj-1')
  const expectRestorable = (snapshot: unknown) => {
    const verdict = classify(snapshot)
    expect(verdict.restoreStatus).toBe('restorable')
    expect(verdict.restoreReason).toBeNull()
  }

  it('(-1, -1) never-active CAPACITY_PLAN pair', () => {
    expectRestorable(makeV2([makeResourceType({ allocationMode: 'CAPACITY_PLAN', allocationStartWeek: -1, allocationEndWeek: -1 })]))
  })

  it('non-negative inverted never-active window (start > end)', () => {
    expectRestorable(makeV2([makeResourceType({ allocationMode: 'CAPACITY_PLAN', allocationStartWeek: 5, allocationEndWeek: 3 })]))
  })

  it('TIMELINE with null/null effective windows (unbounded)', () => {
    expectRestorable(makeV2([makeResourceType({ allocationMode: 'TIMELINE', allocationStartWeek: null, allocationEndWeek: null })]))
  })

  it('TIMELINE with valid captured non-negative windows', () => {
    expectRestorable(makeV2([makeResourceType({ allocationMode: 'TIMELINE', allocationStartWeek: 2, allocationEndWeek: 9 })]))
  })

  it('EFFORT, FULL_PROJECT and null effective modes discard stale windows', () => {
    expectRestorable(makeV2([makeResourceType({ allocationMode: 'EFFORT', allocationStartWeek: 2, allocationEndWeek: 9 })]))
    expectRestorable(makeV2([makeResourceType({ allocationMode: 'FULL_PROJECT', allocationStartWeek: 2, allocationEndWeek: 9 })]))
    expectRestorable(makeV2([makeResourceType({ allocationMode: null, allocationStartWeek: 2, allocationEndWeek: 9 })]))
  })

  it('NamedResource explicit TIMELINE overrides a CAPACITY_PLAN parent', () => {
    // The parent itself carries a valid captured window so the snapshot is
    // fully restorable; only the NamedResource explicit mode override is
    // exercised here.
    const parent = makeResourceType({ allocationMode: 'CAPACITY_PLAN', allocationStartWeek: 0, allocationEndWeek: 10 })
    const nr = makeNamedResource({
      allocationMode: 'TIMELINE',
      allocationStartWeek: 1,
      allocationEndWeek: 4,
    })
    expectRestorable(makeV2([parent], [nr]))
  })

  it('NamedResource mode inherited from a TIMELINE parent', () => {
    const parent = makeResourceType({ allocationMode: 'TIMELINE', allocationStartWeek: null, allocationEndWeek: null })
    const nr = makeNamedResource({ allocationMode: null })
    expectRestorable(makeV2([parent], [nr]))
  })

  it('CAPACITY_PLAN with a valid captured window', () => {
    expectRestorable(makeV2([makeResourceType({ allocationMode: 'CAPACITY_PLAN', allocationStartWeek: 0, allocationEndWeek: 10 })]))
  })

  it('V1 snapshot (epic-only)', () => {
    expectRestorable([{ id: 'e1', name: 'Epic 1', features: [] }])
  })

  it('valid V3 snapshot', () => {
    expectRestorable(makeV3())
  })

  it('valid V4 snapshot', () => {
    expectRestorable(makeV4())
  })
})

// ─── Blocking defects ───────────────────────────────────────────────────────

describe('classifySnapshotRestorability — blocking defects', () => {
  const classify = (snapshot: unknown) => classifySnapshotRestorability(snapshot, 'proj-1')
  const expectDefect = (snapshot: unknown) => {
    const verdict = classify(snapshot)
    expect(verdict.kind).toBe('defect')
    expect(verdict.restoreStatus).toBe('non-restorable')
    expect(typeof verdict.restoreReason).toBe('string')
    expect((verdict.restoreReason as string).length).toBeGreaterThan(0)
  }

  it('one-null/one-valid effective CAPACITY_PLAN window', () => {
    expectDefect(makeV2([makeResourceType({ allocationMode: 'CAPACITY_PLAN', allocationStartWeek: 5, allocationEndWeek: null })]))
    expectDefect(makeV2([makeResourceType({ allocationMode: 'CAPACITY_PLAN', allocationStartWeek: null, allocationEndWeek: 5 })]))
  })

  it('-1 paired with null (effective CAPACITY_PLAN)', () => {
    expectDefect(makeV2([makeResourceType({ allocationMode: 'CAPACITY_PLAN', allocationStartWeek: -1, allocationEndWeek: null })]))
  })

  it('value below -1', () => {
    expectDefect(makeV2([makeResourceType({ allocationMode: 'CAPACITY_PLAN', allocationStartWeek: -2, allocationEndWeek: 5 })]))
  })

  it('fractional week', () => {
    expectDefect(makeV2([makeResourceType({ allocationMode: 'CAPACITY_PLAN', allocationStartWeek: 1.5, allocationEndWeek: 5 })]))
  })

  it('conflicting NamedResource aliases', () => {
    const nr = makeNamedResource({
      allocationMode: 'CAPACITY_PLAN',
      allocationStartWeek: 3,
      startWeek: 5,
      allocationEndWeek: 9,
    })
    expectDefect(makeV2([makeResourceType()], [nr]))
  })

  it('invalid populated stale alias on EFFORT', () => {
    expectDefect(makeV2([makeResourceType({ allocationMode: 'EFFORT', allocationStartWeek: -1 })]))
    expectDefect(makeV2([makeResourceType({ allocationMode: 'EFFORT', allocationStartWeek: 1.5 })]))
  })

  it('TIMELINE with a single negative edge', () => {
    expectDefect(makeV2([makeResourceType({ allocationMode: 'TIMELINE', allocationStartWeek: -1, allocationEndWeek: 5 })]))
  })

  it('unknown allocation mode', () => {
    expectDefect(makeV2([makeResourceType({ allocationMode: 'WARP_DRIVE' })]))
  })

  it('orphan NamedResource (missing parent ResourceType)', () => {
    const nr = makeNamedResource({ resourceTypeId: 'rt-missing' })
    expectDefect(makeV2([makeResourceType({ id: 'rt-1' })], [nr]))
  })

  it('NamedResource without resourceTypeId', () => {
    const nr = makeNamedResource({ resourceTypeId: null })
    expectDefect(makeV2([makeResourceType()], [nr]))
  })

  it('malformed payload', () => {
    expectDefect('not-a-snapshot')
    expectDefect(null)
  })

  it('unknown schema version', () => {
    expectDefect({ schemaVersion: 99, epics: [] })
  })

  it('V3 validation failure', () => {
    const v3 = makeV3()
    v3.capacityProfiles[0]!.resourceTypeId = null
    expectDefect(v3)
  })

  it('non-finite percentage on a quarantine candidate', () => {
    expectDefect(makeV2([makeResourceType({
      allocationMode: 'CAPACITY_PLAN',
      allocationStartWeek: null,
      allocationEndWeek: null,
      allocationPercent: Number.POSITIVE_INFINITY,
    })]))
  })

  it('quarantine candidate mixed with another defect', () => {
    const orphan = makeNamedResource({ id: 'nr-x', resourceTypeId: 'rt-missing' })
    expectDefect(makeV2([CAPACITY_PLAN_RT_A], [orphan]))
  })

  it('duplicate resourceType ids fail structural validation (never quarantine)', () => {
    const dup = makeResourceType({ id: 'rt-dup', allocationMode: 'CAPACITY_PLAN', allocationStartWeek: null, allocationEndWeek: null })
    expectDefect(makeV2([dup, { ...dup, name: 'Clone' }]))
  })
})

// ─── V3/V4 fixtures ─────────────────────────────────────────────────────────

function makeV3() {
  return {
    schemaVersion: 3,
    epics: [],
    project: null,
    resourceTypes: [makeResourceType()],
    namedResources: [makeNamedResource()],
    timelineEntries: [],
    storyTimelineEntries: [],
    epicDependencies: [],
    featureDependencies: [],
    overheadItems: [],
    capacityProfiles: [{
      id: 'cp-role',
      ownerKind: 'ROLE',
      resourceTypeId: 'rt-1',
      namedResourceId: null,
      planningBasis: 'DEMAND_FOLLOWING',
      source: 'FIXED',
      defaultPercent: 100,
      startWeek: null,
      endWeek: null,
      legacy: { kind: 'DB_NULL' },
      segments: [],
    }, {
      id: 'cp-nr',
      ownerKind: 'NAMED_PERSON',
      resourceTypeId: null,
      namedResourceId: 'nr-1',
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

function makeV4() {
  const v3 = makeV3()
  const { allocationMode: _am, allocationPercent: _ap, allocationStartWeek: _as, allocationEndWeek: _ae, ...rtRest } = v3.resourceTypes[0]!
  const { startWeek: _sw, endWeek: _ew, allocationPct: _pct, allocationMode: _am2, allocationPercent: _ap2, allocationStartWeek: _as2, allocationEndWeek: _ae2, ...nrRest } = v3.namedResources[0]!
  return {
    ...v3,
    schemaVersion: 4,
    resourceTypes: [rtRest],
    namedResources: [nrRest],
  }
}
