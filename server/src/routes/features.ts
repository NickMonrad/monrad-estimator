import { Router, Response } from 'express'
import { prisma } from '../lib/prisma.js'
import { authenticate, AuthRequest } from '../middleware/auth.js'

const router = Router({ mergeParams: true })
router.use(authenticate)

async function ownedEpic(epicId: string, userId: string) {
  return prisma.epic.findFirst({
    where: { id: epicId, project: { ownerId: userId } },
  })
}

// GET /epics/:epicId/features
router.get('/', async (req: AuthRequest, res: Response) => {
  const epic = await ownedEpic(req.params.epicId as string, req.userId!)
  if (!epic) { res.status(404).json({ error: 'Epic not found' }); return }
  const features = await prisma.feature.findMany({
    where: { epicId: req.params.epicId as string },
    orderBy: { order: 'asc' },
    include: {
      userStories: {
        orderBy: { order: 'asc' },
        include: { tasks: { orderBy: { order: 'asc' }, include: { resourceType: true } } },
      },
    },
  })
  res.json(features)
})

// POST /epics/:epicId/features
router.post('/', async (req: AuthRequest, res: Response) => {
  const epic = await ownedEpic(req.params.epicId as string, req.userId!)
  if (!epic) { res.status(404).json({ error: 'Epic not found' }); return }
  const { name, description, assumptions } = req.body
  if (!name) { res.status(400).json({ error: 'name is required' }); return }
  const count = await prisma.feature.findMany({ where: { epicId: req.params.epicId as string } })
  const feature = await prisma.feature.create({
    data: { name, description, assumptions, epicId: req.params.epicId as string, order: count.length },
  })
  res.status(201).json(feature)
})

// PUT /epics/:epicId/features/:id
router.put('/:id', async (req: AuthRequest, res: Response) => {
  const epic = await ownedEpic(req.params.epicId as string, req.userId!)
  if (!epic) { res.status(404).json({ error: 'Epic not found' }); return }
  const { name, description, assumptions, order } = req.body
  const feature = await prisma.feature.update({
    where: { id: req.params.id as string },
    data: { name, description, assumptions, order },
  })
  res.json(feature)
})

// DELETE /epics/:epicId/features/:id
router.delete('/:id', async (req: AuthRequest, res: Response) => {
  const epic = await ownedEpic(req.params.epicId as string, req.userId!)
  if (!epic) { res.status(404).json({ error: 'Epic not found' }); return }
  await prisma.feature.delete({ where: { id: req.params.id as string } })
  res.json({ message: 'Deleted' })
})

export default router
