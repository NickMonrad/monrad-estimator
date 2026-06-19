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
})
