import { prisma } from './prisma.js'
import { loadAndValidateOwnerProfile } from './ownerProfileLoader.js'
import { projectCapacityProfileToLegacyAllocation } from './capacityProfileLegacyProjection.js'

/**
 * Clear the weekly demand cache for a project.
 */
function clearProjectDemandCache(tx: any, projectId: string) {
  return tx.project.update({
    where: { id: projectId },
    data: { weeklyDemandCache: {} },
  })
}

type CapacityPlanExitClient = Pick<typeof prisma, 'resourceType' | 'namedResource'>

async function performCapacityPlanExit(db: CapacityPlanExitClient, resourceTypeId: string) {
  await db.resourceType.update({
    where: { id: resourceTypeId },
    data: {
      allocationMode: 'TIMELINE',
      allocationPercent: 100,
      allocationStartWeek: null,
      allocationEndWeek: null,
    },
  })

  await db.namedResource.updateMany({
    where: {
      resourceTypeId,
      allocationMode: 'CAPACITY_PLAN',
    },
    data: {
      allocationMode: 'TIMELINE',
      allocationPercent: 100,
      allocationStartWeek: null,
      allocationEndWeek: null,
      allocationPct: 100,
      startWeek: null,
      endWeek: null,
    },
  })
}

/**
 * Exit a ResourceType from CAPACITY_PLAN mode without modifying named resources.
 *
 * Unlike `exitCapacityPlanForManualScheduling`, this only updates the role-level
 * fields — the caller is responsible for updating per-NR fields based on
 * classification. Use this in the PUT route where NR semantics must be
 * determined before any NR mutation.
 *
 * @see exitCapacityPlanForManualScheduling for the original blanket-NR version.
 */
export async function exitCapacityPlanRoleOnly(
  resourceTypeId: string,
  db: any,
) {
  await db.resourceType.update({
    where: { id: resourceTypeId },
    data: {
      allocationMode: 'TIMELINE',
      allocationPercent: 100,
      allocationStartWeek: null,
      allocationEndWeek: null,
    },
  })
}

export async function exitCapacityPlanForManualScheduling(
  resourceTypeId: string,
  db?: CapacityPlanExitClient,
) {
  if (db) {
    await performCapacityPlanExit(db, resourceTypeId)
    return
  }

  await prisma.$transaction(async tx => {
    await performCapacityPlanExit(tx, resourceTypeId)
  })
}

/**
 * Transition the authoritative ROLE CapacityProfile from CAPACITY_PROFILE
 * to the established manual scheduling state (AVAILABILITY_WINDOW, 100%,
 * null windows, no segments).
 *
 * Unlike `exitCapacityPlanForManualScheduling` and `exitCapacityPlanRoleOnly`
 * which only update legacy ResourceType/NamedResource compatibility fields,
 * this helper updates the authoritative ROLE profile itself and then projects
 * to the ResourceType compatibility fields — keeping both sources consistent.
 *
 * The profile ID is preserved so references remain stable.
 *
 * @returns The validated post-exit ROLE profile.
 */
export async function exitCapacityPlanRoleProfile(
  tx: any,
  projectId: string,
  resourceTypeId: string,
) {
  // 1. Validate the existing ROLE profile
  const roleProfile = await loadAndValidateOwnerProfile({
    tx,
    projectId,
    ownerKind: 'ROLE',
    ownerId: resourceTypeId,
  })

  if (roleProfile.planningBasis !== 'CAPACITY_PROFILE') {
    // Not in CAPACITY_PLAN — nothing to do
    return roleProfile
  }

  // 2. Remove obsolete segments
  if (roleProfile.segments.length > 0) {
    await tx.capacitySegment.deleteMany({
      where: { capacityProfileId: roleProfile.id },
    })
  }

  // 3. Update the ROLE profile in place (preserve ID)
  const newPlanningBasis = 'AVAILABILITY_WINDOW'
  const newSource = 'AVAILABILITY_WINDOW'
  await tx.capacityProfile.update({
    where: { id: roleProfile.id },
    data: {
      planningBasis: newPlanningBasis,
      source: newSource,
      defaultPercent: 100,
      startWeek: null,
      endWeek: null,
    },
  })

  // 4. Project the updated profile to ResourceType compatibility fields
  const projection = projectCapacityProfileToLegacyAllocation({
    planningBasis: newPlanningBasis,
    source: newSource,
    defaultPercent: 100,
    startWeek: null,
    endWeek: null,
    segments: [],
  })

  await tx.resourceType.update({
    where: { id: resourceTypeId },
    data: {
      allocationMode: projection?.allocationMode ?? 'TIMELINE',
      allocationPercent: projection?.allocationPercent ?? 100,
      allocationStartWeek: projection?.allocationStartWeek ?? null,
      allocationEndWeek: projection?.allocationEndWeek ?? null,
    },
  })

  // 5. Clear weekly demand cache
  await clearProjectDemandCache(tx, projectId)

  // 6. Reload and return the updated profile
  return loadAndValidateOwnerProfile({
    tx,
    projectId,
    ownerKind: 'ROLE',
    ownerId: resourceTypeId,
  })
}
