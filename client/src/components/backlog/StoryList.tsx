import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useDroppable } from '@dnd-kit/core'
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { api } from '../../lib/api'
import type { UserStory, ResourceType } from '../../types/backlog'
import type { EpicColour } from '../../lib/epicColours'
import TaskList from './TaskList'

interface Props {
  featureId: string
  stories: UserStory[]
  resourceTypes: ResourceType[]
  projectId: string
  hoursPerDay: number
  epicColour?: EpicColour
}

function SortableStoryItem({ story, isEditing, expanded, onToggle, onEdit, onCancelEdit, onSave, onDelete, onToggleActive, isSaving, onRefresh, isRefreshing, onRefreshSelect, onCancelRefresh, refreshPending, resourceTypes, projectId, hoursPerDay, epicColour }: {
  story: UserStory
  isEditing: boolean
  expanded: boolean
  onToggle: () => void
  onEdit: () => void
  onCancelEdit: () => void
  onSave: (data: { name: string; description: string; assumptions: string }) => void
  onDelete: () => void
  onToggleActive: () => void
  isSaving: boolean
  onRefresh: () => void
  isRefreshing: boolean
  onRefreshSelect: (complexity: string) => void
  onCancelRefresh: () => void
  refreshPending: boolean
  resourceTypes: ResourceType[]
  projectId: string
  hoursPerDay: number
  epicColour?: EpicColour
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: 'story-' + story.id })
  const style = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.4 : undefined }
  const totalHours = story.tasks.reduce((s, t) => s + t.hoursEffort, 0)

  return (
    <div ref={setNodeRef} style={style} {...attributes}>
      {isEditing ? (
        <InlineForm
          label="Story"
          initial={{ name: story.name, description: story.description ?? '', assumptions: story.assumptions ?? '' }}
          onSave={onSave}
          onCancel={onCancelEdit}
          saving={isSaving}
        />
      ) : (
        <div className={`group flex items-center gap-2 bg-purple-50 border border-purple-100 rounded-lg px-3 py-2 hover:border-purple-300 cursor-pointer border-l ${epicColour?.border ?? 'border-l-purple-100'}`}
          onClick={onToggle}>
          <button {...listeners} className="cursor-grab active:cursor-grabbing text-purple-300 hover:text-purple-500 shrink-0 px-0.5 text-base leading-none" onClick={e => e.stopPropagation()}>⠿</button>
          <span className="text-purple-500 text-xs select-none">{expanded ? '▼' : '▶'}</span>
          <span className="text-xs text-purple-500 bg-purple-100 px-1.5 py-0.5 rounded">Story</span>
          <span className={`text-sm flex-1 truncate ${story.isActive === false ? 'line-through text-gray-400' : 'text-gray-800'}`}>{story.name}</span>
          <span className="text-xs text-gray-400">{story.tasks.length} task{story.tasks.length !== 1 ? 's' : ''} · {totalHours.toFixed(2)}h · {(totalHours / hoursPerDay).toFixed(1)}d</span>
          {story.appliedTemplateId && (
            <button onClick={e => { e.stopPropagation(); onRefresh() }} title="Refresh tasks from template"
              className="text-xs text-blue-500 hover:text-blue-700 bg-blue-50 hover:bg-blue-100 border border-blue-200 px-2 py-0.5 rounded transition-colors">
              ↺ Refresh
            </button>
          )}
          <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity" onClick={e => e.stopPropagation()}>
            <button onClick={onToggleActive} title={story.isActive === false ? 'Mark in scope' : 'Mark out of scope'} className={`text-xs px-1 ${story.isActive === false ? 'text-gray-300 hover:text-gray-500' : 'text-gray-400 hover:text-gray-600'}`}>{story.isActive === false ? '○' : '●'}</button>
            <button onClick={onEdit} className="text-xs text-gray-400 hover:text-gray-700 px-1">Edit</button>
            <button onClick={onDelete} className="text-xs text-red-400 hover:text-red-600 px-1">Delete</button>
          </div>
        </div>
      )}
      {isRefreshing && (
        <div className="bg-blue-50 border border-blue-200 rounded-lg px-3 py-2 text-xs text-blue-700 flex items-center gap-3">
          <span>Refresh complexity:</span>
          {(['EXTRA_SMALL', 'SMALL', 'MEDIUM', 'LARGE', 'EXTRA_LARGE'] as const).map(c => (
            <button key={c} onClick={() => onRefreshSelect(c)}
              disabled={refreshPending}
              className="font-medium hover:text-blue-900 disabled:opacity-50">
              {c === 'EXTRA_SMALL' ? 'XS' : c === 'EXTRA_LARGE' ? 'XL' : c[0]}
            </button>
          ))}
          <button onClick={onCancelRefresh} className="ml-auto text-gray-400 hover:text-gray-600">✕</button>
        </div>
      )}
      {expanded && (
        <TaskList storyId={story.id} tasks={story.tasks} resourceTypes={resourceTypes} projectId={projectId} hoursPerDay={hoursPerDay} />
      )}
    </div>
  )
}

export default function StoryList({ featureId, stories, resourceTypes, projectId, hoursPerDay, epicColour }: Props) {
  const qc = useQueryClient()
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set())
  const [adding, setAdding] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState({ name: '', description: '', assumptions: '' })

  const { setNodeRef } = useDroppable({ id: 'feature-container-' + featureId })

  const invalidate = () => qc.invalidateQueries({ queryKey: ['backlog', projectId] })

  const createStory = useMutation({
    mutationFn: (data: typeof form) => api.post(`/features/${featureId}/stories`, data),
    onSuccess: (res) => { invalidate(); setAdding(false); setForm({ name: '', description: '', assumptions: '' }); setExpandedIds(s => { const n = new Set(s); n.add(res.data.id); return n }) },
  })

  const updateStory = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Record<string, unknown> }) =>
      api.put(`/features/${featureId}/stories/${id}`, data),
    onSuccess: () => { invalidate(); setEditingId(null) },
  })

  const toggleStoryActive = useMutation({
    mutationFn: ({ id, isActive }: { id: string; isActive: boolean }) =>
      api.put(`/features/${featureId}/stories/${id}`, { isActive }),
    onSuccess: invalidate,
  })

  const deleteStory = useMutation({
    mutationFn: (id: string) => api.delete(`/features/${featureId}/stories/${id}`),
    onSuccess: invalidate,
  })

  const refreshFromTemplate = useMutation({
    mutationFn: ({ storyId, complexity }: { storyId: string; complexity: string }) =>
      api.post(`/features/${featureId}/refresh-template/${storyId}`, { complexity }),
    onSuccess: (res) => {
      invalidate()
      const added = res.data.added as number
      const updated = res.data.updated as number
      const parts = []
      if (added > 0) parts.push(`Added ${added} new task${added !== 1 ? 's' : ''}`)
      if (updated > 0) parts.push(`Updated ${updated} task${updated !== 1 ? 's' : ''}`)
      setRefreshMsg(parts.length > 0 ? parts.join(', ') : 'Already up to date')
      setRefreshingId(null)
    },
  })

  const [refreshingId, setRefreshingId] = useState<string | null>(null)
  const [refreshMsg, setRefreshMsg] = useState<string | null>(null)

  const toggle = (id: string) =>
    setExpandedIds(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n })

  return (
    <div ref={setNodeRef} className="ml-4 mt-1 space-y-1">
      <SortableContext items={stories.map(s => 'story-' + s.id)} strategy={verticalListSortingStrategy}>
        {stories.map(story => (
          <SortableStoryItem
            key={story.id}
            story={story}
            isEditing={editingId === story.id}
            expanded={expandedIds.has(story.id)}
            onToggle={() => toggle(story.id)}
            onEdit={() => setEditingId(story.id)}
            onCancelEdit={() => setEditingId(null)}
            onSave={(data) => updateStory.mutate({ id: story.id, data })}
            onDelete={() => deleteStory.mutate(story.id)}
            onToggleActive={() => toggleStoryActive.mutate({ id: story.id, isActive: story.isActive !== false ? false : true })}
            isSaving={updateStory.isPending}
            onRefresh={() => setRefreshingId(story.id)}
            isRefreshing={refreshingId === story.id}
            onRefreshSelect={(complexity) => refreshFromTemplate.mutate({ storyId: story.id, complexity })}
            onCancelRefresh={() => setRefreshingId(null)}
            refreshPending={refreshFromTemplate.isPending}
            resourceTypes={resourceTypes}
            projectId={projectId}
            hoursPerDay={hoursPerDay}
            epicColour={epicColour}
          />
        ))}
      </SortableContext>

      {refreshMsg && (
        <div className="text-xs text-green-600 py-1 pl-2">{refreshMsg}
          <button onClick={() => setRefreshMsg(null)} className="ml-2 text-gray-400">✕</button>
        </div>
      )}

      {adding ? (
        <InlineForm
          label="Story"
          initial={form}
          onSave={(data) => createStory.mutate(data)}
          onCancel={() => setAdding(false)}
          saving={createStory.isPending}
        />
      ) : (
        <button onClick={() => setAdding(true)} className="text-xs text-gray-400 hover:text-gray-600 flex items-center gap-1 py-1 pl-1 ml-2">
          + Add user story
        </button>
      )}
    </div>
  )
}

function InlineForm({ label, initial, onSave, onCancel, saving }: {
  label: string
  initial: { name: string; description: string; assumptions: string }
  onSave: (data: typeof initial) => void
  onCancel: () => void
  saving: boolean
}) {
  const [form, setForm] = useState(initial)
  const f = (field: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setForm(v => ({ ...v, [field]: e.target.value }))

  return (
    <div className="bg-white border border-blue-200 rounded-lg px-3 py-2 space-y-2">
      <input placeholder={`${label} name *`} value={form.name} onChange={f('name')}
        className="w-full border border-gray-200 rounded px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-blue-400" />
      <textarea placeholder="Description" value={form.description} onChange={f('description')} rows={1}
        className="w-full border border-gray-200 rounded px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-blue-400" />
      <textarea placeholder="Assumptions" value={form.assumptions} onChange={f('assumptions')} rows={1}
        className="w-full border border-gray-200 rounded px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-blue-400" />
      <div className="flex gap-2">
        <button onClick={() => onSave(form)} disabled={!form.name || saving}
          className="bg-lab3-navy text-white px-3 py-1 rounded text-xs font-medium hover:bg-lab3-blue disabled:opacity-50">
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button onClick={onCancel} className="px-3 py-1 rounded text-xs text-gray-500 hover:bg-gray-100">Cancel</button>
      </div>
    </div>
  )
}
