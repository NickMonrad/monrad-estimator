import { Router, Response } from 'express'
import { prisma } from '../lib/prisma.js'
import { asyncHandler } from '../lib/asyncHandler.js'
import { authenticate, AuthRequest } from '../middleware/auth.js'

const router = Router({ mergeParams: true })
router.use(authenticate)

async function ownedProject(projectId: string, userId: string) {
  return prisma.project.findFirst({ where: { id: projectId, ownerId: userId } })
}

function computeDates(projectStartDate: Date | null, startWeek: number, durationWeeks: number) {
  if (!projectStartDate) return { startDate: null, endDate: null }
  const start = new Date(projectStartDate)
  start.setDate(start.getDate() + startWeek * 7)
  const end = new Date(projectStartDate)
  end.setDate(end.getDate() + (startWeek + durationWeeks) * 7)
  return { startDate: start.toISOString(), endDate: end.toISOString() }
}

type ParallelWarning = { epicId: string; epicName: string; resourceTypeName: string; demandDays: number; capacityDays: number }

type ResourceTypeWithNamed = {
  id: string
  name: string
  count: number
  hoursPerDay: number | null
  namedResources: Array<{
    id: string
    name: string
    startWeek: number | null
    endWeek: number | null
    allocationPct: number
    allocationMode: string
    allocationPercent: number
    allocationStartWeek: number | null
    allocationEndWeek: number | null
  }>
}

/** Compute the effective allocation percentage for a named resource in a given week. */
function effectiveAllocationPct(
  nr: ResourceTypeWithNamed['namedResources'][number],
  week: number,
): number {
  if (nr.allocationMode === 'FULL_PROJECT') return nr.allocationPercent
  if (nr.allocationMode === 'TIMELINE') {
    const wStart = nr.allocationStartWeek ?? nr.startWeek ?? 0
    const wEnd = nr.allocationEndWeek ?? nr.endWeek ?? Infinity
    return week >= wStart && week <= wEnd ? nr.allocationPercent : 0
  }
  // EFFORT (T&M) — no fixed allocation; full capacity available
  return 100
}

/** Compute weekly capacity (hours) for a resource type, accounting for named resource availability. */
export function getWeeklyCapacity(
  rt: ResourceTypeWithNamed,
  week: number,
  defaultHoursPerDay: number,
): number {
  const hoursPerDay = rt.hoursPerDay ?? defaultHoursPerDay
  if (rt.namedResources.length === 0) {
    // No named resources — use aggregate count (existing behaviour)
    return rt.count * hoursPerDay * 5
  }
  // Sum capacity from named resources active this week
  let totalHours = 0
  for (const nr of rt.namedResources) {
    const start = nr.startWeek ?? 0       // null = project start (week 0)
    const end = nr.endWeek ?? Infinity     // null = project end
    if (week >= start && week <= end) {
      const pct = effectiveAllocationPct(nr, week)
      totalHours += (pct / 100) * hoursPerDay * 5
    }
  }
  return totalHours
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
        ...computeDates(project.startDate, e.startWeek, e.durationWeeks),
      }
    }),
  }
}

// Compute over-allocation warnings for parallel-mode epics
// #178: accept pre-loaded features and resourceTypes to avoid redundant DB queries
async function computeParallelWarnings(
  fallbackHoursPerDay: number,
  entries: Array<{ featureId: string; startWeek: number; durationWeeks: number; feature: { epic: { id: string; name: string; featureMode: string } } }>,
  allFeatures: Array<{ id: string; userStories: Array<{ isActive: boolean | null; tasks: Array<{ resourceTypeId: string | null; resourceType: { id: string; name: string; hoursPerDay: number | null } | null; hoursEffort: number; durationDays: number | null }> }> }>,
  allResourceTypes: ResourceTypeWithNamed[],
): Promise<ParallelWarning[]> {
  const warnings: ParallelWarning[] = []

  // Only check parallel epics with 2+ features
  const parallelEpics = new Map<string, { epicName: string; featureIds: string[]; startWeek: number; endWeek: number }>()
  for (const e of entries) {
    if ((e.feature.epic.featureMode ?? 'sequential') !== 'parallel') continue
    const epicId = e.feature.epic.id
    if (!parallelEpics.has(epicId)) {
      parallelEpics.set(epicId, { epicName: e.feature.epic.name, featureIds: [], startWeek: e.startWeek, endWeek: e.startWeek + e.durationWeeks })
    }
    const ep = parallelEpics.get(epicId)!
    ep.featureIds.push(e.featureId)
    ep.startWeek = Math.min(ep.startWeek, e.startWeek)
    ep.endWeek = Math.max(ep.endWeek, e.startWeek + e.durationWeeks)
  }

  // Build lookup maps from pre-loaded data — no additional DB queries needed
  const featureById = new Map(allFeatures.map(f => [f.id, f]))
  const rtCountMap = new Map(allResourceTypes.map(rt => [rt.id, rt.count]))
  const rtMap = new Map(allResourceTypes.map(rt => [rt.id, rt as ResourceTypeWithNamed]))

  for (const [epicId, { epicName, featureIds, startWeek, endWeek }] of parallelEpics) {
    if (featureIds.length < 2) continue
    const epicSpanDays = (endWeek - startWeek) * 5

    // Use pre-loaded features filtered to this parallel epic
    const features = featureIds.map(id => featureById.get(id)).filter((f): f is NonNullable<typeof f> => f !== undefined)

    // Sum total person-days per resource type across ALL features (they run simultaneously)
    const demandMap = new Map<string, { name: string; days: number; count: number }>()
    for (const feature of features) {
      for (const story of feature.userStories) {
        if (story.isActive === false) continue
        for (const task of story.tasks) {
          const rtId = task.resourceTypeId ?? '_unassigned'
          const hpd = task.resourceType?.hoursPerDay ?? fallbackHoursPerDay
          const days = task.durationDays ?? (task.hoursEffort / hpd)
          if (!demandMap.has(rtId)) {
            demandMap.set(rtId, {
              name: task.resourceType?.name ?? 'Unassigned',
              days: 0,
              count: task.resourceTypeId ? (rtCountMap.get(task.resourceTypeId) ?? 1) : 1,
            })
          }
          demandMap.get(rtId)!.days += days
        }
      }
    }

    for (const [rtId, { name, days, count }] of demandMap) {
      // Variable capacity: sum capacity across the epic's span, accounting for named resource availability
      const rt = rtMap.get(rtId)
      let capacityDays: number
      if (rt && rt.namedResources && rt.namedResources.length > 0) {
        capacityDays = 0
        const hpd = rt.hoursPerDay ?? fallbackHoursPerDay
        for (let w = Math.floor(startWeek); w < Math.ceil(endWeek); w++) {
          const overlap = Math.min(w + 1, endWeek) - Math.max(w, startWeek)
          if (overlap <= 0) continue
          capacityDays += (getWeeklyCapacity(rt, w, fallbackHoursPerDay) / hpd) * overlap
        }
      } else {
        capacityDays = count * epicSpanDays
      }
      if (days > capacityDays) {
        warnings.push({
          epicId,
          epicName,
          resourceTypeName: name,
          demandDays: Math.round(days * 10) / 10,
          capacityDays: Math.round(capacityDays * 10) / 10,
        })
      }
    }
  }

  return warnings
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
  const parallelWarnings = await computeParallelWarnings(project.hoursPerDay, activeEntries, activeFeatures, resourceTypes)

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

  const fallbackHoursPerDay = project.hoursPerDay

  // Load full hierarchy — filter inactive epics/features
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
              dependencies: true,   // StoryDependency rows where this story depends on others
            },
          },
          dependencies: true,   // FeatureDependency rows where this feature depends on others
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

  // Load resource types
  const resourceTypes = await prisma.resourceType.findMany({ where: { projectId: project.id }, include: { namedResources: true } })
  const rtCountMap = new Map(resourceTypes.map(rt => [rt.id, rt.count]))

  // Helper: compute duration in weeks for a feature
  function featureDurationWeeks(feature: typeof epics[0]['features'][0]): number {
    const allTasks = feature.userStories.filter(s => s.isActive !== false).flatMap(s => s.tasks)
    if (allTasks.length === 0) return 1

    const byRt = new Map<string | null, typeof allTasks>()
    for (const task of allTasks) {
      const group = byRt.get(task.resourceTypeId) ?? []
      group.push(task)
      byRt.set(task.resourceTypeId, group)
    }

    let maxDays = 0
    for (const [rtId, tasks] of byRt) {
      const personDays = tasks.reduce((sum, t) => {
        const hpd = t.resourceType?.hoursPerDay ?? fallbackHoursPerDay
        return sum + (t.durationDays ?? (t.hoursEffort / hpd))
      }, 0)
      const count = rtId ? (rtCountMap.get(rtId) ?? 1) : 1
      const days = personDays / count
      if (days > maxDays) maxDays = days
    }
    return Math.max(0.2, maxDays / 5)
  }

  // Build flat list of all features across all epics
  const allFeatures = epics.flatMap(epic =>
    epic.features.map(f => ({ ...f, epic }))
  )

  // Build feature map for quick lookup
  const featureMap = new Map(allFeatures.map(f => [f.id, f]))

  // Load existing manual timeline entries — their startWeek is fixed
  const existingEntries = await prisma.timelineEntry.findMany({
    where: { projectId: project.id, isManual: true },
  })
  const manualStartWeeks = new Map(existingEntries.map(e => [e.featureId, e.startWeek]))
  const manualDurationWeeks = new Map(existingEntries.map(e => [e.featureId, e.durationWeeks]))

  const existingStoryEntries = await prisma.storyTimelineEntry.findMany({
    where: { projectId: project.id, isManual: true },
  })
  const manualStoryWeeks = new Map(existingStoryEntries.map(e => [e.storyId, e.startWeek]))

  // Load epic dependencies for hard constraint edges in the topological sort
  const epicDeps = await prisma.epicDependency.findMany({
    where: { epic: { projectId: project.id } },
    select: { epicId: true, dependsOnId: true },
  })

  // Kahn's topological sort over features
  const inDegree = new Map<string, number>()
  const adjList = new Map<string, string[]>()   // from → [to, ...]
  const predecessors = new Map<string, string[]>() // to → [from, ...]

  for (const f of allFeatures) {
    inDegree.set(f.id, 0)
    adjList.set(f.id, [])
    predecessors.set(f.id, [])
  }

  function addEdge(fromId: string, toId: string) {
    const succs = adjList.get(fromId)
    const preds = predecessors.get(toId)
    if (!succs || !preds) return // one of the features not in this project
    if (succs.includes(toId)) return // deduplicate
    succs.push(toId)
    preds.push(fromId)
    inDegree.set(toId, (inDegree.get(toId) ?? 0) + 1)
  }

  // 1. Intra-epic sequential edges: each feature depends on the previous in its epic
  for (const epic of epics) {
    if ((epic.featureMode ?? 'sequential') === 'sequential') {
      const sorted = [...epic.features].sort((a, b) => a.order - b.order)
      for (let i = 1; i < sorted.length; i++) {
        // Don't chain successor onto a manually-pinned feature — let it float freely
        // based only on explicit FeatureDependency rows
        if (manualStartWeeks.has(sorted[i - 1].id)) continue
        addEdge(sorted[i - 1].id, sorted[i].id)
      }
    }
  }

  // 2. Inter-epic sequential chaining: Epic N completes before Epic N+1 starts
  //    All features of Epic[i] → first feature of Epic[i+1] (sequential) or all features (parallel)
  const sortedEpics = [...epics].sort((a, b) => a.order - b.order)
  for (let i = 1; i < sortedEpics.length; i++) {
    const prevEpic = sortedEpics[i - 1]
    const currEpic = sortedEpics[i]
    if (prevEpic.features.length === 0 || currEpic.features.length === 0) continue

    // Skip if currEpic has a manual anchor — it will start at its fixed week regardless
    if (currEpic.timelineStartWeek != null) continue

    // Skip if currEpic is parallel — it floats free, not chained after prevEpic
    if ((currEpic.scheduleMode ?? 'sequential') === 'parallel') continue

    const currTargets = (currEpic.featureMode ?? 'sequential') === 'sequential'
      ? [currEpic.features[0]] // first feature chains to the rest via sequential edges
      : currEpic.features       // parallel: all features need explicit constraint

    for (const prevFeature of prevEpic.features) {
      // Bug fix: if this prevFeature has an explicit FeatureDependency on a feature in
      // currEpic, adding the inter-epic chain edge would create a cycle
      // (prevFeature → currEpic.first → ... → depTarget → prevFeature).
      // Skip the chain edge for prevFeature in that case so it can float freely
      // based only on its explicit deps.
      const hasCrossEpicDep = (prevFeature.dependencies ?? []).some(dep => {
        const target = featureMap.get(dep.dependsOnId)
        return target !== undefined && target.epic.id === currEpic.id
      })
      if (hasCrossEpicDep) continue

      for (const currFeature of currTargets) {
        addEdge(prevFeature.id, currFeature.id)
      }
    }
  }

  // 3. Explicit cross-epic feature dependency edges
  for (const f of allFeatures) {
    for (const dep of (f.dependencies ?? [])) {
      addEdge(dep.dependsOnId, dep.featureId)
    }
  }

  // 4. Epic dependency hard constraints
  //    All features of dependsOn epic → all features of dependent epic
  for (const epicDep of epicDeps) {
    const fromEpic = epics.find(e => e.id === epicDep.dependsOnId)
    const toEpic = epics.find(e => e.id === epicDep.epicId)
    if (!fromEpic || !toEpic) continue
    for (const fromFeature of fromEpic.features) {
      for (const toFeature of toEpic.features) {
        addEdge(fromFeature.id, toFeature.id)
      }
    }
  }

  // Kahn's algorithm — priority queue: always pick lowest (epicOrder, featureOrder)
  // This guarantees predecessors before successors AND respects user priority within independent features
  const finishWeeks = new Map<string, number>()
  const startWeeks = new Map<string, number>()

  function featurePriority(fId: string) {
    const f = featureMap.get(fId)!
    return f.epic.order * 100000 + f.order
  }

  // #178: min-heap replacing array + sort — O(n log n) overall vs O(n² log n)
  class MinHeap {
    private data: Array<{ priority: number; id: string }> = []

    push(item: { priority: number; id: string }) {
      this.data.push(item)
      this._bubbleUp(this.data.length - 1)
    }

    pop(): { priority: number; id: string } | undefined {
      if (this.data.length === 0) return undefined
      const top = this.data[0]
      const last = this.data.pop()!
      if (this.data.length > 0) {
        this.data[0] = last
        this._sinkDown(0)
      }
      return top
    }

    get length() { return this.data.length }

    private _bubbleUp(i: number) {
      while (i > 0) {
        const parent = Math.floor((i - 1) / 2)
        if (this.data[parent].priority <= this.data[i].priority) break
        ;[this.data[parent], this.data[i]] = [this.data[i], this.data[parent]]
        i = parent
      }
    }

    private _sinkDown(i: number) {
      const n = this.data.length
      while (true) {
        let smallest = i
        const l = 2 * i + 1, r = 2 * i + 2
        if (l < n && this.data[l].priority < this.data[smallest].priority) smallest = l
        if (r < n && this.data[r].priority < this.data[smallest].priority) smallest = r
        if (smallest === i) break
        ;[this.data[smallest], this.data[i]] = [this.data[i], this.data[smallest]]
        i = smallest
      }
    }
  }

  const queue = new MinHeap()
  for (const [fId, deg] of inDegree) {
    if (deg === 0) queue.push({ priority: featurePriority(fId), id: fId })
  }

  const processed: string[] = []

  while (queue.length > 0) {
    const { id: fId } = queue.pop()!
    processed.push(fId)

    const f = featureMap.get(fId)!
    const epic = f.epic
    const dur = featureDurationWeeks(f)

    if (manualStartWeeks.has(fId)) {
      const sw = manualStartWeeks.get(fId)!
      startWeeks.set(fId, sw)
      finishWeeks.set(fId, sw + dur)
    } else {
      // earliest = max(epic anchor, all predecessor finish weeks)
      let earliest = epic.timelineStartWeek ?? 0
      for (const predId of predecessors.get(fId) ?? []) {
        const predFinish = finishWeeks.get(predId) ?? 0
        if (predFinish > earliest) earliest = predFinish
      }
      startWeeks.set(fId, earliest)
      finishWeeks.set(fId, earliest + dur)
    }

    for (const succId of adjList.get(fId) ?? []) {
      const newDeg = (inDegree.get(succId) ?? 1) - 1
      inDegree.set(succId, newDeg)
      if (newDeg === 0) queue.push({ priority: featurePriority(succId), id: succId })
    }
  }

  // Tracks actual per-week resource consumption from the levelling simulation
  // key: `${rtName}|${week}` → days consumed; populated only when resourceLevel=true
  const weeklyConsumptionMap = new Map<string, number>()

  if (resourceLevel) {
    // featureResourceHours: total resource-hours needed per feature (unchanged helper)
    function featureResourceHours(feature: typeof allFeatures[0]): Map<string, number> {
      const result = new Map<string, number>()
      for (const story of feature.userStories) {
        if (story.isActive === false) continue
        for (const task of story.tasks) {
          const rtId = task.resourceTypeId ?? '_unassigned'
          const hpd = task.resourceType?.hoursPerDay ?? fallbackHoursPerDay
          const hours = (task.durationDays ?? (task.hoursEffort / hpd)) * hpd
          result.set(rtId, (result.get(rtId) ?? 0) + hours)
        }
      }
      return result
    }

    // #178: pre-compute featureResourceHours for all features to avoid re-computing in the simulation loop
    const featureResourceHoursCache = new Map<string, Map<string, number>>()
    for (const fId of processed) {
      featureResourceHoursCache.set(fId, featureResourceHours(featureMap.get(fId)!))
    }

    // Variable weekly capacity: build lookup by resource type ID
    const rtById = new Map(resourceTypes.map(rt => [rt.id, rt as ResourceTypeWithNamed]))
    const allRtIds = [...resourceTypes.map(rt => rt.id), '_unassigned']

    // Build remaining hours per feature (Map<fId, Map<rtId, hoursRemaining>>)
    const remainingHours = new Map<string, Map<string, number>>()
    for (const fId of processed) {
      if (manualStartWeeks.has(fId)) continue
      remainingHours.set(fId, featureResourceHoursCache.get(fId)!)
    }

    // Simulation state
    const simStart = new Map<string, number>()  // fId -> week started
    const simDone = new Map<string, number>()   // fId -> week completed

    // Manual features: fix their start/done from pre-computed values
    for (const [fId, sw] of manualStartWeeks) {
      simStart.set(fId, sw)
      const storedDur = manualDurationWeeks.get(fId)
      simDone.set(fId, sw + (storedDur !== undefined ? storedDur : featureDurationWeeks(featureMap.get(fId)!)))
    }

    const STEP = 0.2  // 1 day per step
    const MAX_WEEKS = 200
    const autoFeatures = processed.filter(fId => !manualStartWeeks.has(fId))
    const unfinished = new Set(autoFeatures)

    let t = 0
    while (unfinished.size > 0 && t < MAX_WEEKS) {
      // Mark newly eligible features as started
      for (const fId of unfinished) {
        if (simStart.has(fId)) continue
        const f = featureMap.get(fId)!
        const epicStart = f.epic.timelineStartWeek ?? 0
        if (t < epicStart) continue
        const predsAllDone = (predecessors.get(fId) ?? []).every(predId => {
          const done = simDone.get(predId)
          return done !== undefined && done <= t
        })
        if (predsAllDone) {
          const currentWeekForStart = Math.floor(t)
          const fHours = remainingHours.get(fId)
          // Only start the feature when at least one of its resource types has capacity > 0.
          // This prevents features from sitting idle during week 0 when named resources
          // don't start until week 1.
          if (fHours && fHours.size > 0) {
            const hasCapacity = [...fHours.keys()].some(rtId => {
              if (rtId === '_unassigned') return true  // unassigned fallback always works
              const rt = rtById.get(rtId)
              return !rt || getWeeklyCapacity(rt, currentWeekForStart, fallbackHoursPerDay) > 0
            })
            if (!hasCapacity) continue  // wait until capacity is available
          }
          simStart.set(fId, t)
        }
      }

      // Active = started but not done
      const active = [...unfinished].filter(fId => simStart.has(fId))

      // Always track manual feature consumption, even when no auto features are active.
      // This ensures manually-pinned features contribute to the histogram regardless of
      // whether any auto-scheduled features are running in the same window.
      const currentWeek = Math.floor(t)
      for (const rtId of allRtIds) {
        const rt = rtById.get(rtId)
        const rtName = rt?.name ?? 'Unassigned'
        const hpd = rt?.hoursPerDay ?? fallbackHoursPerDay
        for (const [fId] of manualStartWeeks) {
          const fStart = simStart.get(fId)
          const fDone = simDone.get(fId)
          if (fStart === undefined || fDone === undefined || fDone <= fStart) continue
          if (t >= fStart && t < fDone) {
            const rtHours = featureResourceHoursCache.get(fId)!.get(rtId) ?? 0
            if (rtHours > 0) {
              const perStep = (rtHours / (fDone - fStart)) * STEP
              const consumptionKey = `${rtName}|${currentWeek}`
              weeklyConsumptionMap.set(consumptionKey, (weeklyConsumptionMap.get(consumptionKey) ?? 0) + perStep / hpd)
            }
          }
        }
      }

      if (active.length === 0) { t += STEP; continue }

      // Features with no resource hours start and immediately complete
      for (const fId of active) {
        if (remainingHours.get(fId)?.size === 0) {
          if (!simDone.has(fId)) {
            simDone.set(fId, t + STEP)
            unfinished.delete(fId)
          }
        }
      }

      // Proportional allocation: for each resource type, divide capacity across active features needing it
      for (const rtId of allRtIds) {
        const rt = rtById.get(rtId)
        const capPerWeek = rt
          ? getWeeklyCapacity(rt, currentWeek, fallbackHoursPerDay)
          : fallbackHoursPerDay * 5  // _unassigned fallback
        let capPerStep = capPerWeek * STEP  // hours available this step (STEP fraction of a week)
        const rtName = rt?.name ?? 'Unassigned'
        const hpd = rt?.hoursPerDay ?? fallbackHoursPerDay

        // Subtract capacity consumed by active manual features this step so that
        // auto-scheduled features don't over-allocate during manual windows.
        // NOTE: weeklyConsumptionMap is already updated in the block above — do not write it again here.
        for (const [fId] of manualStartWeeks) {
          const fStart = simStart.get(fId)
          const fDone = simDone.get(fId)
          if (fStart === undefined || fDone === undefined || fDone <= fStart) continue
          if (t >= fStart && t < fDone) {
            const rtHours = featureResourceHoursCache.get(fId)!.get(rtId) ?? 0
            if (rtHours > 0) {
              const perStep = (rtHours / (fDone - fStart)) * STEP
              capPerStep = Math.max(0, capPerStep - perStep)
            }
          }
        }

        const competing = active.filter(fId => (remainingHours.get(fId)?.get(rtId) ?? 0) > 0.001)
        if (competing.length === 0) continue

        const totalRemaining = competing.reduce((s, fId) => s + (remainingHours.get(fId)!.get(rtId) ?? 0), 0)

        for (const fId of competing) {
          const rem = remainingHours.get(fId)!.get(rtId)!
          const actualAllocated = Math.min((rem / totalRemaining) * capPerStep, rem)
          // Track actual consumption per RT name per week
          const consumptionKey = `${rtName}|${currentWeek}`
          weeklyConsumptionMap.set(consumptionKey, (weeklyConsumptionMap.get(consumptionKey) ?? 0) + actualAllocated / hpd)
          remainingHours.get(fId)!.set(rtId, Math.max(0, rem - actualAllocated))
        }
      }

      // Mark done: all resource types exhausted
      for (const fId of active) {
        const allDone = [...(remainingHours.get(fId)?.values() ?? [])].every(h => h <= 0.001)
        if (allDone) {
          simDone.set(fId, t + STEP)
          unfinished.delete(fId)
        }
      }

      t += STEP
      t = Math.round(t * 5) / 5  // snap to nearest 0.2 to eliminate float drift
    }

    // Apply simulation results back to startWeeks/finishWeeks
    for (const fId of processed) {
      const sw = simStart.get(fId) ?? startWeeks.get(fId) ?? 0
      const doneW = simDone.get(fId)
      const dur = doneW !== undefined ? doneW - sw : featureDurationWeeks(featureMap.get(fId)!)
      startWeeks.set(fId, sw)
      finishWeeks.set(fId, sw + dur)
    }
  }

  // ── Story-level scheduling ─────────────────────────────────────────────────
  // Build flat list of all stories with their feature context
  const allStories = epics.flatMap(epic =>
    epic.features.flatMap(feature =>
      feature.userStories
        .filter(s => s.isActive !== false)
        .map(s => ({ ...s, feature: { ...feature, epic } }))
    )
  )

  // Story resource hours
  function storyResourceHours(story: typeof allStories[0]): Map<string, number> {
    const result = new Map<string, number>()
    for (const task of story.tasks) {
      const rtId = task.resourceTypeId ?? '_unassigned'
      const hpd = task.resourceType?.hoursPerDay ?? fallbackHoursPerDay
      const hours = (task.durationDays ?? (task.hoursEffort / hpd)) * hpd
      result.set(rtId, (result.get(rtId) ?? 0) + hours)
    }
    return result
  }

  // ── Per-feature proportional story scheduling ──────────────────────────────
  // Stories are distributed sequentially and proportionally within their parent
  // feature's scheduled window [featureStart, featureDone], based on total hours.
  // This keeps all story bars visually within their feature bar.
  //
  // Manual story overrides retain their stored startWeek; their duration is
  // re-computed from their own hours.

  // Group non-manual stories by feature, sorted by story order
  const storiesByFeature = new Map<string, typeof allStories>()
  for (const story of allStories) {
    const fId = story.feature.id
    if (!storiesByFeature.has(fId)) storiesByFeature.set(fId, [])
    storiesByFeature.get(fId)!.push(story)
  }
  for (const stories of storiesByFeature.values()) {
    stories.sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
  }

  // Helper: total hours for a story
  function storyTotalHours(story: typeof allStories[0]): number {
    return [...storyResourceHours(story).values()].reduce((a, b) => a + b, 0)
  }

  // #178: Compute scheduled position for every story in O(S) total — one pass per feature
  // Previously O(S²): for each story we'd scan siblings from the start to accumulate the cursor.
  // Now we build the storyPositionMap (featureId → pre-computed schedules) in a single pass
  // per feature, then stamp each story's result without any repeated scanning.
  const storyScheduled = new Map<string, { startWeek: number; durationWeeks: number; isManual: boolean }>()

  // Pass 1: manual-pinned stories (O(S) total, independent of siblings)
  for (const story of allStories) {
    if (manualStoryWeeks.has(story.id)) {
      const sw = manualStoryWeeks.get(story.id)!
      const totalHours = storyTotalHours(story)
      const dur = Math.max(0.2, totalHours / fallbackHoursPerDay / 5)
      storyScheduled.set(story.id, { startWeek: sw, durationWeeks: dur, isManual: true })
    }
  }

  // Pass 2: proportional sequential scheduling — one pass per feature, O(S) total
  for (const [fId, stories] of storiesByFeature) {
    const featureStart = startWeeks.get(fId) ?? 0
    const featureDone = finishWeeks.get(fId) ?? (featureStart + 1)
    const featureDuration = Math.max(0.2, featureDone - featureStart)

    // Exclude manually-pinned stories from proportional scheduling
    const siblings = stories.filter(s => !manualStoryWeeks.has(s.id))
    if (siblings.length === 0) continue

    const totalFeatureHours = siblings.reduce((sum, s) => sum + storyTotalHours(s), 0)

    // Build position map in a single forward scan — no repeated iteration
    let cursor = featureStart
    for (const sibling of siblings) {
      const hrs = storyTotalHours(sibling)
      const dur = totalFeatureHours > 0
        ? (hrs / totalFeatureHours) * featureDuration
        : featureDuration / Math.max(1, siblings.length)
      const safeDur = Math.max(0.2, dur)
      storyScheduled.set(sibling.id, { startWeek: cursor, durationWeeks: safeDur, isManual: false })
      cursor += safeDur
    }
  }

  // Write StoryTimelineEntry records
  const storyUpserts = allStories.map(async story => {
    const scheduled = storyScheduled.get(story.id)
    if (!scheduled) return null
    const { startWeek: sw, durationWeeks: dur, isManual } = scheduled
    return prisma.storyTimelineEntry.upsert({
      where: { storyId: story.id },
      create: { storyId: story.id, projectId: project.id, startWeek: sw, durationWeeks: dur, isManual },
      update: isManual ? {} : { startWeek: sw, durationWeeks: dur, isManual: false },
    })
  })
  await Promise.all(storyUpserts)
  // ── End story-level scheduling ─────────────────────────────────────────────

  // #178: run feature timeline upserts in parallel instead of sequentially
  await Promise.all([...processed].map(fId => {
    const sw = startWeeks.get(fId)!
    const f = featureMap.get(fId)!
    const dur = (finishWeeks.get(fId) ?? (sw + featureDurationWeeks(f))) - sw
    const isManual = manualStartWeeks.has(fId)
    return prisma.timelineEntry.upsert({
      where: { featureId: fId },
      create: { projectId: project.id, featureId: fId, startWeek: sw, durationWeeks: dur, isManual },
      update: isManual ? {} : { startWeek: sw, durationWeeks: dur, isManual: false },
    })
  }))

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

  // #178: pass pre-loaded allFeatures and resourceTypes to avoid redundant DB queries
  const parallelWarnings = await computeParallelWarnings(project.hoursPerDay, entries, allFeatures, resourceTypes)

  const storyTimelineEntries = await prisma.storyTimelineEntry.findMany({
    where: { projectId: project.id },
    include: { story: { select: { name: true, featureId: true } } },
  })
  const allFeatureIds = entries.map(e => e.featureId)
  const featureDependencies = await prisma.featureDependency.findMany({
    where: { featureId: { in: allFeatureIds } },
    select: { featureId: true, dependsOnId: true },
  })
  const epicDependenciesForResponse = await prisma.epicDependency.findMany({
    where: { epic: { projectId: project.id } },
    select: { epicId: true, dependsOnId: true },
  })
  const allStoryIds = storyTimelineEntries.map(e => e.storyId)
  const storyDependencies = await prisma.storyDependency.findMany({
    where: { storyId: { in: allStoryIds } },
    select: { storyId: true, dependsOnId: true },
  })
  const mappedStoryEntries = storyTimelineEntries.map(e => ({
    storyId: e.storyId,
    storyName: e.story.name,
    featureId: e.story.featureId,
    startWeek: e.startWeek,
    durationWeeks: e.durationWeeks,
    isManual: e.isManual,
  }))

  // Persist the weekly demand cache so GET /timeline can reuse actual consumption
  // data rather than falling back to uniform spread.
  await prisma.project.update({
    where: { id: project.id },
    data: { weeklyDemandCache: Object.fromEntries(weeklyConsumptionMap) },
  })

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
    const startDate = toDateStr(project.startDate, e.startWeek)
    const endDate = toDateStr(project.startDate, e.startWeek + e.durationWeeks)
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
    ...computeDates(project.startDate, entry.startWeek, entry.durationWeeks),
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
