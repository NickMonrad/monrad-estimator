import { Router, Response } from 'express'
import { prisma } from '../lib/prisma.js'
import { authenticate, AuthRequest } from '../middleware/auth.js'

const router = Router()
router.use(authenticate)

// List projects for current user
router.get('/', async (req: AuthRequest, res: Response) => {
  const projects = await prisma.project.findMany({
    where: { ownerId: req.userId },
    orderBy: { updatedAt: 'desc' },
    include: { _count: { select: { epics: true } } },
  })
  res.json(projects)
})

// Update project tax settings
router.patch('/:id/tax', async (req: AuthRequest, res: Response) => {
  const existing = await prisma.project.findFirst({ where: { id: req.params.id as string, ownerId: req.userId } })
  if (!existing) { res.status(404).json({ error: 'Not found' }); return }

  const { taxRate, taxLabel } = req.body
  if (taxRate !== undefined && taxRate !== null && (typeof taxRate !== 'number' || taxRate < 0)) {
    res.status(400).json({ error: 'taxRate must be a non-negative number or null' }); return
  }

  const project = await prisma.project.update({
    where: { id: req.params.id as string },
    data: {
      ...(taxRate !== undefined && { taxRate }),
      ...(taxLabel !== undefined && { taxLabel }),
    },
  })
  res.json(project)
})

// Get single project
router.get('/:id', async (req: AuthRequest, res: Response) => {
  const project = await prisma.project.findFirst({
    where: { id: req.params.id as string, ownerId: req.userId },
    include: { resourceTypes: true, _count: { select: { epics: true } } },
  })
  if (!project) { res.status(404).json({ error: 'Not found' }); return }
  res.json(project)
})

// Create project
router.post('/', async (req: AuthRequest, res: Response) => {
  const { name, description, customer } = req.body
  if (!name) { res.status(400).json({ error: 'name is required' }); return }

  // Fetch global types to seed into the new project
  const globalTypes = await prisma.globalResourceType.findMany()
  const seedTypes = globalTypes.map(gt => ({
    name: gt.name,
    category: gt.category,
    globalTypeId: gt.id,
    hoursPerDay: gt.defaultHoursPerDay ?? null,
    dayRate: gt.defaultDayRate ?? null,
  }))

  const project = await prisma.project.create({
    data: {
      name,
      description,
      customer,
      ownerId: req.userId!,
      // Seed default resource types
      resourceTypes: { create: seedTypes },
    },
    include: { resourceTypes: true },
  })
  res.status(201).json(project)
})

// Update project
router.put('/:id', async (req: AuthRequest, res: Response) => {
  const { name, description, customer, status, hoursPerDay, taxRate, taxLabel } = req.body
  const bufferWeeks = req.body.bufferWeeks !== undefined ? (parseInt(req.body.bufferWeeks) ?? 0) : undefined
  const existing = await prisma.project.findFirst({ where: { id: req.params.id as string, ownerId: req.userId } })
  if (!existing) { res.status(404).json({ error: 'Not found' }); return }
  const project = await prisma.project.update({
    where: { id: req.params.id as string },
    data: { name, description, customer, status, hoursPerDay, taxRate, taxLabel, ...(bufferWeeks !== undefined && { bufferWeeks }) },
  })
  res.json(project)
})

// Archive / delete project
router.delete('/:id', async (req: AuthRequest, res: Response) => {
  const existing = await prisma.project.findFirst({ where: { id: req.params.id as string, ownerId: req.userId } })
  if (!existing) { res.status(404).json({ error: 'Not found' }); return }
  await prisma.project.update({ where: { id: req.params.id as string }, data: { status: 'ARCHIVED' } })
  res.json({ message: 'Project archived' })
})

export default router
