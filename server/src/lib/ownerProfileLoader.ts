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
import { validateProfileStructure } from './capacityProfileStructureValidation.js'

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

// ─── Valid owner kinds ────────────────────────────────────────────────────

const VALID_OWNER_KINDS: Record<string, true> = {
  ROLE: true,
  NAMED_PERSON: true,
  PLANNED_RESOURCE: true,
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

  // ── 4. Structural rules — single authoritative validator ─────────
  // Every consumer (readiness, runtime reads, retained rollback validation,
  // v2 translation) applies the same planning-basis-specific rule set.
  const structuralErrors = validateProfileStructure(
    {
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
      segments: (profile.segments ?? []).map((seg: any) => ({
        id: seg.id,
        capacityProfileId: seg.capacityProfileId ?? null,
        startWeek: seg.startWeek,
        endWeek: seg.endWeek,
        capacityPercent: seg.capacityPercent,
        source: seg.source,
      })),
    },
    {
      projectId,
      resourceTypeIds: new Set(ownerKind === 'ROLE' ? [ownerId] : []),
      namedResourceIds: new Set(ownerKind === 'ROLE' ? [] : [ownerId]),
    },
  )
  if (structuralErrors.length > 0) {
    throw new CapacityIntegrityError(
      `Capacity profile ${profile.id} is structurally invalid: ${structuralErrors.join('; ')}. ` +
      'Run the capacity profile audit/repair workflow before retrying this operation.',
    )
  }

  const startWeek: number | null = profile.startWeek ?? null
  const endWeek: number | null = profile.endWeek ?? null
  const segments: ValidatedSegment[] = (profile.segments ?? []).map((seg: any) => ({
    id: seg.id,
    capacityProfileId: seg.capacityProfileId,
    startWeek: seg.startWeek,
    endWeek: seg.endWeek,
    capacityPercent: seg.capacityPercent,
    source: seg.source,
  }))

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
