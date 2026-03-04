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

function buildResponse(project: { id: string; startDate: Date | null; hoursPerDay: number }, entries: Array<{
  featureId: string
  feature: { name: string; epic: { id: string; name: string; featureMode: string; timelineStartWeek: number | null } }
  startWeek: number
  durationWeeks: number
  isManual: boolean
}>) {
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
    entries: entries.map(e => ({
      featureId: e.featureId,
      featureName: e.feature.name,
      epicId: e.feature.epic.id,
      epicName: e.feature.epic.name,
      epicFeatureMode: e.feature.epic.featureMode,
      epicTimelineStartWeek: e.feature.epic.timelineStartWeek,
      startWeek: e.startWeek,
      durationWeeks: e.durationWeeks,
      isManual: e.isManual,
      ...computeDates(project.startDate, e.startWeek, e.durationWeeks),
    })),
  }
}

// GET /api/projects/:projectId/timeline
router.get('/', async (req: AuthRequest, res: Response) => {
  const project = await ownedProject(req.params.projectId as string, req.userId!)
  if (!project) { res.status(404).json({ error: 'Project not found' }); return }

  const entries = await prisma.timelineEntry.findMany({
    where: { projectId: project.id },
    include: { feature: { include: { epic: true } } },
    orderBy: { startWeek: 'asc' },
  })

  res.json(buildResponse(project, entries))
})

// POST /api/projects/:projectId/timeline/schedule
router.post('/schedule', async (req: AuthRequest, res: Response) => {
  let project = await ownedProject(req.params.projectId as string, req.userId!)
  if (!project) { res.status(404).json({ error: 'Project not found' }); return }

  const { startDate } = req.body
  if (startDate) {
    project = await prisma.project.update({
      where: { id: project.id },
      data: { startDate: new Date(startDate) },
    })
  }

  const fallbackHoursPerDay = project.hoursPerDay

  // Load full hierarchy
  const epics = await prisma.epic.findMany({
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
    return Math.max(1, Math.ceil(Math.ceil(maxDays) / 5))
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
  const adjList = new Map<string, string[]>()

  for (const f of allFeatures) {
    if (!inDegree.has(f.id)) inDegree.set(f.id, 0)
    if (!adjList.has(f.id)) adjList.set(f.id, [])
  }

  function addEdge(fromId: string, toId: string) {
    adjList.get(fromId)!.push(toId)
    inDegree.set(toId, (inDegree.get(toId) ?? 0) + 1)
  }

  // Add intra-epic sequential edges
  for (const epic of epics) {
    if ((epic.featureMode ?? 'sequential') === 'sequential') {
      const sorted = [...epic.features].sort((a, b) => a.order - b.order)
      for (let i = 1; i < sorted.length; i++) {
        addEdge(sorted[i - 1].id, sorted[i].id)
      }
    }
  }

  // Add cross-epic explicit dependency edges
  for (const f of allFeatures) {
    for (const dep of (f.dependencies ?? [])) {
      addEdge(dep.dependsOnId, dep.featureId)
    }
  }

  // Kahn's algorithm
  const finishWeeks = new Map<string, number>()
  const startWeeks = new Map<string, number>()

  const queue: string[] = []
  for (const [fId, deg] of inDegree) {
    if (deg === 0) queue.push(fId)
  }

  const processed: string[] = []

  while (queue.length > 0) {
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
      let earliest = (epic.timelineStartWeek ?? null) ?? 0

      for (const [predId, successors] of adjList) {
        if (successors.includes(fId) && finishWeeks.has(predId)) {
          const predFinish = finishWeeks.get(predId)!
          if (predFinish > earliest) earliest = predFinish
        }
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
    include: { feature: { include: { epic: true } } },
    orderBy: { startWeek: 'asc' },
  })

  res.json(buildResponse(project, entries))
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
    epicTimelineStartWeek: entry.feature.epic.timelineStartWeek,
    startWeek: entry.startWeek,
    durationWeeks: entry.durationWeeks,
    isManual: entry.isManual,
    ...computeDates(project.startDate, entry.startWeek, entry.durationWeeks),
  })
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
