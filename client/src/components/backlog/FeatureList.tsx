import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../../lib/api'
import type { Feature, ResourceType } from '../../types/backlog'
import StoryList from './StoryList'
import ApplyTemplateModal from './ApplyTemplateModal'

interface Props {
  epicId: string
  features: Feature[]
  resourceTypes: ResourceType[]
  projectId: string
}

export default function FeatureList({ epicId, features, resourceTypes, projectId }: Props) {
  const qc = useQueryClient()
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set())
  const [adding, setAdding] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState({ name: '', description: '', assumptions: '' })
  const [applyTemplateFeatureId, setApplyTemplateFeatureId] = useState<string | null>(null)

  const invalidate = () => qc.invalidateQueries({ queryKey: ['backlog', projectId] })

  const createFeature = useMutation({
    mutationFn: (data: typeof form) => api.post(`/epics/${epicId}/features`, data),
    onSuccess: () => { invalidate(); setAdding(false); setForm({ name: '', description: '', assumptions: '' }) },
  })

  const updateFeature = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Partial<typeof form> }) =>
      api.put(`/epics/${epicId}/features/${id}`, data),
    onSuccess: () => { invalidate(); setEditingId(null) },
  })

  const deleteFeature = useMutation({
    mutationFn: (id: string) => api.delete(`/epics/${epicId}/features/${id}`),
    onSuccess: invalidate,
  })

  const toggle = (id: string) =>
    setExpandedIds(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n })

  const totalHours = (feature: Feature) =>
    feature.userStories.reduce((s, st) => s + st.tasks.reduce((a, t) => a + t.hoursEffort, 0), 0)

  return (
    <div className="ml-4 mt-1 space-y-1">
      {applyTemplateFeatureId && (
        <ApplyTemplateModal
          featureId={applyTemplateFeatureId}
          projectId={projectId}
          onClose={() => setApplyTemplateFeatureId(null)}
        />
      )}
      {features.map(feature => (
        <div key={feature.id}>
          {editingId === feature.id ? (
            <InlineForm
              label="Feature"
              initial={{ name: feature.name, description: feature.description ?? '', assumptions: feature.assumptions ?? '' }}
              onSave={(data) => updateFeature.mutate({ id: feature.id, data })}
              onCancel={() => setEditingId(null)}
              saving={updateFeature.isPending}
            />
          ) : (
            <div className="group flex items-center gap-2 bg-blue-50 border border-blue-100 rounded-lg px-3 py-2 hover:border-blue-300 cursor-pointer"
              onClick={() => toggle(feature.id)}>
              <span className="text-blue-500 text-xs select-none">{expandedIds.has(feature.id) ? '▼' : '▶'}</span>
              <span className="text-xs text-blue-500 bg-blue-100 px-1.5 py-0.5 rounded">Feature</span>
              <span className="text-sm text-gray-800 flex-1 truncate">{feature.name}</span>
              <span className="text-xs text-gray-400">{feature.userStories.length} stor{feature.userStories.length !== 1 ? 'ies' : 'y'} · {totalHours(feature)}h</span>
              <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity" onClick={e => e.stopPropagation()}>
                <button onClick={() => setApplyTemplateFeatureId(feature.id)} className="text-xs text-purple-400 hover:text-purple-600 px-1">Template</button>
                <button onClick={() => setEditingId(feature.id)} className="text-xs text-gray-400 hover:text-gray-700 px-1">Edit</button>
                <button onClick={() => deleteFeature.mutate(feature.id)} className="text-xs text-red-400 hover:text-red-600 px-1">Delete</button>
              </div>
            </div>
          )}
          {expandedIds.has(feature.id) && (
            <StoryList featureId={feature.id} stories={feature.userStories} resourceTypes={resourceTypes} projectId={projectId} />
          )}
        </div>
      ))}

      {adding ? (
        <InlineForm
          label="Feature"
          initial={form}
          onSave={(data) => createFeature.mutate(data)}
          onCancel={() => setAdding(false)}
          saving={createFeature.isPending}
        />
      ) : (
        <button onClick={() => setAdding(true)} className="text-xs text-gray-400 hover:text-gray-600 flex items-center gap-1 py-1 pl-1 ml-2">
          + Add feature
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
