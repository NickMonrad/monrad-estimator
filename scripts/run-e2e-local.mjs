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
import { AggregatedError, createFailureCollector } from './aggregated-error.mjs'


const root = fileURLToPath(new URL('..', import.meta.url))
const serverDir = fileURLToPath(new URL('../server/', import.meta.url))
const clientDir = fileURLToPath(new URL('../client/', import.meta.url))
const e2eDir = fileURLToPath(new URL('../e2e/', import.meta.url))
export async function runE2eLocal({ spawn: spawnOption, runCommand: runCommandOverride, withIsolatedTestDatabase: withIsolatedTestDatabaseOverride, loadLocalEnvironment: loadEnvOverride, waitForMonradApi: waitForMonradApiOverride, waitForClient: waitForClientOverride, waitForProxy: waitForProxyOverride, guardFactory = shutdownGuard, terminateChild } = {}) {
  const children = []
  const guard = guardFactory()
  const internalAbort = new AbortController()
  const failures = createFailureCollector()

  // Override addPrimary to also abort the internal signal (for E2E runner).
  const originalAddPrimary = failures.addPrimary.bind(failures)
  failures.addPrimary = (err) => {
    originalAddPrimary(err)
    internalAbort.abort()
  }

  function makeCombinedSignal(...signals) {
    const ctrl = new AbortController()
    for (const sig of signals) sig.addEventListener('abort', () => ctrl.abort(), { once: true })
    return ctrl.signal
  }

  const combinedSignal = AbortSignal.any
    ? AbortSignal.any([guard.abortSignal, internalAbort.signal])
    : makeCombinedSignal(guard.abortSignal, internalAbort.signal)
  const resolvedEnv = loadEnvOverride ? loadEnvOverride(root) : loadLocalEnvironment(root)
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
          if (guard.triggered) return
          if (failures.primary) throw failures.toError()

          // ── Seed ─────────────────────────────────────────────────────────────
          await (runCommandOverride ?? runCommand)('npx', ['tsx', 'prisma/seed.ts'], { cwd: serverDir, env: testEnv, signal: combinedSignal })
          if (guard.triggered) return
          if (failures.primary) throw failures.toError()

          // ── Start API ────────────────────────────────────────────────────────
          const api = start('npx', ['tsx', 'src/index.ts'], {
            cwd: serverDir, env: testEnv,
            extraEnv: { NODE_ENV: 'test', PORT: String(apiPort), CLIENT_URL: baseUrl },
            label: 'api',
          })
          children.push(api)
          if (guard.triggered) return
          if (failures.primary) throw failures.toError()

          // Race API readiness against child failure.
          await Promise.race([
            (waitForMonradApiOverride ?? waitForMonradApi)(apiUrl).then(() => null),
            api.failure,
          ])
          if (guard.triggered) return
          if (failures.primary) throw failures.toError()

          const client = start('npx', ['vite', '--host', host, '--port', String(clientPort), '--strictPort'], {
            cwd: clientDir, env: testEnv,
            extraEnv: { VITE_API_URL: apiUrl },
            label: 'vite',
          })
          children.push(client)
          if (guard.triggered) return
          if (failures.primary) throw failures.toError()

          // Race client readiness against child failure.
          await Promise.race([
            (waitForClientOverride ?? waitForClient)(baseUrl).then(() => null),
            client.failure,
          ])
          if (guard.triggered) return
          if (failures.primary) throw failures.toError()

          // ── Proxy check ──────────────────────────────────────────────────────
          const proxyRace = await Promise.race([
            (waitForProxyOverride ?? waitForProxy)(baseUrl).then(() => 'proxy-ok'),
            Promise.race([api.failure, client.failure]).then(
              () => 'child-failure',
              () => 'child-failure',
            ),
          ])
          if (proxyRace === 'child-failure') {
            if (failures.primary) throw failures.toError()
          }
          if (guard.triggered) return

          // ── Playwright ───────────────────────────────────────────────────────
          const playwrightPromise = (runCommandOverride ?? runCommand)('npx', ['playwright', 'test', '--grep-invert', '@screenshots', ...process.argv.slice(2)], {
            cwd: e2eDir, env: testEnv,
            extraEnv: { BASE_URL: baseUrl, API_URL: apiUrl, NODE_ENV: 'test' },
            inherit: true,
            signal: combinedSignal,
          })
          const pwWinner = await Promise.race([
            Promise.race([api.failure, client.failure]).then(
              () => 'child-failure',
              () => 'child-failure',
            ),
            playwrightPromise.then(() => 'playwright'),
          ])
          if (pwWinner === 'child-failure') {
            // Await forced Playwright termination before cleanup removes DB.
            try { await playwrightPromise } catch (pwErr) {
              if (pwErr?.message?.includes('process-tree termination failed')) {
                failures.addSecondary('playwright termination', pwErr)
              }
            }
            throw failures.toError() ?? new Error('Child failure')
          }
        } finally {
          // Always stop API/Vite children before database cleanup.
          try {
            await stopChildren()
          } catch (childErr) {
            failures.addSecondary('child-process termination', childErr)
          }
        }
      })
    } catch (error) {
      if (error) {
        failures.addError(error, { secondaryType: 'runner' })
      }
    }
  } finally {
    guard.dispose()
  }

  const aggregated = failures.toError()
  return {
    exitCode: computeExitCode(),
    primaryChildFailure: failures.primary,
    aggregatedError: aggregated,
    cleanupErrors: aggregated
      ? aggregated.secondaryErrors.filter(s =>
          !(guard.triggered && s.type === 'runner' && s.error?.message?.endsWith('was cancelled'))
        )
      : [],
  }

  // ── Helpers (closured) ─────────────────────────────────────────────────────

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
    const termFn = terminateChild ?? (
      process.platform === 'win32'
        ? (child) => windowsTerminateProcess(child)
        : (child) => terminateProcess(child, undefined, { useProcessGroup: true })
    )
    const results = await Promise.allSettled(
      children.reverse().map(async entry => {
        entry.markExpectedShutdown?.()
        await termFn(entry.child)
      })
    )
    const rejected = results.filter(r => r.status === 'rejected')
    if (rejected.length > 0) {
      const msg = rejected.map((r, i) => `child ${i}: ${r.reason?.message ?? r.reason}`).join('; ')
      failures.addSecondary('process termination', new Error(msg))
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
    // Any failure — primary, process termination, cleanup — causes non-zero.
    if (failures.primary || failures.secondary.length > 0) return 1
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
  if (result.aggregatedError) {
    const primaryMsg = result.aggregatedError.primary?.message ?? String(result.aggregatedError.primary ?? 'Unknown failure')
    console.error(`[e2e-local] ERROR: ${primaryMsg}`)
    for (const s of result.cleanupErrors) {
      console.error(`[e2e-local] SECONDARY [${s.type}]: ${s.error?.message ?? String(s.error)}`)
    }
  }
  process.exit(result.exitCode)
}
