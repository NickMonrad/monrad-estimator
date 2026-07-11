/**
 * syncCapacityProfilesForProject — Idempotent runtime sync helper.
 *
 * Keeps the additive CapacityProfile / CapacitySegment read model in sync
 * with the authoritative legacy fields (ResourceType, NamedResource,
 * CapacityPlan periods).
 *
 * Designed to be called inside an existing transaction so that if the sync
 * fails, the legacy write also rolls back.
 *
 * @module syncCapacityProfiles
 */

import type { $Enums } from '@prisma/client'
import { materializeCapacityPlanResources } from './capacityPlanMaterialisation.js'
import { mapProjectToCapacityProfiles } from './capacityProfileMapping.js'
import type {
  CapacityProfileResourceTypeLike,
  CapacityProfileNamedResourceLike,
  CapacityPlanSlotInput,
} from './capacityProfileMapping.js'
import { compareCapacityProfiles } from './reconcileCapacityProfiles.js'

// ─── Enum mapping helpers (DTO lowercase → Prisma UPPER_CASE) ─────────────

export function toPrismaOwnerKind(
  kind: string,
): $Enums.CapacityProfileOwnerKind {
  switch (kind) {
    case 'role': return 'ROLE' as $Enums.CapacityProfileOwnerKind
    case 'namedPerson': return 'NAMED_PERSON' as $Enums.CapacityProfileOwnerKind
    case 'plannedResource': return 'PLANNED_RESOURCE' as $Enums.CapacityProfileOwnerKind
    default: throw new Error(`Unknown owner kind: ${kind}`)
  }
}

export function toPrismaPlanningBasis(
  basis: string,
): $Enums.CapacityProfilePlanningBasis {
  switch (basis) {
    case 'demandFollowing': return 'DEMAND_FOLLOWING' as $Enums.CapacityProfilePlanningBasis
    case 'availabilityWindow': return 'AVAILABILITY_WINDOW' as $Enums.CapacityProfilePlanningBasis
    case 'wholeProjectAllocation': return 'WHOLE_PROJECT_ALLOCATION' as $Enums.CapacityProfilePlanningBasis
    case 'capacityProfile': return 'CAPACITY_PROFILE' as $Enums.CapacityProfilePlanningBasis
    default: throw new Error(`Unknown planning basis: ${basis}`)
  }
}

export function toPrismaSource(
  source: string,
): $Enums.CapacityProfileSource {
  switch (source) {
    case 'fixed': return 'FIXED' as $Enums.CapacityProfileSource
    case 'manual': return 'MANUAL' as $Enums.CapacityProfileSource
    case 'availabilityWindow': return 'AVAILABILITY_WINDOW' as $Enums.CapacityProfileSource
    case 'squadPlanner': return 'SQUAD_PLANNER' as $Enums.CapacityProfileSource
    case 'imported': return 'IMPORTED' as $Enums.CapacityProfileSource
    case 'derived': return 'DERIVED' as $Enums.CapacityProfileSource
    case 'legacy': return 'LEGACY' as $Enums.CapacityProfileSource
    default: throw new Error(`Unknown source: ${source}`)
  }
}
// ─── Reverse enum mapping (Prisma UPPER_CASE → DTO camelCase) ──────────

export function prismaOwnerKindToDtoKind(kind: string): 'role' | 'namedPerson' | 'plannedResource' {
  switch (kind) {
    case 'ROLE':
      return 'role'
    case 'NAMED_PERSON':
      return 'namedPerson'
    case 'PLANNED_RESOURCE':
      return 'plannedResource'
    default:
      throw new Error(`Unknown persisted owner kind: ${kind}`)
  }
}


// ─── Sync result type ──────────────────────────────────────────────────────

export interface SyncResult {
  profilesCreated: number
  profilesUpdated: number
  profilesDeleted: number
  segmentsCreated: number
  segmentsDeleted: number
}

export interface SyncOptions {
  /** Named resource IDs whose capacity profiles should not be overwritten by the legacy-derived sync. */
  preserveNamedResourceIds?: string[]
  /** ResourceType (role) IDs whose capacity profiles should not be overwritten by the legacy-derived sync. */
  preserveResourceTypeIds?: string[]
  /**
   * Restrict the sync to only profiles for this ResourceType and its named resources.
   * When set, profiles for all other ResourceTypes are never created, updated, or deleted.
   */
  scopeResourceTypeId?: string
}

// ─── Validation ────────────────────────────────────────────────────────────

export class CapacityProfileValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CapacityProfileValidationError'
  }
}

function validateOwner(profile: {
  owner: { kind: string; id: string }
  projectId: string
}): void {
  const kind = profile.owner.kind
  const ownerId = profile.owner.id

  if (kind === 'role') {
    if (!ownerId) {
      throw new CapacityProfileValidationError(
        `Role-owned profile for project ${profile.projectId} has no resourceTypeId`,
      )
    }
  } else if (kind === 'namedPerson' || kind === 'plannedResource') {
    if (!ownerId) {
      throw new CapacityProfileValidationError(
        `Named-resource profile for project ${profile.projectId} has no namedResourceId`,
      )
    }
  } else {
    throw new CapacityProfileValidationError(
      `Unknown owner kind "${kind}" for project ${profile.projectId}`,
    )
  }
}

// ─── Main sync function ────────────────────────────────────────────────────

/**
 * Idempotently sync the additive CapacityProfile/CapacitySegment rows for a
 * single project so they match the mapper-derived expected profiles.
 *
 * Designed to be called inside an existing write transaction so the sync
 * is atomic with the legacy write.
 *
 * @param prismaOrTx  PrismaClient (standalone) or TransactionClient (inside a transaction)
 * @param options     Optional: SyncOptions (preserveNamedResourceIds, etc.)
 * @throws            If the project is not found or reconciliation fails after sync
 */
export async function syncCapacityProfilesForProject(
  prismaOrTx: any,
  projectId: string,
  options?: SyncOptions,
): Promise<SyncResult> {
  const result: SyncResult = {
    profilesCreated: 0,
    profilesUpdated: 0,
    profilesDeleted: 0,
    segmentsCreated: 0,
    segmentsDeleted: 0,
  }

  // 1. Fetch project with all required includes
  const project = await (prismaOrTx as any).project.findFirst({
    where: { id: projectId },
    include: {
      resourceTypes: {
        include: {
          namedResources: { orderBy: { createdAt: 'asc' as const } },
        },
      },
      capacityPlans: {
        where: { isActive: true },
        take: 1,
        include: {
          periods: {
            include: { entries: true },
            orderBy: { periodIndex: 'asc' as const },
          },
        },
      },
    },
  })

  if (!project) {
    throw new Error(
      `syncCapacityProfilesForProject: Project ${projectId} not found`,
    )
  }

  // 2. Materialise active capacity plan into slot windows per resource type
  const activePlan = project.capacityPlans?.[0] ?? null
  const capacityPlanByRt = materializeCapacityPlanResources(
    activePlan?.periods ?? [],
  )

  const capacityPlanSlotsByResourceTypeId = new Map<
    string,
    CapacityPlanSlotInput[]
  >(
    Array.from(capacityPlanByRt.entries()).map(([rtId, materialized]) => [
      rtId,
      materialized.slotWindows,
    ]),
  )

  // 3. Build named resources lookup per resource type
  const namedResourcesByResourceTypeId = new Map<
    string,
    CapacityProfileNamedResourceLike[]
  >()
  for (const rt of project.resourceTypes) {
    namedResourcesByResourceTypeId.set(
      rt.id,
      rt.namedResources as unknown as CapacityProfileNamedResourceLike[],
    )
  }

  // 4a. Derive expected capacity profile DTOs using the existing mapper
  let expectedProfiles = mapProjectToCapacityProfiles({
    projectId: project.id,
    resourceTypes:
      project.resourceTypes as unknown as CapacityProfileResourceTypeLike[],
    namedResourcesByResourceTypeId,
    capacityPlanSlotsByResourceTypeId,
  })

  // 4b. Scope filtering — when scopeResourceTypeId is set, keep only profiles
  // for that ResourceType and its named resources. This guarantees profiles
  // for other RTs are never created, updated, or deleted.
  const scopeRT = options?.scopeResourceTypeId
  const scopeNRIds = new Set<string>()
  if (scopeRT) {
    const scopedRT = project.resourceTypes.find((rt: { id: string; namedResources?: { id: string }[] }) => rt.id === scopeRT)
    if (scopedRT?.namedResources) {
      for (const nr of scopedRT.namedResources) {
        scopeNRIds.add(nr.id)
      }
    }
    expectedProfiles = expectedProfiles.filter((p: { owner: { kind: string; id: string } }) => {
      if (p.owner.kind === 'role') return p.owner.id === scopeRT
      return scopeNRIds.has(p.owner.id)
    })
  }

  // 5. Fetch existing persisted profiles for this project
  const existingPersistedProfiles = await (
    prismaOrTx as any
  ).capacityProfile.findMany({
    where: { projectId },
    include: { segments: true },
  })

  // 5b. Scope filtering for persisted profiles
  let scopedPersistedProfiles = existingPersistedProfiles
  if (scopeRT) {
    scopedPersistedProfiles = existingPersistedProfiles.filter((pp: { resourceTypeId: string | null; namedResourceId: string | null }) => {
      if (pp.resourceTypeId === scopeRT && pp.namedResourceId === null) return true
      if (pp.namedResourceId && scopeNRIds.has(pp.namedResourceId)) return true
      return false
    })
  }

  // Build lookup map of persisted profiles by owner key (scoped)
  const persistedByKey = new Map<string, any>()
  for (const pp of scopedPersistedProfiles) {
    const ownerKind = prismaOwnerKindToDtoKind(pp.ownerKind)
    const ownerId = pp.resourceTypeId ?? pp.namedResourceId ?? ''
    const key = `${projectId}::${ownerKind}::${ownerId}`
    if (!persistedByKey.has(key)) {
      persistedByKey.set(key, pp)
    }
  }


  // Remove preserved NR/RT profiles from persistedByKey so sync won't touch them
  const preserveIds = new Set(options?.preserveNamedResourceIds ?? [])
  const preserveRTIds = new Set(options?.preserveResourceTypeIds ?? [])
  if (preserveIds.size > 0 || preserveRTIds.size > 0) {
    for (const [key, pp] of persistedByKey) {
      if ((pp.namedResourceId && preserveIds.has(pp.namedResourceId)) ||
          (pp.resourceTypeId && preserveRTIds.has(pp.resourceTypeId) && pp.ownerKind === 'ROLE')) {
        persistedByKey.delete(key)
      }
    }
  }

  // 6. Upsert/create each expected profile and replace its segments
  for (const profile of expectedProfiles) {
    validateOwner(profile)
    // Skip expected profiles for NRs preserved by profile-first writes
    if (profile.owner.kind === 'role') {
      if (preserveRTIds.has(profile.owner.id)) {
        const skipKey = `${project.id}::${profile.owner.kind}::${profile.owner.id}`
        persistedByKey.delete(skipKey)
        continue
      }
    } else {
      if (preserveIds.has(profile.owner.id)) {
        const skipKey = `${project.id}::${profile.owner.kind}::${profile.owner.id}`
        persistedByKey.delete(skipKey)
        continue
      }
    }

    const key = `${project.id}::${profile.owner.kind}::${profile.owner.id}`

    const ownerKind = toPrismaOwnerKind(profile.owner.kind)
    const planningBasis = toPrismaPlanningBasis(profile.planningBasis)
    const source = toPrismaSource(profile.source)

    const data: Record<string, unknown> = {
      projectId: project.id,
      ownerKind,
      planningBasis,
      source,
      defaultPercent: profile.defaultPercent ?? null,
      startWeek: profile.startWeek ?? null,
      endWeek: profile.endWeek ?? null,
      legacy: profile.legacy,
      resourceTypeId:
        profile.owner.kind === 'role' ? profile.owner.id : null,
      namedResourceId:
        profile.owner.kind === 'role' ? null : profile.owner.id,
    }

    const existing = persistedByKey.get(key)

    if (existing) {
      await (prismaOrTx as any).capacityProfile.update({
        where: { id: existing.id },
        data,
      })
      result.profilesUpdated++

      const deleted = await (prismaOrTx as any).capacitySegment.deleteMany({
        where: { capacityProfileId: existing.id },
      })
      result.segmentsDeleted += deleted.count

      for (const seg of profile.segments) {
        await (prismaOrTx as any).capacitySegment.create({
          data: {
            capacityProfileId: existing.id,
            startWeek: seg.startWeek,
            endWeek: seg.endWeek,
            capacityPercent: seg.capacityPercent,
            source: toPrismaSource(seg.source),
          },
        })
        result.segmentsCreated++
      }

      persistedByKey.delete(key)
    } else {
      await (prismaOrTx as any).capacityProfile.create({
        data: {
          ...data,
          segments: {
            create: profile.segments.map((seg: any) => ({
              startWeek: seg.startWeek,
              endWeek: seg.endWeek,
              capacityPercent: seg.capacityPercent,
              source: toPrismaSource(seg.source),
            })),
          },
        },
      })
      result.profilesCreated++
      result.segmentsCreated += profile.segments.length
    }
  }

  // 7. Delete stale persisted profiles (those in DB but not in expected)
  for (const [, pp] of persistedByKey) {
    await (prismaOrTx as any).capacitySegment.deleteMany({
      where: { capacityProfileId: pp.id },
    })
    await (prismaOrTx as any).capacityProfile.delete({
      where: { id: pp.id },
    })
    result.segmentsDeleted += pp.segments?.length ?? 0
    result.profilesDeleted++
  }

  // 8. Verify reconciliation after sync (exclude preserved NRs)
  const afterSyncPersisted = await (
    prismaOrTx as any
  ).capacityProfile.findMany({
    where: { projectId },
    include: {
      segments: {
        orderBy: [{ startWeek: 'asc' as const }, { endWeek: 'asc' as const }],
      },
    },
  })

  // Scope filtering for verification
  let afterSyncScoped = afterSyncPersisted
  if (scopeRT) {
    afterSyncScoped = afterSyncPersisted.filter((pp: { resourceTypeId: string | null; namedResourceId: string | null }) => {
      if (pp.resourceTypeId === scopeRT && pp.namedResourceId === null) return true
      if (pp.namedResourceId && scopeNRIds.has(pp.namedResourceId)) return true
      return false
    })
  }

  const filterPreserved = (p: any) => {
    if (preserveRTIds.size > 0 && p.resourceTypeId && p.ownerKind === 'ROLE' && preserveRTIds.has(p.resourceTypeId)) {
      return false
    }
    if (preserveIds.size > 0 && p.namedResourceId && preserveIds.has(p.namedResourceId)) {
      return false
    }
    return true
  }
  const filteredExpected = expectedProfiles.filter(
    (p: any) => {
      if (preserveRTIds.size > 0 && p.owner.kind === 'role' && preserveRTIds.has(p.owner.id)) {
        return false
      }
      if (preserveIds.size > 0 && p.owner.kind !== 'role' && preserveIds.has(p.owner.id)) {
        return false
      }
      return true
    },
  )
  const filteredPersisted = afterSyncScoped.filter(filterPreserved)

  const comparison = compareCapacityProfiles(
    projectId,
    filteredExpected,
    filteredPersisted.map((pp: any) => ({
      id: pp.id,
      resourceTypeId: pp.resourceTypeId,
      namedResourceId: pp.namedResourceId,
      ownerKind: pp.ownerKind,
      planningBasis: pp.planningBasis,
      source: pp.source,
      defaultPercent: pp.defaultPercent,
      startWeek: pp.startWeek,
      endWeek: pp.endWeek,
      segments: pp.segments.map((s: any) => ({
        startWeek: s.startWeek,
        endWeek: s.endWeek,
        capacityPercent: s.capacityPercent,
        source: s.source,
      })),
    })),
  )

  if (comparison.mismatches.length > 0) {
    throw new Error(
      `syncCapacityProfilesForProject: Reconciliation failed after sync for project ${projectId}: ${comparison.mismatches.length} mismatches`,
    )
  }

  return result
}
