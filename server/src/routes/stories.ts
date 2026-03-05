import { Router, Response } from 'express'
import { prisma } from '../lib/prisma.js'
import { authenticate, AuthRequest } from '../middleware/auth.js'

const router = Router({ mergeParams: true })
router.use(authenticate)

async function ownedFeature(featureId: string, userId: string) {
  return prisma.feature.findFirst({
    where: { id: featureId, epic: { project: { ownerId: userId } } },
  })
}

async function ownedProject(projectId: string, userId: string) {
  return prisma.project.findFirst({ where: { id: projectId, ownerId: userId } })
}

// POST /api/projects/:projectId/stories/:storyId/dependencies
router.post('/:storyId/dependencies', async (req: AuthRequest, res: Response) => {
  const project = await ownedProject(req.params.projectId as string, req.userId!)
  if (!project) { res.status(404).json({ error: 'Project not found' }); return }

  const { dependsOnId } = req.body
  if (!dependsOnId) { res.status(400).json({ error: 'dependsOnId is required' }); return }

  const storyId = req.params.storyId as string

  // Verify both stories belong to this project
  const [story, dependsOnStory] = await Promise.all([
    prisma.userStory.findFirst({ where: { id: storyId, feature: { epic: { projectId: project.id } } } }),
    prisma.userStory.findFirst({ where: { id: dependsOnId, feature: { epic: { projectId: project.id } } } }),
  ])
  if (!story || !dependsOnStory) { res.status(404).json({ error: 'Story not found in this project' }); return }

  // Prevent self-dependency
  if (storyId === dependsOnId) { res.status(400).json({ error: 'A story cannot depend on itself' }); return }

  const dep = await prisma.storyDependency.upsert({
    where: { storyId_dependsOnId: { storyId, dependsOnId } },
    create: { storyId, dependsOnId },
    update: {},
  })
  res.status(201).json(dep)
})

// DELETE /api/projects/:projectId/stories/:storyId/dependencies/:dependsOnId
router.delete('/:storyId/dependencies/:dependsOnId', async (req: AuthRequest, res: Response) => {
  const project = await ownedProject(req.params.projectId as string, req.userId!)
  if (!project) { res.status(404).json({ error: 'Project not found' }); return }

  const { storyId, dependsOnId } = req.params as { storyId: string; dependsOnId: string }

  await prisma.storyDependency.deleteMany({
    where: { storyId, dependsOnId },
  })
  res.status(204).end()
})

// GET /features/:featureId/stories
router.get('/', async (req: AuthRequest, res: Response) => {
  const feature = await ownedFeature(req.params.featureId as string, req.userId!)
  if (!feature) { res.status(404).json({ error: 'Feature not found' }); return }
  const stories = await prisma.userStory.findMany({
    where: { featureId: req.params.featureId as string },
    orderBy: { order: 'asc' },
    include: { tasks: { orderBy: { order: 'asc' }, include: { resourceType: true } } },
  })
  res.json(stories)
})

// POST /features/:featureId/stories
router.post('/', async (req: AuthRequest, res: Response) => {
  const feature = await ownedFeature(req.params.featureId as string, req.userId!)
  if (!feature) { res.status(404).json({ error: 'Feature not found' }); return }
  const { name, description, assumptions } = req.body
  if (!name) { res.status(400).json({ error: 'name is required' }); return }
  const count = await prisma.userStory.findMany({ where: { featureId: req.params.featureId as string } })
  const story = await prisma.userStory.create({
    data: { name, description, assumptions, featureId: req.params.featureId as string, order: count.length },
  })
  res.status(201).json(story)
})

// PUT /features/:featureId/stories/:id
router.put('/:id', async (req: AuthRequest, res: Response) => {
  const feature = await ownedFeature(req.params.featureId as string, req.userId!)
  if (!feature) { res.status(404).json({ error: 'Feature not found' }); return }
  const { name, description, assumptions, order, isActive } = req.body
  const story = await prisma.userStory.update({
    where: { id: req.params.id as string },
    data: { name, description, assumptions, order, ...(isActive !== undefined && { isActive }) },
  })
  res.json(story)
})

// DELETE /features/:featureId/stories/:id
router.delete('/:id', async (req: AuthRequest, res: Response) => {
  const feature = await ownedFeature(req.params.featureId as string, req.userId!)
  if (!feature) { res.status(404).json({ error: 'Feature not found' }); return }
  await prisma.userStory.delete({ where: { id: req.params.id as string } })
  res.json({ message: 'Deleted' })
})

export default router
