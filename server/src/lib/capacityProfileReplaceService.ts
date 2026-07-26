/**
 * capacityProfileReplaceService.ts — Transaction-based service for
 * replacing (upserting) a capacity profile for a role or named person,
 * and applying the role-level default to inherited named resources.
 *
 * This is the write path for issue #363: the PUT endpoint that replaces
 * an owner's capacity profile and projects back to legacy fields.
 *
 * ## Exports
 *
 * - `replaceCapacityProfile` — Replace/create a profile for a single owner (PUT handler).
 * - `applyRoleDefaultToInheritedNRs` — Apply a new role default to inherited
 *   named resources (used by resourceTypes.ts after role-level RT updates).
 */

import { projectCapacityProfileToLegacyAllocation } from './capacityProfileLegacyProjection.js'
import type { LegacyAllocationProjection } from './capacityProfileLegacyProjection.js'
import { mapPersistedProfilesToDTOs } from './capacityProfileMapping.js'
import type { CapacityProfileDTO } from './capacityProfileMapping.js'
import { resolveRoleDefaultForMutation } from './resolveRoleDefaultForMutation.js'
import { classifyNRsForRoleUpdate } from './classifyNRsForRoleUpdate.js'
import type { PrismaClient } from '@prisma/client'

/** Inferred Prisma transaction client type used throughout this module. */
type TxClient = Parameters<Parameters<PrismaClient['$transaction']>[0]>[0]
// ─── Public types ────────────────────────────────────────────────────────────

export type ReplaceOwnerKind = 'ROLE' | 'NAMED_PERSON'

export interface ReplaceSegmentInput {
  startWeek: number
  endWeek: number
  capacityPercent: number
}

export interface ReplaceBody {
  planningBasis: 'DEMAND_FOLLOWING' | 'AVAILABILITY_WINDOW' | 'WHOLE_PROJECT_ALLOCATION' | 'CAPACITY_PROFILE'
  defaultPercent?: number | null
  startWeek?: number | null
  endWeek?: number | null
  segments?: ReplaceSegmentInput[]
}

// ─── Error helpers ───────────────────────────────────────────────────────────

export class ServiceError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = 'ServiceError'
    this.status = status
  }
}

// ─── Role-inheritance helper (used by resourceTypes.ts) ──────────────────────

/**
 * Apply a new role-level default (capacity profile) to all inherited
 * named resources by updating only their legacy compatibility fields.
 *
 * This does NOT create independent CapacityProfile records — the
 * role-level profile remains the source of truth for inherited NRs.
 *
 * @param tx              Transaction client
 */
export async function applyRoleDefaultToInheritedNRs(
  tx: TxClient,
  inheritedNRIds: string[],
  projection: LegacyAllocationProjection,
): Promise<void> {
  if (!inheritedNRIds || inheritedNRIds.length === 0) return

  // Update legacy NamedResource fields for backward compatibility.
  // Do NOT create independent CapacityProfile records for inherited NRs —
  // the role-level profile is the source of truth for inherited resources.
  await tx.namedResource.updateMany({
    where: { id: { in: inheritedNRIds } },
    data: {
      allocationMode: projection.allocationMode,
      allocationPercent: projection.allocationPercent ?? 100,
      allocationStartWeek: projection.allocationStartWeek,
      allocationEndWeek: projection.allocationEndWeek,
      allocationPct: Math.round(projection.allocationPercent ?? 100),
      startWeek: projection.allocationStartWeek,
      endWeek: projection.allocationEndWeek,
    },
  })
}

// ─── PUT replace handler ─────────────────────────────────────────────────────

/**
 * Replace (create or update) a capacity profile for an owner within a
 * Prisma transaction.
 *
 * @param tx        Prisma transaction client
 * @param projectId Project ID
 * @param ownerKind Owner kind (ROLE or NAMED_PERSON)
 * @param ownerId   ResourceType ID (ROLE) or NamedResource ID (NAMED_PERSON)
 * @param body      ReplaceCapacityProfileRequest body
 * @returns         Persisted CapacityProfileDTO
 * @throws ServiceError with appropriate HTTP status on validation/ownership failure
 */
export async function replaceCapacityProfile(
  tx: TxClient,
  projectId: string,
  ownerKind: ReplaceOwnerKind,
  ownerId: string,
  body: ReplaceBody,
  userId?: string,
): Promise<CapacityProfileDTO> {
  const { planningBasis, defaultPercent, startWeek, endWeek, segments } = body

  // ── 0. Transactional project ownership revalidation ──────────────────
  if (userId) {
    const project = await tx.project.findFirst({
      where: { id: projectId, ownerId: userId },
      select: { id: true },
    })
    if (!project) {
      throw new ServiceError(404, 'Project not found or access denied')
    }
  }
  // ── 1. Verify owner exists and belongs to project ─────────────────────
  if (ownerKind === 'ROLE') {
    const rt = await tx.resourceType.findFirst({
      where: { id: ownerId, projectId },
      select: { id: true },
    })
    if (!rt) {
      throw new ServiceError(404, `ResourceType "${ownerId}" not found in project`)
    }
  } else {
    const nrDirect = await tx.namedResource.findFirst({
      where: { id: ownerId, resourceType: { projectId } },
      select: { id: true },
    })
    if (!nrDirect) {
      throw new ServiceError(404, `NamedResource "${ownerId}" not found in project`)
    }
  }

  // ── 2. Fail-closed: guard against ambiguous or protected state ─────────
  const existingProfiles = await tx.capacityProfile.findMany({
    where: {
      OR: [
        { resourceTypeId: ownerId },
        { namedResourceId: ownerId },
      ],
    },
    select: {
      id: true,
      projectId: true,
      ownerKind: true,
      source: true,
      resourceTypeId: true,
      namedResourceId: true,
    },
  })

  if (existingProfiles.length > 1) {
    throw new ServiceError(409, `Multiple capacity profiles exist for this ${ownerKind.toLowerCase()}`)
  }

  for (const profile of existingProfiles) {
    const persistedOwnerKind = profile.ownerKind as string
    if (persistedOwnerKind === 'PLANNED_RESOURCE') {
      throw new ServiceError(409, 'Cannot replace a PLANNED_RESOURCE profile manually')
    }
    if (profile.source === 'SQUAD_PLANNER') {
      throw new ServiceError(409, 'Cannot overwrite a SQUAD_PLANNER profile manually')
    }

    const hasExactlyOneOwner = (profile.resourceTypeId === null) !== (profile.namedResourceId === null)
    const validRoleOwner = ownerKind === 'ROLE'
      && persistedOwnerKind === 'ROLE'
      && profile.resourceTypeId === ownerId
      && profile.namedResourceId === null
    const validNamedPersonOwner = ownerKind === 'NAMED_PERSON'
      && persistedOwnerKind === 'NAMED_PERSON'
      && profile.namedResourceId === ownerId
      && profile.resourceTypeId === null

    if (
      profile.projectId !== projectId
      || !hasExactlyOneOwner
      || (!validRoleOwner && !validNamedPersonOwner)
    ) {
      throw new ServiceError(409, `Malformed persisted ownership for requested ${ownerKind} profile`)
    }
  }


  const existingId = existingProfiles.length === 1 ? existingProfiles[0].id : null
  // ── 3. [ROLE only] Classify inherited named resources ──────────────────
  let inheritedNRIds: string[] = []
  if (ownerKind === 'ROLE') {
    // Load current RT for old-role-default fallback
    const rtRecord = await tx.resourceType.findFirst({
      where: { id: ownerId },
      select: { allocationMode: true, allocationPercent: true, allocationStartWeek: true, allocationEndWeek: true },
    })

    // Load existing role profiles with segments
    const oldRoleProfiles = await tx.capacityProfile.findMany({
      where: { resourceTypeId: ownerId, namedResourceId: null, projectId },
      include: { segments: true },
    })

    // Resolve authoritative pre-mutation role default
    const oldRoleDefault = resolveRoleDefaultForMutation({
      resourceType: rtRecord!,
      roleProfiles: oldRoleProfiles as unknown as readonly any[],
    })

    // Load all named resources for this ResourceType
    const nrs = await tx.namedResource.findMany({
      where: { resourceTypeId: ownerId },
      orderBy: { createdAt: 'asc' },
    })

    // Load NR capacity profiles with segments
    const nrProfileRows = nrs.length > 0
      ? await tx.capacityProfile.findMany({
          where: { namedResourceId: { in: nrs.map((n: { id: string }) => n.id) } },
          include: { segments: true },
        })
      : []

    // Classify: which NRs inherit the role default vs. are explicitly custom
    const classification = classifyNRsForRoleUpdate(
      nrs as any,
      nrProfileRows as any,
      {
        allocationMode: oldRoleDefault.allocationMode,
        allocationPercent: oldRoleDefault.allocationPercent,
        allocationStartWeek: oldRoleDefault.allocationStartWeek,
        allocationEndWeek: oldRoleDefault.allocationEndWeek,
      },
    )

    inheritedNRIds = classification.inheritedNRIds
  }

  // ── 4. Prepare segment data with deterministic ordering ────────────────
  const sortedSegments = Array.isArray(segments) && segments.length > 0
    ? [...segments].sort((a, b) => {
        return a.startWeek - b.startWeek
          || a.endWeek - b.endWeek
          || a.capacityPercent - b.capacityPercent
      })
    : []

  // ── 5. Persist capacity profile ───────────────────────────────────────
  if (existingId) {
    // Update existing profile — preserve id, replace segments
    await tx.capacityProfile.update({
      where: { id: existingId },
      data: {
        planningBasis,
        source: 'MANUAL',
        defaultPercent: defaultPercent ?? null,
        startWeek: startWeek !== undefined ? startWeek : null,
        endWeek: endWeek !== undefined ? endWeek : null,
      },
    })

    // Delete old segments and create new ones
    await tx.capacitySegment.deleteMany({ where: { capacityProfileId: existingId } })

    for (let i = 0; i < sortedSegments.length; i++) {
      const seg = sortedSegments[i]
      await tx.capacitySegment.create({
        data: {
          capacityProfileId: existingId,
          startWeek: seg.startWeek,
          endWeek: seg.endWeek,
          capacityPercent: seg.capacityPercent,
          source: 'MANUAL',
        },
      })
    }
  } else {
    // Create new profile — separate paths by ownerKind for type safety
    const created = ownerKind === 'ROLE'
      ? await tx.capacityProfile.create({
          data: {
            projectId,
            ownerKind,
            planningBasis,
            source: 'MANUAL',
            defaultPercent: defaultPercent ?? null,
            startWeek: startWeek !== undefined ? startWeek : null,
            endWeek: endWeek !== undefined ? endWeek : null,
            resourceTypeId: ownerId,
            namedResourceId: null,
          },
        })
      : await tx.capacityProfile.create({
          data: {
            projectId,
            ownerKind,
            planningBasis,
            source: 'MANUAL',
            defaultPercent: defaultPercent ?? null,
            startWeek: startWeek !== undefined ? startWeek : null,
            endWeek: endWeek !== undefined ? endWeek : null,
            namedResourceId: ownerId,
            resourceTypeId: null,
          },
        })

    // Create segments with deterministic ordering
    for (let i = 0; i < sortedSegments.length; i++) {
      const seg = sortedSegments[i]
      await tx.capacitySegment.create({
        data: {
          capacityProfileId: created.id,
          startWeek: seg.startWeek,
          endWeek: seg.endWeek,
          capacityPercent: seg.capacityPercent,
          source: 'MANUAL',
        },
      })
    }
  }


  // Track persisted profile ID for legacy metadata
  const profileId = existingId ?? (ownerKind === 'ROLE'
    ? (await tx.capacityProfile.findFirstOrThrow({
        where: { resourceTypeId: ownerId, namedResourceId: null, projectId },
        select: { id: true },
        orderBy: { createdAt: 'desc' },
      })).id
    : (await tx.capacityProfile.findFirstOrThrow({
        where: { namedResourceId: ownerId, resourceTypeId: null, projectId },
        select: { id: true },
        orderBy: { createdAt: 'desc' },
      })).id
  )
  // ── 6. Project back to legacy fields ──────────────────────────────────
  const camelPlanningBasis = planningBasis.toLowerCase().replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())

  const projectionInput = {
    planningBasis: camelPlanningBasis,
    source: 'manual',
    defaultPercent: defaultPercent ?? null,
    startWeek: startWeek !== undefined ? startWeek : null,
    endWeek: endWeek !== undefined ? endWeek : null,
    segments: sortedSegments.map(s => ({
      startWeek: s.startWeek,
      endWeek: s.endWeek,
      capacityPercent: s.capacityPercent,
    })),
  }

  const projection = projectCapacityProfileToLegacyAllocation(projectionInput)

  // ── 7. Write projection to legacy compatibility fields ────────────────
  if (projection) {
    if (ownerKind === 'ROLE') {
      await tx.resourceType.update({
        where: { id: ownerId },
        data: {
          allocationMode: projection.allocationMode,
          allocationPercent: projection.allocationPercent ?? 100,
          allocationStartWeek: projection.allocationStartWeek,
          allocationEndWeek: projection.allocationEndWeek,
        },
      })

      // Apply role default to inherited named resources (compatibility fields only)
      if (inheritedNRIds.length > 0) {
        await applyRoleDefaultToInheritedNRs(tx, inheritedNRIds, projection)
      }
    } else {
      await tx.namedResource.update({
        where: { id: ownerId },
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

  // ── 8. Persist lossy projection metadata ──────────────────────────────
  if (projection && profileId) {
    await tx.capacityProfile.update({
      where: { id: profileId },
      data: {
        legacy: {
          version: 1,
          writer: 'manual-editor',
          allocationMode: projection.allocationMode,
          allocationPercent: projection.allocationPercent ?? 100,
          allocationStartWeek: projection.allocationStartWeek,
          allocationEndWeek: projection.allocationEndWeek,
          lossy: projection.lossy,
          lossReason: projection.lossReason ?? null,
        },
      },
    })
  }

  // ── 8. Invalidate weekly demand cache ──────────────────────────────────
  await tx.project.update({
    where: { id: projectId },
    data: { weeklyDemandCache: {} },
  })

  // ── 9. Read back and return as DTO ────────────────────────────────────
  const persistedProfile = await tx.capacityProfile.findFirst({
    where: existingId
      ? { id: existingId }
      : ownerKind === 'ROLE'
        ? { resourceTypeId: ownerId, projectId }
        : { namedResourceId: ownerId, projectId },
    include: {
      segments: {
        orderBy: [
          { startWeek: 'asc' },
          { endWeek: 'asc' },
          { capacityPercent: 'asc' },
        ],
      },
    },
  })

  if (!persistedProfile) {
    throw new ServiceError(500, 'Failed to read back persisted profile')
  }

  // Build lookup maps for DTO conversion
  const resourceTypeById = new Map<string, { id: string; name: string }>()
  if (ownerKind === 'ROLE') {
    const rt = await tx.resourceType.findUnique({
      where: { id: ownerId },
      select: { id: true, name: true },
    })
    if (rt) resourceTypeById.set(rt.id, { id: rt.id, name: rt.name })
  }

  const namedResourceById = new Map<string, { id: string; name: string; resourceTypeId: string }>()
  if (ownerKind === 'NAMED_PERSON') {
    const nrLookup = await tx.namedResource.findFirst({
      where: { id: ownerId },
      select: { id: true, name: true, resourceTypeId: true },
    })
    if (nrLookup) {
      namedResourceById.set(nrLookup.id, { id: nrLookup.id, name: nrLookup.name, resourceTypeId: nrLookup.resourceTypeId! })
    }
  }

  const dtos = mapPersistedProfilesToDTOs(
    [persistedProfile],
    resourceTypeById,
    namedResourceById,
  )

  return dtos[0]
}
