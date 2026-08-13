/**
 * capacityProfileMapping.ts — Pure read-only mapping helpers.
 *
 * Maps persisted CapacityProfile/CapacitySegment rows to the standard
 * CapacityProfileDTO response shape.
 *
 * Read-only. No database writes.
 *
 * The legacy→profile mapper exports (allocationModeToPlanningBasis,
 * mapResourceTypeToCapacityProfile, mapNamedResourceToCapacityProfile,
 * mapProjectToCapacityProfiles and their input helpers) were removed with
 * the temporary backfill/sync/reconcile tooling (issue #418 PR 3).
 */

// ─── Public DTO types ───────────────────────────────────────────────────────

export type CapacityProfileOwnerKind = 'role' | 'namedPerson' | 'plannedResource'

export type CapacityProfilePlanningBasis =
  | 'demandFollowing'
  | 'availabilityWindow'
  | 'wholeProjectAllocation'
  | 'capacityProfile'

export type CapacityProfileSource =
  | 'fixed'
  | 'manual'
  | 'availabilityWindow'
  | 'squadPlanner'
  | 'imported'
  | 'derived'
  | 'legacy'

export type CapacitySegmentDTO = {
  id: string
  startWeek: number
  endWeek: number
  capacityPercent: number
  source: CapacityProfileSource
}

export type CapacityProfileDTO = {
  id: string
  projectId: string
  owner: {
    kind: CapacityProfileOwnerKind
    id: string
    name: string
    roleId?: string
    roleName?: string
  }
  planningBasis: CapacityProfilePlanningBasis
  defaultPercent?: number | null
  startWeek?: number | null
  endWeek?: number | null
  segments: CapacitySegmentDTO[]
  source: CapacityProfileSource
}

// ─── Map persisted CapacityProfile rows to DTOs ────────────────────────────

/**
 * Convert persisted CapacityProfile/CapacitySegment rows to the standard
 * CapacityProfileDTO shape, resolving owner name from project resource data.
 *
 * @param persistedProfiles  Raw persisted profile rows (with segments included)
 * @param resourceTypeById   Map of resource type id → { id, name }
 * @param namedResourceById  Map of named resource id → { id, name, resourceTypeId }
 * @returns                  CapacityProfileDTO[] in stable order (role first, then named)
 */
export function mapPersistedProfilesToDTOs(
  persistedProfiles: ReadonlyArray<{
    id: string
    projectId: string
    resourceTypeId: string | null
    namedResourceId: string | null
    ownerKind: string
    planningBasis: string
    source: string
    defaultPercent: number | null
    startWeek: number | null
    endWeek: number | null
    segments: ReadonlyArray<{
      id: string
      startWeek: number
      endWeek: number
      capacityPercent: number
      source: string
    }>
  }>,
  resourceTypeById: ReadonlyMap<string, { id: string; name: string }>,
  namedResourceById: ReadonlyMap<string, { id: string; name: string; resourceTypeId: string }>,
): CapacityProfileDTO[] {
  // Normalize UPPER_SNAKE_CASE to camelCase
  function toCamel(value: string): string {
    return value.toLowerCase().replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())
  }

  const dtos: CapacityProfileDTO[] = []

  for (const pp of persistedProfiles) {
    const ownerKind = toCamel(pp.ownerKind) as CapacityProfileOwnerKind
    const ownerId = pp.resourceTypeId ?? pp.namedResourceId ?? ''

    let ownerName: string
    let roleId: string | undefined
    let roleName: string | undefined

    if (ownerKind === 'role') {
      const rt = resourceTypeById.get(pp.resourceTypeId!)
      ownerName = rt?.name ?? 'Unknown'
    } else {
      const nr = namedResourceById.get(pp.namedResourceId!)
      ownerName = nr?.name ?? 'Unknown'
      if (nr?.resourceTypeId) {
        roleId = nr.resourceTypeId
        const rt = resourceTypeById.get(nr.resourceTypeId)
        roleName = rt?.name
      }
    }

    const owner: CapacityProfileDTO['owner'] = {
      kind: ownerKind,
      id: ownerId,
      name: ownerName,
    }
    if (roleId) (owner as Record<string, string>).roleId = roleId
    if (roleName) (owner as Record<string, string>).roleName = roleName

    // Defensive sort: startWeek ascending, then endWeek ascending
    const sortedSegments = [...(pp.segments ?? [])].sort(
      (a, b) => a.startWeek - b.startWeek || a.endWeek - b.endWeek,
    )

    const dto: CapacityProfileDTO = {
      id: pp.id,
      projectId: pp.projectId,
      owner,
      planningBasis: toCamel(pp.planningBasis) as CapacityProfilePlanningBasis,
      source: toCamel(pp.source) as CapacityProfileSource,
      defaultPercent: pp.defaultPercent ?? null,
      startWeek: pp.startWeek ?? null,
      endWeek: pp.endWeek ?? null,
      segments: sortedSegments.map(s => ({
        id: s.id,
        startWeek: s.startWeek,
        endWeek: s.endWeek,
        capacityPercent: s.capacityPercent,
        source: toCamel(s.source) as CapacityProfileSource,
      })),
    }

    dtos.push(dto)
  }

  // Stable order: role profiles first, then named/person/planned
  dtos.sort((a, b) => {
    if (a.owner.kind !== b.owner.kind) {
      return a.owner.kind === 'role' ? -1 : 1
    }
    return a.owner.id.localeCompare(b.owner.id)
  })

  return dtos
}
