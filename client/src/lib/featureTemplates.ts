import { useQuery } from '@tanstack/react-query'
import { api } from './api'

/**
 * The template library contract shared by every template-backed backlog flow
 * (applying a template to an existing Feature, and issue #295's
 * add-Feature-from-template creation flow): the same templates and the same
 * XS–XL complexity tiers.
 */

export interface TemplateTask {
  id: string
  name: string
  hoursExtraSmall: number
  hoursSmall: number
  hoursMedium: number
  hoursLarge: number
  hoursExtraLarge: number
  resourceTypeName: string
}

export interface FeatureTemplate {
  id: string
  name: string
  category: string | null
  description: string | null
  tasks: TemplateTask[]
}

export type Complexity = 'EXTRA_SMALL' | 'SMALL' | 'MEDIUM' | 'LARGE' | 'EXTRA_LARGE'

export const COMPLEXITY_LABELS: Record<Complexity, string> = {
  EXTRA_SMALL: 'XS',
  SMALL: 'S',
  MEDIUM: 'M',
  LARGE: 'L',
  EXTRA_LARGE: 'XL',
}

/** The template library, shared by every flow that applies a template. */
export function useFeatureTemplates() {
  return useQuery<FeatureTemplate[]>({
    queryKey: ['templates'],
    queryFn: () => api.get('/templates').then(r => r.data),
  })
}
