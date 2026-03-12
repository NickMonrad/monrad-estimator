import { useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/api'
import { useAuth } from '../hooks/useAuth'

type ResourceCategory = 'ENGINEERING' | 'GOVERNANCE' | 'PROJECT_MANAGEMENT'

interface GlobalResourceType {
  id: string
  name: string
  category: ResourceCategory
  defaultHoursPerDay?: number | null
  defaultDayRate?: number | null
}

interface ProjectResourceType {
  id: string
  name: string
  category: ResourceCategory
  hoursPerDay: number | null
  dayRate: number | null
  globalTypeId: string | null
  globalType: GlobalResourceType | null
  _count: { tasks: number }
}

const CATEGORY_LABELS: Record<ResourceCategory, string> = {
  ENGINEERING: 'Engineering',
  GOVERNANCE: 'Governance',
  PROJECT_MANAGEMENT: 'Project Management',
}

const CATEGORY_COLOURS: Record<ResourceCategory, string> = {
  ENGINEERING: 'bg-blue-100 text-blue-700',
  GOVERNANCE: 'bg-amber-100 text-amber-700',
  PROJECT_MANAGEMENT: 'bg-green-100 text-green-700',
}

const CATEGORIES: ResourceCategory[] = ['ENGINEERING', 'GOVERNANCE', 'PROJECT_MANAGEMENT']

function parseNullableNumber(value: string): number | null {
  if (!value || !value.trim()) return null
  const parsed = parseFloat(value)
  return Number.isFinite(parsed) ? parsed : null
}

interface EditRowFormState {
  name: string
  category: ResourceCategory
  hoursPerDay: string
  dayRate: string
}

interface EditRowProps {
  initial: EditRowFormState
  onSave: (data: EditRowFormState) => void
  onCancel: () => void
  saving: boolean
}

function EditRow({ initial, onSave, onCancel, saving }: EditRowProps) {
  const [form, setForm] = useState(initial)
  return (
    <tr className="bg-blue-50">
      <td className="px-4 py-2">
        <input
          type="text"
          value={form.name}
          onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
          className="w-full border border-gray-300 dark:border-gray-600 rounded px-2 py-1 text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-lab3-blue"
          placeholder="Name *"
        />
      </td>
      <td className="px-4 py-2">
        <select
          value={form.category}
          onChange={e => setForm(f => ({ ...f, category: e.target.value as ResourceCategory }))}
          className="w-full border border-gray-300 dark:border-gray-600 rounded px-2 py-1 text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-lab3-blue"
        >
          {CATEGORIES.map(c => (
            <option key={c} value={c}>{CATEGORY_LABELS[c]}</option>
          ))}
        </select>
      </td>
      <td className="px-4 py-2" />
      <td className="px-4 py-2">
        <input
          type="number"
          step="0.1"
          value={form.hoursPerDay}
          onChange={e => setForm(f => ({ ...f, hoursPerDay: e.target.value }))}
          className="w-full border border-gray-300 dark:border-gray-600 rounded px-2 py-1 text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-lab3-blue"
          placeholder="7.6"
        />
      </td>
      <td className="px-4 py-2">
        <input
          type="number"
          step="50"
          value={form.dayRate}
          onChange={e => setForm(f => ({ ...f, dayRate: e.target.value }))}
          className="w-full border border-gray-300 dark:border-gray-600 rounded px-2 py-1 text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-lab3-blue"
          placeholder="1200"
        />
      </td>
      <td className="px-4 py-2" />
      <td className="px-4 py-2">
        <div className="flex gap-2">
          <button
            onClick={() => onSave(form)}
            disabled={!form.name || saving}
            className="text-xs bg-lab3-navy text-white px-3 py-1 rounded hover:bg-lab3-blue disabled:opacity-50 transition-colors"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
          <button
            onClick={onCancel}
            className="text-xs text-gray-600 px-3 py-1 rounded hover:bg-gray-100 transition-colors"
          >
            Cancel
          </button>
        </div>
      </td>
    </tr>
  )
}

export default function ProjectResourceTypesPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { user, logout } = useAuth()
  const qc = useQueryClient()

  const [editingId, setEditingId] = useState<string | null>(null)
  const [showAddModal, setShowAddModal] = useState(false)
  const [addTab, setAddTab] = useState<'global' | 'new'>('global')
  const [newForm, setNewForm] = useState({ name: '', category: 'ENGINEERING' as ResourceCategory, hoursPerDay: '', dayRate: '' })

  const { data: project } = useQuery({
    queryKey: ['project', id],
    queryFn: () => api.get(`/projects/${id}`).then(r => r.data),
  })

  const { data: resourceTypes = [], isLoading } = useQuery<ProjectResourceType[]>({
    queryKey: ['project-resource-types', id],
    queryFn: () => api.get(`/projects/${id}/resource-types`).then(r => r.data),
  })

  const { data: globalTypes = [] } = useQuery<GlobalResourceType[]>({
    queryKey: ['global-resource-types'],
    queryFn: () => api.get('/global-resource-types').then(r => r.data),
    enabled: showAddModal,
  })

  const invalidate = () => qc.invalidateQueries({ queryKey: ['project-resource-types', id] })

  const updateType = useMutation({
    mutationFn: ({ rtId, data }: { rtId: string; data: EditRowFormState }) =>
      api.put(`/projects/${id}/resource-types/${rtId}`, {
        name: data.name,
        category: data.category,
        hoursPerDay: parseNullableNumber(data.hoursPerDay),
        dayRate: parseNullableNumber(data.dayRate),
      }),
    onSuccess: () => { invalidate(); setEditingId(null) },
  })

  const addFromGlobal = useMutation({
    mutationFn: (gt: GlobalResourceType) =>
      api.post(`/projects/${id}/resource-types`, {
        name: gt.name,
        category: gt.category,
        globalTypeId: gt.id,
        hoursPerDay: gt.defaultHoursPerDay ?? null,
        dayRate: gt.defaultDayRate ?? null,
      }),
    onSuccess: () => { invalidate(); setShowAddModal(false) },
  })

  const createNew = useMutation({
    mutationFn: () =>
      api.post(`/projects/${id}/resource-types`, {
        name: newForm.name,
        category: newForm.category,
        hoursPerDay: parseNullableNumber(newForm.hoursPerDay),
        dayRate: parseNullableNumber(newForm.dayRate),
      }),
    onSuccess: () => {
      invalidate()
      setShowAddModal(false)
      setNewForm({ name: '', category: 'ENGINEERING', hoursPerDay: '', dayRate: '' })
    },
  })

  const deleteType = useMutation({
    mutationFn: (rtId: string) => api.delete(`/projects/${id}/resource-types/${rtId}`),
    onSuccess: invalidate,
    onError: (err: any) => {
      const msg = err?.response?.data?.error ?? 'Failed to remove resource type'
      alert(msg)
    },
  })

  const handleDelete = (rt: ProjectResourceType) => {
    const taskCount = rt._count.tasks
    const warning = taskCount > 0
      ? `"${rt.name}" is assigned to ${taskCount} task${taskCount > 1 ? 's' : ''}. Removing it will unassign those tasks. Continue?`
      : `Remove "${rt.name}" from this project?`
    if (window.confirm(warning)) {
      deleteType.mutate(rt.id)
    }
  }

  // Global types not already on the project
  const existingGlobalIds = new Set(resourceTypes.map(rt => rt.globalTypeId).filter(Boolean))
  const availableGlobalTypes = globalTypes.filter(gt => !existingGlobalIds.has(gt.id))

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
      {/* TODO: dark mode — add dark: variants throughout this page */}
      <header className="bg-white border-b border-gray-200">
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm text-gray-500">
            <button onClick={() => navigate('/')} className="hover:text-lab3-navy transition-colors font-semibold text-gray-900">Monrad Estimator</button>
            <span>/</span>
            <button onClick={() => navigate(`/projects/${id}`)} className="hover:text-lab3-navy transition-colors">{project?.name ?? '…'}</button>
            <span>/</span>
            <span className="text-gray-700">Resource Types</span>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-sm text-gray-500">{user?.name}</span>
            <button onClick={logout} className="text-sm text-gray-500 hover:text-gray-700">Sign out</button>
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-6 py-8">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-xl font-semibold text-gray-900">Resource Types</h1>
            <p className="text-sm text-gray-500 mt-0.5">
              Manage the resource types available on this project. Each type inherits defaults from the global catalog but can be overridden per project.
            </p>
          </div>
          <button
            onClick={() => { setShowAddModal(true); setAddTab('global') }}
            className="bg-lab3-navy text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-lab3-blue transition-colors"
          >
            + Add Resource Type
          </button>
        </div>

        <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 shadow-sm overflow-hidden">
          {isLoading ? (
            <div className="text-center py-12 text-gray-400">Loading…</div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-200 bg-gray-50">
                  <th className="px-4 py-3 text-left font-medium text-gray-600">Name</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-600">Category</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-600">Global Link</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-600">Hours/Day</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-600">Day Rate</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-600">Tasks</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-600">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {resourceTypes.map(rt =>
                  editingId === rt.id ? (
                    <EditRow
                      key={rt.id}
                      initial={{
                        name: rt.name,
                        category: rt.category,
                        hoursPerDay: rt.hoursPerDay?.toString() ?? '',
                        dayRate: rt.dayRate?.toString() ?? '',
                      }}
                      onSave={data => updateType.mutate({ rtId: rt.id, data })}
                      onCancel={() => setEditingId(null)}
                      saving={updateType.isPending}
                    />
                  ) : (
                    <tr key={rt.id} className="hover:bg-gray-50 transition-colors">
                      <td className="px-4 py-3 font-medium text-gray-900">{rt.name}</td>
                      <td className="px-4 py-3">
                        <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${CATEGORY_COLOURS[rt.category]}`}>
                          {CATEGORY_LABELS[rt.category]}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-gray-500">
                        {rt.globalType ? (
                          <span className="text-xs text-gray-500">{rt.globalType.name}</span>
                        ) : (
                          <span className="text-xs text-gray-400 italic">Ad-hoc</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-gray-700">
                        {rt.hoursPerDay != null ? rt.hoursPerDay : '—'}
                      </td>
                      <td className="px-4 py-3 text-gray-700">
                        {rt.dayRate != null ? rt.dayRate.toLocaleString() : '—'}
                      </td>
                      <td className="px-4 py-3 text-gray-500">
                        {rt._count.tasks}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <button
                            onClick={() => setEditingId(rt.id)}
                            className="text-gray-400 hover:text-gray-700 transition-colors p-1 rounded"
                            title="Edit"
                          >
                            <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
                              <path d="M13.586 3.586a2 2 0 112.828 2.828l-.793.793-2.828-2.828.793-.793zM11.379 5.793L3 14.172V17h2.828l8.38-8.379-2.83-2.828z" />
                            </svg>
                          </button>
                          <button
                            onClick={() => handleDelete(rt)}
                            title={rt._count.tasks > 0 ? `Assigned to ${rt._count.tasks} task(s) — click to remove anyway` : 'Remove'}
                            className={`p-1 rounded transition-colors ${rt._count.tasks > 0 ? 'text-amber-400 hover:text-red-600' : 'text-gray-400 hover:text-red-600'}`}
                          >
                            <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
                              <path fillRule="evenodd" d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2v10a2 2 0 002 2h8a2 2 0 002-2V6a1 1 0 100-2h-3.382l-.724-1.447A1 1 0 0011 2H9zM7 8a1 1 0 012 0v6a1 1 0 11-2 0V8zm5-1a1 1 0 00-1 1v6a1 1 0 102 0V8a1 1 0 00-1-1z" clipRule="evenodd" />
                            </svg>
                          </button>
                        </div>
                      </td>
                    </tr>
                  )
                )}

                {resourceTypes.length === 0 && (
                  <tr>
                    <td colSpan={7} className="px-4 py-12 text-center text-gray-400">No resource types on this project yet</td>
                  </tr>
                )}
              </tbody>
            </table>
          )}
        </div>
      </main>

      {/* Add Resource Type Modal */}
      {showAddModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white dark:bg-gray-800 rounded-xl shadow-xl w-full max-w-lg">
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
              <h2 className="font-semibold text-gray-900">Add Resource Type</h2>
              <button
                onClick={() => setShowAddModal(false)}
                className="text-gray-400 hover:text-gray-700 transition-colors text-xl leading-none"
              >
                ×
              </button>
            </div>

            {/* Tabs */}
            <div className="flex border-b border-gray-200">
              <button
                onClick={() => setAddTab('global')}
                className={`px-6 py-3 text-sm font-medium transition-colors ${addTab === 'global' ? 'text-lab3-navy border-b-2 border-lab3-navy' : 'text-gray-500 hover:text-gray-700'}`}
              >
                From Global Catalog
              </button>
              <button
                onClick={() => setAddTab('new')}
                className={`px-6 py-3 text-sm font-medium transition-colors ${addTab === 'new' ? 'text-lab3-navy border-b-2 border-lab3-navy' : 'text-gray-500 hover:text-gray-700'}`}
              >
                Create New
              </button>
            </div>

            <div className="p-6">
              {addTab === 'global' && (
                <>
                  {availableGlobalTypes.length === 0 ? (
                    <p className="text-sm text-gray-500 text-center py-6">All global resource types are already on this project.</p>
                  ) : (
                    <div className="space-y-2 max-h-64 overflow-y-auto">
                      {availableGlobalTypes.map(gt => (
                        <button
                          key={gt.id}
                          onClick={() => addFromGlobal.mutate(gt)}
                          disabled={addFromGlobal.isPending}
                          className="w-full text-left px-4 py-3 rounded-lg border border-gray-200 hover:border-lab3-blue/30 hover:bg-blue-50 transition-all disabled:opacity-50"
                        >
                          <div className="flex items-center justify-between">
                            <div>
                              <span className="font-medium text-gray-900 text-sm">{gt.name}</span>
                              {(gt.defaultHoursPerDay != null || gt.defaultDayRate != null) && (
                                <span className="text-xs text-gray-400 ml-2">
                                  {gt.defaultHoursPerDay != null ? `${gt.defaultHoursPerDay} hrs/day` : ''}
                                  {gt.defaultHoursPerDay != null && gt.defaultDayRate != null ? ' · ' : ''}
                                  {gt.defaultDayRate != null ? `$${gt.defaultDayRate.toLocaleString()}/day` : ''}
                                </span>
                              )}
                            </div>
                            <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${CATEGORY_COLOURS[gt.category]}`}>
                              {CATEGORY_LABELS[gt.category]}
                            </span>
                          </div>
                        </button>
                      ))}
                    </div>
                  )}
                </>
              )}

              {addTab === 'new' && (
                <div className="space-y-4">
                  <div className="grid grid-cols-2 gap-4">
                    <div className="col-span-2">
                      <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Name *</label>
                      <input
                        type="text"
                        value={newForm.name}
                        onChange={e => setNewForm(f => ({ ...f, name: e.target.value }))}
                        className="w-full border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-lab3-blue"
                        placeholder="e.g. Data Engineer"
                      />
                    </div>
                    <div className="col-span-2">
                      <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Category *</label>
                      <select
                        value={newForm.category}
                        onChange={e => setNewForm(f => ({ ...f, category: e.target.value as ResourceCategory }))}
                        className="w-full border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-lab3-blue"
                      >
                        {CATEGORIES.map(c => (
                          <option key={c} value={c}>{CATEGORY_LABELS[c]}</option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Hours/Day</label>
                      <input
                        type="number"
                        step="0.1"
                        value={newForm.hoursPerDay}
                        onChange={e => setNewForm(f => ({ ...f, hoursPerDay: e.target.value }))}
                        className="w-full border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-lab3-blue"
                        placeholder="7.6"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Day Rate</label>
                      <input
                        type="number"
                        step="50"
                        value={newForm.dayRate}
                        onChange={e => setNewForm(f => ({ ...f, dayRate: e.target.value }))}
                        className="w-full border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-lab3-blue"
                        placeholder="1200"
                      />
                    </div>
                  </div>
                  <div className="flex gap-2 pt-2">
                    <button
                      onClick={() => createNew.mutate()}
                      disabled={!newForm.name || createNew.isPending}
                      className="bg-lab3-navy text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-lab3-blue disabled:opacity-50 transition-colors"
                    >
                      {createNew.isPending ? 'Saving…' : 'Create'}
                    </button>
                    <button
                      onClick={() => setShowAddModal(false)}
                      className="px-4 py-2 rounded-lg text-sm font-medium border border-gray-200 text-gray-600 hover:bg-gray-50 transition-colors"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
