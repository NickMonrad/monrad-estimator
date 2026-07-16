#!/usr/bin/env node
/**
 * Local E2E runner.
 *   - Loads server/.env and merges with shell env (shell wins).
 *   - Runs e2e-cleanup before seed so repeated runs start clean.
 *   - Starts API and Vite on dynamic ports, runs Playwright tests.
 *   - Cleans up child processes on exit.
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
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadLocalEnvironment, shutdownGuard, withIsolatedTestDatabase } from './local-postgres.mjs'
import { terminateProcess } from './terminate-process.mjs'


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

console.log(`[e2e-local] API: ${apiUrl}${apiPort === preferredApiPort ? '' : ` (preferred :${preferredApiPort} was unavailable)`}`)
console.log(`[e2e-local] Client: ${baseUrl}${clientPort === preferredClientPort ? '' : ` (preferred :${preferredClientPort} was unavailable)`}`)

try {
  await withIsolatedTestDatabase({ root }, async testEnv => {
    try {
      // ── Cleanup before seed ───────────────────────────────────────────────
      await run('npx', ['tsx', 'scripts/e2e-cleanup.ts'], { cwd: serverDir, env: testEnv })
      if (guard.triggered) return

      // ── Seed ──────────────────────────────────────────────────────────────
      await run('npx', ['tsx', 'prisma/seed.ts'], { cwd: serverDir, env: testEnv })
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

      await waitForMonradApi(apiUrl)
      if (guard.triggered) return
      await waitForClient(baseUrl)
      if (guard.triggered) return
      await waitForProxy(baseUrl)
      if (guard.triggered) return

      await run('npx', ['playwright', 'test', '--grep-invert', '@screenshots', ...process.argv.slice(2)], {
        cwd: e2eDir,
        env: testEnv,
        extraEnv: {
          BASE_URL: baseUrl,
          API_URL: apiUrl,
          NODE_ENV: 'test',
        },
        inherit: true,
      })
    } finally {
      await stopChildren()
    }
  })
} catch (error) {
  if (!guard.triggered) {
    console.error(`[e2e-local] ${error?.message ?? error}`)
    process.exitCode = 1
  }
} finally {
  guard.dispose()
  if (guard.triggered) process.exit(guard.signalExitCode)
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function start(command, args, { cwd, env, extraEnv = {}, label }) {
  const spec = resolveCommand(command, args)
  // Spawn detached so the child gets its own process group.
  // Without this, `npx` wrappers can exit while the underlying tool
  // (API/Vite) continues as an orphan with shared stdio pipes.
  const child = spawn(spec.command, spec.args, {
    cwd,
    env: { ...env, ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  })

  child.stdout.on('data', data => process.stdout.write(`[${label}] ${data}`))
  child.stderr.on('data', data => process.stderr.write(`[${label}] ${data}`))
  child.on('error', error => {
    console.error(`[${label}] failed to start: ${error.message}`)
  })
  child.on('exit', code => {
    if (code !== null && code !== 0) {
      console.error(`[${label}] exited with code ${code}`)
    }
  })

  return child
}

function run(command, args, { cwd, env, extraEnv = {}, inherit, allowFailure } = {}) {
  return new Promise((resolve, reject) => {
    const spec = resolveCommand(command, args)
    const child = spawn(spec.command, spec.args, {
      cwd,
      env: { ...env, ...extraEnv },
      stdio: inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'],
    })

    let output = ''
    if (!inherit) {
      child.stdout.on('data', data => {
        output += data.toString()
        process.stdout.write(data)
      })
      child.stderr.on('data', data => {
        output += data.toString()
        process.stderr.write(data)
      })
    }

    function onAbort() {
      child.kill('SIGTERM')
      reject(new Error(`${command} was cancelled`))
    }

    if (guard.abortSignal.aborted) {
      child.kill('SIGTERM')
      reject(new Error(`${command} was cancelled`))
      return
    }
    guard.abortSignal.addEventListener('abort', onAbort, { once: true })

    child.on('error', error => {
      guard.abortSignal.removeEventListener('abort', onAbort)
      reject(error)
    })
    child.on('exit', code => {
      guard.abortSignal.removeEventListener('abort', onAbort)
      if (code === 0 || allowFailure) resolve(output)
      else reject(new Error(`${command} ${args.join(' ')} failed with exit code ${code}`))
    })
  })
}

function resolveCommand(command, args) {
  if (process.platform === 'win32' && command === 'npx') {
    const npmCli = process.env.npm_execpath
    if (!npmCli) throw new Error('npm_execpath is required to run npx commands on Windows')
    return { command: process.execPath, args: [npmCli, 'exec', '--', ...args] }
  }
  return { command, args }
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
    const response = await fetch(`${url}/health`)
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const body = await response.json()
    if (body.status !== 'ok' || body.service !== 'monrad-estimator') {
      throw new Error(`Unexpected health payload: ${JSON.stringify(body)}`)
    }
  })
}

async function waitForClient(url) {
  await waitFor(`Vite client at ${url}`, async () => {
    const response = await fetch(url)
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const html = await response.text()
    if (!html.includes('Monrad Estimator')) throw new Error('Client HTML did not contain Monrad title')
  })
}

async function waitForProxy(url) {
  await waitFor(`Vite API proxy at ${url}/api/projects`, async () => {
    const response = await fetch(`${url}/api/projects`)
    const body = await response.json()
    if (response.status !== 401 || !['AUTH_REQUIRED', 'Unauthorized'].includes(body.code ?? body.error)) {
      throw new Error(`Unexpected proxy response ${response.status}: ${JSON.stringify(body)}`)
    }
  })
}

async function waitFor(label, check) {
  const deadline = Date.now() + 60_000
  let lastError
  while (Date.now() < deadline) {
    if (guard.abortSignal.aborted) throw new Error(`Cancelled: ${label}`)
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



async function stopChildren() {
  for (const child of children.reverse()) {
    // Windows: `taskkill /T` kills the entire job object — no early skip.
    if (process.platform === 'win32') {
      if (child.pid) {
        await run('taskkill', ['/PID', String(child.pid), '/T', '/F'], { allowFailure: true })
      }
    } else {
      // POSIX: signal the child's process group so spawned wrappers
      // (npx) that already exited do not orphan the actual tool
      // (API/Vite).  terminateProcess handles the wrapper-exit case
      // via pipe-close bounded completion.
      await terminateProcess(child, undefined, { useProcessGroup: true })
    }
  }
}
