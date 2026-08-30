import {
  getWeeklyCapacity,
  type SchedulerInput,
  type SchedulerOutput,
} from './scheduler.js'
import type { CapacityPlanConfig, CapacityPlanResult } from './capacity-planner.js'
import { runSAPlanner, type SAPlannerResult } from './sa-planner.js'
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

  const totalPeakDemandFteByWeek = new Map<number, number>()
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
      totalPeakDemandFteByWeek.set(week, (totalPeakDemandFteByWeek.get(week) ?? 0) + demandFte)
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
  const dependencyViolationKeys = new Set<string>()
  const addDependencyViolation = (featureId: string, dependsOnId: string) => {
    const key = `${featureId}|${dependsOnId}`
    if (dependencyViolationKeys.has(key)) return
    dependencyViolationKeys.add(key)
    dependencyViolations.push({ featureId, dependsOnId })
  }
  const checkDependency = (featureId: string, dependsOnId: string) => {
    const entry = scheduleById.get(featureId)
    const predecessor = scheduleById.get(dependsOnId)
    if (!entry || !predecessor) return
    if (entry.startWeek + EPSILON < predecessor.startWeek + predecessor.durationWeeks) {
      addDependencyViolation(featureId, dependsOnId)
    }
  }

  for (const epic of input.epics) {
    for (const feature of epic.features) {
      for (const dependency of feature.dependencies ?? []) {
        checkDependency(feature.id, dependency.dependsOnId)
      }
    }
  }

  const epicById = new Map(input.epics.map(epic => [epic.id, epic]))
  for (const dependency of input.epicDeps) {
    const predecessorEpic = epicById.get(dependency.dependsOnId)
    const dependentEpic = epicById.get(dependency.epicId)
    if (!predecessorEpic || !dependentEpic) continue
    for (const predecessor of predecessorEpic.features) {
      for (const dependent of dependentEpic.features) {
        checkDependency(dependent.id, predecessor.id)
      }
    }
  }
  const sortedEpics = [...input.epics].sort((a, b) => a.order - b.order)
  for (let index = 1; index < sortedEpics.length; index++) {
    const predecessorEpic = sortedEpics[index - 1]
    const dependentEpic = sortedEpics[index]
    if (predecessorEpic.features.length === 0 || dependentEpic.features.length === 0) continue
    if (dependentEpic.timelineStartWeek != null) continue
    if ((dependentEpic.scheduleMode ?? 'sequential') === 'parallel') continue

    const dependentTargets = (dependentEpic.featureMode ?? 'sequential') === 'sequential'
      ? [dependentEpic.features[0]]
      : dependentEpic.features
    for (const predecessor of predecessorEpic.features) {
      const hasCrossEpicDependency = (predecessor.dependencies ?? []).some(dependency =>
        dependentEpic.features.some(feature => feature.id === dependency.dependsOnId),
      )
      if (hasCrossEpicDependency) continue
      for (const dependent of dependentTargets) {
        checkDependency(dependent.id, predecessor.id)
      }
    }
  }

  const manualFeatureIds = new Set(input.manualFeatureEntries.map(entry => entry.featureId))

  for (const epic of input.epics) {
    if ((epic.featureMode ?? 'sequential') !== 'sequential') continue
    const sortedFeatures = [...epic.features].sort((a, b) => a.order - b.order)
    for (let index = 1; index < sortedFeatures.length; index++) {
      const predecessor = sortedFeatures[index - 1]
      if (manualFeatureIds.has(predecessor.id)) continue
      checkDependency(sortedFeatures[index].id, predecessor.id)
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
  const peakStaffingFte = Math.max(0, ...totalPeakDemandFteByWeek.values())

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

export type CapacityPlanQualityMetrics = {
  targetDurationWeeks: number
  achievedDurationWeeks: number | null
  effortByRole: Record<string, number>
  effortHoursByRole: Record<string, number>
  scheduledEffortByRole: Record<string, number>
  scheduledEffortHoursByRole: Record<string, number>
  staffedCapacityHoursByRole: Record<string, number>
  staffedFteWeeksByRole: Record<string, number>
  peakStaffingFteByRole: Record<string, number>
  peakStaffingFte: number | null
  utilisationPctByRole: Record<string, number | null>
  capacityViolations: Array<{ resourceTypeId: string; periodIndex: number; peakDemandFte: number; staffedFte: number }>
  dependencyViolations: Array<{ featureId: string; dependsOnId: string }>
  rampShapeByRole: Record<string, {
    firstDemandPeriod: number | null
    lastDemandPeriod: number | null
    peakDemandFte: number
    activePeriods: number
    startTransitions: number
    endTransitions: number
  }>
  failureReason: string | null
  deterministicFingerprint: string | null
}

export function runCapacityPlanSchedule(
  input: SchedulerInput,
  config: CapacityPlanConfig,
): SAPlannerResult {
  return runSAPlanner(input, {
    targetDurationWeeks: config.targetDurationWeeks,
    maxParallelismPerFeature: config.maxParallelismPerFeature,
    maxCap: config.maxCap,
    maxConcurrentEpics: config.maxConcurrentEpics,
    iterations: 10000,
    initialTemp: 100,
    coolingRate: 0.995,
  })
}

function scheduledOutputEffortByRole(
  input: SchedulerInput,
  schedule: SAPlannerResult | null,
): Map<string, { days: number; hours: number }> {
  const totals = new Map<string, { days: number; hours: number }>()
  if (!schedule) return totals

  const resourceTypes = new Map(input.resourceTypes.map(rt => [rt.id, rt]))
  for (const [resourceTypeId, weeklyDemand] of schedule.weeklyDemandByResourceType) {
    const days = weeklyDemand.reduce((total, demand) => total + (demand ?? 0), 0)
    if (days <= EPSILON) continue
    const hoursPerDay = resourceTypes.get(resourceTypeId)?.hoursPerDay ?? input.project.hoursPerDay
    totals.set(resourceTypeId, { days, hours: days * hoursPerDay })
  }
  return totals
}

function featureTiming(schedule: Pick<SAPlannerResult, 'weeklyAllocationsByFeature'>): Map<string, { startWeek: number; completionWeek: number }> {
  const timings = new Map<string, { startWeek: number; completionWeek: number }>()
  for (const [featureId, allocations] of schedule.weeklyAllocationsByFeature) {
    let startWeek: number | null = null
    let completionWeek: number | null = null
    for (const [week, resources] of allocations) {
      const allocatedDays = [...resources.values()].reduce((total, days) => total + days, 0)
      if (allocatedDays <= EPSILON) continue
      startWeek = startWeek == null ? week : Math.min(startWeek, week)
      completionWeek = completionWeek == null ? week : Math.max(completionWeek, week)
    }
    if (startWeek != null && completionWeek != null) timings.set(featureId, { startWeek, completionWeek })
  }
  return timings
}

export function capacityDependencyViolations(
  input: SchedulerInput,
  schedule: Pick<SAPlannerResult, 'weeklyAllocationsByFeature'>,
): Array<{ featureId: string; dependsOnId: string }> {
  const timings = featureTiming(schedule)
  const violations: Array<{ featureId: string; dependsOnId: string }> = []
  const seen = new Set<string>()
  const check = (featureId: string, dependsOnId: string) => {
    const feature = timings.get(featureId)
    const dependency = timings.get(dependsOnId)
    if (!feature || !dependency || feature.startWeek > dependency.completionWeek) return
    const key = `${featureId}|${dependsOnId}`
    if (seen.has(key)) return
    seen.add(key)
    violations.push({ featureId, dependsOnId })
  }
  for (const epic of input.epics) {
    for (const feature of epic.features) {
      for (const dependency of feature.dependencies ?? []) check(feature.id, dependency.dependsOnId)
    }
  }
  const epicById = new Map(input.epics.map(epic => [epic.id, epic]))
  for (const dependency of input.epicDeps) {
    const predecessor = epicById.get(dependency.dependsOnId)
    const dependent = epicById.get(dependency.epicId)
    if (!predecessor || !dependent) continue
    for (const predecessorFeature of predecessor.features) {
      for (const dependentFeature of dependent.features) check(dependentFeature.id, predecessorFeature.id)
    }
  }
  for (const epic of input.epics) {
    if ((epic.featureMode ?? 'sequential') !== 'sequential') continue
    const features = [...epic.features].sort((a, b) => a.order - b.order)
    for (let index = 1; index < features.length; index++) check(features[index].id, features[index - 1].id)
  }
  return violations
}


export function measureCapacityPlanQuality(
  input: SchedulerInput,
  targetDurationWeeks: number,
  result: CapacityPlanResult | null,
  schedule: SAPlannerResult | null,
  failureReason: string | null = null,
): CapacityPlanQualityMetrics {
  const effort = taskEffortByRole(input)
  const scheduledEffort = scheduledOutputEffortByRole(input, schedule)
  const effortByRole = sortedRecord([...effort].map(([id, value]) => [id, value.days]))
  const effortHoursByRole = sortedRecord([...effort].map(([id, value]) => [id, value.hours]))
  const scheduledEffortByRole = sortedRecord([...scheduledEffort].map(([id, value]) => [id, value.days]))
  const scheduledEffortHoursByRole = sortedRecord([...scheduledEffort].map(([id, value]) => [id, value.hours]))
  const staffedCapacityHours = new Map<string, number>()
  const staffedFteWeeks = new Map<string, number>()
  const peakStaffing = new Map<string, number>()
  const demandFteWeeks = new Map<string, number>()
  const demandPeriods = new Map<string, number[]>()
  const capacityViolations: CapacityPlanQualityMetrics['capacityViolations'] = []
  const rampShapeByRole: CapacityPlanQualityMetrics['rampShapeByRole'] = {}

  if (result) {
    for (const period of result.periods) {
      const periodWeeks = period.endWeek - period.startWeek
      for (const resource of period.resources) {
        const hpd = input.resourceTypes.find(rt => rt.id === resource.resourceTypeId)?.hoursPerDay ?? input.project.hoursPerDay
        const capacityFteWeeks = resource.headcount * periodWeeks
        staffedFteWeeks.set(resource.resourceTypeId, (staffedFteWeeks.get(resource.resourceTypeId) ?? 0) + capacityFteWeeks)
        staffedCapacityHours.set(resource.resourceTypeId, (staffedCapacityHours.get(resource.resourceTypeId) ?? 0) + capacityFteWeeks * hpd * 5)
        peakStaffing.set(resource.resourceTypeId, Math.max(peakStaffing.get(resource.resourceTypeId) ?? 0, resource.headcount))
        demandFteWeeks.set(resource.resourceTypeId, (demandFteWeeks.get(resource.resourceTypeId) ?? 0) + resource.avgDemandFTE * periodWeeks)
        if (resource.avgDemandFTE > EPSILON) (demandPeriods.get(resource.resourceTypeId) ?? (demandPeriods.set(resource.resourceTypeId, []), demandPeriods.get(resource.resourceTypeId)!)).push(period.periodIndex)
        if (resource.peakDemandFTE > resource.headcount + EPSILON) {
          capacityViolations.push({ resourceTypeId: resource.resourceTypeId, periodIndex: period.periodIndex, peakDemandFte: resource.peakDemandFTE, staffedFte: resource.headcount })
        }
      }
    }
    for (const rt of input.resourceTypes) {
      const periods = demandPeriods.get(rt.id) ?? []
      const active = new Set(periods)
      let startTransitions = 0
      let endTransitions = 0
      let previous = false
      for (let index = 0; index < result.periods.length; index++) {
        const current = active.has(index)
        if (current && !previous) startTransitions++
        if (!current && previous) endTransitions++
        previous = current
      }
      if (previous) endTransitions++
      const peakDemandFte = Math.max(0, ...result.periods.flatMap(period => period.resources.filter(resource => resource.resourceTypeId === rt.id).map(resource => resource.peakDemandFTE)))
      rampShapeByRole[rt.id] = { firstDemandPeriod: periods[0] ?? null, lastDemandPeriod: periods.at(-1) ?? null, peakDemandFte: round(peakDemandFte), activePeriods: periods.length, startTransitions, endTransitions }
    }
  }

  const staffedCapacityHoursByRole = sortedRecord(staffedCapacityHours)
  const staffedFteWeeksByRole = sortedRecord(staffedFteWeeks)
  const peakStaffingFteByRole = sortedRecord(peakStaffing)
  const utilisationPctByRole = Object.fromEntries(
    [...staffedFteWeeks]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([id, capacity]) => [id, capacity > EPSILON ? round((demandFteWeeks.get(id) ?? 0) / capacity * 100) : null]),
  )
  const fingerprint = result
    ? JSON.stringify({ periods: result.periods, epicStartWeeks: [...result.levellingResult.epicStartWeeks], featureStartWeeks: [...result.levellingResult.featureStartWeeks] })
    : null

  return {
    targetDurationWeeks,
    achievedDurationWeeks: result?.deliveryWeeks ?? null,
    effortByRole,
    effortHoursByRole,
    scheduledEffortByRole,
    scheduledEffortHoursByRole,
    staffedCapacityHoursByRole,
    staffedFteWeeksByRole,
    peakStaffingFteByRole,
    peakStaffingFte: result?.peakHeadcount ?? null,
    utilisationPctByRole,
    capacityViolations,
    dependencyViolations: result && schedule ? capacityDependencyViolations(input, schedule) : [],
    rampShapeByRole,
    failureReason,
    deterministicFingerprint: fingerprint,
  }
}
