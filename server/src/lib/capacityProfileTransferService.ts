/**
 * capacityProfileTransferService.ts — Atomic ownership transfer from
 * Squad Planner to manual capacity management.
 *
 * ## Strict validation
 *
 * Before any write, every owner (ROLE and each NamedResource) is loaded
 * and strictly validated via `loadAndValidateOwnerProfile`. This checks
 * project FK shape, owner kind, planning basis, source, percentages,
 * windows, segment structure, segment sources, duplicates, and overlaps.
 *
 * Validation of ALL owners completes before the first write.
 *
 * ## Post-transfer capacity-authority rule
 *
 * After transfer, the ROLE profile (source=MANUAL, planningBasis=CAPACITY_PROFILE)
 * is the role-level scheduling authority. Its subordinate PLANNED_RESOURCE
 * profiles retain their identities and transferred segment data but must
 * not independently contribute capacity while the manual ROLE profile is
 * authoritative. See schedulerCapacityResolver.ts for the enforcement rule.
 *
 * ## Preservation guarantees
 *
 * - ROLE profile: source → MANUAL, segments preserved.
 * - PLANNED_RESOURCE profiles: source → MANUAL, ALL segment IDs, boundaries,
 *   percentages, and ordering preserved (canonical zero-capacity profiles
 *   with zero segments remain valid zero-segment MANUAL state).
 * - All profile IDs, resource IDs, owner kinds preserved.
 * - Protected NAMED_PERSON profiles untouched.
 *
 * @module
 */

import { projectCapacityProfileToLegacyAllocation } from './capacityProfileLegacyProjection.js'
import { validatePlannerOwnerState, capturePlannerAuthority, classifyNamedResource, plannerProvenanceFrom } from './squadPlannerProfileWriter.js'
import { loadAndValidateOwnerProfile } from './ownerProfileLoader.js'
import type { PrismaClient } from '@prisma/client'

/** Test-only failure seam — fires after all writes but before transaction commit. */
export let __transferFailureSeam: (() => void) | null = null
export function __setTransferFailureSeam(fn: (() => void) | null): void {
  __transferFailureSeam = fn
}

/** Inferred Prisma transaction client type. */
type TxClient = Parameters<Parameters<PrismaClient['$transaction']>[0]>[0]

export interface TransferResult {
  profilesTransferred: number
  plannedResourceProfilesTransferred: number
  roleProfileTransferred: boolean
  protectedProfileIds: string[]
}

export class TransferError extends Error {
  public readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = 'TransferError'
    this.status = status
  }
}

function asTransferError(err: unknown): TransferError {
  if (err instanceof TransferError) return err
  const message = err instanceof Error ? err.message : 'Transfer failed'
  return new TransferError(409, message)
}

/**
 * Transfer a Squad Planner-managed role to manual capacity ownership.
 * Atomic — completes entirely or rolls back completely.
 *
 * Pre-validation (before writes):
 * 1. Project ownership + resource type verification
 * 2. loadAndValidateOwnerProfile for the ROLE owner
 * 3. loadAndValidateOwnerProfile for EVERY named-resource owner
 * 4. validatePlannerOwnerState as additional planner-specific preflight
 *
 * Transfer (atomic):
 * 1. Update ROLE profile source → MANUAL, update segment sources → MANUAL
 * 2. Update each planner-created profile source → MANUAL, update segment sources → MANUAL
 * 3. Update legacy compatibility projections
 * 4. Write legacy metadata
 * 5. Invalidate weekly demand cache
 */
export async function transferToManualCapacity(
  tx: TxClient,
  projectId: string,
  resourceTypeId: string,
  userId: string,
): Promise<TransferResult> {
  // ── 0. Verify project ownership ──────────────────────────────────────
  const project = await tx.project.findFirst({
    where: { id: projectId, ownerId: userId },
    select: { id: true },
  })
  if (!project) {
    throw new TransferError(404, 'Project not found or access denied')
  }

  // ── 1. Verify resource type belongs to project ────────────────────────
  const resourceType = await tx.resourceType.findFirst({
    where: { id: resourceTypeId, projectId },
    select: { id: true, name: true },
  })
  if (!resourceType) {
    throw new TransferError(404, `Resource type "${resourceTypeId}" not found in project`)
  }

  // ── 2. Load all profiles and named resources for this role ────────────
  const namedResources = await tx.namedResource.findMany({
    where: { resourceTypeId },
    select: { id: true, name: true, allocationMode: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  })
  const namedResourceIds = namedResources.map(nr => nr.id)

  const allProfiles = await tx.capacityProfile.findMany({
    where: {
      projectId,
      OR: [
        { resourceTypeId },
        ...(namedResourceIds.length > 0
          ? [{ namedResourceId: { in: namedResourceIds } }]
          : []),
      ],
    },
    include: {
      segments: {
        orderBy: [{ startWeek: 'asc' }, { endWeek: 'asc' }],
      },
    },
    orderBy: [{ ownerKind: 'asc' }, { id: 'asc' }],
  })

  if (allProfiles.length === 0) {
    throw new TransferError(409, `No capacity profiles found for resource type "${resourceType.name}"`)
  }

  // ── 3. STRICT PRE-VALIDATION — loadAndValidateOwnerProfile for EVERY owner ──
  // 3a. Find the ROLE profile
  const roleProfiles = allProfiles.filter(
    p => p.resourceTypeId === resourceTypeId && p.namedResourceId === null && p.ownerKind === 'ROLE',
  )
  if (roleProfiles.length === 0) {
    throw new TransferError(409, `No role-level capacity profile found for resource type "${resourceType.name}"`)
  }
  if (roleProfiles.length > 1) {
    throw new TransferError(409, `Multiple role-level capacity profiles exist for resource type "${resourceType.name}" — repair required before transfer`)
  }
  const roleProfile = roleProfiles[0]

  // 3b. Strict validate the ROLE profile
  try {
    await loadAndValidateOwnerProfile({ tx, projectId, ownerKind: 'ROLE', ownerId: resourceTypeId })
  } catch (err) {
    throw asTransferError(err)
  }

  // 3c. The ROLE profile must be Squad Planner-owned
  if (roleProfile.source !== 'SQUAD_PLANNER') {
    throw new TransferError(
      409,
      `Role "${resourceType.name}" is not managed by Squad Planner. Current source: ${String(roleProfile.source)}. Only Squad Planner-managed roles can be transferred.`,
    )
  }

  // 3d. Detect unprofiled planner-managed NamedResources via active-plan provenance
  // Capture planner authority to detect resources kept under planner fallback.
  const plannerAuthority = await capturePlannerAuthority(tx, projectId)

  for (const nr of namedResources) {
    const nrProfiles = allProfiles.filter(p => p.namedResourceId === nr.id)

    if (nrProfiles.length === 0) {
      // No profile at all — check via planner provenance
      const provenance = plannerProvenanceFrom(plannerAuthority, resourceTypeId)
      const kind = classifyNamedResource(
        { id: nr.id, allocationMode: nr.allocationMode ?? null },
        [],
        provenance,
      )
      if (kind === 'planner_managed' || kind === 'legacy_adoptable' || kind === 'capacity_plan_untouched') {
        throw new TransferError(
          409,
          `Named resource "${nr.name}" is planner-managed without a persisted profile. ` +
          'Apply Squad Planner to create profiles for all resources before transferring.',
        )
      }
    }
  }

  // 3e. Strict validate every NamedResource that has a profile
  const resourceProfiles = allProfiles.filter(
    p => p.namedResourceId !== null && namedResourceIds.includes(p.namedResourceId!),
  )
  const protectedProfileIds: string[] = []
  const plannerProfiles: typeof resourceProfiles = []
  const seenNamedResourceIds = new Set<string>()

  for (const profile of resourceProfiles) {
    if (!profile.namedResourceId) {
      protectedProfileIds.push(profile.id)
      continue
    }

    // Reject duplicate named-resource owners
    if (seenNamedResourceIds.has(profile.namedResourceId)) {
      throw new TransferError(
        409,
        `Duplicate capacity profile for named resource "${profile.namedResourceId}" — repair required before transfer`,
      )
    }
    seenNamedResourceIds.add(profile.namedResourceId)

    const expectedOwnerKind = profile.ownerKind as 'NAMED_PERSON' | 'PLANNED_RESOURCE'
    if (expectedOwnerKind !== 'NAMED_PERSON' && expectedOwnerKind !== 'PLANNED_RESOURCE') {
      throw new TransferError(409, `Profile ${profile.id} has invalid ownerKind "${String(profile.ownerKind)}"`)
    }

    // Strict validate via the owner-profile loader
    try {
      await loadAndValidateOwnerProfile({ tx, projectId, ownerKind: expectedOwnerKind, ownerId: profile.namedResourceId })
    } catch (err) {
      throw asTransferError(err)
    }

    const classification = classifyTransferProfile(profile)
    if (classification === 'planner_created' || classification === 'legacy_planner') {
      plannerProfiles.push(profile)
    } else {
      protectedProfileIds.push(profile.id)
    }
  }

  // 3e. Planner-specific ownership conflict preflight
  const ownershipConflicts = await validatePlannerOwnerState(tx, projectId, resourceTypeId)
  if (ownershipConflicts.length > 0) {
    const detail = ownershipConflicts
      .map(c => c.namedResourceName ? `"${c.namedResourceName}"` : c.resourceTypeName)
      .join(', ')
    throw new TransferError(
      409,
      `Invalid planner ownership for resource type "${resourceType.name}": ${detail}. Repair required before transfer.`,
    )
  }

  // ── All pre-validation complete. Writes below are inside the transaction. ──

  // ── 4. Transfer ROLE profile and its segments ─────────────────────────
  await tx.capacityProfile.update({
    where: { id: roleProfile.id },
    data: { source: 'MANUAL' },
  })
  if (roleProfile.segments && roleProfile.segments.length > 0) {
    const segmentIds = roleProfile.segments.map(s => s.id)
    await tx.capacitySegment.updateMany({
      where: { id: { in: segmentIds } },
      data: { source: 'MANUAL' },
    })
  }

  // ── 5. Transfer planner-created resource profiles and their segments ──
  for (const profile of plannerProfiles) {
    await tx.capacityProfile.update({
      where: { id: profile.id },
      data: { source: 'MANUAL' },
    })
    if (profile.segments && profile.segments.length > 0) {
      const segmentIds = profile.segments.map(s => s.id)
      await tx.capacitySegment.updateMany({
        where: { id: { in: segmentIds } },
        data: { source: 'MANUAL' },
      })
    }
  }

  // ── 6. Update legacy compatibility projections ───────────────────────
  const roleSegments = roleProfile.segments ?? []
  const roleProjection = projectCapacityProfileToLegacyAllocation({
    planningBasis: 'capacityProfile',
    source: 'manual',
    defaultPercent: roleProfile.defaultPercent,
    startWeek: roleProfile.startWeek,
    endWeek: roleProfile.endWeek,
    segments: roleSegments.map(s => ({
      startWeek: s.startWeek, endWeek: s.endWeek, capacityPercent: s.capacityPercent,
    })),
  })
  if (roleProjection) {
    await tx.resourceType.update({
      where: { id: resourceTypeId },
      data: {
        allocationMode: roleProjection.allocationMode,
        allocationPercent: roleProjection.allocationPercent ?? 0,
        allocationStartWeek: roleProjection.allocationStartWeek,
        allocationEndWeek: roleProjection.allocationEndWeek,
      },
    })
  }

  for (const profile of plannerProfiles) {
    if (!profile.namedResourceId) continue

    // Transferred planned resources project to zero legacy capacity on the
    // NamedResource compatibility fields. The profile's own defaultPercent
    // and segments are preserved (they retain identity and segment shape).
    // The scheduler authority rule suppresses independent capacity contribution
    // from these profiles, so the manual ROLE profile is the sole authority.
    await tx.namedResource.update({
      where: { id: profile.namedResourceId },
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

  // ── 7. Update legacy metadata on transferred profiles ────────────────
  await writeTransferLegacyMetadata(tx, roleProfile, roleProjection, roleSegments)
  for (const profile of plannerProfiles) {
    if (!profile.namedResourceId) continue
    const segs = profile.segments ?? []
    const proj = projectCapacityProfileToLegacyAllocation({
      planningBasis: 'capacityProfile',
      source: 'manual',
      defaultPercent: profile.defaultPercent,
      startWeek: profile.startWeek,
      endWeek: profile.endWeek,
      segments: segs.map(s => ({
        startWeek: s.startWeek, endWeek: s.endWeek, capacityPercent: s.capacityPercent,
      })),
    })
    if (proj) await writeTransferLegacyMetadata(tx, profile, proj, segs)
  }

  // ── 8. Invalidate weekly demand cache ────────────────────────────────
  await tx.project.update({
    where: { id: projectId },
    data: { weeklyDemandCache: {} },
  })

  // Test-only failure seam (fires after all writes, before commit)
  if (__transferFailureSeam) {
    __transferFailureSeam()
  }

  return {
    profilesTransferred: 1 + plannerProfiles.length,
    plannedResourceProfilesTransferred: plannerProfiles.filter(p => p.ownerKind === 'PLANNED_RESOURCE').length,
    roleProfileTransferred: true,
    protectedProfileIds,
  }
}

// ─── Classification helper ──────────────────────────────────────────────────

type ProfileClassification = 'planner_created' | 'legacy_planner' | 'protected'

function classifyTransferProfile(profile: {
  ownerKind: string; source: string; planningBasis: string
  namedResourceId: string | null; resourceTypeId: string | null
}): ProfileClassification {
  if (!profile.namedResourceId) return 'protected'
  if (
    profile.ownerKind === 'PLANNED_RESOURCE'
    && profile.source === 'SQUAD_PLANNER'
    && profile.planningBasis === 'CAPACITY_PROFILE'
    && profile.resourceTypeId === null
  ) return 'planner_created'
  if (
    profile.ownerKind === 'NAMED_PERSON'
    && profile.source === 'SQUAD_PLANNER'
    && profile.planningBasis === 'CAPACITY_PROFILE'
    && profile.resourceTypeId === null
  ) return 'legacy_planner'
  return 'protected'
}

// ─── Legacy metadata writer ─────────────────────────────────────────────────

async function writeTransferLegacyMetadata(
  tx: TxClient,
  profile: { id: string; defaultPercent?: number | null; startWeek?: number | null; endWeek?: number | null },
  projection: { allocationMode: string; allocationPercent: number | null; allocationStartWeek: number | null; allocationEndWeek: number | null; lossy: boolean; lossReason?: string } | null,
  _segments: Array<{ startWeek: number; endWeek: number; capacityPercent: number }>,
): Promise<void> {
  await tx.capacityProfile.update({
    where: { id: profile.id },
    data: {
      legacy: {
        version: 1,
        writer: 'transfer-to-manual',
        allocationMode: projection?.allocationMode ?? 'CAPACITY_PLAN',
        allocationPercent: projection?.allocationPercent ?? profile.defaultPercent ?? 100,
        allocationStartWeek: projection?.allocationStartWeek ?? profile.startWeek,
        allocationEndWeek: projection?.allocationEndWeek ?? profile.endWeek,
        lossy: projection?.lossy ?? false,
        lossReason: projection?.lossReason ?? null,
      } satisfies Record<string, unknown> as any,
    },
  })
}
