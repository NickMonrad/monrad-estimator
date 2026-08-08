/**
 * ResourceProfilePage.reset.test.tsx — Unit tests for the Reset Planning
 * workflow on the Resource Profile page (issue #449):
 *
 *   - "Reset planning…" is exposed for a CURRENT project and hidden when the
 *     project already needs replanning;
 *   - confirmation dialog copy explains preserve/discard;
 *   - cancel does nothing; confirm calls the reset API and shows feedback;
 *   - reset failure surfaces an actionable error;
 *   - the NEEDS_REPLAN banner is rendered and the Commercial tab is replaced
 *     by the planning-required notice while quarantined.
 */

import React from 'react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import ResourceProfilePage from '@/pages/ResourceProfilePage'
import { resetProjectPlanning } from '@/lib/api'

vi.mock('@/lib/api', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return { ...actual, resetProjectPlanning: vi.fn() }
})

vi.mock('@/hooks/useResourceProfile', async importOriginal => {
  const actual = await importOriginal<typeof import('@/hooks/useResourceProfile')>()
  return { ...actual, useResourceProfile: vi.fn() }
})

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ user: { name: 'Test User', email: 'test@example.com' }, logout: vi.fn() }),
}))

// The page-level tests exercise reset/banner/commercial gating only; the tab
// internals are covered by their own test suites.
vi.mock('@/components/resource-profile/ResourceProfileTab', () => ({
  default: () => <div data-testid="resource-profile-tab" />,
}))
vi.mock('@/components/resource-profile/CommercialTab', () => ({
  default: () => <div data-testid="commercial-tab" />,
}))

import { useResourceProfile, formatNumber } from '@/hooks/useResourceProfile'

function baseState(overrides: Record<string, unknown> = {}) {
  return {
    projectId: 'project-1',
    navigate: vi.fn(),
    qc: new QueryClient(),
    project: { id: 'project-1', name: 'Alpha', planningState: 'CURRENT' },
    profile: {
      projectId: 'project-1',
      planningState: 'CURRENT',
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
    discounts: [],
    rateCards: [],
    activeTab: 'profile' as const,
    setActiveTab: vi.fn(),
    handleExportProfile: vi.fn(),
    handleExportFull: vi.fn(),
    ...overrides,
  }
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/projects/project-1/resource-profile']}>
        <Routes>
          <Route path="/projects/:id/resource-profile" element={<ResourceProfilePage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

beforeEach(() => vi.clearAllMocks())

describe('Reset Planning on the Resource Profile page', () => {
  it('exposes Reset planning… for a CURRENT project', () => {
    vi.mocked(useResourceProfile).mockReturnValue(baseState() as never)
    renderPage()
    expect(screen.getByRole('button', { name: 'Reset planning…' })).toBeInTheDocument()
    expect(screen.queryByTestId('planning-needs-attention')).not.toBeInTheDocument()
  })

  it('hides Reset planning… and shows the banner when the project needs replanning', () => {
    vi.mocked(useResourceProfile).mockReturnValue(
      baseState({ project: { id: 'project-1', name: 'Alpha', planningState: 'NEEDS_REPLAN' }, profile: undefined }) as never,
    )
    renderPage()
    expect(screen.queryByRole('button', { name: 'Reset planning…' })).not.toBeInTheDocument()
    expect(screen.getByTestId('planning-needs-attention')).toBeInTheDocument()
  })

  it('cancel closes the confirmation dialog without calling the API', () => {
    vi.mocked(useResourceProfile).mockReturnValue(baseState() as never)
    renderPage()

    fireEvent.click(screen.getByRole('button', { name: 'Reset planning…' }))
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(screen.getByText(/capacity profiles, capacity plans, planned resources and schedule output are removed/i)).toBeInTheDocument()
    expect(screen.getByText(/The project, backlog, effort estimates and dependencies are kept/i)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(resetProjectPlanning).not.toHaveBeenCalled()
  })

  it('confirm calls the reset API and reports the new state', async () => {
    vi.mocked(useResourceProfile).mockReturnValue(baseState() as never)
    vi.mocked(resetProjectPlanning).mockResolvedValue({ projectId: 'project-1', planningState: 'NEEDS_REPLAN' })
    renderPage()

    fireEvent.click(screen.getByRole('button', { name: 'Reset planning…' }))
    fireEvent.click(screen.getByRole('button', { name: 'Reset planning' }))

    await waitFor(() => expect(resetProjectPlanning).toHaveBeenCalledWith('project-1'))
    await waitFor(() => {
      expect(screen.getByTestId('reset-feedback')).toHaveTextContent(/Planning reset/)
    })
  })

  it('surfaces a reset failure instead of failing silently', async () => {
    vi.mocked(useResourceProfile).mockReturnValue(baseState() as never)
    vi.mocked(resetProjectPlanning).mockRejectedValue({ response: { data: { error: 'Reset failed hard' } } })
    renderPage()

    fireEvent.click(screen.getByRole('button', { name: 'Reset planning…' }))
    fireEvent.click(screen.getByRole('button', { name: 'Reset planning' }))

    await waitFor(() => expect(screen.getByTestId('reset-feedback')).toHaveTextContent('Reset failed hard'))
  })

  it('replaces the Commercial tab with the planning-required notice while NEEDS_REPLAN', () => {
    vi.mocked(useResourceProfile).mockReturnValue(
      baseState({ project: { id: 'project-1', name: 'Alpha', planningState: 'NEEDS_REPLAN' }, profile: undefined, activeTab: 'commercial' as const }) as never,
    )
    renderPage()
    expect(screen.getByText('Commercial totals need a current plan')).toBeInTheDocument()
    expect(screen.getByText(/Replan from the existing backlog first/i)).toBeInTheDocument()
  })
})

// Keep the import used for type-level re-export parity.
void formatNumber
