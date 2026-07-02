/**
 * backfillCapacityProfiles.ts — Idempotent backfill helper.
 *
 * Reads existing persisted fields (ResourceType, NamedResource, CapacityPlan)
 * and derives CapacityProfile / CapacitySegment records using the mapper
 * from capacityProfileMapping.ts.
 *
 * Safe to run multiple times — upserts profiles and replaces segments.
 * Legacy fields remain authoritative and are not modified.
 */
import type { PrismaClient } from '@prisma/client'
import { $Enums } from '@prisma/client'
import { materializeCapacityPlanResources } from './capacityPlanMaterialisation.js'
import { mapProjectToCapacityProfiles } from './capacityProfileMapping.js'
import type {
  CapacityProfileOwnerKind,
  CapacityProfilePlanningBasis,
  CapacityProfileSource,
  CapacityProfileResourceTypeLike,
  CapacityProfileNamedResourceLike,
  CapacityPlanSlotInput,
} from './capacityProfileMapping.js'

// ─── Enum mapping helpers (DTO lowercase → Prisma UPPER_CASE) ─────────────

function toPrismaOwnerKind(kind: CapacityProfileOwnerKind): $Enums.CapacityProfileOwnerKind {
  switch (kind) {
    case 'role': return 'ROLE' as $Enums.CapacityProfileOwnerKind
    case 'namedPerson': return 'NAMED_PERSON' as $Enums.CapacityProfileOwnerKind
    case 'plannedResource': return 'PLANNED_RESOURCE' as $Enums.CapacityProfileOwnerKind
  }
}

function toPrismaPlanningBasis(basis: CapacityProfilePlanningBasis): $Enums.CapacityProfilePlanningBasis {
  switch (basis) {
    case 'demandFollowing': return 'DEMAND_FOLLOWING' as $Enums.CapacityProfilePlanningBasis
    case 'availabilityWindow': return 'AVAILABILITY_WINDOW' as $Enums.CapacityProfilePlanningBasis
    case 'wholeProjectAllocation': return 'WHOLE_PROJECT_ALLOCATION' as $Enums.CapacityProfilePlanningBasis
    case 'capacityProfile': return 'CAPACITY_PROFILE' as $Enums.CapacityProfilePlanningBasis
  }
}

function toPrismaSource(source: CapacityProfileSource): $Enums.CapacityProfileSource {
  switch (source) {
    case 'fixed': return 'FIXED' as $Enums.CapacityProfileSource
    case 'manual': return 'MANUAL' as $Enums.CapacityProfileSource
    case 'availabilityWindow': return 'AVAILABILITY_WINDOW' as $Enums.CapacityProfileSource
    case 'squadPlanner': return 'SQUAD_PLANNER' as $Enums.CapacityProfileSource
    case 'imported': return 'IMPORTED' as $Enums.CapacityProfileSource
    case 'derived': return 'DERIVED' as $Enums.CapacityProfileSource
    case 'legacy': return 'LEGACY' as $Enums.CapacityProfileSource
  }
}

// ─── Exactly-one-owner validation ──────────────────────────────────────────

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
function lookupCriteria(
  projectId: string,
  profile: {
    owner: { kind: CapacityProfileOwnerKind; id: string }
  },
): {
  projectId: string
  ownerKind: $Enums.CapacityProfileOwnerKind
  resourceTypeId?: string | null
  namedResourceId?: string | null
} {
  const ownerKind = toPrismaOwnerKind(profile.owner.kind)

  if (profile.owner.kind === 'role') {
    return { projectId, ownerKind, resourceTypeId: profile.owner.id }
  }

  return { projectId, ownerKind, namedResourceId: profile.owner.id }
}


// ─── Main backfill function ───────────────────────────────────────────────

export interface BackfillResult {
  profilesCreated: number
  profilesUpdated: number
  segmentsCreated: number
  segmentsDeleted: number
}

/**
 * Idempotently backfill CapacityProfile and CapacitySegment records from
 * existing ResourceType, NamedResource, and active CapacityPlan data.
 *
 * Safe to run multiple times. Does not modify legacy fields.
 * Enforces exactly-one-owner at the application level.
 */
export async function backfillCapacityProfiles(
  prisma: PrismaClient,
): Promise<BackfillResult> {
  const result: BackfillResult = {
    profilesCreated: 0,
    profilesUpdated: 0,
    segmentsCreated: 0,
    segmentsDeleted: 0,
  }

  // Fetch all projects with their resource types, named resources, and active capacity plans
  const projects = await prisma.project.findMany({
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

  for (const project of projects) {
    // Materialize active capacity plan into slot windows
    const activePlan = project.capacityPlans?.[0] ?? null
    const capacityPlanByRt = materializeCapacityPlanResources(
      activePlan?.periods ?? [],
    )

    const capacityPlanSlotsByResourceTypeId = new Map<string, CapacityPlanSlotInput[]>(
      Array.from(capacityPlanByRt.entries()).map(([rtId, materialized]) => [
        rtId,
        materialized.slotWindows,
      ]),
    )

    // Build named resources lookup
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

    // Derive capacity profile DTOs using the existing mapper
    const profiles = mapProjectToCapacityProfiles({
      projectId: project.id,
      resourceTypes:
        project.resourceTypes as unknown as CapacityProfileResourceTypeLike[],
      namedResourcesByResourceTypeId,
      capacityPlanSlotsByResourceTypeId,
    })

    for (const profile of profiles) {
      validateOwner(profile)

      const criteria = lookupCriteria(project.id, profile)

      // Determine which fields are nullable and which are set
      const data = {
        projectId: project.id,
        ownerKind: toPrismaOwnerKind(profile.owner.kind),
        planningBasis: toPrismaPlanningBasis(profile.planningBasis),
        source: toPrismaSource(profile.source),
        defaultPercent: profile.defaultPercent ?? null,
        startWeek: profile.startWeek ?? null,
        endWeek: profile.endWeek ?? null,
        legacy: profile.legacy,
        resourceTypeId:
          profile.owner.kind === 'role' ? profile.owner.id : null,
        namedResourceId:
          profile.owner.kind === 'role' ? null : profile.owner.id,
      } satisfies Record<string, unknown>

      // Wrap the whole upsert + segment replacement in a transaction to
      // prevent orphaned profiles or partial segment data on failure.
      await prisma.$transaction(async (tx) => {
        const existing = await tx.capacityProfile.findFirst({
          where: criteria,
        })

        if (existing) {
          await tx.capacityProfile.update({
            where: { id: existing.id },
            data,
          })
          result.profilesUpdated++

          const deleted = await tx.capacitySegment.deleteMany({
            where: { capacityProfileId: existing.id },
          })
          result.segmentsDeleted += deleted.count

          for (const seg of profile.segments) {
            await tx.capacitySegment.create({
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
        } else {
          // Create new profile
          await tx.capacityProfile.create({
            data: {
              ...data,
              segments: {
                create: profile.segments.map((seg) => ({
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
      })
    }
  }

  return result
}
