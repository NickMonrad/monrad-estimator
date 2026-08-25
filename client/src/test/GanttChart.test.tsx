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

function renderChart(options: { featureDependencies?: { featureId: string; dependsOnId: string }[] } = {}) {
  const onAddFeatureDep = vi.fn().mockResolvedValue({})
  const onDragFeature = vi.fn()
  render(
    <GanttChart
      entries={entries}
      featureDependencies={options.featureDependencies ?? []}
      storyDependencies={[]}
      epicDependencies={[]}
      totalWeeks={8}
      projectStartDate={null}
      onDragFeature={onDragFeature}
      onDragStory={vi.fn()}
      onAddFeatureDep={onAddFeatureDep}
      onAddStoryDep={vi.fn()}
      onRemoveFeatureDep={vi.fn()}
      onRemoveStoryDep={vi.fn()}
      editingFeatureId={null}
      setEditingFeatureId={vi.fn()}
      editingStoryId={null}
      setEditingStoryId={vi.fn()}
    />,
  )
  return { onAddFeatureDep, onDragFeature }
}

async function visibleHandles() {
  const rightOne = await screen.findByTestId('dependency-handle-right-feature-1')
  const leftOne = await screen.findByTestId('dependency-handle-left-feature-1')
  const rightTwo = await screen.findByTestId('dependency-handle-right-feature-2')
  const leftTwo = await screen.findByTestId('dependency-handle-left-feature-2')
  return { rightOne, leftOne, rightTwo, leftTwo }
}

async function dragTo(handle: HTMLElement, targetY: number) {
  fireEvent.mouseDown(handle, { clientX: 64, clientY: 110 })
  await waitFor(() => expect(screen.getByTestId('dependency-drag-preview')).toBeInTheDocument())
  fireEvent.mouseMove(window, { clientX: 128, clientY: targetY })
  fireEvent.mouseUp(window, { clientX: 128, clientY: targetY })
}

describe('Gantt feature dependency drag', () => {
  it('maps a right-handle drag from A to B to B depends on A and previews the target', async () => {
    const { onAddFeatureDep, onDragFeature } = renderChart()
    const { rightOne } = await visibleHandles()

    fireEvent.mouseDown(rightOne, { clientX: 64, clientY: 110 })
    await waitFor(() => expect(screen.getByTestId('dependency-drag-preview')).toBeInTheDocument())
    fireEvent.mouseMove(window, { clientX: 128, clientY: 150 })

    expect(screen.getByTestId('dependency-target-feature-2')).toBeInTheDocument()
    fireEvent.mouseUp(window, { clientX: 128, clientY: 150 })

    await waitFor(() => expect(onAddFeatureDep).toHaveBeenCalledWith('feature-2', 'feature-1'))
    expect(onDragFeature).not.toHaveBeenCalled()
    expect(screen.getByRole('status')).toHaveTextContent('Dependency created.')
  })

  it('maps a left-handle drag from B to A to B depends on A', async () => {
    const { onAddFeatureDep } = renderChart()
    const { leftTwo } = await visibleHandles()

    await dragTo(leftTwo, 114)

    await waitFor(() => expect(onAddFeatureDep).toHaveBeenCalledWith('feature-2', 'feature-1'))
  })

  it('blocks self-dependency without calling the API', async () => {
    const { onAddFeatureDep } = renderChart()
    const { rightOne } = await visibleHandles()

    await dragTo(rightOne, 114)

    expect(onAddFeatureDep).not.toHaveBeenCalled()
    expect(screen.getByRole('alert')).toHaveTextContent('A feature cannot depend on itself')
  })

  it('blocks an existing dependency without calling the API', async () => {
    const { onAddFeatureDep } = renderChart({
      featureDependencies: [{ featureId: 'feature-2', dependsOnId: 'feature-1' }],
    })
    const { rightOne } = await visibleHandles()

    await dragTo(rightOne, 150)

    expect(onAddFeatureDep).not.toHaveBeenCalled()
    expect(screen.getByRole('alert')).toHaveTextContent('That dependency already exists')
  })
})
