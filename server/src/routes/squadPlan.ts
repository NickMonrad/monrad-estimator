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
import { buildSnapshot } from './snapshots.js'
import { pruneSnapshots } from '../lib/snapshotUtils.js'
import { runScheduler, type SchedulerInput, type SchedulerResourceType } from '../lib/scheduler.js'
import { levelEpicStarts } from '../lib/leveller.js'
import {
  computeCapacityPlan,
  type CapacityPlanConfig,
} from '../lib/capacity-planner.js'

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
    levellingResult: clientLevellingResult,
    maxParallelismPerFeature: clientMaxParallelism,
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
    levellingResult?: {
      epicStartWeeks: Record<string, number>
      featureStartWeeks: Record<string, number>
      totalDeliveryWeeks: number
      peakUtilisationPct: number
    }
    maxParallelismPerFeature?: number
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

  // ── 1. Create pre-apply snapshot for undo ───────────────────────────────
  const snapshotData = await buildSnapshot(projectId)
  const dateStr = new Date().toISOString().slice(0, 10)
  await prisma.backlogSnapshot.create({
    data: {
      projectId,
      label: `Auto-saved before squad plan apply — ${dateStr}`,
      trigger: 'optimiser_apply',
      snapshot: snapshotData as unknown as object,
      createdById: req.userId!,
    },
  })
  await pruneSnapshots(prisma, projectId)

  // ── 2. Deactivate existing active plans ─────────────────────────────────
  if (shouldActivate) {
    await prisma.capacityPlan.updateMany({
      where: { projectId, isActive: true },
      data: { isActive: false },
    })
  }

  // ── 3. Create the new plan with nested periods & entries ────────────────
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

  // ── 4. Update RT counts + allocation mode, re-run scheduler ─────────────
  if (shouldActivate) {
    // Compute max headcount per RT across all periods
    const maxHeadcountByRt = new Map<string, number>()
    for (const p of periods) {
      for (const e of p.entries) {
        const current = maxHeadcountByRt.get(e.resourceTypeId) ?? 0
        maxHeadcountByRt.set(e.resourceTypeId, Math.max(current, e.headcount))
      }
    }

    // Update RT counts and allocation mode
    for (const [rtId, count] of maxHeadcountByRt) {
      await prisma.resourceType.update({
        where: { id: rtId },
        data: { count, allocationMode: 'CAPACITY_PLAN' },
      })
    }

    // Update named resources allocation mode too
    const rtIds = [...maxHeadcountByRt.keys()]
    await prisma.namedResource.updateMany({
      where: { resourceTypeId: { in: rtIds } },
      data: { allocationMode: 'CAPACITY_PLAN' },
    })

    // Auto-create missing Named Resources to match new RT counts
    for (const [rtId, targetCount] of maxHeadcountByRt) {
      const existingNRs = await prisma.namedResource.findMany({
        where: { resourceTypeId: rtId },
        select: { id: true },
      })
      const missing = targetCount - existingNRs.length
      if (missing > 0) {
        // Get RT name for naming convention
        const rt = await prisma.resourceType.findUnique({
          where: { id: rtId },
          select: { name: true },
        })
        const baseName = rt?.name ?? 'Resource'
        const startIndex = existingNRs.length + 1
        const newNRs = Array.from({ length: missing }, (_, i) => ({
          resourceTypeId: rtId,
          name: `${baseName} ${startIndex + i}`,
          allocationMode: 'CAPACITY_PLAN' as const,
          startWeek: 0,
        }))
        await prisma.namedResource.createMany({ data: newNRs })
      }
    }

    // ── 5. Materialise timeline using the projected schedule ───────────────

    if (clientLevellingResult?.featureStartWeeks && Object.keys(clientLevellingResult.featureStartWeeks).length > 0) {
      // ── Direct persistence path: use SA's featureStartWeeks as-is ──────
      const maxParallelism = clientMaxParallelism ?? 2

      // Persist epic start weeks
      const epicStartWeeks = new Map(
        Object.entries(clientLevellingResult.epicStartWeeks).map(([k, v]) => [k, Number(v)])
      )
      await Promise.all(
        Array.from(epicStartWeeks.entries()).map(([epicId, startWeek]) =>
          prisma.epic.update({ where: { id: epicId }, data: { timelineStartWeek: startWeek } })
        )
      )

      // Load features with stories/tasks to compute durations
      const allEpics = await prisma.epic.findMany({
        where: { projectId },
        include: {
          features: {
            include: {
              userStories: {
                include: { tasks: { include: { resourceType: true } } },
              },
            },
          },
        },
      })

      const resourceTypes = await prisma.resourceType.findMany({ where: { projectId } })
      const rtById = new Map(resourceTypes.map(rt => [rt.id, rt]))
      const hpd = project.hoursPerDay

      // Compute feature durations using the same formula as the SA planner
      const featureStartWeeks = clientLevellingResult.featureStartWeeks
      const featureRows: Array<{
        projectId: string; featureId: string; startWeek: number; durationWeeks: number; isManual: false
      }> = []
      const storyRows: Array<{
        projectId: string; storyId: string; startWeek: number; durationWeeks: number; isManual: false
      }> = []

      for (const epic of allEpics) {
        for (const feature of epic.features) {
          if (feature.isActive === false) continue
          const startWeek = featureStartWeeks[feature.id]
          if (startWeek == null) continue

          // Compute demand per RT (same as sa-planner.ts lines 104-112)
          const demandByRt = new Map<string, number>()
          const activeStories = feature.userStories.filter(s => s.isActive !== false)
          for (const story of activeStories) {
            for (const task of story.tasks) {
              if (!task.resourceTypeId) continue
              const rtHpd = task.resourceType?.hoursPerDay ?? hpd
              const days = task.durationDays ?? (task.hoursEffort / rtHpd)
              demandByRt.set(task.resourceTypeId, (demandByRt.get(task.resourceTypeId) ?? 0) + days)
            }
          }

          // Duration = max across RTs of (totalDays / min(count, maxParallelism) / 5)
          let maxWeeks = 0.2
          for (const [rtId, totalDays] of demandByRt) {
            const rt = rtById.get(rtId)
            if (!rt) continue
            const parallelism = Math.min(rt.count, maxParallelism)
            const weeks = totalDays / parallelism / 5
            if (weeks > maxWeeks) maxWeeks = weeks
          }
          const durationWeeks = Math.max(1, Math.ceil(maxWeeks))

          featureRows.push({
            projectId,
            featureId: feature.id,
            startWeek: Number(startWeek),
            durationWeeks,
            isManual: false as const,
          })

          // Create story-level entries: each story starts at parent feature's start
          // with proportional duration based on its share of total effort
          const totalFeatureDays = Array.from(demandByRt.values()).reduce((sum, d) => sum + d, 0)
          for (const story of activeStories) {
            let storyDays = 0
            for (const task of story.tasks) {
              if (!task.resourceTypeId) continue
              const rtHpd = task.resourceType?.hoursPerDay ?? hpd
              storyDays += task.durationDays ?? (task.hoursEffort / rtHpd)
            }
            const proportion = totalFeatureDays > 0 ? storyDays / totalFeatureDays : 0
            const storyDuration = Math.max(1, Math.ceil(durationWeeks * proportion))
            storyRows.push({
              projectId,
              storyId: story.id,
              startWeek: Number(startWeek),
              durationWeeks: storyDuration,
              isManual: false as const,
            })
          }
        }
      }

      // Persist timeline entries
      await prisma.$transaction(async tx => {
        await tx.timelineEntry.deleteMany({ where: { projectId, isManual: false } })
        if (featureRows.length > 0) {
          await tx.timelineEntry.createMany({ data: featureRows, skipDuplicates: true })
        }
        await tx.storyTimelineEntry.deleteMany({ where: { projectId, isManual: false } })
        if (storyRows.length > 0) {
          await tx.storyTimelineEntry.createMany({ data: storyRows, skipDuplicates: true })
        }
      })
    } else {
      // ── Legacy fallback: re-run scheduler ──────────────────────────────
      const schedulerInput = await loadSchedulerInput(projectId, project.hoursPerDay)

      let epicStartWeeks: Map<string, number>
      if (clientLevellingResult?.epicStartWeeks) {
        epicStartWeeks = new Map(Object.entries(clientLevellingResult.epicStartWeeks).map(([k, v]) => [k, Number(v)]))
      } else {
        const levelResult = levelEpicStarts(schedulerInput)
        epicStartWeeks = levelResult.epicStartWeeks
      }

      // Persist levelled epic start weeks
      await Promise.all(
        Array.from(epicStartWeeks.entries()).map(([epicId, startWeek]) =>
          prisma.epic.update({ where: { id: epicId }, data: { timelineStartWeek: startWeek } })
        )
      )

      // Prepare levelled epics for scheduler
      const levelledEpics = schedulerInput.epics.map(e => ({
        ...e,
        timelineStartWeek: epicStartWeeks.get(e.id) ?? e.timelineStartWeek,
      }))

      // Run scheduler with levelled start weeks
      const { featureSchedule, storySchedule } = runScheduler({
        ...schedulerInput,
        epics: levelledEpics,
      })

      // Materialise timeline entries
      await prisma.$transaction(async tx => {
        await tx.timelineEntry.deleteMany({ where: { projectId, isManual: false } })
        const featureRows = featureSchedule
          .filter(e => !e.isManual)
          .map(e => ({
            projectId,
            featureId: e.featureId,
            startWeek: e.startWeek,
            durationWeeks: e.durationWeeks,
            isManual: false,
          }))
        if (featureRows.length > 0) {
          await tx.timelineEntry.createMany({ data: featureRows, skipDuplicates: true })
        }

        await tx.storyTimelineEntry.deleteMany({ where: { projectId, isManual: false } })
        const storyRows = storySchedule
          .filter(e => !e.isManual)
          .map(e => ({
            projectId,
            storyId: e.storyId,
            startWeek: e.startWeek,
            durationWeeks: e.durationWeeks,
            isManual: false,
          }))
        if (storyRows.length > 0) {
          await tx.storyTimelineEntry.createMany({ data: storyRows, skipDuplicates: true })
        }
      })
    }
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
    maxCap?: Record<string, number>
    maxBudget?: number
    maxAllocationBufferPct?: number
    maxParallelismPerFeature?: number
    maxConcurrentEpics?: number
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
    maxCap: body.maxCap ? new Map(Object.entries(body.maxCap).map(([k, v]) => [k, Number(v)])) : undefined,
    dayRates,
    maxBudget: body.maxBudget,
    maxAllocationBufferPct: body.maxAllocationBufferPct,
    maxParallelismPerFeature: body.maxParallelismPerFeature,
    maxConcurrentEpics: body.maxConcurrentEpics,
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
