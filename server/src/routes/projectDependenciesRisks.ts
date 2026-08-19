import { Router, Response } from 'express'
import { prisma } from '../lib/prisma.js'
import { asyncHandler } from '../lib/asyncHandler.js'
import { authenticate, AuthRequest } from '../middleware/auth.js'

const router = Router({ mergeParams: true })
router.use(authenticate)

async function ownedProject(projectId: string, userId: string) {
  return prisma.project.findFirst({ where: { id: projectId, ownerId: userId } })
}

function parseRequiredText(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null
  return value
}

function parseMitigation(value: unknown): string | null | undefined {
  if (value === null) return null
  if (typeof value !== 'string') return undefined
  return value.trim() ? value : null
}

function parseReorderItems(value: unknown): Array<{ id: string; order: number }> | null {
  if (!Array.isArray(value)) return null
  const items: Array<{ id: string; order: number }> = []
  const ids = new Set<string>()
  const orders = new Set<number>()

  for (const item of value) {
    if (!item || typeof item !== 'object' || !('id' in item) || !('order' in item)) return null
    const id = item.id
    const order = item.order
    if (typeof id !== 'string' || !id.trim() || !Number.isInteger(order) || order < 0) return null
    if (ids.has(id) || orders.has(order)) return null
    ids.add(id)
    orders.add(order)
    items.push({ id, order })
  }

  return items
}

async function reorderDependencies(projectId: string, items: Array<{ id: string; order: number }>) {
  const existing = await prisma.projectDependency.findMany({
    where: { projectId },
    select: { id: true },
  })
  if (existing.length !== items.length || existing.some(row => !items.some(item => item.id === row.id))) {
    return false
  }
  if (items.some(item => item.order >= existing.length)) return false

  await prisma.$transaction(items.map(({ id, order }) =>
    prisma.projectDependency.update({ where: { id }, data: { order } }),
  ))
  return true
}

async function reorderRisks(projectId: string, items: Array<{ id: string; order: number }>) {
  const existing = await prisma.projectRisk.findMany({
    where: { projectId },
    select: { id: true },
  })
  if (existing.length !== items.length || existing.some(row => !items.some(item => item.id === row.id))) {
    return false
  }
  if (items.some(item => item.order >= existing.length)) return false

  await prisma.$transaction(items.map(({ id, order }) =>
    prisma.projectRisk.update({ where: { id }, data: { order } }),
  ))
  return true
}

// GET /api/projects/:projectId/dependencies
router.get('/dependencies', asyncHandler(async (req: AuthRequest, res: Response) => {
  const projectId = req.params.projectId as string
  if (!await ownedProject(projectId, req.userId!)) {
    res.status(404).json({ error: 'Project not found' })
    return
  }

  const dependencies = await prisma.projectDependency.findMany({
    where: { projectId },
    orderBy: [{ order: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
  })
  res.json(dependencies)
}))

// POST /api/projects/:projectId/dependencies
router.post('/dependencies', asyncHandler(async (req: AuthRequest, res: Response) => {
  const projectId = req.params.projectId as string
  if (!await ownedProject(projectId, req.userId!)) {
    res.status(404).json({ error: 'Project not found' })
    return
  }

  const description = parseRequiredText(req.body.description)
  if (!description) {
    res.status(400).json({ error: 'description is required' })
    return
  }

  const order = await prisma.projectDependency.count({ where: { projectId } })
  const dependency = await prisma.projectDependency.create({ data: { projectId, description, order } })
  res.status(201).json(dependency)
}))

// PUT /api/projects/:projectId/dependencies/:dependencyId
router.put('/dependencies/:dependencyId', asyncHandler(async (req: AuthRequest, res: Response) => {
  const projectId = req.params.projectId as string
  if (!await ownedProject(projectId, req.userId!)) {
    res.status(404).json({ error: 'Project not found' })
    return
  }

  const dependency = await prisma.projectDependency.findFirst({
    where: { id: req.params.dependencyId as string, projectId },
  })
  if (!dependency) {
    res.status(404).json({ error: 'Dependency not found' })
    return
  }

  const data: { description?: string } = {}
  if (req.body.description !== undefined) {
    const description = parseRequiredText(req.body.description)
    if (!description) {
      res.status(400).json({ error: 'description is required' })
      return
    }
    data.description = description
  }

  const updated = await prisma.projectDependency.update({ where: { id: dependency.id }, data })
  res.json(updated)
}))

// DELETE /api/projects/:projectId/dependencies/:dependencyId
router.delete('/dependencies/:dependencyId', asyncHandler(async (req: AuthRequest, res: Response) => {
  const projectId = req.params.projectId as string
  if (!await ownedProject(projectId, req.userId!)) {
    res.status(404).json({ error: 'Project not found' })
    return
  }

  const dependency = await prisma.projectDependency.findFirst({
    where: { id: req.params.dependencyId as string, projectId },
  })
  if (!dependency) {
    res.status(404).json({ error: 'Dependency not found' })
    return
  }

  await prisma.projectDependency.delete({ where: { id: dependency.id } })
  res.json({ message: 'Deleted' })
}))

// PATCH /api/projects/:projectId/dependencies/reorder
router.patch('/dependencies/reorder', asyncHandler(async (req: AuthRequest, res: Response) => {
  const projectId = req.params.projectId as string
  if (!await ownedProject(projectId, req.userId!)) {
    res.status(404).json({ error: 'Project not found' })
    return
  }

  const items = parseReorderItems(req.body.items)
  if (!items) {
    res.status(400).json({ error: 'items must contain unique ids and non-negative integer orders' })
    return
  }
  if (!await reorderDependencies(projectId, items)) {
    res.status(400).json({ error: 'items must include every dependency exactly once' })
    return
  }
  res.json({ ok: true })
}))

// GET /api/projects/:projectId/risks
router.get('/risks', asyncHandler(async (req: AuthRequest, res: Response) => {
  const projectId = req.params.projectId as string
  if (!await ownedProject(projectId, req.userId!)) {
    res.status(404).json({ error: 'Project not found' })
    return
  }

  const risks = await prisma.projectRisk.findMany({
    where: { projectId },
    orderBy: [{ order: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
  })
  res.json(risks)
}))

// POST /api/projects/:projectId/risks
router.post('/risks', asyncHandler(async (req: AuthRequest, res: Response) => {
  const projectId = req.params.projectId as string
  if (!await ownedProject(projectId, req.userId!)) {
    res.status(404).json({ error: 'Project not found' })
    return
  }

  const description = parseRequiredText(req.body.description)
  if (!description) {
    res.status(400).json({ error: 'description is required' })
    return
  }

  const mitigation = parseMitigation(req.body.mitigation)
  if (req.body.mitigation !== undefined && mitigation === undefined) {
    res.status(400).json({ error: 'mitigation must be text or null' })
    return
  }

  const order = await prisma.projectRisk.count({ where: { projectId } })
  const risk = await prisma.projectRisk.create({ data: { projectId, description, mitigation: mitigation ?? null, order } })
  res.status(201).json(risk)
}))

// PUT /api/projects/:projectId/risks/:riskId
router.put('/risks/:riskId', asyncHandler(async (req: AuthRequest, res: Response) => {
  const projectId = req.params.projectId as string
  if (!await ownedProject(projectId, req.userId!)) {
    res.status(404).json({ error: 'Project not found' })
    return
  }

  const risk = await prisma.projectRisk.findFirst({ where: { id: req.params.riskId as string, projectId } })
  if (!risk) {
    res.status(404).json({ error: 'Risk not found' })
    return
  }

  const data: { description?: string; mitigation?: string | null } = {}
  if (req.body.description !== undefined) {
    const description = parseRequiredText(req.body.description)
    if (!description) {
      res.status(400).json({ error: 'description is required' })
      return
    }
    data.description = description
  }
  if (req.body.mitigation !== undefined) {
    const mitigation = parseMitigation(req.body.mitigation)
    if (mitigation === undefined) {
      res.status(400).json({ error: 'mitigation must be text or null' })
      return
    }
    data.mitigation = mitigation
  }

  const updated = await prisma.projectRisk.update({ where: { id: risk.id }, data })
  res.json(updated)
}))

// DELETE /api/projects/:projectId/risks/:riskId
router.delete('/risks/:riskId', asyncHandler(async (req: AuthRequest, res: Response) => {
  const projectId = req.params.projectId as string
  if (!await ownedProject(projectId, req.userId!)) {
    res.status(404).json({ error: 'Project not found' })
    return
  }

  const risk = await prisma.projectRisk.findFirst({ where: { id: req.params.riskId as string, projectId } })
  if (!risk) {
    res.status(404).json({ error: 'Risk not found' })
    return
  }

  await prisma.projectRisk.delete({ where: { id: risk.id } })
  res.json({ message: 'Deleted' })
}))

// PATCH /api/projects/:projectId/risks/reorder
router.patch('/risks/reorder', asyncHandler(async (req: AuthRequest, res: Response) => {
  const projectId = req.params.projectId as string
  if (!await ownedProject(projectId, req.userId!)) {
    res.status(404).json({ error: 'Project not found' })
    return
  }

  const items = parseReorderItems(req.body.items)
  if (!items) {
    res.status(400).json({ error: 'items must contain unique ids and non-negative integer orders' })
    return
  }
  if (!await reorderRisks(projectId, items)) {
    res.status(400).json({ error: 'items must include every risk exactly once' })
    return
  }
  res.json({ ok: true })
}))

export default router
