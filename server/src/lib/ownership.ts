import { prisma } from './prisma.js'

export function ownedProject(projectId: string, userId: string) {
  return prisma.project.findFirst({ where: { id: projectId, ownerId: userId } })
}

export function ownedEpic(epicId: string, userId: string) {
  return prisma.epic.findFirst({
    where: { id: epicId, project: { ownerId: userId } },
  })
}

export function ownedFeature(featureId: string, userId: string) {
  return prisma.feature.findFirst({
    where: { id: featureId, epic: { project: { ownerId: userId } } },
  })
}

export function ownedStory(storyId: string, userId: string) {
  return prisma.userStory.findFirst({
    where: { id: storyId, feature: { epic: { project: { ownerId: userId } } } },
    include: { feature: { include: { epic: { include: { project: { select: { hoursPerDay: true } } } } } } },
  })
}
