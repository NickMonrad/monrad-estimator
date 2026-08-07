/**
 * snapshotRestorability.test.ts — Pure unit tests for the issue #444
 * V4-minimum restorability classifier (no database).
 *
 * Coverage (issue #444 policy):
 *   - V1/V2/V3 payloads are non-restorable with ONE stable retirement reason
 *     (deliberate legacy retirement — the payload is never analysed);
 *   - valid V4 payloads are restorable;
 *   - invalid V4 payloads fail validation (defect);
 *   - malformed/unsupported payloads fail closed (defect);
 *   - the retained raw-value quarantine predicates (`classifyV2QuarantineShape`)
 *     still behave exactly as reviewed (used by historical tooling);
 *   - the retained shared v2 translator still behaves exactly as reviewed
 *     (historical tooling may still use it).
 */
import { describe, expect, it } from 'vitest'
import {
  classifySnapshotRestorability,
  classifyV2QuarantineShape,
  RETIREMENT_REASON,
  QUARANTINE_CLASS_A_REASON,
  type V2QuarantineWindowFields,
} from '../lib/snapshotRestorability.js'
import { translateV2SnapshotProfiles } from '../lib/projectSnapshotCapacity.js'
import type { SnapshotV3, SnapshotV4 } from '../lib/projectSnapshotTypes.js'

// ─── Fixture helpers ────────────────────────────────────────────────────────

interface RtFixture {
  id?: string
  name?: string
  count?: number
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

// ─── Raw shape predicate (retained for historical tooling) ──────────────────

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

// ─── Retired (V1/V2/V3) ─────────────────────────────────────────────────────

describe('classifySnapshotRestorability — V4 minimum (issue #444)', () => {
  const classify = (snapshot: unknown) => classifySnapshotRestorability(snapshot, 'proj-1')

  it('V1 (bare epic array) is non-restorable with the stable retirement reason', () => {
    const verdict = classify([{ id: 'e1', name: 'Epic 1', features: [] }])
    expect(verdict.kind).toBe('retired')
    expect(verdict.restoreStatus).toBe('non-restorable')
    expect(verdict.restoreReason).toBe(RETIREMENT_REASON)
  })

  it('V1 (object with epics, no schemaVersion) is non-restorable with the stable retirement reason', () => {
    const verdict = classify({ epics: [{ id: 'e1', name: 'Epic 1', features: [] }] })
    expect(verdict.kind).toBe('retired')
    expect(verdict.restoreStatus).toBe('non-restorable')
    expect(verdict.restoreReason).toBe(RETIREMENT_REASON)
  })

  it('V2 is non-restorable with the stable retirement reason — even previously-restorable shapes are never analysed', () => {
    // A shape that the old issue #438 policy considered restorable (exact
    // all-windowless-100% CAPACITY_PLAN) is now retired without analysis.
    const rt = makeResourceType({ allocationMode: 'CAPACITY_PLAN', allocationStartWeek: null, allocationEndWeek: null })
    const verdict = classify(makeV2([rt]))
    expect(verdict.kind).toBe('retired')
    expect(verdict.restoreStatus).toBe('non-restorable')
    expect(verdict.restoreReason).toBe(RETIREMENT_REASON)
  })

  it('V2 is non-restorable with the stable retirement reason — previously-quarantined shapes too', () => {
    const rt = makeResourceType({ allocationMode: 'CAPACITY_PLAN', allocationStartWeek: null, allocationEndWeek: null, allocationPercent: 80 })
    const verdict = classify(makeV2([rt]))
    expect(verdict.kind).toBe('retired')
    expect(verdict.restoreStatus).toBe('non-restorable')
    expect(verdict.restoreReason).toBe(RETIREMENT_REASON)
    expect(verdict.restoreReason).not.toBe(QUARANTINE_CLASS_A_REASON)
  })

  it('V2 with entries is never classified quarantined — quarantine analysis is retired', () => {
    const nr = makeNamedResource({
      allocationMode: 'CAPACITY_PLAN',
      allocationStartWeek: null,
      allocationEndWeek: null,
      startWeek: null,
      endWeek: null,
    })
    const verdict = classify(makeV2([makeResourceType({ allocationMode: 'EFFORT' })], [nr]))
    expect(verdict.kind).toBe('retired')
    expect(verdict.restoreStatus).toBe('non-restorable')
  })

  it('V3 is non-restorable with the stable retirement reason', () => {
    const verdict = classify(makeV3())
    expect(verdict.kind).toBe('retired')
    expect(verdict.restoreStatus).toBe('non-restorable')
    expect(verdict.restoreReason).toBe(RETIREMENT_REASON)
  })

  it('the retirement verdict is deterministic and idempotent', () => {
    const snapshot = makeV2([makeResourceType()])
    const first = classify(snapshot)
    const second = classify(JSON.parse(JSON.stringify(snapshot)))
    expect(second).toEqual(first)
  })
})

// ─── Restorable (valid V4 only) ─────────────────────────────────────────────

describe('classifySnapshotRestorability — restorable (V4 only)', () => {
  const classify = (snapshot: unknown) => classifySnapshotRestorability(snapshot, 'proj-1')
  const expectRestorable = (snapshot: unknown) => {
    const verdict = classify(snapshot)
    expect(verdict.kind).toBe('restorable')
    expect(verdict.restoreStatus).toBe('restorable')
    expect(verdict.restoreReason).toBeNull()
  }

  it('valid V4 snapshot', () => {
    expectRestorable(makeV4())
  })

  it('valid V4 with empty capacity profiles', () => {
    const v4 = makeV4()
    v4.capacityProfiles = []
    expectRestorable(v4)
  })

  it('valid V4 with segments', () => {
    const v4 = makeV4()
    v4.capacityProfiles[0]!.segments = [{
      id: 'seg-1',
      startWeek: 0,
      endWeek: 4,
      capacityPercent: 100,
      source: 'FIXED',
    }]
    expectRestorable(v4)
  })

  it('valid V4 with capacity plans', () => {
    const v4 = makeV4()
    v4.capacityPlans = [{
      id: 'plan-1',
      name: 'Plan',
      targetWeeks: 10,
      periodWeeks: 2,
      maxDelta: 1,
      isActive: true,
      totalCost: null,
      deliveryWeeks: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      periods: [{
        id: 'per-1',
        periodIndex: 0,
        startWeek: 0,
        endWeek: 1,
        entries: [{
          id: 'ent-1',
          resourceTypeId: 'rt-1',
          headcount: 1,
          demandFTE: 1,
          utilisationPct: 100,
        }],
      }],
    }]
    expectRestorable(v4)
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

  it('malformed payload', () => {
    expectDefect('not-a-snapshot')
    expectDefect(null)
    expectDefect({ schemaVersion: 2, epics: 'not-an-array' })
  })

  it('unknown schema version', () => {
    expectDefect({ schemaVersion: 99, epics: [] })
  })

  it('V4 validation failure (ROLE profile without resourceTypeId)', () => {
    const v4 = makeV4()
    v4.capacityProfiles[0]!.resourceTypeId = null
    const verdict = classify(v4)
    expectDefect(v4)
    expect(verdict.restoreReason).toContain('invalid payload')
  })

  it('V4 validation failure (orphan named resource)', () => {
    const v4 = makeV4()
    v4.namedResources[0]!.resourceTypeId = 'rt-missing'
    expectDefect(v4)
  })

  it('V4 validation failure (duplicate profile ids)', () => {
    const v4 = makeV4()
    const profile = v4.capacityProfiles[0]!
    v4.capacityProfiles.push({ ...profile, id: profile.id })
    expectDefect(v4)
  })

  it('V4 validation failure (invalid segment range)', () => {
    const v4 = makeV4()
    v4.capacityProfiles[0]!.segments = [{
      id: 'seg-bad',
      startWeek: 8,
      endWeek: 3,
      capacityPercent: 100,
      source: 'FIXED',
    }]
    expectDefect(v4)
  })

  it('V4 validation failure (unsupported enum value)', () => {
    const v4 = makeV4()
    ;(v4.capacityProfiles[0] as unknown as { planningBasis: string }).planningBasis = 'WARP_DRIVE'
    expectDefect(v4)
  })

  it('malformed schemaVersion 4 (missing required arrays) fails closed', () => {
    expectDefect({ schemaVersion: 4, epics: [] })
  })
})

// ─── Retained historical translator (used by evidence tooling) ─────────────

describe('translateV2SnapshotProfiles — retained historical translator', () => {
  const translate = (snapshot: unknown) => translateV2SnapshotProfiles(snapshot as never, 'proj-1')

  it('still translates a windowed CAPACITY_PLAN entry deterministically', () => {
    const parent = makeResourceType({ allocationMode: 'CAPACITY_PLAN', allocationStartWeek: 0, allocationEndWeek: 10 })
    const nr = makeNamedResource({
      allocationMode: 'CAPACITY_PLAN',
      allocationStartWeek: 1,
      allocationEndWeek: 8,
    })
    const result = translate(makeV2([parent], [nr]))
    expect(result.errors).toEqual([])
    const named = result.profiles.find(p => p.namedResourceId === 'nr-1')!
    expect(named.ownerKind).toBe('NAMED_PERSON')
    expect(named.planningBasis).toBe('AVAILABILITY_WINDOW')
    expect(named.source).toBe('LEGACY')
    expect(named.startWeek).toBe(1)
    expect(named.endWeek).toBe(8)
  })

  it('still refuses to translate a mixed snapshot with a windowless CAPACITY_PLAN entry (fail closed)', () => {
    const windowless = makeResourceType({ allocationMode: 'CAPACITY_PLAN', allocationStartWeek: null, allocationEndWeek: null })
    const valid = makeResourceType({ id: 'rt-b', name: 'Valid', allocationMode: 'TIMELINE', allocationStartWeek: 2, allocationEndWeek: 9 })
    const result = translate(makeV2([windowless, valid]))
    expect(result.errors.join('; ')).toContain('without a captured start/end window')
  })
})

// ─── V3/V4 fixtures ─────────────────────────────────────────────────────────

function makeV3(): SnapshotV3 {
  return {
    schemaVersion: 3,
    epics: [],
    project: null,
    resourceTypes: [makeResourceType()] as unknown as SnapshotV3['resourceTypes'],
    namedResources: [makeNamedResource()] as unknown as SnapshotV3['namedResources'],
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

function makeV4(): SnapshotV4 {
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
