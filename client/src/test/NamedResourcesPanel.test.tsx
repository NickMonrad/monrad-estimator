import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import NamedResourcesPanel from '@/components/resource-profile/NamedResourcesPanel'
import type { ResourceProfileRow } from '@/types/backlog'

vi.mock('../lib/api', () => ({
  api: {
    get: vi.fn().mockResolvedValue({ data: [] }),
    post: vi.fn().mockResolvedValue({ data: {} }),
    put: vi.fn().mockResolvedValue({ data: {} }),
    delete: vi.fn().mockResolvedValue({}),
  },
}))

import { api } from '../lib/api'

const MOCK_NAMED_RESOURCES = [
  { id: 'nr-1', resourceTypeId: 'rt-1', name: 'Developer 1', startWeek: 0, endWeek: 9, allocationPct: 100, pricingModel: 'ACTUAL_DAYS' as const, createdAt: '', updatedAt: '' },
  { id: 'nr-2', resourceTypeId: 'rt-1', name: 'Developer 2', startWeek: 0, endWeek: 9, allocationPct: 100, pricingModel: 'ACTUAL_DAYS' as const, createdAt: '', updatedAt: '' },
]

const MOCK_ALLOCATIONS: ResourceProfileRow['namedResources'] = [
  { id: 'nr-1', name: 'Developer 1', allocationMode: 'EFFORT', allocationPercent: 100, allocationStartWeek: 0, allocationEndWeek: 9, startWeek: 0, endWeek: 9, allocatedDays: 20, derivedStartWeek: 0, derivedEndWeek: 9, actualAllocatedDays: 20, actualAllocationStartWeek: 0, actualAllocationEndWeek: 9, actualAllocatedWeeks: [{ week: 0, days: 5, capacityDays: 5 }, { week: 1, days: 5, capacityDays: 5 }], actualAllocationSegments: [{ startWeek: 0, endWeek: 1, days: 10 }], synthetic: false },
  { id: 'nr-2', name: 'Developer 2', allocationMode: 'EFFORT', allocationPercent: 100, allocationStartWeek: 0, allocationEndWeek: 9, startWeek: 0, endWeek: 9, allocatedDays: 20, derivedStartWeek: 0, derivedEndWeek: 9, actualAllocatedDays: 20, actualAllocationStartWeek: 0, actualAllocationEndWeek: 9, actualAllocatedWeeks: [{ week: 0, days: 5, capacityDays: 5 }, { week: 1, days: 5, capacityDays: 5 }], actualAllocationSegments: [{ startWeek: 0, endWeek: 1, days: 10 }], synthetic: false },
]

function renderPanel() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries')

  api.get.mockReset()
  api.get.mockResolvedValue({ data: MOCK_NAMED_RESOURCES })
  api.post.mockReset()
  api.post.mockResolvedValue({ data: { id: 'nr-3' } })
  api.put.mockReset()
  api.put.mockResolvedValue({ data: { id: 'nr-1', name: 'Alice' } })
  api.delete.mockReset()
  api.delete.mockResolvedValue({})

  render(
    <QueryClientProvider client={queryClient}>
      <NamedResourcesPanel
        projectId="proj-1"
        rtId="rt-1"
        rtCount={2}
        columnCount={8}
        allocations={MOCK_ALLOCATIONS}
      />
    </QueryClientProvider>,
  )

  return { queryClient, invalidateSpy }
}

describe('NamedResourcesPanel cache invalidation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('loads and displays named resources from the API', async () => {
    renderPanel()

    await waitFor(() => {
      expect(api.get).toHaveBeenCalledWith(
        '/projects/proj-1/resource-types/rt-1/named-resources',
      )
    })

    expect(await screen.findByDisplayValue('Developer 1')).toBeInTheDocument()
    expect(await screen.findByDisplayValue('Developer 2')).toBeInTheDocument()
  })

  it('invalidates timeline query key after renaming', async () => {
    const { invalidateSpy } = renderPanel()

    const input = await screen.findByDisplayValue('Developer 1')
    fireEvent.change(input, { target: { value: 'Alice' } })
    fireEvent.blur(input)

    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['timeline', 'proj-1'] })
    })
  })

  it('invalidates timeline query key after adding a person', async () => {
    const { invalidateSpy } = renderPanel()

    await screen.findByDisplayValue('Developer 1')

    fireEvent.click(screen.getByText('+ Add person'))

    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['timeline', 'proj-1'] })
    })
  })

  it('invalidates timeline query key after deleting a person', async () => {
    const { invalidateSpy } = renderPanel()

    await screen.findByDisplayValue('Developer 1')

    const deleteBtns = await screen.findAllByTitle('Delete')
    fireEvent.click(deleteBtns[0])

    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['timeline', 'proj-1'] })
    })
  })

  it('invalidates all four query keys on create', async () => {
    const { invalidateSpy } = renderPanel()

    await screen.findByDisplayValue('Developer 1')
    fireEvent.click(screen.getByText('+ Add person'))

    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['named-resources', 'proj-1', 'rt-1'] })
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['resource-profile', 'proj-1'] })
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['resource-types', 'proj-1'] })
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['timeline', 'proj-1'] })
    })
  })
})
