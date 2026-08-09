/**
 * resetProjectPlanning.ts — Atomic Reset Planning service (issue #449).
 *
 * One focused server-side operation that discards planning-owned state and
 * marks the project NEEDS_REPLAN, preserving estimation/business inputs.
 *
 * ── Reset allow-list (planning-owned state cleared) ─────────────────────────
 * Based on repository domain ownership (docs/domain/planning-resource-commercial-boundaries.md,
 * capacity-profile-design.md) and the issue #449 boundary:
 *
 *   - CapacityProfile / CapacitySegment rows             (planning state being reset)
 *   - CapacityPlan / CapacityPlanPeriod / CapacityPlanEntry rows (planning inputs/outputs)
 *   - TimelineEntry / StoryTimelineEntry rows            (generated feature/story schedule
 *                                                        output; Timeline/Planning owns manual
 *                                                        overrides as planning state too)
 *   - weeklyDemandCache                                  (derived planning cache)
 *   - NamedResource rows proven to be planner-generated placeholders:
 *     provenance = an existing CapacityProfile with ownerKind PLANNED_RESOURCE.
 *     Squad Planner's findOrCreatePlannedResources creates those rows and marks
 *     them with a PLANNED_RESOURCE profile; user-authored named resources
 *     always carry NAMED_PERSON profiles. Ambiguous rows are preserved.
 *   - project.planningState → NEEDS_REPLAN
 *
 * ── Preserved (never touched) ───────────────────────────────────────────────
 *   Project identity/metadata (incl. hoursPerDay, onboarding/buffer weeks,
 *   startDate, tax settings), org/customer links, backlog hierarchy, task
 *   effort/duration/resource-type assignment, dependencies, ResourceType
 *   identity/count/hoursPerDay/dayRate/global-type links, user-authored
 *   NamedResource identity + pricingModel, ProjectDiscount, ProjectOverhead,
 *   BacklogSnapshots, generated documents. The candidate legacy capacity
 *   columns on ResourceType/NamedResource are NOT removed or rewritten here
 *   (issue #418 PR 2 owns those columns); runtime readers are made
 *   NEEDS_REPLAN-aware so stale legacy values are never projected as capacity.
 *
 * The whole operation runs in one Prisma transaction: any failure rolls back
 * every write and leaves the previous planning state intact.
 *
 * The optional `afterWrites` hook runs inside the transaction after all
 * writes and before commit; it exists solely so tests can inject a
 * mid-transaction failure and prove full rollback.
 */

import { Prisma, type PrismaClient } from '@prisma/client'

export interface ResetPlanningOptions {
  /**
   * Test-only seam: invoked inside the transaction after every reset write.
   * Throwing from it rolls the whole reset back.
   */
  afterWrites?: (tx: Prisma.TransactionClient) => Promise<void>
}

export class ResetPlanningError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = 'ResetPlanningError'
    this.status = status
  }
}

export interface ResetPlanningResult {
  projectId: string
  planningState: 'NEEDS_REPLAN'
}

/**
 * Reset a project's planning state atomically.
 *
 * @param db Prisma client or an already-open transaction client.
 * @param projectId Project whose planning state is discarded.
 * @param options Optional test seam (afterWrites).
 */
export async function resetProjectPlanning(
  db: PrismaClient | Prisma.TransactionClient,
  projectId: string,
  options: ResetPlanningOptions = {},
): Promise<ResetPlanningResult> {
  return db.$transaction(async tx => {
    const result = await resetProjectPlanningWithinTransaction(tx, projectId)
    if (options.afterWrites) {
      await options.afterWrites(tx)
    }
    return result
  })
}

/**
 * The reset transaction body, executed against an already-open transaction
 * client. Shared by the product-facing single-project wrapper above and the
 * maintenance classification batch, which runs the whole reviewed manifest
 * set inside ONE transaction (issue #449 remediation).
 *
 * No writes are committed by this helper itself; the caller's transaction
 * decides commit/rollback.
 */
export async function resetProjectPlanningWithinTransaction(
  tx: Prisma.TransactionClient,
  projectId: string,
): Promise<ResetPlanningResult> {
  const project = await tx.project.findUnique({
    where: { id: projectId },
    select: { id: true, planningState: true },
  })
  if (!project) {
    throw new ResetPlanningError(404, 'Project not found')
  }

  // Proven planner-generated placeholders: NamedResources that carry a
  // PLANNED_RESOURCE profile (the provenance mark written by the Squad
  // Planner apply path). User-authored resources always get NAMED_PERSON
  // profiles, so they are never matched here.
  const plannerProfiles = await tx.capacityProfile.findMany({
    where: { projectId, ownerKind: 'PLANNED_RESOURCE' },
    select: { namedResourceId: true },
  })
  const plannerNamedResourceIds = Array.from(
    new Set(plannerProfiles.map(p => p.namedResourceId).filter((id): id is string => id != null)),
  )

  // Planning-owned state (see module doc for the evidence-based allow-list).
  await tx.capacityProfile.deleteMany({ where: { projectId } }) // cascades segments
  await tx.capacityPlan.deleteMany({ where: { projectId } }) // cascades periods/entries
  await tx.timelineEntry.deleteMany({ where: { projectId } })
  await tx.storyTimelineEntry.deleteMany({ where: { projectId } })
  if (plannerNamedResourceIds.length > 0) {
    await tx.namedResource.deleteMany({
      where: { id: { in: plannerNamedResourceIds }, resourceType: { projectId } },
    })
  }
  await tx.project.update({
    where: { id: projectId },
    data: {
      weeklyDemandCache: Prisma.DbNull,
      planningState: 'NEEDS_REPLAN',
    },
  })

  return { projectId, planningState: 'NEEDS_REPLAN' as const }
}
