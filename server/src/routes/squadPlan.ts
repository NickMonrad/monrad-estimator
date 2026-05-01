/**
 * squadPlan.ts — Express routes for the Capacity Planner (squad sizing).
 *
 * POST /:projectId/squad-plan          Generate a capacity plan
 * POST /:projectId/squad-plan/apply    Save and activate a plan
 * GET  /:projectId/squad-plans         List plans for a project
 */

import { Router, Response } from 'express'
import { prisma } from '../lib/prisma.js'
import { asyncHandler } from '../lib/asyncHandler.js'
import { authenticate, AuthRequest } from '../middleware/auth.js'
import { ownedProject } from '../lib/ownership.js'
import {
  computeCapacityPlan,
  type CapacityPlanConfig,
} from '../lib/capacity-planner.js'
import type { SchedulerInput, SchedulerResourceType } from '../lib/scheduler.js'

const router = Router({ mergeParams: true })
router.use(authenticate)

// ─────────────────────────────────────────────────────────────────────────────
// Data loader — same pattern as optimiser.ts
// ─────────────────────────────────────────────────────────────────────────────

async function loadSchedulerInput(projectId: string, hoursPerDay: number): Promise<SchedulerInput> {
  const [allEpics, resourceTypes, manualFeatures, manualStories, epicDeps] = await Promise.all([
    prisma.epic.findMany({
      where: { projectId },
      orderBy: { order: 'asc' },
      include: {
        features: {
          orderBy: { order: 'asc' },
          include: {
            userStories: {
              orderBy: { order: 'asc' },
              include: {
                tasks: { include: { resourceType: true } },
                dependencies: true,
              },
            },
            dependencies: true,
          },
        },
      },
    }),
    prisma.resourceType.findMany({
      where: { projectId },
      include: { namedResources: true },
    }),
    prisma.timelineEntry.findMany({
      where: { projectId, isManual: true },
    }),
    prisma.storyTimelineEntry.findMany({
      where: { projectId, isManual: true },
    }),
    prisma.epicDependency.findMany({
      where: { epic: { projectId } },
      select: { epicId: true, dependsOnId: true },
    }),
  ])

  const epics = allEpics
    .filter(e => e.isActive !== false)
    .map(e => ({ ...e, features: e.features.filter(f => f.isActive !== false) }))

  return {
    project: { hoursPerDay },
    epics,
    resourceTypes: resourceTypes as SchedulerResourceType[],
    epicDeps,
    manualFeatureEntries: manualFeatures.map(e => ({
      featureId: e.featureId,
      startWeek: e.startWeek,
      durationWeeks: e.durationWeeks,
    })),
    manualStoryEntries: manualStories.map(e => ({
      storyId: e.storyId,
      startWeek: e.startWeek,
    })),
    resourceLevel: false,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /:projectId/squad-plan/apply
// Register BEFORE the root POST to avoid path ambiguity.
// ─────────────────────────────────────────────────────────────────────────────

router.post('/apply', asyncHandler(async (req: AuthRequest, res: Response) => {
  const projectId = req.params.projectId as string
  const project = await ownedProject(projectId, req.userId!)
  if (!project) { res.status(404).json({ error: 'Project not found' }); return }

  const {
    name,
    targetWeeks,
    periodWeeks,
    maxDelta,
    periods,
    totalCost,
    deliveryWeeks,
    setActive,
  } = req.body as {
    name: string
    targetWeeks: number
    periodWeeks: number
    maxDelta: number
    periods: Array<{
      periodIndex: number
      startWeek: number
      endWeek: number
      entries: Array<{
        resourceTypeId: string
        headcount: number
        demandFTE: number
        utilisationPct: number
      }>
    }>
    totalCost?: number
    deliveryWeeks?: number
    setActive?: boolean
  }

  // ── Validation ──────────────────────────────────────────────────────────
  if (!name || typeof name !== 'string') {
    res.status(400).json({ error: 'name is required' }); return
  }
  if (!Number.isInteger(targetWeeks) || targetWeeks <= 0) {
    res.status(400).json({ error: 'targetWeeks must be a positive integer' }); return
  }
  if (periodWeeks !== 4 && periodWeeks !== 13) {
    res.status(400).json({ error: 'periodWeeks must be 4 or 13' }); return
  }
  if (!Number.isInteger(maxDelta) || maxDelta < 1) {
    res.status(400).json({ error: 'maxDelta must be an integer >= 1' }); return
  }
  if (!Array.isArray(periods) || periods.length === 0) {
    res.status(400).json({ error: 'periods array is required' }); return
  }

  const shouldActivate = setActive ?? true

  // ── 1. Deactivate existing active plans ─────────────────────────────────
  if (shouldActivate) {
    await prisma.capacityPlan.updateMany({
      where: { projectId, isActive: true },
      data: { isActive: false },
    })
  }

  // ── 2. Create the new plan with nested periods & entries ────────────────
  const plan = await prisma.capacityPlan.create({
    data: {
      projectId,
      name,
      targetWeeks,
      periodWeeks,
      maxDelta,
      isActive: shouldActivate,
      totalCost,
      deliveryWeeks,
      periods: {
        create: periods.map(p => ({
          periodIndex: p.periodIndex,
          startWeek: p.startWeek,
          endWeek: p.endWeek,
          entries: {
            create: p.entries.map(e => ({
              resourceTypeId: e.resourceTypeId,
              headcount: e.headcount,
              demandFTE: e.demandFTE,
              utilisationPct: e.utilisationPct,
            })),
          },
        })),
      },
    },
    include: { periods: { include: { entries: true } } },
  })

  // ── 3. Update allocation mode on resource types in the plan ─────────────
  if (shouldActivate) {
    const rtIds = [...new Set(periods.flatMap(p => p.entries.map(e => e.resourceTypeId)))]
    await prisma.resourceType.updateMany({
      where: { id: { in: rtIds }, projectId },
      data: { allocationMode: 'CAPACITY_PLAN' },
    })
  }

  res.status(201).json(plan)
}))

// ─────────────────────────────────────────────────────────────────────────────
// POST /:projectId/squad-plan — Generate a capacity plan
// ─────────────────────────────────────────────────────────────────────────────

router.post('/', asyncHandler(async (req: AuthRequest, res: Response) => {
  const projectId = req.params.projectId as string
  const project = await ownedProject(projectId, req.userId!)
  if (!project) { res.status(404).json({ error: 'Project not found' }); return }

  const body = req.body as {
    targetDurationWeeks?: number
    periodWeeks?: number
    maxDeltaPerPeriod?: number
    minFloor?: Record<string, number>
    maxBudget?: number
  }

  // ── Validation ──────────────────────────────────────────────────────────
  const targetDurationWeeks = body.targetDurationWeeks
  if (typeof targetDurationWeeks !== 'number' || targetDurationWeeks <= 0) {
    res.status(400).json({ error: 'targetDurationWeeks is required and must be > 0' }); return
  }

  const periodWeeks = body.periodWeeks
  if (periodWeeks !== 4 && periodWeeks !== 13) {
    res.status(400).json({ error: 'periodWeeks is required and must be 4 or 13' }); return
  }

  const maxDeltaPerPeriod = body.maxDeltaPerPeriod ?? 1
  if (!Number.isInteger(maxDeltaPerPeriod) || maxDeltaPerPeriod < 1) {
    res.status(400).json({ error: 'maxDeltaPerPeriod must be an integer >= 1' }); return
  }

  // ── Load scheduler input ────────────────────────────────────────────────
  const schedulerInput = await loadSchedulerInput(projectId, project.hoursPerDay)

  // ── Build minFloor map ──────────────────────────────────────────────────
  const minFloor = new Map<string, number>()
  if (body.minFloor) {
    for (const [rtId, floor] of Object.entries(body.minFloor)) {
      minFloor.set(rtId, floor)
    }
  }
  // Default floor of 1 for all resource types not explicitly set
  for (const rt of schedulerInput.resourceTypes) {
    if (!minFloor.has(rt.id)) {
      minFloor.set(rt.id, 1)
    }
  }

  // ── Build day rates from resource types ─────────────────────────────────
  const dayRates = new Map<string, number>()
  const rtsWithRates = await prisma.resourceType.findMany({
    where: { projectId, dayRate: { not: null } },
    select: { id: true, dayRate: true },
  })
  for (const rt of rtsWithRates) {
    if (rt.dayRate != null && rt.dayRate > 0) {
      dayRates.set(rt.id, rt.dayRate)
    }
  }

  // ── Build config & run planner ──────────────────────────────────────────
  const config: CapacityPlanConfig = {
    targetDurationWeeks,
    periodWeeks,
    maxDeltaPerPeriod,
    minFloor,
    dayRates,
    maxBudget: body.maxBudget,
  }

  const result = computeCapacityPlan(schedulerInput, config)

  // ── Serialise LevellingResult Maps for JSON transport ───────────────────
  res.json({
    ...result,
    levellingResult: {
      ...result.levellingResult,
      epicStartWeeks: Object.fromEntries(result.levellingResult.epicStartWeeks),
      featureStartWeeks: Object.fromEntries(result.levellingResult.featureStartWeeks),
    },
  })
}))

// ─────────────────────────────────────────────────────────────────────────────
// GET /:projectId/squad-plans — List plans
// ─────────────────────────────────────────────────────────────────────────────

router.get('/', asyncHandler(async (req: AuthRequest, res: Response) => {
  const projectId = req.params.projectId as string
  const project = await ownedProject(projectId, req.userId!)
  if (!project) { res.status(404).json({ error: 'Project not found' }); return }

  const plans = await prisma.capacityPlan.findMany({
    where: { projectId },
    include: {
      periods: {
        include: { entries: true },
        orderBy: { periodIndex: 'asc' },
      },
    },
    orderBy: { createdAt: 'desc' },
  })

  res.json({ plans })
}))

export default router
