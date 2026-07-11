/**
 * resourceTypeCapacityProfileWrites.ts — Profile-first write helper for
 * ResourceType / role-level capacity/allocation updates.
 *
 * This is Phase 4 of #340: role-level write migration.
 * Incoming legacy-style payload fields are converted to a role-owned
 * CapacityProfile row, persisted transactionally, then projected back
 * into legacy ResourceType fields for compatibility.
 *
 * @see docs/domain/capacity-profile-source-of-truth-migration-plan.md#phase-4
 * @see namedResourceCapacityProfileWrites.ts  (NR equivalent, Phase 3)
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

export interface ResourceTypeCapacityPayload {
  allocationMode?: string | null
  allocationPercent?: number | null
  allocationStartWeek?: number | null
  allocationEndWeek?: number | null
}

// ─── Main write helper ──────────────────────────────────────────────────────

/**
 * Upsert a role-owned CapacityProfile from legacy ResourceType allocation
 * fields, then project back to legacy shape.
 *
 * This function MUST be called inside a Prisma `$transaction` callback.
 *
 * @param tx         Prisma transaction client
 * @param projectId  Project ID
 * @param rtId       ResourceType ID
 * @param payload    Incoming capacity/allocation fields from the request
 * @returns          Projected legacy-allocation values the caller writes to ResourceType
 */
export async function upsertRTProfileAndProjectLegacy(
  tx: any,
  projectId: string,
  rtId: string,
  payload: ResourceTypeCapacityPayload,
): Promise<LegacyAllocationProjection> {
  // ── 1. Normalise incoming fields ───────────────────────────────────────
  let allocationStartWeek = payload.allocationStartWeek ?? null
  let allocationEndWeek = payload.allocationEndWeek ?? null

  // Normalise mode: explicit allocationMode wins; if window fields are present, infer TIMELINE
  let mode: string | null | undefined = payload.allocationMode
  const hasAllocationMode = mode !== undefined && mode !== null
  const hasWindow = allocationStartWeek != null || allocationEndWeek != null
  if (!hasAllocationMode) {
    mode = hasWindow ? 'TIMELINE' : 'EFFORT'
  } else if (mode === 'EFFORT' || mode === 'FULL_PROJECT' || mode === 'CAPACITY_PLAN') {
    // Non-window mode explicitly set — suppress stale window fields
    allocationStartWeek = null
    allocationEndWeek = null
  }
  const percent = payload.allocationPercent ?? 100

  const planningBasis = ALLOCATION_MODE_TO_PLANNING_BASIS[mode as string] ?? 'DEMAND_FOLLOWING'
  const source = deriveProfileSource(mode as string)

  // Build in-memory profile shape (camelCase for the projection helper)
  const profile = {
    planningBasis: planningBasis.toLowerCase().replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()),
    source: source.toLowerCase().replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()),
    defaultPercent: percent,
    startWeek: allocationStartWeek,
    endWeek: allocationEndWeek,
    segments: [] as Array<{ startWeek: number; endWeek: number; capacityPercent: number; source: string }>,
  }

  // ── 2. Persist role-owned CapacityProfile ─────────────────────────────
  // Delete any existing role-level profile for this RT first, then create new.
  const existingProfiles = await tx.capacityProfile.findMany({
    where: { resourceTypeId: rtId, namedResourceId: null, projectId },
    select: { id: true },
  })
  const existingProfileIds = existingProfiles.map((p: { id: string }) => p.id)

  if (existingProfileIds.length > 0) {
    await tx.capacitySegment.deleteMany({
      where: { capacityProfileId: { in: existingProfileIds } },
    })
    await tx.capacityProfile.deleteMany({
      where: { id: { in: existingProfileIds } },
    })
  }

  await tx.capacityProfile.create({
    data: {
      ownerKind: 'ROLE',
      projectId,
      resourceTypeId: rtId,
      namedResourceId: null,
      planningBasis,
      source,
      defaultPercent: percent,
      startWeek: allocationStartWeek,
      endWeek: allocationEndWeek,
    },
  })

  // ── 3. Project back to legacy ──────────────────────────────────────────
  const projection = projectCapacityProfileToLegacyAllocation(profile)

  // The projection is always non-null because we always have a profile here.
  return projection!
}

/**
 * Build a capacity payload for the missing-profile case in non-capacity RT update.
 *
 * When no role-owned CapacityProfile exists and the update only changes
 * non-capacity fields, create a profile from existing legacy ResourceType fields.
 *
 * - TIMELINE mode preserves existing window fields
 * - Non-window modes (EFFORT, FULL_PROJECT, CAPACITY_PLAN) suppress window fields
 */
export function buildMissingRTProfilePayload(existing: {
  allocationMode: string | null
  allocationPercent: number | null
  allocationStartWeek: number | null
  allocationEndWeek: number | null
}): ResourceTypeCapacityPayload {
  const isTimeline = existing.allocationMode === 'TIMELINE'

  const startWeek = isTimeline
    ? (existing.allocationStartWeek ?? null)
    : null
  const endWeek = isTimeline
    ? (existing.allocationEndWeek ?? null)
    : null

  return {
    allocationMode: existing.allocationMode,
    allocationPercent: existing.allocationPercent,
    allocationStartWeek: startWeek,
    allocationEndWeek: endWeek,
  }
}
