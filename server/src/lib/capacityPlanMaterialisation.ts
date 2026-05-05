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
  startWeek: number | null
  endWeek: number | null
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
      startWeek: firstWeek,
      endWeek: lastWeek,
    })
  }

  return materialized
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
