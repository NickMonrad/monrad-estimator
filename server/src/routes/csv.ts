import { Router, Response, Request } from 'express'
import { prisma } from '../lib/prisma.js'
import { authenticate, AuthRequest } from '../middleware/auth.js'
import { parse } from 'csv-parse/sync'
import { stringify } from 'csv-stringify/sync'

const router = Router({ mergeParams: true })
router.use(authenticate)

const CSV_HEADERS = [
  'Epic', 'Feature', 'Story', 'Task',
  'ResourceType',
  'HoursExtraSmall', 'HoursSmall', 'HoursMedium', 'HoursLarge', 'HoursExtraLarge',
  'HoursEffort', 'DurationDays',
  'Description', 'Assumptions',
]

interface CsvRow {
  Epic: string
  Feature: string
  Story: string
  Task: string
  ResourceType: string
  HoursExtraSmall: string
  HoursSmall: string
  HoursMedium: string
  HoursLarge: string
  HoursExtraLarge: string
  HoursEffort: string
  DurationDays: string
  Description: string
  Assumptions: string
}

export interface StagedRow {
  rowIndex: number
  epic: string
  feature: string
  story: string
  task: string
  resourceType: string
  hoursSmall: number
  hoursMedium: number
  hoursLarge: number
  hoursExtraLarge: number
  hoursEffort: number
  durationDays: number
  description: string
  assumptions: string
  errors: string[]
  warnings: string[]
}

async function ownedProject(projectId: string, userId: string) {
  return prisma.project.findFirst({ where: { id: projectId, ownerId: userId } })
}

function parseNum(val: string): number {
  const n = parseFloat(val)
  return isNaN(n) ? 0 : n
}

// GET /api/projects/:projectId/backlog/export-csv
router.get('/export-csv', async (req: AuthRequest, res: Response) => {
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
            include: {
              tasks: { orderBy: { order: 'asc' }, include: { resourceType: true } },
            },
          },
        },
      },
    },
  })

  const rows: string[][] = [CSV_HEADERS]

  if (epics.length === 0) {
    // blank template with one example row
    rows.push(['My Epic', 'My Feature', 'My Story', 'My Task', 'Developer', '1', '2', '4', '8', '16', '', '', '', ''])
  } else {
    for (const epic of epics) {
      for (const feature of epic.features) {
        for (const story of feature.userStories) {
          for (const task of story.tasks) {
            rows.push([
              epic.name,
              feature.name,
              story.name,
              task.name,
              task.resourceType?.name ?? '',
              '', // HoursExtraSmall (template field, not applicable to exported tasks)
              '', // HoursSmall
              '', // HoursMedium
              '', // HoursLarge
              '', // HoursExtraLarge
              String(task.hoursEffort),
              String(task.durationDays ?? ''),
              task.description ?? '',
              task.assumptions ?? '',
            ])
          }
          if (story.tasks.length === 0) {
            rows.push([epic.name, feature.name, story.name, '', '', '', '', '', '', '', '', '', story.description ?? '', story.assumptions ?? ''])
          }
        }
      }
    }
  }

  const csv = stringify(rows)
  res.setHeader('Content-Type', 'text/csv')
  res.setHeader('Content-Disposition', `attachment; filename="backlog-${req.params.projectId}.csv"`)
  res.send(csv)
})

// POST /api/projects/:projectId/backlog/stage-csv
// Body: multipart not needed — accepts raw CSV text as body { csv: string }
router.post('/stage-csv', async (req: AuthRequest, res: Response) => {
  const project = await ownedProject(req.params.projectId as string, req.userId!)
  if (!project) { res.status(404).json({ error: 'Project not found' }); return }

  const csvText: string = req.body.csv
  if (!csvText) { res.status(400).json({ error: 'csv field is required' }); return }

  let rawRows: CsvRow[]
  try {
    rawRows = parse(csvText, { columns: true, skip_empty_lines: true, trim: true }) as CsvRow[]
  } catch (e: unknown) {
    res.status(400).json({ error: 'Failed to parse CSV', detail: (e as Error).message }); return
  }

  // Fetch project resource types for validation
  const resourceTypes = await prisma.resourceType.findMany({
    where: { projectId: req.params.projectId as string },
  })
  const rtNames = new Set(resourceTypes.map(r => r.name.toLowerCase()))

  // Carry-forward context (Excel-style empty cell inheritance)
  let lastEpic = '', lastFeature = '', lastStory = ''

  const staged: StagedRow[] = rawRows.map((raw, i) => {
    const epic = raw.Epic?.trim() || lastEpic
    const feature = raw.Feature?.trim() || lastFeature
    const story = raw.Story?.trim() || lastStory
    const task = raw.Task?.trim() ?? ''
    const resourceType = raw.ResourceType?.trim() ?? ''

    if (raw.Epic?.trim()) lastEpic = raw.Epic.trim()
    if (raw.Feature?.trim()) lastFeature = raw.Feature.trim()
    if (raw.Story?.trim()) lastStory = raw.Story.trim()

    const errors: string[] = []
    const warnings: string[] = []

    if (!epic) errors.push('Epic is required')
    if (!feature) errors.push('Feature is required')
    if (!story) errors.push('Story is required')
    if (!task) errors.push('Task name is required')

    if (resourceType && !rtNames.has(resourceType.toLowerCase())) {
      warnings.push(`Resource type "${resourceType}" not found in project — will be left blank on import`)
    }

    return {
      rowIndex: i + 2, // 1-indexed + header
      epic,
      feature,
      story,
      task,
      resourceType,
      hoursExtraSmall: parseNum(raw.HoursExtraSmall),
      hoursSmall: parseNum(raw.HoursSmall),
      hoursMedium: parseNum(raw.HoursMedium),
      hoursLarge: parseNum(raw.HoursLarge),
      hoursExtraLarge: parseNum(raw.HoursExtraLarge),
      hoursEffort: parseNum(raw.HoursEffort),
      durationDays: parseNum(raw.DurationDays),
      description: raw.Description?.trim() ?? '',
      assumptions: raw.Assumptions?.trim() ?? '',
      errors,
      warnings,
    }
  })

  const errorCount = staged.filter(r => r.errors.length > 0).length
  const warningCount = staged.filter(r => r.warnings.length > 0).length

  res.json({ staged, summary: { total: staged.length, errorCount, warningCount } })
})

// POST /api/projects/:projectId/backlog/import-csv
// Body: { rows: StagedRow[] }
router.post('/import-csv', async (req: AuthRequest, res: Response) => {
  const projectId = req.params.projectId as string
  const project = await ownedProject(projectId, req.userId!)
  if (!project) { res.status(404).json({ error: 'Project not found' }); return }

  const rows: StagedRow[] = req.body.rows
  if (!Array.isArray(rows) || rows.length === 0) {
    res.status(400).json({ error: 'rows array is required' }); return
  }

  // Validate no error rows
  const errorRows = rows.filter(r => r.errors && r.errors.length > 0)
  if (errorRows.length > 0) {
    res.status(400).json({ error: 'Cannot import rows with validation errors', count: errorRows.length }); return
  }

  // Fetch resource types for matching
  const resourceTypes = await prisma.resourceType.findMany({ where: { projectId } })
  const rtByName = new Map(resourceTypes.map(r => [r.name.toLowerCase(), r.id]))

  // Auto-snapshot before import
  const existingEpics = await prisma.epic.findMany({
    where: { projectId },
    include: { features: { include: { userStories: { include: { tasks: { include: { resourceType: true } } } } } } },
  })
  if (existingEpics.length > 0) {
    await prisma.backlogSnapshot.create({
      data: {
        projectId,
        label: 'Auto-snapshot before CSV import',
        trigger: 'csv-import',
        snapshot: existingEpics as unknown as object,
        createdById: req.userId!,
      },
    })
  }

  // Build hierarchy maps to group rows
  const epicMap = new Map<string, string>() // epic name → epic id
  const featureMap = new Map<string, string>() // "epic||feature" → feature id
  const storyMap = new Map<string, string>() // "epic||feature||story" → story id

  // Count for ordering
  const epicCount = await prisma.epic.count({ where: { projectId } })
  let epicOrder = epicCount

  for (const row of rows) {
    const epicKey = row.epic
    const featureKey = `${row.epic}||${row.feature}`
    const storyKey = `${row.epic}||${row.feature}||${row.story}`

    // Get or create Epic
    if (!epicMap.has(epicKey)) {
      const epic = await prisma.epic.create({
        data: { name: row.epic, projectId, order: epicOrder++ },
      })
      epicMap.set(epicKey, epic.id)
    }
    const epicId = epicMap.get(epicKey)!

    // Get or create Feature
    if (!featureMap.has(featureKey)) {
      const featCount = await prisma.feature.count({ where: { epicId } })
      const feature = await prisma.feature.create({
        data: { name: row.feature, epicId, order: featCount },
      })
      featureMap.set(featureKey, feature.id)
    }
    const featureId = featureMap.get(featureKey)!

    // Get or create Story
    if (!storyMap.has(storyKey)) {
      const storyCount = await prisma.userStory.count({ where: { featureId } })
      const story = await prisma.userStory.create({
        data: {
          name: row.story,
          featureId,
          order: storyCount,
          description: row.description || null,
          assumptions: row.assumptions || null,
        },
      })
      storyMap.set(storyKey, story.id)
    }
    const storyId = storyMap.get(storyKey)!

    if (!row.task) continue

    // Create Task
    const resourceTypeId = row.resourceType
      ? (rtByName.get(row.resourceType.toLowerCase()) ?? null)
      : null

    const taskCount = await prisma.task.count({ where: { userStoryId: storyId } })
    await prisma.task.create({
      data: {
        name: row.task,
        userStoryId: storyId,
        order: taskCount,
        resourceTypeId,
        hoursEffort: row.hoursEffort,
        durationDays: row.durationDays || null,
        description: row.description || null,
        assumptions: row.assumptions || null,
      },
    })
  }

  res.json({
    message: 'Import successful',
    epicsCreated: epicMap.size,
    featuresCreated: featureMap.size,
    storiesCreated: storyMap.size,
    tasksCreated: rows.filter(r => r.task).length,
  })
})

export default router
