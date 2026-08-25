import { Router, Response } from 'express'
import { prisma } from '../lib/prisma.js'
import { asyncHandler } from '../lib/asyncHandler.js'
import { authenticate, AuthRequest } from '../middleware/auth.js'

const router = Router({ mergeParams: true })
router.use(authenticate)

async function ownedProject(projectId: string, userId: string) {
  return prisma.project.findFirst({ where: { id: projectId, ownerId: userId } })
}
/** DFS-based cycle detection for feature dependencies. */
async function wouldCreateCycle(featureId: string, dependsOnId: string): Promise<boolean> {
  const visited = new Set<string>()
  const stack = [dependsOnId]
  while (stack.length > 0) {
    const current = stack.pop()!
    if (current === featureId) return true
    if (visited.has(current)) continue
    visited.add(current)
    const dependencies = await prisma.featureDependency.findMany({
      where: { featureId: current },
      select: { dependsOnId: true },
    })
    for (const dependency of dependencies) stack.push(dependency.dependsOnId)
  }
  return false
}


// GET /api/projects/:projectId/feature-dependencies
router.get('/', asyncHandler(async (req: AuthRequest, res: Response) => {
  const project = await ownedProject(req.params.projectId as string, req.userId!)
  if (!project) { res.status(404).json({ error: 'Project not found' }); return }

  const deps = await prisma.featureDependency.findMany({
    where: {
      feature: { epic: { projectId: project.id } },
    },
    include: {
      feature: { select: { id: true, name: true, epicId: true } },
      dependsOn: { select: { id: true, name: true, epicId: true } },
    },
  })
  res.json(deps)
}))

// POST /api/projects/:projectId/feature-dependencies
router.post('/', asyncHandler(async (req: AuthRequest, res: Response) => {
  const project = await ownedProject(req.params.projectId as string, req.userId!)
  if (!project) { res.status(404).json({ error: 'Project not found' }); return }

  const { featureId, dependsOnId } = req.body
  if (!featureId || !dependsOnId) {
    res.status(400).json({ error: 'featureId and dependsOnId are required' }); return
  }
  if (featureId === dependsOnId) {
    res.status(400).json({ error: 'A feature cannot depend on itself' }); return
  }

  const [feature, dependsOn] = await Promise.all([
    prisma.feature.findFirst({ where: { id: featureId, epic: { projectId: project.id } } }),
    prisma.feature.findFirst({ where: { id: dependsOnId, epic: { projectId: project.id } } }),
  ])
  if (!feature) { res.status(400).json({ error: 'featureId does not belong to this project' }); return }
  if (!dependsOn) { res.status(400).json({ error: 'dependsOnId does not belong to this project' }); return }

  if (await wouldCreateCycle(featureId, dependsOnId)) {
    res.status(400).json({ error: 'This dependency would create a circular reference' }); return
  }

  try {
    const dep = await prisma.featureDependency.create({
      data: { featureId, dependsOnId },
      include: {
        feature: { select: { id: true, name: true, epicId: true } },
        dependsOn: { select: { id: true, name: true, epicId: true } },
      },
    })
    res.status(201).json(dep)
  } catch (e: any) {
    if (e.code === 'P2002') {
      res.status(409).json({ error: 'Dependency already exists' }); return
    }
    throw e
  }
}))

// DELETE /api/projects/:projectId/feature-dependencies/:featureId/:dependsOnId
router.delete('/:featureId/:dependsOnId', asyncHandler(async (req: AuthRequest, res: Response) => {
  const project = await ownedProject(req.params.projectId as string, req.userId!)
  if (!project) { res.status(404).json({ error: 'Project not found' }); return }

  await prisma.featureDependency.delete({
    where: {
      featureId_dependsOnId: {
        featureId: req.params.featureId as string,
        dependsOnId: req.params.dependsOnId as string,
      },
    },
  })
  res.json({ message: 'Deleted' })
}))

export default router
