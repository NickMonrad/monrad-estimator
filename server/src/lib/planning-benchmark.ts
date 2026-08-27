import {
  getWeeklyCapacity,
  type SchedulerInput,
  type SchedulerOutput,
} from './scheduler.js'
import { effortDays } from '../utils/round.js'

export type PlanningQualityMetrics = {
  targetDurationWeeks: number
  achievedDurationWeeks: number
  effortByRole: Record<string, number>
  effortHoursByRole: Record<string, number>
  staffedCapacityHoursByRole: Record<string, number>
  staffedFteWeeksByRole: Record<string, number>
  peakStaffingFteByRole: Record<string, number>
  peakStaffingFte: number
  utilisationPctByRole: Record<string, number | null>
  capacityViolations: Array<{ resourceTypeId: string; week: number; demandDays: number; capacityDays: number }>
  dependencyViolations: Array<{ featureId: string; dependsOnId: string }>
  demandWeeksByRole: Record<string, number[]>
  rampShapeByRole: Record<string, {
    firstDemandWeek: number | null
    lastDemandWeek: number | null
    peakDemandFte: number
    activeWeeks: number
    startTransitions: number
    endTransitions: number
  }>
  deterministicFingerprint: string
}

const EPSILON = 1e-8

function round(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000
}

function sortedRecord(entries: Iterable<[string, number]>): Record<string, number> {
  return Object.fromEntries(
    [...entries]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => [key, round(value)]),
  )
}

function taskEffortByRole(input: SchedulerInput): Map<string, { hours: number; days: number }> {
  const totals = new Map<string, { hours: number; days: number }>()
  for (const epic of input.epics) {
    for (const feature of epic.features) {
      if (feature.isActive === false) continue
      for (const story of feature.userStories) {
        if (story.isActive === false) continue
        for (const task of story.tasks) {
          if (!task.resourceTypeId) continue
          const hpd = task.resourceType?.hoursPerDay ?? input.project.hoursPerDay
          const total = totals.get(task.resourceTypeId) ?? { hours: 0, days: 0 }
          total.hours += task.hoursEffort
          total.days += effortDays(task.hoursEffort, hpd)
          totals.set(task.resourceTypeId, total)
        }
      }
    }
  }
  return totals
}

function scheduleEnd(output: SchedulerOutput): number {
  return output.featureSchedule.reduce(
    (end, entry) => Math.max(end, entry.startWeek + entry.durationWeeks),
    0,
  )
}

function demandByRoleAndWeek(
  output: SchedulerOutput,
): Map<string, Map<number, number>> {
  const demand = new Map<string, Map<number, number>>()
  for (const [key, days] of output.weeklyConsumptionMap) {
    const separator = key.lastIndexOf('|')
    const roleId = key.slice(0, separator)
    const week = Number(key.slice(separator + 1))
    if (!Number.isFinite(week) || days <= 0) continue
    const byWeek = demand.get(roleId) ?? new Map<number, number>()
    byWeek.set(week, (byWeek.get(week) ?? 0) + days)
    demand.set(roleId, byWeek)
  }
  return demand
}

function stableOutputFingerprint(output: SchedulerOutput): string {
  return JSON.stringify({
    featureSchedule: output.featureSchedule,
    storySchedule: output.storySchedule,
    weeklyConsumption: [...output.weeklyConsumptionMap.entries()].sort(([a], [b]) => a.localeCompare(b)),
    parallelWarnings: output.parallelWarnings,
  })
}

export function measurePlanningQuality(
  input: SchedulerInput,
  output: SchedulerOutput,
  targetDurationWeeks: number,
): PlanningQualityMetrics {
  const effort = taskEffortByRole(input)
  const demand = demandByRoleAndWeek(output)
  const achievedDurationWeeks = scheduleEnd(output)
  const horizonWeeks = Math.ceil(Math.max(achievedDurationWeeks, targetDurationWeeks))
  const rtById = new Map(input.resourceTypes.map(rt => [rt.id, rt]))

  const staffedCapacityHours = new Map<string, number>()
  const peakStaffing = new Map<string, number>()
  const utilisation = new Map<string, number | null>()
  const capacityViolations: PlanningQualityMetrics['capacityViolations'] = []
  const demandWeeksByRole = new Map<string, number[]>()
  const rampShapeByRole: PlanningQualityMetrics['rampShapeByRole'] = {}

  for (const rt of input.resourceTypes) {
    const hpd = rt.hoursPerDay ?? input.project.hoursPerDay
    const byWeek = demand.get(rt.id) ?? new Map<number, number>()
    const demandWeeks: number[] = []
    let capacityHours = 0
    let peakFte = 0
    let previousActive = false
    let startTransitions = 0
    let endTransitions = 0

    for (let week = 0; week < horizonWeeks; week++) {
      const capacityHoursThisWeek = getWeeklyCapacity(rt, week, input.project.hoursPerDay)
      const capacityDays = hpd > 0 ? capacityHoursThisWeek / hpd : 0
      const demandDays = byWeek.get(week) ?? 0
      const demandFte = demandDays / 5
      capacityHours += capacityHoursThisWeek
      peakFte = Math.max(peakFte, demandFte)
      if (demandDays > EPSILON) demandWeeks.push(week)

      const active = demandDays > EPSILON
      if (active && !previousActive) startTransitions++
      if (!active && previousActive) endTransitions++
      previousActive = active

      if (demandDays > capacityDays + EPSILON) {
        capacityViolations.push({
          resourceTypeId: rt.id,
          week,
          demandDays: round(demandDays),
          capacityDays: round(capacityDays),
        })
      }
    }

    if (previousActive) endTransitions++
    staffedCapacityHours.set(rt.id, capacityHours)
    peakStaffing.set(rt.id, peakFte)
    demandWeeksByRole.set(rt.id, demandWeeks)
    const roleEffort = effort.get(rt.id)
    utilisation.set(
      rt.id,
      capacityHours > EPSILON && roleEffort
        ? (roleEffort.hours / capacityHours) * 100
        : null,
    )
    rampShapeByRole[rt.id] = {
      firstDemandWeek: demandWeeks[0] ?? null,
      lastDemandWeek: demandWeeks.at(-1) ?? null,
      peakDemandFte: round(peakFte),
      activeWeeks: demandWeeks.length,
      startTransitions,
      endTransitions,
    }
  }

  const scheduleById = new Map(output.featureSchedule.map(entry => [entry.featureId, entry]))
  const dependencyViolations: PlanningQualityMetrics['dependencyViolations'] = []
  for (const epic of input.epics) {
    for (const feature of epic.features) {
      const entry = scheduleById.get(feature.id)
      if (!entry) continue
      for (const dependency of feature.dependencies ?? []) {
        const predecessor = scheduleById.get(dependency.dependsOnId)
        if (!predecessor) continue
        if (entry.startWeek + EPSILON < predecessor.startWeek + predecessor.durationWeeks) {
          dependencyViolations.push({ featureId: feature.id, dependsOnId: dependency.dependsOnId })
        }
      }
    }
  }

  const effortByRole = sortedRecord([...effort].map(([id, value]) => [id, value.days]))
  const effortHoursByRole = sortedRecord([...effort].map(([id, value]) => [id, value.hours]))
  const staffedCapacityHoursByRole = sortedRecord(staffedCapacityHours)
  const staffedFteWeeksByRole = sortedRecord(
    [...staffedCapacityHours].map(([id, hours]) => [id, hours / ((rtById.get(id)?.hoursPerDay ?? input.project.hoursPerDay) * 5)]),
  )
  const peakStaffingFteByRole = sortedRecord(peakStaffing)
  const utilisationPctByRole = Object.fromEntries(
    [...utilisation]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([id, value]) => [id, value == null ? null : round(value)]),
  )
  const demandWeeks = Object.fromEntries(
    [...demandWeeksByRole]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([id, weeks]) => [id, weeks]),
  )
  const peakStaffingFte = Math.max(0, ...peakStaffing.values())

  return {
    targetDurationWeeks,
    achievedDurationWeeks: round(achievedDurationWeeks),
    effortByRole,
    effortHoursByRole,
    staffedCapacityHoursByRole,
    staffedFteWeeksByRole,
    peakStaffingFteByRole,
    peakStaffingFte: round(peakStaffingFte),
    utilisationPctByRole,
    capacityViolations,
    dependencyViolations,
    demandWeeksByRole: demandWeeks,
    rampShapeByRole,
    deterministicFingerprint: stableOutputFingerprint(output),
  }
}

export function totalConsumedEffortDays(output: SchedulerOutput): number {
  let total = 0
  for (const days of output.weeklyConsumptionMap.values()) total += days
  return total
}

export function totalExpectedEffortDays(input: SchedulerInput): number {
  let total = 0
  for (const value of taskEffortByRole(input).values()) total += value.days
  return total
}
