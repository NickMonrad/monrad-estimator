/**
 * legacyCapacityFieldGuard.ts — Shared rejection guard for legacy capacity
 * request fields on non-capacity ResourceType / NamedResource routes.
 *
 * Issue #403: the owner-scoped capacity-profile endpoint
 *
 *   PUT /api/projects/:projectId/capacity-profiles/:ownerKind/:ownerId
 *
 * is the only public contract that may change capacity shape. Routes that
 * own non-capacity metadata or resource identity must reject supplied legacy
 * capacity fields — including explicit null — with a stable, actionable 400
 * before any database write or cache clear.
 */

import type { Response } from 'express'

export const LEGACY_CAPACITY_FIELDS = [
  'allocationMode',
  'allocationPercent',
  'allocationPct',
  'allocationStartWeek',
  'allocationEndWeek',
  'startWeek',
  'endWeek',
] as const

export type LegacyCapacityField = (typeof LEGACY_CAPACITY_FIELDS)[number]

export const CAPACITY_PROFILE_ENDPOINT =
  '/api/projects/:projectId/capacity-profiles/:ownerKind/:ownerId'

/**
 * Collect every legacy capacity field present in the JSON body.
 *
 * A field counts as supplied when it is present in the object, including
 * when its value is explicitly null.
 */
export function findRejectedLegacyCapacityFields(body: unknown): LegacyCapacityField[] {
  if (!body || typeof body !== 'object') return []
  const rejected: LegacyCapacityField[] = []
  for (const field of LEGACY_CAPACITY_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(body, field)) {
      rejected.push(field)
    }
  }
  return rejected
}

/**
 * Stable 400 response shape identifying every rejected field and directing
 * the caller to the owner-scoped capacity-profile endpoint.
 */
export function legacyCapacityRejection(rejectedFields: LegacyCapacityField[]): {
  status: 400
  body: {
    error: string
    rejectedFields: LegacyCapacityField[]
    capacityProfileEndpoint: string
  }
} {
  return {
    status: 400,
    body: {
      error:
        `Legacy capacity field(s) are no longer accepted on this route: ${rejectedFields.join(', ')}. ` +
        `Change capacity through the owner-scoped capacity-profile endpoint: ${CAPACITY_PROFILE_ENDPOINT}.`,
      rejectedFields,
      capacityProfileEndpoint: CAPACITY_PROFILE_ENDPOINT,
    },
  }
}

/**
 * Reject the request when it supplies any legacy capacity field.
 *
 * Writes the stable 400 response and returns true; returns false when the
 * request carries no legacy capacity fields and may proceed.
 */
export function rejectLegacyCapacityFields(reqBody: unknown, res: Response): boolean {
  const rejected = findRejectedLegacyCapacityFields(reqBody)
  if (rejected.length === 0) return false
  const rejection = legacyCapacityRejection(rejected)
  res.status(rejection.status).json(rejection.body)
  return true
}

/**
 * Whether a persisted capacity profile is Squad Planner-owned.
 *
 * Planner ownership is tracked by the profile `source` (SQUAD_PLANNER).
 * Transferred profiles keep their `ownerKind` (PLANNED_RESOURCE) but move to
 * source MANUAL, so ownerKind alone must not mark a profile planner-owned.
 */
export function isPlannerOwnedProfile(profile: {
  source?: string | null
}): boolean {
  return profile.source === 'SQUAD_PLANNER'
}

/** Shared 409 message directing the user to the explicit transfer workflow. */
export function plannerOwnedIdentityConflict(resourceLabel: string): {
  error: string
  code: string
} {
  return {
    error:
      `${resourceLabel} is managed by Squad Planner. ` +
      'Switch to manual capacity before changing its resources.',
    code: 'PLANNER_MANAGED_IDENTITY',
  }
}

/**
 * Typed conflict thrown by identity routes before any write when a
 * planner-owned role or resource would be altered by count/add/remove.
 * Route handlers map it to HTTP 409.
 */
export class PlannerManagedIdentityError extends Error {
  readonly code = 'PLANNER_MANAGED_IDENTITY'
  constructor(resourceLabel: string) {
    super(plannerOwnedIdentityConflict(resourceLabel).error)
    this.name = 'PlannerManagedIdentityError'
  }
}

export function isPlannerManagedIdentityError(error: unknown): error is PlannerManagedIdentityError {
  return error instanceof PlannerManagedIdentityError
}
