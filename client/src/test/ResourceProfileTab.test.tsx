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
    setBufferWeeks: vi.fn(),
    onboardingWeeks: 0,
    setOnboardingWeeks: vi.fn(),
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
    saveBufferOnboarding: vi.fn(),
    editingAllocation: null,
    setEditingAllocation: vi.fn(),
    allocationDraft: null,
    setAllocationDraft: vi.fn(),
    updateAllocationMutation: { isPending: false, mutate: vi.fn() } as never,
    updateNrAllocationMutation: { isPending: false, mutate: vi.fn() } as never,
    startEditAllocation: vi.fn(),
    getAllocationBadge: (row: any) => ({ label: 'T&M', color: 'bg-gray-100 text-gray-600', sub: null }),
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
    const saveButton = container.querySelector('button')
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
    })
  })
})
