/**
 * resolveRTPatchState.ts — Loads complete pre-mutation ResourceType ownership
 * state for PATCH count changes, resolving the authoritative role default and
 * classifying named resources.
 *
 * This is the single source of truth for the PATCH route's pre-mutation view:
 *   - Named resources and their capacity profiles (with segments)
 *   - The role-owned CapacityProfile, if present
 *   - Authoritative role default (profile first, legacy fallback)
 *   - Inherited vs explicit NR classification
 *
 * @see classifyNRsForRoleUpdate.ts for classification rules
 * @see resolveRoleDefaultForMutation.ts for role-default resolution
 * @see docs/domain/capacity-profile-source-of-truth-migration-plan.md
 */

import { resolveRoleDefaultForMutation } from './resolveRoleDefaultForMutation.js'
import type { ResolvedRoleDefault, RoleProfileLike } from './resolveRoleDefaultForMutation.js'
import { classifyNRsForRoleUpdate } from './classifyNRsForRoleUpdate.js'
import type { NRToClassify, NRProfileState, ClassificationResult } from './classifyNRsForRoleUpdate.js'

// ─── Input shape ─────────────────────────────────────────────────────────────

export interface ResourceTypeRecord {
  id: string
  allocationMode: string | null
  allocationPercent: number | null
  allocationStartWeek: number | null
  allocationEndWeek: number | null
}

export interface NamedResourceRecord {
  id: string
  allocationMode: string | null
  allocationPercent: number | null
  allocationPct: number | null
  allocationStartWeek: number | null
  allocationEndWeek: number | null
  startWeek: number | null
  endWeek: number | null
}

export interface SegmentRecord {
  startWeek: number
  endWeek: number
  capacityPercent: number
  source: string
}

export interface CapacityProfileRecord {
  id: string
  ownerKind: string
  planningBasis: string
  source: string
  defaultPercent: number | null
  startWeek: number | null
  endWeek: number | null
  legacy: unknown
  namedResourceId: string | null
  resourceTypeId: string | null
  segments: SegmentRecord[]
}

// ─── Scheduling state ───────────────────────────────────────────────────────

export interface SchedulingState {
  isCapacityPlan: boolean
}

/**
 * Determine whether the ResourceType is in CAPACITY_PLAN scheduling mode,
 * using the authoritative role-owned CapacityProfile first.
 *
 * Precedence:
 * 1. If a role-owned profile exists with CAPACITY_PROFILE planning basis → capacity plan
 * 2. Other role profile → NOT capacity plan (even if stale RT fields say CAPACITY_PLAN)
 * 3. No role profile → fall back to ResourceType.allocationMode
 */
export function resolveRoleSchedulingState(state: RTPatchState): SchedulingState {
  if (state.roleProfileRows.length > 0) {
    const pp = state.roleProfileRows[0]
    const isCp = pp.planningBasis === 'CAPACITY_PROFILE' || pp.planningBasis === 'capacityProfile'
    return { isCapacityPlan: isCp }
  }
  // Runtime path: no profile → not capacity plan (route-level fail-closed
  // guards catch missing profiles before any mutation)
  return { isCapacityPlan: false }
}

// ─── Return type ─────────────────────────────────────────────────────────────

export interface RTPatchState {
  resourceType: ResourceTypeRecord
  namedResources: NamedResourceRecord[]
  nrProfileRows: CapacityProfileRecord[]
  roleProfileRows: CapacityProfileRecord[]
  roleDefault: ResolvedRoleDefault
  classification: ClassificationResult
}

// ─── Loader function ─────────────────────────────────────────────────────────

/**
 * Load the complete pre-mutation state for a ResourceType PATCH operation.
 *
 * Fetches all named resources, NR capacity profiles with segments, and
 * role-owned profiles with segments in a single transaction block, then
 * resolves the authoritative role default and classifies NRs.
 *
 * @param tx - Prisma transaction client
 * @param rtId - ResourceType ID
 * @param resourceType - The ResourceType record (pre-mutation)
 */
export async function resolveRTPatchState(
  tx: any,
  rtId: string,
  resourceType: ResourceTypeRecord,
): Promise<RTPatchState> {
  // ── 1. Load named resources ──────────────────────────────────────────
  const namedResources: NamedResourceRecord[] = (await tx.namedResource.findMany({
    where: { resourceTypeId: rtId },
    orderBy: { createdAt: 'asc' },
  })) ?? []
  if (!Array.isArray(namedResources)) {
    throw new Error(
      `resolveRTPatchState: tx.namedResource.findMany returned non-array for RT ${rtId}: ${typeof namedResources}`,
    )
  }

  // ── 2. Load NR capacity profiles with segments ──────────────────────
  const nrProfileRows: CapacityProfileRecord[] = (await tx.capacityProfile.findMany({
    where: {
      namedResourceId: { in: namedResources.map((nr: any) => nr.id) },
    },
    include: { segments: true },
  })) ?? []

  const roleProfileRows: CapacityProfileRecord[] = (await tx.capacityProfile.findMany({
    where: {
      resourceTypeId: rtId,
      namedResourceId: null,
      ownerKind: 'ROLE',
    },
    include: { segments: true },
  })) ?? []

  // ── 4. Resolve authoritative role default ────────────────────────────
  const roleDefault = resolveRoleDefaultForMutation({
    resourceType,
    roleProfiles: roleProfileRows as unknown as RoleProfileLike[],
  })

  // Build the old-role-default shape for the classifier
  const oldRoleDefault = {
    allocationMode: roleDefault.allocationMode,
    allocationPercent: roleDefault.allocationPercent,
    allocationStartWeek: roleDefault.allocationStartWeek,
    allocationEndWeek: roleDefault.allocationEndWeek,
  }

  // ── 5. Classify NRs ──────────────────────────────────────────────────
  const classification = classifyNRsForRoleUpdate(
    namedResources as unknown as NRToClassify[],
    nrProfileRows as unknown as NRProfileState[],
    oldRoleDefault,
  )

  return {
    resourceType: resourceType as unknown as ResourceTypeRecord,
    namedResources,
    nrProfileRows,
    roleProfileRows,
    roleDefault,
    classification,
  }
}
