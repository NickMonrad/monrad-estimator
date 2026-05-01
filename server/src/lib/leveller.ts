/**
 * leveller.ts — Greedy resource-levelling algorithm for the Monrad Estimator.
 *
 * Pure function: no I/O, no Prisma, no side effects.
 * Takes a SchedulerInput and returns proposed epic start weeks that
 * spread demand across time, respecting epic dependencies.
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
  totalDeliveryWeeks: number
  peakUtilisationPct: number
}

// ─────────────────────────────────────────────────────────────────────────────
// Main entry point
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Greedy bin-packing leveller.
 *
 * 1. Runs the scheduler (resourceLevel: false) to get epic durations.
 * 2. Computes per-epic demand profiles (demandDaysPerWeek per RT).
 * 3. Builds epic-level dependency graph.
 * 4. Greedily places epics into the earliest week slot that doesn't
 *    exceed capacity for any RT in any covered week.
 */
export function levelEpicStarts(input: SchedulerInput): LevellingResult {
  const { project, epics, resourceTypes, epicDeps } = input
  const hpd = project.hoursPerDay

  // ── Step 1: Run scheduler to get baseline feature schedule ───────────────
  const output = runScheduler({ ...input, resourceLevel: false })
  const { featureSchedule } = output

  // Build lookup: featureId → { startWeek, finishWeek }
  const featureStartMap = new Map<string, number>()
  const featureFinishMap = new Map<string, number>()
  for (const fs of featureSchedule) {
    featureStartMap.set(fs.featureId, fs.startWeek)
    featureFinishMap.set(fs.featureId, fs.startWeek + fs.durationWeeks)
  }

  // ── Step 2: Compute per-epic demand profiles ──────────────────────────────
  // For each epic: duration in weeks + demand rate (days/week) per RT.
  // epicDurations: epicId → durationWeeks
  // epicDemandRates: epicId → Map<rtId, demandDaysPerWeek>

  const epicDurations = new Map<string, number>()
  const epicDemandRates = new Map<string, Map<string, number>>()

  for (const epic of epics) {
    const featureIds = epic.features.map(f => f.id)
    if (featureIds.length === 0) {
      epicDurations.set(epic.id, 1)
      epicDemandRates.set(epic.id, new Map())
      continue
    }

    // Compute epic span from feature schedule
    let epicStart = Infinity
    let epicFinish = 0
    for (const fId of featureIds) {
      const fs = featureStartMap.get(fId)
      const ff = featureFinishMap.get(fId)
      if (fs !== undefined) epicStart = Math.min(epicStart, fs)
      if (ff !== undefined) epicFinish = Math.max(epicFinish, ff)
    }
    const durationWeeks = Math.max(1, epicStart === Infinity ? 1 : epicFinish - epicStart)
    epicDurations.set(epic.id, durationWeeks)

    // Compute total demand days per RT across all active features/stories/tasks
    const totalDemandDaysByRt = new Map<string, number>()
    for (const feature of epic.features) {
      for (const story of feature.userStories) {
        if (story.isActive === false) continue
        for (const task of story.tasks) {
          if (!task.resourceTypeId) continue
          const rtHpd = task.resourceType?.hoursPerDay ?? hpd
          const demandDays = task.durationDays ?? (task.hoursEffort / rtHpd)
          totalDemandDaysByRt.set(
            task.resourceTypeId,
            (totalDemandDaysByRt.get(task.resourceTypeId) ?? 0) + demandDays,
          )
        }
      }
    }

    // Demand rate = totalDemand / epicDuration (evenly distributed approximation)
    const demandRateByRt = new Map<string, number>()
    for (const [rtId, totalDemand] of totalDemandDaysByRt) {
      demandRateByRt.set(rtId, totalDemand / durationWeeks)
    }
    epicDemandRates.set(epic.id, demandRateByRt)
  }

  // ── Step 3: Build dependency graph (epic-level) ───────────────────────────
  // earliestStart[epicId] will be updated as we place epics.
  // We process epics in topological order by (epicDep chain + epic.order).

  const epicById = new Map(epics.map(e => [e.id, e]))

  // Build adjacency (dependsOn → [dependents]) and in-degree
  const epicInDeg = new Map<string, number>()
  const epicSuccessors = new Map<string, string[]>()
  const epicPredecessors = new Map<string, string[]>()

  for (const epic of epics) {
    epicInDeg.set(epic.id, 0)
    epicSuccessors.set(epic.id, [])
    epicPredecessors.set(epic.id, [])
  }

  for (const dep of epicDeps) {
    // dep.epicId depends on dep.dependsOnId
    const succs = epicSuccessors.get(dep.dependsOnId)
    const preds = epicPredecessors.get(dep.epicId)
    if (!succs || !preds) continue
    succs.push(dep.epicId)
    preds.push(dep.dependsOnId)
    epicInDeg.set(dep.epicId, (epicInDeg.get(dep.epicId) ?? 0) + 1)
  }

  // Topological sort (Kahn's) with tie-break by epic.order
  const topoOrder: string[] = []
  const queue: string[] = []

  // Seed: epics with no deps
  for (const epic of epics) {
    if ((epicInDeg.get(epic.id) ?? 0) === 0) {
      queue.push(epic.id)
    }
  }
  // Sort queue by epic.order for deterministic output
  queue.sort((a, b) => (epicById.get(a)?.order ?? 0) - (epicById.get(b)?.order ?? 0))

  while (queue.length > 0) {
    // Pick lowest-order epic from queue
    const epicId = queue.shift()!
    topoOrder.push(epicId)

    const succs = epicSuccessors.get(epicId) ?? []
    const newReady: string[] = []
    for (const succId of succs) {
      const newDeg = (epicInDeg.get(succId) ?? 1) - 1
      epicInDeg.set(succId, newDeg)
      if (newDeg === 0) newReady.push(succId)
    }
    newReady.sort((a, b) => (epicById.get(a)?.order ?? 0) - (epicById.get(b)?.order ?? 0))
    queue.push(...newReady)
    queue.sort((a, b) => (epicById.get(a)?.order ?? 0) - (epicById.get(b)?.order ?? 0))
  }

  // Fallback: any unprocessed epics (cycles) appended in order
  const processedSet = new Set(topoOrder)
  for (const epic of [...epics].sort((a, b) => a.order - b.order)) {
    if (!processedSet.has(epic.id)) topoOrder.push(epic.id)
  }

  // ── Step 4: Greedy placement ──────────────────────────────────────────────
  const rtById = new Map(resourceTypes.map(rt => [rt.id, rt]))

  // Tracks already-allocated demand days per (week, rtId)
  const utilisedDays = new Map<string, number>() // key: `${rtId}|${week}`

  const epicStartWeeks = new Map<string, number>()
  const epicFinishWeeks = new Map<string, number>()

  const MAX_SEARCH = 200

  for (const epicId of topoOrder) {
    const epic = epicById.get(epicId)
    if (!epic) continue

    const durationWeeks = epicDurations.get(epicId) ?? 1
    const demandRates = epicDemandRates.get(epicId) ?? new Map()

    // Earliest start = max finish of all predecessor epics
    let minStart = 0
    for (const predId of epicPredecessors.get(epicId) ?? []) {
      const predFinish = epicFinishWeeks.get(predId) ?? 0
      if (predFinish > minStart) minStart = predFinish
    }
    minStart = Math.ceil(minStart) // snap to integer week boundary

    // Search for earliest integer week that fits
    let placedAt: number | null = null

    for (let week = minStart; week <= minStart + MAX_SEARCH; week++) {
      let fits = true

      // Check every week the epic would occupy
      for (let w = week; w < week + Math.ceil(durationWeeks); w++) {
        for (const [rtId, demandRate] of demandRates) {
          const rt = rtById.get(rtId) as SchedulerResourceType | undefined
          if (!rt) continue

          const key = `${rtId}|${w}`
          const alreadyUsed = utilisedDays.get(key) ?? 0
          const proposed = alreadyUsed + demandRate

          // Capacity in days for this rt this week
          const capacityDays = getWeeklyCapacity(rt, w, hpd) / (rt.hoursPerDay ?? hpd)

          if (proposed > capacityDays + 1e-9) {
            fits = false
            break
          }
        }
        if (!fits) break
      }

      if (fits) {
        placedAt = week
        break
      }
    }

    // Fallback: if no slot found, place at minStart
    const startWeek = placedAt ?? minStart
    epicStartWeeks.set(epicId, startWeek)
    epicFinishWeeks.set(epicId, startWeek + durationWeeks)

    // Update utilisation grid
    for (let w = startWeek; w < startWeek + Math.ceil(durationWeeks); w++) {
      for (const [rtId, demandRate] of demandRates) {
        const key = `${rtId}|${w}`
        utilisedDays.set(key, (utilisedDays.get(key) ?? 0) + demandRate)
      }
    }
  }

  // ── Step 5: Compute metrics ───────────────────────────────────────────────
  const totalDeliveryWeeks =
    epicFinishWeeks.size > 0 ? Math.max(...epicFinishWeeks.values()) : 0

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
    totalDeliveryWeeks,
    peakUtilisationPct: Math.round(peakUtilisationPct * 10) / 10,
  }
}
