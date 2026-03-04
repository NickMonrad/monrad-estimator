import { Router, Response } from 'express'
import { prisma } from '../lib/prisma.js'
import { authenticate, AuthRequest } from '../middleware/auth.js'

const router = Router({ mergeParams: true })
router.use(authenticate)

async function ownedProject(projectId: string, userId: string) {
  return prisma.project.findFirst({ where: { id: projectId, ownerId: userId } })
}

// GET /api/projects/:projectId/feature-dependencies
router.get('/', async (req: AuthRequest, res: Response) => {
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
})

// POST /api/projects/:projectId/feature-dependencies
router.post('/', async (req: AuthRequest, res: Response) => {
  const project = await ownedProject(req.params.projectId as string, req.userId!)
  if (!project) { res.status(404).json({ error: 'Project not found' }); return }

  const { featureId, dependsOnId } = req.body
  if (!featureId || !dependsOnId) {
    res.status(400).json({ error: 'featureId and dependsOnId are required' }); return
  }
  if (featureId === dependsOnId) {
    res.status(400).json({ error: 'A feature cannot depend on itself' }); return
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
})

// DELETE /api/projects/:projectId/feature-dependencies/:featureId/:dependsOnId
router.delete('/:featureId/:dependsOnId', async (req: AuthRequest, res: Response) => {
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
})

export default router
