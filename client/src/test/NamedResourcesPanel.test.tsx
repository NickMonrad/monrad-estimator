import React from 'react'
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
      <table>
        <tbody>
          <NamedResourcesPanel
            projectId="proj-1"
            rtId="rt-1"
            rtCount={2}
            columnCount={8}
            allocations={MOCK_ALLOCATIONS}
          />
        </tbody>
      </table>
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

describe('NamedResourcesPanel billing basis terminology', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('displays Billing basis label', async () => {
    renderPanel()
    const labels = await screen.findAllByText('Billing basis')
    expect(labels).toHaveLength(3)
  })

  it('shows Actual scheduled days option', async () => {
    renderPanel()
    await screen.findByDisplayValue('Developer 1')
    const options = screen.getAllByText('Actual scheduled days')
    expect(options).toHaveLength(2)
  })

  it('shows Planned allocation option', async () => {
    renderPanel()
    await screen.findByDisplayValue('Developer 1')
    const options = screen.getAllByText('Planned allocation')
    expect(options).toHaveLength(2)
  })

  it('does not show old labels Actual Days or Pro-rata', async () => {
    renderPanel()
    await screen.findByDisplayValue('Developer 1')
    expect(screen.queryByText('Actual Days')).not.toBeInTheDocument()
    expect(screen.queryByText('Pro-rata')).not.toBeInTheDocument()
  })

  it('has accessible billing basis selects with name Billing basis', async () => {
    renderPanel()
    const selects = await screen.findAllByRole('combobox', { name: 'Billing basis' })
    expect(selects).toHaveLength(2)
  })

  it('provides helper text that billing does not affect schedule', async () => {
    renderPanel()
    await screen.findByDisplayValue('Developer 1')
    const descriptions = screen.getAllByText('Determines which days are used for commercial billing. Does not affect the planning schedule.')
    expect(descriptions).toHaveLength(2)
    descriptions.forEach(el => expect(el.className).toContain('sr-only'))
  })
})

describe('NamedResourcesPanel capacity profile display', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders capacity profile with all fields for a named resource with 3 segments', async () => {
    const profileAllocations: ResourceProfileRow['namedResources'] = [
      {
        id: 'nr-cap-1',
        name: 'Alice',
        allocationMode: 'EFFORT',
        allocationPercent: 100,
        allocationStartWeek: null,
        allocationEndWeek: null,
        startWeek: null,
        endWeek: null,
        allocatedDays: 15,
        derivedStartWeek: null,
        derivedEndWeek: null,
        actualAllocatedDays: 10,
        actualAllocationStartWeek: 2,
        actualAllocationEndWeek: 6,
        actualAllocatedWeeks: [
          { week: 2, days: 2, capacityDays: 5 },
          { week: 3, days: 2, capacityDays: 5 },
          { week: 4, days: 3, capacityDays: 5 },
          { week: 5, days: 2, capacityDays: 5 },
          { week: 6, days: 1, capacityDays: 5 },
        ],
        actualAllocationSegments: [
          { startWeek: 2, endWeek: 6, days: 10 },
        ],
        synthetic: false,
        capacityProfile: {
          planningBasis: 'availabilityWindow',
          source: 'squadPlanner',
          defaultPercent: 80,
          startWeek: 0,
          endWeek: 11,
          segments: [
            { startWeek: 0, endWeek: 3, capacityPercent: 50 },
            { startWeek: 4, endWeek: 7, capacityPercent: 75 },
            { startWeek: 8, endWeek: 11, capacityPercent: 100 },
          ],
          resolutionSource: 'PROFILE',
        },
      },
    ]

    api.get.mockResolvedValue({
      data: [{
        id: 'nr-cap-1', resourceTypeId: 'rt-1', name: 'Alice',
        startWeek: null, endWeek: null, allocationPct: 100,
        pricingModel: 'ACTUAL_DAYS', createdAt: '2024-01-01', updatedAt: '2024-01-01',
      }],
    })

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={queryClient}>
        <table>
          <tbody>
            <NamedResourcesPanel
              projectId="proj-1"
              rtId="rt-1"
              rtCount={1}
              columnCount={8}
              allocations={profileAllocations}
            />
          </tbody>
        </table>
      </QueryClientProvider>,
    )

    await waitFor(() => {
      expect(screen.getByDisplayValue('Alice')).toBeInTheDocument()
    })

    // Capacity profile: shows "Varies by week" for segmented profile (profile-managed)
    expect(screen.getByText('Varies by week')).toBeInTheDocument()
    // Source badge
    expect(screen.getByText('Squad Planner')).toBeInTheDocument()
    // Resolution source indicator
    expect(screen.getByText(/Resolution: Profile/)).toBeInTheDocument()
    // Each of three segments (displayed with 1-based week labels)
    expect(screen.getByText('W1-W4: 50%')).toBeInTheDocument()
    expect(screen.getByText('W5-W8: 75%')).toBeInTheDocument()
    expect(screen.getByText('W9-W12: 100%')).toBeInTheDocument()
    // Profile-managed guidance shown
    expect(screen.getByText(/Availability varies by week/)).toBeInTheDocument()
    expect(screen.getByText(/this weekly profile is protected/i)).toBeInTheDocument()

    // Billing basis label is separate from capacity profile
    const billingBasisElements = screen.getAllByText('Billing basis')
    expect(billingBasisElements.length).toBeGreaterThanOrEqual(1)
    // Actual assigned summary is present
    expect(screen.getByText(/W3-W7/)).toBeInTheDocument()

    // No "Planned resource" badge (this is a named person, not synthetic)
    expect(screen.queryByText('Planned resource')).not.toBeInTheDocument()

    // No default percent or window for profile-managed state
    expect(screen.queryByText(/Default:/)).not.toBeInTheDocument()
    expect(screen.queryByText(/Window:/)).not.toBeInTheDocument()
  })

  it('labels synthetic resources as Planned resource with Active capacity plan and disabled controls', async () => {
    const syntheticAllocations: ResourceProfileRow['namedResources'] = [
      {
        id: 'nr-synth-1',
        name: 'Generated Dev',
        allocationMode: 'EFFORT',
        allocationPercent: 100,
        allocationStartWeek: null,
        allocationEndWeek: null,
        startWeek: null,
        endWeek: null,
        allocatedDays: 0,
        derivedStartWeek: null,
        derivedEndWeek: null,
        actualAllocatedDays: 0,
        actualAllocationStartWeek: null,
        actualAllocationEndWeek: null,
        actualAllocatedWeeks: [],
        actualAllocationSegments: [],
        synthetic: true,
        capacityProfile: {
          planningBasis: 'demandFollowing',
          source: 'squadPlanner',
          defaultPercent: null,
          startWeek: null,
          endWeek: null,
          segments: [],
          resolutionSource: 'ACTIVE_CAPACITY_PLAN',
        },
      },
    ]

    api.get.mockResolvedValue({ data: [] })

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={queryClient}>
        <table>
          <tbody>
            <NamedResourcesPanel
              projectId="proj-1"
              rtId="rt-1"
              rtCount={1}
              columnCount={8}
              allocations={syntheticAllocations}
            />
          </tbody>
        </table>
      </QueryClientProvider>,
    )

    await waitFor(() => {
      expect(screen.getByDisplayValue('Generated Dev')).toBeInTheDocument()
    })

    // "Planned resource" badge visible
    expect(screen.getByText('Planned resource')).toBeInTheDocument()

    // Name input disabled (non-persisted)
    expect(screen.getByDisplayValue('Generated Dev')).toBeDisabled()

    // Resolution: Active capacity plan
    expect(screen.getByText(/Resolution: Active capacity plan/)).toBeInTheDocument()

    // Source badge visible
    expect(screen.getByText('Squad Planner')).toBeInTheDocument()

    // Delete button shows planned-resource message and is disabled
    expect(screen.getByTitle('Planned resources cannot be deleted')).toBeDisabled()
    expect(screen.queryByTitle('Delete')).not.toBeInTheDocument()
  })

  it('shows weekly profile guidance for a persisted planned resource', async () => {
    const plannedAllocation: ResourceProfileRow['namedResources'][number] = {
      ...MOCK_ALLOCATIONS[0],
      id: 'nr-persisted-profile',
      name: 'Planned Tech Lead',
      resourceIdentity: 'PLANNED_RESOURCE',
      synthetic: false,
      capacityProfile: {
        planningBasis: 'capacityProfile',
        source: 'squadPlanner',
        defaultPercent: null,
        startWeek: 0,
        endWeek: 8,
        segments: [
          { startWeek: 0, endWeek: 3, capacityPercent: 50 },
          { startWeek: 4, endWeek: 8, capacityPercent: 100 },
        ],
        resolutionSource: 'PROFILE',
      },
    }

    api.get.mockResolvedValue({
      data: [{
        id: 'nr-persisted-profile', resourceTypeId: 'rt-1', name: 'Planned Tech Lead',
        startWeek: null, endWeek: null, allocationPct: 100,
        pricingModel: 'ACTUAL_DAYS', createdAt: '', updatedAt: '',
      }],
    })

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={queryClient}>
        <table><tbody><NamedResourcesPanel
          projectId="proj-1" rtId="rt-1" rtCount={1} columnCount={8}
          allocations={[plannedAllocation]}
        /></tbody></table>
      </QueryClientProvider>,
    )

    await screen.findByDisplayValue('Planned Tech Lead')

    // The guidance is shown inline (no toggle button needed)
    expect(screen.getByText(/Availability varies by week/)).toBeInTheDocument()
    expect(screen.getByText(/managed through the weekly capacity plan/i)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Open Squad Planner/i })).toHaveAttribute(
      'href',
      '/projects/proj-1/timeline?panel=squad-planner',
    )
  })
})

describe('planned resource UI', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('persisted PLANNED_RESOURCE shows badge and disables all controls', async () => {
    const plannedAllocation: ResourceProfileRow['namedResources'][number] = {
      ...MOCK_ALLOCATIONS[0],
      id: 'nr-planned',
      name: 'Planned Person',
      resourceIdentity: 'PLANNED_RESOURCE',
      synthetic: false,
    }

    api.get.mockResolvedValue({
      data: [{ id: 'nr-planned', resourceTypeId: 'rt-1', name: 'Planned Person', startWeek: 0, endWeek: 9, allocationPct: 100, pricingModel: 'ACTUAL_DAYS', createdAt: '', updatedAt: '' }],
    })

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={queryClient}>
        <table>
          <tbody>
            <NamedResourcesPanel
              projectId="proj-1"
              rtId="rt-1"
              rtCount={2}
              columnCount={8}
              allocations={[plannedAllocation]}
            />
          </tbody>
        </table>
      </QueryClientProvider>,
    )

    await waitFor(() => {
      expect(screen.getByDisplayValue('Planned Person')).toBeInTheDocument()
    })

    // Badge visible
    expect(screen.getByText('Planned resource')).toBeInTheDocument()

    // Name input disabled
    const nameInput = screen.getByDisplayValue('Planned Person')
    expect(nameInput).toBeDisabled()

    // Delete button shows planned-resource tooltip and is disabled
    const deleteBtn = screen.getByTitle('Planned resources cannot be deleted')
    expect(deleteBtn).toBeDisabled()
  })

  it('persisted named person retains enabled controls', async () => {
    renderPanel()

    await waitFor(() => {
      expect(screen.getByDisplayValue('Developer 1')).toBeInTheDocument()
    })

    // No badge
    expect(screen.queryByText('Planned resource')).not.toBeInTheDocument()

    // Inputs enabled
    expect(screen.getByDisplayValue('Developer 1')).not.toBeDisabled()
  })

  it('generated planned resource (synthetic) shows badge and disabled controls', async () => {
    const synthAllocation: ResourceProfileRow['namedResources'][number] = {
      ...MOCK_ALLOCATIONS[0],
      id: 'nr-synth',
      name: 'Generated',
      synthetic: true,
      resourceIdentity: 'PLANNED_RESOURCE',
    }

    api.get.mockResolvedValue({ data: [] })

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={queryClient}>
        <table>
          <tbody>
            <NamedResourcesPanel
              projectId="proj-1"
              rtId="rt-1"
              rtCount={2}
              columnCount={8}
              allocations={[synthAllocation]}
            />
          </tbody>
        </table>
      </QueryClientProvider>,
    )

    await waitFor(() => {
      expect(screen.getByDisplayValue('Generated')).toBeInTheDocument()
    })

    // Badge visible
    expect(screen.getByText('Planned resource')).toBeInTheDocument()

    // Name input disabled
    expect(screen.getByDisplayValue('Generated')).toBeDisabled()

    // Delete disabled
    expect(screen.getByTitle('Planned resources cannot be deleted')).toBeDisabled()
  })

  it('mixed named-person and planned-resource rows do not cross identity', async () => {
    const personAllocation: ResourceProfileRow['namedResources'][number] = {
      ...MOCK_ALLOCATIONS[0],
      id: 'nr-person',
      name: 'Actual Person',
      synthetic: false,
    }
    const plannedAllocation: ResourceProfileRow['namedResources'][number] = {
      ...MOCK_ALLOCATIONS[1],
      id: 'nr-planned-2',
      name: 'Planned Resource',
      resourceIdentity: 'PLANNED_RESOURCE',
      synthetic: false,
    }

    api.get.mockResolvedValue({
      data: [
        { id: 'nr-person', resourceTypeId: 'rt-1', name: 'Actual Person', startWeek: 0, endWeek: 9, allocationPct: 100, pricingModel: 'ACTUAL_DAYS', createdAt: '', updatedAt: '' },
        { id: 'nr-planned-2', resourceTypeId: 'rt-1', name: 'Planned Resource', startWeek: 0, endWeek: 9, allocationPct: 100, pricingModel: 'ACTUAL_DAYS', createdAt: '', updatedAt: '' },
      ],
    })

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={queryClient}>
        <table>
          <tbody>
            <NamedResourcesPanel
              projectId="proj-1"
              rtId="rt-1"
              rtCount={2}
              columnCount={8}
              allocations={[personAllocation, plannedAllocation]}
            />
          </tbody>
        </table>
      </QueryClientProvider>,
    )

    await waitFor(() => {
      expect(screen.getByDisplayValue('Actual Person')).toBeInTheDocument()
    })

    // Planned resource badge IS visible (for the planned row)
    expect(screen.getByText('Planned resource')).toBeInTheDocument()

    // Planned resource has disabled controls
    expect(screen.getByDisplayValue('Planned Resource')).toBeDisabled()

    // Named person has enabled controls
    expect(screen.getByDisplayValue('Actual Person')).not.toBeDisabled()
  })
})
