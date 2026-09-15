/**
 * TemplateLibraryPage — template metadata contract (issue #168).
 *
 * Covers the client half of the metadata contract:
 *   - stored rich-text metadata is rendered as sanitised HTML, never as raw markup;
 *   - template create/edit submits description and assumptions;
 *   - template-task create/edit submits description and assumptions.
 *
 * RichTextEditor is replaced with a textarea, matching the existing convention
 * used by BacklogGrid.test.tsx and ProjectContextPanel.test.tsx.
 */

import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import TemplateLibraryPage from '@/pages/TemplateLibraryPage'
import { api } from '@/lib/api'

vi.mock('@/lib/api', () => ({
  api: {
    get: vi.fn().mockResolvedValue({ data: [] }),
    post: vi.fn().mockResolvedValue({ data: {} }),
    put: vi.fn().mockResolvedValue({ data: {} }),
    delete: vi.fn().mockResolvedValue({ data: {} }),
  },
}))

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ user: { name: 'Test User', email: 'test@example.com' }, logout: vi.fn() }),
}))

vi.mock('../components/shared/RichTextEditor', () => ({
  default: ({ value, onChange, ariaLabel }: { value: string; onChange: (value: string) => void; ariaLabel?: string }) => (
    <textarea aria-label={ariaLabel} value={value} onChange={event => onChange(event.target.value)} />
  ),
}))

const TEMPLATE_ID = 'tpl-1'
const DESCRIPTION = '<p>Template <strong>description</strong></p><script>window.pwned = 1</script>'
const ASSUMPTIONS = '<p>Team available</p>'
const TASK_DESCRIPTION = '<p>Task description</p><img src="x" onerror="window.pwned = 1" />'
const TASK_ASSUMPTIONS = '<p>Test tenant provisioned</p>'

const template = {
  id: TEMPLATE_ID,
  name: 'Auth Feature',
  category: 'Security',
  description: DESCRIPTION,
  assumptions: ASSUMPTIONS,
  tasks: [
    {
      id: 'ttask-1',
      templateId: TEMPLATE_ID,
      name: 'Backend Auth',
      description: TASK_DESCRIPTION,
      assumptions: TASK_ASSUMPTIONS,
      hoursExtraSmall: 1,
      hoursSmall: 2,
      hoursMedium: 4,
      hoursLarge: 8,
      hoursExtraLarge: 16,
      resourceTypeName: 'Developer',
    },
  ],
}

function mockApi(templates: unknown[] = [template]) {
  vi.mocked(api.get).mockImplementation((url: string) => {
    if (url === '/global-resource-types') return Promise.resolve({ data: [] } as never)
    return Promise.resolve({ data: templates } as never)
  })
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/templates']}>
        <TemplateLibraryPage />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

async function renderWithTemplate() {
  const view = renderPage()
  await screen.findByText('Auth Feature')
  return view
}

beforeEach(() => {
  vi.clearAllMocks()
  mockApi()
})

describe('TemplateLibraryPage metadata display', () => {
  it('renders stored template metadata as sanitised HTML rather than raw markup', async () => {
    const { container } = await renderWithTemplate()

    expect(screen.getByText('description')).toBeInTheDocument()
    expect(screen.getByText('Team available')).toBeInTheDocument()
    expect(container.querySelector('script')).toBeNull()
    expect(container.textContent).not.toContain('<p>')
  })

  it('renders task metadata as sanitised HTML once expanded', async () => {
    const { container } = await renderWithTemplate()

    fireEvent.click(screen.getByText('Auth Feature'))
    fireEvent.click(await screen.findByRole('button', { name: /description & assumptions/i }))

    expect(screen.getByText('Task description')).toBeInTheDocument()
    expect(screen.getByText('Test tenant provisioned')).toBeInTheDocument()
    expect(container.querySelector('img[onerror]')).toBeNull()
    expect(container.textContent).not.toContain('onerror')
  })

  it('omits the task metadata toggle when a task has neither field', async () => {
    mockApi([{ ...template, tasks: [{ ...template.tasks[0], description: null, assumptions: null }] }])

    await renderWithTemplate()
    fireEvent.click(screen.getByText('Auth Feature'))

    expect(screen.queryByRole('button', { name: /description & assumptions/i })).not.toBeInTheDocument()
  })
})

describe('TemplateLibraryPage metadata editing', () => {
  it('submits description and assumptions when creating a template', async () => {
    await renderWithTemplate()

    fireEvent.click(screen.getByRole('button', { name: /new template/i }))
    fireEvent.change(screen.getByPlaceholderText(/template name/i), { target: { value: 'Payments' } })
    fireEvent.change(screen.getByLabelText('Template description'), { target: { value: DESCRIPTION } })
    fireEvent.change(screen.getByLabelText('Template assumptions'), { target: { value: ASSUMPTIONS } })
    fireEvent.click(screen.getByRole('button', { name: /^save template$/i }))

    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/templates', expect.objectContaining({
      name: 'Payments',
      description: DESCRIPTION,
      assumptions: ASSUMPTIONS,
    })))
  })

  it('submits description and assumptions when editing a template', async () => {
    await renderWithTemplate()

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    fireEvent.change(screen.getByLabelText('Template assumptions'), { target: { value: '<p>Updated assumption</p>' } })
    fireEvent.click(screen.getByRole('button', { name: /^save template$/i }))

    await waitFor(() => expect(api.put).toHaveBeenCalledWith(`/templates/${TEMPLATE_ID}`, expect.objectContaining({
      assumptions: '<p>Updated assumption</p>',
    })))
  })

  it('submits description and assumptions when creating a template task', async () => {
    await renderWithTemplate()

    fireEvent.click(screen.getByText('Auth Feature'))
    fireEvent.click(screen.getByRole('button', { name: /add task/i }))
    fireEvent.change(screen.getByPlaceholderText(/task name/i), { target: { value: 'Add MFA' } })
    fireEvent.change(screen.getByPlaceholderText(/resource type name/i), { target: { value: 'Developer' } })
    fireEvent.change(screen.getByLabelText('Task description'), { target: { value: TASK_DESCRIPTION } })
    fireEvent.change(screen.getByLabelText('Task assumptions'), { target: { value: TASK_ASSUMPTIONS } })
    fireEvent.click(screen.getByRole('button', { name: /^save task$/i }))

    await waitFor(() => expect(api.post).toHaveBeenCalledWith(`/templates/${TEMPLATE_ID}/tasks`, expect.objectContaining({
      name: 'Add MFA',
      description: TASK_DESCRIPTION,
      assumptions: TASK_ASSUMPTIONS,
    })))
  })

  it('submits description and assumptions when editing a template task', async () => {
    await renderWithTemplate()

    fireEvent.click(screen.getByText('Auth Feature'))
    const taskRow = within(screen.getByRole('table')).getByRole('row', { name: /Backend Auth/ })
    fireEvent.click(within(taskRow).getByRole('button', { name: 'Edit' }))
    expect(screen.getByLabelText('Task description')).toHaveValue(TASK_DESCRIPTION)
    fireEvent.change(screen.getByLabelText('Task description'), { target: { value: '<p>Revised task description</p>' } })
    fireEvent.click(screen.getByRole('button', { name: /^save task$/i }))

    await waitFor(() => expect(api.put).toHaveBeenCalledWith(`/templates/${TEMPLATE_ID}/tasks/ttask-1`, expect.objectContaining({
      description: '<p>Revised task description</p>',
      assumptions: TASK_ASSUMPTIONS,
    })))
  })
})
