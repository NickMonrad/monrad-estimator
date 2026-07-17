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
 *
 * addError() recursively flattens AggregatedError instances, preserving
 * the first substantive error as primary and adding later distinct
 * errors as typed secondaries.
 */

export class AggregatedError extends Error {
  constructor(primary, secondaryErrors = []) {
    const parts = [primary?.message ?? String(primary)]
    for (const s of secondaryErrors) parts.push(`[${s.type}] ${s.error?.message ?? String(s.error)}`)
    super(parts.join('; '))
    this.name = 'AggregatedError'
    this.primary = primary
    this.secondaryErrors = secondaryErrors
  }
}

/**
 * Build a stable deduplication key from an error and optional type.
 * Uses type, name, message, and cause identity where available.
 */
function dedupKey(error, type = null) {
  const parts = []
  if (type) parts.push(type)
  if (error instanceof Error) {
    parts.push(error.name)
    parts.push(error.message)
    if (error.cause && typeof error.cause === 'object') {
      try { parts.push(JSON.stringify(error.cause)) } catch { /* best effort */ }
    }
  } else {
    parts.push('Error')
    parts.push(String(error))
  }
  return parts.join('::')
}

/**
 * Recursively flatten an AggregatedError into primary/secondary parts.
 * Returns { primary, secondaryErrors[] } without mutating originals.
 */
function flattenAggregated(aggregated) {
  const secondaryErrors = []
  let primary
  if (aggregated.primary) {
    if (aggregated.primary instanceof AggregatedError) {
      const result = flattenAggregated(aggregated.primary)
      primary = result.primary
      if (result.secondaryErrors) secondaryErrors.push(...result.secondaryErrors)
    } else {
      primary = aggregated.primary
    }
  }
  for (const s of (aggregated.secondaryErrors ?? [])) {
    secondaryErrors.push(s)
  }
  return { primary, secondaryErrors }
}

export function createFailureCollector() {
  let primary = null          // Error | null
  const secondary = []        // { type: string, error: Error }
  const seen = new Set()      // dedup key set

  function addUnique(key, item) {
    if (seen.has(key)) return
    seen.add(key)
    secondary.push(item)
  }

  return {
    get primary() { return primary },
    get secondary() { return secondary },

    /**
     * Add an error as the primary failure. If primary is already set,
     * the new error becomes a secondary of type 'primary' (unless it
     * structurally duplicates the existing primary).
     */
    addPrimary(err) {
      if (!err) return
      const error = err instanceof Error ? err : new Error(String(err))
      if (!primary) {
        primary = error
        return
      }
      // Later primary becomes a typed secondary.
      addUnique(dedupKey(error, 'primary'), { type: 'primary', error })
    },

    /**
     * Add a typed secondary error.
     */
    addSecondary(type, error) {
      const errObj = error instanceof Error ? error : new Error(String(error))
      addUnique(dedupKey(errObj, type), { type, error: errObj })
    },

    /**
     * Add an error that may be an AggregatedError (or plain Error).
     * Recursively flattens nested aggregates. Later distinct primary
     * errors from the nested aggregate become typed secondaries here.
     *
     * @param {Error|AggregatedError} error
     * @param {object} [opts]
     * @param {string} [opts.primaryType]  — type key for primary errors
     * @param {string} [opts.secondaryType] — type key for secondary errors
     */
    addError(error, { primaryType, secondaryType } = {}) {
      if (!error) return
      if (error instanceof AggregatedError) {
        const { primary: innerPrimary, secondaryErrors: innerSecondaries } = flattenAggregated(error)
        if (innerPrimary) {
          this.addPrimary(innerPrimary)
        }
        for (const s of innerSecondaries) {
          const type = s.type ?? secondaryType ?? 'secondary'
          addUnique(dedupKey(s.error, type), { type, error: s.error })
        }
      } else {
        const errObj = error instanceof Error ? error : new Error(String(error))
        if (!primary) {
          primary = errObj
        } else {
          const type = primaryType ?? 'primary'
          addUnique(dedupKey(errObj, type), { type, error: errObj })
        }
      }
    },

    /**
     * Produce an AggregatedError from the current collector state,
     * or null if no errors have been recorded.
     */
    toError() {
      if (!primary && secondary.length === 0) return null
      return new AggregatedError(primary ?? new Error('Unknown failure'), [...secondary])
    },
  }
}
