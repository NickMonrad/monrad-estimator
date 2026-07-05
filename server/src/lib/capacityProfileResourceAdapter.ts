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
import { compareCapacityProfiles } from './reconcileCapacityProfiles.js'
import { materializeCapacityPlanResources } from './capacityPlanMaterialisation.js'
import type {
  CapacityProfileDTO,
  CapacityProfileResourceTypeLike,
  CapacityProfileNamedResourceLike,
  CapacityPlanSlotInput,
} from './capacityProfileMapping.js'

// ─── Public types ────────────────────────────────────────────────────────────

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
  /** Capacity segments describing availability over time. */
  segments: CapacityProfileResourceSegment[]
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

// ─── Public helper ───────────────────────────────────────────────────────────

/**
 * Build a capacity-profile enrichment map keyed by owner id.
 *
 * Key rules:
 * - Role profiles → keyed by `resourceTypeId`
 * - Named-person / planned-resource profiles → keyed by `namedResourceId`
 *
 * When persisted CapacityProfile rows exist and are fully reconciled with
 * legacy-derived profiles, this returns data mapped from persisted rows.
 * Otherwise it falls back to legacy-derived profiles.
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

  // Derive the legacy mapper profiles (needed for comparison and fallback)
  const legacyProfiles = mapProjectToCapacityProfiles({
    projectId: project.id,
    resourceTypes: project.resourceTypes as unknown as CapacityProfileResourceTypeLike[],
    namedResourcesByResourceTypeId,
    capacityPlanSlotsByResourceTypeId,
  })

  // Determine source of profile data
  let sourceProfiles: CapacityProfileDTO[]
  const persisted = project.capacityProfiles

  if (persisted && persisted.length > 0) {
    const comparison = compareCapacityProfiles(
      project.id,
      legacyProfiles,
      persisted as unknown as Parameters<typeof compareCapacityProfiles>[2],
    )

    if (comparison.mismatches.length === 0) {
      // Persisted profiles are fully reconciled — use them
      const resourceTypeById = new Map<string, { id: string; name: string }>()
      const namedResourceById = new Map<string, { id: string; name: string; resourceTypeId: string }>()
      for (const rt of project.resourceTypes) {
        resourceTypeById.set(rt.id, { id: rt.id, name: rt.name })
        for (const nr of rt.namedResources) {
          namedResourceById.set(nr.id, { id: nr.id, name: nr.name, resourceTypeId: rt.id })
        }
      }
      sourceProfiles = mapPersistedProfilesToDTOs(
        persisted as unknown as Parameters<typeof mapPersistedProfilesToDTOs>[0],
        resourceTypeById,
        namedResourceById,
      )
    } else {
      // Reconciliation failed — fall back to legacy
      sourceProfiles = legacyProfiles
    }
  } else {
    // No persisted profiles — fall back to legacy
    sourceProfiles = legacyProfiles
  }

  // Build lookup map
  const map = new Map<string, CapacityProfileResourceData>()
  for (const profile of sourceProfiles) {
    // Role profiles keyed by resourceTypeId, named-person/planned-resource by their owner.id
    map.set(profile.owner.id, {
      planningBasis: profile.planningBasis,
      source: profile.source,
      segments: profile.segments.map(s => ({
        startWeek: s.startWeek,
        endWeek: s.endWeek,
        capacityPercent: s.capacityPercent,
      })),
    })
  }

  return map
}
