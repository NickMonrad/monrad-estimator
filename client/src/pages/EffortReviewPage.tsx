import { useMemo, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { api } from '../lib/api'
import AppLayout from '../components/layout/AppLayout'
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

// ── CSV export helpers ────────────────────────────────────────────────────────

function csvEscape(value: string | number | null | undefined): string {
  const str = value == null ? '' : String(value)
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return '"' + str.replace(/"/g, '""') + '"'
  }
  return str
}

function buildSummaryCSV(effort: EffortSummary, hasCost: boolean): string {
  const grandTotal = effort.totalCost ?? 0
  const headers = hasCost
    ? ['Category', 'Resource Type', 'Count', 'Proposed Name', 'Total Hours', 'Total Days', 'Day Rate', 'Estimated Cost', '% of Total']
    : ['Category', 'Resource Type', 'Count', 'Proposed Name', 'Total Hours', 'Total Days', '% of Total']

  const rows: string[][] = [headers]

  for (const cat of effort.byCategory) {
    const catLabel = CATEGORY_LABELS[cat.category]
    for (const rt of cat.resourceTypes) {
      const pct = grandTotal > 0 && rt.estimatedCost != null
        ? ((rt.estimatedCost / grandTotal) * 100).toFixed(1) + '%'
        : ''
      const row = hasCost
        ? [
            catLabel,
            rt.name,
            String(rt.count),
            rt.proposedName ?? '',
            rt.totalHours.toFixed(1) + 'h',
            rt.totalDays.toFixed(1) + 'd',
            rt.dayRate != null ? '$' + rt.dayRate : '',
            rt.estimatedCost != null ? '$' + Math.round(rt.estimatedCost) : '',
            pct,
          ]
        : [
            catLabel,
            rt.name,
            String(rt.count),
            rt.proposedName ?? '',
            rt.totalHours.toFixed(1) + 'h',
            rt.totalDays.toFixed(1) + 'd',
            pct,
          ]
      rows.push(row)
    }

    // Category subtotal row
    const catPct = grandTotal > 0 && cat.totalCost != null
      ? ((cat.totalCost / grandTotal) * 100).toFixed(1) + '%'
      : ''
    const subtotal = hasCost
      ? [
          catLabel + ' Total',
          '', '',
          '',
          cat.totalHours.toFixed(1) + 'h',
          cat.totalDays.toFixed(1) + 'd',
          '',
          cat.totalCost != null ? '$' + Math.round(cat.totalCost) : '',
          catPct,
        ]
      : [
          catLabel + ' Total',
          '', '', '',
          cat.totalHours.toFixed(1) + 'h',
          cat.totalDays.toFixed(1) + 'd',
          catPct,
        ]
    rows.push(subtotal)
  }

  // Grand total
  const grandRow = hasCost
    ? [
        'Grand Total',
        '', '', '',
        effort.totalHours.toFixed(1) + 'h',
        effort.totalDays.toFixed(1) + 'd',
        '',
        grandTotal > 0 ? '$' + Math.round(grandTotal) : '',
        '100%',
      ]
    : [
        'Grand Total',
        '', '', '',
        effort.totalHours.toFixed(1) + 'h',
        effort.totalDays.toFixed(1) + 'd',
        '100%',
      ]
  rows.push(grandRow)

  return rows.map(r => r.map(csvEscape).join(',')).join('\n')
}

function buildDetailCSV(effort: EffortSummary, hasCost: boolean): string {
  const headers = hasCost
    ? ['Category', 'Resource Type', 'Epic', 'Feature', 'Story', 'Task', 'Hours', 'Days', 'Day Rate', 'Estimated Cost']
    : ['Category', 'Resource Type', 'Epic', 'Feature', 'Story', 'Task', 'Hours', 'Days']

  const rows: string[][] = [headers]

  for (const cat of effort.byCategory) {
    const catLabel = CATEGORY_LABELS[cat.category]
    for (const rt of cat.resourceTypes) {
      for (const task of rt.tasks) {
        const row = hasCost
          ? [
              catLabel,
              rt.name,
              task.epicName,
              task.featureName,
              task.storyName,
              task.taskName,
              task.hoursEffort.toFixed(2) + 'h',
              task.daysEffort.toFixed(2) + 'd',
              rt.dayRate != null ? '$' + rt.dayRate : '',
              task.estimatedCost != null ? '$' + Math.round(task.estimatedCost) : '',
            ]
          : [
              catLabel,
              rt.name,
              task.epicName,
              task.featureName,
              task.storyName,
              task.taskName,
              task.hoursEffort.toFixed(2) + 'h',
              task.daysEffort.toFixed(2) + 'd',
            ]
        rows.push(row)
      }
    }
  }

  // Totals row
  const totalCost = effort.totalCost
  const totalRow = hasCost
    ? [
        'Total',
        '', '', '', '', '',
        effort.totalHours.toFixed(1) + 'h',
        effort.totalDays.toFixed(1) + 'd',
        '',
        totalCost != null ? '$' + Math.round(totalCost) : '',
      ]
    : [
        'Total',
        '', '', '', '', '',
        effort.totalHours.toFixed(1) + 'h',
        effort.totalDays.toFixed(1) + 'd',
      ]
  rows.push(totalRow)

  return rows.map(r => r.map(csvEscape).join(',')).join('\n')
}

function exportCSV(
  view: 'summary' | 'detail',
  effort: EffortSummary,
  hasCost: boolean,
  projectName: string
): void {
  const date = new Date().toISOString().slice(0, 10)
  const type = view === 'summary' ? 'Effort Summary' : 'Effort Detail'
  const filename = `${projectName} - ${type} - ${date}.csv`
  const csv = view === 'summary'
    ? buildSummaryCSV(effort, hasCost)
    : buildDetailCSV(effort, hasCost)

  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  URL.revokeObjectURL(url)
}

const CATEGORY_LABELS: Record<ResourceCategory, string> = {
  ENGINEERING: 'Engineering',
  GOVERNANCE: 'Governance',
  PROJECT_MANAGEMENT: 'Project Management',
}

const CATEGORY_ROW_BG: Record<ResourceCategory, string> = {
  ENGINEERING: 'bg-blue-50 dark:bg-blue-950',
  GOVERNANCE: 'bg-amber-50 dark:bg-amber-950',
  PROJECT_MANAGEMENT: 'bg-green-50 dark:bg-green-950',
}

const CATEGORY_HEADER_BG: Record<ResourceCategory, string> = {
  ENGINEERING: 'bg-blue-100 dark:bg-blue-900',
  GOVERNANCE: 'bg-amber-100 dark:bg-amber-900',
  PROJECT_MANAGEMENT: 'bg-green-100 dark:bg-green-900',
}

const CATEGORY_BAR_BG: Record<ResourceCategory, string> = {
  ENGINEERING: 'bg-blue-400',
  GOVERNANCE: 'bg-amber-400',
  PROJECT_MANAGEMENT: 'bg-green-400',
}

export default function EffortReviewPage() {
  const { id: projectId } = useParams<{ id: string }>()
  const navigate = useNavigate()
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
    <AppLayout
      breadcrumb={<>
          <span>/</span>
          <button onClick={() => navigate(`/projects/${projectId}`)} className="hover:text-lab3-navy dark:hover:text-lab3-blue transition-colors">
            {project?.name ?? '…'}
          </button>
          <span>/</span>
          <span className="text-gray-700 dark:text-gray-300">Effort Review</span>
        </>}
    >
      <main className="max-w-6xl mx-auto px-6 py-8">
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-xl font-semibold text-gray-900 dark:text-white">Effort Review</h1>
          <div className="flex items-center gap-3">
            {/* Export CSV */}
            <button
              onClick={() => filteredEffort && exportCSV(view, filteredEffort, hasCost, project?.name ?? 'Export')}
              disabled={!filteredEffort}
              className="text-sm px-3 py-1.5 rounded-lg border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 bg-white dark:bg-gray-800 hover:bg-gray-50 dark:hover:bg-gray-700 font-medium disabled:opacity-40"
            >
              Export CSV
            </button>
            {/* Active-only toggle */}
            <button
              onClick={() => setActiveOnly(v => !v)}
              className={`text-sm px-3 py-1.5 rounded-lg border font-medium transition-colors ${
                activeOnly
                  ? 'bg-green-600 text-white border-green-600'
                  : 'bg-white dark:bg-gray-800 text-gray-600 dark:text-gray-400 border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-700'
              }`}
            >
              {activeOnly ? 'Active scope' : 'All tasks'}
            </button>
            {/* View toggle */}
            <div className="flex rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden text-sm">
              <button
                onClick={() => setView('summary')}
                className={`px-4 py-2 font-medium transition-colors ${view === 'summary' ? 'bg-lab3-navy text-white' : 'bg-white dark:bg-gray-800 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700'}`}
              >
                Summary
              </button>
              <button
                onClick={() => setView('detail')}
                className={`px-4 py-2 font-medium transition-colors ${view === 'detail' ? 'bg-lab3-navy text-white' : 'bg-white dark:bg-gray-800 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700'}`}
              >
                Detail
              </button>
            </div>
          </div>
        </div>

        {/* Summary bar */}
        {filteredEffort && (
          <div className={`grid gap-4 mb-6 ${hasCost ? 'grid-cols-4' : 'grid-cols-3'}`}>
            <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-4 text-center">
              <p className="text-2xl font-bold text-gray-900 dark:text-white">{filteredEffort.totalHours.toFixed(0)}h</p>
              <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">Total hours</p>
            </div>
            <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-4 text-center">
              <p className="text-2xl font-bold text-gray-900 dark:text-white">{filteredEffort.totalDays.toFixed(1)}</p>
              <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">Total days</p>
            </div>
            <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-4 text-center">
              <p className="text-2xl font-bold text-gray-900 dark:text-white">{totalResourceTypes}</p>
              <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">Resource types</p>
            </div>
            {hasCost && filteredEffort.totalCost != null && (
              <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-4 text-center">
                <p className="text-2xl font-bold text-gray-900 dark:text-white">{formatCost(filteredEffort.totalCost)}</p>
                <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">Total cost</p>
              </div>
            )}
          </div>
        )}

        {isLoading && <div className="text-center py-12 text-gray-400 dark:text-gray-500">Loading…</div>}

        {filteredEffort && filteredEffort.byCategory.length === 0 && (
          <div className="text-center py-16 text-gray-400 dark:text-gray-500">
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
    <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-700">
            <th className="text-left px-4 py-3 font-medium text-gray-600 dark:text-gray-300">Resource Type</th>
            <th className="text-center px-4 py-3 font-medium text-gray-600 dark:text-gray-300">Count</th>
            <th className="text-left px-4 py-3 font-medium text-gray-600 dark:text-gray-300">Proposed Name</th>
            <th className="text-right px-4 py-3 font-medium text-gray-600 dark:text-gray-300">Hours</th>
            <th className="text-right px-4 py-3 font-medium text-gray-600 dark:text-gray-300">Days</th>
            {hasCost && <th className="text-right px-4 py-3 font-medium text-gray-600 dark:text-gray-300">Day Rate</th>}
            {hasCost && <th className="text-right px-4 py-3 font-medium text-gray-600 dark:text-gray-300">Cost</th>}
            <th className="text-right px-4 py-3 font-medium text-gray-600 dark:text-gray-300">% of Total</th>
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
                <td colSpan={hasCost ? 6 : 5} className="px-4 py-2.5 font-bold text-gray-800 dark:text-white">
                  <span className="mr-2 text-xs">{collapsedCategories.has(cat.category) ? '▶' : '▼'}</span>
                  {CATEGORY_LABELS[cat.category]}
                </td>
                {hasCost && (
                  <td className="px-4 py-2.5 text-right font-bold text-gray-800 dark:text-white">
                    {cat.totalCost != null ? formatCost(cat.totalCost) : '—'}
                  </td>
                )}
                <td className="px-4 py-2.5 text-right font-bold text-gray-800 dark:text-white">
                  {totalHours > 0 ? ((cat.totalHours / totalHours) * 100).toFixed(1) : '0.0'}%
                </td>
                <td className="px-4 py-2.5 text-right font-medium text-gray-700 dark:text-gray-300">
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
                      className={`${CATEGORY_ROW_BG[rt.category]} border-t border-gray-100 dark:border-gray-700 ${hasEpics ? 'cursor-pointer' : ''}`}
                      onClick={hasEpics ? () => toggleRtEpic(rt.resourceTypeId) : undefined}
                    >
                      <td className="px-4 py-2.5 text-gray-800 dark:text-gray-200 pl-8">
                        {hasEpics && (
                          <span className="mr-2 text-xs text-gray-400 dark:text-gray-500">{isExpanded ? '▼' : '▶'}</span>
                        )}
                        {rt.name}
                      </td>
                      <td className="px-4 py-2.5 text-center text-gray-600 dark:text-gray-300">{rt.count}</td>
                      <td className="px-4 py-2.5 text-gray-500 dark:text-gray-400">{rt.proposedName ?? '—'}</td>
                      <td className="px-4 py-2.5 text-right text-gray-800 dark:text-gray-200">{rt.totalHours}</td>
                      <td className="px-4 py-2.5 text-right text-gray-800 dark:text-gray-200">{rt.totalDays}</td>
                      {hasCost && (
                        <td className="px-4 py-2.5 text-right text-gray-600 dark:text-gray-400">
                          {rt.dayRate != null ? '$' + rt.dayRate.toLocaleString() : '—'}
                        </td>
                      )}
                      {hasCost && (
                        <td className="px-4 py-2.5 text-right text-gray-800 dark:text-gray-200">
                          {rt.estimatedCost != null ? formatCost(rt.estimatedCost) : '—'}
                        </td>
                      )}
                      <td className="px-4 py-2.5 text-right text-gray-600 dark:text-gray-400">{pct.toFixed(1)}%</td>
                      <td className="px-4 py-2.5 w-32">
                        <div className="h-2 bg-gray-200 dark:bg-gray-600 rounded-full overflow-hidden">
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
                        className={`${CATEGORY_ROW_BG[rt.category]} border-t border-gray-100 dark:border-gray-700 opacity-90`}
                      >
                        <td className="px-4 py-2 text-gray-700 dark:text-gray-300 pl-12 italic">{epic.epicName}</td>
                        <td />
                        <td />
                        <td className="px-4 py-2 text-right text-gray-700 dark:text-gray-300">{Number(epic.totalHours).toFixed(2)}</td>
                        <td className="px-4 py-2 text-right text-gray-700 dark:text-gray-300">{Number(epic.totalDays).toFixed(2)}</td>
                        {hasCost && <td />}
                        {hasCost && (
                          <td className="px-4 py-2 text-right text-gray-700 dark:text-gray-300">
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
                <tr key={`subtotal-${cat.category}`} className={`${CATEGORY_HEADER_BG[cat.category]} border-t border-gray-200 dark:border-gray-700`}>
                  <td colSpan={3} className="px-4 py-2 pl-8 font-semibold text-gray-700 dark:text-gray-300 text-xs uppercase tracking-wide">
                    {CATEGORY_LABELS[cat.category]} subtotal
                  </td>
                  <td className="px-4 py-2 text-right font-semibold text-gray-800 dark:text-gray-200">{cat.totalHours}</td>
                  <td className="px-4 py-2 text-right font-semibold text-gray-800 dark:text-gray-200">{cat.totalDays}</td>
                  {hasCost && <td />}
                  {hasCost && (
                    <td className="px-4 py-2 text-right font-semibold text-gray-800 dark:text-gray-200">
                      {cat.totalCost != null ? formatCost(cat.totalCost) : '—'}
                    </td>
                  )}
                  <td colSpan={2} />
                </tr>
              )}
            </>
          ))}

          {/* Grand total row */}
          <tr className="bg-gray-100 dark:bg-gray-700 border-t-2 border-gray-300 dark:border-gray-600">
            <td colSpan={3} className="px-4 py-3 font-bold text-gray-900 dark:text-white">Grand Total</td>
            <td className="px-4 py-3 text-right font-bold text-gray-900 dark:text-white">{effort.totalHours}</td>
            <td className="px-4 py-3 text-right font-bold text-gray-900 dark:text-white">{effort.totalDays}</td>
            {hasCost && <td />}
            {hasCost && (
              <td className="px-4 py-3 text-right font-bold text-gray-900 dark:text-white">
                {effort.totalCost != null ? formatCost(effort.totalCost) : '—'}
              </td>
            )}
            <td className="px-4 py-3 text-right font-bold text-gray-900 dark:text-white">100%</td>
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
      <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-4 space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={epicFilter}
            onChange={e => { setEpicFilter(e.target.value); setFeatureFilter(''); setStoryFilter('') }}
            className="text-sm border border-gray-200 dark:border-gray-600 rounded px-2 py-1.5 text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-700"
          >
            <option value="">All Epics</option>
            {uniqueEpics.map(e => <option key={e} value={e}>{e}</option>)}
          </select>

          <select
            value={featureFilter}
            onChange={e => { setFeatureFilter(e.target.value); setStoryFilter('') }}
            className="text-sm border border-gray-200 dark:border-gray-600 rounded px-2 py-1.5 text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-700"
          >
            <option value="">All Features</option>
            {uniqueFeatures.map(f => <option key={f} value={f}>{f}</option>)}
          </select>

          <select
            value={storyFilter}
            onChange={e => setStoryFilter(e.target.value)}
            className="text-sm border border-gray-200 dark:border-gray-600 rounded px-2 py-1.5 text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-700"
          >
            <option value="">All Stories</option>
            {uniqueStories.map(s => <option key={s} value={s}>{s}</option>)}
          </select>

          <select
            value={rtFilter}
            onChange={e => setRtFilter(e.target.value)}
            className="text-sm border border-gray-200 dark:border-gray-600 rounded px-2 py-1.5 text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-700"
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
              className="text-sm border border-gray-200 dark:border-gray-600 rounded px-2 py-1.5 pl-7 text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-700 w-40"
            />
            <span className="absolute left-2 top-1/2 -translate-y-1/2 text-gray-400 dark:text-gray-500 text-xs">🔍</span>
          </div>

          {hasAnyFilter && (
            <button
              onClick={clearAll}
              className="text-sm px-3 py-1.5 rounded border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
            >
              Clear all
            </button>
          )}
        </div>
        <p className="text-xs text-gray-500 dark:text-gray-400">
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
          <div key={cat.category} className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden">
            <div className={`${CATEGORY_HEADER_BG[cat.category]} px-4 py-3`}>
              <span className="font-bold text-gray-800 dark:text-white">{CATEGORY_LABELS[cat.category]}</span>
              <span className="ml-3 text-sm text-gray-600 dark:text-gray-400">{cat.totalHours}h · {cat.totalDays} days</span>
            </div>

            {filteredRts.map(rt => {
              const tasksToShow = hasAnyFilter ? rt.visibleTasks : rt.tasks
              return (
                <div key={rt.resourceTypeId} className="border-t border-gray-100 dark:border-gray-700">
                  <button
                    className={`w-full text-left ${CATEGORY_ROW_BG[rt.category]} px-4 py-3 flex items-center justify-between hover:brightness-95 transition-all`}
                    onClick={() => onToggleRt(rt.resourceTypeId)}
                  >
                    <div className="flex items-center gap-3">
                      <span className="text-xs text-gray-400 dark:text-gray-500">{expandedRts.has(rt.resourceTypeId) ? '▼' : '▶'}</span>
                      <span className="font-medium text-gray-900 dark:text-white">{rt.name}</span>
                      {rt.proposedName && <span className="text-xs text-gray-500 dark:text-gray-400">({rt.proposedName})</span>}
                      <span className="text-xs text-gray-500 dark:text-gray-400 bg-white dark:bg-gray-700 px-2 py-0.5 rounded-full border border-gray-200 dark:border-gray-600">×{rt.count}</span>
                    </div>
                    <span className="text-sm text-gray-600 dark:text-gray-400">
                      {rt.totalHours}h · {rt.totalDays}d · {tasksToShow.length} task{tasksToShow.length !== 1 ? 's' : ''}
                    </span>
                  </button>

                  {expandedRts.has(rt.resourceTypeId) && tasksToShow.length > 0 && (
                    <div className="border-t border-gray-100 dark:border-gray-700">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="bg-gray-50 dark:bg-gray-700 text-gray-500 dark:text-gray-400">
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
                            <tr key={task.taskId} className="border-t border-gray-100 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-700">
                              <td className="px-4 py-2 text-gray-600 dark:text-gray-400 pl-10">{task.epicName}</td>
                              <td className="px-4 py-2 text-gray-600 dark:text-gray-400">{task.featureName}</td>
                              <td className="px-4 py-2 text-gray-600 dark:text-gray-400">{task.storyName}</td>
                              <td className="px-4 py-2 text-gray-900 dark:text-white">{task.taskName}</td>
                              <td className="px-4 py-2 text-right text-gray-800 dark:text-gray-200">{task.hoursEffort}</td>
                              <td className="px-4 py-2 text-right text-gray-800 dark:text-gray-200">{task.daysEffort}</td>
                              {hasCost && (
                                <td className="px-4 py-2 text-right text-gray-800 dark:text-gray-200">
                                  {task.estimatedCost != null ? formatCost(task.estimatedCost) : '—'}
                                </td>
                              )}
                            </tr>
                          ))}
                          {/* Totals row */}
                          <tr className="border-t border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-700 font-semibold">
                            <td colSpan={4} className="px-4 py-2 pl-10 text-gray-700 dark:text-gray-300 text-xs uppercase tracking-wide">Total</td>
                            <td className="px-4 py-2 text-right text-gray-800 dark:text-gray-200">
                              {tasksToShow.reduce((s, t) => s + t.hoursEffort, 0)}
                            </td>
                            <td className="px-4 py-2 text-right text-gray-800 dark:text-gray-200">
                              {tasksToShow.reduce((s, t) => s + t.daysEffort, 0).toFixed(1)}
                            </td>
                            {hasCost && (
                              <td className="px-4 py-2 text-right text-gray-800 dark:text-gray-200">
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
                    <div className="px-10 py-4 text-sm text-gray-400 dark:text-gray-500">No tasks match the current filters.</div>
                  )}
                </div>
              )
            })}
          </div>
        )
      })}
  </AppLayout>
  )
}
