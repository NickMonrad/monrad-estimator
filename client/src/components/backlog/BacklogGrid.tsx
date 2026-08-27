import { useEffect, useMemo, useRef, useState } from 'react'
import type { ClipboardEvent, KeyboardEvent, MutableRefObject } from 'react'
import RichTextEditor from '../shared/RichTextEditor'
import { api, apiErrorMessage } from '../../lib/api'
import type { Epic, ResourceType } from '../../types/backlog'

type RowType = 'epic' | 'feature' | 'story' | 'task'
type RichTextField = 'description' | 'assumptions'

interface GridRow {
  key: string
  id?: string
  type: RowType
  epicId?: string
  featureId?: string
  storyId?: string
  epicName: string
  featureName: string
  storyName: string
  name: string
  isActive: boolean
  resourceTypeId: string
  resourceTypeName: string
  hoursEffort: string
  durationDays: string
  description: string
  assumptions: string
}

interface FieldError { row: number; field: string; message: string }

interface Props {
  projectId: string
  epics: Epic[]
  resourceTypes: ResourceType[]
  onCommitted: () => void | Promise<void>
  onExit: () => void
}

const editableFields = ['epicName', 'featureName', 'storyName', 'name', 'isActive', 'resourceTypeName', 'hoursEffort', 'durationDays'] as const
type EditableField = typeof editableFields[number]
function rowEditableFields(row: GridRow): EditableField[] {
  const fields: EditableField[] = []
  if (row.type !== 'epic') fields.push('epicName')
  if (row.type === 'story' || row.type === 'task') fields.push('featureName')
  if (row.type === 'task') fields.push('storyName')
  fields.push('name')
  if (row.type !== 'task') fields.push('isActive')
  if (row.type === 'task') fields.push('resourceTypeName', 'hoursEffort', 'durationDays')
  return fields
}


function flatten(epics: Epic[]): GridRow[] {
  const rows: GridRow[] = []
  for (const epic of epics) {
    rows.push({ key: `epic-${epic.id}`, id: epic.id, type: 'epic', epicId: epic.id, epicName: epic.name, featureName: '', storyName: '', name: epic.name, isActive: epic.isActive !== false, resourceTypeId: '', resourceTypeName: '', hoursEffort: '', durationDays: '', description: epic.description ?? '', assumptions: epic.assumptions ?? '' })
    for (const feature of epic.features) {
      rows.push({ key: `feature-${feature.id}`, id: feature.id, type: 'feature', epicId: epic.id, epicName: epic.name, featureId: feature.id, featureName: feature.name, storyName: '', name: feature.name, isActive: feature.isActive !== false, resourceTypeId: '', resourceTypeName: '', hoursEffort: '', durationDays: '', description: feature.description ?? '', assumptions: feature.assumptions ?? '' })
      for (const story of feature.userStories) {
        rows.push({ key: `story-${story.id}`, id: story.id, type: 'story', epicId: epic.id, epicName: epic.name, featureId: feature.id, featureName: feature.name, storyId: story.id, storyName: story.name, name: story.name, isActive: story.isActive !== false, resourceTypeId: '', resourceTypeName: '', hoursEffort: '', durationDays: '', description: story.description ?? '', assumptions: story.assumptions ?? '' })
        for (const task of story.tasks) rows.push({ key: `task-${task.id}`, id: task.id, type: 'task', epicId: epic.id, featureId: feature.id, storyId: story.id, epicName: epic.name, featureName: feature.name, storyName: story.name, name: task.name, isActive: true, resourceTypeId: task.resourceTypeId ?? '', resourceTypeName: task.resourceType?.name ?? '', hoursEffort: String(task.hoursEffort), durationDays: task.durationDays == null ? '' : String(task.durationDays), description: task.description ?? '', assumptions: task.assumptions ?? '' })
      }
    }
  }
  return rows
}

function blankRow(type: RowType): GridRow {
  return { key: `new-${Date.now()}-${Math.random()}`, type, epicName: '', featureName: '', storyName: '', name: '', isActive: true, resourceTypeId: '', resourceTypeName: '', hoursEffort: type === 'task' ? '0' : '', durationDays: '', description: '', assumptions: '' }
}

function clientErrors(rows: GridRow[], resourceTypes: ResourceType[]): FieldError[] {
  const errors: FieldError[] = []
  const seen = new Set<string>()
  rows.forEach((row, index) => {
    if (!row.name.trim()) errors.push({ row: index, field: 'name', message: `${row.type} name is required` })
    if (row.type !== 'epic' && !row.epicName.trim()) errors.push({ row: index, field: 'epicName', message: 'Epic is required' })
    if ((row.type === 'story' || row.type === 'task') && !row.featureName.trim()) errors.push({ row: index, field: 'featureName', message: 'Feature is required' })
    if (row.type === 'task' && !row.storyName.trim()) errors.push({ row: index, field: 'storyName', message: 'Story is required' })
    const path = [row.type, row.epicName, row.featureName, row.storyName, row.name].map(value => value.trim().toLowerCase()).join('|')
    if (!row.id && seen.has(path)) errors.push({ row: index, field: 'name', message: 'Duplicate staged hierarchy path' })
    seen.add(path)
    if (row.type === 'task') {
      const resourceMatches = resourceTypes.filter(resource => resource.id === row.resourceTypeId || resource.name.toLowerCase() === row.resourceTypeName.trim().toLowerCase())
      if (resourceMatches.length !== 1) errors.push({ row: index, field: 'resourceTypeName', message: 'Select one existing project resource type' })
      const hours = Number(row.hoursEffort)
      if (!Number.isFinite(hours) || hours < 0) errors.push({ row: index, field: 'hoursEffort', message: 'Hours must be a non-negative number' })
      if (row.durationDays && (!Number.isFinite(Number(row.durationDays)) || Number(row.durationDays) <= 0)) errors.push({ row: index, field: 'durationDays', message: 'Duration must be a positive number' })
    }
  })
  return errors
}

export default function BacklogGrid({ projectId, epics, resourceTypes, onCommitted, onExit }: Props) {
  const [rows, setRows] = useState<GridRow[]>(() => flatten(epics))
  const [newType, setNewType] = useState<RowType>('epic')
  const [errors, setErrors] = useState<FieldError[]>([])
  const [serverError, setServerError] = useState<string | null>(null)
  const [status, setStatus] = useState<'idle' | 'saving' | 'success'>('idle')
  const [richText, setRichText] = useState<{ rowKey: string; field: RichTextField } | null>(null)
  const [richTextValue, setRichTextValue] = useState('')
  const cellRefs = useRef(new Map<string, HTMLElement>())
  const initialRows = useMemo(() => flatten(epics), [epics])
  const dirty = status !== 'success' && JSON.stringify(rows) !== JSON.stringify(initialRows)

  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!dirty) return
      event.preventDefault()
      event.returnValue = ''
    }
    const guardNavigation = (event: MouseEvent) => {
      if (!dirty) return
      const target = event.target as HTMLElement | null
      if (target?.closest('[aria-label="Grid Entry"]')) return
      if (!window.confirm('You have unsaved Grid Entry changes. Leave without saving?')) {
        event.preventDefault()
        event.stopImmediatePropagation()
      }
    }
    window.addEventListener('beforeunload', beforeUnload)
    window.addEventListener('click', guardNavigation, true)
    return () => {
      window.removeEventListener('beforeunload', beforeUnload)
      window.removeEventListener('click', guardNavigation, true)
    }
  }, [dirty])

  const updateRow = (rowKey: string, field: keyof GridRow, value: string | boolean) => {
    setStatus('idle')
    setRows(current => current.map(row => row.key === rowKey ? { ...row, [field]: value } : row))
    setServerError(null)
  }

  const focusCell = (rowIndex: number, field: EditableField, direction = 0) => {
    const step = direction < 0 ? -1 : 1
    let candidate = rowIndex
    while (candidate >= 0 && candidate < rows.length) {
      const cell = cellRefs.current.get(`${candidate}:${field}`)
      if (cell) {
        cell.focus()
        return
      }
      if (direction === 0) return
      candidate += step
    }
  }

  const moveCell = (event: KeyboardEvent<HTMLElement>, rowIndex: number, field: EditableField) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      focusCell(rowIndex + 1, field, 1)
      return
    }
    if ((event.key === 'ArrowUp' || event.key === 'ArrowDown') && event.currentTarget instanceof HTMLInputElement) {
      event.preventDefault()
      focusCell(rowIndex + (event.key === 'ArrowUp' ? -1 : 1), field, event.key === 'ArrowUp' ? -1 : 1)
      return
    }
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    const target = event.currentTarget
    if (target instanceof HTMLInputElement && target.selectionStart !== (event.key === 'ArrowLeft' ? 0 : target.value.length)) return
    const fields = rowEditableFields(rows[rowIndex])
    const nextIndex = fields.indexOf(field) + (event.key === 'ArrowLeft' ? -1 : 1)
    const nextField = fields[nextIndex]
    if (!nextField) return
    event.preventDefault()
    focusCell(rowIndex, nextField)
  }

  const paste = (event: ClipboardEvent<HTMLElement>, rowIndex: number, field: EditableField) => {
    const value = event.clipboardData.getData('text/plain')
    if (!value.includes('\t') && !value.includes('\n')) return
    event.preventDefault()
    const start = editableFields.indexOf(field)
    const pastedRows = value.replace(/\r/g, '').split('\n').filter(line => line.length > 0).map(line => line.split('\t'))
    setRows(current => {
      const next = [...current]
      pastedRows.forEach((pastedRow, pastedIndex) => {
        const targetIndex = rowIndex + pastedIndex
        if (!next[targetIndex]) next.push(blankRow(newType))
        pastedRow.forEach((cell, cellIndex) => {
          const targetField = editableFields[start + cellIndex]
          if (!targetField) return
          const target = next[targetIndex]
          if (target.id && ['epicName', 'featureName', 'storyName'].includes(targetField)) return
          if (targetField === 'isActive') target.isActive = !['false', 'inactive', '0', 'no'].includes(cell.trim().toLowerCase())
          else (target as unknown as Record<string, string | boolean>)[targetField] = cell
          if (targetField === 'resourceTypeName') target.resourceTypeId = resourceTypes.find(resource => resource.name.toLowerCase() === cell.trim().toLowerCase())?.id ?? ''
        })
      })
      return next
    })

    setStatus('idle')
    setServerError(null)
  }

  const openRichText = (row: GridRow, field: RichTextField) => {
    setRichText({ rowKey: row.key, field })
    setRichTextValue(row[field])
  }

  const saveRichText = () => {
    if (!richText) return
    updateRow(richText.rowKey, richText.field, richTextValue)
    setRichText(null)
  }

  const commit = async () => {
    const nextErrors = clientErrors(rows, resourceTypes)
    setErrors(nextErrors)
    setServerError(null)
    if (nextErrors.length > 0) return
    setStatus('saving')
    try {
      const response = await api.post(`/projects/${projectId}/backlog/grid-commit`, { rows: rows.map(row => ({ id: row.id, type: row.type, epicName: row.epicName, featureName: row.featureName, storyName: row.storyName, name: row.name, isActive: row.isActive, description: row.description, assumptions: row.assumptions, resourceTypeId: row.resourceTypeId || null, resourceTypeName: row.resourceTypeName, hoursEffort: row.type === 'task' ? Number(row.hoursEffort) : undefined, durationDays: row.type === 'task' && row.durationDays ? Number(row.durationDays) : undefined })) })
      const rowIds = response.data?.rowIds
      if (Array.isArray(rowIds)) setRows(current => current.map((row, index) => ({ ...row, id: typeof rowIds[index] === 'string' ? rowIds[index] : row.id })))
      await onCommitted()
      setStatus('success')
      setErrors([])
    } catch (error) {
      const responseErrors = (error as { response?: { data?: { fieldErrors?: FieldError[] } } }).response?.data?.fieldErrors
      setErrors(responseErrors ?? [])
      setServerError(apiErrorMessage(error, 'Grid commit failed; no changes were saved'))
      setStatus('idle')
    }
  }

  const exit = () => {
    if (dirty && !window.confirm('You have unsaved Grid Entry changes. Leave without saving?')) return
    onExit()
  }

  return (
    <section aria-label="Grid Entry" className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={exit} className="border border-gray-300 dark:border-gray-600 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-lab3-blue">← Tree view</button>
        <label className="text-sm text-gray-700 dark:text-gray-300" htmlFor="grid-new-type">New row type</label>
        <select id="grid-new-type" value={newType} onChange={event => setNewType(event.target.value as RowType)} className="border border-gray-300 dark:border-gray-600 rounded px-2 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-lab3-blue"><option value="epic">Epic</option><option value="feature">Feature</option><option value="story">Story</option><option value="task">Task</option></select>
        <button type="button" onClick={() => setRows(current => [...current, blankRow(newType)])} className="border border-gray-300 dark:border-gray-600 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-lab3-blue">+ Add row</button>
        <button type="button" onClick={commit} disabled={status === 'saving'} className="bg-lab3-navy text-white rounded px-4 py-2 text-sm font-medium disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-lab3-blue">{status === 'saving' ? 'Saving…' : 'Save Grid Entry'}</button>
        {dirty && <span className="text-sm text-amber-700 dark:text-amber-300" role="status">Unsaved changes</span>}
        {status === 'success' && <span className="text-sm text-green-700 dark:text-green-300" role="status">Saved</span>}
      </div>
      <p className="text-sm text-gray-500 dark:text-gray-400">Tab moves across cells, Enter moves down, and spreadsheet TSV paste adds rows when needed. Existing hierarchy context is read-only.</p>
      {serverError && <div role="alert" className="rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-200">{serverError}</div>}
      {errors.length > 0 && <div role="alert" className="rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-200"><p className="font-medium">Fix the highlighted grid errors before saving.</p><ul className="list-disc pl-5">{errors.map((error, index) => <li key={`${error.row}-${error.field}-${index}`}>Row {error.row + 1}, {error.field}: {error.message}</li>)}</ul></div>}
      <div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-700">
        <table className="min-w-[1180px] w-full text-sm border-collapse"><caption className="sr-only">Backlog Grid Entry</caption><thead className="bg-gray-50 dark:bg-gray-800 text-left text-gray-700 dark:text-gray-300"><tr>{['Type', 'Epic', 'Feature', 'Story', 'Name', 'Active', 'Resource Type', 'Hours', 'Duration days', 'Description', 'Assumptions'].map(header => <th key={header} scope="col" className="border-b border-gray-200 dark:border-gray-700 px-2 py-2 font-medium">{header}</th>)}</tr></thead><tbody>{rows.map((row, rowIndex) => <GridRowView key={row.key} row={row} rowIndex={rowIndex} resourceTypes={resourceTypes} errors={errors} cellRefs={cellRefs} updateRow={updateRow} onKeyDown={moveCell} onPaste={paste} onRichText={openRichText} />)}</tbody></table>
      </div>
      {rows.length === 0 && <p className="rounded border border-dashed border-gray-300 p-8 text-center text-gray-500">No backlog rows yet. Choose a type and add a row.</p>}
      {richText && <div role="dialog" aria-modal="true" aria-labelledby="grid-rich-text-title" className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"><div className="w-full max-w-2xl rounded-lg bg-white dark:bg-gray-800 p-4 shadow-xl"><h2 id="grid-rich-text-title" className="mb-3 text-lg font-semibold text-gray-900 dark:text-white">Edit {richText.field}</h2><RichTextEditor value={richTextValue} onChange={setRichTextValue} ariaLabel={`Edit ${richText.field}`} /><div className="mt-4 flex justify-end gap-2"><button type="button" onClick={() => setRichText(null)} className="rounded border border-gray-300 px-3 py-2 text-sm">Cancel</button><button type="button" onClick={saveRichText} className="rounded bg-lab3-navy px-3 py-2 text-sm text-white">Apply</button></div></div></div>}
    </section>
  )
}

function GridRowView({ row, rowIndex, resourceTypes, errors, cellRefs, updateRow, onKeyDown, onPaste, onRichText }: {
  row: GridRow
  rowIndex: number
  resourceTypes: ResourceType[]
  errors: FieldError[]
  cellRefs: MutableRefObject<Map<string, HTMLElement>>
  updateRow: (rowKey: string, field: keyof GridRow, value: string | boolean) => void
  onKeyDown: (event: KeyboardEvent<HTMLElement>, rowIndex: number, field: EditableField) => void
  onPaste: (event: ClipboardEvent<HTMLElement>, rowIndex: number, field: EditableField) => void
  onRichText: (row: GridRow, field: RichTextField) => void
}) {
  const hasError = (field: string) => errors.some(error => error.row === rowIndex && error.field === field)
  const inputClass = (field: string) => `w-full min-w-28 rounded border px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-lab3-blue dark:bg-gray-700 dark:text-white ${hasError(field) ? 'border-red-500' : 'border-gray-300 dark:border-gray-600'}`
  const register = (field: EditableField) => (element: HTMLElement | null) => { if (element) cellRefs.current.set(`${rowIndex}:${field}`, element) }
  const contextCell = (field: 'epicName' | 'featureName' | 'storyName', value: string) => <td className="border-b border-gray-100 dark:border-gray-700 px-1 py-1"><input ref={register(field)} aria-label={`Row ${rowIndex + 1} ${field}`} value={value} disabled={Boolean(row.id)} onChange={event => updateRow(row.key, field, event.target.value)} onKeyDown={event => onKeyDown(event, rowIndex, field)} onPaste={event => onPaste(event, rowIndex, field)} className={inputClass(field)} /></td>
  const editCell = (field: EditableField, value: string) => <td className="border-b border-gray-100 dark:border-gray-700 px-1 py-1"><input ref={register(field)} aria-label={`Row ${rowIndex + 1} ${field}`} value={value} onChange={event => updateRow(row.key, field, event.target.value)} onKeyDown={event => onKeyDown(event, rowIndex, field)} onPaste={event => onPaste(event, rowIndex, field)} className={inputClass(field)} /></td>
  return <tr className={hasError('name') ? 'bg-red-50/50 dark:bg-red-950/20' : ''}>
    <td className="border-b border-gray-100 dark:border-gray-700 px-2 py-1 font-medium capitalize">{row.type}</td>
    {row.type === 'epic' ? <td className="border-b border-gray-100 dark:border-gray-700 px-1 py-1">—</td> : contextCell('epicName', row.epicName)}
    {row.type === 'epic' || row.type === 'feature' ? <td className="border-b border-gray-100 dark:border-gray-700 px-1 py-1">—</td> : contextCell('featureName', row.featureName)}
    {row.type !== 'task' ? <td className="border-b border-gray-100 dark:border-gray-700 px-1 py-1">—</td> : contextCell('storyName', row.storyName)}
    {editCell('name', row.name)}
    <td className="border-b border-gray-100 dark:border-gray-700 px-1 py-1"><select ref={register('isActive')} aria-label={`Row ${rowIndex + 1} active`} value={row.isActive ? 'active' : 'inactive'} disabled={row.type === 'task'} onChange={event => updateRow(row.key, 'isActive', event.target.value === 'active')} onKeyDown={event => onKeyDown(event, rowIndex, 'isActive')} onPaste={event => onPaste(event, rowIndex, 'isActive')} className={inputClass('isActive')}><option value="active">Active</option><option value="inactive">Inactive</option></select></td>
    {row.type === 'task' ? <td className="border-b border-gray-100 dark:border-gray-700 px-1 py-1"><select ref={register('resourceTypeName')} aria-label={`Row ${rowIndex + 1} resource type`} value={row.resourceTypeId} onChange={event => { const resource = resourceTypes.find(item => item.id === event.target.value); updateRow(row.key, 'resourceTypeId', event.target.value); updateRow(row.key, 'resourceTypeName', resource?.name ?? '') }} onKeyDown={event => onKeyDown(event, rowIndex, 'resourceTypeName')} onPaste={event => onPaste(event, rowIndex, 'resourceTypeName')} className={inputClass('resourceTypeName')}><option value="">Select resource type</option>{resourceTypes.map(resource => <option key={resource.id} value={resource.id}>{resource.name}</option>)}</select></td> : <td className="border-b border-gray-100 dark:border-gray-700 px-1 py-1">—</td>}
    {row.type === 'task' ? editCell('hoursEffort', row.hoursEffort) : <td className="border-b border-gray-100 dark:border-gray-700 px-1 py-1">—</td>}
    {row.type === 'task' ? editCell('durationDays', row.durationDays) : <td className="border-b border-gray-100 dark:border-gray-700 px-1 py-1">—</td>}
    <td className="border-b border-gray-100 dark:border-gray-700 px-1 py-1"><button type="button" onClick={() => onRichText(row, 'description')} className="rounded border border-gray-300 px-2 py-1 text-left text-xs focus:outline-none focus:ring-2 focus:ring-lab3-blue">{row.description ? 'Edit description' : 'Add description'}</button></td>
    <td className="border-b border-gray-100 dark:border-gray-700 px-1 py-1"><button type="button" onClick={() => onRichText(row, 'assumptions')} className="rounded border border-gray-300 px-2 py-1 text-left text-xs focus:outline-none focus:ring-2 focus:ring-lab3-blue">{row.assumptions ? 'Edit assumptions' : 'Add assumptions'}</button></td>
  </tr>
}
