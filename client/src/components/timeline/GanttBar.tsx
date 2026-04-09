import type { TimelineEntry } from '../../types/backlog'
import type { GanttRow, StoryTimelineEntry, GanttDraggingState } from '../../hooks/useGanttLayout'
import { COL_W, EPIC_ROW_H, FEAT_ROW_H, STORY_ROW_H } from '../../hooks/useGanttLayout'
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
  dragging: GanttDraggingState | null
  svgColors: SvgColors
  weeklyDemand: { week: number; resourceTypeName: string; demandDays: number; capacityDays: number }[]
  featureById: Map<string, TimelineEntry>
  onFeatureDragStart: (e: React.MouseEvent, entry: TimelineEntry) => void
  onStoryDragStart: (e: React.MouseEvent, storyEntry: StoryTimelineEntry) => void
  onFeatureEdit: (featureId: string) => void
  onStoryEdit: (storyId: string) => void
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
  dragging,
  svgColors,
  weeklyDemand,
  featureById,
  onFeatureDragStart,
  onStoryDragStart,
  onFeatureEdit,
  onStoryEdit,
  onTooltipShow,
  onTooltipHide,
}: GanttBarProps) {
  // ── Epic bar ──────────────────────────────────────────────────────────────
  if (row.type === 'epic') {
    const colour = getEpicColour(row.epicIdx)
    const barW = (row.maxWeek - row.minWeek) * COL_W
    if (barW <= 0) return null
    return (
      <g>
        <rect
          x={(row.minWeek + weekOffset) * COL_W}
          y={y + 4}
          width={barW}
          height={EPIC_ROW_H - 8}
          fill={colour.hex}
          fillOpacity={0.15}
          rx={3}
        />
        <rect
          x={(row.minWeek + weekOffset) * COL_W}
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
          x2={totalWeeks * COL_W} y2={y + EPIC_ROW_H}
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
    const barW = Math.max(entry.durationWeeks * COL_W, 4)
    const isOverAllocated = weeklyDemand.some(d =>
      d.week >= entry.startWeek &&
      d.week < entry.startWeek + entry.durationWeeks &&
      d.demandDays > d.capacityDays + 0.01,
    )
    const tooltipContent = buildFeatureTooltip(entry)
    return (
      <g>
        <rect
          x={(effectiveStart + weekOffset) * COL_W}
          y={y + 4}
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
        {isOverAllocated && (
          <circle
            cx={(effectiveStart + weekOffset) * COL_W + barW - 8}
            cy={y + FEAT_ROW_H / 2}
            r={4}
            fill="#ef4444"
            style={{ pointerEvents: 'none' }}
          />
        )}
        {entry.isManual && (
          <text
            x={(effectiveStart + weekOffset) * COL_W + 6}
            y={y + FEAT_ROW_H / 2 + 4}
            fontSize={10}
            style={{ pointerEvents: 'none' }}
          >
            ✏️
          </text>
        )}
        <line
          x1={0} y1={y + FEAT_ROW_H}
          x2={totalWeeks * COL_W} y2={y + FEAT_ROW_H}
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
        x={(effectiveStart + weekOffset) * COL_W}
        y={y + 3}
        width={Math.max(storyEntry.durationWeeks * COL_W, 4)}
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
          x={(effectiveStart + weekOffset) * COL_W + 6}
          y={y + STORY_ROW_H / 2 + 4}
          fontSize={9}
          style={{ pointerEvents: 'none' }}
        >
          ✏️
        </text>
      )}
      <line
        x1={0} y1={y + STORY_ROW_H}
        x2={totalWeeks * COL_W} y2={y + STORY_ROW_H}
        stroke={svgColors.rowSep}
        strokeWidth={1}
      />
    </g>
  )
}
