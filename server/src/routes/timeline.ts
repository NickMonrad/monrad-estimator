import { resolveSchedulerCapacity } from '../lib/schedulerCapacityResolver.js'

import { Router, Response } from 'express'
import { prisma } from '../lib/prisma.js'
import { asyncHandler } from '../lib/asyncHandler.js'
import { authenticate, AuthRequest } from '../middleware/auth.js'
import { effectiveDays } from '../utils/round.js'
import {
  runScheduler,
  getWeeklyCapacity,
  computeParallelWarnings,
  type SchedulerInput,
  type SchedulerResourceType,
  type ParallelWarning,
} from '../lib/scheduler.js'
import {
  shouldFallbackToActiveCapacityPlan,
  type MaterializedCapacityPlanResource,
} from '../lib/capacityPlanMaterialisation.js'
import { deriveNamedResourceAssignments } from '../lib/namedResourceAssignments.js'
import { buildProjectPlanningModel, convertWeeklyDemandCache } from '../lib/projectPlanningModel.js'
import { runSAPlanner } from '../lib/sa-planner.js'
import { buildSnapshot } from './snapshots.js'
import { pruneSnapshots } from '../lib/snapshotUtils.js'
const router = Router({ mergeParams: true })
router.use(authenticate)

/**
 * Re-export for backward compatibility — timeline.test.ts imports this from
 * routes/timeline.js. The canonical implementation lives in lib/scheduler.ts.
 */
export { getWeeklyCapacity }

// Alias for internal use within this file
type AllocationMode = 'EFFORT' | 'TIMELINE' | 'FULL_PROJECT' | 'CAPACITY_PLAN'
type ResourceTypeWithNamed = SchedulerResourceType & { allocationMode?: AllocationMode | null }
type WeeklyDemandRow = { week: number; resourceTypeName: string; demandDays: number; capacityDays: number }

async function ownedProject(projectId: string, userId: string) {
  return prisma.project.findFirst({ where: { id: projectId, ownerId: userId } })
}

function computeDates(projectStartDate: Date | null, startWeek: number, durationWeeks: number, onboardingWeeks = 0) {
  if (!projectStartDate) return { startDate: null, endDate: null }
  const start = new Date(projectStartDate)
  start.setDate(start.getDate() + (startWeek + onboardingWeeks) * 7)
  const end = new Date(projectStartDate)
  end.setDate(end.getDate() + (startWeek + durationWeeks + onboardingWeeks) * 7)
  return { startDate: start.toISOString(), endDate: end.toISOString() }
}

function computeResourceBreakdown(
  feature: { userStories: { isActive: boolean | null; tasks: { resourceTypeId: string | null, hoursEffort: number, durationDays: number | null, resourceType: { name: string, hoursPerDay: number | null } | null }[] }[] },
  fallbackHpd: number
): { name: string; days: number }[] {
  const byRt = new Map<string, { name: string; days: number }>()
  for (const story of feature.userStories) {
    if (story.isActive === false) continue
    for (const task of story.tasks) {
      const key = task.resourceTypeId ?? '_unassigned'
      const name = task.resourceType?.name ?? 'Unassigned'
      const hpd = task.resourceType?.hoursPerDay ?? fallbackHpd
      const days = effectiveDays(task.durationDays, task.hoursEffort, hpd)
      const existing = byRt.get(key) ?? { name, days: 0 }
      byRt.set(key, { name, days: existing.days + days })
    }
  }
  return Array.from(byRt.values()).map(r => ({ name: r.name, days: Math.round(r.days * 10) / 10 }))
}

function buildWarningResourceTypes(
  resourceTypes: ResourceTypeWithNamed[],
  capacityPlanByRt: Map<string, MaterializedCapacityPlanResource>,
): ResourceTypeWithNamed[] {
  return resourceTypes.map(rt => {
    if ((rt.allocationMode as AllocationMode | null) !== 'CAPACITY_PLAN') return rt

    // Profile-backed named resources are already authoritative - skip fallback
    const hasAnyProfileSegments = (rt.namedResources ?? []).some(
      nr => nr.capacitySegments && nr.capacitySegments.length > 0,
    )
    if (hasAnyProfileSegments) return rt

    const materialized = capacityPlanByRt.get(rt.id)
    const useCapacityPlanFallback =
      shouldFallbackToActiveCapacityPlan(rt.namedResources ?? [], materialized)

    if (!useCapacityPlanFallback || !materialized) return rt

    return {
      ...rt,
      namedResources: (materialized.slotWindows ?? []).map((window, idx) => ({
        id: `${rt.id}-capacity-plan-${idx + 1}`,
        name: `${rt.name ?? ''} ${idx + 1}`,
        endWeek: window.endWeek,
        allocationMode: 'CAPACITY_PLAN' as const,
        allocationPercent: window.allocationPercent,
        allocationStartWeek: null,
        allocationEndWeek: null,
        startWeek: window.startWeek,
        allocationPct: window.allocationPercent,
        pricingModel: undefined,
      })),
    }
  })
}

function buildResponse(
  project: { id: string; startDate: Date | null; hoursPerDay: number; bufferWeeks?: number | null; onboardingWeeks?: number | null },
  entries: Array<{
    featureId: string
    feature: { name: string; order: number; timelineColour?: string | null; epic: { id: string; name: string; order: number; featureMode: string; scheduleMode: string; timelineStartWeek: number | null }; userStories: { isActive: boolean | null; tasks: { resourceTypeId: string | null, hoursEffort: number, durationDays: number | null, resourceType: { name: string, hoursPerDay: number | null } | null }[] }[] }
    startWeek: number
    durationWeeks: number
    isManual: boolean
  }>,
  parallelWarnings: ParallelWarning[] = [],
  storyEntries: Array<{
    storyId: string
    storyName: string
    featureId: string
    startWeek: number
    durationWeeks: number
    isManual: boolean
  }> = [],
  featureDeps: Array<{ featureId: string; dependsOnId: string }> = [],
  storyDeps: Array<{ storyId: string; dependsOnId: string }> = [],
  epicDeps: Array<{ epicId: string; dependsOnId: string }> = [],
  resourceTypes: ResourceTypeWithNamed[] = [],
  simulatedDemand?: Map<string, number>,  // key: `${resourceTypeId}|${week}` → days consumed
  capacityPlanByRt: Map<string, MaterializedCapacityPlanResource> = new Map(),
) {
  const rawMaxWeek = entries.length > 0
    ? Math.max(...entries.map(e => e.startWeek + e.durationWeeks))
    : null
  const maxWeek = rawMaxWeek != null ? rawMaxWeek + (project.bufferWeeks ?? 0) + (project.onboardingWeeks ?? 0) : null
  const projectedEndDate = (project.startDate && maxWeek != null)
    ? (() => { const d = new Date(project.startDate); d.setDate(d.getDate() + maxWeek * 7); return d.toISOString() })()
    : null

  // Build resource type lookup maps (name→RT and ID→name) for quick access
  const rtCountByName = new Map(resourceTypes.map(rt => [rt.name, rt.count]))
  const rtByName = new Map(resourceTypes.map(rt => [rt.name, rt]))
  const rtIdToName = new Map(resourceTypes.map(rt => [rt.id, rt.name]))

  const capacityDaysForWeek = (rt: ResourceTypeWithNamed, week: number) => {
    if ((rt.allocationMode as AllocationMode | null) === 'CAPACITY_PLAN') {
      const materialized = capacityPlanByRt.get(rt.id)
      if (materialized) return (materialized.weeklyHeadcount.get(week) ?? 0) * 5
    }
    const hpd = rt.hoursPerDay ?? project.hoursPerDay
    return getWeeklyCapacity(rt, week, project.hoursPerDay) / hpd
  }

  const weeklyDemandKey = (week: number, resourceTypeName: string) => `${week}|${resourceTypeName}`
  const weeklyDemandSort = (a: WeeklyDemandRow, b: WeeklyDemandRow) => a.week - b.week || a.resourceTypeName.localeCompare(b.resourceTypeName)
  const parseSimulatedDemandKey = (key: string) => {
    const separatorIdx = key.lastIndexOf('|')
    const rtId = key.substring(0, separatorIdx)
    const week = parseInt(key.substring(separatorIdx + 1), 10)
    return {
      resourceTypeName: rtIdToName.get(rtId) ?? 'Unknown resource',
      week,
    }
  }

  const buildFallbackWeeklyDemand = (): WeeklyDemandRow[] => {
    // Fallback: uniform spread (used by GET route with saved entries)
    const weeklyDemandMap = new Map<string, { demandDays: number; capacityDays: number }>()
    for (const e of entries) {
      if (e.durationWeeks <= 0) continue
      const featureStart = e.startWeek
      const featureEnd = e.startWeek + e.durationWeeks
      const breakdown = computeResourceBreakdown(e.feature, project.hoursPerDay)
      for (const { name, days } of breakdown) {
        const startW = Math.floor(featureStart)
        const endW = Math.ceil(featureEnd)
        const rt = rtByName.get(name)
        for (let w = startW; w < endW; w++) {
          // Only count the fraction of this integer week the feature actually occupies
          const overlap = Math.min(w + 1, featureEnd) - Math.max(w, featureStart)
          if (overlap <= 0) continue
          const key = weeklyDemandKey(w, name)
          // Variable capacity: use named resource availability for this week
          const capacityDays = rt
            ? capacityDaysForWeek(rt, w)
            : 5
          const existing = weeklyDemandMap.get(key) ?? { demandDays: 0, capacityDays }
          existing.demandDays += days * (overlap / e.durationWeeks)
          weeklyDemandMap.set(key, existing)
        }
      }
    }
    return Array.from(weeklyDemandMap.entries()).map(([key, { demandDays, capacityDays }]) => {
      const [weekStr, ...nameParts] = key.split('|')
      return {
        week: parseInt(weekStr, 10),
        resourceTypeName: nameParts.join('|'),
        demandDays: Math.round(demandDays * 10) / 10,
        capacityDays,
      }
    }).sort(weeklyDemandSort)
  }

  // Compute weekly demand across all features
  let weeklyDemand: WeeklyDemandRow[]

  if (simulatedDemand && simulatedDemand.size > 0) {
    // Use actual consumption from simulation where present. For RTs with cached demand,
    // missing weeks up to that RT's cached horizon are treated as zero demand
    // rather than being reintroduced from fallback spread.
    const fallbackDemand = buildFallbackWeeklyDemand()
    const cachedResourceTypes = new Set<string>()
    const cachedMaxWeekByRt = new Map<string, number>()

    for (const key of simulatedDemand.keys()) {
      const { resourceTypeName, week } = parseSimulatedDemandKey(key)
      cachedResourceTypes.add(resourceTypeName)
      const prev = cachedMaxWeekByRt.get(resourceTypeName) ?? Number.NEGATIVE_INFINITY
      cachedMaxWeekByRt.set(resourceTypeName, Math.max(prev, week))
    }

    const mergedDemand = new Map<string, WeeklyDemandRow>()

    for (const row of fallbackDemand) {
      const hasCachedDemand = cachedResourceTypes.has(row.resourceTypeName)
      // If a resource type has any cached scheduler demand, suppress every
      // fallback row for that resource type across the entire horizon.
      // This prevents duplicated demand from fallback rows after the final
      // cached week.
      if (hasCachedDemand) continue
      mergedDemand.set(weeklyDemandKey(row.week, row.resourceTypeName), row)
    }

    for (const [key, days] of simulatedDemand.entries()) {
      const { resourceTypeName: rtName, week } = parseSimulatedDemandKey(key)
      const rt = rtByName.get(rtName)
      const capacityDays = rt
        ? capacityDaysForWeek(rt, week)
        : 5
      mergedDemand.set(weeklyDemandKey(week, rtName), {
        week,
        resourceTypeName: rtName,
        demandDays: Math.round(days * 100) / 100,
        capacityDays,
      })
    }

    weeklyDemand = Array.from(mergedDemand.values())
      .filter(d => d.demandDays > 0)
      .sort(weeklyDemandSort)
  } else {
    weeklyDemand = buildFallbackWeeklyDemand()
  }

  // Build weekly capacity array for EVERY week (0..maxWeek-1) for RTs that have hours
  const rtNamesWithHours = new Set(weeklyDemand.map(d => d.resourceTypeName))
  const weeklyCapacity: { week: number; resourceTypeName: string; capacityDays: number }[] = []
  // Ensure capacity covers at least as far as the maximum demand week
  const maxDemandWeek = weeklyDemand.length > 0
    ? Math.max(...weeklyDemand.map(d => d.week))
    : 0
  const capacityEndWeek = Math.max(maxWeek != null ? Math.ceil(maxWeek) : 0, maxDemandWeek + 1)
  if (capacityEndWeek > 0) {
    for (const rt of resourceTypes) {
      if (!rtNamesWithHours.has(rt.name)) continue
      for (let w = 0; w < capacityEndWeek; w++) {
        const capDays = capacityDaysForWeek(rt, w)
        weeklyCapacity.push({ week: w, resourceTypeName: rt.name, capacityDays: Math.round(capDays * 10) / 10 })
      }
    }
  }

  const namedResourceAssignments = deriveNamedResourceAssignments({
    resourceTypes,
    weeklyDemand,
    capacityPlanByRt,
  })

  const namedResourcesList = resourceTypes
    .filter(rt => rtNamesWithHours.has(rt.name))
    .flatMap(rt => (
      namedResourceAssignments.get(rt.id)?.namedResources.map(namedResource => ({
        id: namedResource.id,
        resourceTypeId: rt.id,
        resourceTypeName: rt.name,
        name: namedResource.name,
        startWeek: namedResource.startWeek,
        endWeek: namedResource.endWeek,
        allocationPct: namedResource.allocationMode === 'EFFORT'
          ? 100
          : Math.round(namedResource.allocationPercent),
        allocationMode: namedResource.allocationMode,
        allocationPercent: namedResource.allocationPercent,
        allocationStartWeek: namedResource.allocationStartWeek,
        allocationEndWeek: namedResource.allocationEndWeek,
        pricingModel: namedResource.pricingModel,
        actualAllocatedDays: namedResource.actualAllocatedDays,
        actualAllocationStartWeek: namedResource.actualAllocationStartWeek,
        actualAllocationEndWeek: namedResource.actualAllocationEndWeek,
        actualAllocatedWeeks: namedResource.actualAllocatedWeeks,
        actualAllocationSegments: namedResource.actualAllocationSegments,
        synthetic: namedResource.synthetic,
      })) ?? []
    ))

  return {
    projectId: project.id,
    startDate: project.startDate?.toISOString() ?? null,
    hoursPerDay: project.hoursPerDay,
    projectedEndDate,
    bufferWeeks: project.bufferWeeks ?? 0,
    onboardingWeeks: project.onboardingWeeks ?? 0,
    parallelWarnings,
    storyEntries,
    featureDependencies: featureDeps,
    storyDependencies: storyDeps,
    epicDependencies: epicDeps,
    weeklyDemand,
    weeklyCapacity,
    namedResources: namedResourcesList,
    entries: entries.map(e => {
      const breakdown = computeResourceBreakdown(e.feature, project.hoursPerDay)
      const durationWeeksActual = Math.max(e.durationWeeks, 0.01)
      const effectiveEngineers = breakdown.map(({ name, days }) => {
        const totalEngineers = rtCountByName.get(name) ?? 1
        return {
          name,
          engineerEquivalent: Math.round((days / (durationWeeksActual * 5)) * 100) / 100,
          totalEngineers,
        }
      })
      return {
        featureId: e.featureId,
        featureName: e.feature.name,
        epicId: e.feature.epic.id,
        epicName: e.feature.epic.name,
        epicOrder: e.feature.epic.order,
        epicFeatureMode: e.feature.epic.featureMode,
        epicScheduleMode: e.feature.epic.scheduleMode,
        epicTimelineStartWeek: e.feature.epic.timelineStartWeek,
        featureOrder: e.feature.order,
        timelineColour: e.feature.timelineColour ?? null,
        startWeek: e.startWeek,
        durationWeeks: e.durationWeeks,
        isManual: e.isManual,
        resourceBreakdown: breakdown,
        effectiveEngineers,
        ...computeDates(project.startDate, e.startWeek, e.durationWeeks, project.onboardingWeeks ?? 0),
      }
    }),
  }
}

// GET /api/projects/:projectId/timeline
router.get('/', asyncHandler(async (req: AuthRequest, res: Response) => {
  const model = await buildProjectPlanningModel(req.params.projectId as string, req.userId!)
    .catch(() => { res.status(404).json({ error: 'Project not found' }); return null })
  if (!model) return

  const { projectId, planningWindow, storyEntries } = model

  // Build entries with resource breakdown (route-specific formatting)
  // Need the full feature objects to compute breakdown
  // Reload raw entries for the breakdown computation
  // TODO(#268): move feature-entry presentation formatting into the shared model
  const rawEntries = await prisma.timelineEntry.findMany({
    where: { projectId },
    include: {
      feature: {
        include: {
          epic: true,
          userStories: {
            include: {
              tasks: { include: { resourceType: true } },
            },
          },
        },
      },
    },
    orderBy: { startWeek: 'asc' },
  })
  const activeRawEntries = rawEntries.filter(
    e => e.feature.isActive !== false && e.feature.epic.isActive !== false,
  )

  // Group named resources by resource type for the response
  const rtNameById = new Map(model.resourceTypeFacts.map(rt => [rt.id, rt.name]))

  const namedResourcesList = Array.from(model.namedResourceAssignments.entries()).flatMap(([rtId, assignment]) =>
    assignment.namedResources.map(nr => ({
      id: nr.id,
      resourceTypeId: rtId,
      resourceTypeName: rtNameById.get(rtId) ?? '',
      name: nr.name,
      startWeek: nr.startWeek,
      endWeek: nr.endWeek,
      allocationPct: nr.allocationMode === 'EFFORT' ? 100 : Math.round(nr.allocationPercent),
      allocationMode: nr.allocationMode,
      allocationPercent: nr.allocationPercent,
      allocationStartWeek: nr.allocationStartWeek,
      allocationEndWeek: nr.allocationEndWeek,
      pricingModel: nr.pricingModel,
      actualAllocatedDays: nr.actualAllocatedDays,
      actualAllocationStartWeek: nr.actualAllocationStartWeek,
      actualAllocationEndWeek: nr.actualAllocationEndWeek,
      actualAllocatedWeeks: nr.actualAllocatedWeeks,
      actualAllocationSegments: nr.actualAllocationSegments,
      synthetic: nr.synthetic,
    }))
  )

  const projectStartDate = model.startDate ? new Date(model.startDate) : null
  res.json({
    projectId,
    startDate: model.startDate,
    hoursPerDay: model.hoursPerDay,
    projectedEndDate: planningWindow.projectedEndDate,
    bufferWeeks: planningWindow.bufferWeeks,
    onboardingWeeks: planningWindow.onboardingWeeks,
    parallelWarnings: model.parallelWarnings,
    storyEntries,
    featureDependencies: model.featureDependencies,
    storyDependencies: model.storyDependencies,
    epicDependencies: model.epicDependencies,
    weeklyDemand: model.weeklyDemand,
    weeklyCapacity: model.weeklyCapacity,
    namedResources: namedResourcesList,
    entries: activeRawEntries.map(e => {
      const breakdown = computeResourceBreakdown(e.feature, model.hoursPerDay)
      const durationWeeksActual = Math.max(e.durationWeeks, 0.01)
      const effectiveEngineers = breakdown.map(({ name, days }) => ({
        name,
        engineerEquivalent: Math.round((days / (durationWeeksActual * 5)) * 100) / 100,
      }))
      return {
        featureId: e.featureId,
        featureName: e.feature.name,
        epicId: e.feature.epic.id,
        epicName: e.feature.epic.name,
        epicOrder: e.feature.epic.order,
        epicFeatureMode: e.feature.epic.featureMode,
        epicScheduleMode: e.feature.epic.scheduleMode,
        epicTimelineStartWeek: e.feature.epic.timelineStartWeek,
        featureOrder: e.feature.order,
        timelineColour: e.feature.timelineColour ?? null,
        startWeek: e.startWeek,
        durationWeeks: e.durationWeeks,
        isManual: e.isManual,
        resourceBreakdown: breakdown,
        effectiveEngineers,
        ...computeDates(projectStartDate, e.startWeek, e.durationWeeks, planningWindow.onboardingWeeks),
      }
    }),
  })
}))
// POST /api/projects/:projectId/timeline/schedule
router.post('/schedule', asyncHandler(async (req: AuthRequest, res: Response) => {
  let project = await ownedProject(req.params.projectId as string, req.userId!)
  if (!project) { res.status(404).json({ error: 'Project not found' }); return }

  const { startDate } = req.body
  const resourceLevel: boolean = req.body.resourceLevel === true
  if (startDate) {
    project = await prisma.project.update({
      where: { id: project.id },
      data: { startDate: new Date(startDate) },
    })
  }

  // ── 1. Load data from Prisma ───────────────────────────────────────────────

  const allEpics = await prisma.epic.findMany({
    where: { projectId: project.id },
    orderBy: { order: 'asc' },
    include: {
      features: {
        orderBy: { order: 'asc' },
        include: {
          userStories: {
            orderBy: { order: 'asc' },
            include: {
              tasks: { include: { resourceType: true } },
              dependencies: true,
            },
          },
          dependencies: true,
        },
      },
    },
  })

  // Remove inactive epics and features from scheduling
  const inactiveFeatureIds = allEpics.flatMap(e =>
    e.isActive === false
      ? e.features.map(f => f.id)
      : e.features.filter(f => f.isActive === false).map(f => f.id)
  )
  if (inactiveFeatureIds.length > 0) {
    await prisma.timelineEntry.deleteMany({ where: { featureId: { in: inactiveFeatureIds } } })
  }
  const epics = allEpics
    .filter(e => e.isActive !== false)
    .map(e => ({ ...e, features: e.features.filter(f => f.isActive !== false) }))
  // Use shared profile-first capacity resolver
  const resolved = await resolveSchedulerCapacity(prisma, project.id, project.hoursPerDay)
  const resourceTypes = resolved.resourceTypes
  const capacityPlanByRt = resolved.capacityPlanByRt
  const warningResourceTypes = buildWarningResourceTypes(resourceTypes as ResourceTypeWithNamed[], capacityPlanByRt)

  const existingEntries = await prisma.timelineEntry.findMany({
    where: { projectId: project.id, isManual: true },
  })
  const existingStoryEntries = await prisma.storyTimelineEntry.findMany({
    where: { projectId: project.id, isManual: true },
  })
  const epicDeps = await prisma.epicDependency.findMany({
    where: { epic: { projectId: project.id } },
    select: { epicId: true, dependsOnId: true },
  })

  // ── 2. Run the pure scheduler ─────────────────────────────────────────────

  const { featureSchedule, storySchedule, weeklyConsumptionMap } = runScheduler({
    project: { hoursPerDay: project.hoursPerDay },
    epics,
    resourceTypes,
    epicDeps,
    manualFeatureEntries: existingEntries.map(e => ({
      featureId: e.featureId,
      startWeek: e.startWeek,
      durationWeeks: e.durationWeeks,
    })),
    manualStoryEntries: existingStoryEntries.map(e => ({
      storyId: e.storyId,
      startWeek: e.startWeek,
    })),
    resourceLevel,
  })

  // ── 3. Write results to DB ────────────────────────────────────────────────

  // Feature timeline upserts
  await Promise.all(featureSchedule.map(({ featureId, startWeek, durationWeeks, isManual }) =>
    prisma.timelineEntry.upsert({
      where: { featureId },
      create: { projectId: project.id, featureId, startWeek, durationWeeks, isManual },
      update: isManual ? {} : { startWeek, durationWeeks, isManual: false },
    })
  ))

  // Story timeline upserts
  await Promise.all(storySchedule.map(({ storyId, startWeek, durationWeeks, isManual }) =>
    prisma.storyTimelineEntry.upsert({
      where: { storyId },
      create: { storyId, projectId: project.id, startWeek, durationWeeks, isManual },
      update: isManual ? {} : { startWeek, durationWeeks, isManual: false },
    })
  ))

  // Persist the weekly demand cache so GET /timeline can reuse actual consumption
  // data rather than falling back to uniform spread.
  await prisma.project.update({
    where: { id: project.id },
    data: { weeklyDemandCache: Object.fromEntries(weeklyConsumptionMap) },
  })

  // ── 4. Re-fetch and build HTTP response ────────────────────────────────────

  const entries = await prisma.timelineEntry.findMany({
    where: { projectId: project.id },
    include: {
      feature: {
        include: {
          epic: true,
          userStories: { include: { tasks: { include: { resourceType: true } } } },
        },
      },
    },
    orderBy: { startWeek: 'asc' },
  })

  const storyTimelineEntries = await prisma.storyTimelineEntry.findMany({
    where: { projectId: project.id },
    include: { story: { select: { name: true, featureId: true } } },
  })
  const allFeatureIds = entries.map(e => e.featureId)
  const [featureDependencies, storyDependencies] = await Promise.all([
    prisma.featureDependency.findMany({ where: { featureId: { in: allFeatureIds } }, select: { featureId: true, dependsOnId: true } }),
    prisma.storyDependency.findMany({ where: { storyId: { in: storyTimelineEntries.map(e => e.storyId) } }, select: { storyId: true, dependsOnId: true } }),
  ])

  const mappedStoryEntries = storyTimelineEntries.map(e => ({
    storyId: e.storyId,
    storyName: e.story.name,
    featureId: e.story.featureId,
    startWeek: e.startWeek,
    durationWeeks: e.durationWeeks,
    isManual: e.isManual,
  }))

  const activeEntries = entries.filter(e => e.feature.isActive !== false && e.feature.epic.isActive !== false)
  const activeFeatures = activeEntries.map(e => e.feature)
  const parallelWarnings = computeParallelWarnings(
    project.hoursPerDay,
    activeEntries,
    activeFeatures,
    warningResourceTypes,
  )

  res.json(buildResponse(project, entries, parallelWarnings, mappedStoryEntries, featureDependencies, storyDependencies, epicDeps, resourceTypes as ResourceTypeWithNamed[], weeklyConsumptionMap, capacityPlanByRt))
}))

// PUT /api/projects/:projectId/timeline/stories/:storyId — manual story timeline override
router.put('/stories/:storyId', asyncHandler(async (req: AuthRequest, res: Response) => {
  const project = await ownedProject(req.params.projectId as string, req.userId!)
  if (!project) { res.status(404).json({ error: 'Project not found' }); return }

  const { startWeek, durationWeeks } = req.body
  if (startWeek == null || durationWeeks == null) {
    res.status(400).json({ error: 'startWeek and durationWeeks are required' }); return
  }

  const storyId = req.params.storyId as string

  // Verify story belongs to this project
  const story = await prisma.userStory.findFirst({
    where: { id: storyId, feature: { epic: { projectId: project.id } } },
    include: { feature: { include: { epic: true } } },
  })
  if (!story) { res.status(404).json({ error: 'Story not found' }); return }

  const entry = await prisma.storyTimelineEntry.upsert({
    where: { storyId },
    create: { storyId, projectId: project.id, startWeek, durationWeeks, isManual: true },
    update: { startWeek, durationWeeks, isManual: true },
  })

  // Manual story timeline change invalidates cached scheduler demand
  await prisma.project.update({
    where: { id: project.id },
    data: { weeklyDemandCache: {} },
  })

  res.json({
    storyId: entry.storyId,
    storyName: story.name,
    featureId: story.featureId,
    projectId: entry.projectId,
    startWeek: entry.startWeek,
    durationWeeks: entry.durationWeeks,
    isManual: entry.isManual,
  })
}))

// DELETE /api/projects/:projectId/timeline — clear ALL manual overrides (features + stories)
router.delete('/', asyncHandler(async (req: AuthRequest, res: Response) => {
  const project = await ownedProject(req.params.projectId as string, req.userId!)
  if (!project) { res.status(404).json({ error: 'Project not found' }); return }

  await Promise.all([
    prisma.timelineEntry.deleteMany({ where: { projectId: project.id, isManual: true } }),
    prisma.storyTimelineEntry.deleteMany({ where: { projectId: project.id, isManual: true } }),
  ])

  // Clearing manual overrides invalidates cached scheduler demand
  await prisma.project.update({
    where: { id: project.id },
    data: { weeklyDemandCache: {} },
  })

  res.status(204).end()
}))

// DELETE /api/projects/:projectId/timeline/stories/:storyId — clear manual story override
router.delete('/stories/:storyId', asyncHandler(async (req: AuthRequest, res: Response) => {
  const project = await ownedProject(req.params.projectId as string, req.userId!)
  if (!project) { res.status(404).json({ error: 'Project not found' }); return }

  await prisma.storyTimelineEntry.deleteMany({
    where: { storyId: req.params.storyId as string, projectId: project.id },
  })

  // Deleting a manual story override invalidates cached demand
  await prisma.project.update({
    where: { id: project.id },
    data: { weeklyDemandCache: {} },
  })

  res.status(204).end()
}))


// GET /api/projects/:projectId/timeline/export/csv
router.get('/export/csv', asyncHandler(async (req: AuthRequest, res: Response) => {
  const project = await prisma.project.findFirst({
    where: { id: req.params.projectId as string, ownerId: req.userId },
    include: {
      resourceTypes: { include: { namedResources: true } },
    },
  })
  if (!project) { res.status(404).json({ error: 'Project not found' }); return }

  const projectId = project.id
  const hpd = project.hoursPerDay

  // Section 1 — Gantt
  const timelineEntries = await prisma.timelineEntry.findMany({
    where: { projectId },
    include: {
      feature: {
        include: { epic: true },
      },
    },
    orderBy: { startWeek: 'asc' },
  })

  function toDateStr(startDate: Date | null, offsetWeeks: number): string {
    if (!startDate) return ''
    const d = new Date(startDate)
    d.setDate(d.getDate() + offsetWeeks * 7)
    return d.toISOString().slice(0, 10)
  }

  const ganttRows: string[] = ['Feature,Epic,StartWeek,DurationWeeks,StartDate,EndDate']
  for (const e of timelineEntries) {
    const featureName = e.feature.name.replace(/,/g, ' ')
    const epicName = e.feature.epic.name.replace(/,/g, ' ')
    const onboardingWeeks = project.onboardingWeeks ?? 0
    const startDate = toDateStr(project.startDate, e.startWeek + onboardingWeeks)
    const endDate = toDateStr(project.startDate, e.startWeek + e.durationWeeks + onboardingWeeks)
    ganttRows.push(`${featureName},${epicName},${e.startWeek},${e.durationWeeks},${startDate},${endDate}`)
  }

  // Section 2 — Resource Demand
  const demandRows: string[] = ['ResourceType,Week,DemandDays,CapacityDays,Status']
  if (project.weeklyDemandCache) {
    const simulatedDemand = convertWeeklyDemandCache(
      project.weeklyDemandCache as Record<string, number>,
      project.resourceTypes as Array<{ id: string; name: string }>,
    )
    const cacheEntries = Array.from(simulatedDemand.entries()).map(([key, demandDays]) => {
      const pipeIdx = key.lastIndexOf('|')
      const rtName = key.slice(0, pipeIdx)
      const week = Number(key.slice(pipeIdx + 1))
      return { rtName, week, demandDays }
    }).sort((a, b) => a.week - b.week || a.rtName.localeCompare(b.rtName))

    const rtByName = new Map(project.resourceTypes.map(rt => [rt.name, rt as ResourceTypeWithNamed]))
    for (const { rtName, week, demandDays } of cacheEntries) {
      const rt = rtByName.get(rtName)
      const capacityHours = rt ? getWeeklyCapacity(rt, week, hpd) : hpd * 5
      const capacityDays = capacityHours / hpd
      const d = Math.round(demandDays * 100) / 100
      const c = Math.round(capacityDays * 100) / 100
      const status = d > c ? 'Over' : d === c ? 'At capacity' : 'Under'
      demandRows.push(`${rtName.replace(/,/g, ' ')},${week},${d},${c},${status}`)
    }
  }

  // Section 3 — Named Resources
  // Compute derivedStartWeek/derivedEndWeek per resource type from timeline entries
  // (same logic as resourceProfile route)
  const [storyTimelineEntries, tasksForRt] = await Promise.all([
    prisma.storyTimelineEntry.findMany({
      where: { projectId },
      select: { storyId: true, startWeek: true, durationWeeks: true },
    }),
    prisma.task.findMany({
      where: { userStory: { feature: { epic: { projectId } } }, resourceTypeId: { not: null } },
      select: {
        resourceTypeId: true,
        userStoryId: true,
        userStory: { select: { featureId: true } },
      },
    }),
  ])

  // featureId → { startWeek, endWeek } from the already-fetched gantt entries
  const featureWeekMap = new Map(
    timelineEntries.map(e => [e.featureId, { startWeek: e.startWeek, endWeek: e.startWeek + e.durationWeeks }])
  )
  const storyEntryMap2 = new Map(storyTimelineEntries.map(e => [e.storyId, e]))

  const rtWeeks = new Map<string, { starts: number[]; ends: number[] }>()
  for (const task of tasksForRt) {
    if (!task.resourceTypeId) continue
    const storyEntry = task.userStoryId ? storyEntryMap2.get(task.userStoryId) : null
    const featureEntry = task.userStory?.featureId ? featureWeekMap.get(task.userStory.featureId) : null
    const entry = storyEntry
      ? { startWeek: storyEntry.startWeek, endWeek: storyEntry.startWeek + storyEntry.durationWeeks }
      : featureEntry ?? null
    if (!entry) continue
    if (!rtWeeks.has(task.resourceTypeId)) rtWeeks.set(task.resourceTypeId, { starts: [], ends: [] })
    rtWeeks.get(task.resourceTypeId)!.starts.push(entry.startWeek)
    rtWeeks.get(task.resourceTypeId)!.ends.push(entry.endWeek)
  }

  const namedResources = await prisma.namedResource.findMany({
    where: { resourceType: { projectId } },
    include: { resourceType: true },
    orderBy: [{ resourceType: { name: 'asc' } }, { name: 'asc' }],
  })

  function allocationModeLabel(mode: string): string {
    if (mode === 'EFFORT') return 'T&M'
    if (mode === 'TIMELINE') return 'Timeline'
    return 'Full Project'
  }

  const nrRows: string[] = ['Name,ResourceType,AllocationType,AllocationPct,StartWeek,EndWeek']
  for (const nr of namedResources) {
    const name = nr.name.replace(/,/g, ' ')
    const rtName = nr.resourceType.name.replace(/,/g, ' ')
    const modeLabel = allocationModeLabel(nr.allocationMode)
    const pct = nr.allocationPercent

    let startW: number | string = ''
    let endW: number | string = ''
    if (nr.allocationMode === 'TIMELINE') {
      const weeks = rtWeeks.get(nr.resourceTypeId)
      const derivedStart = weeks && weeks.starts.length > 0 ? Math.min(...weeks.starts) : null
      const derivedEnd = weeks && weeks.ends.length > 0 ? Math.max(...weeks.ends) : null
      const rawStart = nr.allocationStartWeek ?? derivedStart ?? null
      const rawEnd = nr.allocationEndWeek ?? derivedEnd ?? null
      startW = rawStart != null ? Math.floor(rawStart) : ''
      endW = rawEnd != null ? Math.floor(rawEnd) : ''
    }
    nrRows.push(`${name},${rtName},${modeLabel},${pct},${startW},${endW}`)
  }

  const today = new Date().toISOString().slice(0, 10)
  const projectName = project.name.replace(/[/\\?%*:|"<>]/g, '-')
  const filename = `${projectName} - Timeline - ${today}.csv`

  const csv = [
    ganttRows.join('\n'),
    '',
    demandRows.join('\n'),
    '',
    nrRows.join('\n'),
  ].join('\n')

  res.setHeader('Content-Type', 'text/csv; charset=utf-8')
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
  res.send(csv)
}))

// POST /api/projects/:projectId/timeline/level
// Must be registered BEFORE /:featureId to avoid param capture.
router.post('/level', asyncHandler(async (req: AuthRequest, res: Response) => {
  const projectId = req.params.projectId as string
  const project = await ownedProject(projectId, req.userId!)
  if (!project) { res.status(404).json({ error: 'Project not found' }); return }

  const { dryRun } = req.body as { dryRun?: boolean }

  // ── 1. Load scheduler input (same pattern as POST /schedule) ─────────────
  const [allEpics, resourceTypes, manualFeatures, manualStories, epicDeps] = await Promise.all([
    prisma.epic.findMany({
      where: { projectId },
      orderBy: { order: 'asc' },
      include: {
        features: {
          orderBy: { order: 'asc' },
          include: {
            userStories: {
              orderBy: { order: 'asc' },
              include: {
                tasks: { include: { resourceType: true } },
                dependencies: true,
              },
            },
            dependencies: true,
          },
        },
      },
    }),
    prisma.resourceType.findMany({ where: { projectId }, include: { namedResources: true } }),
    prisma.timelineEntry.findMany({ where: { projectId, isManual: true } }),
    prisma.storyTimelineEntry.findMany({ where: { projectId, isManual: true } }),
    prisma.epicDependency.findMany({
      where: { epic: { projectId } },
      select: { epicId: true, dependsOnId: true },
    }),
  ])

  const activeEpics = allEpics
    .filter(e => e.isActive !== false)
    .map(e => ({ ...e, features: e.features.filter(f => f.isActive !== false) }))

  const schedulerInput: SchedulerInput = {
    project: { hoursPerDay: project.hoursPerDay },
    epics: activeEpics,
    resourceTypes: resourceTypes as SchedulerResourceType[],
    epicDeps,
    manualFeatureEntries: manualFeatures.map(e => ({
      featureId: e.featureId,
      startWeek: e.startWeek,
      durationWeeks: e.durationWeeks,
    })),
    manualStoryEntries: manualStories.map(e => ({
      storyId: e.storyId,
      startWeek: e.startWeek,
    })),
    resourceLevel: false,
  }

  // ── 2. Run the SA planner for optimised levelling ──────────────────────────
  const saResult = runSAPlanner(schedulerInput, {
    targetDurationWeeks: schedulerInput.epics.length * 13,
    maxParallelismPerFeature: 2,
  })
  const levellingResult = {
    epicStartWeeks: saResult.epicStartWeeks,
    featureStartWeeks: saResult.featureStartWeeks,
    totalDeliveryWeeks: saResult.totalDeliveryWeeks,
    peakUtilisationPct: saResult.peakUtilisationPct,
  }

  if (dryRun) {
    res.json({
      epicStartWeeks: Object.fromEntries(levellingResult.epicStartWeeks),
      featureStartWeeks: Object.fromEntries(levellingResult.featureStartWeeks),
      totalDeliveryWeeks: levellingResult.totalDeliveryWeeks,
      peakUtilisationPct: levellingResult.peakUtilisationPct,
    })
    return
  }

  // ── 3. Persist: snapshot → update Epic.timelineStartWeek → re-materialise ─
  const snapshotData = await buildSnapshot(projectId)
  const dateStr = new Date().toISOString().slice(0, 10)
  const snap = await prisma.backlogSnapshot.create({
    data: {
      projectId,
      label: `Auto-saved before resource levelling — ${dateStr}`,
      trigger: 'level_resources',
      snapshot: snapshotData as unknown as object,
      createdById: req.userId!,
    },
    select: { id: true },
  })
  await pruneSnapshots(prisma, projectId)

  // Update Epic.timelineStartWeek for each epic
  await Promise.all(
    Array.from(levellingResult.epicStartWeeks.entries()).map(([epicId, startWeek]) =>
      prisma.epic.update({ where: { id: epicId }, data: { timelineStartWeek: startWeek } })
    )
  )

  // Update Feature.timelineStartWeek for each feature
  await Promise.all(
    Array.from(levellingResult.featureStartWeeks.entries()).map(([featureId, startWeek]) =>
      prisma.feature.update({ where: { id: featureId }, data: { timelineStartWeek: startWeek } })
    )
  )

  // Re-run scheduler with updated start weeks and materialise timeline
  const updatedEpics = activeEpics.map(e => ({
    ...e,
    timelineStartWeek: levellingResult.epicStartWeeks.get(e.id) ?? e.timelineStartWeek,
    features: e.features.map(f => ({
      ...f,
      timelineStartWeek: levellingResult.featureStartWeeks.get(f.id) ?? f.timelineStartWeek ?? null,
    })),
  }))

  const { featureSchedule, storySchedule } = runScheduler({
    ...schedulerInput,
    epics: updatedEpics,
  })

  await prisma.$transaction(async tx => {
    await tx.timelineEntry.deleteMany({ where: { projectId, isManual: false } })
    const featureRows = featureSchedule
      .filter(e => !e.isManual)
      .map(e => ({
        projectId,
        featureId: e.featureId,
        startWeek: e.startWeek,
        durationWeeks: e.durationWeeks,
        isManual: false,
      }))
    if (featureRows.length > 0) {
      await tx.timelineEntry.createMany({ data: featureRows, skipDuplicates: true })
    }

    await tx.storyTimelineEntry.deleteMany({ where: { projectId, isManual: false } })
    const storyRows = storySchedule
      .filter(e => !e.isManual)
      .map(e => ({
        projectId,
        storyId: e.storyId,
        startWeek: e.startWeek,
        durationWeeks: e.durationWeeks,
        isManual: false,
      }))
    if (storyRows.length > 0) {
      await tx.storyTimelineEntry.createMany({ data: storyRows, skipDuplicates: true })
    }
  })

  // Resource levelling rewrites timeline entries — clear cached demand
  await prisma.project.update({
    where: { id: projectId },
    data: { weeklyDemandCache: {} },
  })

  res.json({
    epicStartWeeks: Object.fromEntries(levellingResult.epicStartWeeks),
    featureStartWeeks: Object.fromEntries(levellingResult.featureStartWeeks),
    snapshotId: snap.id,
    totalDeliveryWeeks: levellingResult.totalDeliveryWeeks,
    peakUtilisationPct: levellingResult.peakUtilisationPct,
  })
}))

// PUT /api/projects/:projectId/timeline/:featureId
router.put('/:featureId', asyncHandler(async (req: AuthRequest, res: Response) => {
  const project = await ownedProject(req.params.projectId as string, req.userId!)
  if (!project) { res.status(404).json({ error: 'Project not found' }); return }

  const { startWeek, durationWeeks } = req.body
  if (startWeek == null || durationWeeks == null) {
    res.status(400).json({ error: 'startWeek and durationWeeks are required' }); return
  }

  const featureId = req.params.featureId as string
  const feature = await prisma.feature.findFirst({ where: { id: featureId, epic: { projectId: project.id } } })
  if (!feature) { res.status(404).json({ error: 'Feature not found' }); return }


  // Manual feature timeline change invalidates cached scheduler demand
  await prisma.project.update({
    where: { id: project.id },
    data: { weeklyDemandCache: {} },
  })

  const entry = await prisma.timelineEntry.upsert({
    where: { featureId },
    create: { projectId: project.id, featureId, startWeek, durationWeeks, isManual: true },
    update: { startWeek, durationWeeks, isManual: true },
    include: { feature: { include: { epic: true } } },
  })

  res.json({
    featureId: entry.featureId,
    featureName: entry.feature.name,
    epicId: entry.feature.epic.id,
    epicName: entry.feature.epic.name,
    epicFeatureMode: entry.feature.epic.featureMode,
    epicScheduleMode: entry.feature.epic.scheduleMode,
    epicTimelineStartWeek: entry.feature.epic.timelineStartWeek,
    startWeek: entry.startWeek,
    durationWeeks: entry.durationWeeks,
    isManual: entry.isManual,
    ...computeDates(project.startDate, entry.startWeek, entry.durationWeeks, project.onboardingWeeks ?? 0),
  })
}))


// DELETE /api/projects/:projectId/timeline/:featureId — clear manual override
router.delete('/:featureId', asyncHandler(async (req: AuthRequest, res: Response) => {
  const project = await ownedProject(req.params.projectId as string, req.userId!)
  if (!project) { res.status(404).json({ error: 'Project not found' }); return }

  await prisma.timelineEntry.deleteMany({
    where: { featureId: req.params.featureId as string, projectId: project.id },
  })

  // Clearing a feature manual override invalidates cached demand
  await prisma.project.update({
    where: { id: project.id },
    data: { weeklyDemandCache: {} },
  })

  res.status(204).end()
}))


// PATCH /api/projects/:projectId/timeline/start-date
router.patch('/start-date', asyncHandler(async (req: AuthRequest, res: Response) => {
  const project = await ownedProject(req.params.projectId as string, req.userId!)
  if (!project) { res.status(404).json({ error: 'Project not found' }); return }

  const { startDate } = req.body
  if (!startDate) { res.status(400).json({ error: 'startDate is required' }); return }

  const updated = await prisma.project.update({
    where: { id: project.id },
    data: { startDate: new Date(startDate) },
  })

  res.json({ startDate: updated.startDate?.toISOString() ?? null })
}))

export default router
