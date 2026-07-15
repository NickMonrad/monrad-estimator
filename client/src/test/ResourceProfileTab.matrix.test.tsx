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
import type { CapacityProfilePlanningBasis, CapacityProfileResolutionSource } from '@/types/backlog'

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
      projectDurationWeeks: 10,
      bufferWeeks: 0,
      onboardingWeeks: 0,
      resourceRows: [{
        resourceTypeId: 'rt-dev',
        name: 'Developer',
        category: 'ENG',
        count,
        hoursPerDay: 8,
        dayRate: 500,
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
        estimatedCost: 5000,
        epics: [],
        namedResources: [],
      }],
      overheadRows: [],
      summary: {
        totalHours: 80,
        totalDays: 10,
        totalCost: 5000,
        hasCost: false,
      },
    },
    profileLoading: false,
    overheadItems: [],
    resourceTypes: [],
    filteredResourceRows: [{
      resourceTypeId: 'rt-dev',
      name: 'Developer',
      category: 'ENG',
      count,
      hoursPerDay: 8,
      dayRate: 500,
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
      estimatedCost: 5000,
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

// ─── Shared capacity profile helper ────────────────────────────────────────

interface ProfileCase {
  name: string
  resolutionSource: CapacityProfileResolutionSource
  planningBasis: CapacityProfilePlanningBasis
  staleAllocationMode: string
}

const SEGMENTED_CASES: ProfileCase[] = [
  {
    name: 'PROFILE + capacityProfile + segments + stale EFFORT',
    resolutionSource: 'PROFILE',
    planningBasis: 'capacityProfile',
    staleAllocationMode: 'EFFORT',
  },
  {
    name: 'PROFILE + availabilityWindow + segments + stale TIMELINE',
    resolutionSource: 'PROFILE',
    planningBasis: 'availabilityWindow',
    staleAllocationMode: 'TIMELINE',
  },
  {
    name: 'PROFILE + wholeProjectAllocation + segments + stale FULL_PROJECT',
    resolutionSource: 'PROFILE',
    planningBasis: 'wholeProjectAllocation',
    staleAllocationMode: 'FULL_PROJECT',
  },
  {
    name: 'ACTIVE_CAPACITY_PLAN + segments + stale EFFORT',
    resolutionSource: 'ACTIVE_CAPACITY_PLAN',
    planningBasis: 'capacityProfile',
    staleAllocationMode: 'EFFORT',
  },
]

/** Build row overrides with a capacity profile and stale allocation mode. */
function profileRowOverrides(
  res: CapacityProfileResolutionSource,
  basis: CapacityProfilePlanningBasis,
  staleMode: string,
  hasSegments: boolean,
) {
  const segments = hasSegments
    ? [{ startWeek: 2, endWeek: 4, capacityPercent: 80 }, { startWeek: 5, endWeek: 8, capacityPercent: 100 }]
    : []
  const capacityProfile = {
    resolutionSource: res,
    planningBasis: basis,
    source: 'squadPlanner' as const,
    defaultPercent: null,
    startWeek: null,
    endWeek: null,
    segments,
  }
  return {
    profile: {
      projectId: 'p',
      hoursPerDay: 8,
      projectDurationWeeks: 10,
      bufferWeeks: 0,
      onboardingWeeks: 0,
      resourceRows: [{
        resourceTypeId: 'rt-dev',
        name: 'Developer',
        category: 'ENG',
        count: 1,
        hoursPerDay: 8,
        dayRate: 500,
        totalHours: 80,
        totalDays: 10,
        effortDays: 10,
        allocatedDays: 10,
        allocationMode: staleMode,
        allocationPercent: 100,
        allocationStartWeek: null,
        allocationEndWeek: null,
        derivedStartWeek: null,
        derivedEndWeek: null,
        estimatedCost: 5000,
        epics: [],
        namedResources: [],
        capacityProfile,
      }],
      overheadRows: [],
      summary: { totalHours: 80, totalDays: 10, totalCost: 5000, hasCost: false },
    },
    filteredResourceRows: [{
      resourceTypeId: 'rt-dev',
      name: 'Developer',
      category: 'ENG',
      count: 1,
      hoursPerDay: 8,
      dayRate: 500,
      totalHours: 80,
      totalDays: 10,
      effortDays: 10,
      allocatedDays: 10,
      allocationMode: staleMode,
      allocationPercent: 100,
      allocationStartWeek: null,
      allocationEndWeek: null,
      derivedStartWeek: null,
      derivedEndWeek: null,
      estimatedCost: 5000,
      epics: [],
      namedResources: [],
      capacityProfile,
    }],
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Section 2 — Exact-payload save tests
// ═══════════════════════════════════════════════════════════════════════════

describe('ResourceProfileTab exact-payload saves', () => {
  it('saves EFFORT allocation with exact payload', () => {
    const mutateFn = vi.fn()
    renderWithRouter(<ResourceProfileTab {...createProps(1, {
      editingAllocation: 'rt-dev',
      allocationDraft: {
        allocationMode: 'EFFORT',
        allocationPercent: 100,
        allocationStartWeek: null,
        allocationEndWeek: null,
      },
      updateAllocationMutation: { isPending: false, mutate: mutateFn } as never,
    })} />)
    fireEvent.click(screen.getByTestId('allocation-save'))
    expect(mutateFn.mock.calls[0][0]).toEqual({
      rtId: 'rt-dev',
      data: {
        allocationMode: 'EFFORT',
        allocationPercent: 100,
        allocationStartWeek: null,
        allocationEndWeek: null,
      },
    })
  })

  it('saves FULL_PROJECT allocation with exact payload', () => {
    const mutateFn = vi.fn()
    renderWithRouter(<ResourceProfileTab {...createProps(1, {
      editingAllocation: 'rt-dev',
      allocationDraft: {
        allocationMode: 'FULL_PROJECT',
        allocationPercent: 75,
        allocationStartWeek: null,
        allocationEndWeek: null,
      },
      updateAllocationMutation: { isPending: false, mutate: mutateFn } as never,
    })} />)
    fireEvent.click(screen.getByTestId('allocation-save'))
    expect(mutateFn.mock.calls[0][0]).toEqual({
      rtId: 'rt-dev',
      data: {
        allocationMode: 'FULL_PROJECT',
        allocationPercent: 75,
        allocationStartWeek: null,
        allocationEndWeek: null,
      },
    })
  })

  it('saves TIMELINE allocation with exact payload including weeks', () => {
    const mutateFn = vi.fn()
    renderWithRouter(<ResourceProfileTab {...createProps(1, {
      editingAllocation: 'rt-dev',
      allocationDraft: {
        allocationMode: 'TIMELINE',
        allocationPercent: 50,
        allocationStartWeek: 2,
        allocationEndWeek: 8,
      },
      updateAllocationMutation: { isPending: false, mutate: mutateFn } as never,
    })} />)
    fireEvent.click(screen.getByTestId('allocation-save'))
    expect(mutateFn.mock.calls[0][0]).toEqual({
      rtId: 'rt-dev',
      data: {
        allocationMode: 'TIMELINE',
        allocationPercent: 50,
        allocationStartWeek: 2,
        allocationEndWeek: 8,
      },
    })
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Section 3 — Profile-managed regression (segmented cases)
// ═══════════════════════════════════════════════════════════════════════════

describe('ResourceProfileTab profile-managed rows', () => {
  it.each(SEGMENTED_CASES)(
    'prevents scalar editor for $name',
    ({ resolutionSource, planningBasis, staleAllocationMode }) => {
      const setEditingAllocation = vi.fn()
      const setAllocationDraft = vi.fn()
      const rowOverrides = profileRowOverrides(resolutionSource, planningBasis, staleAllocationMode, true)

      // Part 1: render with editor closed, click badge
      const { container } = renderWithRouter(<ResourceProfileTab {...createProps(1, {
        ...rowOverrides,
        setEditingAllocation,
        setAllocationDraft,
      })} />)

      const badge = container.querySelector('button[title="Click to edit allocation"]')
      expect(badge).toBeTruthy()
      fireEvent.click(badge!)

      expect(setEditingAllocation).toHaveBeenCalledWith('rt-dev')
      expect(setAllocationDraft).toHaveBeenCalledWith({
        allocationMode: 'CAPACITY_PLAN',
        allocationPercent: 100,
        allocationStartWeek: null,
        allocationEndWeek: null,
      })

      // Part 2: re-render with editor open — verify info panel, no scalar controls
      const { container: c2 } = renderWithRouter(<ResourceProfileTab {...createProps(1, {
        ...rowOverrides,
        editingAllocation: 'rt-dev',
        allocationDraft: {
          allocationMode: 'CAPACITY_PLAN',
          allocationPercent: 100,
          allocationStartWeek: null,
          allocationEndWeek: null,
        },
      })} />)

      expect(screen.getByText(/managed through the weekly capacity profile/i)).toBeInTheDocument()
      expect(c2.querySelector('select[aria-label="Availability pattern"]')).toBeNull()
      expect(screen.queryByText('Save')).toBeNull()
    },
  )
})

// ═══════════════════════════════════════════════════════════════════════════
// Section 3e — Segmentless scalar profile (select IS present)
// ═══════════════════════════════════════════════════════════════════════════

describe('ResourceProfileTab segmentless scalar profile', () => {
  it('PROFILE + availabilityWindow + no segments + stale TIMELINE opens scalar editor with select', () => {
    const setEditingAllocation = vi.fn()
    const setAllocationDraft = vi.fn()
    const rowOverrides = profileRowOverrides('PROFILE', 'availabilityWindow', 'TIMELINE', false)

    // Part 1: click badge
    const { container } = renderWithRouter(<ResourceProfileTab {...createProps(1, {
      ...rowOverrides,
      setEditingAllocation,
      setAllocationDraft,
    })} />)

    const badge = container.querySelector('button[title="Click to edit allocation"]')
    expect(badge).toBeTruthy()
    fireEvent.click(badge!)

    expect(setEditingAllocation).toHaveBeenCalledWith('rt-dev')
    // Not profile-managed → draft uses the stale mode directly
    expect(setAllocationDraft).toHaveBeenCalledWith({
      allocationMode: 'TIMELINE',
      allocationPercent: 100,
      allocationStartWeek: null,
      allocationEndWeek: null,
    })

    // Part 2: open editor — select IS present
    const { container: c2 } = renderWithRouter(<ResourceProfileTab {...createProps(1, {
      ...rowOverrides,
      editingAllocation: 'rt-dev',
      allocationDraft: {
        allocationMode: 'TIMELINE',
        allocationPercent: 100,
        allocationStartWeek: null,
        allocationEndWeek: null,
      },
    })} />)

    expect(c2.querySelector('select[aria-label="Availability pattern"]')).toBeTruthy()
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Section 4 — CAPACITY_PLAN info panel acceptance
// ═══════════════════════════════════════════════════════════════════════════

describe('ResourceProfileTab CAPACITY_PLAN info panel', () => {
  it('shows full info panel with segment summary, navigation, and no percent suffix', () => {
    const segments = [
      { startWeek: 2, endWeek: 4, capacityPercent: 80 },
      { startWeek: 5, endWeek: 8, capacityPercent: 100 },
    ]
    const capacityProfile = {
      resolutionSource: 'PROFILE' as const,
      planningBasis: 'capacityProfile' as const,
      source: 'squadPlanner' as const,
      defaultPercent: null,
      startWeek: null,
      endWeek: null,
      segments,
    }
    const rowOverrides = {
      profile: {
        projectId: 'p',
        hoursPerDay: 8,
        projectDurationWeeks: 10,
        bufferWeeks: 0,
        onboardingWeeks: 0,
        resourceRows: [{
          resourceTypeId: 'rt-dev',
          name: 'Developer',
          category: 'ENG',
          count: 1,
          hoursPerDay: 8,
          dayRate: 500,
          totalHours: 80,
          totalDays: 10,
          effortDays: 10,
          allocatedDays: 10,
          allocationMode: 'CAPACITY_PLAN' as const,
          allocationPercent: 100,
          allocationStartWeek: null,
          allocationEndWeek: null,
          derivedStartWeek: null,
          derivedEndWeek: null,
          estimatedCost: 5000,
          epics: [],
          namedResources: [],
          capacityProfile,
        }],
        overheadRows: [],
        summary: { totalHours: 80, totalDays: 10, totalCost: 5000, hasCost: false },
      },
      filteredResourceRows: [{
        resourceTypeId: 'rt-dev',
        name: 'Developer',
        category: 'ENG',
        count: 1,
        hoursPerDay: 8,
        dayRate: 500,
        totalHours: 80,
        totalDays: 10,
        effortDays: 10,
        allocatedDays: 10,
        allocationMode: 'CAPACITY_PLAN' as const,
        allocationPercent: 100,
        allocationStartWeek: null,
        allocationEndWeek: null,
        derivedStartWeek: null,
        derivedEndWeek: null,
        estimatedCost: 5000,
        epics: [],
        namedResources: [],
        capacityProfile,
      }],
      editingAllocation: 'rt-dev',
      allocationDraft: {
        allocationMode: 'CAPACITY_PLAN' as const,
        allocationPercent: 100,
        allocationStartWeek: null,
        allocationEndWeek: null,
      },
    }

    renderWithRouter(<ResourceProfileTab {...createProps(1, rowOverrides)} />)

    // Badge label must NOT show a percentage suffix — "Varies by week" appears in badge + info panel
    const variesElements = screen.getAllByText('Varies by week')
    expect(variesElements.length).toBeGreaterThanOrEqual(1)
    // The badge (first match) must not contain %
    expect(variesElements[0].textContent).not.toMatch(/%/)

    // Segment summary should be visible
    expect(screen.getByText(/W3-W5: 80%/)).toBeInTheDocument()
    expect(screen.getByText(/W6-W9: 100%/)).toBeInTheDocument()

    // Navigation button — use getAllByText to handle potential duplicates
    const navButtons = screen.getAllByText(/Open weekly profile editor/i)
    expect(navButtons.length).toBeGreaterThanOrEqual(1)

    // Click the first one and verify navigation
    fireEvent.click(navButtons[0])
    expect(mockNavigate).toHaveBeenCalledWith('/projects/project-1/timeline?panel=squad-planner')
  })
})
