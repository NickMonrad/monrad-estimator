/**
 * projectPlanningState.ts — Shared project planning-state guard (issue #449).
 *
 * A project carries an explicit persisted planning state:
 *
 *   CURRENT     — planning is expected to be canonical. Missing, duplicate,
 *                 malformed or conflicting profile state remains a real
 *                 integrity failure (fail closed as today).
 *   NEEDS_REPLAN — the project deliberately discarded its planning state via
 *                 the Reset Planning workflow. Planning incompleteness is
 *                 expected and must NOT trigger legacy fallback, auto-repair
 *                 or capacity invention. Capacity-dependent operations are
 *                 quarantined and return an actionable REPLAN_REQUIRED result
 *                 until the user replans through the normal supported
 *                 planning surfaces and completes replanning.
 *
 * This guard is deliberately NOT a generic recovery framework: it only
 * interprets the explicit persisted state and raises the typed error used by
 * the error handler. Existing profile/planning validation remains the source
 * of truth for canonical completion (see completeReplanning.ts).
 */

export type ProjectPlanningState = 'CURRENT' | 'NEEDS_REPLAN'

/** Minimal project shape the guard needs. */
export interface PlanningStateProjectLike {
  planningState?: ProjectPlanningState | string | null
}

/**
 * Domain error raised when a capacity-dependent operation runs on a project
 * whose planning state is NEEDS_REPLAN. The error handler maps it to HTTP 409
 * with the stable `REPLAN_REQUIRED` code and an actionable message — never a
 * legacy fallback, auto-repair or an opaque integrity failure.
 */
export class ReplanRequiredError extends Error {
  /** Stable machine-readable code for client-side handling. */
  readonly code: string = 'REPLAN_REQUIRED'
  /** HTTP status code — 409 Conflict (the action conflicts with the explicit planning state). */
  readonly status: number = 409
  /** User-facing message safe to return in all environments. */
  readonly userMessage: string

  constructor(message?: string) {
    super(message ?? defaultReplanRequiredMessage())
    this.name = 'ReplanRequiredError'
    this.userMessage = this.message
  }
}

export function defaultReplanRequiredMessage(): string {
  return (
    'This project needs replanning. Its resource planning is no longer current: ' +
    'review the resource inputs in Resource Profile and replan from the existing ' +
    'backlog before running this action.'
  )
}

/**
 * Assert that a project's planning state is CURRENT.
 *
 * Throws {@link ReplanRequiredError} when the project is explicitly in
 * NEEDS_REPLAN. Projects without a persisted state (or with the default
 * CURRENT) pass — the persisted field is authoritative and intentional
 * incompleteness is never inferred from malformed data.
 */
export function assertPlanningCurrent(
  project: PlanningStateProjectLike | null | undefined,
  message?: string,
): void {
  if (project?.planningState === 'NEEDS_REPLAN') {
    throw new ReplanRequiredError(message)
  }
}
