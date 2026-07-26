import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import NamedResourcesPanel from '@/components/resource-profile/NamedResourcesPanel'

const { mockGet, mockPut } = vi.hoisted(() => ({ mockGet: vi.fn(), mockPut: vi.fn() }))

vi.mock('@/lib/api', () => ({
  api: {
    get: mockGet,
    put: mockPut,
    post: vi.fn(),
    delete: vi.fn(),
  },
}))

const persistedResource = {
  id: 'nr-1', resourceTypeId: 'rt-1', name: 'Alex', startWeek: 1, endWeek: 4,
  allocationPct: 70, pricingModel: 'ACTUAL_DAYS', createdAt: '', updatedAt: '',
}

function allocation(overrides: Record<string, unknown> = {}) {
  return {
    id: 'nr-1', name: 'Alex', resourceIdentity: 'NAMED_PERSON', synthetic: false,
    allocationMode: 'TIMELINE', allocationPercent: 70, allocationStartWeek: 1, allocationEndWeek: 4,
    startWeek: 1, endWeek: 4, pricingModel: 'ACTUAL_DAYS', assignedWeeks: [],
    ...overrides,
  }
}

function renderPanel(allocations = [allocation()], resources = [persistedResource]) {
  mockGet.mockResolvedValue({ data: resources })
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <table><tbody><NamedResourcesPanel projectId="project-1" rtId="rt-1" rtCount={1} columnCount={8} allocations={allocations as never} /></tbody></table>
    </QueryClientProvider>,
  )
}

const scalarProfile = {
  id: 'cp-1', ownerKind: 'NAMED_PERSON', ownerId: 'nr-1', source: 'manual', resolutionSource: 'PROFILE',
  planningBasis: 'availabilityWindow', defaultPercent: 75, startWeek: 2, endWeek: 5,
  segments: [], projectDurationWeeks: 12,
}

const segmentedProfile = {
  ...scalarProfile, planningBasis: 'capacityProfile', defaultPercent: null, startWeek: null, endWeek: null,
  segments: [
    { id: 'seg-1', startWeek: 0, endWeek: 2, capacityPercent: 60 },
    { id: 'seg-2', startWeek: 4, endWeek: 6, capacityPercent: 85 },
  ],
}

describe('NamedResourcesPanel first-class profile access', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPut.mockResolvedValue({ data: {} })
  })

  it('opens a legacy-only named person in create mode with effective values', async () => {
    renderPanel()

    fireEvent.click(await screen.findByTestId('named-resource-profile-action-nr-1'))

    expect(screen.getByRole('heading', { name: 'Create Capacity Profile' })).toBeInTheDocument()
    expect(screen.getByTestId('cp-planning-basis-select')).toHaveValue('availabilityWindow')
    expect(screen.getByTestId('cp-default-pct-input')).toHaveValue(70)
    expect(screen.getByTestId('cp-start-week-input')).toHaveValue(1)
    expect(screen.getByTestId('cp-end-week-input')).toHaveValue(4)
  })

  it('opens a manual scalar named-person profile in edit mode', async () => {
    renderPanel([allocation({ capacityProfile: scalarProfile })])

    fireEvent.click(await screen.findByRole('button', { name: 'Edit profile' }))

    expect(screen.getByRole('heading', { name: 'Edit Capacity Profile' })).toBeInTheDocument()
    expect(screen.getByTestId('cp-default-pct-input')).toHaveValue(75)
    expect(screen.getByTestId('cp-start-week-input')).toHaveValue(2)
  })

  it('opens a manual segmented named-person profile in edit mode', async () => {
    renderPanel([allocation({ capacityProfile: segmentedProfile })])

    fireEvent.click(await screen.findByRole('button', { name: 'Edit profile' }))

    expect(screen.getByRole('heading', { name: 'Edit Capacity Profile' })).toBeInTheDocument()
    expect(screen.getByTestId('cp-seg-pct-0')).toHaveValue(60)
    expect(screen.getByTestId('cp-seg-start-1')).toHaveValue(4)
    expect(screen.getByTestId('cp-seg-end-1')).toHaveValue(6)
  })

  it('keeps planned resources read-only with a Squad Planner link', async () => {
    renderPanel([
      allocation({ id: 'planned-1', name: 'Planned Alex', resourceIdentity: 'PLANNED_RESOURCE', synthetic: true }),
    ], [])

    expect(await screen.findByRole('link', { name: 'Open Squad Planner' })).toHaveAttribute('href', '/projects/project-1/timeline?panel=squad-planner')
    expect(screen.queryByRole('button', { name: /profile/i })).not.toBeInTheDocument()
  })

  it('keeps Squad Planner-owned profiles read-only with a Squad Planner link', async () => {
    renderPanel([allocation({ capacityProfile: { ...scalarProfile, source: 'squadPlanner' } })])

    expect(await screen.findByRole('link', { name: 'Open Squad Planner' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Edit profile' })).not.toBeInTheDocument()
  })

  it('closes the modal after a successful save', async () => {
    renderPanel()
    fireEvent.click(await screen.findByRole('button', { name: 'Create profile' }))

    fireEvent.click(screen.getByTestId('cp-save-btn'))

    await waitFor(() => expect(mockPut).toHaveBeenCalledWith(
      '/projects/project-1/capacity-profiles/NAMED_PERSON/nr-1',
      expect.objectContaining({ planningBasis: 'AVAILABILITY_WINDOW', defaultPercent: 70, startWeek: 1, endWeek: 4 }),
    ))
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Create Capacity Profile' })).not.toBeInTheDocument())
  })

  it('preserves the modal and edited draft after a failed save', async () => {
    mockPut.mockRejectedValue({ response: { data: { error: 'Save failed' } } })
    renderPanel()
    fireEvent.click(await screen.findByRole('button', { name: 'Create profile' }))
    fireEvent.change(screen.getByTestId('cp-default-pct-input'), { target: { value: '82.5' } })

    fireEvent.click(screen.getByTestId('cp-save-btn'))

    expect(await screen.findByText('Save failed')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Create Capacity Profile' })).toBeInTheDocument()
    expect(screen.getByTestId('cp-default-pct-input')).toHaveValue(82.5)
  })
})
