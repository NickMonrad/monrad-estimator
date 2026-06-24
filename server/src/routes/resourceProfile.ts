import { Router, Response } from 'express'
import { ResourceCategory } from '@prisma/client'
import { prisma } from '../lib/prisma.js'
import { asyncHandler } from '../lib/asyncHandler.js'
import { authenticate, AuthRequest } from '../middleware/auth.js'
import { effectiveDays } from '../utils/round.js'
import {
  materializeCapacityPlanResources,
  shouldFallbackToActiveCapacityPlan,
} from '../lib/capacityPlanMaterialisation.js'
import { deriveNamedResourceAssignments, type WeeklyDemandLike } from '../lib/namedResourceAssignments.js'
import { buildFallbackWeeklyDemand, mergeWeeklyDemand, computePlanningWindow, convertWeeklyDemandCache } from '../lib/projectPlanningModel.js'
type AllocationMode = 'EFFORT' | 'TIMELINE' | 'FULL_PROJECT' | 'CAPACITY_PLAN'

const router = Router({ mergeParams: true })
router.use(authenticate)

const CATEGORY_ORDER: ResourceCategory[] = ['ENGINEERING', 'GOVERNANCE', 'PROJECT_MANAGEMENT']
const round2 = (value: number) => Math.round(value * 100) / 100

router.get('/', asyncHandler(async (req: AuthRequest, res: Response) => {
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
      capacityPlans: {
        where: { isActive: true },
        take: 1,
        include: { periods: { include: { entries: true }, orderBy: { periodIndex: 'asc' } } },
      },
    },
  })

  if (!project) {
    res.status(404).json({ error: 'Project not found' })
    return
  }

  const fallbackHoursPerDay = project.hoursPerDay
  const resourceTypeById = new Map(project.resourceTypes.map(rt => [rt.id, rt]))
  // Materialize capacity plan for shared model consumption
  const activePlan = project.capacityPlans?.[0] ?? null
  const capacityPlanByRt = materializeCapacityPlanResources(activePlan?.periods ?? [])

  // Project duration in weeks from the latest timeline entry end point + buffer weeks + onboarding weeks
  const planningWindow = computePlanningWindow(
    project.timelineEntries,
    project.startDate,
    project.bufferWeeks ?? 0,
    project.onboardingWeeks ?? 0,
  )
  const projectDurationWeeks = planningWindow.maxWeek ?? 0

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
          const days = effectiveDays(task.durationDays, hours, effectiveHoursPerDay)
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

  // ── Fallback weekly demand from shared model ──────────────────────
  // Build entries at story-level granularity to preserve story-level scheduling semantics.
  // Stories with a story timeline entry get their own timing; remaining active stories
  // without a story entry are grouped under their feature-level timeline entry.
  const fallbackEntries: Array<{
    startWeek: number
    durationWeeks: number
    feature: {
      userStories: Array<{
        isActive: boolean | null
        tasks: Array<{
          resourceTypeId: string | null
          hoursEffort: number
          durationDays: number | null
          resourceType: { name: string; hoursPerDay: number | null } | null
        }>
      }>
    }
  }> = []
  const storyTimedIds = new Set<string>()
  for (const epic of project.epics) {
    if (epic.isActive === false) continue
    for (const feature of epic.features) {
      if (feature.isActive === false) continue
      for (const story of feature.userStories) {
        if (story.isActive === false) continue
        const storyEntry = storyEntryMap.get(story.id)
        if (storyEntry) {
          fallbackEntries.push({
            startWeek: storyEntry.startWeek,
            durationWeeks: storyEntry.durationWeeks,
            feature: { userStories: [story] },
          })
          storyTimedIds.add(story.id)
        }
      }
    }
  }
  for (const epic of project.epics) {
    if (epic.isActive === false) continue
    for (const feature of epic.features) {
      if (feature.isActive === false) continue
      const featureEntry = featureEntryMap.get(feature.id)
      if (!featureEntry) continue
      const remaining = feature.userStories.filter(
        story => story.isActive !== false && !storyTimedIds.has(story.id),
      )
      if (remaining.length > 0) {
        fallbackEntries.push({
          startWeek: featureEntry.startWeek,
          durationWeeks: featureEntry.durationWeeks,
          feature: { userStories: remaining },
        })
      }
    }
  }

  const fallbackDemand = buildFallbackWeeklyDemand(
    fallbackEntries as any[],
    project.resourceTypes,
    capacityPlanByRt,
    project.hoursPerDay,
  )

  const weeklyDemandCache = project.weeklyDemandCache as Record<string, number> | null
  let weeklyDemand: WeeklyDemandLike[]

  if (weeklyDemandCache && Object.keys(weeklyDemandCache).length > 0) {
    const simulatedDemand = convertWeeklyDemandCache(
      weeklyDemandCache,
      project.resourceTypes as Array<{ id: string; name: string }>,
    )
    const merged = mergeWeeklyDemand(fallbackDemand, simulatedDemand)
    weeklyDemand = merged.map(r => ({ week: r.week, resourceTypeName: r.resourceTypeName, demandDays: r.demandDays }))
  } else {
    weeklyDemand = fallbackDemand.map(r => ({ week: r.week, resourceTypeName: r.resourceTypeName, demandDays: r.demandDays }))
  }

  weeklyDemand = weeklyDemand.filter(row => row.demandDays > 0)
  const namedResourceAssignments = deriveNamedResourceAssignments({
    resourceTypes: project.resourceTypes,
    weeklyDemand,
    capacityPlanByRt,
  })

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
      const capacityPlanMaterialized = capacityPlanByRt.get(resourceType.id)

      const weeks = rtWeeks.get(resourceType.id)
      const demandDerivedStartWeek = weeks && weeks.starts.length > 0 ? Math.min(...weeks.starts) : null
      const demandDerivedEndWeek = weeks && weeks.ends.length > 0 ? Math.max(...weeks.ends) : null
      const derivedStartWeek =
        mode === 'CAPACITY_PLAN' && capacityPlanMaterialized?.startWeek != null
          ? capacityPlanMaterialized.startWeek
          : demandDerivedStartWeek
      const derivedEndWeek =
        mode === 'CAPACITY_PLAN' && capacityPlanMaterialized?.endWeek != null
          ? capacityPlanMaterialized.endWeek + 1
          : demandDerivedEndWeek

      const effectiveStartWeek = resourceType.allocationStartWeek ?? derivedStartWeek
      const effectiveEndWeek = resourceType.allocationEndWeek ?? derivedEndWeek

      const useCapacityPlanFallback =
        mode === 'CAPACITY_PLAN' &&
        shouldFallbackToActiveCapacityPlan(resourceType.namedResources, capacityPlanMaterialized)
      const namedResourcesSource = useCapacityPlanFallback && capacityPlanMaterialized
        ? capacityPlanMaterialized.slotWindows.map((window, idx) => {
            const existing = resourceType.namedResources[idx]
            return {
              id: existing?.id ?? `${resourceType.id}-capacity-plan-${idx + 1}`,
              name: existing?.name ?? `${resourceType.name} ${idx + 1}`,
              allocationMode: 'CAPACITY_PLAN',
              allocationPercent: window.allocationPercent,
              allocationStartWeek: null,
              allocationEndWeek: null,
              pricingModel: existing?.pricingModel === 'PRO_RATA' ? 'PRO_RATA' : 'ACTUAL_DAYS',
              startWeek: window.startWeek,
              endWeek: window.endWeek,
            }
          })
        : resourceType.namedResources
      const actualNamedResourceAssignment = namedResourceAssignments.get(resourceType.id)
      const actualNamedResourcesForType = actualNamedResourceAssignment?.namedResources ?? []
      const actualNamedResourceStartWeeks = actualNamedResourcesForType
        .map(namedResource => namedResource.actualAllocationStartWeek)
        .filter((week): week is number => week != null)
      const actualNamedResourceEndWeeks = actualNamedResourcesForType
        .map(namedResource => namedResource.actualAllocationEndWeek)
        .filter((week): week is number => week != null)
      const actualDerivedStartWeek = actualNamedResourceStartWeeks.length > 0
        ? Math.min(...actualNamedResourceStartWeeks)
        : null
      const actualDerivedEndWeek = actualNamedResourceEndWeeks.length > 0
        ? Math.max(...actualNamedResourceEndWeeks)
        : null

      // If named resources exist, compute per-NR allocatedDays
      const hasNamedResources = namedResourcesSource.length > 0

      let allocatedDays: number
      let rowDerivedStartWeek = derivedStartWeek
      let rowDerivedEndWeek = derivedEndWeek
      let namedResourcesOutput: Array<{
        id: string
        name: string
        allocationMode: string
        allocationPercent: number
        allocationStartWeek: number | null
        allocationEndWeek: number | null
        pricingModel: 'ACTUAL_DAYS' | 'PRO_RATA'
        startWeek: number | null
        endWeek: number | null
        allocatedDays: number
        derivedStartWeek: number | null
        derivedEndWeek: number | null
        actualAllocatedDays: number
        actualAllocationStartWeek: number | null
        actualAllocationEndWeek: number | null
        actualAllocatedWeeks: Array<{ week: number; days: number; capacityDays: number }>
        actualAllocationSegments: Array<{ startWeek: number; endWeek: number; days: number }>
        synthetic: boolean
      }>

      if (hasNamedResources) {
        // Compute per-NR allocated days
        namedResourcesOutput = namedResourcesSource.map(nr => {
          const actualNamedResource = actualNamedResourcesForType
            .find(actual => actual.id === nr.id)
          const nrMode = (nr.allocationMode as AllocationMode) ?? 'EFFORT'
          const nrPercent = nr.allocationPercent ?? 100
          let nrAllocatedDays: number
          if (nrMode === 'CAPACITY_PLAN') {
            const startWeek = nr.startWeek
            const endWeek = nr.endWeek
            const allocationRatio = (nrPercent ?? 100) / 100
            nrAllocatedDays = startWeek != null && endWeek != null
              ? round2(Math.max(0, endWeek - startWeek + 1) * 5 * allocationRatio)
              : 0
          } else if (nrMode === 'EFFORT') {
            // Split effort equally across named resources
            nrAllocatedDays = round2(totalDays / namedResourcesSource.length)
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
            pricingModel: nr.pricingModel === 'PRO_RATA' ? 'PRO_RATA' : 'ACTUAL_DAYS',
            startWeek: nr.startWeek ?? null,
            endWeek: nr.endWeek ?? null,
            allocatedDays: nrAllocatedDays,
            derivedStartWeek,
            derivedEndWeek,
            actualAllocatedDays: actualNamedResource?.actualAllocatedDays ?? 0,
            actualAllocationStartWeek: actualNamedResource?.actualAllocationStartWeek ?? null,
            actualAllocationEndWeek: actualNamedResource?.actualAllocationEndWeek ?? null,
            actualAllocatedWeeks: actualNamedResource?.actualAllocatedWeeks ?? [],
            actualAllocationSegments: actualNamedResource?.actualAllocationSegments ?? [],
            synthetic: actualNamedResource?.synthetic ?? false,
          }
        })
        const existingIds = new Set(namedResourcesOutput.map(nr => nr.id))
        const syntheticAssignments = actualNamedResourcesForType
          .filter(actual => !existingIds.has(actual.id))
        namedResourcesOutput.push(...syntheticAssignments.map(actual => ({
          id: actual.id,
          name: actual.name,
          allocationMode: actual.allocationMode,
          allocationPercent: actual.allocationPercent,
          allocationStartWeek: actual.allocationStartWeek,
          allocationEndWeek: actual.allocationEndWeek,
          pricingModel: actual.pricingModel,
          startWeek: actual.startWeek,
          endWeek: actual.endWeek,
          allocatedDays: actual.actualAllocatedDays,
          derivedStartWeek,
          derivedEndWeek,
          actualAllocatedDays: actual.actualAllocatedDays,
          actualAllocationStartWeek: actual.actualAllocationStartWeek,
          actualAllocationEndWeek: actual.actualAllocationEndWeek,
          actualAllocatedWeeks: actual.actualAllocatedWeeks,
          actualAllocationSegments: actual.actualAllocationSegments,
          synthetic: actual.synthetic,
        })))
        const plannedAllocatedDays = round2(namedResourcesOutput.reduce((sum, nr) => sum + nr.allocatedDays, 0))
        const actualAllocatedDays = round2(actualNamedResourceAssignment?.actualAllocatedDays ?? 0)
        const shouldUseActualAssignmentWindow =
          actualDerivedStartWeek != null &&
          actualDerivedEndWeek != null &&
          (
            derivedStartWeek == null ||
            actualDerivedStartWeek < derivedStartWeek ||
            derivedEndWeek == null ||
            actualDerivedEndWeek > derivedEndWeek
          )

        allocatedDays = round2(Math.max(plannedAllocatedDays, actualAllocatedDays))
        if (shouldUseActualAssignmentWindow) {
          rowDerivedStartWeek = actualDerivedStartWeek
          rowDerivedEndWeek = actualDerivedEndWeek
        }
      } else {
        namedResourcesOutput = []
        if (mode === 'CAPACITY_PLAN') {
          allocatedDays = capacityPlanByRt.get(resourceType.id)?.totalDays ?? totalDays
        } else if (mode === 'EFFORT') {
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
        derivedStartWeek: rowDerivedStartWeek,
        derivedEndWeek: rowDerivedEndWeek,
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
    const currentCount = overhead.resourceType?.count ?? null
    const computedDays =
      overhead.type === 'PERCENTAGE'
        ? round2((overhead.value / 100) * totalEffortDays)
        : overhead.type === 'DAYS_PER_WEEK'
          ? round2(overhead.value * projectDurationWeeks)
          : round2(overhead.value)
    const estimatedCost = dayRate != null ? round2(computedDays * dayRate) : null
    // Compute the effective FTE this overhead workload represents.
    // requiredFTE = computedDays / (projectDurationWeeks * 5 working days/week).
    const requiredFTE = projectDurationWeeks > 0
      ? round2(computedDays / (projectDurationWeeks * 5))
      : 0
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
      requiredFTE,
      currentCount,
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
    bufferWeeks: project.bufferWeeks ?? 0,
    onboardingWeeks: project.onboardingWeeks ?? 0,
    resourceRows,
    overheadRows,
    summary: {
      totalHours: totalResourceHours,
      totalDays: round2(totalResourceDays + totalOverheadDays),
      totalCost,
      hasCost,
    },
  })
}))

export default router
