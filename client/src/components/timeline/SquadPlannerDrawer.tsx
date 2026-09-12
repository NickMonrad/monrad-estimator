import { useState, useEffect, useRef, useCallback } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { getPlannerResourceTypeVisibility, type SquadPlannerSeedSettings } from './timelineUx'

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

interface DraftCapacityEdit {
  resourceTypeId: string
  startWeek: number
  endWeek: number
  headcount: number
  locked: boolean
}

interface DraftPlan {
  capacityEdits: DraftCapacityEdit[]
  manualFeatureEntries: Array<{ featureId: string; startWeek: number; durationWeeks: number }>
  manualStoryEntries: Array<{ storyId: string; startWeek: number }>
}

interface PlanSchedule {
  features: Array<{ featureId: string; name: string; startWeek: number; durationWeeks: number }>
  stories: Array<{ storyId: string; featureId: string; name: string; startWeek: number; durationWeeks: number }>
}
interface ReviewedPlanConfig {
  targetDurationWeeks: number
  periodWeeks: 4 | 13
  maxDeltaPerPeriod: number
  smoothingMode: 'smooth' | 'tight' | 'exact'
  minFloor: Record<string, number>
  maxCap: Record<string, number> | null
  maxBudget: number | null
  maxAllocationBufferPct: number | null
  maxParallelismPerFeature: number | null
  maxConcurrentEpics: number | null
}


interface CapacityPlanResult {
  deliveryWeeks: number | null
  totalCost: number
  peakHeadcount: number
  avgUtilisationPct: number
  staffedFteWeeks?: number
  targetAchieved?: boolean
  periods: Period[]
  draft?: DraftPlan
  draftToken?: string
  schedule?: PlanSchedule
  config?: ReviewedPlanConfig
  levellingResult?: {
    epicStartWeeks: Record<string, number>
    featureStartWeeks: Record<string, number>
    totalDeliveryWeeks: number
    peakUtilisationPct: number
  }
  plannedResourceTypeIds?: string[]
  diagnostics?: Array<{
    blocker: string
    resourceTypeName?: string
    featureId?: string
    configuredLimit?: string
    explanation: string
  }>
}
type ApplyableCapacityPlanResult = CapacityPlanResult & {
  deliveryWeeks: number
  draft: DraftPlan
  draftToken: string
  schedule: PlanSchedule
  levellingResult: NonNullable<CapacityPlanResult['levellingResult']>
  config: ReviewedPlanConfig
}


type SmoothingMode = 'smooth' | 'tight' | 'exact'

interface PersistedPlannerSettings {
  targetMonths?: number
  customMonths?: string
  periodWeeks?: 4 | 13
  smoothingMode?: SmoothingMode
  maxDelta?: number
  bufferPct?: number
  minFloor?: Record<string, number>
  maxCap?: Record<string, number>
  maxParallelism?: number
  maxConcurrentEpics?: number
}

interface Props {
  projectId: string
  open: boolean
  onClose: () => void
  resourceTypes: Array<{ id: string; name: string; count: number }>
  fallbackPlannedResourceTypeIds?: string[]
  seedSettings?: SquadPlannerSeedSettings | null
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

function formatWeekCoordinate(value: number) {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(6)))
}

function weekRangeLabel(startWeek: number, endWeek: number) {
  const hasFractionalBoundary = !Number.isInteger(startWeek) || !Number.isInteger(endWeek)
  const firstWeek = startWeek + 1
  const displayedEndWeek = hasFractionalBoundary ? endWeek + 1 : endWeek
  const firstLabel = formatWeekCoordinate(firstWeek)
  const endLabel = formatWeekCoordinate(displayedEndWeek)
  return firstLabel === endLabel ? `W${firstLabel}` : `W${firstLabel}–W${endLabel}`
}

function rangesOverlap(left: Pick<Period, 'startWeek' | 'endWeek'>, right: Pick<Period, 'startWeek' | 'endWeek'>) {
  return left.startWeek < right.endWeek && right.startWeek < left.endWeek
}

function subtractRange(
  source: Pick<Period, 'startWeek' | 'endWeek'>,
  blockers: Array<Pick<Period, 'startWeek' | 'endWeek'>>,
) {
  let fragments: Array<Pick<Period, 'startWeek' | 'endWeek'>> = [source]
  for (const blocker of blockers) {
    const next: Array<Pick<Period, 'startWeek' | 'endWeek'>> = []
    for (const fragment of fragments) {
      if (!rangesOverlap(fragment, blocker)) {
        next.push(fragment)
        continue
      }
      if (fragment.startWeek < blocker.startWeek) {
        next.push({ startWeek: fragment.startWeek, endWeek: blocker.startWeek })
      }
      if (blocker.endWeek < fragment.endWeek) {
        next.push({ startWeek: blocker.endWeek, endWeek: fragment.endWeek })
      }
    }
    fragments = next
  }
  return fragments.filter(fragment => fragment.endWeek > fragment.startWeek)
}

function periodLabel(startWeek: number, endWeek: number, periodWeeks: number) {
  const range = weekRangeLabel(startWeek, endWeek)
  if (endWeek - startWeek !== periodWeeks || startWeek % periodWeeks !== 0) return range
  const period = Math.floor(startWeek / periodWeeks) + 1
  return `${periodWeeks === 13 ? 'Q' : 'M'}${period} (${range})`
}

function formatHeadcount(value: number) {
  return Number.isFinite(value) ? String(value) : 'Unavailable'
}

function hasFiniteNonNegativeValues(value: unknown): value is Record<string, number> {
  return Boolean(
    value
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.values(value).every(entry => (
      typeof entry === 'number' && Number.isFinite(entry) && entry >= 0
    )),
  )
}

function hasValidReviewedDraft(draft: CapacityPlanResult['draft']): draft is DraftPlan {
  if (
    !draft
    || !Array.isArray(draft.capacityEdits)
    || !Array.isArray(draft.manualFeatureEntries)
    || !Array.isArray(draft.manualStoryEntries)
  ) return false

  return draft.capacityEdits.every(edit => (
    typeof edit.resourceTypeId === 'string'
    && Number.isInteger(edit.startWeek)
    && Number.isInteger(edit.endWeek)
    && edit.startWeek >= 0
    && edit.endWeek > edit.startWeek
    && Number.isFinite(edit.headcount)
    && edit.headcount >= 0
    && typeof edit.locked === 'boolean'
  )) && draft.manualFeatureEntries.every(entry => (
    typeof entry.featureId === 'string'
    && Number.isFinite(entry.startWeek)
    && entry.startWeek >= 0
    && Number.isFinite(entry.durationWeeks)
    && entry.durationWeeks > 0
  )) && draft.manualStoryEntries.every(entry => (
    typeof entry.storyId === 'string'
    && Number.isFinite(entry.startWeek)
    && entry.startWeek >= 0
  ))
}

function hasValidReviewedSchedule(schedule: CapacityPlanResult['schedule']): schedule is PlanSchedule {
  if (!schedule || !Array.isArray(schedule.features) || !Array.isArray(schedule.stories)) return false
  return schedule.features.every(feature => (
    typeof feature.featureId === 'string'
    && typeof feature.name === 'string'
    && Number.isFinite(feature.startWeek)
    && feature.startWeek >= 0
    && Number.isFinite(feature.durationWeeks)
    && feature.durationWeeks > 0
  )) && schedule.stories.every(story => (
    typeof story.storyId === 'string'
    && typeof story.featureId === 'string'
    && typeof story.name === 'string'
    && Number.isFinite(story.startWeek)
    && story.startWeek >= 0
    && Number.isFinite(story.durationWeeks)
    && story.durationWeeks > 0
  ))
}

function hasValidReviewedConfig(config: CapacityPlanResult['config']): config is ReviewedPlanConfig {
  if (!config) return false
  const optionalNonNegative = (value: number | null) => (
    value === null || (Number.isFinite(value) && value >= 0)
  )
  const optionalPositiveInteger = (value: number | null) => (
    value === null || (Number.isInteger(value) && value >= 1)
  )
  return (
    Number.isInteger(config.targetDurationWeeks)
    && config.targetDurationWeeks > 0
    && (config.periodWeeks === 4 || config.periodWeeks === 13)
    && Number.isInteger(config.maxDeltaPerPeriod)
    && config.maxDeltaPerPeriod >= 1
    && ['smooth', 'tight', 'exact'].includes(config.smoothingMode)
    && hasFiniteNonNegativeValues(config.minFloor)
    && (config.maxCap === null || hasFiniteNonNegativeValues(config.maxCap))
    && optionalNonNegative(config.maxBudget)
    && optionalNonNegative(config.maxAllocationBufferPct)
    && optionalPositiveInteger(config.maxParallelismPerFeature)
    && optionalPositiveInteger(config.maxConcurrentEpics)
  )
}

function hasValidReviewedPeriods(periods: Period[]) {
  return periods.length > 0 && periods.every((period, index) => (
    period.periodIndex === index
    && Number.isInteger(period.startWeek)
    && Number.isInteger(period.endWeek)
    && period.startWeek >= 0
    && period.endWeek > period.startWeek
    && Array.isArray(period.resources)
    && period.resources.every(resource => (
      typeof resource.resourceTypeId === 'string'
      && typeof resource.resourceTypeName === 'string'
      && Number.isFinite(resource.headcount)
      && resource.headcount >= 0
      && Number.isFinite(resource.avgDemandFTE)
      && resource.avgDemandFTE >= 0
      && Number.isFinite(resource.utilisationPct)
      && resource.utilisationPct >= 0
    ))
  ))
}

function hasValidLevellingResult(result: CapacityPlanResult['levellingResult']) {
  return Boolean(
    result
    && hasFiniteNonNegativeValues(result.epicStartWeeks)
    && hasFiniteNonNegativeValues(result.featureStartWeeks)
    && Number.isFinite(result.totalDeliveryWeeks)
    && result.totalDeliveryWeeks >= 0
    && Number.isFinite(result.peakUtilisationPct)
    && result.peakUtilisationPct >= 0,
  )
}

function isApplyableResult(result: CapacityPlanResult): result is ApplyableCapacityPlanResult {
  return (
    result.deliveryWeeks !== null
    && Number.isFinite(result.deliveryWeeks)
    && result.deliveryWeeks >= 0
    && Number.isFinite(result.totalCost)
    && result.totalCost >= 0
    && hasValidReviewedDraft(result.draft)
    && typeof result.draftToken === 'string'
    && result.draftToken.trim().length > 0
    && hasValidReviewedSchedule(result.schedule)
    && hasValidReviewedPeriods(result.periods)
    && hasValidLevellingResult(result.levellingResult)
    && hasValidReviewedConfig(result.config)
  )
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

function draftFromResult(result: CapacityPlanResult): DraftPlan {
  if (result.draft) {
    return {
      capacityEdits: result.draft.capacityEdits.map(edit => ({ ...edit })),
      manualFeatureEntries: result.draft.manualFeatureEntries.map(entry => ({ ...entry })),
      manualStoryEntries: result.draft.manualStoryEntries.map(entry => ({ ...entry })),
    }
  }
  return {
    capacityEdits: result.periods.flatMap(period =>
      period.resources.map(resource => ({
        resourceTypeId: resource.resourceTypeId,
        startWeek: period.startWeek,
        endWeek: period.endWeek,
        headcount: resource.headcount,
        locked: false,
      })),
    ),
    manualFeatureEntries: [],
    manualStoryEntries: [],
  }
}

function settingsStorageKey(projectId: string) {
  return `squad-planner-settings:${projectId}`
}

function areSettingsAtDefaults(settings: PersistedPlannerSettings) {
  const hasCustomMinFloor = Object.values(settings.minFloor ?? {}).some(value => value !== 0)
  const hasCustomMaxCap = Object.keys(settings.maxCap ?? {}).length > 0

  return (
    settings.targetMonths === 18 &&
    settings.customMonths === '' &&
    settings.periodWeeks === 13 &&
    settings.smoothingMode === 'smooth' &&
    settings.maxDelta === 1 &&
    settings.bufferPct === 20 &&
    !hasCustomMinFloor &&
    !hasCustomMaxCap &&
    settings.maxParallelism === 2 &&
    settings.maxConcurrentEpics === 6
  )
}

function mergePerResourceSettings(
  values: Record<string, number> | undefined,
  resourceTypes: Props['resourceTypes'],
  fallback: (resourceTypeId: string) => number | undefined,
) {
  const next: Record<string, number> = {}

  for (const rt of resourceTypes) {
    const value = values?.[rt.id]
    if (typeof value === 'number' && Number.isFinite(value)) {
      next[rt.id] = value
      continue
    }

    const defaultValue = fallback(rt.id)
    if (defaultValue !== undefined) {
      next[rt.id] = defaultValue
    }
  }

  return next
}

function loadPersistedSettings(projectId: string): PersistedPlannerSettings | null {
  try {
    const raw = window.localStorage.getItem(settingsStorageKey(projectId))
    if (!raw) return null

    const parsed = JSON.parse(raw) as PersistedPlannerSettings
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

function buildResourceTypesKey(resourceTypes: Props['resourceTypes']) {
  return resourceTypes.map(rt => `${rt.id}:${rt.name}:${rt.count}`).join('|')
}

function buildSeedSettingsKey(seedSettings?: SquadPlannerSeedSettings | null) {
  if (!seedSettings) return ''
  const minFloor = Object.entries(seedSettings.minFloor)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([resourceTypeId, value]) => `${resourceTypeId}:${value}`)
    .join('|')
  const maxCap = Object.entries(seedSettings.maxCap)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([resourceTypeId, value]) => `${resourceTypeId}:${value}`)
    .join('|')

  return `${seedSettings.seededResourceTypeIds.join('|')}::${minFloor}::${maxCap}`
}

export default function SquadPlannerDrawer({
  projectId,
  open,
  onClose,
  resourceTypes,
  fallbackPlannedResourceTypeIds,
  seedSettings,
}: Props) {
  // ── state ────────────────────────────────────────────────────────────────
  const [targetMonths, setTargetMonths] = useState<number>(18)
  const [customMonths, setCustomMonths] = useState<string>('')
  const [periodWeeks, setPeriodWeeks] = useState<4 | 13>(13)
  const [smoothingMode, setSmoothingMode] = useState<SmoothingMode>('smooth')
  const [maxDelta, setMaxDelta] = useState(1)
  const [bufferPct, setBufferPct] = useState<number>(20)
  const [minFloor, setMinFloor] = useState<Record<string, number>>({})
  const [maxCap, setMaxCap] = useState<Record<string, number>>({})
  const [maxParallelism, setMaxParallelism] = useState<number>(2)
  const [maxConcurrentEpics, setMaxConcurrentEpics] = useState<number>(6)
  const [showAllResourceTypes, setShowAllResourceTypes] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [diagnostics, setDiagnostics] = useState<CapacityPlanResult['diagnostics'] | null>(null)
  const [seedBanner, setSeedBanner] = useState<string | null>(null)
  const [applyDone, setApplyDone] = useState(false)
  const [applyProofRejected, setApplyProofRejected] = useState(false)
  const [proposal, setProposal] = useState<CapacityPlanResult | null>(null)
  const [latestResult, setLatestResult] = useState<CapacityPlanResult | null>(null)
  const [draft, setDraft] = useState<DraftPlan | null>(null)
  const [validatedRevision, setValidatedRevision] = useState(0)
  const [inputRevision, setInputRevision] = useState(0)
  const inputRevisionRef = useRef(0)
  const requestIdRef = useRef(0)
  const activeRequestIdRef = useRef(0)
  const draftRef = useRef<DraftPlan | null>(null)

  const qc = useQueryClient()
  const skipNextPersistRef = useRef(false)
  const wasOpenRef = useRef(false)
  const lastRestoreSeedRef = useRef<string | null>(null)
  const restoreSeed = `${projectId}::${buildResourceTypesKey(resourceTypes)}::${buildSeedSettingsKey(seedSettings)}`

  const effectiveMonths = customMonths ? Number(customMonths) : targetMonths
  const targetWeeks = Math.round(effectiveMonths * 4.33)

  const markChanged = useCallback(() => {
    const nextRevision = inputRevisionRef.current + 1
    inputRevisionRef.current = nextRevision
    setInputRevision(nextRevision)
    setError(null)
    setDiagnostics(null)
  }, [])

  const replaceDraft = useCallback((next: DraftPlan) => {
    draftRef.current = next
    setDraft(next)
    markChanged()
  }, [markChanged])

  useEffect(() => {
    setMinFloor(prev => mergePerResourceSettings(prev, resourceTypes, rtId => prev[rtId] ?? 0))
    setMaxCap(prev => mergePerResourceSettings(prev, resourceTypes, rtId => prev[rtId]))
  }, [resourceTypes])

  useEffect(() => {
    if (!open) return

    if (skipNextPersistRef.current) {
      skipNextPersistRef.current = false
      return
    }

    try {
      const settings = {
        targetMonths,
        customMonths,
        periodWeeks,
        smoothingMode,
        maxDelta,
        bufferPct,
        minFloor,
        maxCap,
        maxParallelism,
        maxConcurrentEpics,
      } satisfies PersistedPlannerSettings

      if (areSettingsAtDefaults(settings)) {
        window.localStorage.removeItem(settingsStorageKey(projectId))
      } else {
        window.localStorage.setItem(settingsStorageKey(projectId), JSON.stringify(settings))
      }
    } catch {
      // Ignore storage failures and keep the drawer functional.
    }
  }, [
    open,
    projectId,
    targetMonths,
    customMonths,
    periodWeeks,
    smoothingMode,
    maxDelta,
    bufferPct,
    minFloor,
    maxCap,
    maxParallelism,
    maxConcurrentEpics,
  ])

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
    mutationFn: (request: { draft: DraftPlan | undefined; requestId: number; revision: number }) =>
      api
        .post(`/projects/${projectId}/squad-plan`, {
          targetDurationWeeks: targetWeeks,
          periodWeeks,
          smoothingMode,
          maxDeltaPerPeriod: maxDelta,
          maxAllocationBufferPct: bufferPct / 100,
          maxParallelismPerFeature: maxParallelism,
          maxConcurrentEpics,
          minFloor,
          maxCap: Object.keys(maxCap).length > 0 ? maxCap : undefined,
          ...(request.draft ? { draft: request.draft } : {}),
        })
        .then(r => r.data as CapacityPlanResult),
    onError: (err: unknown, request) => {
      if (
        request.requestId !== activeRequestIdRef.current
        || request.revision !== inputRevisionRef.current
      ) return
      let responseError: unknown
      let responseDiagnostics: unknown
      if (err && typeof err === 'object' && 'response' in err) {
        const response = err.response
        if (response && typeof response === 'object' && 'data' in response) {
          const data = response.data
          if (data && typeof data === 'object') {
            if ('error' in data) responseError = data.error
            if ('diagnostics' in data) responseDiagnostics = data.diagnostics
          }
        }
      }
      setError(typeof responseError === 'string' ? responseError : 'Failed to generate plan')
      setDiagnostics(
        Array.isArray(responseDiagnostics)
          ? responseDiagnostics as CapacityPlanResult['diagnostics']
          : null,
      )
    },
    onSuccess: (data: CapacityPlanResult, request) => {
      if (
        request.requestId !== activeRequestIdRef.current
        || request.revision !== inputRevisionRef.current
      ) return
      setError(null)
      setApplyProofRejected(false)
      const acceptedDraft = data.draft ?? draftRef.current
      if (acceptedDraft) {
        draftRef.current = acceptedDraft
        setDraft(acceptedDraft)
      }
      setLatestResult(data)
      setProposal(previous => previous ?? data)
      setDiagnostics(data.diagnostics && data.diagnostics.length > 0 ? data.diagnostics : null)
      setValidatedRevision(request.revision)
    },
  })
  const runGenerate = useCallback(() => {
    const requestId = requestIdRef.current + 1
    requestIdRef.current = requestId
    activeRequestIdRef.current = requestId
    setError(null)
    generate.mutate({
      draft: draftRef.current ?? undefined,
      requestId,
      revision: inputRevisionRef.current,
    })
  }, [generate])

  const restoreSettings = useCallback(() => {
    const saved = loadPersistedSettings(projectId)
    const nextMinFloor = mergePerResourceSettings(saved?.minFloor, resourceTypes, () => 0)
    const nextMaxCap = mergePerResourceSettings(saved?.maxCap, resourceTypes, () => undefined)

    skipNextPersistRef.current = true

    setTargetMonths(saved?.targetMonths ?? 18)
    setCustomMonths(saved?.customMonths ?? '')
    setPeriodWeeks(saved?.periodWeeks === 4 ? 4 : 13)
    setSmoothingMode(
      saved?.smoothingMode === 'tight' || saved?.smoothingMode === 'exact' ? saved.smoothingMode : 'smooth',
    )
    setMaxDelta(saved?.maxDelta ?? 1)
    setBufferPct(saved?.bufferPct ?? 20)
    setMaxParallelism(saved?.maxParallelism ?? 2)
    setMaxConcurrentEpics(saved?.maxConcurrentEpics ?? 6)
    setMinFloor(seedSettings ? { ...nextMinFloor, ...seedSettings.minFloor } : nextMinFloor)
    setMaxCap(seedSettings ? { ...nextMaxCap, ...seedSettings.maxCap } : nextMaxCap)
    setShowAllResourceTypes(false)
    setError(null)
    setDiagnostics(null)
    setSeedBanner(
      seedSettings && seedSettings.seededResourceTypeIds.length > 0
        ? 'Seeded from Starting Team Finder. Adjust these bounds to refine the candidate squad.'
        : null,
    )
    generate.reset()
    setApplyDone(false)
    setApplyProofRejected(false)
    activeRequestIdRef.current = ++requestIdRef.current
    draftRef.current = null
    setDraft(null)
    setProposal(null)
    setLatestResult(null)
    setValidatedRevision(0)
    inputRevisionRef.current = 0
    setInputRevision(0)
  }, [generate, projectId, resourceTypes, seedSettings])

  // ── restore state when drawer opens ──────────────────────────────────────
  useEffect(() => {
    const opened = open && !wasOpenRef.current
    const restoreSeedChanged = open && wasOpenRef.current && lastRestoreSeedRef.current !== restoreSeed

    if (opened || restoreSeedChanged) {
      restoreSettings()
      lastRestoreSeedRef.current = restoreSeed
    }

    if (!open) {
      lastRestoreSeedRef.current = restoreSeed
    }

    wasOpenRef.current = open
  }, [open, restoreSeed, restoreSettings])

  // ── apply mutation ──────────────────────────────────────────────────────
  const apply = useMutation({
    mutationFn: (plan: ApplyableCapacityPlanResult) =>
      api
        .post(`/projects/${projectId}/squad-plan/apply`, {
          name: `${effectiveMonths}-month plan`,
          targetWeeks: plan.config.targetDurationWeeks,
          periodWeeks: plan.config.periodWeeks,
          maxDelta: plan.config.maxDeltaPerPeriod,
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
          maxParallelismPerFeature: plan.config.maxParallelismPerFeature ?? undefined,
          maxConcurrentEpics: plan.config.maxConcurrentEpics ?? undefined,
          config: plan.config,
          draft: plan.draft,
          draftToken: plan.draftToken,
          schedule: plan.schedule,
          setActive: true,
        })
        .then(r => r.data),
    onSuccess: () => {
      setError(null)
      setDiagnostics(null)
      setApplyProofRejected(false)
    },
    onError: (err: unknown) => {
      let responseError: unknown
      let responseStatus: unknown
      if (err && typeof err === 'object' && 'response' in err) {
        const response = err.response
        if (response && typeof response === 'object') {
          if ('status' in response) responseStatus = response.status
          if ('data' in response) {
            const data = response.data
            if (data && typeof data === 'object' && 'error' in data) responseError = data.error
          }
        }
      }
      if (responseStatus === 400 || responseStatus === 409) setApplyProofRejected(true)
      setError(typeof responseError === 'string' ? responseError : 'Failed to apply plan')
    },
  })
  const resetToDefaults = () => {
    setTargetMonths(18)
    setCustomMonths('')
    setPeriodWeeks(13)
    setSmoothingMode('smooth')
    setMaxDelta(1)
    setBufferPct(20)
    setMinFloor(mergePerResourceSettings(undefined, resourceTypes, () => 0))
    setMaxCap({})
    setMaxParallelism(2)
    setMaxConcurrentEpics(6)
    setShowAllResourceTypes(false)
    setSeedBanner(null)
    generate.reset()
    activeRequestIdRef.current = ++requestIdRef.current
    markChanged()
    try {
      window.localStorage.removeItem(settingsStorageKey(projectId))
    } catch {
      // Ignore storage failures and keep the drawer functional.
    }
  }

  if (!open || applyDone) return null

  const result = latestResult
  const resultIsStale = Boolean(result && validatedRevision !== inputRevision)
  const currentDraft = draft ?? (result ? draftFromResult(result) : null)
  const resultIsApplyable = Boolean(result && isApplyableResult(result))
  const canApply = Boolean(
    result
    && !resultIsStale
    && !generate.isPending
    && !apply.isPending
    && !applyProofRejected
    && resultIsApplyable,
  )
  const applyStatus = resultIsStale
    ? 'Apply is disabled because current edits are not included in the previous validated result. Replan first.'
    : generate.isPending
      ? 'Apply is disabled while the draft is being replanned.'
      : apply.isPending
        ? 'Applying the reviewed result.'
        : applyProofRejected
          ? 'Apply is disabled because the server rejected this reviewed proof. Replan to obtain a current result.'
          : !resultIsApplyable
            ? 'Apply is disabled because this response has no complete signed, finite schedule. Adjust or unlock constraints and replan.'
            : result?.targetAchieved === false
              ? 'The requested target was missed, but this finite reconciled plan is reviewed and can be applied.'
              : 'This reviewed result is current and ready to apply.'

  const updateCapacityEdit = (
    resourceTypeId: string,
    period: Pick<Period, 'startWeek' | 'endWeek'>,
    fallbackHeadcount: number,
    changes: Partial<DraftCapacityEdit>,
  ) => {
    const base = currentDraft ?? {
      capacityEdits: [],
      manualFeatureEntries: [],
      manualStoryEntries: [],
    }
    const selectedIndex = base.capacityEdits.findIndex(edit =>
      edit.resourceTypeId === resourceTypeId
      && edit.startWeek <= period.startWeek
      && period.endWeek <= edit.endWeek,
    )
    const existing = selectedIndex >= 0
      ? base.capacityEdits[selectedIndex]
      : {
          resourceTypeId,
          startWeek: period.startWeek,
          endWeek: period.endWeek,
          headcount: fallbackHeadcount,
          locked: false,
        }
    const nextEdit = { ...existing, ...changes }
    const protectedOverlaps = base.capacityEdits.filter((edit, index) =>
      index !== selectedIndex
      && edit.resourceTypeId === resourceTypeId
      && edit.locked
      && rangesOverlap(edit, period),
    )
    const adaptedTarget = subtractRange(period, protectedOverlaps).map(range => ({
      ...nextEdit,
      startWeek: range.startWeek,
      endWeek: range.endWeek,
    }))
    const capacityEdits = base.capacityEdits.flatMap((edit, index) => {
      if (edit.resourceTypeId !== resourceTypeId || !rangesOverlap(edit, period)) return [edit]
      if (edit.locked && index !== selectedIndex) return [edit]
      return subtractRange(edit, [period]).map(range => ({
        ...edit,
        startWeek: range.startWeek,
        endWeek: range.endWeek,
      }))
    })
    replaceDraft({ ...base, capacityEdits: [...capacityEdits, ...adaptedTarget] })
  }

  const toggleFeatureLock = (entry: PlanSchedule['features'][number]) => {
    const base = currentDraft ?? { capacityEdits: [], manualFeatureEntries: [], manualStoryEntries: [] }
    const found = base.manualFeatureEntries.findIndex(item => item.featureId === entry.featureId)
    const manualFeatureEntries = found >= 0
      ? base.manualFeatureEntries.filter(item => item.featureId !== entry.featureId)
      : [...base.manualFeatureEntries, {
          featureId: entry.featureId,
          startWeek: entry.startWeek,
          durationWeeks: entry.durationWeeks,
        }]
    replaceDraft({ ...base, manualFeatureEntries })
  }

  const toggleStoryLock = (entry: Pick<PlanSchedule['stories'][number], 'storyId' | 'startWeek'>) => {
    const base = currentDraft ?? { capacityEdits: [], manualFeatureEntries: [], manualStoryEntries: [] }
    const manualStoryEntries = base.manualStoryEntries.some(item => item.storyId === entry.storyId)
      ? base.manualStoryEntries.filter(item => item.storyId !== entry.storyId)
      : [...base.manualStoryEntries, { storyId: entry.storyId, startWeek: entry.startWeek }]
    replaceDraft({ ...base, manualStoryEntries })
  }

  const displayRangesByKey = new Map<string, { startWeek: number; endWeek: number }>()
  const sourcePeriods = result && result.periods.length > 0
    ? result.periods
    : proposal?.periods ?? []
  const sourceRanges = sourcePeriods.map(period => ({
    startWeek: period.startWeek,
    endWeek: period.endWeek,
  }))
  const editRanges = (currentDraft?.capacityEdits ?? []).map(edit => ({
    startWeek: edit.startWeek,
    endWeek: edit.endWeek,
  }))
  const displayCandidates = [...sourceRanges, ...editRanges]
  const displayBoundaries = Array.from(new Set(
    displayCandidates.flatMap(range => [range.startWeek, range.endWeek]),
  )).sort((left, right) => left - right)
  for (let index = 0; index < displayBoundaries.length - 1; index += 1) {
    const fragment = {
      startWeek: displayBoundaries[index],
      endWeek: displayBoundaries[index + 1],
    }
    if (displayCandidates.some(range => rangesOverlap(range, fragment))) {
      displayRangesByKey.set(`${fragment.startWeek}:${fragment.endWeek}`, fragment)
    }
  }
  const displayPeriods = Array.from(displayRangesByKey.values())
    .sort((left, right) => left.startWeek - right.startWeek || left.endWeek - right.endWeek)


  const resourceNameById = new Map(resourceTypes.map(resource => [resource.id, resource.name]))
  for (const plan of [proposal, result]) {
    for (const period of plan?.periods ?? []) {
      for (const resource of period.resources) {
        if (!resourceNameById.has(resource.resourceTypeId)) {
          resourceNameById.set(resource.resourceTypeId, resource.resourceTypeName)
        }
      }
    }
  }
  const displayedResourceTypeIds = new Set<string>()
  for (const period of result?.periods ?? []) {
    for (const resource of period.resources) displayedResourceTypeIds.add(resource.resourceTypeId)
  }
  for (const edit of currentDraft?.capacityEdits ?? []) displayedResourceTypeIds.add(edit.resourceTypeId)
  if (displayedResourceTypeIds.size === 0) {
    for (const period of proposal?.periods ?? []) {
      for (const resource of period.resources) displayedResourceTypeIds.add(resource.resourceTypeId)
    }
  }

  const findPeriodResource = (
    periods: Period[],
    resourceTypeId: string,
    range: Pick<Period, 'startWeek' | 'endWeek'>,
  ) => {
    const period = periods.find(candidate =>
      candidate.startWeek === range.startWeek && candidate.endWeek === range.endWeek)
      ?? periods.find(candidate =>
        range.startWeek >= candidate.startWeek && range.endWeek <= candidate.endWeek)
    return period?.resources.find(resource => resource.resourceTypeId === resourceTypeId)
  }

  const responseSchedule = result?.schedule
  const validResponseSchedule = hasValidReviewedSchedule(responseSchedule) ? responseSchedule : undefined
  const responseHasPlacements = Boolean(
    validResponseSchedule
    && (validResponseSchedule.features.length > 0 || validResponseSchedule.stories.length > 0),
  )
  const proposalSchedule = hasValidReviewedSchedule(proposal?.schedule) ? proposal.schedule : undefined
  const knownSchedule = responseHasPlacements ? validResponseSchedule : proposalSchedule
  const displayedFeatures = new Map(
    (knownSchedule?.features ?? []).map(feature => [feature.featureId, feature]),
  )
  for (const entry of currentDraft?.manualFeatureEntries ?? []) {
    const known = displayedFeatures.get(entry.featureId)
    displayedFeatures.set(entry.featureId, {
      featureId: entry.featureId,
      name: known?.name ?? `Feature ${entry.featureId}`,
      startWeek: entry.startWeek,
      durationWeeks: entry.durationWeeks,
    })
  }
  const displayedStories = new Map<string, PlanSchedule['stories'][number] | {
    storyId: string
    featureId: string
    name: string
    startWeek: number
    durationWeeks?: number
  }>(
    (knownSchedule?.stories ?? []).map(story => [story.storyId, story]),
  )
  for (const entry of currentDraft?.manualStoryEntries ?? []) {
    const known = displayedStories.get(entry.storyId)
    displayedStories.set(entry.storyId, {
      storyId: entry.storyId,
      featureId: known?.featureId ?? '',
      name: known?.name ?? `Story ${entry.storyId}`,
      startWeek: entry.startWeek,
      durationWeeks: known?.durationWeeks,
    })
  }
  const showingPreviousCapacity = Boolean(result && result.periods.length === 0 && displayPeriods.length > 0)
  const showingPreviousSchedule = Boolean(
    result
    && !responseHasPlacements
    && ((proposalSchedule?.features.length ?? 0) > 0 || (proposalSchedule?.stories.length ?? 0) > 0),
  )

  const presetMonths = [12, 18, 24] as const
  const effectivePlannedResourceTypeIds =
    result?.plannedResourceTypeIds ?? fallbackPlannedResourceTypeIds
  const defaultVisibility = getPlannerResourceTypeVisibility(
    resourceTypes,
    effectivePlannedResourceTypeIds,
    false,
  )
  const { visibleResourceTypes, isFiltered } = getPlannerResourceTypeVisibility(
    resourceTypes,
    effectivePlannedResourceTypeIds,
    showAllResourceTypes,
  )

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
          <div>
            <h2 className="text-lg font-semibold text-gray-900 dark:text-white">👥 Squad Planner</h2>
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              Generate or review a capacity profile for larger programmes.
            </p>
          </div>
          <div className="flex items-center gap-3">
            <button
              type="button"
              disabled={apply.isPending}
              onClick={resetToDefaults}
              className="text-xs font-medium text-red-600 hover:text-red-700 focus:outline-none focus:ring-2 focus:ring-lab3-blue disabled:cursor-not-allowed disabled:opacity-50 dark:text-red-400 dark:hover:text-red-300"
            >
              Reset settings
            </button>
            <button
              type="button"
              onClick={onClose}
              className="text-xl leading-none text-gray-400 hover:text-gray-600 focus:outline-none focus:ring-2 focus:ring-lab3-blue dark:hover:text-gray-200"
              aria-label="Close"
            >
              ×
            </button>
          </div>
        </div>

        {/* ── Scrollable body ── */}
        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-5">
          {seedBanner && (
            <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-xs text-red-700 dark:border-red-800 dark:bg-red-900/20 dark:text-red-300">
              {seedBanner}
            </div>
          )}

          {/* Target Duration */}
          <div>
            <label className="text-xs font-semibold text-gray-700 dark:text-gray-300 mb-2 block">
              Target Duration
            </label>
            <div role="group" aria-label="Target duration" className="flex rounded-lg border border-gray-200 dark:border-gray-600 overflow-hidden">
              {presetMonths.map(m => (
                <button
                  type="button"
                  aria-pressed={!customMonths && targetMonths === m}
                  disabled={apply.isPending}
                  key={m}
                  onClick={() => { setTargetMonths(m); setCustomMonths(''); markChanged() }}
                  className={`flex-1 py-1.5 text-sm font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-inset focus:ring-lab3-blue disabled:cursor-not-allowed disabled:opacity-50 ${
                    !customMonths && targetMonths === m
                      ? 'bg-lab3-navy text-white'
                      : 'text-gray-600 hover:bg-gray-50 dark:text-gray-300 dark:hover:bg-gray-700'
                  }`}
                >
                  {m}mo
                </button>
              ))}
              <input
                aria-label="Custom target duration in months"
                disabled={apply.isPending}
                type="number"
                min={3}
                max={60}
                placeholder="Custom"
                value={customMonths}
                onChange={e => { setCustomMonths(e.target.value); markChanged() }}
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
            <div role="group" aria-label="Change frequency" className="flex rounded-lg border border-gray-200 dark:border-gray-600 overflow-hidden">
              {([
                { value: 4 as const, label: 'Monthly' },
                { value: 13 as const, label: 'Quarterly' },
              ]).map(opt => (
                <button
                  type="button"
                  aria-pressed={periodWeeks === opt.value}
                  disabled={apply.isPending}
                  key={opt.value}
                  onClick={() => { setPeriodWeeks(opt.value); markChanged() }}
                  className={`flex-1 py-1.5 text-sm font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-inset focus:ring-lab3-blue disabled:cursor-not-allowed disabled:opacity-50 ${
                    periodWeeks === opt.value
                      ? 'bg-lab3-navy text-white'
                      : 'text-gray-600 hover:bg-gray-50 dark:text-gray-300 dark:hover:bg-gray-700'
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
                aria-label="Maximum scaling per period"
                value={maxDelta}
                onChange={e => { setMaxDelta(Number(e.target.value)); markChanged() }}
                disabled={smoothingMode === 'exact' || apply.isPending}
                className="border border-gray-200 dark:border-gray-600 rounded px-3 py-1.5 text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:outline-none focus:ring-1 focus:ring-lab3-blue"
              >
                {[1, 2, 3, 4, 5].map(n => (
                  <option key={n} value={n}>{n}</option>
                ))}
              </select>
              <span className="text-xs text-gray-500 dark:text-gray-400">
                {smoothingMode === 'exact' ? 'not used in exact mode' : 'people per RT per period'}
              </span>
            </div>
          </div>

          {/* Smoothing Mode */}
          <div>
            <label className="text-xs font-semibold text-gray-700 dark:text-gray-300 mb-2 block">
              Capacity Tracking
            </label>
            <div role="group" aria-label="Capacity tracking" className="flex rounded-lg border border-gray-200 dark:border-gray-600 overflow-hidden">
              {([
                { value: 'smooth' as const, label: 'Smooth' },
                { value: 'tight' as const, label: 'Tight' },
                { value: 'exact' as const, label: 'Exact' },
              ]).map(opt => (
                <button
                  type="button"
                  aria-pressed={smoothingMode === opt.value}
                  disabled={apply.isPending}
                  key={opt.value}
                  onClick={() => { setSmoothingMode(opt.value); markChanged() }}
                  className={`flex-1 py-1.5 text-sm font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-inset focus:ring-lab3-blue disabled:cursor-not-allowed disabled:opacity-50 ${
                    smoothingMode === opt.value
                      ? 'bg-lab3-navy text-white'
                      : 'text-gray-600 hover:bg-gray-50 dark:text-gray-300 dark:hover:bg-gray-700'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              Smooth = stable, Tight = closer to demand, Exact = no smoothing.
            </p>
          </div>

          {/* Allocation Buffer */}
          <div>
            <label className="text-xs font-semibold text-gray-700 dark:text-gray-300 mb-2 block">
              Max Over-allocation Buffer
            </label>
            <div className="flex items-center gap-2">
              <select
                aria-label="Maximum over-allocation buffer"
                disabled={apply.isPending}
                value={bufferPct}
                onChange={e => { setBufferPct(Number(e.target.value)); markChanged() }}
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
                aria-label="Maximum people per feature"
                disabled={apply.isPending}
                value={maxParallelism}
                onChange={e => { setMaxParallelism(Number(e.target.value)); markChanged() }}
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
                aria-label="Maximum concurrent epics"
                disabled={apply.isPending}
                value={maxConcurrentEpics}
                onChange={e => { setMaxConcurrentEpics(Number(e.target.value)); markChanged() }}
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
            <div className="mb-2 flex items-center justify-between gap-3">
              <label className="text-xs font-semibold text-gray-700 dark:text-gray-300 block">
                RT Constraints (Min / Max)
              </label>
              {defaultVisibility.hiddenResourceTypes.length > 0 && (
                <button
                  type="button"
                  aria-pressed={showAllResourceTypes}
                  disabled={apply.isPending}
                  onClick={() => setShowAllResourceTypes(prev => !prev)}
                  className="text-[11px] font-medium text-lab3-navy hover:underline focus:outline-none focus:ring-2 focus:ring-lab3-blue disabled:cursor-not-allowed disabled:opacity-50 dark:text-lab3-blue"
                >
                  {showAllResourceTypes
                    ? `Show demand-bearing only (${defaultVisibility.visibleResourceTypes.length})`
                    : `Show all RTs (+${defaultVisibility.hiddenResourceTypes.length} zero-demand)`}
                </button>
              )}
            </div>
            <div className="space-y-2">
              {visibleResourceTypes.map(rt => (
                <div key={rt.id} className="flex items-center gap-2">
                  <span className="flex-1 text-sm text-gray-700 dark:text-gray-300 truncate" title={rt.name}>
                    {rt.name}
                  </span>
                  <input
                    aria-label={`Minimum headcount for ${rt.name}`}
                    disabled={apply.isPending}
                    type="number"
                    min={0}
                    max={20}
                    value={minFloor[rt.id] ?? 0}
                    onChange={e => {
                      setMinFloor(prev => ({ ...prev, [rt.id]: Math.max(0, Number(e.target.value)) }))
                      markChanged()
                    }}
                    title="Min headcount"
                    className="w-14 border border-gray-200 dark:border-gray-600 rounded px-2 py-1 text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-center focus:outline-none focus:ring-1 focus:ring-lab3-blue"
                  />
                  <span className="text-xs text-gray-400">–</span>
                  <input
                    aria-label={`Maximum headcount for ${rt.name}`}
                    disabled={apply.isPending}
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
                      markChanged()
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
            {isFiltered && defaultVisibility.hiddenResourceTypes.length > 0 && (
              <p className="mt-1 text-[10px] text-gray-500 dark:text-gray-400">
                Showing only demand-bearing RTs by default. Hidden until expanded: {defaultVisibility.hiddenResourceTypes.map(rt => rt.name).join(', ')}.
              </p>
            )}
          </div>

          {/* Generate button */}
          <button
            type="button"
            onClick={runGenerate}
            disabled={generate.isPending || apply.isPending || effectiveMonths < 1}
            className="w-full rounded-lg bg-lab3-navy px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-lab3-blue focus:outline-none focus:ring-2 focus:ring-lab3-blue focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {generate.isPending
              ? result ? 'Replanning unlocked work…' : 'Generating capacity profile…'
              : result ? '↻ Replan unlocked work' : '▶ Generate capacity profile'}
          </button>
          {error && (
            <div role="alert" className="rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 p-3 text-sm text-red-700 dark:text-red-300">
              {error}
              {diagnostics && diagnostics.length > 0 && (
                <ul className="mt-2 space-y-1 text-xs list-disc list-inside">
                  {diagnostics.map((d, i) => (
                    <li key={i}>
                      <span className="font-medium">{d.explanation}</span>
                      {d.resourceTypeName && (
                        <span className="text-red-600 dark:text-red-400"> ({d.resourceTypeName})</span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              {!diagnostics || diagnostics.length === 0 ? (
                <div className="mt-1 text-xs">
                  If this looks like an impossible plan,{' '}
                  <button
                    type="button"
                    onClick={resetToDefaults}
                    className="underline font-medium hover:no-underline focus:outline-none focus:ring-2 focus:ring-lab3-blue"
                  >
                    reset planner settings
                  </button>{' '}
                  to try the defaults.
                </div>
              ) : (
                <div className="mt-1 text-xs">
                  <button
                    type="button"
                    onClick={resetToDefaults}
                    className="underline font-medium hover:no-underline focus:outline-none focus:ring-2 focus:ring-lab3-blue"
                  >
                    Reset planner settings
                  </button>{' '}
                  or adjust the constraints above.
                </div>
              )}
            </div>
          )}

          {/* ── Post-completion diagnostics (target missed) ── */}
          {!error && diagnostics && diagnostics.length > 0 && (
            <div role="status" className="rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 p-3 text-sm text-amber-700 dark:text-amber-300">
              <div className="font-medium text-xs mb-1">⚠ Target not achievable under current constraints</div>
              <ul className="space-y-1 text-xs list-disc list-inside">
                {diagnostics.map((d, i) => (
                  <li key={i}>
                    <span className="font-medium">{d.explanation}</span>
                    {d.resourceTypeName && (
                      <span className="text-amber-600 dark:text-amber-400"> ({d.resourceTypeName})</span>
                    )}
                  </li>
                ))}
              </ul>
              <div className="mt-2 text-xs">
                <button
                  type="button"
                  onClick={resetToDefaults}
                  className="underline font-medium hover:no-underline focus:outline-none focus:ring-2 focus:ring-lab3-blue"
                >
                  Reset planner settings
                </button>{' '}
                or adjust the constraints above.
              </div>
            </div>
          )}

          {/* ── Results ── */}
          {result && (
            <div className="space-y-4">
              {resultIsStale && (
                <div
                  role="status"
                  className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-800 dark:bg-amber-900/20 dark:text-amber-200"
                >
                  <span className="font-semibold">Out of date.</span>{' '}
                  Showing the previous validated result. Current edits and locks are not reflected until you replan.
                </div>
              )}
              {!resultIsStale && generate.isPending && (
                <div
                  role="status"
                  className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-xs text-gray-600 dark:border-gray-700 dark:bg-gray-700/40 dark:text-gray-300"
                >
                  Replanning unlocked work. The previous validated result remains visible until the response is accepted.
                </div>
              )}

              {/* Summary KPIs */}
              <div>
                <div className="text-xs font-semibold text-gray-700 dark:text-gray-300 mb-2">Capacity profile summary</div>
                {proposal && proposal !== result && (
                  <p className="mb-2 text-[11px] text-gray-600 dark:text-gray-300">
                    Initial planner proposal:{' '}
                    {proposal.deliveryWeeks !== null && Number.isFinite(proposal.deliveryWeeks)
                      ? `${proposal.deliveryWeeks} weeks`
                      : 'duration unavailable'}
                    {' · '}{typeof proposal.staffedFteWeeks === 'number' && Number.isFinite(proposal.staffedFteWeeks)
                      ? proposal.staffedFteWeeks
                      : 'unavailable'} FTE-weeks
                    {' · '}peak {Number.isFinite(proposal.peakHeadcount) ? proposal.peakHeadcount : 'unavailable'} FTE
                    {' · '}{Number.isFinite(proposal.avgUtilisationPct) ? `${proposal.avgUtilisationPct.toFixed(0)}%` : 'utilisation unavailable'}
                    {' · '}{Number.isFinite(proposal.totalCost) ? fmtCost(proposal.totalCost) : 'cost unavailable'}.
                  </p>
                )}
                <div className="grid grid-cols-2 gap-2">
                  <div className="rounded-lg border border-gray-200 dark:border-gray-700 px-3 py-2">
                    <div className="text-[10px] text-gray-500 dark:text-gray-400 uppercase tracking-wide">Requested duration</div>
                    <div className="text-sm font-semibold text-gray-900 dark:text-white">
                      🎯 {result.config?.targetDurationWeeks ?? targetWeeks} weeks
                    </div>
                  </div>
                  <div className="rounded-lg border border-gray-200 dark:border-gray-700 px-3 py-2">
                    <div className="text-[10px] text-gray-500 dark:text-gray-400 uppercase tracking-wide">Achieved duration</div>
                    <div className="text-sm font-semibold text-gray-900 dark:text-white">
                      📅 {result.deliveryWeeks == null || !Number.isFinite(result.deliveryWeeks)
                        ? 'Unavailable'
                        : `${result.deliveryWeeks} weeks`}
                    </div>
                  </div>
                  <div className="rounded-lg border border-gray-200 dark:border-gray-700 px-3 py-2">
                    <div className="text-[10px] text-gray-500 dark:text-gray-400 uppercase tracking-wide">Staffed FTE-weeks</div>
                    <div className="text-sm font-semibold text-gray-900 dark:text-white">
                      👥 {typeof result.staffedFteWeeks === 'number' && Number.isFinite(result.staffedFteWeeks)
                        ? result.staffedFteWeeks
                        : 'Unavailable'}
                    </div>
                  </div>
                  <div className="rounded-lg border border-gray-200 dark:border-gray-700 px-3 py-2">
                    <div className="text-[10px] text-gray-500 dark:text-gray-400 uppercase tracking-wide">Peak staffing</div>
                    <div className="text-sm font-semibold text-gray-900 dark:text-white">
                      📊 {Number.isFinite(result.peakHeadcount) ? `${result.peakHeadcount} FTE` : 'Unavailable'}
                    </div>
                  </div>
                  <div className="rounded-lg border border-gray-200 dark:border-gray-700 px-3 py-2">
                    <div className="text-[10px] text-gray-500 dark:text-gray-400 uppercase tracking-wide">Utilisation</div>
                    <div className="text-sm font-semibold text-gray-900 dark:text-white">
                      📈 {Number.isFinite(result.avgUtilisationPct) ? `${result.avgUtilisationPct.toFixed(0)}%` : 'Unavailable'}
                    </div>
                  </div>
                  <div className="rounded-lg border border-gray-200 dark:border-gray-700 px-3 py-2">
                    <div className="text-[10px] text-gray-500 dark:text-gray-400 uppercase tracking-wide">Planned squad cost</div>
                    <div className="text-sm font-semibold text-gray-900 dark:text-white">
                      💰 {Number.isFinite(result.totalCost) ? fmtCost(result.totalCost) : 'Unavailable'}
                    </div>
                  </div>
                </div>
                <p className="mt-2 text-[11px] text-gray-500 dark:text-gray-400">
                  Target status: {result.targetAchieved === true
                    ? 'achieved'
                    : result.targetAchieved === false
                      ? 'not achieved under current constraints'
                      : 'unavailable'}.
                  Headline cost reflects planned squad capacity only.
                </p>
              </div>

              {/* Capacity Profile Table */}
              <div>
                <div className="text-xs font-semibold text-gray-700 dark:text-gray-300 mb-2">Capacity profile</div>
                {showingPreviousCapacity && (
                  <p className="mb-2 text-[11px] text-amber-700 dark:text-amber-300">
                    The latest response returned no capacity periods. Previous values remain available so you can edit or unlock the draft.
                  </p>
                )}
                {displayPeriods.length === 0 || displayedResourceTypeIds.size === 0 ? (
                  <p className="rounded-lg border border-gray-200 px-3 py-3 text-xs text-gray-500 dark:border-gray-700 dark:text-gray-400">
                    No capacity periods are available. Adjust the planner settings and replan.
                  </p>
                ) : (
                  <div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-700">
                    <table className="min-w-full text-xs">
                      <thead>
                        <tr className="bg-gray-50 dark:bg-gray-700">
                          <th
                            scope="col"
                            className="text-left px-2 py-1.5 font-medium text-gray-600 dark:text-gray-300 sticky left-0 bg-gray-50 dark:bg-gray-700 z-10"
                          >
                            Role
                          </th>
                          {displayPeriods.map(period => (
                            <th
                              key={`${period.startWeek}:${period.endWeek}`}
                              scope="col"
                              className="text-center px-2 py-1.5 font-medium text-gray-600 dark:text-gray-300 whitespace-nowrap"
                            >
                              {periodLabel(
                                period.startWeek,
                                period.endWeek,
                                result.config?.periodWeeks ?? periodWeeks,
                              )}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {Array.from(displayedResourceTypeIds).map((resourceTypeId, rowIndex) => {
                          const resourceTypeName = resourceNameById.get(resourceTypeId) ?? `Role ${resourceTypeId}`
                          return (
                            <tr
                              key={resourceTypeId}
                              className={rowIndex % 2 === 0 ? 'bg-white dark:bg-gray-800' : 'bg-gray-50/50 dark:bg-gray-750'}
                            >
                              <th
                                scope="row"
                                className="px-2 py-1.5 text-left font-medium text-gray-700 dark:text-gray-300 truncate max-w-[140px] sticky left-0 bg-inherit z-10"
                                title={resourceTypeName}
                              >
                                {resourceTypeName}
                              </th>
                              {displayPeriods.map((period, periodIndex) => {
                                const latestCell = findPeriodResource(result?.periods ?? [], resourceTypeId, period)
                                const proposedCell = findPeriodResource(proposal?.periods ?? [], resourceTypeId, period)
                                const draftEdit = currentDraft?.capacityEdits.find(edit =>
                                  edit.resourceTypeId === resourceTypeId
                                  && edit.startWeek <= period.startWeek
                                  && period.endWeek <= edit.endWeek,
                                )
                                const fallbackHeadcount = latestCell?.headcount ?? proposedCell?.headcount
                                if (draftEdit === undefined && fallbackHeadcount === undefined) {
                                  return (
                                    <td
                                      key={`${period.startWeek}:${period.endWeek}`}
                                      className="text-center px-2 py-1.5 text-gray-400"
                                    >
                                      —
                                    </td>
                                  )
                                }
                                const editedHeadcount = draftEdit?.headcount ?? fallbackHeadcount ?? 0
                                const locked = draftEdit?.locked ?? false
                                const proposedDiffers = proposedCell !== undefined
                                  && proposedCell.headcount !== editedHeadcount
                                const validatedDiffers = latestCell !== undefined
                                  && latestCell.headcount !== editedHeadcount
                                  && latestCell.headcount !== proposedCell?.headcount
                                const comparisonId = `capacity-comparison-${rowIndex}-${periodIndex}`
                                const comparison = [
                                  proposedDiffers ? `Planner proposed ${formatHeadcount(proposedCell.headcount)}` : null,
                                  validatedDiffers ? `Last validated ${formatHeadcount(latestCell.headcount)}` : null,
                                ].filter(Boolean)
                                const cellTitle = [
                                  `Current edit ${formatHeadcount(editedHeadcount)} FTE`,
                                  latestCell ? `latest validated ${formatHeadcount(latestCell.headcount)} FTE` : null,
                                  proposedCell ? `initial proposal ${formatHeadcount(proposedCell.headcount)} FTE` : null,
                                  latestCell ? `${latestCell.utilisationPct.toFixed(0)}% utilisation` : null,
                                ].filter(Boolean).join(' · ')
                                return (
                                  <td
                                    key={`${period.startWeek}:${period.endWeek}`}
                                    className={`px-1 py-1.5 font-medium ${
                                      latestCell
                                        ? utilClass(latestCell.utilisationPct)
                                        : 'bg-gray-50 text-gray-700 dark:bg-gray-700/40 dark:text-gray-200'
                                    }`}
                                    title={cellTitle}
                                  >
                                    <div className="flex items-center gap-1">
                                      <input
                                        aria-label={`Capacity for ${resourceTypeName} ${periodLabel(
                                          period.startWeek,
                                          period.endWeek,
                                          result.config?.periodWeeks ?? periodWeeks,
                                        )}`}
                                        aria-describedby={comparison.length > 0 ? comparisonId : undefined}
                                        type="number"
                                        min={0}
                                        step="any"
                                        value={formatHeadcount(editedHeadcount)}
                                        disabled={apply.isPending}
                                        onChange={event => {
                                          const value = Number(event.target.value)
                                          if (Number.isFinite(value) && value >= 0) {
                                            updateCapacityEdit(resourceTypeId, period, editedHeadcount, { headcount: value })
                                          }
                                        }}
                                        className="w-16 rounded border border-gray-200 bg-white/70 px-1 py-1 text-center text-gray-900 focus:outline-none focus:ring-1 focus:ring-lab3-blue disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-600 dark:bg-gray-700/70 dark:text-white"
                                      />
                                      <button
                                        type="button"
                                        aria-label={`${locked ? 'Unlock' : 'Lock'} capacity for ${resourceTypeName} ${periodLabel(
                                          period.startWeek,
                                          period.endWeek,
                                          result.config?.periodWeeks ?? periodWeeks,
                                        )}`}
                                        aria-pressed={locked}
                                        disabled={apply.isPending}
                                        onClick={() => updateCapacityEdit(
                                          resourceTypeId,
                                          period,
                                          editedHeadcount,
                                          { locked: !locked },
                                        )}
                                        className="whitespace-nowrap text-[10px] underline focus:outline-none focus:ring-1 focus:ring-lab3-blue disabled:cursor-not-allowed disabled:opacity-50"
                                      >
                                        {locked ? 'Unlock' : 'Lock'}
                                      </button>
                                    </div>
                                    {comparison.length > 0 && (
                                      <div
                                        id={comparisonId}
                                        className="mt-1 whitespace-nowrap text-[10px] font-normal text-gray-600 dark:text-gray-300"
                                      >
                                        {comparison.join(' · ')}
                                      </div>
                                    )}
                                  </td>
                                )
                              })}
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
                <p className="mt-1 text-[10px] text-gray-400 dark:text-gray-500">
                  Cell colour: <span className="text-green-600">≥80%</span> · <span className="text-amber-600">50-79%</span> · <span className="text-red-600">&lt;50%</span> utilisation in the latest validated result
                </p>
              </div>

              <div className="space-y-2">
                <div className="text-xs font-semibold text-gray-700 dark:text-gray-300">Schedule placement locks</div>
                {showingPreviousSchedule && (
                  <p className="text-[11px] text-amber-700 dark:text-amber-300">
                    The latest response returned no schedule. Previous placements remain available so you can unlock the draft.
                  </p>
                )}
                {displayedFeatures.size === 0 && displayedStories.size === 0 ? (
                  <p className="text-xs text-gray-500 dark:text-gray-400">
                    No supported feature or story placements are available. Adjust constraints and replan.
                  </p>
                ) : (
                  <div className="space-y-1">
                    {Array.from(displayedFeatures.values()).map(feature => {
                      const locked = currentDraft?.manualFeatureEntries.some(entry => entry.featureId === feature.featureId) ?? false
                      const initial = proposalSchedule?.features.find(entry => entry.featureId === feature.featureId)
                      const placement = weekRangeLabel(feature.startWeek, feature.startWeek + feature.durationWeeks)
                      const initialPlacement = initial
                        ? weekRangeLabel(initial.startWeek, initial.startWeek + initial.durationWeeks)
                        : null
                      return (
                        <div key={feature.featureId} className="flex items-center justify-between gap-2 rounded border border-gray-200 dark:border-gray-700 px-2 py-1.5 text-xs">
                          <span className="min-w-0 flex-1">
                            <span className="block truncate" title={feature.name}>
                              Feature: {feature.name} · {placement}
                            </span>
                            {initialPlacement && initialPlacement !== placement && (
                              <span className="block text-[10px] text-gray-500 dark:text-gray-400">
                                Initial proposal {initialPlacement}
                              </span>
                            )}
                          </span>
                          <button
                            type="button"
                            aria-label={`${locked ? 'Unlock' : 'Lock'} feature placement for ${feature.name}`}
                            aria-pressed={locked}
                            disabled={apply.isPending}
                            onClick={() => toggleFeatureLock(feature)}
                            className="shrink-0 underline focus:outline-none focus:ring-1 focus:ring-lab3-blue disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            {locked ? 'Unlock feature placement' : 'Lock feature placement'}
                          </button>
                        </div>
                      )
                    })}
                    {Array.from(displayedStories.values()).map(story => {
                      const locked = currentDraft?.manualStoryEntries.some(entry => entry.storyId === story.storyId) ?? false
                      const initial = proposalSchedule?.stories.find(entry => entry.storyId === story.storyId)
                      const placement = story.durationWeeks
                        ? weekRangeLabel(story.startWeek, story.startWeek + story.durationWeeks)
                        : `W${story.startWeek + 1}`
                      const initialPlacement = initial
                        ? weekRangeLabel(initial.startWeek, initial.startWeek + initial.durationWeeks)
                        : null
                      return (
                        <div key={story.storyId} className="flex items-center justify-between gap-2 rounded border border-gray-200 dark:border-gray-700 px-2 py-1.5 text-xs">
                          <span className="min-w-0 flex-1">
                            <span className="block truncate" title={story.name}>
                              Story: {story.name} · {placement}
                            </span>
                            {initialPlacement && initialPlacement !== placement && (
                              <span className="block text-[10px] text-gray-500 dark:text-gray-400">
                                Initial proposal {initialPlacement}
                              </span>
                            )}
                          </span>
                          <button
                            type="button"
                            aria-label={`${locked ? 'Unlock' : 'Lock'} story placement for ${story.name}`}
                            aria-pressed={locked}
                            disabled={apply.isPending}
                            onClick={() => toggleStoryLock(story)}
                            className="shrink-0 underline focus:outline-none focus:ring-1 focus:ring-lab3-blue disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            {locked ? 'Unlock story placement' : 'Lock story placement'}
                          </button>
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>

              {/* Action buttons */}
              <div className="space-y-2">
                <p id="squad-planner-apply-status" role="status" className="text-[11px] text-gray-500 dark:text-gray-400">
                  {applyStatus}
                </p>
                <div className="flex gap-2">
                  <button
                    type="button"
                    aria-describedby="squad-planner-apply-status"
                    onClick={async () => {
                      if (!canApply || !isApplyableResult(result)) return
                      if (!window.confirm('Apply this capacity profile? Resource profiles will be updated.')) return
                      try {
                        await apply.mutateAsync(result)
                        setApplyDone(true)
                        onClose()
                        Promise.all([
                          qc.refetchQueries({ queryKey: ['resource-profile', projectId] }),
                          qc.refetchQueries({ queryKey: ['timeline', projectId] }),
                          qc.refetchQueries({ queryKey: ['resource-types', projectId] }),
                        ]).catch(() => {
                          /* refetch failures are non-critical after successful apply */
                        })
                      } catch {
                        /* error state handled by mutation onError callback */
                      }
                    }}
                    disabled={!canApply}
                    className="flex-1 rounded-lg bg-lab3-navy px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-lab3-blue focus:outline-none focus:ring-2 focus:ring-lab3-blue focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {apply.isPending ? 'Applying capacity profile…' : '✓ Apply capacity profile'}
                  </button>
                  <button
                    type="button"
                    onClick={() => exportCsv(result, result.config?.periodWeeks ?? periodWeeks)}
                    disabled={resultIsStale || generate.isPending || apply.isPending || result.periods.length === 0}
                    className="rounded-lg border border-gray-200 px-4 py-2 text-sm font-medium text-gray-600 transition-colors hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-lab3-blue focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700"
                  >
                    📥 Export CSV
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  )
}
