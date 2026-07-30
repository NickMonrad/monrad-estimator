/**
 * capacityProfileTransferService.ts — Atomic ownership transfer from
 * Squad Planner to manual capacity management.
 *
 * Uses the repository's strict owner-profile validation contract before
 * any mutation. Every transferred profile (ROLE and PLANNED_RESOURCE) is
 * validated for exact project/FK shape, owner kind, planning basis, source,
 * default percentage, windows, segment structure, and segment source.
 *
 * After transfer:
 * - Profile AND segment sources are updated to MANUAL.
 * - Profile IDs and segment IDs are preserved.
 * - Segment boundaries, percentages, ordering are preserved.
 * - Zero-capacity PLANNED_RESOURCE placeholders remain valid.
 * - Protected NAMED_PERSON profiles remain untouched.
 *
 * @module
 */

import { projectCapacityProfileToLegacyAllocation } from './capacityProfileLegacyProjection.js'
import { validatePlannerOwnerState } from './squadPlannerProfileWriter.js'
import type { PrismaClient } from '@prisma/client'

/** Inferred Prisma transaction client type. */
type TxClient = Parameters<Parameters<PrismaClient['$transaction']>[0]>[0]

// ─── Public types ────────────────────────────────────────────────────────────

export interface TransferResult {
  /** Number of profiles whose source was changed from SQUAD_PLANNER to MANUAL. */
  profilesTransferred: number
  /** Number of planner-created PLANNED_RESOURCE profiles transferred. */
  plannedResourceProfilesTransferred: number
  /** Whether the role-level profile was transferred. */
  roleProfileTransferred: boolean
  /** IDs of profiles left untouched because they were not planner-owned. */
  protectedProfileIds: string[]
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
 * Pre-validation (before any write):
 * 1. Project ownership
 * 2. Resource type belongs to project
 * 3. Load ALL profiles for this role (ROLE + named resource profiles)
 * 4. Run the strict `validatePlannerOwnerState` check — any malformed,
 *    duplicate, or conflicting ownership blocks the transfer
 * 5. Classify each profile as planner-owned (to transfer) or protected (to skip)
 * 6. Validate profile FK shape, owner kind, planning basis, source, segments
 *
 * Transfer (atomic):
 * 1. Update profile source to MANUAL
 * 2. Update all segment sources to MANUAL
 * 3. Update legacy compatibility projections
 * 4. Update legacy metadata
 * 5. Invalidate weekly demand cache
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

  // ── 2. Load all profiles and named resources for this role ────────────
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
    orderBy: [{ ownerKind: 'asc' }, { id: 'asc' }],
  })

  if (allProfiles.length === 0) {
    throw new TransferError(409, `No capacity profiles found for resource type "${resourceType.name}"`)
  }

  // ── 3. STRICT PRE-VALIDATION — fail closed before any write ──────────
  // Use the repository's existing strict planner-owner-state validator.
  // This checks every profile for exact ownership shape, FK consistency,
  // duplicate owners, planning basis, source validity, and segment structure.
  const ownershipConflicts = await validatePlannerOwnerState(
    tx,
    projectId,
    resourceTypeId,
  )

  if (ownershipConflicts.length > 0) {
    const detail = ownershipConflicts
      .map(c => c.namedResourceName ? `"${c.namedResourceName}"` : c.resourceTypeName)
      .join(', ')
    throw new TransferError(
      409,
      `Invalid planner ownership for resource type "${resourceType.name}": ${detail}. ` +
      'Repair required before transfer.',
    )
  }

  // ── 4. Classify profiles ─────────────────────────────────────────────
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

  // Role profile must be Squad Planner-owned with valid structure
  assertPlannerRoleProfile(roleProfile, resourceTypeId, resourceType.name)

  // Classify each resource profile
  const plannerProfiles: typeof resourceProfiles = []
  const protectedProfileIds: string[] = []

  for (const profile of resourceProfiles) {
    if (!profile.namedResourceId) {
      protectedProfileIds.push(profile.id)
      continue
    }

    const classification = classifyTransferProfile(profile)

    if (classification === 'planner_created' || classification === 'legacy_planner') {
      plannerProfiles.push(profile)
    } else {
      protectedProfileIds.push(profile.id)
    }
  }

  // ── 5. Validate no duplicate named-resource ownership ────────────────
  const seenNamedResourceIds = new Set<string>()
  for (const profile of resourceProfiles) {
    if (!profile.namedResourceId) continue
    if (seenNamedResourceIds.has(profile.namedResourceId)) {
      throw new TransferError(
        409,
        `Duplicate capacity profile for named resource "${profile.namedResourceId}" — repair required before transfer`,
      )
    }
    seenNamedResourceIds.add(profile.namedResourceId)
  }

  // ── 6. Perform the transfer ──────────────────────────────────────────

  // 6a. Transfer role-level profile and its segments
  await tx.capacityProfile.update({
    where: { id: roleProfile.id },
    data: { source: 'MANUAL' },
  })
  if (roleProfile.segments && roleProfile.segments.length > 0) {
    const segmentIds = roleProfile.segments.map(s => s.id)
    await tx.capacitySegment.updateMany({
      where: { id: { in: segmentIds } },
      data: { source: 'MANUAL' },
    })
  }

  // 6b. Transfer planner-created resource profiles and their segments
  for (const profile of plannerProfiles) {
    await tx.capacityProfile.update({
      where: { id: profile.id },
      data: { source: 'MANUAL' },
    })
    if (profile.segments && profile.segments.length > 0) {
      const segmentIds = profile.segments.map(s => s.id)
      await tx.capacitySegment.updateMany({
        where: { id: { in: segmentIds } },
        data: { source: 'MANUAL' },
      })
    }
  }

  // ── 7. Update legacy compatibility projections ───────────────────────
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

  for (const profile of plannerProfiles) {
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

  // ── 8. Update legacy metadata on transferred profiles ────────────────
  await writeTransferLegacyMetadata(tx, roleProfile, roleProjection, roleSegments)

  for (const profile of plannerProfiles) {
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
      await writeTransferLegacyMetadata(tx, profile, proj, segs)
    }
  }

  // ── 9. Invalidate weekly demand cache ───────────────────────────────
  await tx.project.update({
    where: { id: projectId },
    data: { weeklyDemandCache: {} },
  })

  return {
    profilesTransferred: 1 + plannerProfiles.length,
    plannedResourceProfilesTransferred: plannerProfiles.filter(
      p => p.ownerKind === 'PLANNED_RESOURCE',
    ).length,
    roleProfileTransferred: true,
    protectedProfileIds,
  }
}

// ─── Classification helper ──────────────────────────────────────────────────

type ProfileClassification = 'planner_created' | 'legacy_planner' | 'protected'

/**
 * Classify a named-resource capacity profile for transfer eligibility.
 *
 * - `planner_created`:  PLANNED_RESOURCE + SQUAD_PLANNER + CAPACITY_PROFILE
 * - `legacy_planner`:   NAMED_PERSON + SQUAD_PLANNER + CAPACITY_PROFILE
 * - `protected`:        Everything else (MANUAL, FIXED, NAMED_PERSON, etc.)
 */
function classifyTransferProfile(
  profile: {
    ownerKind: string
    source: string
    planningBasis: string
    namedResourceId: string | null
    resourceTypeId: string | null
  },
): ProfileClassification {
  if (!profile.namedResourceId) return 'protected'

  // Squad Planner-created PLANNED_RESOURCE profiles
  if (
    profile.ownerKind === 'PLANNED_RESOURCE'
    && profile.source === 'SQUAD_PLANNER'
    && profile.planningBasis === 'CAPACITY_PROFILE'
    && profile.resourceTypeId === null
  ) {
    return 'planner_created'
  }

  // Legacy Squad Planner-created NAMED_PERSON profiles
  if (
    profile.ownerKind === 'NAMED_PERSON'
    && profile.source === 'SQUAD_PLANNER'
    && profile.planningBasis === 'CAPACITY_PROFILE'
    && profile.resourceTypeId === null
  ) {
    return 'legacy_planner'
  }

  return 'protected'
}

// ─── Role profile assertion ─────────────────────────────────────────────────

/**
 * Assert that a ROLE profile has the exact expected Squad Planner shape.
 */
function assertPlannerRoleProfile(
  profile: {
    ownerKind: string
    source: string
    planningBasis: string
    resourceTypeId: string | null
    namedResourceId: string | null
  },
  expectedResourceTypeId: string,
  resourceTypeName: string,
): void {
  if (profile.ownerKind !== 'ROLE') {
    throw new TransferError(
      409,
      `Role "${resourceTypeName}" role-level profile has invalid owner kind: expected ROLE, got ${String(profile.ownerKind)}`,
    )
  }
  if (profile.source !== 'SQUAD_PLANNER') {
    const sourceLabel = String(profile.source)
    throw new TransferError(
      409,
      `Role "${resourceTypeName}" is not managed by Squad Planner. Current source: ${sourceLabel}. Only Squad Planner-managed roles can be transferred.`,
    )
  }
  if (profile.planningBasis !== 'CAPACITY_PROFILE') {
    throw new TransferError(
      409,
      `Role "${resourceTypeName}" role-level profile has invalid planning basis: expected CAPACITY_PROFILE, got ${String(profile.planningBasis)}`,
    )
  }
  if (profile.resourceTypeId !== expectedResourceTypeId || profile.namedResourceId !== null) {
    throw new TransferError(
      409,
      `Role "${resourceTypeName}" role-level profile has malformed foreign key ownership`,
    )
  }
}

// ─── Legacy metadata writer ─────────────────────────────────────────────────

/**
 * Write transfer legacy metadata to a single profile.
 */
async function writeTransferLegacyMetadata(
  tx: TxClient,
  profile: { id: string; defaultPercent?: number | null; startWeek?: number | null; endWeek?: number | null },
  projection: { allocationMode: string; allocationPercent: number | null; allocationStartWeek: number | null; allocationEndWeek: number | null; lossy: boolean; lossReason?: string } | null,
  _segments: Array<{ startWeek: number; endWeek: number; capacityPercent: number }>,
): Promise<void> {
  await tx.capacityProfile.update({
    where: { id: profile.id },
    data: {
      legacy: {
        version: 1,
        writer: 'transfer-to-manual',
        allocationMode: projection?.allocationMode ?? 'CAPACITY_PLAN',
        allocationPercent: projection?.allocationPercent ?? profile.defaultPercent ?? 100,
        allocationStartWeek: projection?.allocationStartWeek ?? profile.startWeek,
        allocationEndWeek: projection?.allocationEndWeek ?? profile.endWeek,
        lossy: projection?.lossy ?? false,
        lossReason: projection?.lossReason ?? null,
      } satisfies Record<string, unknown> as any,
    },
  })
}

