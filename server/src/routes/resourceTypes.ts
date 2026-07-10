import { Router, Response } from 'express'
import { prisma } from '../lib/prisma.js'
import { asyncHandler } from '../lib/asyncHandler.js'
import { authenticate, AuthRequest } from '../middleware/auth.js'
import { AllocationMode } from '@prisma/client'
import { ownedProject } from '../lib/ownership.js'
import { syncCapacityProfilesForProject } from '../lib/syncCapacityProfiles.js'
import { exitCapacityPlanRoleOnly } from '../lib/capacityPlanExit.js'
import { upsertRTProfileAndProjectLegacy, buildMissingRTProfilePayload } from '../lib/resourceTypeCapacityProfileWrites.js'
import type { LegacyAllocationProjection } from '../lib/capacityProfileLegacyProjection.js'
import { loadAndClassifyRTState, toLegacyAllocationPct } from '../lib/classifyNRsForRoleUpdate.js'


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
    // Initialize allocation fields from the RT so the NR matches the role default for first PUT.
    await tx.namedResource.create({
      data: {
        name: `${name} 1`,
        resourceTypeId: created.id,
        allocationMode: created.allocationMode,
        allocationPct: toLegacyAllocationPct(created.allocationPercent) ?? 100,
        allocationPercent: created.allocationPercent ?? null,
        allocationStartWeek: created.allocationStartWeek ?? null,
        allocationEndWeek: created.allocationEndWeek ?? null,
        startWeek: created.allocationStartWeek ?? null,
        endWeek: created.allocationEndWeek ?? null,
      },
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
    let updated: Record<string, unknown>
    let projection: LegacyAllocationProjection | undefined
    let preserveNRIds: string[]

    if (shouldExitCapacityPlan) {
      // 1. Read pre-exit NR state and profiles BEFORE any mutation
      const state = await loadAndClassifyRTState(tx, req.params.id as string, existing)
      const { inheritedNRIds, explicitNRIds } = state.classification

      // 2. Create role profile (TIMELINE/100/null/null)
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

      // 3. Role-only exit — does NOT mutate named resources
      await exitCapacityPlanRoleOnly(existing.id, tx)

      // 4. Update RT legacy fields
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

      // 5. Update only inherited NRs (explicit/custom/planned NRs preserved)
      if (inheritedNRIds.length > 0) {
        await tx.namedResource.updateMany({
          where: { id: { in: inheritedNRIds } },
          data: {
            allocationMode: projection.allocationMode,
            allocationPercent: projection.allocationPercent ?? 100,
            allocationStartWeek: projection.allocationStartWeek,
            allocationEndWeek: projection.allocationEndWeek,
            allocationPct: toLegacyAllocationPct(projection.allocationPercent) ?? 100,
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

      // Classify NRs using pre-update role default
      const state = await loadAndClassifyRTState(tx, req.params.id as string, existing)
      const { inheritedNRIds, explicitNRIds } = state.classification

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
            allocationPct: toLegacyAllocationPct(projection.allocationPercent) ?? 100,
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
      scopeResourceTypeId: req.params.id as string,
    })

    return updated
  })
  res.json(rt)
}))

router.patch('/:id', asyncHandler(async (req: AuthRequest, res: Response) => {
  const project = await ownedProject(req.params.projectId as string, req.userId!)
  if (!project) { res.status(404).json({ error: 'Project not found' }); return }

  const { count } = req.body
  if (count === undefined || typeof count !== 'number' || count < 0) {
    res.status(400).json({ error: 'count must be a non-negative number' }); return
  }

  const existing = await prisma.resourceType.findFirst({ where: { id: req.params.id as string, projectId: req.params.projectId as string } })
  if (!existing) { res.status(404).json({ error: 'Resource type not found' }); return }

  const isCapacityPlan = existing.allocationMode === 'CAPACITY_PLAN'

  const { updated, warnings } = await prisma.$transaction(async tx => {
    // Load + classify ONCE before any mutations
    const state = await loadAndClassifyRTState(tx, existing.id, existing)
    const { inheritedNRIds, explicitNRIds } = state.classification

    // ── Determine role defaults after possible CAPACITY_PLAN exit ──────
    let roleMode: AllocationMode | 'EFFORT'
    let rolePercent: number
    let roleStartWeek: number | null
    let roleEndWeek: number | null
    if (isCapacityPlan) {
      // 1. Create TIMELINE/100/null/null role profile
      const exitPayload = {
        allocationMode: 'TIMELINE',
        allocationPercent: 100,
        allocationStartWeek: null,
        allocationEndWeek: null,
      }
      const exitProjection = await upsertRTProfileAndProjectLegacy(
        tx, req.params.projectId as string, existing.id, exitPayload,
      )

      roleMode = exitProjection.allocationMode as unknown as AllocationMode
      rolePercent = exitProjection.allocationPercent ?? 100
      roleStartWeek = exitProjection.allocationStartWeek
      roleEndWeek = exitProjection.allocationEndWeek

      // 2. Role-only exit — does NOT mutate named resources directly
      await exitCapacityPlanRoleOnly(existing.id, tx)

      // 3. Update ONLY inherited NRs with new role defaults
      if (inheritedNRIds.length > 0) {
        await tx.namedResource.updateMany({
          where: { id: { in: inheritedNRIds } },
          data: {
            allocationMode: roleMode,
            allocationPercent: rolePercent,
            allocationStartWeek: roleStartWeek,
            allocationEndWeek: roleEndWeek,
            allocationPct: toLegacyAllocationPct(rolePercent) ?? 100,
            startWeek: roleStartWeek,
            endWeek: roleEndWeek,
          },
        })
      }
    } else {
      roleMode = (existing.allocationMode ?? 'EFFORT') as AllocationMode
      rolePercent = existing.allocationPercent ?? 100
      roleStartWeek = existing.allocationStartWeek ?? null
      roleEndWeek = existing.allocationEndWeek ?? null
    }

    const currentNRs = state.allNRs
    const currentCount = currentNRs.length
    const nextWarnings: string[] = []
    let result!: { updated: Record<string, unknown>; warnings: string[] }

    if (count > currentCount) {
      // Increase: create new NRs with current role defaults
      for (let n = currentCount + 1; n <= count; n++) {
        await tx.namedResource.create({
          data: {
            name: `${existing.name} ${n}`,
            resourceTypeId: existing.id,
            allocationMode: roleMode,
            allocationPercent: rolePercent,
            allocationPct: toLegacyAllocationPct(rolePercent) ?? 100,
            allocationStartWeek: roleStartWeek,
            allocationEndWeek: roleEndWeek,
            startWeek: roleStartWeek,
            endWeek: roleEndWeek,
          },
        })
      }


      result = {
        updated: await tx.resourceType.update({ where: { id: existing.id }, data: { count } }),
        warnings: nextWarnings,
      }
    } else if (count < currentCount) {
      // Reduction: remove only inherited NRs (newest first), warn for protected
      const sortedNRs = [...currentNRs].reverse()
      let removed = 0
      const needToRemove = currentCount - count
      for (const nr of sortedNRs) {
        if (removed >= needToRemove) break
        if (!inheritedNRIds.includes(nr.id)) {
          // Protected candidate — warn and skip
          nextWarnings.push(`Skipped removal of "${nr.name}" — is an explicit/custom resource`)
          continue
        }
        await tx.namedResource.delete({ where: { id: nr.id } })
        removed++
      }

      const actual = currentCount - removed
      result = {
        updated: await tx.resourceType.update({ where: { id: existing.id }, data: { count: actual } }),
        warnings: nextWarnings,
      }
    } else if (isCapacityPlan) {
      // CAPACITY_PLAN with same count: exit already applied, still need sync
      result = {
        updated: await tx.resourceType.update({
          where: { id: existing.id },
          data: { count },
        }),
        warnings: nextWarnings,
      }
    } else {
      // Same count, not CAPACITY_PLAN — no profile/cache/sync work needed
      return { updated: existing, warnings: [] }
    }

    // ── Mutations or CAPACITY_PLAN exit occurred: clear cache + sync ──
    await clearWeeklyDemandCache(req.params.projectId as string, tx)

    // Build preserve list: all classified explicit NRs that still exist
    const preserveNRIds = explicitNRIds.filter((id: string) =>
      currentNRs.some(nr => nr.id === id),
    )
    await syncCapacityProfilesForProject(tx, req.params.projectId as string, {
      preserveNamedResourceIds: preserveNRIds,
      preserveResourceTypeIds: [existing.id],
      scopeResourceTypeId: existing.id,
    })

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
