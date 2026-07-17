#!/usr/bin/env node
/**
 * Bounded, cancellable development database setup.
 *
 * - First SIGINT/SIGTERM requests graceful cancellation.
 * - Second signal force-exits the process.
 * - MONRAD_DB_SETUP_TIMEOUT_MS (default 120000ms) bounds the entire operation.
 * - Connection and query timeouts derive from the overall deadline.
 * - Credentials are redacted from all error output.
 * - Existing databases are never reset or dropped.
 *
 * Usage:
 *   npm run db:setup
 *
 * Environment:
 *   MONRAD_DB_SETUP_TIMEOUT_MS  — overall operation timeout (ms, default 120000)
 *   MONRAD_ENV_FILE             — path to env file (defaults to server/.env)
 *   DATABASE_URL                — persistent development database URL
 */
import { fileURLToPath } from 'node:url'
import { createFailureCollector } from './aggregated-error.mjs'
import { ensureDatabase, loadLocalEnvironment, preparePrisma, redactError, shutdownGuard } from './local-postgres.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))

function parseTimeout(envValue) {
  if (envValue === undefined || envValue === '') return 120_000
  const n = Number(envValue)
  if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) {
    throw new Error(`MONRAD_DB_SETUP_TIMEOUT_MS must be a positive integer, got "${envValue}"`)
  }
  if (n < 5_000) throw new Error(`MONRAD_DB_SETUP_TIMEOUT_MS must be at least 5000ms, got ${n}ms`)
  if (n > 600_000) throw new Error(`MONRAD_DB_SETUP_TIMEOUT_MS must be at most 600000ms, got ${n}ms`)
  return n
}

/**
 * Compute remaining time from a deadline, capped by an optional maximum.
 * Returns 0 when the deadline has passed. Never negative.
 */
function remainingTime(deadline, maximum = Infinity) {
  if (deadline == null) return Number.isFinite(maximum) ? maximum : 300_000
  const remaining = deadline - Date.now()
  if (remaining <= 0) return 0
  return Number.isFinite(maximum) ? Math.min(remaining, maximum) : remaining
}

/**
 * Orchestrate the full db:setup lifecycle.
 *
 * Returns { exitCode, aggregatedError }.
 *
 * When guard.triggered sets process.exitCode (130/143), this function
 * must NOT overwrite it with exit code 1.
 *
 * Ordering (F4):
 *   1. validate config BEFORE guard creation so config errors don't leak listeners
 *   2. create guard
 *   3. immediately enter try/finally
 *   4. construct combined signal inside the protected block
 *   5. execute lifecycle
 *   6. dispose guard in finally
 *
 * Cancellation checks (F2):
 *   - before ensureDatabase
 *   - after ensureDatabase, before preparePrisma
 *   - before success output
 *   Guard-triggered = cancellation; timeout = timeout; both = guard wins.
 */
export async function runDbSetup({
  environment,
  ensureDatabase: ensureFn = ensureDatabase,
  preparePrisma: prepareFn = preparePrisma,
  guardFactory = shutdownGuard,
  timeoutFactory = AbortSignal.timeout.bind(AbortSignal),
  process: proc = process,
} = {}) {
  // Step 1: create guard FIRST so try/finally can always dispose it (F4)
  const guard = guardFactory()
  const collector = createFailureCollector()
  // Cancellation-source state shared by try/catch/finally (blocker 1 fix).
  let cancellationSource = null  // 'signal' | 'timeout' | null
  let guardAbort = null
  let timeoutAbort = null
  let timeoutSignal = null

  /**
   * Determine cancellation source: guard (signal) vs timeout vs nil.
   * Hoisted to function scope so catch and finally can call it.
   */
  function resolveSource() {
    return cancellationSource || (timeoutSignal?.aborted ? 'timeout' : guard.triggered ? 'signal' : null)
  }

  try {
    // Step 2: validate config inside the protected block
    const timeoutMs = parseTimeout(environment.MONRAD_DB_SETUP_TIMEOUT_MS)
    timeoutSignal = timeoutFactory(timeoutMs)

    // Attach listeners to detect the first cancellation source.
    cancellationSource = null
    guardAbort = () => { if (!cancellationSource) cancellationSource = 'signal' }
    timeoutAbort = () => { if (!cancellationSource) cancellationSource = 'timeout' }
    guard.abortSignal.addEventListener('abort', guardAbort, { once: true })
    timeoutSignal.addEventListener('abort', timeoutAbort, { once: true })

    // Step 3: combined signal
    const combinedSignal = AbortSignal.any
      ? AbortSignal.any([guard.abortSignal, timeoutSignal])
      : (() => {
        const ctrl = new AbortController()
        const onAbort = () => ctrl.abort()
        guard.abortSignal.addEventListener('abort', onAbort, { once: true })
        timeoutSignal.addEventListener('abort', onAbort, { once: true })
        return ctrl.signal
      })()

    // Compute absolute deadline so ensureDatabase can derive timeouts from it.
    const deadline = Date.now() + timeoutMs

    // Step 4a: cancellation check BEFORE database work
    if (combinedSignal.aborted) throw new Error(resolveSource() === 'timeout' ? 'db:setup timed out' : 'db:setup was cancelled')

    // Step 4b: ensure database
    const result = await ensureFn({ databaseUrl: environment.DATABASE_URL, signal: combinedSignal, deadline })

    // Step 4c: cancellation check AFTER ensureDatabase, BEFORE Prisma
    if (combinedSignal.aborted) {
      throw new Error(resolveSource() === 'timeout' ? 'db:setup timed out' : 'db:setup was cancelled')
    }

    // Step 4d: Prisma migration and generation
    await prepareFn({ root, env: environment, signal: combinedSignal })

    // Step 4e: check before success output
    if (guard.triggered) {
      collector.addSecondary('runner', new Error('db:setup was cancelled'))
    } else if (timeoutSignal.aborted) {
      collector.addSecondary('runner', new Error('db:setup timed out'))
    } else {
      const status = result.created ? 'created' : 'already exists'
      console.log(`[db:setup] Development database ${status}; migrations and Prisma client are current.`)
    }
  } catch (error) {
    // Classification: cancellation source determines the label.
    const source = resolveSource()
    if (source === 'signal') {
      collector.addSecondary('runner', error instanceof Error ? error : new Error(String(error)))
    } else if (source === 'timeout') {
      collector.addPrimary(new Error('db:setup timed out'))
      if (error) {
        collector.addSecondary('runner', error instanceof Error ? error : new Error(String(error)))
      }
    } else {
      collector.addPrimary(error instanceof Error ? error : new Error(String(error)))
    }
  } finally {
    // Clean up abort listeners — safe even if never fired or already removed.
    if (guardAbort) guard.abortSignal.removeEventListener('abort', guardAbort)
    if (timeoutAbort && timeoutSignal) timeoutSignal.removeEventListener('abort', timeoutAbort)
    guard.dispose()
  }

  const aggregated = collector.toError()
  return {
    exitCode: guard.triggered ? guard.signalExitCode : aggregated ? 1 : 0,
    aggregatedError: aggregated,
  }
}

// ── CLI entrypoint ──────────────────────────────────────────────────────────
// Only run when this file is executed directly.
const isMain = process.argv[1] === fileURLToPath(import.meta.url)
if (isMain) {
  const environment = loadLocalEnvironment(root)
  if (!environment.DATABASE_URL) {
    console.error('[db:setup] DATABASE_URL is required; configure server/.env, MONRAD_ENV_FILE, or the shell environment')
    process.exit(1)
  }

  const result = await runDbSetup({ environment, process })
  if (result.aggregatedError) {
    const msg = redactError(result.aggregatedError, 'db:setup failed')
    console.error(`[db:setup] ${msg.message}`)
  }
  process.exit(result.exitCode)
}
