import { Router, Response } from 'express'
import { prisma } from '../lib/prisma.js'
import { asyncHandler } from '../lib/asyncHandler.js'
import { authenticate, AuthRequest } from '../middleware/auth.js'
import { requireAdmin } from '../middleware/requireAdmin.js'

const router = Router()
router.use(authenticate)

// GET /api/rate-cards
router.get('/', asyncHandler(async (_req: AuthRequest, res: Response) => {
  const rateCards = await prisma.rateCard.findMany({
    orderBy: { name: 'asc' },
    include: {
      entries: {
        include: { globalResourceType: { select: { id: true, name: true, category: true } } },
      },
    },
  })
  res.json(rateCards)
}))

// GET /api/rate-cards/:id
router.get('/:id', asyncHandler(async (req: AuthRequest, res: Response) => {
  const rateCard = await prisma.rateCard.findUnique({
    where: { id: req.params.id as string },
    include: {
      entries: {
        include: { globalResourceType: { select: { id: true, name: true, category: true } } },
      },
    },
  })
  if (!rateCard) { res.status(404).json({ error: 'Rate card not found' }); return }
  res.json(rateCard)
}))

// POST /api/rate-cards
router.post('/', requireAdmin, asyncHandler(async (req: AuthRequest, res: Response) => {
  const { name, isDefault, entries } = req.body
  if (!name) { res.status(400).json({ error: 'name is required' }); return }
  if (!Array.isArray(entries) || entries.length === 0) {
    res.status(400).json({ error: 'entries array with at least one entry is required' }); return
  }

  const rateCard = await prisma.$transaction(async (tx) => {
    if (isDefault) {
      await tx.rateCard.updateMany({ where: { isDefault: true }, data: { isDefault: false } })
    }
    return tx.rateCard.create({
      data: {
        name,
        isDefault: isDefault ?? false,
        entries: {
          create: entries.map((e: { globalResourceTypeId: string; dayRate: number }) => ({
            globalResourceTypeId: e.globalResourceTypeId,
            dayRate: e.dayRate,
          })),
        },
      },
      include: {
        entries: {
          include: { globalResourceType: { select: { id: true, name: true, category: true } } },
        },
      },
    })
  })

  res.status(201).json(rateCard)
}))

// PUT /api/rate-cards/:id
router.put('/:id', requireAdmin, asyncHandler(async (req: AuthRequest, res: Response) => {
  const { name, isDefault, entries } = req.body

  const existing = await prisma.rateCard.findUnique({ where: { id: req.params.id as string } })
  if (!existing) { res.status(404).json({ error: 'Rate card not found' }); return }

  const rateCard = await prisma.$transaction(async (tx) => {
    if (isDefault) {
      await tx.rateCard.updateMany({ where: { isDefault: true }, data: { isDefault: false } })
    }

    // Delete existing entries and recreate
    await tx.rateCardEntry.deleteMany({ where: { rateCardId: req.params.id as string } })

    return tx.rateCard.update({
      where: { id: req.params.id as string },
      data: {
        name: name ?? existing.name,
        isDefault: isDefault ?? existing.isDefault,
        version: { increment: 1 },
        entries: {
          create: Array.isArray(entries)
            ? entries.map((e: { globalResourceTypeId: string; dayRate: number }) => ({
                globalResourceTypeId: e.globalResourceTypeId,
                dayRate: e.dayRate,
              }))
            : undefined,
        },
      },
      include: {
        entries: {
          include: { globalResourceType: { select: { id: true, name: true, category: true } } },
        },
      },
    })
  })

  res.json(rateCard)
}))

// DELETE /api/rate-cards/:id
router.delete('/:id', requireAdmin, asyncHandler(async (req: AuthRequest, res: Response) => {
  const existing = await prisma.rateCard.findUnique({ where: { id: req.params.id as string } })
  if (!existing) { res.status(404).json({ error: 'Rate card not found' }); return }
  await prisma.rateCard.delete({ where: { id: req.params.id as string } })
  res.status(204).send()
}))

export default router

// --- Apply rate card to project (project-scoped) ---

export const applyRateCardRouter = Router({ mergeParams: true })
applyRateCardRouter.use(authenticate)

async function ownedProject(projectId: string, userId: string) {
  return prisma.project.findFirst({ where: { id: projectId, ownerId: userId } })
}

// POST /api/projects/:projectId/apply-rate-card
applyRateCardRouter.post('/', async (req: AuthRequest, res: Response) => {
  const projectId = req.params.projectId as string
  const project = await ownedProject(projectId, req.userId!)
  if (!project) { res.status(404).json({ error: 'Project not found' }); return }

  const { rateCardId } = req.body
  if (!rateCardId) { res.status(400).json({ error: 'rateCardId is required' }); return }

  // Load rate card with entries
  const rateCard = await prisma.rateCard.findUnique({
    where: { id: rateCardId },
    include: {
      entries: {
        include: { globalResourceType: { select: { id: true, name: true } } },
      },
    },
  })
  if (!rateCard) { res.status(404).json({ error: 'Rate card not found' }); return }

  // Build lookup: globalResourceTypeId → dayRate
  const rateByGlobalTypeId = new Map(
    rateCard.entries.map(e => [e.globalResourceTypeId, e.dayRate]),
  )

  // Load project resource types
  const resourceTypes = await prisma.resourceType.findMany({
    where: { projectId },
    include: { globalType: { select: { id: true, name: true } } },
  })

  const details: Array<{ resourceTypeName: string; oldRate: number | null; newRate: number }> = []
  let skipped = 0

  for (const rt of resourceTypes) {
    if (!rt.globalTypeId || !rateByGlobalTypeId.has(rt.globalTypeId)) {
      skipped++
      continue
    }
    const newRate = rateByGlobalTypeId.get(rt.globalTypeId)!
    details.push({ resourceTypeName: rt.name, oldRate: rt.dayRate, newRate })
    await prisma.resourceType.update({
      where: { id: rt.id },
      data: { dayRate: newRate },
    })
  }

  res.json({ updated: details.length, skipped, details })
})
