/**
 * sa-planner.ts — Resource-Constrained Priority Scheduler (RCPS).
 *
 * Schedules features into available capacity without exceeding it,
 * like manually filling an Excel resource calendar. Features are
 * placed in epic-priority order (by epic.order, then feature.order),
 * each slotted into the earliest week where capacity is available
 * across all required resource types.
 *
 * An optional SA compression pass tries to pull features earlier
 * to minimise total delivery weeks while maintaining feasibility.
 *
 * Pure function: no I/O, no Prisma, no side effects.
 */

import {
  getWeeklyCapacity,
  type SchedulerInput,
} from './scheduler.js'

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
  /** Number of SA iterations. Default 5000. */
  iterations?: number
  /** Initial temperature. Default 100. */
  initialTemp?: number
  /** Cooling rate (0-1). Default 0.995. */
  coolingRate?: number

  // Fitness weights (all default to 1.0)
  /** Weight for resource utilisation variance penalty */
  weightUtilVariance?: number
  /** Weight for over-allocation penalty (exceeding RT capacity) */
  weightOverAllocation?: number
  /** Weight for duration exceeding target */
  weightDurationPenalty?: number
  /** Weight for idle gaps (weeks with 0 demand for an active RT) */
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
}

// ─── Internal types ──────────────────────────────────────────────────────────

interface FeatureInfo {
  id: string
  epicId: string
  durationWeeks: number
  demandRates: Map<string, number> // rtId → days/week demand
  predecessors: Set<string>        // featureId predecessors
}

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

  // ── Precompute data structures ──────────────────────────────────────────

  const rtById = new Map(resourceTypes.map(rt => [rt.id, rt]))
  const features: FeatureInfo[] = []
  const featureMap = new Map<string, FeatureInfo>()
  const epicFeatures = new Map<string, string[]>() // epicId → featureIds

  // Compute feature durations with parallelism cap
  for (const epic of epics) {
    const fIds: string[] = []
    for (const feature of epic.features) {
      fIds.push(feature.id)

      // Compute demand per RT
      const demandByRt = new Map<string, number>()
      for (const story of feature.userStories) {
        if (story.isActive === false) continue
        for (const task of story.tasks) {
          if (!task.resourceTypeId) continue
          const rtHpd = task.resourceType?.hoursPerDay ?? hpd
          const days = task.durationDays ?? (task.hoursEffort / rtHpd)
          demandByRt.set(task.resourceTypeId, (demandByRt.get(task.resourceTypeId) ?? 0) + days)
        }
      }

      // Duration = max across RTs of (totalDays / min(count, maxParallelism) / 5)
      let maxWeeks = 0.2
      for (const [rtId, totalDays] of demandByRt) {
        const rt = rtById.get(rtId)
        if (!rt) continue
        const parallelism = Math.min(rt.count, maxParallelismPerFeature)
        const weeks = totalDays / parallelism / 5
        if (weeks > maxWeeks) maxWeeks = weeks
      }
      const durationWeeks = Math.max(1, Math.ceil(maxWeeks))

      // Demand rates = totalDays / durationWeeks per RT
      const demandRates = new Map<string, number>()
      for (const [rtId, totalDays] of demandByRt) {
        demandRates.set(rtId, totalDays / durationWeeks)
      }

      const info: FeatureInfo = {
        id: feature.id,
        epicId: epic.id,
        durationWeeks,
        demandRates,
        predecessors: new Set(),
      }
      features.push(info)
      featureMap.set(feature.id, info)
    }
    epicFeatures.set(epic.id, fIds)
  }

  // Build dependency graph
  const epicById = new Map(epics.map(e => [e.id, e]))

  // Explicit feature deps
  for (const epic of epics) {
    for (const feature of epic.features) {
      for (const dep of feature.dependencies ?? []) {
        const info = featureMap.get(feature.id)
        if (info) info.predecessors.add(dep.dependsOnId)
      }
    }
  }

  // Epic deps → all features in dependent epic depend on all in predecessor
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

  // Sequential intra-epic deps
  for (const epic of epics) {
    if ((epic.featureMode ?? 'sequential') !== 'sequential') continue
    const sorted = [...epic.features].sort((a, b) => a.order - b.order)
    for (let i = 1; i < sorted.length; i++) {
      const info = featureMap.get(sorted[i].id)
      if (info) info.predecessors.add(sorted[i - 1].id)
    }
  }

  // RT capacity per week (days) — use max across all project weeks
  const rtCapacity = new Map<string, number>()
  for (const rt of resourceTypes) {
    let maxCap2 = 0
    for (let w = 0; w < targetDurationWeeks; w++) {
      const capW = getWeeklyCapacity(rt, w, hpd) / (rt.hoursPerDay ?? hpd)
      if (capW > maxCap2) maxCap2 = capW
    }
    // Fallback: count × 5 days/week if still 0
    if (maxCap2 === 0) maxCap2 = rt.count * 5
    // Apply maxCap if set
    const maxCount = maxCap?.get(rt.id)
    if (maxCount != null) {
      const perPerson = maxCap2 / rt.count
      rtCapacity.set(rt.id, perPerson * Math.min(rt.count, maxCount))
    } else {
      rtCapacity.set(rt.id, maxCap2)
    }
  }

  // ── Resource-Constrained Priority Scheduler ─────────────────────────────

  const MAX_WEEKS = 300 // safety bound

  /**
   * Build a capacity-feasible schedule by placing features one-by-one
   * in priority order (epic.order → feature.order) into the earliest
   * week where (a) dependencies are met, (b) epic concurrency allows,
   * and (c) all required RT capacity is available.
   */
  function buildResourceConstrainedSchedule(): Map<string, number> {
    const scheduled = new Map<string, number>()

    // Weekly usage arrays: rtId → Float64Array of days used per week
    const weeklyUsed = new Map<string, Float64Array>()
    for (const [rtId] of rtCapacity) {
      weeklyUsed.set(rtId, new Float64Array(MAX_WEEKS))
    }

    // Build priority-ordered feature list:
    //   Primary: epic.order (sort epics from input by their order field)
    //   Secondary: preserve feature input order within the epic
    const sortedEpics = [...epics].sort((a, b) => a.order - b.order)
    const epicPriority = new Map(sortedEpics.map((e, i) => [e.id, i]))

    const sortedFeatures = [...features].sort((a, b) => {
      const epicA = epicPriority.get(a.epicId) ?? 999
      const epicB = epicPriority.get(b.epicId) ?? 999
      if (epicA !== epicB) return epicA - epicB
      // Preserve input order within same epic (features array is already in
      // epic-feature insertion order, so indexOf gives stable ordering)
      return features.indexOf(a) - features.indexOf(b)
    })

    // Pre-build successor map for efficient concurrency tracking
    // epicId → Set of featureIds (for quick epic-activity lookup)
    const scheduledByEpic = new Map<string, string[]>()
    for (const [epicId] of epicFeatures) {
      scheduledByEpic.set(epicId, [])
    }

    for (const feature of sortedFeatures) {
      // 1. Find earliest start respecting dependencies
      let earliest = 0
      for (const predId of feature.predecessors) {
        const predStart = scheduled.get(predId)
        if (predStart !== undefined) {
          const predInfo = featureMap.get(predId)
          const predEnd = predStart + (predInfo?.durationWeeks ?? 0)
          if (predEnd > earliest) earliest = predEnd
        }
      }

      // 2. Check max concurrent epics constraint
      if (maxConcurrentEpics) {
        while (earliest < MAX_WEEKS) {
          const activeEpics = new Set<string>()
          for (const [epicId, fIds] of scheduledByEpic) {
            if (epicId === feature.epicId) continue // own epic doesn't count
            for (const fId of fIds) {
              const fStart = scheduled.get(fId)!
              const fInfo = featureMap.get(fId)!
              if (fStart <= earliest && fStart + fInfo.durationWeeks > earliest) {
                activeEpics.add(epicId)
                break // one active feature is enough to mark epic active
              }
            }
          }
          if (activeEpics.size < maxConcurrentEpics) break
          earliest++
        }
      }

      // 3. Find earliest week where capacity is available for ALL required RTs
      //    across the full feature duration
      let startWeek = earliest
      while (startWeek + feature.durationWeeks <= MAX_WEEKS) {
        let fits = true
        for (const [rtId, ratePerWeek] of feature.demandRates) {
          const capacity = rtCapacity.get(rtId) ?? Infinity
          const used = weeklyUsed.get(rtId)
          if (!used) continue
          for (let w = startWeek; w < startWeek + feature.durationWeeks; w++) {
            if (used[w] + ratePerWeek > capacity + 0.01) { // epsilon for float
              fits = false
              break
            }
          }
          if (!fits) break
        }
        if (fits) break
        startWeek++
      }

      // 4. Schedule the feature and update weekly usage
      scheduled.set(feature.id, startWeek)
      scheduledByEpic.get(feature.epicId)?.push(feature.id)

      for (const [rtId, ratePerWeek] of feature.demandRates) {
        const used = weeklyUsed.get(rtId)
        if (!used) continue
        for (let w = startWeek; w < startWeek + feature.durationWeeks && w < MAX_WEEKS; w++) {
          used[w] += ratePerWeek
        }
      }
    }

    return scheduled
  }

  const bestSolution = buildResourceConstrainedSchedule()

  // ── Gap-filling pass ────────────────────────────────────────────────────
  // After priority-order placement, some RTs have idle gaps because later
  // features that use those RTs weren't placed yet when the gap existed.
  // This pass iterates multiple times, trying to pull each feature to its
  // earliest feasible week (respecting deps, capacity, and concurrency).

  let improvements = 0

  if (features.length > 0) {
    // Rebuild weekly usage from the RCPS solution
    const weeklyUsed = new Map<string, Float64Array>()
    for (const [rtId] of rtCapacity) {
      weeklyUsed.set(rtId, new Float64Array(MAX_WEEKS))
    }
    for (const f of features) {
      const start = bestSolution.get(f.id) ?? 0
      for (const [rtId, rate] of f.demandRates) {
        const used = weeklyUsed.get(rtId)
        if (!used) continue
        for (let w = start; w < start + f.durationWeeks && w < MAX_WEEKS; w++) {
          used[w] += rate
        }
      }
    }

    // Build successor lookup: featureId → list of dependent featureIds
    const successors = new Map<string, string[]>()
    for (const f of features) {
      for (const predId of f.predecessors) {
        let list = successors.get(predId)
        if (!list) { list = []; successors.set(predId, list) }
        list.push(f.id)
      }
    }

    // Multi-pass gap filling: sort features by current start (latest first)
    // and try to pull each one earlier. Repeat until no more improvements.
    // Precompute per-week epic count for concurrency checks (O(1) lookup)
    let epicCountPerWeek: Uint16Array | null = null
    let epicPresence: Map<string, Uint8Array> | null = null
    if (maxConcurrentEpics) {
      epicCountPerWeek = new Uint16Array(MAX_WEEKS)
      epicPresence = new Map<string, Uint8Array>()
      for (const epic of epics) {
        epicPresence.set(epic.id, new Uint8Array(MAX_WEEKS))
      }
      for (const f of features) {
        const start = bestSolution.get(f.id) ?? 0
        const ep = epicPresence.get(f.epicId)!
        for (let w = start; w < start + f.durationWeeks && w < MAX_WEEKS; w++) {
          if (ep[w] === 0) { ep[w] = 1; epicCountPerWeek[w]++ }
        }
      }
    }

    const maxPasses = 5
    for (let pass = 0; pass < maxPasses; pass++) {
      let passImprovements = 0

      const byStart = [...features].sort((a, b) => {
        return (bestSolution.get(b.id) ?? 0) - (bestSolution.get(a.id) ?? 0)
      })

      for (const f of byStart) {
        const currentStart = bestSolution.get(f.id) ?? 0

        let depEarliest = 0
        for (const predId of f.predecessors) {
          const predInfo = featureMap.get(predId)
          if (!predInfo) continue
          const predEnd = (bestSolution.get(predId) ?? 0) + predInfo.durationWeeks
          if (predEnd > depEarliest) depEarliest = predEnd
        }

        if (depEarliest >= currentStart) continue

        // Remove this feature's usage from the grid
        for (const [rtId, rate] of f.demandRates) {
          const used = weeklyUsed.get(rtId)
          if (!used) continue
          for (let w = currentStart; w < currentStart + f.durationWeeks && w < MAX_WEEKS; w++) {
            used[w] -= rate
          }
        }
        // Remove from epic presence
        if (epicCountPerWeek && epicPresence) {
          const ep = epicPresence.get(f.epicId)!
          // Check if other features in same epic still cover each week
          for (let w = currentStart; w < currentStart + f.durationWeeks && w < MAX_WEEKS; w++) {
            const stillCovered = features.some(other =>
              other.id !== f.id && other.epicId === f.epicId &&
              (bestSolution.get(other.id) ?? 0) <= w &&
              (bestSolution.get(other.id) ?? 0) + other.durationWeeks > w
            )
            if (!stillCovered && ep[w] === 1) { ep[w] = 0; epicCountPerWeek[w]-- }
          }
        }

        let newStart = depEarliest
        let found = false

        while (newStart < currentStart) {
          // Epic concurrency check (O(duration) using precomputed arrays)
          let concurrencyOk = true
          if (maxConcurrentEpics && epicCountPerWeek && epicPresence) {
            const ep = epicPresence.get(f.epicId)!
            for (let w = newStart; w < newStart + f.durationWeeks && concurrencyOk; w++) {
              if (ep[w] === 0 && epicCountPerWeek[w] >= maxConcurrentEpics) {
                concurrencyOk = false
              }
            }
          }

          if (!concurrencyOk) { newStart++; continue }

          // Capacity feasibility
          let capacityOk = true
          for (const [rtId, ratePerWeek] of f.demandRates) {
            const capacity = rtCapacity.get(rtId) ?? Infinity
            const used = weeklyUsed.get(rtId)
            if (!used) continue
            for (let w = newStart; w < newStart + f.durationWeeks && w < MAX_WEEKS; w++) {
              if (used[w] + ratePerWeek > capacity + 0.01) {
                capacityOk = false
                break
              }
            }
            if (!capacityOk) break
          }

          if (capacityOk) { found = true; break }
          newStart++
        }

        if (found && newStart < currentStart) {
          bestSolution.set(f.id, newStart)
          for (const [rtId, rate] of f.demandRates) {
            const used = weeklyUsed.get(rtId)
            if (!used) continue
            for (let w = newStart; w < newStart + f.durationWeeks && w < MAX_WEEKS; w++) {
              used[w] += rate
            }
          }
          // Update epic presence
          if (epicCountPerWeek && epicPresence) {
            const ep = epicPresence.get(f.epicId)!
            for (let w = newStart; w < newStart + f.durationWeeks && w < MAX_WEEKS; w++) {
              if (ep[w] === 0) { ep[w] = 1; epicCountPerWeek[w]++ }
            }
          }
          passImprovements++
          improvements++
        } else {
          // Restore original position
          for (const [rtId, rate] of f.demandRates) {
            const used = weeklyUsed.get(rtId)
            if (!used) continue
            for (let w = currentStart; w < currentStart + f.durationWeeks && w < MAX_WEEKS; w++) {
              used[w] += rate
            }
          }
          // Restore epic presence
          if (epicCountPerWeek && epicPresence) {
            const ep = epicPresence.get(f.epicId)!
            for (let w = currentStart; w < currentStart + f.durationWeeks && w < MAX_WEEKS; w++) {
              if (ep[w] === 0) { ep[w] = 1; epicCountPerWeek[w]++ }
            }
          }
        }
      }

      if (passImprovements === 0) break
    }
  }

  // ── Build result ─────────────────────────────────────────────────────

  // Derive epic start weeks
  const epicStartWeeks = new Map<string, number>()
  for (const epic of epics) {
    let minW = Infinity
    for (const f of epic.features) {
      const fw = bestSolution.get(f.id)
      if (fw !== undefined && fw < minW) minW = fw
    }
    epicStartWeeks.set(epic.id, minW === Infinity ? 0 : minW)
  }

  // Compute total delivery weeks
  let totalDeliveryWeeks = 0
  for (const f of features) {
    const start = bestSolution.get(f.id) ?? 0
    const end = start + f.durationWeeks
    if (end > totalDeliveryWeeks) totalDeliveryWeeks = end
  }

  // Peak utilisation
  let peakUtilisationPct = 0
  const weeklyDemand = new Map<string, Map<number, number>>()
  for (const rt of resourceTypes) weeklyDemand.set(rt.id, new Map())
  for (const f of features) {
    const start = bestSolution.get(f.id) ?? 0
    for (const [rtId, rate] of f.demandRates) {
      const rtD = weeklyDemand.get(rtId)!
      for (let w = start; w < start + f.durationWeeks; w++) {
        rtD.set(w, (rtD.get(w) ?? 0) + rate)
      }
    }
  }
  for (const rt of resourceTypes) {
    const cap = rtCapacity.get(rt.id) ?? 1
    for (const [, demand] of weeklyDemand.get(rt.id)!) {
      const pct = cap > 0 ? (demand / cap) * 100 : 0
      if (pct > peakUtilisationPct) peakUtilisationPct = pct
    }
  }

  // bestFitness = total delivery weeks (for compatibility)
  const bestFitness = totalDeliveryWeeks

  console.log(`[RCPS] features=${features.length} totalWeeks=${totalDeliveryWeeks} peakUtil=${Math.round(peakUtilisationPct)}% compressionImprovements=${improvements}`)

  return {
    epicStartWeeks,
    featureStartWeeks: bestSolution,
    totalDeliveryWeeks,
    peakUtilisationPct: Math.round(peakUtilisationPct * 10) / 10,
    bestFitness,
    improvements,
  }
}
