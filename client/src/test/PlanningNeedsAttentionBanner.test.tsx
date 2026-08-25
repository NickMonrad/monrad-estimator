/**
 * PlanningNeedsAttentionBanner.test.tsx — Unit tests for the NEEDS_REPLAN
 * banner (issue #449): copy, the single Replan project action, actionable
 * incomplete findings, success invalidation, and error handling.
 */

import React from 'react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import PlanningNeedsAttentionBanner from '@/components/shared/PlanningNeedsAttentionBanner'
import { completeReplanning } from '@/lib/api'

vi.mock('@/lib/api', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return { ...actual, completeReplanning: vi.fn() }
})

function createTestQueryClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } })
}

function renderBanner(projectId = 'project-1') {
  const qc = createTestQueryClient()
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[`/projects/${projectId}/resource-profile`]}>
        <Routes>
          <Route path="/projects/:id/resource-profile" element={<PlanningNeedsAttentionBanner projectId={projectId} />} />
          <Route path="/projects/:id/*" element={<PlanningNeedsAttentionBanner projectId={projectId} />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

beforeEach(() => vi.clearAllMocks())

describe('PlanningNeedsAttentionBanner', () => {
  it('shows the planning-needs-attention state and copy', () => {
    renderBanner()
    expect(screen.getByTestId('planning-needs-attention')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Planning needs attention' })).toBeInTheDocument()
    expect(screen.getByText(/resource planning is no longer current/i)).toBeInTheDocument()
  })

  it('calls complete replanning from the Replan project action', async () => {
    vi.mocked(completeReplanning).mockResolvedValue({ projectId: 'project-1', planningState: 'CURRENT' })
    renderBanner()

    fireEvent.click(screen.getByTestId('replan-project-button'))

    await waitFor(() => expect(completeReplanning).toHaveBeenCalledWith('project-1'))
  })

  it('shows actionable findings and offers the Resource Profile route when incomplete', async () => {
    vi.mocked(completeReplanning).mockRejectedValue({
      response: {
        data: {
          code: 'REPLAN_INCOMPLETE',
          error: 'Replanning is incomplete: project "X": resource type "Engineer" lacks a ROLE profile',
          findings: ['project "X": resource type "Engineer" lacks a ROLE profile'],
        },
      },
    })
    renderBanner()

    fireEvent.click(screen.getByTestId('replan-project-button'))

    await waitFor(() => {
      expect(screen.getByText(/Replanning is not complete yet/i)).toBeInTheDocument()
      expect(screen.getByText(/1 planning input still need attention/i)).toBeInTheDocument()
    })
    expect(screen.getByRole('button', { name: 'Review recovery actions in Resource Profile' })).toBeInTheDocument()
  })

  it('surfaces unexpected completion errors', async () => {
    vi.mocked(completeReplanning).mockRejectedValue({ response: { data: { error: 'Boom' } } })
    renderBanner()

    fireEvent.click(screen.getByTestId('replan-project-button'))

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Boom'))
  })
})
