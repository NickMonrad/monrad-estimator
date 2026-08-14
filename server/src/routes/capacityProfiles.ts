import { Router, Response } from 'express'
import { prisma } from '../lib/prisma.js'
import { asyncHandler } from '../lib/asyncHandler.js'
import { authenticate, AuthRequest } from '../middleware/auth.js'
import {
  mapPersistedProfilesToDTOs,
} from '../lib/capacityProfileMapping.js'
import {
  validatePersistedCapacityProfiles,
  checkPersistedCompleteness,
} from '../lib/persistedCapacityProfileValidation.js'
import {
  validateReplaceCapacityProfileRequest,
} from '../lib/capacityProfileReplaceValidator.js'
import type { ReplaceCapacityProfileOwnerKind } from '../lib/capacityProfileReplaceValidator.js'
import { replaceCapacityProfile, ServiceError } from '../lib/capacityProfileReplaceService.js'
import {
  transferToManualCapacity,
  TransferError,
} from '../lib/capacityProfileTransferService.js'
import {
  applyRoleCountsAsNeeded,
  BulkAsNeededError,
} from '../lib/bulkAsNeededProfiles.js'
import { ownedProject } from '../lib/ownership.js'


const router = Router({ mergeParams: true })
router.use(authenticate)

router.get('/', asyncHandler(async (req: AuthRequest, res: Response) => {
  const projectId = req.params.projectId as string

  const project = await prisma.project.findFirst({
    where: { id: projectId, ownerId: req.userId },
    include: {
      resourceTypes: {
        include: {
          namedResources: { orderBy: { createdAt: 'asc' } },
        },
      },
      capacityPlans: {
        where: { isActive: true },
        take: 1,
        include: { periods: { include: { entries: true }, orderBy: { periodIndex: 'asc' } } },
      },
      capacityProfiles: {
        include: {
          segments: {
            orderBy: [
              { startWeek: 'asc' },
              { endWeek: 'asc' },
            ],
          },
        },
      },
    },
  })

  if (!project) {
    res.status(404).json({ error: 'Project not found' })
    return
  }

  // ── Persisted-authority path: validate structural integrity first ─────
  // Issue #418: there is no legacy mapper fallback. Missing, malformed or
  // conflicting profile state fails closed with an actionable error.
  const resourceTypeIds = new Set(project.resourceTypes.map(rt => rt.id))
  const namedResourceIds = new Set(
    project.resourceTypes.flatMap(rt => rt.namedResources.map(nr => nr.id)),
  )

  const validation = validatePersistedCapacityProfiles(
    project.capacityProfiles as Parameters<typeof validatePersistedCapacityProfiles>[0],
    { projectId, resourceTypeIds, namedResourceIds },
  )

  if (!validation.valid) {
    res.status(409).json({
      error: 'Persisted capacity profiles are invalid: ' + validation.errors.join('; '),
      code: 'CAPACITY_INTEGRITY_ERROR',
    })
    return
  }

  const completenessErrors = checkPersistedCompleteness({
    resourceTypes: project.resourceTypes.map(rt => ({
      id: rt.id,
      name: rt.name,
      namedResources: rt.namedResources.map(nr => ({ id: nr.id, name: nr.name })),
    })),
    capacityProfiles: project.capacityProfiles.map(profile => ({
      resourceTypeId: profile.resourceTypeId,
      namedResourceId: profile.namedResourceId,
      ownerKind: String(profile.ownerKind),
      source: String(profile.source),
      planningBasis: String(profile.planningBasis),
    })),
  })

  if (completenessErrors.length > 0 && project.planningState !== 'NEEDS_REPLAN') {
    res.status(409).json({
      error: 'Persisted capacity profiles are incomplete: ' + completenessErrors.join('; '),
      code: 'CAPACITY_INTEGRITY_ERROR',
    })
    return
  }
  // NEEDS_REPLAN (issue #449): missing profile coverage is the intentional,
  // expected state after Reset Planning — the user is mid-replanning. The
  // structural validation above still fails closed on genuinely malformed
  // rows, so the quarantine never masks unrelated corruption.

  const resourceTypeById = new Map<string, { id: string; name: string }>()
  const namedResourceById = new Map<string, { id: string; name: string; resourceTypeId: string }>()
  for (const rt of project.resourceTypes) {
    resourceTypeById.set(rt.id, { id: rt.id, name: rt.name })
    for (const nr of rt.namedResources) {
      namedResourceById.set(nr.id, { id: nr.id, name: nr.name, resourceTypeId: rt.id })
    }
  }

  res.json({
    capacityProfiles: mapPersistedProfilesToDTOs(
      project.capacityProfiles,
      resourceTypeById,
      namedResourceById,
    ),
  })
}))

// ─── POST transfer-to-manual (must be registered before parameterised routes) ──

router.post('/transfer-to-manual', asyncHandler(async (req: AuthRequest, res: Response) => {
  const projectId = req.params.projectId as string
  const { resourceTypeId } = req.body as { resourceTypeId?: string }

  if (!resourceTypeId || typeof resourceTypeId !== 'string') {
    res.status(400).json({ error: 'resourceTypeId is required' })
    return
  }

  try {
    const result = await prisma.$transaction(tx =>
      transferToManualCapacity(tx, projectId, resourceTypeId, req.userId!),
    )

    res.status(200).json({ transferred: true, result })
  } catch (err) {
    if (err instanceof TransferError) {
      res.status(err.status).json({ error: err.message })
      return
    }
    throw err
  }
}))

// ─── POST bulk-as-needed (must be registered before parameterised routes) ──

router.post('/bulk-as-needed', asyncHandler(async (req: AuthRequest, res: Response) => {
  const projectId = req.params.projectId as string

  try {
    const result = await applyRoleCountsAsNeeded(prisma, projectId, req.userId!)
    res.status(200).json(result)
  } catch (err) {
    if (err instanceof BulkAsNeededError) {
      res.status(err.status).json({ error: err.message, code: err.code })
      return
    }
    throw err
  }
}))

const VALID_OWNER_KINDS: Record<string, ReplaceCapacityProfileOwnerKind> = {
  ROLE: 'ROLE',
  NAMED_PERSON: 'NAMED_PERSON',
}

router.put('/:ownerKind/:ownerId', asyncHandler(async (req: AuthRequest, res: Response) => {
  const projectId = req.params.projectId as string
  const ownerKindParam = req.params.ownerKind as string
  const ownerId = req.params.ownerId as string

  // ── Project ownership check ─────────────────────────────────────────
  const project = await ownedProject(projectId, req.userId!)
  if (!project) {
    res.status(404).json({ error: 'Project not found' })
    return
  }
  // ── Validate ownerKind ──────────────────────────────────────────────
  const ownerKind = VALID_OWNER_KINDS[ownerKindParam]
  if (!ownerKind) {
    res.status(400).json({ error: 'ownerKind must be "ROLE" or "NAMED_PERSON"' })
    return
  }
  // ── Validate request body ───────────────────────────────────────────
  const bodyErrors = validateReplaceCapacityProfileRequest(req.body, ownerKind)
  if (bodyErrors.length > 0) {
    res.status(400).json({ error: 'Invalid request body', details: bodyErrors })
    return
  }

  // ── Run in transaction ──────────────────────────────────────────────
  try {
    const profile = await prisma.$transaction(tx =>
      replaceCapacityProfile(tx, projectId, ownerKind, ownerId, req.body, req.userId!),
    )

    res.status(200).json({ capacityProfile: profile })
  } catch (err) {
    if (err instanceof ServiceError) {
      res.status(err.status).json({ error: err.message })
      return
    }
    // Narrow P2002: only map the expected capacity-profile owner uniqueness violation
    if (
      err &&
      typeof err === 'object' &&
      'code' in err &&
      (err as { code: string }).code === 'P2002'
    ) {
      const meta = (err as {
        meta?: { modelName?: string; target?: string[] }
      }).meta
      const expectedTarget = ownerKind === 'ROLE' ? 'resourceTypeId' : 'namedResourceId'
      if (
        meta?.modelName === 'CapacityProfile'
        && Array.isArray(meta.target)
        && meta.target.length === 1
        && meta.target[0] === expectedTarget
      ) {
        res.status(409).json({ error: 'A capacity profile already exists for this owner' })
        return
      }
    }
    throw err
  }
}))

export default router
