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
  feature: { name: string; epic: { id: string; name: string } }
  startWeek: number
  durationWeeks: number
  isManual: boolean
}>) {
  return {
    projectId: project.id,
    startDate: project.startDate?.toISOString() ?? null,
    hoursPerDay: project.hoursPerDay,
    entries: entries.map(e => ({
      featureId: e.featureId,
      featureName: e.feature.name,
      epicId: e.feature.epic.id,
      epicName: e.feature.epic.name,
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

  const hoursPerDay = project.hoursPerDay

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
              tasks: {
                include: { resourceType: true },
              },
            },
          },
        },
      },
    },
  })

  // Load resource types for this project (for count info)
  const resourceTypes = await prisma.resourceType.findMany({ where: { projectId: project.id } })
  const rtCountMap = new Map(resourceTypes.map(rt => [rt.id, rt.count]))

  let currentStartWeek = 0
  const upsertOps: Array<{ featureId: string; startWeek: number; durationWeeks: number }> = []

  for (const epic of epics) {
    for (const feature of epic.features) {
      const allTasks = feature.userStories.flatMap(s => s.tasks)

      if (allTasks.length === 0) {
        upsertOps.push({ featureId: feature.id, startWeek: currentStartWeek, durationWeeks: 1 })
        currentStartWeek += 1
        continue
      }

      // Group by resourceTypeId
      const byRt = new Map<string | null, typeof allTasks>()
      for (const task of allTasks) {
        const group = byRt.get(task.resourceTypeId) ?? []
        group.push(task)
        byRt.set(task.resourceTypeId, group)
      }

      let maxDays = 0
      for (const [rtId, tasks] of byRt) {
        const personDays = tasks.reduce((sum, t) => sum + (t.durationDays ?? t.hoursEffort / hoursPerDay), 0)
        const count = rtId ? (rtCountMap.get(rtId) ?? 1) : 1
        const parallelDays = personDays / count
        if (parallelDays > maxDays) maxDays = parallelDays
      }

      const roundedDays = Math.ceil(maxDays)
      const durationWeeks = Math.max(1, Math.ceil(roundedDays / 5))
      upsertOps.push({ featureId: feature.id, startWeek: currentStartWeek, durationWeeks })
      currentStartWeek += durationWeeks
    }
  }

  // Upsert all entries
  for (const op of upsertOps) {
    await prisma.timelineEntry.upsert({
      where: { featureId: op.featureId },
      create: { projectId: project.id, featureId: op.featureId, startWeek: op.startWeek, durationWeeks: op.durationWeeks, isManual: false },
      update: { startWeek: op.startWeek, durationWeeks: op.durationWeeks, isManual: false },
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
