import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../../lib/api'
import type { UserStory, ResourceType } from '../../types/backlog'
import TaskList from './TaskList'

interface Props {
  featureId: string
  stories: UserStory[]
  resourceTypes: ResourceType[]
  projectId: string
  hoursPerDay: number
}

export default function StoryList({ featureId, stories, resourceTypes, projectId, hoursPerDay }: Props) {
  const qc = useQueryClient()
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set())
  const [adding, setAdding] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState({ name: '', description: '', assumptions: '' })

  const invalidate = () => qc.invalidateQueries({ queryKey: ['backlog', projectId] })

  const createStory = useMutation({
    mutationFn: (data: typeof form) => api.post(`/features/${featureId}/stories`, data),
    onSuccess: (res) => { invalidate(); setAdding(false); setForm({ name: '', description: '', assumptions: '' }); setExpandedIds(s => { const n = new Set(s); n.add(res.data.id); return n }) },
  })

  const updateStory = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Partial<typeof form> }) =>
      api.put(`/features/${featureId}/stories/${id}`, data),
    onSuccess: () => { invalidate(); setEditingId(null) },
  })

  const deleteStory = useMutation({
    mutationFn: (id: string) => api.delete(`/features/${featureId}/stories/${id}`),
    onSuccess: invalidate,
  })

  const refreshFromTemplate = useMutation({
    mutationFn: ({ storyId, complexity }: { storyId: string; complexity: string }) =>
      api.post(`/features/${featureId}/refresh-template/${storyId}`, { complexity }),
    onSuccess: (res, { storyId }) => {
      invalidate()
      const added = res.data.added as number
      setRefreshMsg(added > 0 ? `Added ${added} new task${added !== 1 ? 's' : ''}` : 'Already up to date')
      setRefreshingId(null)
    },
  })

  const [refreshingId, setRefreshingId] = useState<string | null>(null)
  const [refreshMsg, setRefreshMsg] = useState<string | null>(null)

  const toggle = (id: string) =>
    setExpandedIds(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n })

  const totalHours = (story: UserStory) => story.tasks.reduce((s, t) => s + t.hoursEffort, 0)

  return (
    <div className="ml-4 mt-1 space-y-1">
      {stories.map(story => (
        <div key={story.id}>
          {editingId === story.id ? (
            <InlineForm
              label="Story"
              initial={{ name: story.name, description: story.description ?? '', assumptions: story.assumptions ?? '' }}
              onSave={(data) => updateStory.mutate({ id: story.id, data })}
              onCancel={() => setEditingId(null)}
              saving={updateStory.isPending}
            />
          ) : (
            <div className="group flex items-center gap-2 bg-purple-50 border border-purple-100 rounded-lg px-3 py-2 hover:border-purple-300 cursor-pointer"
              onClick={() => toggle(story.id)}>
              <span className="text-purple-500 text-xs select-none">{expandedIds.has(story.id) ? '▼' : '▶'}</span>
              <span className="text-xs text-purple-500 bg-purple-100 px-1.5 py-0.5 rounded">Story</span>
              <span className="text-sm text-gray-800 flex-1 truncate">{story.name}</span>
              <span className="text-xs text-gray-400">{story.tasks.length} task{story.tasks.length !== 1 ? 's' : ''} · {totalHours(story)}h</span>
              <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity" onClick={e => e.stopPropagation()}>
                <button onClick={() => setEditingId(story.id)} className="text-xs text-gray-400 hover:text-gray-700 px-1">Edit</button>
                {story.appliedTemplateId && (
                  <button onClick={() => setRefreshingId(story.id)} title="Refresh from template" className="text-xs text-blue-400 hover:text-blue-600 px-1">↺ Refresh</button>
                )}
                <button onClick={() => deleteStory.mutate(story.id)} className="text-xs text-red-400 hover:text-red-600 px-1">Delete</button>
              </div>
            </div>
          )}
          {expandedIds.has(story.id) && (
            <TaskList storyId={story.id} tasks={story.tasks} resourceTypes={resourceTypes} projectId={projectId} hoursPerDay={hoursPerDay} />
          )}
        </div>
      ))}

      {refreshingId && (
        <div className="bg-blue-50 border border-blue-200 rounded-lg px-3 py-2 text-xs text-blue-700 flex items-center gap-3">
          <span>Refresh complexity:</span>
          {(['SMALL', 'MEDIUM', 'LARGE', 'EXTRA_LARGE'] as const).map(c => (
            <button key={c} onClick={() => refreshFromTemplate.mutate({ storyId: refreshingId, complexity: c })}
              disabled={refreshFromTemplate.isPending}
              className="font-medium hover:text-blue-900 disabled:opacity-50">
              {c === 'EXTRA_LARGE' ? 'XL' : c[0]}
            </button>
          ))}
          <button onClick={() => setRefreshingId(null)} className="ml-auto text-gray-400 hover:text-gray-600">✕</button>
        </div>
      )}
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
          className="bg-red-600 text-white px-3 py-1 rounded text-xs font-medium hover:bg-red-700 disabled:opacity-50">
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button onClick={onCancel} className="px-3 py-1 rounded text-xs text-gray-500 hover:bg-gray-100">Cancel</button>
      </div>
    </div>
  )
}
