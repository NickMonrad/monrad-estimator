/**
 * optimiser.ts — Pure resource optimiser for the Monrad Estimator.
 *
 * No Prisma, no I/O, no side effects. Calls runScheduler() in a tight loop
 * across a search space of resource configurations and ranks candidates.
 *
 * Performance note: scenarios are evaluated WITHOUT resource levelling
 * (resourceLevel: false) to keep each scheduler call O(features) rather than
 * running the time-step simulation. Utilisation is computed from total task
 * demand hours vs total capacity hours — a good comparative approximation.
 * Phase 4 can opt into more accurate levelled metrics if needed.
 *
 * Phase 3 of the Resource Optimiser feature, issue #233.
 */

import {
  runScheduler,
  getWeeklyCapacity,
  type SchedulerInput,
  type SchedulerResourceType,
} from './scheduler.js'

// ─────────────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────────────

export type OptimiserMode = 'speed' | 'utilisation' | 'balanced'

export interface OptimiserConfig {
  mode: OptimiserMode
  constraints: {
    /** Per resource type: min/max count to search */
    countRanges: Array<{ resourceTypeId: string; min: number; max: number }>
    /**
     * If true, suggestedStartWeek on each candidate RT reflects the first
     * week that RT has demand in the baseline run (ramp-up hint).
     * If false, suggestedStartWeek is always 0.
     */
    allowRampUp: boolean
    /** Candidates with estimatedCost > maxBudget are filtered out. */
    maxBudget?: number
    /** Candidates with deliveryWeeks > maxDurationWeeks are filtered out. */
    maxDurationWeeks?: number
  }
  /**
   * Day rate per RT (resourceTypeId → dayRate).
   * weeklyRate = count × dayRate × 5 days.
   *
   * NOTE: Phase 3 uses ResourceType.dayRate directly (passed in by the route).
   * Full rate-card integration is deferred to Phase 4.
   * If absent or empty, estimatedCost = 0 for all candidates.
   */
  dayRates?: Map<string, number>
  /** Top N candidates to return (ranked best-first) */
  topN: number
  /**
   * Optional PRNG for random sampling (injected for deterministic testing).
   * Defaults to Math.random when not provided.
   */
  rng?: () => number
}

export interface OptimiserCandidate {
  resourceTypes: Array<{
    resourceTypeId: string
    count: number
    /** First week this RT has demand (from baseline). Used by the apply endpoint. */
    suggestedStartWeek: number
  }>
  metrics: {
    deliveryWeeks: number
    avgUtilisationPct: number
    /** Count of gap weeks per resourceTypeId (capacity > 0, no demand scheduled) */
    gapWeeksByResourceTypeId: Map<string, number>
    /** 0 when dayRates not provided */
    estimatedCost: number
    parallelWarningCount: number
  }
  score: number
  /** Per-component breakdown for UI display */
  scoreBreakdown: Record<string, number>
}

export interface OptimiserResult {
  candidates: OptimiserCandidate[] // top N, ranked best-first
  baseline: OptimiserCandidate     // current config metrics for diff display
  searchStats: {
    /** Total number of scheduler invocations (includes filtered-out scenarios) */
    scenariosEvaluated: number
    /** Number of scenarios that passed all constraints (≤ scenariosEvaluated) */
    candidatesFound: number
    durationMs: number
    /** true when search space exceeded MAX_SCENARIOS and random sampling was used */
    sampled: boolean
  }
  /**
   * Count of scenarios filtered out specifically because parallelWarningCount > 0.
   * These are strictly infeasible: a parallel-mode epic exceeded RT capacity.
   */
  infeasibleCount: number
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal constants
// ─────────────────────────────────────────────────────────────────────────────

const MAX_SCENARIOS = 5000

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Total grid search space size */
function searchSpaceSize(
  ranges: Array<{ resourceTypeId: string; min: number; max: number }>,
): number {
  return ranges.reduce((acc, r) => acc * Math.max(1, r.max - r.min + 1), 1)
}

/** Generate all combinations (cartesian product) of count arrays. */
function cartesianProduct(
  ranges: Array<{ resourceTypeId: string; min: number; max: number }>,
): Array<Array<{ resourceTypeId: string; count: number }>> {
  let result: Array<Array<{ resourceTypeId: string; count: number }>> = [[]]
  for (const range of ranges) {
    const next: Array<Array<{ resourceTypeId: string; count: number }>> = []
    for (const existing of result) {
      for (let c = range.min; c <= range.max; c++) {
        next.push([...existing, { resourceTypeId: range.resourceTypeId, count: c }])
      }
    }
    result = next
  }
  return result
}

/**
 * Random sample of `n` unique configurations from the search space.
 * Samples each RT count independently — does not require enumerating the
 * full space. Uses a seen-set to avoid duplicates.
 */
function randomSample(
  ranges: Array<{ resourceTypeId: string; min: number; max: number }>,
  n: number,
  rng: () => number = Math.random,
): Array<Array<{ resourceTypeId: string; count: number }>> {
  const samples: Array<Array<{ resourceTypeId: string; count: number }>> = []
  const seen = new Set<string>()
  const maxAttempts = n * 10

  for (let attempts = 0; attempts < maxAttempts && samples.length < n; attempts++) {
    const config = ranges.map(r => ({
      resourceTypeId: r.resourceTypeId,
      count: r.min + Math.floor(rng() * (r.max - r.min + 1)),
    }))
    const key = config.map(c => `${c.resourceTypeId}:${c.count}`).join(',')
    if (!seen.has(key)) {
      seen.add(key)
      samples.push(config)
    }
  }
  return samples
}

/** Deep-clone resource types, overriding counts for the given RTs. */
function applyCountOverrides(
  baseRTs: SchedulerResourceType[],
  overrides: Array<{ resourceTypeId: string; count: number }>,
): SchedulerResourceType[] {
  const overrideMap = new Map(overrides.map(o => [o.resourceTypeId, o.count]))
  return baseRTs.map(rt => ({
    ...rt,
    count: overrideMap.has(rt.id) ? overrideMap.get(rt.id)! : rt.count,
    // shallow-clone namedResources so we don't mutate the originals
    namedResources: rt.namedResources.map(nr => ({ ...nr })),
  }))
}

/**
 * Compute optimiser metrics from a scheduler input + its feature schedule output.
 *
 * Does NOT require resource levelling — utilisation is computed as:
 *   totalDemandHours(rt) / totalCapacityHours(rt, 0..deliveryWeeks)
 *
 * Gap weeks: weeks where an RT has capacity but no feature that uses it is
 * scheduled to run during that week.
 */
function computeMetrics(
  input: SchedulerInput,
  featureSchedule: Array<{ featureId: string; startWeek: number; durationWeeks: number }>,
  parallelWarningCount: number,
  dayRates?: Map<string, number>,
): OptimiserCandidate['metrics'] {
  const hoursPerDay = input.project.hoursPerDay

  const deliveryWeeks =
    featureSchedule.length > 0
      ? Math.max(...featureSchedule.map(e => e.startWeek + e.durationWeeks))
      : 0

  // ── Build task demand hours and active week sets per RT ───────────────────
  const scheduleByFeature = new Map(featureSchedule.map(e => [e.featureId, e]))
  const demandHoursByRtId = new Map<string, number>()
  const activeWeeksByRtId = new Map<string, Set<number>>()

  for (const epic of input.epics) {
    for (const feature of epic.features) {
      if (feature.isActive === false) continue
      const sched = scheduleByFeature.get(feature.id)

      for (const story of feature.userStories) {
        if (story.isActive === false) continue
        for (const task of story.tasks) {
          if (!task.resourceTypeId) continue
          const rtId = task.resourceTypeId

          // Accumulate demand hours
          demandHoursByRtId.set(rtId, (demandHoursByRtId.get(rtId) ?? 0) + task.hoursEffort)

          // Mark which weeks this feature runs (for gap week calculation)
          if (sched && sched.durationWeeks > 0) {
            let set = activeWeeksByRtId.get(rtId)
            if (!set) { set = new Set(); activeWeeksByRtId.set(rtId, set) }
            const startW = Math.floor(sched.startWeek)
            const endW = Math.ceil(sched.startWeek + sched.durationWeeks)
            for (let w = startW; w < endW; w++) {
              set.add(w)
            }
          }
        }
      }
    }
  }

  // ── Utilisation and gap weeks per RT ──────────────────────────────────────
  let totalUtil = 0
  let rtWithDemandCount = 0
  const gapWeeksByResourceTypeId = new Map<string, number>()

  for (const rt of input.resourceTypes) {
    const demandHours = demandHoursByRtId.get(rt.id) ?? 0
    if (demandHours === 0 || deliveryWeeks <= 0) continue

    let totalCapacityHours = 0
    let gapWeeks = 0
    const activeWeeks = activeWeeksByRtId.get(rt.id) ?? new Set<number>()

    for (let w = 0; w < Math.ceil(deliveryWeeks); w++) {
      const capHours = getWeeklyCapacity(rt, w, hoursPerDay)
      totalCapacityHours += capHours
      if (capHours > 0 && !activeWeeks.has(w)) gapWeeks++
    }

    if (totalCapacityHours > 0) {
      totalUtil += (demandHours / totalCapacityHours) * 100
      rtWithDemandCount++
    }
    gapWeeksByResourceTypeId.set(rt.id, gapWeeks)
  }

  const avgUtilisationPct = rtWithDemandCount > 0 ? totalUtil / rtWithDemandCount : 0

  // ── Estimated cost ────────────────────────────────────────────────────────
  // Demand-based cost (matches Effort Review / Resource Profile):
  //   Σ over active tasks: (hoursEffort / hpd) × dayRate
  // We deliberately do NOT use count × dayRate × deliveryWeeks (capacity-based)
  // because that bills for idle time and diverges from the rest of the app.
  let estimatedCost = 0
  if (dayRates && dayRates.size > 0) {
    for (const epic of input.epics) {
      for (const feature of epic.features) {
        if (feature.isActive === false) continue
        for (const story of feature.userStories) {
          if (story.isActive === false) continue
          for (const task of story.tasks) {
            if (!task.resourceTypeId) continue
            const dayRate = dayRates.get(task.resourceTypeId) ?? 0
            if (dayRate <= 0) continue
            const rt = input.resourceTypes.find(r => r.id === task.resourceTypeId)
            const hpd = rt?.hoursPerDay ?? input.project.hoursPerDay
            estimatedCost += (task.hoursEffort / hpd) * dayRate
          }
        }
      }
    }
  }

  return {
    deliveryWeeks,
    avgUtilisationPct,
    gapWeeksByResourceTypeId,
    estimatedCost,
    parallelWarningCount,
  }
}

/** Score a candidate and produce a per-component breakdown. */
function scoreCandidate(
  metrics: OptimiserCandidate['metrics'],
  mode: OptimiserMode,
  normMin: { deliveryWeeks: number; cost: number; utilisation: number },
  normMax: { deliveryWeeks: number; cost: number; utilisation: number },
): { score: number; scoreBreakdown: Record<string, number> } {
  const norm = (val: number, min: number, max: number) =>
    max === min ? 0.5 : (val - min) / (max - min)

  if (mode === 'speed') {
    // Lower weeks = higher score. Tiebreak hints stored for sort step.
    const score = -metrics.deliveryWeeks
    return {
      score,
      scoreBreakdown: {
        deliveryWeeksComponent: score,
        costTiebreak: -metrics.estimatedCost,
        utilisationTiebreak: metrics.avgUtilisationPct,
      },
    }
  }

  if (mode === 'utilisation') {
    // Higher utilisation = higher score.
    const score = metrics.avgUtilisationPct
    return {
      score,
      scoreBreakdown: {
        utilisationComponent: score,
        deliveryWeeksTiebreak: -metrics.deliveryWeeks,
      },
    }
  }

  // balanced: speed×0.4 + utilisation×0.4 + (1/cost)×0.2
  // When no costs available, redistribute weight equally (0.5/0.5).
  const normWeeks = norm(metrics.deliveryWeeks, normMin.deliveryWeeks, normMax.deliveryWeeks)
  const normUtil = norm(metrics.avgUtilisationPct, normMin.utilisation, normMax.utilisation)
  const hasCosts = normMax.cost > 0

  if (hasCosts) {
    const normCost = norm(metrics.estimatedCost, normMin.cost, normMax.cost)
    const speedC = (1 - normWeeks) * 0.4
    const utilC = normUtil * 0.4
    const costC = (1 - normCost) * 0.2
    return {
      score: speedC + utilC + costC,
      scoreBreakdown: { speedComponent: speedC, utilisationComponent: utilC, costComponent: costC },
    }
  } else {
    const speedC = (1 - normWeeks) * 0.5
    const utilC = normUtil * 0.5
    return {
      score: speedC + utilC,
      scoreBreakdown: { speedComponent: speedC, utilisationComponent: utilC },
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main entry point
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Run the resource optimiser.
 *
 * Pure function: no database access, no I/O. Can be called from tests or
 * the HTTP route handler without side effects.
 */
export function runOptimiser(
  baseInput: SchedulerInput,
  config: OptimiserConfig,
  _now: () => number = Date.now,
): OptimiserResult {
  const startMs = _now()
  const { mode, constraints, dayRates, topN } = config
  const { countRanges, allowRampUp, maxBudget, maxDurationWeeks } = constraints

  // ── 1. Baseline run (non-levelled, consistent with scenario evaluations) ──
  const baselineOutput = runScheduler({ ...baseInput, resourceLevel: false })

  // Find first demand week per RT from the feature schedule (for rampUp hints).
  // For each RT, the suggested start week is the earliest feature start week
  // that contains tasks for that RT.
  const firstDemandWeekByRtId = new Map<string, number>()
  const schedByFeature = new Map(
    baselineOutput.featureSchedule.map(e => [e.featureId, e]),
  )
  for (const epic of baseInput.epics) {
    for (const feature of epic.features) {
      if (feature.isActive === false) continue
      const sched = schedByFeature.get(feature.id)
      if (!sched) continue
      for (const story of feature.userStories) {
        if (story.isActive === false) continue
        for (const task of story.tasks) {
          if (!task.resourceTypeId) continue
          const existing = firstDemandWeekByRtId.get(task.resourceTypeId)
          if (existing === undefined || sched.startWeek < existing) {
            firstDemandWeekByRtId.set(task.resourceTypeId, Math.floor(sched.startWeek))
          }
        }
      }
    }
  }

  // When ramp-up is enabled, the apply route shifts namedResources[].startWeek
  // to the first demand week (only when > 0). Mirror that in scoring so a
  // candidate's metrics reflect the schedule that will actually be applied;
  // otherwise a scenario can look feasible here but be infeasible after apply.
  function applyRampUp(rts: SchedulerResourceType[]): SchedulerResourceType[] {
    if (!allowRampUp) return rts
    return rts.map(rt => {
      const sw = firstDemandWeekByRtId.get(rt.id)
      if (sw === undefined || sw <= 0) return rt
      return {
        ...rt,
        namedResources: rt.namedResources.map(nr => ({ ...nr, startWeek: sw })),
      }
    })
  }

  // Re-run the baseline with ramp-up overlays so the displayed baseline candidate
  // matches what would actually ship if the user clicked "apply".
  const baselineRTs = applyRampUp(baseInput.resourceTypes)
  const baselineInputForMetrics: SchedulerInput =
    allowRampUp
      ? { ...baseInput, resourceTypes: baselineRTs, resourceLevel: false }
      : { ...baseInput, resourceLevel: false }
  const baselineOutputForMetrics = allowRampUp
    ? runScheduler(baselineInputForMetrics)
    : baselineOutput

  const baselineMetrics = computeMetrics(
    baselineInputForMetrics,
    baselineOutputForMetrics.featureSchedule,
    baselineOutputForMetrics.parallelWarnings.length,
    dayRates,
  )

  const baselineCandidate: OptimiserCandidate = {
    resourceTypes: baseInput.resourceTypes.map(rt => ({
      resourceTypeId: rt.id,
      count: rt.count,
      suggestedStartWeek: allowRampUp ? (firstDemandWeekByRtId.get(rt.id) ?? 0) : 0,
    })),
    metrics: baselineMetrics,
    score: 0,
    scoreBreakdown: {},
  }

  // ── 2. Generate scenarios ─────────────────────────────────────────────────
  const totalSpace = searchSpaceSize(countRanges)
  let scenarios: Array<Array<{ resourceTypeId: string; count: number }>>
  let sampled = false

  if (totalSpace <= MAX_SCENARIOS) {
    scenarios = cartesianProduct(countRanges)
  } else {
    scenarios = randomSample(countRanges, MAX_SCENARIOS, config.rng ?? Math.random)
    sampled = true
  }

  // ── 3. Evaluate each scenario ─────────────────────────────────────────────
  type RawCandidate = {
    resourceTypes: OptimiserCandidate['resourceTypes']
    metrics: OptimiserCandidate['metrics']
  }

  const rawCandidates: RawCandidate[] = []
  let scenariosRun = 0
  let infeasibleCount = 0

  for (const scenario of scenarios) {
    scenariosRun++
    const overrideMap = new Map(scenario.map(s => [s.resourceTypeId, s.count]))
    const newRTs = applyRampUp(applyCountOverrides(baseInput.resourceTypes, scenario))
    const scenarioInput: SchedulerInput = { ...baseInput, resourceTypes: newRTs, resourceLevel: false }

    const output = runScheduler(scenarioInput)

    const deliveryWeeks =
      output.featureSchedule.length > 0
        ? Math.max(...output.featureSchedule.map(e => e.startWeek + e.durationWeeks))
        : 0

    // Apply maxDurationWeeks constraint
    if (maxDurationWeeks !== undefined && deliveryWeeks > maxDurationWeeks) continue

    const metrics = computeMetrics(
      scenarioInput,
      output.featureSchedule,
      output.parallelWarnings.length,
      dayRates,
    )

    // Apply maxBudget constraint
    if (maxBudget !== undefined && metrics.estimatedCost > maxBudget) continue

    // Strict feasibility: drop any scenario with parallel over-allocation warnings.
    // PARALLEL_EPICS mode doesn't extend delivery weeks when capacity is exceeded,
    // so lowering counts looks "free" to the scorer — these scenarios are infeasible.
    if (metrics.parallelWarningCount > 0) {
      infeasibleCount++
      continue
    }

    rawCandidates.push({
      resourceTypes: baseInput.resourceTypes.map(rt => ({
        resourceTypeId: rt.id,
        count: overrideMap.get(rt.id) ?? rt.count,
        suggestedStartWeek: allowRampUp ? (firstDemandWeekByRtId.get(rt.id) ?? 0) : 0,
      })),
      metrics,
    })
  }

  // ── 4. Score & rank ───────────────────────────────────────────────────────
  // Compute normalisation bounds across all candidates (needed for balanced mode)
  const normMin = { deliveryWeeks: Infinity, cost: Infinity, utilisation: Infinity }
  const normMax = { deliveryWeeks: -Infinity, cost: -Infinity, utilisation: -Infinity }

  for (const c of rawCandidates) {
    normMin.deliveryWeeks = Math.min(normMin.deliveryWeeks, c.metrics.deliveryWeeks)
    normMax.deliveryWeeks = Math.max(normMax.deliveryWeeks, c.metrics.deliveryWeeks)
    normMin.cost = Math.min(normMin.cost, c.metrics.estimatedCost)
    normMax.cost = Math.max(normMax.cost, c.metrics.estimatedCost)
    normMin.utilisation = Math.min(normMin.utilisation, c.metrics.avgUtilisationPct)
    normMax.utilisation = Math.max(normMax.utilisation, c.metrics.avgUtilisationPct)
  }

  // Guard: empty candidate list (e.g. all filtered by constraints)
  if (!isFinite(normMin.deliveryWeeks)) {
    normMin.deliveryWeeks = 0; normMax.deliveryWeeks = 0
    normMin.cost = 0; normMax.cost = 0
    normMin.utilisation = 0; normMax.utilisation = 0
  }

  const scoredCandidates: OptimiserCandidate[] = rawCandidates.map(c => {
    const { score, scoreBreakdown } = scoreCandidate(c.metrics, mode, normMin, normMax)
    return { ...c, score, scoreBreakdown }
  })

  // Sort descending by score, then apply mode-specific tiebreaks
  scoredCandidates.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    if (mode === 'speed') {
      // Lower cost wins, then higher utilisation
      if (a.metrics.estimatedCost !== b.metrics.estimatedCost) {
        return a.metrics.estimatedCost - b.metrics.estimatedCost
      }
      return b.metrics.avgUtilisationPct - a.metrics.avgUtilisationPct
    }
    if (mode === 'utilisation') {
      // Fewer delivery weeks wins
      return a.metrics.deliveryWeeks - b.metrics.deliveryWeeks
    }
    return 0
  })

  // Score the baseline with the same normalisation bounds (for diff display)
  const { score: baselineScore, scoreBreakdown: baselineBreakdown } = scoreCandidate(
    baselineMetrics,
    mode,
    normMin,
    normMax,
  )
  baselineCandidate.score = baselineScore
  baselineCandidate.scoreBreakdown = baselineBreakdown

  return {
    candidates: scoredCandidates.slice(0, topN),
    baseline: baselineCandidate,
    searchStats: {
      scenariosEvaluated: scenariosRun,
      candidatesFound: rawCandidates.length,
      durationMs: _now() - startMs,
      sampled,
    },
    infeasibleCount,
  }
}
