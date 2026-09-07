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
import { effortDays, scheduleDurationDays } from '../utils/round.js'
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
  /** Structured infeasibility diagnostics when the planner cannot complete all features */
  diagnostics?: PlannerDiagnostic[]
}

// ─── Diagnostics ─────────────────────────────────────────────────────────────

export type PlannerDiagnosticBlocker =
  | 'ROLE_MAX_CAP'
  | 'PROFILE_WINDOW'
  | 'DEPENDENCY_PATH'
  | 'FEATURE_PARALLELISM'
  | 'CONCURRENT_EPICS'
  | 'SCHEDULE_LOCK'
  | 'CONSTRAINT'

export interface PlannerDiagnostic {
  /** The confirmed blocker category */
  blocker: PlannerDiagnosticBlocker
  /** Affected resource type ID where applicable */
  resourceTypeId?: string
  /** Affected resource type name where applicable */
  resourceTypeName?: string
  /** Affected feature ID where applicable */
  featureId?: string
  /** The configured limit that was hit (e.g. max cap value, window range) */
  configuredLimit?: string
  /** What was requested vs what was achieved */
  requested?: string
  achieved?: string
  /** Concise actionable explanation */
  explanation: string
}

/** Error carrying structured diagnostics when the SA planner cannot complete */
export class SAPlannerInfeasibleError extends Error {
  constructor(
    message: string,
    public readonly diagnostics: PlannerDiagnostic[],
  ) {
    super(message)
    this.name = 'SAPlannerInfeasibleError'
  }
}

// ─── Post-completion diagnostics ─────────────────────────────────────────────

/**
 * Analyze why a completed plan missed the requested target duration.
 * Called when totalDeliveryWeeks > targetDurationWeeks but the planner
 * did not throw (plan completed, just slowly).
 *
 * Uses actual schedule evidence: weekly capacity, demand curves, explicit
 * caps, profile windows, and dependency chains.
 */
export function analyzeTargetMiss(
  result: SAPlannerResult,
  input: SchedulerInput,
  config: SAPlannerConfig,
): PlannerDiagnostic[] {
  const {
    targetDurationWeeks,
    maxCap,
    maxParallelismPerFeature = 2,
    maxConcurrentEpics,
  } = config

  if (result.totalDeliveryWeeks <= targetDurationWeeks) return []

  const diagnostics: PlannerDiagnostic[] = []
  const EPSILON = 1e-6

  // Check 1: Profile window — demand exists in weeks beyond the profile window
  for (const rt of input.resourceTypes) {
    if (!rt.roleSegments || rt.roleSegments.length === 0) continue

    const weeklyDemand = result.weeklyDemandByResourceType.get(rt.id) ?? []
    const capAvailable = new Set<number>()
    for (const seg of rt.roleSegments) {
      for (let w = seg.startWeek; w <= seg.endWeek; w++) capAvailable.add(w)
    }

    // Find demand weeks beyond the profile window
    let demandBeyondWindow = 0
    let firstDemandBeyondWeek = -1
    for (let w = 0; w < weeklyDemand.length; w++) {
      if ((weeklyDemand[w] ?? 0) > EPSILON && !capAvailable.has(w)) {
        demandBeyondWindow += weeklyDemand[w]
        if (firstDemandBeyondWeek < 0) firstDemandBeyondWeek = w
      }
    }

    if (demandBeyondWindow > EPSILON) {
      const windowRange = rt.roleSegments
        .map(s => `W${s.startWeek}–W${s.endWeek}`)
        .join(', ')
      diagnostics.push({
        blocker: 'PROFILE_WINDOW',
        resourceTypeId: rt.id,
        resourceTypeName: rt.name,
        configuredLimit: windowRange,
        explanation: `${rt.name} capacity is only available during ${windowRange}; ${Math.round(demandBeyondWindow)} days of later ${rt.name} demand cannot be scheduled.`,
      })
    }
  }

  // Check 2: Explicit role cap — cap materially limits capacity vs demand
  if (maxCap) {
    for (const rt of input.resourceTypes) {
      const cap = maxCap.get(rt.id)
      if (cap == null) continue

      const weeklyDemand = result.weeklyDemandByResourceType.get(rt.id) ?? []
      let totalDemandDays = 0
      for (let w = 0; w < weeklyDemand.length; w++) {
        const d = weeklyDemand[w] ?? 0
        if (d > EPSILON) {
          totalDemandDays += d
        }
      }

      if (totalDemandDays <= EPSILON) continue

      // Capacity per week at cap: cap * 5 days
      const capacityDaysPerWeek = cap * 5
      const weeksNeeded = totalDemandDays / capacityDaysPerWeek

      // If the plan took longer than the target and the cap materially
      // limits capacity (demand exceeds what cap can deliver in target weeks)
      const weeksAtCap = targetDurationWeeks * capacityDaysPerWeek
      if (totalDemandDays > weeksAtCap * 1.1) {
        diagnostics.push({
          blocker: 'ROLE_MAX_CAP',
          resourceTypeId: rt.id,
          resourceTypeName: rt.name,
          configuredLimit: `${cap}`,
          requested: `>${cap} FTE needed for ${Math.round(totalDemandDays)} days in ${targetDurationWeeks} weeks`,
          achieved: `${cap} FTE (${Math.round(capacityDaysPerWeek)} days/week)`,
          explanation: `${rt.name} is capped at ${cap}; the target requires more capacity (${Math.round(weeksNeeded)} weeks at cap vs ${targetDurationWeeks} week target).`,
        })
      }
    }
  }

  // Check 3: Feature dependency path — features whose start is delayed
  // by predecessors that were still active at the target time
  for (const epic of input.epics) {
    for (const feature of epic.features) {
      const featureStart = result.featureStartWeeks.get(feature.id)
      if (featureStart == null || featureStart <= targetDurationWeeks) continue

      // Feature started AFTER target — check if dependency is the cause
      const deps = feature.dependencies ?? []
      for (const dep of deps) {
        const predStart = result.featureStartWeeks.get(dep.dependsOnId)
        // Compute predecessor completion: last allocation week
        let predCompletion = predStart ?? 0
        const predAllocs = result.weeklyAllocationsByFeature.get(dep.dependsOnId)
        if (predAllocs) {
          for (const w of predAllocs.keys()) {
            if (w > predCompletion) predCompletion = w
          }
        }

        // Predecessor was still active at the target time (started before
        // target but hadn't completed yet) — this is a dependency constraint
        if (predStart != null && predStart < targetDurationWeeks && predCompletion >= targetDurationWeeks) {
          diagnostics.push({
            blocker: 'DEPENDENCY_PATH',
            featureId: feature.id,
            explanation: `Feature ${feature.id} cannot start until predecessor ${dep.dependsOnId} completes; this dependency chain extends beyond the ${targetDurationWeeks}-week target.`,
          })
          break // one dependency diagnostic per feature is enough
        }
      }
    }
  }

  // Check 4: Concurrent epics — if configured limit was actively constraining
  if (maxConcurrentEpics) {
    // Check if any feature was ready but couldn't start due to epic limit
    const epicActiveWeeks = new Map<string, { start: number; end: number }>()
    for (const epic of input.epics) {
      const featureStarts = epic.features
        .map(f => result.featureStartWeeks.get(f.id))
        .filter((w): w is number => w != null)
      const featureEnds = epic.features
        .map(f => {
          const start = result.featureStartWeeks.get(f.id)
          if (start == null) return null
          // Find last allocation week for this epic
          let lastWeek = start
          for (const feature of epic.features) {
            const allocs = result.weeklyAllocationsByFeature.get(feature.id)
            if (allocs) {
              for (const w of allocs.keys()) {
                if (w > lastWeek) lastWeek = w
              }
            }
          }
          return lastWeek
        })
        .filter((w): w is number => w != null)

      if (featureStarts.length > 0 && featureEnds.length > 0) {
        epicActiveWeeks.set(epic.id, {
          start: Math.min(...featureStarts),
          end: Math.max(...featureEnds),
        })
      }
    }

    // Count concurrent active epics during the target window
    let maxConcurrent = 0
    for (let w = 0; w <= targetDurationWeeks; w++) {
      let active = 0
      for (const [, span] of epicActiveWeeks) {
        if (w >= span.start && w <= span.end) active++
      }
      if (active > maxConcurrent) maxConcurrent = active
    }

    if (maxConcurrent >= maxConcurrentEpics) {
      diagnostics.push({
        blocker: 'CONCURRENT_EPICS',
        configuredLimit: `${maxConcurrentEpics}`,
        explanation: `Maximum ${maxConcurrentEpics} concurrent epic(s) was reached during the target window, constraining parallel execution.`,
      })
    }
  }

  // Check 5: Feature parallelism — per-feature cap limiting allocation.
  // Evidence-based: look for features where weekly allocation hit the
  // per-feature cap on any RT while the feature still had unmet demand.
  // The planner uses maxParallelismPerFeature * 5 as the per-feature cap
  // in days/week (5 working days per week).
  const perFeatureCapDays = maxParallelismPerFeature * 5
  for (const epic of input.epics) {
    for (const feature of epic.features) {
      const featureStart = result.featureStartWeeks.get(feature.id)
      if (featureStart == null) continue

      const featureAllocs = result.weeklyAllocationsByFeature.get(feature.id)
      if (!featureAllocs) continue

      // Check if any RT hit the per-feature cap during this feature's window
      let hitCap = false
      for (const [, rtAllocs] of featureAllocs) {
        for (const [, days] of rtAllocs) {
          if (days >= perFeatureCapDays - EPSILON) {
            hitCap = true
            break
          }
        }
        if (hitCap) break
      }
      if (!hitCap) continue

      // Feature was capped — check if it completed after the target
      let lastAllocWeek = featureStart
      for (const w of featureAllocs.keys()) {
        if (w > lastAllocWeek) lastAllocWeek = w
      }
      // If the feature completed after the target, the cap contributed to the miss
      if (lastAllocWeek <= targetDurationWeeks) continue

      diagnostics.push({
        blocker: 'FEATURE_PARALLELISM',
        featureId: feature.id,
        configuredLimit: `${maxParallelismPerFeature}`,
        explanation: `Feature ${feature.id} per-feature parallelism of ${maxParallelismPerFeature} limits simultaneous work; the configured cap prevented faster completion.`,
      })
      break // one diagnostic per feature is enough
    }
  }

  // Check 6: Manual schedule locks — a fixed completion/start constraint can
  // make the target impossible even when the rest of the schedule is feasible.
  // Only diagnose pins whose active feature/story owners are present in the
  // actual input plan and whose schedule evidence is present in the result.
  const activeFeatures = new Map<string, typeof input.epics[number]['features'][number]>()
  const activeStories = new Map<string, {
    featureId: string
    story: typeof input.epics[number]['features'][number]['userStories'][number]
  }>()
  for (const epic of input.epics) {
    for (const feature of epic.features) {
      if (feature.isActive === false) continue
      activeFeatures.set(feature.id, feature)
      for (const story of feature.userStories) {
        if (story.isActive === false) continue
        activeStories.set(story.id, { featureId: feature.id, story })
      }
    }
  }

  for (const pin of input.manualFeatureEntries) {
    const feature = activeFeatures.get(pin.featureId)
    if (!feature) continue

    const fixedEndWeek = pin.startWeek + Math.max(0, pin.durationWeeks)
    if (fixedEndWeek <= targetDurationWeeks + EPSILON) continue
    if (result.featureStartWeeks.get(feature.id) == null) continue

    diagnostics.push({
      blocker: 'SCHEDULE_LOCK',
      featureId: feature.id,
      configuredLimit: `W${pin.startWeek}–W${fixedEndWeek}`,
      explanation: `Feature ${feature.id} is manually pinned to W${pin.startWeek}–W${fixedEndWeek}; its fixed completion is beyond the ${targetDurationWeeks}-week target.`,
    })
  }

  for (const pin of input.manualStoryEntries) {
    const owner = activeStories.get(pin.storyId)
    if (!owner) continue

    const pinnedResourceTypeIds = new Set<string>()
    let totalPinnedDays = 0
    const storyHours = owner.story.tasks.reduce((sum, task) => {
      const taskHpd = task.resourceType?.hoursPerDay ?? input.project.hoursPerDay
      const durationDays = scheduleDurationDays(task.durationDays, task.hoursEffort, taskHpd)
      if (task.resourceTypeId) {
        pinnedResourceTypeIds.add(task.resourceTypeId)
        totalPinnedDays += effortDays(task.hoursEffort, taskHpd)
      }
      return sum + durationDays * taskHpd
    }, 0)
    if (totalPinnedDays <= EPSILON || pinnedResourceTypeIds.size === 0) continue

    const fixedEndWeek = pin.startWeek + Math.max(
      0.2,
      storyHours / input.project.hoursPerDay / 5,
    )
    if (fixedEndWeek <= targetDurationWeeks + EPSILON) continue

    const featureStart = result.featureStartWeeks.get(owner.featureId)
    const featureAllocations = result.weeklyAllocationsByFeature.get(owner.featureId)
    if (featureStart == null || !featureAllocations) continue
    const hasPinnedIntervalEvidence = [...featureAllocations.entries()].some(([week, allocations]) => {
      const overlapsPin = week + 1 > pin.startWeek && week < fixedEndWeek
      if (!overlapsPin) return false
      return [...pinnedResourceTypeIds].some(rtId => (allocations.get(rtId) ?? 0) > EPSILON)
    })
    if (!hasPinnedIntervalEvidence) continue

    diagnostics.push({
      blocker: 'SCHEDULE_LOCK',
      featureId: owner.featureId,
      configuredLimit: `W${pin.startWeek}–W${fixedEndWeek}`,
      explanation: `Story ${pin.storyId} is manually pinned to W${pin.startWeek}–W${fixedEndWeek}; its fixed completion is beyond the ${targetDurationWeeks}-week target.`,
    })
  }

  // Deduplicate diagnostics by (blocker, resourceTypeId, featureId)
  const seen = new Set<string>()
  return diagnostics.filter(d => {
    const key = `${d.blocker}|${d.resourceTypeId ?? ''}|${d.featureId ?? ''}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
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
  /** A manual feature pin fixes the feature's entire automatic window. */
  manualStartWeek?: number
  manualEndWeek?: number
  /** Pinned stories are independent phases, but still block feature dependencies. */
  pinnedStartWeek?: number
  pinnedEndWeek?: number
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
  const manualFeatureById = new Map(input.manualFeatureEntries.map(entry => [entry.featureId, entry]))
  const manualStoryById = new Map(input.manualStoryEntries.map(entry => [entry.storyId, entry]))
  const featureByStoryId = new Map<string, typeof epics[number]['features'][number]>()
  for (const epic of epics) {
    for (const feature of epic.features) {
      for (const story of feature.userStories) featureByStoryId.set(story.id, feature)
    }
  }

  const pinnedStoryIntervals: Array<{
    featureId: string
    storyId: string
    rtId: string
    startWeek: number
    endWeek: number
    days: number
  }> = []
  let latestPinWeek = 0
  for (const [storyId, pin] of manualStoryById) {
    const feature = featureByStoryId.get(storyId)
    if (!feature) continue
    latestPinWeek = Math.max(latestPinWeek, pin.startWeek)
    const story = feature.userStories.find(candidate => candidate.id === storyId)
    if (!story || story.isActive === false) continue
    const totalHours = story.tasks.reduce((sum, task) => {
      const taskHpd = task.resourceType?.hoursPerDay ?? hpd
      return sum + scheduleDurationDays(task.durationDays, task.hoursEffort, taskHpd) * taskHpd
    }, 0)
    const durationWeeks = Math.max(0.2, totalHours / hpd / 5)
    const endWeek = pin.startWeek + durationWeeks
    latestPinWeek = Math.max(latestPinWeek, endWeek)
    for (const task of story.tasks) {
      if (!task.resourceTypeId) continue
      const taskHpd = task.resourceType?.hoursPerDay ?? hpd
      const days = effortDays(task.hoursEffort, taskHpd)
      pinnedStoryIntervals.push({
        featureId: feature.id,
        storyId,
        rtId: task.resourceTypeId,
        startWeek: pin.startWeek,
        endWeek,
        days,
      })
    }
  }

  for (const pin of manualFeatureById.values()) {
    latestPinWeek = Math.max(latestPinWeek, pin.startWeek + Math.max(0, pin.durationWeeks))
  }

  const rtById = new Map(resourceTypes.map(rt => [rt.id, rt]))

  const features: FeatureInfo[] = []
  const featureMap = new Map<string, FeatureInfo>()
  const featuresByEpic = new Map<string, FeatureInfo[]>()
  const epicById = new Map(epics.map(epic => [epic.id, epic]))

  // effectiveRtCount is used only for per-feature parallelism caps.
  // Blank/unrestricted maxCap must NOT cap overall planning capacity.
  const effectiveRtCount = new Map<string, number>()
  for (const rt of resourceTypes) {
    const capCount = maxCap?.get(rt.id)
    // When no explicit cap, effective count = rt.count (no hidden limit).
    // When explicit cap < count, clamp to cap. When cap > count (Starting
    // Team Finder), allow the higher count for per-feature parallelism.
    effectiveRtCount.set(rt.id, capCount != null
      ? Math.max(0, Math.min(rt.count, capCount))
      : Math.max(0, rt.count))
  }

  for (const epic of epics) {
    const epicFeatures: FeatureInfo[] = []

    for (const feature of epic.features) {
      const totalDaysByRt = new Map<string, number>()

      for (const story of feature.userStories) {
        if (story.isActive === false || manualStoryById.has(story.id)) continue
        for (const task of story.tasks) {
          if (!task.resourceTypeId) continue
          const rtHpd = task.resourceType?.hoursPerDay ?? hpd
          const days = effortDays(task.hoursEffort, rtHpd)
          totalDaysByRt.set(task.resourceTypeId, (totalDaysByRt.get(task.resourceTypeId) ?? 0) + days)
        }
      }

      const manualFeature = manualFeatureById.get(feature.id)
      const featurePins = pinnedStoryIntervals.filter(pin => pin.featureId === feature.id)
      const pinnedStartWeek = featurePins.length > 0
        ? Math.min(...featurePins.map(pin => pin.startWeek))
        : undefined
      const pinnedEndWeek = featurePins.length > 0
        ? Math.max(...featurePins.map(pin => pin.endWeek))
        : undefined
      const info: FeatureInfo = {
        id: feature.id,
        epicId: epic.id,
        epicOrder: epic.order,
        featureOrder: feature.order,
        remainingDaysByRt: new Map(totalDaysByRt),
        totalDaysByRt,
        predecessors: new Set(),
        hasDemand: totalDaysByRt.size > 0,
        manualStartWeek: manualFeature?.startWeek,
        manualEndWeek: manualFeature
          ? manualFeature.startWeek + Math.max(0, manualFeature.durationWeeks)
          : undefined,
        pinnedStartWeek,
        pinnedEndWeek,
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
      const capCount = maxCap?.get(rtId)
      // Per-feature parallelism cap: use maxCap when explicit (Starting Team
      // Finder or user-configured), else maxParallelismPerFeature.
      // Blank maxCap must not artificially limit per-feature allocation.
      const allowedPeople = capCount != null
        ? Math.min(maxParallelismPerFeature, capCount)
        : maxParallelismPerFeature
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

    // Only scale down when an explicit cap is LOWER than the count.
    // Blank/unrestricted maxCap must NOT reduce capacity below what
    // getWeeklyCapacity provides. When cap > count (Starting Team Finder),
    // the higher capacity is already reflected in getWeeklyCapacity's
    // phantom slots (count-based) or roleSegments (profile-based).
    const capCount = maxCap?.get(rt.id)
    if (capCount != null && capCount < rt.count && rt.count > 0) {
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
    Math.ceil(latestPinWeek) + features.length + 12,
  )

  let completedFeatureCount = 0
  let lastAllocationWeek = -1

  function scheduleLock(featureId: string | undefined, explanation: string): PlannerDiagnostic {
    return { blocker: 'SCHEDULE_LOCK', featureId, explanation }
  }
  function assertPinnedStoryDependencies(feature: FeatureInfo): void {
    const pinnedStart = feature.pinnedStartWeek
    if (pinnedStart === undefined) return

    for (const predId of feature.predecessors) {
      const predecessor = featureMap.get(predId)
      if (!predecessor || predecessor.completedWeek === undefined || predecessor.completedWeek >= pinnedStart - EPSILON) {
        throw new SAPlannerInfeasibleError(
          `Manual story lock for feature ${feature.id} conflicts with its dependencies`,
          [scheduleLock(
            feature.id,
            `Manual story work for feature ${feature.id} is pinned to W${pinnedStart}, but its predecessor chain does not complete before that locked start.`,
          )],
        )
      }
    }
  }

  function isFeatureComplete(feature: FeatureInfo): boolean {
    for (const remaining of feature.remainingDaysByRt.values()) {
      if (remaining > EPSILON) return false
    }
    return true
  }

  function isFeatureReady(feature: FeatureInfo, week: number): boolean {
    if (feature.completedWeek !== undefined) return false
    if (feature.manualStartWeek !== undefined && feature.manualEndWeek !== undefined) {
      const overlapsLock = Math.min(week + 1, feature.manualEndWeek)
        - Math.max(week, feature.manualStartWeek)
      if (overlapsLock <= EPSILON) return false
      // A manual feature pin may begin part-way through a scheduler week, but
      // it must not be silently shifted to a later whole week.
      if (feature.startedWeek === undefined && week > Math.floor(feature.manualStartWeek)) return false
    }
    for (const predId of feature.predecessors) {
      const pred = featureMap.get(predId)
      if (!pred || pred.completedWeek === undefined || pred.completedWeek >= week) return false
    }
    return true
  }

  function getFeatureWindowOverlap(feature: FeatureInfo, week: number): number {
    if (feature.manualStartWeek === undefined || feature.manualEndWeek === undefined) return 1
    return Math.max(
      0,
      Math.min(week + 1, feature.manualEndWeek) - Math.max(week, feature.manualStartWeek),
    )
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
    if (capCount != null && capCount < rt.count && rt.count > 0) {
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

  const pinnedDemandByRtWeek = new Map<string, number>()
  for (const interval of pinnedStoryIntervals) {
    const rt = rtById.get(interval.rtId)
    if (!rt) {
      throw new SAPlannerInfeasibleError(
        `Manual story ${interval.storyId} references unknown resource type ${interval.rtId}`,
        [scheduleLock(interval.featureId, `Manual story ${interval.storyId} cannot be placed because resource type ${interval.rtId} is unavailable.`)],
      )
    }
    const startWeek = Math.floor(interval.startWeek)
    const endWeek = Math.ceil(interval.endWeek)
    for (let week = startWeek; week < endWeek; week++) {
      const overlap = Math.min(week + 1, interval.endWeek) - Math.max(week, interval.startWeek)
      if (overlap <= EPSILON) continue
      const days = interval.days * overlap / (interval.endWeek - interval.startWeek)
      const key = `${interval.rtId}|${week}`
      pinnedDemandByRtWeek.set(key, (pinnedDemandByRtWeek.get(key) ?? 0) + days)
      recordAllocation(featureMap.get(interval.featureId)!, interval.rtId, week, days)
      lastAllocationWeek = Math.max(lastAllocationWeek, week)
    }
  }

  for (const rt of resourceTypes) {
    for (let week = 0; week < MAX_WEEKS; week++) {
      const pinnedDays = pinnedDemandByRtWeek.get(`${rt.id}|${week}`) ?? 0
      if (pinnedDays <= EPSILON) continue
      const capacityDays = getWeeklyCapacityDays(rt, week)
      if (pinnedDays > capacityDays + EPSILON) {
        throw new SAPlannerInfeasibleError(
          `Manual schedule locks exceed ${rt.name} capacity in week ${week}`,
          [scheduleLock(
            undefined,
            `${rt.name} has ${capacityDays.toFixed(2)} available days in week ${week}, but manual story locks require ${pinnedDays.toFixed(2)} days.`,
          )],
        )
      }
    }
  }

  for (const feature of features) {
    if (feature.manualStartWeek === undefined || feature.manualEndWeek === undefined) continue
    const featurePins = pinnedStoryIntervals.filter(pin => pin.featureId === feature.id)
    if (feature.manualEndWeek <= feature.manualStartWeek && feature.hasDemand) {
      throw new SAPlannerInfeasibleError(
        `Manual feature lock for ${feature.id} has no usable duration`,
        [scheduleLock(feature.id, `Feature ${feature.id} is pinned to an empty window (${feature.manualStartWeek}–${feature.manualEndWeek}).`)],
      )
    }
    for (const pin of featurePins) {
      if (pin.startWeek < feature.manualStartWeek - EPSILON || pin.endWeek > feature.manualEndWeek + EPSILON) {
        throw new SAPlannerInfeasibleError(
          `Manual feature and story locks conflict for ${feature.id}`,
          [scheduleLock(feature.id, `Story ${pin.storyId} is pinned to W${pin.startWeek}–W${pin.endWeek}, outside feature lock W${feature.manualStartWeek}–W${feature.manualEndWeek}.`)],
        )
      }
    }
  }

  for (let week = 0; week < MAX_WEEKS && completedFeatureCount < features.length; week++) {
    const readyFeatures = features
      .filter(feature => isFeatureReady(feature, week) && canStartFeature(feature))
      .sort(compareFeatures)

    if (readyFeatures.length === 0) continue

    for (const feature of readyFeatures) {
      const wasStarted = feature.startedWeek !== undefined
      if (wasStarted || feature.hasDemand) continue
      assertPinnedStoryDependencies(feature)
      feature.startedWeek = feature.manualStartWeek ?? feature.pinnedStartWeek ?? week
      const lockedEnd = feature.manualEndWeek ?? feature.pinnedEndWeek
      feature.completedWeek = lockedEnd !== undefined
        ? lockedEnd - EPSILON
        : feature.startedWeek
      completedFeatureCount++
      lastAllocationWeek = Math.max(lastAllocationWeek, Math.ceil(feature.completedWeek) - 1)
    }

    for (const rt of resourceTypes) {
      let availableCapacity = getWeeklyCapacityDays(rt, week)
      availableCapacity -= pinnedDemandByRtWeek.get(`${rt.id}|${week}`) ?? 0
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
        const lockRemainingWeeks = feature.manualEndWeek !== undefined
          ? Math.max(1, feature.manualEndWeek - week)
          : undefined
        const pacingWeeks = lockRemainingWeeks ?? (week < targetDurationWeeks
          ? Math.max(1, Math.min(weeksLeftToTarget, featureRemainingWeeks))
          : 1)
        const smoothedTarget = Math.min(perFeatureCap, remaining / pacingWeeks)
        const windowOverlap = getFeatureWindowOverlap(feature, week)
        const windowCapacity = getWeeklyCapacityDays(rt, week) * windowOverlap
        const featureCapacity = windowOverlap < 1 - EPSILON
          ? Math.min(availableCapacity, windowCapacity)
          : availableCapacity

        const allocation = Math.min(featureCapacity, smoothedTarget)
        if (allocation <= EPSILON) continue

        baselineAllocations.set(feature.id, allocation)
        availableCapacity -= allocation
      }

      // Continuity-aware pacing deliberately avoids spending all spare RT
      // capacity whenever multiple features compete for the same role. This
      // keeps smaller role slices on long-running features from disappearing
      // early while the feature remains active. We still top up when there is
      // only one ready candidate so blockers can clear quickly. Manual feature
      // locks are paced across their exact persisted duration instead.
      if (availableCapacity > EPSILON && candidates.length === 1 && candidates[0]?.manualEndWeek === undefined) {
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

        if (feature.startedWeek === undefined) {
          assertPinnedStoryDependencies(feature)
          feature.startedWeek = feature.manualStartWeek ?? week
        }

        recordAllocation(feature, rt.id, week, allocation)
        lastAllocationWeek = Math.max(lastAllocationWeek, week)
      }
    }

    for (const feature of readyFeatures) {
      if (feature.completedWeek !== undefined) continue
      if (!isFeatureComplete(feature)) continue

      if (feature.startedWeek === undefined) feature.startedWeek = week
      const lockEnd = Math.max(
        feature.manualEndWeek ?? 0,
        feature.pinnedEndWeek ?? 0,
      )
      feature.completedWeek = lockEnd > 0
        ? Math.max(week, lockEnd - EPSILON)
        : week
      completedFeatureCount++
    }
  }

  const diagnostics: PlannerDiagnostic[] = []

  for (const feature of features) {
    if (feature.completedWeek !== undefined) continue
    if (!isFeatureComplete(feature)) {
      collectInfeasibilityDiagnostics(feature, diagnostics)
      throw new SAPlannerInfeasibleError(
        `Fractional planner could not finish feature ${feature.id} within ${MAX_WEEKS} weeks`,
        diagnostics,
      )
    }

    const fallbackWeek = feature.startedWeek ?? 0
    feature.startedWeek = fallbackWeek
    feature.completedWeek = fallbackWeek
    completedFeatureCount++
  }

  function collectInfeasibilityDiagnostics(failedFeature: FeatureInfo, diags: PlannerDiagnostic[]) {
    if (failedFeature.manualStartWeek !== undefined) {
      diags.push(scheduleLock(
        failedFeature.id,
        `Feature ${failedFeature.id} is pinned to W${failedFeature.manualStartWeek}–W${failedFeature.manualEndWeek}; its effort and dependencies cannot be satisfied inside that locked window.`,
      ))
      return
    }
    // A pinned story reserves its exact interval; if automatic work remains
    // impossible, surface the lock rather than pretending it was movable.
    if (failedFeature.pinnedStartWeek !== undefined && failedFeature.pinnedEndWeek !== undefined) {
      diags.push(scheduleLock(
        failedFeature.id,
        `Manual story work for feature ${failedFeature.id} is locked to W${failedFeature.pinnedStartWeek}–W${failedFeature.pinnedEndWeek}; remaining work cannot be placed by moving that lock.`,
      ))
    }
    // Check 1: Zero capacity for a role with demand in any week
    for (const [rtId, totalDays] of failedFeature.totalDaysByRt) {
      if (totalDays <= EPSILON) continue
      const rt = rtById.get(rtId)
      if (!rt) continue

      let hasZeroCapacityWeek = false
      let hasSomeCapacity = false
      for (let w = 0; w < MAX_WEEKS; w++) {
        const cap = getWeeklyCapacityDays(rt, w)
        if (cap > EPSILON) {
          hasSomeCapacity = true
        } else if (w === 0 || hasSomeCapacity) {
          hasZeroCapacityWeek = true
        }
      }

      if (hasZeroCapacityWeek && hasSomeCapacity) {
        diags.push({
          blocker: 'PROFILE_WINDOW',
          resourceTypeId: rtId,
          resourceTypeName: rt.name,
          featureId: failedFeature.id,
          explanation: `${rt.name} capacity is only available during certain weeks; later ${rt.name} work cannot be scheduled.`,
        })
      } else if (!hasSomeCapacity) {
        const capCount = maxCap?.get(rtId)
        if (capCount != null && capCount < rt.count) {
          diags.push({
            blocker: 'ROLE_MAX_CAP',
            resourceTypeId: rtId,
            resourceTypeName: rt.name,
            featureId: failedFeature.id,
            configuredLimit: `${capCount}`,
            requested: `>${capCount}`,
            achieved: `${capCount}`,
            explanation: `${rt.name} is capped at ${capCount}; the target requires more capacity.`,
          })
        } else {
          diags.push({
            blocker: 'PROFILE_WINDOW',
            resourceTypeId: rtId,
            resourceTypeName: rt.name,
            featureId: failedFeature.id,
            explanation: `${rt.name} has no available capacity in any week.`,
          })
        }
      }
    }

    // Check 2: Dependency / critical path
    const unmetPredecessors = [...failedFeature.predecessors].filter(predId => {
      const pred = featureMap.get(predId)
      return pred && pred.completedWeek === undefined
    })
    if (unmetPredecessors.length > 0 && failedFeature.startedWeek === undefined) {
      diags.push({
        blocker: 'DEPENDENCY_PATH',
        featureId: failedFeature.id,
        explanation: `Feature ${failedFeature.id} cannot start until its dependency chain completes; additional staffing cannot shorten this path.`,
      })
    }

    // Check 3: Max concurrent epics
    if (maxConcurrentEpics && !canStartFeature(failedFeature)) {
      diags.push({
        blocker: 'CONCURRENT_EPICS',
        featureId: failedFeature.id,
        configuredLimit: `${maxConcurrentEpics}`,
        explanation: `Maximum ${maxConcurrentEpics} concurrent epic(s) reached; feature cannot start until another epic completes.`,
      })
    }

    // Check 4: Feature parallelism
    if (failedFeature.startedWeek !== undefined) {
      let allRtsCapped = true
      for (const [rtId] of failedFeature.remainingDaysByRt) {
        const capCount = maxCap?.get(rtId)
        const rt = rtById.get(rtId)
        if (capCount == null || !rt || capCount >= rt.count) {
          allRtsCapped = false
          break
        }
      }
      if (allRtsCapped && failedFeature.totalDaysByRt.size > 0) {
        diags.push({
          blocker: 'FEATURE_PARALLELISM',
          featureId: failedFeature.id,
          explanation: `Feature parallelism or resource cap limits prevent finishing ${failedFeature.id} within the target.`,
        })
      }
    }

    if (diags.length === 0) {
      diags.push({
        blocker: 'CONSTRAINT',
        featureId: failedFeature.id,
        explanation: `Scheduling constraints prevent completing feature ${failedFeature.id} within ${MAX_WEEKS} weeks.`,
      })
    }
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
    diagnostics: diagnostics.length > 0 ? diagnostics : undefined,
  }
}
