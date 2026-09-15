import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import AddFeatureFromTemplateModal from '@/components/backlog/AddFeatureFromTemplateModal'
import FeatureList from '@/components/backlog/FeatureList'
import { api } from '../lib/api'
import type { Feature } from '@/types/backlog'

vi.mock('../lib/api', () => ({
  api: {
    get: vi.fn().mockResolvedValue({ data: [] }),
    post: vi.fn().mockResolvedValue({ data: {} }),
    put: vi.fn().mockResolvedValue({ data: {} }),
    delete: vi.fn().mockResolvedValue({ data: {} }),
  },
  apiErrorMessage: (error: { response?: { data?: { error?: string } } }, fallback: string) =>
    error.response?.data?.error ?? fallback,
  duplicateBacklogItem: vi.fn(),
}))

vi.mock('@/components/shared/RichTextEditor', () => ({
  default: ({ placeholder }: { placeholder?: string }) => <textarea aria-label={placeholder ?? 'Rich text'} />,
}))

const post = vi.mocked(api.post)
const remove = vi.mocked(api.delete)

/** One template whose L tier (8h) is distinguishable from its default M tier (4h). */
const TEMPLATES = [
  {
    id: 'tpl-1',
    name: 'API Endpoint',
    category: null,
    description: null,
    tasks: [
      { id: 'tt-1', name: 'Implement handler', hoursExtraSmall: 1, hoursSmall: 2, hoursMedium: 4, hoursLarge: 8, hoursExtraLarge: 16, resourceTypeName: 'Developer' },
    ],
  },
]

function wrapper({ children }: { children: React.ReactNode }) {
  return <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>
}

function renderModal(onSettled = vi.fn()) {
  render(
    <AddFeatureFromTemplateModal epicId="e1" onClose={vi.fn()} onSettled={onSettled} />,
    { wrapper },
  )
  return onSettled
}

function createButton() {
  return screen.getByRole('button', { name: /^create feature$/i })
}

async function fillForm({ featureName = 'Checkout', storyName = 'Checkout story', tier }: { featureName?: string; storyName?: string; tier?: string } = {}) {
  fireEvent.change(await screen.findByLabelText('Feature name'), { target: { value: featureName } })
  fireEvent.change(screen.getByLabelText('Template'), { target: { value: 'tpl-1' } })
  if (tier) fireEvent.click(screen.getByRole('button', { name: tier, exact: true }))
  fireEvent.change(screen.getByLabelText('Story name'), { target: { value: storyName } })
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(api.get).mockResolvedValue({ data: TEMPLATES } as never)
  post.mockResolvedValue({ data: {} } as never)
  remove.mockResolvedValue({ data: {} } as never)
})

describe('AddFeatureFromTemplateModal', () => {
  it('blocks creation until the feature name, template and story name are supplied', async () => {
    renderModal()

    expect(createButton()).toBeDisabled()

    fireEvent.change(await screen.findByLabelText('Feature name'), { target: { value: 'Checkout' } })
    expect(createButton()).toBeDisabled()

    fireEvent.change(screen.getByLabelText('Template'), { target: { value: 'tpl-1' } })
    expect(createButton()).toBeDisabled()

    fireEvent.change(screen.getByLabelText('Story name'), { target: { value: 'Checkout story' } })
    expect(createButton()).toBeEnabled()

    fireEvent.change(screen.getByLabelText('Story name'), { target: { value: '   ' } })
    expect(createButton()).toBeDisabled()
  })

  it('creates the feature first, then applies the selected template at the chosen tier', async () => {
    const onSettled = renderModal()
    post
      .mockResolvedValueOnce({ data: { id: 'f-new' } } as never)
      .mockResolvedValueOnce({ data: {} } as never)

    await fillForm({ tier: 'L' })
    fireEvent.click(createButton())

    await waitFor(() => expect(post).toHaveBeenCalledTimes(2))
    expect(post.mock.calls[0]).toEqual(['/epics/e1/features', { name: 'Checkout' }])
    expect(post.mock.calls[1]).toEqual([
      '/features/f-new/apply-template',
      { templateId: 'tpl-1', complexity: 'LARGE', storyName: 'Checkout story' },
    ])

    await waitFor(() => expect(onSettled).toHaveBeenCalledWith('f-new'))
    expect(onSettled).toHaveBeenCalledTimes(1)
    expect(remove).not.toHaveBeenCalled()
  })

  it('prevents duplicate submission while creating', async () => {
    renderModal()
    let releaseCreate: (value: { data: { id: string } }) => void = () => {}
    post.mockImplementationOnce(() => new Promise(resolve => { releaseCreate = resolve }) as never)

    await fillForm()
    fireEvent.click(createButton())

    await waitFor(() => expect(screen.getByRole('button', { name: /creating/i })).toBeDisabled())
    expect(screen.getByLabelText('Feature name')).toBeDisabled()
    expect(screen.getByRole('button', { name: /^cancel$/i })).toBeDisabled()

    releaseCreate({ data: { id: 'f-new' } })
    await waitFor(() => expect(post).toHaveBeenCalledTimes(2))
  })

  it('removes the empty feature, reports the apply failure and never reports success', async () => {
    const onSettled = renderModal()
    post
      .mockResolvedValueOnce({ data: { id: 'f-new' } } as never)
      .mockRejectedValueOnce({ response: { data: { error: 'Template not found' } } })

    await fillForm()
    fireEvent.click(createButton())

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Template not found'))
    expect(remove).toHaveBeenCalledWith('/epics/e1/features/f-new')
    expect(onSettled).toHaveBeenCalledWith(null)
    expect(onSettled).not.toHaveBeenCalledWith('f-new')
    // Still open on the failure: the user sees the error rather than a silent close.
    expect(screen.getByRole('dialog', { name: 'Add feature from template' })).toBeVisible()
    expect(createButton()).toBeEnabled()
  })

  it('says so when the empty feature could not be removed', async () => {
    renderModal()
    post
      .mockResolvedValueOnce({ data: { id: 'f-new' } } as never)
      .mockRejectedValueOnce({ response: { data: { error: 'Template not found' } } })
    remove.mockRejectedValueOnce(new Error('offline'))

    await fillForm()
    fireEvent.click(createButton())

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Template not found'))
    expect(screen.getByRole('alert')).toHaveTextContent('The empty feature could not be removed.')
  })

  it('reports a failed feature create and never applies a template', async () => {
    const onSettled = renderModal()
    post.mockRejectedValueOnce({ response: { data: { error: 'name is required' } } })

    await fillForm()
    fireEvent.click(createButton())

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('name is required'))
    expect(post).toHaveBeenCalledTimes(1)
    expect(remove).not.toHaveBeenCalled()
    expect(onSettled).not.toHaveBeenCalled()
  })
})

describe('FeatureList template entry points', () => {
  const feature: Feature = {
    id: 'f-1',
    name: 'Existing feature',
    order: 0,
    epicId: 'e1',
    isActive: true,
    userStories: [],
  }

  function renderFeatureList() {
    render(
      <FeatureList epicId="e1" features={[feature]} resourceTypes={[]} projectId="p1" hoursPerDay={7.6} />,
      { wrapper },
    )
  }

  it('offers blank and template creation beside each other without disturbing the per-feature template action', async () => {
    renderFeatureList()

    expect(screen.getByRole('button', { name: '+ Add feature' })).toBeVisible()
    expect(screen.getByRole('button', { name: '+ Template' })).toBeVisible()

    fireEvent.click(screen.getByRole('button', { name: 'Add from template' }))
    const dialog = await screen.findByRole('dialog', { name: 'Add feature from template' })
    expect(dialog).toBeVisible()
    expect(screen.getByRole('button', { name: '+ Add feature' })).toBeVisible()

    fireEvent.click(screen.getByRole('button', { name: 'Close add feature from template' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Add feature from template' })).toBeNull())

    fireEvent.click(screen.getByRole('button', { name: '+ Add feature' }))
    expect(screen.getByPlaceholderText('Feature name *')).toBeVisible()
  })
})
