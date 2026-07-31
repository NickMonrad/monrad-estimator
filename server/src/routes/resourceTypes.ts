import { Router, Response } from 'express'
import { prisma } from '../lib/prisma.js'
import { asyncHandler } from '../lib/asyncHandler.js'
import { authenticate, AuthRequest } from '../middleware/auth.js'
import { ownedProject } from '../lib/ownership.js'
import { toLegacyAllocationPct } from '../lib/resolveRoleDefaultForMutation.js'
import { resolveRTPatchState } from '../lib/resolveRTPatchState.js'
import { CapacityIntegrityError } from '../lib/capacityIntegrityError.js'
import { loadAndValidateOwnerProfile } from '../lib/ownerProfileLoader.js'
import { projectCapacityProfileToLegacyAllocation } from '../lib/capacityProfileLegacyProjection.js'
import {
  rejectLegacyCapacityFields,
  isPlannerOwnedProfile,
  PlannerManagedIdentityError,
  isPlannerManagedIdentityError,
} from '../lib/legacyCapacityFieldGuard.js'

const clearWeeklyDemandCache = (projectId: string, tx?: any) =>
  (tx ?? prisma).project.update({
    where: { id: projectId },
    data: { weeklyDemandCache: {} },
  })

let rtPatchFailureSeam: (() => void) | null = null

/** Test-only transaction seam; production never installs a callback. */
export function __setRTPatchFailureSeam(callback: (() => void) | null): void {
  rtPatchFailureSeam = callback
}


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
  if (rejectLegacyCapacityFields(req.body, res)) return
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
        legacy: {
          allocationMode: 'TIMELINE',
          allocationPercent: 100,
          allocationPct: null,
          allocationStartWeek: null,
          allocationEndWeek: null,
          startWeek: null,
          endWeek: null,
        },
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
        legacy: {
          allocationMode: 'EFFORT',
          allocationPercent: 100,
          allocationPct: 100,
          allocationStartWeek: null,
          allocationEndWeek: null,
          startWeek: null,
          endWeek: null,
        },
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
  if (rejectLegacyCapacityFields(req.body, res)) return

  const { name, category, count, proposedName, hoursPerDay, dayRate } = req.body

  const existing = await prisma.resourceType.findFirst({
    where: { id: req.params.id as string, projectId: req.params.projectId as string },
  })
  if (!existing) { res.status(404).json({ error: 'Resource type not found' }); return }

  // Non-capacity metadata fields only
  const data: Record<string, unknown> = { name, category, count, proposedName, hoursPerDay, dayRate }
  Object.keys(data).forEach(key => { if (data[key] === undefined) delete data[key] })

  try {
    const rt = await prisma.$transaction(async tx => {
      // ── Validate the exact authoritative ROLE profile before any write ──
      const roleProfile = await loadAndValidateOwnerProfile({
        tx,
        projectId: req.params.projectId as string,
        ownerKind: 'ROLE',
        ownerId: req.params.id as string,
      })

      // Count is an identity operation — planner-owned roles must transfer first
      if (count !== undefined && isPlannerOwnedProfile(roleProfile)) {
        throw new PlannerManagedIdentityError(`Resource type "${existing.name}"`)
      }

      const updated = await tx.resourceType.update({
        where: { id: req.params.id as string },
        data,
      })
      await clearWeeklyDemandCache(req.params.projectId as string, tx)
      return updated
    })
    res.json(rt)
  } catch (error) {
    if (isPlannerManagedIdentityError(error)) {
      res.status(409).json({ error: error.message, code: error.code })
      return
    }
    throw error
  }
}))
// PATCH /projects/:projectId/resource-types/:id — update count and sync named resources
router.patch('/:id', asyncHandler(async (req: AuthRequest, res: Response) => {
  const project = await ownedProject(req.params.projectId as string, req.userId!)
  if (!project) { res.status(404).json({ error: 'Project not found' }); return }
  if (rejectLegacyCapacityFields(req.body, res)) return

  const { count } = req.body
  if (count === undefined || typeof count !== 'number' || count < 0) {
    res.status(400).json({ error: 'count must be a non-negative number' }); return
  }
  const rt = await prisma.resourceType.findFirst({ where: { id: req.params.id as string, projectId: req.params.projectId as string } })
  if (!rt) { res.status(404).json({ error: 'Resource type not found' }); return }

  try {
    const { updated, warnings } = await prisma.$transaction(async tx => {
      const state = await resolveRTPatchState(tx, rt.id, rt, req.params.projectId as string)

      const currentCount = state.namedResources.length
      const nextWarnings: string[] = []

      // ── Planner-owned guard — fail before any write ─────────────────
      // A non-capacity identity operation must never alter a role or
      // resources still owned by Squad Planner (source SQUAD_PLANNER).
      const roleProfile = state.roleProfileRows[0]
      if (
        isPlannerOwnedProfile(roleProfile) ||
        state.nrProfileRows.some(isPlannerOwnedProfile)
      ) {
        throw new PlannerManagedIdentityError(`Resource type "${rt.name}"`)
      }

      const inheritedIds = new Set(state.classification.inheritedNRIds)

      // ── Derive legacy compatibility shape from the validated ROLE profile ──
      const effLegacy = projectCapacityProfileToLegacyAllocation({
        planningBasis: roleProfile.planningBasis,
        defaultPercent: roleProfile.defaultPercent,
        startWeek: roleProfile.startWeek,
        endWeek: roleProfile.endWeek,
        segments: roleProfile.segments.map((s: any) => ({
          startWeek: s.startWeek,
          endWeek: s.endWeek,
          capacityPercent: s.capacityPercent,
          source: s.source,
        })),
        source: roleProfile.source,
      })
      if (!effLegacy) {
        throw new Error('Failed to project role profile to legacy values')
      }
      const effectiveLegacyMode = {
        allocationMode: effLegacy.allocationMode,
        allocationPercent: effLegacy.allocationPercent ?? 100,
        allocationStartWeek: effLegacy.allocationStartWeek,
        allocationEndWeek: effLegacy.allocationEndWeek,
      }
      const effectiveAllocPct = toLegacyAllocationPct(effLegacy.allocationPercent ?? 100)

      // ── Count increase ─────────────────────────────────────────
      if (count > currentCount) {
        for (let n = currentCount + 1; n <= count; n++) {
          const nr = await tx.namedResource.create({
            data: {
              name: `${rt.name} ${n}`,
              resourceTypeId: rt.id,
              allocationMode: effectiveLegacyMode.allocationMode,
              allocationPercent: effectiveLegacyMode.allocationPercent,
              allocationStartWeek: effectiveLegacyMode.allocationStartWeek,
              allocationEndWeek: effectiveLegacyMode.allocationEndWeek,
              allocationPct: effectiveAllocPct,
              startWeek: effectiveLegacyMode.allocationStartWeek,
              endWeek: effectiveLegacyMode.allocationEndWeek,
            } as any,
          })
          const segs = roleProfile.segments
          await tx.capacityProfile.create({
            data: {
              ownerKind: 'NAMED_PERSON' as any,
              projectId: req.params.projectId as string,
              resourceTypeId: null,
              namedResourceId: nr.id,
              planningBasis: roleProfile.planningBasis as any,
              // System-derived clones must stay deletable on later reduction:
              // a MANUAL role source marks user-edited profiles as protected.
              source: roleProfile.source === 'MANUAL' ? 'DERIVED' : (roleProfile.source as any),
              defaultPercent: roleProfile.defaultPercent,
              startWeek: roleProfile.startWeek,
              endWeek: roleProfile.endWeek,
              legacy: {},
              segments: segs && segs.length > 0
                ? { create: segs.map((seg: any) => ({
                    startWeek: seg.startWeek,
                    endWeek: seg.endWeek,
                    capacityPercent: seg.capacityPercent,
                    source: seg.source as any,
                  })) }
                : undefined,
            },
          })
        }

        const updatedRt = await tx.resourceType.update({ where: { id: rt.id }, data: { count } })
        await clearWeeklyDemandCache(req.params.projectId as string, tx)
        rtPatchFailureSeam?.()
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

      // ── Same count — nothing to change ────────────────────────
      return { updated: rt, warnings: [] }
    })

    res.json({ ...updated, warnings: warnings.length > 0 ? warnings : undefined })
  } catch (error) {
    if (isPlannerManagedIdentityError(error)) {
      res.status(409).json({ error: error.message, code: error.code })
      return
    }
    throw error
  }
}))

// DELETE /projects/:projectId/resource-types/:id
router.delete('/:id', asyncHandler(async (req: AuthRequest, res: Response) => {
  const project = await ownedProject(req.params.projectId as string, req.userId!)
  if (!project) { res.status(404).json({ error: 'Project not found' }); return }

  const rt = await prisma.resourceType.findFirst({
    where: { id: req.params.id as string, projectId: req.params.projectId as string },
  })
  if (!rt) { res.status(404).json({ error: 'Resource type not found' }); return }

  const count = await prisma.$transaction(async tx => {
    // ── Validate exact ROLE profile before deletion ─────────────
    await loadAndValidateOwnerProfile({
      tx,
      projectId: req.params.projectId as string,
      ownerKind: 'ROLE',
      ownerId: req.params.id as string,
    })

    // ── Load and validate every NamedResource profile ───────────
    const nrs = await tx.namedResource.findMany({
      where: { resourceTypeId: req.params.id as string },
    })

    for (const nr of nrs) {
      const nrProfiles = await tx.capacityProfile.findMany({
        where: { namedResourceId: nr.id, resourceTypeId: null, projectId: req.params.projectId as string },
      })

      if (nrProfiles.length === 0) {
        throw new CapacityIntegrityError(
          `Missing capacity profile for named resource ${nr.id}. ` +
          'Run the capacity profile backfill/repair workflow before retrying this operation.',
        )
      }
      if (nrProfiles.length > 1) {
        throw new CapacityIntegrityError(
          `Multiple capacity profiles exist for named resource ${nr.id}.`,
        )
      }

      const profileOwnerKind = nrProfiles[0].ownerKind as string
      if (profileOwnerKind !== 'NAMED_PERSON' && profileOwnerKind !== 'PLANNED_RESOURCE') {
        throw new CapacityIntegrityError(
          `Capacity profile ${nrProfiles[0].id} has invalid owner kind "${profileOwnerKind}".`,
        )
      }

      await loadAndValidateOwnerProfile({
        tx,
        projectId: req.params.projectId as string,
        ownerKind: profileOwnerKind,
        ownerId: nr.id,
      })
    }

    // ── All profiles validated — proceed with delete ──────────
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
