/**
 * snapshotRestorability.ts — Derived restorability classifier for stored
 * snapshots (Issue #428, policy #426).
 *
 * One small pure classifier decides whether a stored snapshot is restorable,
 * derived-quarantined, or a blocking defect. The verdict is a pure function of
 * the raw snapshot content: deterministic, read-only, independent of current
 * live project state, and reusable by listing, rollback, readiness,
 * remediation and retention pruning.
 *
 * Policy boundary (never a translation error-string match):
 *   - Class A — v2 CAPACITY_PLAN entries with no captured window;
 *   - Class B — v2 CAPACITY_PLAN entries with a single `-1` window edge.
 *
 * Entry-level translation rules (mode mapping, alias fallback, never-active
 * windows, orphan rejection, percentage and window-value checks) come from the
 * shared helpers in `projectSnapshotCapacity.ts` — the same code the
 * authoritative translator runs — so there is exactly one source of truth.
 *
 * A snapshot is quarantined only when at least one entry matches Class A or
 * Class B and every other entry either translates successfully or matches an
 * approved shape; any independent defect anywhere makes the snapshot a
 * blocking defect. Quarantine never rewrites or annotates the stored record.
 */

import {
  parseSnapshotData,
  isLegacyV1Snapshot,
  isSnapshotV2,
  isSnapshotV3,
  isSnapshotV4,
  type SnapshotData,
  type SnapshotResourceType,
  type SnapshotNamedResource,
} from './projectSnapshotTypes.js'
import { validateSnapshotV3 } from './projectSnapshotValidation.js'
import {
  translateV2SnapshotProfiles,
  isKnownV2Mode,
  v2PercentIsValid,
  v2EffectiveNamedMode,
  v2ResourceTypeEntryErrors,
  v2NamedResourceEntryErrors,
  v2ProfilesToStructureInput,
  isNonNegativeInteger,
  type TranslatedV2Profile,
} from './projectSnapshotCapacity.js'
import { validatePersistedCapacityProfiles } from './persistedCapacityProfileValidation.js'

// ─── Stable quarantine reasons ───────────────────────────────────────────────

/**
 * Stable, tested Class A quarantine reason (user-visible). No production
 * identifiers are embedded — the class is a property of the raw record.
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

// ─── Per-entry evaluation ────────────────────────────────────────────────────

type EntryVerdict =
  | { kind: 'restorable' }
  | { kind: 'quarantined'; entryClass: V2QuarantineClass }
  | { kind: 'defect' }

function evaluateResourceTypeEntry(rt: SnapshotResourceType, index: number): EntryVerdict {
  const prefix = `v2 snapshot resourceTypes[${index}] (${rt.name})`
  if (rt.allocationMode != null && !isKnownV2Mode(rt.allocationMode)) {
    return { kind: 'defect' }
  }
  if (rt.allocationMode === 'CAPACITY_PLAN') {
    const entryClass = classifyV2QuarantineShape({
      primaryStart: rt.allocationStartWeek ?? null,
      aliasStart: null,
      primaryEnd: rt.allocationEndWeek ?? null,
      aliasEnd: null,
    })
    if (entryClass != null && v2PercentIsValid(rt.allocationPercent)) {
      return { kind: 'quarantined', entryClass }
    }
  }
  const errors = v2ResourceTypeEntryErrors(rt, prefix)
  return errors.length > 0 ? { kind: 'defect' } : { kind: 'restorable' }
}

function evaluateNamedResourceEntry(
  nr: SnapshotNamedResource,
  parentRt: SnapshotResourceType | undefined,
  index: number,
): EntryVerdict {
  const prefix = `v2 snapshot namedResources[${index}] (${nr.name})`
  // Orphan ownership is a blocking defect and can never quarantine.
  if (!nr.resourceTypeId || !parentRt) {
    return { kind: 'defect' }
  }
  const mode = v2EffectiveNamedMode(nr, parentRt)
  if (mode != null && !isKnownV2Mode(mode)) {
    return { kind: 'defect' }
  }
  if (mode === 'CAPACITY_PLAN') {
    const entryClass = classifyV2QuarantineShape({
      primaryStart: nr.allocationStartWeek ?? null,
      aliasStart: nr.startWeek ?? null,
      primaryEnd: nr.allocationEndWeek ?? null,
      aliasEnd: nr.endWeek ?? null,
    })
    if (
      entryClass != null &&
      v2PercentIsValid(nr.allocationPercent) &&
      v2PercentIsValid(nr.allocationPct)
    ) {
      return { kind: 'quarantined', entryClass }
    }
  }
  // Conflicting populated aliases (the two captured fields of one edge
  // disagree) cannot be reconciled under the v2 rules and are a blocking
  // defect for window-using modes (policy #426, Section 3).
  if (mode === 'TIMELINE' || mode === 'CAPACITY_PLAN') {
    if (
      (nr.allocationStartWeek != null && nr.startWeek != null && nr.allocationStartWeek !== nr.startWeek) ||
      (nr.allocationEndWeek != null && nr.endWeek != null && nr.allocationEndWeek !== nr.endWeek)
    ) {
      return { kind: 'defect' }
    }
  }
  const errors = v2NamedResourceEntryErrors(nr, parentRt, prefix)
  return errors.length > 0 ? { kind: 'defect' } : { kind: 'restorable' }
}

// ─── Snapshot-level classification ───────────────────────────────────────────

function quarantineReasonFor(classes: V2QuarantineClass[]): string {
  const parts: string[] = []
  if (classes.includes('A')) parts.push(QUARANTINE_CLASS_A_REASON)
  if (classes.includes('B')) parts.push(QUARANTINE_CLASS_B_REASON)
  return parts.join(' ')
}

/**
 * Classify a stored snapshot's restorability from its raw content only.
 *
 * Outcomes:
 *   - `restorable` — V1; V3/V4 passing `validateSnapshotV3`; or V2 whose
 *     complete translation (including structural validation) succeeds;
 *   - `quarantined` — V2 with at least one Class A/B entry, every other entry
 *     translating successfully or matching an approved shape, and no
 *     independent defect anywhere;
 *   - `defect` — parse failure, unknown version, V3/V4 validation failure,
 *     any V2 entry error outside the approved shapes, or any structural
 *     validation error (mixed quarantine-and-defect snapshots are defects).
 *
 * Never throws; never rewrites the stored record.
 */
export function classifySnapshotRestorability(
  raw: unknown,
  projectId: string,
): SnapshotRestorability {
  let parsed: SnapshotData
  try {
    parsed = parseSnapshotData(raw)
  } catch (error) {
    return {
      kind: 'defect',
      restoreStatus: 'non-restorable',
      restoreReason: `unsupported or malformed snapshot data — ${error instanceof Error ? error.message : String(error)}`,
    }
  }

  if (isLegacyV1Snapshot(parsed)) {
    return { kind: 'restorable', restoreStatus: 'restorable', restoreReason: null }
  }

  if (isSnapshotV3(parsed) || isSnapshotV4(parsed)) {
    try {
      validateSnapshotV3(parsed as Parameters<typeof validateSnapshotV3>[0])
    } catch (error) {
      return {
        kind: 'defect',
        restoreStatus: 'non-restorable',
        restoreReason: `invalid payload — ${error instanceof Error ? error.message : String(error)}`,
      }
    }
    return { kind: 'restorable', restoreStatus: 'restorable', restoreReason: null }
  }

  if (isSnapshotV2(parsed)) {
    const translation = translateV2SnapshotProfiles(parsed, projectId)
    const rtById = new Map(parsed.resourceTypes.map(rt => [rt.id, rt]))
    const quarantineClasses: V2QuarantineClass[] = []
    // Owner keys of entries matching an approved quarantine shape. Their
    // translated profile windows (e.g. the -1 edge) are the quarantine shape
    // itself, so structural validation of the snapshot must not treat those
    // derived window errors as independent defects.
    const quarantineOwnerKeys = new Set<string>()
    const markQuarantine = (entryClass: V2QuarantineClass, ownerKey: string): void => {
      quarantineClasses.push(entryClass)
      quarantineOwnerKeys.add(ownerKey)
    }

    for (let i = 0; i < parsed.resourceTypes.length; i++) {
      const rt = parsed.resourceTypes[i]!
      const verdict = evaluateResourceTypeEntry(rt, i)
      if (verdict.kind === 'defect') {
        return defectVerdict(translation.errors)
      }
      if (verdict.kind === 'quarantined') markQuarantine(verdict.entryClass, `rt::${rt.id}`)
    }
    for (let i = 0; i < parsed.namedResources.length; i++) {
      const nr = parsed.namedResources[i]!
      const verdict = evaluateNamedResourceEntry(nr, rtById.get(nr.resourceTypeId ?? ''), i)
      if (verdict.kind === 'defect') {
        return defectVerdict(translation.errors)
      }
      if (verdict.kind === 'quarantined') markQuarantine(verdict.entryClass, `nr::${nr.id}`)
    }

    // Snapshot-level structural errors (duplicate owners, percent ranges,
    // enum failures) are independent defects: a quarantine candidate with any
    // structural defect is a defect, never quarantine. Quarantine-shaped
    // entries are validated with their window edges removed so the -1/null
    // shape itself is not double-counted as a defect.
    const sanitizedProfiles: TranslatedV2Profile[] = translation.profiles.map(p => {
      const ownerKey = p.resourceTypeId ? `rt::${p.resourceTypeId}` : p.namedResourceId ? `nr::${p.namedResourceId}` : ''
      return quarantineOwnerKeys.has(ownerKey) ? { ...p, startWeek: null, endWeek: null } : p
    })
    const structureErrors = validatePersistedCapacityProfiles(
      v2ProfilesToStructureInput(sanitizedProfiles),
      {
        projectId,
        resourceTypeIds: new Set(parsed.resourceTypes.map(rt => rt.id)),
        namedResourceIds: new Set(parsed.namedResources.map(nr => nr.id)),
      },
    ).errors
    if (structureErrors.length > 0) {
      return defectVerdict(translation.errors)
    }

    if (quarantineClasses.length > 0) {
      return {
        kind: 'quarantined',
        restoreStatus: 'non-restorable',
        restoreReason: quarantineReasonFor(quarantineClasses),
        quarantineClasses,
      }
    }
    return { kind: 'restorable', restoreStatus: 'restorable', restoreReason: null }
  }

  return {
    kind: 'defect',
    restoreStatus: 'non-restorable',
    restoreReason: 'unsupported snapshot data',
  }
}

function defectVerdict(translationErrors: string[]): SnapshotRestorability {
  return {
    kind: 'defect',
    restoreStatus: 'non-restorable',
    restoreReason:
      translationErrors.length > 0
        ? `V2 snapshot capacity translation failed: ${translationErrors.join('; ')}`
        : 'V2 snapshot capacity translation failed',
  }
}
