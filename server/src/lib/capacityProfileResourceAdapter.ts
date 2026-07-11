/**
 * capacityProfileResourceAdapter.ts — Adapter that maps capacity-profile DTO data
 * into the shape consumed by Resource Profile and export code.
 *
 * Enumerates every ResourceType role owner and every named/planned owner independently.
 * Persisted owner-specific profile wins; otherwise uses per-owner legacy mapper fallback.
 * Active Capacity Plan fallback per shouldFallbackToActiveCapacityPlan.
 * Duplicate profiles are handled deterministically — resolved before active-plan eligibility.
 *
 * Returns collision-safe separate maps for role-level and named/planned-resource profiles.
 */
import {
  mapResourceTypeToCapacityProfile,
  mapNamedResourceToCapacityProfile,
  mapPersistedProfilesToDTOs,
} from './capacityProfileMapping.js'
import {
  materializeCapacityPlanResources,
  shouldFallbackToActiveCapacityPlan,
  materializePerResourceSlots,
  computeDefaultPercentForSegments,
} from './capacityPlanMaterialisation.js'
import type {
  CapacityPlanResourceTrajectory,
} from './capacityPlanMaterialisation.js'
import type {
  CapacityProfileResourceTypeLike,
  CapacityProfileNamedResourceLike,
  CapacityPlanSlotInput,
} from './capacityProfileMapping.js'

// ─── Public types ────────────────────────────────────────────────────────────

export type CapacityProfileResolutionSource = 'PROFILE' | 'LEGACY' | 'ACTIVE_CAPACITY_PLAN'

export interface CapacityProfileResourceSegment {
  startWeek: number
  endWeek: number
  capacityPercent: number
}

export interface CapacityProfileResourceData {
  /** Planning basis from the capacity profile (e.g. demandFollowing, availabilityWindow, capacityProfile). */
  planningBasis: string
  /** Source of the capacity profile (e.g. fixed, manual, squadPlanner, legacy). */
  source: string
  /** Default capacity percentage (profile-level default, not segments). */
  defaultPercent: number | null
  /** Profile-level start week (null for demand-following or segments-only). */
  startWeek: number | null
  /** Profile-level end week. */
  endWeek: number | null
  /** Capacity segments describing availability over time. */
  segments: CapacityProfileResourceSegment[]
  /** Whether the data came from a persisted profile, legacy fallback, or active capacity plan. */
  resolutionSource: CapacityProfileResolutionSource
  /** Identity derived from the profile ownerKind: NAMED_PERSON for named people, PLANNED_RESOURCE for planned resources. Undefined for role-level profiles. */
  resourceIdentity?: 'NAMED_PERSON' | 'PLANNED_RESOURCE'
}

/**
 * Collision-safe capacity profile lookup result.
 * Returns separate maps for role-level profiles (keyed by resourceTypeId)
 * and named/planned-resource profiles (keyed by NR id or generated planned-resource id).
 */
export interface CapacityProfileMap {
  roleProfiles: Map<string, CapacityProfileResourceData>
  namedResourceProfiles: Map<string, CapacityProfileResourceData>
}

/** Minimal project-like shape required by the adapter. Exported for type-safety at callers. */
export interface CapacityProfileAdapterInput {
  id: string
  hoursPerDay: number
  resourceTypes: Array<{
    id: string
    name: string
    allocationMode: string | null
    allocationPercent: number | null
    allocationStartWeek: number | null
    allocationEndWeek: number | null
    count: number
    hoursPerDay: number | null
    synthetic: boolean | null
    namedResources: Array<{
      id: string
      name: string
      allocationMode: string | null
      allocationPercent: number | null
      allocationStartWeek: number | null
      allocationEndWeek: number | null
      startWeek: number | null
      endWeek: number | null
      pricingModel: string | null
      synthetic: boolean | null
    }>
  }>
  capacityPlans?: Array<{
    id: string
    isActive: boolean
    periods: Array<{
      periodIndex: number
      startWeek: number
      endWeek: number
      entries: Array<{
        resourceTypeId: string
        headcount: number
        demandFTE: number
        utilisationPct: number | null
      }>
    }>
  }>
  capacityProfiles?: Array<{
    id: string
    ownerKind: string
    resourceTypeId: string | null
    namedResourceId: string | null
    planningBasis: string
    source: string
    defaultPercent: number | null
    startWeek: number | null
    endWeek: number | null
    segments: Array<{
      id: string
      capacityProfileId: string
      startWeek: number
      endWeek: number
      capacityPercent: number
      source: string
    }>
  }>
}

// ─── Profile classification types ────────────────────────────────────────────

type PersistedProfile = NonNullable<CapacityProfileAdapterInput['capacityProfiles']>[number]

export type ProfileClassificationKind = 'NONE' | 'VALID' | 'CONFLICT'

export interface ProfileClassification {
  kind: ProfileClassificationKind
  /** The resolved profile when VALID. */
  profile?: PersistedProfile
  /** The conflicting profile IDs when CONFLICT. */
  ids?: string[]
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Check whether two segments are semantically equal (ignoring id/capacityProfileId/source metadata). */
function segmentFieldsEqual(
  a: { startWeek: number; endWeek: number; capacityPercent: number },
  b: { startWeek: number; endWeek: number; capacityPercent: number },
): boolean {
  return a.startWeek === b.startWeek && a.endWeek === b.endWeek && a.capacityPercent === b.capacityPercent
}

/** Check whether two arrays of segments are semantically equal. */
function arraysEqualByContent(
  a: ReadonlyArray<{ startWeek: number; endWeek: number; capacityPercent: number }>,
  b: ReadonlyArray<{ startWeek: number; endWeek: number; capacityPercent: number }>,
): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (!segmentFieldsEqual(a[i], b[i])) return false
  }
  return true
}

/** Sort segments deterministically (startWeek asc, endWeek asc, capacityPercent asc). */
function sortSegments<T extends { startWeek: number; endWeek: number; capacityPercent: number }>(segs: T[]): T[] {
  return [...segs].sort((a, b) => a.startWeek - b.startWeek || a.endWeek - b.endWeek || a.capacityPercent - b.capacityPercent)
}

/**
 * Classify a group of persisted profiles for the same owner.
 *
 * - NONE: no profiles exist.
 * - VALID: exactly one profile, or multiple semantically identical ones (smallest ID wins).
 * - CONFLICT: multiple profiles with conflicting data — warning logged, fallback permitted.
 */
function classifyProfiles(
  profiles: PersistedProfile[],
  ownerLabel: string,
  ownerId: string,
): ProfileClassification {
  if (profiles.length === 0) return { kind: 'NONE' }
  if (profiles.length === 1) return { kind: 'VALID', profile: profiles[0] }

  const sorted = [...profiles].sort((a, b) => a.id.localeCompare(b.id))
  const first = sorted[0]

  const allExact = sorted.every(p =>
    p.planningBasis === first.planningBasis &&
    p.source === first.source &&
    p.defaultPercent === first.defaultPercent &&
    p.startWeek === first.startWeek &&
    p.endWeek === first.endWeek &&
    arraysEqualByContent(
      sortSegments(p.segments ?? []),
      sortSegments(first.segments ?? []),
    )
  )

  if (allExact) return { kind: 'VALID', profile: first }

  console.warn(
    `Conflicting duplicate capacity profiles for ${ownerLabel} "${ownerId}": falling back. IDs: ${sorted.map(p => p.id).join(', ')}`,
  )
  return { kind: 'CONFLICT', ids: sorted.map(p => p.id) }
}

/** Convert a materialized capacity plan resource to ACTIVE_CAPACITY_PLAN profile data (role-level aggregate). */
function materializedToActivePlanProfile(
  materialized: { slotWindows: CapacityPlanSlotInput[]; resourceTrajectories: CapacityPlanResourceTrajectory[] },
): CapacityProfileResourceData {
  const slotWindows = materialized.slotWindows
  const trajectories = materialized.resourceTrajectories
  const defaultPercent =
    trajectories.length === 1 && trajectories[0].segments.length > 0
      ? computeDefaultPercentForSegments(trajectories[0].segments)
      : null
  return {
    planningBasis: 'capacityProfile',
    source: 'squadPlanner',
    defaultPercent,
    startWeek: null,
    endWeek: null,
    segments: slotWindows.map(w => ({
      startWeek: w.startWeek,
      endWeek: w.endWeek,
      capacityPercent: w.allocationPercent,
    })),
    resolutionSource: 'ACTIVE_CAPACITY_PLAN',
  }
}

/** Convert slot windows to ACTIVE_CAPACITY_PLAN profile data (per-resource). */
function singleSlotActivePlanProfile(
  slotWindows: CapacityPlanSlotInput[],
): CapacityProfileResourceData {
  const defaultPercent = computeDefaultPercentForSegments(
    slotWindows.map(w => ({ startWeek: w.startWeek, endWeek: w.endWeek, allocationPercent: w.allocationPercent }))
  )
  return {
    planningBasis: 'capacityProfile',
    source: 'squadPlanner',
    defaultPercent,
    startWeek: slotWindows.length > 0 ? Math.min(...slotWindows.map(w => w.startWeek)) : null,
    endWeek: slotWindows.length > 0 ? Math.max(...slotWindows.map(w => w.endWeek)) : null,
    segments: slotWindows.map(w => ({
      startWeek: w.startWeek,
      endWeek: w.endWeek,
      capacityPercent: w.allocationPercent,
    })),
    resolutionSource: 'ACTIVE_CAPACITY_PLAN',
  }
}
/** Convert a resolved persisted profile DTO to CapacityProfileResourceData. */
function profileDtoToData(
  p: {
    planningBasis: string
    source: string
    defaultPercent?: number | null
    startWeek?: number | null
    endWeek?: number | null
    segments: Array<{ startWeek: number; endWeek: number; capacityPercent: number }>
  },
  ownerKind?: string,
): CapacityProfileResourceData {
  const result: CapacityProfileResourceData = {
    planningBasis: p.planningBasis,
    source: p.source,
    defaultPercent: p.defaultPercent ?? null,
    startWeek: p.startWeek ?? null,
    endWeek: p.endWeek ?? null,
    segments: p.segments.map(s => ({
      startWeek: s.startWeek,
      endWeek: s.endWeek,
      capacityPercent: s.capacityPercent,
    })),
    resolutionSource: 'PROFILE',
  }
  if (ownerKind === 'PLANNED_RESOURCE' || ownerKind === 'NAMED_PERSON') {
    result.resourceIdentity = ownerKind === 'PLANNED_RESOURCE' ? 'PLANNED_RESOURCE' : 'NAMED_PERSON'
  }
  return result
}

// ─── Main function ───────────────────────────────────────────────────────────

/**
 * Build collision-safe capacity-profile enrichment maps.
 *
 * Precedence (per owner):
 * 1. Persisted owner-specific CapacityProfile (PROFILE) — authoritative.
 * 2. Active Capacity Plan fallback (ACTIVE_CAPACITY_PLAN) — when shouldFallbackToActiveCapacityPlan
 *    and no VALID persisted profile exists (CONFLICT or NONE).
 * 3. Legacy compatibility from ResourceType/NamedResource fields (LEGACY).
 *
 * Duplicates: classified before active-plan eligibility. VALID exact duplicates resolve
 * deterministically (smallest persisted ID wins). CONFLICT duplicates permit active-plan
 * fallback when needed or legacy when not.
 *
 * Pure legacy entries are derived WITHOUT active-plan slot windows — the active-plan
 * materialization only applies in the explicit fallback branch.
 *
 * Returns separate roleProfiles and namedResourceProfiles maps for collision-safe lookups.
 */
export function buildResourceCapacityProfileMap(
  project: CapacityProfileAdapterInput,
): CapacityProfileMap {
  const activePlan = project.capacityPlans?.[0] ?? null
  const capacityPlanByRt = materializeCapacityPlanResources(activePlan?.periods ?? [])

  // ── Phase 0: Build lookup maps ────────────────────────────────────────────

  const resourceTypeById = new Map<string, { id: string; name: string }>()
  const namedResourceById = new Map<string, { id: string; name: string; resourceTypeId: string }>()
  for (const rt of project.resourceTypes) {
    resourceTypeById.set(rt.id, { id: rt.id, name: rt.name })
    for (const nr of rt.namedResources) {
      namedResourceById.set(nr.id, { id: nr.id, name: nr.name, resourceTypeId: rt.id })
    }
  }

  // ── Phase 1: Classify persisted profiles (resolve duplicates before eligibility) ──

  const rtClassifications = new Map<string, ProfileClassification>()
  const nrClassifications = new Map<string, ProfileClassification>()

  const rawProfiles = project.capacityProfiles
  if (rawProfiles) {
    const rawByRT = new Map<string, PersistedProfile[]>()
    const rawByNR = new Map<string, PersistedProfile[]>()
    for (const cp of rawProfiles) {
      if (cp.ownerKind === 'ROLE' && cp.resourceTypeId) {
        const arr = rawByRT.get(cp.resourceTypeId) ?? []
        arr.push(cp)
        rawByRT.set(cp.resourceTypeId, arr)
      } else if ((cp.ownerKind === 'NAMED_PERSON' || cp.ownerKind === 'PLANNED_RESOURCE') && cp.namedResourceId) {
        const arr = rawByNR.get(cp.namedResourceId) ?? []
        arr.push(cp)
        rawByNR.set(cp.namedResourceId, arr)
      }
    }

    for (const [rtId, profiles] of rawByRT) {
      rtClassifications.set(rtId, classifyProfiles(profiles, 'ROLE', rtId))
    }
    for (const [nrId, profiles] of rawByNR) {
      const label = namedResourceById.get(nrId)?.name ?? nrId
      nrClassifications.set(nrId, classifyProfiles(profiles, label, nrId))
    }
  }

  // ── Phase 2: Build pure legacy profiles (NO active-plan slots) ────────────

  const roleProfiles = new Map<string, CapacityProfileResourceData>()
  const namedResourceProfiles = new Map<string, CapacityProfileResourceData>()
  for (const rt of project.resourceTypes) {
    const roleProfile = mapResourceTypeToCapacityProfile({
      projectId: project.id,
      resourceType: rt as unknown as CapacityProfileResourceTypeLike,
    })
    roleProfiles.set(rt.id, {
      planningBasis: roleProfile.planningBasis,
      source: roleProfile.source,
      defaultPercent: roleProfile.defaultPercent ?? null,
      startWeek: roleProfile.startWeek ?? null,
      endWeek: roleProfile.endWeek ?? null,
      segments: roleProfile.segments.map(s => ({
        startWeek: s.startWeek,
        endWeek: s.endWeek,
        capacityPercent: s.capacityPercent,
      })),
      resolutionSource: 'LEGACY',
    })

    for (const nr of rt.namedResources) {
      const nrProfile = mapNamedResourceToCapacityProfile({
        projectId: project.id,
        resourceType: rt as unknown as CapacityProfileResourceTypeLike,
        namedResource: nr as unknown as CapacityProfileNamedResourceLike,
      })
      namedResourceProfiles.set(nr.id, {
        planningBasis: nrProfile.planningBasis,
        source: nrProfile.source,
        defaultPercent: nrProfile.defaultPercent ?? null,
        startWeek: nrProfile.startWeek ?? null,
        endWeek: nrProfile.endWeek ?? null,
        segments: nrProfile.segments.map(s => ({
          startWeek: s.startWeek,
          endWeek: s.endWeek,
          capacityPercent: s.capacityPercent,
        })),
        resolutionSource: 'LEGACY',
        resourceIdentity: nr.synthetic === true ? 'PLANNED_RESOURCE' : 'NAMED_PERSON',
      })
    }
  }

  // ── Phase 3: Apply PROFILE overrides for VALID groups ─────────────────────

  for (const [rtId, classification] of rtClassifications) {
    if (classification.kind === 'VALID' && classification.profile) {
      const dto = mapPersistedProfilesToDTOs(
        [classification.profile] as unknown as Parameters<typeof mapPersistedProfilesToDTOs>[0],
        resourceTypeById,
        namedResourceById,
      )
      if (dto[0]) {
        roleProfiles.set(rtId, profileDtoToData(dto[0]))
      }
    }
  }

  for (const [nrId, classification] of nrClassifications) {
    if (classification.kind === 'VALID' && classification.profile) {
      const dto = mapPersistedProfilesToDTOs(
        [classification.profile] as unknown as Parameters<typeof mapPersistedProfilesToDTOs>[0],
        resourceTypeById,
        namedResourceById,
      )
      if (dto[0]) {
        namedResourceProfiles.set(nrId, profileDtoToData(dto[0], classification.profile.ownerKind))
      }
    }
  }

  // ── Phase 4: Active-plan fallback for non-VALID groups ────────────────────

  if (activePlan) {
    for (const rt of project.resourceTypes) {
      const materialized = capacityPlanByRt.get(rt.id)
      if (!materialized) continue

      const needsFallback = shouldFallbackToActiveCapacityPlan(
        rt.namedResources,
        materialized,
      )

      if (!needsFallback) continue

      // Role-level: aggregate slots if not VALID
      const rtClass = rtClassifications.get(rt.id) ?? { kind: 'NONE' as const }
      if (rtClass.kind !== 'VALID') {
        roleProfiles.set(rt.id, materializedToActivePlanProfile({
          slotWindows: materialized.slotWindows,
          resourceTrajectories: materialized.resourceTrajectories,
        }))
      }

      // Per-resource trajectory assignment using stable trajectory model
      const trajectories = materialized.resourceTrajectories
      const assignment = materializePerResourceSlots(
        trajectories,
        rt.id,
        rt.name,
        rt.namedResources,
      )

      for (const slot of assignment.resourceSlots) {
        const nrClass = nrClassifications.get(slot.id) ?? { kind: 'NONE' as const }
        if (nrClass.kind !== 'VALID') {
          namedResourceProfiles.set(slot.id, singleSlotActivePlanProfile(slot.slotWindows))
        }
      }

      // Preserve persisted NRs NOT matched to any trajectory
      const matchedIds = new Set(assignment.resourceSlots.map(s => s.existingNamedResourceId).filter((id): id is string => id !== null))
      for (const nr of rt.namedResources) {
        if (!matchedIds.has(nr.id)) {
          // This NR has no trajectory — its existing profile (LEGACY or PROFILE) stays as is
        }
      }
    }
  }

  return { roleProfiles, namedResourceProfiles }
}
