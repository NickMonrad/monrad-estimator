import React from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import ProjectContextPanel from '../components/project/ProjectContextPanel'

const mocks = vi.hoisted(() => ({
  getProjectDependencies: vi.fn(),
  getProjectRisks: vi.fn(),
  createProjectDependency: vi.fn(),
  createProjectRisk: vi.fn(),
  updateProjectDependency: vi.fn(),
  updateProjectRisk: vi.fn(),
  deleteProjectDependency: vi.fn(),
  deleteProjectRisk: vi.fn(),
  reorderProjectDependencies: vi.fn(),
  reorderProjectRisks: vi.fn(),
}))

vi.mock('../lib/api', () => ({
  ...mocks,
  apiErrorMessage: vi.fn((_err: unknown, fallback: string) => fallback),
}))

vi.mock('../components/shared/RichTextEditor', () => ({
  default: ({ value, onChange, ariaLabel, placeholder }: { value: string; onChange: (value: string) => void; ariaLabel?: string; placeholder?: string }) => (
    <textarea aria-label={ariaLabel} placeholder={placeholder} value={value} onChange={event => onChange(event.target.value)} />
  ),
}))

const dependencies = [
  { id: 'dependency-1', projectId: 'project-1', description: 'First dependency', order: 0, createdAt: '', updatedAt: '' },
  { id: 'dependency-2', projectId: 'project-1', description: 'Second dependency', order: 1, createdAt: '', updatedAt: '' },
]

function renderPanel() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={queryClient}><ProjectContextPanel projectId="project-1" /></QueryClientProvider>)
}

describe('ProjectContextPanel', () => {
  it('adds a dependency and submits an ordered move', async () => {
    mocks.getProjectDependencies.mockResolvedValue(dependencies)
    mocks.getProjectRisks.mockResolvedValue([])
    mocks.createProjectDependency.mockResolvedValue({ ...dependencies[0], id: 'dependency-3' })
    mocks.reorderProjectDependencies.mockResolvedValue(dependencies)

    renderPanel()

    const newDependency = await screen.findByLabelText('New dependency description')
    fireEvent.change(newDependency, { target: { value: 'New dependency' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add dependency' }))
    await waitFor(() => expect(mocks.createProjectDependency).toHaveBeenCalledWith('project-1', { description: 'New dependency' }))

    fireEvent.click(screen.getAllByRole('button', { name: 'Move dependency down' })[0])
    await waitFor(() => expect(mocks.reorderProjectDependencies).toHaveBeenCalledWith('project-1', [
      { id: 'dependency-2', order: 0 },
      { id: 'dependency-1', order: 1 },
    ]))
  })
})
