import { randomUUID } from 'crypto'
import { Router, Response } from 'express'
import { prisma } from '../lib/prisma.js'
import { asyncHandler } from '../lib/asyncHandler.js'
import { authenticate, AuthRequest } from '../middleware/auth.js'
import { upsertNRProfileAndProjectLegacy, mapScalarModeToProfile } from '../lib/namedResourceCapacityProfileWrites.js'
import type { NamedResourceCapacityPayload } from '../lib/namedResourceCapacityProfileWrites.js'
import { exitCapacityPlanForManualScheduling } from '../lib/capacityPlanExit.js'
import { CapacityIntegrityError } from '../lib/capacityIntegrityError.js'
import { loadAndValidateOwnerProfile } from '../lib/ownerProfileLoader.js'
import { toLegacyAllocationPct } from '../lib/resolveRoleDefaultForMutation.js'
import { projectCapacityProfileToLegacyAllocation } from '../lib/capacityProfileLegacyProjection.js'
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

  const existing = await prisma.namedResource.findFirst({ where: { id, resourceTypeId: rtId } })
  if (!existing) { res.status(404).json({ error: 'Named resource not found' }); return }

  const { name, startWeek, endWeek, allocationPct, pricingModel, allocationMode, allocationPercent, allocationStartWeek, allocationEndWeek } = req.body

  const has = (k: string) => Object.prototype.hasOwnProperty.call(req.body, k)

  // ── Percentage validation ─────────────────────────────────────────────
  function isValidPercent(v: unknown): v is number {
    return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100
  }
  function isExplicitNull(v: unknown): v is null {
    return v === null
  }

  if (has('allocationPercent')) {
    if (isExplicitNull(allocationPercent)) {
      res.status(400).json({ error: 'allocationPercent must not be null.' }); return
    }
    if (!isValidPercent(allocationPercent)) {
      res.status(400).json({ error: 'allocationPercent must be a finite number between 0 and 100.' }); return
    }
  }
  if (has('allocationPct')) {
    if (isExplicitNull(allocationPct)) {
      res.status(400).json({ error: 'allocationPct must not be null.' }); return
    }
    if (!isValidPercent(allocationPct)) {
      res.status(400).json({ error: 'allocationPct must be a finite number between 0 and 100.' }); return
    }
  }
  if (has('allocationPercent') && has('allocationPct') && allocationPct !== allocationPercent) {
    res.status(400).json({ error: 'allocationPercent and allocationPct must represent the same value.' }); return
  }
  // ── Pricing-model validation ───────────────────────────────────────────
  if (has('pricingModel') && pricingModel !== undefined && pricingModel !== null && !VALID_PRICING_MODELS.includes(pricingModel as string)) {
    res.status(400).json({ error: `pricingModel must be one of: ${VALID_PRICING_MODELS.join(', ')}` }); return
  }
  if (has('allocationMode') && allocationMode !== undefined && allocationMode !== null && !['EFFORT', 'TIMELINE', 'FULL_PROJECT'].includes(allocationMode as string)) {
    res.status(400).json({ error: `Invalid allocationMode "${allocationMode}". Supported modes: EFFORT, TIMELINE, FULL_PROJECT.` })
    return
  }

  // Non-capacity fields written directly to NamedResource
  const nrData: Record<string, unknown> = { name, pricingModel }
  Object.keys(nrData).forEach(key => {
    if (nrData[key] === undefined) delete nrData[key]
  })

  const hasCapacityInput =
    has('allocationMode') ||
    has('allocationPercent') ||
    has('allocationPct') ||
    has('allocationStartWeek') ||
    has('allocationEndWeek') ||
    has('startWeek') ||
    has('endWeek')

  try {
    const resource = await prisma.$transaction(async tx => {
      // ── 1. Validate the exact authoritative profile ───────────────
      const nrProfile = await loadAndValidateOwnerProfile({
        tx,
        projectId,
        ownerKind: 'NAMED_PERSON',
        ownerId: id,
      })

      if (hasCapacityInput) {
        // ── 2. Reject protected profiles ──────────────────────────
        const hasSegments = nrProfile.segments.length > 0
        const isProtectedPlanningBasis = nrProfile.planningBasis === 'CAPACITY_PROFILE'
        if (hasSegments || isProtectedPlanningBasis) {
          throw new ProfileManagedCapacityError(
            'This resource has a protected weekly capacity profile and cannot be updated through scalar capacity fields.',
          )
        }

        // ── 3. Derive defaults from the validated profile ─────────
        const profileAllocMode = nrProfile.planningBasis === 'CAPACITY_PROFILE' ? 'TIMELINE' :
          nrProfile.planningBasis === 'DEMAND_FOLLOWING' ? 'EFFORT' :
          nrProfile.planningBasis === 'AVAILABILITY_WINDOW' ? 'TIMELINE' :
          nrProfile.planningBasis === 'WHOLE_PROJECT_ALLOCATION' ? 'FULL_PROJECT' :
          'EFFORT'
        const profileAllocPercent = nrProfile.planningBasis === 'CAPACITY_PROFILE' ? 100 : (nrProfile.defaultPercent ?? 100)
        const profileAllocStartWeek = nrProfile.planningBasis === 'CAPACITY_PROFILE' ? null : nrProfile.startWeek
        const profileAllocEndWeek = nrProfile.planningBasis === 'CAPACITY_PROFILE' ? null : nrProfile.endWeek

        // ── 4. Apply only explicitly supplied request fields ──────
        const mode = has('allocationMode') ? allocationMode : profileAllocMode
        const percent = has('allocationPercent') ? allocationPercent : (has('allocationPct') ? allocationPct : profileAllocPercent)
        const nrStartWeek = has('startWeek') ? startWeek : (has('allocationStartWeek') ? allocationStartWeek : profileAllocStartWeek)
        const nrEndWeek = has('endWeek') ? endWeek : (has('allocationEndWeek') ? allocationEndWeek : profileAllocEndWeek)

        // ── 5. Determine authoritative profile basis from mode ────
        const { planningBasis, source, isNonWindow } = mapScalarModeToProfile(mode)


        await tx.capacityProfile.update({
          where: { id: nrProfile.id },
          data: {
            ownerKind: 'NAMED_PERSON',
            planningBasis: planningBasis as any,
            source: source as any,
            defaultPercent: percent,
            startWeek: isNonWindow ? null : nrStartWeek,
            endWeek: isNonWindow ? null : nrEndWeek,
          },
        })

        // ── 7. Write compatibility fields from profile projection ──
        const compatProjection = projectCapacityProfileToLegacyAllocation({
          planningBasis: planningBasis,
          defaultPercent: percent,
          startWeek: isNonWindow ? null : nrStartWeek,
          endWeek: isNonWindow ? null : nrEndWeek,
          segments: [],
          source: source,
        })
        const compatMode = compatProjection?.allocationMode ?? 'EFFORT'
        const compatPercent = compatProjection?.allocationPercent ?? 100
        const compatStart = compatProjection?.allocationStartWeek ?? null
        const compatEnd = compatProjection?.allocationEndWeek ?? null
        await tx.namedResource.update({
          where: { id },
          data: {
            ...nrData,
            allocationMode: compatMode,
            allocationPercent: compatPercent,
            allocationPct: toLegacyAllocationPct(compatPercent),
            allocationStartWeek: compatStart,
            allocationEndWeek: compatEnd,
            startWeek: compatStart,
            endWeek: compatEnd,
          },
        })
      } else {
        // Non-capacity writes still require valid NAMED_PERSON authority.
        await tx.namedResource.update({ where: { id }, data: nrData })
      }

      await clearWeeklyDemandCache(projectId, tx)
      const updated = await tx.namedResource.findFirst({ where: { id } })
      if (!updated) throw new Error('NamedResource not found after update')
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
router.patch('/:id', asyncHandler(async (req: AuthRequest, res: Response) => {
  const { projectId, rtId, id } = req.params as { projectId: string; rtId: string; id: string }
  const project = await ownedProject(projectId, req.userId!)
  if (!project) { res.status(404).json({ error: 'Project not found' }); return }

  const rt = await verifyResourceType(rtId, projectId)
  if (!rt) { res.status(404).json({ error: 'Resource type not found' }); return }

  const existing = await prisma.namedResource.findFirst({ where: { id, resourceTypeId: rtId } })
  if (!existing) { res.status(404).json({ error: 'Named resource not found' }); return }
  const { allocationMode, allocationPercent, allocationStartWeek, allocationEndWeek, startWeek, endWeek, allocationPct } = req.body

  const hasPatch = (k: string) => Object.prototype.hasOwnProperty.call(req.body, k)

  // ── Percentage validation ─────────────────────────────────────────────
  function isValidPercent(v: unknown): v is number {
    return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100
  }
  function isExplicitNull(v: unknown): v is null {
    return v === null
  }

  if (hasPatch('allocationPercent')) {
    if (isExplicitNull(allocationPercent)) {
      res.status(400).json({ error: 'allocationPercent must not be null.' }); return
    }
    if (!isValidPercent(allocationPercent)) {
      res.status(400).json({ error: 'allocationPercent must be a finite number between 0 and 100.' }); return
    }
  }
  if (hasPatch('allocationPct')) {
    if (isExplicitNull(allocationPct)) {
      res.status(400).json({ error: 'allocationPct must not be null.' }); return
    }
    if (!isValidPercent(allocationPct)) {
      res.status(400).json({ error: 'allocationPct must be a finite number between 0 and 100.' }); return
    }
  }
  if (hasPatch('allocationPercent') && hasPatch('allocationPct') && allocationPct !== allocationPercent) {
    res.status(400).json({ error: 'allocationPercent and allocationPct must represent the same value.' }); return
  }
  try {
    const resource = await prisma.$transaction(async tx => {
      // ── 1. Validate the exact authoritative profile ───────────────
      const nrProfile = await loadAndValidateOwnerProfile({
        tx,
        projectId,
        ownerKind: 'NAMED_PERSON',
        ownerId: id,
      })

      // ── 2. Reject protected profiles ─────────────────────────────
      const hasSegments = nrProfile.segments.length > 0
      const isProtectedPlanningBasis = nrProfile.planningBasis === 'CAPACITY_PROFILE'
      if (hasSegments || isProtectedPlanningBasis) {
        throw new ProfileManagedCapacityError(
          'This resource has a protected weekly capacity profile and cannot be updated through scalar capacity fields.',
        )
      }

      // ── 3. Derive defaults from the validated profile ────────────
      const profileAllocMode = nrProfile.planningBasis === 'CAPACITY_PROFILE' ? 'TIMELINE' :
        nrProfile.planningBasis === 'DEMAND_FOLLOWING' ? 'EFFORT' :
        nrProfile.planningBasis === 'AVAILABILITY_WINDOW' ? 'TIMELINE' :
        nrProfile.planningBasis === 'WHOLE_PROJECT_ALLOCATION' ? 'FULL_PROJECT' :
        'EFFORT'
      const profileAllocPercent = nrProfile.planningBasis === 'CAPACITY_PROFILE' ? 100 : (nrProfile.defaultPercent ?? 100)

      // ── 4. Apply only explicitly supplied request fields ─────────
      const mode = hasPatch('allocationMode') ? allocationMode : profileAllocMode
      const percent = hasPatch('allocationPercent') ? allocationPercent :
        hasPatch('allocationPct') ? allocationPct : profileAllocPercent
      const nrStartWeek = hasPatch('startWeek') ? startWeek : (hasPatch('allocationStartWeek') ? allocationStartWeek : nrProfile.startWeek)
      const nrEndWeek = hasPatch('endWeek') ? endWeek : (hasPatch('allocationEndWeek') ? allocationEndWeek : nrProfile.endWeek)

      // ── 5. Determine authoritative profile basis from mode ────────
      const { planningBasis, source, isNonWindow } = mapScalarModeToProfile(mode)

      await tx.capacityProfile.update({
        where: { id: nrProfile.id },
        data: {
          ownerKind: 'NAMED_PERSON',
          planningBasis: planningBasis as any,
          source: source as any,
          defaultPercent: percent,
          startWeek: isNonWindow ? null : nrStartWeek,
          endWeek: isNonWindow ? null : nrEndWeek,
        },
      })
      // ── 7. Write compatibility fields from profile projection ──
      const compatProjection = projectCapacityProfileToLegacyAllocation({
        planningBasis: planningBasis,
        defaultPercent: percent,
        startWeek: isNonWindow ? null : nrStartWeek,
        endWeek: isNonWindow ? null : nrEndWeek,
        segments: [],
        source: source,
      })
      const compatMode = compatProjection?.allocationMode ?? 'EFFORT'
      const compatPercent = compatProjection?.allocationPercent ?? 100
      const compatStart = compatProjection?.allocationStartWeek ?? null
      const compatEnd = compatProjection?.allocationEndWeek ?? null
      const updated = await tx.namedResource.update({
        where: { id },
        data: {
          allocationMode: compatMode,
          allocationPercent: compatPercent,
          allocationPct: toLegacyAllocationPct(compatPercent),
          allocationStartWeek: compatStart,
          allocationEndWeek: compatEnd,
          startWeek: compatStart,
          endWeek: compatEnd,
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
    // ── Validate the NR's authority profile before any write ─────
    const existingProfiles = await tx.capacityProfile.findMany({
      where: { namedResourceId: id, projectId },
      select: { id: true, ownerKind: true },
    })
    if (existingProfiles.length === 0) {
      throw new CapacityIntegrityError(
        'Missing capacity profile for this named resource. ' +
        'Run the capacity profile backfill/repair workflow before retrying this operation.',
      )
    }
    if (existingProfiles.length > 1) {
      throw new CapacityIntegrityError(
        'Multiple capacity profiles exist for this named resource. ' +
        'Run the capacity profile backfill/repair workflow before retrying this operation.',
      )
    }
    const actualOwnerKind = existingProfiles[0].ownerKind as string
    if (actualOwnerKind !== 'NAMED_PERSON' && actualOwnerKind !== 'PLANNED_RESOURCE') {
      throw new CapacityIntegrityError(
        `Capacity profile has invalid owner kind "${actualOwnerKind}".`,
      )
    }

    // Validate through strict loader — allows both NAMED_PERSON and PLANNED_RESOURCE
    await loadAndValidateOwnerProfile({
      tx,
      projectId,
      ownerKind: actualOwnerKind,
      ownerId: id,
    })

    // ── Require exactly one valid ROLE profile ──────────────────
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
