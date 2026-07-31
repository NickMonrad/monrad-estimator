import React, { type ComponentProps } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const { mockNavigate } = vi.hoisted(() => ({ mockNavigate: vi.fn() }))

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom')
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  }
})
import ResourceProfileTab from '@/components/resource-profile/ResourceProfileTab'

function createTestQueryClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } })
}

/** Wrap in MemoryRouter and QueryClientProvider for routing and React Query support. */
function renderWithProviders(ui: React.ReactElement) {
  const qc = createTestQueryClient()
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  )
}

function createProps(
  count: number,
  overrides: Partial<ComponentProps<typeof ResourceProfileTab>> = {},
): ComponentProps<typeof ResourceProfileTab> {
  const removeMutate = vi.fn()
  const addMutate = vi.fn()
  const updateResourceTypeMutate = vi.fn()

  return {
    projectId: 'project-1',
    profile: {
      projectId: 'project-1',
      hoursPerDay: 8,
      projectDurationWeeks: 0,
      bufferWeeks: 0,
      onboardingWeeks: 0,
      resourceRows: [{
        resourceTypeId: 'rt-security',
        name: 'Security Consultant',
        category: 'GOVERNANCE',
        count,
        hoursPerDay: 8,
        dayRate: 1200,
        totalHours: 0,
        totalDays: 0,
        effortDays: 0,
        allocatedDays: 0,
        allocationMode: 'EFFORT',
        allocationPercent: 100,
        allocationStartWeek: null,
        allocationEndWeek: null,
        derivedStartWeek: null,
        derivedEndWeek: null,
        estimatedCost: null,
        epics: [],
        namedResources: [],
      }],
      overheadRows: [],
      summary: {
        totalHours: 0,
        totalDays: 0,
        totalCost: null,
        hasCost: false,
      },
    },
    profileLoading: false,
    overheadItems: [],
    resourceTypes: [],
    filteredResourceRows: [{
      resourceTypeId: 'rt-security',
      name: 'Security Consultant',
      category: 'GOVERNANCE',
      count,
      hoursPerDay: 8,
      dayRate: 1200,
      totalHours: 0,
      totalDays: 0,
      effortDays: 0,
      allocatedDays: 0,
      allocationMode: 'EFFORT',
      allocationPercent: 100,
      allocationStartWeek: null,
      allocationEndWeek: null,
      derivedStartWeek: null,
      derivedEndWeek: null,
      estimatedCost: null,
      epics: [],
      namedResources: [],
    }],
    hasCost: false,
    columnCount: 8,
    chartData: [],
    expandedRows: new Set(),
    expandedNamedResources: new Set(),
    editingId: null,
    form: {
      name: '',
      resourceTypeId: '',
      type: 'PERCENTAGE',
      value: '',
    },
    setForm: vi.fn(),
    formError: null,
    profileMutationError: null,
    clearProfileMutationError: vi.fn(),
    bufferWeeks: 0,
    onboardingWeeks: 0,
    toggleRow: vi.fn(),
    toggleNamedResources: vi.fn(),
    resetForm: vi.fn(),
    handleFormSubmit: vi.fn(),
    handleEdit: vi.fn(),
    handleDelete: vi.fn(),
    updateResourceType: { mutate: updateResourceTypeMutate } as never,
    addPerson: { mutate: addMutate } as never,
    removeLastPerson: { mutate: removeMutate } as never,
    createOverhead: { isPending: false } as never,
    updateOverhead: { isPending: false } as never,
    weekToDate: vi.fn(() => null),
    fmtDate: vi.fn(() => ''),
    formatNumber: (value: number, fractionDigits = 2) => value.toFixed(fractionDigits),
    editingAllocation: null,
    setEditingAllocation: vi.fn(),
    allocationDraft: null,
    setAllocationDraft: vi.fn(),
    updateAllocationMutation: { isPending: false, mutate: vi.fn() } as never,
    updateNrAllocationMutation: { isPending: false, mutate: vi.fn() } as never,
    startEditAllocation: vi.fn(),
    getAllocationBadge: () => ({ label: 'As needed', color: 'bg-gray-100 text-gray-600', sub: null }),
    qc: new QueryClient(),
    ...overrides,
  }
}

describe('ResourceProfileTab', () => {
  it('surfaces a planner-managed identity conflict from count/add/remove mutations (#403 finding 4)', () => {
    const clearProfileMutationError = vi.fn()
    renderWithProviders(<ResourceProfileTab
      {...createProps(1, {
        profileMutationError: 'Resource type "Developer" is managed by Squad Planner. Switch to manual capacity before changing its resources.',
        clearProfileMutationError,
      })}
    />)

    const alert = screen.getByRole('alert')
    expect(alert.textContent).toContain('Switch to manual capacity')
    fireEvent.click(screen.getByRole('button', { name: /dismiss/i }))
    expect(clearProfileMutationError).toHaveBeenCalled()
  })

  it('allows removing the final named resource when count is 1', () => {
    const removeMutate = vi.fn()

    renderWithProviders(<ResourceProfileTab {...createProps(1, { removeLastPerson: { mutate: removeMutate } as never })} />)

    const removeButton = screen.getByTitle('Remove person')
    expect(removeButton).toBeEnabled()

    fireEvent.click(removeButton)

    expect(removeMutate).toHaveBeenCalledWith('rt-security')
  })

  it('disables removal only when the count is already zero', () => {
    renderWithProviders(<ResourceProfileTab {...createProps(0)} />)

    expect(screen.getByTitle('Remove person')).toBeDisabled()
  })

  it('shows named resource assignment summaries on the role row', () => {
    renderWithProviders(<ResourceProfileTab
      {...createProps(1, {
        profile: {
          projectId: 'project-1',
          hoursPerDay: 8,
          projectDurationWeeks: 0,
          bufferWeeks: 0,
          onboardingWeeks: 0,
          resourceRows: [{
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
            allocationPercent: 100,
            allocationStartWeek: null,
            allocationEndWeek: null,
            derivedStartWeek: null,
            derivedEndWeek: null,
            estimatedCost: null,
            epics: [],
            namedResources: [{
              id: 'nr-1',
              name: 'Alex',
              allocationMode: 'EFFORT',
              allocationPercent: 100,
              allocationStartWeek: null,
              allocationEndWeek: null,
              startWeek: null,
              endWeek: null,
              allocatedDays: 0,
              derivedStartWeek: null,
              derivedEndWeek: null,
              actualAllocatedDays: 2.5,
              actualAllocationStartWeek: 2,
              actualAllocationEndWeek: 3,
              actualAllocatedWeeks: [
                { week: 2, days: 1.5, capacityDays: 5 },
                { week: 3, days: 1, capacityDays: 5 },
              ],
              actualAllocationSegments: [
                { startWeek: 2, endWeek: 3, days: 2.5 },
              ],
              synthetic: false,
            }],
          }],
          overheadRows: [],
          summary: {
            totalHours: 0,
            totalDays: 0,
            totalCost: null,
            hasCost: false,
          },
        },
        filteredResourceRows: [{
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
          allocationPercent: 100,
          allocationStartWeek: null,
          allocationEndWeek: null,
          derivedStartWeek: null,
          derivedEndWeek: null,
          estimatedCost: null,
          epics: [],
          namedResources: [{
            id: 'nr-1',
            name: 'Alex',
            allocationMode: 'EFFORT',
            allocationPercent: 100,
            allocationStartWeek: null,
            allocationEndWeek: null,
            startWeek: null,
            endWeek: null,
            allocatedDays: 0,
            derivedStartWeek: null,
            derivedEndWeek: null,
            actualAllocatedDays: 2.5,
            actualAllocationStartWeek: 2,
            actualAllocationEndWeek: 3,
            actualAllocatedWeeks: [
              { week: 2, days: 1.5, capacityDays: 5 },
              { week: 3, days: 1, capacityDays: 5 },
            ],
            actualAllocationSegments: [
              { startWeek: 2, endWeek: 3, days: 2.5 },
            ],
            synthetic: false,
          }],
        }],
      })}
    />,)

    expect(screen.getByText('Assigned: Alex W3-W4')).toBeInTheDocument()
  })



})

describe('ResourceProfileTab Planning Context', () => {
  it('shows Planning Context heading with read-only values', () => {
    renderWithProviders(<ResourceProfileTab {...createProps(1, {
      onboardingWeeks: 3,
      bufferWeeks: 2,
    })} />)

    expect(screen.getByText('Planning Context')).toBeInTheDocument()
    expect(screen.getByText('3')).toBeInTheDocument()
    expect(screen.getByText('2')).toBeInTheDocument()
    expect(screen.getAllByText('Set in Timeline → Planning Settings')).toHaveLength(2)
  })
  it('does not show editable Project Duration section with inputs and save', () => {
    renderWithProviders(<ResourceProfileTab {...createProps(1)} />)

    expect(screen.queryByText('Project Duration')).not.toBeInTheDocument()
    expect(screen.queryByText('Weeks at project start for team onboarding (added to period)')).not.toBeInTheDocument()
    expect(screen.queryByText('Extra weeks added to project end date for contingency')).not.toBeInTheDocument()
    expect(screen.queryByText('Onboarding Weeks')).toBeInTheDocument()
    expect(screen.queryByText('Buffer Weeks')).toBeInTheDocument()
  })
})

describe('Capacity Profile labels — availability terminology', () => {
  it('shows Resource Profile heading and capacity profile help text', () => {
    renderWithProviders(<ResourceProfileTab {...createProps(1)} />)
    expect(screen.getByText('Capacity profile summary')).toBeInTheDocument()
    // Help text: the <strong> element contains "Capacity profiles"
    expect(screen.getByText('Capacity profiles')).toBeInTheDocument()
    // "availability patterns" appears in the subtitle
    expect(screen.getByText(/availability patterns/i)).toBeInTheDocument()
  })

  it('shows resource identity as Role-level capacity when no named resources exist', () => {
    renderWithProviders(<ResourceProfileTab {...createProps(1)} />)
    expect(screen.getByText('Role-level capacity')).toBeInTheDocument()
  })

  it('shows resource identity as Named person when named resources are non-synthetic', () => {
    renderWithProviders(<ResourceProfileTab {...createProps(1, {
      profile: {
        projectId: 'p', hoursPerDay: 8, projectDurationWeeks: 0,
        bufferWeeks: 0, onboardingWeeks: 0,
        resourceRows: [{
          resourceTypeId: 'rt', name: 'Dev', category: 'ENG', count: 1,
          hoursPerDay: 8, dayRate: 800, totalHours: 40, totalDays: 5,
          effortDays: 5, allocatedDays: 5, allocationMode: 'EFFORT',
          allocationPercent: 100, allocationStartWeek: null, allocationEndWeek: null,
          derivedStartWeek: null, derivedEndWeek: null, estimatedCost: null,
          epics: [], namedResources: [{
            id: 'nr1', name: 'Alice', allocationMode: 'EFFORT',
            allocationPercent: 100, allocationStartWeek: null, allocationEndWeek: null,
            startWeek: null, endWeek: null, allocatedDays: 5,
            derivedStartWeek: null, derivedEndWeek: null,
            actualAllocatedDays: 0, actualAllocationStartWeek: null, actualAllocationEndWeek: null,
            actualAllocatedWeeks: [], actualAllocationSegments: [],
            synthetic: false,
          }],
        }],
        overheadRows: [],
        summary: { totalHours: 0, totalDays: 0, totalCost: null, hasCost: false },
      },
      filteredResourceRows: [{
        resourceTypeId: 'rt', name: 'Dev', category: 'ENG', count: 1,
        hoursPerDay: 8, dayRate: 800, totalHours: 40, totalDays: 5,
        effortDays: 5, allocatedDays: 5, allocationMode: 'EFFORT',
        allocationPercent: 100, allocationStartWeek: null, allocationEndWeek: null,
        derivedStartWeek: null, derivedEndWeek: null, estimatedCost: null,
        epics: [], namedResources: [{
          id: 'nr1', name: 'Alice', allocationMode: 'EFFORT',
          allocationPercent: 100, allocationStartWeek: null, allocationEndWeek: null,
          startWeek: null, endWeek: null, allocatedDays: 5,
          derivedStartWeek: null, derivedEndWeek: null,
          actualAllocatedDays: 0, actualAllocationStartWeek: null, actualAllocationEndWeek: null,
          actualAllocatedWeeks: [], actualAllocationSegments: [],
          synthetic: false,
        }],
      }],
    })} />)
    expect(screen.getByText('Named person')).toBeInTheDocument()
  })

  it('shows resource identity as Planned resource when all named resources are synthetic', () => {
    renderWithProviders(<ResourceProfileTab {...createProps(1, {
      profile: {
        projectId: 'p', hoursPerDay: 8, projectDurationWeeks: 0,
        bufferWeeks: 0, onboardingWeeks: 0,
        resourceRows: [{
          resourceTypeId: 'rt', name: 'Planned Dev', category: 'ENG', count: 1,
          hoursPerDay: 8, dayRate: 800, totalHours: 40, totalDays: 5,
          effortDays: 5, allocatedDays: 5, allocationMode: 'EFFORT',
          allocationPercent: 100, allocationStartWeek: null, allocationEndWeek: null,
          derivedStartWeek: null, derivedEndWeek: null, estimatedCost: null,
          epics: [], namedResources: [{
            id: 'nr1', name: 'Planned Dev', allocationMode: 'EFFORT',
            allocationPercent: 100, allocationStartWeek: null, allocationEndWeek: null,
            startWeek: null, endWeek: null, allocatedDays: 5,
            derivedStartWeek: null, derivedEndWeek: null,
            actualAllocatedDays: 0, actualAllocationStartWeek: null, actualAllocationEndWeek: null,
            actualAllocatedWeeks: [], actualAllocationSegments: [],
            synthetic: true,
          }],
        }],
        overheadRows: [],
        summary: { totalHours: 0, totalDays: 0, totalCost: null, hasCost: false },
      },
      filteredResourceRows: [{
        resourceTypeId: 'rt', name: 'Planned Dev', category: 'ENG', count: 1,
        hoursPerDay: 8, dayRate: 800, totalHours: 40, totalDays: 5,
        effortDays: 5, allocatedDays: 5, allocationMode: 'EFFORT',
        allocationPercent: 100, allocationStartWeek: null, allocationEndWeek: null,
        derivedStartWeek: null, derivedEndWeek: null, estimatedCost: null,
        epics: [], namedResources: [{
          id: 'nr1', name: 'Planned Dev', allocationMode: 'EFFORT',
          allocationPercent: 100, allocationStartWeek: null, allocationEndWeek: null,
          startWeek: null, endWeek: null, allocatedDays: 5,
          derivedStartWeek: null, derivedEndWeek: null,
          actualAllocatedDays: 0, actualAllocationStartWeek: null, actualAllocationEndWeek: null,
          actualAllocatedWeeks: [], actualAllocationSegments: [],
          synthetic: true,
        }],
      }],
    })} />)
    expect(screen.getByText('Planned resource')).toBeInTheDocument()
  })

  it('shows As needed badge by default (EFFORT)', () => {
    renderWithProviders(<ResourceProfileTab {...createProps(1)} />)
    expect(screen.getByText(/As needed/i)).toBeInTheDocument()
  })

  it('rejects forbidden internal terms in the Resource Profile UI', () => {
    renderWithProviders(<ResourceProfileTab {...createProps(1)} />)
    const forbidden = [
      'Capacity Plan', 'Timeline allocation', 'Full Project',
      'SyntheticSlot', 'Allocation mode', 'ActualAllocatedDays',
      'PricingModel', 'Capacity Plan',
    ]
    for (const term of forbidden) {
      expect(screen.queryByText(term, { exact: false })).toBeNull()
    }
  })

  it('shows Fixed for selected weeks badge for TIMELINE allocation mode', () => {
    renderWithProviders(<ResourceProfileTab {...createProps(1, {
      profile: {
        projectId: 'p', hoursPerDay: 8, projectDurationWeeks: 0,
        bufferWeeks: 0, onboardingWeeks: 0,
        resourceRows: [{
          resourceTypeId: 'rt', name: 'Dev', category: 'ENG', count: 1,
          hoursPerDay: 8, dayRate: 800, totalHours: 40, totalDays: 5,
          effortDays: 5, allocatedDays: 5, allocationMode: 'TIMELINE',
          allocationPercent: 100, allocationStartWeek: 1, allocationEndWeek: 10,
          derivedStartWeek: 0, derivedEndWeek: 12, estimatedCost: null,
          epics: [], namedResources: [],
        }],
        overheadRows: [],
        summary: { totalHours: 0, totalDays: 0, totalCost: null, hasCost: false },
      },
      filteredResourceRows: [{
        resourceTypeId: 'rt', name: 'Dev', category: 'ENG', count: 1,
        hoursPerDay: 8, dayRate: 800, totalHours: 40, totalDays: 5,
        effortDays: 5, allocatedDays: 5, allocationMode: 'TIMELINE',
        allocationPercent: 100, allocationStartWeek: 1, allocationEndWeek: 10,
        derivedStartWeek: 0, derivedEndWeek: 12, estimatedCost: null,
        epics: [], namedResources: [],
      }],
    })} />)
    expect(screen.getByText(/Fixed for selected weeks · 100%/)).toBeInTheDocument()
  })

  it('shows Fixed for whole project badge for FULL_PROJECT mode with percent', () => {
    renderWithProviders(<ResourceProfileTab {...createProps(1, {
      profile: {
        projectId: 'p', hoursPerDay: 8, projectDurationWeeks: 10,
        bufferWeeks: 0, onboardingWeeks: 0,
        resourceRows: [{
          resourceTypeId: 'rt', name: 'Dev', category: 'ENG', count: 1,
          hoursPerDay: 8, dayRate: 800, totalHours: 40, totalDays: 5,
          effortDays: 5, allocatedDays: 5, allocationMode: 'FULL_PROJECT',
          allocationPercent: 75, allocationStartWeek: null, allocationEndWeek: null,
          derivedStartWeek: 0, derivedEndWeek: 10, estimatedCost: null,
          epics: [], namedResources: [],
        }],
        overheadRows: [],
        summary: { totalHours: 0, totalDays: 0, totalCost: null, hasCost: false },
      },
      filteredResourceRows: [{
        resourceTypeId: 'rt', name: 'Dev', category: 'ENG', count: 1,
        hoursPerDay: 8, dayRate: 800, totalHours: 40, totalDays: 5,
        effortDays: 5, allocatedDays: 5, allocationMode: 'FULL_PROJECT',
        allocationPercent: 75, allocationStartWeek: null, allocationEndWeek: null,
        derivedStartWeek: 0, derivedEndWeek: 10, estimatedCost: null,
        epics: [], namedResources: [],
      }],
    })} />)
    expect(screen.getByText(/Fixed for whole project · 75%/)).toBeInTheDocument()
  })
})



  it('shows Availability pattern table heading on the column', () => {
    renderWithProviders(<ResourceProfileTab {...createProps(1)} />)
    const thElements = document.querySelectorAll('th')
    const heading = Array.from(thElements).find(th => th.textContent === 'Availability pattern')
    expect(heading).toBeTruthy()
  })




describe('Overhead type options', () => {
  it('shows all three overhead type options', () => {
    renderWithProviders(<ResourceProfileTab {...createProps(1)} />)
    expect(screen.getByText('% of task days')).toBeInTheDocument()
    expect(screen.getByText('Fixed total days')).toBeInTheDocument()
    expect(screen.getByText('Days per week')).toBeInTheDocument()
  })

  it('selecting % of task days sets form.type to PERCENTAGE', () => {
    const setForm = vi.fn()
    renderWithProviders(<ResourceProfileTab {...createProps(1, {
      editingId: 'overhead-1',
      form: { name: 'Test', resourceTypeId: '', type: 'FIXED_DAYS' as const, value: '10' },
      setForm,
    })} />)
    fireEvent.click(screen.getByText('% of task days'))
    expect(setForm).toHaveBeenCalled()
    const updater = setForm.mock.calls[0][0]
    expect(updater({ type: 'FIXED_DAYS' })).toMatchObject({ type: 'PERCENTAGE' })
  })

  it('overhead can be created with percentage type', () => {
    const createOverheadMutate = vi.fn()
    const handleFormSubmit = vi.fn(() => {
      createOverheadMutate({ name: 'Test', type: 'PERCENTAGE', value: 20 })
    })
    renderWithProviders(<ResourceProfileTab {...createProps(1, {
      form: { name: 'Test', resourceTypeId: '', type: 'PERCENTAGE' as const, value: '20' },
      handleFormSubmit,
      createOverhead: { isPending: false, mutate: createOverheadMutate } as never,
    })} />)
    fireEvent.click(screen.getByRole('button', { name: 'Add overhead' }))
    expect(handleFormSubmit).toHaveBeenCalled()
    expect(createOverheadMutate).toHaveBeenCalledWith(expect.objectContaining({ type: 'PERCENTAGE' }))
  })
})

