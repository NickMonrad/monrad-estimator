#!/usr/bin/env node
/**
 * Local E2E runner.
 *
 * Starts isolated API + Vite dev servers, validates that the API is actually
 * Monrad Estimator (not another service on the same port), then runs Playwright.
 */
import { spawn } from 'node:child_process'
import net from 'node:net'
import { fileURLToPath } from 'node:url'


const root = fileURLToPath(new URL('..', import.meta.url))
const serverDir = fileURLToPath(new URL('../server/', import.meta.url))
const clientDir = fileURLToPath(new URL('../client/', import.meta.url))
const e2eDir = fileURLToPath(new URL('../e2e/', import.meta.url))

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
  await run('npx', ['prisma', 'migrate', 'deploy'], { cwd: serverDir })
  await run('npx', ['prisma', 'generate'], { cwd: serverDir })
  await run('npx', ['tsx', 'prisma/seed.ts'], { cwd: serverDir })

  const api = start('npx', ['tsx', 'src/index.ts'], {
    cwd: serverDir,
    env: {
      NODE_ENV: 'test',
      PORT: String(apiPort),
      CLIENT_URL: baseUrl,
    },
    label: 'api',
  })
  children.push(api)

  const client = start('npx', ['vite', '--host', host, '--port', String(clientPort), '--strictPort'], {
    cwd: clientDir,
    env: {
      VITE_API_URL: apiUrl,
    },
    label: 'vite',
  })
  children.push(client)

  await waitForMonradApi(apiUrl)
  await waitForClient(baseUrl)
  await waitForProxy(baseUrl)

  await run('npx', ['playwright', 'test', '--grep-invert', '@screenshots', ...process.argv.slice(2)], {
    cwd: e2eDir,
    env: {
      BASE_URL: baseUrl,
      API_URL: apiUrl,
      NODE_ENV: 'test',
    },
    inherit: true,
  })
} finally {
  await stopChildren()
}

function start(command, args, options) {
  const spec = resolveCommand(command, args)
  const child = spawn(spec.command, spec.args, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  child.stdout.on('data', data => process.stdout.write(`[${options.label}] ${data}`))
  child.stderr.on('data', data => process.stderr.write(`[${options.label}] ${data}`))
  child.on('error', error => {
    console.error(`[${options.label}] failed to start: ${error.message}`)
  })
  child.on('exit', code => {
    if (code !== null && code !== 0) {
      console.error(`[${options.label}] exited with code ${code}`)
    }
  })

  return child
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const spec = resolveCommand(command, args)
    const child = spawn(spec.command, spec.args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: options.inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'],
    })

    let output = ''
    if (!options.inherit) {
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
      if (code === 0 || options.allowFailure) resolve(output)
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
