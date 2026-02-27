import { Router, Response } from 'express'
import { prisma } from '../lib/prisma.js'
import { authenticate, AuthRequest } from '../middleware/auth.js'

const router = Router({ mergeParams: true })
router.use(authenticate)

// Verify project ownership helper
async function ownedProject(projectId: string, userId: string) {
  return prisma.project.findFirst({ where: { id: projectId, ownerId: userId } })
}

// GET /projects/:projectId/epics
router.get('/', async (req: AuthRequest, res: Response) => {
  const project = await ownedProject(req.params.projectId as string, req.userId!)
  if (!project) { res.status(404).json({ error: 'Project not found' }); return }
  const epics = await prisma.epic.findMany({
    where: { projectId: req.params.projectId as string },
    orderBy: { order: 'asc' },
    include: {
      features: {
        orderBy: { order: 'asc' },
        include: {
          userStories: {
            orderBy: { order: 'asc' },
            include: { tasks: { orderBy: { order: 'asc' }, include: { resourceType: true } } },
          },
        },
      },
    },
  })
  res.json(epics)
})

// POST /projects/:projectId/epics
router.post('/', async (req: AuthRequest, res: Response) => {
  const project = await ownedProject(req.params.projectId as string, req.userId!)
  if (!project) { res.status(404).json({ error: 'Project not found' }); return }
  const { name, description } = req.body
  if (!name) { res.status(400).json({ error: 'name is required' }); return }
  const count = await prisma.epic.findMany({ where: { projectId: req.params.projectId as string } })
  const epic = await prisma.epic.create({
    data: { name, description, projectId: req.params.projectId as string, order: count.length },
  })
  res.status(201).json(epic)
})

// PUT /projects/:projectId/epics/:id
router.put('/:id', async (req: AuthRequest, res: Response) => {
  const project = await ownedProject(req.params.projectId as string, req.userId!)
  if (!project) { res.status(404).json({ error: 'Project not found' }); return }
  const { name, description, order } = req.body
  const epic = await prisma.epic.update({
    where: { id: req.params.id as string },
    data: { name, description, order },
  })
  res.json(epic)
})

// DELETE /projects/:projectId/epics/:id
router.delete('/:id', async (req: AuthRequest, res: Response) => {
  const project = await ownedProject(req.params.projectId as string, req.userId!)
  if (!project) { res.status(404).json({ error: 'Project not found' }); return }
  await prisma.epic.delete({ where: { id: req.params.id as string } })
  res.json({ message: 'Deleted' })
})

export default router
