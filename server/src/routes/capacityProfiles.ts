import { Router, Response } from 'express'
import { prisma } from '../lib/prisma.js'
import { asyncHandler } from '../lib/asyncHandler.js'
import { authenticate, AuthRequest } from '../middleware/auth.js'
import { materializeCapacityPlanResources } from '../lib/capacityPlanMaterialisation.js'
import {
  mapProjectToCapacityProfiles,
  mapPersistedProfilesToDTOs,
  mapResourceTypeToCapacityProfile,
} from '../lib/capacityProfileMapping.js'
import type {
  CapacityProfileResourceTypeLike,
  CapacityProfileNamedResourceLike,
  CapacityPlanSlotInput,
} from '../lib/capacityProfileMapping.js'
import { compareCapacityProfiles } from '../lib/reconcileCapacityProfiles.js'

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

  // Materialise active capacity plan into slot windows per resource type
  const activePlan = project.capacityPlans?.[0] ?? null
  const capacityPlanByRt = materializeCapacityPlanResources(activePlan?.periods ?? [])

  const capacityPlanSlotsByResourceTypeId = new Map<string, CapacityPlanSlotInput[]>(
    Array.from(capacityPlanByRt.entries()).map(([rtId, materialized]) => [
      rtId,
      materialized.slotWindows,
    ]),
  )

  // Build named resources lookup per resource type
  const namedResourcesByResourceTypeId = new Map<string, CapacityProfileNamedResourceLike[]>()
  for (const rt of project.resourceTypes) {
    namedResourcesByResourceTypeId.set(rt.id, rt.namedResources as CapacityProfileNamedResourceLike[])
  }

  // Derive the legacy mapper profiles (needed for both persisted-read decision and fallback)
  const legacyProfiles = mapProjectToCapacityProfiles({
    projectId,
    resourceTypes: project.resourceTypes as CapacityProfileResourceTypeLike[],
    namedResourcesByResourceTypeId,
    capacityPlanSlotsByResourceTypeId,
  })

  // If persisted profiles exist, check whether they are fully reconciled
  if (project.capacityProfiles && project.capacityProfiles.length > 0) {
    // Augment legacy profiles with role-level expected profiles for RTs that
    // have named resources. The project-level mapper skips role profiles when
    // NRs exist, but the profile-first write path creates them.
    // Adding them here ensures reconciliation validates role profiles, so
    // Augment legacy profiles with role-level expected profiles for RTs that
    // have named resources AND have a persisted role profile to validate.
    // If no role profile exists in persisted, there's nothing to validate —
    // the expected set stays as the mapper produced it.
    const augmentedLegacyProfiles = [...legacyProfiles]
    for (const rt of project.resourceTypes as any[]) {
      if (rt.namedResources && rt.namedResources.length > 0) {
        const hasPersistedRoleProfile = (project.capacityProfiles as any[]).some(
          (pp: any) => pp.resourceTypeId === rt.id && pp.ownerKind === 'ROLE',
        )
        if (hasPersistedRoleProfile) {
          const hasExpectedRoleProfile = augmentedLegacyProfiles.some(
            (p: any) => p.owner?.kind === 'role' && p.owner?.id === rt.id,
          )
          if (!hasExpectedRoleProfile) {
            const roleProfile = mapResourceTypeToCapacityProfile({
              projectId,
              resourceType: rt as CapacityProfileResourceTypeLike,
              capacityPlanSlots: capacityPlanSlotsByResourceTypeId.get(rt.id),
            })
            augmentedLegacyProfiles.push(roleProfile)
          }
        }
      }
    }

    const comparison = compareCapacityProfiles(
      projectId,
      augmentedLegacyProfiles,
      project.capacityProfiles,
    )

    if (comparison.mismatches.length === 0) {
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
      `[capacity-profiles] Reconciliation failed for project ${projectId}: ` +
      `${comparison.mismatches.length} mismatch(es). Falling back to legacy mapper.`,
    )
  }

  // Fallback: return the legacy mapper-derived profiles
  res.json({ capacityProfiles: legacyProfiles })
}))

export default router
