import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import TaskList from '@/components/backlog/TaskList'
import type { Task, ResourceType } from '@/types/backlog'

vi.mock('../../lib/api', () => ({
  api: {
    post: vi.fn().mockResolvedValue({ data: {} }),
    put: vi.fn().mockResolvedValue({ data: {} }),
    delete: vi.fn().mockResolvedValue({ data: {} }),
  },
}))

const resourceTypes: ResourceType[] = [
  { id: 'rt-1', name: 'Developer', category: 'ENGINEERING', projectId: 'proj-1' },
]

const tasks: Task[] = [
  { id: 't-1', name: 'Implement login', hoursEffort: 4, order: 0, userStoryId: 's-1', resourceTypeId: 'rt-1', resourceType: resourceTypes[0] },
]

function wrapper({ children }: { children: React.ReactNode }) {
  return <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>
}

describe('TaskList', () => {
  it('renders task name and hours', () => {
    render(<TaskList storyId="s-1" tasks={tasks} resourceTypes={resourceTypes} projectId="proj-1" />, { wrapper })
    expect(screen.getByText('Implement login')).toBeInTheDocument()
    expect(screen.getByText(/4h/)).toBeInTheDocument()
    expect(screen.getByText('Developer')).toBeInTheDocument()
  })

  it('shows add task button', () => {
    render(<TaskList storyId="s-1" tasks={[]} resourceTypes={resourceTypes} projectId="proj-1" />, { wrapper })
    expect(screen.getByText('+ Add task')).toBeInTheDocument()
  })

  it('shows task form when add task clicked', () => {
    render(<TaskList storyId="s-1" tasks={[]} resourceTypes={resourceTypes} projectId="proj-1" />, { wrapper })
    fireEvent.click(screen.getByText('+ Add task'))
    expect(screen.getByPlaceholderText('Task name *')).toBeInTheDocument()
  })

  it('shows hours in days too', () => {
    render(<TaskList storyId="s-1" tasks={tasks} resourceTypes={resourceTypes} projectId="proj-1" />, { wrapper })
    expect(screen.getByText(/0\.5d/)).toBeInTheDocument()
  })
})
