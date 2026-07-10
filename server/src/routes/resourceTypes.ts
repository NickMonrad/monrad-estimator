import { Router, Response } from 'express'
import { prisma } from '../lib/prisma.js'
import { asyncHandler } from '../lib/asyncHandler.js'
import { authenticate, AuthRequest } from '../middleware/auth.js'
import { ownedProject } from '../lib/ownership.js'
import { syncCapacityProfilesForProject } from '../lib/syncCapacityProfiles.js'
import { exitCapacityPlanForManualScheduling, exitCapacityPlanRoleOnly } from '../lib/capacityPlanExit.js'
import { upsertRTProfileAndProjectLegacy, buildMissingRTProfilePayload } from '../lib/resourceTypeCapacityProfileWrites.js'
import { classifyNRsForRoleUpdate } from '../lib/classifyNRsForRoleUpdate.js'
import type { NRToClassify, OldRoleDefault } from '../lib/classifyNRsForRoleUpdate.js'


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

  // Capture the old role default BEFORE any writes — classification compares
  // NR effective allocation against the pre-update role state.
  const oldRoleDefault: OldRoleDefault = {
    allocationMode: existing.allocationMode,
    allocationPercent: existing.allocationPercent,
    allocationStartWeek: existing.allocationStartWeek,
    allocationEndWeek: existing.allocationEndWeek,
  }

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
  // ── Build capacity payload with hasOwnProperty semantics ────────────
  const capacityPayload: Record<string, unknown> = {}
  if ('allocationMode' in req.body) {
    capacityPayload.allocationMode = allocationMode
  }
  if ('allocationPercent' in req.body) {
    capacityPayload.allocationPercent = allocationPercent
  }
  if ('allocationStartWeek' in req.body) {
    capacityPayload.allocationStartWeek = allocationStartWeek ?? null
  }
  if ('allocationEndWeek' in req.body) {
    capacityPayload.allocationEndWeek = allocationEndWeek ?? null
  }

  // Fill omitted capacity fields from existing record
  if (capacityPayload.allocationMode === undefined) {
    capacityPayload.allocationMode = existing.allocationMode
  }
  if (capacityPayload.allocationPercent === undefined) {
    capacityPayload.allocationPercent = existing.allocationPercent
  }
  if (capacityPayload.allocationStartWeek === undefined) {
    capacityPayload.allocationStartWeek = existing.allocationStartWeek
  }
  if (capacityPayload.allocationEndWeek === undefined) {
    capacityPayload.allocationEndWeek = existing.allocationEndWeek
  }

  const shouldExitCapacityPlan =
    existing.allocationMode === 'CAPACITY_PLAN' &&
    allocationMode === undefined &&
    count !== undefined


  const rt = await prisma.$transaction(async tx => {
    let updated
    let projection: any
    let preserveNRIds: string[]

    if (shouldExitCapacityPlan) {
      // 1. Read pre-exit NR state and profiles BEFORE any mutation
      const allNRs = await tx.namedResource.findMany({
        where: { resourceTypeId: req.params.id as string },
      })
      const nrProfileRows = await tx.capacityProfile.findMany({
        where: { namedResourceId: { in: allNRs.map((nr: any) => nr.id) } },
        include: { segments: true },
      })

      // 2. Classify using old role default (captured before transaction started)
      const { inheritedNRIds, explicitNRIds } = classifyNRsForRoleUpdate(
        allNRs as NRToClassify[],
        nrProfileRows,
        oldRoleDefault,
      )

      // 3. Create role profile (TIMELINE/100/null/null)
      const exitPayload = {
        allocationMode: 'TIMELINE',
        allocationPercent: 100,
        allocationStartWeek: null,
        allocationEndWeek: null,
      }
      projection = await upsertRTProfileAndProjectLegacy(
        tx, req.params.projectId as string, req.params.id as string,
        exitPayload,
      )

      // 4. Role-only exit — does NOT mutate named resources
      await exitCapacityPlanRoleOnly(existing.id, tx)

      // 5. Update RT legacy fields
      const exitData = {
        ...data,
        allocationMode: projection.allocationMode,
        allocationPercent: projection.allocationPercent ?? 100,
        allocationStartWeek: projection.allocationStartWeek,
        allocationEndWeek: projection.allocationEndWeek,
      }
      updated = await tx.resourceType.update({
        where: { id: req.params.id as string },
        data: exitData,
      })

      // 6. Update only inherited NRs (explicit/custom/planned NRs preserved)
      if (inheritedNRIds.length > 0) {
        await tx.namedResource.updateMany({
          where: { id: { in: inheritedNRIds } },
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
      preserveNRIds = explicitNRIds
    } else if (hasCapacityInput) {
      projection = await upsertRTProfileAndProjectLegacy(
        tx, req.params.projectId as string, req.params.id as string,
        capacityPayload,
      )
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

      // Classify NRs and separate inherited from explicit/custom
      const allNRs = await tx.namedResource.findMany({
        where: { resourceTypeId: req.params.id as string },
      })
      const nrProfileRows = await tx.capacityProfile.findMany({
        where: { namedResourceId: { in: allNRs.map((nr: any) => nr.id) } },
        include: { segments: true },
      })
      const { inheritedNRIds, explicitNRIds } = classifyNRsForRoleUpdate(
        allNRs as NRToClassify[],
        nrProfileRows,
        oldRoleDefault,
      )

      preserveNRIds = explicitNRIds

      // Update inherited NRs with the new role projection
      if (inheritedNRIds.length > 0) {
        await tx.namedResource.updateMany({
          where: { id: { in: inheritedNRIds } },
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
      const existingProfiles = await tx.capacityProfile.findMany({
        where: { resourceTypeId: req.params.id as string, namedResourceId: null, projectId: req.params.projectId as string },
        select: { id: true },
      })
      if (existingProfiles.length === 0) {
        await upsertRTProfileAndProjectLegacy(tx, req.params.projectId as string, req.params.id as string,
          buildMissingRTProfilePayload(existing))
      }
      updated = await tx.resourceType.update({
        where: { id: req.params.id as string },
        data,
      })
      // Non-capacity: preserve all NRs
      const allNRs = await tx.namedResource.findMany({
        where: { resourceTypeId: req.params.id as string },
        select: { id: true },
      })
      preserveNRIds = allNRs.map((nr: { id: string }) => nr.id)
    }


    await clearWeeklyDemandCache(req.params.projectId as string, tx)
    await syncCapacityProfilesForProject(tx, req.params.projectId as string, {
      preserveNamedResourceIds: preserveNRIds,
      preserveResourceTypeIds: [req.params.id as string],
    })

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
