import { Fragment, useMemo, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import JSZip from 'jszip'
import {
  ResponsiveContainer,
  BarChart,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  Bar,
  CartesianGrid,
} from 'recharts'
import { api } from '../lib/api'
import { useAuth } from '../hooks/useAuth'
import type {
  Project,
  ResourceProfile,
  ResourceType,
  OverheadItem,
  ProjectDiscount,
  RateCard,
} from '../types/backlog'

type OverheadType = 'PERCENTAGE' | 'FIXED_DAYS' | 'DAYS_PER_WEEK'
const TYPE_OPTIONS: Array<{ label: string; value: OverheadType }> = [
  { label: '% of task days', value: 'PERCENTAGE' },
  { label: 'Fixed total days', value: 'FIXED_DAYS' },
  { label: 'Days per week', value: 'DAYS_PER_WEEK' },
]

const formatNumber = (value: number, fractionDigits = 2) =>
  value.toLocaleString(undefined, { minimumFractionDigits: fractionDigits, maximumFractionDigits: fractionDigits })

type PricingModel = 'ACTUAL_DAYS' | 'PRO_RATA'

interface NamedResource {
  id: string
  resourceTypeId: string
  name: string
  startWeek: number | null
  endWeek: number | null
  allocationPct: number
  pricingModel: PricingModel
  createdAt: string
  updatedAt: string
}

function NamedResourcesPanel({
  projectId,
  rtId,
  rtCount,
  columnCount,
}: {
  projectId: string
  rtId: string
  rtCount: number
  columnCount: number
}) {
  const qc = useQueryClient()

  const { data: resources = [], isLoading } = useQuery<NamedResource[]>({
    queryKey: ['named-resources', projectId, rtId],
    queryFn: () =>
      api
        .get(`/projects/${projectId}/resource-types/${rtId}/named-resources`)
        .then((r) => r.data),
  })

  const createResource = useMutation({
    mutationFn: () =>
      api
        .post(`/projects/${projectId}/resource-types/${rtId}/named-resources`, {
          name: 'New person',
        })
        .then((r) => r.data),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ['named-resources', projectId, rtId] }),
  })

  const updateResource = useMutation({
    mutationFn: ({
      id,
      ...data
    }: {
      id: string
      name?: string
      startWeek?: number | null
      endWeek?: number | null
      allocationPct?: number
      pricingModel?: string
    }) =>
      api
        .put(
          `/projects/${projectId}/resource-types/${rtId}/named-resources/${id}`,
          data,
        )
        .then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['named-resources', projectId, rtId] })
      qc.invalidateQueries({ queryKey: ['resource-profile', projectId] })
      qc.invalidateQueries({ queryKey: ['resource-types', projectId] })
    },
  })

  const deleteResource = useMutation({
    mutationFn: (id: string) =>
      api.delete(
        `/projects/${projectId}/resource-types/${rtId}/named-resources/${id}`,
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['named-resources', projectId, rtId] })
      qc.invalidateQueries({ queryKey: ['resource-profile', projectId] })
      qc.invalidateQueries({ queryKey: ['resource-types', projectId] })
    },
  })

  return (
    <tr>
      <td colSpan={columnCount} className="px-10 py-4 bg-gray-50 border-b border-gray-100">
        <div className="space-y-3">
          <h4 className="text-xs font-semibold text-gray-600 uppercase tracking-wide">
            Named Resources
          </h4>

          {isLoading ? (
            <p className="text-sm text-gray-400">Loading…</p>
          ) : resources.length === 0 ? (
            <p className="text-sm text-gray-500">
              No named resources — using aggregate count ({rtCount})
            </p>
          ) : (
            <div className="space-y-0.5">
              <div className="grid grid-cols-[1fr_110px_110px_80px_140px_28px] gap-2 text-xs font-medium text-gray-500 px-2 py-1">
                <span>Name</span>
                <span>Start Week</span>
                <span>End Week</span>
                <span>Alloc %</span>
                <span>Pricing</span>
                <span />
              </div>
              {resources.map((r) => (
                <div
                  key={r.id}
                  className="grid grid-cols-[1fr_110px_110px_80px_140px_28px] gap-2 items-center px-2 py-0.5 rounded hover:bg-gray-100"
                >
                  <input
                    type="text"
                    defaultValue={r.name}
                    onBlur={(e) => {
                      const val = e.target.value.trim()
                      if (val && val !== r.name)
                        updateResource.mutate({ id: r.id, name: val })
                    }}
                    className="border border-gray-200 rounded px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-red-400 w-full"
                  />
                  <input
                    type="number"
                    defaultValue={r.startWeek ?? ''}
                    placeholder="Project start"
                    onBlur={(e) => {
                      const val = e.target.value
                        ? parseInt(e.target.value)
                        : null
                      if (val !== r.startWeek)
                        updateResource.mutate({ id: r.id, startWeek: val })
                    }}
                    className="border border-gray-200 rounded px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-red-400 w-full"
                  />
                  <input
                    type="number"
                    defaultValue={r.endWeek ?? ''}
                    placeholder="Project end"
                    onBlur={(e) => {
                      const val = e.target.value
                        ? parseInt(e.target.value)
                        : null
                      if (val !== r.endWeek)
                        updateResource.mutate({ id: r.id, endWeek: val })
                    }}
                    className="border border-gray-200 rounded px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-red-400 w-full"
                  />
                  <input
                    type="number"
                    min={0}
                    max={100}
                    defaultValue={r.allocationPct}
                    onBlur={(e) => {
                      const val = parseInt(e.target.value)
                      if (
                        !isNaN(val) &&
                        val >= 0 &&
                        val <= 100 &&
                        val !== r.allocationPct
                      ) {
                        updateResource.mutate({ id: r.id, allocationPct: val })
                      }
                    }}
                    className="border border-gray-200 rounded px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-red-400 w-full"
                  />
                  <select
                    defaultValue={r.pricingModel}
                    onChange={(e) => {
                      if (e.target.value !== r.pricingModel) {
                        updateResource.mutate({
                          id: r.id,
                          pricingModel: e.target.value,
                        })
                      }
                    }}
                    className="border border-gray-200 rounded px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-red-400 w-full"
                  >
                    <option value="ACTUAL_DAYS">Actual Days</option>
                    <option value="PRO_RATA">Pro-rata</option>
                  </select>
                  <button
                    onClick={() => deleteResource.mutate(r.id)}
                    className="text-gray-400 hover:text-red-600 text-lg leading-none"
                    title="Delete"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}

          <button
            onClick={() => createResource.mutate()}
            disabled={createResource.isPending}
            className="text-sm text-red-600 hover:text-red-700 font-medium disabled:opacity-50"
          >
            {createResource.isPending ? 'Adding…' : '+ Add person'}
          </button>
        </div>
      </td>
    </tr>
  )
}

export default function ResourceProfilePage() {
  const { id: projectId } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { user, logout } = useAuth()
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
  const columnCount = hasCost ? 8 : 7

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
      qc.invalidateQueries({ queryKey: ['named-resources'] })
      // Auto-expand named resources panel so the user sees the people
      setExpandedNamedResources(prev => new Set([...prev, rtId]))
    },
  })

  const removeLastPerson = useMutation({
    mutationFn: async (rtId: string) => {
      const res = await api.get(`/projects/${projectId}/resource-types/${rtId}/named-resources`)
      const resources = res.data as NamedResource[]
      if (resources.length > 1) {
        await api.delete(`/projects/${projectId}/resource-types/${rtId}/named-resources/${resources[resources.length - 1].id}`)
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['resource-profile', projectId] })
      qc.invalidateQueries({ queryKey: ['resource-types', projectId] })
      qc.invalidateQueries({ queryKey: ['named-resources'] })
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

  const toCsvValue = (value: string | number | null | undefined) => {
    if (value === null || value === undefined) return ''
    const str = typeof value === 'number' ? value.toString() : value
    if (/[",\n]/.test(str)) {
      return `"${str.replace(/"/g, '""')}"`
    }
    return str
  }

  const buildProfileCsv = (profileData: ResourceProfile) => {
    const rows: Array<Array<string | number>> = [[
      'Role', 'Category', 'Count', 'HoursPerDay', 'Hours', 'Days', 'DayRate', 'Cost',
    ]]
    profileData.resourceRows.forEach(row => {
      rows.push([
        row.name,
        row.category,
        row.count,
        row.hoursPerDay,
        row.totalHours,
        row.totalDays,
        row.dayRate ?? '',
        row.estimatedCost ?? '',
      ])
    })
    profileData.overheadRows.forEach(row => {
      const description = row.type === 'PERCENTAGE'
        ? `${row.value}% of task days`
        : row.type === 'DAYS_PER_WEEK'
          ? `${row.value} days/week × ${profileData.projectDurationWeeks} weeks`
          : `${row.value} fixed days`
      rows.push([
        row.name,
        'Overhead',
        '',
        `— ${description}`,
        '',
        row.computedDays,
        row.dayRate ?? '',
        row.estimatedCost ?? '',
      ])
    })
    rows.push([
      'Total',
      '',
      '',
      '',
      profileData.summary.totalHours,
      profileData.summary.totalDays,
      '',
      profileData.summary.totalCost ?? '',
    ])
    return rows.map(r => r.map(toCsvValue).join(',')).join('\n')
  }

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
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
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
      const backlogRes = await api.get(`/projects/${projectId}/backlog/export-csv`, { responseType: 'blob' })
      zip.file(`${safeName}-backlog.csv`, backlogRes.data)
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

  // ── Commercial cost computation ──
  const commercialData = useMemo(() => {
    if (!profile) return null

    // All rows (resource + overhead) with day rates
    const costRows = [
      ...profile.resourceRows.filter(r => r.dayRate != null).flatMap(r => {
        if (r.namedResources && r.namedResources.length > 0) {
          // RT-level aggregate row (non-editable allocation, just shows totals)
          const rtRow = {
            id: r.resourceTypeId,
            name: r.name,
            count: r.count,
            effortDays: r.effortDays ?? r.totalDays,
            allocatedDays: r.allocatedDays ?? r.totalDays,
            totalDays: r.totalDays,
            dayRate: r.dayRate!,
            subtotal: r.totalDays * r.dayRate!,
            allocationMode: 'AGGREGATE',
            allocationPercent: 100,
            allocationStartWeek: null as number | null,
            allocationEndWeek: null as number | null,
            derivedStartWeek: r.derivedStartWeek ?? null,
            derivedEndWeek: r.derivedEndWeek ?? null,
            kind: 'resource' as const,
            resourceTypeId: r.resourceTypeId,
          }
          // Per-NR rows
          const nrRows = r.namedResources.map(nr => ({
            id: nr.id,
            name: `  ${nr.name}`,
            count: 1,
            effortDays: nr.allocatedDays,
            allocatedDays: nr.allocatedDays,
            totalDays: nr.allocatedDays,
            dayRate: r.dayRate!,
            subtotal: nr.allocatedDays * r.dayRate!,
            allocationMode: nr.allocationMode,
            allocationPercent: nr.allocationPercent,
            allocationStartWeek: nr.allocationStartWeek ?? null,
            allocationEndWeek: nr.allocationEndWeek ?? null,
            derivedStartWeek: nr.derivedStartWeek ?? r.derivedStartWeek ?? null,
            derivedEndWeek: nr.derivedEndWeek ?? r.derivedEndWeek ?? null,
            kind: 'named-resource' as const,
            resourceTypeId: r.resourceTypeId,
          }))
          return [rtRow, ...nrRows]
        }
        // No NRs — RT-level row as before
        return [{
          id: r.resourceTypeId,
          name: r.name,
          count: r.count,
          effortDays: r.effortDays ?? r.totalDays,
          allocatedDays: r.allocatedDays ?? r.totalDays,
          totalDays: r.totalDays,
          dayRate: r.dayRate!,
          subtotal: r.totalDays * r.dayRate!,
          allocationMode: r.allocationMode ?? 'EFFORT',
          allocationPercent: r.allocationPercent ?? 100,
          allocationStartWeek: r.allocationStartWeek ?? null,
          allocationEndWeek: r.allocationEndWeek ?? null,
          derivedStartWeek: r.derivedStartWeek ?? null,
          derivedEndWeek: r.derivedEndWeek ?? null,
          kind: 'resource' as const,
          resourceTypeId: r.resourceTypeId,
        }]
      }),
      ...profile.overheadRows.filter(r => r.dayRate != null).map(r => ({
        id: r.overheadId,
        name: r.name,
        count: 1,
        effortDays: r.computedDays,
        allocatedDays: r.computedDays,
        totalDays: r.computedDays,
        dayRate: r.dayRate!,
        subtotal: r.computedDays * r.dayRate!,
        allocationMode: 'EFFORT' as string,
        allocationPercent: 100,
        allocationStartWeek: null as number | null,
        allocationEndWeek: null as number | null,
        derivedStartWeek: null as number | null,
        derivedEndWeek: null as number | null,
        kind: 'overhead' as const,
        resourceTypeId: r.overheadId,
      })),
    ]

    // Per-resource-type discounts
    const rtDiscounts = discounts.filter(d => d.resourceTypeId != null)
    const projectDiscounts = discounts.filter(d => d.resourceTypeId == null)

    // Build net subtotals per row (applying RT-level discounts)
    const rowsWithDiscounts = costRows.map(row => {
      const appliedDiscounts = rtDiscounts
        .filter(d => d.resourceTypeId === row.resourceTypeId)
        .map(d => ({
          ...d,
          calculatedAmount: d.type === 'PERCENTAGE' ? (d.value / 100) * row.subtotal : d.value,
        }))
      // For aggregate rows (AGGREGATE mode), don't double-count discounts — NR rows handle their own
      const skipDiscounts = row.allocationMode === 'AGGREGATE'
      const effectiveDiscounts = skipDiscounts ? [] : appliedDiscounts
      const totalDiscount = effectiveDiscounts.reduce((sum, d) => sum + d.calculatedAmount, 0)
      return { ...row, appliedDiscounts: effectiveDiscounts, netSubtotal: row.subtotal - totalDiscount }
    })

    const subtotal = rowsWithDiscounts.reduce((sum, r) => sum + r.netSubtotal, 0)

    // Project-level discounts
    const projectDiscountsWithCalc = projectDiscounts.map(d => ({
      ...d,
      calculatedAmount: d.type === 'PERCENTAGE' ? (d.value / 100) * subtotal : d.value,
    }))
    const totalProjectDiscount = projectDiscountsWithCalc.reduce((sum, d) => sum + d.calculatedAmount, 0)
    const afterDiscounts = subtotal - totalProjectDiscount

    // Tax
    const taxRate = project?.taxRate ?? null
    const taxLabel = project?.taxLabel ?? 'GST'
    const taxEnabled = taxRate != null
    const taxAmount = taxEnabled ? (taxRate / 100) * afterDiscounts : 0

    const grandTotal = afterDiscounts + taxAmount

    return {
      rows: rowsWithDiscounts,
      subtotal,
      projectDiscounts: projectDiscountsWithCalc,
      totalProjectDiscount,
      afterDiscounts,
      taxRate,
      taxLabel,
      taxEnabled,
      taxAmount,
      grandTotal,
    }
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

  type CommercialRow = {
    id: string; name: string; count: number
    effortDays: number; allocatedDays: number; totalDays: number
    dayRate: number; subtotal: number
    allocationMode: string; allocationPercent: number
    allocationStartWeek: number | null; allocationEndWeek: number | null
    derivedStartWeek: number | null; derivedEndWeek: number | null
    kind: 'resource' | 'named-resource' | 'overhead'
    resourceTypeId: string  // for mutations — NR rows need their RT id for the PATCH URL
    appliedDiscounts: Array<{ id: string; label: string; type: string; value: number; calculatedAmount: number; resourceTypeId: string | null }>
    netSubtotal: number
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
    const effectiveStart = row.allocationStartWeek ?? row.derivedStartWeek
    const effectiveEnd = row.allocationEndWeek ?? row.derivedEndWeek
    if (row.allocationMode === 'AGGREGATE') {
      return { label: 'Aggregate', color: 'bg-gray-100 text-gray-400', sub: null }
    } else if (row.allocationMode === 'EFFORT') {
      return { label: 'T&M', color: 'bg-gray-100 text-gray-600', sub: null }
    } else if (row.allocationMode === 'TIMELINE') {
      const sub = effectiveStart != null && effectiveEnd != null
        ? `Wk ${Math.round(effectiveStart)} → Wk ${Math.round(effectiveEnd)}`
        : null
      return {
        label: `Timeline · ${row.allocationPercent}%`,
        color: 'bg-blue-100 text-blue-700',
        sub,
      }
    } else {
      return {
        label: `Full Project · ${row.allocationPercent}%`,
        color: 'bg-purple-100 text-purple-700',
        sub: null,
      }
    }
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white border-b border-gray-200">
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm text-gray-500">
            <button onClick={() => navigate('/')} className="hover:text-red-600 transition-colors font-semibold text-gray-900">
              Monrad Estimator
            </button>
            <span>/</span>
            <button onClick={() => navigate(`/projects/${projectId}`)} className="hover:text-red-600 transition-colors">
              {project?.name ?? '…'}
            </button>
            <span>/</span>
            <span className="text-gray-700">Resource Profile</span>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-sm text-gray-500">{user?.name}</span>
            <button onClick={logout} className="text-sm text-gray-500 hover:text-gray-700">Sign out</button>
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-6 py-8 space-y-6">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <h1 className="text-xl font-semibold text-gray-900">Resource Profile</h1>
            {profile && (
              <p className="text-sm text-gray-500 mt-1">
                Total {formatNumber(profile.summary.totalHours)}h · {formatNumber(profile.summary.totalDays)} days
                {profile.summary.totalCost != null && ` · $${formatNumber(profile.summary.totalCost, 0)}`}
              </p>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              onClick={handleExportProfile}
              disabled={!profile}
              className="border border-gray-300 text-gray-700 px-4 py-2 rounded-lg text-sm font-medium hover:bg-gray-100 disabled:opacity-50"
            >
              ⬇ Export Resource Profile
            </button>
            <button
              onClick={handleExportFull}
              disabled={!profile}
              className="bg-red-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-red-700 disabled:opacity-50"
            >
              ⬇ Export Full Project
            </button>
          </div>
        </div>

        {/* ── Tab bar ── */}
        <div className="border-b border-gray-200">
          <nav className="flex gap-6">
            <button
              onClick={() => setActiveTab('profile')}
              className={`pb-2 text-sm font-medium transition-colors ${
                activeTab === 'profile'
                  ? 'border-b-2 border-red-600 text-red-600'
                  : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              Resource Profile
            </button>
            <button
              onClick={() => setActiveTab('commercial')}
              className={`pb-2 text-sm font-medium transition-colors ${
                activeTab === 'commercial'
                  ? 'border-b-2 border-red-600 text-red-600'
                  : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              Commercial
            </button>
          </nav>
        </div>

        {/* ═══════════════════════════════════════════════════════ */}
        {/* RESOURCE PROFILE TAB                                    */}
        {/* ═══════════════════════════════════════════════════════ */}
        {activeTab === 'profile' && (
        <>
        <section className="bg-white rounded-xl border border-gray-200">
          <header className="px-6 py-4 border-b border-gray-100 flex items-center justify-between">
            <div>
              <h2 className="text-base font-semibold text-gray-900">Summary</h2>
              <p className="text-sm text-gray-500">Active scope only — role mix, overheads, and allocation modes</p>
            </div>
          </header>
          {profileLoading && (
            <div className="py-12 text-center text-gray-400">Loading resource profile…</div>
          )}
          {!profileLoading && profile && profile.resourceRows.length === 0 && profile.overheadRows.length === 0 && (
            <div className="py-12 text-center text-gray-400">
              <p className="text-lg mb-1">No tasks assigned yet.</p>
              <p className="text-sm">Add tasks to your backlog to see the resource profile.</p>
            </div>
          )}
          {!profileLoading && profile && (profile.resourceRows.length > 0 || profile.overheadRows.length > 0) && (
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead>
                  <tr className="bg-gray-50 text-gray-600 border-b border-gray-200">
                    <th className="text-left px-6 py-3 font-medium">Role</th>
                    <th className="text-center px-4 py-3 font-medium">Count</th>
                    <th className="text-left px-4 py-3 font-medium">Hrs/Day</th>
                    <th className="text-right px-4 py-3 font-medium min-w-[5rem]">Hours</th>
                    <th className="text-right px-4 py-3 font-medium min-w-[5rem]">Days</th>
                    <th className="text-left px-4 py-3 font-medium">Allocation</th>
                    <th className="text-right px-4 py-3 font-medium">Day Rate</th>
                    {hasCost && (
                      <th className="text-right px-6 py-3 font-medium">Cost</th>
                    )}
                  </tr>
                </thead>
                <tbody>
                  {filteredResourceRows.map(row => (
                    <Fragment key={row.resourceTypeId}>
                      <tr
                        className="border-b border-gray-100 hover:bg-gray-50 transition-colors"
                      >
                        <td className="px-6 py-3">
                          <div className="font-medium text-gray-900">
                            <button
                              className="text-left hover:text-red-600 transition-colors font-medium"
                              onClick={() => toggleRow(row.resourceTypeId)}
                            >
                              {row.count > 1 ? `${row.count} × ${row.name}` : row.name}
                            </button>
                            {expandedNamedResources.has(row.resourceTypeId) && (
                              <span className="ml-2 text-[10px] bg-red-100 text-red-600 px-1.5 py-0.5 rounded font-medium uppercase tracking-wide">People</span>
                            )}
                          </div>
                          <p className="text-xs text-gray-500 mt-0.5">{row.category.replace('_', ' ')}</p>
                          {row.count > 1 && (
                            <p className="text-xs text-gray-500 mt-0.5">
                              ({formatNumber(row.totalHours / row.count)}h / {formatNumber(row.totalDays / row.count)}d per person)
                            </p>
                          )}
                          <div className="flex items-center gap-3 mt-0.5">
                            <button
                              className="text-xs text-red-500 hover:text-red-700 transition-colors"
                              onClick={() => toggleRow(row.resourceTypeId)}
                            >
                              {expandedRows.has(row.resourceTypeId) ? '▲ Hide breakdown' : '▼ Show breakdown'}
                            </button>
                            <button
                              className="text-xs text-gray-400 hover:text-gray-600 transition-colors"
                              onClick={() => toggleNamedResources(row.resourceTypeId)}
                              title="Show named resources"
                            >
                              People ↗
                            </button>
                          </div>
                        </td>
                        <td className="text-center px-4 py-3 text-gray-800">
                          <div className="flex items-center justify-center gap-1">
                            <button
                              onClick={(e) => {
                                e.stopPropagation()
                                removeLastPerson.mutate(row.resourceTypeId)
                              }}
                              disabled={row.count <= 1}
                              className="w-6 h-6 rounded border border-gray-200 text-gray-500 hover:bg-gray-100 hover:text-red-600 disabled:opacity-30 disabled:cursor-not-allowed text-sm font-medium"
                              title="Remove person"
                            >
                              −
                            </button>
                            <span className="w-8 text-center text-sm font-medium">{row.count}</span>
                            <button
                              onClick={(e) => {
                                e.stopPropagation()
                                addPerson.mutate(row.resourceTypeId)
                              }}
                              className="w-6 h-6 rounded border border-gray-200 text-gray-500 hover:bg-gray-100 hover:text-green-600 text-sm font-medium"
                              title="Add person"
                            >
                              +
                            </button>
                          </div>
                        </td>
                        <td className="px-4 py-3 text-gray-800">
                          <input
                            type="number"
                            step="0.5"
                            min="0.5"
                            defaultValue={row.hoursPerDay ?? ''}
                            key={`hpd-${row.resourceTypeId}-${row.hoursPerDay}`}
                            onClick={e => e.stopPropagation()}
                            onBlur={e => {
                              const raw = e.target.value.trim()
                              const parsed = raw === '' ? null : parseFloat(raw)
                              if (parsed !== null && (!Number.isFinite(parsed) || parsed <= 0)) return
                              const rt = resourceTypes.find(r => r.id === row.resourceTypeId)
                              const current = rt?.hoursPerDay ?? null
                              if (parsed === current) return
                              if (rt) updateResourceType.mutate({ id: rt.id, hoursPerDay: parsed })
                            }}
                            className="w-16 border border-gray-200 rounded px-2 py-0.5 text-sm text-right focus:outline-none focus:ring-1 focus:ring-blue-400"
                            placeholder="—"
                          /> h
                        </td>
                        <td className="text-right px-4 py-3 text-gray-900 whitespace-nowrap">{formatNumber(row.totalHours)} h</td>
                        <td className="text-right px-4 py-3 text-gray-900 whitespace-nowrap">
                          {Math.abs((row.allocatedDays ?? row.totalDays) - (row.effortDays ?? row.totalDays)) > 0.5 ? (
                            <div>
                              <div className="font-medium">{formatNumber(row.allocatedDays ?? row.totalDays)} d</div>
                              <div className="text-xs text-gray-400">effort: {formatNumber(row.effortDays ?? row.totalDays)}</div>
                            </div>
                          ) : (
                            <span>{formatNumber(row.totalDays)} d</span>
                          )}
                        </td>
                        <td className="px-4 py-3">
                          {(() => {
                            const mode = row.allocationMode ?? 'EFFORT'
                            const effectiveStart = row.allocationStartWeek ?? row.derivedStartWeek ?? null
                            const effectiveEnd = row.allocationEndWeek ?? row.derivedEndWeek ?? null
                            if (mode === 'EFFORT') {
                              return <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-gray-100 text-gray-600">T&amp;M</span>
                            } else if (mode === 'TIMELINE') {
                              return (
                                <div>
                                  <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-blue-100 text-blue-700">
                                    Timeline · {row.allocationPercent ?? 100}%
                                  </span>
                                  {effectiveStart != null && effectiveEnd != null && (
                                    <div className="text-xs text-gray-400 mt-0.5">Wk {Math.round(effectiveStart)} → Wk {Math.round(effectiveEnd)}</div>
                                  )}
                                </div>
                              )
                            } else {
                              return <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-purple-100 text-purple-700">Full Project · {row.allocationPercent ?? 100}%</span>
                            }
                          })()}
                        </td>
                        <td className="text-right px-4 py-3 text-gray-900">
                          <input
                            type="number"
                            min="0"
                            step="1"
                            defaultValue={row.dayRate ?? ''}
                            key={`dr-${row.resourceTypeId}-${row.dayRate}`}
                            onClick={e => e.stopPropagation()}
                            onBlur={e => {
                              const raw = e.target.value.trim()
                              const val = raw === '' ? null : parseFloat(raw)
                              if (val !== null && (Number.isNaN(val) || val < 0)) return
                              const rt = resourceTypes.find(r => r.id === row.resourceTypeId)
                              if (rt && val !== (rt.dayRate ?? null)) updateResourceType.mutate({ id: rt.id, dayRate: val })
                            }}
                            className="w-20 border border-gray-200 rounded px-2 py-0.5 text-sm text-right focus:outline-none focus:ring-1 focus:ring-blue-400"
                            placeholder="—"
                          />
                        </td>
                        {hasCost && (
                          <td className="text-right px-6 py-3 text-gray-900">
                            {row.estimatedCost != null ? `$${formatNumber(row.estimatedCost, 0)}` : '—'}
                          </td>
                        )}
                      </tr>
                      {expandedNamedResources.has(row.resourceTypeId) && (
                        <NamedResourcesPanel
                          projectId={projectId!}
                          rtId={row.resourceTypeId}
                          rtCount={row.count}
                          columnCount={columnCount}
                        />
                      )}
                      {expandedRows.has(row.resourceTypeId) && (
                        <tr className="bg-gray-50">
                          <td colSpan={columnCount} className="px-10 py-4">
                            <div className="space-y-4">
                              {row.epics.map(epic => (
                                <div key={epic.epicId} className="border-l-2 border-red-200 pl-3">
                                  <div className="flex items-center justify-between text-sm font-semibold text-gray-800">
                                    <span>{epic.epicName}</span>
                                    <span>{formatNumber(epic.days)} d · {formatNumber(epic.hours)} h</span>
                                  </div>
                                  <div className="mt-2 space-y-2">
                                    {epic.features.map(feature => (
                                      <div key={feature.featureId} className="ml-4">
                                        <div className="flex items-center justify-between text-sm text-gray-600">
                                          <span>{feature.featureName}</span>
                                          <span>{formatNumber(feature.days)} d · {formatNumber(feature.hours)} h</span>
                                        </div>
                                        <ul className="mt-1 ml-4 text-xs text-gray-500 space-y-0.5">
                                          {feature.stories.map(story => (
                                            <li key={story.storyId} className="flex items-center justify-between">
                                              <span>{story.storyName}</span>
                                              <span>{formatNumber(story.days)} d · {formatNumber(story.hours)} h</span>
                                            </li>
                                          ))}
                                        </ul>
                                      </div>
                                    ))}
                                  </div>
                                </div>
                              ))}
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  ))}

                  {profile.overheadRows.map(row => (
                    <tr key={row.overheadId} className="bg-amber-50 text-gray-700 italic border-b border-amber-100">
                      <td className="px-6 py-3">
                        <div className="font-medium">{row.name}</div>
                        {row.resourceTypeName && <p className="text-xs text-gray-500 normal-case not-italic">Linked to: {row.resourceTypeName}</p>}
                      </td>
                      <td className="text-center px-4 py-3">
                        {profile.projectDurationWeeks > 0
                          ? formatNumber(row.computedDays / (profile.projectDurationWeeks * 5), 2)
                          : '—'}
                      </td>
                      <td className="px-4 py-3">
                        {row.type === 'PERCENTAGE'
                          ? `— ${row.value}% of task days`
                          : row.type === 'DAYS_PER_WEEK'
                            ? `— ${formatNumber(row.value, 2)} d/wk × ${formatNumber(profile.projectDurationWeeks)} wks`
                            : `— ${formatNumber(row.value, 2)} fixed days`}
                      </td>
                      <td className="text-center px-4 py-3">—</td>
                      <td className="text-right px-4 py-3 font-medium text-gray-900">{formatNumber(row.computedDays, 2)} d</td>
                      <td className="px-4 py-3">—</td>
                      <td className="text-right px-4 py-3">{row.dayRate != null ? `$${formatNumber(row.dayRate, 0)}` : '—'}</td>
                      {hasCost && (
                        <td className="text-right px-6 py-3 font-medium text-gray-900">
                          {row.estimatedCost != null ? `$${formatNumber(row.estimatedCost, 0)}` : '—'}
                        </td>
                      )}
                    </tr>
                  ))}

                  {profile && (
                    <tr className="bg-gray-900 text-white font-semibold">
                      <td className="px-6 py-3 uppercase tracking-wide">Grand total</td>
                      <td className="px-4 py-3 text-center">{filteredResourceRows.reduce((sum, row) => sum + row.count, 0)}</td>
                      <td className="px-4 py-3">—</td>
                      <td className="px-4 py-3 text-right whitespace-nowrap">{formatNumber(profile.summary.totalHours)} h</td>
                      <td className="px-4 py-3 text-right whitespace-nowrap">{formatNumber(profile.summary.totalDays)} d</td>
                      <td className="px-4 py-3">—</td>
                      <td className="px-4 py-3 text-right">—</td>
                      {hasCost && (
                        <td className="px-6 py-3 text-right">
                          {profile.summary.totalCost != null ? `$${formatNumber(profile.summary.totalCost, 0)}` : '—'}
                        </td>
                      )}
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="bg-white rounded-xl border border-gray-200 p-6 space-y-5">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div>
              <h2 className="text-base font-semibold text-gray-900">Overhead configuration</h2>
              <p className="text-sm text-gray-500">Percentages or days applied on top of task estimates.</p>
            </div>
          </div>

          <div className="space-y-3">
            {overheadItems.length === 0 && (
              <p className="text-sm text-gray-500">No overheads yet. Add one below.</p>
            )}
            {overheadItems.map(item => (
              <div key={item.id} className="flex flex-wrap items-center justify-between gap-3 border border-gray-100 rounded-lg px-4 py-3">
                <div>
                  <p className="font-medium text-gray-900">{item.name}</p>
                  <p className="text-xs text-gray-500">
                    {item.type === 'PERCENTAGE'
                      ? `${item.value}% of task days`
                      : item.type === 'DAYS_PER_WEEK'
                        ? `${formatNumber(item.value, 2)} days/week × ${formatNumber(profile?.projectDurationWeeks ?? 0)} weeks`
                        : `${formatNumber(item.value, 2)} fixed total days`}
                    {item.resourceType?.name && ` · Billed with ${item.resourceType.name}`}
                  </p>
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={() => handleEdit(item)}
                    className="text-sm text-blue-600 hover:text-blue-800 font-medium"
                  >
                    Edit
                  </button>
                  <button
                    onClick={() => handleDelete(item.id)}
                    className="text-sm text-red-600 hover:text-red-800 font-medium"
                  >
                    Delete
                  </button>
                </div>
              </div>
            ))}
          </div>

          <div className="border border-dashed border-gray-300 rounded-lg p-4">
            <h3 className="text-sm font-semibold text-gray-900 mb-3">
              {editingId ? 'Edit overhead' : 'Add overhead'}
            </h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">Name</label>
                <input
                  type="text"
                  value={form.name}
                  onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-red-500"
                  placeholder="e.g. Delivery management"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">Bill using resource rate (optional)</label>
                <select
                  value={form.resourceTypeId}
                  onChange={e => setForm(f => ({ ...f, resourceTypeId: e.target.value }))}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-red-500"
                >
                  <option value="">No resource type</option>
                  {resourceTypes.map(rt => (
                    <option key={rt.id} value={rt.id}>{rt.name}</option>
                  ))}
                </select>
              </div>
            </div>
            <div className="mt-4 flex flex-wrap gap-4">
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">Type</label>
                <div className="flex gap-2">
                  {TYPE_OPTIONS.map(opt => (
                    <button
                      key={opt.value}
                      onClick={() => setForm(f => ({ ...f, type: opt.value }))}
                      type="button"
                      className={`px-3 py-1.5 rounded-lg text-sm border ${
                        form.type === opt.value
                          ? 'border-red-500 bg-red-50 text-red-600'
                          : 'border-gray-200 text-gray-600 hover:bg-gray-50'
                      }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="flex-1 min-w-[160px]">
                <label className="block text-xs font-medium text-gray-500 mb-1">
                  {form.type === 'PERCENTAGE' ? 'Percentage (%)' : form.type === 'DAYS_PER_WEEK' ? 'Days per week' : 'Fixed total days'}
                </label>
                <input
                  type="number"
                  min={0}
                  step={form.type === 'PERCENTAGE' ? 0.5 : 0.1}
                  value={form.value}
                  onChange={e => setForm(f => ({ ...f, value: e.target.value }))}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-red-500"
                />
              </div>
            </div>
            {form.type === 'DAYS_PER_WEEK' && (profile?.projectDurationWeeks ?? 0) === 0 && (
              <p className="text-xs text-amber-600 mt-2">⚠ No timeline set for this project — computed days will be 0 until you add features to the timeline.</p>
            )}
            {form.type === 'DAYS_PER_WEEK' && (profile?.projectDurationWeeks ?? 0) > 0 && form.value !== '' && (
              <p className="text-xs text-gray-500 mt-2">= {formatNumber(parseFloat(form.value || '0') * (profile?.projectDurationWeeks ?? 0), 2)} total days ({formatNumber(profile?.projectDurationWeeks ?? 0)} weeks)</p>
            )}
            {formError && <p className="text-sm text-red-600 mt-2">{formError}</p>}
            <div className="mt-4 flex gap-2">
              <button
                onClick={handleFormSubmit}
                disabled={createOverhead.isPending || updateOverhead.isPending}
                className="bg-red-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-red-700 disabled:opacity-50"
              >
                {editingId
                  ? (updateOverhead.isPending ? 'Saving…' : 'Save changes')
                  : (createOverhead.isPending ? 'Adding…' : 'Add overhead')}
              </button>
              {editingId && (
                <button
                  onClick={resetForm}
                  className="px-4 py-2 rounded-lg text-sm text-gray-600 hover:bg-gray-100"
                >
                  Cancel
                </button>
              )}
            </div>
          </div>
        </section>

        <section className="bg-white rounded-xl border border-gray-200 p-6">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="text-base font-semibold text-gray-900">Capacity vs overhead</h2>
              <p className="text-sm text-gray-500">Stacked days by role</p>
            </div>
          </div>
          {chartData.length === 0 ? (
            <div className="text-center text-gray-400 py-10 text-sm">Not enough data yet</div>
          ) : (
            <div className="h-72">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  data={chartData}
                  layout="vertical"
                  margin={{ top: 10, right: 30, left: 0, bottom: 0 }}
                >
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis type="number" />
                  <YAxis type="category" dataKey="name" width={150} />
                  <Tooltip formatter={(value) => formatNumber(Number(value))} />
                  <Legend />
                  <Bar dataKey="taskDays" name="Task days" stackId="a" fill="#2563eb" />
                  <Bar dataKey="overheadDays" name="Overhead days" stackId="a" fill="#f97316" />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </section>
        </>
        )}

        {/* ═══════════════════════════════════════════════════════ */}
        {/* COMMERCIAL TAB                                          */}
        {/* ═══════════════════════════════════════════════════════ */}
        {activeTab === 'commercial' && (
        <>
          {/* ── Apply Rate Card ── */}
          <section className="bg-white rounded-xl border border-gray-200 p-6 space-y-4">
            <div>
              <h2 className="text-base font-semibold text-gray-900">Apply Rate Card</h2>
              <p className="text-sm text-gray-500">Select a rate card to bulk-apply day rates to matching resource types.</p>
            </div>
            <div className="flex flex-wrap items-end gap-3">
              <div className="flex-1 min-w-[200px]">
                <label className="block text-xs font-medium text-gray-500 mb-1">Rate Card</label>
                <select
                  value={selectedRateCardId}
                  onChange={e => { setSelectedRateCardId(e.target.value); setRateCardResult(null) }}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-red-500"
                >
                  <option value="">Select a rate card…</option>
                  {rateCards.map(rc => (
                    <option key={rc.id} value={rc.id}>{rc.name} (v{rc.version})</option>
                  ))}
                </select>
              </div>
              <button
                onClick={handleApplyRateCard}
                disabled={!selectedRateCardId || applyRateCard.isPending}
                className="bg-red-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-red-700 disabled:opacity-50"
              >
                {applyRateCard.isPending ? 'Applying…' : 'Apply'}
              </button>
            </div>
            {rateCardResult && (
              <p className="text-sm text-green-700 bg-green-50 border border-green-200 rounded-lg px-4 py-2">
                ✓ {rateCardResult.updated} rate{rateCardResult.updated !== 1 ? 's' : ''} updated
                {rateCardResult.skipped > 0 && `, ${rateCardResult.skipped} skipped`}
              </p>
            )}
          </section>

          {/* ── Cost Summary Table ── */}
          <section className="bg-white rounded-xl border border-gray-200">
            <header className="px-6 py-4 border-b border-gray-100">
              <h2 className="text-base font-semibold text-gray-900">Cost Summary</h2>
              <p className="text-sm text-gray-500">Breakdown by resource type with day rates and discounts</p>
            </header>
            {!commercialData || commercialData.rows.length === 0 ? (
              <div className="py-12 text-center text-gray-400">
                <p className="text-lg mb-1">No costed resources.</p>
                <p className="text-sm">Assign day rates to resource types to see the cost summary.</p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="min-w-full text-sm">
                  <thead>
                    <tr className="bg-gray-50 text-gray-600 border-b border-gray-200">
                      <th className="text-left px-6 py-3 font-medium">Resource Type</th>
                      <th className="text-center px-4 py-3 font-medium">Count</th>
                      <th className="text-right px-4 py-3 font-medium">Effort Days</th>
                      <th className="text-left px-4 py-3 font-medium">Allocation</th>
                      <th className="text-right px-4 py-3 font-medium">Allocated Days</th>
                      <th className="text-right px-4 py-3 font-medium">Day Rate</th>
                      <th className="text-right px-6 py-3 font-medium">Subtotal</th>
                    </tr>
                  </thead>
                  <tbody>
                    {commercialData.rows.map(row => (
                      <Fragment key={row.id}>
                        <tr className={`border-b border-gray-100 ${row.kind === 'named-resource' ? 'bg-gray-50' : ''}`}>
                          <td className="px-6 py-3 text-gray-900 font-medium">
                            {row.name}
                            {row.kind === 'overhead' && <span className="text-xs text-amber-600 ml-2">(overhead)</span>}
                            {row.kind === 'named-resource' && <span className="text-xs text-blue-500 ml-2">(person)</span>}
                          </td>
                          <td className="text-center px-4 py-3 text-gray-800">{row.count}</td>
                          <td className="text-right px-4 py-3 text-gray-500">{formatNumber(row.effortDays)}</td>
                          <td className="px-4 py-3">
                            {(row.kind === 'resource' || row.kind === 'named-resource') ? (() => {
                              const badge = getAllocationBadge(row)
                              const isAggregate = row.allocationMode === 'AGGREGATE'
                              if (isAggregate) {
                                return <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${badge.color}`}>{badge.label}</span>
                              }
                              return (
                                <div>
                                  <button
                                    onClick={() => editingAllocation === row.id ? setEditingAllocation(null) : startEditAllocation(row)}
                                    className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${badge.color} hover:opacity-80 transition-opacity`}
                                    title="Click to edit allocation"
                                  >
                                    {badge.label}
                                  </button>
                                  {badge.sub && <div className="text-xs text-gray-400 mt-0.5">{badge.sub}</div>}
                                </div>
                              )
                            })() : <span className="text-gray-400 text-xs">—</span>}
                          </td>
                          <td className="text-right px-4 py-3 text-gray-900 font-medium">{formatNumber(row.allocatedDays)}</td>
                          <td className="text-right px-4 py-3 text-gray-800">${formatNumber(row.dayRate, 0)}</td>
                          <td className="text-right px-6 py-3 text-gray-900">${formatNumber(row.subtotal, 0)}</td>
                        </tr>
                        {/* Inline allocation editor */}
                        {editingAllocation === row.id && allocationDraft && (row.kind === 'resource' || row.kind === 'named-resource') && row.allocationMode !== 'AGGREGATE' && (
                          <tr className="border-b border-blue-100 bg-blue-50">
                            <td colSpan={7} className="px-6 py-4">
                              <div className="flex flex-wrap items-end gap-4">
                                <div>
                                  <label className="block text-xs font-medium text-gray-600 mb-1">Allocation Mode</label>
                                  <select
                                    value={allocationDraft.allocationMode}
                                    onChange={e => setAllocationDraft(d => d ? { ...d, allocationMode: e.target.value } : d)}
                                    className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                                  >
                                    <option value="EFFORT">T&amp;M (effort only)</option>
                                    <option value="TIMELINE">Timeline window</option>
                                    <option value="FULL_PROJECT">Full project</option>
                                  </select>
                                </div>
                                <div>
                                  <label className="block text-xs font-medium text-gray-600 mb-1">FTE %</label>
                                  <input
                                    type="number"
                                    min={1}
                                    max={100}
                                    step={5}
                                    value={allocationDraft.allocationPercent}
                                    onChange={e => setAllocationDraft(d => d ? { ...d, allocationPercent: Number(e.target.value) } : d)}
                                    className="w-20 border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                                  />
                                </div>
                                {allocationDraft.allocationMode === 'TIMELINE' && (
                                  <>
                                    <div>
                                      <label className="block text-xs font-medium text-gray-600 mb-1">
                                        Start Week override
                                        {row.derivedStartWeek != null && <span className="text-gray-400 ml-1">(auto: Wk {Math.round(row.derivedStartWeek)})</span>}
                                      </label>
                                      <input
                                        type="number"
                                        min={0}
                                        step={0.5}
                                        value={allocationDraft.allocationStartWeek ?? ''}
                                        onChange={e => setAllocationDraft(d => d ? { ...d, allocationStartWeek: e.target.value === '' ? null : Number(e.target.value) } : d)}
                                        placeholder="auto"
                                        className="w-24 border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                                      />
                                    </div>
                                    <div>
                                      <label className="block text-xs font-medium text-gray-600 mb-1">
                                        End Week override
                                        {row.derivedEndWeek != null && <span className="text-gray-400 ml-1">(auto: Wk {Math.round(row.derivedEndWeek)})</span>}
                                      </label>
                                      <input
                                        type="number"
                                        min={0}
                                        step={0.5}
                                        value={allocationDraft.allocationEndWeek ?? ''}
                                        onChange={e => setAllocationDraft(d => d ? { ...d, allocationEndWeek: e.target.value === '' ? null : Number(e.target.value) } : d)}
                                        placeholder="auto"
                                        className="w-24 border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                                      />
                                    </div>
                                  </>
                                )}
                                <div className="flex gap-2 ml-auto">
                                  <button
                                    onClick={() => {
                                      if (row.kind === 'named-resource') {
                                        updateNrAllocationMutation.mutate({
                                          rtId: row.resourceTypeId,
                                          nrId: row.id,
                                          data: {
                                            allocationMode: allocationDraft.allocationMode,
                                            allocationPercent: allocationDraft.allocationPercent,
                                            allocationStartWeek: allocationDraft.allocationStartWeek,
                                            allocationEndWeek: allocationDraft.allocationEndWeek,
                                          }
                                        })
                                      } else {
                                        updateAllocationMutation.mutate({
                                          rtId: row.id,
                                          data: {
                                            allocationMode: allocationDraft.allocationMode,
                                            allocationPercent: allocationDraft.allocationPercent,
                                            allocationStartWeek: allocationDraft.allocationStartWeek,
                                            allocationEndWeek: allocationDraft.allocationEndWeek,
                                          }
                                        })
                                      }
                                    }}
                                    disabled={updateAllocationMutation.isPending || updateNrAllocationMutation.isPending}
                                    className="bg-blue-600 text-white px-4 py-1.5 rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50"
                                  >
                                    {(updateAllocationMutation.isPending || updateNrAllocationMutation.isPending) ? 'Saving…' : 'Save'}
                                  </button>
                                  <button
                                    onClick={() => { setEditingAllocation(null); setAllocationDraft(null) }}
                                    className="px-4 py-1.5 rounded-lg text-sm text-gray-600 hover:bg-gray-100"
                                  >
                                    Cancel
                                  </button>
                                </div>
                              </div>
                            </td>
                          </tr>
                        )}
                        {row.appliedDiscounts.map(d => (
                          <tr key={d.id} className="border-b border-gray-50 bg-gray-50">
                            <td className="px-6 py-2 pl-10 text-gray-500 italic text-xs" colSpan={6}>
                              ↳ {d.label} ({d.type === 'PERCENTAGE' ? `${d.value}%` : `$${formatNumber(d.value, 0)}`})
                            </td>
                            <td className="text-right px-6 py-2 text-red-600 text-xs italic">
                              −${formatNumber(d.calculatedAmount, 0)}
                            </td>
                          </tr>
                        ))}
                        {row.appliedDiscounts.length > 0 && (
                          <tr className="border-b border-gray-100 bg-gray-50">
                            <td className="px-6 py-2 pl-10 text-gray-600 text-xs font-medium" colSpan={6}>
                              Net subtotal
                            </td>
                            <td className="text-right px-6 py-2 text-gray-900 text-xs font-medium">
                              ${formatNumber(row.netSubtotal, 0)}
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    ))}
                    <tr className="bg-gray-900 text-white font-semibold">
                      <td className="px-6 py-3 uppercase tracking-wide" colSpan={6}>Subtotal</td>
                      <td className="text-right px-6 py-3">${formatNumber(commercialData.subtotal, 0)}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {/* ── Project Discounts ── */}
          <section className="bg-white rounded-xl border border-gray-200 p-6 space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-base font-semibold text-gray-900">Project Discounts</h2>
                <p className="text-sm text-gray-500">Discounts applied to the overall project subtotal</p>
              </div>
            </div>

            {commercialData && commercialData.projectDiscounts.length === 0 && !showDiscountForm && (
              <p className="text-sm text-gray-500">No project-level discounts yet.</p>
            )}

            {commercialData && commercialData.projectDiscounts.length > 0 && (
              <div className="overflow-x-auto">
                <table className="min-w-full text-sm">
                  <thead>
                    <tr className="bg-gray-50 text-gray-600 border-b border-gray-200">
                      <th className="text-left px-4 py-2 font-medium">Label</th>
                      <th className="text-left px-4 py-2 font-medium">Type</th>
                      <th className="text-right px-4 py-2 font-medium">Value</th>
                      <th className="text-right px-4 py-2 font-medium">Amount</th>
                      <th className="px-4 py-2"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {commercialData.projectDiscounts.map(d => (
                      <tr key={d.id} className="border-b border-gray-100">
                        <td className="px-4 py-2 text-gray-900">{d.label}</td>
                        <td className="px-4 py-2 text-gray-600">{d.type === 'PERCENTAGE' ? 'Percentage' : 'Fixed Amount'}</td>
                        <td className="text-right px-4 py-2 text-gray-800">
                          {d.type === 'PERCENTAGE' ? `${d.value}%` : `$${formatNumber(d.value, 0)}`}
                        </td>
                        <td className="text-right px-4 py-2 text-red-600 font-medium">
                          −${formatNumber(d.calculatedAmount, 0)}
                        </td>
                        <td className="px-4 py-2 text-right">
                          <button
                            onClick={() => { if (confirm('Delete this discount?')) deleteDiscount.mutate(d.id) }}
                            className="text-red-600 hover:text-red-800 text-xs font-medium"
                          >
                            Delete
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {showDiscountForm ? (
              <div className="border border-dashed border-gray-300 rounded-lg p-4 space-y-3">
                <h3 className="text-sm font-semibold text-gray-900">Add project discount</h3>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                  <div>
                    <label className="block text-xs font-medium text-gray-500 mb-1">Label</label>
                    <input
                      type="text"
                      value={discountForm.label}
                      onChange={e => setDiscountForm(f => ({ ...f, label: e.target.value }))}
                      placeholder="e.g. Early bird"
                      className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-red-500"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-500 mb-1">Type</label>
                    <select
                      value={discountForm.type}
                      onChange={e => setDiscountForm(f => ({ ...f, type: e.target.value as 'PERCENTAGE' | 'FIXED_AMOUNT' }))}
                      className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-red-500"
                    >
                      <option value="PERCENTAGE">Percentage</option>
                      <option value="FIXED_AMOUNT">Fixed Amount</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-500 mb-1">
                      {discountForm.type === 'PERCENTAGE' ? 'Percentage (%)' : 'Amount ($)'}
                    </label>
                    <input
                      type="number"
                      min={0}
                      step={discountForm.type === 'PERCENTAGE' ? 0.5 : 1}
                      value={discountForm.value}
                      onChange={e => setDiscountForm(f => ({ ...f, value: e.target.value }))}
                      className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-red-500"
                    />
                  </div>
                </div>
                {discountFormError && <p className="text-sm text-red-600">{discountFormError}</p>}
                <div className="flex gap-2">
                  <button
                    onClick={handleDiscountSubmit}
                    disabled={createDiscount.isPending}
                    className="bg-red-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-red-700 disabled:opacity-50"
                  >
                    {createDiscount.isPending ? 'Adding…' : 'Add discount'}
                  </button>
                  <button
                    onClick={() => { setShowDiscountForm(false); setDiscountFormError(null) }}
                    className="px-4 py-2 rounded-lg text-sm text-gray-600 hover:bg-gray-100"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <button
                onClick={() => setShowDiscountForm(true)}
                className="text-sm text-red-600 hover:text-red-800 font-medium"
              >
                + Add Discount
              </button>
            )}
          </section>

          {/* ── Tax ── */}
          <section className="bg-white rounded-xl border border-gray-200 p-6 space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-base font-semibold text-gray-900">Tax</h2>
                <p className="text-sm text-gray-500">Apply tax to the after-discount total</p>
              </div>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={commercialData?.taxEnabled ?? false}
                  onChange={e => {
                    if (e.target.checked) {
                      updateTax.mutate({ taxRate: 10, taxLabel: project?.taxLabel ?? 'GST' })
                    } else {
                      updateTax.mutate({ taxRate: null })
                    }
                  }}
                  className="h-4 w-4 rounded border-gray-300 text-red-600 focus:ring-red-500"
                />
                <span className="text-sm text-gray-600">Enable tax</span>
              </label>
            </div>

            {commercialData?.taxEnabled && (
              <div className="flex flex-wrap items-center gap-6 border border-gray-100 rounded-lg px-4 py-3">
                <div className="flex items-center gap-2">
                  <span className="text-sm text-gray-500">Label:</span>
                  {editingTaxLabel ? (
                    <div className="flex items-center gap-1">
                      <input
                        type="text"
                        value={taxLabelDraft}
                        onChange={e => setTaxLabelDraft(e.target.value)}
                        onKeyDown={e => {
                          if (e.key === 'Enter') {
                            updateTax.mutate({ taxLabel: taxLabelDraft.trim() || 'GST' })
                            setEditingTaxLabel(false)
                          }
                        }}
                        className="border border-gray-300 rounded px-2 py-1 text-sm w-24 focus:outline-none focus:ring-1 focus:ring-red-500"
                        autoFocus
                      />
                      <button
                        onClick={() => { updateTax.mutate({ taxLabel: taxLabelDraft.trim() || 'GST' }); setEditingTaxLabel(false) }}
                        className="text-xs text-red-600 hover:text-red-800 font-medium"
                      >
                        Save
                      </button>
                      <button
                        onClick={() => setEditingTaxLabel(false)}
                        className="text-xs text-gray-500 hover:text-gray-700"
                      >
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => { setTaxLabelDraft(commercialData.taxLabel); setEditingTaxLabel(true) }}
                      className="text-sm font-medium text-gray-900 hover:text-red-600 transition-colors"
                    >
                      {commercialData.taxLabel}
                    </button>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-sm text-gray-500">Rate:</span>
                  {editingTaxRate ? (
                    <div className="flex items-center gap-1">
                      <input
                        type="number"
                        min={0}
                        step={0.5}
                        value={taxRateDraft}
                        onChange={e => setTaxRateDraft(e.target.value)}
                        onKeyDown={e => {
                          if (e.key === 'Enter') {
                            const val = parseFloat(taxRateDraft)
                            if (!Number.isNaN(val) && val >= 0) {
                              updateTax.mutate({ taxRate: val })
                              setEditingTaxRate(false)
                            }
                          }
                        }}
                        className="border border-gray-300 rounded px-2 py-1 text-sm w-20 focus:outline-none focus:ring-1 focus:ring-red-500"
                        autoFocus
                      />
                      <span className="text-sm text-gray-500">%</span>
                      <button
                        onClick={() => {
                          const val = parseFloat(taxRateDraft)
                          if (!Number.isNaN(val) && val >= 0) {
                            updateTax.mutate({ taxRate: val })
                            setEditingTaxRate(false)
                          }
                        }}
                        className="text-xs text-red-600 hover:text-red-800 font-medium"
                      >
                        Save
                      </button>
                      <button
                        onClick={() => setEditingTaxRate(false)}
                        className="text-xs text-gray-500 hover:text-gray-700"
                      >
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => { setTaxRateDraft(String(commercialData.taxRate ?? 10)); setEditingTaxRate(true) }}
                      className="text-sm font-medium text-gray-900 hover:text-red-600 transition-colors"
                    >
                      {commercialData.taxRate}%
                    </button>
                  )}
                </div>
                <div className="flex items-center gap-2 ml-auto">
                  <span className="text-sm text-gray-500">Tax amount:</span>
                  <span className="text-sm font-medium text-gray-900">${formatNumber(commercialData.taxAmount, 0)}</span>
                </div>
              </div>
            )}
          </section>

          {/* ── Grand Total ── */}
          {commercialData && commercialData.rows.length > 0 && (
            <section className="bg-gray-900 rounded-xl p-6">
              <div className="flex items-center justify-between flex-wrap gap-4">
                <div className="space-y-1">
                  <div className="text-sm text-gray-400">
                    Subtotal: ${formatNumber(commercialData.subtotal, 0)}
                    {commercialData.totalProjectDiscount > 0 && (
                      <span> − Discounts: ${formatNumber(commercialData.totalProjectDiscount, 0)}</span>
                    )}
                    {commercialData.taxEnabled && (
                      <span> + {commercialData.taxLabel}: ${formatNumber(commercialData.taxAmount, 0)}</span>
                    )}
                  </div>
                </div>
                <div className="text-right">
                  <p className="text-sm text-gray-400 uppercase tracking-wide">Grand Total</p>
                  <p className="text-3xl font-bold text-white">${formatNumber(commercialData.grandTotal, 0)}</p>
                </div>
              </div>
            </section>
          )}
        </>
        )}
      </main>
    </div>
  )
}
