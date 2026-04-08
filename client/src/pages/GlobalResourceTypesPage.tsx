import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/api'
import AppLayout from '../components/layout/AppLayout'

interface GlobalResourceType {
  id: string
  name: string
  category: 'ENGINEERING' | 'GOVERNANCE' | 'PROJECT_MANAGEMENT'
  description?: string | null
  defaultHoursPerDay?: number | null
  defaultDayRate?: number | null
  isDefault: boolean
}

const CATEGORY_LABELS: Record<GlobalResourceType['category'], string> = {
  ENGINEERING: 'Engineering',
  GOVERNANCE: 'Governance',
  PROJECT_MANAGEMENT: 'Project Management',
}

const CATEGORY_COLOURS: Record<GlobalResourceType['category'], string> = {
  ENGINEERING: 'bg-blue-100 text-blue-700',
  GOVERNANCE: 'bg-amber-100 text-amber-700',
  PROJECT_MANAGEMENT: 'bg-green-100 text-green-700',
}

const CATEGORIES: GlobalResourceType['category'][] = ['ENGINEERING', 'GOVERNANCE', 'PROJECT_MANAGEMENT']

function sortTypes(types: GlobalResourceType[]) {
  return [...types].sort((a, b) => {
    if (a.category < b.category) return -1
    if (a.category > b.category) return 1
    return a.name.localeCompare(b.name)
  })
}

interface RowFormState {
  name: string
  category: GlobalResourceType['category']
  description: string
  defaultHoursPerDay: string
  defaultDayRate: string
}

function parseNullableNumber(value: string) {
  if (!value || !value.trim()) return null
  const parsed = parseFloat(value)
  return Number.isFinite(parsed) ? parsed : null
}

function toPayload(data: RowFormState) {
  return {
    name: data.name,
    category: data.category,
    description: data.description || null,
    defaultHoursPerDay: parseNullableNumber(data.defaultHoursPerDay),
    defaultDayRate: parseNullableNumber(data.defaultDayRate),
  }
}

interface EditRowProps {
  initial: RowFormState
  onSave: (data: RowFormState) => void
  onCancel: () => void
  saving: boolean
}

function EditRow({ initial, onSave, onCancel, saving }: EditRowProps) {
  const [form, setForm] = useState(initial)
  return (
    <tr className="bg-blue-50 dark:bg-blue-950/30">
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
          onChange={e => setForm(f => ({ ...f, category: e.target.value as GlobalResourceType['category'] }))}
          className="w-full border border-gray-300 dark:border-gray-600 rounded px-2 py-1 text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-lab3-blue"
        >
          {CATEGORIES.map(c => (
            <option key={c} value={c}>{CATEGORY_LABELS[c]}</option>
          ))}
        </select>
      </td>
      <td className="px-4 py-2">
        <input
          type="text"
          value={form.description}
          onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
          className="w-full border border-gray-300 dark:border-gray-600 rounded px-2 py-1 text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-lab3-blue"
          placeholder="Description"
        />
      </td>
      <td className="px-4 py-2">
        <input
          type="number"
          step="0.1"
          value={form.defaultHoursPerDay}
          onChange={e => setForm(f => ({ ...f, defaultHoursPerDay: e.target.value }))}
          className="w-full border border-gray-300 dark:border-gray-600 rounded px-2 py-1 text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-lab3-blue"
          placeholder="7.6"
        />
      </td>
      <td className="px-4 py-2">
        <input
          type="number"
          step="50"
          value={form.defaultDayRate}
          onChange={e => setForm(f => ({ ...f, defaultDayRate: e.target.value }))}
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
            className="text-xs text-gray-600 dark:text-gray-400 px-3 py-1 rounded hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
          >
            Cancel
          </button>
        </div>
      </td>
    </tr>
  )
}

export default function GlobalResourceTypesPage() {
  const qc = useQueryClient()

  const [editingId, setEditingId] = useState<string | null>(null)
  const [showAddForm, setShowAddForm] = useState(false)
  const [addForm, setAddForm] = useState<RowFormState>({
    name: '',
    category: 'ENGINEERING' as GlobalResourceType['category'],
    description: '',
    defaultHoursPerDay: '',
    defaultDayRate: '',
  })

  const { data: types = [], isLoading } = useQuery<GlobalResourceType[]>({
    queryKey: ['global-resource-types'],
    queryFn: () => api.get('/global-resource-types').then(r => r.data),
  })

  const invalidate = () => qc.invalidateQueries({ queryKey: ['global-resource-types'] })

  const updateType = useMutation({
    mutationFn: ({ id, data }: { id: string; data: RowFormState }) =>
      api.put(`/global-resource-types/${id}`, toPayload(data)),
    onSuccess: () => { invalidate(); setEditingId(null) },
  })

  const createType = useMutation({
    mutationFn: (data: typeof addForm) => api.post('/global-resource-types', toPayload(data)),
    onSuccess: () => {
      invalidate()
      setShowAddForm(false)
      setAddForm({ name: '', category: 'ENGINEERING', description: '', defaultHoursPerDay: '', defaultDayRate: '' })
    },
  })

  const deleteType = useMutation({
    mutationFn: (id: string) => api.delete(`/global-resource-types/${id}`),
    onSuccess: invalidate,
    onError: (err: any) => {
      const msg = err?.response?.data?.error ?? 'Failed to delete resource type'
      alert(msg)
    },
  })

  const handleDelete = (t: GlobalResourceType) => {
    if (window.confirm(`Delete "${t.name}"? This cannot be undone.`)) {
      deleteType.mutate(t.id)
    }
  }

  const sorted = sortTypes(types)

  return (
    <AppLayout>
      <main className="max-w-6xl mx-auto px-6 py-8">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-xl font-semibold text-gray-900 dark:text-white">Resource Types</h1>
            <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">Manage the standard resource types available across all projects</p>
          </div>
          <button
            onClick={() => setShowAddForm(true)}
            className="bg-lab3-navy text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-lab3-blue transition-colors"
          >
            + Add resource type
          </button>
        </div>

        <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden">
          {isLoading ? (
            <div className="text-center py-12 text-gray-400">Loading…</div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-700">
                  <th className="px-4 py-3 text-left font-medium text-gray-600 dark:text-gray-400">Name</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-600 dark:text-gray-400">Category</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-600 dark:text-gray-400">Description</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-600 dark:text-gray-400">Default hrs/day</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-600 dark:text-gray-400">Default day rate</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-600 dark:text-gray-400">Default</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-600 dark:text-gray-400">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                {sorted.map(t =>
                  editingId === t.id ? (
                    <EditRow
                      key={t.id}
                      initial={{
                        name: t.name,
                        category: t.category,
                        description: t.description ?? '',
                        defaultHoursPerDay: t.defaultHoursPerDay?.toString() ?? '',
                        defaultDayRate: t.defaultDayRate?.toString() ?? '',
                      }}
                      onSave={data => updateType.mutate({ id: t.id, data })}
                      onCancel={() => setEditingId(null)}
                      saving={updateType.isPending}
                    />
                  ) : (
                    <tr key={t.id} className="hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors">
                      <td className="px-4 py-3 font-medium text-gray-900 dark:text-white">{t.name}</td>
                      <td className="px-4 py-3">
                        <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${CATEGORY_COLOURS[t.category]}`}>
                          {CATEGORY_LABELS[t.category]}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-gray-500 dark:text-gray-400">{t.description ?? ''}</td>
                      <td className="px-4 py-3 text-gray-700 dark:text-gray-300">{t.defaultHoursPerDay ?? '—'}</td>
                      <td className="px-4 py-3 text-gray-700 dark:text-gray-300">
                        {t.defaultDayRate != null ? t.defaultDayRate.toLocaleString() : '—'}
                      </td>
                      <td className="px-4 py-3">
                        {t.isDefault && (
                          <span className="text-xs px-2 py-0.5 rounded-full font-medium bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300">Default</span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <button
                            onClick={() => setEditingId(t.id)}
                            className="text-gray-400 dark:text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 transition-colors p-1 rounded"
                            title="Edit"
                          >
                            {/* Pencil icon */}
                            <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
                              <path d="M13.586 3.586a2 2 0 112.828 2.828l-.793.793-2.828-2.828.793-.793zM11.379 5.793L3 14.172V17h2.828l8.38-8.379-2.83-2.828z" />
                            </svg>
                          </button>
                          <button
                            onClick={() => handleDelete(t)}
                            disabled={t.isDefault}
                            title={t.isDefault ? 'Default types cannot be deleted' : 'Delete'}
                            className={`p-1 rounded transition-colors ${t.isDefault ? 'text-gray-200 dark:text-gray-600 cursor-not-allowed' : 'text-gray-400 dark:text-gray-500 hover:text-red-600'}`}
                          >
                            {/* Trash icon */}
                            <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
                              <path fillRule="evenodd" d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2v10a2 2 0 002 2h8a2 2 0 002-2V6a1 1 0 100-2h-3.382l-.724-1.447A1 1 0 0011 2H9zM7 8a1 1 0 012 0v6a1 1 0 11-2 0V8zm5-1a1 1 0 00-1 1v6a1 1 0 102 0V8a1 1 0 00-1-1z" clipRule="evenodd" />
                            </svg>
                          </button>
                        </div>
                      </td>
                    </tr>
                  )
                )}

                {sorted.length === 0 && (
                  <tr>
                    <td colSpan={7} className="px-4 py-12 text-center text-gray-400 dark:text-gray-500">No resource types yet</td>
                  </tr>
                )}
              </tbody>
            </table>
          )}
        </div>

        {/* Add form */}
        {showAddForm && (
          <div className="bg-white dark:bg-gray-800 rounded-xl border border-blue-200 p-6 mt-4">
            <h2 className="font-medium text-gray-900 dark:text-white mb-4">New resource type</h2>
            <div className="grid grid-cols-2 gap-4 mb-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Name *</label>
                <input
                  type="text"
                  value={addForm.name}
                  onChange={e => setAddForm(f => ({ ...f, name: e.target.value }))}
                  className="w-full border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-lab3-blue"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Category *</label>
                <select
                  value={addForm.category}
                  onChange={e => setAddForm(f => ({ ...f, category: e.target.value as GlobalResourceType['category'] }))}
                  className="w-full border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-lab3-blue"
                >
                  {CATEGORIES.map(c => (
                    <option key={c} value={c}>{CATEGORY_LABELS[c]}</option>
                  ))}
                </select>
              </div>
              <div className="col-span-2">
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Description</label>
                <input
                  type="text"
                  value={addForm.description}
                  onChange={e => setAddForm(f => ({ ...f, description: e.target.value }))}
                  className="w-full border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-lab3-blue"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Default hrs/day</label>
                <input
                  type="number"
                  step="0.1"
                  value={addForm.defaultHoursPerDay}
                  onChange={e => setAddForm(f => ({ ...f, defaultHoursPerDay: e.target.value }))}
                  className="w-full border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-lab3-blue"
                  placeholder="7.6"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Default day rate</label>
                <input
                  type="number"
                  step="50"
                  value={addForm.defaultDayRate}
                  onChange={e => setAddForm(f => ({ ...f, defaultDayRate: e.target.value }))}
                  className="w-full border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-lab3-blue"
                  placeholder="1200"
                />
              </div>
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => createType.mutate(addForm)}
                disabled={!addForm.name || createType.isPending}
                className="bg-lab3-navy text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-lab3-blue disabled:opacity-50 transition-colors"
              >
                {createType.isPending ? 'Saving…' : 'Save'}
              </button>
              <button
                onClick={() => setShowAddForm(false)}
                className="px-4 py-2 rounded-lg text-sm font-medium text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </main>
  </AppLayout>
  )
}
