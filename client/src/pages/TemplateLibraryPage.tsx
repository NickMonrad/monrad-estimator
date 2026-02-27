import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/api'
import { useAuth } from '../hooks/useAuth'

const HOURS_PER_DAY = 7.6

interface TemplateTask {
  id: string
  templateId: string
  name: string
  hoursSmall: number
  hoursMedium: number
  hoursLarge: number
  hoursExtraLarge: number
  resourceTypeName: string
}

interface FeatureTemplate {
  id: string
  name: string
  category: string | null
  description: string | null
  tasks: TemplateTask[]
}

export default function TemplateLibraryPage() {
  const navigate = useNavigate()
  const { user, logout } = useAuth()
  const qc = useQueryClient()

  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set())
  const [adding, setAdding] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [templateForm, setTemplateForm] = useState({ name: '', category: '', description: '' })
  const [addingTaskForId, setAddingTaskForId] = useState<string | null>(null)
  const [editingTaskId, setEditingTaskId] = useState<string | null>(null)
  const [taskForm, setTaskForm] = useState({ name: '', hoursSmall: 0, hoursMedium: 0, hoursLarge: 0, hoursExtraLarge: 0, resourceTypeName: '' })

  const { data: templates = [], isLoading } = useQuery<FeatureTemplate[]>({
    queryKey: ['templates'],
    queryFn: () => api.get('/templates').then(r => r.data),
  })

  const invalidate = () => qc.invalidateQueries({ queryKey: ['templates'] })

  const createTemplate = useMutation({
    mutationFn: (data: typeof templateForm) => api.post('/templates', data),
    onSuccess: () => { invalidate(); setAdding(false); setTemplateForm({ name: '', category: '', description: '' }) },
  })

  const updateTemplate = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Partial<typeof templateForm> }) => api.put(`/templates/${id}`, data),
    onSuccess: () => { invalidate(); setEditingId(null) },
  })

  const deleteTemplate = useMutation({
    mutationFn: (id: string) => api.delete(`/templates/${id}`),
    onSuccess: invalidate,
  })

  const createTask = useMutation({
    mutationFn: ({ templateId, data }: { templateId: string; data: typeof taskForm }) =>
      api.post(`/templates/${templateId}/tasks`, data),
    onSuccess: () => { invalidate(); setAddingTaskForId(null); setTaskForm({ name: '', hoursSmall: 0, hoursMedium: 0, hoursLarge: 0, hoursExtraLarge: 0, resourceTypeName: '' }) },
  })

  const updateTask = useMutation({
    mutationFn: ({ templateId, taskId, data }: { templateId: string; taskId: string; data: Partial<typeof taskForm> }) =>
      api.put(`/templates/${templateId}/tasks/${taskId}`, data),
    onSuccess: () => { invalidate(); setEditingTaskId(null) },
  })

  const deleteTask = useMutation({
    mutationFn: ({ templateId, taskId }: { templateId: string; taskId: string }) =>
      api.delete(`/templates/${templateId}/tasks/${taskId}`),
    onSuccess: invalidate,
  })

  const toggle = (id: string) =>
    setExpandedIds(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n })

  const fmt = (h: number) => `${h}h (${(h / HOURS_PER_DAY).toFixed(1)}d)`

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white border-b border-gray-200">
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm text-gray-500">
            <button onClick={() => navigate('/')} className="hover:text-red-600 transition-colors font-semibold text-gray-900">Monrad Estimator</button>
            <span>/</span>
            <span className="text-gray-700">Template Library</span>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-sm text-gray-500">{user?.name}</span>
            <button onClick={logout} className="text-sm text-gray-500 hover:text-gray-700">Sign out</button>
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-6 py-8">
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-xl font-semibold text-gray-900">Template Library</h1>
          {!adding && (
            <button onClick={() => setAdding(true)}
              className="bg-red-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-red-700 transition-colors">
              + New template
            </button>
          )}
        </div>

        {isLoading ? (
          <div className="text-center py-12 text-gray-400">Loading…</div>
        ) : (
          <div className="space-y-3">
            {adding && (
              <div className="bg-white rounded-xl border border-blue-200 p-4">
                <h3 className="text-sm font-medium text-gray-700 mb-3">New template</h3>
                <TemplateForm
                  initial={templateForm}
                  onSave={(data) => createTemplate.mutate(data)}
                  onCancel={() => setAdding(false)}
                  saving={createTemplate.isPending}
                />
              </div>
            )}

            {templates.map(tpl => (
              <div key={tpl.id} className="bg-white rounded-xl border border-gray-200 overflow-hidden">
                {editingId === tpl.id ? (
                  <div className="p-4">
                    <TemplateForm
                      initial={{ name: tpl.name, category: tpl.category ?? '', description: tpl.description ?? '' }}
                      onSave={(data) => updateTemplate.mutate({ id: tpl.id, data })}
                      onCancel={() => setEditingId(null)}
                      saving={updateTemplate.isPending}
                    />
                  </div>
                ) : (
                  <div className="group flex items-center gap-3 px-5 py-4 cursor-pointer hover:bg-gray-50"
                    onClick={() => toggle(tpl.id)}>
                    <span className="text-gray-400 text-sm select-none">{expandedIds.has(tpl.id) ? '▼' : '▶'}</span>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-gray-900">{tpl.name}</span>
                        {tpl.category && (
                          <span className="text-xs text-purple-600 bg-purple-50 px-2 py-0.5 rounded">{tpl.category}</span>
                        )}
                      </div>
                      {tpl.description && <p className="text-xs text-gray-500 mt-0.5 truncate">{tpl.description}</p>}
                    </div>
                    <span className="text-xs text-gray-400 whitespace-nowrap">
                      {tpl.tasks.length} task{tpl.tasks.length !== 1 ? 's' : ''}
                    </span>
                    <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity" onClick={e => e.stopPropagation()}>
                      <button onClick={() => setEditingId(tpl.id)} className="text-xs text-gray-400 hover:text-gray-700 px-2 py-1">Edit</button>
                      <button onClick={() => deleteTemplate.mutate(tpl.id)} className="text-xs text-red-400 hover:text-red-600 px-2 py-1">Delete</button>
                    </div>
                  </div>
                )}

                {expandedIds.has(tpl.id) && (
                  <div className="border-t border-gray-100 px-5 py-4">
                    {tpl.tasks.length > 0 && (
                      <table className="w-full text-sm mb-3">
                        <thead>
                          <tr className="text-xs text-gray-400 border-b border-gray-100">
                            <th className="text-left pb-2 font-medium">Task</th>
                            <th className="text-left pb-2 font-medium">Resource type</th>
                            <th className="text-right pb-2 font-medium">S</th>
                            <th className="text-right pb-2 font-medium">M</th>
                            <th className="text-right pb-2 font-medium">L</th>
                            <th className="text-right pb-2 font-medium">XL</th>
                            <th className="pb-2"></th>
                          </tr>
                        </thead>
                        <tbody>
                          {tpl.tasks.map(task => (
                            editingTaskId === task.id ? (
                              <tr key={task.id}>
                                <td colSpan={7} className="py-2">
                                  <TaskForm
                                    initial={{ name: task.name, hoursSmall: task.hoursSmall, hoursMedium: task.hoursMedium, hoursLarge: task.hoursLarge, hoursExtraLarge: task.hoursExtraLarge, resourceTypeName: task.resourceTypeName }}
                                    onSave={(data) => updateTask.mutate({ templateId: tpl.id, taskId: task.id, data })}
                                    onCancel={() => setEditingTaskId(null)}
                                    saving={updateTask.isPending}
                                  />
                                </td>
                              </tr>
                            ) : (
                              <tr key={task.id} className="group border-b border-gray-50 last:border-0">
                                <td className="py-2 pr-4 text-gray-800">{task.name}</td>
                                <td className="py-2 pr-4 text-gray-500">{task.resourceTypeName}</td>
                                <td className="py-2 pr-3 text-right text-gray-600 text-xs whitespace-nowrap">{fmt(task.hoursSmall)}</td>
                                <td className="py-2 pr-3 text-right text-gray-600 text-xs whitespace-nowrap">{fmt(task.hoursMedium)}</td>
                                <td className="py-2 pr-3 text-right text-gray-600 text-xs whitespace-nowrap">{fmt(task.hoursLarge)}</td>
                                <td className="py-2 pr-3 text-right text-gray-600 text-xs whitespace-nowrap">{fmt(task.hoursExtraLarge)}</td>
                                <td className="py-2">
                                  <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                                    <button onClick={() => setEditingTaskId(task.id)} className="text-xs text-gray-400 hover:text-gray-700 px-1">Edit</button>
                                    <button onClick={() => deleteTask.mutate({ templateId: tpl.id, taskId: task.id })} className="text-xs text-red-400 hover:text-red-600 px-1">Delete</button>
                                  </div>
                                </td>
                              </tr>
                            )
                          ))}
                        </tbody>
                      </table>
                    )}

                    {addingTaskForId === tpl.id ? (
                      <TaskForm
                        initial={taskForm}
                        onSave={(data) => createTask.mutate({ templateId: tpl.id, data })}
                        onCancel={() => setAddingTaskForId(null)}
                        saving={createTask.isPending}
                      />
                    ) : (
                      <button onClick={() => setAddingTaskForId(tpl.id)}
                        className="text-xs text-gray-400 hover:text-gray-600 flex items-center gap-1 py-1">
                        + Add task
                      </button>
                    )}
                  </div>
                )}
              </div>
            ))}

            {templates.length === 0 && !adding && (
              <div className="text-center py-16 text-gray-400">
                <p className="text-lg mb-1">No templates yet</p>
                <p className="text-sm">Create a template to speed up backlog creation</p>
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  )
}

function TemplateForm({ initial, onSave, onCancel, saving }: {
  initial: { name: string; category: string; description: string }
  onSave: (data: typeof initial) => void
  onCancel: () => void
  saving: boolean
}) {
  const [form, setForm] = useState(initial)
  const f = (field: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setForm(v => ({ ...v, [field]: e.target.value }))

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-2">
        <input placeholder="Template name *" value={form.name} onChange={f('name')}
          className="border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-red-400" />
        <input placeholder="Category (e.g. Security, Auth)" value={form.category} onChange={f('category')}
          className="border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-red-400" />
      </div>
      <textarea placeholder="Description" value={form.description} onChange={f('description')} rows={2}
        className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-red-400" />
      <div className="flex gap-2">
        <button onClick={() => onSave(form)} disabled={!form.name || saving}
          className="bg-red-600 text-white px-4 py-1.5 rounded-lg text-sm font-medium hover:bg-red-700 disabled:opacity-50">
          {saving ? 'Saving…' : 'Save template'}
        </button>
        <button onClick={onCancel} className="px-4 py-1.5 rounded-lg text-sm text-gray-500 hover:bg-gray-100">Cancel</button>
      </div>
    </div>
  )
}

function TaskForm({ initial, onSave, onCancel, saving }: {
  initial: { name: string; hoursSmall: number; hoursMedium: number; hoursLarge: number; hoursExtraLarge: number; resourceTypeName: string }
  onSave: (data: typeof initial) => void
  onCancel: () => void
  saving: boolean
}) {
  const [form, setForm] = useState(initial)
  const fText = (field: 'name' | 'resourceTypeName') => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm(v => ({ ...v, [field]: e.target.value }))
  const fNum = (field: 'hoursSmall' | 'hoursMedium' | 'hoursLarge' | 'hoursExtraLarge') => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm(v => ({ ...v, [field]: parseFloat(e.target.value) || 0 }))

  return (
    <div className="bg-gray-50 rounded-lg px-3 py-2 space-y-2">
      <div className="grid grid-cols-2 gap-2">
        <input placeholder="Task name *" value={form.name} onChange={fText('name')}
          className="border border-gray-200 rounded px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-blue-400" />
        <input placeholder="Resource type name *" value={form.resourceTypeName} onChange={fText('resourceTypeName')}
          className="border border-gray-200 rounded px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-blue-400" />
      </div>
      <div className="grid grid-cols-4 gap-2">
        {(['hoursSmall', 'hoursMedium', 'hoursLarge', 'hoursExtraLarge'] as const).map((field, i) => (
          <div key={field}>
            <label className="text-xs text-gray-400 block mb-1">{['S', 'M', 'L', 'XL'][i]} hours</label>
            <input type="number" min="0" step="0.5" value={form[field]} onChange={fNum(field)}
              className="w-full border border-gray-200 rounded px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-blue-400" />
          </div>
        ))}
      </div>
      <div className="flex gap-2">
        <button onClick={() => onSave(form)} disabled={!form.name || !form.resourceTypeName || saving}
          className="bg-red-600 text-white px-3 py-1 rounded text-xs font-medium hover:bg-red-700 disabled:opacity-50">
          {saving ? 'Saving…' : 'Save task'}
        </button>
        <button onClick={onCancel} className="px-3 py-1 rounded text-xs text-gray-500 hover:bg-gray-100">Cancel</button>
      </div>
    </div>
  )
}
