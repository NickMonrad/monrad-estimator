import { Router, Response } from 'express'
import { prisma } from '../lib/prisma.js'
import { authenticate, AuthRequest } from '../middleware/auth.js'
import { parse } from 'csv-parse/sync'
import { stringify } from 'csv-stringify/sync'
import { calcDurationDays } from '../utils/round.js'

const router = Router({ mergeParams: true })
router.use(authenticate)

const CSV_HEADERS = [
  'Type', 'Epic', 'Feature', 'Story', 'Task',
  'Template',
  'ResourceType',
  'HoursEffort', 'DurationDays',
  'Description', 'Assumptions',
  'EpicStatus', 'FeatureStatus', 'StoryStatus',
]

interface CsvRow {
  Type: string
  Epic: string
  Feature: string
  Story: string
  Task: string
  EpicStatus: string
  FeatureStatus: string
  StoryStatus: string
  Template: string
  ResourceType: string
  // legacy fields — kept for backwards compat (old CSVs may still have these)
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
  type: 'Epic' | 'Feature' | 'Story' | 'Task'
  epic: string
  feature: string
  story: string
  task: string
  epicStatus: boolean
  featureStatus: boolean
  storyStatus: boolean
  template: string
  resourceType: string
  // legacy fields kept for backwards compat
  hoursExtraSmall: number
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
  return prisma.project.findFirst({ where: { id: projectId, ownerId: userId }, include: { customer: { select: { name: true } } } })
}

function parseNum(val: string | undefined): number {
  const n = parseFloat(val ?? '')
  return isNaN(n) ? 0 : n
}

function parseStatus(val: string | undefined): boolean {
  return (val?.trim().toLowerCase() === 'inactive') ? false : true
}

/** Prevent CSV formula injection by prefixing dangerous characters with a single quote */
export function sanitizeCsvCell(value: string): string {
  if (/^[=+\-@\t\r]/.test(value)) {
    return `'${value}`
  }
  return value
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
              appliedTemplate: true,
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
    rows.push(['Task', 'My Epic', 'My Feature', 'My Story', 'My Task', '', 'Developer', '', '', '', '', '', '', ''])
  } else {
    for (const epic of epics) {
      // Epic row
      rows.push([
        'Epic', sanitizeCsvCell(epic.name), '', '', '',
        '', '', '', '',
        sanitizeCsvCell(epic.description ?? ''), sanitizeCsvCell(epic.assumptions ?? ''),
        epic.isActive ? 'active' : 'inactive', '', '',
      ])

      for (const feature of epic.features) {
        // Feature row
        rows.push([
          'Feature', sanitizeCsvCell(epic.name), sanitizeCsvCell(feature.name), '', '',
          '', '', '', '',
          sanitizeCsvCell(feature.description ?? ''), sanitizeCsvCell(feature.assumptions ?? ''),
          '', feature.isActive ? 'active' : 'inactive', '',
        ])

        for (const story of feature.userStories) {
          // Story row
          rows.push([
            'Story', sanitizeCsvCell(epic.name), sanitizeCsvCell(feature.name), sanitizeCsvCell(story.name), '',
            sanitizeCsvCell(story.appliedTemplate?.name ?? ''),
            '', '', '',
            sanitizeCsvCell(story.description ?? ''), sanitizeCsvCell(story.assumptions ?? ''),
            '', '', story.isActive ? 'active' : 'inactive',
          ])

          // Task rows
          for (const task of story.tasks) {
            rows.push([
              'Task', sanitizeCsvCell(epic.name), sanitizeCsvCell(feature.name), sanitizeCsvCell(story.name), sanitizeCsvCell(task.name),
              '',
              sanitizeCsvCell(task.resourceType?.name ?? ''),
              String(task.hoursEffort),
              String(task.durationDays != null ? Math.round(task.durationDays * 100) / 100 : ''),
              sanitizeCsvCell(task.description ?? ''),
              sanitizeCsvCell(task.assumptions ?? ''),
              '', '', '',
            ])
          }
        }
      }
    }
  }

  const csv = stringify(rows)
  res.setHeader('Content-Type', 'text/csv')
  const datestamp = new Date().toISOString().slice(0, 10) // YYYY-MM-DD
  const safeName = (s: string) => s.replace(/[^a-zA-Z0-9 \-_]/g, '').trim()
  const clientPart = project.customer?.name ? `${safeName(project.customer.name)} - ` : ''
  const filename = `${clientPart}${safeName(project.name)} - ${datestamp}.csv`
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
  res.send(csv)
})

// POST /api/projects/:projectId/backlog/stage-csv
// Body: { csv: string }
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

  // Fetch all template names for validation
  const allTemplates = await prisma.featureTemplate.findMany({ select: { name: true } })
  const templateNames = new Set(allTemplates.map(t => t.name.toLowerCase()))

  // Carry-forward context (Excel-style empty cell inheritance)
  let lastEpic = '', lastFeature = '', lastStory = ''

  const staged: StagedRow[] = rawRows.map((raw, i) => {
    // Determine type — default to 'Task' if Type column absent (legacy compat)
    const rawType = raw.Type?.trim() || 'Task'
    const type = (['Epic', 'Feature', 'Story', 'Task'].includes(rawType)
      ? rawType
      : 'Task') as StagedRow['type']

    // Carry-forward (only update when non-blank)
    const epic = raw.Epic?.trim() || lastEpic
    const feature = type !== 'Epic' ? (raw.Feature?.trim() || lastFeature) : ''
    const story = ['Story', 'Task'].includes(type) ? (raw.Story?.trim() || lastStory) : ''
    const task = type === 'Task' ? (raw.Task?.trim() ?? '') : ''

    if (raw.Epic?.trim()) lastEpic = raw.Epic.trim()
    if (raw.Feature?.trim()) lastFeature = raw.Feature.trim()
    if (raw.Story?.trim()) lastStory = raw.Story.trim()

    const epicStatus = parseStatus(raw.EpicStatus)
    const featureStatus = parseStatus(raw.FeatureStatus)
    const storyStatus = parseStatus(raw.StoryStatus)
    const template = raw.Template?.trim() ?? ''

    const resourceType = raw.ResourceType?.trim() ?? ''

    const errors: string[] = []
    const warnings: string[] = []

    // Validation by type
    if (!epic) errors.push('Epic is required')
    if (type !== 'Epic' && !feature) errors.push('Feature is required')
    if (['Story', 'Task'].includes(type) && !story) errors.push('Story is required')
    if (type === 'Task' && !task) errors.push('Task name is required')

    if (resourceType && !rtNames.has(resourceType.toLowerCase())) {
      warnings.push(`Resource type "${resourceType}" not found in project — will be created automatically on import`)
    }

    // Template validation — only meaningful on Story rows
    if (type === 'Story' && template && !templateNames.has(template.toLowerCase())) {
      warnings.push(`Template "${template}" not found — will be ignored on import`)
    }
    if (type !== 'Story' && template) {
      warnings.push(`Template column is only applied on Story rows — will be ignored for this ${type} row`)
    }

    // Status-on-wrong-type warnings
    if (type !== 'Epic' && raw.EpicStatus?.trim()) {
      warnings.push(`EpicStatus is only applied on Epic rows — will be ignored for this ${type} row`)
    }
    if (type !== 'Feature' && raw.FeatureStatus?.trim()) {
      warnings.push(`FeatureStatus is only applied on Feature rows — will be ignored for this ${type} row`)
    }
    if (type !== 'Story' && raw.StoryStatus?.trim()) {
      warnings.push(`StoryStatus is only applied on Story rows — will be ignored for this ${type} row`)
    }

    // Reject negative hour values
    const rawHoursEffort = parseNum(raw.HoursEffort)
    if (rawHoursEffort < 0) errors.push('HoursEffort must be non-negative')

    return {
      rowIndex: i + 2, // 1-indexed + header
      type,
      epic,
      feature,
      story,
      task,
      epicStatus,
      featureStatus,
      storyStatus,
      template,
      resourceType,
      hoursExtraSmall: parseNum(raw.HoursExtraSmall),
      hoursSmall: parseNum(raw.HoursSmall),
      hoursMedium: parseNum(raw.HoursMedium),
      hoursLarge: parseNum(raw.HoursLarge),
      hoursExtraLarge: parseNum(raw.HoursExtraLarge),
      hoursEffort: rawHoursEffort,
      durationDays: parseNum(raw.DurationDays),
      description: sanitizeCsvCell(raw.Description?.trim() ?? ''),
      assumptions: sanitizeCsvCell(raw.Assumptions?.trim() ?? ''),
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
  const fallbackHoursPerDay = project.hoursPerDay ?? 7.6
  const resourceTypes = await prisma.resourceType.findMany({
    where: { projectId },
    select: { id: true, name: true, hoursPerDay: true },
  })
  const rtByName = new Map(resourceTypes.map(r => [r.name.toLowerCase(), r]))

  // Auto-create any resource types referenced in the CSV that don't exist yet
  const newRtNames = [
    ...new Set(
      rows
        .filter(row => row.resourceType && !rtByName.has(row.resourceType.toLowerCase()))
        .map(row => row.resourceType)
    ),
  ]
  for (const rtName of newRtNames) {
    const newRt = await prisma.resourceType.create({
      data: { name: rtName, category: 'ENGINEERING', count: 1, projectId },
      select: { id: true, name: true, hoursPerDay: true },
    })
    rtByName.set(rtName.toLowerCase(), newRt)
  }

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
        trigger: 'csv_import',
        snapshot: existingEpics as unknown as object,
        createdById: req.userId!,
      },
    })
  }

  // Build hierarchy maps to group rows (upsert by name within parent)
  const epicMap = new Map<string, string>() // epic name → epic id
  const featureMap = new Map<string, string>() // "epic||feature" → feature id
  const storyMap = new Map<string, string>() // "epic||feature||story" → story id

  let epicOrder = await prisma.epic.count({ where: { projectId } })

  // Counters for response
  let epicsCreated = 0, epicsUpdated = 0
  let featuresCreated = 0, featuresUpdated = 0
  let storiesCreated = 0, storiesUpdated = 0
  let tasksCreated = 0, tasksUpdated = 0

  for (const row of rows) {
    const epicKey = row.epic
    const featureKey = `${row.epic}||${row.feature}`
    const storyKey = `${row.epic}||${row.feature}||${row.story}`

    // ── Epic ───────────────────────────────────────────────────────────────
    if (!epicMap.has(epicKey)) {
      let epic = await prisma.epic.findFirst({ where: { projectId, name: row.epic } })
      if (!epic) {
        epic = await prisma.epic.create({
          data: {
            name: row.epic,
            projectId,
            order: epicOrder++,
            isActive: row.type === 'Epic' ? row.epicStatus : true,
            description: row.type === 'Epic' ? (row.description || null) : null,
            assumptions: row.type === 'Epic' ? (row.assumptions || null) : null,
          },
        })
        epicsCreated++
      } else if (row.type === 'Epic') {
        // Only update status when this is a canonical Epic row
        await prisma.epic.update({
          where: { id: epic.id },
          data: {
            isActive: row.epicStatus,
            ...(row.type === 'Epic' ? {
              description: row.description || null,
              assumptions: row.assumptions || null,
            } : {}),
          },
        })
        epicsUpdated++
      }
      epicMap.set(epicKey, epic.id)
    }
    const epicId = epicMap.get(epicKey)!

    // Epic-only rows — stop here
    if (row.type === 'Epic') continue

    // ── Feature ────────────────────────────────────────────────────────────
    if (!featureMap.has(featureKey)) {
      let feature = await prisma.feature.findFirst({ where: { epicId, name: row.feature } })
      if (!feature) {
        const featCount = await prisma.feature.count({ where: { epicId } })
        feature = await prisma.feature.create({
          data: {
            name: row.feature,
            epicId,
            order: featCount,
            isActive: row.type === 'Feature' ? row.featureStatus : true,
            description: row.type === 'Feature' ? (row.description || null) : null,
            assumptions: row.type === 'Feature' ? (row.assumptions || null) : null,
          },
        })
        featuresCreated++
      } else if (row.type === 'Feature') {
        await prisma.feature.update({
          where: { id: feature.id },
          data: {
            isActive: row.featureStatus,
            ...(row.type === 'Feature' ? {
              description: row.description || null,
              assumptions: row.assumptions || null,
            } : {}),
          },
        })
        featuresUpdated++
      }
      featureMap.set(featureKey, feature.id)
    }
    const featureId = featureMap.get(featureKey)!

    // Feature-only rows — stop here
    if (row.type === 'Feature') continue

    // ── Story ──────────────────────────────────────────────────────────────
    if (!storyMap.has(storyKey)) {
      // Template and status are only applied from canonical Story rows
      const isStoryRow = row.type === 'Story'
      const templateRecord = isStoryRow && row.template
        ? await prisma.featureTemplate.findUnique({ where: { name: row.template } })
        : null
      const appliedTemplateId = templateRecord?.id ?? null

      let story = await prisma.userStory.findFirst({ where: { featureId, name: row.story } })
      if (!story) {
        const storyCount = await prisma.userStory.count({ where: { featureId } })
        story = await prisma.userStory.create({
          data: {
            name: row.story,
            featureId,
            order: storyCount,
            isActive: isStoryRow ? row.storyStatus : true,
            appliedTemplateId,
            description: isStoryRow ? (row.description || null) : null,
            assumptions: isStoryRow ? (row.assumptions || null) : null,
          },
        })
        storiesCreated++
      } else if (isStoryRow) {
        // Only update story-level fields from a canonical Story row
        await prisma.userStory.update({
          where: { id: story.id },
          data: {
            isActive: row.storyStatus,
            ...(appliedTemplateId !== null ? { appliedTemplateId } : {}),
            ...(row.type === 'Story' ? {
              description: row.description || null,
              assumptions: row.assumptions || null,
            } : {}),
          },
        })
        storiesUpdated++
      }
      storyMap.set(storyKey, story.id)
    }
    const storyId = storyMap.get(storyKey)!

    // Story-only rows — stop here
    if (row.type === 'Story') continue

    // ── Task ───────────────────────────────────────────────────────────────
    if (!row.task) continue

    const resourceType = row.resourceType
      ? rtByName.get(row.resourceType.toLowerCase())
      : undefined
    const resourceTypeId = resourceType?.id ?? null
    const hoursPerDay = resourceType?.hoursPerDay ?? fallbackHoursPerDay

    const task = await prisma.task.findFirst({ where: { userStoryId: storyId, name: row.task } })
    if (!task) {
      const taskCount = await prisma.task.count({ where: { userStoryId: storyId } })
      await prisma.task.create({
        data: {
          name: row.task,
          userStoryId: storyId,
          order: taskCount,
          resourceTypeId,
          hoursEffort: row.hoursEffort,
          durationDays: row.durationDays || calcDurationDays(row.hoursEffort, hoursPerDay),
          description: row.description || null,
          assumptions: row.assumptions || null,
        },
      })
      tasksCreated++
    } else {
      await prisma.task.update({
        where: { id: task.id },
        data: {
          resourceTypeId,
          hoursEffort: row.hoursEffort,
          durationDays: row.durationDays || calcDurationDays(row.hoursEffort, hoursPerDay),
          description: row.description || null,
          assumptions: row.assumptions || null,
        },
      })
      tasksUpdated++
    }
  }

  res.json({
    message: 'Import successful',
    epicsCreated,
    epicsUpdated,
    featuresCreated,
    featuresUpdated,
    storiesCreated,
    storiesUpdated,
    tasksCreated,
    tasksUpdated,
  })
})

export default router
