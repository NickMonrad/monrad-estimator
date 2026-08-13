import { randomUUID } from 'crypto'
import { Router, Response } from 'express'
import { prisma } from '../lib/prisma.js'
import { asyncHandler } from '../lib/asyncHandler.js'
import { authenticate, AuthRequest } from '../middleware/auth.js'
import { CapacityIntegrityError } from '../lib/capacityIntegrityError.js'
import { loadAndValidateOwnerProfile } from '../lib/ownerProfileLoader.js'
import type { OwnerProfileQuery } from '../lib/ownerProfileLoader.js'
import {
  rejectLegacyCapacityFields,
  isPlannerOwnedProfile,
  PlannerManagedIdentityError,
  isPlannerManagedIdentityError,
} from '../lib/legacyCapacityFieldGuard.js'
import {
  ROLE_DEFAULT_CLONE_PROVENANCE,
  assertRoleProfileCloneableAsNamedPerson,
  isAggregateRoleCloneError,
  respondAggregateRoleCloneError,
} from '../lib/roleProfileClonePolicy.js'
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
const clearWeeklyDemandCache = (projectId: string, tx?: any) =>
  (tx ?? prisma).project.update({
    where: { id: projectId },
    data: { weeklyDemandCache: {} },
  })

/**
 * Load the exactly-one authoritative profile for a named resource.
 *
 * Fails closed when the profile is missing, duplicated, malformed,
 * cross-project, or has a wrong owner kind.
 */
async function loadNamedResourceOwnerProfile(
  tx: OwnerProfileQuery['tx'],
  projectId: string,
  namedResourceId: string,
) {
  const profiles = await tx.capacityProfile.findMany({
    where: { projectId, namedResourceId, resourceTypeId: null },
  })
  const ownerKind = profiles[0]?.ownerKind
  if (profiles.some((profile: { ownerKind: string }) => (
    profile.ownerKind !== 'NAMED_PERSON' && profile.ownerKind !== 'PLANNED_RESOURCE'
  ))) {
    throw new CapacityIntegrityError(
      `Named resource ${namedResourceId} has a capacity profile with the wrong owner kind. ` +
      'Repair the profile before retrying this operation.',
    )
  }
  return loadAndValidateOwnerProfile({
    tx,
    projectId,
    ownerKind: ownerKind as 'NAMED_PERSON' | 'PLANNED_RESOURCE',
    ownerId: namedResourceId,
  })
}

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

  // Legacy capacity request fields are rejected before any write — capacity
  // shape is owned by the capacity-profile endpoint, not the identity route.
  if (rejectLegacyCapacityFields(req.body, res)) return

  const { name: rawName, pricingModel } = req.body

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

  if (pricingModel !== undefined && !VALID_PRICING_MODELS.includes(pricingModel)) {
    res.status(400).json({ error: `pricingModel must be one of: ${VALID_PRICING_MODELS.join(', ')}` }); return
  }

  try {
    const resource = await prisma.$transaction(async tx => {
      // ── Load authoritative role profile via validator ──────────────
      const roleProfile = await loadAndValidateOwnerProfile({
        tx,
        projectId,
        ownerKind: 'ROLE',
        ownerId: rtId,
      })

      // Planner-owned roles cannot gain identities through this route —
      // the user must Switch to manual capacity first.
      if (isPlannerOwnedProfile(roleProfile)) {
        throw new PlannerManagedIdentityError(`Resource type "${rt.name}"`)
      }

      // Aggregate ROLE capacity above 100% per person cannot be represented
      // as one valid named-person profile — reject before any write.
      assertRoleProfileCloneableAsNamedPerson(roleProfile)

      // Create NR with non-capacity fields only
      const created = await tx.namedResource.create({
        data: {
          name,
          resourceTypeId: rtId,
          ...(pricingModel !== undefined && { pricingModel }),
        },
      })

      // ── Create the required owner profile from the role default ────
      // The new person inherits the authoritative ROLE profile (planning
      // basis, percentage, window, segments) with the same generation
      // provenance policy as ResourceType count increase: non-protective
      // DERIVED source plus explicit ROLE_DEFAULT provenance.
      const segments = roleProfile.segments ?? []
      await tx.capacityProfile.create({
        data: {
          ownerKind: 'NAMED_PERSON' as any,
          projectId,
          resourceTypeId: null,
          namedResourceId: created.id,
          planningBasis: roleProfile.planningBasis as any,
          source: 'DERIVED' as any,
          defaultPercent: roleProfile.defaultPercent,
          startWeek: roleProfile.startWeek,
          endWeek: roleProfile.endWeek,
          provenance: ROLE_DEFAULT_CLONE_PROVENANCE as any,
          segments: segments.length > 0
            ? { create: segments.map((seg: any) => ({
                startWeek: seg.startWeek,
                endWeek: seg.endWeek,
                capacityPercent: seg.capacityPercent,
                source: seg.source as any,
              })) }
            : undefined,
        },
      })

      // Sync resource type count to match total named resources
      const total = await tx.namedResource.count({ where: { resourceTypeId: rtId } })
      await tx.resourceType.update({ where: { id: rtId }, data: { count: total } })

      return created
    })
    res.status(201).json(resource)
  } catch (error) {
    if (isPlannerManagedIdentityError(error)) {
      res.status(409).json({ error: error.message, code: error.code })
      return
    }
    if (isAggregateRoleCloneError(error)) {
      respondAggregateRoleCloneError(error, res)
      return
    }
    throw error
  }
}))


router.put('/:id', asyncHandler(async (req: AuthRequest, res: Response) => {
  const { projectId, rtId, id } = req.params as { projectId: string; rtId: string; id: string }
  const project = await ownedProject(projectId, req.userId!)
  if (!project) { res.status(404).json({ error: 'Project not found' }); return }

  const rt = await verifyResourceType(rtId, projectId)
  if (!rt) { res.status(404).json({ error: 'Resource type not found' }); return }

  const existing = await prisma.namedResource.findFirst({ where: { id, resourceTypeId: rtId } })
  if (!existing) { res.status(404).json({ error: 'Named resource not found' }); return }

  // Legacy capacity request fields are rejected before any write.
  if (rejectLegacyCapacityFields(req.body, res)) return

  const { name, pricingModel } = req.body

  if (pricingModel !== undefined && !VALID_PRICING_MODELS.includes(pricingModel as string)) {
    res.status(400).json({ error: `pricingModel must be one of: ${VALID_PRICING_MODELS.join(', ')}` }); return
  }

  // Non-capacity fields written directly to NamedResource
  const nrData: Record<string, unknown> = { name, pricingModel }
  Object.keys(nrData).forEach(key => {
    if (nrData[key] === undefined) delete nrData[key]
  })

  const resource = await prisma.$transaction(async tx => {
    // ── Fail closed: the exact authoritative profile must exist ──────
    await loadNamedResourceOwnerProfile(tx, projectId, id)

    // Non-capacity writes update only the requested non-capacity fields
    // while preserving the valid authoritative profile (NAMED_PERSON or
    // PLANNED_RESOURCE). The profile and all segments remain untouched.
    const updated = await tx.namedResource.update({ where: { id }, data: nrData })

    await clearWeeklyDemandCache(projectId, tx)
    return updated
  })
  res.json(resource)
}))

// PATCH /projects/:projectId/resource-types/:rtId/named-resources/:id
//
// Rejection-only route (#403): PATCH is not a capacity-mutation path. Any
// legacy capacity field (including explicit null) receives the stable
// structured 400; any other payload receives a method/contract error. This
// route performs no transaction, database write, or cache clear.
router.patch('/:id', asyncHandler(async (req: AuthRequest, res: Response) => {
  const { projectId, rtId, id } = req.params as { projectId: string; rtId: string; id: string }
  const project = await ownedProject(projectId, req.userId!)
  if (!project) { res.status(404).json({ error: 'Project not found' }); return }

  const rt = await verifyResourceType(rtId, projectId)
  if (!rt) { res.status(404).json({ error: 'Resource type not found' }); return }

  const existing = await prisma.namedResource.findFirst({ where: { id, resourceTypeId: rtId } })
  if (!existing) { res.status(404).json({ error: 'Named resource not found' }); return }

  if (rejectLegacyCapacityFields(req.body, res)) return

  res.status(405).json({
    error: 'PATCH is not supported for named resources. Use PUT on the owner-scoped capacity-profile endpoint ' +
      '(/api/projects/:projectId/capacity-profiles/:ownerKind/:ownerId) for capacity changes, or PUT on this route ' +
      'for name and pricingModel.',
  })
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

  try {
    await prisma.$transaction(async tx => {
      // ── Validate the NR's authority profile before any write ─────
      const nrProfile = await loadNamedResourceOwnerProfile(tx, projectId, id)

      // ── Require exactly one valid ROLE profile ──────────────────
      const roleProfile = await loadAndValidateOwnerProfile({
        tx,
        projectId,
        ownerKind: 'ROLE',
        ownerId: rtId,
      })

      // Planner-owned roles and planner-created resources cannot be
      // removed through this identity route — transfer first.
      if (isPlannerOwnedProfile(nrProfile) || isPlannerOwnedProfile(roleProfile)) {
        throw new PlannerManagedIdentityError(
          isPlannerOwnedProfile(roleProfile)
            ? `Resource type "${rt.name}"`
            : `Resource "${existing.name}"`,
        )
      }

      await tx.namedResource.delete({ where: { id } })
      await clearWeeklyDemandCache(projectId, tx)

      // Sync resource type count (can reach 0 when all named resources are deleted)
      const total = await tx.namedResource.count({ where: { resourceTypeId: rtId } })
      await tx.resourceType.update({ where: { id: rtId }, data: { count: total } })
    })

    res.status(204).send()
  } catch (error) {
    if (isPlannerManagedIdentityError(error)) {
      res.status(409).json({ error: error.message, code: error.code })
      return
    }
    throw error
  }
}))

export default router
