/**
 * capacityProfileStructureValidation.ts — Single authoritative structural
 * validator for one CapacityProfile row and its segments (issue #418 PR 1
 * review round 2).
 *
 * Every consumer applies the SAME rule set through this pure helper:
 *   - production migration readiness (`validatePersistedCapacityProfiles`);
 *   - mutation loading (`ownerProfileLoader.loadAndValidateOwnerProfile`);
 *   - runtime reads (`capacityProfileResourceAdapter.buildResourceCapacityProfileMap`);
 *   - snapshot rollback retained-ownership validation;
 *   - historical v2 translation validation.
 *
 * The helper is dependency-free (no Prisma, no routes) and returns
 * human-readable errors; callers decide how to fail (throw or collect).
 */

// ─── Valid enum sets ─────────────────────────────────────────────────────────

const VALID_OWNER_KINDS: ReadonlySet<string> = new Set([
  'ROLE',
  'NAMED_PERSON',
  'PLANNED_RESOURCE',
])

const VALID_PLANNING_BASIS: ReadonlySet<string> = new Set([
  'DEMAND_FOLLOWING',
  'AVAILABILITY_WINDOW',
  'WHOLE_PROJECT_ALLOCATION',
  'CAPACITY_PROFILE',
])

const VALID_SOURCES: ReadonlySet<string> = new Set([
  'FIXED',
  'MANUAL',
  'AVAILABILITY_WINDOW',
  'SQUAD_PLANNER',
  'IMPORTED',
  'DERIVED',
  'LEGACY',
])

// ─── Input types ─────────────────────────────────────────────────────────────

export interface ProfileStructureSegment {
  id: string
  capacityProfileId?: string | null
  startWeek: number
  endWeek: number
  capacityPercent: number
  source: string
}

export interface ProfileStructureInput {
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
  segments: ReadonlyArray<ProfileStructureSegment>
}

export interface ProfileStructureContext {
  projectId: string
  resourceTypeIds: ReadonlySet<string>
  namedResourceIds: ReadonlySet<string>
}

// ─── Value helpers ───────────────────────────────────────────────────────────

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isNonNegativeInteger(value: unknown): value is number {
  return isFiniteNumber(value) && Number.isInteger(value) && value >= 0
}

// ─── The authoritative structural rule set ──────────────────────────────────

/**
 * Validate the structural fields of exactly one profile and its segments.
 * Returns a list of human-readable errors (empty when valid).
 *
 * Planning-basis-specific rules:
 *   - DEMAND_FOLLOWING: no segments; startWeek/endWeek must be null.
 *   - WHOLE_PROJECT_ALLOCATION: no segments; startWeek/endWeek must be null.
 *   - AVAILABILITY_WINDOW: no segments; nullable window allowed, start <= end.
 *   - CAPACITY_PROFILE: segments required for ROLE, NAMED_PERSON and
 *     PLANNED_RESOURCE, except the canonical segmentless zero-capacity
 *     PLANNED_RESOURCE (source SQUAD_PLANNER or MANUAL, defaultPercent 0,
 *     start/end null, no segments). Segmented CAPACITY_PROFILE profiles may
 *     carry profile-level startWeek/endWeek (min/max bounds persisted by the
 *     Squad Planner writer).
 */
export function validateProfileStructure(
  profile: ProfileStructureInput,
  context: ProfileStructureContext,
): string[] {
  const errors: string[] = []
  const p = profile

  // ── Project ownership ────────────────────────────────────────────────
  if (p.projectId !== context.projectId) {
    errors.push(`Profile ${p.id}: projectId "${p.projectId}" does not match expected "${context.projectId}"`)
  }

  // ── Exactly-one owner FK ──────────────────────────────────────────────
  const hasRt = p.resourceTypeId != null
  const hasNr = p.namedResourceId != null
  if (hasRt === hasNr) {
    errors.push(
      `Profile ${p.id}: must have exactly one owner FK (resourceTypeId XOR namedResourceId); ` +
      `got resourceTypeId=${JSON.stringify(p.resourceTypeId)}, namedResourceId=${JSON.stringify(p.namedResourceId)}`,
    )
  }

  // ── Owner-kind shape ──────────────────────────────────────────────────
  if (!VALID_OWNER_KINDS.has(p.ownerKind)) {
    errors.push(`Profile ${p.id}: invalid ownerKind "${p.ownerKind}"`)
  }
  if (p.ownerKind === 'ROLE' && !hasRt) {
    errors.push(`Profile ${p.id}: ownerKind ROLE requires resourceTypeId`)
  }
  if (p.ownerKind === 'ROLE' && hasNr) {
    errors.push(`Profile ${p.id}: ownerKind ROLE must not have namedResourceId set`)
  }
  if ((p.ownerKind === 'NAMED_PERSON' || p.ownerKind === 'PLANNED_RESOURCE') && !hasNr) {
    errors.push(`Profile ${p.id}: ownerKind ${p.ownerKind} requires namedResourceId`)
  }
  if ((p.ownerKind === 'NAMED_PERSON' || p.ownerKind === 'PLANNED_RESOURCE') && hasRt) {
    errors.push(`Profile ${p.id}: ownerKind ${p.ownerKind} must not have resourceTypeId set`)
  }

  // ── Owner belongs to the project ─────────────────────────────────────
  if (hasRt && !context.resourceTypeIds.has(p.resourceTypeId!)) {
    errors.push(`Profile ${p.id}: resourceTypeId "${p.resourceTypeId}" not found in project`)
  }
  if (hasNr && !context.namedResourceIds.has(p.namedResourceId!)) {
    errors.push(`Profile ${p.id}: namedResourceId "${p.namedResourceId}" not found in project`)
  }

  // ── Enum values ───────────────────────────────────────────────────────
  if (!VALID_PLANNING_BASIS.has(p.planningBasis)) {
    errors.push(`Profile ${p.id}: invalid planningBasis "${p.planningBasis}"`)
  }
  if (!VALID_SOURCES.has(p.source)) {
    errors.push(`Profile ${p.id}: invalid source "${p.source}"`)
  }

  // ── Percentages ───────────────────────────────────────────────────────
  if (p.defaultPercent != null) {
    if (!isFiniteNumber(p.defaultPercent) || p.defaultPercent < 0) {
      errors.push(`Profile ${p.id}: defaultPercent ${p.defaultPercent} must be finite and non-negative`)
    } else if (p.ownerKind !== 'ROLE' && p.defaultPercent > 100) {
      errors.push(`Profile ${p.id}: defaultPercent ${p.defaultPercent} must be in range [0,100] for ownerKind ${p.ownerKind}`)
    }
  }

  // ── Profile-level weeks ───────────────────────────────────────────────
  if (p.startWeek != null && !isNonNegativeInteger(p.startWeek)) {
    errors.push(`Profile ${p.id}: startWeek ${p.startWeek} must be a non-negative finite integer`)
  }
  if (p.endWeek != null && !isNonNegativeInteger(p.endWeek)) {
    errors.push(`Profile ${p.id}: endWeek ${p.endWeek} must be a non-negative finite integer`)
  }
  if (isFiniteNumber(p.startWeek) && isFiniteNumber(p.endWeek) && p.startWeek! > p.endWeek!) {
    errors.push(`Profile ${p.id}: startWeek ${p.startWeek} must not exceed endWeek ${p.endWeek}`)
  }

  // ── Planning-basis-specific structural rules ─────────────────────────
  const segments = p.segments ?? []
  if (p.planningBasis === 'DEMAND_FOLLOWING') {
    if (segments.length > 0) {
      errors.push(`Profile ${p.id}: DEMAND_FOLLOWING must not have segments`)
    }
    if (p.startWeek !== null) {
      errors.push(`Profile ${p.id}: DEMAND_FOLLOWING must not have startWeek`)
    }
    if (p.endWeek !== null) {
      errors.push(`Profile ${p.id}: DEMAND_FOLLOWING must not have endWeek`)
    }
  } else if (p.planningBasis === 'WHOLE_PROJECT_ALLOCATION') {
    if (segments.length > 0) {
      errors.push(`Profile ${p.id}: WHOLE_PROJECT_ALLOCATION must not have segments`)
    }
    if (p.startWeek !== null) {
      errors.push(`Profile ${p.id}: WHOLE_PROJECT_ALLOCATION must not have startWeek`)
    }
    if (p.endWeek !== null) {
      errors.push(`Profile ${p.id}: WHOLE_PROJECT_ALLOCATION must not have endWeek`)
    }
  } else if (p.planningBasis === 'AVAILABILITY_WINDOW') {
    if (segments.length > 0) {
      errors.push(`Profile ${p.id}: AVAILABILITY_WINDOW must not have segments`)
    }
  } else if (p.planningBasis === 'CAPACITY_PROFILE') {
    // Squad Planner apply persists profile-level startWeek/endWeek as the
    // min/max bounds of a SEGMENTED CAPACITY_PROFILE — valid authority.
    // Only a segmentless CAPACITY_PROFILE must have null windows, and that
    // state is restricted to the canonical zero-capacity PLANNED_RESOURCE.
    if (segments.length === 0) {
      const isCanonicalZeroCapacity = (
        p.ownerKind === 'PLANNED_RESOURCE' &&
        (p.source === 'SQUAD_PLANNER' || p.source === 'MANUAL') &&
        p.defaultPercent === 0 &&
        p.startWeek == null &&
        p.endWeek == null
      )
      if (isCanonicalZeroCapacity) {
        if (p.startWeek !== null) {
          errors.push(`Profile ${p.id}: CAPACITY_PROFILE must not have startWeek`)
        }
        if (p.endWeek !== null) {
          errors.push(`Profile ${p.id}: CAPACITY_PROFILE must not have endWeek`)
        }
      } else {
        errors.push(
          `Profile ${p.id}: CAPACITY_PROFILE with no segments is only valid as the ` +
          'canonical zero-capacity PLANNED_RESOURCE state',
        )
      }
    }
  }

  // ── Segment validation ────────────────────────────────────────────────
  if (segments.length > 0) {
    for (const s of segments) {
      if (s.capacityProfileId != null && s.capacityProfileId !== p.id) {
        errors.push(
          `Segment ${s.id}: capacityProfileId "${s.capacityProfileId}" ` +
          `does not match parent profile "${p.id}"`,
        )
      }
      if (!VALID_SOURCES.has(s.source)) {
        errors.push(`Segment ${s.id}: invalid source "${s.source}"`)
      }
      if (!isFiniteNumber(s.capacityPercent) || s.capacityPercent < 0) {
        errors.push(`Segment ${s.id}: capacityPercent ${s.capacityPercent} must be finite and non-negative`)
      } else if (p.ownerKind !== 'ROLE' && s.capacityPercent > 100) {
        errors.push(`Segment ${s.id}: capacityPercent ${s.capacityPercent} must be in range [0,100] for ownerKind ${p.ownerKind}`)
      }
      if (
        !isNonNegativeInteger(s.startWeek) ||
        !isNonNegativeInteger(s.endWeek) ||
        s.startWeek > s.endWeek
      ) {
        errors.push(`Segment ${s.id}: invalid week range [${s.startWeek}, ${s.endWeek}]`)
      }
    }

    // Deterministic ordering for overlap and duplicate checks
    const sorted = [...segments].sort((a, b) => a.startWeek - b.startWeek)

    const seenRanges = new Set<string>()
    for (const s of sorted) {
      const rangeKey = `${s.startWeek}-${s.endWeek}`
      if (seenRanges.has(rangeKey)) {
        errors.push(`Segment ${s.id}: duplicate segment with week range [${s.startWeek}, ${s.endWeek}]`)
      }
      seenRanges.add(rangeKey)
    }

    let priorEnd = -1
    let priorSegmentId: string | null = null
    for (const current of sorted) {
      if (current.startWeek <= priorEnd) {
        errors.push(
          `Segment ${current.id}: segment (W${current.startWeek}-W${current.endWeek}) ` +
          `overlaps with previous segment "${priorSegmentId}" (ending W${priorEnd})`,
        )
      }
      if (current.endWeek > priorEnd) {
        priorEnd = current.endWeek
        priorSegmentId = current.id
      }
    }
  }

  return errors
}
