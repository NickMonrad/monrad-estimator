import {
  shouldFallbackToActiveCapacityPlan,
  type CapacityPlanSlotWindow,
  type MaterializedCapacityPlanResource,
} from './capacityPlanMaterialisation.js'

type AllocationMode = 'EFFORT' | 'TIMELINE' | 'FULL_PROJECT' | 'CAPACITY_PLAN'
type PricingModel = 'ACTUAL_DAYS' | 'PRO_RATA'

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
  pricingModel?: string | null
  /**
   * Profile/plan capacity segments. When present, authoritative over
   * legacy allocation fields for weekly capacity calculation.
   */
  capacitySegments?: { startWeek: number; endWeek: number; allocationPercent: number }[]
}

type ResourceTypeLike = {
  id: string
  name: string
  count: number
  allocationMode?: string | null
  /**
   * True when valid persisted owner profiles are authoritative for this RT.
   * In that case an active Capacity Plan must not rematerialize its named
   * resources over the persisted profile-backed resources.
   */
  capacityProfileBacked?: boolean
  /**
   * Resolved aggregate role-level capacity segments.
   * When present, constrains the phantom/unnamed-slot capacity instead of
   * using count-based synthetic resources at 100%.
   */
  roleSegments?: { startWeek: number; endWeek: number; allocationPercent: number }[]
  /**
   * True when the scheduler capacity resolver has already resolved this RT
   * from an active Capacity Plan. When set, the assignment function must
   * not rematerialize the plan over already-authoritative output.
   */
  capacityPlanResolved?: boolean
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
  pricingModel: PricingModel
  startWeek: number | null
  endWeek: number | null
  synthetic: boolean
  actualAllocatedDays: number
  actualAllocationStartWeek: number | null
  actualAllocationEndWeek: number | null
  actualAllocatedWeeks: NamedResourceAssignedWeek[]
  capacitySegments?: CapacityPlanSlotWindow[]
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
  const hasRoleSegments = resourceType.roleSegments && resourceType.roleSegments.length > 0
  // When a valid role profile is authoritative, suppress capacity plan fallback.
  // The role segments provide aggregate unnamed-staff capacity instead of
  // both the plan's trajectory set AND count-based phantom slots (defect #362).
  // Also suppress when the resolver has already produced authoritative output.
  const useCapacityPlanFallback =
    mode === 'CAPACITY_PLAN' &&
    !resourceType.capacityProfileBacked &&
    !resourceType.capacityPlanResolved &&
    !hasRoleSegments &&
    shouldFallbackToActiveCapacityPlan(persistedNamedResources, capacityPlanMaterialized)

  const baseNamedResources = useCapacityPlanFallback && capacityPlanMaterialized
    ? (() => {
        const usedTrajectories = capacityPlanMaterialized.resourceTrajectories

        const trajectoryResources = usedTrajectories.map((trajectory, idx) => {
          const existing = persistedNamedResources[idx]
          const totalPercent = trajectory.segments.length > 0 ? trajectory.segments[0].allocationPercent : 100
          return {
            id: existing?.id ?? `${resourceType.id}-capacity-plan-${trajectory.trajectoryIndex + 1}`,
            name: existing?.name ?? `${resourceType.name} ${trajectory.trajectoryIndex + 1}`,
            startWeek: trajectory.segments[0]?.startWeek ?? null,
            endWeek: trajectory.segments.length > 0 ? trajectory.segments[trajectory.segments.length - 1].endWeek : null,
            allocationPct: totalPercent,
            allocationMode: 'CAPACITY_PLAN',
            allocationPercent: totalPercent,
            allocationStartWeek: null,
            allocationEndWeek: null,
            pricingModel: existing?.pricingModel === 'PRO_RATA' ? 'PRO_RATA' : 'ACTUAL_DAYS',
            synthetic: !existing,
            capacitySegments: trajectory.segments,
          }
        })

        // Preserve persisted NRs not matched to any trajectory
        const matchedIds = new Set(trajectoryResources.map(r => r.id))
        const unmatchedPersisted = persistedNamedResources
          .filter(nr => !matchedIds.has(nr.id))
          .map(nr => ({
            ...nr,
            synthetic: false,
          }))

        return [...trajectoryResources, ...unmatchedPersisted]
      })()
    : persistedNamedResources.map(namedResource => ({
        ...namedResource,
        synthetic: false,
      }))

  // ── Role-segment authority: provide aggregate role capacity ────────────
  // When a valid role profile is authoritative, generate a synthetic NR
  // carrying the role segments. This replaces count-based phantom slots
  // and provides the aggregate unnamed-staff capacity. Named resources
  // contribute their own capacity independently; the role synthetic adds
  // the capacity that count would have provided for phantom slots.
  // Keeps assignment capacity consistent with getWeeklyCapacity().
  if (hasRoleSegments && hasDemand) {
    const roleNR = {
      id: `${resourceType.id}-role`,
      name: `${resourceType.name} (Role)`,
      startWeek: null,
      endWeek: null,
      allocationPct: 100,
      allocationMode: 'EFFORT' as const,
      allocationPercent: 100,
      allocationStartWeek: null,
      allocationEndWeek: null,
      pricingModel: 'ACTUAL_DAYS' as const,
      synthetic: true,
      capacitySegments: resourceType.roleSegments,
    }

    return [roleNR, ...baseNamedResources].map((namedResource, order) => ({
      id: namedResource.id,
      resourceTypeId: resourceType.id,
      resourceTypeName: resourceType.name,
      name: namedResource.name,
      allocationMode: namedResource.allocationMode ?? 'EFFORT',
      allocationPercent: namedResource.allocationPercent ?? namedResource.allocationPct ?? 100,
      allocationStartWeek: namedResource.allocationStartWeek ?? null,
      allocationEndWeek: namedResource.allocationEndWeek ?? null,
      pricingModel: namedResource.pricingModel === 'PRO_RATA' ? 'PRO_RATA' : 'ACTUAL_DAYS',
      startWeek: namedResource.startWeek ?? null,
      endWeek: namedResource.endWeek ?? null,
      synthetic: namedResource.synthetic,
      actualAllocatedDays: 0,
      actualAllocationStartWeek: null,
      actualAllocationEndWeek: null,
      actualAllocatedWeeks: [],
      actualAllocationSegments: [],
      capacitySegments: (namedResource as { capacitySegments?: CapacityPlanSlotWindow[] }).capacitySegments,
      order,
      lastAssignedWeek: null,
    }))
  }

  // ── Legacy fallback: count-based phantom slots ──────────────────────────
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
          allocationMode: 'EFFORT' as const,
          allocationPercent: 100,
          allocationStartWeek: null,
          allocationEndWeek: null,
          pricingModel: 'ACTUAL_DAYS' as const,
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
    pricingModel: namedResource.pricingModel === 'PRO_RATA' ? 'PRO_RATA' : 'ACTUAL_DAYS',
    startWeek: namedResource.startWeek ?? null,
    endWeek: namedResource.endWeek ?? null,
    synthetic: namedResource.synthetic,
    actualAllocatedDays: 0,
    actualAllocationStartWeek: null,
    actualAllocationEndWeek: null,
    actualAllocatedWeeks: [],
    actualAllocationSegments: [],
    capacitySegments: (namedResource as { capacitySegments?: CapacityPlanSlotWindow[] }).capacitySegments,
    order,
    lastAssignedWeek: null,
  }))
}
function weeklyCapacityForNamedResource(
  namedResource: DerivedNamedResourceAssignment,
  week: number,
): number {
  // Profile/segment-first: if capacity segments are present, use them
  // regardless of legacy start/end week or allocation mode
  if (namedResource.capacitySegments && namedResource.capacitySegments.length > 0) {
    const segment = namedResource.capacitySegments.find(
      s => week >= s.startWeek && week <= s.endWeek,
    )
    return segment ? 5 * (segment.allocationPercent / 100) : 0
  }

  const startWeek = namedResource.startWeek ?? 0
  const endWeek = namedResource.endWeek ?? Infinity

  if (week < startWeek || week > endWeek) return 0

  const mode = toAllocationMode(namedResource.allocationMode)
  const allocationPercent = namedResource.allocationPercent ?? 100

  if (mode === 'EFFORT') return 5
  if (mode === 'FULL_PROJECT' || mode === 'CAPACITY_PLAN') return 5 * (allocationPercent / 100)

  const hasExplicitAllocationWindow =
    namedResource.allocationStartWeek != null ||
    namedResource.allocationEndWeek != null

  if (!hasExplicitAllocationWindow) return 5 * (allocationPercent / 100)

  const effectiveStartWeek = namedResource.allocationStartWeek ?? -Infinity
  const effectiveEndWeek = namedResource.allocationEndWeek ?? Infinity

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
