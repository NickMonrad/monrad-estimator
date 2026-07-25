import { Fragment, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ResponsiveContainer, BarChart, XAxis, YAxis, Tooltip, Legend, Bar, CartesianGrid,
} from 'recharts'
import type { UseResourceProfileReturn } from '../../hooks/useResourceProfile'
import {
  formatAllocationModeDescription,
  formatCapacityProfileSource,
  formatResolutionSource,
  ALLOCATION_MODE_OPTIONS,
  getEffectiveAvailabilityDisplay,
  getEffectiveAvailabilityBadge,
  getEffectiveAvailabilityPeriod,
  formatEffectiveAvailabilityPeriod,
} from '../../lib/capacityProfileFormatting'
import NamedResourcesPanel from './NamedResourcesPanel'
import CapacityProfileEditorModal from './CapacityProfileEditorModal'
import type { CapacityProfilePlanningBasis } from '../../types/backlog'

const TYPE_OPTIONS = [
  { label: '% of task days', value: 'PERCENTAGE' },
  { label: 'Fixed total days', value: 'FIXED_DAYS' },
  { label: 'Days per week', value: 'DAYS_PER_WEEK' },
] as const

/** Options for the generic editor dropdown — excludes CAPACITY_PLAN (profile-managed). */
const MANUAL_ALLOCATION_OPTIONS = ALLOCATION_MODE_OPTIONS.filter(o => o.value !== 'CAPACITY_PLAN')

interface Props extends UseResourceProfileReturn {
  projectId: string
}

export default function ResourceProfileTab({
  projectId, profile, profileLoading, overheadItems, resourceTypes,
  filteredResourceRows, hasCost, columnCount, chartData,
  expandedRows, expandedNamedResources, editingId, form, setForm, formError,
  bufferWeeks, onboardingWeeks,
  toggleRow, toggleNamedResources, resetForm, handleFormSubmit, handleEdit, handleDelete,
  updateResourceType, addPerson, removeLastPerson,
  createOverhead, updateOverhead,
  weekToDate, fmtDate, formatNumber,
  editingAllocation, setEditingAllocation, allocationDraft, setAllocationDraft,
  updateAllocationMutation,
}: Props) {
  const navigate = useNavigate()
  const [editingRoleProfile, setEditingRoleProfile] = useState<{
    ownerKind: 'ROLE' | 'NAMED_PERSON'
    ownerId: string
    initialProfile: {
      planningBasis: CapacityProfilePlanningBasis
      defaultPercent: number | null
      startWeek: number | null
      endWeek: number | null
      segments: Array<{ startWeek: number; endWeek: number; capacityPercent: number }>
    } | null
  } | null>(null)
  return (
    <>
    <section className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700">
      <header className="px-6 py-4 border-b border-gray-100 dark:border-gray-700 flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold text-gray-900 dark:text-white">Capacity profile summary</h2>
          <p className="text-sm text-gray-500 dark:text-gray-400">Capacity profiles, availability patterns, and resource allocation by role</p>
        </div>
      </header>
      <div className="px-6 py-3 bg-blue-50 dark:bg-blue-950/30 border-b border-blue-100 dark:border-blue-900">
        <p className="text-xs text-blue-700 dark:text-blue-300">
          <strong className="font-medium">Capacity profiles</strong> describe how much of a role, named person, or planned resource is available over time. Changing a profile affects planning capacity and scheduling. Commercial billing basis and billable days are managed separately on the <strong className="font-medium">Commercial</strong> tab.
        </p>
      </div>
      {profileLoading && <div className="py-12 text-center text-gray-400 dark:text-gray-500">Loading resource profile…</div>}
      {!profileLoading && profile && profile.resourceRows.length === 0 && profile.overheadRows.length === 0 && (
        <div className="py-12 text-center text-gray-400 dark:text-gray-500">
          <p className="text-lg mb-1">No tasks assigned yet.</p>
          <p className="text-sm">Add tasks to your backlog to see the resource profile.</p>
        </div>
      )}
      {!profileLoading && profile && (profile.resourceRows.length > 0 || profile.overheadRows.length > 0) && (
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="bg-gray-50 dark:bg-gray-700 text-gray-600 dark:text-gray-400 border-b border-gray-200 dark:border-gray-700">
                <th className="text-left px-6 py-3 font-medium">Role</th>
                <th className="text-center px-4 py-3 font-medium">Count</th>
                <th className="text-left px-4 py-3 font-medium">Hrs/Day</th>
                <th className="text-right px-4 py-3 font-medium min-w-[5rem]">Hours</th>
                <th className="text-right px-4 py-3 font-medium min-w-[5rem]">Days</th>
                <th className="text-left px-4 py-3 font-medium">Availability pattern</th>
                <th className="text-left px-4 py-3 font-medium">Period</th>
                <th className="text-right px-4 py-3 font-medium">Day Rate</th>
                {hasCost && <th className="text-right px-6 py-3 font-medium">Cost</th>}
              </tr>
            </thead>
            <tbody>
              {filteredResourceRows.map(row => {
                const availability = getEffectiveAvailabilityDisplay(row)
                return (
                <Fragment key={row.resourceTypeId}>
                  <tr data-testid={`resource-profile-row-${row.resourceTypeId}`} className="border-b border-gray-100 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors">
                    <td className="px-6 py-3">
                      <div className="font-medium text-gray-900 dark:text-white">
                        <button className="text-left hover:text-lab3-navy transition-colors font-medium" onClick={() => toggleRow(row.resourceTypeId)}>
                          {row.count > 1 ? `${row.count} × ${row.name}` : row.name}
                        </button>
                        {expandedNamedResources.has(row.resourceTypeId) && (
                          <span className="ml-2 text-[10px] bg-red-100 text-red-600 px-1.5 py-0.5 rounded font-medium uppercase tracking-wide">People</span>
                        )}
                      </div>
                      <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{row.category.replace('_', ' ')}</p>
                      {row.count > 1 && (
                        <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">({formatNumber(row.totalHours / row.count)}h / {formatNumber(row.totalDays / row.count)}d per person)</p>
                      )}
                      {/* Resource identity label */}
                      {row.namedResources && row.namedResources.length > 0 ? (
                        row.namedResources.every(nr => nr.synthetic) ? (
                          <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">Planned resource</p>
                        ) : row.namedResources.some(nr => nr.synthetic) ? (
                          <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">Mixed (named person + planned resource)</p>
                        ) : (
                          <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">Named person</p>
                        )
                      ) : (
                        <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">Role-level capacity</p>
                      )}
                      {row.namedResources && row.namedResources.some(namedResource => (namedResource.actualAllocationSegments?.length ?? 0) > 0) && (
                        <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                          Assigned: {row.namedResources
                            .filter(namedResource => (namedResource.actualAllocationSegments?.length ?? 0) > 0)
                            .slice(0, 2)
                            .map(namedResource => {
                              const firstSegment = namedResource.actualAllocationSegments[0]
                              return firstSegment.startWeek === firstSegment.endWeek
                                ? `${namedResource.name} W${firstSegment.startWeek + 1}`
                                : `${namedResource.name} W${firstSegment.startWeek + 1}-W${firstSegment.endWeek + 1}`
                            })
                            .join('; ')}
                          {row.namedResources.filter(namedResource => (namedResource.actualAllocationSegments?.length ?? 0) > 0).length > 2
                            ? ` +${row.namedResources.filter(namedResource => (namedResource.actualAllocationSegments?.length ?? 0) > 0).length - 2} more`
                            : ''}
                        </p>
                      )}
                      <div className="flex items-center gap-3 mt-0.5">
                        <button className="text-xs text-red-500 hover:text-red-700 transition-colors" onClick={() => toggleRow(row.resourceTypeId)}>
                          {expandedRows.has(row.resourceTypeId) ? '▲ Hide breakdown' : '▼ Show breakdown'}
                        </button>
                        <button className="text-xs text-gray-400 dark:text-gray-500 hover:text-gray-600 transition-colors" onClick={() => toggleNamedResources(row.resourceTypeId)} title="Show named resources">
                          People ↗
                        </button>
                      </div>
                    </td>
                    <td className="text-center px-4 py-3 text-gray-800 dark:text-gray-100">
                      <div className="flex items-center justify-center gap-1">
                        <button onClick={e => { e.stopPropagation(); removeLastPerson.mutate(row.resourceTypeId) }} disabled={row.count <= 0}
                          className="w-6 h-6 rounded border border-gray-200 dark:border-gray-700 text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 hover:text-red-600 disabled:opacity-30 disabled:cursor-not-allowed text-sm font-medium" title="Remove person">−</button>
                        <span className="w-8 text-center text-sm font-medium">{row.count}</span>
                        <button onClick={e => { e.stopPropagation(); addPerson.mutate(row.resourceTypeId) }}
                          className="w-6 h-6 rounded border border-gray-200 dark:border-gray-700 text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 hover:text-green-600 text-sm font-medium" title="Add person">+</button>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-gray-800 dark:text-gray-100">
                      <input type="number" step="0.5" min="0.5" defaultValue={row.hoursPerDay ?? ''} key={`hpd-${row.resourceTypeId}-${row.hoursPerDay}`}
                        onClick={e => e.stopPropagation()}
                        onBlur={e => {
                          const raw = e.target.value.trim(); const parsed = raw === '' ? null : parseFloat(raw)
                          if (parsed !== null && (!Number.isFinite(parsed) || parsed <= 0)) return
                          const rt = resourceTypes.find(r => r.id === row.resourceTypeId)
                          const current = rt?.hoursPerDay ?? null
                          if (parsed === current) return
                          if (rt) updateResourceType.mutate({ id: rt.id, hoursPerDay: parsed })
                        }}
                        className="w-16 border border-gray-200 dark:border-gray-600 rounded px-2 py-0.5 text-sm text-right bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:outline-none focus:ring-1 focus:ring-blue-400" placeholder="—" /> h
                    </td>
                    <td className="text-right px-4 py-3 text-gray-900 dark:text-white whitespace-nowrap">{formatNumber(row.totalHours)} h</td>
                    <td className="text-right px-4 py-3 text-gray-900 dark:text-white whitespace-nowrap">
                      {Math.abs((row.allocatedDays ?? row.totalDays) - (row.effortDays ?? row.totalDays)) > 0.5 ? (
                        <div>
                          <div className="font-medium">{formatNumber(row.allocatedDays ?? row.totalDays)} d</div>
                          <div className="text-xs text-gray-400 dark:text-gray-500">effort: {formatNumber(row.effortDays ?? row.totalDays)}</div>
                        </div>
                      ) : <span>{formatNumber(row.totalDays)} d</span>}
                    </td>
                    <td className="px-4 py-3">
                      {(() => {
                        if (row.namedResources && row.namedResources.length > 0) {
                          const count = row.namedResources.length
                          const profileCount = row.namedResources.filter(nr => nr.capacityProfile).length
                          const hint = profileCount > 0 ? `${profileCount} capacity profile${profileCount > 1 ? 's' : ''}` : 'No profiles'
                          return (
                            <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400">
                              {count} {count === 1 ? 'person' : 'people'} · {hint}
                            </span>
                          )
                        }
                        const badge = getEffectiveAvailabilityBadge(availability, profile?.projectDurationWeeks)
                        return (
                          <div>
                            <button
                              onClick={() => {
                                // Role rows with capacity profiles open the new profile editor
                                if (row.capacityProfile && !row.namedResources?.length && row.capacityProfile?.source !== 'squadPlanner') {
                                  setEditingRoleProfile({
                                    ownerKind: 'ROLE',
                                    ownerId: row.resourceTypeId,
                                    initialProfile: row.capacityProfile ? {
                                      planningBasis: row.capacityProfile.planningBasis,
                                      defaultPercent: row.capacityProfile.defaultPercent ?? null,
                                      startWeek: row.capacityProfile.startWeek ?? null,
                                      endWeek: row.capacityProfile.endWeek ?? null,
                                      segments: row.capacityProfile.segments,
                                    } : null,
                                  })
                                  return
                                }
                                // Otherwise, use existing scalar editor
                                if (editingAllocation === row.resourceTypeId) {
                                  setEditingAllocation(null)
                                  setAllocationDraft(null)
                                } else {
                                  setEditingAllocation(row.resourceTypeId)
                                  const canEdit = !availability.isProfileManaged
                                  const draftMode = availability.effectiveMode
                                  const draftPct = availability.percentage ?? 100
                                  const draftStart = canEdit && draftMode === 'TIMELINE'
                                    ? availability.startWeek
                                    : null
                                  const draftEnd = canEdit && draftMode === 'TIMELINE'
                                    ? availability.endWeek
                                    : null
                                  setAllocationDraft({
                                    allocationMode: draftMode,
                                    allocationPercent: draftPct,
                                    allocationStartWeek: draftStart,
                                    allocationEndWeek: draftEnd,
                                  })
                                }
                              }}
                              className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${badge.color} hover:opacity-80 transition-opacity`}
                              title="Click to edit allocation"
                            >
                              {badge.label}
                            </button>
                            {row.capacityProfile && (
                              <span className="ml-1 inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-gray-100 dark:bg-gray-700 text-gray-400 dark:text-gray-500 uppercase tracking-wide" aria-describedby={`profile-meta-${row.resourceTypeId}`}>
                                {formatCapacityProfileSource(row.capacityProfile.source)}
                              </span>
                            )}
                            {row.capacityProfile && (
                              <span id={`profile-meta-${row.resourceTypeId}`} className="sr-only">
                                Profile source: {formatCapacityProfileSource(row.capacityProfile.source)} · Resolution source: {formatResolutionSource(row.capacityProfile.resolutionSource)}
                              </span>
                            )}
                            {badge.sub && (
                              <div className="text-xs text-gray-400 dark:text-gray-500 mt-0.5">{badge.sub}</div>
                            )}
                            {row.capacityProfile && row.capacityProfile.segments.length > 0 && (
                              <div className="text-xs text-gray-400 dark:text-gray-500 mt-0.5">
                                {row.capacityProfile.segments.map((seg, i) => (
                                  <span key={i}>
                                    {i > 0 && <span className="mx-1">·</span>}
                                    W{seg.startWeek + 1}-W{seg.endWeek + 1}: {seg.capacityPercent}%
                                  </span>
                                ))}
                              </div>
                            )}
                          </div>
                        )
                      })()}
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-500 dark:text-gray-400 whitespace-nowrap">
                      {formatEffectiveAvailabilityPeriod(
                        getEffectiveAvailabilityPeriod(availability, profile?.projectDurationWeeks),
                        { weekToDate, formatDate: fmtDate },
                      )}
                    </td>
                    <td className="text-right px-4 py-3 text-gray-900 dark:text-white">
                      <input type="number" min="0" step="1" defaultValue={row.dayRate ?? ''} key={`dr-${row.resourceTypeId}-${row.dayRate}`}
                        onClick={e => e.stopPropagation()}
                        onBlur={e => {
                          const raw = e.target.value.trim(); const val = raw === '' ? null : parseFloat(raw)
                          if (val !== null && (Number.isNaN(val) || val < 0)) return
                          const rt = resourceTypes.find(r => r.id === row.resourceTypeId)
                          if (rt && val !== (rt.dayRate ?? null)) updateResourceType.mutate({ id: rt.id, dayRate: val })
                        }}
                        className="w-20 border border-gray-200 dark:border-gray-600 rounded px-2 py-0.5 text-sm text-right bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:outline-none focus:ring-1 focus:ring-blue-400" placeholder="—" />
                    </td>
                    {hasCost && <td className="text-right px-6 py-3 text-gray-900 dark:text-white">{row.estimatedCost != null ? `$${formatNumber(row.estimatedCost, 0)}` : '—'}</td>}
                  </tr>
                  {editingAllocation === row.resourceTypeId && allocationDraft && (
                    allocationDraft.allocationMode === 'CAPACITY_PLAN' ? (
                      <tr className="border-b border-green-100 dark:border-green-900 bg-green-50 dark:bg-green-950/30">
                        <td colSpan={columnCount} className="px-6 py-4">
                          <div className="flex flex-col gap-2">
                            <div className="flex items-center gap-2">
                              <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-green-100 text-green-700">
                                Varies by week
                              </span>
                              <span className="text-xs text-gray-500 dark:text-gray-400">
                                — managed through the weekly capacity profile
                              </span>
                            </div>
                            <p className="text-xs text-gray-500 dark:text-gray-400">
                              Availability varies by week. Open the weekly profile editor to review or configure the pattern.
                            </p>
                            <div className="flex gap-2">
                              <button
                                onClick={() => navigate(`/projects/${projectId}/timeline?panel=squad-planner`)}
                                className="inline-flex items-center gap-1 px-4 py-1.5 rounded-lg text-sm font-medium bg-lab3-navy text-white hover:bg-lab3-blue transition-colors"
                              >
                                Open weekly profile editor ↗
                              </button>
                              <button data-testid="allocation-cancel" onClick={() => { setEditingAllocation(null); setAllocationDraft(null) }}
                                className="px-4 py-1.5 rounded-lg text-sm text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700">
                                Close
                              </button>
                            </div>
                          </div>
                        </td>
                      </tr>
                    ) : (
                      <tr className="border-b border-blue-100 dark:border-blue-900 bg-blue-50 dark:bg-blue-950/30">
                        <td colSpan={columnCount} className="px-6 py-4">
                          <div className="flex flex-wrap items-end gap-4">
                            <div>
                              <label className="block text-xs font-medium text-gray-600 dark:text-gray-300 mb-1">Availability pattern</label>
                              <select value={allocationDraft.allocationMode} onChange={e => {
                                const newMode = e.target.value
                                setAllocationDraft(d => d ? {
                                  ...d,
                                  allocationMode: newMode,
                                  allocationStartWeek: newMode === 'TIMELINE' ? d.allocationStartWeek : null,
                                  allocationEndWeek: newMode === 'TIMELINE' ? d.allocationEndWeek : null,
                                  allocationPercent: (newMode !== 'EFFORT' && newMode !== 'CAPACITY_PLAN') ? d.allocationPercent : 100,
                                } : d)
                              }}
                                className="w-full text-xs border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-1.5 bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500 min-w-[7rem]"
                                aria-label="Availability pattern"
                              >
                                {MANUAL_ALLOCATION_OPTIONS.map(opt => (
                                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                                ))}
                              </select>
                            </div>
                            {allocationDraft.allocationMode !== 'EFFORT' && allocationDraft.allocationMode !== 'CAPACITY_PLAN' && (
                              <div>
                                <label className="block text-xs font-medium text-gray-600 dark:text-gray-300 mb-1">Available %</label>
                                <input type="number" min={1} max={100} step={5} value={allocationDraft.allocationPercent}
                                  onChange={e => setAllocationDraft(d => d ? { ...d, allocationPercent: Number(e.target.value) } : d)}
                                  className="w-20 border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-1.5 text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500" />
                              </div>
                            )}
                            {allocationDraft.allocationMode === 'TIMELINE' && (
                              <>
                                <div>
                                  <label className="block text-xs font-medium text-gray-600 dark:text-gray-300 mb-1">
                                    Available from
                                    {!availability.hasAuthoritativeProfile && row.derivedStartWeek != null && <span className="text-gray-400 dark:text-gray-500 ml-1">(auto: Wk {Math.floor(row.derivedStartWeek)})</span>}
                                  </label>
                                  <input type="number" min={0} step={0.5} value={allocationDraft.allocationStartWeek ?? ''} placeholder="auto"
                                    onChange={e => setAllocationDraft(d => d ? { ...d, allocationStartWeek: e.target.value === '' ? null : Number(e.target.value) } : d)}
                                    className="w-24 border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-1.5 text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500" />
                                </div>
                                <div>
                                  <label className="block text-xs font-medium text-gray-600 dark:text-gray-300 mb-1">
                                    Available to
                                    {!availability.hasAuthoritativeProfile && row.derivedEndWeek != null && <span className="text-gray-400 dark:text-gray-500 ml-1">(auto: Wk {Math.floor(row.derivedEndWeek)})</span>}
                                  </label>
                                  <input type="number" min={0} step={0.5} value={allocationDraft.allocationEndWeek ?? ''} placeholder="auto"
                                    onChange={e => setAllocationDraft(d => d ? { ...d, allocationEndWeek: e.target.value === '' ? null : Number(e.target.value) } : d)}
                                    className="w-24 border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-1.5 text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500" />
                                </div>
                              </>
                            )}
                            <p className="text-[11px] text-gray-500 dark:text-gray-400">
                              {allocationDraft.allocationMode === 'EFFORT' && formatAllocationModeDescription('EFFORT')}
                              {allocationDraft.allocationMode === 'FULL_PROJECT' && formatAllocationModeDescription('FULL_PROJECT')}
                              {allocationDraft.allocationMode === 'TIMELINE' && (
                                allocationDraft.allocationStartWeek != null && allocationDraft.allocationEndWeek != null
                                  ? `Available at ${allocationDraft.allocationPercent}% from W${Math.floor(allocationDraft.allocationStartWeek)} to W${Math.floor(allocationDraft.allocationEndWeek)}. Work is assigned only when demand exists.`
                                  : formatAllocationModeDescription('TIMELINE')
                              )}
                            </p>
                            <div className="flex gap-2 ml-auto">
                              <button data-testid="allocation-save" onClick={() => {
                                updateAllocationMutation.mutate(
                                  { rtId: row.resourceTypeId, data: { allocationMode: allocationDraft.allocationMode, allocationPercent: allocationDraft.allocationPercent, allocationStartWeek: allocationDraft.allocationStartWeek, allocationEndWeek: allocationDraft.allocationEndWeek } },
                                  { onSuccess: () => { setEditingAllocation(null); setAllocationDraft(null) } }
                                )
                              }} disabled={updateAllocationMutation.isPending}
                                className="bg-lab3-navy text-white px-4 py-1.5 rounded-lg text-sm font-medium hover:bg-lab3-blue disabled:opacity-50">
                                {updateAllocationMutation.isPending ? 'Saving…' : 'Save'}
                              </button>
                              <button data-testid="allocation-cancel" onClick={() => { setEditingAllocation(null); setAllocationDraft(null) }}
                                className="px-4 py-1.5 rounded-lg text-sm text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700">
                                Cancel
                              </button>
                            </div>
                          </div>
                        </td>
                      </tr>
                    )
                  )}
                  {expandedNamedResources.has(row.resourceTypeId) && (
                    <NamedResourcesPanel
                      projectId={projectId}
                      rtId={row.resourceTypeId}
                      rtCount={row.count}
                      columnCount={columnCount}
                      allocations={row.namedResources}
                    />
                  )}
                  {expandedRows.has(row.resourceTypeId) && (
                    <tr className="bg-gray-50 dark:bg-gray-700">
                      <td colSpan={columnCount} className="px-10 py-4">
                        <div className="space-y-4">
                          {row.epics.map(epic => (
                            <div key={epic.epicId} className="border-l-2 border-red-200 pl-3">
                              <div className="flex items-center justify-between text-sm font-semibold text-gray-800 dark:text-gray-100">
                                <span>{epic.epicName}</span><span>{formatNumber(epic.days)} d · {formatNumber(epic.hours)} h</span>
                              </div>
                              <div className="mt-2 space-y-2">
                                {epic.features.map(feature => (
                                  <div key={feature.featureId} className="ml-4">
                                    <div className="flex items-center justify-between text-sm text-gray-600 dark:text-gray-400">
                                      <span>{feature.featureName}</span><span>{formatNumber(feature.days)} d · {formatNumber(feature.hours)} h</span>
                                    </div>
                                    <ul className="mt-1 ml-4 text-xs text-gray-500 dark:text-gray-400 space-y-0.5">
                                      {feature.stories.map(story => (
                                        <li key={story.storyId} className="flex items-center justify-between">
                                          <span>{story.storyName}</span><span>{formatNumber(story.days)} d · {formatNumber(story.hours)} h</span>
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
                )
              })}

              {profile.overheadRows.map(row => {
                const fteExceedsCount = row.currentCount != null && row.requiredFTE > row.currentCount
                return (
                  <tr key={row.overheadId} className={`border-b border-amber-100 dark:border-amber-900 ${
                    fteExceedsCount
                      ? 'bg-red-50 dark:bg-red-950 text-red-700 dark:text-red-300'
                      : 'bg-amber-50 dark:bg-amber-950 text-gray-700 dark:text-gray-300 italic'
                  }`}>
                    <td className="px-6 py-3">
                      <div className="font-medium">{row.name}</div>
                      {row.resourceTypeName && <p className="text-xs text-gray-500 dark:text-gray-400 normal-case not-italic">Linked to: {row.resourceTypeName}</p>}
                    </td>
                    <td className="text-center px-4 py-3 font-medium">
                      {row.currentCount != null ? (
                        <span>
                          {row.currentCount}
                          {row.currentCount > 0 && (
                            <span title="Current count"></span>
                          )}
                        </span>
                      ) : '—'}
                    </td>
                    <td className="px-4 py-3">
                      {row.type === 'PERCENTAGE' ? `— ${row.value}% of task days`
                        : row.type === 'DAYS_PER_WEEK' ? `— ${formatNumber(row.value, 2)} d/wk × ${formatNumber(profile.projectDurationWeeks)} wks`
                        : `— ${formatNumber(row.value, 2)} fixed days`}
                    </td>
                    <td className="text-center px-4 py-3">—</td>
                    <td className="text-right px-4 py-3 font-medium text-gray-900 dark:text-white">{formatNumber(row.computedDays, 2)} d</td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1.5">
                        <span className={`font-medium ${fteExceedsCount ? 'text-red-600 dark:text-red-400' : ''}`}>
                          {formatNumber(row.requiredFTE, 2)} FTE
                        </span>
                        {fteExceedsCount && (
                          <span
                            className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-bold uppercase bg-red-100 dark:bg-red-900 text-red-700 dark:text-red-300"
                            title={`${row.requiredFTE.toFixed(2)} FTE required but only ${row.currentCount!} configured`}
                          >
                            ⚠ Short {Math.ceil(row.requiredFTE - row.currentCount!)}
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-500 dark:text-gray-400">—</td>
                    <td className="text-right px-4 py-3">{row.dayRate != null ? `$${formatNumber(row.dayRate, 0)}` : '—'}</td>
                    {hasCost && <td className="text-right px-6 py-3 font-medium text-gray-900 dark:text-white">{row.estimatedCost != null ? `$${formatNumber(row.estimatedCost, 0)}` : '—'}</td>}
                  </tr>
                )
              })}

              {profile && (
                <tr className="bg-gray-900 text-white font-semibold">
                  <td className="px-6 py-3 uppercase tracking-wide">Grand total</td>
                  <td className="px-4 py-3 text-center">{filteredResourceRows.reduce((sum, row) => sum + row.count, 0)}</td>
                  <td className="px-4 py-3">—</td>
                  <td className="px-4 py-3 text-right whitespace-nowrap">{formatNumber(profile.summary.totalHours)} h</td>
                  <td className="px-4 py-3 text-right whitespace-nowrap">{formatNumber(profile.summary.totalDays)} d</td>
                  <td className="px-4 py-3">—</td><td className="px-4 py-3">—</td>
                  <td className="px-4 py-3 text-right">—</td>
                  {hasCost && <td className="px-6 py-3 text-right">{profile.summary.totalCost != null ? `$${formatNumber(profile.summary.totalCost, 0)}` : '—'}</td>}
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </section>

    <section className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-6 space-y-5">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h2 className="text-base font-semibold text-gray-900 dark:text-white">Overhead configuration</h2>
          <p className="text-sm text-gray-500 dark:text-gray-400">Percentages or days applied on top of task estimates.</p>
        </div>
      </div>
      <div className="space-y-3">
        {overheadItems.length === 0 && <p className="text-sm text-gray-500 dark:text-gray-400">No overheads yet. Add one below.</p>}
        {overheadItems.map(item => (
          <div key={item.id} className="flex flex-wrap items-center justify-between gap-3 border border-gray-100 dark:border-gray-700 rounded-lg px-4 py-3">
            <div>
              <p className="font-medium text-gray-900 dark:text-white">{item.name}</p>
              <p className="text-xs text-gray-500 dark:text-gray-400">
                {item.type === 'PERCENTAGE' ? `${item.value}% of task days`
                  : item.type === 'DAYS_PER_WEEK' ? `${formatNumber(item.value, 2)} days/week × ${formatNumber(profile?.projectDurationWeeks ?? 0)} weeks`
                  : `${formatNumber(item.value, 2)} fixed total days`}
                {item.resourceType?.name && ` · Billed with ${item.resourceType.name}`}
              </p>
            </div>
            <div className="flex gap-2">
              <button onClick={() => handleEdit(item)} className="text-sm text-blue-600 hover:text-blue-800 font-medium">Edit</button>
              <button onClick={() => handleDelete(item.id)} className="text-sm text-red-600 hover:text-red-800 font-medium">Delete</button>
            </div>
          </div>
        ))}
      </div>

      <div className="border border-dashed border-gray-300 rounded-lg p-4">
        <h3 className="text-sm font-semibold text-gray-900 dark:text-white mb-3">{editingId ? 'Edit overhead' : 'Add overhead'}</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Name</label>
            <input type="text" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
              className="w-full border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-lab3-blue"
              placeholder="e.g. Delivery management" />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Bill using resource rate (optional)</label>
            <select value={form.resourceTypeId} onChange={e => setForm(f => ({ ...f, resourceTypeId: e.target.value }))}
              className="w-full border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-lab3-blue">
              <option value="">No resource type</option>
              {resourceTypes.map(rt => <option key={rt.id} value={rt.id}>{rt.name}</option>)}
            </select>
          </div>
        </div>
        <div className="mt-4 flex flex-wrap gap-4">
          <div>
            <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Type</label>
            <div className="flex gap-2">
              {TYPE_OPTIONS.map(opt => (
                <button key={opt.value} onClick={() => setForm(f => ({ ...f, type: opt.value }))} type="button"
                  className={`px-3 py-1.5 rounded-lg text-sm border ${form.type === opt.value ? 'border-red-500 bg-red-50 text-red-600' : 'border-gray-200 text-gray-600 hover:bg-gray-50'}`}>
                  {opt.label}
                </button>
              ))}
            </div>
          </div>
          <div className="flex-1 min-w-[160px]">
            <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">
              {form.type === 'PERCENTAGE' ? 'Percentage (%)' : form.type === 'DAYS_PER_WEEK' ? 'Days per week' : 'Fixed total days'}
            </label>
            <input type="number" min={0} step={form.type === 'PERCENTAGE' ? 0.5 : 0.1} value={form.value}
              onChange={e => setForm(f => ({ ...f, value: e.target.value }))}
              className="w-full border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-lab3-blue" />
          </div>
        </div>
        {form.type === 'DAYS_PER_WEEK' && (profile?.projectDurationWeeks ?? 0) === 0 && (
          <p className="text-xs text-amber-600 mt-2">⚠ No timeline set for this project — computed days will be 0 until you add features to the timeline.</p>
        )}
        {form.type === 'DAYS_PER_WEEK' && (profile?.projectDurationWeeks ?? 0) > 0 && form.value !== '' && (
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-2">= {formatNumber(parseFloat(form.value || '0') * (profile?.projectDurationWeeks ?? 0), 2)} total days ({formatNumber(profile?.projectDurationWeeks ?? 0)} weeks)</p>
        )}
        {formError && <p className="text-sm text-red-600 mt-2">{formError}</p>}
        <div className="mt-4 flex gap-2">
          <button onClick={handleFormSubmit} disabled={createOverhead.isPending || updateOverhead.isPending}
            className="bg-lab3-navy text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-lab3-blue disabled:opacity-50">
            {editingId ? (updateOverhead.isPending ? 'Saving…' : 'Save changes') : (createOverhead.isPending ? 'Adding…' : 'Add overhead')}
          </button>
          {editingId && <button onClick={resetForm} className="px-4 py-2 rounded-lg text-sm text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700">Cancel</button>}
        </div>
      </div>
    </section>

    <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-4 mb-4">
      <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-3">Planning Context</h3>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <p className="text-xs text-gray-500 dark:text-gray-400">Onboarding Weeks</p>
          <p className="text-sm font-medium text-gray-900 dark:text-white">{onboardingWeeks}</p>
          <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">Set in Timeline → Planning Settings</p>
        </div>
        <div>
          <p className="text-xs text-gray-500 dark:text-gray-400">Buffer Weeks</p>
          <p className="text-sm font-medium text-gray-900 dark:text-white">{bufferWeeks}</p>
          <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">Set in Timeline → Planning Settings</p>
        </div>
      </div>
    </div>

    <section className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-6">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-base font-semibold text-gray-900 dark:text-white">Capacity vs overhead</h2>
          <p className="text-sm text-gray-500 dark:text-gray-400">Stacked days by role</p>
        </div>
      </div>
      {chartData.length === 0 ? (
        <div className="text-center text-gray-400 dark:text-gray-500 py-10 text-sm">Not enough data yet</div>
      ) : (
        <div className="h-72">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={chartData} layout="vertical" margin={{ top: 10, right: 30, left: 0, bottom: 0 }}>
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
      {editingRoleProfile && (
        <CapacityProfileEditorModal
          isOpen={true}
          projectId={projectId}
          ownerKind={editingRoleProfile.ownerKind}
          ownerId={editingRoleProfile.ownerId}
          initialProfile={editingRoleProfile.initialProfile}
          onClose={() => setEditingRoleProfile(null)}
          onSaved={() => {
            setEditingRoleProfile(null)
          }}
          onCancel={() => {
            setEditingRoleProfile(null)
          }}
        />
      )}
    </>
  )
}
