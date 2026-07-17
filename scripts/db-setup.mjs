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

try {
  const environment = loadLocalEnvironment(root)
  if (!environment.DATABASE_URL) throw new Error('DATABASE_URL is required; configure server/.env, MONRAD_ENV_FILE, or the shell environment')

  const timeoutMs = parseTimeout(environment.MONRAD_DB_SETUP_TIMEOUT_MS)
  const guard = shutdownGuard()
  const timeoutSignal = AbortSignal.timeout(timeoutMs)
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
    const result = await ensureDatabase({ databaseUrl: environment.DATABASE_URL, signal: combinedSignal })
    await preparePrisma({ root, env: environment, signal: combinedSignal })

    const status = guard.triggered
      ? `cancelled after ${timeoutMs}ms timeout`
      : result.created ? 'created' : 'already exists'
    console.log(`[db:setup] Development database ${status}; migrations and Prisma client are current.`)
  } finally {
    guard.dispose()
  }
} catch (error) {
  let prefix = 'db:setup failed'
  if (error?.name === 'AbortError' || error?.name === 'TimeoutError') {
    prefix = 'db:setup timed out'
  } else if (error?.message?.includes('Cancelled') || error?.message?.includes('cancelled')) {
    prefix = 'db:setup cancelled'
  }
  console.error(`[db:setup] ${redactError(error, prefix).message}`)
  process.exitCode = 1
}
