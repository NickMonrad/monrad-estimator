import type { QueryClient } from '@tanstack/react-query'

type QueryInvalidator = Pick<QueryClient, 'invalidateQueries'>

export function invalidateTimelineDerivedQueries(
  queryClient: QueryInvalidator,
  projectId: string | undefined,
) {
  if (!projectId) return

  queryClient.invalidateQueries({ queryKey: ['timeline', projectId] })
  queryClient.invalidateQueries({ queryKey: ['resource-profile', projectId] })
}

export function invalidateResourceTypeDerivedQueries(
  queryClient: QueryInvalidator,
  projectId: string | undefined,
) {
  if (!projectId) return

  queryClient.invalidateQueries({ queryKey: ['resource-types', projectId] })
  queryClient.invalidateQueries({ queryKey: ['resource-profile', projectId] })
}
