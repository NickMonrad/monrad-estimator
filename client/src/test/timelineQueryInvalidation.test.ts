import { describe, expect, it, vi } from 'vitest'
import {
  invalidateResourceTypeDerivedQueries,
  invalidateTimelineDerivedQueries,
} from '@/lib/timelineQueryInvalidation'

describe('timelineQueryInvalidation', () => {
  it('invalidates timeline and resource-profile queries together', () => {
    const invalidateQueries = vi.fn()

    invalidateTimelineDerivedQueries({ invalidateQueries } as never, 'project-1')

    expect(invalidateQueries).toHaveBeenCalledTimes(2)
    expect(invalidateQueries).toHaveBeenNthCalledWith(1, { queryKey: ['timeline', 'project-1'] })
    expect(invalidateQueries).toHaveBeenNthCalledWith(2, { queryKey: ['resource-profile', 'project-1'] })
  })

  it('invalidates resource-types and resource-profile queries together', () => {
    const invalidateQueries = vi.fn()

    invalidateResourceTypeDerivedQueries({ invalidateQueries } as never, 'project-1')

    expect(invalidateQueries).toHaveBeenCalledTimes(2)
    expect(invalidateQueries).toHaveBeenNthCalledWith(1, { queryKey: ['resource-types', 'project-1'] })
    expect(invalidateQueries).toHaveBeenNthCalledWith(2, { queryKey: ['resource-profile', 'project-1'] })
  })
})
