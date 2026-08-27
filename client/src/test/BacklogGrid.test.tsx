import React from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import BacklogGrid from '../components/backlog/BacklogGrid'
import type { Epic, ResourceType } from '../types/backlog'
import { api } from '../lib/api'

vi.mock('../lib/api', () => ({
  api: { post: vi.fn() },
  apiErrorMessage: vi.fn(() => 'Grid commit failed; no changes were saved'),
}))

vi.mock('../components/shared/RichTextEditor', () => ({ default: ({ value, onChange }: { value: string; onChange: (value: string) => void }) => <textarea aria-label="Rich text" value={value} onChange={event => onChange(event.target.value)} /> }))

const resourceTypes: ResourceType[] = [{ id: 'rt-dev', name: 'Developer', category: 'ENGINEERING', count: 1, projectId: 'p1' }]
const epics: Epic[] = [{ id: 'e1', name: 'Existing Epic', order: 0, projectId: 'p1', isActive: true, features: [] }]

beforeEach(() => vi.clearAllMocks())

describe('BacklogGrid', () => {
  it('loads existing rows and opens the rich text editor without changing content', () => {
    render(<BacklogGrid projectId="p1" epics={epics} resourceTypes={resourceTypes} onCommitted={vi.fn()} onExit={vi.fn()} />)
    expect(screen.getByDisplayValue('Existing Epic')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Add description' }))
    expect(screen.getByRole('dialog')).toBeVisible()
    expect(screen.getByRole('textbox', { name: 'Rich text' })).toHaveValue('')
  })

  it('supports keyboard row creation and TSV paste with validation feedback', () => {
    render(<BacklogGrid projectId="p1" epics={[]} resourceTypes={resourceTypes} onCommitted={vi.fn()} onExit={vi.fn()} />)
    fireEvent.change(screen.getByLabelText('New row type'), { target: { value: 'task' } })
    fireEvent.click(screen.getByRole('button', { name: '+ Add row' }))
    const epic = screen.getByLabelText('Row 1 epicName')
    fireEvent.paste(epic, { clipboardData: { getData: () => 'Epic\tFeature\tStory\tTask\tactive\tTypo\t-1' } })
    expect(screen.getByLabelText('Row 1 name')).toHaveValue('Task')
    fireEvent.click(screen.getByRole('button', { name: 'Save Grid Entry' }))
    expect(screen.getByText(/Hours must be a non-negative number/)).toBeVisible()
    expect(screen.getByText(/Select one existing project resource type/)).toBeVisible()
  })
  it('moves with arrows without overriding text cursor movement', () => {
    render(<BacklogGrid projectId="p1" epics={[]} resourceTypes={resourceTypes} onCommitted={vi.fn()} onExit={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: '+ Add row' }))
    fireEvent.click(screen.getByRole('button', { name: '+ Add row' }))
    const firstName = screen.getByLabelText('Row 1 name')
    const secondName = screen.getByLabelText('Row 2 name')
    firstName.focus()
    fireEvent.keyDown(firstName, { key: 'ArrowDown' })
    expect(secondName).toHaveFocus()
    secondName.focus()
    fireEvent.keyDown(secondName, { key: 'ArrowRight' })
    expect(screen.getByLabelText('Row 2 active')).toHaveFocus()
  })
  it('skips disabled Task Active cell during horizontal navigation', () => {
    render(<BacklogGrid projectId="p1" epics={[]} resourceTypes={resourceTypes} onCommitted={vi.fn()} onExit={vi.fn()} />)
    fireEvent.change(screen.getByLabelText('New row type'), { target: { value: 'task' } })
    fireEvent.click(screen.getByRole('button', { name: '+ Add row' }))
    const name = screen.getByLabelText('Row 1 name')
    const resourceType = screen.getByLabelText('Row 1 resource type')
    name.focus()
    fireEvent.keyDown(name, { key: 'ArrowRight' })
    expect(resourceType).toHaveFocus()
    fireEvent.keyDown(resourceType, { key: 'ArrowLeft' })
    expect(name).toHaveFocus()
  })

  it('uses persisted row identities for a second same-session save', async () => {
    vi.mocked(api.post)
      .mockResolvedValueOnce({ data: { message: 'Grid entry committed', rowIds: ['epic-1'] } } as never)
      .mockResolvedValueOnce({ data: { message: 'Grid entry committed', rowIds: ['epic-1'] } } as never)
    render(<BacklogGrid projectId="p1" epics={[]} resourceTypes={resourceTypes} onCommitted={vi.fn()} onExit={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: '+ Add row' }))
    fireEvent.change(screen.getByLabelText('Row 1 name'), { target: { value: 'New Epic' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save Grid Entry' }))
    await waitFor(() => expect(screen.getByText('Saved')).toBeVisible())
    fireEvent.change(screen.getByLabelText('Row 1 name'), { target: { value: 'Renamed Epic' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save Grid Entry' }))
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(2))
    expect(vi.mocked(api.post).mock.calls[1][0]).toBe('/projects/p1/backlog/grid-commit')
    expect(vi.mocked(api.post).mock.calls[1][1]).toEqual(expect.objectContaining({ rows: [expect.objectContaining({ id: 'epic-1', name: 'Renamed Epic' })] }))
  })



  it('commits valid rows explicitly and reports success', async () => {
    vi.mocked(api.post).mockResolvedValue({ data: { message: 'Grid entry committed' } } as never)
    const onCommitted = vi.fn()
    render(<BacklogGrid projectId="p1" epics={[]} resourceTypes={resourceTypes} onCommitted={onCommitted} onExit={vi.fn()} />)
    fireEvent.change(screen.getByLabelText('New row type'), { target: { value: 'epic' } })
    fireEvent.click(screen.getByRole('button', { name: '+ Add row' }))
    fireEvent.change(screen.getByLabelText('Row 1 name'), { target: { value: 'New Epic' } })
    fireEvent.keyDown(screen.getByLabelText('Row 1 name'), { key: 'Enter' })
    fireEvent.click(screen.getByRole('button', { name: 'Save Grid Entry' }))
    await waitFor(() => expect(screen.getByText('Saved')).toBeVisible())
    expect(api.post).toHaveBeenCalledWith('/projects/p1/backlog/grid-commit', expect.objectContaining({ rows: expect.any(Array) }))
    expect(onCommitted).toHaveBeenCalledTimes(1)
  })
})
