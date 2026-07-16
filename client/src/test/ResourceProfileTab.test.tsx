import React, { type ComponentProps } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

const { mockNavigate } = vi.hoisted(() => ({ mockNavigate: vi.fn() }))

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom')
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  }
})
import ResourceProfileTab from '@/components/resource-profile/ResourceProfileTab'

/** Wrap in MemoryRouter for useNavigate support. */
function renderWithRouter(ui: React.ReactElement) {
  return render(<MemoryRouter>{ui}</MemoryRouter>)
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
    ...overrides,
  }
}

describe('ResourceProfileTab', () => {
  it('allows removing the final named resource when count is 1', () => {
    const removeMutate = vi.fn()

    renderWithRouter(<ResourceProfileTab {...createProps(1, { removeLastPerson: { mutate: removeMutate } as never })} />)

    const removeButton = screen.getByTitle('Remove person')
    expect(removeButton).toBeEnabled()

    fireEvent.click(removeButton)

    expect(removeMutate).toHaveBeenCalledWith('rt-security')
  })

  it('disables removal only when the count is already zero', () => {
    renderWithRouter(<ResourceProfileTab {...createProps(0)} />)

    expect(screen.getByTitle('Remove person')).toBeDisabled()
  })

  it('shows named resource assignment summaries on the role row', () => {
    renderWithRouter(<ResourceProfileTab
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

  it('shows allocation editor when clicking the allocation badge', () => {
    const setEditingAllocation = vi.fn()
    const setAllocationDraft = vi.fn()
    const updateAllocationMutate = vi.fn()
    const props = createProps(1, {
      profile: {
        resourceRows: [
          {
            resourceTypeId: 'rt-dev',
            name: 'Developer',
            count: 1,
            hoursPerDay: 8,
            totalHours: 80,
            totalDays: 10,
            effortDays: 10,
            allocatedDays: 10,
            allocationMode: 'TIMELINE' as const,
            allocationPercent: 100,
            allocationStartWeek: null,
            allocationEndWeek: null,
            derivedStartWeek: 0,
            derivedEndWeek: 10,
            dayRate: 500,
            category: 'ENGINEERING',
            estimatedCost: 5000,
            namedResources: [],
            epics: [],
          } as any,
        ],
        overheadRows: [],
        summary: { totalHours: 80, totalDays: 10, totalCost: 5000, hasCost: true },
        projectDurationWeeks: 12,
        hoursPerDay: 8,
        bufferWeeks: 0,
        onboardingWeeks: 0,
        projectId: 'project-1',
      } as any,
      filteredResourceRows: [
        {
          resourceTypeId: 'rt-dev',
          name: 'Developer',
          category: 'ENGINEERING',
          count: 1,
          hoursPerDay: 8,
          dayRate: 500,
          totalHours: 80,
          totalDays: 10,
          effortDays: 10,
          allocatedDays: 10,
          allocationMode: 'TIMELINE',
          allocationPercent: 100,
          allocationStartWeek: null,
          allocationEndWeek: null,
          derivedStartWeek: 0,
          derivedEndWeek: 10,
          estimatedCost: 5000,
          epics: [],
          namedResources: [],
        },
      ],
      editingAllocation: null,
      setEditingAllocation,
      setAllocationDraft,
      updateAllocationMutation: { isPending: false, mutate: updateAllocationMutate } as never,
    })

    const { container } = renderWithRouter(<ResourceProfileTab {...props} />)
    const badge = container.querySelector('button[title="Click to edit allocation"]')
    expect(badge).toBeTruthy()

    // Click to open editor
    fireEvent.click(badge!)
    expect(setEditingAllocation).toHaveBeenCalledWith('rt-dev')
    expect(setAllocationDraft).toHaveBeenCalledWith({
      allocationMode: 'TIMELINE',
      allocationPercent: 100,
      allocationStartWeek: 0,
      allocationEndWeek: 10,
    })
  })

  it('shows allocation mode options in the editor', () => {
    const props = createProps(1, {
      profile: {
        resourceRows: [
          {
            resourceTypeId: 'rt-dev',
            name: 'Developer',
            count: 1,
            hoursPerDay: 8,
            totalHours: 80,
            totalDays: 10,
            effortDays: 10,
            allocatedDays: 10,
            allocationMode: 'EFFORT' as const,
            allocationPercent: 100,
            allocationStartWeek: null,
            allocationEndWeek: null,
            derivedStartWeek: null,
            derivedEndWeek: null,
            dayRate: 500,
            category: 'ENGINEERING',
            estimatedCost: 5000,
            namedResources: [],
            epics: [],
          } as any,
        ],
        overheadRows: [],
        summary: { totalHours: 80, totalDays: 10, totalCost: 5000, hasCost: true },
        projectDurationWeeks: 12,
        hoursPerDay: 8,
        bufferWeeks: 0,
        onboardingWeeks: 0,
        projectId: 'project-1',
      } as any,
      filteredResourceRows: [
        {
          resourceTypeId: 'rt-dev',
          name: 'Developer',
          category: 'ENGINEERING',
          count: 1,
          hoursPerDay: 8,
          dayRate: 500,
          totalHours: 80,
          totalDays: 10,
          effortDays: 10,
          allocatedDays: 10,
          allocationMode: 'TIMELINE',
          allocationPercent: 100,
          allocationStartWeek: null,
          allocationEndWeek: null,
          derivedStartWeek: 0,
          derivedEndWeek: 10,
          estimatedCost: 5000,
          epics: [],
          namedResources: [],
        },
      ],
      editingAllocation: 'rt-dev',
      allocationDraft: {
        allocationMode: 'EFFORT',
        allocationPercent: 100,
        allocationStartWeek: null,
        allocationEndWeek: null,
      },
      updateAllocationMutation: { isPending: false, mutate: vi.fn() } as never,
    })

    const { container } = renderWithRouter(<ResourceProfileTab {...props} />)
    // The inline editor should be visible with allocation mode dropdown
    const select = container.querySelector('select')
    expect(select).toBeTruthy()
    expect(select?.querySelector('option[value="EFFORT"]')).toBeTruthy()
    expect(select?.querySelector('option[value="TIMELINE"]')).toBeTruthy()
    expect(select?.querySelector('option[value="FULL_PROJECT"]')).toBeTruthy()
    // CAPACITY_PLAN is profile-managed — not offered in the generic editor
    expect(select?.querySelector('option[value="CAPACITY_PLAN"]')).toBeFalsy()
  })

  it('saves allocation changes when clicking Save', () => {
    const updateAllocationMutate = vi.fn()
    const props = createProps(1, {
      profile: {
        resourceRows: [
          {
            resourceTypeId: 'rt-dev',
            name: 'Developer',
            count: 1,
            hoursPerDay: 8,
            totalHours: 80,
            totalDays: 10,
            effortDays: 10,
            allocatedDays: 10,
            allocationMode: 'EFFORT' as const,
            allocationPercent: 100,
            allocationStartWeek: null,
            allocationEndWeek: null,
            derivedStartWeek: null,
            derivedEndWeek: null,
            dayRate: 500,
            category: 'ENGINEERING',
            estimatedCost: 5000,
            namedResources: [],
            epics: [],
          } as any,
        ],
        overheadRows: [],
        summary: { totalHours: 80, totalDays: 10, totalCost: 5000, hasCost: true },
        projectDurationWeeks: 12,
        hoursPerDay: 8,
        bufferWeeks: 0,
        onboardingWeeks: 0,
        projectId: 'project-1',
      } as any,
      filteredResourceRows: [
        {
          resourceTypeId: 'rt-dev',
          name: 'Developer',
          category: 'ENGINEERING',
          count: 1,
          hoursPerDay: 8,
          dayRate: 500,
          totalHours: 80,
          totalDays: 10,
          effortDays: 10,
          allocatedDays: 10,
          allocationMode: 'TIMELINE',
          allocationPercent: 100,
          allocationStartWeek: null,
          allocationEndWeek: null,
          derivedStartWeek: 0,
          derivedEndWeek: 10,
          estimatedCost: 5000,
          epics: [],
          namedResources: [],
        },
      ],
      editingAllocation: 'rt-dev',
      allocationDraft: {
        allocationMode: 'TIMELINE',
        allocationPercent: 75,
        allocationStartWeek: null,
        allocationEndWeek: null,
      },
      updateAllocationMutation: { isPending: false, mutate: updateAllocationMutate } as never,
    })

    const { container } = renderWithRouter(<ResourceProfileTab {...props} />)
    // Find the Save button in the editor
    const allButtons = container.querySelectorAll('button')
    const saveBtn = Array.from(allButtons).find(b => b.textContent === 'Save')
    expect(saveBtn).toBeTruthy()
    fireEvent.click(saveBtn!)
    expect(updateAllocationMutate).toHaveBeenCalledWith({
      rtId: 'rt-dev',
      data: {
        allocationMode: 'TIMELINE',
        allocationPercent: 75,
        allocationStartWeek: null,
        allocationEndWeek: null,
      },
    }, { onSuccess: expect.any(Function) })
  })
})

describe('ResourceProfileTab Planning Context', () => {
  it('shows Planning Context heading with read-only values', () => {
    renderWithRouter(<ResourceProfileTab {...createProps(1, {
      onboardingWeeks: 3,
      bufferWeeks: 2,
    })} />)

    expect(screen.getByText('Planning Context')).toBeInTheDocument()
    expect(screen.getByText('3')).toBeInTheDocument()
    expect(screen.getByText('2')).toBeInTheDocument()
    expect(screen.getAllByText('Set in Timeline → Planning Settings')).toHaveLength(2)
  })
  it('does not show editable Project Duration section with inputs and save', () => {
    renderWithRouter(<ResourceProfileTab {...createProps(1)} />)

    expect(screen.queryByText('Project Duration')).not.toBeInTheDocument()
    expect(screen.queryByText('Weeks at project start for team onboarding (added to period)')).not.toBeInTheDocument()
    expect(screen.queryByText('Extra weeks added to project end date for contingency')).not.toBeInTheDocument()
    expect(screen.queryByText('Onboarding Weeks')).toBeInTheDocument()
    expect(screen.queryByText('Buffer Weeks')).toBeInTheDocument()
  })
})

describe('Capacity Profile labels — availability terminology', () => {
  it('shows Resource Profile heading and capacity profile help text', () => {
    renderWithRouter(<ResourceProfileTab {...createProps(1)} />)
    expect(screen.getByText('Capacity profile summary')).toBeInTheDocument()
    // Help text: the <strong> element contains "Capacity profiles"
    expect(screen.getByText('Capacity profiles')).toBeInTheDocument()
    // "availability patterns" appears in the subtitle
    expect(screen.getByText(/availability patterns/i)).toBeInTheDocument()
  })

  it('shows resource identity as Role-level capacity when no named resources exist', () => {
    renderWithRouter(<ResourceProfileTab {...createProps(1)} />)
    expect(screen.getByText('Role-level capacity')).toBeInTheDocument()
  })

  it('shows resource identity as Named person when named resources are non-synthetic', () => {
    renderWithRouter(<ResourceProfileTab {...createProps(1, {
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
    renderWithRouter(<ResourceProfileTab {...createProps(1, {
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
    renderWithRouter(<ResourceProfileTab {...createProps(1)} />)
    expect(screen.getByText(/As needed/i)).toBeInTheDocument()
  })

  it('rejects forbidden internal terms in the Resource Profile UI', () => {
    renderWithRouter(<ResourceProfileTab {...createProps(1)} />)
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
    renderWithRouter(<ResourceProfileTab {...createProps(1, {
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
    renderWithRouter(<ResourceProfileTab {...createProps(1, {
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
  it('uses authoritative capacity profile when allocationMode is stale EFFORT', () => {
    const setEditingAllocation = vi.fn()
    const setAllocationDraft = vi.fn()
    const updateAllocationMutate = vi.fn()
    const capacityProfile = {
      resolutionSource: 'PROFILE' as const,
      planningBasis: 'capacityProfile' as const,
      source: 'squadPlanner' as const,
      defaultPercent: null,
      startWeek: null,
      endWeek: null,
      segments: [
        { startWeek: 2, endWeek: 4, capacityPercent: 80 },
        { startWeek: 5, endWeek: 8, capacityPercent: 100 },
      ],
    }
    const rowOverrides = {
      profile: {
        projectId: 'p', hoursPerDay: 8, projectDurationWeeks: 10,
        bufferWeeks: 0, onboardingWeeks: 0,
        resourceRows: [{
          resourceTypeId: 'rt-dev', name: 'Developer', category: 'ENG', count: 1,
          hoursPerDay: 8, dayRate: 500, totalHours: 80, totalDays: 10,
          effortDays: 10, allocatedDays: 10, allocationMode: 'EFFORT' as const,
          allocationPercent: 100, allocationStartWeek: null, allocationEndWeek: null,
          derivedStartWeek: null, derivedEndWeek: null, estimatedCost: 5000,
          epics: [], namedResources: [],
          capacityProfile,
        }],
        overheadRows: [],
        summary: { totalHours: 80, totalDays: 10, totalCost: 5000, hasCost: true },
      },
      filteredResourceRows: [{
        resourceTypeId: 'rt-dev', name: 'Developer', category: 'ENG', count: 1,
        hoursPerDay: 8, dayRate: 500, totalHours: 80, totalDays: 10,
        effortDays: 10, allocatedDays: 10, allocationMode: 'EFFORT' as const,
        allocationPercent: 100, allocationStartWeek: null, allocationEndWeek: null,
        derivedStartWeek: null, derivedEndWeek: null, estimatedCost: 5000,
        epics: [], namedResources: [],
        capacityProfile,
      }],
      setEditingAllocation,
      setAllocationDraft,
      updateAllocationMutation: { isPending: false, mutate: updateAllocationMutate } as never,
    }
    // Part 1: render with editor closed — verify badge and click override
    const { container } = renderWithRouter(<ResourceProfileTab {...createProps(1, rowOverrides)} />)
    const badge = container.querySelector('button[title="Click to edit allocation"]')
    expect(badge).toBeTruthy()
    expect(badge!.textContent).toBe('Varies by week')
    expect(badge!.textContent).not.toMatch(/%/)
    expect(badge!.className).toContain('bg-green-100')
    expect(badge!.className).toContain('text-green-700')
    fireEvent.click(badge!)
    expect(setEditingAllocation).toHaveBeenCalledWith('rt-dev')
    expect(setAllocationDraft).toHaveBeenCalledWith({
      allocationMode: 'CAPACITY_PLAN',
      allocationPercent: 100,
      allocationStartWeek: null,
      allocationEndWeek: null,
    })
    expect(updateAllocationMutate).not.toHaveBeenCalled()
    // Part 2: re-render with editor open — verify info panel
    const { container: c2 } = renderWithRouter(<ResourceProfileTab {...createProps(1, {
      ...rowOverrides,
      editingAllocation: 'rt-dev',
      allocationDraft: {
        allocationMode: 'CAPACITY_PLAN' as const,
        allocationPercent: 100,
        allocationStartWeek: null,
        allocationEndWeek: null,
      },
    })} />)
    expect(screen.getByText(/managed through the weekly capacity profile/i)).toBeInTheDocument()
    expect(screen.getByText(/Open weekly profile editor/i)).toBeInTheDocument()
    // No generic allocation-mode select (overhead resource-type select may exist)
    expect(c2.querySelector('select[aria-label="Availability pattern"]')).toBeNull()
    expect(screen.queryByText('Save')).toBeNull()
  })
})

  it('shows Varies by week badge for CAPACITY_PLAN without percentage suffix', () => {
    renderWithRouter(<ResourceProfileTab {...createProps(1, {
      profile: {
        projectId: 'p', hoursPerDay: 8, projectDurationWeeks: 10,
        bufferWeeks: 0, onboardingWeeks: 0,
        resourceRows: [{
          resourceTypeId: 'rt', name: 'Dev', category: 'ENG', count: 1,
          hoursPerDay: 8, dayRate: 800, totalHours: 40, totalDays: 5,
          effortDays: 5, allocatedDays: 5, allocationMode: 'CAPACITY_PLAN' as const,
          allocationPercent: 100, allocationStartWeek: null, allocationEndWeek: null,
          derivedStartWeek: null, derivedEndWeek: null, estimatedCost: null,
          epics: [], namedResources: [],
        }],
        overheadRows: [],
        summary: { totalHours: 0, totalDays: 0, totalCost: null, hasCost: false },
      },
      filteredResourceRows: [{
        resourceTypeId: 'rt', name: 'Dev', category: 'ENG', count: 1,
        hoursPerDay: 8, dayRate: 800, totalHours: 40, totalDays: 5,
        effortDays: 5, allocatedDays: 5, allocationMode: 'CAPACITY_PLAN' as const,
        allocationPercent: 100, allocationStartWeek: null, allocationEndWeek: null,
        derivedStartWeek: null, derivedEndWeek: null, estimatedCost: null,
        epics: [], namedResources: [],
      }],
    })} />)
    const badge = screen.getByTitle('Click to edit allocation')
    expect(badge).toBeInTheDocument()
    // CAPACITY_PLAN must NOT show a percentage suffix
    expect(badge.textContent).not.toMatch(/%/)
  })

  it('shows info panel when opening editor on CAPACITY_PLAN row', () => {
    const props = createProps(1, {
      profile: {
        projectId: 'p', hoursPerDay: 8, projectDurationWeeks: 10,
        bufferWeeks: 0, onboardingWeeks: 0,
        resourceRows: [{
          resourceTypeId: 'rt-dev', name: 'Developer', category: 'ENG', count: 1,
          hoursPerDay: 8, dayRate: 500, totalHours: 80, totalDays: 10,
          effortDays: 10, allocatedDays: 10, allocationMode: 'CAPACITY_PLAN' as const,
          allocationPercent: 100, allocationStartWeek: null, allocationEndWeek: null,
          derivedStartWeek: null, derivedEndWeek: null, estimatedCost: 5000,
          epics: [], namedResources: [],
        }],
        overheadRows: [],
        summary: { totalHours: 80, totalDays: 10, totalCost: 5000, hasCost: true },
      },
      filteredResourceRows: [{
        resourceTypeId: 'rt-dev', name: 'Developer', category: 'ENG', count: 1,
        hoursPerDay: 8, dayRate: 500, totalHours: 80, totalDays: 10,
        effortDays: 10, allocatedDays: 10, allocationMode: 'CAPACITY_PLAN' as const,
        allocationPercent: 100, allocationStartWeek: null, allocationEndWeek: null,
        derivedStartWeek: null, derivedEndWeek: null, estimatedCost: 5000,
        epics: [], namedResources: [],
      }],
      editingAllocation: 'rt-dev',
      allocationDraft: {
        allocationMode: 'CAPACITY_PLAN' as const,
        allocationPercent: 100,
        allocationStartWeek: null,
        allocationEndWeek: null,
      },
    })
    renderWithRouter(<ResourceProfileTab {...props} />)
    // The info panel should show — look for the profile-managed message
    expect(screen.getByText(/managed through the weekly capacity profile/i)).toBeInTheDocument()
    // Navigation button should be present
    expect(screen.getByText(/Open weekly profile editor/i)).toBeInTheDocument()
    // Click it and verify navigation to squad planner panel
    fireEvent.click(screen.getByText(/Open weekly profile editor/i))
    expect(mockNavigate).toHaveBeenCalledWith('/projects/project-1/timeline?panel=squad-planner')
    // No Save button (CAPACITY_PLAN can't be saved from generic editor)
    expect(screen.queryByText('Save')).toBeNull()
  })

  it('shows Availability pattern table heading on the column', () => {
    renderWithRouter(<ResourceProfileTab {...createProps(1)} />)
    const thElements = document.querySelectorAll('th')
    const heading = Array.from(thElements).find(th => th.textContent === 'Availability pattern')
    expect(heading).toBeTruthy()
  })

  it('cancel closes editor without persisting changes', () => {
    const setEdit = vi.fn()
    const setDraft = vi.fn()
    const props = createProps(1, {
      profile: {
        projectId: 'p', hoursPerDay: 8, projectDurationWeeks: 10,
        bufferWeeks: 0, onboardingWeeks: 0,
        resourceRows: [{
          resourceTypeId: 'rt-dev', name: 'Developer', category: 'ENG', count: 1,
          hoursPerDay: 8, dayRate: 500, totalHours: 80, totalDays: 10,
          effortDays: 10, allocatedDays: 10, allocationMode: 'EFFORT' as const,
          allocationPercent: 100, allocationStartWeek: null, allocationEndWeek: null,
          derivedStartWeek: null, derivedEndWeek: null, estimatedCost: 5000,
          epics: [], namedResources: [],
        }],
        overheadRows: [],
        summary: { totalHours: 80, totalDays: 10, totalCost: 5000, hasCost: true },
      },
      filteredResourceRows: [{
        resourceTypeId: 'rt-dev', name: 'Developer', category: 'ENG', count: 1,
        hoursPerDay: 8, dayRate: 500, totalHours: 80, totalDays: 10,
        effortDays: 10, allocatedDays: 10, allocationMode: 'EFFORT' as const,
        allocationPercent: 100, allocationStartWeek: null, allocationEndWeek: null,
        derivedStartWeek: null, derivedEndWeek: null, estimatedCost: 5000,
        epics: [], namedResources: [],
      }],
      editingAllocation: 'rt-dev',
      allocationDraft: {
        allocationMode: 'EFFORT' as const,
        allocationPercent: 100,
        allocationStartWeek: null,
        allocationEndWeek: null,
      },
      setEditingAllocation: setEdit,
      setAllocationDraft: setDraft,
    })
    const { container } = renderWithRouter(<ResourceProfileTab {...props} />)
    const cancelBtn = Array.from(container.querySelectorAll('button')).find(b => b.textContent === 'Cancel')
    expect(cancelBtn).toBeTruthy()
    fireEvent.click(cancelBtn!)
    expect(setEdit).toHaveBeenCalledWith(null)
    expect(setDraft).toHaveBeenCalledWith(null)
  })

  it('mode change normalisation clears stale start/end weeks', () => {
    const setDraft = vi.fn()
    const props = createProps(1, {
      profile: {
        projectId: 'p', hoursPerDay: 8, projectDurationWeeks: 10,
        bufferWeeks: 0, onboardingWeeks: 0,
        resourceRows: [{
          resourceTypeId: 'rt-dev', name: 'Developer', category: 'ENG', count: 1,
          hoursPerDay: 8, dayRate: 500, totalHours: 80, totalDays: 10,
          effortDays: 10, allocatedDays: 10, allocationMode: 'TIMELINE' as const,
          allocationPercent: 75, allocationStartWeek: 2, allocationEndWeek: 8,
          derivedStartWeek: 0, derivedEndWeek: 10, estimatedCost: 5000,
          epics: [], namedResources: [],
        }],
        overheadRows: [],
        summary: { totalHours: 80, totalDays: 10, totalCost: 5000, hasCost: true },
      },
      filteredResourceRows: [{
        resourceTypeId: 'rt-dev', name: 'Developer', category: 'ENG', count: 1,
        hoursPerDay: 8, dayRate: 500, totalHours: 80, totalDays: 10,
        effortDays: 10, allocatedDays: 10, allocationMode: 'TIMELINE' as const,
        allocationPercent: 75, allocationStartWeek: 2, allocationEndWeek: 8,
        derivedStartWeek: 0, derivedEndWeek: 10, estimatedCost: 5000,
        epics: [], namedResources: [],
      }],
      editingAllocation: 'rt-dev',
      allocationDraft: {
        allocationMode: 'TIMELINE' as const,
        allocationPercent: 75,
        allocationStartWeek: 2,
        allocationEndWeek: 8,
      },
      setAllocationDraft: setDraft,
    })
    const { container } = renderWithRouter(<ResourceProfileTab {...props} />)
    const select = container.querySelector('select')
    expect(select).toBeTruthy()
    // Change from TIMELINE to FULL_PROJECT — start/end should be cleared in the next render
    // (test checks that the mode-change handler clears them; the actual state update
    // is via setDraft which we can verify indirectly)
    fireEvent.change(select!, { target: { value: 'FULL_PROJECT' } })
    expect(setDraft).toHaveBeenCalled()
    const callback = setDraft.mock.calls[0][0]
    const result = callback({ allocationMode: 'TIMELINE', allocationPercent: 75, allocationStartWeek: 2, allocationEndWeek: 8 })
    expect(result.allocationMode).toBe('FULL_PROJECT')
    expect(result.allocationStartWeek).toBeNull()
    expect(result.allocationEndWeek).toBeNull()
    expect(result.allocationPercent).toBe(75)
  })


describe('Overhead type options', () => {
  it('shows all three overhead type options', () => {
    renderWithRouter(<ResourceProfileTab {...createProps(1)} />)
    expect(screen.getByText('% of task days')).toBeInTheDocument()
    expect(screen.getByText('Fixed total days')).toBeInTheDocument()
    expect(screen.getByText('Days per week')).toBeInTheDocument()
  })

  it('selecting % of task days sets form.type to PERCENTAGE', () => {
    const setForm = vi.fn()
    renderWithRouter(<ResourceProfileTab {...createProps(1, {
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
    renderWithRouter(<ResourceProfileTab {...createProps(1, {
      form: { name: 'Test', resourceTypeId: '', type: 'PERCENTAGE' as const, value: '20' },
      handleFormSubmit,
      createOverhead: { isPending: false, mutate: createOverheadMutate } as never,
    })} />)
    fireEvent.click(screen.getByRole('button', { name: 'Add overhead' }))
    expect(handleFormSubmit).toHaveBeenCalled()
    expect(createOverheadMutate).toHaveBeenCalledWith(expect.objectContaining({ type: 'PERCENTAGE' }))
  })
})

describe('Responsive layout', () => {
  it('Availability pattern select has minimum width of 7rem', () => {
    const props = createProps(1, {
      editingAllocation: 'rt-security',
      allocationDraft: { allocationMode: 'TIMELINE' as const, allocationPercent: 100, allocationStartWeek: null, allocationEndWeek: null },
    })
    const { container } = renderWithRouter(<ResourceProfileTab {...props} />)
    const select = container.querySelector('select[aria-label="Availability pattern"]')
    expect(select).toBeTruthy()
    expect(select!.className).toContain('min-w-[7rem]')
  })

  it('info panel navigation button is visible and reachable', () => {
    const props = createProps(1, {
      editingAllocation: 'rt-security',
      allocationDraft: { allocationMode: 'CAPACITY_PLAN' as const, allocationPercent: 100, allocationStartWeek: null, allocationEndWeek: null },
    })
    renderWithRouter(<ResourceProfileTab {...props} />)
    const navButton = screen.getByText(/Open weekly profile editor/)
    expect(navButton).toBeInTheDocument()
    expect(navButton.className).not.toContain('overflow-hidden')
    expect(navButton.className).not.toContain('invisible')
  })
})
