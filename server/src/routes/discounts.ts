import { Router, Response } from 'express'
import { prisma } from '../lib/prisma.js'
import { authenticate, AuthRequest } from '../middleware/auth.js'

const router = Router({ mergeParams: true })
router.use(authenticate)

// Verify project ownership helper
async function ownedProject(projectId: string, userId: string) {
  return prisma.project.findFirst({ where: { id: projectId, ownerId: userId } })
}

const VALID_DISCOUNT_TYPES = ['PERCENTAGE', 'FIXED_AMOUNT']

// GET /projects/:projectId/discounts
router.get('/', async (req: AuthRequest, res: Response) => {
  const project = await ownedProject(req.params.projectId as string, req.userId!)
  if (!project) { res.status(404).json({ error: 'Project not found' }); return }
  const discounts = await prisma.projectDiscount.findMany({
    where: { projectId: req.params.projectId as string },
    orderBy: { order: 'asc' },
    include: { resourceType: true },
  })
  res.json(discounts)
})

// POST /projects/:projectId/discounts
router.post('/', async (req: AuthRequest, res: Response) => {
  const project = await ownedProject(req.params.projectId as string, req.userId!)
  if (!project) { res.status(404).json({ error: 'Project not found' }); return }

  const { type, value, label, resourceTypeId, order } = req.body
  if (!label) { res.status(400).json({ error: 'label is required' }); return }
  if (!VALID_DISCOUNT_TYPES.includes(type)) {
    res.status(400).json({ error: 'type must be PERCENTAGE or FIXED_AMOUNT' }); return
  }
  if (typeof value !== 'number' || value <= 0) {
    res.status(400).json({ error: 'value must be a positive number' }); return
  }

  // If resourceTypeId provided, verify it belongs to this project
  if (resourceTypeId) {
    const rt = await prisma.resourceType.findFirst({
      where: { id: resourceTypeId, projectId: req.params.projectId as string },
    })
    if (!rt) { res.status(400).json({ error: 'resourceTypeId does not belong to this project' }); return }
  }

  const discount = await prisma.projectDiscount.create({
    data: {
      type,
      value,
      label,
      projectId: req.params.projectId as string,
      ...(resourceTypeId && { resourceTypeId }),
      ...(typeof order === 'number' && { order }),
    },
    include: { resourceType: true },
  })
  res.status(201).json(discount)
})

// PUT /projects/:projectId/discounts/:id
router.put('/:id', async (req: AuthRequest, res: Response) => {
  const project = await ownedProject(req.params.projectId as string, req.userId!)
  if (!project) { res.status(404).json({ error: 'Project not found' }); return }

  // Verify discount belongs to this project
  const existing = await prisma.projectDiscount.findFirst({
    where: { id: req.params.id as string, projectId: req.params.projectId as string },
  })
  if (!existing) { res.status(404).json({ error: 'Discount not found' }); return }

  const { type, value, label, resourceTypeId, order } = req.body

  if (type !== undefined && !VALID_DISCOUNT_TYPES.includes(type)) {
    res.status(400).json({ error: 'type must be PERCENTAGE or FIXED_AMOUNT' }); return
  }
  if (value !== undefined && (typeof value !== 'number' || value <= 0)) {
    res.status(400).json({ error: 'value must be a positive number' }); return
  }

  // If resourceTypeId provided, verify it belongs to this project
  if (resourceTypeId) {
    const rt = await prisma.resourceType.findFirst({
      where: { id: resourceTypeId, projectId: req.params.projectId as string },
    })
    if (!rt) { res.status(400).json({ error: 'resourceTypeId does not belong to this project' }); return }
  }

  const discount = await prisma.projectDiscount.update({
    where: { id: req.params.id as string },
    data: {
      ...(type !== undefined && { type }),
      ...(value !== undefined && { value }),
      ...(label !== undefined && { label }),
      ...(resourceTypeId !== undefined && { resourceTypeId }),
      ...(typeof order === 'number' && { order }),
    },
    include: { resourceType: true },
  })
  res.json(discount)
})

// DELETE /projects/:projectId/discounts/:id
router.delete('/:id', async (req: AuthRequest, res: Response) => {
  const project = await ownedProject(req.params.projectId as string, req.userId!)
  if (!project) { res.status(404).json({ error: 'Project not found' }); return }

  // Verify discount belongs to this project
  const existing = await prisma.projectDiscount.findFirst({
    where: { id: req.params.id as string, projectId: req.params.projectId as string },
  })
  if (!existing) { res.status(404).json({ error: 'Discount not found' }); return }

  await prisma.projectDiscount.delete({ where: { id: req.params.id as string } })
  res.status(204).send()
})

export default router
