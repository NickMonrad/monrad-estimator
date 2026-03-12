import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/api'
import { useAuth } from '../hooks/useAuth'

/* ── Types ─────────────────────────────────────────────── */

interface GlobalResourceType {
  id: string
  name: string
  category: string
}

interface RateCardEntry {
  id: string
  globalResourceTypeId: string
  globalResourceType: GlobalResourceType
  dayRate: number
}

interface RateCard {
  id: string
  name: string
  version: number
  isDefault: boolean
  entries: RateCardEntry[]
  createdAt: string
  updatedAt: string
}

interface EntryDraft {
  globalResourceTypeId: string
  dayRate: string
}

/* ── Modal ─────────────────────────────────────────────── */

interface RateCardModalProps {
  title: string
  initial?: { name: string; isDefault: boolean; entries: EntryDraft[] }
  globalResourceTypes: GlobalResourceType[]
  saving: boolean
  onSave: (payload: { name: string; isDefault: boolean; entries: { globalResourceTypeId: string; dayRate: number }[] }) => void
  onClose: () => void
}

function RateCardModal({ title, initial, globalResourceTypes, saving, onSave, onClose }: RateCardModalProps) {
  const [name, setName] = useState(initial?.name ?? '')
  const [isDefault, setIsDefault] = useState(initial?.isDefault ?? false)
  const [entries, setEntries] = useState<EntryDraft[]>(
    initial?.entries ?? [],
  )

  const usedTypeIds = new Set(entries.map(e => e.globalResourceTypeId))
  const availableTypes = globalResourceTypes.filter(t => !usedTypeIds.has(t.id))

  const addEntry = (typeId: string) => {
    setEntries(prev => [...prev, { globalResourceTypeId: typeId, dayRate: '' }])
  }

  const removeEntry = (idx: number) => {
    setEntries(prev => prev.filter((_, i) => i !== idx))
  }

  const updateRate = (idx: number, value: string) => {
    setEntries(prev => prev.map((e, i) => (i === idx ? { ...e, dayRate: value } : e)))
  }

  const validEntries = entries.filter(e => {
    const v = parseFloat(e.dayRate)
    return e.globalResourceTypeId && Number.isFinite(v) && v > 0
  })

  const canSave = name.trim() && validEntries.length > 0

  const handleSave = () => {
    if (!canSave) return
    onSave({
      name: name.trim(),
      isDefault,
      entries: validEntries.map(e => ({
        globalResourceTypeId: e.globalResourceTypeId,
        dayRate: parseFloat(e.dayRate),
      })),
    })
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />

      {/* Panel */}
      <div className="relative bg-white dark:bg-gray-800 rounded-xl shadow-xl w-full max-w-2xl max-h-[85vh] overflow-y-auto mx-4">
        <div className="px-6 py-5 border-b border-gray-200 dark:border-gray-700 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white">{title}</h2>
          <button onClick={onClose} className="text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 transition-colors">
            <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
              <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
            </svg>
          </button>
        </div>

        <div className="px-6 py-5 space-y-5">
          {/* Name */}
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Name *</label>
            <input
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              className="w-full border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-lab3-blue"
              placeholder="e.g. Standard 2025 Rates"
            />
          </div>

          {/* Default checkbox */}
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={isDefault}
              onChange={e => setIsDefault(e.target.checked)}
              className="rounded border-gray-300 dark:border-gray-600 text-lab3-navy focus:ring-lab3-blue dark:bg-gray-700 dark:text-white"
            />
            <span className="text-sm text-gray-700 dark:text-gray-300">Set as default rate card</span>
          </label>

          {/* Entries */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-sm font-medium text-gray-700 dark:text-gray-300">Rate Entries</label>
              {availableTypes.length > 0 && (
                <select
                  value=""
                  onChange={e => { if (e.target.value) addEntry(e.target.value) }}
                  className="border border-gray-300 dark:border-gray-600 rounded-lg px-2 py-1.5 text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-lab3-blue"
                >
                  <option value="">+ Add resource type…</option>
                  {availableTypes.map(t => (
                    <option key={t.id} value={t.id}>{t.name}</option>
                  ))}
                </select>
              )}
            </div>

            {entries.length === 0 ? (
              <p className="text-sm text-gray-400 dark:text-gray-500 py-4 text-center border border-dashed border-gray-200 dark:border-gray-600 rounded-lg">
                No entries yet — add a resource type above
              </p>
            ) : (
              <table className="w-full text-sm border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden">
                <thead>
                  <tr className="bg-gray-50 dark:bg-gray-700 border-b border-gray-200 dark:border-gray-600">
                    <th className="px-4 py-2 text-left font-medium text-gray-600 dark:text-gray-300">Resource Type</th>
                    <th className="px-4 py-2 text-left font-medium text-gray-600 dark:text-gray-300">Day Rate</th>
                    <th className="px-4 py-2 w-10" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                  {entries.map((entry, idx) => {
                    const rt = globalResourceTypes.find(t => t.id === entry.globalResourceTypeId)
                    return (
                      <tr key={entry.globalResourceTypeId} className="hover:bg-gray-50 dark:hover:bg-gray-700">
                        <td className="px-4 py-2 text-gray-900 dark:text-white">{rt?.name ?? 'Unknown'}</td>
                        <td className="px-4 py-2">
                          <input
                            type="number"
                            step="50"
                            min="0"
                            value={entry.dayRate}
                            onChange={e => updateRate(idx, e.target.value)}
                            className="w-32 border border-gray-300 dark:border-gray-600 rounded px-2 py-1 text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-lab3-blue"
                            placeholder="1200"
                          />
                        </td>
                        <td className="px-4 py-2">
                          <button
                            onClick={() => removeEntry(idx)}
                            className="text-gray-400 dark:text-gray-500 hover:text-lab3-navy transition-colors p-1 rounded"
                            title="Remove"
                          >
                            <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
                              <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
                            </svg>
                          </button>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-gray-200 dark:border-gray-700 flex justify-end gap-2">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-lg text-sm font-medium text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={!canSave || saving}
            className="bg-lab3-navy text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-lab3-blue disabled:opacity-50 transition-colors"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}

/* ── Page ───────────────────────────────────────────────── */

export default function RateCardsPage() {
  const navigate = useNavigate()
  const { user, logout } = useAuth()
  const qc = useQueryClient()

  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set())
  const [showCreate, setShowCreate] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)

  /* ── Queries ─────────────────────────────────────────── */

  const { data: rateCards = [], isLoading } = useQuery<RateCard[]>({
    queryKey: ['rate-cards'],
    queryFn: () => api.get('/rate-cards').then(r => r.data),
  })

  const { data: globalResourceTypes = [] } = useQuery<GlobalResourceType[]>({
    queryKey: ['global-resource-types'],
    queryFn: () => api.get('/global-resource-types').then(r => r.data),
  })

  const invalidate = () => qc.invalidateQueries({ queryKey: ['rate-cards'] })

  /* ── Mutations ───────────────────────────────────────── */

  const createRateCard = useMutation({
    mutationFn: (data: { name: string; isDefault: boolean; entries: { globalResourceTypeId: string; dayRate: number }[] }) =>
      api.post('/rate-cards', data),
    onSuccess: () => { invalidate(); setShowCreate(false) },
  })

  const updateRateCard = useMutation({
    mutationFn: ({ id, data }: { id: string; data: { name: string; isDefault: boolean; entries: { globalResourceTypeId: string; dayRate: number }[] } }) =>
      api.put(`/rate-cards/${id}`, data),
    onSuccess: () => { invalidate(); setEditingId(null) },
  })

  const deleteRateCard = useMutation({
    mutationFn: (id: string) => api.delete(`/rate-cards/${id}`),
    onSuccess: invalidate,
    onError: (err: any) => {
      const msg = err?.response?.data?.error ?? 'Failed to delete rate card'
      alert(msg)
    },
  })

  const setDefault = useMutation({
    mutationFn: (id: string) => api.put(`/rate-cards/${id}`, { isDefault: true }),
    onSuccess: invalidate,
  })

  /* ── Helpers ─────────────────────────────────────────── */

  const toggleExpand = (id: string) => {
    setExpandedIds(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  const handleDelete = (rc: RateCard) => {
    if (window.confirm(`Delete "${rc.name}"? This cannot be undone.`)) {
      deleteRateCard.mutate(rc.id)
    }
  }

  /* ── Render ──────────────────────────────────────────── */

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
      {/* Header */}
      <header className="bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400">
            <button onClick={() => navigate('/')} className="hover:text-lab3-navy transition-colors font-semibold text-gray-900 dark:text-white">Monrad Estimator</button>
            <span>/</span>
            <span className="text-gray-700 dark:text-gray-300">Rate Cards</span>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-sm text-gray-500 dark:text-gray-400">{user?.name}</span>
            <button onClick={logout} className="text-sm text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200">Sign out</button>
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-6 py-8">
        {/* Title + action */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-xl font-semibold text-gray-900 dark:text-white">Rate Cards</h1>
            <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">Create and manage reusable rate card templates for project pricing</p>
          </div>
          <button
            onClick={() => setShowCreate(true)}
            className="bg-lab3-navy text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-lab3-blue transition-colors"
          >
            + Create Rate Card
          </button>
        </div>

        {/* List */}
        {isLoading ? (
          <div className="text-center py-12 text-gray-400 dark:text-gray-500">Loading…</div>
        ) : rateCards.length === 0 ? (
          <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 text-center py-16">
            <p className="text-gray-400 dark:text-gray-500 mb-4">No rate cards yet</p>
            <button
              onClick={() => setShowCreate(true)}
              className="bg-lab3-navy text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-lab3-blue transition-colors"
            >
              + Create your first rate card
            </button>
          </div>
        ) : (
          <div className="space-y-3">
            {rateCards.map(rc => {
              const expanded = expandedIds.has(rc.id)
              return (
                <div key={rc.id} className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden">
                  {/* Card header */}
                  <div
                    className="flex items-center justify-between px-5 py-4 cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
                    onClick={() => toggleExpand(rc.id)}
                  >
                    <div className="flex items-center gap-3">
                      {/* Chevron */}
                      <svg
                        xmlns="http://www.w3.org/2000/svg"
                        className={`h-4 w-4 text-gray-400 dark:text-gray-500 transition-transform ${expanded ? 'rotate-90' : ''}`}
                        viewBox="0 0 20 20"
                        fill="currentColor"
                      >
                        <path fillRule="evenodd" d="M7.293 14.707a1 1 0 010-1.414L10.586 10 7.293 6.707a1 1 0 011.414-1.414l4 4a1 1 0 010 1.414l-4 4a1 1 0 01-1.414 0z" clipRule="evenodd" />
                      </svg>

                      <span className="font-medium text-gray-900 dark:text-white">{rc.name}</span>

                      {/* Version badge */}
                      <span className="text-xs px-2 py-0.5 rounded-full font-medium bg-blue-100 text-blue-700">
                        v{rc.version}
                      </span>

                      {/* Default badge */}
                      {rc.isDefault && (
                        <span className="text-xs px-2 py-0.5 rounded-full font-medium bg-green-100 text-green-700">
                          Default
                        </span>
                      )}

                      {/* Entry count */}
                      <span className="text-xs text-gray-400 dark:text-gray-500">
                        {rc.entries.length} {rc.entries.length === 1 ? 'entry' : 'entries'}
                      </span>
                    </div>

                    {/* Actions */}
                    <div className="flex items-center gap-2" onClick={e => e.stopPropagation()}>
                      {!rc.isDefault && (
                        <button
                          onClick={() => setDefault.mutate(rc.id)}
                          className="text-xs text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-white px-2 py-1 rounded hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
                          title="Set as default"
                        >
                          Set default
                        </button>
                      )}
                      <button
                        onClick={() => setEditingId(rc.id)}
                        className="text-gray-400 dark:text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 transition-colors p-1 rounded"
                        title="Edit"
                      >
                        <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
                          <path d="M13.586 3.586a2 2 0 112.828 2.828l-.793.793-2.828-2.828.793-.793zM11.379 5.793L3 14.172V17h2.828l8.38-8.379-2.83-2.828z" />
                        </svg>
                      </button>
                      <button
                        onClick={() => handleDelete(rc)}
                        className="text-gray-400 dark:text-gray-500 hover:text-lab3-navy transition-colors p-1 rounded"
                        title="Delete"
                      >
                        <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
                          <path fillRule="evenodd" d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2v10a2 2 0 002 2h8a2 2 0 002-2V6a1 1 0 100-2h-3.382l-.724-1.447A1 1 0 0011 2H9zM7 8a1 1 0 012 0v6a1 1 0 11-2 0V8zm5-1a1 1 0 00-1 1v6a1 1 0 102 0V8a1 1 0 00-1-1z" clipRule="evenodd" />
                        </svg>
                      </button>
                    </div>
                  </div>

                  {/* Expanded entries table */}
                  {expanded && (
                    <div className="border-t border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-700 px-5 py-4">
                      {rc.entries.length === 0 ? (
                        <p className="text-sm text-gray-400 dark:text-gray-500 text-center py-4">No rate entries</p>
                      ) : (
                        <table className="w-full text-sm">
                          <thead>
                            <tr className="border-b border-gray-200 dark:border-gray-600">
                              <th className="px-4 py-2 text-left font-medium text-gray-600 dark:text-gray-300">Resource Type</th>
                              <th className="px-4 py-2 text-left font-medium text-gray-600 dark:text-gray-300">Category</th>
                              <th className="px-4 py-2 text-right font-medium text-gray-600 dark:text-gray-300">Day Rate</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                            {rc.entries.map(entry => (
                              <tr key={entry.id}>
                                <td className="px-4 py-2 text-gray-900 dark:text-white">{entry.globalResourceType.name}</td>
                                <td className="px-4 py-2">
                                  <span className="text-xs px-2 py-0.5 rounded-full font-medium bg-gray-100 dark:bg-gray-600 text-gray-600 dark:text-gray-300">
                                    {entry.globalResourceType.category.replace(/_/g, ' ')}
                                  </span>
                                </td>
                                <td className="px-4 py-2 text-right text-gray-900 dark:text-white font-medium">
                                  ${entry.dayRate.toLocaleString()}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}

        {/* Create modal */}
        {showCreate && (
          <RateCardModal
            title="Create Rate Card"
            globalResourceTypes={globalResourceTypes}
            saving={createRateCard.isPending}
            onSave={data => createRateCard.mutate(data)}
            onClose={() => setShowCreate(false)}
          />
        )}

        {/* Edit modal */}
        {editingId && (() => {
          const rc = rateCards.find(r => r.id === editingId)
          if (!rc) return null
          return (
            <RateCardModal
              title="Edit Rate Card"
              initial={{
                name: rc.name,
                isDefault: rc.isDefault,
                entries: rc.entries.map(e => ({
                  globalResourceTypeId: e.globalResourceTypeId,
                  dayRate: e.dayRate.toString(),
                })),
              }}
              globalResourceTypes={globalResourceTypes}
              saving={updateRateCard.isPending}
              onSave={data => updateRateCard.mutate({ id: editingId, data })}
              onClose={() => setEditingId(null)}
            />
          )
        })()}
      </main>
    </div>
  )
}
