import { prisma } from './prisma.js'

export async function exitCapacityPlanForManualScheduling(resourceTypeId: string) {
  await prisma.resourceType.update({
    where: { id: resourceTypeId },
    data: {
      allocationMode: 'TIMELINE',
      allocationPercent: 100,
      allocationStartWeek: null,
      allocationEndWeek: null,
    },
  })

  await prisma.namedResource.updateMany({
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
