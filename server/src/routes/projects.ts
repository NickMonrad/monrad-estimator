import { Router, Response } from 'express'
import { prisma } from '../lib/prisma.js'
import { authenticate, AuthRequest } from '../middleware/auth.js'

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
router.get('/', async (req: AuthRequest, res: Response) => {
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
})

// Update project tax settings
router.patch('/:id/tax', async (req: AuthRequest, res: Response) => {
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
})

// Clone project — deep copy (specific route before /:id)
router.post('/:id/clone', async (req: AuthRequest, res: Response) => {
  const source = await prisma.project.findFirst({
    where: { id: req.params.id as string, ownerId: req.userId },
    include: {
      resourceTypes: { include: { namedResources: true } },
      overheads: true,
      discounts: true,
      epics: {
        include: {
          features: {
            include: {
              userStories: {
                include: { tasks: true },
              },
            },
          },
        },
      },
    },
  })
  if (!source) { res.status(404).json({ error: 'Not found' }); return }

  // Build resource type id map: old id → new id
  const rtIdMap = new Map<string, string>()

  const newProject = await prisma.project.create({
    data: {
      name: `Copy of ${source.name}`,
      description: source.description,
      customerId: source.customerId,
      orgId: source.orgId,
      status: 'DRAFT',
      hoursPerDay: source.hoursPerDay,
      bufferWeeks: source.bufferWeeks,
      startDate: source.startDate,
      taxRate: source.taxRate,
      taxLabel: source.taxLabel,
      ownerId: req.userId!,
    },
  })

  // Copy resource types
  for (const rt of source.resourceTypes) {
    const newRt = await prisma.resourceType.create({
      data: {
        name: rt.name,
        category: rt.category,
        count: rt.count,
        hoursPerDay: rt.hoursPerDay,
        dayRate: rt.dayRate,
        allocationMode: rt.allocationMode,
        allocationPercent: rt.allocationPercent,
        allocationStartWeek: rt.allocationStartWeek,
        allocationEndWeek: rt.allocationEndWeek,
        proposedName: rt.proposedName,
        globalTypeId: rt.globalTypeId,
        projectId: newProject.id,
      },
    })
    rtIdMap.set(rt.id, newRt.id)

    // Copy named resources
    for (const nr of rt.namedResources) {
      await prisma.namedResource.create({
        data: {
          name: nr.name,
          startWeek: nr.startWeek,
          endWeek: nr.endWeek,
          allocationPct: nr.allocationPct,
          allocationMode: nr.allocationMode,
          allocationPercent: nr.allocationPercent,
          allocationStartWeek: nr.allocationStartWeek,
          allocationEndWeek: nr.allocationEndWeek,
          pricingModel: nr.pricingModel,
          resourceTypeId: newRt.id,
        },
      })
    }
  }

  // Copy overheads
  for (const oh of source.overheads) {
    await prisma.projectOverhead.create({
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
    await prisma.projectDiscount.create({
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

  // Copy epics → features → stories → tasks
  for (const epic of source.epics) {
    const newEpic = await prisma.epic.create({
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

    for (const feature of epic.features) {
      const newFeature = await prisma.feature.create({
        data: {
          name: feature.name,
          description: feature.description,
          assumptions: feature.assumptions,
          order: feature.order,
          isActive: feature.isActive,
          epicId: newEpic.id,
        },
      })

      for (const story of feature.userStories) {
        const newStory = await prisma.userStory.create({
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

        for (const task of story.tasks) {
          await prisma.task.create({
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

  const result = await prisma.project.findFirst({
    where: { id: newProject.id },
    include: { resourceTypes: true, _count: { select: { epics: true } } },
  })
  res.status(201).json(result)
})

// Restore soft-deleted project (specific route before /:id)
router.post('/:id/restore', async (req: AuthRequest, res: Response) => {
  const existing = await prisma.project.findFirst({
    where: { id: req.params.id as string, ownerId: req.userId, deletedAt: { not: null } },
  })
  if (!existing) { res.status(404).json({ error: 'Not found' }); return }
  const project = await prisma.project.update({
    where: { id: req.params.id as string },
    data: { deletedAt: null },
  })
  res.json(project)
})

// Permanent (hard) delete — for archived projects
router.delete('/:id/permanent', async (req: AuthRequest, res: Response) => {
  const existing = await ownedProject(req.params.id as string, req.userId!)
  if (!existing) { res.status(404).json({ error: 'Not found' }); return }
  await prisma.project.delete({ where: { id: req.params.id as string } })
  res.json({ message: 'Project permanently deleted' })
})

// Get single project
router.get('/:id', async (req: AuthRequest, res: Response) => {
  const project = await canAccessProject(req.params.id as string, req.userId!)
  if (!project) { res.status(404).json({ error: 'Not found' }); return }
  res.json(project)
})

// Create project
router.post('/', async (req: AuthRequest, res: Response) => {
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

  const project = await prisma.project.create({
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
  res.status(201).json(project)
})

// Partial update project (e.g. bufferWeeks, onboardingWeeks, hoursPerDay)
router.patch('/:id', async (req: AuthRequest, res: Response) => {
  const existing = await ownedProject(req.params.id as string, req.userId!)
  if (!existing) { res.status(404).json({ error: 'Not found' }); return }
  const data: Record<string, unknown> = {}
  if (req.body.bufferWeeks !== undefined) data.bufferWeeks = parseInt(req.body.bufferWeeks) ?? 0
  if (req.body.onboardingWeeks !== undefined) data.onboardingWeeks = parseInt(req.body.onboardingWeeks) ?? 0
  if (req.body.hoursPerDay !== undefined) data.hoursPerDay = req.body.hoursPerDay
  if (req.body.name !== undefined) data.name = req.body.name
  if (req.body.status !== undefined) data.status = req.body.status
  const project = await prisma.project.update({ where: { id: req.params.id as string }, data })
  res.json(project)
})

// Update project
router.put('/:id', async (req: AuthRequest, res: Response) => {
  const { name, description, status, hoursPerDay, taxRate, taxLabel } = req.body
  const customerId = req.body.customerId !== undefined ? (req.body.customerId || null) : undefined
  const bufferWeeks = req.body.bufferWeeks !== undefined ? (parseInt(req.body.bufferWeeks) ?? 0) : undefined
  const onboardingWeeks = req.body.onboardingWeeks !== undefined ? (parseInt(req.body.onboardingWeeks) ?? 0) : undefined
  const existing = await ownedProject(req.params.id as string, req.userId!)
  if (!existing) { res.status(404).json({ error: 'Not found' }); return }
  const project = await prisma.project.update({
    where: { id: req.params.id as string },
    data: { name, description, ...(customerId !== undefined && { customerId }), status, hoursPerDay, taxRate, taxLabel, ...(bufferWeeks !== undefined && { bufferWeeks }), ...(onboardingWeeks !== undefined && { onboardingWeeks }) },
  })
  res.json(project)
})

// Soft-delete project (sets deletedAt)
router.delete('/:id', async (req: AuthRequest, res: Response) => {
  const existing = await ownedProject(req.params.id as string, req.userId!)
  if (!existing) { res.status(404).json({ error: 'Not found' }); return }
  await prisma.project.update({ where: { id: req.params.id as string }, data: { deletedAt: new Date() } })
  res.json({ message: 'Project archived' })
})

// POST /api/projects/:id/move-to-org
router.post('/:id/move-to-org', async (req: AuthRequest, res: Response) => {
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
})

export default router
