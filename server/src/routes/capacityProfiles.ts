import { Router, Response } from 'express'
import { prisma } from '../lib/prisma.js'
import { asyncHandler } from '../lib/asyncHandler.js'
import { authenticate, AuthRequest } from '../middleware/auth.js'
import { materializeCapacityPlanResources } from '../lib/capacityPlanMaterialisation.js'
import {
  mapProjectToCapacityProfiles,
  mapPersistedProfilesToDTOs,
} from '../lib/capacityProfileMapping.js'
import type {
  CapacityProfileResourceTypeLike,
  CapacityProfileNamedResourceLike,
  CapacityPlanSlotInput,
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
  if (project.capacityProfiles && project.capacityProfiles.length > 0) {
    const resourceTypeIds = new Set(project.resourceTypes.map(rt => rt.id))
    const namedResourceIds = new Set(
      project.resourceTypes.flatMap(rt => rt.namedResources.map(nr => nr.id)),
    )

    const validation = validatePersistedCapacityProfiles(
      project.capacityProfiles as Parameters<typeof validatePersistedCapacityProfiles>[0],
      { projectId, resourceTypeIds, namedResourceIds },
    )

    if (validation.valid) {
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

      // Persisted state is authoritative only when structural validation and
      // complete owner coverage both succeed.
      if (completenessErrors.length === 0) {
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
        return
      }

      console.warn(
        `[capacity-profiles] Incomplete persisted set for project ${projectId}: ` +
        completenessErrors.join('; ') + '. Falling back to legacy mapper.',
      )
    } else {
      console.warn(
        `[capacity-profiles] Validation failed for project ${projectId}: ` +
        validation.errors.join('; ') + '. Falling back to legacy mapper.',
      )
    }
  }

  // ── Fallback: derive profiles from project data via legacy mapper ────
  const activePlan = project.capacityPlans?.[0] ?? null
  const capacityPlanByRt = materializeCapacityPlanResources(activePlan?.periods ?? [])

  const capacityPlanSlotsByResourceTypeId = new Map<string, CapacityPlanSlotInput[]>(
    Array.from(capacityPlanByRt.entries()).map(([rtId, materialized]) => [
      rtId,
      materialized.slotWindows,
    ]),
  )

  const namedResourcesByResourceTypeId = new Map<string, CapacityProfileNamedResourceLike[]>()
  for (const rt of project.resourceTypes) {
    namedResourcesByResourceTypeId.set(rt.id, rt.namedResources as CapacityProfileNamedResourceLike[])
  }

  const legacyProfiles = mapProjectToCapacityProfiles({
    projectId,
    resourceTypes: project.resourceTypes as CapacityProfileResourceTypeLike[],
    namedResourcesByResourceTypeId,
    capacityPlanSlotsByResourceTypeId,
  })

  res.json({ capacityProfiles: legacyProfiles })
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
      replaceCapacityProfile(tx as any, projectId, ownerKind, ownerId, req.body),
    )

    res.status(200).json({ capacityProfile: profile })
  } catch (err) {
    if (err instanceof ServiceError) {
      res.status(err.status).json({ error: err.message })
      return
    }
    // Prisma unique constraint violation — race condition on create
    if (err && typeof err === 'object' && 'code' in err && (err as { code: string }).code === 'P2002') {
      res.status(409).json({ error: 'A capacity profile already exists for this owner' })
      return
    }
    throw err
  }
}))

export default router
