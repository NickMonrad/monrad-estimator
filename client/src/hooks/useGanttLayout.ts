import { useMemo } from 'react'
import type { TimelineEntry } from '../types/backlog'

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------
export interface StoryTimelineEntry {
  storyId: string
  storyName: string
  featureId: string
  startWeek: number
  durationWeeks: number
  isManual: boolean
}

export interface FeatureDependency {
  featureId: string
  dependsOnId: string
}

export interface StoryDependency {
  storyId: string
  dependsOnId: string
}

export interface EpicDependency {
  epicId: string
  dependsOnId: string
}

export type GanttRow =
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

export interface GanttDraggingState {
  id: string
  type: 'feature' | 'story'
  origStart: number
  startX: number
  currentStart: number
}

// ---------------------------------------------------------------------------
// Scale type
// ---------------------------------------------------------------------------
export type GanttScale = 'week' | 'month' | 'quarter'

/** Returns the pixel width per week for the given scale. */
export function colWForScale(scale: GanttScale): number {
  switch (scale) {
    case 'month':   return 28
    case 'quarter': return 16
    default:        return 64
  }
}

// ---------------------------------------------------------------------------
// Layout constants (shared across Gantt sub-components)
// ---------------------------------------------------------------------------
export const COL_W = 64
export const EPIC_ROW_H = 36
export const FEAT_ROW_H = 36
export const STORY_ROW_H = 28
export const HEADER_H = 44
export const LABEL_W = 300
export const DEP_ARROW_COLOR = '#9ca3af'

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------
interface EpicGroup {
  epicId: string
  epicName: string
  epicOrder: number
  epicFeatureMode: string
  epicScheduleMode: string
  features: TimelineEntry[]
}

interface UseGanttLayoutResult {
  epicGroups: EpicGroup[]
  rows: GanttRow[]
  rowY: Map<string, number>
  totalHeight: number
}

export function useGanttLayout(
  entries: TimelineEntry[],
  storyEntries: StoryTimelineEntry[],
  totalWeeks: number,
  expandedEpics: Set<string>,
  expandedFeatures: Set<string>,
): UseGanttLayoutResult {
  const epicGroups = useMemo<EpicGroup[]>(() => {
    const map = new Map<string, EpicGroup>()
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
    return Array.from(map.values()).sort((a, b) => a.epicOrder - b.epicOrder)
  }, [entries])

  const rows = useMemo<GanttRow[]>(() => {
    const result: GanttRow[] = []
    epicGroups.forEach((epicGroup, epicIdx) => {
      const sortedFeatures = [...epicGroup.features].sort(
        (a, b) => (a.featureOrder ?? 0) - (b.featureOrder ?? 0),
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

  const { rowY, totalHeight } = useMemo(() => {
    let y = HEADER_H
    const map = new Map<string, number>()
    for (const row of rows) {
      map.set(row.key, y)
      y += row.type === 'story' ? STORY_ROW_H : row.type === 'epic' ? EPIC_ROW_H : FEAT_ROW_H
    }
    return { rowY: map, totalHeight: y }
  }, [rows])

  return { epicGroups, rows, rowY, totalHeight }
}
