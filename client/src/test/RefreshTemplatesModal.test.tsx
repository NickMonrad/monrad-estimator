import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import RefreshTemplatesModal, { type TemplateRefreshTarget } from '@/components/backlog/RefreshTemplatesModal'
import StoryList from '@/components/backlog/StoryList'
import { api } from '../lib/api'
import type { UserStory } from '@/types/backlog'

vi.mock('../lib/api', () => ({
  api: {
    get: vi.fn().mockResolvedValue({ data: {} }),
    post: vi.fn().mockResolvedValue({ data: {} }),
    put: vi.fn().mockResolvedValue({ data: {} }),
    delete: vi.fn().mockResolvedValue({ data: {} }),
  },
  duplicateBacklogItem: vi.fn().mockResolvedValue({ type: 'story', id: 's-copy', name: 'Copy', parentId: 'f-1' }),
  apiErrorMessage: (error: { response?: { data?: { error?: string } } }, fallback: string) =>
    error.response?.data?.error ?? fallback,
}))

const post = vi.mocked(api.post)

function target(overrides: Partial<TemplateRefreshTarget>): TemplateRefreshTarget {
  return {
    featureId: 'f-1',
    storyId: 's-1',
    storyName: 'Story',
    featureName: 'Feature',
    epicName: 'Epic',
    complexity: null,
    ...overrides,
  }
}

function finishButton() {
  return screen.getByRole('button', { name: /^refresh \d+ stor(y|ies)$/i })
}

beforeEach(() => {
  vi.clearAllMocks()
  post.mockResolvedValue({ data: {} } as never)
})

describe('RefreshTemplatesModal', () => {
  it('uses each story recorded complexity, keeping mixed sizes mixed', async () => {
    const onCompleted = vi.fn()
    render(
      <RefreshTemplatesModal
        targets={[
          target({ storyId: 's-xs', storyName: 'Tiny story', featureId: 'f-1', complexity: 'EXTRA_SMALL' }),
          target({ storyId: 's-l', storyName: 'Big story', featureId: 'f-2', complexity: 'LARGE' }),
        ]}
        onClose={vi.fn()}
        onCompleted={onCompleted}
      />,
    )

    fireEvent.click(finishButton())

    await waitFor(() => expect(post).toHaveBeenCalledTimes(2))
    expect(post.mock.calls[0]).toEqual(['/features/f-1/refresh-template/s-xs', { complexity: 'EXTRA_SMALL' }])
    expect(post.mock.calls[1]).toEqual(['/features/f-2/refresh-template/s-l', { complexity: 'LARGE' }])
    expect(await screen.findByText(/refreshed 2 of 2 stories/i)).toBeInTheDocument()
    expect(onCompleted).toHaveBeenCalledTimes(1)
  })

  it('requires an explicit complexity for a legacy story before refreshing', async () => {
    render(
      <RefreshTemplatesModal
        targets={[
          target({ storyId: 's-known', storyName: 'Known story', complexity: 'SMALL' }),
          target({ storyId: 's-legacy', storyName: 'Legacy story', complexity: null }),
        ]}
        onClose={vi.fn()}
        onCompleted={vi.fn()}
      />,
    )

    expect(finishButton()).toBeDisabled()
    expect(screen.getByText(/1 template-backed story has no recorded complexity/i)).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('Complexity for Legacy story'), { target: { value: 'EXTRA_LARGE' } })

    expect(finishButton()).toBeEnabled()
    fireEvent.click(finishButton())

    await waitFor(() => expect(post).toHaveBeenCalledTimes(2))
    expect(post.mock.calls[0]).toEqual(['/features/f-1/refresh-template/s-known', { complexity: 'SMALL' }])
    expect(post.mock.calls[1]).toEqual(['/features/f-1/refresh-template/s-legacy', { complexity: 'EXTRA_LARGE' }])
  })

  it('prevents duplicate submission while the batch is running', async () => {
    const pendingPost = Promise.withResolvers<unknown>()
    post.mockImplementation(() => pendingPost.promise)

    render(
      <RefreshTemplatesModal
        targets={[target({ storyId: 's-1', complexity: 'MEDIUM' })]}
        onClose={vi.fn()}
        onCompleted={vi.fn()}
      />,
    )

    fireEvent.click(finishButton())
    await waitFor(() => expect(screen.getByRole('button', { name: /refreshing…/i })).toBeDisabled())

    fireEvent.click(screen.getByRole('button', { name: /refreshing…/i }))
    expect(post).toHaveBeenCalledTimes(1)

    pendingPost.resolve({ data: {} })
    await waitFor(() => expect(finishButton()).toBeEnabled())
    expect(post).toHaveBeenCalledTimes(1)
  })

  it('keeps going after a failure and reports the partial result', async () => {
    post
      .mockRejectedValueOnce({ response: { data: { error: 'Story not found' } } })
      .mockResolvedValueOnce({ data: {} } as never)

    render(
      <RefreshTemplatesModal
        targets={[
          target({ storyId: 's-fail', storyName: 'Broken story', complexity: 'SMALL' }),
          target({ storyId: 's-ok', storyName: 'Working story', complexity: 'LARGE' }),
        ]}
        onClose={vi.fn()}
        onCompleted={vi.fn()}
      />,
    )

    fireEvent.click(finishButton())

    await waitFor(() => expect(post).toHaveBeenCalledTimes(2))
    expect(await screen.findByText(/refreshed 1 of 2 stories/i)).toBeInTheDocument()
    expect(screen.getByText(/broken story — story not found/i)).toBeInTheDocument()
    expect(screen.queryByText(/refreshed 2 of 2 stories/i)).not.toBeInTheDocument()
  })
})

describe('StoryList per-story refresh', () => {
  const story: UserStory = {
    id: 's-1',
    name: 'Templated story',
    order: 0,
    featureId: 'f-1',
    appliedTemplateId: 'tpl-1',
    appliedTemplateComplexity: 'SMALL',
    isActive: true,
    tasks: [],
  }

  function wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>
  }

  it('still refreshes a single story from its own control', async () => {
    render(
      <StoryList featureId="f-1" stories={[story]} resourceTypes={[]} projectId="proj-1" hoursPerDay={7.6} />,
      { wrapper },
    )

    fireEvent.click(screen.getByTitle('Refresh tasks from template'))
    fireEvent.click(screen.getByRole('button', { name: 'L' }))

    await waitFor(() =>
      expect(post).toHaveBeenCalledWith('/features/f-1/refresh-template/s-1', { complexity: 'LARGE' }),
    )
  })
})
