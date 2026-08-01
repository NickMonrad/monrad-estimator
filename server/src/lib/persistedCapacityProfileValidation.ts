/**
 * persistedCapacityProfileValidation.ts — Structural validator for persisted
 * CapacityProfile/CapacitySegment rows.
 *
 * Per-profile structure delegates to the single authoritative
 * `validateProfileStructure` helper (shared with readiness, mutation loading,
 * runtime reads, rollback retained-ownership validation and v2 translation);
 * this module adds the cross-profile duplicate-owner check and the
 * completeness assessment.
 */

import { validateProfileStructure } from './capacityProfileStructureValidation.js'

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ValidationContext {
  projectId: string
  resourceTypeIds: ReadonlySet<string>
  namedResourceIds: ReadonlySet<string>
}

export interface ValidationResult {
  valid: boolean
  errors: string[]
}

// ─── Core validator ─────────────────────────────────────────────────────────

export function validatePersistedCapacityProfiles(
  profiles: ReadonlyArray<{
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
      capacityProfileId?: string | null
      startWeek: number
      endWeek: number
      capacityPercent: number
      source: string
    }>
  }>,
  context: ValidationContext,
): ValidationResult {
  const errors: string[] = []

  // Track physical owner keys (by FK namespace + ID) to detect duplicates
  const ownerKeys = new Map<string, string>() // key → first profile id

  for (const p of profiles) {
    // Per-profile structural rules come from the single authoritative
    // validator (planning-basis-specific rules included).
    errors.push(...validateProfileStructure(p, context))

    // ── No duplicate physical owner keys ───────────────────────────────
    // Physical owner is identified by FK namespace + ID, not by ownerKind.
    // A resourceTypeId can only appear once (for ROLE), and a namedResourceId
    // can only appear once (cannot be both NAMED_PERSON and PLANNED_RESOURCE).
    const physKey = p.resourceTypeId
      ? `resourceTypeId::${p.resourceTypeId}`
      : p.namedResourceId
        ? `namedResourceId::${p.namedResourceId}`
        : '' // caught by shape validation
    if (physKey && ownerKeys.has(physKey)) {
      errors.push(
        `Profile ${p.id}: duplicate physical owner "${physKey}" ` +
        `(first occurrence in profile ${ownerKeys.get(physKey)})`,
      )
    } else if (physKey) {
      ownerKeys.set(physKey, p.id)
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  }
}

// ─── Completeness assessment ──────────────────────────────────────────────────

export interface PersistedCompletenessInput {
  resourceTypes: Array<{
    id: string
    name: string
    namedResources: Array<{ id: string; name: string }>
  }>
  capacityProfiles: Array<{
    resourceTypeId: string | null
    namedResourceId: string | null
    ownerKind: string
    source: string
    planningBasis: string
  }>
}

/**
 * Assess whether persisted profiles cover the complete project authority
 * boundary. Planner-owned capacity requires an aggregate ROLE profile;
 * explicit-only named people are allowed without one.
 */
export function checkPersistedCompleteness(
  input: PersistedCompletenessInput,
): string[] {
  const errors: string[] = []
  const profilesByResourceType = new Map<string, typeof input.capacityProfiles>()
  for (const profile of input.capacityProfiles) {
    if (!profile.resourceTypeId) continue
    const profiles = profilesByResourceType.get(profile.resourceTypeId) ?? []
    profiles.push(profile)
    profilesByResourceType.set(profile.resourceTypeId, profiles)
  }

  for (const resourceType of input.resourceTypes) {
    const namedResourceIds = new Set(resourceType.namedResources.map(namedResource => namedResource.id))
    const profiles = [
      ...(profilesByResourceType.get(resourceType.id) ?? []),
      ...input.capacityProfiles.filter(
        profile => profile.namedResourceId != null && namedResourceIds.has(profile.namedResourceId),
      ),
    ]
    const roleProfiles = profiles.filter(
      profile => profile.resourceTypeId === resourceType.id && profile.ownerKind === 'ROLE',
    )
    const hasPlannerOwnership = profiles.some(
      profile => profile.ownerKind === 'PLANNED_RESOURCE' || profile.source === 'SQUAD_PLANNER',
    )

    for (const namedResource of resourceType.namedResources) {
      const ownerProfiles = input.capacityProfiles.filter(
        profile => profile.namedResourceId === namedResource.id,
      )
      if (ownerProfiles.length === 0) {
        errors.push(`Named resource "${namedResource.id}" for RT "${resourceType.id}" lacks persisted profile`)
      }
    }

    if (hasPlannerOwnership && roleProfiles.length !== 1) {
      errors.push(
        `Resource type "${resourceType.id}" has planner-owned profiles but requires exactly one ROLE profile`,
      )
    } else if (resourceType.namedResources.length === 0 && roleProfiles.length !== 1) {
      errors.push(`Resource type "${resourceType.id}" lacks exactly one persisted ROLE profile`)
    }
  }

  return errors
}
