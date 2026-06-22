import { useState, useEffect, useMemo } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import JSZip from 'jszip'
import { api } from '../lib/api'
import type {
  Project,
  ResourceProfile,
  ResourceType,
  NamedResourceEntry,
  OverheadItem,
  ProjectDiscount,
  RateCard,
} from '../types/backlog'
import { computeCommercialData, type CommercialRow } from '../utils/financialCalculations'

type OverheadType = 'PERCENTAGE' | 'FIXED_DAYS' | 'DAYS_PER_WEEK'
export const TYPE_OPTIONS: Array<{ label: string; value: OverheadType }> = [
  { label: '% of task days', value: 'PERCENTAGE' },
  { label: 'Fixed total days', value: 'FIXED_DAYS' },
  { label: 'Days per week', value: 'DAYS_PER_WEEK' },
]

export const formatNumber = (value: number, fractionDigits = 2) =>
  value.toLocaleString(undefined, { minimumFractionDigits: fractionDigits, maximumFractionDigits: fractionDigits })

export { type CommercialRow, type OverheadType }

const asciiSafe = (value: string) => value
  .replace(/[–—]/g, '-')
  .replace(/×/g, 'x')

export const toCsvValue = (value: string | number | null | undefined) => {
  if (value === null || value === undefined) return ''
  const str = asciiSafe(typeof value === 'number' ? value.toString() : value)
  if (/[",\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`
  }
  return str
}

function formatWeekLabel(week: number) {
  return `W${week + 1}`
}

function formatNamedResourceSegments(namedResource: NonNullable<ResourceProfile['resourceRows'][number]['namedResources']>[number]) {
  const segments = namedResource.actualAllocationSegments ?? []
  if (segments.length === 0) return ''
  return segments
    .map(segment => (
      segment.startWeek === segment.endWeek
        ? `${formatWeekLabel(segment.startWeek)} (${segment.days.toFixed(2)}d)`
        : `${formatWeekLabel(segment.startWeek)}-${formatWeekLabel(segment.endWeek)} (${segment.days.toFixed(2)}d)`
    ))
    .join('; ')
}

function formatNamedResourceWeeks(namedResource: NonNullable<ResourceProfile['resourceRows'][number]['namedResources']>[number]) {
  const weeks = namedResource.actualAllocatedWeeks ?? []
  return weeks
    .map(week => `${formatWeekLabel(week.week)}=${week.days.toFixed(2)}`)
    .join('; ')
}

export const buildProfileCsv = (profileData: ResourceProfile) => {
  const rows: Array<Array<string | number>> = [[
    'Section',
    'Role',
    'NamedResource',
    'SyntheticSlot',
    'Category',
    'Count',
    'HoursPerDay',
    'RoleDays',
    'PlannedDays',
    'AssignedDays',
    'DayRate',
    'Cost',
    'AvailabilityStartWeek',
    'AvailabilityEndWeek',
    'AssignedStartWeek',
    'AssignedEndWeek',
    'AssignedSpans',
    'WeekAllocations',
    'Billing basis',
  ]]

  profileData.resourceRows.forEach(row => {
    if (row.namedResources && row.namedResources.length > 0) {
      row.namedResources.forEach(namedResource => {
        rows.push([
          'Resource',
          row.name,
          namedResource.name,
          namedResource.synthetic ? 'Yes' : 'No',
          row.category,
          row.count,
          row.hoursPerDay,
          row.effortDays,
          namedResource.allocatedDays,
          namedResource.actualAllocatedDays,
          row.dayRate ?? '',
          row.dayRate != null ? (namedResource.actualAllocatedDays * row.dayRate).toFixed(2) : '',
          namedResource.startWeek != null ? formatWeekLabel(namedResource.startWeek) : '',
          namedResource.endWeek != null ? formatWeekLabel(namedResource.endWeek) : '',
          namedResource.actualAllocationStartWeek != null ? formatWeekLabel(namedResource.actualAllocationStartWeek) : '',
          namedResource.actualAllocationEndWeek != null ? formatWeekLabel(namedResource.actualAllocationEndWeek) : '',
          formatNamedResourceSegments(namedResource),
          formatNamedResourceWeeks(namedResource),
          namedResource.pricingModel === 'PRO_RATA' ? 'Planned allocation' : 'Actual scheduled days',
        ])
      })
      return
    }

    rows.push([
      'Resource',
      row.name,
      '',
      '',
      row.category,
      row.count,
      row.hoursPerDay,
      row.effortDays,
      row.totalDays,
      row.allocatedDays,
      row.dayRate ?? '',
      row.estimatedCost ?? '',
      row.allocationStartWeek != null ? formatWeekLabel(row.allocationStartWeek) : '',
      row.allocationEndWeek != null ? formatWeekLabel(row.allocationEndWeek) : '',
      '',
      '',
      '',
      '',
      '',
    ])
  })

  profileData.overheadRows.forEach(row => {
    const description = row.type === 'PERCENTAGE'
      ? `${row.value}% of task days`
      : row.type === 'DAYS_PER_WEEK'
        ? `${row.value} days/week x ${profileData.projectDurationWeeks} weeks`
        : `${row.value} fixed days`
    rows.push([
      'Overhead',
      row.name,
      '',
      '',
      'Overhead',
      '',
      '',
      row.computedDays,
      row.computedDays,
      row.computedDays,
      row.dayRate ?? '',
      row.estimatedCost ?? '',
      '',
      '',
      '',
      '',
      description,
      '',
      '',
    ])
  })

  rows.push([
    'Summary',
    'Total',
    '',
    '',
    '',
    '',
    '',
    profileData.summary.totalDays,
    profileData.summary.totalDays,
    profileData.summary.totalDays,
    '',
    profileData.summary.totalCost ?? '',
    '',
    '',
    '',
    '',
    '',
    '',
    '',
  ])

  return rows.map(row => row.map(toCsvValue).join(',')).join('\n')
}

/**
 * All data-fetching, state management, mutations, and business-logic handlers
 * for the Resource Profile page — extracted from ResourceProfilePage.tsx.
 */
export function useResourceProfile() {
  const { id: projectId } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const qc = useQueryClient()

  const { data: project } = useQuery<Project>({
    queryKey: ['project', projectId],
    queryFn: () => api.get(`/projects/${projectId}`).then(r => r.data),
  })

  const { data: profile, isLoading: profileLoading } = useQuery<ResourceProfile>({
    queryKey: ['resource-profile', projectId],
    queryFn: () => api.get(`/projects/${projectId}/resource-profile`).then(r => r.data),
    enabled: !!projectId,
  })

  const { data: overheadItems = [] } = useQuery<OverheadItem[]>({
    queryKey: ['overheads', projectId],
    queryFn: () => api.get(`/projects/${projectId}/overhead`).then(r => r.data),
    enabled: !!projectId,
  })

  const { data: resourceTypes = [] } = useQuery<ResourceType[]>({
    queryKey: ['resource-types', projectId],
    queryFn: () => api.get(`/projects/${projectId}/resource-types`).then(r => r.data),
    enabled: !!projectId,
  })

  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set())
  const [expandedNamedResources, setExpandedNamedResources] = useState<Set<string>>(new Set())
  const [editingId, setEditingId] = useState<string | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [form, setForm] = useState({
    name: '',
    resourceTypeId: '',
    type: 'PERCENTAGE' as OverheadType,
    value: '',
  })

  // ── Buffer / onboarding weeks ──
  const [bufferWeeks, setBufferWeeks] = useState(0)
  const [onboardingWeeks, setOnboardingWeeks] = useState(0)

  useEffect(() => {
    if (profile != null) {
      setBufferWeeks(profile.bufferWeeks ?? 0)
      setOnboardingWeeks(profile.onboardingWeeks ?? 0)
    }
  }, [profile?.bufferWeeks, profile?.onboardingWeeks])

  // ── Tab state ──
  type TabKey = 'profile' | 'commercial'
  const [activeTab, setActiveTab] = useState<TabKey>('profile')

  // ── Commercial tab state ──
  const [showDiscountForm, setShowDiscountForm] = useState(false)
  const [discountForm, setDiscountForm] = useState({ label: '', type: 'PERCENTAGE' as 'PERCENTAGE' | 'FIXED_AMOUNT', value: '' })
  const [discountFormError, setDiscountFormError] = useState<string | null>(null)
  const [selectedRateCardId, setSelectedRateCardId] = useState('')
  const [rateCardResult, setRateCardResult] = useState<{ updated: number; skipped: number } | null>(null)
  const [editingTaxLabel, setEditingTaxLabel] = useState(false)
  const [taxLabelDraft, setTaxLabelDraft] = useState('')
  const [editingTaxRate, setEditingTaxRate] = useState(false)
  const [taxRateDraft, setTaxRateDraft] = useState('')
  const [editingAllocation, setEditingAllocation] = useState<string | null>(null)  // resourceTypeId
  const [allocationDraft, setAllocationDraft] = useState<{
    allocationMode: string
    allocationPercent: number
    allocationStartWeek: number | null
    allocationEndWeek: number | null
  } | null>(null)

  // ── Commercial data queries ──
  const { data: discounts = [] } = useQuery<ProjectDiscount[]>({
    queryKey: ['discounts', projectId],
    queryFn: () => api.get(`/projects/${projectId}/discounts`).then(r => r.data),
    enabled: !!projectId && activeTab === 'commercial',
  })

  const { data: rateCards = [] } = useQuery<RateCard[]>({
    queryKey: ['rate-cards'],
    queryFn: () => api.get('/rate-cards').then(r => r.data),
    enabled: activeTab === 'commercial',
  })

  // ── Commercial mutations ──
  const createDiscount = useMutation({
    mutationFn: (data: { label: string; type: string; value: number }) =>
      api.post(`/projects/${projectId}/discounts`, data).then(r => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['discounts', projectId] })
      setShowDiscountForm(false)
      setDiscountForm({ label: '', type: 'PERCENTAGE', value: '' })
      setDiscountFormError(null)
    },
  })

  const deleteDiscount = useMutation({
    mutationFn: (id: string) => api.delete(`/projects/${projectId}/discounts/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['discounts', projectId] }),
  })

  const updateTax = useMutation({
    mutationFn: (data: { taxRate?: number | null; taxLabel?: string }) =>
      api.patch(`/projects/${projectId}/tax`, data).then(r => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['project', projectId] })
    },
  })

  const applyRateCard = useMutation({
    mutationFn: (rateCardId: string) =>
      api.post(`/projects/${projectId}/apply-rate-card`, { rateCardId }).then(r => r.data),
    onSuccess: (data: { updated: number; skipped: number }) => {
      setRateCardResult(data)
      qc.invalidateQueries({ queryKey: ['resource-profile', projectId] })
      qc.invalidateQueries({ queryKey: ['resource-types', projectId] })
    },
  })

  const hasCost = profile?.summary.hasCost ?? false
  const columnCount = hasCost ? 9 : 8

  const weekToDate = (weekNum: number | null | undefined): Date | null => {
    if (weekNum == null || !project?.startDate) return null
    const d = new Date(project.startDate)
    d.setDate(d.getDate() + Math.round(weekNum * 7))
    return d
  }
  const fmtDate = (d: Date | null): string => {
    if (!d) return ''
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
  }

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
    qc.invalidateQueries({ queryKey: ['resource-profile', projectId] })
    qc.invalidateQueries({ queryKey: ['overheads', projectId] })
  }

  const updateResourceType = useMutation({
    mutationFn: ({ id, ...data }: { id: string; count?: number; hoursPerDay?: number | null; dayRate?: number | null }) =>
      api.put(`/projects/${projectId}/resource-types/${id}`, data).then(r => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['resource-profile', projectId] })
      qc.invalidateQueries({ queryKey: ['resource-types', projectId] })
    },
  })

  const updateAllocationMutation = useMutation({
    mutationFn: ({ rtId, data }: { rtId: string; data: object }) =>
      api.put(`/projects/${projectId}/resource-types/${rtId}`, data).then(r => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['resource-profile', projectId] })
      qc.invalidateQueries({ queryKey: ['resource-types', projectId] })
      setEditingAllocation(null)
      setAllocationDraft(null)
    },
  })

  const updateNrAllocationMutation = useMutation({
    mutationFn: ({ rtId, nrId, data }: { rtId: string; nrId: string; data: object }) =>
      api.patch(`/projects/${projectId}/resource-types/${rtId}/named-resources/${nrId}`, data).then(r => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['resource-profile', projectId] })
      qc.invalidateQueries({ queryKey: ['resource-types', projectId] })
      setEditingAllocation(null)
      setAllocationDraft(null)
    },
  })

  const addPerson = useMutation({
    mutationFn: (rtId: string) =>
      api.post(`/projects/${projectId}/resource-types/${rtId}/named-resources`, {
        name: 'New person',
      }).then(r => r.data),
    onSuccess: (_data, rtId) => {
      qc.invalidateQueries({ queryKey: ['resource-profile', projectId] })
      qc.invalidateQueries({ queryKey: ['resource-types', projectId] })
      qc.invalidateQueries({ queryKey: ['named-resources', projectId, rtId] })
      // Auto-expand named resources panel so the user sees the people
      setExpandedNamedResources(prev => new Set([...prev, rtId]))
    },
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
      qc.invalidateQueries({ queryKey: ['resource-profile', projectId] })
      qc.invalidateQueries({ queryKey: ['resource-types', projectId] })
      qc.invalidateQueries({ queryKey: ['named-resources', projectId, rtId] })
    },
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

  const slugify = (text: string) =>
    (text || 'project')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'project'

  const createCsvBlob = (csv: string) => new Blob([csv], { type: 'text/csv;charset=utf-8' })

  const downloadBlob = (blob: Blob, filename: string) => {
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    a.click()
    URL.revokeObjectURL(url)
  }

  const handleExportProfile = () => {
    if (!profile) return
    const csv = buildProfileCsv(profile)
    const blob = createCsvBlob(csv)
    const safeName = slugify(project?.name ?? 'project')
    downloadBlob(blob, `${safeName}-resource-profile.csv`)
  }

  const handleExportFull = async () => {
    if (!profile || !projectId) return
    try {
      const csv = buildProfileCsv(profile)
      const safeName = slugify(project?.name ?? 'project')
      const zip = new JSZip()
      zip.file(`${safeName}-resource-profile.csv`, csv)
      const [backlogRes, timelineRes] = await Promise.all([
        api.get(`/projects/${projectId}/backlog/export-csv`, { responseType: 'blob' }),
        api.get(`/projects/${projectId}/timeline/export/csv`, { responseType: 'blob' }),
      ])
      zip.file(`${safeName}-backlog.csv`, backlogRes.data)
      zip.file(`${safeName}-timeline.csv`, timelineRes.data)
      const blob = await zip.generateAsync({ type: 'blob' })
      downloadBlob(blob, `${safeName}-project-export.zip`)
    } catch (err) {
      console.error(err)
      alert('Failed to export project data. Please try again.')
    }
  }

  const chartData = useMemo(() => {
    if (!profile) return []
    const data: Array<{ name: string; taskDays: number; overheadDays: number }> = [
      ...profile.resourceRows.map(row => ({
        name: row.name,
        taskDays: row.totalDays,
        overheadDays: 0,
      })),
      ...profile.overheadRows.map(row => ({
        name: row.name,
        taskDays: 0,
        overheadDays: row.computedDays,
      })),
    ]
    return data
  }, [profile])

  // ── Filter resource rows: only show allocated ones ──
  const filteredResourceRows = useMemo(() => {
    if (!profile) return []
    const overheadLinkedRtIds = new Set(
      profile.overheadRows
        .filter(r => r.resourceTypeId)
        .map(r => r.resourceTypeId!)
    )
    return profile.resourceRows.filter(
      row => row.totalHours > 0 || row.totalDays > 0 || overheadLinkedRtIds.has(row.resourceTypeId)
    )
  }, [profile])

  // ── Commercial cost computation (see utils/financialCalculations.ts) ──
  const commercialData = useMemo(() => {
    return computeCommercialData(profile, discounts, project)
  }, [profile, discounts, project])

  const handleDiscountSubmit = () => {
    if (!discountForm.label.trim()) {
      setDiscountFormError('Label is required')
      return
    }
    const numericValue = parseFloat(discountForm.value)
    if (Number.isNaN(numericValue) || numericValue <= 0) {
      setDiscountFormError('Value must be a positive number')
      return
    }
    setDiscountFormError(null)
    createDiscount.mutate({ label: discountForm.label.trim(), type: discountForm.type, value: numericValue })
  }

  const handleApplyRateCard = () => {
    if (!selectedRateCardId) return
    if (!confirm('Apply this rate card? Existing day rates will be overwritten for matching resource types.')) return
    setRateCardResult(null)
    applyRateCard.mutate(selectedRateCardId)
  }


  const startEditAllocation = (row: CommercialRow) => {
    setEditingAllocation(row.id)
    setAllocationDraft({
      allocationMode: row.allocationMode,
      allocationPercent: row.allocationPercent,
      allocationStartWeek: row.allocationStartWeek,
      allocationEndWeek: row.allocationEndWeek,
    })
  }

  const getAllocationBadge = (row: CommercialRow) => {
    if (row.allocationMode === 'AGGREGATE') {
      return { label: 'Aggregate', color: 'bg-gray-100 text-gray-400', sub: null }
    } else if (row.allocationMode === 'EFFORT') {
      return { label: 'T&M', color: 'bg-gray-100 text-gray-600', sub: null }
    } else if (row.allocationMode === 'TIMELINE') {
      const effectiveStart = row.allocationStartWeek ?? row.derivedStartWeek
      const effectiveEnd = row.allocationEndWeek ?? row.derivedEndWeek
      const sub = effectiveStart != null && effectiveEnd != null
        ? `Wk ${Math.floor(effectiveStart)} → Wk ${Math.floor(effectiveEnd)}`
        : null
      return {
        label: `Timeline · ${row.allocationPercent}%`,
        color: 'bg-blue-100 text-blue-700',
        sub,
      }
    } else if (row.allocationMode === 'CAPACITY_PLAN') {
      return { label: 'Capacity Plan', color: 'bg-green-100 text-green-700', sub: null }
    } else {
      const dur = profile?.projectDurationWeeks
      const sub = dur != null ? `Wk 0 → Wk ${Math.floor(dur)}` : null
      return {
        label: `Full Project · ${row.allocationPercent}%`,
        color: 'bg-purple-100 text-purple-700',
        sub,
      }
    }
  }


  return {
    projectId, navigate, qc,
    project, profile, profileLoading, overheadItems, resourceTypes,
    discounts, rateCards,
    expandedRows, setExpandedRows,
    expandedNamedResources, setExpandedNamedResources,
    editingId, setEditingId,
    formError, setFormError,
    form, setForm,
    bufferWeeks, onboardingWeeks,
    activeTab, setActiveTab,
    showDiscountForm, setShowDiscountForm,
    discountForm, setDiscountForm,
    discountFormError, setDiscountFormError,
    selectedRateCardId, setSelectedRateCardId,
    rateCardResult,
    editingTaxLabel, setEditingTaxLabel,
    taxLabelDraft, setTaxLabelDraft,
    editingTaxRate, setEditingTaxRate,
    taxRateDraft, setTaxRateDraft,
    editingAllocation, setEditingAllocation,
    allocationDraft, setAllocationDraft,
    hasCost, columnCount, chartData, filteredResourceRows, commercialData,
    createDiscount, deleteDiscount, updateTax, applyRateCard,
    updateResourceType, updateAllocationMutation, updateNrAllocationMutation,
    addPerson, removeLastPerson,
    createOverhead, updateOverhead, deleteOverhead,
    handleFormSubmit, handleEdit, handleDelete,
    resetForm,
    slugify, toCsvValue, buildProfileCsv, createCsvBlob, downloadBlob,
    handleExportProfile, handleExportFull,
    handleDiscountSubmit, handleApplyRateCard,
    startEditAllocation, getAllocationBadge,
    toggleRow, toggleNamedResources,
    weekToDate, fmtDate, formatNumber,
  }
}

export type ResourceProfileState = ReturnType<typeof useResourceProfile>
export type UseResourceProfileReturn = ResourceProfileState
