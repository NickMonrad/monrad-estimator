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

import type { ResolvedRoleDefault } from './resolveRoleDefaultForMutation.js'
import { CapacityIntegrityError } from './capacityIntegrityError.js'
import { classifyNRsForRoleUpdate } from './classifyNRsForRoleUpdate.js'
import type { NRToClassify, NRProfileState, ClassificationResult } from './classifyNRsForRoleUpdate.js'
import { loadAndValidateOwnerProfile } from './ownerProfileLoader.js'
import { projectCapacityProfileToLegacyAllocation } from './capacityProfileLegacyProjection.js'

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
  projectId: string,
): Promise<RTPatchState> {
  // ── 1. Validate exactly one authoritative ROLE profile ──────────────
  const roleProfile = await loadAndValidateOwnerProfile({
    tx,
    projectId,
    ownerKind: 'ROLE',
    ownerId: rtId,
  })

  // ── 2. Project the validated profile to legacy-compatible values ─────
  const projection = projectCapacityProfileToLegacyAllocation({
    planningBasis: roleProfile.planningBasis,
    defaultPercent: roleProfile.defaultPercent,
    startWeek: roleProfile.startWeek,
    endWeek: roleProfile.endWeek,
    segments: roleProfile.segments.map(s => ({
      startWeek: s.startWeek,
      endWeek: s.endWeek,
      capacityPercent: s.capacityPercent,
      source: s.source,
    })),
    source: roleProfile.source,
  })

  const roleDefault: ResolvedRoleDefault = {
    allocationMode: projection?.allocationMode ?? 'EFFORT',
    allocationPercent: projection?.allocationPercent ?? 100,
    allocationStartWeek: projection?.allocationStartWeek ?? null,
    allocationEndWeek: projection?.allocationEndWeek ?? null,
    source: 'PROFILE',
    lossy: projection?.lossy ?? false,
    lossReason: (projection as any)?.lossReason,
  }

  // ── 3. Load named resources with their profiles ──────────────────────
  const namedResources: NamedResourceRecord[] = (await tx.namedResource.findMany({
    where: { resourceTypeId: rtId },
    orderBy: { createdAt: 'asc' },
  })) ?? []

  const rawNRProfiles: CapacityProfileRecord[] = (await tx.capacityProfile.findMany({
    where: {
      namedResourceId: { in: namedResources.map((nr: any) => nr.id) },
      projectId,
    },
    include: { segments: true },
  })) ?? []

  // ── 4. Validate every NR profile through strict validation ────────────
  const nrProfileRows: CapacityProfileRecord[] = []
  for (const nr of namedResources) {
    const nrProfiles = rawNRProfiles.filter((p: any) => p.namedResourceId === nr.id)

    if (nrProfiles.length === 0) {
      // No profile for this NR — allowed only if it matches inheritance rules.
      // The classifier will treat it as inherited if its legacy fields match the
      // role default, or explicit if they differ. We skip strict validation for
      // profile-less NRs because there's nothing to validate.
      continue
    }

    if (nrProfiles.length > 1) {
      throw new CapacityIntegrityError(
        `Multiple capacity profiles exist for named resource ${nr.id}. ` +
        'Run the capacity profile backfill/repair workflow before retrying this operation.',
      )
    }

    const p = nrProfiles[0]
    const profileOwnerKind = p.ownerKind as string
    if (profileOwnerKind !== 'NAMED_PERSON' && profileOwnerKind !== 'PLANNED_RESOURCE') {
      throw new CapacityIntegrityError(
        `Capacity profile ${p.id} has invalid owner kind "${profileOwnerKind}".`,
      )
    }

    // Validate through the strict loader — will throw if malformed
    await loadAndValidateOwnerProfile({
      tx,
      projectId,
      ownerKind: profileOwnerKind,
      ownerId: nr.id,
    })

    nrProfileRows.push(p)
  }

  // ── 5. Build old-role-default for classifier ─────────────────────────
  const oldRoleDefault = {
    allocationMode: roleDefault.allocationMode,
    allocationPercent: roleDefault.allocationPercent,
    allocationStartWeek: roleDefault.allocationStartWeek,
    allocationEndWeek: roleDefault.allocationEndWeek,
  }

  // ── 6. Classify NRs ──────────────────────────────────────────────────
  const classification = classifyNRsForRoleUpdate(
    namedResources as unknown as NRToClassify[],
    nrProfileRows as unknown as NRProfileState[],
    oldRoleDefault,
  )

  return {
    resourceType: resourceType as unknown as ResourceTypeRecord,
    namedResources,
    nrProfileRows,
    roleProfileRows: [roleProfile as unknown as CapacityProfileRecord],
    roleDefault,
    classification,
  }
}
