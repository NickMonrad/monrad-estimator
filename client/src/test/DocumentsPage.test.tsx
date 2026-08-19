import React from 'react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import DocumentsPage from '@/pages/DocumentsPage'

const mockGet = vi.hoisted(() => vi.fn())
const mockPost = vi.hoisted(() => vi.fn())

vi.mock('@/lib/api', () => ({
  api: {
    get: mockGet,
    post: mockPost,
    delete: vi.fn(),
  },
}))

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ user: { name: 'Test User', email: 'test@example.com' }, logout: vi.fn() }),
}))

vi.mock('@/components/layout/AppLayout', () => ({
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

type SectionKey = 'cover' | 'scope' | 'effort' | 'timeline' | 'resourceProfile' | 'assumptions' | 'dependencies' | 'risks' | 'ganttChart'

type StoredDocument = {
  id: string
  label: string
  format: string
  type: string
  createdAt: string
  sections: Record<string, boolean> | null
  generatedBy: { email: string }
}

const sectionLabels: Record<SectionKey, string> = {
  cover: 'Cover Page',
  scope: 'Scope Summary',
  effort: 'Effort Breakdown',
  timeline: 'Timeline Summary',
  resourceProfile: 'Resource Profile',
  assumptions: 'Assumptions',
  dependencies: 'Dependencies',
  risks: 'Risks',
  ganttChart: 'Gantt Chart',
}

const defaultSections: Record<SectionKey, boolean> = {
  cover: true,
  scope: true,
  effort: true,
  timeline: true,
  resourceProfile: true,
  assumptions: true,
  dependencies: true,
  risks: true,
  ganttChart: true,
}

let documentsByProject: Record<string, StoredDocument[]> = {}
let pendingDocumentProject: string | null = null
let pendingDocumentResponse: Promise<{ data: StoredDocument[] }> | null = null
let pendingDocumentRequestCount = 0

function documentRecord(id: string, sections: Record<string, boolean> | null): StoredDocument {
  return {
    id,
    label: id,
    format: 'pdf',
    type: 'SCOPE_DOC',
    createdAt: '2026-08-18T01:00:00.000Z',
    sections,
    generatedBy: { email: 'test@example.com' },
  }
}

function projectIdFromUrl(url: string): string {
  return url.match(/^\/projects\/([^/]+)/)?.[1] ?? ''
}

function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  })
}

function ProjectSwitcher({ targetProjectId }: { targetProjectId: string }) {
  const navigate = useNavigate()
  return <button onClick={() => navigate(`/projects/${targetProjectId}/documents`)}>Switch project</button>
}

function renderPage(projectId = 'project-a', targetProjectId?: string) {
  const queryClient = createQueryClient()
  const view = render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[`/projects/${projectId}/documents`]}>
        <Routes>
          <Route
            path="/projects/:id/documents"
            element={
              <>
                <DocumentsPage />
                {targetProjectId && <ProjectSwitcher targetProjectId={targetProjectId} />}
              </>
            }
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
  return { ...view, queryClient }
}

async function expectSections(expected: Record<SectionKey, boolean>) {
  await waitFor(() => {
    for (const key of Object.keys(expected) as SectionKey[]) {
      const checkbox = screen.getByRole('checkbox', { name: sectionLabels[key] })
      if (expected[key]) expect(checkbox).toBeChecked()
      else expect(checkbox).not.toBeChecked()
    }
  })
}

beforeEach(() => {
  documentsByProject = {}
  pendingDocumentProject = null
  pendingDocumentResponse = null
  pendingDocumentRequestCount = 0
  vi.clearAllMocks()
  mockGet.mockImplementation((url: string) => {
    const projectId = projectIdFromUrl(url)
    if (url.endsWith('/documents')) {
      if (projectId === pendingDocumentProject && pendingDocumentResponse) {
        pendingDocumentRequestCount += 1
        return pendingDocumentResponse
      }
      return Promise.resolve({ data: documentsByProject[projectId] ?? [] })
    }
    if (url.includes('/effort')) return Promise.resolve({ data: {} })
    if (url.includes('/timeline')) return Promise.resolve({ data: { projectedEndDate: null } })
    if (url.includes('/resource-profile')) return Promise.resolve({ data: {} })
    if (url.includes('/epics')) return Promise.resolve({ data: [] })
    return Promise.resolve({ data: { id: projectId, name: `Project ${projectId}` } })
  })
})

describe('DocumentsPage section settings restoration', () => {
  it('uses the existing defaults when there are no previous generated documents', async () => {
    renderPage()

    await expectSections(defaultSections)
  })

  it('restores section selections from the newest generated document', async () => {
    const restoredSections = { ...defaultSections, scope: false, effort: false, ganttChart: false }
    documentsByProject['project-a'] = [documentRecord('newest', restoredSections)]
    renderPage()

    await expectSections(restoredSections)
  })

  it('uses the newest generation when document history has different settings', async () => {
    const olderSections = { ...defaultSections, scope: false }
    const newestSections = { ...defaultSections, resourceProfile: false, assumptions: false }
    documentsByProject['project-a'] = [
      documentRecord('newest', newestSections),
      documentRecord('older', olderSections),
    ]
    renderPage()

    await expectSections(newestSections)
  })

  it('keeps settings isolated when switching projects', async () => {
    documentsByProject['project-a'] = [documentRecord('project-a-doc', { ...defaultSections, scope: false })]
    renderPage('project-a', 'project-b')

    await waitFor(() => expect(screen.getByRole('checkbox', { name: sectionLabels.scope })).not.toBeChecked())
    fireEvent.click(screen.getByRole('button', { name: 'Switch project' }))

    await expectSections(defaultSections)
  })

  it('does not replace the latest successful settings after generation fails', async () => {
    const savedSections = { ...defaultSections, timeline: false, assumptions: false }
    documentsByProject['project-a'] = [documentRecord('saved', savedSections)]
    const view = renderPage()
    await expectSections(savedSections)

    mockPost.mockRejectedValueOnce({ response: { data: { error: 'Generation failed' } } })
    fireEvent.click(screen.getByRole('button', { name: 'Generate & Save' }))
    expect(await screen.findByText('Generation failed')).toBeInTheDocument()
    await expectSections(savedSections)

    view.unmount()
    renderPage()
    await expectSections(savedSections)
  })

  it('keeps new section defaults when legacy metadata lacks dependency and risk keys', async () => {
    documentsByProject['project-a'] = [documentRecord('legacy', { cover: false, scope: false })]
    renderPage()

    await waitFor(() => {
      expect(screen.getByRole('checkbox', { name: sectionLabels.cover })).not.toBeChecked()
      expect(screen.getByRole('checkbox', { name: sectionLabels.scope })).not.toBeChecked()
      expect(screen.getByRole('checkbox', { name: sectionLabels.dependencies })).toBeChecked()
      expect(screen.getByRole('checkbox', { name: sectionLabels.risks })).toBeChecked()
    })
  })

  it('falls back to defaults when the latest document has null section metadata', async () => {
    documentsByProject['project-a'] = [documentRecord('legacy', null)]
    renderPage()

    await expectSections(defaultSections)
  })

  it('falls back to defaults for unusable legacy section metadata', async () => {
    documentsByProject['project-a'] = [documentRecord('legacy', { oldSectionName: true })]
    renderPage()

    await expectSections(defaultSections)
  })

  it('does not overwrite user edits when document history refetches', async () => {
    const savedSections = { ...defaultSections, scope: false }
    documentsByProject['project-a'] = [documentRecord('saved', savedSections)]
    const { queryClient } = renderPage()
    await expectSections(savedSections)

    fireEvent.click(screen.getByRole('checkbox', { name: sectionLabels.scope }))
    const documentRequestCount = () => mockGet.mock.calls.filter(([url]) => (url as string).endsWith('/documents')).length
    const previousDocumentRequestCount = documentRequestCount()
    await queryClient.invalidateQueries({ queryKey: ['generated-docs', 'project-a'] })
    await waitFor(() => expect(documentRequestCount()).toBeGreaterThan(previousDocumentRequestCount))

    expect(screen.getByRole('checkbox', { name: sectionLabels.scope })).toBeChecked()
  })

  it('does not overwrite edits made while cached documents refetch', async () => {
    const cachedSections = { ...defaultSections }
    documentsByProject['project-b'] = [documentRecord('refetched', cachedSections)]
    const documentRefetch = Promise.withResolvers<{ data: StoredDocument[] }>()
    pendingDocumentProject = 'project-b'
    pendingDocumentResponse = documentRefetch.promise

    const { queryClient } = renderPage('project-a', 'project-b')
    await expectSections(defaultSections)
    queryClient.setQueryData(['generated-docs', 'project-b'], [documentRecord('cached', cachedSections)])

    fireEvent.click(screen.getByRole('button', { name: 'Switch project' }))
    await waitFor(() => expect(pendingDocumentRequestCount).toBe(1))
    await waitFor(() => expect(screen.getByRole('checkbox', { name: sectionLabels.scope })).toBeChecked())

    fireEvent.click(screen.getByRole('checkbox', { name: sectionLabels.scope }))
    documentRefetch.resolve({ data: documentsByProject['project-b'] })

    await waitFor(() => expect(screen.getByRole('checkbox', { name: sectionLabels.scope })).not.toBeChecked())
  })
})
