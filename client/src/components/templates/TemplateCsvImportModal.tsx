import { useState, useRef } from 'react'
import { api } from '../../lib/api'

interface NewTemplate { name: string; category: string; taskCount: number }
interface UpdatedTemplate {
  id: string; name: string; category: string
  before: { taskCount: number; tasks: { name: string; resourceTypeName: string }[] }
  after: { taskCount: number; tasks: { name: string; resourceTypeName: string }[] }
}
interface RowError { row: number; message: string }
interface PreviewResult {
  newTemplates: NewTemplate[]
  updatedTemplates: UpdatedTemplate[]
  errors: RowError[]
}

interface Props {
  onClose: () => void
  onImported: () => void
}

export default function TemplateCsvImportModal({ onClose, onImported }: Props) {
  const [step, setStep] = useState<'upload' | 'review' | 'done'>('upload')
  const [csvText, setCsvText] = useState('')
  const [preview, setPreview] = useState<PreviewResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)

  const handleFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = ev => setCsvText(ev.target?.result as string)
    reader.readAsText(file)
  }

  const handlePreview = async () => {
    if (!csvText.trim()) { setError('Please select a CSV file'); return }
    setLoading(true); setError('')
    try {
      const { data } = await api.post('/templates/import-csv/preview', { csv: csvText })
      setPreview(data)
      setStep('review')
    } catch (e: unknown) {
      const msg = (e as { response?: { data?: { detail?: string; error?: string } } })?.response?.data
      setError(msg?.detail ?? msg?.error ?? 'Preview failed')
    } finally { setLoading(false) }
  }

  const handleImport = async () => {
    setLoading(true); setError('')
    try {
      await api.post('/templates/import-csv', { csv: csvText })
      setStep('done')
      onImported()
    } catch (e: unknown) {
      const msg = (e as { response?: { data?: { error?: string } } })?.response?.data
      setError(msg?.error ?? 'Import failed')
    } finally { setLoading(false) }
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-2xl max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b">
          <h2 className="text-lg font-semibold text-gray-900">Import Templates CSV</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none">&times;</button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {step === 'upload' && (
            <div className="space-y-4">
              <p className="text-sm text-gray-600">
                Upload a CSV to create new templates or update existing ones by matching on <code className="bg-gray-100 px-1 rounded">TemplateName</code>.
              </p>
              <div className="border-2 border-dashed border-gray-300 rounded-lg p-6 text-center">
                <input ref={fileRef} type="file" accept=".csv" onChange={handleFile} className="hidden" />
                <button onClick={() => fileRef.current?.click()} className="text-sm text-red-600 underline">
                  {csvText ? '✓ File loaded — click to change' : 'Choose CSV file'}
                </button>
                {csvText && <p className="text-xs text-gray-500 mt-1">{csvText.split('\n').length - 1} data rows</p>}
              </div>
              <a href="/api/templates/export-csv" className="text-xs text-gray-400 underline">Download current templates as CSV template</a>
              {error && <p className="text-sm text-red-600">{error}</p>}
            </div>
          )}

          {step === 'review' && preview && (
            <div className="space-y-4">
              {preview.errors.length > 0 && (
                <div className="bg-red-50 border border-red-200 rounded-lg p-3">
                  <p className="text-sm font-medium text-red-700 mb-2">⚠ Parse errors ({preview.errors.length})</p>
                  <ul className="text-xs text-red-600 space-y-1">
                    {preview.errors.map((e, i) => <li key={i}>Row {e.row}: {e.message}</li>)}
                  </ul>
                </div>
              )}

              {preview.newTemplates.length > 0 && (
                <div>
                  <p className="text-sm font-medium text-gray-700 mb-2">New templates ({preview.newTemplates.length})</p>
                  <div className="space-y-1">
                    {preview.newTemplates.map((t, i) => (
                      <div key={i} className="flex items-center gap-2 text-sm p-2 bg-green-50 rounded">
                        <span className="bg-green-600 text-white text-xs font-bold px-1.5 py-0.5 rounded">NEW</span>
                        <span className="font-medium">{t.name}</span>
                        {t.category && <span className="text-gray-400">· {t.category}</span>}
                        <span className="text-gray-400 ml-auto">{t.taskCount} tasks</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {preview.updatedTemplates.length > 0 && (
                <div>
                  <p className="text-sm font-medium text-gray-700 mb-2">Templates to update ({preview.updatedTemplates.length})</p>
                  <div className="space-y-2">
                    {preview.updatedTemplates.map((t, i) => (
                      <div key={i} className="p-2 bg-yellow-50 border border-yellow-200 rounded">
                        <div className="flex items-center gap-2 text-sm mb-2">
                          <span className="bg-yellow-500 text-white text-xs font-bold px-1.5 py-0.5 rounded">UPDATE</span>
                          <span className="font-medium">{t.name}</span>
                          <span className="text-gray-400 ml-auto">
                            {t.before.taskCount} → {t.after.taskCount} tasks
                          </span>
                        </div>
                        <div className="grid grid-cols-2 gap-2 text-xs text-gray-500">
                          <div>
                            <p className="font-medium text-gray-600 mb-1">Before</p>
                            {t.before.tasks.map((tk, j) => <p key={j}>{tk.name} <span className="text-gray-400">({tk.resourceTypeName})</span></p>)}
                          </div>
                          <div>
                            <p className="font-medium text-gray-600 mb-1">After</p>
                            {t.after.tasks.map((tk, j) => <p key={j}>{tk.name} <span className="text-gray-400">({tk.resourceTypeName})</span></p>)}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {preview.newTemplates.length === 0 && preview.updatedTemplates.length === 0 && preview.errors.length === 0 && (
                <p className="text-sm text-gray-500 text-center py-4">No changes detected.</p>
              )}

              {error && <p className="text-sm text-red-600">{error}</p>}
            </div>
          )}

          {step === 'done' && (
            <div className="text-center py-8">
              <div className="text-4xl mb-2">✓</div>
              <p className="text-gray-700 font-medium">Import complete</p>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-between items-center p-4 border-t gap-2">
          {step === 'upload' && (
            <>
              <button onClick={onClose} className="text-sm text-gray-500 hover:text-gray-700">Cancel</button>
              <button
                onClick={handlePreview} disabled={loading || !csvText}
                className="bg-red-600 text-white text-sm px-4 py-2 rounded-lg hover:bg-red-700 disabled:opacity-50"
              >
                {loading ? 'Parsing…' : 'Review & Confirm →'}
              </button>
            </>
          )}
          {step === 'review' && (
            <>
              <button onClick={() => setStep('upload')} className="text-sm text-gray-500 hover:text-gray-700">← Back</button>
              <button
                onClick={handleImport} disabled={loading || (preview?.newTemplates.length === 0 && preview?.updatedTemplates.length === 0)}
                className="bg-red-600 text-white text-sm px-4 py-2 rounded-lg hover:bg-red-700 disabled:opacity-50"
              >
                {loading ? 'Importing…' : `✓ Import Templates`}
              </button>
            </>
          )}
          {step === 'done' && (
            <button onClick={onClose} className="ml-auto bg-gray-100 text-gray-700 text-sm px-4 py-2 rounded-lg hover:bg-gray-200">
              Close
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
