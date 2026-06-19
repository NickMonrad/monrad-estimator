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
