/**
 * capacityProfileProvenance.ts — Shared explicit provenance constants and
 * pure legacy-payload predicates for CapacityProfile (issue #405).
 *
 * `provenance` is the single explicit nullable enum that replaces the
 * overloaded `legacy` JSON: it records why a profile receives special
 * behavioural treatment beyond what `source` alone can express. Profiles
 * with no special provenance store null. It is NOT a generic metadata bag.
 *
 * This module is the single source of truth for:
 *  - the four provenance values;
 *  - the post-#405 runtime classification predicates (provenance + the
 *    authoritative shape checks that protected ownership before the legacy
 *    JSON was removed, so user-edited or planner-transferred rows with
 *    changed source/basis are never misclassified);
 *  - the structural legacy-payload predicates used to translate recognised
 *    pre-#405 `legacy` provenance — the exact rules the database migration
 *    backfill SQL mirrors, and the exact rules the V4 snapshot restore
 *    translation applies to historical snapshots.
 */

// ─── Provenance values ──────────────────────────────────────────────────────

export const CapacityProfileProvenance = {
  LEGACY_MAPPER: 'LEGACY_MAPPER',
  ROLE_DEFAULT: 'ROLE_DEFAULT',
  RESOURCE_OPTIMISER: 'RESOURCE_OPTIMISER',
  TRANSFERRED_FROM_SQUAD_PLANNER: 'TRANSFERRED_FROM_SQUAD_PLANNER',
} as const

export type CapacityProfileProvenanceValue =
  typeof CapacityProfileProvenance[keyof typeof CapacityProfileProvenance]

export const CAPACITY_PROFILE_PROVENANCE_VALUES: readonly CapacityProfileProvenanceValue[] = [
  CapacityProfileProvenance.LEGACY_MAPPER,
  CapacityProfileProvenance.ROLE_DEFAULT,
  CapacityProfileProvenance.RESOURCE_OPTIMISER,
  CapacityProfileProvenance.TRANSFERRED_FROM_SQUAD_PLANNER,
]

// ─── Minimal shape helpers ──────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isNullableFinite(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isFinite(value))
}

/** hasValidAvailabilityWindow: finite percent, null-or-finite edges, ordered. */
export function hasValidAvailabilityWindow(profile: {
  defaultPercent?: number | null | undefined
  startWeek?: number | null | undefined
  endWeek?: number | null | undefined
}): boolean {
  return Number.isFinite(profile.defaultPercent ?? null)
    && isNullableFinite(profile.startWeek ?? null)
    && isNullableFinite(profile.endWeek ?? null)
    && (profile.startWeek == null || profile.endWeek == null || profile.startWeek <= profile.endWeek)
}

// ─── Post-#405 runtime classification predicates ────────────────────────────

/**
 * Whether a persisted profile is a system-generated NAMED_PERSON clone of a
 * ROLE default (count increase / NamedResource POST). Removable by count
 * reduction and follows role edits; user edits flip source to MANUAL which
 * the classifier protects independently.
 */
export function isRoleDefaultClone(profile: { provenance?: unknown }): boolean {
  return profile.provenance === CapacityProfileProvenance.ROLE_DEFAULT
}

/**
 * Whether a scalar NAMED_PERSON profile is an optimiser-owned derived
 * profile: explicit provenance plus the authoritative shape the optimiser
 * writes (issue #405). Keeps the pre-#405 shape checks so a malformed row
 * carrying the marker fails closed instead of being overwritten.
 */
export function isOptimiserDerivedProfile(profile: {
  ownerKind: string
  namedResourceId?: string | null | undefined
  resourceTypeId?: string | null | undefined
  source: string
  planningBasis: string
  defaultPercent?: number | null | undefined
  startWeek?: number | null | undefined
  endWeek?: number | null | undefined
  provenance?: unknown
}): boolean {
  return profile.ownerKind === 'NAMED_PERSON'
    && profile.namedResourceId != null
    && profile.resourceTypeId == null
    && profile.source === 'DERIVED'
    && profile.planningBasis === 'AVAILABILITY_WINDOW'
    && hasValidAvailabilityWindow(profile)
    && profile.provenance === CapacityProfileProvenance.RESOURCE_OPTIMISER
}

// ─── Mapper (source, planningBasis) pair contract ───────────────────────────

/**
 * The exact (source, planningBasis) pairs the legacy mapper/backfill and the
 * current profile-first seeds produce for a recognised allocation mode.
 * Post-#405 the mode lives only in history, so the persisted pair is the
 * authoritative shape evidence that a LEGACY_MAPPER profile is still
 * mapper-shaped (a user edit or planner/transfer write changes source and
 * must not be treated as mapper-owned).
 */
const MAPPER_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['FIXED', 'DEMAND_FOLLOWING'],
  ['AVAILABILITY_WINDOW', 'AVAILABILITY_WINDOW'],
  ['FIXED', 'WHOLE_PROJECT_ALLOCATION'],
  ['LEGACY', 'CAPACITY_PROFILE'],
  ['LEGACY', 'DEMAND_FOLLOWING'],
]

export function isMapperSourceBasisPair(source: string | null | undefined, planningBasis: string | null | undefined): boolean {
  return MAPPER_PAIRS.some(([s, b]) => s === source && b === planningBasis)
}

/**
 * Whether a persisted profile satisfies the strict mapper-derived contract
 * after #405: explicit LEGACY_MAPPER provenance plus the authoritative
 * mapper shape (owner kind, FKs, mapper pair, valid scalar window).
 */
export function isLegacyMapperProfile(profile: {
  ownerKind: string
  source?: string | null | undefined
  planningBasis?: string | null | undefined
  resourceTypeId?: string | null | undefined
  namedResourceId?: string | null | undefined
  defaultPercent?: number | null | undefined
  startWeek?: number | null | undefined
  endWeek?: number | null | undefined
  provenance?: unknown
}): boolean {
  if (profile.provenance !== CapacityProfileProvenance.LEGACY_MAPPER) return false
  if (!isMapperSourceBasisPair(profile.source, profile.planningBasis)) return false
  if (profile.ownerKind === 'ROLE') {
    return profile.resourceTypeId != null && profile.namedResourceId == null
  }
  if (profile.ownerKind === 'NAMED_PERSON') {
    return profile.namedResourceId != null
      && profile.resourceTypeId == null
      && hasValidAvailabilityWindow(profile)
  }
  return false
}

// ─── Pre-#405 legacy-payload predicates (migration + V4 translation) ────────

/**
 * Minimal persisted shape carrying the pre-#405 `legacy` payload. Used by
 * the V4 snapshot translation (and mirrored by the migration backfill SQL).
 */
export interface LegacyPayloadProfileShape {
  ownerKind: string
  source: string
  planningBasis: string
  resourceTypeId: string | null | undefined
  namedResourceId: string | null | undefined
  defaultPercent: number | null | undefined
  startWeek: number | null | undefined
  endWeek: number | null | undefined
  legacy: unknown
}

const MAPPER_KEYS = [
  'allocationMode',
  'allocationPercent',
  'allocationPct',
  'allocationStartWeek',
  'allocationEndWeek',
  'startWeek',
  'endWeek',
] as const

function hasAllMapperKeys(legacy: Record<string, unknown>): boolean {
  return MAPPER_KEYS.every(key => key in legacy)
}

function mapperValuesNullableFinite(legacy: Record<string, unknown>): boolean {
  return MAPPER_KEYS.slice(1).every(key => isNullableFinite(legacy[key]))
}

/**
 * The exact (source, planningBasis) pair the mapper produced for a legacy
 * allocationMode value, or undefined when the mode is not a recognised
 * mapper mode. Mirrors MAPPER_PAIRS in the pre-#405 runtime services.
 */
function mapperPairForMode(mode: unknown): readonly [string, string] | undefined {
  if (mode == null) return ['LEGACY', 'DEMAND_FOLLOWING']
  if (typeof mode !== 'string') return undefined
  switch (mode) {
    case 'EFFORT': return ['FIXED', 'DEMAND_FOLLOWING']
    case 'TIMELINE': return ['AVAILABILITY_WINDOW', 'AVAILABILITY_WINDOW']
    case 'FULL_PROJECT': return ['FIXED', 'WHOLE_PROJECT_ALLOCATION']
    case 'CAPACITY_PLAN': return ['LEGACY', 'CAPACITY_PROFILE']
    default: return undefined
  }
}

function readNullableFiniteLegacyValue(record: Record<string, unknown>, key: string): number | null {
  const value = record[key]
  if (!isNullableFinite(value)) throw new TypeError(`Expected ${key} to be a finite number or null`)
  return value
}

/**
 * Strict ROLE-level mapper contract (the pre-#405 isValidMapperProvenance):
 * aggregate ROLE profile with a fully-populated 7-key mapper payload,
 * recognised mode pair, shape agreement with the legacy payload, and the
 * ROLE-only legacy fields exactly null.
 */
export function isLegacyMapperRoleProfile(profile: LegacyPayloadProfileShape): boolean {
  if (profile.ownerKind !== 'ROLE') return false
  if (profile.namedResourceId != null) return false
  if (profile.resourceTypeId == null) return false
  if (!isRecord(profile.legacy)) return false

  const legacy = profile.legacy
  if (!hasAllMapperKeys(legacy)) return false
  if (!mapperValuesNullableFinite(legacy)) return false

  const expectedPair = mapperPairForMode(legacy.allocationMode)
  if (!expectedPair) return false
  if (profile.source !== expectedPair[0] || profile.planningBasis !== expectedPair[1]) return false

  if ((profile.defaultPercent ?? null) !== legacy.allocationPercent) return false
  if ((profile.startWeek ?? null) !== legacy.allocationStartWeek) return false
  if ((profile.endWeek ?? null) !== legacy.allocationEndWeek) return false

  // ROLE-only legacy fields must be exactly null.
  if (legacy.allocationPct !== null) return false
  if (legacy.startWeek !== null) return false
  if (legacy.endWeek !== null) return false

  return true
}

/**
 * Strict NAMED_PERSON-level mapper contract (the pre-#405
 * isValidNamedResourceMapperProvenance): scalar NAMED_PERSON profile with a
 * valid availability window and a fully-populated 7-key mapper payload whose
 * shape agrees with the profile (using the mapper's alias fallbacks).
 */
export function isLegacyMapperNamedProfile(profile: LegacyPayloadProfileShape): boolean {
  if (profile.ownerKind !== 'NAMED_PERSON') return false
  if (profile.namedResourceId == null || profile.resourceTypeId != null) return false
  if (!hasValidAvailabilityWindow(profile)) return false
  if (!isRecord(profile.legacy)) return false

  const legacy = profile.legacy
  if (!hasAllMapperKeys(legacy)) return false
  if (!mapperValuesNullableFinite(legacy)) return false

  const expectedPair = mapperPairForMode(legacy.allocationMode)
  if (!expectedPair) return false
  if (profile.source !== expectedPair[0] || profile.planningBasis !== expectedPair[1]) return false

  const expectedPercent = readNullableFiniteLegacyValue(legacy, 'allocationPercent')
    ?? readNullableFiniteLegacyValue(legacy, 'allocationPct')
    ?? 100
  const expectedStart = readNullableFiniteLegacyValue(legacy, 'allocationStartWeek')
    ?? readNullableFiniteLegacyValue(legacy, 'startWeek')
    ?? null
  const expectedEnd = readNullableFiniteLegacyValue(legacy, 'allocationEndWeek')
    ?? readNullableFiniteLegacyValue(legacy, 'endWeek')
    ?? null

  return profile.defaultPercent === expectedPercent
    && profile.startWeek === expectedStart
    && profile.endWeek === expectedEnd
}

/**
 * Strict mapper contract for either ROLE or NAMED_PERSON profiles.
 */
export function isMapperLegacyPayloadProfile(profile: LegacyPayloadProfileShape): boolean {
  return isLegacyMapperRoleProfile(profile) || isLegacyMapperNamedProfile(profile)
}

/**
 * Deterministically translate a pre-#405 legacy payload into the recognised
 * behavioural provenance, using the exact same rules as the database
 * migration. Returns null when the payload carries no behavioural
 * provenance (manual-editor/projection-only metadata, ROLE transfer
 * metadata, unknown JSON, arbitrary values) — those restore as null.
 */
export function legacyProvenanceOf(profile: LegacyPayloadProfileShape): CapacityProfileProvenanceValue | null {
  const legacy = profile.legacy

  // ROLE_DEFAULT — valid system-generated NAMED_PERSON clone.
  if (
    profile.ownerKind === 'NAMED_PERSON'
    && profile.resourceTypeId == null
    && profile.namedResourceId != null
    && profile.source === 'DERIVED'
    && isRecord(legacy)
    && legacy.writer === 'ROLE_DEFAULT'
  ) {
    return CapacityProfileProvenance.ROLE_DEFAULT
  }

  // RESOURCE_OPTIMISER — optimiser-owned scalar profile.
  if (
    profile.ownerKind === 'NAMED_PERSON'
    && profile.resourceTypeId == null
    && profile.namedResourceId != null
    && profile.source === 'DERIVED'
    && profile.planningBasis === 'AVAILABILITY_WINDOW'
    && hasValidAvailabilityWindow(profile)
    && isRecord(legacy)
    && legacy.writer === 'RESOURCE_OPTIMISER'
    && legacy.version === 1
  ) {
    return CapacityProfileProvenance.RESOURCE_OPTIMISER
  }

  // TRANSFERRED_FROM_SQUAD_PLANNER — transferred planned resource whose
  // scheduler suppression contract is satisfied. ROLE profiles carrying the
  // same writer are not promoted (the scheduler never suppresses a role).
  if (
    profile.ownerKind === 'PLANNED_RESOURCE'
    && profile.resourceTypeId == null
    && profile.namedResourceId != null
    && profile.source === 'MANUAL'
    && profile.planningBasis === 'CAPACITY_PROFILE'
    && isRecord(legacy)
    && legacy.writer === 'transfer-to-manual'
  ) {
    return CapacityProfileProvenance.TRANSFERRED_FROM_SQUAD_PLANNER
  }

  // LEGACY_MAPPER — complete strict mapper contract (ROLE or NAMED_PERSON).
  if (isMapperLegacyPayloadProfile(profile)) {
    return CapacityProfileProvenance.LEGACY_MAPPER
  }

  return null
}
