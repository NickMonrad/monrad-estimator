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
  const [scheduleStale, setScheduleStale] = useState(false)
  const [resourceLevel, setResourceLevel] = useState(false)
  const [tooltip, setTooltip] = useState<{ x: number; y: number; entry: TimelineEntry } | null>(null)

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
    onSuccess: () => { invalidate(); setEditingFeatureId(null) },
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
    return Math.ceil(Math.max(...timeline.entries.map(e => e.startWeek + e.durationWeeks))) + 1
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
              <label className="flex items-center gap-1.5 text-xs text-gray-600 cursor-pointer">
                <input
                  type="checkbox"
                  checked={resourceLevel}
                  onChange={e => setResourceLevel(e.target.checked)}
                  className="rounded"
                />
                Resource leveling
              </label>
            </div>
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
                {epicGroups.map((group, epicIdx) => {
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
                        {/* Epic reorder arrows */}
                        <div className="flex flex-col -my-0.5 mr-1">
                          <button
                            onClick={() => moveEpic(epicIdx, epicIdx - 1)}
                            disabled={epicIdx === 0 || reorderEpics.isPending}
                            className="text-gray-300 hover:text-gray-600 disabled:opacity-0 disabled:cursor-default leading-none text-xs"
                            title="Move epic up"
                          >▲</button>
                          <button
                            onClick={() => moveEpic(epicIdx, epicIdx + 1)}
                            disabled={epicIdx === epicGroups.length - 1 || reorderEpics.isPending}
                            className="text-gray-300 hover:text-gray-600 disabled:opacity-0 disabled:cursor-default leading-none text-xs"
                            title="Move epic down"
                          >▼</button>
                        </div>
                        <span>{group.epicName}</span>
                        <span className="text-gray-400 font-normal">W{epicMinWeek % 1 === 0 ? epicMinWeek + 1 : (epicMinWeek + 1).toFixed(1)}–W{epicMaxWeek % 1 === 0 ? epicMaxWeek : epicMaxWeek.toFixed(1)}</span>
                        {(() => {
                          const epicFeatureMode = group.entries[0]?.epicFeatureMode ?? 'sequential'
                          return (
                            <button
                              onClick={() => updateEpicMode.mutate({ epicId: group.epicId, featureMode: epicFeatureMode === 'sequential' ? 'parallel' : 'sequential' })}
                              title={epicFeatureMode === 'sequential'
                                ? 'Features within this epic run one after another — click for parallel'
                                : 'Features within this epic all start simultaneously — click for sequential'}
                              className="ml-2 text-xs px-2 py-0.5 rounded border border-gray-200 text-gray-500 hover:bg-white"
                            >
                              {epicFeatureMode === 'sequential' ? '↓ Features: sequential' : '⇉ Features: parallel'}
                            </button>
                          )
                        })()}
                        {(() => {
                          const epicScheduleMode = group.entries[0]?.epicScheduleMode ?? 'sequential'
                          return (
                            <button
                              onClick={() => updateEpicScheduleMode.mutate({
                                epicId: group.epicId,
                                scheduleMode: epicScheduleMode === 'sequential' ? 'parallel' : 'sequential',
                              })}
                              title={epicScheduleMode === 'sequential'
                                ? 'This epic starts after the previous epic completes — click to run concurrently'
                                : 'This epic runs concurrently with other epics — click to chain after previous'}
                              className={`text-xs px-2 py-0.5 rounded border font-medium ${
                                epicScheduleMode === 'parallel'
                                  ? 'bg-purple-100 text-purple-700 border-purple-300'
                                  : 'bg-gray-100 text-gray-500 border-gray-200'
                              }`}
                            >
                              {epicScheduleMode === 'parallel' ? '⬛ Epic: concurrent' : '⏭ Epic: after prev'}
                            </button>
                          )
                        })()}
                      </div>

                      {/* Feature rows */}
                      {group.entries.map((entry, featureIdx) => (
                        <>
                          <div
                            key={`label-${entry.featureId}`}
                            className="border-b border-gray-50 px-3 py-2 text-sm text-gray-700 truncate cursor-pointer hover:text-red-600 flex items-center"
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
                            {/* Feature reorder arrows */}
                            <div className="flex flex-col -my-0.5 mr-1 shrink-0" onClick={e => e.stopPropagation()}>
                              <button
                                onClick={() => moveFeature(group.epicId, featureIdx, featureIdx - 1)}
                                disabled={featureIdx === 0 || reorderFeatures.isPending}
                                className="text-gray-300 hover:text-gray-600 disabled:opacity-0 disabled:cursor-default leading-none text-xs"
                                title="Move feature up"
                              >▲</button>
                              <button
                                onClick={() => moveFeature(group.epicId, featureIdx, featureIdx + 1)}
                                disabled={featureIdx === group.entries.length - 1 || reorderFeatures.isPending}
                                className="text-gray-300 hover:text-gray-600 disabled:opacity-0 disabled:cursor-default leading-none text-xs"
                                title="Move feature down"
                              >▼</button>
                            </div>
                            {entry.featureName}
                          </div>
                          {/* Week cells + Gantt bar */}
                          {Array.from({ length: totalWeeks }, (_, i) => {
                            const floorStart = Math.floor(entry.startWeek)
                            const ceilEnd = Math.ceil(entry.startWeek + entry.durationWeeks)
                            const isBar = i >= floorStart && i < ceilEnd
                            const isFirst = i === floorStart
                            const isLast = i === ceilEnd - 1
                            const overlapStart = Math.max(i, entry.startWeek)
                            const overlapEnd = Math.min(i + 1, entry.startWeek + entry.durationWeeks)
                            const leftPct = (overlapStart - i) * 100
                            const widthPct = (overlapEnd - overlapStart) * 100
                            return (
                              <div
                                key={`cell-${entry.featureId}-${i}`}
                                className="border-b border-l border-gray-50 py-2 px-0.5 flex items-center"
                              >
                                {isBar && (
                                  <div
                                    className={`h-6 ${colour.bar} ${isFirst ? 'rounded-l' : ''} ${isLast ? 'rounded-r' : ''} flex items-center px-1 cursor-pointer`}
                                    style={{ marginLeft: `${leftPct}%`, width: `max(4px, ${widthPct}%)` }}
                                    onClick={() => {
                                      setEditingFeatureId(entry.featureId)
                                      setEditForm({ startWeek: String(entry.startWeek), durationWeeks: String(entry.durationWeeks) })
                                    }}
                                    onMouseEnter={(e) => setTooltip({ x: e.clientX, y: e.clientY, entry })}
                                    onMouseMove={(e) => setTooltip(t => t ? { ...t, x: e.clientX, y: e.clientY } : null)}
                                    onMouseLeave={() => setTooltip(null)}
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
                              className="bg-blue-50 border-b border-blue-100 px-3 py-2 flex flex-wrap items-center gap-3"
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
                              <div className="mt-2 w-full" data-testid="dep-section" style={{ gridColumn: `1 / span ${totalWeeks + 1}` }}>
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
                          )}
                        </>
                      ))}
                    </>
                  )
                })}
              </div>

              {/* Summary footer */}
              <div className="px-4 py-3 border-t border-gray-100 text-xs text-gray-500">
                {Math.ceil(totalWeeks - 1)} weeks total · {timeline.entries.length} features scheduled
                {timeline.entries.some(e => e.isManual) && (
                  <span className="ml-2 text-blue-500">· ✏ = manually overridden</span>
                )}
              </div>
            </div>
          )}
        </div>
      </main>
      {tooltip && tooltip.entry.resourceBreakdown && tooltip.entry.resourceBreakdown.length > 0 && (
        <div
          className="fixed z-50 pointer-events-none bg-white border border-gray-200 rounded-lg shadow-lg p-3 text-xs"
          style={{ left: tooltip.x + 12, top: tooltip.y - 10 }}
        >
          <div className="font-semibold text-gray-800 mb-1">{tooltip.entry.featureName}</div>
          <div className="font-medium text-gray-500 mb-1.5">Resource Breakdown</div>
          {tooltip.entry.resourceBreakdown.map(rb => (
            <div key={rb.name} className="flex justify-between gap-4 text-gray-700">
              <span>{rb.name}</span>
              <span className="font-medium">{rb.days}d</span>
            </div>
          ))}
          <div className="border-t border-gray-100 mt-1.5 pt-1.5 flex justify-between gap-4 text-gray-600 font-medium">
            <span>Total</span>
            <span>{tooltip.entry.resourceBreakdown.reduce((s, r) => s + r.days, 0).toFixed(1)}d</span>
          </div>
        </div>
      )}
    </div>
  )
}
