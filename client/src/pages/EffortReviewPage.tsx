import { useMemo, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { api } from '../lib/api'
import { useAuth } from '../hooks/useAuth'
import type { Project } from '../types/backlog'

type ResourceCategory = 'ENGINEERING' | 'GOVERNANCE' | 'PROJECT_MANAGEMENT'

interface TaskSummary {
  taskId: string
  taskName: string
  storyName: string
  featureName: string
  epicName: string
  hoursEffort: number
  daysEffort: number
}

interface ResourceTypeSummary {
  resourceTypeId: string
  name: string
  category: ResourceCategory
  count: number
  proposedName: string | null
  totalHours: number
  totalDays: number
  tasks: TaskSummary[]
}

interface CategorySummary {
  category: ResourceCategory
  totalHours: number
  totalDays: number
  resourceTypes: ResourceTypeSummary[]
}

interface EffortSummary {
  projectId: string
  hoursPerDay: number
  totalHours: number
  totalDays: number
  byCategory: CategorySummary[]
}

const CATEGORY_LABELS: Record<ResourceCategory, string> = {
  ENGINEERING: 'Engineering',
  GOVERNANCE: 'Governance',
  PROJECT_MANAGEMENT: 'Project Management',
}

const CATEGORY_ROW_BG: Record<ResourceCategory, string> = {
  ENGINEERING: 'bg-blue-50',
  GOVERNANCE: 'bg-amber-50',
  PROJECT_MANAGEMENT: 'bg-green-50',
}

const CATEGORY_HEADER_BG: Record<ResourceCategory, string> = {
  ENGINEERING: 'bg-blue-100',
  GOVERNANCE: 'bg-amber-100',
  PROJECT_MANAGEMENT: 'bg-green-100',
}

const CATEGORY_BAR_BG: Record<ResourceCategory, string> = {
  ENGINEERING: 'bg-blue-400',
  GOVERNANCE: 'bg-amber-400',
  PROJECT_MANAGEMENT: 'bg-green-400',
}

export default function EffortReviewPage() {
  const { id: projectId } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { user, logout } = useAuth()
  const [view, setView] = useState<'summary' | 'detail'>('summary')
  const [expandedRts, setExpandedRts] = useState<Set<string>>(new Set())
  const [collapsedCategories, setCollapsedCategories] = useState<Set<string>>(new Set())

  const { data: project } = useQuery<Project>({
    queryKey: ['project', projectId],
    queryFn: () => api.get(`/projects/${projectId}`).then(r => r.data),
  })

  const { data: effort, isLoading } = useQuery<EffortSummary>({
    queryKey: ['effort', projectId],
    queryFn: () => api.get(`/projects/${projectId}/effort`).then(r => r.data),
  })

  const filteredEffort = useMemo(() => {
    if (!effort) return null
    const categories = effort.byCategory
      .map(cat => {
        const resourceTypes = cat.resourceTypes.filter(rt => rt.totalHours > 0)
        const totalHours = resourceTypes.reduce((sum, rt) => sum + rt.totalHours, 0)
        const totalDays = resourceTypes.reduce((sum, rt) => sum + rt.totalDays, 0)
        return { ...cat, resourceTypes, totalHours, totalDays }
      })
      .filter(cat => cat.resourceTypes.length > 0)

    const totalHours = categories.reduce((sum, cat) => sum + cat.totalHours, 0)
    const totalDays = categories.reduce((sum, cat) => sum + cat.totalDays, 0)
    return { ...effort, byCategory: categories, totalHours, totalDays }
  }, [effort])

  const toggleRt = (id: string) =>
    setExpandedRts(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n })

  const toggleCategory = (cat: string) =>
    setCollapsedCategories(s => { const n = new Set(s); n.has(cat) ? n.delete(cat) : n.add(cat); return n })

  const totalResourceTypes = filteredEffort?.byCategory.reduce((s, c) => s + c.resourceTypes.length, 0) ?? 0

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white border-b border-gray-200">
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm text-gray-500">
            <button onClick={() => navigate('/')} className="hover:text-red-600 transition-colors font-semibold text-gray-900">Monrad Estimator</button>
            <span>/</span>
            <button onClick={() => navigate(`/projects/${projectId}`)} className="hover:text-red-600 transition-colors">{project?.name ?? '…'}</button>
            <span>/</span>
            <span className="text-gray-700">Effort Review</span>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-sm text-gray-500">{user?.name}</span>
            <button onClick={logout} className="text-sm text-gray-500 hover:text-gray-700">Sign out</button>
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-6 py-8">
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-xl font-semibold text-gray-900">Effort Review</h1>
          {/* View toggle */}
          <div className="flex rounded-lg border border-gray-200 overflow-hidden text-sm">
            <button
              onClick={() => setView('summary')}
              className={`px-4 py-2 font-medium transition-colors ${view === 'summary' ? 'bg-red-600 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}
            >
              Summary
            </button>
            <button
              onClick={() => setView('detail')}
              className={`px-4 py-2 font-medium transition-colors ${view === 'detail' ? 'bg-red-600 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}
            >
              Detail
            </button>
          </div>
        </div>

        {/* Summary bar */}
        {filteredEffort && (
          <div className="grid grid-cols-3 gap-4 mb-6">
            <div className="bg-white rounded-xl border border-gray-200 p-4 text-center">
              <p className="text-2xl font-bold text-gray-900">{filteredEffort.totalHours.toFixed(0)}h</p>
              <p className="text-sm text-gray-500 mt-1">Total hours</p>
            </div>
            <div className="bg-white rounded-xl border border-gray-200 p-4 text-center">
              <p className="text-2xl font-bold text-gray-900">{filteredEffort.totalDays.toFixed(1)}</p>
              <p className="text-sm text-gray-500 mt-1">Total days</p>
            </div>
            <div className="bg-white rounded-xl border border-gray-200 p-4 text-center">
              <p className="text-2xl font-bold text-gray-900">{totalResourceTypes}</p>
              <p className="text-sm text-gray-500 mt-1">Resource types</p>
            </div>
          </div>
        )}

        {isLoading && <div className="text-center py-12 text-gray-400">Loading…</div>}

        {filteredEffort && filteredEffort.byCategory.length === 0 && (
          <div className="text-center py-16 text-gray-400">
            <p className="text-lg mb-1">No tasks assigned yet.</p>
            <p className="text-sm">Add tasks with hours to the backlog to see effort here</p>
          </div>
        )}

        {filteredEffort && filteredEffort.byCategory.length > 0 && view === 'summary' && (
          <SummaryView
            effort={filteredEffort}
            collapsedCategories={collapsedCategories}
            onToggleCategory={toggleCategory}
          />
        )}

        {filteredEffort && filteredEffort.byCategory.length > 0 && view === 'detail' && (
          <DetailView
            effort={filteredEffort}
            expandedRts={expandedRts}
            onToggleRt={toggleRt}
          />
        )}
      </main>
    </div>
  )
}

function SummaryView({
  effort,
  collapsedCategories,
  onToggleCategory,
}: {
  effort: EffortSummary
  collapsedCategories: Set<string>
  onToggleCategory: (cat: string) => void
}) {
  const totalHours = effort.totalHours

  return (
    <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-gray-200 bg-gray-50">
            <th className="text-left px-4 py-3 font-medium text-gray-600">Resource Type</th>
            <th className="text-center px-4 py-3 font-medium text-gray-600">Count</th>
            <th className="text-left px-4 py-3 font-medium text-gray-600">Proposed Name</th>
            <th className="text-right px-4 py-3 font-medium text-gray-600">Hours</th>
            <th className="text-right px-4 py-3 font-medium text-gray-600">Days</th>
            <th className="text-right px-4 py-3 font-medium text-gray-600">% of Total</th>
            <th className="px-4 py-3"></th>
          </tr>
        </thead>
        <tbody>
          {effort.byCategory.map(cat => (
            <>
              {/* Category header row */}
              <tr
                key={`cat-${cat.category}`}
                className={`${CATEGORY_HEADER_BG[cat.category]} cursor-pointer`}
                onClick={() => onToggleCategory(cat.category)}
              >
                <td colSpan={5} className="px-4 py-2.5 font-bold text-gray-800">
                  <span className="mr-2 text-xs">{collapsedCategories.has(cat.category) ? '▶' : '▼'}</span>
                  {CATEGORY_LABELS[cat.category]}
                </td>
                <td className="px-4 py-2.5 text-right font-bold text-gray-800">
                  {totalHours > 0 ? ((cat.totalHours / totalHours) * 100).toFixed(1) : '0.0'}%
                </td>
                <td className="px-4 py-2.5 text-right font-medium text-gray-700">
                  {cat.totalHours}h / {cat.totalDays}d
                </td>
              </tr>

              {/* Resource type rows */}
              {!collapsedCategories.has(cat.category) && cat.resourceTypes.map(rt => {
                const pct = totalHours > 0 ? (rt.totalHours / totalHours) * 100 : 0
                return (
                  <tr key={rt.resourceTypeId} className={`${CATEGORY_ROW_BG[rt.category]} border-t border-gray-100`}>
                    <td className="px-4 py-2.5 text-gray-800 pl-8">{rt.name}</td>
                    <td className="px-4 py-2.5 text-center text-gray-600">{rt.count}</td>
                    <td className="px-4 py-2.5 text-gray-500">{rt.proposedName ?? '—'}</td>
                    <td className="px-4 py-2.5 text-right text-gray-800">{rt.totalHours}</td>
                    <td className="px-4 py-2.5 text-right text-gray-800">{rt.totalDays}</td>
                    <td className="px-4 py-2.5 text-right text-gray-600">{pct.toFixed(1)}%</td>
                    <td className="px-4 py-2.5 w-32">
                      <div className="h-2 bg-gray-200 rounded-full overflow-hidden">
                        <div
                          className={`h-full rounded-full ${CATEGORY_BAR_BG[rt.category]}`}
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                    </td>
                  </tr>
                )
              })}

              {/* Category subtotal row */}
              {!collapsedCategories.has(cat.category) && (
                <tr key={`subtotal-${cat.category}`} className={`${CATEGORY_HEADER_BG[cat.category]} border-t border-gray-200`}>
                  <td colSpan={3} className="px-4 py-2 pl-8 font-semibold text-gray-700 text-xs uppercase tracking-wide">
                    {CATEGORY_LABELS[cat.category]} subtotal
                  </td>
                  <td className="px-4 py-2 text-right font-semibold text-gray-800">{cat.totalHours}</td>
                  <td className="px-4 py-2 text-right font-semibold text-gray-800">{cat.totalDays}</td>
                  <td colSpan={2} />
                </tr>
              )}
            </>
          ))}

          {/* Grand total row */}
          <tr className="bg-gray-100 border-t-2 border-gray-300">
            <td colSpan={3} className="px-4 py-3 font-bold text-gray-900">Grand Total</td>
            <td className="px-4 py-3 text-right font-bold text-gray-900">{effort.totalHours}</td>
            <td className="px-4 py-3 text-right font-bold text-gray-900">{effort.totalDays}</td>
            <td className="px-4 py-3 text-right font-bold text-gray-900">100%</td>
            <td />
          </tr>
        </tbody>
      </table>
    </div>
  )
}

function DetailView({
  effort,
  expandedRts,
  onToggleRt,
}: {
  effort: EffortSummary
  expandedRts: Set<string>
  onToggleRt: (id: string) => void
}) {
  return (
    <div className="space-y-4">
      {effort.byCategory.map(cat => (
        <div key={cat.category} className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          <div className={`${CATEGORY_HEADER_BG[cat.category]} px-4 py-3`}>
            <span className="font-bold text-gray-800">{CATEGORY_LABELS[cat.category]}</span>
            <span className="ml-3 text-sm text-gray-600">{cat.totalHours}h · {cat.totalDays} days</span>
          </div>

          {cat.resourceTypes.map(rt => (
            <div key={rt.resourceTypeId} className="border-t border-gray-100">
              <button
                className={`w-full text-left ${CATEGORY_ROW_BG[rt.category]} px-4 py-3 flex items-center justify-between hover:brightness-95 transition-all`}
                onClick={() => onToggleRt(rt.resourceTypeId)}
              >
                <div className="flex items-center gap-3">
                  <span className="text-xs text-gray-400">{expandedRts.has(rt.resourceTypeId) ? '▼' : '▶'}</span>
                  <span className="font-medium text-gray-900">{rt.name}</span>
                  {rt.proposedName && <span className="text-xs text-gray-500">({rt.proposedName})</span>}
                  <span className="text-xs text-gray-500 bg-white px-2 py-0.5 rounded-full border border-gray-200">×{rt.count}</span>
                </div>
                <span className="text-sm text-gray-600">{rt.totalHours}h · {rt.totalDays}d · {rt.tasks.length} task{rt.tasks.length !== 1 ? 's' : ''}</span>
              </button>

              {expandedRts.has(rt.resourceTypeId) && rt.tasks.length > 0 && (
                <div className="border-t border-gray-100">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="bg-gray-50 text-gray-500">
                        <th className="text-left px-4 py-2 font-medium pl-10">Epic</th>
                        <th className="text-left px-4 py-2 font-medium">Feature</th>
                        <th className="text-left px-4 py-2 font-medium">Story</th>
                        <th className="text-left px-4 py-2 font-medium">Task</th>
                        <th className="text-right px-4 py-2 font-medium">Hours</th>
                        <th className="text-right px-4 py-2 font-medium">Days</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rt.tasks.map(task => (
                        <tr key={task.taskId} className="border-t border-gray-100 hover:bg-gray-50">
                          <td className="px-4 py-2 text-gray-600 pl-10">{task.epicName}</td>
                          <td className="px-4 py-2 text-gray-600">{task.featureName}</td>
                          <td className="px-4 py-2 text-gray-600">{task.storyName}</td>
                          <td className="px-4 py-2 text-gray-900">{task.taskName}</td>
                          <td className="px-4 py-2 text-right text-gray-800">{task.hoursEffort}</td>
                          <td className="px-4 py-2 text-right text-gray-800">{task.daysEffort}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {expandedRts.has(rt.resourceTypeId) && rt.tasks.length === 0 && (
                <div className="px-10 py-4 text-sm text-gray-400">No tasks assigned to this resource type.</div>
              )}
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}
