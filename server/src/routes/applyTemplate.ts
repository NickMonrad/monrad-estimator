import { Router, Response } from 'express'
import { prisma } from '../lib/prisma.js'
import { authenticate, AuthRequest } from '../middleware/auth.js'

const router = Router()
router.use(authenticate)

type Complexity = 'SMALL' | 'MEDIUM' | 'LARGE' | 'EXTRA_LARGE'

const HOURS_FIELD: Record<Complexity, 'hoursSmall' | 'hoursMedium' | 'hoursLarge' | 'hoursExtraLarge'> = {
  SMALL: 'hoursSmall',
  MEDIUM: 'hoursMedium',
  LARGE: 'hoursLarge',
  EXTRA_LARGE: 'hoursExtraLarge',
}

// POST /api/features/:featureId/apply-template
router.post('/:featureId/apply-template', async (req: AuthRequest, res: Response) => {
  const featureId = req.params.featureId as string
  const { templateId, complexity } = req.body as { templateId: string; complexity: Complexity }

  if (!templateId || !complexity || !HOURS_FIELD[complexity]) {
    res.status(400).json({ error: 'templateId and complexity (SMALL|MEDIUM|LARGE|EXTRA_LARGE) are required' })
    return
  }

  const feature = await prisma.feature.findFirst({
    where: { id: featureId, epic: { project: { ownerId: req.userId! } } },
    include: { epic: { include: { project: true } } },
  })
  if (!feature) { res.status(404).json({ error: 'Feature not found' }); return }

  const template = await prisma.featureTemplate.findUnique({
    where: { id: templateId },
    include: { tasks: true },
  })
  if (!template) { res.status(404).json({ error: 'Template not found' }); return }

  const projectId = feature.epic.projectId
  const resourceTypes = await prisma.resourceType.findMany({ where: { projectId } })

  const hoursField = HOURS_FIELD[complexity]

  const existingStories = await prisma.userStory.findMany({ where: { featureId } })
  const story = await prisma.userStory.create({
    data: {
      name: `${template.name} \u2014 ${complexity}`,
      featureId,
      order: existingStories.length,
    },
  })

  for (let i = 0; i < template.tasks.length; i++) {
    const tmplTask = template.tasks[i]
    const matchedRt = resourceTypes.find(
      rt => rt.name.toLowerCase() === tmplTask.resourceTypeName.toLowerCase()
    ) ?? resourceTypes[0]

    if (!matchedRt) continue

    await prisma.task.create({
      data: {
        name: tmplTask.name,
        hoursEffort: tmplTask[hoursField],
        resourceTypeId: matchedRt.id,
        userStoryId: story.id,
        order: i,
      },
    })
  }

  const result = await prisma.userStory.findUnique({
    where: { id: story.id },
    include: { tasks: { orderBy: { order: 'asc' }, include: { resourceType: true } } },
  })

  res.status(201).json(result)
})

export default router
