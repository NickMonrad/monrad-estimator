import { useState, useEffect, useCallback } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../../lib/api'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PeriodResource {
  resourceTypeId: string
  resourceTypeName: string
  headcount: number
  peakDemandFTE: number
  avgDemandFTE: number
  utilisationPct: number
  cost: number
}

interface Period {
  periodIndex: number
  startWeek: number
  endWeek: number
  resources: PeriodResource[]
}

interface CapacityPlanResult {
  deliveryWeeks: number
  totalCost: number
  peakHeadcount: number
  avgUtilisationPct: number
  periods: Period[]
  levellingResult?: {
    epicStartWeeks: Record<string, number>
    featureStartWeeks: Record<string, number>
    totalDeliveryWeeks: number
    peakUtilisationPct: number
  }
  plannedResourceTypeIds?: string[]
}

interface Props {
  projectId: string
  open: boolean
  onClose: () => void
  resourceTypes: Array<{ id: string; name: string; count: number }>
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmtCost(n: number) {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `$${Math.round(n).toLocaleString()}`
  return `$${n}`
}

function utilClass(pct: number) {
  if (pct >= 80) return 'bg-green-50 text-green-700 dark:bg-green-900/30 dark:text-green-300'
  if (pct >= 50) return 'bg-amber-50 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300'
  return 'bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-300'
}

function periodLabel(startWeek: number, _endWeek: number, periodWeeks: number) {
  if (periodWeeks === 13) {
    const q = Math.floor(startWeek / 13) + 1
    return `Q${q}`
  }
  const m = Math.floor(startWeek / 4) + 1
  return `M${m}`
}

function exportCsv(result: CapacityPlanResult, periodWeeks: number) {
  const rows: string[] = [
    'Period,Start Week,End Week,Resource Type,Headcount,Peak Demand FTE,Avg Demand FTE,Utilisation %,Cost',
  ]
  for (const p of result.periods) {
    const label = periodLabel(p.startWeek, p.endWeek, periodWeeks)
    for (const r of p.resources) {
      rows.push(
        [
          label,
          p.startWeek,
          p.endWeek,
          r.resourceTypeName,
          r.headcount,
          r.peakDemandFTE.toFixed(1),
          r.avgDemandFTE.toFixed(1),
          r.utilisationPct.toFixed(1),
          Math.round(r.cost),
        ].join(','),
      )
    }
  }
  const blob = new Blob([rows.join('\n')], { type: 'text/csv' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = 'squad-plan.csv'
  a.click()
  URL.revokeObjectURL(url)
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function SquadPlannerDrawer({ projectId, open, onClose, resourceTypes }: Props) {
  // ── state ────────────────────────────────────────────────────────────────
  const [targetMonths, setTargetMonths] = useState<number>(18)
  const [customMonths, setCustomMonths] = useState<string>('')
  const [periodWeeks, setPeriodWeeks] = useState<4 | 13>(13)
  const [maxDelta, setMaxDelta] = useState(1)
  const [bufferPct, setBufferPct] = useState<number>(20)
  const [minFloor, setMinFloor] = useState<Record<string, number>>({})
  const [maxCap, setMaxCap] = useState<Record<string, number>>({})
  const [maxParallelism, setMaxParallelism] = useState<number>(2)
  const [maxConcurrentEpics, setMaxConcurrentEpics] = useState<number>(6)
  const [error, setError] = useState<string | null>(null)

  const qc = useQueryClient()

  const effectiveMonths = customMonths ? Number(customMonths) : targetMonths
  const targetWeeks = Math.round(effectiveMonths * 4.33)

  // ── reset state when drawer opens ────────────────────────────────────────
  useEffect(() => {
    if (open) {
      setTargetMonths(18)
      setCustomMonths('')
      setPeriodWeeks(13)
      setMaxDelta(1)
      setBufferPct(20)
      setMaxParallelism(2)
      setMaxConcurrentEpics(6)
      setError(null)
      generate.reset()

      const floor: Record<string, number> = {}
      for (const rt of resourceTypes) {
        floor[rt.id] = 1
      }
      setMinFloor(floor)
      setMaxCap({})
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, resourceTypes])

  // ── ESC to close ────────────────────────────────────────────────────────
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    },
    [onClose],
  )
  useEffect(() => {
    if (open) {
      document.addEventListener('keydown', handleKeyDown)
      return () => document.removeEventListener('keydown', handleKeyDown)
    }
  }, [open, handleKeyDown])

  // ── generate mutation ───────────────────────────────────────────────────
  const generate = useMutation({
    mutationFn: () =>
      api
        .post(`/projects/${projectId}/squad-plan`, {
          targetDurationWeeks: targetWeeks,
          periodWeeks,
          maxDeltaPerPeriod: maxDelta,
          maxAllocationBufferPct: bufferPct / 100,
          maxParallelismPerFeature: maxParallelism,
          maxConcurrentEpics,
          minFloor,
          maxCap: Object.keys(maxCap).length > 0 ? maxCap : undefined,
        })
        .then(r => r.data as CapacityPlanResult),
    onError: (err: unknown) => {
      const msg =
        (err as { response?: { data?: { error?: string } } })?.response?.data?.error ??
        'Failed to generate plan'
      setError(msg)
    },
    onSuccess: () => setError(null),
  })

  // ── apply mutation ──────────────────────────────────────────────────────
  const apply = useMutation({
    mutationFn: (plan: CapacityPlanResult) =>
      api
        .post(`/projects/${projectId}/squad-plan/apply`, {
          name: `${effectiveMonths}-month plan`,
          targetWeeks,
          periodWeeks,
          maxDelta,
          periods: plan.periods.map(p => ({
            periodIndex: p.periodIndex,
            startWeek: p.startWeek,
            endWeek: p.endWeek,
            entries: p.resources.map(r => ({
              resourceTypeId: r.resourceTypeId,
              headcount: r.headcount,
              demandFTE: r.avgDemandFTE,
              utilisationPct: r.utilisationPct,
            })),
          })),
          totalCost: plan.totalCost,
          deliveryWeeks: plan.deliveryWeeks,
          levellingResult: plan.levellingResult,
          maxParallelismPerFeature: maxParallelism,
          setActive: true,
        })
        .then(r => r.data),
    onSuccess: async () => {
      await Promise.all([
        qc.refetchQueries({ queryKey: ['resource-profile', projectId] }),
        qc.refetchQueries({ queryKey: ['timeline', projectId] }),
        qc.refetchQueries({ queryKey: ['resource-types', projectId] }),
      ])
      onClose()
      setTimeout(() => alert('✅ Plan applied — timeline and resource counts updated.'), 100)
    },
    onError: (err: unknown) => {
      const msg =
        (err as { response?: { data?: { error?: string } } })?.response?.data?.error ??
        'Failed to apply plan'
      setError(msg)
    },
  })

  if (!open) return null

  const result = generate.data

  // Build unique RT names from the result for row headers
  const rtNames: string[] = result
    ? Array.from(new Set(result.periods.flatMap(p => p.resources.map(r => r.resourceTypeName))))
    : []

  // Build a quick lookup: rtName → periodIndex → resource
  const lookup = new Map<string, Map<number, PeriodResource>>()
  if (result) {
    for (const p of result.periods) {
      for (const r of p.resources) {
        if (!lookup.has(r.resourceTypeName)) lookup.set(r.resourceTypeName, new Map())
        lookup.get(r.resourceTypeName)!.set(p.periodIndex, r)
      }
    }
  }

  const presetMonths = [12, 18, 24] as const

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/40 z-40"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Drawer panel */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Squad Planner"
        className="fixed inset-y-0 right-0 w-[480px] bg-white dark:bg-gray-800 shadow-2xl z-50 flex flex-col"
      >
        {/* ── Header ── */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 dark:border-gray-700 flex-shrink-0">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white">👥 Squad Planner</h2>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 text-xl leading-none"
            aria-label="Close"
          >
            ×
          </button>
        </div>

        {/* ── Scrollable body ── */}
        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-5">

          {/* Target Duration */}
          <div>
            <label className="text-xs font-semibold text-gray-700 dark:text-gray-300 mb-2 block">
              Target Duration
            </label>
            <div className="flex rounded-lg border border-gray-200 dark:border-gray-600 overflow-hidden">
              {presetMonths.map(m => (
                <button
                  key={m}
                  onClick={() => { setTargetMonths(m); setCustomMonths('') }}
                  className={`flex-1 py-1.5 text-sm font-medium transition-colors ${
                    !customMonths && targetMonths === m
                      ? 'bg-lab3-navy text-white'
                      : 'text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700'
                  }`}
                >
                  {m}mo
                </button>
              ))}
              <input
                type="number"
                min={3}
                max={60}
                placeholder="Custom"
                value={customMonths}
                onChange={e => setCustomMonths(e.target.value)}
                className="w-20 border-l border-gray-200 dark:border-gray-600 px-2 py-1.5 text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white placeholder-gray-400 focus:outline-none focus:ring-1 focus:ring-lab3-blue"
              />
            </div>
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              ≈ {targetWeeks} weeks
            </p>
          </div>

          {/* Change Frequency */}
          <div>
            <label className="text-xs font-semibold text-gray-700 dark:text-gray-300 mb-2 block">
              Change Frequency
            </label>
            <div className="flex rounded-lg border border-gray-200 dark:border-gray-600 overflow-hidden">
              {([
                { value: 4 as const, label: 'Monthly' },
                { value: 13 as const, label: 'Quarterly' },
              ]).map(opt => (
                <button
                  key={opt.value}
                  onClick={() => setPeriodWeeks(opt.value)}
                  className={`flex-1 py-1.5 text-sm font-medium transition-colors ${
                    periodWeeks === opt.value
                      ? 'bg-lab3-navy text-white'
                      : 'text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          {/* Max Scaling */}
          <div>
            <label className="text-xs font-semibold text-gray-700 dark:text-gray-300 mb-2 block">
              Max Scaling (per period)
            </label>
            <div className="flex items-center gap-2">
              <span className="text-sm text-gray-500 dark:text-gray-400">±</span>
              <select
                value={maxDelta}
                onChange={e => setMaxDelta(Number(e.target.value))}
                className="border border-gray-200 dark:border-gray-600 rounded px-3 py-1.5 text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:outline-none focus:ring-1 focus:ring-lab3-blue"
              >
                {[1, 2, 3, 4, 5].map(n => (
                  <option key={n} value={n}>{n}</option>
                ))}
              </select>
              <span className="text-xs text-gray-500 dark:text-gray-400">people per RT per period</span>
            </div>
          </div>

          {/* Allocation Buffer */}
          <div>
            <label className="text-xs font-semibold text-gray-700 dark:text-gray-300 mb-2 block">
              Max Over-allocation Buffer
            </label>
            <div className="flex items-center gap-2">
              <select
                value={bufferPct}
                onChange={e => setBufferPct(Number(e.target.value))}
                className="border border-gray-200 dark:border-gray-600 rounded px-3 py-1.5 text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:outline-none focus:ring-1 focus:ring-lab3-blue"
              >
                {[10, 15, 20, 25, 30, 40, 50].map(n => (
                  <option key={n} value={n}>{n}%</option>
                ))}
              </select>
              <span className="text-xs text-gray-500 dark:text-gray-400">above backlog effort per RT</span>
            </div>
          </div>

          {/* Max Parallelism per Feature */}
          <div>
            <label className="text-xs font-semibold text-gray-700 dark:text-gray-300 mb-2 block">
              Max People per Feature
            </label>
            <div className="flex items-center gap-2">
              <select
                value={maxParallelism}
                onChange={e => setMaxParallelism(Number(e.target.value))}
                className="border border-gray-200 dark:border-gray-600 rounded px-3 py-1.5 text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:outline-none focus:ring-1 focus:ring-lab3-blue"
              >
                {[1, 2, 3, 4, 5, 6].map(n => (
                  <option key={n} value={n}>{n}</option>
                ))}
              </select>
              <span className="text-xs text-gray-500 dark:text-gray-400">per RT per feature (flattens demand)</span>
            </div>
          </div>

          {/* Max Concurrent Epics */}
          <div>
            <label className="text-xs font-semibold text-gray-700 dark:text-gray-300 mb-2 block">
              Max Concurrent Epics
            </label>
            <div className="flex items-center gap-2">
              <select
                value={maxConcurrentEpics}
                onChange={e => setMaxConcurrentEpics(Number(e.target.value))}
                className="border border-gray-200 dark:border-gray-600 rounded px-3 py-1.5 text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:outline-none focus:ring-1 focus:ring-lab3-blue"
              >
                {[2, 3, 4, 5, 6, 8, 10, 12].map(n => (
                  <option key={n} value={n}>{n}</option>
                ))}
              </select>
              <span className="text-xs text-gray-500 dark:text-gray-400">epics active at the same time</span>
            </div>
          </div>

          {/* RT Constraints (min/max) */}
          <div>
            <label className="text-xs font-semibold text-gray-700 dark:text-gray-300 mb-2 block">
              RT Constraints (Min / Max)
            </label>
            <div className="space-y-2">
              {resourceTypes.map(rt => (
                <div key={rt.id} className="flex items-center gap-2">
                  <span className="flex-1 text-sm text-gray-700 dark:text-gray-300 truncate" title={rt.name}>
                    {rt.name}
                  </span>
                  <input
                    type="number"
                    min={0}
                    max={20}
                    value={minFloor[rt.id] ?? 1}
                    onChange={e =>
                      setMinFloor(prev => ({ ...prev, [rt.id]: Math.max(0, Number(e.target.value)) }))
                    }
                    title="Min headcount"
                    className="w-14 border border-gray-200 dark:border-gray-600 rounded px-2 py-1 text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-center focus:outline-none focus:ring-1 focus:ring-lab3-blue"
                  />
                  <span className="text-xs text-gray-400">–</span>
                  <input
                    type="number"
                    min={0}
                    max={20}
                    placeholder="∞"
                    value={maxCap[rt.id] ?? ''}
                    onChange={e => {
                      const val = e.target.value
                      setMaxCap(prev => {
                        if (!val || Number(val) <= 0) {
                          const next = { ...prev }
                          delete next[rt.id]
                          return next
                        }
                        return { ...prev, [rt.id]: Number(val) }
                      })
                    }}
                    title="Max headcount (blank = no limit)"
                    className="w-14 border border-gray-200 dark:border-gray-600 rounded px-2 py-1 text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-center placeholder-gray-400 focus:outline-none focus:ring-1 focus:ring-lab3-blue"
                  />
                </div>
              ))}
            </div>
            <p className="mt-1 text-[10px] text-gray-400 dark:text-gray-500">
              Left = minimum headcount · Right = maximum (blank = no limit)
            </p>
          </div>

          {/* Generate button */}
          <button
            onClick={() => { setError(null); generate.mutate() }}
            disabled={generate.isPending || effectiveMonths < 1}
            className="w-full bg-lab3-navy text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-lab3-blue disabled:opacity-50 transition-colors"
          >
            {generate.isPending ? 'Generating…' : '▶ Generate Plan'}
          </button>

          {/* Error */}
          {error && (
            <div className="rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 p-3 text-sm text-red-700 dark:text-red-300">
              {error}
            </div>
          )}

          {/* ── Results ── */}
          {result && (
            <div className="space-y-4">
              {/* Summary KPIs */}
              <div>
                <div className="text-xs font-semibold text-gray-700 dark:text-gray-300 mb-2">Summary</div>
                <div className="grid grid-cols-2 gap-2">
                  <div className="rounded-lg border border-gray-200 dark:border-gray-700 px-3 py-2">
                    <div className="text-[10px] text-gray-500 dark:text-gray-400 uppercase tracking-wide">Peak</div>
                    <div className="text-sm font-semibold text-gray-900 dark:text-white">📊 {result.peakHeadcount} people</div>
                  </div>
                  <div className="rounded-lg border border-gray-200 dark:border-gray-700 px-3 py-2">
                    <div className="text-[10px] text-gray-500 dark:text-gray-400 uppercase tracking-wide">Delivery</div>
                    <div className="text-sm font-semibold text-gray-900 dark:text-white">📅 {result.deliveryWeeks} weeks</div>
                  </div>
                  <div className="rounded-lg border border-gray-200 dark:border-gray-700 px-3 py-2">
                    <div className="text-[10px] text-gray-500 dark:text-gray-400 uppercase tracking-wide">Cost</div>
                    <div className="text-sm font-semibold text-gray-900 dark:text-white">💰 {fmtCost(result.totalCost)}</div>
                  </div>
                  <div className="rounded-lg border border-gray-200 dark:border-gray-700 px-3 py-2">
                    <div className="text-[10px] text-gray-500 dark:text-gray-400 uppercase tracking-wide">Avg Utilisation</div>
                    <div className="text-sm font-semibold text-gray-900 dark:text-white">📈 {result.avgUtilisationPct.toFixed(0)}%</div>
                  </div>
                </div>
              </div>

              {/* Capacity Plan Table */}
              <div>
                <div className="text-xs font-semibold text-gray-700 dark:text-gray-300 mb-2">Capacity Plan</div>
                <div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-700">
                  <table className="min-w-full text-xs">
                    <thead>
                      <tr className="bg-gray-50 dark:bg-gray-700">
                        <th className="text-left px-2 py-1.5 font-medium text-gray-600 dark:text-gray-300 sticky left-0 bg-gray-50 dark:bg-gray-700 z-10">
                          RT
                        </th>
                        {result.periods.map(p => (
                          <th
                            key={p.periodIndex}
                            className="text-center px-2 py-1.5 font-medium text-gray-600 dark:text-gray-300 whitespace-nowrap"
                          >
                            {periodLabel(p.startWeek, p.endWeek, periodWeeks)}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {rtNames.map((rtName, idx) => (
                        <tr
                          key={rtName}
                          className={idx % 2 === 0 ? 'bg-white dark:bg-gray-800' : 'bg-gray-50/50 dark:bg-gray-750'}
                        >
                          <td
                            className="px-2 py-1.5 font-medium text-gray-700 dark:text-gray-300 truncate max-w-[140px] sticky left-0 bg-inherit z-10"
                            title={rtName}
                          >
                            {rtName}
                          </td>
                          {result.periods.map(p => {
                            const cell = lookup.get(rtName)?.get(p.periodIndex)
                            if (!cell) {
                              return (
                                <td key={p.periodIndex} className="text-center px-2 py-1.5 text-gray-400">
                                  —
                                </td>
                              )
                            }
                            return (
                              <td
                                key={p.periodIndex}
                                className={`text-center px-2 py-1.5 font-medium ${utilClass(cell.utilisationPct)}`}
                                title={`${cell.headcount} HC · ${cell.utilisationPct.toFixed(0)}% util`}
                              >
                                {cell.headcount}
                              </td>
                            )
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="mt-1 text-[10px] text-gray-400 dark:text-gray-500">
                  Cell colour: <span className="text-green-600">≥80%</span> · <span className="text-amber-600">50-79%</span> · <span className="text-red-600">&lt;50%</span> utilisation
                </p>
              </div>

              {/* Action buttons */}
              <div className="flex gap-2">
                <button
                  onClick={() => {
                    if (!window.confirm('Apply this plan? Resource profiles will be updated.')) return
                    apply.mutate(result)
                  }}
                  disabled={apply.isPending}
                  className="flex-1 bg-lab3-navy text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-lab3-blue disabled:opacity-50 transition-colors"
                >
                  {apply.isPending ? 'Applying…' : '✓ Apply Plan'}
                </button>
                <button
                  onClick={() => exportCsv(result, periodWeeks)}
                  className="border border-gray-200 dark:border-gray-600 text-gray-600 dark:text-gray-300 px-4 py-2 rounded-lg text-sm font-medium hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
                >
                  📥 Export CSV
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  )
}
