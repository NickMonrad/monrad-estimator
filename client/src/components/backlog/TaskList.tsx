import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useDroppable } from '@dnd-kit/core'
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { api } from '../../lib/api'
import type { Task, ResourceType } from '../../types/backlog'
import RichTextEditor from '../shared/RichTextEditor'

interface Props {
  storyId: string
  tasks: Task[]
  resourceTypes: ResourceType[]
  projectId: string
  hoursPerDay: number
}

function SortableTaskItem({ task, isEditing, onEdit, onCancelEdit, onSave, onDelete, isSaving, resourceTypes, hoursPerDay }: {
  task: Task
  isEditing: boolean
  onEdit: () => void
  onCancelEdit: () => void
  onSave: (data: { name: string; description: string; assumptions: string; hoursEffort: string; resourceTypeId: string; durationDays: string }) => void
  onDelete: () => void
  isSaving: boolean
  resourceTypes: ResourceType[]
  hoursPerDay: number
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: 'task-' + task.id })
  const style = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.4 : undefined }

  if (isEditing) {
    return (
      <div ref={setNodeRef} style={style} {...attributes} className="bg-white dark:bg-gray-800 border border-blue-200 dark:border-blue-800 rounded-lg px-3 py-2">
        <TaskForm
          initial={{ name: task.name, description: task.description ?? '', assumptions: task.assumptions ?? '', hoursEffort: String(task.hoursEffort), resourceTypeId: task.resourceTypeId ?? '', durationDays: task.durationDays != null ? String(task.durationDays) : '' }}
          resourceTypes={resourceTypes}
          hoursPerDay={hoursPerDay}
          onSave={onSave}
          onCancel={onCancelEdit}
          saving={isSaving}
        />
      </div>
    )
  }

  return (
    <div ref={setNodeRef} style={style} {...attributes} className="group flex items-start gap-2 bg-white dark:bg-gray-800 border border-gray-100 dark:border-gray-700 rounded-lg px-3 py-2 hover:border-gray-300 dark:hover:border-gray-500">
      <button {...listeners} className="cursor-grab active:cursor-grabbing text-gray-300 hover:text-gray-500 self-center shrink-0 px-0.5 text-base leading-none" onClick={e => e.stopPropagation()}>⠿</button>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs text-gray-500 dark:text-gray-400 bg-gray-100 dark:bg-gray-700 px-1.5 py-0.5 rounded">Task</span>
          <span className="text-sm text-gray-800 dark:text-gray-200">{task.name}</span>
          {task.resourceType
            ? <span className="text-xs text-blue-600 bg-blue-50 px-1.5 py-0.5 rounded">{task.resourceType.name}</span>
            : <span className="text-xs text-gray-400 dark:text-gray-500 bg-gray-100 dark:bg-gray-700 px-1.5 py-0.5 rounded italic">No resource type</span>
          }
          <span className="text-xs font-medium text-gray-700 dark:text-gray-300 ml-auto">
            {task.hoursEffort}h · {(task.hoursEffort / hoursPerDay).toFixed(1)}d{task.durationDays != null && <span className="text-gray-400 dark:text-gray-500 font-normal"> (dur: {task.durationDays}d)</span>}
          </span>
        </div>
        {task.description && <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5 ml-0 truncate">{task.description}</p>}
      </div>
      <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
        <button onClick={onEdit} className="text-xs text-gray-400 dark:text-gray-500 hover:text-gray-700 px-1">Edit</button>
        <button onClick={onDelete} className="text-xs text-red-400 hover:text-red-600 px-1">Delete</button>
      </div>
    </div>
  )
}

export default function TaskList({ storyId, tasks, resourceTypes, projectId, hoursPerDay }: Props) {
  const qc = useQueryClient()
  const [adding, setAdding] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState({ name: '', description: '', assumptions: '', hoursEffort: '0', resourceTypeId: '', durationDays: '' })

  const { setNodeRef } = useDroppable({ id: 'story-container-' + storyId })

  const invalidate = () => qc.invalidateQueries({ queryKey: ['backlog', projectId] })

  const createTask = useMutation({
    mutationFn: (data: typeof form) =>
      api.post(`/stories/${storyId}/tasks`, { ...data, hoursEffort: parseFloat(data.hoursEffort), durationDays: data.durationDays ? parseFloat(data.durationDays) : null }),
    onSuccess: () => { invalidate(); setAdding(false); setForm({ name: '', description: '', assumptions: '', hoursEffort: '0', resourceTypeId: '', durationDays: '' }) },
  })

  const updateTask = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Partial<typeof form> }) =>
      api.put(`/stories/${storyId}/tasks/${id}`, { ...data, hoursEffort: data.hoursEffort ? parseFloat(data.hoursEffort) : undefined, durationDays: data.durationDays !== undefined ? (data.durationDays ? parseFloat(data.durationDays) : null) : undefined }),
    onSuccess: () => { invalidate(); setEditingId(null) },
  })

  const deleteTask = useMutation({
    mutationFn: (id: string) => api.delete(`/stories/${storyId}/tasks/${id}`),
    onSuccess: invalidate,
  })

  return (
    <div ref={setNodeRef} className="ml-6 mt-1 space-y-1">
      <SortableContext items={tasks.map(t => 'task-' + t.id)} strategy={verticalListSortingStrategy}>
        {tasks.map(task => (
          <SortableTaskItem
            key={task.id}
            task={task}
            isEditing={editingId === task.id}
            onEdit={() => setEditingId(task.id)}
            onCancelEdit={() => setEditingId(null)}
            onSave={(data) => updateTask.mutate({ id: task.id, data })}
            onDelete={() => deleteTask.mutate(task.id)}
            isSaving={updateTask.isPending}
            resourceTypes={resourceTypes}
            hoursPerDay={hoursPerDay}
          />
        ))}
      </SortableContext>

      {adding ? (
        <div className="bg-white dark:bg-gray-800 border border-blue-200 dark:border-blue-800 rounded-lg px-3 py-2">
          <TaskForm
            initial={form}
            resourceTypes={resourceTypes}
            hoursPerDay={hoursPerDay}
            onSave={(data) => createTask.mutate(data)}
            onCancel={() => setAdding(false)}
            saving={createTask.isPending}
          />
        </div>
      ) : (
        <button onClick={() => setAdding(true)} className="text-xs text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-400 flex items-center gap-1 py-1 pl-1">
          + Add task
        </button>
      )}
    </div>
  )
}

function TaskForm({ initial, resourceTypes, hoursPerDay, onSave, onCancel, saving }: {
  initial: { name: string; description: string; assumptions: string; hoursEffort: string; resourceTypeId: string; durationDays: string }
  resourceTypes: ResourceType[]
  hoursPerDay: number
  onSave: (data: typeof initial) => void
  onCancel: () => void
  saving: boolean
}) {
  const [form, setForm] = useState(initial)
  const [days, setDays] = useState(
    initial.hoursEffort && parseFloat(initial.hoursEffort) > 0
      ? String(parseFloat((parseFloat(initial.hoursEffort) / hoursPerDay).toFixed(2)))
      : ''
  )

  const f = (field: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm(v => ({ ...v, [field]: e.target.value }))

  const onHoursChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const h = e.target.value
    setForm(v => ({ ...v, hoursEffort: h }))
    const parsed = parseFloat(h)
    setDays(!isNaN(parsed) && parsed > 0 ? String(parseFloat((parsed / hoursPerDay).toFixed(2))) : '')
  }

  const onDaysChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const d = e.target.value
    setDays(d)
    const parsed = parseFloat(d)
    setForm(v => ({ ...v, hoursEffort: !isNaN(parsed) && parsed > 0 ? String(parseFloat((parsed * hoursPerDay).toFixed(2))) : '' }))
  }

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-2">
        <input placeholder="Task name *" value={form.name} onChange={f('name')} className="col-span-2 border border-gray-200 dark:border-gray-600 rounded px-2 py-1 text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-400 focus:outline-none focus:ring-1 focus:ring-blue-400" />
        <select value={form.resourceTypeId} onChange={f('resourceTypeId')} className="col-span-2 border border-gray-200 dark:border-gray-600 rounded px-2 py-1 text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:outline-none focus:ring-1 focus:ring-blue-400">
          <option value="">Resource type *</option>
          {resourceTypes.map(rt => <option key={rt.id} value={rt.id}>{rt.name}</option>)}
        </select>
        <div>
          <label className="block text-xs text-gray-500 dark:text-gray-400 mb-0.5">Hours</label>
          <input type="number" placeholder="0" min="0" step="0.5" value={form.hoursEffort} onChange={onHoursChange} className="w-full border border-gray-200 dark:border-gray-600 rounded px-2 py-1 text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:outline-none focus:ring-1 focus:ring-blue-400" />
        </div>
        <div>
          <label className="block text-xs text-gray-500 dark:text-gray-400 mb-0.5">Days (@ {hoursPerDay}h)</label>
          <input type="number" placeholder="0" min="0" step="0.1" value={days} onChange={onDaysChange} className="w-full border border-gray-200 dark:border-gray-600 rounded px-2 py-1 text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:outline-none focus:ring-1 focus:ring-blue-400" />
        </div>
        <div className="col-span-2">
          <RichTextEditor
            value={form.description}
            onChange={v => setForm(prev => ({ ...prev, description: v }))}
            placeholder="Description"
            className="text-sm"
          />
        </div>
        <div className="col-span-2">
          <RichTextEditor
            value={form.assumptions}
            onChange={v => setForm(prev => ({ ...prev, assumptions: v }))}
            placeholder="Assumptions"
            className="text-sm"
          />
        </div>
        <div className="col-span-2">
          <label className="block text-xs text-gray-400 dark:text-gray-500 mb-0.5">Duration override (days) — optional</label>
          <input type="number" placeholder="Leave blank to use hours/day rate" min="0" step="0.5" value={form.durationDays} onChange={f('durationDays')} className="w-full border border-gray-200 dark:border-gray-600 rounded px-2 py-1 text-xs text-gray-600 dark:text-gray-400 bg-white dark:bg-gray-700 focus:outline-none focus:ring-1 focus:ring-blue-400" />
        </div>
      </div>
      <div className="flex gap-2">
        <button onClick={() => onSave(form)} disabled={!form.name || !form.resourceTypeId || saving}
          className="bg-lab3-navy text-white px-3 py-1 rounded text-xs font-medium hover:bg-lab3-blue disabled:opacity-50">
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button onClick={onCancel} className="px-3 py-1 rounded text-xs text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700">Cancel</button>
      </div>
    </div>
  )
}
