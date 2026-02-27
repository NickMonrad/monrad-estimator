import { useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/api'
import { useAuth } from '../hooks/useAuth'
import type { Epic, ResourceType } from '../types/backlog'
import FeatureList from '../components/backlog/FeatureList'

export default function BacklogPage() {
  const { id: projectId } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { user, logout } = useAuth()
  const qc = useQueryClient()

  const [expandedEpics, setExpandedEpics] = useState<Set<string>>(new Set())
  const [addingEpic, setAddingEpic] = useState(false)
  const [editingEpicId, setEditingEpicId] = useState<string | null>(null)
  const [epicForm, setEpicForm] = useState({ name: '', description: '' })

  const { data: project } = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => api.get(`/projects/${projectId}`).then(r => r.data),
  })

  const { data: epics = [], isLoading } = useQuery<Epic[]>({
    queryKey: ['backlog', projectId],
    queryFn: () => api.get(`/projects/${projectId}/epics`).then(r => r.data),
  })

  const { data: resourceTypes = [] } = useQuery<ResourceType[]>({
    queryKey: ['resource-types', projectId],
    queryFn: () => api.get(`/projects/${projectId}/resource-types`).then(r => r.data),
  })

  const invalidate = () => qc.invalidateQueries({ queryKey: ['backlog', projectId] })

  const createEpic = useMutation({
    mutationFn: (data: typeof epicForm) => api.post(`/projects/${projectId}/epics`, data),
    onSuccess: () => { invalidate(); setAddingEpic(false); setEpicForm({ name: '', description: '' }) },
  })

  const updateEpic = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Partial<typeof epicForm> }) =>
      api.put(`/projects/${projectId}/epics/${id}`, data),
    onSuccess: () => { invalidate(); setEditingEpicId(null) },
  })

  const deleteEpic = useMutation({
    mutationFn: (id: string) => api.delete(`/projects/${projectId}/epics/${id}`),
    onSuccess: invalidate,
  })

  const toggle = (id: string) =>
    setExpandedEpics(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n })

  const epicTotalHours = (epic: Epic) =>
    epic.features.reduce((s, f) =>
      s + f.userStories.reduce((ss, st) =>
        ss + st.tasks.reduce((a, t) => a + t.hoursEffort, 0), 0), 0)

  const grandTotal = epics.reduce((s, e) => s + epicTotalHours(e), 0)

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white border-b border-gray-200">
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm text-gray-500">
            <button onClick={() => navigate('/')} className="hover:text-red-600 transition-colors font-semibold text-gray-900">Monrad Estimator</button>
            <span>/</span>
            <button onClick={() => navigate(`/projects/${projectId}`)} className="hover:text-red-600 transition-colors">{project?.name ?? '…'}</button>
            <span>/</span>
            <span className="text-gray-700">Backlog</span>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-sm text-gray-500">{user?.name}</span>
            <button onClick={logout} className="text-sm text-gray-500 hover:text-gray-700">Sign out</button>
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-6 py-8">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h1 className="text-xl font-semibold text-gray-900">Backlog</h1>
            {epics.length > 0 && (
              <p className="text-sm text-gray-500 mt-0.5">
                {epics.length} epic{epics.length !== 1 ? 's' : ''} · {grandTotal}h total ({(grandTotal / 8).toFixed(1)} days)
              </p>
            )}
          </div>
          <button onClick={() => setAddingEpic(true)}
            className="bg-red-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-red-700 transition-colors">
            + Add epic
          </button>
        </div>

        {isLoading ? (
          <div className="text-center py-12 text-gray-400">Loading…</div>
        ) : (
          <div className="space-y-2">
            {epics.map(epic => (
              <div key={epic.id} className="bg-white rounded-xl border border-gray-200 overflow-hidden">
                {editingEpicId === epic.id ? (
                  <div className="p-3">
                    <EpicForm
                      initial={{ name: epic.name, description: epic.description ?? '' }}
                      onSave={(data) => updateEpic.mutate({ id: epic.id, data })}
                      onCancel={() => setEditingEpicId(null)}
                      saving={updateEpic.isPending}
                    />
                  </div>
                ) : (
                  <div className="group flex items-center gap-2 px-4 py-3 cursor-pointer hover:bg-gray-50"
                    onClick={() => toggle(epic.id)}>
                    <span className="text-gray-400 text-sm select-none">{expandedEpics.has(epic.id) ? '▼' : '▶'}</span>
                    <span className="text-xs text-red-600 bg-red-50 px-2 py-0.5 rounded font-medium">Epic</span>
                    <span className="font-medium text-gray-900 flex-1">{epic.name}</span>
                    <span className="text-sm text-gray-400">
                      {epic.features.length} feature{epic.features.length !== 1 ? 's' : ''} · {epicTotalHours(epic)}h
                    </span>
                    <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity" onClick={e => e.stopPropagation()}>
                      <button onClick={() => setEditingEpicId(epic.id)} className="text-xs text-gray-400 hover:text-gray-700 px-2 py-1">Edit</button>
                      <button onClick={() => deleteEpic.mutate(epic.id)} className="text-xs text-red-400 hover:text-red-600 px-2 py-1">Delete</button>
                    </div>
                  </div>
                )}
                {expandedEpics.has(epic.id) && (
                  <div className="border-t border-gray-100 px-3 pb-3 pt-2">
                    <FeatureList epicId={epic.id} features={epic.features} resourceTypes={resourceTypes} projectId={projectId!} />
                  </div>
                )}
              </div>
            ))}

            {addingEpic && (
              <div className="bg-white rounded-xl border border-blue-200 p-4">
                <EpicForm
                  initial={epicForm}
                  onSave={(data) => createEpic.mutate(data)}
                  onCancel={() => setAddingEpic(false)}
                  saving={createEpic.isPending}
                />
              </div>
            )}

            {epics.length === 0 && !addingEpic && (
              <div className="text-center py-16 text-gray-400">
                <p className="text-lg mb-1">Backlog is empty</p>
                <p className="text-sm">Add an epic to get started, or use AI to generate a starter backlog</p>
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  )
}

function EpicForm({ initial, onSave, onCancel, saving }: {
  initial: { name: string; description: string }
  onSave: (data: typeof initial) => void
  onCancel: () => void
  saving: boolean
}) {
  const [form, setForm] = useState(initial)
  const f = (field: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setForm(v => ({ ...v, [field]: e.target.value }))

  return (
    <div className="space-y-2">
      <input placeholder="Epic name *" value={form.name} onChange={f('name')}
        className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-red-400" />
      <textarea placeholder="Description" value={form.description} onChange={f('description')} rows={2}
        className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-red-400" />
      <div className="flex gap-2">
        <button onClick={() => onSave(form)} disabled={!form.name || saving}
          className="bg-red-600 text-white px-4 py-1.5 rounded-lg text-sm font-medium hover:bg-red-700 disabled:opacity-50">
          {saving ? 'Saving…' : 'Save epic'}
        </button>
        <button onClick={onCancel} className="px-4 py-1.5 rounded-lg text-sm text-gray-500 hover:bg-gray-100">Cancel</button>
      </div>
    </div>
  )
}
