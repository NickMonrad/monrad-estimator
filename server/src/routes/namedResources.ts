import { Router, Response } from 'express'
import { prisma } from '../lib/prisma.js'
import { authenticate, AuthRequest } from '../middleware/auth.js'

const router = Router({ mergeParams: true })
router.use(authenticate)

async function ownedProject(projectId: string, userId: string) {
  return prisma.project.findFirst({ where: { id: projectId, ownerId: userId } })
}

/** Verify the resource type exists and belongs to the project */
async function verifyResourceType(rtId: string, projectId: string) {
  return prisma.resourceType.findFirst({ where: { id: rtId, projectId } })
}

const VALID_PRICING_MODELS = ['ACTUAL_DAYS', 'PRO_RATA']

// GET /projects/:projectId/resource-types/:rtId/named-resources
router.get('/', async (req: AuthRequest, res: Response) => {
  const { projectId, rtId } = req.params as { projectId: string; rtId: string }
  const project = await ownedProject(projectId, req.userId!)
  if (!project) { res.status(404).json({ error: 'Project not found' }); return }

  const rt = await verifyResourceType(rtId, projectId)
  if (!rt) { res.status(404).json({ error: 'Resource type not found' }); return }

  const resources = await prisma.namedResource.findMany({
    where: { resourceTypeId: rtId },
    include: { resourceType: true },
    orderBy: { name: 'asc' },
  })
  res.json(resources)
})

// POST /projects/:projectId/resource-types/:rtId/named-resources
router.post('/', async (req: AuthRequest, res: Response) => {
  const { projectId, rtId } = req.params as { projectId: string; rtId: string }
  const project = await ownedProject(projectId, req.userId!)
  if (!project) { res.status(404).json({ error: 'Project not found' }); return }

  const rt = await verifyResourceType(rtId, projectId)
  if (!rt) { res.status(404).json({ error: 'Resource type not found' }); return }

  const { name: rawName, startWeek, endWeek, allocationPct, pricingModel } = req.body

  // Auto-generate a numbered name if none provided or generic
  let name = rawName as string | undefined
  if (!name || name === 'New person') {
    const existing = await prisma.namedResource.count({ where: { resourceTypeId: rtId } })
    name = `${rt.name} ${existing + 1}`
  }

  if (allocationPct !== undefined && (allocationPct < 0 || allocationPct > 100)) {
    res.status(400).json({ error: 'allocationPct must be between 0 and 100' }); return
  }

  if (pricingModel !== undefined && !VALID_PRICING_MODELS.includes(pricingModel)) {
    res.status(400).json({ error: `pricingModel must be one of: ${VALID_PRICING_MODELS.join(', ')}` }); return
  }

  const resource = await prisma.namedResource.create({
    data: {
      name,
      resourceTypeId: rtId,
      ...(startWeek !== undefined && { startWeek }),
      ...(endWeek !== undefined && { endWeek }),
      ...(allocationPct !== undefined && { allocationPct }),
      ...(pricingModel !== undefined && { pricingModel }),
    },
  })

  // Sync resource type count to match total named resources
  const total = await prisma.namedResource.count({ where: { resourceTypeId: rtId } })
  await prisma.resourceType.update({ where: { id: rtId }, data: { count: total } })

  res.status(201).json(resource)
})

// PUT /projects/:projectId/resource-types/:rtId/named-resources/:id
router.put('/:id', async (req: AuthRequest, res: Response) => {
  const { projectId, rtId, id } = req.params as { projectId: string; rtId: string; id: string }
  const project = await ownedProject(projectId, req.userId!)
  if (!project) { res.status(404).json({ error: 'Project not found' }); return }

  const rt = await verifyResourceType(rtId, projectId)
  if (!rt) { res.status(404).json({ error: 'Resource type not found' }); return }

  // Verify the named resource belongs to this resource type
  const existing = await prisma.namedResource.findFirst({ where: { id, resourceTypeId: rtId } })
  if (!existing) { res.status(404).json({ error: 'Named resource not found' }); return }

  const { name, startWeek, endWeek, allocationPct, pricingModel } = req.body

  if (allocationPct !== undefined && (allocationPct < 0 || allocationPct > 100)) {
    res.status(400).json({ error: 'allocationPct must be between 0 and 100' }); return
  }

  if (pricingModel !== undefined && !VALID_PRICING_MODELS.includes(pricingModel)) {
    res.status(400).json({ error: `pricingModel must be one of: ${VALID_PRICING_MODELS.join(', ')}` }); return
  }

  const data: Record<string, unknown> = { name, startWeek, endWeek, allocationPct, pricingModel }
  Object.keys(data).forEach(key => {
    if (data[key] === undefined) delete data[key]
  })

  const resource = await prisma.namedResource.update({
    where: { id },
    data,
  })
  res.json(resource)
})

// DELETE /projects/:projectId/resource-types/:rtId/named-resources/:id
router.delete('/:id', async (req: AuthRequest, res: Response) => {
  const { projectId, rtId, id } = req.params as { projectId: string; rtId: string; id: string }
  const project = await ownedProject(projectId, req.userId!)
  if (!project) { res.status(404).json({ error: 'Project not found' }); return }

  const rt = await verifyResourceType(rtId, projectId)
  if (!rt) { res.status(404).json({ error: 'Resource type not found' }); return }

  // Verify the named resource belongs to this resource type
  const existing = await prisma.namedResource.findFirst({ where: { id, resourceTypeId: rtId } })
  if (!existing) { res.status(404).json({ error: 'Named resource not found' }); return }

  await prisma.namedResource.delete({ where: { id } })

  // Sync resource type count (minimum 1 — always need at least one resource)
  const total = await prisma.namedResource.count({ where: { resourceTypeId: rtId } })
  await prisma.resourceType.update({ where: { id: rtId }, data: { count: Math.max(1, total) } })

  res.status(204).send()
})

export default router
