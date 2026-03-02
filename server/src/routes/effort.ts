import { Router, Response } from 'express'
import { prisma } from '../lib/prisma.js'
import { authenticate, AuthRequest } from '../middleware/auth.js'

const router = Router({ mergeParams: true })
router.use(authenticate)

const CATEGORY_ORDER = ['ENGINEERING', 'GOVERNANCE', 'PROJECT_MANAGEMENT'] as const

// GET /api/projects/:projectId/effort
router.get('/', async (req: AuthRequest, res: Response) => {
  const projectId = req.params.projectId as string

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
      resourceTypes: true,
    },
  })

  if (!project) {
    res.status(404).json({ error: 'Project not found' })
    return
  }

  const hoursPerDay = project.hoursPerDay

  // Collect all tasks with context
  type TaskEntry = {
    taskId: string
    taskName: string
    storyName: string
    featureName: string
    epicName: string
    hoursEffort: number
    daysEffort: number
    resourceTypeId: string
  }

  const allTasks: TaskEntry[] = []
  for (const epic of project.epics) {
    for (const feature of epic.features) {
      for (const story of feature.userStories) {
        for (const task of story.tasks) {
          allTasks.push({
            taskId: task.id,
            taskName: task.name,
            storyName: story.name,
            featureName: feature.name,
            epicName: epic.name,
            hoursEffort: task.hoursEffort,
            daysEffort: Math.round((task.hoursEffort / hoursPerDay) * 100) / 100,
            resourceTypeId: task.resourceTypeId,
          })
        }
      }
    }
  }

  // Group tasks by resourceTypeId
  const tasksByRt = new Map<string, TaskEntry[]>()
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
        const totalDays = Math.round((totalHours / hoursPerDay) * 100) / 100
        return {
          resourceTypeId: rt.id,
          name: rt.name,
          category: rt.category,
          count: rt.count,
          proposedName: rt.proposedName ?? null,
          totalHours,
          totalDays,
          tasks: tasks.map(({ taskId, taskName, storyName, featureName, epicName, hoursEffort, daysEffort }) => ({
            taskId, taskName, storyName, featureName, epicName, hoursEffort, daysEffort,
          })),
        }
      })

      const totalHours = resourceTypes.reduce((s, rt) => s + rt.totalHours, 0)
      const totalDays = Math.round((totalHours / hoursPerDay) * 100) / 100

      return { category: cat, totalHours, totalDays, resourceTypes }
    })

  const totalHours = byCategory.reduce((s, c) => s + c.totalHours, 0)
  const totalDays = Math.round((totalHours / hoursPerDay) * 100) / 100

  res.json({ projectId, hoursPerDay, totalHours, totalDays, byCategory })
})

export default router
