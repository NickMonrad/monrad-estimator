import { useState, useEffect } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { invalidateProjectAll, invalidateProjectDocumentData } from '../lib/projectInvalidation'
import { api, apiErrorMessage, getCustomers, getOrgs, moveProjectToOrg } from '../lib/api'
import AppLayout from '../components/layout/AppLayout'
import RichTextEditor from '../components/shared/RichTextEditor'

const STATUS_OPTIONS = ['DRAFT', 'ACTIVE', 'REVIEW', 'COMPLETE', 'ARCHIVED']

interface Customer {
  id: string
  name: string
}

interface Org {
  id: string
  name: string
}

interface ProjectDependency {
  id: string
  description: string
  order: number
}

interface ProjectRisk {
  id: string
  description: string
  mitigation: string | null
  order: number
}

export default function ProjectSettingsPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const qc = useQueryClient()

  const [form, setForm] = useState({ name: '', description: '', customerId: '', status: 'DRAFT', hoursPerDay: 7.6, bufferWeeks: 0, onboardingWeeks: 0, taxRate: 10, taxLabel: 'GST' })
  const [saved, setSaved] = useState(false)
  const [customers, setCustomers] = useState<Customer[]>([])
  const [orgs, setOrgs] = useState<Org[]>([])
  const [selectedOrgId, setSelectedOrgId] = useState('')
  const [orgSaved, setOrgSaved] = useState(false)
  const [dropdownError, setDropdownError] = useState<string | null>(null)
  const [metadataError, setMetadataError] = useState<string | null>(null)
  const [newDependency, setNewDependency] = useState('')
  const [newRisk, setNewRisk] = useState({ description: '', mitigation: '' })
  const [editingDependency, setEditingDependency] = useState<{ id: string; description: string } | null>(null)
  const [editingRisk, setEditingRisk] = useState<{ id: string; description: string; mitigation: string } | null>(null)
  const [metadataBusy, setMetadataBusy] = useState<string | null>(null)

  const { data: project, isLoading } = useQuery({
    queryKey: ['project', id],
    queryFn: () => api.get(`/projects/${id}`).then(r => r.data),
  })

  const { data: dependencies = [], isLoading: dependenciesLoading, isError: dependenciesLoadError } = useQuery<ProjectDependency[]>({
    queryKey: ['project-dependencies', id],
    queryFn: () => api.get(`/projects/${id}/dependencies`).then(r => r.data),
    enabled: !!id,
  })

  const { data: risks = [], isLoading: risksLoading, isError: risksLoadError } = useQuery<ProjectRisk[]>({
    queryKey: ['project-risks', id],
    queryFn: () => api.get(`/projects/${id}/risks`).then(r => r.data),
    enabled: !!id,
  })

  useEffect(() => {
    Promise.all([
      getCustomers().then(setCustomers),
      getOrgs().then(setOrgs),
    ]).catch(() => {
      setDropdownError('Failed to load customer / team data. Some dropdowns may be unavailable.')
    })
  }, [])
  useEffect(() => {
    setNewDependency('')
    setNewRisk({ description: '', mitigation: '' })
    setEditingDependency(null)
    setEditingRisk(null)
    setMetadataBusy(null)
    setMetadataError(null)
  }, [id])


  useEffect(() => {
    if (project) {
      setForm({
        name: project.name ?? '',
        description: project.description ?? '',
        customerId: project.customerId ?? '',
        status: project.status ?? 'DRAFT',
        hoursPerDay: project.hoursPerDay ?? 7.6,
        bufferWeeks: project.bufferWeeks ?? 0,
        onboardingWeeks: project.onboardingWeeks ?? 0,
        taxRate: project.taxRate ?? 10,
        taxLabel: project.taxLabel ?? 'GST',
      })
      setSelectedOrgId(project.orgId ?? '')
    }
  }, [project])

  const updateProject = useMutation({
    mutationFn: (data: typeof form) => api.put(`/projects/${id}`, data),
    onSuccess: () => {
      invalidateProjectAll(qc, id)
      qc.invalidateQueries({ queryKey: ['projects'] })
      setSaved(true)
      setTimeout(() => setSaved(false), 3000)
    },
  })

  const f = (field: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => {
    const value = field === 'hoursPerDay' ? parseFloat(e.target.value) || 7.6 : e.target.value
    setForm(v => ({ ...v, [field]: value }))
  }

  const refreshMetadata = async () => {
    await invalidateProjectDocumentData(qc, id)
  }

  const runMetadataAction = async (action: string, request: () => Promise<unknown>): Promise<boolean> => {
    setMetadataBusy(action)
    setMetadataError(null)
    try {
      await request()
      await refreshMetadata()
      return true
    } catch (err) {
      setMetadataError(apiErrorMessage(err, 'Failed to save project dependencies and risks'))
      return false
    } finally {
      setMetadataBusy(null)
    }
  }

  const addDependency = () => {
    const description = newDependency
    if (!description.trim()) return
    void runMetadataAction('add-dependency', () => api.post(`/projects/${id}/dependencies`, { description }))
      .then(success => {
        if (success) setNewDependency('')
      })
  }

  const saveDependency = () => {
    const dependency = editingDependency
    if (!dependency?.description.trim()) return
    void runMetadataAction(`edit-dependency-${dependency.id}`, () => api.put(`/projects/${id}/dependencies/${dependency.id}`, {
      description: dependency.description,
    })).then(success => {
      if (success) setEditingDependency(null)
    })
  }

  const deleteDependency = (dependencyId: string) => {
    if (!window.confirm('Delete this dependency?')) return
    void runMetadataAction(`delete-dependency-${dependencyId}`, () => api.delete(`/projects/${id}/dependencies/${dependencyId}`))
  }

  const moveDependency = (index: number, direction: -1 | 1) => {
    const target = index + direction
    if (target < 0 || target >= dependencies.length) return
    const reordered = [...dependencies]
    const [moved] = reordered.splice(index, 1)
    reordered.splice(target, 0, moved)
    void runMetadataAction('reorder-dependencies', () => api.patch(`/projects/${id}/dependencies/reorder`, {
      items: reordered.map((item, order) => ({ id: item.id, order })),
    }))
  }

  const addRisk = () => {
    const risk = newRisk
    if (!risk.description.trim()) return
    void runMetadataAction('add-risk', () => api.post(`/projects/${id}/risks`, {
      description: risk.description,
      mitigation: risk.mitigation,
    })).then(success => {
      if (success) setNewRisk({ description: '', mitigation: '' })
    })
  }

  const saveRisk = () => {
    const risk = editingRisk
    if (!risk?.description.trim()) return
    void runMetadataAction(`edit-risk-${risk.id}`, () => api.put(`/projects/${id}/risks/${risk.id}`, {
      description: risk.description,
      mitigation: risk.mitigation,
    })).then(success => {
      if (success) setEditingRisk(null)
    })
  }

  const deleteRisk = (riskId: string) => {
    if (!window.confirm('Delete this risk?')) return
    void runMetadataAction(`delete-risk-${riskId}`, () => api.delete(`/projects/${id}/risks/${riskId}`))
  }

  const moveRisk = (index: number, direction: -1 | 1) => {
    const target = index + direction
    if (target < 0 || target >= risks.length) return
    const reordered = [...risks]
    const [moved] = reordered.splice(index, 1)
    reordered.splice(target, 0, moved)
    void runMetadataAction('reorder-risks', () => api.patch(`/projects/${id}/risks/reorder`, {
      items: reordered.map((item, order) => ({ id: item.id, order })),
    }))
  }

  if (isLoading) return <div className="min-h-screen flex items-center justify-center text-gray-400">Loading…</div>
  if (!project) return <div className="min-h-screen flex items-center justify-center text-gray-400">Project not found</div>

  return (
    <AppLayout
      breadcrumb={<>
          <span>/</span>
          <button onClick={() => navigate(`/projects/${id}`)} className="hover:text-lab3-navy dark:hover:text-lab3-blue transition-colors">
            {project?.name ?? '…'}
          </button>
          <span>/</span>
          <span className="text-gray-700 dark:text-gray-300">Settings</span>
        </>}
    >
      <main className="max-w-2xl mx-auto px-6 py-8">
        <h1 className="text-xl font-semibold text-gray-900 mb-6">Project Settings</h1>

        {dropdownError && (
          <div className="mb-4 p-3 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700 rounded-lg text-sm text-amber-700 dark:text-amber-400">
            ⚠️ {dropdownError}
          </div>
        )}

        <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 p-6 space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Project name *</label>
            <input
              type="text" value={form.name} onChange={f('name')}
              className="w-full border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-lab3-blue"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Organisation</label>
            <div className="flex gap-2 items-center">
              <select
                value={selectedOrgId}
                onChange={e => { setSelectedOrgId(e.target.value); setOrgSaved(false) }}
                className="flex-1 border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-red-500"
              >
                <option value="">Personal project</option>
                {orgs.map(o => (
                  <option key={o.id} value={o.id}>{o.name}</option>
                ))}
              </select>
              <button
                type="button"
                onClick={async () => {
                  await moveProjectToOrg(id!, selectedOrgId)
                  invalidateProjectAll(qc, id!)
                  setOrgSaved(true)
                  setTimeout(() => setOrgSaved(false), 2000)
                }}
                disabled={selectedOrgId === (project?.orgId ?? '')}
                className="px-3 py-2 text-sm bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-lg disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                {orgSaved ? '✓ Saved' : 'Apply'}
              </button>
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Customer</label>
            <select
              value={form.customerId} onChange={f('customerId')}
              className="w-full border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-red-500"
            >
              <option value="">No customer</option>
              {customers.map(c => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Description</label>
            <RichTextEditor
              value={form.description}
              onChange={v => setForm(prev => ({ ...prev, description: v }))}
              placeholder="Project description"
              className="text-sm"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Status</label>
            <select
              value={form.status} onChange={f('status')}
              className="w-full border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-lab3-blue"
            >
              {STATUS_OPTIONS.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Onboarding weeks</label>
            <input
              type="number" value={form.onboardingWeeks}
              onChange={e => setForm(v => ({ ...v, onboardingWeeks: parseInt(e.target.value) || 0 }))}
              min={0} max={52} step={1}
              className="w-full border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-lab3-blue"
            />
            <p className="text-xs text-gray-400 mt-1">Weeks reserved at the START of the project for onboarding.</p>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Buffer weeks</label>
            <input
              type="number" value={form.bufferWeeks}
              onChange={e => setForm(v => ({ ...v, bufferWeeks: parseInt(e.target.value) || 0 }))}
              min={0} max={52} step={1}
              className="w-full border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-lab3-blue"
            />
            <p className="text-xs text-gray-400 mt-1">Weeks reserved at the END of the project (e.g. for handover). Affects FULL_PROJECT allocation and timeline display.</p>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Hours per day</label>
            <input
              type="number" value={form.hoursPerDay} onChange={f('hoursPerDay')}
              min={1} max={24} step={0.1}
              className="w-full border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-lab3-blue"
            />
            <p className="text-xs text-gray-400 mt-1">Used to convert hours to days in estimates. Default is 7.6h.</p>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Tax label (e.g. GST, VAT)</label>
              <input
                type="text" value={form.taxLabel} onChange={f('taxLabel')}
                className="w-full border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-lab3-blue"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Tax rate (%)</label>
              <input
                type="number" value={form.taxRate}
                onChange={e => setForm(v => ({ ...v, taxRate: parseFloat(e.target.value) || 0 }))}
                step="0.01" min={0}
                className="w-full border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-lab3-blue"
              />
            </div>
          </div>

          <div className="flex items-center gap-3 pt-2">
            <button
              onClick={() => updateProject.mutate(form)}
              disabled={!form.name || updateProject.isPending}
              className="bg-lab3-navy text-white px-5 py-2 rounded-lg text-sm font-medium hover:bg-lab3-blue disabled:opacity-50 transition-colors"
            >
              {updateProject.isPending ? 'Saving…' : 'Save settings'}
            </button>
            <button
              onClick={() => navigate(`/projects/${id}`)}
              className="px-5 py-2 rounded-lg text-sm text-gray-600 hover:bg-gray-100 transition-colors"
            >
              Cancel
            </button>
            {saved && <span className="text-sm text-green-600">✓ Settings saved</span>}
          </div>
        </div>

        {(metadataError || dependenciesLoadError || risksLoadError) && (
          <div role="alert" className="mt-6 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-700 rounded-lg text-sm text-red-700 dark:text-red-400">
            {metadataError ?? 'Failed to load project dependencies and risks.'}
          </div>
        )}

        <section aria-labelledby="project-dependencies-heading" className="mt-6 bg-white dark:bg-gray-800 rounded-xl border border-gray-200 p-6 space-y-4">
          <div>
            <h2 id="project-dependencies-heading" className="text-base font-semibold text-gray-900 dark:text-white">Dependencies</h2>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">Project-level conditions needed for successful delivery.</p>
          </div>

          {dependenciesLoading ? (
            <p className="text-sm text-gray-400">Loading dependencies…</p>
          ) : dependencies.length === 0 ? (
            <p className="text-sm text-gray-500 dark:text-gray-400">No dependencies added yet.</p>
          ) : (
            <div className="space-y-2">
              {dependencies.map((dependency, index) => editingDependency?.id === dependency.id ? (
                <div key={dependency.id} className="space-y-2 rounded-lg border border-gray-200 dark:border-gray-600 p-3">
                  <label className="block text-xs font-medium text-gray-600 dark:text-gray-300" htmlFor={`dependency-${dependency.id}`}>Dependency description</label>
                  <textarea
                    id={`dependency-${dependency.id}`}
                    value={editingDependency.description}
                    onChange={e => setEditingDependency({ ...editingDependency, description: e.target.value })}
                    rows={2}
                    className="w-full border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-lab3-blue"
                  />
                  <div className="flex gap-2">
                    <button type="button" onClick={saveDependency} disabled={metadataBusy !== null || !editingDependency.description.trim()} className="bg-lab3-navy text-white px-3 py-1.5 rounded text-xs disabled:opacity-50">Save</button>
                    <button type="button" onClick={() => setEditingDependency(null)} className="text-xs text-gray-500 hover:text-gray-800">Cancel</button>
                  </div>
                </div>
              ) : (
                <div key={dependency.id} className="flex items-start gap-3 rounded-lg border border-gray-200 dark:border-gray-600 p-3">
                  <p className="flex-1 text-sm text-gray-800 dark:text-gray-200 whitespace-pre-wrap">{dependency.description}</p>
                  <div className="flex items-center gap-1 shrink-0">
                    <button type="button" onClick={() => moveDependency(index, -1)} disabled={index === 0 || metadataBusy !== null} aria-label={`Move dependency ${index + 1} up`} className="px-1.5 py-1 text-xs text-gray-500 hover:text-lab3-navy disabled:opacity-30">↑</button>
                    <button type="button" onClick={() => moveDependency(index, 1)} disabled={index === dependencies.length - 1 || metadataBusy !== null} aria-label={`Move dependency ${index + 1} down`} className="px-1.5 py-1 text-xs text-gray-500 hover:text-lab3-navy disabled:opacity-30">↓</button>
                    <button type="button" onClick={() => setEditingDependency({ id: dependency.id, description: dependency.description })} disabled={metadataBusy !== null} aria-label={`Edit dependency ${index + 1}`} className="px-2 py-1 text-xs text-gray-500 hover:text-gray-800">Edit</button>
                    <button type="button" onClick={() => deleteDependency(dependency.id)} disabled={metadataBusy !== null} aria-label={`Delete dependency ${index + 1}`} className="px-2 py-1 text-xs text-gray-500 hover:text-red-600">Delete</button>
                  </div>
                </div>
              ))}
            </div>
          )}

          <div className="flex items-end gap-2 pt-2 border-t border-gray-100 dark:border-gray-700">
            <div className="flex-1">
              <label className="block text-xs font-medium text-gray-600 dark:text-gray-300 mb-1" htmlFor="new-dependency">Add dependency</label>
              <textarea id="new-dependency" value={newDependency} onChange={e => setNewDependency(e.target.value)} rows={2} placeholder="Describe a project dependency" className="w-full border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-lab3-blue" />
            </div>
            <button type="button" onClick={addDependency} disabled={metadataBusy !== null || !newDependency.trim()} className="bg-lab3-navy text-white px-3 py-2 rounded-lg text-sm disabled:opacity-50">Add dependency</button>
          </div>
        </section>

        <section aria-labelledby="project-risks-heading" className="mt-6 bg-white dark:bg-gray-800 rounded-xl border border-gray-200 p-6 space-y-4">
          <div>
            <h2 id="project-risks-heading" className="text-base font-semibold text-gray-900 dark:text-white">Risks</h2>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">Uncertain conditions that may affect delivery.</p>
          </div>

          {risksLoading ? (
            <p className="text-sm text-gray-400">Loading risks…</p>
          ) : risks.length === 0 ? (
            <p className="text-sm text-gray-500 dark:text-gray-400">No risks added yet.</p>
          ) : (
            <div className="space-y-2">
              {risks.map((risk, index) => editingRisk?.id === risk.id ? (
                <div key={risk.id} className="space-y-2 rounded-lg border border-gray-200 dark:border-gray-600 p-3">
                  <label className="block text-xs font-medium text-gray-600 dark:text-gray-300" htmlFor={`risk-${risk.id}`}>Risk description</label>
                  <textarea id={`risk-${risk.id}`} value={editingRisk.description} onChange={e => setEditingRisk({ ...editingRisk, description: e.target.value })} rows={2} className="w-full border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-lab3-blue" />
                  <label className="block text-xs font-medium text-gray-600 dark:text-gray-300" htmlFor={`risk-mitigation-${risk.id}`}>Mitigation / response (optional)</label>
                  <textarea id={`risk-mitigation-${risk.id}`} value={editingRisk.mitigation} onChange={e => setEditingRisk({ ...editingRisk, mitigation: e.target.value })} rows={2} className="w-full border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-lab3-blue" />
                  <div className="flex gap-2">
                    <button type="button" onClick={saveRisk} disabled={metadataBusy !== null || !editingRisk.description.trim()} className="bg-lab3-navy text-white px-3 py-1.5 rounded text-xs disabled:opacity-50">Save</button>
                    <button type="button" onClick={() => setEditingRisk(null)} className="text-xs text-gray-500 hover:text-gray-800">Cancel</button>
                  </div>
                </div>
              ) : (
                <div key={risk.id} className="flex items-start gap-3 rounded-lg border border-gray-200 dark:border-gray-600 p-3">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-gray-800 dark:text-gray-200 whitespace-pre-wrap">{risk.description}</p>
                    {risk.mitigation && <p className="text-xs text-gray-500 dark:text-gray-400 mt-1 whitespace-pre-wrap"><span className="font-medium">Mitigation / response:</span> {risk.mitigation}</p>}
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <button type="button" onClick={() => moveRisk(index, -1)} disabled={index === 0 || metadataBusy !== null} aria-label={`Move risk ${index + 1} up`} className="px-1.5 py-1 text-xs text-gray-500 hover:text-lab3-navy disabled:opacity-30">↑</button>
                    <button type="button" onClick={() => moveRisk(index, 1)} disabled={index === risks.length - 1 || metadataBusy !== null} aria-label={`Move risk ${index + 1} down`} className="px-1.5 py-1 text-xs text-gray-500 hover:text-lab3-navy disabled:opacity-30">↓</button>
                    <button type="button" onClick={() => setEditingRisk({ id: risk.id, description: risk.description, mitigation: risk.mitigation ?? '' })} disabled={metadataBusy !== null} aria-label={`Edit risk ${index + 1}`} className="px-2 py-1 text-xs text-gray-500 hover:text-gray-800">Edit</button>
                    <button type="button" onClick={() => deleteRisk(risk.id)} disabled={metadataBusy !== null} aria-label={`Delete risk ${index + 1}`} className="px-2 py-1 text-xs text-gray-500 hover:text-red-600">Delete</button>
                  </div>
                </div>
              ))}
            </div>
          )}

          <div className="space-y-2 pt-2 border-t border-gray-100 dark:border-gray-700">
            <label className="block text-xs font-medium text-gray-600 dark:text-gray-300" htmlFor="new-risk">Add risk</label>
            <textarea id="new-risk" value={newRisk.description} onChange={e => setNewRisk(prev => ({ ...prev, description: e.target.value }))} rows={2} placeholder="Describe a project risk" className="w-full border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-lab3-blue" />
            <label className="block text-xs font-medium text-gray-600 dark:text-gray-300" htmlFor="new-risk-mitigation">Mitigation / response (optional)</label>
            <textarea id="new-risk-mitigation" value={newRisk.mitigation} onChange={e => setNewRisk(prev => ({ ...prev, mitigation: e.target.value }))} rows={2} placeholder="Describe a mitigation or response" className="w-full border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-lab3-blue" />
            <button type="button" onClick={addRisk} disabled={metadataBusy !== null || !newRisk.description.trim()} className="bg-lab3-navy text-white px-3 py-2 rounded-lg text-sm disabled:opacity-50">Add risk</button>
          </div>
        </section>
      </main>
  </AppLayout>
  )
}
