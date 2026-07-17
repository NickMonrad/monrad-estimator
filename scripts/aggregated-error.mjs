/**
 * Structured error aggregation for multi-stage cleanup and termination.
 *
 * Designed for the E2E runner and Docker lifecycle helpers so that primary
 * failures, child-process termination failures, Playwright cancellation
 * failures, and Docker cleanup failures are all preserved without message
 * parsing and without duplicate entries.
 *
 * Use createFailureCollector to build a shared collector; call
 * .toError() to produce a structured AggregatedError when the run is complete.
 */

export class AggregatedError extends Error {
  constructor(primary, secondaryErrors = []) {
    const parts = [primary?.message ?? String(primary)]
    for (const s of secondaryErrors) parts.push(`[${s.type}] ${s.error}`)
    super(parts.join('; '))
    this.name = 'AggregatedError'
    this.primary = primary
    this.secondaryErrors = secondaryErrors
  }
}

export function createFailureCollector() {
  let primary = null
  const secondary = []
  const seen = new Set()

  return {
    get primary() { return primary },
    get secondary() { return secondary },

    addPrimary(err) {
      if (!primary) {
        primary = err instanceof Error ? err : new Error(String(err))
      }
    },

    addSecondary(type, error) {
      const key = `${type}::${String(error)}`
      if (seen.has(key)) return
      seen.add(key)
      secondary.push({ type, error: String(error) })
    },

    toError() {
      if (!primary && secondary.length === 0) return null
      return new AggregatedError(primary ?? new Error('Unknown failure'), [...secondary])
    },
  }
}
