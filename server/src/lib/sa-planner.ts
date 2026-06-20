/**
 * sa-planner.ts — Deterministic weekly fractional staffing planner.
 *
 * Schedules feature work as week-by-week resource flow instead of fixed blocks.
 * Each week, ready features receive fractional RT capacity in priority order,
 * capped per feature to avoid unrealistic single-feature staffing spikes.
 *
 * Pure function: no I/O, no Prisma, no side effects.
 */

import {
  getWeeklyCapacity,
  type SchedulerInput,
  type SchedulerResourceType,
} from './scheduler.js'
import { effectiveDays } from '../utils/round.js'

// ─── Config ──────────────────────────────────────────────────────────────────

export interface SAPlannerConfig {
  /** Target delivery duration in weeks */
  targetDurationWeeks: number
  /** Max people from one RT on a single feature. Default 2. */
  maxParallelismPerFeature?: number
  /** Per-RT max headcount cap (rtId → max). No cap if absent. */
  maxCap?: Map<string, number>
  /** Maximum number of epics active simultaneously. Default: all (no limit). */
  maxConcurrentEpics?: number
  /** Legacy compatibility only; ignored by the deterministic allocator. */
  iterations?: number
  /** Legacy compatibility only; ignored by the deterministic allocator. */
  initialTemp?: number
  /** Legacy compatibility only; ignored by the deterministic allocator. */
  coolingRate?: number

  // Legacy compatibility only; ignored by the deterministic allocator.
  weightUtilVariance?: number
  weightOverAllocation?: number
  weightDurationPenalty?: number
  weightGapPenalty?: number
}

export interface SAPlannerResult {
  /** Feature start weeks (same shape as LevellingResult) */
  epicStartWeeks: Map<string, number>
  featureStartWeeks: Map<string, number>
  totalDeliveryWeeks: number
  peakUtilisationPct: number
  /** Fitness score of the best solution (lower = better) */
  bestFitness: number
  /** Number of iterations that improved the solution */
  improvements: number
  /** Actual weekly demand curve by RT (days/week) */
  weeklyDemandByResourceType: Map<string, number[]>
  /** Actual per-feature weekly RT allocations (days/week) */
  weeklyAllocationsByFeature: Map<string, Map<number, Map<string, number>>>
}

// ─── Internal types ──────────────────────────────────────────────────────────

interface FeatureInfo {
  id: string
  epicId: string
  epicOrder: number
  featureOrder: number
  remainingDaysByRt: Map<string, number>
  totalDaysByRt: Map<string, number>
  predecessors: Set<string>
  startedWeek?: number
  completedWeek?: number
  hasDemand: boolean
}

const EPSILON = 1e-6

// ─── Main entry ──────────────────────────────────────────────────────────────

export function runSAPlanner(
  input: SchedulerInput,
  config: SAPlannerConfig,
): SAPlannerResult {
  const {
    targetDurationWeeks,
    maxParallelismPerFeature = 2,
    maxCap,
    maxConcurrentEpics,
  } = config

  const { epics, resourceTypes, epicDeps } = input
  const hpd = input.project.hoursPerDay

  const features: FeatureInfo[] = []
  const featureMap = new Map<string, FeatureInfo>()
  const featuresByEpic = new Map<string, FeatureInfo[]>()
  const epicById = new Map(epics.map(epic => [epic.id, epic]))
  const rtById = new Map(resourceTypes.map(rt => [rt.id, rt]))

  const effectiveRtCount = new Map<string, number>()
  for (const rt of resourceTypes) {
    const capCount = maxCap?.get(rt.id)
    effectiveRtCount.set(rt.id, Math.max(0, Math.min(rt.count, capCount ?? rt.count)))
  }

  for (const epic of epics) {
    const epicFeatures: FeatureInfo[] = []

    for (const feature of epic.features) {
      const totalDaysByRt = new Map<string, number>()

      for (const story of feature.userStories) {
        if (story.isActive === false) continue
        for (const task of story.tasks) {
          if (!task.resourceTypeId) continue
          const rtHpd = task.resourceType?.hoursPerDay ?? hpd
          const days = effectiveDays(task.durationDays, task.hoursEffort, rtHpd)
          totalDaysByRt.set(task.resourceTypeId, (totalDaysByRt.get(task.resourceTypeId) ?? 0) + days)
        }
      }

      const info: FeatureInfo = {
        id: feature.id,
        epicId: epic.id,
        epicOrder: epic.order,
        featureOrder: feature.order,
        remainingDaysByRt: new Map(totalDaysByRt),
        totalDaysByRt,
        predecessors: new Set(),
        hasDemand: totalDaysByRt.size > 0,
      }

      features.push(info)
      featureMap.set(feature.id, info)
      epicFeatures.push(info)
    }

    featuresByEpic.set(epic.id, epicFeatures)
  }

  for (const epic of epics) {
    for (const feature of epic.features) {
      const info = featureMap.get(feature.id)
      if (!info) continue
      for (const dep of feature.dependencies ?? []) {
        info.predecessors.add(dep.dependsOnId)
      }
    }
  }

  for (const dep of epicDeps) {
    const fromEpic = epicById.get(dep.dependsOnId)
    const toEpic = epicById.get(dep.epicId)
    if (!fromEpic || !toEpic) continue

    for (const toFeature of toEpic.features) {
      const info = featureMap.get(toFeature.id)
      if (!info) continue
      for (const fromFeature of fromEpic.features) {
        info.predecessors.add(fromFeature.id)
      }
    }
  }

  for (const epic of epics) {
    if ((epic.featureMode ?? 'sequential') !== 'sequential') continue
    const sortedFeatures = [...epic.features].sort((a, b) => a.order - b.order)
    for (let i = 1; i < sortedFeatures.length; i++) {
      const info = featureMap.get(sortedFeatures[i].id)
      if (info) info.predecessors.add(sortedFeatures[i - 1].id)
    }
  }

  const weeklyDemandByResourceType = new Map<string, number[]>()
  const weeklyAllocationsByFeature = new Map<string, Map<number, Map<string, number>>>()

  for (const rt of resourceTypes) weeklyDemandByResourceType.set(rt.id, [])
  for (const feature of features) weeklyAllocationsByFeature.set(feature.id, new Map())

  const featureWeeklyCapByRt = new Map<string, Map<string, number>>()
  for (const feature of features) {
    const capByRt = new Map<string, number>()
    for (const rtId of feature.totalDaysByRt.keys()) {
      const allowedPeople = Math.min(
        maxParallelismPerFeature,
        effectiveRtCount.get(rtId) ?? (rtById.get(rtId)?.count ?? maxParallelismPerFeature),
      )
      capByRt.set(rtId, Math.max(0, allowedPeople * 5))
    }
    featureWeeklyCapByRt.set(feature.id, capByRt)
  }

  const totalDemandByRt = new Map<string, number>()
  for (const feature of features) {
    for (const [rtId, days] of feature.totalDaysByRt) {
      totalDemandByRt.set(rtId, (totalDemandByRt.get(rtId) ?? 0) + days)
    }
  }

  function getSizingCapacityDays(rt: SchedulerResourceType, week: number): number {
    const hoursPerDay = rt.hoursPerDay ?? hpd
    if (hoursPerDay <= 0) return 0

    let capacityDays = getWeeklyCapacity(rt, week, hpd) / hoursPerDay
    if (!Number.isFinite(capacityDays) || capacityDays <= 0) return 0

    const capCount = maxCap?.get(rt.id)
    if (capCount != null && rt.count > 0 && capCount < rt.count) {
      capacityDays *= capCount / rt.count
    }

    return Math.max(0, capacityDays)
  }

  function estimateAvailabilityProbeWeeks(rt: SchedulerResourceType, durationWeeks: number): number {
    const latestNamedWindowWeek = (rt.namedResources ?? []).reduce((latest, nr) => {
      return Math.max(
        latest,
        nr.startWeek ?? 0,
        nr.endWeek ?? 0,
        nr.allocationStartWeek ?? 0,
        nr.allocationEndWeek ?? 0,
      )
    }, 0)

    return Math.max(
      52,
      Math.ceil(targetDurationWeeks * 3),
      Math.ceil(durationWeeks * 4) + features.length + 12,
      latestNamedWindowWeek + Math.ceil(targetDurationWeeks * 2) + 12,
    )
  }

  function estimateFeatureDurationWeeks(
    daysByRt: Map<string, number>,
    capByRt?: Map<string, number>,
  ): number {
    let durationWeeks = 0
    for (const [rtId, days] of daysByRt) {
      if (days <= EPSILON) continue
      const weeklyCap = capByRt?.get(rtId) ?? days
      if (weeklyCap <= EPSILON) continue
      durationWeeks = Math.max(durationWeeks, days / weeklyCap)
    }

    return Math.max(1, durationWeeks)
  }

  const serialFeatureDurationWeeks = features.reduce((total, feature) => {
    if (!feature.hasDemand) return total
    const capByRt = featureWeeklyCapByRt.get(feature.id)
    return total + estimateFeatureDurationWeeks(feature.totalDaysByRt, capByRt)
  }, 0)

  const bottleneckFeatureDurationWeeks = features.reduce((maxWeeks, feature) => {
    if (!feature.hasDemand) return maxWeeks
    const capByRt = featureWeeklyCapByRt.get(feature.id)
    return Math.max(maxWeeks, estimateFeatureDurationWeeks(feature.totalDaysByRt, capByRt))
  }, 0)

  const aggregateDurationWithDelayWeeks = (() => {
    let maxWeeks = 0
    let maxAvailabilityDelayWeeks = 0
    for (const rt of resourceTypes) {
      const demand = totalDemandByRt.get(rt.id) ?? 0
      if (demand <= EPSILON) continue
      const people = effectiveRtCount.get(rt.id) ?? rt.count ?? 0
      if (people <= EPSILON) continue

      const demandDurationWeeks = demand / (people * 5)
      const sizingDurationWeeks = Math.max(
        demandDurationWeeks,
        bottleneckFeatureDurationWeeks,
        serialFeatureDurationWeeks,
      )
      const probeWeeks = estimateAvailabilityProbeWeeks(rt, sizingDurationWeeks)
      let availabilityDelayWeeks = probeWeeks

      for (let week = 0; week <= probeWeeks; week++) {
        if (getSizingCapacityDays(rt, week) > EPSILON) {
          availabilityDelayWeeks = week
          break
        }
      }

      const weeks = demandDurationWeeks + availabilityDelayWeeks
      if (weeks > maxWeeks) maxWeeks = weeks
      if (availabilityDelayWeeks > maxAvailabilityDelayWeeks) {
        maxAvailabilityDelayWeeks = availabilityDelayWeeks
      }
    }

    return Math.max(
      maxWeeks,
      serialFeatureDurationWeeks + maxAvailabilityDelayWeeks,
      bottleneckFeatureDurationWeeks + maxAvailabilityDelayWeeks,
    )
  })()

  const MAX_WEEKS = Math.max(
    52,
    Math.ceil(targetDurationWeeks * 3),
    Math.ceil(aggregateDurationWithDelayWeeks * 4) + features.length + 12,
  )

  let completedFeatureCount = 0
  let lastAllocationWeek = -1

  function isFeatureComplete(feature: FeatureInfo): boolean {
    for (const remaining of feature.remainingDaysByRt.values()) {
      if (remaining > EPSILON) return false
    }
    return true
  }

  function isFeatureReady(feature: FeatureInfo, week: number): boolean {
    if (feature.completedWeek !== undefined) return false
    for (const predId of feature.predecessors) {
      const pred = featureMap.get(predId)
      if (!pred || pred.completedWeek === undefined || pred.completedWeek >= week) return false
    }
    return true
  }

  function getEpicStartedWeek(epicId: string): number | undefined {
    const epicFeatures = featuresByEpic.get(epicId) ?? []
    let minWeek: number | undefined
    for (const feature of epicFeatures) {
      if (feature.startedWeek === undefined) continue
      if (minWeek === undefined || feature.startedWeek < minWeek) minWeek = feature.startedWeek
    }
    return minWeek
  }

  function isEpicComplete(epicId: string): boolean {
    const epicFeatures = featuresByEpic.get(epicId) ?? []
    return epicFeatures.length > 0 && epicFeatures.every(feature => feature.completedWeek !== undefined)
  }

  function isEpicActive(epicId: string): boolean {
    return getEpicStartedWeek(epicId) !== undefined && !isEpicComplete(epicId)
  }

  function canStartFeature(feature: FeatureInfo): boolean {
    if (!maxConcurrentEpics) return true
    if (getEpicStartedWeek(feature.epicId) !== undefined) return true

    let activeEpicCount = 0
    for (const epic of epics) {
      if (isEpicActive(epic.id)) activeEpicCount++
    }

    return activeEpicCount < maxConcurrentEpics
  }

  function getWeeklyCapacityDays(rt: SchedulerResourceType, week: number): number {
    const hoursPerDay = rt.hoursPerDay ?? hpd
    if (hoursPerDay <= 0) return 0

    let capacityDays = getWeeklyCapacity(rt, week, hpd) / hoursPerDay
    if (!Number.isFinite(capacityDays) || capacityDays <= 0) return 0

    const capCount = maxCap?.get(rt.id)
    if (capCount != null && rt.count > 0 && capCount < rt.count) {
      capacityDays *= capCount / rt.count
    }

    return Math.max(0, capacityDays)
  }

  function compareFeatures(a: FeatureInfo, b: FeatureInfo): number {
    if (a.epicOrder !== b.epicOrder) return a.epicOrder - b.epicOrder

    const aStarted = a.startedWeek !== undefined ? 0 : 1
    const bStarted = b.startedWeek !== undefined ? 0 : 1
    if (aStarted !== bStarted) return aStarted - bStarted

    if (a.featureOrder !== b.featureOrder) return a.featureOrder - b.featureOrder
    return a.id.localeCompare(b.id)
  }

  function estimateFeatureRemainingWeeks(feature: FeatureInfo): number {
    const capByRt = featureWeeklyCapByRt.get(feature.id)
    return estimateFeatureDurationWeeks(feature.remainingDaysByRt, capByRt)
  }

  function recordAllocation(feature: FeatureInfo, rtId: string, week: number, days: number) {
    const byWeek = weeklyAllocationsByFeature.get(feature.id)
    if (!byWeek) return

    let byRt = byWeek.get(week)
    if (!byRt) {
      byRt = new Map<string, number>()
      byWeek.set(week, byRt)
    }

    byRt.set(rtId, (byRt.get(rtId) ?? 0) + days)

    const weeklyDemand = weeklyDemandByResourceType.get(rtId)
    if (weeklyDemand) {
      weeklyDemand[week] = (weeklyDemand[week] ?? 0) + days
    }
  }

  for (let week = 0; week < MAX_WEEKS && completedFeatureCount < features.length; week++) {
    const readyFeatures = features
      .filter(feature => isFeatureReady(feature, week) && canStartFeature(feature))
      .sort(compareFeatures)

    if (readyFeatures.length === 0) continue

    for (const feature of readyFeatures) {
      if (feature.startedWeek !== undefined || feature.hasDemand) continue
      feature.startedWeek = week
      feature.completedWeek = week
      completedFeatureCount++
    }

    for (const rt of resourceTypes) {
      let availableCapacity = getWeeklyCapacityDays(rt, week)
      if (availableCapacity <= EPSILON) continue

      const estimatedFeatureWeeks = new Map<string, number>()
      for (const feature of readyFeatures) {
        estimatedFeatureWeeks.set(feature.id, estimateFeatureRemainingWeeks(feature))
      }

      const candidates = readyFeatures
        .filter(feature => (feature.remainingDaysByRt.get(rt.id) ?? 0) > EPSILON)
        .sort(compareFeatures)

      if (candidates.length === 0) continue

      const baselineAllocations = new Map<string, number>()
      const weeksLeftToTarget = Math.max(1, targetDurationWeeks - week)

      for (const feature of candidates) {
        if (availableCapacity <= EPSILON) break

        const remaining = feature.remainingDaysByRt.get(rt.id) ?? 0
        const perFeatureCap = Math.min(
          remaining,
          featureWeeklyCapByRt.get(feature.id)?.get(rt.id) ?? remaining,
        )
        if (perFeatureCap <= EPSILON) continue

        const featureRemainingWeeks = estimatedFeatureWeeks.get(feature.id) ?? 1
        const pacingWeeks = week < targetDurationWeeks
          ? Math.max(1, Math.min(weeksLeftToTarget, featureRemainingWeeks))
          : 1
        const smoothedTarget = Math.min(perFeatureCap, remaining / pacingWeeks)

        const allocation = Math.min(availableCapacity, smoothedTarget)
        if (allocation <= EPSILON) continue

        baselineAllocations.set(feature.id, allocation)
        availableCapacity -= allocation
      }

      // Continuity-aware pacing deliberately avoids spending all spare RT
      // capacity whenever multiple features compete for the same role. This
      // keeps smaller role slices on long-running features from disappearing
      // early while the feature remains active. We still top up when there is
      // only one ready candidate so blockers can clear quickly.
      if (availableCapacity > EPSILON && candidates.length === 1) {
        for (const feature of candidates) {
          if (availableCapacity <= EPSILON) break

          const remaining = feature.remainingDaysByRt.get(rt.id) ?? 0
          const existing = baselineAllocations.get(feature.id) ?? 0
          const perFeatureCap = Math.min(
            remaining,
            featureWeeklyCapByRt.get(feature.id)?.get(rt.id) ?? remaining,
          )
          const extraRoom = perFeatureCap - existing
          if (extraRoom <= EPSILON) continue

          const extra = Math.min(availableCapacity, extraRoom)
          baselineAllocations.set(feature.id, existing + extra)
          availableCapacity -= extra
        }
      }

      for (const feature of candidates) {
        const allocation = baselineAllocations.get(feature.id) ?? 0
        if (allocation <= EPSILON) continue

        const remaining = feature.remainingDaysByRt.get(rt.id) ?? 0
        const nextRemaining = Math.max(0, remaining - allocation)
        feature.remainingDaysByRt.set(rt.id, nextRemaining)

        if (feature.startedWeek === undefined) feature.startedWeek = week

        recordAllocation(feature, rt.id, week, allocation)
        lastAllocationWeek = Math.max(lastAllocationWeek, week)
      }
    }

    for (const feature of readyFeatures) {
      if (feature.completedWeek !== undefined) continue
      if (!isFeatureComplete(feature)) continue

      feature.completedWeek = week
      if (feature.startedWeek === undefined) feature.startedWeek = week
      completedFeatureCount++
    }
  }

  for (const feature of features) {
    if (feature.completedWeek !== undefined) continue
    if (!isFeatureComplete(feature)) {
      throw new Error(`Fractional planner could not finish feature ${feature.id} within ${MAX_WEEKS} weeks`)
    }

    const fallbackWeek = feature.startedWeek ?? 0
    feature.startedWeek = fallbackWeek
    feature.completedWeek = fallbackWeek
    completedFeatureCount++
  }

  const featureStartWeeks = new Map<string, number>()
  for (const feature of features) {
    featureStartWeeks.set(feature.id, feature.startedWeek ?? 0)
  }

  const epicStartWeeks = new Map<string, number>()
  for (const epic of epics) {
    let minWeek = Infinity
    for (const feature of featuresByEpic.get(epic.id) ?? []) {
      if (feature.startedWeek !== undefined && feature.startedWeek < minWeek) {
        minWeek = feature.startedWeek
      }
    }
    epicStartWeeks.set(epic.id, minWeek === Infinity ? 0 : minWeek)
  }

  const totalDeliveryWeeks = lastAllocationWeek >= 0 ? lastAllocationWeek + 1 : 0

  let peakUtilisationPct = 0
  for (const rt of resourceTypes) {
    const weeklyDemand = weeklyDemandByResourceType.get(rt.id) ?? []
    for (let week = 0; week < weeklyDemand.length; week++) {
      const demand = weeklyDemand[week] ?? 0
      if (demand <= EPSILON) continue
      const capacity = getWeeklyCapacityDays(rt, week)
      const utilisation = capacity > EPSILON ? (demand / capacity) * 100 : 0
      if (utilisation > peakUtilisationPct) peakUtilisationPct = utilisation
    }
  }

  return {
    epicStartWeeks,
    featureStartWeeks,
    totalDeliveryWeeks,
    peakUtilisationPct: Math.round(peakUtilisationPct * 10) / 10,
    bestFitness: totalDeliveryWeeks,
    improvements: 0,
    weeklyDemandByResourceType,
    weeklyAllocationsByFeature,
  }
}
