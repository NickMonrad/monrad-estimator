import { Router, Response } from 'express'
import { prisma } from '../lib/prisma.js'
import { authenticate, AuthRequest } from '../middleware/auth.js'
import { ownedProject } from '../lib/ownership.js'

const router = Router({ mergeParams: true })
router.use(authenticate)

// GET /projects/:projectId/resource-types
router.get('/', async (req: AuthRequest, res: Response) => {
  const project = await ownedProject(req.params.projectId as string, req.userId!)
  if (!project) { res.status(404).json({ error: 'Project not found' }); return }
  const types = await prisma.resourceType.findMany({
    where: { projectId: req.params.projectId as string },
    orderBy: [{ category: 'asc' }, { name: 'asc' }],
    include: {
      globalType: {
        select: { id: true, name: true, category: true, defaultHoursPerDay: true, defaultDayRate: true },
      },
      _count: { select: { tasks: true } },
    },
  })
  res.json(types)
})

// POST /projects/:projectId/resource-types
router.post('/', async (req: AuthRequest, res: Response) => {
  const project = await ownedProject(req.params.projectId as string, req.userId!)
  if (!project) { res.status(404).json({ error: 'Project not found' }); return }
  const { name, category, count, proposedName, hoursPerDay, dayRate } = req.body
  if (!name || !category) { res.status(400).json({ error: 'name and category are required' }); return }
  const rt = await prisma.resourceType.create({
    data: {
      name,
      category,
      count,
      proposedName,
      hoursPerDay,
      dayRate,
      projectId: req.params.projectId as string,
    },
  })
  // Auto-create a default named resource so the resource profile has a person ready to configure
  await prisma.namedResource.create({
    data: { name: `${name} 1`, resourceTypeId: rt.id },
  })
  await prisma.resourceType.update({ where: { id: rt.id }, data: { count: 1 } })
  res.status(201).json(rt)
})

// PUT /projects/:projectId/resource-types/:id
router.put('/:id', async (req: AuthRequest, res: Response) => {
  const project = await ownedProject(req.params.projectId as string, req.userId!)
  if (!project) { res.status(404).json({ error: 'Project not found' }); return }
  const { name, category, count, proposedName, hoursPerDay, dayRate, allocationMode, allocationPercent, allocationStartWeek, allocationEndWeek } = req.body

  // Validate new allocation fields
  if (allocationMode !== undefined && !['EFFORT', 'TIMELINE', 'FULL_PROJECT'].includes(allocationMode)) {
    res.status(400).json({ error: 'Invalid allocationMode' }); return
  }
  if (allocationPercent !== undefined && (allocationPercent < 1 || allocationPercent > 100)) {
    res.status(400).json({ error: 'allocationPercent must be 1–100' }); return
  }

  const data: Record<string, unknown> = { name, category, count, proposedName, hoursPerDay, dayRate }
  Object.keys(data).forEach(key => {
    if (data[key] === undefined) delete data[key]
  })
  if (allocationMode !== undefined) data.allocationMode = allocationMode
  if (allocationPercent !== undefined) data.allocationPercent = allocationPercent
  // Allow explicit null to clear overrides
  if ('allocationStartWeek' in req.body) data.allocationStartWeek = allocationStartWeek ?? null
  if ('allocationEndWeek' in req.body) data.allocationEndWeek = allocationEndWeek ?? null

  const rt = await prisma.resourceType.update({
    where: { id: req.params.id as string },
    data,
  })
  res.json(rt)
})

// PATCH /projects/:projectId/resource-types/:id — update count and sync named resources
router.patch('/:id', async (req: AuthRequest, res: Response) => {
  const project = await ownedProject(req.params.projectId as string, req.userId!)
  if (!project) { res.status(404).json({ error: 'Project not found' }); return }

  const { count } = req.body
  if (count === undefined || typeof count !== 'number' || count < 0) {
    res.status(400).json({ error: 'count must be a non-negative number' }); return
  }

  const rt = await prisma.resourceType.findFirst({ where: { id: req.params.id as string, projectId: req.params.projectId as string } })
  if (!rt) { res.status(404).json({ error: 'Resource type not found' }); return }

  const currentNRs = await prisma.namedResource.findMany({
    where: { resourceTypeId: rt.id },
    orderBy: { createdAt: 'asc' },
  })
  const currentCount = currentNRs.length
  const warnings: string[] = []

  if (count > currentCount) {
    // Add new anonymous named resources for each new slot
    for (let n = currentCount + 1; n <= count; n++) {
      await prisma.namedResource.create({
        data: { name: `${rt.name} ${n}`, resourceTypeId: rt.id, allocationPct: 100 },
      })
    }
  } else if (count < currentCount) {
    // Remove last N named resources (highest createdAt) if they have no custom settings
    const toConsider = [...currentNRs].reverse().slice(0, currentCount - count)
    let removed = 0
    for (const nr of toConsider) {
      if (nr.startWeek !== null || nr.endWeek !== null || nr.allocationPct !== 100) {
        warnings.push(`Skipped removal of "${nr.name}" — has custom settings`)
        continue
      }
      await prisma.namedResource.delete({ where: { id: nr.id } })
      removed++
    }
    // Recompute actual count after removals
    const actualCount = currentCount - removed
    await prisma.resourceType.update({ where: { id: rt.id }, data: { count: actualCount } })
    const updated = await prisma.resourceType.findUnique({ where: { id: rt.id } })
    res.json({ ...updated, warnings: warnings.length > 0 ? warnings : undefined })
    return
  }

  const updated = await prisma.resourceType.update({ where: { id: rt.id }, data: { count } })
  res.json({ ...updated, warnings: warnings.length > 0 ? warnings : undefined })
})

// DELETE /projects/:projectId/resource-types/:id
router.delete('/:id', async (req: AuthRequest, res: Response) => {
  const project = await ownedProject(req.params.projectId as string, req.userId!)
  if (!project) { res.status(404).json({ error: 'Project not found' }); return }
  await prisma.resourceType.delete({ where: { id: req.params.id as string } })
  res.json({ message: 'Deleted' })
})

export default router
