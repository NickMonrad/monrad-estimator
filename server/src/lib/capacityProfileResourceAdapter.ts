/**
 * capacityProfileResourceAdapter.ts — Adapter that maps capacity-profile DTO data
 * into the shape consumed by Resource Profile and export code.
 *
 * Enumerates every ResourceType role owner and every named/planned owner independently.
 * Persisted owner-specific profile wins; otherwise uses per-owner legacy mapper fallback.
 * Active Capacity Plan fallback per shouldFallbackToActiveCapacityPlan.
 * Duplicate profiles are handled deterministically.
 */
import {
  mapResourceTypeToCapacityProfile,
  mapNamedResourceToCapacityProfile,
  mapPersistedProfilesToDTOs,
} from './capacityProfileMapping.js'
import {
  materializeCapacityPlanResources,
  shouldFallbackToActiveCapacityPlan,
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
}

// ─── Minimal project-like shape required by the adapter ──────────────────────

interface AdapterProject {
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

/** Resolve a group of duplicate persisted profiles: if all identical return the one with smallest ID; otherwise null (fall back to legacy). */
function resolveDuplicateProfiles(
  profiles: Array<NonNullable<AdapterProject['capacityProfiles']>[number]>,
  ownerLabel: string,
  ownerId: string,
): NonNullable<AdapterProject['capacityProfiles']>[number] | null {
  if (profiles.length === 0) return null
  if (profiles.length === 1) return profiles[0]

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

  if (allExact) return first

  // Conflicting duplicates — log warning, fall back to legacy
  console.warn(
    `Conflicting duplicate capacity profiles for ${ownerLabel} "${ownerId}": falling back to legacy. IDs: ${sorted.map(p => p.id).join(', ')}`,
  )
  return null
}

/** Convert a materialized capacity plan resource to ACTIVE_CAPACITY_PLAN profile data. */
function materializedToActivePlanProfile(
  materialized: { slotWindows: CapacityPlanSlotInput[] },
): CapacityProfileResourceData {
  return {
    planningBasis: 'capacityProfile',
    source: 'squadPlanner',
    defaultPercent: 100,
    startWeek: null,
    endWeek: null,
    segments: materialized.slotWindows.map(w => ({
      startWeek: w.startWeek,
      endWeek: w.endWeek,
      capacityPercent: w.allocationPercent,
    })),
    resolutionSource: 'ACTIVE_CAPACITY_PLAN',
  }
}

// ─── Main function ───────────────────────────────────────────────────────────

/**
 * Build a capacity-profile enrichment map keyed by owner id.
 *
 * Enumerates every ResourceType role owner and every named/planned owner independently.
 *
 * Precedence:
 * 1. Persisted owner-specific CapacityProfile (PROFILE) — authoritative.
 * 2. Active Capacity Plan fallback (ACTIVE_CAPACITY_PLAN) — when shouldFallbackToActiveCapacityPlan.
 * 3. Legacy compatibility from ResourceType/NamedResource fields (LEGACY).
 *
 * Duplicates: exact duplicates are resolved deterministically (smallest persisted ID wins).
 * Conflicting duplicates trigger a console.warn and fall back to legacy.
 *
 * Key collision: role (resourceTypeId) vs named resource (namedResourceId) keys are tracked
 * separately internally; a warning is logged if any overlap exists.
 *
 * Returns an empty Map when no profiles could be derived.
 */
export function buildResourceCapacityProfileMap(
  project: AdapterProject,
): Map<string, CapacityProfileResourceData> {
  const activePlan = project.capacityPlans?.[0] ?? null
  const capacityPlanByRt = materializeCapacityPlanResources(activePlan?.periods ?? [])

  const capacityPlanSlotsByResourceTypeId = new Map<string, CapacityPlanSlotInput[]>(
    Array.from(capacityPlanByRt.entries()).map(([rtId, materialized]) => [
      rtId,
      materialized.slotWindows,
    ]),
  )

  // ── Phase 0: Build lookup maps ────────────────────────────────────────────

  const resourceTypeById = new Map<string, { id: string; name: string }>()
  const namedResourceById = new Map<string, { id: string; name: string; resourceTypeId: string }>()
  for (const rt of project.resourceTypes) {
    resourceTypeById.set(rt.id, { id: rt.id, name: rt.name })
    for (const nr of rt.namedResources) {
      namedResourceById.set(nr.id, { id: nr.id, name: nr.name, resourceTypeId: rt.id })
    }
  }

  // ── Phase 1: Build legacy profiles per owner independently ────────────────

  const roleLegacy = new Map<string, CapacityProfileResourceData>()
  const nrLegacy = new Map<string, CapacityProfileResourceData>()

  for (const rt of project.resourceTypes) {
    const roleProfile = mapResourceTypeToCapacityProfile({
      projectId: project.id,
      resourceType: rt as unknown as CapacityProfileResourceTypeLike,
      capacityPlanSlots: capacityPlanSlotsByResourceTypeId.get(rt.id),
    })
    roleLegacy.set(rt.id, {
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
        capacityPlanSlots: capacityPlanSlotsByResourceTypeId.get(rt.id),
      })
      nrLegacy.set(nr.id, {
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
      })
    }
  }

  // ── Phase 2: Group persisted profiles, detect duplicates ──────────────────

  const persistedByRTId = new Map<string, Array<NonNullable<AdapterProject['capacityProfiles']>[number]>>()
  const persistedByNRId = new Map<string, Array<NonNullable<AdapterProject['capacityProfiles']>[number]>>()
  const persisted = project.capacityProfiles
  if (persisted) {
    for (const cp of persisted) {
      if (cp.ownerKind === 'ROLE' && cp.resourceTypeId) {
        const arr = persistedByRTId.get(cp.resourceTypeId) ?? []
        arr.push(cp)
        persistedByRTId.set(cp.resourceTypeId, arr)
      } else if ((cp.ownerKind === 'NAMED_PERSON' || cp.ownerKind === 'PLANNED_RESOURCE') && cp.namedResourceId) {
        const arr = persistedByNRId.get(cp.namedResourceId) ?? []
        arr.push(cp)
        persistedByNRId.set(cp.namedResourceId, arr)
      }
    }
  }

  // ── Phase 3: Build result map with precedence ─────────────────────────────

  const result = new Map<string, CapacityProfileResourceData>()

  // Step A: Seed with legacy entries (lowest precedence)
  for (const [rtId, legacy] of roleLegacy) {
    result.set(rtId, legacy)
  }
  for (const [nrId, legacy] of nrLegacy) {
    result.set(nrId, legacy)
  }

  // Step B: Override with ACTIVE_CAPACITY_PLAN where fallback is needed
  if (activePlan) {
    for (const rt of project.resourceTypes) {
      const materialized = capacityPlanByRt.get(rt.id)
      if (!materialized) continue

      const needsFallback = shouldFallbackToActiveCapacityPlan(
        rt.namedResources,
        materialized,
      )

      if (!needsFallback) continue

      // Override role entry (if not persisted)
      if (!persistedByRTId.has(rt.id)) {
        result.set(rt.id, materializedToActivePlanProfile(materialized))
      }

      // Override each named resource entry (if not persisted)
      for (const nr of rt.namedResources) {
        if (!persistedByNRId.has(nr.id)) {
          result.set(nr.id, materializedToActivePlanProfile(materialized))
        }
      }


    }
  }

  // Step C: Override with persisted profiles (highest precedence)
  for (const [rtId, profiles] of persistedByRTId) {
    const resolved = resolveDuplicateProfiles(profiles, 'ROLE', rtId)
    if (!resolved) {
      // Conflicting duplicates → keep existing legacy or ACTIVE_CAPACITY_PLAN entry
      continue
    }
    const dto = mapPersistedProfilesToDTOs(
      [resolved] as unknown as Parameters<typeof mapPersistedProfilesToDTOs>[0],
      resourceTypeById,
      namedResourceById,
    )
    const p = dto[0]
    if (p) {
      result.set(rtId, {
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
      })
    }
  }

  for (const [nrId, profiles] of persistedByNRId) {
    const resolved = resolveDuplicateProfiles(
      profiles,
      namedResourceById.get(nrId)?.name ?? 'NAMED_PERSON',
      nrId,
    )
    if (!resolved) {
      continue
    }
    const dto = mapPersistedProfilesToDTOs(
      [resolved] as unknown as Parameters<typeof mapPersistedProfilesToDTOs>[0],
      resourceTypeById,
      namedResourceById,
    )
    const p = dto[0]
    if (p) {
      result.set(nrId, {
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
      })
    }
  }

  // ── Phase 4: Collision detection (role ID vs NR ID) ──────────────────────

  const roleIds = new Set(project.resourceTypes.map(rt => rt.id))
  const nrIds = new Set<string>()
  for (const rt of project.resourceTypes) {
    for (const nr of rt.namedResources) {
      nrIds.add(nr.id)
    }
  }
  const collidingKeys = [...roleIds].filter(id => nrIds.has(id))
  if (collidingKeys.length > 0) {
    console.warn(
      `Key collision between role and named resource profile keys: "${collidingKeys.join(', ')}". Role entry may shadow named resource entry.`,
    )
  }

  return result
}

