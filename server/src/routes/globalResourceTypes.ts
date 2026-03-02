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

export default router
