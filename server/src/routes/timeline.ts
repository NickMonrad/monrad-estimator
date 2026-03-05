import { Router, Response } from 'express'
import { prisma } from '../lib/prisma.js'
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

function computeResourceBreakdown(
  feature: { userStories: { tasks: { resourceTypeId: string | null, hoursEffort: number, durationDays: number | null, resourceType: { name: string, hoursPerDay: number | null } | null }[] }[] },
  fallbackHpd: number
): { name: string; days: number }[] {
  const byRt = new Map<string, { name: string; days: number }>()
  for (const story of feature.userStories) {
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
  project: { id: string; startDate: Date | null; hoursPerDay: number },
  entries: Array<{
    featureId: string
    feature: { name: string; order: number; epic: { id: string; name: string; order: number; featureMode: string; scheduleMode: string; timelineStartWeek: number | null }; userStories: { tasks: { resourceTypeId: string | null, hoursEffort: number, durationDays: number | null, resourceType: { name: string, hoursPerDay: number | null } | null }[] }[] }
    startWeek: number
    durationWeeks: number
    isManual: boolean
  }>,
  parallelWarnings: ParallelWarning[] = [],
) {
  const maxWeek = entries.length > 0
    ? Math.max(...entries.map(e => e.startWeek + e.durationWeeks))
    : null
  const projectedEndDate = (project.startDate && maxWeek != null)
    ? (() => { const d = new Date(project.startDate); d.setDate(d.getDate() + maxWeek * 7); return d.toISOString() })()
    : null

  return {
    projectId: project.id,
    startDate: project.startDate?.toISOString() ?? null,
    hoursPerDay: project.hoursPerDay,
    projectedEndDate,
    parallelWarnings,
    entries: entries.map(e => ({
      featureId: e.featureId,
      featureName: e.feature.name,
      epicId: e.feature.epic.id,
      epicName: e.feature.epic.name,
      epicOrder: e.feature.epic.order,
      epicFeatureMode: e.feature.epic.featureMode,
      epicScheduleMode: e.feature.epic.scheduleMode,
      epicTimelineStartWeek: e.feature.epic.timelineStartWeek,
      featureOrder: e.feature.order,
      startWeek: e.startWeek,
      durationWeeks: e.durationWeeks,
      isManual: e.isManual,
      resourceBreakdown: computeResourceBreakdown(e.feature, project.hoursPerDay),
      ...computeDates(project.startDate, e.startWeek, e.durationWeeks),
    })),
  }
}

// Compute over-allocation warnings for parallel-mode epics
async function computeParallelWarnings(
  projectId: string,
  fallbackHoursPerDay: number,
  entries: Array<{ featureId: string; startWeek: number; durationWeeks: number; feature: { epic: { id: string; name: string; featureMode: string } } }>,
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

  for (const [epicId, { epicName, featureIds, startWeek, endWeek }] of parallelEpics) {
    if (featureIds.length < 2) continue
    const epicSpanDays = (endWeek - startWeek) * 5

    // Load tasks for all features in this parallel epic
    const features = await prisma.feature.findMany({
      where: { id: { in: featureIds } },
      include: { userStories: { include: { tasks: { include: { resourceType: true } } } } },
    })
    const resourceTypes = await prisma.resourceType.findMany({ where: { projectId } })
    const rtCountMap = new Map(resourceTypes.map(rt => [rt.id, rt.count]))

    // Sum total person-days per resource type across ALL features (they run simultaneously)
    const demandMap = new Map<string, { name: string; days: number; count: number }>()
    for (const feature of features) {
      for (const story of feature.userStories) {
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

    for (const [, { name, days, count }] of demandMap) {
      const capacityDays = count * epicSpanDays
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
router.get('/', async (req: AuthRequest, res: Response) => {
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

  // Compute parallel over-allocation warnings
  const parallelWarnings = await computeParallelWarnings(project.id, project.hoursPerDay, activeEntries)

  res.json(buildResponse(project, activeEntries, parallelWarnings))
})

// POST /api/projects/:projectId/timeline/schedule
router.post('/schedule', async (req: AuthRequest, res: Response) => {
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
            include: {
              tasks: { include: { resourceType: true } },
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
  const resourceTypes = await prisma.resourceType.findMany({ where: { projectId: project.id } })
  const rtCountMap = new Map(resourceTypes.map(rt => [rt.id, rt.count]))

  // Helper: compute duration in weeks for a feature
  function featureDurationWeeks(feature: typeof epics[0]['features'][0]): number {
    const allTasks = feature.userStories.flatMap(s => s.tasks)
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

  // Kahn's algorithm — priority queue: always pick lowest (epicOrder, featureOrder)
  // This guarantees predecessors before successors AND respects user priority within independent features
  const finishWeeks = new Map<string, number>()
  const startWeeks = new Map<string, number>()

  function featurePriority(fId: string) {
    const f = featureMap.get(fId)!
    return f.epic.order * 100000 + f.order
  }

  const queue: string[] = []
  for (const [fId, deg] of inDegree) {
    if (deg === 0) queue.push(fId)
  }

  const processed: string[] = []

  while (queue.length > 0) {
    queue.sort((a, b) => featurePriority(a) - featurePriority(b))
    const fId = queue.shift()!
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
      if (newDeg === 0) queue.push(succId)
    }
  }

  if (resourceLevel) {
    // Helper: compute per-resource-type person-hours for a feature
    function featureResourceHours(feature: typeof allFeatures[0]): Map<string, number> {
      const result = new Map<string, number>()
      for (const story of feature.userStories) {
        for (const task of story.tasks) {
          const rtId = task.resourceTypeId ?? '_unassigned'
          const hpd = task.resourceType?.hoursPerDay ?? fallbackHoursPerDay
          const hours = (task.durationDays ?? (task.hoursEffort / hpd)) * hpd
          result.set(rtId, (result.get(rtId) ?? 0) + hours)
        }
      }
      return result
    }

    // Week capacity per resource type (hours per week)
    const weekCapacity = new Map<string, number>()
    for (const rt of resourceTypes) {
      weekCapacity.set(rt.id, rt.count * (rt.hoursPerDay ?? fallbackHoursPerDay) * 5)
    }
    weekCapacity.set('_unassigned', fallbackHoursPerDay * 5) // 1 person fallback

    // Track cumulative weekly usage: rtId → hours used per week
    const weeklyUsage = new Map<string, number[]>()
    const MAX_WEEKS = 200

    function getUsage(rtId: string): number[] {
      if (!weeklyUsage.has(rtId)) weeklyUsage.set(rtId, new Array(MAX_WEEKS).fill(0))
      return weeklyUsage.get(rtId)!
    }

    function canSchedule(fId: string, startW: number, durW: number, resourceHours: Map<string, number>): boolean {
      const weekStart = Math.floor(startW)
      const weekEnd = Math.ceil(startW + durW)
      for (const [rtId, totalHours] of resourceHours) {
        const cap = weekCapacity.get(rtId) ?? (fallbackHoursPerDay * 5)
        const usage = getUsage(rtId)
        for (let w = weekStart; w < weekEnd && w < MAX_WEEKS; w++) {
          const overlapStart = Math.max(w, startW)
          const overlapEnd = Math.min(w + 1, startW + durW)
          const overlapFraction = overlapEnd - overlapStart  // fraction of this week used (0–1)
          const hoursThisWeek = (totalHours / durW) * overlapFraction
          if ((usage[w] ?? 0) + hoursThisWeek > cap + 0.001) return false
        }
      }
      return true
    }

    function reserveWeeks(startW: number, durW: number, resourceHours: Map<string, number>) {
      const weekStart = Math.floor(startW)
      const weekEnd = Math.ceil(startW + durW)
      for (const [rtId, totalHours] of resourceHours) {
        const usage = getUsage(rtId)
        for (let w = weekStart; w < weekEnd && w < MAX_WEEKS; w++) {
          const overlapStart = Math.max(w, startW)
          const overlapEnd = Math.min(w + 1, startW + durW)
          const overlapFraction = overlapEnd - overlapStart
          const hoursThisWeek = (totalHours / durW) * overlapFraction
          usage[w] = (usage[w] ?? 0) + hoursThisWeek
        }
      }
    }

    // Process in topological priority order (already sorted by Kahn's priority queue above)
    // Re-compute earliest from live finishWeeks so pushed predecessors propagate to successors
    for (const fId of processed) {
      const f = featureMap.get(fId)!
      const dur = featureDurationWeeks(f)
      const resourceHours = featureResourceHours(f)

      if (manualStartWeeks.has(fId)) {
        // Manual: fixed — just reserve its weeks
        const sw = startWeeks.get(fId)!
        reserveWeeks(sw, dur, resourceHours)
        continue
      }

      // Re-compute earliest from live (post-levelling) predecessor finish weeks
      let earliest = f.epic.timelineStartWeek ?? 0
      for (const predId of predecessors.get(fId) ?? []) {
        const predFinish = finishWeeks.get(predId) ?? 0
        if (predFinish > earliest) earliest = predFinish
      }

      let candidateWeek = earliest
      while (candidateWeek < MAX_WEEKS) {
        if (canSchedule(fId, candidateWeek, dur, resourceHours)) break
        candidateWeek += 0.2  // try each day
      }
      startWeeks.set(fId, candidateWeek)
      finishWeeks.set(fId, candidateWeek + dur)
      reserveWeeks(candidateWeek, dur, resourceHours)
    }
  }

  for (const fId of processed) {
    const sw = startWeeks.get(fId)!
    const f = featureMap.get(fId)!
    const dur = featureDurationWeeks(f)
    const isManual = manualStartWeeks.has(fId)
    await prisma.timelineEntry.upsert({
      where: { featureId: fId },
      create: { projectId: project.id, featureId: fId, startWeek: sw, durationWeeks: dur, isManual },
      update: isManual ? {} : { startWeek: sw, durationWeeks: dur, isManual: false },
    })
  }

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

  const parallelWarnings = await computeParallelWarnings(project.id, project.hoursPerDay, entries)
  res.json(buildResponse(project, entries, parallelWarnings))
})

// PUT /api/projects/:projectId/timeline/:featureId
router.put('/:featureId', async (req: AuthRequest, res: Response) => {
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
})

// DELETE /api/projects/:projectId/timeline/:featureId — clear manual override
router.delete('/:featureId', async (req: AuthRequest, res: Response) => {
  const project = await ownedProject(req.params.projectId as string, req.userId!)
  if (!project) { res.status(404).json({ error: 'Project not found' }); return }

  await prisma.timelineEntry.deleteMany({
    where: { featureId: req.params.featureId as string, projectId: project.id },
  })
  res.status(204).end()
})

// PATCH /api/projects/:projectId/timeline/start-date
router.patch('/start-date', async (req: AuthRequest, res: Response) => {
  const project = await ownedProject(req.params.projectId as string, req.userId!)
  if (!project) { res.status(404).json({ error: 'Project not found' }); return }

  const { startDate } = req.body
  if (!startDate) { res.status(400).json({ error: 'startDate is required' }); return }

  const updated = await prisma.project.update({
    where: { id: project.id },
    data: { startDate: new Date(startDate) },
  })

  res.json({ startDate: updated.startDate?.toISOString() ?? null })
})

export default router
