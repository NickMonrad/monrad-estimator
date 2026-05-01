/**
 * scheduler.ts — Pure scheduling engine for the Monrad Estimator timeline.
 *
 * This module is intentionally free of Prisma, I/O, and side effects.
 * It accepts plain data in and returns plain data out, which lets the
 * Phase 3 optimiser call runScheduler() in a tight loop with different
 * resource configurations without touching the database.
 *
 * Phase 2 extraction: issue #233
 */

// ─────────────────────────────────────────────────────────────────────────────
// Input / Output types
// ─────────────────────────────────────────────────────────────────────────────

export interface SchedulerTask {
  resourceTypeId: string | null
  hoursEffort: number
  durationDays: number | null
  resourceType: {
    id: string
    name: string
    hoursPerDay: number | null
  } | null
}

export interface SchedulerStory {
  id: string
  order: number | null
  isActive: boolean | null
  tasks: SchedulerTask[]
}

export interface SchedulerFeature {
  id: string
  order: number
  isActive: boolean | null
  timelineStartWeek: number | null
  userStories: SchedulerStory[]
  /** FeatureDependency rows where this feature is the dependent */
  dependencies: Array<{ featureId: string; dependsOnId: string }>
}

export interface SchedulerEpic {
  id: string
  name: string
  order: number
  isActive: boolean | null
  featureMode: string | null
  scheduleMode: string | null
  timelineStartWeek: number | null
  features: SchedulerFeature[]
}

export interface SchedulerNamedResource {
  id: string
  name: string
  startWeek: number | null
  endWeek: number | null
  allocationPct: number
  allocationMode: string
  allocationPercent: number
  allocationStartWeek: number | null
  allocationEndWeek: number | null
}

export interface SchedulerResourceType {
  id: string
  name: string
  count: number
  hoursPerDay: number | null
  namedResources: SchedulerNamedResource[]
}

export interface SchedulerInput {
  /** Scheduling-relevant project fields */
  project: {
    hoursPerDay: number
  }
  /** Active epics (inactive ones already filtered out by the caller) */
  epics: SchedulerEpic[]
  resourceTypes: SchedulerResourceType[]
  epicDeps: Array<{ epicId: string; dependsOnId: string }>
  /** Feature-level manual pins (isManual=true rows) */
  manualFeatureEntries: Array<{ featureId: string; startWeek: number; durationWeeks: number }>
  /** Story-level manual pins */
  manualStoryEntries: Array<{ storyId: string; startWeek: number }>
  /** When true, run the resource-levelling simulation */
  resourceLevel: boolean
  /** Cap parallelism within a single feature (for demand flattening). Optional. */
  maxParallelismPerFeature?: number
}

export interface ParallelWarning {
  epicId: string
  epicName: string
  resourceTypeName: string
  demandDays: number
  capacityDays: number
}

export interface SchedulerOutput {
  /** One entry per processed feature */
  featureSchedule: Array<{
    featureId: string
    startWeek: number
    durationWeeks: number
    isManual: boolean
  }>
  /** One entry per active story */
  storySchedule: Array<{
    storyId: string
    startWeek: number
    durationWeeks: number
    isManual: boolean
  }>
  /**
   * Actual resource consumption from the levelling simulation.
   * Key: `${resourceTypeName}|${week}`, value: days consumed.
   * Empty map when resourceLevel=false.
   */
  weeklyConsumptionMap: Map<string, number>
  parallelWarnings: ParallelWarning[]
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure helpers (previously in routes/timeline.ts)
// ─────────────────────────────────────────────────────────────────────────────

/** Compute the effective allocation percentage for a named resource in a given week. */
export function effectiveAllocationPct(
  nr: SchedulerNamedResource,
  week: number,
): number {
  if (nr.allocationMode === 'FULL_PROJECT') return nr.allocationPercent
  if (nr.allocationMode === 'TIMELINE') {
    const wStart = nr.allocationStartWeek ?? nr.startWeek ?? 0
    const wEnd = nr.allocationEndWeek ?? nr.endWeek ?? Infinity
    return week >= wStart && week <= wEnd ? nr.allocationPercent : 0
  }
  // EFFORT (T&M) — no fixed allocation; full capacity available
  return 100
}

/**
 * Compute weekly capacity (hours) for a resource type.
 *
 * `count` is treated as the true effective headcount. Named resources are
 * allocation/availability overlays for known team members; any slots beyond
 * `namedResources.length` are treated as full-availability phantom (T&M) staff.
 *
 * weeklyHours = Σ namedResource(active this week, allocation %) +
 *               max(0, count - namedResources.length) × hpd × 5
 */
export function getWeeklyCapacity(
  rt: SchedulerResourceType,
  week: number,
  defaultHoursPerDay: number,
): number {
  const hoursPerDay = rt.hoursPerDay ?? defaultHoursPerDay
  // Defensive: real Prisma queries always return [] (include: { namedResources: true }),
  // but some test mocks omit the field entirely. Treat undefined as empty.
  const namedResources = rt.namedResources ?? []
  let totalHours = 0
  // Named resources contribute their allocation-respecting capacity for this week
  for (const nr of namedResources) {
    const start = nr.startWeek ?? 0       // null = project start (week 0)
    const end = nr.endWeek ?? Infinity     // null = project end
    if (week >= start && week <= end) {
      const pct = effectiveAllocationPct(nr, week)
      totalHours += (pct / 100) * hoursPerDay * 5
    }
  }
  // Phantom slots: any count slots beyond namedResources are full-time T&M staff
  const phantomSlots = Math.max(0, rt.count - namedResources.length)
  totalHours += phantomSlots * hoursPerDay * 5
  return totalHours
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Min-heap for Kahn's topological sort priority queue. O(n log n) total. */
class MinHeap {
  private data: Array<{ priority: number; id: string }> = []

  push(item: { priority: number; id: string }) {
    this.data.push(item)
    this._bubbleUp(this.data.length - 1)
  }

  pop(): { priority: number; id: string } | undefined {
    if (this.data.length === 0) return undefined
    const top = this.data[0]
    const last = this.data.pop()!
    if (this.data.length > 0) {
      this.data[0] = last
      this._sinkDown(0)
    }
    return top
  }

  get length() { return this.data.length }

  private _bubbleUp(i: number) {
    while (i > 0) {
      const parent = Math.floor((i - 1) / 2)
      if (this.data[parent].priority <= this.data[i].priority) break
      ;[this.data[parent], this.data[i]] = [this.data[i], this.data[parent]]
      i = parent
    }
  }

  private _sinkDown(i: number) {
    const n = this.data.length
    while (true) {
      let smallest = i
      const l = 2 * i + 1, r = 2 * i + 2
      if (l < n && this.data[l].priority < this.data[smallest].priority) smallest = l
      if (r < n && this.data[r].priority < this.data[smallest].priority) smallest = r
      if (smallest === i) break
      ;[this.data[smallest], this.data[i]] = [this.data[i], this.data[smallest]]
      i = smallest
    }
  }
}

/**
 * Compute over-allocation warnings for parallel-mode epics.
 * Pure function: accepts pre-computed schedule entries + resource data.
 * Exported so the GET /timeline route can call it directly on saved DB entries.
 */
export function computeParallelWarnings(
  fallbackHoursPerDay: number,
  entries: Array<{
    featureId: string
    startWeek: number
    durationWeeks: number
    feature: { epic: { id: string; name: string; featureMode: string | null } }
  }>,
  allFeatures: Array<{
    id: string
    userStories: Array<{
      isActive: boolean | null
      tasks: Array<{
        resourceTypeId: string | null
        resourceType: { id: string; name: string; hoursPerDay: number | null } | null
        hoursEffort: number
        durationDays: number | null
      }>
    }>
  }>,
  allResourceTypes: SchedulerResourceType[],
): ParallelWarning[] {
  const warnings: ParallelWarning[] = []

  // Only check parallel epics with 2+ features
  const parallelEpics = new Map<string, { epicName: string; featureIds: string[]; startWeek: number; endWeek: number }>()
  for (const e of entries) {
    if ((e.feature.epic.featureMode ?? 'sequential') !== 'parallel') continue
    const epicId = e.feature.epic.id
    if (!parallelEpics.has(epicId)) {
      parallelEpics.set(epicId, { epicName: e.feature.epic.name, featureIds: [], startWeek: e.startWeek, endWeek: e.startWeek + e.durationWeeks })
    }
    const ep = parallelEpics.get(epicId)!
    ep.featureIds.push(e.featureId)
    ep.startWeek = Math.min(ep.startWeek, e.startWeek)
    ep.endWeek = Math.max(ep.endWeek, e.startWeek + e.durationWeeks)
  }

  const featureById = new Map(allFeatures.map(f => [f.id, f]))
  const rtMap = new Map(allResourceTypes.map(rt => [rt.id, rt]))

  for (const [epicId, { epicName, featureIds, startWeek, endWeek }] of parallelEpics) {
    if (featureIds.length < 2) continue

    const features = featureIds.map(id => featureById.get(id)).filter((f): f is NonNullable<typeof f> => f !== undefined)

    const demandMap = new Map<string, { name: string; days: number }>()
    for (const feature of features) {
      for (const story of feature.userStories) {
        if (story.isActive === false) continue
        for (const task of story.tasks) {
          const rtId = task.resourceTypeId ?? '_unassigned'
          const hpd = task.resourceType?.hoursPerDay ?? fallbackHoursPerDay
          const days = task.durationDays ?? (task.hoursEffort / hpd)
          if (!demandMap.has(rtId)) {
            demandMap.set(rtId, {
              name: task.resourceType?.name ?? 'Unassigned',
              days: 0,
            })
          }
          demandMap.get(rtId)!.days += days
        }
      }
    }

    for (const [rtId, { name, days }] of demandMap) {
      const rt = rtMap.get(rtId)
      // Capacity over the epic span: integrate getWeeklyCapacity across the span.
      // For unknown RTs (no entry in rtMap, e.g. _unassigned), treat capacity as 0.
      let capacityDays = 0
      if (rt) {
        const hpd = rt.hoursPerDay ?? fallbackHoursPerDay
        for (let w = Math.floor(startWeek); w < Math.ceil(endWeek); w++) {
          const overlap = Math.min(w + 1, endWeek) - Math.max(w, startWeek)
          if (overlap <= 0) continue
          capacityDays += (getWeeklyCapacity(rt, w, fallbackHoursPerDay) / hpd) * overlap
        }
      }
      if (days > capacityDays) {
        warnings.push({
          epicId,
          epicName,
          resourceTypeName: name,
          demandDays: Math.round(days * 10) / 10,
          capacityDays: Math.round(capacityDays * 10) / 10,
        })
      }
    }
  }

  return warnings
}

// ─────────────────────────────────────────────────────────────────────────────
// Main entry point
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Pure scheduling engine.
 *
 * Takes plain data (no Prisma types), performs topological sort + optional
 * resource-levelling simulation, and returns computed schedules for features
 * and stories together with the weekly resource consumption map and any
 * over-allocation warnings.
 *
 * Same inputs → same outputs.  No DB access.  No side effects.
 */
export function runScheduler(input: SchedulerInput): SchedulerOutput {
  const { project, epics, resourceTypes, epicDeps, manualFeatureEntries, manualStoryEntries, resourceLevel } = input
  const fallbackHoursPerDay = project.hoursPerDay

  const rtCountMap = new Map(resourceTypes.map(rt => [rt.id, rt.count]))

  // Build manual lookup maps
  const manualStartWeeks = new Map(manualFeatureEntries.map(e => [e.featureId, e.startWeek]))
  const manualDurationWeeks = new Map(manualFeatureEntries.map(e => [e.featureId, e.durationWeeks]))
  const manualStoryWeeks = new Map(manualStoryEntries.map(e => [e.storyId, e.startWeek]))

  // ── Flatten features across epics, attaching epic back-reference ─────────
  const allFeatures = epics.flatMap(epic =>
    epic.features.map(f => ({ ...f, epic }))
  )
  const featureMap = new Map(allFeatures.map(f => [f.id, f]))

  // ── Precompute parallel demand floor per epic ─────────────────────────────
  // For parallel epics with 2+ features sharing an RT, the features cannot all
  // complete faster than totalDemand / (count × 5) weeks — raising count adds
  // capacity but also shortens durations, keeping net capacity flat. This floor
  // ensures featureDurationWeeks reflects real shared-resource contention.
  const parallelEpicMinSpan = new Map<string, number>()

  for (const epic of epics) {
    if (epic.featureMode !== 'parallel') continue
    const activeFeatures = epic.features.filter(f => f.isActive !== false)
    if (activeFeatures.length < 2) continue

    // Collect total demand days per RT across all features in this epic
    const totalDemandByRt = new Map<string, number>()
    for (const feature of activeFeatures) {
      const tasks = feature.userStories
        .filter(s => s.isActive !== false)
        .flatMap(s => s.tasks)
      for (const task of tasks) {
        if (!task.resourceTypeId) continue
        const hpd = task.resourceType?.hoursPerDay ?? fallbackHoursPerDay
        const demand = task.durationDays ?? (task.hoursEffort / hpd)
        totalDemandByRt.set(
          task.resourceTypeId,
          (totalDemandByRt.get(task.resourceTypeId) ?? 0) + demand,
        )
      }
    }

    // Floor weeks = max over all RTs of (totalDemand / (count × 5))
    let minSpan = 0
    for (const [rtId, totalDemand] of totalDemandByRt) {
      const count = rtCountMap.get(rtId) ?? 1
      const weeklyCapacityDays = count * 5
      const floorWeeks = totalDemand / weeklyCapacityDays
      if (floorWeeks > minSpan) minSpan = floorWeeks
    }

    if (minSpan > 0) {
      parallelEpicMinSpan.set(epic.id, minSpan)
    }
  }

  // ── Helper: duration in weeks for a feature ───────────────────────────────
  function featureDurationWeeks(feature: typeof allFeatures[0]): number {
    const allTasks = feature.userStories.filter(s => s.isActive !== false).flatMap(s => s.tasks)
    if (allTasks.length === 0) return 1

    const byRt = new Map<string | null, typeof allTasks>()
    for (const task of allTasks) {
      const group = byRt.get(task.resourceTypeId) ?? []
      group.push(task)
      byRt.set(task.resourceTypeId, group)
    }

    let maxDays = 0
    for (const [rtId, tasks] of byRt) {
      const personDays = tasks.reduce((sum, t) => {
        const hpd = t.resourceType?.hoursPerDay ?? fallbackHoursPerDay
        return sum + (t.durationDays ?? (t.hoursEffort / hpd))
      }, 0)
      const count = rtId ? (rtCountMap.get(rtId) ?? 1) : 1
      const days = personDays / count
      if (days > maxDays) maxDays = days
    }
    const individualResult = Math.max(0.2, maxDays / 5)

    // Apply parallel demand floor if this feature belongs to a parallel epic
    const floor = parallelEpicMinSpan.get(feature.epic.id)
    if (floor !== undefined) {
      return Math.max(individualResult, floor)
    }
    return individualResult
  }

  // ── Kahn's topological sort over features ─────────────────────────────────
  const inDegree = new Map<string, number>()
  const adjList = new Map<string, Set<string>>()   // from → Set<to>  (Set for O(1) dedup)
  const predecessors = new Map<string, string[]>() // to → [from, ...]

  for (const f of allFeatures) {
    inDegree.set(f.id, 0)
    adjList.set(f.id, new Set())
    predecessors.set(f.id, [])
  }

  function addEdge(fromId: string, toId: string) {
    const succs = adjList.get(fromId)
    const preds = predecessors.get(toId)
    if (!succs || !preds) return // one of the features not in this project
    if (succs.has(toId)) return // deduplicate (O(1) with Set)
    succs.add(toId)
    preds.push(fromId)
    inDegree.set(toId, (inDegree.get(toId) ?? 0) + 1)
  }

  const sortedEpics = [...epics].sort((a, b) => a.order - b.order)

  // 1. Intra-epic sequential edges
  for (const epic of epics) {
    if ((epic.featureMode ?? 'sequential') === 'sequential') {
      const sorted = [...epic.features].sort((a, b) => a.order - b.order)
      for (let i = 1; i < sorted.length; i++) {
        // Don't chain successor onto a manually-pinned feature
        if (manualStartWeeks.has(sorted[i - 1].id)) continue
        addEdge(sorted[i - 1].id, sorted[i].id)
      }
    }
  }

  // 2. Inter-epic sequential chaining
  for (let i = 1; i < sortedEpics.length; i++) {
    const prevEpic = sortedEpics[i - 1]
    const currEpic = sortedEpics[i]
    if (prevEpic.features.length === 0 || currEpic.features.length === 0) continue

    if (currEpic.timelineStartWeek != null) continue
    if ((currEpic.scheduleMode ?? 'sequential') === 'parallel') continue

    const currTargets = (currEpic.featureMode ?? 'sequential') === 'sequential'
      ? [currEpic.features[0]]
      : currEpic.features

    for (const prevFeature of prevEpic.features) {
      const hasCrossEpicDep = (prevFeature.dependencies ?? []).some(dep => {
        const target = featureMap.get(dep.dependsOnId)
        return target !== undefined && target.epic.id === currEpic.id
      })
      if (hasCrossEpicDep) continue

      for (const currFeature of currTargets) {
        addEdge(prevFeature.id, currFeature.id)
      }
    }
  }

  // 3. Explicit cross-epic feature dependency edges
  for (const f of allFeatures) {
    for (const dep of (f.dependencies ?? [])) {
      addEdge(dep.dependsOnId, dep.featureId)
    }
  }

  // 4. Epic dependency hard constraints
  const epicById = new Map(epics.map(e => [e.id, e]))
  for (const epicDep of epicDeps) {
    const fromEpic = epicById.get(epicDep.dependsOnId)
    const toEpic = epicById.get(epicDep.epicId)
    if (!fromEpic || !toEpic) continue
    for (const fromFeature of fromEpic.features) {
      for (const toFeature of toEpic.features) {
        addEdge(fromFeature.id, toFeature.id)
      }
    }
  }

  // Kahn's algorithm with min-heap priority queue
  const finishWeeks = new Map<string, number>()
  const startWeeks = new Map<string, number>()

  function featurePriority(fId: string) {
    const f = featureMap.get(fId)!
    return f.epic.order * 100000 + f.order
  }

  const queue = new MinHeap()
  for (const [fId, deg] of inDegree) {
    if (deg === 0) queue.push({ priority: featurePriority(fId), id: fId })
  }

  const processed: string[] = []

  while (queue.length > 0) {
    const { id: fId } = queue.pop()!
    processed.push(fId)

    const f = featureMap.get(fId)!
    const epic = f.epic
    const dur = featureDurationWeeks(f)

    if (manualStartWeeks.has(fId)) {
      const sw = manualStartWeeks.get(fId)!
      startWeeks.set(fId, sw)
      finishWeeks.set(fId, sw + dur)
    } else {
      let earliest = f.timelineStartWeek ?? epic.timelineStartWeek ?? 0
      for (const predId of predecessors.get(fId) ?? []) {
        const predFinish = finishWeeks.get(predId) ?? 0
        if (predFinish > earliest) earliest = predFinish
      }
      startWeeks.set(fId, earliest)
      finishWeeks.set(fId, earliest + dur)
    }

    for (const succId of adjList.get(fId) ?? []) {
      const newDeg = (inDegree.get(succId) ?? 1) - 1
      inDegree.set(succId, newDeg)
      if (newDeg === 0) queue.push({ priority: featurePriority(succId), id: succId })
    }
  }

  // Fallback: features not processed (cycle / unresolvable deps)
  if (processed.length < allFeatures.length) {
    const epicMaxFinish = new Map<string, number>()
    for (const f of allFeatures) {
      const fw = finishWeeks.get(f.id)
      if (fw === undefined) continue
      const prev = epicMaxFinish.get(f.epic.id) ?? 0
      if (fw > prev) epicMaxFinish.set(f.epic.id, fw)
    }
    for (const f of allFeatures) {
      if (startWeeks.has(f.id)) continue
      let earliest = f.timelineStartWeek ?? f.epic.timelineStartWeek ?? 0
      for (const prevEpic of sortedEpics) {
        if (prevEpic.order >= f.epic.order) break
        const prevFinish = epicMaxFinish.get(prevEpic.id) ?? 0
        if (prevFinish > earliest) earliest = prevFinish
      }
      startWeeks.set(f.id, earliest)
      finishWeeks.set(f.id, earliest + featureDurationWeeks(f))
      processed.push(f.id)
      const cur = epicMaxFinish.get(f.epic.id) ?? 0
      const newFinish = earliest + featureDurationWeeks(f)
      if (newFinish > cur) epicMaxFinish.set(f.epic.id, newFinish)
    }
  }

  // ── Resource-levelling simulation ─────────────────────────────────────────
  const weeklyConsumptionMap = new Map<string, number>()

  if (resourceLevel) {
    function featureResourceHours(feature: typeof allFeatures[0]): Map<string, number> {
      const result = new Map<string, number>()
      for (const story of feature.userStories) {
        if (story.isActive === false) continue
        for (const task of story.tasks) {
          const rtId = task.resourceTypeId ?? '_unassigned'
          const hpd = task.resourceType?.hoursPerDay ?? fallbackHoursPerDay
          const hours = (task.durationDays ?? (task.hoursEffort / hpd)) * hpd
          result.set(rtId, (result.get(rtId) ?? 0) + hours)
        }
      }
      return result
    }

    const featureResourceHoursCache = new Map<string, Map<string, number>>()
    for (const fId of processed) {
      featureResourceHoursCache.set(fId, featureResourceHours(featureMap.get(fId)!))
    }

    const rtById = new Map(resourceTypes.map(rt => [rt.id, rt]))
    const allRtIds = [...resourceTypes.map(rt => rt.id), '_unassigned']

    const remainingHours = new Map<string, Map<string, number>>()
    for (const fId of processed) {
      if (manualStartWeeks.has(fId)) continue
      remainingHours.set(fId, new Map(featureResourceHoursCache.get(fId)!))
    }

    const simStart = new Map<string, number>()
    const simDone = new Map<string, number>()

    for (const [fId, sw] of manualStartWeeks) {
      simStart.set(fId, sw)
      const storedDur = manualDurationWeeks.get(fId)
      simDone.set(fId, sw + (storedDur !== undefined ? storedDur : featureDurationWeeks(featureMap.get(fId)!)))
    }

    const STEP = 0.2
    const MAX_WEEKS = 200
    const autoFeatures = processed.filter(fId => !manualStartWeeks.has(fId))
    const unfinished = new Set(autoFeatures)

    let t = 0
    while (unfinished.size > 0 && t < MAX_WEEKS) {
      for (const fId of unfinished) {
        if (simStart.has(fId)) continue
        const f = featureMap.get(fId)!
        const epicStart = f.timelineStartWeek ?? f.epic.timelineStartWeek ?? 0
        if (t < epicStart) continue
        const predsAllDone = (predecessors.get(fId) ?? []).every(predId => {
          const done = simDone.get(predId)
          return done !== undefined && done <= t
        })
        if (predsAllDone) {
          const currentWeekForStart = Math.floor(t)
          const fHours = remainingHours.get(fId)
          if (fHours && fHours.size > 0) {
            const hasCapacity = [...fHours.keys()].some(rtId => {
              if (rtId === '_unassigned') return true
              const rt = rtById.get(rtId)
              return !rt || getWeeklyCapacity(rt, currentWeekForStart, fallbackHoursPerDay) > 0
            })
            if (!hasCapacity) continue
          }
          simStart.set(fId, t)
        }
      }

      const active = [...unfinished].filter(fId => simStart.has(fId))

      const currentWeek = Math.floor(t)
      for (const rtId of allRtIds) {
        const rt = rtById.get(rtId)
        const rtName = rt?.name ?? 'Unassigned'
        const hpd = rt?.hoursPerDay ?? fallbackHoursPerDay
        for (const [fId] of manualStartWeeks) {
          const fStart = simStart.get(fId)
          const fDone = simDone.get(fId)
          if (fStart === undefined || fDone === undefined || fDone <= fStart) continue
          if (t >= fStart && t < fDone) {
            const rtHours = featureResourceHoursCache.get(fId)!.get(rtId) ?? 0
            if (rtHours > 0) {
              const perStep = (rtHours / (fDone - fStart)) * STEP
              const consumptionKey = `${rtName}|${currentWeek}`
              weeklyConsumptionMap.set(consumptionKey, (weeklyConsumptionMap.get(consumptionKey) ?? 0) + perStep / hpd)
            }
          }
        }
      }

      if (active.length === 0) { t += STEP; continue }

      for (const fId of active) {
        if (remainingHours.get(fId)?.size === 0) {
          if (!simDone.has(fId)) {
            simDone.set(fId, t + STEP)
            unfinished.delete(fId)
          }
        }
      }

      for (const rtId of allRtIds) {
        const rt = rtById.get(rtId)
        const capPerWeek = rt
          ? getWeeklyCapacity(rt, currentWeek, fallbackHoursPerDay)
          : fallbackHoursPerDay * 5
        let capPerStep = capPerWeek * STEP
        const rtName = rt?.name ?? 'Unassigned'
        const hpd = rt?.hoursPerDay ?? fallbackHoursPerDay

        for (const [fId] of manualStartWeeks) {
          const fStart = simStart.get(fId)
          const fDone = simDone.get(fId)
          if (fStart === undefined || fDone === undefined || fDone <= fStart) continue
          if (t >= fStart && t < fDone) {
            const rtHours = featureResourceHoursCache.get(fId)!.get(rtId) ?? 0
            if (rtHours > 0) {
              const perStep = (rtHours / (fDone - fStart)) * STEP
              capPerStep = Math.max(0, capPerStep - perStep)
            }
          }
        }

        const competing = active.filter(fId => (remainingHours.get(fId)?.get(rtId) ?? 0) > 0.001)
        if (competing.length === 0) continue

        const totalRemaining = competing.reduce((s, fId) => s + (remainingHours.get(fId)!.get(rtId) ?? 0), 0)

        for (const fId of competing) {
          const rem = remainingHours.get(fId)!.get(rtId)!
          const actualAllocated = Math.min((rem / totalRemaining) * capPerStep, rem)
          const consumptionKey = `${rtName}|${currentWeek}`
          weeklyConsumptionMap.set(consumptionKey, (weeklyConsumptionMap.get(consumptionKey) ?? 0) + actualAllocated / hpd)
          remainingHours.get(fId)!.set(rtId, Math.max(0, rem - actualAllocated))
        }
      }

      for (const fId of active) {
        const allDone = [...(remainingHours.get(fId)?.values() ?? [])].every(h => h <= 0.001)
        if (allDone) {
          simDone.set(fId, t + STEP)
          unfinished.delete(fId)
        }
      }

      t += STEP
      t = Math.round(t * 5) / 5
    }

    // Apply simulation results back to startWeeks/finishWeeks
    for (const fId of processed) {
      const sw = simStart.get(fId) ?? startWeeks.get(fId) ?? 0
      const doneW = simDone.get(fId)
      const dur = doneW !== undefined ? doneW - sw : featureDurationWeeks(featureMap.get(fId)!)
      startWeeks.set(fId, sw)
      finishWeeks.set(fId, sw + dur)
    }
  }

  // ── Story-level scheduling ─────────────────────────────────────────────────
  const allStories = epics.flatMap(epic =>
    epic.features.flatMap(feature =>
      feature.userStories
        .filter(s => s.isActive !== false)
        .map(s => ({ ...s, feature: { ...feature, epic } }))
    )
  )

  function storyResourceHours(story: typeof allStories[0]): Map<string, number> {
    const result = new Map<string, number>()
    for (const task of story.tasks) {
      const rtId = task.resourceTypeId ?? '_unassigned'
      const hpd = task.resourceType?.hoursPerDay ?? fallbackHoursPerDay
      const hours = (task.durationDays ?? (task.hoursEffort / hpd)) * hpd
      result.set(rtId, (result.get(rtId) ?? 0) + hours)
    }
    return result
  }

  function storyTotalHours(story: typeof allStories[0]): number {
    return [...storyResourceHours(story).values()].reduce((a, b) => a + b, 0)
  }

  const storyScheduled = new Map<string, { startWeek: number; durationWeeks: number; isManual: boolean }>()

  // Pass 1: manual-pinned stories
  for (const story of allStories) {
    if (manualStoryWeeks.has(story.id)) {
      const sw = manualStoryWeeks.get(story.id)!
      const totalHours = storyTotalHours(story)
      const dur = Math.max(0.2, totalHours / fallbackHoursPerDay / 5)
      storyScheduled.set(story.id, { startWeek: sw, durationWeeks: dur, isManual: true })
    }
  }

  // Pass 2: proportional sequential scheduling per feature
  const storiesByFeature = new Map<string, typeof allStories>()
  for (const story of allStories) {
    const fId = story.feature.id
    if (!storiesByFeature.has(fId)) storiesByFeature.set(fId, [])
    storiesByFeature.get(fId)!.push(story)
  }
  for (const stories of storiesByFeature.values()) {
    stories.sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
  }

  for (const [fId, stories] of storiesByFeature) {
    const featureStart = startWeeks.get(fId) ?? 0
    const featureDone = finishWeeks.get(fId) ?? (featureStart + 1)
    const featureDuration = Math.max(0.2, featureDone - featureStart)

    const siblings = stories.filter(s => !manualStoryWeeks.has(s.id))
    if (siblings.length === 0) continue

    const totalFeatureHours = siblings.reduce((sum, s) => sum + storyTotalHours(s), 0)

    let cursor = featureStart
    for (const sibling of siblings) {
      const hrs = storyTotalHours(sibling)
      const dur = totalFeatureHours > 0
        ? (hrs / totalFeatureHours) * featureDuration
        : featureDuration / Math.max(1, siblings.length)
      const safeDur = Math.max(0.2, dur)
      storyScheduled.set(sibling.id, { startWeek: cursor, durationWeeks: safeDur, isManual: false })
      cursor += safeDur
    }
  }

  // ── Parallel warnings ─────────────────────────────────────────────────────
  const scheduleEntries = processed.map(fId => {
    const f = featureMap.get(fId)!
    const sw = startWeeks.get(fId)!
    const durationWeeks = (finishWeeks.get(fId)! - sw)
    return {
      featureId: fId,
      startWeek: sw,
      durationWeeks,
      feature: { epic: { id: f.epic.id, name: f.epic.name, featureMode: f.epic.featureMode } },
    }
  })

  const parallelWarnings = computeParallelWarnings(
    fallbackHoursPerDay,
    scheduleEntries,
    allFeatures,
    resourceTypes,
  )

  // ── Assemble output ───────────────────────────────────────────────────────
  const featureSchedule = processed.map(fId => {
    const sw = startWeeks.get(fId)!
    const f = featureMap.get(fId)!
    const durationWeeks = (finishWeeks.get(fId) ?? (sw + featureDurationWeeks(f))) - sw
    return {
      featureId: fId,
      startWeek: sw,
      durationWeeks,
      isManual: manualStartWeeks.has(fId),
    }
  })

  const storySchedule = allStories
    .map(story => {
      const sched = storyScheduled.get(story.id)
      if (!sched) return null
      return { storyId: story.id, ...sched }
    })
    .filter((s): s is NonNullable<typeof s> => s !== null)

  return { featureSchedule, storySchedule, weeklyConsumptionMap, parallelWarnings }
}
