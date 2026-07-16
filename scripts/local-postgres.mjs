import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { terminateProcess, windowsTerminateProcess } from './terminate-process.mjs'

const POSTGRES_PROTOCOLS = new Set(['postgres:', 'postgresql:'])
const IDENTIFIER_LIMIT = 63

export function readEnvFile(filename) {
  if (!fs.existsSync(filename)) return {}
  const values = {}
  for (const rawLine of fs.readFileSync(filename, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const cleaned = line.startsWith('export ') ? line.slice(7).trimStart() : line
    const match = cleaned.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
    if (!match) continue
    let value = match[2].trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    values[match[1]] = value
  }
  return values
}

export function loadLocalEnvironment(root, shellEnvironment = process.env) {
  const envFile = shellEnvironment.MONRAD_ENV_FILE ?? path.join(root, 'server', '.env')
  return { ...readEnvFile(envFile), ...shellEnvironment }
}

export function redactDatabaseUrl(value) {
  try {
    const url = new URL(value)
    if (url.password) url.password = '***'
    if (url.searchParams.has('password')) url.searchParams.set('password', '***')
    return url.toString()
  } catch {
    return '[invalid database URL]'
  }
}

export function parseDatabaseUrl(value) {
  let url
  try {
    url = new URL(value)
  } catch {
    throw new Error('DATABASE_URL must be a valid PostgreSQL connection URL')
  }
  if (!POSTGRES_PROTOCOLS.has(url.protocol)) throw new Error('DATABASE_URL must use postgres:// or postgresql://')
  const database = decodeURIComponent(url.pathname.replace(/^\//, ''))
  if (!database) throw new Error('DATABASE_URL must include a database name')
  return { url, database }
}

export function withDatabaseName(value, database) {
  assertSafeIdentifier(database)
  const { url } = parseDatabaseUrl(value)
  url.pathname = `/${encodeURIComponent(database)}`
  return url.toString()
}

export function maintenanceDatabaseUrl(value) {
  return withDatabaseName(value, 'postgres')
}

export function assertSafeIdentifier(name) {
  if (!/^[a-z_][a-z0-9_]*$/.test(name) || Buffer.byteLength(name) > IDENTIFIER_LIMIT) {
    throw new Error(`PostgreSQL identifier must be lowercase letters, digits, or underscores; maximum ${IDENTIFIER_LIMIT} bytes`)
  }
  return name
}

export function quoteIdentifier(name) {
  if (!name || typeof name !== 'string') {
    throw new Error('PostgreSQL identifier must be a non-empty string')
  }
  if (Buffer.byteLength(name) > IDENTIFIER_LIMIT) {
    throw new Error(`PostgreSQL identifier exceeds ${IDENTIFIER_LIMIT} bytes`)
  }
  return `"${name.replace(/"/g, '""')}"`
}

export function createTestDatabaseName({ worktree = process.cwd(), pid = process.pid, random = crypto.randomUUID() } = {}) {
  const suffix = crypto.createHash('sha256').update(`${worktree}:${pid}:${random}`).digest('hex').slice(0, 16)
  const stem = path.basename(worktree).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'worktree'
  return `monrad_test_${stem.slice(0, 34)}_${suffix}`.slice(0, IDENTIFIER_LIMIT)
}

export function resolveCommand(command, args, platform = process.platform, npmExecPath = process.env.npm_execpath) {
  if (platform !== 'win32') return { command, args }
  if (command === 'npm') {
    if (!npmExecPath) throw new Error('npm_execpath is required to run npm commands on Windows')
    return { command: process.execPath, args: [npmExecPath, ...args] }
  }
  if (command === 'npx') {
    if (!npmExecPath) throw new Error('npm_execpath is required to run npx commands on Windows')
    return { command: process.execPath, args: [npmExecPath, 'exec', '--', ...args] }
  }
  return { command, args }
}

export function runCommand(command, args, { cwd, env, extraEnv, inherit = true, platform, npmExecPath, signal, graceMs = 4_000 } = {}) {
  if (signal?.aborted) {
    return Promise.reject(new Error(`${command} was cancelled`))
  }
  return new Promise((resolve, reject) => {
    let settled = false
    let abortRequested = false
    const resolveOnce = (value) => { if (!settled) { settled = true; resolve(value) } }
    const rejectOnce = (reason) => { if (!settled) { settled = true; reject(reason) } }

    const spec = resolveCommand(command, args, platform, npmExecPath)
    const mergedEnv = extraEnv ? { ...env, ...extraEnv } : env
    const child = spawn(spec.command, spec.args, { cwd, env: mergedEnv, shell: false, stdio: inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' })
    let output = ''
    if (!inherit) {
      child.stdout.on('data', chunk => { output += chunk; process.stdout.write(chunk) })
      child.stderr.on('data', chunk => { output += chunk; process.stderr.write(chunk) })
    }

    function onAbort() {
      signal?.removeEventListener('abort', onAbort)
      if (settled) return
      abortRequested = true

      const isWin = (platform ?? process.platform) === 'win32'
      const termPromise = isWin
        ? windowsTerminateProcess(child)
        : terminateProcess(child, graceMs, { useProcessGroup: true })
      termPromise.then(
        () => rejectOnce(new Error(`${command} was cancelled`)),
        (termError) => {
          const safeMsg = termError?.message ?? String(termError)
          const err = new Error(`${command} was cancelled; process-tree termination failed: ${safeMsg}`)
          err.cause = termError
          rejectOnce(err)
        },
      )
    }

    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true })
    }

    child.once('error', error => {
      signal?.removeEventListener('abort', onAbort)
      if (abortRequested) return
      rejectOnce(new Error(`${command} could not start: ${error.message}`))
    })
    child.once('exit', code => {
      signal?.removeEventListener('abort', onAbort)
      if (abortRequested) return
      code === 0 ? resolveOnce(output) : rejectOnce(new Error(`${command} failed with exit code ${code}`))
    })
  })
}
async function defaultClientFactory(connectionString) {
  const { Client } = await import('pg')
  return new Client({ connectionString })
}

async function runQuery(client, sql, values) {
  await client.query(sql, values)
}

export async function ensureDatabase({ databaseUrl, clientFactory = defaultClientFactory }) {
  const { database } = parseDatabaseUrl(databaseUrl)
  const maintenanceUrl = maintenanceDatabaseUrl(databaseUrl)
  const client = await clientFactory(maintenanceUrl)
  try {
    await client.connect()
    const result = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [database])
    if (result.rowCount === 0) await runQuery(client, `CREATE DATABASE ${quoteIdentifier(database)}`)
    return { created: result.rowCount === 0, database }
  } catch (error) {
    throw redactError(error, 'Could not connect to PostgreSQL maintenance database or create the configured development database')
  } finally {
    await client.end().catch(() => {})
  }
}

export function redactError(error, prefix = 'Database operation failed') {
  const message = error instanceof Error ? error.message : String(error)
  let redacted = message.replace(/(postgres(?:ql)?:\/\/[^\s@/:]+:)[^@\s]+@/gi, '$1***@')
  redacted = redacted.replace(/([?&])password=([^&\s]*)/gi, '$1password=***')
  return new Error(`${prefix}: ${redacted}`)
}

export async function preparePrisma({ root, env, run = runCommand }) {
  const serverDir = path.join(root, 'server')
  await run('npx', ['prisma', 'migrate', 'deploy'], { cwd: serverDir, env })
  await run('npx', ['prisma', 'generate'], { cwd: serverDir, env })
}

async function terminateAndDrop({ maintenanceUrl, databaseName, clientFactory }) {
  const client = await clientFactory(maintenanceUrl)
  try {
    await client.connect()
    await client.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()', [databaseName])
    await client.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)}`)
  } finally {
    await client.end().catch(() => {})
  }
}

function dockerCommand(command, args, options) {
  return runCommand(command, args, options)
}

export async function startDockerPostgres({ run = dockerCommand, random = crypto.randomUUID(), waitForPort, environment = process.env } = {}) {
  const name = createTestDatabaseName({ worktree: 'docker', random }).replace(/^monrad_test_/, 'monrad_pg_')
  const password = crypto.randomBytes(24).toString('base64url')
  const dockerEnv = { ...environment, POSTGRES_PASSWORD: password, POSTGRES_USER: 'postgres', POSTGRES_DB: 'postgres' }
  await run('docker', ['run', '--detach', '--name', name, '--env', 'POSTGRES_PASSWORD', '--env', 'POSTGRES_USER', '--env', 'POSTGRES_DB', '--publish', '127.0.0.1::5432', 'postgres:15'], { env: dockerEnv })
  try {
    const output = await run('docker', ['port', name, '5432/tcp'], { env: dockerEnv, inherit: false })
    const match = String(output).trim().match(/:(\d+)$/)
    if (!match) throw new Error('Docker did not return a mapped PostgreSQL port')
    const port = Number(match[1])
    const databaseUrl = `postgresql://postgres:${encodeURIComponent(password)}@127.0.0.1:${port}/postgres`
    if (waitForPort) await waitForPort(port, databaseUrl)
    return { name, port, databaseUrl, dockerEnv }
  } catch (error) {
    await run('docker', ['rm', '--force', name], { env: dockerEnv }).catch(() => {})
    throw error
  }
}

export async function stopDockerPostgres(container, { run = dockerCommand, environment = process.env } = {}) {
  if (container?.name) await run('docker', ['rm', '--force', container.name], { env: { ...environment, ...container.dockerEnv } })
}

async function waitForPostgres(databaseUrl, clientFactory, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  let lastError
  while (Date.now() < deadline) {
    const client = await clientFactory(databaseUrl)
    try {
      await client.connect()
      await client.query('SELECT 1')
      return
    } catch (error) {
      lastError = error
      await new Promise(resolve => setTimeout(resolve, 500))
    } finally {
      await client.end().catch(() => {})
    }
  }
  throw redactError(lastError, 'Timed out waiting for Docker PostgreSQL')
}

export async function withIsolatedTestDatabase({ root, environment = process.env, clientFactory = defaultClientFactory, run = runCommand, startDocker = startDockerPostgres, stopDocker = stopDockerPostgres, prepare = preparePrisma }, action) {
  const resolvedEnvironment = loadLocalEnvironment(root, environment)
  const externalUrl = resolvedEnvironment.MONRAD_TEST_DATABASE_URL
  if (externalUrl) {
    if (resolvedEnvironment.MONRAD_ALLOW_EXTERNAL_TEST_DATABASE !== '1') {
      throw new Error('MONRAD_TEST_DATABASE_URL requires MONRAD_ALLOW_EXTERNAL_TEST_DATABASE=1 because migrations and cleanup are destructive')
    }
    parseDatabaseUrl(externalUrl)
    const testEnvironment = { ...resolvedEnvironment, DATABASE_URL: externalUrl, INTEGRATION_TEST: 'true' }
    await prepare({ root, env: testEnvironment, run })
    return action(testEnvironment, { external: true, databaseName: parseDatabaseUrl(externalUrl).database })
  }

  const configuredUrl = resolvedEnvironment.DATABASE_URL
  if (!configuredUrl) throw new Error('DATABASE_URL is required; configure server/.env, MONRAD_ENV_FILE, or the shell environment')
  parseDatabaseUrl(configuredUrl)
  let container
  let maintenanceUrl
  let databaseName
  let actionError
  try {
    try {
      maintenanceUrl = maintenanceDatabaseUrl(configuredUrl)
      const client = await clientFactory(maintenanceUrl)
      await client.connect()
      await client.end()
    } catch (hostError) {
      try {
        container = await startDocker({ run, environment: resolvedEnvironment, waitForPort: async (_port, databaseUrl) => waitForPostgres(databaseUrl, clientFactory) })
        maintenanceUrl = maintenanceDatabaseUrl(container.databaseUrl)
      } catch (dockerError) {
        throw redactError(dockerError, 'Host PostgreSQL is unavailable and Docker fallback could not start')
      }
    }
    databaseName = createTestDatabaseName({ worktree: root })
    const targetUrl = withDatabaseName(maintenanceUrl, databaseName)
    const client = await clientFactory(maintenanceUrl)
    try {
      await client.connect()
      await client.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`)
    } finally {
      await client.end().catch(() => {})
    }
    const testEnvironment = { ...resolvedEnvironment, DATABASE_URL: targetUrl, INTEGRATION_TEST: 'true' }
    await prepare({ root, env: testEnvironment, run })
    return await action(testEnvironment, { external: false, databaseName, docker: Boolean(container) })
  } catch (err) {
    actionError = err instanceof Error ? err : new Error(String(err))
    throw actionError
  } finally {
    const cleanupErrors = []
    if (databaseName && maintenanceUrl) {
      try {
        await terminateAndDrop({ maintenanceUrl, databaseName, clientFactory })
      } catch (dbErr) {
        cleanupErrors.push(redactError(dbErr, 'Database cleanup failed'))
      }
    }
    if (container) {
      try {
        await stopDocker(container, { run, environment: resolvedEnvironment })
      } catch (dockerErr) {
        cleanupErrors.push(redactError(dockerErr, 'Docker cleanup failed'))
      }
    }
    if (cleanupErrors.length > 0) {
      const combinedMessages = cleanupErrors.map(e => e.message).join('; ')
      if (actionError) {
        actionError.message = `${actionError.message} (cleanup: ${combinedMessages})`
      } else {
        throw new Error(`Cleanup failed: ${combinedMessages}`)
      }
    }
  }
}

export function shutdownGuard({ process: proc = process } = {}) {
  let triggered = false
  let receivedSignal = null
  let exitCode = null
  const controller = new AbortController()

  const handler = (signal) => {
    if (triggered) return
    triggered = true
    receivedSignal = signal
    exitCode = signal === 'SIGINT' ? 130 : 143
    proc.exitCode = exitCode
    controller.abort()
  }

  proc.on('SIGINT', handler)
  proc.on('SIGTERM', handler)

  return {
    get triggered() { return triggered },
    get signal() { return receivedSignal },
    get signalExitCode() { return exitCode },
    abortSignal: controller.signal,
    dispose() {
      proc.off('SIGINT', handler)
      proc.off('SIGTERM', handler)
    },
    /** @internal exposed for deterministic testing */
    _handler: handler,
  }
}
