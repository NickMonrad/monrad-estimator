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
 *   - Exactly one canonical ROLE profile (DEMAND_FOLLOWING, 100% As needed,
 *     MANUAL source) is created per eligible role via the existing
 *     authoritative writer (`replaceCapacityProfile`), never overwriting an
 *     existing profile and never guessing planner-owned or named-resource
 *     authority.
 *   - The batch is atomic: any failure (including a concurrent duplicate
 *     create hitting the partial unique index) rolls back every write.
 *   - The project stays NEEDS_REPLAN; the response reports the remaining
 *     canonical completeness findings so the user can resolve non-eligible
 *     findings manually before running the existing completion operation.
 */

import type { Prisma, PrismaClient } from '@prisma/client'

import { replaceCapacityProfile } from './capacityProfileReplaceService.js'
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

/**
 * Persist a canonical demand-following (As needed) ROLE profile for every
 * eligible missing role-only ResourceType in one atomic transaction.
 *
 * @param prisma    Prisma client
 * @param projectId Project ID
 * @param userId    Requesting user (ownership revalidated inside the tx)
 * @returns         Created count + remaining completeness findings
 * @throws BulkAsNeededError with a stable `code` on guard violations
 */
export async function applyRoleCountsAsNeeded(
  prisma: PrismaClient,
  projectId: string,
  userId: string,
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

    let created = 0
    for (const roleId of eligibleRoleIds) {
      // The authoritative single-owner writer: validates ownership, refuses
      // PLANNED_RESOURCE/SQUAD_PLANNER overwrite, creates the canonical
      // MANUAL-source DEMAND_FOLLOWING profile, clears behavioural
      // provenance and invalidates the weekly-demand cache. A concurrent
      // duplicate create fails on the partial unique index and aborts the
      // whole batch atomically.
      await replaceCapacityProfile(
        tx,
        projectId,
        'ROLE',
        roleId,
        { planningBasis: 'DEMAND_FOLLOWING', defaultPercent: 100 },
        userId,
      )
      created++
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
