/**
 * scheduleProject.ts — Focused transactional scheduling command (issue #387).
 *
 * Moves schedule orchestration out of the Express route into one command:
 *
 *   1. verify ownership
 *   2. validate the request inputs
 *   3. load scheduler inputs and existing manual overrides
 *   4. run the existing pure runScheduler()
 *   5. persist all schedule-owned writes atomically in one Prisma transaction
 *   6. reload and return the canonical planning model
 *
 * The transaction covers feature timeline entries, story timeline entries,
 * removal of inactive/superseded generated entries, the applicable project
 * start-date change, and weeklyDemandCache. A failure while writing any part
 * leaves the previous persisted schedule and cache intact.
 *
 * No generic command/query framework: a focused function over the existing
 * Prisma/Express patterns, mirroring the afterWrites test seam already used by
 * resetProjectPlanning (issue #449).
 */

import { Prisma } from '@prisma/client'
import { prisma } from './prisma.js'
import { runScheduler } from './scheduler.js'
import { resolveSchedulerCapacity } from './schedulerCapacityResolver.js'
import { assertPlanningCurrent } from './projectPlanningState.js'
import {
  buildProjectPlanningModel,
  ProjectNotFoundError,
  type ProjectPlanningModel,
} from './projectPlanningModel.js'

/** Actionable input-validation error (maps to HTTP 400). */
export class ScheduleValidationError extends Error {
  readonly status = 400
  readonly userMessage: string

  constructor(message: string) {
    super(message)
    this.name = 'ScheduleValidationError'
    this.userMessage = message
  }
}

export interface ScheduleProjectOptions {
  /**
   * Test-only seam: invoked inside the transaction after every schedule write
   * and before commit. Throwing from it rolls the whole schedule back.
   */
  afterWrites?: (tx: Prisma.TransactionClient) => Promise<void>
}

export interface ScheduleProjectInput {
  projectId: string
  userId: string
  /** Optional new project start date (ISO string). */
  startDate?: string
  /** When true, run the resource-levelling simulation. */
  resourceLevel?: boolean
}

export async function scheduleProject(
  input: ScheduleProjectInput,
  options: ScheduleProjectOptions = {},
): Promise<ProjectPlanningModel> {
  const { projectId, userId } = input
  const resourceLevel = input.resourceLevel === true

  // ── 1. Verify ownership and planning state ──────────────────────────────
  const project = await prisma.project.findFirst({
    where: { id: projectId, ownerId: userId },
  })
  if (!project) {
    throw new ProjectNotFoundError()
  }
  // Planning-dependent: the scheduler consumes the current capacity model.
  assertPlanningCurrent(project)

  // ── 2. Validate request inputs ──────────────────────────────────────────
  let parsedStartDate: Date | null = null
  if (input.startDate != null && input.startDate !== '') {
    const candidate = new Date(input.startDate)
    if (Number.isNaN(candidate.getTime())) {
      throw new ScheduleValidationError('startDate must be a valid ISO date string')
    }
    parsedStartDate = candidate
  }

  // ── 3. Load scheduler inputs and manual overrides ───────────────────────
  const allEpics = await prisma.epic.findMany({
    where: { projectId: project.id },
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
  })

  // Remove inactive epics and features from scheduling
  const inactiveFeatureIds = allEpics.flatMap(e =>
    e.isActive === false
      ? e.features.map(f => f.id)
      : e.features.filter(f => f.isActive === false).map(f => f.id)
  )
  const epics = allEpics
    .filter(e => e.isActive !== false)
    .map(e => ({ ...e, features: e.features.filter(f => f.isActive !== false) }))

  // Use shared profile-first capacity resolver
  const resolved = await resolveSchedulerCapacity(prisma, project.id)

  const [existingEntries, existingStoryEntries, epicDeps] = await Promise.all([
    prisma.timelineEntry.findMany({
      where: { projectId: project.id, isManual: true },
    }),
    prisma.storyTimelineEntry.findMany({
      where: { projectId: project.id, isManual: true },
    }),
    prisma.epicDependency.findMany({
      where: { epic: { projectId: project.id } },
      select: { epicId: true, dependsOnId: true },
    }),
  ])

  // ── 4. Run the pure scheduler ───────────────────────────────────────────
  const { featureSchedule, storySchedule, weeklyConsumptionMap } = runScheduler({
    project: { hoursPerDay: project.hoursPerDay },
    epics,
    resourceTypes: resolved.resourceTypes,
    epicDeps,
    manualFeatureEntries: existingEntries.map(e => ({
      featureId: e.featureId,
      startWeek: e.startWeek,
      durationWeeks: e.durationWeeks,
    })),
    manualStoryEntries: existingStoryEntries.map(e => ({
      storyId: e.storyId,
      startWeek: e.startWeek,
    })),
    resourceLevel,
  })

  // ── 5. Persist schedule-owned writes atomically ─────────────────────────
  await prisma.$transaction(async tx => {
    // Removal of inactive/superseded generated entries is part of the update
    if (inactiveFeatureIds.length > 0) {
      await tx.timelineEntry.deleteMany({
        where: { featureId: { in: inactiveFeatureIds } },
      })
    }

    // Feature timeline upserts (manual rows keep their pinned values)
    for (const { featureId, startWeek, durationWeeks, isManual } of featureSchedule) {
      await tx.timelineEntry.upsert({
        where: { featureId },
        create: { projectId: project.id, featureId, startWeek, durationWeeks, isManual },
        update: isManual ? {} : { startWeek, durationWeeks, isManual: false },
      })
    }

    // Story timeline upserts (manual rows keep their pinned values)
    for (const { storyId, startWeek, durationWeeks, isManual } of storySchedule) {
      await tx.storyTimelineEntry.upsert({
        where: { storyId },
        create: { storyId, projectId: project.id, startWeek, durationWeeks, isManual },
        update: isManual ? {} : { startWeek, durationWeeks, isManual: false },
      })
    }

    // Applicable project start-date change + demand cache in the same write
    await tx.project.update({
      where: { id: project.id },
      data: {
        ...(parsedStartDate ? { startDate: parsedStartDate } : {}),
        weeklyDemandCache: Object.fromEntries(weeklyConsumptionMap),
      },
    })

    if (options.afterWrites) {
      await options.afterWrites(tx)
    }
  })

  // ── 6. Reload the canonical planning model ──────────────────────────────
  return buildProjectPlanningModel(projectId, userId)
}
