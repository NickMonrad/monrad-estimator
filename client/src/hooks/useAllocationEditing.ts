import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/api'
import { invalidateProjectResourceProfile } from '../lib/projectInvalidation'
import { formatAllocationMode } from '../lib/capacityProfileFormatting'
import type { ResourceProfile } from '../types/backlog'
import type { CommercialRow } from '../utils/financialCalculations'

export interface AllocationEditingState {
  editingAllocation: string | null
  setEditingAllocation: React.Dispatch<React.SetStateAction<string | null>>
  allocationDraft: { allocationMode: string; allocationPercent: number; allocationStartWeek: number | null; allocationEndWeek: number | null } | null
  setAllocationDraft: React.Dispatch<React.SetStateAction<{ allocationMode: string; allocationPercent: number; allocationStartWeek: number | null; allocationEndWeek: number | null } | null>>
  updateAllocationMutation: ReturnType<typeof useMutation>
  updateNrAllocationMutation: ReturnType<typeof useMutation>
  startEditAllocation: (row: CommercialRow) => void
  getAllocationBadge: (row: CommercialRow, profile: ResourceProfile | undefined) => { label: string; color: string; sub: string | null }
}

export function useAllocationEditing(projectId: string | undefined) {
  const qc = useQueryClient()
  const [editingAllocation, setEditingAllocation] = useState<string | null>(null)
  const [allocationDraft, setAllocationDraft] = useState<{
    allocationMode: string
    allocationPercent: number
    allocationStartWeek: number | null
    allocationEndWeek: number | null
  } | null>(null)

  const updateAllocationMutation = useMutation({
    mutationFn: ({ rtId, data }: { rtId: string; data: object }) =>
      api.put(`/projects/${projectId}/resource-types/${rtId}`, data).then(r => r.data),
    onSuccess: () => {
      invalidateProjectResourceProfile(qc, projectId)
      setEditingAllocation(null)
      setAllocationDraft(null)
    },
  })

  const updateNrAllocationMutation = useMutation({
    mutationFn: ({ rtId, nrId, data }: { rtId: string; nrId: string; data: object }) =>
      api.patch(`/projects/${projectId}/resource-types/${rtId}/named-resources/${nrId}`, data).then(r => r.data),
    onSuccess: () => {
      invalidateProjectResourceProfile(qc, projectId)
      setEditingAllocation(null)
      setAllocationDraft(null)
    },
  })

  const startEditAllocation = (row: CommercialRow) => {
    setEditingAllocation(row.id)
    setAllocationDraft({
      allocationMode: row.allocationMode,
      allocationPercent: row.allocationPercent,
      allocationStartWeek: row.allocationStartWeek,
      allocationEndWeek: row.allocationEndWeek,
    })
  }

  const getAllocationBadge = (row: CommercialRow, profile: ResourceProfile | undefined) => {
    const mode = row.allocationMode ?? 'FULL_PROJECT'
    if (mode === 'AGGREGATE') {
      return { label: 'Named resources: mixed modes', color: 'bg-gray-100 text-gray-400', sub: null as string | null }
    }
    if (mode === 'EFFORT') {
      return { label: formatAllocationMode(mode), color: 'bg-gray-100 text-gray-600', sub: null }
    }
    if (mode === 'TIMELINE') {
      const effectiveStart = row.allocationStartWeek ?? row.derivedStartWeek
      const effectiveEnd = row.allocationEndWeek ?? row.derivedEndWeek
      const sub = effectiveStart != null && effectiveEnd != null
        ? `Wk ${Math.floor(effectiveStart)} → Wk ${Math.floor(effectiveEnd)}`
        : null
      return {
        label: `${formatAllocationMode(mode)} · ${row.allocationPercent}%`,
        color: 'bg-blue-100 text-blue-700',
        sub,
      }
    }
    if (mode === 'CAPACITY_PLAN') {
      return { label: formatAllocationMode(mode), color: 'bg-green-100 text-green-700', sub: null }
    }
    // FULL_PROJECT default
    const dur = profile?.projectDurationWeeks
    const sub = dur != null ? `Wk 0 → Wk ${Math.floor(dur)}` : null
    return {
      label: `${formatAllocationMode(mode)} · ${row.allocationPercent}%`,
      color: 'bg-purple-100 text-purple-700',
      sub,
    }
  }

  return {
    editingAllocation, setEditingAllocation,
    allocationDraft, setAllocationDraft,
    updateAllocationMutation,
    updateNrAllocationMutation,
    startEditAllocation,
    getAllocationBadge,
  }
}
