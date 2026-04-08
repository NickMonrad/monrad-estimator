import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../../lib/api'

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
}

export default function NamedResourcesPanel({
  projectId,
  rtId,
  rtCount,
  columnCount,
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
      <td colSpan={columnCount} className="px-10 py-4 bg-gray-50 dark:bg-gray-700 border-b border-gray-100 dark:border-gray-700">
        <div className="space-y-3">
          <h4 className="text-xs font-semibold text-gray-600 dark:text-gray-400 uppercase tracking-wide">
            Named Resources
          </h4>

          {isLoading ? (
            <p className="text-sm text-gray-400 dark:text-gray-500">Loading…</p>
          ) : resources.length === 0 ? (
            <p className="text-sm text-gray-500 dark:text-gray-400">
              No named resources — using aggregate count ({rtCount})
            </p>
          ) : (
            <div className="space-y-0.5">
              <div className="grid grid-cols-[1fr_110px_110px_80px_140px_28px] gap-2 text-xs font-medium text-gray-500 dark:text-gray-400 px-2 py-1">
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
                  className="grid grid-cols-[1fr_110px_110px_80px_140px_28px] gap-2 items-center px-2 py-0.5 rounded hover:bg-gray-100 dark:hover:bg-gray-700"
                >
                  <input
                    type="text"
                    defaultValue={r.name}
                    onBlur={(e) => {
                      const val = e.target.value.trim()
                      if (val && val !== r.name)
                        updateResource.mutate({ id: r.id, name: val })
                    }}
                    className="border border-gray-200 dark:border-gray-600 rounded px-2 py-1 text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-400 focus:outline-none focus:ring-1 focus:ring-lab3-blue w-full"
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
                    className="border border-gray-200 dark:border-gray-600 rounded px-2 py-1 text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-400 focus:outline-none focus:ring-1 focus:ring-lab3-blue w-full"
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
                    className="border border-gray-200 dark:border-gray-600 rounded px-2 py-1 text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-400 focus:outline-none focus:ring-1 focus:ring-lab3-blue w-full"
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
                    className="border border-gray-200 dark:border-gray-600 rounded px-2 py-1 text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-400 focus:outline-none focus:ring-1 focus:ring-lab3-blue w-full"
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
                    className="border border-gray-200 dark:border-gray-600 rounded px-2 py-1 text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-400 focus:outline-none focus:ring-1 focus:ring-lab3-blue w-full"
                  >
                    <option value="ACTUAL_DAYS">Actual Days</option>
                    <option value="PRO_RATA">Pro-rata</option>
                  </select>
                  <button
                    onClick={() => deleteResource.mutate(r.id)}
                    className="text-gray-400 dark:text-gray-500 hover:text-red-600 text-lg leading-none"
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
            className="text-sm text-lab3-blue hover:text-lab3-navy font-medium disabled:opacity-50"
          >
            {createResource.isPending ? 'Adding…' : '+ Add person'}
          </button>
        </div>
      </td>
    </tr>
  )
}
