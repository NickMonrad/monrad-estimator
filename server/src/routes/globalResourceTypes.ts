import { Router, Response } from 'express'
import { prisma } from '../lib/prisma.js'
import { asyncHandler } from '../lib/asyncHandler.js'
import { authenticate, AuthRequest } from '../middleware/auth.js'
import { requireAdmin } from '../middleware/requireAdmin.js'

const router = Router()

// GET /api/global-resource-types — auth required
router.get('/', authenticate, asyncHandler(async (_req: AuthRequest, res: Response) => {
  const types = await prisma.globalResourceType.findMany({ orderBy: { name: 'asc' } })
  res.json(types)
}))

// POST /api/global-resource-types — auth required
// After creating, seeds a ResourceType instance into every existing project.
//
// Each seeded role also receives its authoritative ROLE capacity profile, in
// one transaction: profile-first planning fails closed when a role has no
// profile, so a bare ResourceType row would make every existing project
// unreadable on the Timeline/Resource Profile endpoints. The seeded profile
// reproduces the strict mapper shape used by project creation and CSV import.
router.post('/', authenticate, requireAdmin, asyncHandler(async (req: AuthRequest, res: Response) => {
  const { name, category, description, defaultHoursPerDay, defaultDayRate } = req.body
  if (!name || !category) { res.status(400).json({ error: 'name and category are required' }); return }
  const gt = await prisma.globalResourceType.create({
    data: { name, category, description, defaultHoursPerDay, defaultDayRate },
  })
  const projects = await prisma.project.findMany({ select: { id: true } })
  if (projects.length > 0) {
    await prisma.$transaction(async tx => {
      for (const project of projects) {
        await tx.resourceType.create({
          data: {
            name,
            category,
            projectId: project.id,
            globalTypeId: gt.id,
            hoursPerDay: gt.defaultHoursPerDay ?? null,
            dayRate: gt.defaultDayRate ?? null,
            capacityProfiles: {
              create: {
                projectId: project.id,
                ownerKind: 'ROLE',
                planningBasis: 'AVAILABILITY_WINDOW',
                source: 'AVAILABILITY_WINDOW',
                defaultPercent: 100,
                startWeek: null,
                endWeek: null,
                provenance: 'LEGACY_MAPPER',
              },
            },
          },
        })
      }
    })
  }
  res.status(201).json(gt)
}))

// PUT /api/global-resource-types/:id — auth required
// Syncs name + category changes to all linked project-level ResourceType instances
router.put('/:id', authenticate, requireAdmin, asyncHandler(async (req: AuthRequest, res: Response) => {
  const { name, category, description, defaultHoursPerDay, defaultDayRate } = req.body
  if (!name || !category) { res.status(400).json({ error: 'name and category are required' }); return }
  const existing = await prisma.globalResourceType.findFirst({ where: { id: req.params.id as string } })
  if (!existing) { res.status(404).json({ error: 'Not found' }); return }
  const gt = await prisma.globalResourceType.update({
    where: { id: req.params.id as string },
    data: { name, category, description, defaultHoursPerDay, defaultDayRate },
  })
  await prisma.resourceType.updateMany({ where: { globalTypeId: req.params.id as string }, data: { name, category } })
  res.json(gt)
}))

// DELETE /api/global-resource-types/:id — auth required
// Blocks deletion if any linked ResourceType has tasks assigned to it
router.delete('/:id', authenticate, requireAdmin, asyncHandler(async (req: AuthRequest, res: Response) => {
  const existing = await prisma.globalResourceType.findFirst({ where: { id: req.params.id as string } })
  if (!existing) { res.status(404).json({ error: 'Not found' }); return }
  if (existing.isDefault) { res.status(403).json({ error: 'Default types cannot be deleted' }); return }
  const inUse = await prisma.task.findFirst({
    where: { resourceType: { globalTypeId: req.params.id as string } }
  })
  if (inUse) { res.status(409).json({ error: 'This resource type is in use by one or more tasks and cannot be deleted' }); return }
  // Nullify globalTypeId on linked ResourceTypes before deleting
  await prisma.resourceType.updateMany({ where: { globalTypeId: req.params.id as string }, data: { globalTypeId: null } })
  await prisma.globalResourceType.delete({ where: { id: req.params.id as string } })
  res.status(204).send()
}))

export default router
