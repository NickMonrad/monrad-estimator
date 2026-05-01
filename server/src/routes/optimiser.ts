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
import { runSAPlanner } from '../lib/sa-planner.js'
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

  // Expected body: { resourceTypes: [{ resourceTypeId, count, suggestedStartWeek }], staggerEpics?: boolean }
  const { resourceTypes: candidateRTs, staggerEpics } = req.body as {
    resourceTypes: Array<{ resourceTypeId: string; count: number; suggestedStartWeek: number }>
    staggerEpics?: boolean
  }
  if (!Array.isArray(candidateRTs) || candidateRTs.length === 0) {
    res.status(400).json({ error: 'resourceTypes array is required' }); return
  }

  // Fix 4: element-level validation — run BEFORE snapshot to avoid wasteful writes
  const invalid = candidateRTs.some(
    r => typeof r.resourceTypeId !== 'string'
      || !Number.isInteger(r.count) || r.count < 1
      || typeof r.suggestedStartWeek !== 'number' || r.suggestedStartWeek < 0,
  )
  if (invalid) {
    res.status(400).json({ error: 'Invalid resourceTypes element' }); return
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

    // 3c. Prepare updated SchedulerInput with new counts AND new namedResource startWeeks.
    // Fix: the DB is updated in 3b but the in-memory schedulerInput still holds the old
    // startWeek values loaded before the transaction — override them here so the scheduler
    // call materialises the timeline with the correct ramp-up start week.
    const updatedRTs = schedulerInput.resourceTypes.map(rt => {
      const newCount = countMap.get(rt.id) ?? rt.count
      const newStartWeek = startWeekMap.get(rt.id)
      return {
        ...rt,
        count: newCount,
        namedResources: newStartWeek !== undefined && newStartWeek > 0
          ? rt.namedResources.map(nr => ({ ...nr, startWeek: newStartWeek }))
          : rt.namedResources,
      }
    }) as SchedulerResourceType[]

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

  // ── 4. Optional: stagger epics to level demand ────────────────────────────
  let levellingResult: { epicStartWeeks: Map<string, number>; featureStartWeeks: Map<string, number>; totalDeliveryWeeks: number; peakUtilisationPct: number } | null = null

  if (staggerEpics) {
    // Re-load scheduler input (counts/NRs are now updated in DB)
    const updatedInput = await loadSchedulerInput(projectId, project.hoursPerDay)

    // Use SA planner for optimised staggering
    const saResult = runSAPlanner(updatedInput, {
      targetDurationWeeks: updatedInput.epics.length * 13, // reasonable default
      maxParallelismPerFeature: 2,
    })
    levellingResult = {
      epicStartWeeks: saResult.epicStartWeeks,
      featureStartWeeks: saResult.featureStartWeeks,
      totalDeliveryWeeks: saResult.totalDeliveryWeeks,
      peakUtilisationPct: saResult.peakUtilisationPct,
    }

    // Persist levelled start weeks
    await Promise.all(
      Array.from(levellingResult.epicStartWeeks.entries()).map(([epicId, startWeek]) =>
        prisma.epic.update({ where: { id: epicId }, data: { timelineStartWeek: startWeek } })
      )
    )

    // Re-run scheduler with levelled start weeks and re-materialise
    const levelledEpics = updatedInput.epics.map(e => ({
      ...e,
      timelineStartWeek: levellingResult!.epicStartWeeks.get(e.id) ?? e.timelineStartWeek,
    }))

    const { featureSchedule: lfs, storySchedule: lss } = runScheduler({
      ...updatedInput,
      epics: levelledEpics,
    })

    await prisma.$transaction(async tx => {
      await tx.timelineEntry.deleteMany({ where: { projectId, isManual: false } })
      const fRows = lfs
        .filter(e => !e.isManual)
        .map(e => ({ projectId, featureId: e.featureId, startWeek: e.startWeek, durationWeeks: e.durationWeeks, isManual: false }))
      if (fRows.length > 0) await tx.timelineEntry.createMany({ data: fRows, skipDuplicates: true })

      await tx.storyTimelineEntry.deleteMany({ where: { projectId, isManual: false } })
      const sRows = lss
        .filter(e => !e.isManual)
        .map(e => ({ projectId, storyId: e.storyId, startWeek: e.startWeek, durationWeeks: e.durationWeeks, isManual: false }))
      if (sRows.length > 0) await tx.storyTimelineEntry.createMany({ data: sRows, skipDuplicates: true })
    })
  }

  const responseBody: {
    message: string
    snapshotId: string
    levellingResult?: { epicStartWeeks: Record<string, number>; totalDeliveryWeeks: number; peakUtilisationPct: number }
  } = {
    message: 'Optimiser scenario applied successfully',
    snapshotId: snap.id,
  }

  if (levellingResult) {
    responseBody.levellingResult = {
      epicStartWeeks: Object.fromEntries(levellingResult.epicStartWeeks),
      totalDeliveryWeeks: levellingResult.totalDeliveryWeeks,
      peakUtilisationPct: levellingResult.peakUtilisationPct,
    }
  }

  res.status(200).json(responseBody)
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
      minDurationWeeks?: number
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
      minDurationWeeks: body.constraints?.minDurationWeeks,
    },
    dayRates,
    topN,
  }

  // ── 6. Run the optimiser ──────────────────────────────────────────────────
  const result = runOptimiser(schedulerInput, config)

  // ── 7. Serialise Maps to plain objects for JSON transport ─────────────────
  // Maps don't serialise automatically; convert to { [rtId]: count } objects.
  // gapWeeksByResourceTypeId is keyed by resourceTypeId; include a resourceTypes
  // lookup in the response so consumers can map ids → names without a second fetch.
  const serialiseCandidate = (c: OptimiserCandidate) => ({
    ...c,
    metrics: {
      ...c.metrics,
      gapWeeksByResourceTypeId: Object.fromEntries(c.metrics.gapWeeksByResourceTypeId),
    },
  })

  res.json({
    candidates: result.candidates.map(serialiseCandidate),
    baseline: serialiseCandidate(result.baseline),
    searchStats: result.searchStats,
    infeasibleCount: result.infeasibleCount,
    /** Lookup table: id → name for gapWeeksByResourceTypeId consumers */
    resourceTypes: schedulerInput.resourceTypes.map(rt => ({ id: rt.id, name: rt.name })),
  })
}))

export default router
