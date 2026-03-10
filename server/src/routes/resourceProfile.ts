import { Router, Response } from 'express'
import { ResourceCategory } from '@prisma/client'
import { prisma } from '../lib/prisma.js'
import { authenticate, AuthRequest } from '../middleware/auth.js'

type AllocationMode = 'EFFORT' | 'TIMELINE' | 'FULL_PROJECT'

const router = Router({ mergeParams: true })
router.use(authenticate)

const CATEGORY_ORDER: ResourceCategory[] = ['ENGINEERING', 'GOVERNANCE', 'PROJECT_MANAGEMENT']
const round2 = (value: number) => Math.round(value * 100) / 100

router.get('/', async (req: AuthRequest, res: Response) => {
  const projectId = req.params.projectId as string
  const project = await prisma.project.findFirst({
    where: { id: projectId, ownerId: req.userId },
    include: {
      resourceTypes: {
        include: {
          globalType: true,
          namedResources: { orderBy: { createdAt: 'asc' } }
        }
      },
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
      storyTimelineEntries: { select: { storyId: true, startWeek: true, durationWeeks: true } },
    },
  })

  if (!project) {
    res.status(404).json({ error: 'Project not found' })
    return
  }

  const fallbackHoursPerDay = project.hoursPerDay
  const resourceTypeById = new Map(project.resourceTypes.map(rt => [rt.id, rt]))

  // Project duration in weeks from the latest timeline entry end point + buffer weeks
  const projectDurationWeeks =
    (project.timelineEntries.length > 0
      ? Math.max(...project.timelineEntries.map(te => te.startWeek + te.durationWeeks))
      : 0) + (project.bufferWeeks ?? 0)

  // Build lookup maps for timeline entries
  const featureEntryMap = new Map(project.timelineEntries.map(e => [e.featureId, e]))
  const storyEntryMap = new Map(project.storyTimelineEntries.map(e => [e.storyId, e]))

  // Track min start week / max end week per resource type (for TIMELINE allocation)
  const rtWeeks = new Map<string, { starts: number[]; ends: number[] }>()

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

          // Collect week ranges for TIMELINE allocation mode
          const storyEntry = storyEntryMap.get(story.id)
          const featureEntry = featureEntryMap.get(feature.id)
          const entry = storyEntry ?? featureEntry
          if (entry) {
            if (!rtWeeks.has(resourceType.id)) {
              rtWeeks.set(resourceType.id, { starts: [], ends: [] })
            }
            rtWeeks.get(resourceType.id)!.starts.push(entry.startWeek)
            rtWeeks.get(resourceType.id)!.ends.push(entry.startWeek + entry.durationWeeks)
          }

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

      // Compute allocation
      const mode = (resourceType.allocationMode as AllocationMode) ?? 'EFFORT'
      const percent = resourceType.allocationPercent ?? 100
      const count = resourceType.count

      const weeks = rtWeeks.get(resourceType.id)
      const derivedStartWeek = weeks && weeks.starts.length > 0 ? Math.min(...weeks.starts) : null
      const derivedEndWeek = weeks && weeks.ends.length > 0 ? Math.max(...weeks.ends) : null

      const effectiveStartWeek = resourceType.allocationStartWeek ?? derivedStartWeek
      const effectiveEndWeek = resourceType.allocationEndWeek ?? derivedEndWeek

      // If named resources exist, compute per-NR allocatedDays
      const hasNamedResources = resourceType.namedResources && resourceType.namedResources.length > 0

      let allocatedDays: number
      let namedResourcesOutput: Array<{
        id: string
        name: string
        allocationMode: string
        allocationPercent: number
        allocationStartWeek: number | null
        allocationEndWeek: number | null
        startWeek: number | null
        endWeek: number | null
        allocatedDays: number
        derivedStartWeek: number | null
        derivedEndWeek: number | null
      }>

      if (hasNamedResources) {
        // Compute per-NR allocated days
        namedResourcesOutput = resourceType.namedResources.map(nr => {
          const nrMode = (nr.allocationMode as AllocationMode) ?? 'EFFORT'
          const nrPercent = nr.allocationPercent ?? 100
          let nrAllocatedDays: number
          if (nrMode === 'EFFORT') {
            // Split effort equally across named resources
            nrAllocatedDays = round2(totalDays / resourceType.namedResources.length)
          } else if (nrMode === 'TIMELINE') {
            const effectiveStart = nr.allocationStartWeek ?? nr.startWeek ?? derivedStartWeek ?? 0
            const effectiveEnd = nr.allocationEndWeek ?? nr.endWeek ?? derivedEndWeek ?? effectiveStart
            nrAllocatedDays = round2(Math.max(0, effectiveEnd - effectiveStart) * 5 * (nrPercent / 100))
          } else {
            // FULL_PROJECT
            nrAllocatedDays = round2(projectDurationWeeks * 5 * (nrPercent / 100))
          }
          return {
            id: nr.id,
            name: nr.name,
            allocationMode: nrMode,
            allocationPercent: nrPercent,
            allocationStartWeek: nr.allocationStartWeek ?? null,
            allocationEndWeek: nr.allocationEndWeek ?? null,
            startWeek: nr.startWeek ?? null,
            endWeek: nr.endWeek ?? null,
            allocatedDays: nrAllocatedDays,
            derivedStartWeek,
            derivedEndWeek,
          }
        })
        // Total RT allocatedDays = sum of NR allocatedDays
        allocatedDays = round2(namedResourcesOutput.reduce((sum, nr) => sum + nr.allocatedDays, 0))
      } else {
        namedResourcesOutput = []
        if (mode === 'EFFORT') {
          allocatedDays = totalDays
        } else if (mode === 'TIMELINE') {
          if (effectiveStartWeek != null && effectiveEndWeek != null) {
            allocatedDays = round2((effectiveEndWeek - effectiveStartWeek) * 5 * count * (percent / 100))
          } else {
            allocatedDays = totalDays
          }
        } else {
          // FULL_PROJECT
          allocatedDays = round2(projectDurationWeeks * 5 * count * (percent / 100))
        }
      }

      const allocatedCost = dayRate != null ? round2(allocatedDays * dayRate) : null
      const estimatedCost = allocatedCost

      return {
        resourceTypeId: resourceType.id,
        name: resourceType.name,
        category: resourceType.category,
        count: resourceType.count,
        hoursPerDay: agg.hoursPerDay,
        dayRate,
        totalHours,
        effortDays: totalDays,
        totalDays: allocatedDays,   // keep totalDays = allocatedDays so existing UI subtotal works
        allocatedDays,
        allocationMode: mode,
        allocationPercent: percent,
        allocationStartWeek: resourceType.allocationStartWeek ?? null,
        allocationEndWeek: resourceType.allocationEndWeek ?? null,
        derivedStartWeek,
        derivedEndWeek,
        estimatedCost,
        epics,
        namedResources: namedResourcesOutput,
      }
    })
    .sort((a, b) => {
      const catDiff = categoryIndex(a.category as ResourceCategory) - categoryIndex(b.category as ResourceCategory)
      if (catDiff !== 0) return catDiff
      return a.name.localeCompare(b.name)
    })

  const totalResourceDays = round2(resourceRows.reduce((sum, row) => sum + row.totalDays, 0))
  const totalEffortDays = round2(resourceRows.reduce((sum, row) => sum + row.effortDays, 0))
  const totalResourceHours = round2(resourceRows.reduce((sum, row) => sum + row.totalHours, 0))

  const overheadRows = project.overheads.map(overhead => {
    const dayRate = overhead.resourceType?.dayRate ?? overhead.resourceType?.globalType?.defaultDayRate ?? null
    const resourceTypeName = overhead.resourceType?.name ?? null
    const computedDays =
      overhead.type === 'PERCENTAGE'
        ? round2((overhead.value / 100) * totalEffortDays)  // % of effort, not allocated days
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
