import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { terminateProcess, windowsTerminateProcess } from './terminate-process.mjs'
import { createFailureCollector } from './aggregated-error.mjs'

const POSTGRES_PROTOCOLS = new Set(['postgres:', 'postgresql:'])
const IDENTIFIER_LIMIT = 63
const dockerCommand = runCommand
const DIAGNOSTIC_CAP = 500

/**
 * Redact credential-like values from a diagnostic text string.
 * Does not create an Error — use on captured command output before surfacing.
 */
function redactDiagnosticOutput(text) {
  return text
    .replace(/(postgres(?:ql)?:\/\/[^\s@/:]+:)[^@\s]+@/gi, '$1***@')
    .replace(/([?&])password=([^&\s]*)/gi, '$1password=***')
    .replace(/(randomBytes|base64url)[\s\S]{0,100}/gi, (m) => m.length > 48 ? m.slice(0, 24) + '***' : m)
    .slice(0, DIAGNOSTIC_CAP)
}

/**
 * Remove a Docker container by name with bounded timeout and credential-safe
 * diagnostics. Uses an independent AbortSignal.timeout so cleanup is not
 * blocked by an already-aborted primary signal.
 *
 * Returns { removed, reason?, error? } — never throws.
 * "no such container" is treated as already cleaned (removed: false, reason: 'no-such-container').
 */
export async function removeDockerContainer(name, { run = dockerCommand, env = process.env } = {}) {
  const cleanupSignal = AbortSignal.timeout(30_000)
  try {
    await run('docker', ['rm', '--force', name], { env, signal: cleanupSignal, inherit: false })
    return { removed: true }
  } catch (err) {
    const msg = err?.message ?? String(err)
    const redacted = redactDiagnosticOutput(msg)
    if (/no such container/i.test(redacted)) {
      return { removed: false, reason: 'no-such-container' }
    }
    // Detect timeout from the signal that expired.
    const timedOut = cleanupSignal.aborted && cleanupSignal.reason?.name === 'TimeoutError'
    return { removed: false, reason: timedOut ? 'cleanup-timed-out' : 'removal-failed', error: redacted }
  }
}

/**
 * Determine whether a Docker error specifically indicates daemon or socket
 * connectivity failure, as opposed to other Docker exit-code-1 failures.
 */
export function isDockerDaemonUnavailable(error) {
  if (!error) return false
  const msg = (typeof error === 'string' ? error : (error.message ?? String(error))).toLowerCase()
  // Specific daemon/socket connectivity patterns only.
  // ENOENT is classified only as a spawn/executable-not-found error from
  // runCommand's "could not start" pattern, not from arbitrary Docker output.
  const patterns = [
    /cannot connect.*docker daemon/i,
    /is the docker daemon running/i,
    /docker daemon (is not running|not running|not available)/i,
    /cannot connect to docker/i,
    /named pipe.*not found/i,
    /docker socket/i,
    /unix.*docker.*socket/i,
    /connection refused.*docker/i,
    /docker executable not found/i,
    /docker could not start.*enoent/i,
    /\.docker\.sock/i,
    /daemon is not running/i,
    /daemon not running/i,
  ]
  return patterns.some(p => p.test(msg))
}

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

export function normalizeDatabaseIdentity(urlString) {
  const parsed = parseDatabaseUrl(urlString)
  const { url, database } = parsed
  let host = url.hostname.toLowerCase()
  // Normalize local loopback aliases
  if (host === '127.0.0.1' || host === '::1' || host === '[::1]') host = 'localhost'
  const port = url.port ? Number(url.port) : 5432
  return { host, port, database }
}

export function isSameDatabase(urlA, urlB) {
  const a = normalizeDatabaseIdentity(urlA)
  const b = normalizeDatabaseIdentity(urlB)
  return a.host === b.host && a.port === b.port && a.database === b.database
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

export function runCommand(command, args, { cwd, env, extraEnv, inherit = true, platform, npmExecPath, signal, graceMs = 4_000, terminateWindows, terminatePosix } = {}) {
  if (signal?.aborted) {
    const isTimeout = signal.reason?.name === 'TimeoutError'
    const msg = isTimeout ? `${command} timed out` : `${command} was cancelled`
    return Promise.reject(new Error(msg))
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
      child.stdout.on('data', chunk => { output += chunk })
      child.stderr.on('data', chunk => { output += chunk })
    }

    function onAbort() {
      signal?.removeEventListener('abort', onAbort)
      if (settled) return
      abortRequested = true

      const isTimeout = signal?.reason?.name === 'TimeoutError'
      const cancelMsg = isTimeout ? `${command} timed out` : `${command} was cancelled`

      const isWin = (platform ?? process.platform) === 'win32'
      const termFn = isWin
        ? (terminateWindows ?? windowsTerminateProcess)
        : (terminatePosix ?? terminateProcess)
      const termPromise = isWin
        ? termFn(child)
        : termFn(child, graceMs, { useProcessGroup: true })
      termPromise.then(
        () => rejectOnce(new Error(cancelMsg)),
        (termError) => {
          const safeMsg = termError?.message ?? String(termError)
          const prefix = isTimeout ? `${command} timed out` : `${command} was cancelled`
          const err = new Error(`${prefix}; process-tree termination failed: ${safeMsg}`)
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
      if (code === 0) { resolveOnce(output); return }
      // Include bounded diagnostic output when available (non-inherit mode).
      // This lets callers distinguish failure types without seeing secrets.
      const diag = output ? redactDiagnosticOutput(output) : ''
      const hint = diag ? `: ${diag}` : ''
      rejectOnce(new Error(`${command} failed with exit code ${code}${hint}`))
    })
  })
}

async function runQuery(client, sql, values) {
  await client.query(sql, values)
}
async function defaultClientFactory(connectionString, extraOptions = {}) {
  const { Client } = await import('pg')
  return new Client({ connectionString, ...extraOptions })
}

export async function ensureDatabase({ databaseUrl, clientFactory = defaultClientFactory, signal, queryTimeout = 30_000 } = {}) {
  const { database } = parseDatabaseUrl(databaseUrl)
  const maintenanceUrl = maintenanceDatabaseUrl(databaseUrl)
  if (signal?.aborted) throw new Error('Database setup was cancelled before connecting')
  const client = await clientFactory(maintenanceUrl, { connectionTimeoutMillis: 10_000, query_timeout: queryTimeout })
  let aborted = false
  const onAbort = () => { aborted = true }
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    await client.connect()
    if (signal?.aborted) throw new Error('Database setup was cancelled after connecting')
    const result = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [database])
    if (result.rowCount === 0) {
      if (aborted) throw new Error('Database setup was cancelled before CREATE DATABASE')
      await runQuery(client, `CREATE DATABASE ${quoteIdentifier(database)}`)
    }
    return { created: result.rowCount === 0, database }
  } catch (error) {
    if (aborted) {
      // Actively close when abort fired — don't let a stale query hang.
      try {
        client.end({ timeout: 5_000 })
      } catch { /* best-effort */ }
    }
    throw redactError(error, 'Could not connect to PostgreSQL maintenance database or create the configured development database')
  } finally {
    signal?.removeEventListener('abort', onAbort)
    // Bound client shutdown — don't let a stalled end() hang the process.
    await Promise.race([
      client.end().catch(() => {}),
      new Promise(r => setTimeout(r, 5_000)),
    ])
  }
}

export function redactError(error, prefix = 'Database operation failed') {
  const message = error instanceof Error ? error.message : String(error)
  let redacted = message.replace(/(postgres(?:ql)?:\/\/[^\s@/:]+:)[^@\s]+@/gi, '$1***@')
  redacted = redacted.replace(/([?&])password=([^&\s]*)/gi, '$1password=***')
  return new Error(`${prefix}: ${redacted}`)
}

export async function preparePrisma({ root, env, run = runCommand, signal }) {
  const serverDir = path.join(root, 'server')
  await run('npx', ['prisma', 'migrate', 'deploy'], { cwd: serverDir, env, signal })
  await run('npx', ['prisma', 'generate'], { cwd: serverDir, env, signal })
}

export async function startDockerPostgres({ run = dockerCommand, random = crypto.randomUUID(), waitForPort, environment = process.env, signal } = {}) {
  if (signal?.aborted) throw new Error('Docker startup was cancelled')
  const name = createTestDatabaseName({ worktree: 'docker', random }).replace(/^monrad_test_/, 'monrad_pg_')
  const password = crypto.randomBytes(24).toString('base64url')
  const dockerEnv = { ...environment, POSTGRES_PASSWORD: password, POSTGRES_USER: 'postgres', POSTGRES_DB: 'postgres' }
  try {
    await run('docker', ['run', '--detach', '--name', name, '--env', 'POSTGRES_PASSWORD', '--env', 'POSTGRES_USER', '--env', 'POSTGRES_DB', '--publish', '127.0.0.1::5432', 'postgres:15'], { env: dockerEnv, signal, inherit: false })
  } catch (err) {
    // Attempt bounded cleanup; container may have been created despite the error.
    const cleanup = await removeDockerContainer(name, { run, env: dockerEnv })

    const dockerErr = err instanceof Error ? err : new Error(String(err))
    if (isDockerDaemonUnavailable(dockerErr)) {
      throw new Error('Docker daemon is unavailable. Docker is the default prerequisite for disposable test databases. Use MONRAD_TEST_DATABASE_URL with MONRAD_ALLOW_EXTERNAL_TEST_DATABASE=1 for an externally managed database, or start the Docker daemon.')
    }
    // If cleanup also failed, append the diagnostic.
    if (cleanup.removed === false && cleanup.reason === 'removal-failed') {
      throw redactError(dockerErr, `Docker startup failed (cleanup: ${cleanup.error})`)
    }
    throw redactError(dockerErr, 'Docker startup failed')
  }
  if (signal?.aborted) {
    const cleanup = await removeDockerContainer(name, { run, env: dockerEnv })
    if (cleanup.removed === false && cleanup.reason === 'removal-failed') {
      const err = new Error('Docker startup was cancelled')
      err.cause = cleanup.error
      throw err
    }
    throw new Error('Docker startup was cancelled')
  }
  try {
    const output = await run('docker', ['port', name, '5432/tcp'], { env: dockerEnv, inherit: false, signal })
    const match = String(output).trim().match(/:(\d+)$/)
    if (!match) {
      const cleanup = await removeDockerContainer(name, { run, env: dockerEnv })
      const err = new Error('Docker did not return a mapped PostgreSQL port')
      if (cleanup.removed === false && cleanup.reason === 'removal-failed') {
        err.message += ` (cleanup: ${cleanup.error})`
      }
      throw err
    }
    const port = Number(match[1])
    const databaseUrl = `postgresql://postgres:${encodeURIComponent(password)}@127.0.0.1:${port}/postgres`
    if (waitForPort) await waitForPort(port, databaseUrl)
    return { name, port, databaseUrl, dockerEnv }
  } catch (error) {
    // Bounded cleanup for port discovery or readiness failure.
    if (error.message.startsWith('Docker did not return') && error.message.includes('(cleanup:')) {
      throw error
    }
    if (error.message.startsWith('Docker startup was cancelled') && error.cause) {
      throw error
    }
    const cleanup = await removeDockerContainer(name, { run, env: dockerEnv })
    const preserved = error instanceof Error ? error : new Error(String(error))
    if (cleanup.removed === false && cleanup.reason === 'removal-failed') {
      preserved.message = `${preserved.message} (cleanup: ${cleanup.error})`
    }
    throw preserved
  }
}
async function waitForPostgres(databaseUrl, clientFactory, timeoutMs = 60_000, signal) {
  const deadline = Date.now() + timeoutMs
  let lastError
  while (Date.now() < deadline) {
    if (signal?.aborted) throw redactError(lastError ?? new Error('Cancelled waiting for PostgreSQL readiness'))
    let client
    try {
      client = await clientFactory(databaseUrl, { connectionTimeoutMillis: 5_000 })
      await client.connect()
      await client.query('SELECT 1')
      return
    } catch (error) {
      lastError = error
      // Abortable retry delay — removes both timer and listener on completion.
      await new Promise(resolve => {
        let onAbort
        const timer = setTimeout(() => {
          if (signal && onAbort) signal.removeEventListener('abort', onAbort)
          resolve()
        }, 500)
        if (signal) {
          onAbort = () => { clearTimeout(timer); resolve() }
          signal.addEventListener('abort', onAbort, { once: true })
        }
      })
    } finally {
      if (client) {
        try { await client.end() } catch {
          // client.end() failure must not replace primary readiness failure
        }
      }
    }
  }
  throw redactError(lastError, 'Timed out waiting for Docker PostgreSQL')
}

export async function stopDockerPostgres(container, { run = dockerCommand, environment = process.env, signal } = {}) {
  if (!container?.name) return
  const result = await removeDockerContainer(container.name, { run, env: { ...environment, ...container.dockerEnv } })
  if (result.removed) return
  if (result.reason === 'no-such-container') return
  if (result.reason === 'cleanup-timed-out') {
    throw new Error(`Docker container "${container.name}" cleanup timed out after 30s`)
  }
  throw new Error(`Failed to remove Docker container "${container.name}": ${result.error}`)
}

export async function withIsolatedTestDatabase({ root, environment = process.env, clientFactory = defaultClientFactory, run = runCommand, startDocker = startDockerPostgres, stopDocker = stopDockerPostgres, prepare = preparePrisma, signal }, action, { timeoutMs = 0 } = {}) {
  const resolvedEnvironment = loadLocalEnvironment(root, environment)
  const externalUrl = resolvedEnvironment.MONRAD_TEST_DATABASE_URL

  // Reject MONRAD_ALLOW_EXTERNAL_TEST_DATABASE=1 when no external URL is set.
  // This catches stale or accidental environment settings — the flag alone
  // must not silently select Docker mode.
  if (resolvedEnvironment.MONRAD_ALLOW_EXTERNAL_TEST_DATABASE === '1' && !externalUrl) {
    throw new Error('MONRAD_ALLOW_EXTERNAL_TEST_DATABASE=1 requires MONRAD_TEST_DATABASE_URL to be set. Without an external test URL the default Docker-first mode applies; remove MONRAD_ALLOW_EXTERNAL_TEST_DATABASE unless you intend external mode.')
  }
  // ── External mode ──────────────────────────────────────────────
  if (externalUrl) {
    if (resolvedEnvironment.MONRAD_ALLOW_EXTERNAL_TEST_DATABASE !== '1') {
      throw new Error('MONRAD_TEST_DATABASE_URL requires MONRAD_ALLOW_EXTERNAL_TEST_DATABASE=1 because migrations and cleanup are destructive')
    }
    const persistentUrl = resolvedEnvironment.DATABASE_URL
    if (!persistentUrl) {
      throw new Error('DATABASE_URL is required to validate MONRAD_TEST_DATABASE_URL isolation')
    }
    const normalizedExternal = normalizeDatabaseIdentity(externalUrl)
    try {
      const normalizedPersistent = normalizeDatabaseIdentity(persistentUrl)
      if (
        normalizedPersistent.host === normalizedExternal.host &&
        normalizedPersistent.port === normalizedExternal.port &&
        normalizedPersistent.database === normalizedExternal.database
      ) {
        throw new Error('MONRAD_TEST_DATABASE_URL must not target the same database as the persistent DATABASE_URL')
      }
    } catch (err) {
      // Re-throw if it's our own identity-match error
      if (err instanceof Error && err.message === 'MONRAD_TEST_DATABASE_URL must not target the same database as the persistent DATABASE_URL') throw err
      // Otherwise a parse or normalization failure in the persistent URL — reject
      throw new Error(`Cannot validate MONRAD_TEST_DATABASE_URL isolation: ${err instanceof Error ? err.message : String(err)}`)
    }
    if (signal?.aborted) throw new Error('Test database setup was cancelled')
    const testEnvironment = { ...resolvedEnvironment, DATABASE_URL: externalUrl, INTEGRATION_TEST: 'true' }
    await prepare({ root, env: testEnvironment, run, signal })
    if (signal?.aborted) throw new Error('Test database setup was cancelled')
    return action(testEnvironment, { external: true, databaseName: normalizedExternal.database })
  }

  // ── Docker-first default mode ──────────────────────────────────
  if (signal?.aborted) throw new Error('Test database setup was cancelled')

  let container
  const collector = createFailureCollector()

  try {
    container = await startDocker({
      run,
      environment: resolvedEnvironment,
      waitForPort: async (_port, databaseUrl) => waitForPostgres(databaseUrl, clientFactory, 60_000, signal),
      signal,
    })

    // The disposable container's built-in postgres database IS the test database.
    // No additional CREATE/DROP DATABASE is needed — container removal handles cleanup.
    const testEnvironment = { ...resolvedEnvironment, DATABASE_URL: container.databaseUrl, INTEGRATION_TEST: 'true' }

    if (signal?.aborted) {
      collector.addPrimary(new Error('Test database setup was cancelled'))
      throw collector.toError()
    }

    await prepare({ root, env: testEnvironment, run, signal })

    if (signal?.aborted) {
      collector.addPrimary(new Error('Test database setup was cancelled'))
      throw collector.toError()
    }

    return await action(testEnvironment, { external: false, docker: true })
  } catch (err) {
    collector.addPrimary(err instanceof Error ? err : new Error(String(err)))
    throw collector.toError()
  } finally {
    // Cleanup uses an independent bounded context so container removal
    // still works after the main signal has been aborted.
    if (container) {
      try {
        const cleanupSignal = AbortSignal.timeout(30_000)
        await stopDocker(container, { run, environment: resolvedEnvironment, signal: cleanupSignal })
      } catch (dockerErr) {
        const redacted = redactError(dockerErr instanceof Error ? dockerErr : new Error(String(dockerErr)), 'Docker cleanup failed')
        if (collector.primary) {
          // Action already failed — add cleanup as secondary.
          collector.addSecondary('docker cleanup', redacted)
        } else {
          // Action succeeded — cleanup failure IS the primary failure.
          collector.addPrimary(redacted)
        }
      }
    }
    // Re-throw the collector error if we have one (primary or secondary).
    // When primary is set by cleanup (action succeeded), that's the correct primary.
    const aggregated = collector.toError()
    if (aggregated) throw aggregated
  }
}
export function shutdownGuard({ process: proc = process, forceExit = (code) => { proc.exit(code) } } = {}) {
  let triggered = false
  let receivedSignal = null
  let exitCode = null
  const controller = new AbortController()

  const handler = (signal) => {
    if (triggered) {
      // Second signal: force exit immediately.
      forceExit(exitCode ?? 1)
      return
    }
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
