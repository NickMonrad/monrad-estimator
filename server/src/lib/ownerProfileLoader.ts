/**
 * ownerProfileLoader.ts — Focused transaction-level loader and validator
 * for a single expected authoritative CapacityProfile owner.
 *
 * Normal runtime routes use this helper to load and validate exactly one
 * expected owner profile before any mutation. It fails closed with a
 * CapacityIntegrityError when persisted state is missing, malformed,
 * ambiguous, cross-project, or wrong-owner-kind.
 *
 * Validation rules are kept in sync with capacityProfileReplaceValidator.ts.
 *
 * @see docs/domain/capacity-profile-source-of-truth-migration-plan.md
 */

import { CapacityIntegrityError } from './capacityIntegrityError.js'

// ─── Accepted enum sets ──────────────────────────────────────────────────────

const VALID_PLANNING_BASIS: Record<string, true> = {
  DEMAND_FOLLOWING: true,
  AVAILABILITY_WINDOW: true,
  WHOLE_PROJECT_ALLOCATION: true,
  CAPACITY_PROFILE: true,
}

const VALID_SOURCES: Record<string, true> = {
  FIXED: true,
  MANUAL: true,
  AVAILABILITY_WINDOW: true,
  SQUAD_PLANNER: true,
  IMPORTED: true,
  DERIVED: true,
  LEGACY: true,
}

const VALID_OWNER_KINDS: Record<string, true> = {
  ROLE: true,
  NAMED_PERSON: true,
  PLANNED_RESOURCE: true,
}

// ─── Input ───────────────────────────────────────────────────────────────────

export interface OwnerProfileQuery {
  tx: any
  projectId: string
  /** Expected owner kind. */
  ownerKind: string
  /** ResourceType ID (for ROLE) or NamedResource ID (for NAMED_PERSON/PLANNED_RESOURCE). */
  ownerId: string
}

export interface ValidatedOwnerProfile {
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
  segments: ValidatedSegment[]
}

export interface ValidatedSegment {
  id: string
  capacityProfileId: string
  startWeek: number
  endWeek: number
  capacityPercent: number
  source: string
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

function isNonNegativeInteger(v: unknown): v is number {
  return isFiniteNumber(v) && Number.isInteger(v) && v >= 0
}

// ─── Main loader ─────────────────────────────────────────────────────────────

/**
 * Load and validate exactly one expected authoritative owner profile.
 *
 * Throws CapacityIntegrityError when the owner is missing, duplicated,
 * malformed, cross-project, or wrong-owner-kind.
 * Returns the validated profile with segments.
 */
export async function loadAndValidateOwnerProfile(
  query: OwnerProfileQuery,
): Promise<ValidatedOwnerProfile> {
  const { tx, projectId, ownerKind, ownerId } = query
  // ── 1. Build entity-appropriate where ──────────────────────────────
  const where: Record<string, unknown> = { projectId }

  if (ownerKind === 'ROLE') {
    where.resourceTypeId = ownerId
    where.namedResourceId = null
  } else {
    where.namedResourceId = ownerId
    where.resourceTypeId = null
  }

  const profiles: any[] = await tx.capacityProfile.findMany({
    where,
    include: { segments: true },
  })

  // ── 2. Count check ─────────────────────────────────────────────────
  if (profiles.length === 0) {
    const ownerLabel = ownerKind === 'ROLE' ? `resource type ${ownerId}` : `named resource ${ownerId}`
    throw new CapacityIntegrityError(
      `Missing capacity profile for ${ownerLabel}. ` +
      'Run the capacity profile backfill/repair workflow before retrying this operation.',
    )
  }

  if (profiles.length > 1) {
    const ownerLabel = ownerKind === 'ROLE' ? `resource type ${ownerId}` : `named resource ${ownerId}`
    throw new CapacityIntegrityError(
      `Multiple capacity profiles exist for ${ownerLabel}. ` +
      'Run the capacity profile backfill/repair workflow before retrying this operation.',
    )
  }

  const profile = profiles[0]

  // ── 3. Project / owner-kind / FK validation ────────────────────────
  if (profile.projectId !== projectId) {
    throw new CapacityIntegrityError(
      `Capacity profile ${profile.id} belongs to a different project. ` +
      'Run the capacity profile audit/repair workflow before retrying this operation.',
    )
  }

  if (!VALID_OWNER_KINDS[profile.ownerKind]) {
    throw new CapacityIntegrityError(
      `Capacity profile ${profile.id} has invalid owner kind "${profile.ownerKind}". ` +
      'Run the capacity profile backfill/repair workflow before retrying this operation.',
    )
  }

  if (ownerKind === 'ROLE') {
    if (profile.ownerKind !== 'ROLE') {
      throw new CapacityIntegrityError(
        `Expected ROLE capacity profile for resource type ${ownerId} but found "${profile.ownerKind}" kind. ` +
        'Run the capacity profile audit/repair workflow before retrying this operation.',
      )
    }
    if (profile.resourceTypeId !== ownerId) {
      throw new CapacityIntegrityError(
        `Capacity profile ${profile.id} has wrong resourceTypeId "${profile.resourceTypeId}" expected "${ownerId}".`,
      )
    }
    if (profile.namedResourceId !== null) {
      throw new CapacityIntegrityError(
        `Capacity profile ${profile.id} has unexpected namedResourceId "${profile.namedResourceId}" for ROLE owner.`,
      )
    }
  } else {
    if (profile.ownerKind !== ownerKind) {
      throw new CapacityIntegrityError(
        `Expected ${ownerKind} capacity profile for named resource ${ownerId} but found "${profile.ownerKind}" kind. ` +
        'Run the capacity profile audit/repair workflow before retrying this operation.',
      )
    }
    if (profile.namedResourceId !== ownerId) {
      throw new CapacityIntegrityError(
        `Capacity profile ${profile.id} has wrong namedResourceId "${profile.namedResourceId}" expected "${ownerId}".`,
      )
    }
    if (profile.resourceTypeId !== null) {
      throw new CapacityIntegrityError(
        `Capacity profile ${profile.id} has unexpected resourceTypeId "${profile.resourceTypeId}" for NR-owned profile.`,
      )
    }
  }

  // ── 4. Planning basis and source ───────────────────────────────────
  if (!VALID_PLANNING_BASIS[profile.planningBasis]) {
    throw new CapacityIntegrityError(
      `Capacity profile ${profile.id} has invalid planning basis "${profile.planningBasis}".`,
    )
  }

  if (!VALID_SOURCES[profile.source]) {
    throw new CapacityIntegrityError(
      `Capacity profile ${profile.id} has invalid source "${profile.source}".`,
    )
  }

  // ── 5. Default percent ─────────────────────────────────────────────
  if (profile.defaultPercent !== null) {
    if (!isFiniteNumber(profile.defaultPercent) || profile.defaultPercent < 0) {
      throw new CapacityIntegrityError(
        `Capacity profile ${profile.id} has invalid defaultPercent "${profile.defaultPercent}".`,
      )
    }
    if (ownerKind !== 'ROLE' && profile.defaultPercent > 100) {
      throw new CapacityIntegrityError(
        `Capacity profile ${profile.id} has defaultPercent "${profile.defaultPercent}" > 100 for ${ownerKind}.`,
      )
    }
  }

  const startWeek: number | null = profile.startWeek ?? null
  const endWeek: number | null = profile.endWeek ?? null

  if (startWeek !== null && !isNonNegativeInteger(startWeek)) {
    throw new CapacityIntegrityError(
      `Capacity profile ${profile.id} has non-integer startWeek "${profile.startWeek}".`,
    )
  }
  if (endWeek !== null && !isNonNegativeInteger(endWeek)) {
    throw new CapacityIntegrityError(
      `Capacity profile ${profile.id} has non-integer endWeek "${profile.endWeek}".`,
    )
  }
  if (startWeek !== null && endWeek !== null && startWeek > endWeek) {
    throw new CapacityIntegrityError(
      `Capacity profile ${profile.id} has startWeek ${startWeek} after endWeek ${endWeek}.`,
    )
  }

  // ── 7. Planning-basis-specific structural validation ───────────────
  const planningBasis = profile.planningBasis
  const segmentsRaw: any[] = profile.segments ?? []

  if (planningBasis === 'DEMAND_FOLLOWING') {
    if (segmentsRaw.length > 0) {
      throw new CapacityIntegrityError(
        `DEMAND_FOLLOWING profile ${profile.id} must not have segments.`,
      )
    }
    if (startWeek !== null) {
      throw new CapacityIntegrityError(
        `DEMAND_FOLLOWING profile ${profile.id} must not have startWeek.`,
      )
    }
    if (endWeek !== null) {
      throw new CapacityIntegrityError(
        `DEMAND_FOLLOWING profile ${profile.id} must not have endWeek.`,
      )
    }
  } else if (planningBasis === 'WHOLE_PROJECT_ALLOCATION') {
    if (segmentsRaw.length > 0) {
      throw new CapacityIntegrityError(
        `WHOLE_PROJECT_ALLOCATION profile ${profile.id} must not have segments.`,
      )
    }
    if (startWeek !== null) {
      throw new CapacityIntegrityError(
        `WHOLE_PROJECT_ALLOCATION profile ${profile.id} must not have startWeek.`,
      )
    }
    if (endWeek !== null) {
      throw new CapacityIntegrityError(
        `WHOLE_PROJECT_ALLOCATION profile ${profile.id} must not have endWeek.`,
      )
    }
  } else if (planningBasis === 'AVAILABILITY_WINDOW') {
    if (segmentsRaw.length > 0) {
      throw new CapacityIntegrityError(
        `AVAILABILITY_WINDOW profile ${profile.id} must not have segments.`,
      )
    }
  } else if (planningBasis === 'CAPACITY_PROFILE') {
    if (startWeek !== null) {
      throw new CapacityIntegrityError(
        `CAPACITY_PROFILE profile ${profile.id} must not have startWeek.`,
      )
    }
    if (endWeek !== null) {
      throw new CapacityIntegrityError(
        `CAPACITY_PROFILE profile ${profile.id} must not have endWeek.`,
      )
    }
  }

  // ── 8. Segment validation ──────────────────────────────────────────
  const segments: ValidatedSegment[] = segmentsRaw.map((seg: any, idx: number) => {
    if (!seg.id || !seg.capacityProfileId) {
      throw new CapacityIntegrityError(
        `Capacity profile ${profile.id} has a segment (index ${idx}) missing required id or capacityProfileId.`,
      )
    }

    if (!isNonNegativeInteger(seg.startWeek)) {
      throw new CapacityIntegrityError(
        `Capacity profile ${profile.id} segment ${seg.id} has invalid startWeek "${seg.startWeek}".`,
      )
    }
    if (!isNonNegativeInteger(seg.endWeek)) {
      throw new CapacityIntegrityError(
        `Capacity profile ${profile.id} segment ${seg.id} has invalid endWeek "${seg.endWeek}".`,
      )
    }
    if (seg.startWeek > seg.endWeek) {
      throw new CapacityIntegrityError(
        `Capacity profile ${profile.id} segment ${seg.id} has startWeek ${seg.startWeek} after endWeek ${seg.endWeek}.`,
      )
    }

    // capacityPercent: finite non-negative; non-ROLE max 100
    if (!isFiniteNumber(seg.capacityPercent) || seg.capacityPercent < 0) {
      throw new CapacityIntegrityError(
        `Capacity profile ${profile.id} segment ${seg.id} has invalid capacityPercent "${seg.capacityPercent}".`,
      )
    }
    if (ownerKind !== 'ROLE' && seg.capacityPercent > 100) {
      throw new CapacityIntegrityError(
        `Capacity profile ${profile.id} segment ${seg.id} has capacityPercent ${seg.capacityPercent} > 100 for ${ownerKind}.`,
      )
    }

    if (!VALID_SOURCES[seg.source]) {
      throw new CapacityIntegrityError(
        `Capacity profile ${profile.id} segment ${seg.id} has invalid source "${seg.source}".`,
      )
    }

    return {
      id: seg.id,
      capacityProfileId: seg.capacityProfileId,
      startWeek: seg.startWeek,
      endWeek: seg.endWeek,
      capacityPercent: seg.capacityPercent,
      source: seg.source,
    }
  })

  // ── 9. Overlap and duplicate detection (inclusive overlap) ─────────
  if (segments.length >= 2) {
    const sorted = [...segments].sort((a, b) => a.startWeek - b.startWeek || a.endWeek - b.endWeek)

    const seenRanges = new Set<string>()
    let priorEnd = -1

    for (const seg of sorted) {
      const rangeKey = `${seg.startWeek}-${seg.endWeek}`
      if (seenRanges.has(rangeKey)) {
        throw new CapacityIntegrityError(
          `Capacity profile ${profile.id} segment ${seg.id}: duplicate range [${seg.startWeek}, ${seg.endWeek}].`,
        )
      }
      seenRanges.add(rangeKey)

      if (seg.startWeek <= priorEnd) {
        throw new CapacityIntegrityError(
          `Capacity profile ${profile.id} segment ${seg.id} (W${seg.startWeek}-W${seg.endWeek}) overlaps with prior segment ending W${priorEnd}.`,
        )
      }
      if (seg.endWeek > priorEnd) {
        priorEnd = seg.endWeek
      }
    }
  }

  // CAPACITY_PROFILE intrinsically requires at least one segment,
  // except for the canonical zero-capacity PLANNED_RESOURCE state.
  // Squad Planner intentionally persists surplus resources with
  // planningBasis=CAPACITY_PROFILE, defaultPercent=0, source=SQUAD_PLANNER,
  // null windows, and zero segments.
  // After transfer to manual, the equivalent state with source=MANUAL
  // is also valid (issue #411).
  if (planningBasis === 'CAPACITY_PROFILE' && segments.length === 0) {
    const isCanonicalZero = (
      ownerKind === 'PLANNED_RESOURCE' &&
      (profile.source === 'SQUAD_PLANNER' || profile.source === 'MANUAL') &&
      profile.defaultPercent === 0 &&
      startWeek === null &&
      endWeek === null
    )
    if (!isCanonicalZero) {
      throw new CapacityIntegrityError(
        `CAPACITY_PROFILE profile ${profile.id} has no segments but segments are required.`,
      )
    }
  }

  return {
    id: profile.id,
    projectId: profile.projectId,
    resourceTypeId: profile.resourceTypeId ?? null,
    namedResourceId: profile.namedResourceId ?? null,
    ownerKind: profile.ownerKind,
    planningBasis: profile.planningBasis,
    source: profile.source,
    defaultPercent: profile.defaultPercent,
    startWeek,
    endWeek,
    segments,
  }
}
