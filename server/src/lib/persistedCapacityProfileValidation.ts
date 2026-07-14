/**
 * persistedCapacityProfileValidation.ts — Structural validator for persisted
 * CapacityProfile/CapacitySegment rows.
 *
 * Checks structural integrity only (not semantic correctness against a legacy
 * mapper). A valid persisted set is returned as-authority by the GET
 * capacity-profiles route — no reconciliation against the lossy mapper.
 */

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ValidationContext {
  projectId: string
  resourceTypeIds: ReadonlySet<string>
  namedResourceIds: ReadonlySet<string>
}

export interface ValidationResult {
  valid: boolean
  errors: string[]
}

// ─── Valid enum sets ────────────────────────────────────────────────────────

const VALID_OWNER_KINDS: Record<string, true> = {
  ROLE: true,
  NAMED_PERSON: true,
  PLANNED_RESOURCE: true,
}

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


function isFiniteNumber(value: number | null): value is number {
  return value != null && Number.isFinite(value)
}

// ─── Core validator ─────────────────────────────────────────────────────────

export function validatePersistedCapacityProfiles(
  profiles: ReadonlyArray<{
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
    segments: ReadonlyArray<{
      id: string
      capacityProfileId?: string | null
      startWeek: number
      endWeek: number
      capacityPercent: number
      source: string
    }>
  }>,
  context: ValidationContext,
): ValidationResult {
  const errors: string[] = []

  // Track (ownerKind, ownerId) keys to detect duplicates
  const ownerKeys = new Map<string, string>() // key → first profile id

  for (const p of profiles) {
    // ── projectId check ────────────────────────────────────────────────
    if (p.projectId !== context.projectId) {
      errors.push(`Profile ${p.id}: projectId "${p.projectId}" does not match expected "${context.projectId}"`)
    }

    // ── Exactly-one owner FK ──────────────────────────────────────────
    const hasRt = p.resourceTypeId != null
    const hasNr = p.namedResourceId != null
    if (hasRt === hasNr) {
      errors.push(
        `Profile ${p.id}: must have exactly one owner FK (resourceTypeId XOR namedResourceId); ` +
        `got resourceTypeId=${JSON.stringify(p.resourceTypeId)}, namedResourceId=${JSON.stringify(p.namedResourceId)}`,
      )
    }

    // ── Owner-kind shape ──────────────────────────────────────────────
    if (!(p.ownerKind in VALID_OWNER_KINDS)) {
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

    // ── Owner belongs to requested project (no orphan owner) ───────────
    if (hasRt && !context.resourceTypeIds.has(p.resourceTypeId!)) {
      errors.push(`Profile ${p.id}: resourceTypeId "${p.resourceTypeId}" not found in project`)
    }
    if (hasNr && !context.namedResourceIds.has(p.namedResourceId!)) {
      errors.push(`Profile ${p.id}: namedResourceId "${p.namedResourceId}" not found in project`)
    }

    // ── Valid profile enum values ──────────────────────────────────────
    if (!(p.planningBasis in VALID_PLANNING_BASIS)) {
      errors.push(`Profile ${p.id}: invalid planningBasis "${p.planningBasis}"`)
    }
    if (!(p.source in VALID_SOURCES)) {
      errors.push(`Profile ${p.id}: invalid source "${p.source}"`)
    }
    // ── Numeric profile fields ──────────────────────────────────────────
    if (p.defaultPercent != null && (!isFiniteNumber(p.defaultPercent) || p.defaultPercent < 0 || p.defaultPercent > 100)) {
      errors.push(`Profile ${p.id}: defaultPercent ${p.defaultPercent} must be finite and in range [0,100]`)
    }
    if ((p.startWeek != null && !isFiniteNumber(p.startWeek)) || (p.endWeek != null && !isFiniteNumber(p.endWeek))) {
      errors.push(`Profile ${p.id}: startWeek/endWeek must be finite when present`)
    }
    if (isFiniteNumber(p.startWeek) && isFiniteNumber(p.endWeek) && p.startWeek > p.endWeek) {
      errors.push(`Profile ${p.id}: startWeek ${p.startWeek} must not exceed endWeek ${p.endWeek}`)
    }


    // ── No duplicate owner keys ────────────────────────────────────────
    const ownerId = p.resourceTypeId ?? p.namedResourceId ?? ''
    const key = `${p.ownerKind}::${ownerId}`
    if (ownerKeys.has(key)) {
      errors.push(
        `Profile ${p.id}: duplicate owner key "${key}" ` +
        `(first occurrence in profile ${ownerKeys.get(key)})`,
      )
    } else {
      ownerKeys.set(key, p.id)
    }

    // ── Segment validation ─────────────────────────────────────────────
    if (p.segments && p.segments.length > 0) {
      for (const s of p.segments) {
        // Segments belong to parent profile (belt-and-suspenders with Prisma FK)
        if (s.capacityProfileId != null && s.capacityProfileId !== p.id) {
          errors.push(
            `Segment ${s.id}: capacityProfileId "${s.capacityProfileId}" ` +
            `does not match parent profile "${p.id}"`,
          )
        }

        // Valid segment source
        if (!(s.source in VALID_SOURCES)) {
          errors.push(`Segment ${s.id}: invalid source "${s.source}"`)
        }

        // Finite capacity and non-negative, ordered range
        if (
          !Number.isFinite(s.capacityPercent) ||
          s.capacityPercent < 0 ||
          s.capacityPercent > 100
        ) {
          errors.push(`Segment ${s.id}: capacityPercent ${s.capacityPercent} out of range [0,100]`)
        }

        if (
          !Number.isFinite(s.startWeek) ||
          !Number.isFinite(s.endWeek) ||
          s.startWeek < 0 ||
          s.endWeek < 0 ||
          s.startWeek > s.endWeek
        ) {
          errors.push(`Segment ${s.id}: invalid week range [${s.startWeek}, ${s.endWeek}]`)
        }
      }

      // Non-overlapping: segments must not overlap when sorted by startWeek
      const sorted = [...p.segments].sort((a, b) => a.startWeek - b.startWeek)
      for (let i = 1; i < sorted.length; i++) {
        if (sorted[i].startWeek < sorted[i - 1].endWeek) {
          errors.push(
            `Profile ${p.id}: segment "${sorted[i].id}" (W${sorted[i].startWeek}-W${sorted[i].endWeek}) ` +
            `overlaps with previous segment "${sorted[i - 1].id}" (W${sorted[i - 1].startWeek}-W${sorted[i - 1].endWeek})`,
          )
        }
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  }
}
