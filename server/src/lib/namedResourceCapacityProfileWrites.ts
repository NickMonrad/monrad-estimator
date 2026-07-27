/**
 * namedResourceCapacityProfileWrites.ts — Profile-first write helper for
 * named-resource capacity/allocation updates.
 *
 * This is the first source-of-truth migration step (Phase 3 of #340).
 * Incoming legacy-style payload fields are converted to CapacityProfile /
 * CapacitySegment rows, persisted transactionally, then projected back
 * into legacy NamedResource fields for compatibility.
 *
 * @see docs/domain/capacity-profile-source-of-truth-migration-plan.md#phase-3
 */

import { projectCapacityProfileToLegacyAllocation } from './capacityProfileLegacyProjection.js'
import type { LegacyAllocationProjection } from './capacityProfileLegacyProjection.js'
import { CapacityIntegrityError } from './capacityIntegrityError.js'
import { loadAndValidateOwnerProfile } from './ownerProfileLoader.js'

// ─── Mapping tables (legacy → profile) ───────────────────────────────────────

const ALLOCATION_MODE_TO_PLANNING_BASIS: Record<string, string> = {
  EFFORT: 'DEMAND_FOLLOWING',
  TIMELINE: 'AVAILABILITY_WINDOW',
  FULL_PROJECT: 'WHOLE_PROJECT_ALLOCATION',
  CAPACITY_PLAN: 'CAPACITY_PROFILE',
}

function deriveProfileSource(mode: string | null | undefined): string {
  if (mode === 'CAPACITY_PLAN') return 'SQUAD_PLANNER'
  if (mode === 'TIMELINE') return 'AVAILABILITY_WINDOW'
  if (mode === 'EFFORT' || mode === 'FULL_PROJECT') return 'FIXED'
  return 'LEGACY'
}

// ─── Input type ──────────────────────────────────────────────────────────────

export interface NamedResourceCapacityPayload {
  allocationMode?: string | null
  allocationPercent?: number | null
  allocationPct?: number | null
  allocationStartWeek?: number | null
  allocationEndWeek?: number | null
  startWeek?: number | null
  endWeek?: number | null
}

export interface NRProfileWriteOptions {
  /** Whether the named resource is a synthetic/planned resource (true) or a named person (false/null/undefined). */
  synthetic?: boolean | null
  /** Allow creating a new profile when none exists (default: false). */
  allowCreate?: boolean
}
/**
 * ## Flow
 *
 * 1. Normalise incoming fields → profile shape (planningBasis, source, percent, etc.)
 * 2. Upsert `CapacityProfile` row (delete existing for this NR, create new)
 * 3. Replace `CapacitySegment` rows
 * 4. Call `projectCapacityProfileToLegacyAllocation` for backward projection
 * 5. Return projected legacy-allocation values the caller writes to NamedResource
 *
 * ## Transactionality
 *
 * This function MUST be called inside a Prisma `$transaction` callback.
 * All DB writes use the provided `tx` client.
 *
 * @param tx         Prisma transaction client
 * @param projectId  Project ID
 * @param nrId       NamedResource ID
 * @param rtId       ResourceType ID the NR belongs to
 * @param payload    Incoming capacity/allocation fields from the request
 * @param options    Optional: { synthetic } to control owner kind. Default { synthetic: false } → NAMED_PERSON.
 */
export async function upsertNRProfileAndProjectLegacy(
  tx: any,
  projectId: string,
  nrId: string,
  _rtId: string,
  payload: NamedResourceCapacityPayload,
  options: NRProfileWriteOptions = {},
): Promise<LegacyAllocationProjection> {
  // ── 1. Normalise incoming fields ───────────────────────────────────────
  let allocationStartWeek = payload.allocationStartWeek !== undefined ? payload.allocationStartWeek : payload.startWeek ?? null
  let allocationEndWeek = payload.allocationEndWeek !== undefined ? payload.allocationEndWeek : payload.endWeek ?? null

  // Normalise mode: explicit allocationMode wins; if window fields are present, infer TIMELINE
  let mode: string | null | undefined = payload.allocationMode
  const hasAllocationMode = mode !== undefined && mode !== null
  const hasWindow = allocationStartWeek != null || allocationEndWeek != null
  if (!hasAllocationMode) {
    mode = hasWindow ? 'TIMELINE' : 'EFFORT'
  } else if (mode === 'EFFORT' || mode === 'FULL_PROJECT' || mode === 'CAPACITY_PLAN') {
    // Non-window mode explicitly set — suppress window fields to prevent
    // the projection helper from returning TIMELINE due to stale window values.
    // This ensures explicit non-window mode always projects back correctly.
    allocationStartWeek = null
    allocationEndWeek = null
  }
  const percent = payload.allocationPercent ?? payload.allocationPct ?? 100

  const planningBasis = ALLOCATION_MODE_TO_PLANNING_BASIS[mode as string] ?? 'DEMAND_FOLLOWING'
  const source = deriveProfileSource(mode as string)

  // Build the in-memory profile shape (camelCase for the projection helper).
  const profile = {
    planningBasis: planningBasisToCamel(planningBasis),
    source: sourceToCamel(source),
    defaultPercent: percent,
    // For simple legacy fields there are no explicit segments.
    // The projection helper uses startWeek/endWeek when segments are empty.
    // Always include window values if present, regardless of planning basis.
    // This ensures explicit startWeek/endWeek inputs are preserved through
    // the projection cycle even when allocationMode was omitted/defaulted.
    startWeek: allocationStartWeek,
    endWeek: allocationEndWeek,
    segments: [] as Array<{ startWeek: number; endWeek: number; capacityPercent: number; source: string }>,
  }

  // ── 2. Load and validate existing profile, or create ─────────────────
  const expectedOwnerKind = options.synthetic ? 'PLANNED_RESOURCE' : 'NAMED_PERSON'
  const existingProfiles = await tx.capacityProfile.findMany({
    where: { namedResourceId: nrId, projectId },
    select: { id: true },
  })

  if (existingProfiles.length > 1) {
    throw new CapacityIntegrityError(
      `Multiple capacity profiles exist for named resource ${nrId}. ` +
      'Run the capacity profile backfill/repair workflow before retrying this operation.',
    )
  }

  const existingId = existingProfiles.length === 1 ? existingProfiles[0].id : null

  if (existingId) {
    // Validate existing profile before update
    const validated = await loadAndValidateOwnerProfile({
      tx,
      projectId,
      ownerKind: expectedOwnerKind,
      ownerId: nrId,
    })
    // Update in place — preserve profile ID, replace segments
    await tx.capacitySegment.deleteMany({
      where: { capacityProfileId: validated.id },
    })
    await tx.capacityProfile.update({
      where: { id: validated.id },
      data: {
        ownerKind: expectedOwnerKind,
        planningBasis,
        source,
        defaultPercent: percent,
        startWeek: allocationStartWeek,
        endWeek: allocationEndWeek,
      },
    })
  } else {
    // No existing profile — create only when allowCreate is set
    if (!options.allowCreate) {
      throw new CapacityIntegrityError(
        `Missing capacity profile for named resource ${nrId}. ` +
        'Run the capacity profile backfill/repair workflow before retrying this operation.',
      )
    }
    await tx.capacityProfile.create({
      data: {
        ownerKind: expectedOwnerKind,
        projectId,
        resourceTypeId: null,
        namedResourceId: nrId,
        planningBasis,
        source,
        defaultPercent: percent,
        startWeek: allocationStartWeek,
        endWeek: allocationEndWeek,
      },
    })
  }
  // ── 3. Replace segments ────────────────────────────────────────────────
  // For simple legacy-style payloads there are no segments to create.
  // When segment arrays are added to the public API in a future phase,
  // they will be created here.
  // ── 4. Project back to legacy ──────────────────────────────────────────
  const projection = projectCapacityProfileToLegacyAllocation(profile)
  return projection!
}

// ─── Internal helpers ────────────────────────────────────────────────────────

function planningBasisToCamel(value: string): string {
  return value.toLowerCase().replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())
}

function sourceToCamel(value: string): string {
  return value.toLowerCase().replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())
}

// ─── Exported scalar mode helpers for PUT/PATCH routes ─────────────────────

/**
 * Map a scalar allocation mode to its authoritative profile semantics.
 *
 * Valid modes: EFFORT → DEMAND_FOLLOWING/FIXED, TIMELINE → AVAILABILITY_WINDOW,
 * FULL_PROJECT → WHOLE_PROJECT_ALLOCATION.
 *
 * Throws an error for CAPACITY_PLAN (not settable via scalar API) and
 * unknown/unsupported modes.
 *
 * Returns the authoritative planning basis, source and non-window flag.
 */
export function mapScalarModeToProfile(mode: string): {
  planningBasis: string
  source: string
  isNonWindow: boolean
} {
  // Reject CAPACITY_PLAN — scalar NamedResource endpoint is not for capacity-plan management
  if (mode === 'CAPACITY_PLAN') {
    throw new Error('CAPACITY_PLAN mode cannot be set on a named resource through scalar capacity fields.')
  }

  const planningBasis = ALLOCATION_MODE_TO_PLANNING_BASIS[mode]
  if (!planningBasis) {
    throw new Error(`Invalid allocation mode "${mode}". Supported modes: EFFORT, TIMELINE, FULL_PROJECT.`)
  }

  const source = deriveProfileSource(mode)
  const NON_WINDOW_MODES = new Set(['EFFORT', 'FULL_PROJECT'])
  const isNonWindow = NON_WINDOW_MODES.has(mode)

  return { planningBasis, source, isNonWindow }
}
