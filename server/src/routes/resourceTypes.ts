import { Router, Response } from 'express'
import { prisma } from '../lib/prisma.js'
import { asyncHandler } from '../lib/asyncHandler.js'
import { authenticate, AuthRequest } from '../middleware/auth.js'
import { ownedProject } from '../lib/ownership.js'
import { syncCapacityProfilesForProject } from '../lib/syncCapacityProfiles.js'
import { exitCapacityPlanForManualScheduling } from '../lib/capacityPlanExit.js'
import { upsertRTProfileAndProjectLegacy, buildMissingRTProfilePayload } from '../lib/resourceTypeCapacityProfileWrites.js'


const clearWeeklyDemandCache = (projectId: string, tx?: any) =>
  (tx ?? prisma).project.update({
    where: { id: projectId },
    data: { weeklyDemandCache: {} },
  })

const router = Router({ mergeParams: true })
router.use(authenticate)

// GET /projects/:projectId/resource-types
router.get('/', asyncHandler(async (req: AuthRequest, res: Response) => {
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
}))

// POST /projects/:projectId/resource-types
router.post('/', asyncHandler(async (req: AuthRequest, res: Response) => {
  const project = await ownedProject(req.params.projectId as string, req.userId!)
  if (!project) { res.status(404).json({ error: 'Project not found' }); return }
  const { name, category, proposedName, hoursPerDay, dayRate } = req.body
  if (!name || !category) { res.status(400).json({ error: 'name and category are required' }); return }
  const rt = await prisma.$transaction(async tx => {
    const created = await tx.resourceType.create({
      data: {
        name,
        category,
        projectId: project.id,
        count: 0,
        proposedName,
        hoursPerDay,
        dayRate,
      },
    })
    // Auto-create a default named resource so the resource profile has a person ready to configure
    await tx.namedResource.create({
      data: { name: `${name} 1`, resourceTypeId: created.id },
    })
    await tx.resourceType.update({ where: { id: created.id }, data: { count: 1 } })
    await clearWeeklyDemandCache(project.id, tx)
    return created
  })
  res.status(201).json(rt)
}))

// PUT /projects/:projectId/resource-types/:id
router.put('/:id', asyncHandler(async (req: AuthRequest, res: Response) => {
  const project = await ownedProject(req.params.projectId as string, req.userId!)
  if (!project) { res.status(404).json({ error: 'Project not found' }); return }
  const { name, category, count, proposedName, hoursPerDay, dayRate, allocationMode, allocationPercent, allocationStartWeek, allocationEndWeek } = req.body

  const existing = await prisma.resourceType.findFirst({
    where: {
      id: req.params.id as string,
      projectId: req.params.projectId as string,
    },
  })
  if (!existing) { res.status(404).json({ error: 'Resource type not found' }); return }

  // Validate new allocation fields
  if (allocationMode !== undefined && !['EFFORT', 'TIMELINE', 'FULL_PROJECT'].includes(allocationMode)) {
    res.status(400).json({ error: 'Invalid allocationMode' }); return
  }
  if (allocationPercent !== undefined && (allocationPercent < 1 || allocationPercent > 100)) {
    res.status(400).json({ error: 'allocationPercent must be 1–100' }); return
  }

  // ── Detect whether capacity fields are being changed ────────────────
  const hasCapacityInput =
    allocationMode !== undefined ||
    allocationPercent !== undefined ||
    'allocationStartWeek' in req.body ||
    'allocationEndWeek' in req.body

  // Non-capacity-only fields
  const data: Record<string, unknown> = { name, category, count, proposedName, hoursPerDay, dayRate }
  Object.keys(data).forEach(key => {
    if (data[key] === undefined) delete data[key]
  })

  const shouldExitCapacityPlan =
    existing.allocationMode === 'CAPACITY_PLAN' &&
    allocationMode === undefined &&
    count !== undefined

  const rt = await prisma.$transaction(async tx => {
    let updated

    if (hasCapacityInput) {
      // Capacity fields provided — profile-first write + project back to legacy
      const projection = await upsertRTProfileAndProjectLegacy(tx, req.params.projectId as string, req.params.id as string, {
        allocationMode,
        allocationPercent,
        allocationStartWeek: 'allocationStartWeek' in req.body ? (allocationStartWeek ?? null) : undefined,
        allocationEndWeek: 'allocationEndWeek' in req.body ? (allocationEndWeek ?? null) : undefined,
      })

      // Write projected legacy fields + non-capacity fields
      updated = await tx.resourceType.update({
        where: { id: req.params.id as string },
        data: {
          ...data,
          allocationMode: projection.allocationMode,
          allocationPercent: projection.allocationPercent ?? 100,
          allocationStartWeek: projection.allocationStartWeek,
          allocationEndWeek: projection.allocationEndWeek,
        },
      })

      // Handle CAPACITY_PLAN exit if applicable (count change triggered it)
      if (shouldExitCapacityPlan) {
        await exitCapacityPlanForManualScheduling(existing.id, tx)
        // Update NRs that were in CAPACITY_PLAN mode
        await tx.namedResource.updateMany({
          where: { resourceTypeId: existing.id, allocationMode: 'CAPACITY_PLAN' },
          data: {
            allocationMode: projection.allocationMode,
            allocationPercent: projection.allocationPercent ?? 100,
            allocationStartWeek: projection.allocationStartWeek,
            allocationEndWeek: projection.allocationEndWeek,
            allocationPct: projection.allocationPercent ?? 100,
            startWeek: projection.allocationStartWeek,
            endWeek: projection.allocationEndWeek,
          },
        })
      }
    } else {
      // No capacity changes — preserve existing role-level profile if present.
      // Only create a profile if one does not already exist.
      const existingProfiles = await tx.capacityProfile.findMany({
        where: { resourceTypeId: req.params.id as string, namedResourceId: null, projectId: req.params.projectId as string },
        select: { id: true },
      })
      if (existingProfiles.length === 0) {
        // Create a profile from existing legacy fields
        // For TIMELINE mode, preserve existing window fields.
        // For non-window modes, suppress stale windows.
        await upsertRTProfileAndProjectLegacy(tx, req.params.projectId as string, req.params.id as string,
          buildMissingRTProfilePayload(existing))
      }

      // Update non-capacity fields only — legacy allocation fields stay unchanged
      updated = await tx.resourceType.update({
        where: { id: req.params.id as string },
        data,
      })

      if (shouldExitCapacityPlan) {
        data.allocationMode = 'TIMELINE'
        data.allocationPercent = 100
        data.allocationStartWeek = null
        data.allocationEndWeek = null
        await exitCapacityPlanForManualScheduling(existing.id, tx)
        updated = await tx.resourceType.update({ where: { id: req.params.id as string }, data })
        await tx.namedResource.updateMany({
          where: { resourceTypeId: existing.id, allocationMode: 'CAPACITY_PLAN' },
          data: {
            allocationMode: 'TIMELINE',
            allocationPercent: 100,
            allocationStartWeek: null,
            allocationEndWeek: null,
            allocationPct: 100,
            startWeek: null,
            endWeek: null,
          },
        })
      }
    }

    await clearWeeklyDemandCache(req.params.projectId as string, tx)
    await syncCapacityProfilesForProject(tx, req.params.projectId as string)

    return updated
  })
  res.json(rt)
}))

// PATCH /projects/:projectId/resource-types/:id — update count and sync named resources
router.patch('/:id', asyncHandler(async (req: AuthRequest, res: Response) => {
  const project = await ownedProject(req.params.projectId as string, req.userId!)
  if (!project) { res.status(404).json({ error: 'Project not found' }); return }

  const { count } = req.body
  if (count === undefined || typeof count !== 'number' || count < 0) {
    res.status(400).json({ error: 'count must be a non-negative number' }); return
  }

  const rt = await prisma.resourceType.findFirst({ where: { id: req.params.id as string, projectId: req.params.projectId as string } })
  if (!rt) { res.status(404).json({ error: 'Resource type not found' }); return }

  const defaultAllocationMode = rt.allocationMode === 'CAPACITY_PLAN' ? 'TIMELINE' : rt.allocationMode
  const defaultAllocationPercent = rt.allocationMode === 'CAPACITY_PLAN' ? 100 : (rt.allocationPercent ?? 100)
  const defaultAllocationStartWeek = rt.allocationMode === 'CAPACITY_PLAN' ? null : (rt.allocationStartWeek ?? null)
  const defaultAllocationEndWeek = rt.allocationMode === 'CAPACITY_PLAN' ? null : (rt.allocationEndWeek ?? null)

  const { updated, warnings } = await prisma.$transaction(async tx => {
    if (rt.allocationMode === 'CAPACITY_PLAN') {
      await exitCapacityPlanForManualScheduling(rt.id, tx)
    }

    const currentNRs = await tx.namedResource.findMany({
      where: { resourceTypeId: rt.id },
      orderBy: { createdAt: 'asc' },
    })
    const currentCount = currentNRs.length
    const nextWarnings: string[] = []

    let result: { updated: any; warnings: string[] }

    if (count > currentCount) {
      // Add new anonymous named resources for each new slot
      for (let n = currentCount + 1; n <= count; n++) {
        await tx.namedResource.create({
          data: {
            name: `${rt.name} ${n}`,
            resourceTypeId: rt.id,
            allocationPct: 100,
            ...(defaultAllocationMode !== 'EFFORT' && {
              allocationMode: defaultAllocationMode,
              allocationPercent: defaultAllocationPercent,
              allocationStartWeek: defaultAllocationStartWeek,
              allocationEndWeek: defaultAllocationEndWeek,
            }),
          },
        })
      }

      result = {
        updated: await tx.resourceType.update({ where: { id: rt.id }, data: { count } }),
        warnings: nextWarnings,
      }
    } else if (count < currentCount) {
      // Remove last N named resources (highest createdAt) if they have no custom settings
      const toConsider = [...currentNRs].reverse().slice(0, currentCount - count)
      let removed = 0
      for (const nr of toConsider) {
        if (nr.startWeek !== null || nr.endWeek !== null || nr.allocationPct !== 100) {
          nextWarnings.push(`Skipped removal of "${nr.name}" — has custom settings`)
          continue
        }
        await tx.namedResource.delete({ where: { id: nr.id } })
        removed++
      }

      const actualCount = currentCount - removed
      result = {
        updated: await tx.resourceType.update({ where: { id: rt.id }, data: { count: actualCount } }),
        warnings: nextWarnings,
      }
    } else {
      result = {
        updated: await tx.resourceType.update({ where: { id: rt.id }, data: { count } }),
        warnings: nextWarnings,
      }
    }

    await clearWeeklyDemandCache(req.params.projectId as string, tx)
    await syncCapacityProfilesForProject(tx, req.params.projectId as string)
    return result
  })
  res.json({ ...updated, warnings: warnings.length > 0 ? warnings : undefined })
}))

// DELETE /projects/:projectId/resource-types/:id
router.delete('/:id', asyncHandler(async (req: AuthRequest, res: Response) => {
  const project = await ownedProject(req.params.projectId as string, req.userId!)
  if (!project) { res.status(404).json({ error: 'Project not found' }); return }
  const count = await prisma.$transaction(async tx => {
    const deleted = await tx.resourceType.deleteMany({
      where: { id: req.params.id as string, projectId: req.params.projectId as string },
    })
    if (deleted.count > 0) {
      await clearWeeklyDemandCache(req.params.projectId as string, tx)
      await syncCapacityProfilesForProject(tx, req.params.projectId as string)
    }
    return deleted.count
  })
  if (count === 0) { res.status(404).json({ error: 'Resource type not found' }); return }

  res.json({ message: 'Deleted' })
}))

export default router
