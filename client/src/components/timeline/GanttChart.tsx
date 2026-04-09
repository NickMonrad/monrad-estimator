import { useState, useEffect, useMemo } from 'react'
import type { TimelineEntry } from '../../types/backlog'
import { useIsDark } from '../../hooks/useIsDark'
import {
  useGanttLayout,
  COL_W,
  HEADER_H,
} from '../../hooks/useGanttLayout'
import type {
  StoryTimelineEntry,
  FeatureDependency,
  StoryDependency,
  GanttDraggingState,
} from '../../hooks/useGanttLayout'
import GanttBar from './GanttBar'
import GanttDependencyArrows from './GanttDependencyArrows'
import GanttLabelPanel from './GanttLabelPanel'
import TimelineTooltip from './TimelineTooltip'

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
  onMoveEpic?: (epicId: string, direction: 'up' | 'down', epicIdx: number) => void
  onMoveFeature?: (epicId: string, featureIdx: number, direction: 'up' | 'down') => void
  onUpdateEpicMode?: (epicId: string, featureMode: 'sequential' | 'parallel') => void
  onUpdateEpicScheduleMode?: (epicId: string, scheduleMode: 'sequential' | 'parallel') => void
  rightPanelRef?: React.RefObject<HTMLDivElement | null>
  onRightPanelScroll?: React.UIEventHandler<HTMLDivElement>
  weeklyDemand?: { week: number; resourceTypeName: string; demandDays: number; capacityDays: number }[]
  weekOffset?: number
  bufferWeeks?: number
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
  weeklyDemand = [],
  weekOffset = 0,
  bufferWeeks = 0,
}: GanttChartProps) {
  const [expandedFeatures, setExpandedFeatures] = useState<Set<string>>(new Set())
  const [expandedEpics, setExpandedEpics] = useState<Set<string>>(new Set())

  // Initialise expandedEpics with all unique epic IDs whenever entries change
  useEffect(() => {
    const ids = new Set(entries.map(e => e.epicId))
    setExpandedEpics(ids)
  }, [entries])

  const [tooltip, setTooltip] = useState<{ x: number; y: number; content: string } | null>(null)
  const [dragging, setDragging] = useState<GanttDraggingState | null>(null)

  // -----------------------------------------------------------------------
  // Layout (rows, positions)
  // -----------------------------------------------------------------------
  const { rows, rowY, totalHeight } = useGanttLayout(
    entries, storyEntries, totalWeeks, expandedEpics, expandedFeatures,
  )

  // Derived lookups
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

  // Set of featureIds that have at least one story entry
  const featuresWithStories = useMemo(() => new Set(storyEntries.map(s => s.featureId)), [storyEntries])

  // -----------------------------------------------------------------------
  // Drag handlers
  // -----------------------------------------------------------------------
  function startFeatureDrag(e: React.MouseEvent, entry: TimelineEntry) {
    e.preventDefault(); setTooltip(null)
    setDragging({ id: entry.featureId, type: 'feature', origStart: entry.startWeek, startX: e.clientX, currentStart: entry.startWeek })
  }
  function startStoryDrag(e: React.MouseEvent, storyEntry: StoryTimelineEntry) {
    e.preventDefault(); setTooltip(null)
    setDragging({ id: storyEntry.storyId, type: 'story', origStart: storyEntry.startWeek, startX: e.clientX, currentStart: storyEntry.startWeek })
  }

  useEffect(() => {
    function onMouseMove(e: MouseEvent) {
      if (!dragging) return
      const deltaWeeks = (e.clientX - dragging.startX) / COL_W
      const snapped = Math.max(0, Math.round((dragging.origStart + deltaWeeks) / 0.2) * 0.2)
      setDragging(d => (d ? { ...d, currentStart: snapped } : null))
    }
    function onMouseUp() {
      if (!dragging) return
      if (dragging.currentStart !== dragging.origStart) {
        if (dragging.type === 'feature') onDragFeature(dragging.id, dragging.currentStart)
        else onDragStory(dragging.id, dragging.currentStart)
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
  // Dark mode SVG colour palette (Tailwind dark: can't apply to SVG attrs)
  // -----------------------------------------------------------------------
  const isDark = useIsDark()
  const svgColors = {
    bg:          isDark ? '#111827' : '#fafafa',
    gridLine:    isDark ? '#374151' : '#f3f4f6',
    weekSep:     isDark ? '#374151' : '#e5e7eb',
    rowSep:      isDark ? '#1f2937' : '#f9fafb',
    headerText:  isDark ? '#9ca3af' : '#6b7280',
    weekNumText: isDark ? '#6b7280' : '#9ca3af',
  }

  // -----------------------------------------------------------------------
  // Render
  // -----------------------------------------------------------------------
  return (
    <div className="flex overflow-hidden border border-gray-100 dark:border-gray-700 rounded-lg">
      <GanttLabelPanel
        rows={rows}
        storyEntryIds={featuresWithStories}
        expandedEpics={expandedEpics}
        expandedFeatures={expandedFeatures}
        setExpandedEpics={setExpandedEpics}
        setExpandedFeatures={setExpandedFeatures}
        setEditingFeatureId={setEditingFeatureId}
        onMoveEpic={onMoveEpic}
        onMoveFeature={onMoveFeature}
        onUpdateEpicMode={onUpdateEpicMode}
        onUpdateEpicScheduleMode={onUpdateEpicScheduleMode}
      />

      {/* Right SVG area — horizontally scrollable */}
      <div className="overflow-x-auto flex-1" ref={rightPanelRef} onScroll={onRightPanelScroll}>
        <svg width={totalWeeks * COL_W} height={totalHeight} style={{ display: 'block' }}>
          <GanttDependencyArrows
            featureDependencies={featureDependencies}
            storyDependencies={storyDependencies}
            featureById={featureById}
            storyById={storyById}
            rowY={rowY}
            weekOffset={weekOffset}
            dragging={dragging}
          />

          {/* Background fill */}
          <rect x={0} y={0} width={totalWeeks * COL_W} height={totalHeight} fill={svgColors.bg} style={{ pointerEvents: 'none' }} />

          {/* Onboarding zone */}
          {weekOffset > 0 && (
            <g style={{ pointerEvents: 'none' }}>
              <rect x={0} y={0} width={weekOffset * COL_W} height={totalHeight}
                fill={isDark ? 'rgba(251,191,36,0.08)' : 'rgba(251,191,36,0.12)'} />
              <rect x={4} y={HEADER_H + 4} width={Math.min(weekOffset * COL_W - 8, 110)} height={16}
                rx={3} fill={isDark ? 'rgba(251,191,36,0.18)' : 'rgba(251,191,36,0.25)'} />
              <text x={8} y={HEADER_H + 15} fontSize={9} fill={isDark ? '#fbbf24' : '#b45309'} fontWeight={500}>
                Onboarding ({weekOffset}w)
              </text>
              <line x1={weekOffset * COL_W} y1={0} x2={weekOffset * COL_W} y2={totalHeight}
                stroke={isDark ? '#92400e' : '#d97706'} strokeWidth={1} strokeDasharray="4,3" />
            </g>
          )}

          {/* Buffer zone */}
          {bufferWeeks > 0 && (
            <g style={{ pointerEvents: 'none' }}>
              <rect x={(totalWeeks - bufferWeeks) * COL_W} y={0}
                width={bufferWeeks * COL_W} height={totalHeight}
                fill={isDark ? 'rgba(99,102,241,0.08)' : 'rgba(99,102,241,0.10)'} />
              <rect x={(totalWeeks - bufferWeeks) * COL_W + 4} y={HEADER_H + 4}
                width={Math.min(bufferWeeks * COL_W - 8, 80)} height={16}
                rx={3} fill={isDark ? 'rgba(99,102,241,0.20)' : 'rgba(99,102,241,0.18)'} />
              <text x={(totalWeeks - bufferWeeks) * COL_W + 8} y={HEADER_H + 15}
                fontSize={9} fill={isDark ? '#818cf8' : '#4338ca'} fontWeight={500}>
                Buffer ({bufferWeeks}w)
              </text>
              <line x1={(totalWeeks - bufferWeeks) * COL_W} y1={0}
                x2={(totalWeeks - bufferWeeks) * COL_W} y2={totalHeight}
                stroke={isDark ? '#4338ca' : '#6366f1'} strokeWidth={1} strokeDasharray="4,3" />
            </g>
          )}

          {/* Week header + vertical grid lines */}
          {Array.from({ length: totalWeeks }, (_, i) => (
            <g key={i}>
              <line x1={i * COL_W} y1={0} x2={i * COL_W} y2={totalHeight}
                stroke={svgColors.gridLine} strokeWidth={1} />
              <text x={i * COL_W + COL_W / 2} y={HEADER_H - (projectStartDate ? 14 : 8)}
                textAnchor="middle" fontSize={11} fill={svgColors.headerText}>
                W{i + 1}
              </text>
              {projectStartDate && (
                <text x={i * COL_W + COL_W / 2} y={HEADER_H - 2}
                  textAnchor="middle" fontSize={9} fill={svgColors.weekNumText}>
                  {formatDate(addDays(projectStartDate, i * 7))}
                </text>
              )}
            </g>
          ))}

          {/* Header bottom border */}
          <line x1={0} y1={HEADER_H} x2={totalWeeks * COL_W} y2={HEADER_H}
            stroke={svgColors.weekSep} strokeWidth={1} />

          {/* Row bars */}
          {rows.map(row => {
            const y = rowY.get(row.key)
            if (y === undefined) return null
            return (
              <GanttBar
                key={row.key}
                row={row}
                y={y}
                weekOffset={weekOffset}
                totalWeeks={totalWeeks}
                dragging={dragging}
                svgColors={svgColors}
                weeklyDemand={weeklyDemand}
                featureById={featureById}
                onFeatureDragStart={startFeatureDrag}
                onStoryDragStart={startStoryDrag}
                onFeatureEdit={setEditingFeatureId}
                onStoryEdit={setEditingStoryId}
                onTooltipShow={(x, y, content) => setTooltip({ x, y, content })}
                onTooltipHide={() => setTooltip(null)}
              />
            )
          })}
        </svg>
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
