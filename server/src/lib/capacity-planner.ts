/**
 * capacity-planner.ts — Demand Envelope capacity planner for squad sizing.
 *
 * Pure function: no I/O, no Prisma, no side effects.
 * Given a backlog (SchedulerInput) and a target delivery window, computes
 * the minimum smooth capacity envelope per resource type per period.
 */

import {
  getWeeklyCapacity,
  type SchedulerInput,
  type SchedulerResourceType,
} from './scheduler.js'
import { levelEpicStarts, type LevellingResult } from './leveller.js'

// ─── Public types ────────────────────────────────────────────────────────────

export interface CapacityPlanConfig {
  /** Target delivery duration in weeks (e.g., 78 for 18 months) */
  targetDurationWeeks: number
  /** Period length: 4 = monthly, 13 = quarterly */
  periodWeeks: 4 | 13
  /** Max headcount change per RT per period (default 1) */
  maxDeltaPerPeriod: number
  /** Minimum headcount floor per RT (rtId → min count). Default 1 for all. */
  minFloor: Map<string, number>
  /** Day rates for cost computation (rtId → dayRate) */
  dayRates: Map<string, number>
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
    headcount: number       // smoothed capacity (integer)
    peakDemandFTE: number   // peak demand in this period (can be fractional)
    avgDemandFTE: number    // average demand in this period
    utilisationPct: number  // avg / headcount × 100 (0 if headcount is 0)
    costForPeriod: number   // headcount × dayRate × periodWeeks × 5
  }>
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
}

// ─── Main entry ──────────────────────────────────────────────────────────────

export function computeCapacityPlan(
  input: SchedulerInput,
  config: CapacityPlanConfig,
): CapacityPlanResult {
  const { targetDurationWeeks, periodWeeks, maxDeltaPerPeriod, minFloor, dayRates, maxBudget } = config
  const hpd = input.project.hoursPerDay

  // ── Step 1: Scale estimation ─────────────────────────────────────────────
  // Run leveller with current capacity to get baseline delivery
  let scaledInput = { ...input }
  let levelResult = levelEpicStarts(scaledInput)

  // If current capacity can't deliver within target, scale up iteratively
  const MAX_ITERATIONS = 5
  let iteration = 0
  while (levelResult.totalDeliveryWeeks > targetDurationWeeks && iteration < MAX_ITERATIONS) {
    iteration++
    const scaleFactor = Math.min(
      levelResult.totalDeliveryWeeks / targetDurationWeeks,
      2.0, // cap scale factor to avoid unreasonably large teams
    )
    // Scale up all resource types
    const scaledRTs: SchedulerResourceType[] = scaledInput.resourceTypes.map(rt => ({
      ...rt,
      count: Math.min(
        Math.ceil(rt.count * scaleFactor),
        rt.count * 3, // hard cap at 3× original
      ),
    }))
    scaledInput = { ...scaledInput, resourceTypes: scaledRTs }
    levelResult = levelEpicStarts(scaledInput)
  }

  // ── Step 2: Compute demand curve ─────────────────────────────────────────
  // From the levelled schedule, extract per-RT per-week demand
  const totalWeeks = Math.ceil(levelResult.totalDeliveryWeeks)
  const epics = scaledInput.epics
  const resourceTypes = scaledInput.resourceTypes
  const rtById = new Map(resourceTypes.map(rt => [rt.id, rt]))

  // demandDays[rtId][week] = total person-days of demand in that week
  const demandDays = new Map<string, Float64Array>()
  for (const rt of resourceTypes) {
    demandDays.set(rt.id, new Float64Array(totalWeeks + 1))
  }

  // For each feature, spread its demand evenly across its placed duration
  const rtCountMap = new Map(resourceTypes.map(rt => [rt.id, rt.count]))
  const parallelEpicIds = new Set(epics.filter(e => e.featureMode === 'parallel').map(e => e.id))

  for (const epic of epics) {
    for (const feature of epic.features) {
      const startWeek = levelResult.featureStartWeeks.get(feature.id)
      if (startWeek === undefined) continue

      // Compute total demand per RT for this feature
      const featureDemand = new Map<string, number>()
      for (const story of feature.userStories) {
        if (story.isActive === false) continue
        for (const task of story.tasks) {
          if (!task.resourceTypeId) continue
          const rtHpd = task.resourceType?.hoursPerDay ?? hpd
          const days = task.durationDays ?? (task.hoursEffort / rtHpd)
          featureDemand.set(task.resourceTypeId, (featureDemand.get(task.resourceTypeId) ?? 0) + days)
        }
      }

      // Get feature duration from levelResult
      let featureDurWeeks: number

      if (parallelEpicIds.has(epic.id)) {
        // Raw duration (same as leveller)
        const allTasks = feature.userStories
          .filter(s => s.isActive !== false)
          .flatMap(s => s.tasks)
        if (allTasks.length === 0) {
          featureDurWeeks = 1
        } else {
          const byRt = new Map<string | null, typeof allTasks>()
          for (const task of allTasks) {
            const group = byRt.get(task.resourceTypeId) ?? []
            group.push(task)
            byRt.set(task.resourceTypeId, group)
          }
          let maxDays = 0
          for (const [rtId, tasks] of byRt) {
            const personDays = tasks.reduce((sum, t) => {
              const rtHpd = t.resourceType?.hoursPerDay ?? hpd
              return sum + (t.durationDays ?? (t.hoursEffort / rtHpd))
            }, 0)
            const count = rtId ? (rtCountMap.get(rtId) ?? 1) : 1
            const days = personDays / count
            if (days > maxDays) maxDays = days
          }
          featureDurWeeks = Math.max(0.2, maxDays / 5)
        }
      } else {
        // Sequential: use scheduler output duration (approximate with demand/capacity)
        let maxWeeks = 1
        for (const [rtId, totalDemand] of featureDemand) {
          const rt = rtById.get(rtId)
          if (!rt) continue
          const capacityPerWeek = getWeeklyCapacity(rt, 0, hpd) / (rt.hoursPerDay ?? hpd)
          if (capacityPerWeek > 0) {
            const weeks = totalDemand / capacityPerWeek
            if (weeks > maxWeeks) maxWeeks = weeks
          }
        }
        featureDurWeeks = maxWeeks
      }

      const ceilDur = Math.max(1, Math.ceil(featureDurWeeks))
      const endWeek = Math.min(startWeek + ceilDur, totalWeeks + 1)

      // Spread demand evenly across the feature's duration
      for (const [rtId, totalDemandDays] of featureDemand) {
        const arr = demandDays.get(rtId)
        if (!arr) continue
        const ratePerWeek = totalDemandDays / ceilDur
        for (let w = Math.floor(startWeek); w < endWeek; w++) {
          if (w >= 0 && w < arr.length) {
            arr[w] += ratePerWeek
          }
        }
      }
    }
  }

  // ── Step 3: Identify demand RTs (those with actual demand) ───────────────
  const plannedRtIds: string[] = []
  for (const [rtId, arr] of demandDays) {
    const hasDemand = arr.some(d => d > 0)
    if (hasDemand) plannedRtIds.push(rtId)
  }

  // ── Step 4: Period aggregation ───────────────────────────────────────────
  const numPeriods = Math.max(1, Math.ceil(totalWeeks / periodWeeks))

  // peakFTE[rtId][period] and avgFTE[rtId][period]
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
          const fte = arr[w] / 5 // days per week → FTE
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

  // ── Step 5: Capacity envelope fitting ────────────────────────────────────
  // Start with ceil(peakFTE) per period per RT
  const capacity = new Map<string, number[]>()

  for (const rtId of plannedRtIds) {
    const peaks = peakFTE.get(rtId)!
    const cap = peaks.map(p => Math.ceil(p))
    capacity.set(rtId, cap)
  }

  // Apply minimum floor
  for (const rtId of plannedRtIds) {
    const floor = minFloor.get(rtId) ?? 1
    const cap = capacity.get(rtId)!
    for (let p = 0; p < numPeriods; p++) {
      if (cap[p] < floor) cap[p] = floor
    }
  }

  // Forward-backward smoothing (max delta constraint)
  // Repeat until stable
  for (let pass = 0; pass < 5; pass++) {
    let changed = false
    for (const rtId of plannedRtIds) {
      const cap = capacity.get(rtId)!
      // Forward pass: can't increase by more than maxDelta per period
      for (let p = 1; p < numPeriods; p++) {
        if (cap[p] > cap[p - 1] + maxDeltaPerPeriod) {
          cap[p] = cap[p - 1] + maxDeltaPerPeriod
          changed = true
        }
      }
      // Backward pass: can't decrease by more than maxDelta per period
      for (let p = numPeriods - 2; p >= 0; p--) {
        if (cap[p] > cap[p + 1] + maxDeltaPerPeriod) {
          cap[p] = cap[p + 1] + maxDeltaPerPeriod
          changed = true
        }
      }
      // Re-apply floor (smoothing might have pushed below)
      const floor = minFloor.get(rtId) ?? 1
      for (let p = 0; p < numPeriods; p++) {
        if (cap[p] < floor) { cap[p] = floor; changed = true }
      }
      // Ensure capacity covers peak demand (smoothing might have capped it)
      const peaks = peakFTE.get(rtId)!
      for (let p = 0; p < numPeriods; p++) {
        const needed = Math.ceil(peaks[p])
        if (cap[p] < needed) { cap[p] = needed; changed = true }
      }
    }
    if (!changed) break
  }

  // ── Step 6: Build output ─────────────────────────────────────────────────
  const periods: CapacityPlanPeriodResult[] = []
  let totalCost = 0
  let peakHeadcount = 0
  let totalUtilWeighted = 0
  let totalUtilWeight = 0

  for (let p = 0; p < numPeriods; p++) {
    const pStartWeek = p * periodWeeks
    const pEndWeek = Math.min((p + 1) * periodWeeks, totalWeeks + 1)
    const periodLabel = periodWeeks === 4
      ? `Month ${p + 1}`
      : `Q${p + 1}`

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
        resourceTypeId: rtId,
        resourceTypeName: rt.name,
        headcount,
        peakDemandFTE: Math.round(peak * 100) / 100,
        avgDemandFTE: Math.round(avg * 100) / 100,
        utilisationPct: Math.round(util * 10) / 10,
        costForPeriod: Math.round(costForPeriod),
      })

      totalCost += costForPeriod
      periodHeadcount += headcount
      totalUtilWeighted += util * headcount
      totalUtilWeight += headcount
    }

    if (periodHeadcount > peakHeadcount) peakHeadcount = periodHeadcount
    periods.push({ periodIndex: p, periodLabel, startWeek: pStartWeek, endWeek: pEndWeek, resources })
  }

  const avgUtilisationPct = totalUtilWeight > 0
    ? Math.round((totalUtilWeighted / totalUtilWeight) * 10) / 10
    : 0

  return {
    periods,
    totalCost: Math.round(totalCost),
    deliveryWeeks: levelResult.totalDeliveryWeeks,
    peakHeadcount,
    avgUtilisationPct,
    budgetExceeded: maxBudget != null ? totalCost > maxBudget : false,
    levellingResult: levelResult,
    plannedResourceTypeIds: plannedRtIds,
  }
}
