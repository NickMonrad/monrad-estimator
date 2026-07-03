/**
 * capacityProfileMapping.ts — Pure read-only mapping helpers.
 *
 * Converts existing implicit capacity/profile fields (ResourceType, NamedResource)
 * into a first-class CapacityProfileDTO shape.
 *
 * Read-only. Not consumed by any route yet.
 *
 * Mapping rules:
 *   EFFORT        → demandFollowing
 *   TIMELINE      → availabilityWindow
 *   FULL_PROJECT  → wholeProjectAllocation
 *   CAPACITY_PLAN → capacityProfile
 *
 * Owner kinds:
 *   ResourceType without named resources → role
 *   NamedResource (persisted)            → namedPerson
 *   NamedResource (synthetic/derived)    → plannedResource
 *
 * Field precedence (matching current app behaviour):
 *   allocationPercent > allocationPct for NamedResource
 *   allocationStartWeek > startWeek / allocationEndWeek > endWeek
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
  legacy: {
    allocationMode?: string | null
    allocationPercent?: number | null
    allocationPct?: number | null
    allocationStartWeek?: number | null
    allocationEndWeek?: number | null
    startWeek?: number | null
    endWeek?: number | null
  }
}

// ─── Input "Like" types (minimal shape, no Prisma dependency) ───────────────

export type CapacityProfileResourceTypeLike = {
  id: string
  name: string
  allocationMode?: string | null
  allocationPercent?: number | null
  allocationStartWeek?: number | null
  allocationEndWeek?: number | null
  count?: number | null
}

export type CapacityProfileNamedResourceLike = {
  id: string
  name: string
  startWeek?: number | null
  endWeek?: number | null
  allocationPct?: number | null
  allocationMode?: string | null
  allocationPercent?: number | null
  allocationStartWeek?: number | null
  allocationEndWeek?: number | null
  pricingModel?: string | null
  synthetic?: boolean | null
}

/** Pre-derived capacity plan slot windows (produced by materializeCapacityPlanResources). */
export type CapacityPlanSlotInput = {
  startWeek: number
  endWeek: number
  allocationPercent: number
}

// ─── Allocation mode → planning basis mapping ───────────────────────────────

const ALLOCATION_MODE_TO_PLANNING_BASIS: Record<string, CapacityProfilePlanningBasis> = {
  EFFORT: 'demandFollowing',
  TIMELINE: 'availabilityWindow',
  FULL_PROJECT: 'wholeProjectAllocation',
  CAPACITY_PLAN: 'capacityProfile',
}

export function allocationModeToPlanningBasis(
  mode: string | null | undefined,
): CapacityProfilePlanningBasis {
  if (mode && mode in ALLOCATION_MODE_TO_PLANNING_BASIS) {
    return ALLOCATION_MODE_TO_PLANNING_BASIS[mode]!
  }
  return 'demandFollowing'
}

// ─── Source derivation ──────────────────────────────────────────────────────

function deriveSource(
  mode: string | null | undefined,
  hasActivePlanSlots: boolean,
): CapacityProfileSource {
  if (mode === 'CAPACITY_PLAN' && hasActivePlanSlots) return 'squadPlanner'
  if (mode === 'TIMELINE') return 'availabilityWindow'
  if (mode === 'EFFORT') return 'fixed'
  if (mode === 'FULL_PROJECT') return 'fixed'
  return 'legacy'
}

// ─── Field precedence helpers ───────────────────────────────────────────────

export function resolveNamedResourcePercent(
  nr: CapacityProfileNamedResourceLike,
): number {
  return nr.allocationPercent ?? nr.allocationPct ?? 100
}

export function resolveNamedResourceStartWeek(
  nr: CapacityProfileNamedResourceLike,
): number | null {
  return nr.allocationStartWeek ?? nr.startWeek ?? null
}

export function resolveNamedResourceEndWeek(
  nr: CapacityProfileNamedResourceLike,
): number | null {
  return nr.allocationEndWeek ?? nr.endWeek ?? null
}

// ─── Owner kind resolution ──────────────────────────────────────────────────

function ownerKindFromSynthetic(synthetic?: boolean | null): CapacityProfileOwnerKind {
  return synthetic ? 'plannedResource' : 'namedPerson'
}

// ─── Segment derivation from slot windows ───────────────────────────────────

function deriveSegmentsFromSlotWindows(
  resourceTypeId: string,
  slotWindows: CapacityPlanSlotInput[],
): CapacitySegmentDTO[] {
  return slotWindows.map((window, idx) => ({
    id: `segment-${resourceTypeId}-${idx + 1}`,
    startWeek: window.startWeek,
    endWeek: window.endWeek,
    capacityPercent: window.allocationPercent,
    source: 'squadPlanner' as CapacityProfileSource,
  }))
}

// ─── Legacy snapshot helper ─────────────────────────────────────────────────

function buildLegacyFields(
  fields: {
    allocationMode?: string | null
    allocationPercent?: number | null
    allocationPct?: number | null
    allocationStartWeek?: number | null
    allocationEndWeek?: number | null
    startWeek?: number | null
    endWeek?: number | null
  },
): CapacityProfileDTO['legacy'] {
  return {
    allocationMode: fields.allocationMode ?? null,
    allocationPercent: fields.allocationPercent ?? null,
    allocationPct: fields.allocationPct ?? null,
    allocationStartWeek: fields.allocationStartWeek ?? null,
    allocationEndWeek: fields.allocationEndWeek ?? null,
    startWeek: fields.startWeek ?? null,
    endWeek: fields.endWeek ?? null,
  }
}

// ─── Map single ResourceType (role-level) ───────────────────────────────────

export function mapResourceTypeToCapacityProfile(input: {
  projectId: string
  resourceType: CapacityProfileResourceTypeLike
  capacityPlanSlots?: CapacityPlanSlotInput[]
}): CapacityProfileDTO {
  const { projectId, resourceType, capacityPlanSlots } = input
  const mode = resourceType.allocationMode ?? null
  const usesCapacityPlanSegments =
    mode === 'CAPACITY_PLAN' &&
    capacityPlanSlots !== undefined &&
    capacityPlanSlots.length > 0
  const planningBasis = allocationModeToPlanningBasis(mode)
  const segments = usesCapacityPlanSegments
    ? deriveSegmentsFromSlotWindows(resourceType.id, capacityPlanSlots!)
    : []

  return {
    id: resourceType.id,
    projectId,
    owner: {
      kind: 'role',
      id: resourceType.id,
      name: resourceType.name,
    },
    planningBasis,
    defaultPercent: resourceType.allocationPercent ?? null,
    startWeek: resourceType.allocationStartWeek ?? null,
    endWeek: resourceType.allocationEndWeek ?? null,
    segments,
    source: deriveSource(mode, usesCapacityPlanSegments),
    legacy: buildLegacyFields({
      allocationMode: mode,
      allocationPercent: resourceType.allocationPercent,
      allocationStartWeek: resourceType.allocationStartWeek,
      allocationEndWeek: resourceType.allocationEndWeek,
    }),
  }
}

// ─── Map single NamedResource within a ResourceType ─────────────────────────

export function mapNamedResourceToCapacityProfile(input: {
  projectId: string
  resourceType: CapacityProfileResourceTypeLike
  namedResource: CapacityProfileNamedResourceLike
  capacityPlanSlots?: CapacityPlanSlotInput[]
}): CapacityProfileDTO {
  const { projectId, resourceType, namedResource, capacityPlanSlots } = input
  const mode = namedResource.allocationMode ?? resourceType.allocationMode ?? null
  const usesCapacityPlanSegments =
    mode === 'CAPACITY_PLAN' &&
    capacityPlanSlots !== undefined &&
    capacityPlanSlots.length > 0
  const planningBasis = allocationModeToPlanningBasis(mode)
  const segments = usesCapacityPlanSegments
    ? deriveSegmentsFromSlotWindows(resourceType.id, capacityPlanSlots!)
    : []

  const resolvedPct = resolveNamedResourcePercent(namedResource)
  const resolvedStartWeek = resolveNamedResourceStartWeek(namedResource)
  const resolvedEndWeek = resolveNamedResourceEndWeek(namedResource)

  return {
    id: namedResource.id,
    projectId,
    owner: {
      kind: ownerKindFromSynthetic(namedResource.synthetic),
      id: namedResource.id,
      name: namedResource.name,
      roleId: resourceType.id,
      roleName: resourceType.name,
    },
    planningBasis,
    defaultPercent: resolvedPct,
    startWeek: resolvedStartWeek,
    endWeek: resolvedEndWeek,
    segments,
    source: deriveSource(mode, usesCapacityPlanSegments),
    legacy: buildLegacyFields({
      allocationMode: mode,
      allocationPercent: namedResource.allocationPercent,
      allocationPct: namedResource.allocationPct,
      allocationStartWeek: namedResource.allocationStartWeek,
      allocationEndWeek: namedResource.allocationEndWeek,
      startWeek: namedResource.startWeek,
      endWeek: namedResource.endWeek,
    }),
  }
}

// ─── Map a full project's worth of capacity profiles ───────────────────────

export function mapProjectToCapacityProfiles(input: {
  projectId: string
  resourceTypes: CapacityProfileResourceTypeLike[]
  namedResourcesByResourceTypeId?: Map<string, CapacityProfileNamedResourceLike[]>
  capacityPlanSlotsByResourceTypeId?: Map<string, CapacityPlanSlotInput[]>
}): CapacityProfileDTO[] {
  const {
    projectId,
    resourceTypes,
    namedResourcesByResourceTypeId,
    capacityPlanSlotsByResourceTypeId,
  } = input

  const profiles: CapacityProfileDTO[] = []

  for (const rt of resourceTypes) {
    const nrList = namedResourcesByResourceTypeId?.get(rt.id) ?? []

    if (nrList.length === 0) {
      // Role-level profile only — no named resources
      profiles.push(mapResourceTypeToCapacityProfile({
        projectId,
        resourceType: rt,
        capacityPlanSlots: capacityPlanSlotsByResourceTypeId?.get(rt.id),
      }))
    } else {
      // One profile per named resource
      for (const nr of nrList) {
        profiles.push(mapNamedResourceToCapacityProfile({
          projectId,
          resourceType: rt,
          namedResource: nr,
          capacityPlanSlots: capacityPlanSlotsByResourceTypeId?.get(rt.id),
        }))
      }
    }
  }

  return profiles
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
    resourceTypeId: string | null
    namedResourceId: string | null
    ownerKind: string
    planningBasis: string
    source: string
    defaultPercent: number | null
    startWeek: number | null
    endWeek: number | null
    segments: ReadonlyArray<{
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

    const dto: CapacityProfileDTO = {
      id: pp.id,
      projectId: '',
      owner,
      planningBasis: toCamel(pp.planningBasis) as CapacityProfilePlanningBasis,
      source: toCamel(pp.source) as CapacityProfileSource,
      defaultPercent: pp.defaultPercent ?? null,
      startWeek: pp.startWeek ?? null,
      endWeek: pp.endWeek ?? null,
      segments: (pp.segments ?? []).map(s => ({
        id: '',
        startWeek: s.startWeek,
        endWeek: s.endWeek,
        capacityPercent: s.capacityPercent,
        source: toCamel(s.source) as CapacityProfileSource,
      })),
      legacy: {
        allocationMode: null,
        allocationPercent: null,
        allocationPct: null,
        allocationStartWeek: null,
        allocationEndWeek: null,
        startWeek: null,
        endWeek: null,
      },
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
