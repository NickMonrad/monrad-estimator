/**
 * schedulerCapacityResolver.ts — Shared profile-first capacity resolver for scheduler consumers.
 *
 * Centralises loading and resolution of project capacity into scheduler-facing DTOs.
 * Profile-first precedence: persisted CapacityProfile > active Capacity Plan fallback > legacy.
 *
 * Keeps scheduler.ts pure (no Prisma dependency).
 */

import {
  buildResourceCapacityProfileMap,
  type CapacityProfileAdapterInput,
} from './capacityProfileResourceAdapter.js'
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
 * Resolve profile-first capacity for scheduler consumers.
 *
 * Accepts PrismaClient or Prisma TransactionClient via structurally-typed `client`.
 *
 * Resolution order per named resource:
 * 1. Valid persisted CapacityProfile → capacitySegments populated from profile
 * 2. Active Capacity Plan trajectory → per-resource segments
 * 3. Legacy allocation fields preserved unchanged
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
    include: { namedResources: { orderBy: { createdAt: 'asc' } } },
  })
  const resourceTypes = rawRTs as Array<Record<string, unknown>>

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

  const resultRTs: SchedulerResourceType[] = resourceTypes.map((rt: any) => {
    const rtNamedResources: any[] = (rt.namedResources ?? []).filter(Boolean)

    const namedResources: SchedulerNamedResource[] = rtNamedResources.map((nr: any) => {
      const nameResourceProfiles = profileMap.namedResourceProfiles.get(nr.id)

      // Profile-first: valid persisted profile with segments
      if (nameResourceProfiles && nameResourceProfiles.resolutionSource === 'PROFILE' && nameResourceProfiles.segments.length > 0) {
        profileBackedCount++
        profileBackedNamedResourceIds.push(nr.id)
        const segments: SchedulerCapacitySegment[] = nameResourceProfiles.segments.map((s: any) => ({
          startWeek: s.startWeek,
          endWeek: s.endWeek,
          capacityPercent: s.capacityPercent,
        }))

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
          capacitySegments: segments,
        }
      }

      // Capacity plan trajectory → segments for individual named resources
      if (nameResourceProfiles && nameResourceProfiles.resolutionSource === 'ACTIVE_CAPACITY_PLAN' && nameResourceProfiles.segments.length > 0) {
        const segments: SchedulerCapacitySegment[] = nameResourceProfiles.segments.map((s: any) => ({
          startWeek: s.startWeek,
          endWeek: s.endWeek,
          capacityPercent: s.capacityPercent,
        }))

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
          capacitySegments: segments,
        }
      }

      // Legacy fallback — no valid profile or capacity plan trajectory
      legacyCount++
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
    })

    return {
      id: rt.id,
      name: rt.name,
      count: rt.count,
      hoursPerDay: rt.hoursPerDay ?? null,
      allocationMode: rt.allocationMode ?? 'EFFORT',
      namedResources,
    }
  })

  return {
    resourceTypes: resultRTs,
    meta: {
      profileBackedCount,
      legacyCount,
      profileBackedNamedResourceIds,
    },
    capacityPlanByRt,
  }
}
