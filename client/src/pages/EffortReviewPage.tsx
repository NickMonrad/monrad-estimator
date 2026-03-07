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
  estimatedCost: number | null
}

interface EpicBreakdown {
  epicName: string
  totalHours: number
  totalDays: number
  estimatedCost: number | null
}

interface ResourceTypeSummary {
  resourceTypeId: string
  name: string
  category: ResourceCategory
  count: number
  proposedName: string | null
  totalHours: number
  totalDays: number
  dayRate: number | null
  estimatedCost: number | null
  byEpic: EpicBreakdown[]
  tasks: TaskSummary[]
}

interface CategorySummary {
  category: ResourceCategory
  totalHours: number
  totalDays: number
  totalCost: number | null
  resourceTypes: ResourceTypeSummary[]
}

interface EffortSummary {
  projectId: string
  hoursPerDay: number
  totalHours: number
  totalDays: number
  totalCost: number | null
  hasCost: boolean
  byCategory: CategorySummary[]
}

function formatCost(amount: number): string {
  return '$' + Math.round(amount).toLocaleString('en-AU')
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
  const [activeOnly, setActiveOnly] = useState(true)

  const { data: project } = useQuery<Project>({
    queryKey: ['project', projectId],
    queryFn: () => api.get(`/projects/${projectId}`).then(r => r.data),
  })

  const { data: effort, isLoading } = useQuery<EffortSummary>({
    queryKey: ['effort', projectId, activeOnly],
    queryFn: () => api.get(`/projects/${projectId}/effort`, { params: { activeOnly } }).then(r => r.data),
  })

  const filteredEffort = useMemo(() => {
    if (!effort) return null
    const categories = effort.byCategory
      .map(cat => {
        const resourceTypes = cat.resourceTypes.filter(rt => rt.totalHours > 0)
        const totalHours = resourceTypes.reduce((sum, rt) => sum + rt.totalHours, 0)
        const totalDays = resourceTypes.reduce((sum, rt) => sum + rt.totalDays, 0)
        const totalCost = resourceTypes.some(rt => rt.estimatedCost != null)
          ? resourceTypes.reduce((sum, rt) => sum + (rt.estimatedCost ?? 0), 0)
          : cat.totalCost
        return { ...cat, resourceTypes, totalHours, totalDays, totalCost }
      })
      .filter(cat => cat.resourceTypes.length > 0)

    const totalHours = categories.reduce((sum, cat) => sum + cat.totalHours, 0)
    const totalDays = categories.reduce((sum, cat) => sum + cat.totalDays, 0)
    const totalCost = effort.totalCost
    return { ...effort, byCategory: categories, totalHours, totalDays, totalCost }
  }, [effort])

  const toggleRt = (id: string) =>
    setExpandedRts(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n })

  const toggleCategory = (cat: string) =>
    setCollapsedCategories(s => { const n = new Set(s); n.has(cat) ? n.delete(cat) : n.add(cat); return n })

  const totalResourceTypes = filteredEffort?.byCategory.reduce((s, c) => s + c.resourceTypes.length, 0) ?? 0
  const hasCost = filteredEffort?.hasCost ?? false

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
          <div className="flex items-center gap-3">
            {/* Active-only toggle */}
            <button
              onClick={() => setActiveOnly(v => !v)}
              className={`text-sm px-3 py-1.5 rounded-lg border font-medium transition-colors ${
                activeOnly
                  ? 'bg-green-600 text-white border-green-600'
                  : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'
              }`}
            >
              {activeOnly ? 'Active scope' : 'All tasks'}
            </button>
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
        </div>

        {/* Summary bar */}
        {filteredEffort && (
          <div className={`grid gap-4 mb-6 ${hasCost ? 'grid-cols-4' : 'grid-cols-3'}`}>
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
            {hasCost && filteredEffort.totalCost != null && (
              <div className="bg-white rounded-xl border border-gray-200 p-4 text-center">
                <p className="text-2xl font-bold text-gray-900">{formatCost(filteredEffort.totalCost)}</p>
                <p className="text-sm text-gray-500 mt-1">Total cost</p>
              </div>
            )}
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
            hasCost={hasCost}
            collapsedCategories={collapsedCategories}
            onToggleCategory={toggleCategory}
          />
        )}

        {filteredEffort && filteredEffort.byCategory.length > 0 && view === 'detail' && (
          <DetailView
            effort={filteredEffort}
            hasCost={hasCost}
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
  hasCost,
  collapsedCategories,
  onToggleCategory,
}: {
  effort: EffortSummary
  hasCost: boolean
  collapsedCategories: Set<string>
  onToggleCategory: (cat: string) => void
}) {
  const totalHours = effort.totalHours
  const [expandedRtEpics, setExpandedRtEpics] = useState<Set<string>>(new Set())

  const toggleRtEpic = (id: string) =>
    setExpandedRtEpics(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n })


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
            {hasCost && <th className="text-right px-4 py-3 font-medium text-gray-600">Day Rate</th>}
            {hasCost && <th className="text-right px-4 py-3 font-medium text-gray-600">Cost</th>}
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
                <td colSpan={hasCost ? 6 : 5} className="px-4 py-2.5 font-bold text-gray-800">
                  <span className="mr-2 text-xs">{collapsedCategories.has(cat.category) ? '▶' : '▼'}</span>
                  {CATEGORY_LABELS[cat.category]}
                </td>
                {hasCost && (
                  <td className="px-4 py-2.5 text-right font-bold text-gray-800">
                    {cat.totalCost != null ? formatCost(cat.totalCost) : '—'}
                  </td>
                )}
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
                const isExpanded = expandedRtEpics.has(rt.resourceTypeId)
                const hasEpics = rt.byEpic && rt.byEpic.length > 0
                return (
                  <>
                    <tr
                      key={rt.resourceTypeId}
                      className={`${CATEGORY_ROW_BG[rt.category]} border-t border-gray-100 ${hasEpics ? 'cursor-pointer' : ''}`}
                      onClick={hasEpics ? () => toggleRtEpic(rt.resourceTypeId) : undefined}
                    >
                      <td className="px-4 py-2.5 text-gray-800 pl-8">
                        {hasEpics && (
                          <span className="mr-2 text-xs text-gray-400">{isExpanded ? '▼' : '▶'}</span>
                        )}
                        {rt.name}
                      </td>
                      <td className="px-4 py-2.5 text-center text-gray-600">{rt.count}</td>
                      <td className="px-4 py-2.5 text-gray-500">{rt.proposedName ?? '—'}</td>
                      <td className="px-4 py-2.5 text-right text-gray-800">{rt.totalHours}</td>
                      <td className="px-4 py-2.5 text-right text-gray-800">{rt.totalDays}</td>
                      {hasCost && (
                        <td className="px-4 py-2.5 text-right text-gray-600">
                          {rt.dayRate != null ? '$' + rt.dayRate.toLocaleString() : '—'}
                        </td>
                      )}
                      {hasCost && (
                        <td className="px-4 py-2.5 text-right text-gray-800">
                          {rt.estimatedCost != null ? formatCost(rt.estimatedCost) : '—'}
                        </td>
                      )}
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

                    {/* Epic sub-rows */}
                    {isExpanded && hasEpics && rt.byEpic.map(epic => (
                      <tr
                        key={`${rt.resourceTypeId}-epic-${epic.epicName}`}
                        className={`${CATEGORY_ROW_BG[rt.category]} border-t border-gray-100 opacity-90`}
                      >
                        <td className="px-4 py-2 text-gray-700 pl-12 italic">{epic.epicName}</td>
                        <td />
                        <td />
                        <td className="px-4 py-2 text-right text-gray-700">{Number(epic.totalHours).toFixed(2)}</td>
                        <td className="px-4 py-2 text-right text-gray-700">{Number(epic.totalDays).toFixed(2)}</td>
                        {hasCost && <td />}
                        {hasCost && (
                          <td className="px-4 py-2 text-right text-gray-700">
                            {epic.estimatedCost != null ? formatCost(epic.estimatedCost) : '—'}
                          </td>
                        )}
                        <td />
                        <td />
                      </tr>
                    ))}
                  </>
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
                  {hasCost && <td />}
                  {hasCost && (
                    <td className="px-4 py-2 text-right font-semibold text-gray-800">
                      {cat.totalCost != null ? formatCost(cat.totalCost) : '—'}
                    </td>
                  )}
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
            {hasCost && <td />}
            {hasCost && (
              <td className="px-4 py-3 text-right font-bold text-gray-900">
                {effort.totalCost != null ? formatCost(effort.totalCost) : '—'}
              </td>
            )}
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
  hasCost,
  expandedRts,
  onToggleRt,
}: {
  effort: EffortSummary
  hasCost: boolean
  expandedRts: Set<string>
  onToggleRt: (id: string) => void
}) {
  const [epicFilter, setEpicFilter] = useState('')
  const [featureFilter, setFeatureFilter] = useState('')
  const [storyFilter, setStoryFilter] = useState('')
  const [rtFilter, setRtFilter] = useState('')
  const [taskNameFilter, setTaskNameFilter] = useState('')

  // Collect all tasks flat for unique value derivation
  const allTasks = useMemo(() => {
    const tasks: (TaskSummary & { rtName: string; rtId: string })[] = []
    for (const cat of effort.byCategory) {
      for (const rt of cat.resourceTypes) {
        for (const task of rt.tasks) {
          tasks.push({ ...task, rtName: rt.name, rtId: rt.resourceTypeId })
        }
      }
    }
    return tasks
  }, [effort])

  const uniqueEpics = useMemo(() => [...new Set(allTasks.map(t => t.epicName))].sort(), [allTasks])
  const uniqueFeatures = useMemo(() => {
    const tasks = epicFilter ? allTasks.filter(t => t.epicName === epicFilter) : allTasks
    return [...new Set(tasks.map(t => t.featureName))].sort()
  }, [allTasks, epicFilter])
  const uniqueStories = useMemo(() => {
    let tasks = allTasks
    if (epicFilter) tasks = tasks.filter(t => t.epicName === epicFilter)
    if (featureFilter) tasks = tasks.filter(t => t.featureName === featureFilter)
    return [...new Set(tasks.map(t => t.storyName))].sort()
  }, [allTasks, epicFilter, featureFilter])
  const uniqueRts = useMemo(() => [...new Set(allTasks.map(t => t.rtName))].sort(), [allTasks])

  const taskMatches = (task: TaskSummary & { rtName: string }) => {
    if (epicFilter && task.epicName !== epicFilter) return false
    if (featureFilter && task.featureName !== featureFilter) return false
    if (storyFilter && task.storyName !== storyFilter) return false
    if (rtFilter && task.rtName !== rtFilter) return false
    if (taskNameFilter && !task.taskName.toLowerCase().includes(taskNameFilter.toLowerCase())) return false
    return true
  }

  const hasAnyFilter = epicFilter || featureFilter || storyFilter || rtFilter || taskNameFilter

  const clearAll = () => {
    setEpicFilter('')
    setFeatureFilter('')
    setStoryFilter('')
    setRtFilter('')
    setTaskNameFilter('')
  }

  // Count visible tasks
  const visibleCount = useMemo(() =>
    allTasks.filter(t => taskMatches(t)).length
  // eslint-disable-next-line react-hooks/exhaustive-deps
  , [allTasks, epicFilter, featureFilter, storyFilter, rtFilter, taskNameFilter])

  return (
    <div className="space-y-4">
      {/* Filter bar */}
      <div className="bg-white rounded-xl border border-gray-200 p-4 space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={epicFilter}
            onChange={e => { setEpicFilter(e.target.value); setFeatureFilter(''); setStoryFilter('') }}
            className="text-sm border border-gray-200 rounded px-2 py-1.5 text-gray-700 bg-white"
          >
            <option value="">All Epics</option>
            {uniqueEpics.map(e => <option key={e} value={e}>{e}</option>)}
          </select>

          <select
            value={featureFilter}
            onChange={e => { setFeatureFilter(e.target.value); setStoryFilter('') }}
            className="text-sm border border-gray-200 rounded px-2 py-1.5 text-gray-700 bg-white"
          >
            <option value="">All Features</option>
            {uniqueFeatures.map(f => <option key={f} value={f}>{f}</option>)}
          </select>

          <select
            value={storyFilter}
            onChange={e => setStoryFilter(e.target.value)}
            className="text-sm border border-gray-200 rounded px-2 py-1.5 text-gray-700 bg-white"
          >
            <option value="">All Stories</option>
            {uniqueStories.map(s => <option key={s} value={s}>{s}</option>)}
          </select>

          <select
            value={rtFilter}
            onChange={e => setRtFilter(e.target.value)}
            className="text-sm border border-gray-200 rounded px-2 py-1.5 text-gray-700 bg-white"
          >
            <option value="">All Resource Types</option>
            {uniqueRts.map(r => <option key={r} value={r}>{r}</option>)}
          </select>

          <div className="relative">
            <input
              type="text"
              value={taskNameFilter}
              onChange={e => setTaskNameFilter(e.target.value)}
              placeholder="Task name…"
              className="text-sm border border-gray-200 rounded px-2 py-1.5 pl-7 text-gray-700 bg-white w-40"
            />
            <span className="absolute left-2 top-1/2 -translate-y-1/2 text-gray-400 text-xs">🔍</span>
          </div>

          {hasAnyFilter && (
            <button
              onClick={clearAll}
              className="text-sm px-3 py-1.5 rounded border border-gray-200 text-gray-600 hover:bg-gray-50 transition-colors"
            >
              Clear all
            </button>
          )}
        </div>
        <p className="text-xs text-gray-500">
          Showing {visibleCount} of {allTasks.length} task{allTasks.length !== 1 ? 's' : ''}
        </p>
      </div>

      {effort.byCategory.map(cat => {
        // Filter resource types to only those with matching tasks
        const filteredRts = cat.resourceTypes.map(rt => ({
          ...rt,
          visibleTasks: rt.tasks.filter(t => taskMatches({ ...t, rtName: rt.name })),
        })).filter(rt => rt.visibleTasks.length > 0 || !hasAnyFilter)

        if (filteredRts.length === 0) return null

        return (
          <div key={cat.category} className="bg-white rounded-xl border border-gray-200 overflow-hidden">
            <div className={`${CATEGORY_HEADER_BG[cat.category]} px-4 py-3`}>
              <span className="font-bold text-gray-800">{CATEGORY_LABELS[cat.category]}</span>
              <span className="ml-3 text-sm text-gray-600">{cat.totalHours}h · {cat.totalDays} days</span>
            </div>

            {filteredRts.map(rt => {
              const tasksToShow = hasAnyFilter ? rt.visibleTasks : rt.tasks
              return (
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
                    <span className="text-sm text-gray-600">
                      {rt.totalHours}h · {rt.totalDays}d · {tasksToShow.length} task{tasksToShow.length !== 1 ? 's' : ''}
                    </span>
                  </button>

                  {expandedRts.has(rt.resourceTypeId) && tasksToShow.length > 0 && (
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
                            {hasCost && <th className="text-right px-4 py-2 font-medium">Cost</th>}
                          </tr>
                        </thead>
                        <tbody>
                          {tasksToShow.map(task => (
                            <tr key={task.taskId} className="border-t border-gray-100 hover:bg-gray-50">
                              <td className="px-4 py-2 text-gray-600 pl-10">{task.epicName}</td>
                              <td className="px-4 py-2 text-gray-600">{task.featureName}</td>
                              <td className="px-4 py-2 text-gray-600">{task.storyName}</td>
                              <td className="px-4 py-2 text-gray-900">{task.taskName}</td>
                              <td className="px-4 py-2 text-right text-gray-800">{task.hoursEffort}</td>
                              <td className="px-4 py-2 text-right text-gray-800">{task.daysEffort}</td>
                              {hasCost && (
                                <td className="px-4 py-2 text-right text-gray-800">
                                  {task.estimatedCost != null ? formatCost(task.estimatedCost) : '—'}
                                </td>
                              )}
                            </tr>
                          ))}
                          {/* Totals row */}
                          <tr className="border-t border-gray-200 bg-gray-50 font-semibold">
                            <td colSpan={4} className="px-4 py-2 pl-10 text-gray-700 text-xs uppercase tracking-wide">Total</td>
                            <td className="px-4 py-2 text-right text-gray-800">
                              {tasksToShow.reduce((s, t) => s + t.hoursEffort, 0)}
                            </td>
                            <td className="px-4 py-2 text-right text-gray-800">
                              {tasksToShow.reduce((s, t) => s + t.daysEffort, 0).toFixed(1)}
                            </td>
                            {hasCost && (
                              <td className="px-4 py-2 text-right text-gray-800">
                                {tasksToShow.some(t => t.estimatedCost != null)
                                  ? formatCost(tasksToShow.reduce((s, t) => s + (t.estimatedCost ?? 0), 0))
                                  : '—'}
                              </td>
                            )}
                          </tr>
                        </tbody>
                      </table>
                    </div>
                  )}

                  {expandedRts.has(rt.resourceTypeId) && tasksToShow.length === 0 && (
                    <div className="px-10 py-4 text-sm text-gray-400">No tasks match the current filters.</div>
                  )}
                </div>
              )
            })}
          </div>
        )
      })}
    </div>
  )
}
