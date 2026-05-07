import {
  shouldFallbackToActiveCapacityPlan,
  type MaterializedCapacityPlanResource,
} from './capacityPlanMaterialisation.js'

type AllocationMode = 'EFFORT' | 'TIMELINE' | 'FULL_PROJECT' | 'CAPACITY_PLAN'

type NamedResourceLike = {
  id: string
  name: string
  startWeek: number | null
  endWeek: number | null
  allocationPct?: number | null
  allocationMode?: string | null
  allocationPercent?: number | null
  allocationStartWeek?: number | null
  allocationEndWeek?: number | null
}

type ResourceTypeLike = {
  id: string
  name: string
  count: number
  allocationMode?: string | null
  namedResources?: NamedResourceLike[]
}

export type WeeklyDemandLike = {
  week: number
  resourceTypeName: string
  demandDays: number
}

export type NamedResourceAssignedWeek = {
  week: number
  days: number
  capacityDays: number
}

export type NamedResourceAssignedSegment = {
  startWeek: number
  endWeek: number
  days: number
}

export type DerivedNamedResourceAssignment = {
  id: string
  resourceTypeId: string
  resourceTypeName: string
  name: string
  allocationMode: string
  allocationPercent: number
  allocationStartWeek: number | null
  allocationEndWeek: number | null
  startWeek: number | null
  endWeek: number | null
  synthetic: boolean
  actualAllocatedDays: number
  actualAllocationStartWeek: number | null
  actualAllocationEndWeek: number | null
  actualAllocatedWeeks: NamedResourceAssignedWeek[]
  actualAllocationSegments: NamedResourceAssignedSegment[]
}

type DerivedResourceTypeAssignment = {
  resourceTypeId: string
  resourceTypeName: string
  actualAllocatedDays: number
  unallocatedDays: number
  namedResources: DerivedNamedResourceAssignment[]
}

type DeriveNamedResourceAssignmentsInput = {
  resourceTypes: ResourceTypeLike[]
  weeklyDemand: WeeklyDemandLike[]
  capacityPlanByRt?: Map<string, MaterializedCapacityPlanResource>
}

type WorkingNamedResource = DerivedNamedResourceAssignment & {
  order: number
  lastAssignedWeek: number | null
}

const FLOAT_EPSILON = 0.000001

const round2 = (value: number) => Math.round(value * 100) / 100

function toAllocationMode(mode: string | null | undefined): AllocationMode {
  return (mode as AllocationMode | null) ?? 'EFFORT'
}

function buildEffectiveNamedResources(
  resourceType: ResourceTypeLike,
  hasDemand: boolean,
  capacityPlanByRt: Map<string, MaterializedCapacityPlanResource>,
): WorkingNamedResource[] {
  const persistedNamedResources = resourceType.namedResources ?? []
  const mode = toAllocationMode(resourceType.allocationMode)
  const capacityPlanMaterialized = capacityPlanByRt.get(resourceType.id)
  const useCapacityPlanFallback =
    mode === 'CAPACITY_PLAN' &&
    shouldFallbackToActiveCapacityPlan(persistedNamedResources, capacityPlanMaterialized)

  const baseNamedResources = useCapacityPlanFallback && capacityPlanMaterialized
    ? capacityPlanMaterialized.slotWindows.map((window, idx) => {
        const existing = persistedNamedResources[idx]
        return {
          id: existing?.id ?? `${resourceType.id}-capacity-plan-${idx + 1}`,
          name: existing?.name ?? `${resourceType.name} ${idx + 1}`,
          startWeek: window.startWeek,
          endWeek: window.endWeek,
          allocationPct: window.allocationPercent,
          allocationMode: 'CAPACITY_PLAN',
          allocationPercent: window.allocationPercent,
          allocationStartWeek: null,
          allocationEndWeek: null,
          synthetic: !existing,
        }
      })
    : persistedNamedResources.map(namedResource => ({
        ...namedResource,
        synthetic: false,
      }))

  const effectiveCount = Math.max(resourceType.count ?? 0, baseNamedResources.length)
  const namedResources = hasDemand && effectiveCount > baseNamedResources.length
    ? [
        ...baseNamedResources,
        ...Array.from({ length: effectiveCount - baseNamedResources.length }, (_, offset) => ({
          id: `${resourceType.id}-synthetic-${baseNamedResources.length + offset + 1}`,
          name: `${resourceType.name} ${baseNamedResources.length + offset + 1}`,
          startWeek: null,
          endWeek: null,
          allocationPct: 100,
          allocationMode: 'EFFORT',
          allocationPercent: 100,
          allocationStartWeek: null,
          allocationEndWeek: null,
          synthetic: true,
        })),
      ]
    : baseNamedResources

  return namedResources.map((namedResource, order) => ({
    id: namedResource.id,
    resourceTypeId: resourceType.id,
    resourceTypeName: resourceType.name,
    name: namedResource.name,
    allocationMode: namedResource.allocationMode ?? 'EFFORT',
    allocationPercent: namedResource.allocationPercent ?? namedResource.allocationPct ?? 100,
    allocationStartWeek: namedResource.allocationStartWeek ?? null,
    allocationEndWeek: namedResource.allocationEndWeek ?? null,
    startWeek: namedResource.startWeek ?? null,
    endWeek: namedResource.endWeek ?? null,
    synthetic: namedResource.synthetic,
    actualAllocatedDays: 0,
    actualAllocationStartWeek: null,
    actualAllocationEndWeek: null,
    actualAllocatedWeeks: [],
    actualAllocationSegments: [],
    order,
    lastAssignedWeek: null,
  }))
}

function weeklyCapacityForNamedResource(
  namedResource: DerivedNamedResourceAssignment,
  week: number,
): number {
  const startWeek = namedResource.startWeek ?? 0
  const endWeek = namedResource.endWeek ?? Infinity

  if (week < startWeek || week > endWeek) return 0

  const mode = toAllocationMode(namedResource.allocationMode)
  const allocationPercent = namedResource.allocationPercent ?? 100

  if (mode === 'EFFORT') return 5
  if (mode === 'FULL_PROJECT' || mode === 'CAPACITY_PLAN') return 5 * (allocationPercent / 100)

  const effectiveStartWeek = namedResource.allocationStartWeek ?? namedResource.startWeek ?? 0
  const effectiveEndWeek =
    namedResource.allocationEndWeek ??
    namedResource.endWeek ??
    effectiveStartWeek

  if (week < effectiveStartWeek || week > effectiveEndWeek) return 0
  return 5 * (allocationPercent / 100)
}

function buildSegments(weeks: NamedResourceAssignedWeek[]): NamedResourceAssignedSegment[] {
  if (weeks.length === 0) return []

  const sortedWeeks = [...weeks].sort((a, b) => a.week - b.week)
  const segments: NamedResourceAssignedSegment[] = []
  let current: NamedResourceAssignedSegment = {
    startWeek: sortedWeeks[0].week,
    endWeek: sortedWeeks[0].week,
    days: round2(sortedWeeks[0].days),
  }

  for (let index = 1; index < sortedWeeks.length; index += 1) {
    const week = sortedWeeks[index]
    if (week.week === current.endWeek + 1) {
      current.endWeek = week.week
      current.days = round2(current.days + week.days)
      continue
    }

    segments.push(current)
    current = {
      startWeek: week.week,
      endWeek: week.week,
      days: round2(week.days),
    }
  }

  segments.push(current)
  return segments
}

export function deriveNamedResourceAssignments({
  resourceTypes,
  weeklyDemand,
  capacityPlanByRt = new Map<string, MaterializedCapacityPlanResource>(),
}: DeriveNamedResourceAssignmentsInput): Map<string, DerivedResourceTypeAssignment> {
  const weeklyDemandByResourceType = new Map<string, WeeklyDemandLike[]>()

  for (const row of weeklyDemand) {
    if (!Number.isFinite(row.demandDays) || row.demandDays <= 0) continue
    if (!weeklyDemandByResourceType.has(row.resourceTypeName)) {
      weeklyDemandByResourceType.set(row.resourceTypeName, [])
    }
    weeklyDemandByResourceType.get(row.resourceTypeName)!.push(row)
  }

  const assignmentsByResourceType = new Map<string, DerivedResourceTypeAssignment>()

  for (const resourceType of resourceTypes) {
    const demandRows = [...(weeklyDemandByResourceType.get(resourceType.name) ?? [])]
      .sort((a, b) => a.week - b.week)

    const namedResources = buildEffectiveNamedResources(
      resourceType,
      demandRows.length > 0,
      capacityPlanByRt,
    )

    let unallocatedDays = 0

    for (const demandRow of demandRows) {
      let remainingDemand = demandRow.demandDays
      const capacityRows = namedResources
        .map(namedResource => ({
          namedResource,
          capacityDays: weeklyCapacityForNamedResource(namedResource, demandRow.week),
        }))
        .filter(row => row.capacityDays > FLOAT_EPSILON)
        .sort((left, right) => {
          const leftContinues = left.namedResource.lastAssignedWeek === demandRow.week - 1 ? 1 : 0
          const rightContinues = right.namedResource.lastAssignedWeek === demandRow.week - 1 ? 1 : 0
          if (leftContinues !== rightContinues) return rightContinues - leftContinues
          if (left.namedResource.synthetic !== right.namedResource.synthetic) {
            return Number(left.namedResource.synthetic) - Number(right.namedResource.synthetic)
          }
          if (Math.abs(left.namedResource.actualAllocatedDays - right.namedResource.actualAllocatedDays) > FLOAT_EPSILON) {
            return left.namedResource.actualAllocatedDays - right.namedResource.actualAllocatedDays
          }
          return left.namedResource.order - right.namedResource.order
        })

      for (const { namedResource, capacityDays } of capacityRows) {
        if (remainingDemand <= FLOAT_EPSILON) break
        const allocatedDays = Math.min(remainingDemand, capacityDays)
        if (allocatedDays <= FLOAT_EPSILON) continue

        namedResource.actualAllocatedDays = round2(namedResource.actualAllocatedDays + allocatedDays)
        namedResource.lastAssignedWeek = demandRow.week
        namedResource.actualAllocatedWeeks.push({
          week: demandRow.week,
          days: round2(allocatedDays),
          capacityDays: round2(capacityDays),
        })
        remainingDemand -= allocatedDays
      }

      if (remainingDemand > FLOAT_EPSILON) {
        unallocatedDays = round2(unallocatedDays + remainingDemand)
      }
    }

    for (const namedResource of namedResources) {
      const sortedWeeks = [...namedResource.actualAllocatedWeeks].sort((a, b) => a.week - b.week)
      namedResource.actualAllocatedWeeks = sortedWeeks
      namedResource.actualAllocationSegments = buildSegments(sortedWeeks)
      namedResource.actualAllocationStartWeek = sortedWeeks[0]?.week ?? null
      namedResource.actualAllocationEndWeek = sortedWeeks[sortedWeeks.length - 1]?.week ?? null
    }

    assignmentsByResourceType.set(resourceType.id, {
      resourceTypeId: resourceType.id,
      resourceTypeName: resourceType.name,
      actualAllocatedDays: round2(namedResources.reduce((sum, namedResource) => sum + namedResource.actualAllocatedDays, 0)),
      unallocatedDays,
      namedResources,
    })
  }

  return assignmentsByResourceType
}
