import { Router, Response } from 'express'
import { OverheadType } from '@prisma/client'
import { prisma } from '../lib/prisma.js'
import { asyncHandler } from '../lib/asyncHandler.js'
import { authenticate, AuthRequest } from '../middleware/auth.js'

const router = Router({ mergeParams: true })
router.use(authenticate)

async function ownedProject(projectId: string, userId: string) {
  return prisma.project.findFirst({ where: { id: projectId, ownerId: userId } })
}

function isValidOverheadType(value: unknown): value is OverheadType {
  return value === 'PERCENTAGE' || value === 'FIXED_DAYS' || value === 'DAYS_PER_WEEK'
}

async function validateResourceType(resourceTypeId: string | null | undefined, projectId: string) {
  if (!resourceTypeId) {
    return null
  }
  const resourceType = await prisma.resourceType.findFirst({
    where: { id: resourceTypeId, projectId },
    select: { id: true },
  })
  return resourceType ? resourceTypeId : null
}

// GET /api/projects/:projectId/overhead
router.get('/', asyncHandler(async (req: AuthRequest, res: Response) => {
  const project = await ownedProject(req.params.projectId as string, req.userId!)
  if (!project) {
    res.status(404).json({ error: 'Project not found' })
    return
  }

  const overheads = await prisma.projectOverhead.findMany({
    where: { projectId: req.params.projectId as string },
    orderBy: [{ order: 'asc' }, { createdAt: 'asc' }],
    include: { resourceType: true },
  })
  res.json(overheads)
}))

// POST /api/projects/:projectId/overhead
router.post('/', asyncHandler(async (req: AuthRequest, res: Response) => {
  const projectId = req.params.projectId as string
  const project = await ownedProject(projectId, req.userId!)
  if (!project) {
    res.status(404).json({ error: 'Project not found' })
    return
  }

  const { name, resourceTypeId, type, value, order } = req.body
  if (!name) {
    res.status(400).json({ error: 'name is required' })
    return
  }
  if (!isValidOverheadType(type)) {
    res.status(400).json({ error: 'type must be PERCENTAGE or FIXED_DAYS' })
    return
  }
  const numericValue = Number(value)
  if (Number.isNaN(numericValue)) {
    res.status(400).json({ error: 'value must be a number' })
    return
  }
  if (numericValue < 0) {
    res.status(400).json({ error: 'value must be non-negative' })
    return
  }

  const rtId = await validateResourceType(resourceTypeId, projectId)
  if (resourceTypeId && !rtId) {
    res.status(400).json({ error: 'resourceTypeId is invalid for this project' })
    return
  }

  const numericOrder = order === undefined ? 0 : Number(order)
  if (order !== undefined && Number.isNaN(numericOrder)) {
    res.status(400).json({ error: 'order must be a number' })
    return
  }

  const overhead = await prisma.projectOverhead.create({
    data: {
      name,
      resourceTypeId: rtId,
      type,
      value: numericValue,
      order: numericOrder,
      projectId,
    },
    include: { resourceType: true },
  })
  res.status(201).json(overhead)
}))

// PUT /api/projects/:projectId/overhead/:overheadId
router.put('/:overheadId', asyncHandler(async (req: AuthRequest, res: Response) => {
  const projectId = req.params.projectId as string
  const project = await ownedProject(projectId, req.userId!)
  if (!project) {
    res.status(404).json({ error: 'Project not found' })
    return
  }

  const overheadId = req.params.overheadId as string
  const existing = await prisma.projectOverhead.findFirst({ where: { id: overheadId, projectId } })
  if (!existing) {
    res.status(404).json({ error: 'Overhead not found' })
    return
  }

  const data: Record<string, unknown> = {}
  if (req.body.name !== undefined) data.name = req.body.name
  if (req.body.order !== undefined) {
    const numericOrder = Number(req.body.order)
    if (Number.isNaN(numericOrder)) {
      res.status(400).json({ error: 'order must be a number' })
      return
    }
    data.order = numericOrder
  }

  if (req.body.type !== undefined) {
    if (!isValidOverheadType(req.body.type)) {
      res.status(400).json({ error: 'type must be PERCENTAGE or FIXED_DAYS' })
      return
    }
    data.type = req.body.type
  }

  if (req.body.value !== undefined) {
    const numericValue = Number(req.body.value)
    if (Number.isNaN(numericValue)) {
      res.status(400).json({ error: 'value must be a number' })
      return
    }
    data.value = numericValue
  }

  if (req.body.resourceTypeId !== undefined) {
    if (req.body.resourceTypeId === null) {
      data.resourceTypeId = null
    } else {
      const rtId = await validateResourceType(req.body.resourceTypeId, projectId)
      if (!rtId) {
        res.status(400).json({ error: 'resourceTypeId is invalid for this project' })
        return
      }
      data.resourceTypeId = rtId
    }
  }

  const updated = await prisma.projectOverhead.update({
    where: { id: overheadId },
    data,
    include: { resourceType: true },
  })
  res.json(updated)
}))

// DELETE /api/projects/:projectId/overhead/:overheadId
router.delete('/:overheadId', asyncHandler(async (req: AuthRequest, res: Response) => {
  const projectId = req.params.projectId as string
  const project = await ownedProject(projectId, req.userId!)
  if (!project) {
    res.status(404).json({ error: 'Project not found' })
    return
  }

  const overheadId = req.params.overheadId as string
  const existing = await prisma.projectOverhead.findFirst({ where: { id: overheadId, projectId } })
  if (!existing) {
    res.status(404).json({ error: 'Overhead not found' })
    return
  }

  await prisma.projectOverhead.delete({ where: { id: overheadId } })
  res.json({ message: 'Deleted' })
}))

export default router
