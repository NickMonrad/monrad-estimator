import type { Prisma } from '@prisma/client'
import { prisma } from './prisma.js'

export type BacklogItemType = 'epic' | 'feature' | 'story' | 'task'

export class BacklogDuplicationError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message)
    this.name = 'BacklogDuplicationError'
  }
}

type TransactionClient = Prisma.TransactionClient

type TaskSource = {
  id: string
  name: string
  description: string | null
  assumptions: string | null
  hoursEffort: number
  durationDays: number | null
  order: number
  userStoryId: string
  resourceTypeId: string | null
}

type StorySource = {
  id: string
  name: string
  description: string | null
  assumptions: string | null
  order: number
  isActive: boolean
  appliedTemplateId: string | null
  featureId: string
  tasks: TaskSource[]
}

type FeatureSource = {
  id: string
  name: string
  description: string | null
  assumptions: string | null
  order: number
  featureMode: string
  isActive: boolean
  timelineColour: string | null
  epicId: string
  userStories: StorySource[]
}

type EpicSource = {
  id: string
  name: string
  description: string | null
  assumptions: string | null
  order: number
  featureMode: string
  scheduleMode: string
  isActive: boolean
  projectId: string
  features: FeatureSource[]
}

export type DuplicatedBacklogItem = {
  type: BacklogItemType
  id: string
  name: string
  parentId: string | null
}

async function validateResourceTypeReferences(
  tx: TransactionClient,
  projectId: string,
  tasks: TaskSource[],
) {
  const resourceTypeIds = [...new Set(tasks
    .map(task => task.resourceTypeId)
    .filter((id): id is string => id !== null))]
  if (resourceTypeIds.length === 0) return

  const resourceTypes = await tx.resourceType.findMany({
    where: { id: { in: resourceTypeIds }, projectId },
    select: { id: true },
  })
  const validIds = new Set(resourceTypes.map(resourceType => resourceType.id))
  const invalidId = resourceTypeIds.find(id => !validIds.has(id))
  if (invalidId) {
    throw new BacklogDuplicationError(
      `Cannot duplicate backlog item: resource type assignment "${invalidId}" is not part of this project`,
      422,
    )
  }
}

async function copyTask(
  tx: TransactionClient,
  source: TaskSource,
  userStoryId: string,
  name: string,
  order = source.order,
) {
  return tx.task.create({
    data: {
      name,
      description: source.description,
      assumptions: source.assumptions,
      hoursEffort: source.hoursEffort,
      durationDays: source.durationDays,
      resourceTypeId: source.resourceTypeId,
      userStoryId,
      order,
    },
  })
}

async function copyStory(
  tx: TransactionClient,
  source: StorySource,
  featureId: string,
  name: string,
  order = source.order,
) {
  const copy = await tx.userStory.create({
    data: {
      name,
      description: source.description,
      assumptions: source.assumptions,
      isActive: source.isActive,
      appliedTemplateId: source.appliedTemplateId,
      featureId,
      order,
    },
  })
  for (const task of source.tasks) {
    await copyTask(tx, task, copy.id, task.name)
  }
  return copy
}

async function copyFeature(
  tx: TransactionClient,
  source: FeatureSource,
  epicId: string,
  name: string,
  order = source.order,
) {
  const copy = await tx.feature.create({
    data: {
      name,
      description: source.description,
      assumptions: source.assumptions,
      featureMode: source.featureMode,
      timelineColour: source.timelineColour,
      isActive: source.isActive,
      epicId,
      order,
    },
  })
  for (const story of source.userStories) {
    await copyStory(tx, story, copy.id, story.name)
  }
  return copy
}

async function copyEpic(
  tx: TransactionClient,
  source: EpicSource,
  projectId: string,
  name: string,
  order = source.order,
) {
  const copy = await tx.epic.create({
    data: {
      name,
      description: source.description,
      assumptions: source.assumptions,
      featureMode: source.featureMode,
      scheduleMode: source.scheduleMode,
      isActive: source.isActive,
      projectId,
      order,
    },
  })
  for (const feature of source.features) {
    await copyFeature(tx, feature, copy.id, feature.name)
  }
  return copy
}

export async function duplicateBacklogItem(
  projectId: string,
  itemType: BacklogItemType,
  itemId: string,
): Promise<DuplicatedBacklogItem | null> {
  return prisma.$transaction(async tx => {
    if (itemType === 'epic') {
      const source = await tx.epic.findFirst({
        where: { id: itemId, projectId },
        include: {
          features: {
            orderBy: { order: 'asc' },
            include: {
              userStories: {
                orderBy: { order: 'asc' },
                include: { tasks: { orderBy: { order: 'asc' } } },
              },
            },
          },
        },
      }) as EpicSource | null
      if (!source) return null

      const tasks = source.features.flatMap(feature => feature.userStories.flatMap(story => story.tasks))
      await validateResourceTypeReferences(tx, projectId, tasks)
      await tx.epic.updateMany({
        where: { projectId, order: { gt: source.order } },
        data: { order: { increment: 1 } },
      })
      const copy = await copyEpic(tx, source, projectId, `Copy of ${source.name}`, source.order + 1)
      return { type: itemType, id: copy.id, name: copy.name, parentId: null }
    }

    if (itemType === 'feature') {
      const source = await tx.feature.findFirst({
        where: { id: itemId, epic: { projectId } },
        include: {
          userStories: {
            orderBy: { order: 'asc' },
            include: { tasks: { orderBy: { order: 'asc' } } },
          },
        },
      }) as FeatureSource | null
      if (!source) return null

      const tasks = source.userStories.flatMap(story => story.tasks)
      await validateResourceTypeReferences(tx, projectId, tasks)
      await tx.feature.updateMany({
        where: { epicId: source.epicId, order: { gt: source.order } },
        data: { order: { increment: 1 } },
      })
      const copy = await copyFeature(tx, source, source.epicId, `Copy of ${source.name}`, source.order + 1)
      return { type: itemType, id: copy.id, name: copy.name, parentId: source.epicId }
    }

    if (itemType === 'story') {
      const source = await tx.userStory.findFirst({
        where: { id: itemId, feature: { epic: { projectId } } },
        include: { tasks: { orderBy: { order: 'asc' } } },
      }) as StorySource | null
      if (!source) return null

      await validateResourceTypeReferences(tx, projectId, source.tasks)
      await tx.userStory.updateMany({
        where: { featureId: source.featureId, order: { gt: source.order } },
        data: { order: { increment: 1 } },
      })
      const copy = await copyStory(tx, source, source.featureId, `Copy of ${source.name}`, source.order + 1)
      return { type: itemType, id: copy.id, name: copy.name, parentId: source.featureId }
    }

    const source = await tx.task.findFirst({
      where: { id: itemId, userStory: { feature: { epic: { projectId } } } },
    }) as TaskSource | null
    if (!source) return null

    await validateResourceTypeReferences(tx, projectId, [source])
    await tx.task.updateMany({
      where: { userStoryId: source.userStoryId, order: { gt: source.order } },
      data: { order: { increment: 1 } },
    })
    const copy = await copyTask(tx, source, source.userStoryId, `Copy of ${source.name}`, source.order + 1)
    return { type: itemType, id: copy.id, name: copy.name, parentId: source.userStoryId }
  }, { timeout: 30000, isolationLevel: 'RepeatableRead' })
}
