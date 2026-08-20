import { Router, Response } from 'express'
import { prisma } from '../lib/prisma.js'
import { asyncHandler } from '../lib/asyncHandler.js'
import { authenticate, AuthRequest } from '../middleware/auth.js'
import { loadExactCapacityProfiles } from '../lib/exactCapacityProfileReader.js'

const router = Router()
router.use(authenticate)

// Helper: strict ownership check (for destructive/admin ops)
async function ownedProject(id: string, userId: string) {
  return prisma.project.findFirst({ where: { id, ownerId: userId } })
}

// Helper: org-aware access check (read/update ops visible to org members)
async function canAccessProject(projectId: string, userId: string) {
  const userOrgIds = (await prisma.organisationMember.findMany({
    where: { userId },
    select: { orgId: true },
  })).map(m => m.orgId)

  return prisma.project.findFirst({
    where: {
      id: projectId,
      OR: [
        { ownerId: userId },
        ...(userOrgIds.length > 0 ? [{ orgId: { in: userOrgIds } }] : []),
      ],
    },
    include: { resourceTypes: true, _count: { select: { epics: true } }, org: { select: { id: true, name: true } }, customer: { select: { id: true, name: true } } },
  })
}

// List projects for current user
// ?archived=true → only deleted projects; default → only live projects
router.get('/', asyncHandler(async (req: AuthRequest, res: Response) => {
  const archived = req.query.archived === 'true'
  const userOrgIds = (await prisma.organisationMember.findMany({
    where: { userId: req.userId! },
    select: { orgId: true },
  })).map(m => m.orgId)

  const projects = await prisma.project.findMany({
    where: {
      deletedAt: archived ? { not: null } : null,
      OR: [
        { ownerId: req.userId! },
        ...(userOrgIds.length > 0 ? [{ orgId: { in: userOrgIds } }] : []),
      ],
    },
    orderBy: { updatedAt: 'desc' },
    include: {
      _count: { select: { epics: true } },
      org: { select: { id: true, name: true } },
      customer: { select: { id: true, name: true } },
    },
  })
  res.json(projects)
}))

// Update project tax settings
router.patch('/:id/tax', asyncHandler(async (req: AuthRequest, res: Response) => {
  const existing = await ownedProject(req.params.id as string, req.userId!)
  if (!existing) { res.status(404).json({ error: 'Not found' }); return }

  const { taxRate, taxLabel } = req.body
  if (taxRate !== undefined && taxRate !== null && (typeof taxRate !== 'number' || taxRate < 0)) {
    res.status(400).json({ error: 'taxRate must be a non-negative number or null' }); return
  }

  const project = await prisma.project.update({
    where: { id: req.params.id as string },
    data: {
      ...(taxRate !== undefined && { taxRate }),
      ...(taxLabel !== undefined && { taxLabel }),
    },
  })
  res.json(project)
}))

// Clone project — deep copy (specific route before /:id)
router.post('/:id/clone', asyncHandler(async (req: AuthRequest, res: Response) => {
  const clonedProject = await prisma.$transaction(async (tx) => {
    const source = await tx.project.findFirst({
      where: { id: req.params.id as string, ownerId: req.userId },
      include: {
        resourceTypes: { include: { namedResources: true } },
        overheads: true,
        discounts: true,
        dependencies: true,
        risks: true,
        timelineEntries: true,
        storyTimelineEntries: true,
        capacityPlans: {
          include: {
            periods: {
              include: { entries: true },
            },
          },
        },
        epics: {
          include: {
            epicDependencies: true,
            epicDependents: true,
            features: {
              include: {
                dependencies: true,
                dependents: true,
                timelineEntry: true,
                userStories: {
                  include: {
                    dependencies: true,
                    dependents: true,
                    timelineEntry: true,
                    tasks: true,
                  },
                },
              },
            },
          },
        },
      },
    })
    if (!source) return null

    // Build ID maps for all cloned entities
    const rtIdMap = new Map<string, string>()
    const nrIdMap = new Map<string, string>()
    const epicIdMap = new Map<string, string>()
    const featureIdMap = new Map<string, string>()
    const storyIdMap = new Map<string, string>()

    const newProject = await tx.project.create({
      data: {
        name: `Copy of ${source.name}`,
        description: source.description,
        customerId: source.customerId,
        orgId: source.orgId,
        status: 'DRAFT',
        // A clone of a NEEDS_REPLAN project must stay quarantined: its
        // planning state is copied verbatim so the copy never presents an
        // absent capacity model as CURRENT (issue #449).
        planningState: source.planningState,
        onboardingWeeks: source.onboardingWeeks,
        bufferWeeks: source.bufferWeeks,
        startDate: source.startDate,
        hoursPerDay: source.hoursPerDay,
        taxRate: source.taxRate,
        taxLabel: source.taxLabel,
        ownerId: req.userId!,
      },
    })

    // Copy resource types
    for (const rt of source.resourceTypes) {
      const newRt = await tx.resourceType.create({
        data: {
          name: rt.name,
          category: rt.category,
          count: rt.count,
          hoursPerDay: rt.hoursPerDay,
          dayRate: rt.dayRate,
          proposedName: rt.proposedName,
          globalTypeId: rt.globalTypeId,
          projectId: newProject.id,
        },
      })
      rtIdMap.set(rt.id, newRt.id)

      // Copy named resources (identity and independent metadata only;
      // capacity state is cloned losslessly via capacity profiles below).
      // createdAt is preserved so scheduler/resource-profile ordering (which
      // sorts named resources by createdAt) matches the source exactly —
      // otherwise a transaction-stamped identical createdAt defers the order
      // to a random id tiebreak and assignment parity breaks.
      for (const nr of rt.namedResources) {
        const newNr = await tx.namedResource.create({
          data: {
            name: nr.name,
            pricingModel: nr.pricingModel,
            resourceTypeId: newRt.id,
            createdAt: nr.createdAt,
          },
        })
        nrIdMap.set(nr.id, newNr.id)
      }
    }

    // Copy capacity plans, periods, and entries (remap resourceTypeId)
    for (const plan of source.capacityPlans ?? []) {
      const newPlan = await tx.capacityPlan.create({
        data: {
          projectId: newProject.id,
          name: plan.name,
          targetWeeks: plan.targetWeeks,
          periodWeeks: plan.periodWeeks,
          maxDelta: plan.maxDelta,
          isActive: plan.isActive,
          totalCost: plan.totalCost,
          deliveryWeeks: plan.deliveryWeeks,
        },
      })
      for (const period of plan.periods ?? []) {
        const newPeriod = await tx.capacityPlanPeriod.create({
          data: {
            planId: newPlan.id,
            periodIndex: period.periodIndex,
            startWeek: period.startWeek,
            endWeek: period.endWeek,
          },
        })
        for (const entry of period.entries ?? []) {
          const newRtId = rtIdMap.get(entry.resourceTypeId)
          if (!newRtId) {
            throw new Error(
              `Clone failed: capacity plan entry references resource type "${entry.resourceTypeId}" which was not cloned. ` +
              `All resource types must be cloned for a valid deep copy.`,
            )
          }
          await tx.capacityPlanEntry.create({
            data: {
              periodId: newPeriod.id,
              resourceTypeId: newRtId,
              headcount: entry.headcount,
              demandFTE: entry.demandFTE,
              utilisationPct: entry.utilisationPct,
            },
          })
        }
      }
    }

    // Copy overheads
    for (const oh of source.overheads) {
      await tx.projectOverhead.create({
        data: {
          projectId: newProject.id,
          name: oh.name,
          resourceTypeId: oh.resourceTypeId ? (rtIdMap.get(oh.resourceTypeId) ?? null) : null,
          type: oh.type,
          value: oh.value,
          order: oh.order,
        },
      })
    }

    // Copy discounts
    for (const disc of source.discounts) {
      await tx.projectDiscount.create({
        data: {
          projectId: newProject.id,
          resourceTypeId: disc.resourceTypeId ? (rtIdMap.get(disc.resourceTypeId) ?? null) : null,
          type: disc.type,
          value: disc.value,
          label: disc.label,
          order: disc.order,
        },
      })
    }

    // Copy project-owned dependencies and risks with their persisted order.
    for (const dependency of source.dependencies ?? []) {
      await tx.projectDependency.create({
        data: {
          projectId: newProject.id,
          description: dependency.description,
          order: dependency.order,
        },
      })
    }
    for (const risk of source.risks ?? []) {
      await tx.projectRisk.create({
        data: {
          projectId: newProject.id,
          description: risk.description,
          mitigation: risk.mitigation,
          order: risk.order,
        },
      })
    }

    // Copy epics → features → stories → tasks, building ID maps
    for (const epic of source.epics) {
      const newEpic = await tx.epic.create({
        data: {
          name: epic.name,
          description: epic.description,
          assumptions: epic.assumptions,
          order: epic.order,
          featureMode: epic.featureMode,
          scheduleMode: epic.scheduleMode,
          timelineStartWeek: epic.timelineStartWeek,
          isActive: epic.isActive,
          projectId: newProject.id,
        },
      })
      epicIdMap.set(epic.id, newEpic.id)

      for (const feature of epic.features) {
        const newFeature = await tx.feature.create({
          data: {
            name: feature.name,
            description: feature.description,
            assumptions: feature.assumptions,
            order: feature.order,
            isActive: feature.isActive,
            featureMode: feature.featureMode,
            timelineColour: feature.timelineColour,
            timelineStartWeek: feature.timelineStartWeek,
            epicId: newEpic.id,
          },
        })
        featureIdMap.set(feature.id, newFeature.id)

        for (const story of feature.userStories) {
          const newStory = await tx.userStory.create({
            data: {
              name: story.name,
              description: story.description,
              assumptions: story.assumptions,
              order: story.order,
              isActive: story.isActive,
              appliedTemplateId: story.appliedTemplateId,
              featureId: newFeature.id,
            },
          })
          storyIdMap.set(story.id, newStory.id)

          for (const task of story.tasks) {
            await tx.task.create({
              data: {
                name: task.name,
                description: task.description,
                assumptions: task.assumptions,
                hoursEffort: task.hoursEffort,
                durationDays: task.durationDays,
                order: task.order,
                userStoryId: newStory.id,
                resourceTypeId: task.resourceTypeId ? (rtIdMap.get(task.resourceTypeId) ?? null) : null,
              },
            })
          }
        }
      }
    }

    // Recreate epic dependencies (remap both epicId and dependsOnId)
    for (const epic of source.epics) {
      for (const dep of epic.epicDependencies ?? []) {
        const newEpicId = epicIdMap.get(dep.epicId)
        const newDependsOnId = epicIdMap.get(dep.dependsOnId)
        if (newEpicId && newDependsOnId) {
          await tx.epicDependency.create({
            data: { epicId: newEpicId, dependsOnId: newDependsOnId },
          })
        }
      }
    }

    // Recreate feature dependencies + timeline entries
    for (const epic of source.epics) {
      for (const feature of epic.features) {
        for (const dep of feature.dependencies ?? []) {
          const newFeatureId = featureIdMap.get(dep.featureId)
          const newDependsOnId = featureIdMap.get(dep.dependsOnId)
          if (newFeatureId && newDependsOnId) {
            await tx.featureDependency.create({
              data: { featureId: newFeatureId, dependsOnId: newDependsOnId },
            })
          }
        }
        if (feature.timelineEntry) {
          const newFeatureId = featureIdMap.get(feature.id)
          if (newFeatureId) {
            await tx.timelineEntry.create({
              data: {
                projectId: newProject.id,
                featureId: newFeatureId,
                startWeek: feature.timelineEntry.startWeek,
                durationWeeks: feature.timelineEntry.durationWeeks,
                isManual: feature.timelineEntry.isManual,
              },
            })
          }
        }
      }
    }

    // Recreate story dependencies + story timeline entries
    for (const epic of source.epics) {
      for (const feature of epic.features) {
        for (const story of feature.userStories) {
          for (const dep of story.dependencies ?? []) {
            const newStoryId = storyIdMap.get(dep.storyId)
            const newDependsOnId = storyIdMap.get(dep.dependsOnId)
            if (newStoryId && newDependsOnId) {
              await tx.storyDependency.create({
                data: { storyId: newStoryId, dependsOnId: newDependsOnId },
              })
            }
          }
          if (story.timelineEntry) {
            const newStoryId = storyIdMap.get(story.id)
            if (newStoryId) {
              await tx.storyTimelineEntry.create({
                data: {
                  projectId: newProject.id,
                  storyId: newStoryId,
                  startWeek: story.timelineEntry.startWeek,
                  durationWeeks: story.timelineEntry.durationWeeks,
                  isManual: story.timelineEntry.isManual,
                },
              })
            }
          }
        }
      }
    }

    // Clone exact capacity profiles (preserving DB_NULL vs JSON_NULL semantics)
    const exactProfiles = await loadExactCapacityProfiles(source.id, tx)
    for (const profile of exactProfiles) {
      // Validate owner shape and remap owner IDs (strict: never null owner)
      let newResourceTypeId: string | null = null
      let newNamedResourceId: string | null = null
      if (profile.ownerKind === 'ROLE') {
        if (!profile.resourceTypeId || profile.namedResourceId !== null) {
          throw new Error(
            `Clone failed: ROLE capacity profile ${profile.id} must have resourceTypeId and null namedResourceId`,
          )
        }
        const mapped = rtIdMap.get(profile.resourceTypeId)
        if (!mapped) {
          throw new Error(
            `Clone failed: ROLE capacity profile ${profile.id} references missing resource type "${profile.resourceTypeId}"`,
          )
        }
        newResourceTypeId = mapped
      } else if (profile.ownerKind === 'NAMED_PERSON' || profile.ownerKind === 'PLANNED_RESOURCE') {
        if (!profile.namedResourceId || profile.resourceTypeId !== null) {
          throw new Error(
            `Clone failed: ${profile.ownerKind} capacity profile ${profile.id} must have namedResourceId and null resourceTypeId`,
          )
        }
        const mapped = nrIdMap.get(profile.namedResourceId)
        if (!mapped) {
          throw new Error(
            `Clone failed: ${profile.ownerKind} capacity profile ${profile.id} references missing named resource "${profile.namedResourceId}"`,
          )
        }
        newNamedResourceId = mapped
      } else {
        throw new Error(
          `Clone failed: capacity profile ${profile.id} has unknown ownerKind "${profile.ownerKind}"`,
        )
      }

      const newProfile = await tx.capacityProfile.create({
        data: {
          projectId: newProject.id,
          ownerKind: profile.ownerKind,
          resourceTypeId: newResourceTypeId,
          namedResourceId: newNamedResourceId,
          planningBasis: profile.planningBasis,
          source: profile.source,
          defaultPercent: profile.defaultPercent,
          startWeek: profile.startWeek,
          endWeek: profile.endWeek,
          provenance: profile.provenance,
        },
      })

      for (const segment of profile.segments) {
        await tx.capacitySegment.create({
          data: {
            capacityProfileId: newProfile.id,
            startWeek: segment.startWeek,
            endWeek: segment.endWeek,
            capacityPercent: segment.capacityPercent,
            source: segment.source,
          },
        })
      }
    }

    return tx.project.findFirst({
      where: { id: newProject.id },
      include: { resourceTypes: true, _count: { select: { epics: true } } },
    })
  }, { timeout: 30000, isolationLevel: 'RepeatableRead' })

  if (!clonedProject) { res.status(404).json({ error: 'Not found' }); return }
  res.status(201).json(clonedProject)
}))

// Restore soft-deleted project (specific route before /:id)
router.post('/:id/restore', asyncHandler(async (req: AuthRequest, res: Response) => {
  const existing = await prisma.project.findFirst({
    where: { id: req.params.id as string, ownerId: req.userId, deletedAt: { not: null } },
  })
  if (!existing) { res.status(404).json({ error: 'Not found' }); return }
  const project = await prisma.project.update({
    where: { id: req.params.id as string },
    data: { deletedAt: null },
  })
  res.json(project)
}))

// Permanent (hard) delete — for archived projects
router.delete('/:id/permanent', asyncHandler(async (req: AuthRequest, res: Response) => {
  const existing = await ownedProject(req.params.id as string, req.userId!)
  if (!existing) { res.status(404).json({ error: 'Not found' }); return }
  await prisma.project.delete({ where: { id: req.params.id as string } })
  res.json({ message: 'Project permanently deleted' })
}))

// Get single project
router.get('/:id', asyncHandler(async (req: AuthRequest, res: Response) => {
  const project = await canAccessProject(req.params.id as string, req.userId!)
  if (!project) { res.status(404).json({ error: 'Not found' }); return }
  res.json(project)
}))

// Create project
router.post('/', asyncHandler(async (req: AuthRequest, res: Response) => {
  const { name, description, status, hoursPerDay, bufferWeeks } = req.body
  const customerId = req.body.customerId || null
  const orgId = req.body.orgId || null
  if (!name) { res.status(400).json({ error: 'name is required' }); return }

  // Validate org membership if orgId provided
  if (orgId) {
    const membership = await prisma.organisationMember.findUnique({
      where: { orgId_userId: { orgId, userId: req.userId! } },
    })
    if (!membership) { res.status(403).json({ error: 'Not a member of that org' }); return }
  }

  // Fetch global types to seed into the new project
  const globalTypes = await prisma.globalResourceType.findMany()
  const seedTypes = globalTypes.map(gt => ({
    name: gt.name,
    category: gt.category,
    globalTypeId: gt.id,
    hoursPerDay: gt.defaultHoursPerDay ?? null,
    dayRate: gt.defaultDayRate ?? null,
  }))

  const project = await prisma.$transaction(async tx => {
    const p = await tx.project.create({
      data: {
        name,
        description,
        status: status ?? 'DRAFT',
        hoursPerDay: hoursPerDay ?? 7.6,
        bufferWeeks: bufferWeeks ?? 0,
        customerId,
        orgId,
        ownerId: req.userId!,
        resourceTypes: { create: seedTypes },
      },
      include: { resourceTypes: true, org: { select: { id: true, name: true } }, customer: { select: { id: true, name: true } } },
    })

    // Create authoritative role-owned capacity profiles for each seeded resource type.
    // The seed reproduces the strict mapper (source, planningBasis) shape, so it carries
    // LEGACY_MAPPER provenance to preserve Squad Planner ROLE adoption parity (issue #405).
    for (const rt of p.resourceTypes) {
      await tx.capacityProfile.create({
        data: {
          ownerKind: 'ROLE',
          projectId: p.id,
          resourceTypeId: rt.id,
          namedResourceId: null,
          planningBasis: 'AVAILABILITY_WINDOW',
          source: 'AVAILABILITY_WINDOW',
          defaultPercent: 100,
          startWeek: null,
          endWeek: null,
          provenance: 'LEGACY_MAPPER',
        },
      })
    }

    return p
  })
  res.status(201).json(project)
}))

// Partial update project (e.g. bufferWeeks, onboardingWeeks, hoursPerDay)
router.patch('/:id', asyncHandler(async (req: AuthRequest, res: Response) => {
  const existing = await ownedProject(req.params.id as string, req.userId!)
  if (!existing) { res.status(404).json({ error: 'Not found' }); return }
  const data: Record<string, unknown> = {}
  if (req.body.bufferWeeks !== undefined) data.bufferWeeks = parseInt(req.body.bufferWeeks) || 0
  if (req.body.onboardingWeeks !== undefined) data.onboardingWeeks = parseInt(req.body.onboardingWeeks) || 0
  if (req.body.hoursPerDay !== undefined) data.hoursPerDay = req.body.hoursPerDay
  if (req.body.name !== undefined) data.name = req.body.name
  if (req.body.status !== undefined) data.status = req.body.status
  const project = await prisma.project.update({ where: { id: req.params.id as string }, data })
  res.json(project)
}))

// Update project
router.put('/:id', asyncHandler(async (req: AuthRequest, res: Response) => {
  const { name, description, status, hoursPerDay, taxRate, taxLabel } = req.body
  const customerId = req.body.customerId !== undefined ? (req.body.customerId || null) : undefined
  const bufferWeeks = req.body.bufferWeeks !== undefined ? (parseInt(req.body.bufferWeeks) || 0) : undefined
  const onboardingWeeks = req.body.onboardingWeeks !== undefined ? (parseInt(req.body.onboardingWeeks) || 0) : undefined
  const existing = await ownedProject(req.params.id as string, req.userId!)
  if (!existing) { res.status(404).json({ error: 'Not found' }); return }
  const project = await prisma.project.update({
    where: { id: req.params.id as string },
    data: { name, description, ...(customerId !== undefined && { customerId }), status, hoursPerDay, taxRate, taxLabel, ...(bufferWeeks !== undefined && { bufferWeeks }), ...(onboardingWeeks !== undefined && { onboardingWeeks }) },
  })
  res.json(project)
}))

// Soft-delete project (sets deletedAt)
router.delete('/:id', asyncHandler(async (req: AuthRequest, res: Response) => {
  const existing = await ownedProject(req.params.id as string, req.userId!)
  if (!existing) { res.status(404).json({ error: 'Not found' }); return }
  await prisma.project.update({ where: { id: req.params.id as string }, data: { deletedAt: new Date() } })
  res.json({ message: 'Project archived' })
}))

// POST /api/projects/:id/move-to-org
router.post('/:id/move-to-org', asyncHandler(async (req: AuthRequest, res: Response) => {
  try {
    const id = req.params.id as string
    const { orgId } = req.body

    const existing = await prisma.project.findFirst({ where: { id, ownerId: req.userId } })
    if (!existing) { res.status(404).json({ error: 'Not found' }); return }

    // orgId = '' or null means remove from org (make personal)
    if (orgId) {
      const membership = await prisma.organisationMember.findUnique({
        where: { orgId_userId: { orgId: orgId as string, userId: req.userId! } },
      })
      if (!membership) { res.status(403).json({ error: 'Not a member of that org' }); return }
    }

    const project = await prisma.project.update({
      where: { id },
      data: { orgId: orgId || null },
      include: { org: { select: { id: true, name: true } } },
    })
    res.json(project)
  } catch (err) {
    console.error('POST /projects/:id/move-to-org error:', err)
    res.status(500).json({ error: 'Failed to update project org' })
  }
}))

export default router
