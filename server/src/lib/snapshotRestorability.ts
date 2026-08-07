/**
 * snapshotRestorability.ts — Shared restorability classifier for stored
 * project snapshots (issue #428, policy #426, superseded by issue #444).
 *
 * One small pure classifier decides whether a stored snapshot is restorable
 * or non-restorable. The verdict is a pure function of the raw snapshot
 * content: deterministic, read-only, independent of current live project
 * state, and reusable by listing, rollback, readiness, remediation and
 * retention pruning.
 *
 * Issue #444 policy (V4 minimum): the product accepts the deliberate loss of
 * pre-V4 rollback history. V1/V2/V3 snapshots are no longer restorable for
 * ANY payload — even a previously-approved historical shape — and carry one
 * stable retirement reason. Only structurally valid V4 snapshots are
 * restorable; invalid V4 payloads and malformed/unsupported payloads are
 * blocking defects. No historical translation or Class A/B quarantine
 * analysis runs here any more; the raw-value quarantine predicates
 * (`classifyV2QuarantineShape`, Class A/B reasons) remain exported only for
 * the retained historical evidence/remediation tooling.
 */

import {
  isNonNegativeInteger,
} from './projectSnapshotCapacity.js'
import type { SnapshotNamedResource } from './projectSnapshotTypes.js'
import { classifySnapshotVersion } from './snapshotVersionClassification.js'

// ─── Stable retirement reason ────────────────────────────────────────────────

/**
 * Stable, tested retirement reason for deliberately-retired legacy snapshots
 * (issue #444). User-visible through the existing `restoreStatus` /
 * `restoreReason` contract; no production identifiers are embedded.
 */
export const RETIREMENT_REASON =
  'historical snapshot is no longer restorable: V4 is the minimum supported snapshot version'

// ─── Stable quarantine reasons (retained for historical tooling) ────────────

/**
 * Stable, tested Class A quarantine reason (user-visible in the retained
 * evidence/remediation tooling). No production identifiers are embedded —
 * the class is a property of the raw record.
 */
export const QUARANTINE_CLASS_A_REASON =
  'historical snapshot is non-restorable (quarantined): its CAPACITY_PLAN entries have no captured ' +
  'capacity window (Class A) — the original capacity window is not recoverable from the stored record'

/**
 * Stable, tested Class B quarantine reason (user-visible).
 */
export const QUARANTINE_CLASS_B_REASON =
  'historical snapshot is non-restorable (quarantined): its CAPACITY_PLAN entries carry a single ' +
  '-1 window edge (Class B) — the original capacity window is not recoverable from the stored record'

// ─── Verdict types ───────────────────────────────────────────────────────────

export type V2QuarantineClass = 'A' | 'B'

export type SnapshotRestorability =
  | {
      kind: 'restorable'
      restoreStatus: 'restorable'
      restoreReason: null
    }
  | {
      kind: 'retired'
      restoreStatus: 'non-restorable'
      restoreReason: string
    }
  | {
      kind: 'quarantined'
      restoreStatus: 'non-restorable'
      restoreReason: string
      quarantineClasses: V2QuarantineClass[]
    }
  | {
      kind: 'defect'
      restoreStatus: 'non-restorable'
      restoreReason: string
    }

// ─── Raw-value quarantine predicates (the reviewed policy constant) ─────────

export interface V2QuarantineWindowFields {
  primaryStart: number | null
  aliasStart: number | null
  primaryEnd: number | null
  aliasEnd: number | null
}

/**
 * Exact raw-value quarantine predicates for one v2 entry, evaluated on the
 * effective window edges and every populated alias:
 *
 * Class A — both effective edges absent/null (effective edges are computed
 * with the translator's alias fallback, so a populated alternate alias always
 * supplies an edge and excludes Class A).
 *
 * Class B — exactly one effective edge is `-1` and the other is a
 * non-negative integer; exactly one populated window field equals `-1` (the
 * "single -1 edge"); every other populated field is a non-negative integer;
 * and both fields of the non-negative edge agree when both are populated.
 * Any other negative, fractional or conflicting populated value excludes the
 * shape (defect).
 *
 * ResourceType entries pass null aliases (they have no `startWeek`/`endWeek`
 * fallback); NamedResource entries pass the real captured aliases.
 */
export function classifyV2QuarantineShape(
  fields: V2QuarantineWindowFields,
): V2QuarantineClass | null {
  const effectiveStart = fields.primaryStart ?? fields.aliasStart
  const effectiveEnd = fields.primaryEnd ?? fields.aliasEnd

  // Class A — both effective window edges absent.
  if (effectiveStart == null && effectiveEnd == null) return 'A'

  // Class B — exactly one effective edge is -1; the other must be a
  // non-negative integer (a null other edge is the blocking "-1 plus null"
  // shape, never quarantine).
  const startIsMinusOne = effectiveStart === -1
  const endIsMinusOne = effectiveEnd === -1
  if (startIsMinusOne === endIsMinusOne) return null
  const otherEdge = startIsMinusOne ? effectiveEnd : effectiveStart
  if (otherEdge == null || !isNonNegativeInteger(otherEdge)) return null

  const minusOneIsStart = startIsMinusOne
  const minusOnePrimary = minusOneIsStart ? fields.primaryStart : fields.primaryEnd
  const minusOneAlias = minusOneIsStart ? fields.aliasStart : fields.aliasEnd
  const otherPrimary = minusOneIsStart ? fields.primaryEnd : fields.primaryStart
  const otherAlias = minusOneIsStart ? fields.aliasEnd : fields.aliasStart

  // Exactly one populated field equals -1 (a second -1 field — e.g. both
  // aliases of the same edge — is not the reviewed single-edge shape).
  const minusOneCount = [
    fields.primaryStart,
    fields.aliasStart,
    fields.primaryEnd,
    fields.aliasEnd,
  ].filter(value => value === -1).length
  if (minusOneCount !== 1) return null

  // The -1 edge's other alias must be absent (a populated alias holding a
  // different value would conflict with the effective -1 edge).
  if (minusOnePrimary != null && minusOnePrimary !== -1) return null
  if (minusOneAlias != null && minusOneAlias !== -1) return null

  // The non-negative edge: every populated alias must be a non-negative
  // integer (no other negative/fractional/invalid value) and agree with the
  // effective value when both aliases are populated.
  if (otherPrimary != null && !isNonNegativeInteger(otherPrimary)) return null
  if (otherAlias != null && !isNonNegativeInteger(otherAlias)) return null
  if (otherPrimary != null && otherAlias != null && otherPrimary !== otherAlias) return null

  return 'B'
}

export type V2AliasEdge = 'start' | 'end'

/**
 * Per-edge conflicting-populated-alias predicate. A conflict exists when
 * both captured fields of one edge are populated and disagree. Window-using
 * modes only; any other mode reports no conflict on either edge.
 */
export function v2NamedResourceEdgeAliasConflict(
  nr: Pick<SnapshotNamedResource, 'allocationStartWeek' | 'allocationEndWeek' | 'startWeek' | 'endWeek'>,
  mode: string | null,
  edge: V2AliasEdge,
): boolean {
  if (mode !== 'TIMELINE' && mode !== 'CAPACITY_PLAN') return false
  if (edge === 'start') {
    return nr.allocationStartWeek != null && nr.startWeek != null && nr.allocationStartWeek !== nr.startWeek
  }
  return nr.allocationEndWeek != null && nr.endWeek != null && nr.allocationEndWeek !== nr.endWeek
}

/**
 * Conflicting populated aliases (the two captured fields of one edge
 * disagree) cannot be reconciled under the v2 rules and are a blocking
 * defect for window-using modes (policy #426, Section 3). Shared by the
 * retained historical evidence tooling. Derived from the per-edge predicate
 * so both share one definition.
 */
export function v2NamedResourceAliasConflict(
  nr: Pick<SnapshotNamedResource, 'allocationStartWeek' | 'allocationEndWeek' | 'startWeek' | 'endWeek'>,
  mode: string | null,
): boolean {
  return v2NamedResourceEdgeAliasConflict(nr, mode, 'start') || v2NamedResourceEdgeAliasConflict(nr, mode, 'end')
}

// ─── Classification ──────────────────────────────────────────────────────────

/**
 * Classify a stored snapshot's restorability from its raw content only
 * (issue #444 policy).
 *
 * Outcomes:
 *   - `restorable` — a structurally valid V4 payload;
 *   - `retired` — any V1/V2/V3 payload (deliberate legacy retirement: V4 is
 *     the minimum supported snapshot version; the payload is NOT analysed);
 *   - `defect` — malformed/unsupported data, or a V4 payload failing
 *     structural validation.
 *
 * Never throws; never rewrites the stored record.
 */
export function classifySnapshotRestorability(
  raw: unknown,
  _projectId: string,
): SnapshotRestorability {
  const version = classifySnapshotVersion(raw)

  switch (version.kind) {
    case 'v1':
    case 'v2':
    case 'v3':
      return {
        kind: 'retired',
        restoreStatus: 'non-restorable',
        restoreReason: RETIREMENT_REASON,
      }
    case 'v4':
      if (version.valid) {
        return { kind: 'restorable', restoreStatus: 'restorable', restoreReason: null }
      }
      return {
        kind: 'defect',
        restoreStatus: 'non-restorable',
        restoreReason: `invalid payload — ${version.reason}`,
      }
    case 'malformed':
      return {
        kind: 'defect',
        restoreStatus: 'non-restorable',
        restoreReason: `unsupported or malformed snapshot data — ${version.reason}`,
      }
  }
}
