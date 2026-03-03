import { Router, Response } from 'express'
import { ResourceCategory } from '@prisma/client'
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

  // Fetch global types to link by name
  const globalTypes = await prisma.globalResourceType.findMany()
  const globalTypeByName = new Map(globalTypes.map(gt => [gt.name, gt]))
  const baseTypes: Array<{ name: string; category: ResourceCategory }> = [
    { name: 'Business Analyst', category: 'ENGINEERING' },
    { name: 'Developer', category: 'ENGINEERING' },
    { name: 'Tech Lead', category: 'ENGINEERING' },
    { name: 'QA Engineer', category: 'ENGINEERING' },
    { name: 'Tech Governance', category: 'GOVERNANCE' },
    { name: 'Project Manager', category: 'PROJECT_MANAGEMENT' },
  ]
  const seedTypes = baseTypes.map(type => {
    const globalType = globalTypeByName.get(type.name)
    return {
      ...type,
      globalTypeId: globalType?.id,
      hoursPerDay: globalType?.defaultHoursPerDay ?? null,
      dayRate: globalType?.defaultDayRate ?? null,
    }
  })

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
  const { name, description, customer, status, hoursPerDay } = req.body
  const existing = await prisma.project.findFirst({ where: { id: req.params.id as string, ownerId: req.userId } })
  if (!existing) { res.status(404).json({ error: 'Not found' }); return }
  const project = await prisma.project.update({
    where: { id: req.params.id as string },
    data: { name, description, customer, status, hoursPerDay },
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
