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

import { effectiveAllocationPct, type SchedulerInput, type SchedulerResourceType } from './scheduler.js'
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

/** Weekly FTE supplied by preserved named resources. */
function namedCapacityFte(rt: SchedulerResourceType, week: number): number {
  let capacity = 0
  for (const resource of rt.namedResources ?? []) {
    if (!resource.capacitySegments || resource.capacitySegments.length === 0) {
      const start = resource.startWeek ?? 0
      const end = resource.endWeek ?? Infinity
      if (week < start || week > end) continue
    }
    capacity += effectiveAllocationPct(resource, week) / 100
  }
  return capacity
}

/** Whether an aggregate role profile permits capacity in this week. */
function isWithinRoleWindow(rt: SchedulerResourceType, week: number): boolean {
  return rt.roleSegments == null
    || rt.roleSegments.some(segment => week >= segment.startWeek && week <= segment.endWeek)
}

/**
 * Mirror materializeEnvelopeToResourceTypes: profile windows constrain where
 * synthetic capacity may exist, but the starting count is not an upper bound.
 * With no profile, an existing unnamed slot or explicit envelope growth
 * permits unrestricted synthetic capacity; named-only capacity remains tied
 * to the named person's active window.
 */
function canMaterializeSyntheticCapacity(
  rt: SchedulerResourceType,
  envelopeHeadcount: number,
): boolean {
  if (rt.roleSegments != null) return rt.roleSegments.length > 0
  const baseUnnamedSlots = Math.max(0, rt.count - (rt.namedResources ?? []).length)
  return baseUnnamedSlots > FLOAT_EPSILON || envelopeHeadcount > rt.count + FLOAT_EPSILON
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
  resourceTypes: SchedulerResourceType[],
  totalWeeks: number,
  periodWeeks: number,
  peakFTE: Map<string, number[]>,
  avgFTE: Map<string, number[]>,
  config: CapacityPlanConfig,
  envelopeBuffer = 1.1,
): Map<string, number[]> {
  const { maxDeltaPerPeriod, smoothingMode = 'smooth', minFloor, maxCap, maxAllocationBufferPct } = config
  const numPeriods = Math.max(1, Math.ceil(totalWeeks / periodWeeks))
  const plannedRtIds = [...peakFTE.keys()]
  const namedFloorFor = (rt: SchedulerResourceType, period: number): number => {
    const startWeek = period * periodWeeks
    const endWeek = Math.min((period + 1) * periodWeeks, totalWeeks + 1)
    let floor = 0
    for (let week = startWeek; week < endWeek; week++) {
      floor = Math.max(floor, namedCapacityFte(rt, week))
    }
    return round2(floor)
  }

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

  // Protected named allocations are part of the truthful envelope even when
  // demand is lower than the locked person's capacity.
  for (const rtId of plannedRtIds) {
    const rt = resourceTypes.find(candidate => candidate.id === rtId)
    if (!rt) continue
    const cap = capacity.get(rtId)!
    for (let p = 0; p < numPeriods; p++) {
      cap[p] = Math.max(cap[p], namedFloorFor(rt, p))
    }
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
      const rt = resourceTypes.find(candidate => candidate.id === rtId)
      for (let p = 0; p < numPeriods; p++) {
        const minFloorCapacity = quantizeHeadcountUp(floor)
        const namedFloor = rt ? namedFloorFor(rt, p) : 0
        const lowerBound = Math.max(minFloorCapacity, namedFloor)
        if (cap[p] < lowerBound) { cap[p] = lowerBound; changed = true }
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
    const rt = resourceTypes.find(candidate => candidate.id === rtId)
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
      const peaks = peakFTE.get(rtId)!
      const namedFloor = rt ? namedFloorFor(rt, p) : 0
      const minRequired = Math.max(floor, namedFloor, quantizeHeadcountUp(peaks[p]))
      while (cap[p] > minRequired + FLOAT_EPSILON && currentAllocated > maxAllocatedDays) {
        cap[p] = round2(Math.max(minRequired, cap[p] - HEADCOUNT_QUANTUM))
        currentAllocated = getAllocatedDays()
      }
    }
  }
  // Max-cap and allocation-buffer trimming must not erase protected named
  // capacity. A locked person remains represented even when demand is small.
  for (const rtId of plannedRtIds) {
    const rt = resourceTypes.find(candidate => candidate.id === rtId)
    if (!rt) continue
    const cap = capacity.get(rtId)!
    for (let p = 0; p < numPeriods; p++) {
      cap[p] = Math.max(cap[p], namedFloorFor(rt, p))
    }
  }


  return capacity
}

/**
 * Build period-level output from a capacity envelope and demand data.
 * Pure function: no I/O, no side effects.
 */
function buildEnvelopeOutput(
  resourceTypes: SchedulerResourceType[],
  totalWeeks: number,
  periodWeeks: number,
  capacity: Map<string, number[]>,
  avgFTE: Map<string, number[]>,
  levelResult: LevellingResult,
  config: CapacityPlanConfig,
  weeklyDemandByResourceType?: Map<string, number[]>,
): CapacityPlanResult {
  const { dayRates, maxBudget } = config
  const plannedRtIds = [...capacity.keys()]
  const rtById = new Map(resourceTypes.map(rt => [rt.id, rt]))
  const weeklyCapacity = new Map<string, number[]>()
  // Preserve named-resource allocations beyond demand's horizon when they
  // are explicitly represented/protected. Role-profile availability alone is
  // not staffing and must not extend the priced envelope.
  let horizonEnd = totalWeeks + 1
  for (const rtId of plannedRtIds) {
    const rt = rtById.get(rtId)
    if (!rt) continue
    for (const resource of rt.namedResources ?? []) {
      for (const segment of resource.capacitySegments ?? []) {
        if (Number.isFinite(segment.endWeek)) horizonEnd = Math.max(horizonEnd, segment.endWeek + 1)
      }
      if (resource.endWeek != null) horizonEnd = Math.max(horizonEnd, resource.endWeek + 1)
    }
  }
  const outputPeriods = Math.max(1, Math.ceil(horizonEnd / periodWeeks))

  for (const rtId of plannedRtIds) {
    const rt = rtById.get(rtId)!
    const values = new Array<number>(horizonEnd).fill(0)
    const envelope = capacity.get(rtId)!
    for (let week = 0; week < horizonEnd; week++) {
      const coarsePeriod = Math.floor(week / periodWeeks)
      const envelopeHeadcount = envelope[coarsePeriod] ?? 0
      const inRoleWindow = isWithinRoleWindow(rt, week)
      const protectedFte = namedCapacityFte(rt, week)
      const canMaterializeSynthetic = canMaterializeSyntheticCapacity(rt, envelopeHeadcount)
      values[week] = !inRoleWindow || (!canMaterializeSynthetic && protectedFte <= FLOAT_EPSILON)
        ? protectedFte
        : Math.max(envelopeHeadcount, protectedFte)
    }
    weeklyCapacity.set(rtId, values)
  }

  const ranges: Array<{ startWeek: number; endWeek: number; coarsePeriod: number }> = []
  for (let coarse = 0; coarse < outputPeriods; coarse++) {
    const start = coarse * periodWeeks
    const end = Math.min((coarse + 1) * periodWeeks, horizonEnd)
    let runStart = start
    for (let week = start + 1; week < end; week++) {
      const changed = plannedRtIds.some(rtId =>
        Math.abs(weeklyCapacity.get(rtId)![week] - weeklyCapacity.get(rtId)![week - 1]) > FLOAT_EPSILON ||
        Math.abs(namedCapacityFte(rtById.get(rtId)!, week) - namedCapacityFte(rtById.get(rtId)!, week - 1)) > FLOAT_EPSILON)
      if (!changed) continue
      ranges.push({ startWeek: runStart, endWeek: week, coarsePeriod: coarse })
      runStart = week
    }
    if (end > runStart) ranges.push({ startWeek: runStart, endWeek: end, coarsePeriod: coarse })
  }
  if (ranges.length === 0) ranges.push({ startWeek: 0, endWeek: horizonEnd, coarsePeriod: 0 })

  const periods: CapacityPlanPeriodResult[] = []
  let totalCost = 0
  let peakHeadcount = 0
  let totalUtilWeighted = 0
  let totalUtilWeight = 0

  for (const range of ranges) {
    let periodHeadcount = 0
    const resources: CapacityPlanPeriodResult['resources'] = []
    for (const rtId of plannedRtIds) {
      const rt = rtById.get(rtId)!
      const headcount = weeklyCapacity.get(rtId)![range.startWeek] ?? 0
      const weeklyDemand = weeklyDemandByResourceType?.get(rtId) ?? []
      let peak = 0
      let totalFte = 0
      for (let week = range.startWeek; week < range.endWeek; week++) {
        const fte = weeklyDemandByResourceType
          ? (weeklyDemand[week] ?? 0) / 5
          : (avgFTE.get(rtId)?.[range.coarsePeriod] ?? 0)
        peak = Math.max(peak, fte)
        totalFte += fte
      }
      const width = range.endWeek - range.startWeek
      const avg = width > 0 ? totalFte / width : 0
      const util = headcount > 0 ? (avg / headcount) * 100 : 0
      const dayRate = dayRates.get(rtId) ?? 0
      const costForPeriod = headcount * dayRate * width * 5
      resources.push({
        resourceTypeId: rtId, resourceTypeName: rt.name,
        headcount: round2(headcount), peakDemandFTE: Math.round(peak * 100) / 100,
        avgDemandFTE: Math.round(avg * 100) / 100, utilisationPct: Math.round(util * 10) / 10,
        costForPeriod: Math.round(costForPeriod),
      })
      totalCost += costForPeriod
      periodHeadcount += headcount
      totalUtilWeighted += util * headcount
      totalUtilWeight += headcount
    }
    if (periodHeadcount > peakHeadcount) peakHeadcount = periodHeadcount
    const periodIndex = periods.length
    const periodLabel = periodWeeks === 4 && range.endWeek - range.startWeek === 4
      ? `Month ${range.coarsePeriod + 1}`
      : periodWeeks === 13 && range.endWeek - range.startWeek === 13
        ? `Q${range.coarsePeriod + 1}`
        : `W${range.startWeek}-${range.endWeek}`
    periods.push({ periodIndex, periodLabel, startWeek: range.startWeek, endWeek: range.endWeek, resources })
  }

  const avgUtilisationPct = totalUtilWeight > 0
    ? Math.round((totalUtilWeighted / totalUtilWeight) * 10) / 10
    : 0
  return {
    periods, totalCost: Math.round(totalCost), deliveryWeeks: levelResult.totalDeliveryWeeks,
    peakHeadcount, avgUtilisationPct,
    budgetExceeded: maxBudget != null ? totalCost > maxBudget : false,
    levellingResult: levelResult, plannedResourceTypeIds: plannedRtIds,
  }
}

// ─── Resource type augmentation helpers (#481) ───────────────────────────────

/** Maximum iterations for the joint planning loop. Derived from the bounded
 * search space: each iteration adds one quantum to one role. The bound is
 * proportional to total possible increments across all roles. */
function computeMaxIterations(resourceTypes: SchedulerResourceType[], maxCap?: Map<string, number>): number {
  let totalSlots = 0
  for (const rt of resourceTypes) {
    const cap = maxCap?.get(rt.id) ?? 100
    totalSlots += Math.ceil(Math.max(0, cap) / CAPACITY_QUANTUM)
  }
  // Keep a finite safety bound even for unrestricted roles. The loop has a
  // tighter useful-capacity stop, but this protects malformed inputs.
  return Math.min(Math.max(totalSlots + 10, 32), 200)
}

/** Effective capacity in FTE for a role, optionally at one scheduler week. */
function currentCapacityFte(rt: SchedulerResourceType, week?: number): number {

  if (week != null) {
    if (rt.roleSegments !== undefined) {
      const segmentCapacity = rt.roleSegments
        .find(segment => week >= segment.startWeek && week <= segment.endWeek)
        ?.allocationPercent
      return (segmentCapacity ?? 0) / 100 + namedCapacityFte(rt, week)
    }
    const phantomCapacity = Math.max(0, rt.count - (rt.namedResources ?? []).length)
    return phantomCapacity + namedCapacityFte(rt, week)
  }

  if (rt.roleSegments !== undefined) {
    let maximum = 0
    const weeks = new Set<number>()
    for (const segment of rt.roleSegments) {
      if (Number.isFinite(segment.startWeek)) weeks.add(segment.startWeek)
      if (Number.isFinite(segment.endWeek)) weeks.add(segment.endWeek)
    }
    for (const resource of rt.namedResources ?? []) {
      if (resource.startWeek != null) weeks.add(resource.startWeek)
      if (resource.endWeek != null) weeks.add(resource.endWeek)
      if (resource.allocationStartWeek != null) weeks.add(resource.allocationStartWeek)
      if (resource.allocationEndWeek != null) weeks.add(resource.allocationEndWeek)
      for (const segment of resource.capacitySegments ?? []) {
        weeks.add(segment.startWeek)
        weeks.add(segment.endWeek)
      }
    }
    if (weeks.size === 0 && (rt.namedResources ?? []).length > 0) weeks.add(0)
    for (const weekValue of weeks) maximum = Math.max(maximum, currentCapacityFte(rt, weekValue))
    return maximum
  }
  return rt.count
}

/** Identify the role with the tightest weekly capacity-to-demand ratio. */
function identifyBottleneckRole(
  weeklyDemandByRt: Map<string, number[]>,
  currentRts: SchedulerResourceType[],
): string | null {
  let bestRt: string | null = null
  let bestScore = -Infinity

  for (const rt of currentRts) {
    const demand = weeklyDemandByRt.get(rt.id) ?? []
    let totalDemand = 0
    let roleScore = 0
    for (let week = 0; week < demand.length; week++) {
      const days = demand[week] ?? 0
      if (days <= EPSILON) continue
      totalDemand += days
      const capacityDays = currentCapacityFte(rt, week) * 5
      roleScore = Math.max(roleScore, days / Math.max(capacityDays, EPSILON))
    }
    if (totalDemand <= EPSILON || roleScore < 0) continue
    const score = roleScore + totalDemand * 1e-10
    if (score > bestScore) {
      bestScore = score
      bestRt = rt.id
    }
  }
  return bestRt
}

interface CapacityGrowthOptions {
  /** Restrict profile growth to the segment containing this week. */
  week?: number
  /** Clamp effective aggregate capacity to this FTE maximum. */
  maxFte?: number
}

/** Create a copy of resource types with capacity increased by one quantum.
 * Two-argument callers retain the historical all-segment behaviour. */
export function augmentResourceType(
  resourceTypes: SchedulerResourceType[],
  rtId: string,
  options?: CapacityGrowthOptions,
): SchedulerResourceType[] {
  return resourceTypes.map(rt => {
    if (rt.id !== rtId) return rt
    if (!rt.roleSegments || rt.roleSegments.length === 0) {
      const namedCount = (rt.namedResources ?? []).length
      const namedFte = options?.week == null ? 0 : namedCapacityFte(rt, options.week)
      const maxCount = options?.maxFte == null
        ? Infinity
        : namedCount + Math.max(0, options.maxFte - namedFte)
      if (rt.count >= maxCount - FLOAT_EPSILON) return rt
      return { ...rt, count: round2(Math.min(maxCount, rt.count + CAPACITY_QUANTUM)) }
    }

    const targetWeek = options?.week
    let updated = false
    return {
      ...rt,
      roleSegments: rt.roleSegments.map(segment => {
        if (targetWeek != null &&
          (targetWeek < segment.startWeek || targetWeek > segment.endWeek || updated)) return segment
        const namedFte = targetWeek == null
          ? namedCapacityFte(rt, segment.startWeek)
          : namedCapacityFte(rt, targetWeek)
        const maximumPercent = options?.maxFte == null
          ? Infinity
          : Math.max(0, options.maxFte - namedFte) * 100
        if (segment.allocationPercent >= maximumPercent - FLOAT_EPSILON) return segment
        updated = true
        return {
          ...segment,
          allocationPercent: Math.min(
            maximumPercent,
            segment.allocationPercent + CAPACITY_QUANTUM * 100,
          ),
        }
      }),
    }
  })
}


/** Create a copy of resource types with capacity reduced by one quantum. */
export function reduceResourceType(
  resourceTypes: SchedulerResourceType[],
  rtId: string,
): { rts: SchedulerResourceType[]; reduced: boolean } {
  const originalRt = resourceTypes.find(rt => rt.id === rtId)
  if (!originalRt) return { rts: resourceTypes, reduced: false }
  const isSegmentBased = originalRt.roleSegments && originalRt.roleSegments.length > 0
  const newRts = resourceTypes.map(rt => {
    if (rt.id !== rtId) return rt
    if (!isSegmentBased || !rt.roleSegments || rt.roleSegments.length === 0) {
      return { ...rt, count: Math.max(0, round2(rt.count - CAPACITY_QUANTUM)) }
    }
    return {
      ...rt,
      roleSegments: rt.roleSegments.map(segment => ({
        ...segment,
        allocationPercent: Math.max(0, segment.allocationPercent - CAPACITY_QUANTUM * 100),
      })),
    }
  })
  const newRt = newRts.find(rt => rt.id === rtId)
  if (!newRt) return { rts: newRts, reduced: false }
  if (!isSegmentBased) return { rts: newRts, reduced: newRt.count < originalRt.count - FLOAT_EPSILON }
  return {
    rts: newRts,
    reduced: (newRt.roleSegments ?? []).some((segment, index) =>
      segment.allocationPercent < (originalRt.roleSegments?.[index]?.allocationPercent ?? 0) - FLOAT_EPSILON),
  }
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
  type SlotWindow = { startWeek: number; endWeek: number; allocationPercent: number }

  return baseResourceTypes.map(rt => {
    const envelopeByPeriod: Array<{ startWeek: number; endWeek: number; headcount: number }> = []
    for (const period of periods) {
      const resource = period.resources.find(r => r.resourceTypeId === rt.id)
      // An explicit zero is authoritative: materialize it so original count or
      // profile capacity cannot reappear during replay. Only a missing role
      // entry retains the base resource type unchanged.
      if (resource) {
        envelopeByPeriod.push({ startWeek: period.startWeek, endWeek: period.endWeek, headcount: resource.headcount })
      }
    }
    if (envelopeByPeriod.length === 0) return rt

    let maxEnvelopeHeadcount = 0
    for (const ep of envelopeByPeriod) maxEnvelopeHeadcount = Math.max(maxEnvelopeHeadcount, ep.headcount)
    maxEnvelopeHeadcount = round2(maxEnvelopeHeadcount)

    // Role-level profile windows are authoritative for aggregate capacity.
    // Named-person availability is independent: when roleSegments is absent,
    // preserve unrestricted phantom slots while retaining named windows.
    const preservedNamedResources = [...(rt.namedResources ?? [])]
    const addedWindows: SlotWindow[][] = []

    // Materialise only the shortfall over preserved named resources. This is
    // important for locks/availability: replacing a named TIMELINE resource
    // with a CAPACITY_PLAN resource would invent capacity in locked weeks, and
    // retaining it while adding a full envelope slot would double-count it.
    for (const ep of envelopeByPeriod) {
      for (let week = ep.startWeek; week < ep.endWeek; week++) {
        if (!isWithinRoleWindow(rt, week)) continue

        let preservedFte = 0
        for (const nr of preservedNamedResources) {
          // capacitySegments are authoritative; otherwise mirror the
          // scheduler's physical start/end guard before legacy allocation.
          if (!nr.capacitySegments || nr.capacitySegments.length === 0) {
            const start = nr.startWeek ?? 0
            const end = nr.endWeek ?? Infinity
            if (week < start || week > end) continue
          }
          preservedFte += effectiveAllocationPct(nr, week) / 100
        }

        // With no role profile, count slots beyond named resources are
        // unrestricted. A named-only role remains tied to its people unless
        // the envelope explicitly grows beyond the original count.
        const canMaterializeSynthetic = canMaterializeSyntheticCapacity(rt, ep.headcount)
        if (!canMaterializeSynthetic && preservedFte <= FLOAT_EPSILON) continue

        const remaining = Math.max(0, ep.headcount - preservedFte)
        const fullSlots = Math.floor(remaining + FLOAT_EPSILON)
        const fractional = remaining - fullSlots
        const slotCount = fullSlots + (fractional > FLOAT_EPSILON ? 1 : 0)
        for (let slot = 0; slot < slotCount; slot++) {
          const allocationPercent = slot < fullSlots ? 100 : Math.round(fractional * 100)
          if (allocationPercent <= 0) continue
          if (!addedWindows[slot]) addedWindows[slot] = []
          const slotRanges = addedWindows[slot]
          const last = slotRanges[slotRanges.length - 1]
          if (last && last.endWeek + 1 === week && last.allocationPercent === allocationPercent) {
            last.endWeek = week
          } else {
            slotRanges.push({ startWeek: week, endWeek: week, allocationPercent })
          }
        }
      }
    }

    const addedNamedResources = addedWindows.flatMap((ranges, slot) => ranges.map((range, index) => ({
      id: `reconcile-${rt.id}-${slot}-${index}`,
      name: `${rt.name} reconcile-${slot}-${index}`,
      startWeek: range.startWeek,
      endWeek: range.endWeek,
      allocationPct: range.allocationPercent,
      allocationMode: 'CAPACITY_PLAN',
      allocationPercent: range.allocationPercent,
      allocationStartWeek: null,
      allocationEndWeek: null,
    })))

    return {
      ...rt,
      // Named resources (preserved plus added shortfall slots) are the sole
      // replay authority. Clearing roleSegments prevents aggregate profile
      // capacity from being counted on top of them.
      count: maxEnvelopeHeadcount,
      roleSegments: rt.roleSegments && rt.roleSegments.length === 0 ? [] : undefined,
      namedResources: [...preservedNamedResources, ...addedNamedResources],
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
    ...buildEnvelopeOutput(resourceTypes, totalWeeks, periodWeeks, capacity, avgFTE, levelResult, config,
      saResult.weeklyDemandByResourceType),
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
  // A protected named allocation above an explicit role cap cannot be
  // represented truthfully: lowering the envelope would erase the named
  // person, while retaining it would violate the configured maximum. Reject
  // only demanded roles, since undemanded resource types are not part of
  // this plan.
  if (maxCap) {
    for (const rt of input.resourceTypes) {
      const cap = maxCap.get(rt.id)
      if (cap == null) continue
      const hasDemand = input.epics.some(epic => epic.isActive !== false &&
        epic.features.some(feature => feature.isActive !== false &&
          feature.userStories.some(story => story.isActive !== false &&
            story.tasks.some(task => task.resourceTypeId === rt.id && task.hoursEffort > EPSILON))))
      if (!hasDemand) continue

      const weeks = new Set<number>([0])
      const addBoundary = (value: number | null | undefined) => {
        if (!Number.isFinite(value)) return
        weeks.add(value!)
        weeks.add(value! + 1)
      }
      for (const resource of rt.namedResources ?? []) {
        addBoundary(resource.startWeek)
        addBoundary(resource.endWeek)
        addBoundary(resource.allocationStartWeek)
        addBoundary(resource.allocationEndWeek)
        for (const segment of resource.capacitySegments ?? []) {
          addBoundary(segment.startWeek)
          addBoundary(segment.endWeek)
        }
      }
      const conflictWeek = [...weeks].sort((a, b) => a - b).find(week =>
        namedCapacityFte(rt, week) > cap + FLOAT_EPSILON)
      if (conflictWeek == null) continue
      const protectedFte = namedCapacityFte(rt, conflictWeek)
      const diagnostic: PlannerDiagnostic = {
        blocker: 'ROLE_MAX_CAP',
        resourceTypeId: rt.id,
        resourceTypeName: rt.name,
        configuredLimit: `${cap}`,
        requested: `${protectedFte} FTE required in week ${conflictWeek}`,
        achieved: `${cap} FTE maximum`,
        explanation: `${rt.name} has ${protectedFte} FTE of protected named capacity in week ${conflictWeek}, above the configured ${cap} FTE maximum.`,
      }
      return {
        periods: [],
        totalCost: 0,
        deliveryWeeks: Infinity,
        peakHeadcount: 0,
        avgUtilisationPct: 0,
        budgetExceeded: false,
        levellingResult: {
          epicStartWeeks: new Map(),
          featureStartWeeks: new Map(),
          totalDeliveryWeeks: Infinity,
          peakUtilisationPct: 0,
        },
        plannedResourceTypeIds: [],
        diagnostics: [diagnostic],
        iterations: 0,
        loopDiagnostics: [diagnostic],
        targetAchieved: false,
      }
    }
  }

  let iteration = 0

  // ── Phase 1: Initial run ──────────────────────────────────────────────────
  let initialSchedule: SAPlannerResult | undefined
  let initialFailure: SAPlannerInfeasibleError | undefined
  try {
    initialSchedule = runSAPlanner({ ...input, resourceTypes: currentRts }, saConfig)
  } catch (error) {
    if (!(error instanceof SAPlannerInfeasibleError)) throw error
    initialFailure = error
    allDiagnostics.push(...error.diagnostics)
  }

  // A failed run is recoverable when a role still has useful capacity in its
  // own available window. Each recovery candidate is raised to a finite,
  // evidence-based throughput bound before the expensive planner is rerun.
  const maxUsefulParallelism = saConfig.maxParallelismPerFeature ?? 2
  function usefulCapacityFor(rtId: string): { capacity: number; activeFeatures: number } | undefined {
    let activeFeatures = 0
    for (const epic of input.epics) {
      for (const feature of epic.features) {
        if (feature.isActive === false) continue
        let featureHasDemand = false
        for (const story of feature.userStories) {
          if (story.isActive === false) continue
          for (const task of story.tasks) {
            if (task.resourceTypeId !== rtId) continue
            const hoursPerDay = task.resourceType?.hoursPerDay ?? input.project.hoursPerDay
            if (hoursPerDay <= 0) continue
            featureHasDemand = true
          }
        }
        if (featureHasDemand) activeFeatures++
      }
    }
    if (activeFeatures === 0) return undefined
    const configuredMax = maxCap?.get(rtId)
    // Each active feature may consume up to the configured parallelism
    // allowance at once. This is a finite safe upper bound: hard windows can
    // squeeze all of that work into the target, so do not use target-average
    // effort as a smaller hidden cap.
    const usefulCapacity = activeFeatures * maxUsefulParallelism
    return {
      capacity: configuredMax == null ? usefulCapacity : Math.min(configuredMax, usefulCapacity),
      activeFeatures,
    }
  }

  function chooseGrowthWeeks(rt: SchedulerResourceType, demand: number[]): number[] {
    const scoredWeeks: Array<{ week: number; score: number }> = []
    for (let week = 0; week < demand.length; week++) {
      const days = demand[week] ?? 0
      if (days > EPSILON) {
        scoredWeeks.push({
          week,
          score: days / Math.max(currentCapacityFte(rt, week) * 5, EPSILON),
        })
      }
    }
    if (scoredWeeks.length === 0 && rt.roleSegments && rt.roleSegments.length > 0) {
      for (const segment of rt.roleSegments) {
        scoredWeeks.push({ week: segment.startWeek, score: 0 })
      }
    }
    if (scoredWeeks.length === 0) {
      for (const resource of rt.namedResources ?? []) {
        scoredWeeks.push({ week: resource.startWeek ?? 0, score: 0 })
      }
    }
    if (scoredWeeks.length === 0) scoredWeeks.push({ week: 0, score: 0 })
    scoredWeeks.sort((a, b) => b.score - a.score || a.week - b.week)
    return [...new Set(scoredWeeks.map(candidate => candidate.week))]
  }

  function canGrowAt(rt: SchedulerResourceType, week: number, useful?: { capacity: number }): boolean {
    // A role profile cannot be augmented at a week outside every configured
    // segment. Rejecting that candidate here avoids no-op probes and repeated
    // planner runs for a permanently unavailable profile window.
    if (rt.roleSegments !== undefined &&
      !rt.roleSegments.some(segment => week >= segment.startWeek && week <= segment.endWeek)) {
      return false
    }
    const capacity = currentCapacityFte(rt, week)
    if (useful && capacity >= useful.capacity - FLOAT_EPSILON) return false
    const configuredMax = maxCap?.get(rt.id)
    return configuredMax == null || capacity < configuredMax - FLOAT_EPSILON
  }


  let recoveryAttempts = 0
  const recoveryProbes = new Set<string>()
  while (!initialSchedule && initialFailure && recoveryAttempts < maxIterations) {
    const diagnosticRoleIds = initialFailure.diagnostics
      .map(diagnostic => diagnostic.resourceTypeId)
      .filter((id): id is string => id != null)
    const demandedRoleIds = currentRts
      .filter(rt => usefulCapacityFor(rt.id) != null)
      .map(rt => rt.id)
    const orderedRoleIds = [...new Set([...diagnosticRoleIds, ...demandedRoleIds])]
    let growth: { rt: SchedulerResourceType; week: number } | undefined
    const blockedCaps = new Map<string, number>()

    for (const roleId of orderedRoleIds) {
      const rt = currentRts.find(candidate => candidate.id === roleId)
      if (!rt) continue
      const useful = usefulCapacityFor(roleId)
      for (const week of chooseGrowthWeeks(rt, [])) {
        if (!canGrowAt(rt, week, useful)) {
          const configuredMax = maxCap?.get(rt.id)
          if (configuredMax != null) blockedCaps.set(rt.id, configuredMax)
          continue
        }
        const probeKey = `${roleId}:${week}:${currentCapacityFte(rt, week).toFixed(6)}`
        if (!recoveryProbes.has(probeKey)) {
          growth = { rt, week }
          break
        }
      }
      if (growth) break
    }

    if (!growth) {
      for (const [roleId, configuredMax] of blockedCaps) {
        const rt = currentRts.find(candidate => candidate.id === roleId)
        if (!rt) continue
        allDiagnostics.push({
          blocker: 'ROLE_MAX_CAP',
          resourceTypeId: rt.id,
          resourceTypeName: rt.name,
          configuredLimit: `${configuredMax}`,
          requested: `>${configuredMax}`,
          achieved: `${configuredMax}`,
          explanation: `${rt.name} is capped at ${configuredMax}; the target requires more capacity.`,
        })
      }
      break
    }

    const { rt, week } = growth
    const currentCapacity = currentCapacityFte(rt, week)
    recoveryProbes.add(`${rt.id}:${week}:${currentCapacity.toFixed(6)}`)

    // Recovery probes are evidence-gathering runs, not a reason to invoke SA
    // once per quarter-FTE. Raise this role to the finite useful-throughput
    // bound in one candidate, then run the expensive planner once.
    const usefulTarget = usefulCapacityFor(rt.id)?.capacity
    let nextCapacity = currentCapacity
    let nextRts = currentRts
    do {
      const augmented = augmentResourceType(nextRts, rt.id, {
        week,
        maxFte: maxCap?.get(rt.id),
      })
      const candidate = augmented.find(candidateRt => candidateRt.id === rt.id)
      const candidateCapacity = candidate ? currentCapacityFte(candidate, week) : nextCapacity
      if (!candidate || candidateCapacity <= nextCapacity + FLOAT_EPSILON) break
      nextRts = augmented
      nextCapacity = candidateCapacity
    } while (usefulTarget != null && nextCapacity < usefulTarget - FLOAT_EPSILON)

    if (nextCapacity <= currentCapacity + FLOAT_EPSILON) continue
    currentRts = nextRts
    recoveryAttempts++

    try {
      initialSchedule = runSAPlanner({ ...input, resourceTypes: currentRts }, saConfig)
    } catch (error) {
      if (!(error instanceof SAPlannerInfeasibleError)) throw error
      // Replace the active failure with the latest evidence, while retaining
      // the diagnostic history for the operator-facing loop diagnostics.
      initialFailure = error
      allDiagnostics.push(...error.diagnostics)
    }
  }
  totalIterations += recoveryAttempts

  if (!initialSchedule) {
    return {
      periods: [], totalCost: 0, deliveryWeeks: Infinity, peakHeadcount: 0,
      avgUtilisationPct: 0, budgetExceeded: false,
      levellingResult: { epicStartWeeks: new Map(), featureStartWeeks: new Map(),
        totalDeliveryWeeks: Infinity, peakUtilisationPct: 0 },
      plannedResourceTypeIds: [],
      diagnostics: allDiagnostics,
      iterations: Math.max(1, totalIterations),
      loopDiagnostics: allDiagnostics,
      targetAchieved: false,
    }
  }
  // Use the successful post-recovery schedule and its actual resource
  // representation as the starting-state evidence. Failed-run diagnostics
  // describe infeasibility, but must not be guessed into the blocked-growth
  // set once recovery has produced a schedule.
  const initialDiags = initialSchedule.totalDeliveryWeeks > targetDurationWeeks
    ? analyzeTargetMiss(initialSchedule, { ...input, resourceTypes: currentRts }, saConfig)
    : []


  const initialDelivery = initialSchedule.totalDeliveryWeeks
  let bestResult = buildResult(initialSchedule, currentRts)
  let bestSchedule: SAPlannerResult = initialSchedule
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
  function buildResult(sched: SAPlannerResult, rts: SchedulerResourceType[], minimizeBuffer = false): CapacityPlanResult {
    const { totalWeeks, peakFTE, avgFTE } = deriveDemandMetrics(sched, rts)
    const capacity = deriveCapacityEnvelope(
      rts, totalWeeks, periodWeeks, peakFTE, avgFTE, config, minimizeBuffer ? 1 : 1.1,
    )
    const levelResult: LevellingResult = {
      epicStartWeeks: sched.epicStartWeeks,
      featureStartWeeks: sched.featureStartWeeks,
      totalDeliveryWeeks: sched.totalDeliveryWeeks,
      peakUtilisationPct: sched.peakUtilisationPct,
    }
    return buildEnvelopeOutput(rts, totalWeeks, periodWeeks, capacity, avgFTE, levelResult, config,
      sched.weeklyDemandByResourceType)
  }

  // Keep the already-materialized envelope as the returned capacity. Refresh
  // demand, cost, and levelling observations from the replayed schedule;
  // calling buildResult here would derive a different, unvalidated envelope.
  function adoptValidatedSchedule(
    result: CapacityPlanResult,
    sched: SAPlannerResult,
    _rts: SchedulerResourceType[],
  ): CapacityPlanResult {
    // Replay demand must be aggregated over the committed output windows. The
    // replay may finish earlier than those windows, but its missing weeks are
    // still zero-demand weeks in the returned plan's utilisation denominator.
    const periods = result.periods.map(period => {
      const periodWeeks = period.endWeek - period.startWeek
      return {
        ...period,
        resources: period.resources.map(resource => {
          const weeklyDemand = sched.weeklyDemandByResourceType.get(resource.resourceTypeId) ?? []
          let peak = 0
          let totalFte = 0
          for (let week = period.startWeek; week < period.endWeek; week++) {
            const fte = (weeklyDemand[week] ?? 0) / 5
            if (fte > peak) peak = fte
            totalFte += fte
          }
          const avg = periodWeeks > 0 ? totalFte / periodWeeks : 0
          const dayRate = config.dayRates.get(resource.resourceTypeId) ?? 0
          const costForPeriod = resource.headcount * dayRate * periodWeeks * 5
          return {
            ...resource,
            peakDemandFTE: Math.round(peak * 100) / 100,
            avgDemandFTE: Math.round(avg * 100) / 100,
            utilisationPct: resource.headcount > 0 ? Math.round((avg / resource.headcount) * 1000) / 10 : 0,
            costForPeriod: Math.round(costForPeriod),
          }
        }),
      }
    })
    let totalCost = 0
    let peakHeadcount = 0
    let totalUtilWeighted = 0
    let totalUtilWeight = 0
    for (const period of periods) {
      let periodHeadcount = 0
      for (const resource of period.resources) {
        totalCost += resource.costForPeriod
        periodHeadcount += resource.headcount
        totalUtilWeighted += resource.utilisationPct * resource.headcount
        totalUtilWeight += resource.headcount
      }
      if (periodHeadcount > peakHeadcount) peakHeadcount = periodHeadcount
    }
    return {
      ...result,
      periods,
      totalCost: Math.round(totalCost),
      peakHeadcount,
      avgUtilisationPct: totalUtilWeight > 0
        ? Math.round((totalUtilWeighted / totalUtilWeight) * 10) / 10
        : 0,
      budgetExceeded: config.maxBudget != null && totalCost > config.maxBudget,
      deliveryWeeks: sched.totalDeliveryWeeks,
      levellingResult: {
        epicStartWeeks: sched.epicStartWeeks,
        featureStartWeeks: sched.featureStartWeeks,
        totalDeliveryWeeks: sched.totalDeliveryWeeks,
        peakUtilisationPct: sched.peakUtilisationPct,
      },
    }
  }

  if (initialDelivery <= targetDurationWeeks) {
    // Target met on first run — skip to capacity reduction
  } else {
    // These diagnostics prove that more capacity for the affected role cannot
    // change the observed schedule (for example demand beyond a closed
    // profile window). Do not spend later SA runs re-proving that blocker.
    const blockedGrowthRoles = new Set(
      initialDiags
        .filter(diagnostic =>
          diagnostic.resourceTypeId != null &&
          (diagnostic.blocker === 'PROFILE_WINDOW' ||
            diagnostic.blocker === 'SCHEDULE_LOCK' ||
            diagnostic.blocker === 'FEATURE_PARALLELISM'))
        .map(diagnostic => diagnostic.resourceTypeId as string),
    )

    // ── Phase 2: Iterative capacity growth ──────────────────────────────────
    let lastDelivery = initialDelivery
    const growthProbes = new Set<string>()
    while (iteration < maxIterations && lastDelivery > targetDurationWeeks) {
      iteration++
      const demand = lastSchedule.weeklyDemandByResourceType
      const primaryRoleId = identifyBottleneckRole(demand, currentRts)
      if (primaryRoleId == null) break

      const orderedRoles = [
        primaryRoleId,
        ...currentRts
          .filter(rt => rt.id !== primaryRoleId)
          .map(rt => rt.id),
      ]
      let growthRole: SchedulerResourceType | undefined
      let growthWeek = 0
      let growthMax: number | undefined
      for (const roleId of orderedRoles) {
        const rt = currentRts.find(candidate => candidate.id === roleId)
        if (!rt || blockedGrowthRoles.has(roleId)) continue
        const useful = usefulCapacityFor(roleId)
        for (const week of chooseGrowthWeeks(rt, demand.get(roleId) ?? [])) {
          if (!canGrowAt(rt, week, useful)) continue
          const probeKey = `${roleId}:${week}:${currentCapacityFte(rt, week).toFixed(6)}`
          if (growthProbes.has(probeKey)) continue
          growthRole = rt
          growthWeek = week
          growthMax = maxCap?.get(roleId)
          growthProbes.add(probeKey)
          break
        }
        if (growthRole) break
      }

      if (!growthRole) {
        // Only report a hard cap when every demanded week for that role is
        // already at the configured limit. A historical peak in an earlier
        // segment must not cap a later under-capacity segment.
        for (const rt of currentRts) {
          const cap = maxCap?.get(rt.id)
          const roleDemand = demand.get(rt.id) ?? []
          if (cap == null || !roleDemand.some(days => days > EPSILON)) continue
          const allDemandWeeksCapped = roleDemand.every((days, week) =>
            days <= EPSILON || currentCapacityFte(rt, week) >= cap - FLOAT_EPSILON)
          if (!allDemandWeeksCapped ||
            allDiagnostics.some(diagnostic =>
              diagnostic.blocker === 'ROLE_MAX_CAP' && diagnostic.resourceTypeId === rt.id)) continue
          const totalDemand = roleDemand.reduce((sum, days) => sum + Math.max(0, days ?? 0), 0)
          const requiredDays = targetDurationWeeks * cap * 5
          if (totalDemand <= requiredDays + FLOAT_EPSILON) continue
          allDiagnostics.push({
            blocker: 'ROLE_MAX_CAP',
            resourceTypeId: rt.id,
            resourceTypeName: rt.name,
            configuredLimit: `${cap}`,
            requested: `>${cap} FTE needed for ${Math.round(totalDemand)} days in ${targetDurationWeeks} weeks`,
            achieved: `${cap} FTE (${Math.round(cap * 5)} days/week)`,
            explanation: `${rt.name} is capped at ${cap}; target requires more capacity.`,
          })
        }
        break
      }

      const nextRts = augmentResourceType(currentRts, growthRole.id, {
        week: growthWeek,
        maxFte: growthMax,
      })
      const nextRole = nextRts.find(rt => rt.id === growthRole!.id)!
      if (currentCapacityFte(nextRole, growthWeek) <=
        currentCapacityFte(growthRole, growthWeek) + FLOAT_EPSILON) continue
      currentRts = nextRts

      try {
        const newSchedule = runSAPlanner({ ...input, resourceTypes: currentRts }, saConfig)
        lastSchedule = newSchedule
        const newDelivery = newSchedule.totalDeliveryWeeks
        if (newDelivery < lastDelivery) {
          bestResult = buildResult(newSchedule, currentRts)
          bestSchedule = newSchedule
          lastDelivery = newDelivery
        }
      } catch (error) {
        if (!(error instanceof SAPlannerInfeasibleError)) throw error
        // Preserve failed-probe evidence, but stop revisiting a role when
        // diagnostics prove its remaining blocker is not capacity growth.
        allDiagnostics.push(...error.diagnostics)
        for (const diagnostic of error.diagnostics) {
          if (diagnostic.resourceTypeId == null) continue
          if (diagnostic.blocker === 'PROFILE_WINDOW' ||
            diagnostic.blocker === 'SCHEDULE_LOCK' ||
            diagnostic.blocker === 'FEATURE_PARALLELISM') {
            blockedGrowthRoles.add(diagnostic.resourceTypeId)
          }
        }
      }
    }
  }
  totalIterations += iteration

  // ── Phase 3: Capacity reduction (minimise staffed FTE-weeks) ──────────────
  if (bestResult && bestSchedule && bestResult.deliveryWeeks <= targetDurationWeeks) {
    // Reduce the returned envelope directly. Reducing a role's aggregate
    // capacity changes every period at once and can hide an independently
    // removable quantum in another period after replay.
    let currentResult = bestResult
    let currentSchedule = bestSchedule
    let reductionCommitted = false

    // Named resources are preserved by materializeEnvelopeToResourceTypes;
    // never lower an envelope period beneath their greatest locked weekly
    // capacity. The configured floor is a separate hard lower bound.
    const namedFloors = new Map<string, number>()
    for (const rt of input.resourceTypes) {
      for (const period of currentResult.periods) {
        let periodFloor = 0
        for (let week = period.startWeek; week < period.endWeek; week++) {
          let weeklyFloor = 0
          for (const namedResource of rt.namedResources ?? []) {
            // capacitySegments are authoritative; otherwise match
            // getWeeklyCapacity's physical availability guard before applying
            // legacy allocation fields.
            if (!namedResource.capacitySegments || namedResource.capacitySegments.length === 0) {
              const start = namedResource.startWeek ?? 0
              const end = namedResource.endWeek ?? Infinity
              if (week < start || week > end) continue
            }
            weeklyFloor += effectiveAllocationPct(namedResource, week) / 100
          }
          if (weeklyFloor > periodFloor) periodFloor = weeklyFloor
        }
        namedFloors.set(`${rt.id}:${period.periodIndex}`, periodFloor)
      }
    }

    const minimumFor = (resourceTypeId: string, periodIndex: number) => Math.max(
      quantizeHeadcountUp(config.minFloor.get(resourceTypeId) ?? 0),
      namedFloors.get(`${resourceTypeId}:${periodIndex}`) ?? 0,
    )
    const candidateSlots = Math.max(1, currentResult.periods.reduce((sum, period) => sum + period.resources.length, 0))
    const removableSlots = currentResult.periods.reduce((sum, period) => sum + period.resources.reduce(
      (periodSum, resource) => {
        const removable = resource.headcount - minimumFor(resource.resourceTypeId, period.periodIndex)
        return periodSum + Math.max(0, Math.ceil((removable - FLOAT_EPSILON) / HEADCOUNT_QUANTUM))
      }, 0,
    ), 0)
    // Failed trials may become feasible after another period is reduced, so
    // permit a complete bounded retry pass for each removable quantum.
    const maxReductionTrials = Math.max(1, (removableSlots + 1) * candidateSlots)
    let reductionTrials = 0
    let reductionFound = true

    while (reductionFound && reductionTrials < maxReductionTrials) {
      reductionFound = false
      for (const period of currentResult.periods) {
        for (const resource of period.resources) {
          if (reductionTrials >= maxReductionTrials) break
          reductionTrials++
          const minimum = minimumFor(resource.resourceTypeId, period.periodIndex)
          const candidateHeadcount = round2(resource.headcount - HEADCOUNT_QUANTUM)
          if (candidateHeadcount < minimum - FLOAT_EPSILON) continue

          const candidatePeriods = currentResult.periods.map(candidatePeriod => ({
            ...candidatePeriod,
            resources: candidatePeriod.resources.map(candidateResource => (
              candidatePeriod.periodIndex === period.periodIndex &&
              candidateResource.resourceTypeId === resource.resourceTypeId
                ? { ...candidateResource, headcount: Math.max(0, candidateHeadcount) }
                : candidateResource
            )),
          }))
          const candidateRts = materializeEnvelopeToResourceTypes(input.resourceTypes, candidatePeriods, periodWeeks)
          let candidateSchedule: SAPlannerResult
          try {
            candidateSchedule = runSAPlanner({ ...input, resourceTypes: candidateRts }, saConfig)
          } catch (error) {
            if (!(error instanceof SAPlannerInfeasibleError)) throw error
            continue
          }

          if (candidateSchedule.totalDeliveryWeeks <= targetDurationWeeks + FLOAT_EPSILON) {
            currentResult = adoptValidatedSchedule(
              { ...currentResult, periods: candidatePeriods }, candidateSchedule, candidateRts,
            )
            currentSchedule = candidateSchedule
            reductionFound = true
            reductionCommitted = true
          }
        }
        if (reductionTrials >= maxReductionTrials) break
      }
    }

    if (reductionCommitted) {
      bestResult = currentResult
      bestSchedule = currentSchedule
    }
  }

  // Do not restore the faster initial schedule here. A slower schedule that
  // still meets the target with fewer staffed FTE-weeks is the required plan;
  // Phase 3 has already proved each retained reduction feasible.

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
        // Keep bestResult.periods: those are the exact capacity envelope used
        // to construct reconciledRts. Refreshing via buildResult would derive
        // another envelope from the replay and claim it was validated.
        bestResult = adoptValidatedSchedule(bestResult, reconciledSchedule, reconciledRts)
        bestSchedule = reconciledSchedule
        reconciliationSucceeded = true
      } else {
        bestResult = { ...bestResult, deliveryWeeks: Infinity }
      }
    } catch (error) {
      if (!(error instanceof SAPlannerInfeasibleError)) throw error
      allDiagnostics.push(...error.diagnostics)
      // Reconciliation failed — the pre-reconciliation result cannot be
      // claimed as reconciled. Mark as not achieved so callers know the
      // returned profile has not been validated against the scheduler.
      bestResult = { ...bestResult, deliveryWeeks: Infinity }
    }
    totalIterations++ // count reconciliation as one iteration
  }

  // ── Phase 6: Final diagnostics from the best schedule ─────────────────────
  if (bestSchedule && bestResult && bestResult.deliveryWeeks > targetDurationWeeks) {
    allDiagnostics.push(...analyzeTargetMiss(bestSchedule, input, saConfig))
    // analyzeTargetMiss intentionally uses a tolerance for noisy estimates.
    // A hard cap must still be reported for a small (even 5%) target miss.
    for (const rt of currentRts) {
      const cap = maxCap?.get(rt.id)
      if (cap == null) continue
      const demand = bestSchedule.weeklyDemandByResourceType.get(rt.id) ?? []
      const demandWeeks = demand
        .map((days, week) => ({ days: days ?? 0, week }))
        .filter(entry => entry.days > EPSILON)
      if (demandWeeks.length === 0) continue
      // A role is hard-capped only when every week carrying demand is at the
      // configured maximum. An earlier peak must not suppress later growth.
      const allDemandWeeksCapped = demandWeeks.every(entry =>
        currentCapacityFte(rt, entry.week) >= cap - FLOAT_EPSILON)
      if (!allDemandWeeksCapped) continue
      const totalDemand = demandWeeks.reduce((sum, entry) => sum + entry.days, 0)
      if (totalDemand <= targetDurationWeeks * cap * 5 + FLOAT_EPSILON) continue
      if (allDiagnostics.some(d => d.blocker === 'ROLE_MAX_CAP' && d.resourceTypeId === rt.id)) continue
      allDiagnostics.push({
        blocker: 'ROLE_MAX_CAP',
        resourceTypeId: rt.id,
        resourceTypeName: rt.name,
        configuredLimit: `${cap}`,
        requested: `>${cap} FTE needed for ${Math.round(totalDemand)} days in ${targetDurationWeeks} weeks`,
        achieved: `${cap} FTE (${Math.round(cap * 5)} days/week)`,
        explanation: `${rt.name} is capped at ${cap}; the target requires ${Math.round(totalDemand)} days in ${targetDurationWeeks} weeks.`,
      })
    }
  }

  let finalResult = bestResult
  // Surface the structured blockers on the returned result whenever the
  // final (reconciled) schedule misses the target, so callers see the same
  // diagnostics that explain targetAchieved: false (wire contract #481).
  if (finalResult && finalResult.deliveryWeeks > targetDurationWeeks + FLOAT_EPSILON) {
    finalResult = { ...finalResult, diagnostics: allDiagnostics }
  }
  if (!finalResult) {
    try {
      finalResult = computeCapacityPlan(input, config)
    } catch (error) {
      if (!(error instanceof SAPlannerInfeasibleError)) throw error
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
