import { Router, Response } from 'express'
import type { PrismaClient } from '@prisma/client'
import { prisma } from '../lib/prisma.js'
import { asyncHandler } from '../lib/asyncHandler.js'
import { authenticate, AuthRequest } from '../middleware/auth.js'
import { ownedProject } from '../lib/ownership.js'
import { pruneSnapshots } from '../lib/snapshotUtils.js'
import {
  parseSnapshotData,
  isLegacyV1Snapshot,
  isSnapshotV2,
  isSnapshotV3,
  SnapshotSchemaError,
  type SnapshotData,
  type SnapshotEpic,
  type SnapshotJsonValue,
  type SnapshotV2,
  type SnapshotV3,
} from '../lib/projectSnapshotTypes.js'
import {
  validateSnapshotV3,
  SnapshotValidationError,
  sortSnapshotProfiles,
  sortSnapshotSegments,
} from '../lib/projectSnapshotValidation.js'
import {
  recreateV2CapacityProfiles,
  recreateV3CapacityProfiles,
} from '../lib/projectSnapshotCapacity.js'

const router = Router({ mergeParams: true })
router.use(authenticate)

// ---------------------------------------------------------------------------
// Schema versions: 1 (bare epic array), 2 (full state), 3 (v2 + capacityProfiles)
// Documented trigger values:
//   'manual'           — user-initiated from the UI
//   'csv_import'       — auto-saved before a CSV import
//   'template_apply'   — auto-saved before applying a template
//   'optimiser_apply'  — auto-saved before the optimiser applies a scenario (Phase 2+)
//   'pre_rollback'     — auto-saved before rolling back to a prior snapshot (reversible rollback)
// ---------------------------------------------------------------------------

/** Client type compatible with both PrismaClient and transaction client. */
type SnapshotDbClient = PrismaClient | Omit<PrismaClient, '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'>

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
 * Returns an empty map when $queryRawUnsafe is unavailable (e.g. mock client),
 * so all profiles are treated as VALUE/JSON_VALUE — safe for tests that don't
 * exercise DB_NULL vs JSON_NULL discrimination.
 */
async function fetchLegacyNullMap(
  projectId: string,
  db: SnapshotDbClient,
): Promise<Map<string, boolean>> {
  try {
    const rows = await (db as PrismaClient).$queryRawUnsafe<Array<{ id: string; legacy_is_null: boolean }>>(
      'SELECT id, "legacy" IS NULL AS legacy_is_null FROM "CapacityProfile" WHERE "projectId" = $1',
      projectId,
    )
    return new Map(rows.map(r => [r.id, r.legacy_is_null]))
  } catch {
    // Mock clients may not support $queryRawUnsafe; return empty map.
    return new Map()
  }
}

/** Build the full project snapshot (schemaVersion 3) with ordered capacity profiles. */
async function buildSnapshot(
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
    legacyNullMap,
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
    fetchLegacyNullMap(projectId, db),
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
      legacy = { kind: 'VALUE', value: p.legacy as Record<string, unknown> | unknown[] | string | number | boolean | null }
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

  return {
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
}

// GET /api/projects/:projectId/snapshots
router.get('/', asyncHandler(async (req: AuthRequest, res: Response) => {
  const projectId = req.params.projectId as string
  const project = await ownedProject(projectId, req.userId!)
  if (!project) { res.status(404).json({ error: 'Project not found' }); return }

  const snapshots = await prisma.backlogSnapshot.findMany({
    where: { projectId },
    orderBy: { createdAt: 'desc' },
    select: { id: true, label: true, trigger: true, createdAt: true, createdById: true },
  })
  res.json(snapshots)
}))

// POST /api/projects/:projectId/snapshots — manual snapshot
router.post('/', asyncHandler(async (req: AuthRequest, res: Response) => {
  const projectId = req.params.projectId as string
  const project = await ownedProject(projectId, req.userId!)
  if (!project) { res.status(404).json({ error: 'Project not found' }); return }

  const { label } = req.body as { label?: string }
  const snapshotData = await buildSnapshot(projectId)
  const snap = await prisma.backlogSnapshot.create({
    data: {
      projectId,
      label: label ?? null,
      trigger: 'manual',
      snapshot: snapshotData as unknown as object,
      createdById: req.userId!,
    },
    select: { id: true, label: true, trigger: true, createdAt: true },
  })
  // #177: enforce retention policy — keep the 20 most-recent snapshots per project
  await pruneSnapshots(prisma, projectId)
  res.status(201).json(snap)
}))

// GET /api/projects/:projectId/snapshots/:snapshotId
router.get('/:snapshotId', asyncHandler(async (req: AuthRequest, res: Response) => {
  const { projectId, snapshotId } = req.params as { projectId: string; snapshotId: string }
  const project = await ownedProject(projectId, req.userId!)
  if (!project) { res.status(404).json({ error: 'Project not found' }); return }

  const snap = await prisma.backlogSnapshot.findFirst({ where: { id: snapshotId, projectId } })
  if (!snap) { res.status(404).json({ error: 'Snapshot not found' }); return }
  res.json(snap)
}))

// GET /api/projects/:projectId/snapshots/:snapshotId/diff
router.get('/:snapshotId/diff', asyncHandler(async (req: AuthRequest, res: Response) => {
  const { projectId, snapshotId } = req.params as { projectId: string; snapshotId: string }
  const project = await ownedProject(projectId, req.userId!)
  if (!project) { res.status(404).json({ error: 'Project not found' }); return }

  const snap = await prisma.backlogSnapshot.findFirst({ where: { id: snapshotId, projectId } })
  if (!snap) { res.status(404).json({ error: 'Snapshot not found' }); return }

  let parsed: SnapshotData
  try {
    parsed = parseSnapshotData(snap.snapshot)
  } catch (e) {
    if (e instanceof SnapshotSchemaError) {
      res.status(400).json({ error: e.message })
      return
    }
    throw e
  }

  const currentSnapshot = await buildSnapshot(projectId)

  // Produce a simple flat diff of epic/feature/story/task names
  const flatten = (epics: SnapshotEpic[]) => {
    const items: string[] = []
    for (const e of epics) {
      items.push(`Epic: ${e.name}`)
      for (const f of e.features) {
        items.push(`  Feature: ${f.name}`)
        for (const s of f.userStories) {
          items.push(`    Story: ${s.name}`)
          for (const t of s.tasks) {
            items.push(`      Task: ${t.name} (${t.hoursEffort}h)`)
          }
        }
      }
    }
    return items
  }

  const snapEpics = isLegacyV1Snapshot(parsed) ? parsed : parsed.epics
  const currentEpics = currentSnapshot.epics
  const snapItems = flatten(snapEpics)
  const currentItems = flatten(currentEpics)
  const snapSet = new Set(snapItems)
  const currentSet = new Set(currentItems)

  res.json({
    added: currentItems.filter(i => !snapSet.has(i)),
    removed: snapItems.filter(i => !currentSet.has(i)),
    snapshotAt: snap.createdAt,
  })
}))

/**
 * Restore the common snapshot state shared across v2 and v3 rollbacks.
 * Handles ResourceTypes, NamedResources, epics, project fields, timeline
 * entries, story timeline entries, dependencies, and overhead items.
 */
async function restoreSnapshotCommonState(
  tx: any,
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
      data: { name: epic.name, description: epic.description, order: epic.order, projectId },
    })
    epicIdMap.set(epic.id, newEpic.id)
    for (const feature of epic.features) {
      const newFeature = await tx.feature.create({
        data: { name: feature.name, description: feature.description, assumptions: feature.assumptions, order: feature.order, epicId: newEpic.id },
      })
      featureIdMap.set(feature.id, newFeature.id)
      for (const story of feature.userStories) {
        const newStory = await tx.userStory.create({
          data: { name: story.name, description: story.description, assumptions: story.assumptions, order: story.order, featureId: newFeature.id, appliedTemplateId: story.appliedTemplateId },
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
        onboardingWeeks: data.project.onboardingWeeks,
        bufferWeeks: data.project.bufferWeeks,
        hoursPerDay: data.project.hoursPerDay,
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

// POST /api/projects/:projectId/snapshots/:snapshotId/rollback
router.post('/:snapshotId/rollback', asyncHandler(async (req: AuthRequest, res: Response) => {
  const { projectId, snapshotId } = req.params as { projectId: string; snapshotId: string }
  const project = await ownedProject(projectId, req.userId!)
  if (!project) { res.status(404).json({ error: 'Project not found' }); return }

  const snap = await prisma.backlogSnapshot.findFirst({ where: { id: snapshotId, projectId } })
  if (!snap) { res.status(404).json({ error: 'Snapshot not found' }); return }

  // Parse snapshot data BEFORE any pre-snapshot or destructive operation
  let parsedData: SnapshotData
  try {
    parsedData = parseSnapshotData(snap.snapshot)
  } catch (e) {
    if (e instanceof SnapshotSchemaError) {
      res.status(400).json({ error: e.message })
      return
    }
    throw e
  }

  // V3: pre-flight validation before any writes
  if (isSnapshotV3(parsedData)) {
    try {
      validateSnapshotV3(parsedData)
    } catch (e) {
      if (e instanceof SnapshotValidationError) {
        res.status(400).json({ error: e.message })
        return
      }
      throw e
    }
    // Cross-project owner ID collision check
    // Collect ALL IDs from snapshot rows, not just profile-owner IDs
    const allRtIds = [
      ...new Set([
        // IDs from snapshot.resourceTypes
        ...parsedData.resourceTypes.map(rt => rt.id),
        // resourceTypeIds from ROLE profiles
        ...parsedData.capacityProfiles
          .filter(p => p.ownerKind === 'ROLE' && p.resourceTypeId)
          .map(p => p.resourceTypeId as string),
        // non-null overheadItems resourceTypeIds
        ...parsedData.overheadItems
          .filter(o => o.resourceTypeId !== null)
          .map(o => o.resourceTypeId as string),
      ]),
    ]
    const allNrIds = [
      ...new Set([
        // IDs from snapshot.namedResources
        ...parsedData.namedResources.map(nr => nr.id),
        // namedResourceIds from NAMED_PERSON / PLANNED_RESOURCE profiles
        ...parsedData.capacityProfiles
          .filter(p =>
            (p.ownerKind === 'NAMED_PERSON' || p.ownerKind === 'PLANNED_RESOURCE') && p.namedResourceId,
          )
          .map(p => p.namedResourceId as string),
      ]),
    ]
    if (allRtIds.length > 0) {
      const existingRTs = await prisma.resourceType.findMany({
        where: { id: { in: allRtIds } },
        select: { id: true, projectId: true },
      })
      const crossProjectRTs = existingRTs.filter(rt => rt.projectId !== projectId)
      if (crossProjectRTs.length > 0) {
        res.status(400).json({
          error: `Resource type IDs ${crossProjectRTs.map(rt => rt.id).join(', ')} belong to another project; rollback rejected`,
        })
        return
      }
    }

    if (allNrIds.length > 0) {
      const existingNRs = await prisma.namedResource.findMany({
        where: { id: { in: allNrIds } },
        select: { id: true, resourceType: { select: { projectId: true } } },
      })
      const crossProjectNRs = existingNRs.filter(nr => nr.resourceType.projectId !== projectId)
      if (crossProjectNRs.length > 0) {
        res.status(400).json({
          error: `Named resource IDs ${crossProjectNRs.map(nr => nr.id).join(', ')} belong to another project; rollback rejected`,
        })
        return
      }
    }
  }

  // All validation passed — one atomic transaction
  const dateStr = new Date().toISOString().slice(0, 10)
  const originalLabel = snap.label ?? snapshotId

  await prisma.$transaction(async tx => {
    // Pre-rollback snapshot inside the transaction
    const preRollbackData = await buildSnapshot(projectId, tx)
    await tx.backlogSnapshot.create({
      data: {
        projectId,
        label: `Auto-saved before rollback to '${originalLabel}' — ${dateStr}`,
        trigger: 'pre_rollback',
        snapshot: preRollbackData as unknown as object,
        createdById: req.userId!,
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
          data: { name: epic.name, description: epic.description, order: epic.order, projectId },
        })
        for (const feature of epic.features) {
          const newFeature = await tx.feature.create({
            data: { name: feature.name, description: feature.description, assumptions: feature.assumptions, order: feature.order, epicId: newEpic.id },
          })
          for (const story of feature.userStories) {
            const newStory = await tx.userStory.create({
              data: { name: story.name, description: story.description, assumptions: story.assumptions, order: story.order, featureId: newFeature.id, appliedTemplateId: story.appliedTemplateId },
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
      await recreateV3CapacityProfiles(tx, projectId, parsedData)
    }

    // Enforce retention policy inside the same transaction
    await pruneSnapshots(tx, projectId)
  })

  res.json({ message: 'Rollback complete' })
}))

export default router

// Export the buildSnapshot helper for use in other routes
export { buildSnapshot }
