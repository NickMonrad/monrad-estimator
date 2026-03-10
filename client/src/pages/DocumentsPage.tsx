import { useState, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { PDFViewer, pdf } from '@react-pdf/renderer'
import { api } from '../lib/api'
import ScopeDocument from '../components/documents/ScopeDocument'
import type { ScopeDocumentProps } from '../components/documents/ScopeDocument'

interface GeneratedDoc {
  id: string
  label: string
  format: string
  type: string
  createdAt: string
  generatedBy: { email: string }
}

function defaultLabel(): string {
  return `Scope Document — ${new Date().toLocaleDateString('en-AU', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  })}`
}

export default function DocumentsPage() {
  const { id: projectId } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  const [sections, setSections] = useState({
    cover: true,
    scope: true,
    effort: true,
    timeline: true,
    resourceProfile: true,
    assumptions: true,
  })
  const [label, setLabel] = useState(defaultLabel)
  const [generating, setGenerating] = useState(false)
  const [generateError, setGenerateError] = useState<string | null>(null)

  // ── Data fetching ──────────────────────────────────────────────
  const { data: project } = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => api.get(`/projects/${projectId}`).then(r => r.data),
    enabled: !!projectId,
  })

  const { data: effortData } = useQuery({
    queryKey: ['effort', projectId],
    queryFn: () => api.get(`/projects/${projectId}/effort`).then(r => r.data),
    enabled: !!projectId,
  })

  const { data: timelineData } = useQuery({
    queryKey: ['timeline', projectId],
    queryFn: () => api.get(`/projects/${projectId}/timeline`).then(r => r.data),
    enabled: !!projectId,
  })

  const { data: resourceProfileData } = useQuery({
    queryKey: ['resource-profile', projectId],
    queryFn: () => api.get(`/projects/${projectId}/resource-profile`).then(r => r.data),
    enabled: !!projectId,
  })

  const { data: epics = [] } = useQuery({
    queryKey: ['epics', projectId],
    queryFn: () => api.get(`/projects/${projectId}/epics`).then(r => r.data),
    enabled: !!projectId,
  })

  const { data: generatedDocs = [], isLoading: docsLoading } = useQuery<GeneratedDoc[]>({
    queryKey: ['generated-docs', projectId],
    queryFn: () => api.get(`/projects/${projectId}/documents`).then(r => r.data),
    enabled: !!projectId,
  })

  // ── Derived "all data loaded" flag ────────────────────────────
  const allLoaded = !!(project && effortData && timelineData && resourceProfileData)

  // ── Build props for ScopeDocument ─────────────────────────────
  const scopeDocProps: ScopeDocumentProps = {
    project: {
      name: project?.name ?? '',
      customer: project?.customer ?? null,
      description: project?.description ?? null,
      startDate: project?.startDate ?? null,
    },
    sections,
    effortData: effortData ?? null,
    timelineData: timelineData ?? null,
    resourceProfileData: resourceProfileData ?? null,
    epics: epics ?? [],
  }

  // ── Generate & Save ───────────────────────────────────────────
  const handleGenerate = useCallback(async () => {
    if (!allLoaded) return
    setGenerating(true)
    setGenerateError(null)
    try {
      const blob = await pdf(<ScopeDocument {...scopeDocProps} />).toBlob()
      const base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => {
          const result = reader.result as string
          // strip data URL prefix: "data:application/pdf;base64,"
          const b64 = result.split(',')[1]
          resolve(b64)
        }
        reader.onerror = reject
        reader.readAsDataURL(blob)
      })

      await api.post(`/projects/${projectId}/documents/generate`, {
        type: 'SCOPE_DOC',
        format: 'pdf',
        label,
        pdfBase64: base64,
      })

      queryClient.invalidateQueries({ queryKey: ['generated-docs', projectId] })
      // Reset label with today's date for next generation
      setLabel(defaultLabel())
    } catch (err: any) {
      setGenerateError(err?.response?.data?.error ?? err?.message ?? 'Failed to generate document')
    } finally {
      setGenerating(false)
    }
  }, [allLoaded, scopeDocProps, projectId, label, queryClient])

  // ── Delete document ───────────────────────────────────────────
  const handleDelete = useCallback(async (docId: string) => {
    if (!confirm('Delete this document?')) return
    try {
      await api.delete(`/projects/${projectId}/documents/${docId}`)
      queryClient.invalidateQueries({ queryKey: ['generated-docs', projectId] })
    } catch (err: any) {
      alert(err?.response?.data?.error ?? 'Failed to delete document')
    }
  }, [projectId, queryClient])

  // ── Download document (JWT-authenticated) ─────────────────────
  const handleDownload = useCallback(async (doc: GeneratedDoc) => {
    try {
      const response = await api.get(
        `/projects/${projectId}/documents/${doc.id}/download`,
        { responseType: 'blob' }
      )
      const url = URL.createObjectURL(response.data)
      const a = document.createElement('a')
      a.href = url
      a.download = `${doc.label}.${doc.format}`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
    } catch (err: any) {
      alert('Download failed')
    }
  }, [projectId])

  const toggleSection = (key: keyof typeof sections) => {
    setSections(prev => ({ ...prev, [key]: !prev[key] }))
  }

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white border-b border-gray-200 px-6 py-4">
        <nav className="text-sm text-gray-500 flex items-center gap-1 mb-1">
          <button onClick={() => navigate('/')} className="hover:text-gray-700">Monrad Estimator</button>
          <span>/</span>
          <button onClick={() => navigate(`/projects/${projectId}`)} className="hover:text-gray-700">
            {project?.name ?? '…'}
          </button>
          <span>/</span>
          <span className="text-gray-900 font-medium">Documents</span>
        </nav>
        <h1 className="text-xl font-semibold text-gray-900">Documents</h1>
      </header>

      <div className="max-w-screen-xl mx-auto px-6 py-6 flex gap-6">
        {/* ── Left column: PDF Viewer ── */}
        <div className="flex-1" style={{ minWidth: 0 }}>
          <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
            {allLoaded ? (
              <PDFViewer style={{ width: '100%', height: '700px' }}>
                <ScopeDocument {...scopeDocProps} />
              </PDFViewer>
            ) : (
              <div className="flex items-center justify-center h-64 text-gray-400">
                Loading preview…
              </div>
            )}
          </div>
        </div>

        {/* ── Right column: Controls ── */}
        <div className="w-80 flex-shrink-0 space-y-4">

          {/* Document type */}
          <div className="bg-white rounded-lg border border-gray-200 p-4">
            <h2 className="text-sm font-semibold text-gray-700 mb-3">Document Type</h2>
            <div className="space-y-2">
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="radio" name="docType" defaultChecked className="accent-red-600" />
                <span className="text-sm text-gray-800">Scope Document</span>
              </label>
              <label className="flex items-center gap-2 opacity-40 cursor-not-allowed">
                <input type="radio" name="docType" disabled />
                <span className="text-sm text-gray-800">SOW <span className="text-xs text-gray-400">(coming soon)</span></span>
              </label>
              <label className="flex items-center gap-2 opacity-40 cursor-not-allowed">
                <input type="radio" name="docType" disabled />
                <span className="text-sm text-gray-800">Proposal Deck <span className="text-xs text-gray-400">(coming soon)</span></span>
              </label>
            </div>
          </div>

          {/* Sections */}
          <div className="bg-white rounded-lg border border-gray-200 p-4">
            <h2 className="text-sm font-semibold text-gray-700 mb-3">Sections</h2>
            <div className="space-y-2">
              {([
                ['cover', 'Cover Page'],
                ['scope', 'Scope Summary'],
                ['effort', 'Effort Breakdown'],
                ['timeline', 'Timeline Summary'],
                ['resourceProfile', 'Resource Profile'],
                ['assumptions', 'Assumptions'],
              ] as const).map(([key, label]) => (
                <label key={key} className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={sections[key]}
                    onChange={() => toggleSection(key)}
                    className="accent-red-600"
                  />
                  <span className="text-sm text-gray-800">{label}</span>
                </label>
              ))}
            </div>
          </div>

          {/* Label */}
          <div className="bg-white rounded-lg border border-gray-200 p-4">
            <h2 className="text-sm font-semibold text-gray-700 mb-2">Document Label</h2>
            <input
              type="text"
              value={label}
              onChange={e => setLabel(e.target.value)}
              className="w-full text-sm border border-gray-300 rounded px-3 py-2 focus:outline-none focus:border-red-400"
              placeholder="Label for this document"
            />
          </div>

          {/* Generate button */}
          <button
            onClick={handleGenerate}
            disabled={!allLoaded || generating}
            className="w-full bg-red-600 hover:bg-red-700 disabled:opacity-50 text-white text-sm font-medium py-2.5 px-4 rounded-lg transition-colors"
          >
            {generating ? 'Generating…' : 'Generate & Save'}
          </button>

          {generateError && (
            <p className="text-xs text-red-600">{generateError}</p>
          )}

          {/* Generated documents history */}
          <div className="bg-white rounded-lg border border-gray-200 p-4">
            <h2 className="text-sm font-semibold text-gray-700 mb-3">Generated Documents</h2>

            {docsLoading ? (
              <p className="text-xs text-gray-400">Loading…</p>
            ) : generatedDocs.length === 0 ? (
              <p className="text-xs text-gray-400">No documents generated yet.</p>
            ) : (
              <ul className="space-y-3">
                {generatedDocs.map(doc => (
                  <li key={doc.id} className="flex items-start gap-2 text-sm">
                    <div className="flex-1 min-w-0">
                      <p className="font-medium text-gray-800 truncate">{doc.label}</p>
                      <p className="text-xs text-gray-400">
                        {new Date(doc.createdAt).toLocaleDateString('en-AU', {
                          year: 'numeric', month: 'short', day: 'numeric',
                        })}
                        {' · '}
                        {doc.generatedBy.email}
                      </p>
                    </div>
                    <span className="flex-shrink-0 text-xs bg-gray-100 text-gray-600 px-2 py-0.5 rounded-full uppercase">
                      {doc.format}
                    </span>
                    <button
                      onClick={() => handleDownload(doc)}
                      className="flex-shrink-0 text-xs text-red-600 hover:text-red-700 font-medium"
                      title="Download"
                    >
                      ↓
                    </button>
                    <button
                      onClick={() => handleDelete(doc.id)}
                      className="flex-shrink-0 text-xs text-gray-400 hover:text-red-500"
                      title="Delete"
                    >
                      ✕
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
