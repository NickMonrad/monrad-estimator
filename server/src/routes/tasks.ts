import { Router, Response } from 'express'
import { prisma } from '../lib/prisma.js'
import { authenticate, AuthRequest } from '../middleware/auth.js'

const router = Router({ mergeParams: true })
router.use(authenticate)

async function ownedStory(storyId: string, userId: string) {
  return prisma.userStory.findFirst({
    where: { id: storyId, feature: { epic: { project: { ownerId: userId } } } },
  })
}

// GET /stories/:storyId/tasks
router.get('/', async (req: AuthRequest, res: Response) => {
  const story = await ownedStory(req.params.storyId as string, req.userId!)
  if (!story) { res.status(404).json({ error: 'Story not found' }); return }
  const tasks = await prisma.task.findMany({
    where: { userStoryId: req.params.storyId as string },
    orderBy: { order: 'asc' },
    include: { resourceType: true },
  })
  res.json(tasks)
})

// POST /stories/:storyId/tasks
router.post('/', async (req: AuthRequest, res: Response) => {
  const story = await ownedStory(req.params.storyId as string, req.userId!)
  if (!story) { res.status(404).json({ error: 'Story not found' }); return }
  const { name, description, assumptions, hoursEffort, resourceTypeId } = req.body
  if (!name || !resourceTypeId) { res.status(400).json({ error: 'name and resourceTypeId are required' }); return }
  const count = await prisma.task.findMany({ where: { userStoryId: req.params.storyId as string } })
  const task = await prisma.task.create({
    data: { name, description, assumptions, hoursEffort: hoursEffort ?? 0, resourceTypeId, userStoryId: req.params.storyId as string, order: count.length },
    include: { resourceType: true },
  })
  res.status(201).json(task)
})

// PUT /stories/:storyId/tasks/:id
router.put('/:id', async (req: AuthRequest, res: Response) => {
  const story = await ownedStory(req.params.storyId as string, req.userId!)
  if (!story) { res.status(404).json({ error: 'Story not found' }); return }
  const { name, description, assumptions, hoursEffort, resourceTypeId, order } = req.body
  const task = await prisma.task.update({
    where: { id: req.params.id as string },
    data: { name, description, assumptions, hoursEffort, resourceTypeId, order },
    include: { resourceType: true },
  })
  res.json(task)
})

// DELETE /stories/:storyId/tasks/:id
router.delete('/:id', async (req: AuthRequest, res: Response) => {
  const story = await ownedStory(req.params.storyId as string, req.userId!)
  if (!story) { res.status(404).json({ error: 'Story not found' }); return }
  await prisma.task.delete({ where: { id: req.params.id as string } })
  res.json({ message: 'Deleted' })
})

export default router
