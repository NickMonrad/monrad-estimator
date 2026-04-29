import { Router, Response } from 'express'
import { prisma } from '../lib/prisma.js'
import { asyncHandler } from '../lib/asyncHandler.js'
import { authenticate, AuthRequest } from '../middleware/auth.js'
import { ownedProject } from '../lib/ownership.js'
import { pruneSnapshots } from '../lib/snapshotUtils.js'

const router = Router({ mergeParams: true })
router.use(authenticate)

// ---------------------------------------------------------------------------
// Snapshot shape (schemaVersion 2)
// Documented trigger values:
//   'manual'           — user-initiated from the UI
//   'csv_import'       — auto-saved before a CSV import
//   'template_apply'   — auto-saved before applying a template
//   'optimiser_apply'  — auto-saved before the optimiser applies a scenario (Phase 2+)
//   'pre_rollback'     — auto-saved before rolling back to a prior snapshot (reversible rollback)
// ---------------------------------------------------------------------------

/** Epic tree shape returned by the backlog query */
type EpicTree = Awaited<ReturnType<typeof fetchEpics>>

async function fetchEpics(projectId: string) {
  return prisma.epic.findMany({
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

/** Build the full project snapshot (schemaVersion 2). */
async function buildSnapshot(projectId: string) {
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
  ] = await Promise.all([
    fetchEpics(projectId),
    prisma.project.findUnique({
      where: { id: projectId },
      select: { startDate: true, onboardingWeeks: true, bufferWeeks: true, hoursPerDay: true },
    }),
    prisma.resourceType.findMany({
      where: { projectId },
      select: {
        id: true,
        name: true,
        category: true,
        count: true,
        hoursPerDay: true,
        dayRate: true,
        globalTypeId: true,
        allocationMode: true,
        allocationPercent: true,
        allocationStartWeek: true,
        allocationEndWeek: true,
      },
    }),
    prisma.namedResource.findMany({
      where: { resourceType: { projectId } },
      select: {
        id: true,
        resourceTypeId: true,
        name: true,
        startWeek: true,
        endWeek: true,
        allocationPct: true,
        allocationMode: true,
        allocationPercent: true,
        allocationStartWeek: true,
        allocationEndWeek: true,
        pricingModel: true,
      },
    }),
    prisma.timelineEntry.findMany({
      where: { projectId },
      select: { featureId: true, startWeek: true, durationWeeks: true, isManual: true },
    }),
    prisma.storyTimelineEntry.findMany({
      where: { projectId },
      select: { storyId: true, startWeek: true, durationWeeks: true, isManual: true },
    }),
    prisma.epicDependency.findMany({
      where: { epic: { projectId } },
      select: { epicId: true, dependsOnId: true },
    }),
    prisma.featureDependency.findMany({
      where: { feature: { epic: { projectId } } },
      select: { featureId: true, dependsOnId: true },
    }),
    prisma.projectOverhead.findMany({
      where: { projectId },
      select: { name: true, type: true, value: true, resourceTypeId: true, order: true },
    }),
  ])

  return {
    schemaVersion: 2 as const,
    epics,
    project: project
      ? {
          startDate: project.startDate,
          onboardingWeeks: project.onboardingWeeks,
          bufferWeeks: project.bufferWeeks,
          hoursPerDay: project.hoursPerDay,
        }
      : null,
    resourceTypes,
    namedResources,
    timelineEntries,
    storyTimelineEntries,
    epicDependencies,
    featureDependencies,
    overheadItems,
  }
}

/** Normalise snapshot data to extract the epics array regardless of schema version. */
function extractEpics(snapshotData: unknown): EpicTree {
  if (Array.isArray(snapshotData)) {
    // Legacy v1 — snapshot is just the epics array
    return snapshotData as EpicTree
  }
  const obj = snapshotData as { schemaVersion?: number; epics?: EpicTree }
  return (obj.epics ?? []) as EpicTree
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
      snapshot: snapshotData as any,
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

  const currentSnapshot = await buildSnapshot(projectId)

  // Produce a simple flat diff of epic/feature/story/task names
  const flatten = (epics: EpicTree) => {
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

  const snapEpics = extractEpics(snap.snapshot)
  const currentEpics = extractEpics(currentSnapshot)
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

// POST /api/projects/:projectId/snapshots/:snapshotId/rollback
router.post('/:snapshotId/rollback', asyncHandler(async (req: AuthRequest, res: Response) => {
  const { projectId, snapshotId } = req.params as { projectId: string; snapshotId: string }
  const project = await ownedProject(projectId, req.userId!)
  if (!project) { res.status(404).json({ error: 'Project not found' }); return }

  const snap = await prisma.backlogSnapshot.findFirst({ where: { id: snapshotId, projectId } })
  if (!snap) { res.status(404).json({ error: 'Snapshot not found' }); return }

  // Auto-snapshot current state BEFORE rollback so it can itself be rolled back ('pre_rollback').
  const preRollbackData = await buildSnapshot(projectId)
  const dateStr = new Date().toISOString().slice(0, 10)
  const originalLabel = snap.label ?? snapshotId
  const preSnap = await prisma.backlogSnapshot.create({
    data: {
      projectId,
      label: `Auto-saved before rollback to '${originalLabel}' — ${dateStr}`,
      trigger: 'pre_rollback',
      snapshot: preRollbackData as unknown as object,
      createdById: req.userId!,
    },
  })
  await pruneSnapshots(prisma, projectId)

  // Determine snapshot version
  const snapshotData = snap.snapshot as unknown
  const isLegacy =
    Array.isArray(snapshotData) ||
    (typeof snapshotData === 'object' &&
      snapshotData !== null &&
      !('schemaVersion' in snapshotData))

  try {
  if (isLegacy) {
    // --- Legacy v1: restore epics only (original behaviour) ---
    const epics = extractEpics(snapshotData)
    const resourceTypes = await prisma.resourceType.findMany({
      where: { projectId },
      select: { id: true, name: true },
    })
    const rtMap = new Map(resourceTypes.map(rt => [rt.name.toLowerCase(), rt.id]))

    await prisma.$transaction(async tx => {
      await tx.epic.deleteMany({ where: { projectId } })
      for (const epic of epics) {
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
              const resourceTypeId = task.resourceType?.name
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
                  resourceTypeId,
                },
              })
            }
          }
        }
      }
    })
  } else {
    // --- v2: full-state restore in a single transaction ---
    type V2Snapshot = Awaited<ReturnType<typeof buildSnapshot>>
    const v2 = snapshotData as V2Snapshot

    await prisma.$transaction(async tx => {
      // 1. Restore ResourceTypes FIRST so task FKs resolve correctly when recreating epics
      const rtNameMap = new Map<string, string>()
      for (const rt of v2.resourceTypes) {
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
      for (const nr of v2.namedResources) {
        await tx.namedResource.upsert({
          where: { id: nr.id },
          update: {
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
      //    We track old→new ID mapping so downstream FK restores use new IDs.
      await tx.epic.deleteMany({ where: { projectId } })

      // Build old→new ID maps as we recreate the tree
      const epicIdMap = new Map<string, string>()
      const featureIdMap = new Map<string, string>()
      const storyIdMap = new Map<string, string>()

      for (const epic of v2.epics) {
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
      if (v2.project) {
        await tx.project.update({
          where: { id: projectId },
          data: {
            startDate: v2.project.startDate,
            onboardingWeeks: v2.project.onboardingWeeks,
            bufferWeeks: v2.project.bufferWeeks,
            hoursPerDay: v2.project.hoursPerDay,
          },
        })
      }

      // 5. Restore TimelineEntries — delete then recreate using new feature IDs
      await tx.timelineEntry.deleteMany({ where: { projectId } })
      if (v2.timelineEntries.length > 0) {
        const mappedTLEs = v2.timelineEntries
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

      // 6. Restore StoryTimelineEntries — delete then recreate using new story IDs
      await tx.storyTimelineEntry.deleteMany({ where: { projectId } })
      if (v2.storyTimelineEntries.length > 0) {
        const mappedSTLEs = v2.storyTimelineEntries
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

      // 7. Restore EpicDependencies using new epic IDs
      await tx.epicDependency.deleteMany({ where: { epic: { projectId } } })
      if (v2.epicDependencies.length > 0) {
        const mappedEDs = v2.epicDependencies
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

      // 8. Restore FeatureDependencies using new feature IDs
      await tx.featureDependency.deleteMany({ where: { feature: { epic: { projectId } } } })
      if (v2.featureDependencies.length > 0) {
        const mappedFDs = v2.featureDependencies
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

      // 9. Restore OverheadItems — delete all then recreate
      await tx.projectOverhead.deleteMany({ where: { projectId } })
      if (v2.overheadItems.length > 0) {
        await tx.projectOverhead.createMany({
          data: v2.overheadItems.map(o => ({
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
    })
  }
  } catch (err) {
    await prisma.backlogSnapshot.delete({ where: { id: preSnap.id } }).catch(() => {})
    throw err
  }

  res.json({ message: 'Rollback complete' })
}))

export default router

// Export the buildSnapshot helper for use in other routes
export { buildSnapshot }
