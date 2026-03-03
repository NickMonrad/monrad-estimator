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
} from '../types/backlog'

type OverheadType = 'PERCENTAGE' | 'FIXED_DAYS'
const TYPE_OPTIONS: Array<{ label: string; value: OverheadType }> = [
  { label: '% of task days', value: 'PERCENTAGE' },
  { label: 'Fixed days', value: 'FIXED_DAYS' },
]

const formatNumber = (value: number, fractionDigits = 1) =>
  value.toLocaleString(undefined, { minimumFractionDigits: fractionDigits, maximumFractionDigits: fractionDigits })

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
  const [editingId, setEditingId] = useState<string | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [form, setForm] = useState({
    name: '',
    resourceTypeId: '',
    type: 'PERCENTAGE' as OverheadType,
    value: '',
  })

  const hasCost = profile?.summary.hasCost ?? false
  const columnCount = hasCost ? 7 : 5

  const toggleRow = (rtId: string) => {
    setExpandedRows(prev => {
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
    const overheadByResource = new Map<string, number>()
    for (const row of profile.overheadRows) {
      if (row.resourceTypeId) {
        overheadByResource.set(
          row.resourceTypeId,
          (overheadByResource.get(row.resourceTypeId) ?? 0) + row.computedDays,
        )
      }
    }
    const data = profile.resourceRows.map(row => ({
      name: row.name,
      taskDays: row.totalDays,
      overheadDays: overheadByResource.get(row.resourceTypeId) ?? 0,
    }))
    const generalOverhead = profile.overheadRows
      .filter(o => !o.resourceTypeId)
      .reduce((sum, row) => sum + row.computedDays, 0)
    if (generalOverhead > 0) {
      data.push({ name: 'General Overhead', taskDays: 0, overheadDays: generalOverhead })
    }
    return data
  }, [profile])

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
                Total {formatNumber(profile.summary.totalHours, 1)}h · {formatNumber(profile.summary.totalDays, 2)} days
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

        <section className="bg-white rounded-xl border border-gray-200">
          <header className="px-6 py-4 border-b border-gray-100 flex items-center justify-between">
            <div>
              <h2 className="text-base font-semibold text-gray-900">Summary</h2>
              <p className="text-sm text-gray-500">Role mix, overheads, and drill-down by epic → feature → story</p>
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
                    <th className="text-right px-4 py-3 font-medium">Hours</th>
                    <th className="text-right px-4 py-3 font-medium">Days</th>
                    {hasCost && (
                      <>
                        <th className="text-right px-4 py-3 font-medium">Day Rate</th>
                        <th className="text-right px-6 py-3 font-medium">Cost</th>
                      </>
                    )}
                  </tr>
                </thead>
                <tbody>
                  {profile.resourceRows.map(row => (
                    <Fragment key={row.resourceTypeId}>
                      <tr
                        className="border-b border-gray-100 hover:bg-gray-50 transition-colors cursor-pointer"
                        onClick={() => toggleRow(row.resourceTypeId)}
                      >
                        <td className="px-6 py-3">
                          <div className="font-medium text-gray-900 flex items-center gap-2">
                            <span className="text-xs text-gray-400">{expandedRows.has(row.resourceTypeId) ? '▼' : '▶'}</span>
                            {row.name}
                          </div>
                          <p className="text-xs text-gray-500 mt-0.5">{row.category.replace('_', ' ')}</p>
                        </td>
                        <td className="text-center px-4 py-3 text-gray-800">{row.count}</td>
                        <td className="px-4 py-3 text-gray-800">{formatNumber(row.hoursPerDay, 1)} h</td>
                        <td className="text-right px-4 py-3 text-gray-900">{formatNumber(row.totalHours, 1)} h</td>
                        <td className="text-right px-4 py-3 text-gray-900">{formatNumber(row.totalDays, 2)} d</td>
                        {hasCost && (
                          <>
                            <td className="text-right px-4 py-3 text-gray-900">
                              {row.dayRate != null ? `$${formatNumber(row.dayRate, 0)}` : '—'}
                            </td>
                            <td className="text-right px-6 py-3 text-gray-900">
                              {row.estimatedCost != null ? `$${formatNumber(row.estimatedCost, 0)}` : '—'}
                            </td>
                          </>
                        )}
                      </tr>
                      {expandedRows.has(row.resourceTypeId) && (
                        <tr className="bg-gray-50">
                          <td colSpan={columnCount} className="px-10 py-4">
                            <div className="space-y-4">
                              {row.epics.map(epic => (
                                <div key={epic.epicId} className="border-l-2 border-red-200 pl-3">
                                  <div className="flex items-center justify-between text-sm font-semibold text-gray-800">
                                    <span>{epic.epicName}</span>
                                    <span>{formatNumber(epic.days, 2)} d · {formatNumber(epic.hours, 1)} h</span>
                                  </div>
                                  <div className="mt-2 space-y-2">
                                    {epic.features.map(feature => (
                                      <div key={feature.featureId} className="ml-4">
                                        <div className="flex items-center justify-between text-sm text-gray-600">
                                          <span>{feature.featureName}</span>
                                          <span>{formatNumber(feature.days, 2)} d · {formatNumber(feature.hours, 1)} h</span>
                                        </div>
                                        <ul className="mt-1 ml-4 text-xs text-gray-500 space-y-0.5">
                                          {feature.stories.map(story => (
                                            <li key={story.storyId} className="flex items-center justify-between">
                                              <span>{story.storyName}</span>
                                              <span>{formatNumber(story.days, 2)} d · {formatNumber(story.hours, 1)} h</span>
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
                      <td className="text-center px-4 py-3">—</td>
                      <td className="px-4 py-3">
                        {row.type === 'PERCENTAGE' ? `— ${row.value}% of task days` : `— ${formatNumber(row.value, 2)} fixed days`}
                      </td>
                      <td className="text-center px-4 py-3">—</td>
                      <td className="text-right px-4 py-3 font-medium text-gray-900">{formatNumber(row.computedDays, 2)} d</td>
                      {hasCost && (
                        <>
                          <td className="text-right px-4 py-3">{row.dayRate != null ? `$${formatNumber(row.dayRate, 0)}` : '—'}</td>
                          <td className="text-right px-6 py-3 font-medium text-gray-900">
                            {row.estimatedCost != null ? `$${formatNumber(row.estimatedCost, 0)}` : '—'}
                          </td>
                        </>
                      )}
                    </tr>
                  ))}

                  {profile && (
                    <tr className="bg-gray-900 text-white font-semibold">
                      <td className="px-6 py-3 uppercase tracking-wide">Grand total</td>
                      <td className="px-4 py-3 text-center">{profile.resourceRows.reduce((sum, row) => sum + row.count, 0)}</td>
                      <td className="px-4 py-3">—</td>
                      <td className="px-4 py-3 text-right">{formatNumber(profile.summary.totalHours, 1)} h</td>
                      <td className="px-4 py-3 text-right">{formatNumber(profile.summary.totalDays, 2)} d</td>
                      {hasCost && (
                        <>
                          <td className="px-4 py-3 text-right">—</td>
                          <td className="px-6 py-3 text-right">
                            {profile.summary.totalCost != null ? `$${formatNumber(profile.summary.totalCost, 0)}` : '—'}
                          </td>
                        </>
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
              <p className="text-sm text-gray-500">Percentages or fixed days applied on top of task estimates.</p>
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
                    {item.type === 'PERCENTAGE' ? `${item.value}% of task days` : `${formatNumber(item.value, 2)} fixed days`}
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
                  {form.type === 'PERCENTAGE' ? 'Percentage (%)' : 'Fixed days'}
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
                  <Tooltip />
                  <Legend />
                  <Bar dataKey="taskDays" name="Task days" stackId="a" fill="#2563eb" />
                  <Bar dataKey="overheadDays" name="Overhead days" stackId="a" fill="#f97316" />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </section>
      </main>
    </div>
  )
}
