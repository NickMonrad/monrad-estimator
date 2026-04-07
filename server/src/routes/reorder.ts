import { Router, Response } from 'express'
import { prisma } from '../lib/prisma.js'
import { asyncHandler } from '../lib/asyncHandler.js'
import { authenticate, AuthRequest } from '../middleware/auth.js'

const router = Router({ mergeParams: true })
router.use(authenticate)

async function ownedProject(projectId: string, userId: string) {
  return prisma.project.findFirst({ where: { id: projectId, ownerId: userId } })
}

// PATCH /projects/:projectId/reorder/epics
// Body: { items: [{ id, order }] }
router.patch('/epics', asyncHandler(async (req: AuthRequest, res: Response) => {
  const { projectId } = req.params as { projectId: string }
  const project = await ownedProject(projectId, req.userId!)
  if (!project) { res.status(404).json({ error: 'Project not found' }); return }

  const items: { id: string; order: number }[] = req.body.items
  if (!Array.isArray(items)) { res.status(400).json({ error: 'items array required' }); return }

  // #169: verify all epic IDs belong to this project to prevent cross-project IDOR
  const ids = items.map(i => i.id)
  const owned = await prisma.epic.findMany({ where: { id: { in: ids }, projectId: project.id }, select: { id: true } })
  if (owned.length !== ids.length) { res.status(403).json({ error: 'One or more items do not belong to this project' }); return }

  await prisma.$transaction(items.map(({ id, order }) =>
    prisma.epic.update({ where: { id }, data: { order } })
  ))
  res.json({ ok: true })
}))

// PATCH /projects/:projectId/reorder/features
// Body: { items: [{ id, order, epicId }] }
router.patch('/features', asyncHandler(async (req: AuthRequest, res: Response) => {
  const { projectId } = req.params as { projectId: string }
  const project = await ownedProject(projectId, req.userId!)
  if (!project) { res.status(404).json({ error: 'Project not found' }); return }

  const items: { id: string; order: number; epicId: string }[] = req.body.items
  if (!Array.isArray(items)) { res.status(400).json({ error: 'items array required' }); return }

  // #169: verify all feature IDs belong to this project to prevent cross-project IDOR
  const ids = items.map(i => i.id)
  const owned = await prisma.feature.findMany({ where: { id: { in: ids }, epic: { projectId: project.id } }, select: { id: true } })
  if (owned.length !== ids.length) { res.status(403).json({ error: 'One or more items do not belong to this project' }); return }

  await prisma.$transaction(items.map(({ id, order, epicId }) =>
    prisma.feature.update({ where: { id }, data: { order, epicId } })
  ))
  res.json({ ok: true })
}))

// PATCH /projects/:projectId/reorder/stories
// Body: { items: [{ id, order, featureId }] }
router.patch('/stories', asyncHandler(async (req: AuthRequest, res: Response) => {
  const { projectId } = req.params as { projectId: string }
  const project = await ownedProject(projectId, req.userId!)
  if (!project) { res.status(404).json({ error: 'Project not found' }); return }

  const items: { id: string; order: number; featureId: string }[] = req.body.items
  if (!Array.isArray(items)) { res.status(400).json({ error: 'items array required' }); return }

  // #169: verify all story IDs belong to this project to prevent cross-project IDOR
  const ids = items.map(i => i.id)
  const owned = await prisma.userStory.findMany({ where: { id: { in: ids }, feature: { epic: { projectId: project.id } } }, select: { id: true } })
  if (owned.length !== ids.length) { res.status(403).json({ error: 'One or more items do not belong to this project' }); return }

  await prisma.$transaction(items.map(({ id, order, featureId }) =>
    prisma.userStory.update({ where: { id }, data: { order, featureId } })
  ))
  res.json({ ok: true })
}))

// PATCH /projects/:projectId/reorder/tasks
// Body: { items: [{ id, order, storyId }] }
router.patch('/tasks', asyncHandler(async (req: AuthRequest, res: Response) => {
  const { projectId } = req.params as { projectId: string }
  const project = await ownedProject(projectId, req.userId!)
  if (!project) { res.status(404).json({ error: 'Project not found' }); return }

  const items: { id: string; order: number; storyId: string }[] = req.body.items
  if (!Array.isArray(items)) { res.status(400).json({ error: 'items array required' }); return }

  // #169: verify all task IDs belong to this project to prevent cross-project IDOR
  const ids = items.map(i => i.id)
  const owned = await prisma.task.findMany({ where: { id: { in: ids }, userStory: { feature: { epic: { projectId: project.id } } } }, select: { id: true } })
  if (owned.length !== ids.length) { res.status(403).json({ error: 'One or more items do not belong to this project' }); return }

  await prisma.$transaction(items.map(({ id, order, storyId }) =>
    prisma.task.update({ where: { id }, data: { order, userStoryId: storyId } })
  ))
  res.json({ ok: true })
}))

export default router
