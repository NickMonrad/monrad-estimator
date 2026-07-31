import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { api, apiErrorMessage } from '../lib/api'
import { invalidateProjectResourceProfile } from '../lib/projectInvalidation'
import type { NamedResourceEntry, OverheadItem } from '../types/backlog'

type OverheadType = 'PERCENTAGE' | 'FIXED_DAYS' | 'DAYS_PER_WEEK'

export const TYPE_OPTIONS: Array<{ label: string; value: OverheadType }> = [
  { label: '% of task days', value: 'PERCENTAGE' },
  { label: 'Fixed days per week', value: 'FIXED_DAYS' },
  { label: 'Days per week', value: 'DAYS_PER_WEEK' },
]

export { type OverheadType }

/**
 * Resource Profile mutations: resource types, named resources, overheads.
 * Owns form state and CRUD operations for overhead items.
 */
export interface ResourceProfileMutations {
  expandedRows: Set<string>; setExpandedRows: React.Dispatch<React.SetStateAction<Set<string>>>
  expandedNamedResources: Set<string>; setExpandedNamedResources: React.Dispatch<React.SetStateAction<Set<string>>>
  editingId: string | null; setEditingId: React.Dispatch<React.SetStateAction<string | null>>
  formError: string | null; setFormError: React.Dispatch<React.SetStateAction<string | null>>
  profileMutationError: string | null; clearProfileMutationError: () => void
  form: { name: string; resourceTypeId: string; type: OverheadType; value: string }; setForm: React.Dispatch<React.SetStateAction<{ name: string; resourceTypeId: string; type: OverheadType; value: string }>>
  toggleRow: (rtId: string) => void
  toggleNamedResources: (rtId: string) => void
  resetForm: () => void
  invalidateProfile: () => void
  updateResourceType: ReturnType<typeof useMutation>
  addPerson: ReturnType<typeof useMutation>
  removeLastPerson: ReturnType<typeof useMutation>
  createOverhead: ReturnType<typeof useMutation>
  updateOverhead: ReturnType<typeof useMutation>
  deleteOverhead: ReturnType<typeof useMutation>
  handleFormSubmit: () => void
  handleEdit: (item: OverheadItem) => void
  handleDelete: (id: string) => void
}

export function useResourceProfileMutations(projectId: string | undefined) {
  const qc = useQueryClient()
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set())
  const [expandedNamedResources, setExpandedNamedResources] = useState<Set<string>>(new Set())
  const [editingId, setEditingId] = useState<string | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  // Surface actionable conflicts (e.g. 409 PLANNER_MANAGED_IDENTITY) from
  // count/add/remove mutations instead of failing silently.
  const [profileMutationError, setProfileMutationError] = useState<string | null>(null)
  const clearProfileMutationError = () => setProfileMutationError(null)
  const [form, setForm] = useState({
    name: '',
    resourceTypeId: '',
    type: 'PERCENTAGE' as OverheadType,
    value: '',
  })

  const toggleRow = (rtId: string) => {
    setExpandedRows(prev => {
      const next = new Set(prev)
      next.has(rtId) ? next.delete(rtId) : next.add(rtId)
      return next
    })
  }

  const toggleNamedResources = (rtId: string) => {
    setExpandedNamedResources(prev => {
      const next = new Set(prev)
      next.has(rtId) ? next.delete(rtId) : next.add(rtId)
      return next
    })
  }

  const resetForm = () => {
    setForm({ name: '', resourceTypeId: '', type: 'PERCENTAGE', value: '' })
    setEditingId(null)
    setFormError(null)
  }

  const invalidateProfile = () => {
    invalidateProjectResourceProfile(qc, projectId)
  }

  const updateResourceType = useMutation({
    mutationFn: ({ id, ...data }: { id: string; count?: number; hoursPerDay?: number | null; dayRate?: number | null }) =>
      api.put(`/projects/${projectId}/resource-types/${id}`, data).then(r => r.data),
    onSuccess: () => {
      setProfileMutationError(null)
      invalidateProjectResourceProfile(qc, projectId)
    },
    onError: (err) => setProfileMutationError(apiErrorMessage(err, 'Failed to update resource type')),
  })

  const addPerson = useMutation({
    mutationFn: (rtId: string) =>
      api.post(`/projects/${projectId}/resource-types/${rtId}/named-resources`, {
        name: 'New person',
      }).then(r => r.data),
    onSuccess: (_data, rtId) => {
      setProfileMutationError(null)
      invalidateProjectResourceProfile(qc, projectId)
      qc.invalidateQueries({ queryKey: ['named-resources', projectId, rtId] })
      setExpandedNamedResources(prev => new Set([...prev, rtId]))
    },
    onError: (err) => setProfileMutationError(apiErrorMessage(err, 'Failed to add named resource')),
  })

  const removeLastPerson = useMutation({
    mutationFn: async (rtId: string) => {
      const res = await api.get(`/projects/${projectId}/resource-types/${rtId}/named-resources`)
      const resources = res.data as NamedResourceEntry[]
      if (resources.length > 0) {
        await api.delete(`/projects/${projectId}/resource-types/${rtId}/named-resources/${resources[resources.length - 1].id}`)
      }
    },
    onSuccess: (_data, rtId) => {
      setProfileMutationError(null)
      invalidateProjectResourceProfile(qc, projectId)
      qc.invalidateQueries({ queryKey: ['named-resources', projectId, rtId] })
    },
    onError: (err) => setProfileMutationError(apiErrorMessage(err, 'Failed to remove named resource')),
  })

  const createOverhead = useMutation({
    mutationFn: (data: { name: string; resourceTypeId: string | null; type: OverheadType; value: number }) =>
      api.post(`/projects/${projectId}/overhead`, data).then(r => r.data),
    onSuccess: () => {
      invalidateProfile()
      resetForm()
    },
  })

  const updateOverhead = useMutation({
    mutationFn: ({ id, ...data }: { id: string; name?: string; resourceTypeId?: string | null; type?: OverheadType; value?: number }) =>
      api.put(`/projects/${projectId}/overhead/${id}`, data).then(r => r.data),
    onSuccess: () => {
      invalidateProfile()
      resetForm()
    },
  })

  const deleteOverhead = useMutation({
    mutationFn: (id: string) => api.delete(`/projects/${projectId}/overhead/${id}`),
    onSuccess: () => invalidateProfile(),
  })

  const handleFormSubmit = () => {
    if (!form.name.trim()) {
      setFormError('Name is required')
      return
    }
    const numericValue = parseFloat(form.value)
    if (Number.isNaN(numericValue) || numericValue < 0) {
      setFormError('Value must be a non-negative number')
      return
    }
    setFormError(null)
    const payload = {
      name: form.name.trim(),
      resourceTypeId: form.resourceTypeId || null,
      type: form.type,
      value: numericValue,
    }
    if (editingId) {
      updateOverhead.mutate({ id: editingId, ...payload })
    } else {
      createOverhead.mutate(payload)
    }
  }

  const handleEdit = (item: OverheadItem) => {
    setEditingId(item.id)
    setForm({
      name: item.name,
      resourceTypeId: item.resourceTypeId ?? '',
      type: item.type,
      value: String(item.value),
    })
    setFormError(null)
  }

  const handleDelete = (id: string) => {
    if (!confirm('Delete this overhead item?')) return
    deleteOverhead.mutate(id)
  }

  return {
    expandedRows, setExpandedRows,
    expandedNamedResources, setExpandedNamedResources,
    editingId, setEditingId,
    formError, setFormError,
    profileMutationError, clearProfileMutationError,
    form, setForm,
    toggleRow, toggleNamedResources,
    resetForm, invalidateProfile,
    updateResourceType,
    addPerson, removeLastPerson,
    createOverhead, updateOverhead, deleteOverhead,
    handleFormSubmit, handleEdit, handleDelete,
  }
}
