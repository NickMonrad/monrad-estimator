import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useDroppable } from '@dnd-kit/core'
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { api } from '../../lib/api'
import type { Feature, ResourceType } from '../../types/backlog'
import type { EpicColour } from '../../lib/epicColours'
import StoryList from './StoryList'
import ApplyTemplateModal from './ApplyTemplateModal'
import RichTextEditor from '../shared/RichTextEditor'
interface Props {
  epicId: string
  features: Feature[]
  resourceTypes: ResourceType[]
  projectId: string
  hoursPerDay: number
  epicColour?: EpicColour
  allFeatures?: Array<{ id: string; name: string; epicName: string }>
  featureDeps?: Array<{ featureId: string; dependsOnId: string }>
  onAddFeatureDep?: (featureId: string, dependsOnId: string) => void
  onRemoveFeatureDep?: (featureId: string, dependsOnId: string) => void
  featureDepError?: string | null
}

function SortableFeatureItem({ feature, isEditing, expanded, onToggle, onEdit, onCancelEdit, onSave, onDelete, onToggleActive, onToggleFeatureMode, isSaving, onApplyTemplate, resourceTypes, projectId, hoursPerDay, epicColour, allFeatures, featureDeps, onAddFeatureDep, onRemoveFeatureDep, featureDepError }: {
  feature: Feature
  isEditing: boolean
  expanded: boolean
  onToggle: () => void
  onEdit: () => void
  onCancelEdit: () => void
  onSave: (data: { name: string; description: string; assumptions: string }) => void
  onDelete: () => void
  onToggleActive: () => void
  onToggleFeatureMode: () => void
  isSaving: boolean
  onApplyTemplate: () => void
  resourceTypes: ResourceType[]
  projectId: string
  hoursPerDay: number
  epicColour?: EpicColour
  allFeatures?: Array<{ id: string; name: string; epicName: string }>
  featureDeps?: Array<{ featureId: string; dependsOnId: string }>
  onAddFeatureDep?: (featureId: string, dependsOnId: string) => void
  onRemoveFeatureDep?: (featureId: string, dependsOnId: string) => void
  featureDepError?: string | null
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: 'feature-' + feature.id })
  const style = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.4 : undefined }
  const totalHours = feature.userStories.reduce((s, st) => s + st.tasks.reduce((a, t) => a + t.hoursEffort, 0), 0)
  const [featureDepPickerOpen, setFeatureDepPickerOpen] = useState(false)

  return (
    <div ref={setNodeRef} style={style} {...attributes}>
      {isEditing ? (
        <InlineForm
          label="Feature"
          initial={{ name: feature.name, description: feature.description ?? '', assumptions: feature.assumptions ?? '' }}
          onSave={onSave}
          onCancel={onCancelEdit}
          saving={isSaving}
        />
      ) : (
        <div className={`group flex items-center gap-2 bg-blue-50 dark:bg-blue-950 border border-blue-100 dark:border-blue-900 rounded-lg px-3 py-2 hover:border-blue-300 dark:hover:border-blue-700 cursor-pointer border-l-2 ${epicColour?.border ?? 'border-l-blue-200'}`}
          onClick={onToggle}>
          <button {...listeners} className="cursor-grab active:cursor-grabbing text-blue-300 hover:text-blue-500 shrink-0 px-0.5 text-base leading-none" onClick={e => e.stopPropagation()}>⠿</button>
          <span className="text-blue-500 dark:text-blue-400 text-xs select-none">{expanded ? '▼' : '▶'}</span>
          <span className="text-xs text-blue-500 dark:text-blue-300 bg-blue-100 dark:bg-blue-900 px-1.5 py-0.5 rounded">Feature</span>
          <span className={`text-sm flex-1 truncate ${feature.isActive === false ? 'line-through text-gray-400 dark:text-gray-500' : 'text-gray-800 dark:text-gray-200'}`}>{feature.name}</span>
          <button
            onClick={e => { e.stopPropagation(); onToggleFeatureMode() }}
            title={`Story mode: ${feature.featureMode ?? 'sequential'} — click to toggle`}
            className={feature.featureMode === 'parallel'
              ? 'bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400 text-xs px-2 py-0.5 rounded cursor-pointer hover:bg-blue-100 dark:hover:bg-blue-900/50'
              : 'bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400 text-xs px-2 py-0.5 rounded cursor-pointer hover:bg-gray-200 dark:hover:bg-gray-600'}
          >
            {feature.featureMode === 'parallel' ? 'parallel' : 'sequential'}
          </button>
          <span className="text-xs text-gray-400 dark:text-gray-500">{feature.userStories.length} stor{feature.userStories.length !== 1 ? 'ies' : 'y'} · {totalHours.toFixed(2)}h · {(totalHours / hoursPerDay).toFixed(1)}d</span>
          <button onClick={e => { e.stopPropagation(); onApplyTemplate() }}
            className="text-xs text-purple-500 hover:text-purple-700 bg-purple-50 hover:bg-purple-100 border border-purple-200 px-2 py-0.5 rounded transition-colors">
            + Template
          </button>
          <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity" onClick={e => e.stopPropagation()}>
            <button
              onClick={onToggleActive}
              title={feature.isActive === false ? 'Mark in scope' : 'Mark out of scope'}
              className={feature.isActive === false
                ? 'bg-gray-100 dark:bg-gray-700 text-gray-400 dark:text-gray-500 border border-gray-200 dark:border-gray-600 text-xs px-2 py-0.5 rounded-full font-medium cursor-pointer hover:bg-gray-200 dark:hover:bg-gray-600 line-through'
                : 'bg-green-50 dark:bg-green-900/30 text-green-700 dark:text-green-400 border border-green-200 dark:border-green-800 text-xs px-2 py-0.5 rounded-full font-medium cursor-pointer hover:bg-green-100 dark:hover:bg-green-900/50'}
            >
              {feature.isActive === false ? 'Out of scope' : 'In scope'}
            </button>
            <button onClick={onEdit} className="text-xs text-gray-400 dark:text-gray-500 hover:text-gray-700 px-1">Edit</button>
            <button onClick={onDelete} className="text-xs text-red-400 hover:text-red-600 px-1">Delete</button>
          </div>
        </div>
      )}
      {expanded && (
        <StoryList featureId={feature.id} stories={feature.userStories} resourceTypes={resourceTypes} projectId={projectId} hoursPerDay={hoursPerDay} epicColour={epicColour} />
      )}
      {/* Feature dependency row */}
      {(featureDeps !== undefined || onAddFeatureDep) && (
        <div className="flex flex-wrap items-center gap-1 mt-0.5 ml-6" onClick={e => e.stopPropagation()}>
          {(featureDeps ?? [])
            .filter(d => d.featureId === feature.id)
            .map(d => {
              const depFeature = (allFeatures ?? []).find(f => f.id === d.dependsOnId)
              const depLabel = depFeature ? `${depFeature.epicName} / ${depFeature.name}` : d.dependsOnId
              return (
                <span key={d.dependsOnId} className="inline-flex items-center gap-0.5 text-xs bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400 px-1.5 py-0.5 rounded">
                  → {depLabel}
                  <button onClick={() => onRemoveFeatureDep?.(feature.id, d.dependsOnId)} className="ml-0.5 text-blue-400 hover:text-red-500">×</button>
                </span>
              )
            })}
          {onAddFeatureDep && (
            <div className="relative">
              <button
                onClick={() => setFeatureDepPickerOpen(v => !v)}
                className="text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 border border-dashed border-gray-300 dark:border-gray-600 px-1.5 py-0.5 rounded"
                title="Add feature dependency"
              >＋ dep</button>
              {featureDepPickerOpen && (
                <div className="absolute top-full left-0 z-50 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-600 rounded shadow-lg py-1 min-w-[200px]">
                  {(allFeatures ?? [])
                    .filter(f => f.id !== feature.id && !(featureDeps ?? []).some(d => d.featureId === feature.id && d.dependsOnId === f.id))
                    .map(f => (
                      <button
                        key={f.id}
                        className="w-full text-left text-xs px-3 py-1.5 hover:bg-gray-50 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-300"
                        onClick={() => { onAddFeatureDep(feature.id, f.id); setFeatureDepPickerOpen(false) }}
                      >
                        <span className="text-gray-400 dark:text-gray-500">{f.epicName} / </span>{f.name}
                      </button>
                    ))}
                  {(allFeatures ?? []).filter(f => f.id !== feature.id && !(featureDeps ?? []).some(d => d.featureId === feature.id && d.dependsOnId === f.id)).length === 0 && (
                    <span className="text-xs px-3 py-1.5 text-gray-400 block">No features available</span>
                  )}
                </div>
              )}
            </div>
          )}
          {featureDepError && <span className="text-xs text-red-500">{featureDepError}</span>}
        </div>
      )}
    </div>
  )
}

export default function FeatureList({ epicId, features, resourceTypes, projectId, hoursPerDay, epicColour, allFeatures, featureDeps, onAddFeatureDep, onRemoveFeatureDep, featureDepError }: Props) {
  const qc = useQueryClient()
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set())
  const [adding, setAdding] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState({ name: '', description: '', assumptions: '' })
  const [applyTemplateFeatureId, setApplyTemplateFeatureId] = useState<string | null>(null)

  const { setNodeRef } = useDroppable({ id: 'epic-container-' + epicId })

  const invalidate = () => qc.invalidateQueries({ queryKey: ['backlog', projectId] })

  const createFeature = useMutation({
    mutationFn: (data: typeof form) => api.post(`/epics/${epicId}/features`, data),
    onSuccess: (res) => { invalidate(); setAdding(false); setForm({ name: '', description: '', assumptions: '' }); setExpandedIds(s => { const n = new Set(s); n.add(res.data.id); return n }) },
  })

  const updateFeature = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Record<string, unknown> }) =>
      api.put(`/epics/${epicId}/features/${id}`, data),
    onSuccess: () => { invalidate(); setEditingId(null) },
  })

  const toggleFeatureActive = useMutation({
    mutationFn: ({ id, isActive }: { id: string; isActive: boolean }) =>
      api.put(`/epics/${epicId}/features/${id}`, { isActive }),
    onSuccess: invalidate,
  })

  const toggleFeatureMode = useMutation({
    mutationFn: ({ id, featureMode }: { id: string; featureMode: string }) =>
      api.put(`/epics/${epicId}/features/${id}`, { featureMode }),
    onSuccess: invalidate,
  })

  const deleteFeature = useMutation({
    mutationFn: (id: string) => api.delete(`/epics/${epicId}/features/${id}`),
    onSuccess: invalidate,
  })

  const toggle = (id: string) =>
    setExpandedIds(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n })

  return (
    <div ref={setNodeRef} className="ml-4 mt-1 space-y-1">
      {applyTemplateFeatureId && (
        <ApplyTemplateModal
          featureId={applyTemplateFeatureId}
          projectId={projectId}
          onClose={() => setApplyTemplateFeatureId(null)}
        />
      )}
      <SortableContext items={features.map(f => 'feature-' + f.id)} strategy={verticalListSortingStrategy}>
        {features.map(feature => (
          <SortableFeatureItem
            key={feature.id}
            feature={feature}
            isEditing={editingId === feature.id}
            expanded={expandedIds.has(feature.id)}
            onToggle={() => toggle(feature.id)}
            onEdit={() => setEditingId(feature.id)}
            onCancelEdit={() => setEditingId(null)}
            onSave={(data) => updateFeature.mutate({ id: feature.id, data })}
            onDelete={() => deleteFeature.mutate(feature.id)}
            onToggleActive={() => toggleFeatureActive.mutate({ id: feature.id, isActive: feature.isActive !== false ? false : true })}
            onToggleFeatureMode={() => toggleFeatureMode.mutate({ id: feature.id, featureMode: feature.featureMode === 'parallel' ? 'sequential' : 'parallel' })}
            isSaving={updateFeature.isPending}
            onApplyTemplate={() => setApplyTemplateFeatureId(feature.id)}
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
        ))}
      </SortableContext>

      {adding ? (
        <InlineForm
          label="Feature"
          initial={form}
          onSave={(data) => createFeature.mutate(data)}
          onCancel={() => setAdding(false)}
          saving={createFeature.isPending}
        />
      ) : (
        <button onClick={() => setAdding(true)} className="text-xs text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-400 flex items-center gap-1 py-1 pl-1 ml-2">
          + Add feature
        </button>
      )}
    </div>
  )
}

function InlineForm({ label, initial, onSave, onCancel, saving }: {
  label: string
  initial: { name: string; description: string; assumptions: string }
  onSave: (data: typeof initial) => void
  onCancel: () => void
  saving: boolean
}) {
  const [form, setForm] = useState(initial)

  return (
    <div className="bg-white dark:bg-gray-800 border border-blue-200 dark:border-blue-800 rounded-lg px-3 py-2 space-y-2">
      <input placeholder={`${label} name *`} value={form.name} onChange={e => setForm(v => ({ ...v, name: e.target.value }))}
        className="w-full border border-gray-200 dark:border-gray-600 rounded px-2 py-1 text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-400 focus:outline-none focus:ring-1 focus:ring-blue-400" />
      <RichTextEditor
        value={form.description}
        onChange={v => setForm(prev => ({ ...prev, description: v }))}
        placeholder="Description"
        className="text-sm"
      />
      <RichTextEditor
        value={form.assumptions}
        onChange={v => setForm(prev => ({ ...prev, assumptions: v }))}
        placeholder="Assumptions"
        className="text-sm"
      />
      <div className="flex gap-2">
        <button onClick={() => onSave(form)} disabled={!form.name || saving}
          className="bg-lab3-navy text-white px-3 py-1 rounded text-xs font-medium hover:bg-lab3-blue disabled:opacity-50">
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button onClick={onCancel} className="px-3 py-1 rounded text-xs text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700">Cancel</button>
      </div>
    </div>
  )
}
