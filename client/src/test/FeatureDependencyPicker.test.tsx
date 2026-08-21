import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import React, { type ComponentProps } from 'react'
import FeatureDependencyPicker from '@/components/timeline/FeatureDependencyPicker'
import type { TimelineEntry } from '@/types/backlog'

function entry(overrides: Partial<TimelineEntry>): TimelineEntry {
  return {
    featureId: 'feature-default',
    featureName: 'Default Feature',
    epicId: 'epic-default',
    epicName: 'Default Epic',
    epicOrder: 1,
    featureOrder: 1,
    startWeek: 0,
    durationWeeks: 1,
    isManual: false,
    startDate: null,
    endDate: null,
    ...overrides,
  }
}

const candidates = [
  entry({ featureId: 'beta-2', featureName: 'Beta Second', epicId: 'epic-beta', epicName: 'Release Beta', epicOrder: 2, featureOrder: 2 }),
  entry({ featureId: 'alpha-2', featureName: 'Alpha Second', epicId: 'epic-alpha', epicName: 'Release Alpha', epicOrder: 1, featureOrder: 2 }),
  entry({ featureId: 'beta-1', featureName: 'Beta First', epicId: 'epic-beta', epicName: 'Release Beta', epicOrder: 2, featureOrder: 1 }),
  entry({ featureId: 'alpha-1', featureName: 'Alpha First', epicId: 'epic-alpha', epicName: 'Release Alpha', epicOrder: 1, featureOrder: 1 }),
]

function renderPicker(overrides: Partial<ComponentProps<typeof FeatureDependencyPicker>> = {}) {
  const onAddDependency = vi.fn()
  render(
    <FeatureDependencyPicker
      currentFeatureId="alpha-1"
      entries={candidates}
      featureDependencies={[]}
      onAddDependency={onAddDependency}
      {...overrides}
    />,
  )
  return { onAddDependency }
}

describe('FeatureDependencyPicker', () => {
  it('excludes the current feature and existing dependencies', () => {
    renderPicker({
      featureDependencies: [{ featureId: 'alpha-1', dependsOnId: 'alpha-2' }],
    })

    const trigger = screen.getByRole('button', { name: 'Add dependency' })
    expect(trigger).toBeEnabled()
    fireEvent.click(trigger)

    expect(screen.queryByText('Release Alpha / Alpha First')).not.toBeInTheDocument()
    expect(screen.queryByText('Release Alpha / Alpha Second')).not.toBeInTheDocument()
    expect(screen.getAllByRole('option').map(option => option.textContent)).toEqual([
      'Release Beta / Beta First',
      'Release Beta / Beta Second',
    ])
  })
  it('keeps features grouped when epics share an order', () => {
    const equalOrderEntries = [
      entry({ featureId: 'a-2', featureName: 'A2', epicId: 'epic-a', epicName: 'Epic A', epicOrder: 1, featureOrder: 2 }),
      entry({ featureId: 'b-1', featureName: 'B1', epicId: 'epic-b', epicName: 'Epic B', epicOrder: 1, featureOrder: 1 }),
      entry({ featureId: 'a-1', featureName: 'A1', epicId: 'epic-a', epicName: 'Epic A', epicOrder: 1, featureOrder: 1 }),
      entry({ featureId: 'b-2', featureName: 'B2', epicId: 'epic-b', epicName: 'Epic B', epicOrder: 1, featureOrder: 2 }),
    ]

    renderPicker({ currentFeatureId: 'selected-feature', entries: equalOrderEntries })
    fireEvent.click(screen.getByRole('button', { name: 'Add dependency' }))

    expect(screen.getAllByRole('option').map(option => option.textContent)).toEqual([
      'Epic A / A1',
      'Epic A / A2',
      'Epic B / B1',
      'Epic B / B2',
    ])
  })

  it('filters by feature, epic, and full path case-insensitively', () => {
    renderPicker()
    fireEvent.click(screen.getByRole('button', { name: 'Add dependency' }))
    const search = screen.getByRole('combobox', { name: 'Search dependencies' })

    fireEvent.change(search, { target: { value: 'SECOND' } })
    expect(screen.getAllByRole('option').map(option => option.textContent)).toEqual([
      'Release Alpha / Alpha Second',
      'Release Beta / Beta Second',
    ])

    fireEvent.change(search, { target: { value: 'release beta' } })
    expect(screen.getAllByRole('option').map(option => option.textContent)).toEqual([
      'Release Beta / Beta First',
      'Release Beta / Beta Second',
    ])

    fireEvent.change(search, { target: { value: 'no such feature' } })
    expect(screen.getByRole('status')).toHaveTextContent('No matching features')
  })

  it('focuses search on open and supports ArrowDown, ArrowUp, Enter, and Escape', () => {
    const { onAddDependency } = renderPicker()
    const trigger = screen.getByRole('button', { name: 'Add dependency' })
    fireEvent.click(trigger)
    const search = screen.getByRole('combobox', { name: 'Search dependencies' })
    expect(search).toHaveFocus()

    fireEvent.keyDown(search, { key: 'ArrowDown' })
    expect(screen.getAllByRole('option')[0]).toHaveAttribute('aria-selected', 'true')
    fireEvent.keyDown(search, { key: 'ArrowDown' })
    expect(screen.getAllByRole('option')[1]).toHaveAttribute('aria-selected', 'true')
    fireEvent.keyDown(search, { key: 'ArrowUp' })
    expect(screen.getAllByRole('option')[0]).toHaveAttribute('aria-selected', 'true')
    fireEvent.keyDown(search, { key: 'Enter' })

    expect(onAddDependency).toHaveBeenCalledWith('alpha-1', 'alpha-2')
    expect(screen.queryByRole('combobox', { name: 'Search dependencies' })).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()

    fireEvent.click(trigger)
    fireEvent.keyDown(screen.getByRole('combobox', { name: 'Search dependencies' }), { key: 'Escape' })
    expect(onAddDependency).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('combobox', { name: 'Search dependencies' })).not.toBeInTheDocument()
  })

  it('shows a disabled empty state and surfaces creation errors', () => {
    renderPicker({ entries: [candidates[3]], error: 'Dependency rejected' })

    expect(screen.getByRole('button', { name: 'Add dependency' })).toBeDisabled()
    expect(screen.getByText('No available dependencies')).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent('Dependency rejected')
  })
})
