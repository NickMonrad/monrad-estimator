/**
 * capacityProfileTransferService.ts — Atomic ownership transfer from
 * Squad Planner to manual capacity management.
 *
 * The transfer converts all planner-owned profiles for a single role to
 * manual ownership while preserving profile identities, segment boundaries,
 * percentages, and effective weekly capacity.
 *
 * ## Scope
 *
 * - Transfers ONE role (ResourceType) at a time — the caller must invoke
 *   per role.
 * - Transfers the role-level ROLE profile AND all PLANNED_RESOURCE profiles
 *   proven to be Squad Planner-created for that role.
 * - Leaves existing NAMED_PERSON (explicit/protected) profiles untouched.
 * - Updates legacy compatibility projections deterministically inside the
 *   same transaction.
 *
 * ## Guards
 *
 * - Fails closed if the role is not currently Squad Planner-managed.
 * - Fails closed on malformed, duplicate, or conflicting persisted ownership.
 * - Fails closed if the persisted authority is ambiguous or incomplete.
 * - Rolls back the complete transaction if any write fails.
 *
 * @module
 */

import { projectCapacityProfileToLegacyAllocation } from './capacityProfileLegacyProjection.js'
import type { PrismaClient } from '@prisma/client'

/** Inferred Prisma transaction client type. */
type TxClient = Parameters<Parameters<PrismaClient['$transaction']>[0]>[0]

// ─── Public types ────────────────────────────────────────────────────────────

export interface TransferResult {
  /** Number of profiles whose source was changed from SQUAD_PLANNER to MANUAL. */
  profilesTransferred: number
  /** Number of planners-created PLANNED_RESOURCE profiles transferred. */
  plannedResourceProfilesTransferred: number
  /** Whether the role-level profile was transferred. */
  roleProfileTransferred: boolean
  /** Names of profiles left untouched because they were not planner-owned. */
  protectedProfiles: string[]
}

// ─── Error helper ────────────────────────────────────────────────────────────

export class TransferError extends Error {
  public readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'TransferError'
    this.status = status
  }
}

// ─── Transfer command ────────────────────────────────────────────────────────

/**
 * Transfer a Squad Planner-managed role to manual capacity ownership.
 *
 * The transfer is atomic — it either completes for the entire role or
 * rolls back with no partial state.
 *
 * @param tx              Prisma transaction client
 * @param projectId       Project ID
 * @param resourceTypeId  ResourceType ID (the role to transfer)
 * @param userId          Authenticated user ID (for ownership check)
 * @returns               TransferResult with counts of transferred profiles
 * @throws TransferError  On validation failure or conflicting state
 */
export async function transferToManualCapacity(
  tx: TxClient,
  projectId: string,
  resourceTypeId: string,
  userId: string,
): Promise<TransferResult> {
  // ── 0. Verify project ownership ──────────────────────────────────────
  const project = await tx.project.findFirst({
    where: { id: projectId, ownerId: userId },
    select: { id: true },
  })
  if (!project) {
    throw new TransferError(404, 'Project not found or access denied')
  }

  // ── 1. Verify resource type belongs to project ────────────────────────
  const resourceType = await tx.resourceType.findFirst({
    where: { id: resourceTypeId, projectId },
    select: { id: true, name: true },
  })
  if (!resourceType) {
    throw new TransferError(404, `Resource type "${resourceTypeId}" not found in project`)
  }

  // ── 2. Load all profiles for this role ────────────────────────────────
  const namedResources = await tx.namedResource.findMany({
    where: { resourceTypeId },
    select: { id: true, name: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  })
  const namedResourceIds = namedResources.map(nr => nr.id)

  const allProfiles = await tx.capacityProfile.findMany({
    where: {
      projectId,
      OR: [
        { resourceTypeId },
        ...(namedResourceIds.length > 0
          ? [{ namedResourceId: { in: namedResourceIds } }]
          : []),
      ],
    },
    include: {
      segments: {
        orderBy: [{ startWeek: 'asc' }, { endWeek: 'asc' }],
      },
    },
    orderBy: { createdAt: 'asc' },
  })

  if (allProfiles.length === 0) {
    throw new TransferError(409, `No capacity profiles found for resource type "${resourceType.name}"`)
  }

  // ── 3. Classify profiles ─────────────────────────────────────────────
  const roleProfiles = allProfiles.filter(
    p => p.resourceTypeId === resourceTypeId && p.namedResourceId === null && p.ownerKind === 'ROLE',
  )
  const resourceProfiles = allProfiles.filter(
    p => p.namedResourceId !== null && namedResourceIds.includes(p.namedResourceId!),
  )

  if (roleProfiles.length === 0) {
    throw new TransferError(409, `No role-level capacity profile found for resource type "${resourceType.name}"`)
  }
  if (roleProfiles.length > 1) {
    throw new TransferError(409, `Multiple role-level capacity profiles exist for resource type "${resourceType.name}" — repair required before transfer`)
  }

  const roleProfile = roleProfiles[0]

  // Validate role profile structure
  if (!roleProfile || typeof roleProfile !== 'object') {
    throw new TransferError(409, 'Malformed role-level capacity profile')
  }

  // ── 4. Validate exact planner ownership ──────────────────────────────
  // The role profile must be SQUAD_PLANNER-owned
  if (roleProfile.source !== 'SQUAD_PLANNER') {
    const sourceLabel = String(roleProfile.source)
    throw new TransferError(
      409,
      `Role "${resourceType.name}" is not managed by Squad Planner. Current source: ${sourceLabel}. Only Squad Planner-managed roles can be transferred.`,
    )
  }

  // Validate role profile ownerKind
  if (roleProfile.ownerKind !== 'ROLE') {
    throw new TransferError(409, `Malformed role-level profile owner kind: expected ROLE, got ${String(roleProfile.ownerKind)}`)
  }

  // Validate role profile planningBasis
  if (roleProfile.planningBasis !== 'CAPACITY_PROFILE') {
    throw new TransferError(409, `Malformed role-level profile planning basis: expected CAPACITY_PROFILE, got ${String(roleProfile.planningBasis)}`)
  }

  // Validate FK consistency
  if (roleProfile.resourceTypeId !== resourceTypeId || roleProfile.namedResourceId !== null) {
    throw new TransferError(409, 'Malformed role-level profile foreign key ownership')
  }

  // ── 5. Classify resource profiles ────────────────────────────────────
  const plannerResourceProfiles: typeof resourceProfiles = []
  const protectedProfiles: string[] = []

  for (const profile of resourceProfiles) {
    if (!profile.namedResourceId) {
      protectedProfiles.push(`unnamed (id=${profile.id})`)
      continue
    }
    const namedResource = namedResources.find(nr => nr.id === profile.namedResourceId)
    const nrName = namedResource?.name ?? `unknown (id=${profile.namedResourceId})`

    // Squad Planner-created PLANNED_RESOURCE profiles are transferred
    if (
      profile.ownerKind === 'PLANNED_RESOURCE'
      && profile.source === 'SQUAD_PLANNER'
      && profile.planningBasis === 'CAPACITY_PROFILE'
    ) {
      plannerResourceProfiles.push(profile)
      continue
    }

    // Squad Planner NAMED_PERSON profiles with CAPACITY_PROFILE basis are legacy planner
    if (
      profile.ownerKind === 'NAMED_PERSON'
      && profile.source === 'SQUAD_PLANNER'
      && profile.planningBasis === 'CAPACITY_PROFILE'
    ) {
      plannerResourceProfiles.push(profile)
      continue
    }

    // Any other profile (MANUAL, FIXED, IMPORTED, etc.) is protected
    protectedProfiles.push(nrName)
  }

  // ── 6. Check for duplicate profiles ──────────────────────────────────
  // (Already handled by DB unique constraints, but fail-closed check)
  if (resourceProfiles.some(p => {
    const count = resourceProfiles.filter(
      other => other.namedResourceId !== null && other.namedResourceId === p.namedResourceId,
    ).length
    return count > 1
  })) {
    throw new TransferError(409, `Duplicate named-resource profiles exist for resource type "${resourceType.name}" — repair required before transfer`)
  }

  // ── 7. Perform the transfer ──────────────────────────────────────────

  // 7a. Transfer role-level profile
  await tx.capacityProfile.update({
    where: { id: roleProfile.id },
    data: { source: 'MANUAL' },
  })

  // 7b. Transfer planner-created resource profiles
  for (const profile of plannerResourceProfiles) {
    await tx.capacityProfile.update({
      where: { id: profile.id },
      data: { source: 'MANUAL' },
    })
  }

  // ── 8. Update legacy compatibility projections ───────────────────────
  // 8a. Project role profile to legacy ResourceType fields
  const roleSegments = roleProfile.segments ?? []
  const roleProjection = projectCapacityProfileToLegacyAllocation({
    planningBasis: 'capacityProfile',
    source: 'manual',
    defaultPercent: roleProfile.defaultPercent,
    startWeek: roleProfile.startWeek,
    endWeek: roleProfile.endWeek,
    segments: roleSegments.map(s => ({
      startWeek: s.startWeek,
      endWeek: s.endWeek,
      capacityPercent: s.capacityPercent,
    })),
  })

  if (roleProjection) {
    await tx.resourceType.update({
      where: { id: resourceTypeId },
      data: {
        allocationMode: roleProjection.allocationMode,
        allocationPercent: roleProjection.allocationPercent ?? 0,
        allocationStartWeek: roleProjection.allocationStartWeek,
        allocationEndWeek: roleProjection.allocationEndWeek,
      },
    })
  }

  // 8b. Project planner resource profiles to legacy NamedResource fields
  for (const profile of plannerResourceProfiles) {
    if (!profile.namedResourceId) continue

    const segs = profile.segments ?? []
    const projection = projectCapacityProfileToLegacyAllocation({
      planningBasis: 'capacityProfile',
      source: 'manual',
      defaultPercent: profile.defaultPercent,
      startWeek: profile.startWeek,
      endWeek: profile.endWeek,
      segments: segs.map(s => ({
        startWeek: s.startWeek,
        endWeek: s.endWeek,
        capacityPercent: s.capacityPercent,
      })),
    })

    if (projection) {
      await tx.namedResource.update({
        where: { id: profile.namedResourceId },
        data: {
          allocationMode: projection.allocationMode,
          allocationPercent: projection.allocationPercent ?? 100,
          allocationPct: Math.round(projection.allocationPercent ?? 100),
          allocationStartWeek: projection.allocationStartWeek,
          allocationEndWeek: projection.allocationEndWeek,
          startWeek: projection.allocationStartWeek,
          endWeek: projection.allocationEndWeek,
        },
      })
    }
  }

  // ── 9. Update legacy metadata on transferred profiles ───────────────
  // Mark role profile with transfer metadata
  await tx.capacityProfile.update({
    where: { id: roleProfile.id },
    data: {
      legacy: {
        version: 1,
        writer: 'transfer-to-manual',
        allocationMode: roleProjection?.allocationMode ?? 'CAPACITY_PLAN',
        allocationPercent: roleProjection?.allocationPercent ?? roleProfile.defaultPercent ?? 100,
        allocationStartWeek: roleProjection?.allocationStartWeek ?? roleProfile.startWeek,
        allocationEndWeek: roleProjection?.allocationEndWeek ?? roleProfile.endWeek,
        lossy: roleProjection?.lossy ?? false,
        lossReason: roleProjection?.lossReason ?? null,
      } satisfies Record<string, unknown> as any,
    },
  })

  for (const profile of plannerResourceProfiles) {
    if (!profile.namedResourceId) continue
    const segs = profile.segments ?? []
    const proj = projectCapacityProfileToLegacyAllocation({
      planningBasis: 'capacityProfile',
      source: 'manual',
      defaultPercent: profile.defaultPercent,
      startWeek: profile.startWeek,
      endWeek: profile.endWeek,
      segments: segs.map(s => ({
        startWeek: s.startWeek,
        endWeek: s.endWeek,
        capacityPercent: s.capacityPercent,
      })),
    })

    if (proj) {
      await tx.capacityProfile.update({
        where: { id: profile.id },
        data: {
          legacy: {
            version: 1,
            writer: 'transfer-to-manual',
            allocationMode: proj.allocationMode,
            allocationPercent: proj.allocationPercent ?? profile.defaultPercent ?? 100,
            allocationStartWeek: proj.allocationStartWeek ?? profile.startWeek,
            allocationEndWeek: proj.allocationEndWeek ?? profile.endWeek,
            lossy: proj.lossy,
            lossReason: proj.lossReason ?? null,
          } satisfies Record<string, unknown> as any,
        },
      })
    }
  }

  // ── 10. Invalidate weekly demand cache ───────────────────────────────
  await tx.project.update({
    where: { id: projectId },
    data: { weeklyDemandCache: {} },
  })

  return {
    profilesTransferred: 1 + plannerResourceProfiles.length,
    plannedResourceProfilesTransferred: plannerResourceProfiles.filter(
      p => p.ownerKind === 'PLANNED_RESOURCE',
    ).length,
    roleProfileTransferred: true,
    protectedProfiles,
  }
}
