import { describe, expect, it, vi } from 'vitest'
import {
  invalidateProjectPlanning,
  invalidateProjectResourceProfile,
  invalidateProjectCommercial,
  invalidateProjectAll,
  invalidateProjectDocumentData,
} from '@/lib/projectInvalidation'

describe('projectInvalidation', () => {
  describe('invalidateProjectPlanning', () => {
    it('invalidates project, timeline, and resource-profile queries', () => {
      const invalidateQueries = vi.fn()

      invalidateProjectPlanning({ invalidateQueries } as never, 'project-1')

      expect(invalidateQueries).toHaveBeenCalledTimes(3)
      expect(invalidateQueries).toHaveBeenNthCalledWith(1, { queryKey: ['project', 'project-1'] })
      expect(invalidateQueries).toHaveBeenNthCalledWith(2, { queryKey: ['timeline', 'project-1'] })
      expect(invalidateQueries).toHaveBeenNthCalledWith(3, { queryKey: ['resource-profile', 'project-1'] })
    })

    it('does nothing when projectId is undefined', () => {
      const invalidateQueries = vi.fn()

      invalidateProjectPlanning({ invalidateQueries } as never, undefined)

      expect(invalidateQueries).not.toHaveBeenCalled()
    })
  })

  describe('invalidateProjectDocumentData', () => {
    it('invalidates every query used by document generation', () => {
      const invalidateQueries = vi.fn()

      invalidateProjectDocumentData({ invalidateQueries } as never, 'project-1')

      expect(invalidateQueries).toHaveBeenCalledTimes(6)
      expect(invalidateQueries).toHaveBeenNthCalledWith(1, { queryKey: ['effort', 'project-1'] })
      expect(invalidateQueries).toHaveBeenNthCalledWith(2, { queryKey: ['timeline', 'project-1'] })
      expect(invalidateQueries).toHaveBeenNthCalledWith(3, { queryKey: ['resource-profile', 'project-1'] })
      expect(invalidateQueries).toHaveBeenNthCalledWith(4, { queryKey: ['epics', 'project-1'] })
      expect(invalidateQueries).toHaveBeenNthCalledWith(5, { queryKey: ['project-dependencies', 'project-1'] })
      expect(invalidateQueries).toHaveBeenNthCalledWith(6, { queryKey: ['project-risks', 'project-1'] })
    })

    it('does nothing when projectId is undefined', () => {
      const invalidateQueries = vi.fn()

      invalidateProjectDocumentData({ invalidateQueries } as never, undefined)

      expect(invalidateQueries).not.toHaveBeenCalled()
    })
  })

  describe('invalidateProjectResourceProfile', () => {
    it('invalidates resource-profile, resource-types, overheads, and timeline queries', () => {
      const invalidateQueries = vi.fn()

      invalidateProjectResourceProfile({ invalidateQueries } as never, 'project-1')

      expect(invalidateQueries).toHaveBeenCalledTimes(5)
      expect(invalidateQueries).toHaveBeenNthCalledWith(1, { queryKey: ['resource-profile', 'project-1'] })
      expect(invalidateQueries).toHaveBeenNthCalledWith(2, { queryKey: ['resource-types', 'project-1'] })
      expect(invalidateQueries).toHaveBeenNthCalledWith(3, { queryKey: ['overheads', 'project-1'] })
      expect(invalidateQueries).toHaveBeenNthCalledWith(4, { queryKey: ['timeline', 'project-1'] })
      expect(invalidateQueries).toHaveBeenNthCalledWith(5, { queryKey: ['capacity-profiles', 'project-1'] })
    })
    it('does nothing when projectId is undefined', () => {
      const invalidateQueries = vi.fn()

      invalidateProjectResourceProfile({ invalidateQueries } as never, undefined)

      expect(invalidateQueries).not.toHaveBeenCalled()
    })
  })

  describe('invalidateProjectCommercial', () => {
    it('invalidates project, discounts, and resource-profile queries', () => {
      const invalidateQueries = vi.fn()

      invalidateProjectCommercial({ invalidateQueries } as never, 'project-1')

      expect(invalidateQueries).toHaveBeenCalledTimes(3)
      expect(invalidateQueries).toHaveBeenNthCalledWith(1, { queryKey: ['project', 'project-1'] })
      expect(invalidateQueries).toHaveBeenNthCalledWith(2, { queryKey: ['discounts', 'project-1'] })
      expect(invalidateQueries).toHaveBeenNthCalledWith(3, { queryKey: ['resource-profile', 'project-1'] })
    })

    it('does nothing when projectId is undefined', () => {
      const invalidateQueries = vi.fn()

      invalidateProjectCommercial({ invalidateQueries } as never, undefined)

      expect(invalidateQueries).not.toHaveBeenCalled()
    })
  })

  describe('invalidateProjectAll', () => {
    it('invalidates all project-related queries', () => {
      const invalidateQueries = vi.fn()

      invalidateProjectAll({ invalidateQueries } as never, 'project-1')

      // Planning: project, timeline, resource-profile (3)
      // Resource profile: resource-profile, resource-types, overheads, timeline (4, but resource-profile + timeline deduped by React Query)
      // Commercial: project, discounts, resource-profile (3, but project + resource-profile deduped)
      // Total unique: 6 (project, timeline, resource-profile, resource-types, overheads, discounts)
      // React Query deduplicates by queryKey, so the actual fetch is less than the call count
      expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['project', 'project-1'] })
      expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['timeline', 'project-1'] })
      expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['resource-profile', 'project-1'] })
      expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['resource-types', 'project-1'] })
      expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['overheads', 'project-1'] })
      expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['discounts', 'project-1'] })
    })

    it('does nothing when projectId is undefined', () => {
      const invalidateQueries = vi.fn()

      invalidateProjectAll({ invalidateQueries } as never, undefined)

      expect(invalidateQueries).not.toHaveBeenCalled()
    })
  })

  describe('guard clause', () => {
    it('handles empty string projectId gracefully (skips because empty string is falsy)', () => {
      const invalidateQueries = vi.fn()

      invalidateProjectPlanning({ invalidateQueries } as never, '')

      // Empty string is falsy, so the guard clause prevents invalidation
      expect(invalidateQueries).not.toHaveBeenCalled()
    })
  })
})
