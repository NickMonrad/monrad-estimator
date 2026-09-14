import React from 'react'
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import GanttChart from '@/components/timeline/GanttChart'
import type { TimelineEntry } from '@/types/backlog'

vi.mock('@/hooks/useIsDark', () => ({ useIsDark: () => false }))
vi.mock('@/components/timeline/TimelineTooltip', () => ({ default: () => null }))

function entry(featureId: string, featureName: string, featureOrder: number): TimelineEntry {
  return {
    featureId,
    featureName,
    epicId: 'epic-1',
    epicName: 'Epic One',
    epicOrder: 1,
    featureOrder,
    startWeek: featureOrder - 1,
    durationWeeks: 1,
    isManual: false,
    startDate: null,
    endDate: null,
  }
}

const entries = [
  entry('feature-1', 'Feature One', 1),
  entry('feature-2', 'Feature Two', 2),
]

type FeatureDep = { featureId: string; dependsOnId: string }

function chartElement(options: {
  featureDependencies?: FeatureDep[]
  onAddFeatureDep?: (featureId: string, dependsOnId: string) => void | Promise<unknown>
  onDragFeature?: (featureId: string, newStartWeek: number) => void
  onRemoveFeatureDep?: (featureId: string, dependsOnId: string) => void | Promise<unknown>
}) {
  return (
    <GanttChart
      entries={entries}
      featureDependencies={options.featureDependencies ?? []}
      storyDependencies={[]}
      epicDependencies={[]}
      totalWeeks={8}
      projectStartDate={null}
      onDragFeature={options.onDragFeature ?? vi.fn()}
      onDragStory={vi.fn()}
      onAddFeatureDep={options.onAddFeatureDep ?? vi.fn()}
      onAddStoryDep={vi.fn()}
      onRemoveFeatureDep={options.onRemoveFeatureDep ?? vi.fn()}
      onRemoveStoryDep={vi.fn()}
      editingFeatureId={null}
      setEditingFeatureId={vi.fn()}
      editingStoryId={null}
      setEditingStoryId={vi.fn()}
    />
  )
}

function renderChart(options: {
  featureDependencies?: FeatureDep[]
  onRemoveFeatureDep?: (featureId: string, dependsOnId: string) => void | Promise<unknown>
} = {}) {
  const onAddFeatureDep = vi.fn().mockResolvedValue({})
  const onDragFeature = vi.fn()
  const onRemoveFeatureDep = options.onRemoveFeatureDep ?? vi.fn().mockResolvedValue(undefined)
  const view = render(chartElement({ ...options, onAddFeatureDep, onDragFeature, onRemoveFeatureDep }))
  return { onAddFeatureDep, onDragFeature, onRemoveFeatureDep, rerender: view.rerender }
}

async function visibleHandles() {
  const rightOne = await screen.findByTestId('dependency-handle-right-feature-1')
  const leftOne = await screen.findByTestId('dependency-handle-left-feature-1')
  const rightTwo = await screen.findByTestId('dependency-handle-right-feature-2')
  const leftTwo = await screen.findByTestId('dependency-handle-left-feature-2')
  return { rightOne, leftOne, rightTwo, leftTwo }
}

async function dragTo(handle: HTMLElement, targetX: number, targetY: number) {
  fireEvent.mouseDown(handle, { clientX: 64, clientY: 110 })
  await waitFor(() => expect(screen.getByTestId('dependency-drag-preview')).toBeInTheDocument())
  fireEvent.mouseMove(window, { clientX: targetX, clientY: targetY })
  fireEvent.mouseUp(window, { clientX: targetX, clientY: targetY })
}

describe('Gantt feature dependency drag', () => {
  it('maps a right-handle drag from A to B to B depends on A and previews the target', async () => {
    const { onAddFeatureDep, onDragFeature } = renderChart()
    const { rightOne } = await visibleHandles()

    fireEvent.mouseDown(rightOne, { clientX: 64, clientY: 110 })
    await waitFor(() => expect(screen.getByTestId('dependency-drag-preview')).toBeInTheDocument())
    fireEvent.mouseMove(window, { clientX: 96, clientY: 150 })

    expect(screen.getByTestId('dependency-target-feature-2')).toBeInTheDocument()
    fireEvent.mouseUp(window, { clientX: 96, clientY: 150 })

    await waitFor(() => expect(onAddFeatureDep).toHaveBeenCalledWith('feature-2', 'feature-1'))
    expect(onDragFeature).not.toHaveBeenCalled()
    expect(screen.getByRole('status')).toHaveTextContent('Dependency created.')
  })

  it('maps a left-handle drag from B to A to B depends on A', async () => {
    const { onAddFeatureDep } = renderChart()
    const { leftTwo } = await visibleHandles()

    await dragTo(leftTwo, 32, 114)

    await waitFor(() => expect(onAddFeatureDep).toHaveBeenCalledWith('feature-2', 'feature-1'))
  })

  it('rejects a release outside a feature target even when the row aligns', async () => {
    const { onAddFeatureDep } = renderChart()
    const { rightOne } = await visibleHandles()

    fireEvent.mouseDown(rightOne, { clientX: 64, clientY: 110 })
    await waitFor(() => expect(screen.getByTestId('dependency-drag-preview')).toBeInTheDocument())
    fireEvent.mouseMove(window, { clientX: 200, clientY: 150 })
    fireEvent.mouseUp(window, { clientX: 200, clientY: 150 })

    expect(onAddFeatureDep).not.toHaveBeenCalled()
    expect(screen.getByRole('alert')).toHaveTextContent('Drop on another feature to create a dependency.')
  })

  it('blocks self-dependency without calling the API', async () => {
    const { onAddFeatureDep } = renderChart()
    const { rightOne } = await visibleHandles()

    await dragTo(rightOne, 32, 114)

    expect(onAddFeatureDep).not.toHaveBeenCalled()
    expect(screen.getByRole('alert')).toHaveTextContent('A feature cannot depend on itself')
  })

  it('blocks an existing dependency without calling the API', async () => {
    const { onAddFeatureDep } = renderChart({
      featureDependencies: [{ featureId: 'feature-2', dependsOnId: 'feature-1' }],
    })
    const { rightOne } = await visibleHandles()

    await dragTo(rightOne, 96, 150)

    expect(onAddFeatureDep).not.toHaveBeenCalled()
    expect(screen.getByRole('alert')).toHaveTextContent('That dependency already exists')
  })
})

describe('Gantt feature dependency removal', () => {
  // Feature Two depends on Feature One, plus the reverse edge so removal has to
  // prove it targets one specific relationship.
  const twoDependsOnOne: FeatureDep = { featureId: 'feature-2', dependsOnId: 'feature-1' }
  const oneDependsOnTwo: FeatureDep = { featureId: 'feature-1', dependsOnId: 'feature-2' }

  function connector(name: string) {
    return screen.getByRole('button', { name })
  }

  function removeControls() {
    return screen.queryAllByRole('button', { name: /^remove dependency/i })
  }

  it('offers a remove control only for the selected connector', () => {
    renderChart({ featureDependencies: [twoDependsOnOne, oneDependsOnTwo] })

    expect(removeControls()).toHaveLength(0)

    fireEvent.click(connector('Dependency Feature One → Feature Two'))

    expect(removeControls()).toHaveLength(1)
    expect(connector('Remove dependency Feature One → Feature Two')).toBeInTheDocument()
  })

  it('removes only the selected relationship', async () => {
    const { onRemoveFeatureDep } = renderChart({
      featureDependencies: [twoDependsOnOne, oneDependsOnTwo],
    })

    fireEvent.click(connector('Dependency Feature One → Feature Two'))
    fireEvent.click(connector('Remove dependency Feature One → Feature Two'))

    await waitFor(() => expect(onRemoveFeatureDep).toHaveBeenCalledWith('feature-2', 'feature-1'))
    expect(onRemoveFeatureDep).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('dependency-arrow-feature-2-feature-1')).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('Dependency removed.')
  })

  it('is operable from the keyboard', async () => {
    const { onRemoveFeatureDep } = renderChart({ featureDependencies: [twoDependsOnOne] })

    const target = connector('Dependency Feature One → Feature Two')
    target.focus()
    fireEvent.keyDown(target, { key: 'Enter' })

    const remove = connector('Remove dependency Feature One → Feature Two')
    remove.focus()
    fireEvent.keyDown(remove, { key: ' ' })

    await waitFor(() => expect(onRemoveFeatureDep).toHaveBeenCalledWith('feature-2', 'feature-1'))
  })

  it('drops the selection when refreshed data no longer contains the dependency', () => {
    const { onRemoveFeatureDep, rerender } = renderChart({ featureDependencies: [twoDependsOnOne] })

    fireEvent.click(connector('Dependency Feature One → Feature Two'))
    expect(removeControls()).toHaveLength(1)

    rerender(chartElement({ featureDependencies: [], onRemoveFeatureDep }))

    expect(removeControls()).toHaveLength(0)
  })

  it('clears the selection with Escape', () => {
    renderChart({ featureDependencies: [twoDependsOnOne] })

    const target = connector('Dependency Feature One → Feature Two')
    fireEvent.click(target)
    expect(removeControls()).toHaveLength(1)

    fireEvent.keyDown(target, { key: 'Escape' })

    expect(removeControls()).toHaveLength(0)
  })

  it('surfaces a failed removal', async () => {
    const onRemoveFeatureDep = vi.fn().mockRejectedValue(new Error('offline'))
    renderChart({ featureDependencies: [twoDependsOnOne], onRemoveFeatureDep })

    fireEvent.click(connector('Dependency Feature One → Feature Two'))
    fireEvent.click(connector('Remove dependency Feature One → Feature Two'))

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Failed to remove dependency.'))
  })
})
