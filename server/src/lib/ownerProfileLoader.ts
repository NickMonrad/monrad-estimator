/**
 * ownerProfileLoader.ts — Focused transaction-level loader and validator
 * for a single expected authoritative CapacityProfile owner.
 *
 * Normal runtime routes use this helper to load and validate exactly one
 * expected owner profile before any mutation. It fails closed with a
 * CapacityIntegrityError when persisted state is missing, malformed,
 * ambiguous, cross-project, or wrong-owner-kind.
 *
 * @see docs/domain/capacity-profile-source-of-truth-migration-plan.md
 */

import { CapacityIntegrityError } from './capacityIntegrityError.js'

// ─── Accepted enum sets ──────────────────────────────────────────────────────

const VALID_PLANNING_BASIS = new Set([
  'DEMAND_FOLLOWING',
  'AVAILABILITY_WINDOW',
  'WHOLE_PROJECT_ALLOCATION',
  'CAPACITY_PROFILE',
])

const VALID_SOURCES = new Set([
  'FIXED',
  'MANUAL',
  'AVAILABILITY_WINDOW',
  'SQUAD_PLANNER',
  'IMPORTED',
  'DERIVED',
  'LEGACY',
])

const VALID_OWNER_KINDS = new Set(['ROLE', 'NAMED_PERSON', 'PLANNED_RESOURCE'])

// ─── Input ───────────────────────────────────────────────────────────────────

export interface OwnerProfileQuery {
  tx: any
  projectId: string
  /** Expected owner kind: 'ROLE' for RT-owned, 'NAMED_PERSON' or 'PLANNED_RESOURCE' for NR-owned. */
  ownerKind: string
  /** ResourceType ID (for ROLE) or NamedResource ID (for NAMED_PERSON/PLANNED_RESOURCE). */
  ownerId: string
  /** Whether segments must be non-empty (default false). */
  requireSegments?: boolean
  /** Include segment rows in the returned result (default true). */
  includeSegments?: boolean
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

function isPositivePercent(v: unknown): v is number {
  return isFiniteNumber(v) && v > 0 && v <= 100
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
  const { tx, projectId, ownerKind, ownerId, requireSegments = false, includeSegments = true } = query

  // ── 1. Build entity-appropriate where ──────────────────────────────
  const where: Record<string, unknown> = { projectId }

  if (ownerKind === 'ROLE') {
    where.resourceTypeId = ownerId
    where.namedResourceId = null
  } else {
    where.namedResourceId = ownerId
    where.resourceTypeId = null
  }

  const profiles: any[] = includeSegments
    ? await tx.capacityProfile.findMany({ where, include: { segments: true } })
    : await tx.capacityProfile.findMany({ where })

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

  if (!VALID_OWNER_KINDS.has(profile.ownerKind)) {
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
    if (profile.ownerKind !== 'NAMED_PERSON' && profile.ownerKind !== 'PLANNED_RESOURCE') {
      throw new CapacityIntegrityError(
        `Expected NAMED_PERSON/PLANNED_RESOURCE capacity profile for named resource ${ownerId} but found "${profile.ownerKind}" kind.`,
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
  if (!VALID_PLANNING_BASIS.has(profile.planningBasis)) {
    throw new CapacityIntegrityError(
      `Capacity profile ${profile.id} has invalid planning basis "${profile.planningBasis}". ` +
      'Run the capacity profile backfill/repair workflow before retrying this operation.',
    )
  }

  if (!VALID_SOURCES.has(profile.source)) {
    throw new CapacityIntegrityError(
      `Capacity profile ${profile.id} has invalid source "${profile.source}". ` +
      'Run the capacity profile backfill/repair workflow before retrying this operation.',
    )
  }

  // ── 5. Default percent ────────────────────────────────────────────
  if (profile.defaultPercent !== null && !isPositivePercent(profile.defaultPercent)) {
    throw new CapacityIntegrityError(
      `Capacity profile ${profile.id} has invalid defaultPercent "${profile.defaultPercent}".`,
    )
  }

  // ── 6. Window validation ───────────────────────────────────────────
  if (profile.startWeek !== null && !isNonNegativeInteger(profile.startWeek)) {
    throw new CapacityIntegrityError(
      `Capacity profile ${profile.id} has non-integer startWeek "${profile.startWeek}".`,
    )
  }
  if (profile.endWeek !== null && !isNonNegativeInteger(profile.endWeek)) {
    throw new CapacityIntegrityError(
      `Capacity profile ${profile.id} has non-integer endWeek "${profile.endWeek}".`,
    )
  }
  if (profile.startWeek !== null && profile.endWeek !== null && profile.startWeek > profile.endWeek) {
    throw new CapacityIntegrityError(
      `Capacity profile ${profile.id} has startWeek ${profile.startWeek} after endWeek ${profile.endWeek}.`,
    )
  }

  // ── 7. Segments ────────────────────────────────────────────────────
  const segments: ValidatedSegment[] = (profile.segments ?? []).map((seg: any) => {
    if (!seg.id || !seg.capacityProfileId) {
      throw new CapacityIntegrityError(
        `Capacity profile ${profile.id} has a segment missing required id or capacityProfileId.`,
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
    if (!isPositivePercent(seg.capacityPercent)) {
      throw new CapacityIntegrityError(
        `Capacity profile ${profile.id} segment ${seg.id} has invalid capacityPercent "${seg.capacityPercent}".`,
      )
    }
    if (!VALID_SOURCES.has(seg.source)) {
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

  // ── 8. Overlap check ──────────────────────────────────────────────
  if (segments.length > 1) {
    const sorted = [...segments].sort((a, b) => a.startWeek - b.startWeek)
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i].startWeek <= sorted[i - 1].endWeek) {
        throw new CapacityIntegrityError(
          `Capacity profile ${profile.id} has overlapping segments: ` +
          `segment "${sorted[i - 1].id}" (W${sorted[i - 1].startWeek}-W${sorted[i - 1].endWeek}) ` +
          `overlaps with "${sorted[i].id}" (W${sorted[i].startWeek}-W${sorted[i].endWeek}).`,
        )
      }
    }
  }

  if (requireSegments && segments.length === 0) {
    throw new CapacityIntegrityError(
      `Capacity profile ${profile.id} has no segments but segments are required.`,
    )
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
    startWeek: profile.startWeek,
    endWeek: profile.endWeek,
    segments,
  }
}
