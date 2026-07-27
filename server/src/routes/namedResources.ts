import { randomUUID } from 'crypto'
import { Router, Response } from 'express'
import { prisma } from '../lib/prisma.js'
import { asyncHandler } from '../lib/asyncHandler.js'
import { authenticate, AuthRequest } from '../middleware/auth.js'
import { upsertNRProfileAndProjectLegacy } from '../lib/namedResourceCapacityProfileWrites.js'
import type { NamedResourceCapacityPayload } from '../lib/namedResourceCapacityProfileWrites.js'
import type { PrismaTransactionClient } from '../lib/squadPlannerProfileWriter.js'
import { exitCapacityPlanForManualScheduling } from '../lib/capacityPlanExit.js'
import { CapacityIntegrityError } from '../lib/capacityIntegrityError.js'
import { loadAndValidateOwnerProfile } from '../lib/ownerProfileLoader.js'

const router = Router({ mergeParams: true })
router.use(authenticate)

async function ownedProject(projectId: string, userId: string) {
  return prisma.project.findFirst({ where: { id: projectId, ownerId: userId } })
}

/** Verify the resource type exists and belongs to the project */
async function verifyResourceType(rtId: string, projectId: string) {
  return prisma.resourceType.findFirst({ where: { id: rtId, projectId } })
}

const VALID_PRICING_MODELS = ['ACTUAL_DAYS', 'PRO_RATA']

/**
 * Typed error for protected-capacity rejection.
 * Caught by PUT/PATCH routes and mapped to HTTP 409.
 */
class ProfileManagedCapacityError extends Error {
  readonly code = 'PROFILE_MANAGED_CAPACITY'
  constructor(message: string) {
    super(message)
    this.name = 'ProfileManagedCapacityError'
  }
}

function isProfileManagedCapacityError(error: unknown): error is ProfileManagedCapacityError {
  return error instanceof ProfileManagedCapacityError
}

/**
 * Assert that a capacity-bearing update is safe for the existing profile.
 *
 * A named resource is protected from scalar capacity mutation when its
 * CapacityProfile has any of:
 * - one or more CapacitySegment rows (segmented profile)
 * - planningBasis = 'capacityProfile' (weekly-profile even without segments)
 * - ownerKind = 'PLANNED_RESOURCE' (managed by Squad Planner)
 *
 * Multiple conflicting profiles also fail closed — we cannot determine
 * which profile is authoritative, so scalar mutation is refused.
 *
 * Throws ProfileManagedCapacityError.
 */
async function assertCapacityNotProtected(
  tx: PrismaTransactionClient,
  namedResourceId: string,
  projectId: string,
): Promise<void> {
  const profiles = await tx.capacityProfile.findMany({
    where: { namedResourceId, projectId },
    include: { segments: { select: { id: true, startWeek: true, endWeek: true } } },
    orderBy: { createdAt: 'asc' },
  }) as Array<{ id: string; planningBasis: string | null; ownerKind: string | null; segments: Array<{ id: string }> }>

  if (profiles.length > 1) {
    throw new ProfileManagedCapacityError('This resource has a protected weekly capacity profile and cannot be updated through scalar capacity fields.')
  }

  const profile = profiles[0]
  if (!profile) return

  const hasSegments = profile.segments.length > 0
  const isProtectedPlanningBasis = profile.planningBasis === 'CAPACITY_PROFILE'
  const isPlannedResource = profile.ownerKind === 'PLANNED_RESOURCE'
  if (hasSegments || isProtectedPlanningBasis || isPlannedResource) {
    throw new ProfileManagedCapacityError('This resource has a protected weekly capacity profile and cannot be updated through scalar capacity fields.')
  }
}


const clearWeeklyDemandCache = (projectId: string, tx?: any) =>
  (tx ?? prisma).project.update({
    where: { id: projectId },
    data: { weeklyDemandCache: {} },
  })

// GET /projects/:projectId/resource-types/:rtId/named-resources
router.get('/', asyncHandler(async (req: AuthRequest, res: Response) => {
  const { projectId, rtId } = req.params as { projectId: string; rtId: string }
  const project = await ownedProject(projectId, req.userId!)
  if (!project) { res.status(404).json({ error: 'Project not found' }); return }

  const rt = await verifyResourceType(rtId, projectId)
  if (!rt) { res.status(404).json({ error: 'Resource type not found' }); return }

  const resources = await prisma.namedResource.findMany({
    where: { resourceTypeId: rtId },
    include: { resourceType: true },
    orderBy: { name: 'asc' },
  })
  res.json(resources)
}))

// POST /projects/:projectId/resource-types/:rtId/named-resources
router.post('/', asyncHandler(async (req: AuthRequest, res: Response) => {
  const { projectId, rtId } = req.params as { projectId: string; rtId: string }
  const project = await ownedProject(projectId, req.userId!)
  if (!project) { res.status(404).json({ error: 'Project not found' }); return }

  const rt = await verifyResourceType(rtId, projectId)
  if (!rt) { res.status(404).json({ error: 'Resource type not found' }); return }

  const { name: rawName, startWeek, endWeek, allocationPct, pricingModel } = req.body

  // Auto-generate a name if none provided or generic.
  //
  // Uniqueness strategy (Option A): random UUID suffix.
  //
  // The old approach used `count({ resourceTypeId }) + 1` which races when two
  // concurrent requests read the same count before either creates.
  //
  // A deterministic fix (Option B) would add a unique constraint on
  // (resourceTypeId, name) and retry on conflict, but that requires a schema
  // migration.  The random suffix eliminates the shared-counter race without
  // schema changes: each request independently generates a name using
  // randomUUID().slice(0, 8), which provides 2^32 ≈ 4 billion possible values.
  // Collision probability for two concurrent requests is ~1 in 4 billion.
  //
  // If collision risk becomes a practical concern, add a unique index on
  // (resourceTypeId, name) and wrap the create in a retry loop.
  let name = rawName as string | undefined
  if (!name || name === 'New person') {
    name = `${rt.name} ${randomUUID().slice(0, 8)}`
  }

  if (allocationPct !== undefined && (allocationPct < 0 || allocationPct > 100)) {
    res.status(400).json({ error: 'allocationPct must be between 0 and 100' }); return
  }

  if (pricingModel !== undefined && !VALID_PRICING_MODELS.includes(pricingModel)) {
    res.status(400).json({ error: `pricingModel must be one of: ${VALID_PRICING_MODELS.join(', ')}` }); return
  }

  const resource = await prisma.$transaction(async tx => {
    // ── Load authoritative role profile via validator ──────────────
    const roleProfile = await loadAndValidateOwnerProfile({
      tx,
      projectId,
      ownerKind: 'ROLE',
      ownerId: rtId,
    })

    const isCapacityPlan = roleProfile.planningBasis === 'CAPACITY_PROFILE'

    if (isCapacityPlan) {
      await exitCapacityPlanForManualScheduling(rt.id, tx)
      // Reload the post-exit role profile
      const postExitProfile = await loadAndValidateOwnerProfile({
        tx,
        projectId,
        ownerKind: 'ROLE',
        ownerId: rtId,
      })
      Object.assign(roleProfile, postExitProfile)
    }

    // Derive inherited defaults from the authoritative role profile
    const roleAllocationMode = isCapacityPlan ? 'TIMELINE' : (
      roleProfile.planningBasis === 'DEMAND_FOLLOWING' ? 'EFFORT' :
      roleProfile.planningBasis === 'AVAILABILITY_WINDOW' ? 'TIMELINE' :
      roleProfile.planningBasis === 'WHOLE_PROJECT_ALLOCATION' ? 'FULL_PROJECT' :
      'TIMELINE' as string
    )
    const roleAllocationPercent = isCapacityPlan ? 100 : (roleProfile.defaultPercent ?? 100)
    const roleAllocationStartWeek = isCapacityPlan ? null : roleProfile.startWeek
    const roleAllocationEndWeek = isCapacityPlan ? null : roleProfile.endWeek
    const inheritAllocation = roleAllocationMode !== 'EFFORT'

    // Create NR with non-capacity fields first
    const created = await tx.namedResource.create({
      data: {
        name,
        resourceTypeId: rtId,
        ...(startWeek !== undefined && { startWeek }),
        ...(endWeek !== undefined && { endWeek }),
        ...(pricingModel !== undefined && { pricingModel }),
      },
    })

    // Build capacity payload: explicit request fields win, fall back to inherited role defaults
    const hasPost = (k: string) => Object.prototype.hasOwnProperty.call(req.body, k)
    const capacityPayload: NamedResourceCapacityPayload = {
      allocationMode: hasPost('allocationMode') ? req.body.allocationMode : (inheritAllocation ? roleAllocationMode : undefined),
      allocationPercent: hasPost('allocationPercent')
        ? req.body.allocationPercent
        : hasPost('allocationPct')
          ? undefined
          : (inheritAllocation ? roleAllocationPercent : undefined),
      allocationPct: hasPost('allocationPct') ? req.body.allocationPct : undefined,
      allocationStartWeek: hasPost('allocationStartWeek')
        ? req.body.allocationStartWeek
        : hasPost('startWeek')
          ? undefined
          : (inheritAllocation ? roleAllocationStartWeek : undefined),
      allocationEndWeek: hasPost('allocationEndWeek')
        ? req.body.allocationEndWeek
        : hasPost('endWeek')
          ? undefined
          : (inheritAllocation ? roleAllocationEndWeek : undefined),
      startWeek: hasPost('startWeek') ? req.body.startWeek : undefined,
      endWeek: hasPost('endWeek') ? req.body.endWeek : undefined,
    }

    // Profile-first write + project back to legacy
    const projection = await upsertNRProfileAndProjectLegacy(tx, projectId, created.id, rtId, capacityPayload, { allowCreate: true })

    // Write projected legacy fields as compatibility
    const updated = await tx.namedResource.update({
      where: { id: created.id },
      data: {
        allocationMode: projection.allocationMode,
        allocationPercent: projection.allocationPercent ?? 100,
        allocationPct: projection.allocationPercent ?? 100,
        allocationStartWeek: projection.allocationStartWeek,
        allocationEndWeek: projection.allocationEndWeek,
        startWeek: projection.allocationStartWeek,
        endWeek: projection.allocationEndWeek,
      },
    })

    // Sync resource type count to match total named resources
    const total = await tx.namedResource.count({ where: { resourceTypeId: rtId } })
    await tx.resourceType.update({ where: { id: rtId }, data: { count: total } })

    return updated
  })
  res.status(201).json(resource)
}))



router.put('/:id', asyncHandler(async (req: AuthRequest, res: Response) => {
  const { projectId, rtId, id } = req.params as { projectId: string; rtId: string; id: string }
  const project = await ownedProject(projectId, req.userId!)
  if (!project) { res.status(404).json({ error: 'Project not found' }); return }

  const rt = await verifyResourceType(rtId, projectId)
  if (!rt) { res.status(404).json({ error: 'Resource type not found' }); return }

  // Verify the named resource belongs to this resource type
  const existing = await prisma.namedResource.findFirst({ where: { id, resourceTypeId: rtId } })
  if (!existing) { res.status(404).json({ error: 'Named resource not found' }); return }

  const { name, startWeek, endWeek, allocationPct, pricingModel, allocationMode, allocationPercent, allocationStartWeek, allocationEndWeek } = req.body

  if (allocationPct !== undefined && (allocationPct < 0 || allocationPct > 100)) {
    res.status(400).json({ error: 'allocationPct must be between 0 and 100' }); return
  }

  if (pricingModel !== undefined && !VALID_PRICING_MODELS.includes(pricingModel)) {
    res.status(400).json({ error: `pricingModel must be one of: ${VALID_PRICING_MODELS.join(', ')}` }); return
  }

  // Non-capacity fields written directly to NamedResource
  const nrData: Record<string, unknown> = { name, pricingModel }
  Object.keys(nrData).forEach(key => {
    if (nrData[key] === undefined) delete nrData[key]
  })

  const has = (k: string) => Object.prototype.hasOwnProperty.call(req.body, k)
  const hasCapacityInput =
    has('allocationMode') ||
    has('allocationPercent') ||
    has('allocationPct') ||
    has('allocationStartWeek') ||
    has('allocationEndWeek') ||
    has('startWeek') ||
    has('endWeek')

  /** Non-window allocation modes — when explicitly set, stale window fields must be suppressed. */
  const NON_WINDOW_MODES = new Set(['EFFORT', 'FULL_PROJECT', 'CAPACITY_PLAN'])
  const isExplicitNonWindow = has('allocationMode') && allocationMode !== undefined && allocationMode !== null && NON_WINDOW_MODES.has(allocationMode)

  const capacityPayload: NamedResourceCapacityPayload = {
    allocationMode: has('allocationMode')
      ? allocationMode
      : hasCapacityInput
        ? undefined          // let helper infer TIMELINE from startWeek/endWeek
        : existing.allocationMode,  // preserve existing mode

    allocationPercent: has('allocationPercent')
      ? allocationPercent
      : has('allocationPct')
        ? undefined
        : existing.allocationPercent,

    allocationPct: has('allocationPct') ? allocationPct : existing.allocationPct,

    // When allocationMode is explicitly a non-window mode (EFFORT, FULL_PROJECT, CAPACITY_PLAN),
    // suppress stale window fields regardless of what the NR previously had.
    // This prevents the projection from misinterpreting historical windows as TIMELINE intent.
    allocationStartWeek: isExplicitNonWindow
      ? null
      : has('allocationStartWeek')
        ? allocationStartWeek
        : has('startWeek')
          ? startWeek
          : existing.allocationStartWeek,

    allocationEndWeek: isExplicitNonWindow
      ? null
      : has('allocationEndWeek')
        ? allocationEndWeek
        : has('endWeek')
          ? endWeek
          : existing.allocationEndWeek,

    startWeek: has('startWeek')
      ? startWeek
      : has('allocationStartWeek')
        ? allocationStartWeek
        : existing.startWeek,

    endWeek: isExplicitNonWindow
      ? null
      : has('endWeek') ? endWeek : existing.endWeek,
  }
  try {
    const resource = await prisma.$transaction(async tx => {
      // Guard runs inside the transaction, before any write.
      // If the profile is protected, ProfileManagedCapacityError escapes the transaction.
      if (hasCapacityInput) {
        await assertCapacityNotProtected(tx, id, projectId)
      }

      // Write non-capacity fields first
      await tx.namedResource.update({ where: { id }, data: nrData })
      let updated
      if (hasCapacityInput) {
        // Capacity fields provided — profile-first write + project back to legacy
        const projection = await upsertNRProfileAndProjectLegacy(tx, projectId, id, rtId, capacityPayload)
        updated = await tx.namedResource.update({
          where: { id },
          data: {
            allocationMode: projection.allocationMode,
            allocationPercent: projection.allocationPercent ?? 100,
            allocationPct: projection.allocationPercent ?? 100,
            allocationStartWeek: projection.allocationStartWeek,
            allocationEndWeek: projection.allocationEndWeek,
            startWeek: projection.allocationStartWeek,
            endWeek: projection.allocationEndWeek,
          },
        })
      } else {
        // No capacity changes — profile must already exist
        const existingProfiles = await tx.capacityProfile.findMany({
          where: { namedResourceId: id, projectId },
          select: { id: true },
        })
        if (existingProfiles.length === 0) {
          throw new CapacityIntegrityError(
            'Missing capacity profile for this named resource. ' +
            'Run the capacity profile backfill/repair workflow before retrying this operation.',
          )
        }
        updated = await tx.namedResource.findFirst({ where: { id } })
        if (!updated) throw new Error('NamedResource not found after update')
      }
      await clearWeeklyDemandCache(projectId, tx)
      return updated
    })
    res.json(resource)
  } catch (error) {
    if (isProfileManagedCapacityError(error)) {
      res.status(409).json({
        error: error.message,
        code: 'PROFILE_MANAGED_CAPACITY',
      })
      return
    }
    throw error
  }
}))
// PATCH /projects/:projectId/resource-types/:rtId/named-resources/:id
router.patch('/:id', asyncHandler(async (req: AuthRequest, res: Response) => {
  const { projectId, rtId, id } = req.params as { projectId: string; rtId: string; id: string }
  const project = await ownedProject(projectId, req.userId!)
  if (!project) { res.status(404).json({ error: 'Project not found' }); return }

  const rt = await verifyResourceType(rtId, projectId)
  if (!rt) { res.status(404).json({ error: 'Resource type not found' }); return }

  const existing = await prisma.namedResource.findFirst({ where: { id, resourceTypeId: rtId } })
  if (!existing) { res.status(404).json({ error: 'Named resource not found' }); return }
  const { allocationMode, allocationPercent, allocationStartWeek, allocationEndWeek, startWeek, endWeek } = req.body

  const NON_WINDOW_MODES = new Set(['EFFORT', 'FULL_PROJECT', 'CAPACITY_PLAN'])
  const hasPatch = (k: string) => Object.prototype.hasOwnProperty.call(req.body, k)
  const isExplicitNonWindowPatch = hasPatch('allocationMode') && allocationMode !== undefined && allocationMode !== null && NON_WINDOW_MODES.has(allocationMode)

  const capacityPayload: NamedResourceCapacityPayload = {
    allocationMode: hasPatch('allocationMode') ? allocationMode : existing.allocationMode,

    allocationPercent: hasPatch('allocationPercent') ? allocationPercent : existing.allocationPercent,

    allocationPct: existing.allocationPct,

    // Non-window mode suppresses stale window fields
    allocationStartWeek: isExplicitNonWindowPatch
      ? null
      : hasPatch('allocationStartWeek')
        ? allocationStartWeek
        : hasPatch('startWeek')
          ? startWeek
          : existing.allocationStartWeek,

    allocationEndWeek: isExplicitNonWindowPatch
      ? null
      : hasPatch('allocationEndWeek')
        ? allocationEndWeek
        : hasPatch('endWeek')
          ? endWeek
          : existing.allocationEndWeek,

    startWeek: hasPatch('startWeek')
      ? startWeek
      : hasPatch('allocationStartWeek')
        ? allocationStartWeek
        : existing.startWeek,

    endWeek: hasPatch('endWeek') ? endWeek : existing.endWeek,
  }
  try {
    const resource = await prisma.$transaction(async tx => {
      // Guard runs inside transaction, before any write.
      // PATCH is always a capacity operation.
      await assertCapacityNotProtected(tx, id, projectId)

      // Profile-first write + project back to legacy
      const projection = await upsertNRProfileAndProjectLegacy(tx, projectId, id, rtId, capacityPayload)
      // Write projected legacy fields as compatibility
      const updated = await tx.namedResource.update({
        where: { id },
        data: {
          allocationMode: projection.allocationMode,
          allocationPercent: projection.allocationPercent ?? 100,
          allocationPct: projection.allocationPercent ?? 100,
          allocationStartWeek: projection.allocationStartWeek,
          allocationEndWeek: projection.allocationEndWeek,
          startWeek: projection.allocationStartWeek,
          endWeek: projection.allocationEndWeek,
        },
      })

      await clearWeeklyDemandCache(projectId, tx)
      return updated
    })
    res.json(resource)
  } catch (error) {
    if (isProfileManagedCapacityError(error)) {
      res.status(409).json({
        error: error.message,
        code: 'PROFILE_MANAGED_CAPACITY',
      })
      return
    }
    throw error
  }
}))

// DELETE /projects/:projectId/resource-types/:rtId/named-resources/:id
router.delete('/:id', asyncHandler(async (req: AuthRequest, res: Response) => {
  const { projectId, rtId, id } = req.params as { projectId: string; rtId: string; id: string }
  const project = await ownedProject(projectId, req.userId!)
  if (!project) { res.status(404).json({ error: 'Project not found' }); return }

  const rt = await verifyResourceType(rtId, projectId)
  if (!rt) { res.status(404).json({ error: 'Resource type not found' }); return }

  // Verify the named resource belongs to this resource type
  const existing = await prisma.namedResource.findFirst({ where: { id, resourceTypeId: rtId } })
  if (!existing) { res.status(404).json({ error: 'Named resource not found' }); return }

  await prisma.$transaction(async tx => {
    // ── Require exactly one valid ROLE profile ─────────────────────
    const roleProfile = await loadAndValidateOwnerProfile({
      tx,
      projectId,
      ownerKind: 'ROLE',
      ownerId: rtId,
    })

    const isCapacityPlan = roleProfile.planningBasis === 'CAPACITY_PROFILE'
    if (isCapacityPlan) {
      await exitCapacityPlanForManualScheduling(rt.id, tx)
    }

    await tx.namedResource.delete({ where: { id } })
    await clearWeeklyDemandCache(projectId, tx)

    // Sync resource type count (can reach 0 when all named resources are deleted)
    const total = await tx.namedResource.count({ where: { resourceTypeId: rtId } })
    await tx.resourceType.update({ where: { id: rtId }, data: { count: total } })
  })

  res.status(204).send()
}))

export default router
