import { useState } from 'react'
import type { TimelineEntry } from '../../types/backlog'
import type {
  StoryTimelineEntry,
  FeatureDependency,
  StoryDependency,
  EpicDependency,
  GanttDraggingState,
} from '../../hooks/useGanttLayout'
import { FEAT_ROW_H, STORY_ROW_H, EPIC_ROW_H, DEP_ARROW_COLOR } from '../../hooks/useGanttLayout'

/** Accent for the hovered / focused / selected feature dependency connector. */
const DEP_ACTIVE_COLOR = '#2c60f6'
/** Fill of the remove control revealed by a selected feature dependency. */
const DEP_REMOVE_COLOR = '#dc2626'
/** Transparent stroke width that makes a thin connector comfortably clickable. */
const DEP_HIT_STROKE_W = 16

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function bezierArrow(x1: number, y1: number, x2: number, y2: number): string {
  const dx = Math.abs(x2 - x1)
  const cpOffset = Math.max(30, dx * 0.4)
  return `M ${x1} ${y1} C ${x1 + cpOffset} ${y1}, ${x2 - cpOffset} ${y2}, ${x2} ${y2}`
}

function isSameFeatureDep(a: FeatureDependency | null, b: FeatureDependency | null): boolean {
  return a !== null && b !== null && a.featureId === b.featureId && a.dependsOnId === b.dependsOnId
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------
export interface GanttDependencyDragPreview {
  startX: number
  startY: number
  currentX: number
  currentY: number
  targetValid: boolean
}

interface GanttDependencyArrowsProps {
  featureDependencies: FeatureDependency[]
  storyDependencies: StoryDependency[]
  epicDependencies: EpicDependency[]
  featureById: Map<string, TimelineEntry>
  storyById: Map<string, StoryTimelineEntry>
  epicById: Map<string, { epicId: string; startWeek: number; durationWeeks: number }>
  rowY: Map<string, number>
  weekOffset: number
  colW: number
  dragging: GanttDraggingState | null
  dependencyPreview?: GanttDependencyDragPreview | null
  selectedFeatureDep: FeatureDependency | null
  onSelectFeatureDep: (dep: FeatureDependency | null) => void
  onRemoveFeatureDep: (featureId: string, dependsOnId: string) => void
}

// ---------------------------------------------------------------------------
// Component — renders inside an existing <svg>
// ---------------------------------------------------------------------------
export default function GanttDependencyArrows({
  featureDependencies,
  storyDependencies,
  epicDependencies,
  featureById,
  storyById,
  epicById,
  rowY,
  weekOffset,
  colW,
  dragging,
  dependencyPreview,
  selectedFeatureDep,
  onSelectFeatureDep,
  onRemoveFeatureDep,
}: GanttDependencyArrowsProps) {
  // Hover/keyboard-focus emphasis for feature connectors. Selection lives in the
  // parent because it survives across dependency refreshes.
  const [activeFeatureDep, setActiveFeatureDep] = useState<FeatureDependency | null>(null)

  function activateFeatureDep(dep: FeatureDependency) {
    onSelectFeatureDep(isSameFeatureDep(selectedFeatureDep, dep) ? null : dep)
  }

  return (
    <>
      <defs>
        <marker id="arrow" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
          <path d="M0,0 L0,6 L8,3 z" fill={DEP_ARROW_COLOR} />
        </marker>
      </defs>
      {dependencyPreview && (
        <path
          data-testid="dependency-drag-preview"
          d={bezierArrow(
            dependencyPreview.startX,
            dependencyPreview.startY,
            dependencyPreview.currentX,
            dependencyPreview.currentY,
          )}
          stroke={dependencyPreview.targetValid ? '#2563eb' : '#dc2626'}
          strokeWidth={2}
          strokeDasharray="6 4"
          fill="none"
          markerEnd="url(#arrow)"
          style={{ pointerEvents: 'none' }}
        />
      )}

      {/* Feature dependency arrows */}
      {featureDependencies.map(dep => {
        const predEntry = featureById.get(dep.dependsOnId)
        const succEntry = featureById.get(dep.featureId)
        if (!predEntry || !succEntry) return null

        const predY = rowY.get(`feature-${predEntry.featureId}`)
        const succY = rowY.get(`feature-${succEntry.featureId}`)
        if (predY === undefined || succY === undefined) return null

        const predDragging = dragging?.type === 'feature' && dragging.id === predEntry.featureId
        const succDragging = dragging?.type === 'feature' && dragging.id === succEntry.featureId
        const predStart = predDragging ? dragging!.currentStart : predEntry.startWeek
        const succStart = succDragging ? dragging!.currentStart : succEntry.startWeek

        const x1 = (predStart + weekOffset + predEntry.durationWeeks) * colW
        const y1 = predY + FEAT_ROW_H / 2
        const x2 = (succStart + weekOffset) * colW
        const y2 = succY + FEAT_ROW_H / 2

        const isSelected = isSameFeatureDep(selectedFeatureDep, dep)
        const isEmphasised = isSelected || isSameFeatureDep(activeFeatureDep, dep)
        const depLabel = `${predEntry.featureName} → ${succEntry.featureName}`
        // The bezier control points are symmetric, so the curve midpoint is the
        // mean of both endpoints.
        const midX = (x1 + x2) / 2
        const midY = (y1 + y2) / 2

        return (
          <g key={`fdep-${dep.dependsOnId}-${dep.featureId}`}>
            <path
              data-testid={`dependency-arrow-${dep.dependsOnId}-${dep.featureId}`}
              d={bezierArrow(x1, y1, x2, y2)}
              stroke={isEmphasised ? DEP_ACTIVE_COLOR : DEP_ARROW_COLOR}
              strokeWidth={isEmphasised ? 2.5 : 1.5}
              fill="none"
              markerEnd="url(#arrow)"
              opacity={isEmphasised ? 1 : 0.7}
              style={{ pointerEvents: 'none' }}
            />
            {/* Invisible wide stroke: the pointer/focus target for the connector. */}
            <path
              d={bezierArrow(x1, y1, x2, y2)}
              role="button"
              tabIndex={0}
              aria-pressed={isSelected}
              aria-label={`Dependency ${depLabel}`}
              stroke="transparent"
              strokeWidth={DEP_HIT_STROKE_W}
              fill="none"
              className="cursor-pointer focus:outline-none"
              style={{ pointerEvents: 'stroke' }}
              onClick={() => activateFeatureDep(dep)}
              onMouseEnter={() => setActiveFeatureDep(dep)}
              onMouseLeave={() => setActiveFeatureDep(current => (isSameFeatureDep(current, dep) ? null : current))}
              onFocus={() => setActiveFeatureDep(dep)}
              onBlur={() => setActiveFeatureDep(current => (isSameFeatureDep(current, dep) ? null : current))}
              onKeyDown={event => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  activateFeatureDep(dep)
                } else if (event.key === 'Escape') {
                  onSelectFeatureDep(null)
                }
              }}
            />
            {isSelected && (
              <>
                <circle
                  role="button"
                  tabIndex={0}
                  aria-label={`Remove dependency ${depLabel}`}
                  data-testid={`dependency-remove-${dep.dependsOnId}-${dep.featureId}`}
                  cx={midX}
                  cy={midY}
                  r={9}
                  fill={DEP_REMOVE_COLOR}
                  stroke="#ffffff"
                  strokeWidth={1.5}
                  className="cursor-pointer focus:outline-none hover:[stroke-width:3px] focus:[stroke:#1d245b] focus:[stroke-width:4px] dark:focus:[stroke:#ffffff]"
                  style={{ pointerEvents: 'all' }}
                  onClick={() => onRemoveFeatureDep(dep.featureId, dep.dependsOnId)}
                  onKeyDown={event => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault()
                      onRemoveFeatureDep(dep.featureId, dep.dependsOnId)
                    }
                  }}
                />
                <text
                  x={midX}
                  y={midY + 4}
                  textAnchor="middle"
                  fontSize={11}
                  fill="#ffffff"
                  style={{ pointerEvents: 'none', userSelect: 'none' }}
                >
                  ✕
                </text>
              </>
            )}
          </g>
        )
      })}

      {/* Story dependency arrows */}
      {storyDependencies.map(dep => {
        const predEntry = storyById.get(dep.dependsOnId)
        const succEntry = storyById.get(dep.storyId)
        if (!predEntry || !succEntry) return null

        const predY = rowY.get(`story-${predEntry.storyId}`)
        const succY = rowY.get(`story-${succEntry.storyId}`)
        if (predY === undefined || succY === undefined) return null

        const predDragging = dragging?.type === 'story' && dragging.id === predEntry.storyId
        const succDragging = dragging?.type === 'story' && dragging.id === succEntry.storyId
        const predStart = predDragging ? dragging!.currentStart : predEntry.startWeek
        const succStart = succDragging ? dragging!.currentStart : succEntry.startWeek

        const x1 = (predStart + weekOffset + predEntry.durationWeeks) * colW
        const y1 = predY + STORY_ROW_H / 2
        const x2 = (succStart + weekOffset) * colW
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

      {/* Epic dependency arrows */}
      {epicDependencies.map(dep => {
        const predEpic = epicById.get(dep.dependsOnId)
        const succEpic = epicById.get(dep.epicId)
        if (!predEpic || !succEpic) return null

        const predY = rowY.get(`epic-${dep.dependsOnId}`)
        const succY = rowY.get(`epic-${dep.epicId}`)
        if (predY === undefined || succY === undefined) return null

        const x1 = (predEpic.startWeek + weekOffset + predEpic.durationWeeks) * colW
        const y1 = predY + EPIC_ROW_H / 2
        const x2 = (succEpic.startWeek + weekOffset) * colW
        const y2 = succY + EPIC_ROW_H / 2

        return (
          <path
            key={`edep-${dep.dependsOnId}-${dep.epicId}`}
            d={bezierArrow(x1, y1, x2, y2)}
            stroke={DEP_ARROW_COLOR}
            strokeWidth={2}
            fill="none"
            markerEnd="url(#arrow)"
            opacity={0.8}
          />
        )
      })}
    </>
  )
}
