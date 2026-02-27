import { Router, Response } from 'express'
import { prisma } from '../lib/prisma.js'
import { authenticate, AuthRequest } from '../middleware/auth.js'

const router = Router({ mergeParams: true })
router.use(authenticate)

async function ownedProject(projectId: string, userId: string) {
  return prisma.project.findFirst({ where: { id: projectId, ownerId: userId } })
}

// GET /projects/:projectId/resource-types
router.get('/', async (req: AuthRequest, res: Response) => {
  const project = await ownedProject(req.params.projectId as string, req.userId!)
  if (!project) { res.status(404).json({ error: 'Project not found' }); return }
  const types = await prisma.resourceType.findMany({
    where: { projectId: req.params.projectId as string },
    orderBy: { name: 'asc' },
  })
  res.json(types)
})

// POST /projects/:projectId/resource-types
router.post('/', async (req: AuthRequest, res: Response) => {
  const project = await ownedProject(req.params.projectId as string, req.userId!)
  if (!project) { res.status(404).json({ error: 'Project not found' }); return }
  const { name, category } = req.body
  if (!name || !category) { res.status(400).json({ error: 'name and category are required' }); return }
  const rt = await prisma.resourceType.create({
    data: { name, category, projectId: req.params.projectId as string },
  })
  res.status(201).json(rt)
})

// PUT /projects/:projectId/resource-types/:id
router.put('/:id', async (req: AuthRequest, res: Response) => {
  const project = await ownedProject(req.params.projectId as string, req.userId!)
  if (!project) { res.status(404).json({ error: 'Project not found' }); return }
  const { name, category } = req.body
  const rt = await prisma.resourceType.update({
    where: { id: req.params.id as string },
    data: { name, category },
  })
  res.json(rt)
})

// DELETE /projects/:projectId/resource-types/:id
router.delete('/:id', async (req: AuthRequest, res: Response) => {
  const project = await ownedProject(req.params.projectId as string, req.userId!)
  if (!project) { res.status(404).json({ error: 'Project not found' }); return }
  await prisma.resourceType.delete({ where: { id: req.params.id as string } })
  res.json({ message: 'Deleted' })
})

export default router
