import { useState, useMemo, useEffect, useRef, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { toPng } from 'html-to-image'
import { api } from '../lib/api'
import { useIsDark } from '../hooks/useIsDark'
import AppLayout from '../components/layout/AppLayout'
import type { Project, ResourceType, TimelineSummary, TimelineEntry, NamedResourceEntry } from '../types/backlog'
import GanttChart from '../components/timeline/GanttChart'
import ResourceHistogram from '../components/timeline/ResourceHistogram'
import TimelineTooltip from '../components/timeline/TimelineTooltip'
import { getEpicColour } from '../lib/epicColours'
import type { GanttScale } from '../hooks/useGanttLayout'
import { colWForScale, LABEL_W } from '../hooks/useGanttLayout'

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
  weeklyDemand = [],
  weekOffset = 0,
}: {
  namedResources: NamedResourceEntry[]
  totalWeeks: number
  colW: number
  labelW: number
  weeklyDemand?: { week: number; resourceTypeName: string; demandDays: number; capacityDays: number }[]
  weekOffset?: number
}) {
  const isDark = useIsDark()
  const gridStroke = isDark ? '#374151' : '#f3f4f6'

  // Pre-index demand by resourceTypeName → week → demandDays/capacityDays
  const demandByRt = useMemo(() => {
    const map = new Map<string, Map<number, { demand: number; capacity: number }>>()
    for (const d of weeklyDemand) {
      if (!map.has(d.resourceTypeName)) map.set(d.resourceTypeName, new Map())
      map.get(d.resourceTypeName)!.set(d.week, { demand: d.demandDays, capacity: d.capacityDays })
    }
    return map
  }, [weeklyDemand])

  // Tooltip state
  const [tooltip, setTooltip] = useState<{ x: number; y: number; content: string } | null>(null)

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
    <div className="border-t border-gray-200 dark:border-gray-700">
      {/* Section header */}
      <div className="flex items-center px-4 py-2 bg-gray-50 dark:bg-gray-700 border-b border-gray-100 dark:border-gray-700">
        <span className="text-xs font-medium text-gray-500 dark:text-gray-400">Named Resources</span>
      </div>

      <div className="flex overflow-hidden">
        {/* Left label panel */}
        <div style={{ width: labelW, flexShrink: 0 }} className="bg-white dark:bg-gray-800 border-r border-gray-100 dark:border-gray-700">
          {grouped.map(([rtName, people]) => (
            <div key={rtName}>
              {/* Resource type header */}
              <div className="px-3 py-1.5 bg-gray-50 dark:bg-gray-700 border-b border-gray-100 dark:border-gray-700">
                <span className="text-xs font-semibold text-gray-600 dark:text-gray-400">{rtName}</span>
              </div>
              {/* People rows */}
              {people.map((nr, i) => {
                const mode = nr.allocationMode ?? 'EFFORT'
                const modeLabel = mode === 'EFFORT' ? 'T&M'
                  : mode === 'FULL_PROJECT' ? `Full Project · ${nr.allocationPct}%`
                  : `Timeline · ${nr.allocationPct}%`
                return (
                  <div
                    key={`${rtName}-${nr.name}-${i}`}
                    className="flex flex-col justify-center px-3 border-b border-gray-50 dark:border-gray-700"
                    style={{ height: 36 }}
                  >
                    <span className="text-xs text-gray-700 dark:text-gray-300 truncate">{nr.name}</span>
                    <span className="text-[10px] text-gray-400 dark:text-gray-500">
                      {modeLabel}
                    </span>
                  </div>
                )
              })}
            </div>
          ))}
        </div>

        {/* Right bar area */}
        <div className="overflow-x-auto flex-1">
          <div style={{ width: totalWeeks * colW, minHeight: '100%' }} className="relative bg-gray-50/50 dark:bg-gray-900/50">
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
                  stroke={gridStroke}
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
                  <div className="border-b border-gray-100 dark:border-gray-700" style={{ height: 30 }} />
                  {/* Person bars */}
                  {people.map((nr, i) => {
                    const start = nr.startWeek ?? 0
                    const end = nr.endWeek ?? projectEndWeek
                    const colour = RESOURCE_COLOURS[(colourIdx++) % RESOURCE_COLOURS.length]
                    const isEffort = (nr.allocationMode ?? 'EFFORT') === 'EFFORT'
                    const rtDemand = demandByRt.get(rtName)

                    if (isEffort && rtDemand) {
                      // T&M: render a demand-following mini histogram per person.
                      // weeklyDemand tracks the whole resource type pool, so divide by
                      // the number of named resources to get each person's share.
                      const personCount = Math.max(people.length, 1)
                      const ROW_H = 28
                      const maxCap = Math.max(...Array.from(rtDemand.values()).map(d => d.capacity / personCount), 1)
                      return (
                        <div
                          key={`${rtName}-${nr.name}-${i}`}
                          className="relative border-b border-gray-50 dark:border-gray-700"
                          style={{ height: 36 }}
                        >
                          <svg
                            width={totalWeeks * colW}
                            height={36}
                            className="absolute inset-0"
                          >
                            {Array.from({ length: totalWeeks }, (_, w) => {
                              const d = rtDemand.get(w)
                              if (!d || d.demand <= 0) return null
                              const personDemand = d.demand / personCount
                              const personCap = d.capacity / personCount
                              const pct = Math.min(personDemand / maxCap, 1)
                              const barH = Math.max(Math.round(pct * ROW_H), 2)
                              return (
                                <g key={w}>
                                  <rect
                                    x={(w + weekOffset) * colW + 2}
                                    y={36 - barH - 4}
                                    width={colW - 4}
                                    height={barH}
                                    rx={2}
                                    fill="#6366f1"
                                    opacity={0.55}
                                    onMouseEnter={(e) => setTooltip({
                                      x: e.clientX,
                                      y: e.clientY,
                                      content: `${nr.name} · T&M\nWk ${w}: ${personDemand.toFixed(1)} / ${personCap.toFixed(1)} days (${Math.round(personDemand / personCap * 100)}%)`,
                                    })}
                                    onMouseMove={(e) => setTooltip(prev => prev ? { ...prev, x: e.clientX, y: e.clientY } : prev)}
                                    onMouseLeave={() => setTooltip(null)}
                                    style={{ cursor: 'default' }}
                                  />
                                </g>
                              )
                            })}
                          </svg>
                        </div>
                      )
                    }

                    // Fixed allocation (FULL_PROJECT or TIMELINE): flat bar
                    const barLeft = (start + weekOffset) * colW
                    const barWidth = Math.max((end - start + 1) * colW - 4, 8)
                    return (
                      <div
                        key={`${rtName}-${nr.name}-${i}`}
                        className="relative border-b border-gray-50 dark:border-gray-700"
                        style={{ height: 36 }}
                      >
                        <div
                          className={`absolute top-1 ${colour} rounded h-[28px] flex items-center px-2 text-[10px] font-medium text-gray-700 truncate cursor-default`}
                          style={{ left: barLeft + 2, width: barWidth }}
                          onMouseEnter={(e) => setTooltip({
                            x: e.clientX,
                            y: e.clientY,
                            content: `${nr.name} · W${Math.floor(start + weekOffset) + 1}–W${Math.floor(end + weekOffset) + 1} · ${nr.allocationPct}%`,
                          })}
                          onMouseMove={(e) => setTooltip(prev => prev ? { ...prev, x: e.clientX, y: e.clientY } : prev)}
                          onMouseLeave={() => setTooltip(null)}
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
      <TimelineTooltip
        x={tooltip?.x ?? 0}
        y={tooltip?.y ?? 0}
        visible={tooltip !== null}
        content={tooltip?.content ?? ''}
      />
    </div>
  )
}

export default function TimelinePage() {
  const { id: projectId } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const qc = useQueryClient()

  const [startDateInput, setStartDateInput] = useState('')
  const [resourcesOpen, setResourcesOpen] = useState(true)
  const [editingFeatureId, setEditingFeatureId] = useState<string | null>(null)
  const [editingStoryId, setEditingStoryId] = useState<string | null>(null)
  const [editForm, setEditForm] = useState({ startWeek: '', durationWeeks: '' })
  const [editColour, setEditColour] = useState<string | null>(null)
  const [scheduleStale, setScheduleStale] = useState(false)
  const rlKey = `timeline.resourceLevel.${projectId}`
  const [resourceLevel, setResourceLevel] = useState(() => localStorage.getItem(rlKey) === 'true')

  const SCALE_KEY = 'gantt-scale'
  const [ganttScale, setGanttScale] = useState<GanttScale>(
    () => (localStorage.getItem(SCALE_KEY) as GanttScale | null) ?? 'week',
  )
  const ganttColW = colWForScale(ganttScale)

  // Scroll sync refs for Gantt + Histogram right panels
  const ganttScrollRef = useRef<HTMLDivElement>(null)
  const histScrollRef = useRef<HTMLDivElement>(null)
  const topScrollRef = useRef<HTMLDivElement>(null)
  const isSyncingScroll = useRef(false)

  // Ref for PNG export — wraps the entire Gantt+histogram+named resources section
  const ganttContainerRef = useRef<HTMLDivElement | null>(null)

  const handleGanttScroll = useCallback(() => {
    if (isSyncingScroll.current) return
    isSyncingScroll.current = true
    const sl = ganttScrollRef.current?.scrollLeft ?? 0
    if (histScrollRef.current) histScrollRef.current.scrollLeft = sl
    if (topScrollRef.current) topScrollRef.current.scrollLeft = sl
    isSyncingScroll.current = false
  }, [])

  const handleHistScroll = useCallback(() => {
    if (isSyncingScroll.current) return
    isSyncingScroll.current = true
    const sl = histScrollRef.current?.scrollLeft ?? 0
    if (ganttScrollRef.current) ganttScrollRef.current.scrollLeft = sl
    if (topScrollRef.current) topScrollRef.current.scrollLeft = sl
    isSyncingScroll.current = false
  }, [])

  const handleTopScroll = useCallback(() => {
    if (isSyncingScroll.current) return
    isSyncingScroll.current = true
    const sl = topScrollRef.current?.scrollLeft ?? 0
    if (ganttScrollRef.current) ganttScrollRef.current.scrollLeft = sl
    if (histScrollRef.current) histScrollRef.current.scrollLeft = sl
    isSyncingScroll.current = false
  }, [])

  // Export handlers
  const handleExportCsv = async () => {
    const resp = await api.get(`/projects/${projectId}/timeline/export/csv`, { responseType: 'blob' })
    const url = URL.createObjectURL(resp.data)
    const a = document.createElement('a')
    a.href = url
    a.download = `${project?.name ?? 'Timeline'} - Timeline - ${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  const handleExportPng = async () => {
    const container = ganttContainerRef.current
    if (!container) return

    // Exact dimensions: label panel + chart columns at the current scale
    const EXPORT_LABEL_W = LABEL_W
    const fullWidth = EXPORT_LABEL_W + totalWeeks * ganttColW
    const fullHeight = container.scrollHeight

    // Dark-mode aware background colour — read from DOM since handler is outside hook scope
    const bgColor = document.documentElement.classList.contains('dark') ? '#111827' : '#ffffff'

    // Collect all scrollable right-panels and expand them
    const scrollEls = Array.from(
      container.querySelectorAll<HTMLElement>('.overflow-x-auto')
    )

    // Save and expand every scroll container + the outer container
    const savedContainer = {
      overflowX: container.style.overflowX,
      minWidth: container.style.minWidth,
      width: container.style.width,
    }
    const savedChildren = scrollEls.map(el => ({
      el,
      overflowX: el.style.overflowX,
      minWidth: el.style.minWidth,
    }))

    container.style.overflowX = 'visible'
    container.style.minWidth = fullWidth + 'px'
    container.style.width = fullWidth + 'px'
    scrollEls.forEach(el => {
      el.style.overflowX = 'visible'
      el.style.minWidth = el.scrollWidth + 'px'
    })

    // Two rAF frames to ensure full reflow before capture
    await new Promise(r => requestAnimationFrame(r))
    await new Promise(r => requestAnimationFrame(r))

    try {
      const dataUrl = await toPng(container, {
        backgroundColor: bgColor,
        width: fullWidth,
        height: fullHeight,
      })
      const a = document.createElement('a')
      a.href = dataUrl
      a.download = `${project?.name ?? 'Timeline'} - Gantt - ${new Date().toISOString().slice(0, 10)}.png`
      a.click()
    } finally {
      container.style.overflowX = savedContainer.overflowX
      container.style.minWidth = savedContainer.minWidth
      container.style.width = savedContainer.width
      savedChildren.forEach(({ el, overflowX, minWidth }) => {
        el.style.overflowX = overflowX
        el.style.minWidth = minWidth
      })
    }
  }

  const initialScheduleDone = useRef(false)

  const { data: project } = useQuery<Project>({
    queryKey: ['project', projectId],
    queryFn: () => api.get(`/projects/${projectId}`).then(r => r.data),
  })

  const { data: timeline, isLoading } = useQuery<TimelineSummary>({
    queryKey: ['timeline', projectId],
    queryFn: () => api.get(`/projects/${projectId}/timeline`).then(r => r.data),
  })

  const { data: resourceTypes } = useQuery<ResourceType[]>({
    queryKey: ['resource-types', projectId],
    queryFn: () => api.get(`/projects/${projectId}/resource-types`).then(r => r.data),
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
      if (entry) {
        setEditForm({ startWeek: String(entry.startWeek), durationWeeks: String(entry.durationWeeks) })
        setEditColour(entry.timelineColour ?? null)
      }
    }
  }, [editingFeatureId, timeline])

  // Auto-schedule on page load ONLY if no entries exist yet (first run for new projects).
  // For projects with existing entries, the user drives rescheduling via the button.
  useEffect(() => {
    if (!initialScheduleDone.current && timeline !== undefined && project !== undefined) {
      initialScheduleDone.current = true
      if (timeline.entries.length === 0) {
        const body = project.startDate ? { startDate: project.startDate.slice(0, 10), resourceLevel } : { resourceLevel }
        scheduleTimeline.mutate(body)
      }
    }
  }, [timeline, project])

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

  const updateFeatureColour = useMutation({
    mutationFn: ({ epicId, featureId, timelineColour }: { epicId: string; featureId: string; timelineColour: string | null }) =>
      api.put(`/epics/${epicId}/features/${featureId}`, { timelineColour }).then(r => r.data),
    onSuccess: () => { invalidate() },
  })

  const { data: featureDeps = [] } = useQuery<Array<{ featureId: string; dependsOnId: string; feature: { name: string }; dependsOn: { name: string } }>>({
    queryKey: ['feature-deps', projectId],
    queryFn: () => api.get(`/projects/${projectId}/feature-dependencies`).then(r => r.data),
  })

  const addFeatureDep = useMutation({
    mutationFn: ({ featureId, dependsOnId }: { featureId: string; dependsOnId: string }) =>
      // Only POST the dependency — must NOT set isManual on the feature's timeline entry
      api.post(`/projects/${projectId}/feature-dependencies`, { featureId, dependsOnId }).then(r => r.data),
    onSuccess: () => {
      // Refresh both the dep list (sidebar badges) and the timeline (Gantt arrows).
      // Do NOT call updateEntry here — that would set isManual=true as a side effect.
      qc.invalidateQueries({ queryKey: ['feature-deps', projectId] })
      qc.invalidateQueries({ queryKey: ['timeline', projectId] })
      setScheduleStale(true)
    },
  })

  const removeFeatureDep = useMutation({
    mutationFn: ({ featureId, dependsOnId }: { featureId: string; dependsOnId: string }) =>
      api.delete(`/projects/${projectId}/feature-dependencies/${featureId}/${dependsOnId}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['feature-deps', projectId] })
      qc.invalidateQueries({ queryKey: ['timeline', projectId] })
      setScheduleStale(true)
    },
  })

  const { data: epicDeps = [] } = useQuery<Array<{ epicId: string; dependsOnId: string; epic: { name: string }; dependsOn: { name: string } }>>({
    queryKey: ['epicDeps', projectId],
    queryFn: () => api.get(`/projects/${projectId}/epic-dependencies`).then(r => r.data),
    enabled: !!projectId,
  })

  const addEpicDep = useMutation({
    mutationFn: ({ epicId, dependsOnId }: { epicId: string; dependsOnId: string }) =>
      api.post(`/projects/${projectId}/epic-dependencies`, { epicId, dependsOnId }).then(r => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['epicDeps', projectId] })
      qc.invalidateQueries({ queryKey: ['timeline', projectId] })
      setScheduleStale(true)
    },
  })

  const removeEpicDep = useMutation({
    mutationFn: ({ epicId, dependsOnId }: { epicId: string; dependsOnId: string }) =>
      api.delete(`/projects/${projectId}/epic-dependencies/${epicId}/${dependsOnId}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['epicDeps', projectId] })
      qc.invalidateQueries({ queryKey: ['timeline', projectId] })
      setScheduleStale(true)
    },
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
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['resource-types', projectId] }); setScheduleStale(true) },
  })

  const addNamedResource = useMutation({
    mutationFn: ({ rtId, name }: { rtId: string; name: string }) =>
      api.post(`/projects/${projectId}/resource-types/${rtId}/named-resources`, {
        name,
        allocationPct: 100,
      }).then(r => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['timeline', projectId] })
      setScheduleStale(true)
    },
  })

  const removeNamedResource = useMutation({
    mutationFn: ({ rtId, nrId }: { rtId: string; nrId: string }) =>
      api.delete(`/projects/${projectId}/resource-types/${rtId}/named-resources/${nrId}`).then(r => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['timeline', projectId] })
      setScheduleStale(true)
    },
  })

  const updateNamedResource = useMutation({
    mutationFn: ({ rtId, nrId, allocationMode, allocationPercent, allocationStartWeek, allocationEndWeek }: { rtId: string; nrId: string; allocationMode: string; allocationPercent: number; allocationStartWeek?: number | null; allocationEndWeek?: number | null }) =>
      api.patch(`/projects/${projectId}/resource-types/${rtId}/named-resources/${nrId}`, { allocationMode, allocationPercent, allocationStartWeek, allocationEndWeek }).then(r => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['timeline', projectId] })
      setScheduleStale(true)
    },
  })

  function handleAddNamedResource(rtId: string, rtName: string) {
    const existingCount = (timeline?.namedResources ?? []).filter(nr => nr.resourceTypeId === rtId).length
    const name = `${rtName} ${existingCount + 1}`
    addNamedResource.mutate({ rtId, name })
  }

  function handleRemoveNamedResource(rtId: string, nrId: string) {
    if (!window.confirm('Remove this person?')) return
    removeNamedResource.mutate({ rtId, nrId })
  }

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
    const deliveryWeeks = Math.ceil(Math.max(featureMax, storyMax))
    return deliveryWeeks + (timeline.bufferWeeks ?? 0) + (timeline.onboardingWeeks ?? 0)
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

  // Group resource types by category — only include RTs with demand in timeline
  const rtByCategory = useMemo(() => {
    if (!resourceTypes) return []
    // Build set of RT names that appear in weeklyDemand
    const rtNamesWithDemand = new Set<string>()
    if (timeline?.weeklyDemand) {
      for (const d of timeline.weeklyDemand) {
        if (d.demandDays > 0) rtNamesWithDemand.add(d.resourceTypeName)
      }
    }
    const filtered = resourceTypes.filter(rt => rtNamesWithDemand.has(rt.name))
    const map = new Map<string, ResourceType[]>()
    for (const rt of filtered) {
      if (!map.has(rt.category)) map.set(rt.category, [])
      map.get(rt.category)!.push(rt)
    }
    return Array.from(map.entries())
  }, [resourceTypes, timeline])

  // Map named resources from timeline by resourceTypeId (for the Resource Counts panel)
  const rtNRMap = useMemo(() => {
    const map = new Map<string, NamedResourceEntry[]>()
    for (const nr of timeline?.namedResources ?? []) {
      if (!nr.resourceTypeId) continue
      if (!map.has(nr.resourceTypeId)) map.set(nr.resourceTypeId, [])
      map.get(nr.resourceTypeId)!.push(nr)
    }
    return map
  }, [timeline?.namedResources])

  const projectStartDate = timeline?.startDate ? new Date(timeline.startDate) : null

  return (
    <AppLayout
      breadcrumb={<>
          <span>/</span>
          <button onClick={() => navigate(`/projects/${projectId}`)} className="hover:text-lab3-navy dark:hover:text-lab3-blue transition-colors">
            {project?.name ?? '…'}
          </button>
          <span>/</span>
          <span className="text-gray-700 dark:text-gray-300">Timeline</span>
        </>}
    >
      <main className="w-full px-6 py-6 space-y-6">
        <div className="flex items-center justify-between">
          <h1 className="text-xl font-semibold text-gray-900 dark:text-white">Timeline Planner</h1>
        </div>

        {/* Setup bar */}
        <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-4">
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex flex-col gap-1">
              <label className="text-xs text-gray-500 dark:text-gray-400">Project start date</label>
              <input
                type="date"
                value={startDateInput}
                onChange={e => setStartDateInput(e.target.value)}
                onBlur={handleStartDateBlur}
                className="border border-gray-200 dark:border-gray-600 rounded px-3 py-1.5 text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-400 focus:outline-none focus:ring-1 focus:ring-lab3-blue"
              />
            </div>
            <div className="w-px h-7 bg-gray-200" />
            <button
              onClick={handleSchedule}
              disabled={scheduleTimeline.isPending}
              className="bg-lab3-navy text-white px-4 py-1.5 rounded text-sm font-medium hover:bg-lab3-blue disabled:opacity-50"
            >
              {scheduleTimeline.isPending ? 'Scheduling…' : 'Auto-schedule'}
            </button>
            {timeline?.entries && timeline.entries.length > 0 && (
              <button
                onClick={handleSchedule}
                disabled={scheduleTimeline.isPending}
                className="border border-gray-200 dark:border-gray-700 px-4 py-1.5 rounded text-sm text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50"
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
            {/* Export buttons */}
            {timeline?.entries && timeline.entries.length > 0 && (
              <>
                <button
                  onClick={handleExportCsv}
                  className="border border-gray-200 dark:border-gray-600 text-gray-600 dark:text-gray-300 px-3 py-1.5 rounded-lg text-sm hover:bg-gray-50 dark:hover:bg-gray-700 flex items-center gap-1.5"
                  title="Export timeline data as CSV"
                >
                  ↓ CSV
                </button>
                <button
                  onClick={handleExportPng}
                  className="border border-gray-200 dark:border-gray-600 text-gray-600 dark:text-gray-300 px-3 py-1.5 rounded-lg text-sm hover:bg-gray-50 dark:hover:bg-gray-700 flex items-center gap-1.5"
                  title="Export Gantt chart as PNG image"
                >
                  ↓ PNG
                </button>
                <div className="w-px h-7 bg-gray-200" />
              </>
            )}
            <label className="flex items-center gap-1.5 text-xs text-gray-600 dark:text-gray-300 cursor-pointer">
              <input
                type="checkbox"
                checked={resourceLevel}
                onChange={e => { setResourceLevel(e.target.checked); localStorage.setItem(rlKey, String(e.target.checked)) }}
                className="rounded"
              />
              Resource leveling
            </label>
            {timeline?.projectedEndDate && (
              <div className="text-sm text-gray-600 dark:text-gray-400">
                <span className="text-gray-400 dark:text-gray-500">Projected end:</span>{' '}
                <span className="font-medium">{new Date(timeline.projectedEndDate).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}</span>
                {(project?.bufferWeeks ?? 0) > 0 && (
                  <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-amber-100 text-amber-700 ml-2">
                    +{project!.bufferWeeks}w buffer
                  </span>
                )}
              </div>
            )}
            {timeline?.startDate && (
              <span className="text-xs text-gray-400 dark:text-gray-500 ml-auto">
                Last scheduled: {formatDate(timeline.startDate)}
              </span>
            )}
            {!timeline?.startDate && (
              <span className="text-xs text-gray-400 dark:text-gray-500 ml-auto">Not yet scheduled</span>
            )}
          </div>
        </div>

        {/* Stale schedule banner */}
        {scheduleStale && (
          <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 flex items-center justify-between text-sm">
            <span className="text-amber-800">⚠ Schedule may be stale (dependencies, epic mode, or resourcing changed) — re-run <strong>Auto-schedule</strong> to apply.</span>
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
        <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden">
          <button
            onClick={() => setResourcesOpen(o => !o)}
            className="w-full flex items-center justify-between px-4 py-3 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700"
          >
            <span>Resource Counts — adjust before scheduling</span>
            <span className="text-gray-400 dark:text-gray-500">{resourcesOpen ? '▲' : '▼'}</span>
          </button>
          {resourcesOpen && (
            <div className="px-4 pb-4">
              <p className="text-xs text-gray-400 dark:text-gray-500 mb-3">Counts affect how quickly each feature can be delivered in parallel</p>
              {rtByCategory.map(([category, rts]) => (
                <div key={category} className="mb-4">
                  <div className={`text-xs font-semibold uppercase tracking-wide px-2 py-1 rounded mb-2 ${CATEGORY_HEADER_BG[category]} text-gray-700`}>
                    {CATEGORY_LABELS[category] ?? category}
                  </div>
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-xs text-gray-400 dark:text-gray-500">
                        <th className="text-left pb-1 font-normal">Resource Type</th>
                        <th className="text-right pb-1 font-normal w-20">Count</th>
                        <th className="text-right pb-1 font-normal w-24">Hrs/day</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rts.map(rt => {
                        const nrs = rtNRMap.get(rt.id) ?? []
                        return (
                          <tr key={rt.id} className="border-t border-gray-700">
                            <td className="py-1.5 text-gray-700 dark:text-gray-300">
                              <div className="flex items-center gap-1">
                                <span>{rt.name}</span>
                                <button
                                  onClick={() => handleAddNamedResource(rt.id, rt.name)}
                                  className="text-xs text-lab3-navy dark:text-lab3-blue hover:underline ml-auto"
                                  title="Add person"
                                >+ Add</button>
                              </div>
                              {nrs.length > 0 && (
                                <div className="mt-1 space-y-0.5 pl-2">
                                  {nrs.map((nr, i) => (
                                    <div key={nr.id ?? `${rt.id}-${i}`} className="flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400 mt-0.5 pl-2">
                                      <span className="flex-1 truncate text-gray-600 dark:text-gray-300">{nr.name}</span>
                                      {/* Mode selector */}
                                      {nr.id && (
                                        <select
                                          value={nr.allocationMode ?? 'EFFORT'}
                                          onChange={e => {
                                            const mode = e.target.value
                                            const pct = mode === 'EFFORT' ? 100 : (nr.allocationPercent ?? 100)
                                            updateNamedResource.mutate({ rtId: rt.id, nrId: nr.id!, allocationMode: mode, allocationPercent: pct })
                                          }}
                                          className="text-xs border border-gray-200 dark:border-gray-600 rounded px-1 py-0 bg-white dark:bg-gray-700 text-gray-600 dark:text-gray-300"
                                        >
                                          <option value="EFFORT">T&amp;M</option>
                                          <option value="FULL_PROJECT">Full Project</option>
                                          <option value="TIMELINE">Timeline</option>
                                        </select>
                                      )}
                                      {/* % input — only shown for non-EFFORT modes */}
                                      {nr.id && (nr.allocationMode ?? 'EFFORT') !== 'EFFORT' && (
                                        <div className="flex items-center gap-0.5">
                                          <input
                                            type="number"
                                            min={1}
                                            max={100}
                                            defaultValue={nr.allocationPercent ?? 100}
                                            key={`${nr.id}-pct-${nr.allocationPercent}`}
                                            onBlur={e => {
                                              const val = Math.min(100, Math.max(1, parseInt(e.target.value) || 100))
                                              updateNamedResource.mutate({ rtId: rt.id, nrId: nr.id!, allocationMode: nr.allocationMode ?? 'EFFORT', allocationPercent: val })
                                            }}
                                            className="w-12 text-xs border border-gray-200 dark:border-gray-600 rounded px-1 py-0 text-right bg-white dark:bg-gray-700 text-gray-700 dark:text-gray-300"
                                          />
                                          <span className="text-gray-400">%</span>
                                        </div>
                                      )}
                                      {/* Start/end week — only for TIMELINE mode */}
                                      {nr.id && nr.allocationMode === 'TIMELINE' && (
                                        <div className="flex items-center gap-0.5 text-gray-400">
                                          <span>W</span>
                                          <input
                                            type="number"
                                            min={1}
                                            placeholder="start"
                                            defaultValue={nr.allocationStartWeek ?? ''}
                                            key={`${nr.id}-sw-${nr.allocationStartWeek}`}
                                            onBlur={e => {
                                              const val = e.target.value.trim() === '' ? null : Math.max(1, parseInt(e.target.value) || 1)
                                              updateNamedResource.mutate({ rtId: rt.id, nrId: nr.id!, allocationMode: 'TIMELINE', allocationPercent: nr.allocationPercent ?? 100, allocationStartWeek: val })
                                            }}
                                            className="w-10 text-xs border border-gray-200 dark:border-gray-600 rounded px-1 py-0 text-right bg-white dark:bg-gray-700 text-gray-700 dark:text-gray-300 placeholder-gray-300"
                                          />
                                          <span>–</span>
                                          <input
                                            type="number"
                                            min={1}
                                            placeholder="end"
                                            defaultValue={nr.allocationEndWeek ?? ''}
                                            key={`${nr.id}-ew-${nr.allocationEndWeek}`}
                                            onBlur={e => {
                                              const val = e.target.value.trim() === '' ? null : Math.max(1, parseInt(e.target.value) || 1)
                                              updateNamedResource.mutate({ rtId: rt.id, nrId: nr.id!, allocationMode: 'TIMELINE', allocationPercent: nr.allocationPercent ?? 100, allocationEndWeek: val })
                                            }}
                                            className="w-10 text-xs border border-gray-200 dark:border-gray-600 rounded px-1 py-0 text-right bg-white dark:bg-gray-700 text-gray-700 dark:text-gray-300 placeholder-gray-300"
                                          />
                                        </div>
                                      )}
                                      {/* remove button */}
                                      {nr.id && (
                                        <button
                                          onClick={() => handleRemoveNamedResource(rt.id, nr.id!)}
                                          className="text-gray-300 hover:text-red-400 dark:text-gray-600 dark:hover:text-red-400 ml-0.5"
                                          title="Remove person"
                                        >×</button>
                                      )}
                                    </div>
                                  ))}
                                </div>
                              )}
                            </td>
                            <td className="py-1.5 text-right text-sm text-gray-700 dark:text-gray-300 align-top">{rt.count}</td>
                            <td className="py-1.5 text-right align-top">
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
                                className="w-20 border border-gray-200 dark:border-gray-600 rounded px-2 py-0.5 text-sm text-right bg-white dark:bg-gray-700 text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-400 focus:outline-none focus:ring-1 focus:ring-blue-400"
                              />
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Gantt chart */}
        <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700">
          <div className="px-4 py-3 border-b border-gray-100 dark:border-gray-700 flex items-center justify-between">
            <h2 className="text-sm font-medium text-gray-700 dark:text-gray-300">Gantt Chart</h2>
            {/* Scale toggle */}
            <div className="flex items-center gap-1">
              {(['week', 'month', 'quarter', 'year'] as const).map(s => (
                <button
                  key={s}
                  onClick={() => { setGanttScale(s); localStorage.setItem(SCALE_KEY, s) }}
                  className={ganttScale === s
                    ? 'bg-lab3-navy text-white px-3 py-1 rounded text-sm font-medium dark:bg-lab3-blue'
                    : 'border border-gray-200 text-gray-600 px-3 py-1 rounded text-sm dark:border-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700'
                  }
                >
                  {s === 'week' ? 'Wk' : s === 'month' ? 'Mo' : s === 'quarter' ? 'Qtr' : 'Yr'}
                </button>
              ))}
            </div>
          </div>

          {isLoading && <div className="p-8 text-center text-gray-400 dark:text-gray-500 text-sm">Loading…</div>}

          {!isLoading && (!timeline?.entries || timeline.entries.length === 0) && (
            <div className="p-8 text-center text-gray-400 dark:text-gray-500 text-sm">
              Set a start date and click <strong>Auto-schedule</strong> to generate your timeline
            </div>
          )}

          {!isLoading && timeline?.entries && timeline.entries.length > 0 && (
            <div ref={ganttContainerRef}>
              {/* Top mirror scrollbar — synced with the Gantt scroll container */}
              <div
                ref={topScrollRef}
                className="overflow-x-auto"
                style={{ height: 12 }}
                onScroll={handleTopScroll}
              >
                <div style={{ width: totalWeeks * ganttColW + LABEL_W, height: 1 }} />
              </div>
              <GanttChart
                entries={timeline.entries}
                storyEntries={timeline.storyEntries}
                featureDependencies={timeline.featureDependencies}
                storyDependencies={timeline.storyDependencies}
                totalWeeks={totalWeeks}
                projectStartDate={projectStartDate}
                scale={ganttScale}
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
                epicDependencies={epicDeps}
                onAddEpicDep={(epicId, dependsOnId) => addEpicDep.mutate({ epicId, dependsOnId })}
                onRemoveEpicDep={(epicId, dependsOnId) => removeEpicDep.mutate({ epicId, dependsOnId })}
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
                weeklyDemand={timeline.weeklyDemand}
                weekOffset={timeline.onboardingWeeks ?? 0}
                bufferWeeks={timeline.bufferWeeks ?? 0}
              />

              {/* Resource allocation histogram */}
              {timeline.weeklyDemand && timeline.weeklyDemand.length > 0 && (
                <ResourceHistogram
                  weeklyDemand={timeline.weeklyDemand}
                  weeklyCapacity={timeline.weeklyCapacity}
                  totalWeeks={totalWeeks}
                  colW={ganttColW}
                  labelW={LABEL_W}
                  weekOffset={timeline.onboardingWeeks ?? 0}
                  scrollContainerRef={histScrollRef}
                  onScroll={handleHistScroll}
                />
              )}

              {/* Named Resources — individual people and their availability */}
              {timeline.namedResources && timeline.namedResources.length > 0 && (
                <NamedResourcesPanel
                  namedResources={timeline.namedResources}
                  totalWeeks={totalWeeks}
                  colW={ganttColW}
                  labelW={LABEL_W}
                  weeklyDemand={timeline.weeklyDemand}
                  weekOffset={timeline.onboardingWeeks ?? 0}
                />
              )}

              {/* Inline edit panel — shown below chart when a feature is selected */}
              {editingFeatureId && (() => {
                const entry = timeline.entries.find(e => e.featureId === editingFeatureId)
                if (!entry) return null
                const epicIdx = Array.from(new Map(
                  timeline.entries.map(e => [e.epicId, e.epicOrder ?? 0])
                ).entries())
                  .sort((a, b) => a[1] - b[1])
                  .map(([id]) => id)
                  .indexOf(entry.epicId)
                const epicColour = getEpicColour(epicIdx < 0 ? 0 : epicIdx).hex
                return (
                  <div className="sticky bottom-0 z-20 border-t border-blue-200 bg-blue-50 shadow-md px-4 py-3 flex flex-wrap items-center gap-3">
                    <span className="text-xs text-gray-600 dark:text-gray-400 font-medium">{entry.featureName}</span>
                    <label className="text-xs text-gray-500 dark:text-gray-400">Start week:</label>
                    <input
                      type="number"
                      min="0"
                      value={editForm.startWeek}
                      onChange={e => setEditForm(f => ({ ...f, startWeek: e.target.value }))}
                      className="w-16 border border-gray-200 dark:border-gray-600 rounded px-2 py-0.5 text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-400 focus:outline-none focus:ring-1 focus:ring-blue-400"
                    />
                    <label className="text-xs text-gray-500 dark:text-gray-400">Duration weeks:</label>
                    <input
                      type="number"
                      min="0.2"
                      value={editForm.durationWeeks}
                      onChange={e => setEditForm(f => ({ ...f, durationWeeks: e.target.value }))}
                      className="w-16 border border-gray-200 dark:border-gray-600 rounded px-2 py-0.5 text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-400 focus:outline-none focus:ring-1 focus:ring-blue-400"
                    />
                    {/* Bar colour picker */}
                    <label className="text-xs text-gray-500 dark:text-gray-400">Bar colour:</label>
                    <input
                      type="color"
                      value={editColour ?? epicColour}
                      onChange={e => setEditColour(e.target.value)}
                      className="w-8 h-8 rounded cursor-pointer border border-gray-200 dark:border-gray-600"
                    />
                    {editColour && (
                      <button
                        onClick={() => setEditColour(null)}
                        className="text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
                      >
                        Reset to epic colour
                      </button>
                    )}
                    <button
                      onClick={() => {
                        const newStart = parseFloat(editForm.startWeek)
                        const newDuration = parseFloat(editForm.durationWeeks)
                        const timelineChanged = newStart !== entry.startWeek || newDuration !== entry.durationWeeks
                        if (timelineChanged) {
                          updateEntry.mutate({ featureId: entry.featureId, startWeek: newStart, durationWeeks: newDuration })
                        }
                        updateFeatureColour.mutate({ epicId: entry.epicId, featureId: entry.featureId, timelineColour: editColour })
                      }}
                      disabled={updateEntry.isPending || updateFeatureColour.isPending}
                      className="bg-blue-600 text-white px-3 py-0.5 rounded text-xs font-medium hover:bg-blue-700 disabled:opacity-50"
                    >
                      {(updateEntry.isPending || updateFeatureColour.isPending) ? 'Saving…' : 'Save'}
                    </button>
                    <button
                      onClick={() => setEditingFeatureId(null)}
                      className="px-3 py-0.5 rounded text-xs text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700"
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
                        <p className="text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Depends on (must finish before this feature starts):</p>
                        <div className="flex flex-wrap gap-1 mb-2">
                          {featureDeps
                            .filter(d => d.featureId === entry.featureId)
                            .map(d => (
                              <span key={d.dependsOnId} className="inline-flex items-center gap-1 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded px-2 py-0.5 text-xs text-gray-700 dark:text-gray-300">
                                {d.dependsOn.name}
                                <button
                                  onClick={() => removeFeatureDep.mutate({ featureId: entry.featureId, dependsOnId: d.dependsOnId })}
                                  className="text-gray-400 dark:text-gray-500 hover:text-red-500 ml-1"
                                >✕</button>
                              </span>
                            ))}
                          {featureDeps.filter(d => d.featureId === entry.featureId).length === 0 && (
                            <span className="text-xs text-gray-400 dark:text-gray-500">None</span>
                          )}
                        </div>
                        <div className="flex items-center gap-2">
                          <select
                            className="border border-gray-200 dark:border-gray-600 rounded px-2 py-0.5 text-xs text-gray-700 bg-white dark:bg-gray-700 text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-400 focus:outline-none focus:ring-1 focus:ring-blue-400"
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
                        className="text-xs text-gray-500 dark:text-gray-400 hover:text-gray-700"
                      >
                        Close ✕
                      </button>
                    </div>
                  </div>
                )
              })()}

              {/* Summary footer */}
              <div className="px-4 py-3 border-t border-gray-100 dark:border-gray-700 text-xs text-gray-500 dark:text-gray-400">
                {Math.ceil(totalWeeks - 1)} weeks total · {timeline.entries.length} features scheduled
                {timeline.entries.some(e => e.isManual) && (
                  <span className="ml-2 text-blue-500">· ✏ = manually overridden</span>
                )}
              </div>
            </div>
          )}
        </div>
      </main>
  </AppLayout>
  )
}
