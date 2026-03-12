import { useState, useEffect } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api, getCustomers, getOrgs, moveProjectToOrg } from '../lib/api'
import { useAuth } from '../hooks/useAuth'

const STATUS_OPTIONS = ['DRAFT', 'ACTIVE', 'REVIEW', 'COMPLETE', 'ARCHIVED']

interface Customer {
  id: string
  name: string
}

interface Org {
  id: string
  name: string
}

export default function ProjectSettingsPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { user, logout } = useAuth()
  const qc = useQueryClient()

  const [form, setForm] = useState({ name: '', description: '', customerId: '', status: 'DRAFT', hoursPerDay: 7.6, bufferWeeks: 0 })
  const [saved, setSaved] = useState(false)
  const [customers, setCustomers] = useState<Customer[]>([])
  const [orgs, setOrgs] = useState<Org[]>([])
  const [selectedOrgId, setSelectedOrgId] = useState('')
  const [orgSaved, setOrgSaved] = useState(false)

  const { data: project, isLoading } = useQuery({
    queryKey: ['project', id],
    queryFn: () => api.get(`/projects/${id}`).then(r => r.data),
  })

  useEffect(() => {
    getCustomers().then(setCustomers).catch(() => {})
    getOrgs().then(setOrgs).catch(() => {})
  }, [])

  useEffect(() => {
    if (project) {
      setForm({
        name: project.name ?? '',
        description: project.description ?? '',
        customerId: project.customerId ?? '',
        status: project.status ?? 'DRAFT',
        hoursPerDay: project.hoursPerDay ?? 7.6,
        bufferWeeks: project.bufferWeeks ?? 0,
      })
      setSelectedOrgId(project.orgId ?? '')
    }
  }, [project])

  const updateProject = useMutation({
    mutationFn: (data: typeof form) => api.put(`/projects/${id}`, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['project', id] })
      qc.invalidateQueries({ queryKey: ['projects'] })
      qc.invalidateQueries({ queryKey: ['timeline', id] })
      qc.invalidateQueries({ queryKey: ['resource-profile', id] })
      setSaved(true)
      setTimeout(() => setSaved(false), 3000)
    },
  })

  const f = (field: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => {
    const value = field === 'hoursPerDay' ? parseFloat(e.target.value) || 7.6 : e.target.value
    setForm(v => ({ ...v, [field]: value }))
  }

  if (isLoading) return <div className="min-h-screen flex items-center justify-center text-gray-400">Loading…</div>
  if (!project) return <div className="min-h-screen flex items-center justify-center text-gray-400">Project not found</div>

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
      {/* TODO: dark mode — add dark: variants throughout this page */}
      <header className="bg-white border-b border-gray-200">
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm text-gray-500">
            <button onClick={() => navigate('/')} className="hover:text-lab3-navy transition-colors font-semibold text-gray-900">Monrad Estimator</button>
            <span>/</span>
            <button onClick={() => navigate(`/projects/${id}`)} className="hover:text-lab3-navy transition-colors">{project.name}</button>
            <span>/</span>
            <span className="text-gray-700">Settings</span>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-sm text-gray-500">{user?.name}</span>
            <button onClick={logout} className="text-sm text-gray-500 hover:text-gray-700">Sign out</button>
          </div>
        </div>
      </header>

      <main className="max-w-2xl mx-auto px-6 py-8">
        <h1 className="text-xl font-semibold text-gray-900 mb-6">Project Settings</h1>

        <div className="bg-white rounded-xl border border-gray-200 p-6 space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Project name *</label>
            <input
              type="text" value={form.name} onChange={f('name')}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-lab3-blue"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Organisation</label>
            <div className="flex gap-2 items-center">
              <select
                value={selectedOrgId}
                onChange={e => { setSelectedOrgId(e.target.value); setOrgSaved(false) }}
                className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-red-500"
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
                  qc.invalidateQueries({ queryKey: ['project', id] })
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
            <label className="block text-sm font-medium text-gray-700 mb-1">Customer</label>
            <select
              value={form.customerId} onChange={f('customerId')}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-red-500"
            >
              <option value="">No customer</option>
              {customers.map(c => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Description</label>
            <textarea
              value={form.description} onChange={f('description')} rows={3}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-lab3-blue"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Status</label>
            <select
              value={form.status} onChange={f('status')}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-lab3-blue"
            >
              {STATUS_OPTIONS.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Buffer weeks at end</label>
            <input
              type="number" value={form.bufferWeeks}
              onChange={e => setForm(v => ({ ...v, bufferWeeks: parseInt(e.target.value) || 0 }))}
              min={0} max={52} step={1}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-lab3-blue"
            />
            <p className="text-xs text-gray-400 mt-1">Adds extra weeks to the end of the project (e.g. for handover). Affects FULL_PROJECT allocation and timeline display.</p>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Hours per day</label>
            <input
              type="number" value={form.hoursPerDay} onChange={f('hoursPerDay')}
              min={1} max={24} step={0.1}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-lab3-blue"
            />
            <p className="text-xs text-gray-400 mt-1">Used to convert hours to days in estimates. Default is 7.6h.</p>
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
      </main>
    </div>
  )
}
