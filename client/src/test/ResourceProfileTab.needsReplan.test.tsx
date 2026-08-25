/**
 * ResourceProfileTab.needsReplan.test.tsx — Unit tests for the issue #456
 * NEEDS_REPLAN Resource Profile behaviour:
 *
 *   - missing persisted ROLE profiles are visibly marked
 *     ("Needs capacity profile") instead of showing the effective
 *     As-needed draft as if it were persisted canonical state;
 *   - the marked row still opens the existing capacity editor (create path);
 *   - a persisted ROLE profile on a NEEDS_REPLAN project renders normally;
 *   - CURRENT-project rows without a profile keep the pre-existing effective
 *     As-needed badge (behaviour unchanged);
 *   - the bulk "Use role counts as As needed" action is exposed only while
 *     NEEDS_REPLAN, calls the API, reports created counts and remaining
 *     findings, and surfaces failures.
 */

import React, { type ComponentProps } from 'react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import ResourceProfileTab from '@/components/resource-profile/ResourceProfileTab'
import { applyNamedPeopleAsNeeded, applyRoleCountsAsNeeded } from '@/lib/api'
import type { ResourceProfileRow } from '@/types/backlog'
vi.mock('@/lib/api', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return { ...actual, applyNamedPeopleAsNeeded: vi.fn(), applyRoleCountsAsNeeded: vi.fn() }
})

function renderWithProviders(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  )
}

interface TestRow {
  resourceTypeId: string
  name: string
  missingCapacityProfile?: boolean
  capacityProfile?: Record<string, unknown>
  namedResources?: Array<{
    id: string
    name: string
    replanStatus?: 'COMPLETE' | 'NEEDS_AVAILABILITY' | 'BLOCKED'
    canUseAsNeeded?: boolean
    replanAction?: 'SET_AVAILABILITY' | 'OPEN_SQUAD_PLANNER'
  }>
}

function row(r: TestRow) {
  return {
    resourceTypeId: r.resourceTypeId,
    name: r.name,
    category: 'ENGINEERING',
    count: 1,
    hoursPerDay: 8,
    dayRate: null,
    totalHours: 100,
    totalDays: 12.5,
    effortDays: 12.5,
    allocatedDays: 12.5,
    allocationMode: 'EFFORT',
    allocationPercent: 100,
    allocationStartWeek: null,
    allocationEndWeek: null,
    derivedStartWeek: null,
    derivedEndWeek: null,
    estimatedCost: null,
    epics: [],
    namedResources: (r.namedResources ?? []) as ResourceProfileRow['namedResources'],
    ...(r.missingCapacityProfile !== undefined ? { missingCapacityProfile: r.missingCapacityProfile } : {}),
    ...(r.capacityProfile ? { capacityProfile: r.capacityProfile } : {}),
  }
}

function createProps(
  rows: TestRow[],
  overrides: Partial<ComponentProps<typeof ResourceProfileTab>> = {},
): ComponentProps<typeof ResourceProfileTab> {
  const resourceRows = rows.map(row)
  const profile: ComponentProps<typeof ResourceProfileTab>['profile'] = {
    projectId: 'project-1',
    planningState: 'NEEDS_REPLAN',
    hoursPerDay: 8,
    projectDurationWeeks: 12,
    bufferWeeks: 0,
    onboardingWeeks: 0,
    resourceRows,
    overheadRows: [],
    summary: { totalHours: 100, totalDays: 12.5, totalCost: null, hasCost: false },
  }
  return {
    projectId: 'project-1',
    profile,
    profileLoading: false,
    overheadItems: [],
    resourceTypes: [],
    filteredResourceRows: resourceRows,
    hasCost: false,
    columnCount: 8,
    chartData: [],
    expandedRows: new Set(),
    expandedNamedResources: new Set(),
    editingId: null,
    form: { name: '', resourceTypeId: '', type: 'PERCENTAGE', value: '' },
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
    getAllocationBadge: () => ({ label: 'As needed', color: 'bg-gray-100 text-gray-600', sub: null }),
    qc: new QueryClient(),
    ...overrides,
  }
}

beforeEach(() => vi.clearAllMocks())

describe('ResourceProfileTab — missing persisted ROLE profiles (issue #456)', () => {
  it('marks a missing persisted ROLE profile instead of showing the effective As-needed draft as persisted', () => {
    renderWithProviders(
      <ResourceProfileTab
        {...createProps([
          { resourceTypeId: 'rt-missing', name: 'Business Analyst', missingCapacityProfile: true },
        ])}
      />,
    )

    const badge = screen.getByTestId('missing-profile-badge-rt-missing')
    expect(badge).toHaveTextContent('Needs capacity profile')
    // The row must not present the effective draft as a valid persisted
    // "As needed" badge.
    expect(badge).not.toHaveTextContent('As needed')
  })

  it('opens the existing capacity editor (create path) from the missing marker', () => {
    renderWithProviders(
      <ResourceProfileTab
        {...createProps([
          { resourceTypeId: 'rt-missing', name: 'Business Analyst', missingCapacityProfile: true },
        ])}
      />,
    )

    fireEvent.click(screen.getByTestId('missing-profile-badge-rt-missing'))

    expect(screen.getByRole('dialog', { name: 'Edit capacity profile' })).toBeInTheDocument()
    expect(screen.getByText('Create Capacity Profile')).toBeInTheDocument()
  })

  it('shows a persisted ROLE profile as normal state on a NEEDS_REPLAN project', () => {
    renderWithProviders(
      <ResourceProfileTab
        {...createProps([
          {
            resourceTypeId: 'rt-persisted',
            name: 'Security Consultant',
            capacityProfile: {
              planningBasis: 'demandFollowing',
              source: 'manual',
              defaultPercent: 100,
              startWeek: null,
              endWeek: null,
              segments: [],
              resolutionSource: 'PROFILE',
            },
          },
        ])}
      />,
    )

    expect(screen.queryByTestId('missing-profile-badge-rt-persisted')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'As needed' })).toBeInTheDocument()
  })

  it('keeps CURRENT-project rows without a profile showing the effective As-needed badge (unchanged)', () => {
    const currentRow = row({ resourceTypeId: 'rt-current', name: 'Business Analyst' })
    const props = createProps([{ resourceTypeId: 'rt-current', name: 'Business Analyst' }], {
      profile: {
        projectId: 'project-1',
        planningState: 'CURRENT',
        hoursPerDay: 8,
        projectDurationWeeks: 12,
        bufferWeeks: 0,
        onboardingWeeks: 0,
        resourceRows: [currentRow],
        overheadRows: [],
        summary: { totalHours: 0, totalDays: 0, totalCost: null, hasCost: false },
      },
    })
    // CURRENT project: rows keep the effective draft badge; no missing marker.
    props.filteredResourceRows = [currentRow]

    renderWithProviders(<ResourceProfileTab {...props} />)

    expect(screen.queryByTestId('missing-profile-badge-rt-current')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'As needed' })).toBeInTheDocument()
  })
})

describe('ResourceProfileTab — bulk Use role counts as As needed (issue #456)', () => {
  it('exposes the bulk action only while NEEDS_REPLAN', () => {
    renderWithProviders(
      <ResourceProfileTab
        {...createProps([
          { resourceTypeId: 'rt-missing', name: 'Business Analyst', missingCapacityProfile: true },
        ])}
      />,
    )
    expect(screen.getByRole('button', { name: 'Use role counts as As needed' })).toBeInTheDocument()
  })

  it('hides the bulk action for a CURRENT project', () => {
    const currentRow = row({ resourceTypeId: 'rt-current', name: 'Business Analyst' })
    const props = createProps([{ resourceTypeId: 'rt-current', name: 'Business Analyst' }], {
      profile: {
        projectId: 'project-1',
        planningState: 'CURRENT',
        hoursPerDay: 8,
        projectDurationWeeks: 12,
        bufferWeeks: 0,
        onboardingWeeks: 0,
        resourceRows: [currentRow],
        overheadRows: [],
        summary: { totalHours: 0, totalDays: 0, totalCost: null, hasCost: false },
      },
    })
    props.filteredResourceRows = [currentRow]

    renderWithProviders(<ResourceProfileTab {...props} />)

    expect(screen.queryByRole('button', { name: 'Use role counts as As needed' })).not.toBeInTheDocument()
  })

  it('calls the bulk API and reports the created count', async () => {
    vi.mocked(applyRoleCountsAsNeeded).mockResolvedValue({
      projectId: 'project-1',
      planningState: 'NEEDS_REPLAN',
      created: 2,
      remainingFindings: [],
    })
    renderWithProviders(
      <ResourceProfileTab
        {...createProps([
          { resourceTypeId: 'rt-missing', name: 'Business Analyst', missingCapacityProfile: true },
        ])}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Use role counts as As needed' }))

    await waitFor(() => expect(applyRoleCountsAsNeeded).toHaveBeenCalledWith('project-1'))
    await waitFor(() => {
      expect(screen.getByTestId('bulk-as-needed-feedback')).toHaveTextContent(
        'Created As needed capacity profiles for 2 roles.',
      )
    })
  })

  it('separates successful role writes from remaining recovery blockers', async () => {
    vi.mocked(applyRoleCountsAsNeeded).mockResolvedValue({
      projectId: 'project-1',
      planningState: 'NEEDS_REPLAN',
      created: 1,
      remainingFindings: [
        'Named resource "Alice Example" lacks persisted profile (named resource nr-1, resource type rt-3)',
      ],
    })
    renderWithProviders(
      <ResourceProfileTab
        {...createProps([
          { resourceTypeId: 'rt-missing', name: 'Business Analyst', missingCapacityProfile: true },
        ])}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Use role counts as As needed' }))

    await waitFor(() => {
      expect(screen.getByTestId('bulk-as-needed-feedback')).toHaveTextContent('Role profiles were created')
    })
    expect(screen.getByTestId('bulk-as-needed-feedback')).not.toHaveTextContent('Alice Example')
  })

  it('surfaces a bulk action failure instead of failing silently', async () => {
    vi.mocked(applyRoleCountsAsNeeded).mockRejectedValue({
      response: { data: { error: 'This action is only available while the project needs replanning.' } },
    })
    renderWithProviders(
      <ResourceProfileTab
        {...createProps([
          { resourceTypeId: 'rt-missing', name: 'Business Analyst', missingCapacityProfile: true },
        ])}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Use role counts as As needed' }))

    await waitFor(() => {
      expect(screen.getByTestId('bulk-as-needed-error')).toHaveTextContent(
        'This action is only available while the project needs replanning.',
      )
    })
  })
})

describe('ResourceProfileTab — named-person recovery (issue #474)', () => {
  const namedBlocker = {
    id: 'nr-alice',
    name: 'Alice Example',
    replanStatus: 'NEEDS_AVAILABILITY' as const,
    canUseAsNeeded: true,
    replanAction: 'SET_AVAILABILITY' as const,
  }

  it('shows the named resource, parent role, and direct availability action', () => {
    renderWithProviders(
      <ResourceProfileTab
        {...createProps([
          { resourceTypeId: 'rt-engineering', name: 'Platform Engineer', namedResources: [namedBlocker] },
        ])}
      />,
    )

    expect(screen.getByTestId('replan-recovery-summary')).toHaveTextContent('Alice Example')
    expect(screen.getByTestId('replan-recovery-summary')).toHaveTextContent('Role: Platform Engineer')
    fireEvent.click(screen.getByTestId('set-availability-nr-alice'))
    expect(screen.getByRole('dialog', { name: 'Edit capacity profile' })).toBeInTheDocument()
    expect(screen.getByText('Create Capacity Profile')).toBeInTheDocument()
  })

  it('offers the safe named-person bulk action and separates its success from remaining blockers', async () => {
    vi.mocked(applyNamedPeopleAsNeeded).mockResolvedValue({
      projectId: 'project-1',
      planningState: 'NEEDS_REPLAN',
      created: 1,
      remainingFindings: ['Named resource "Planner Person" lacks persisted profile'],
    })
    renderWithProviders(
      <ResourceProfileTab
        {...createProps([
          {
            resourceTypeId: 'rt-engineering',
            name: 'Platform Engineer',
            namedResources: [
              namedBlocker,
              {
                id: 'nr-planner',
                name: 'Planner Person',
                replanStatus: 'BLOCKED',
                canUseAsNeeded: false,
                replanAction: 'OPEN_SQUAD_PLANNER',
              },
            ],
          },
        ])}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Use As needed for eligible named people' }))
    await waitFor(() => expect(applyNamedPeopleAsNeeded).toHaveBeenCalledWith('project-1'))
    await waitFor(() => expect(screen.getByTestId('bulk-named-as-needed-feedback')).toHaveTextContent('Created As needed availability for 1 named resource.'))
    expect(screen.getByTestId('bulk-named-as-needed-feedback')).toHaveTextContent('Replanning is still incomplete')
  })

  it('does not show a People indicator for an expanded empty role', () => {
    renderWithProviders(
      <ResourceProfileTab
        {...createProps(
          [{ resourceTypeId: 'rt-empty', name: 'Empty Role' }],
          { expandedNamedResources: new Set(['rt-empty']) },
        )}
      />,
    )

    expect(screen.queryByTestId('people-indicator-rt-empty')).not.toBeInTheDocument()
  })
})
