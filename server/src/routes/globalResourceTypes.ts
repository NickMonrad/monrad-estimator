import { Router, Request, Response } from 'express'
import { prisma } from '../lib/prisma.js'
import { authenticate, AuthRequest } from '../middleware/auth.js'

const router = Router()

// GET /api/global-resource-types — no auth required
router.get('/', async (_req: Request, res: Response) => {
  const types = await prisma.globalResourceType.findMany({ orderBy: { name: 'asc' } })
  res.json(types)
})

// POST /api/global-resource-types — auth required
router.post('/', authenticate, async (req: AuthRequest, res: Response) => {
  const { name, category, description } = req.body
  if (!name || !category) { res.status(400).json({ error: 'name and category are required' }); return }
  const gt = await prisma.globalResourceType.create({ data: { name, category, description } })
  res.status(201).json(gt)
})

// PUT /api/global-resource-types/:id — auth required
router.put('/:id', authenticate, async (req: AuthRequest, res: Response) => {
  const { name, category, description } = req.body
  if (!name || !category) { res.status(400).json({ error: 'name and category are required' }); return }
  const existing = await prisma.globalResourceType.findFirst({ where: { id: req.params.id } })
  if (!existing) { res.status(404).json({ error: 'Not found' }); return }
  const gt = await prisma.globalResourceType.update({ where: { id: req.params.id }, data: { name, category, description } })
  res.json(gt)
})

// DELETE /api/global-resource-types/:id — auth required
router.delete('/:id', authenticate, async (req: AuthRequest, res: Response) => {
  const existing = await prisma.globalResourceType.findFirst({ where: { id: req.params.id } })
  if (!existing) { res.status(404).json({ error: 'Not found' }); return }
  if (existing.isDefault) { res.status(403).json({ error: 'Default types cannot be deleted' }); return }
  await prisma.globalResourceType.delete({ where: { id: req.params.id } })
  res.status(204).send()
})

export default router
