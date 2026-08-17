import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import TaskList from '@/components/backlog/TaskList'
import { duplicateBacklogItem } from '../lib/api'
import type { Task, ResourceType } from '@/types/backlog'
vi.mock('../lib/api', () => ({
  api: {
    post: vi.fn().mockResolvedValue({ data: {} }),
    put: vi.fn().mockResolvedValue({ data: {} }),
    delete: vi.fn().mockResolvedValue({ data: {} }),
  },
  duplicateBacklogItem: vi.fn().mockResolvedValue({ type: 'task', id: 't-2', name: 'Copy of Implement login', parentId: 's-1' }),
  apiErrorMessage: vi.fn((error: { response?: { data?: { error?: string } } }, fallback: string) => error.response?.data?.error ?? fallback),
}))

const resourceTypes: ResourceType[] = [
  { id: 'rt-1', name: 'Developer', category: 'ENGINEERING', count: 1, projectId: 'proj-1' },
]

const tasks: Task[] = [
  { id: 't-1', name: 'Implement login', hoursEffort: 4, order: 0, userStoryId: 's-1', resourceTypeId: 'rt-1', resourceType: resourceTypes[0] },
]

function wrapper({ children }: { children: React.ReactNode }) {
  return <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>
}

describe('TaskList', () => {
  it('renders task name and hours', () => {
    render(<TaskList storyId="s-1" tasks={tasks} resourceTypes={resourceTypes} projectId="proj-1" hoursPerDay={7.6} />, { wrapper })
    expect(screen.getByText('Implement login')).toBeInTheDocument()
    expect(screen.getByText(/4h/)).toBeInTheDocument()
    expect(screen.getByText('Developer')).toBeInTheDocument()
  })

  it('shows add task button', () => {
    render(<TaskList storyId="s-1" tasks={[]} resourceTypes={resourceTypes} projectId="proj-1" hoursPerDay={7.6} />, { wrapper })
    expect(screen.getByText('+ Add task')).toBeInTheDocument()
  })

  it('shows task form when add task clicked', () => {
    render(<TaskList storyId="s-1" tasks={[]} resourceTypes={resourceTypes} projectId="proj-1" hoursPerDay={7.6} />, { wrapper })
    fireEvent.click(screen.getByText('+ Add task'))
    expect(screen.getByPlaceholderText('Task name *')).toBeInTheDocument()
  })

  it('shows hours in days too', () => {
    render(<TaskList storyId="s-1" tasks={tasks} resourceTypes={resourceTypes} projectId="proj-1" hoursPerDay={7.6} />, { wrapper })
    expect(screen.getByText(/0\.5d/)).toBeInTheDocument()
  })
})

describe('TaskList — durationDays validation', () => {
  it('shows error when saving with duration override of 0', () => {
    render(<TaskList storyId="s-1" tasks={[]} resourceTypes={resourceTypes} projectId="proj-1" hoursPerDay={7.6} />, { wrapper })
    fireEvent.click(screen.getByText('+ Add task'))
    fireEvent.change(screen.getByPlaceholderText('Task name *'), { target: { value: 'Test task' } })
    const rtSelect = screen.getByRole('combobox')
    fireEvent.change(rtSelect, { target: { value: 'rt-1' } })
    const overrideInput = screen.getByPlaceholderText('Leave blank to use hours/day rate')
    fireEvent.change(overrideInput, { target: { value: '0' } })
    fireEvent.click(screen.getByText('Save'))
    expect(screen.getByText('Duration must be at least 1 day')).toBeInTheDocument()
  })

  it('shows error when saving with negative duration override', () => {
    render(<TaskList storyId="s-1" tasks={[]} resourceTypes={resourceTypes} projectId="proj-1" hoursPerDay={7.6} />, { wrapper })
    fireEvent.click(screen.getByText('+ Add task'))
    fireEvent.change(screen.getByPlaceholderText('Task name *'), { target: { value: 'Test task' } })
    const rtSelect = screen.getByRole('combobox')
    fireEvent.change(rtSelect, { target: { value: 'rt-1' } })
    const overrideInput = screen.getByPlaceholderText('Leave blank to use hours/day rate')
    fireEvent.change(overrideInput, { target: { value: '-1' } })
    fireEvent.click(screen.getByText('Save'))
    expect(screen.getByText('Duration must be at least 1 day')).toBeInTheDocument()
  })

  it('clears error when duration override is changed after failed validation', () => {
    render(<TaskList storyId="s-1" tasks={[]} resourceTypes={resourceTypes} projectId="proj-1" hoursPerDay={7.6} />, { wrapper })
    fireEvent.click(screen.getByText('+ Add task'))
    const rtSelect = screen.getByRole('combobox')
    fireEvent.change(rtSelect, { target: { value: 'rt-1' } })
    fireEvent.change(screen.getByPlaceholderText('Task name *'), { target: { value: 'Test task' } })
    const overrideInput = screen.getByPlaceholderText('Leave blank to use hours/day rate')
    fireEvent.change(overrideInput, { target: { value: '0' } })
    fireEvent.click(screen.getByText('Save'))
    expect(screen.getByText('Duration must be at least 1 day')).toBeInTheDocument()
    // Change duration to a valid value — error should clear
    fireEvent.change(overrideInput, { target: { value: '3' } })
    expect(screen.queryByText('Duration must be at least 1 day')).not.toBeInTheDocument()
  })

  it('saves successfully with valid positive duration override', () => {
    render(<TaskList storyId="s-1" tasks={[]} resourceTypes={resourceTypes} projectId="proj-1" hoursPerDay={7.6} />, { wrapper })
    fireEvent.click(screen.getByText('+ Add task'))
    const rtSelect = screen.getByRole('combobox')
    fireEvent.change(rtSelect, { target: { value: 'rt-1' } })
    fireEvent.change(screen.getByPlaceholderText('Task name *'), { target: { value: 'Test task' } })
    const overrideInput = screen.getByPlaceholderText('Leave blank to use hours/day rate')
    fireEvent.change(overrideInput, { target: { value: '3' } })
    fireEvent.click(screen.getByText('Save'))
    expect(screen.queryByText('Duration must be at least 1 day')).not.toBeInTheDocument()
  })
})

describe('TaskList — duplication', () => {
  it('shows Duplicate and calls the project-scoped task duplication endpoint', async () => {
    render(<TaskList storyId="s-1" tasks={[{ ...tasks[0], durationDays: 2 }]} resourceTypes={resourceTypes} projectId="proj-1" hoursPerDay={7.6} />, { wrapper })

    fireEvent.click(screen.getByRole('button', { name: 'Duplicate' }))

    await waitFor(() => expect(duplicateBacklogItem).toHaveBeenCalledWith('proj-1', 'task', 't-1'))
  })

  it('shows duplication failure feedback', async () => {
    vi.mocked(duplicateBacklogItem).mockRejectedValueOnce({ response: { data: { error: 'Resource assignment is invalid' } } })
    render(<TaskList storyId="s-1" tasks={tasks} resourceTypes={resourceTypes} projectId="proj-1" hoursPerDay={7.6} />, { wrapper })

    fireEvent.click(screen.getByRole('button', { name: 'Duplicate' }))

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Resource assignment is invalid'))
  })
})
