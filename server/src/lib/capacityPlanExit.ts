import { prisma } from './prisma.js'

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
