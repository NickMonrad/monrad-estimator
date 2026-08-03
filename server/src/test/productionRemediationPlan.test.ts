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
  type ManifestDecision,
  type ProposedProfile,
  type RemediationNamedResource,
  type RemediationPlan,
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

// ─── Derived quarantine in plans (issue #428) ───────────────────────────────

describe('remediation plan — derived quarantine', () => {
  function makeSnapshot(overrides: Partial<RemediationDatabaseState['snapshots'][number]> = {}) {
    return {
      id: 'snap-1',
      projectId: 'proj-1',
      snapshot: {
        schemaVersion: 2,
        epics: [],
        project: null,
        resourceTypes: [{
          id: 'rt-q',
          name: 'Quarantine Role',
          category: 'ENGINEERING',
          count: 1,
          hoursPerDay: null,
          dayRate: null,
          globalTypeId: null,
          allocationMode: 'CAPACITY_PLAN',
          allocationPercent: 100,
          allocationStartWeek: null,
          allocationEndWeek: null,
        }, {
          id: 'rt-ok',
          name: 'Valid Role',
          category: 'ENGINEERING',
          count: 1,
          hoursPerDay: null,
          dayRate: null,
          globalTypeId: null,
          allocationMode: 'TIMELINE',
          allocationPercent: 80,
          allocationStartWeek: 2,
          allocationEndWeek: 9,
        }],
        namedResources: [],
        timelineEntries: [],
        storyTimelineEntries: [],
        epicDependencies: [],
        featureDependencies: [],
        overheadItems: [],
      },
      ...overrides,
    }
  }

  const buildWithSnapshot = (snapshot: RemediationDatabaseState['snapshots'][number]) =>
    buildRemediationPlan({ projects: [makeProject()], snapshots: [snapshot] }, 'commit-1')

  it('Class A entries are quarantined: no decision ID, no operation, summary count', () => {
    const plan = buildWithSnapshot(makeSnapshot())
    const quarantined = plan.findings.filter(f => f.classification === 'quarantined')
    expect(quarantined).toHaveLength(1)
    expect(quarantined[0]!.snapshotId).toBe('snap-1')
    expect(quarantined[0]!.entryId).toBe('rt-q')
    expect(quarantined[0]!.message).toContain('Class A')
    expect(quarantined[0]!.decisionId).toBeNull()
    expect(quarantined[0]!.operationId).toBeNull()
    expect(quarantined[0]!.evidenceHash).toMatch(/^[0-9a-f]{64}$/)
    // Removed from decisionRequired: no plan decision and no apply operation
    // reference the snapshot entry.
    expect(plan.decisions).toHaveLength(0)
    expect(plan.operations).toHaveLength(0)
    expect(plan.summary.quarantined).toBe(1)
    expect(plan.summary.decisionsRequired).toBe(0)
    // Quarantine-only plan is eligible for exit 0.
    expect(classifyPlanExit(plan)).toBe(0)
  })

  it('Class B entries are quarantined with the Class B reason', () => {
    const snapshot = makeSnapshot()
    ;(snapshot.snapshot as Record<string, unknown>).resourceTypes = [{
      id: 'rt-q',
      name: 'Quarantine Role',
      category: 'ENGINEERING',
      count: 1,
      hoursPerDay: null,
      dayRate: null,
      globalTypeId: null,
      allocationMode: 'CAPACITY_PLAN',
      allocationPercent: 100,
      allocationStartWeek: -1,
      allocationEndWeek: 5,
    }, {
      id: 'rt-ok',
      name: 'Valid Role',
      category: 'ENGINEERING',
      count: 1,
      hoursPerDay: null,
      dayRate: null,
      globalTypeId: null,
      allocationMode: 'TIMELINE',
      allocationPercent: 80,
      allocationStartWeek: 2,
      allocationEndWeek: 9,
    }]
    const plan = buildWithSnapshot(snapshot)
    const quarantined = plan.findings.filter(f => f.classification === 'quarantined')
    expect(quarantined).toHaveLength(1)
    expect(quarantined[0]!.message).toContain('Class B')
    expect(plan.summary.quarantined).toBe(1)
    expect(plan.decisions).toHaveLength(0)
    expect(plan.operations).toHaveLength(0)
  })

  it('windowless CAPACITY_PLAN entries no longer produce snapshot-window decisions', () => {
    const plan = buildWithSnapshot(makeSnapshot())
    expect(plan.decisions.some(d => d.snapshotId === 'snap-1')).toBe(false)
    expect(plan.summary.findings.decisionRequired).toBe(0)
  })

  it('a mixed quarantine-and-defect snapshot keeps per-entry classifications (never quarantined)', () => {
    const snapshot = makeSnapshot()
    ;(snapshot.snapshot as Record<string, unknown>).namedResources = [{
      id: 'nr-orphan',
      resourceTypeId: 'rt-missing',
      name: 'Orphan Person',
      startWeek: null,
      endWeek: null,
      allocationPct: 100,
      allocationMode: 'CAPACITY_PLAN',
      allocationPercent: 100,
      allocationStartWeek: null,
      allocationEndWeek: null,
      pricingModel: 'ACTUAL_DAYS',
    }]
    const plan = buildWithSnapshot(snapshot)
    expect(plan.summary.quarantined).toBe(0)
    const orphan = plan.findings.find(f => f.entryId === 'nr-orphan')
    expect(orphan?.classification).toBe('unsupported')
    // The windowless RT entry of the defective snapshot stays a decision
    // (defects are never quarantined and never silently excluded).
    const rtFinding = plan.findings.find(f => f.entryId === 'rt-q')
    expect(rtFinding?.classification).toBe('decisionRequired')
    // Unsupported findings take precedence in the exit contract.
    expect(classifyPlanExit(plan)).toBe(1)
  })

  it('quarantine plus unresolved live-state decisions still exits 2', () => {
    const plan = buildRemediationPlan({
      projects: [makeProject({
        resourceTypes: [makeRt({ id: 'rt-live', allocationMode: 'CAPACITY_PLAN' })],
      })],
      snapshots: [makeSnapshot()],
    }, 'commit-1')
    expect(plan.summary.quarantined).toBe(1)
    expect(plan.summary.decisionsRequired).toBeGreaterThan(0)
    expect(classifyPlanExit(plan)).toBe(2)
  })

  it('quarantine plus unsupported state exits 1', () => {
    const plan = buildRemediationPlan({
      projects: [],
      snapshots: [makeSnapshot(), {
        id: 'snap-bad',
        projectId: 'proj-1',
        snapshot: { schemaVersion: 99, epics: [] },
      }],
    }, 'commit-1')
    expect(plan.summary.quarantined).toBe(1)
    expect(classifyPlanExit(plan)).toBe(1)
  })

  it('plan fingerprint is deterministic across reruns with quarantined findings', () => {
    const plan1 = buildWithSnapshot(makeSnapshot())
    const plan2 = buildWithSnapshot(makeSnapshot())
    expect(plan2.fingerprint).toBe(plan1.fingerprint)
    expect(plan2.summary).toEqual(plan1.summary)
  })

  // ── Effective-mode-aware quarantine (review remediation) ──────────────────
  // A globally quarantined snapshot may contain valid non-CAPACITY_PLAN
  // entries whose raw window shape resembles Class A. Only the genuine
  // effective-CAPACITY_PLAN entries may become quarantined findings.

  function v2Role(id: string, name: string, overrides: Record<string, unknown> = {}) {
    return {
      id,
      name,
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

  function makeQuarantineWithValidCompanions() {
    return {
      id: 'snap-mixed-valid',
      projectId: 'proj-1',
      snapshot: {
        schemaVersion: 2,
        epics: [],
        project: null,
        resourceTypes: [
          v2Role('rt-q', 'Quarantine Role', { allocationMode: 'CAPACITY_PLAN' }),
          v2Role('rt-timeline-null', 'Timeline Null', { allocationMode: 'TIMELINE' }),
          v2Role('rt-effort-stale', 'Effort Stale', { allocationMode: 'EFFORT', allocationStartWeek: 2, allocationEndWeek: 9 }),
          v2Role('rt-full-null', 'Full Null', { allocationMode: 'FULL_PROJECT' }),
          v2Role('rt-null-mode', 'Null Mode', { allocationMode: null }),
        ],
        namedResources: [{
          id: 'nr-override',
          resourceTypeId: 'rt-q',
          name: 'Override Person',
          startWeek: null,
          endWeek: null,
          allocationPct: null,
          allocationMode: 'TIMELINE',
          allocationPercent: 70,
          allocationStartWeek: null,
          allocationEndWeek: null,
          pricingModel: 'ACTUAL_DAYS',
        }],
        timelineEntries: [],
        storyTimelineEntries: [],
        epicDependencies: [],
        featureDependencies: [],
        overheadItems: [],
      },
    }
  }

  it('valid non-CAPACITY_PLAN companions are never quarantined (Class A snapshot)', () => {
    const plan = buildRemediationPlan(
      { projects: [makeProject()], snapshots: [makeQuarantineWithValidCompanions()] },
      'commit-1',
    )
    const quarantined = plan.findings.filter(f => f.classification === 'quarantined')
    // Only the genuine effective-CAPACITY_PLAN entry is quarantined.
    expect(quarantined).toHaveLength(1)
    expect(quarantined[0]!.entryId).toBe('rt-q')
    expect(quarantined[0]!.message).toContain('Class A')
    // Valid companions keep the normal valid/no-action treatment.
    for (const entryId of ['rt-timeline-null', 'rt-effort-stale', 'rt-full-null', 'rt-null-mode', 'nr-override']) {
      const finding = plan.findings.find(f => f.entryId === entryId)
      expect(finding?.classification).toBe('alreadyValid')
    }
    // Companions create no decision, no operation, no unsupported finding.
    expect(plan.decisions).toHaveLength(0)
    expect(plan.operations).toHaveLength(0)
    expect(plan.summary.findings.unsupported).toBe(0)
    // summary.quarantined equals the actual quarantine-entry count.
    expect(plan.summary.quarantined).toBe(1)
    expect(plan.summary.findings.quarantined).toBe(1)
    expect(classifyPlanExit(plan)).toBe(0)
  })

  it('valid non-CAPACITY_PLAN companions are never quarantined (Class B snapshot)', () => {
    const snapshot = makeQuarantineWithValidCompanions()
    ;(snapshot.snapshot as Record<string, unknown>).resourceTypes = [
      v2Role('rt-q', 'Quarantine Role', { allocationMode: 'CAPACITY_PLAN', allocationStartWeek: -1, allocationEndWeek: 5 }),
      v2Role('rt-timeline-null', 'Timeline Null', { allocationMode: 'TIMELINE' }),
      v2Role('rt-effort-stale', 'Effort Stale', { allocationMode: 'EFFORT', allocationStartWeek: 2, allocationEndWeek: 9 }),
    ]
    const plan = buildRemediationPlan({ projects: [makeProject()], snapshots: [snapshot] }, 'commit-1')
    const quarantined = plan.findings.filter(f => f.classification === 'quarantined')
    expect(quarantined).toHaveLength(1)
    expect(quarantined[0]!.entryId).toBe('rt-q')
    expect(quarantined[0]!.message).toContain('Class B')
    expect(plan.summary.quarantined).toBe(1)
    expect(plan.decisions).toHaveLength(0)
    expect(plan.operations).toHaveLength(0)
  })

  it('quarantine findings with valid companions are deterministic and manifest-stable', () => {
    const plan1 = buildRemediationPlan(
      { projects: [makeProject()], snapshots: [makeQuarantineWithValidCompanions()] },
      'commit-1',
    )
    const plan2 = buildRemediationPlan(
      { projects: [makeProject()], snapshots: [makeQuarantineWithValidCompanions()] },
      'commit-1',
    )
    expect(plan2.fingerprint).toBe(plan1.fingerprint)
    expect(plan2.summary).toEqual(plan1.summary)

    // Resolving an (empty) manifest must not alter quarantined findings: no
    // decision exists for them, so they are untouched by resolution.
    const resolved = resolvePlanWithManifest(plan1, {
      formatVersion: 1,
      applicationCommit: 'commit-1',
      planFingerprint: plan1.fingerprint,
      decisions: [],
    })
    expect(resolved.errors).toEqual([])
    expect(resolved.plan.summary.quarantined).toBe(1)
    const resolvedQuarantined = resolved.plan.findings.filter(f => f.classification === 'quarantined')
    expect(resolvedQuarantined).toHaveLength(1)
    expect(resolvedQuarantined[0]!.entryId).toBe('rt-q')
    expect(resolvedQuarantined[0]!.decisionId).toBeNull()
    // No rewrite-snapshot-entry operation exists for the quarantined entry.
    expect(resolved.plan.operations.some(op => op.kind === 'rewrite-snapshot-entry')).toBe(false)
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

// ─── Owner-kind decisions (issue #421 review round 2) ───────────────────────

describe('owner-kind decisions for ambiguous NamedResources', () => {
  function ambiguousNrProject(): { project: RemediationProject; nr: RemediationNamedResource } {
    const nr = makeNr({ id: 'nr-amb', allocationMode: 'CAPACITY_PLAN' })
    return {
      nr,
      project: makeProject({
        resourceTypes: [
          makeRt({ id: 'rt-parent', allocationMode: 'EFFORT', namedResources: [nr] }),
        ],
      }),
    }
  }

  it('emits an owner-kind-required decision for a missing ambiguous NamedResource', () => {
    const { project } = ambiguousNrProject()
    const plan = buildRemediationPlan(makeState(project), 'commit-1')
    const decision = plan.decisions.find(d => d.ownerId === 'nr-amb')
    expect(decision).toBeDefined()
    expect(decision!.allowedResolutions).toEqual(['owner-kind-decision'])
    expect(decision!.message).toContain('owner kind and capacity require explicit review')
  })

  it('emits an owner-kind-required decision for a single -1 missing NamedResource', () => {
    const nr = makeNr({ id: 'nr-neg', allocationMode: 'CAPACITY_PLAN', startWeek: 0, endWeek: -1 })
    const plan = buildRemediationPlan(makeState(makeProject({
      resourceTypes: [makeRt({ id: 'rt-parent', allocationMode: 'EFFORT', namedResources: [nr] })],
    })), 'commit-1')
    const decision = plan.decisions.find(d => d.ownerId === 'nr-neg')
    expect(decision!.allowedResolutions).toEqual(['owner-kind-decision'])
  })

  it('rejects a direct capacity-only resolution while owner kind is unresolved', () => {
    const { project } = ambiguousNrProject()
    const plan = buildRemediationPlan(makeState(project), 'commit-1')
    const manifest = {
      formatVersion: 1 as const,
      applicationCommit: 'commit-1',
      planFingerprint: plan.fingerprint,
      decisions: [{
        decisionId: plan.decisions[0]!.id,
        projectId: 'proj-1',
        ownerId: 'nr-amb',
        snapshotId: null,
        resolution: { shape: 'availability-window' as const, defaultPercent: 100, startWeek: 0, endWeek: 10 },
      }],
    }
    const resolved = resolvePlanWithManifest(plan, manifest as RemediationManifest)
    expect(resolved.errors.join(' ')).toContain('not allowed for this entry')
  })

  it('creates the exact NAMED_PERSON profile from an explicit owner-kind decision', () => {
    const { project } = ambiguousNrProject()
    const plan = buildRemediationPlan(makeState(project), 'commit-1')
    const manifest = {
      formatVersion: 1 as const,
      applicationCommit: 'commit-1',
      planFingerprint: plan.fingerprint,
      decisions: [{
        decisionId: plan.decisions[0]!.id,
        projectId: 'proj-1',
        ownerId: 'nr-amb',
        snapshotId: null,
        resolution: {
          shape: 'owner-kind-decision' as const,
          ownerKind: 'NAMED_PERSON' as const,
          capacity: { shape: 'availability-window' as const, defaultPercent: 100, startWeek: 0, endWeek: 10 },
        },
      }],
    }
    const resolved = resolvePlanWithManifest(plan, manifest as RemediationManifest)
    expect(resolved.errors).toEqual([])
    expect(resolved.plan.operations).toHaveLength(1)
    expect(resolved.plan.operations[0]!).toMatchObject({
      kind: 'create-named-profile',
      classification: 'decisionResolved',
    })
    expect(resolved.plan.operations[0]!.proposed).toMatchObject({
      profileId: remediationProfileId('namedPerson', 'nr-amb'),
      ownerKind: 'NAMED_PERSON',
      planningBasis: 'AVAILABILITY_WINDOW',
      source: 'AVAILABILITY_WINDOW',
      defaultPercent: 100,
      startWeek: 0,
      endWeek: 10,
    })
  })

  it('creates the exact PLANNED_RESOURCE profile from an explicit owner-kind decision', () => {
    const { project } = ambiguousNrProject()
    const plan = buildRemediationPlan(makeState(project), 'commit-1')
    const manifest = {
      formatVersion: 1 as const,
      applicationCommit: 'commit-1',
      planFingerprint: plan.fingerprint,
      decisions: [{
        decisionId: plan.decisions[0]!.id,
        projectId: 'proj-1',
        ownerId: 'nr-amb',
        snapshotId: null,
        resolution: {
          shape: 'owner-kind-decision' as const,
          ownerKind: 'PLANNED_RESOURCE' as const,
          capacity: {
            shape: 'segmented-capacity-profile' as const,
            defaultPercent: 50,
            segments: [
              { startWeek: 5, endWeek: 10, capacityPercent: 25 },
              { startWeek: 0, endWeek: 4, capacityPercent: 50 },
            ],
          },
        },
      }],
    }
    const resolved = resolvePlanWithManifest(plan, manifest as RemediationManifest)
    expect(resolved.errors).toEqual([])
    const proposed = resolved.plan.operations[0]!.proposed
    expect(proposed).toMatchObject({
      ownerKind: 'PLANNED_RESOURCE',
      planningBasis: 'CAPACITY_PROFILE',
      source: 'LEGACY',
      defaultPercent: 50,
    })
    // Segments are ordered like the persisted read-back (startWeek, id).
    expect(proposed).toMatchObject({
      segments: [
        { startWeek: 0, endWeek: 4, capacityPercent: 50 },
        { startWeek: 5, endWeek: 10, capacityPercent: 25 },
      ],
    })
  })

  it('rejects an unknown nested capacity shape before writes', () => {
    const { project } = ambiguousNrProject()
    const plan = buildRemediationPlan(makeState(project), 'commit-1')
    const manifest = {
      formatVersion: 1 as const,
      applicationCommit: 'commit-1',
      planFingerprint: plan.fingerprint,
      decisions: [{
        decisionId: plan.decisions[0]!.id,
        projectId: 'proj-1',
        ownerId: 'nr-amb',
        snapshotId: null,
        resolution: {
          shape: 'owner-kind-decision' as const,
          ownerKind: 'NAMED_PERSON' as const,
          capacity: { shape: 'mystery-shape' } as never,
        },
      }],
    }
    const resolved = resolvePlanWithManifest(plan, manifest as RemediationManifest)
    expect(resolved.errors.join(' ')).toContain('unknown nested capacity shape')
  })

  it('rejects PLANNED_RESOURCE when the parent ROLE profile cannot be derived deterministically', () => {
    // Parent role is CAPACITY_PLAN without plan evidence → its ROLE profile
    // cannot be proven, so PLANNED_RESOURCE must not be selectable.
    const nr = makeNr({ id: 'nr-amb2', allocationMode: 'CAPACITY_PLAN' })
    const plan = buildRemediationPlan(makeState(makeProject({
      resourceTypes: [
        makeRt({ id: 'rt-parent2', allocationMode: 'CAPACITY_PLAN', namedResources: [nr] }),
      ],
    })), 'commit-1')
    const decision = plan.decisions.find(d => d.ownerId === 'nr-amb2')!
    expect(decision.roleProposed).toBeNull()
    const manifest = {
      formatVersion: 1 as const,
      applicationCommit: 'commit-1',
      planFingerprint: plan.fingerprint,
      decisions: [{
        decisionId: decision.id,
        projectId: 'proj-1',
        ownerId: 'nr-amb2',
        snapshotId: null,
        resolution: {
          shape: 'owner-kind-decision' as const,
          ownerKind: 'PLANNED_RESOURCE' as const,
          capacity: { shape: 'scalar-profile' as const, planningBasis: 'DEMAND_FOLLOWING' as const, defaultPercent: 100 },
        },
      }],
    }
    const resolved = resolvePlanWithManifest(plan, manifest as RemediationManifest)
    expect(resolved.errors.join(' ')).toContain('PLANNED_RESOURCE requires a valid existing or deterministically derivable parent ROLE profile')
  })

  it('emits the deterministic parent ROLE op when PLANNED_RESOURCE is selected', () => {
    const nr = makeNr({ id: 'nr-amb3', allocationMode: 'CAPACITY_PLAN' })
    const plan = buildRemediationPlan(makeState(makeProject({
      resourceTypes: [
        makeRt({ id: 'rt-parent3', allocationMode: 'EFFORT', namedResources: [nr] }),
      ],
    })), 'commit-1')
    const decision = plan.decisions.find(d => d.ownerId === 'nr-amb3')!
    expect(decision.roleProposed).not.toBeNull()
    expect(decision.roleOwnerId).toBe('rt-parent3')
    const manifest = {
      formatVersion: 1 as const,
      applicationCommit: 'commit-1',
      planFingerprint: plan.fingerprint,
      decisions: [{
        decisionId: decision.id,
        projectId: 'proj-1',
        ownerId: 'nr-amb3',
        snapshotId: null,
        resolution: {
          shape: 'owner-kind-decision' as const,
          ownerKind: 'PLANNED_RESOURCE' as const,
          capacity: { shape: 'scalar-profile' as const, planningBasis: 'DEMAND_FOLLOWING' as const, defaultPercent: 100 },
        },
      }],
    }
    const resolved = resolvePlanWithManifest(plan, manifest as RemediationManifest)
    expect(resolved.errors).toEqual([])
    expect(resolved.plan.operations).toHaveLength(2)
    expect(resolved.plan.operations[0]).toMatchObject({ kind: 'create-named-profile', ownerId: 'nr-amb3' })
    expect(resolved.plan.operations[1]).toMatchObject({
      kind: 'create-role-profile',
      ownerId: 'rt-parent3',
      decisionId: decision.id,
    })
    expect(resolved.plan.operations[1]!.proposed).toMatchObject({ ownerKind: 'ROLE', planningBasis: 'DEMAND_FOLLOWING' })
  })

  // ── Shared-parent coordination (issue #421 review round 3) ───────────────

  function sharedParentPlan(): {
    plan: RemediationPlan
    nrA: string
    nrB: string
    parentId: string
  } {
    const nrA = 'nr-shared-a'
    const nrB = 'nr-shared-b'
    const parentId = 'rt-shared'
    const plan = buildRemediationPlan(makeState(makeProject({
      resourceTypes: [
        makeRt({
          id: parentId,
          allocationMode: 'EFFORT',
          namedResources: [
            makeNr({ id: nrA, allocationMode: 'CAPACITY_PLAN' }),
            makeNr({ id: nrB, allocationMode: 'CAPACITY_PLAN' }),
          ],
        }),
      ],
    })), 'commit-1')
    return { plan, nrA, nrB, parentId }
  }

  function plannedResourceResolution(ownerId: string, decisionId: string): ManifestDecision {
    return {
      decisionId,
      projectId: 'proj-1',
      ownerId,
      snapshotId: null,
      resolution: {
        shape: 'owner-kind-decision',
        ownerKind: 'PLANNED_RESOURCE',
        capacity: { shape: 'scalar-profile', planningBasis: 'DEMAND_FOLLOWING', defaultPercent: 100 },
      },
    }
  }

  it('emits at most one parent ROLE op for two PLANNED_RESOURCE children of one parent', () => {
    const { plan, nrA, nrB, parentId } = sharedParentPlan()
    const decA = plan.decisions.find(d => d.ownerId === nrA)!
    const decB = plan.decisions.find(d => d.ownerId === nrB)!
    const manifest = {
      formatVersion: 1 as const,
      applicationCommit: 'commit-1',
      planFingerprint: plan.fingerprint,
      decisions: [
        plannedResourceResolution(nrA, decA.id),
        plannedResourceResolution(nrB, decB.id),
      ],
    }
    const resolved = resolvePlanWithManifest(plan, manifest as RemediationManifest)
    expect(resolved.errors).toEqual([])
    const childOps = resolved.plan.operations.filter(op => op.ownerId === nrA || op.ownerId === nrB)
    const parentOps = resolved.plan.operations.filter(op => op.ownerId === parentId && op.kind === 'create-role-profile')
    expect(childOps).toHaveLength(2)
    expect(parentOps).toHaveLength(1)
    expect(resolved.plan.operations).toHaveLength(3)
  })

  it('produces identical coordinated operations and fingerprint regardless of manifest decision order', () => {
    const { plan, nrA, nrB } = sharedParentPlan()
    const decA = plan.decisions.find(d => d.ownerId === nrA)!
    const decB = plan.decisions.find(d => d.ownerId === nrB)!
    const forward = {
      formatVersion: 1 as const,
      applicationCommit: 'commit-1',
      planFingerprint: plan.fingerprint,
      decisions: [
        plannedResourceResolution(nrA, decA.id),
        plannedResourceResolution(nrB, decB.id),
      ],
    }
    const reversed = {
      formatVersion: 1 as const,
      applicationCommit: 'commit-1',
      planFingerprint: plan.fingerprint,
      decisions: [
        plannedResourceResolution(nrB, decB.id),
        plannedResourceResolution(nrA, decA.id),
      ],
    }
    const forwardResolved = resolvePlanWithManifest(plan, forward as RemediationManifest)
    const reversedResolved = resolvePlanWithManifest(plan, reversed as RemediationManifest)
    expect(forwardResolved.errors).toEqual([])
    expect(reversedResolved.errors).toEqual([])
    expect(forwardResolved.plan.operations.map(op => op.id)).toEqual(reversedResolved.plan.operations.map(op => op.id))
    expect(forwardResolved.plan.fingerprint).toBe(reversedResolved.plan.fingerprint)
  })

  it('coordinates one parent ROLE op for mixed PLANNED_RESOURCE / NAMED_PERSON children', () => {
    const { plan, nrA, nrB, parentId } = sharedParentPlan()
    const decA = plan.decisions.find(d => d.ownerId === nrA)!
    const decB = plan.decisions.find(d => d.ownerId === nrB)!
    const manifest = {
      formatVersion: 1 as const,
      applicationCommit: 'commit-1',
      planFingerprint: plan.fingerprint,
      decisions: [
        plannedResourceResolution(nrA, decA.id),
        {
          decisionId: decB.id,
          projectId: 'proj-1',
          ownerId: nrB,
          snapshotId: null,
          resolution: {
            shape: 'owner-kind-decision' as const,
            ownerKind: 'NAMED_PERSON' as const,
            capacity: { shape: 'availability-window' as const, defaultPercent: 100, startWeek: 0, endWeek: 10 },
          },
        },
      ],
    }
    const resolved = resolvePlanWithManifest(plan, manifest as RemediationManifest)
    expect(resolved.errors).toEqual([])
    const parentOps = resolved.plan.operations.filter(op => op.ownerId === parentId && op.kind === 'create-role-profile')
    expect(parentOps).toHaveLength(1)
    const childA = resolved.plan.operations.find(op => op.ownerId === nrA)!
    const childB = resolved.plan.operations.find(op => op.ownerId === nrB)!
    expect(childA.proposed).toMatchObject({ ownerKind: 'PLANNED_RESOURCE' })
    expect(childB.proposed).toMatchObject({ ownerKind: 'NAMED_PERSON' })
  })

  it('retains a valid existing parent ROLE profile (roleState existing) and emits no parent op', () => {
    const nr = makeNr({ id: 'nr-exist', allocationMode: 'CAPACITY_PLAN' })
    const plan = buildRemediationPlan(makeState(makeProject({
      resourceTypes: [
        makeRt({
          id: 'rt-exist',
          allocationMode: 'EFFORT',
          namedResources: [nr],
        }),
      ],
      capacityProfiles: [{
        id: 'prof-exist-role',
        projectId: 'proj-1',
        resourceTypeId: 'rt-exist',
        namedResourceId: null,
        ownerKind: 'ROLE',
        planningBasis: 'DEMAND_FOLLOWING',
        source: 'FIXED',
        defaultPercent: 100,
        startWeek: null,
        endWeek: null,
        legacy: null,
        segments: [],
      }],
    })), 'commit-1')
    const decision = plan.decisions.find(d => d.ownerId === 'nr-exist')!
    expect(decision.roleState).toBe('existing')
    expect(decision.roleProposed).toBeNull()
    const manifest = {
      formatVersion: 1 as const,
      applicationCommit: 'commit-1',
      planFingerprint: plan.fingerprint,
      decisions: [plannedResourceResolution('nr-exist', decision.id)],
    }
    const resolved = resolvePlanWithManifest(plan, manifest as RemediationManifest)
    expect(resolved.errors).toEqual([])
    expect(resolved.plan.operations).toHaveLength(1) // child only
    expect(resolved.plan.operations[0]!.ownerId).toBe('nr-exist')
  })

  it('reuses a compatible baseline parent ROLE operation (planner-owned parent)', () => {
    // Planner-owned parent: baseline ROLE op derived from plan entries +
    // one ambiguous NR decision; PLANNED_RESOURCE must reuse the baseline op.
    const nr = makeNr({ id: 'nr-base', allocationMode: 'CAPACITY_PLAN' })
    const plan = buildRemediationPlan(makeState(makeProject({
      resourceTypes: [
        makeRt({
          id: 'rt-base',
          allocationMode: 'CAPACITY_PLAN',
          count: 1,
          namedResources: [
            makeNr({ id: 'nr-planned', allocationMode: 'CAPACITY_PLAN' }),
            nr,
          ],
        }),
      ],
      activePlanPeriods: [{
        periodIndex: 0,
        startWeek: 0,
        endWeek: 8,
        entries: [{ resourceTypeId: 'rt-base', headcount: 1 }],
      }],
      capacityProfiles: [{
        id: 'prof-nr-planned',
        projectId: 'proj-1',
        resourceTypeId: null,
        namedResourceId: 'nr-planned',
        ownerKind: 'PLANNED_RESOURCE',
        planningBasis: 'CAPACITY_PROFILE',
        source: 'SQUAD_PLANNER',
        defaultPercent: null,
        startWeek: 0,
        endWeek: 7,
        legacy: null,
        segments: [{ id: 'seg-planned', startWeek: 0, endWeek: 7, capacityPercent: 100, source: 'SQUAD_PLANNER' }],
      }],
    })), 'commit-1')
    const baselineRoleOps = plan.operations.filter(op => op.ownerId === 'rt-base' && op.kind === 'create-role-profile')
    expect(baselineRoleOps).toHaveLength(1)
    const decision = plan.decisions.find(d => d.ownerId === 'nr-base')!
    expect(decision.roleState).toBe('derived')
    const manifest = {
      formatVersion: 1 as const,
      applicationCommit: 'commit-1',
      planFingerprint: plan.fingerprint,
      decisions: [plannedResourceResolution('nr-base', decision.id)],
    }
    const resolved = resolvePlanWithManifest(plan, manifest as RemediationManifest)
    expect(resolved.errors).toEqual([])
    const parentRoleOps = resolved.plan.operations.filter(op => op.ownerId === 'rt-base' && op.kind === 'create-role-profile')
    expect(parentRoleOps).toHaveLength(1) // baseline reused, no duplicate
    expect(resolved.plan.operations).toHaveLength(2) // baseline role op + child
  })

  it('rejects conflicting parent ROLE requirements and identifies the parent and decisions', () => {
    const { plan, nrA, nrB } = sharedParentPlan()
    const decA = plan.decisions.find(d => d.ownerId === nrA)!
    const decB = plan.decisions.find(d => d.ownerId === nrB)!
    // Mutate one child's captured role proposal so the two decisions imply
    // different parent ROLE profiles.
    const mutatedPlan = JSON.parse(JSON.stringify(plan)) as RemediationPlan
    const mutatedB = mutatedPlan.decisions.find(d => d.ownerId === nrB)!
    mutatedB.roleProposed = {
      ...JSON.parse(JSON.stringify(mutatedB.roleProposed)),
      defaultPercent: 123,
    } as unknown as ProposedProfile
    const manifest = {
      formatVersion: 1 as const,
      applicationCommit: 'commit-1',
      planFingerprint: plan.fingerprint,
      decisions: [
        plannedResourceResolution(nrA, decA.id),
        plannedResourceResolution(nrB, decB.id),
      ],
    }
    const resolved = resolvePlanWithManifest(mutatedPlan, manifest as RemediationManifest)
    expect(resolved.errors.join(' ')).toContain('conflicting parent ROLE proposals')
    expect(resolved.errors.join(' ')).toContain('rt-shared')
    expect(resolved.errors.join(' ')).toContain(decA.id)
    expect(resolved.errors.join(' ')).toContain(decB.id)
  })

  it('rejects a parent ROLE requirement conflicting with a baseline operation', () => {
    const nr = makeNr({ id: 'nr-conflict', allocationMode: 'CAPACITY_PLAN' })
    const plan = buildRemediationPlan(makeState(makeProject({
      resourceTypes: [
        makeRt({
          id: 'rt-conflict',
          allocationMode: 'CAPACITY_PLAN',
          count: 1,
          namedResources: [
            makeNr({ id: 'nr-planned2', allocationMode: 'CAPACITY_PLAN' }),
            nr,
          ],
        }),
      ],
      activePlanPeriods: [{
        periodIndex: 0,
        startWeek: 0,
        endWeek: 8,
        entries: [{ resourceTypeId: 'rt-conflict', headcount: 1 }],
      }],
      capacityProfiles: [{
        id: 'prof-nr-planned2',
        projectId: 'proj-1',
        resourceTypeId: null,
        namedResourceId: 'nr-planned2',
        ownerKind: 'PLANNED_RESOURCE',
        planningBasis: 'CAPACITY_PROFILE',
        source: 'SQUAD_PLANNER',
        defaultPercent: null,
        startWeek: 0,
        endWeek: 7,
        legacy: null,
        segments: [{ id: 'seg-planned2', startWeek: 0, endWeek: 7, capacityPercent: 100, source: 'SQUAD_PLANNER' }],
      }],
    })), 'commit-1')
    const baselineRoleOps = plan.operations.filter(op => op.ownerId === 'rt-conflict' && op.kind === 'create-role-profile')
    expect(baselineRoleOps).toHaveLength(1)
    const decision = plan.decisions.find(d => d.ownerId === 'nr-conflict')!
    const mutatedPlan = JSON.parse(JSON.stringify(plan)) as RemediationPlan
    const mutatedDecision = mutatedPlan.decisions.find(d => d.ownerId === 'nr-conflict')!
    mutatedDecision.roleProposed = {
      ...JSON.parse(JSON.stringify(mutatedDecision.roleProposed)),
      defaultPercent: 321,
    } as unknown as ProposedProfile
    const manifest = {
      formatVersion: 1 as const,
      applicationCommit: 'commit-1',
      planFingerprint: plan.fingerprint,
      decisions: [plannedResourceResolution('nr-conflict', decision.id)],
    }
    const resolved = resolvePlanWithManifest(mutatedPlan, manifest as RemediationManifest)
    expect(resolved.errors.join(' ')).toContain('conflicts with baseline operation')
    expect(resolved.errors.join(' ')).toContain('rt-conflict')
    expect(resolved.errors.join(' ')).toContain(baselineRoleOps[0]!.id)
  })

  it('keeps deterministic NamedResource mappings unchanged (no owner-kind decision)', () => {
    const nr = makeNr({ id: 'nr-det', allocationMode: 'TIMELINE', startWeek: 0, endWeek: 8 })
    const plan = buildRemediationPlan(makeState(makeProject({
      resourceTypes: [makeRt({ id: 'rt-parent', allocationMode: 'EFFORT', namedResources: [nr] })],
    })), 'commit-1')
    expect(plan.decisions).toHaveLength(0)
    expect(plan.operations).toHaveLength(1)
    expect(plan.operations[0]!.proposed).toMatchObject({ ownerKind: 'NAMED_PERSON' })
  })
})

// ─── Baseline state hash (issue #421 review round 2) ────────────────────────

describe('baselineStateHash', () => {
  it('is present, stable for identical state and changes with state', () => {
    const state = makeState(makeProject({
      resourceTypes: [makeRt({ allocationMode: 'TIMELINE' })],
    }))
    const plan1 = buildRemediationPlan(state, 'commit-1')
    const plan2 = buildRemediationPlan(state, 'commit-2')
    expect(plan1.baselineStateHash).toBe(plan2.baselineStateHash)
    const changed = buildRemediationPlan(makeState(makeProject({
      resourceTypes: [makeRt({ allocationMode: 'TIMELINE', allocationPercent: 50 })],
    })), 'commit-1')
    expect(changed.baselineStateHash).not.toBe(plan1.baselineStateHash)
  })

  it('is covered by the plan fingerprint (tamper detection)', () => {
    const plan = buildRemediationPlan(makeState(makeProject({
      resourceTypes: [makeRt({ allocationMode: 'TIMELINE' })],
    })), 'commit-1')
    const json = JSON.parse(JSON.stringify(plan)) as Record<string, unknown>
    json.baselineStateHash = 'deadbeef'
    const parsed = parsePlanJson(JSON.stringify(json))
    expect(parsed.plan).toBeNull()
    expect(parsed.errors.join(' ')).toContain('fingerprint mismatch')
  })

  it('round-trips through the plan file contract', () => {
    const plan = buildRemediationPlan(makeState(makeProject({
      resourceTypes: [makeRt({ allocationMode: 'TIMELINE' })],
    })), 'commit-1')
    const parsed = parsePlanJson(JSON.stringify(plan))
    expect(parsed.errors).toEqual([])
    expect(parsed.plan!.baselineStateHash).toBe(plan.baselineStateHash)
  })
})
