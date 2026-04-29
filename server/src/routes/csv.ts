import { Router, Response } from 'express'
import { prisma } from '../lib/prisma.js'
import { asyncHandler } from '../lib/asyncHandler.js'
import { authenticate, AuthRequest } from '../middleware/auth.js'
import { parse } from 'csv-parse/sync'
import { stringify } from 'csv-stringify/sync'
import { calcDurationDays } from '../utils/round.js'
import { pruneSnapshots } from '../lib/snapshotUtils.js'
import { buildSnapshot } from './snapshots.js'

const router = Router({ mergeParams: true })
router.use(authenticate)

const CSV_HEADERS = [
  'Type', 'Epic', 'Feature', 'Story', 'Task',
  'Template',
  'TemplateSize',
  'ResourceType',
  'HoursEffort', 'DurationDays',
  'Description', 'Assumptions',
  'EpicStatus', 'FeatureStatus', 'StoryStatus',
  'EpicMode', 'FeatureMode',
  'EpicDependsOn', 'FeatureDependsOn',
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
  EpicMode: string
  FeatureMode: string
  EpicDependsOn: string
  FeatureDependsOn: string
  Template: string
  TemplateSize: string
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
  epicMode: string
  featureMode: string
  epicDependsOn: string[]   // array of epic names
  featureDependsOn: string[]  // array of feature names
  template: string
  templateSize: string   // 'XS' | 'Small' | 'Medium' | 'Large' | 'XL' | ''
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
  status?: 'new' | 'existing' | 'error'
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

/** Pick hours from a TemplateTask based on the sizing tier string */
function pickHours(
  task: { hoursExtraSmall: number; hoursSmall: number; hoursMedium: number; hoursLarge: number; hoursExtraLarge: number },
  size: string,
): number {
  switch (size.toLowerCase()) {
    case 'xs':     return task.hoursExtraSmall ?? 0
    case 'small':  return task.hoursSmall ?? 0
    case 'medium': return task.hoursMedium ?? 0
    case 'large':  return task.hoursLarge ?? 0
    case 'xl':     return task.hoursExtraLarge ?? 0
    default:       return 0
  }
}

/** Prevent CSV formula injection by prefixing dangerous characters with a single quote */
export function sanitizeCsvCell(value: string): string {
  if (/^[=+\-@\t\r]/.test(value)) {
    return `'${value}`
  }
  return value
}

// GET /api/projects/:projectId/backlog/export-csv
router.get('/export-csv', asyncHandler(async (req: AuthRequest, res: Response) => {
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

  // Build dependency lookup maps for export
  const epicDepsRaw = await prisma.epicDependency.findMany({
    where: { epic: { projectId: req.params.projectId as string } },
    include: { dependsOn: { select: { name: true } } },
  })
  const epicDepNames = new Map<string, string[]>()
  for (const d of epicDepsRaw) {
    const arr = epicDepNames.get(d.epicId) ?? []
    arr.push(d.dependsOn.name)
    epicDepNames.set(d.epicId, arr)
  }

  const featureDepsRaw = await prisma.featureDependency.findMany({
    where: { feature: { epic: { projectId: req.params.projectId as string } } },
    include: {
      feature: { select: { epicId: true } },
      dependsOn: { select: { name: true, epicId: true, epic: { select: { name: true } } } },
    },
  })
  const featureDepNames = new Map<string, string[]>()
  for (const d of featureDepsRaw) {
    const arr = featureDepNames.get(d.featureId) ?? []
    // Use qualified "EpicName: FeatureName" format for cross-epic deps so they round-trip correctly
    const isCrossEpic = d.feature.epicId !== d.dependsOn.epicId
    arr.push(isCrossEpic ? `${d.dependsOn.epic.name}: ${d.dependsOn.name}` : d.dependsOn.name)
    featureDepNames.set(d.featureId, arr)
  }

  if (epics.length === 0) {
    // Description row — explains each column
    rows.push([
      'Type: Epic | Feature | Story | Task',
      'Epic name (required on all rows)',
      'Feature name (required on Feature/Story/Task rows)',
      'Story name (required on Story/Task rows)',
      'Task name (required on Task rows)',
      'Template name to link to story (Story rows only)',
      'Template size tier: XS | Small | Medium | Large | XL (Story rows only — auto-expands tasks)',
      'Resource type name (Task rows only)',
      'Hours of effort (Task rows only)',
      'Duration in days — auto-calculated if blank (Task rows only)',
      'Description (rich text supported)',
      'Assumptions (rich text supported)',
      'Epic status: active | inactive',
      'Feature status: active | inactive',
      'Story status: active | inactive',
      'Epic feature mode: sequential | parallel',
      'Feature story mode: sequential | parallel',
      'Epic dependencies: comma-separated epic names this epic depends on',
      'Feature dependencies: comma-separated feature names this feature depends on (same-epic: "FeatureName"; cross-epic: "EpicName: FeatureName")',
    ])
    // Example Epic row
    rows.push(['Epic', 'Platform Setup', '', '', '', '', '', '', '', '', 'Core infrastructure and environment setup', '', 'active', '', '', 'sequential', '', '', ''])
    rows.push(['Epic', 'Mobile App', '', '', '', '', '', '', '', '', 'Mobile front-end layer', '', 'active', '', '', 'sequential', '', 'Platform Setup', ''])
    // Example Feature rows — same-epic dep, then cross-epic dep
    rows.push(['Feature', 'Platform Setup', 'Authentication', '', '', '', '', '', '', '', 'Login and registration flows', '', '', 'active', '', '', 'sequential', '', ''])
    rows.push(['Feature', 'Platform Setup', 'User Profile', '', '', '', '', '', '', '', 'User profile management', '', '', 'active', '', '', 'sequential', '', 'Authentication'])
    rows.push(['Feature', 'Mobile App', 'Login Screen', '', '', '', '', '', '', '', 'Mobile login UI', '', '', 'active', '', '', 'sequential', '', 'Platform Setup: Authentication'])
    // Example Story row (with template)
    rows.push(['Story', 'Platform Setup', 'Authentication', 'User can log in', '', 'Login Flow', 'Medium', '', '', '', 'As a user I can log in with email and password', '', '', '', 'active', '', '', '', ''])
    // Example Task row
    rows.push(['Task', 'Platform Setup', 'Authentication', 'User can log in', 'Backend API', '', '', 'Developer', '8', '', '', '', '', '', '', '', '', '', ''])
  } else {
    for (const epic of epics) {
      // Epic row
      rows.push([
        'Epic', sanitizeCsvCell(epic.name), '', '', '',
        '', '', '', '', '',
        sanitizeCsvCell(epic.description ?? ''), sanitizeCsvCell(epic.assumptions ?? ''),
        epic.isActive ? 'active' : 'inactive', '', '',
        epic.featureMode ?? 'sequential', '',
        epicDepNames.get(epic.id)?.join(', ') ?? '', '',
      ])

      for (const feature of epic.features) {
        // Feature row
        rows.push([
          'Feature', sanitizeCsvCell(epic.name), sanitizeCsvCell(feature.name), '', '',
          '', '', '', '', '',
          sanitizeCsvCell(feature.description ?? ''), sanitizeCsvCell(feature.assumptions ?? ''),
          '', feature.isActive ? 'active' : 'inactive', '',
          '', feature.featureMode ?? 'sequential',
          '', featureDepNames.get(feature.id)?.join(', ') ?? '',
        ])

        for (const story of feature.userStories) {
          // Story row
          rows.push([
            'Story', sanitizeCsvCell(epic.name), sanitizeCsvCell(feature.name), sanitizeCsvCell(story.name), '',
            sanitizeCsvCell(story.appliedTemplate?.name ?? ''),
            '', // TemplateSize — UserStory has no sizingTier field; exported blank
            '', '', '',
            sanitizeCsvCell(story.description ?? ''), sanitizeCsvCell(story.assumptions ?? ''),
            '', '', story.isActive ? 'active' : 'inactive',
            '', '',
            '', '',
          ])

          // Task rows
          for (const task of story.tasks) {
            rows.push([
              'Task', sanitizeCsvCell(epic.name), sanitizeCsvCell(feature.name), sanitizeCsvCell(story.name), sanitizeCsvCell(task.name),
              '', // Template
              '', // TemplateSize
              sanitizeCsvCell(task.resourceType?.name ?? ''),
              String(task.hoursEffort),
              String(task.durationDays != null ? Math.round(task.durationDays * 100) / 100 : ''),
              sanitizeCsvCell(task.description ?? ''),
              sanitizeCsvCell(task.assumptions ?? ''),
              '', '', '',
              '', '',
              '', '',
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
}))

// POST /api/projects/:projectId/backlog/stage-csv
// Body: { csv: string }
router.post('/stage-csv', asyncHandler(async (req: AuthRequest, res: Response) => {
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
    const rawEpicMode = raw.EpicMode?.trim().toLowerCase() || 'sequential'
    const epicMode = (rawEpicMode === 'sequential' || rawEpicMode === 'parallel') ? rawEpicMode : 'sequential'
    const rawFeatureMode = raw.FeatureMode?.trim().toLowerCase() || 'sequential'
    const featureMode = (rawFeatureMode === 'sequential' || rawFeatureMode === 'parallel') ? rawFeatureMode : 'sequential'
    const template = raw.Template?.trim() ?? ''
    const templateSize = raw.TemplateSize?.trim() ?? ''

    const epicDependsOn = (raw.EpicDependsOn ?? '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean)

    const featureDependsOn = (raw.FeatureDependsOn ?? '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean)

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

    // TemplateSize validation — only meaningful on Story rows
    const validSizes = new Set(['xs', 'small', 'medium', 'large', 'xl'])
    if (type === 'Story' && templateSize && !validSizes.has(templateSize.toLowerCase())) {
      warnings.push(`TemplateSize "${templateSize}" is not valid — use XS, Small, Medium, Large, or XL`)
    }
    if (type !== 'Story' && templateSize) {
      warnings.push(`TemplateSize column is only applied on Story rows — will be ignored for this ${type} row`)
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
      epicMode,
      featureMode,
      epicDependsOn,
      featureDependsOn,
      template,
      templateSize,
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

  // Cross-row dependency name validation (warnings only — import still proceeds)
  const knownEpicNames = new Set(staged.filter(r => r.type === 'Epic').map(r => r.epic))
  const knownFeatureNames = new Set(staged.filter(r => r.type === 'Feature').map(r => r.feature))
  // Build "EpicName||FeatureName" set for cross-epic qualified lookup
  const knownEpicFeaturePairs = new Set(staged.filter(r => r.type === 'Feature').map(r => `${r.epic}||${r.feature}`))
  for (const row of staged) {
    for (const depName of row.epicDependsOn) {
      if (!knownEpicNames.has(depName)) {
        row.warnings.push(`EpicDependsOn: '${depName}' not found in this import`)
      }
    }
    for (const depName of row.featureDependsOn) {
      const colonIdx = depName.indexOf(': ')
      if (colonIdx !== -1) {
        // Cross-epic qualified format: "EpicName: FeatureName"
        const epicPart = depName.slice(0, colonIdx)
        const featPart = depName.slice(colonIdx + 2)
        if (!knownEpicFeaturePairs.has(`${epicPart}||${featPart}`)) {
          row.warnings.push(`FeatureDependsOn: '${depName}' not found in this import`)
        }
      } else if (!knownFeatureNames.has(depName)) {
        row.warnings.push(`FeatureDependsOn: '${depName}' not found in this import`)
      }
    }
  }

  const errorCount = staged.filter(r => r.errors.length > 0).length
  const warningCount = staged.filter(r => r.warnings.length > 0).length

  // Fetch existing epics/features/stories to determine new vs existing status
  const existingEpics = await prisma.epic.findMany({
    where: { projectId: req.params.projectId as string },
    include: {
      features: {
        include: { userStories: { select: { name: true } } },
      }
    },
  })
  const existingKeys = new Set<string>()
  for (const ep of existingEpics) {
    existingKeys.add(ep.name.toLowerCase())
    for (const ft of ep.features) {
      existingKeys.add(`${ep.name}|||${ft.name}`.toLowerCase())
      for (const st of ft.userStories) {
        existingKeys.add(`${ep.name}|||${ft.name}|||${st.name}`.toLowerCase())
      }
    }
  }

  // Annotate each staged row with status
  const annotatedStaged = staged.map(row => {
    if (row.errors.length > 0) return { ...row, status: 'error' as const }
    const key = [row.epic, row.feature, row.story].filter(Boolean).join('|||').toLowerCase()
    return { ...row, status: existingKeys.has(key) ? 'existing' as const : 'new' as const }
  })

  res.json({ staged: annotatedStaged, summary: { total: staged.length, errorCount, warningCount } })
}))

// POST /api/projects/:projectId/backlog/import-csv
// Body: { rows: StagedRow[] }
router.post('/import-csv', asyncHandler(async (req: AuthRequest, res: Response) => {
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

  // Auto-snapshot before import using shared buildSnapshot() for full state capture
  const existingEpics = await prisma.epic.findMany({ where: { projectId }, select: { id: true } })
  if (existingEpics.length > 0) {
    const snapshotData = await buildSnapshot(projectId)
    await prisma.backlogSnapshot.create({
      data: {
        projectId,
        label: 'Auto-snapshot before CSV import',
        trigger: 'csv_import',
        snapshot: snapshotData as unknown as object,
        createdById: req.userId!,
      },
    })
    // #177: enforce retention policy — keep the 20 most-recent snapshots per project
    await pruneSnapshots(prisma, projectId)
  }

  // #176: wrap all DB writes in a transaction for atomicity
  const result = await prisma.$transaction(async (tx) => {
    // Build hierarchy maps to group rows (upsert by name within parent)
    const epicMap = new Map<string, string>() // epic name → epic id
    const featureMap = new Map<string, string>() // "epic||feature" → feature id
    const storyMap = new Map<string, string>() // "epic||feature||story" → story id
    const storyTemplateMap = new Map<string, { appliedTemplateId: string | null; templateSize: string }>()

    // Build set of story keys that have at least one Task row in the CSV (used for Gap 1 auto-expand check)
    const storyKeysWithTaskRows = new Set<string>()
    for (const row of rows) {
      if (row.type === 'Task' && row.story) {
        storyKeysWithTaskRows.add(`${row.epic}||${row.feature}||${row.story}`)
      }
    }

    let epicOrder = await tx.epic.count({ where: { projectId } })

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
        let epic = await tx.epic.findFirst({ where: { projectId, name: row.epic } })
        if (!epic) {
          epic = await tx.epic.create({
            data: {
              name: row.epic,
              projectId,
              order: epicOrder++,
              isActive: row.type === 'Epic' ? row.epicStatus : true,
              featureMode: row.type === 'Epic' ? (row.epicMode ?? 'sequential') : 'sequential',
              description: row.type === 'Epic' ? (row.description || null) : null,
              assumptions: row.type === 'Epic' ? (row.assumptions || null) : null,
            },
          })
          epicsCreated++
        } else if (row.type === 'Epic') {
          // Only update status when this is a canonical Epic row
          await tx.epic.update({
            where: { id: epic.id },
            data: {
              isActive: row.epicStatus,
              featureMode: row.epicMode ?? 'sequential',
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
        let feature = await tx.feature.findFirst({ where: { epicId, name: row.feature } })
        if (!feature) {
          const featCount = await tx.feature.count({ where: { epicId } })
          feature = await tx.feature.create({
            data: {
              name: row.feature,
              epicId,
              order: featCount,
              isActive: row.type === 'Feature' ? row.featureStatus : true,
              featureMode: row.type === 'Feature' ? (row.featureMode ?? 'sequential') : 'sequential',
              description: row.type === 'Feature' ? (row.description || null) : null,
              assumptions: row.type === 'Feature' ? (row.assumptions || null) : null,
            },
          })
          featuresCreated++
        } else if (row.type === 'Feature') {
          await tx.feature.update({
            where: { id: feature.id },
            data: {
              isActive: row.featureStatus,
              featureMode: row.featureMode ?? 'sequential',
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
          ? await tx.featureTemplate.findUnique({ where: { name: row.template } })
          : null
        const appliedTemplateId = templateRecord?.id ?? null
        const templateSize = isStoryRow ? (row.templateSize ?? '') : ''

        let story = await tx.userStory.findFirst({ where: { featureId, name: row.story } })
        if (!story) {
          const storyCount = await tx.userStory.count({ where: { featureId } })
          story = await tx.userStory.create({
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
          await tx.userStory.update({
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

        // Track template info for Gap 2 (Task rows that need hour backfill)
        storyTemplateMap.set(storyKey, { appliedTemplateId, templateSize })

        // Gap 1: Auto-expand template tasks when no Task rows for this story appear in the CSV
        if (appliedTemplateId && templateSize && !storyKeysWithTaskRows.has(storyKey)) {
          const tmpl = await tx.featureTemplate.findUnique({
            where: { id: appliedTemplateId },
            include: { tasks: { orderBy: { order: 'asc' } } },
          })
          if (tmpl) {
            let taskOrder = await tx.task.count({ where: { userStoryId: story.id } })
            for (const tmplTask of tmpl.tasks) {
              const hours = pickHours(tmplTask, templateSize)
              const tmplRt = tmplTask.resourceTypeName
                ? rtByName.get(tmplTask.resourceTypeName.toLowerCase())
                : undefined
              const tmplResourceTypeId = tmplRt?.id ?? null
              const tmplHoursPerDay = tmplRt?.hoursPerDay ?? fallbackHoursPerDay
              const existingTask = await tx.task.findFirst({
                where: { userStoryId: story.id, name: tmplTask.name },
              })
              if (!existingTask) {
                await tx.task.create({
                  data: {
                    name: tmplTask.name,
                    userStoryId: story.id,
                    order: taskOrder++,
                    resourceTypeId: tmplResourceTypeId,
                    hoursEffort: hours,
                    durationDays: calcDurationDays(hours, tmplHoursPerDay),
                  },
                })
                tasksCreated++
              }
            }
          }
        }
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

      // Gap 2: Backfill hours from template when row hours are blank (0) and story has Template+TemplateSize
      let effectiveHoursEffort = row.hoursEffort
      if (effectiveHoursEffort === 0) {
        const storyTmpl = storyTemplateMap.get(storyKey)
        if (storyTmpl?.appliedTemplateId && storyTmpl.templateSize) {
          const tmplTask = await tx.templateTask.findFirst({
            where: { templateId: storyTmpl.appliedTemplateId, name: row.task },
          })
          if (tmplTask) {
            effectiveHoursEffort = pickHours(tmplTask, storyTmpl.templateSize)
          }
        }
      }

      const task = await tx.task.findFirst({ where: { userStoryId: storyId, name: row.task } })
      if (!task) {
        const taskCount = await tx.task.count({ where: { userStoryId: storyId } })
        await tx.task.create({
          data: {
            name: row.task,
            userStoryId: storyId,
            order: taskCount,
            resourceTypeId,
            hoursEffort: effectiveHoursEffort,
            durationDays: row.durationDays || calcDurationDays(effectiveHoursEffort, hoursPerDay),
            description: row.description || null,
            assumptions: row.assumptions || null,
          },
        })
        tasksCreated++
      } else {
        await tx.task.update({
          where: { id: task.id },
          data: {
            resourceTypeId,
            hoursEffort: effectiveHoursEffort,
            durationDays: row.durationDays || calcDurationDays(effectiveHoursEffort, hoursPerDay),
            description: row.description || null,
            assumptions: row.assumptions || null,
          },
        })
        tasksUpdated++
      }
    }

    // ── Epic dependencies ─────────────────────────────────────────────────────
    // Build name→id map from what was just created/updated
    const epicNameToId = new Map<string, string>()
    for (const [epicKey, epicId] of epicMap.entries()) {
      epicNameToId.set(epicKey, epicId)
    }
    for (const row of rows) {
      if (row.type !== 'Epic' || !row.epicDependsOn?.length) continue
      const epicId = epicNameToId.get(row.epic)
      if (!epicId) continue
      for (const depName of row.epicDependsOn) {
        const depEpicId = epicNameToId.get(depName)
        if (!depEpicId || depEpicId === epicId) continue
        await tx.epicDependency.upsert({
          where: { epicId_dependsOnId: { epicId, dependsOnId: depEpicId } },
          create: { epicId, dependsOnId: depEpicId },
          update: {},
        })
      }
    }

    // ── Feature dependencies ──────────────────────────────────────────────────
    // Build epic-scoped name→id map: epicName → (featureName → featureId)
    // Scoping to the same epic prevents cross-epic name collisions when templates
    // share identical feature names (e.g. every epic has "Infrastructure & Environment")
    const featureNameByEpic = new Map<string, Map<string, string>>()
    for (const [featureKey, featureId] of featureMap.entries()) {
      const [epicName, featureName] = featureKey.split('||')
      if (!featureNameByEpic.has(epicName)) featureNameByEpic.set(epicName, new Map())
      featureNameByEpic.get(epicName)!.set(featureName, featureId)
    }
    for (const row of rows) {
      if (row.type !== 'Feature' || !row.featureDependsOn?.length) continue
      const featureId = featureMap.get(`${row.epic}||${row.feature}`)
      if (!featureId) continue
      const epicFeatures = featureNameByEpic.get(row.epic) ?? new Map<string, string>()
      for (const depName of row.featureDependsOn) {
        // Support "EpicName: FeatureName" for cross-epic deps; plain name = same-epic
        let depFeatureId: string | undefined
        const colonIdx = depName.indexOf(': ')
        if (colonIdx !== -1) {
          const epicPart = depName.slice(0, colonIdx)
          const featPart = depName.slice(colonIdx + 2)
          depFeatureId = featureNameByEpic.get(epicPart)?.get(featPart)
        } else {
          depFeatureId = epicFeatures.get(depName)
        }
        if (!depFeatureId || depFeatureId === featureId) continue
        await tx.featureDependency.upsert({
          where: { featureId_dependsOnId: { featureId, dependsOnId: depFeatureId } },
          create: { featureId, dependsOnId: depFeatureId },
          update: {},
        })
      }
    }

    return { epicsCreated, epicsUpdated, featuresCreated, featuresUpdated, storiesCreated, storiesUpdated, tasksCreated, tasksUpdated }
  }, { timeout: 60000 })

  res.json({
    message: 'Import successful',
    ...result,
  })
}))

export default router
