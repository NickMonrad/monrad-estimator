import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate, Link } from 'react-router-dom'
import { api, getOrgs, getCustomers, moveProjectToOrg } from '../lib/api'
import { useAuth } from '../hooks/useAuth'
import ThemeToggle from '../components/layout/ThemeToggle'
import { useGeocitiesEgg } from '../hooks/useGeocitiesEgg'

interface Project {
  id: string
  name: string
  description?: string
  customer?: { id: string; name: string }
  hoursPerDay: number
  updatedAt: string
  deletedAt?: string | null
  status?: string
  _count: { epics: number }
  org?: { id: string; name: string }
}

interface Org {
  id: string
  name: string
}

interface Customer {
  id: string
  name: string
  orgId?: string
}

const STATUS_OPTIONS = ['DRAFT', 'ACTIVE', 'REVIEW', 'COMPLETE', 'ARCHIVED']

const STATUS_COLOURS: Record<string, string> = {
  DRAFT: 'bg-gray-100 text-gray-700',
  ACTIVE: 'bg-blue-100 text-blue-700',
  REVIEW: 'bg-yellow-100 text-yellow-700',
  COMPLETE: 'bg-green-100 text-green-700',
  ARCHIVED: 'bg-red-100 text-red-700',
}

export default function ProjectsPage() {
  const { user, logout } = useAuth()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [showNew, setShowNew] = useState(false)
  const [form, setForm] = useState({ name: '', description: '', status: 'DRAFT', hoursPerDay: 7.6, bufferWeeks: 0, customerId: '', orgId: '' })
  const [search, setSearch] = useState('')
  const { triggerClick: geocitiesClick } = useGeocitiesEgg()
  const [showArchived, setShowArchived] = useState(false)
  const [cloningId, setCloningId] = useState<string | null>(null)
  const [menuOpen, setMenuOpen] = useState<string | null>(null)
  const [moveToOrgProject, setMoveToOrgProject] = useState<Project | null>(null)
  const [selectedOrgId, setSelectedOrgId] = useState('')

  const { data: projects = [], isLoading } = useQuery<Project[]>({
    queryKey: ['projects', showArchived],
    queryFn: () => api.get('/projects', { params: showArchived ? { archived: 'true' } : {} }).then(r => r.data),
  })

  const { data: orgs = [] } = useQuery<Org[]>({
    queryKey: ['orgs'],
    queryFn: getOrgs,
  })

  const { data: customers = [] } = useQuery<Customer[]>({
    queryKey: ['customers'],
    queryFn: getCustomers,
  })

  const createProject = useMutation({
    mutationFn: (data: typeof form) => api.post('/projects', data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['projects'] })
      setShowNew(false)
      setForm({ name: '', description: '', status: 'DRAFT', hoursPerDay: 7.6, bufferWeeks: 0, customerId: '', orgId: '' })
    },
  })

  const deleteProject = useMutation({
    mutationFn: (id: string) => api.delete(`/projects/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['projects'] }),
  })

  const restoreProject = useMutation({
    mutationFn: (id: string) => api.post(`/projects/${id}/restore`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['projects'] }),
  })

  const permanentDelete = useMutation({
    mutationFn: (id: string) => api.delete(`/projects/${id}/permanent`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['projects'] }),
  })

  const cloneProject = async (id: string) => {
    setCloningId(id)
    try {
      await api.post(`/projects/${id}/clone`)
      queryClient.invalidateQueries({ queryKey: ['projects'] })
    } finally {
      setCloningId(null)
    }
  }

  const moveToOrg = useMutation({
    mutationFn: ({ projectId, orgId }: { projectId: string; orgId: string }) =>
      moveProjectToOrg(projectId, orgId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['projects'] })
      setMoveToOrgProject(null)
      setSelectedOrgId('')
    },
  })

  function openMoveToOrg(project: Project) {
    setMoveToOrgProject(project)
    setSelectedOrgId(project.org?.id ?? '')
    setMenuOpen(null)
  }

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
      {/* Header */}
      <header className="bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            {/* Logo — 3 rapid clicks triggers Geocities easter egg */}
            <button
              onClick={geocitiesClick}
              className="w-8 h-8 bg-lab3-navy rounded-lg flex items-center justify-center focus:outline-none"
              aria-label="Monrad Estimator logo"
            >
              <span className="text-white text-xs font-bold">M</span>
            </button>
            <span className="font-semibold text-gray-900 dark:text-white">Monrad Estimator</span>
            <Link to="/resource-types" className="text-sm text-gray-500 dark:text-gray-400 hover:text-lab3-navy dark:hover:text-lab3-blue transition-colors ml-2">Resource Types</Link>
            <Link to="/templates" className="text-sm text-gray-500 dark:text-gray-400 hover:text-lab3-navy dark:hover:text-lab3-blue transition-colors ml-2">Templates</Link>
            <Link to="/rate-cards" className="text-sm text-gray-500 dark:text-gray-400 hover:text-lab3-navy dark:hover:text-lab3-blue transition-colors ml-2">Rate Cards</Link>
            <Link to="/orgs" className="text-sm text-gray-500 dark:text-gray-400 hover:text-lab3-navy dark:hover:text-lab3-blue transition-colors ml-2">Team</Link>
            <Link to="/customers" className="text-sm text-gray-500 dark:text-gray-400 hover:text-lab3-navy dark:hover:text-lab3-blue transition-colors ml-2">Customers</Link>
          </div>
          <div className="flex items-center gap-3">
            <ThemeToggle />
            <span className="text-sm text-gray-500 dark:text-gray-400">{user?.name}</span>
            <button onClick={logout} className="text-sm text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200">Sign out</button>
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-6 py-8">
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-xl font-semibold text-gray-900 dark:text-white">Projects</h1>
          <div className="flex items-center gap-3">
            <input
              type="text"
              placeholder="Search projects…"
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm w-56 bg-white dark:bg-gray-700 text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-lab3-blue"
            />
            <button
              onClick={() => { setShowArchived(a => !a); setSearch('') }}
              className={`px-4 py-2 rounded-lg text-sm font-medium border transition-colors ${showArchived ? 'bg-gray-800 text-white border-gray-800 hover:bg-gray-700' : 'border-gray-300 text-gray-600 hover:bg-gray-50'}`}
            >
              {showArchived ? '← Live projects' : 'Archived'}
            </button>
            {!showArchived && (
              <button
                onClick={() => setShowNew(true)}
                className="bg-lab3-navy text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-lab3-blue transition-colors"
              >
                + New project
              </button>
            )}
          </div>
        </div>

        {/* New project form */}
        {showNew && !showArchived && (
          <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-6 mb-6">
            <h2 className="font-medium text-gray-900 dark:text-white mb-4">New project</h2>
            <div className="grid grid-cols-2 gap-4 mb-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Project name *</label>
                <input
                  type="text" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="Project name"
                  className="w-full border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-lab3-blue"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Status</label>
                <select
                  value={form.status} onChange={e => setForm(f => ({ ...f, status: e.target.value }))}
                  className="w-full border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-red-500"
                >
                  {STATUS_OPTIONS.map(s => <option key={s} value={s}>{s}</option>)}
                </select>
              </div>
              <div className="col-span-2">
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Description</label>
                <textarea
                  value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} rows={2}
                  className="w-full border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-lab3-blue"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Hours per day</label>
                <input
                  type="number" step="0.1" min="1" max="24"
                  value={form.hoursPerDay} onChange={e => setForm(f => ({ ...f, hoursPerDay: parseFloat(e.target.value) || 7.6 }))}
                  className="w-full border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-red-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Buffer weeks</label>
                <input
                  type="number" min="0"
                  value={form.bufferWeeks} onChange={e => setForm(f => ({ ...f, bufferWeeks: parseInt(e.target.value) || 0 }))}
                  className="w-full border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-red-500"
                />
              </div>
              {customers.length > 0 && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Customer</label>
                  <select
                    value={form.customerId} onChange={e => {
                      const cid = e.target.value
                      const cust = customers.find(c => c.id === cid)
                      setForm(f => ({
                        ...f,
                        customerId: cid,
                        orgId: cid && cust?.orgId && !f.orgId ? cust.orgId : f.orgId,
                      }))
                    }}
                    className="w-full border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-red-500"
                  >
                    <option value="">No customer</option>
                    {customers.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                </div>
              )}
              {orgs.length > 0 && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Team</label>
                  <select
                    value={form.orgId} onChange={e => setForm(f => ({ ...f, orgId: e.target.value }))}
                    className="w-full border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-red-500"
                  >
                    <option value="">Personal project</option>
                    {orgs.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
                  </select>
                </div>
              )}
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => createProject.mutate(form)} disabled={!form.name || createProject.isPending}
                className="bg-lab3-navy text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-lab3-blue disabled:opacity-50 transition-colors"
              >
                {createProject.isPending ? 'Creating…' : 'Create project'}
              </button>
              <button
                onClick={() => setShowNew(false)}
                className="px-4 py-2 rounded-lg text-sm font-medium text-gray-600 hover:bg-gray-100 transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {/* Project list */}
        {isLoading ? (
          <div className="text-center py-12 text-gray-400">Loading…</div>
        ) : projects.length === 0 ? (
          <div className="text-center py-12 text-gray-400">
            <p className="text-lg mb-2">{showArchived ? 'No archived projects' : 'No projects yet'}</p>
            <p className="text-sm">{showArchived ? 'Deleted projects appear here' : 'Create your first project to get started'}</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {projects
              .filter(p => p.name.toLowerCase().includes(search.toLowerCase()))
              .map(project => (
              <div
                key={project.id}
                className={`bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-5 ${!showArchived ? 'cursor-pointer hover:border-lab3-blue/30 hover:shadow-sm' : 'opacity-75'} transition-all`}
                onClick={!showArchived && !menuOpen ? () => navigate(`/projects/${project.id}`) : undefined}
              >
                <div className="flex items-start justify-between mb-2">
                  <h3 className="font-medium text-gray-900 dark:text-white">{project.name}</h3>
                  <div className="flex items-center gap-1">
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${STATUS_COLOURS[project.status] ?? 'bg-gray-100 text-gray-700'}`}>
                      {project.status}
                    </span>
                    {!showArchived && (
                      <div className="relative">
                        <button
                          onClick={e => { e.stopPropagation(); setMenuOpen(menuOpen === project.id ? null : project.id) }}
                          className="p-1 rounded hover:bg-gray-100 text-gray-400 hover:text-gray-600 transition-colors"
                          title="More options"
                        >
                          <svg xmlns="http://www.w3.org/2000/svg" className="w-4 h-4" viewBox="0 0 20 20" fill="currentColor">
                            <circle cx="10" cy="4" r="1.5"/><circle cx="10" cy="10" r="1.5"/><circle cx="10" cy="16" r="1.5"/>
                          </svg>
                        </button>
                        {menuOpen === project.id && (
                          <div
                            className="absolute right-0 mt-1 w-40 bg-white dark:bg-gray-800 border border-gray-200 rounded-lg shadow-lg z-10"
                            onClick={e => e.stopPropagation()}
                          >
                            <button
                              onClick={() => openMoveToOrg(project)}
                              className="w-full text-left px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 rounded-lg"
                            >
                              Move to org…
                            </button>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </div>
                {project.org && <span className="text-xs bg-blue-100 text-blue-700 rounded-full px-2 py-0.5 mb-1 inline-block">{project.org.name}</span>}
                {project.customer && <p className="text-xs text-gray-500 mb-1">Customer: {project.customer.name}</p>}
                {project.description && <p className="text-sm text-gray-600 mb-3 line-clamp-2">{project.description}</p>}
                <div className="flex items-center justify-between text-xs text-gray-400 mt-2">
                  <span>{project._count.epics} epic{project._count.epics !== 1 ? 's' : ''}</span>
                  <span>{new Date(project.updatedAt).toLocaleDateString()}</span>
                </div>
                {/* Action buttons */}
                <div className="flex gap-2 mt-3 pt-3 border-t border-gray-100" onClick={e => e.stopPropagation()}>
                  {showArchived ? (
                    <>
                      <button
                        onClick={() => restoreProject.mutate(project.id)}
                        disabled={restoreProject.isPending}
                        className="flex-1 text-xs px-3 py-1.5 rounded-lg bg-green-50 text-green-700 hover:bg-green-100 border border-green-200 font-medium transition-colors disabled:opacity-50"
                      >
                        Restore
                      </button>
                      <button
                        onClick={() => {
                          if (window.confirm(`Permanently delete "${project.name}"? This cannot be undone.`)) {
                            permanentDelete.mutate(project.id)
                          }
                        }}
                        disabled={permanentDelete.isPending}
                        className="flex-1 text-xs px-3 py-1.5 rounded-lg bg-red-50 text-red-600 hover:bg-red-100 border border-red-200 font-medium transition-colors disabled:opacity-50"
                      >
                        Delete forever
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        onClick={() => navigate(`/projects/${project.id}`)}
                        className="flex-1 text-xs px-3 py-1.5 rounded-lg text-gray-600 hover:bg-gray-100 border border-gray-200 font-medium transition-colors"
                      >
                        Edit
                      </button>
                      <button
                        onClick={() => cloneProject(project.id)}
                        disabled={cloningId === project.id}
                        className="flex-1 text-xs px-3 py-1.5 rounded-lg text-gray-600 hover:bg-gray-100 border border-gray-200 font-medium transition-colors disabled:opacity-50"
                      >
                        {cloningId === project.id ? 'Cloning…' : 'Clone'}
                      </button>
                      <button
                        onClick={() => {
                          if (window.confirm(`Archive "${project.name}"?`)) {
                            deleteProject.mutate(project.id)
                          }
                        }}
                        disabled={deleteProject.isPending}
                        className="flex-1 text-xs px-3 py-1.5 rounded-lg text-red-600 hover:bg-red-50 border border-red-200 font-medium transition-colors disabled:opacity-50"
                      >
                        Archive
                      </button>
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </main>

      {/* Move to Org modal */}
      {moveToOrgProject && (
        <div
          className="fixed inset-0 bg-black/40 flex items-center justify-center z-50"
          onClick={() => { setMoveToOrgProject(null); setSelectedOrgId('') }}
        >
          <div className="bg-white dark:bg-gray-800 rounded-xl p-6 w-full max-w-sm shadow-xl" onClick={e => e.stopPropagation()}>
            <h2 className="text-base font-semibold text-gray-900 mb-1">Move to org</h2>
            <p className="text-sm text-gray-500 mb-4">
              Project: <span className="font-medium text-gray-700">{moveToOrgProject.name}</span>
              {moveToOrgProject.org && (
                <span className="ml-2 text-xs bg-blue-100 text-blue-700 rounded-full px-2 py-0.5">
                  Currently: {moveToOrgProject.org.name}
                </span>
              )}
            </p>
            {orgs.length === 0 ? (
              <p className="text-sm text-gray-500 mb-4">You have no orgs. Create one on the Team page first.</p>
            ) : (
              <select
                value={selectedOrgId}
                onChange={e => setSelectedOrgId(e.target.value)}
                className="w-full border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm mb-4 bg-white dark:bg-gray-700 text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-red-500"
              >
                <option value="">Select org…</option>
                {orgs.map(org => (
                  <option key={org.id} value={org.id}>{org.name}</option>
                ))}
              </select>
            )}
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => { setMoveToOrgProject(null); setSelectedOrgId('') }}
                className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded-lg transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => moveToOrg.mutate({ projectId: moveToOrgProject.id, orgId: selectedOrgId })}
                disabled={!selectedOrgId || moveToOrg.isPending}
                className="bg-red-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-red-700 disabled:opacity-50 transition-colors"
              >
                {moveToOrg.isPending ? 'Moving…' : 'Move to org'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
