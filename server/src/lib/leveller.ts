/**
 * leveller.ts — Greedy resource-levelling algorithm for the Monrad Estimator.
 *
 * Pure function: no I/O, no Prisma, no side effects.
 * Takes a SchedulerInput and returns proposed epic + feature start weeks that
 * spread demand across time, respecting epic and feature dependencies.
 *
 * Phase 4: stagger individual features (not just epics), filling resource
 * gaps by interleaving features across parallel-mode epics.
 */

import {
  runScheduler,
  getWeeklyCapacity,
  type SchedulerInput,
  type SchedulerResourceType,
} from './scheduler.js'

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface LevellingResult {
  /** epicId → proposed startWeek */
  epicStartWeeks: Map<string, number>
  /** featureId → proposed startWeek */
  featureStartWeeks: Map<string, number>
  totalDeliveryWeeks: number
  peakUtilisationPct: number
}

// ─────────────────────────────────────────────────────────────────────────────
// Main entry point
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Greedy bin-packing leveller — feature-level placement.
 *
 * 1. Runs the scheduler (resourceLevel: false) to get feature durations.
 * 2. Computes per-feature demand profiles (demandDaysPerWeek per RT).
 * 3. Builds feature-level dependency graph (explicit deps, epic deps,
 *    sequential intra-epic chains).
 * 4. Topological sort features (Kahn's).
 * 5. Greedily places each feature at the earliest week that fits within
 *    RT capacity constraints.
 * 6. Derives epic start weeks as min of contained feature start weeks.
 */
export function levelEpicStarts(input: SchedulerInput): LevellingResult {
  const { project, epics, resourceTypes, epicDeps } = input
  const hpd = project.hoursPerDay

  // ── Step 1: Run scheduler to get baseline feature durations ─────────────
  const output = runScheduler({ ...input, resourceLevel: false })
  const { featureSchedule } = output

  // Build feature duration map.
  // For features in parallel epics, compute raw (un-inflated) durations
  // since the leveller handles capacity itself via greedy placement.
  // For sequential epics, use the scheduler's durations (which don't inflate).
  const rtCountMap = new Map(resourceTypes.map(rt => [rt.id, rt.count]))
  const featureDurations = new Map<string, number>()
  const parallelEpicIds = new Set(epics.filter(e => e.featureMode === 'parallel').map(e => e.id))

  for (const fs of featureSchedule) {
    featureDurations.set(fs.featureId, fs.durationWeeks)
  }

  // Recompute raw durations for features in parallel epics
  // (the scheduler inflates them via parallelEpicMinSpan floor, which we don't want)
  for (const epic of epics) {
    if (!parallelEpicIds.has(epic.id)) continue
    for (const feature of epic.features) {
      const allTasks = feature.userStories
        .filter(s => s.isActive !== false)
        .flatMap(s => s.tasks)
      if (allTasks.length === 0) {
        featureDurations.set(feature.id, 1)
        continue
      }
      // Max days across RTs (same logic as scheduler's featureDurationWeeks minus the floor)
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
      featureDurations.set(feature.id, Math.max(0.2, maxDays / 5))
    }
  }

  // ── Step 2: Compute per-feature demand rates (days/week per RT) ─────────
  const featureDemandRates = new Map<string, Map<string, number>>()

  for (const epic of epics) {
    for (const feature of epic.features) {
      const dur = featureDurations.get(feature.id) ?? 1
      const demandByRt = new Map<string, number>()

      for (const story of feature.userStories) {
        if (story.isActive === false) continue
        for (const task of story.tasks) {
          if (!task.resourceTypeId) continue
          const rtHpd = task.resourceType?.hoursPerDay ?? hpd
          const demandDays = task.durationDays ?? (task.hoursEffort / rtHpd)
          demandByRt.set(
            task.resourceTypeId,
            (demandByRt.get(task.resourceTypeId) ?? 0) + demandDays,
          )
        }
      }

      // Convert total demand to rate (days/week)
      const rateByRt = new Map<string, number>()
      for (const [rtId, totalDemand] of demandByRt) {
        rateByRt.set(rtId, totalDemand / dur)
      }
      featureDemandRates.set(feature.id, rateByRt)
    }
  }

  // ── Step 3: Build feature-level dependency graph ────────────────────────
  const epicById = new Map(epics.map(e => [e.id, e]))
  const featureEpicMap = new Map<string, string>() // featureId → epicId
  const allFeatureIds: string[] = []
  const featureOrderKey = new Map<string, number>() // for topo tie-break

  for (const epic of epics) {
    for (const feature of epic.features) {
      allFeatureIds.push(feature.id)
      featureEpicMap.set(feature.id, epic.id)
      // Round-robin tie-break: interleave features across epics by processing
      // feature[0] from all epics first, then feature[1], etc.
      featureOrderKey.set(feature.id, feature.order * 100000 + epic.order)
    }
  }

  const predecessors = new Map<string, Set<string>>()
  const successors = new Map<string, Set<string>>()
  const inDegree = new Map<string, number>()

  for (const fId of allFeatureIds) {
    predecessors.set(fId, new Set())
    successors.set(fId, new Set())
    inDegree.set(fId, 0)
  }

  function addEdge(fromId: string, toId: string) {
    if (fromId === toId) return
    const preds = predecessors.get(toId)
    const succs = successors.get(fromId)
    if (!preds || !succs) return
    if (preds.has(fromId)) return // already exists
    preds.add(fromId)
    succs.add(toId)
    inDegree.set(toId, (inDegree.get(toId) ?? 0) + 1)
  }

  // 3a. Explicit feature dependencies
  for (const epic of epics) {
    for (const feature of epic.features) {
      for (const dep of feature.dependencies ?? []) {
        addEdge(dep.dependsOnId, dep.featureId)
      }
    }
  }

  // 3b. Epic dependencies → all features in dependent epic depend on all features in predecessor
  for (const dep of epicDeps) {
    const fromEpic = epicById.get(dep.dependsOnId)
    const toEpic = epicById.get(dep.epicId)
    if (!fromEpic || !toEpic) continue
    for (const fromFeature of fromEpic.features) {
      for (const toFeature of toEpic.features) {
        addEdge(fromFeature.id, toFeature.id)
      }
    }
  }

  // 3c. Sequential intra-epic edges (only for sequential-mode epics)
  for (const epic of epics) {
    if ((epic.featureMode ?? 'sequential') !== 'sequential') continue
    const sorted = [...epic.features].sort((a, b) => a.order - b.order)
    for (let i = 1; i < sorted.length; i++) {
      addEdge(sorted[i - 1].id, sorted[i].id)
    }
  }
  // 3d. NO intra-epic edges for parallel-mode epics

  // ── Step 4: Topological sort (Kahn's with tie-break) ────────────────────
  const topoOrder: string[] = []
  const queue: string[] = []

  for (const fId of allFeatureIds) {
    if ((inDegree.get(fId) ?? 0) === 0) queue.push(fId)
  }
  queue.sort((a, b) => (featureOrderKey.get(a) ?? 0) - (featureOrderKey.get(b) ?? 0))

  while (queue.length > 0) {
    const fId = queue.shift()!
    topoOrder.push(fId)

    for (const succId of successors.get(fId) ?? []) {
      const newDeg = (inDegree.get(succId) ?? 1) - 1
      inDegree.set(succId, newDeg)
      if (newDeg === 0) queue.push(succId)
    }
    // Re-sort after adding new entries for deterministic output
    queue.sort((a, b) => (featureOrderKey.get(a) ?? 0) - (featureOrderKey.get(b) ?? 0))
  }

  // Fallback: features not processed (cycles) appended by order
  const processedSet = new Set(topoOrder)
  for (const fId of allFeatureIds) {
    if (!processedSet.has(fId)) topoOrder.push(fId)
  }

  // ── Step 5: Greedy placement ────────────────────────────────────────────
  // Only the BOTTLENECK RT (the one that drives feature duration) constrains
  // placement. Non-bottleneck RTs are tracked for utilisation metrics but
  // don't block placement — this eliminates dead zones where secondary
  // resources have no work while the primary resource is saturated.
  const rtById = new Map(resourceTypes.map(rt => [rt.id, rt]))
  const featureStartWeeks = new Map<string, number>()
  const featureFinishWeeks = new Map<string, number>()
  const utilisedDays = new Map<string, number>() // key: `${rtId}|${week}`

  const MAX_SEARCH = 200

  // Precompute: for each feature, identify the bottleneck RT(s).
  // Bottleneck = RT with highest (totalDemand / weeklyCapacity), i.e. the one
  // that requires the most weeks at full utilisation. We allow a small tolerance
  // so near-bottleneck RTs also constrain (within 20% of the longest).
  const featureBottleneckRts = new Map<string, Set<string>>()
  for (const epic of epics) {
    for (const feature of epic.features) {
      const demandByRt = new Map<string, number>()
      for (const story of feature.userStories) {
        if (story.isActive === false) continue
        for (const task of story.tasks) {
          if (!task.resourceTypeId) continue
          const rtHpd = task.resourceType?.hoursPerDay ?? hpd
          const demandDays = task.durationDays ?? (task.hoursEffort / rtHpd)
          demandByRt.set(task.resourceTypeId, (demandByRt.get(task.resourceTypeId) ?? 0) + demandDays)
        }
      }
      // Compute weeks-to-complete for each RT (at full capacity)
      let maxWeeks = 0
      const rtWeeks = new Map<string, number>()
      for (const [rtId, totalDemand] of demandByRt) {
        const rt = rtById.get(rtId)
        if (!rt) continue
        const capacityDaysPerWeek = getWeeklyCapacity(rt, 0, hpd) / (rt.hoursPerDay ?? hpd)
        const weeks = capacityDaysPerWeek > 0 ? totalDemand / capacityDaysPerWeek : Infinity
        rtWeeks.set(rtId, weeks)
        if (weeks > maxWeeks) maxWeeks = weeks
      }
      // Bottleneck = within 20% of the longest RT
      const threshold = maxWeeks * 0.8
      const bottlenecks = new Set<string>()
      for (const [rtId, weeks] of rtWeeks) {
        if (weeks >= threshold) bottlenecks.add(rtId)
      }
      featureBottleneckRts.set(feature.id, bottlenecks)
    }
  }

  // Precompute RT capacity in days for quick lookup
  const rtCapacityDays = new Map<string, number>()
  for (const rt of resourceTypes) {
    rtCapacityDays.set(rt.id, getWeeklyCapacity(rt, 0, hpd) / (rt.hoursPerDay ?? hpd))
  }

  // Best-fit window: among feasible weeks within this window from the earliest
  // feasible slot, pick the one that best fills under-utilised resource gaps.
  const BEST_FIT_WINDOW = 12

  for (const featureId of topoOrder) {
    const dur = featureDurations.get(featureId) ?? 1
    const demandRates = featureDemandRates.get(featureId) ?? new Map()
    const bottlenecks = featureBottleneckRts.get(featureId) ?? new Set(demandRates.keys())
    const ceilDur = Math.ceil(dur)

    // Min start = max finish of all predecessors
    let minStart = 0
    for (const predId of predecessors.get(featureId) ?? []) {
      const predFinish = featureFinishWeeks.get(predId) ?? 0
      if (predFinish > minStart) minStart = predFinish
    }
    minStart = Math.ceil(minStart)

    // Helper: check if a week slot is feasible (bottleneck RTs have capacity)
    function isFeasible(week: number): boolean {
      for (let w = week; w < week + ceilDur; w++) {
        for (const [rtId, demandRate] of demandRates) {
          if (!bottlenecks.has(rtId)) continue
          const rt = rtById.get(rtId) as SchedulerResourceType | undefined
          if (!rt) continue
          const key = `${rtId}|${w}`
          const alreadyUsed = utilisedDays.get(key) ?? 0
          const capacityDays = rtCapacityDays.get(rtId) ?? 0
          if (alreadyUsed + demandRate > capacityDays + 1e-9) return false
        }
      }
      return true
    }

    // Helper: score a week — how much existing demand exists for this feature's
    // RTs in the weeks it would occupy. Higher = better gap-fill.
    // We want to place where our secondary resources already have work,
    // i.e. avoid placing into dead zones.
    function gapFillScore(week: number): number {
      let score = 0
      for (let w = week; w < week + ceilDur; w++) {
        for (const [rtId] of demandRates) {
          if (bottlenecks.has(rtId)) continue // skip bottleneck (already constrained)
          const key = `${rtId}|${w}`
          const existing = utilisedDays.get(key) ?? 0
          // Score: prefer weeks where this RT already has demand (filling, not creating new islands)
          score += existing
        }
      }
      return score
    }

    // Find feasible candidates within BEST_FIT_WINDOW of the first feasible slot
    let firstFeasible: number | null = null
    const candidates: Array<{ week: number; score: number }> = []

    for (let week = minStart; week <= minStart + MAX_SEARCH; week++) {
      if (!isFeasible(week)) continue

      if (firstFeasible === null) firstFeasible = week

      // Only consider candidates within the window from first feasible
      if (week > firstFeasible + BEST_FIT_WINDOW) break

      candidates.push({ week, score: gapFillScore(week) })
    }

    // Pick best candidate (highest gap-fill score; tie-break: earliest week)
    let placedAt: number
    if (candidates.length > 0) {
      candidates.sort((a, b) => b.score - a.score || a.week - b.week)
      placedAt = candidates[0].week
    } else {
      placedAt = minStart // fallback
    }

    featureStartWeeks.set(featureId, placedAt)
    featureFinishWeeks.set(featureId, placedAt + dur)

    // Update utilisation grid for ALL RTs
    for (let w = placedAt; w < placedAt + ceilDur; w++) {
      for (const [rtId, demandRate] of demandRates) {
        const key = `${rtId}|${w}`
        utilisedDays.set(key, (utilisedDays.get(key) ?? 0) + demandRate)
      }
    }
  }

  // ── Step 6: Derive epic start weeks ─────────────────────────────────────
  const epicStartWeeks = new Map<string, number>()
  for (const epic of epics) {
    let minW = Infinity
    for (const f of epic.features) {
      const fw = featureStartWeeks.get(f.id)
      if (fw !== undefined && fw < minW) minW = fw
    }
    epicStartWeeks.set(epic.id, minW === Infinity ? 0 : minW)
  }

  // ── Step 7: Compute metrics ─────────────────────────────────────────────
  const totalDeliveryWeeks =
    featureFinishWeeks.size > 0 ? Math.max(...featureFinishWeeks.values()) : 0

  // Peak utilisation: max over all (rtId, week) of utilised / capacity
  let peakUtilisationPct = 0
  for (const [key, used] of utilisedDays) {
    const separatorIdx = key.lastIndexOf('|')
    const rtId = key.substring(0, separatorIdx)
    const week = parseInt(key.substring(separatorIdx + 1), 10)
    const rt = rtById.get(rtId)
    if (!rt) continue
    const capacityDays = getWeeklyCapacity(rt, week, hpd) / (rt.hoursPerDay ?? hpd)
    if (capacityDays > 0) {
      const pct = (used / capacityDays) * 100
      if (pct > peakUtilisationPct) peakUtilisationPct = pct
    }
  }

  return {
    epicStartWeeks,
    featureStartWeeks,
    totalDeliveryWeeks,
    peakUtilisationPct: Math.round(peakUtilisationPct * 10) / 10,
  }
}
