/**
 * schedulerCapacityResolver.ts — Shared profile-first capacity resolver for scheduler consumers.
 *
 * Centralises loading and resolution of project capacity into scheduler-facing DTOs.
 * Profile-first precedence: persisted CapacityProfile > active Capacity Plan fallback > legacy.
 *
 * Resolution per named resource:
 * 1. Valid persisted profile (segmented, fixed, or availability-window) → capacitySegments
 * 2. Active Capacity Plan trajectory → per-resource segments
 * 3. Legacy allocation fields preserved unchanged
 *
 * Role-level profiles are applied to phantom slot capacity.
 *
 * Keeps scheduler.ts pure (no Prisma dependency).
 */

import {
  buildResourceCapacityProfileMap,
  type CapacityProfileAdapterInput,
  type CapacityProfileResourceData,
} from './capacityProfileResourceAdapter.js'
import { projectCapacityProfileToLegacyAllocation } from './capacityProfileLegacyProjection.js'
import {
  materializeCapacityPlanResources,
  matchTrajectoriesToResources,
  shouldFallbackToActiveCapacityPlan,
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
 * Build a single SchedulerNamedResource with profile segments from a
 * CapacityProfileResourceData.
 *
 * When profile data is available, the allocationMode is projected from the
 * profile's planning basis (e.g. CAPACITY_PROFILE → CAPACITY_PLAN) rather
 * than using the stale legacy NamedResource.allocationMode field.
 */
function buildProfileBackedNR(
  nr: any,
  segments: SchedulerCapacitySegment[],
  profile?: CapacityProfileResourceData | null,
): SchedulerNamedResource {
  // Project allocation mode from profile when available; fall back to legacy
  let allocationMode = nr.allocationMode ?? 'EFFORT'
  let allocationPercent = nr.allocationPercent ?? 100
  let allocationStartWeek: number | null = nr.allocationStartWeek ?? null
  let allocationEndWeek: number | null = nr.allocationEndWeek ?? null

  if (profile) {
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
    if (projection) {
      allocationMode = projection.allocationMode
      allocationPercent = projection.allocationPercent ?? allocationPercent
      allocationStartWeek = projection.allocationStartWeek
      allocationEndWeek = projection.allocationEndWeek
    }
  }

  return {
    id: nr.id,
    name: nr.name,
    // Profile-backed: legacy startWeek/endWeek fields are no longer authoritative
    // for capacity calculation, but we preserve them for display/diagnostics
    startWeek: nr.startWeek ?? null,
    endWeek: nr.endWeek ?? null,
    allocationPct: nr.allocationPct,
    allocationMode,
    allocationPercent,
    allocationStartWeek,
    allocationEndWeek,
    pricingModel: nr.pricingModel ?? undefined,
    capacitySegments: segments,
  }
}

/**
 * Build legacy-fallback SchedulerNamedResource (no profile).
 */
function buildLegacyNR(nr: any): SchedulerNamedResource {
  return {
    id: nr.id,
    name: nr.name,
    startWeek: nr.startWeek ?? null,
    endWeek: nr.endWeek ?? null,
    allocationPct: nr.allocationPct,
    allocationMode: nr.allocationMode ?? 'EFFORT',
    allocationPercent: nr.allocationPercent ?? 100,
    allocationStartWeek: nr.allocationStartWeek ?? null,
    allocationEndWeek: nr.allocationEndWeek ?? null,
    pricingModel: nr.pricingModel ?? undefined,
    capacitySegments: undefined,
  }
}

/**
 * Resolve profile-first capacity for scheduler consumers.
 *
 * Accepts PrismaClient or Prisma TransactionClient.
 *
 * @param client   Prisma client or transaction client
 * @param projectId  Project to resolve capacity for
 * @param hoursPerDay Project default hours per day
 * @returns Resolved scheduler capacity
 */
export async function resolveSchedulerCapacity(
  client: any,
  projectId: string,
  hoursPerDay: number,
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

  // ── 3. Load active capacity plan for fallback ────────────────────────────
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

  // ── 4. Build profile lookup maps using the existing adapter ──────────────
  const profileMap = buildResourceCapacityProfileMap({
    id: projectId,
    hoursPerDay,
    resourceTypes: resourceTypes as unknown as CapacityProfileAdapterInput['resourceTypes'],
    capacityProfiles: capacityProfiles as unknown as CapacityProfileAdapterInput['capacityProfiles'],
    capacityPlans: activeCapacityPlan ? [activeCapacityPlan] : [],
  } as unknown as CapacityProfileAdapterInput)

  // ── 5. Map rows to scheduler DTOs with profile-aware segments ────────────
  let profileBackedCount = 0
  let legacyCount = 0
  const profileBackedNamedResourceIds: string[] = []
  const roleProfileRTIds: string[] = []

  const resultRTs: SchedulerResourceType[] = resourceTypes.map((rt: any) => {
    const rtNamedResources: any[] = (rt.namedResources ?? []).filter(Boolean)
    const roleProfile = profileMap.roleProfiles.get(rt.id)
    const roleProfileValid = roleProfile && roleProfile.resolutionSource === 'PROFILE'

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
          nrProfile?.resolutionSource === 'PROFILE' &&
          nrProfile?.source === 'squadPlanner'
      })
    const useRoleSegments = roleProfileValid && !hasSquadPlannerPlannedResources

    if (useRoleSegments) {
      roleProfileRTIds.push(rt.id)
    }

    // Track per-NR resolution source to distinguish PROFILE from ACTIVE_CAPACITY_PLAN
    const nrSources = new Map<string, 'PROFILE' | 'ACTIVE_CAPACITY_PLAN' | 'LEGACY'>()

    const namedResources: SchedulerNamedResource[] = rtNamedResources.map((nr: any) => {
      const nrProfile = profileMap.namedResourceProfiles.get(nr.id)

      // Profile-first: valid persisted profile
      if (nrProfile && nrProfile.resolutionSource === 'PROFILE') {
        const segments = profileDataToSchedulerSegments(nrProfile)
        profileBackedCount++
        profileBackedNamedResourceIds.push(nr.id)
        nrSources.set(nr.id, 'PROFILE')
        return buildProfileBackedNR(nr, segments, nrProfile)
      }

      // Capacity plan trajectory → per-resource segments
      if (nrProfile && nrProfile.resolutionSource === 'ACTIVE_CAPACITY_PLAN') {
        const segments = profileDataToSchedulerSegments(nrProfile)
        profileBackedCount++
        profileBackedNamedResourceIds.push(nr.id)
        nrSources.set(nr.id, 'ACTIVE_CAPACITY_PLAN')
        return buildProfileBackedNR(nr, segments, nrProfile)
      }

      // Legacy fallback — no valid profile
      legacyCount++
      nrSources.set(nr.id, 'LEGACY')
      return buildLegacyNR(nr)
    })

    // ── 5b. Capacity plan fallback: create synthetic NRs where appropriate ──
    const allocationMode: string = rt.allocationMode ?? 'EFFORT'
    const materialized = capacityPlanByRt.get(rt.id)

    // Only a VALID role-level profile suppresses plan fallback. NR profile
    // segments do NOT — the plan fallback code already handles PROFILE NRs
    // by keeping their segments via matchTrajectoriesToResources.
    const hasProfileAuthority = useRoleSegments

    if (
      !hasProfileAuthority &&
      allocationMode === 'CAPACITY_PLAN' &&
      materialized &&
      shouldFallbackToActiveCapacityPlan(namedResources, materialized)
    ) {
      // Single code path: use matchTrajectoriesToResources to map ALL
      // trajectories to ALL ordered persisted NRs. For each pairing:
      //   - If the NR has a valid PROFILE source → keep its profile segments
      //   - Otherwise → use trajectory segments
      // This preserves stable IDs for matched NRs, generates deterministic
      // synthetic IDs for unmatched trajectories, and never drops a persisted
      // NR or loses a trajectory (defect #362 remediation).
      const trajectories = materialized.resourceTrajectories
      const matched = matchTrajectoriesToResources(
        trajectories,
        rt.id,
        rt.name,
        rtNamedResources.map((nr: any) => ({ id: nr.id, name: nr.name })),
      )

      const planSlots: SchedulerNamedResource[] = matched.map(m => {
        // Does this matched resource have a valid persisted PROFILE?
        const existingNR = namedResources.find(nr => nr.id === m.id)
        const hasProfile = existingNR && nrSources.get(m.id) === 'PROFILE'

        if (hasProfile && existingNR) {
          // Keep the profile-backed NR as-is — its segments are authoritative
          return existingNR
        }

        // Use trajectory segments for this slot
        const firstSeg = m.slotWindows[0]
        const lastSeg = m.slotWindows.length > 0 ? m.slotWindows[m.slotWindows.length - 1] : null
        return {
          id: m.id,
          name: m.name,
          startWeek: firstSeg?.startWeek ?? null,
          endWeek: lastSeg?.endWeek ?? null,
          allocationPct: firstSeg?.allocationPercent ?? 100,
          allocationMode: 'CAPACITY_PLAN',
          allocationPercent: firstSeg?.allocationPercent ?? 100,
          allocationStartWeek: null,
          allocationEndWeek: null,
          capacitySegments: m.slotWindows,
        }
      })

      // Preserve unmatched persisted NRs — but set them to zero capacity.
      // When the plan fallback runs, the plan's trajectories are the
      // authoritative capacity. Unmatched NRs (e.g. original TIMELINE
      // resources that became surplus after planner apply) must not
      // contribute phantom or legacy capacity.
      const matchedExistingIds = new Set(
        matched.filter(m => m.existingNamedResourceId).map(m => m.existingNamedResourceId!),
      )
      const unmatchedPersisted: SchedulerNamedResource[] = namedResources
        .filter(nr => !matchedExistingIds.has(nr.id))
        .map(nr => ({
          id: nr.id,
          name: nr.name,
          startWeek: null,
          endWeek: null,
          allocationPct: 0,
          allocationMode: 'CAPACITY_PLAN',
          allocationPercent: 0,
          allocationStartWeek: null,
          allocationEndWeek: null,
          capacitySegments: [{ startWeek: 0, endWeek: 9999, allocationPercent: 0 }],
        }))

      return {
        id: rt.id,
        name: rt.name,
        count: rt.count,
        hoursPerDay: rt.hoursPerDay ?? null,
        allocationMode: 'CAPACITY_PLAN',
        namedResources: [...planSlots, ...unmatchedPersisted],
        // Explicit empty roleSegments: the plan fallback replaces the ROLE
        // profile as authoritative capacity. Undefined would cause
        // getWeeklyCapacity to fall through to phantom slots (count-based).
        // Empty array signals 'no role capacity, no phantom slots'.
        roleSegments: [],
        capacityPlanResolved: true,
      }
    }

    return {
      id: rt.id,
      name: rt.name,
      count: rt.count,
      hoursPerDay: rt.hoursPerDay ?? null,
      allocationMode,
      namedResources,
      roleSegments: useRoleSegments ? profileDataToSchedulerSegments(roleProfile) : (roleProfileValid ? [] : undefined),
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
