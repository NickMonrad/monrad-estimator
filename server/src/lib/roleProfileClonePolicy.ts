/**
 * roleProfileClonePolicy.ts — Provenance and validity policy for profiles
 * generated from a ROLE default (ResourceType count increase and
 * NamedResource POST).
 *
 * Generated named-person profiles are system-derived, not user-authored:
 * they carry a persisted provenance marker in the existing `legacy` JSON
 * (`writer: 'ROLE_DEFAULT'`) and a non-protective `DERIVED` source so the
 * NR classifier recognises them as inherited and a later count reduction
 * may remove them. A user edit through the first-class capacity endpoint
 * flips `source` to `MANUAL`, which the classifier treats as protected.
 *
 * ROLE profiles may represent aggregate capacity above 100% (the
 * authoritative validator only caps non-ROLE owners at 100). Such a shape
 * cannot be represented as a single valid named-person profile, so the
 * clone operations reject it before any write.
 */

import type { Response } from 'express'

/** Persisted provenance marker written onto every generated named-person profile. */
export const ROLE_DEFAULT_CLONE_LEGACY = { version: 1, writer: 'ROLE_DEFAULT' } as const

export const ROLE_DEFAULT_CLONE_WRITER = 'ROLE_DEFAULT'

/** Whether a persisted profile was generated from a ROLE default by the system. */
export function isRoleDefaultClone(profile: { legacy?: unknown }): boolean {
  const legacy = profile.legacy
  if (typeof legacy !== 'object' || legacy === null) return false
  return (legacy as { writer?: unknown }).writer === ROLE_DEFAULT_CLONE_WRITER
}

/**
 * Typed 400 thrown when a ROLE profile's aggregate capacity cannot be
 * represented as one valid named-person profile. Route handlers map it to
 * HTTP 400 before any write.
 */
export class AggregateRoleCloneError extends Error {
  readonly code = 'AGGREGATE_ROLE_CAPACITY'
  constructor(message: string) {
    super(message)
    this.name = 'AggregateRoleCloneError'
  }
}

export function isAggregateRoleCloneError(error: unknown): error is AggregateRoleCloneError {
  return error instanceof AggregateRoleCloneError
}

export interface RoleProfileShape {
  defaultPercent: number | null
  segments?: Array<{ startWeek: number; endWeek: number; capacityPercent: number }>
}

/**
 * Reject cloning a ROLE profile into a named-person profile when any
 * percentage exceeds the non-ROLE cap of 100 — the authoritative validator
 * would reject the persisted NAMED_PERSON profile.
 *
 * Throws AggregateRoleCloneError (mapped to HTTP 400) with an actionable
 * message; no values are clamped or re-derived.
 */
export function assertRoleProfileCloneableAsNamedPerson(roleProfile: RoleProfileShape): void {
  if (roleProfile.defaultPercent !== null && roleProfile.defaultPercent > 100) {
    throw new AggregateRoleCloneError(
      `Role capacity profile has defaultPercent ${roleProfile.defaultPercent}, which exceeds the 100% per-person maximum. ` +
      'Reduce the role capacity to at most 100% before adding named resources.',
    )
  }
  for (const segment of roleProfile.segments ?? []) {
    if (segment.capacityPercent > 100) {
      throw new AggregateRoleCloneError(
        `Role capacity profile segment [W${segment.startWeek}-W${segment.endWeek}] has capacityPercent ${segment.capacityPercent}, which exceeds the 100% per-person maximum. ` +
        'Reduce the segment capacity to at most 100% before adding named resources.',
      )
    }
  }
}

/** Render a 400 response for the aggregate-capacity conflict. */
export function respondAggregateRoleCloneError(error: AggregateRoleCloneError, res: Response): void {
  res.status(400).json({ error: error.message, code: error.code })
}
