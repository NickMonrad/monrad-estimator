/**
 * capacityProfileReplaceService.ts — Transaction-based service for
 * replacing (upserting) a capacity profile for a role or named person,
 * and keeping inherited named-resource profiles tracking the role default.
 *
 * This is the write path for issue #363: the PUT endpoint that replaces
 * an owner's capacity profile. Authoritative profile state only — no
 * ResourceType/NamedResource candidate-column reads or writes (issue #418).
 *
 * ## Exports
 *
 * - `replaceCapacityProfile` — Replace/create a profile for a single owner (PUT handler).
 */

import { projectCapacityProfileToLegacyAllocation } from './capacityProfileLegacyProjection.js'
import { mapPersistedProfilesToDTOs } from './capacityProfileMapping.js'
import type { CapacityProfileDTO } from './capacityProfileMapping.js'
import { loadAndValidateOwnerProfile, type ValidatedOwnerProfile } from './ownerProfileLoader.js'
import { CapacityIntegrityError } from './capacityIntegrityError.js'
import { classifyNRsForRoleUpdate } from './classifyNRsForRoleUpdate.js'
import { isRoleDefaultClone } from './roleProfileClonePolicy.js'
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
  userId: string,
): Promise<CapacityProfileDTO> {
  const { planningBasis, defaultPercent, startWeek, endWeek, segments } = body

  // ── 0. Transactional project ownership revalidation ──────────────────
  const project = await tx.project.findFirst({
    where: { id: projectId, ownerId: userId },
    select: { id: true },
  })
  if (!project) {
    throw new ServiceError(404, 'Project not found or access denied')
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
  // Authoritative profile state only (issue #418): the validated ROLE profile
  // supplies the old role default shape; every named resource must have
  // exactly one validated profile.
  let inheritedNRProfiles: Array<{
    id: string
    planningBasis: string
    defaultPercent: number | null
    startWeek: number | null
    endWeek: number | null
    segments: Array<{ id: string; startWeek: number; endWeek: number; capacityPercent: number; source: string }>
  }> = []
  if (ownerKind === 'ROLE') {
    // Load and validate the authoritative pre-mutation role profile (fails
    // closed on duplicate, malformed or cross-project state). A genuinely
    // missing role profile is the CREATE path (the documented
    // "replace (create or update)" contract): after Reset Planning (issue
    // #449) every profile is gone and the user builds the new plan through
    // this surface. With no prior role profile there is nothing for named
    // resources to inherit, so the inherited-NR classification is skipped.
    let oldRoleProfile: ValidatedOwnerProfile | null = null
    try {
      oldRoleProfile = await loadAndValidateOwnerProfile({
        tx,
        projectId,
        ownerKind: 'ROLE',
        ownerId,
      })
    } catch (error) {
      if (!(error instanceof CapacityIntegrityError) || existingProfiles.length > 0) {
        throw error
      }
    }

    if (oldRoleProfile) {
      // Load all named resources for this ResourceType
      const nrs = await tx.namedResource.findMany({
        where: { resourceTypeId: ownerId },
        orderBy: { createdAt: 'asc' },
      })

      // Load NR capacity profiles with segments and validate exactly one per NR
      const nrProfileRows = nrs.length > 0
        ? await tx.capacityProfile.findMany({
            where: { namedResourceId: { in: nrs.map((n: { id: string }) => n.id) }, projectId },
            include: { segments: true },
          })
        : []

      const profilesByNRId = new Map<string, any[]>()
      for (const profile of nrProfileRows) {
        if (!profile.namedResourceId) continue
        const arr = profilesByNRId.get(profile.namedResourceId) ?? []
        arr.push(profile)
        profilesByNRId.set(profile.namedResourceId, arr)
      }
      for (const nr of nrs) {
        const profiles = profilesByNRId.get(nr.id) ?? []
        if (profiles.length === 0) {
          throw new ServiceError(409, `Missing capacity profile for named resource ${nr.id}`)
        }
        if (profiles.length > 1) {
          throw new ServiceError(409, `Multiple capacity profiles exist for named resource ${nr.id}`)
        }
      }

      // Classify: which NRs inherit the role default vs. are explicitly custom
      const classification = classifyNRsForRoleUpdate(
        nrs as any,
        nrProfileRows as any,
        {
          planningBasis: oldRoleProfile.planningBasis,
          defaultPercent: oldRoleProfile.defaultPercent,
          startWeek: oldRoleProfile.startWeek,
          endWeek: oldRoleProfile.endWeek,
          segments: oldRoleProfile.segments.map(s => ({
            startWeek: s.startWeek,
            endWeek: s.endWeek,
            capacityPercent: s.capacityPercent,
          })),
        },
      )

      inheritedNRProfiles = classification.inheritedNRIds
        .map(id => profilesByNRId.get(id)?.[0])
        .filter((profile): profile is NonNullable<typeof profile> => profile != null)
    }
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
  // ── 6. Project the new profile for provenance metadata ───────────────
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

  // ── 7. Keep inherited named-resource profiles tracking the role default ─
  // The profile-first equivalent of the retired legacy-column projection
  // (issue #418): inherited system-generated clones (ROLE_DEFAULT marker)
  // mirror the new role profile shape so a later count reduction can still
  // classify them as inherited. Segment IDs are preserved by updating
  // existing segments in place; provenance (source, legacy writer marker) is
  // untouched so generated clones remain removable. Sync-derived scalar
  // profiles without the marker are left untouched — their classification
  // follows the authoritative profile-shape comparison.
  if (ownerKind === 'ROLE' && inheritedNRProfiles.length > 0) {
    const sortedRoleSegments = [...sortedSegments].map((s, idx) => ({ ...s, idx }))
    for (const inheritedProfile of inheritedNRProfiles) {
      if (!isRoleDefaultClone({ legacy: (inheritedProfile as { legacy?: unknown }).legacy })) continue
      await tx.capacityProfile.update({
        where: { id: inheritedProfile.id },
        data: {
          planningBasis,
          defaultPercent: defaultPercent ?? null,
          startWeek: startWeek !== undefined ? startWeek : null,
          endWeek: endWeek !== undefined ? endWeek : null,
        },
      })
      const existingSegments = [...(inheritedProfile.segments ?? [])]
        .sort((a, b) => a.startWeek - b.startWeek || a.endWeek - b.endWeek)
      // Update existing segments in place (preserve IDs), create extras, delete leftovers.
      for (let i = 0; i < sortedRoleSegments.length; i++) {
        const seg = sortedRoleSegments[i]
        if (i < existingSegments.length) {
          await tx.capacitySegment.update({
            where: { id: existingSegments[i].id },
            data: {
              startWeek: seg.startWeek,
              endWeek: seg.endWeek,
              capacityPercent: seg.capacityPercent,
              source: 'MANUAL',
            },
          })
        } else {
          await tx.capacitySegment.create({
            data: {
              capacityProfileId: inheritedProfile.id,
              startWeek: seg.startWeek,
              endWeek: seg.endWeek,
              capacityPercent: seg.capacityPercent,
              source: 'MANUAL',
            },
          })
        }
      }
      if (existingSegments.length > sortedRoleSegments.length) {
        const surplusIds = existingSegments
          .slice(sortedRoleSegments.length)
          .map(s => s.id)
        await tx.capacitySegment.deleteMany({
          where: { id: { in: surplusIds } },
        })
      }
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
