/**
 * bulkAsNeededProfiles.ts — Explicit bulk "Use role counts as As needed"
 * action for a NEEDS_REPLAN project (issue #456).
 *
 * After Reset Planning (issue #449) a project can contain many preserved
 * role-only ResourceTypes with no persisted ROLE CapacityProfile. Creating
 * each profile through the single-owner editor is impractical at that scale,
 * so this service persists the canonical demand-following (As needed) ROLE
 * profile for every eligible missing role in ONE atomic batch.
 *
 * Contract:
 *   - Only a NEEDS_REPLAN project may use this action; the state is
 *     re-checked inside the transaction so a concurrent completion cannot
 *     race the writes.
 *   - Eligible owners are role-only ResourceTypes (zero named resources —
 *     so there is no named-person, planned-resource or segmented authority
 *     to conflict with) that lack a persisted ROLE profile.
 *   - The bulk write is strictly CREATE-ONLY (issue #456 review): it never
 *     updates or replaces an existing profile. The general-purpose editor
 *     writer (`replaceCapacityProfile`) is deliberately NOT reused because
 *     it is a create-or-replace writer — a ROLE profile created by another
 *     request after the bulk eligibility read could otherwise be
 *     overwritten. Instead each role is re-checked inside the transaction
 *     immediately before its insert, and a concurrent duplicate insert is
 *     detected through the partial unique index on `resourceTypeId`
 *     (P2002) and treated as "already exists → skip". A concurrently
 *     created profile therefore always survives completely unchanged.
 *   - The batch is atomic: an unexpected failure rolls back every write;
 *     the project stays NEEDS_REPLAN; the response reports the remaining
 *     canonical completeness findings so the user can resolve non-eligible
 *     findings manually before running the existing completion operation.
 */

import { Prisma, type PrismaClient } from '@prisma/client'

import { validateProfileStructure } from './capacityProfileStructureValidation.js'
import { collectReplanningFindings } from './completeReplanning.js'

export class BulkAsNeededError extends Error {
  readonly code: string
  readonly status: number

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'BulkAsNeededError'
    this.status = status
    this.code = code
  }
}

export interface BulkAsNeededResult {
  projectId: string
  /** The action never transitions planning state — completion owns that. */
  planningState: 'NEEDS_REPLAN'
  /** Number of canonical ROLE profiles created by this call. */
  created: number
  /** Remaining canonical completeness findings (human-readable names). */
  remainingFindings: string[]
}

/** Optional test seams (mirrors the reset service's `afterWrites` hook). */
export interface BulkAsNeededHooks {
  /** Invoked after each successful profile create (roleId = role just created). */
  afterCreate?: (roleId: string, created: number) => Promise<void> | void
}

/**
 * Whether a Prisma P2002 error is the partial-unique-index violation on
 * CapacityProfile.resourceTypeId (a concurrent ROLE profile insert for the
 * same resource type). Same constraint-identity detection as the Squad
 * Planner apply path; unrelated P2002 errors propagate.
 */
function isRoleProfileAlreadyExistsConflict(err: unknown): boolean {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError)) return false
  if (err.code !== 'P2002') return false
  const meta = err.meta as Record<string, unknown> | null | undefined
  if (!meta) return false
  if (meta.modelName !== 'CapacityProfile') return false
  // With adapter-pg (Prisma 7) the constraint name is in
  // driverAdapterError.cause.originalMessage.
  const adapterErr = meta.driverAdapterError as Record<string, unknown> | undefined
  const cause = adapterErr?.cause as Record<string, unknown> | undefined
  if (cause && typeof cause.originalMessage === 'string') {
    return cause.originalMessage.includes('CapacityProfile_resourceTypeId_key')
  }
  return false
}

/**
 * Create the canonical As-needed ROLE profile for one role, guaranteeing the
 * profile is CREATE-ONLY: the role is re-checked immediately before the
 * insert, and a concurrent insert that wins the unique-index race is treated
 * as "already exists" (skip, never update).
 *
 * @returns true when a profile was created, false when one already exists.
 */
async function createMissingRoleAsNeededProfile(
  tx: Prisma.TransactionClient,
  projectId: string,
  roleId: string,
  resourceTypeIds: ReadonlySet<string>,
): Promise<boolean> {
  // Re-check inside the transaction: a profile created after the initial
  // eligibility read (e.g. by a concurrent editor save) must never be
  // updated or replaced by this bulk action.
  const existing = await tx.capacityProfile.findFirst({
    where: { projectId, resourceTypeId: roleId, ownerKind: 'ROLE' },
    select: { id: true },
  })
  if (existing) return false

  // Canonical "As needed / demand-following" ROLE profile — the same shape
  // the single-owner editor would persist for this choice. Run it through
  // the single authoritative structural rule set before writing.
  const structuralErrors = validateProfileStructure(
    {
      id: 'pending-create',
      projectId,
      resourceTypeId: roleId,
      namedResourceId: null,
      ownerKind: 'ROLE',
      planningBasis: 'DEMAND_FOLLOWING',
      source: 'MANUAL',
      defaultPercent: 100,
      startWeek: null,
      endWeek: null,
      segments: [],
    },
    {
      projectId,
      resourceTypeIds,
      namedResourceIds: new Set<string>(),
    },
  )
  if (structuralErrors.length > 0) {
    throw new Error(
      `Refusing to create a non-canonical As-needed profile for role ${roleId}: ` +
        structuralErrors.join('; '),
    )
  }

  try {
    await tx.capacityProfile.create({
      data: {
        projectId,
        ownerKind: 'ROLE',
        resourceTypeId: roleId,
        namedResourceId: null,
        planningBasis: 'DEMAND_FOLLOWING',
        source: 'MANUAL',
        defaultPercent: 100,
        startWeek: null,
        endWeek: null,
        provenance: null,
      },
    })
    return true
  } catch (error) {
    // A concurrent ROLE profile insert committed between the re-check and
    // this insert → the unique index refused the duplicate. The concurrent
    // profile is authoritative and untouched; skip this role.
    if (isRoleProfileAlreadyExistsConflict(error)) return false
    throw error
  }
}

/**
 * Persist a canonical demand-following (As needed) ROLE profile for every
 * eligible missing role-only ResourceType in one atomic transaction.
 *
 * @param prisma    Prisma client
 * @param projectId Project ID
 * @param userId    Requesting user (ownership revalidated inside the tx)
 * @param hooks     Optional test seams
 * @returns         Created count + remaining completeness findings
 * @throws BulkAsNeededError with a stable `code` on guard violations
 */
export async function applyRoleCountsAsNeeded(
  prisma: PrismaClient,
  projectId: string,
  userId: string,
  hooks: BulkAsNeededHooks = {},
): Promise<BulkAsNeededResult> {
  return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const project = await tx.project.findFirst({
      where: { id: projectId, ownerId: userId },
      select: {
        id: true,
        planningState: true,
        resourceTypes: {
          select: {
            id: true,
            namedResources: { select: { id: true } },
          },
        },
        capacityProfiles: {
          select: {
            resourceTypeId: true,
            namedResourceId: true,
            ownerKind: true,
            source: true,
          },
        },
      },
    })

    if (!project) {
      throw new BulkAsNeededError(404, 'PROJECT_NOT_FOUND', 'Project not found or access denied')
    }
    if (project.planningState !== 'NEEDS_REPLAN') {
      throw new BulkAsNeededError(
        409,
        'REPLAN_ACTION_UNAVAILABLE',
        'This action is only available while the project needs replanning. ' +
          'Complete or reset the plan before retrying.',
      )
    }

    // Role-only resource types that already carry a persisted ROLE profile
    // are not missing — they are skipped (never overwritten).
    const persistedRoleRtIds = new Set<string>()
    for (const profile of project.capacityProfiles) {
      if (profile.ownerKind === 'ROLE' && profile.resourceTypeId) {
        persistedRoleRtIds.add(profile.resourceTypeId)
      }
    }

    // Eligible: role-only ResourceTypes (zero named resources → no
    // named-person/planned-resource/segmented authority to guess or replace)
    // with no persisted ROLE profile. Roles with named resources, planner-owned
    // profiles or existing profiles stay visible as remaining findings.
    const eligibleRoleIds = project.resourceTypes
      .filter(rt => rt.namedResources.length === 0 && !persistedRoleRtIds.has(rt.id))
      .map(rt => rt.id)
    const resourceTypeIds = new Set(project.resourceTypes.map(rt => rt.id))

    let created = 0
    for (const roleId of eligibleRoleIds) {
      // Strictly create-only: the role is re-checked inside the transaction
      // and a concurrent duplicate insert (P2002 on the resourceTypeId
      // unique index) is treated as "already exists → skip" — an existing
      // profile, including one that appeared after the eligibility read, is
      // never updated or replaced by this bulk action.
      const didCreate = await createMissingRoleAsNeededProfile(tx, projectId, roleId, resourceTypeIds)
      if (didCreate) {
        created++
        await hooks.afterCreate?.(roleId, created)
      }
    }

    if (created > 0) {
      // Invalidate the derived weekly-demand cache for the created profiles
      // (same invalidation the single-owner writer performs).
      await tx.project.update({
        where: { id: projectId },
        data: { weeklyDemandCache: {} },
      })
    }

    // Reuse the authoritative completion validation for the remaining
    // findings — same semantics the Replan project completion will enforce.
    const remainingFindings = await collectReplanningFindings(tx, projectId)

    return {
      projectId,
      planningState: 'NEEDS_REPLAN' as const,
      created,
      remainingFindings,
    }
  })
}
