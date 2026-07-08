import { randomUUID } from 'crypto'
import { Router, Response } from 'express'
import { AllocationMode } from '@prisma/client'
import { prisma } from '../lib/prisma.js'
import { asyncHandler } from '../lib/asyncHandler.js'
import { authenticate, AuthRequest } from '../middleware/auth.js'
import { syncCapacityProfilesForProject } from '../lib/syncCapacityProfiles.js'
import { upsertNRProfileAndProjectLegacy } from '../lib/namedResourceCapacityProfileWrites.js'
import type { NamedResourceCapacityPayload } from '../lib/namedResourceCapacityProfileWrites.js'
import { exitCapacityPlanForManualScheduling } from '../lib/capacityPlanExit.js'

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

  // If RT's allocationMode is not EFFORT, copy the RT's allocation settings as defaults for the new NR
  const rtAllocationMode = rt.allocationMode === 'CAPACITY_PLAN'
    ? 'TIMELINE'
    : rt.allocationMode as AllocationMode
  const rtAllocationPercent = rt.allocationMode === 'CAPACITY_PLAN' ? 100 : (rt.allocationPercent ?? 100)
  const rtAllocationStartWeek = rt.allocationMode === 'CAPACITY_PLAN' ? null : (rt.allocationStartWeek ?? null)
  const rtAllocationEndWeek = rt.allocationMode === 'CAPACITY_PLAN' ? null : (rt.allocationEndWeek ?? null)
  const inheritAllocation = rtAllocationMode !== 'EFFORT'

  const resource = await prisma.$transaction(async tx => {
    if (rt.allocationMode === 'CAPACITY_PLAN') {
      await exitCapacityPlanForManualScheduling(rt.id, tx)
    }

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

    // Build capacity payload from request + inherited RT allocation defaults
    const capacityPayload: NamedResourceCapacityPayload = {
      allocationMode: req.body.allocationMode ?? (inheritAllocation ? rtAllocationMode : undefined),
      allocationPercent: req.body.allocationPercent ?? (inheritAllocation ? rtAllocationPercent : undefined),
      allocationPct: req.body.allocationPct,
      allocationStartWeek: req.body.allocationStartWeek ?? (inheritAllocation ? rtAllocationStartWeek : undefined),
      allocationEndWeek: req.body.allocationEndWeek ?? (inheritAllocation ? rtAllocationEndWeek : undefined),
      startWeek: req.body.startWeek,
      endWeek: req.body.endWeek,
    }

    // Profile-first write + project back to legacy
    const projection = await upsertNRProfileAndProjectLegacy(tx, projectId, created.id, rtId, capacityPayload)

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
    // Sync remaining profiles (role-level, other NRs) for full project reconciliation
    await syncCapacityProfilesForProject(tx, projectId, { preserveNamedResourceIds: [created.id] })


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
  // Capacity payload: request fields take precedence, fall back to existing NR
  const capacityPayload: NamedResourceCapacityPayload = {
    allocationMode: allocationMode ?? existing.allocationMode,
    allocationPercent: allocationPercent ?? existing.allocationPercent,
    allocationPct: allocationPct ?? existing.allocationPct,
    allocationStartWeek: allocationStartWeek ?? existing.allocationStartWeek,
    allocationEndWeek: allocationEndWeek ?? existing.allocationEndWeek,
    startWeek: startWeek ?? existing.startWeek,
    endWeek: endWeek ?? existing.endWeek,
  }

  const resource = await prisma.$transaction(async tx => {
    // Write non-capacity fields first
    await tx.namedResource.update({ where: { id }, data: nrData })
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
    // Sync remaining profiles (role-level, other NRs) for full project reconciliation
    await syncCapacityProfilesForProject(tx, projectId, { preserveNamedResourceIds: [id] })

    await clearWeeklyDemandCache(projectId, tx)
    return updated
  })
  res.json(resource)
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
  const { allocationMode, allocationPercent, allocationStartWeek, allocationEndWeek } = req.body

  const capacityPayload: NamedResourceCapacityPayload = {
    allocationMode: allocationMode ?? existing.allocationMode,
    allocationPercent: allocationPercent ?? existing.allocationPercent,
    allocationStartWeek: allocationStartWeek ?? existing.allocationStartWeek,
    allocationEndWeek: allocationEndWeek ?? existing.allocationEndWeek,
    allocationPct: existing.allocationPct,
    startWeek: existing.startWeek,
    endWeek: existing.endWeek,
  }

  const resource = await prisma.$transaction(async tx => {
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
    // Sync remaining profiles (role-level, other NRs) for full project reconciliation
    await syncCapacityProfilesForProject(tx, projectId, { preserveNamedResourceIds: [id] })

    await clearWeeklyDemandCache(projectId, tx)
    return updated
  })
  res.json(resource)
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
    if (rt.allocationMode === 'CAPACITY_PLAN') {
      await exitCapacityPlanForManualScheduling(rt.id, tx)
    }

    await tx.namedResource.delete({ where: { id } })
    await clearWeeklyDemandCache(projectId, tx)

    // Sync resource type count (can reach 0 when all named resources are deleted)
    const total = await tx.namedResource.count({ where: { resourceTypeId: rtId } })
    await tx.resourceType.update({ where: { id: rtId }, data: { count: total } })

    await syncCapacityProfilesForProject(tx, projectId)
  })

  res.status(204).send()
}))

export default router
