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
const mockNavigate = vi.hoisted(() => vi.fn())

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
  default: ({ open, onClose }: { open: boolean; onClose?: () => void }) =>
    open ? <div data-testid="squad-planner-drawer"><button onClick={onClose}>Close Squad Planner</button></div> : null,
}))

vi.mock('@/components/SnapshotHistoryPanel', () => ({
  default: () => null,
}))

vi.mock('@/components/timeline/TimelineTooltip', () => ({
  default: () => null,
}))
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom')
  return { ...actual, useNavigate: () => mockNavigate }
})

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

// ---------------------------------------------------------------------------
// Named-resource allocation controls — issue #311
// ---------------------------------------------------------------------------
describe('TimelinePage — named-resource allocation controls', () => {
  const rtId = 'rt-dev'
  const nrId = 'nr-1'

  const baseResourceType = {
    id: rtId,
    name: 'Developer',
    category: 'Engineering',
    count: 1,
    hoursPerDay: 8,
  }

  const baseNamedResource = {
    id: nrId,
    resourceTypeId: rtId,
    name: 'Alice',
    allocationMode: 'EFFORT' as const,
    allocationPercent: 100,
    allocationStartWeek: null,
    allocationEndWeek: null,
  }

  beforeEach(() => {
    const localStorageStore: Record<string, string> = {}
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => localStorageStore[key] ?? null,
      setItem: (key: string, value: string) => { localStorageStore[key] = value },
      removeItem: (key: string) => { delete localStorageStore[key] },
      clear: () => { Object.keys(localStorageStore).forEach(k => delete localStorageStore[k]) },
      length: 0,
      key: () => null,
    })

    vi.clearAllMocks()

    mockGet.mockImplementation((url: string) => {
      if (url.includes('/timeline')) return Promise.resolve({ data: mockTimeline })
      if (url.includes('/resource-types')) return Promise.resolve({ data: mockResourceTypes })
      return Promise.resolve({ data: mockProject })
    })

    mockPatch.mockImplementation((_url: string, _body: Record<string, unknown>) => {
      return Promise.resolve({ data: mockProject })
    })
    // Issue #403: Timeline capacity edits submit the first-class
    // owner-scoped capacity-profile request contract.
    mockPut.mockImplementation((url: string, body: Record<string, unknown>) => {
      if (url.includes('/capacity-profiles/NAMED_PERSON/')) {
        const nrId = url.split('/').pop()
        const basis = body.planningBasis
        const allocationMode = basis === 'DEMAND_FOLLOWING' ? 'EFFORT'
          : basis === 'WHOLE_PROJECT_ALLOCATION' ? 'FULL_PROJECT'
          : 'TIMELINE'
        mockTimeline = {
          ...mockTimeline,
          namedResources: (mockTimeline.namedResources ?? []).map((nr: any) =>
            nr.id === nrId ? {
              ...nr,
              allocationMode,
              allocationPercent: body.defaultPercent ?? 100,
              allocationStartWeek: allocationMode === 'TIMELINE' ? (body.startWeek ?? null) : null,
              allocationEndWeek: allocationMode === 'TIMELINE' ? (body.endWeek ?? null) : null,
            } : nr,
          ),
        }
        return Promise.resolve({ data: mockTimeline })
      }

      return Promise.resolve({ data: mockProject })
    })
    mockDelete.mockResolvedValue({ data: {} })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function setupWithNamedResource(nrOverrides: Partial<typeof baseNamedResource> = {}) {
    mockResourceTypes = [baseResourceType]
    mockTimeline = createTimeline({
      weeklyDemand: [{ resourceTypeName: 'Developer', demandDays: 5 }],
      namedResources: [{ ...baseNamedResource, ...nrOverrides }],
    })
  }

  it('renders column headers when named resources exist', async () => {
    setupWithNamedResource()
    renderPage()


    expect(await screen.findByText('Named resource')).toBeInTheDocument()
    expect(screen.getByText('Availability pattern')).toBeInTheDocument()
    expect(screen.getByText('Available %')).toBeInTheDocument()
    expect(screen.getByText('Available from')).toBeInTheDocument()
    expect(screen.getByText('Available to')).toBeInTheDocument()
  })

  it('renders the named-resource name in its row', async () => {
    setupWithNamedResource()
    renderPage()


    const alice = await screen.findAllByText('Alice')
    expect(alice.length).toBeGreaterThan(0)
    expect(screen.getByText(/No assigned weeks.*As needed/i)).toBeInTheDocument()
  })

  it('shows a planning basis select defaulting to As needed', async () => {
    setupWithNamedResource({ allocationMode: 'EFFORT' })
    renderPage()


    const select = await screen.findByRole('combobox')
    expect(select).toHaveValue('EFFORT')
  })

  it('mode switch fires PATCH with new mode and clears weeks when leaving TIMELINE', async () => {
    setupWithNamedResource({
      allocationMode: 'TIMELINE',
      allocationPercent: 80,
      allocationStartWeek: 2,
      allocationEndWeek: 10,
    })
    renderPage()

    const select = await screen.findByRole('combobox')
    expect(select).toHaveValue('TIMELINE')

    fireEvent.change(select, { target: { value: 'FULL_PROJECT' } })

    await waitFor(() => {
      expect(mockPut).toHaveBeenCalledWith(
        `/projects/${projectId}/capacity-profiles/NAMED_PERSON/${nrId}`,
        expect.objectContaining({
          planningBasis: 'WHOLE_PROJECT_ALLOCATION',
          startWeek: null,
          endWeek: null,
        }),
      )
    })

    await waitFor(() => {
      expect(select).toHaveValue('FULL_PROJECT')
    })
  })

  it('mode switch to TIMELINE preserves existing weeks', async () => {
    setupWithNamedResource({
      allocationMode: 'FULL_PROJECT',
      allocationPercent: 100,
      allocationStartWeek: 3,
      allocationEndWeek: 12,
    })
    renderPage()

    const select = await screen.findByRole('combobox')
    fireEvent.change(select, { target: { value: 'TIMELINE' } })

    await waitFor(() => {
      expect(mockPut).toHaveBeenCalledWith(
        `/projects/${projectId}/capacity-profiles/NAMED_PERSON/${nrId}`,
        expect.objectContaining({
          planningBasis: 'AVAILABILITY_WINDOW',
          startWeek: 3,
          endWeek: 12,
        }),
      )
    })

    await waitFor(() => {
      expect(select).toHaveValue('TIMELINE')
    })

    const row = screen.getAllByText('Alice')[0].closest('div')
    expect(row).not.toBeNull()
    expect(within(row!).getByPlaceholderText('W1')).toHaveValue(3)
    expect(within(row!).getByPlaceholderText('W∞')).toHaveValue(12)
  })

  it('CAPACITY_PLAN is not available in dropdown when current mode is TIMELINE', async () => {
    setupWithNamedResource({
      allocationMode: 'TIMELINE',
      allocationPercent: 80,
      allocationStartWeek: 2,
      allocationEndWeek: 10,
    })
    renderPage()

    const select = await screen.findByRole('combobox')
    const options = Array.from(select.querySelectorAll('option'))
    const optionValues = options.map(o => (o as HTMLOptionElement).value)
    expect(optionValues).not.toContain('CAPACITY_PLAN')
  })

  it('start/end week inputs are disabled for non-TIMELINE rows', async () => {
    setupWithNamedResource({ allocationMode: 'FULL_PROJECT' })
    renderPage()

    await screen.findAllByText('Alice')
    const weekInputs = screen.getAllByPlaceholderText('—')
    expect(weekInputs.length).toBeGreaterThanOrEqual(2)
    weekInputs.slice(-2).forEach(el => expect(el).toBeDisabled())
  })

  it('allocation % column shows — for EFFORT mode', async () => {
    setupWithNamedResource({ allocationMode: 'EFFORT' })
    renderPage()
    await screen.findAllByText('Alice')
    // No % input visible for EFFORT
    const percentInputs = screen.queryAllByRole('spinbutton', { name: /allocation/i })
    expect(percentInputs.length).toBe(0)
  })

  it('CAPACITY_PLAN mode label shows Varies by week without percentage suffix', async () => {
    setupWithNamedResource({ allocationMode: 'CAPACITY_PLAN' })
    renderPage()
    await screen.findAllByText('Alice')
    // The summary label should not contain a percentage
    const summaryLabels = screen.getAllByText(/Varies by week/)
    for (const el of summaryLabels) {
      if (el.tagName === 'OPTION') continue // skip the dropdown option
      expect(el.textContent).not.toMatch(/%/)
    }
  })

  it('CAPACITY_PLAN has truthful help text', async () => {
    setupWithNamedResource({ allocationMode: 'CAPACITY_PLAN' })
    renderPage()
    await screen.findAllByText('Alice')
    const helpText = await screen.findByText(/Availability varies by week/i)
    expect(helpText).toBeInTheDocument()
    // Must NOT claim a saved profile exists
    expect(helpText.textContent).not.toMatch(/saved weekly capacity profile/i)
    // "View Resource Profile" button navigates to the resource profile tab
    const viewProfileBtn = screen.getByText(/View Resource Profile/)
    expect(viewProfileBtn).toBeInTheDocument()
    fireEvent.click(viewProfileBtn)
    expect(mockNavigate).toHaveBeenCalledWith(`/projects/${projectId}/resource-profile`)
  })

  it('marks timeline stale after allocation mode change', async () => {
    setupWithNamedResource({ allocationMode: 'EFFORT' })
    renderPage()


    const select = await screen.findByRole('combobox')
    fireEvent.change(select, { target: { value: 'FULL_PROJECT' } })

    await waitFor(() => {
      expect(mockPut).toHaveBeenCalled()
    })

    // stale banner should appear after the capacity write resolves
    await waitFor(() => {
      expect(screen.getByText(/timeline inputs changed/i)).toBeInTheDocument()
    })
  })


  // ---------------------------------------------------------------------------
  // Exact-payload verification for allocation mode changes — issue #382
  // ---------------------------------------------------------------------------
  it('sends exact payload with allocationPercent=100 when switching to EFFORT', async () => {
    setupWithNamedResource({
      allocationMode: 'TIMELINE',
      allocationPercent: 80,
      allocationStartWeek: 2,
      allocationEndWeek: 10,
    })
    renderPage()

    const select = await screen.findByRole('combobox')
    expect(select).toHaveValue('TIMELINE')

    fireEvent.change(select, { target: { value: 'EFFORT' } })

    await waitFor(() => {
      expect(mockPut).toHaveBeenCalledWith(
        `/projects/${projectId}/capacity-profiles/NAMED_PERSON/${nrId}`,
        {
          planningBasis: 'DEMAND_FOLLOWING',
          defaultPercent: 100,
          startWeek: null,
          endWeek: null,
        },
      )
    })
  })

  it('sends exact payload with preserved percent and null weeks when switching to FULL_PROJECT', async () => {
    setupWithNamedResource({
      allocationMode: 'TIMELINE',
      allocationPercent: 80,
      allocationStartWeek: 2,
      allocationEndWeek: 10,
    })
    renderPage()

    const select = await screen.findByRole('combobox')
    expect(select).toHaveValue('TIMELINE')

    fireEvent.change(select, { target: { value: 'FULL_PROJECT' } })

    await waitFor(() => {
      expect(mockPut).toHaveBeenCalledWith(
        `/projects/${projectId}/capacity-profiles/NAMED_PERSON/${nrId}`,
        {
          planningBasis: 'WHOLE_PROJECT_ALLOCATION',
          defaultPercent: 80,
          startWeek: null,
          endWeek: null,
        },
      )
    })
  })

  it('sends exact payload with preserved percent and weeks when switching to TIMELINE', async () => {
    setupWithNamedResource({
      allocationMode: 'FULL_PROJECT',
      allocationPercent: 80,
      allocationStartWeek: 3,
      allocationEndWeek: 12,
    })
    renderPage()

    const select = await screen.findByRole('combobox')
    expect(select).toHaveValue('FULL_PROJECT')

    fireEvent.change(select, { target: { value: 'TIMELINE' } })

    await waitFor(() => {
      expect(mockPut).toHaveBeenCalledWith(
        `/projects/${projectId}/capacity-profiles/NAMED_PERSON/${nrId}`,
        {
          planningBasis: 'AVAILABILITY_WINDOW',
          defaultPercent: 80,
          startWeek: 3,
          endWeek: 12,
        },
      )
    })
  })

  it('CAPACITY_PLAN is not available in dropdown when current mode is EFFORT', async () => {
    setupWithNamedResource({
      allocationMode: 'EFFORT',
      allocationPercent: 100,
      allocationStartWeek: null,
      allocationEndWeek: null,
    })
    renderPage()

    const select = await screen.findByRole('combobox')
    expect(select).toHaveValue('EFFORT')
    const options = Array.from(select.querySelectorAll('option'))
    const optionValues = options.map(o => (o as HTMLOptionElement).value)
    expect(optionValues).not.toContain('CAPACITY_PLAN')
  })

  // ---------------------------------------------------------------------------
  // Field visibility per allocation mode — issue #382
  // ---------------------------------------------------------------------------
  it('shows percentage input for FULL_PROJECT mode', async () => {
    setupWithNamedResource({ allocationMode: 'FULL_PROJECT', allocationPercent: 75 })
    renderPage()
    await screen.findAllByText('Alice')

    const pctInput = screen.getByRole('spinbutton', { name: /Available percentage for Alice/i })
    expect(pctInput).toBeInTheDocument()
    expect(pctInput).toHaveValue(75)
  })

  it('shows percentage input for TIMELINE mode', async () => {
    setupWithNamedResource({ allocationMode: 'TIMELINE', allocationPercent: 80 })
    renderPage()
    await screen.findAllByText('Alice')

    const pctInput = screen.getByRole('spinbutton', { name: /Available percentage for Alice/i })
    expect(pctInput).toBeInTheDocument()
    expect(pctInput).toHaveValue(80)
  })

  it('shows enabled date controls for TIMELINE mode', async () => {
    setupWithNamedResource({
      allocationMode: 'TIMELINE',
      allocationPercent: 80,
      allocationStartWeek: 2,
      allocationEndWeek: 10,
    })
    renderPage()
    await screen.findAllByText('Alice')

    const fromInput = screen.getByPlaceholderText('W1')
    const toInput = screen.getByPlaceholderText('W∞')
    expect(fromInput).not.toBeDisabled()
    expect(toInput).not.toBeDisabled()
    expect(fromInput).toHaveValue(2)
    expect(toInput).toHaveValue(10)
  })

  // ---------------------------------------------------------------------------
  // Help/control-state matrix — each mode renders exactly one help message,
  // the correct controls, and the matching selected option label.
  // ---------------------------------------------------------------------------

  it('EFFORT mode: exact label, help text, absent controls, single help message', async () => {
    setupWithNamedResource({ allocationMode: 'EFFORT' })
    renderPage()
    await screen.findAllByText('Alice')

    // Select value and option label
    const select = screen.getByRole('combobox', { name: /availability pattern for alice/i }) as HTMLSelectElement
    expect(select).toHaveValue('EFFORT')
    expect(select.options[select.selectedIndex]).toHaveTextContent('As needed')

    // Exactly one help message (no leftover from other modes)
    const helpTexts = screen.getAllByText('Assigned only when scheduled work requires this resource.')
    expect(helpTexts).toHaveLength(1)

    // No percentage input visible
    const percentInputs = screen.queryAllByRole('spinbutton', { name: /Available percentage for Alice/i })
    expect(percentInputs).toHaveLength(0)

    // Date inputs are disabled with — placeholder
    const weekInputs = screen.getAllByPlaceholderText('—')
    expect(weekInputs.length).toBeGreaterThanOrEqual(2)
    weekInputs.slice(-2).forEach(el => expect(el).toBeDisabled())

    // No stale banner on initial load
    expect(screen.queryByText(/timeline inputs changed/i)).not.toBeInTheDocument()
  })

  it('FULL_PROJECT mode: exact label, help text, percentage present, dates disabled, single help message', async () => {
    setupWithNamedResource({ allocationMode: 'FULL_PROJECT', allocationPercent: 75 })
    renderPage()
    await screen.findAllByText('Alice')

    // Select value and option label
    const select = screen.getByRole('combobox', { name: /availability pattern for alice/i }) as HTMLSelectElement
    expect(select).toHaveValue('FULL_PROJECT')
    expect(select.options[select.selectedIndex]).toHaveTextContent('Fixed for whole project')

    // Exactly one help message
    const helpTexts = screen.getAllByText('Available at the selected percentage from the beginning to the end of the project. Work is assigned only when demand exists.')
    expect(helpTexts).toHaveLength(1)

    // Percentage input visible with correct value
    const pctInput = screen.getByRole('spinbutton', { name: /Available percentage for Alice/i })
    expect(pctInput).toHaveValue(75)

    // Date inputs are disabled
    const weekInputs = screen.getAllByPlaceholderText('—')
    expect(weekInputs.length).toBeGreaterThanOrEqual(2)
    weekInputs.slice(-2).forEach(el => expect(el).toBeDisabled())

    // No stale banner on initial load
    expect(screen.queryByText(/timeline inputs changed/i)).not.toBeInTheDocument()
  })

  it('TIMELINE mode: exact label, dynamic help text, percentage present, dates enabled, single help message', async () => {
    setupWithNamedResource({
      allocationMode: 'TIMELINE',
      allocationPercent: 80,
      allocationStartWeek: 2,
      allocationEndWeek: 10,
    })
    renderPage()
    await screen.findAllByText('Alice')

    // Select value and option label
    const select = screen.getByRole('combobox', { name: /availability pattern for alice/i }) as HTMLSelectElement
    expect(select).toHaveValue('TIMELINE')
    expect(select.options[select.selectedIndex]).toHaveTextContent('Fixed for selected weeks')

    // Dynamic TIMELINE help text with inline values
    const helpText = screen.getByText(/Available at 80% from W2 to W10\. Work is assigned only when demand exists\./)
    expect(helpText).toBeInTheDocument()

    // Only one matching help message (no other mode's help text visible)
    const allDescs = screen.queryAllByText(/Assigned only when scheduled work requires this resource/)
    expect(allDescs).toHaveLength(0)

    // Percentage input visible
    const pctInput = screen.getByRole('spinbutton', { name: /Available percentage for Alice/i })
    expect(pctInput).toHaveValue(80)

    // Date inputs enabled with correct values
    const fromInput = screen.getByPlaceholderText('W1')
    const toInput = screen.getByPlaceholderText('W∞')
    expect(fromInput).not.toBeDisabled()
    expect(toInput).not.toBeDisabled()
    expect(fromInput).toHaveValue(2)
    expect(toInput).toHaveValue(10)

    // No stale banner on initial load
    expect(screen.queryByText(/timeline inputs changed/i)).not.toBeInTheDocument()
  })

  it('CAPACITY_PLAN mode: exact label, help text, no percentage, dates disabled, View Resource Profile link, single help message', async () => {
    setupWithNamedResource({ allocationMode: 'CAPACITY_PLAN' })
    renderPage()
    await screen.findAllByText('Alice')

    // Select value and option label
    const select = screen.getByRole('combobox', { name: /availability pattern for alice/i }) as HTMLSelectElement
    expect(select).toHaveValue('CAPACITY_PLAN')
    expect(select.options[select.selectedIndex]).toHaveTextContent('Varies by week')

    // Exactly one help message
    const helpTexts = screen.getAllByText(/Availability varies by week/i)
    expect(helpTexts).toHaveLength(1)
    expect(helpTexts[0]).toHaveTextContent(
      'Availability varies by week. Open the Resource Profile tab to review or configure the weekly pattern.'
    )

    // No percentage input visible
    const percentInputs = screen.queryAllByRole('spinbutton', { name: /Available percentage for Alice/i })
    expect(percentInputs).toHaveLength(0)

    // Date inputs are disabled
    const weekInputs = screen.getAllByPlaceholderText('—')
    expect(weekInputs.length).toBeGreaterThanOrEqual(2)
    weekInputs.slice(-2).forEach(el => expect(el).toBeDisabled())

    // "View Resource Profile" link navigates
    const viewProfileBtn = screen.getByText(/View Resource Profile/)
    expect(viewProfileBtn).toBeInTheDocument()
    fireEvent.click(viewProfileBtn)
    expect(mockNavigate).toHaveBeenCalledWith(`/projects/${projectId}/resource-profile`)

    // No stale banner on initial load
    expect(screen.queryByText(/timeline inputs changed/i)).not.toBeInTheDocument()
  })

  it('mode switch TIMELINE→EFFORT clears TIMELINE help text, shows EFFORT help text, and clears weeks', async () => {
    setupWithNamedResource({
      allocationMode: 'TIMELINE',
      allocationPercent: 80,
      allocationStartWeek: 2,
      allocationEndWeek: 10,
    })
    renderPage()
    await screen.findAllByText('Alice')

    // TIMELINE help text is visible initially
    expect(screen.getByText(/Available at 80% from W2 to W10/)).toBeInTheDocument()

    const select = screen.getByRole('combobox', { name: /availability pattern for alice/i })
    fireEvent.change(select, { target: { value: 'EFFORT' } })

    // Wait for mutation and re-render
    await waitFor(() => {
      expect(select).toHaveValue('EFFORT')
    })

    // TIMELINE help text disappears
    expect(screen.queryByText(/Available at 80% from W2 to W10/)).not.toBeInTheDocument()

    // EFFORT help text appears
    expect(screen.getByText('Assigned only when scheduled work requires this resource.')).toBeInTheDocument()

    // Dates are cleared — disabled with — placeholder
    const weekInputs = screen.getAllByPlaceholderText('—')
    expect(weekInputs.length).toBeGreaterThanOrEqual(2)
    weekInputs.slice(-2).forEach(el => expect(el).toBeDisabled())
  })

  it('add named resource does not send allocationPct', async () => {
    mockResourceTypes = [baseResourceType]
    mockTimeline = createTimeline({
      weeklyDemand: [{ resourceTypeName: 'Developer', demandDays: 5 }],
      namedResources: [],
    })
    mockPost.mockResolvedValue({ data: { id: 'nr-new' } })
    renderPage()

    await screen.findAllByText('Developer')
    const addBtn = screen.getByRole('button', { name: /add named resource to developer/i })
    fireEvent.click(addBtn)

    await waitFor(() => {
      expect(mockPost).toHaveBeenCalledWith(
        `/projects/${projectId}/resource-types/${rtId}/named-resources`,
        expect.objectContaining({ name: expect.any(String) }),
      )
    })
    // Issue #403: the capacity shape is established by the server; the
    // identity route must not receive allocationPct.
    const [, body] = mockPost.mock.calls.find(([url]: [string]) =>
      String(url).includes('/named-resources')) ?? []
    expect(body).not.toHaveProperty('allocationPct')
  })

  it('failed profile write surfaces the server error and does not mark the timeline stale', async () => {
    setupWithNamedResource({ allocationMode: 'EFFORT' })
    mockPut.mockRejectedValue({
      response: { data: { error: 'Cannot replace a PLANNED_RESOURCE profile manually' } },
    })
    renderPage()

    const select = await screen.findByRole('combobox')
    fireEvent.change(select, { target: { value: 'FULL_PROJECT' } })

    // The server error is visible in the resource-counts panel
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('Cannot replace a PLANNED_RESOURCE profile manually')
    })
    // A failed write must not mark the schedule stale
    expect(screen.queryByText(/timeline inputs changed/i)).not.toBeInTheDocument()
  })

  it('switching away from CAPACITY_PLAN fails visibly with the 409 error', async () => {
    setupWithNamedResource({ allocationMode: 'CAPACITY_PLAN' })
    mockPut.mockRejectedValue({
      response: { data: { error: 'Cannot replace a PLANNED_RESOURCE profile manually' } },
    })
    renderPage()

    const select = await screen.findByRole('combobox')
    expect(select).toHaveValue('CAPACITY_PLAN')

    fireEvent.change(select, { target: { value: 'EFFORT' } })

    await waitFor(() => {
      expect(mockPut).toHaveBeenCalledWith(
        `/projects/${projectId}/capacity-profiles/NAMED_PERSON/${nrId}`,
        expect.objectContaining({ planningBasis: 'DEMAND_FOLLOWING' }),
      )
    })
    // The planner-managed conflict is surfaced to the user
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('Cannot replace a PLANNED_RESOURCE profile manually')
    })
  })
})


describe('TimelinePage — resource-counts layout', () => {
  const rtId = 'rt-layout'
  const nrId = 'nr-layout-1'

  const baseResourceType = {
    id: rtId,
    name: 'LayoutTester',
    category: 'Engineering',
    count: 3,
    hoursPerDay: 7.6,
  }

  const baseNamedResource = {
    id: nrId,
    resourceTypeId: rtId,
    name: 'Bob',
    allocationMode: 'EFFORT' as const,
    allocationPercent: 100,
    allocationStartWeek: null,
    allocationEndWeek: null,
  }

  beforeEach(() => {
    const localStorageStore: Record<string, string> = {}
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => localStorageStore[key] ?? null,
      setItem: (key: string, value: string) => { localStorageStore[key] = value },
      removeItem: (key: string) => { delete localStorageStore[key] },
      clear: () => { Object.keys(localStorageStore).forEach(k => delete localStorageStore[k]) },
      length: 0,
      key: () => null,
    })

    vi.clearAllMocks()

    mockGet.mockImplementation((url: string) => {
      if (url.includes('/timeline')) return Promise.resolve({ data: mockTimeline })
      if (url.includes('/resource-types')) return Promise.resolve({ data: mockResourceTypes })
      return Promise.resolve({ data: mockProject })
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('hours input is discoverable by contextual accessible name', async () => {
    mockResourceTypes = [baseResourceType]
    mockTimeline = createTimeline({
      weeklyDemand: [{ resourceTypeName: 'LayoutTester', demandDays: 5 }],
    })
    renderPage()

    const hoursInput = await screen.findByRole('spinbutton', { name: /hours per day for layouttester/i })
    expect(hoursInput).toBeInTheDocument()
    expect(hoursInput).toHaveValue(7.6)
  })

  it('renders + Add named resource button with accessible name within resource type', async () => {
    mockResourceTypes = [baseResourceType]
    mockTimeline = createTimeline({
      weeklyDemand: [{ resourceTypeName: 'LayoutTester', demandDays: 5 }],
    })
    renderPage()

    const card = await screen.findByTestId(`resource-type-card-${rtId}`)
    expect(card).toBeInTheDocument()

    // Card contains the type name
    expect(within(card).getByText('LayoutTester')).toBeInTheDocument()

    // Card contains Count label and its value
    expect(within(card).getByText('Count')).toBeInTheDocument()
    expect(within(card).getByText('3')).toBeInTheDocument()

    // Card contains Hours per day spinbutton with contextual accessible name
    const hoursInput = within(card).getByRole('spinbutton', { name: /hours per day for layouttester/i })
    expect(hoursInput).toBeInTheDocument()
    expect(hoursInput).toHaveValue(7.6)

    // Card contains the contextual add button
    const addBtn = within(card).getByRole('button', { name: /add named resource to layouttester/i })
    expect(addBtn).toBeInTheDocument()
    expect(addBtn).toHaveAttribute('title', 'Add person')
    // Assert ml-auto is not present (targeted class guard for issue #369)
    expect(addBtn.className).not.toMatch(/\bml-auto\b/)
  })

  it('renders named resource column headers and fields together', async () => {
    mockResourceTypes = [baseResourceType]
    mockTimeline = createTimeline({
      weeklyDemand: [{ resourceTypeName: 'LayoutTester', demandDays: 5 }],
      namedResources: [{ ...baseNamedResource }],
    })
    renderPage()

    // Column headers are visible
    expect(await screen.findByText('Named resource')).toBeInTheDocument()
    expect(screen.getByText('Availability pattern')).toBeInTheDocument()
    expect(screen.getByText('Available %')).toBeInTheDocument()
    expect(screen.getByText('Available from')).toBeInTheDocument()
    expect(screen.getByText('Available to')).toBeInTheDocument()

    // Named resource name is rendered (may appear in multiple panels)
    const bobNames = await screen.findAllByText('Bob')
    expect(bobNames.length).toBeGreaterThanOrEqual(1)

    // Planning basis select has contextual accessible name
    const basisSelect = screen.getByRole('combobox', { name: /availability pattern for bob/i })
    expect(basisSelect).toBeInTheDocument()
    expect(basisSelect).toHaveValue('EFFORT')

    // Remove button has an accessible name and adequate target size classes
    const removeBtn = screen.getByRole('button', { name: /remove bob/i })
    expect(removeBtn).toBeInTheDocument()
    expect(removeBtn).toHaveAttribute('title', 'Remove person')
    expect(removeBtn.className).toMatch(/w-8/)
    expect(removeBtn.className).toMatch(/h-8/)
  })

  it('desktop column headers are hidden on mobile via CSS class', async () => {
    mockResourceTypes = [baseResourceType]
    mockTimeline = createTimeline({
      weeklyDemand: [{ resourceTypeName: 'LayoutTester', demandDays: 5 }],
      namedResources: [{ ...baseNamedResource }],
    })
    renderPage()

    // The column header div has 'hidden' class (hidden on mobile, visible on sm+)
    const headersDiv = (await screen.findByText('Named resource')).closest('div')
    expect(headersDiv).toBeInTheDocument()
    expect(headersDiv?.className).toMatch(/\bhidden\b/)
    expect(headersDiv?.className).toMatch(/\bsm:grid\b/)
  })

  it('renders mobile inline labels (Basis:, Alloc:, Start:, End:) for each named resource', async () => {
    mockResourceTypes = [baseResourceType]
    mockTimeline = createTimeline({
      weeklyDemand: [{ resourceTypeName: 'LayoutTester', demandDays: 5 }],
      namedResources: [{ ...baseNamedResource, allocationMode: 'TIMELINE' }],
    })
    renderPage()

    await screen.findAllByText('Bob')

    // Mobile inline labels exist for each control
    expect(screen.getByText('Pattern:')).toBeInTheDocument()
    expect(screen.getByText('Avail:')).toBeInTheDocument()
    expect(screen.getByText('Avail from:')).toBeInTheDocument()
    expect(screen.getByText('Avail to:')).toBeInTheDocument()

    // Inline label spans have sm:hidden class
    const basisLabel = screen.getByText('Pattern:')
    expect(basisLabel.className).toMatch(/\bsm:hidden\b/)
  })

  it('allocation percentage input has contextual accessible name', async () => {
    mockResourceTypes = [baseResourceType]
    mockTimeline = createTimeline({
      weeklyDemand: [{ resourceTypeName: 'LayoutTester', demandDays: 5 }],
      namedResources: [{
        ...baseNamedResource,
        allocationMode: 'FULL_PROJECT',
        allocationPercent: 75,
      }],
    })
    renderPage()

    await screen.findAllByText('Bob')

    const pctInput = screen.getByRole('spinbutton', { name: /available percentage for bob/i })
    expect(pctInput).toBeInTheDocument()
    expect(pctInput).toHaveValue(75)

    // Start/end inputs have contextual accessible names and are disabled in non-TIMELINE mode
    const startInput = screen.getByRole('spinbutton', { name: /available from week for bob/i })
    expect(startInput).toBeDisabled()

    const endInput = screen.getByRole('spinbutton', { name: /available to week for bob/i })
    expect(endInput).toBeDisabled()
  })

  it('start/end inputs have contextual accessible names and remain labeled when disabled', async () => {
    mockResourceTypes = [baseResourceType]
    mockTimeline = createTimeline({
      weeklyDemand: [{ resourceTypeName: 'LayoutTester', demandDays: 5 }],
      namedResources: [{ ...baseNamedResource, allocationMode: 'FULL_PROJECT' }],
    })
    renderPage()

    await screen.findAllByText('Bob')

    // Both start/end inputs are disabled for non-TIMELINE mode
    const startInput = screen.getByRole('spinbutton', { name: /available from week for bob/i })
    expect(startInput).toBeDisabled()
    expect(startInput).toHaveAttribute('aria-label', 'Available from week for Bob')

    const endInput = screen.getByRole('spinbutton', { name: /available to week for bob/i })
    expect(endInput).toBeDisabled()
    expect(endInput).toHaveAttribute('aria-label', 'Available to week for Bob')
  })

  it('preserves existing mutation behaviour when hours change', async () => {
    mockResourceTypes = [{
      ...baseResourceType,
      hoursPerDay: 8,
    }]
    mockTimeline = createTimeline({
      weeklyDemand: [{ resourceTypeName: 'LayoutTester', demandDays: 5 }],
    })
    renderPage()

    const hoursInput = (await screen.findByRole('spinbutton', { name: /hours per day for layouttester/i })) as HTMLInputElement

    fireEvent.change(hoursInput, { target: { value: '6.5' } })
    fireEvent.blur(hoursInput)

    await waitFor(() => {
      expect(mockPut).toHaveBeenCalledWith(
        `/projects/${projectId}/resource-types/${rtId}`,
        { hoursPerDay: 6.5 },
      )
    })
  })

  it('availability pattern change submits exact mutation payload', async () => {
    mockResourceTypes = [baseResourceType]
    mockTimeline = createTimeline({
      weeklyDemand: [{ resourceTypeName: 'LayoutTester', demandDays: 5 }],
      namedResources: [{ ...baseNamedResource }],
    })
    renderPage()

    await screen.findAllByText('Bob')

    const select = screen.getByRole('combobox', { name: /availability pattern for bob/i })
    fireEvent.change(select, { target: { value: 'FULL_PROJECT' } })

    await waitFor(() => {
      expect(mockPut).toHaveBeenCalledWith(
        `/projects/${projectId}/capacity-profiles/NAMED_PERSON/${nrId}`,
        expect.objectContaining({
          planningBasis: 'WHOLE_PROJECT_ALLOCATION',
          defaultPercent: 100,
          startWeek: null,
          endWeek: null,
        }),
      )
    })
  })

  it('allocation/start/end onBlur behaviour is preserved', async () => {
    mockResourceTypes = [baseResourceType]
    mockTimeline = createTimeline({
      weeklyDemand: [{ resourceTypeName: 'LayoutTester', demandDays: 5 }],
      namedResources: [{
        ...baseNamedResource,
        allocationMode: 'TIMELINE',
        allocationPercent: 80,
        allocationStartWeek: 2,
        allocationEndWeek: 10,
      }],
    })
    renderPage()

    await screen.findAllByText('Bob')

    // Change allocation percent
    const pctInput = screen.getByRole('spinbutton', { name: /available percentage for bob/i })
    fireEvent.change(pctInput, { target: { value: '60' } })
    fireEvent.blur(pctInput)

    await waitFor(() => {
      expect(mockPut).toHaveBeenCalledWith(
        `/projects/${projectId}/capacity-profiles/NAMED_PERSON/${nrId}`,
        expect.objectContaining({ defaultPercent: 60 }),
      )
    })

    // Change start week
    const startInput = screen.getByRole('spinbutton', { name: /available from week for bob/i })
    fireEvent.change(startInput, { target: { value: '5' } })
    fireEvent.blur(startInput)

    await waitFor(() => {
      expect(mockPut).toHaveBeenCalledWith(
        `/projects/${projectId}/capacity-profiles/NAMED_PERSON/${nrId}`,
        expect.objectContaining({ startWeek: 5 }),
      )
    })

    // Change end week
    const endInput = screen.getByRole('spinbutton', { name: /available to week for bob/i })
    fireEvent.change(endInput, { target: { value: '15' } })
    fireEvent.blur(endInput)

    await waitFor(() => {
      expect(mockPut).toHaveBeenCalledWith(
        `/projects/${projectId}/capacity-profiles/NAMED_PERSON/${nrId}`,
        expect.objectContaining({ endWeek: 15 }),
      )
    })
  })

  it('add and remove actions retain their current callbacks', async () => {
    mockResourceTypes = [baseResourceType]
    mockTimeline = createTimeline({
      weeklyDemand: [{ resourceTypeName: 'LayoutTester', demandDays: 5 }],
      namedResources: [{ ...baseNamedResource }],
    })
    // Mock post for add
    mockPost.mockResolvedValue({ data: { id: 'new-nr' } })
    mockDelete.mockResolvedValue({ data: {} })
    renderPage()

    await screen.findAllByText('LayoutTester')

    // Click the Add named resource button
    const addBtn = screen.getByRole('button', { name: /add named resource to layouttester/i })
    fireEvent.click(addBtn)

    await waitFor(() => {
      expect(mockPost).toHaveBeenCalledWith(
        `/projects/${projectId}/resource-types/${rtId}/named-resources`,
        expect.objectContaining({ name: expect.stringContaining('LayoutTester') }),
      )
    })

    // Click the remove button
    mockGet.mockClear()
    const removeBtn = screen.getByRole('button', { name: /remove bob/i })
    // Stub window.confirm
    const originalConfirm = window.confirm
    window.confirm = vi.fn(() => true)
    fireEvent.click(removeBtn)
    window.confirm = originalConfirm

    await waitFor(() => {
      expect(mockDelete).toHaveBeenCalledWith(
        `/projects/${projectId}/resource-types/${rtId}/named-resources/${nrId}`,
      )
    })
  })

  it('resource-counts test ID is rendered on the counts panel', async () => {
    mockResourceTypes = [baseResourceType]
    mockTimeline = createTimeline({
      weeklyDemand: [{ resourceTypeName: 'LayoutTester', demandDays: 5 }],
    })
    renderPage()

    const countsPanel = await screen.findByTestId('resource-counts')
    expect(countsPanel).toBeInTheDocument()
  })

  it('resource-type-card test ID is rendered for each resource type', async () => {
    mockResourceTypes = [baseResourceType]
    mockTimeline = createTimeline({
      weeklyDemand: [{ resourceTypeName: 'LayoutTester', demandDays: 5 }],
    })
    renderPage()

    const card = await screen.findByTestId(`resource-type-card-${rtId}`)
    expect(card).toBeInTheDocument()
    expect(card.className).toMatch(/border.*rounded-lg/)
  })

  it('named-resource mutation calls central invalidation once, no direct duplicate', async () => {
    mockResourceTypes = [baseResourceType]
    mockTimeline = createTimeline({
      weeklyDemand: [{ resourceTypeName: 'LayoutTester', demandDays: 5 }],
      namedResources: [{ ...baseNamedResource, allocationMode: 'TIMELINE' }],
    })
    mockPut.mockResolvedValue({ data: {} })

    const qc = createQueryClient()
    const spy = vi.spyOn(qc, 'invalidateQueries')
    renderPage(qc)

    await screen.findAllByText('Bob')

    // Trigger update by changing allocation percent
    const pctInput = screen.getByRole('spinbutton', { name: /available percentage for bob/i })
    fireEvent.change(pctInput, { target: { value: '60' } })
    fireEvent.blur(pctInput)

    await waitFor(() => {
      expect(mockPut).toHaveBeenCalled()
    })

    // The central helper invalidates 4 keys including ['timeline', projectId]
    // There should be NO separate direct ['timeline', projectId] call
    const timelineInvocations = spy.mock.calls.filter(
      args => JSON.stringify(args[0]?.queryKey) === JSON.stringify(['timeline', projectId]),
    )
    // Expect exactly 1 call from invalidateProjectResourceProfile
    expect(timelineInvocations.length).toBe(1)

    spy.mockRestore()
  })

  it('renders named-resource-headers test ID on desktop header block', async () => {
    mockResourceTypes = [baseResourceType]
    mockTimeline = createTimeline({
      weeklyDemand: [{ resourceTypeName: 'LayoutTester', demandDays: 5 }],
      namedResources: [{ ...baseNamedResource }],
    })
    renderPage()

    await screen.findAllByText('Bob')

    const headers = screen.getByTestId('named-resource-headers')
    expect(headers).toBeInTheDocument()
    expect(headers.className).toMatch(/\bhidden\b/)
    expect(headers.className).toMatch(/\bsm:grid\b/)
  })

  it('renders named-resource-row test ID for each persisted named resource', async () => {
    mockResourceTypes = [baseResourceType]
    mockTimeline = createTimeline({
      weeklyDemand: [{ resourceTypeName: 'LayoutTester', demandDays: 5 }],
      namedResources: [{ ...baseNamedResource }],
    })
    renderPage()

    await screen.findAllByText('Bob')

    const row = screen.getByTestId(`named-resource-row-${nrId}`)
    expect(row).toBeInTheDocument()
    expect(row.className).toMatch(/grid-cols-1/)
    // Row should have the multi-column sm:grid-cols-[...] layout
    expect(row.className).toMatch(/sm:grid-cols-/)
    expect(row.getAttribute('data-testid')).toBe(`named-resource-row-${nrId}`)
  })
})

// ---------------------------------------------------------------------------
// Squad Planner deep link — issue #383
// ---------------------------------------------------------------------------
describe('TimelinePage — Squad Planner deep link', () => {
  beforeEach(() => {
    const localStorageStore: Record<string, string> = {}
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => localStorageStore[key] ?? null,
      setItem: (key: string, value: string) => { localStorageStore[key] = value },
      removeItem: (key: string) => { delete localStorageStore[key] },
      clear: () => { Object.keys(localStorageStore).forEach(k => delete localStorageStore[k]) },
      length: 0,
      key: () => null,
    })

    vi.clearAllMocks()

    mockGet.mockImplementation((url: string) => {
      if (url.includes('/timeline')) return Promise.resolve({ data: mockTimeline })
      if (url.includes('/resource-types')) return Promise.resolve({ data: mockResourceTypes })
      return Promise.resolve({ data: mockProject })
    })

    mockPost.mockImplementation(() => Promise.resolve({ data: mockTimeline }))
    mockPatch.mockResolvedValue({ data: mockProject })
    mockDelete.mockResolvedValue({ data: {} })
    mockNavigate.mockClear()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('loading Timeline with ?panel=squad-planner opens Squad Planner drawer', async () => {
    render(
      <QueryClientProvider client={createQueryClient()}>
        <MemoryRouter initialEntries={[`/projects/${projectId}/timeline?panel=squad-planner`]}>
          <Routes>
            <Route path="/projects/:id/timeline" element={<TimelinePage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    )

    expect(await screen.findByTestId('squad-planner-drawer')).toBeInTheDocument()
  })

  it('loading Timeline without panel param leaves Squad Planner closed', async () => {
    renderPage()

    // Wait for page to render
    await screen.findByText('Planning Settings')

    expect(screen.queryByTestId('squad-planner-drawer')).not.toBeInTheDocument()
  })

  it('closing Squad Planner does not immediately reopen it', async () => {
    render(
      <QueryClientProvider client={createQueryClient()}>
        <MemoryRouter initialEntries={[`/projects/${projectId}/timeline?panel=squad-planner`]}>
          <Routes>
            <Route path="/projects/:id/timeline" element={<TimelinePage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    )

    // Wait for auto-open
    expect(await screen.findByTestId('squad-planner-drawer')).toBeInTheDocument()

    // Close via the button
    fireEvent.click(screen.getByText('Close Squad Planner'))

    // Verify it closed and stays closed
    await waitFor(() => {
      expect(screen.queryByTestId('squad-planner-drawer')).not.toBeInTheDocument()
    })
  })
})
