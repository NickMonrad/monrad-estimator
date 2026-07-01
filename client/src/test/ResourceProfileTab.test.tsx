import React, { type ComponentProps } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import ResourceProfileTab from '@/components/resource-profile/ResourceProfileTab'

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
    getAllocationBadge: () => ({ label: 'Demand-following', color: 'bg-gray-100 text-gray-600', sub: null }),
    ...overrides,
  }
}

describe('ResourceProfileTab', () => {
  it('allows removing the final named resource when count is 1', () => {
    const removeMutate = vi.fn()

    render(<ResourceProfileTab {...createProps(1, { removeLastPerson: { mutate: removeMutate } as never })} />)

    const removeButton = screen.getByTitle('Remove person')
    expect(removeButton).toBeEnabled()

    fireEvent.click(removeButton)

    expect(removeMutate).toHaveBeenCalledWith('rt-security')
  })

  it('disables removal only when the count is already zero', () => {
    render(<ResourceProfileTab {...createProps(0)} />)

    expect(screen.getByTitle('Remove person')).toBeDisabled()
  })

  it('shows named resource assignment summaries on the role row', () => {
    render(
      <ResourceProfileTab
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
      />,
    )

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

    const { container } = render(<ResourceProfileTab {...props} />)
    const badge = container.querySelector('button[title="Click to edit allocation"]')
    expect(badge).toBeTruthy()

    // Click to open editor
    fireEvent.click(badge!)
    expect(setEditingAllocation).toHaveBeenCalledWith('rt-dev')
    expect(setAllocationDraft).toHaveBeenCalledWith({
      allocationMode: 'TIMELINE',
      allocationPercent: 100,
      allocationStartWeek: null,
      allocationEndWeek: null,
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

    const { container } = render(<ResourceProfileTab {...props} />)
    // The inline editor should be visible with allocation mode dropdown
    const select = container.querySelector('select')
    expect(select).toBeTruthy()
    expect(select?.querySelector('option[value="EFFORT"]')).toBeTruthy()
    expect(select?.querySelector('option[value="TIMELINE"]')).toBeTruthy()
    expect(select?.querySelector('option[value="FULL_PROJECT"]')).toBeTruthy()
    expect(select?.querySelector('option[value="CAPACITY_PLAN"]')).toBeTruthy()
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

    const { container } = render(<ResourceProfileTab {...props} />)
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
    render(<ResourceProfileTab {...createProps(1, {
      onboardingWeeks: 3,
      bufferWeeks: 2,
    })} />)

    expect(screen.getByText('Planning Context')).toBeInTheDocument()
    expect(screen.getByText('3')).toBeInTheDocument()
    expect(screen.getByText('2')).toBeInTheDocument()
    expect(screen.getAllByText('Set in Timeline → Planning Settings')).toHaveLength(2)
  })
  it('does not show editable Project Duration section with inputs and save', () => {
    render(<ResourceProfileTab {...createProps(1)} />)

    expect(screen.queryByText('Project Duration')).not.toBeInTheDocument()
    expect(screen.queryByText('Weeks at project start for team onboarding (added to period)')).not.toBeInTheDocument()
    expect(screen.queryByText('Extra weeks added to project end date for contingency')).not.toBeInTheDocument()
    expect(screen.queryByText('Onboarding Weeks')).toBeInTheDocument()
    expect(screen.queryByText('Buffer Weeks')).toBeInTheDocument()
  })
})

describe('Capacity Profile labels', () => {
  it('shows Resource Profile heading and capacity profile help text', () => {
    render(<ResourceProfileTab {...createProps(1)} />)
    expect(screen.getByText('Resource Profile')).toBeInTheDocument()
    // Help text: the <strong> element contains "Capacity profiles"
    expect(screen.getByText('Capacity profiles')).toBeInTheDocument()
    // "Planning basis" appears in both subtitle and column header
    expect(screen.getAllByText(/planning basis/i)).toHaveLength(2)
  })

  it('shows resource identity as Role-level capacity when no named resources exist', () => {
    render(<ResourceProfileTab {...createProps(1)} />)
    expect(screen.getByText('Role-level capacity')).toBeInTheDocument()
  })

  it('shows resource identity as Named person when named resources are non-synthetic', () => {
    render(<ResourceProfileTab {...createProps(1, {
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
    render(<ResourceProfileTab {...createProps(1, {
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

  it('shows Demand-following planning basis badge by default', () => {
    render(<ResourceProfileTab {...createProps(1)} />)
    expect(screen.getByText(/Demand-following/i)).toBeInTheDocument()
  })

  it('rejects forbidden internal terms in the Resource Profile UI', () => {
    render(<ResourceProfileTab {...createProps(1)} />)
    const forbidden = [
      'Capacity Plan', 'Timeline allocation', 'Full Project',
      'SyntheticSlot', 'Allocation mode', 'ActualAllocatedDays',
      'PricingModel', 'Capacity Plan',
    ]
    for (const term of forbidden) {
      expect(screen.queryByText(term, { exact: false })).toBeNull()
    }
  })

  it('shows Availability window badge for TIMELINE allocation mode', () => {
    render(<ResourceProfileTab {...createProps(1, {
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
    expect(screen.getByText(/Availability window · 100%/)).toBeInTheDocument()
  })

  it('shows Whole-project allocation badge for FULL_PROJECT mode with percent', () => {
    render(<ResourceProfileTab {...createProps(1, {
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
    expect(screen.getByText(/Whole-project allocation · 75%/)).toBeInTheDocument()
  })
})
