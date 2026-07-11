/**
 * capacityProfileResourceAdapter.ts — Adapter that maps capacity-profile DTO data
 * into the shape consumed by Resource Profile and export code.
 *
 * Legacy ResourceType/NamedResource fields remain authoritative.
 * CapacityProfile is a derived read model — the adapter enriches Resource Profile
 * output when persisted profiles exist and reconcile; falls back gracefully.
 */
import {
  mapProjectToCapacityProfiles,
  mapPersistedProfilesToDTOs,
} from './capacityProfileMapping.js'
import { materializeCapacityPlanResources } from './capacityPlanMaterialisation.js'
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
/**
 * Build a capacity-profile enrichment map keyed by owner id.
 *
 * Key rules:
 * - Role profiles → keyed by `resourceTypeId`
 * - Named-person / planned-resource profiles → keyed by `namedResourceId`
 *
 * Precedence:
 * 1. Persisted owner-specific CapacityProfile (authoritative after PR #355).
 * 2. Legacy compatibility fallback derived from ResourceType/NamedResource fields.
 * 3. Active Capacity Plan materialisation only where existing fallback rules apply.
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

  // Build named resources lookup per resource type
  const namedResourcesByResourceTypeId = new Map<string, CapacityProfileNamedResourceLike[]>()
  for (const rt of project.resourceTypes) {
    namedResourcesByResourceTypeId.set(rt.id, rt.namedResources as unknown as CapacityProfileNamedResourceLike[])
  }

  // Derive the legacy mapper profiles (fallback when no persisted profile exists)
  const legacyProfiles = mapProjectToCapacityProfiles({
    projectId: project.id,
    resourceTypes: project.resourceTypes as unknown as CapacityProfileResourceTypeLike[],
    namedResourcesByResourceTypeId,
    capacityPlanSlotsByResourceTypeId,
  })

  // Build lookup maps for persisted profiles
  const persistedByRTId = new Map<string, NonNullable<AdapterProject['capacityProfiles']>[number]>()
  const persistedByNRId = new Map<string, NonNullable<AdapterProject['capacityProfiles']>[number]>()
  const persisted = project.capacityProfiles
  if (persisted) {
    for (const cp of persisted) {
      if (cp.ownerKind === 'ROLE' && cp.resourceTypeId) {
        persistedByRTId.set(cp.resourceTypeId, cp)
      } else if ((cp.ownerKind === 'NAMED_PERSON' || cp.ownerKind === 'PLANNED_RESOURCE') && cp.namedResourceId) {
        persistedByNRId.set(cp.namedResourceId, cp)
      }
    }
  }

  const resourceTypeById = new Map<string, { id: string; name: string }>()
  const namedResourceById = new Map<string, { id: string; name: string; resourceTypeId: string }>()
  for (const rt of project.resourceTypes) {
    resourceTypeById.set(rt.id, { id: rt.id, name: rt.name })
    for (const nr of rt.namedResources) {
      namedResourceById.set(nr.id, { id: nr.id, name: nr.name, resourceTypeId: rt.id })
    }
  }

  // Build lookup map
  const map = new Map<string, CapacityProfileResourceData>()

  for (const profile of legacyProfiles) {
    const ownerId = profile.owner.id

    // Check for persisted profile for this owner
    const persistedProfile = profile.owner.kind === 'role'
      ? persistedByRTId.get(ownerId)
      : persistedByNRId.get(ownerId)

    if (persistedProfile) {
      // Profile-first: use persisted profile data authoritatively
      const dto = mapPersistedProfilesToDTOs(
        [persistedProfile] as unknown as Parameters<typeof mapPersistedProfilesToDTOs>[0],
        resourceTypeById,
        namedResourceById,
      )
      const p = dto[0]
      if (p) {
        map.set(ownerId, {
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
        continue
      }
    }

    // Legacy fallback: use mapper-derived profile
    map.set(ownerId, {
      planningBasis: profile.planningBasis,
      source: profile.source,
      defaultPercent: profile.defaultPercent ?? null,
      startWeek: profile.startWeek ?? null,
      endWeek: profile.endWeek ?? null,
      segments: profile.segments.map(s => ({
        startWeek: s.startWeek,
        endWeek: s.endWeek,
        capacityPercent: s.capacityPercent,
      })),
      resolutionSource: 'LEGACY',
    })
  }

  return map
}
