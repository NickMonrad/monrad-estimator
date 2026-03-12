import { useParams, useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { api } from '../lib/api'
import { useAuth } from '../hooks/useAuth'

const STATUS_COLOURS: Record<string, string> = {
  DRAFT: 'bg-gray-100 text-gray-700',
  ACTIVE: 'bg-blue-100 text-blue-700',
  REVIEW: 'bg-yellow-100 text-yellow-700',
  COMPLETE: 'bg-green-100 text-green-700',
  ARCHIVED: 'bg-red-100 text-red-700',
}

export default function ProjectDetailPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { user, logout } = useAuth()

  const { data: project, isLoading } = useQuery({
    queryKey: ['project', id],
    queryFn: () => api.get(`/projects/${id}`).then(r => r.data),
  })

  if (isLoading) return <div className="min-h-screen flex items-center justify-center text-gray-400">Loading…</div>
  if (!project) return <div className="min-h-screen flex items-center justify-center text-gray-400">Project not found</div>

  const navItems = [
    { label: 'Backlog', href: `/projects/${id}/backlog`, icon: '📋', desc: 'Manage epics, features, stories and tasks' },
    { label: 'Effort Review', href: `/projects/${id}/effort`, icon: '📊', desc: 'Review estimates by resource type' },
    { label: 'Timeline', href: `/projects/${id}/timeline`, icon: '📅', desc: 'Plan and schedule work' },
    { label: 'Resource Profile', href: `/projects/${id}/resource-profile`, icon: '👥', desc: 'Role mix, overhead and cost profile' },
    { label: 'Resource Types', href: `/projects/${id}/resource-types`, icon: '🎭', desc: 'Manage roles and rate overrides' },
    { label: 'Documents', href: `/projects/${id}/documents`, icon: '📄', desc: 'Generate scope doc and SOW' },
    { label: 'Template Library', href: `/templates`, icon: '🧩', desc: 'Browse and manage feature templates' },
    { label: 'Settings', href: `/projects/${id}/settings`, icon: '⚙️', desc: 'Edit project name, customer, hours per day' },
  ]

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
      {/* TODO: dark mode — add dark: variants to feature cards in this file */}
      <header className="bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <button onClick={() => navigate('/')} className="flex items-center gap-2 group">
              <div className="w-8 h-8 bg-lab3-navy rounded-lg flex items-center justify-center">
                <span className="text-white text-xs font-bold">M</span>
              </div>
              <span className="font-semibold text-gray-900 dark:text-white group-hover:text-lab3-navy dark:group-hover:text-lab3-blue transition-colors">Monrad Estimator</span>
            </button>
            <span className="text-gray-300 dark:text-gray-600">/</span>
            <span className="text-gray-600 dark:text-gray-400 text-sm">{project.name}</span>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-sm text-gray-500 dark:text-gray-400">{user?.name}</span>
            <button onClick={logout} className="text-sm text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200">Sign out</button>
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-6 py-8">
        <div className="mb-6">
          <div className="flex items-center gap-3 mb-1">
            <h1 className="text-xl font-semibold text-gray-900">{project.name}</h1>
            <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${STATUS_COLOURS[project.status]}`}>
              {project.status}
            </span>
            <button onClick={() => navigate(`/projects/${id}/settings`)} title="Edit project settings" className="text-gray-400 hover:text-lab3-navy transition-colors">✏️</button>
          </div>
          {project.customer && <p className="text-sm text-gray-500">Customer: {project.customer.name ?? project.customer}</p>}
          {project.description && <p className="text-sm text-gray-600 mt-1">{project.description}</p>}
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {navItems.map(item => (
            <button
              key={item.label}
              onClick={() => navigate(item.href)}
              className="bg-white rounded-xl border border-gray-200 p-5 text-left hover:border-lab3-blue/30 hover:shadow-sm transition-all"
            >
              <div className="text-2xl mb-2">{item.icon}</div>
              <div className="font-medium text-gray-900 mb-1">{item.label}</div>
              <div className="text-sm text-gray-500">{item.desc}</div>
            </button>
          ))}
        </div>
      </main>
    </div>
  )
}
