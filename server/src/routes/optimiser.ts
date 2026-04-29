/**
 * optimiser.ts — Express routes for the Resource Optimiser (Phase 3, issue #233).
 *
 * POST /api/projects/:projectId/optimise
 *   Run the optimiser search and return ranked candidates.
 *
 * POST /api/projects/:projectId/optimise/apply
 *   Apply a candidate scenario: snapshot → update RT counts + NR start weeks
 *   → re-materialise timeline → return snapshotId for "Undo" link.
 */

import { Router, Response } from 'express'
import { prisma } from '../lib/prisma.js'
import { asyncHandler } from '../lib/asyncHandler.js'
import { authenticate, AuthRequest } from '../middleware/auth.js'
import { ownedProject } from '../lib/ownership.js'
import { buildSnapshot } from './snapshots.js'
import { pruneSnapshots } from '../lib/snapshotUtils.js'
import {
  runScheduler,
  type SchedulerInput,
  type SchedulerResourceType,
} from '../lib/scheduler.js'
import {
  runOptimiser,
  type OptimiserConfig,
  type OptimiserMode,
  type OptimiserCandidate,
} from '../lib/optimiser.js'

const router = Router({ mergeParams: true })
router.use(authenticate)

// ─────────────────────────────────────────────────────────────────────────────
// Data loader — same pattern as POST /timeline/schedule
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

  // Filter out inactive epics and features (mirror POST /schedule behaviour)
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
// POST /api/projects/:projectId/optimise/apply
// Register BEFORE the root POST to avoid path ambiguity.
// ─────────────────────────────────────────────────────────────────────────────

router.post('/apply', asyncHandler(async (req: AuthRequest, res: Response) => {
  const projectId = req.params.projectId as string
  const project = await ownedProject(projectId, req.userId!)
  if (!project) { res.status(404).json({ error: 'Project not found' }); return }

  // Expected body: { resourceTypes: [{ resourceTypeId, count, suggestedStartWeek }] }
  const { resourceTypes: candidateRTs } = req.body as {
    resourceTypes: Array<{ resourceTypeId: string; count: number; suggestedStartWeek: number }>
  }
  if (!Array.isArray(candidateRTs) || candidateRTs.length === 0) {
    res.status(400).json({ error: 'resourceTypes array is required' }); return
  }

  // ── 1. Create pre-apply snapshot for undo support ─────────────────────────
  const snapshotData = await buildSnapshot(projectId)
  const dateStr = new Date().toISOString().slice(0, 10)
  const snap = await prisma.backlogSnapshot.create({
    data: {
      projectId,
      label: `Auto-saved before optimiser apply — ${dateStr}`,
      trigger: 'optimiser_apply',
      snapshot: snapshotData as unknown as object,
      createdById: req.userId!,
    },
    select: { id: true, label: true, trigger: true, createdAt: true },
  })
  await pruneSnapshots(prisma, projectId)

  // ── 2. Load full scheduler input BEFORE transaction (reads are outside tx) ─
  const schedulerInput = await loadSchedulerInput(projectId, project.hoursPerDay)

  // ── 3. Transaction: update counts + start weeks + materialise timeline ─────
  const countMap = new Map(candidateRTs.map(rt => [rt.resourceTypeId, rt.count]))
  const startWeekMap = new Map(candidateRTs.map(rt => [rt.resourceTypeId, rt.suggestedStartWeek]))

  await prisma.$transaction(async tx => {
    // 3a. Update ResourceType counts
    for (const [rtId, count] of countMap) {
      await tx.resourceType.update({ where: { id: rtId }, data: { count } })
    }

    // 3b. Update NamedResource.startWeek for ramp-up (only when > 0 to avoid
    //     accidentally zeroing out NRs that were already at week 0)
    for (const [rtId, startWeek] of startWeekMap) {
      if (startWeek > 0) {
        await tx.namedResource.updateMany({
          where: { resourceTypeId: rtId },
          data: { startWeek },
        })
      }
    }

    // 3c. Prepare updated SchedulerInput with new counts
    const updatedRTs = schedulerInput.resourceTypes.map(rt => ({
      ...rt,
      count: countMap.get(rt.id) ?? rt.count,
    })) as SchedulerResourceType[]

    const { featureSchedule, storySchedule } = runScheduler({
      ...schedulerInput,
      resourceTypes: updatedRTs,
      resourceLevel: false,
    })

    // 3d. Rewrite non-manual timeline entries (preserve manual pins)
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

    // 3e. Rewrite non-manual story entries
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

  res.status(200).json({
    message: 'Optimiser scenario applied successfully',
    snapshotId: snap.id,
  })
}))

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/projects/:projectId/optimise
// ─────────────────────────────────────────────────────────────────────────────

router.post('/', asyncHandler(async (req: AuthRequest, res: Response) => {
  const projectId = req.params.projectId as string
  const project = await ownedProject(projectId, req.userId!)
  if (!project) { res.status(404).json({ error: 'Project not found' }); return }

  // ── 1. Parse request body ─────────────────────────────────────────────────
  const body = req.body as {
    mode?: OptimiserMode
    constraints?: {
      countRanges?: Array<{ resourceTypeId: string; min: number; max: number }>
      allowRampUp?: boolean
      maxBudget?: number
      maxDurationWeeks?: number
    }
    /** JSON object: { [resourceTypeId]: dayRate } */
    dayRates?: Record<string, number>
    topN?: number
  }

  const mode: OptimiserMode = body.mode ?? 'balanced'
  if (!['speed', 'utilisation', 'balanced'].includes(mode)) {
    res.status(400).json({ error: 'mode must be speed, utilisation, or balanced' }); return
  }

  const topN = typeof body.topN === 'number' && body.topN > 0 ? body.topN : 5

  // ── 2. Load scheduler input ───────────────────────────────────────────────
  const schedulerInput = await loadSchedulerInput(projectId, project.hoursPerDay)

  // ── 3. Build countRanges (from request or sensible defaults: current ± 2, min 1, max 6) ──
  const countRanges: Array<{ resourceTypeId: string; min: number; max: number }> =
    body.constraints?.countRanges ??
    schedulerInput.resourceTypes.map(rt => ({
      resourceTypeId: rt.id,
      min: Math.max(1, rt.count - 2),
      max: Math.min(6, rt.count + 2),
    }))

  // ── 4. Build day rates ────────────────────────────────────────────────────
  // Phase 3: use ResourceType.dayRate directly (each RT stores its own rate).
  // Rate-card-based rates are a Phase 4 enhancement.
  // Caller can override via request body.dayRates.
  let dayRates: Map<string, number> | undefined

  if (body.dayRates && Object.keys(body.dayRates).length > 0) {
    dayRates = new Map(Object.entries(body.dayRates).map(([k, v]) => [k, Number(v)]))
  } else {
    // Fall back to ResourceType.dayRate stored on each RT
    const rtsWithRates = await prisma.resourceType.findMany({
      where: { projectId, dayRate: { not: null } },
      select: { id: true, dayRate: true },
    })
    const rtDayRates = rtsWithRates
      .filter((rt): rt is typeof rt & { dayRate: number } => rt.dayRate != null && rt.dayRate > 0)
    if (rtDayRates.length > 0) {
      dayRates = new Map(rtDayRates.map(rt => [rt.id, rt.dayRate]))
    }
    // If no rates found at all, dayRates stays undefined → estimatedCost = 0 everywhere
  }

  // ── 5. Build OptimiserConfig ──────────────────────────────────────────────
  const config: OptimiserConfig = {
    mode,
    constraints: {
      countRanges,
      allowRampUp: body.constraints?.allowRampUp ?? false,
      maxBudget: body.constraints?.maxBudget,
      maxDurationWeeks: body.constraints?.maxDurationWeeks,
    },
    dayRates,
    topN,
  }

  // ── 6. Run the optimiser ──────────────────────────────────────────────────
  const result = runOptimiser(schedulerInput, config)

  // ── 7. Serialise Maps to plain objects for JSON transport ─────────────────
  // Maps don't serialise automatically; convert to { [rtName]: count } objects.
  const serialiseCandidate = (c: OptimiserCandidate) => ({
    ...c,
    metrics: {
      ...c.metrics,
      gapWeeksByType: Object.fromEntries(c.metrics.gapWeeksByType),
    },
  })

  res.json({
    candidates: result.candidates.map(serialiseCandidate),
    baseline: serialiseCandidate(result.baseline),
    searchStats: result.searchStats,
  })
}))

export default router
