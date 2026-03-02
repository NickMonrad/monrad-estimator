import { useState, useRef, useCallback } from 'react'
import { api } from '../../lib/api'

export interface StagedRow {
  rowIndex: number
  epic: string
  feature: string
  story: string
  task: string
  resourceType: string
  hoursEffort: number
  durationDays: number
  description: string
  assumptions: string
  errors: string[]
  warnings: string[]
}

interface Props {
  projectId: string
  onClose: () => void
  onImported: () => void
}

type Step = 'upload' | 'staging' | 'confirm'

export default function CsvImportModal({ projectId, onClose, onImported }: Props) {
  const [step, setStep] = useState<Step>('upload')
  const [staged, setStaged] = useState<StagedRow[]>([])
  const [summary, setSummary] = useState<{ total: number; errorCount: number; warningCount: number } | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [editingRow, setEditingRow] = useState<number | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const handleFileChange = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setError(null)
    setLoading(true)
    try {
      const text = await file.text()
      const res = await api.post(`/projects/${projectId}/backlog/stage-csv`, { csv: text })
      setStaged(res.data.staged)
      setSummary(res.data.summary)
      setStep('staging')
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? 'Failed to parse CSV'
      setError(msg)
    } finally {
      setLoading(false)
    }
  }, [projectId])

  const removeRow = (idx: number) => {
    setStaged(prev => {
      const next = prev.filter((_, i) => i !== idx)
      const errorCount = next.filter(r => r.errors.length > 0).length
      const warningCount = next.filter(r => r.warnings.length > 0).length
      setSummary({ total: next.length, errorCount, warningCount })
      return next
    })
  }

  const updateRow = (idx: number, field: keyof StagedRow, value: string | number) => {
    setStaged(prev => prev.map((r, i) => {
      if (i !== idx) return r
      const updated = { ...r, [field]: value }
      // re-validate
      const errors: string[] = []
      if (!updated.epic) errors.push('Epic is required')
      if (!updated.feature) errors.push('Feature is required')
      if (!updated.story) errors.push('Story is required')
      if (!updated.task) errors.push('Task name is required')
      return { ...updated, errors }
    }))
  }

  const handleCommit = async () => {
    const errorRows = staged.filter(r => r.errors.length > 0)
    if (errorRows.length > 0) {
      setError(`${errorRows.length} row(s) still have errors. Fix or remove them before importing.`)
      return
    }
    setLoading(true)
    setError(null)
    try {
      await api.post(`/projects/${projectId}/backlog/import-csv`, { rows: staged })
      onImported()
      onClose()
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? 'Import failed'
      setError(msg)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-5xl max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <div>
            <h2 className="text-lg font-semibold text-gray-900">Import Backlog from CSV</h2>
            <div className="flex items-center gap-2 mt-1">
              {(['upload', 'staging', 'confirm'] as Step[]).map((s, i) => (
                <span key={s} className="flex items-center gap-1 text-xs">
                  {i > 0 && <span className="text-gray-300">›</span>}
                  <span className={`font-medium ${step === s ? 'text-red-600' : 'text-gray-400'}`}>
                    {i + 1}. {s === 'upload' ? 'Upload' : s === 'staging' ? 'Review & Edit' : 'Confirm'}
                  </span>
                </span>
              ))}
            </div>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl">✕</button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-auto p-6">
          {error && (
            <div className="mb-4 bg-red-50 text-red-700 text-sm px-4 py-3 rounded-lg border border-red-200">{error}</div>
          )}

          {/* Step 1: Upload */}
          {step === 'upload' && (
            <div className="text-center py-12">
              <p className="text-gray-500 mb-6 text-sm">Upload a CSV file with columns: Epic, Feature, Story, Task, ResourceType, HoursEffort, DurationDays, Description, Assumptions</p>
              <input ref={fileRef} type="file" accept=".csv" className="hidden" onChange={handleFileChange} />
              <button
                onClick={() => fileRef.current?.click()}
                disabled={loading}
                className="bg-red-600 text-white px-6 py-3 rounded-lg text-sm font-medium hover:bg-red-700 disabled:opacity-50 transition-colors"
              >
                {loading ? 'Parsing…' : '📂 Choose CSV file'}
              </button>
            </div>
          )}

          {/* Step 2: Staging table */}
          {step === 'staging' && (
            <div>
              {summary && (
                <div className="flex gap-4 mb-4 text-sm">
                  <span className="bg-gray-100 text-gray-700 px-3 py-1 rounded-full">{summary.total} rows</span>
                  {summary.errorCount > 0 && <span className="bg-red-100 text-red-700 px-3 py-1 rounded-full">{summary.errorCount} errors</span>}
                  {summary.warningCount > 0 && <span className="bg-yellow-100 text-yellow-700 px-3 py-1 rounded-full">{summary.warningCount} warnings</span>}
                </div>
              )}
              <div className="overflow-x-auto border border-gray-200 rounded-lg">
                <table className="w-full text-xs">
                  <thead className="bg-gray-50 border-b border-gray-200">
                    <tr>
                      {['Row', 'Epic', 'Feature', 'Story', 'Task', 'Resource Type', 'Hours', 'Days', 'Issues', ''].map(h => (
                        <th key={h} className="text-left px-3 py-2 text-gray-500 font-medium whitespace-nowrap">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {staged.map((row, i) => (
                      <tr key={i} className={`border-b border-gray-100 ${row.errors.length > 0 ? 'bg-red-50' : row.warnings.length > 0 ? 'bg-yellow-50' : ''}`}>
                        <td className="px-3 py-2 text-gray-400">{row.rowIndex}</td>
                        {(['epic', 'feature', 'story', 'task', 'resourceType'] as const).map(field => (
                          <td key={field} className="px-2 py-1">
                            {editingRow === i ? (
                              <input
                                className="border border-gray-300 rounded px-1 py-0.5 w-24 text-xs"
                                value={row[field] as string}
                                onChange={e => updateRow(i, field, e.target.value)}
                              />
                            ) : (
                              <span className="cursor-pointer hover:text-red-600" onClick={() => setEditingRow(i)}>{row[field] || <span className="text-gray-300 italic">empty</span>}</span>
                            )}
                          </td>
                        ))}
                        <td className="px-2 py-1">
                          {editingRow === i ? (
                            <input type="number" className="border border-gray-300 rounded px-1 py-0.5 w-16 text-xs" value={row.hoursEffort} onChange={e => updateRow(i, 'hoursEffort', parseFloat(e.target.value) || 0)} />
                          ) : (
                            <span className="cursor-pointer hover:text-red-600" onClick={() => setEditingRow(i)}>{row.hoursEffort || '—'}</span>
                          )}
                        </td>
                        <td className="px-2 py-1 text-gray-500">{row.durationDays || '—'}</td>
                        <td className="px-2 py-1">
                          {row.errors.map((e, j) => <div key={j} className="text-red-600">⚠ {e}</div>)}
                          {row.warnings.map((w, j) => <div key={j} className="text-yellow-600">⚡ {w}</div>)}
                        </td>
                        <td className="px-2 py-1">
                          <button onClick={() => removeRow(i)} className="text-gray-400 hover:text-red-600 text-xs">✕</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {editingRow !== null && (
                <p className="text-xs text-gray-400 mt-2">Click a cell to edit. Press elsewhere to deselect.</p>
              )}
            </div>
          )}

          {/* Step 3: Confirm */}
          {step === 'confirm' && (
            <div className="text-center py-12">
              <div className="text-5xl mb-4">📋</div>
              <h3 className="text-lg font-semibold text-gray-800 mb-2">Ready to import {staged.length} rows</h3>
              <p className="text-sm text-gray-500 mb-2">This will add epics, features, stories and tasks to your backlog.</p>
              <p className="text-sm text-gray-500">A snapshot of your current backlog will be saved automatically before import.</p>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-gray-100 flex justify-between items-center">
          <button onClick={onClose} className="text-sm text-gray-500 hover:text-gray-700">Cancel</button>
          <div className="flex gap-3">
            {step === 'staging' && (
              <button
                onClick={() => { setStep('upload'); setStaged([]); setSummary(null) }}
                className="border border-gray-200 text-gray-600 px-4 py-2 rounded-lg text-sm font-medium hover:bg-gray-50 transition-colors"
              >
                ← Re-upload
              </button>
            )}
            {step === 'staging' && (
              <button
                onClick={() => setStep('confirm')}
                disabled={staged.filter(r => r.errors.length > 0).length > 0}
                className="bg-red-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-red-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                Review & Confirm →
              </button>
            )}
            {step === 'confirm' && (
              <>
                <button onClick={() => setStep('staging')} className="border border-gray-200 text-gray-600 px-4 py-2 rounded-lg text-sm font-medium hover:bg-gray-50 transition-colors">← Back</button>
                <button
                  onClick={handleCommit}
                  disabled={loading}
                  className="bg-red-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-red-700 disabled:opacity-50 transition-colors"
                >
                  {loading ? 'Importing…' : '✓ Import Backlog'}
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
