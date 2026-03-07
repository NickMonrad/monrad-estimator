import { Router, Response } from 'express'
import { ResourceCategory } from '@prisma/client'
import { prisma } from '../lib/prisma.js'
import { authenticate, AuthRequest } from '../middleware/auth.js'

const router = Router({ mergeParams: true })
router.use(authenticate)

const CATEGORY_ORDER: ResourceCategory[] = ['ENGINEERING', 'GOVERNANCE', 'PROJECT_MANAGEMENT']
const round2 = (value: number) => Math.round(value * 100) / 100

router.get('/', async (req: AuthRequest, res: Response) => {
  const projectId = req.params.projectId as string
  const project = await prisma.project.findFirst({
    where: { id: projectId, ownerId: req.userId },
    include: {
      resourceTypes: { include: { globalType: true } },
      epics: {
        orderBy: { order: 'asc' },
        include: {
          features: {
            orderBy: { order: 'asc' },
            include: {
              userStories: {
                orderBy: { order: 'asc' },
                include: {
                  tasks: {
                    orderBy: { order: 'asc' },
                    include: { resourceType: true },
                  },
                },
              },
            },
          },
        },
      },
      overheads: {
        include: { resourceType: { include: { globalType: true } } },
        orderBy: [{ order: 'asc' }, { createdAt: 'asc' }],
      },
      timelineEntries: true,
    },
  })

  if (!project) {
    res.status(404).json({ error: 'Project not found' })
    return
  }

  const fallbackHoursPerDay = project.hoursPerDay
  const resourceTypeById = new Map(project.resourceTypes.map(rt => [rt.id, rt]))

  // Project duration in weeks from the latest timeline entry end point
  const projectDurationWeeks =
    project.timelineEntries.length > 0
      ? Math.max(...project.timelineEntries.map(te => te.startWeek + te.durationWeeks))
      : 0

  type StoryAgg = { storyId: string; storyName: string; order: number; hours: number; days: number }
  type FeatureAgg = {
    featureId: string
    featureName: string
    order: number
    hours: number
    days: number
    stories: Map<string, StoryAgg>
  }
  type EpicAgg = {
    epicId: string
    epicName: string
    order: number
    hours: number
    days: number
    features: Map<string, FeatureAgg>
  }
  type ResourceAgg = {
    resourceTypeId: string
    hoursPerDay: number
    totalHours: number
    totalDays: number
    epics: Map<string, EpicAgg>
  }

  const resourceAgg = new Map<string, ResourceAgg>()

  for (const epic of project.epics) {
    if (epic.isActive === false) continue
    for (const feature of epic.features) {
      if (feature.isActive === false) continue
      for (const story of feature.userStories) {
        if (story.isActive === false) continue
        for (const task of story.tasks) {
          if (!task.resourceTypeId) continue
          const resourceType = resourceTypeById.get(task.resourceTypeId)
          if (!resourceType) continue
          const effectiveHoursPerDay =
            resourceType.hoursPerDay && resourceType.hoursPerDay > 0 ? resourceType.hoursPerDay : fallbackHoursPerDay
          if (!effectiveHoursPerDay) continue

          const hours = task.hoursEffort ?? 0
          const days = hours / effectiveHoursPerDay
          if (!resourceAgg.has(resourceType.id)) {
            resourceAgg.set(resourceType.id, {
              resourceTypeId: resourceType.id,
              hoursPerDay: effectiveHoursPerDay,
              totalHours: 0,
              totalDays: 0,
              epics: new Map(),
            })
          }
          const agg = resourceAgg.get(resourceType.id)!
          agg.totalHours += hours
          agg.totalDays += days

          const epicAgg =
            agg.epics.get(epic.id) ??
            {
              epicId: epic.id,
              epicName: epic.name,
              order: epic.order ?? 0,
              hours: 0,
              days: 0,
              features: new Map<string, FeatureAgg>(),
            }
          epicAgg.hours += hours
          epicAgg.days += days
          agg.epics.set(epic.id, epicAgg)

          const featureAgg =
            epicAgg.features.get(feature.id) ??
            {
              featureId: feature.id,
              featureName: feature.name,
              order: feature.order ?? 0,
              hours: 0,
              days: 0,
              stories: new Map<string, StoryAgg>(),
            }
          featureAgg.hours += hours
          featureAgg.days += days
          epicAgg.features.set(feature.id, featureAgg)

          const storyAgg =
            featureAgg.stories.get(story.id) ??
            {
              storyId: story.id,
              storyName: story.name,
              order: story.order ?? 0,
              hours: 0,
              days: 0,
            }
          storyAgg.hours += hours
          storyAgg.days += days
          featureAgg.stories.set(story.id, storyAgg)
        }
      }
    }
  }

  const categoryIndex = (category: ResourceCategory) => {
    const idx = CATEGORY_ORDER.indexOf(category)
    return idx === -1 ? CATEGORY_ORDER.length : idx
  }

  const resourceRows = Array.from(resourceAgg.values())
    .map(agg => {
      const resourceType = resourceTypeById.get(agg.resourceTypeId)!
      const epics = Array.from(agg.epics.values())
        .sort((a, b) => a.order - b.order || a.epicName.localeCompare(b.epicName))
        .map(epic => ({
          epicId: epic.epicId,
          epicName: epic.epicName,
          hours: round2(epic.hours),
          days: round2(epic.days),
          features: Array.from(epic.features.values())
            .sort((a, b) => a.order - b.order || a.featureName.localeCompare(b.featureName))
            .map(feature => ({
              featureId: feature.featureId,
              featureName: feature.featureName,
              hours: round2(feature.hours),
              days: round2(feature.days),
              stories: Array.from(feature.stories.values())
                .sort((a, b) => a.order - b.order || a.storyName.localeCompare(b.storyName))
                .map(story => ({
                  storyId: story.storyId,
                  storyName: story.storyName,
                  hours: round2(story.hours),
                  days: round2(story.days),
                })),
            })),
        }))

      const dayRate = resourceType.dayRate ?? resourceType.globalType?.defaultDayRate ?? null
      const totalDays = round2(agg.totalDays)
      const totalHours = round2(agg.totalHours)
      const estimatedCost = dayRate != null ? round2(totalDays * dayRate) : null

      return {
        resourceTypeId: resourceType.id,
        name: resourceType.name,
        category: resourceType.category,
        count: resourceType.count,
        hoursPerDay: agg.hoursPerDay,
        dayRate,
        totalHours,
        totalDays,
        estimatedCost,
        epics,
      }
    })
    .sort((a, b) => {
      const catDiff = categoryIndex(a.category as ResourceCategory) - categoryIndex(b.category as ResourceCategory)
      if (catDiff !== 0) return catDiff
      return a.name.localeCompare(b.name)
    })

  const totalResourceDays = round2(resourceRows.reduce((sum, row) => sum + row.totalDays, 0))
  const totalResourceHours = round2(resourceRows.reduce((sum, row) => sum + row.totalHours, 0))

  const overheadRows = project.overheads.map(overhead => {
    const dayRate = overhead.resourceType?.dayRate ?? overhead.resourceType?.globalType?.defaultDayRate ?? null
    const resourceTypeName = overhead.resourceType?.name ?? null
    const computedDays =
      overhead.type === 'PERCENTAGE'
        ? round2((overhead.value / 100) * totalResourceDays)
        : overhead.type === 'DAYS_PER_WEEK'
          ? round2(overhead.value * projectDurationWeeks)
          : round2(overhead.value)
    const estimatedCost = dayRate != null ? round2(computedDays * dayRate) : null
    return {
      overheadId: overhead.id,
      name: overhead.name,
      resourceTypeId: overhead.resourceTypeId,
      resourceTypeName,
      dayRate,
      type: overhead.type,
      value: overhead.value,
      computedDays,
      estimatedCost,
    }
  })

  const totalOverheadDays = round2(overheadRows.reduce((sum, row) => sum + row.computedDays, 0))
  const hasCost =
    resourceRows.some(row => row.dayRate !== null) || overheadRows.some(row => row.dayRate !== null)
  const totalCost = hasCost
    ? round2(
        resourceRows.reduce((sum, row) => sum + (row.estimatedCost ?? 0), 0) +
          overheadRows.reduce((sum, row) => sum + (row.estimatedCost ?? 0), 0),
      )
    : null

  res.json({
    projectId,
    hoursPerDay: fallbackHoursPerDay,
    projectDurationWeeks,
    resourceRows,
    overheadRows,
    summary: {
      totalHours: totalResourceHours,
      totalDays: round2(totalResourceDays + totalOverheadDays),
      totalCost,
      hasCost,
    },
  })
})

export default router
