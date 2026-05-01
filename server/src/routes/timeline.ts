import { Router, Response } from 'express'
import { prisma } from '../lib/prisma.js'
import { asyncHandler } from '../lib/asyncHandler.js'
import { authenticate, AuthRequest } from '../middleware/auth.js'
import {
  runScheduler,
  getWeeklyCapacity,
  computeParallelWarnings,
  type SchedulerInput,
  type SchedulerResourceType,
  type ParallelWarning,
} from '../lib/scheduler.js'
import { levelEpicStarts } from '../lib/leveller.js'
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
type ResourceTypeWithNamed = SchedulerResourceType

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
      const days = task.durationDays ?? (task.hoursEffort / hpd)
      const existing = byRt.get(key) ?? { name, days: 0 }
      byRt.set(key, { name, days: existing.days + days })
    }
  }
  return Array.from(byRt.values()).map(r => ({ name: r.name, days: Math.round(r.days * 10) / 10 }))
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
  simulatedDemand?: Map<string, number>,  // key: `${rtName}|${week}` → days consumed
) {
  const rawMaxWeek = entries.length > 0
    ? Math.max(...entries.map(e => e.startWeek + e.durationWeeks))
    : null
  const maxWeek = rawMaxWeek != null ? rawMaxWeek + (project.bufferWeeks ?? 0) + (project.onboardingWeeks ?? 0) : null
  const projectedEndDate = (project.startDate && maxWeek != null)
    ? (() => { const d = new Date(project.startDate); d.setDate(d.getDate() + maxWeek * 7); return d.toISOString() })()
    : null

  // Build resource type count map (name → count) for quick lookup
  const rtCountByName = new Map(resourceTypes.map(rt => [rt.name, rt.count]))
  const rtByName = new Map(resourceTypes.map(rt => [rt.name, rt]))

  // Compute weekly demand across all features
  let weeklyDemand: { week: number; resourceTypeName: string; demandDays: number; capacityDays: number }[]

  if (simulatedDemand && simulatedDemand.size > 0) {
    // Use actual consumption from simulation — accurate, never exceeds capacity
    weeklyDemand = Array.from(simulatedDemand.entries())
      .map(([key, days]) => {
        const separatorIdx = key.lastIndexOf('|')
        const rtName = key.substring(0, separatorIdx)
        const week = parseInt(key.substring(separatorIdx + 1), 10)
        const rt = rtByName.get(rtName)
        const capacityDays = rt
          ? getWeeklyCapacity(rt, week, project.hoursPerDay) / (rt.hoursPerDay ?? project.hoursPerDay)
          : 5
        return {
          week,
          resourceTypeName: rtName,
          demandDays: Math.round(days * 100) / 100,
          capacityDays,
        }
      })
      .filter(d => d.demandDays > 0)
      .sort((a, b) => a.week - b.week || a.resourceTypeName.localeCompare(b.resourceTypeName))
  } else {
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
          const key = `${w}|${name}`
          // Variable capacity: use named resource availability for this week
          const capacityDays = rt
            ? getWeeklyCapacity(rt, w, project.hoursPerDay) / (rt.hoursPerDay ?? project.hoursPerDay)
            : 5
          const existing = weeklyDemandMap.get(key) ?? { demandDays: 0, capacityDays }
          existing.demandDays += days * (overlap / e.durationWeeks)
          weeklyDemandMap.set(key, existing)
        }
      }
    }
    weeklyDemand = Array.from(weeklyDemandMap.entries()).map(([key, { demandDays, capacityDays }]) => {
      const [weekStr, ...nameParts] = key.split('|')
      return {
        week: parseInt(weekStr, 10),
        resourceTypeName: nameParts.join('|'),
        demandDays: Math.round(demandDays * 10) / 10,
        capacityDays,
      }
    }).sort((a, b) => a.week - b.week || a.resourceTypeName.localeCompare(b.resourceTypeName))
  }

  // Build weekly capacity array for EVERY week (0..maxWeek-1) for RTs that have hours
  const rtNamesWithHours = new Set(weeklyDemand.map(d => d.resourceTypeName))
  const weeklyCapacity: { week: number; resourceTypeName: string; capacityDays: number }[] = []
  if (maxWeek != null) {
    for (const rt of resourceTypes) {
      if (!rtNamesWithHours.has(rt.name)) continue
      const hpd = rt.hoursPerDay ?? project.hoursPerDay
      for (let w = 0; w < Math.ceil(maxWeek); w++) {
        const capDays = getWeeklyCapacity(rt, w, project.hoursPerDay) / hpd
        weeklyCapacity.push({ week: w, resourceTypeName: rt.name, capacityDays: Math.round(capDays * 10) / 10 })
      }
    }
  }

  // Build derived weeks per RT for display (Bug #8)
  const rtDerivedWeeks = new Map<string, { start: number; end: number }>()
  for (const d of weeklyDemand) {
    const rtName = d.resourceTypeName
    const week = d.week
    const existing = rtDerivedWeeks.get(rtName)
    if (!existing) {
      rtDerivedWeeks.set(rtName, { start: week, end: week })
    } else {
      existing.start = Math.min(existing.start, week)
      existing.end = Math.max(existing.end, week)
    }
  }

  // Build named resources list from resource types, auto-generating numbered
  // entries for RTs with count > 0 but no named resources that have demand.
  // Bug #7: filter to only include NRs where the RT actually has demand
  const namedResourcesList = resourceTypes
    .filter(rt => rt.namedResources && rt.namedResources.length > 0 ? rtNamesWithHours.has(rt.name) : true)
    .flatMap(rt => {
      if (rt.namedResources && rt.namedResources.length > 0) {
        // Bug #7: only include if RT has demand
        if (!rtNamesWithHours.has(rt.name)) return []
        const derivedRt = rtDerivedWeeks.get(rt.name)
        return rt.namedResources.map(nr => {
          const isFullProject = nr.allocationMode === 'FULL_PROJECT'
          return {
            id: nr.id,
            resourceTypeId: rt.id,
            resourceTypeName: rt.name,
            name: nr.name,
            // Full Project: leave null so client falls back to projectEndWeek (full span incl. buffer)
            // Timeline: use manual override first, then demand-derived min/max
            // Effort (T&M): bar uses demand histogram, so start/end are ignored
            startWeek: isFullProject ? null : (nr.allocationStartWeek ?? (derivedRt?.start ?? null)),
            endWeek: isFullProject ? null : (nr.allocationEndWeek ?? (derivedRt?.end ?? null)),
            allocationPct: nr.allocationMode === 'EFFORT' ? 100 : Math.round(nr.allocationPercent),
            allocationMode: nr.allocationMode,
            allocationPercent: nr.allocationPercent ?? 100,
            allocationStartWeek: nr.allocationStartWeek ?? null,
            allocationEndWeek: nr.allocationEndWeek ?? null,
          }
        })
      }
      // Auto-generate synthetic named resources when RT has count > 0 and demand
      if (rt.count > 0 && rtNamesWithHours.has(rt.name)) {
        return Array.from({ length: rt.count }, (_, i) => ({
          resourceTypeName: rt.name,
          name: `${rt.name} ${i + 1}`,
          startWeek: null as number | null,
          endWeek: null as number | null,
          allocationPct: 100,
          allocationMode: 'EFFORT' as string,
        }))
      }
      return []
    })

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
  const project = await ownedProject(req.params.projectId as string, req.userId!)
  if (!project) { res.status(404).json({ error: 'Project not found' }); return }

  const entries = await prisma.timelineEntry.findMany({
    where: { projectId: project.id },
    include: {
      feature: {
        include: {
          epic: true,
          userStories: {
            include: {
              tasks: { include: { resourceType: true } }
            }
          }
        }
      }
    },
    orderBy: { startWeek: 'asc' },
  })

  // Filter out inactive epics/features
  const activeEntries = entries.filter(e => e.feature.isActive !== false && e.feature.epic.isActive !== false)

  // Load resource types before computing warnings (passed in to avoid redundant queries)
  const resourceTypes = await prisma.resourceType.findMany({ where: { projectId: project.id }, include: { namedResources: true } })

  // #178: pass pre-loaded features and resource types — no extra DB queries inside
  const activeFeatures = activeEntries.map(e => e.feature)
  const parallelWarnings = computeParallelWarnings(project.hoursPerDay, activeEntries, activeFeatures, resourceTypes)

  const storyTimelineEntries = await prisma.storyTimelineEntry.findMany({
    where: { projectId: project.id },
    include: { story: { select: { name: true, featureId: true } } },
  })
  const allFeatureIds = activeEntries.map(e => e.featureId)
  const featureDependencies = await prisma.featureDependency.findMany({
    where: { featureId: { in: allFeatureIds } },
    select: { featureId: true, dependsOnId: true },
  })
  const epicDependencies = await prisma.epicDependency.findMany({
    where: { epic: { projectId: project.id } },
    select: { epicId: true, dependsOnId: true },
  })
  const activeFeatureIdSet = new Set(allFeatureIds)
  const activeStoryTimelineEntries = storyTimelineEntries.filter(e => activeFeatureIdSet.has(e.story.featureId))
  const allStoryIds = activeStoryTimelineEntries.map(e => e.storyId)
  const storyDependencies = await prisma.storyDependency.findMany({
    where: { storyId: { in: allStoryIds } },
    select: { storyId: true, dependsOnId: true },
  })
  const mappedStoryEntries = activeStoryTimelineEntries.map(e => ({
    storyId: e.storyId,
    storyName: e.story.name,
    featureId: e.story.featureId,
    startWeek: e.startWeek,
    durationWeeks: e.durationWeeks,
    isManual: e.isManual,
  }))

  const simulatedDemand = project.weeklyDemandCache
    ? new Map<string, number>(Object.entries(project.weeklyDemandCache as Record<string, number>))
    : undefined
  res.json(buildResponse(project, activeEntries, parallelWarnings, mappedStoryEntries, featureDependencies, storyDependencies, epicDependencies, resourceTypes, simulatedDemand))
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

  const resourceTypes = await prisma.resourceType.findMany({ where: { projectId: project.id }, include: { namedResources: true } })

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

  const { featureSchedule, storySchedule, weeklyConsumptionMap, parallelWarnings } = runScheduler({
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
  const [featureDependencies, epicDependenciesForResponse, storyDependencies] = await Promise.all([
    prisma.featureDependency.findMany({ where: { featureId: { in: allFeatureIds } }, select: { featureId: true, dependsOnId: true } }),
    prisma.epicDependency.findMany({ where: { epic: { projectId: project.id } }, select: { epicId: true, dependsOnId: true } }),
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

  res.json(buildResponse(project, entries, parallelWarnings, mappedStoryEntries, featureDependencies, storyDependencies, epicDependenciesForResponse, resourceTypes, weeklyConsumptionMap))
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
  res.status(204).end()
}))

// DELETE /api/projects/:projectId/timeline/stories/:storyId — clear manual story override
router.delete('/stories/:storyId', asyncHandler(async (req: AuthRequest, res: Response) => {
  const project = await ownedProject(req.params.projectId as string, req.userId!)
  if (!project) { res.status(404).json({ error: 'Project not found' }); return }

  await prisma.storyTimelineEntry.deleteMany({
    where: { storyId: req.params.storyId as string, projectId: project.id },
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
    const cacheMap = project.weeklyDemandCache as Record<string, number>
    const rtByName = new Map(project.resourceTypes.map(rt => [rt.name, rt as ResourceTypeWithNamed]))
    // Sort entries by (week, rtName) for deterministic output
    const cacheEntries = Object.entries(cacheMap).map(([key, demandDays]) => {
      const pipeIdx = key.lastIndexOf('|')
      const rtName = key.slice(0, pipeIdx)
      const week = Number(key.slice(pipeIdx + 1))
      return { rtName, week, demandDays }
    }).sort((a, b) => a.week - b.week || a.rtName.localeCompare(b.rtName))

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

  // ── 2. Run the leveller ───────────────────────────────────────────────────
  const levellingResult = levelEpicStarts(schedulerInput)

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
