import { Router, Response } from 'express'
import { prisma } from '../lib/prisma.js'
import { asyncHandler } from '../lib/asyncHandler.js'
import { authenticate, AuthRequest } from '../middleware/auth.js'
import { ownedProject } from '../lib/ownership.js'

const router = Router({ mergeParams: true })
router.use(authenticate)

function parseOrder(value: unknown): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) return undefined
  return value
}

function hasText(value: string): boolean {
  return value.replace(/<[^>]*>/g, '').replace(/&nbsp;/gi, ' ').trim().length > 0
}

router.get('/', asyncHandler(async (req: AuthRequest, res: Response) => {
  const projectId = req.params.projectId as string
  const project = await ownedProject(projectId, req.userId!)
  if (!project) { res.status(404).json({ error: 'Project not found' }); return }

  const dependencies = await prisma.projectDependency.findMany({
    where: { projectId },
    orderBy: [{ order: 'asc' }, { id: 'asc' }],
  })
  res.json(dependencies)
}))

router.patch('/reorder', asyncHandler(async (req: AuthRequest, res: Response) => {
  const projectId = req.params.projectId as string
  const project = await ownedProject(projectId, req.userId!)
  if (!project) { res.status(404).json({ error: 'Project not found' }); return }

  const items = Array.isArray(req.body.items) ? req.body.items : []
  if (
    items.length === 0 ||
    items.some((item: unknown) => {
      const value = item as { id?: unknown; order?: unknown }
      return typeof value.id !== 'string' || parseOrder(value.order) === undefined
    }) ||
    new Set(items.map((item: { id: string }) => item.id)).size !== items.length
  ) {
    res.status(400).json({ error: 'Items must contain unique ids and non-negative integer orders' }); return
  }

  const existing = await prisma.projectDependency.findMany({ where: { projectId, id: { in: items.map((item: { id: string }) => item.id) } } })
  if (existing.length !== items.length) { res.status(404).json({ error: 'Dependency not found' }); return }
  await Promise.all(items.map((item: { id: string; order: number }) =>
    prisma.projectDependency.update({ where: { id: item.id }, data: { order: item.order } }),
  ))
  const dependencies = await prisma.projectDependency.findMany({ where: { projectId }, orderBy: [{ order: 'asc' }, { id: 'asc' }] })
  res.json(dependencies)
}))

router.post('/', asyncHandler(async (req: AuthRequest, res: Response) => {
  const projectId = req.params.projectId as string
  const project = await ownedProject(projectId, req.userId!)
  if (!project) { res.status(404).json({ error: 'Project not found' }); return }

  const description = typeof req.body.description === 'string' ? req.body.description.trim() : ''
  if (!hasText(description)) { res.status(400).json({ error: 'Description is required' }); return }
  const requestedOrder = parseOrder(req.body.order)
  if (req.body.order !== undefined && requestedOrder === undefined) {
    res.status(400).json({ error: 'Order must be a non-negative integer' }); return
  }

  const last = await prisma.projectDependency.findFirst({ where: { projectId }, orderBy: { order: 'desc' } })
  const dependency = await prisma.projectDependency.create({
    data: { projectId, description, order: requestedOrder ?? (last?.order ?? -1) + 1 },
  })
  res.status(201).json(dependency)
}))

router.put('/:id', asyncHandler(async (req: AuthRequest, res: Response) => {
  const projectId = req.params.projectId as string
  const project = await ownedProject(projectId, req.userId!)
  if (!project) { res.status(404).json({ error: 'Project not found' }); return }

  const dependency = await prisma.projectDependency.findFirst({ where: { id: req.params.id as string, projectId } })
  if (!dependency) { res.status(404).json({ error: 'Dependency not found' }); return }

  const data: { description?: string; order?: number } = {}
  if (req.body.description !== undefined) {
    const description = typeof req.body.description === 'string' ? req.body.description.trim() : ''
    if (!hasText(description)) { res.status(400).json({ error: 'Description is required' }); return }
    data.description = description
  }
  if (req.body.order !== undefined) {
    const order = parseOrder(req.body.order)
    if (order === undefined) { res.status(400).json({ error: 'Order must be a non-negative integer' }); return }
    data.order = order
  }
  if (Object.keys(data).length === 0) { res.status(400).json({ error: 'No changes supplied' }); return }

  const updated = await prisma.projectDependency.update({ where: { id: dependency.id }, data })
  res.json(updated)
}))

router.delete('/:id', asyncHandler(async (req: AuthRequest, res: Response) => {
  const projectId = req.params.projectId as string
  const project = await ownedProject(projectId, req.userId!)
  if (!project) { res.status(404).json({ error: 'Project not found' }); return }

  const dependency = await prisma.projectDependency.findFirst({ where: { id: req.params.id as string, projectId } })
  if (!dependency) { res.status(404).json({ error: 'Dependency not found' }); return }

  await prisma.projectDependency.delete({ where: { id: dependency.id } })
  res.status(204).send()
}))

export default router
