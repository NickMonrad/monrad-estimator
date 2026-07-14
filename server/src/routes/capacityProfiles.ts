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
import { validatePersistedCapacityProfiles } from '../lib/persistedCapacityProfileValidation.js'


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
      // Build name lookups for DTO mapping
      const resourceTypeById = new Map<string, { id: string; name: string }>()
      const namedResourceById = new Map<string, { id: string; name: string; resourceTypeId: string }>()
      for (const rt of project.resourceTypes) {
        resourceTypeById.set(rt.id, { id: rt.id, name: rt.name })
        for (const nr of rt.namedResources) {
          namedResourceById.set(nr.id, { id: nr.id, name: nr.name, resourceTypeId: rt.id })
        }
      }

      const profiles = mapPersistedProfilesToDTOs(
        project.capacityProfiles,
        resourceTypeById,
        namedResourceById,
      )
      res.json({ capacityProfiles: profiles })
      return
    }

    console.warn(
      `[capacity-profiles] Validation failed for project ${projectId}: ` +
      validation.errors.join('; ') + '. Falling back to legacy mapper.',
    )
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

export default router
