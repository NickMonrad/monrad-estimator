import { useQuery } from '@tanstack/react-query'
import { api } from '../lib/api'
import type { Project, ResourceProfile, OverheadItem, ResourceType } from '../types/backlog'

/**
 * Data-fetching hook for the Resource Profile domain.
 * Owns queries for project, profile, overhead items, and resource types.
 */
export interface ResourceProfileData {
  project: Project | undefined
  profile: ResourceProfile | undefined
  profileLoading: boolean
  overheadItems: OverheadItem[]
  resourceTypes: ResourceType[]
}

export function useResourceProfileData(projectId: string | undefined) {
  const { data: project } = useQuery<Project>({
    queryKey: ['project', projectId],
    queryFn: () => api.get(`/projects/${projectId}`).then(r => r.data),
    enabled: !!projectId,
  })

  const { data: profile, isLoading: profileLoading } = useQuery<ResourceProfile>({
    queryKey: ['resource-profile', projectId],
    queryFn: () => api.get(`/projects/${projectId}/resource-profile`).then(r => r.data),
    enabled: !!projectId,
  })

  const { data: overheadItems = [] } = useQuery<OverheadItem[]>({
    queryKey: ['overheads', projectId],
    queryFn: () => api.get(`/projects/${projectId}/overhead`).then(r => r.data),
    enabled: !!projectId,
  })

  const { data: resourceTypes = [] } = useQuery<ResourceType[]>({
    queryKey: ['resource-types', projectId],
    queryFn: () => api.get(`/projects/${projectId}/resource-types`).then(r => r.data),
    enabled: !!projectId,
  })

  return { project, profile, profileLoading, overheadItems, resourceTypes }
}
