import { Router, Response } from 'express'
import { prisma } from '../lib/prisma.js'
import { authenticate, AuthRequest } from '../middleware/auth.js'

const router = Router({ mergeParams: true })
router.use(authenticate)

// Build the full backlog JSON for a project
async function buildSnapshot(projectId: string) {
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

// Helper to verify project ownership
async function getProject(projectId: string, userId: string) {
  return prisma.project.findFirst({ where: { id: projectId, ownerId: userId } })
}

// GET /api/projects/:projectId/snapshots
router.get('/', async (req: AuthRequest, res: Response) => {
  const projectId = req.params.projectId as string
  const project = await getProject(projectId, req.userId!)
  if (!project) { res.status(404).json({ error: 'Project not found' }); return }

  const snapshots = await prisma.backlogSnapshot.findMany({
    where: { projectId },
    orderBy: { createdAt: 'desc' },
    select: { id: true, label: true, trigger: true, createdAt: true, createdById: true },
  })
  res.json(snapshots)
})

// POST /api/projects/:projectId/snapshots — manual snapshot
router.post('/', async (req: AuthRequest, res: Response) => {
  const projectId = req.params.projectId as string
  const project = await getProject(projectId, req.userId!)
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
  res.status(201).json(snap)
})

// GET /api/projects/:projectId/snapshots/:snapshotId
router.get('/:snapshotId', async (req: AuthRequest, res: Response) => {
  const { projectId, snapshotId } = req.params as { projectId: string; snapshotId: string }
  const project = await getProject(projectId, req.userId!)
  if (!project) { res.status(404).json({ error: 'Project not found' }); return }

  const snap = await prisma.backlogSnapshot.findFirst({ where: { id: snapshotId, projectId } })
  if (!snap) { res.status(404).json({ error: 'Snapshot not found' }); return }
  res.json(snap)
})

// GET /api/projects/:projectId/snapshots/:snapshotId/diff
router.get('/:snapshotId/diff', async (req: AuthRequest, res: Response) => {
  const { projectId, snapshotId } = req.params as { projectId: string; snapshotId: string }
  const project = await getProject(projectId, req.userId!)
  if (!project) { res.status(404).json({ error: 'Project not found' }); return }

  const snap = await prisma.backlogSnapshot.findFirst({ where: { id: snapshotId, projectId } })
  if (!snap) { res.status(404).json({ error: 'Snapshot not found' }); return }

  const current = await buildSnapshot(projectId)

  // Produce a simple flat diff of epic/feature/story/task names
  const flatten = (epics: typeof current) => {
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

  const snapItems = flatten(snap.snapshot as unknown as typeof current)
  const currentItems = flatten(current)
  const snapSet = new Set(snapItems)
  const currentSet = new Set(currentItems)

  res.json({
    added: currentItems.filter(i => !snapSet.has(i)),
    removed: snapItems.filter(i => !currentSet.has(i)),
    snapshotAt: snap.createdAt,
  })
})

// POST /api/projects/:projectId/snapshots/:snapshotId/rollback
router.post('/:snapshotId/rollback', async (req: AuthRequest, res: Response) => {
  const { projectId, snapshotId } = req.params as { projectId: string; snapshotId: string }
  const project = await getProject(projectId, req.userId!)
  if (!project) { res.status(404).json({ error: 'Project not found' }); return }

  const snap = await prisma.backlogSnapshot.findFirst({ where: { id: snapshotId, projectId } })
  if (!snap) { res.status(404).json({ error: 'Snapshot not found' }); return }

  // Auto-snapshot current state before rollback
  const currentData = await buildSnapshot(projectId)
  await prisma.backlogSnapshot.create({
    data: {
      projectId,
      label: 'Pre-rollback auto-snapshot',
      trigger: 'rollback',
      snapshot: currentData as any,
      createdById: req.userId!,
    },
  })

  // Delete current backlog (cascades to features/stories/tasks)
  await prisma.epic.deleteMany({ where: { projectId } })

  // Recreate from snapshot
  const epics = snap.snapshot as unknown as typeof currentData
  for (const epic of epics) {
    const newEpic = await prisma.epic.create({
      data: { name: epic.name, description: epic.description, order: epic.order, projectId },
    })
    for (const feature of epic.features) {
      const newFeature = await prisma.feature.create({
        data: { name: feature.name, description: feature.description, assumptions: feature.assumptions, order: feature.order, epicId: newEpic.id },
      })
      for (const story of feature.userStories) {
        const newStory = await prisma.userStory.create({
          data: { name: story.name, description: story.description, assumptions: story.assumptions, order: story.order, featureId: newFeature.id, appliedTemplateId: story.appliedTemplateId },
        })
        for (const task of story.tasks) {
          // Re-match resource type by name in the project
          const rt = await prisma.resourceType.findFirst({
            where: { projectId, name: task.resourceType?.name },
          })
          if (!rt) continue
          await prisma.task.create({
            data: { name: task.name, description: task.description, assumptions: task.assumptions, hoursEffort: task.hoursEffort, durationDays: task.durationDays, order: task.order, userStoryId: newStory.id, resourceTypeId: rt.id },
          })
        }
      }
    }
  }

  res.json({ message: 'Rollback complete' })
})

export default router

// Export the buildSnapshot helper for use in other routes
export { buildSnapshot }
