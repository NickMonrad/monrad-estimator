import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  apiErrorMessage,
  createProjectDependency,
  createProjectRisk,
  deleteProjectDependency,
  deleteProjectRisk,
  getProjectDependencies,
  getProjectRisks,
  reorderProjectDependencies,
  reorderProjectRisks,
  updateProjectDependency,
  updateProjectRisk,
} from '../../lib/api'
import type { ProjectDependency, ProjectRisk } from '../../lib/api'
import RichTextEditor from '../shared/RichTextEditor'

interface ProjectContextPanelProps {
  projectId: string
}

type ContextItem = ProjectDependency | ProjectRisk

type ContextChanges = {
  description: string
  mitigation?: string | null
}

function hasText(value: string): boolean {
  return value.replace(/<[^>]*>/g, '').replace(/&nbsp;/gi, ' ').trim().length > 0
}

function ContextRow({
  item,
  index,
  count,
  isRisk,
  isPending,
  onSave,
  onDelete,
  onMove,
}: {
  item: ContextItem
  index: number
  count: number
  isRisk: boolean
  isPending: boolean
  onSave: (changes: ContextChanges) => void
  onDelete: () => void
  onMove: (direction: -1 | 1) => void
}) {
  const [description, setDescription] = useState(item.description)
  const [mitigation, setMitigation] = useState(isRisk && 'mitigation' in item ? item.mitigation ?? '' : '')

  return (
    <div className="border border-gray-200 dark:border-gray-700 rounded-lg p-3 space-y-2">
      <div className="flex items-start gap-2">
        <div className="flex-1 space-y-2">
          <RichTextEditor
            value={description}
            onChange={setDescription}
            ariaLabel={isRisk ? 'Risk description' : 'Dependency description'}
            placeholder={isRisk ? 'Describe the risk' : 'Describe the dependency'}
            className="text-sm"
          />
          {isRisk && (
            <RichTextEditor
              value={mitigation}
              onChange={setMitigation}
              ariaLabel="Risk mitigation or response"
              placeholder="Mitigation or response (optional)"
              className="text-sm"
            />
          )}
        </div>
        <div className="flex flex-col gap-1 shrink-0">
          <button
            type="button"
            onClick={() => onMove(-1)}
            disabled={index === 0 || isPending}
            aria-label={`Move ${isRisk ? 'risk' : 'dependency'} up`}
            className="px-2 py-1 text-xs border border-gray-200 dark:border-gray-600 rounded text-gray-600 dark:text-gray-300 disabled:opacity-30"
          >
            ↑
          </button>
          <button
            type="button"
            onClick={() => onMove(1)}
            disabled={index === count - 1 || isPending}
            aria-label={`Move ${isRisk ? 'risk' : 'dependency'} down`}
            className="px-2 py-1 text-xs border border-gray-200 dark:border-gray-600 rounded text-gray-600 dark:text-gray-300 disabled:opacity-30"
          >
            ↓
          </button>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => onSave(isRisk ? { description, mitigation: mitigation || null } : { description })}
          disabled={!hasText(description) || isPending}
          className="bg-lab3-navy text-white px-3 py-1.5 rounded text-xs font-medium hover:bg-lab3-blue disabled:opacity-40"
        >
          {isPending ? 'Saving…' : 'Save'}
        </button>
        <button
          type="button"
          onClick={onDelete}
          disabled={isPending}
          className="px-3 py-1.5 rounded text-xs text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 disabled:opacity-40"
        >
          Delete
        </button>
      </div>
    </div>
  )
}

export default function ProjectContextPanel({ projectId }: ProjectContextPanelProps) {
  const queryClient = useQueryClient()
  const [newDependency, setNewDependency] = useState('')
  const [newRisk, setNewRisk] = useState('')
  const [newMitigation, setNewMitigation] = useState('')
  const [error, setError] = useState<string | null>(null)

  const dependencyQuery = useQuery({
    queryKey: ['project-dependencies', projectId],
    queryFn: () => getProjectDependencies(projectId),
  })
  const riskQuery = useQuery({
    queryKey: ['project-risks', projectId],
    queryFn: () => getProjectRisks(projectId),
  })

  const refresh = (key: string[]) => queryClient.invalidateQueries({ queryKey: key })
  const reportError = (err: unknown) => setError(apiErrorMessage(err, 'Failed to save project context.'))

  const createDependency = useMutation({
    mutationFn: () => createProjectDependency(projectId, { description: newDependency }),
    onSuccess: () => { setNewDependency(''); setError(null); refresh(['project-dependencies', projectId]) },
    onError: reportError,
  })
  const createRisk = useMutation({
    mutationFn: () => createProjectRisk(projectId, { description: newRisk, mitigation: newMitigation || null }),
    onSuccess: () => { setNewRisk(''); setNewMitigation(''); setError(null); refresh(['project-risks', projectId]) },
    onError: reportError,
  })
  const updateDependency = useMutation({
    mutationFn: ({ id, changes }: { id: string; changes: ContextChanges }) => updateProjectDependency(projectId, id, { description: changes.description }),
    onSuccess: () => { setError(null); refresh(['project-dependencies', projectId]) },
    onError: reportError,
  })
  const updateRisk = useMutation({
    mutationFn: ({ id, changes }: { id: string; changes: ContextChanges }) => updateProjectRisk(projectId, id, changes),
    onSuccess: () => { setError(null); refresh(['project-risks', projectId]) },
    onError: reportError,
  })
  const deleteDependency = useMutation({
    mutationFn: (id: string) => deleteProjectDependency(projectId, id),
    onSuccess: () => { setError(null); refresh(['project-dependencies', projectId]) },
    onError: reportError,
  })
  const deleteRisk = useMutation({
    mutationFn: (id: string) => deleteProjectRisk(projectId, id),
    onSuccess: () => { setError(null); refresh(['project-risks', projectId]) },
    onError: reportError,
  })
  const reorderDependency = useMutation({
    mutationFn: (items: Array<{ id: string; order: number }>) => reorderProjectDependencies(projectId, items),
    onSuccess: () => { setError(null); refresh(['project-dependencies', projectId]) },
    onError: reportError,
  })
  const reorderRisk = useMutation({
    mutationFn: (items: Array<{ id: string; order: number }>) => reorderProjectRisks(projectId, items),
    onSuccess: () => { setError(null); refresh(['project-risks', projectId]) },
    onError: reportError,
  })

  const dependencyItems = dependencyQuery.data ?? []
  const riskItems = riskQuery.data ?? []
  const dependencyBusy = updateDependency.isPending || deleteDependency.isPending || reorderDependency.isPending
  const riskBusy = updateRisk.isPending || deleteRisk.isPending || reorderRisk.isPending

  function moveDependency(index: number, direction: -1 | 1) {
    const next = [...dependencyItems]
    const target = index + direction
    if (target < 0 || target >= next.length) return
    ;[next[index], next[target]] = [next[target], next[index]]
    reorderDependency.mutate(next.map((item, order) => ({ id: item.id, order })))
  }

  function moveRisk(index: number, direction: -1 | 1) {
    const next = [...riskItems]
    const target = index + direction
    if (target < 0 || target >= next.length) return
    ;[next[index], next[target]] = [next[target], next[index]]
    reorderRisk.mutate(next.map((item, order) => ({ id: item.id, order })))
  }

  const loading = dependencyQuery.isLoading || riskQuery.isLoading
  const queryError = dependencyQuery.error ?? riskQuery.error
  const displayError = error ?? (queryError ? apiErrorMessage(queryError, 'Failed to load project context.') : null)

  return (
    <section className="mt-6 bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-6 space-y-7" aria-labelledby="project-context-heading">
      <div>
        <h2 id="project-context-heading" className="text-lg font-semibold text-gray-900 dark:text-white">Project Context</h2>
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">Capture reusable project-level dependencies and risks for Scope Documents.</p>
      </div>

      {displayError && <div role="alert" className="p-3 rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-sm text-red-700 dark:text-red-300">{displayError}</div>}
      {loading && <p className="text-sm text-gray-500 dark:text-gray-400">Loading project context…</p>}

      <div className="space-y-3">
        <h3 className="font-medium text-gray-900 dark:text-white">Dependencies</h3>
        {!loading && dependencyItems.length === 0 && <p className="text-sm text-gray-500 dark:text-gray-400">No dependencies added.</p>}
        {dependencyItems.map((item, index) => (
          <ContextRow
            key={`${item.id}-${item.updatedAt}`}
            item={item}
            index={index}
            count={dependencyItems.length}
            isRisk={false}
            isPending={dependencyBusy}
            onSave={changes => updateDependency.mutate({ id: item.id, changes })}
            onDelete={() => deleteDependency.mutate(item.id)}
            onMove={direction => moveDependency(index, direction)}
          />
        ))}
        <div className="space-y-2">
          <RichTextEditor value={newDependency} onChange={setNewDependency} ariaLabel="New dependency description" placeholder="Add a dependency" className="text-sm" />
          <button
            type="button"
            onClick={() => createDependency.mutate()}
            disabled={!hasText(newDependency) || createDependency.isPending}
            className="bg-lab3-navy text-white px-3 py-1.5 rounded text-xs font-medium hover:bg-lab3-blue disabled:opacity-40"
          >
            {createDependency.isPending ? 'Adding…' : 'Add dependency'}
          </button>
        </div>
      </div>

      <div className="space-y-3">
        <h3 className="font-medium text-gray-900 dark:text-white">Risks</h3>
        {!loading && riskItems.length === 0 && <p className="text-sm text-gray-500 dark:text-gray-400">No risks added.</p>}
        {riskItems.map((item, index) => (
          <ContextRow
            key={`${item.id}-${item.updatedAt}`}
            item={item}
            index={index}
            count={riskItems.length}
            isRisk
            isPending={riskBusy}
            onSave={changes => updateRisk.mutate({ id: item.id, changes })}
            onDelete={() => deleteRisk.mutate(item.id)}
            onMove={direction => moveRisk(index, direction)}
          />
        ))}
        <div className="space-y-2">
          <RichTextEditor value={newRisk} onChange={setNewRisk} ariaLabel="New risk description" placeholder="Add a risk" className="text-sm" />
          <RichTextEditor value={newMitigation} onChange={setNewMitigation} ariaLabel="New risk mitigation or response" placeholder="Mitigation or response (optional)" className="text-sm" />
          <button
            type="button"
            onClick={() => createRisk.mutate()}
            disabled={!hasText(newRisk) || createRisk.isPending}
            className="bg-lab3-navy text-white px-3 py-1.5 rounded text-xs font-medium hover:bg-lab3-blue disabled:opacity-40"
          >
            {createRisk.isPending ? 'Adding…' : 'Add risk'}
          </button>
        </div>
      </div>
    </section>
  )
}
