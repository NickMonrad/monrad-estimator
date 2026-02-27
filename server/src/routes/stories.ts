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
  const { name, description, assumptions, order } = req.body
  const story = await prisma.userStory.update({
    where: { id: req.params.id as string },
    data: { name, description, assumptions, order },
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
