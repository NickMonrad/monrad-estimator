import { invalidateProjectResourceProfile } from '@/lib/projectInvalidation'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../../lib/api'
import type { ResourceProfileRow } from '../../types/backlog'

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
    ...resources.map(resource => ({
      ...resource,
      allocation: allocationById.get(resource.id),
      persisted: true,
    })),
    ...allocations
      .filter(allocation => !resources.some(resource => resource.id === allocation.id))
      .map(allocation => ({
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
        persisted: false,
      })),
  ]

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
                <div
                  key={resource.id}
                  className="grid grid-cols-[1fr_110px_110px_80px_150px_minmax(180px,1fr)_28px] gap-2 items-center px-2 py-0.5 rounded hover:bg-gray-100 dark:hover:bg-gray-700"
                >
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
                    disabled={!resource.persisted}
                    className="border border-gray-200 dark:border-gray-600 rounded px-2 py-1 text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-400 focus:outline-none focus:ring-1 focus:ring-lab3-blue w-full disabled:opacity-60"
                  />
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
                        updateResource.mutate({ id: resource.id, startWeek: value })
                      }
                    }}
                    disabled={!resource.persisted}
                    className="border border-gray-200 dark:border-gray-600 rounded px-2 py-1 text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-400 focus:outline-none focus:ring-1 focus:ring-lab3-blue w-full disabled:opacity-60"
                  />
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
                        updateResource.mutate({ id: resource.id, endWeek: value })
                      }
                    }}
                    disabled={!resource.persisted}
                    className="border border-gray-200 dark:border-gray-600 rounded px-2 py-1 text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-400 focus:outline-none focus:ring-1 focus:ring-lab3-blue w-full disabled:opacity-60"
                  />
                  <input
                    type="number"
                    min={0}
                    max={100}
                    defaultValue={resource.allocationPct}
                    onBlur={(e) => {
                      if (!resource.persisted) return
                      const value = parseInt(e.target.value, 10)
                      if (
                        !isNaN(value) &&
                        value >= 0 &&
                        value <= 100 &&
                        value !== resource.allocationPct
                      ) {
                        updateResource.mutate({ id: resource.id, allocationPct: value })
                      }
                    }}
                    disabled={!resource.persisted}
                    className="border border-gray-200 dark:border-gray-600 rounded px-2 py-1 text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-400 focus:outline-none focus:ring-1 focus:ring-lab3-blue w-full disabled:opacity-60"
                  />
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
                    disabled={!resource.persisted}
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
                    onClick={() => resource.persisted && deleteResource.mutate(resource.id)}
                    disabled={!resource.persisted}
                    className="text-gray-400 dark:text-gray-500 hover:text-red-600 text-lg leading-none disabled:opacity-30"
                    title={resource.persisted ? 'Delete' : 'Generated slot'}
                  >
                    x
                  </button>
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
        </div>
      </td>
    </tr>
  )
}
