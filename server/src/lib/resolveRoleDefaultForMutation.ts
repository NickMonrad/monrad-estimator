/**
 * resolveRoleDefaultForMutation.ts — Pure helper that resolves the
 * authoritative role-level default for a ResourceType during PATCH count
 * mutations.
 *
 * The role-owned CapacityProfile is the source of truth when it exists.
 * ResourceType legacy fields serve only as a fallback when no role profile
 * has been persisted yet.
 *
 * @see capacityProfileLegacyProjection.ts for the projection algorithm
 * @see docs/domain/capacity-profile-source-of-truth-migration-plan.md
 */

import { projectCapacityProfileToLegacyAllocation } from './capacityProfileLegacyProjection.js'
import type { LegacyAllocationProjection, SegmentLike } from './capacityProfileLegacyProjection.js'

// ─── Input types ─────────────────────────────────────────────────────────────

export interface RoleDefaultResourceTypeLike {
  allocationMode: string | null
  allocationPercent: number | null
  allocationStartWeek: number | null
  allocationEndWeek: number | null
}


export interface RoleProfileLike {
  planningBasis: string
  defaultPercent: number | null
  startWeek: number | null
  endWeek: number | null
  segments: SegmentLike[]
}

// ─── Return type ─────────────────────────────────────────────────────────────

export type ResolvedRoleDefaultSource = 'PROFILE' | 'LEGACY'

export interface ResolvedRoleDefault {
  allocationMode: string
  allocationPercent: number
  allocationStartWeek: number | null
  allocationEndWeek: number | null
  source: ResolvedRoleDefaultSource
  /** True when the projection is lossy (multi-segment role profile). */
  lossy: boolean
  /** Human-readable explanation when lossy. */
  lossReason?: string
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Convert a projected allocation percent to the legacy `allocationPct`
 * integer field on NamedResource.
 *
 * `allocationPct` is `Int @default(100)` in the schema, so the Float
 * projection is rounded to the nearest integer.
 */
export function toLegacyAllocationPct(percent: number): number {
  return Math.round(percent)
}

/**
 * Normalize an enum value from UPPER_SNAKE_CASE (Prisma format) to
 * camelCase, as consumed by the projection helper.
 *
 * E.g., `'AVAILABILITY_WINDOW'` → `'availabilityWindow'`
 * `'CAPACITY_PROFILE'` → `'capacityProfile'`
 */
function normalizeEnum(value: string): string {
  return value.toLowerCase().replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())
}

/**
 * Check whether two legacy allocation projections are semantically identical
 * (within floating-point epsilon for percent).
 */
function projectionsAreIdentical(
  a: LegacyAllocationProjection,
  b: LegacyAllocationProjection,
): boolean {
  if (a.allocationMode !== b.allocationMode) return false
  const pctA = a.allocationPercent ?? 100
  const pctB = b.allocationPercent ?? 100
  if (Math.abs(pctA - pctB) > 1e-9) return false
  if (a.allocationStartWeek !== b.allocationStartWeek) return false
  if (a.allocationEndWeek !== b.allocationEndWeek) return false
  return true
}

// ─── Main helper ─────────────────────────────────────────────────────────────

/**
 * Resolve the authoritative role-level default from persisted role-owned
 * CapacityProfiles, falling back to ResourceType legacy fields.
 *
 * ## Priority
 *
 * 1. If exactly one valid role-owned profile exists → project it and return
 *    with `source: 'PROFILE'`.
 * 2. If multiple role-owned profiles exist and all project to the same legacy
 *    values → use the first/oldest, return with `source: 'PROFILE'`.
 * 3. If multiple conflicting role-owned profiles exist → throw an error.
 *    This prevents silently creating NR defaults from an ambiguous source.
 * 4. If no role-owned profile exists → return ResourceType legacy fields with
 *    `source: 'LEGACY'`.
 *
 * ## Multi-segment profiles
 *
 * A multi-segment role profile cannot be represented losslessly in legacy
 * NR scalar fields. The projection produces a merged range with a
 * duration-weighted average percent. The returned `lossy` flag and
 * `lossReason` field document this.
 *
 * ## Duplicate handling
 *
 * The schema currently does not enforce uniqueness on
 * `(resourceTypeId, namedResourceId, ownerKind)`.  The helper handles
 * well-known cases deterministically:
 *
 * - Semantically identical duplicates → safe, use first row.
 * - Conflicting duplicates → throw with a descriptive message.
 */
export function resolveRoleDefaultForMutation(params: {
  resourceType: RoleDefaultResourceTypeLike
  roleProfiles: readonly RoleProfileLike[]
}): ResolvedRoleDefault {
  const { resourceType } = params
  let { roleProfiles } = params
  roleProfiles = roleProfiles ?? []

  // ── Duplicate role profiles: check for conflicts ──────────────
  if (roleProfiles.length > 1) {
    const projections = roleProfiles.map(p =>
      projectCapacityProfileToLegacyAllocation({
        planningBasis: normalizeEnum(p.planningBasis),
        defaultPercent: p.defaultPercent,
        startWeek: p.startWeek,
        endWeek: p.endWeek,
        segments: p.segments,
        source: 'LEGACY', // placeholder — not meaningful for projection
      }),
    )

    const first = projections[0]
    const validProjections = projections.filter(
      (p): p is LegacyAllocationProjection => p !== null,
    )

    if (validProjections.length === 0) {
      return fallbackToLegacy(resourceType)
    }

    const allIdentical = validProjections.every(p =>
      projectionsAreIdentical(p, first!),
    )

    if (!allIdentical) {
      throw new Error(
        `Conflicting role-owned CapacityProfiles found for resource type. ` +
        `Cannot determine authoritative role default. ` +
        `Expected all role profiles to project to identical legacy values ` +
        `or provide exactly one profile.`,
      )
    }

    // All identical → use first valid projection
    return {
      allocationMode: first!.allocationMode,
      allocationPercent: first!.allocationPercent ?? 100,
      allocationStartWeek: first!.allocationStartWeek,
      allocationEndWeek: first!.allocationEndWeek,
      source: 'PROFILE',
      lossy: first!.lossy ?? false,
      lossReason: (first as any).lossReason,
    }
  }

  // ── Exactly one role profile → project ────────────────────────
  if (roleProfiles.length === 1) {
    const projection = projectCapacityProfileToLegacyAllocation({
      planningBasis: normalizeEnum(roleProfiles[0].planningBasis),
      defaultPercent: roleProfiles[0].defaultPercent,
      startWeek: roleProfiles[0].startWeek,
      endWeek: roleProfiles[0].endWeek,
      segments: roleProfiles[0].segments,
      source: 'LEGACY', // placeholder — not meaningful for projection
    })

    if (!projection) {
      return fallbackToLegacy(resourceType)
    }

    return {
      allocationMode: projection.allocationMode,
      allocationPercent: projection.allocationPercent ?? 100,
      allocationStartWeek: projection.allocationStartWeek,
      allocationEndWeek: projection.allocationEndWeek,
      source: 'PROFILE',
      lossy: projection.lossy ?? false,
      lossReason: (projection as any).lossReason,
    }
  }

  // ── No role profiles → use ResourceType legacy fields ─────────────
  return fallbackToLegacy(resourceType)
}

function fallbackToLegacy(
  resourceType: RoleDefaultResourceTypeLike,
): ResolvedRoleDefault {
  return {
    allocationMode: resourceType.allocationMode ?? 'EFFORT',
    allocationPercent: resourceType.allocationPercent ?? 100,
    allocationStartWeek: resourceType.allocationStartWeek ?? null,
    allocationEndWeek: resourceType.allocationEndWeek ?? null,
    source: 'LEGACY',
    lossy: false,
  }
}
