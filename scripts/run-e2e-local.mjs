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

// ── Environment loading ──────────────────────────────────────────────────────

const resolvedEnv = loadLocalEnvironment(root)

// ── Validation mode ──────────────────────────────────────────────────────────
// `--validate` loads and merges server/.env then exits — lets CI check the
// runner can parse without starting servers.
if (process.argv.includes('--validate')) {
  console.log(`[e2e-local] DATABASE_URL: ${resolvedEnv.DATABASE_URL ? 'set' : 'unset'}`)
  // Also validate JWT_SECRET — catches stale .env files with old placeholder
  const js = resolvedEnv.JWT_SECRET ?? ''
  if (!js || js === 'change-me-in-production' || js.length < 32) {
    console.error('[e2e-local] JWT_SECRET: INVALID (missing, too short, or placeholder)')
    process.exit(1)
  }
  console.log('[e2e-local] Validation OK')
  process.exit(0)
}

// ── Preflight checks ─────────────────────────────────────────────────────────
// Must have a valid JWT_SECRET — the API rejects the old placeholder at startup.
const jwtSecret = resolvedEnv.JWT_SECRET ?? ''
if (!jwtSecret || jwtSecret === 'change-me-in-production' || jwtSecret.length < 32) {
  console.error('[e2e-local] ERROR: JWT_SECRET is missing, too short, or still set to "change-me-in-production".')
  console.error('[e2e-local] The example env uses "local-dev-jwt-secret-at-least-32-chars!!" — copy it:')
  console.error('[e2e-local]   cp server/.env.example server/.env')
  console.error('[e2e-local] Or set a custom value of 32+ characters.')
  process.exit(1)
}

// ── Port discovery ──────────────────────────────────────────────────────────

const host = resolvedEnv.E2E_HOST ?? '127.0.0.1'
const preferredApiPort = Number(resolvedEnv.E2E_API_PORT ?? resolvedEnv.PORT ?? 3001)
const preferredClientPort = Number(resolvedEnv.E2E_CLIENT_PORT ?? 5173)
const apiPort = await findAvailablePort(preferredApiPort)
const clientPort = await findAvailablePort(preferredClientPort, new Set([apiPort]))
const apiUrl = `http://${host}:${apiPort}`
const baseUrl = `http://${host}:${clientPort}`
const children = []
const guard = shutdownGuard()
const internalAbort = new AbortController()
function makeCombinedSignal(...signals) {
  const ctrl = new AbortController()
  for (const sig of signals) sig.addEventListener('abort', () => ctrl.abort(), { once: true })
  return ctrl.signal
}
const combinedSignal = AbortSignal.any
  ? AbortSignal.any([guard.abortSignal, internalAbort.signal])
  : makeCombinedSignal(guard.abortSignal, internalAbort.signal)
let cleanupErrors = []

console.log(`[e2e-local] API: ${apiUrl}${apiPort === preferredApiPort ? '' : ` (preferred :${preferredApiPort} was unavailable)`}`)
console.log(`[e2e-local] Client: ${baseUrl}${clientPort === preferredClientPort ? '' : ` (preferred :${preferredClientPort} was unavailable)`}`)

try {
  await withIsolatedTestDatabase({ root, signal: combinedSignal }, async testEnv => {
    try {
      // ── Cleanup before seed ───────────────────────────────────────────────
      await runCommand('npx', ['tsx', 'scripts/e2e-cleanup.ts'], { cwd: serverDir, env: testEnv, signal: combinedSignal })
      if (guard.triggered) return

      // ── Seed ──────────────────────────────────────────────────────────────
      await runCommand('npx', ['tsx', 'prisma/seed.ts'], { cwd: serverDir, env: testEnv, signal: combinedSignal })
      if (guard.triggered) return

      // ── Start API ─────────────────────────────────────────────────────────
      const api = start('npx', ['tsx', 'src/index.ts'], {
        cwd: serverDir,
        env: testEnv,
        extraEnv: {
          NODE_ENV: 'test',
          PORT: String(apiPort),
          CLIENT_URL: baseUrl,
        },
        label: 'api',
      })
      children.push(api)
      if (guard.triggered) return

      // Race API readiness against child failure — whichever fires first wins.
      await Promise.race([
        waitForMonradApi(apiUrl).then(() => null),
        api.failure,
      ])
      if (guard.triggered) return

      // ── Start Vite ────────────────────────────────────────────────────────
      const client = start('npx', ['vite', '--host', host, '--port', String(clientPort), '--strictPort'], {
        cwd: clientDir,
        env: testEnv,
        extraEnv: {
          VITE_API_URL: apiUrl,
        },
        label: 'vite',
      })
      children.push(client)
      if (guard.triggered) return

      // Race client readiness against child failure.
      await Promise.race([
        waitForClient(baseUrl).then(() => null),
        client.failure,
      ])
      if (guard.triggered) return

      await waitForProxy(baseUrl)
      if (guard.triggered) return

      await runCommand('npx', ['playwright', 'test', '--grep-invert', '@screenshots', ...process.argv.slice(2)], {
        cwd: e2eDir,
        env: testEnv,
        extraEnv: {
          BASE_URL: baseUrl,
          API_URL: apiUrl,
          NODE_ENV: 'test',
        },
        inherit: true,
        signal: combinedSignal,
      })
    } finally {
      // Always stop API/Vite children before database cleanup.
      try {
        await stopChildren()
      } catch (childErr) {
        cleanupErrors.push({ type: 'child-process termination', error: String(childErr) })
      }
    }
  })
} catch (error) {
  cleanupErrors.push({ type: 'runner', error: error?.message ?? String(error) })
} finally {
  guard.dispose()
}

// ── Report and exit ─────────────────────────────────────────────────────────

for (const ce of cleanupErrors) {
  if (guard.triggered && ce.type === 'runner' && ce.error.endsWith('was cancelled')) continue
  console.error(`[e2e-local] ${ce.type}: ${ce.error}`)
}

if (guard.triggered) {
  process.exitCode = guard.signalExitCode
} else if (cleanupErrors.length > 0) {
  process.exitCode = 1
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function start(command, args, { cwd, env, extraEnv = {}, label }) {
  const spec = resolveCommand(command, args)
  // Spawn detached so the child gets its own process group.
  // On POSIX, `detached: true` creates a new group; on Windows,
  // `detached: false` keeps it in the caller's job object.
  const child = spawn(spec.command, spec.args, {
    cwd,
    env: { ...env, ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  })

  child.stdout.on('data', data => process.stdout.write(`[${label}] ${data}`))
  child.stderr.on('data', data => process.stderr.write(`[${label}] ${data}`))

  let expectedShutdown = false

  const failure = new Promise((_, reject) => {
    child.on('error', err => {
      if (!expectedShutdown) {
        console.error(`[${label}] failed to start: ${err.message}`)
        reject(new Error(`${label} could not start: ${err.message}`))
      }
    })
    // ANY unexpected exit (including code 0) is a failure — the child should
    // run until explicitly shut down (markExpectedShutdown).
    child.on('exit', code => {
      if (!expectedShutdown) {
        console.error(`[${label}] exited unexpectedly with code ${code}`)
        reject(new Error(`${label} exited unexpectedly with code ${code}`))
      }
    })
  })

  // Suppress unhandled rejection: callers race failure against readiness checks
  // so the failure is surfaced through the race, not through a global rejection.
  failure.catch(() => {})

  return { child, failure, markExpectedShutdown: () => { expectedShutdown = true } }
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
  const failures = results.filter(r => r.status === 'rejected')
  if (failures.length > 0) {
    const messages = failures.map((r, i) => `child ${i}: ${r.reason?.message ?? r.reason}`).join('; ')
    throw new Error(`Process termination failed: ${messages}`)
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
    try {
      const response = await fetch(`${url}/health`, { signal: controller.signal })
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
    try {
      const response = await fetch(url, { signal: controller.signal })
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
    try {
      const response = await fetch(`${url}/api/projects`, { signal: controller.signal })
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
    if (combinedSignal.aborted) throw new Error(`Cancelled: ${label}`)
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
