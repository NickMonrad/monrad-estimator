import { Router, Response } from 'express'
import { prisma } from '../lib/prisma.js'
import { asyncHandler } from '../lib/asyncHandler.js'
import { authenticate, AuthRequest } from '../middleware/auth.js'
import { ownedEpic } from '../lib/ownership.js'

const router = Router({ mergeParams: true })
router.use(authenticate)

// GET /epics/:epicId/features
router.get('/', asyncHandler(async (req: AuthRequest, res: Response) => {
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
}))

// POST /epics/:epicId/features
router.post('/', asyncHandler(async (req: AuthRequest, res: Response) => {
  const epic = await ownedEpic(req.params.epicId as string, req.userId!)
  if (!epic) { res.status(404).json({ error: 'Epic not found' }); return }
  const { name, description, assumptions } = req.body
  if (!name) { res.status(400).json({ error: 'name is required' }); return }
  const count = await prisma.feature.count({ where: { epicId: req.params.epicId as string } })
  const feature = await prisma.feature.create({
    data: { name, description, assumptions, epicId: req.params.epicId as string, order: count },
  })
  res.status(201).json(feature)
}))

// PUT /epics/:epicId/features/:id
router.put('/:id', asyncHandler(async (req: AuthRequest, res: Response) => {
  const epic = await ownedEpic(req.params.epicId as string, req.userId!)
  if (!epic) { res.status(404).json({ error: 'Epic not found' }); return }
  const { name, description, assumptions, order, isActive, timelineColour } = req.body
  const data: Record<string, unknown> = { name, description, assumptions, order }
  if (isActive !== undefined) data.isActive = isActive
  if (timelineColour !== undefined) data.timelineColour = timelineColour
  const feature = await prisma.feature.update({
    where: { id: req.params.id as string, epicId: req.params.epicId as string },
    data,
  })
  res.json(feature)
}))

// DELETE /epics/:epicId/features/:id
router.delete('/:id', asyncHandler(async (req: AuthRequest, res: Response) => {
  const epic = await ownedEpic(req.params.epicId as string, req.userId!)
  if (!epic) { res.status(404).json({ error: 'Epic not found' }); return }
  await prisma.feature.delete({ where: { id: req.params.id as string, epicId: req.params.epicId as string } })
  res.json({ message: 'Deleted' })
}))

export default router
