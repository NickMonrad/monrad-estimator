import { Router, Response } from 'express'
import { prisma } from '../lib/prisma.js'
import { asyncHandler } from '../lib/asyncHandler.js'
import { authenticate, AuthRequest } from '../middleware/auth.js'

const router = Router({ mergeParams: true })
router.use(authenticate)

async function ownedProject(projectId: string, userId: string) {
  return prisma.project.findFirst({ where: { id: projectId, ownerId: userId } })
}

/** DFS-based cycle detection. Returns true if `targetId` can reach `startId` following existing deps. */
async function wouldCreateCycle(epicId: string, dependsOnId: string): Promise<boolean> {
  // We're about to add edge: epicId → dependsOnId (epicId depends on dependsOnId)
  // A cycle exists if dependsOnId already transitively depends on epicId
  // i.e., can we reach epicId starting from dependsOnId?
  const visited = new Set<string>()
  const stack = [dependsOnId]
  while (stack.length > 0) {
    const current = stack.pop()!
    if (current === epicId) return true
    if (visited.has(current)) continue
    visited.add(current)
    const deps = await prisma.epicDependency.findMany({
      where: { epicId: current },
      select: { dependsOnId: true },
    })
    for (const d of deps) stack.push(d.dependsOnId)
  }
  return false
}

// GET /api/projects/:projectId/epic-dependencies
router.get('/', asyncHandler(async (req: AuthRequest, res: Response) => {
  const project = await ownedProject(req.params.projectId as string, req.userId!)
  if (!project) { res.status(404).json({ error: 'Project not found' }); return }

  const deps = await prisma.epicDependency.findMany({
    where: {
      epic: { projectId: project.id },
    },
    include: {
      epic: { select: { id: true, name: true } },
      dependsOn: { select: { id: true, name: true } },
    },
  })
  res.json(deps)
}))

// POST /api/projects/:projectId/epic-dependencies
router.post('/', asyncHandler(async (req: AuthRequest, res: Response) => {
  const project = await ownedProject(req.params.projectId as string, req.userId!)
  if (!project) { res.status(404).json({ error: 'Project not found' }); return }

  const { epicId, dependsOnId } = req.body
  if (!epicId || !dependsOnId) {
    res.status(400).json({ error: 'epicId and dependsOnId are required' }); return
  }
  if (epicId === dependsOnId) {
    res.status(400).json({ error: 'An epic cannot depend on itself' }); return
  }

  // Validate both epics belong to this project
  const [epicRecord, dependsOnRecord] = await Promise.all([
    prisma.epic.findFirst({ where: { id: epicId, projectId: project.id } }),
    prisma.epic.findFirst({ where: { id: dependsOnId, projectId: project.id } }),
  ])
  if (!epicRecord) { res.status(400).json({ error: 'epicId does not belong to this project' }); return }
  if (!dependsOnRecord) { res.status(400).json({ error: 'dependsOnId does not belong to this project' }); return }

  // Return existing dependency with 200 if already exists
  const existing = await prisma.epicDependency.findUnique({
    where: { epicId_dependsOnId: { epicId, dependsOnId } },
    include: {
      epic: { select: { id: true, name: true } },
      dependsOn: { select: { id: true, name: true } },
    },
  })
  if (existing) {
    res.status(200).json(existing); return
  }

  // Check for circular dependency before inserting
  if (await wouldCreateCycle(epicId, dependsOnId)) {
    res.status(400).json({ error: 'This dependency would create a circular reference' }); return
  }

  const dep = await prisma.epicDependency.create({
    data: { epicId, dependsOnId },
    include: {
      epic: { select: { id: true, name: true } },
      dependsOn: { select: { id: true, name: true } },
    },
  })
  res.status(201).json(dep)
}))

// DELETE /api/projects/:projectId/epic-dependencies/:epicId/:dependsOnId
router.delete('/:epicId/:dependsOnId', asyncHandler(async (req: AuthRequest, res: Response) => {
  const project = await ownedProject(req.params.projectId as string, req.userId!)
  if (!project) { res.status(404).json({ error: 'Project not found' }); return }

  await prisma.epicDependency.delete({
    where: {
      epicId_dependsOnId: {
        epicId: req.params.epicId as string,
        dependsOnId: req.params.dependsOnId as string,
      },
    },
  })
  res.json({ message: 'Deleted' })
}))

export default router
