/**
 * ResourceProfileTab transfer-to-manual tests.
 *
 * Tests the "Switch to manual capacity" button behaviour and confirmation dialog
 * in ResourceProfileTab for issue #411.
 */

import React, { type ComponentProps } from 'react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import ResourceProfileTab from '@/components/resource-profile/ResourceProfileTab'
import * as api from '@/lib/api'

vi.mock('@/lib/api', () => ({
  transferToManualCapacity: vi.fn(),
}))

function createTestQueryClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
}

function renderWithProviders(ui: React.ReactElement) {
  const qc = createTestQueryClient()
  return {
    qc,
    ...render(
      <QueryClientProvider client={qc}>
        <MemoryRouter>{ui}</MemoryRouter>
      </QueryClientProvider>,
    ),
  }
}

const baseProfile = {
  projectId: 'project-1',
  hoursPerDay: 8,
  projectDurationWeeks: 12,
  bufferWeeks: 0,
  onboardingWeeks: 0,
  resourceRows: [],
  overheadRows: [],
  summary: { totalHours: 0, totalDays: 0, totalCost: null, hasCost: false },
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

function createProps(
  overrides: Partial<ComponentProps<typeof ResourceProfileTab>> = {},
): ComponentProps<typeof ResourceProfileTab> {
  return {
    projectId: 'project-1',
    profile: baseProfile,
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
    getAllocationBadge: () => ({ label: 'As needed', color: 'bg-gray-100 text-gray-600', sub: null }),
    qc: createTestQueryClient(),
    ...overrides,
  }
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('Switch to manual capacity', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  function createRowWithPlannerProfile() {
    return {
      ...baseRow,
      capacityProfile: {
        id: 'cp-role-1',
        ownerKind: 'role' as const,
        planningBasis: 'capacityProfile' as const,
        source: 'squadPlanner' as const,
        resolutionSource: 'PROFILE' as const,
        defaultPercent: 100,
        startWeek: 0,
        endWeek: 11,
        segments: [
          { startWeek: 0, endWeek: 3, capacityPercent: 100 },
          { startWeek: 4, endWeek: 7, capacityPercent: 75 },
        ],
      },
      namedResources: [],
    }
  }

  it('shows Switch to manual capacity button for a planner-managed role', () => {
    const row = createRowWithPlannerProfile()
    renderWithProviders(
      <ResourceProfileTab
        {...createProps({
          profile: { ...baseProfile, resourceRows: [row] },
          filteredResourceRows: [row],
        })}
        projectId="project-1"
      />,
    )

    expect(screen.getByTitle(/Transfer this role/)).toBeInTheDocument()
    expect(screen.getByText('Switch to manual capacity')).toBeInTheDocument()
  })

  it('hides Switch to manual capacity button for a manually managed role', () => {
    const row = {
      ...baseRow,
      capacityProfile: {
        id: 'cp-role-2',
        ownerKind: 'role' as const,
        planningBasis: 'demandFollowing' as const,
        source: 'manual' as const,
        resolutionSource: 'PROFILE' as const,
        defaultPercent: 100,
        segments: [],
      },
      namedResources: [],
    }
    renderWithProviders(
      <ResourceProfileTab
        {...createProps({
          profile: { ...baseProfile, resourceRows: [row] },
          filteredResourceRows: [row],
        })}
        projectId="project-1"
      />,
    )

    expect(screen.queryByTitle(/Transfer this role/)).not.toBeInTheDocument()
    expect(screen.queryByText('Switch to manual capacity')).not.toBeInTheDocument()
  })

  it('hides Switch to manual capacity button for roles without capacity profile', () => {
    const row = { ...baseRow, namedResources: [] }
    renderWithProviders(
      <ResourceProfileTab
        {...createProps({
          profile: { ...baseProfile, resourceRows: [row] },
          filteredResourceRows: [row],
        })}
        projectId="project-1"
      />,
    )

    expect(screen.queryByTitle(/Transfer this role/)).not.toBeInTheDocument()
    expect(screen.queryByText('Switch to manual capacity')).not.toBeInTheDocument()
  })

  it('shows confirmation dialog with expected content on click', () => {
    const row = createRowWithPlannerProfile()
    renderWithProviders(
      <ResourceProfileTab
        {...createProps({
          profile: { ...baseProfile, resourceRows: [row] },
          filteredResourceRows: [row],
        })}
        projectId="project-1"
      />,
    )

    fireEvent.click(screen.getByTitle(/Transfer this role/))

    expect(screen.getByRole('dialog', { name: /Switch to manual capacity/i })).toBeInTheDocument()
    expect(screen.getByText(/current capacity.*will be preserved/i)).toBeInTheDocument()
    expect(screen.getByText(/Resource Profile.*editing surface/i)).toBeInTheDocument()
    expect(screen.getByText(/no longer.*automatically updated/i)).toBeInTheDocument()
    expect(screen.getByText(/one-way/i)).toBeInTheDocument()
  })

  it('cancelling confirmation closes the dialog without making the API call', () => {
    const row = createRowWithPlannerProfile()
    renderWithProviders(
      <ResourceProfileTab
        {...createProps({
          profile: { ...baseProfile, resourceRows: [row] },
          filteredResourceRows: [row],
        })}
        projectId="project-1"
      />,
    )

    // Open dialog
    fireEvent.click(screen.getByTitle(/Transfer this role/))
    expect(screen.getByRole('dialog')).toBeInTheDocument()

    // Click Cancel
    fireEvent.click(screen.getByText('Cancel'))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(api.transferToManualCapacity).not.toHaveBeenCalled()
  })

  it('calls transferToManualCapacity with correct resourceTypeId on confirm', async () => {
    const mockTransfer = vi.mocked(api.transferToManualCapacity)
    mockTransfer.mockResolvedValue({
      transferred: true,
      result: {
        profilesTransferred: 3,
        plannedResourceProfilesTransferred: 2,
        roleProfileTransferred: true,
        protectedProfileIds: [],
      },
    })

    const row = createRowWithPlannerProfile()
    renderWithProviders(
      <ResourceProfileTab
        {...createProps({
          profile: { ...baseProfile, resourceRows: [row] },
          filteredResourceRows: [row],
        })}
        projectId="project-1"
      />,
    )

    // Open dialog
    fireEvent.click(screen.getByTitle(/Transfer this role/))

    // Confirm — find button inside the dialog
    const dialog = screen.getByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: /Switch to manual capacity/i }))

    await waitFor(() => {
      expect(mockTransfer).toHaveBeenCalledTimes(1)
      expect(mockTransfer).toHaveBeenCalledWith('project-1', 'rt-dev')
    })
  })

  it('prevents duplicate submission while transfer is in progress', async () => {
    const mockTransfer = vi.mocked(api.transferToManualCapacity)
    const { promise: transferPromise, resolve: resolveTransfer } = Promise.withResolvers<api.TransferToManualResult>()
    mockTransfer.mockImplementation(() => transferPromise)

    const row = createRowWithPlannerProfile()
    renderWithProviders(
      <ResourceProfileTab
        {...createProps({
          profile: { ...baseProfile, resourceRows: [row] },
          filteredResourceRows: [row],
        })}
        projectId="project-1"
      />,
    )

    // Open dialog
    fireEvent.click(screen.getByTitle(/Transfer this role/))

    // Wait for dialog to appear
    await waitFor(() => {
      expect(screen.getByRole('dialog')).toBeInTheDocument()
    })

    // Confirm once — find button inside the dialog
    const dialog = screen.getByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: /Switch to manual capacity/i }))

    // The button should show pending state
    await waitFor(() => {
      expect(screen.getByText('Transferring…')).toBeInTheDocument()
    })
    expect(screen.getByText('Transferring…')).toBeDisabled()

    // Resolve the first call
    resolveTransfer({
      transferred: true,
      result: {
        profilesTransferred: 1,
        plannedResourceProfilesTransferred: 0,
        roleProfileTransferred: true,
        protectedProfileIds: [],
      },
    })
    await waitFor(() => {
      expect(mockTransfer).toHaveBeenCalledTimes(1)
    })
  })

  it('shows error state when transfer fails', async () => {
    const mockTransfer = vi.mocked(api.transferToManualCapacity)
    mockTransfer.mockRejectedValue(new Error('Role is not managed by Squad Planner'))

    const row = createRowWithPlannerProfile()
    renderWithProviders(
      <ResourceProfileTab
        {...createProps({
          profile: { ...baseProfile, resourceRows: [row] },
          filteredResourceRows: [row],
        })}
        projectId="project-1"
      />,
    )

    // Open dialog and confirm
    fireEvent.click(screen.getByTitle(/Transfer this role/))
    const dialog = screen.getByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: /Switch to manual capacity/i }))

    await waitFor(() => {
      expect(screen.getByText(/Role is not managed by Squad Planner/)).toBeInTheDocument()
    })

    // Dialog is still open so user can retry or cancel
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('shows role as editable (non-squadPlanner) after successful transfer and refresh', async () => {
    const mockTransfer = vi.mocked(api.transferToManualCapacity)
    mockTransfer.mockResolvedValue({
      transferred: true,
      result: {
        profilesTransferred: 1,
        plannedResourceProfilesTransferred: 0,
        roleProfileTransferred: true,
        protectedProfileIds: [],
      },
    })

    // Start with squadPlanner profile
    const plannerRow = createRowWithPlannerProfile()

    // After transfer, re-render with manual profile
    const { rerender } = renderWithProviders(
      <ResourceProfileTab
        {...createProps({
          profile: { ...baseProfile, resourceRows: [plannerRow] },
          filteredResourceRows: [plannerRow],
        })}
        projectId="project-1"
      />,
    )

    // Initially shows squad planner button
    expect(screen.getByText('Open Squad Planner')).toBeInTheDocument()
    expect(screen.getByTitle(/Transfer this role/)).toBeInTheDocument()

    // Re-render with manual profile (simulating what happens after transfer + refresh)
    const manualRow = {
      ...baseRow,
      capacityProfile: {
        id: 'cp-role-1',
        ownerKind: 'role' as const,
        planningBasis: 'capacityProfile' as const,
        source: 'manual' as const,
        resolutionSource: 'PROFILE' as const,
        defaultPercent: 100,
        startWeek: 0,
        endWeek: 11,
        segments: [
          { startWeek: 0, endWeek: 3, capacityPercent: 100 },
          { startWeek: 4, endWeek: 7, capacityPercent: 75 },
        ],
      },
      namedResources: [],
    }

    rerender(
      <QueryClientProvider client={createTestQueryClient()}>
        <MemoryRouter>
          <ResourceProfileTab
            {...createProps({
              profile: { ...baseProfile, resourceRows: [manualRow] },
              filteredResourceRows: [manualRow],
            })}
            projectId="project-1"
          />
        </MemoryRouter>
      </QueryClientProvider>,
    )

    // Now shows as manual, editable
    expect(screen.queryByText('Open Squad Planner')).not.toBeInTheDocument()
    expect(screen.queryByTitle(/Transfer this role/)).not.toBeInTheDocument()
    // At least one "Varies by week" element is shown (the editable badge)
    expect(screen.getAllByText('Varies by week').length).toBeGreaterThanOrEqual(1)
  })

  describe('Dialog focus and keyboard lifecycle', () => {
    function renderPlannerRole() {
      const row = {
        ...baseRow,
        capacityProfile: {
          id: 'cp-role-focus',
          ownerKind: 'role' as const,
          planningBasis: 'capacityProfile' as const,
          source: 'squadPlanner' as const,
          resolutionSource: 'PROFILE' as const,
          defaultPercent: 100,
          startWeek: 0,
          endWeek: 11,
          segments: [{ startWeek: 0, endWeek: 3, capacityPercent: 100 }],
        },
        namedResources: [],
      }
      return renderWithProviders(
        <ResourceProfileTab
          {...createProps({
            profile: { ...baseProfile, resourceRows: [row] },
            filteredResourceRows: [row],
          })}
          projectId="project-1"
        />,
      )
    }

    function openDialog() {
      fireEvent.click(screen.getByTitle(/Transfer this role/))
    }

    beforeEach(() => {
      vi.clearAllMocks()
    })

    it('confirms confirm button receives initial focus when dialog opens', () => {
      renderPlannerRole()
      openDialog()

      const dialog = screen.getByRole('dialog')
      expect(dialog).toBeInTheDocument()

      // The confirm button (primary action) should have focus
      const confirmButton = within(dialog).getByRole('button', { name: /Switch to manual capacity/i })
      expect(confirmButton).toHaveFocus()
    })

    it('sets accessible name via aria-labelledby linked to visible title', () => {
      renderPlannerRole()
      openDialog()

      const dialog = screen.getByRole('dialog')
      expect(dialog).toHaveAttribute('aria-labelledby', 'transfer-dialog-title')
      const title = document.getElementById('transfer-dialog-title')
      expect(title).toBeInTheDocument()
      expect(title).toHaveTextContent('Switch to manual capacity?')
    })

    it('closes dialog on Escape when no mutation pending', () => {
      renderPlannerRole()
      openDialog()
      expect(screen.getByRole('dialog')).toBeInTheDocument()

      fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
      expect(vi.mocked(api.transferToManualCapacity)).not.toHaveBeenCalled()
    })

    it('restores focus to trigger button after cancel', () => {
      renderPlannerRole()
      const triggerButton = screen.getByTitle(/Transfer this role/)
      triggerButton.focus()
      openDialog()

      // Cancel
      const cancelButton = within(screen.getByRole('dialog')).getByText('Cancel')
      fireEvent.click(cancelButton)

      // Focus should return to trigger
      expect(triggerButton).toHaveFocus()
    })

    it('prevents backdrop click dismissal while pending', async () => {
      const mockTransfer = vi.mocked(api.transferToManualCapacity)
      const { promise } = Promise.withResolvers<api.TransferToManualResult>()
      mockTransfer.mockImplementation(() => promise)

      renderPlannerRole()
      openDialog()

      // Confirm to start mutation
      const dialog = screen.getByRole('dialog')
      fireEvent.click(within(dialog).getByRole('button', { name: /Switch to manual capacity/i }))

      // Wait for pending state
      await waitFor(() => {
        expect(within(dialog).getByText('Transferring…')).toBeDisabled()
      })

      // Backdrop click should NOT close while pending
      fireEvent.click(dialog)
      expect(screen.getByRole('dialog')).toBeInTheDocument()
    })

    it('prevents Escape dismissal while pending', async () => {
      const mockTransfer = vi.mocked(api.transferToManualCapacity)
      const { promise } = Promise.withResolvers<api.TransferToManualResult>()
      mockTransfer.mockImplementation(() => promise)

      renderPlannerRole()
      openDialog()

      // Confirm to start mutation
      const dialog = screen.getByRole('dialog')
      fireEvent.click(within(dialog).getByRole('button', { name: /Switch to manual capacity/i }))

      // Wait for pending state
      await waitFor(() => {
        expect(within(dialog).getByText('Transferring…')).toBeDisabled()
      })

      // Escape should NOT close while pending
      fireEvent.keyDown(dialog, { key: 'Escape' })
      expect(screen.getByRole('dialog')).toBeInTheDocument()
    })

    it('retains dialog with actionable error after failed mutation', async () => {
      const mockTransfer = vi.mocked(api.transferToManualCapacity)
      mockTransfer.mockRejectedValue(new Error('Role is not managed by Squad Planner'))

      renderPlannerRole()
      openDialog()

      const dialog = screen.getByRole('dialog')
      fireEvent.click(within(dialog).getByRole('button', { name: /Switch to manual capacity/i }))

      await waitFor(() => {
        expect(screen.getByText(/Role is not managed by Squad Planner/)).toBeInTheDocument()
      })
      // Dialog remains open with error
      expect(screen.getByRole('dialog')).toBeInTheDocument()
    })

    it('closes dialog after successful mutation', async () => {
      const mockTransfer = vi.mocked(api.transferToManualCapacity)
      mockTransfer.mockResolvedValue({
        transferred: true,
        result: {
          profilesTransferred: 1,
          plannedResourceProfilesTransferred: 0,
          roleProfileTransferred: true,
          protectedProfileIds: [],
        },
      })

      renderPlannerRole()
      openDialog()

      const dialog = screen.getByRole('dialog')
      fireEvent.click(within(dialog).getByRole('button', { name: /Switch to manual capacity/i }))

      await waitFor(() => {
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
      })
    })
  })
})
