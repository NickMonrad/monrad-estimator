/**
 * projectSnapshotValidation.ts — V3 snapshot validation for pre-rollback checks.
 *
 * Validates that a SnapshotV3 payload is structurally sound before
 * committing destructive work (rollback).  Duplicate owners are preserved;
 * duplicate profile/segment IDs are rejected.
 *
 * @module projectSnapshotValidation
 */

import type {
  SnapshotV3,
  SnapshotCapacityProfile,
  SnapshotCapacitySegment,
  SnapshotJsonValue,
  CapacityProfileOwnerKindEnum,
  CapacityProfilePlanningBasisEnum,
  CapacityProfileSourceEnum,
} from './projectSnapshotTypes.js'

// ─── Known enum value sets ───────────────────────────────────────────────────

const VALID_OWNER_KINDS: readonly CapacityProfileOwnerKindEnum[] = [
  'ROLE',
  'NAMED_PERSON',
  'PLANNED_RESOURCE',
] as const

const VALID_PLANNING_BASES: readonly CapacityProfilePlanningBasisEnum[] = [
  'DEMAND_FOLLOWING',
  'AVAILABILITY_WINDOW',
  'WHOLE_PROJECT_ALLOCATION',
  'CAPACITY_PROFILE',
] as const

const VALID_SOURCES: readonly CapacityProfileSourceEnum[] = [
  'FIXED',
  'MANUAL',
  'AVAILABILITY_WINDOW',
  'SQUAD_PLANNER',
  'IMPORTED',
  'DERIVED',
  'LEGACY',
] as const

// ─── Error class ─────────────────────────────────────────────────────────────

export class SnapshotValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SnapshotValidationError'
  }
}

// ─── Validation ──────────────────────────────────────────────────────────────

function fail(path: string, detail: string): never {
  throw new SnapshotValidationError(`${path}: ${detail}`)
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

function isJsonCompatible(value: unknown, stack?: Set<object>): boolean {
  stack = stack ?? new Set<object>()
  // Primitives
  if (value === null) return true
  if (typeof value === 'string') return true
  if (typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  // Arrays — detect cycles in the current path only (shared refs are fine)
  if (Array.isArray(value)) {
    if (stack.has(value)) return false
    stack.add(value)
    const ok = value.every(v => isJsonCompatible(v, stack))
    stack.delete(value)
    return ok
  }
  // Plain objects only — reject Date, RegExp, custom classes
  if (typeof value === 'object' && value !== null) {
    const proto = Object.getPrototypeOf(value)
    if (proto !== null && proto !== Object.prototype) return false
    if (stack.has(value)) return false
    stack.add(value)
    const ok = Object.values(value).every(v => isJsonCompatible(v, stack))
    stack.delete(value)
    return ok
  }
  return false
}

export function validateSnapshotJsonValue(
  sjv: unknown,
  pfx: string,
): asserts sjv is SnapshotJsonValue {
  if (typeof sjv !== 'object' || sjv === null) {
    fail(pfx, 'SnapshotJsonValue must be a non-null object')
  }
  const obj = sjv as Record<string, unknown>
  // kind must be present and a string
  if (typeof obj.kind !== 'string') {
    fail(pfx, `SnapshotJsonValue kind must be a string, got ${typeof obj.kind === 'string' ? '"' + obj.kind + '"' : String(typeof obj.kind)}`)
  }
  const kind = obj.kind as string
  if (kind === 'DB_NULL') {
    const keys = Object.keys(obj)
    if (keys.length !== 1 || keys[0] !== 'kind') {
      fail(pfx, 'DB_NULL must have exactly one field "kind"')
    }
    return
  }
  if (kind === 'JSON_NULL') {
    const keys = Object.keys(obj)
    if (keys.length !== 1 || keys[0] !== 'kind') {
      fail(pfx, 'JSON_NULL must have exactly one field "kind"')
    }
    return
  }
  if (kind === 'VALUE') {
    const keys = Object.keys(obj)
    if (keys.length !== 2 || !keys.includes('kind') || !keys.includes('value')) {
      fail(pfx, 'VALUE must have exactly two fields: "kind" and "value"')
    }
    // Top-level null is not valid for VALUE — use DB_NULL / JSON_NULL for null semantics
    if (obj.value === null) {
      fail(pfx, 'VALUE kind must not contain a top-level null value')
    }
    if (!isJsonCompatible(obj.value)) {
      fail(pfx, 'VALUE kind contains a non-serialisable value (undefined, NaN, ±Infinity, function, symbol, bigint, cyclic reference, or non-plain object)')
    }
    return
  }
  fail(pfx, `unsupported SnapshotJsonValue kind "${String(kind)}"`)
}

/**
 * Validate a SnapshotV3 payload for structural soundness.
 *
 * Checks performed:
 *  - Non-empty unique resourceTypes IDs
 *  - Non-empty unique namedResources IDs
 *  - Each namedResource.resourceTypeId exists in snapshot.resourceTypes
 *  - Each non-null overheadItems.resourceTypeId exists in snapshot.resourceTypes
 *  - Non-empty unique profile IDs globally
 *  - Non-empty unique segment IDs globally
 *  - ownerKind is a supported enum value
 *  - ROLE requires resourceTypeId and null namedResourceId
 *  - NAMED_PERSON / PLANNED_RESOURCE require namedResourceId and null resourceTypeId
 *  - Each referenced owner ID exists in snapshot.resourceTypes or .namedResources
 *  - Named resource's resourceTypeId exists in snapshot.resourceTypes
 *  - planningBasis is a supported enum value
 *  - source (profile-level) is a supported enum value
 *  - defaultPercent is null or finite >= 0
 *  - Profile startWeek / endWeek are null or finite numbers
 *  - Segment startWeek / endWeek are finite numbers with end >= start
 *  - Segment capacityPercent is finite >= 0
 *  - Segment source is a supported enum value
 *
 * Explicitly NOT rejected:
 *  - Duplicate owners (same resourceTypeId / namedResourceId across profiles)
 *  - Overlapping or discontinuous segments
 *  - >100% role capacity
 *  - null legacy field
 *
 * @throws SnapshotValidationError on first invalid value.
 */
export function validateSnapshotV3(snapshot: SnapshotV3): void {
  const { capacityProfiles, resourceTypes, namedResources, overheadItems } = snapshot

  // ── resourceTypes structure ──────────────────────────────────────────────
  const seenRtIds = new Set<string>()
  for (let ri = 0; ri < resourceTypes.length; ri++) {
    const rt = resourceTypes[ri]
    const rpfx = `resourceTypes[${ri}]`
    if (typeof rt !== 'object' || rt === null) {
      fail(rpfx, 'resourceType entry must be a non-null object')
    }
    if (typeof rt.id !== 'string' || rt.id.length === 0) {
      fail(rpfx, 'resourceType id must be a non-empty string')
    }
    if (seenRtIds.has(rt.id)) {
      fail(rpfx, `duplicate resourceType id "${rt.id}"`)
    }
    seenRtIds.add(rt.id)
  }

  // ── namedResources structure ─────────────────────────────────────────────
  const seenNrIds = new Set<string>()
  for (let ni = 0; ni < namedResources.length; ni++) {
    const nr = namedResources[ni]
    const npfx = `namedResources[${ni}]`
    if (typeof nr !== 'object' || nr === null) {
      fail(npfx, 'namedResource entry must be a non-null object')
    }
    if (typeof nr.id !== 'string' || nr.id.length === 0) {
      fail(npfx, 'namedResource id must be a non-empty string')
    }
    if (seenNrIds.has(nr.id)) {
      fail(npfx, `duplicate namedResource id "${nr.id}"`)
    }
    seenNrIds.add(nr.id)
  }

  // Build lookup sets for owner ID existence checks
  const rtIds = new Set(resourceTypes.map(r => r.id))
  const nrIds = new Set(namedResources.map(n => n.id))
  const nrRtIds = new Map(namedResources.map(n => [n.id, n.resourceTypeId]))

  // ── Every namedResource.resourceTypeId must exist in resourceTypes ──────
  for (let ni = 0; ni < namedResources.length; ni++) {
    const nr = namedResources[ni]
    const npfx = `namedResources[${ni}]`
    if (!rtIds.has(nr.resourceTypeId)) {
      fail(npfx, `resourceTypeId "${nr.resourceTypeId}" not found in snapshot.resourceTypes`)
    }
  }

  // ── Overhead items: non-null resourceTypeId must exist in resourceTypes ─
  for (let oi = 0; oi < overheadItems.length; oi++) {
    const item = overheadItems[oi]
    const opfx = `overheadItems[${oi}]`
    if (typeof item !== 'object' || item === null) {
      fail(opfx, 'overhead item must be a non-null object')
    }
    const oiRtId = item.resourceTypeId
    if (oiRtId !== null && !rtIds.has(oiRtId)) {
      fail(opfx, `resourceTypeId "${oiRtId}" not found in snapshot.resourceTypes`)
    }
  }

  // ── Capacity profiles ───────────────────────────────────────────────────
  const seenProfileIds = new Set<string>()
  const seenSegmentIds = new Set<string>()

  for (let pi = 0; pi < capacityProfiles.length; pi++) {
    const profile = capacityProfiles[pi]
    const pfx = `capacityProfiles[${pi}]`

    if (typeof profile !== 'object' || profile === null) {
      fail(pfx, 'capacity profile must be a non-null object')
    }

    validateProfile(profile, pfx, rtIds, nrIds, nrRtIds, seenProfileIds, seenSegmentIds)
  }
}

function validateProfile(
  profile: SnapshotCapacityProfile,
  pfx: string,
  rtIds: Set<string>,
  nrIds: Set<string>,
  nrRtIds: Map<string, string>,
  seenProfileIds: Set<string>,
  seenSegmentIds: Set<string>,
): void {
  // id — non-empty and globally unique
  if (typeof profile.id !== 'string' || profile.id.length === 0) {
    fail(pfx, 'profile id must be a non-empty string')
  }
  if (seenProfileIds.has(profile.id)) {
    fail(pfx, `duplicate profile id "${profile.id}"`)
  }
  seenProfileIds.add(profile.id)

  // ownerKind — supported value
  if (!VALID_OWNER_KINDS.includes(profile.ownerKind as CapacityProfileOwnerKindEnum)) {
    fail(pfx, `unsupported ownerKind "${String(profile.ownerKind)}"`)
  }

  // Owner-kind-specific rules
  switch (profile.ownerKind) {
    case 'ROLE': {
      if (typeof profile.resourceTypeId !== 'string' || profile.resourceTypeId.length === 0) {
        fail(pfx, 'ROLE ownerKind requires a non-empty resourceTypeId')
      }
      if (profile.namedResourceId !== null) {
        fail(pfx, 'ROLE ownerKind requires namedResourceId to be null')
      }
      // Verify resourceTypeId exists
      if (!rtIds.has(profile.resourceTypeId)) {
        fail(pfx, `resourceTypeId "${profile.resourceTypeId}" not found in snapshot.resourceTypes`)
      }
      break
    }
    case 'NAMED_PERSON':
    case 'PLANNED_RESOURCE': {
      if (typeof profile.namedResourceId !== 'string' || profile.namedResourceId.length === 0) {
        fail(pfx, `${profile.ownerKind} ownerKind requires a non-empty namedResourceId`)
      }
      if (profile.resourceTypeId !== null) {
        fail(pfx, `${profile.ownerKind} ownerKind requires resourceTypeId to be null`)
      }
      // Verify namedResourceId exists
      if (!nrIds.has(profile.namedResourceId)) {
        fail(pfx, `namedResourceId "${profile.namedResourceId}" not found in snapshot.namedResources`)
      }
      // Verify the named resource's own resourceTypeId exists
      const linkedRtId = nrRtIds.get(profile.namedResourceId)
      if (linkedRtId !== undefined && !rtIds.has(linkedRtId)) {
        fail(pfx, `namedResource "${profile.namedResourceId}" references resourceTypeId "${linkedRtId}" which is not in snapshot.resourceTypes`)
      }
      break
    }
    default:
      // Already caught by the ownerKind check above, but satisfies exhaustiveness
      fail(pfx, `unsupported ownerKind "${String(profile.ownerKind)}"`)
  }

  // planningBasis — supported value
  if (!VALID_PLANNING_BASES.includes(profile.planningBasis as CapacityProfilePlanningBasisEnum)) {
    fail(pfx, `unsupported planningBasis "${String(profile.planningBasis)}"`)
  }

  // source — supported value
  if (!VALID_SOURCES.includes(profile.source as CapacityProfileSourceEnum)) {
    fail(pfx, `unsupported source "${String(profile.source)}"`)
  }

  // defaultPercent — null or finite >= 0
  if (profile.defaultPercent !== null) {
    if (!isFiniteNumber(profile.defaultPercent) || profile.defaultPercent < 0) {
      fail(pfx, `defaultPercent must be null or a finite number >= 0, got ${String(profile.defaultPercent)}`)
    }
  }
  // startWeek / endWeek — null or finite number
  if (profile.startWeek !== null && !isFiniteNumber(profile.startWeek)) {
    fail(pfx, `startWeek must be null or a finite number, got ${String(profile.startWeek)}`)
  }
  if (profile.endWeek !== null && !isFiniteNumber(profile.endWeek)) {
    fail(pfx, `endWeek must be null or a finite number, got ${String(profile.endWeek)}`)
  }
  if (
    profile.startWeek !== null &&
    profile.endWeek !== null &&
    profile.endWeek < profile.startWeek
  ) {
    fail(pfx, `endWeek (${profile.endWeek}) must be >= startWeek (${profile.startWeek})`)
  }

  // Legacy — SnapshotJsonValue discriminator
  validateSnapshotJsonValue(profile.legacy, `${pfx}.legacy`)

  // Segments
  if (!Array.isArray(profile.segments)) {
    fail(pfx, 'segments must be an array')
  }

  for (let si = 0; si < profile.segments.length; si++) {
    const seg = profile.segments[si]
    const spfx = `${pfx}.segments[${si}]`
    if (typeof seg !== 'object' || seg === null) {
      fail(spfx, 'segment must be a non-null object')
    }
    validateSegment(seg, spfx, seenSegmentIds)
  }
}

function validateSegment(
  seg: SnapshotCapacitySegment,
  pfx: string,
  seenSegmentIds: Set<string>,
): void {
  // id — non-empty and globally unique
  if (typeof seg.id !== 'string' || seg.id.length === 0) {
    fail(pfx, 'segment id must be a non-empty string')
  }
  if (seenSegmentIds.has(seg.id)) {
    fail(pfx, `duplicate segment id "${seg.id}"`)
  }
  seenSegmentIds.add(seg.id)

  // startWeek/endWeek — finite numbers with end >= start
  if (!isFiniteNumber(seg.startWeek)) {
    fail(pfx, `startWeek must be a finite number, got ${String(seg.startWeek)}`)
  }
  if (!isFiniteNumber(seg.endWeek)) {
    fail(pfx, `endWeek must be a finite number, got ${String(seg.endWeek)}`)
  }
  if (seg.endWeek < seg.startWeek) {
    fail(pfx, `endWeek (${seg.endWeek}) must be >= startWeek (${seg.startWeek})`)
  }

  // capacityPercent — finite >= 0
  if (!isFiniteNumber(seg.capacityPercent) || seg.capacityPercent < 0) {
    fail(pfx, `capacityPercent must be a finite number >= 0, got ${String(seg.capacityPercent)}`)
  }

  // source — supported value
  if (!VALID_SOURCES.includes(seg.source as CapacityProfileSourceEnum)) {
    fail(pfx, `unsupported source "${String(seg.source)}"`)
  }
}

// ─── Stable ordering helpers ─────────────────────────────────────────────────

/**
 * Stable comparator for capacity profiles.
 *
 * Sort order:
 *   1. ownerKind (alphabetical — ROLE, NAMED_PERSON, PLANNED_RESOURCE)
 *   2. Owner identity:
 *      - ROLE profiles by resourceTypeId
 *      - Named-resource profiles by namedResourceId
 *   3. Profile ID (deterministic tie-breaker)
 *
 * Does NOT mutate the input arrays.
 */
export function sortSnapshotProfiles(
  profiles: SnapshotCapacityProfile[],
): SnapshotCapacityProfile[] {
  return [...profiles].sort((a, b) => {
    // 1. ownerKind
    const kindCmp = a.ownerKind.localeCompare(b.ownerKind)
    if (kindCmp !== 0) return kindCmp

    // 2. Owner identity (one of the two IDs is always set for valid profiles)
    const ownerA = a.resourceTypeId ?? a.namedResourceId ?? ''
    const ownerB = b.resourceTypeId ?? b.namedResourceId ?? ''
    const ownerCmp = ownerA.localeCompare(ownerB)
    if (ownerCmp !== 0) return ownerCmp

    // 3. Profile ID
    return a.id.localeCompare(b.id)
  })
}

/**
 * Stable comparator for capacity segments within a profile.
 *
 * Sort order:
 *   1. startWeek (ascending)
 *   2. endWeek (ascending)
 *   3. Segment ID (deterministic tie-breaker)
 *
 * Does NOT mutate the input arrays.
 */
export function sortSnapshotSegments(
  segments: SnapshotCapacitySegment[],
): SnapshotCapacitySegment[] {
  return [...segments].sort((a, b) => {
    const startCmp = a.startWeek - b.startWeek
    if (startCmp !== 0) return startCmp

    const endCmp = a.endWeek - b.endWeek
    if (endCmp !== 0) return endCmp

    return a.id.localeCompare(b.id)
  })
}
