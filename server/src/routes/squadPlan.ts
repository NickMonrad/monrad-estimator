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
  type CapacityPlanSlotWindow,
  type CapacityPlanPeriodInput,
} from '../lib/capacityPlanMaterialisation.js'

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
    select: { id: true },
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

  // ── 4. Update RT counts + allocation mode, re-run scheduler ─────────────
  if (shouldActivate) {
    let refreshedWeeklyDemandCache: Record<string, number>

    // Compute max headcount per RT across all periods
    const maxHeadcountByRt = new Map<string, number>()
    for (const p of normalisedPeriods) {
      for (const e of p.entries) {
        const current = maxHeadcountByRt.get(e.resourceTypeId) ?? 0
        maxHeadcountByRt.set(e.resourceTypeId, Math.max(current, e.headcount))
      }
    }

    // Update RT counts and allocation mode for demand RTs
    for (const [rtId, count] of maxHeadcountByRt) {
      await prisma.resourceType.update({
        where: { id: rtId },
        data: { count: Math.max(1, Math.ceil(count)), allocationMode: 'CAPACITY_PLAN' },
      })
    }

    // Also set ALL other project RTs to CAPACITY_PLAN (overhead RTs keep their count)
    await prisma.resourceType.updateMany({
      where: { projectId, id: { notIn: [...maxHeadcountByRt.keys()] } },
      data: { allocationMode: 'CAPACITY_PLAN' },
    })

    // Update ALL named resources allocation mode
    await prisma.namedResource.updateMany({
      where: { resourceType: { projectId } },
      data: { allocationMode: 'CAPACITY_PLAN' },
    })

    // ── Compute fractional-aware slot windows per RT ──────────────────────────
    // Uses the shared materialisation library so fractional headcount (e.g. 0.25,
    // 1.25) produces the correct number of NR windows with the right
    // allocationPercent values (e.g. 0.25 HC → one window at 25%).
    const slotWindowsByRt = deriveSlotWindowsByResourceType(normalisedPeriods)

    // ── Auto-create missing NRs then assign slot windows ────────────────────
    for (const [rtId] of maxHeadcountByRt) {
      const slotWindows = slotWindowsByRt.get(rtId) ?? []

      // Fetch existing NRs with stable ordering (oldest first = lowest id)
      const existingNRs = await prisma.namedResource.findMany({
        where: { resourceTypeId: rtId },
        orderBy: { id: 'asc' },
        select: { id: true },
      })

      const missing = Math.max(0, slotWindows.length - existingNRs.length)
      if (missing > 0) {
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
          startWeek: 0,   // placeholder; updated immediately below
        }))
        await prisma.namedResource.createMany({ data: newNRs })
      }

      // Re-fetch all NRs (including any just created) with stable ordering
      const allNRs = await prisma.namedResource.findMany({
        where: { resourceTypeId: rtId },
        orderBy: { id: 'asc' },
        select: { id: true },
      })

      // Assign each NR one slot window (startWeek, endWeek, allocationPercent).
      // Surplus NRs become inactive (startWeek=-1, endWeek=-1, allocationPercent=100).
      await Promise.all(
        allNRs.map((nr, idx) => {
          const win = slotWindows[idx] ?? { startWeek: -1, endWeek: -1, allocationPercent: 100 }
          return prisma.namedResource.update({
            where: { id: nr.id },
            data: {
              startWeek: win.startWeek,
              endWeek: win.endWeek,
              allocationPercent: win.allocationPercent,
              allocationMode: 'CAPACITY_PLAN',
            },
          })
        })
      )
    }

    // ── 5. Materialise timeline using the projected schedule ───────────────

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
        replayResourceTypes,
      )

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

      const hpd = project.hoursPerDay

      // Compute feature spans from actual weekly allocations produced by planner
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
          const fallbackStartWeek = Number(
            featureStartWeeks[feature.id]
              ?? plannerResult.featureStartWeeks.get(feature.id)
              ?? 0,
          )
          const span = deriveFeatureSpanFromWeeklyAllocations(
            plannerResult.weeklyAllocationsByFeature.get(feature.id),
            fallbackStartWeek,
          )

          // Compute demand per RT (same as sa-planner.ts lines 104-112)
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

          featureRows.push({
            projectId,
            featureId: feature.id,
            startWeek: span.startWeek,
            durationWeeks: span.durationWeeks,
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
              storyDays += effectiveDays(task.durationDays, task.hoursEffort, rtHpd)
            }
            const proportion = totalFeatureDays > 0 ? storyDays / totalFeatureDays : 0
            const storyDuration = Math.max(1, Math.ceil(span.durationWeeks * proportion))
            storyRows.push({
              projectId,
              storyId: story.id,
              startWeek: span.startWeek,
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
      const { featureSchedule, storySchedule, weeklyConsumptionMap } = runScheduler({
        ...schedulerInput,
        epics: levelledEpics,
      })
      refreshedWeeklyDemandCache = Object.fromEntries(weeklyConsumptionMap)

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

    await prisma.project.update({
      where: { id: projectId },
      data: { weeklyDemandCache: refreshedWeeklyDemandCache },
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
