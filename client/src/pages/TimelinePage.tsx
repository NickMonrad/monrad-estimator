import { useState, useMemo, useEffect } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/api'
import { useAuth } from '../hooks/useAuth'
import type { Project, ResourceType, TimelineSummary, TimelineEntry } from '../types/backlog'

const EPIC_COLOURS = [
  { bar: 'bg-blue-400', text: 'text-blue-700', light: 'bg-blue-50' },
  { bar: 'bg-purple-400', text: 'text-purple-700', light: 'bg-purple-50' },
  { bar: 'bg-green-400', text: 'text-green-700', light: 'bg-green-50' },
  { bar: 'bg-orange-400', text: 'text-orange-700', light: 'bg-orange-50' },
  { bar: 'bg-pink-400', text: 'text-pink-700', light: 'bg-pink-50' },
]

const CATEGORY_HEADER_BG: Record<string, string> = {
  ENGINEERING: 'bg-blue-100',
  GOVERNANCE: 'bg-amber-100',
  PROJECT_MANAGEMENT: 'bg-green-100',
}

const CATEGORY_LABELS: Record<string, string> = {
  ENGINEERING: 'Engineering',
  GOVERNANCE: 'Governance',
  PROJECT_MANAGEMENT: 'Project Management',
}

function formatDate(iso: string) {
  const d = new Date(iso)
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
}

function addDays(base: Date, days: number) {
  const d = new Date(base)
  d.setDate(d.getDate() + days)
  return d
}

export default function TimelinePage() {
  const { id: projectId } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { user, logout } = useAuth()
  const qc = useQueryClient()

  const [startDateInput, setStartDateInput] = useState('')
  const [resourcesOpen, setResourcesOpen] = useState(true)
  const [editingFeatureId, setEditingFeatureId] = useState<string | null>(null)
  const [editForm, setEditForm] = useState({ startWeek: '', durationWeeks: '' })

  const { data: project } = useQuery<Project>({
    queryKey: ['project', projectId],
    queryFn: () => api.get(`/projects/${projectId}`).then(r => r.data),
  })

  useEffect(() => {
    if (project?.startDate && !startDateInput) {
      setStartDateInput(project.startDate.slice(0, 10))
    }
  }, [project?.startDate])

  const { data: timeline, isLoading } = useQuery<TimelineSummary>({
    queryKey: ['timeline', projectId],
    queryFn: () => api.get(`/projects/${projectId}/timeline`).then(r => r.data),
  })

  const { data: resourceTypes } = useQuery<ResourceType[]>({
    queryKey: ['resource-types', projectId],
    queryFn: () => api.get(`/projects/${projectId}/resource-types`).then(r => r.data),
  })

  const invalidate = () => qc.invalidateQueries({ queryKey: ['timeline', projectId] })

  const scheduleTimeline = useMutation({
    mutationFn: (body: { startDate?: string }) =>
      api.post(`/projects/${projectId}/timeline/schedule`, body).then(r => r.data),
    onSuccess: (data) => {
      qc.setQueryData(['timeline', projectId], data)
      qc.invalidateQueries({ queryKey: ['project', projectId] })
    },
  })

  const saveStartDate = useMutation({
    mutationFn: (startDate: string) =>
      api.patch(`/projects/${projectId}/timeline/start-date`, { startDate }).then(r => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['project', projectId] }),
  })

  const handleStartDateBlur = () => {
    if (startDateInput) saveStartDate.mutate(startDateInput)
  }

  const updateEntry = useMutation({
    mutationFn: ({ featureId, startWeek, durationWeeks }: { featureId: string; startWeek: number; durationWeeks: number }) =>
      api.put(`/projects/${projectId}/timeline/${featureId}`, { startWeek, durationWeeks }).then(r => r.data),
    onSuccess: () => { invalidate(); setEditingFeatureId(null) },
  })

  const updateResourceType = useMutation({
    mutationFn: ({ id, count }: { id: string; count: number }) =>
      api.put(`/projects/${projectId}/resource-types/${id}`, { count }).then(r => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['resource-types', projectId] }),
  })

  const handleSchedule = () => {
    scheduleTimeline.mutate(startDateInput ? { startDate: startDateInput } : {})
  }

  // Compute Gantt dimensions
  const totalWeeks = useMemo(() => {
    if (!timeline?.entries.length) return 0
    return Math.max(...timeline.entries.map(e => e.startWeek + e.durationWeeks)) + 1
  }, [timeline])

  // Group entries by epicId
  const epicGroups = useMemo(() => {
    if (!timeline?.entries.length) return []
    const map = new Map<string, { epicId: string; epicName: string; entries: TimelineEntry[] }>()
    for (const e of timeline.entries) {
      if (!map.has(e.epicId)) map.set(e.epicId, { epicId: e.epicId, epicName: e.epicName, entries: [] })
      map.get(e.epicId)!.entries.push(e)
    }
    return Array.from(map.values())
  }, [timeline])

  const epicColourMap = useMemo(() => {
    const m = new Map<string, typeof EPIC_COLOURS[0]>()
    epicGroups.forEach((g, i) => m.set(g.epicId, EPIC_COLOURS[i % EPIC_COLOURS.length]))
    return m
  }, [epicGroups])

  // Group resource types by category
  const rtByCategory = useMemo(() => {
    if (!resourceTypes) return []
    const map = new Map<string, ResourceType[]>()
    for (const rt of resourceTypes) {
      if (!map.has(rt.category)) map.set(rt.category, [])
      map.get(rt.category)!.push(rt)
    }
    return Array.from(map.entries())
  }, [resourceTypes])

  const projectStartDate = timeline?.startDate ? new Date(timeline.startDate) : null

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white border-b border-gray-200">
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm text-gray-500">
            <button onClick={() => navigate('/')} className="flex items-center gap-2 group">
              <div className="w-8 h-8 bg-red-600 rounded-lg flex items-center justify-center">
                <span className="text-white text-xs font-bold">M</span>
              </div>
            </button>
            <span className="text-gray-300">/</span>
            <Link to={`/projects/${projectId}`} className="hover:text-gray-700">{project?.name ?? 'Project'}</Link>
            <span className="text-gray-300">/</span>
            <span className="text-gray-700 font-medium">Timeline</span>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-sm text-gray-500">{user?.name}</span>
            <button onClick={logout} className="text-sm text-gray-500 hover:text-gray-700">Sign out</button>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-6 py-6 space-y-6">
        <div className="flex items-center justify-between">
          <h1 className="text-xl font-semibold text-gray-900">Timeline Planner</h1>
        </div>

        {/* Setup bar */}
        <div className="bg-white rounded-xl border border-gray-200 p-4">
          <div className="flex flex-wrap items-center gap-4">
            <div>
              <label className="block text-xs text-gray-500 mb-1">Project start date</label>
              <input
                type="date"
                value={startDateInput}
                onChange={e => setStartDateInput(e.target.value)}
                onBlur={handleStartDateBlur}
                className="border border-gray-200 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-red-400"
              />
            </div>
            <div className="flex items-end gap-2">
              <button
                onClick={handleSchedule}
                disabled={scheduleTimeline.isPending}
                className="bg-red-600 text-white px-4 py-1.5 rounded text-sm font-medium hover:bg-red-700 disabled:opacity-50"
              >
                {scheduleTimeline.isPending ? 'Scheduling…' : 'Auto-schedule'}
              </button>
              {timeline?.entries && timeline.entries.length > 0 && (
                <button
                  onClick={handleSchedule}
                  disabled={scheduleTimeline.isPending}
                  className="border border-gray-200 px-4 py-1.5 rounded text-sm text-gray-600 hover:bg-gray-50 disabled:opacity-50"
                >
                  Reset to auto
                </button>
              )}
            </div>
            {timeline?.startDate && (
              <span className="text-xs text-gray-400 ml-auto">
                Last scheduled: {formatDate(timeline.startDate)}
              </span>
            )}
            {!timeline?.startDate && (
              <span className="text-xs text-gray-400 ml-auto">Not yet scheduled</span>
            )}
          </div>
        </div>

        {/* Resource counts panel */}
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          <button
            onClick={() => setResourcesOpen(o => !o)}
            className="w-full flex items-center justify-between px-4 py-3 text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            <span>Resource Counts — adjust before scheduling</span>
            <span className="text-gray-400">{resourcesOpen ? '▲' : '▼'}</span>
          </button>
          {resourcesOpen && (
            <div className="px-4 pb-4">
              <p className="text-xs text-gray-400 mb-3">Counts affect how quickly each feature can be delivered in parallel</p>
              {rtByCategory.map(([category, rts]) => (
                <div key={category} className="mb-4">
                  <div className={`text-xs font-semibold uppercase tracking-wide px-2 py-1 rounded mb-2 ${CATEGORY_HEADER_BG[category]} text-gray-700`}>
                    {CATEGORY_LABELS[category] ?? category}
                  </div>
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-xs text-gray-400">
                        <th className="text-left pb-1 font-normal">Resource Type</th>
                        <th className="text-right pb-1 font-normal w-24">Count</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rts.map(rt => (
                        <tr key={rt.id} className="border-t border-gray-50">
                          <td className="py-1.5 text-gray-700">{rt.name}</td>
                          <td className="py-1.5 text-right">
                            <input
                              type="number"
                              min="1"
                              defaultValue={rt.count}
                              onBlur={e => {
                                const v = parseInt(e.target.value)
                                if (!isNaN(v) && v > 0 && v !== rt.count) {
                                  updateResourceType.mutate({ id: rt.id, count: v })
                                }
                              }}
                              className="w-16 border border-gray-200 rounded px-2 py-0.5 text-sm text-right focus:outline-none focus:ring-1 focus:ring-blue-400"
                            />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Gantt chart */}
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-100">
            <h2 className="text-sm font-medium text-gray-700">Gantt Chart</h2>
          </div>

          {isLoading && <div className="p-8 text-center text-gray-400 text-sm">Loading…</div>}

          {!isLoading && (!timeline?.entries || timeline.entries.length === 0) && (
            <div className="p-8 text-center text-gray-400 text-sm">
              Set a start date and click <strong>Auto-schedule</strong> to generate your timeline
            </div>
          )}

          {!isLoading && timeline?.entries && timeline.entries.length > 0 && (
            <div className="overflow-x-auto">
              {/* Grid with label col + week cols */}
              <div
                className="min-w-max"
                style={{ display: 'grid', gridTemplateColumns: `200px repeat(${totalWeeks}, minmax(60px, 1fr))` }}
              >
                {/* Header row: week labels */}
                <div className="bg-gray-50 border-b border-gray-100 px-3 py-2 text-xs font-medium text-gray-500">Feature</div>
                {Array.from({ length: totalWeeks }, (_, i) => (
                  <div key={i} className="bg-gray-50 border-b border-l border-gray-100 px-1 py-2 text-center">
                    <div className="text-xs font-medium text-gray-600">W{i + 1}</div>
                    {projectStartDate && (
                      <div className="text-xs text-gray-400">{formatDate(addDays(projectStartDate, i * 7).toISOString())}</div>
                    )}
                  </div>
                ))}

                {/* Epic groups */}
                {epicGroups.map((group) => {
                  const colour = epicColourMap.get(group.epicId)!
                  const epicMinWeek = Math.min(...group.entries.map(e => e.startWeek))
                  const epicMaxWeek = Math.max(...group.entries.map(e => e.startWeek + e.durationWeeks))
                  return (
                    <>
                      {/* Epic header row */}
                      <div
                        key={`epic-${group.epicId}`}
                        className={`col-span-full border-b border-gray-100 px-3 py-1.5 text-xs font-semibold text-gray-600 ${colour.light} flex items-center gap-2`}
                        style={{ gridColumn: `1 / span ${totalWeeks + 1}` }}
                      >
                        <span>{group.epicName}</span>
                        <span className="text-gray-400 font-normal">W{epicMinWeek + 1}–W{epicMaxWeek}</span>
                      </div>

                      {/* Feature rows */}
                      {group.entries.map((entry) => (
                        <>
                          <div
                            key={`label-${entry.featureId}`}
                            className="border-b border-gray-50 px-3 py-2 text-sm text-gray-700 truncate cursor-pointer hover:text-red-600"
                            title={entry.featureName}
                            onClick={() => {
                              if (editingFeatureId === entry.featureId) {
                                setEditingFeatureId(null)
                              } else {
                                setEditingFeatureId(entry.featureId)
                                setEditForm({ startWeek: String(entry.startWeek), durationWeeks: String(entry.durationWeeks) })
                              }
                            }}
                          >
                            {entry.featureName}
                          </div>
                          {/* Week cells + Gantt bar */}
                          {Array.from({ length: totalWeeks }, (_, i) => {
                            const isBar = i >= entry.startWeek && i < entry.startWeek + entry.durationWeeks
                            const isFirst = i === entry.startWeek
                            const isLast = i === entry.startWeek + entry.durationWeeks - 1
                            return (
                              <div
                                key={`cell-${entry.featureId}-${i}`}
                                className="border-b border-l border-gray-50 py-2 px-0.5 flex items-center"
                              >
                                {isBar && (
                                  <div
                                    className={`h-6 w-full ${colour.bar} ${isFirst ? 'rounded-l' : ''} ${isLast ? 'rounded-r' : ''} flex items-center px-1 cursor-pointer`}
                                    onClick={() => {
                                      setEditingFeatureId(entry.featureId)
                                      setEditForm({ startWeek: String(entry.startWeek), durationWeeks: String(entry.durationWeeks) })
                                    }}
                                  >
                                    {isFirst && entry.isManual && (
                                      <span className="text-white text-xs">✏</span>
                                    )}
                                  </div>
                                )}
                              </div>
                            )
                          })}

                          {/* Inline edit row */}
                          {editingFeatureId === entry.featureId && (
                            <div
                              key={`edit-${entry.featureId}`}
                              className="bg-blue-50 border-b border-blue-100 px-3 py-2 flex items-center gap-3"
                              style={{ gridColumn: `1 / span ${totalWeeks + 1}` }}
                            >
                              <span className="text-xs text-gray-600 font-medium">{entry.featureName}</span>
                              <label className="text-xs text-gray-500">Start week:</label>
                              <input
                                type="number"
                                min="0"
                                value={editForm.startWeek}
                                onChange={e => setEditForm(f => ({ ...f, startWeek: e.target.value }))}
                                className="w-16 border border-gray-200 rounded px-2 py-0.5 text-sm focus:outline-none focus:ring-1 focus:ring-blue-400"
                              />
                              <label className="text-xs text-gray-500">Duration weeks:</label>
                              <input
                                type="number"
                                min="1"
                                value={editForm.durationWeeks}
                                onChange={e => setEditForm(f => ({ ...f, durationWeeks: e.target.value }))}
                                className="w-16 border border-gray-200 rounded px-2 py-0.5 text-sm focus:outline-none focus:ring-1 focus:ring-blue-400"
                              />
                              <button
                                onClick={() => updateEntry.mutate({
                                  featureId: entry.featureId,
                                  startWeek: parseInt(editForm.startWeek),
                                  durationWeeks: parseInt(editForm.durationWeeks),
                                })}
                                disabled={updateEntry.isPending}
                                className="bg-blue-600 text-white px-3 py-0.5 rounded text-xs font-medium hover:bg-blue-700 disabled:opacity-50"
                              >
                                {updateEntry.isPending ? 'Saving…' : 'Save'}
                              </button>
                              <button
                                onClick={() => setEditingFeatureId(null)}
                                className="px-3 py-0.5 rounded text-xs text-gray-500 hover:bg-gray-100"
                              >
                                Cancel
                              </button>
                            </div>
                          )}
                        </>
                      ))}
                    </>
                  )
                })}
              </div>

              {/* Summary footer */}
              <div className="px-4 py-3 border-t border-gray-100 text-xs text-gray-500">
                {totalWeeks - 1} weeks total · {timeline.entries.length} features scheduled
                {timeline.entries.some(e => e.isManual) && (
                  <span className="ml-2 text-blue-500">· ✏ = manually overridden</span>
                )}
              </div>
            </div>
          )}
        </div>
      </main>
    </div>
  )
}
