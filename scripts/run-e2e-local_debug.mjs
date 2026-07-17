#!/usr/bin/env node
/**
 * Local E2E runner.
 *   - Loads server/.env and merges with shell env (shell wins).
 *   - Runs e2e-cleanup before seed so repeated runs start clean.
 *   - Starts API and Vite on dynamic ports, runs Playwright tests.
 *   - Cleans up child processes on exit.
 *
 * Awaited commands use the shared `runCommand` from local-postgres.mjs
 * for cross-platform process-tree termination.  Long-lived API/Vite
 * processes use explicit handles cleaned via `stopChildren()` which
 * uses `terminateProcess` (POSIX group) or `windowsTerminateProcess`
 * (taskkill /T /F).
 *
 * Usage:
 *   cd <repo-root>
 *   npm run test:e2e:local
 *
 *   # Pass extra args to Playwright:
 *   npm run test:e2e:local -- --grep "auth"
 */
import { spawn } from 'node:child_process'
import net from 'node:net'
import { fileURLToPath } from 'node:url'
import { loadLocalEnvironment, resolveCommand, runCommand, shutdownGuard, withIsolatedTestDatabase } from './local-postgres.mjs'
import { terminateProcess, windowsTerminateProcess } from './terminate-process.mjs'


const root = fileURLToPath(new URL('..', import.meta.url))
const serverDir = fileURLToPath(new URL('../server/', import.meta.url))
const clientDir = fileURLToPath(new URL('../client/', import.meta.url))
const e2eDir = fileURLToPath(new URL('../e2e/', import.meta.url))

export async function runE2eLocal({ spawn: spawnOption, runCommand: runCommandOverride, withIsolatedTestDatabase: withIsolatedTestDatabaseOverride, loadLocalEnvironment: loadEnvOverride, waitForMonradApi: waitForMonradApiOverride, waitForClient: waitForClientOverride, waitForProxy: waitForProxyOverride } = {}) {
  const resolvedEnv = loadEnvOverride ? loadEnvOverride(root) : loadLocalEnvironment(root)
  const children = []
  const guard = shutdownGuard()
  const internalAbort = new AbortController()

  // Structured failure aggregation.
  class AggregatedError extends Error {
    constructor(primary, secondaryErrors = []) {
      const parts = [primary?.message ?? String(primary)]
      for (const s of secondaryErrors) {
        parts.push(`[${s.type}] ${s.error}`)
      }
      super(parts.join('; '))
      this.name = 'AggregatedError'
      this.primary = primary
      this.secondaryErrors = secondaryErrors
    }
  }

  const failures = {
    primary: null,
    secondary: [],
    addPrimary(err) {
      if (!this.primary) {
        this.primary = err instanceof Error ? err : new Error(String(err))
        internalAbort.abort()
      }
    },
    addSecondary(type, error) {
      this.secondary.push({ type, error: String(error) })
    },
    toError() {
      if (!this.primary && this.secondary.length === 0) return null
      return new AggregatedError(this.primary ?? new Error('Unknown failure'), this.secondary)
    },
  }

  function makeCombinedSignal(...signals) {
    const ctrl = new AbortController()
    for (const sig of signals) sig.addEventListener('abort', () => ctrl.abort(), { once: true })
    return ctrl.signal
  }

  const combinedSignal = AbortSignal.any
    ? AbortSignal.any([guard.abortSignal, internalAbort.signal])
    : makeCombinedSignal(guard.abortSignal, internalAbort.signal)
  const host = resolvedEnv.E2E_HOST ?? '127.0.0.1'

  // Wrap the entire body after guard creation so guard.dispose() runs on every path.
  try {
    // ── Preflight checks ─────────────────────────────────────────────────────
    const jwtSecret = resolvedEnv.JWT_SECRET ?? ''
    if (!jwtSecret || jwtSecret === 'change-me-in-production' || jwtSecret.length < 32) {
      console.error('[e2e-local] ERROR: JWT_SECRET is missing, too short, or still set to "change-me-in-production".')
      console.error('[e2e-local] The example env uses "local-dev-jwt-secret-at-least-32-chars!!" — copy it:')
      console.error('[e2e-local]   cp server/.env.example server/.env')
      console.error('[e2e-local] Or set a custom value of 32+ characters.')
      return { exitCode: 1, primaryChildFailure: null, aggregatedError: null, cleanupErrors: [] }
    }

    // ── Port discovery ───────────────────────────────────────────────────────
    const preferredApiPort = Number(resolvedEnv.E2E_API_PORT ?? resolvedEnv.PORT ?? 3001)
    const preferredClientPort = Number(resolvedEnv.E2E_CLIENT_PORT ?? 5173)
    const apiPort = await findAvailablePort(preferredApiPort)
    const clientPort = await findAvailablePort(preferredClientPort, new Set([apiPort]))
    const apiUrl = `http://${host}:${apiPort}`
    const baseUrl = `http://${host}:${clientPort}`

    console.log(`[e2e-local] API: ${apiUrl}${apiPort === preferredApiPort ? '' : ` (preferred :${preferredApiPort} was unavailable)`}`)
    console.log(`[e2e-local] Client: ${baseUrl}${clientPort === preferredClientPort ? '' : ` (preferred :${preferredClientPort} was unavailable)`}`)

    try {
      await (withIsolatedTestDatabaseOverride ?? withIsolatedTestDatabase)({ root, signal: combinedSignal }, async testEnv => {
        try {
          // ── Cleanup before seed ──────────────────────────────────────────────
          await (runCommandOverride ?? runCommand)('npx', ['tsx', 'scripts/e2e-cleanup.ts'], { cwd: serverDir, env: testEnv, signal: combinedSignal })
          if (guard.triggered || failures.primary) return

          // ── Seed ─────────────────────────────────────────────────────────────
          await (runCommandOverride ?? runCommand)('npx', ['tsx', 'prisma/seed.ts'], { cwd: serverDir, env: testEnv, signal: combinedSignal })
          if (guard.triggered || failures.primary) return

          // ── Start API ────────────────────────────────────────────────────────
          const api = start('npx', ['tsx', 'src/index.ts'], {
            cwd: serverDir, env: testEnv,
            extraEnv: { NODE_ENV: 'test', PORT: String(apiPort), CLIENT_URL: baseUrl },
            label: 'api',
          })
          children.push(api)
          if (guard.triggered || failures.primary) return

          // Race API readiness against child failure.
          await Promise.race([
            (waitForMonradApiOverride ?? waitForMonradApi)(apiUrl).then(() => null),
            api.failure,
          ])
          if (guard.triggered || failures.primary) return

          const client = start('npx', ['vite', '--host', host, '--port', String(clientPort), '--strictPort'], {
            cwd: clientDir, env: testEnv,
            extraEnv: { VITE_API_URL: apiUrl },
            label: 'vite',
          })
          children.push(client)
          if (guard.triggered || failures.primary) return

          // Race client readiness against child failure.
          await Promise.race([
            (waitForClientOverride ?? waitForClient)(baseUrl).then(() => null),
            client.failure,
          ])
          if (guard.triggered || failures.primary) return

          // ── Proxy check ──────────────────────────────────────────────────────
          await Promise.race([
            (waitForProxyOverride ?? waitForProxy)(baseUrl),
            Promise.race([api.failure, client.failure]).catch(() => {}),
          ])
          if (guard.triggered || failures.primary) return

          // ── Playwright ───────────────────────────────────────────────────────
          const playwrightPromise = (runCommandOverride ?? runCommand)('npx', ['playwright', 'test', '--grep-invert', '@screenshots', ...process.argv.slice(2)], {
            cwd: e2eDir, env: testEnv,
            extraEnv: { BASE_URL: baseUrl, API_URL: apiUrl, NODE_ENV: 'test' },
            inherit: true,
            signal: combinedSignal,
          })
          const childFailure = Promise.race([api.failure, client.failure]).catch(() => {})
          const winner = await Promise.race([
            childFailure.then(() => 'child-failure'),
            playwrightPromise.then(() => 'playwright'),
          ])
          if (winner === 'child-failure') {
            // Await forced Playwright termination before cleanup removes DB.
            try {
              await playwrightPromise
            } catch (playwrightErr) {
              const pwMsg = playwrightErr?.message ?? String(playwrightErr)
              // Distinguish ordinary cancellation (expected) from termination failure.
              if (pwMsg.includes('process-tree termination failed')) {
                failures.addSecondary('playwright termination', pwMsg)
              }
            }
            // Throw aggregated error from the action so withIsolatedTestDatabase
            // can append Docker cleanup failures naturally.
            throw failures.toError() ?? new Error('Child failure')
          }
        } finally {
          // Always stop API/Vite children before database cleanup.
          try {
            await stopChildren()
          } catch (childErr) {
            failures.addSecondary('child-process termination', childErr?.message ?? String(childErr))
          }
        }
      })
    } catch (error) {
      // Use the caught error directly — it's already aggregated or is the raw error.
      // Do not replace with primaryChildFailure.message, which would lose cleanup details.
      console.error("CATCH:", typeof error, error?.constructor?.name, "instanceof AggregatedError:", error instanceof AggregatedError); if (error instanceof AggregatedError) {
        if (error.primary) failures.primary = error.primary
        for (const s of error.secondaryErrors) {
          failures.addSecondary(s.type, s.error)
        }
      } else if (error) {
        failures.addSecondary('runner', error?.message ?? String(error))
      }
    }
  } finally {
    guard.dispose()
  }

  return {
    exitCode: computeExitCode(),
    primaryChildFailure: failures.primary,
    aggregatedError: failures.toError(),
    cleanupErrors: failures.secondary.filter(e => {
      if (guard.triggered && e.type === 'runner' && e.error.endsWith('was cancelled')) return false
      return true
    }),
  }

  // ── Helpers (closured) ─────────────────────────────────────────────────────

  /**
   * Attach failure monitoring to a child process.
   * Records the first unexpected exit/error as the primary failure
   * and aborts `internalAbort` to cancel remaining work.
   */
  function monitorChild(child, label) {
    let expectedShutdown = false
    const failure = new Promise((_, reject) => {
      child.on('error', err => {
        if (expectedShutdown) return
        const msg = `${label} could not start: ${err.message}`
        console.error(`[e2e-local] ${msg}`)
        failures.addPrimary(new Error(msg))
        reject(failures.primary)
      })
      child.on('exit', code => {
        if (expectedShutdown) return
        const msg = `${label} exited unexpectedly with code ${code}`
        console.error(`[e2e-local] ${msg}`)
        failures.addPrimary(new Error(msg))
        reject(failures.primary)
      })
    })
    failure.catch(() => {})
    return {
      child,
      failure,
      markExpectedShutdown: () => { expectedShutdown = true },
    }
  }

  function start(command, args, { cwd, env, extraEnv = {}, label }) {
    const spec = resolveCommand(command, args)
    const child = (spawnOption ?? spawn)(spec.command, spec.args, {
      cwd,
      env: { ...env, ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    })

    child.stdout.on('data', data => process.stdout.write(`[${label}] ${data}`))
    child.stderr.on('data', data => process.stderr.write(`[${label}] ${data}`))

    return monitorChild(child, label)
  }

  async function stopChildren() {
    const results = await Promise.allSettled(
      children.reverse().map(async entry => {
        entry.markExpectedShutdown?.()
        if (process.platform === 'win32') {
          await windowsTerminateProcess(entry.child)
        } else {
          await terminateProcess(entry.child, undefined, { useProcessGroup: true })
        }
      })
    )
    const rejected = results.filter(r => r.status === 'rejected')
    if (rejected.length > 0) {
      const messages = rejected.map((r, i) => `child ${i}: ${r.reason?.message ?? r.reason}`).join('; ')
      failures.addSecondary('process termination', messages)
    }
  }

  async function findAvailablePort(startPort, reserved = new Set()) {
    for (let port = startPort; port < startPort + 100; port++) {
      if (reserved.has(port)) continue
      if (await isPortAvailable(port)) return port
    }
    throw new Error(`No available port found starting at ${startPort}`)
  }

  async function isPortAvailable(port) {
    if (await portRespondsToHttp(port)) return false
    return new Promise(resolve => {
      const server = net.createServer()
      server.once('error', () => resolve(false))
      server.once('listening', () => server.close(() => resolve(true)))
      server.listen(port, host)
    })
  }

  async function portRespondsToHttp(port) {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 500)
    try {
      await fetch(`http://${host}:${port}/health`, { signal: controller.signal })
      return true
    } catch {
      return false
    } finally {
      clearTimeout(timeout)
    }
  }

  async function waitForMonradApi(url) {
    await waitFor(`Monrad API at ${url}`, async () => {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 10_000)
      const fetchSignal = AbortSignal.any
        ? AbortSignal.any([controller.signal, combinedSignal])
        : controller.signal
      try {
        const response = await fetch(`${url}/health`, { signal: fetchSignal })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const body = await response.json()
        if (body.status !== 'ok' || body.service !== 'monrad-estimator') {
          throw new Error(`Unexpected health payload: ${JSON.stringify(body)}`)
        }
      } catch (err) {
        if (err?.name === 'AbortError') throw new Error('Request timed out')
        throw err
      } finally {
        clearTimeout(timeout)
      }
    })
  }

  async function waitForClient(url) {
    await waitFor(`Vite client at ${url}`, async () => {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 10_000)
      const fetchSignal = AbortSignal.any
        ? AbortSignal.any([controller.signal, combinedSignal])
        : controller.signal
      try {
        const response = await fetch(url, { signal: fetchSignal })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const html = await response.text()
        if (!html.includes('Monrad Estimator')) throw new Error('Client HTML did not contain Monrad title')
      } catch (err) {
        if (err?.name === 'AbortError') throw new Error('Request timed out')
        throw err
      } finally {
        clearTimeout(timeout)
      }
    })
  }

  async function waitForProxy(url) {
    await waitFor(`Vite API proxy at ${url}/api/projects`, async () => {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 10_000)
      const fetchSignal = AbortSignal.any
        ? AbortSignal.any([controller.signal, combinedSignal])
        : controller.signal
      try {
        const response = await fetch(`${url}/api/projects`, { signal: fetchSignal })
        const body = await response.json()
        if (response.status !== 401 || !['AUTH_REQUIRED', 'Unauthorized'].includes(body.code ?? body.error)) {
          throw new Error(`Unexpected proxy response ${response.status}: ${JSON.stringify(body)}`)
        }
      } catch (err) {
        if (err?.name === 'AbortError') throw new Error('Request timed out')
        throw err
      } finally {
        clearTimeout(timeout)
      }
    })
  }

  async function waitFor(label, check) {
    const deadline = Date.now() + 60_000
    let lastError
    while (Date.now() < deadline) {
      if (combinedSignal.aborted) {
        if (failures.primary) throw failures.primary
        throw new Error(`Cancelled: ${label}`)
      }
      try {
        await check()
        console.log(`[e2e-local] Ready: ${label}`)
        return
      } catch (error) {
        lastError = error
        await new Promise(resolve => setTimeout(resolve, 1_000))
      }
    }
    throw new Error(`Timed out waiting for ${label}: ${lastError?.message ?? 'unknown error'}`)
  }

  function computeExitCode() {
    if (guard.triggered) return guard.signalExitCode
    if (failures.primary || failures.secondary.some(e => e.type !== 'process termination')) return 1
    return 0
  }
}

// ── CLI entrypoint ──────────────────────────────────────────────────────────
// Only run when this file is executed directly, not when imported by tests.
const isMain = process.argv[1] === fileURLToPath(import.meta.url)
if (isMain) {
  // Validation mode: load env and exit without starting servers.
  const validateEnv = loadLocalEnvironment(root)
  if (process.argv.includes('--validate')) {
    console.log(`[e2e-local] DATABASE_URL: ${validateEnv.DATABASE_URL ? 'set' : 'unset'}`)
    const js = validateEnv.JWT_SECRET ?? ''
    if (!js || js === 'change-me-in-production' || js.length < 32) {
      console.error('[e2e-local] JWT_SECRET: INVALID (missing, too short, or placeholder)')
      process.exit(1)
    }
    console.log('[e2e-local] Validation OK')
    process.exit(0)
  }

  // Run the full lifecycle.
  const result = await runE2eLocal()
  for (const ce of result.cleanupErrors) {
    console.error(`[e2e-local] ${ce.type}: ${ce.error}`)
  }
  process.exit(result.exitCode)
}
