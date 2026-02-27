import { Router, Response } from 'express'
import { prisma } from '../lib/prisma.js'
import { authenticate, AuthRequest } from '../middleware/auth.js'

const router = Router()

const templateInclude = { tasks: { orderBy: { id: 'asc' as const } } }

// GET /api/templates — no auth required
router.get('/', async (_req, res: Response) => {
  const templates = await prisma.featureTemplate.findMany({
    orderBy: { name: 'asc' },
    include: templateInclude,
  })
  res.json(templates)
})

// POST /api/templates — auth required
router.post('/', authenticate, async (req: AuthRequest, res: Response) => {
  const { name, category, description } = req.body
  if (!name) { res.status(400).json({ error: 'name is required' }); return }
  const template = await prisma.featureTemplate.create({
    data: { name, category, description },
    include: templateInclude,
  })
  res.status(201).json(template)
})

// GET /api/templates/:id
router.get('/:id', async (req, res: Response) => {
  const template = await prisma.featureTemplate.findUnique({
    where: { id: req.params.id as string },
    include: templateInclude,
  })
  if (!template) { res.status(404).json({ error: 'Template not found' }); return }
  res.json(template)
})

// PUT /api/templates/:id — auth required
router.put('/:id', authenticate, async (req: AuthRequest, res: Response) => {
  const { name, category, description } = req.body
  const template = await prisma.featureTemplate.update({
    where: { id: req.params.id as string },
    data: { name, category, description },
    include: templateInclude,
  })
  res.json(template)
})

// DELETE /api/templates/:id — auth required
router.delete('/:id', authenticate, async (req: AuthRequest, res: Response) => {
  await prisma.featureTemplate.delete({ where: { id: req.params.id as string } })
  res.json({ message: 'Deleted' })
})

// POST /api/templates/:id/tasks — auth required
router.post('/:id/tasks', authenticate, async (req: AuthRequest, res: Response) => {
  const { name, hoursSmall, hoursMedium, hoursLarge, hoursExtraLarge, resourceTypeName } = req.body
  if (!name || !resourceTypeName) { res.status(400).json({ error: 'name and resourceTypeName are required' }); return }
  const task = await prisma.templateTask.create({
    data: {
      name,
      hoursSmall: hoursSmall ?? 0,
      hoursMedium: hoursMedium ?? 0,
      hoursLarge: hoursLarge ?? 0,
      hoursExtraLarge: hoursExtraLarge ?? 0,
      resourceTypeName,
      templateId: req.params.id as string,
    },
  })
  res.status(201).json(task)
})

// PUT /api/templates/:id/tasks/:taskId — auth required
router.put('/:id/tasks/:taskId', authenticate, async (req: AuthRequest, res: Response) => {
  const { name, hoursSmall, hoursMedium, hoursLarge, hoursExtraLarge, resourceTypeName } = req.body
  const task = await prisma.templateTask.update({
    where: { id: req.params.taskId as string },
    data: { name, hoursSmall, hoursMedium, hoursLarge, hoursExtraLarge, resourceTypeName },
  })
  res.json(task)
})

// DELETE /api/templates/:id/tasks/:taskId — auth required
router.delete('/:id/tasks/:taskId', authenticate, async (req: AuthRequest, res: Response) => {
  await prisma.templateTask.delete({ where: { id: req.params.taskId as string } })
  res.json({ message: 'Deleted' })
})

export default router
