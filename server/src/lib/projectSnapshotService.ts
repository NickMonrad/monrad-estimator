/**
 * projectSnapshotService.ts — Rollback orchestration, snapshot building,
 * and common-state restoration extracted from the Express route.
 *
 * Ownership: auth/ownership checks belong in the Express handler; this
 * service operates on already-authenticated inputs.
 */

import { Prisma } from '@prisma/client'
import type { PrismaClient } from '@prisma/client'
import { prisma } from './prisma.js'
import {
  parseSnapshotData,
  isLegacyV1Snapshot,
  isSnapshotV2,
  isSnapshotV3,
  SnapshotSchemaError,
  type SnapshotData,
  type SnapshotJsonValue,
  type SnapshotV2,
  type SnapshotV3,
} from './projectSnapshotTypes.js'
import {
  validateSnapshotV3,
  sortSnapshotProfiles,
  sortSnapshotSegments,
} from './projectSnapshotValidation.js'
import {
  recreateV2CapacityProfiles,
  recreateV3CapacityProfiles,
} from './projectSnapshotCapacity.js'
import { pruneSnapshots } from './snapshotUtils.js'

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

// ─── Client type ──────────────────────────────────────────────────────────────

/** Client type compatible with both PrismaClient and transaction client. */
export type SnapshotDbClient =
  | PrismaClient
  | Omit<PrismaClient, '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'>

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

/**
 * Detect which project capacity profiles have database-NULL legacy.
 * Prisma reads both DB_NULL (Prisma.DbNull) and JSON null (Prisma.JsonNull)
 * as JavaScript null; this raw query distinguishes them so the snapshot can
 * preserve the exact null semantics.
 *
 * Uses parameterised Prisma.sql via $queryRaw for compatibility with
 * PrismaClient, transaction clients, and explicit unit doubles.
 * Validates exact 1:1 correspondence with ORM-loaded profiles.
 */
async function fetchLegacyNullMap(
  projectId: string,
  db: SnapshotDbClient,
  rawProfiles: Array<{ id: string }>,
): Promise<Map<string, boolean>> {
  const rows = await db.$queryRaw<Array<{ id: string; legacy_is_null: boolean; legacy_typeof: string | null }>>(
    Prisma.sql`SELECT id, "legacy" IS NULL AS legacy_is_null, jsonb_typeof("legacy") AS legacy_typeof FROM "CapacityProfile" WHERE "projectId" = ${projectId} ORDER BY id`,
  )

  // Validate exact 1:1 correspondence with ORM-loaded profiles
  const profileIds = new Set(rawProfiles.map(p => p.id))
  const seen = new Set<string>()
  for (const row of rows) {
    if (seen.has(row.id)) {
      throw new Error(`Duplicate null-state row for capacity profile ${row.id}`)
    }
    if (!profileIds.has(row.id)) {
      throw new Error(`Null-state row references unknown capacity profile ${row.id}`)
    }
    seen.add(row.id)
  }
  for (const p of rawProfiles) {
    if (!seen.has(p.id)) {
      throw new Error(`Missing null-state row for capacity profile ${p.id}`)
    }
  }

  return new Map(rows.map(r => [r.id, r.legacy_is_null]))
}

// ─── buildSnapshot (public) ───────────────────────────────────────────────────

/** Build the full project snapshot (schemaVersion 3) with ordered capacity profiles. */
export async function buildSnapshot(
  projectId: string,
  db: SnapshotDbClient = prisma,
): Promise<SnapshotV3> {
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
    rawProfiles,
  ] = await Promise.all([
    fetchEpics(projectId, db),
    db.project.findUnique({
      where: { id: projectId },
      select: { startDate: true, onboardingWeeks: true, bufferWeeks: true, hoursPerDay: true },
    }),
    db.resourceType.findMany({
      where: { projectId },
      select: {
        id: true, name: true, category: true, count: true, hoursPerDay: true,
        dayRate: true, globalTypeId: true,
        allocationMode: true, allocationPercent: true,
        allocationStartWeek: true, allocationEndWeek: true,
      },
    }),
    db.namedResource.findMany({
      where: { resourceType: { projectId } },
      select: {
        id: true, resourceTypeId: true, name: true,
        startWeek: true, endWeek: true, allocationPct: true,
        allocationMode: true, allocationPercent: true,
        allocationStartWeek: true, allocationEndWeek: true,
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
    db.capacityProfile.findMany({
      where: { projectId },
      include: {
        segments: { orderBy: { startWeek: 'asc' } },
      },
      orderBy: [
        { ownerKind: 'asc' },
        { resourceTypeId: 'asc' },
        { namedResourceId: 'asc' },
      ],
    }),
  ])

  const legacyNullMap = await fetchLegacyNullMap(projectId, db, rawProfiles)
  // Convert Date to ISO string for JSON compatibility
  const projectFields = project
    ? {
        startDate: project.startDate instanceof Date
          ? project.startDate.toISOString()
          : project.startDate,
        onboardingWeeks: project.onboardingWeeks,
        bufferWeeks: project.bufferWeeks,
        hoursPerDay: project.hoursPerDay,
      }
    : null

  // Map Prisma model rows to SnapshotCapacityProfile, preserving null semantics
  const capacityProfiles = rawProfiles.map(p => {
    // Determine the precise null state for legacy
    const isDBNull = legacyNullMap.get(p.id) ?? false
    let legacy: SnapshotJsonValue
    if (isDBNull) {
      legacy = { kind: 'DB_NULL' }
    } else if (p.legacy === null) {
      legacy = { kind: 'JSON_NULL' }
    } else {
      legacy = { kind: 'VALUE', value: p.legacy as Record<string, unknown> | unknown[] | string | number | boolean }
    }

    return {
      id: p.id,
      ownerKind: p.ownerKind as SnapshotV3['capacityProfiles'][number]['ownerKind'],
      resourceTypeId: p.resourceTypeId,
      namedResourceId: p.namedResourceId,
      planningBasis: p.planningBasis as SnapshotV3['capacityProfiles'][number]['planningBasis'],
      source: p.source as SnapshotV3['capacityProfiles'][number]['source'],
      defaultPercent: p.defaultPercent,
      startWeek: p.startWeek,
      endWeek: p.endWeek,
      legacy,
      segments: sortSnapshotSegments(p.segments.map(s => ({
        id: s.id,
        startWeek: s.startWeek,
        endWeek: s.endWeek,
        capacityPercent: s.capacityPercent,
        source: s.source as SnapshotV3['capacityProfiles'][number]['segments'][number]['source'],
      }))),
    }
  })

  const snapshot: SnapshotV3 = {
    schemaVersion: 3 as const,
    epics,
    project: projectFields,
    resourceTypes,
    namedResources,
    timelineEntries,
    storyTimelineEntries,
    epicDependencies,
    featureDependencies,
    overheadItems,
    capacityProfiles: sortSnapshotProfiles(capacityProfiles),
  }

  validateSnapshotV3(snapshot)
  return snapshot
}

// ─── restoreSnapshotCommonState ───────────────────────────────────────────────

/**
 * Restore the common snapshot state shared across v2 and v3 rollbacks.
 * Handles ResourceTypes, NamedResources, epics, project fields, timeline
 * entries, story timeline entries, dependencies, and overhead items.
 */
async function restoreSnapshotCommonState(
  tx: SnapshotDbClient,
  projectId: string,
  data: Omit<SnapshotV2, 'schemaVersion'>,
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
        allocationMode: rt.allocationMode,
        allocationPercent: rt.allocationPercent,
        allocationStartWeek: rt.allocationStartWeek,
        allocationEndWeek: rt.allocationEndWeek,
      },
      create: {
        id: rt.id,
        name: rt.name,
        category: rt.category,
        count: rt.count,
        hoursPerDay: rt.hoursPerDay,
        dayRate: rt.dayRate,
        globalTypeId: rt.globalTypeId,
        allocationMode: rt.allocationMode,
        allocationPercent: rt.allocationPercent,
        allocationStartWeek: rt.allocationStartWeek,
        allocationEndWeek: rt.allocationEndWeek,
        projectId,
      },
    })
    rtNameMap.set(rt.name.toLowerCase(), rt.id)
  }

  // 2. Restore NamedResources (depends on RTs existing)
  for (const nr of data.namedResources) {
    await tx.namedResource.upsert({
      where: { id: nr.id },
      update: {
        name: nr.name,
        resourceTypeId: nr.resourceTypeId,
        startWeek: nr.startWeek,
        endWeek: nr.endWeek,
        allocationPct: nr.allocationPct,
        allocationMode: nr.allocationMode,
        allocationPercent: nr.allocationPercent,
        allocationStartWeek: nr.allocationStartWeek,
        allocationEndWeek: nr.allocationEndWeek,
        pricingModel: nr.pricingModel,
      },
      create: {
        id: nr.id,
        resourceTypeId: nr.resourceTypeId,
        name: nr.name,
        startWeek: nr.startWeek,
        endWeek: nr.endWeek,
        allocationPct: nr.allocationPct,
        allocationMode: nr.allocationMode,
        allocationPercent: nr.allocationPercent,
        allocationStartWeek: nr.allocationStartWeek,
        allocationEndWeek: nr.allocationEndWeek,
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

/**
 * V3-only: Delete ResourceTypes and NamedResources that exist in the project
 * but are absent from the target snapshot, handling FK-safe ordering.
 * Called after restoreSnapshotCommonState has recreated dependent rows
 * and before recreateV3CapacityProfiles recreates profiles.
 */
async function pruneNonTargetOwners(
  tx: SnapshotDbClient,
  projectId: string,
  data: { resourceTypes: Array<{ id: string }>; namedResources: Array<{ id: string }> },
): Promise<void> {
  const targetRtIds = new Set(data.resourceTypes.map(rt => rt.id))
  const targetNrIds = new Set(data.namedResources.map(nr => nr.id))

  // 1. Determine non-target ResourceTypes before deleting any owners.
  const rtWhere = targetRtIds.size > 0
    ? { projectId, id: { notIn: Array.from(targetRtIds) } }
    : { projectId }
  const nonTargetRts = await tx.resourceType.findMany({
    where: rtWhere,
    select: { id: true },
  })
  const nonTargetRtIds = nonTargetRts.map(rt => rt.id)

  // 2. Delete role-scoped discounts owned exclusively by pruned roles.
  //    Never null resourceTypeId: null means project-wide to Commercial.
  //    The projectId predicate prevents touching another project's discounts.
  if (nonTargetRtIds.length > 0) {
    await tx.projectDiscount.deleteMany({
      where: {
        projectId,
        resourceTypeId: { in: nonTargetRtIds },
      },
    })
  }

  // 3. Clear other non-cascading references before deleting ResourceTypes.
  if (nonTargetRtIds.length > 0 && tx.templateTask) {
    await tx.templateTask.updateMany({
      where: { resourceTypeId: { in: nonTargetRtIds } },
      data: { resourceTypeId: null },
    })
  }

  // 4. Delete non-target NamedResources (cascades to their capacity profiles).
  const nrWhere = targetNrIds.size > 0
    ? { resourceType: { projectId }, id: { notIn: Array.from(targetNrIds) } }
    : { resourceType: { projectId } }
  const nonTargetNrs = await tx.namedResource.findMany({
    where: nrWhere,
    select: { id: true },
  })
  if (nonTargetNrs.length > 0) {
    await tx.namedResource.deleteMany({
      where: { id: { in: nonTargetNrs.map(nr => nr.id) } },
    })
  }

  // 5. Delete non-target ResourceTypes (cascade handles profiles).
  if (nonTargetRtIds.length > 0) {
    await tx.resourceType.deleteMany({
      where: { id: { in: nonTargetRtIds } },
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

  // 3. V3: validation + pre-flight checks before any writes
  if (isSnapshotV3(parsedData)) {
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
      // --- V3: full-state restore + exact profile/segment replacement ---
      await restoreSnapshotCommonState(tx, projectId, parsedData)
      await pruneNonTargetOwners(tx, projectId, parsedData)
      await recreateV3CapacityProfiles(tx, projectId, parsedData)
    }

    // Enforce retention policy inside the same transaction
    await pruneSnapshots(tx, projectId)
  })
}
