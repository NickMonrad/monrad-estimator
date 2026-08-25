import type { TimelineEntry } from '../../types/backlog'
import type { GanttRow, StoryTimelineEntry, GanttDraggingState, DependencyDragDirection } from '../../hooks/useGanttLayout'
import { EPIC_ROW_H, FEAT_ROW_H, STORY_ROW_H } from '../../hooks/useGanttLayout'
import { getEpicColour } from '../../lib/epicColours'

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------
interface SvgColors {
  gridLine: string
  rowSep: string
}

interface GanttBarProps {
  row: GanttRow
  y: number
  weekOffset: number
  totalWeeks: number
  colW: number
  dragging: GanttDraggingState | null
  svgColors: SvgColors
  weeklyDemand: { week: number; resourceTypeName: string; demandDays: number; capacityDays: number }[]
  featureById: Map<string, TimelineEntry>
  onFeatureDragStart: (e: React.MouseEvent, entry: TimelineEntry) => void
  onStoryDragStart: (e: React.MouseEvent, storyEntry: StoryTimelineEntry) => void
  onFeatureEdit: (featureId: string) => void
  onStoryEdit: (storyId: string) => void
  onDependencyDragStart: (e: React.MouseEvent | React.PointerEvent, entry: TimelineEntry, direction: DependencyDragDirection) => void
  dependencyDragActive: boolean
  dependencyTargetState: 'valid' | 'invalid' | null
  onTooltipShow: (x: number, y: number, content: string) => void
  onTooltipHide: () => void
}

// ---------------------------------------------------------------------------
// Tooltip content helpers
// ---------------------------------------------------------------------------
function buildFeatureTooltip(entry: TimelineEntry): string {
  const rb = entry.resourceBreakdown ?? []
  const totalDays = rb.reduce((s, r) => s + r.days, 0)
  const breakdown = rb.length > 0
    ? '\n' + rb.map(r => `  ${r.name}: ${r.days.toFixed(1)}d`).join('\n')
    : ''
  const ee = entry.effectiveEngineers ?? []
  const engineersSection = ee.length > 0
    ? '\n\nEngineers allocated:\n' +
      ee.map(e => `  ${e.name}: ${e.engineerEquivalent.toFixed(1)} of ${e.totalEngineers} engineer${e.totalEngineers !== 1 ? 's' : ''} avg`).join('\n')
    : ''
  return `${entry.featureName}\n${totalDays.toFixed(1)} engineering days${breakdown}${engineersSection}\n\nClick to edit · Drag to move`
}

// ---------------------------------------------------------------------------
// Component — renders a single SVG <g> for an epic, feature, or story row
// ---------------------------------------------------------------------------
export default function GanttBar({
  row,
  y,
  weekOffset,
  totalWeeks,
  colW,
  dragging,
  svgColors,
  weeklyDemand,
  featureById,
  onFeatureDragStart,
  onStoryDragStart,
  onFeatureEdit,
  onStoryEdit,
  onDependencyDragStart,
  dependencyDragActive,
  dependencyTargetState,
  onTooltipShow,
  onTooltipHide,
}: GanttBarProps) {
  // ── Epic bar ──────────────────────────────────────────────────────────────
  if (row.type === 'epic') {
    const colour = getEpicColour(row.epicIdx)
    const barW = (row.maxWeek - row.minWeek) * colW
    if (barW <= 0) return null
    return (
      <g>
        <rect
          x={(row.minWeek + weekOffset) * colW}
          y={y + 4}
          width={barW}
          height={EPIC_ROW_H - 8}
          fill={colour.hex}
          fillOpacity={0.15}
          rx={3}
        />
        <rect
          x={(row.minWeek + weekOffset) * colW}
          y={y + 4}
          width={barW}
          height={EPIC_ROW_H - 8}
          fill="none"
          stroke={colour.hex}
          strokeWidth={1}
          rx={3}
        />
        <line
          x1={0} y1={y + EPIC_ROW_H}
          x2={totalWeeks * colW} y2={y + EPIC_ROW_H}
          stroke={svgColors.gridLine}
          strokeWidth={1}
        />
      </g>
    )
  }

  // ── Feature bar ───────────────────────────────────────────────────────────
  if (row.type === 'feature') {
    const entry = row.entry
    const colour = getEpicColour(row.epicIdx)
    const barColor = entry.timelineColour ?? colour.hex
    const isDragging = dragging?.type === 'feature' && dragging.id === entry.featureId
    const effectiveStart = isDragging ? dragging!.currentStart : entry.startWeek
    const effectiveEnd = effectiveStart + entry.durationWeeks
    const barW = Math.max(entry.durationWeeks * colW, 4)
    const barX = (effectiveStart + weekOffset) * colW
    const barY = y + 4
    const handleOffset = 6
    const leftHandleX = Math.max(handleOffset, barX - handleOffset)
    const rightHandleX = Math.min(totalWeeks * colW - handleOffset, barX + barW + handleOffset)
    const barMidY = y + FEAT_ROW_H / 2
    const isOverAllocated = weeklyDemand.some(d =>
      d.week >= effectiveStart &&
      d.week < effectiveEnd &&
      d.demandDays > d.capacityDays + 0.01,
    )
    const tooltipContent = buildFeatureTooltip(entry)
    const targetStroke = dependencyTargetState === 'invalid' ? '#dc2626' : '#2563eb'
    return (
      <g data-feature-id={entry.featureId} data-feature-name={entry.featureName}>
        <rect
          x={barX}
          y={barY}
          width={barW}
          height={FEAT_ROW_H - 8}
          fill={barColor}
          rx={3}
          style={{ cursor: isDragging ? 'grabbing' : 'grab', opacity: isDragging ? 0.8 : 1 }}
          onMouseDown={e => onFeatureDragStart(e, entry)}
          onClick={() => onFeatureEdit(entry.featureId)}
          onMouseEnter={e => onTooltipShow(e.clientX, e.clientY, tooltipContent)}
          onMouseLeave={onTooltipHide}
          onMouseMove={e => onTooltipShow(e.clientX, e.clientY, tooltipContent)}
        />
        {dependencyTargetState && (
          <rect
            data-testid={`dependency-target-${entry.featureId}`}
            x={barX - 2}
            y={barY - 2}
            width={barW + 4}
            height={FEAT_ROW_H - 4}
            fill="none"
            stroke={targetStroke}
            strokeWidth={2}
            strokeDasharray="4 2"
            rx={4}
            style={{ pointerEvents: 'none' }}
          />
        )}
        {isOverAllocated && (
          <circle
            cx={barX + barW - 8}
            cy={barMidY}
            r={4}
            fill="#ef4444"
            style={{ pointerEvents: 'none' }}
          />
        )}
        {entry.isManual && (
          <text
            x={barX + 6}
            y={barMidY + 4}
            fontSize={10}
            style={{ pointerEvents: 'none' }}
          >
            ✏️
          </text>
        )}
        <circle
          role="button"
          tabIndex={0}
          aria-label="Create dependency to this feature"
          data-testid={`dependency-handle-left-${entry.featureId}`}
          cx={leftHandleX}
          cy={barMidY}
          r={6}
          fill="white"
          stroke={barColor}
          strokeWidth={2}
          style={{ cursor: 'crosshair', opacity: dependencyDragActive ? 1 : 0.8, pointerEvents: 'all' }}
          onMouseDown={e => onDependencyDragStart(e, entry, 'from-left')}
          onClick={e => e.stopPropagation()}
        />
        <circle
          role="button"
          tabIndex={0}
          aria-label="Create dependency from this feature"
          data-testid={`dependency-handle-right-${entry.featureId}`}
          cx={rightHandleX}
          cy={barMidY}
          r={6}
          fill="white"
          stroke={barColor}
          strokeWidth={2}
          style={{ cursor: 'crosshair', opacity: dependencyDragActive ? 1 : 0.8, pointerEvents: 'all' }}
          onMouseDown={e => onDependencyDragStart(e, entry, 'from-right')}
          onClick={e => e.stopPropagation()}
        />
        <line
          x1={0} y1={y + FEAT_ROW_H}
          x2={totalWeeks * colW} y2={y + FEAT_ROW_H}
          stroke={svgColors.rowSep}
          strokeWidth={1}
        />
      </g>
    )
  }

  // ── Story bar ─────────────────────────────────────────────────────────────
  const storyEntry = row.entry
  const colour = getEpicColour(row.epicIdx)
  const parentFeature = featureById.get(storyEntry.featureId)
  const storyBarColor = parentFeature?.timelineColour ?? colour.hex
  const isDragging = dragging?.type === 'story' && dragging.id === storyEntry.storyId
  const effectiveStart = isDragging ? dragging!.currentStart : storyEntry.startWeek
  const storyTooltip = `${storyEntry.storyName}\n${storyEntry.durationWeeks.toFixed(1)}w · drag to move`
  return (
    <g>
      <rect
        x={(effectiveStart + weekOffset) * colW}
        y={y + 3}
        width={Math.max(storyEntry.durationWeeks * colW, 4)}
        height={STORY_ROW_H - 6}
        fill={storyBarColor}
        fillOpacity={0.4}
        rx={3}
        style={{ cursor: isDragging ? 'grabbing' : 'grab', opacity: isDragging ? 0.8 : 1 }}
        onMouseDown={e => onStoryDragStart(e, storyEntry)}
        onClick={() => onStoryEdit(storyEntry.storyId)}
        onMouseEnter={e => onTooltipShow(e.clientX, e.clientY, storyTooltip)}
        onMouseLeave={onTooltipHide}
        onMouseMove={e => onTooltipShow(e.clientX, e.clientY, storyTooltip)}
      />
      {storyEntry.isManual && (
        <text
          x={(effectiveStart + weekOffset) * colW + 6}
          y={y + STORY_ROW_H / 2 + 4}
          fontSize={9}
          style={{ pointerEvents: 'none' }}
        >
          ✏️
        </text>
      )}
      <line
        x1={0} y1={y + STORY_ROW_H}
        x2={totalWeeks * colW} y2={y + STORY_ROW_H}
        stroke={svgColors.rowSep}
        strokeWidth={1}
      />
    </g>
  )
}
