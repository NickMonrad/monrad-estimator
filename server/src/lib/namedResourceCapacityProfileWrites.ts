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
 * @returns LegacyAllocationProjection for the caller to write to NamedResource
 */
export async function upsertNRProfileAndProjectLegacy(
  tx: any,
  projectId: string,
  nrId: string,
  rtId: string,
  payload: NamedResourceCapacityPayload,
): Promise<LegacyAllocationProjection> {
  // ── 1. Normalise incoming fields ───────────────────────────────────────
  const mode = payload.allocationMode ?? 'EFFORT'
  const percent = payload.allocationPercent ?? payload.allocationPct ?? 100
  const allocationStartWeek = payload.allocationStartWeek ?? payload.startWeek ?? null
  const allocationEndWeek = payload.allocationEndWeek ?? payload.endWeek ?? null

  const planningBasis = ALLOCATION_MODE_TO_PLANNING_BASIS[mode] ?? 'DEMAND_FOLLOWING'
  const source = deriveProfileSource(mode)

  // Build the in-memory profile shape (camelCase for the projection helper).
  const profile = {
    planningBasis: planningBasisToCamel(planningBasis),
    source: sourceToCamel(source),
    defaultPercent: percent,
    // For simple legacy fields there are no explicit segments.
    // The projection helper uses startWeek/endWeek when segments are empty.
    startWeek: planningBasis === 'AVAILABILITY_WINDOW' ? allocationStartWeek : null,
    endWeek: planningBasis === 'AVAILABILITY_WINDOW' ? allocationEndWeek : null,
    segments: [] as Array<{ startWeek: number; endWeek: number; capacityPercent: number; source: string }>,
  }

  // ── 2. Persist CapacityProfile ─────────────────────────────────────────
  // Delete any existing profile + segments for this NR first.
  await tx.capacitySegment.deleteMany({
    where: { capacityProfile: { namedResourceId: nrId, projectId } },
  })
  await tx.capacityProfile.deleteMany({
    where: { namedResourceId: nrId, projectId },
  })

  await tx.capacityProfile.create({
    data: {
      projectId,
      resourceTypeId: rtId,
      namedResourceId: nrId,
      ownerKind: 'NAMED_PERSON',
      planningBasis,
      source,
      defaultPercent: percent,
      startWeek: allocationStartWeek,
      endWeek: allocationEndWeek,
    },
  })

  // ── 3. Replace segments ────────────────────────────────────────────────
  // For simple legacy-style payloads there are no segments to create.
  // When segment arrays are added to the public API in a future phase,
  // they will be created here.

  // ── 4. Project back to legacy ──────────────────────────────────────────
  const projection = projectCapacityProfileToLegacyAllocation(profile)

  // The projection is always non-null because we always have a profile here.
  return projection!
}

// ─── Internal helpers ────────────────────────────────────────────────────────

function planningBasisToCamel(value: string): string {
  return value.toLowerCase().replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())
}

function sourceToCamel(value: string): string {
  return value.toLowerCase().replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())
}
