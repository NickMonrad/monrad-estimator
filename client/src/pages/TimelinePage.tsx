import { useState, useMemo, useEffect, useRef, useCallback } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/api'
import { useAuth } from '../hooks/useAuth'
import type { Project, ResourceType, TimelineSummary, TimelineEntry, NamedResourceEntry } from '../types/backlog'
import GanttChart from '../components/timeline/GanttChart'
import ResourceHistogram from '../components/timeline/ResourceHistogram'

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

// ---------------------------------------------------------------------------
// Named Resources Panel — shows individual people with their availability bars
// ---------------------------------------------------------------------------
const RESOURCE_COLOURS = [
  'bg-indigo-200', 'bg-emerald-200', 'bg-amber-200', 'bg-sky-200',
  'bg-rose-200', 'bg-violet-200', 'bg-teal-200', 'bg-orange-200',
]

function NamedResourcesPanel({
  namedResources,
  totalWeeks,
  colW,
  labelW,
}: {
  namedResources: NamedResourceEntry[]
  totalWeeks: number
  colW: number
  labelW: number
}) {
  // Group by resource type name
  const grouped = useMemo(() => {
    const map = new Map<string, NamedResourceEntry[]>()
    for (const nr of namedResources) {
      if (!map.has(nr.resourceTypeName)) map.set(nr.resourceTypeName, [])
      map.get(nr.resourceTypeName)!.push(nr)
    }
    return Array.from(map.entries()).sort(([a], [b]) => a.localeCompare(b))
  }, [namedResources])

  const projectEndWeek = totalWeeks - 1

  return (
    <div className="border-t border-gray-200">
      {/* Section header */}
      <div className="flex items-center px-4 py-2 bg-gray-50 border-b border-gray-100">
        <span className="text-xs font-medium text-gray-500">Named Resources</span>
      </div>

      <div className="flex overflow-hidden">
        {/* Left label panel */}
        <div style={{ width: labelW, flexShrink: 0 }} className="bg-white border-r border-gray-100">
          {grouped.map(([rtName, people]) => (
            <div key={rtName}>
              {/* Resource type header */}
              <div className="px-3 py-1.5 bg-gray-50 border-b border-gray-100">
                <span className="text-xs font-semibold text-gray-600">{rtName}</span>
              </div>
              {/* People rows */}
              {people.map((nr, i) => {
                const start = nr.startWeek ?? 0
                const end = nr.endWeek ?? projectEndWeek
                return (
                  <div
                    key={`${rtName}-${nr.name}-${i}`}
                    className="flex flex-col justify-center px-3 border-b border-gray-50"
                    style={{ height: 36 }}
                  >
                    <span className="text-xs text-gray-700 truncate">{nr.name}</span>
                    <span className="text-[10px] text-gray-400">
                      W{start}–W{end} · {nr.allocationPct}%
                    </span>
                  </div>
                )
              })}
            </div>
          ))}
        </div>

        {/* Right bar area */}
        <div className="overflow-x-auto flex-1">
          <div style={{ width: totalWeeks * colW, minHeight: '100%' }} className="relative bg-gray-50/50">
            {/* Vertical grid lines */}
            <svg
              width={totalWeeks * colW}
              height="100%"
              className="absolute inset-0 pointer-events-none"
              preserveAspectRatio="none"
            >
              {Array.from({ length: totalWeeks + 1 }).map((_, i) => (
                <line
                  key={i}
                  x1={i * colW}
                  y1={0}
                  x2={i * colW}
                  y2="100%"
                  stroke="#f3f4f6"
                  strokeWidth={1}
                />
              ))}
            </svg>

            {/* Bars for each group */}
            {(() => {
              let colourIdx = 0
              return grouped.map(([rtName, people]) => (
                <div key={rtName}>
                  {/* Spacer for the resource type header row */}
                  <div className="border-b border-gray-100" style={{ height: 30 }} />
                  {/* Person bars */}
                  {people.map((nr, i) => {
                    const start = nr.startWeek ?? 0
                    const end = nr.endWeek ?? projectEndWeek
                    const barLeft = start * colW
                    const barWidth = Math.max((end - start + 1) * colW - 4, 8)
                    const colour = RESOURCE_COLOURS[(colourIdx++) % RESOURCE_COLOURS.length]
                    return (
                      <div
                        key={`${rtName}-${nr.name}-${i}`}
                        className="relative border-b border-gray-50"
                        style={{ height: 36 }}
                      >
                        <div
                          className={`absolute top-1 ${colour} rounded h-[28px] flex items-center px-2 text-[10px] font-medium text-gray-700 truncate`}
                          style={{ left: barLeft + 2, width: barWidth }}
                          title={`${nr.name}: W${start}–W${end}, ${nr.allocationPct}% allocation`}
                        >
                          {nr.name} — {nr.allocationPct}%
                        </div>
                      </div>
                    )
                  })}
                </div>
              ))
            })()}
          </div>
        </div>
      </div>
    </div>
  )
}

export default function TimelinePage() {
  const { id: projectId } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { user, logout } = useAuth()
  const qc = useQueryClient()

  const [startDateInput, setStartDateInput] = useState('')
  const [resourcesOpen, setResourcesOpen] = useState(true)
  const [editingFeatureId, setEditingFeatureId] = useState<string | null>(null)
  const [editingStoryId, setEditingStoryId] = useState<string | null>(null)
  const [editForm, setEditForm] = useState({ startWeek: '', durationWeeks: '' })
  const [scheduleStale, setScheduleStale] = useState(false)
  const [resourceLevel, setResourceLevel] = useState(false)

  // Scroll sync refs for Gantt + Histogram right panels
  const ganttScrollRef = useRef<HTMLDivElement>(null)
  const histScrollRef = useRef<HTMLDivElement>(null)
  const isSyncingScroll = useRef(false)

  const handleGanttScroll = useCallback(() => {
    if (isSyncingScroll.current) return
    isSyncingScroll.current = true
    if (histScrollRef.current && ganttScrollRef.current) {
      histScrollRef.current.scrollLeft = ganttScrollRef.current.scrollLeft
    }
    isSyncingScroll.current = false
  }, [])

  const handleHistScroll = useCallback(() => {
    if (isSyncingScroll.current) return
    isSyncingScroll.current = true
    if (ganttScrollRef.current && histScrollRef.current) {
      ganttScrollRef.current.scrollLeft = histScrollRef.current.scrollLeft
    }
    isSyncingScroll.current = false
  }, [])

  const { data: project } = useQuery<Project>({
    queryKey: ['project', projectId],
    queryFn: () => api.get(`/projects/${projectId}`).then(r => r.data),
  })

  useEffect(() => {
    if (project?.startDate && !startDateInput) {
      setStartDateInput(project.startDate.slice(0, 10))
    }
  }, [project?.startDate])

  // Populate edit form with current entry values when a feature is selected
  useEffect(() => {
    if (editingFeatureId && timeline?.entries) {
      const entry = timeline.entries.find(e => e.featureId === editingFeatureId)
      if (entry) setEditForm({ startWeek: String(entry.startWeek), durationWeeks: String(entry.durationWeeks) })
    }
  }, [editingFeatureId])

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
    mutationFn: (body: { startDate?: string; resourceLevel?: boolean }) =>
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
    onSuccess: () => { invalidate() },
  })

  const { data: featureDeps = [] } = useQuery<Array<{ featureId: string; dependsOnId: string; feature: { name: string }; dependsOn: { name: string } }>>({
    queryKey: ['feature-deps', projectId],
    queryFn: () => api.get(`/projects/${projectId}/feature-dependencies`).then(r => r.data),
  })

  const addFeatureDep = useMutation({
    mutationFn: ({ featureId, dependsOnId }: { featureId: string; dependsOnId: string }) =>
      api.post(`/projects/${projectId}/feature-dependencies`, { featureId, dependsOnId }).then(r => r.data),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['feature-deps', projectId] }); setScheduleStale(true) },
  })

  const removeFeatureDep = useMutation({
    mutationFn: ({ featureId, dependsOnId }: { featureId: string; dependsOnId: string }) =>
      api.delete(`/projects/${projectId}/feature-dependencies/${featureId}/${dependsOnId}`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['feature-deps', projectId] }); setScheduleStale(true) },
  })

  const updateStoryTimeline = useMutation({
    mutationFn: ({ storyId, startWeek, durationWeeks }: { storyId: string; startWeek: number; durationWeeks: number }) =>
      api.put(`/projects/${projectId}/timeline/stories/${storyId}`, { startWeek, durationWeeks }).then(r => r.data),
    onSuccess: invalidate,
  })

  const addStoryDep = useMutation({
    mutationFn: ({ storyId, dependsOnId }: { storyId: string; dependsOnId: string }) =>
      api.post(`/projects/${projectId}/stories/${storyId}/dependencies`, { dependsOnId }).then(r => r.data),
    onSuccess: invalidate,
  })

  const removeStoryDep = useMutation({
    mutationFn: ({ storyId, dependsOnId }: { storyId: string; dependsOnId: string }) =>
      api.delete(`/projects/${projectId}/stories/${storyId}/dependencies/${dependsOnId}`).then(r => r.data),
    onSuccess: invalidate,
  })

  const updateEpicMode = useMutation({
    mutationFn: ({ epicId, featureMode }: { epicId: string; featureMode: string }) =>
      api.put(`/projects/${projectId}/epics/${epicId}`, { featureMode }).then(r => r.data),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['timeline', projectId] }); setScheduleStale(true) },
  })

  const updateEpicScheduleMode = useMutation({
    mutationFn: ({ epicId, scheduleMode }: { epicId: string; scheduleMode: string }) =>
      api.put(`/projects/${projectId}/epics/${epicId}`, { scheduleMode }).then(r => r.data),
    onSuccess: () => {
      setScheduleStale(true)
      qc.invalidateQueries({ queryKey: ['timeline', projectId] })
    },
  })

  const updateResourceType = useMutation({
    mutationFn: ({ id, ...data }: { id: string; count?: number; hoursPerDay?: number | null; dayRate?: number | null }) => {
      const payload: Record<string, number | null> = {}
      if (data.count !== undefined) payload.count = data.count
      if (data.hoursPerDay !== undefined) payload.hoursPerDay = data.hoursPerDay
      if (data.dayRate !== undefined) payload.dayRate = data.dayRate
      return api.put(`/projects/${projectId}/resource-types/${id}`, payload).then(r => r.data)
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['resource-types', projectId] }),
  })

  const resetManual = useMutation({
    mutationFn: (featureId: string) => api.delete(`/projects/${projectId}/timeline/${featureId}`),
    onSuccess: () => {
      setEditingFeatureId(null)
      scheduleTimeline.mutate(startDateInput ? { startDate: startDateInput, resourceLevel } : { resourceLevel })
    },
  })

  const resetAllManual = useMutation({
    mutationFn: () => api.delete(`/projects/${projectId}/timeline`),
    onSuccess: () => {
      setEditingFeatureId(null)
      scheduleTimeline.mutate(startDateInput ? { startDate: startDateInput, resourceLevel } : { resourceLevel })
    },
  })

  const resetStoryTimeline = useMutation({
    mutationFn: (storyId: string) =>
      api.delete(`/projects/${projectId}/timeline/stories/${storyId}`),
    onSuccess: () => {
      scheduleTimeline.mutate(startDateInput ? { startDate: startDateInput, resourceLevel } : { resourceLevel })
    },
  })

  const reorderEpics = useMutation({
    mutationFn: (items: { id: string; order: number }[]) =>
      api.patch(`/projects/${projectId}/reorder/epics`, { items }).then(r => r.data),
    onSuccess: () => {
      setScheduleStale(true)
      qc.invalidateQueries({ queryKey: ['timeline', projectId] })
    },
  })

  const reorderFeatures = useMutation({
    mutationFn: (items: { id: string; order: number; epicId: string }[]) =>
      api.patch(`/projects/${projectId}/reorder/features`, { items }).then(r => r.data),
    onSuccess: () => {
      setScheduleStale(true)
      qc.invalidateQueries({ queryKey: ['timeline', projectId] })
    },
  })

  function moveEpic(fromIdx: number, toIdx: number) {
    const reordered = [...epicGroups]
    const [moved] = reordered.splice(fromIdx, 1)
    reordered.splice(toIdx, 0, moved)
    reorderEpics.mutate(reordered.map((g, i) => ({ id: g.epicId, order: i + 1 })))
  }

  function moveFeature(epicId: string, fromIdx: number, toIdx: number) {
    const group = epicGroups.find(g => g.epicId === epicId)
    if (!group) return
    const reordered = [...group.entries]
    const [moved] = reordered.splice(fromIdx, 1)
    reordered.splice(toIdx, 0, moved)
    reorderFeatures.mutate(reordered.map((e, i) => ({ id: e.featureId, order: i + 1, epicId })))
  }

  const handleSchedule = () => {
    setScheduleStale(false)
    scheduleTimeline.mutate(startDateInput ? { startDate: startDateInput, resourceLevel } : { resourceLevel })
  }

  // Compute Gantt dimensions
  const totalWeeks = useMemo(() => {
    if (!timeline?.entries.length) return 0
    const featureMax = Math.max(...timeline.entries.map(e => e.startWeek + e.durationWeeks))
    const storyMax = timeline.storyEntries?.length
      ? Math.max(...timeline.storyEntries.map(e => e.startWeek + e.durationWeeks))
      : 0
    return Math.ceil(Math.max(featureMax, storyMax)) + 1
  }, [timeline])

  // Group entries by epicId, sorted by epicOrder then featureOrder
  const epicGroups = useMemo(() => {
    if (!timeline?.entries.length) return []
    const map = new Map<string, { epicId: string; epicName: string; epicOrder: number; entries: TimelineEntry[] }>()
    for (const e of timeline.entries) {
      if (!map.has(e.epicId)) map.set(e.epicId, { epicId: e.epicId, epicName: e.epicName, epicOrder: e.epicOrder ?? 0, entries: [] })
      map.get(e.epicId)!.entries.push(e)
    }
    const groups = Array.from(map.values())
    groups.sort((a, b) => a.epicOrder - b.epicOrder)
    for (const g of groups) g.entries.sort((a, b) => (a.featureOrder ?? 0) - (b.featureOrder ?? 0))
    return groups
  }, [timeline])

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
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex flex-col gap-1">
              <label className="text-xs text-gray-500">Project start date</label>
              <input
                type="date"
                value={startDateInput}
                onChange={e => setStartDateInput(e.target.value)}
                onBlur={handleStartDateBlur}
                className="border border-gray-200 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-red-400"
              />
            </div>
            <div className="w-px h-7 bg-gray-200" />
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
                title="Re-runs the scheduler — use this after updating tasks or resources in the backlog"
              >
                ↺ Re-run scheduler
              </button>
            )}
            {timeline?.entries?.some(e => e.isManual) && (
              <button
                onClick={() => resetAllManual.mutate()}
                disabled={resetAllManual.isPending}
                className="border border-blue-200 text-blue-600 px-4 py-1.5 rounded text-sm hover:bg-blue-50 disabled:opacity-50"
                title="Remove all manual position overrides and let the scheduler place everything automatically"
              >
                {resetAllManual.isPending ? 'Clearing…' : '✕ Clear all overrides'}
              </button>
            )}
            <div className="w-px h-7 bg-gray-200" />
            <label className="flex items-center gap-1.5 text-xs text-gray-600 cursor-pointer">
              <input
                type="checkbox"
                checked={resourceLevel}
                onChange={e => setResourceLevel(e.target.checked)}
                className="rounded"
              />
              Resource leveling
            </label>
            {timeline?.projectedEndDate && (
              <div className="text-sm text-gray-600">
                <span className="text-gray-400">Projected end:</span>{' '}
                <span className="font-medium">{new Date(timeline.projectedEndDate).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}</span>
              </div>
            )}
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

        {/* Stale schedule banner */}
        {scheduleStale && (
          <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 flex items-center justify-between text-sm">
            <span className="text-amber-800">⚠ Dependencies or epic mode changed — re-run <strong>Auto-schedule</strong> to apply.</span>
            <button onClick={handleSchedule} className="bg-amber-500 text-white px-3 py-1 rounded text-xs font-medium hover:bg-amber-600">
              Auto-schedule now
            </button>
          </div>
        )}

        {/* Parallel over-allocation warnings */}
        {(timeline?.parallelWarnings ?? []).length > 0 && (
          <div className="bg-red-50 border border-red-200 rounded-xl px-4 py-3 space-y-1">
            <p className="text-sm font-medium text-red-800">⚠ Resource over-allocation in parallel epics</p>
            {(timeline!.parallelWarnings!).map((w, i) => (
              <p key={i} className="text-xs text-red-700">
                <span className="font-medium">{w.epicName}</span> — {w.resourceTypeName}: {w.demandDays.toFixed(1)} person-days needed, only {w.capacityDays.toFixed(1)} days available at current headcount. Increase count or switch to "Features: sequential" mode.
              </p>
            ))}
          </div>
        )}

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
                        <th className="text-right pb-1 font-normal w-20">Count</th>
                        <th className="text-right pb-1 font-normal w-24">Hrs/day</th>
                        <th className="text-right pb-1 font-normal w-28">Day rate</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rts.map(rt => (
                        <tr key={rt.id} className="border-t border-gray-50">
                          <td className="py-1.5 text-gray-700">{rt.name}</td>
                          <td className="py-1.5 text-right">
                            <input
                              key={`count-${rt.id}-${rt.count}`}
                              type="number"
                              min="1"
                              defaultValue={rt.count}
                              onBlur={e => {
                                const v = parseInt(e.target.value, 10)
                                if (!Number.isFinite(v) || v <= 0 || v === rt.count) return
                                updateResourceType.mutate({ id: rt.id, count: v })
                              }}
                              className="w-16 border border-gray-200 rounded px-2 py-0.5 text-sm text-right focus:outline-none focus:ring-1 focus:ring-blue-400"
                            />
                          </td>
                          <td className="py-1.5 text-right">
                            <input
                              key={`hours-${rt.id}-${rt.hoursPerDay ?? 'null'}`}
                              type="number"
                              step="0.1"
                              defaultValue={rt.hoursPerDay ?? ''}
                              placeholder={project?.hoursPerDay ? String(project.hoursPerDay) : ''}
                              onBlur={e => {
                                const value = e.target.value.trim()
                                const parsed = value === '' ? null : parseFloat(value)
                                if (parsed !== null && !Number.isFinite(parsed)) return
                                const current = rt.hoursPerDay ?? null
                                if (parsed === current) return
                                updateResourceType.mutate({ id: rt.id, hoursPerDay: parsed })
                              }}
                              className="w-20 border border-gray-200 rounded px-2 py-0.5 text-sm text-right focus:outline-none focus:ring-1 focus:ring-blue-400"
                            />
                          </td>
                          <td className="py-1.5 text-right">
                            <input
                              key={`rate-${rt.id}-${rt.dayRate ?? 'null'}`}
                              type="number"
                              step="50"
                              defaultValue={rt.dayRate ?? ''}
                              placeholder={rt.globalType?.defaultDayRate != null ? String(rt.globalType.defaultDayRate) : '—'}
                              onBlur={e => {
                                const value = e.target.value.trim()
                                const parsed = value === '' ? null : parseFloat(value)
                                if (parsed !== null && !Number.isFinite(parsed)) return
                                const current = rt.dayRate ?? null
                                if (parsed === current) return
                                updateResourceType.mutate({ id: rt.id, dayRate: parsed })
                              }}
                              className="w-24 border border-gray-200 rounded px-2 py-0.5 text-sm text-right focus:outline-none focus:ring-1 focus:ring-blue-400"
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
        <div className="bg-white rounded-xl border border-gray-200">
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
            <>
              <GanttChart
                entries={timeline.entries}
                storyEntries={timeline.storyEntries}
                featureDependencies={timeline.featureDependencies}
                storyDependencies={timeline.storyDependencies}
                totalWeeks={totalWeeks}
                projectStartDate={projectStartDate}
                onDragFeature={(featureId, newStartWeek) => {
                  const entry = timeline.entries.find(e => e.featureId === featureId)
                  if (!entry) return
                  updateEntry.mutate({ featureId, startWeek: newStartWeek, durationWeeks: entry.durationWeeks })
                }}
                onDragStory={(storyId, newStartWeek) => {
                  const entry = timeline.storyEntries?.find(e => e.storyId === storyId)
                  if (!entry) return
                  updateStoryTimeline.mutate({ storyId, startWeek: newStartWeek, durationWeeks: entry.durationWeeks })
                }}
                onAddFeatureDep={(featureId, dependsOnId) => addFeatureDep.mutate({ featureId, dependsOnId })}
                onRemoveFeatureDep={(featureId, dependsOnId) => removeFeatureDep.mutate({ featureId, dependsOnId })}
                onAddStoryDep={(storyId, dependsOnId) => addStoryDep.mutate({ storyId, dependsOnId })}
                onRemoveStoryDep={(storyId, dependsOnId) => removeStoryDep.mutate({ storyId, dependsOnId })}
                editingFeatureId={editingFeatureId}
                setEditingFeatureId={setEditingFeatureId}
                editingStoryId={editingStoryId}
                setEditingStoryId={setEditingStoryId}
                onMoveEpic={(_epicId, direction, epicIdx) => {
                  const toIdx = direction === 'up' ? epicIdx - 1 : epicIdx + 1
                  moveEpic(epicIdx, toIdx)
                }}
                onMoveFeature={(epicId, featureIdx, direction) => {
                  const toIdx = direction === 'up' ? featureIdx - 1 : featureIdx + 1
                  moveFeature(epicId, featureIdx, toIdx)
                }}
                onUpdateEpicMode={(epicId, featureMode) =>
                  updateEpicMode.mutate({ epicId, featureMode })
                }
                onUpdateEpicScheduleMode={(epicId, scheduleMode) =>
                  updateEpicScheduleMode.mutate({ epicId, scheduleMode })
                }
                rightPanelRef={ganttScrollRef}
                onRightPanelScroll={handleGanttScroll}
              />

              {/* Resource allocation histogram */}
              {timeline.weeklyDemand && timeline.weeklyDemand.length > 0 && (
                <ResourceHistogram
                  weeklyDemand={timeline.weeklyDemand}
                  totalWeeks={totalWeeks}
                  colW={64}
                  labelW={300}
                  scrollContainerRef={histScrollRef}
                  onScroll={handleHistScroll}
                />
              )}

              {/* Named Resources — individual people and their availability */}
              {timeline.namedResources && timeline.namedResources.length > 0 && (
                <NamedResourcesPanel
                  namedResources={timeline.namedResources}
                  totalWeeks={totalWeeks}
                  colW={64}
                  labelW={300}
                />
              )}

              {/* Inline edit panel — shown below chart when a feature is selected */}
              {editingFeatureId && (() => {
                const entry = timeline.entries.find(e => e.featureId === editingFeatureId)
                if (!entry) return null
                return (
                  <div className="sticky bottom-0 z-20 border-t border-blue-200 bg-blue-50 shadow-md px-4 py-3 flex flex-wrap items-center gap-3">
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
                      min="0.2"
                      value={editForm.durationWeeks}
                      onChange={e => setEditForm(f => ({ ...f, durationWeeks: e.target.value }))}
                      className="w-16 border border-gray-200 rounded px-2 py-0.5 text-sm focus:outline-none focus:ring-1 focus:ring-blue-400"
                    />
                    <button
                      onClick={() => updateEntry.mutate({
                        featureId: entry.featureId,
                        startWeek: parseFloat(editForm.startWeek),
                        durationWeeks: parseFloat(editForm.durationWeeks),
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
                    {entry.isManual && (
                      <button
                        onClick={() => resetManual.mutate(entry.featureId)}
                        disabled={resetManual.isPending}
                        title="Clear manual override and re-run auto-schedule"
                        className="px-3 py-0.5 rounded text-xs text-orange-600 border border-orange-200 hover:bg-orange-50 disabled:opacity-50"
                      >
                        {resetManual.isPending ? 'Resetting…' : '↺ Reset to auto'}
                      </button>
                    )}
                    {/* Dependencies section */}
                    <div className="mt-2 w-full" data-testid="dep-section">
                      <div className="px-3 py-2 bg-blue-50 border-t border-blue-100">
                        <p className="text-xs font-medium text-gray-600 mb-1">Depends on (must finish before this feature starts):</p>
                        <div className="flex flex-wrap gap-1 mb-2">
                          {featureDeps
                            .filter(d => d.featureId === entry.featureId)
                            .map(d => (
                              <span key={d.dependsOnId} className="inline-flex items-center gap-1 bg-white border border-gray-200 rounded px-2 py-0.5 text-xs text-gray-700">
                                {d.dependsOn.name}
                                <button
                                  onClick={() => removeFeatureDep.mutate({ featureId: entry.featureId, dependsOnId: d.dependsOnId })}
                                  className="text-gray-400 hover:text-red-500 ml-1"
                                >✕</button>
                              </span>
                            ))}
                          {featureDeps.filter(d => d.featureId === entry.featureId).length === 0 && (
                            <span className="text-xs text-gray-400">None</span>
                          )}
                        </div>
                        <div className="flex items-center gap-2">
                          <select
                            className="border border-gray-200 rounded px-2 py-0.5 text-xs text-gray-700 focus:outline-none focus:ring-1 focus:ring-blue-400"
                            value=""
                            onChange={e => {
                              if (e.target.value) {
                                addFeatureDep.mutate({ featureId: entry.featureId, dependsOnId: e.target.value })
                                e.target.value = ''
                              }
                            }}
                          >
                            <option value="">+ Add dependency…</option>
                            {timeline?.entries
                              .filter(e2 => e2.featureId !== entry.featureId && !featureDeps.some(d => d.featureId === entry.featureId && d.dependsOnId === e2.featureId))
                              .map(e2 => (
                                <option key={e2.featureId} value={e2.featureId}>{e2.epicName} / {e2.featureName}</option>
                              ))}
                          </select>
                        </div>
                      </div>
                    </div>
                  </div>
                )
              })()}

              {editingStoryId && (() => {
                const storyEntry = timeline.storyEntries?.find(e => e.storyId === editingStoryId)
                if (!storyEntry) return null
                return (
                  <div className="sticky bottom-0 z-20 border-t border-blue-200 bg-blue-50 shadow-md px-4 py-3 flex items-center justify-between gap-4">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="text-sm font-medium text-blue-800 truncate">{storyEntry.storyName}</span>
                      {storyEntry.isManual && <span className="text-xs bg-blue-200 text-blue-700 px-1.5 py-0.5 rounded">✏ manual</span>}
                    </div>
                    <div className="flex items-center gap-3 flex-shrink-0">
                      {storyEntry.isManual && (
                        <button
                          onClick={() => { resetStoryTimeline.mutate(editingStoryId); setEditingStoryId(null) }}
                          className="text-xs text-blue-600 hover:text-blue-800 underline"
                        >
                          Reset to auto
                        </button>
                      )}
                      <button
                        onClick={() => setEditingStoryId(null)}
                        className="text-xs text-gray-500 hover:text-gray-700"
                      >
                        Close ✕
                      </button>
                    </div>
                  </div>
                )
              })()}

              {/* Summary footer */}
              <div className="px-4 py-3 border-t border-gray-100 text-xs text-gray-500">
                {Math.ceil(totalWeeks - 1)} weeks total · {timeline.entries.length} features scheduled
                {timeline.entries.some(e => e.isManual) && (
                  <span className="ml-2 text-blue-500">· ✏ = manually overridden</span>
                )}
              </div>
            </>
          )}
        </div>
      </main>
    </div>
  )
}
