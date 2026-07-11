export type CapacityPlanPeriodInput = {
  periodIndex: number
  startWeek: number
  endWeek: number
  entries: Array<{
    resourceTypeId: string
    headcount: number
  }>
}

export type CapacityPlanSlotWindow = {
  startWeek: number
  endWeek: number
  allocationPercent: number
}

export type MaterializedCapacityPlanResource = {
  resourceTypeId: string
  totalDays: number
  weeklyHeadcount: Map<number, number>
  slotWindows: CapacityPlanSlotWindow[]
  resourceTrajectories: CapacityPlanResourceTrajectory[]
  startWeek: number | null
  endWeek: number | null
}

export type CapacityPlanResourceTrajectory = {
  trajectoryIndex: number
  segments: CapacityPlanSlotWindow[]
}

type CapacityPlanNamedResourceLike = {
  startWeek: number | null
  endWeek: number | null
  allocationPercent?: number | null
  allocationMode?: string | null
}

const HEADCOUNT_QUANTUM = 0.25
const FLOAT_EPSILON = 0.000001

function quantizeUnits(headcount: number): number {
  if (!Number.isFinite(headcount) || headcount <= 0) return 0
  return Math.max(0, Math.round(headcount / HEADCOUNT_QUANTUM))
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}

function deriveSlotWindows(
  periods: Array<{ periodIndex: number; startWeek: number; endWeek: number; headcount: number }>,
): CapacityPlanSlotWindow[] {
  const sortedPeriods = [...periods].sort((a, b) => a.periodIndex - b.periodIndex)
  const maxUnits = Math.max(0, ...sortedPeriods.map(period => quantizeUnits(period.headcount)))
  const quantumWindows: CapacityPlanSlotWindow[] = []

  for (let unit = 1; unit <= maxUnits; unit++) {
    let currentWindow: CapacityPlanSlotWindow | null = null

    for (const period of sortedPeriods) {
      const isActive = quantizeUnits(period.headcount) >= unit
      const inclusiveEndWeek = period.endWeek - 1

      if (!isActive || inclusiveEndWeek < period.startWeek) {
        if (currentWindow) {
          quantumWindows.push(currentWindow)
          currentWindow = null
        }
        continue
      }

      if (!currentWindow) {
        currentWindow = {
          startWeek: period.startWeek,
          endWeek: inclusiveEndWeek,
          allocationPercent: HEADCOUNT_QUANTUM * 100,
        }
        continue
      }

      if (period.startWeek <= currentWindow.endWeek + 1) {
        currentWindow.endWeek = inclusiveEndWeek
        continue
      }

      quantumWindows.push(currentWindow)
      currentWindow = {
        startWeek: period.startWeek,
        endWeek: inclusiveEndWeek,
        allocationPercent: HEADCOUNT_QUANTUM * 100,
      }
    }

    if (currentWindow) quantumWindows.push(currentWindow)
  }

  const grouped = new Map<string, number>()

  for (const window of quantumWindows) {
    const key = `${window.startWeek}:${window.endWeek}`
    grouped.set(key, (grouped.get(key) ?? 0) + window.allocationPercent)
  }

  return Array.from(grouped.entries())
    .flatMap(([key, totalAllocationPercent]) => {
      const [startWeekStr, endWeekStr] = key.split(':')
      const startWeek = Number(startWeekStr)
      const endWeek = Number(endWeekStr)
      const windows: CapacityPlanSlotWindow[] = []
      let remaining = round2(totalAllocationPercent)

      while (remaining > FLOAT_EPSILON) {
        const allocationPercent = Math.min(100, remaining)
        windows.push({
          startWeek,
          endWeek,
          allocationPercent: round2(allocationPercent),
        })
        remaining = round2(remaining - allocationPercent)
      }

      return windows
    })
    .sort((a, b) => (
      a.startWeek - b.startWeek ||
      a.endWeek - b.endWeek ||
      b.allocationPercent - a.allocationPercent
    ))
}

export function materializeCapacityPlanResources(
  periods: CapacityPlanPeriodInput[],
): Map<string, MaterializedCapacityPlanResource> {
  const resourceTypeIds = new Set(periods.flatMap(period => period.entries.map(entry => entry.resourceTypeId)))
  const materialized = new Map<string, MaterializedCapacityPlanResource>()

  for (const resourceTypeId of resourceTypeIds) {
    const rtPeriods = periods.map(period => ({
      periodIndex: period.periodIndex,
      startWeek: period.startWeek,
      endWeek: period.endWeek,
      headcount: period.entries.find(entry => entry.resourceTypeId === resourceTypeId)?.headcount ?? 0,
    }))

    const resourceTrajectories = materializeResourceTrajectories(rtPeriods)

    const weeklyHeadcount = new Map<number, number>()
    let totalDays = 0

    for (const period of rtPeriods) {
      const durationWeeks = Math.max(0, period.endWeek - period.startWeek)
      totalDays += period.headcount * durationWeeks * 5
      for (let week = period.startWeek; week < period.endWeek; week++) {
        weeklyHeadcount.set(week, period.headcount)
      }
    }

    const slotWindows = deriveSlotWindows(rtPeriods)
    const firstWeek = weeklyHeadcount.size > 0 ? Math.min(...weeklyHeadcount.keys()) : null
    const lastWeek = weeklyHeadcount.size > 0 ? Math.max(...weeklyHeadcount.keys()) : null

    materialized.set(resourceTypeId, {
      resourceTypeId,
      totalDays,
      weeklyHeadcount,
      slotWindows,
      resourceTrajectories,
      startWeek: firstWeek,
      endWeek: lastWeek,
    })
  }

  return materialized
}

export function materializeResourceTrajectories(
  periods: Array<{ periodIndex: number; startWeek: number; endWeek: number; headcount: number }>,
): CapacityPlanResourceTrajectory[] {
  const sortedPeriods = [...periods].sort((a, b) => a.periodIndex - b.periodIndex)
  const maxUnits = Math.max(0, ...sortedPeriods.map(p => quantizeUnits(p.headcount)))
  const TRAJECTORY_UNITS = 4
  const trajectoryCount = Math.ceil(maxUnits / TRAJECTORY_UNITS)

  if (trajectoryCount === 0) return []

  const trajectories: CapacityPlanResourceTrajectory[] = []

  for (let t = 0; t < trajectoryCount; t++) {
    const firstUnit = t * TRAJECTORY_UNITS
    const unitsInTrajectory = Math.min(TRAJECTORY_UNITS, maxUnits - firstUnit)
    if (unitsInTrajectory <= 0) continue

    const segments: CapacityPlanSlotWindow[] = []
    let current: CapacityPlanSlotWindow | null = null

    for (const period of sortedPeriods) {
      const periodUnits = quantizeUnits(period.headcount)
      const activeUnits = Math.max(0, Math.min(unitsInTrajectory, periodUnits - firstUnit))
      const activePercent = round2((activeUnits / unitsInTrajectory) * 100)
      const inclusiveEndWeek = period.endWeek - 1

      if (activePercent <= FLOAT_EPSILON || inclusiveEndWeek < period.startWeek) {
        if (current) { segments.push(current); current = null }
        continue
      }

      if (!current) {
        current = { startWeek: period.startWeek, endWeek: inclusiveEndWeek, allocationPercent: round2(activePercent) }
      } else if (
        Math.abs(activePercent - current.allocationPercent) <= FLOAT_EPSILON &&
        period.startWeek <= current.endWeek + 1
      ) {
        current.endWeek = inclusiveEndWeek
      } else {
        segments.push(current)
        current = { startWeek: period.startWeek, endWeek: inclusiveEndWeek, allocationPercent: round2(activePercent) }
      }
    }

    if (current) segments.push(current)
    if (segments.length > 0) trajectories.push({ trajectoryIndex: t, segments })
  }

  return trajectories
}

export function computeDefaultPercentForSegments(segments: CapacityPlanSlotWindow[]): number | null {
  if (segments.length === 0) return null
  if (segments.length === 1) return segments[0].allocationPercent
  const first = segments[0].allocationPercent
  const allSame = segments.every(s => Math.abs(s.allocationPercent - first) <= 0.000001)
  return allSame ? first : null
}

export type MaterializedTrajectorySlot = {
  id: string
  name: string
  trajectoryIndex: number
  slotWindows: CapacityPlanSlotWindow[]
  existingNamedResourceId: string | null
  synthetic: boolean
}

/**
 * Match resource trajectories to existing named resources by index.
 * Trajectory i maps to existing named resource i (if one exists).
 * Trajectories beyond existing count get generated planned-resource IDs.
 * Persisted NRs without a matching trajectory are NOT included here
 * (the caller preserves them independently).
 */
export function matchTrajectoriesToResources(
  trajectories: CapacityPlanResourceTrajectory[],
  resourceTypeId: string,
  resourceTypeName: string,
  existingNamedResources: Array<{ id: string; name: string }>,
): MaterializedTrajectorySlot[] {
  return trajectories.map((trajectory, idx) => {
    const existing = existingNamedResources[idx]
    return {
      id: existing?.id ?? `${resourceTypeId}-capacity-plan-${trajectory.trajectoryIndex + 1}`,
      name: existing?.name ?? `${resourceTypeName} ${trajectory.trajectoryIndex + 1}`,
      trajectoryIndex: trajectory.trajectoryIndex,
      slotWindows: trajectory.segments,
      existingNamedResourceId: existing?.id ?? null,
      synthetic: !existing,
    }
  })
}

export function shouldFallbackToActiveCapacityPlan(
  namedResources: CapacityPlanNamedResourceLike[],
  materialized?: MaterializedCapacityPlanResource,
): boolean {
  if (!materialized) return false
  if (namedResources.length === 0) return true
  if (namedResources.some(nr => nr.startWeek == null || nr.endWeek == null)) return true

  const minStartWeek = Math.min(...namedResources.map(nr => nr.startWeek ?? 0), materialized.startWeek ?? 0)
  const maxEndWeek = Math.max(...namedResources.map(nr => nr.endWeek ?? -1), materialized.endWeek ?? -1)

  for (let week = minStartWeek; week <= maxEndWeek; week++) {
    const persistedHeadcount = namedResources.reduce((count, nr) => (
      nr.startWeek != null && nr.endWeek != null && week >= nr.startWeek && week <= nr.endWeek
        ? count + (
            nr.allocationMode === 'CAPACITY_PLAN'
              ? (nr.allocationPercent ?? 100) / 100
              : 1
          )
        : count
    ), 0)
    const activePlanHeadcount = materialized.weeklyHeadcount.get(week) ?? 0
    if (Math.abs(persistedHeadcount - activePlanHeadcount) > FLOAT_EPSILON) return true
  }

  return false
}

// ─── Shared per-resource slot materialisation ───────────────────────────────

export type PerResourceSlotAssignment = {
  resourceTypeId: string
  /** One entry per slot window — existing named resources by index, otherwise deterministic generated IDs. */
  resourceSlots: Array<{
    id: string
    name: string
    slotWindows: CapacityPlanSlotWindow[]
    trajectoryIndex: number
    existingNamedResourceId: string | null
    synthetic: boolean
  }>
  /** Aggregate slot set for role-level presentation. */
  roleSlotWindows: CapacityPlanSlotWindow[]
}

/**
 * Materialise per-resource slot assignments from capacity plan resource trajectories.
 *
 * Each trajectory at index i maps to existing named resource i (if one exists).
 * Trajectories beyond existing count generate deterministic planned-resource
 * IDs matching the route convention: `${resourceTypeId}-capacity-plan-${i+1}`.
 *
 * The role-level aggregate contains the full segment set for presentation.
 * This function is **presentation-only** — it does not alter calculation/assignment semantics.
 */
export function materializePerResourceSlots(
  trajectories: CapacityPlanResourceTrajectory[],
  resourceTypeId: string,
  resourceTypeName: string,
  existingNamedResources: Array<{ id: string; name: string }>,
): PerResourceSlotAssignment {
  const matched = matchTrajectoriesToResources(trajectories, resourceTypeId, resourceTypeName, existingNamedResources)
  const resourceSlots = matched.map(m => ({
    id: m.id,
    name: m.name,
    slotWindows: m.slotWindows,
    trajectoryIndex: m.trajectoryIndex,
    existingNamedResourceId: m.existingNamedResourceId,
    synthetic: m.synthetic,
  }))
  return {
    resourceTypeId,
    resourceSlots,
    roleSlotWindows: trajectories.flatMap(t => t.segments),
  }
}
