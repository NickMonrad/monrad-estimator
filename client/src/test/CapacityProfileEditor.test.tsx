/**
 * CapacityProfileEditor.test.tsx — Tests for the capacity profile editor
 * and its modal wrapper.
 *
 * @see issue #363 — Capacity profile segment editor
 */

import React from 'react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import CapacityProfileEditor from '@/components/resource-profile/CapacityProfileEditor'
import CapacityProfileEditorModal from '@/components/resource-profile/CapacityProfileEditorModal'

const { mockPut } = vi.hoisted(() => ({
  mockPut: vi.fn().mockResolvedValue({ data: { capacityProfile: {} } }),
}))

vi.mock('../lib/api', () => ({
  api: {
    put: mockPut,
  },
}))

import { api } from '../lib/api'


// ─── Wrapper ────────────────────────────────────────────────────────────────
function renderEditor(element: React.ReactElement) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries')

  const { container } = render(<QueryClientProvider client={queryClient}>{element}</QueryClientProvider>)

  return { queryClient, invalidateSpy, container }
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('CapacityProfileEditor — demandFollowing', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('renders with default values for create mode', () => {
    renderEditor(
      <CapacityProfileEditor
        projectId="proj-1"
        ownerKind="ROLE"
        ownerId="rt-1"
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />,
    )

    expect(screen.getByTestId('capacity-profile-editor')).toBeInTheDocument()
    expect(screen.getByTestId('cp-planning-basis-select')).toHaveValue('demandFollowing')
    expect(screen.getByTestId('cp-default-pct-input')).toHaveValue(100)
  })

  it('shows default percent input for demandFollowing', () => {
    renderEditor(
      <CapacityProfileEditor
        projectId="proj-1"
        ownerKind="ROLE"
        ownerId="rt-1"
        initialProfile={{ planningBasis: 'demandFollowing', defaultPercent: 80, startWeek: null, endWeek: null, segments: [] }}
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />,
    )

    expect(screen.getByTestId('cp-planning-basis-select')).toHaveValue('demandFollowing')
    expect(screen.getByTestId('cp-default-pct-input')).toHaveValue(80)
    expect(screen.queryByTestId('cp-start-week-input')).not.toBeInTheDocument()
    expect(screen.queryByTestId('cp-segments-section')).not.toBeInTheDocument()
  })

  it('calls api.put and onSaved on submit', async () => {
    const onSaved = vi.fn()
    mockPut.mockResolvedValue({ data: { capacityProfile: {} } })

    renderEditor(
      <CapacityProfileEditor
        projectId="proj-1"
        ownerKind="ROLE"
        ownerId="rt-1"
        onSaved={onSaved}
        onCancel={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByTestId('cp-save-btn'))

    await waitFor(() => {
      expect(mockPut).toHaveBeenCalledWith(
        '/api/projects/proj-1/capacity-profiles/ROLE/rt-1',
        expect.objectContaining({ planningBasis: 'demandFollowing', defaultPercent: 100 }),
      )
    })
  })
  it('calls onCancel when cancel is clicked', () => {
    const onCancel = vi.fn()
    renderEditor(
      <CapacityProfileEditor
        projectId="proj-1"
        ownerKind="ROLE"
        ownerId="rt-1"
        onSaved={vi.fn()}
        onCancel={onCancel}
      />,
    )

    fireEvent.click(screen.getByTestId('cp-cancel-btn'))
    expect(onCancel).toHaveBeenCalledTimes(1)
  })
})

describe('CapacityProfileEditor — wholeProjectAllocation', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('shows default percent and no window inputs', () => {
    renderEditor(
      <CapacityProfileEditor
        projectId="proj-1"
        ownerKind="ROLE"
        ownerId="rt-1"
        initialProfile={{ planningBasis: 'wholeProjectAllocation', defaultPercent: 100, startWeek: null, endWeek: null, segments: [] }}
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />,
    )

    expect(screen.getByTestId('cp-planning-basis-select')).toHaveValue('wholeProjectAllocation')
    expect(screen.getByTestId('cp-default-pct-input')).toHaveValue(100)
    expect(screen.queryByTestId('cp-start-week-input')).not.toBeInTheDocument()
    expect(screen.queryByTestId('cp-end-week-input')).not.toBeInTheDocument()
  })
})

describe('CapacityProfileEditor — availabilityWindow', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('shows default percent and week window inputs', () => {
    renderEditor(
      <CapacityProfileEditor
        projectId="proj-1"
        ownerKind="ROLE"
        ownerId="rt-1"
        initialProfile={{ planningBasis: 'availabilityWindow', defaultPercent: 80, startWeek: 2, endWeek: 10, segments: [] }}
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />,
    )

    expect(screen.getByTestId('cp-planning-basis-select')).toHaveValue('availabilityWindow')
    expect(screen.getByTestId('cp-default-pct-input')).toHaveValue(80)
    expect(screen.getByTestId('cp-start-week-input')).toHaveValue(2)
    expect(screen.getByTestId('cp-end-week-input')).toHaveValue(10)
  })

  it('changes planning basis and shows window inputs', () => {
    renderEditor(
      <CapacityProfileEditor
        projectId="proj-1"
        ownerKind="ROLE"
        ownerId="rt-1"
        initialProfile={{ planningBasis: 'demandFollowing', defaultPercent: 100, startWeek: null, endWeek: null, segments: [] }}
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />,
    )

    // Switch to availabilityWindow
    fireEvent.change(screen.getByTestId('cp-planning-basis-select'), { target: { value: 'availabilityWindow' } })

    expect(screen.getByTestId('cp-default-pct-input')).toBeInTheDocument()
    expect(screen.getByTestId('cp-start-week-input')).toBeInTheDocument()
    expect(screen.getByTestId('cp-end-week-input')).toBeInTheDocument()
  })
})

describe('CapacityProfileEditor — capacityProfile (segments)', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('shows segments section with default single empty row', () => {
    renderEditor(
      <CapacityProfileEditor
        projectId="proj-1"
        ownerKind="ROLE"
        ownerId="rt-1"
        initialProfile={{ planningBasis: 'capacityProfile', defaultPercent: null, startWeek: null, endWeek: null, segments: [] }}
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />,
    )

    expect(screen.getByTestId('cp-planning-basis-select')).toHaveValue('capacityProfile')
    expect(screen.queryByTestId('cp-default-pct-input')).not.toBeInTheDocument()
    expect(screen.getByTestId('cp-segments-section')).toBeInTheDocument()
    expect(screen.getByTestId('cp-segment-row-0')).toBeInTheDocument()
  })

  it('adds and removes segments', () => {
    renderEditor(
      <CapacityProfileEditor
        projectId="proj-1"
        ownerKind="ROLE"
        ownerId="rt-1"
        initialProfile={{ planningBasis: 'capacityProfile', defaultPercent: null, startWeek: null, endWeek: null, segments: [{ startWeek: 0, endWeek: 4, capacityPercent: 100 }] }}
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />,
    )

    expect(screen.getByTestId('cp-segment-row-0')).toBeInTheDocument()
    expect(screen.getByTestId('cp-seg-start-0')).toHaveValue(0)
    expect(screen.getByTestId('cp-seg-end-0')).toHaveValue(4)
    expect(screen.getByTestId('cp-seg-pct-0')).toHaveValue(100)

    // Add segment
    fireEvent.click(screen.getByTestId('cp-add-segment'))
    expect(screen.getByTestId('cp-segment-row-1')).toBeInTheDocument()

    // Remove first segment — since length > 1, should work
    fireEvent.click(screen.getByTestId('cp-seg-remove-1'))
    expect(screen.queryByTestId('cp-segment-row-1')).not.toBeInTheDocument()
  })

  it('sends segments in the request body', async () => {
    const onSaved = vi.fn()
    mockPut.mockResolvedValue({ data: { capacityProfile: {} } })

    renderEditor(
      <CapacityProfileEditor
        projectId="proj-1"
        ownerKind="ROLE"
        ownerId="rt-1"
        initialProfile={{ planningBasis: 'capacityProfile', defaultPercent: null, startWeek: null, endWeek: null, segments: [{ startWeek: 0, endWeek: 4, capacityPercent: 100 }] }}
        onSaved={onSaved}
        onCancel={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByTestId('cp-save-btn'))

    await waitFor(() => {
      expect(mockPut).toHaveBeenCalledWith(
        '/api/projects/proj-1/capacity-profiles/ROLE/rt-1',
        expect.objectContaining({
          planningBasis: 'capacityProfile',
          segments: [{ startWeek: 0, endWeek: 4, capacityPercent: 100 }],
        }),
      )
    })
  })

  it('validates segment start <= end', () => {
    renderEditor(
      <CapacityProfileEditor
        projectId="proj-1"
        ownerKind="ROLE"
        ownerId="rt-1"
        initialProfile={{ planningBasis: 'capacityProfile', defaultPercent: null, startWeek: null, endWeek: null, segments: [{ startWeek: 5, endWeek: 2, capacityPercent: 100 }] }}
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByTestId('cp-save-btn'))

    expect(screen.getByTestId('cp-error')).toBeInTheDocument()
    expect(screen.getByTestId('cp-error').textContent).toContain('start week must be ≤ end week')
  })
})

describe('CapacityProfileEditor — readOnly', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('renders profile data as text in readOnly mode', () => {
    const { container } = renderEditor(
      <CapacityProfileEditor
        projectId="proj-1"
        ownerKind="ROLE"
        ownerId="rt-1"
        initialProfile={{ planningBasis: 'availabilityWindow', defaultPercent: 75, startWeek: 1, endWeek: 8, segments: [] }}
        readOnly={true}
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />,
    )

    expect(container.textContent).toContain('Fixed for selected weeks')
    expect(container.textContent).toContain('75%')
    expect(container.textContent).toContain('W2')
    expect(container.textContent).toContain('W9')
  })

  it('renders segments in readOnly mode', () => {
    const { container } = renderEditor(
      <CapacityProfileEditor
        projectId="proj-1"
        ownerKind="ROLE"
        ownerId="rt-1"
        initialProfile={{ planningBasis: 'capacityProfile', defaultPercent: null, startWeek: null, endWeek: null, segments: [{ startWeek: 0, endWeek: 4, capacityPercent: 100 }, { startWeek: 5, endWeek: 9, capacityPercent: 80 }] }}
        readOnly={true}
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />,
    )

    expect(container.textContent).toContain('Varies by week')
    expect(container.textContent).toContain('W1 - W5: 100%')
    expect(container.textContent).toContain('W6 - W10: 80%')
  })

  it('shows no form inputs in readOnly mode', () => {
    renderEditor(
      <CapacityProfileEditor
        projectId="proj-1"
        ownerKind="ROLE"
        ownerId="rt-1"
        initialProfile={{ planningBasis: 'demandFollowing', defaultPercent: 100, startWeek: null, endWeek: null, segments: [] }}
        readOnly={true}
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />,
    )

    expect(screen.queryByTestId('cp-planning-basis-select')).not.toBeInTheDocument()
    expect(screen.queryByTestId('cp-default-pct-input')).not.toBeInTheDocument()
    expect(screen.queryByTestId('cp-save-btn')).not.toBeInTheDocument()
  })
})

describe('CapacityProfileEditor — planner managed', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('shows Squad Planner link when plannerSquadLink is provided', () => {
    const { container } = renderEditor(
      <CapacityProfileEditor
        projectId="proj-1"
        ownerKind="ROLE"
        ownerId="rt-1"
        initialProfile={{ planningBasis: 'capacityProfile', defaultPercent: null, startWeek: null, endWeek: null, segments: [] }}
        plannerSquadLink="/projects/proj-1/timeline?panel=squad-planner"
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />,
    )

    expect(container.textContent).toContain('Managed by Squad Planner')
    const link = screen.getByText('Open Squad Planner ↗')
    expect(link).toBeInTheDocument()
    expect(link.closest('a')).toHaveAttribute('href', '/projects/proj-1/timeline?panel=squad-planner')
  })

  it('shows no form inputs in planner managed mode', () => {
    renderEditor(
      <CapacityProfileEditor
        projectId="proj-1"
        ownerKind="ROLE"
        ownerId="rt-1"
        plannerSquadLink="/projects/proj-1/timeline?panel=squad-planner"
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />,
    )

    expect(screen.queryByTestId('cp-planning-basis-select')).not.toBeInTheDocument()
    expect(screen.queryByTestId('cp-save-btn')).not.toBeInTheDocument()
  })
})

describe('CapacityProfileEditor — NAMED_PERSON owner', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('calls api.put with NAMED_PERSON owner kind', async () => {
    mockPut.mockResolvedValue({ data: { capacityProfile: {} } })

    renderEditor(
      <CapacityProfileEditor
        projectId="proj-1"
        ownerKind="NAMED_PERSON"
        ownerId="nr-1"
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByTestId('cp-save-btn'))

    await waitFor(() => {
      expect(mockPut).toHaveBeenCalledWith(
        '/api/projects/proj-1/capacity-profiles/NAMED_PERSON/nr-1',
        expect.anything(),
      )
    })
  })
})
describe('CapacityProfileEditorModal', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('renders nothing when isOpen is false', () => {
    const { container } = renderEditor(
      <CapacityProfileEditorModal
        isOpen={false}
        onClose={vi.fn()}
        projectId="proj-1"
        ownerKind="ROLE"
        ownerId="rt-1"
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />,
    )

    expect(container.innerHTML).toBe('')
  })

  it('renders editor when isOpen is true', () => {
    renderEditor(
      <CapacityProfileEditorModal
        isOpen={true}
        onClose={vi.fn()}
        projectId="proj-1"
        ownerKind="ROLE"
        ownerId="rt-1"
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />,
    )

    expect(screen.getByTestId('capacity-profile-editor')).toBeInTheDocument()
    expect(screen.getByText('Create Capacity Profile')).toBeInTheDocument()
  })

  it('shows Edit title when initialProfile provided', () => {
    renderEditor(
      <CapacityProfileEditorModal
        isOpen={true}
        onClose={vi.fn()}
        projectId="proj-1"
        ownerKind="ROLE"
        ownerId="rt-1"
        initialProfile={{ planningBasis: 'demandFollowing', defaultPercent: 100, startWeek: null, endWeek: null, segments: [] }}
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />,
    )

    expect(screen.getByText('Edit Capacity Profile')).toBeInTheDocument()
  })

  it('closes on Escape key', () => {
    const onClose = vi.fn()
    renderEditor(
      <CapacityProfileEditorModal
        isOpen={true}
        onClose={onClose}
        projectId="proj-1"
        ownerKind="ROLE"
        ownerId="rt-1"
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />,
    )

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('closes on backdrop click', () => {
    const onClose = vi.fn()
    const { container } = render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <CapacityProfileEditorModal
          isOpen={true}
          onClose={onClose}
          projectId="proj-1"
          ownerKind="ROLE"
          ownerId="rt-1"
          onSaved={vi.fn()}
          onCancel={vi.fn()}
        />
      </QueryClientProvider>,
    )

    // Click the backdrop (first child of overlay)
    const overlay = container.firstChild as HTMLElement
    fireEvent.click(overlay)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('does not close on inner content click', () => {
    const onClose = vi.fn()
    renderEditor(
      <CapacityProfileEditorModal
        isOpen={true}
        onClose={onClose}
        projectId="proj-1"
        ownerKind="ROLE"
        ownerId="rt-1"
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />,
    )

    // Click on the modal content (form)
    fireEvent.click(screen.getByTestId('capacity-profile-editor'))
    expect(onClose).not.toHaveBeenCalled()
  })
})

describe('CapacityProfileEditor — validation', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('shows error for invalid segment capacity percent', async () => {
    renderEditor(
      <CapacityProfileEditor
        projectId="proj-1"
        ownerKind="ROLE"
        ownerId="rt-1"
        initialProfile={{ planningBasis: 'capacityProfile', defaultPercent: null, startWeek: null, endWeek: null, segments: [{ startWeek: 0, endWeek: 4, capacityPercent: 150 }] }}
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />,
    )

    // Submit the form directly to ensure submit handler fires
    const form = screen.getByTestId('capacity-profile-editor')
    fireEvent.submit(form)

    await waitFor(() => {
      expect(screen.getByTestId('cp-error')).toBeInTheDocument()
    })
    expect(screen.getByTestId('cp-error').textContent).toContain('capacity percent must be between 0 and 100')
  })
})
