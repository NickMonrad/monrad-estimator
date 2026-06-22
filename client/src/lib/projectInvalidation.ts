import type { QueryClient } from '@tanstack/react-query'

type QueryInvalidator = Pick<QueryClient, 'invalidateQueries'>

/**
 * Invalidate query keys consumed by the Timeline planning domain.
 *
 * Timeline owns scheduling/planning settings. When planning settings change
 * (buffer weeks, onboarding weeks, start date, schedule), all surfaces that
 * consume those facts must be refreshed.
 */
export function invalidateProjectPlanning(
  queryClient: QueryInvalidator,
  projectId: string | undefined,
) {
  if (!projectId) return
  queryClient.invalidateQueries({ queryKey: ['project', projectId] })
  queryClient.invalidateQueries({ queryKey: ['timeline', projectId] })
  queryClient.invalidateQueries({ queryKey: ['resource-profile', projectId] })
}

/**
 * Invalidate query keys consumed by the Resource Profile domain.
 *
 * Resource Profile owns resource shape, named resources, capacity,
 * and allocation-mode editing. When these change, the timeline,
 * commercial surfaces, and the profile itself must refresh.
 */
export function invalidateProjectResourceProfile(
  queryClient: QueryInvalidator,
  projectId: string | undefined,
) {
  if (!projectId) return
  queryClient.invalidateQueries({ queryKey: ['resource-profile', projectId] })
  queryClient.invalidateQueries({ queryKey: ['resource-types', projectId] })
  queryClient.invalidateQueries({ queryKey: ['overheads', projectId] })
  queryClient.invalidateQueries({ queryKey: ['timeline', projectId] })
}

/**
 * Invalidate query keys consumed by the Commercial domain.
 *
 * Commercial owns pricing/billing presentation. Commercial-only mutations
 * (discounts, tax) must refresh their own state without pretending to own
 * planning or resource-allocation state.
 */
export function invalidateProjectCommercial(
  queryClient: QueryInvalidator,
  projectId: string | undefined,
) {
  if (!projectId) return
  queryClient.invalidateQueries({ queryKey: ['project', projectId] })
  queryClient.invalidateQueries({ queryKey: ['discounts', projectId] })
  queryClient.invalidateQueries({ queryKey: ['resource-profile', projectId] })
}

/**
 * Invalidate all project-related query keys across every domain.
 *
 * Use sparingly — prefer the domain-specific helpers to keep invalidation
 * boundaries explicit. Appropriate for entry-level project mutations
 * (settings page updates) or mutations where the scope genuinely spans
 * planning, resource, and commercial surfaces.
 */
export function invalidateProjectAll(
  queryClient: QueryInvalidator,
  projectId: string | undefined,
) {
  if (!projectId) return
  invalidateProjectPlanning(queryClient, projectId)
  invalidateProjectResourceProfile(queryClient, projectId)
  invalidateProjectCommercial(queryClient, projectId)
}
