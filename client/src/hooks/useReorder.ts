import { useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/api'

interface ReorderEpicItem { id: string; order: number }
interface ReorderFeatureItem { id: string; order: number; epicId: string }
interface ReorderStoryItem { id: string; order: number; featureId: string }
interface ReorderTaskItem { id: string; order: number; storyId: string }

export function useReorderEpics(projectId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (items: ReorderEpicItem[]) =>
      api.patch(`/projects/${projectId}/reorder/epics`, { items }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['backlog', projectId] }),
  })
}

export function useReorderFeatures(projectId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (items: ReorderFeatureItem[]) =>
      api.patch(`/projects/${projectId}/reorder/features`, { items }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['backlog', projectId] }),
  })
}

export function useReorderStories(projectId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (items: ReorderStoryItem[]) =>
      api.patch(`/projects/${projectId}/reorder/stories`, { items }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['backlog', projectId] }),
  })
}

export function useReorderTasks(projectId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (items: ReorderTaskItem[]) =>
      api.patch(`/projects/${projectId}/reorder/tasks`, { items }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['backlog', projectId] }),
  })
}
