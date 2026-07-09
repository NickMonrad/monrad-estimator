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
import fs from 'node:fs'
import net from 'node:net'
import { fileURLToPath } from 'node:url'


const root = fileURLToPath(new URL('..', import.meta.url))
const serverDir = fileURLToPath(new URL('../server/', import.meta.url))
const clientDir = fileURLToPath(new URL('../client/', import.meta.url))
const e2eDir = fileURLToPath(new URL('../e2e/', import.meta.url))

// ── Environment loading ──────────────────────────────────────────────────────

/** Read and parse server/.env, return a plain object. */
function loadDotEnv() {
  const envPath = fileURLToPath(new URL('server/.env', root))
  let raw
  try {
    raw = fs.readFileSync(envPath, 'utf8')
  } catch {
    // server/.env missing — that's fine, use process.env only
    return {}
  }

  const parsed = {}
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue

    // Strip optional `export ` prefix
    const cleaned = trimmed.startsWith('export ') ? trimmed.slice(7).trimStart() : trimmed

    const sepIdx = cleaned.indexOf('=')
    if (sepIdx <= 0) continue

    const key = cleaned.slice(0, sepIdx).trim()
    if (!key) continue

    let value = cleaned.slice(sepIdx + 1).trim()

    // Unwrap matching quotes (single or double)
    if ((value.startsWith("'") && value.endsWith("'")) ||
        (value.startsWith('"') && value.endsWith('"'))) {
      value = value.slice(1, -1)
    }

    parsed[key] = value
  }

  return parsed
}

/** Merged env: file values first, shell env wins. */
const fileEnv = loadDotEnv()
const resolvedEnv = { ...fileEnv, ...process.env }

// ── Port discovery ──────────────────────────────────────────────────────────

const host = process.env.E2E_HOST ?? '127.0.0.1'
const preferredApiPort = Number(process.env.E2E_API_PORT ?? process.env.PORT ?? 3001)
const preferredClientPort = Number(process.env.E2E_CLIENT_PORT ?? 5173)
const apiPort = await findAvailablePort(preferredApiPort)
const clientPort = await findAvailablePort(preferredClientPort, new Set([apiPort]))
const apiUrl = `http://${host}:${apiPort}`
const baseUrl = `http://${host}:${clientPort}`
const children = []

console.log(`[e2e-local] API: ${apiUrl}${apiPort === preferredApiPort ? '' : ` (preferred :${preferredApiPort} was unavailable)`}`)
console.log(`[e2e-local] Client: ${baseUrl}${clientPort === preferredClientPort ? '' : ` (preferred :${preferredClientPort} was unavailable)`}`)

try {
  // ── Prisma ──────────────────────────────────────────────────────────────
  await run('npx', ['prisma', 'migrate', 'deploy'], { cwd: serverDir, env: resolvedEnv })
  await run('npx', ['prisma', 'generate'], { cwd: serverDir, env: resolvedEnv })

  // ── Cleanup before seed ─────────────────────────────────────────────────
  await run('npx', ['tsx', 'scripts/e2e-cleanup.ts'], { cwd: serverDir, env: resolvedEnv })

  // ── Seed ────────────────────────────────────────────────────────────────
  await run('npx', ['tsx', 'prisma/seed.ts'], { cwd: serverDir, env: resolvedEnv })

  // ── Start API ───────────────────────────────────────────────────────────
  const api = start('npx', ['tsx', 'src/index.ts'], {
    cwd: serverDir,
    env: resolvedEnv,
    extraEnv: {
      NODE_ENV: 'test',
      PORT: String(apiPort),
      CLIENT_URL: baseUrl,
    },
    label: 'api',
  })
  children.push(api)

  // ── Start Vite ──────────────────────────────────────────────────────────
  const client = start('npx', ['vite', '--host', host, '--port', String(clientPort), '--strictPort'], {
    cwd: clientDir,
    env: resolvedEnv,
    extraEnv: {
      VITE_API_URL: apiUrl,
    },
    label: 'vite',
  })
  children.push(client)

  // ── Wait for services ───────────────────────────────────────────────────
  await waitForMonradApi(apiUrl)
  await waitForClient(baseUrl)
  await waitForProxy(baseUrl)

  // ── Playwright ──────────────────────────────────────────────────────────
  await run('npx', ['playwright', 'test', '--grep-invert', '@screenshots', ...process.argv.slice(2)], {
    cwd: e2eDir,
    env: resolvedEnv,
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

// ── Helpers ──────────────────────────────────────────────────────────────────

function start(command, args, { cwd, env, extraEnv = {}, label }) {
  const spec = resolveCommand(command, args)
  const child = spawn(spec.command, spec.args, {
    cwd,
    env: { ...env, ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
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
    child.on('error', reject)

    child.on('exit', code => {
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
    if (child.killed) continue
    if (process.platform === 'win32' && child.pid) {
      await run('taskkill', ['/PID', String(child.pid), '/T', '/F'], { allowFailure: true })
    } else {
      child.kill('SIGTERM')
    }
  }
  await new Promise(resolve => setTimeout(resolve, 1_000))
}
