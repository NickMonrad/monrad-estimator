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

  const risks = await prisma.projectRisk.findMany({
    where: { projectId },
    orderBy: [{ order: 'asc' }, { id: 'asc' }],
  })
  res.json(risks)
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

  const existing = await prisma.projectRisk.findMany({ where: { projectId, id: { in: items.map((item: { id: string }) => item.id) } } })
  if (existing.length !== items.length) { res.status(404).json({ error: 'Risk not found' }); return }
  await Promise.all(items.map((item: { id: string; order: number }) =>
    prisma.projectRisk.update({ where: { id: item.id }, data: { order: item.order } }),
  ))
  const risks = await prisma.projectRisk.findMany({ where: { projectId }, orderBy: [{ order: 'asc' }, { id: 'asc' }] })
  res.json(risks)
}))

router.post('/', asyncHandler(async (req: AuthRequest, res: Response) => {
  const projectId = req.params.projectId as string
  const project = await ownedProject(projectId, req.userId!)
  if (!project) { res.status(404).json({ error: 'Project not found' }); return }

  const description = typeof req.body.description === 'string' ? req.body.description.trim() : ''
  if (!hasText(description)) { res.status(400).json({ error: 'Description is required' }); return }
  const mitigation = req.body.mitigation == null ? null : typeof req.body.mitigation === 'string' ? req.body.mitigation.trim() : null
  if (req.body.mitigation !== undefined && req.body.mitigation !== null && typeof req.body.mitigation !== 'string') {
    res.status(400).json({ error: 'Mitigation must be text' }); return
  }
  const requestedOrder = parseOrder(req.body.order)
  if (req.body.order !== undefined && requestedOrder === undefined) {
    res.status(400).json({ error: 'Order must be a non-negative integer' }); return
  }

  const last = await prisma.projectRisk.findFirst({ where: { projectId }, orderBy: { order: 'desc' } })
  const risk = await prisma.projectRisk.create({
    data: { projectId, description, mitigation, order: requestedOrder ?? (last?.order ?? -1) + 1 },
  })
  res.status(201).json(risk)
}))

router.put('/:id', asyncHandler(async (req: AuthRequest, res: Response) => {
  const projectId = req.params.projectId as string
  const project = await ownedProject(projectId, req.userId!)
  if (!project) { res.status(404).json({ error: 'Project not found' }); return }

  const risk = await prisma.projectRisk.findFirst({ where: { id: req.params.id as string, projectId } })
  if (!risk) { res.status(404).json({ error: 'Risk not found' }); return }

  const data: { description?: string; mitigation?: string | null; order?: number } = {}
  if (req.body.description !== undefined) {
    const description = typeof req.body.description === 'string' ? req.body.description.trim() : ''
    if (!hasText(description)) { res.status(400).json({ error: 'Description is required' }); return }
    data.description = description
  }
  if (req.body.mitigation !== undefined) {
    if (req.body.mitigation !== null && typeof req.body.mitigation !== 'string') {
      res.status(400).json({ error: 'Mitigation must be text' }); return
    }
    data.mitigation = typeof req.body.mitigation === 'string' ? req.body.mitigation.trim() : null
  }
  if (req.body.order !== undefined) {
    const order = parseOrder(req.body.order)
    if (order === undefined) { res.status(400).json({ error: 'Order must be a non-negative integer' }); return }
    data.order = order
  }
  if (Object.keys(data).length === 0) { res.status(400).json({ error: 'No changes supplied' }); return }

  const updated = await prisma.projectRisk.update({ where: { id: risk.id }, data })
  res.json(updated)
}))

router.delete('/:id', asyncHandler(async (req: AuthRequest, res: Response) => {
  const projectId = req.params.projectId as string
  const project = await ownedProject(projectId, req.userId!)
  if (!project) { res.status(404).json({ error: 'Project not found' }); return }

  const risk = await prisma.projectRisk.findFirst({ where: { id: req.params.id as string, projectId } })
  if (!risk) { res.status(404).json({ error: 'Risk not found' }); return }

  await prisma.projectRisk.delete({ where: { id: risk.id } })
  res.status(204).send()
}))

export default router
