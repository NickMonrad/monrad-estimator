/**
 * productionRemediationPlan.ts — Issue #421: pure read-only remediation
 * planning for production capacity-profile readiness blockers.
 *
 * This module builds the reviewed remediation plan that #404 executes BEFORE
 * the destructive legacy-column migration (#418 PR 2). It is deliberately
 * pure where possible (no Prisma calls inside the planner itself) so the
 * full classification matrix, fingerprint contract and manifest merge are
 * unit-testable without a database.
 *
 * Guarantees:
 *  - NEVER runs during application startup or from an HTTP request.
 *  - Planning performs NO writes; the CLI wraps it in dry-run mode.
 *  - Every operation carries an `evidenceHash` over the exact current-state
 *    evidence used to derive it; apply refuses when re-read state differs.
 *  - Ambiguous owners are never guessed: they become decision entries that
 *    require an explicit reviewed manifest resolution before apply.
 *  - Candidate ResourceType/NamedResource columns are only READ here, never
 *    written, and the permanent readiness command is never weakened.
 *
 * Exit contract (shared by the CLI):
 *   0 — plan is valid and has no unresolved decisions;
 *   1 — operational, structural or drift failure;
 *   2 — plan is valid but explicit decisions remain unresolved.
 */

import { createHash } from 'node:crypto'
import type { PrismaClient } from '@prisma/client'

import {
  mapResourceTypeToCapacityProfile,
  mapNamedResourceToCapacityProfile,
  type CapacityProfileResourceTypeLike,
  type CapacityProfileNamedResourceLike,
  type CapacityProfileDTO,
} from './capacityProfileMapping.js'
import { buildRoleProfileData } from './squadPlannerProfileWriter.js'
import { isNeverActiveWindow } from './projectSnapshotCapacity.js'
import {
  validateProfileStructure,
  type ProfileStructureInput,
  type ProfileStructureSegment,
} from './capacityProfileStructureValidation.js'
import {
  isLegacyV1Snapshot,
  isSnapshotV2,
  isSnapshotV3,
  isSnapshotV4,
  parseSnapshotData,
  type SnapshotV2,
} from './projectSnapshotTypes.js'
import { validateSnapshotV3 } from './projectSnapshotValidation.js'

function round2(value: number): number {
  return Math.round(value * 100) / 100
}

// ─── Format versions ─────────────────────────────────────────────────────────

export const REMEDIATION_PLAN_FORMAT_VERSION = 1
export const REMEDIATION_MANIFEST_FORMAT_VERSION = 1

// ─── Classifications ─────────────────────────────────────────────────────────

export type FindingClassification =
  | 'deterministic'
  | 'decisionRequired'
  | 'unsupported'
  | 'alreadyValid'

export type OperationKind =
  | 'create-role-profile'
  | 'create-named-profile'
  | 'update-profile'
  | 'rewrite-snapshot-entry'

// ─── Current-state evidence types ────────────────────────────────────────────

export interface RemediationNamedResource {
  id: string
  name: string
  allocationMode: string | null
  allocationPercent: number | null
  allocationPct: number | null
  allocationStartWeek: number | null
  allocationEndWeek: number | null
  startWeek: number | null
  endWeek: number | null
}

export interface RemediationResourceType {
  id: string
  name: string
  count: number
  allocationMode: string | null
  allocationPercent: number | null
  allocationStartWeek: number | null
  allocationEndWeek: number | null
  namedResources: RemediationNamedResource[]
}

export interface RemediationSegment {
  id: string
  startWeek: number
  endWeek: number
  capacityPercent: number
  source: string
}

export interface RemediationProfile {
  id: string
  projectId: string
  resourceTypeId: string | null
  namedResourceId: string | null
  ownerKind: string
  planningBasis: string
  source: string
  defaultPercent: number | null
  startWeek: number | null
  endWeek: number | null
  legacy: unknown
  segments: RemediationSegment[]
}

export interface RemediationPlanPeriod {
  periodIndex: number
  startWeek: number
  endWeek: number
  entries: Array<{ resourceTypeId: string; headcount: number }>
}

export interface RemediationProject {
  id: string
  name: string
  resourceTypes: RemediationResourceType[]
  capacityProfiles: RemediationProfile[]
  /** Periods of the active CapacityPlan (ordered by periodIndex); [] when none. */
  activePlanPeriods: RemediationPlanPeriod[]
}

export interface RemediationSnapshot {
  id: string
  projectId: string
  snapshot: unknown
}

export interface RemediationDatabaseState {
  projects: RemediationProject[]
  snapshots: RemediationSnapshot[]
}

// ─── Proposed writes ─────────────────────────────────────────────────────────

export interface ProposedSegment {
  id: string
  startWeek: number
  endWeek: number
  capacityPercent: number
  source: string
}

export interface ProposedProfile {
  /** Existing profile id for updates, deterministic new id for creates. */
  profileId: string
  ownerKind: 'ROLE' | 'NAMED_PERSON' | 'PLANNED_RESOURCE'
  planningBasis: 'DEMAND_FOLLOWING' | 'AVAILABILITY_WINDOW' | 'WHOLE_PROJECT_ALLOCATION' | 'CAPACITY_PROFILE'
  source: 'FIXED' | 'AVAILABILITY_WINDOW' | 'LEGACY' | 'SQUAD_PLANNER'
  defaultPercent: number | null
  startWeek: number | null
  endWeek: number | null
  /**
   * Mapper-shaped legacy JSON written on create; `null`/undefined for update
   * operations, whose existing legacy payload is preserved untouched.
   */
  legacy?: Record<string, unknown> | null
  segments: ProposedSegment[]
}

export interface ProposedSnapshotRewrite {
  snapshotId: string
  entryType: 'resourceType' | 'namedResource'
  entryId: string
  /** Approved captured window written to allocationStartWeek/allocationEndWeek. */
  startWeek: number
  endWeek: number
}

export interface RemediationOperation {
  /** Stable id within the plan: `op-0001`. */
  id: string
  kind: OperationKind
  classification: 'deterministic' | 'decisionResolved'
  projectId: string
  ownerId: string
  ownerName: string
  /** Exact current-state evidence hash (canonical JSON, SHA-256). */
  evidenceHash: string
  proposed: ProposedProfile | ProposedSnapshotRewrite
  /** Set when the operation comes from an explicit manifest decision. */
  decisionId?: string
}

export interface RemediationFinding {
  id: string
  category: 'live-owner' | 'persisted-profile' | 'snapshot-entry' | 'snapshot'
  projectId: string
  ownerId: string | null
  ownerName: string | null
  profileId: string | null
  snapshotId: string | null
  entryId: string | null
  classification: FindingClassification
  message: string
  evidenceHash: string
  operationId: string | null
  decisionId: string | null
}

export interface PlanDecisionEntry {
  id: string
  projectId: string
  ownerId: string
  ownerKind: 'role' | 'namedPerson'
  profileId: string | null
  snapshotId: string | null
  entryId: string | null
  /** Mapper-shaped legacy base used to build the resolved profile. */
  legacyBase: Record<string, unknown> | null
  evidenceHash: string
  allowedResolutions: string[]
  message: string
}

export interface RemediationPlanSummary {
  findings: Record<FindingClassification, number>
  operations: number
  decisionsRequired: number
}

export interface RemediationPlan {
  formatVersion: typeof REMEDIATION_PLAN_FORMAT_VERSION
  generatedAt: string
  /** Informational: the git commit the plan was generated on (never enforced). */
  applicationCommit: string
  /** SHA-256 over the canonical actionable content (stable across reruns). */
  fingerprint: string
  summary: RemediationPlanSummary
  findings: RemediationFinding[]
  operations: RemediationOperation[]
  decisions: PlanDecisionEntry[]
}

// ─── Manifest (explicit reviewed decisions) ─────────────────────────────────

export type ManifestCapacityResolution =
  | {
      shape: 'scalar-profile'
      planningBasis: 'DEMAND_FOLLOWING' | 'WHOLE_PROJECT_ALLOCATION'
      defaultPercent: number | null
    }
  | {
      shape: 'availability-window'
      defaultPercent: number | null
      startWeek: number | null
      endWeek: number | null
    }
  | {
      shape: 'segmented-capacity-profile'
      defaultPercent: number | null
      segments: Array<{ startWeek: number; endWeek: number; capacityPercent: number }>
    }

export type ManifestResolution =
  | ManifestCapacityResolution
  | {
      shape: 'owner-kind-decision'
      ownerKind: 'NAMED_PERSON' | 'PLANNED_RESOURCE'
      capacity: ManifestCapacityResolution
    }
  | {
      shape: 'snapshot-window-interpretation'
      startWeek: number
      endWeek: number
    }

export interface ManifestDecision {
  decisionId: string
  projectId: string
  ownerId: string
  snapshotId: string | null
  resolution: ManifestResolution
  rationale?: string
}

export interface RemediationManifest {
  formatVersion: typeof REMEDIATION_MANIFEST_FORMAT_VERSION
  applicationCommit: string
  /** Must equal the referenced plan's fingerprint. */
  planFingerprint: string
  decisions: ManifestDecision[]
}

// ─── Canonical serialisation + fingerprint ──────────────────────────────────

/**
 * Deterministic JSON serialisation: object keys sorted recursively, arrays in
 * order. Used for evidence hashes and the plan fingerprint so identical state
 * always yields identical hashes.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) {
    return `[${value.map(v => canonicalJson(v)).join(',')}]`
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>
    const keys = Object.keys(obj).sort()
    const body = keys.map(key => `${JSON.stringify(key)}:${canonicalJson(obj[key])}`).join(',')
    return `{${body}}`
  }
  return JSON.stringify(value)
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

export function evidenceHash(evidence: Record<string, unknown>): string {
  return sha256Hex(canonicalJson(evidence))
}

/** Stable per-plan fingerprint over the actionable content (never timestamps). */
export function computePlanFingerprint(plan: {
  formatVersion: number
  summary: RemediationPlanSummary
  findings: RemediationFinding[]
  operations: RemediationOperation[]
  decisions: PlanDecisionEntry[]
}): string {
  return sha256Hex(canonicalJson({
    formatVersion: plan.formatVersion,
    summary: plan.summary,
    findings: plan.findings,
    operations: plan.operations,
    decisions: plan.decisions,
  }))
}

// ─── Small domain helpers ───────────────────────────────────────────────────

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isNonNegativeInteger(value: unknown): value is number {
  return isFiniteNumber(value) && Number.isInteger(value) && value >= 0
}

function enumToUpper(value: string): string {
  return value.replace(/[a-z][A-Z]/g, m => `${m[0]}_${m[1]}`).toUpperCase()
}

/** Deterministic new profile id for created profiles (traceable, collision-safe). */
export function remediationProfileId(ownerKind: 'role' | 'namedPerson', ownerId: string): string {
  return `remediation-${ownerKind === 'role' ? 'role' : 'named'}-${ownerId}`
}

function remediationSegmentId(profileId: string, index: number): string {
  return `${profileId}-seg-${String(index + 1).padStart(3, '0')}`
}

// ─── Live-state derivation (deterministic matrix) ───────────────────────────

export interface DerivedOwnerState {
  classification: FindingClassification
  proposed?: ProposedProfile
  message: string
}

function mapperDtoToProposed(
  dto: CapacityProfileDTO,
  ownerKind: 'ROLE' | 'NAMED_PERSON',
  profileId: string,
  overrides?: Partial<ProposedProfile>,
): ProposedProfile {
  return {
    profileId,
    ownerKind,
    planningBasis: enumToUpper(dto.planningBasis) as ProposedProfile['planningBasis'],
    source: enumToUpper(dto.source) as ProposedProfile['source'],
    defaultPercent: dto.defaultPercent ?? null,
    startWeek: dto.startWeek ?? null,
    endWeek: dto.endWeek ?? null,
    legacy: dto.legacy as unknown as Record<string, unknown>,
    segments: [],
    ...overrides,
  }
}

/**
 * Deterministic ROLE profile derivation for a resource type that has no
 * persisted profiles and no named resources (or is planner-owned).
 *
 * Mapping (reuses the approved mapper semantics, issue #421):
 *   TIMELINE    → AVAILABILITY_WINDOW / AVAILABILITY_WINDOW, window preserved
 *   EFFORT/null → DEMAND_FOLLOWING / FIXED
 *   FULL_PROJECT→ WHOLE_PROJECT_ALLOCATION / FIXED
 *   CAPACITY_PLAN with valid persisted active-plan entries
 *               → CAPACITY_PROFILE / SQUAD_PLANNER via buildRoleProfileData
 *                 (the current Squad Planner ROLE writer — aggregate weekly
 *                 headcount segments, provenance preserved)
 *   CAPACITY_PLAN without plan evidence → decisionRequired (never guessed)
 */
export function deriveRoleProfileFromLegacy(
  rt: RemediationResourceType,
  activePlanPeriods: RemediationPlanPeriod[],
): DerivedOwnerState {
  const mode = rt.allocationMode ?? null

  if (mode === 'CAPACITY_PLAN') {
    const rtPeriods = activePlanPeriods.map(period => ({
      periodIndex: period.periodIndex,
      startWeek: period.startWeek,
      endWeek: period.endWeek,
      entries: period.entries.filter(entry => entry.resourceTypeId === rt.id),
    })).filter(period => period.entries.length > 0)
    const hasPlanEntries = rtPeriods.some(period => period.entries.some(entry => entry.headcount > 0))

    if (hasPlanEntries) {
      const roleData = buildRoleProfileData(rt.id, rtPeriods)
      const profileId = remediationProfileId('role', rt.id)
      const segments: ProposedSegment[] = roleData.segments.map((segment, index) => ({
        id: remediationSegmentId(profileId, index),
        startWeek: segment.startWeek,
        endWeek: segment.endWeek,
        capacityPercent: segment.capacityPercent,
        source: 'SQUAD_PLANNER',
      }))
      return {
        classification: 'deterministic',
        message: 'planner-owned role: ROLE profile reconstructed from valid persisted CapacityPlan entries',
        proposed: {
          profileId,
          ownerKind: 'ROLE',
          planningBasis: 'CAPACITY_PROFILE',
          source: 'SQUAD_PLANNER',
          defaultPercent: roleData.defaultPercent,
          startWeek: roleData.startWeek,
          endWeek: roleData.endWeek,
          legacy: {
            allocationMode: 'CAPACITY_PLAN',
            allocationPercent: rt.allocationPercent,
            allocationStartWeek: rt.allocationStartWeek,
            allocationEndWeek: rt.allocationEndWeek,
          },
          segments,
        },
      }
    }

    return {
      classification: 'decisionRequired',
      message: 'CAPACITY_PLAN without usable window or plan evidence — owner intent required',
    }
  }

  const dto = mapResourceTypeToCapacityProfile({
    projectId: 'placeholder',
    resourceType: rt as unknown as CapacityProfileResourceTypeLike,
  })
  // EFFORT / FULL_PROJECT / null never used window aliases (same stale-alias
  // policy as the v2 snapshot translation) — discard them so the proposed
  // DEMAND_FOLLOWING / WHOLE_PROJECT_ALLOCATION profile is structurally valid.
  const modeDiscardsWindows = mode === 'EFFORT' || mode == null || mode === 'FULL_PROJECT'
  const profileId = remediationProfileId('role', rt.id)
  const overrides: Partial<ProposedProfile> = {
    startWeek: modeDiscardsWindows ? null : (dto.startWeek ?? null),
    endWeek: modeDiscardsWindows ? null : (dto.endWeek ?? null),
  }
  if (mode == null) {
    // The v2 snapshot policy maps a missing mode to DEMAND_FOLLOWING/FIXED
    // (same as EFFORT); the mapper alone labels it LEGACY.
    overrides.source = 'FIXED'
  }
  return {
    classification: 'deterministic',
    message: `missing ROLE profile derived from unambiguous legacy mode ${JSON.stringify(mode)}`,
    proposed: mapperDtoToProposed(dto, 'ROLE', profileId, overrides),
  }
}

/**
 * Deterministic NAMED_PERSON profile derivation for a named resource with no
 * persisted profile. Mode is the named resource's OWN allocationMode (the
 * legacy scheduler never inherited the parent role's mode).
 *
 *   TIMELINE     → AVAILABILITY_WINDOW / AVAILABILITY_WINDOW, window preserved
 *   FULL_PROJECT → WHOLE_PROJECT_ALLOCATION / FIXED
 *   EFFORT/null  → DEMAND_FOLLOWING / FIXED (windows discarded — the same
 *                  stale-alias policy the v2 snapshot translation applies)
 *   CAPACITY_PLAN with captured window
 *                → AVAILABILITY_WINDOW / LEGACY (same policy as v2 translation)
 *   CAPACITY_PLAN without captured window → decisionRequired
 *   never-active (-1,-1 or inverted) window → zero-capacity profile (policy)
 */
export function deriveNamedProfileFromLegacy(
  nr: RemediationNamedResource,
): DerivedOwnerState {
  const mode = nr.allocationMode ?? null
  const effectiveStart = nr.allocationStartWeek ?? nr.startWeek
  const effectiveEnd = nr.allocationEndWeek ?? nr.endWeek
  const modeUsesWindows = mode === 'TIMELINE' || mode === 'CAPACITY_PLAN'
  const neverActive = modeUsesWindows && isNeverActiveWindow(effectiveStart, effectiveEnd)

  if (mode === 'CAPACITY_PLAN' && !neverActive) {
    if (effectiveStart == null || effectiveEnd == null) {
      return {
        classification: 'decisionRequired',
        message: 'CAPACITY_PLAN without a usable window — owner intent required',
      }
    }
    if (!isNonNegativeInteger(effectiveStart) || !isNonNegativeInteger(effectiveEnd)) {
      return {
        classification: 'decisionRequired',
        message: 'single -1 or negative window edge without established meaning — owner intent required',
      }
    }
    const profileId = remediationProfileId('namedPerson', nr.id)
    return {
      classification: 'deterministic',
      message: 'CAPACITY_PLAN with captured window maps to AVAILABILITY_WINDOW/LEGACY (v2 policy)',
      proposed: {
        profileId,
        ownerKind: 'NAMED_PERSON',
        planningBasis: 'AVAILABILITY_WINDOW',
        source: 'LEGACY',
        defaultPercent: nr.allocationPercent ?? nr.allocationPct ?? 100,
        startWeek: effectiveStart,
        endWeek: effectiveEnd,
        legacy: {
          allocationMode: mode,
          allocationPercent: nr.allocationPercent,
          allocationPct: nr.allocationPct,
          allocationStartWeek: nr.allocationStartWeek,
          allocationEndWeek: nr.allocationEndWeek,
          startWeek: nr.startWeek,
          endWeek: nr.endWeek,
        },
        segments: [],
      },
    }
  }

  if (neverActive) {
    // Issue #421 never-active policy: the captured window never contributed
    // capacity; the faithful profile is zero-capacity with a null window.
    const profileId = remediationProfileId('namedPerson', nr.id)
    return {
      classification: 'deterministic',
      message: 'never-active window (never contributed capacity) → zero-capacity profile',
      proposed: {
        profileId,
        ownerKind: 'NAMED_PERSON',
        planningBasis: 'AVAILABILITY_WINDOW',
        source: mode === 'CAPACITY_PLAN' ? 'LEGACY' : 'AVAILABILITY_WINDOW',
        defaultPercent: 0,
        startWeek: null,
        endWeek: null,
        legacy: {
          allocationMode: mode,
          allocationPercent: nr.allocationPercent,
          allocationPct: nr.allocationPct,
          allocationStartWeek: nr.allocationStartWeek,
          allocationEndWeek: nr.allocationEndWeek,
          startWeek: nr.startWeek,
          endWeek: nr.endWeek,
        },
        segments: [],
      },
    }
  }

  const dto = mapNamedResourceToCapacityProfile({
    projectId: 'placeholder',
    resourceType: { id: '', name: '', count: 1 } as unknown as CapacityProfileResourceTypeLike,
    namedResource: nr as unknown as CapacityProfileNamedResourceLike,
  })
  const profileId = remediationProfileId('namedPerson', nr.id)
  const modeDiscardsWindows = mode === 'EFFORT' || mode == null || mode === 'FULL_PROJECT'
  return {
    classification: 'deterministic',
    message: `missing NAMED_PERSON profile derived from unambiguous legacy mode ${JSON.stringify(mode)}`,
    proposed: mapperDtoToProposed(dto, 'NAMED_PERSON', profileId, {
      defaultPercent: nr.allocationPercent ?? nr.allocationPct ?? 100,
      startWeek: modeDiscardsWindows ? null : (effectiveStart ?? null),
      endWeek: modeDiscardsWindows ? null : (effectiveEnd ?? null),
    }),
  }
}

// ─── Overlap decomposition (deterministic correction) ───────────────────────

/**
 * Decompose overlapping segments into the exact non-overlapping representation
 * that preserves the per-week effective capacity (the sum of every segment
 * covering that week). Only captured capacity values are used — nothing is
 * invented. Existing segment IDs are preserved where the interval count
 * allows; surplus intervals receive deterministic new IDs.
 */
export function decomposeOverlappingSegments(
  profileId: string,
  segments: ReadonlyArray<ProfileStructureSegment>,
): ProposedSegment[] | null {
  if (segments.length === 0) return []

  const boundaries = new Set<number>()
  for (const segment of segments) {
    boundaries.add(segment.startWeek)
    boundaries.add(segment.endWeek + 1)
  }
  const sortedBoundaries = [...boundaries].sort((a, b) => a - b)

  const intervals: Array<{ startWeek: number; endWeek: number; capacityPercent: number; source: string }> = []
  for (let i = 0; i < sortedBoundaries.length - 1; i++) {
    const startWeek = sortedBoundaries[i]
    const endWeek = sortedBoundaries[i + 1] - 1
    if (endWeek < startWeek) continue
    let total = 0
    let covered = false
    let coveringSource = 'LEGACY'
    for (const segment of segments) {
      if (segment.startWeek <= startWeek && segment.endWeek >= endWeek) {
        covered = true
        total += segment.capacityPercent
        coveringSource = segment.source
      }
    }
    if (!covered) continue
    intervals.push({ startWeek, endWeek, capacityPercent: round2(total), source: coveringSource })
  }
  if (intervals.length === 0) return null

  const orderedOriginals = [...segments].sort(
    (a, b) => a.startWeek - b.startWeek || a.endWeek - b.endWeek || a.id.localeCompare(b.id),
  )
  return intervals.map((interval, index) => ({
    id: orderedOriginals[index]?.id ?? remediationSegmentId(profileId, index),
    startWeek: interval.startWeek,
    endWeek: interval.endWeek,
    capacityPercent: interval.capacityPercent,
    // Mapped originals keep their own provenance; surplus intervals inherit
    // the provenance of the first segment covering them.
    source: orderedOriginals[index]?.source ?? interval.source,
  }))
}

function segmentsOverlap(segments: ReadonlyArray<ProfileStructureSegment>): boolean {
  const sorted = [...segments].sort((a, b) => a.startWeek - b.startWeek || a.endWeek - b.endWeek)
  let priorEnd = -1
  for (const segment of sorted) {
    if (segment.startWeek <= priorEnd) return true
    priorEnd = Math.max(priorEnd, segment.endWeek)
  }
  return false
}

// ─── Persisted-profile defect classification ────────────────────────────────

export type ProfileDefectKind =
  | 'window-clear'
  | 'overlap-fix'
  | 'segmentless-decision'
  | 'window-decision'
  | 'unsupported'

export interface ProfileDefect {
  kind: ProfileDefectKind
  classification: FindingClassification
  proposed?: ProposedProfile
  message: string
  allowedResolutions?: string[]
}

/**
 * Classify a structurally invalid persisted profile. Deterministic
 * corrections only where the intended state is proven (window fields that the
 * basis forbids; overlapping segments whose exact non-overlapping sum
 * representation is provable). Ambiguous shapes require explicit decisions.
 */
export function classifyPersistedProfileDefect(
  profile: RemediationProfile,
  context: {
    projectId: string
    resourceTypeIds: ReadonlySet<string>
    namedResourceIds: ReadonlySet<string>
  },
): ProfileDefect | null {
  const input: ProfileStructureInput = {
    id: profile.id,
    projectId: profile.projectId,
    resourceTypeId: profile.resourceTypeId,
    namedResourceId: profile.namedResourceId,
    ownerKind: profile.ownerKind,
    planningBasis: profile.planningBasis,
    source: profile.source,
    defaultPercent: profile.defaultPercent,
    startWeek: profile.startWeek,
    endWeek: profile.endWeek,
    segments: profile.segments.map(segment => ({
      id: segment.id,
      startWeek: segment.startWeek,
      endWeek: segment.endWeek,
      capacityPercent: segment.capacityPercent,
      source: segment.source,
    })),
  }
  const errors = validateProfileStructure(input, context)
  if (errors.length === 0) return null

  const base: Omit<ProposedProfile, 'planningBasis' | 'source' | 'defaultPercent' | 'startWeek' | 'endWeek' | 'segments'> = {
    profileId: profile.id,
    ownerKind: profile.ownerKind as ProposedProfile['ownerKind'],
    legacy: null,
  }

  // Window fields present on a basis that forbids them → deterministic clear.
  const windowClearOnly = errors.every(error =>
    error.includes('must not have startWeek') || error.includes('must not have endWeek'),
  )
  if (windowClearOnly) {
    return {
      kind: 'window-clear',
      classification: 'deterministic',
      proposed: {
        ...base,
        planningBasis: profile.planningBasis as ProposedProfile['planningBasis'],
        source: profile.source as ProposedProfile['source'],
        defaultPercent: profile.defaultPercent,
        startWeek: null,
        endWeek: null,
        segments: profile.segments.map(segment => ({
          id: segment.id,
          startWeek: segment.startWeek,
          endWeek: segment.endWeek,
          capacityPercent: segment.capacityPercent,
          source: segment.source,
        })),
      },
      message: 'window fields are meaningless for this planning basis — deterministic clear',
    }
  }

  // Overlapping segments on a segmented profile → deterministic decomposition.
  if (
    profile.planningBasis === 'CAPACITY_PROFILE' &&
    profile.segments.length > 0 &&
    errors.some(error =>
      error.includes('overlaps with previous segment') ||
      error.includes('duplicate segment with week range'),
    ) &&
    segmentsOverlap(profile.segments as unknown as ProfileStructureSegment[])
  ) {
    const decomposed = decomposeOverlappingSegments(profile.id, profile.segments as unknown as ProfileStructureSegment[])
    if (!decomposed) {
      return {
        kind: 'unsupported',
        classification: 'unsupported',
        message: 'overlapping segments cannot be decomposed deterministically',
      }
    }
    return {
      kind: 'overlap-fix',
      classification: 'deterministic',
      proposed: {
        ...base,
        planningBasis: 'CAPACITY_PROFILE',
        source: profile.source as ProposedProfile['source'],
        defaultPercent: profile.defaultPercent,
        startWeek: profile.startWeek,
        endWeek: profile.endWeek,
        segments: decomposed,
      },
      message: 'contained/partial overlap decomposed to the exact sum-preserving non-overlapping representation',
    }
  }

  // Segmentless non-canonical CAPACITY_PROFILE → owner intent required.
  if (
    profile.planningBasis === 'CAPACITY_PROFILE' &&
    profile.segments.length === 0 &&
    errors.some(error => error.includes('CAPACITY_PROFILE with no segments is only valid'))
  ) {
    return {
      kind: 'segmentless-decision',
      classification: 'decisionRequired',
      message: 'segmentless ROLE/NAMED_PERSON CAPACITY_PROFILE — authoritative capacity not provable',
      allowedResolutions: ['segmented-capacity-profile', 'availability-window', 'scalar-profile'],
    }
  }

  // AVAILABILITY_WINDOW with invalid or inverted weeks → owner intent required.
  if (profile.planningBasis === 'AVAILABILITY_WINDOW') {
    const windowErrors = errors.some(error =>
      error.includes('must be a non-negative finite integer') ||
      error.includes('must not exceed endWeek'),
    )
    if (windowErrors) {
      return {
        kind: 'window-decision',
        classification: 'decisionRequired',
        message: 'AVAILABILITY_WINDOW with invalid/inverted week fields — owner intent required',
        allowedResolutions: ['availability-window', 'scalar-profile'],
      }
    }
  }

  return {
    kind: 'unsupported',
    classification: 'unsupported',
    message: `structurally invalid profile with no deterministic remediation: ${errors[0] ?? 'unknown error'}`,
  }
}

// ─── Snapshot entry classification ──────────────────────────────────────────

export interface SnapshotEntryFinding {
  classification: FindingClassification
  message: string
}

export function classifySnapshotEntry(
  entry: { allocationMode: string | null; allocationPercent: number | null; allocationPct?: number | null; allocationStartWeek: number | null; allocationEndWeek: number | null; startWeek?: number | null; endWeek?: number | null },
): SnapshotEntryFinding {
  const mode = entry.allocationMode ?? null
  if (mode != null && mode !== 'EFFORT' && mode !== 'TIMELINE' && mode !== 'FULL_PROJECT' && mode !== 'CAPACITY_PLAN') {
    return { classification: 'unsupported', message: `unknown allocationMode ${JSON.stringify(mode)}` }
  }
  const effectiveStart = entry.allocationStartWeek ?? entry.startWeek ?? null
  const effectiveEnd = entry.allocationEndWeek ?? entry.endWeek ?? null
  const modeUsesWindows = mode === 'TIMELINE' || mode === 'CAPACITY_PLAN'
  const neverActive = modeUsesWindows && isNeverActiveWindow(effectiveStart, effectiveEnd)

  if (neverActive) {
    return {
      classification: 'deterministic',
      message: 'never-active window normalized by policy to a zero-capacity profile (no write required)',
    }
  }
  if (modeUsesWindows) {
    if (effectiveStart == null || effectiveEnd == null) {
      if (mode === 'CAPACITY_PLAN') {
        return {
          classification: 'decisionRequired',
          message: 'CAPACITY_PLAN without captured window — explicit window interpretation required',
        }
      }
      // TIMELINE without captured window is valid (null = unbounded).
      return { classification: 'alreadyValid', message: 'valid: windowless TIMELINE translates as unbounded' }
    }
    const singleNegative = effectiveStart < 0 || effectiveEnd < 0
    if (singleNegative) {
      return {
        classification: 'decisionRequired',
        message: 'single -1/negative window edge without established meaning — explicit window interpretation required',
      }
    }
    if (effectiveStart > effectiveEnd) {
      // Inverted window is handled by the never-active branch above; unreachable.
      return { classification: 'unsupported', message: 'inverted window' }
    }
    return { classification: 'alreadyValid', message: 'valid: captured window translates directly' }
  }
  // EFFORT / FULL_PROJECT / null — windows are stale aliases, discarded.
  return { classification: 'alreadyValid', message: 'valid: windows discarded for this mode' }
}

// ─── Plan builder ───────────────────────────────────────────────────────────

const EMPTY_CLASS_COUNTS = (): Record<FindingClassification, number> => ({
  deterministic: 0,
  decisionRequired: 0,
  unsupported: 0,
  alreadyValid: 0,
})

function projectContext(project: RemediationProject): {
  projectId: string
  resourceTypeIds: ReadonlySet<string>
  namedResourceIds: ReadonlySet<string>
} {
  const resourceTypeIds = new Set(project.resourceTypes.map(rt => rt.id))
  const namedResourceIds = new Set(project.resourceTypes.flatMap(rt => rt.namedResources.map(nr => nr.id)))
  return { projectId: project.id, resourceTypeIds, namedResourceIds }
}

/**
 * Build the complete remediation plan from current database state.
 *
 * @param state                Loaded current state (see loadRemediationState).
 * @param applicationCommit    Informational git commit for traceability.
 * @returns                    The reviewed plan (never written by this function).
 */
export function buildRemediationPlan(
  state: RemediationDatabaseState,
  applicationCommit: string,
): RemediationPlan {
  const findings: RemediationFinding[] = []
  const operations: RemediationOperation[] = []
  const decisions: PlanDecisionEntry[] = []
  const classCounts = EMPTY_CLASS_COUNTS()

  const addFinding = (
    finding: Omit<RemediationFinding, 'id' | 'evidenceHash' | 'operationId' | 'decisionId'>,
    evidence: Record<string, unknown>,
  ): RemediationFinding => {
    const id = `finding-${String(findings.length + 1).padStart(4, '0')}`
    const full: RemediationFinding = {
      ...finding,
      id,
      evidenceHash: evidenceHash(evidence),
      operationId: null,
      decisionId: null,
    }
    classCounts[finding.classification]++
    findings.push(full)
    return full
  }

  const addOperation = (
    finding: RemediationFinding,
    op: Omit<RemediationOperation, 'id' | 'evidenceHash'>,
  ): void => {
    const id = `op-${String(operations.length + 1).padStart(4, '0')}`
    const full: RemediationOperation = { ...op, id, evidenceHash: finding.evidenceHash }
    operations.push(full)
    finding.operationId = id
  }

  const addDecision = (
    finding: RemediationFinding,
    decision: Omit<PlanDecisionEntry, 'id' | 'evidenceHash'>,
  ): void => {
    const id = `decision-${String(decisions.length + 1).padStart(4, '0')}`
    const full: PlanDecisionEntry = { ...decision, id, evidenceHash: finding.evidenceHash }
    decisions.push(full)
    finding.decisionId = id
  }

  // ── Live owners and persisted profiles ──────────────────────────────────
  for (const project of state.projects) {
    const context = projectContext(project)
    const profilesByOwner = new Map<string, RemediationProfile[]>()
    for (const profile of project.capacityProfiles) {
      const ownerKey = profile.resourceTypeId
        ? `rt::${profile.resourceTypeId}`
        : profile.namedResourceId
          ? `nr::${profile.namedResourceId}`
          : `none::${profile.id}`
      const list = profilesByOwner.get(ownerKey) ?? []
      list.push(profile)
      profilesByOwner.set(ownerKey, list)
    }

    for (const rt of project.resourceTypes) {
      const roleProfiles = profilesByOwner.get(`rt::${rt.id}`)?.filter(p => p.ownerKind === 'ROLE') ?? []
      const nrProfiles = new Map<string, RemediationProfile[]>()
      for (const nr of rt.namedResources) {
        const profiles = profilesByOwner.get(`nr::${nr.id}`) ?? []
        if (profiles.length > 0) nrProfiles.set(nr.id, profiles)
      }
      const hasPlannerOwnership = roleProfiles.some(p => p.source === 'SQUAD_PLANNER') ||
        [...nrProfiles.values()].flat().some(p => p.ownerKind === 'PLANNED_RESOURCE' || p.source === 'SQUAD_PLANNER')

      for (const nr of rt.namedResources) {
        const profiles = nrProfiles.get(nr.id) ?? []
        if (profiles.length > 1) {
          addFinding({
            category: 'live-owner',
            projectId: project.id,
            ownerId: nr.id,
            ownerName: nr.name,
            profileId: null,
            snapshotId: null,
            entryId: null,
            classification: 'unsupported',
            message: `named resource has ${profiles.length} persisted profiles — duplicate owner`,
          }, buildNrEvidence(nr))
          continue
        }
        if (profiles.length === 1) continue

        const derived = deriveNamedProfileFromLegacy(nr)
        const evidence = buildNrEvidence(nr)
        const finding = addFinding({
          category: 'live-owner',
          projectId: project.id,
          ownerId: nr.id,
          ownerName: nr.name,
          profileId: null,
          snapshotId: null,
          entryId: null,
          classification: derived.classification,
          message: derived.message,
        }, evidence)
        if (derived.classification === 'deterministic' && derived.proposed) {
          addOperation(finding, {
            kind: 'create-named-profile',
            classification: 'deterministic',
            projectId: project.id,
            ownerId: nr.id,
            ownerName: nr.name,
            proposed: derived.proposed,
          })
        } else if (derived.classification === 'decisionRequired') {
          addDecision(finding, {
            projectId: project.id,
            ownerId: nr.id,
            ownerKind: 'namedPerson',
            profileId: null,
            snapshotId: null,
            entryId: null,
            legacyBase: mapperLegacyForNamedResource(nr),
            allowedResolutions: ['scalar-profile', 'availability-window', 'segmented-capacity-profile'],
            message: derived.message,
          })
        }
      }

      // Role completeness: planner-owned roles require exactly one ROLE
      // profile; NR-less roles require exactly one ROLE profile.
      const roleMissing = hasPlannerOwnership
        ? roleProfiles.length !== 1
        : rt.namedResources.length === 0 && roleProfiles.length !== 1
      if (roleMissing && roleProfiles.length > 1) {
        addFinding({
          category: 'live-owner',
          projectId: project.id,
          ownerId: rt.id,
          ownerName: rt.name,
          profileId: null,
          snapshotId: null,
          entryId: null,
          classification: 'unsupported',
          message: `resource type has ${roleProfiles.length} ROLE profiles — duplicate owner`,
        }, buildRtEvidence(rt, stateProjectsActivePlan(state, project.id)))
        continue
      }
      if (roleMissing) {
        const derived = deriveRoleProfileFromLegacy(rt, stateProjectsActivePlan(state, project.id))
        const evidence = buildRtEvidence(rt, stateProjectsActivePlan(state, project.id))
        const finding = addFinding({
          category: 'live-owner',
          projectId: project.id,
          ownerId: rt.id,
          ownerName: rt.name,
          profileId: null,
          snapshotId: null,
          entryId: null,
          classification: derived.classification,
          message: derived.message,
        }, evidence)
        if (derived.classification === 'deterministic' && derived.proposed) {
          addOperation(finding, {
            kind: 'create-role-profile',
            classification: 'deterministic',
            projectId: project.id,
            ownerId: rt.id,
            ownerName: rt.name,
            proposed: derived.proposed,
          })
        } else if (derived.classification === 'decisionRequired') {
          addDecision(finding, {
            projectId: project.id,
            ownerId: rt.id,
            ownerKind: 'role',
            profileId: null,
            snapshotId: null,
            entryId: null,
            legacyBase: mapperLegacyForResourceType(rt),
            allowedResolutions: ['scalar-profile', 'availability-window', 'segmented-capacity-profile'],
            message: derived.message,
          })
        }
      }
    }

    // ── Persisted profile defects ────────────────────────────────────────
    for (const profile of project.capacityProfiles) {
      const defect = classifyPersistedProfileDefect(profile, context)
      if (!defect) continue
      const ownerId = profile.resourceTypeId ?? profile.namedResourceId ?? profile.id
      const evidence = buildProfileEvidence(profile)
      const finding = addFinding({
        category: 'persisted-profile',
        projectId: project.id,
        ownerId,
        ownerName: null,
        profileId: profile.id,
        snapshotId: null,
        entryId: null,
        classification: defect.classification,
        message: defect.message,
      }, evidence)
      if (defect.kind === 'window-clear' || defect.kind === 'overlap-fix') {
        addOperation(finding, {
          kind: 'update-profile',
          classification: 'deterministic',
          projectId: project.id,
          ownerId,
          ownerName: '',
          proposed: defect.proposed!,
        })
      } else if (defect.kind === 'segmentless-decision' || defect.kind === 'window-decision') {
        addDecision(finding, {
          projectId: project.id,
          ownerId,
          ownerKind: profile.ownerKind === 'ROLE' ? 'role' : 'namedPerson',
          profileId: profile.id,
          snapshotId: null,
          entryId: null,
          legacyBase: null,
          allowedResolutions: defect.allowedResolutions ?? [],
          message: defect.message,
        })
      }
    }
  }

  // ── Historical snapshots ────────────────────────────────────────────────
  for (const snapshot of state.snapshots) {
    let parsed: unknown
    try {
      parsed = parseSnapshotData(snapshot.snapshot)
    } catch (error) {
      addFinding({
        category: 'snapshot',
        projectId: snapshot.projectId,
        ownerId: null,
        ownerName: null,
        profileId: null,
        snapshotId: snapshot.id,
        entryId: null,
        classification: 'unsupported',
        message: `malformed snapshot: ${error instanceof Error ? error.message : String(error)}`,
      }, { snapshotId: snapshot.id, malformed: true })
      continue
    }

    if (isLegacyV1Snapshot(parsed)) continue
    if (isSnapshotV3(parsed) || isSnapshotV4(parsed)) {
      try {
        validateSnapshotV3(parsed as Parameters<typeof validateSnapshotV3>[0])
      } catch (error) {
        addFinding({
          category: 'snapshot',
          projectId: snapshot.projectId,
          ownerId: null,
          ownerName: null,
          profileId: null,
          snapshotId: snapshot.id,
          entryId: null,
          classification: 'unsupported',
          message: `invalid v${String((parsed as { schemaVersion?: unknown }).schemaVersion)} payload: ${error instanceof Error ? error.message : String(error)}`,
        }, { snapshotId: snapshot.id, schemaVersion: (parsed as { schemaVersion?: unknown }).schemaVersion })
      }
      continue
    }
    if (!isSnapshotV2(parsed)) continue

    const v2 = parsed as SnapshotV2
    const rtById = new Map(v2.resourceTypes.map(rt => [rt.id, true]))

    for (let i = 0; i < v2.resourceTypes.length; i++) {
      const rt = v2.resourceTypes[i]
      const classified = classifySnapshotEntry({
        allocationMode: rt.allocationMode ?? null,
        allocationPercent: rt.allocationPercent ?? null,
        allocationStartWeek: rt.allocationStartWeek ?? null,
        allocationEndWeek: rt.allocationEndWeek ?? null,
      })
      const evidence = buildSnapshotEntryEvidence(snapshot.id, 'resourceType', rt.id, {
        allocationMode: rt.allocationMode ?? null,
        allocationPercent: rt.allocationPercent ?? null,
        allocationStartWeek: rt.allocationStartWeek ?? null,
        allocationEndWeek: rt.allocationEndWeek ?? null,
      })
      const finding = addFinding({
        category: 'snapshot-entry',
        projectId: snapshot.projectId,
        ownerId: rt.id,
        ownerName: rt.name,
        profileId: null,
        snapshotId: snapshot.id,
        entryId: rt.id,
        classification: classified.classification,
        message: classified.message,
      }, evidence)
      if (classified.classification === 'decisionRequired') {
        addDecision(finding, {
          projectId: snapshot.projectId,
          ownerId: rt.id,
          ownerKind: 'role',
          profileId: null,
          snapshotId: snapshot.id,
          entryId: rt.id,
          legacyBase: null,
          allowedResolutions: ['snapshot-window-interpretation'],
          message: classified.message,
        })
      }
    }

    for (let i = 0; i < v2.namedResources.length; i++) {
      const nr = v2.namedResources[i]
      // Orphan-owner rejection (same rule as the v2 translation): a named
      // resource whose parent resource type is absent from the snapshot
      // cannot be translated into authoritative ownership.
      if (!nr.resourceTypeId || !rtById.has(nr.resourceTypeId)) {
        addFinding({
          category: 'snapshot-entry',
          projectId: snapshot.projectId,
          ownerId: nr.id,
          ownerName: nr.name,
          profileId: null,
          snapshotId: snapshot.id,
          entryId: nr.id,
          classification: 'unsupported',
          message: 'named resource references a resource type absent from this snapshot — orphan ownership cannot be translated',
        }, buildSnapshotEntryEvidence(snapshot.id, 'namedResource', nr.id, {
          allocationMode: nr.allocationMode ?? null,
          allocationPercent: nr.allocationPercent ?? null,
          allocationPct: nr.allocationPct ?? null,
          allocationStartWeek: nr.allocationStartWeek ?? null,
          allocationEndWeek: nr.allocationEndWeek ?? null,
          startWeek: nr.startWeek ?? null,
          endWeek: nr.endWeek ?? null,
        }))
        continue
      }
      const classified = classifySnapshotEntry({
        allocationMode: nr.allocationMode ?? null,
        allocationPercent: nr.allocationPercent ?? null,
        allocationPct: nr.allocationPct ?? null,
        allocationStartWeek: nr.allocationStartWeek ?? null,
        allocationEndWeek: nr.allocationEndWeek ?? null,
        startWeek: nr.startWeek ?? null,
        endWeek: nr.endWeek ?? null,
      })
      const evidence = buildSnapshotEntryEvidence(snapshot.id, 'namedResource', nr.id, {
        allocationMode: nr.allocationMode ?? null,
        allocationPercent: nr.allocationPercent ?? null,
        allocationPct: nr.allocationPct ?? null,
        allocationStartWeek: nr.allocationStartWeek ?? null,
        allocationEndWeek: nr.allocationEndWeek ?? null,
        startWeek: nr.startWeek ?? null,
        endWeek: nr.endWeek ?? null,
      })
      const finding = addFinding({
        category: 'snapshot-entry',
        projectId: snapshot.projectId,
        ownerId: nr.id,
        ownerName: nr.name,
        profileId: null,
        snapshotId: snapshot.id,
        entryId: nr.id,
        classification: classified.classification,
        message: classified.message,
      }, evidence)
      if (classified.classification === 'decisionRequired') {
        addDecision(finding, {
          projectId: snapshot.projectId,
          ownerId: nr.id,
          ownerKind: 'namedPerson',
          profileId: null,
          snapshotId: snapshot.id,
          entryId: nr.id,
          legacyBase: null,
          allowedResolutions: ['snapshot-window-interpretation'],
          message: classified.message,
        })
      }
    }
  }

  const summary: RemediationPlanSummary = {
    findings: classCounts,
    operations: operations.length,
    decisionsRequired: decisions.length,
  }
  const plan: RemediationPlan = {
    formatVersion: REMEDIATION_PLAN_FORMAT_VERSION,
    generatedAt: new Date().toISOString(),
    applicationCommit,
    fingerprint: '',
    summary,
    findings,
    operations,
    decisions,
  }
  plan.fingerprint = computePlanFingerprint(plan)
  return plan
}

// ─── Evidence builders ──────────────────────────────────────────────────────

function stateProjectsActivePlan(state: RemediationDatabaseState, projectId: string): RemediationPlanPeriod[] {
  const project = state.projects.find(project => project.id === projectId)
  return project?.activePlanPeriods ?? []
}

export function buildRtEvidence(rt: RemediationResourceType, activePlanPeriods: RemediationPlanPeriod[]): Record<string, unknown> {
  const rtPeriods = activePlanPeriods
    .map(period => ({
      periodIndex: period.periodIndex,
      startWeek: period.startWeek,
      endWeek: period.endWeek,
      entries: period.entries
        .filter(entry => entry.resourceTypeId === rt.id)
        .map(entry => ({ resourceTypeId: entry.resourceTypeId, headcount: entry.headcount })),
    }))
    .filter(period => period.entries.length > 0)
  return {
    ownerType: 'resourceType',
    allocationMode: rt.allocationMode,
    allocationPercent: rt.allocationPercent,
    allocationStartWeek: rt.allocationStartWeek,
    allocationEndWeek: rt.allocationEndWeek,
    count: rt.count,
    namedResourcesCount: rt.namedResources.length,
    activePlanEntries: rtPeriods.length > 0 ? rtPeriods : null,
  }
}

export function buildNrEvidence(nr: RemediationNamedResource): Record<string, unknown> {
  return {
    ownerType: 'namedResource',
    allocationMode: nr.allocationMode,
    allocationPercent: nr.allocationPercent,
    allocationPct: nr.allocationPct,
    allocationStartWeek: nr.allocationStartWeek,
    allocationEndWeek: nr.allocationEndWeek,
    startWeek: nr.startWeek,
    endWeek: nr.endWeek,
  }
}

export function buildProfileEvidence(profile: RemediationProfile): Record<string, unknown> {
  return {
    profileId: profile.id,
    ownerKind: profile.ownerKind,
    planningBasis: profile.planningBasis,
    source: profile.source,
    defaultPercent: profile.defaultPercent,
    startWeek: profile.startWeek,
    endWeek: profile.endWeek,
    segments: profile.segments.map(segment => ({
      id: segment.id,
      startWeek: segment.startWeek,
      endWeek: segment.endWeek,
      capacityPercent: segment.capacityPercent,
      source: segment.source,
    })),
    legacy: profile.legacy == null ? null : canonicalJson(profile.legacy),
  }
}

export function buildSnapshotEntryEvidence(
  snapshotId: string,
  entryType: 'resourceType' | 'namedResource',
  entryId: string,
  captured: Record<string, unknown>,
): Record<string, unknown> {
  return { snapshotId, entryType, entryId, captured }
}

function mapperLegacyForResourceType(rt: RemediationResourceType): Record<string, unknown> {
  return {
    allocationMode: rt.allocationMode,
    allocationPercent: rt.allocationPercent,
    allocationStartWeek: rt.allocationStartWeek,
    allocationEndWeek: rt.allocationEndWeek,
  }
}

function mapperLegacyForNamedResource(nr: RemediationNamedResource): Record<string, unknown> {
  return {
    allocationMode: nr.allocationMode,
    allocationPercent: nr.allocationPercent,
    allocationPct: nr.allocationPct,
    allocationStartWeek: nr.allocationStartWeek,
    allocationEndWeek: nr.allocationEndWeek,
    startWeek: nr.startWeek,
    endWeek: nr.endWeek,
  }
}

// ─── Database state loader ──────────────────────────────────────────────────

/**
 * Load the exact current profile/snapshot state the planner inspects. This is
 * the only Prisma-touching part of the planner; everything above is pure.
 */
export async function loadRemediationState(prisma: PrismaClient): Promise<RemediationDatabaseState> {
  const projects = await prisma.project.findMany({
    select: { id: true, name: true },
    orderBy: { id: 'asc' },
  })

  const loadedProjects: RemediationProject[] = []
  for (const project of projects) {
    const [resourceTypes, capacityProfiles, activePlan] = await Promise.all([
      prisma.resourceType.findMany({
        where: { projectId: project.id },
        orderBy: { id: 'asc' },
        select: {
          id: true,
          name: true,
          count: true,
          allocationMode: true,
          allocationPercent: true,
          allocationStartWeek: true,
          allocationEndWeek: true,
          namedResources: {
            orderBy: { id: 'asc' },
            select: {
              id: true,
              name: true,
              allocationMode: true,
              allocationPercent: true,
              allocationPct: true,
              allocationStartWeek: true,
              allocationEndWeek: true,
              startWeek: true,
              endWeek: true,
            },
          },
        },
      }),
      prisma.capacityProfile.findMany({
        where: { projectId: project.id },
        orderBy: { id: 'asc' },
        include: {
          segments: {
            orderBy: [{ startWeek: 'asc' }, { id: 'asc' }],
          },
        },
      }),
      prisma.capacityPlan.findFirst({
        where: { projectId: project.id, isActive: true },
        select: {
          periods: {
            orderBy: { periodIndex: 'asc' },
            select: {
              periodIndex: true,
              startWeek: true,
              endWeek: true,
              entries: {
                orderBy: { resourceTypeId: 'asc' },
                select: { resourceTypeId: true, headcount: true },
              },
            },
          },
        },
      }),
    ])

    loadedProjects.push({
      id: project.id,
      name: project.name,
      resourceTypes: resourceTypes.map(rt => ({
        id: rt.id,
        name: rt.name,
        count: rt.count,
        allocationMode: rt.allocationMode,
        allocationPercent: rt.allocationPercent,
        allocationStartWeek: rt.allocationStartWeek,
        allocationEndWeek: rt.allocationEndWeek,
        namedResources: rt.namedResources.map(nr => ({
          id: nr.id,
          name: nr.name,
          allocationMode: nr.allocationMode,
          allocationPercent: nr.allocationPercent,
          allocationPct: nr.allocationPct,
          allocationStartWeek: nr.allocationStartWeek,
          allocationEndWeek: nr.allocationEndWeek,
          startWeek: nr.startWeek,
          endWeek: nr.endWeek,
        })),
      })),
      capacityProfiles: capacityProfiles.map(profile => ({
        id: profile.id,
        projectId: profile.projectId,
        resourceTypeId: profile.resourceTypeId,
        namedResourceId: profile.namedResourceId,
        ownerKind: profile.ownerKind,
        planningBasis: profile.planningBasis,
        source: profile.source,
        defaultPercent: profile.defaultPercent,
        startWeek: profile.startWeek,
        endWeek: profile.endWeek,
        legacy: profile.legacy,
        segments: profile.segments.map(segment => ({
          id: segment.id,
          startWeek: segment.startWeek,
          endWeek: segment.endWeek,
          capacityPercent: segment.capacityPercent,
          source: segment.source,
        })),
      })),
      activePlanPeriods: (activePlan?.periods ?? []).map(period => ({
        periodIndex: period.periodIndex,
        startWeek: period.startWeek,
        endWeek: period.endWeek,
        entries: period.entries.map(entry => ({
          resourceTypeId: entry.resourceTypeId,
          headcount: entry.headcount,
        })),
      })),
    })
  }

  const snapshots = await prisma.backlogSnapshot.findMany({
    select: { id: true, projectId: true, snapshot: true },
    orderBy: { id: 'asc' },
  })

  return { projects: loadedProjects, snapshots }
}

// ─── Manifest merge ─────────────────────────────────────────────────────────

export interface ResolvedPlanResult {
  plan: RemediationPlan
  errors: string[]
}

function capacityResolutionToProposed(
  resolution: ManifestCapacityResolution,
  base: {
    profileId: string
    ownerKind: 'ROLE' | 'NAMED_PERSON' | 'PLANNED_RESOURCE'
    legacy: Record<string, unknown> | null
  },
): ProposedProfile {
  switch (resolution.shape) {
    case 'scalar-profile':
      return {
        profileId: base.profileId,
        ownerKind: base.ownerKind,
        planningBasis: resolution.planningBasis,
        source: 'FIXED',
        defaultPercent: resolution.defaultPercent ?? null,
        startWeek: null,
        endWeek: null,
        legacy: base.legacy,
        segments: [],
      }
    case 'availability-window':
      return {
        profileId: base.profileId,
        ownerKind: base.ownerKind,
        planningBasis: 'AVAILABILITY_WINDOW',
        source: 'AVAILABILITY_WINDOW',
        defaultPercent: resolution.defaultPercent ?? null,
        startWeek: resolution.startWeek ?? null,
        endWeek: resolution.endWeek ?? null,
        legacy: base.legacy,
        segments: [],
      }
    case 'segmented-capacity-profile':
      return {
        profileId: base.profileId,
        ownerKind: base.ownerKind,
        planningBasis: 'CAPACITY_PROFILE',
        source: 'LEGACY',
        defaultPercent: resolution.defaultPercent ?? null,
        startWeek: null,
        endWeek: null,
        legacy: base.legacy,
        segments: resolution.segments.map((segment, index) => ({
          id: remediationSegmentId(base.profileId, index),
          startWeek: segment.startWeek,
          endWeek: segment.endWeek,
          capacityPercent: segment.capacityPercent,
          source: 'LEGACY',
        })),
      }
  }
}

/**
 * Merge an approved decision manifest into a plan, converting every resolved
 * decision into a concrete operation. Validation errors are returned; the
 * caller must refuse apply when `errors` is non-empty or any decision remains
 * unresolved.
 */
export function resolvePlanWithManifest(
  plan: RemediationPlan,
  manifest: RemediationManifest,
): ResolvedPlanResult {
  const errors: string[] = []
  if (manifest.formatVersion !== REMEDIATION_MANIFEST_FORMAT_VERSION) {
    errors.push(`unsupported manifest formatVersion ${manifest.formatVersion}`)
  }
  if (manifest.planFingerprint !== plan.fingerprint) {
    errors.push('manifest planFingerprint does not match the plan fingerprint — manifest references different plan content')
  }
  if (errors.length > 0) return { plan, errors }

  const resolvedByDecisionId = new Map<string, ManifestDecision>()
  for (const decision of manifest.decisions) {
    if (resolvedByDecisionId.has(decision.decisionId)) {
      errors.push(`duplicate manifest decision ${decision.decisionId}`)
      continue
    }
    resolvedByDecisionId.set(decision.decisionId, decision)
  }

  const operations: RemediationOperation[] = [...plan.operations]
  const decisions: PlanDecisionEntry[] = []
  const findings: RemediationFinding[] = plan.findings.map(finding => ({ ...finding }))
  const findingByDecisionId = new Map<string, RemediationFinding>()
  for (const finding of findings) {
    if (finding.decisionId) findingByDecisionId.set(finding.decisionId, finding)
  }

  for (const entry of plan.decisions) {
    const manifestDecision = resolvedByDecisionId.get(entry.id)
    if (!manifestDecision) {
      decisions.push(entry)
      continue
    }
    if (manifestDecision.projectId !== entry.projectId || manifestDecision.ownerId !== entry.ownerId) {
      errors.push(`manifest decision ${entry.id} references ${manifestDecision.projectId}/${manifestDecision.ownerId} but the plan entry is ${entry.projectId}/${entry.ownerId}`)
      continue
    }
    if (entry.snapshotId != null && manifestDecision.snapshotId !== entry.snapshotId) {
      errors.push(`manifest decision ${entry.id} snapshot mismatch`)
      continue
    }
    if (!entry.allowedResolutions.includes(manifestDecision.resolution.shape)) {
      errors.push(`manifest decision ${entry.id} uses resolution shape "${manifestDecision.resolution.shape}" which is not allowed for this entry (allowed: ${entry.allowedResolutions.join(', ')})`)
      continue
    }

    const resolution = manifestDecision.resolution
    if (resolution.shape === 'snapshot-window-interpretation') {
      if (!isNonNegativeInteger(resolution.startWeek) || !isNonNegativeInteger(resolution.endWeek) || resolution.startWeek > resolution.endWeek) {
        errors.push(`manifest decision ${entry.id}: snapshot window interpretation must be non-negative with start <= end`)
        continue
      }
      const finding = findingByDecisionId.get(entry.id)
      if (finding) {
        finding.classification = 'deterministic'
        finding.operationId = `op-${String(operations.length + 1).padStart(4, '0')}`
      }
      operations.push({
        id: `op-${String(operations.length + 1).padStart(4, '0')}`,
        kind: 'rewrite-snapshot-entry',
        classification: 'decisionResolved',
        projectId: entry.projectId,
        ownerId: entry.ownerId,
        ownerName: '',
        evidenceHash: entry.evidenceHash,
        decisionId: entry.id,
        proposed: {
          snapshotId: entry.snapshotId!,
          entryType: entry.ownerKind === 'role' ? 'resourceType' : 'namedResource',
          entryId: entry.entryId!,
          startWeek: resolution.startWeek,
          endWeek: resolution.endWeek,
        },
      })
      continue
    }

    // Profile-producing resolution (live owner or persisted profile).
    let ownerKind: 'ROLE' | 'NAMED_PERSON' | 'PLANNED_RESOURCE'
    let capacity: ManifestCapacityResolution
    if (resolution.shape === 'owner-kind-decision') {
      ownerKind = resolution.ownerKind
      capacity = resolution.capacity
    } else {
      ownerKind = entry.ownerKind === 'role' ? 'ROLE' : 'NAMED_PERSON'
      capacity = resolution
    }

    const profileId = entry.profileId ?? remediationProfileId(entry.ownerKind, entry.ownerId)
    const proposed = capacityResolutionToProposed(capacity, {
      profileId,
      ownerKind,
      legacy: entry.legacyBase ?? null,
    })

    const finding = findingByDecisionId.get(entry.id)
    if (finding) {
      finding.classification = 'deterministic'
      finding.operationId = `op-${String(operations.length + 1).padStart(4, '0')}`
    }
    operations.push({
      id: `op-${String(operations.length + 1).padStart(4, '0')}`,
      kind: entry.profileId ? 'update-profile' : entry.ownerKind === 'role' ? 'create-role-profile' : 'create-named-profile',
      classification: 'decisionResolved',
      projectId: entry.projectId,
      ownerId: entry.ownerId,
      ownerName: '',
      evidenceHash: entry.evidenceHash,
      decisionId: entry.id,
      proposed,
    })
  }

  const merged: RemediationPlan = {
    ...plan,
    findings,
    operations,
    decisions,
    summary: {
      findings: {
        deterministic: findings.filter(f => f.classification === 'deterministic').length,
        decisionRequired: findings.filter(f => f.classification === 'decisionRequired').length,
        unsupported: findings.filter(f => f.classification === 'unsupported').length,
        alreadyValid: findings.filter(f => f.classification === 'alreadyValid').length,
      },
      operations: operations.length,
      decisionsRequired: decisions.length,
    },
    fingerprint: computePlanFingerprint({
      formatVersion: plan.formatVersion,
      summary: {
        findings: {
          deterministic: findings.filter(f => f.classification === 'deterministic').length,
          decisionRequired: findings.filter(f => f.classification === 'decisionRequired').length,
          unsupported: findings.filter(f => f.classification === 'unsupported').length,
          alreadyValid: findings.filter(f => f.classification === 'alreadyValid').length,
        },
        operations: operations.length,
        decisionsRequired: decisions.length,
      },
      findings,
      operations,
      decisions,
    }),
  }
  return { plan: merged, errors }
}

// ─── Plan serialisation / parsing ───────────────────────────────────────────

export function planToJson(plan: RemediationPlan): string {
  return JSON.stringify(plan, null, 2)
}

export interface ParsePlanResult {
  plan: RemediationPlan | null
  errors: string[]
}

export function parsePlanJson(raw: string): ParsePlanResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    return { plan: null, errors: [`plan is not valid JSON: ${error instanceof Error ? error.message : String(error)}`] }
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { plan: null, errors: ['plan must be a JSON object'] }
  }
  const obj = parsed as Record<string, unknown>
  if (obj.formatVersion !== REMEDIATION_PLAN_FORMAT_VERSION) {
    return { plan: null, errors: [`unsupported plan formatVersion ${String(obj.formatVersion)} (expected ${REMEDIATION_PLAN_FORMAT_VERSION})`] }
  }
  if (!Array.isArray(obj.findings) || !Array.isArray(obj.operations) || !Array.isArray(obj.decisions)) {
    return { plan: null, errors: ['plan must contain findings, operations and decisions arrays'] }
  }
  const candidate = obj as unknown as RemediationPlan
  const recomputed = computePlanFingerprint({
    formatVersion: candidate.formatVersion,
    summary: candidate.summary,
    findings: candidate.findings,
    operations: candidate.operations,
    decisions: candidate.decisions,
  })
  if (recomputed !== candidate.fingerprint) {
    return { plan: null, errors: ['plan fingerprint mismatch — plan content was altered after review'] }
  }
  return { plan: candidate, errors: [] }
}

export function parseManifestJson(raw: string): { manifest: RemediationManifest | null; errors: string[] } {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    return { manifest: null, errors: [`manifest is not valid JSON: ${error instanceof Error ? error.message : String(error)}`] }
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { manifest: null, errors: ['manifest must be a JSON object'] }
  }
  const obj = parsed as Record<string, unknown>
  if (obj.formatVersion !== REMEDIATION_MANIFEST_FORMAT_VERSION) {
    return { manifest: null, errors: [`unsupported manifest formatVersion ${String(obj.formatVersion)} (expected ${REMEDIATION_MANIFEST_FORMAT_VERSION})`] }
  }
  if (typeof obj.planFingerprint !== 'string' || !Array.isArray(obj.decisions)) {
    return { manifest: null, errors: ['manifest must contain planFingerprint and decisions'] }
  }
  return { manifest: obj as unknown as RemediationManifest, errors: [] }
}

/** Exit classification for a plan (0 = clean, 1 = structural, 2 = decisions). */
export function classifyPlanExit(plan: RemediationPlan): 0 | 1 | 2 {
  if (plan.summary.findings.unsupported > 0) return 1
  if (plan.summary.decisionsRequired > 0) return 2
  return 0
}

// ─── Human-readable report ──────────────────────────────────────────────────

export function formatRemediationPlanReport(plan: RemediationPlan): string {
  const lines: string[] = []
  lines.push('═══ Capacity-Profile Readiness Remediation Plan ═══')
  lines.push('')
  lines.push(`Application commit (informational): ${plan.applicationCommit}`)
  lines.push(`Plan fingerprint: ${plan.fingerprint}`)
  lines.push(`Format version: ${plan.formatVersion}`)
  lines.push('')
  lines.push('Summary:')
  lines.push(`  deterministic changes:     ${plan.summary.findings.deterministic}`)
  lines.push(`  explicit decisions needed: ${plan.summary.findings.decisionRequired}`)
  lines.push(`  unsupported / invalid:     ${plan.summary.findings.unsupported}`)
  lines.push(`  already valid / no action: ${plan.summary.findings.alreadyValid}`)
  lines.push(`  operations (writes):       ${plan.summary.operations}`)
  lines.push(`  unresolved decisions:      ${plan.summary.decisionsRequired}`)
  lines.push('')
  if (plan.summary.findings.unsupported > 0) {
    lines.push('❌ Unsupported or structurally invalid findings present:')
    for (const finding of plan.findings.filter(f => f.classification === 'unsupported')) {
      lines.push(`   - ${finding.id}: ${finding.message} (${finding.projectId}${finding.ownerId ? ` / ${finding.ownerId}` : ''}${finding.snapshotId ? ` / snapshot ${finding.snapshotId}` : ''})`)
    }
    lines.push('')
  }
  if (plan.summary.findings.decisionRequired > 0) {
    lines.push('⚠ Explicit reviewed decisions required:')
    for (const decision of plan.decisions) {
      lines.push(`   - ${decision.id}: ${decision.message} (${decision.projectId} / ${decision.ownerId}${decision.snapshotId ? ` / snapshot ${decision.snapshotId}` : ''})`)
      lines.push(`     allowed resolutions: ${decision.allowedResolutions.join(', ')}`)
    }
    lines.push('')
  }
  if (plan.summary.operations > 0) {
    lines.push('Planned operations (no writes in dry-run):')
    for (const operation of plan.operations) {
      lines.push(`   - ${operation.id}: ${operation.kind} ${operation.projectId} / ${operation.ownerId}${operation.decisionId ? ` (decision ${operation.decisionId})` : ''}`)
    }
    lines.push('')
  }
  const exit = classifyPlanExit(plan)
  lines.push(exit === 0
    ? '✅ PLAN VALID — no unresolved decisions.'
    : exit === 2
      ? '⚠ PLAN VALID BUT DECISIONS REMAIN — apply is refused until every decision is resolved.'
      : '❌ PLAN INVALID — unsupported/structural findings must be reviewed before any apply.')
  return lines.join('\n')
}

// re-export for apply's structural validation
export type { ProfileStructureInput, ProfileStructureSegment }
