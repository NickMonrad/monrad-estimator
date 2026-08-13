/**
 * capacityProfileResourceAdapter.ts — Adapter that maps persisted capacity-profile
 * data into the shape consumed by Resource Profile, export, and scheduler code.
 *
 * Enumerates every ResourceType role owner and every named/planned owner independently.
 * Persisted owner-specific profiles are the ONLY resolution source (issue #418):
 * missing, conflicting, or cross-project owner state fails closed with a
 * CapacityIntegrityError — there is no legacy-column fallback and no active-plan
 * rematerialisation over missing profiles.
 *
 * An explicit-only role (every named resource carries a NAMED_PERSON profile and
 * no planner ownership exists) is the single supported state without a ROLE profile.
 *
 * Any duplicate physical owner fails closed with a CapacityIntegrityError —
 * semantically identical duplicate rows are just as conflicting as divergent ones.
 *
 * Returns collision-safe separate maps for role-level and named/planned-resource profiles.
 */

import {
  mapPersistedProfilesToDTOs,
} from './capacityProfileMapping.js'
import { CapacityIntegrityError } from './capacityIntegrityError.js'
import { validateProfileStructure } from './capacityProfileStructureValidation.js'

// ─── Public types ────────────────────────────────────────────────────────────

export type CapacityProfileResolutionSource = 'PROFILE' | 'ACTIVE_CAPACITY_PLAN'

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
  /** Explicit behavioural provenance (issue #405) — TRANSFERRED_FROM_SQUAD_PLANNER marks #411 transferred planned resources. */
  provenance?: string | null
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
  resourceTypes: Array<{
    id: string
    name: string
    count: number
    hoursPerDay: number | null
    synthetic: boolean | null
    namedResources: Array<{
      id: string
      name: string
      pricingModel: string | null
      synthetic: boolean | null
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
    provenance?: string | null
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

/**
 * Classify a group of persisted profiles for the same owner.
 *
 * - NONE: no profiles exist.
 * - VALID: exactly one profile.
 * - CONFLICT: more than one physical row for the same owner — the caller
 *   fails closed. Duplicate rows are never compared for semantic equality
 *   and no canonical row is selected (issue #418 PR 1 review round 3).
 */
function classifyProfiles(
  profiles: PersistedProfile[],
): ProfileClassification {
  if (profiles.length === 0) return { kind: 'NONE' }
  if (profiles.length === 1) return { kind: 'VALID', profile: profiles[0] }

  return {
    kind: 'CONFLICT',
    ids: [...profiles].sort((a, b) => a.id.localeCompare(b.id)).map(p => p.id),
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
  provenance?: string | null,
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
    provenance: provenance ?? null,
  }
  if (ownerKind === 'PLANNED_RESOURCE' || ownerKind === 'NAMED_PERSON') {
    result.resourceIdentity = ownerKind === 'PLANNED_RESOURCE' ? 'PLANNED_RESOURCE' : 'NAMED_PERSON'
  }
  return result
}

// ─── Main function ───────────────────────────────────────────────────────────

/**
 * Build collision-safe capacity-profile enrichment maps from persisted profiles.
 *
 * Persisted owner-specific CapacityProfile rows are the only resolution source.
 * The builder fails closed with a CapacityIntegrityError when:
 *  - a profile references an owner outside the project or has malformed owner shape;
 *  - an owner has more than one physical profile row (duplicate owner) —
 *    identical duplicates fail closed exactly like conflicting ones;
 *  - a named resource has no valid profile;
 *  - a role has no valid ROLE profile unless every named resource of that role
 *    carries a NAMED_PERSON profile (explicit-only role, the one supported
 *    no-ROLE-profile state).
 *
 * Returns separate roleProfiles and namedResourceProfiles maps for collision-safe lookups.
 */
export function buildResourceCapacityProfileMap(
  project: CapacityProfileAdapterInput,
): CapacityProfileMap {
  // ── Phase 0: Build lookup maps ────────────────────────────────────────────

  const resourceTypeById = new Map<string, { id: string; name: string }>()
  const namedResourceById = new Map<string, { id: string; name: string; resourceTypeId: string }>()
  const rtIds = new Set<string>()
  const nrIds = new Set<string>()
  for (const rt of project.resourceTypes) {
    resourceTypeById.set(rt.id, { id: rt.id, name: rt.name })
    rtIds.add(rt.id)
    for (const nr of rt.namedResources) {
      namedResourceById.set(nr.id, { id: nr.id, name: nr.name, resourceTypeId: rt.id })
      nrIds.add(nr.id)
    }
  }

  // ── Phase 1: Classify persisted profiles ─────────────────────────────────

  const rtClassifications = new Map<string, ProfileClassification>()
  const nrClassifications = new Map<string, ProfileClassification>()

  const rawProfiles = project.capacityProfiles
  if (rawProfiles) {
    const rawByRT = new Map<string, PersistedProfile[]>()
    const rawByNR = new Map<string, PersistedProfile[]>()
    for (const cp of rawProfiles) {
      // Every persisted profile must satisfy the single authoritative
      // structural rule set (same rules readiness, mutations and v2
      // translation apply) BEFORE it can be converted into a runtime DTO.
      const structuralErrors = validateProfileStructure(
        cp as unknown as Parameters<typeof validateProfileStructure>[0],
        {
          projectId: project.id,
          resourceTypeIds: rtIds,
          namedResourceIds: nrIds,
        },
      )
      if (structuralErrors.length > 0) {
        throw new CapacityIntegrityError(
          `Capacity profile ${cp.id} is structurally invalid: ${structuralErrors.join('; ')}. ` +
          'Run the capacity profile audit/repair workflow before retrying this operation.',
        )
      }

      const hasRt = cp.resourceTypeId != null
      const hasNr = cp.namedResourceId != null
      if (cp.ownerKind === 'ROLE' && hasRt && !hasNr) {
        if (!rtIds.has(cp.resourceTypeId!)) {
          throw new CapacityIntegrityError(
            `Capacity profile ${cp.id} references resource type "${cp.resourceTypeId}" outside this project. ` +
            'Run the capacity profile audit/repair workflow before retrying this operation.',
          )
        }
        const arr = rawByRT.get(cp.resourceTypeId!) ?? []
        arr.push(cp)
        rawByRT.set(cp.resourceTypeId!, arr)
      } else if ((cp.ownerKind === 'NAMED_PERSON' || cp.ownerKind === 'PLANNED_RESOURCE') && hasNr && !hasRt) {
        if (!nrIds.has(cp.namedResourceId!)) {
          throw new CapacityIntegrityError(
            `Capacity profile ${cp.id} references named resource "${cp.namedResourceId}" outside this project. ` +
            'Run the capacity profile audit/repair workflow before retrying this operation.',
          )
        }
        const arr = rawByNR.get(cp.namedResourceId!) ?? []
        arr.push(cp)
        rawByNR.set(cp.namedResourceId!, arr)
      } else {
        // Malformed owner shape (both FKs, neither FK, or unknown ownerKind).
        throw new CapacityIntegrityError(
          `Capacity profile ${cp.id} has malformed ownership (ownerKind=${String(cp.ownerKind)}, ` +
          `resourceTypeId=${JSON.stringify(cp.resourceTypeId)}, namedResourceId=${JSON.stringify(cp.namedResourceId)}). ` +
          'Run the capacity profile audit/repair workflow before retrying this operation.',
        )
      }
    }

    for (const [rtId, profiles] of rawByRT) {
      rtClassifications.set(rtId, classifyProfiles(profiles))
    }
    for (const [nrId, profiles] of rawByNR) {
      nrClassifications.set(nrId, classifyProfiles(profiles))
    }
  }

  // ── Phase 2: Resolve VALID groups; fail closed on conflicts and gaps ─────

  const roleProfiles = new Map<string, CapacityProfileResourceData>()
  const namedResourceProfiles = new Map<string, CapacityProfileResourceData>()

  for (const [rtId, classification] of rtClassifications) {
    if (classification.kind === 'CONFLICT') {
      throw new CapacityIntegrityError(
        `Duplicate capacity profiles for role "${rtId}": ${(classification.ids ?? []).join(', ')}. ` +
        'Run the capacity profile audit/repair workflow before retrying this operation.',
      )
    }
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
    if (classification.kind === 'CONFLICT') {
      throw new CapacityIntegrityError(
        `Duplicate capacity profiles for named resource "${nrId}": ${(classification.ids ?? []).join(', ')}. ` +
        'Run the capacity profile audit/repair workflow before retrying this operation.',
      )
    }
    if (classification.kind === 'VALID' && classification.profile) {
      const dto = mapPersistedProfilesToDTOs(
        [classification.profile] as unknown as Parameters<typeof mapPersistedProfilesToDTOs>[0],
        resourceTypeById,
        namedResourceById,
      )
      if (dto[0]) {
        namedResourceProfiles.set(nrId, profileDtoToData(dto[0], classification.profile.ownerKind, classification.profile.provenance ?? null))
      }
    }
  }

  // ── Phase 3: Completeness — every owner resolves to exactly one profile ──

  for (const rt of project.resourceTypes) {
    for (const nr of rt.namedResources) {
      if (!namedResourceProfiles.has(nr.id)) {
        throw new CapacityIntegrityError(
          `Missing capacity profile for named resource ${nr.id}. ` +
          'Run the capacity profile backfill/repair workflow before retrying this operation.',
        )
      }
    }
    if (!roleProfiles.has(rt.id)) {
      // The single supported no-ROLE-profile state: an explicit-only role whose
      // every named resource carries a NAMED_PERSON profile.
      const allExplicitNamedPeople =
        rt.namedResources.length > 0 &&
        rt.namedResources.every(
          nr => namedResourceProfiles.get(nr.id)?.resourceIdentity === 'NAMED_PERSON',
        )
      if (!allExplicitNamedPeople) {
        throw new CapacityIntegrityError(
          `Missing role capacity profile for resource type ${rt.id}. ` +
          'Run the capacity profile backfill/repair workflow before retrying this operation.',
        )
      }
    }
  }

  return { roleProfiles, namedResourceProfiles }
}
