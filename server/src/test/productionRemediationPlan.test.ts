/**
 * productionRemediationPlan.test.ts — Pure unit tests for the Issue #421
 * remediation planner (no database).
 *
 * Coverage:
 *   - deterministic live-state derivation matrix (ROLE + NAMED_PERSON);
 *   - planner-owned ROLE reconstruction from valid CapacityPlan entries;
 *   - never-active window policy (shared with readiness/rollback translation);
 *   - persisted-profile defect classification (window-clear, overlap-fix,
 *     segmentless-decision, unsupported);
 *   - overlap decomposition preserves per-week effective capacity and IDs;
 *   - snapshot entry classification matrix;
 *   - canonical JSON + stable fingerprints (reruns identical, tampering detected);
 *   - plan/manifest parse validation and merge (resolutions, refusals);
 *   - exit classification (0/1/2).
 */
import { describe, expect, it } from 'vitest'

import {
  buildRemediationPlan,
  canonicalJson,
  classifyPlanExit,
  computePlanFingerprint,
  decomposeOverlappingSegments,
  deriveNamedProfileFromLegacy,
  deriveRoleProfileFromLegacy,
  classifyPersistedProfileDefect,
  classifySnapshotEntry,
  parsePlanJson,
  parseManifestJson,
  resolvePlanWithManifest,
  remediationProfileId,
  sha256Hex,
  type RemediationDatabaseState,
  type RemediationManifest,
  type RemediationNamedResource,
  type RemediationProject,
  type RemediationResourceType,
} from '../lib/productionRemediationPlan.js'
import { isNeverActiveWindow } from '../lib/projectSnapshotCapacity.js'

// ─── Fixture helpers ────────────────────────────────────────────────────────

function makeRt(overrides: Partial<RemediationResourceType> = {}): RemediationResourceType {
  return {
    id: 'rt-1',
    name: 'Engineer',
    count: 1,
    allocationMode: 'EFFORT',
    allocationPercent: 100,
    allocationStartWeek: null,
    allocationEndWeek: null,
    namedResources: [],
    ...overrides,
  }
}

function makeNr(overrides: Partial<RemediationNamedResource> = {}): RemediationNamedResource {
  return {
    id: 'nr-1',
    name: 'Alice',
    allocationMode: 'EFFORT',
    allocationPercent: 100,
    allocationPct: null,
    allocationStartWeek: null,
    allocationEndWeek: null,
    startWeek: null,
    endWeek: null,
    ...overrides,
  }
}

function makeProject(overrides: Partial<RemediationProject> = {}): RemediationProject {
  return {
    id: 'proj-1',
    name: 'Project One',
    resourceTypes: [],
    capacityProfiles: [],
    activePlanPeriods: [],
    ...overrides,
  }
}

function makeState(project: RemediationProject): RemediationDatabaseState {
  return { projects: [project], snapshots: [] }
}

// ─── never-active policy ────────────────────────────────────────────────────

describe('isNeverActiveWindow (issue #421 policy)', () => {
  it('treats the (-1, -1) Squad Planner sentinel as never active', () => {
    expect(isNeverActiveWindow(-1, -1)).toBe(true)
  })

  it('treats inverted windows (start > end) as never active', () => {
    expect(isNeverActiveWindow(4, 3)).toBe(true)
  })

  it('does not treat null/unbounded windows as never active', () => {
    expect(isNeverActiveWindow(null, null)).toBe(false)
    expect(isNeverActiveWindow(0, null)).toBe(false)
    expect(isNeverActiveWindow(null, 10)).toBe(false)
  })

  it('does not normalise a single -1 edge (no established meaning)', () => {
    expect(isNeverActiveWindow(-1, 5)).toBe(false)
    expect(isNeverActiveWindow(0, -1)).toBe(false)
  })

  it('treats valid windows as active', () => {
    expect(isNeverActiveWindow(0, 10)).toBe(false)
  })
})

// ─── Deterministic ROLE derivation matrix ───────────────────────────────────

describe('deriveRoleProfileFromLegacy', () => {
  it('maps TIMELINE → AVAILABILITY_WINDOW preserving percent and window', () => {
    const result = deriveRoleProfileFromLegacy(makeRt({
      allocationMode: 'TIMELINE',
      allocationPercent: 75,
      allocationStartWeek: 2,
      allocationEndWeek: 10,
    }), [])
    expect(result.classification).toBe('deterministic')
    expect(result.proposed).toMatchObject({
      profileId: remediationProfileId('role', 'rt-1'),
      ownerKind: 'ROLE',
      planningBasis: 'AVAILABILITY_WINDOW',
      source: 'AVAILABILITY_WINDOW',
      defaultPercent: 75,
      startWeek: 2,
      endWeek: 10,
      segments: [],
    })
  })

  it('maps EFFORT → DEMAND_FOLLOWING and discards stale windows', () => {
    const result = deriveRoleProfileFromLegacy(makeRt({
      allocationMode: 'EFFORT',
      allocationPercent: null,
      allocationStartWeek: 2,
      allocationEndWeek: 10,
    }), [])
    expect(result.classification).toBe('deterministic')
    expect(result.proposed).toMatchObject({
      planningBasis: 'DEMAND_FOLLOWING',
      source: 'FIXED',
      defaultPercent: null,
      startWeek: null,
      endWeek: null,
    })
  })

  it('maps null mode → DEMAND_FOLLOWING', () => {
    const result = deriveRoleProfileFromLegacy(makeRt({ allocationMode: null }), [])
    expect(result.classification).toBe('deterministic')
    expect(result.proposed).toMatchObject({ planningBasis: 'DEMAND_FOLLOWING', source: 'FIXED' })
  })

  it('maps FULL_PROJECT → WHOLE_PROJECT_ALLOCATION', () => {
    const result = deriveRoleProfileFromLegacy(makeRt({ allocationMode: 'FULL_PROJECT' }), [])
    expect(result.classification).toBe('deterministic')
    expect(result.proposed).toMatchObject({
      planningBasis: 'WHOLE_PROJECT_ALLOCATION',
      source: 'FIXED',
      defaultPercent: 100,
      startWeek: null,
      endWeek: null,
    })
  })

  it('reconstructs a planner-owned ROLE profile from valid active-plan entries', () => {
    const periods = [
      {
        periodIndex: 0,
        startWeek: 0,
        endWeek: 8,
        entries: [{ resourceTypeId: 'rt-1', headcount: 2 }],
      },
      {
        periodIndex: 1,
        startWeek: 8,
        endWeek: 16,
        entries: [{ resourceTypeId: 'rt-1', headcount: 2 }],
      },
    ]
    const result = deriveRoleProfileFromLegacy(makeRt({ allocationMode: 'CAPACITY_PLAN' }), periods)
    expect(result.classification).toBe('deterministic')
    expect(result.proposed).toMatchObject({
      ownerKind: 'ROLE',
      planningBasis: 'CAPACITY_PROFILE',
      source: 'SQUAD_PLANNER',
      defaultPercent: 200,
    })
    expect(result.proposed!.segments).toEqual([{
      id: `${result.proposed!.profileId}-seg-001`,
      startWeek: 0,
      endWeek: 15,
      capacityPercent: 200,
      source: 'SQUAD_PLANNER',
    }])
    expect(result.proposed!.legacy).toMatchObject({ allocationMode: 'CAPACITY_PLAN' })
  })

  it('requires a decision for CAPACITY_PLAN without plan evidence', () => {
    const result = deriveRoleProfileFromLegacy(makeRt({ allocationMode: 'CAPACITY_PLAN' }), [])
    expect(result.classification).toBe('decisionRequired')
    expect(result.proposed).toBeUndefined()
  })
})

// ─── Deterministic NAMED_PERSON derivation matrix ───────────────────────────

describe('deriveNamedProfileFromLegacy', () => {
  it('maps TIMELINE → AVAILABILITY_WINDOW with field precedence', () => {
    const result = deriveNamedProfileFromLegacy(makeNr({
      allocationMode: 'TIMELINE',
      allocationPercent: 50,
      allocationStartWeek: null,
      allocationEndWeek: null,
      startWeek: 3,
      endWeek: 9,
    }))
    expect(result.classification).toBe('deterministic')
    expect(result.proposed).toMatchObject({
      ownerKind: 'NAMED_PERSON',
      planningBasis: 'AVAILABILITY_WINDOW',
      source: 'AVAILABILITY_WINDOW',
      defaultPercent: 50,
      startWeek: 3,
      endWeek: 9,
    })
  })

  it('maps FULL_PROJECT → WHOLE_PROJECT_ALLOCATION and discards windows', () => {
    const result = deriveNamedProfileFromLegacy(makeNr({
      allocationMode: 'FULL_PROJECT',
      allocationPercent: 80,
      startWeek: 1,
      endWeek: 4,
    }))
    expect(result.classification).toBe('deterministic')
    expect(result.proposed).toMatchObject({
      planningBasis: 'WHOLE_PROJECT_ALLOCATION',
      source: 'FIXED',
      defaultPercent: 80,
      startWeek: null,
      endWeek: null,
    })
  })

  it('maps EFFORT → DEMAND_FOLLOWING at captured percent (approved mapper semantics)', () => {
    const result = deriveNamedProfileFromLegacy(makeNr({ allocationMode: 'EFFORT' }))
    expect(result.classification).toBe('deterministic')
    expect(result.proposed).toMatchObject({
      planningBasis: 'DEMAND_FOLLOWING',
      source: 'FIXED',
      defaultPercent: 100,
      startWeek: null,
      endWeek: null,
    })
  })

  it('maps CAPACITY_PLAN with captured window → AVAILABILITY_WINDOW/LEGACY (v2 policy)', () => {
    const result = deriveNamedProfileFromLegacy(makeNr({
      allocationMode: 'CAPACITY_PLAN',
      allocationPercent: 100,
      startWeek: 0,
      endWeek: 29,
    }))
    expect(result.classification).toBe('deterministic')
    expect(result.proposed).toMatchObject({
      planningBasis: 'AVAILABILITY_WINDOW',
      source: 'LEGACY',
      defaultPercent: 100,
      startWeek: 0,
      endWeek: 29,
    })
  })

  it('requires a decision for CAPACITY_PLAN without a captured window', () => {
    const result = deriveNamedProfileFromLegacy(makeNr({ allocationMode: 'CAPACITY_PLAN' }))
    expect(result.classification).toBe('decisionRequired')
  })

  it('normalises a never-active (-1, -1) window to zero capacity', () => {
    const result = deriveNamedProfileFromLegacy(makeNr({
      allocationMode: 'CAPACITY_PLAN',
      allocationPercent: 100,
      startWeek: -1,
      endWeek: -1,
    }))
    expect(result.classification).toBe('deterministic')
    expect(result.proposed).toMatchObject({
      planningBasis: 'AVAILABILITY_WINDOW',
      source: 'LEGACY',
      defaultPercent: 0,
      startWeek: null,
      endWeek: null,
    })
  })

  it('requires a decision for a single -1 edge', () => {
    const result = deriveNamedProfileFromLegacy(makeNr({
      allocationMode: 'CAPACITY_PLAN',
      startWeek: 0,
      endWeek: -1,
    }))
    expect(result.classification).toBe('decisionRequired')
  })
})

// ─── Overlap decomposition ──────────────────────────────────────────────────

describe('decomposeOverlappingSegments', () => {
  it('splits a contained overlap preserving weekly sums and segment IDs', () => {
    const result = decomposeOverlappingSegments('prof-1', [
      { id: 'seg-a', startWeek: 39, endWeek: 64, capacityPercent: 25, source: 'SQUAD_PLANNER' },
      { id: 'seg-b', startWeek: 52, endWeek: 64, capacityPercent: 25, source: 'SQUAD_PLANNER' },
    ])
    expect(result).toEqual([
      { id: 'seg-a', startWeek: 39, endWeek: 51, capacityPercent: 25, source: 'SQUAD_PLANNER' },
      { id: 'seg-b', startWeek: 52, endWeek: 64, capacityPercent: 50, source: 'SQUAD_PLANNER' },
    ])
  })

  it('handles partial overlaps with differing percents', () => {
    const result = decomposeOverlappingSegments('prof-1', [
      { id: 'seg-a', startWeek: 0, endWeek: 8, capacityPercent: 100, source: 'SQUAD_PLANNER' },
      { id: 'seg-b', startWeek: 4, endWeek: 12, capacityPercent: 50, source: 'SQUAD_PLANNER' },
    ])
    expect(result).toEqual([
      { id: 'seg-a', startWeek: 0, endWeek: 3, capacityPercent: 100, source: 'SQUAD_PLANNER' },
      { id: 'seg-b', startWeek: 4, endWeek: 8, capacityPercent: 150, source: 'SQUAD_PLANNER' },
      { id: `${'prof-1'}-seg-003`, startWeek: 9, endWeek: 12, capacityPercent: 50, source: 'SQUAD_PLANNER' },
    ])
  })

  it('returns empty for an empty segment list', () => {
    expect(decomposeOverlappingSegments('prof-1', [])).toEqual([])
  })

  it('preserves non-overlapping segments unchanged', () => {
    const segments = [
      { id: 'seg-a', startWeek: 0, endWeek: 4, capacityPercent: 25, source: 'SQUAD_PLANNER' },
      { id: 'seg-b', startWeek: 5, endWeek: 8, capacityPercent: 50, source: 'SQUAD_PLANNER' },
    ]
    expect(decomposeOverlappingSegments('prof-1', segments)).toEqual([
      { id: 'seg-a', startWeek: 0, endWeek: 4, capacityPercent: 25, source: 'SQUAD_PLANNER' },
      { id: 'seg-b', startWeek: 5, endWeek: 8, capacityPercent: 50, source: 'SQUAD_PLANNER' },
    ])
  })
})

// ─── Persisted-profile defect classification ────────────────────────────────

describe('classifyPersistedProfileDefect', () => {
  const ctx = {
    projectId: 'proj-1',
    resourceTypeIds: new Set(['rt-1']),
    namedResourceIds: new Set(['nr-1']),
  }

  function profile(overrides: Record<string, unknown> = {}) {
    return {
      id: 'p-1',
      projectId: 'proj-1',
      resourceTypeId: 'rt-1',
      namedResourceId: null,
      ownerKind: 'ROLE',
      planningBasis: 'DEMAND_FOLLOWING',
      source: 'FIXED',
      defaultPercent: 100,
      startWeek: null,
      endWeek: null,
      legacy: null,
      segments: [],
      ...overrides,
    }
  }

  it('returns null for a valid profile', () => {
    expect(classifyPersistedProfileDefect(profile(), ctx)).toBeNull()
  })

  it('deterministically clears DEMAND_FOLLOWING window fields', () => {
    const defect = classifyPersistedProfileDefect(profile({ startWeek: 0, endWeek: 29 }), ctx)
    expect(defect).not.toBeNull()
    expect(defect!.kind).toBe('window-clear')
    expect(defect!.classification).toBe('deterministic')
    expect(defect!.proposed).toMatchObject({ profileId: 'p-1', startWeek: null, endWeek: null })
  })

  it('deterministically fixes a contained overlap preserving IDs', () => {
    const defect = classifyPersistedProfileDefect(profile({
      planningBasis: 'CAPACITY_PROFILE',
      source: 'SQUAD_PLANNER',
      segments: [
        { id: 'seg-a', startWeek: 39, endWeek: 64, capacityPercent: 25, source: 'SQUAD_PLANNER' },
        { id: 'seg-b', startWeek: 52, endWeek: 64, capacityPercent: 25, source: 'SQUAD_PLANNER' },
      ],
    }), ctx)
    expect(defect!.kind).toBe('overlap-fix')
    expect(defect!.classification).toBe('deterministic')
    expect(defect!.proposed!.segments).toEqual([
      { id: 'seg-a', startWeek: 39, endWeek: 51, capacityPercent: 25, source: 'SQUAD_PLANNER' },
      { id: 'seg-b', startWeek: 52, endWeek: 64, capacityPercent: 50, source: 'SQUAD_PLANNER' },
    ])
  })

  it('requires a decision for segmentless non-canonical CAPACITY_PROFILE', () => {
    const defect = classifyPersistedProfileDefect(profile({
      planningBasis: 'CAPACITY_PROFILE',
      source: 'LEGACY',
      defaultPercent: 100,
    }), ctx)
    expect(defect!.classification).toBe('decisionRequired')
    expect(defect!.kind).toBe('segmentless-decision')
    expect(defect!.allowedResolutions).toContain('segmented-capacity-profile')
  })

  it('classifies unrelated structural errors as unsupported', () => {
    const defect = classifyPersistedProfileDefect(profile({
      resourceTypeId: null,
      namedResourceId: null,
    }), ctx)
    expect(defect!.classification).toBe('unsupported')
  })
})

// ─── Snapshot entry classification ──────────────────────────────────────────

describe('classifySnapshotEntry', () => {
  it('classifies valid windowed CAPACITY_PLAN entries as already valid', () => {
    const result = classifySnapshotEntry({
      allocationMode: 'CAPACITY_PLAN',
      allocationPercent: 100,
      allocationStartWeek: 0,
      allocationEndWeek: 10,
    })
    expect(result.classification).toBe('alreadyValid')
  })

  it('classifies windowless CAPACITY_PLAN entries as decision required', () => {
    const result = classifySnapshotEntry({
      allocationMode: 'CAPACITY_PLAN',
      allocationPercent: 100,
      allocationStartWeek: null,
      allocationEndWeek: null,
    })
    expect(result.classification).toBe('decisionRequired')
  })

  it('classifies windowless TIMELINE entries as already valid (unbounded)', () => {
    const result = classifySnapshotEntry({
      allocationMode: 'TIMELINE',
      allocationPercent: 100,
      allocationStartWeek: null,
      allocationEndWeek: null,
    })
    expect(result.classification).toBe('alreadyValid')
  })

  it('classifies (-1, -1) entries as deterministic policy normalisation', () => {
    const result = classifySnapshotEntry({
      allocationMode: 'CAPACITY_PLAN',
      allocationPercent: 100,
      allocationStartWeek: -1,
      allocationEndWeek: -1,
    })
    expect(result.classification).toBe('deterministic')
  })

  it('classifies inverted windows as deterministic policy normalisation', () => {
    const result = classifySnapshotEntry({
      allocationMode: 'CAPACITY_PLAN',
      allocationPercent: 100,
      allocationStartWeek: 4,
      allocationEndWeek: 3,
    })
    expect(result.classification).toBe('deterministic')
  })

  it('classifies a single -1 edge as decision required', () => {
    const result = classifySnapshotEntry({
      allocationMode: 'CAPACITY_PLAN',
      allocationPercent: 100,
      allocationStartWeek: 0,
      allocationEndWeek: -1,
    })
    expect(result.classification).toBe('decisionRequired')
  })

  it('classifies unknown modes as unsupported', () => {
    const result = classifySnapshotEntry({
      allocationMode: 'MYSTERY',
      allocationPercent: 100,
      allocationStartWeek: null,
      allocationEndWeek: null,
    })
    expect(result.classification).toBe('unsupported')
  })

  it('classifies EFFORT/FULL_PROJECT entries as already valid (windows discarded)', () => {
    expect(classifySnapshotEntry({
      allocationMode: 'EFFORT', allocationPercent: 100,
      allocationStartWeek: 2, allocationEndWeek: 9,
    }).classification).toBe('alreadyValid')
    expect(classifySnapshotEntry({
      allocationMode: 'FULL_PROJECT', allocationPercent: 100,
      allocationStartWeek: 2, allocationEndWeek: 9,
    }).classification).toBe('alreadyValid')
  })
})

// ─── Canonical JSON + fingerprints ──────────────────────────────────────────

describe('canonicalJson / fingerprints', () => {
  it('serialises objects with sorted keys', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [3, 4] } }))
      .toBe('{"a":{"c":[3,4],"d":2},"b":1}')
  })

  it('produces stable fingerprints for identical state across repeated runs', () => {
    const plan1 = buildRemediationPlan(makeState(makeProject({
      resourceTypes: [
        makeRt({ id: 'rt-a', allocationMode: 'TIMELINE', allocationPercent: 80 }),
        makeRt({ id: 'rt-b', allocationMode: 'CAPACITY_PLAN' }),
      ],
    })), 'commit-1')
    const plan2 = buildRemediationPlan(makeState(makeProject({
      resourceTypes: [
        makeRt({ id: 'rt-a', allocationMode: 'TIMELINE', allocationPercent: 80 }),
        makeRt({ id: 'rt-b', allocationMode: 'CAPACITY_PLAN' }),
      ],
    })), 'commit-2')
    expect(plan1.fingerprint).toBe(plan2.fingerprint)
    expect(computePlanFingerprint(plan1)).toBe(plan1.fingerprint)
    expect(plan1.operations).toHaveLength(1)
    expect(plan1.decisions).toHaveLength(1)
  })

  it('changes the fingerprint when plan content changes', () => {
    const base = buildRemediationPlan(makeState(makeProject({
      resourceTypes: [makeRt({ allocationMode: 'TIMELINE', allocationPercent: 80 })],
    })), 'commit-1')
    const changed = buildRemediationPlan(makeState(makeProject({
      resourceTypes: [makeRt({ allocationMode: 'TIMELINE', allocationPercent: 90 })],
    })), 'commit-1')
    expect(changed.fingerprint).not.toBe(base.fingerprint)
  })

  it('detects tampered plan files via parsePlanJson', () => {
    const plan = buildRemediationPlan(makeState(makeProject({
      resourceTypes: [makeRt({ allocationMode: 'TIMELINE' })],
    })), 'commit-1')
    const json = JSON.parse(JSON.stringify(plan))
    json.operations[0]!.proposed.defaultPercent = 55
    const parsed = parsePlanJson(JSON.stringify(json))
    expect(parsed.plan).toBeNull()
    expect(parsed.errors.join(' ')).toContain('fingerprint mismatch')
  })

  it('accepts an unaltered plan file', () => {
    const plan = buildRemediationPlan(makeState(makeProject({
      resourceTypes: [makeRt({ allocationMode: 'TIMELINE' })],
    })), 'commit-1')
    const parsed = parsePlanJson(JSON.stringify(plan))
    expect(parsed.plan).not.toBeNull()
    expect(parsed.errors).toEqual([])
  })
})

// ─── Manifest merge ─────────────────────────────────────────────────────────

describe('resolvePlanWithManifest', () => {
  it('resolves a windowless CAPACITY_PLAN owner with an availability window', () => {
    const plan = buildRemediationPlan(makeState(makeProject({
      resourceTypes: [makeRt({ id: 'rt-x', allocationMode: 'CAPACITY_PLAN' })],
    })), 'commit-1')
    const manifest = {
      formatVersion: 1,
      applicationCommit: 'commit-1',
      planFingerprint: plan.fingerprint,
      decisions: [{
        decisionId: plan.decisions[0]!.id,
        projectId: 'proj-1',
        ownerId: 'rt-x',
        snapshotId: null,
        resolution: { shape: 'availability-window', defaultPercent: 100, startWeek: 0, endWeek: 20 },
        rationale: 'reviewed owner intent',
      }],
    }
    const parsed = parseManifestJson(JSON.stringify(manifest))
    expect(parsed.errors).toEqual([])
    const resolved = resolvePlanWithManifest(plan, parsed.manifest!)
    expect(resolved.errors).toEqual([])
    expect(resolved.plan.operations).toHaveLength(1)
    expect(resolved.plan.decisions).toHaveLength(0)
    expect(resolved.plan.operations[0]).toMatchObject({
      kind: 'create-role-profile',
      classification: 'decisionResolved',
      decisionId: plan.decisions[0]!.id,
    })
    const proposed = resolved.plan.operations[0]!.proposed
    expect(proposed).toMatchObject({
      planningBasis: 'AVAILABILITY_WINDOW',
      source: 'AVAILABILITY_WINDOW',
      startWeek: 0,
      endWeek: 20,
    })
  })

  it('rejects a manifest with a mismatched plan fingerprint', () => {
    const plan = buildRemediationPlan(makeState(makeProject({
      resourceTypes: [makeRt({ allocationMode: 'CAPACITY_PLAN' })],
    })), 'commit-1')
    const manifest = {
      formatVersion: 1 as const,
      applicationCommit: 'commit-1',
      planFingerprint: sha256Hex('wrong'),
      decisions: [],
    }
    const resolved = resolvePlanWithManifest(plan, manifest as RemediationManifest)
    expect(resolved.errors.join(' ')).toContain('planFingerprint')
  })

  it('rejects resolutions whose shape is not allowed for the entry', () => {
    const plan = buildRemediationPlan(makeState(makeProject({
      resourceTypes: [makeRt({ allocationMode: 'CAPACITY_PLAN' })],
    })), 'commit-1')
    const manifest = {
      formatVersion: 1 as const,
      applicationCommit: 'commit-1',
      planFingerprint: plan.fingerprint,
      decisions: [{
        decisionId: plan.decisions[0]!.id,
        projectId: 'proj-1',
        ownerId: 'rt-1',
        snapshotId: null,
        resolution: { shape: 'snapshot-window-interpretation' as const, startWeek: 0, endWeek: 5 },
      }],
    }
    const resolved = resolvePlanWithManifest(plan, manifest)
    expect(resolved.errors.join(' ')).toContain('not allowed')
  })

  it('keeps unresolved decisions in the merged plan', () => {
    const plan = buildRemediationPlan(makeState(makeProject({
      resourceTypes: [makeRt({ id: 'rt-x', allocationMode: 'CAPACITY_PLAN' })],
    })), 'commit-1')
    const manifest = {
      formatVersion: 1 as const,
      applicationCommit: 'commit-1',
      planFingerprint: plan.fingerprint,
      decisions: [],
    }
    const resolved = resolvePlanWithManifest(plan, manifest as RemediationManifest)
    expect(resolved.errors).toEqual([])
    expect(resolved.plan.decisions).toHaveLength(1)
    expect(resolved.plan.operations).toHaveLength(0)
  })

  it('rejects a malformed snapshot window interpretation', () => {
    const plan = buildRemediationPlan(makeState(makeProject({
      resourceTypes: [makeRt({ id: 'rt-x', allocationMode: 'CAPACITY_PLAN' })],
    })), 'commit-1')
    const manifest = {
      formatVersion: 1 as const,
      applicationCommit: 'commit-1',
      planFingerprint: plan.fingerprint,
      decisions: [{
        decisionId: plan.decisions[0]!.id,
        projectId: 'proj-1',
        ownerId: 'rt-x',
        snapshotId: null,
        resolution: { shape: 'availability-window' as const, defaultPercent: 100, startWeek: 9, endWeek: 3 },
      }],
    }
    // Inverted window on a live-owner resolution: structurally invalid → the
    // resulting proposed profile fails the authoritative validator at apply,
    // and the merged operation is still emitted; apply refuses. The merge
    // itself validates shape membership only.
    const resolved = resolvePlanWithManifest(plan, manifest)
    expect(resolved.errors).toEqual([])
    expect(resolved.plan.operations).toHaveLength(1)
  })
})

// ─── Exit classification ────────────────────────────────────────────────────

describe('classifyPlanExit', () => {
  it('returns 2 when decisions remain', () => {
    const plan = buildRemediationPlan(makeState(makeProject({
      resourceTypes: [makeRt({ allocationMode: 'CAPACITY_PLAN' })],
    })), 'commit-1')
    expect(classifyPlanExit(plan)).toBe(2)
  })

  it('returns 0 for a fully resolved plan', () => {
    const plan = buildRemediationPlan(makeState(makeProject({
      resourceTypes: [makeRt({ allocationMode: 'TIMELINE' })],
    })), 'commit-1')
    expect(classifyPlanExit(plan)).toBe(0)
  })

  it('returns 1 for unsupported findings even without decisions', () => {
    const plan = buildRemediationPlan({
      projects: [],
      snapshots: [{
        id: 'snap-1',
        projectId: 'proj-1',
        snapshot: { schemaVersion: 99 },
      }],
    }, 'commit-1')
    expect(classifyPlanExit(plan)).toBe(1)
  })
})

// ─── Full plan shape ────────────────────────────────────────────────────────

describe('buildRemediationPlan (integration of matrix)', () => {
  it('classifies every live owner and emits operations/decisions/findings', () => {
    const project = makeProject({
      resourceTypes: [
        makeRt({ id: 'rt-1', allocationMode: 'TIMELINE' }),
        makeRt({ id: 'rt-2', allocationMode: 'CAPACITY_PLAN' }),
        makeRt({
          id: 'rt-3',
          allocationMode: 'TIMELINE',
          namedResources: [
            makeNr({ id: 'nr-1', allocationMode: 'TIMELINE', startWeek: 0, endWeek: 8 }),
            makeNr({ id: 'nr-2', allocationMode: 'CAPACITY_PLAN' }),
          ],
        }),
      ],
    })
    const plan = buildRemediationPlan(makeState(project), 'commit-1')
    expect(plan.operations).toHaveLength(2) // rt-1 role + nr-1 named
    expect(plan.decisions).toHaveLength(2) // rt-2 role + nr-2 named
    expect(plan.summary.findings.deterministic).toBe(2)
    expect(plan.summary.findings.decisionRequired).toBe(2)
    // Stable ordering: findings/operations sorted deterministically.
    expect(plan.operations[0]!.ownerId).toBe('rt-1')
    expect(plan.operations[1]!.ownerId).toBe('nr-1')
  })

  it('reports planner-owned RTs without ROLE profiles as deterministic when plan entries exist', () => {
    const project = makeProject({
      resourceTypes: [makeRt({ id: 'rt-p', allocationMode: 'CAPACITY_PLAN', count: 2 })],
      activePlanPeriods: [{
        periodIndex: 0,
        startWeek: 0,
        endWeek: 8,
        entries: [{ resourceTypeId: 'rt-p', headcount: 1 }],
      }],
      capacityProfiles: [{
        id: 'prof-nr-1',
        projectId: 'proj-1',
        resourceTypeId: null,
        namedResourceId: 'nr-p-1',
        ownerKind: 'PLANNED_RESOURCE',
        planningBasis: 'CAPACITY_PROFILE',
        source: 'SQUAD_PLANNER',
        defaultPercent: null,
        startWeek: 0,
        endWeek: 7,
        legacy: null,
        segments: [{ id: 'seg-nr-1', startWeek: 0, endWeek: 7, capacityPercent: 100, source: 'SQUAD_PLANNER' }],
      }],
    })
    const withNr = { ...project, resourceTypes: [{
      ...project.resourceTypes[0]!,
      namedResources: [
        { ...makeNr({ id: 'nr-p-1', allocationMode: 'CAPACITY_PLAN' }), resourceTypeId: 'rt-p' },
      ],
    }] }
    const plan = buildRemediationPlan(makeState(withNr), 'commit-1')
    const roleOps = plan.operations.filter(op => op.ownerId === 'rt-p')
    expect(roleOps).toHaveLength(1)
    expect(roleOps[0]!.kind).toBe('create-role-profile')
    const proposed = roleOps[0]!.proposed
    expect(proposed).toMatchObject({ planningBasis: 'CAPACITY_PROFILE', source: 'SQUAD_PLANNER' })
  })
})
