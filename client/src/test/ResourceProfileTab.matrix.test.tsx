import React, { type ComponentProps } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
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
// Section 3f — Authoritative null windows never revive compatibility dates
// ═══════════════════════════════════════════════════════════════════════════

function nullWindowProfileRowOverrides(
  resolutionSource: CapacityProfileResolutionSource,
  planningBasis: CapacityProfilePlanningBasis,
) {
  const overrides = profileRowOverrides(resolutionSource, planningBasis, 'TIMELINE', false) as any
  for (const row of [overrides.profile.resourceRows[0], overrides.filteredResourceRows[0]]) {
    row.allocationPercent = 25
    row.allocationStartWeek = 2
    row.allocationEndWeek = 6
    row.derivedStartWeek = 3
    row.derivedEndWeek = 7
    row.capacityProfile.defaultPercent = 75
    row.capacityProfile.startWeek = null
    row.capacityProfile.endWeek = null
  }
  return overrides
}

const NULL_WINDOW_SCALAR_CASES = [
  ['demandFollowing', 'EFFORT', '—'],
  ['wholeProjectAllocation', 'FULL_PROJECT', 'Wk 0 – Wk 10'],
  ['availabilityWindow', 'TIMELINE', '—'],
] as const

describe('ResourceProfileTab authoritative null profile windows', () => {
  it.each(NULL_WINDOW_SCALAR_CASES)(
    'keeps PROFILE + %s null bounds authoritative in the period and scalar draft',
    (planningBasis, expectedMode, expectedPeriod) => {
      const setAllocationDraft = vi.fn()
      const overrides = nullWindowProfileRowOverrides('PROFILE', planningBasis)
      const { container } = renderWithRouter(<ResourceProfileTab {...createProps(1, {
        ...overrides,
        setAllocationDraft,
      })} />)
      const row = screen.getByTestId('resource-profile-row-rt-dev')

      expect(row.querySelectorAll('td')[6]?.textContent).toBe(expectedPeriod)
      const badge = container.querySelector('button[title="Click to edit allocation"]')!
      expect(badge.textContent).not.toContain('25%')
      fireEvent.click(badge)
      expect(setAllocationDraft).toHaveBeenCalledWith({
        allocationMode: expectedMode,
        allocationPercent: 75,
        allocationStartWeek: null,
        allocationEndWeek: null,
      })
      expect(screen.queryByText(/\(auto: Wk/)).toBeNull()
    },
  )

  it('saves a scalar-safe null-window availability profile without stale dates', () => {
    const mutate = vi.fn()
    const overrides = nullWindowProfileRowOverrides('PROFILE', 'availabilityWindow')
    const { container } = renderWithRouter(<ResourceProfileTab {...createProps(1, {
      ...overrides,
      editingAllocation: 'rt-dev',
      allocationDraft: {
        allocationMode: 'TIMELINE', allocationPercent: 75,
        allocationStartWeek: null, allocationEndWeek: null,
      },
      updateAllocationMutation: { isPending: false, mutate } as never,
    })} />)

    expect(container.querySelector('select[aria-label="Availability pattern"]')).toBeTruthy()
    const startInput = screen.getByText('Available from').parentElement?.querySelector('input')
    const endInput = screen.getByText('Available to').parentElement?.querySelector('input')
    expect(startInput).toHaveValue(null)
    expect(endInput).toHaveValue(null)
    fireEvent.click(screen.getByTestId('allocation-save'))
    expect(mutate.mock.calls[0][0]).toEqual({
      rtId: 'rt-dev',
      data: {
        allocationMode: 'TIMELINE', allocationPercent: 75,
        allocationStartWeek: null, allocationEndWeek: null,
      },
    })
  })

  it.each([
    ['start only', 3, null, 'From Wk 3'],
    ['end only', null, 7, 'Until Wk 7'],
  ] as const)('renders authoritative selected-week %s without legacy fallback', (_case, startWeek, endWeek, period) => {
    const overrides = nullWindowProfileRowOverrides('PROFILE', 'availabilityWindow')
    for (const row of [overrides.profile.resourceRows[0], overrides.filteredResourceRows[0]]) {
      row.capacityProfile.startWeek = startWeek
      row.capacityProfile.endWeek = endWeek
    }

    renderWithRouter(<ResourceProfileTab {...createProps(1, overrides)} />)
    const row = screen.getByTestId('resource-profile-row-rt-dev')
    expect(row.querySelectorAll('td')[6]?.textContent).toBe(period)
    expect(screen.queryByText(/Wk 2|Wk 6|auto: Wk/)).toBeNull()
  })

  it('retains derived hints for a pure legacy selected-week row', () => {
    const props = createProps(1)
    props.filteredResourceRows[0] = {
      ...props.filteredResourceRows[0],
      allocationMode: 'TIMELINE',
      derivedStartWeek: 3,
      derivedEndWeek: 7,
    }
    props.profile!.resourceRows[0] = props.filteredResourceRows[0]
    props.editingAllocation = 'rt-dev'
    props.allocationDraft = {
      allocationMode: 'TIMELINE',
      allocationPercent: 100,
      allocationStartWeek: 3,
      allocationEndWeek: 7,
    }

    renderWithRouter(<ResourceProfileTab {...props} />)
    expect(screen.getByText(/\(auto: Wk 3\)/)).toBeInTheDocument()
    expect(screen.getByText(/\(auto: Wk 7\)/)).toBeInTheDocument()
  })

  it('keeps PROFILE capacityProfile and ACTIVE_CAPACITY_PLAN null windows profile-managed', () => {
    for (const [resolutionSource, planningBasis] of [
      ['PROFILE', 'capacityProfile'],
      ['ACTIVE_CAPACITY_PLAN', 'availabilityWindow'],
    ] as const) {
      const overrides = nullWindowProfileRowOverrides(resolutionSource, planningBasis)
      const { container, unmount } = renderWithRouter(<ResourceProfileTab {...createProps(1, {
        ...overrides,
        editingAllocation: 'rt-dev',
        allocationDraft: {
          allocationMode: 'CAPACITY_PLAN', allocationPercent: 75,
          allocationStartWeek: null, allocationEndWeek: null,
        },
      })} />)

      const row = screen.getByTestId('resource-profile-row-rt-dev')
      expect(row.querySelectorAll('td')[6]?.textContent).toBe('Varies by week')
      expect(container.querySelector('select[aria-label="Availability pattern"]')).toBeNull()
      expect(screen.queryByTestId('allocation-save')).toBeNull()
      unmount()
    }
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

// ═══════════════════════════════════════════════════════════════════════════
// Section 5 — Authoritative scalar mismatch (profile resolves to different mode than stale row)
// ═══════════════════════════════════════════════════════════════════════════

describe('ResourceProfileTab authoritative scalar mismatch', () => {
  it('PROFILE + demandFollowing + no segments + stale TIMELINE maps to EFFORT scalar editor', () => {
    const capacityProfile = {
      resolutionSource: 'PROFILE' as const,
      planningBasis: 'demandFollowing' as const,
      source: 'squadPlanner' as const,
      defaultPercent: null as number | null,
      startWeek: null as number | null,
      endWeek: null as number | null,
      segments: [] as Array<{ startWeek: number; endWeek: number; capacityPercent: number }>,
    }
    const rowBase = {
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
      allocationMode: 'TIMELINE' as const,
      allocationPercent: 100,
      allocationStartWeek: 2,
      allocationEndWeek: 8,
      derivedStartWeek: null,
      derivedEndWeek: null,
      estimatedCost: 5000,
      epics: [] as Array<never>,
      namedResources: [] as Array<never>,
      capacityProfile,
    }
    const profile = {
      projectId: 'p',
      hoursPerDay: 8,
      projectDurationWeeks: 10,
      bufferWeeks: 0,
      onboardingWeeks: 0,
      resourceRows: [rowBase],
      overheadRows: [] as Array<never>,
      summary: { totalHours: 80, totalDays: 10, totalCost: 5000, hasCost: false },
    }
    const filteredResourceRows = [rowBase]
    const setAllocationDraft = vi.fn()
    const setEditingAllocation = vi.fn()

    // Part 1: render with editor closed, click badge
    const { container } = renderWithRouter(<ResourceProfileTab {...createProps(1, {
      profile,
      filteredResourceRows,
      setAllocationDraft,
      setEditingAllocation,
    })} />)

    const badge = container.querySelector('button[title="Click to edit allocation"]')
    expect(badge).toBeTruthy()
    // Badge shows planning-basis label 'As needed', not stale TIMELINE label
    expect(badge!.textContent).toContain('As needed')
    // No percentage suffix for demand-following (EFFORT) mode
    expect(badge!.textContent).not.toContain('%')

    fireEvent.click(badge!)
    expect(setEditingAllocation).toHaveBeenCalledWith('rt-dev')
    expect(setAllocationDraft).toHaveBeenCalledWith({
      allocationMode: 'EFFORT',
      allocationPercent: 100,
      allocationStartWeek: null,
      allocationEndWeek: null,
    })

    // Part 2: re-render with editor open — verify scalar controls
    renderWithRouter(<ResourceProfileTab {...createProps(1, {
      profile,
      filteredResourceRows,
      editingAllocation: 'rt-dev',
      allocationDraft: { allocationMode: 'EFFORT', allocationPercent: 100, allocationStartWeek: null, allocationEndWeek: null },
      setAllocationDraft,
      setEditingAllocation,
    })} />)

    expect(screen.queryByLabelText('Available %')).toBeNull()
    expect(screen.queryByText('Available from')).toBeNull()
    expect(screen.queryByText('Available to')).toBeNull()
  })

  it('PROFILE + availabilityWindow + no segments + stale EFFORT maps to TIMELINE scalar editor', () => {
    const capacityProfile = {
      resolutionSource: 'PROFILE' as const,
      planningBasis: 'availabilityWindow' as const,
      source: 'squadPlanner' as const,
      defaultPercent: 75,
      startWeek: 3,
      endWeek: 8,
      segments: [] as Array<{ startWeek: number; endWeek: number; capacityPercent: number }>,
    }
    const rowBase = {
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
      allocationMode: 'EFFORT' as const,
      allocationPercent: 100,
      allocationStartWeek: null,
      allocationEndWeek: null,
      derivedStartWeek: null,
      derivedEndWeek: null,
      estimatedCost: 5000,
      epics: [] as Array<never>,
      namedResources: [] as Array<never>,
      capacityProfile,
    }
    const profile = {
      projectId: 'p',
      hoursPerDay: 8,
      projectDurationWeeks: 10,
      bufferWeeks: 0,
      onboardingWeeks: 0,
      resourceRows: [rowBase],
      overheadRows: [] as Array<never>,
      summary: { totalHours: 80, totalDays: 10, totalCost: 5000, hasCost: false },
    }
    const filteredResourceRows = [rowBase]
    const setAllocationDraft = vi.fn()
    const setEditingAllocation = vi.fn()

    // Part 1: click badge
    const { container } = renderWithRouter(<ResourceProfileTab {...createProps(1, {
      profile,
      filteredResourceRows,
      setAllocationDraft,
      setEditingAllocation,
    })} />)

    const badge = container.querySelector('button[title="Click to edit allocation"]')
    expect(badge).toBeTruthy()
    expect(badge!.textContent).toContain('Fixed for selected weeks')
    // Badge uses profile defaultPercent (75%) not stale row value (100%)
    expect(badge!.textContent).toContain('75%')
    // Week range shows profile values (W3-W8)
    expect(screen.getAllByText('Wk 3 – Wk 8')).toHaveLength(2)

    fireEvent.click(badge!)
    expect(setEditingAllocation).toHaveBeenCalledWith('rt-dev')
    expect(setAllocationDraft).toHaveBeenCalledWith({
      allocationMode: 'TIMELINE',
      allocationPercent: 75,
      allocationStartWeek: 3,
      allocationEndWeek: 8,
    })

    // Part 2: open editor
    renderWithRouter(<ResourceProfileTab {...createProps(1, {
      profile,
      filteredResourceRows,
      editingAllocation: 'rt-dev',
      allocationDraft: { allocationMode: 'TIMELINE', allocationPercent: 75, allocationStartWeek: 3, allocationEndWeek: 8 },
      setAllocationDraft,
      setEditingAllocation,
    })} />)

    expect(screen.getByText('Available %')).toBeInTheDocument()
    expect(screen.getByText('Available from')).toBeInTheDocument()
    expect(screen.getByText('Available to')).toBeInTheDocument()
  })

  it('PROFILE + availabilityWindow + stale TIMELINE + badge uses profile percent and dates', () => {
    const capacityProfile = {
      resolutionSource: 'PROFILE' as const,
      planningBasis: 'availabilityWindow' as const,
      source: 'squadPlanner' as const,
      defaultPercent: 75,
      startWeek: 3,
      endWeek: 8,
      segments: [] as Array<{ startWeek: number; endWeek: number; capacityPercent: number }>,
    }
    const rowBase = {
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
      allocationMode: 'TIMELINE' as const,
      allocationPercent: 100,
      allocationStartWeek: 2,
      allocationEndWeek: 6,
      derivedStartWeek: null,
      derivedEndWeek: null,
      estimatedCost: 5000,
      epics: [] as Array<never>,
      namedResources: [] as Array<never>,
      capacityProfile,
    }
    const profile = {
      projectId: 'p',
      hoursPerDay: 8,
      projectDurationWeeks: 10,
      bufferWeeks: 0,
      onboardingWeeks: 0,
      resourceRows: [rowBase],
      overheadRows: [] as Array<never>,
      summary: { totalHours: 80, totalDays: 10, totalCost: 5000, hasCost: false },
    }
    const filteredResourceRows = [rowBase]

    const { container } = renderWithRouter(<ResourceProfileTab {...createProps(1, {
      profile,
      filteredResourceRows,
    })} />)

    const badge = container.querySelector('button[title="Click to edit allocation"]')
    expect(badge).toBeTruthy()
    // Badge shows planning-basis label, not stale TIMELINE label
    expect(badge!.textContent).toContain('Fixed for selected weeks')
    // Badge uses profile defaultPercent (75%), not stale row value (100%)
    expect(badge!.textContent).toContain('75%')
    expect(badge!.textContent).not.toContain('100%')
    // Week range shows profile values (W3-W8), not legacy (W2-W6)
    expect(screen.getAllByText('Wk 3 – Wk 8')).toHaveLength(2)
    expect(screen.queryByText(/Wk 2.*Wk 6/)).toBeNull()
  })

  it('PROFILE + wholeProjectAllocation + no segments + stale EFFORT maps to FULL_PROJECT scalar editor', () => {
    const capacityProfile = {
      resolutionSource: 'PROFILE' as const,
      planningBasis: 'wholeProjectAllocation' as const,
      source: 'squadPlanner' as const,
      defaultPercent: 80,
      startWeek: null as number | null,
      endWeek: null as number | null,
      segments: [] as Array<{ startWeek: number; endWeek: number; capacityPercent: number }>,
    }
    const rowBase = {
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
      allocationMode: 'EFFORT' as const,
      allocationPercent: 100,
      allocationStartWeek: null,
      allocationEndWeek: null,
      derivedStartWeek: null,
      derivedEndWeek: null,
      estimatedCost: 5000,
      epics: [] as Array<never>,
      namedResources: [] as Array<never>,
      capacityProfile,
    }
    const profile = {
      projectId: 'p',
      hoursPerDay: 8,
      projectDurationWeeks: 10,
      bufferWeeks: 0,
      onboardingWeeks: 0,
      resourceRows: [rowBase],
      overheadRows: [] as Array<never>,
      summary: { totalHours: 80, totalDays: 10, totalCost: 5000, hasCost: false },
    }
    const filteredResourceRows = [rowBase]
    const setAllocationDraft = vi.fn()
    const setEditingAllocation = vi.fn()

    // Part 1: click badge
    const { container } = renderWithRouter(<ResourceProfileTab {...createProps(1, {
      profile,
      filteredResourceRows,
      setAllocationDraft,
      setEditingAllocation,
    })} />)

    const badge = container.querySelector('button[title="Click to edit allocation"]')
    expect(badge).toBeTruthy()
    expect(badge!.textContent).toContain('Fixed for whole project')
    // Badge uses profile defaultPercent (80%) not stale row value (100%)
    expect(badge!.textContent).toContain('80%')

    fireEvent.click(badge!)
    expect(setEditingAllocation).toHaveBeenCalledWith('rt-dev')
    expect(setAllocationDraft).toHaveBeenCalledWith({
      allocationMode: 'FULL_PROJECT',
      allocationPercent: 80,
      allocationStartWeek: null,
      allocationEndWeek: null,
    })

    // Part 2: open editor
    renderWithRouter(<ResourceProfileTab {...createProps(1, {
      profile,
      filteredResourceRows,
      editingAllocation: 'rt-dev',
      allocationDraft: { allocationMode: 'FULL_PROJECT', allocationPercent: 80, allocationStartWeek: null, allocationEndWeek: null },
      setAllocationDraft,
      setEditingAllocation,
    })} />)

    expect(screen.getByText('Available %')).toBeInTheDocument()
    expect(screen.queryByText('Available from')).toBeNull()
    expect(screen.queryByText('Available to')).toBeNull()
  })

  it('PROFILE + capacityProfile + no segments (profile-managed, no scalar editor)', () => {
    const capacityProfile = {
      resolutionSource: 'PROFILE' as const,
      planningBasis: 'capacityProfile' as const,
      source: 'squadPlanner' as const,
      defaultPercent: null as number | null,
      startWeek: null as number | null,
      endWeek: null as number | null,
      segments: [] as Array<{ startWeek: number; endWeek: number; capacityPercent: number }>,
    }
    const rowBase = {
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
      allocationMode: 'EFFORT' as const,
      allocationPercent: 100,
      allocationStartWeek: null,
      allocationEndWeek: null,
      derivedStartWeek: null,
      derivedEndWeek: null,
      estimatedCost: 5000,
      epics: [] as Array<never>,
      namedResources: [] as Array<never>,
      capacityProfile,
    }
    const profile = {
      projectId: 'p',
      hoursPerDay: 8,
      projectDurationWeeks: 10,
      bufferWeeks: 0,
      onboardingWeeks: 0,
      resourceRows: [rowBase],
      overheadRows: [] as Array<never>,
      summary: { totalHours: 80, totalDays: 10, totalCost: 5000, hasCost: false },
    }
    const filteredResourceRows = [rowBase]
    const setAllocationDraft = vi.fn()
    const setEditingAllocation = vi.fn()

    // Part 1: click badge
    const { container } = renderWithRouter(<ResourceProfileTab {...createProps(1, {
      profile,
      filteredResourceRows,
      setAllocationDraft,
      setEditingAllocation,
    })} />)

    const badge = container.querySelector('button[title="Click to edit allocation"]')
    expect(badge).toBeTruthy()
    expect(badge!.textContent).toContain('Varies by week')

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
      profile,
      filteredResourceRows,
      editingAllocation: 'rt-dev',
      allocationDraft: { allocationMode: 'CAPACITY_PLAN', allocationPercent: 100, allocationStartWeek: null, allocationEndWeek: null },
      setAllocationDraft,
      setEditingAllocation,
    })} />)

    expect(screen.getByText(/managed through the weekly capacity profile/i)).toBeInTheDocument()
    expect(c2.querySelector('select[aria-label="Availability pattern"]')).toBeNull()
    expect(screen.queryByText('Save')).toBeNull()
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Section 6 — Help/control matrix: each editable mode's UI behavior
// ═══════════════════════════════════════════════════════════════════════════

describe('ResourceProfileTab help/control matrix', () => {
  it('EFFORT editor: label, description, no scalar controls, switch clears dates', () => {
    const setAllocationDraft = vi.fn()
    // Render with a TIMELINE draft that has dates — then switch to EFFORT
    const { container } = renderWithRouter(<ResourceProfileTab {...createProps(1, {
      editingAllocation: 'rt-dev',
      allocationDraft: { allocationMode: 'TIMELINE', allocationPercent: 50, allocationStartWeek: 2, allocationEndWeek: 8 },
      setAllocationDraft,
    })} />)

    const select = container.querySelector('select[aria-label="Availability pattern"]')
    expect(select).toBeTruthy()

    // Switch select to EFFORT
    fireEvent.change(select!, { target: { value: 'EFFORT' } })

    // Verify the updater clears dates and resets percent to 100
    expect(setAllocationDraft).toHaveBeenCalled()
    const updater = setAllocationDraft.mock.calls[0][0]
    const result = updater({ allocationMode: 'TIMELINE', allocationPercent: 50, allocationStartWeek: 2, allocationEndWeek: 8 })
    expect(result).toEqual({
      allocationMode: 'EFFORT',
      allocationPercent: 100,
      allocationStartWeek: null,
      allocationEndWeek: null,
    })

    // Re-render with EFFORT draft — fresh container
    const { container: c2 } = renderWithRouter(<ResourceProfileTab {...createProps(1, {
      editingAllocation: 'rt-dev',
      allocationDraft: result,
    })} />)

    // Label 'As needed' appears in the select option
    const effortOption = c2.querySelector('option[value="EFFORT"]')
    expect(effortOption).toBeTruthy()
    expect(effortOption!.textContent).toBe('As needed')
    // Description rendered in the editor panel
    expect(within(c2).getByText(/Assigned only when scheduled work requires this resource/)).toBeVisible()
    // Percentage hidden
    expect(within(c2).queryByText('Available %')).toBeNull()
    // Dates hidden
    expect(within(c2).queryByText('Available from')).toBeNull()
    expect(within(c2).queryByText('Available to')).toBeNull()
    // Save button present
    expect(within(c2).getByTestId('allocation-save')).toBeInTheDocument()
  })

  it('FULL_PROJECT editor: label, description, visible pct, hidden dates, stale dates cleared', () => {
    const setAllocationDraft = vi.fn()
    // Render with a TIMELINE draft that has dates — then switch to FULL_PROJECT
    const { container } = renderWithRouter(<ResourceProfileTab {...createProps(1, {
      editingAllocation: 'rt-dev',
      allocationDraft: { allocationMode: 'TIMELINE', allocationPercent: 50, allocationStartWeek: 2, allocationEndWeek: 8 },
      setAllocationDraft,
    })} />)

    const select = container.querySelector('select[aria-label="Availability pattern"]')
    expect(select).toBeTruthy()

    fireEvent.change(select!, { target: { value: 'FULL_PROJECT' } })

    // Verify updater clears dates for non-TIMELINE mode
    expect(setAllocationDraft).toHaveBeenCalled()
    const updater = setAllocationDraft.mock.calls[0][0]
    const result = updater({ allocationMode: 'TIMELINE', allocationPercent: 50, allocationStartWeek: 2, allocationEndWeek: 8 })
    expect(result).toEqual({
      allocationMode: 'FULL_PROJECT',
      allocationPercent: 50,
      allocationStartWeek: null,
      allocationEndWeek: null,
    })

    // Re-render with FULL_PROJECT draft — fresh container
    const { container: c2 } = renderWithRouter(<ResourceProfileTab {...createProps(1, {
      editingAllocation: 'rt-dev',
      allocationDraft: result,
    })} />)

    const fpOption = c2.querySelector('option[value="FULL_PROJECT"]')
    expect(fpOption).toBeTruthy()
    // Description rendered in the editor panel
    expect(within(c2).getByText(/Available at the selected percentage from the beginning to the end/)).toBeVisible()
    // Percentage visible
    expect(within(c2).getByText('Available %')).toBeInTheDocument()
    // Dates hidden
    expect(within(c2).queryByText('Available from')).toBeNull()
    expect(within(c2).queryByText('Available to')).toBeNull()
    expect(within(c2).getByTestId('allocation-save')).toBeInTheDocument()
})

  it('TIMELINE editor: label, description, visible pct, accessible date fields', () => {
    const { container } = renderWithRouter(<ResourceProfileTab {...createProps(1, {
      editingAllocation: 'rt-dev',
      allocationDraft: { allocationMode: 'TIMELINE', allocationPercent: 50, allocationStartWeek: 2, allocationEndWeek: 8 },
    })} />)

    const tlOption = container.querySelector('option[value="TIMELINE"]')
    expect(tlOption).toBeTruthy()
    // Description rendered in the editor panel with interpolated percent/dates
    expect(screen.getByText(/Available at 50% from W2 to W8/)).toBeVisible()
    // Percentage visible (label text, not label+for association)
    expect(screen.getByText('Available %')).toBeInTheDocument()
    // Date fields visible
    expect(screen.getByText('Available from')).toBeInTheDocument()
    expect(screen.getByText('Available to')).toBeInTheDocument()
    expect(screen.getByTestId('allocation-save')).toBeInTheDocument()
  })

  it('CAPACITY_PLAN editor: label, description, no scalar controls, no Save, nav button', () => {
    const segments = [
      { startWeek: 2, endWeek: 4, capacityPercent: 80 },
      { startWeek: 5, endWeek: 8, capacityPercent: 100 },
    ]
    const capacityProfile = {
      resolutionSource: 'PROFILE' as const,
      planningBasis: 'capacityProfile' as const,
      source: 'squadPlanner' as const,
      defaultPercent: null as number | null,
      startWeek: null as number | null,
      endWeek: null as number | null,
      segments,
    }
    const rowBase = {
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
      allocationMode: 'EFFORT' as const,
      allocationPercent: 100,
      allocationStartWeek: null,
      allocationEndWeek: null,
      derivedStartWeek: null,
      derivedEndWeek: null,
      estimatedCost: 5000,
      epics: [] as Array<never>,
      namedResources: [] as Array<never>,
      capacityProfile,
    }
    const profile = {
      projectId: 'p',
      hoursPerDay: 8,
      projectDurationWeeks: 10,
      bufferWeeks: 0,
      onboardingWeeks: 0,
      resourceRows: [rowBase],
      overheadRows: [] as Array<never>,
      summary: { totalHours: 80, totalDays: 10, totalCost: 5000, hasCost: false },
    }
    const filteredResourceRows = [rowBase]

    const { container } = renderWithRouter(<ResourceProfileTab {...createProps(1, {
      profile,
      filteredResourceRows,
      editingAllocation: 'rt-dev',
      allocationDraft: { allocationMode: 'CAPACITY_PLAN', allocationPercent: 100, allocationStartWeek: null, allocationEndWeek: null },
    })} />)

    // Label
    expect(screen.getAllByText('Varies by week').length).toBeGreaterThanOrEqual(1)
    expect(screen.getByText(/Availability varies by week\. Open the weekly profile editor/i)).toBeVisible()
    // No scalar controls
    expect(container.querySelector('select[aria-label="Availability pattern"]')).toBeNull()
    // No Save (CAPACITY_PLAN uses Close, not Save)
    expect(screen.queryByTestId('allocation-save')).toBeNull()
    // Segment summary visible
    expect(screen.getByText(/W3-W5: 80%/)).toBeInTheDocument()
    expect(screen.getByText(/W6-W9: 100%/)).toBeInTheDocument()
    // Navigation button present
    const navButtons = screen.getAllByText(/Open weekly profile editor/i)
    expect(navButtons.length).toBeGreaterThanOrEqual(1)
  })
})


describe('ResourceProfileTab authoritative Period column', () => {
  it('uses authoritative availability-window dates instead of stale scalar dates everywhere', () => {
    const row = {
      resourceTypeId: 'rt-dev', name: 'Developer', category: 'ENG', count: 1, hoursPerDay: 8, dayRate: 500,
      totalHours: 80, totalDays: 10, effortDays: 10, allocatedDays: 10, allocationMode: 'TIMELINE',
      allocationPercent: 100, allocationStartWeek: 2, allocationEndWeek: 6, derivedStartWeek: null, derivedEndWeek: null,
      estimatedCost: 5000, epics: [], namedResources: [],
      capacityProfile: {
        resolutionSource: 'PROFILE' as const, planningBasis: 'availabilityWindow' as const, source: 'availabilityWindow' as const,
        defaultPercent: 75, startWeek: 3, endWeek: 8, segments: [],
      },
    }
    const profile = {
      projectId: 'p', hoursPerDay: 8, projectDurationWeeks: 10, bufferWeeks: 0, onboardingWeeks: 0,
      resourceRows: [row], overheadRows: [], summary: { totalHours: 80, totalDays: 10, totalCost: 5000, hasCost: false },
    }

    const { container } = renderWithRouter(<ResourceProfileTab {...createProps(1, { profile, filteredResourceRows: [row] })} />)
    const profileRow = within(container).getByTestId('resource-profile-row-rt-dev')
    const badge = within(profileRow).getByTitle('Click to edit allocation')

    expect(badge.textContent).toBe('Fixed for selected weeks · 75%')
    expect(within(profileRow).getByText('Availability window')).toBeInTheDocument()
    expect(screen.getByText(/Profile source: Availability window/)).toBeInTheDocument()
    expect(within(profileRow).getAllByText('Wk 3 – Wk 8')).toHaveLength(2)
    expect(screen.queryByText(/Wk 2.*Wk 6/)).toBeNull()
  })

  it('renders Varies by week in Period for segmented capacity profiles instead of stale scalar dates', () => {
    const row = {
      resourceTypeId: 'rt-dev', name: 'Developer', category: 'ENG', count: 1, hoursPerDay: 8, dayRate: 500,
      totalHours: 80, totalDays: 10, effortDays: 10, allocatedDays: 10, allocationMode: 'EFFORT',
      allocationPercent: 100, allocationStartWeek: 2, allocationEndWeek: 6, derivedStartWeek: null, derivedEndWeek: null,
      estimatedCost: 5000, epics: [], namedResources: [],
      capacityProfile: {
        resolutionSource: 'PROFILE' as const, planningBasis: 'capacityProfile' as const, source: 'squadPlanner' as const,
        defaultPercent: 75, startWeek: 0, endWeek: 8,
        segments: [{ startWeek: 0, endWeek: 3, capacityPercent: 50 }, { startWeek: 4, endWeek: 8, capacityPercent: 100 }],
      },
    }
    const profile = {
      projectId: 'p', hoursPerDay: 8, projectDurationWeeks: 10, bufferWeeks: 0, onboardingWeeks: 0,
      resourceRows: [row], overheadRows: [], summary: { totalHours: 80, totalDays: 10, totalCost: 5000, hasCost: false },
    }

    const { container } = renderWithRouter(<ResourceProfileTab {...createProps(1, { profile, filteredResourceRows: [row] })} />)
    const profileRow = within(container).getByTestId('resource-profile-row-rt-dev')

    expect(within(profileRow).getAllByText('Varies by week')).toHaveLength(2)
    expect(within(profileRow).queryByText(/Wk 2.*Wk 6/)).toBeNull()
  })
})
