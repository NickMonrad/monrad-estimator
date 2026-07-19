import { useState, useEffect, useCallback, useRef } from 'react'
import { useMutation } from '@tanstack/react-query'
import {
  runOptimiser,
  applyOptimiserScenario,
  type OptimiserResponse,
  type OptimiserCandidate,
} from '../../lib/api'
import {
  getPlannerResourceTypeVisibility,
  getStartingTeamFinderDefaultRange,
} from './timelineUx'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CountRange {
  min: number
  max: number
}

interface Props {
  projectId: string
  open: boolean
  onClose: () => void
  resourceTypes: Array<{ id: string; name: string; count: number }>
  fallbackPlannedResourceTypeIds?: string[]
  onApplied: (snapshotId: string) => void
  onRefineScenario: (
    candidate: OptimiserCandidate,
    options: { allowRampUp: boolean; seedResourceTypeIds: string[] },
  ) => void
}

type Mode = 'speed' | 'utilisation' | 'balanced'

function buildResourceTypesKey(resourceTypes: Props['resourceTypes']) {
  return resourceTypes.map(rt => `${rt.id}:${rt.name}:${rt.count}`).join('|')
}

function buildIdListKey(ids?: string[]) {
  return (ids ?? []).join('|')
}

function buildDefaultCountRanges(
  resourceTypes: Props['resourceTypes'],
  fallbackPlannedResourceTypeIds?: string[],
) {
  const defaultVisibility = getPlannerResourceTypeVisibility(
    resourceTypes,
    fallbackPlannedResourceTypeIds,
    false,
  )
  const ranges = new Map<string, CountRange>()

  for (const rt of defaultVisibility.visibleResourceTypes) {
    ranges.set(rt.id, getStartingTeamFinderDefaultRange(rt.count))
  }

  return ranges
}

const MODE_LABELS: Record<Mode, string> = {
  speed: 'Speed',
  utilisation: 'Utilisation',
  balanced: 'Balanced',
}

const MODE_DESCRIPTIONS: Record<Mode, string> = {
  speed: 'Minimise delivery weeks',
  utilisation: 'Maximise resource utilisation',
  balanced: 'Best mix of speed, utilisation, and cost',
}

// ---------------------------------------------------------------------------
// Helper formatters
// ---------------------------------------------------------------------------

function fmtCost(n: number) {
  return `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })} AUD`
}

function fmtDelta(n: number, unit = '') {
  const sign = n < 0 ? '−' : '+'
  return `${sign}${Math.abs(n).toLocaleString(undefined, { maximumFractionDigits: 1 })}${unit}`
}

// ---------------------------------------------------------------------------
// KPI tile
// ---------------------------------------------------------------------------

function KpiTile({
  label,
  value,
  delta,
  deltaGoodWhenNegative,
}: {
  label: string
  value: string
  delta: string
  deltaGoodWhenNegative: boolean
}) {
  const numeric = parseFloat(delta.replace('−', '-').replace('+', ''))
  const isNegative = numeric < 0
  const isGood = deltaGoodWhenNegative ? isNegative : !isNegative
  const deltaColour =
    numeric === 0
      ? 'text-gray-400 dark:text-gray-500'
      : isGood
        ? 'text-green-600 dark:text-green-400'
        : 'text-red-600 dark:text-red-400'

  return (
    <div className="flex-1 rounded-lg border border-gray-200 dark:border-gray-700 px-3 py-2 text-center">
      <div className="text-[10px] text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-0.5">{label}</div>
      <div className="text-sm font-semibold text-gray-900 dark:text-white">{value}</div>
      <div className={`text-xs font-medium ${deltaColour}`}>{delta}</div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Candidate card
// ---------------------------------------------------------------------------

function CandidateCard({
  candidate,
  rank,
  baseline,
  rtNameMap,
  baselineRtMap,
  allowRampUp,
  projectId,
  rampUpScopeResourceTypeIds,
  onApplied,
  onRefineScenario,
}: {
  candidate: OptimiserCandidate
  rank: number
  baseline: OptimiserCandidate
  rtNameMap: Map<string, string>
  baselineRtMap: Map<string, { count: number; suggestedStartWeek: number }>
  allowRampUp: boolean
  projectId: string
  rampUpScopeResourceTypeIds: string[]
  onApplied: (snapshotId: string) => void
  onRefineScenario: (candidate: OptimiserCandidate) => void
}) {
  const [applyError, setApplyError] = useState<string | null>(null)
  const [staggerEpics, setStaggerEpics] = useState(true)

  const applyMutation = useMutation({
    mutationFn: () => applyOptimiserScenario(projectId, candidate.resourceTypes, {
      rampUpScopeResourceTypeIds,
      staggerEpics,
    }),
    onSuccess: (data) => {
      onApplied(data.snapshotId)
    },
    onError: (err: unknown) => {
      const msg =
        (err as { response?: { data?: { error?: string } } })?.response?.data?.error ??
        'Failed to apply starting team'
      setApplyError(msg)
    },
  })

  const handleApply = () => {
    if (
      !window.confirm(
        'Use this starting team? The current state will be auto-snapshotted so you can roll back.',
      )
    )
      return
    setApplyError(null)
    applyMutation.mutate()
  }

  // Deltas
  const deltaWeeks = candidate.metrics.deliveryWeeks - baseline.metrics.deliveryWeeks
  const deltaUtil = candidate.metrics.avgUtilisationPct - baseline.metrics.avgUtilisationPct
  const deltaCost = candidate.metrics.estimatedCost - baseline.metrics.estimatedCost
  const showCost = !(candidate.metrics.estimatedCost === 0 && baseline.metrics.estimatedCost === 0)

  // Diffs vs baseline
  const changedRts = candidate.resourceTypes.filter(rt => {
    const base = baselineRtMap.get(rt.resourceTypeId)
    return base === undefined || base.count !== rt.count
  })

  // Ramp-up suggestions
  const rampUps = allowRampUp
    ? candidate.resourceTypes.filter(rt => rt.suggestedStartWeek > 0)
    : []

  return (
    <div className="border border-gray-200 dark:border-gray-700 rounded-xl p-4 space-y-3 bg-white dark:bg-gray-800">
      {/* Header row */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="inline-flex items-center justify-center w-7 h-7 rounded-full bg-lab3-navy text-white text-xs font-bold">
            #{rank}
          </span>
          <span className="text-xs text-gray-400 dark:text-gray-500">
            score {candidate.score.toFixed(3)}
          </span>
          {/* All returned candidates are guaranteed feasible by the optimiser filter */}
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-300 text-[10px] font-medium">
            ✓ Feasible
          </span>
        </div>
      </div>

      {/* KPI tiles */}
      <div className="flex gap-2">
        <KpiTile
          label="Delivery"
          value={`${candidate.metrics.deliveryWeeks} wks`}
          delta={deltaWeeks === 0 ? '±0 wks' : `${fmtDelta(deltaWeeks)} wks`}
          deltaGoodWhenNegative={true}
        />
        <KpiTile
          label="Utilisation"
          value={`${candidate.metrics.avgUtilisationPct.toFixed(1)}%`}
          delta={deltaUtil === 0 ? '±0%' : `${fmtDelta(deltaUtil, '%')}`}
          deltaGoodWhenNegative={false}
        />
        {showCost && (
          <KpiTile
            label="Cost"
            value={fmtCost(candidate.metrics.estimatedCost)}
            delta={deltaCost === 0 ? '±$0' : fmtDelta(deltaCost)}
            deltaGoodWhenNegative={true}
          />
        )}
      </div>

      {/* Resource count changes */}
      {changedRts.length > 0 && (
        <div>
          <div className="text-[10px] text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-1">
            Starting team changes
          </div>
          <div className="flex flex-wrap gap-x-3 gap-y-1">
            {changedRts.map(rt => {
              const baseCt = baselineRtMap.get(rt.resourceTypeId)?.count ?? 0
              const name = rtNameMap.get(rt.resourceTypeId) ?? rt.resourceTypeId
              return (
                <span key={rt.resourceTypeId} className="text-xs text-gray-700 dark:text-gray-300">
                  {name}: {baseCt} → {rt.count}
                </span>
              )
            })}
          </div>
        </div>
      )}

      {/* Ramp-up suggestions */}
      {rampUps.length > 0 && (
        <div>
          <div className="text-[10px] text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-1">
            Later ramp-up ideas
          </div>
          <div className="flex flex-wrap gap-x-3 gap-y-1">
            {rampUps.map(rt => {
              const name = rtNameMap.get(rt.resourceTypeId) ?? rt.resourceTypeId
              return (
                <span key={rt.resourceTypeId} className="text-xs text-gray-700 dark:text-gray-300">
                  {name}: start week {rt.suggestedStartWeek}
                </span>
              )
            })}
          </div>
        </div>
      )}

      {/* Error */}
      {applyError && (
        <p className="text-xs text-red-600 dark:text-red-400">{applyError}</p>
      )}

      {/* Apply section */}
      <div className="pt-1 space-y-3">
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={staggerEpics}
            onChange={e => setStaggerEpics(e.target.checked)}
            className="rounded"
          />
          <span className="text-xs text-gray-600 dark:text-gray-400">
            Stagger epics to level demand before planning
          </span>
        </label>
        <div className="flex items-center justify-end gap-2">
          <button
            onClick={() => onRefineScenario(candidate)}
            className="bg-red-600 hover:bg-red-700 text-white px-3 py-1.5 rounded text-xs font-medium transition-colors"
          >
            Refine in Squad Planner
          </button>
          <button
            onClick={handleApply}
            disabled={applyMutation.isPending}
            className="border border-gray-200 dark:border-gray-600 text-gray-700 dark:text-gray-200 px-3 py-1.5 rounded text-xs font-medium hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50 transition-colors"
          >
            {applyMutation.isPending ? 'Applying…' : 'Apply directly'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Baseline card
// ---------------------------------------------------------------------------

function BaselineCard({ baseline, showCost }: { baseline: OptimiserCandidate; showCost: boolean }) {
  const totalGapWeeks = Object.values(baseline.metrics.gapWeeksByResourceTypeId).reduce(
    (s, v) => s + v,
    0,
  )
  const warnCount = baseline.metrics.parallelWarningCount
  return (
    <div className="border border-gray-200 dark:border-gray-200/30 rounded-xl p-3 bg-gray-50 dark:bg-gray-700/40 space-y-1">
      <div className="flex items-center justify-between mb-2">
        <div className="text-xs font-medium text-gray-600 dark:text-gray-300">
          Current starting point
        </div>
        {warnCount === 0 ? (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-300 text-[10px] font-medium">
            ✓ Feasible
          </span>
        ) : (
          <span
            title="Some parallel-mode epics exceed capacity at this configuration"
            className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300 text-[10px] font-medium cursor-help"
          >
            ⚠ {warnCount} over-allocation{warnCount > 1 ? 's' : ''}
          </span>
        )}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-700 dark:text-gray-300">
        <span>🗓 {baseline.metrics.deliveryWeeks} weeks delivery</span>
        <span>⚡ {baseline.metrics.avgUtilisationPct.toFixed(1)}% utilisation</span>
        {showCost && baseline.metrics.estimatedCost > 0 && (
          <span>💰 {fmtCost(baseline.metrics.estimatedCost)} squad cost</span>
        )}
        {totalGapWeeks > 0 && (
          <span>⏳ {totalGapWeeks.toFixed(1)} gap wks</span>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main drawer
// ---------------------------------------------------------------------------

export default function TimelineOptimiserDrawer({
  projectId,
  open,
  onClose,
  resourceTypes,
  fallbackPlannedResourceTypeIds,
  onApplied,
  onRefineScenario,
}: Props) {
  // ── local state ──────────────────────────────────────────────────────────
  const [mode, setMode] = useState<Mode>('balanced')
  const [countRanges, setCountRanges] = useState<Map<string, CountRange>>(new Map())
  const [lastRunScopeResourceTypeIds, setLastRunScopeResourceTypeIds] = useState<string[]>([])
  const pendingRunScopeRef = useRef<string[]>([])
  const [allowRampUp, setAllowRampUp] = useState(false)
  const [maxBudget, setMaxBudget] = useState('')
  const [maxDurationWeeks, setMaxDurationWeeks] = useState('')
  const [minDurationWeeks, setMinDurationWeeks] = useState('')
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [lastResult, setLastResult] = useState<OptimiserResponse | null>(null)
  const [runError, setRunError] = useState<string | null>(null)
  const [showAllResourceTypes, setShowAllResourceTypes] = useState(false)
  const wasOpenRef = useRef(false)
  const lastRestoreSeedRef = useRef<string | null>(null)
  const restoreSeed = `${projectId}::${buildResourceTypesKey(resourceTypes)}::${buildIdListKey(fallbackPlannedResourceTypeIds)}`

  const resetSettings = useCallback(() => {
    setMode('balanced')
    setAllowRampUp(false)
    setMaxBudget('')
    setMaxDurationWeeks('')
    setMinDurationWeeks('')
    setAdvancedOpen(false)
    setRunError(null)
    setLastResult(null)
    setShowAllResourceTypes(false)
    setCountRanges(buildDefaultCountRanges(resourceTypes, fallbackPlannedResourceTypeIds))
  }, [fallbackPlannedResourceTypeIds, resourceTypes])

  // ── initialise / reset when drawer opens ─────────────────────────────────
  useEffect(() => {
    const opened = open && !wasOpenRef.current
    const restoreSeedChanged = open && wasOpenRef.current && lastRestoreSeedRef.current !== restoreSeed

    if (opened || restoreSeedChanged) {
      resetSettings()
      lastRestoreSeedRef.current = restoreSeed
    }

    if (!open) {
      lastRestoreSeedRef.current = restoreSeed
    }

    wasOpenRef.current = open
  }, [open, resetSettings, restoreSeed])

  // ── ESC to close ──────────────────────────────────────────────────────────
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

  const defaultVisibility = getPlannerResourceTypeVisibility(
    resourceTypes,
    fallbackPlannedResourceTypeIds,
    false,
  )
  const { visibleResourceTypes, isFiltered } = getPlannerResourceTypeVisibility(
    resourceTypes,
    fallbackPlannedResourceTypeIds,
    showAllResourceTypes,
  )

  useEffect(() => {
    if (!open || visibleResourceTypes.length === 0) return

    setCountRanges(prev => {
      let changed = false
      const next = new Map(prev)

      for (const rt of visibleResourceTypes) {
        if (!next.has(rt.id)) {
          next.set(rt.id, getStartingTeamFinderDefaultRange(rt.count))
          changed = true
        }
      }

      return changed ? next : prev
    })
  }, [open, visibleResourceTypes])

  // ── run mutation ──────────────────────────────────────────────────────────
  const runMutation = useMutation({
    mutationFn: () => {
      const countRangesArr = visibleResourceTypes.map(rt => {
        const range = countRanges.get(rt.id) ?? getStartingTeamFinderDefaultRange(rt.count)
        return {
          resourceTypeId: rt.id,
          min: range.min,
          max: range.max,
        }
      })
      pendingRunScopeRef.current = countRangesArr.map(range => range.resourceTypeId)
      return runOptimiser(projectId, {
        mode,
        constraints: {
          countRanges: countRangesArr,
          allowRampUp,
          maxBudget: maxBudget ? Number(maxBudget) : undefined,
          maxDurationWeeks: maxDurationWeeks ? Number(maxDurationWeeks) : undefined,
          minDurationWeeks: minDurationWeeks ? Number(minDurationWeeks) : undefined,
        },
      })
    },
    onSuccess: (data) => {
      setLastResult(data)
      setLastRunScopeResourceTypeIds(pendingRunScopeRef.current)
      setRunError(null)
    },
    onError: (err: unknown) => {
      const msg =
        (err as { response?: { data?: { error?: string } } })?.response?.data?.error ??
        'Failed to find starting teams'
      setRunError(msg)
    },
  })

  // ── derived ───────────────────────────────────────────────────────────────
  const rtNameMap = new Map<string, string>(
    (lastResult?.resourceTypes ?? []).map(rt => [rt.id, rt.name]),
  )
  // Also seed from props for cases where result isn't back yet
  for (const rt of resourceTypes) {
    if (!rtNameMap.has(rt.id)) rtNameMap.set(rt.id, rt.name)
  }

  const baselineRtMap = new Map<string, { count: number; suggestedStartWeek: number }>(
    (lastResult?.baseline.resourceTypes ?? []).map(rt => [rt.resourceTypeId, rt]),
  )

  const showCost =
    !!lastResult &&
    !(
      lastResult.candidates.every(c => c.metrics.estimatedCost === 0) &&
      lastResult.baseline.metrics.estimatedCost === 0
    )

  // ── count range helpers ───────────────────────────────────────────────────
  function setRange(rtId: string, field: 'min' | 'max', raw: string) {
    const v = parseInt(raw, 10)
    if (isNaN(v) || v < 1) return
    setCountRanges(prev => {
      const next = new Map(prev)
      const resourceType = resourceTypes.find(rt => rt.id === rtId)
      const cur =
        next.get(rtId) ??
        getStartingTeamFinderDefaultRange(resourceType?.count ?? 0)
      const updated = { ...cur, [field]: v }
      if (field === 'min' && updated.min > updated.max) updated.max = updated.min
      if (field === 'max' && updated.max < updated.min) updated.min = updated.max
      next.set(rtId, updated)
      return next
    })
  }

  if (!open) return null

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
        aria-label="Starting Team Finder"
        className="fixed inset-y-0 right-0 w-[420px] bg-white dark:bg-gray-800 shadow-2xl z-50 flex flex-col"
      >
        {/* ── Header ── */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200 dark:border-gray-700 flex-shrink-0">
          <div>
            <h2 className="text-base font-semibold text-gray-900 dark:text-white">🔧 Starting Team Finder</h2>
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              Find a sensible starting squad size to use with Squad Planner.
            </p>
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={resetSettings}
              className="text-xs font-medium text-red-600 hover:text-red-700 dark:text-red-400 dark:hover:text-red-300"
            >
              Reset settings
            </button>
            <button
              onClick={onClose}
              className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 text-xl leading-none"
              aria-label="Close"
            >
              ×
            </button>
          </div>
        </div>

        {/* ── Scrollable body ── */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">

          {/* Mode selector */}
          <div>
            <div className="flex rounded-lg border border-gray-200 dark:border-gray-600 overflow-hidden">
              {(['speed', 'utilisation', 'balanced'] as Mode[]).map(m => (
                <button
                  key={m}
                  onClick={() => setMode(m)}
                  className={`flex-1 py-1.5 text-sm font-medium transition-colors ${
                    mode === m
                      ? 'bg-lab3-navy text-white'
                      : 'text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700'
                  }`}
                >
                  {MODE_LABELS[m]}
                </button>
              ))}
            </div>
            <p className="mt-1.5 text-xs text-gray-500 dark:text-gray-400">{MODE_DESCRIPTIONS[mode]}</p>
          </div>

          {/* Per-RT count ranges */}
          <div>
            <div className="mb-2 flex items-center justify-between gap-3">
              <div className="text-xs font-semibold text-gray-700 dark:text-gray-300">
                Count ranges per resource type
              </div>
              {defaultVisibility.hiddenResourceTypes.length > 0 && (
                <button
                  type="button"
                  onClick={() => setShowAllResourceTypes(prev => !prev)}
                  className="text-[11px] font-medium text-lab3-navy dark:text-lab3-blue hover:underline"
                >
                  {showAllResourceTypes
                    ? `Show demand-bearing only (${defaultVisibility.visibleResourceTypes.length})`
                    : `Show all RTs (+${defaultVisibility.hiddenResourceTypes.length} zero-demand)`}
                </button>
              )}
            </div>
            <p className="mb-3 text-[11px] leading-relaxed text-gray-500 dark:text-gray-400">
              Defaults are intentionally broad to surface candidate squads for Squad Planner:
              start at 1, then search up to the larger of current + 4 or 2× current, capped at 12.
            </p>
            <div className="space-y-2">
              {visibleResourceTypes.map(rt => {
                const range = countRanges.get(rt.id) ?? getStartingTeamFinderDefaultRange(rt.count)
                return (
                  <div key={rt.id} className="flex items-center gap-3">
                    <span className="flex-1 text-sm text-gray-700 dark:text-gray-300 truncate">
                      {rt.name}
                    </span>
                    <div className="flex items-center gap-1.5">
                      <label className="text-xs text-gray-500 dark:text-gray-400">min</label>
                      <input
                        type="number"
                        min={1}
                        value={range.min}
                        onChange={e => setRange(rt.id, 'min', e.target.value)}
                        className="w-14 border border-gray-200 dark:border-gray-600 rounded px-2 py-1 text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:outline-none focus:ring-1 focus:ring-lab3-blue"
                      />
                    </div>
                    <div className="flex items-center gap-1.5">
                      <label className="text-xs text-gray-500 dark:text-gray-400">max</label>
                      <input
                        type="number"
                        min={range.min}
                        value={range.max}
                        onChange={e => setRange(rt.id, 'max', e.target.value)}
                        className="w-14 border border-gray-200 dark:border-gray-600 rounded px-2 py-1 text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:outline-none focus:ring-1 focus:ring-lab3-blue"
                      />
                    </div>
                  </div>
                )
              })}
            </div>
            {isFiltered && defaultVisibility.hiddenResourceTypes.length > 0 && (
              <p className="mt-2 text-[10px] text-gray-500 dark:text-gray-400">
                Hidden zero-demand RTs are excluded from the search until you expand them: {defaultVisibility.hiddenResourceTypes.map(rt => rt.name).join(', ')}.
              </p>
            )}
            {visibleResourceTypes.length === 0 && (
              <p className="mt-2 text-[10px] text-amber-600 dark:text-amber-300">
                No demand-bearing resource types are currently active. Expand all RTs if you still want to explore manual scenarios.
              </p>
            )}
          </div>

          {/* Allow ramp-up toggle */}
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={allowRampUp}
              onChange={e => setAllowRampUp(e.target.checked)}
              className="rounded"
            />
            <span className="text-sm text-gray-700 dark:text-gray-300">
              Include later ramp-up suggestions
            </span>
          </label>

          {/* Advanced / optional ceilings */}
          <div>
            <button
              onClick={() => setAdvancedOpen(o => !o)}
              className="flex items-center gap-1.5 text-xs font-medium text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white"
            >
              <span>{advancedOpen ? '▾' : '▸'}</span>
              Advanced
            </button>
            {advancedOpen && (
              <div className="mt-3 space-y-3 pl-3 border-l-2 border-gray-100 dark:border-gray-700">
                <div className="flex items-center gap-3">
                  <label className="text-xs text-gray-500 dark:text-gray-400 w-36">
                    Max budget (AUD)
                  </label>
                  <input
                    type="number"
                    min={0}
                    placeholder="no limit"
                    value={maxBudget}
                    onChange={e => setMaxBudget(e.target.value)}
                    className="w-32 border border-gray-200 dark:border-gray-600 rounded px-2 py-1 text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:outline-none focus:ring-1 focus:ring-lab3-blue placeholder-gray-300"
                  />
                </div>
                <div className="flex items-center gap-3">
                  <label className="text-xs text-gray-500 dark:text-gray-400 w-36">
                    Min duration (weeks)
                  </label>
                  <input
                    type="number"
                    min={1}
                    placeholder="no limit"
                    value={minDurationWeeks}
                    onChange={e => setMinDurationWeeks(e.target.value)}
                    className="w-32 border border-gray-200 dark:border-gray-600 rounded px-2 py-1 text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:outline-none focus:ring-1 focus:ring-lab3-blue placeholder-gray-300"
                  />
                </div>
                <div className="flex items-center gap-3">
                  <label className="text-xs text-gray-500 dark:text-gray-400 w-36">
                    Max duration (weeks)
                  </label>
                  <input
                    type="number"
                    min={1}
                    placeholder="no limit"
                    value={maxDurationWeeks}
                    onChange={e => setMaxDurationWeeks(e.target.value)}
                    className="w-32 border border-gray-200 dark:border-gray-600 rounded px-2 py-1 text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:outline-none focus:ring-1 focus:ring-lab3-blue placeholder-gray-300"
                  />
                </div>
              </div>
            )}
          </div>

          {/* Run button */}
          <button
            onClick={() => runMutation.mutate()}
            disabled={runMutation.isPending || visibleResourceTypes.length === 0}
            className="w-full bg-lab3-navy hover:bg-lab3-blue text-white px-4 py-2 rounded-lg text-sm font-medium disabled:opacity-50 transition-colors"
          >
            {runMutation.isPending ? 'Finding…' : 'Find starting teams'}
          </button>

          {/* Error banner */}
          {runError && (
            <div className="bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-800 rounded-lg px-4 py-3 flex items-center justify-between gap-3">
              <p className="text-sm text-red-700 dark:text-red-300 flex-1">{runError}</p>
              <button
                onClick={() => runMutation.mutate()}
                disabled={runMutation.isPending}
                className="text-xs font-medium text-red-700 dark:text-red-300 hover:underline flex-shrink-0 disabled:opacity-50"
              >
                Retry
              </button>
            </div>
          )}

          {/* Search stats */}
          {lastResult && (
            <div className="text-xs text-gray-500 dark:text-gray-400">
              Evaluated {lastResult.searchStats.scenariosEvaluated.toLocaleString()} team options in{' '}
              {(lastResult.searchStats.durationMs / 1000).toFixed(1)}s
              {lastResult.searchStats.sampled && (
                <span className="ml-1 text-gray-400 dark:text-gray-500">(sampled)</span>
              )}
            </div>
          )}

          {/* Baseline card */}
          {lastResult && (
            <BaselineCard baseline={lastResult.baseline} showCost={showCost} />
          )}

          {/* Candidate cards */}
          {lastResult && lastResult.candidates.length > 0 && (
            <div className="space-y-3">
              <div className="text-xs font-semibold text-gray-700 dark:text-gray-300">
                Starting team options
              </div>
              {lastResult.candidates.map((c, i) => (
                <CandidateCard
                  key={i}
                  candidate={c}
                  rank={i + 1}
                  baseline={lastResult.baseline}
                  rtNameMap={rtNameMap}
                  baselineRtMap={baselineRtMap}
                  allowRampUp={allowRampUp}
                  projectId={projectId}
                  rampUpScopeResourceTypeIds={lastRunScopeResourceTypeIds}
                  onRefineScenario={(candidate) => {
                    onRefineScenario(candidate, {
                      allowRampUp,
                      seedResourceTypeIds: visibleResourceTypes.map(rt => rt.id),
                    })
                    onClose()
                  }}
                  onApplied={(snapshotId) => {
                    onApplied(snapshotId)
                    onClose()
                  }}
                />
              ))}
            </div>
          )}

          {/* Empty state: run was completed but all scenarios were infeasible */}
          {lastResult && lastResult.candidates.length === 0 && (
            <div className="rounded-xl border border-amber-200 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/20 px-4 py-4 space-y-2">
              <p className="text-sm font-semibold text-amber-800 dark:text-amber-200">
                No feasible starting teams found within these constraints.
              </p>
              <p className="text-xs text-amber-700 dark:text-amber-300 leading-relaxed">
                Every team option still had parallel over-allocation warnings. Try increasing the max
                count for under-resourced types, switching some epics to{' '}
                <em>Features: sequential</em> mode, or relaxing your duration/budget ceilings.
              </p>
              <p className="text-xs text-amber-600 dark:text-amber-400 font-medium">
                {lastResult.infeasibleCount} of {lastResult.searchStats.scenariosEvaluated} team options were infeasible.
              </p>
            </div>
          )}

          {/* Empty state (no run yet) */}
          {!lastResult && !runError && !runMutation.isPending && (
            <p className="text-xs text-gray-400 dark:text-gray-500">
              Set your ranges above and click <strong>Find starting teams</strong> to compare ranked
              options for Squad Planner.
            </p>
          )}
        </div>
      </div>
    </>
  )
}
