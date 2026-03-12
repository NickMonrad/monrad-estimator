import { useState, useEffect, useMemo } from 'react'
import type { TimelineEntry } from '../../types/backlog'
import { getEpicColour } from '../../lib/epicColours'

// ---------------------------------------------------------------------------
// Local types (not yet in backlog.ts)
// ---------------------------------------------------------------------------
interface StoryTimelineEntry {
  storyId: string
  storyName: string
  featureId: string
  startWeek: number
  durationWeeks: number
  isManual: boolean
}

interface FeatureDependency {
  featureId: string
  dependsOnId: string
}

interface StoryDependency {
  storyId: string
  dependsOnId: string
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------
interface GanttChartProps {
  entries: TimelineEntry[]
  storyEntries?: StoryTimelineEntry[]
  featureDependencies?: FeatureDependency[]
  storyDependencies?: StoryDependency[]
  totalWeeks: number
  projectStartDate: Date | null
  onDragFeature: (featureId: string, newStartWeek: number) => void
  onDragStory: (storyId: string, newStartWeek: number) => void
  onAddFeatureDep: (featureId: string, dependsOnId: string) => void
  onAddStoryDep: (storyId: string, dependsOnId: string) => void
  onRemoveFeatureDep: (featureId: string, dependsOnId: string) => void
  onRemoveStoryDep: (storyId: string, dependsOnId: string) => void
  editingFeatureId: string | null
  setEditingFeatureId: (id: string | null) => void
  editingStoryId: string | null
  setEditingStoryId: (id: string | null) => void
  // Optional: reorder + mode callbacks wired from TimelinePage
  onMoveEpic?: (epicId: string, direction: 'up' | 'down', epicIdx: number) => void
  onMoveFeature?: (epicId: string, featureIdx: number, direction: 'up' | 'down') => void
  onUpdateEpicMode?: (epicId: string, featureMode: 'sequential' | 'parallel') => void
  onUpdateEpicScheduleMode?: (epicId: string, scheduleMode: 'sequential' | 'parallel') => void
  rightPanelRef?: React.RefObject<HTMLDivElement | null>
  onRightPanelScroll?: React.UIEventHandler<HTMLDivElement>
}

// ---------------------------------------------------------------------------
// Layout constants
// ---------------------------------------------------------------------------
const COL_W = 64
const EPIC_ROW_H = 36
const FEAT_ROW_H = 36
const STORY_ROW_H = 28
const HEADER_H = 44
const LABEL_W = 300
const DEP_ARROW_COLOR = '#9ca3af'

// ---------------------------------------------------------------------------
// Row model
// ---------------------------------------------------------------------------
type Row =
  | {
      type: 'epic'
      key: string
      epicId: string
      epicName: string
      epicOrder: number
      epicIdx: number
      epicCount: number
      epicFeatureMode: string
      epicScheduleMode: string
      minWeek: number
      maxWeek: number
    }
  | {
      type: 'feature'
      key: string
      entry: TimelineEntry
      epicIdx: number
      featureIdx: number
      totalFeaturesInEpic: number
    }
  | {
      type: 'story'
      key: string
      entry: StoryTimelineEntry
      epicIdx: number
      featureIdx: number
    }

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function addDays(date: Date, days: number): Date {
  const d = new Date(date)
  d.setDate(d.getDate() + days)
  return d
}

function formatDate(date: Date): string {
  return `${date.getDate()}/${date.getMonth() + 1}`
}

function bezierArrow(x1: number, y1: number, x2: number, y2: number): string {
  const dx = Math.abs(x2 - x1)
  const cpOffset = Math.max(30, dx * 0.4)
  return `M ${x1} ${y1} C ${x1 + cpOffset} ${y1}, ${x2 - cpOffset} ${y2}, ${x2} ${y2}`
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------
export default function GanttChart({
  entries,
  storyEntries = [],
  featureDependencies = [],
  storyDependencies = [],
  totalWeeks,
  projectStartDate,
  onDragFeature,
  onDragStory,
  onMoveEpic,
  onMoveFeature,
  onUpdateEpicMode,
  onUpdateEpicScheduleMode,
  editingFeatureId: _editingFeatureId,
  setEditingFeatureId,
  editingStoryId: _editingStoryId,
  setEditingStoryId,
  rightPanelRef,
  onRightPanelScroll,
}: GanttChartProps) {
  // Expanded state
  const [expandedFeatures, setExpandedFeatures] = useState<Set<string>>(new Set())
  const [expandedEpics, setExpandedEpics] = useState<Set<string>>(new Set())

  // Initialise expandedEpics with all unique epic IDs whenever entries change
  useEffect(() => {
    const ids = new Set(entries.map(e => e.epicId))
    setExpandedEpics(ids)
  }, [entries])

  // Tooltip state
  const [tooltip, setTooltip] = useState<{ x: number; y: number; content: string } | null>(null)

  // Drag state
  const [dragging, setDragging] = useState<{
    id: string
    type: 'feature' | 'story'
    origStart: number
    startX: number
    currentStart: number
  } | null>(null)

  // -----------------------------------------------------------------------
  // Build ordered epic groups
  // -----------------------------------------------------------------------
  const epicGroups = useMemo(() => {
    const map = new Map<
      string,
      { epicId: string; epicName: string; epicOrder: number; epicFeatureMode: string; epicScheduleMode: string; features: TimelineEntry[] }
    >()
    for (const entry of entries) {
      if (!map.has(entry.epicId)) {
        map.set(entry.epicId, {
          epicId: entry.epicId,
          epicName: entry.epicName,
          epicOrder: entry.epicOrder ?? 0,
          epicFeatureMode: entry.epicFeatureMode ?? 'sequential',
          epicScheduleMode: entry.epicScheduleMode ?? 'sequential',
          features: [],
        })
      }
      const g = map.get(entry.epicId)!
      g.features.push(entry)
      // keep mode in sync with latest entry (in case it changed)
      if (entry.epicFeatureMode) g.epicFeatureMode = entry.epicFeatureMode
      if (entry.epicScheduleMode) g.epicScheduleMode = entry.epicScheduleMode
    }
    // Sort epics by order
    return Array.from(map.values()).sort((a, b) => a.epicOrder - b.epicOrder)
  }, [entries])

  // -----------------------------------------------------------------------
  // Build rows
  // -----------------------------------------------------------------------
  const rows = useMemo<Row[]>(() => {
    const result: Row[] = []
    epicGroups.forEach((epicGroup, epicIdx) => {
      // Sort features by featureOrder
      const sortedFeatures = [...epicGroup.features].sort(
        (a, b) => (a.featureOrder ?? 0) - (b.featureOrder ?? 0)
      )

      const allWeeks = sortedFeatures.flatMap(f => [f.startWeek, f.startWeek + f.durationWeeks])
      const minWeek = allWeeks.length ? Math.min(...allWeeks) : 0
      const maxWeek = allWeeks.length ? Math.max(...allWeeks) : totalWeeks

      result.push({
        type: 'epic',
        key: `epic-${epicGroup.epicId}`,
        epicId: epicGroup.epicId,
        epicName: epicGroup.epicName,
        epicOrder: epicGroup.epicOrder,
        epicIdx,
        epicCount: epicGroups.length,
        epicFeatureMode: epicGroup.epicFeatureMode,
        epicScheduleMode: epicGroup.epicScheduleMode,
        minWeek,
        maxWeek,
      })

      if (!expandedEpics.has(epicGroup.epicId)) return

      sortedFeatures.forEach((entry, featureIdx) => {
        result.push({
          type: 'feature',
          key: `feature-${entry.featureId}`,
          entry,
          epicIdx,
          featureIdx,
          totalFeaturesInEpic: sortedFeatures.length,
        })

        if (!expandedFeatures.has(entry.featureId)) return

        const featureStories = storyEntries
          .filter(s => s.featureId === entry.featureId)
          .sort((a, b) => a.startWeek - b.startWeek)
        featureStories.forEach(storyEntry => {
          result.push({
            type: 'story',
            key: `story-${storyEntry.storyId}`,
            entry: storyEntry,
            epicIdx,
            featureIdx,
          })
        })
      })
    })
    return result
  }, [epicGroups, expandedEpics, expandedFeatures, storyEntries, totalWeeks])

  // -----------------------------------------------------------------------
  // Y positions
  // -----------------------------------------------------------------------
  const { rowY, totalHeight } = useMemo(() => {
    let y = HEADER_H
    const map = new Map<string, number>()
    for (const row of rows) {
      map.set(row.key, y)
      y += row.type === 'story' ? STORY_ROW_H : row.type === 'epic' ? EPIC_ROW_H : FEAT_ROW_H
    }
    return { rowY: map, totalHeight: y }
  }, [rows])

  // -----------------------------------------------------------------------
  // Drag handlers
  // -----------------------------------------------------------------------
  function startFeatureDrag(e: React.MouseEvent, entry: TimelineEntry) {
    e.preventDefault()
    setTooltip(null)
    setDragging({
      id: entry.featureId,
      type: 'feature',
      origStart: entry.startWeek,
      startX: e.clientX,
      currentStart: entry.startWeek,
    })
  }

  function startStoryDrag(e: React.MouseEvent, storyEntry: StoryTimelineEntry) {
    e.preventDefault()
    setTooltip(null)
    setDragging({
      id: storyEntry.storyId,
      type: 'story',
      origStart: storyEntry.startWeek,
      startX: e.clientX,
      currentStart: storyEntry.startWeek,
    })
  }

  useEffect(() => {
    function onMouseMove(e: MouseEvent) {
      if (!dragging) return
      const deltaX = e.clientX - dragging.startX
      const deltaWeeks = deltaX / COL_W
      const snapped = Math.max(0, Math.round((dragging.origStart + deltaWeeks) / 0.2) * 0.2)
      setDragging(d => (d ? { ...d, currentStart: snapped } : null))
    }
    function onMouseUp() {
      if (!dragging) return
      if (dragging.currentStart !== dragging.origStart) {
        if (dragging.type === 'feature') {
          onDragFeature(dragging.id, dragging.currentStart)
        } else {
          onDragStory(dragging.id, dragging.currentStart)
        }
      }
      setDragging(null)
    }
    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
    return () => {
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
    }
  }, [dragging, onDragFeature, onDragStory])

  // -----------------------------------------------------------------------
  // Feature lookup for dependency arrows
  // -----------------------------------------------------------------------
  const featureById = useMemo(() => {
    const m = new Map<string, TimelineEntry>()
    for (const e of entries) m.set(e.featureId, e)
    return m
  }, [entries])

  const storyById = useMemo(() => {
    const m = new Map<string, StoryTimelineEntry>()
    for (const s of storyEntries) m.set(s.storyId, s)
    return m
  }, [storyEntries])

  // -----------------------------------------------------------------------
  // Render
  // -----------------------------------------------------------------------
  return (
    <div className="flex overflow-hidden border border-gray-100 dark:border-gray-700 rounded-lg">
      {/* Left label panel — sticky, no horizontal scroll */}
      <div
        style={{ width: LABEL_W, flexShrink: 0 }}
        className="relative bg-white dark:bg-gray-800 border-r border-gray-100 dark:border-gray-700 z-10"
      >
        {/* Label header */}
        <div
          style={{ height: HEADER_H }}
          className="border-b border-gray-100 dark:border-gray-700 flex items-end px-3 pb-2"
        >
          <span className="text-xs font-medium text-gray-500 dark:text-gray-400">Feature</span>
        </div>

        {/* Label rows */}
        {rows.map(row => {
          if (row.type === 'epic') {
            const colour = getEpicColour(row.epicIdx)
            const isOpen = expandedEpics.has(row.epicId)
            return (
              <div
                key={row.key}
                style={{
                  height: EPIC_ROW_H,
                  backgroundColor: `${colour.hex}14`, // ~8% opacity
                }}
                className="border-b border-gray-100 dark:border-gray-700 flex items-center px-3 gap-1 cursor-pointer select-none"
                onClick={() =>
                  setExpandedEpics(prev => {
                    const next = new Set(prev)
                    if (next.has(row.epicId)) next.delete(row.epicId)
                    else next.add(row.epicId)
                    return next
                  })
                }
              >
                {/* Epic reorder arrows */}
                {onMoveEpic && (
                  <div
                    className="flex flex-col -my-0.5 mr-1 flex-shrink-0"
                    onClick={e => e.stopPropagation()}
                  >
                    <button
                      onClick={() => onMoveEpic(row.epicId, 'up', row.epicIdx)}
                      disabled={row.epicIdx === 0}
                      className="text-gray-300 dark:text-gray-600 hover:text-gray-600 dark:hover:text-gray-400 disabled:opacity-0 disabled:cursor-default leading-none text-xs"
                      title="Move epic up"
                    >▲</button>
                    <button
                      onClick={() => onMoveEpic(row.epicId, 'down', row.epicIdx)}
                      disabled={row.epicIdx === row.epicCount - 1}
                      className="text-gray-300 dark:text-gray-600 hover:text-gray-600 dark:hover:text-gray-400 disabled:opacity-0 disabled:cursor-default leading-none text-xs"
                      title="Move epic down"
                    >▼</button>
                  </div>
                )}
                <span className="mr-1 text-xs text-gray-400 dark:text-gray-500">{isOpen ? '▼' : '▶'}</span>
                <span
                  className="text-sm font-semibold truncate"
                  style={{ color: colour.hex }}
                  title={row.epicName}
                >
                  {row.epicName}
                </span>
                {/* Feature mode button */}
                {onUpdateEpicMode && (
                  <button
                    onClick={e => {
                      e.stopPropagation()
                      onUpdateEpicMode(
                        row.epicId,
                        row.epicFeatureMode === 'sequential' ? 'parallel' : 'sequential',
                      )
                    }}
                    title={
                      row.epicFeatureMode === 'sequential'
                        ? 'Features run sequentially — click for parallel'
                        : 'Features run in parallel — click for sequential'
                    }
                    aria-label={row.epicFeatureMode === 'sequential' ? 'sequential' : 'parallel'}
                    className="ml-1 text-xs px-1.5 py-0.5 rounded border border-gray-200 dark:border-gray-600 text-gray-500 dark:text-gray-400 hover:bg-white dark:hover:bg-gray-700 flex-shrink-0"
                  >
                    {row.epicFeatureMode === 'sequential' ? '↓ seq' : '⇉ par'}
                  </button>
                )}
                {/* Schedule mode button */}
                {onUpdateEpicScheduleMode && (
                  <button
                    onClick={e => {
                      e.stopPropagation()
                      onUpdateEpicScheduleMode(
                        row.epicId,
                        row.epicScheduleMode === 'sequential' ? 'parallel' : 'sequential',
                      )
                    }}
                    title={
                      row.epicScheduleMode === 'sequential'
                        ? 'Epic starts after previous — click for concurrent'
                        : 'Epic runs concurrently — click to chain after previous'
                    }
                    className={`text-xs px-1.5 py-0.5 rounded border font-medium flex-shrink-0 ${
                      row.epicScheduleMode === 'parallel'
                        ? 'bg-purple-100 text-purple-700 border-purple-300'
                        : 'bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400 border-gray-200 dark:border-gray-600'
                    }`}
                  >
                    {row.epicScheduleMode === 'parallel' ? '⬛' : '⏭'}
                  </button>
                )}
              </div>
            )
          }

          if (row.type === 'feature') {
            const isOpen = expandedFeatures.has(row.entry.featureId)
            const hasStories = storyEntries.some(s => s.featureId === row.entry.featureId)
            return (
              <div
                key={row.key}
                style={{ height: FEAT_ROW_H }}
                className="border-b border-gray-50 dark:border-gray-700 flex items-center px-3 gap-1"
              >
                <button
                  className="text-xs text-gray-400 dark:text-gray-500 w-4 flex-shrink-0 disabled:opacity-30"
                  disabled={!hasStories}
                  onClick={() =>
                    setExpandedFeatures(prev => {
                      const next = new Set(prev)
                      if (next.has(row.entry.featureId)) next.delete(row.entry.featureId)
                      else next.add(row.entry.featureId)
                      return next
                    })
                  }
                >
                  {hasStories ? (isOpen ? '▼' : '▶') : ''}
                </button>
                <span
                  className="text-sm truncate flex-1 text-gray-700 dark:text-gray-300 cursor-pointer hover:text-blue-600 dark:hover:text-blue-400"
                  title={row.entry.featureName}
                  onClick={() => setEditingFeatureId(row.entry.featureId)}
                >
                  {row.entry.featureName}
                </span>
                {/* Reorder buttons */}
                <div className="flex flex-col gap-px flex-shrink-0">
                  <button
                    className="text-gray-300 dark:text-gray-600 hover:text-gray-600 dark:hover:text-gray-400 text-xs leading-none disabled:opacity-20"
                    disabled={row.featureIdx === 0 || !onMoveFeature}
                    onClick={() => onMoveFeature?.(row.entry.epicId, row.featureIdx, 'up')}
                    title="Move feature up"
                  >
                    ▲
                  </button>
                  <button
                    className="text-gray-300 dark:text-gray-600 hover:text-gray-600 dark:hover:text-gray-400 text-xs leading-none disabled:opacity-20"
                    disabled={row.featureIdx === row.totalFeaturesInEpic - 1 || !onMoveFeature}
                    onClick={() => onMoveFeature?.(row.entry.epicId, row.featureIdx, 'down')}
                    title="Move feature down"
                  >
                    ▼
                  </button>
                </div>
              </div>
            )
          }

          // story
          return (
            <div
              key={row.key}
              style={{ height: STORY_ROW_H }}
              className="border-b border-gray-50 dark:border-gray-700 flex items-center pl-6 pr-3"
            >
              <span
                className="text-xs text-gray-500 dark:text-gray-400 truncate"
                title={row.entry.storyName}
              >
                {row.entry.storyName}
              </span>
            </div>
          )
        })}
      </div>

      {/* Right SVG area — horizontally scrollable */}
      <div className="overflow-x-auto flex-1" ref={rightPanelRef} onScroll={onRightPanelScroll}>
        <svg
          width={totalWeeks * COL_W}
          height={totalHeight}
          style={{ display: 'block' }}
        >
          {/* Arrowhead marker */}
          <defs>
            <marker id="arrow" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
              <path d="M0,0 L0,6 L8,3 z" fill={DEP_ARROW_COLOR} />
            </marker>
          </defs>

          {/* Background fill */}
          <rect x={0} y={0} width={totalWeeks * COL_W} height={totalHeight} fill="#fafafa" style={{ pointerEvents: 'none' }} />

          {/* Week header + vertical grid lines */}
          {Array.from({ length: totalWeeks }, (_, i) => (
            <g key={i}>
              <line
                x1={i * COL_W}
                y1={0}
                x2={i * COL_W}
                y2={totalHeight}
                stroke="#f3f4f6"
                strokeWidth={1}
              />
              <text
                x={i * COL_W + COL_W / 2}
                y={HEADER_H - (projectStartDate ? 14 : 8)}
                textAnchor="middle"
                fontSize={11}
                fill="#6b7280"
              >
                W{i + 1}
              </text>
              {projectStartDate && (
                <text
                  x={i * COL_W + COL_W / 2}
                  y={HEADER_H - 2}
                  textAnchor="middle"
                  fontSize={9}
                  fill="#9ca3af"
                >
                  {formatDate(addDays(projectStartDate, i * 7))}
                </text>
              )}
            </g>
          ))}

          {/* Header bottom border */}
          <line
            x1={0}
            y1={HEADER_H}
            x2={totalWeeks * COL_W}
            y2={HEADER_H}
            stroke="#e5e7eb"
            strokeWidth={1}
          />

          {/* Row bars */}
          {rows.map(row => {
            const y = rowY.get(row.key)
            if (y === undefined) return null

            if (row.type === 'epic') {
              const colour = getEpicColour(row.epicIdx)
              const barW = (row.maxWeek - row.minWeek) * COL_W
              if (barW <= 0) return null
              return (
                <g key={row.key}>
                  <rect
                    x={row.minWeek * COL_W}
                    y={y + 4}
                    width={barW}
                    height={EPIC_ROW_H - 8}
                    fill={colour.hex}
                    fillOpacity={0.15}
                    rx={3}
                  />
                  <rect
                    x={row.minWeek * COL_W}
                    y={y + 4}
                    width={barW}
                    height={EPIC_ROW_H - 8}
                    fill="none"
                    stroke={colour.hex}
                    strokeWidth={1}
                    rx={3}
                  />
                  {/* Row bottom border */}
                  <line
                    x1={0}
                    y1={y + EPIC_ROW_H}
                    x2={totalWeeks * COL_W}
                    y2={y + EPIC_ROW_H}
                    stroke="#f3f4f6"
                    strokeWidth={1}
                  />
                </g>
              )
            }

            if (row.type === 'feature') {
              const entry = row.entry
              const colour = getEpicColour(row.epicIdx)
              const isDragging =
                dragging !== null && dragging.type === 'feature' && dragging.id === entry.featureId
              const effectiveStart = isDragging ? dragging!.currentStart : entry.startWeek
              return (
                <g key={row.key}>
                  <rect
                    x={effectiveStart * COL_W}
                    y={y + 4}
                    width={Math.max(entry.durationWeeks * COL_W, 4)}
                    height={FEAT_ROW_H - 8}
                    fill={colour.hex}
                    rx={3}
                    style={{
                      cursor: isDragging ? 'grabbing' : 'grab',
                      opacity: isDragging ? 0.8 : 1,
                    }}
                    onMouseDown={e => startFeatureDrag(e, entry)}
                    onClick={() => setEditingFeatureId(entry.featureId)}
                    onMouseEnter={e => {
                      const rb = entry.resourceBreakdown ?? []
                      const totalDays = rb.reduce((s, r) => s + r.days, 0)
                      const breakdown = rb.length > 0 ? '\n' + rb.map(r => `  ${r.name}: ${r.days.toFixed(1)}d`).join('\n') : ''
                      const ee = entry.effectiveEngineers ?? []
                      const engineersSection = ee.length > 0
                        ? '\n\nEngineers allocated:\n' + ee.map(e => `  ${e.name}: ${e.engineerEquivalent.toFixed(1)} of ${e.totalEngineers} engineer${e.totalEngineers !== 1 ? 's' : ''} avg`).join('\n')
                        : ''
                      setTooltip({ x: e.clientX, y: e.clientY, content: `${entry.featureName}\n${totalDays.toFixed(1)} engineering days${breakdown}${engineersSection}\n\nClick to edit · Drag to move` })
                    }}
                    onMouseLeave={() => setTooltip(null)}
                    onMouseMove={e => {
                      const rb = entry.resourceBreakdown ?? []
                      const totalDays = rb.reduce((s, r) => s + r.days, 0)
                      const breakdown = rb.length > 0 ? '\n' + rb.map(r => `  ${r.name}: ${r.days.toFixed(1)}d`).join('\n') : ''
                      const ee = entry.effectiveEngineers ?? []
                      const engineersSection = ee.length > 0
                        ? '\n\nEngineers allocated:\n' + ee.map(e => `  ${e.name}: ${e.engineerEquivalent.toFixed(1)} of ${e.totalEngineers} engineer${e.totalEngineers !== 1 ? 's' : ''} avg`).join('\n')
                        : ''
                      setTooltip({ x: e.clientX, y: e.clientY, content: `${entry.featureName}\n${totalDays.toFixed(1)} engineering days${breakdown}${engineersSection}\n\nClick to edit · Drag to move` })
                    }}
                  />
                  {entry.isManual && (
                    <text
                      x={effectiveStart * COL_W + 6}
                      y={y + FEAT_ROW_H / 2 + 4}
                      fontSize={10}
                      style={{ pointerEvents: 'none' }}
                    >
                      ✏️
                    </text>
                  )}
                  {/* Row bottom border */}
                  <line
                    x1={0}
                    y1={y + FEAT_ROW_H}
                    x2={totalWeeks * COL_W}
                    y2={y + FEAT_ROW_H}
                    stroke="#f9fafb"
                    strokeWidth={1}
                  />
                </g>
              )
            }

            // story
            const storyEntry = row.entry
            const colour = getEpicColour(row.epicIdx)
            const isDragging =
              dragging !== null && dragging.type === 'story' && dragging.id === storyEntry.storyId
            const effectiveStart = isDragging ? dragging!.currentStart : storyEntry.startWeek
            return (
              <g key={row.key}>
                <rect
                  x={effectiveStart * COL_W}
                  y={y + 3}
                  width={Math.max(storyEntry.durationWeeks * COL_W, 4)}
                  height={STORY_ROW_H - 6}
                  fill={colour.hex}
                  fillOpacity={0.6}
                  rx={3}
                  style={{
                    cursor: isDragging ? 'grabbing' : 'grab',
                    opacity: isDragging ? 0.8 : 1,
                  }}
                  onMouseDown={e => startStoryDrag(e, storyEntry)}
                  onClick={() => setEditingStoryId(storyEntry.storyId)}
                  onMouseEnter={e => setTooltip({ x: e.clientX, y: e.clientY, content: `${storyEntry.storyName}\n${storyEntry.durationWeeks.toFixed(1)}w · drag to move` })}
                  onMouseLeave={() => setTooltip(null)}
                  onMouseMove={e => setTooltip({ x: e.clientX, y: e.clientY, content: `${storyEntry.storyName}\n${storyEntry.durationWeeks.toFixed(1)}w · drag to move` })}
                />
                {storyEntry.isManual && (
                  <text
                    x={effectiveStart * COL_W + 6}
                    y={y + STORY_ROW_H / 2 + 4}
                    fontSize={9}
                    style={{ pointerEvents: 'none' }}
                  >
                    ✏️
                  </text>
                )}
                {/* Row bottom border */}
                <line
                  x1={0}
                  y1={y + STORY_ROW_H}
                  x2={totalWeeks * COL_W}
                  y2={y + STORY_ROW_H}
                  stroke="#f9fafb"
                  strokeWidth={1}
                />
              </g>
            )
          })}

          {/* Feature dependency arrows */}
          {featureDependencies.map(dep => {
            const predEntry = featureById.get(dep.dependsOnId)
            const succEntry = featureById.get(dep.featureId)
            if (!predEntry || !succEntry) return null

            const predKey = `feature-${predEntry.featureId}`
            const succKey = `feature-${succEntry.featureId}`
            const predY = rowY.get(predKey)
            const succY = rowY.get(succKey)
            if (predY === undefined || succY === undefined) return null

            const predDragging =
              dragging?.type === 'feature' && dragging.id === predEntry.featureId
            const succDragging =
              dragging?.type === 'feature' && dragging.id === succEntry.featureId

            const predStart = predDragging ? (dragging?.currentStart ?? predEntry.startWeek) : predEntry.startWeek
            const succStart = succDragging ? (dragging?.currentStart ?? succEntry.startWeek) : succEntry.startWeek

            const x1 = (predStart + predEntry.durationWeeks) * COL_W
            const y1 = predY + FEAT_ROW_H / 2
            const x2 = succStart * COL_W
            const y2 = succY + FEAT_ROW_H / 2

            return (
              <path
                key={`fdep-${dep.dependsOnId}-${dep.featureId}`}
                d={bezierArrow(x1, y1, x2, y2)}
                stroke={DEP_ARROW_COLOR}
                strokeWidth={1.5}
                fill="none"
                markerEnd="url(#arrow)"
                opacity={0.7}
              />
            )
          })}

          {/* Story dependency arrows */}
          {storyDependencies.map(dep => {
            const predEntry = storyById.get(dep.dependsOnId)
            const succEntry = storyById.get(dep.storyId)
            if (!predEntry || !succEntry) return null

            const predKey = `story-${predEntry.storyId}`
            const succKey = `story-${succEntry.storyId}`
            const predY = rowY.get(predKey)
            const succY = rowY.get(succKey)
            if (predY === undefined || succY === undefined) return null

            const predDragging =
              dragging?.type === 'story' && dragging.id === predEntry.storyId
            const succDragging =
              dragging?.type === 'story' && dragging.id === succEntry.storyId

            const predStart = predDragging ? (dragging?.currentStart ?? predEntry.startWeek) : predEntry.startWeek
            const succStart = succDragging ? (dragging?.currentStart ?? succEntry.startWeek) : succEntry.startWeek

            const x1 = (predStart + predEntry.durationWeeks) * COL_W
            const y1 = predY + STORY_ROW_H / 2
            const x2 = succStart * COL_W
            const y2 = succY + STORY_ROW_H / 2

            return (
              <path
                key={`sdep-${dep.dependsOnId}-${dep.storyId}`}
                d={bezierArrow(x1, y1, x2, y2)}
                stroke={DEP_ARROW_COLOR}
                strokeWidth={1.5}
                fill="none"
                markerEnd="url(#arrow)"
                opacity={0.7}
              />
            )
          })}
        </svg>
      </div>
      {tooltip && (
        <div
          className="fixed z-50 pointer-events-none bg-gray-900 text-white rounded-lg shadow-xl px-3 py-2 text-sm whitespace-pre max-w-xs"
          style={{ left: tooltip.x + 12, top: tooltip.y + 12 }}
        >
          {tooltip.content}
        </div>
      )}
    </div>
  )
}
