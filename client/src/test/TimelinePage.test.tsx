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

    mockPatch.mockImplementation((url: string, body: Record<string, unknown>) => {
      if (url.includes('/named-resources/')) {
        const nrId = url.split('/').pop()
        mockTimeline = {
          ...mockTimeline,
          namedResources: (mockTimeline.namedResources ?? []).map((nr: any) =>
            nr.id === nrId ? { ...nr, ...body } : nr,
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
    expect(screen.getByText('Planning basis')).toBeInTheDocument()
    expect(screen.getByText('Allocation %')).toBeInTheDocument()
    expect(screen.getByText('Start')).toBeInTheDocument()
    expect(screen.getByText('End')).toBeInTheDocument()
  })

  it('renders the named-resource name in its row', async () => {
    setupWithNamedResource()
    renderPage()


    const alice = await screen.findAllByText('Alice')
    expect(alice.length).toBeGreaterThan(0)
    expect(screen.getByText(/No assigned weeks.*Demand-following/i)).toBeInTheDocument()
  })

  it('shows a planning basis select defaulting to Demand-following', async () => {
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
      expect(mockPatch).toHaveBeenCalledWith(
        `/projects/${projectId}/resource-types/${rtId}/named-resources/${nrId}`,
        expect.objectContaining({
          allocationMode: 'FULL_PROJECT',
          allocationStartWeek: null,
          allocationEndWeek: null,
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
      expect(mockPatch).toHaveBeenCalledWith(
        `/projects/${projectId}/resource-types/${rtId}/named-resources/${nrId}`,
        expect.objectContaining({
          allocationMode: 'TIMELINE',
          allocationStartWeek: 3,
          allocationEndWeek: 12,
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

  it('switches to Capacity profile without losing the allocation percent', async () => {
    setupWithNamedResource({
      allocationMode: 'TIMELINE',
      allocationPercent: 80,
      allocationStartWeek: 2,
      allocationEndWeek: 10,
    })
    renderPage()

    const select = await screen.findByRole('combobox')
    fireEvent.change(select, { target: { value: 'CAPACITY_PLAN' } })

    await waitFor(() => {
      expect(mockPatch).toHaveBeenCalledWith(
        `/projects/${projectId}/resource-types/${rtId}/named-resources/${nrId}`,
        expect.objectContaining({
          allocationMode: 'CAPACITY_PLAN',
          allocationPercent: 80,
          allocationStartWeek: null,
          allocationEndWeek: null,
        }),
      )
    })

    await waitFor(() => {
      expect(select).toHaveValue('CAPACITY_PLAN')
    })
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

  it('marks timeline stale after allocation mode change', async () => {
    setupWithNamedResource({ allocationMode: 'EFFORT' })
    renderPage()


    const select = await screen.findByRole('combobox')
    fireEvent.change(select, { target: { value: 'FULL_PROJECT' } })

    await waitFor(() => {
      expect(mockPatch).toHaveBeenCalled()
    })

    // stale banner should appear after patch resolves
    await waitFor(() => {
      expect(screen.getByText(/timeline inputs changed/i)).toBeInTheDocument()
    })
  })
})

// ---------------------------------------------------------------------------
// Resource-counts section layout — issue #369
// ---------------------------------------------------------------------------
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

    await screen.findAllByText('LayoutTester')

    const addBtn = screen.getByRole('button', { name: /add named resource to layouttester/i })
    expect(addBtn).toBeInTheDocument()
    expect(addBtn).toHaveAttribute('title', 'Add person')
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
    expect(screen.getByText('Planning basis')).toBeInTheDocument()
    expect(screen.getByText('Allocation %')).toBeInTheDocument()
    expect(screen.getByText('Start')).toBeInTheDocument()
    expect(screen.getByText('End')).toBeInTheDocument()

    // Named resource name is rendered (may appear in multiple panels)
    const bobNames = await screen.findAllByText('Bob')
    expect(bobNames.length).toBeGreaterThanOrEqual(1)

    // Planning basis select has contextual accessible name
    const basisSelect = screen.getByRole('combobox', { name: /planning basis for bob/i })
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
    expect(screen.getByText('Basis:')).toBeInTheDocument()
    expect(screen.getByText('Alloc:')).toBeInTheDocument()
    expect(screen.getByText('Start:')).toBeInTheDocument()
    expect(screen.getByText('End:')).toBeInTheDocument()

    // Inline label spans have sm:hidden class
    const basisLabel = screen.getByText('Basis:')
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

    const pctInput = screen.getByRole('spinbutton', { name: /allocation percentage for bob/i })
    expect(pctInput).toBeInTheDocument()
    expect(pctInput).toHaveValue(75)

    // Start/end inputs have contextual accessible names and are disabled in non-TIMELINE mode
    const startInput = screen.getByRole('spinbutton', { name: /start week for bob/i })
    expect(startInput).toBeDisabled()

    const endInput = screen.getByRole('spinbutton', { name: /end week for bob/i })
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
    const startInput = screen.getByRole('spinbutton', { name: /start week for bob/i })
    expect(startInput).toBeDisabled()
    expect(startInput).toHaveAttribute('aria-label', 'Start week for Bob')

    const endInput = screen.getByRole('spinbutton', { name: /end week for bob/i })
    expect(endInput).toBeDisabled()
    expect(endInput).toHaveAttribute('aria-label', 'End week for Bob')
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

  it('planning basis change submits exact mutation payload', async () => {
    mockResourceTypes = [baseResourceType]
    mockTimeline = createTimeline({
      weeklyDemand: [{ resourceTypeName: 'LayoutTester', demandDays: 5 }],
      namedResources: [{ ...baseNamedResource }],
    })
    renderPage()

    await screen.findAllByText('Bob')

    const select = screen.getByRole('combobox', { name: /planning basis for bob/i })
    fireEvent.change(select, { target: { value: 'FULL_PROJECT' } })

    await waitFor(() => {
      expect(mockPatch).toHaveBeenCalledWith(
        `/projects/${projectId}/resource-types/${rtId}/named-resources/${nrId}`,
        expect.objectContaining({
          allocationMode: 'FULL_PROJECT',
          allocationPercent: 100,
          allocationStartWeek: null,
          allocationEndWeek: null,
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
    const pctInput = screen.getByRole('spinbutton', { name: /allocation percentage for bob/i })
    fireEvent.change(pctInput, { target: { value: '60' } })
    fireEvent.blur(pctInput)

    await waitFor(() => {
      expect(mockPatch).toHaveBeenCalledWith(
        `/projects/${projectId}/resource-types/${rtId}/named-resources/${nrId}`,
        expect.objectContaining({ allocationPercent: 60 }),
      )
    })

    // Change start week
    const startInput = screen.getByRole('spinbutton', { name: /start week for bob/i })
    fireEvent.change(startInput, { target: { value: '5' } })
    fireEvent.blur(startInput)

    await waitFor(() => {
      expect(mockPatch).toHaveBeenCalledWith(
        `/projects/${projectId}/resource-types/${rtId}/named-resources/${nrId}`,
        expect.objectContaining({ allocationStartWeek: 5 }),
      )
    })

    // Change end week
    const endInput = screen.getByRole('spinbutton', { name: /end week for bob/i })
    fireEvent.change(endInput, { target: { value: '15' } })
    fireEvent.blur(endInput)

    await waitFor(() => {
      expect(mockPatch).toHaveBeenCalledWith(
        `/projects/${projectId}/resource-types/${rtId}/named-resources/${nrId}`,
        expect.objectContaining({ allocationEndWeek: 15 }),
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
    mockPatch.mockResolvedValue({ data: {} })

    const qc = createQueryClient()
    const spy = vi.spyOn(qc, 'invalidateQueries')
    renderPage(qc)

    await screen.findAllByText('Bob')

    // Trigger update by changing allocation percent
    const pctInput = screen.getByRole('spinbutton', { name: /allocation percentage for bob/i })
    fireEvent.change(pctInput, { target: { value: '60' } })
    fireEvent.blur(pctInput)

    await waitFor(() => {
      expect(mockPatch).toHaveBeenCalled()
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
