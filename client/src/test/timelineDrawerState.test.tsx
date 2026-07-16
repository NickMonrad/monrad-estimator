import { api } from '@/lib/api'

vi.mock('@/lib/api', () => ({
  api: {
    get: vi.fn().mockResolvedValue({ data: [] }),
    post: vi.fn().mockResolvedValue({ data: {} }),
  },
}))

import React from 'react'
import { describe, expect, it, vi } from 'vitest'
import { waitFor } from '@testing-library/react'
import { fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import TimelineOptimiserDrawer from '@/components/timeline/TimelineOptimiserDrawer'
import SquadPlannerDrawer from '@/components/timeline/SquadPlannerDrawer'

function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  })
}

function renderWithClient(ui: React.ReactElement, client = createQueryClient()) {
  return {
    client,
    ...render(
      <QueryClientProvider client={client}>
        {ui}
      </QueryClientProvider>,
    ),
  }
}

describe('timeline drawer state restoration', () => {
  it('keeps Starting Team Finder edits when the parent rerenders with the same resource values', () => {
    const onClose = vi.fn()
    const onApplied = vi.fn()
    const onRefineScenario = vi.fn()
    const { rerender, client } = renderWithClient(
      <TimelineOptimiserDrawer
        projectId="proj-1"
        open={true}
        onClose={onClose}
        resourceTypes={[{ id: 'rt-dev', name: 'Developer', count: 2 }]}
        fallbackPlannedResourceTypeIds={['rt-dev']}
        onApplied={onApplied}
        onRefineScenario={onRefineScenario}
      />,
    )

    const [minInput] = screen.getAllByRole('spinbutton')
    fireEvent.change(minInput, { target: { value: '3' } })
    expect(screen.getAllByRole('spinbutton')[0]).toHaveValue(3)

    rerender(
      <QueryClientProvider client={client}>
        <TimelineOptimiserDrawer
          projectId="proj-1"
          open={true}
          onClose={onClose}
          resourceTypes={[{ id: 'rt-dev', name: 'Developer', count: 2 }]}
          fallbackPlannedResourceTypeIds={['rt-dev']}
          onApplied={onApplied}
          onRefineScenario={onRefineScenario}
        />
      </QueryClientProvider>,
    )

    expect(screen.getAllByRole('spinbutton')[0]).toHaveValue(3)
  })

  it('keeps Squad Planner edits when the parent rerenders with the same resource values', () => {
    const onClose = vi.fn()
    const { rerender, client } = renderWithClient(
      <SquadPlannerDrawer
        projectId="proj-1"
        open={true}
        onClose={onClose}
        resourceTypes={[{ id: 'rt-dev', name: 'Developer', count: 2 }]}
      />,
    )

    const minFloorInput = screen.getByTitle('Min headcount')
    fireEvent.change(minFloorInput, { target: { value: '2' } })
    expect(screen.getByTitle('Min headcount')).toHaveValue(2)

    rerender(
      <QueryClientProvider client={client}>
        <SquadPlannerDrawer
          projectId="proj-1"
          open={true}
          onClose={onClose}
          resourceTypes={[{ id: 'rt-dev', name: 'Developer', count: 2 }]}
        />
      </QueryClientProvider>,
    )

    expect(screen.getByTitle('Min headcount')).toHaveValue(2)
  })

  it('hides drawer immediately after successful apply (applyDone local guard)', async () => {
    const planResult = {
      deliveryWeeks: 78,
      totalCost: 500000,
      peakHeadcount: 5,
      avgUtilisationPct: 85,
      periods: [{
        periodIndex: 0,
        startWeek: 0,
        endWeek: 13,
        resources: [{
          resourceTypeId: 'rt-dev',
          resourceTypeName: 'Developer',
          headcount: 2,
          peakDemandFTE: 1.5,
          avgDemandFTE: 1.2,
          utilisationPct: 85,
          cost: 100000,
        }],
      }],
      plannedResourceTypeIds: ['rt-dev'],
    }

    const onClose = vi.fn()
    const mockedPost = vi.mocked(api.post)
    mockedPost
      .mockResolvedValueOnce({ data: planResult })
      .mockResolvedValueOnce({ data: {} })

    renderWithClient(
      <SquadPlannerDrawer
        projectId="proj-1"
        open={true}
        onClose={onClose}
        resourceTypes={[{ id: 'rt-dev', name: 'Developer', count: 2 }]}
      />,
    )

    expect(screen.getByText('👥 Squad Planner')).toBeInTheDocument()

    // Generate a plan so the Apply button appears
    fireEvent.click(screen.getByRole('button', { name: /generate capacity profile/i }))
    const applyButton = await screen.findByRole('button', { name: /apply capacity profile/i })

    // Apply the plan
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    fireEvent.click(applyButton)

    // Drawer must hide due to the applyDone render guard
    await waitFor(() => {
      expect(screen.queryByText('👥 Squad Planner')).not.toBeInTheDocument()
    })

    // Verify that onClose was still called
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
