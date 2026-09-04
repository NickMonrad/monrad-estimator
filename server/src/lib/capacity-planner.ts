/**
 * capacity-planner.ts — Demand Envelope capacity planner for squad sizing.
 *
 * Pure function: no I/O, no Prisma, no side effects.
 * Given a backlog (SchedulerInput) and a target delivery window, computes
 * the minimum smooth capacity envelope per resource type per period.
 *
 * #481 adds `computeJointPlan()` — an iterative feedback loop that
 * reconciles candidate capacity with capacity-aware scheduling until
 * the target/minimum-capacity stopping criteria are met or hard
 * infeasibility is proven.
 */

import { type SchedulerInput, type SchedulerResourceType } from './scheduler.js'
import { type LevellingResult } from './leveller.js'
import {
  runSAPlanner,
  analyzeTargetMiss,
  SAPlannerInfeasibleError,
  type SAPlannerConfig,
  type SAPlannerResult,
  type PlannerDiagnostic,
} from './sa-planner.js'

// ─── Public types ────────────────────────────────────────────────────────────

export interface CapacityPlanConfig {
  /** Target delivery duration in weeks (e.g., 78 for 18 months) */
  targetDurationWeeks: number
  /** Period length: 4 = monthly, 13 = quarterly */
  periodWeeks: 4 | 13
  /** Max headcount change per RT per period (default 1) */
  maxDeltaPerPeriod: number
  /** Capacity smoothing mode. Defaults to 'smooth'. */
  smoothingMode?: 'smooth' | 'tight' | 'exact'
  /** Minimum headcount floor per RT (rtId → min count). Default 0 for all. */
  minFloor: Map<string, number>
  /** Maximum headcount cap per RT (rtId → max count). No cap if not specified. */
  maxCap?: Map<string, number>
  /** Day rates for cost computation (rtId → dayRate) */
  dayRates: Map<string, number>
  /** Max over-allocation buffer as a fraction (0.2 = 20% above demand). Default 0.2 */
  maxAllocationBufferPct?: number
  /** Max people from one RT that can work on a single feature simultaneously. Default 2. */
  maxParallelismPerFeature?: number
  /** Maximum number of epics active simultaneously. Default: all (no limit). */
  maxConcurrentEpics?: number
  /** Optional maximum budget — if exceeded, result includes overflow flag */
  maxBudget?: number
}

export interface CapacityPlanPeriodResult {
  periodIndex: number
  periodLabel: string       // "Month 1", "Q1 FY27", etc.
  startWeek: number
  endWeek: number
  resources: Array<{
    resourceTypeId: string
    resourceTypeName: string
    headcount: number       // smoothed capacity (supports fractional FTE)
    peakDemandFTE: number   // peak demand in this period (can be fractional)
    avgDemandFTE: number    // average demand in this period
    utilisationPct: number  // avg / headcount × 100 (0 if headcount is 0)
    costForPeriod: number   // headcount × dayRate × periodWeeks × 5
  }>
}

const HEADCOUNT_QUANTUM = 0.25
const FLOAT_EPSILON = 0.000001
const EPSILON = 1e-6

function round2(value: number): number {
  return Math.round(value * 100) / 100
}

function quantizeHeadcountUp(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0
  return round2(Math.ceil((value - FLOAT_EPSILON) / HEADCOUNT_QUANTUM) * HEADCOUNT_QUANTUM)
}

export interface CapacityPlanResult {
  periods: CapacityPlanPeriodResult[]
  totalCost: number
  deliveryWeeks: number
  peakHeadcount: number     // max sum of all RT headcounts in any period
  avgUtilisationPct: number // weighted average utilisation across all periods/RTs
  budgetExceeded: boolean
  /** The levelling result that produced this plan */
  levellingResult: LevellingResult
  /** Demand RTs that were included in planning (only those with task demand) */
  plannedResourceTypeIds: string[]
  /** Structured infeasibility diagnostics (present when planner fails) */
  diagnostics?: PlannerDiagnostic[]
}

/** Result from the joint schedule/capacity planning loop (#481). */
export interface JointPlanResult extends CapacityPlanResult {
  /** Number of iterations the joint loop ran before converging or stopping. */
  iterations: number
  /** Structured diagnostics from all planner runs in the loop. */
  loopDiagnostics: PlannerDiagnostic[]
  /** Whether the target was achieved. */
  targetAchieved: boolean
}

// ─── Capacity envelope derivation (shared by computeCapacityPlan and loop) ──

/** Capacity quantum for headcount adjustments (0.25 FTE). */
export const CAPACITY_QUANTUM = HEADCOUNT_QUANTUM

/**
 * Derive a smoothed capacity envelope from demand peaks/averages.
 * Pure function: given per-RT per-period demand data, produce quantised
 * headcount that covers demand with optional smoothing.
 */
function deriveCapacityEnvelope(
  _resourceTypes: SchedulerResourceType[],
  totalWeeks: number,
  periodWeeks: number,
  peakFTE: Map<string, number[]>,
  avgFTE: Map<string, number[]>,
  config: CapacityPlanConfig,
): Map<string, number[]> {
  const { maxDeltaPerPeriod, smoothingMode = 'smooth', minFloor, maxCap, maxAllocationBufferPct } = config
  const numPeriods = Math.max(1, Math.ceil(totalWeeks / periodWeeks))
  const plannedRtIds = [...peakFTE.keys()]

  // Reconstruct demandDays from avgFTE for buffer calculation
  const demandDays = new Map<string, Float64Array>()
  for (const rtId of plannedRtIds) {
    const arr = new Float64Array(totalWeeks + 1)
    const avgs = avgFTE.get(rtId)!
    for (let p = 0; p < numPeriods; p++) {
      const startW = p * periodWeeks
      const endW = Math.min((p + 1) * periodWeeks, totalWeeks + 1)
      const avgDaysPerWeek = (avgs[p] ?? 0) * 5
      for (let w = startW; w < endW; w++) arr[w] = avgDaysPerWeek
    }
    demandDays.set(rtId, arr)
  }

  const capacity = new Map<string, number[]>()
  const envelopeBuffer = 1.1

  for (const rtId of plannedRtIds) {
    const avgs = avgFTE.get(rtId)!
    const peaks = peakFTE.get(rtId)!
    const cap = avgs.map((avg, i) => {
      const fromAvg = quantizeHeadcountUp(avg * envelopeBuffer)
      const fromPeak = quantizeHeadcountUp(peaks[i])
      return Math.max(fromAvg, fromPeak)
    })
    capacity.set(rtId, cap)
  }

  // Apply minimum floor
  for (const rtId of plannedRtIds) {
    const floor = minFloor.get(rtId) ?? 0
    const cap = capacity.get(rtId)!
    for (let p = 0; p < numPeriods; p++) {
      if (cap[p] < floor) cap[p] = quantizeHeadcountUp(floor)
    }
  }

  // Forward-backward smoothing
  const smoothingPasses = smoothingMode === 'smooth' ? 5 : smoothingMode === 'tight' ? 1 : 0
  for (let pass = 0; pass < smoothingPasses; pass++) {
    let changed = false
    for (const rtId of plannedRtIds) {
      const cap = capacity.get(rtId)!
      for (let p = 1; p < numPeriods; p++) {
        if (cap[p] > cap[p - 1] + maxDeltaPerPeriod) { cap[p] = cap[p - 1] + maxDeltaPerPeriod; changed = true }
      }
      for (let p = numPeriods - 2; p >= 0; p--) {
        if (cap[p] > cap[p + 1] + maxDeltaPerPeriod) { cap[p] = cap[p + 1] + maxDeltaPerPeriod; changed = true }
      }
      const floor = minFloor.get(rtId) ?? 0
      for (let p = 0; p < numPeriods; p++) {
        const minFloorCapacity = quantizeHeadcountUp(floor)
        if (cap[p] < minFloorCapacity) { cap[p] = minFloorCapacity; changed = true }
      }
      const peaks = peakFTE.get(rtId)!
      for (let p = 0; p < numPeriods; p++) {
        const needed = quantizeHeadcountUp(peaks[p])
        if (cap[p] < needed) { cap[p] = needed; changed = true }
      }
    }
    if (!changed) break
  }

  // Apply per-RT max cap
  if (maxCap) {
    for (const rtId of plannedRtIds) {
      const cap = maxCap.get(rtId)
      if (cap == null) continue
      const arr = capacity.get(rtId)!
      for (let p = 0; p < numPeriods; p++) { if (arr[p] > cap) arr[p] = cap }
    }
  }

  // Cap total allocation per RT (over-allocation buffer)
  const bufferPct = maxAllocationBufferPct ?? 0.2
  for (const rtId of plannedRtIds) {
    const arr = demandDays.get(rtId)!
    let totalDemand = 0
    for (let w = 0; w < arr.length; w++) totalDemand += arr[w]
    if (totalDemand <= 0) continue
    const maxAllocatedDays = totalDemand * (1 + bufferPct)
    const cap = capacity.get(rtId)!
    const floor = quantizeHeadcountUp(minFloor.get(rtId) ?? 0)
    const getAllocatedDays = () => {
      let total = 0
      for (let p = 0; p < numPeriods; p++) {
        const pStart = p * periodWeeks
        const pEnd = Math.min((p + 1) * periodWeeks, totalWeeks + 1)
        total += cap[p] * (pEnd - pStart) * 5
      }
      return total
    }
    let currentAllocated = getAllocatedDays()
    if (currentAllocated <= maxAllocatedDays) continue
    const avgs = avgFTE.get(rtId)!
    const periodsByUtil = Array.from({ length: numPeriods }, (_, i) => i)
      .sort((a, b) => (cap[a] > 0 ? avgs[a] / cap[a] : 0) - (cap[b] > 0 ? avgs[b] / cap[b] : 0))
    for (const p of periodsByUtil) {
      if (currentAllocated <= maxAllocatedDays) break
      const peaks = peakFTE.get(rtId)!
      const minRequired = Math.max(floor, quantizeHeadcountUp(peaks[p]))
      while (cap[p] > minRequired + FLOAT_EPSILON && currentAllocated > maxAllocatedDays) {
        cap[p] = round2(Math.max(minRequired, cap[p] - HEADCOUNT_QUANTUM))
        currentAllocated = getAllocatedDays()
      }
    }
  }

  return capacity
}

/**
 * Build period-level output from a capacity envelope and demand data.
 * Pure function: no I/O, no side effects.
 */
function buildEnvelopeOutput(
  input: SchedulerInput,
  totalWeeks: number,
  periodWeeks: number,
  capacity: Map<string, number[]>,
  peakFTE: Map<string, number[]>,
  avgFTE: Map<string, number[]>,
  levelResult: LevellingResult,
  config: CapacityPlanConfig,
): CapacityPlanResult {
  const { dayRates, maxBudget } = config
  const numPeriods = Math.max(1, Math.ceil(totalWeeks / periodWeeks))
  const plannedRtIds = [...capacity.keys()]
  const rtById = new Map(input.resourceTypes.map(rt => [rt.id, rt]))
  const periods: CapacityPlanPeriodResult[] = []
  let totalCost = 0
  let peakHeadcount = 0
  let totalUtilWeighted = 0
  let totalUtilWeight = 0

  for (let p = 0; p < numPeriods; p++) {
    const pStartWeek = p * periodWeeks
    const pEndWeek = Math.min((p + 1) * periodWeeks, totalWeeks + 1)
    const periodLabel = periodWeeks === 4 ? `Month ${p + 1}` : `Q${p + 1}`
    let periodHeadcount = 0
    const resources: CapacityPlanPeriodResult['resources'] = []

    for (const rtId of plannedRtIds) {
      const rt = rtById.get(rtId)!
      const headcount = capacity.get(rtId)![p]
      const peak = peakFTE.get(rtId)![p]
      const avg = avgFTE.get(rtId)![p]
      const util = headcount > 0 ? (avg / headcount) * 100 : 0
      const dayRate = dayRates.get(rtId) ?? 0
      const costForPeriod = headcount * dayRate * (pEndWeek - pStartWeek) * 5
      resources.push({
        resourceTypeId: rtId, resourceTypeName: rt.name,
        headcount: round2(headcount), peakDemandFTE: Math.round(peak * 100) / 100,
        avgDemandFTE: Math.round(avg * 100) / 100, utilisationPct: Math.round(util * 10) / 10,
        costForPeriod: Math.round(costForPeriod),
      })
      totalCost += costForPeriod; periodHeadcount += headcount
      totalUtilWeighted += util * headcount; totalUtilWeight += headcount
    }
    if (periodHeadcount > peakHeadcount) peakHeadcount = periodHeadcount
    periods.push({ periodIndex: p, periodLabel, startWeek: pStartWeek, endWeek: pEndWeek, resources })
  }

  const avgUtilisationPct = totalUtilWeight > 0 ? Math.round((totalUtilWeighted / totalUtilWeight) * 10) / 10 : 0
  return {
    periods, totalCost: Math.round(totalCost), deliveryWeeks: levelResult.totalDeliveryWeeks,
    peakHeadcount, avgUtilisationPct,
    budgetExceeded: maxBudget != null ? totalCost > maxBudget : false,
    levellingResult: levelResult, plannedResourceTypeIds: plannedRtIds,
  }
}

// ─── Resource type augmentation helpers (#481) ───────────────────────────────

/** Maximum iterations for the joint planning loop. Derived from the bounded
 *  search space: each iteration adds one quantum to one role. The bound is
 *  proportional to total possible increments across all roles. */
function computeMaxIterations(resourceTypes: SchedulerResourceType[], maxCap?: Map<string, number>): number {
  let totalSlots = 0
  for (const rt of resourceTypes) {
    const cap = maxCap?.get(rt.id) ?? 100
    totalSlots += Math.ceil(cap / CAPACITY_QUANTUM)
  }
  return Math.min(totalSlots + 10, 200)
}

/** Identify the primary bottleneck role: the role whose capacity-to-demand
 *  ratio is closest to 1.0 (fully utilised), breaking ties by total demand. */
function identifyBottleneckRole(
  weeklyDemandByRt: Map<string, number[]>,
  currentRts: SchedulerResourceType[],
): string | null {
  let bestRt: string | null = null
  let bestScore = -Infinity

  for (const rt of currentRts) {
    const demand = weeklyDemandByRt.get(rt.id) ?? []
    let totalDemand = 0
    for (const d of demand) totalDemand += d ?? 0
    if (totalDemand <= EPSILON) continue

    const maxWeeks = demand.length
    const maxCapacityDays = rt.count * 5 * maxWeeks
    if (maxCapacityDays <= EPSILON) continue
    const ratio = totalDemand / maxCapacityDays
    const score = ratio + totalDemand * 1e-10
    if (score > bestScore) { bestScore = score; bestRt = rt.id }
  }
  return bestRt
}

/** Effective candidate capacity (in FTE) of a resource type as seen by the
 *  scheduler. Profile-backed roles derive capacity from roleSegments
 *  allocationPercent (100% = 1 FTE); other roles from count. */
function currentCapacityFte(rt: SchedulerResourceType): number {
  if (rt.roleSegments && rt.roleSegments.length > 0) {
    let maxPct = 0
    for (const seg of rt.roleSegments) {
      if (seg.allocationPercent > maxPct) maxPct = seg.allocationPercent
    }
    return maxPct / 100
  }
  return rt.count
}

/** Create a copy of resource types with capacity increased by one quantum
 *  for the specified role. For segment-free roles, increments rt.count.
 *  For profile-backed roles (roleSegments present), raises aggregate role
 *  capacity by 25 percentage points inside EVERY existing segment window.
 *  Segment boundaries and gaps are preserved — capacity is never created
 *  outside an existing segment. */
export function augmentResourceType(
  resourceTypes: SchedulerResourceType[],
  rtId: string,
): SchedulerResourceType[] {
  return resourceTypes.map(rt => {
    if (rt.id !== rtId) return rt
    if (!rt.roleSegments || rt.roleSegments.length === 0) {
      return { ...rt, count: round2(rt.count + CAPACITY_QUANTUM) }
    }
    // Profile-backed: adjust the aggregate role capacity by one quantum
    // (0.25 FTE = 25 percentage points) per segment. The same representation
    // is used for reduction so grow/reduce stays symmetric.
    return {
      ...rt,
      roleSegments: rt.roleSegments.map(seg => ({
        ...seg,
        allocationPercent: seg.allocationPercent + CAPACITY_QUANTUM * 100,
      })),
    }
  })
}

/** Create a copy of resource types with capacity reduced by one quantum
 *  for the specified role. For segment-free roles, decrements rt.count.
 *  For profile-backed roles (roleSegments present), lowers aggregate role
 *  capacity by 25 percentage points inside EVERY existing segment window,
 *  never below zero. Segment boundaries and gaps are preserved.
 *  Returns reduced=false when no further reduction is possible. */
export function reduceResourceType(
  resourceTypes: SchedulerResourceType[],
  rtId: string,
): { rts: SchedulerResourceType[]; reduced: boolean } {
  const originalRt = resourceTypes.find(rt => rt.id === rtId)
  if (!originalRt) return { rts: resourceTypes, reduced: false }

  const isSegmentBased = originalRt.roleSegments && originalRt.roleSegments.length > 0

  const newRts = resourceTypes.map(rt => {
    if (rt.id !== rtId) return rt
    const roleSegments = rt.roleSegments
    if (!isSegmentBased || !roleSegments || roleSegments.length === 0) {
      const newCount = round2(rt.count - CAPACITY_QUANTUM)
      return { ...rt, count: Math.max(0, newCount) }
    }
    // Profile-backed: lower aggregate role capacity by one quantum
    // (0.25 FTE = 25 percentage points) per segment, floor at zero.
    return {
      ...rt,
      roleSegments: roleSegments.map(seg => ({
        ...seg,
        allocationPercent: Math.max(0, seg.allocationPercent - CAPACITY_QUANTUM * 100),
      })),
    }
  })

  // Report whether effective capacity actually decreased
  const newRt = newRts.find(rt => rt.id === rtId)
  if (!newRt) return { rts: newRts, reduced: false }

  if (!isSegmentBased) {
    // Count-based: reduced if count genuinely decreased
    return { rts: newRts, reduced: newRt.count < originalRt.count - FLOAT_EPSILON }
  }
  // Profile-backed: reduced if at least one segment's capacity decreased
  const originalSegments = originalRt.roleSegments ?? []
  const newSegments = newRt.roleSegments ?? []
  let reducedPercent = false
  for (let idx = 0; idx < newSegments.length; idx++) {
    const origPct = originalSegments[idx]?.allocationPercent ?? 0
    if (newSegments[idx].allocationPercent < origPct - FLOAT_EPSILON) {
      reducedPercent = true
      break
    }
  }
  return { rts: newRts, reduced: reducedPercent }
}


/**
 * Materialize a capacity envelope (period-level headcount) into scheduler-
 * compatible resource types.  For each RT the envelope peak headcount per
 * period is converted into named resources with capacity segments covering
 * the exact period windows.  This ensures the planner replays against the
 * exact same capacity model that the envelope describes.
 *
 * Pure function: no I/O, no side effects.
 */
export function materializeEnvelopeToResourceTypes(
  baseResourceTypes: SchedulerResourceType[],
  periods: CapacityPlanPeriodResult[],
  _periodWeeks: number,
): SchedulerResourceType[] {
  /** Intersect an envelope period range [periodStart, periodEnd) with the
   *  authoritative profile windows for a role.  Returns the list of sub-ranges
   *  that fall inside a profile window.  When no roleSegments exist the entire
   *  period range is returned unchanged (unconstrained role). */
  function intersectWithWindows(
    periodStart: number,
    periodEnd: number,
    roleSegments: Array<{ startWeek: number; endWeek: number }> | undefined,
  ): Array<{ startWeek: number; endWeek: number }> {
    if (!roleSegments || roleSegments.length === 0) {
      return [{ startWeek: periodStart, endWeek: periodEnd }]
    }
    const result: Array<{ startWeek: number; endWeek: number }> = []
    for (const seg of roleSegments) {
      // roleSegments endWeek is INCLUSIVE in the scheduler model
      // (week <= seg.endWeek contributes capacity), while envelope period
      // endWeek is EXCLUSIVE. Extend the window end by one so a demand week
      // on the final window week is still covered by the materialized NR.
      const overlapStart = Math.max(periodStart, seg.startWeek)
      const overlapEnd = Math.min(periodEnd, seg.endWeek + 1)
      if (overlapStart < overlapEnd) {
        result.push({ startWeek: overlapStart, endWeek: overlapEnd })
      }
    }
    return result
  }

  return baseResourceTypes.map(rt => {
    // Collect envelope headcount for this RT across periods
    const envelopeByPeriod: Array<{ startWeek: number; endWeek: number; headcount: number }> = []
    for (const period of periods) {
      const resource = period.resources.find(r => r.resourceTypeId === rt.id)
      if (resource && resource.headcount > 0) {
        envelopeByPeriod.push({ startWeek: period.startWeek, endWeek: period.endWeek, headcount: resource.headcount })
      }
    }
    if (envelopeByPeriod.length === 0) return rt

    // Peak envelope headcount — used as the count on the materialized RT so
    // getWeeklyCapacity() never adds phantom count slots beyond the
    // reconcile-* named resources (which always cover >= this headcount).
    let maxEnvelopeHeadcount = 0
    for (const ep of envelopeByPeriod) {
      if (ep.headcount > maxEnvelopeHeadcount) maxEnvelopeHeadcount = ep.headcount
    }
    maxEnvelopeHeadcount = round2(maxEnvelopeHeadcount)

    // Intersect each envelope period with authoritative profile windows
    const slotWindows: Array<{ startWeek: number; endWeek: number; allocationPercent: number }> = []
    for (const ep of envelopeByPeriod) {
      const subRanges = intersectWithWindows(ep.startWeek, ep.endWeek, rt.roleSegments)
      for (const range of subRanges) {
        const slotCount = Math.ceil(ep.headcount)
        for (let slot = 0; slot < slotCount; slot++) {
          const pct = slot < Math.floor(ep.headcount) ? 100 : (ep.headcount % 1) * 100 || 100
          slotWindows.push({
            startWeek: range.startWeek,
            // range.endWeek is exclusive; scheduler NR endWeek is inclusive.
            endWeek: range.endWeek - 1,
            allocationPercent: Math.max(25, Math.round(pct)),
          })
        }
      }
    }

    // Deduplicate identical adjacent windows into capacity segments
    const segments: Array<{ startWeek: number; endWeek: number; allocationPercent: number }> = []
    for (const sw of slotWindows) {
      const last = segments[segments.length - 1]
      // NR endWeek is inclusive, so two segments tile contiguously when
      // last.endWeek + 1 === sw.startWeek (identical single-week slots must
      // NOT merge — each slot is separate capacity).
      if (last && last.endWeek + 1 === sw.startWeek && last.allocationPercent === sw.allocationPercent) {
        last.endWeek = sw.endWeek
      } else {
        segments.push({ ...sw })
      }
    }

    // The materialized named resources ARE the authoritative capacity for
    // the reconciliation replay. Clear the stale aggregate roleSegments so
    // getWeeklyCapacity() cannot count them on top of the envelope, and set
    // count to the envelope peak so no phantom count slots appear either
    // (the reconcile-* named resources cover at least that headcount).
    // Precedent: buildReplayPlannerResourceTypes (#362 fix 3). Windows and
    // gaps remain hard because every reconcile-* window is clipped to the
    // original roleSegments above.
    return {
      ...rt,
      count: maxEnvelopeHeadcount,
      roleSegments: undefined,
      namedResources: segments.map((seg, idx) => ({
        id: `reconcile-${rt.id}-${idx}`,
        name: `${rt.name} reconcile-${idx}`,
        startWeek: seg.startWeek,
        endWeek: seg.endWeek,
        allocationPct: seg.allocationPercent,
        allocationMode: 'CAPACITY_PLAN',
        allocationPercent: seg.allocationPercent,
        allocationStartWeek: null,
        allocationEndWeek: null,
      })),
    }
  })
}

// ─── Main entry: computeCapacityPlan (single-shot, backward compatible) ─────

export function computeCapacityPlan(
  input: SchedulerInput,
  config: CapacityPlanConfig,
): CapacityPlanResult {
  const {
    targetDurationWeeks,
    periodWeeks,
    maxCap,
    maxParallelismPerFeature,
    maxConcurrentEpics,
  } = config

  const saConfig: SAPlannerConfig = {
    targetDurationWeeks,
    maxParallelismPerFeature,
    maxCap,
    maxConcurrentEpics,
    iterations: 10000,
    initialTemp: 100,
    coolingRate: 0.995,
  }

  const saResult = runSAPlanner(input, saConfig)
  const levelResult: LevellingResult = {
    epicStartWeeks: saResult.epicStartWeeks,
    featureStartWeeks: saResult.featureStartWeeks,
    totalDeliveryWeeks: saResult.totalDeliveryWeeks,
    peakUtilisationPct: saResult.peakUtilisationPct,
  }

  const totalWeeks = Math.ceil(levelResult.totalDeliveryWeeks)
  const resourceTypes = input.resourceTypes

  const demandDays = new Map<string, Float64Array>()
  for (const rt of resourceTypes) {
    demandDays.set(rt.id, new Float64Array(totalWeeks + 1))
  }

  for (const [rtId, weeklyDemand] of saResult.weeklyDemandByResourceType) {
    const arr = demandDays.get(rtId)
    if (!arr) continue
    for (let w = 0; w < Math.min(arr.length, weeklyDemand.length); w++) {
      arr[w] = weeklyDemand[w] ?? 0
    }
  }

  const plannedRtIds: string[] = []
  for (const [rtId, arr] of demandDays) {
    const hasDemand = arr.some(d => d > 0)
    if (hasDemand) plannedRtIds.push(rtId)
  }

  const numPeriods = Math.max(1, Math.ceil(totalWeeks / periodWeeks))
  const peakFTE = new Map<string, number[]>()
  const avgFTE = new Map<string, number[]>()

  for (const rtId of plannedRtIds) {
    const peaks = new Array<number>(numPeriods).fill(0)
    const avgs = new Array<number>(numPeriods).fill(0)
    const arr = demandDays.get(rtId)!

    for (let p = 0; p < numPeriods; p++) {
      const startW = p * periodWeeks
      const endW = Math.min((p + 1) * periodWeeks, totalWeeks + 1)
      let sum = 0
      let peak = 0
      let weekCount = 0
      for (let w = startW; w < endW; w++) {
        if (w < arr.length) {
          const fte = arr[w] / 5
          if (fte > peak) peak = fte
          sum += fte
          weekCount++
        }
      }
      peaks[p] = peak
      avgs[p] = weekCount > 0 ? sum / weekCount : 0
    }

    peakFTE.set(rtId, peaks)
    avgFTE.set(rtId, avgs)
  }

  const capacity = deriveCapacityEnvelope(resourceTypes, totalWeeks, periodWeeks, peakFTE, avgFTE, config)

  const diagnostics = saResult.totalDeliveryWeeks > targetDurationWeeks
    ? analyzeTargetMiss(saResult, input, saConfig)
    : undefined

  return {
    ...buildEnvelopeOutput(input, totalWeeks, periodWeeks, capacity, peakFTE, avgFTE, levelResult, config),
    diagnostics,
  }
}

// ─── Main entry: computeJointPlan (#481 iterative feedback loop) ─────────────

/**
 * Deterministic joint schedule/capacity planning loop.
 *
 * Iteratively reconciles candidate capacity with capacity-aware scheduling
 * until the target is met, hard infeasibility is proven, or the bounded
 * iteration limit is reached.
 *
 * The loop follows the approved #481 priority:
 * 1. correctness — effort, dependencies, hard constraints
 * 2. target attainment
 * 3. minimise total staffed FTE-weeks while meeting target
 * 4. minimise unnecessary peak staffing and ramp churn
 * 5. improve utilisation only where it does not conflict with the above
 *
 * Pure function: no I/O, no Prisma, no side effects.
 */
export function computeJointPlan(
  input: SchedulerInput,
  config: CapacityPlanConfig,
): JointPlanResult {
  const {
    targetDurationWeeks,
    periodWeeks,
    maxCap,
    maxParallelismPerFeature,
    maxConcurrentEpics,
  } = config

  const saConfig: SAPlannerConfig = {
    targetDurationWeeks,
    maxParallelismPerFeature,
    maxCap,
    maxConcurrentEpics,
    iterations: 10000,
    initialTemp: 100,
    coolingRate: 0.995,
  }

  const maxIterations = computeMaxIterations(input.resourceTypes, maxCap)
  let currentRts = [...input.resourceTypes]
  const allDiagnostics: PlannerDiagnostic[] = []
  let totalIterations = 0
  let iteration = 0

  // ── Phase 1: Initial run ──────────────────────────────────────────────────
  let initialSchedule: SAPlannerResult
  try {
    initialSchedule = runSAPlanner({ ...input, resourceTypes: currentRts }, saConfig)
  } catch (error) {
    if (error instanceof SAPlannerInfeasibleError) {
      allDiagnostics.push(...error.diagnostics)
    }
    // Infeasible from the start — return minimal result with diagnostics
    return {
      periods: [], totalCost: 0, deliveryWeeks: Infinity, peakHeadcount: 0,
      avgUtilisationPct: 0, budgetExceeded: false,
      levellingResult: { epicStartWeeks: new Map(), featureStartWeeks: new Map(),
        totalDeliveryWeeks: Infinity, peakUtilisationPct: 0 },
      plannedResourceTypeIds: [],
      diagnostics: allDiagnostics,
      iterations: 1,
      loopDiagnostics: allDiagnostics,
      targetAchieved: false,
    }
  }

  const initialDelivery = initialSchedule.totalDeliveryWeeks
  let bestResult = buildResult(initialSchedule, currentRts)
  let bestSchedule: SAPlannerResult = initialSchedule
  let bestRts: SchedulerResourceType[] = [...currentRts]
  let lastSchedule: SAPlannerResult = initialSchedule

  // Helper: derive envelope peaks/averages from a schedule
  function deriveDemandMetrics(sched: SAPlannerResult, rts: SchedulerResourceType[]) {
    const totalWeeks = Math.ceil(sched.totalDeliveryWeeks)
    const demandDays = new Map<string, Float64Array>()
    for (const rt of rts) demandDays.set(rt.id, new Float64Array(totalWeeks + 1))
    for (const [rtId, weeklyDemand] of sched.weeklyDemandByResourceType) {
      const arr = demandDays.get(rtId)
      if (!arr) continue
      for (let w = 0; w < Math.min(arr.length, weeklyDemand.length); w++) arr[w] = weeklyDemand[w] ?? 0
    }
    const plannedRtIds = [...demandDays.keys()].filter(rtId => {
      const arr = demandDays.get(rtId)!
      return arr.some(d => d > 0)
    })
    const numPeriods = Math.max(1, Math.ceil(totalWeeks / periodWeeks))
    const peakFTE = new Map<string, number[]>()
    const avgFTE = new Map<string, number[]>()
    for (const rtId of plannedRtIds) {
      const peaks = new Array<number>(numPeriods).fill(0)
      const avgs = new Array<number>(numPeriods).fill(0)
      const arr = demandDays.get(rtId)!
      for (let p = 0; p < numPeriods; p++) {
        const startW = p * periodWeeks
        const endW = Math.min((p + 1) * periodWeeks, totalWeeks + 1)
        let sum = 0, peak = 0, weekCount = 0
        for (let w = startW; w < endW; w++) {
          if (w < arr.length) {
            const fte = arr[w] / 5
            if (fte > peak) peak = fte
            sum += fte
            weekCount++
          }
        }
        peaks[p] = peak
        avgs[p] = weekCount > 0 ? sum / weekCount : 0
      }
      peakFTE.set(rtId, peaks)
      avgFTE.set(rtId, avgs)
    }
    return { totalWeeks, peakFTE, avgFTE, plannedRtIds }
  }

  // Helper: build a full CapacityPlanResult from a schedule
  function buildResult(sched: SAPlannerResult, rts: SchedulerResourceType[]): CapacityPlanResult {
    const { totalWeeks, peakFTE, avgFTE } = deriveDemandMetrics(sched, rts)
    const capacity = deriveCapacityEnvelope(rts, totalWeeks, periodWeeks, peakFTE, avgFTE, config)
    const levelResult: LevellingResult = {
      epicStartWeeks: sched.epicStartWeeks,
      featureStartWeeks: sched.featureStartWeeks,
      totalDeliveryWeeks: sched.totalDeliveryWeeks,
      peakUtilisationPct: sched.peakUtilisationPct,
    }
    return buildEnvelopeOutput(input, totalWeeks, periodWeeks, capacity, peakFTE, avgFTE, levelResult, config)
  }

  if (initialDelivery <= targetDurationWeeks) {
    // Target met on first run — skip to capacity reduction
  } else {
    // Collect post-completion diagnostics from initial run
    const initialDiags = analyzeTargetMiss(initialSchedule, input, saConfig)
    allDiagnostics.push(...initialDiags)

    // ── Phase 2: Iterative capacity growth ──────────────────────────────────
    let lastDelivery = initialDelivery
    let consecutiveNoImprove = 0

    while (iteration < maxIterations && lastDelivery > targetDurationWeeks) {
      iteration++
      const bottleneckRtId = identifyBottleneckRole(lastSchedule!.weeklyDemandByResourceType, currentRts)
      if (bottleneckRtId == null) break // no demand-driven bottleneck found

      // Check if explicit max cap prevents further growth for this role.
      // Compare scheduler-effective FTE capacity (count for plain roles,
      // roleSegments allocationPercent for profile-backed roles) so an
      // explicit cap stays hard for both representations.
      const maxForRole = maxCap?.get(bottleneckRtId)
      const currentBottleneckRt = currentRts.find(rt => rt.id === bottleneckRtId)
      const currentCapFte = currentBottleneckRt ? currentCapacityFte(currentBottleneckRt) : 0
      if (maxForRole != null && currentCapFte >= maxForRole - FLOAT_EPSILON) {
        // Role is at its explicit max — identify the next bottleneck
        const remainingRts = currentRts.filter(rt => rt.id !== bottleneckRtId)
        const nextBottleneck = identifyBottleneckRole(lastSchedule!.weeklyDemandByResourceType, remainingRts)
        if (nextBottleneck == null) {
          // All bottlenecks are at their explicit maxes
          allDiagnostics.push({
            blocker: 'ROLE_MAX_CAP',
            resourceTypeId: bottleneckRtId,
            resourceTypeName: currentRts.find(rt => rt.id === bottleneckRtId)?.name,
            configuredLimit: `${maxForRole}`,
            requested: `>${maxForRole}`,
            achieved: `${maxForRole}`,
            explanation: `${currentRts.find(rt => rt.id === bottleneckRtId)?.name} is capped at ${maxForRole}; target requires more capacity.`,
          })
          break
        }
        currentRts = augmentResourceType(currentRts, nextBottleneck)
      } else {
        currentRts = augmentResourceType(currentRts, bottleneckRtId)
      }

      let newSchedule: SAPlannerResult
      try {
        newSchedule = runSAPlanner({ ...input, resourceTypes: currentRts }, saConfig)
      } catch (error) {
        if (error instanceof SAPlannerInfeasibleError) {
          allDiagnostics.push(...error.diagnostics)
        }
        // Can't grow further — stop growing
        break
      }

      lastSchedule = newSchedule
      const newDelivery = newSchedule.totalDeliveryWeeks

      if (newDelivery < lastDelivery) {
        // Improvement — update best
        bestResult = buildResult(newSchedule, currentRts)
        bestSchedule = newSchedule
        bestRts = [...currentRts]
        lastDelivery = newDelivery
        consecutiveNoImprove = 0
      } else {
        consecutiveNoImprove++
        if (consecutiveNoImprove >= 3) {
          // No improvement for 3 consecutive iterations — stop growing
          break
        }
      }
    }
  }
  totalIterations += iteration

  // ── Phase 3: Capacity reduction (minimise staffed FTE-weeks) ──────────────
  if (bestResult && bestSchedule && bestResult.deliveryWeeks <= targetDurationWeeks) {
    let reducedRts = [...bestRts]
    let reducedSchedule = bestSchedule

    for (const rt of reducedRts) {
      const maxForRole = maxCap?.get(rt.id)
      let currentCount = rt.count
      let reduced = true

      while (reduced && currentCount > CAPACITY_QUANTUM + FLOAT_EPSILON) {
        if (maxForRole != null && currentCount > maxForRole + FLOAT_EPSILON) break

        const { rts: candidateRts, reduced: didReduce } = reduceResourceType(reducedRts, rt.id)
        if (!didReduce) break // no more boosts to remove — stop this role

        let candidateSchedule: SAPlannerResult
        try {
          candidateSchedule = runSAPlanner({ ...input, resourceTypes: candidateRts }, saConfig)
        } catch {
          break // reduction broke feasibility — keep current
        }

        if (candidateSchedule.totalDeliveryWeeks <= targetDurationWeeks + FLOAT_EPSILON) {
          reducedRts = candidateRts
          reducedSchedule = candidateSchedule
          currentCount = candidateRts.find(r => r.id === rt.id)?.count ?? 0
        } else {
          reduced = false
        }
      }
    }

    // Update best if reduction improved it (fewer FTE-weeks)
    const reducedResult = buildResult(reducedSchedule, reducedRts)
    if (reducedResult.totalCost <= bestResult.totalCost) {
      bestResult = reducedResult
      bestSchedule = reducedSchedule
    }
  }

  // ── Phase 4: Ensure best is at least as good as initial one-shot ──────────
  if (bestResult && initialSchedule.totalDeliveryWeeks < bestResult.deliveryWeeks) {
    bestResult = buildResult(initialSchedule, input.resourceTypes)
    bestSchedule = initialSchedule
  }

  // ── Phase 5: Final reconciliation ─────────────────────────────────────────
  // Rerun the planner against the exact returned capacity envelope so that
  // deliveryWeeks, weekly demand, and generated capacity profile all come
  // from the same reconciled capacity-aware scheduling result.
  let reconciliationSucceeded = false

  if (bestSchedule && bestResult && bestResult.periods.length > 0) {
    const reconciledRts = materializeEnvelopeToResourceTypes(
      input.resourceTypes, bestResult.periods, config.periodWeeks,
    )
    try {
      const reconciledSchedule = runSAPlanner({ ...input, resourceTypes: reconciledRts }, saConfig)
      // Validate: the reconciled schedule must complete all features. When it
      // completes, the reconciled schedule is authoritative EVEN IF it is
      // slower than the pre-reconciliation candidate: deliveryWeeks, periods
      // and demand must all describe the schedule the returned capacity can
      // actually reproduce (never keep a better-looking unreconciled result).
      const allComplete = reconciledSchedule.totalDeliveryWeeks < Infinity &&
        reconciledSchedule.weeklyDemandByResourceType.size > 0
      if (allComplete) {
        bestResult = buildResult(reconciledSchedule, reconciledRts)
        bestSchedule = reconciledSchedule
        reconciliationSucceeded = true
      }
    } catch {
      // Reconciliation failed — the pre-reconciliation result cannot be
      // claimed as reconciled. Mark as not achieved so callers know the
      // returned profile has not been validated against the scheduler.
      bestResult = { ...bestResult, deliveryWeeks: Infinity }
    }
    totalIterations++ // count reconciliation as one iteration
  }

  // ── Phase 6: Final diagnostics from the best schedule ─────────────────────
  if (bestSchedule && bestResult) {
    if (bestResult.deliveryWeeks > targetDurationWeeks) {
      const finalDiags = analyzeTargetMiss(bestSchedule, input, saConfig)
      allDiagnostics.push(...finalDiags)
    }
  }

  let finalResult = bestResult
  // Surface the structured blockers on the returned result whenever the
  // final (reconciled) schedule misses the target, so callers see the same
  // diagnostics that explain targetAchieved: false (wire contract #481).
  if (finalResult && finalResult.deliveryWeeks > targetDurationWeeks + FLOAT_EPSILON && !finalResult.diagnostics) {
    finalResult = { ...finalResult, diagnostics: allDiagnostics }
  }
  if (!finalResult) {
    try {
      finalResult = computeCapacityPlan(input, config)
    } catch {
      finalResult = {
        periods: [], totalCost: 0, deliveryWeeks: Infinity, peakHeadcount: 0,
        avgUtilisationPct: 0, budgetExceeded: false,
        levellingResult: { epicStartWeeks: new Map(), featureStartWeeks: new Map(),
          totalDeliveryWeeks: Infinity, peakUtilisationPct: 0 },
        plannedResourceTypeIds: [], diagnostics: allDiagnostics,
      }
    }
  }
  return {
    ...finalResult,
    iterations: totalIterations,
    loopDiagnostics: allDiagnostics,
    targetAchieved: reconciliationSucceeded && finalResult.deliveryWeeks <= targetDurationWeeks + FLOAT_EPSILON,
  }
}
