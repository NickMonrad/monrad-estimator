import React from 'react'
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import TimelinePage from '@/pages/TimelinePage'

// ---------------------------------------------------------------------------
// Mocks — hoisted for vi.mock factory references
// ---------------------------------------------------------------------------
const mockGet = vi.hoisted(() => vi.fn())
const mockPatch = vi.hoisted(() => vi.fn())
const mockPost = vi.hoisted(() => vi.fn())
const mockPut = vi.hoisted(() => vi.fn())
const mockDelete = vi.hoisted(() => vi.fn())

vi.mock('@/lib/api', () => ({
  api: {
    get: mockGet,
    patch: mockPatch,
    post: mockPost,
    put: mockPut,
    delete: mockDelete,
  },
}))

vi.mock('@/components/layout/AppLayout', () => ({
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

vi.mock('@/components/timeline/GanttChart', () => ({
  default: () => <div data-testid="gantt-chart" />,
}))

vi.mock('@/components/timeline/ResourceHistogram', () => ({
  default: () => <div data-testid="resource-histogram" />,
}))

vi.mock('@/components/timeline/TimelineOptimiserDrawer', () => ({
  default: () => null,
}))

vi.mock('@/components/timeline/SquadPlannerDrawer', () => ({
  default: () => null,
}))

vi.mock('@/components/SnapshotHistoryPanel', () => ({
  default: () => null,
}))

vi.mock('@/components/timeline/TimelineTooltip', () => ({
  default: () => null,
}))

// ---------------------------------------------------------------------------
// Mock data
// ---------------------------------------------------------------------------
const projectId = 'test-project-1'

const mockProject = {
  id: projectId,
  name: 'Test Project',
  status: 'active',
  hoursPerDay: 8,
  bufferWeeks: 2,
  onboardingWeeks: 3,
  startDate: '2026-01-15T00:00:00.000Z',
  updatedAt: '2026-06-01T00:00:00.000Z',
}

const defaultTimelineEntry = {
  epicId: 'epic-1',
  epicName: 'Epic One',
  epicOrder: 1,
  featureId: 'feature-1',
  featureName: 'Feature One',
  featureOrder: 1,
  startWeek: 0,
  durationWeeks: 1,
  isManual: false,
}

function createTimeline(overrides: Record<string, unknown> = {}) {
  return {
    projectId,
    startDate: '2026-01-15',
    hoursPerDay: 8,
    projectedEndDate: '2026-06-30T00:00:00.000Z',
    entries: [defaultTimelineEntry],
    storyEntries: [],
    weeklyDemand: [],
    parallelWarnings: [],
    namedResources: [],
    bufferWeeks: 2,
    onboardingWeeks: 3,
    ...overrides,
  }
}

let mockTimeline = createTimeline()
let mockResourceTypes: any[] = []

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  })
}

function renderPage(client = createQueryClient()) {
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/projects/${projectId}/timeline`]}>
        <Routes>
          <Route path="/projects/:id/timeline" element={<TimelinePage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('TimelinePage — Planning Settings', () => {
  let localStorageStore: Record<string, string> = {}

  beforeEach(() => {
    localStorageStore = {}
    mockTimeline = createTimeline()
    mockResourceTypes = []

    // Stub localStorage (jsdom doesn't provide it by default)
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => localStorageStore[key] ?? null,
      setItem: (key: string, value: string) => { localStorageStore[key] = value },
      removeItem: (key: string) => { delete localStorageStore[key] },
      clear: () => { localStorageStore = {} },
      length: 0,
      key: () => null,
    })

    vi.clearAllMocks()

    // Default: project, timeline, resource-types
    mockGet.mockImplementation((url: string) => {
      if (url.includes('/timeline')) return Promise.resolve({ data: mockTimeline })
      if (url.includes('/resource-types')) return Promise.resolve({ data: mockResourceTypes })
      return Promise.resolve({ data: mockProject })
    })

    mockPost.mockImplementation(() => Promise.resolve({ data: mockTimeline }))
    mockPut.mockResolvedValue({ data: {} })
    mockPatch.mockResolvedValue({ data: mockProject })
    mockDelete.mockResolvedValue({ data: {} })
  })


  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('renders the Planning Settings heading', async () => {
    renderPage()
    expect(await screen.findByText('Planning Settings')).toBeInTheDocument()
  })

  it('renders Onboarding Weeks and Buffer Weeks inputs', async () => {
    renderPage()

    const onboardingInput = await screen.findByRole('spinbutton', { name: /onboarding weeks/i })
    expect(onboardingInput).toBeInTheDocument()

    const bufferInput = await screen.findByRole('spinbutton', { name: /buffer weeks/i })
    expect(bufferInput).toBeInTheDocument()
  })

  it('initialises inputs from loaded project values', async () => {
    renderPage()

    // Inputs start at 0 but the useEffect syncs from the project query once loaded.
    // Wait for the value to be set from the project data (3).
    await waitFor(() => {
      const onboardingInput = screen.getByRole('spinbutton', { name: /onboarding weeks/i })
      expect(onboardingInput).toHaveValue(3)
    })

    const bufferInput = screen.getByRole('spinbutton', { name: /buffer weeks/i })
    expect(bufferInput).toHaveValue(2)
  })

  it('renders a Save button', async () => {
    renderPage()

    const saveButton = await screen.findByRole('button', { name: /save/i })
    expect(saveButton).toBeInTheDocument()
    expect(saveButton).not.toBeDisabled()
  })

  it('calls PATCH /projects/:id with onboardingWeeks and bufferWeeks on Save', async () => {
    renderPage()

    // Wait for page to load with project data (value syncs from query)
    await waitFor(() => {
      const input = screen.getByRole('spinbutton', { name: /onboarding weeks/i })
      expect(input).toHaveValue(3)
    })

    const onboardingInput = screen.getByRole('spinbutton', { name: /onboarding weeks/i })
    const bufferInput = screen.getByRole('spinbutton', { name: /buffer weeks/i })

    // Change both values
    fireEvent.change(onboardingInput, { target: { value: '5' } })
    fireEvent.change(bufferInput, { target: { value: '4' } })

    // Click Save
    const saveButton = screen.getByRole('button', { name: /save/i })
    fireEvent.click(saveButton)

    await waitFor(() => {
      expect(mockPatch).toHaveBeenCalledWith(`/projects/${projectId}`, {
        onboardingWeeks: 5,
        bufferWeeks: 4,
      })
    })
  })

  it('invalidates project and timeline queries after successful save', async () => {
    const client = createQueryClient()
    const invalidateSpy = vi.spyOn(client, 'invalidateQueries')

    renderPage(client)

    // Wait for data load
    await waitFor(() => {
      const input = screen.getByRole('spinbutton', { name: /onboarding weeks/i })
      expect(input).toHaveValue(3)
    })

    // Click Save
    const saveButton = screen.getByRole('button', { name: /save/i })
    fireEvent.click(saveButton)

    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['project', projectId] })
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['timeline', projectId] })
    })
  })

  it('has accessible labels associated via htmlFor and id', async () => {
    renderPage()

    await screen.findByRole('spinbutton', { name: /onboarding weeks/i })

    const onboardingInput = screen.getByRole('spinbutton', { name: /onboarding weeks/i })
    expect(onboardingInput).toHaveAttribute('id', 'timeline-onboarding-weeks')

    const bufferInput = screen.getByRole('spinbutton', { name: /buffer weeks/i })
    expect(bufferInput).toHaveAttribute('id', 'timeline-buffer-weeks')

    // Verify labels are associated via htmlFor
    const onboardingLabel = screen.getByText('Onboarding Weeks')
    expect(onboardingLabel).toHaveAttribute('for', 'timeline-onboarding-weeks')

    const bufferLabel = screen.getByText('Buffer Weeks')
    expect(bufferLabel).toHaveAttribute('for', 'timeline-buffer-weeks')
  })
  it('renders Update timeline and hides the level action', async () => {
    renderPage()

    expect(await screen.findByRole('button', { name: /^update timeline$/i })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /level current timeline/i })).not.toBeInTheDocument()
  })

  it('posts the schedule request when Update timeline is clicked', async () => {
    renderPage()

    await screen.findByDisplayValue('2026-01-15')
    fireEvent.click(screen.getByRole('button', { name: /^update timeline$/i }))

    await waitFor(() => {
      expect(mockPost).toHaveBeenCalledWith(`/projects/${projectId}/timeline/schedule`, {
        startDate: '2026-01-15',
        resourceLevel: false,
      })
    })
  })

  it('passes resourceLevel true when Resource leveling is enabled', async () => {
    renderPage()

    await screen.findByDisplayValue('2026-01-15')
    const checkbox = screen.getByRole('checkbox', { name: /resource leveling/i })
    fireEvent.click(checkbox)

    await waitFor(() => {
      expect(checkbox).toBeChecked()
    })

    fireEvent.click(screen.getByRole('button', { name: /^update timeline$/i }))

    await waitFor(() => {
      expect(mockPost).toHaveBeenCalledWith(`/projects/${projectId}/timeline/schedule`, {
        startDate: '2026-01-15',
        resourceLevel: true,
      })
    })
  })

  it('shows Update timeline in the stale banner after a resource edit', async () => {
    mockTimeline = createTimeline({
      weeklyDemand: [{ resourceTypeName: 'Developer', demandDays: 5 }],
    })
    mockResourceTypes = [
      { id: 'rt-dev', name: 'Developer', category: 'Engineering', count: 1, hoursPerDay: 8 },
    ]

    renderPage()

    const hoursInput = (await screen.findByDisplayValue('8')) as HTMLInputElement

    fireEvent.change(hoursInput!, { target: { value: '7' } })
    fireEvent.blur(hoursInput!)

    await waitFor(() => {
      expect(mockPut).toHaveBeenCalledWith(`/projects/${projectId}/resource-types/rt-dev`, {
        hoursPerDay: 7,
      })
    })

    const banner = screen.getByText(/timeline inputs changed/i).closest('div')
    expect(banner).not.toBeNull()
    expect(within(banner!).getByRole('button', { name: /update timeline/i })).toBeInTheDocument()
    expect(
      screen.getByText(/update the timeline to recalculate dates from the latest backlog, dependencies, and resource setup/i),
    ).toBeInTheDocument()
  })
})
