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
import {
  type SchedulerInput,
  type SchedulerResourceType,
} from '../lib/scheduler.js'
import {
  runOptimiser,
  type OptimiserConfig,
  type OptimiserMode,
  type OptimiserCandidate,
} from '../lib/optimiser.js'
import {
  applyOptimiserCandidate,
  OptimiserApplyConflictError,
  type ApplyCandidateResourceType,
} from '../lib/optimiserApplyService.js'


interface RequestedCountRange {
  resourceTypeId: string
  min: number
  max: number
}

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

function buildDefaultCountRanges(
  resourceTypes: SchedulerResourceType[],
): RequestedCountRange[] {
  return resourceTypes.map(rt => ({
    resourceTypeId: rt.id,
    min: Math.max(1, rt.count - 2),
    max: Math.min(6, rt.count + 2),
  }))
}

function sanitiseCountRanges(
  requestedRanges: RequestedCountRange[] | undefined,
  resourceTypes: SchedulerResourceType[],
): RequestedCountRange[] | null {
  if (!requestedRanges) {
    return buildDefaultCountRanges(resourceTypes)
  }

  const validResourceTypeIds = new Set(resourceTypes.map(rt => rt.id))
  const seenIds = new Set<string>()
  const sanitised: RequestedCountRange[] = []

  for (const range of requestedRanges) {
    if (
      typeof range?.resourceTypeId !== 'string'
      || seenIds.has(range.resourceTypeId)
      || !validResourceTypeIds.has(range.resourceTypeId)
      || !Number.isInteger(range.min)
      || !Number.isInteger(range.max)
      || range.min < 1
      || range.max < range.min
    ) {
      return null
    }

    seenIds.add(range.resourceTypeId)
    sanitised.push({
      resourceTypeId: range.resourceTypeId,
      min: range.min,
      max: range.max,
    })
  }

  return sanitised
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/projects/:projectId/optimise/apply
// Register BEFORE the root POST to avoid path ambiguity.
// ─────────────────────────────────────────────────────────────────────────────

router.post('/apply', asyncHandler(async (req: AuthRequest, res: Response) => {
  const projectId = req.params.projectId as string
  const project = await ownedProject(projectId, req.userId!)
  if (!project) { res.status(404).json({ error: 'Project not found' }); return }

  const { resourceTypes: candidateRTs, staggerEpics } = req.body as {
    resourceTypes: ApplyCandidateResourceType[]
    staggerEpics?: boolean
  }
  if (!Array.isArray(candidateRTs) || candidateRTs.length === 0) {
    res.status(400).json({ error: 'resourceTypes array is required' }); return
  }

  const invalid = candidateRTs.some(
    entry => typeof entry.resourceTypeId !== 'string'
      || !Number.isInteger(entry.count)
      || entry.count < 1
      || !Number.isInteger(entry.suggestedStartWeek)
      || entry.suggestedStartWeek < 0,
  )
  if (invalid) {
    res.status(400).json({ error: 'Invalid resourceTypes element' }); return
  }

  const candidateIds = candidateRTs.map(entry => entry.resourceTypeId)
  if (new Set(candidateIds).size !== candidateIds.length) {
    res.status(400).json({ error: 'Duplicate resourceTypeId in resourceTypes array' }); return
  }

  const projectResourceTypes = await prisma.resourceType.findMany({
    where: { projectId, id: { in: candidateIds } },
    select: { id: true },
  })
  if (projectResourceTypes.length !== candidateIds.length) {
    res.status(400).json({ error: 'All candidate resource types must belong to this project' }); return
  }

  try {
    const result = await applyOptimiserCandidate({
      projectId,
      userId: req.userId!,
      candidate: candidateRTs,
      staggerEpics,
    })
    res.status(200).json(result)
  } catch (error) {
    if (error instanceof OptimiserApplyConflictError) {
      res.status(409).json({
        error: error.message,
        code: error.code,
        conflicts: error.conflicts.map(conflict => ({
          code: conflict.code,
          resourceTypeName: conflict.resourceTypeName,
          namedResourceName: conflict.namedResourceName,
        })),
      })
      return
    }
    throw error
  }
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
  const countRanges = sanitiseCountRanges(body.constraints?.countRanges, schedulerInput.resourceTypes)
  if (!countRanges) {
    res.status(400).json({ error: 'Invalid constraints.countRanges' }); return
  }

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
