/**
 * schedulerCapacityResolver.ts — Shared profile-first capacity resolver for scheduler consumers.
 *
 * Centralises loading and resolution of project capacity into scheduler-facing DTOs.
 * Persisted CapacityProfile / CapacitySegment state is the ONLY resolution source
 * (issue #418): the adapter fails closed on missing, conflicting, malformed or
 * cross-project owner state, so no legacy-column fallback exists in this resolver.
 *
 * Legacy-shaped DTO fields (allocationMode / allocationPercent / allocationPct /
 * allocationStartWeek / allocationEndWeek / startWeek / endWeek) are derived from
 * the authoritative profile via the projection helper — never read from
 * ResourceType or NamedResource database columns.
 *
 * Transferred planned resources (Squad Planner → manual, #411) keep their
 * identity and preserved profile data but contribute zero capacity while a
 * manual ROLE CAPACITY_PROFILE profile is the scheduling authority. The
 * suppression is driven by the explicit TRANSFERRED_FROM_SQUAD_PLANNER
 * provenance (issue #405), never by legacy column values.
 *
 * Keeps scheduler.ts pure (no Prisma dependency).
 */

import {
  buildResourceCapacityProfileMap,
  type CapacityProfileAdapterInput,
  type CapacityProfileResourceData,
} from './capacityProfileResourceAdapter.js'
import { projectCapacityProfileToLegacyAllocation } from './capacityProfileLegacyProjection.js'
import { CapacityIntegrityError } from './capacityIntegrityError.js'
import {
  materializeCapacityPlanResources,
  type MaterializedCapacityPlanResource,
} from './capacityPlanMaterialisation.js'
import type {
  SchedulerResourceType,
  SchedulerNamedResource,
  SchedulerCapacitySegment,
} from './scheduler.js'

// ─── Public API ───────────────────────────────────────────────────────────

/**
 * Resolution metadata for diagnostics and tests — describes how each resource
 * type's capacity was resolved.
 */
export interface CapacityResolutionMeta {
  /** Number of named resources with profile-backed segments. */
  profileBackedCount: number
  /** Number of named resources using legacy fallback. */
  legacyCount: number
  /** IDs of named resources resolved from a valid persisted profile. */
  profileBackedNamedResourceIds: string[]
  /** Resource type IDs where a valid role-level profile was applied to phantom slots. */
  roleProfileRTIds: string[]
}

/**
 * Result of resolving scheduler capacity for a project.
 */
export interface ResolvedSchedulerCapacity {
  /** Resource types with profile-aware capacity segments populated. */
  resourceTypes: SchedulerResourceType[]
  /** Resolution metadata for diagnostics. */
  meta: CapacityResolutionMeta
  /** Materialised capacity plan data (for consumers that still need it). */
  capacityPlanByRt: Map<string, MaterializedCapacityPlanResource>
}

/**
 * Convert a CapacityProfileResourceData (from the adapter) to scheduler segments.
 * Handles both segment-based profiles and scalar (fixed/avail-window) profiles.
 */
function profileDataToSchedulerSegments(
  data: CapacityProfileResourceData,
): SchedulerCapacitySegment[] {
  // Segment-based profile: use segments directly
  if (data.segments.length > 0) {
    return data.segments.map(s => ({
      startWeek: s.startWeek,
      endWeek: s.endWeek,
      allocationPercent: s.capacityPercent,
    }))
  }

  // Scalar profile (fixed or availability-window): derive a single segment from defaultPercent/startWeek/endWeek
  const pct = data.defaultPercent != null ? data.defaultPercent : 100
  const start = data.startWeek ?? 0
  const end = data.endWeek ?? Infinity

  if (start === 0 && !Number.isFinite(end)) {
    // Whole-project fixed profile → single segment covering everything
    return [{ startWeek: 0, endWeek: Infinity, allocationPercent: pct }]
  }

  // Availability window without segments → single window segment
  return [{ startWeek: start, endWeek: end, allocationPercent: pct }]
}

/**
 * Build a SchedulerNamedResource with profile-derived capacity segments and
 * legacy-shaped compatibility fields projected from the authoritative profile.
 *
 * No ResourceType/NamedResource candidate column is read: every field except
 * id/name/pricingModel comes from the profile projection.
 */
function buildProfileBackedNR(
  nr: { id: string; name: string; pricingModel?: string | null },
  segments: SchedulerCapacitySegment[],
  profile: CapacityProfileResourceData,
): SchedulerNamedResource {
  const projection = projectCapacityProfileToLegacyAllocation({
    planningBasis: profile.planningBasis,
    source: profile.source,
    defaultPercent: profile.defaultPercent,
    startWeek: profile.startWeek,
    endWeek: profile.endWeek,
    segments: profile.segments.map(s => ({
      startWeek: s.startWeek,
      endWeek: s.endWeek,
      capacityPercent: s.capacityPercent,
    })),
  })

  const allocationMode = projection?.allocationMode ?? 'EFFORT'
  const allocationPercent = projection?.allocationPercent ?? 100
  const allocationStartWeek = projection?.allocationStartWeek ?? null
  const allocationEndWeek = projection?.allocationEndWeek ?? null

  return {
    id: nr.id,
    name: nr.name,
    // Legacy-shaped aliases are profile-derived compatibility output only.
    startWeek: allocationStartWeek,
    endWeek: allocationEndWeek,
    allocationPct: Math.round(allocationPercent),
    allocationMode,
    allocationPercent,
    allocationStartWeek,
    allocationEndWeek,
    pricingModel: nr.pricingModel ?? undefined,
    capacitySegments: segments,
  }
}

/**
 * Build the zero-capacity SchedulerNamedResource for a transferred planned
 * resource (issue #411). Identity and preserved profile data are kept, but the
 * capacity segments are explicitly zero while the manual ROLE CAPACITY_PROFILE
 * profile is the scheduling authority.
 */
function buildTransferredZeroNR(
  nr: { id: string; name: string; pricingModel?: string | null },
  _profile: CapacityProfileResourceData,
): SchedulerNamedResource {
  // The transferred planned resource is deliberately suppressed under the
  // manual ROLE authority (issue #411): every compatibility capacity output
  // must represent zero contribution so scheduler, Timeline and Resource
  // Profile views stay consistent (issue #418 PR 1 review). The preserved
  // underlying profile is untouched — this is presentation-only.
  return {
    id: nr.id,
    name: nr.name,
    startWeek: null,
    endWeek: null,
    allocationPct: 0,
    allocationMode: 'CAPACITY_PLAN',
    allocationPercent: 0,
    allocationStartWeek: null,
    allocationEndWeek: null,
    pricingModel: nr.pricingModel ?? undefined,
    // Explicit zero segment: the ROLE profile is the authority; this resource
    // must not contribute independent capacity and must not fall through to
    // any legacy window calculation.
    capacitySegments: [{ startWeek: 0, endWeek: Infinity, allocationPercent: 0 }],
  }
}

/**
 * Resolve profile-first capacity for scheduler consumers.
 *
 * Accepts PrismaClient or Prisma TransactionClient.
 *
 * @param client   Prisma client or transaction client
 * @param projectId  Project to resolve capacity for
 * @returns Resolved scheduler capacity
 */
export async function resolveSchedulerCapacity(
  client: any,
  projectId: string,
): Promise<ResolvedSchedulerCapacity> {
  // ── 1. Load resource types with named resources ──────────────────────────
  const rawRTs = await client.resourceType.findMany({
    where: { projectId },
    orderBy: [{ name: 'asc' }],
    include: { namedResources: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] } },
  })
  const resourceTypes = (rawRTs as Array<Record<string, unknown>>).map(rt => {
    const nrs = ((rt.namedResources ?? []) as Array<Record<string, unknown>>)
      .sort((a: any, b: any) => {
        const aTime = a.createdAt?.getTime?.() ?? 0
        const bTime = b.createdAt?.getTime?.() ?? 0
        if (aTime !== bTime) return aTime - bTime
        return (a.id ?? '').localeCompare(b.id ?? '')
      })
    return { ...rt, namedResources: nrs }
  })

  // ── 2. Load capacity profiles with segments ──────────────────────────────
  const rawProfiles = await client.capacityProfile.findMany({
    where: { projectId },
    include: {
      segments: {
        orderBy: [
          { startWeek: 'asc' },
          { endWeek: 'asc' },
        ],
      },
    },
  })
  const capacityProfiles = rawProfiles as Array<Record<string, unknown>>

  // ── 3. Load active capacity plan for display materialisation ─────────────
  const rawPlan = await client.capacityPlan.findFirst({
    where: { projectId, isActive: true },
    include: {
      periods: {
        include: { entries: true },
        orderBy: { periodIndex: 'asc' },
      },
    },
  })
  const activeCapacityPlan = rawPlan as Record<string, unknown> | null

  const capacityPlanByRt = materializeCapacityPlanResources(
    Array.isArray((activeCapacityPlan as any)?.periods)
      ? (activeCapacityPlan as any).periods
      : [],
  )

  // ── 4. Build profile lookup maps using the existing adapter (fail-closed) ─
  const profileMap = buildResourceCapacityProfileMap({
    id: projectId,
    resourceTypes: resourceTypes as unknown as CapacityProfileAdapterInput['resourceTypes'],
    capacityProfiles: capacityProfiles as unknown as CapacityProfileAdapterInput['capacityProfiles'],
  })

  // ── 5. Map rows to scheduler DTOs with profile-derived segments ──────────
  let profileBackedCount = 0
  let legacyCount = 0
  const profileBackedNamedResourceIds: string[] = []
  const roleProfileRTIds: string[] = []

  const resultRTs: SchedulerResourceType[] = resourceTypes.map((rt: any) => {
    const rtNamedResources: any[] = (rt.namedResources ?? []).filter(Boolean)
    const roleProfile = profileMap.roleProfiles.get(rt.id)
    const roleProfileValid = roleProfile != null

    // When Squad Planner persists both an aggregate ROLE profile (source:
    // 'squadPlanner') AND planned-resource profiles for the same RT, they
    // represent the same active plan capacity. Use only the planned-resource
    // trajectories for scheduler capacity — don't expose roleSegments to
    // avoid double-counting aggregate capacity on top of individual capacity.
    const roleProfileIsSquadPlanner = roleProfile?.source === 'squadPlanner'
    // The aggregate ROLE profile must only be suppressed when the overlapping
    // planned-resource profiles are ALSO authoritative Squad Planner profiles.
    // A manual, imported, derived, or fallback PLANNED_RESOURCE must NOT
    // suppress a Squad Planner ROLE profile.
    const hasSquadPlannerPlannedResources = roleProfileIsSquadPlanner &&
      rtNamedResources.some((nr: any) => {
        const nrProfile = profileMap.namedResourceProfiles.get(nr.id)
        return nrProfile?.resourceIdentity === 'PLANNED_RESOURCE' &&
          nrProfile?.source === 'squadPlanner'
      })
    const useRoleSegments = roleProfileValid && !hasSquadPlannerPlannedResources

    if (useRoleSegments) {
      roleProfileRTIds.push(rt.id)
    }

    const namedResources: SchedulerNamedResource[] = rtNamedResources.map((nr: any) => {
      const nrProfile = profileMap.namedResourceProfiles.get(nr.id)

      // The adapter fails closed on missing/conflicting profiles, so every
      // persisted named resource resolves here. Defensive throw keeps the
      // invariant explicit for future callers.
      if (!nrProfile) {
        throw new CapacityIntegrityError(
          `Missing capacity profile for named resource ${nr.id}. ` +
          'Run the capacity profile backfill/repair workflow before retrying this operation.',
        )
      }

      // After Squad Planner → manual transfer (issue #411):
      // The ROLE profile is the sole scheduling authority. ONLY planned-resource
      // profiles carrying TRANSFERRED_FROM_SQUAD_PLANNER provenance retain
      // their identity and segment data but must not contribute independent
      // capacity while a valid MANUAL ROLE CAPACITY_PROFILE exists. An
      // independently authored manual planned-resource profile without that
      // provenance remains scheduler-authoritative.
      const isTransferredPlannedResource =
        nrProfile.resourceIdentity === 'PLANNED_RESOURCE' &&
        nrProfile.source === 'manual' &&
        nrProfile.provenance === 'TRANSFERRED_FROM_SQUAD_PLANNER' &&
        roleProfile?.source === 'manual' &&
        roleProfile?.planningBasis === 'capacityProfile' &&
        roleProfileValid

      if (isTransferredPlannedResource) {
        legacyCount++
        return buildTransferredZeroNR(
          { id: nr.id, name: nr.name, pricingModel: nr.pricingModel ?? undefined },
          nrProfile,
        )
      }

      // Profile-first: valid persisted profile
      const segments = profileDataToSchedulerSegments(nrProfile)
      profileBackedCount++
      profileBackedNamedResourceIds.push(nr.id)
      return buildProfileBackedNR(
        { id: nr.id, name: nr.name, pricingModel: nr.pricingModel ?? undefined },
        segments,
        nrProfile,
      )
    })

    // RT-level allocation mode is projected from the authoritative role
    // profile. Explicit-only roles (no ROLE profile) present as EFFORT.
    const roleProjection = roleProfile
      ? projectCapacityProfileToLegacyAllocation({
          planningBasis: roleProfile.planningBasis,
          source: roleProfile.source,
          defaultPercent: roleProfile.defaultPercent,
          startWeek: roleProfile.startWeek,
          endWeek: roleProfile.endWeek,
          segments: roleProfile.segments.map(s => ({
            startWeek: s.startWeek,
            endWeek: s.endWeek,
            capacityPercent: s.capacityPercent,
          })),
        })
      : null

    return {
      id: rt.id,
      name: rt.name,
      count: rt.count,
      hoursPerDay: rt.hoursPerDay ?? null,
      allocationMode: roleProjection?.allocationMode ?? 'EFFORT',
      namedResources,
      // No roleSegments → getWeeklyCapacity falls back to phantom count slots
      // (legacy semantics). A role without a ROLE profile is legal only as an
      // explicit-only role whose every NR is profile-backed (adapter-enforced),
      // so the profile-derived NR capacity is the complete authority — never
      // phantom slots on top of it (issue #418).
      roleSegments: useRoleSegments
        ? profileDataToSchedulerSegments(roleProfile)
        : roleProfileValid
          ? []
          : [],
    }
  })

  return {
    resourceTypes: resultRTs,
    meta: {
      profileBackedCount,
      legacyCount,
      profileBackedNamedResourceIds,
      roleProfileRTIds,
    },
    capacityPlanByRt,
  }
}
