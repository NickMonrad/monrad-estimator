import { Router, Response } from 'express'
import { prisma } from '../lib/prisma.js'
import { authenticate, AuthRequest } from '../middleware/auth.js'
import { parse } from 'csv-parse/sync'
import { stringify } from 'csv-stringify/sync'

const router = Router()

const templateInclude = { tasks: { orderBy: { order: 'asc' as const } } }

// GET /api/templates — no auth required
router.get('/', async (_req, res: Response) => {
  const templates = await prisma.featureTemplate.findMany({
    orderBy: { name: 'asc' },
    include: templateInclude,
  })
  res.json(templates)
})

// POST /api/templates — auth required
router.post('/', authenticate, async (req: AuthRequest, res: Response) => {
  const { name, category, description } = req.body
  if (!name) { res.status(400).json({ error: 'name is required' }); return }
  const template = await prisma.featureTemplate.create({
    data: { name, category, description },
    include: templateInclude,
  })
  res.status(201).json(template)
})

// GET /api/templates/:id
router.get('/:id', async (req, res: Response) => {
  const template = await prisma.featureTemplate.findUnique({
    where: { id: req.params.id as string },
    include: templateInclude,
  })
  if (!template) { res.status(404).json({ error: 'Template not found' }); return }
  res.json(template)
})

// PUT /api/templates/:id — auth required
router.put('/:id', authenticate, async (req: AuthRequest, res: Response) => {
  const { name, category, description } = req.body
  const template = await prisma.featureTemplate.update({
    where: { id: req.params.id as string },
    data: { name, category, description },
    include: templateInclude,
  })
  res.json(template)
})

// DELETE /api/templates/:id — auth required
router.delete('/:id', authenticate, async (req: AuthRequest, res: Response) => {
  await prisma.featureTemplate.delete({ where: { id: req.params.id as string } })
  res.json({ message: 'Deleted' })
})

// POST /api/templates/:id/tasks — auth required
router.post('/:id/tasks', authenticate, async (req: AuthRequest, res: Response) => {
  const { name, hoursExtraSmall, hoursSmall, hoursMedium, hoursLarge, hoursExtraLarge, resourceTypeName } = req.body
  if (!name || !resourceTypeName) { res.status(400).json({ error: 'name and resourceTypeName are required' }); return }
  const count = await prisma.templateTask.count({ where: { templateId: req.params.id as string } })
  const task = await prisma.templateTask.create({
    data: {
      name,
      order: count,
      hoursExtraSmall: hoursExtraSmall ?? 0,
      hoursSmall: hoursSmall ?? 0,
      hoursMedium: hoursMedium ?? 0,
      hoursLarge: hoursLarge ?? 0,
      hoursExtraLarge: hoursExtraLarge ?? 0,
      resourceTypeName,
      templateId: req.params.id as string,
    },
  })
  res.status(201).json(task)
})

// PUT /api/templates/:id/tasks/reorder — auth required
router.put('/:id/tasks/reorder', authenticate, async (req: AuthRequest, res: Response) => {
  const items = req.body as { id: string; order: number }[]
  if (!Array.isArray(items)) { res.status(400).json({ error: 'Expected array of { id, order }' }); return }
  await Promise.all(items.map(({ id, order }) =>
    prisma.templateTask.update({ where: { id }, data: { order } })
  ))
  const template = await prisma.featureTemplate.findUnique({
    where: { id: req.params.id as string },
    include: templateInclude,
  })
  res.json(template)
})

// PUT /api/templates/:id/tasks/:taskId — auth required
router.put('/:id/tasks/:taskId', authenticate, async (req: AuthRequest, res: Response) => {
  const { name, hoursExtraSmall, hoursSmall, hoursMedium, hoursLarge, hoursExtraLarge, resourceTypeName } = req.body
  const task = await prisma.templateTask.update({
    where: { id: req.params.taskId as string },
    data: { name, hoursExtraSmall, hoursSmall, hoursMedium, hoursLarge, hoursExtraLarge, resourceTypeName },
  })
  res.json(task)
})

// DELETE /api/templates/:id/tasks/:taskId — auth required
router.delete('/:id/tasks/:taskId', authenticate, async (req: AuthRequest, res: Response) => {
  await prisma.templateTask.delete({ where: { id: req.params.taskId as string } })
  res.json({ message: 'Deleted' })
})

export default router

// GET /api/templates/export-csv — no auth required
router.get('/export-csv', async (_req, res: Response) => {
  const templates = await prisma.featureTemplate.findMany({
    orderBy: { name: 'asc' },
    include: { tasks: { orderBy: { order: 'asc' } } },
  })

  const headers = ['TemplateName', 'Category', 'TaskName', 'ResourceTypeName', 'HoursExtraSmall', 'HoursSmall', 'HoursMedium', 'HoursLarge', 'HoursExtraLarge']
  const rows: string[][] = [headers]

  if (templates.length === 0) {
    rows.push(['My Template', 'Engineering', 'My Task', 'Developer', '1', '2', '4', '8', '16'])
  } else {
    for (const tpl of templates) {
      for (const task of tpl.tasks) {
        rows.push([
          tpl.name,
          tpl.category ?? '',
          task.name,
          task.resourceTypeName,
          String(task.hoursExtraSmall),
          String(task.hoursSmall),
          String(task.hoursMedium),
          String(task.hoursLarge),
          String(task.hoursExtraLarge),
        ])
      }
      if (tpl.tasks.length === 0) {
        rows.push([tpl.name, tpl.category ?? '', '', '', '', '', '', '', ''])
      }
    }
  }

  const csv = stringify(rows)
  res.setHeader('Content-Type', 'text/csv')
  res.setHeader('Content-Disposition', 'attachment; filename="templates.csv"')
  res.send(csv)
})

// POST /api/templates/import-csv — auth required
router.post('/import-csv', authenticate, async (req: AuthRequest, res: Response) => {
  const csvText: string = req.body.csv
  if (!csvText) { res.status(400).json({ error: 'csv field is required' }); return }

  interface TplRow { TemplateName: string; Category: string; TaskName: string; ResourceTypeName: string; HoursExtraSmall: string; HoursSmall: string; HoursMedium: string; HoursLarge: string; HoursExtraLarge: string }
  let rows: TplRow[]
  try {
    rows = parse(csvText, { columns: true, skip_empty_lines: true, trim: true }) as TplRow[]
  } catch (e: unknown) {
    res.status(400).json({ error: 'Failed to parse CSV', detail: (e as Error).message }); return
  }

  const tplMap = new Map<string, string>() // name → id
  let created = 0, tasksCreated = 0

  for (const row of rows) {
    const name = row.TemplateName?.trim()
    if (!name) continue

    if (!tplMap.has(name)) {
      const tpl = await prisma.featureTemplate.create({
        data: { name, category: row.Category?.trim() || null },
      })
      tplMap.set(name, tpl.id)
      created++
    }
    const templateId = tplMap.get(name)!

    if (!row.TaskName?.trim()) continue
    const count = await prisma.templateTask.count({ where: { templateId } })
    await prisma.templateTask.create({
      data: {
        name: row.TaskName.trim(),
        resourceTypeName: row.ResourceTypeName?.trim() || 'Unassigned',
        hoursExtraSmall: parseFloat(row.HoursExtraSmall) || 0,
        hoursSmall: parseFloat(row.HoursSmall) || 0,
        hoursMedium: parseFloat(row.HoursMedium) || 0,
        hoursLarge: parseFloat(row.HoursLarge) || 0,
        hoursExtraLarge: parseFloat(row.HoursExtraLarge) || 0,
        order: count,
        templateId,
      },
    })
    tasksCreated++
  }

  res.status(201).json({ message: 'Import successful', templatesCreated: created, tasksCreated })
})
