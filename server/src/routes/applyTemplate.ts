import { Router, Response } from 'express'
import { prisma } from '../lib/prisma.js'
import { authenticate, AuthRequest } from '../middleware/auth.js'

const router = Router()
router.use(authenticate)

type Complexity = 'EXTRA_SMALL' | 'SMALL' | 'MEDIUM' | 'LARGE' | 'EXTRA_LARGE'

const HOURS_FIELD: Record<Complexity, 'hoursExtraSmall' | 'hoursSmall' | 'hoursMedium' | 'hoursLarge' | 'hoursExtraLarge'> = {
  EXTRA_SMALL: 'hoursExtraSmall',
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
    res.status(400).json({ error: 'templateId and complexity (EXTRA_SMALL|SMALL|MEDIUM|LARGE|EXTRA_LARGE) are required' })
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
  const hoursPerDay = feature.epic.project.hoursPerDay ?? 7.6
  const resourceTypes = await prisma.resourceType.findMany({ where: { projectId } })

  const hoursField = HOURS_FIELD[complexity]

  const existingStories = await prisma.userStory.findMany({ where: { featureId } })
  const story = await prisma.userStory.create({
    data: {
      name: `${template.name} \u2014 ${complexity}`,
      featureId,
      order: existingStories.length,
      appliedTemplateId: templateId,
    },
  })

  for (let i = 0; i < template.tasks.length; i++) {
    const tmplTask = template.tasks[i]
    const matchedRt = resourceTypes.find(
      rt => rt.name.toLowerCase() === tmplTask.resourceTypeName.toLowerCase()
    ) ?? resourceTypes[0]

    if (!matchedRt) continue
    const hoursEffort = tmplTask[hoursField]

    await prisma.task.create({
      data: {
        name: tmplTask.name,
        hoursEffort,
        durationDays: hoursEffort / hoursPerDay,
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

// POST /api/features/:featureId/refresh-template/:storyId
// Additive refresh: adds any template tasks not already present in the story
router.post('/:featureId/refresh-template/:storyId', async (req: AuthRequest, res: Response) => {
  const { featureId, storyId } = req.params as { featureId: string; storyId: string }
  const { complexity } = req.body as { complexity: Complexity }

  if (!complexity || !HOURS_FIELD[complexity]) {
    res.status(400).json({ error: 'complexity (EXTRA_SMALL|SMALL|MEDIUM|LARGE|EXTRA_LARGE) is required' }); return
  }

  const story = await prisma.userStory.findFirst({
    where: { id: storyId, featureId, feature: { epic: { project: { ownerId: req.userId! } } } },
    include: { tasks: true },
  })
  if (!story) { res.status(404).json({ error: 'Story not found' }); return }
  if (!story.appliedTemplateId) { res.status(400).json({ error: 'Story was not created from a template' }); return }

  const template = await prisma.featureTemplate.findUnique({
    where: { id: story.appliedTemplateId },
    include: { tasks: { orderBy: { order: 'asc' } } },
  })
  if (!template) { res.status(404).json({ error: 'Template not found' }); return }

  const feature = await prisma.feature.findUnique({
    where: { id: featureId },
    include: { epic: { include: { project: true } } },
  })
  const projectId = feature!.epic.projectId
  const hoursPerDay = feature!.epic.project.hoursPerDay ?? 7.6
  const resourceTypes = await prisma.resourceType.findMany({ where: { projectId } })
  const hoursField = HOURS_FIELD[complexity]

  const existingTaskNames = new Set(story.tasks.map(t => t.name.toLowerCase()))
  const newTasks = template.tasks.filter(t => !existingTaskNames.has(t.name.toLowerCase()))
  const baseOrder = story.tasks.length

  for (let i = 0; i < newTasks.length; i++) {
    const tmplTask = newTasks[i]
    const matchedRt = resourceTypes.find(
      rt => rt.name.toLowerCase() === tmplTask.resourceTypeName.toLowerCase()
    ) ?? resourceTypes[0]
    if (!matchedRt) continue
    const hoursEffort = tmplTask[hoursField]
    await prisma.task.create({
      data: {
        name: tmplTask.name,
        hoursEffort,
        durationDays: hoursEffort / hoursPerDay,
        resourceTypeId: matchedRt.id,
        userStoryId: storyId,
        order: baseOrder + i,
      },
    })
  }

  const result = await prisma.userStory.findUnique({
    where: { id: storyId },
    include: { tasks: { orderBy: { order: 'asc' }, include: { resourceType: true } } },
  })
  res.json({ added: newTasks.length, story: result })
})

export default router
