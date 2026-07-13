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

function isPlannerOwnedProfile(
  profile: Pick<PersistedProfileSummary, 'ownerKind' | 'source' | 'planningBasis'>,
  namedResource: Pick<NamedResourceSummary, 'allocationMode'>,
): boolean {
  return (profile.ownerKind === 'PLANNED_RESOURCE' && profile.source === 'SQUAD_PLANNER')
    || isLegacyPlannerProfile(profile, namedResource)
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
      // Should not happen if caller ensures enough resources
      return null as unknown as PlannedResourceProfileWriteSet
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
  }).filter((p): p is PlannedResourceProfileWriteSet => p !== null)
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
    for (const profile of profiles) {
      const namedResource = usedResources.find(r => r.id === namedResourceId) ?? { allocationMode: null }
      if (profile.ownerKind === 'NAMED_PERSON' && !isLegacyPlannerProfile(profile, namedResource)) {
        protectedNamedPersonProfiles.push({
          resourceTypeId: profile.resourceTypeId ?? '',
          resourceTypeName: 'named-person',
          namedResourceName,
        })
      } else if (PROTECTED_PROFILE_SOURCES[profile.source]) {
        protectedNamedPersonProfiles.push({
          resourceTypeId: profile.resourceTypeId ?? '',
          resourceTypeName: 'protected',
          namedResourceName,
        })
      }
    }
  }

  return {
    hasConflict: duplicateOwnerProfiles.length > 0 || protectedNamedPersonProfiles.length > 0,
    duplicateOwnerProfiles,
    protectedNamedPersonProfiles,
  }
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
): Promise<ConflictCheckResult | undefined> {
  const resourceTypeIds = [...new Set(periods.flatMap(p => p.entries.map(e => e.resourceTypeId)))]
  const conflicts: ConflictResourceInfo[] = []
  const protectedNamedPersonProfiles: ConflictResourceInfo[] = []

  for (const rtId of resourceTypeIds) {
    // Fetch existing ROLE profiles for this resource type
    const roleProfiles = (await tx.capacityProfile.findMany({
      where: { projectId, resourceTypeId: rtId, ownerKind: 'ROLE' },
      select: { id: true },
    })) ?? []

    if (roleProfiles.length > 1) {
      conflicts.push({
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
    const namedResources = (await tx.namedResource.findMany({
      where: { resourceTypeId: rtId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { id: true, name: true, allocationMode: true },
    })) ?? []

    const usedResources = namedResources.slice(0, trajectoryCount)
    const usedResourceIds = new Set(usedResources.map(r => r.id))

    if (usedResourceIds.size > 0) {
      const resourceProfiles = (await tx.capacityProfile.findMany({
        where: {
          projectId,
          namedResourceId: { in: [...usedResourceIds] },
        },
        select: { id: true, namedResourceId: true, source: true, ownerKind: true, planningBasis: true },
      })) ?? []
      const profilesByNamedResource = new Map<string, typeof resourceProfiles>()
      for (const profile of resourceProfiles) {
        if (!profile.namedResourceId) continue
        const profiles = profilesByNamedResource.get(profile.namedResourceId) ?? []
        profiles.push(profile)
        profilesByNamedResource.set(profile.namedResourceId, profiles)
      }
      for (const [namedResourceId, profiles] of profilesByNamedResource) {
        const nr = usedResources.find(resource => resource.id === namedResourceId)
        if (profiles.length > 1) {
          conflicts.push({
            resourceTypeId: rtId,
            resourceTypeName: 'named-resource',
            namedResourceName: nr?.name,
          })
        }
        for (const profile of profiles) {
          if (profile.ownerKind === 'NAMED_PERSON' && !isLegacyPlannerProfile(profile, nr ?? { allocationMode: null })) {
            protectedNamedPersonProfiles.push({
              resourceTypeId: rtId,
              resourceTypeName: 'named-person',
              namedResourceName: nr?.name,
            })
          } else if (PROTECTED_PROFILE_SOURCES[profile.source]) {
            protectedNamedPersonProfiles.push({
              resourceTypeId: rtId,
              resourceTypeName: 'protected',
              namedResourceName: nr?.name,
            })
          }
        }
      }
    }
  }

  if (conflicts.length > 0 || protectedNamedPersonProfiles.length > 0) {
    return {
      hasConflict: true,
      duplicateOwnerProfiles: conflicts,
      protectedNamedPersonProfiles,
    }
  }

  return undefined
}

// ─── Async: find or create planner-managed named resources ───────────────────

export interface PlannedResourceMatchResult {
  namedResources: Array<{ id: string; name: string }>
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
  const profilesByResource = new Map<string, typeof existingProfiles>()
  for (const profile of existingProfiles) {
    if (!profile.namedResourceId) continue
    const profiles = profilesByResource.get(profile.namedResourceId) ?? []
    profiles.push(profile)
    profilesByResource.set(profile.namedResourceId, profiles)
  }
  const isPlannerManaged = (nr: { id: string; allocationMode?: string | null }) => {
    const profiles = profilesByResource.get(nr.id) ?? []
    return profiles.some(profile => isPlannerOwnedProfile(profile, nr))
      || (profiles.length === 0 && nr.allocationMode === 'CAPACITY_PLAN')
  }
  const plannerResources = existingNRs.filter(isPlannerManaged)

  const missing = Math.max(0, requiredCount - plannerResources.length)
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

  const allNRs = await tx.namedResource.findMany({
    where: { resourceTypeId },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { id: true, name: true, createdAt: true, allocationMode: true },
  })
  const allProfiles = allNRs.length === 0
    ? []
    : await tx.capacityProfile.findMany({
      where: { namedResourceId: { in: allNRs.map(nr => nr.id) } },
      select: { namedResourceId: true, ownerKind: true, source: true, planningBasis: true },
    })
  const allProfilesByResource = new Map<string, typeof allProfiles>()
  for (const profile of allProfiles) {
    if (!profile.namedResourceId) continue
    const profiles = allProfilesByResource.get(profile.namedResourceId) ?? []
    profiles.push(profile)
    allProfilesByResource.set(profile.namedResourceId, profiles)
  }
  const retained = allNRs.filter(nr => {
    const profiles = allProfilesByResource.get(nr.id) ?? []
    return profiles.some(profile => isPlannerOwnedProfile(profile, nr))
      || (profiles.length === 0 && nr.allocationMode === 'CAPACITY_PLAN')
  })

  return { namedResources: retained, created: missing }
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
): Promise<ProfileWriteResult> {
  let roleProfilesWritten = 0
  let plannedResourceProfilesWritten = 0
  let segmentsWritten = 0
  let surplusProfilesWritten = 0
  const prismaSource = source as CapacityProfileSource

  for (const rp of roleProfiles) {
    const existing = await tx.capacityProfile.findFirst({
      where: { projectId, resourceTypeId: rp.resourceTypeId, ownerKind: 'ROLE' },
      select: { id: true },
    })
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
    const existing = await tx.capacityProfile.findFirst({
      where: { projectId, namedResourceId: pp.namedResourceId },
      select: { id: true },
    })
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
    const existing = await tx.capacityProfile.findFirst({
      where: { projectId, namedResourceId: surplusId },
      select: { id: true },
    })
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
/**
 * Clear planner-owned role/resource capacity for resource types omitted from
 * the replacement plan while preserving explicit/manual profiles.
 */
export async function clearOmittedPlannerCapacity(
  tx: PrismaTransactionClient,
  projectId: string,
  activeResourceTypeIds: Set<string>,
): Promise<void> {
  const roleProfiles = await tx.capacityProfile.findMany({
    where: {
      projectId,
      ownerKind: 'ROLE',
      planningBasis: 'CAPACITY_PROFILE',
      source: 'SQUAD_PLANNER',
    },
    select: { resourceTypeId: true },
  })
  const omittedResourceTypeIds = [...new Set(
    roleProfiles
      .map(profile => profile.resourceTypeId)
      .filter((id): id is string => id !== null && !activeResourceTypeIds.has(id)),
  )]
  if (omittedResourceTypeIds.length === 0) return

  const zeroRoleProfiles: RoleProfileWriteSet[] = omittedResourceTypeIds.map(resourceTypeId => ({
    resourceTypeId,
    defaultPercent: 0,
    startWeek: null,
    endWeek: null,
    segments: [],
  }))
  const zeroPlannedProfiles: PlannedResourceProfileWriteSet[] = []
  const zeroResourceIds: string[] = []

  for (const resourceTypeId of omittedResourceTypeIds) {
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
    for (const namedResource of namedResources) {
      const profile = await tx.capacityProfile.findFirst({
        where: { projectId, namedResourceId: namedResource.id },
        select: { ownerKind: true, source: true, planningBasis: true },
      })
      if (
        (!profile && namedResource.allocationMode === 'CAPACITY_PLAN')
        || (profile && isPlannerOwnedProfile(profile, namedResource))
      ) {
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
