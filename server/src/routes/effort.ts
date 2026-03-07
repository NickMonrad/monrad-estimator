import { Router, Response } from 'express'
import { prisma } from '../lib/prisma.js'
import { authenticate, AuthRequest } from '../middleware/auth.js'

const router = Router({ mergeParams: true })
router.use(authenticate)

const CATEGORY_ORDER = ['ENGINEERING', 'GOVERNANCE', 'PROJECT_MANAGEMENT'] as const

// GET /api/projects/:projectId/effort
router.get('/', async (req: AuthRequest, res: Response) => {
  const projectId = req.params.projectId as string
  const activeOnly = req.query.activeOnly === 'true'

  const project = await prisma.project.findFirst({
    where: { id: projectId, ownerId: req.userId },
    include: {
      epics: {
        include: {
          features: {
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
      },
      resourceTypes: { include: { globalType: true } },
    },
  })

  if (!project) {
    res.status(404).json({ error: 'Project not found' })
    return
  }

  const fallbackHoursPerDay = project.hoursPerDay

  // Build a dayRate lookup map keyed by resourceTypeId
  const dayRateByRtId = new Map<string, number | null>()
  for (const rt of project.resourceTypes) {
    const dayRate: number | null = rt.dayRate ?? rt.globalType?.defaultDayRate ?? null
    dayRateByRtId.set(rt.id, dayRate)
  }

  // Collect all tasks with context
  type TaskEntry = {
    taskId: string
    taskName: string
    storyName: string
    featureName: string
    epicName: string
    hoursEffort: number
    daysEffort: number
    resourceTypeId: string | null
    estimatedCost: number | null
  }

  const allTasks: TaskEntry[] = []
  for (const epic of project.epics) {
    for (const feature of epic.features) {
      for (const story of feature.userStories) {
        // Skip inactive entities when activeOnly is set
        if (activeOnly && (!epic.isActive || !feature.isActive || !story.isActive)) continue

        for (const task of story.tasks) {
          const taskHoursPerDay = task.resourceType?.hoursPerDay ?? fallbackHoursPerDay
          const daysEffort = Math.round((task.hoursEffort / taskHoursPerDay) * 100) / 100
          const dayRate = task.resourceTypeId != null ? (dayRateByRtId.get(task.resourceTypeId) ?? null) : null
          const estimatedCost = dayRate !== null ? Math.round(daysEffort * dayRate * 100) / 100 : null
          allTasks.push({
            taskId: task.id,
            taskName: task.name,
            storyName: story.name,
            featureName: feature.name,
            epicName: epic.name,
            hoursEffort: task.hoursEffort,
            daysEffort,
            resourceTypeId: task.resourceTypeId,
            estimatedCost,
          })
        }
      }
    }
  }

  // Group tasks by resourceTypeId
  const tasksByRt = new Map<string | null, TaskEntry[]>()
  for (const t of allTasks) {
    const arr = tasksByRt.get(t.resourceTypeId) ?? []
    arr.push(t)
    tasksByRt.set(t.resourceTypeId, arr)
  }

  // Group resourceTypes by category
  const rtsByCategory = new Map<string, typeof project.resourceTypes>()
  for (const rt of project.resourceTypes) {
    const arr = rtsByCategory.get(rt.category) ?? []
    arr.push(rt)
    rtsByCategory.set(rt.category, arr)
  }

  // Determine whether any resource type has a non-null dayRate
  let hasCost = false
  for (const [, rate] of dayRateByRtId) {
    if (rate !== null) { hasCost = true; break }
  }

  // Build byCategory
  const byCategory = CATEGORY_ORDER
    .filter(cat => rtsByCategory.has(cat))
    .map(cat => {
      const rts = (rtsByCategory.get(cat) ?? [])
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name))

      const resourceTypes = rts.map(rt => {
        const tasks = tasksByRt.get(rt.id) ?? []
        const totalHours = tasks.reduce((s, t) => s + t.hoursEffort, 0)
        const hoursPerDay = rt.hoursPerDay ?? fallbackHoursPerDay
        const totalDays = Math.round((totalHours / hoursPerDay) * 100) / 100
        const dayRate: number | null = rt.dayRate ?? rt.globalType?.defaultDayRate ?? null
        const estimatedCost: number | null = dayRate !== null
          ? Math.round(totalDays * dayRate * 100) / 100
          : null

        // byEpic breakdown
        const epicMap = new Map<string, { totalHours: number; totalDays: number }>()
        for (const t of tasks) {
          const existing = epicMap.get(t.epicName) ?? { totalHours: 0, totalDays: 0 }
          epicMap.set(t.epicName, {
            totalHours: existing.totalHours + t.hoursEffort,
            totalDays: Math.round((existing.totalDays + t.daysEffort) * 100) / 100,
          })
        }
        const byEpic = Array.from(epicMap.entries()).map(([epicName, vals]) => ({
          epicName,
          totalHours: vals.totalHours,
          totalDays: vals.totalDays,
          estimatedCost: dayRate !== null ? Math.round(vals.totalDays * dayRate * 100) / 100 : null,
        }))

        return {
          resourceTypeId: rt.id,
          name: rt.name,
          category: rt.category,
          count: rt.count,
          proposedName: rt.proposedName ?? null,
          dayRate,
          totalHours,
          totalDays,
          estimatedCost,
          byEpic,
          tasks: tasks.map(({ taskId, taskName, storyName, featureName, epicName, hoursEffort, daysEffort, estimatedCost: taskCost }) => ({
            taskId, taskName, storyName, featureName, epicName, hoursEffort, daysEffort, estimatedCost: taskCost,
          })),
        }
      })

      const totalHours = resourceTypes.reduce((s, rt) => s + rt.totalHours, 0)
      const totalDays = Math.round((resourceTypes.reduce((s, rt) => s + rt.totalDays, 0)) * 100) / 100
      const costsAll = resourceTypes.map(rt => rt.estimatedCost)
      const totalCost: number | null = costsAll.some(c => c !== null)
        ? Math.round(costsAll.reduce<number>((s, c) => s + (c ?? 0), 0) * 100) / 100
        : null

      return { category: cat, totalHours, totalDays, totalCost, resourceTypes }
    })

  const totalHours = byCategory.reduce((s, c) => s + c.totalHours, 0)
  const totalDays = Math.round((byCategory.reduce((s, c) => s + c.totalDays, 0)) * 100) / 100
  const categoryCosts = byCategory.map(c => c.totalCost)
  const totalCost: number | null = categoryCosts.some(c => c !== null)
    ? Math.round(categoryCosts.reduce<number>((s, c) => s + (c ?? 0), 0) * 100) / 100
    : null

  res.json({ projectId, hoursPerDay: fallbackHoursPerDay, totalHours, totalDays, totalCost, hasCost, byCategory })
})

export default router
