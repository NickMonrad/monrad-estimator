import { resolveSchedulerCapacity } from '../lib/schedulerCapacityResolver.js'

import { Router, Response } from 'express'
import { prisma } from '../lib/prisma.js'
import { asyncHandler } from '../lib/asyncHandler.js'
import { authenticate, AuthRequest } from '../middleware/auth.js'
import {
  runScheduler,
  getWeeklyCapacity,
  type SchedulerInput,
  type SchedulerResourceType,
} from '../lib/scheduler.js'
import {
  buildProjectPlanningModel,
  convertWeeklyDemandCache,
  type ProjectPlanningModel,
} from '../lib/projectPlanningModel.js'
import { scheduleProject } from '../lib/scheduleProject.js'
import { runSAPlanner } from '../lib/sa-planner.js'
import { buildSnapshot } from './snapshots.js'
import { pruneSnapshots } from '../lib/snapshotUtils.js'
import { assertPlanningCurrent } from '../lib/projectPlanningState.js'
const router = Router({ mergeParams: true })
router.use(authenticate)

/**
 * Re-export for backward compatibility — timeline.test.ts imports this from
 * routes/timeline.js. The canonical implementation lives in lib/scheduler.ts.
 */
export { getWeeklyCapacity }

// Alias for internal use within this file
type AllocationMode = 'EFFORT' | 'TIMELINE' | 'FULL_PROJECT' | 'CAPACITY_PLAN'
type ResourceTypeWithNamed = SchedulerResourceType & { allocationMode?: AllocationMode | null }

async function ownedProject(projectId: string, userId: string) {
  return prisma.project.findFirst({ where: { id: projectId, ownerId: userId } })
}

function computeDates(projectStartDate: Date | null, startWeek: number, durationWeeks: number, onboardingWeeks = 0) {
  if (!projectStartDate) return { startDate: null, endDate: null }
  const start = new Date(projectStartDate)
  start.setDate(start.getDate() + (startWeek + onboardingWeeks) * 7)
  const end = new Date(projectStartDate)
  end.setDate(end.getDate() + (startWeek + durationWeeks + onboardingWeeks) * 7)
  return { startDate: start.toISOString(), endDate: end.toISOString() }
}

function mapPlanningModelToTimelineResponse(model: ProjectPlanningModel) {
  const rtNameById = new Map(model.resourceTypeFacts.map(rt => [rt.id, rt.name]))

  const namedResourcesList = Array.from(model.namedResourceAssignments.entries()).flatMap(([rtId, assignment]) =>
    assignment.namedResources
      .map(nr => ({
        id: nr.id,
        resourceTypeId: rtId,
        resourceTypeName: rtNameById.get(rtId) ?? '',
        name: nr.name,
        startWeek: nr.startWeek,
        endWeek: nr.endWeek,
        allocationPct: nr.allocationMode === 'EFFORT' ? 100 : Math.round(nr.allocationPercent),
        allocationMode: nr.allocationMode,
        allocationPercent: nr.allocationPercent,
        allocationStartWeek: nr.allocationStartWeek,
        allocationEndWeek: nr.allocationEndWeek,
        pricingModel: nr.pricingModel,
        actualAllocatedDays: nr.actualAllocatedDays,
        actualAllocationStartWeek: nr.actualAllocationStartWeek,
        actualAllocationEndWeek: nr.actualAllocationEndWeek,
        actualAllocatedWeeks: nr.actualAllocatedWeeks,
        actualAllocationSegments: nr.actualAllocationSegments,
        synthetic: nr.synthetic,
      }))
  )
  // Sort: actual named resources first, role synthetics last
  namedResourcesList.sort((a, b) => {
    const aRole = a.synthetic && a.id.endsWith('-role') ? 1 : 0
    const bRole = b.synthetic && b.id.endsWith('-role') ? 1 : 0
    return aRole - bRole
  })

  return {
    projectId: model.projectId,
    startDate: model.startDate,
    hoursPerDay: model.hoursPerDay,
    projectedEndDate: model.planningWindow.projectedEndDate,
    bufferWeeks: model.planningWindow.bufferWeeks,
    onboardingWeeks: model.planningWindow.onboardingWeeks,
    parallelWarnings: model.parallelWarnings,
    storyEntries: model.storyEntries,
    featureDependencies: model.featureDependencies,
    storyDependencies: model.storyDependencies,
    epicDependencies: model.epicDependencies,
    weeklyDemand: model.weeklyDemand,
    weeklyCapacity: model.weeklyCapacity,
    namedResources: namedResourcesList,
    entries: model.entries,
  }
}

// GET /api/projects/:projectId/timeline
router.get('/', asyncHandler(async (req: AuthRequest, res: Response) => {
  const project = await ownedProject(req.params.projectId as string, req.userId!)
  if (!project) { res.status(404).json({ error: 'Project not found' }); return }
  if (project.planningState === 'NEEDS_REPLAN') {
    // Reset Planning clears generated schedule output and manual overrides.
    // The timeline is intentionally empty (never derived from stale state)
    // until the user replans and the project returns to CURRENT.
    res.json({
      projectId: project.id,
      startDate: project.startDate,
      hoursPerDay: project.hoursPerDay,
      projectedEndDate: null,
      bufferWeeks: project.bufferWeeks ?? 0,
      onboardingWeeks: project.onboardingWeeks ?? 0,
      parallelWarnings: [],
      entries: [],
      storyEntries: [],
      featureDependencies: [],
      storyDependencies: [],
      epicDependencies: [],
      weeklyDemand: [],
      weeklyCapacity: [],
      namedResources: [],
      planningState: 'NEEDS_REPLAN',
    })
    return
  }
  const model = await buildProjectPlanningModel(req.params.projectId as string, req.userId!)
  res.json(mapPlanningModelToTimelineResponse(model))
}))

// POST /api/projects/:projectId/timeline/schedule
router.post('/schedule', asyncHandler(async (req: AuthRequest, res: Response) => {
  const body = (req.body ?? {}) as { startDate?: unknown; resourceLevel?: unknown }
  const model = await scheduleProject({
    projectId: req.params.projectId as string,
    userId: req.userId!,
    startDate: typeof body.startDate === 'string' ? body.startDate : undefined,
    resourceLevel: body.resourceLevel === true,
  })
  res.json(mapPlanningModelToTimelineResponse(model))
}))

// PUT /api/projects/:projectId/timeline/stories/:storyId — manual story timeline override
router.put('/stories/:storyId', asyncHandler(async (req: AuthRequest, res: Response) => {
  const project = await ownedProject(req.params.projectId as string, req.userId!)
  if (!project) { res.status(404).json({ error: 'Project not found' }); return }
  // Manual overrides are planning-owned state (Timeline/Planning boundary).
  assertPlanningCurrent(project)

  const { startWeek, durationWeeks } = req.body
  if (startWeek == null || durationWeeks == null) {
    res.status(400).json({ error: 'startWeek and durationWeeks are required' }); return
  }

  const storyId = req.params.storyId as string

  // Verify story belongs to this project
  const story = await prisma.userStory.findFirst({
    where: { id: storyId, feature: { epic: { projectId: project.id } } },
    include: { feature: { include: { epic: true } } },
  })
  if (!story) { res.status(404).json({ error: 'Story not found' }); return }

  const entry = await prisma.storyTimelineEntry.upsert({
    where: { storyId },
    create: { storyId, projectId: project.id, startWeek, durationWeeks, isManual: true },
    update: { startWeek, durationWeeks, isManual: true },
  })

  // Manual story timeline change invalidates cached scheduler demand
  await prisma.project.update({
    where: { id: project.id },
    data: { weeklyDemandCache: {} },
  })

  res.json({
    storyId: entry.storyId,
    storyName: story.name,
    featureId: story.featureId,
    projectId: entry.projectId,
    startWeek: entry.startWeek,
    durationWeeks: entry.durationWeeks,
    isManual: entry.isManual,
  })
}))

// DELETE /api/projects/:projectId/timeline — clear ALL manual overrides (features + stories)
router.delete('/', asyncHandler(async (req: AuthRequest, res: Response) => {
  const project = await ownedProject(req.params.projectId as string, req.userId!)
  if (!project) { res.status(404).json({ error: 'Project not found' }); return }
  // Manual overrides are planning-owned state (Timeline/Planning boundary).
  assertPlanningCurrent(project)

  await Promise.all([
    prisma.timelineEntry.deleteMany({ where: { projectId: project.id, isManual: true } }),
    prisma.storyTimelineEntry.deleteMany({ where: { projectId: project.id, isManual: true } }),
  ])

  // Clearing manual overrides invalidates cached scheduler demand
  await prisma.project.update({
    where: { id: project.id },
    data: { weeklyDemandCache: {} },
  })

  res.status(204).end()
}))

// DELETE /api/projects/:projectId/timeline/stories/:storyId — clear manual story override
router.delete('/stories/:storyId', asyncHandler(async (req: AuthRequest, res: Response) => {
  const project = await ownedProject(req.params.projectId as string, req.userId!)
  if (!project) { res.status(404).json({ error: 'Project not found' }); return }
  // Manual overrides are planning-owned state (Timeline/Planning boundary).
  assertPlanningCurrent(project)

  await prisma.storyTimelineEntry.deleteMany({
    where: { storyId: req.params.storyId as string, projectId: project.id },
  })

  // Deleting a manual story override invalidates cached demand
  await prisma.project.update({
    where: { id: project.id },
    data: { weeklyDemandCache: {} },
  })

  res.status(204).end()
}))


// GET /api/projects/:projectId/timeline/export/csv
router.get('/export/csv', asyncHandler(async (req: AuthRequest, res: Response) => {
  const project = await prisma.project.findFirst({
    where: { id: req.params.projectId as string, ownerId: req.userId },
    include: {
      resourceTypes: { include: { namedResources: true } },
    },
  })
  if (!project) { res.status(404).json({ error: 'Project not found' }); return }
  // Planning-dependent export: the schedule/capacity CSV is a planning output.
  assertPlanningCurrent(project)

  const projectId = project.id
  const hpd = project.hoursPerDay

  // Profile-first capacity resolution — CSV capacity values derive from
  // authoritative profiles, never from candidate columns (issue #418).
  const resolved = await resolveSchedulerCapacity(prisma, projectId)
  const capacityResourceTypes = resolved.resourceTypes

  // Section 1 — Gantt
  const timelineEntries = await prisma.timelineEntry.findMany({
    where: { projectId },
    include: {
      feature: {
        include: { epic: true },
      },
    },
    orderBy: { startWeek: 'asc' },
  })

  function toDateStr(startDate: Date | null, offsetWeeks: number): string {
    if (!startDate) return ''
    const d = new Date(startDate)
    d.setDate(d.getDate() + offsetWeeks * 7)
    return d.toISOString().slice(0, 10)
  }

  const ganttRows: string[] = ['Feature,Epic,StartWeek,DurationWeeks,StartDate,EndDate']
  for (const e of timelineEntries) {
    const featureName = e.feature.name.replace(/,/g, ' ')
    const epicName = e.feature.epic.name.replace(/,/g, ' ')
    const onboardingWeeks = project.onboardingWeeks ?? 0
    const startDate = toDateStr(project.startDate, e.startWeek + onboardingWeeks)
    const endDate = toDateStr(project.startDate, e.startWeek + e.durationWeeks + onboardingWeeks)
    ganttRows.push(`${featureName},${epicName},${e.startWeek},${e.durationWeeks},${startDate},${endDate}`)
  }

  // Section 2 — Resource Demand
  const demandRows: string[] = ['ResourceType,Week,DemandDays,CapacityDays,Status']
  if (project.weeklyDemandCache) {
    const simulatedDemand = convertWeeklyDemandCache(
      project.weeklyDemandCache as Record<string, number>,
      project.resourceTypes as Array<{ id: string; name: string }>,
    )
    const cacheEntries = Array.from(simulatedDemand.entries()).map(([key, demandDays]) => {
      const pipeIdx = key.lastIndexOf('|')
      const rtName = key.slice(0, pipeIdx)
      const week = Number(key.slice(pipeIdx + 1))
      return { rtName, week, demandDays }
    }).sort((a, b) => a.week - b.week || a.rtName.localeCompare(b.rtName))

    const rtByName = new Map(capacityResourceTypes.map(rt => [rt.name, rt as ResourceTypeWithNamed]))
    for (const { rtName, week, demandDays } of cacheEntries) {
      const rt = rtByName.get(rtName)
      const capacityHours = rt ? getWeeklyCapacity(rt, week, hpd) : hpd * 5
      const capacityDays = capacityHours / hpd
      const d = Math.round(demandDays * 100) / 100
      const c = Math.round(capacityDays * 100) / 100
      const status = d > c ? 'Over' : d === c ? 'At capacity' : 'Under'
      demandRows.push(`${rtName.replace(/,/g, ' ')},${week},${d},${c},${status}`)
    }
  }

  // Section 3 — Named Resources
  // Compute derivedStartWeek/derivedEndWeek per resource type from timeline entries
  // (same logic as resourceProfile route)
  const [storyTimelineEntries, tasksForRt] = await Promise.all([
    prisma.storyTimelineEntry.findMany({
      where: { projectId },
      select: { storyId: true, startWeek: true, durationWeeks: true },
    }),
    prisma.task.findMany({
      where: { userStory: { feature: { epic: { projectId } } }, resourceTypeId: { not: null } },
      select: {
        resourceTypeId: true,
        userStoryId: true,
        userStory: { select: { featureId: true } },
      },
    }),
  ])

  // featureId → { startWeek, endWeek } from the already-fetched gantt entries
  const featureWeekMap = new Map(
    timelineEntries.map(e => [e.featureId, { startWeek: e.startWeek, endWeek: e.startWeek + e.durationWeeks }])
  )
  const storyEntryMap2 = new Map(storyTimelineEntries.map(e => [e.storyId, e]))

  const rtWeeks = new Map<string, { starts: number[]; ends: number[] }>()
  for (const task of tasksForRt) {
    if (!task.resourceTypeId) continue
    const storyEntry = task.userStoryId ? storyEntryMap2.get(task.userStoryId) : null
    const featureEntry = task.userStory?.featureId ? featureWeekMap.get(task.userStory.featureId) : null
    const entry = storyEntry
      ? { startWeek: storyEntry.startWeek, endWeek: storyEntry.startWeek + storyEntry.durationWeeks }
      : featureEntry ?? null
    if (!entry) continue
    if (!rtWeeks.has(task.resourceTypeId)) rtWeeks.set(task.resourceTypeId, { starts: [], ends: [] })
    rtWeeks.get(task.resourceTypeId)!.starts.push(entry.startWeek)
    rtWeeks.get(task.resourceTypeId)!.ends.push(entry.endWeek)
  }

  // Named resources come from the profile-derived scheduler DTOs: every
  // allocation field is projected from the authoritative profile (issue #418).
  const namedResources = capacityResourceTypes.flatMap(rt =>
    (rt.namedResources ?? []).map(nr => ({
      ...nr,
      resourceTypeId: rt.id,
      resourceTypeName: rt.name,
    })),
  )

  function allocationModeLabel(mode: string): string {
    if (mode === 'EFFORT') return 'T&M'
    if (mode === 'TIMELINE') return 'Timeline'
    return 'Full Project'
  }

  const nrRows: string[] = ['Name,ResourceType,AllocationType,AllocationPct,StartWeek,EndWeek']
  for (const nr of namedResources) {
    const name = nr.name.replace(/,/g, ' ')
    const rtName = nr.resourceTypeName.replace(/,/g, ' ')
    const modeLabel = allocationModeLabel(nr.allocationMode)
    const pct = nr.allocationPercent

    let startW: number | string = ''
    let endW: number | string = ''
    if (nr.allocationMode === 'TIMELINE') {
      const weeks = rtWeeks.get(nr.resourceTypeId)
      const derivedStart = weeks && weeks.starts.length > 0 ? Math.min(...weeks.starts) : null
      const derivedEnd = weeks && weeks.ends.length > 0 ? Math.max(...weeks.ends) : null
      const rawStart = nr.allocationStartWeek ?? derivedStart ?? null
      const rawEnd = nr.allocationEndWeek ?? derivedEnd ?? null
      startW = rawStart != null ? Math.floor(rawStart) : ''
      endW = rawEnd != null ? Math.floor(rawEnd) : ''
    }
    nrRows.push(`${name},${rtName},${modeLabel},${pct},${startW},${endW}`)
  }

  const today = new Date().toISOString().slice(0, 10)
  const projectName = project.name.replace(/[/\\?%*:|"<>]/g, '-')
  const filename = `${projectName} - Timeline - ${today}.csv`

  const csv = [
    ganttRows.join('\n'),
    '',
    demandRows.join('\n'),
    '',
    nrRows.join('\n'),
  ].join('\n')

  res.setHeader('Content-Type', 'text/csv; charset=utf-8')
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
  res.send(csv)
}))

// POST /api/projects/:projectId/timeline/level
// Must be registered BEFORE /:featureId to avoid param capture.
router.post('/level', asyncHandler(async (req: AuthRequest, res: Response) => {
  const projectId = req.params.projectId as string
  const project = await ownedProject(projectId, req.userId!)
  if (!project) { res.status(404).json({ error: 'Project not found' }); return }
  // Planning-dependent: levelling consumes the current capacity model.
  assertPlanningCurrent(project)

  const { dryRun } = req.body as { dryRun?: boolean }

  // ── 1. Load scheduler input (same pattern as POST /schedule) ─────────────
  const [allEpics, manualFeatures, manualStories, epicDeps] = await Promise.all([
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
    prisma.timelineEntry.findMany({ where: { projectId, isManual: true } }),
    prisma.storyTimelineEntry.findMany({ where: { projectId, isManual: true } }),
    prisma.epicDependency.findMany({
      where: { epic: { projectId } },
      select: { epicId: true, dependsOnId: true },
    }),
  ])
  // Profile-derived scheduler DTOs are authoritative (issue #418); the raw
  // ResourceType/NamedResource rows no longer carry legacy capacity columns.
  const resolvedCapacity = await resolveSchedulerCapacity(prisma, projectId)

  const activeEpics = allEpics
    .filter(e => e.isActive !== false)
    .map(e => ({ ...e, features: e.features.filter(f => f.isActive !== false) }))

  const schedulerInput: SchedulerInput = {
    project: { hoursPerDay: project.hoursPerDay },
    epics: activeEpics,
    resourceTypes: resolvedCapacity.resourceTypes,
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

  // ── 2. Run the SA planner for optimised levelling ──────────────────────────
  const saResult = runSAPlanner(schedulerInput, {
    targetDurationWeeks: schedulerInput.epics.length * 13,
    maxParallelismPerFeature: 2,
  })
  const levellingResult = {
    epicStartWeeks: saResult.epicStartWeeks,
    featureStartWeeks: saResult.featureStartWeeks,
    totalDeliveryWeeks: saResult.totalDeliveryWeeks,
    peakUtilisationPct: saResult.peakUtilisationPct,
  }

  if (dryRun) {
    res.json({
      epicStartWeeks: Object.fromEntries(levellingResult.epicStartWeeks),
      featureStartWeeks: Object.fromEntries(levellingResult.featureStartWeeks),
      totalDeliveryWeeks: levellingResult.totalDeliveryWeeks,
      peakUtilisationPct: levellingResult.peakUtilisationPct,
    })
    return
  }

  // ── 3. Persist: snapshot → update Epic.timelineStartWeek → re-materialise ─
  const snapshotData = await buildSnapshot(projectId)
  const dateStr = new Date().toISOString().slice(0, 10)
  const snap = await prisma.backlogSnapshot.create({
    data: {
      projectId,
      label: `Auto-saved before resource levelling — ${dateStr}`,
      trigger: 'level_resources',
      snapshot: snapshotData as unknown as object,
      createdById: req.userId!,
    },
    select: { id: true },
  })
  await pruneSnapshots(prisma, projectId)

  // Update Epic.timelineStartWeek for each epic
  await Promise.all(
    Array.from(levellingResult.epicStartWeeks.entries()).map(([epicId, startWeek]) =>
      prisma.epic.update({ where: { id: epicId }, data: { timelineStartWeek: startWeek } })
    )
  )

  // Update Feature.timelineStartWeek for each feature
  await Promise.all(
    Array.from(levellingResult.featureStartWeeks.entries()).map(([featureId, startWeek]) =>
      prisma.feature.update({ where: { id: featureId }, data: { timelineStartWeek: startWeek } })
    )
  )

  // Re-run scheduler with updated start weeks and materialise timeline
  const updatedEpics = activeEpics.map(e => ({
    ...e,
    timelineStartWeek: levellingResult.epicStartWeeks.get(e.id) ?? e.timelineStartWeek,
    features: e.features.map(f => ({
      ...f,
      timelineStartWeek: levellingResult.featureStartWeeks.get(f.id) ?? f.timelineStartWeek ?? null,
    })),
  }))

  const { featureSchedule, storySchedule } = runScheduler({
    ...schedulerInput,
    epics: updatedEpics,
  })

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

  // Resource levelling rewrites timeline entries — clear cached demand
  await prisma.project.update({
    where: { id: projectId },
    data: { weeklyDemandCache: {} },
  })

  res.json({
    epicStartWeeks: Object.fromEntries(levellingResult.epicStartWeeks),
    featureStartWeeks: Object.fromEntries(levellingResult.featureStartWeeks),
    snapshotId: snap.id,
    totalDeliveryWeeks: levellingResult.totalDeliveryWeeks,
    peakUtilisationPct: levellingResult.peakUtilisationPct,
  })
}))

// PUT /api/projects/:projectId/timeline/:featureId
router.put('/:featureId', asyncHandler(async (req: AuthRequest, res: Response) => {
  const project = await ownedProject(req.params.projectId as string, req.userId!)
  if (!project) { res.status(404).json({ error: 'Project not found' }); return }
  // Manual overrides are planning-owned state (Timeline/Planning boundary).
  assertPlanningCurrent(project)

  const { startWeek, durationWeeks } = req.body
  if (startWeek == null || durationWeeks == null) {
    res.status(400).json({ error: 'startWeek and durationWeeks are required' }); return
  }

  const featureId = req.params.featureId as string
  const feature = await prisma.feature.findFirst({ where: { id: featureId, epic: { projectId: project.id } } })
  if (!feature) { res.status(404).json({ error: 'Feature not found' }); return }


  // Manual feature timeline change invalidates cached scheduler demand
  await prisma.project.update({
    where: { id: project.id },
    data: { weeklyDemandCache: {} },
  })

  const entry = await prisma.timelineEntry.upsert({
    where: { featureId },
    create: { projectId: project.id, featureId, startWeek, durationWeeks, isManual: true },
    update: { startWeek, durationWeeks, isManual: true },
    include: { feature: { include: { epic: true } } },
  })

  res.json({
    featureId: entry.featureId,
    featureName: entry.feature.name,
    epicId: entry.feature.epic.id,
    epicName: entry.feature.epic.name,
    epicFeatureMode: entry.feature.epic.featureMode,
    epicScheduleMode: entry.feature.epic.scheduleMode,
    epicTimelineStartWeek: entry.feature.epic.timelineStartWeek,
    startWeek: entry.startWeek,
    durationWeeks: entry.durationWeeks,
    isManual: entry.isManual,
    ...computeDates(project.startDate, entry.startWeek, entry.durationWeeks, project.onboardingWeeks ?? 0),
  })
}))


// DELETE /api/projects/:projectId/timeline/:featureId — clear manual override
router.delete('/:featureId', asyncHandler(async (req: AuthRequest, res: Response) => {
  const project = await ownedProject(req.params.projectId as string, req.userId!)
  if (!project) { res.status(404).json({ error: 'Project not found' }); return }
  // Manual overrides are planning-owned state (Timeline/Planning boundary).
  assertPlanningCurrent(project)

  await prisma.timelineEntry.deleteMany({
    where: { featureId: req.params.featureId as string, projectId: project.id },
  })

  // Clearing a feature manual override invalidates cached demand
  await prisma.project.update({
    where: { id: project.id },
    data: { weeklyDemandCache: {} },
  })

  res.status(204).end()
}))


// PATCH /api/projects/:projectId/timeline/start-date
router.patch('/start-date', asyncHandler(async (req: AuthRequest, res: Response) => {
  const project = await ownedProject(req.params.projectId as string, req.userId!)
  if (!project) { res.status(404).json({ error: 'Project not found' }); return }

  const { startDate } = req.body
  if (!startDate) { res.status(400).json({ error: 'startDate is required' }); return }

  const updated = await prisma.project.update({
    where: { id: project.id },
    data: { startDate: new Date(startDate) },
  })

  res.json({ startDate: updated.startDate?.toISOString() ?? null })
}))

export default router
