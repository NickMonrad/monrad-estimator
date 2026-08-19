import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import ProjectSettingsPage from '@/pages/ProjectSettingsPage'

const mockGet = vi.hoisted(() => vi.fn())
const mockPost = vi.hoisted(() => vi.fn())
const mockPut = vi.hoisted(() => vi.fn())
const mockPatch = vi.hoisted(() => vi.fn())
const mockDelete = vi.hoisted(() => vi.fn())

vi.mock('@/lib/api', () => ({
  api: { get: mockGet, post: mockPost, put: mockPut, patch: mockPatch, delete: mockDelete },
  apiErrorMessage: (_error: unknown, fallback: string) => fallback,
  getCustomers: vi.fn().mockResolvedValue([]),
  getOrgs: vi.fn().mockResolvedValue([]),
  moveProjectToOrg: vi.fn(),
}))

vi.mock('@/components/layout/AppLayout', () => ({
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

vi.mock('@/components/shared/RichTextEditor', () => ({
  default: ({ value, onChange }: { value: string; onChange: (value: string) => void }) => (
    <textarea aria-label="Project description" value={value} onChange={event => onChange(event.target.value)} />
  ),
}))

const project = { id: 'project-a', name: 'Project A', description: '', status: 'DRAFT', hoursPerDay: 7.6, bufferWeeks: 0, onboardingWeeks: 0, taxRate: 10, taxLabel: 'GST' }
let dependencies: Array<{ id: string; description: string; order: number }> = []
let risks: Array<{ id: string; description: string; mitigation: string | null; order: number }> = []

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/projects/project-a/settings']}>
        <Routes>
          <Route path="/projects/:id/settings" element={<ProjectSettingsPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  dependencies = [
    { id: 'dependency-1', description: 'API access', order: 0 },
    { id: 'dependency-2', description: 'Test data', order: 1 },
  ]
  risks = [{ id: 'risk-1', description: 'Vendor delay', mitigation: null, order: 0 }]
  vi.clearAllMocks()
  mockGet.mockImplementation((url: string) => {
    if (url.endsWith('/dependencies')) return Promise.resolve({ data: dependencies })
    if (url.endsWith('/risks')) return Promise.resolve({ data: risks })
    return Promise.resolve({ data: project })
  })
  mockPost.mockImplementation((url: string, body: { description: string; mitigation?: string }) => {
    if (url.endsWith('/dependencies')) {
      const created = { id: 'dependency-new', description: body.description, order: dependencies.length }
      dependencies = [...dependencies, created]
      return Promise.resolve({ data: created })
    }
    const created = { id: 'risk-new', description: body.description, mitigation: body.mitigation || null, order: risks.length }
    risks = [...risks, created]
    return Promise.resolve({ data: created })
  })
  mockPut.mockResolvedValue({ data: {} })
  mockPatch.mockResolvedValue({ data: { ok: true } })
  mockDelete.mockResolvedValue({ data: { message: 'Deleted' } })
  vi.stubGlobal('confirm', vi.fn(() => true))
})

describe('ProjectSettingsPage project context editing', () => {
  it('adds dependencies and risks with mitigation', async () => {
    renderPage()
    await screen.findByText('API access')

    fireEvent.change(screen.getByLabelText('Add dependency'), { target: { value: 'Credentials' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add dependency' }))
    expect(mockPost).toHaveBeenCalledWith('/projects/project-a/dependencies', { description: 'Credentials' })
    await waitFor(() => expect(screen.getByText('Credentials')).toBeInTheDocument())

    fireEvent.change(screen.getByLabelText('Add risk'), { target: { value: 'Vendor outage' } })
    fireEvent.change(screen.getByLabelText('Mitigation / response (optional)'), { target: { value: 'Fallback vendor' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add risk' }))
    await waitFor(() => expect(mockPost).toHaveBeenCalledWith('/projects/project-a/risks', { description: 'Vendor outage', mitigation: 'Fallback vendor' }))
  })

  it('shows an inline error when project context loading fails', async () => {
    mockGet.mockImplementation((url: string) => {
      if (url.endsWith('/dependencies')) return Promise.reject(new Error('Dependency load failed'))
      if (url.endsWith('/risks')) return Promise.resolve({ data: risks })
      return Promise.resolve({ data: project })
    })

    renderPage()

    expect(await screen.findByRole('alert')).toHaveTextContent('Failed to load project dependencies and risks.')
  })

  it('edits, reorders and deletes project context rows', async () => {
    renderPage()
    await screen.findByText('API access')

    fireEvent.click(screen.getByRole('button', { name: 'Move dependency 1 down' }))
    await waitFor(() => expect(mockPatch).toHaveBeenCalledWith('/projects/project-a/dependencies/reorder', {
      items: [{ id: 'dependency-2', order: 0 }, { id: 'dependency-1', order: 1 }],
    }))

    fireEvent.click(screen.getAllByRole('button', { name: 'Edit' }).at(-1)!)
    fireEvent.change(screen.getByLabelText('Risk description'), { target: { value: 'Vendor delay updated' } })
    fireEvent.change(screen.getAllByLabelText('Mitigation / response (optional)').at(0)!, { target: { value: 'Escalate early' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(mockPut).toHaveBeenCalledWith('/projects/project-a/risks/risk-1', {
      description: 'Vendor delay updated', mitigation: 'Escalate early',
    }))

    fireEvent.click(screen.getAllByRole('button', { name: 'Delete' })[0])
    await waitFor(() => expect(mockDelete).toHaveBeenCalledWith('/projects/project-a/dependencies/dependency-1'))
  })
})
