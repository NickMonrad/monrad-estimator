import { Router, Response } from 'express'
import { prisma } from '../lib/prisma.js'
import { asyncHandler } from '../lib/asyncHandler.js'
import { authenticate, AuthRequest } from '../middleware/auth.js'
import { ownedProject } from '../lib/ownership.js'
import { exitCapacityPlanRoleOnly } from '../lib/capacityPlanExit.js'
import { upsertRTProfileAndProjectLegacy } from '../lib/resourceTypeCapacityProfileWrites.js'
import { toLegacyAllocationPct } from '../lib/resolveRoleDefaultForMutation.js'
import { resolveRTPatchState, resolveRoleSchedulingState } from '../lib/resolveRTPatchState.js'
import { applyRoleDefaultToInheritedNRs } from '../lib/capacityProfileReplaceService.js'
import { CapacityIntegrityError } from '../lib/capacityIntegrityError.js'
import { loadAndValidateOwnerProfile } from '../lib/ownerProfileLoader.js'

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
    const defaultNr = await tx.namedResource.create({
      data: { name: `${name} 1`, resourceTypeId: created.id },
    })
    await tx.resourceType.update({ where: { id: created.id }, data: { count: 1 } })

    // Create authoritative ROLE profile with availability-window default (matches TIMELINE/100 compat)
    await tx.capacityProfile.create({
      data: {
        ownerKind: 'ROLE',
        projectId: project.id,
        resourceTypeId: created.id,
        namedResourceId: null,
        planningBasis: 'AVAILABILITY_WINDOW',
        source: 'AVAILABILITY_WINDOW',
        defaultPercent: 100,
        startWeek: null,
        endWeek: null,
      },
    })

    // Create authoritative NAMED_PERSON profile for the default named resource
    await tx.capacityProfile.create({
      data: {
        ownerKind: 'NAMED_PERSON',
        projectId: project.id,
        resourceTypeId: null,
        namedResourceId: defaultNr.id,
        planningBasis: 'DEMAND_FOLLOWING',
        source: 'FIXED',
        defaultPercent: 100,
        startWeek: null,
        endWeek: null,
      },
    })

    await clearWeeklyDemandCache(project.id, tx)
    return created
  })
  res.status(201).json(rt)
}))

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

  const rt = await prisma.$transaction(async tx => {
    // ── Load authoritative ROLE profile first ─────────────────────
    const roleProfile = await loadAndValidateOwnerProfile({
      tx,
      projectId: req.params.projectId as string,
      ownerKind: 'ROLE',
      ownerId: req.params.id as string,
    })

    // Build capacity payload from profile-derived defaults (not from compatibility columns)
    const profileAllocMode = roleProfile.planningBasis === 'CAPACITY_PROFILE' ? 'TIMELINE' :
      roleProfile.planningBasis === 'DEMAND_FOLLOWING' ? 'EFFORT' :
      roleProfile.planningBasis === 'AVAILABILITY_WINDOW' ? 'TIMELINE' :
      roleProfile.planningBasis === 'WHOLE_PROJECT_ALLOCATION' ? 'FULL_PROJECT' :
      'EFFORT'
    const profileAllocPercent = roleProfile.planningBasis === 'CAPACITY_PROFILE' ? 100 : (roleProfile.defaultPercent ?? 100)
    const profileAllocStartWeek = roleProfile.planningBasis === 'CAPACITY_PROFILE' ? null : roleProfile.startWeek
    const profileAllocEndWeek = roleProfile.planningBasis === 'CAPACITY_PROFILE' ? null : roleProfile.endWeek

    const capacityPayload: Record<string, unknown> = {}
    if ('allocationMode' in req.body) { capacityPayload.allocationMode = allocationMode }
    else { capacityPayload.allocationMode = profileAllocMode }
    if ('allocationPercent' in req.body) { capacityPayload.allocationPercent = allocationPercent }
    else { capacityPayload.allocationPercent = profileAllocPercent }
    if ('allocationStartWeek' in req.body) { capacityPayload.allocationStartWeek = allocationStartWeek ?? null }
    else { capacityPayload.allocationStartWeek = profileAllocStartWeek }
    if ('allocationEndWeek' in req.body) { capacityPayload.allocationEndWeek = allocationEndWeek ?? null }
    else { capacityPayload.allocationEndWeek = profileAllocEndWeek }
    const state = await resolveRTPatchState(tx, existing.id, existing, req.params.projectId as string)
    const schedulingState = resolveRoleSchedulingState(state)
    const inheritedIds = new Set(state.classification.inheritedNRIds)

    const shouldExitCapacityPlan =
      schedulingState.isCapacityPlan &&
      allocationMode === undefined &&
      count !== undefined

    let updated

    if (shouldExitCapacityPlan) {
      // ── Ownership-aware CAPACITY_PLAN exit ──────────────────
      await upsertRTProfileAndProjectLegacy(
        tx, req.params.projectId as string, req.params.id as string,
        { allocationMode: 'TIMELINE', allocationPercent: 100, allocationStartWeek: null, allocationEndWeek: null },
      )
      await exitCapacityPlanRoleOnly(existing.id, tx)
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
      updated = await tx.resourceType.update({
        where: { id: req.params.id as string },
        data: { ...data, allocationMode: 'TIMELINE', allocationPercent: 100, allocationStartWeek: null, allocationEndWeek: null },
      })
    } else if (hasCapacityInput) {
      const projection = await upsertRTProfileAndProjectLegacy(
        tx, req.params.projectId as string, req.params.id as string,
        capacityPayload,
      )
      await applyRoleDefaultToInheritedNRs(tx, [...inheritedIds], projection)

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
      // Non-capacity-only PUT — profile was already validated by loader above
      updated = await tx.resourceType.update({
        where: { id: req.params.id as string },
        data,
      })
    }
    await clearWeeklyDemandCache(req.params.projectId as string, tx)
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
    const state = await resolveRTPatchState(tx, rt.id, rt, req.params.projectId as string)

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
    const roleProfileRows = state.roleProfileRows
    // ── CAPACITY_PLAN exit (before count logic) ────────────────
    if (isCapacityPlan) {
      // 1. Upsert the role-owned profile with manual-scheduling defaults
      await upsertRTProfileAndProjectLegacy(
        tx, req.params.projectId as string, rt.id,
        { allocationMode: 'TIMELINE', allocationPercent: 100, allocationStartWeek: null, allocationEndWeek: null },
      )

      // 2. Transition the role-level compatibility fields
      await exitCapacityPlanRoleOnly(rt.id, tx)

      // 3. Update inherited NR profiles and compatibility fields
      if (inheritedIds.size > 0) {
        for (const inhId of inheritedIds) {
          // Find the validated NR profile from state
          const inhProfile = state.nrProfileRows.find(
            (np: any) => np.namedResourceId === inhId,
          )
          if (inhProfile) {
            // Update profile to post-exit inherited state (preserve ID)
            await tx.capacityProfile.update({
              where: { id: inhProfile.id },
              data: {
                ownerKind: 'NAMED_PERSON',
                planningBasis: 'DEMAND_FOLLOWING' as any,
                source: 'FIXED' as any,
                defaultPercent: 100,
                endWeek: null,
              },
            })
            // Clear any planner segments from inherited profiles
            await tx.capacitySegment.deleteMany({
              where: { capacityProfileId: inhProfile.id },
            })
          }
        }
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
    }
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


    // ── Fail-closed: role profile must exist for count changes ──
    // Normal paths always have a valid role profile (created during RT creation,
    // maintained by PUT/PATCH capacity updates). If missing, the database has
    // invalid persisted state that must be repaired via backfill tooling.
    if (count !== currentCount && roleProfileRows.length === 0) {
      throw new CapacityIntegrityError(
        'Missing capacity profile for this resource type. ' +
        'Run the capacity profile backfill/repair workflow before retrying this operation.',
      )
    }
    // ── Count increase ─────────────────────────────────────────
    if (count > currentCount) {
      for (let n = currentCount + 1; n <= count; n++) {
        const nr = await tx.namedResource.create({
          data: buildInheritedNRCreateData(rt.name, n),
        })
        const roleProfile = roleProfileRows[0]
        // Always create a NAMED_PERSON profile for each new inherited NR
        // derived from the current role-level default profile state.
        if (roleProfile) {
          await tx.capacityProfile.create({
            data: {
              ownerKind: 'NAMED_PERSON' as any,
              projectId: req.params.projectId as string,
              resourceTypeId: null,
              namedResourceId: nr.id,
              planningBasis: roleProfile.planningBasis as any,
              source: roleProfile.source as any,
              defaultPercent: roleProfile.defaultPercent,
              startWeek: roleProfile.startWeek,
              endWeek: roleProfile.endWeek,
              segments: roleProfile.segments && roleProfile.segments.length > 0
                ? { create: roleProfile.segments.map((seg: any) => ({
                    startWeek: seg.startWeek,
                    endWeek: seg.endWeek,
                    capacityPercent: seg.capacityPercent,
                    source: seg.source as any,
                  })) }
                : undefined,
            },
          })
        }
      }

      const updatedRt = await tx.resourceType.update({ where: { id: rt.id }, data: { count } })
      await clearWeeklyDemandCache(req.params.projectId as string, tx)
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
          // Find the exact profile for this NR to delete by ID
          const nrProfile = state.nrProfileRows.find(
            (p: any) => p.namedResourceId === nr.id,
          )
          if (!nrProfile) {
            throw new CapacityIntegrityError(
              `Cannot delete named resource ${nr.id}: no validated capacity profile found. ` +
              'Run the capacity profile backfill/repair workflow before retrying this operation.',
            )
          }
          await tx.capacityProfile.delete({ where: { id: nrProfile.id } })
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

      return { updated: updatedRt, warnings: nextWarnings }
    }

    // ── Same count ─────────────────────────────────────────────
    if (!isCapacityPlan) {
      return { updated: rt, warnings: [] }
    }

    const updatedRt = await tx.resourceType.update({ where: { id: rt.id }, data: { count } })
    await clearWeeklyDemandCache(req.params.projectId as string, tx)
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
    }
    return deleted.count
  })
  if (count === 0) { res.status(404).json({ error: 'Resource type not found' }); return }

  res.json({ message: 'Deleted' })
}))

export default router
