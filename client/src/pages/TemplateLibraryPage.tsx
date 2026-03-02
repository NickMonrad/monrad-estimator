import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { DndContext, closestCenter, PointerSensor, useSensor, useSensors } from '@dnd-kit/core'
import type { DragEndEvent } from '@dnd-kit/core'
import { SortableContext, verticalListSortingStrategy, useSortable, arrayMove } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { api } from '../lib/api'
import { useAuth } from '../hooks/useAuth'

const HOURS_PER_DAY = 7.6

interface GlobalResourceType {
  id: string
  name: string
  category: string
}

interface TemplateTask {
  id: string
  templateId: string
  name: string
  hoursExtraSmall: number
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
  const [taskForm, setTaskForm] = useState({ name: '', hoursExtraSmall: 0, hoursSmall: 0, hoursMedium: 0, hoursLarge: 0, hoursExtraLarge: 0, resourceTypeName: '' })
  const [showTplImport, setShowTplImport] = useState(false)
  const [tplImportCsv, setTplImportCsv] = useState('')
  const [tplImportError, setTplImportError] = useState<string | null>(null)
  const [tplImportLoading, setTplImportLoading] = useState(false)

  const { data: templates = [], isLoading } = useQuery<FeatureTemplate[]>({
    queryKey: ['templates'],
    queryFn: () => api.get('/templates').then(r => r.data),
  })

  const { data: globalResourceTypes = [] } = useQuery<GlobalResourceType[]>({
    queryKey: ['global-resource-types'],
    queryFn: () => api.get('/global-resource-types').then(r => r.data),
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
    onSuccess: () => { invalidate(); setAddingTaskForId(null); setTaskForm({ name: '', hoursExtraSmall: 0, hoursSmall: 0, hoursMedium: 0, hoursLarge: 0, hoursExtraLarge: 0, resourceTypeName: '' }) },
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

  const reorderTasks = useMutation({
    mutationFn: ({ templateId, items }: { templateId: string; items: { id: string; order: number }[] }) =>
      api.put(`/templates/${templateId}/tasks/reorder`, items),
    onSuccess: invalidate,
  })

  const handleDragEnd = (templateId: string, tasks: TemplateTask[], event: DragEndEvent) => {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const oldIndex = tasks.findIndex(t => t.id === active.id)
    const newIndex = tasks.findIndex(t => t.id === over.id)
    const reordered = arrayMove(tasks, oldIndex, newIndex)
    reorderTasks.mutate({ templateId, items: reordered.map((t, i) => ({ id: t.id, order: i })) })
  }

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }))

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
          <div className="flex items-center gap-2">
            <button
              onClick={async () => {
                const res = await api.get('/templates/export-csv', { responseType: 'blob' })
                const url = URL.createObjectURL(res.data)
                const a = document.createElement('a'); a.href = url; a.download = 'templates.csv'; a.click()
                URL.revokeObjectURL(url)
              }}
              className="border border-gray-200 text-gray-600 px-4 py-2 rounded-lg text-sm font-medium hover:bg-gray-50 transition-colors">
              ⬇ Export CSV
            </button>
            <button onClick={() => setShowTplImport(true)}
              className="border border-gray-200 text-gray-600 px-4 py-2 rounded-lg text-sm font-medium hover:bg-gray-50 transition-colors">
              ⬆ Import CSV
            </button>
            {!adding && (
              <button onClick={() => setAdding(true)}
                className="bg-red-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-red-700 transition-colors">
                + New template
              </button>
            )}
          </div>
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
                      <DndContext sensors={sensors} collisionDetection={closestCenter}
                        onDragEnd={(e) => handleDragEnd(tpl.id, tpl.tasks, e)}>
                        <SortableContext items={tpl.tasks.map(t => t.id)} strategy={verticalListSortingStrategy}>
                          <table className="w-full text-sm mb-3">
                            <thead>
                              <tr className="text-xs text-gray-400 border-b border-gray-100">
                                <th className="pb-2 w-5"></th>
                                <th className="text-left pb-2 font-medium">Task</th>
                                <th className="text-left pb-2 font-medium">Resource type</th>
                                <th className="text-right pb-2 font-medium">XS</th>
                                <th className="text-right pb-2 font-medium">S</th>
                                <th className="text-right pb-2 font-medium">M</th>
                                <th className="text-right pb-2 font-medium">L</th>
                                <th className="text-right pb-2 font-medium">XL</th>
                                <th className="pb-2 w-20"></th>
                              </tr>
                            </thead>
                            <tbody>
                              {tpl.tasks.map(task => (
                                editingTaskId === task.id ? (
                                  <tr key={task.id}>
                                    <td colSpan={9} className="py-2">
                                      <TaskForm
                                       initial={{ name: task.name, hoursExtraSmall: task.hoursExtraSmall, hoursSmall: task.hoursSmall, hoursMedium: task.hoursMedium, hoursLarge: task.hoursLarge, hoursExtraLarge: task.hoursExtraLarge, resourceTypeName: task.resourceTypeName }}
                                        globalResourceTypes={globalResourceTypes}
                                        onSave={(data) => updateTask.mutate({ templateId: tpl.id, taskId: task.id, data })}
                                        onCancel={() => setEditingTaskId(null)}
                                        saving={updateTask.isPending}
                                      />
                                    </td>
                                  </tr>
                                ) : (
                                  <SortableTaskRow
                                    key={task.id}
                                    task={task}
                                    fmt={fmt}
                                    onEdit={() => setEditingTaskId(task.id)}
                                    onDelete={() => deleteTask.mutate({ templateId: tpl.id, taskId: task.id })}
                                  />
                                )
                              ))}
                            </tbody>
                          </table>
                        </SortableContext>
                      </DndContext>
                    )}

                    {addingTaskForId === tpl.id ? (
                      <TaskForm
                        initial={taskForm}
                        globalResourceTypes={globalResourceTypes}
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
      {showTplImport && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg">
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
              <h2 className="text-lg font-semibold text-gray-900">Import Templates from CSV</h2>
              <button onClick={() => { setShowTplImport(false); setTplImportCsv(''); setTplImportError(null) }} className="text-gray-400 hover:text-gray-600 text-xl">✕</button>
            </div>
            <div className="p-6">
              <p className="text-sm text-gray-500 mb-2">Upload a CSV with columns: <code className="bg-gray-100 px-1 rounded text-xs">TemplateName, Category, TaskName, ResourceTypeName, HoursSmall, HoursMedium, HoursLarge, HoursExtraLarge</code></p>
              <button
                onClick={() => {
                  const headers = 'TemplateName,Category,TaskName,ResourceTypeName,HoursSmall,HoursMedium,HoursLarge,HoursExtraLarge'
                  const example = 'My Template,Engineering,My Task,Developer,2,4,8,16'
                  const blob = new Blob([headers + '\n' + example], { type: 'text/csv' })
                  const url = URL.createObjectURL(blob)
                  const a = document.createElement('a'); a.href = url; a.download = 'template-format.csv'; a.click()
                  URL.revokeObjectURL(url)
                }}
                className="text-red-600 underline text-sm hover:text-red-700 mb-4 inline-block"
              >
                ⬇ Download blank CSV template
              </button>
              {tplImportError && <div className="mb-4 bg-red-50 text-red-700 text-sm px-4 py-3 rounded-lg border border-red-200">{tplImportError}</div>}
              <input
                type="file" accept=".csv"
                onChange={async (e) => {
                  const file = e.target.files?.[0]
                  if (file) setTplImportCsv(await file.text())
                }}
                className="block w-full text-sm text-gray-500 file:mr-4 file:py-2 file:px-4 file:rounded-lg file:border-0 file:text-sm file:font-medium file:bg-red-50 file:text-red-700 hover:file:bg-red-100 mb-4"
              />
            </div>
            <div className="px-6 py-4 border-t border-gray-100 flex justify-end gap-3">
              <button onClick={() => { setShowTplImport(false); setTplImportCsv(''); setTplImportError(null) }} className="text-sm text-gray-500 hover:text-gray-700">Cancel</button>
              <button
                disabled={!tplImportCsv || tplImportLoading}
                onClick={async () => {
                  setTplImportLoading(true); setTplImportError(null)
                  try {
                    await api.post('/templates/import-csv', { csv: tplImportCsv })
                    invalidate(); setShowTplImport(false); setTplImportCsv('')
                  } catch (err: unknown) {
                    const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? 'Import failed'
                    setTplImportError(msg)
                  } finally { setTplImportLoading(false) }
                }}
                className="bg-red-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-red-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                {tplImportLoading ? 'Importing…' : '✓ Import Templates'}
              </button>
            </div>
          </div>
        </div>
      )}
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

function TaskForm({ initial, globalResourceTypes, onSave, onCancel, saving }: {
  initial: { name: string; hoursExtraSmall: number; hoursSmall: number; hoursMedium: number; hoursLarge: number; hoursExtraLarge: number; resourceTypeName: string }
  globalResourceTypes: GlobalResourceType[]
  onSave: (data: typeof initial) => void
  onCancel: () => void
  saving: boolean
}) {
  const [form, setForm] = useState(initial)
  const fText = (field: 'name') => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm(v => ({ ...v, [field]: e.target.value }))
  const fNum = (field: 'hoursExtraSmall' | 'hoursSmall' | 'hoursMedium' | 'hoursLarge' | 'hoursExtraLarge') => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm(v => ({ ...v, [field]: parseFloat(e.target.value) || 0 }))

  return (
    <div className="bg-gray-50 rounded-lg px-3 py-2 space-y-2">
      <div className="grid grid-cols-2 gap-2">
        <input placeholder="Task name *" value={form.name} onChange={fText('name')}
          className="border border-gray-200 rounded px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-blue-400" />
        {globalResourceTypes.length > 0 ? (
          <select value={form.resourceTypeName} onChange={e => setForm(v => ({ ...v, resourceTypeName: e.target.value }))}
            className="border border-gray-200 rounded px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-blue-400">
            <option value="">Resource type *</option>
            {globalResourceTypes.map(gt => <option key={gt.id} value={gt.name}>{gt.name}</option>)}
          </select>
        ) : (
          <input placeholder="Resource type name *" value={form.resourceTypeName} onChange={e => setForm(v => ({ ...v, resourceTypeName: e.target.value }))}
            className="border border-gray-200 rounded px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-blue-400" />
        )}
      </div>
      <div className="grid grid-cols-5 gap-2">
        {(['hoursExtraSmall', 'hoursSmall', 'hoursMedium', 'hoursLarge', 'hoursExtraLarge'] as const).map((field, i) => (
          <div key={field}>
            <label className="text-xs text-gray-400 block mb-1">{['XS', 'S', 'M', 'L', 'XL'][i]} hours</label>
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

function SortableTaskRow({ task, fmt, onEdit, onDelete }: {
  task: TemplateTask
  fmt: (h: number) => string
  onEdit: () => void
  onDelete: () => void
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: task.id })
  const style = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.5 : 1 }

  return (
    <tr ref={setNodeRef} style={style} className="group border-b border-gray-50 last:border-0 bg-white">
      <td className="py-2 pr-1">
        <span {...attributes} {...listeners}
          className="cursor-grab active:cursor-grabbing text-gray-300 hover:text-gray-500 select-none px-1 text-base">
          ⠿
        </span>
      </td>
      <td className="py-2 pr-4 text-gray-800">{task.name}</td>
      <td className="py-2 pr-4 text-gray-500">{task.resourceTypeName}</td>
      <td className="py-2 pr-3 text-right text-gray-600 text-xs whitespace-nowrap">{fmt(task.hoursExtraSmall)}</td>
      <td className="py-2 pr-3 text-right text-gray-600 text-xs whitespace-nowrap">{fmt(task.hoursSmall)}</td>
      <td className="py-2 pr-3 text-right text-gray-600 text-xs whitespace-nowrap">{fmt(task.hoursMedium)}</td>
      <td className="py-2 pr-3 text-right text-gray-600 text-xs whitespace-nowrap">{fmt(task.hoursLarge)}</td>
      <td className="py-2 pr-3 text-right text-gray-600 text-xs whitespace-nowrap">{fmt(task.hoursExtraLarge)}</td>
      <td className="py-2">
        <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
          <button onClick={onEdit} className="text-xs text-gray-400 hover:text-gray-700 px-1">Edit</button>
          <button onClick={onDelete} className="text-xs text-red-400 hover:text-red-600 px-1">Delete</button>
        </div>
      </td>
    </tr>
  )
}
