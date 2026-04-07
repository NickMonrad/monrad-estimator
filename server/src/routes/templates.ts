import { Router, Response } from 'express'
import { prisma } from '../lib/prisma.js'
import { asyncHandler } from '../lib/asyncHandler.js'
import { authenticate, AuthRequest } from '../middleware/auth.js'
import { parse } from 'csv-parse/sync'
import { stringify } from 'csv-stringify/sync'
import { sanitizeCsvCell } from './csv.js'

const router = Router()

const templateInclude = { tasks: { orderBy: { order: 'asc' as const } } }

interface TplRow {
  TemplateName: string; Category: string; TaskName: string
  ResourceTypeName: string; HoursExtraSmall: string; HoursSmall: string
  HoursMedium: string; HoursLarge: string; HoursExtraLarge: string
}

/** Parse and validate CSV rows, return structured result (no DB writes) */
function parseCsvRows(csvText: string): { rows: TplRow[]; parseError?: string } {
  try {
    const rows = parse(csvText, { columns: true, skip_empty_lines: true, trim: true }) as TplRow[]
    return { rows }
  } catch (e: unknown) {
    return { rows: [], parseError: (e as Error).message }
  }
}

/** Capture current state of a template as a JSON snapshot */
async function captureSnapshot(templateId: string, label: string | null, trigger: string) {
  const template = await prisma.featureTemplate.findUnique({
    where: { id: templateId },
    include: { tasks: { orderBy: { order: 'asc' } } },
  })
  if (!template) return
  await prisma.templateSnapshot.create({
    data: { templateId, label, trigger, snapshot: template as object },
  })
}

// GET /api/templates — auth required
// ?archived=true → only soft-deleted templates; default → only live templates
router.get('/', authenticate, asyncHandler(async (req: AuthRequest, res: Response) => {
  const archived = req.query.archived === 'true'
  const templates = await prisma.featureTemplate.findMany({
    where: { deletedAt: archived ? { not: null } : null },
    orderBy: { name: 'asc' },
    include: templateInclude,
  })
  res.json(templates)
}))

// POST /api/templates — auth required
router.post('/', authenticate, asyncHandler(async (req: AuthRequest, res: Response) => {
  const { name, category, description } = req.body
  if (!name) { res.status(400).json({ error: 'name is required' }); return }
  const existing = await prisma.featureTemplate.findUnique({ where: { name } })
  if (existing) { res.status(409).json({ error: `A template named "${name}" already exists` }); return }
  const template = await prisma.featureTemplate.create({
    data: { name, category, description },
    include: templateInclude,
  })
  res.status(201).json(template)
}))

// GET /api/templates/export-csv — auth required (before /:id to avoid conflict)
router.get('/export-csv', authenticate, asyncHandler(async (_req: AuthRequest, res: Response) => {
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
        rows.push([sanitizeCsvCell(tpl.name), sanitizeCsvCell(tpl.category ?? ''), sanitizeCsvCell(task.name), sanitizeCsvCell(task.resourceTypeName),
          String(task.hoursExtraSmall), String(task.hoursSmall), String(task.hoursMedium),
          String(task.hoursLarge), String(task.hoursExtraLarge)])
      }
      if (tpl.tasks.length === 0) {
        rows.push([sanitizeCsvCell(tpl.name), sanitizeCsvCell(tpl.category ?? ''), '', '', '', '', '', '', ''])
      }
    }
  }

  const csv = stringify(rows)
  res.setHeader('Content-Type', 'text/csv')
  res.setHeader('Content-Disposition', 'attachment; filename="templates.csv"')
  res.send(csv)
}))

// POST /api/templates/import-csv/preview — auth required, returns diff without writing
router.post('/import-csv/preview', authenticate, asyncHandler(async (req: AuthRequest, res: Response) => {
  const csvText: string = req.body.csv
  if (!csvText) { res.status(400).json({ error: 'csv field is required' }); return }

  const { rows, parseError } = parseCsvRows(csvText)
  if (parseError) { res.status(400).json({ error: 'Failed to parse CSV', detail: parseError }); return }

  // Group rows by template name
  const grouped = new Map<string, TplRow[]>()
  const rowErrors: { row: number; message: string }[] = []

  rows.forEach((row, i) => {
    const name = row.TemplateName?.trim()
    if (!name) { rowErrors.push({ row: i + 2, message: 'Missing TemplateName' }); return }
    if (!grouped.has(name)) grouped.set(name, [])
    if (row.TaskName?.trim()) grouped.get(name)!.push(row)
  })

  // Look up existing templates by name (case-insensitive)
  const allExisting = await prisma.featureTemplate.findMany({
    include: { tasks: { orderBy: { order: 'asc' } } },
  })
  const existingByName = new Map(allExisting.map(t => [t.name.toLowerCase(), t]))

  const newTemplates: { name: string; category: string; taskCount: number }[] = []
  const updatedTemplates: {
    id: string; name: string; category: string
    before: { taskCount: number; tasks: { name: string; resourceTypeName: string }[] }
    after: { taskCount: number; tasks: { name: string; resourceTypeName: string }[] }
  }[] = []

  for (const [name, taskRows] of grouped) {
    const existing = existingByName.get(name.toLowerCase())
    const afterTasks = taskRows.map(r => ({ name: r.TaskName.trim(), resourceTypeName: r.ResourceTypeName?.trim() || 'Unassigned' }))
    if (existing) {
      updatedTemplates.push({
        id: existing.id,
        name,
        category: taskRows[0]?.Category?.trim() || existing.category || '',
        before: { taskCount: existing.tasks.length, tasks: existing.tasks.map(t => ({ name: t.name, resourceTypeName: t.resourceTypeName })) },
        after: { taskCount: afterTasks.length, tasks: afterTasks },
      })
    } else {
      newTemplates.push({ name, category: taskRows[0]?.Category?.trim() || '', taskCount: taskRows.length })
    }
  }

  res.json({ newTemplates, updatedTemplates, errors: rowErrors })
}))

// POST /api/templates/import-csv — auth required, commits the import
router.post('/import-csv', authenticate, asyncHandler(async (req: AuthRequest, res: Response) => {
  const csvText: string = req.body.csv
  if (!csvText) { res.status(400).json({ error: 'csv field is required' }); return }

  const { rows, parseError } = parseCsvRows(csvText)
  if (parseError) { res.status(400).json({ error: 'Failed to parse CSV', detail: parseError }); return }

  // Group by template name
  const grouped = new Map<string, TplRow[]>()
  rows.forEach(row => {
    const name = row.TemplateName?.trim()
    if (!name) return
    if (!grouped.has(name)) grouped.set(name, [])
    if (row.TaskName?.trim()) grouped.get(name)!.push(row)
  })

  const allExisting = await prisma.featureTemplate.findMany()
  const existingByName = new Map(allExisting.map(t => [t.name.toLowerCase(), t]))

  let created = 0, updated = 0, tasksCreated = 0

  for (const [name, taskRows] of grouped) {
    const existing = existingByName.get(name.toLowerCase())
    const category = taskRows[0]?.Category?.trim() || null

    if (existing) {
      // Auto-snapshot before overwrite
      await captureSnapshot(existing.id, null, 'csv_import')
      // Replace tasks
      await prisma.templateTask.deleteMany({ where: { templateId: existing.id } })
      for (let i = 0; i < taskRows.length; i++) {
        const row = taskRows[i]
        await prisma.templateTask.create({
          data: {
            name: sanitizeCsvCell(row.TaskName.trim()),
            resourceTypeName: sanitizeCsvCell(row.ResourceTypeName?.trim() || 'Unassigned'),
            hoursExtraSmall: parseFloat(row.HoursExtraSmall) || 0,
            hoursSmall: parseFloat(row.HoursSmall) || 0,
            hoursMedium: parseFloat(row.HoursMedium) || 0,
            hoursLarge: parseFloat(row.HoursLarge) || 0,
            hoursExtraLarge: parseFloat(row.HoursExtraLarge) || 0,
            order: i,
            templateId: existing.id,
          },
        })
        tasksCreated++
      }
      await prisma.featureTemplate.update({ where: { id: existing.id }, data: { category } })
      updated++
    } else {
      const tpl = await prisma.featureTemplate.create({ data: { name, category } })
      for (let i = 0; i < taskRows.length; i++) {
        const row = taskRows[i]
        await prisma.templateTask.create({
          data: {
            name: sanitizeCsvCell(row.TaskName.trim()),
            resourceTypeName: sanitizeCsvCell(row.ResourceTypeName?.trim() || 'Unassigned'),
            hoursExtraSmall: parseFloat(row.HoursExtraSmall) || 0,
            hoursSmall: parseFloat(row.HoursSmall) || 0,
            hoursMedium: parseFloat(row.HoursMedium) || 0,
            hoursLarge: parseFloat(row.HoursLarge) || 0,
            hoursExtraLarge: parseFloat(row.HoursExtraLarge) || 0,
            order: i,
            templateId: tpl.id,
          },
        })
        tasksCreated++
      }
      created++
    }
  }

  res.status(201).json({ message: 'Import successful', templatesCreated: created, templatesUpdated: updated, tasksCreated })
}))

// POST /api/templates/:id/restore — auth required (clears soft delete)
router.post('/:id/restore', authenticate, asyncHandler(async (req: AuthRequest, res: Response) => {
  const template = await prisma.featureTemplate.findUnique({ where: { id: req.params.id as string } })
  if (!template || !template.deletedAt) { res.status(404).json({ error: 'Template not found or not archived' }); return }
  const restored = await prisma.featureTemplate.update({
    where: { id: req.params.id as string },
    data: { deletedAt: null },
    include: templateInclude,
  })
  res.json(restored)
}))

// GET /api/templates/:id/export-csv — auth required (before /:id to avoid conflict)
router.get('/:id/export-csv', authenticate, asyncHandler(async (req: AuthRequest, res: Response) => {
  const template = await prisma.featureTemplate.findUnique({
    where: { id: req.params.id as string },
    include: { tasks: { orderBy: { order: 'asc' } } },
  })
  if (!template) { res.status(404).json({ error: 'Template not found' }); return }

  const headers = ['TemplateName', 'Category', 'TaskName', 'ResourceTypeName', 'HoursExtraSmall', 'HoursSmall', 'HoursMedium', 'HoursLarge', 'HoursExtraLarge']
  const rows: string[][] = [headers]

  if (template.tasks.length === 0) {
    rows.push([template.name, template.category ?? '', '', '', '', '', '', '', ''])
  } else {
    for (const task of template.tasks) {
      rows.push([template.name, template.category ?? '', task.name, task.resourceTypeName,
        String(task.hoursExtraSmall), String(task.hoursSmall), String(task.hoursMedium),
        String(task.hoursLarge), String(task.hoursExtraLarge)])
    }
  }

  const csv = stringify(rows)
  const slug = template.name.toLowerCase().replace(/\s+/g, '-')
  res.setHeader('Content-Type', 'text/csv')
  res.setHeader('Content-Disposition', `attachment; filename="${slug}.csv"`)
  res.send(csv)
}))

// GET /api/templates/:id
router.get('/:id', authenticate, asyncHandler(async (req: AuthRequest, res: Response) => {
  const template = await prisma.featureTemplate.findUnique({
    where: { id: req.params.id as string },
    include: templateInclude,
  })
  if (!template) { res.status(404).json({ error: 'Template not found' }); return }
  res.json(template)
}))

// PUT /api/templates/:id — auth required (auto-snapshots before save)
router.put('/:id', authenticate, asyncHandler(async (req: AuthRequest, res: Response) => {
  const { name, category, description, snapshot: takeSnapshot, snapshotLabel } = req.body
  if (takeSnapshot !== false) {
    await captureSnapshot(req.params.id as string, snapshotLabel ?? null, 'manual_edit')
  }
  const template = await prisma.featureTemplate.update({
    where: { id: req.params.id as string },
    data: { name, category, description },
    include: templateInclude,
  })
  res.json(template)
}))

// DELETE /api/templates/:id — auth required (soft delete)
router.delete('/:id', authenticate, asyncHandler(async (req: AuthRequest, res: Response) => {
  await prisma.featureTemplate.update({ where: { id: req.params.id as string }, data: { deletedAt: new Date() } })
  res.json({ message: 'Archived' })
}))

// POST /api/templates/:id/tasks — auth required
router.post('/:id/tasks', authenticate, asyncHandler(async (req: AuthRequest, res: Response) => {
  const { name, hoursExtraSmall, hoursSmall, hoursMedium, hoursLarge, hoursExtraLarge, resourceTypeName } = req.body
  if (!name || !resourceTypeName) { res.status(400).json({ error: 'name and resourceTypeName are required' }); return }
  const count = await prisma.templateTask.count({ where: { templateId: req.params.id as string } })
  const task = await prisma.templateTask.create({
    data: {
      name, order: count,
      hoursExtraSmall: hoursExtraSmall ?? 0, hoursSmall: hoursSmall ?? 0,
      hoursMedium: hoursMedium ?? 0, hoursLarge: hoursLarge ?? 0,
      hoursExtraLarge: hoursExtraLarge ?? 0, resourceTypeName,
      templateId: req.params.id as string,
    },
  })
  res.status(201).json(task)
}))

// PUT /api/templates/:id/tasks/reorder — auth required
router.put('/:id/tasks/reorder', authenticate, asyncHandler(async (req: AuthRequest, res: Response) => {
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
}))

// PUT /api/templates/:id/tasks/:taskId — auth required
router.put('/:id/tasks/:taskId', authenticate, asyncHandler(async (req: AuthRequest, res: Response) => {
  const { name, hoursExtraSmall, hoursSmall, hoursMedium, hoursLarge, hoursExtraLarge, resourceTypeName } = req.body
  const task = await prisma.templateTask.update({
    where: { id: req.params.taskId as string },
    data: { name, hoursExtraSmall, hoursSmall, hoursMedium, hoursLarge, hoursExtraLarge, resourceTypeName },
  })
  res.json(task)
}))

// DELETE /api/templates/:id/tasks/:taskId — auth required
router.delete('/:id/tasks/:taskId', authenticate, asyncHandler(async (req: AuthRequest, res: Response) => {
  await prisma.templateTask.delete({ where: { id: req.params.taskId as string } })
  res.json({ message: 'Deleted' })
}))

// GET /api/templates/:id/snapshots — auth required
router.get('/:id/snapshots', authenticate, asyncHandler(async (req: AuthRequest, res: Response) => {
  const snapshots = await prisma.templateSnapshot.findMany({
    where: { templateId: req.params.id as string },
    orderBy: { createdAt: 'desc' },
  })
  res.json(snapshots)
}))

// POST /api/templates/:id/snapshots — auth required (manual snapshot)
router.post('/:id/snapshots', authenticate, asyncHandler(async (req: AuthRequest, res: Response) => {
  const { label } = req.body
  await captureSnapshot(req.params.id as string, label ?? null, 'manual')
  const snapshots = await prisma.templateSnapshot.findMany({
    where: { templateId: req.params.id as string },
    orderBy: { createdAt: 'desc' },
  })
  res.status(201).json(snapshots[0])
}))

// POST /api/templates/:id/snapshots/:snapshotId/restore — auth required
router.post('/:id/snapshots/:snapshotId/restore', authenticate, asyncHandler(async (req: AuthRequest, res: Response) => {
  const snap = await prisma.templateSnapshot.findUnique({ where: { id: req.params.snapshotId as string } })
  if (!snap) { res.status(404).json({ error: 'Snapshot not found' }); return }

  // Auto-snapshot current state before restoring
  await captureSnapshot(req.params.id as string, 'Before restore', 'manual_edit')

  const saved = snap.snapshot as { name: string; category: string | null; description: string | null; tasks: { name: string; order: number; hoursExtraSmall: number; hoursSmall: number; hoursMedium: number; hoursLarge: number; hoursExtraLarge: number; resourceTypeName: string }[] }
  await prisma.featureTemplate.update({
    where: { id: req.params.id as string },
    data: { name: saved.name, category: saved.category, description: saved.description },
  })
  await prisma.templateTask.deleteMany({ where: { templateId: req.params.id as string } })
  for (const task of saved.tasks ?? []) {
    await prisma.templateTask.create({
      data: { ...task, id: undefined, templateId: req.params.id as string },
    })
  }

  const template = await prisma.featureTemplate.findUnique({
    where: { id: req.params.id as string },
    include: templateInclude,
  })
  res.json(template)
}))


export default router
