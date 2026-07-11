import React, { type ComponentProps } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import ResourceProfileTab from '@/components/resource-profile/ResourceProfileTab'

function createProps(
  overrides: Partial<ComponentProps<typeof ResourceProfileTab>> = {},
): ComponentProps<typeof ResourceProfileTab> {
  return {
    projectId: 'project-1',
    profile: {
      projectId: 'project-1',
      hoursPerDay: 8,
      projectDurationWeeks: 12,
      bufferWeeks: 0,
      onboardingWeeks: 0,
      resourceRows: [],
      overheadRows: [],
      summary: { totalHours: 0, totalDays: 0, totalCost: null, hasCost: false },
    },
    profileLoading: false,
    overheadItems: [],
    resourceTypes: [],
    filteredResourceRows: [],
    hasCost: false,
    columnCount: 8,
    chartData: [],
    expandedRows: new Set(),
    expandedNamedResources: new Set(),
    editingId: null,
    form: { name: '', resourceTypeId: '', type: 'PERCENTAGE' as const, value: '' },
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

const baseRow = {
  resourceTypeId: 'rt-dev',
  name: 'Developer',
  category: 'ENGINEERING',
  count: 1,
  hoursPerDay: 8,
  dayRate: 800,
  totalHours: 80,
  totalDays: 10,
  effortDays: 10,
  allocatedDays: 10,
  allocationMode: 'EFFORT',
  allocationPercent: 100,
  allocationStartWeek: null,
  allocationEndWeek: null,
  derivedStartWeek: null,
  derivedEndWeek: null,
  estimatedCost: null,
  epics: [],
}

describe('Capacity Profile Display', () => {
  it('renders planning basis from capacityProfile when authoritative, not stale allocationMode', () => {
    const row = {
      ...baseRow,
      allocationMode: 'TIMELINE' as const,
      allocationPercent: 100,
      capacityProfile: {
        planningBasis: 'demandFollowing',
        source: 'squadPlanner',
        defaultPercent: 50,
        startWeek: null,
        endWeek: null,
        segments: [],
        resolutionSource: 'PROFILE',
      },
    }
    render(
      <ResourceProfileTab
        {...createProps({
          profile: {
            projectId: 'project-1',
            hoursPerDay: 8,
            projectDurationWeeks: 12,
            bufferWeeks: 0,
            onboardingWeeks: 0,
            resourceRows: [row],
            overheadRows: [],
            summary: { totalHours: 80, totalDays: 10, totalCost: null, hasCost: false },
          },
          filteredResourceRows: [row],
        })}
      />,
    )

    // Badge should show 'Demand-following' from profile, not 'Availability window' from stale allocationMode
    expect(screen.getByText(/Demand-following/i)).toBeInTheDocument()
    // Button title is the stable action label
    const button = screen.getByTitle('Click to edit allocation')
    expect(button).toBeInTheDocument()
    // Source tag should indicate Squad Planner (formatted via shared helper)
    expect(screen.getByText('Squad Planner')).toBeInTheDocument()
    // SR-only metadata present with formatted source and resolution
    expect(screen.getByText(/Profile source:/)).toBeInTheDocument()
    expect(screen.getByText(/Resolution source:/)).toBeInTheDocument()
  })

  it('renders profile source tag when resolutionSource is PROFILE', () => {
    const row = {
      ...baseRow,
      capacityProfile: {
        planningBasis: 'demandFollowing',
        source: 'squadPlanner',
        defaultPercent: null,
        startWeek: null,
        endWeek: null,
        segments: [],
        resolutionSource: 'PROFILE',
      },
    }
    render(
      <ResourceProfileTab
        {...createProps({
          profile: {
            projectId: 'project-1',
            hoursPerDay: 8,
            projectDurationWeeks: 12,
            bufferWeeks: 0,
            onboardingWeeks: 0,
            resourceRows: [row],
            overheadRows: [],
            summary: { totalHours: 80, totalDays: 10, totalCost: null, hasCost: false },
          },
          filteredResourceRows: [row],
        })}
      />,
    )

    // The source tag badge shows 'Squad Planner' (formatted via shared helper)
    expect(screen.getByText('Squad Planner')).toBeInTheDocument()
    // The source tag uses aria-describedby for screen-reader metadata
    const sourceTag = screen.getByText('Squad Planner')
    expect(sourceTag).toHaveAttribute('aria-describedby')
    expect(sourceTag.closest('span')).toHaveClass('uppercase')
    // SR-only span contains formatted resolution source
    expect(screen.getByText(/Resolution source: Profile/)).toBeInTheDocument()
    // Button has stable title
    expect(screen.getByTitle('Click to edit allocation')).toBeInTheDocument()
  })

  it('renders capacity segments correctly', () => {
    const row = {
      ...baseRow,
      capacityProfile: {
        planningBasis: 'availabilityWindow',
        source: 'fixed',
        defaultPercent: 100,
        startWeek: 0,
        endWeek: 11,
        segments: [
          { startWeek: 0, endWeek: 3, capacityPercent: 50 },
          { startWeek: 4, endWeek: 7, capacityPercent: 75 },
          { startWeek: 8, endWeek: 11, capacityPercent: 100 },
        ],
        resolutionSource: 'PROFILE',
      },
    }
    render(
      <ResourceProfileTab
        {...createProps({
          profile: {
            projectId: 'project-1',
            hoursPerDay: 8,
            projectDurationWeeks: 12,
            bufferWeeks: 0,
            onboardingWeeks: 0,
            resourceRows: [row],
            overheadRows: [],
            summary: { totalHours: 80, totalDays: 10, totalCost: null, hasCost: false },
          },
          filteredResourceRows: [row],
        })}
      />,
    )

    // Segment labels display: W1-W4: 50% · W5-W8: 75% · W9-W12: 100%
    expect(screen.getByText('W1-W4: 50%')).toBeInTheDocument()
    expect(screen.getByText('W5-W8: 75%')).toBeInTheDocument()
    expect(screen.getByText('W9-W12: 100%')).toBeInTheDocument()
  })

  it('renders one named resource row when a named resource has a multi-segment capacityProfile', () => {
    const row = {
      ...baseRow,
      namedResources: [
        {
          id: 'nr-1',
          name: 'Alice',
          allocationMode: 'EFFORT',
          allocationPercent: 100,
          allocationStartWeek: null,
          allocationEndWeek: null,
          startWeek: null,
          endWeek: null,
          allocatedDays: 5,
          derivedStartWeek: null,
          derivedEndWeek: null,
          actualAllocatedDays: 3,
          actualAllocationStartWeek: 2,
          actualAllocationEndWeek: 4,
          actualAllocatedWeeks: [
            { week: 2, days: 1.5, capacityDays: 5 },
            { week: 3, days: 1, capacityDays: 5 },
            { week: 4, days: 0.5, capacityDays: 5 },
          ],
          actualAllocationSegments: [
            { startWeek: 2, endWeek: 4, days: 3 },
          ],
          synthetic: false,
          capacityProfile: {
            planningBasis: 'demandFollowing',
            source: 'squadPlanner',
            defaultPercent: 50,
            startWeek: 0,
            endWeek: 11,
            segments: [
              { startWeek: 0, endWeek: 5, capacityPercent: 50 },
              { startWeek: 6, endWeek: 11, capacityPercent: 75 },
            ],
            resolutionSource: 'PROFILE',
          },
        },
      ],
    }
    render(
      <ResourceProfileTab
        {...createProps({
          profile: {
            projectId: 'project-1',
            hoursPerDay: 8,
            projectDurationWeeks: 12,
            bufferWeeks: 0,
            onboardingWeeks: 0,
            resourceRows: [row],
            overheadRows: [],
            summary: { totalHours: 80, totalDays: 10, totalCost: null, hasCost: false },
          },
          filteredResourceRows: [row],
        })}
      />,
    )

    // The named resource summary should show exactly one entry (Alice)
    const assignedText = screen.getByText(/Assigned:/)
    expect(assignedText).toBeInTheDocument()
    expect(assignedText.textContent).toContain('Alice')
    // Only one named resource — no "+N more" appended
    expect(assignedText.textContent).not.toContain('+')
  })

  it('keeps actual assignment data separate from capacity profile display', () => {
    // Two rows: one role-level for capacity segments, one with named resource for assignment
    const roleRow = {
      ...baseRow,
      resourceTypeId: 'rt-role',
      name: 'Role Capacity',
      capacityProfile: {
        planningBasis: 'demandFollowing',
        source: 'squadPlanner',
        defaultPercent: 50,
        startWeek: 0,
        endWeek: 11,
        segments: [
          { startWeek: 0, endWeek: 5, capacityPercent: 50 },
          { startWeek: 6, endWeek: 11, capacityPercent: 75 },
        ],
        resolutionSource: 'PROFILE',
      },
    }
    const namedRow = {
      ...baseRow,
      resourceTypeId: 'rt-named',
      name: 'Named Dev',
      namedResources: [
        {
          id: 'nr-1',
          name: 'Bob',
          allocationMode: 'EFFORT',
          allocationPercent: 100,
          allocationStartWeek: null,
          allocationEndWeek: null,
          startWeek: null,
          endWeek: null,
          allocatedDays: 5,
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
        },
      ],
    }
    render(
      <ResourceProfileTab
        {...createProps({
          profile: {
            projectId: 'project-1',
            hoursPerDay: 8,
            projectDurationWeeks: 12,
            bufferWeeks: 0,
            onboardingWeeks: 0,
            resourceRows: [roleRow, namedRow],
            overheadRows: [],
            summary: { totalHours: 160, totalDays: 20, totalCost: null, hasCost: false },
          },
          filteredResourceRows: [roleRow, namedRow],
        })}
      />,
    )

    // Capacity profile segments on the role-level row
    expect(screen.getByText('W1-W6: 50%')).toBeInTheDocument()
    expect(screen.getByText('W7-W12: 75%')).toBeInTheDocument()

    // Actual assignment summary on the named-resource row
    expect(screen.getByText(/Assigned:/)).toBeInTheDocument()
    expect(screen.getByText(/Bob/)).toBeInTheDocument()
    expect(screen.getByText(/Bob W3-W4/)).toBeInTheDocument()
  })

  it('preserves commercial fields unchanged when capacityProfile is present', () => {
    const row = {
      ...baseRow,
      allocatedDays: 12, // Different from effortDays to trigger split display
      allocationMode: 'EFFORT',
      estimatedCost: 8000,
      capacityProfile: {
        planningBasis: 'demandFollowing',
        source: 'squadPlanner',
        defaultPercent: null,
        startWeek: null,
        endWeek: null,
        segments: [],
        resolutionSource: 'PROFILE',
      },
    }
    render(
      <ResourceProfileTab
        {...createProps({
          profile: {
            projectId: 'project-1',
            hoursPerDay: 8,
            projectDurationWeeks: 12,
            bufferWeeks: 0,
            onboardingWeeks: 0,
            resourceRows: [row],
            overheadRows: [],
            summary: { totalHours: 80, totalDays: 12, totalCost: 8000, hasCost: true },
          },
          filteredResourceRows: [row],
          hasCost: true,
          columnCount: 9,
        })}
      />,
    )

    // Commercial days display (allocated vs effort)
    expect(screen.getByText(/effort: 10/)).toBeInTheDocument()
    // Cost appears in both row and grand total — at least two occurrences
    const costCells = screen.getAllByText('$8000')
    expect(costCells.length).toBeGreaterThanOrEqual(2)
  })
})

describe('Named resource aggregate hint', () => {
  it('shows count and capacity profile count in planning basis column when named resources exist', () => {
    const row = {
      resourceTypeId: 'rt-dev',
      name: 'Developer',
      category: 'ENGINEERING',
      count: 2,
      hoursPerDay: 8,
      dayRate: 800,
      totalHours: 80,
      totalDays: 10,
      effortDays: 10,
      allocatedDays: 5,
      allocationMode: 'EFFORT',
      allocationPercent: 100,
      allocationStartWeek: null,
      allocationEndWeek: null,
      derivedStartWeek: null,
      derivedEndWeek: null,
      estimatedCost: null,
      epics: [],
      namedResources: [
        {
          id: 'nr-1', name: 'Alice',
          allocationMode: 'EFFORT', allocationPercent: 100,
          allocationStartWeek: null, allocationEndWeek: null,
          startWeek: null, endWeek: null,
          allocatedDays: 3, derivedStartWeek: null, derivedEndWeek: null,
          actualAllocatedDays: 1.5, actualAllocationStartWeek: 2, actualAllocationEndWeek: 3,
          actualAllocatedWeeks: [{ week: 2, days: 1.5, capacityDays: 5 }],
          actualAllocationSegments: [{ startWeek: 2, endWeek: 3, days: 1.5 }],
          synthetic: false,
          capacityProfile: {
            planningBasis: 'demandFollowing', source: 'squadPlanner',
            defaultPercent: null, startWeek: null, endWeek: null,
            segments: [], resolutionSource: 'PROFILE',
          },
        },
        {
          id: 'nr-2', name: 'Bob',
          allocationMode: 'EFFORT', allocationPercent: 100,
          allocationStartWeek: null, allocationEndWeek: null,
          startWeek: null, endWeek: null,
          allocatedDays: 2, derivedStartWeek: null, derivedEndWeek: null,
          actualAllocatedDays: 1, actualAllocationStartWeek: 4, actualAllocationEndWeek: 4,
          actualAllocatedWeeks: [{ week: 4, days: 1, capacityDays: 5 }],
          actualAllocationSegments: [{ startWeek: 4, endWeek: 4, days: 1 }],
          synthetic: true,
          capacityProfile: {
            planningBasis: 'availabilityWindow', source: 'fixed',
            defaultPercent: 50, startWeek: 0, endWeek: 11,
            segments: [{ startWeek: 0, endWeek: 5, capacityPercent: 50 }, { startWeek: 6, endWeek: 11, capacityPercent: 100 }],
            resolutionSource: 'ACTIVE_CAPACITY_PLAN',
          },
        },
      ],
    }
    render(
      <ResourceProfileTab
        {...createProps({
          profile: {
            projectId: 'project-1', hoursPerDay: 8, projectDurationWeeks: 12,
            bufferWeeks: 0, onboardingWeeks: 0,
            resourceRows: [row],
            overheadRows: [],
            summary: { totalHours: 80, totalDays: 10, totalCost: null, hasCost: false },
          },
          filteredResourceRows: [row],
        })}
      />,
    )

    // Aggregate hint shows count and profile count
    const hintSpan = screen.getByText(/2 people · 2 capacity profiles/)
    expect(hintSpan).toBeInTheDocument()
    // Role identity label acknowledges mixed person/planned
    expect(screen.getByText(/Mixed \(named person \+ planned resource\)/)).toBeInTheDocument()
  })

  it('shows "person" in aggregate hint for single named resource without capacity profile', () => {
    const row = {
      resourceTypeId: 'rt-dev',
      name: 'Developer',
      category: 'ENGINEERING',
      count: 1,
      hoursPerDay: 8,
      dayRate: 800,
      totalHours: 80,
      totalDays: 10,
      effortDays: 10,
      allocatedDays: 3,
      allocationMode: 'EFFORT',
      allocationPercent: 100,
      allocationStartWeek: null,
      allocationEndWeek: null,
      derivedStartWeek: null,
      derivedEndWeek: null,
      estimatedCost: null,
      epics: [],
      namedResources: [
        {
          id: 'nr-1', name: 'Carol',
          allocationMode: 'EFFORT', allocationPercent: 100,
          allocationStartWeek: null, allocationEndWeek: null,
          startWeek: null, endWeek: null,
          allocatedDays: 0, derivedStartWeek: null, derivedEndWeek: null,
          actualAllocatedDays: 0, actualAllocationStartWeek: null, actualAllocationEndWeek: null,
          actualAllocatedWeeks: [],
          actualAllocationSegments: [],
          synthetic: false,
        },
      ],
    }
    render(
      <ResourceProfileTab
        {...createProps({
          profile: {
            projectId: 'project-1', hoursPerDay: 8, projectDurationWeeks: 12,
            bufferWeeks: 0, onboardingWeeks: 0,
            resourceRows: [row],
            overheadRows: [],
            summary: { totalHours: 80, totalDays: 10, totalCost: null, hasCost: false },
          },
          filteredResourceRows: [row],
        })}
      />,
    )

    // Aggregate hint: single person, no capacity profiles
    expect(screen.getByText(/1 person · No profiles/)).toBeInTheDocument()
    // Role identity label
    expect(screen.getByText('Named person')).toBeInTheDocument()
  })
})
