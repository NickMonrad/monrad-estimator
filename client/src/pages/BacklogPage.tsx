import { useState, useEffect } from 'react'
import DOMPurify from 'dompurify'
import { useParams, useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  DndContext, DragOverlay, closestCorners, PointerSensor, useSensor, useSensors,
  type DragStartEvent, type DragOverEvent, type DragEndEvent,
} from '@dnd-kit/core'
import { SortableContext, useSortable, verticalListSortingStrategy, arrayMove } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { api } from '../lib/api'
import AppLayout from '../components/layout/AppLayout'
import { useReorderEpics, useReorderFeatures, useReorderStories, useReorderTasks } from '../hooks/useReorder'
import type { Epic, Feature, UserStory, Task, ResourceType, Project } from '../types/backlog'
import FeatureList from '../components/backlog/FeatureList'
import CsvImportModal from '../components/backlog/CsvImportModal'
import { getEpicColour, type EpicColour } from '../lib/epicColours'
import RichTextEditor from '../components/shared/RichTextEditor'

export default function BacklogPage() {
  const { id: projectId } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const qc = useQueryClient()

  const [expandedEpics, setExpandedEpics] = useState<Set<string>>(new Set())
  const [addingEpic, setAddingEpic] = useState(false)
  const [editingEpicId, setEditingEpicId] = useState<string | null>(null)
  const [epicForm, setEpicForm] = useState({ name: '', description: '', assumptions: '' })
  const [showHistory, setShowHistory] = useState(false)
  const [showCsvImport, setShowCsvImport] = useState(false)
  const [snapshotLabel, setSnapshotLabel] = useState('')
  const [diffId, setDiffId] = useState<string | null>(null)

  const [tree, setTree] = useState<Epic[]>([])
  const [activeItem, setActiveItem] = useState<{ name: string } | null>(null)

  const { data: project } = useQuery<Project>({
    queryKey: ['project', projectId],
    queryFn: () => api.get(`/projects/${projectId}`).then(r => r.data),
  })

  const { data: epics = [], isLoading } = useQuery<Epic[]>({
    queryKey: ['backlog', projectId],
    queryFn: () => api.get(`/projects/${projectId}/epics`).then(r => r.data),
  })

  const { data: resourceTypes = [] } = useQuery<ResourceType[]>({
    queryKey: ['resource-types', projectId],
    queryFn: () => api.get(`/projects/${projectId}/resource-types`).then(r => r.data),
  })

  const reorderEpics = useReorderEpics(projectId!)
  const reorderFeatures = useReorderFeatures(projectId!)
  const reorderStories = useReorderStories(projectId!)
  const reorderTasks = useReorderTasks(projectId!)

  const isMutating = reorderEpics.isPending || reorderFeatures.isPending || reorderStories.isPending || reorderTasks.isPending

  useEffect(() => {
    if (!activeItem && !isMutating) {
      setTree(epics)
    }
  }, [epics, activeItem, isMutating])

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }))

  const hoursPerDay = project?.hoursPerDay ?? 7.6

  // Full invalidation: for mutations that affect effort/hours/active-status
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['backlog', projectId] })
    qc.invalidateQueries({ queryKey: ['timeline', projectId] })
    qc.invalidateQueries({ queryKey: ['resource-profile', projectId] })
  }

  // Backlog-only invalidation: for metadata-only mutations (name, description, assumptions)
  // that cannot affect timeline scheduling or resource demand
  const invalidateBacklog = () => {
    qc.invalidateQueries({ queryKey: ['backlog', projectId] })
  }

  const createEpic = useMutation({
    mutationFn: (data: typeof epicForm) => api.post(`/projects/${projectId}/epics`, data),
    onSuccess: (res) => { invalidateBacklog(); setAddingEpic(false); setEpicForm({ name: '', description: '', assumptions: '' }); setExpandedEpics(s => { const n = new Set(s); n.add(res.data.id); return n }) },
  })

  const updateEpic = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Record<string, unknown> }) =>
      api.put(`/projects/${projectId}/epics/${id}`, data),
    onSuccess: () => { invalidateBacklog(); setEditingEpicId(null) },
  })

  const toggleEpicActive = useMutation({
    mutationFn: ({ id, isActive }: { id: string; isActive: boolean }) =>
      api.put(`/projects/${projectId}/epics/${id}`, { isActive }),
    onSuccess: invalidate,
  })

  const deleteEpic = useMutation({
    mutationFn: (id: string) => api.delete(`/projects/${projectId}/epics/${id}`),
    onSuccess: invalidate,
  })

  const { data: epicDepsData = [] } = useQuery<Array<{ epicId: string; dependsOnId: string }>>({
    queryKey: ['epicDeps', projectId],
    queryFn: () => api.get(`/projects/${projectId}/epic-dependencies`).then(r => r.data),
    enabled: !!projectId,
  })

  const [epicDepError, setEpicDepError] = useState<string | null>(null)

  const addEpicDep = useMutation({
    mutationFn: ({ epicId, dependsOnId }: { epicId: string; dependsOnId: string }) =>
      api.post(`/projects/${projectId}/epic-dependencies`, { epicId, dependsOnId }).then(r => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['epicDeps', projectId] })
      setEpicDepError(null)
    },
    onError: (err: unknown) => {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? 'Failed to add dependency'
      setEpicDepError(msg)
    },
  })

  const removeEpicDep = useMutation({
    mutationFn: ({ epicId, dependsOnId }: { epicId: string; dependsOnId: string }) =>
      api.delete(`/projects/${projectId}/epic-dependencies/${epicId}/${dependsOnId}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['epicDeps', projectId] }),
  })

  const { data: featureDepsData = [] } = useQuery<Array<{ featureId: string; dependsOnId: string }>>({
    queryKey: ['feature-deps', projectId],
    queryFn: () => api.get(`/projects/${projectId}/feature-dependencies`).then(r => r.data),
    enabled: !!projectId,
  })

  const [featureDepError, setFeatureDepError] = useState<string | null>(null)

  const addFeatureDepBacklog = useMutation({
    mutationFn: ({ featureId, dependsOnId }: { featureId: string; dependsOnId: string }) =>
      api.post(`/projects/${projectId}/feature-dependencies`, { featureId, dependsOnId }).then(r => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['feature-deps', projectId] })
      setFeatureDepError(null)
    },
    onError: (err: unknown) => {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? 'Failed to add dependency'
      setFeatureDepError(msg)
    },
  })

  const removeFeatureDepBacklog = useMutation({
    mutationFn: ({ featureId, dependsOnId }: { featureId: string; dependsOnId: string }) =>
      api.delete(`/projects/${projectId}/feature-dependencies/${featureId}/${dependsOnId}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['feature-deps', projectId] }),
  })

  interface Snapshot { id: string; label: string | null; trigger: string; createdAt: string }
  interface Diff { added: string[]; removed: string[]; snapshotAt: string }

  const { data: snapshots = [], refetch: refetchSnapshots } = useQuery<Snapshot[]>({
    queryKey: ['snapshots', projectId],
    queryFn: () => api.get(`/projects/${projectId}/snapshots`).then(r => r.data),
    enabled: showHistory,
  })

  const { data: diffData } = useQuery<Diff>({
    queryKey: ['snapshot-diff', projectId, diffId],
    queryFn: () => api.get(`/projects/${projectId}/snapshots/${diffId}/diff`).then(r => r.data),
    enabled: !!diffId,
  })

  const saveSnapshot = useMutation({
    mutationFn: (label: string) => api.post(`/projects/${projectId}/snapshots`, { label }),
    onSuccess: () => { setSnapshotLabel(''); refetchSnapshots() },
  })

  const rollback = useMutation({
    mutationFn: (snapshotId: string) => api.post(`/projects/${projectId}/snapshots/${snapshotId}/rollback`, {}),
    onSuccess: () => { invalidate(); refetchSnapshots() },
  })

  const toggle = (id: string) =>
    setExpandedEpics(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n })

  const epicTotalHours = (epic: Epic) =>
    epic.features.reduce((s, f) =>
      s + f.userStories.reduce((ss, st) =>
        ss + st.tasks.reduce((a, t) => a + t.hoursEffort, 0), 0), 0)

  const grandTotal = tree.reduce((s, e) => s + epicTotalHours(e), 0)

  const handleDragStart = (event: DragStartEvent) => {
    const activeId = String(event.active.id)
    let name = ''
    if (activeId.startsWith('epic-') && !activeId.startsWith('epic-container-')) {
      name = tree.find(e => e.id === activeId.slice('epic-'.length))?.name ?? ''
    } else if (activeId.startsWith('feature-') && !activeId.startsWith('feature-container-')) {
      const fid = activeId.slice('feature-'.length)
      for (const epic of tree) { const f = epic.features.find(f => f.id === fid); if (f) { name = f.name; break } }
    } else if (activeId.startsWith('story-') && !activeId.startsWith('story-container-')) {
      const sid = activeId.slice('story-'.length)
      for (const epic of tree) { for (const feat of epic.features) { const s = feat.userStories.find(s => s.id === sid); if (s) { name = s.name; break } } if (name) break }
    } else if (activeId.startsWith('task-') && !activeId.startsWith('task-container-')) {
      const tid = activeId.slice('task-'.length)
      outer: for (const epic of tree) { for (const feat of epic.features) { for (const story of feat.userStories) { const t = story.tasks.find(t => t.id === tid); if (t) { name = t.name; break outer } } } }
    }
    setActiveItem({ name })
  }

  const handleDragOver = (event: DragOverEvent) => {
    const { active, over } = event
    if (!over) return
    const activeId = String(active.id)
    const overId = String(over.id)
    if (activeId === overId) return

    setTree(prev => {
      if (activeId.startsWith('epic-') && !activeId.startsWith('epic-container-')) {
        return moveEpicInTree(prev, activeId.slice('epic-'.length), overId)
      }
      if (activeId.startsWith('feature-') && !activeId.startsWith('feature-container-')) {
        return moveFeatureInTree(prev, activeId.slice('feature-'.length), overId)
      }
      if (activeId.startsWith('story-') && !activeId.startsWith('story-container-')) {
        return moveStoryInTree(prev, activeId.slice('story-'.length), overId)
      }
      if (activeId.startsWith('task-') && !activeId.startsWith('task-container-')) {
        return moveTaskInTree(prev, activeId.slice('task-'.length), overId)
      }
      return prev
    })
  }

  const handleDragEnd = (event: DragEndEvent) => {
    const { active } = event
    const activeId = String(active.id)
    setActiveItem(null)

    if (activeId.startsWith('epic-') && !activeId.startsWith('epic-container-')) {
      reorderEpics.mutate(tree.map((e, i) => ({ id: e.id, order: i })))
    } else if (activeId.startsWith('feature-') && !activeId.startsWith('feature-container-')) {
      const items: Array<{ id: string; order: number; epicId: string }> = []
      for (const epic of tree) epic.features.forEach((f, i) => items.push({ id: f.id, order: i, epicId: epic.id }))
      reorderFeatures.mutate(items)
    } else if (activeId.startsWith('story-') && !activeId.startsWith('story-container-')) {
      const items: Array<{ id: string; order: number; featureId: string }> = []
      for (const epic of tree) for (const feat of epic.features) feat.userStories.forEach((s, i) => items.push({ id: s.id, order: i, featureId: feat.id }))
      reorderStories.mutate(items)
    } else if (activeId.startsWith('task-') && !activeId.startsWith('task-container-')) {
      const items: Array<{ id: string; order: number; storyId: string }> = []
      for (const epic of tree) for (const feat of epic.features) for (const story of feat.userStories) story.tasks.forEach((t, i) => items.push({ id: t.id, order: i, storyId: story.id }))
      reorderTasks.mutate(items)
    }
  }

  return (
    <AppLayout
      breadcrumb={<>
          <span>/</span>
          <button onClick={() => navigate(`/projects/${projectId}`)} className="hover:text-lab3-navy dark:hover:text-lab3-blue transition-colors">
            {project?.name ?? '…'}
          </button>
          <span>/</span>
          <span className="text-gray-700 dark:text-gray-300">Backlog</span>
        </>}
    >
      <main className="max-w-6xl mx-auto px-6 py-8">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h1 className="text-xl font-semibold text-gray-900 dark:text-white">Backlog</h1>
            {epics.length > 0 && (
              <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">
                {epics.length} epic{epics.length !== 1 ? 's' : ''} · {grandTotal.toFixed(2)}h total ({(grandTotal / hoursPerDay).toFixed(2)} days)
              </p>
            )}
          </div>
          <button onClick={() => setAddingEpic(true)}
            className="bg-lab3-navy text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-lab3-blue transition-colors">
            + Add epic
          </button>
          <button onClick={() => setShowCsvImport(true)}
            className="border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 px-4 py-2 rounded-lg text-sm font-medium hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors">
            ⬆ Import CSV
          </button>
          <button
            onClick={async () => {
              const res = await api.get(`/projects/${projectId}/backlog/export-csv`, { responseType: 'blob' })
              const url = URL.createObjectURL(res.data)
              const disposition: string = res.headers['content-disposition'] ?? ''
              const match = disposition.match(/filename="([^"]+)"/)
              const filename = match ? match[1] : `backlog-${projectId}.csv`
              const a = document.createElement('a'); a.href = url; a.download = filename; a.click()
              URL.revokeObjectURL(url)
            }}
            className="border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 px-4 py-2 rounded-lg text-sm font-medium hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors">
            ⬇ Export CSV
          </button>
          <button onClick={() => setShowHistory(h => !h)}
            className="border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 px-4 py-2 rounded-lg text-sm font-medium hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors">
            🕐 History
          </button>
        </div>

        {isLoading ? (
          <div className="text-center py-12 text-gray-400 dark:text-gray-500">Loading…</div>
        ) : (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCorners}
            onDragStart={handleDragStart}
            onDragOver={handleDragOver}
            onDragEnd={handleDragEnd}
          >
            <SortableContext items={tree.map(e => 'epic-' + e.id)} strategy={verticalListSortingStrategy}>
              <div className="space-y-2">
                {tree.map((epic, index) => (
                  <SortableEpicRow
                    key={epic.id}
                    epic={epic}
                    expanded={expandedEpics.has(epic.id)}
                    onToggle={() => toggle(epic.id)}
                    isEditing={editingEpicId === epic.id}
                    onEdit={() => setEditingEpicId(epic.id)}
                    onSaveEdit={(data) => updateEpic.mutate({ id: epic.id, data })}
                    onCancelEdit={() => setEditingEpicId(null)}
                    editSaving={updateEpic.isPending}
                    onDelete={() => deleteEpic.mutate(epic.id)}
                    onToggleActive={() => toggleEpicActive.mutate({ id: epic.id, isActive: epic.isActive !== false ? false : true })}
                    onToggleFeatureMode={() => updateEpic.mutate({ id: epic.id, data: { featureMode: epic.featureMode === 'parallel' ? 'sequential' : 'parallel' } })}
                    epicTotalHours={epicTotalHours(epic)}
                    resourceTypes={resourceTypes}
                    projectId={projectId!}
                    hoursPerDay={hoursPerDay}
                    epicColour={getEpicColour(index)}
                    allEpics={tree.map(e => ({ id: e.id, name: e.name }))}
                    epicDeps={epicDepsData}
                    onAddEpicDep={(epicId, dependsOnId) => addEpicDep.mutate({ epicId, dependsOnId })}
                    onRemoveEpicDep={(epicId, dependsOnId) => removeEpicDep.mutate({ epicId, dependsOnId })}
                    epicDepError={epicDepError}
                    allFeatures={tree.flatMap(e => e.features.map(f => ({ id: f.id, name: f.name, epicName: e.name })))}
                    featureDeps={featureDepsData}
                    onAddFeatureDep={(featureId, dependsOnId) => addFeatureDepBacklog.mutate({ featureId, dependsOnId })}
                    onRemoveFeatureDep={(featureId, dependsOnId) => removeFeatureDepBacklog.mutate({ featureId, dependsOnId })}
                    featureDepError={featureDepError}
                  />
                ))}

                {addingEpic && (
                  <div className="bg-white dark:bg-gray-800 rounded-xl border border-blue-200 p-4">
                    <EpicForm
                      initial={epicForm}
                      onSave={(data) => createEpic.mutate(data)}
                      onCancel={() => setAddingEpic(false)}
                      saving={createEpic.isPending}
                    />
                  </div>
                )}

                {tree.length === 0 && !addingEpic && (
                  <div className="text-center py-16 text-gray-400 dark:text-gray-500">
                    <p className="text-lg mb-1">Backlog is empty</p>
                    <p className="text-sm">Add an epic to get started, or use AI to generate a starter backlog</p>
                  </div>
                )}
              </div>
            </SortableContext>
            <DragOverlay>
              {activeItem && (
                <div className="bg-white dark:bg-gray-800 border-2 border-blue-400 rounded-lg px-3 py-2 shadow-lg text-sm font-medium opacity-90">
                  {activeItem.name}
                </div>
              )}
            </DragOverlay>
          </DndContext>
        )}

        {showHistory && (
          <div className="mt-6 bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-5">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-sm font-semibold text-gray-800 dark:text-gray-100">Backlog History</h2>
              <div className="flex gap-2">
                <input
                  placeholder="Snapshot label (optional)"
                  value={snapshotLabel}
                  onChange={e => setSnapshotLabel(e.target.value)}
                  className="border border-gray-200 dark:border-gray-600 rounded px-2 py-1 text-xs bg-white dark:bg-gray-700 text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-400 focus:outline-none focus:ring-1 focus:ring-lab3-blue w-48"
                />
                <button
                  onClick={() => saveSnapshot.mutate(snapshotLabel)}
                  disabled={saveSnapshot.isPending}
                  className="bg-lab3-navy text-white px-3 py-1 rounded text-xs font-medium hover:bg-lab3-blue disabled:opacity-50">
                  {saveSnapshot.isPending ? 'Saving…' : 'Save snapshot'}
                </button>
              </div>
            </div>
            {snapshots.length === 0 ? (
              <p className="text-sm text-gray-400 dark:text-gray-500 text-center py-4">No snapshots yet</p>
            ) : (
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-gray-400 dark:text-gray-500 border-b border-gray-100 dark:border-gray-700">
                    <th className="text-left pb-2 font-medium">Label</th>
                    <th className="text-left pb-2 font-medium">Trigger</th>
                    <th className="text-left pb-2 font-medium">Saved</th>
                    <th className="pb-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {snapshots.map(snap => (
                    <>
                      <tr key={snap.id} className="border-b border-gray-50 last:border-0">
                        <td className="py-2 pr-4 text-gray-700 dark:text-gray-300">{snap.label ?? <span className="text-gray-400 dark:text-gray-500 italic">unlabelled</span>}</td>
                        <td className="py-2 pr-4"><span className="bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400 px-1.5 py-0.5 rounded">{snap.trigger}</span></td>
                        <td className="py-2 pr-4 text-gray-500 dark:text-gray-400">{new Date(snap.createdAt).toLocaleString()}</td>
                        <td className="py-2">
                          <div className="flex gap-2">
                            <button onClick={() => setDiffId(d => d === snap.id ? null : snap.id)} className="text-blue-500 hover:text-blue-700">
                              {diffId === snap.id ? 'Hide diff' : 'Diff'}
                            </button>
                            <button
                              onClick={() => { if (confirm('Roll back to this snapshot? Current state will be auto-saved first.')) rollback.mutate(snap.id) }}
                              disabled={rollback.isPending}
                              className="text-red-500 hover:text-red-700 disabled:opacity-50">
                              Rollback
                            </button>
                          </div>
                        </td>
                      </tr>
                      {diffId === snap.id && diffData && (
                        <tr key={`diff-${snap.id}`}>
                          <td colSpan={4} className="pb-3 pt-1">
                            <div className="bg-gray-50 dark:bg-gray-700 rounded-lg p-3 text-xs font-mono space-y-1">
                              <p className="text-gray-500 dark:text-gray-400 mb-2">Comparing snapshot ({new Date(diffData.snapshotAt).toLocaleString()}) to current:</p>
                              {diffData.added.map((line, i) => <div key={i} className="text-green-700">+ {line}</div>)}
                              {diffData.removed.map((line, i) => <div key={i} className="text-red-600">- {line}</div>)}
                              {diffData.added.length === 0 && diffData.removed.length === 0 && (
                                <div className="text-gray-400 dark:text-gray-500">No differences</div>
                              )}
                            </div>
                          </td>
                        </tr>
                      )}
                    </>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
      </main>
      {showCsvImport && (
        <CsvImportModal
          projectId={projectId!}
          onClose={() => setShowCsvImport(false)}
          onImported={invalidate}
        />
      )}
    </AppLayout>
  )
}

function SortableEpicRow({ epic, expanded, onToggle, isEditing, onEdit, onSaveEdit, onCancelEdit, editSaving, onDelete, onToggleActive, onToggleFeatureMode, epicTotalHours, resourceTypes, projectId, hoursPerDay, epicColour, allEpics, epicDeps, onAddEpicDep, onRemoveEpicDep, epicDepError, allFeatures, featureDeps, onAddFeatureDep, onRemoveFeatureDep, featureDepError }: {
  epic: Epic
  expanded: boolean
  onToggle: () => void
  isEditing: boolean
  onEdit: () => void
  onSaveEdit: (data: { name: string; description: string; assumptions: string }) => void
  onCancelEdit: () => void
  editSaving: boolean
  onDelete: () => void
  onToggleActive: () => void
  onToggleFeatureMode: () => void
  epicTotalHours: number
  resourceTypes: ResourceType[]
  projectId: string
  hoursPerDay: number
  epicColour: EpicColour
  allEpics: Array<{ id: string; name: string }>
  epicDeps: Array<{ epicId: string; dependsOnId: string }>
  onAddEpicDep: (epicId: string, dependsOnId: string) => void
  onRemoveEpicDep: (epicId: string, dependsOnId: string) => void
  epicDepError: string | null
  allFeatures: Array<{ id: string; name: string; epicName: string }>
  featureDeps: Array<{ featureId: string; dependsOnId: string }>
  onAddFeatureDep: (featureId: string, dependsOnId: string) => void
  onRemoveFeatureDep: (featureId: string, dependsOnId: string) => void
  featureDepError: string | null
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: 'epic-' + epic.id })
  const style = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.4 : undefined }
  const [epicDepPickerOpen, setEpicDepPickerOpen] = useState(false)

  return (
    <div ref={setNodeRef} style={style} {...attributes} className={`bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 border-l-4 ${epicColour.border}`}>
      {isEditing ? (
        <div className="p-3">
          <EpicForm
            initial={{ name: epic.name, description: epic.description ?? '', assumptions: epic.assumptions ?? '' }}
            onSave={onSaveEdit}
            onCancel={onCancelEdit}
            saving={editSaving}
          />
        </div>
      ) : (
        <div className={`group px-4 py-3 cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-700 ${epicColour.light} ${epicColour.darkLight}`} onClick={onToggle}>
          <div className="flex items-center gap-2">
            <button {...listeners} className="cursor-grab active:cursor-grabbing text-gray-300 hover:text-gray-500 shrink-0 px-0.5 text-base leading-none mr-1" onClick={e => e.stopPropagation()}>⠿</button>
            <span className="text-gray-400 dark:text-gray-500 text-sm select-none">{expanded ? '▼' : '▶'}</span>
            <span className="text-xs text-lab3-navy dark:text-blue-300 bg-blue-50 dark:bg-blue-900 px-2 py-0.5 rounded font-medium">Epic</span>
            <span className={`font-medium flex-1 ${epic.isActive === false ? 'line-through text-gray-400' : 'text-gray-900 dark:text-white'}`}>{epic.name}</span>
            <button
              onClick={e => { e.stopPropagation(); onToggleFeatureMode() }}
              title={`Feature mode: ${epic.featureMode ?? 'sequential'} — click to toggle`}
              className={epic.featureMode === 'parallel'
                ? 'bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400 text-xs px-2 py-0.5 rounded cursor-pointer hover:bg-blue-100 dark:hover:bg-blue-900/50'
                : 'bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400 text-xs px-2 py-0.5 rounded cursor-pointer hover:bg-gray-200 dark:hover:bg-gray-600'}
            >
              {epic.featureMode === 'parallel' ? 'parallel' : 'sequential'}
            </button>
            <span className="text-sm text-gray-400 dark:text-gray-500">
              {epic.features.length} feature{epic.features.length !== 1 ? 's' : ''} · {epicTotalHours.toFixed(2)}h · {(epicTotalHours / hoursPerDay).toFixed(1)}d
            </span>
            <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity" onClick={e => e.stopPropagation()}>
              <button
                onClick={onToggleActive}
                title={epic.isActive === false ? 'Mark in scope' : 'Mark out of scope'}
                className={epic.isActive === false
                  ? 'bg-gray-100 dark:bg-gray-700 text-gray-400 dark:text-gray-500 border border-gray-200 dark:border-gray-600 text-xs px-2 py-0.5 rounded-full font-medium cursor-pointer hover:bg-gray-200 dark:hover:bg-gray-600 line-through'
                  : 'bg-green-50 dark:bg-green-900/30 text-green-700 dark:text-green-400 border border-green-200 dark:border-green-800 text-xs px-2 py-0.5 rounded-full font-medium cursor-pointer hover:bg-green-100 dark:hover:bg-green-900/50'}
              >
                {epic.isActive === false ? 'Out of scope' : 'In scope'}
              </button>
              <button onClick={onEdit} className="text-xs text-gray-400 dark:text-gray-500 hover:text-gray-700 px-2 py-1">Edit</button>
              <button onClick={onDelete} className="text-xs text-red-400 hover:text-red-600 px-2 py-1">Delete</button>
            </div>
          </div>
          {epic.description && (
            <div
              className="text-sm text-gray-500 dark:text-gray-400 mt-1 ml-7 rich-text-content"
              dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(epic.description) }}
            />
          )}
          {epic.assumptions && (
            <div className="mt-0.5 ml-7">
              <span className="text-xs font-medium text-gray-500 dark:text-gray-400">Assumptions: </span>
              <span
                className="text-sm text-gray-400 dark:text-gray-500 rich-text-content inline"
                dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(epic.assumptions) }}
              />
            </div>
          )}
          {/* Epic dependencies row */}
          <div className="flex flex-wrap items-center gap-1 mt-1 ml-7" onClick={e => e.stopPropagation()}>
            {epicDeps
              .filter(d => d.epicId === epic.id)
              .map(d => {
                const depName = allEpics.find(e => e.id === d.dependsOnId)?.name ?? d.dependsOnId
                return (
                  <span key={d.dependsOnId} className="inline-flex items-center gap-0.5 text-xs bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 px-1.5 py-0.5 rounded">
                    → {depName}
                    <button onClick={() => onRemoveEpicDep(epic.id, d.dependsOnId)} className="ml-0.5 text-gray-400 hover:text-red-500">×</button>
                  </span>
                )
              })}
            <div className="relative">
              <button
                onClick={() => setEpicDepPickerOpen(v => !v)}
                className="text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 border border-dashed border-gray-300 dark:border-gray-600 px-1.5 py-0.5 rounded"
                title="Add epic dependency"
              >＋ dep</button>
              {epicDepPickerOpen && (
                <div className="absolute top-full left-0 z-50 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-600 rounded shadow-lg py-1 min-w-[160px]">
                  {allEpics
                    .filter(e => e.id !== epic.id && !epicDeps.some(d => d.epicId === epic.id && d.dependsOnId === e.id))
                    .map(e => (
                      <button
                        key={e.id}
                        className="w-full text-left text-xs px-3 py-1.5 hover:bg-gray-50 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-300"
                        onClick={() => { onAddEpicDep(epic.id, e.id); setEpicDepPickerOpen(false) }}
                      >
                        {e.name}
                      </button>
                    ))}
                  {allEpics.filter(e => e.id !== epic.id && !epicDeps.some(d => d.epicId === epic.id && d.dependsOnId === e.id)).length === 0 && (
                    <span className="text-xs px-3 py-1.5 text-gray-400 block">No epics available</span>
                  )}
                </div>
              )}
            </div>
            {epicDepError && <span className="text-xs text-red-500">{epicDepError}</span>}
          </div>
        </div>
      )}
      {expanded && (
        <div className="border-t border-gray-100 dark:border-gray-700 px-3 pb-3 pt-2">
          <FeatureList
            epicId={epic.id}
            features={epic.features}
            resourceTypes={resourceTypes}
            projectId={projectId}
            hoursPerDay={hoursPerDay}
            epicColour={epicColour}
            allFeatures={allFeatures}
            featureDeps={featureDeps}
            onAddFeatureDep={onAddFeatureDep}
            onRemoveFeatureDep={onRemoveFeatureDep}
            featureDepError={featureDepError}
          />
        </div>
      )}
    </div>
  )
}

function moveEpicInTree(tree: Epic[], epicId: string, overId: string): Epic[] {
  if (!overId.startsWith('epic-') || overId.startsWith('epic-container-')) return tree
  const overEpicId = overId.slice('epic-'.length)
  if (epicId === overEpicId) return tree
  const fromIdx = tree.findIndex(e => e.id === epicId)
  const toIdx = tree.findIndex(e => e.id === overEpicId)
  if (fromIdx === -1 || toIdx === -1 || fromIdx === toIdx) return tree
  return arrayMove(tree, fromIdx, toIdx)
}

function moveFeatureInTree(tree: Epic[], featureId: string, overId: string): Epic[] {
  let sourceEpicId = ''
  let sourceFeature: Feature | null = null
  for (const epic of tree) {
    const f = epic.features.find(f => f.id === featureId)
    if (f) { sourceEpicId = epic.id; sourceFeature = f; break }
  }
  if (!sourceFeature) return tree

  let targetEpicId = ''
  let insertBeforeId: string | null = null

  if (overId.startsWith('epic-container-')) {
    targetEpicId = overId.slice('epic-container-'.length)
  } else if (overId.startsWith('feature-') && !overId.startsWith('feature-container-')) {
    const overFeatureId = overId.slice('feature-'.length)
    if (overFeatureId === featureId) return tree
    for (const epic of tree) {
      if (epic.features.some(f => f.id === overFeatureId)) {
        targetEpicId = epic.id; insertBeforeId = overFeatureId; break
      }
    }
  }
  if (!targetEpicId) return tree

  if (targetEpicId === sourceEpicId) {
    if (!insertBeforeId) return tree
    const epic = tree.find(e => e.id === sourceEpicId)!
    const fromIdx = epic.features.findIndex(f => f.id === featureId)
    const toIdx = epic.features.findIndex(f => f.id === insertBeforeId)
    if (fromIdx === toIdx) return tree
    return tree.map(e => e.id === sourceEpicId ? { ...e, features: arrayMove(e.features, fromIdx, toIdx) } : e)
  }

  let moved: Feature | undefined
  const removed = tree.map(epic => {
    if (epic.id === sourceEpicId) { moved = epic.features.find(f => f.id === featureId); return { ...epic, features: epic.features.filter(f => f.id !== featureId) } }
    return epic
  })
  if (!moved) return tree
  return removed.map(epic => {
    if (epic.id === targetEpicId) {
      const idx = insertBeforeId ? epic.features.findIndex(f => f.id === insertBeforeId) : epic.features.length
      const newFeatures = [...epic.features]
      newFeatures.splice(idx === -1 ? newFeatures.length : idx, 0, { ...moved!, epicId: targetEpicId })
      return { ...epic, features: newFeatures }
    }
    return epic
  })
}

function moveStoryInTree(tree: Epic[], storyId: string, overId: string): Epic[] {
  let sourceFeatureId = ''
  let sourceStory: UserStory | null = null
  outer1: for (const epic of tree) {
    for (const feat of epic.features) {
      const s = feat.userStories.find(s => s.id === storyId)
      if (s) { sourceFeatureId = feat.id; sourceStory = s; break outer1 }
    }
  }
  if (!sourceStory) return tree

  let targetFeatureId = ''
  let insertBeforeId: string | null = null

  if (overId.startsWith('feature-container-')) {
    targetFeatureId = overId.slice('feature-container-'.length)
  } else if (overId.startsWith('story-') && !overId.startsWith('story-container-')) {
    const overStoryId = overId.slice('story-'.length)
    if (overStoryId === storyId) return tree
    outer2: for (const epic of tree) {
      for (const feat of epic.features) {
        if (feat.userStories.some(s => s.id === overStoryId)) {
          targetFeatureId = feat.id; insertBeforeId = overStoryId; break outer2
        }
      }
    }
  }
  if (!targetFeatureId) return tree

  if (targetFeatureId === sourceFeatureId) {
    if (!insertBeforeId) return tree
    return tree.map(epic => ({
      ...epic,
      features: epic.features.map(feat => {
        if (feat.id !== sourceFeatureId) return feat
        const fromIdx = feat.userStories.findIndex(s => s.id === storyId)
        const toIdx = feat.userStories.findIndex(s => s.id === insertBeforeId)
        if (fromIdx === toIdx) return feat
        return { ...feat, userStories: arrayMove(feat.userStories, fromIdx, toIdx) }
      }),
    }))
  }

  let moved: UserStory | undefined
  const removed = tree.map(epic => ({
    ...epic,
    features: epic.features.map(feat => {
      if (feat.id === sourceFeatureId) { moved = feat.userStories.find(s => s.id === storyId); return { ...feat, userStories: feat.userStories.filter(s => s.id !== storyId) } }
      return feat
    }),
  }))
  if (!moved) return tree
  return removed.map(epic => ({
    ...epic,
    features: epic.features.map(feat => {
      if (feat.id === targetFeatureId) {
        const idx = insertBeforeId ? feat.userStories.findIndex(s => s.id === insertBeforeId) : feat.userStories.length
        const newStories = [...feat.userStories]
        newStories.splice(idx === -1 ? newStories.length : idx, 0, { ...moved!, featureId: targetFeatureId })
        return { ...feat, userStories: newStories }
      }
      return feat
    }),
  }))
}

function moveTaskInTree(tree: Epic[], taskId: string, overId: string): Epic[] {
  let sourceStoryId = ''
  let sourceTask: Task | null = null
  outer1: for (const epic of tree) {
    for (const feat of epic.features) {
      for (const story of feat.userStories) {
        const t = story.tasks.find(t => t.id === taskId)
        if (t) { sourceStoryId = story.id; sourceTask = t; break outer1 }
      }
    }
  }
  if (!sourceTask) return tree

  let targetStoryId = ''
  let insertBeforeId: string | null = null

  if (overId.startsWith('story-container-')) {
    targetStoryId = overId.slice('story-container-'.length)
  } else if (overId.startsWith('task-') && !overId.startsWith('task-container-')) {
    const overTaskId = overId.slice('task-'.length)
    if (overTaskId === taskId) return tree
    outer2: for (const epic of tree) {
      for (const feat of epic.features) {
        for (const story of feat.userStories) {
          if (story.tasks.some(t => t.id === overTaskId)) {
            targetStoryId = story.id; insertBeforeId = overTaskId; break outer2
          }
        }
      }
    }
  }
  if (!targetStoryId) return tree

  if (targetStoryId === sourceStoryId) {
    if (!insertBeforeId) return tree
    return tree.map(epic => ({
      ...epic,
      features: epic.features.map(feat => ({
        ...feat,
        userStories: feat.userStories.map(story => {
          if (story.id !== sourceStoryId) return story
          const fromIdx = story.tasks.findIndex(t => t.id === taskId)
          const toIdx = story.tasks.findIndex(t => t.id === insertBeforeId)
          if (fromIdx === toIdx) return story
          return { ...story, tasks: arrayMove(story.tasks, fromIdx, toIdx) }
        }),
      })),
    }))
  }

  let moved: Task | undefined
  const removed = tree.map(epic => ({
    ...epic,
    features: epic.features.map(feat => ({
      ...feat,
      userStories: feat.userStories.map(story => {
        if (story.id === sourceStoryId) { moved = story.tasks.find(t => t.id === taskId); return { ...story, tasks: story.tasks.filter(t => t.id !== taskId) } }
        return story
      }),
    })),
  }))
  if (!moved) return tree
  return removed.map(epic => ({
    ...epic,
    features: epic.features.map(feat => ({
      ...feat,
      userStories: feat.userStories.map(story => {
        if (story.id === targetStoryId) {
          const idx = insertBeforeId ? story.tasks.findIndex(t => t.id === insertBeforeId) : story.tasks.length
          const newTasks = [...story.tasks]
          newTasks.splice(idx === -1 ? newTasks.length : idx, 0, { ...moved!, userStoryId: targetStoryId })
          return { ...story, tasks: newTasks }
        }
        return story
      }),
    })),
  }))
}

function EpicForm({ initial, onSave, onCancel, saving }: {
  initial: { name: string; description: string; assumptions: string }
  onSave: (data: typeof initial) => void
  onCancel: () => void
  saving: boolean
}) {
  const [form, setForm] = useState(initial)

  return (
    <div className="space-y-2">
      <input placeholder="Epic name *" value={form.name} onChange={e => setForm(v => ({ ...v, name: e.target.value }))}
        className="w-full border border-gray-200 dark:border-gray-600 rounded-lg px-3 py-2 text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-lab3-blue" />
      <RichTextEditor
        value={form.description}
        onChange={v => setForm(prev => ({ ...prev, description: v }))}
        placeholder="Description"
        className="text-sm"
      />
      <RichTextEditor
        value={form.assumptions}
        onChange={v => setForm(prev => ({ ...prev, assumptions: v }))}
        placeholder="Assumptions (optional)"
        className="text-sm"
      />
      <div className="flex gap-2">
        <button onClick={() => onSave(form)} disabled={!form.name || saving}
          className="bg-lab3-navy text-white px-4 py-1.5 rounded-lg text-sm font-medium hover:bg-lab3-blue disabled:opacity-50">
          {saving ? 'Saving…' : 'Save epic'}
        </button>
        <button onClick={onCancel} className="px-4 py-1.5 rounded-lg text-sm text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700">Cancel</button>
      </div>
    </div>
  )
}
