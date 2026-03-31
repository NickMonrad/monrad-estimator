import { useState, useCallback, useEffect } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/api'
import { getProjectCustomerName } from '../lib/projectCustomer'
import { useAuth } from '../hooks/useAuth'
import ThemeToggle from '../components/layout/ThemeToggle'
import type { Project } from '../types/backlog'

interface GeneratedDoc {
  id: string
  label: string
  format: string
  type: string
  createdAt: string
  sections?: Record<string, boolean> | null
  generatedBy: { email: string }
}

function defaultLabel(projectName?: string): string {
  const now = new Date()
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
  const date = now.toLocaleDateString('en-AU', { year: 'numeric', month: 'long', day: 'numeric', timeZone: tz })
  const time = now.toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: tz })
  const suffix = `Scope Document — ${date} ${time}`
  return projectName ? `${projectName} - ${suffix}` : suffix
}

export default function DocumentsPage() {
  const { id: projectId } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { user, logout } = useAuth()

  const [sections, setSections] = useState({
    cover: true,
    scope: true,
    effort: true,
    timeline: true,
    resourceProfile: true,
    assumptions: true,
    ganttChart: true,
  })
  const [label, setLabel] = useState(defaultLabel)
  const [generating, setGenerating] = useState(false)
  const [generateError, setGenerateError] = useState<string | null>(null)

  // ── Data fetching ──────────────────────────────────────────────
  const { data: project } = useQuery<Project>({
    queryKey: ['project', projectId],
    queryFn: () => api.get(`/projects/${projectId}`).then(r => r.data),
    enabled: !!projectId,
  })

  // Update default label once project name is known
  useEffect(() => {
    if (project?.name) setLabel(defaultLabel(project.name))
  }, [project?.name])

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

  // ── Generate & Save ───────────────────────────────────────────
  const handleGenerate = useCallback(async () => {
    if (!allLoaded) return
    setGenerating(true)
    setGenerateError(null)
    try {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
      await api.post(`/projects/${projectId}/documents/generate`, {
        type: 'SCOPE_DOC',
        format: 'pdf',
        label,
        tz,
        documentData: {
          project: {
            name: project?.name ?? '',
            customer: getProjectCustomerName(project?.customer),
            description: project?.description ?? null,
            startDate: project?.startDate ?? null,
            endDate: timelineData?.projectedEndDate ?? null,
          },
          sections,
          effortData: effortData ?? null,
          timelineData: timelineData ?? null,
          resourceProfileData: resourceProfileData ?? null,
          epics: epics ?? [],
          generatedBy: user?.name ?? user?.email ?? 'Monrad Estimator',
          documentLabel: label,
        },
      })
      queryClient.invalidateQueries({ queryKey: ['generated-docs', projectId] })
      setLabel(defaultLabel(project?.name))
    } catch (err: any) {
      setGenerateError(err?.response?.data?.error ?? err?.message ?? 'Failed to generate document')
    } finally {
      setGenerating(false)
    }
  }, [allLoaded, project, effortData, timelineData, resourceProfileData, epics, sections, label, projectId, queryClient, user])

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
    } catch {
      alert('Download failed')
    }
  }, [projectId])

  const toggleSection = (key: keyof typeof sections) => {
    setSections(prev => ({ ...prev, [key]: !prev[key] }))
  }

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
      {/* Header */}
      <header className="bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400">
            <button onClick={() => navigate('/')} className="flex items-center gap-2 group">
              <div className="w-8 h-8 bg-lab3-navy rounded-lg flex items-center justify-center"><span className="text-white text-xs font-bold">M</span></div>
              <span className="font-semibold text-gray-900 dark:text-white group-hover:text-lab3-navy dark:group-hover:text-lab3-blue transition-colors">Monrad Estimator</span>
            </button>
            <span>/</span>
            <button onClick={() => navigate(`/projects/${projectId}`)} className="hover:text-lab3-navy dark:hover:text-lab3-blue transition-colors">{project?.name ?? '…'}</button>
            <span>/</span>
            <span className="text-gray-700 dark:text-gray-300">Documents</span>
          </div>
          <div className="flex items-center gap-3">
            <ThemeToggle />
            <span className="text-sm text-gray-500 dark:text-gray-400">{user?.name}</span>
            <button onClick={logout} className="text-sm text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200">Sign out</button>
          </div>
        </div>
      </header>

      <div className="max-w-5xl mx-auto px-6 py-8 space-y-6">

        {/* ── Generation panel ── */}
        <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-6">
          <div className="flex items-start gap-8">

            {/* Left: Document Type (~200px) */}
            <div className="flex-shrink-0" style={{ width: '200px' }}>
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">Document Type</p>
              <div className="space-y-2">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="radio" name="docType" defaultChecked className="accent-lab3-navy" />
                  <span className="text-sm text-gray-800 dark:text-gray-200">Scope Document</span>
                </label>
                <label className="flex items-center gap-2 opacity-40 cursor-not-allowed">
                  <input type="radio" name="docType" disabled />
                  <span className="text-sm text-gray-800 dark:text-gray-200">SOW <span className="text-xs text-gray-400 dark:text-gray-500">(coming soon)</span></span>
                </label>
                <label className="flex items-center gap-2 opacity-40 cursor-not-allowed">
                  <input type="radio" name="docType" disabled />
                  <span className="text-sm text-gray-800 dark:text-gray-200">Proposal Deck <span className="text-xs text-gray-400 dark:text-gray-500">(coming soon)</span></span>
                </label>
              </div>
            </div>

            {/* Middle: Sections (flex-1) */}
            <div className="flex-1">
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">Sections</p>
              <div className="grid grid-cols-3 gap-2">
                {([
                  ['cover', 'Cover Page'],
                  ['scope', 'Scope Summary'],
                  ['effort', 'Effort Breakdown'],
                  ['ganttChart', 'Gantt Chart'],
                  ['timeline', 'Timeline Summary'],
                  ['resourceProfile', 'Resource Profile'],
                  ['assumptions', 'Assumptions'],
                ] as const).map(([key, sectionLabel]) => (
                  <label key={key} className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={sections[key]}
                      onChange={() => toggleSection(key)}
                      className="accent-lab3-navy"
                    />
                    <span className="text-sm text-gray-800 dark:text-gray-200">{sectionLabel}</span>
                  </label>
                ))}
              </div>
            </div>

            {/* Right: Label + Generate (~280px) */}
            <div className="flex-shrink-0" style={{ width: '280px' }}>
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">Document Label</p>
              <input
                type="text"
                value={label}
                onChange={e => setLabel(e.target.value)}
                className="w-full text-sm border border-gray-300 dark:border-gray-600 rounded px-3 py-2 bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:outline-none focus:border-lab3-navy mb-3"
                placeholder="Label for this document"
              />
              <button
                onClick={handleGenerate}
                disabled={!allLoaded || generating}
                className="w-full bg-lab3-navy hover:bg-lab3-blue disabled:opacity-50 text-white text-sm font-medium py-2.5 px-4 rounded-lg transition-colors"
              >
                {generating ? 'Generating…' : 'Generate & Save'}
              </button>
              {generateError && (
                <p className="text-xs text-red-600 mt-2">{generateError}</p>
              )}
            </div>

          </div>
        </div>

        {/* ── Documents grid ── */}
        <div>
          <div className="flex items-center gap-3 mb-4">
            <h2 className="text-base font-semibold text-gray-900 dark:text-white">Generated Documents</h2>
            <span className="text-xs bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-400 px-2 py-0.5 rounded-full">
              {generatedDocs.length}
            </span>
          </div>

          {docsLoading ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {[0, 1, 2].map(i => (
                <div key={i} className="bg-gray-100 dark:bg-gray-700 rounded-lg h-36 animate-pulse" />
              ))}
            </div>
          ) : generatedDocs.length === 0 ? (
            <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-10 text-center">
              <div className="text-4xl mb-3">📄</div>
              <p className="text-sm text-gray-500 dark:text-gray-400">
                No documents generated yet. Use the panel above to generate your first scope document.
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {generatedDocs.map(doc => {
                const typeLabel = doc.type === 'SCOPE_DOC' ? 'Scope Document' : doc.type
                const dateStr =
                  new Date(doc.createdAt).toLocaleDateString('en-AU', {
                    day: 'numeric', month: 'short', year: 'numeric',
                  }) +
                  ', ' +
                  new Date(doc.createdAt).toLocaleTimeString('en-AU', {
                    hour: '2-digit', minute: '2-digit', hour12: false,
                  })
                const sectionLabels: Record<string, string> = {
                  cover: 'Cover', scope: 'Scope', effort: 'Effort',
                  timeline: 'Timeline', resourceProfile: 'Resources', assumptions: 'Assumptions',
                  ganttChart: 'Gantt',
                }
                const includedSections = doc.sections
                  ? Object.entries(doc.sections).filter(([, v]) => v).map(([k]) => sectionLabels[k] ?? k)
                  : null
                return (
                  <div key={doc.id} className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-4 flex flex-col gap-3">
                    {/* Top row: PDF badge + format badge */}
                    <div className="flex items-center justify-between">
                      <span className="bg-red-100 text-red-600 text-xs font-bold px-2 py-1 rounded">PDF</span>
                      <span className="text-xs bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 px-2 py-0.5 rounded-full uppercase">
                        {doc.format}
                      </span>
                    </div>
                    {/* Label */}
                    <p className="text-sm font-semibold text-gray-900 dark:text-white">{doc.label}</p>
                    {/* Type */}
                    <p className="text-xs text-gray-500 dark:text-gray-400">{typeLabel}</p>
                    {/* Sections */}
                    {includedSections && (
                      <div className="flex flex-wrap gap-1">
                        {includedSections.map(s => (
                          <span key={s} className="text-xs bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400 px-1.5 py-0.5 rounded">
                            {s}
                          </span>
                        ))}
                      </div>
                    )}
                    {/* Meta */}
                    <p className="text-xs text-gray-400">{dateStr} · {doc.generatedBy.email}</p>
                    {/* Actions */}
                    <div className="flex items-center mt-auto">
                      <button
                        onClick={() => handleDownload(doc)}
                        className="bg-lab3-navy hover:bg-lab3-blue text-white text-xs font-medium px-3 py-1.5 rounded transition-colors"
                      >
                        Download
                      </button>
                      <button
                        onClick={() => handleDelete(doc.id)}
                        className="text-xs text-gray-400 hover:text-red-500 ml-auto transition-colors"
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>

      </div>
    </div>
  )
}
