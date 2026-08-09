/**
 * completeReplanning.ts — Completion validation for the Reset Planning /
 * Replan project workflow (issue #449).
 *
 * NEEDS_REPLAN returns to CURRENT only when the project's persisted planning
 * state is canonical and valid. This module reuses the existing authoritative
 * validation (validatePersistedCapacityProfiles + checkPersistedCompleteness —
 * the same rules the readiness check and GET /capacity-profiles enforce) so no
 * second integrity implementation is introduced.
 *
 * The completion itself is atomic: the validation runs inside the same
 * transaction that flips the state, so the project can never become CURRENT
 * with incomplete planning state, and a concurrent mutation cannot slip in
 * between validation and the state change.
 */

import type { Prisma, PrismaClient } from '@prisma/client'

import {
  validatePersistedCapacityProfiles,
  checkPersistedCompleteness,
} from './persistedCapacityProfileValidation.js'

export class ReplanIncompleteError extends Error {
  /** Stable machine-readable code for client-side handling. */
  readonly code: string = 'REPLAN_INCOMPLETE'
  /** HTTP status code — 422 Unprocessable (actionable validation findings). */
  readonly status: number = 422
  /** Actionable validation findings. */
  readonly findings: string[]

  constructor(findings: string[]) {
    super(
      'Replanning is incomplete: ' +
        findings.join('; ') +
        ' Review the resource inputs in Resource Profile and complete the plan before finishing replanning.',
    )
    this.name = 'ReplanIncompleteError'
    this.findings = findings
  }
}

/**
 * Validate that a project's persisted planning state is canonical.
 *
 * Mirrors the per-project readiness section: structural profile rules plus
 * per-owner completeness (every role covered by a ROLE profile unless all of
 * its named resources carry explicit NAMED_PERSON profiles; every named
 * resource has exactly one valid profile).
 *
 * @returns Empty array when the project is valid, otherwise actionable findings.
 */
export async function collectReplanningFindings(
  db: PrismaClient | Prisma.TransactionClient,
  projectId: string,
): Promise<string[]> {
  const project = await db.project.findUnique({
    where: { id: projectId },
    select: {
      id: true,
      resourceTypes: {
        include: { namedResources: { orderBy: { createdAt: 'asc' as const } } },
      },
      capacityProfiles: {
        include: {
          segments: {
            orderBy: [{ startWeek: 'asc' as const }, { endWeek: 'asc' as const }],
          },
        },
      },
    },
  })
  if (!project) return ['Project not found']

  const resourceTypeIds = new Set(project.resourceTypes.map(rt => rt.id))
  const namedResourceIds = new Set(
    project.resourceTypes.flatMap(rt => rt.namedResources.map(nr => nr.id)),
  )

  const validation = validatePersistedCapacityProfiles(
    project.capacityProfiles as Parameters<typeof validatePersistedCapacityProfiles>[0],
    { projectId, resourceTypeIds, namedResourceIds },
  )
  const findings = [...validation.errors]

  const completenessErrors = checkPersistedCompleteness({
    resourceTypes: project.resourceTypes.map(rt => ({
      id: rt.id,
      name: rt.name,
      namedResources: rt.namedResources.map(nr => ({ id: nr.id, name: nr.name })),
    })),
    capacityProfiles: project.capacityProfiles.map(profile => ({
      resourceTypeId: profile.resourceTypeId,
      namedResourceId: profile.namedResourceId,
      ownerKind: String(profile.ownerKind),
      source: String(profile.source),
      planningBasis: String(profile.planningBasis),
    })),
  })
  findings.push(...completenessErrors)
  return findings
}

/**
 * Complete replanning: atomically move the project from NEEDS_REPLAN to
 * CURRENT, but only when canonical planning validation passes.
 *
 * - A CURRENT project is a no-op (returns CURRENT).
 * - A NEEDS_REPLAN project with valid canonical state flips to CURRENT.
 * - A NEEDS_REPLAN project with incomplete/structural findings throws
 *   {@link ReplanIncompleteError} and leaves the state untouched — no profile
 *   is fabricated and the flag is never cleared merely because a button was
 *   clicked.
 */
export async function completeReplanning(
  prisma: PrismaClient,
  projectId: string,
): Promise<'CURRENT'> {
  return prisma.$transaction(async tx => {
    const project = await tx.project.findUnique({
      where: { id: projectId },
      select: { id: true, planningState: true },
    })
    if (!project) {
      const error = new Error('Project not found') as Error & { status: number }
      error.status = 404
      throw error
    }
    if (project.planningState === 'CURRENT') return 'CURRENT' as const

    const findings = await collectReplanningFindings(tx, projectId)
    if (findings.length > 0) {
      throw new ReplanIncompleteError(findings)
    }

    await tx.project.update({
      where: { id: projectId },
      data: { planningState: 'CURRENT' },
    })
    return 'CURRENT' as const
  })
}
