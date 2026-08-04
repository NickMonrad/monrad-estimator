/**
 * snapshotEvidence.ts — Issue #432: pure, read-only aggregation of sanitized
 * historical snapshot evidence for the Issue #430 design investigation.
 *
 * One pure module with one responsibility: convert the existing read-only
 * remediation-plan result and shared snapshot-classifier results into a
 * versioned, sanitized aggregate evidence report. It reuses:
 *   - buildRemediationPlan / computeStateHash / computePlanFingerprint /
 *     classifyPlanExit (productionRemediationPlan.ts);
 *   - classifySnapshotRestorability / classifyV2QuarantineShape /
 *     v2NamedResourceAliasConflict (snapshotRestorability.ts);
 *   - parseSnapshotData / isSnapshotV2 (projectSnapshotTypes.ts);
 *   - v2EffectiveNamedMode / v2ResourceTypeEntryErrors /
 *     v2NamedResourceEntryErrors / v2PercentIsValid /
 *     translateV2SnapshotProfiles / validateV2TranslatedProfiles
 *     (projectSnapshotCapacity.ts).
 *
 * It never decides whether an entry should be translated, quarantined,
 * repaired or retained as decision-required: `policyDecision` is always
 * `not-assessed`. It emits aggregate evidence only — no project/snapshot/
 * owner/finding/decision identifiers, no names, no payloads.
 *
 * Pure function of its inputs (database state, snapshot created-at
 * metadata, reviewed expectations); performs zero writes; contains no I/O.
 */

  import { parseSnapshotData, isSnapshotV2, type SnapshotData, type SnapshotV2, type SnapshotResourceType, type SnapshotNamedResource } from './projectSnapshotTypes.js'
import {
  isKnownV2Mode,
  v2EffectiveNamedMode,
  v2ResourceTypeEntryErrors,
  v2NamedResourceEntryErrors,
  v2PercentIsValid,
  translateV2SnapshotProfiles,
  validateV2TranslatedProfiles,
} from './projectSnapshotCapacity.js'
import {
  classifySnapshotRestorability,
  classifyV2QuarantineShape,
  v2NamedResourceAliasConflict,
  v2NamedResourceEdgeAliasConflict,
  type SnapshotRestorability,
} from './snapshotRestorability.js'
import {
  buildRemediationPlan,
  canonicalJson,
  classifyPlanExit,
  classifySnapshotEntry,
  computePlanFingerprint,
  computeStateHash,
  sha256Hex,
  type RemediationDatabaseState,
} from './productionRemediationPlan.js'

// ─── Version and schema ─────────────────────────────────────────────────────

export const SNAPSHOT_EVIDENCE_FORMAT_VERSION = 1 as const

/** Stable evidence categories; never raw identifiers or payloads. */
export type OwnerKindCategory = 'resourceType' | 'namedResource' | 'unavailable'
export type NamedModeSourceCategory = 'explicit' | 'inherited' | 'other' | 'unavailable'
export type PercentCategory =
  | 'absent-null'
  | 'zero'
  | 'one-to-ninety-nine'
  | 'hundred'
  | 'above-hundred'
  | 'invalid-non-finite'
export type AlternateAliasState = 'all-absent-null' | 'populated' | 'conflicting'
export type MinusOneField = 'allocationStartWeek' | 'allocationEndWeek' | 'startWeek' | 'endWeek'
/** Fixed sanitized state vocabulary for one raw window field (no numbers). */
export type WindowFieldState = 'minus-one' | 'absent-null' | 'populated'
export type IndependentDefectCategory = 'entry-level' | 'structural' | 'both' | 'unavailable'
export type DefectSubgroup = 'eleven-windowless-only' | 'seven-single-minus-one'
export type SnapshotEraCategory =
  | 'before-2026-05-05'
  | '2026-05-05-to-2026-07-13'
  | '2026-07-14-or-later'
  | 'unavailable'

/** Stable entry-level translator error categories (derived from the shared
 * translator helpers, never a second policy implementation). */
export type EntryErrorCategory =
  | 'unknown-mode'
  | 'orphan-ownership'
  | 'non-finite-percent'
  | 'windowless-capacity-plan'
  | 'negative-one-window-value'
  | 'below-minus-one-window-value'
  | 'fractional-window-value'
  | 'negative-window-value'
  | 'inverted-window'
  | 'alias-conflict'
  | 'other'

/** Stable snapshot-level structural validation error categories (from the
 * shared validateV2TranslatedProfiles result). */
export type StructuralErrorCategory =
  | 'duplicate-owner'
  | 'percent-range'
  | 'profile-window'
  | 'invalid-planning-basis'
  | 'invalid-source'
  | 'invalid-owner-kind'
  | 'owner-fk'
  | 'segmentless-capacity-profile'
  | 'owner-not-found'
  | 'planning-basis-shape'
  | 'segment-shape'
  | 'other'

// ─── Reviewed expectations (production-run input, never hard-coded) ─────────

export interface SnapshotEvidenceExpected {
  /** Reviewed remediation-plan fingerprint (64 hex chars). */
  fingerprint: string
  /** Reviewed baseline-state hash over loadRemediationState scope. */
  baselineStateHash: string
  quarantinedEntries: number
  quarantinedSnapshots: number
  defectSnapshots: number
  windowlessDecisions: number
  singleMinusOneDecisions: number
  snapshotDecisions: number
  liveDecisions: number
  unsupported: number
  rewriteOperations: number
  /** Corrected topology: 11-snapshot windowless-only subgroup snapshot count. */
  topology11Snapshots: number
  /** Corrected topology: 7-snapshot single-`-1` subgroup snapshot count. */
  topology7Snapshots: number
  /** Corrected topology: 11-snapshot windowless-only subgroup decisions. */
  topology11WindowlessDecisions: number
  /** Corrected topology: 7-snapshot subgroup windowless decisions. */
  topology7WindowlessDecisions: number
  /** Corrected topology: 7-snapshot subgroup single-`-1` decisions. */
  topology7SingleMinusOneDecisions: number
}

// ─── Report schema (versioned, evidence-only) ───────────────────────────────

export interface SnapshotEvidenceReport {
  formatVersion: typeof SNAPSHOT_EVIDENCE_FORMAT_VERSION
  runMetadata: {
    generatedAt: string
    applicationCommit: string
  }
  expectedBoundary: SnapshotEvidenceExpected
  observedBoundary: {
    fingerprint: string
    baselineStateHash: string
    planExit: 0 | 1 | 2
    summary: {
      findings: Record<string, number>
      operations: number
      decisionsRequired: number
      quarantined: number
      rewriteOperations: number
    }
    snapshotPopulation: {
      totalSnapshots: number
      restorable: number
      quarantined: number
      defect: number
    }
  }
  integrityResult: {
    fingerprintMatch: boolean
    baselineMatch: boolean
    countsMatch: boolean
    reconciliationPassed: boolean
  }
  topology: {
    quarantinedSnapshots: number
    defectSnapshots: number
    windowlessDecisions: number
    singleMinusOneDecisions: number
    snapshotDecisions: number
    liveDecisions: number
    elevenSnapshotSubgroup: { snapshots: number; windowlessDecisions: number }
    sevenSnapshotSubgroup: {
      snapshots: number
      windowlessDecisions: number
      singleMinusOneDecisions: number
      totalDecisions: number
    }
    quarantinedFindingsWithDecisionOrOperationIds: number
  }
  singleNegativeEntries: Array<{
    label: string
    entryKind: OwnerKindCategory
    minusOneField: MinusOneField
    /** Sanitized state of every raw window field (never numeric values). */
    windowFields: Record<MinusOneField, WindowFieldState>
    /** Per-edge conflicting-populated-alias evidence (shared predicate). */
    aliasConflicts: { startEdge: boolean; endEdge: boolean }
    alternateAliasState: AlternateAliasState
    /** Sanitized mode values only (fixed evidence vocabulary). */
    rawMode: SanitizedMode
    parentMode: SanitizedMode
    effectiveMode: SanitizedMode
    modeSource: NamedModeSourceCategory
    allocationPercentCategory: PercentCategory
    allocationPctCategory: PercentCategory
    entryErrorCategories: EntryErrorCategory[]
    structuralErrorCategories: StructuralErrorCategory[]
    independentDefect: IndependentDefectCategory
  }>
  defectSnapshots: Array<{
    label: string
    subgroup: DefectSubgroup
    windowlessDecisionCount: number
    singleMinusOneDecisionCount: number
    otherDecisionRequiredCounts: Record<string, number>
    alreadyValidCount: number
    quarantinedCount: number
    unsupportedCount: number
    entryErrorCategories: Record<EntryErrorCategory, number>
    structuralErrorCategories: Record<StructuralErrorCategory, number>
    independentDefect: IndependentDefectCategory
  }>
  classAAggregates: {
    totalEntries: number
    totalSnapshots: number
    byOwnerKind: Record<OwnerKindCategory, number>
    byNamedModeSource: Record<NamedModeSourceCategory, number>
    percentageByCategory: Record<
      'resourceType' | NamedModeSourceCategory,
      { allocationPercent: Record<PercentCategory, number>; allocationPct: Record<PercentCategory, number> }
    >
    aliasShapes: {
      primaryAbsentNull: number
      fallbackAbsentNull: number
      populatedAgreeing: number
      conflicting: number
      unavailable: number
    }
    snapshotsByOwnerKindMix: { resourceTypeOnly: number; namedResourceOnly: number; mixed: number }
    /** Affected snapshots per owner-kind category (deduplicated per snapshot). */
    affectedSnapshotsByOwnerKind: Record<OwnerKindCategory, number>
    /** Affected snapshots per NamedResource mode-source category (deduplicated per snapshot). */
    affectedSnapshotsByNamedModeSource: Record<NamedModeSourceCategory, number>
    entriesByEra: Record<SnapshotEraCategory, number>
    snapshotsByEra: Record<SnapshotEraCategory, number>
  }
  unavailableEvidence: {
    singleEntriesModeSourceUnavailable: number
    defectSnapshotsIndependentDefectUnavailable: number
    classAEntriesEraUnavailable: number
    classASnapshotsEraUnavailable: number
  }
  reconciliation: {
    passed: boolean
    details: string[]
  }
  policyDecision: 'not-assessed'
}

// ─── Controlled error ───────────────────────────────────────────────────────

export type EvidenceErrorCode = 'unsupported-snapshot' | 'snapshot-parse-failure'

export class SnapshotEvidenceError extends Error {
  readonly code: EvidenceErrorCode
  constructor(code: EvidenceErrorCode, message: string) {
    super(message)
    this.name = 'SnapshotEvidenceError'
    this.code = code
  }
}

// ─── Small pure helpers ─────────────────────────────────────────────────────

function isHex64(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value)
}

export function isExpectedBoundaryShape(value: unknown): value is SnapshotEvidenceExpected {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return (
    typeof v.fingerprint === 'string' && isHex64(v.fingerprint) &&
    typeof v.baselineStateHash === 'string' && isHex64(v.baselineStateHash) &&
    typeof v.quarantinedEntries === 'number' && Number.isInteger(v.quarantinedEntries) && v.quarantinedEntries >= 0 &&
    typeof v.quarantinedSnapshots === 'number' && Number.isInteger(v.quarantinedSnapshots) && v.quarantinedSnapshots >= 0 &&
    typeof v.defectSnapshots === 'number' && Number.isInteger(v.defectSnapshots) && v.defectSnapshots >= 0 &&
    typeof v.windowlessDecisions === 'number' && Number.isInteger(v.windowlessDecisions) && v.windowlessDecisions >= 0 &&
    typeof v.singleMinusOneDecisions === 'number' && Number.isInteger(v.singleMinusOneDecisions) && v.singleMinusOneDecisions >= 0 &&
    typeof v.snapshotDecisions === 'number' && Number.isInteger(v.snapshotDecisions) && v.snapshotDecisions >= 0 &&
    typeof v.liveDecisions === 'number' && Number.isInteger(v.liveDecisions) && v.liveDecisions >= 0 &&
    typeof v.unsupported === 'number' && Number.isInteger(v.unsupported) && v.unsupported >= 0 &&
    typeof v.rewriteOperations === 'number' && Number.isInteger(v.rewriteOperations) && v.rewriteOperations >= 0 &&
    typeof v.topology11Snapshots === 'number' && Number.isInteger(v.topology11Snapshots) && v.topology11Snapshots >= 0 &&
    typeof v.topology7Snapshots === 'number' && Number.isInteger(v.topology7Snapshots) && v.topology7Snapshots >= 0 &&
    typeof v.topology11WindowlessDecisions === 'number' && Number.isInteger(v.topology11WindowlessDecisions) && v.topology11WindowlessDecisions >= 0 &&
    typeof v.topology7WindowlessDecisions === 'number' && Number.isInteger(v.topology7WindowlessDecisions) && v.topology7WindowlessDecisions >= 0 &&
    typeof v.topology7SingleMinusOneDecisions === 'number' && Number.isInteger(v.topology7SingleMinusOneDecisions) && v.topology7SingleMinusOneDecisions >= 0
  )
}

/**
 * Fixed evidence mode values. Arbitrary historical mode strings are never
 * copied into evidence output: known modes pass through, unknown or
 * malformed strings map to `other`, absent values map to null. The allowed
 * known set is exactly the repository's current known allocation modes
 * (checked through the shared `isKnownV2Mode` helper — no second list).
 */
export type SanitizedMode =
  | 'TIMELINE'
  | 'CAPACITY_PLAN'
  | 'EFFORT'
  | 'FULL_PROJECT'
  | null
  | 'other'
  | 'unavailable'

/** Pure mode normalization for outward-facing evidence only. */
export function sanitizeMode(value: string | null | undefined): SanitizedMode {
  if (value == null) return null
  if (isKnownV2Mode(value)) {
    // isKnownV2Mode is the shared known-mode check; the result is a known
    // mode by construction.
    return value as Exclude<SanitizedMode, null | 'other' | 'unavailable'>
  }
  return 'other'
}

/** Deterministic percentage bucket used for evidence only. */
export function percentCategory(value: number | null | undefined): PercentCategory {
  if (value == null) return 'absent-null'
  if (!Number.isFinite(value)) return 'invalid-non-finite'
  if (value === 0) return 'zero'
  if (value >= 1 && value <= 99) return 'one-to-ninety-nine'
  if (value === 100) return 'hundred'
  return 'above-hundred'
}

const ERA_BEFORE: SnapshotEraCategory = 'before-2026-05-05'
const ERA_MID: SnapshotEraCategory = '2026-05-05-to-2026-07-13'
const ERA_AFTER: SnapshotEraCategory = '2026-07-14-or-later'
const ERA_UNAVAILABLE: SnapshotEraCategory = 'unavailable'

/** Snapshot writer-era grouping from the stored created-at timestamp. The
 * timestamp is NOT proof of the exact historical writer; it is a directly
 * available metadata grouping only. */
export function snapshotEraCategory(createdAtIso: string | null | undefined): SnapshotEraCategory {
  if (!createdAtIso) return ERA_UNAVAILABLE
  const ms = Date.parse(createdAtIso)
  if (!Number.isFinite(ms)) return ERA_UNAVAILABLE
  const before = Date.parse('2026-05-05T00:00:00Z')
  const after = Date.parse('2026-07-14T00:00:00Z')
  if (ms < before) return ERA_BEFORE
  if (ms < after) return ERA_MID
  return ERA_AFTER
}

const WINDOW_FIELD_NAMES = ['allocationStartWeek', 'allocationEndWeek', 'startWeek', 'endWeek'] as const

/** Map a shared-translator error message to a stable evidence category. The
 * window-value message is refined from the raw field value the shared helper
 * already rejected (evidence granularity, not a new predicate). */
function entryErrorCategory(message: string, entry: SnapshotResourceType | SnapshotNamedResource): EntryErrorCategory {
  if (message.includes('unknown allocationMode')) return 'unknown-mode'
  if (message.includes('cannot be translated into authoritative ownership') || message.includes('orphan ownership cannot be translated')) return 'orphan-ownership'
  if (message.includes('allocationPercent must be finite') || message.includes('allocationPct must be finite')) return 'non-finite-percent'
  if (message.includes('cannot be translated without guessing capacity')) return 'windowless-capacity-plan'
  if (message.includes('must not exceed')) return 'inverted-window'
  for (const field of WINDOW_FIELD_NAMES) {
    if (!message.includes(`${field} must be a non-negative integer or null`)) continue
    const value = (entry as Record<string, unknown>)[field]
    if (value === -1) return 'negative-one-window-value'
    if (typeof value === 'number' && value < -1) return 'below-minus-one-window-value'
    if (typeof value === 'number' && !Number.isInteger(value)) return 'fractional-window-value'
    return 'negative-window-value'
  }
  return 'other'
}

/** Map a shared structural-validation message to a stable evidence category. */
function structuralErrorCategory(message: string): StructuralErrorCategory {
  if (message.includes('duplicate physical owner')) return 'duplicate-owner'
  if (message.includes('defaultPercent')) return 'percent-range'
  if (message.includes('invalid planningBasis')) return 'invalid-planning-basis'
  if (message.includes('invalid source')) return 'invalid-source'
  if (message.includes('invalid ownerKind')) return 'invalid-owner-kind'
  if (message.includes('must have exactly one owner FK')) return 'owner-fk'
  if (message.includes('CAPACITY_PROFILE with no segments')) return 'segmentless-capacity-profile'
  if (message.includes('not found in project')) return 'owner-not-found'
  if (message.includes('DEMAND_FOLLOWING must not') || message.includes('WHOLE_PROJECT_ALLOCATION must not')) return 'planning-basis-shape'
  if (message.includes('Segment ')) return 'segment-shape'
  if (message.includes('must be a non-negative finite integer') || message.includes('must not exceed')) return 'profile-window'
  return 'other'
}

function emptyCounts<T extends string>(categories: readonly T[]): Record<T, number> {
  const out = {} as Record<T, number>
  for (const category of categories) out[category] = 0
  return out
}

const ENTRY_ERROR_CATEGORIES: readonly EntryErrorCategory[] = [
  'unknown-mode', 'orphan-ownership', 'non-finite-percent', 'windowless-capacity-plan',
  'negative-one-window-value', 'below-minus-one-window-value', 'fractional-window-value',
  'negative-window-value', 'inverted-window', 'alias-conflict', 'other',
]

const STRUCTURAL_ERROR_CATEGORIES: readonly StructuralErrorCategory[] = [
  'duplicate-owner', 'percent-range', 'profile-window', 'invalid-planning-basis',
  'invalid-source', 'invalid-owner-kind', 'owner-fk', 'segmentless-capacity-profile',
  'owner-not-found', 'planning-basis-shape', 'segment-shape', 'other',
]

const PERCENT_CATEGORIES: readonly PercentCategory[] = [
  'absent-null', 'zero', 'one-to-ninety-nine', 'hundred', 'above-hundred', 'invalid-non-finite',
]

// ─── Per-entry evidence extraction (shared helpers only) ────────────────────

export interface V2EntryEvidence {
  kind: 'resourceType' | 'namedResource'
  effectiveMode: string | null
  modeSource: NamedModeSourceCategory
  parentMode: string | null
  minusOneFields: MinusOneField[]
  effectiveStart: number | null
  effectiveEnd: number | null
  entryErrorCategories: EntryErrorCategory[]
  allocationPercentCategory: PercentCategory
  allocationPctCategory: PercentCategory
  /** Class A/B per the shared classifier predicate (evidence reuse). */
  quarantineClass: 'A' | 'B' | null
}

function resourceTypeEntryEvidence(rt: SnapshotResourceType, index: number): V2EntryEvidence {
  const errors = v2ResourceTypeEntryErrors(rt, `v2 snapshot resourceTypes[${index}]`)
  const categories: EntryErrorCategory[] = []
  for (const error of errors) {
    const category = entryErrorCategory(error, rt)
    if (!categories.includes(category)) categories.push(category)
  }
  const mode = rt.allocationMode ?? null
  const minusOneFields: MinusOneField[] = []
  if (rt.allocationStartWeek === -1) minusOneFields.push('allocationStartWeek')
  if (rt.allocationEndWeek === -1) minusOneFields.push('allocationEndWeek')
  const quarantineClass = mode === 'CAPACITY_PLAN' && v2PercentIsValid(rt.allocationPercent)
    ? classifyV2QuarantineShape({
        primaryStart: rt.allocationStartWeek ?? null,
        aliasStart: null,
        primaryEnd: rt.allocationEndWeek ?? null,
        aliasEnd: null,
      })
    : null
  return {
    kind: 'resourceType',
    effectiveMode: mode,
    modeSource: 'unavailable',
    parentMode: null,
    minusOneFields,
    effectiveStart: rt.allocationStartWeek ?? null,
    effectiveEnd: rt.allocationEndWeek ?? null,
    entryErrorCategories: categories,
    allocationPercentCategory: percentCategory(rt.allocationPercent),
    allocationPctCategory: 'absent-null',
    quarantineClass,
  }
}

function namedResourceEntryEvidence(
  nr: SnapshotNamedResource,
  parentRt: SnapshotResourceType | undefined,
  index: number,
): V2EntryEvidence {
  const errors = v2NamedResourceEntryErrors(nr, parentRt, `v2 snapshot namedResources[${index}]`)
  const categories: EntryErrorCategory[] = []
  for (const error of errors) {
    const category = entryErrorCategory(error, nr)
    if (!categories.includes(category)) categories.push(category)
  }
  const parentMode = parentRt?.allocationMode ?? null
  const rawMode = nr.allocationMode ?? null
  const effectiveMode = v2EffectiveNamedMode(nr, parentRt)
  // Classifier-only alias-conflict rule (shared export, verdict-neutral reuse).
  if (v2NamedResourceAliasConflict(nr, effectiveMode) && !categories.includes('alias-conflict')) {
    categories.push('alias-conflict')
  }
  const modeSource: NamedModeSourceCategory =
    rawMode === 'CAPACITY_PLAN' ? 'explicit'
      : rawMode != null ? 'other'
        : parentMode === 'CAPACITY_PLAN' ? 'inherited'
          : parentMode == null ? 'unavailable'
            : 'other'
  const minusOneFields: MinusOneField[] = []
  if (nr.allocationStartWeek === -1) minusOneFields.push('allocationStartWeek')
  if (nr.allocationEndWeek === -1) minusOneFields.push('allocationEndWeek')
  if (nr.startWeek === -1) minusOneFields.push('startWeek')
  if (nr.endWeek === -1) minusOneFields.push('endWeek')
  const effectiveStart = nr.allocationStartWeek ?? nr.startWeek ?? null
  const effectiveEnd = nr.allocationEndWeek ?? nr.endWeek ?? null
  const quarantineClass =
    effectiveMode === 'CAPACITY_PLAN' &&
    v2PercentIsValid(nr.allocationPercent) &&
    v2PercentIsValid(nr.allocationPct)
      ? classifyV2QuarantineShape({
          primaryStart: nr.allocationStartWeek ?? null,
          aliasStart: nr.startWeek ?? null,
          primaryEnd: nr.allocationEndWeek ?? null,
          aliasEnd: nr.endWeek ?? null,
        })
      : null
  return {
    kind: 'namedResource',
    effectiveMode,
    modeSource,
    parentMode,
    minusOneFields,
    effectiveStart,
    effectiveEnd,
    entryErrorCategories: categories,
    allocationPercentCategory: percentCategory(nr.allocationPercent),
    allocationPctCategory: percentCategory(nr.allocationPct),
    quarantineClass,
  }
}

// ─── Snapshot-level evidence ────────────────────────────────────────────────

export interface SnapshotEvidence {
  restorability: SnapshotRestorability
  /** Entry evidence in payload order (resourceTypes then namedResources). */
  entries: V2EntryEvidence[]
  structuralErrorCategories: StructuralErrorCategory[]
}

/** Classify one stored snapshot through the shared classifier and shared
 * translator helpers only. Throws SnapshotEvidenceError on parse failure or
 * unsupported versions (fail closed). */
export function classifySnapshotEvidence(raw: unknown, projectId: string): SnapshotEvidence {
  let parsed: SnapshotData
  try {
    parsed = parseSnapshotData(raw)
  } catch {
    throw new SnapshotEvidenceError('snapshot-parse-failure', 'a stored snapshot payload could not be parsed')
  }
  const version = (parsed as { schemaVersion?: unknown }).schemaVersion
  if (!isSnapshotV2(parsed)) {
    // V1 is a bare epic array (no schemaVersion); V3/V4 carry schemaVersion 3/4.
    if (!Array.isArray(parsed) && version !== 1 && version !== 3 && version !== 4) {
      throw new SnapshotEvidenceError('unsupported-snapshot', 'a stored snapshot has an unsupported schema version')
    }
    return {
      restorability: classifySnapshotRestorability(raw, projectId),
      entries: [],
      structuralErrorCategories: [],
    }
  }
  const restorability = classifySnapshotRestorability(raw, projectId)
  const rtById = new Map(parsed.resourceTypes.map(rt => [rt.id, rt]))
  const entries: V2EntryEvidence[] = []
  for (let i = 0; i < parsed.resourceTypes.length; i++) {
    entries.push(resourceTypeEntryEvidence(parsed.resourceTypes[i]!, i))
  }
  for (let i = 0; i < parsed.namedResources.length; i++) {
    const nr = parsed.namedResources[i]!
    entries.push(namedResourceEntryEvidence(nr, rtById.get(nr.resourceTypeId ?? ''), i))
  }
  const translation = translateV2SnapshotProfiles(parsed, projectId)
  const structuralErrorCategories = validateV2TranslatedProfiles(translation.profiles, projectId, parsed)
    .map(message => structuralErrorCategory(message))
  return { restorability, entries, structuralErrorCategories }
}

// ─── Evidence assembly ──────────────────────────────────────────────────────

const WINDOWLESS_DECISION_MESSAGE = 'CAPACITY_PLAN without captured window'
const SINGLE_NEGATIVE_DECISION_MESSAGE = 'single -1/negative window edge'

function snapshotDecisionCategory(message: string): 'windowless' | 'single-negative' | 'other' {
  if (message.includes(WINDOWLESS_DECISION_MESSAGE)) return 'windowless'
  if (message.includes(SINGLE_NEGATIVE_DECISION_MESSAGE)) return 'single-negative'
  return 'other'
}

/**
 * Raw payload shape for the plan-level snapshot-entry classifier (the exact
 * fields the remediation plan builder passes).
 */
function planEntryPayload(rt: SnapshotResourceType | SnapshotNamedResource, kind: 'resourceType' | 'namedResource'): {
  allocationMode: string | null
  allocationPercent: number | null
  allocationPct?: number | null
  allocationStartWeek: number | null
  allocationEndWeek: number | null
  startWeek?: number | null
  endWeek?: number | null
} {
  return {
    allocationMode: rt.allocationMode ?? null,
    allocationPercent: rt.allocationPercent ?? null,
    allocationStartWeek: rt.allocationStartWeek ?? null,
    allocationEndWeek: rt.allocationEndWeek ?? null,
    ...(kind === 'namedResource'
      ? {
          allocationPct: (rt as SnapshotNamedResource).allocationPct ?? null,
          startWeek: (rt as SnapshotNamedResource).startWeek ?? null,
          endWeek: (rt as SnapshotNamedResource).endWeek ?? null,
        }
      : {}),
  }
}

export interface SnapshotEvidenceInputs {
  state: RemediationDatabaseState
  /** snapshot id → ISO created-at timestamp (separate read-only query;
   * deliberately NOT part of the baseline-state hash scope). */
  snapshotCreatedAtById: ReadonlyMap<string, string>
  applicationCommit: string
  generatedAt: string
  expected: SnapshotEvidenceExpected
}

interface ClassifiedSnapshot {
  evidence: SnapshotEvidence
  v2: boolean
  parsed: SnapshotData | null
  /** Narrowed v2 payload when v2 (resourceTypes/namedResources access). */
  parsedV2: SnapshotV2 | null
}

function classifyAllSnapshots(state: RemediationDatabaseState): ClassifiedSnapshot[] {
  return state.snapshots.map(snapshot => {
    const evidence = classifySnapshotEvidence(snapshot.snapshot, snapshot.projectId)
    let parsed: SnapshotData | null = null
    try {
      parsed = parseSnapshotData(snapshot.snapshot)
    } catch {
      // classifySnapshotEvidence already failed closed above.
    }
    const parsedV2 = parsed != null && isSnapshotV2(parsed) ? parsed : null
    return { evidence, v2: parsedV2 != null, parsed, parsedV2 }
  })
}

/**
 * Build the complete sanitized evidence report. Pure: no I/O, no writes, no
 * policy decisions. Throws SnapshotEvidenceError on unsupported/malformed
 * snapshots; the CLI refuses to emit any evidence in that case.
 */
export function buildSnapshotEvidenceReport(inputs: SnapshotEvidenceInputs): SnapshotEvidenceReport {
  const { state, snapshotCreatedAtById, applicationCommit, generatedAt, expected } = inputs
  const plan = buildRemediationPlan(state, applicationCommit)
  const observedFingerprint = computePlanFingerprint(plan)
  const observedBaseline = computeStateHash(state)
  const planExit = classifyPlanExit(plan)

  const classified = classifyAllSnapshots(state)
  let restorableSnapshots = 0
  let quarantinedSnapshots = 0
  let defectSnapshots = 0
  for (const item of classified) {
    if (item.evidence.restorability.kind === 'restorable') restorableSnapshots++
    else if (item.evidence.restorability.kind === 'quarantined') quarantinedSnapshots++
    else defectSnapshots++
  }

  // ── Plan-level snapshot decisions grouped per snapshot ───────────────────
  const decisionsBySnapshot = new Map<string, { windowless: number; singleNegative: number; other: Record<string, number> }>()
  let windowlessDecisions = 0
  let singleMinusOneDecisions = 0
  let snapshotDecisions = 0
  let liveDecisions = 0
  for (const decision of plan.decisions) {
    if (decision.snapshotId == null) {
      liveDecisions++
      continue
    }
    snapshotDecisions++
    const category = snapshotDecisionCategory(decision.message)
    const entry = decisionsBySnapshot.get(decision.snapshotId) ?? { windowless: 0, singleNegative: 0, other: {} as Record<string, number> }
    if (category === 'windowless') {
      entry.windowless++
      windowlessDecisions++
    } else if (category === 'single-negative') {
      entry.singleNegative++
      singleMinusOneDecisions++
    } else {
      entry.other[decision.message] = (entry.other[decision.message] ?? 0) + 1
    }
    decisionsBySnapshot.set(decision.snapshotId, entry)
  }

  // ── Plan findings per snapshot (alreadyValid/quarantined/unsupported) ────
  const findingCountsBySnapshot = new Map<string, { alreadyValid: number; quarantined: number; unsupported: number }>()
  for (const finding of plan.findings) {
    if (finding.snapshotId == null || finding.category !== 'snapshot-entry') continue
    const entry = findingCountsBySnapshot.get(finding.snapshotId) ?? { alreadyValid: 0, quarantined: 0, unsupported: 0 }
    if (finding.classification === 'alreadyValid') entry.alreadyValid++
    else if (finding.classification === 'quarantined') entry.quarantined++
    else if (finding.classification === 'unsupported') entry.unsupported++
    findingCountsBySnapshot.set(finding.snapshotId, entry)
  }

  // ── S entries: raw `-1` edge decisions — the exact entries the plan
  // classifies as "single -1/negative window edge" (shared predicate via
  // classifySnapshotEntry; the observed production shape is a single `-1`
  // raw field; the other-edge state is reported as raw evidence, not
  // assumed). Evidence, not policy.
  interface SingleNegativeRecord {
    key: string
    entryKind: OwnerKindCategory
    minusOneField: MinusOneField
    windowFields: Record<MinusOneField, WindowFieldState>
    aliasConflicts: { startEdge: boolean; endEdge: boolean }
    alternateAliasState: AlternateAliasState
    rawMode: SanitizedMode
    parentMode: SanitizedMode
    effectiveMode: SanitizedMode
    modeSource: NamedModeSourceCategory
    allocationPercentCategory: PercentCategory
    allocationPctCategory: PercentCategory
    entryErrorCategories: EntryErrorCategory[]
    structuralErrorCategories: StructuralErrorCategory[]
    independentDefect: IndependentDefectCategory
  }
  const singleNegativeRecords: SingleNegativeRecord[] = []

  for (let snapshotIndex = 0; snapshotIndex < state.snapshots.length; snapshotIndex++) {
    const item = classified[snapshotIndex]!
    if (!item.v2 || !item.parsedV2) continue
    const parsed = item.parsedV2
    const rtById = new Map(parsed.resourceTypes.map(rt => [rt.id, rt]))
    const evidence = item.evidence
    // Entry evidence is in payload order: RTs then NRs.
    for (let i = 0; i < evidence.entries.length; i++) {
      const entry = evidence.entries[i]!
      if (entry.minusOneFields.length !== 1) continue
      let raw: SnapshotResourceType | SnapshotNamedResource
      let kind: 'resourceType' | 'namedResource'
      if (entry.kind === 'resourceType') {
        raw = parsed.resourceTypes[i]!
        kind = 'resourceType'
      } else {
        raw = parsed.namedResources[i - parsed.resourceTypes.length]!
        kind = 'namedResource'
      }
      // Shared plan-level predicate: the entry must be exactly the
      // "single -1/negative window edge" decision class. The plan quarantines
      // CAPACITY_PLAN entries inside quarantined snapshots that match a
      // shared quarantine shape BEFORE any decision classification; mirror
      // that precedence so the S record set equals the plan's decision set.
      if (item.evidence.restorability.kind === 'quarantined' && entry.effectiveMode === 'CAPACITY_PLAN') {
        const shape = kind === 'resourceType'
          ? {
              primaryStart: (raw as SnapshotResourceType).allocationStartWeek ?? null,
              aliasStart: null,
              primaryEnd: (raw as SnapshotResourceType).allocationEndWeek ?? null,
              aliasEnd: null,
            }
          : {
              primaryStart: (raw as SnapshotNamedResource).allocationStartWeek ?? null,
              aliasStart: (raw as SnapshotNamedResource).startWeek ?? null,
              primaryEnd: (raw as SnapshotNamedResource).allocationEndWeek ?? null,
              aliasEnd: (raw as SnapshotNamedResource).endWeek ?? null,
            }
        if (classifyV2QuarantineShape(shape) != null) continue
      }
      const finding = classifySnapshotEntry(planEntryPayload(raw, kind))
      if (finding.classification !== 'decisionRequired') continue
      if (!finding.message.includes(SINGLE_NEGATIVE_DECISION_MESSAGE)) continue

      let rawMode: SanitizedMode
      let parentMode: SanitizedMode
      let percent: number | null | undefined
      let pct: number | null | undefined
      let windowFields: Record<MinusOneField, WindowFieldState>
      let aliasConflicts: { startEdge: boolean; endEdge: boolean }
      let aliasState: AlternateAliasState
      let sanitizedForKey: Record<string, unknown>
      if (kind === 'resourceType') {
        const rt = raw as SnapshotResourceType
        rawMode = sanitizeMode(rt.allocationMode)
        parentMode = null
        percent = rt.allocationPercent
        // ResourceType entries carry no alternate aliases: every fallback
        // field is reported absent, and no edge can conflict.
        windowFields = {
          allocationStartWeek: windowFieldState(rt.allocationStartWeek),
          allocationEndWeek: windowFieldState(rt.allocationEndWeek),
          startWeek: 'absent-null',
          endWeek: 'absent-null',
        }
        aliasConflicts = { startEdge: false, endEdge: false }
        aliasState = aliasStateFrom(windowFields)
        sanitizedForKey = {
          kind: entry.kind,
          mode: rawMode,
          percent: rt.allocationPercent ?? null,
          asw: rt.allocationStartWeek ?? null,
          aew: rt.allocationEndWeek ?? null,
        }
      } else {
        const nr = raw as SnapshotNamedResource
        rawMode = sanitizeMode(nr.allocationMode)
        parentMode = sanitizeMode(rtById.get(nr.resourceTypeId ?? '')?.allocationMode)
        percent = nr.allocationPercent
        pct = nr.allocationPct
        windowFields = {
          allocationStartWeek: windowFieldState(nr.allocationStartWeek),
          allocationEndWeek: windowFieldState(nr.allocationEndWeek),
          startWeek: windowFieldState(nr.startWeek),
          endWeek: windowFieldState(nr.endWeek),
        }
        // Shared per-edge alias semantics (same definition the classifier
        // uses); window-using modes only.
        aliasConflicts = {
          startEdge: v2NamedResourceEdgeAliasConflict(nr, entry.effectiveMode, 'start'),
          endEdge: v2NamedResourceEdgeAliasConflict(nr, entry.effectiveMode, 'end'),
        }
        aliasState = aliasConflicts.startEdge || aliasConflicts.endEdge
          ? 'conflicting'
          : aliasStateFrom(windowFields)
        sanitizedForKey = {
          kind: entry.kind,
          mode: rawMode,
          percent: nr.allocationPercent ?? null,
          pct: nr.allocationPct ?? null,
          asw: nr.allocationStartWeek ?? null,
          aew: nr.allocationEndWeek ?? null,
          sw: nr.startWeek ?? null,
          ew: nr.endWeek ?? null,
        }
      }

      singleNegativeRecords.push({
        key: contentKey(sanitizedForKey),
        entryKind: entry.kind,
        minusOneField: entry.minusOneFields[0],
        windowFields,
        aliasConflicts,
        alternateAliasState: aliasState,
        rawMode,
        parentMode,
        effectiveMode: sanitizeMode(entry.effectiveMode),
        modeSource: entry.modeSource,
        allocationPercentCategory: percentCategory(percent),
        allocationPctCategory: percentCategory(pct),
        entryErrorCategories: entry.entryErrorCategories,
        structuralErrorCategories: evidence.structuralErrorCategories,
        independentDefect: evidence.structuralErrorCategories.length > 0 ? 'both' : 'entry-level',
      })
    }
  }

  // ── M records: the defect-classified snapshots ───────────────────────────
  interface DefectSnapshotRecord {
    key: string
    snapshotId: string
    subgroup: DefectSubgroup
    windowlessDecisionCount: number
    singleMinusOneDecisionCount: number
    otherDecisionRequiredCounts: Record<string, number>
    alreadyValidCount: number
    quarantinedCount: number
    unsupportedCount: number
    entryErrorCategories: Record<EntryErrorCategory, number>
    structuralErrorCategories: Record<StructuralErrorCategory, number>
    independentDefect: IndependentDefectCategory
  }
  const defectSnapshotRecords: DefectSnapshotRecord[] = []

  for (let snapshotIndex = 0; snapshotIndex < state.snapshots.length; snapshotIndex++) {
    const snapshot = state.snapshots[snapshotIndex]!
    const item = classified[snapshotIndex]!
    if (item.evidence.restorability.kind !== 'defect') continue
    const decisions = decisionsBySnapshot.get(snapshot.id)
    const windowlessCount = decisions?.windowless ?? 0
    const singleNegativeCount = decisions?.singleNegative ?? 0
    const subgroup: DefectSubgroup = singleNegativeCount > 0 ? 'seven-single-minus-one' : 'eleven-windowless-only'

    const entryErrors = emptyCounts(ENTRY_ERROR_CATEGORIES)
    const sanitizedEntries: unknown[] = []
    for (const entry of item.evidence.entries) {
      for (const category of entry.entryErrorCategories) entryErrors[category]++
      sanitizedEntries.push({
        kind: entry.kind,
        mode: sanitizeMode(entry.effectiveMode),
        source: entry.modeSource,
        errors: entry.entryErrorCategories,
      })
    }
    const structuralErrors = emptyCounts(STRUCTURAL_ERROR_CATEGORIES)
    for (const category of item.evidence.structuralErrorCategories) structuralErrors[category]++
    const findings = findingCountsBySnapshot.get(snapshot.id) ?? { alreadyValid: 0, quarantined: 0, unsupported: 0 }
    const independentDefect: IndependentDefectCategory =
      hasNonWindowlessEntryErrors(entryErrors)
        ? (item.evidence.structuralErrorCategories.length > 0 ? 'both' : 'entry-level')
        : item.evidence.structuralErrorCategories.length > 0
          ? 'structural'
          : 'unavailable'

    defectSnapshotRecords.push({
      key: contentKey(sanitizedEntries),
      snapshotId: snapshot.id,
      subgroup,
      windowlessDecisionCount: windowlessCount,
      singleMinusOneDecisionCount: singleNegativeCount,
      otherDecisionRequiredCounts: decisions?.other ?? {},
      alreadyValidCount: findings.alreadyValid,
      quarantinedCount: findings.quarantined,
      unsupportedCount: findings.unsupported,
      entryErrorCategories: entryErrors,
      structuralErrorCategories: structuralErrors,
      independentDefect,
    })
  }

  // ── Class A aggregates (574 expected; quarantined snapshots only) ────────
  const byOwnerKind: Record<OwnerKindCategory, number> = { resourceType: 0, namedResource: 0, unavailable: 0 }
  const byNamedModeSource: Record<NamedModeSourceCategory, number> = { explicit: 0, inherited: 0, other: 0, unavailable: 0 }
  const percentageByCategory: Record<'resourceType' | NamedModeSourceCategory, { allocationPercent: Record<PercentCategory, number>; allocationPct: Record<PercentCategory, number> }> = {
    resourceType: { allocationPercent: emptyCounts(PERCENT_CATEGORIES), allocationPct: emptyCounts(PERCENT_CATEGORIES) },
    explicit: { allocationPercent: emptyCounts(PERCENT_CATEGORIES), allocationPct: emptyCounts(PERCENT_CATEGORIES) },
    inherited: { allocationPercent: emptyCounts(PERCENT_CATEGORIES), allocationPct: emptyCounts(PERCENT_CATEGORIES) },
    other: { allocationPercent: emptyCounts(PERCENT_CATEGORIES), allocationPct: emptyCounts(PERCENT_CATEGORIES) },
    unavailable: { allocationPercent: emptyCounts(PERCENT_CATEGORIES), allocationPct: emptyCounts(PERCENT_CATEGORIES) },
  }
  const aliasShapes = { primaryAbsentNull: 0, fallbackAbsentNull: 0, populatedAgreeing: 0, conflicting: 0, unavailable: 0 }
  const snapshotsByOwnerKindMix = { resourceTypeOnly: 0, namedResourceOnly: 0, mixed: 0 }
  // Affected-snapshot aggregates: a snapshot counts at most once per
  // category; mixed snapshots may appear in more than one category.
  const affectedSnapshotsByOwnerKind: Record<OwnerKindCategory, number> = { resourceType: 0, namedResource: 0, unavailable: 0 }
  const affectedSnapshotsByNamedModeSource: Record<NamedModeSourceCategory, number> = { explicit: 0, inherited: 0, other: 0, unavailable: 0 }
  const entriesByEra = emptyCounts([ERA_BEFORE, ERA_MID, ERA_AFTER, ERA_UNAVAILABLE])
  const snapshotsByEra = emptyCounts([ERA_BEFORE, ERA_MID, ERA_AFTER, ERA_UNAVAILABLE])
  let classATotalEntries = 0
  let classATotalSnapshots = 0

  for (let snapshotIndex = 0; snapshotIndex < state.snapshots.length; snapshotIndex++) {
    const snapshot = state.snapshots[snapshotIndex]!
    const item = classified[snapshotIndex]!
    if (item.evidence.restorability.kind !== 'quarantined') continue
    const era = snapshotEraCategory(snapshotCreatedAtById.get(snapshot.id))
    snapshotsByEra[era]++
    let rtCount = 0
    let nrCount = 0
    const ownerKindsInSnapshot = new Set<OwnerKindCategory>()
    const modeSourcesInSnapshot = new Set<NamedModeSourceCategory>()
    for (const entry of item.evidence.entries) {
      if (entry.quarantineClass !== 'A') continue
      classATotalEntries++
      entriesByEra[era]++
      if (entry.kind === 'resourceType') {
        byOwnerKind.resourceType++
        rtCount++
        ownerKindsInSnapshot.add('resourceType')
        // ResourceType entries carry no NamedResource mode-source category;
        // affectedSnapshotsByNamedModeSource is fed only by Class A
        // NamedResource entries below.
        percentageByCategory.resourceType.allocationPercent[entry.allocationPercentCategory]++
        aliasShapes.primaryAbsentNull++
      } else {
        byOwnerKind.namedResource++
        byNamedModeSource[entry.modeSource]++
        nrCount++
        ownerKindsInSnapshot.add('namedResource')
        modeSourcesInSnapshot.add(entry.modeSource)
        percentageByCategory[entry.modeSource].allocationPercent[entry.allocationPercentCategory]++
        percentageByCategory[entry.modeSource].allocationPct[entry.allocationPctCategory]++
        // Every Class A entry has all four window fields absent by the shared
        // shape predicate; reported for completeness/drift detection.
        aliasShapes.primaryAbsentNull++
        aliasShapes.fallbackAbsentNull++
      }
    }
    if (rtCount > 0 && nrCount > 0) snapshotsByOwnerKindMix.mixed++
    else if (nrCount > 0) snapshotsByOwnerKindMix.namedResourceOnly++
    else if (rtCount > 0) snapshotsByOwnerKindMix.resourceTypeOnly++
    for (const ownerKind of ownerKindsInSnapshot) affectedSnapshotsByOwnerKind[ownerKind]++
    for (const modeSource of modeSourcesInSnapshot) affectedSnapshotsByNamedModeSource[modeSource]++
    if (rtCount + nrCount > 0) classATotalSnapshots++
  }

  // ── Reconciliation ────────────────────────────────────────────────────────
  const details: string[] = []
  const check = (label: string, observed: number, expectedValue: number): boolean => {
    const ok = observed === expectedValue
    details.push(`${label}: observed ${observed}, expected ${expectedValue} — ${ok ? 'OK' : 'MISMATCH'}`)
    return ok
  }
  const rewriteOperations = plan.operations.filter(operation => operation.kind === 'rewrite-snapshot-entry').length
  const quarantinedFindingsWithIds = plan.findings.filter(
    finding => finding.classification === 'quarantined' && (finding.decisionId != null || finding.operationId != null),
  ).length

  const elevenRecords = defectSnapshotRecords.filter(record => record.subgroup === 'eleven-windowless-only')
  const sevenRecords = defectSnapshotRecords.filter(record => record.subgroup === 'seven-single-minus-one')
  const elevenWindowless = elevenRecords.reduce((sum, record) => sum + record.windowlessDecisionCount, 0)
  const sevenWindowless = sevenRecords.reduce((sum, record) => sum + record.windowlessDecisionCount, 0)
  const sevenSingle = sevenRecords.reduce((sum, record) => sum + record.singleMinusOneDecisionCount, 0)

  const windowFieldReconciliationViolations = singleNegativeRecords.filter(record => {
    const fields = Object.keys(record.windowFields) as MinusOneField[]
    const minusOneFields = fields.filter(field => record.windowFields[field] === 'minus-one')
    if (minusOneFields.length !== 1) return true
    if (minusOneFields[0] !== record.minusOneField) return true
    return fields.some(
      field => field !== minusOneFields[0] && record.windowFields[field] !== 'absent-null' && record.windowFields[field] !== 'populated',
    )
  })

  const checks: boolean[] = [
    check('quarantined entries', plan.summary.quarantined, expected.quarantinedEntries),
    check('quarantined snapshots', quarantinedSnapshots, expected.quarantinedSnapshots),
    check('defect snapshots', defectSnapshots, expected.defectSnapshots),
    check('windowless decisions', windowlessDecisions, expected.windowlessDecisions),
    check('single -1 decisions', singleMinusOneDecisions, expected.singleMinusOneDecisions),
    check('snapshot decisions', snapshotDecisions, expected.snapshotDecisions),
    check('live decisions', liveDecisions, expected.liveDecisions),
    check('unsupported findings', plan.summary.findings.unsupported, expected.unsupported),
    check('rewrite operations', rewriteOperations, expected.rewriteOperations),
    check('topology 11 subgroup snapshots', elevenRecords.length, expected.topology11Snapshots),
    check('topology 7 subgroup snapshots', sevenRecords.length, expected.topology7Snapshots),
    check('expected subgroup snapshot sum = expected defect snapshots', expected.topology11Snapshots + expected.topology7Snapshots, expected.defectSnapshots),
    check('observed subgroup snapshots = observed defect snapshots', elevenRecords.length + sevenRecords.length, defectSnapshots),
    check('topology 11 subgroup windowless', elevenWindowless, expected.topology11WindowlessDecisions),
    check('topology 7 subgroup windowless', sevenWindowless, expected.topology7WindowlessDecisions),
    check('topology 7 subgroup single -1', sevenSingle, expected.topology7SingleMinusOneDecisions),
    check('windowless = topology 11 + topology 7', windowlessDecisions, elevenWindowless + sevenWindowless),
    check('topology 7 total = windowless + single', sevenWindowless + sevenSingle, expected.topology7WindowlessDecisions + expected.topology7SingleMinusOneDecisions),
    check('snapshot decisions = windowless + single', snapshotDecisions, windowlessDecisions + singleMinusOneDecisions),
    check('quarantined findings carry no decision/op ids', quarantinedFindingsWithIds, 0),
    check('single-negative records', singleNegativeRecords.length, expected.singleMinusOneDecisions),
    check('S records window-field reconciliation', windowFieldReconciliationViolations.length, 0),
    check('class A entries reconcile', classATotalEntries, expected.quarantinedEntries),
    check('class A snapshots reconcile', classATotalSnapshots, expected.quarantinedSnapshots),
  ]
  const countsMatch = checks.every(ok => ok)
  const fingerprintMatch = observedFingerprint === expected.fingerprint
  const baselineMatch = observedBaseline === expected.baselineStateHash
  const reconciliationPassed = countsMatch && fingerprintMatch && baselineMatch

  // ── Deterministic labels (content-derived, never raw IDs) ────────────────
  const sortedS = [...singleNegativeRecords].sort((a, b) => a.key.localeCompare(b.key))
  const sortedM = [...defectSnapshotRecords].sort((a, b) => a.key.localeCompare(b.key))

  return {
    formatVersion: SNAPSHOT_EVIDENCE_FORMAT_VERSION,
    runMetadata: { generatedAt, applicationCommit },
    expectedBoundary: expected,
    observedBoundary: {
      fingerprint: observedFingerprint,
      baselineStateHash: observedBaseline,
      planExit,
      summary: {
        findings: { ...plan.summary.findings },
        operations: plan.summary.operations,
        decisionsRequired: plan.summary.decisionsRequired,
        quarantined: plan.summary.quarantined,
        rewriteOperations,
      },
      snapshotPopulation: {
        totalSnapshots: state.snapshots.length,
        restorable: restorableSnapshots,
        quarantined: quarantinedSnapshots,
        defect: defectSnapshots,
      },
    },
    integrityResult: {
      fingerprintMatch,
      baselineMatch,
      countsMatch,
      reconciliationPassed,
    },
    topology: {
      quarantinedSnapshots,
      defectSnapshots,
      windowlessDecisions,
      singleMinusOneDecisions,
      snapshotDecisions,
      liveDecisions,
      elevenSnapshotSubgroup: {
        snapshots: elevenRecords.length,
        windowlessDecisions: elevenWindowless,
      },
      sevenSnapshotSubgroup: {
        snapshots: sevenRecords.length,
        windowlessDecisions: sevenWindowless,
        singleMinusOneDecisions: sevenSingle,
        totalDecisions: sevenWindowless + sevenSingle,
      },
      quarantinedFindingsWithDecisionOrOperationIds: quarantinedFindingsWithIds,
    },
    singleNegativeEntries: sortedS.map((record, index) => {
      const { key: _key, ...rest } = record
      return { ...rest, label: `S${index + 1}` }
    }),
    defectSnapshots: sortedM.map((record, index) => {
      const { key: _key, snapshotId: _snapshotId, ...rest } = record
      return { ...rest, label: `M${index + 1}` }
    }),
    classAAggregates: {
      totalEntries: classATotalEntries,
      totalSnapshots: classATotalSnapshots,
      byOwnerKind,
      byNamedModeSource,
      percentageByCategory,
      aliasShapes,
      snapshotsByOwnerKindMix,
      affectedSnapshotsByOwnerKind,
      affectedSnapshotsByNamedModeSource,
      entriesByEra,
      snapshotsByEra,
    },
    unavailableEvidence: {
      singleEntriesModeSourceUnavailable: sortedS.filter(record => record.modeSource === 'unavailable').length,
      defectSnapshotsIndependentDefectUnavailable: sortedM.filter(record => record.independentDefect === 'unavailable').length,
      classAEntriesEraUnavailable: entriesByEra[ERA_UNAVAILABLE],
      classASnapshotsEraUnavailable: snapshotsByEra[ERA_UNAVAILABLE],
    },
    reconciliation: { passed: reconciliationPassed, details },
    policyDecision: 'not-assessed',
  }
}

// ─── Small raw-field evidence helpers (no ids, no names) ────────────────────

function windowFieldState(value: number | null | undefined): WindowFieldState {
  if (value === -1) return 'minus-one'
  if (value == null) return 'absent-null'
  return 'populated'
}

/** Aggregate alias state from the per-field states (conflict handled
 * separately by the per-edge predicate). The minus-one field itself is never
 * reported as populated: only genuinely populated other fields count. */
function aliasStateFrom(windowFields: Record<MinusOneField, WindowFieldState>): AlternateAliasState {
  const states = Object.values(windowFields)
  if (states.some(state => state === 'populated')) return 'populated'
  return 'all-absent-null'
}

function summarizeWindowFields(windowFields: Record<MinusOneField, WindowFieldState>): string {
  return (Object.keys(windowFields) as MinusOneField[])
    .map(field => `${field}:${windowFields[field]}`)
    .join(' ')
}

function hasNonWindowlessEntryErrors(entryErrors: Record<EntryErrorCategory, number>): boolean {
  return ENTRY_ERROR_CATEGORIES.some(
    category => category !== 'windowless-capacity-plan' && entryErrors[category] > 0,
  )
}

function contentKey(payload: unknown): string {
  return sha256Hex(canonicalJson(payload))
}

function summarizeCounts(counts: Record<string, number>): string {
  const parts = Object.entries(counts)
    .filter(([, count]) => count > 0)
    .map(([category, count]) => `${category}:${count}`)
  return parts.length > 0 ? parts.join(', ') : 'none'
}

// ─── Markdown rendering (from the same evidence object — JSON and Markdown
// ─── cannot diverge) ────────────────────────────────────────────────────────

/** Render the sanitized evidence report as human-readable Markdown. All data
 * comes from the report object; no identifiers are introduced here. */
export function renderSnapshotEvidenceMarkdown(report: SnapshotEvidenceReport): string {
  const lines: string[] = []
  lines.push('# Sanitized Historical Snapshot Evidence')
  lines.push('')
  lines.push(`- formatVersion: ${report.formatVersion}`)
  lines.push(`- generatedAt: ${report.runMetadata.generatedAt}`)
  lines.push(`- applicationCommit: ${report.runMetadata.applicationCommit}`)
  lines.push(`- policyDecision: ${report.policyDecision} (this command assesses no policy)`)
  lines.push('')
  lines.push('## Integrity')
  lines.push('')
  lines.push(`- fingerprintMatch: ${report.integrityResult.fingerprintMatch}`)
  lines.push(`- baselineMatch: ${report.integrityResult.baselineMatch}`)
  lines.push(`- countsMatch: ${report.integrityResult.countsMatch}`)
  lines.push(`- reconciliationPassed: ${report.integrityResult.reconciliationPassed}`)
  lines.push('')
  lines.push('## Observed boundary')
  lines.push('')
  lines.push(`- fingerprint: ${report.observedBoundary.fingerprint}`)
  lines.push(`- baselineStateHash: ${report.observedBoundary.baselineStateHash}`)
  lines.push(`- planExit: ${report.observedBoundary.planExit}`)
  lines.push(`- findings: ${JSON.stringify(report.observedBoundary.summary.findings)}`)
  lines.push(`- operations: ${report.observedBoundary.summary.operations} (rewrite: ${report.observedBoundary.summary.rewriteOperations})`)
  lines.push(`- decisionsRequired: ${report.observedBoundary.summary.decisionsRequired}`)
  lines.push(`- quarantined: ${report.observedBoundary.summary.quarantined}`)
  lines.push(`- snapshotPopulation: total ${report.observedBoundary.snapshotPopulation.totalSnapshots}, restorable ${report.observedBoundary.snapshotPopulation.restorable}, quarantined ${report.observedBoundary.snapshotPopulation.quarantined}, defect ${report.observedBoundary.snapshotPopulation.defect}`)
  lines.push('')
  lines.push('## Topology')
  lines.push('')
  lines.push(`- quarantinedSnapshots: ${report.topology.quarantinedSnapshots}`)
  lines.push(`- defectSnapshots: ${report.topology.defectSnapshots}`)
  lines.push(`- windowlessDecisions: ${report.topology.windowlessDecisions}`)
  lines.push(`- singleMinusOneDecisions: ${report.topology.singleMinusOneDecisions}`)
  lines.push(`- snapshotDecisions: ${report.topology.snapshotDecisions}`)
  lines.push(`- liveDecisions: ${report.topology.liveDecisions}`)
  lines.push(`- 11-snapshot subgroup: ${report.topology.elevenSnapshotSubgroup.snapshots} snapshots, ${report.topology.elevenSnapshotSubgroup.windowlessDecisions} windowless decisions`)
  lines.push(`- 7-snapshot subgroup: ${report.topology.sevenSnapshotSubgroup.snapshots} snapshots, ${report.topology.sevenSnapshotSubgroup.windowlessDecisions} windowless + ${report.topology.sevenSnapshotSubgroup.singleMinusOneDecisions} single-(-1) = ${report.topology.sevenSnapshotSubgroup.totalDecisions} total decisions`)
  lines.push(`- quarantined findings with decision/op ids: ${report.topology.quarantinedFindingsWithDecisionOrOperationIds}`)
  lines.push('')
  if (report.singleNegativeEntries.length > 0) {
    // S records are selected from the plan's single-negative decision class
    // (shared classifySnapshotEntry predicate). A clean `-1` + null shape may
    // instead be classified through the windowless branch, so the heading
    // names the decision class, not an assumed raw shape.
    lines.push('## Single-negative decision entries')
    lines.push('')
    lines.push('Each row reports the sanitized state of every raw window field (allocationStartWeek/allocationEndWeek/startWeek/endWeek) and per-edge conflicting-populated-alias evidence (shared predicate; window-using modes only).')
    lines.push('')
    lines.push('| Label | Kind | -1 field | Window fields (allocationStartWeek, allocationEndWeek, startWeek, endWeek) | Start edge conflict | End edge conflict | Alternate aliases | Raw mode | Parent mode | Effective mode | Mode source | allocationPercent | allocationPct | Entry errors | Structural errors | Independent defect |')
    lines.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|')
    for (const entry of report.singleNegativeEntries) {
      lines.push([
        entry.label, entry.entryKind, entry.minusOneField,
        summarizeWindowFields(entry.windowFields),
        entry.aliasConflicts.startEdge ? 'yes' : 'no',
        entry.aliasConflicts.endEdge ? 'yes' : 'no',
        entry.alternateAliasState,
        entry.rawMode ?? 'null', entry.parentMode ?? 'null', entry.effectiveMode ?? 'null', entry.modeSource,
        entry.allocationPercentCategory, entry.allocationPctCategory,
        entry.entryErrorCategories.join(','), entry.structuralErrorCategories.join(','),
        entry.independentDefect,
      ].join(' | '))
    }
    lines.push('')
  }
  if (report.defectSnapshots.length > 0) {
    lines.push('## Defect-classified snapshots')
    lines.push('')
    lines.push('| Label | Subgroup | Windowless decisions | Single -1 decisions | Other decision reasons | Already valid | Quarantined | Unsupported | Entry error categories | Structural categories | Independent defect |')
    lines.push('|---|---|---|---|---|---|---|---|---|---|---|')
    for (const snapshot of report.defectSnapshots) {
      lines.push([
        snapshot.label, snapshot.subgroup, snapshot.windowlessDecisionCount, snapshot.singleMinusOneDecisionCount,
        summarizeCounts(snapshot.otherDecisionRequiredCounts),
        snapshot.alreadyValidCount, snapshot.quarantinedCount, snapshot.unsupportedCount,
        summarizeCounts(snapshot.entryErrorCategories), summarizeCounts(snapshot.structuralErrorCategories),
        snapshot.independentDefect,
      ].join(' | '))
    }
    lines.push('')
  }
  lines.push('## Class A aggregates')
  lines.push('')
  lines.push(`- totalEntries: ${report.classAAggregates.totalEntries}`)
  lines.push(`- totalSnapshots: ${report.classAAggregates.totalSnapshots}`)
  lines.push(`- byOwnerKind: ${JSON.stringify(report.classAAggregates.byOwnerKind)}`)
  lines.push(`- byNamedModeSource: ${JSON.stringify(report.classAAggregates.byNamedModeSource)}`)
  lines.push(`- aliasShapes: ${JSON.stringify(report.classAAggregates.aliasShapes)}`)
  lines.push(`- snapshotsByOwnerKindMix: ${JSON.stringify(report.classAAggregates.snapshotsByOwnerKindMix)}`)
  lines.push(`- affectedSnapshotsByOwnerKind: ${JSON.stringify(report.classAAggregates.affectedSnapshotsByOwnerKind)} (a snapshot counts at most once per category; mixed snapshots may appear in both)`)
  lines.push(`- affectedSnapshotsByNamedModeSource: ${JSON.stringify(report.classAAggregates.affectedSnapshotsByNamedModeSource)} (a snapshot containing explicit and inherited entries counts in both)`)
  lines.push(`- entriesByEra: ${JSON.stringify(report.classAAggregates.entriesByEra)} (timestamp is not proof of the exact historical writer)`)
  lines.push(`- snapshotsByEra: ${JSON.stringify(report.classAAggregates.snapshotsByEra)}`)
  lines.push('')
  lines.push('### Class A percentage evidence (by owner kind / mode source)')
  lines.push('')
  lines.push('| Category | allocationPercent buckets | allocationPct buckets |')
  lines.push('|---|---|---|')
  for (const category of ['resourceType', 'explicit', 'inherited', 'other', 'unavailable'] as const) {
    const byCategory = report.classAAggregates.percentageByCategory[category]
    if (!byCategory) continue
    lines.push([
      category,
      summarizeCounts(byCategory.allocationPercent),
      summarizeCounts(byCategory.allocationPct),
    ].join(' | '))
  }
  lines.push('')
  lines.push('## Reconciliation')
  lines.push('')
  lines.push(`- passed: ${report.reconciliation.passed}`)
  for (const detail of report.reconciliation.details) lines.push(`- ${detail}`)
  lines.push('')
  lines.push('## Unavailable evidence')
  lines.push('')
  lines.push(`- ${JSON.stringify(report.unavailableEvidence)}`)
  lines.push('')
  lines.push('This report is evidence only. It does not authorize remediation, migration, manifest creation or decision selection.')
  return `${lines.join('\n')}\n`
}
