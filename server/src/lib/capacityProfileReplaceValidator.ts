/**
 * capacityProfileReplaceValidator.ts — Pure validation for
 * ReplaceCapacityProfileRequest bodies.
 *
 * This validator checks structural and semantic rules for a single
 * capacity-profile PUT request before the service layer runs.
 *
 * @see issue #363 — Capacity profile segment editor
 */

// ─── Public types ────────────────────────────────────────────────────────────

export type ReplaceCapacityProfileOwnerKind = 'ROLE' | 'NAMED_PERSON'

export interface ReplaceCapacityProfileSegment {
  startWeek: number
  endWeek: number
  capacityPercent: number
}

export interface ReplaceCapacityProfileRequest {
  planningBasis: string
  defaultPercent?: number | null
  startWeek?: number | null
  endWeek?: number | null
  segments?: ReplaceCapacityProfileSegment[]
}

// ─── Valid planning basis values ─────────────────────────────────────────────

const VALID_PLANNING_BASIS: Record<string, true> = {
  DEMAND_FOLLOWING: true,
  AVAILABILITY_WINDOW: true,
  WHOLE_PROJECT_ALLOCATION: true,
  CAPACITY_PROFILE: true,
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value)
}

// ─── Core validator ──────────────────────────────────────────────────────────

/**
 * Validate a ReplaceCapacityProfileRequest body against structural and
 * semantic rules for the given ownerKind.
 *
 * @param body      The parsed request body (assumed to be a plain object).
 * @param ownerKind Owner kind the profile will be created for.
 * @returns         Array of validation error messages (empty = valid).
 */
export function validateReplaceCapacityProfileRequest(
  body: unknown,
  ownerKind: ReplaceCapacityProfileOwnerKind,
): string[] {
  const errors: string[] = []

  // ── Enforce object shape ───────────────────────────────────────────────
  if (!body || typeof body !== 'object') {
    errors.push('Request body must be a JSON object')
    return errors
  }

  const req = body as Record<string, unknown>

  // ── planningBasis ──────────────────────────────────────────────────────
  if (typeof req.planningBasis !== 'string' || !(req.planningBasis in VALID_PLANNING_BASIS)) {
    errors.push(
      `planningBasis must be one of: ${Object.keys(VALID_PLANNING_BASIS).join(', ')}`,
    )
    return errors  // No further validation makes sense
  }

  const planningBasis = req.planningBasis as string

  // ── defaultPercent ─────────────────────────────────────────────────────
  if (req.defaultPercent !== undefined && req.defaultPercent !== null) {
    if (!isFiniteNumber(req.defaultPercent) || req.defaultPercent < 0) {
      errors.push('defaultPercent must be a finite non-negative number')
    } else if (ownerKind !== 'ROLE' && req.defaultPercent > 100) {
      errors.push(`defaultPercent must be in range [0, 100] for ${ownerKind} profiles`)
    }
  }

  // ── startWeek / endWeek (profile-level) ────────────────────────────────
  const startWeek = req.startWeek !== undefined ? req.startWeek : null
  const endWeek = req.endWeek !== undefined ? req.endWeek : null


  // Validate numeric shape if present
  if (startWeek !== null) {
    if (!isFiniteNumber(startWeek) || !isInteger(startWeek) || (startWeek as number) < 0) {
      errors.push('startWeek must be a non-negative integer or null')
    }
  }
  if (endWeek !== null) {
    if (!isFiniteNumber(endWeek) || !isInteger(endWeek) || (endWeek as number) < 0) {
      errors.push('endWeek must be a non-negative integer or null')
    }
  }
  if (
    startWeek !== null &&
    endWeek !== null &&
    isFiniteNumber(startWeek) &&
    isFiniteNumber(endWeek) &&
    (startWeek as number) > (endWeek as number)
  ) {
    errors.push('startWeek must not exceed endWeek')
  }

  // ── Planning-basis-specific rules ──────────────────────────────────────
  const segmentsRaw = req.segments !== undefined ? req.segments : []

  if (planningBasis === 'DEMAND_FOLLOWING') {
    // No segments, no startWeek/endWeek
    if (segmentsRaw !== null && segmentsRaw !== undefined && Array.isArray(segmentsRaw) && segmentsRaw.length > 0) {
      errors.push('DEMAND_FOLLOWING profiles must not have segments')
    }
    if (startWeek !== null) {
      errors.push('DEMAND_FOLLOWING profiles must not have startWeek')
    }
    if (endWeek !== null) {
      errors.push('DEMAND_FOLLOWING profiles must not have endWeek')
    }
  } else if (planningBasis === 'WHOLE_PROJECT_ALLOCATION') {
    // No segments, no startWeek/endWeek
    if (segmentsRaw !== null && segmentsRaw !== undefined && Array.isArray(segmentsRaw) && segmentsRaw.length > 0) {
      errors.push('WHOLE_PROJECT_ALLOCATION profiles must not have segments')
    }
    if (startWeek !== null) {
      errors.push('WHOLE_PROJECT_ALLOCATION profiles must not have startWeek')
    }
    if (endWeek !== null) {
      errors.push('WHOLE_PROJECT_ALLOCATION profiles must not have endWeek')
    }
  } else if (planningBasis === 'AVAILABILITY_WINDOW') {
    // No segments, startWeek/endWeek nullable but preserved exactly
    if (segmentsRaw !== null && segmentsRaw !== undefined && Array.isArray(segmentsRaw) && segmentsRaw.length > 0) {
      errors.push('AVAILABILITY_WINDOW profiles must not have segments')
    }
  } else if (planningBasis === 'CAPACITY_PROFILE') {
    // At least 1 segment, startWeek AND endWeek must be null
    if (!Array.isArray(segmentsRaw) || segmentsRaw.length === 0) {
      errors.push('CAPACITY_PROFILE profiles must have at least one segment')
    }
    if (startWeek !== null) {
      errors.push('CAPACITY_PROFILE profiles must not have startWeek')
    }
    if (endWeek !== null) {
      errors.push('CAPACITY_PROFILE profiles must not have endWeek')
    }
  }

  // ── Segment validation ─────────────────────────────────────────────────
  if (Array.isArray(segmentsRaw) && segmentsRaw.length > 0) {
    const segments = segmentsRaw as unknown[]

    for (let i = 0; i < segments.length; i++) {
      const s = segments[i]
      const idx = i + 1

      if (!s || typeof s !== 'object') {
        errors.push(`Segment ${idx} must be an object`)
        continue
      }

      const seg = s as Record<string, unknown>
      const segLabels: string[] = []

      // startWeek
      if (!isFiniteNumber(seg.startWeek) || !isInteger(seg.startWeek) || (seg.startWeek as number) < 0) {
        segLabels.push('startWeek must be a non-negative integer')
      }

      // endWeek
      if (!isFiniteNumber(seg.endWeek) || !isInteger(seg.endWeek) || (seg.endWeek as number) < 0) {
        segLabels.push('endWeek must be a non-negative integer')
      }

      // startWeek <= endWeek
      if (
        isFiniteNumber(seg.startWeek) &&
        isFiniteNumber(seg.endWeek) &&
        (seg.startWeek as number) > (seg.endWeek as number)
      ) {
        segLabels.push('startWeek must not exceed endWeek')
      }

      // capacityPercent
      if (
        !isFiniteNumber(seg.capacityPercent) ||
        (seg.capacityPercent as number) < 0
      ) {
        segLabels.push('capacityPercent must be a finite non-negative number')
      } else if (
        ownerKind !== 'ROLE' &&
        (seg.capacityPercent as number) > 100
      ) {
        segLabels.push('capacityPercent must be at most 100 for NAMED_PERSON')
      }
      if (segLabels.length > 0) {
        errors.push(`Segment ${idx}: ${segLabels.join('; ')}`)
      }
    }

    // ── Overlap and duplicate detection ─────────────────────────────────
    // Parse valid segments into typed objects
    const typedSegments: Array<{
      index: number
      startWeek: number
      endWeek: number
      capacityPercent: number
    }> = []

    for (let i = 0; i < segments.length; i++) {
      const s = segments[i] as Record<string, unknown>
      if (
        s &&
        typeof s === 'object' &&
        isFiniteNumber(s.startWeek) &&
        isFiniteNumber(s.endWeek) &&
        isFiniteNumber(s.capacityPercent)
      ) {
        typedSegments.push({
          index: i + 1,
          startWeek: s.startWeek as number,
          endWeek: s.endWeek as number,
          capacityPercent: s.capacityPercent as number,
        })
      }
    }

    if (typedSegments.length >= 2) {
      // Sort by startWeek asc, endWeek asc, capacityPercent asc
      const sorted = [...typedSegments].sort((a, b) => {
        return a.startWeek - b.startWeek
          || a.endWeek - b.endWeek
          || a.capacityPercent - b.capacityPercent
      })

      // Exact duplicate detection
      const seenRanges = new Set<string>()
      for (const seg of sorted) {
        const rangeKey = `${seg.startWeek}-${seg.endWeek}`
        if (seenRanges.has(rangeKey)) {
          errors.push(
            `Segment ${seg.index}: duplicate segment with week range [${seg.startWeek}, ${seg.endWeek}] ` +
            `at ${seg.capacityPercent}%`,
          )
        }
        seenRanges.add(rangeKey)
      }

      // Inclusive overlap detection — track farthest prior end
      let priorEnd = -1
      let priorIndex: number | null = null
      for (const current of sorted) {
        if (current.startWeek <= priorEnd) {
          errors.push(
            `Segment ${current.index} (W${current.startWeek}-W${current.endWeek}) overlaps with ` +
            `segment ${priorIndex} (ending W${priorEnd})`,
          )
        }
        if (current.endWeek > priorEnd) {
          priorEnd = current.endWeek
          priorIndex = current.index
        }
      }
    }
  }

  return errors
}
