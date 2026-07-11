import { Router, Response } from 'express'
import { prisma } from '../lib/prisma.js'
import { asyncHandler } from '../lib/asyncHandler.js'
import { authenticate, AuthRequest } from '../middleware/auth.js'
import { ownedProject } from '../lib/ownership.js'
import { syncCapacityProfilesForProject } from '../lib/syncCapacityProfiles.js'
import { exitCapacityPlanRoleOnly } from '../lib/capacityPlanExit.js'
import { upsertRTProfileAndProjectLegacy, buildMissingRTProfilePayload } from '../lib/resourceTypeCapacityProfileWrites.js'
import { toLegacyAllocationPct } from '../lib/resolveRoleDefaultForMutation.js'
import { resolveRTPatchState, resolveRoleSchedulingState } from '../lib/resolveRTPatchState.js'

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
    where: { id: req.params.id as string, projectId: req.params.projectId as string },
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
  Object.keys(data).forEach(key => { if (data[key] === undefined) delete data[key] })
  // ── Build capacity payload with hasOwnProperty semantics ────────────
  const capacityPayload: Record<string, unknown> = {}
  if ('allocationMode' in req.body) { capacityPayload.allocationMode = allocationMode }
  if ('allocationPercent' in req.body) { capacityPayload.allocationPercent = allocationPercent }
  if ('allocationStartWeek' in req.body) { capacityPayload.allocationStartWeek = allocationStartWeek ?? null }
  if ('allocationEndWeek' in req.body) { capacityPayload.allocationEndWeek = allocationEndWeek ?? null }

  // Fill omitted capacity fields from existing record
  if (capacityPayload.allocationMode === undefined) { capacityPayload.allocationMode = existing.allocationMode }
  if (capacityPayload.allocationPercent === undefined) { capacityPayload.allocationPercent = existing.allocationPercent }
  if (capacityPayload.allocationStartWeek === undefined) { capacityPayload.allocationStartWeek = existing.allocationStartWeek }
  if (capacityPayload.allocationEndWeek === undefined) { capacityPayload.allocationEndWeek = existing.allocationEndWeek }

  // ── Shared sync-options builder (same ownership rules as PATCH) ─────
  const putSyncOptions = (explicitNRIds: Iterable<string>) => {
    const opts: Record<string, unknown> = {
      scopeResourceTypeId: req.params.id as string,
      preserveResourceTypeIds: [existing.id],
    }
    const ids = [...explicitNRIds]
    if (ids.length > 0) {
      opts.preserveNamedResourceIds = ids
    }
    return opts
  }

  const rt = await prisma.$transaction(async tx => {
    // ── Load authoritative state before any mutation ──────────────
    const state = await resolveRTPatchState(tx, existing.id, existing)
    const schedulingState = resolveRoleSchedulingState(state)
    const inheritedIds = new Set(state.classification.inheritedNRIds)
    const explicitIds = new Set(state.classification.explicitNRIds)

    const shouldExitCapacityPlan =
      schedulingState.isCapacityPlan &&
      allocationMode === undefined &&
      count !== undefined

    let updated


    if (shouldExitCapacityPlan) {
      // ── Ownership-aware CAPACITY_PLAN exit ──────────────────
      // 1. Write the manual role profile
      await upsertRTProfileAndProjectLegacy(
        tx, req.params.projectId as string, req.params.id as string,
        { allocationMode: 'TIMELINE', allocationPercent: 100, allocationStartWeek: null, allocationEndWeek: null },
      )
      // 2. Transition role-level compatibility fields only
      await exitCapacityPlanRoleOnly(existing.id, tx)
      // 3. Update ONLY inherited NRs (ID-scoped)
      if (inheritedIds.size > 0) {
        await tx.namedResource.updateMany({
          where: { id: { in: [...inheritedIds] } },
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
      // Explicit/custom/segmented/planned NRs are left untouched

      updated = await tx.resourceType.update({
        where: { id: req.params.id as string },
        data: { ...data, allocationMode: 'TIMELINE', allocationPercent: 100, allocationStartWeek: null, allocationEndWeek: null },
      })
    } else if (hasCapacityInput) {
      // ── Normal role-capacity PUT ─────────────────────────────
      // 1. Write the new role-owned profile first
      const projection = await upsertRTProfileAndProjectLegacy(
        tx, req.params.projectId as string, req.params.id as string,
        capacityPayload,
      )
      // 2. Update inherited NRs to the new projected role default
      if (inheritedIds.size > 0) {
        await tx.namedResource.updateMany({
          where: { id: { in: [...inheritedIds] } },
          data: {
            allocationMode: projection.allocationMode,
            allocationPercent: projection.allocationPercent ?? 100,
            allocationStartWeek: projection.allocationStartWeek,
            allocationEndWeek: projection.allocationEndWeek,
            allocationPct: toLegacyAllocationPct(projection.allocationPercent ?? 100),
            startWeek: projection.allocationStartWeek,
            endWeek: projection.allocationEndWeek,
          },
        })
      }
      // Explicit/custom/segmented/planned NRs are left untouched

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
    } else {
      // ── Non-capacity-only PUT ────────────────────────────────
      // Ensure a role profile exists (created from existing RT fields)
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
    }

    await clearWeeklyDemandCache(req.params.projectId as string, tx)
    await syncCapacityProfilesForProject(tx, req.params.projectId as string, putSyncOptions(explicitIds))
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

  const { updated, warnings } = await prisma.$transaction(async tx => {
    // ── Load authoritative state via shared helper ─────────────
    const state = await resolveRTPatchState(tx, rt.id, rt)

    const currentCount = state.namedResources.length
    const nextWarnings: string[] = []

    // CAPACITY_PLAN state from authoritative role profile first, legacy fallback
    const schedulingState = resolveRoleSchedulingState(state)
    const isCapacityPlan = schedulingState.isCapacityPlan
    const defaultAllocMode = isCapacityPlan ? 'TIMELINE' : state.roleDefault.allocationMode
    const defaultAllocPercent = isCapacityPlan ? 100 : state.roleDefault.allocationPercent
    const defaultAllocStartWeek = isCapacityPlan ? null : state.roleDefault.allocationStartWeek
    const defaultAllocEndWeek = isCapacityPlan ? null : state.roleDefault.allocationEndWeek
    const defaultAllocPct = toLegacyAllocationPct(defaultAllocPercent)

    const inheritedIds = new Set(state.classification.inheritedNRIds)
    const preserveIds = new Set(state.classification.explicitNRIds)

    // ── Shared sync-options builder ────────────────────────────
    const patchSyncOptions = (preserveNamedResourceIds: Iterable<string>) => {
      const opts: Record<string, unknown> = {
        scopeResourceTypeId: req.params.id as string,
        preserveResourceTypeIds: [rt.id],
      }
      const ids = [...preserveNamedResourceIds]
      if (ids.length > 0) {
        opts.preserveNamedResourceIds = ids
      }
      return opts
    }

    // ── CAPACITY_PLAN exit (before count logic) ────────────────
    if (isCapacityPlan) {
      // 1. Upsert the role-owned profile with manual-scheduling defaults
      await upsertRTProfileAndProjectLegacy(
        tx, req.params.projectId as string, rt.id,
        { allocationMode: 'TIMELINE', allocationPercent: 100, allocationStartWeek: null, allocationEndWeek: null },
      )

      // 2. Transition the role-level compatibility fields
      await exitCapacityPlanRoleOnly(rt.id, tx)

      // 3. Update only inherited NR compatibility fields to manual-scheduling defaults
      if (inheritedIds.size > 0) {
        await tx.namedResource.updateMany({
          where: { id: { in: [...inheritedIds] } },
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
      // Explicit, custom, segmented, planned NRs are left untouched
    }

    // ── Helper to create the full compatibility shape ───────────
    const buildInheritedNRCreateData = (name: string, nrCount: number) => ({
      name: `${name} ${nrCount}`,
      resourceTypeId: rt.id,
      allocationMode: defaultAllocMode,
      allocationPercent: defaultAllocPercent,
      allocationPct: defaultAllocPct,
      allocationStartWeek: defaultAllocStartWeek,
      allocationEndWeek: defaultAllocEndWeek,
      startWeek: defaultAllocStartWeek,
      endWeek: defaultAllocEndWeek,
    } as any)

    // ── Count increase ─────────────────────────────────────────
    if (count > currentCount) {
      const shouldCloneRoleProfileForNewNR =
        !isCapacityPlan &&
        state.roleDefault.source === 'PROFILE' &&
        state.roleProfileRows.length === 1 &&
        state.roleProfileRows[0].segments.length > 0

      for (let n = currentCount + 1; n <= count; n++) {
        const nr = await tx.namedResource.create({
          data: buildInheritedNRCreateData(rt.name, n),
        })

        // Multi-segment role profile: clone segments to new NR
        if (shouldCloneRoleProfileForNewNR) {
          const roleProfile = state.roleProfileRows[0]
          await tx.capacityProfile.create({
            data: {
              ownerKind: 'NAMED_PERSON' as any,
              projectId: req.params.projectId as string,
              // ← Blocker 4: NR-owned profile has resourceTypeId = null, not rt.id
              resourceTypeId: null,
              namedResourceId: nr.id,
              planningBasis: roleProfile.planningBasis as any,
              source: roleProfile.source as any,
              defaultPercent: roleProfile.defaultPercent,
              startWeek: roleProfile.startWeek,
              endWeek: roleProfile.endWeek,
              segments: {
                create: roleProfile.segments.map((seg: any) => ({
                  startWeek: seg.startWeek,
                  endWeek: seg.endWeek,
                  capacityPercent: seg.capacityPercent,
                  source: seg.source as any,
                })),
              },
            },
          })
          preserveIds.add(nr.id)
        }
      }

      const updatedRt = await tx.resourceType.update({ where: { id: rt.id }, data: { count } })
      await clearWeeklyDemandCache(req.params.projectId as string, tx)
      await syncCapacityProfilesForProject(tx, req.params.projectId as string, patchSyncOptions(preserveIds))
      return { updated: updatedRt, warnings: nextWarnings }
    }

    // ── Count reduction ────────────────────────────────────────
    if (count < currentCount) {
      const reversed = [...state.namedResources].reverse()
      let removed = 0
      const targetRemove = currentCount - count
      const deletedIds = new Set<string>()

      for (const nr of reversed) {
        if (removed >= targetRemove) break
        if (inheritedIds.has(nr.id)) {
          await tx.capacityProfile.deleteMany({ where: { namedResourceId: nr.id } })
          await tx.namedResource.delete({ where: { id: nr.id } })
          deletedIds.add(nr.id)
          removed++
        }
      }

      const actualCount = currentCount - removed
      const updatedRt = await tx.resourceType.update({ where: { id: rt.id }, data: { count: actualCount } })
      await clearWeeklyDemandCache(req.params.projectId as string, tx)

      // Warn ONLY if the target count could not be reached
      if (actualCount > count) {
        // Compute the actual number of protected resources remaining.
        // Classification tracks which NRs are explicit (custom/segmented/planned);
        // only inherited NRs are eligible for deletion, so explicit NRs survive.
        const remainingProtectedIds = state.classification.explicitNRIds.filter(
          (id: string) => !deletedIds.has(id),
        )
        const protectedCount = remainingProtectedIds.length
        nextWarnings.push(
          `Could not reduce resource count to ${count} because ${protectedCount} ` +
          `resource(s) have custom or protected capacity settings. Actual count remains ${actualCount}.`,
        )
      }

      await syncCapacityProfilesForProject(tx, req.params.projectId as string, patchSyncOptions(preserveIds))
      return { updated: updatedRt, warnings: nextWarnings }
    }

    // ── Same count ─────────────────────────────────────────────
    if (!isCapacityPlan) {
      return { updated: rt, warnings: [] }
    }

    const updatedRt = await tx.resourceType.update({ where: { id: rt.id }, data: { count } })
    await clearWeeklyDemandCache(req.params.projectId as string, tx)
    await syncCapacityProfilesForProject(tx, req.params.projectId as string, patchSyncOptions(preserveIds))
    return { updated: updatedRt, warnings: nextWarnings }
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
