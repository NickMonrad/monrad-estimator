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
      targetAchieved: true,
      staffedFteWeeks: 130,
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
      draft: {
        capacityEdits: [{
          resourceTypeId: 'rt-dev',
          startWeek: 0,
          endWeek: 13,
          headcount: 2,
          locked: false,
        }],
        manualFeatureEntries: [],
        manualStoryEntries: [],
      },
      draftToken: 'apply-token',
      schedule: {
        features: [{ featureId: 'feature-1', name: 'Feature one', startWeek: 0, durationWeeks: 13 }],
        stories: [{ storyId: 'story-1', featureId: 'feature-1', name: 'Story one', startWeek: 0, durationWeeks: 2 }],
      },
      levellingResult: {
        epicStartWeeks: {},
        featureStartWeeks: { 'feature-1': 0 },
        totalDeliveryWeeks: 78,
        peakUtilisationPct: 85,
      },
      config: {
        targetDurationWeeks: 78,
        periodWeeks: 13,
        maxDeltaPerPeriod: 1,
        smoothingMode: 'smooth',
        minFloor: { 'rt-dev': 0 },
        maxCap: null,
        maxBudget: null,
        maxAllocationBufferPct: 0.2,
        maxParallelismPerFeature: 2,
        maxConcurrentEpics: 6,
      },
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
    expect(applyButton).toBeEnabled()

    // Apply the plan
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    fireEvent.click(applyButton)

    // Drawer must hide due to the applyDone render guard
    await waitFor(() => {
      expect(screen.queryByText('👥 Squad Planner')).not.toBeInTheDocument()
    })

    // Verify that onClose was still called
    expect(onClose).toHaveBeenCalledTimes(1)
    vi.restoreAllMocks()
  })
})

describe('Squad Planner editable draft workflow', () => {
  const draftResult = (overrides: Record<string, unknown> = {}) => ({
    deliveryWeeks: 4,
    targetAchieved: true,
    staffedFteWeeks: 4,
    totalCost: 1200,
    peakHeadcount: 2,
    avgUtilisationPct: 80,
    periods: [{
      periodIndex: 0,
      startWeek: 0,
      endWeek: 4,
      resources: [{
        resourceTypeId: 'rt-dev',
        resourceTypeName: 'Developer',
        headcount: 2,
        peakDemandFTE: 1.5,
        avgDemandFTE: 1.2,
        utilisationPct: 80,
        cost: 1200,
      }],
    }],
    draft: {
      capacityEdits: [{ resourceTypeId: 'rt-dev', startWeek: 0, endWeek: 4, headcount: 2, locked: false }],
      manualFeatureEntries: [],
      manualStoryEntries: [],
    },
    draftToken: 'token-1',
    schedule: {
      features: [{ featureId: 'feature-1', name: 'Feature one', startWeek: 0, durationWeeks: 4 }],
      stories: [{ storyId: 'story-1', featureId: 'feature-1', name: 'Story one', startWeek: 0, durationWeeks: 2 }],
    },
    levellingResult: {
      epicStartWeeks: {},
      featureStartWeeks: { 'feature-1': 0 },
      totalDeliveryWeeks: 4,
      peakUtilisationPct: 80,
    },
    config: {
      targetDurationWeeks: 78,
      periodWeeks: 13,
      maxDeltaPerPeriod: 1,
      smoothingMode: 'smooth',
      minFloor: { 'rt-dev': 0 },
      maxCap: null,
      maxBudget: null,
      maxAllocationBufferPct: 0.2,
      maxParallelismPerFeature: 2,
      maxConcurrentEpics: 6,
    },
    ...overrides,
  })

  it('keeps exact capacity edits and lock controls visible while the reviewed result is stale', async () => {
    const mockedPost = vi.mocked(api.post)
    mockedPost.mockReset()
    const acceptedDraft = {
      capacityEdits: [{
        resourceTypeId: 'rt-dev',
        startWeek: 0,
        endWeek: 4,
        headcount: 1.23456789,
        locked: true,
      }],
      manualFeatureEntries: [],
      manualStoryEntries: [],
    }
    mockedPost
      .mockResolvedValueOnce({ data: draftResult() })
      .mockResolvedValueOnce({ data: draftResult({ draft: acceptedDraft, draftToken: 'token-2' }) })

    renderWithClient(
      <SquadPlannerDrawer
        projectId="proj-1"
        open={true}
        onClose={vi.fn()}
        resourceTypes={[{ id: 'rt-dev', name: 'Developer', count: 2 }]}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: /generate capacity profile/i }))
    const capacity = await screen.findByRole('spinbutton', { name: 'Capacity for Developer W1–W4' })
    fireEvent.change(capacity, { target: { value: '1.23456789' } })

    expect(capacity).toHaveValue(1.23456789)
    expect(screen.getByText('Planner proposed 2')).toBeInTheDocument()
    expect(screen.getByText(/out of date/i)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /lock capacity for developer/i }))
    fireEvent.click(screen.getByRole('button', { name: /unlock capacity for developer/i }))
    fireEvent.click(screen.getByRole('button', { name: /lock capacity for developer/i }))
    expect(screen.getByRole('button', { name: /apply capacity profile/i })).toBeDisabled()

    fireEvent.click(screen.getByRole('button', { name: /replan unlocked work/i }))
    await waitFor(() => expect(mockedPost).toHaveBeenCalledTimes(2))
    expect(mockedPost.mock.calls[1][1]).toMatchObject({
      draft: acceptedDraft,
    })
    expect(await screen.findByText(/reviewed result is current and ready to apply/i)).toBeInTheDocument()
    expect(screen.getByRole('spinbutton', { name: 'Capacity for Developer W1–W4' })).toHaveValue(1.23456789)
  })

  it('keeps capacity and schedule unlock controls after an irreconcilable response returns no periods', async () => {
    const mockedPost = vi.mocked(api.post)
    mockedPost.mockReset()
    const lockedDraft = {
      capacityEdits: [{
        resourceTypeId: 'rt-dev',
        startWeek: 0,
        endWeek: 4,
        headcount: 2,
        locked: true,
      }],
      manualFeatureEntries: [{ featureId: 'feature-1', startWeek: 0, durationWeeks: 4 }],
      manualStoryEntries: [{ storyId: 'story-1', startWeek: 0 }],
    }
    mockedPost
      .mockResolvedValueOnce({ data: draftResult() })
      .mockResolvedValueOnce({
        data: draftResult({
          deliveryWeeks: null,
          targetAchieved: false,
          periods: [],
          draft: lockedDraft,
          draftToken: undefined,
          schedule: { features: [], stories: [] },
          diagnostics: [{
            blocker: 'CAPACITY_LOCK',
            resourceTypeName: 'Developer',
            explanation: 'Locked capacity leaves insufficient staffing.',
          }],
        }),
      })

    renderWithClient(
      <SquadPlannerDrawer
        projectId="proj-1"
        open={true}
        onClose={vi.fn()}
        resourceTypes={[{ id: 'rt-dev', name: 'Developer', count: 2 }]}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: /generate capacity profile/i }))
    await screen.findByRole('spinbutton', { name: /capacity for developer/i })
    fireEvent.click(screen.getByRole('button', { name: /lock capacity for developer/i }))
    fireEvent.click(screen.getByRole('button', { name: /lock feature placement for feature one/i }))
    fireEvent.click(screen.getByRole('button', { name: /lock story placement for story one/i }))
    fireEvent.click(screen.getByRole('button', { name: /replan unlocked work/i }))

    expect(await screen.findByText(/latest response returned no capacity periods/i)).toBeInTheDocument()
    expect(screen.getByText(/locked capacity leaves insufficient staffing/i)).toBeInTheDocument()
    expect(screen.getByRole('spinbutton', { name: /capacity for developer/i })).toHaveValue(2)
    expect(screen.getByRole('button', { name: /unlock capacity for developer/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /unlock feature placement for feature one/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /unlock story placement for story one/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /apply capacity profile/i })).toBeDisabled()

    fireEvent.click(screen.getByRole('button', { name: /unlock capacity for developer/i }))
    expect(screen.getByRole('button', { name: /replan unlocked work/i })).toBeInTheDocument()
  })

  it('allows a signed finite plan that misses the target and applies the accepted proof-bound result', async () => {
    const mockedPost = vi.mocked(api.post)
    mockedPost.mockReset()
    const missedTargetResult = draftResult({
      deliveryWeeks: 9,
      targetAchieved: false,
      draftToken: 'missed-target-token',
      diagnostics: [{
        blocker: 'TARGET_DURATION',
        explanation: 'The earliest reconciled schedule takes nine weeks.',
      }],
    })
    mockedPost
      .mockResolvedValueOnce({ data: missedTargetResult })
      .mockResolvedValueOnce({ data: {} })

    renderWithClient(
      <SquadPlannerDrawer
        projectId="proj-1"
        open={true}
        onClose={vi.fn()}
        resourceTypes={[{ id: 'rt-dev', name: 'Developer', count: 2 }]}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: /generate capacity profile/i }))
    const applyButton = await screen.findByRole('button', { name: /apply capacity profile/i })
    expect(applyButton).toBeEnabled()
    expect(screen.getByText(/requested target was missed.*can be applied/i)).toBeInTheDocument()

    vi.spyOn(window, 'confirm').mockReturnValue(true)
    fireEvent.click(applyButton)
    await waitFor(() => expect(mockedPost).toHaveBeenCalledTimes(2))
    expect(mockedPost.mock.calls[1][1]).toMatchObject({
      targetWeeks: missedTargetResult.config.targetDurationWeeks,
      periodWeeks: missedTargetResult.config.periodWeeks,
      maxDelta: missedTargetResult.config.maxDeltaPerPeriod,
      periods: [{
        periodIndex: 0,
        startWeek: 0,
        endWeek: 4,
        entries: [{
          resourceTypeId: 'rt-dev',
          headcount: 2,
          demandFTE: 1.2,
          utilisationPct: 80,
        }],
      }],
      totalCost: missedTargetResult.totalCost,
      deliveryWeeks: missedTargetResult.deliveryWeeks,
      levellingResult: missedTargetResult.levellingResult,
      config: missedTargetResult.config,
      draft: missedTargetResult.draft,
      draftToken: missedTargetResult.draftToken,
      schedule: missedTargetResult.schedule,
    })
    vi.restoreAllMocks()
  })

  it('rejects an older in-flight replan after a later draft edit', async () => {
    const mockedPost = vi.mocked(api.post)
    mockedPost.mockReset()
    const gate = Promise.withResolvers<unknown>()
    mockedPost
      .mockResolvedValueOnce({ data: draftResult() })
      .mockImplementationOnce(() => gate.promise)

    renderWithClient(
      <SquadPlannerDrawer
        projectId="proj-1"
        open={true}
        onClose={vi.fn()}
        resourceTypes={[{ id: 'rt-dev', name: 'Developer', count: 2 }]}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: /generate capacity profile/i }))
    const capacity = await screen.findByRole('spinbutton', { name: /capacity for developer/i })
    fireEvent.change(capacity, { target: { value: '1.5' } })
    fireEvent.click(screen.getByRole('button', { name: /replan unlocked work/i }))
    expect(screen.getByRole('button', { name: /replanning unlocked work/i })).toBeDisabled()
    fireEvent.change(capacity, { target: { value: '1.25' } })
    gate.resolve({ data: draftResult({ draftToken: 'stale-token' }) })

    await waitFor(() => expect(screen.getByRole('spinbutton', { name: /capacity for developer/i })).toHaveValue(1.25))
    expect(screen.getByText(/out of date/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /apply capacity profile/i })).toBeDisabled()
  })

  it('keeps local edits and unlock controls when replan fails', async () => {
    const mockedPost = vi.mocked(api.post)
    mockedPost.mockReset()
    mockedPost
      .mockResolvedValueOnce({ data: draftResult() })
      .mockRejectedValueOnce({
        response: {
          data: {
            error: 'Locked capacity conflicts with protected availability.',
            diagnostics: [{
              blocker: 'CAPACITY_LOCK',
              explanation: 'Developer is unavailable in this period.',
            }],
          },
        },
      })

    renderWithClient(
      <SquadPlannerDrawer
        projectId="proj-1"
        open={true}
        onClose={vi.fn()}
        resourceTypes={[{ id: 'rt-dev', name: 'Developer', count: 2 }]}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: /generate capacity profile/i }))
    const capacity = await screen.findByRole('spinbutton', { name: /capacity for developer/i })
    fireEvent.change(capacity, { target: { value: '0.333333' } })
    fireEvent.click(screen.getByRole('button', { name: /lock capacity for developer/i }))
    fireEvent.click(screen.getByRole('button', { name: /replan unlocked work/i }))

    expect(await screen.findByRole('alert')).toHaveTextContent(/locked capacity conflicts/i)
    expect(screen.getByRole('spinbutton', { name: /capacity for developer/i })).toHaveValue(0.333333)
    expect(screen.getByRole('button', { name: /unlock capacity for developer/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /apply capacity profile/i })).toBeDisabled()
  })

  it('requires replan after the server rejects the reviewed proof', async () => {
    const mockedPost = vi.mocked(api.post)
    mockedPost.mockReset()
    mockedPost
      .mockResolvedValueOnce({ data: draftResult() })
      .mockRejectedValueOnce({
        response: {
          status: 409,
          data: {
            error: 'Reviewed squad-plan result is stale; regenerate the draft.',
          },
        },
      })

    renderWithClient(
      <SquadPlannerDrawer
        projectId="proj-1"
        open={true}
        onClose={vi.fn()}
        resourceTypes={[{ id: 'rt-dev', name: 'Developer', count: 2 }]}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: /generate capacity profile/i }))
    const applyButton = await screen.findByRole('button', { name: /apply capacity profile/i })
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    fireEvent.click(applyButton)

    expect(await screen.findByRole('alert')).toHaveTextContent(/result is stale/i)
    expect(screen.getByRole('button', { name: /apply capacity profile/i })).toBeDisabled()
    expect(screen.getByText(/server rejected this reviewed proof.*replan/i)).toBeInTheDocument()
    vi.restoreAllMocks()
  })

  it('keeps Apply disabled without a token and after an invalid schedule response', async () => {
    const mockedPost = vi.mocked(api.post)
    mockedPost.mockReset()
    mockedPost
      .mockResolvedValueOnce({ data: draftResult({ draftToken: undefined }) })
      .mockResolvedValueOnce({
        data: draftResult({
          draftToken: 'invalid-schedule-token',
          schedule: {
            features: [{ featureId: 'feature-1', name: 'Feature one', startWeek: 0, durationWeeks: 0 }],
            stories: [],
          },
        }),
      })

    renderWithClient(
      <SquadPlannerDrawer
        projectId="proj-1"
        open={true}
        onClose={vi.fn()}
        resourceTypes={[{ id: 'rt-dev', name: 'Developer', count: 2 }]}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: /generate capacity profile/i }))
    expect(await screen.findByRole('button', { name: /apply capacity profile/i })).toBeDisabled()
    expect(screen.getByText(/no complete signed, finite schedule/i)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /replan unlocked work/i }))
    await waitFor(() => expect(mockedPost).toHaveBeenCalledTimes(2))
    expect(screen.getByRole('button', { name: /apply capacity profile/i })).toBeDisabled()
    expect(screen.getByText(/no complete signed, finite schedule/i)).toBeInTheDocument()
  })
})
