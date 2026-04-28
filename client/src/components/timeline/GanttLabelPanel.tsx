import { useState } from 'react'
import type { GanttRow } from '../../hooks/useGanttLayout'
import { EPIC_ROW_H, FEAT_ROW_H, STORY_ROW_H, HEADER_H, LABEL_W } from '../../hooks/useGanttLayout'
import { getEpicColour } from '../../lib/epicColours'

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------
interface GanttLabelPanelProps {
  rows: GanttRow[]
  storyEntryIds: Set<string>  // featureIds that have at least one story
  expandedEpics: Set<string>
  expandedFeatures: Set<string>
  setExpandedEpics: React.Dispatch<React.SetStateAction<Set<string>>>
  setExpandedFeatures: React.Dispatch<React.SetStateAction<Set<string>>>
  setEditingFeatureId: (id: string | null) => void
  onMoveEpic?: (epicId: string, direction: 'up' | 'down', epicIdx: number) => void
  onMoveFeature?: (epicId: string, featureIdx: number, direction: 'up' | 'down') => void
  onUpdateEpicMode?: (epicId: string, featureMode: 'sequential' | 'parallel') => void
  onUpdateEpicScheduleMode?: (epicId: string, scheduleMode: 'sequential' | 'parallel') => void
  epicDependencies?: Array<{ epicId: string; dependsOnId: string }>
  onAddEpicDep?: (epicId: string, dependsOnId: string) => void
  onRemoveEpicDep?: (epicId: string, dependsOnId: string) => void
}

// ---------------------------------------------------------------------------
// Component — sticky left label column
// ---------------------------------------------------------------------------
export default function GanttLabelPanel({
  rows,
  storyEntryIds,
  expandedEpics,
  expandedFeatures,
  setExpandedEpics,
  setExpandedFeatures,
  setEditingFeatureId,
  onMoveEpic,
  onMoveFeature,
  onUpdateEpicMode,
  onUpdateEpicScheduleMode,
  epicDependencies = [],
  onAddEpicDep,
  onRemoveEpicDep,
}: GanttLabelPanelProps) {
  // track which epic row has its dep-picker dropdown open
  const [depPickerEpicId, setDepPickerEpicId] = useState<string | null>(null)

  // derive the full list of epic rows for the dep dropdown
  const allEpicRows = rows.filter((r): r is Extract<GanttRow, { type: 'epic' }> => r.type === 'epic')
  return (
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
        // ── Epic row ────────────────────────────────────────────────────────
        if (row.type === 'epic') {
          const colour = getEpicColour(row.epicIdx)
          const isOpen = expandedEpics.has(row.epicId)
          return (
            <div
              key={row.key}
              style={{ height: EPIC_ROW_H, backgroundColor: `${colour.hex}14` }}
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
              {/* Epic dependency chips + picker */}
              {onAddEpicDep && (
                <div
                  className="flex items-center gap-1 flex-shrink-0 relative"
                  onClick={e => e.stopPropagation()}
                >
                  {/* existing dep chips */}
                  {epicDependencies
                    .filter(d => d.epicId === row.epicId)
                    .map(d => {
                      const depName = allEpicRows.find(r => r.epicId === d.dependsOnId)?.epicName ?? d.dependsOnId
                      return (
                        <span
                          key={d.dependsOnId}
                          className="inline-flex items-center gap-0.5 text-xs bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400 px-1 py-0.5 rounded"
                          title={`Depends on: ${depName}`}
                        >
                          →{depName.slice(0, 6)}
                          <button
                            onClick={() => onRemoveEpicDep?.(row.epicId, d.dependsOnId)}
                            className="ml-0.5 text-gray-400 hover:text-red-500 leading-none"
                          >×</button>
                        </span>
                      )
                    })}
                  {/* add dep button */}
                  <button
                    onClick={() => setDepPickerEpicId(prev => prev === row.epicId ? null : row.epicId)}
                    className="text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 px-1 leading-none"
                    title="Add dependency"
                  >＋</button>
                  {/* dropdown picker */}
                  {depPickerEpicId === row.epicId && (
                    <div className="absolute top-full left-0 z-50 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-600 rounded shadow-lg py-1 min-w-[140px]">
                      {allEpicRows
                        .filter(r => r.epicId !== row.epicId && !epicDependencies.some(d => d.epicId === row.epicId && d.dependsOnId === r.epicId))
                        .map(r => (
                          <button
                            key={r.epicId}
                            className="w-full text-left text-xs px-3 py-1.5 hover:bg-gray-50 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-300"
                            onClick={() => {
                              onAddEpicDep(row.epicId, r.epicId)
                              setDepPickerEpicId(null)
                            }}
                          >
                            {r.epicName}
                          </button>
                        ))}
                      {allEpicRows.filter(r => r.epicId !== row.epicId && !epicDependencies.some(d => d.epicId === row.epicId && d.dependsOnId === r.epicId)).length === 0 && (
                        <span className="text-xs px-3 py-1.5 text-gray-400 block">No epics available</span>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          )
        }

        // ── Feature row ─────────────────────────────────────────────────────
        if (row.type === 'feature') {
          const isOpen = expandedFeatures.has(row.entry.featureId)
          const hasStories = storyEntryIds.has(row.entry.featureId)
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
                >▲</button>
                <button
                  className="text-gray-300 dark:text-gray-600 hover:text-gray-600 dark:hover:text-gray-400 text-xs leading-none disabled:opacity-20"
                  disabled={row.featureIdx === row.totalFeaturesInEpic - 1 || !onMoveFeature}
                  onClick={() => onMoveFeature?.(row.entry.epicId, row.featureIdx, 'down')}
                  title="Move feature down"
                >▼</button>
              </div>
            </div>
          )
        }

        // ── Story row ───────────────────────────────────────────────────────
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
  )
}
