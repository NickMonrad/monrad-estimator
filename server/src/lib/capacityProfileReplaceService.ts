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

// ─── Public types ────────────────────────────────────────────────────────────

export type ReplaceOwnerKind = 'ROLE' | 'NAMED_PERSON'

export interface ReplaceSegmentInput {
  startWeek: number
  endWeek: number
  capacityPercent: number
}

export interface ReplaceBody {
  planningBasis: string
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
 * @param inheritedNRIds  NR IDs classified as ROLE_DEFAULT (inherited)
 * @param projection      Projected legacy allocation from the role profile
 */
export async function applyRoleDefaultToInheritedNRs(
  tx: any,
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
  tx: any,
  projectId: string,
  ownerKind: ReplaceOwnerKind,
  ownerId: string,
  body: ReplaceBody,
): Promise<CapacityProfileDTO> {
  const { planningBasis, defaultPercent, startWeek, endWeek, segments } = body

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

  // ── 2. Check planner-owned boundary ───────────────────────────────────
  const existingProfiles = await tx.capacityProfile.findMany({
    where: ownerKind === 'ROLE'
      ? { resourceTypeId: ownerId, projectId }
      : { namedResourceId: ownerId, projectId },
    select: { id: true, ownerKind: true, source: true },
  })

  for (const ep of existingProfiles) {
    if (ep.ownerKind === 'PLANNED_RESOURCE') {
      throw new ServiceError(409, 'Cannot replace a PLANNED_RESOURCE profile manually')
    }
    if (ep.source === 'SQUAD_PLANNER') {
      throw new ServiceError(409, 'Cannot overwrite a SQUAD_PLANNER profile manually')
    }
  }

  const existingId = existingProfiles.length > 0 ? existingProfiles[0].id : null

  // ── 3. Prepare segment data with deterministic ordering ───────────────
  const sortedSegments = Array.isArray(segments) && segments.length > 0
    ? [...segments].sort((a, b) => {
        return a.startWeek - b.startWeek
          || a.endWeek - b.endWeek
          || a.capacityPercent - b.capacityPercent
      })
    : []

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

    // Delete existing segments
    await tx.capacitySegment.deleteMany({
      where: { capacityProfileId: existingId },
    })

    // Create new segments with deterministic ordering
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

  // ── 5. Project back to legacy fields ─────────────────────────────────
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

  // ── 6. Write projection to legacy fields ─────────────────────────────
  if (projection) {
    if (ownerKind === 'ROLE') {
      await tx.resourceType.update({
        where: { id: ownerId },
        data: {
          allocationMode: projection.allocationMode,
          allocationPercent: projection.allocationPercent,
          allocationStartWeek: projection.allocationStartWeek,
          allocationEndWeek: projection.allocationEndWeek,
        },
      })

      // Inherited named resources are NOT updated here — the role-level
      // profile is the source of truth. The legacy resourceTypes.ts PUT
      // route handles inherited-NR field updates separately.
    } else {
      await tx.namedResource.update({
        where: { id: ownerId },
        data: {
          allocationMode: projection.allocationMode,
          allocationPercent: projection.allocationPercent,
          allocationPct: projection.allocationPercent != null ? Math.round(projection.allocationPercent) : null,
          allocationStartWeek: projection.allocationStartWeek,
          allocationEndWeek: projection.allocationEndWeek,
          startWeek: projection.allocationStartWeek,
          endWeek: projection.allocationEndWeek,
        },
      })
    }
  }

  // ── 7. Clear project weeklyDemandCache ────────────────────────────────
  await tx.project.update({
    where: { id: projectId },
    data: { weeklyDemandCache: {} },
  })

  // ── 8. Read back and return as DTO ────────────────────────────────────
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

  // Build resource-type and named-resource maps for DTO conversion
  const projectData = await tx.project.findFirst({
    where: { id: projectId },
    select: {
      resourceTypes: {
        select: { id: true, name: true },
      },
    },
  })

  const resourceTypeById = new Map<string, { id: string; name: string }>()
  const namedResourceById = new Map<string, { id: string; name: string; resourceTypeId: string }>()

  if (projectData?.resourceTypes) {
    for (const rt of projectData.resourceTypes) {
      resourceTypeById.set(rt.id, { id: rt.id, name: rt.name })
    }
  }

  if (ownerKind === 'NAMED_PERSON') {
    const nrLookup = await tx.namedResource.findFirst({
      where: { id: ownerId },
      select: { id: true, name: true, resourceTypeId: true },
    })
    if (nrLookup) {
      namedResourceById.set(nrLookup.id, { id: nrLookup.id, name: nrLookup.name, resourceTypeId: nrLookup.resourceTypeId })
    }
  }

  const dtos = mapPersistedProfilesToDTOs(
    [persistedProfile],
    resourceTypeById,
    namedResourceById,
  )

  return dtos[0]
}
