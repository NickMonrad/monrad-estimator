import { Router, Response } from 'express'
import { prisma } from '../lib/prisma.js'
import { authenticate, AuthRequest } from '../middleware/auth.js'

const router = Router({ mergeParams: true })
router.use(authenticate)

async function ownedProject(projectId: string, userId: string) {
  return prisma.project.findFirst({ where: { id: projectId, ownerId: userId } })
}

// PATCH /projects/:projectId/reorder/epics
// Body: { items: [{ id, order }] }
router.patch('/epics', async (req: AuthRequest, res: Response) => {
  const { projectId } = req.params as { projectId: string }
  const project = await ownedProject(projectId, req.userId!)
  if (!project) { res.status(404).json({ error: 'Project not found' }); return }

  const items: { id: string; order: number }[] = req.body.items
  if (!Array.isArray(items)) { res.status(400).json({ error: 'items array required' }); return }

  await prisma.$transaction(items.map(({ id, order }) =>
    prisma.epic.update({ where: { id }, data: { order } })
  ))
  res.json({ ok: true })
})

// PATCH /projects/:projectId/reorder/features
// Body: { items: [{ id, order, epicId }] }
router.patch('/features', async (req: AuthRequest, res: Response) => {
  const { projectId } = req.params as { projectId: string }
  const project = await ownedProject(projectId, req.userId!)
  if (!project) { res.status(404).json({ error: 'Project not found' }); return }

  const items: { id: string; order: number; epicId: string }[] = req.body.items
  if (!Array.isArray(items)) { res.status(400).json({ error: 'items array required' }); return }

  await prisma.$transaction(items.map(({ id, order, epicId }) =>
    prisma.feature.update({ where: { id }, data: { order, epicId } })
  ))
  res.json({ ok: true })
})

// PATCH /projects/:projectId/reorder/stories
// Body: { items: [{ id, order, featureId }] }
router.patch('/stories', async (req: AuthRequest, res: Response) => {
  const { projectId } = req.params as { projectId: string }
  const project = await ownedProject(projectId, req.userId!)
  if (!project) { res.status(404).json({ error: 'Project not found' }); return }

  const items: { id: string; order: number; featureId: string }[] = req.body.items
  if (!Array.isArray(items)) { res.status(400).json({ error: 'items array required' }); return }

  await prisma.$transaction(items.map(({ id, order, featureId }) =>
    prisma.userStory.update({ where: { id }, data: { order, featureId } })
  ))
  res.json({ ok: true })
})

// PATCH /projects/:projectId/reorder/tasks
// Body: { items: [{ id, order, storyId }] }
router.patch('/tasks', async (req: AuthRequest, res: Response) => {
  const { projectId } = req.params as { projectId: string }
  const project = await ownedProject(projectId, req.userId!)
  if (!project) { res.status(404).json({ error: 'Project not found' }); return }

  const items: { id: string; order: number; storyId: string }[] = req.body.items
  if (!Array.isArray(items)) { res.status(400).json({ error: 'items array required' }); return }

  await prisma.$transaction(items.map(({ id, order, storyId }) =>
    prisma.task.update({ where: { id }, data: { order, userStoryId: storyId } })
  ))
  res.json({ ok: true })
})

export default router
