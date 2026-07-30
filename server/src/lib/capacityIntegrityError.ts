/**
 * capacityIntegrityError.ts — Domain error for invalid persisted capacity state.
 *
 * Thrown when a normal runtime write encounters missing, duplicate, malformed,
 * wrong-owner-kind, cross-project, or ambiguous CapacityProfile state that
 * prevents safe mutation.
 *
 * The error handler maps this to an actionable HTTP response without exposing
 * internal details in production.
 *
 * @see docs/domain/capacity-profile-source-of-truth-migration-plan.md
 */

export class CapacityIntegrityError extends Error {
  /** Stable machine-readable code for client-side handling. */
  readonly code: string = 'CAPACITY_INTEGRITY_ERROR'
  /** HTTP status code — 409 Conflict (state conflicts with expected invariants). */
  readonly status: number = 409
  /** User-facing message safe to return in all environments. */
  readonly userMessage: string

  constructor(message: string) {
    super(message)
    this.name = 'CapacityIntegrityError'
    this.userMessage = message
  }
}
