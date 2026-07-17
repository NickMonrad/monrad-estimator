#!/usr/bin/env node
/**
 * Bounded, cancellable development database setup.
 *
 * - First SIGINT/SIGTERM requests graceful cancellation.
 * - Second signal force-exits the process.
 * - MONRAD_DB_SETUP_TIMEOUT_MS (default 120000ms) bounds the entire operation.
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
import { AggregatedError, createFailureCollector } from './aggregated-error.mjs'
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
 * Orchestrate the full db:setup lifecycle.
 * Returns { exitCode, aggregatedError }.
 *
 * When guard.triggered sets process.exitCode (130/143), this function
 * must NOT overwrite it with exit code 1.
 */
export async function runDbSetup({
  environment,
  ensureDatabase: ensureFn = ensureDatabase,
  preparePrisma: prepareFn = preparePrisma,
  guardFactory = shutdownGuard,
  timeoutFactory = AbortSignal.timeout.bind(AbortSignal),
  process: proc = process,
} = {}) {
  const collector = createFailureCollector()
  const guard = guardFactory()
  const timeoutMs = parseTimeout(environment.MONRAD_DB_SETUP_TIMEOUT_MS)
  const timeoutSignal = timeoutFactory(timeoutMs)

  // Combine guard abort + timeout into one signal.
  const combinedSignal = AbortSignal.any
    ? AbortSignal.any([guard.abortSignal, timeoutSignal])
    : (() => {
      const ctrl = new AbortController()
      guard.abortSignal.addEventListener('abort', () => ctrl.abort(), { once: true })
      timeoutSignal.addEventListener('abort', () => ctrl.abort(), { once: true })
      return ctrl.signal
    })()

  try {
    const result = await ensureFn({ databaseUrl: environment.DATABASE_URL, signal: combinedSignal })
    await prepareFn({ root, env: environment, signal: combinedSignal })

    const status = guard.triggered
      ? `cancelled after ${timeoutMs}ms timeout`
      : result.created ? 'created' : 'already exists'
    console.log(`[db:setup] Development database ${status}; migrations and Prisma client are current.`)
  } catch (error) {
    if (guard.triggered) {
      // Guard already set process.exitCode; do not overwrite.
      collector.addSecondary('runner', error instanceof Error ? error : new Error(String(error)))
    } else if (timeoutSignal.aborted) {
      collector.addPrimary(new Error('db:setup timed out'))
    } else {
      collector.addPrimary(error instanceof Error ? error : new Error(String(error)))
    }
  } finally {
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
