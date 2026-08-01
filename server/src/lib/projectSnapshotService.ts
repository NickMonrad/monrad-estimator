/**
 * projectSnapshotService.ts — Rollback orchestration, snapshot building,
 * and common-state restoration extracted from the Express route.
 *
 * Ownership: auth/ownership checks belong in the Express handler; this
 * service operates on already-authenticated inputs.
 */

import { Prisma, type PrismaClient } from '@prisma/client'
import { prisma } from './prisma.js'
import {
  parseSnapshotData,
  isLegacyV1Snapshot,
  isSnapshotV2,
  isSnapshotV3,
  isSnapshotV4,
  SnapshotSchemaError,
  type SnapshotData,
  type SnapshotV2,
  type SnapshotV3,
  type SnapshotV4,
} from './projectSnapshotTypes.js'
import {
  validateSnapshotV3,
} from './projectSnapshotValidation.js'
import {
  recreateV2CapacityProfiles,
  recreateV3CapacityProfiles,
} from './projectSnapshotCapacity.js'
import { pruneSnapshots } from './snapshotUtils.js'
import {
  loadExactCapacityProfiles,
  type SnapshotDbClient,
} from './exactCapacityProfileReader.js'

// ─── Error types ──────────────────────────────────────────────────────────────

export class RollbackError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RollbackError'
  }
}

export class SnapshotNotFoundError extends RollbackError {
  constructor(message?: string) {
    super(message ?? 'Snapshot not found')
    this.name = 'SnapshotNotFoundError'
  }
}

export class RollbackPreflightError extends RollbackError {
  constructor(message: string) {
    super(message)
    this.name = 'RollbackPreflightError'
  }
}


// ─── Internal helpers (moved verbatim from the Express route) ─────────────────

async function fetchEpics(projectId: string, db: SnapshotDbClient = prisma) {
  return db.epic.findMany({
    where: { projectId },
    orderBy: { order: 'asc' },
    include: {
      features: {
        orderBy: { order: 'asc' },
        include: {
          userStories: {
            orderBy: { order: 'asc' },
            include: {
              tasks: {
                orderBy: { order: 'asc' },
                include: { resourceType: true },
              },
            },
          },
        },
      },
    },
  })
}
function parseWeeklyDemandCache(value: Prisma.JsonValue | null | undefined): Record<string, number> | null {
  if (value == null) return null
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new SnapshotSchemaError('weeklyDemandCache must be a JSON object or null')
  }

  const entries = Object.entries(value)
  const cache: Record<string, number> = {}
  for (const [key, entryValue] of entries) {
    if (typeof entryValue !== 'number' || !Number.isFinite(entryValue)) {
      throw new SnapshotSchemaError('weeklyDemandCache values must be finite numbers')
    }
    cache[key] = entryValue
  }
  return cache
}



// ─── buildSnapshot (public) ───────────────────────────────────────────────────

/**
 * Build the full project snapshot (schemaVersion 4) with ordered capacity
 * profiles.
 *
 * v4 omits the candidate ResourceType/NamedResource legacy capacity columns:
 * all capacity state is captured by capacityProfiles/capacitySegments
 * (issue #418). v1/v2/v3 snapshots remain readable historical input.
 */
export async function buildSnapshot(
  projectId: string,
  db: SnapshotDbClient = prisma,
): Promise<SnapshotV4> {
  const [
    epics,
    project,
    resourceTypes,
    namedResources,
    timelineEntries,
    storyTimelineEntries,
    epicDependencies,
    featureDependencies,
    overheadItems,
    capacityProfiles,
    capacityPlans,
  ] = await Promise.all([
    fetchEpics(projectId, db),
    db.project.findUnique({
      where: { id: projectId },
      select: { startDate: true, onboardingWeeks: true, bufferWeeks: true, hoursPerDay: true, weeklyDemandCache: true },
    }),
    db.resourceType.findMany({
      where: { projectId },
      select: {
        id: true, name: true, category: true, count: true, hoursPerDay: true,
        dayRate: true, globalTypeId: true,
      },
    }),
    db.namedResource.findMany({
      where: { resourceType: { projectId } },
      select: {
        id: true, resourceTypeId: true, name: true,
        pricingModel: true,
      },
    }),
    db.timelineEntry.findMany({
      where: { projectId },
      select: { featureId: true, startWeek: true, durationWeeks: true, isManual: true },
    }),
    db.storyTimelineEntry.findMany({
      where: { projectId },
      select: { storyId: true, startWeek: true, durationWeeks: true, isManual: true },
    }),
    db.epicDependency.findMany({
      where: { epic: { projectId } },
      select: { epicId: true, dependsOnId: true },
    }),
    db.featureDependency.findMany({
      where: { feature: { epic: { projectId } } },
      select: { featureId: true, dependsOnId: true },
    }),
    db.projectOverhead.findMany({
      where: { projectId },
      select: { name: true, type: true, value: true, resourceTypeId: true, order: true },
    }),
    loadExactCapacityProfiles(projectId, db),
    db.capacityPlan?.findMany({
      where: { projectId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        name: true,
        targetWeeks: true,
        periodWeeks: true,
        maxDelta: true,
        isActive: true,
        totalCost: true,
        deliveryWeeks: true,
        createdAt: true,
        periods: {
          orderBy: [{ periodIndex: 'asc' }, { id: 'asc' }],
          select: {
            id: true,
            periodIndex: true,
            startWeek: true,
            endWeek: true,
            entries: {
              orderBy: { id: 'asc' },
              select: {
                id: true,
                resourceTypeId: true,
                headcount: true,
                demandFTE: true,
                utilisationPct: true,
              },
            },
          },
        },
      },
    }) ?? Promise.resolve([]),
  ])

  // Convert Date to ISO string for JSON compatibility
  const projectFields = project
    ? {
        startDate: project.startDate instanceof Date
          ? project.startDate.toISOString()
          : project.startDate,
        onboardingWeeks: project.onboardingWeeks,
        bufferWeeks: project.bufferWeeks,
        hoursPerDay: project.hoursPerDay,
        weeklyDemandCache: parseWeeklyDemandCache(project.weeklyDemandCache),
      }
    : null

  const snapshot: SnapshotV4 = {
    schemaVersion: 4 as const,
    epics,
    project: projectFields,
    resourceTypes,
    namedResources,
    timelineEntries,
    storyTimelineEntries,
    epicDependencies,
    featureDependencies,
    overheadItems,
    capacityProfiles,
    capacityPlans: capacityPlans.map(plan => ({
      ...plan,
      createdAt: plan.createdAt.toISOString(),
    })),
  }

  validateSnapshotV3(snapshot)
  return snapshot
}

// ─── restoreSnapshotCommonState ───────────────────────────────────────────────

/**
 * Restore the common snapshot state shared across v2/v3/v4 rollbacks.
 * Handles ResourceTypes, NamedResources, epics, project fields, timeline
 * entries, story timeline entries, dependencies, and overhead items.
 *
 * Capacity state is restored exclusively through capacity profiles:
 * the candidate ResourceType/NamedResource legacy capacity columns are
 * historical input (v2/v3) or absent (v4) and are never written during
 * restoration (issue #418).
 */
export async function restoreSnapshotCommonState(
  tx: SnapshotDbClient,
  projectId: string,
  data: Omit<SnapshotV2, 'schemaVersion'> | Omit<SnapshotV4, 'schemaVersion'>,
): Promise<void> {
  // 1. Restore ResourceTypes FIRST so task FKs resolve correctly when recreating epics
  const rtNameMap = new Map<string, string>()
  for (const rt of data.resourceTypes) {
    await tx.resourceType.upsert({
      where: { id: rt.id },
      update: {
        name: rt.name,
        category: rt.category,
        count: rt.count,
        hoursPerDay: rt.hoursPerDay,
        dayRate: rt.dayRate,
        globalTypeId: rt.globalTypeId,
      },
      create: {
        id: rt.id,
        name: rt.name,
        category: rt.category,
        count: rt.count,
        hoursPerDay: rt.hoursPerDay,
        dayRate: rt.dayRate,
        globalTypeId: rt.globalTypeId,
        projectId,
      },
    })
    rtNameMap.set(rt.name.toLowerCase(), rt.id)
  }

  // 2. Delete post-snapshot NamedResources not in the snapshot,
  //    then restore snapshot NamedResources (depends on RTs existing).
  //    Cascade deletes any capacity profiles referencing the orphan NRs.
  const snapshotNrIds = new Set(data.namedResources.map(nr => nr.id))
  const projectNRs = await tx.namedResource.findMany({
    where: { resourceType: { projectId } },
    select: { id: true },
  })
  const orphanIds = projectNRs
    .filter(nr => !snapshotNrIds.has(nr.id))
    .map(nr => nr.id)
  if (orphanIds.length > 0) {
    await tx.namedResource.deleteMany({ where: { id: { in: orphanIds } } })
  }

  // Restore NamedResources (depends on RTs existing)
  for (const nr of data.namedResources) {
    await tx.namedResource.upsert({
      where: { id: nr.id },
      update: {
        name: nr.name,
        resourceTypeId: nr.resourceTypeId,
        pricingModel: nr.pricingModel,
      },
      create: {
        id: nr.id,
        resourceTypeId: nr.resourceTypeId,
        name: nr.name,
        pricingModel: nr.pricingModel,
      },
    })
  }

  // 3. Restore epics (delete all, recreate from snapshot — IDs will change)
  await tx.epic.deleteMany({ where: { projectId } })

  // Build old→new ID maps as we recreate the tree
  const epicIdMap = new Map<string, string>()
  const featureIdMap = new Map<string, string>()
  const storyIdMap = new Map<string, string>()

  for (const epic of data.epics) {
    const newEpic = await tx.epic.create({
      data: { name: epic.name, description: epic.description, assumptions: epic.assumptions, order: epic.order, projectId, featureMode: epic.featureMode, scheduleMode: epic.scheduleMode, timelineStartWeek: epic.timelineStartWeek, isActive: epic.isActive },
    })
    epicIdMap.set(epic.id, newEpic.id)
    for (const feature of epic.features) {
      const newFeature = await tx.feature.create({
      data: { name: feature.name, description: feature.description, assumptions: feature.assumptions, order: feature.order, epicId: newEpic.id, featureMode: feature.featureMode, isActive: feature.isActive, timelineColour: feature.timelineColour, timelineStartWeek: feature.timelineStartWeek },
      })
      featureIdMap.set(feature.id, newFeature.id)
      for (const story of feature.userStories) {
        const newStory = await tx.userStory.create({
      data: { name: story.name, description: story.description, assumptions: story.assumptions, order: story.order, featureId: newFeature.id, appliedTemplateId: story.appliedTemplateId, isActive: story.isActive ?? true },
        })
        storyIdMap.set(story.id, newStory.id)
        for (const task of story.tasks) {
          const resourceTypeId = task.resourceType?.name
            ? (rtNameMap.get(task.resourceType.name.toLowerCase()) ?? null)
            : null
          await tx.task.create({
            data: {
              name: task.name,
              description: task.description,
              assumptions: task.assumptions,
              hoursEffort: task.hoursEffort,
              durationDays: task.durationDays,
              order: task.order,
              userStoryId: newStory.id,
              resourceTypeId,
            },
          })
        }
      }
    }
  }

  // 4. Restore project fields
  if (data.project) {
    await tx.project.update({
      where: { id: projectId },
      data: {
        startDate: data.project.startDate,
        onboardingWeeks: data.project.onboardingWeeks ?? 0,
        bufferWeeks: data.project.bufferWeeks ?? 0,
        hoursPerDay: data.project.hoursPerDay ?? 7.6,
        ...(data.project.weeklyDemandCache !== undefined
          ? {
              weeklyDemandCache: data.project.weeklyDemandCache === null
                ? Prisma.DbNull
                : data.project.weeklyDemandCache,
            }
          : {}),
      },
    })
  }

  // 5. Restore TimelineEntries
  await tx.timelineEntry.deleteMany({ where: { projectId } })
  if (data.timelineEntries.length > 0) {
    const mappedTLEs = data.timelineEntries
      .map(e => {
        const newFeatureId = featureIdMap.get(e.featureId)
        if (!newFeatureId) return null
        return {
          projectId,
          featureId: newFeatureId,
          startWeek: e.startWeek,
          durationWeeks: e.durationWeeks,
          isManual: e.isManual,
        }
      })
      .filter((e): e is NonNullable<typeof e> => e !== null)
    if (mappedTLEs.length > 0) {
      await tx.timelineEntry.createMany({ data: mappedTLEs, skipDuplicates: true })
    }
  }

  // 6. Restore StoryTimelineEntries
  await tx.storyTimelineEntry.deleteMany({ where: { projectId } })
  if (data.storyTimelineEntries.length > 0) {
    const mappedSTLEs = data.storyTimelineEntries
      .map(e => {
        const newStoryId = storyIdMap.get(e.storyId)
        if (!newStoryId) return null
        return {
          projectId,
          storyId: newStoryId,
          startWeek: e.startWeek,
          durationWeeks: e.durationWeeks,
          isManual: e.isManual,
        }
      })
      .filter((e): e is NonNullable<typeof e> => e !== null)
    if (mappedSTLEs.length > 0) {
      await tx.storyTimelineEntry.createMany({ data: mappedSTLEs, skipDuplicates: true })
    }
  }

  // 7. Restore EpicDependencies
  await tx.epicDependency.deleteMany({ where: { epic: { projectId } } })
  if (data.epicDependencies.length > 0) {
    const mappedEDs = data.epicDependencies
      .map(d => {
        const newEpicId = epicIdMap.get(d.epicId)
        const newDependsOnId = epicIdMap.get(d.dependsOnId)
        if (!newEpicId || !newDependsOnId) return null
        return { epicId: newEpicId, dependsOnId: newDependsOnId }
      })
      .filter((d): d is NonNullable<typeof d> => d !== null)
    if (mappedEDs.length > 0) {
      await tx.epicDependency.createMany({ data: mappedEDs, skipDuplicates: true })
    }
  }

  // 8. Restore FeatureDependencies
  await tx.featureDependency.deleteMany({ where: { feature: { epic: { projectId } } } })
  if (data.featureDependencies.length > 0) {
    const mappedFDs = data.featureDependencies
      .map(d => {
        const newFeatureId = featureIdMap.get(d.featureId)
        const newDependsOnId = featureIdMap.get(d.dependsOnId)
        if (!newFeatureId || !newDependsOnId) return null
        return { featureId: newFeatureId, dependsOnId: newDependsOnId }
      })
      .filter((d): d is NonNullable<typeof d> => d !== null)
    if (mappedFDs.length > 0) {
      await tx.featureDependency.createMany({ data: mappedFDs, skipDuplicates: true })
    }
  }

  // 9. Restore OverheadItems
  await tx.projectOverhead.deleteMany({ where: { projectId } })
  if (data.overheadItems.length > 0) {
    await tx.projectOverhead.createMany({
      data: data.overheadItems.map(o => ({
        projectId,
        name: o.name,
        type: o.type,
        value: o.value,
        resourceTypeId: o.resourceTypeId,
        order: o.order,
      })),
      skipDuplicates: true,
    })
  }
}

/** Restore the exact capacity-plan history captured by a v3 snapshot. */
async function restoreSnapshotCapacityPlans(
  tx: SnapshotDbClient,
  projectId: string,
  plans: SnapshotV3['capacityPlans'],
): Promise<void> {
  if (plans === undefined) return

  await tx.capacityPlan.deleteMany({ where: { projectId } })
  for (const plan of plans) {
    await tx.capacityPlan.create({
      data: {
        id: plan.id,
        projectId,
        name: plan.name,
        targetWeeks: plan.targetWeeks,
        periodWeeks: plan.periodWeeks,
        maxDelta: plan.maxDelta,
        isActive: plan.isActive,
        totalCost: plan.totalCost,
        deliveryWeeks: plan.deliveryWeeks,
        createdAt: new Date(plan.createdAt),
        periods: {
          create: plan.periods.map(period => ({
            id: period.id,
            periodIndex: period.periodIndex,
            startWeek: period.startWeek,
            endWeek: period.endWeek,
            entries: {
              create: period.entries.map(entry => ({
                id: entry.id,
                resourceTypeId: entry.resourceTypeId,
                headcount: entry.headcount,
                demandFTE: entry.demandFTE,
                utilisationPct: entry.utilisationPct,
              })),
            },
          })),
        },
      },
    })
  }
}

// ─── rollbackProjectSnapshot (the authoritative rollback operation) ───────────

/**
 * Execute a destructive rollback of a project to the state captured in a
 * selected backlog snapshot.
 *
 * Flow:
 *  1. Load target snapshot and fail-closed on not-found.
 *  2. Parse and validate the embedded snapshot JSON.
 *  3. V3: pre-flight cross-project ownership validation (before any writes).
 *  4. Inside a single $transaction:
 *       a. Build a current v3 pre_rollback snapshot.
 *       b. Persist the pre_rollback snapshot record.
 *       c. Restore common state (resource types, named resources, epic tree,
 *          project fields, timeline entries, dependencies, overhead items).
 *       d. Run version-specific capacity profile recovery.
 *       e. Prune older snapshots to enforce the retention policy.
 *
 * Does NOT perform auth/ownership checks — those belong in the caller.
 *
 * @throws {SnapshotNotFoundError} if the target snapshot does not exist.
 * @throws {SnapshotSchemaError} if the snapshot JSON cannot be parsed.
 * @throws {SnapshotValidationError} if the V3 payload fails validation.
 * @throws {RollbackPreflightError} if V3 cross-project ID collisions are detected.
 */
export async function rollbackProjectSnapshot({
  projectId,
  snapshotId,
  userId,
  db = prisma,
}: {
  projectId: string
  snapshotId: string
  userId: string
  db?: PrismaClient
}): Promise<void> {
  // 1. Load target snapshot
  const snap = await db.backlogSnapshot.findFirst({
    where: { id: snapshotId, projectId },
  })
  if (!snap) {
    throw new SnapshotNotFoundError('Snapshot not found')
  }

  // 2. Parse snapshot data BEFORE any destructive operation
  let parsedData: SnapshotData
  try {
    parsedData = parseSnapshotData(snap.snapshot)
  } catch (e) {
    if (e instanceof SnapshotSchemaError) {
      throw e
    }
    throw e
  }

  // 3. V3/V4: validation + pre-flight checks before any writes
  if (isSnapshotV3(parsedData) || isSnapshotV4(parsedData)) {
    validateSnapshotV3(parsedData)

    // Cross-project owner ID collision check
    const allRtIds = [
      ...new Set([
        ...parsedData.resourceTypes.map(rt => rt.id),
        ...parsedData.capacityProfiles
          .filter(p => p.ownerKind === 'ROLE' && p.resourceTypeId)
          .map(p => p.resourceTypeId as string),
        ...parsedData.overheadItems
          .filter(o => o.resourceTypeId !== null)
          .map(o => o.resourceTypeId as string),
        ...(parsedData.capacityPlans ?? []).flatMap(plan =>
          plan.periods.flatMap(period => period.entries.map(entry => entry.resourceTypeId)),
        ),
      ]),
    ]
    const allNrIds = [
      ...new Set([
        ...parsedData.namedResources.map(nr => nr.id),
        ...parsedData.capacityProfiles
          .filter(p =>
            (p.ownerKind === 'NAMED_PERSON' || p.ownerKind === 'PLANNED_RESOURCE') && p.namedResourceId,
          )
          .map(p => p.namedResourceId as string),
      ]),
    ]

    if (allRtIds.length > 0) {
      const existingRTs = await db.resourceType.findMany({
        where: { id: { in: allRtIds } },
        select: { id: true, projectId: true },
      })
      const crossProjectRTs = existingRTs.filter(rt => rt.projectId !== projectId)
      if (crossProjectRTs.length > 0) {
        throw new RollbackPreflightError(
          `Resource type IDs ${crossProjectRTs.map(rt => rt.id).join(', ')} belong to another project; rollback rejected`,
        )
      }
    }

    if (allNrIds.length > 0) {
      const existingNRs = await db.namedResource.findMany({
        where: { id: { in: allNrIds } },
        select: { id: true, resourceType: { select: { projectId: true } } },
      })
      const crossProjectNRs = existingNRs.filter(nr => nr.resourceType.projectId !== projectId)
      if (crossProjectNRs.length > 0) {
        throw new RollbackPreflightError(
          `Named resource IDs ${crossProjectNRs.map(nr => nr.id).join(', ')} belong to another project; rollback rejected`,
        )
      }
    }
  }

  // 4. All validation passed — one atomic transaction
  const dateStr = new Date().toISOString().slice(0, 10)
  const originalLabel = snap.label ?? snapshotId

  await db.$transaction(async tx => {
    // Pre-rollback snapshot inside the transaction
    const preRollbackData = await buildSnapshot(projectId, tx)
    await tx.backlogSnapshot.create({
      data: {
        projectId,
        label: `Auto-saved before rollback to '${originalLabel}' — ${dateStr}`,
        trigger: 'pre_rollback',
        snapshot: preRollbackData as unknown as object,
        createdById: userId,
      },
    })

    // Restore based on schema version
    if (isLegacyV1Snapshot(parsedData)) {
      // --- V1: restore epics only ---
      const resourceTypes = await tx.resourceType.findMany({
        where: { projectId },
        select: { id: true, name: true },
      })
      const rtMap = new Map(resourceTypes.map(rt => [rt.name.toLowerCase(), rt.id]))

      await tx.epic.deleteMany({ where: { projectId } })
      for (const epic of parsedData) {
        const newEpic = await tx.epic.create({
          data: { name: epic.name, description: epic.description, assumptions: epic.assumptions, order: epic.order, projectId, featureMode: epic.featureMode, scheduleMode: epic.scheduleMode, timelineStartWeek: epic.timelineStartWeek, isActive: epic.isActive },
        })
        for (const feature of epic.features) {
          const newFeature = await tx.feature.create({
            data: { name: feature.name, description: feature.description, assumptions: feature.assumptions, order: feature.order, epicId: newEpic.id, featureMode: feature.featureMode, isActive: feature.isActive, timelineColour: feature.timelineColour, timelineStartWeek: feature.timelineStartWeek },
          })
          for (const story of feature.userStories) {
            const newStory = await tx.userStory.create({
              data: { name: story.name, description: story.description, assumptions: story.assumptions, order: story.order, featureId: newFeature.id, appliedTemplateId: story.appliedTemplateId, isActive: story.isActive ?? true },
            })
            for (const task of story.tasks) {
              const taskRtId = task.resourceType?.name
                ? (rtMap.get(task.resourceType.name.toLowerCase()) ?? null)
                : null
              await tx.task.create({
                data: {
                  name: task.name,
                  description: task.description,
                  assumptions: task.assumptions,
                  hoursEffort: task.hoursEffort,
                  durationDays: task.durationDays,
                  order: task.order,
                  userStoryId: newStory.id,
                  resourceTypeId: taskRtId,
                },
              })
            }
          }
        }
      }
      // V1 does NOT touch resource types, named resources, capacity profiles, or segments
    } else if (isSnapshotV2(parsedData)) {
      // --- V2: full-state restore + capacity profile cleanup ---
      await restoreSnapshotCommonState(tx, projectId, parsedData)
      await recreateV2CapacityProfiles(tx, projectId, parsedData)
    } else if (isSnapshotV3(parsedData)) {
      // --- V3: full-state restore + exact profile/segment and plan replacement ---
      await restoreSnapshotCommonState(tx, projectId, parsedData)
      await recreateV3CapacityProfiles(tx, projectId, parsedData)
      await restoreSnapshotCapacityPlans(tx, projectId, parsedData.capacityPlans)
    } else if (isSnapshotV4(parsedData)) {
      // --- V4: full-state restore + exact profile/segment and plan replacement ---
      // Capacity state is exclusively profile-based; the candidate legacy
      // columns are absent from v4 payloads (issue #418).
      await restoreSnapshotCommonState(tx, projectId, parsedData)
      await recreateV3CapacityProfiles(tx, projectId, parsedData)
      await restoreSnapshotCapacityPlans(tx, projectId, parsedData.capacityPlans)
    }

    // Enforce retention policy inside the same transaction
    await pruneSnapshots(tx, projectId)
  })
}
