/**
 * squadPlannerProfileWriter.ts — Profile-first Squad Planner apply path.
 *
 * Replaces the broad legacy-to-profile sync (syncCapacityProfilesForProject)
 * with direct authoritative writes of ROLE and PLANNED_RESOURCE profiles,
 * then projects required legacy compatibility fields from the committed profile state.
 *
 * Exported pure helpers are separately unit-testable.
 * Async helpers accept a Prisma transaction client and return typed results.
 */

// Using PrismaClient's own transaction client type.
// We define the type via Parameters inference to avoid coupling to internal Prisma types.
import type { PrismaClient } from '@prisma/client'
export type PrismaTransactionClient = Parameters<Parameters<PrismaClient['$transaction']>[0]>[0]
import {
  materializeResourceTrajectories,
  materializeRoleCapacitySegments,
  computeDefaultPercentForSegments,
  type CapacityPlanSlotWindow,
  type CapacityPlanPeriodInput,
  type CapacityPlanResourceTrajectory,
} from './capacityPlanMaterialisation.js'
import { projectCapacityProfileToLegacyAllocation } from './capacityProfileLegacyProjection.js'
import type { CapacityProfileSource } from '@prisma/client'

// ─── Public types ───────────────────────────────────────────────────────────

export interface RoleProfileWriteSet {
  resourceTypeId: string
  defaultPercent: number | null
  startWeek: number | null
  endWeek: number | null
  segments: Array<{ startWeek: number; endWeek: number; capacityPercent: number }>
}

export interface PlannedResourceProfileWriteSet {
  namedResourceId: string
  trajectoryIndex: number
  defaultPercent: number | null
  startWeek: number | null
  endWeek: number | null
  segments: Array<{ startWeek: number; endWeek: number; capacityPercent: number }>
}

export interface PlannerProfileApplyResult {
  roleProfiles: RoleProfileWriteSet[]
  plannedResourceProfiles: PlannedResourceProfileWriteSet[]
  surplusResourceIds: string[]
}

export interface ConflictResourceInfo {
  resourceTypeId: string
  resourceTypeName: string
  namedResourceName?: string
}

export interface ConflictCheckResult {
  hasConflict: boolean
  duplicateOwnerProfiles: ConflictResourceInfo[]
  protectedNamedPersonProfiles: ConflictResourceInfo[]
}

/** Minimal persisted profile shape for conflict and classification checks. */
interface PersistedProfileSummary {
  id: string
  projectId: string
  resourceTypeId: string | null
  namedResourceId: string | null
  ownerKind: string
  source: string
  planningBasis?: string
}

/** Sources that represent explicit/manual ownership and must not be replaced. */
const PROTECTED_PROFILE_SOURCES: Record<string, true> = {
  MANUAL: true,
  FIXED: true,
  AVAILABILITY_WINDOW: true,
  IMPORTED: true,
}

/**
 * The exact (source, planningBasis) pairs produced by the mapper for a
 * legacy ROLE capacity profile when the ResourceType has no active Capacity
 * Plan slots. These are the only ROLE provenance combinations the planner
 * may safely adopt under allowLegacyRole — all other non-SQUAD_PLANNER
 * ROLE profiles remain rejected to preserve fail-closed ownership.
 */
const LEGACY_ROLE_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['AVAILABILITY_WINDOW', 'AVAILABILITY_WINDOW'],
  ['FIXED', 'DEMAND_FOLLOWING'],
  ['FIXED', 'WHOLE_PROJECT_ALLOCATION'],
  ['LEGACY', 'DEMAND_FOLLOWING'],
]

/** True when the (source, planningBasis) pair is one of the four legacy
 * mapper-produced ROLE pairs. Used only by `validatePlannerOwnerState` when
 * `allowLegacyRole` is enabled. */
function isLegacyRoleProfile(source: string, planningBasis: string): boolean {
  return LEGACY_ROLE_PAIRS.some(([s, p]) => source === s && planningBasis === p)
}

/** Minimal NamedResource shape for deterministic ordering. */
interface NamedResourceSummary {
  id: string
  name: string
  createdAt: Date
  allocationMode?: string | null
}

/** Legacy planner rows may be adopted only when every planner marker agrees. */
export function isLegacyPlannerProfile(
  profile: Pick<PersistedProfileSummary, 'ownerKind' | 'source' | 'planningBasis'>,
  namedResource: Pick<NamedResourceSummary, 'allocationMode'>,
): boolean {
  return profile.ownerKind === 'NAMED_PERSON'
    && profile.source === 'SQUAD_PLANNER'
    && profile.planningBasis === 'CAPACITY_PROFILE'
    && namedResource.allocationMode === 'CAPACITY_PLAN'
}

export interface PlannerProvenance {
  /** True only when the previous active CapacityPlan contained this role. */
  priorActivePlan: boolean
  /** Named resources created in the current transaction are trusted planner rows. */
  readonly createdResourceIds?: ReadonlySet<string>
}


/**
 * Immutable prior-planner authority captured at the start of a Serializable
 * transaction, before any active-plan mutation. Contains the prior active plan
 * identity and the complete set of resource types it covers, so downstream
 * functions (revalidation, find-or-create, omitted-role cleanup) never need to
 * post-mutation query isActive:true for prior-plan evidence.
 *
 * `allPlannerResourceTypeIds` is the union of:
 * - active-plan resource types
 * - ROLE+SQUAD_PLANNER+CAPACITY_PROFILE profile resource types
 * - PLANNED_RESOURCE+SQUAD_PLANNER profile resource types
 * - legacy NAMED_PERSON+SQUAD_PLANNER+CAPACITY_PROFILE profile resource types
 */
export interface PriorPlannerAuthority {
  readonly activePlanId: string | null
  readonly activePlanResourceTypeIds: ReadonlySet<string>
  /** Valid ROLE+SQUAD_PLANNER+CAPACITY_PROFILE resource types. */
  readonly plannerRoleResourceTypeIds: ReadonlySet<string>
  /** All resource type IDs with any planner-owned profile evidence captured before mutation. */
  readonly allPlannerResourceTypeIds: ReadonlySet<string>
}

/**
 * Capture the current active plan authority AND all planner-owned profile
 * evidence before any mutation in a Serializable transaction.
 *
 * Queries four sources in parallel:
 * 1. Active plan (if any) — resource type IDs from period entries
 * 2. ROLE+SQUAD_PLANNER+CAPACITY_PROFILE profiles
 * 3. PLANNED_RESOURCE+SQUAD_PLANNER profiles (via namedResource)
 * 4. Legacy NAMED_PERSON+SQUAD_PLANNER+CAPACITY_PROFILE profiles (via namedResource)
 *
 * The returned object is frozen and uses ReadonlySet for immutability.
 */
export async function capturePlannerAuthority(
  tx: PrismaTransactionClient,
  projectId: string,
): Promise<PriorPlannerAuthority> {
  const [activePlan, plannerRoleProfiles, plannerManagedProfiles, legacyPlannerProfiles] =
    await Promise.all([
      tx.capacityPlan.findFirst({
        where: { projectId, isActive: true },
        select: {
          id: true,
          periods: {
            select: {
              entries: {
                select: { resourceTypeId: true },
              },
            },
          },
        },
      }),
      // ROLE-level planner profiles
      tx.capacityProfile.findMany({
        where: {
          projectId,
          ownerKind: 'ROLE',
          source: 'SQUAD_PLANNER',
          planningBasis: 'CAPACITY_PROFILE',
          namedResourceId: null,
          resourceTypeId: { not: null },
        },
        select: { resourceTypeId: true },
      }),
      // PLANNED_RESOURCE planner profiles (join through namedResource)
      // Filtered to valid planningBasis CAPACITY_PROFILE so stale or
      // invalid source/basis rows do not become planner authority.
      tx.capacityProfile.findMany({
        where: {
          projectId,
          ownerKind: 'PLANNED_RESOURCE',
          source: 'SQUAD_PLANNER',
          planningBasis: 'CAPACITY_PROFILE',
          namedResourceId: { not: null },
        },
        select: {
          namedResource: { select: { resourceTypeId: true } },
        },
      }),
      // Legacy planner profiles
      tx.capacityProfile.findMany({
        where: {
          projectId,
          ownerKind: 'NAMED_PERSON',
          source: 'SQUAD_PLANNER',
          planningBasis: 'CAPACITY_PROFILE',
          namedResourceId: { not: null },
        },
        select: {
          namedResource: { select: { resourceTypeId: true } },
        },
      }),
    ])

  const activePlanRtIds = new Set(
    activePlan?.periods.flatMap(p => p.entries.map(e => e.resourceTypeId)) ?? [],
  )
  const plannerRoleRtIds = new Set(
    plannerRoleProfiles
      .map(p => p.resourceTypeId)
      .filter((id): id is string => id !== null),
  )
  const plannerManagedRtIds = new Set(
    plannerManagedProfiles
      .map(p => p.namedResource?.resourceTypeId)
      .filter((id): id is string => id !== undefined),
  )
  const legacyPlannerRtIds = new Set(
    legacyPlannerProfiles
      .map(p => p.namedResource?.resourceTypeId)
      .filter((id): id is string => id !== undefined),
  )

  const allPlannerResourceTypeIds = new Set([
    ...activePlanRtIds,
    ...plannerRoleRtIds,
    ...plannerManagedRtIds,
    ...legacyPlannerRtIds,
  ])

  return Object.freeze({
      activePlanId: activePlan?.id ?? null,
      activePlanResourceTypeIds: activePlanRtIds,
      plannerRoleResourceTypeIds: plannerRoleRtIds,
      allPlannerResourceTypeIds,
    }) as PriorPlannerAuthority
}

/**
 * Derive planner provenance for a single resource type from a captured
 * PriorPlannerAuthority. Returns priorActivePlan:true exactly when the
 * resource type was a member of the prior active plan.
 */
export function plannerProvenanceFrom(
  authority: PriorPlannerAuthority,
  resourceTypeId: string,
): PlannerProvenance {
  return { priorActivePlan: authority.activePlanResourceTypeIds.has(resourceTypeId) }
}
const noPlannerProvenance: PlannerProvenance = { priorActivePlan: false }
// ─── Shared planner-managed resource classification ─────────────────────────

/**
 * Planner-managed resource classification: shared by conflict preflight and
 * write path for deterministic matching. Each resource is classified by its
 * full profile set, ordered by priority:
 *
 * 1. PROTECTED_PROFILE_SOURCES   → 'explicit_person'   (never matched)
 * 2. Non-legacy NAMED_PERSON     → 'explicit_person' (never matched)
 * 3. Legacy adoptable (all markers) → 'legacy_adoptable' (matched)
 * 4. PLANNED_RESOURCE+SQUAD_PLANNER → 'planner_managed' (matched)
 * 5. No profiles + CAPACITY_PLAN mode + prior active-plan provenance
 *    → 'capacity_plan_untouched' (matched)
 * 6. Everything else → 'other'
 */
export type PlannerResourceKind =
  | 'explicit_person'
  | 'legacy_adoptable'
  | 'planner_managed'
  | 'capacity_plan_untouched'
  | 'other'

/**
 * Classify a single named resource by its full profile set.
 * Used by both conflict preflight and write path for consistent
 * planner-vs-explicit determination.
 */
export function classifyNamedResource(
  namedResource: Pick<NamedResourceSummary, 'allocationMode'> & { id?: string },
  profiles: ReadonlyArray<Pick<PersistedProfileSummary, 'ownerKind' | 'source' | 'planningBasis'>>,
  provenance: PlannerProvenance = noPlannerProvenance,
): PlannerResourceKind {
  for (const profile of profiles) {
    if (profile.source && PROTECTED_PROFILE_SOURCES[profile.source]) {
      return 'explicit_person'
    }
  }
  for (const profile of profiles) {
    if (profile.ownerKind === 'NAMED_PERSON' && !isLegacyPlannerProfile(profile, namedResource)) {
      return 'explicit_person'
    }
  }
  for (const profile of profiles) {
    if (isLegacyPlannerProfile(profile, namedResource)) {
      return 'legacy_adoptable'
    }
  }
  for (const profile of profiles) {
    if (profile.ownerKind === 'PLANNED_RESOURCE' && profile.source === 'SQUAD_PLANNER') {
      return 'planner_managed'
    }
  }
  if (profiles.length === 0
    && namedResource.allocationMode === 'CAPACITY_PLAN'
    && (provenance.priorActivePlan
      || (namedResource.id !== undefined && provenance.createdResourceIds?.has(namedResource.id)))) {
    return 'capacity_plan_untouched'
  }
  return 'other'
}

/**
 * True if a resource is planner-managed (legacy-adoptable, existing planner-owned,
 * or an unprofiled legacy row backed by prior active-plan provenance).
 */
export function isPlannerManaged(
  namedResource: Pick<NamedResourceSummary, 'allocationMode'> & { id?: string },
  profiles: ReadonlyArray<Pick<PersistedProfileSummary, 'ownerKind' | 'source' | 'planningBasis'>>,
  provenance: PlannerProvenance = noPlannerProvenance,
): boolean {
  const kind = classifyNamedResource(namedResource, profiles, provenance)
  return kind === 'legacy_adoptable'
    || kind === 'planner_managed'
    || kind === 'capacity_plan_untouched'
}


// ─── Segment mapping helper ─────────────────────────────────────────────────

function slotsToSegmentLikes(
  slots: CapacityPlanSlotWindow[],
): Array<{ startWeek: number; endWeek: number; capacityPercent: number }> {
  return slots.map(s => ({
    startWeek: s.startWeek,
    endWeek: s.endWeek,
    capacityPercent: s.allocationPercent,
  }))
}

// ─── Pure: build role-level profile write set ───────────────────────────────

/**
 * Build a ROLE capacity profile write set from materialised resource data.
 * Uses `materializeRoleCapacitySegments` for non-overlapping ordered segments.
 */
export function buildRoleProfileData(
  resourceTypeId: string,
  periods: CapacityPlanPeriodInput[],
): RoleProfileWriteSet {
  const rtPeriods = periods.map(p => ({
    periodIndex: p.periodIndex,
    startWeek: p.startWeek,
    endWeek: p.endWeek,
    headcount: p.entries.find(e => e.resourceTypeId === resourceTypeId)?.headcount ?? 0,
  }))

  // Build weekly headcount (same logic as materializeCapacityPlanResources)
  const weeklyHeadcount = new Map<number, number>()
  for (const period of rtPeriods) {
    for (let week = period.startWeek; week < period.endWeek; week++) {
      weeklyHeadcount.set(week, period.headcount)
    }
  }

  const segments = materializeRoleCapacitySegments(weeklyHeadcount)
  const defaultPercent = computeDefaultPercentForSegments(segments)

  const firstWeek = segments.length > 0 ? Math.min(...segments.map(s => s.startWeek)) : null
  const lastWeek = segments.length > 0 ? Math.max(...segments.map(s => s.endWeek)) : null

  return {
    resourceTypeId,
    defaultPercent,
    startWeek: firstWeek,
    endWeek: lastWeek,
    segments: slotsToSegmentLikes(segments),
  }
}

// ─── Pure: build planned-resource profile write sets from trajectories ──────

/**
 * Build PLANNED_RESOURCE capacity profile write sets from materialised
 * resource trajectories and deterministically ordered named resources.
 *
 * Each trajectory maps to one named resource (index-based). Resources beyond
 * the trajectory count are NOT included here — the caller handles shrink.
 */
export function buildPlannedResourceProfileData(
  trajectories: CapacityPlanResourceTrajectory[],
  namedResources: Array<{ id: string; name: string }>,
): PlannedResourceProfileWriteSet[] {
  return trajectories.map((trajectory, idx) => {
    const nr = namedResources[idx]
    if (!nr) {
      throw new Error(
        `Trajectory index ${idx} has no matching named resource — ` +
        `requires ${trajectories.length} resources but only ${namedResources.length} available. ` +
        `Check named resource ordering and planner resource classification.`
      )
    }
    const segments = slotsToSegmentLikes(trajectory.segments)
    const defaultPercent = computeDefaultPercentForSegments(trajectory.segments)
    const startWeek = segments.length > 0 ? Math.min(...segments.map(s => s.startWeek)) : null
    const endWeek = segments.length > 0 ? Math.max(...segments.map(s => s.endWeek)) : null

    return {
      namedResourceId: nr.id,
      trajectoryIndex: trajectory.trajectoryIndex,
      defaultPercent,
      startWeek,
      endWeek,
      segments,
    }
  })
}

// ─── Pure: build zero-capacity profile data for surplus resources ───────────

/**
 * Build a zero-capacity PLANNED_RESOURCE profile write set.
 * The profile has no segments, 0% defaultPercent, and null date fields.
 * This prevents stale legacy capacity from being read.
 */
export function buildZeroCapacityProfileData(
  namedResourceId: string,
): PlannedResourceProfileWriteSet {
  return {
    namedResourceId,
    trajectoryIndex: -1,
    defaultPercent: 0,
    startWeek: null,
    endWeek: null,
    segments: [],
  }
}

// ─── Pure: conflict classification ─────────────────────────────────────────

/**
 * Classify existing persisted profiles for conflict preflight.
 * Returns structured conflict information.
 *
 * Conflict rules:
 * - Duplicate ROLE profiles for the same resource type → fail
 * - Named resources with NAMED_PERSON ownerKind → fail (protected explicit profiles)
 */
export function classifyProfileConflicts(
  existingRoleProfiles: PersistedProfileSummary[],
  existingResourceProfiles: PersistedProfileSummary[],
  trajectoryCount: number,
  orderedNamedResources: NamedResourceSummary[],
): ConflictCheckResult {
  const duplicateOwnerProfiles: ConflictResourceInfo[] = []
  const protectedNamedPersonProfiles: ConflictResourceInfo[] = []

  // Check duplicate ROLE profiles
  if (existingRoleProfiles.length > 1) {
    duplicateOwnerProfiles.push({
      resourceTypeId: existingRoleProfiles[0].resourceTypeId ?? '',
      resourceTypeName: 'role',
      namedResourceName: undefined,
    })
  }

  // Check duplicate and protected profiles within the trajectory-used range
  const usedResources = orderedNamedResources.slice(0, trajectoryCount)
  const usedResourceIdSet = new Set(usedResources.map(r => r.id))
  const profilesByNamedResource = new Map<string, PersistedProfileSummary[]>()

  for (const profile of existingResourceProfiles) {
    if (!profile.namedResourceId || !usedResourceIdSet.has(profile.namedResourceId)) continue
    const profiles = profilesByNamedResource.get(profile.namedResourceId) ?? []
    profiles.push(profile)
    profilesByNamedResource.set(profile.namedResourceId, profiles)
  }

  for (const [namedResourceId, profiles] of profilesByNamedResource) {
    const namedResourceName = usedResources.find(r => r.id === namedResourceId)?.name
    if (profiles.length > 1) {
      duplicateOwnerProfiles.push({
        resourceTypeId: profiles[0].resourceTypeId ?? '',
        resourceTypeName: 'named-resource',
        namedResourceName,
      })
    }
    const namedResource = usedResources.find(r => r.id === namedResourceId) ?? { allocationMode: null }
    const kind = classifyNamedResource(namedResource, profiles)
    if (kind === 'explicit_person') {
      protectedNamedPersonProfiles.push({
        resourceTypeId: profiles[0].resourceTypeId ?? '',
        resourceTypeName: 'named-person',
        namedResourceName,
      })
    }
  }

  return {
    hasConflict: duplicateOwnerProfiles.length > 0 || protectedNamedPersonProfiles.length > 0,
    duplicateOwnerProfiles,
    protectedNamedPersonProfiles,
  }
}

/**
 * Validate every profile claiming ownership of one affected resource type.
 * This is the single fail-closed ownership validator used before adoption,
 * matching, and writes. It deliberately never repairs malformed rows.
 */
export async function validatePlannerOwnerState(
  tx: PrismaTransactionClient,
  projectId: string,
  resourceTypeId: string,
  allowLegacyRole?: boolean,
): Promise<ConflictResourceInfo[]> {
  const resourceType = await tx.resourceType.findUnique({
    where: { id: resourceTypeId },
    select: { id: true, name: true, projectId: true },
  })
  if (!resourceType || resourceType.projectId !== projectId) {
    return [{ resourceTypeId, resourceTypeName: 'resource-type' }]
  }

  const namedResources = (await tx.namedResource.findMany({
    where: { resourceTypeId },
    select: { id: true, name: true },
  })) ?? []
  const namedResourceById = new Map(namedResources.map(resource => [resource.id, resource]))
  const namedResourceIds = namedResources.map(resource => resource.id)
  const profiles = (await tx.capacityProfile.findMany({
    where: {
      OR: [
        { resourceTypeId },
        ...(namedResourceIds.length > 0 ? [{ namedResourceId: { in: namedResourceIds } }] : []),
      ],
    },
    select: {
      id: true,
      projectId: true,
      resourceTypeId: true,
      namedResourceId: true,
      ownerKind: true,
      source: true,
      planningBasis: true,
    },
  })) ?? []
  const conflicts: ConflictResourceInfo[] = []
  const seen = new Set<string>()
  const mark = (profileId: string, namedResourceName?: string) => {
    if (seen.has(profileId)) return
    seen.add(profileId)
    conflicts.push({
      resourceTypeId,
      resourceTypeName: resourceType.name,
      namedResourceName,
    })
  }

  const profilesByNamedResource = new Map<string, typeof profiles>()
  for (const profile of profiles) {
    if (profile.namedResourceId) {
      const list = profilesByNamedResource.get(profile.namedResourceId) ?? []
      list.push(profile)
      profilesByNamedResource.set(profile.namedResourceId, list)
    }
    if (profile.projectId !== projectId) {
      mark(profile.id, profile.namedResourceId ? namedResourceById.get(profile.namedResourceId)?.name : undefined)
    }

    if (profile.resourceTypeId === resourceTypeId) {
      if (profile.namedResourceId !== null || profile.ownerKind !== 'ROLE') {
        mark(profile.id, profile.namedResourceId ? namedResourceById.get(profile.namedResourceId)?.name : undefined)
      } else if (profile.ownerKind === 'ROLE') {
        const validSquadPlanner = profile.source === 'SQUAD_PLANNER' && profile.planningBasis === 'CAPACITY_PROFILE'
        const validLegacyRole = allowLegacyRole && isLegacyRoleProfile(profile.source, profile.planningBasis)
        if (!validSquadPlanner && !validLegacyRole) {
          mark(profile.id, profile.namedResourceId ? namedResourceById.get(profile.namedResourceId)?.name : undefined)
        }
      }
    }
    if (profile.namedResourceId) {
      const namedResource = namedResourceById.get(profile.namedResourceId)
      if (!namedResource || profile.resourceTypeId !== null || profile.ownerKind === 'ROLE') {
        mark(profile.id, namedResource?.name)
      } else if (
        profile.ownerKind === 'PLANNED_RESOURCE'
        && (profile.source !== 'SQUAD_PLANNER' || profile.planningBasis !== 'CAPACITY_PROFILE')
      ) {
        mark(profile.id, namedResource.name)
      } else if (
        profile.ownerKind === 'NAMED_PERSON'
        && profile.source === 'SQUAD_PLANNER'
        && profile.planningBasis !== 'CAPACITY_PROFILE'
      ) {
        mark(profile.id, namedResource.name)
      } else if (profile.ownerKind !== 'PLANNED_RESOURCE' && profile.ownerKind !== 'NAMED_PERSON') {
        mark(profile.id, namedResource.name)
      }
    }
  }

  const roleProfiles = profiles.filter(profile => profile.resourceTypeId === resourceTypeId)
  if (roleProfiles.length > 1) {
    for (const profile of roleProfiles.slice(1)) mark(profile.id)
  }
  for (const [namedResourceId, resourceProfiles] of profilesByNamedResource) {
    if (resourceProfiles.length > 1) {
      for (const profile of resourceProfiles.slice(1)) {
        mark(profile.id, namedResourceById.get(namedResourceId)?.name)
      }
    }
  }

  return conflicts
}

async function hasPriorActivePlanEvidence(
  tx: PrismaTransactionClient,
  projectId: string,
  resourceTypeId: string,
): Promise<boolean> {
  const activePlan = await tx.capacityPlan.findFirst({
    where: { projectId, isActive: true },
    select: {
      periods: {
        select: {
          entries: {
            where: { resourceTypeId },
            select: { id: true },
          },
        },
      },
    },
  })
  return activePlan?.periods.some(period => period.entries.length > 0) ?? false
}

// ─── Async: conflict preflight (reads DB via tx) ─────────────────────────────

/**
 * Run conflict preflight checks for all resource types in the plan.
 * Reads existing profiles and named resources via the transaction client.
 * Returns typed conflict info or undefined if no conflicts.
 *
 * Must be called BEFORE snapshot creation to avoid orphan undo snapshots.
 */
export async function conflictPreflightCheck(
  tx: PrismaTransactionClient,
  projectId: string,
  periods: CapacityPlanPeriodInput[],
  allowLegacyRole?: boolean,
): Promise<ConflictCheckResult | undefined> {
  const resourceTypeIds = [...new Set(periods.flatMap(p => p.entries.map(e => e.resourceTypeId)))]
  const allDuplicates: ConflictResourceInfo[] = []

  for (const rtId of resourceTypeIds) {
    allDuplicates.push(...await validatePlannerOwnerState(tx, projectId, rtId, allowLegacyRole))
    // Fetch existing ROLE profiles for this resource type
    const roleProfiles = (await tx.capacityProfile.findMany({
      where: { projectId, resourceTypeId: rtId, ownerKind: 'ROLE' },
      select: { id: true },
    })) ?? []

    if (roleProfiles.length > 1) {
      allDuplicates.push({
        resourceTypeId: rtId,
        resourceTypeName: 'role',
      })
    }

    // Fetch trajectories count for this resource type
    const rtPeriods = periods.map(p => ({
      periodIndex: p.periodIndex,
      startWeek: p.startWeek,
      endWeek: p.endWeek,
      headcount: p.entries.find(e => e.resourceTypeId === rtId)?.headcount ?? 0,
    }))
    const trajectories = materializeResourceTrajectories(rtPeriods)
    const trajectoryCount = trajectories.length

    // Fetch named resources with stable ordering (includes createdAt for buildPlannerResourcePlan)
    const namedResources = (await tx.namedResource.findMany({
      where: { resourceTypeId: rtId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { id: true, name: true, createdAt: true, allocationMode: true },
    })) ?? []

    const resourceProfiles = namedResources.length === 0
      ? []
      : (await tx.capacityProfile.findMany({
          where: {
            projectId,
            namedResourceId: { in: namedResources.map(resource => resource.id) },
          },
          select: { namedResourceId: true, source: true, ownerKind: true, planningBasis: true },
        })) ?? []

    const plan = buildPlannerResourcePlan(
      namedResources,
      resourceProfiles,
      rtId,
      'role',
      trajectoryCount,
      { priorActivePlan: await hasPriorActivePlanEvidence(tx, projectId, rtId) },
    )

    allDuplicates.push(...plan.conflicts)
  }

  if (allDuplicates.length > 0) {
    return {
      hasConflict: true,
      duplicateOwnerProfiles: allDuplicates,
      protectedNamedPersonProfiles: [],
    }
  }

  return undefined
}

// ─── Async: find or create planner-managed named resources ───────────────────

export interface PlannedResourceMatchResult {
  /** The first requiredCount planner-managed resources in stable order. */
  namedResources: Array<{ id: string; name: string }>
  /** All planner-managed resources, including surplus resources to zero. */
  allNamedResources: Array<{ id: string; name: string }>
  created: number
}

/**
 * Find existing named resources with stable ordering (createdAt, id)
 * and create any missing placeholders to match the required trajectory count.
 *
 * Returns the deterministic list of named resources and the count created.
 */
export async function findOrCreatePlannedResources(
  tx: PrismaTransactionClient,
  resourceTypeId: string,
  resourceTypeName: string,
  requiredCount: number,
  projectId?: string,
  authority?: PriorPlannerAuthority,
  allowLegacyRole?: boolean,
): Promise<PlannedResourceMatchResult> {
  const existingNRs = await tx.namedResource.findMany({
    where: { resourceTypeId },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { id: true, name: true, createdAt: true, allocationMode: true },
  })
  const existingProfiles = existingNRs.length === 0
    ? []
    : await tx.capacityProfile.findMany({
      where: { namedResourceId: { in: existingNRs.map(nr => nr.id) } },
      select: { namedResourceId: true, ownerKind: true, source: true, planningBasis: true },
    })
  const ownerConflicts = projectId
    ? await validatePlannerOwnerState(tx, projectId, resourceTypeId, allowLegacyRole)
    : []
  if (ownerConflicts.length > 0) {
    throw new PlannerConflictError(
      `Invalid planner ownership for resource type "${resourceTypeName}" — repair required before applying.`,
      ownerConflicts,
    )
  }
  const priorActivePlan = authority
    ? authority.activePlanResourceTypeIds.has(resourceTypeId)
    : projectId
      ? await hasPriorActivePlanEvidence(tx, projectId, resourceTypeId)
      : false

  const plan = buildPlannerResourcePlan(
    existingNRs,
    existingProfiles,
    resourceTypeId,
    resourceTypeName,
    requiredCount,
    { priorActivePlan },
  )

  if (plan.hasConflict) {
    throw new PlannerConflictError(
      `Duplicate/ambiguous owner profiles for resource type "${resourceTypeName}" — ` +
      `repair required before applying.`,
      plan.conflicts,
    )
  }

  const missing = plan.shortfall
  if (missing > 0) {
    const startIndex = existingNRs.length + 1
    const newNRs = Array.from({ length: missing }, (_, i) => ({
      resourceTypeId,
      name: `${resourceTypeName} ${startIndex + i}`,
      allocationMode: 'CAPACITY_PLAN' as const,
      startWeek: 0,
    }))
    await tx.namedResource.createMany({ data: newNRs })
  }

  // Re-read to capture newly created resource IDs
  const allNRs = await tx.namedResource.findMany({
    where: { resourceTypeId },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { id: true, name: true, createdAt: true, allocationMode: true },
  })
  const existingResourceIds = new Set(existingNRs.map(resource => resource.id))
  const createdResourceIds = new Set(
    allNRs
      .filter(resource => !existingResourceIds.has(resource.id))
      .map(resource => resource.id),
  )
  const allProfiles = allNRs.length === 0
    ? []
    : await tx.capacityProfile.findMany({
        where: { namedResourceId: { in: allNRs.map(nr => nr.id) } },
        select: { namedResourceId: true, ownerKind: true, source: true, planningBasis: true },
      })
  const finalOwnerConflicts = projectId
    ? await validatePlannerOwnerState(tx, projectId, resourceTypeId, allowLegacyRole)
    : []
  if (finalOwnerConflicts.length > 0) {
    throw new PlannerConflictError(
      `Planner resource ownership changed while applying resource type "${resourceTypeName}".`,
      finalOwnerConflicts,
    )
  }

  const finalPlan = buildPlannerResourcePlan(
    allNRs,
    allProfiles,
    resourceTypeId,
    resourceTypeName,
    requiredCount,
    { priorActivePlan, createdResourceIds },
  )

  if (finalPlan.hasConflict || finalPlan.plannerResources.length < requiredCount) {
    const conflicts = finalPlan.conflicts.length > 0
      ? finalPlan.conflicts
      : finalPlan.explicitResources.map(resource => ({
          resourceTypeId,
          resourceTypeName,
          namedResourceName: resource.name,
        }))
    throw new PlannerConflictError(
      `Planner resource ownership changed while applying resource type "${resourceTypeName}".`,
      conflicts,
    )
  }

  return {
    namedResources: finalPlan.plannerResources.slice(0, requiredCount),
    allNamedResources: finalPlan.allPlannerResources,
    created: missing,
  }
}

// ─── Async: write profiles and segments ─────────────────────────────────────

export interface ProfileWriteResult {
  roleProfilesWritten: number
  plannedResourceProfilesWritten: number
  segmentsWritten: number
  surplusProfilesWritten: number
}

/**
 * Persist ROLE and PLANNED_RESOURCE profiles with their segments.
 * Replaces existing planner-owned profiles: deletes stale segments first,
 * updates profile metadata, then creates new segments.
 *
 * For surplus resources (beyond trajectory count), writes zero-capacity profiles.
 */
export async function writePlannerProfiles(
  tx: PrismaTransactionClient,
  projectId: string,
  roleProfiles: RoleProfileWriteSet[],
  plannedProfiles: PlannedResourceProfileWriteSet[],
  surplusResourceIds: string[],
  source: 'SQUAD_PLANNER' = 'SQUAD_PLANNER',
  allowLegacyRole?: boolean,
): Promise<ProfileWriteResult> {
  let roleProfilesWritten = 0
  let plannedResourceProfilesWritten = 0
  let segmentsWritten = 0
  let surplusProfilesWritten = 0
  const prismaSource = source as CapacityProfileSource
  const plannedResourceIds = plannedProfiles.map(profile => profile.namedResourceId)
  const plannedOwners = plannedResourceIds.length === 0
    ? []
    : await tx.namedResource.findMany({
        where: { id: { in: plannedResourceIds } },
        select: { id: true, resourceTypeId: true },
      })
  if (plannedOwners.length !== plannedResourceIds.length) {
    throw new PlannerConflictError(
      'A planner-owned NamedResource is missing or belongs to an unrelated project.',
      [{ resourceTypeId: '', resourceTypeName: 'named-resource' }],
    )
  }
  const ownerResourceTypeIds = new Set([
    ...roleProfiles.map(profile => profile.resourceTypeId),
    ...plannedOwners.map(owner => owner.resourceTypeId),
  ])
  for (const resourceTypeId of ownerResourceTypeIds) {
    const ownerConflicts = await validatePlannerOwnerState(tx, projectId, resourceTypeId, allowLegacyRole)
    if (ownerConflicts.length > 0) {
      throw new PlannerConflictError(
        'Invalid planner ownership state — repair required before applying.',
        ownerConflicts,
      )
    }
  }

  for (const rp of roleProfiles) {
    const existingList = await tx.capacityProfile.findMany({
      where: { projectId, resourceTypeId: rp.resourceTypeId, ownerKind: 'ROLE' },
      select: { id: true, resourceTypeId: true, namedResourceId: true },
    })
    if (existingList.length > 1) {
      throw new PlannerConflictError(
        `Duplicate ROLE profiles exist for resource type ${rp.resourceTypeId} — ` +
        `repair required before applying.`,
        [{ resourceTypeId: rp.resourceTypeId, resourceTypeName: 'role' }],
      )
    }
    const existing = existingList[0] ?? null
    if (existing && (existing.resourceTypeId !== rp.resourceTypeId || existing.namedResourceId !== null)) {
      throw new PlannerConflictError(
        `ROLE profile ownership is ambiguous for resource type ${rp.resourceTypeId}.`,
        [{ resourceTypeId: rp.resourceTypeId, resourceTypeName: 'role' }],
      )
    }
    const profile = existing
      ? await tx.capacityProfile.update({
          where: { id: existing.id },
          data: {
            resourceTypeId: rp.resourceTypeId,
            namedResourceId: null,
            ownerKind: 'ROLE',
            planningBasis: 'CAPACITY_PROFILE',
            source: prismaSource,
            defaultPercent: rp.defaultPercent,
            startWeek: rp.startWeek,
            endWeek: rp.endWeek,
          },
        })
      : await tx.capacityProfile.create({
          data: {
            projectId,
            resourceTypeId: rp.resourceTypeId,
            namedResourceId: null,
            ownerKind: 'ROLE',
            planningBasis: 'CAPACITY_PROFILE',
            source: prismaSource,
            defaultPercent: rp.defaultPercent,
            startWeek: rp.startWeek,
            endWeek: rp.endWeek,
          },
        })
    await tx.capacitySegment.deleteMany({ where: { capacityProfileId: profile.id } })
    if (rp.segments.length > 0) {
      await tx.capacitySegment.createMany({
        data: rp.segments.map(s => ({
          capacityProfileId: profile.id,
          startWeek: s.startWeek,
          endWeek: s.endWeek,
          capacityPercent: s.capacityPercent,
          source: prismaSource,
        })),
      })
      segmentsWritten += rp.segments.length
    }
    roleProfilesWritten++
  }

  for (const pp of plannedProfiles) {
    const existingList = await tx.capacityProfile.findMany({
      where: { projectId, namedResourceId: pp.namedResourceId },
      select: { id: true, ownerKind: true, source: true, planningBasis: true },
    })
    if (existingList.length > 1) {
      throw new PlannerConflictError(
        `Duplicate capacity profiles exist for named resource ${pp.namedResourceId} — ` +
        `repair required before applying.`,
        [{
          resourceTypeId: '',
          resourceTypeName: 'named-resource',
          namedResourceName: pp.namedResourceId,
        }],
      )
    }
    const existing = existingList[0] ?? null
    if (
      existing &&
      !(
        (existing.ownerKind === 'PLANNED_RESOURCE' && existing.source === 'SQUAD_PLANNER') ||
        (existing.ownerKind === 'NAMED_PERSON'
          && existing.source === 'SQUAD_PLANNER'
          && existing.planningBasis === 'CAPACITY_PROFILE')
      )
    ) {
      throw new PlannerConflictError(
        `Explicit owner profile appeared for named resource ${pp.namedResourceId} during apply.`,
        [{
          resourceTypeId: '',
          resourceTypeName: 'named-resource',
          namedResourceName: pp.namedResourceId,
        }],
      )
    }
    const profile = existing
      ? await tx.capacityProfile.update({
          where: { id: existing.id },
          data: {
            resourceTypeId: null,
            namedResourceId: pp.namedResourceId,
            ownerKind: 'PLANNED_RESOURCE',
            planningBasis: 'CAPACITY_PROFILE',
            source: prismaSource,
            defaultPercent: pp.defaultPercent,
            startWeek: pp.startWeek,
            endWeek: pp.endWeek,
          },
        })
      : await tx.capacityProfile.create({
          data: {
            projectId,
            resourceTypeId: null,
            namedResourceId: pp.namedResourceId,
            ownerKind: 'PLANNED_RESOURCE',
            planningBasis: 'CAPACITY_PROFILE',
            source: prismaSource,
            defaultPercent: pp.defaultPercent,
            startWeek: pp.startWeek,
            endWeek: pp.endWeek,
          },
        })
    await tx.capacitySegment.deleteMany({ where: { capacityProfileId: profile.id } })
    if (pp.segments.length > 0) {
      await tx.capacitySegment.createMany({
        data: pp.segments.map(s => ({
          capacityProfileId: profile.id,
          startWeek: s.startWeek,
          endWeek: s.endWeek,
          capacityPercent: s.capacityPercent,
          source: prismaSource,
        })),
      })
      segmentsWritten += pp.segments.length
    }
    plannedResourceProfilesWritten++
  }

  for (const surplusId of surplusResourceIds) {
    const existingList = await tx.capacityProfile.findMany({
      where: { projectId, namedResourceId: surplusId },
      select: { id: true, ownerKind: true, source: true, planningBasis: true },
    })
    if (existingList.length > 1) {
      throw new PlannerConflictError(
        `Duplicate capacity profiles exist for named resource ${surplusId} — ` +
        `repair required before applying.`,
        [{
          resourceTypeId: '',
          resourceTypeName: 'named-resource',
          namedResourceName: surplusId,
        }],
      )
    }
    const existing = existingList[0] ?? null
    if (
      existing &&
      !(
        (existing.ownerKind === 'PLANNED_RESOURCE' && existing.source === 'SQUAD_PLANNER') ||
        (existing.ownerKind === 'NAMED_PERSON'
          && existing.source === 'SQUAD_PLANNER'
          && existing.planningBasis === 'CAPACITY_PROFILE')
      )
    ) {
      throw new PlannerConflictError(
        `Explicit owner profile appeared for named resource ${surplusId} during apply.`,
        [{
          resourceTypeId: '',
          resourceTypeName: 'named-resource',
          namedResourceName: surplusId,
        }],
      )
    }
    const data = {
      resourceTypeId: null,
      namedResourceId: surplusId,
      ownerKind: 'PLANNED_RESOURCE' as const,
      planningBasis: 'CAPACITY_PROFILE' as const,
      source: prismaSource,
      defaultPercent: 0,
      startWeek: null,
      endWeek: null,
    }
    const profile = existing
      ? await tx.capacityProfile.update({ where: { id: existing.id }, data })
      : await tx.capacityProfile.create({ data: { projectId, ...data } })
    await tx.capacitySegment.deleteMany({ where: { capacityProfileId: profile.id } })
    surplusProfilesWritten++
  }

  return {
    roleProfilesWritten,
    plannedResourceProfilesWritten,
    segmentsWritten,
    surplusProfilesWritten,
  }
}

// ─── Async: project compatibility fields from just-written profiles ─────────

/**
 * Project legacy compatibility fields from the just-written ROLE profile
 * onto the ResourceType, and from PLANNED_RESOURCE profiles onto each
 * NamedResource.
 *
 * The projection is lossy for multi-segment profiles. The authoritative
 * profile data remains in CapacityProfile/CapacitySegment.
 */
export async function projectCompatibilityFields(
  tx: PrismaTransactionClient,
  _projectId: string,
  roleProfiles: RoleProfileWriteSet[],
  plannedProfiles: PlannedResourceProfileWriteSet[],
): Promise<void> {
  for (const rp of roleProfiles) {
    const projection = projectCapacityProfileToLegacyAllocation({
      planningBasis: 'capacityProfile',
      source: 'SQUAD_PLANNER',
      defaultPercent: rp.defaultPercent,
      startWeek: rp.startWeek,
      endWeek: rp.endWeek,
      segments: rp.segments,
    })
    if (projection) {
      await tx.resourceType.update({
        where: { id: rp.resourceTypeId },
        data: {
          allocationMode: projection.allocationMode,
          allocationPercent: projection.allocationPercent ?? 0,
          allocationStartWeek: projection.allocationStartWeek,
          allocationEndWeek: projection.allocationEndWeek,
        },
      })
    }
  }

  for (const pp of plannedProfiles) {
    const projection = projectCapacityProfileToLegacyAllocation({
      planningBasis: 'capacityProfile',
      source: 'SQUAD_PLANNER',
      defaultPercent: pp.defaultPercent,
      startWeek: pp.startWeek,
      endWeek: pp.endWeek,
      segments: pp.segments,
    })
    if (projection) {
      await tx.namedResource.update({
        where: { id: pp.namedResourceId },
        data: {
          allocationMode: projection.allocationMode,
          allocationPercent: projection.allocationPercent ?? 0,
          allocationPct: Math.round(projection.allocationPercent ?? 0),
          allocationStartWeek: projection.allocationStartWeek,
          allocationEndWeek: projection.allocationEndWeek,
          startWeek: projection.allocationStartWeek,
          endWeek: projection.allocationEndWeek,
        },
      })
    }
  }
}

// ─── Async: clear compatibility fields for surplus resources ─────────────────

/**
 * Clear legacy compatibility fields on surplus named resources so they
 * do not contribute stale capacity to legacy readers.
 */
export async function clearSurplusCompatibilityFields(
  tx: PrismaTransactionClient,
  surplusResourceIds: string[],
): Promise<void> {
  if (surplusResourceIds.length === 0) return

  await tx.namedResource.updateMany({
    where: { id: { in: surplusResourceIds } },
    data: {
      allocationMode: 'CAPACITY_PLAN',
      allocationPercent: 0,
      allocationPct: 0,
      allocationStartWeek: null,
      allocationEndWeek: null,
      startWeek: null,
      endWeek: null,
    },
  })
}

// ─── Test failure seam ───────────────────────────────────────────────────────

/**
 * Deterministic transaction failure seam for the activated apply path.
 * The squadPlan route invokes it after profile, compatibility, timeline, and
 * weekly-cache writes begin, so integration tests can prove full transaction
 * rollback without changing production behaviour.
 *
 * In production this is always null — no production code path ever sets it.
 * Integration tests set a throwing function to verify atomic rollback.
 *
 * ```ts
 * import { __setApplyFailureSeam } from '../lib/squadPlannerProfileWriter.js'
 * __setApplyFailureSeam(() => { throw new Error('injected') })
 * ```
 */
export let __applyFailureSeam: (() => void) | null = null
/**
 * Override the apply failure seam for testing. Pass null to disable.
 */
export function __setApplyFailureSeam(fn: (() => void) | null): void {
  __applyFailureSeam = fn
}

/**
 * Clear planner-owned role/resource capacity for resource types omitted from
 * the replacement plan while preserving explicit/manual profiles.
 * Uses captured authority data rather than re-querying profiles after mutation.
 */
export async function clearOmittedPlannerCapacity(
  tx: PrismaTransactionClient,
  projectId: string,
  activeResourceTypeIds: Set<string>,
  authority: PriorPlannerAuthority,
): Promise<void> {
  const priorActivePlanResourceTypeIds = authority.activePlanResourceTypeIds
  const omittedResourceTypeIds = [...authority.allPlannerResourceTypeIds]
    .filter(id => !activeResourceTypeIds.has(id))
  const zeroRoleProfiles: RoleProfileWriteSet[] = [...authority.plannerRoleResourceTypeIds]
      .filter(resourceTypeId => !activeResourceTypeIds.has(resourceTypeId))
      .map(resourceTypeId => ({
        resourceTypeId,
        defaultPercent: 0,
        startWeek: null,
        endWeek: null,
        segments: [],
      }))
  const zeroPlannedProfiles: PlannedResourceProfileWriteSet[] = []
  const zeroResourceIds: string[] = []

  for (const resourceTypeId of omittedResourceTypeIds) {
    const ownerConflicts = await validatePlannerOwnerState(tx, projectId, resourceTypeId)
    if (ownerConflicts.length > 0) {
      throw new PlannerConflictError(
        `Protected ROLE profile blocks omitted-role cleanup for resource type "${resourceTypeId}".`,
        ownerConflicts,
      )
    }
    await tx.resourceType.update({
      where: { id: resourceTypeId },
      data: {
        count: 0,
        allocationMode: 'CAPACITY_PLAN',
        allocationPercent: 0,
        allocationStartWeek: null,
        allocationEndWeek: null,
      },
    })
    const namedResources = await tx.namedResource.findMany({
      where: { resourceTypeId },
      select: { id: true, allocationMode: true },
    })
    const nrIds = namedResources.map(nr => nr.id)
    const nrAllProfiles = nrIds.length === 0 ? [] : await tx.capacityProfile.findMany({
      where: { projectId, namedResourceId: { in: nrIds } },
      select: { namedResourceId: true, ownerKind: true, source: true, planningBasis: true },
    })
    const profilesByNrId = new Map<string, typeof nrAllProfiles>()
    for (const profile of nrAllProfiles) {
      if (!profile.namedResourceId) continue
      const list = profilesByNrId.get(profile.namedResourceId) ?? []
      list.push(profile)
      profilesByNrId.set(profile.namedResourceId, list)
    }
    for (const namedResource of namedResources) {
      const profiles = profilesByNrId.get(namedResource.id) ?? []
      if (isPlannerManaged(
        namedResource,
        profiles,
        { priorActivePlan: priorActivePlanResourceTypeIds.has(resourceTypeId) },
      )) {
        zeroPlannedProfiles.push(buildZeroCapacityProfileData(namedResource.id))
        zeroResourceIds.push(namedResource.id)
      }
    }
  }

  await writePlannerProfiles(tx, projectId, zeroRoleProfiles, zeroPlannedProfiles, [])
  await projectCompatibilityFields(tx, projectId, zeroRoleProfiles, zeroPlannedProfiles)
  await clearSurplusCompatibilityFields(tx, zeroResourceIds)
}


// ─── Pure: determine surplus resource IDs ────────────────────────────────────

/**
 * Given the existing ordered named resources and the required trajectory count,
 * return the IDs of resources beyond the trajectory count (surplus).
 */
export function determineSurplusResourceIds(
  orderedNamedResources: Array<{ id: string }>,
  trajectoryCount: number,
): string[] {
  if (trajectoryCount >= orderedNamedResources.length) return []
  return orderedNamedResources.slice(trajectoryCount).map(nr => nr.id)
}

// ─── Shared deterministic planner resource plan ───────────────────────────

export interface PlannerResourcePlan {
  /** Ordered (createdAt, id) planner-managed resources to use for trajectory assignment */
  plannerResources: Array<{ id: string; name: string }>
  /** All ordered planner-managed resources, including surplus rows to zero. */
  allPlannerResources: Array<{ id: string; name: string }>
  /** Resources classified as explicit/protected (never selected by planner) */
  explicitResources: Array<{ id: string; name: string }>
  /** Number of new placeholders still needed beyond available planner resources */
  shortfall: number
  /** Whether duplicate/ambiguous owner state blocks the plan */
  hasConflict: boolean
  /** Conflict details when blocked */
  conflicts: ConflictResourceInfo[]
}

/**
 * Build a deterministic planner resource plan for a single resource type.
 *
 * Shared by conflict preflight, `findOrCreatePlannedResources`, and
 * transaction-time revalidation. The plan is derived from the full set of
 * existing named resources and their profiles, classified by the same
 * `classifyNamedResource` rules.
 *
 * Rules:
 * - Explicit/protected resources are never selected and never treated as a
 *   conflict merely because placeholders are needed (shortfall creates new).
 * - Legacy-adoptable, existing planner-managed, and capacity-plan-untouched
 *   resources are reused.
 * - Duplicate/ambiguous owner state causes a failed-closed conflict.
 * - Returned plannerResources are ordered by (createdAt, id).
 */
export function buildPlannerResourcePlan(
  existingNamedResources: ReadonlyArray<{ id: string; name: string; createdAt: Date; allocationMode: string | null }>,
  existingProfiles: ReadonlyArray<{ namedResourceId: string | null; ownerKind: string; source: string; planningBasis?: string }>,
  resourceTypeId: string,
  resourceTypeName: string,
  requiredCount: number,
  provenance: PlannerProvenance = noPlannerProvenance,
): PlannerResourcePlan {
  const profilesByResource = new Map<string, Array<{
    namedResourceId: string | null
    ownerKind: string
    source: string
    planningBasis?: string
  }>>()
  for (const profile of existingProfiles) {
    if (!profile.namedResourceId) continue
    const list = profilesByResource.get(profile.namedResourceId)
    if (list) {
      list.push(profile)
    } else {
      profilesByResource.set(profile.namedResourceId, [profile])
    }
  }

  const conflicts: ConflictResourceInfo[] = []

  // Check ROLE profile duplicates (profiles without a named resource)
  const roleProfiles = existingProfiles.filter(
    p => !p.namedResourceId && p.ownerKind === 'ROLE'
  )
  if (roleProfiles.length > 1) {
    conflicts.push({
      resourceTypeId,
      resourceTypeName,
      namedResourceName: undefined,
    })
  }

  const plannerResources: Array<{ id: string; name: string }> = []
  const explicitResources: Array<{ id: string; name: string }> = []

  for (const nr of existingNamedResources) {
    const profiles = profilesByResource.get(nr.id) ?? []

    // Check for duplicate profiles on ANY resource (regardless of classification)
    if (profiles.length > 1) {
      conflicts.push({
        resourceTypeId,
        resourceTypeName: 'named-resource',
        namedResourceName: nr.name,
      })
    }
    const kind = classifyNamedResource(nr, profiles, provenance)
    if (kind === 'explicit_person') {
      explicitResources.push({ id: nr.id, name: nr.name })
    } else if (isPlannerManaged(nr, profiles, provenance)) {
      plannerResources.push({ id: nr.id, name: nr.name })
    }
    // 'other' resources are ignored — they aren't planner-managed and not explicit
  }

  const shortfall = Math.max(0, requiredCount - plannerResources.length)

  return {
    plannerResources: plannerResources.slice(0, requiredCount),
    allPlannerResources: plannerResources,
    explicitResources,
    shortfall,
    hasConflict: conflicts.length > 0,
    conflicts,
  }
}

// ─── Transaction-time revalidation ──────────────────────────────────────────

/**
 * Error thrown by `revalidatePlannerPlan` when a conflict is detected
 * inside the transaction, before any mutation. The route catches this
 * to return 409 and clean up the pre-apply snapshot.
 */
export class PlannerConflictError extends Error {
  public readonly conflicts: ConflictResourceInfo[]

  constructor(message: string, conflicts: ConflictResourceInfo[]) {
    super(message)
    this.name = 'PlannerConflictError'
    this.conflicts = conflicts
  }
}

/**
 * Revalidate the planner plan inside the apply transaction, immediately
 * before any deactivate/create/write mutation. Re-reads the current DB
 * state and re-checks all conflict rules using the same shared
 * `buildPlannerResourcePlan` function that preflight and findOrCreate use.
 *
 * Throws `PlannerConflictError` on conflict so the caller can abort
 * before active-plan deactivation and return 409.
 */
export async function revalidatePlannerPlan(
  tx: PrismaTransactionClient,
  projectId: string,
  periods: ReadonlyArray<CapacityPlanPeriodInput>,
  authority?: PriorPlannerAuthority,
  allowLegacyRole?: boolean,

): Promise<void> {
  const resourceTypeIds = [...new Set(periods.flatMap(p => p.entries.map(e => e.resourceTypeId)))]
  const allConflicts: ConflictResourceInfo[] = []
  for (const rtId of resourceTypeIds) {
    allConflicts.push(...await validatePlannerOwnerState(tx, projectId, rtId, allowLegacyRole))
    // Check ROLE profile duplicates (existing profiles query)
    const roleProfiles = await tx.capacityProfile.findMany({
      where: { projectId, resourceTypeId: rtId, ownerKind: 'ROLE' },
      select: { id: true },
    })
    if (roleProfiles.length > 1) {
      allConflicts.push({
        resourceTypeId: rtId,
        resourceTypeName: 'role',
      })
    }

    // Compute trajectory count
    const rtPeriods = periods.map(p => ({
      periodIndex: p.periodIndex,
      startWeek: p.startWeek,
      endWeek: p.endWeek,
      headcount: p.entries.find(e => e.resourceTypeId === rtId)?.headcount ?? 0,
    }))
    const trajectories = materializeResourceTrajectories(rtPeriods)
    const trajectoryCount = trajectories.length

    // Fetch named resources (stable order)
    const namedResources = await tx.namedResource.findMany({
      where: { resourceTypeId: rtId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { id: true, name: true, createdAt: true, allocationMode: true },
    })

    // Fetch profiles for those named resources
    const resourceProfiles = namedResources.length === 0
      ? []
      : await tx.capacityProfile.findMany({
        where: { namedResourceId: { in: namedResources.map(nr => nr.id) } },
        select: { namedResourceId: true, ownerKind: true, source: true, planningBasis: true },
      })
    const plan = buildPlannerResourcePlan(
      namedResources,
      resourceProfiles,
      rtId,
      'role',
      trajectoryCount,
      { priorActivePlan: authority
        ? authority.activePlanResourceTypeIds.has(rtId)
        : await hasPriorActivePlanEvidence(tx, projectId, rtId) },
    )
    allConflicts.push(...plan.conflicts)
  }

  if (allConflicts.length > 0) {
    throw new PlannerConflictError(
      `Plan revalidation failed: ${allConflicts.length} conflict(s) detected. ` +
      `Duplicate owner profiles exist. Repair required before applying.`,
      allConflicts,
    )
  }
}

// ─── Pre-validation conflict test seam ───────────────────────────────────────

/**
 * Deterministic async test seam invoked inside the apply transaction before
 * `revalidatePlannerPlan`. Integration tests can commit a concurrent profile
 * mutation before the transaction reads ownership state.
 *
 * In production this is always null.
 */
export let __preValidationConflictSeam: (() => void | Promise<void>) | null = null

/**
 * Override the pre-validation conflict seam for testing. Pass null to disable.
 */
export function __setPreValidationConflictSeam(fn: (() => void | Promise<void>) | null): void {
  __preValidationConflictSeam = fn
}

/** Invoke the currently configured pre-validation seam. */
export async function runPreValidationConflictSeam(): Promise<void> {
  await __preValidationConflictSeam?.()
}

// ─── Pre-write conflict test seam ────────────────────────────────────────────

/**
 * Deterministic test seam invoked inside the apply transaction after
 * `revalidatePlannerPlan` passes but before any deactivate/create/write
 * mutation. Integration tests can set this to inject a profile mutation
 * between preflight/snapshot and transaction validation.
 *
 * In production this is always null.
 */
export let __preWriteConflictSeam: (() => void) | null = null

/**
 * Override the pre-write conflict seam for testing. Pass null to disable.
 */
export function __setPreWriteConflictSeam(fn: (() => void) | null): void {
  __preWriteConflictSeam = fn
}

/** Invoke the currently configured pre-write seam without relying on mutable
 * ESM binding semantics in route consumers. */
export function runPreWriteConflictSeam(): void {
  __preWriteConflictSeam?.()
}

// ─── Orchestration: apply planner profiles for one resource type ────────────

export interface WriterResourceTypeApplyResult {
  roleProfile: RoleProfileWriteSet
  plannedProfiles: PlannedResourceProfileWriteSet[]
  surplusResources: string[]
}

/**
 * For a single resource type, materialise role and per-resource profiles,
 * ensuring deterministic resource identity.
 *
 * This is a stateless pure-materialisation step (no DB writes).
 */
export function materializeProfilesForResourceType(
  resourceTypeId: string,
  _resourceTypeName: string,
  normalisedPeriods: CapacityPlanPeriodInput[],
  orderedNamedResources: Array<{ id: string; name: string }>,
): WriterResourceTypeApplyResult {
  // Build role profile
  const roleProfile = buildRoleProfileData(resourceTypeId, normalisedPeriods)

  // Build trajectories
  const rtPeriods = normalisedPeriods.map(p => ({
    periodIndex: p.periodIndex,
    startWeek: p.startWeek,
    endWeek: p.endWeek,
    headcount: p.entries.find(e => e.resourceTypeId === resourceTypeId)?.headcount ?? 0,
  }))
  const trajectories = materializeResourceTrajectories(rtPeriods)

  // Build planned-resource profiles from trajectories and ordered named resources
  const plannedProfiles = buildPlannedResourceProfileData(trajectories, orderedNamedResources)

  // Determine surplus resources
  const surplusResources = determineSurplusResourceIds(orderedNamedResources, trajectories.length)

  return {
    roleProfile,
    plannedProfiles,
    surplusResources,
  }
}
