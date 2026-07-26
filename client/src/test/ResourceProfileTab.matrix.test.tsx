import React, { type ComponentProps } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import ResourceProfileTab from '@/components/resource-profile/ResourceProfileTab'

const { mockNavigate } = vi.hoisted(() => ({ mockNavigate: vi.fn() }))

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom')
  return { ...actual, useNavigate: () => mockNavigate }
})

function renderTab(props: ComponentProps<typeof ResourceProfileTab>) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter><ResourceProfileTab {...props} /></MemoryRouter>
    </QueryClientProvider>,
  )
}

function roleRow(overrides: Record<string, unknown> = {}) {
  return {
    resourceTypeId: 'rt-security',
    name: 'Security Consultant',
    category: 'GOVERNANCE',
    count: 1,
    hoursPerDay: 8,
    dayRate: 1200,
    totalHours: 0,
    totalDays: 0,
    effortDays: 0,
    allocatedDays: 0,
    allocationMode: 'EFFORT',
    allocationPercent: 65,
    allocationStartWeek: null,
    allocationEndWeek: null,
    derivedStartWeek: null,
    derivedEndWeek: null,
    estimatedCost: null,
    epics: [],
    namedResources: [],
    ...overrides,
  }
}

function createProps(rowOverrides: Record<string, unknown> = {}): ComponentProps<typeof ResourceProfileTab> {
  const row = roleRow(rowOverrides)
  return {
    projectId: 'project-1',
    profile: {
      projectId: 'project-1', hoursPerDay: 8, projectDurationWeeks: 12, bufferWeeks: 0, onboardingWeeks: 0,
      resourceRows: [row], overheadRows: [],
      summary: { totalHours: 0, totalDays: 0, totalCost: null, hasCost: false },
    } as never,
    profileLoading: false,
    overheadItems: [],
    resourceTypes: [],
    filteredResourceRows: [row] as never,
    hasCost: false,
    columnCount: 8,
    chartData: [],
    expandedRows: new Set(),
    expandedNamedResources: new Set(),
    editingId: null,
    form: { name: '', resourceTypeId: '', type: 'PERCENTAGE', value: '' },
    setForm: vi.fn(),
    formError: null,
    bufferWeeks: 0,
    onboardingWeeks: 0,
    toggleRow: vi.fn(),
    toggleNamedResources: vi.fn(),
    resetForm: vi.fn(),
    handleFormSubmit: vi.fn(),
    handleEdit: vi.fn(),
    handleDelete: vi.fn(),
    updateResourceType: { mutate: vi.fn() } as never,
    addPerson: { mutate: vi.fn() } as never,
    removeLastPerson: { mutate: vi.fn() } as never,
    createOverhead: { isPending: false } as never,
    updateOverhead: { isPending: false } as never,
    weekToDate: vi.fn(() => null),
    fmtDate: vi.fn(() => ''),
    formatNumber: (value: number, digits = 2) => value.toFixed(digits),
    editingAllocation: null,
    setEditingAllocation: vi.fn(),
    allocationDraft: null,
    setAllocationDraft: vi.fn(),
    updateAllocationMutation: { isPending: false, mutate: vi.fn() } as never,
    updateNrAllocationMutation: { isPending: false, mutate: vi.fn() } as never,
    startEditAllocation: vi.fn(),
    getAllocationBadge: () => ({ label: 'As needed', color: 'bg-gray-100 text-gray-600', sub: null }),
  }
}

const manualScalarProfile = {
  id: 'cp-role', ownerKind: 'ROLE', ownerId: 'rt-security', source: 'manual',
  resolutionSource: 'PROFILE', planningBasis: 'wholeProjectAllocation', defaultPercent: 72.5,
  startWeek: null, endWeek: null, segments: [], projectDurationWeeks: 12,
}

const manualSegmentedProfile = {
  ...manualScalarProfile,
  planningBasis: 'capacityProfile', defaultPercent: null,
  segments: [
    { id: 'seg-1', startWeek: 0, endWeek: 2, capacityPercent: 50 },
    { id: 'seg-2', startWeek: 4, endWeek: 6, capacityPercent: 80 },
  ],
}

describe('ResourceProfileTab first-class ROLE profile access', () => {
  it('opens a legacy-only ROLE in create mode with effective compatibility values', () => {
    renderTab(createProps())

    fireEvent.click(screen.getByTitle('Click to edit capacity profile'))

    expect(screen.getByRole('heading', { name: 'Create Capacity Profile' })).toBeInTheDocument()
    expect(screen.getByTestId('cp-planning-basis-select')).toHaveValue('demandFollowing')
    expect(screen.getByTestId('cp-default-pct-input')).toHaveValue(65)
  })

  it('opens a manual scalar ROLE in edit mode', () => {
    renderTab(createProps({ capacityProfile: manualScalarProfile }))

    fireEvent.click(screen.getByTitle('Click to edit capacity profile'))

    expect(screen.getByRole('heading', { name: 'Edit Capacity Profile' })).toBeInTheDocument()
    expect(screen.getByTestId('cp-planning-basis-select')).toHaveValue('wholeProjectAllocation')
    expect(screen.getByTestId('cp-default-pct-input')).toHaveValue(72.5)
  })

  it('opens a manual segmented ROLE in edit mode with exact segments', () => {
    renderTab(createProps({ capacityProfile: manualSegmentedProfile }))

    fireEvent.click(screen.getByTitle('Click to edit capacity profile'))

    expect(screen.getByRole('heading', { name: 'Edit Capacity Profile' })).toBeInTheDocument()
    expect(screen.getByTestId('cp-seg-start-0')).toHaveValue(0)
    expect(screen.getByTestId('cp-seg-end-0')).toHaveValue(2)
    expect(screen.getByTestId('cp-seg-pct-1')).toHaveValue(80)
  })

  it('remains editable when named resources exist', () => {
    renderTab(createProps({ namedResources: [{ id: 'nr-1', name: 'Alex' }] }))

    expect(screen.getByTitle('Click to edit capacity profile')).toBeEnabled()
    fireEvent.click(screen.getByTitle('Click to edit capacity profile'))
    expect(screen.getByRole('heading', { name: 'Create Capacity Profile' })).toBeInTheDocument()
  })

  it('routes only Squad Planner profiles to Squad Planner', () => {
    renderTab(createProps({ capacityProfile: { ...manualScalarProfile, source: 'squadPlanner' } }))

    fireEvent.click(screen.getByRole('button', { name: 'Open Squad Planner' }))

    expect(mockNavigate).toHaveBeenCalledWith('/projects/project-1/timeline?panel=squad-planner')
    expect(screen.queryByRole('heading', { name: /Capacity Profile/ })).not.toBeInTheDocument()
  })
})
