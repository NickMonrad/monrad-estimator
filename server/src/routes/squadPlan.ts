/**
 * squadPlan.ts — Express routes for the Capacity Planner (squad sizing).
 *
 * POST /:projectId/squad-plan          Generate a capacity plan
 * POST /:projectId/squad-plan/apply    Save and activate a plan
 * GET  /:projectId/squad-plans         List plans for a project
 */

import { Router, Response } from 'express'
import { Prisma } from '@prisma/client'
import { prisma } from '../lib/prisma.js'
import { asyncHandler } from '../lib/asyncHandler.js'
import { authenticate, AuthRequest } from '../middleware/auth.js'
import { effectiveDays } from '../utils/round.js'
import { ownedProject } from '../lib/ownership.js'
import { buildSnapshot } from './snapshots.js'
import { pruneSnapshots } from '../lib/snapshotUtils.js'
import { runScheduler, type SchedulerInput, type SchedulerResourceType } from '../lib/scheduler.js'
import { levelEpicStarts } from '../lib/leveller.js'
import { runSAPlanner } from '../lib/sa-planner.js'
import {
  computeCapacityPlan,
  type CapacityPlanConfig,
} from '../lib/capacity-planner.js'
import {
  materializeCapacityPlanResources,
  materializeResourceTrajectories,
  type CapacityPlanSlotWindow,
  type CapacityPlanPeriodInput,
} from '../lib/capacityPlanMaterialisation.js'
import {
  conflictPreflightCheck,
  findOrCreatePlannedResources,
  materializeProfilesForResourceType,
  writePlannerProfiles,
  projectCompatibilityFields,
  clearSurplusCompatibilityFields,
  clearOmittedPlannerCapacity,
  revalidatePlannerPlan,
  PlannerConflictError,
  runPreValidationConflictSeam,
  runPreWriteConflictSeam,
  __applyFailureSeam,
  type PrismaTransactionClient,
} from '../lib/squadPlannerProfileWriter.js'

type ApplyPeriodEntry = {
  resourceTypeId: string
  headcount: number
  demandFTE: number
  utilisationPct: number
}

type ApplyPeriod = {
  periodIndex: number
  startWeek: number
  endWeek: number
  entries: ApplyPeriodEntry[]
}

type SlotWindow = {
  startWeek: number
  endWeek: number
}

type PlannerInputLoadOptions = {
  includeCapacityPlanMaterialization?: boolean
}

type PlannerInputResourceType = SchedulerResourceType & {
  allocationMode?: string | null
}

const router = Router({ mergeParams: true })
router.use(authenticate)

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value)

const isNonNegativeFiniteNumber = (value: unknown): value is number =>
  isFiniteNumber(value) && value >= 0

export function deriveFeatureSpanFromWeeklyAllocations(
  weeklyAllocations: Map<number, Map<string, number>> | undefined,
  fallbackStartWeek: number,
): { startWeek: number; durationWeeks: number } {
  const allocatedWeeks: number[] = []
  if (weeklyAllocations) {
    for (const [week, byRt] of weeklyAllocations.entries()) {
      let totalAllocation = 0
      for (const allocation of byRt.values()) {
        if (Number.isFinite(allocation)) totalAllocation += allocation
      }
      if (totalAllocation > 0) allocatedWeeks.push(week)
    }
  }

  if (allocatedWeeks.length === 0) {
    return { startWeek: fallbackStartWeek, durationWeeks: 1 }
  }

  const startWeek = Math.min(...allocatedWeeks)
  const endWeek = Math.max(...allocatedWeeks)
  return { startWeek, durationWeeks: Math.max(1, endWeek - startWeek + 1) }
}

// ─────────────────────────────────────────────────────────────────────────────
// Data loader — same pattern as optimiser.ts
// ─────────────────────────────────────────────────────────────────────────────

export function stripCapacityPlanMaterialization(
  resourceTypes: PlannerInputResourceType[],
): SchedulerResourceType[] {
  return resourceTypes.map(resourceType => ({
    ...resourceType,
    namedResources: (resourceType.namedResources ?? []).filter(
      namedResource => namedResource.allocationMode !== 'CAPACITY_PLAN',
    ),
  }))
}

function buildWeeklyDemandCacheFromPlannerResult(
  weeklyDemandByResourceType: Map<string, number[]>,
): Record<string, number> {
  const weeklyDemandCache: Record<string, number> = {}

  for (const [resourceTypeId, weeklyDemand] of weeklyDemandByResourceType.entries()) {
    for (let week = 0; week < weeklyDemand.length; week++) {
      const demandDays = weeklyDemand[week]
      if (!Number.isFinite(demandDays) || demandDays <= 0) continue
      weeklyDemandCache[`${resourceTypeId}|${week}`] = demandDays
    }
  }

  return weeklyDemandCache
}

function buildReplayPlannerResourceTypes(
  resourceTypes: SchedulerResourceType[],
  slotWindowsByRt: Map<string, CapacityPlanSlotWindow[]>,
  maxHeadcountByRt: Map<string, number>,
): SchedulerResourceType[] {
  return resourceTypes.map(resourceType => {
    const slotWindows = slotWindowsByRt.get(resourceType.id)
    const maxHeadcount = maxHeadcountByRt.get(resourceType.id)

    if (!slotWindows || maxHeadcount == null) return resourceType

    return {
      ...resourceType,
      count: maxHeadcount,
      namedResources: slotWindows.map((slotWindow, idx) => ({
        id: `capacity-plan-${resourceType.id}-${idx}`,
        name: `${resourceType.name} ${idx + 1}`,
        startWeek: slotWindow.startWeek,
        endWeek: slotWindow.endWeek,
        allocationPct: slotWindow.allocationPercent,
        allocationMode: 'CAPACITY_PLAN',
        allocationPercent: slotWindow.allocationPercent,
        allocationStartWeek: null,
        allocationEndWeek: null,
      })),
    }
  })
}

async function loadSchedulerInput(
  projectId: string,
  hoursPerDay: number,
  options: PlannerInputLoadOptions = {},
): Promise<SchedulerInput> {
  const { includeCapacityPlanMaterialization = true } = options
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

  const plannerResourceTypes = includeCapacityPlanMaterialization
    ? resourceTypes as SchedulerResourceType[]
    : stripCapacityPlanMaterialization(resourceTypes as PlannerInputResourceType[])

  return {
    project: { hoursPerDay },
    epics,
    resourceTypes: plannerResourceTypes,
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

export type SlotSegment = {
  slotIndex: number
  segmentIndex: number
  startWeek: number
  endWeek: number
}

export function deriveSlotSegments(
  periods: Array<{ periodIndex: number; startWeek: number; endWeek: number; headcount: number }>,
): SlotSegment[] {
  const sortedPeriods = [...periods].sort((a, b) => a.periodIndex - b.periodIndex)
  const maxSlots = Math.max(0, ...sortedPeriods.map(period => period.headcount))
  const segments: SlotSegment[] = []

  for (let slot = 1; slot <= maxSlots; slot++) {
    let currentWindow: SlotWindow | null = null
    let segmentIndex = 0

    for (const period of sortedPeriods) {
      const isActive = period.headcount >= slot

      if (!isActive) {
        if (currentWindow) {
          segments.push({
            slotIndex: slot,
            segmentIndex,
            startWeek: currentWindow.startWeek,
            endWeek: currentWindow.endWeek,
          })
          currentWindow = null
          segmentIndex += 1
        }
        continue
      }

      if (!currentWindow) {
        currentWindow = { startWeek: period.startWeek, endWeek: period.endWeek }
        continue
      }

      if (period.startWeek <= currentWindow.endWeek + 1) {
        currentWindow.endWeek = period.endWeek
        continue
      }

      segments.push({
        slotIndex: slot,
        segmentIndex,
        startWeek: currentWindow.startWeek,
        endWeek: currentWindow.endWeek,
      })
      segmentIndex += 1
      currentWindow = { startWeek: period.startWeek, endWeek: period.endWeek }
    }

    if (currentWindow) {
      segments.push({
        slotIndex: slot,
        segmentIndex,
        startWeek: currentWindow.startWeek,
        endWeek: currentWindow.endWeek,
      })
    }
  }

  return segments
}

/**
 * Derive slot windows per resource type using the shared fractional-aware
 * materialisation library.  Each window carries { startWeek, endWeek,
 * allocationPercent } so that 0.25 HC produces one window at 25%, 1.25 HC
 * produces a 100% window plus a 25% window, etc.
 *
 * This replaces deriveSlotSegmentsByResourceType in the apply path.
 */
function deriveSlotWindowsByResourceType(periods: ApplyPeriod[]): Map<string, CapacityPlanSlotWindow[]> {
  // ApplyPeriod is a superset of CapacityPlanPeriodInput — extra entry fields
  // (demandFTE, utilisationPct) are simply ignored by the materialisation lib.
  const materialized = materializeCapacityPlanResources(periods as unknown as CapacityPlanPeriodInput[])
  const result = new Map<string, CapacityPlanSlotWindow[]>()
  for (const [rtId, mat] of materialized) {
    result.set(rtId, mat.slotWindows)
  }
  return result
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
    maxConcurrentEpics: clientMaxConcurrentEpics,
  } = req.body as {
    name: string
    targetWeeks: number
    periodWeeks: number
    maxDelta: number
    periods: ApplyPeriod[]
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
    maxConcurrentEpics?: number
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
  if (totalCost != null && !isNonNegativeFiniteNumber(totalCost)) {
    res.status(400).json({ error: 'totalCost must be a finite number >= 0' }); return
  }
  if (deliveryWeeks != null && !isNonNegativeFiniteNumber(deliveryWeeks)) {
    res.status(400).json({ error: 'deliveryWeeks must be a finite number >= 0' }); return
  }
  if (clientMaxParallelism != null && (!Number.isInteger(clientMaxParallelism) || clientMaxParallelism < 1)) {
    res.status(400).json({ error: 'maxParallelismPerFeature must be an integer >= 1' }); return
  }
  if (clientMaxConcurrentEpics != null && (!Number.isInteger(clientMaxConcurrentEpics) || clientMaxConcurrentEpics < 1)) {
    res.status(400).json({ error: 'maxConcurrentEpics must be an integer >= 1' }); return
  }

  const projectResourceTypes = await prisma.resourceType.findMany({
    where: { projectId },
    select: { id: true, name: true },
  })
  const projectResourceTypeIds = new Set(projectResourceTypes.map(rt => rt.id))

  const normalisedPeriods = [...periods].sort((a, b) => a.periodIndex - b.periodIndex)
  let previousEndWeek = -Infinity
  for (let idx = 0; idx < normalisedPeriods.length; idx++) {
    const period = normalisedPeriods[idx]
    if (!Number.isInteger(period.periodIndex) || period.periodIndex !== idx) {
      res.status(400).json({ error: 'periods must have contiguous integer periodIndex values starting at 0' }); return
    }
    if (!Number.isInteger(period.startWeek) || !Number.isInteger(period.endWeek)) {
      res.status(400).json({ error: 'period startWeek and endWeek must be integers' }); return
    }
    if (period.startWeek < 0 || period.endWeek <= period.startWeek) {
      res.status(400).json({ error: 'period ranges must be non-negative with endWeek > startWeek' }); return
    }
    if (period.startWeek < previousEndWeek) {
      res.status(400).json({ error: 'period ranges must be ordered and non-overlapping' }); return
    }
    previousEndWeek = period.endWeek
    if (!Array.isArray(period.entries)) {
      res.status(400).json({ error: 'period entries are required' }); return
    }

    for (const entry of period.entries) {
      if (!entry?.resourceTypeId || typeof entry.resourceTypeId !== 'string') {
        res.status(400).json({ error: 'period entry resourceTypeId is required' }); return
      }
      if (!projectResourceTypeIds.has(entry.resourceTypeId)) {
        res.status(400).json({ error: `Unknown resourceTypeId in periods: ${entry.resourceTypeId}` }); return
      }
      if (!isNonNegativeFiniteNumber(entry.headcount)) {
        res.status(400).json({ error: 'period entry headcount must be a finite number >= 0' }); return
      }
      if (!isNonNegativeFiniteNumber(entry.demandFTE)) {
        res.status(400).json({ error: 'period entry demandFTE must be a finite number >= 0' }); return
      }


      if (!isNonNegativeFiniteNumber(entry.utilisationPct)) {
        res.status(400).json({ error: 'period entry utilisationPct must be a finite number >= 0' }); return
      }
    }
  }

  const shouldActivate = setActive ?? true

  // ── 1a. Conflict preflight (before snapshot) ─────────────────────────────
  if (shouldActivate) {
    const conflictResult = await conflictPreflightCheck(
      prisma,
      projectId,
      normalisedPeriods as unknown as CapacityPlanPeriodInput[],
    )
    if (conflictResult?.hasConflict) {
      const messages: string[] = []
      if (conflictResult.duplicateOwnerProfiles.length > 0) {
        messages.push('Duplicate owner profiles exist for one or more affected resources. Repair required before applying.')
      }
      if (conflictResult.protectedNamedPersonProfiles.length > 0) {
        for (const p of conflictResult.protectedNamedPersonProfiles) {
          const label = p.namedResourceName ?? p.resourceTypeName
          messages.push(`"${label}" has an explicit named-person profile and cannot be replaced by the planner.`)
        }
      }
      res.status(409).json({ error: messages.join('; ') })
      return
    }
  }

  // ── 1. Create pre-apply snapshot for undo (track ID for on-conflict cleanup) ──
  let newSnapshotId: string | null = null
  if (shouldActivate) {
    const snapshotData = await buildSnapshot(projectId)
    const dateStr = new Date().toISOString().slice(0, 10)
    const snapshot = await prisma.backlogSnapshot.create({
      data: {
        projectId,
        label: `Auto-saved before squad plan apply — ${dateStr}`,
        trigger: 'optimiser_apply',
        snapshot: snapshotData as unknown as object,
        createdById: req.userId!,
      },
    })
    newSnapshotId = snapshot.id
    // pruneSnapshots is deferred to after a successful transaction
  }


  // ── 2. Compute planner-derived values from request data (no DB) ──────────
  let maxHeadcountByRt: Map<string, number> | undefined
  let slotWindowsByRt: Map<string, CapacityPlanSlotWindow[]> | undefined
  if (shouldActivate) {
    maxHeadcountByRt = new Map<string, number>()
    for (const p of normalisedPeriods) {
      for (const e of p.entries) {
        const current = maxHeadcountByRt.get(e.resourceTypeId) ?? 0
        maxHeadcountByRt.set(e.resourceTypeId, Math.max(current, e.headcount))
      }
    }
    slotWindowsByRt = deriveSlotWindowsByResourceType(normalisedPeriods)
  }

  // ── 2b. Precompute timeline/cache data (before transaction) ────────────────
  let timelinePrecomputed: {
    epicStartWeeks: Map<string, number>
    featureRows: Array<{ projectId: string; featureId: string; startWeek: number; durationWeeks: number; isManual: false }>
    storyRows: Array<{ projectId: string; storyId: string; startWeek: number; durationWeeks: number; isManual: false }>
    weeklyDemandCache: Record<string, number>
  } | undefined

  if (shouldActivate && maxHeadcountByRt && slotWindowsByRt) {
    let refreshedWeeklyDemandCache: Record<string, number>
    let pfFeatureRows: Array<{ projectId: string; featureId: string; startWeek: number; durationWeeks: number; isManual: false }> = []
    let pfStoryRows: Array<{ projectId: string; storyId: string; startWeek: number; durationWeeks: number; isManual: false }> = []
    let epicStartWeeks: Map<string, number>

    if (clientLevellingResult?.featureStartWeeks && Object.keys(clientLevellingResult.featureStartWeeks).length > 0) {
      // ── Direct persistence path: derive spans from planner allocations ───
      const maxParallelism = clientMaxParallelism ?? 2
      const schedulerInput = await loadSchedulerInput(projectId, project.hoursPerDay, {
        includeCapacityPlanMaterialization: false,
      })
      const replayResourceTypes = buildReplayPlannerResourceTypes(
        schedulerInput.resourceTypes,
        slotWindowsByRt,
        maxHeadcountByRt,
      )
      const plannerResult = runSAPlanner({
        ...schedulerInput,
        resourceTypes: replayResourceTypes,
      }, {
        targetDurationWeeks: targetWeeks,
        maxParallelismPerFeature: maxParallelism,
        maxConcurrentEpics: clientMaxConcurrentEpics,
      })
      refreshedWeeklyDemandCache = buildWeeklyDemandCacheFromPlannerResult(
        plannerResult.weeklyDemandByResourceType,
      )

      epicStartWeeks = new Map(
        Object.entries(clientLevellingResult.epicStartWeeks).map(([k, v]) => [k, Number(v)])
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

      const hpd = project.hoursPerDay
      const featureStartWeeks = clientLevellingResult.featureStartWeeks

      for (const epic of allEpics) {
        for (const feature of epic.features) {
          if (feature.isActive === false) continue
          const fallbackStartWeek = Number(
            featureStartWeeks[feature.id]
              ?? plannerResult.featureStartWeeks.get(feature.id)
              ?? 0,
          )
          const span = deriveFeatureSpanFromWeeklyAllocations(
            plannerResult.weeklyAllocationsByFeature.get(feature.id),
            fallbackStartWeek,
          )

          const demandByRt = new Map<string, number>()
          const activeStories = feature.userStories.filter(s => s.isActive !== false)
          for (const story of activeStories) {
            for (const task of story.tasks) {
              if (!task.resourceTypeId) continue
              const rtHpd = task.resourceType?.hoursPerDay ?? hpd
              const days = effectiveDays(task.durationDays, task.hoursEffort, rtHpd)
              demandByRt.set(task.resourceTypeId, (demandByRt.get(task.resourceTypeId) ?? 0) + days)
            }
          }

          pfFeatureRows.push({
            projectId,
            featureId: feature.id,
            startWeek: span.startWeek,
            durationWeeks: span.durationWeeks,
            isManual: false as const,
          })

          const totalFeatureDays = Array.from(demandByRt.values()).reduce((sum, d) => sum + d, 0)
          for (const story of activeStories) {
            let storyDays = 0
            for (const task of story.tasks) {
              if (!task.resourceTypeId) continue
              const rtHpd = task.resourceType?.hoursPerDay ?? hpd
              storyDays += effectiveDays(task.durationDays, task.hoursEffort, rtHpd)
            }
            const proportion = totalFeatureDays > 0 ? storyDays / totalFeatureDays : 0
            const storyDuration = Math.max(1, Math.ceil(span.durationWeeks * proportion))
            pfStoryRows.push({
              projectId,
              storyId: story.id,
              startWeek: span.startWeek,
              durationWeeks: storyDuration,
              isManual: false as const,
            })
          }
        }
      }
    } else {
      // ── Legacy fallback: re-run scheduler ──────────────────────────────
      const schedulerInput = await loadSchedulerInput(projectId, project.hoursPerDay)

      if (clientLevellingResult?.epicStartWeeks) {
        epicStartWeeks = new Map(Object.entries(clientLevellingResult.epicStartWeeks).map(([k, v]) => [k, Number(v)]))
      } else {
        const levelResult = levelEpicStarts(schedulerInput)
        epicStartWeeks = levelResult.epicStartWeeks
      }

      const levelledEpics = schedulerInput.epics.map(e => ({
        ...e,
        timelineStartWeek: epicStartWeeks.get(e.id) ?? e.timelineStartWeek,
      }))

      const { featureSchedule, storySchedule, weeklyConsumptionMap } = runScheduler({
        ...schedulerInput,
        epics: levelledEpics,
      })
      refreshedWeeklyDemandCache = Object.fromEntries(weeklyConsumptionMap)

      pfFeatureRows = featureSchedule
        .filter(e => !e.isManual)
        .map(e => ({
          projectId,
          featureId: e.featureId,
          startWeek: e.startWeek,
          durationWeeks: e.durationWeeks,
          isManual: false as const,
        }))

      pfStoryRows = storySchedule
        .filter(e => !e.isManual)
        .map(e => ({
          projectId,
          storyId: e.storyId,
          startWeek: e.startWeek,
          durationWeeks: e.durationWeeks,
          isManual: false as const,
        }))
    }

    timelinePrecomputed = {
      epicStartWeeks,
      featureRows: pfFeatureRows,
      storyRows: pfStoryRows,
      weeklyDemandCache: refreshedWeeklyDemandCache,
    }


}

  // ── 3. Single transaction: revalidate → deactivate → plan → profile → timeline + cache ──
  let plan: unknown
  try {
    plan = await prisma.$transaction(async (tx: PrismaTransactionClient) => {
      // A deterministic test seam can commit a concurrent profile mutation
      // before validation reads ownership state.
      if (shouldActivate) {
        await runPreValidationConflictSeam()
        await revalidatePlannerPlan(
          tx,
          projectId,
          normalisedPeriods as unknown as CapacityPlanPeriodInput[],
        )

        // ── Pre-write conflict test seam ─────────────────────────────────
        // Integration tests inject a profile mutation here to test preflight/apply race.
        runPreWriteConflictSeam()
      }

      // Deactivate existing active plans
      if (shouldActivate) {
        await tx.capacityPlan.updateMany({
          where: { projectId, isActive: true },
          data: { isActive: false },
        })
      }

      // Create the new plan with nested periods & entries
      const createdPlan = await tx.capacityPlan.create({
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
            create: normalisedPeriods.map(p => ({
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

      // ── Profile-first: write authoritative profiles directly, project compatibility ──
      if (shouldActivate && maxHeadcountByRt) {
        // Update RT counts and allocation mode for demand RTs
        for (const [rtId, count] of maxHeadcountByRt) {
          await tx.resourceType.update({
            where: { id: rtId },
            data: { count: Math.max(1, Math.ceil(count)), allocationMode: 'CAPACITY_PLAN' },
          })
        }

        // Reuse the validated project resource types for materialisation
        const rtNameById = new Map(projectResourceTypes.map(rt => [rt.id, rt.name]))

        // Write authoritative profiles per resource type
        for (const [rtId] of maxHeadcountByRt) {
          const rtName = rtNameById.get(rtId) ?? 'Resource'

          // Compute trajectories to know required count and provide data
          const rtPeriods = normalisedPeriods.map(p => ({
            periodIndex: p.periodIndex,
            startWeek: p.startWeek,
            endWeek: p.endWeek,
            headcount: p.entries.find(e => e.resourceTypeId === rtId)?.headcount ?? 0,
          }))
          const trajectories = materializeResourceTrajectories(rtPeriods)

          // Find/create named resources with stable ordering (createdAt, id)
          const { allNamedResources } = await findOrCreatePlannedResources(
            tx,
            rtId,
            rtName,
            trajectories.length,
            projectId,
          )
          // Build profile write sets (role + per-resource), including all
          // planner-managed resources so shrink operations zero surplus rows.
          const materialized = materializeProfilesForResourceType(
            rtId,
            rtName,
            normalisedPeriods as unknown as CapacityPlanPeriodInput[],
            allNamedResources,
          )

          // Authoritative profile + segment persistence
          await writePlannerProfiles(
            tx,
            projectId,
            [materialized.roleProfile],
            materialized.plannedProfiles,
            materialized.surplusResources,
          )

          // Project compatibility fields from just-written profiles
          await projectCompatibilityFields(
            tx,
            projectId,
            [materialized.roleProfile],
            materialized.plannedProfiles,
          )

          // Clear surplus resource windows so legacy readers see no stale capacity
          if (materialized.surplusResources.length > 0) {
            await clearSurplusCompatibilityFields(tx, materialized.surplusResources)
          }
        }
        await clearOmittedPlannerCapacity(tx, projectId, new Set(maxHeadcountByRt.keys()))
      }

      // ── Timeline + cache persistence using precomputed data ────────────
      if (shouldActivate && timelinePrecomputed) {
        // Persist epic start weeks
        for (const [epicId, startWeek] of timelinePrecomputed.epicStartWeeks) {
          await tx.epic.update({ where: { id: epicId }, data: { timelineStartWeek: startWeek } })
        }

        // Persist timeline entries
        await tx.timelineEntry.deleteMany({ where: { projectId, isManual: false } })
        if (timelinePrecomputed.featureRows.length > 0) {
          await tx.timelineEntry.createMany({ data: timelinePrecomputed.featureRows, skipDuplicates: true })
        }

        // Persist story timeline entries
        await tx.storyTimelineEntry.deleteMany({ where: { projectId, isManual: false } })
        if (timelinePrecomputed.storyRows.length > 0) {
          await tx.storyTimelineEntry.createMany({ data: timelinePrecomputed.storyRows, skipDuplicates: true })
        }

        // Update weekly demand cache
        await tx.project.update({
          where: { id: projectId },
          data: { weeklyDemandCache: timelinePrecomputed.weeklyDemandCache },
        })

        // ── Test failure seam (after timeline/cache) ─────────────────────────
        // Production: no-op. Integration tests inject a throwing function to
        // verify the transaction rolls back timeline and cache mutations too.
        if (__applyFailureSeam) {
          __applyFailureSeam()
        }
      }

      return createdPlan
    }, { isolationLevel: 'Serializable' })
  } catch (err: unknown) {
    if (err instanceof PlannerConflictError) {
      // Transaction-time conflict: abort before active-plan deactivation.
      // Delete only the new snapshot (created before the transaction) and return 409.
      if (newSnapshotId) {
        await prisma.backlogSnapshot.delete({ where: { id: newSnapshotId } }).catch(() => {
          // Snapshot may already be deleted by another path; ignore deletion failure
        })
      }
      res.status(409).json({ error: err.message })
      return
    }
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2034') {
      // PostgreSQL Serializable transactions can abort on a concurrent write.
      // The new snapshot is outside the transaction and must be cleaned up explicitly.
      if (newSnapshotId) {
        await prisma.backlogSnapshot.delete({ where: { id: newSnapshotId } }).catch(() => {
          // Snapshot may already be deleted by another path; ignore deletion failure
        })
      }
      res.status(409).json({ error: 'Concurrent planner apply detected; retry the operation.' })
      return
    }
    throw err // Unexpected errors propagate as 500
  }

  // Prune snapshots only after a successful transaction
  if (newSnapshotId) {
    await pruneSnapshots(prisma, projectId)
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
    smoothingMode?: 'smooth' | 'tight' | 'exact'
    minFloor?: Record<string, number>
    maxCap?: Record<string, number>
    maxBudget?: number
    maxAllocationBufferPct?: number
    maxParallelismPerFeature?: number
    maxConcurrentEpics?: number
  }

  // ── Validation ──────────────────────────────────────────────────────────
  const targetDurationWeeks = body.targetDurationWeeks
  if (!isFiniteNumber(targetDurationWeeks) || targetDurationWeeks <= 0) {
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

  const smoothingMode = body.smoothingMode ?? 'smooth'
  if (smoothingMode !== 'smooth' && smoothingMode !== 'tight' && smoothingMode !== 'exact') {
    res.status(400).json({ error: 'smoothingMode must be smooth, tight, or exact' }); return
  }
  if (body.maxBudget != null && !isNonNegativeFiniteNumber(body.maxBudget)) {
    res.status(400).json({ error: 'maxBudget must be a finite number >= 0' }); return
  }
  if (body.maxAllocationBufferPct != null && (!isFiniteNumber(body.maxAllocationBufferPct) || body.maxAllocationBufferPct < 0)) {
    res.status(400).json({ error: 'maxAllocationBufferPct must be a finite number >= 0' }); return
  }
  if (body.maxParallelismPerFeature != null && (!Number.isInteger(body.maxParallelismPerFeature) || body.maxParallelismPerFeature < 1)) {
    res.status(400).json({ error: 'maxParallelismPerFeature must be an integer >= 1' }); return
  }
  if (body.maxConcurrentEpics != null && (!Number.isInteger(body.maxConcurrentEpics) || body.maxConcurrentEpics < 1)) {
    res.status(400).json({ error: 'maxConcurrentEpics must be an integer >= 1' }); return
  }

  // ── Load scheduler input ────────────────────────────────────────────────
  const schedulerInput = await loadSchedulerInput(projectId, project.hoursPerDay, {
    includeCapacityPlanMaterialization: false,
  })
  const projectRtIds = new Set(schedulerInput.resourceTypes.map(rt => rt.id))

  // ── Build minFloor map ──────────────────────────────────────────────────
  const minFloor = new Map<string, number>()
  if (body.minFloor) {
    for (const [rtId, floor] of Object.entries(body.minFloor)) {
      if (!projectRtIds.has(rtId)) {
        res.status(400).json({ error: `Unknown resourceTypeId in minFloor: ${rtId}` }); return
      }
      if (!isNonNegativeFiniteNumber(floor)) {
        res.status(400).json({ error: `minFloor for ${rtId} must be a finite number >= 0` }); return
      }
      minFloor.set(rtId, floor)
    }
  }
  // Default floor of 0 for all resource types not explicitly set
  // (users set explicit floors via the UI if they want minimum presence)
  for (const rt of schedulerInput.resourceTypes) {
    if (!minFloor.has(rt.id)) {
      minFloor.set(rt.id, 0)
    }
  }

  const maxCap = new Map<string, number>()
  if (body.maxCap) {
    for (const [rtId, cap] of Object.entries(body.maxCap)) {
      if (!projectRtIds.has(rtId)) {
        res.status(400).json({ error: `Unknown resourceTypeId in maxCap: ${rtId}` }); return
      }
      if (!isNonNegativeFiniteNumber(cap)) {
        res.status(400).json({ error: `maxCap for ${rtId} must be a finite number >= 0` }); return
      }
      const floor = minFloor.get(rtId) ?? 0
      if (cap < floor) {
        res.status(400).json({ error: `maxCap for ${rtId} must be >= minFloor` }); return
      }
      maxCap.set(rtId, cap)
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
    smoothingMode,
    minFloor,
    maxCap: maxCap.size > 0 ? maxCap : undefined,
    dayRates,
    maxBudget: body.maxBudget,
    maxAllocationBufferPct: body.maxAllocationBufferPct,
    maxParallelismPerFeature: body.maxParallelismPerFeature,
    maxConcurrentEpics: body.maxConcurrentEpics,
  }

  let result: ReturnType<typeof computeCapacityPlan>
  try {
    result = computeCapacityPlan(schedulerInput, config)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    const isGenerationFailure =
      error instanceof Error && detail.includes('Fractional planner could not finish feature')

    if (isGenerationFailure) {
      res.status(400).json({
        error:
          'No feasible squad plan found under the current constraints. Try resetting RT max caps, increasing max parallelism, or clearing saved planner settings. ' +
          `Details: ${detail}`,
      })
      return
    }

    throw error
  }

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
