import { useState } from 'react'
import { invalidateProjectResourceProfile } from '@/lib/projectInvalidation'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../../lib/api'
import type { ResourceProfileRow } from '../../types/backlog'
import {
  buildEffectiveProfileDraft,
  formatPlanningBasis,
  formatCapacityProfileSource,
  formatResolutionSource,
  getEffectiveAvailabilityDisplay,
  scalarModeToPlanningBasis,
} from '../../lib/capacityProfileFormatting'
import CapacityProfileEditorModal from './CapacityProfileEditorModal'
import type { CapacityProfileEditorDraft } from '../../lib/capacityProfileFormatting'


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

interface NamedResourcesPanelProps {
  projectId: string
  rtId: string
  rtCount: number
  columnCount: number
  allocations?: ResourceProfileRow['namedResources']
}

type AllocationEntry = NonNullable<ResourceProfileRow['namedResources']>[number]

function formatWeekLabel(week: number) {
  return `W${week + 1}`
}

function formatAssignedSummary(allocation?: AllocationEntry) {
  const segments = allocation?.actualAllocationSegments ?? []
  if (segments.length === 0) return 'No assigned weeks'
  return segments
    .slice(0, 2)
    .map(segment => (
      segment.startWeek === segment.endWeek
        ? `${formatWeekLabel(segment.startWeek)} (${segment.days.toFixed(1)}d)`
        : `${formatWeekLabel(segment.startWeek)}-${formatWeekLabel(segment.endWeek)} (${segment.days.toFixed(1)}d)`
    ))
    .join(', ') + (segments.length > 2 ? ` +${segments.length - 2} more` : '')
}

export default function NamedResourcesPanel({
  projectId,
  rtId,
  rtCount,
  columnCount,
  allocations = [],
}: NamedResourcesPanelProps) {
  const qc = useQueryClient()
  const [editingProfile, setEditingProfile] = useState<{
    ownerKind: 'ROLE' | 'NAMED_PERSON'
    ownerId: string
    initialProfile: CapacityProfileEditorDraft
    isPersisted: boolean
  } | null>(null)

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
    onSuccess: () => {
      invalidateProjectResourceProfile(qc, projectId)
      qc.invalidateQueries({ queryKey: ['named-resources', projectId, rtId] })
    },
  })

  const updateResource = useMutation({
    mutationFn: ({
      id,
      ...data
    }: {
      id: string
      name?: string
      pricingModel?: string
    }) =>
      api
        .put(
          `/projects/${projectId}/resource-types/${rtId}/named-resources/${id}`,
          data,
        )
        .then((r) => r.data),
    onSuccess: () => {
      invalidateProjectResourceProfile(qc, projectId)
      qc.invalidateQueries({ queryKey: ['named-resources', projectId, rtId] })
    },
  })

  // Scalar start/end-week and allocation-% edits submit the first-class
  // owner-scoped capacity-profile request contract (#403) instead of the
  // legacy NamedResource capacity fields.
  const updateCapacity = useMutation({
    mutationFn: ({
      id,
      planningBasis,
      defaultPercent,
      startWeek,
      endWeek,
    }: {
      id: string
      planningBasis: 'DEMAND_FOLLOWING' | 'WHOLE_PROJECT_ALLOCATION' | 'AVAILABILITY_WINDOW'
      defaultPercent: number | null
      startWeek?: number | null
      endWeek?: number | null
    }) =>
      api
        .put(`/projects/${projectId}/capacity-profiles/NAMED_PERSON/${id}`, {
          planningBasis,
          defaultPercent,
          startWeek: planningBasis === 'AVAILABILITY_WINDOW' ? (startWeek ?? null) : null,
          endWeek: planningBasis === 'AVAILABILITY_WINDOW' ? (endWeek ?? null) : null,
        })
        .then((r) => r.data),
    onSuccess: () => {
      invalidateProjectResourceProfile(qc, projectId)
      qc.invalidateQueries({ queryKey: ['named-resources', projectId, rtId] })
    },
  })

  const deleteResource = useMutation({
    mutationFn: (id: string) =>
      api.delete(
        `/projects/${projectId}/resource-types/${rtId}/named-resources/${id}`,
      ),
    onSuccess: () => {
      invalidateProjectResourceProfile(qc, projectId)
      qc.invalidateQueries({ queryKey: ['named-resources', projectId, rtId] })
    },
  })

  const allocationById = new Map(allocations.map(allocation => [allocation.id, allocation]))
  const mergedResources = [
    ...resources.map(resource => {
      const allocation = allocationById.get(resource.id)
      const allocationRow = allocation ?? resource
      const availability = getEffectiveAvailabilityDisplay(allocationRow as Parameters<typeof getEffectiveAvailabilityDisplay>[0])
      return {
        id: resource.id,
        resourceTypeId: resource.resourceTypeId,
        name: resource.name,
        // Use authoritative profile values exactly (including nulls) when profile is authoritative.
        // Never fall back to stale legacy compatibility values for authoritative profiles.
        startWeek: availability.hasAuthoritativeProfile ? availability.startWeek : (availability.startWeek ?? resource.startWeek),
        endWeek: availability.hasAuthoritativeProfile ? availability.endWeek : (availability.endWeek ?? resource.endWeek),
        allocationPct: availability.hasAuthoritativeProfile ? availability.percentage : (availability.percentage ?? resource.allocationPct),
        pricingModel: resource.pricingModel,
        allocation,
        availability,
        resourceIdentity: allocation?.resourceIdentity ?? (allocation?.synthetic ? 'PLANNED_RESOURCE' : 'NAMED_PERSON'),
        synthetic: allocation?.synthetic ?? false,
        persisted: true,
      }
    }),
    ...allocations
      .filter(allocation => !resources.some(resource => resource.id === allocation.id))
      .map(allocation => {
        const availability = getEffectiveAvailabilityDisplay(allocation as Parameters<typeof getEffectiveAvailabilityDisplay>[0])
        return {
          id: allocation.id,
          resourceTypeId: rtId,
          name: allocation.name,
          startWeek: allocation.startWeek,
          endWeek: allocation.endWeek,
          allocationPct: allocation.allocationPercent,
          pricingModel: (allocation.pricingModel ?? 'ACTUAL_DAYS') as PricingModel,
          createdAt: '',
          updatedAt: '',
          allocation,
          availability,
          synthetic: true,
          persisted: false,
          resourceIdentity: allocation?.resourceIdentity === 'PLANNED_RESOURCE' ? 'PLANNED_RESOURCE' : 'NAMED_PERSON',
        }
      }),
  ]

  function isProtectedOwner(resource: (typeof mergedResources)[number]) {
    return resource.resourceIdentity === 'PLANNED_RESOURCE'
      || resource.allocation?.capacityProfile?.source === 'squadPlanner'
  }

  function hasEditableDraft(resource: (typeof mergedResources)[number]) {
    return Boolean(resource.allocation?.capacityProfile || buildEffectiveProfileDraft(resource.availability))
  }

  function openProfileEditor(resource: (typeof mergedResources)[number]) {
    if (isProtectedOwner(resource)) return
    const profile = resource.allocation?.capacityProfile
    const draft: CapacityProfileEditorDraft | null = profile ? {
      planningBasis: profile.planningBasis,
      defaultPercent: profile.defaultPercent ?? null,
      startWeek: profile.startWeek ?? null,
      endWeek: profile.endWeek ?? null,
      segments: profile.segments,
    } : buildEffectiveProfileDraft(resource.availability)
    if (!draft) return
    setEditingProfile({
      ownerKind: 'NAMED_PERSON',
      ownerId: resource.id,
      initialProfile: draft,
      isPersisted: Boolean(profile),
    })
  }

  return (
    <tr>
      <td colSpan={columnCount} className="px-10 py-4 bg-gray-50 dark:bg-gray-700 border-b border-gray-100 dark:border-gray-700">
        <div className="space-y-3">
          <h4 className="text-xs font-semibold text-gray-600 dark:text-gray-400 uppercase tracking-wide">
            Named Resources
          </h4>

          {isLoading ? (
            <p className="text-sm text-gray-400 dark:text-gray-500">Loading…</p>
          ) : mergedResources.length === 0 ? (
            <p className="text-sm text-gray-500 dark:text-gray-400">
              No named resources - using aggregate count ({rtCount})
            </p>
          ) : (
            <div className="space-y-0.5">
              <div className="grid grid-cols-[1fr_110px_110px_80px_150px_minmax(180px,1fr)_28px] gap-2 text-xs font-medium text-gray-500 dark:text-gray-400 px-2 py-1">
                <span>Name</span>
                <span>Start Week</span>
                <span>End Week</span>
                <span>Alloc %</span>
                <span>Billing basis</span>
                <span>Assigned weeks</span>
                <span />
              </div>
              {mergedResources.map((resource) => (
                <div key={resource.id}>
                  <div data-testid={`named-resource-row-${resource.id}`} className="grid grid-cols-[1fr_110px_110px_80px_150px_minmax(180px,1fr)_28px] gap-2 items-center px-2 py-0.5 rounded hover:bg-gray-100 dark:hover:bg-gray-700">
                  <div className="flex items-center gap-1">
                    <input
                      type="text"
                      defaultValue={resource.name}
                      onBlur={(e) => {
                        if (!resource.persisted) return
                        const value = e.target.value.trim()
                        if (value && value !== resource.name) {
                          updateResource.mutate({ id: resource.id, name: value })
                        }
                      }}
                      disabled={!resource.persisted || resource.resourceIdentity === 'PLANNED_RESOURCE'}
                      className="border border-gray-200 dark:border-gray-600 rounded px-2 py-1 text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-400 focus:outline-none focus:ring-1 focus:ring-lab3-blue w-full disabled:opacity-60"
                    />
                    {(resource.resourceIdentity === 'PLANNED_RESOURCE' || resource.synthetic) && (
                      <span className="shrink-0 inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-bold bg-purple-100 dark:bg-purple-900 text-purple-700 dark:text-purple-300 uppercase tracking-wide">
                        Planned resource
                      </span>
                    )}
                  </div>
                  {resource.availability?.isProfileManaged ? (
                    <span className="text-sm text-gray-400 dark:text-gray-500 italic" title="Capacity varies by week — see profile below">Varies</span>
                  ) : (
                    <input
                      type="number"
                      defaultValue={resource.startWeek ?? ''}
                      placeholder="Project start"
                      onBlur={(e) => {
                        if (!resource.persisted) return
                        const value = e.target.value
                          ? parseInt(e.target.value, 10)
                          : null
                        if (value !== resource.startWeek) {
                          updateCapacity.mutate({
                            id: resource.id,
                            planningBasis: 'AVAILABILITY_WINDOW',
                            defaultPercent: resource.allocationPct,
                            startWeek: value,
                            endWeek: resource.endWeek,
                          })
                        }
                      }}
                      disabled={!resource.persisted || resource.resourceIdentity === 'PLANNED_RESOURCE'}
                      className="border border-gray-200 dark:border-gray-600 rounded px-2 py-1 text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-400 focus:outline-none focus:ring-1 focus:ring-lab3-blue w-full disabled:opacity-60"
                    />
                  )}
                  {resource.availability?.isProfileManaged ? (
                    <span className="text-sm text-gray-400 dark:text-gray-500 italic">Varies</span>
                  ) : (
                    <input
                      type="number"
                      defaultValue={resource.endWeek ?? ''}
                      placeholder="Project end"
                      onBlur={(e) => {
                        if (!resource.persisted) return
                        const value = e.target.value
                          ? parseInt(e.target.value, 10)
                          : null
                        if (value !== resource.endWeek) {
                          updateCapacity.mutate({
                            id: resource.id,
                            planningBasis: 'AVAILABILITY_WINDOW',
                            defaultPercent: resource.allocationPct,
                            startWeek: resource.startWeek,
                            endWeek: value,
                          })
                        }
                      }}
                      disabled={!resource.persisted || resource.resourceIdentity === 'PLANNED_RESOURCE'}
                      className="border border-gray-200 dark:border-gray-600 rounded px-2 py-1 text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-400 focus:outline-none focus:ring-1 focus:ring-lab3-blue w-full disabled:opacity-60"
                    />
                  )}
                  {resource.availability?.isProfileManaged ? (
                    <span className="text-sm text-gray-400 dark:text-gray-500 italic">—</span>
                  ) : (
                    <input
                      type="number"
                      min={0}
                      max={100}
                      defaultValue={resource.allocationPct ?? ''}
                      onBlur={(e) => {
                        if (!resource.persisted) return
                        const value = parseInt(e.target.value, 10)
                        if (
                          !isNaN(value) &&
                          value >= 0 &&
                          value <= 100 &&
                          value !== resource.allocationPct
                        ) {
                          const basis = scalarModeToPlanningBasis(resource.availability?.effectiveMode ?? 'EFFORT')
                          if (basis) {
                            updateCapacity.mutate({
                              id: resource.id,
                              planningBasis: basis,
                              defaultPercent: value,
                              startWeek: resource.startWeek,
                              endWeek: resource.endWeek,
                            })
                          }
                        }
                      }}
                      disabled={!resource.persisted || resource.resourceIdentity === 'PLANNED_RESOURCE'}
                      className="border border-gray-200 dark:border-gray-600 rounded px-2 py-1 text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-400 focus:outline-none focus:ring-1 focus:ring-lab3-blue w-full disabled:opacity-60" />
                  )}
                  <label htmlFor={`billing-basis-${resource.id}`} className="block text-xs text-gray-500 dark:text-gray-400 mb-1 font-medium" title="Determines which days are used for commercial billing — does not affect the planning schedule">Billing basis</label>
                  <select
                    id={`billing-basis-${resource.id}`}
                    defaultValue={resource.pricingModel}
                    aria-describedby={`billing-desc-${resource.id}`}
                    onChange={(e) => {
                      if (!resource.persisted) return
                      if (e.target.value !== resource.pricingModel) {
                        updateResource.mutate({
                          id: resource.id,
                          pricingModel: e.target.value,
                        })
                      }
                    }}
                    disabled={!resource.persisted || resource.resourceIdentity === 'PLANNED_RESOURCE'}
                    className="border border-gray-200 dark:border-gray-600 rounded px-2 py-1 text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-400 focus:outline-none focus:ring-1 focus:ring-lab3-blue w-full disabled:opacity-60"
                  >
                    <option value="ACTUAL_DAYS">Actual scheduled days</option>
                    <option value="PRO_RATA">Planned allocation</option>
                  </select>
                  <span id={`billing-desc-${resource.id}`} className="sr-only">Determines which days are used for commercial billing. Does not affect the planning schedule.</span>
                  <div className="text-xs text-gray-500 dark:text-gray-400">
                    <div>{formatAssignedSummary(resource.allocation)}</div>
                    {resource.allocation?.actualAllocatedDays ? (
                      <div className="mt-0.5 text-[11px] text-gray-400 dark:text-gray-500">
                        {resource.allocation.actualAllocatedDays.toFixed(1)} assigned days
                      </div>
                    ) : null}
                  </div>
                  <button
                    onClick={() => resource.persisted && resource.resourceIdentity !== 'PLANNED_RESOURCE' && !resource.synthetic && deleteResource.mutate(resource.id)}
                    disabled={!resource.persisted || resource.resourceIdentity === 'PLANNED_RESOURCE' || resource.synthetic}
                    className="text-gray-400 dark:text-gray-500 hover:text-red-600 text-lg leading-none disabled:opacity-30"
                    title={resource.resourceIdentity === 'PLANNED_RESOURCE' || resource.synthetic ? 'Planned resources cannot be deleted' : 'Delete'}
                  >
                    x
                  </button>
                  </div>
                  {resource.allocation?.capacityProfile && (resource.availability?.isProfileManaged || resource.allocation?.capacityProfile) && (
                    <div data-testid={`named-resource-profile-${resource.id}`} className="px-2 py-1 ml-2 mt-0.5 text-xs space-y-0.5 border-l-2 border-blue-200 dark:border-blue-700 bg-blue-50/50 dark:bg-blue-950/20 rounded-r">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span data-testid={`profile-managed-owner-${resource.id}`} className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-green-100 dark:bg-green-900 text-green-700 dark:text-green-300">
                          {resource.availability?.isProfileManaged ? 'Varies by week' : formatPlanningBasis(resource.allocation.capacityProfile.planningBasis)}
                        </span>
                        <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400 uppercase tracking-wide">
                          {formatCapacityProfileSource(resource.allocation.capacityProfile.source)}
                        </span>
                        <span className="text-[10px] text-gray-400 dark:text-gray-500">
                          Resolution: {formatResolutionSource(resource.allocation.capacityProfile.resolutionSource)}
                        </span>
                        {resource.allocation.capacityProfile.defaultPercent != null && !resource.availability?.isProfileManaged && (
                          <span className="text-[10px] text-gray-500 dark:text-gray-400">
                            Default: {resource.allocation.capacityProfile.defaultPercent}%
                          </span>
                        )}
                      </div>
                      {!resource.availability?.isProfileManaged && (
                        <div className="text-[10px] text-gray-400 dark:text-gray-500">
                          {resource.allocation.capacityProfile.startWeek != null && resource.allocation.capacityProfile.endWeek != null
                            ? <>Window: W{resource.allocation.capacityProfile.startWeek + 1} → W{resource.allocation.capacityProfile.endWeek + 1}</>
                            : <span className="italic">No fixed window</span>
                          }
                        </div>
                      )}
                      {resource.allocation.capacityProfile.segments.length > 0 && (
                        <div className="text-[10px] text-gray-500 dark:text-gray-400">
                          Profile: {resource.allocation.capacityProfile.segments.map((seg, i) => (
                            <span key={i}>
                              {i > 0 && <span className="mx-1">·</span>}
                              W{seg.startWeek + 1}-W{seg.endWeek + 1}: {seg.capacityPercent}%
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                  <div className="mt-1">
                    {isProtectedOwner(resource) ? (
                      <a
                        href={`/projects/${projectId}/timeline?panel=squad-planner`}
                        className="text-xs text-lab3-blue hover:underline"
                      >
                        Open Squad Planner
                      </a>
                    ) : (
                      <button
                        type="button"
                        data-testid={`named-resource-profile-action-${resource.id}`}
                        onClick={() => openProfileEditor(resource)}
                        disabled={!hasEditableDraft(resource)}
                        className="text-xs text-lab3-blue hover:underline disabled:text-gray-400 disabled:no-underline"
                      >
                        {resource.allocation?.capacityProfile ? 'Edit profile' : 'Create profile'}
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}

          <button
            onClick={() => createResource.mutate()}
            disabled={createResource.isPending}
            className="text-sm text-lab3-blue hover:text-lab3-navy font-medium disabled:opacity-50"
          >
            {createResource.isPending ? 'Adding…' : '+ Add person'}
          </button>
          {/* Capacity profile editor modal */}
          {editingProfile && (
            <CapacityProfileEditorModal
              isOpen={true}
              onClose={() => setEditingProfile(null)}
              initialProfile={editingProfile.initialProfile}
              isPersisted={editingProfile.isPersisted}
              ownerKind={editingProfile.ownerKind}
              ownerId={editingProfile.ownerId}
              projectId={projectId}
              onSaved={() => void 0}
              onCancel={() => setEditingProfile(null)}
            />
          )}
        </div>
      </td>
    </tr>
  )
}
