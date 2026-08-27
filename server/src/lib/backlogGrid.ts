import { z } from 'zod'
import { buildSnapshot } from './projectSnapshotService.js'
import { pruneSnapshots } from './snapshotUtils.js'
import { prisma } from './prisma.js'
import { calcDurationDays } from '../utils/round.js'

export type GridRowType = 'epic' | 'feature' | 'story' | 'task'

export interface BacklogGridRowInput {
  id?: string | null
  type: GridRowType
  epicName?: string
  featureName?: string
  storyName?: string
  name?: string
  isActive?: boolean
  description?: string | null
  assumptions?: string | null
  resourceTypeId?: string | null
  resourceTypeName?: string | null
  hoursEffort?: number | null
  durationDays?: number | null
}

export interface GridFieldError {
  row: number
  field: string
  message: string
}

export class BacklogGridValidationError extends Error {
  constructor(public readonly fieldErrors: GridFieldError[]) {
    super('Grid entry contains validation errors')
    this.name = 'BacklogGridValidationError'
  }
}

interface ExistingTree {
  epics: Array<{ id: string; name: string; features: Array<{ id: string; name: string; epicId: string; userStories: Array<{ id: string; name: string; featureId: string; tasks: Array<{ id: string; name: string }> }> }> }>
}

const text = (value: unknown) => typeof value === 'string' ? value.trim() : ''
const key = (value: string) => value.trim().toLocaleLowerCase()

function addError(errors: GridFieldError[], row: number, field: string, message: string) {
  errors.push({ row, field, message })
}
const gridRowsSchema = z.array(z.object({
  id: z.string().nullable().optional(),
  type: z.enum(['epic', 'feature', 'story', 'task']),
  epicName: z.string().optional(),
  featureName: z.string().optional(),
  storyName: z.string().optional(),
  name: z.string().optional(),
  isActive: z.boolean().optional(),
  description: z.string().nullable().optional(),
  assumptions: z.string().nullable().optional(),
  resourceTypeId: z.string().nullable().optional(),
  resourceTypeName: z.string().nullable().optional(),
  hoursEffort: z.number().nullable().optional(),
  durationDays: z.number().nullable().optional(),
})).min(1)

export function parseBacklogGridRows(value: unknown): BacklogGridRowInput[] {
  const result = gridRowsSchema.safeParse(value)
  if (!result.success) {
    throw new BacklogGridValidationError(result.error.issues.map(issue => ({
      row: typeof issue.path[0] === 'number' ? issue.path[0] : 0,
      field: typeof issue.path[1] === 'string' ? issue.path[1] : typeof issue.path[0] === 'number' ? 'row' : 'rows',
      message: issue.message,
    })))
  }
  return result.data
}



function requireText(errors: GridFieldError[], row: number, field: string, value: unknown, label: string) {
  if (!text(value)) addError(errors, row, field, `${label} is required`)
}

function finiteNonNegative(errors: GridFieldError[], row: number, field: string, value: unknown) {
  if (value !== undefined && value !== null && (typeof value !== 'number' || !Number.isFinite(value) || value < 0)) {
    addError(errors, row, field, 'must be a finite non-negative number')
  }
}

function positiveNumber(errors: GridFieldError[], row: number, field: string, value: unknown) {
  if (value !== undefined && value !== null && (typeof value !== 'number' || !Number.isFinite(value) || value <= 0)) {
    addError(errors, row, field, 'must be a positive number')
  }
}

async function loadTree(projectId: string): Promise<ExistingTree> {
  const epics = await prisma.epic.findMany({
    where: { projectId },
    select: {
      id: true,
      name: true,
      features: {
        select: {
          id: true,
          name: true,
          epicId: true,
          userStories: { select: { id: true, name: true, featureId: true, tasks: { select: { id: true, name: true } } } },
        },
      },
    },
  })
  return { epics: epics as ExistingTree['epics'] }
}

function findUniqueByName<T extends { id: string; name: string }>(items: T[], name: string): T | null | 'ambiguous' {
  const matches = items.filter(item => key(item.name) === key(name))
  return matches.length > 1 ? 'ambiguous' : matches[0] ?? null
}

function findExistingRow(tree: ExistingTree, type: GridRowType, id: string) {
  for (const epic of tree.epics) {
    if (type === 'epic' && epic.id === id) return { epic }
    for (const feature of epic.features) {
      if (type === 'feature' && feature.id === id) return { epic, feature }
      for (const story of feature.userStories) {
        if (type === 'story' && story.id === id) return { epic, feature, story }
        if (type === 'task' && story.tasks.some(task => task.id === id)) return { epic, feature, story }
      }
    }
  }
  return null
}

export async function validateBacklogGrid(projectId: string, rows: BacklogGridRowInput[]) {
  const tree = await loadTree(projectId)
  const resourceTypes = await prisma.resourceType.findMany({ where: { projectId }, select: { id: true, name: true } })
  const errors: GridFieldError[] = []
  const seenIds = new Set<string>()
  const newPaths = new Set<string>()
  const stagedEpics = rows.filter(row => !row.id && row.type === 'epic' && text(row.name))
  const stagedFeatures = rows.filter(row => !row.id && row.type === 'feature' && text(row.name))
  const stagedStories = rows.filter(row => !row.id && row.type === 'story' && text(row.name))

  for (const [rowIndex, row] of rows.entries()) {
    if (!['epic', 'feature', 'story', 'task'].includes(row.type)) {
      addError(errors, rowIndex, 'type', 'type must be Epic, Feature, Story, or Task')
      continue
    }
    requireText(errors, rowIndex, 'name', row.name, `${row.type} name`)
    if (row.id) {
      if (seenIds.has(row.id)) addError(errors, rowIndex, 'id', 'the same existing item appears more than once')
      seenIds.add(row.id)
      if (!findExistingRow(tree, row.type, row.id)) addError(errors, rowIndex, 'id', 'existing item was not found in this project')
    }

    if (row.type !== 'epic') requireText(errors, rowIndex, 'epicName', row.epicName, 'Epic')
    if (row.type === 'story' || row.type === 'task') requireText(errors, rowIndex, 'featureName', row.featureName, 'Feature')
    if (row.type === 'task') requireText(errors, rowIndex, 'storyName', row.storyName, 'Story')

    if (row.type === 'task') {
      finiteNonNegative(errors, rowIndex, 'hoursEffort', row.hoursEffort)
      positiveNumber(errors, rowIndex, 'durationDays', row.durationDays)
      if (row.resourceTypeId) {
        if (!resourceTypes.some(resourceType => resourceType.id === row.resourceTypeId)) {
          addError(errors, rowIndex, 'resourceType', 'resource type is not available in this project')
        }
      } else {
        const matches = resourceTypes.filter(resourceType => key(resourceType.name) === key(row.resourceTypeName ?? ''))
        if (matches.length !== 1) addError(errors, rowIndex, 'resourceType', matches.length > 1 ? 'resource type is ambiguous' : 'resource type must resolve to an existing project resource type')
      }
    }

    if (!row.id) {
      const path = row.type === 'epic'
        ? `epic:${key(row.name ?? '')}`
        : row.type === 'feature'
          ? `feature:${key(row.epicName ?? '')}:${key(row.name ?? '')}`
          : row.type === 'story'
            ? `story:${key(row.epicName ?? '')}:${key(row.featureName ?? '')}:${key(row.name ?? '')}`
            : `task:${key(row.epicName ?? '')}:${key(row.featureName ?? '')}:${key(row.storyName ?? '')}:${key(row.name ?? '')}`
      if (newPaths.has(path)) addError(errors, rowIndex, 'name', 'duplicate staged hierarchy path')
      newPaths.add(path)
    }
  }

  for (const row of stagedEpics) {
    const existing = findUniqueByName(tree.epics, text(row.name))
    if (existing === 'ambiguous') addError(errors, rows.indexOf(row), 'name', 'name conflicts with ambiguous existing epics')
    else if (existing) addError(errors, rows.indexOf(row), 'name', 'an existing epic already has this name; edit that row instead')
  }

  const resolveEpic = (row: BacklogGridRowInput) => {
    const existing = findUniqueByName(tree.epics, text(row.epicName))
    if (existing === 'ambiguous') return 'ambiguous' as const
    if (existing) return existing
    const staged = stagedEpics.find(candidate => key(candidate.name ?? '') === key(row.epicName ?? ''))
    return staged ? { id: null, name: text(staged.name) } : null
  }

  for (const row of [...stagedFeatures, ...stagedStories, ...rows.filter(candidate => !candidate.id && candidate.type === 'task')]) {
    const rowIndex = rows.indexOf(row)
    const epic = resolveEpic(row)
    if (epic === 'ambiguous') addError(errors, rowIndex, 'epicName', 'Epic name is ambiguous')
    else if (!epic) addError(errors, rowIndex, 'epicName', 'Epic does not exist or is not staged')
    if (row.type === 'feature' && epic && epic !== 'ambiguous' && epic.id) {
      const existingFeature = findUniqueByName(tree.epics.find(candidate => candidate.id === epic.id)?.features ?? [], text(row.name))
      if (existingFeature === 'ambiguous') addError(errors, rowIndex, 'name', 'Feature name is ambiguous')
      else if (existingFeature) addError(errors, rowIndex, 'name', 'an existing feature already has this name; edit that row instead')
    }
    if (row.type !== 'story' && row.type !== 'task') continue
    const existingEpic = epic && epic !== 'ambiguous' && epic.id ? tree.epics.find(candidate => candidate.id === epic.id) : null
    const featureCandidates = existingEpic?.features ?? []
    const existingFeature = findUniqueByName(featureCandidates, text(row.featureName))
    const stagedFeature = stagedFeatures.find(candidate => key(candidate.epicName ?? '') === key(row.epicName ?? '') && key(candidate.name ?? '') === key(row.featureName ?? ''))
    if (!stagedFeature && existingFeature === 'ambiguous') addError(errors, rowIndex, 'featureName', 'Feature name is ambiguous')
    else if (!stagedFeature && !existingFeature) addError(errors, rowIndex, 'featureName', 'Feature does not exist or is not staged')
    const existingFeatureRecord = existingFeature && existingFeature !== 'ambiguous' ? existingFeature : null
    const storyCandidates = existingFeatureRecord ? tree.epics.flatMap(e => e.features).find(f => f.id === existingFeatureRecord.id)?.userStories ?? [] : []
    const existingStory = findUniqueByName(storyCandidates, text(row.type === 'story' ? row.name : row.storyName))
    if (row.type === 'story') {
      if (existingFeatureRecord && existingStory === 'ambiguous') addError(errors, rowIndex, 'name', 'Story name is ambiguous')
      else if (existingFeatureRecord && existingStory) addError(errors, rowIndex, 'name', 'an existing story already has this name; edit that row instead')
      continue
    }
    const stagedStory = stagedStories.find(candidate => key(candidate.epicName ?? '') === key(row.epicName ?? '') && key(candidate.featureName ?? '') === key(row.featureName ?? '') && key(candidate.name ?? '') === key(row.storyName ?? ''))
    if (!stagedStory && existingStory === 'ambiguous') addError(errors, rowIndex, 'storyName', 'Story name is ambiguous')
    else if (!stagedStory && !existingStory) addError(errors, rowIndex, 'storyName', 'Story does not exist or is not staged')
    if (existingStory && existingStory !== 'ambiguous') {
      const existingTask = findUniqueByName(existingStory.tasks, text(row.name))
      if (existingTask === 'ambiguous') addError(errors, rowIndex, 'name', 'Task name is ambiguous')
      else if (existingTask) addError(errors, rowIndex, 'name', 'an existing task already has this name; edit that row instead')
    }
  }

  if (errors.length > 0) throw new BacklogGridValidationError(errors)
  return { tree, resourceTypes }
}

export async function commitBacklogGrid(projectId: string, userId: string, rows: BacklogGridRowInput[]) {
  const { tree, resourceTypes } = await validateBacklogGrid(projectId, rows)
  const project = await prisma.project.findUnique({ where: { id: projectId }, select: { hoursPerDay: true } })
  const hoursPerDay = project?.hoursPerDay ?? 7.6
  const rank: Record<GridRowType, number> = { epic: 0, feature: 1, story: 2, task: 3 }
  const orderedRows = rows.map((row, index) => ({ row, index })).sort((left, right) => rank[left.row.type] - rank[right.row.type])
  const result = await prisma.$transaction(async tx => {
    const rowIds: Array<string | null> = Array(rows.length).fill(null)
    let snapshotId: string | null = null
    if (tree.epics.length > 0) {
      const snapshot = await buildSnapshot(projectId, tx)
      const saved = await tx.backlogSnapshot.create({
        data: { projectId, label: 'Auto-snapshot before Grid Entry commit', trigger: 'grid_entry', snapshot: snapshot as unknown as object, createdById: userId },
        select: { id: true },
      })
      snapshotId = saved.id
      await pruneSnapshots(tx, projectId)
    }

    const epicIds = new Map<string, string>()
    const featureIds = new Map<string, string>()
    const storyIds = new Map<string, string>()
    const existingFeatureById = new Map(tree.epics.flatMap(epic => epic.features).map(feature => [feature.id, feature]))
    for (const epic of tree.epics) {
      epicIds.set(`name:${key(epic.name)}`, epic.id)
      for (const feature of epic.features) {
        featureIds.set(`name:${key(epic.name)}:${key(feature.name)}`, feature.id)
        for (const story of feature.userStories) storyIds.set(`name:${key(epic.name)}:${key(feature.name)}:${key(story.name)}`, story.id)
      }
    }

    let epicOrder = tree.epics.length
    const featureOrder = new Map<string, number>()
    const storyOrder = new Map<string, number>()
    const taskOrder = new Map<string, number>()
    for (const epic of tree.epics) {
      featureOrder.set(epic.id, epic.features.length)
      for (const feature of epic.features) {
        storyOrder.set(feature.id, feature.userStories.length)
        for (const story of feature.userStories) taskOrder.set(story.id, story.tasks.length)
      }
    }

    for (const { row, index } of orderedRows) {
      let committedId = row.id ?? null
      const description = row.description ?? null
      const assumptions = row.assumptions ?? null
      if (row.type === 'epic') {
        if (row.id) await tx.epic.update({ where: { id: row.id }, data: { name: text(row.name), description, assumptions, ...(row.isActive !== undefined && { isActive: row.isActive }) } })
        else {
          const created = await tx.epic.create({ data: { name: text(row.name), description, assumptions, projectId, order: epicOrder++, isActive: row.isActive ?? true } })
          committedId = created.id
          epicIds.set(`name:${key(row.name ?? '')}`, created.id)
        }
      }
      if (row.type === 'feature') {
        const epicId = row.id ? existingFeatureById.get(row.id)!.epicId : epicIds.get(`name:${key(row.epicName ?? '')}`)
        if (!epicId) throw new Error('Grid feature parent was not resolved')
        if (row.id) await tx.feature.update({ where: { id: row.id }, data: { name: text(row.name), description, assumptions, ...(row.isActive !== undefined && { isActive: row.isActive }) } })
        else {
          const created = await tx.feature.create({ data: { name: text(row.name), description, assumptions, epicId, order: featureOrder.get(epicId) ?? 0, isActive: row.isActive ?? true } })
          featureOrder.set(epicId, (featureOrder.get(epicId) ?? 0) + 1)
          committedId = created.id
          featureIds.set(`name:${key(row.epicName ?? '')}:${key(row.name ?? '')}`, created.id)
        }
      }
      if (row.type === 'story') {
        const featureId = row.id
          ? tree.epics.flatMap(epic => epic.features).find(feature => feature.userStories.some(story => story.id === row.id))?.id
          : featureIds.get(`name:${key(row.epicName ?? '')}:${key(row.featureName ?? '')}`)
        if (!featureId) throw new Error('Grid story parent was not resolved')
        if (row.id) await tx.userStory.update({ where: { id: row.id }, data: { name: text(row.name), description, assumptions, ...(row.isActive !== undefined && { isActive: row.isActive }) } })
        else {
          const created = await tx.userStory.create({ data: { name: text(row.name), description, assumptions, featureId, order: storyOrder.get(featureId) ?? 0, isActive: row.isActive ?? true } })
          storyOrder.set(featureId, (storyOrder.get(featureId) ?? 0) + 1)
          committedId = created.id
          storyIds.set(`name:${key(row.epicName ?? '')}:${key(row.featureName ?? '')}:${key(row.name ?? '')}`, created.id)
        }
      }
      if (row.type === 'task') {
        const storyId = row.id
          ? tree.epics.flatMap(epic => epic.features.flatMap(feature => feature.userStories)).find(story => story.tasks.some(task => task.id === row.id))?.id
          : storyIds.get(`name:${key(row.epicName ?? '')}:${key(row.featureName ?? '')}:${key(row.storyName ?? '')}`)
        if (!storyId) throw new Error('Grid task parent was not resolved')
        const resourceTypeId = row.resourceTypeId ?? resourceTypes.find(resourceType => key(resourceType.name) === key(row.resourceTypeName ?? ''))!.id
        const hoursEffort = row.hoursEffort ?? 0
        const durationDays = row.durationDays ?? calcDurationDays(hoursEffort, hoursPerDay)
        if (row.id) await tx.task.update({ where: { id: row.id }, data: { name: text(row.name), description, assumptions, resourceTypeId, hoursEffort, durationDays } })
        else {
          const created = await tx.task.create({ data: { name: text(row.name), description, assumptions, resourceTypeId, hoursEffort, durationDays, userStoryId: storyId, order: taskOrder.get(storyId) ?? 0 } })
          committedId = created.id
        }
        taskOrder.set(storyId, (taskOrder.get(storyId) ?? 0) + 1)
      }
      rowIds[index] = committedId
    }
    await tx.project.update({ where: { id: projectId }, data: { weeklyDemandCache: {} } })
    return { snapshotId, rowIds }
  }, { timeout: 60000 })
  return result
}
