import type { TimelineEntry } from '../../types/backlog'
import type {
  StoryTimelineEntry,
  FeatureDependency,
  StoryDependency,
  GanttDraggingState,
} from '../../hooks/useGanttLayout'
import { COL_W, FEAT_ROW_H, STORY_ROW_H, DEP_ARROW_COLOR } from '../../hooks/useGanttLayout'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function bezierArrow(x1: number, y1: number, x2: number, y2: number): string {
  const dx = Math.abs(x2 - x1)
  const cpOffset = Math.max(30, dx * 0.4)
  return `M ${x1} ${y1} C ${x1 + cpOffset} ${y1}, ${x2 - cpOffset} ${y2}, ${x2} ${y2}`
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------
interface GanttDependencyArrowsProps {
  featureDependencies: FeatureDependency[]
  storyDependencies: StoryDependency[]
  featureById: Map<string, TimelineEntry>
  storyById: Map<string, StoryTimelineEntry>
  rowY: Map<string, number>
  weekOffset: number
  dragging: GanttDraggingState | null
}

// ---------------------------------------------------------------------------
// Component — renders inside an existing <svg>
// ---------------------------------------------------------------------------
export default function GanttDependencyArrows({
  featureDependencies,
  storyDependencies,
  featureById,
  storyById,
  rowY,
  weekOffset,
  dragging,
}: GanttDependencyArrowsProps) {
  return (
    <>
      <defs>
        <marker id="arrow" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
          <path d="M0,0 L0,6 L8,3 z" fill={DEP_ARROW_COLOR} />
        </marker>
      </defs>

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

        const x1 = (predStart + weekOffset + predEntry.durationWeeks) * COL_W
        const y1 = predY + FEAT_ROW_H / 2
        const x2 = (succStart + weekOffset) * COL_W
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

        const predY = rowY.get(`story-${predEntry.storyId}`)
        const succY = rowY.get(`story-${succEntry.storyId}`)
        if (predY === undefined || succY === undefined) return null

        const predDragging = dragging?.type === 'story' && dragging.id === predEntry.storyId
        const succDragging = dragging?.type === 'story' && dragging.id === succEntry.storyId
        const predStart = predDragging ? dragging!.currentStart : predEntry.startWeek
        const succStart = succDragging ? dragging!.currentStart : succEntry.startWeek

        const x1 = (predStart + weekOffset + predEntry.durationWeeks) * COL_W
        const y1 = predY + STORY_ROW_H / 2
        const x2 = (succStart + weekOffset) * COL_W
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
    </>
  )
}
