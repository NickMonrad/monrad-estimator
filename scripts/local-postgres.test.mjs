import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  createTestDatabaseName,
  ensureDatabase,
  isDockerDaemonUnavailable,
  loadLocalEnvironment,
  maintenanceDatabaseUrl,
  normalizeDatabaseIdentity,
  isSameDatabase,
  parseDatabaseUrl,
  preparePrisma,
  redactDatabaseUrl,
  resolveCommand,
  startDockerPostgres,
  stopDockerPostgres,
  waitForPostgres,
  withDatabaseName,
  withIsolatedTestDatabase,
  redactError,
  quoteIdentifier,
  runCommand,
  shutdownGuard,
} from './local-postgres.mjs'

const developmentUrl = 'postgresql://developer:secret@localhost:5432/development_db?sslmode=disable'

function fakeClientFactory(queries) {
  return async () => ({
    async connect() {},
    async query(sql, values) {
      queries.push({ sql, values })
      if (sql.startsWith('SELECT 1 FROM pg_database')) return { rowCount: 0 }
      return { rowCount: 1 }
    },
    async end() {},
  })
}

test('loads quoted env values while the shell overrides the file', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'monrad-env-'))
  fs.mkdirSync(path.join(root, 'server'))
  fs.writeFileSync(path.join(root, 'server', '.env'), 'DATABASE_URL="postgresql://file:secret@localhost/file_db"\nQUOTED=\'value\'\n')
  assert.deepEqual(loadLocalEnvironment(root, { DATABASE_URL: 'postgresql://shell:secret@localhost/shell_db' }).DATABASE_URL, 'postgresql://shell:secret@localhost/shell_db')
  assert.equal(loadLocalEnvironment(root, {}).QUOTED, 'value')
  fs.rmSync(root, { recursive: true, force: true })
})

test('derives maintenance and target URLs without mutating development URL', () => {
  assert.equal(maintenanceDatabaseUrl(developmentUrl), 'postgresql://developer:secret@localhost:5432/postgres?sslmode=disable')
  assert.equal(withDatabaseName(developmentUrl, 'monrad_test_safe'), 'postgresql://developer:secret@localhost:5432/monrad_test_safe?sslmode=disable')
  assert.equal(developmentUrl, 'postgresql://developer:secret@localhost:5432/development_db?sslmode=disable')
})

test('normalizeDatabaseIdentity handles scheme aliases and default port', () => {
  const a = normalizeDatabaseIdentity('postgresql://u:p@localhost/mydb')
  const b = normalizeDatabaseIdentity('postgres://u@localhost:5432/mydb')
  assert.deepEqual(a, { host: 'localhost', port: 5432, database: 'mydb' })
  assert.deepEqual(b, { host: 'localhost', port: 5432, database: 'mydb' })
})

test('normalizeDatabaseIdentity handles loopback aliases', () => {
  const localhost = normalizeDatabaseIdentity('postgresql://u:p@localhost/db')
  const ipv4 = normalizeDatabaseIdentity('postgresql://u:p@127.0.0.1/db')
  const ipv6 = normalizeDatabaseIdentity('postgresql://u:p@[::1]/db')
  assert.equal(localhost.host, 'localhost')
  assert.equal(ipv4.host, 'localhost')
  assert.equal(ipv6.host, 'localhost')
})


test('isSameDatabase missing persistent DATABASE_URL fails closed', async () => {
  await assert.rejects(
    withIsolatedTestDatabase({
      root: process.cwd(),
      environment: {
        MONRAD_TEST_DATABASE_URL: 'postgresql://tester:secret@localhost/test_db',
        MONRAD_ALLOW_EXTERNAL_TEST_DATABASE: '1',
      },
    }, async () => {}),
    /DATABASE_URL is required to validate MONRAD_TEST_DATABASE_URL isolation/,
  )
})

test('isSameDatabase external URL rejected when it matches persistent URL', async () => {
  await assert.rejects(
    withIsolatedTestDatabase({
      root: process.cwd(),
      environment: {
        DATABASE_URL: 'postgresql://user:pass@localhost:5432/monrad_estimator',
        MONRAD_TEST_DATABASE_URL: 'postgresql://other:creds@127.0.0.1:5432/monrad_estimator?sslmode=require',
        MONRAD_ALLOW_EXTERNAL_TEST_DATABASE: '1',
      },
    }, async () => {}),
    /must not target the same database/,
  )
})

test('normalizeDatabaseIdentity throws on invalid URL', () => {
  assert.throws(() => normalizeDatabaseIdentity('not-a-url'), /valid PostgreSQL connection URL/)
})

test('normalizeDatabaseIdentity throws on unsupported protocol', () => {
  assert.throws(() => normalizeDatabaseIdentity('mysql://u:p@localhost/db'), /must use postgres/)
})

test('normalizeDatabaseIdentity throws on missing database name', () => {
  assert.throws(() => normalizeDatabaseIdentity('postgresql://u:p@localhost/'), /must include a database name/)
})

test('isSameDatabase throws on invalid persistent URL', () => {
  assert.throws(() => isSameDatabase('not-a-url', 'postgresql://u:p@localhost/db'), /valid PostgreSQL connection URL/)
})

test('isSameDatabase throws on invalid external URL', () => {
  assert.throws(() => isSameDatabase('postgresql://u:p@localhost/db', 'not-a-url'), /valid PostgreSQL connection URL/)
})

test('isSameDatabase identical with different credentials', () => {
  assert.ok(isSameDatabase('postgresql://a:1@localhost/x', 'postgresql://b:2@localhost/x'))
})

test('isSameDatabase ignores irrelevant query parameters', () => {
  assert.ok(isSameDatabase('postgresql://u:p@localhost/db', 'postgresql://u:p@localhost/db?sslmode=disable'))
})

test('isSameDatabase handles URL-encoded database names', () => {
  assert.ok(isSameDatabase('postgresql://u:p@localhost/test%20db', 'postgresql://u:p@localhost/test db'))
})

test('isSameDatabase ignores hostname case', () => {
  assert.ok(isSameDatabase('postgresql://u:p@LOCALHOST/db', 'postgresql://u:p@localhost/db'))
})

test('isSameDatabase different databases are different', () => {
  assert.equal(isSameDatabase('postgresql://u:p@localhost/a', 'postgresql://u:p@localhost/b'), false)
})

test('isSameDatabase different hosts are different', () => {
  assert.equal(isSameDatabase('postgresql://u:p@host1/x', 'postgresql://u:p@host2/x'), false)
})

test('withIsolatedTestDatabase rejects ALLOW_EXTERNAL without TEST_URL', async () => {
  await assert.rejects(
    withIsolatedTestDatabase({
      root: process.cwd(),
      environment: {
        DATABASE_URL: 'postgresql://u:p@localhost/persistent',
        MONRAD_ALLOW_EXTERNAL_TEST_DATABASE: '1',
      },
    }, async () => {}),
    /MONRAD_ALLOW_EXTERNAL_TEST_DATABASE=1 requires MONRAD_TEST_DATABASE_URL/,
  )
})

test('withIsolatedTestDatabase rejects invalid persistent URL in external mode', async () => {
  await assert.rejects(
    withIsolatedTestDatabase({
      root: process.cwd(),
      environment: {
        DATABASE_URL: 'not-a-valid-url',
        MONRAD_TEST_DATABASE_URL: 'postgresql://tester:secret@localhost/test_db',
        MONRAD_ALLOW_EXTERNAL_TEST_DATABASE: '1',
      },
    }, async () => {}),
    /Cannot validate MONRAD_TEST_DATABASE_URL isolation/,
  )
})

test('withIsolatedTestDatabase rejects external URL that matches persistent URL', async () => {
  await assert.rejects(
    withIsolatedTestDatabase({
      root: process.cwd(),
      environment: {
        DATABASE_URL: 'postgresql://user:pass@localhost:5432/monrad_estimator',
        MONRAD_TEST_DATABASE_URL: 'postgresql://other:creds@127.0.0.1:5432/monrad_estimator?sslmode=require',
        MONRAD_ALLOW_EXTERNAL_TEST_DATABASE: '1',
      },
    }, async () => {}),
    /must not target the same database/,
  )
})

test('generates unique PostgreSQL-safe test names within limits', () => {
  const first = createTestDatabaseName({ worktree: '/tmp/very-long-worktree-name-with-unsafe-characters!!!', pid: 1, random: 'one' })
  const second = createTestDatabaseName({ worktree: '/tmp/another-worktree', pid: 2, random: 'two' })
  assert.match(first, /^[a-z_][a-z0-9_]*$/)
  assert.ok(Buffer.byteLength(first) <= 63)
  assert.notEqual(first, second)
})

test('creates a missing configured development database through maintenance connection', async () => {
  const queries = []
  const result = await ensureDatabase({ databaseUrl: developmentUrl, clientFactory: fakeClientFactory(queries) })
  assert.equal(result.created, true)
  assert.match(queries[0].sql, /pg_database/)
  assert.match(queries[1].sql, /CREATE DATABASE "development_db"/)
})

test('redacts credentials from URLs and errors', () => {
  assert.equal(redactDatabaseUrl(developmentUrl), 'postgresql://developer:***@localhost:5432/development_db?sslmode=disable')
  assert.throws(() => parseDatabaseUrl('mysql://user:secret@localhost/db'), /postgres/)
})

test('uses Windows npx command adaptation without shell strings', () => {
  const command = resolveCommand('npx', ['prisma', 'generate'], 'win32', 'C:/npm-cli.js')
  assert.deepEqual(command, { command: process.execPath, args: ['C:/npm-cli.js', 'exec', '--', 'prisma', 'generate'] })
})

test('constructs Docker commands with a dynamic port and removes the container', async () => {
  const calls = []
  const run = async (command, args) => {
    calls.push({ command, args })
    if (args[0] === 'port') return '127.0.0.1:49152\n'
    return ''
  }
  const container = await startDockerPostgres({ run, random: 'docker-test', waitForPort: async port => assert.equal(port, 49152) })
  assert.equal(container.port, 49152)
  assert.match(container.name, /^monrad_pg_/)
  assert.deepEqual(calls[0].args.slice(0, 12), ['run', '--detach', '--name', container.name, '--env', 'POSTGRES_PASSWORD', '--env', 'POSTGRES_USER', '--env', 'POSTGRES_DB', '--publish', '127.0.0.1::5432'])
  assert.equal(calls[0].args[12], 'postgres:15')
  await stopDockerPostgres(container, { run })
  assert.deepEqual(calls.at(-1).args, ['rm', '--force', container.name])
})

// ── Docker error classification ──────────────────────────────────────────

test('isDockerDaemonUnavailable detects daemon connectivity failure on Unix', () => {
  const err = new Error('Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?')
  assert.ok(isDockerDaemonUnavailable(err))
})

test('isDockerDaemonUnavailable detects daemon connectivity failure on Windows named pipe', () => {
  const err = new Error('error during connect: this error may indicate that the docker daemon is not running.: docker named pipe not found')
  assert.ok(isDockerDaemonUnavailable(err))
})

test('isDockerDaemonUnavailable does NOT classify Docker CLI "command not found" as daemon failure', () => {
  // Docker is running but the subcommand doesn't exist — NOT daemon unavailable.
  assert.equal(isDockerDaemonUnavailable(new Error('docker: \'foo\' is not a docker command.\nSee \'docker --help\'')), false)
  assert.equal(isDockerDaemonUnavailable(new Error('docker: command not found')), false)
})

test('isDockerDaemonUnavailable detects spawn ENOENT (docker binary not installed)', () => {
  const err = new Error('docker could not start: spawn docker ENOENT')
  assert.ok(isDockerDaemonUnavailable(err))
})

test('isDockerDaemonUnavailable does NOT classify generic exit code 1 as daemon unavailable', () => {
  assert.equal(isDockerDaemonUnavailable(new Error('docker failed with exit code 1')), false)
  assert.equal(isDockerDaemonUnavailable(new Error('Command failed with exit code 1')), false)
  assert.equal(isDockerDaemonUnavailable(new Error('exit code 1')), false)
})

test('isDockerDaemonUnavailable does NOT classify image pull failures as daemon unavailable', () => {
  const err = new Error('docker failed with exit code 1: Unable to find image "postgres:15" locally, pull access denied')
  assert.equal(isDockerDaemonUnavailable(err), false)
})

test('isDockerDaemonUnavailable does NOT classify permission failures as daemon unavailable', () => {
  const err = new Error('docker failed with exit code 1: permission denied while trying to connect')
  assert.equal(isDockerDaemonUnavailable(err), false)
})

test('isDockerDaemonUnavailable does NOT classify container name conflicts as daemon unavailable', () => {
  const err = new Error('docker failed with exit code 1: Conflict. The container name "/monrad_pg_test" is already in use')
  assert.equal(isDockerDaemonUnavailable(err), false)
})

test('isDockerDaemonUnavailable returns false for null/undefined', () => {
  assert.equal(isDockerDaemonUnavailable(null), false)
  assert.equal(isDockerDaemonUnavailable(undefined), false)
})

test('startDockerPostgres preserves original diagnostic for non-daemon failures', async () => {
  const run = async () => { throw new Error('Unable to find image "postgres:15" locally: pull access denied') }
  await assert.rejects(
    startDockerPostgres({ run, random: 'test-pull-fail' }),
    /pull access denied/,
  )
})

test('startDockerPostgres surfs Docker port conflict error without misclassifying', async () => {
  const run = async (cmd, args, opts) => {
    if (args[0] === 'run') throw new Error('Conflict. The container name "/monrad_pg_conflict" is already in use by container')
    return ''
  }
  await assert.rejects(
    startDockerPostgres({ run, random: 'test-conflict' }),
    /container name.*already in use|Conflict/,
  )
})

test('startDockerPostgres tries cleanup when port discovery fails', async () => {
  let cleanedUp = false
  const run = async (cmd, args, opts) => {
    if (args[0] === 'run') { return 'abc\n' }
    if (args[0] === 'port') { throw new Error('port not assigned') }
    if (args[0] === 'rm') { cleanedUp = true; return '' }
    return ''
  }
  await assert.rejects(
    startDockerPostgres({ run, random: 'test-cleanup-port', waitForPort: async () => {} }),
    /port not assigned/,
  )
  assert.equal(cleanedUp, true, 'cleanup must be attempted when port discovery fails')
})

test('startDockerPostgres retains primary Docker failure alongside cleanup failure', async () => {
  let cleanupCalled = false
  const run = async (cmd, args, opts) => {
    if (args[0] === 'run') { return 'abc\n' }
    if (args[0] === 'port') { throw new Error('port mapping failed') }
    if (args[0] === 'rm') { cleanupCalled = true; throw new Error('docker rm failed') }
    return ''
  }
  await assert.rejects(
    startDockerPostgres({ run, random: 'test-dual-fail', waitForPort: async () => {} }),
    /port mapping failed.*docker rm failed/,
  )
  assert.equal(cleanupCalled, true, 'cleanup must be attempted even when primary error will occur')
})

test('uses Docker-first mode by default and cleans up container after success', async () => {
  let dockerStarted = false
  let dockerStopped = false
  let actionUrl = null
  let createDbQueries = 0
  let dropDbQueries = 0
  const queries = []
  const mockClient = {
    async connect() {},
    async query(sql, values) {
      queries.push({ sql, values })
      if (sql.startsWith('CREATE DATABASE')) createDbQueries++
      if (sql.startsWith('DROP DATABASE')) dropDbQueries++
      return { rowCount: 1 }
    },
    async end() {},
  }
  const clientFactory = async () => mockClient
  await withIsolatedTestDatabase({
    root: process.cwd(),
    environment: { DATABASE_URL: developmentUrl },
    clientFactory,
    startDocker: async () => {
      dockerStarted = true
      return { name: 'monrad_pg_test', databaseUrl: 'postgresql://postgres:secret@127.0.0.1:49152/postgres' }
    },
    stopDocker: async () => { dockerStopped = true },
    prepare: async ({ env }) => { actionUrl = env.DATABASE_URL },
  }, async () => 'ok')
  assert.equal(dockerStarted, true, 'Docker must be started')
  assert.equal(dockerStopped, true, 'Docker must be stopped')
  assert.equal(actionUrl, 'postgresql://postgres:secret@127.0.0.1:49152/postgres', 'Docker databaseUrl must be used')
  assert.equal(createDbQueries, 0, 'no CREATE DATABASE queries in Docker-first mode')
  assert.equal(dropDbQueries, 0, 'no DROP DATABASE queries in Docker-first mode')
})

test('cleans up container when child action fails', async () => {
  let dockerStarted = false
  let dockerStopped = false
  const queries = []
  const mockClient = {
    async connect() {},
    async query(sql, values) { queries.push({ sql, values }); return { rowCount: 1 } },
    async end() {},
  }
  const clientFactory = async () => mockClient
  await assert.rejects(
    withIsolatedTestDatabase({
      root: process.cwd(),
      environment: { DATABASE_URL: developmentUrl },
      clientFactory,
      startDocker: async () => {
        dockerStarted = true
        return { name: 'monrad_pg_test', databaseUrl: 'postgresql://postgres:secret@127.0.0.1:49152/postgres' }
      },
      stopDocker: async () => { dockerStopped = true },
      prepare: async () => {},
    }, async () => { throw new Error('child failed') }),
    /child failed/,
  )
  assert.equal(dockerStarted, true, 'Docker must be started')
  assert.equal(dockerStopped, true, 'Docker must be stopped even on failure')
  assert.equal(queries.length, 0, 'no database-level queries in Docker-first mode')
})

test('requires explicit opt-in for externally managed test databases', async () => {
  await assert.rejects(withIsolatedTestDatabase({
    root: process.cwd(),
    environment: { DATABASE_URL: developmentUrl, MONRAD_TEST_DATABASE_URL: 'postgresql://tester:secret@localhost/test_db' },
  }, async () => {}), /MONRAD_ALLOW_EXTERNAL_TEST_DATABASE=1/)
})

test('uses an explicitly allowed external test database without dropping it', async () => {
  let preparedUrl
  await withIsolatedTestDatabase({
    root: process.cwd(),
    environment: {
      DATABASE_URL: developmentUrl,
      MONRAD_TEST_DATABASE_URL: 'postgresql://tester:secret@localhost/test_db',
      MONRAD_ALLOW_EXTERNAL_TEST_DATABASE: '1',
    },
    prepare: async ({ env }) => { preparedUrl = env.DATABASE_URL },
  }, async (_env, metadata) => assert.equal(metadata.external, true))
  assert.equal(preparedUrl, 'postgresql://tester:secret@localhost/test_db')
})


test('uses Windows npm command adaptation without shell strings', () => {
  const command = resolveCommand('npm', ['install'], 'win32', 'C:/npm-cli.js')
  assert.deepEqual(command, { command: process.execPath, args: ['C:/npm-cli.js', 'install'] })
})

test('preserves native command on non-Windows platform', () => {
  const npmCmd = resolveCommand('npm', ['test'], 'linux')
  assert.deepEqual(npmCmd, { command: 'npm', args: ['test'] })
  const npxCmd = resolveCommand('npx', ['prisma'], 'darwin')
  assert.deepEqual(npxCmd, { command: 'npx', args: ['prisma'] })
  const otherCmd = resolveCommand('docker', ['ps'], 'win32')
  assert.deepEqual(otherCmd, { command: 'docker', args: ['ps'] })
})

test('quotes configured database identifiers safely with special characters', () => {
  assert.equal(quoteIdentifier('My DB'), '"My DB"')
  assert.equal(quoteIdentifier('project-db'), '"project-db"')
  assert.equal(quoteIdentifier('UPPERCASE'), '"UPPERCASE"')
  assert.equal(quoteIdentifier('quote"d'), '"quote""d"')
  assert.equal(quoteIdentifier('a b'), '"a b"')
  assert.equal(quoteIdentifier('with"double"quotes'), '"with""double""quotes"')
  assert.throws(() => quoteIdentifier(''), /non-empty/)
  assert.throws(() => quoteIdentifier(null), /non-empty/)
  const longName = 'a'.repeat(64)
  assert.throws(() => quoteIdentifier(longName), /exceeds/)
})

test('creates configured databases with hyphens, mixed case, spaces, and embedded quotes', async () => {
  const cases = [
    { url: 'postgresql://u:p@localhost/monrad-estimator', name: 'monrad-estimator', createSql: 'CREATE DATABASE "monrad-estimator"' },
    { url: 'postgresql://u:p@localhost/MonradEstimator', name: 'MonradEstimator', createSql: 'CREATE DATABASE "MonradEstimator"' },
    { url: 'postgresql://u:p@localhost/monrad%20estimator', name: 'monrad estimator', createSql: 'CREATE DATABASE "monrad estimator"' },
    { url: 'postgresql://u:p@localhost/quote%22d', name: 'quote"d', createSql: 'CREATE DATABASE "quote""d"' },
  ]
  for (const { url, name, createSql: expectedCreate } of cases) {
    const queries = []
    const result = await ensureDatabase({ databaseUrl: url, clientFactory: fakeClientFactory(queries) })
    assert.equal(result.created, true)
    assert.equal(result.database, name)
    assert.equal(queries[0].sql, 'SELECT 1 FROM pg_database WHERE datname = $1')
    assert.deepEqual(queries[0].values, [name])
    assert.equal(queries[1].sql, expectedCreate)
  }
})

test('rejects a configured database name exceeding 63 bytes before emitting CREATE DATABASE', async () => {
  const overlongName = 'a'.repeat(62) + '\u00e9'
  assert.ok(Buffer.byteLength(overlongName) > 63, 'precondition: construct a name that exceeds 63 bytes')
  const encodedName = encodeURIComponent(overlongName)
  const overlongUrl = `postgresql://u:p@localhost/${encodedName}`
  const queries = []
  await assert.rejects(
    ensureDatabase({ databaseUrl: overlongUrl, clientFactory: fakeClientFactory(queries) }),
    /exceeds.*63/,
  )
  assert.equal(queries.length, 1, 'SELECT executed but CREATE DATABASE must not be emitted')
  assert.equal(queries[0].sql, 'SELECT 1 FROM pg_database WHERE datname = $1')
  assert.deepEqual(queries[0].values, [overlongName])
})

test('redacts credentials across multiple PostgreSQL URLs in error messages', () => {
  const msg = 'Connect to postgresql://user1:pass1@host1/a failed; also postgresql://user2:pass2@host2/b'
  const redacted = redactError(new Error(msg), 'Prefix')
  assert.match(redacted.message, /user1:\*\*\*@host1/)
  assert.match(redacted.message, /user2:\*\*\*@host2/)
  assert.doesNotMatch(redacted.message, /:pass1@/)
  assert.doesNotMatch(redacted.message, /:pass2@/)
})

test('redacts percent-encoded passwords in error messages', () => {
  const msg = 'postgresql://user:pass%20word@host/db'
  const redacted = redactError(new Error(msg), 'Prefix')
  assert.match(redacted.message, /user:\*\*\*@host/)
  assert.doesNotMatch(redacted.message, /pass%20word/)
})

test('redacts password query parameters in error messages', () => {
  const msg = 'postgresql://user@host/db?password=topsecret&sslmode=disable'
  const redacted = redactError(new Error(msg), 'Prefix')
  assert.match(redacted.message, /password=\*\*\*/)
  assert.doesNotMatch(redacted.message, /password=topsecret/)
})

test('throws cleanup error when Docker cleanup fails after successful action', async () => {
  let stopDockerCalled = false
  let err
  try {
    await withIsolatedTestDatabase({
      root: process.cwd(),
      environment: { DATABASE_URL: developmentUrl },
      startDocker: async () => ({ name: 'monrad_pg_clnp', databaseUrl: 'postgresql://postgres:secret@127.0.0.1:49152/postgres' }),
      stopDocker: async () => {
        stopDockerCalled = true
        throw new Error('stop failed: postgresql://user:realpass@localhost/db')
      },
      prepare: async () => {},
    }, async () => 'ok')
    assert.fail('expected rejection')
  } catch (e) {
    err = e
  }
  assert.ok(err instanceof Error, 'rejection is an Error')
  assert.ok(err.message.includes('cleanup failed'), 'cleanup error is primary when action succeeds')
  assert.match(err.message, /\*\*\*@/, 'password is redacted in cleanup error')
  assert.equal(stopDockerCalled, true)
})

test('surfaces Docker cleanup failure alongside primary action failure', async () => {
  let stopDockerCalled = false
  let err
  try {
    await withIsolatedTestDatabase({
      root: process.cwd(),
      environment: { DATABASE_URL: developmentUrl },
      startDocker: async () => ({ name: 'monrad_pg_clna', databaseUrl: 'postgresql://postgres:secret@127.0.0.1:49152/postgres' }),
      stopDocker: async () => {
        stopDockerCalled = true
        throw new Error('Docker cleanup failed')
      },
      prepare: async () => {},
    }, async () => { throw new Error('action failed') })
    assert.fail('expected rejection')
  } catch (e) {
    err = e
  }
  assert.ok(err instanceof Error, 'rejection is an Error')
  assert.ok(err.message.includes('action failed'), 'primary action failure is present')
  assert.ok(err.message.includes('Docker cleanup'), 'Docker cleanup failure is surfaced alongside action failure')
  assert.equal(stopDockerCalled, true)
})

test('Docker cleanup failure after non-Error action rejection', async () => {
  let stopDockerCalled = false
  let err
  try {
    await withIsolatedTestDatabase({
      root: process.cwd(),
      environment: { DATABASE_URL: developmentUrl },
      startDocker: async () => ({ name: 'monrad_pg_clnp', databaseUrl: 'postgresql://postgres:secret@127.0.0.1:49152/postgres' }),
      stopDocker: async () => {
        stopDockerCalled = true
        throw new Error('Docker cleanup choked')
      },
      prepare: async () => {},
    }, async () => { throw 'urgent failure' })
    assert.fail('expected rejection')
  } catch (e) {
    err = e
  }
  assert.ok(err instanceof Error, 'non-Error rejection is normalized to Error')
  assert.ok(err.message.includes('urgent failure'), 'original failure meaning is retained')
  assert.ok(err.message.includes('Docker cleanup'), 'Docker cleanup failure is surfaced')
  assert.equal(stopDockerCalled, true, 'Docker cleanup was attempted')
})




// ── Shutdown guard ───────────────────────────────────────────────────────────

test('shutdownGuard initial state reflects no signal received', () => {
  const events = {}
  const mockProc = {
    exitCode: undefined,
    on(event, handler) { events[event] = handler },
    off(event) { delete events[event] },
  }
  const guard = shutdownGuard({ process: mockProc })
  assert.equal(guard.triggered, false)
  assert.equal(guard.signal, null)
  assert.equal(guard.signalExitCode, null)
  guard.dispose()
})

test('shutdownGuard SIGINT sets triggered, signal, and 130 exit code', () => {
  const events = {}
  const mockProc = {
    exitCode: undefined,
    on(event, handler) { events[event] = handler },
    off(event) { delete events[event] },
  }
  const guard = shutdownGuard({ process: mockProc })
  events.SIGINT('SIGINT')
  assert.equal(guard.triggered, true)
  assert.equal(guard.signal, 'SIGINT')
  assert.equal(guard.signalExitCode, 130)
  assert.equal(mockProc.exitCode, 130)
  guard.dispose()
})

test('shutdownGuard SIGTERM sets triggered, signal, and 143 exit code', () => {
  const events = {}
  const mockProc = {
    exitCode: undefined,
    on(event, handler) { events[event] = handler },
    off(event) { delete events[event] },
  }
  const guard = shutdownGuard({ process: mockProc })
  events.SIGTERM('SIGTERM')
  assert.equal(guard.triggered, true)
  assert.equal(guard.signal, 'SIGTERM')
  assert.equal(guard.signalExitCode, 143)
  assert.equal(mockProc.exitCode, 143)
  guard.dispose()
})

test('shutdownGuard second signal triggers force-exit', () => {
  const events = {}
  const mockProc = {
    exitCode: undefined,
    on(event, handler) { events[event] = handler },
    off(event) { delete events[event] },
  }
  let forceExitCalledWith = null
  const guard = shutdownGuard({
    process: mockProc,
    forceExit: (code) => { forceExitCalledWith = code },
  })
  // First signal: SIGINT
  events.SIGINT('SIGINT')
  assert.equal(guard.triggered, true)
  assert.equal(guard.signal, 'SIGINT')
  assert.equal(guard.signalExitCode, 130)
  assert.equal(guard.abortSignal.aborted, true)
  assert.equal(forceExitCalledWith, null, 'forceExit must not be called on first signal')

  // Second signal: SIGTERM must trigger force-exit
  events.SIGTERM('SIGTERM')
  assert.equal(forceExitCalledWith, 130, 'forceExit must be called with the first signal exit code')
  assert.equal(guard.signal, 'SIGINT', 'signal must still reflect the first signal')
  assert.equal(guard.signalExitCode, 130, 'exit code must still reflect the first signal')
  guard.dispose()
})

test('shutdownGuard dispose removes SIGINT and SIGTERM handlers', () => {
  const events = {}
  const mockProc = {
    exitCode: undefined,
    on(event, handler) { events[event] = handler },
    off(event) { delete events[event] },
  }
  const guard = shutdownGuard({ process: mockProc })

  // Verify handlers were registered
  assert.ok(typeof events.SIGINT === 'function', 'SIGINT handler must be registered')
  assert.ok(typeof events.SIGTERM === 'function', 'SIGTERM handler must be registered')

  guard.dispose()

  // Verify handlers were removed
  assert.equal(events.SIGINT, undefined, 'SIGINT handler must be removed')
  assert.equal(events.SIGTERM, undefined, 'SIGTERM handler must be removed')
})

test('shutdownGuard _handler matches the registered handler', () => {
  const events = {}
  const mockProc = {
    exitCode: undefined,
    on(event, handler) { events[event] = handler },
    off(event) { delete events[event] },
  }
  const guard = shutdownGuard({ process: mockProc })
  assert.equal(events.SIGINT, guard._handler, 'SIGINT handler must be the same function reference')
  assert.equal(events.SIGTERM, guard._handler, 'SIGTERM handler must be the same function reference')
  guard.dispose()
})

test('shutdownGuard abortSignal is an AbortSignal that is not aborted initially', () => {
  const events = {}
  const mockProc = {
    exitCode: undefined,
    on(event, handler) { events[event] = handler },
    off(event) { delete events[event] },
  }
  const guard = shutdownGuard({ process: mockProc })
  assert.ok(guard.abortSignal instanceof AbortSignal, 'abortSignal must be an AbortSignal')
  assert.equal(guard.abortSignal.aborted, false, 'abortSignal must not be aborted initially')
  guard.dispose()
})

test('shutdownGuard abortSignal aborts on SIGINT', () => {
  const events = {}
  const mockProc = {
    exitCode: undefined,
    on(event, handler) { events[event] = handler },
    off(event) { delete events[event] },
  }
  const guard = shutdownGuard({ process: mockProc })
  events.SIGINT('SIGINT')
  assert.equal(guard.abortSignal.aborted, true, 'abortSignal must be aborted after SIGINT')
  guard.dispose()
})

test('shutdownGuard abortSignal aborts on SIGTERM', () => {
  const events = {}
  const mockProc = {
    exitCode: undefined,
    on(event, handler) { events[event] = handler },
    off(event) { delete events[event] },
  }
  const guard = shutdownGuard({ process: mockProc })
  events.SIGTERM('SIGTERM')
  assert.equal(guard.abortSignal.aborted, true, 'abortSignal must be aborted after SIGTERM')
  guard.dispose()
})

test('shutdownGuard abortSignal is distinct from triggered state', () => {
  const events = {}
  const mockProc = {
    exitCode: undefined,
    on(event, handler) { events[event] = handler },
    off(event) { delete events[event] },
  }
  const guard = shutdownGuard({ process: mockProc })
  assert.ok(guard.abortSignal instanceof AbortSignal)
  assert.equal(guard.abortSignal.aborted, false)
  assert.equal(guard.triggered, false)
  events.SIGINT('SIGINT')
  assert.equal(guard.abortSignal.aborted, true)
  assert.equal(guard.triggered, true)
  assert.equal(guard.signal, 'SIGINT')
  assert.equal(guard.signalExitCode, 130)
  guard.dispose()
})

test('shutdownGuard abortSignal remains aborted after dispose', () => {
  const events = {}
  const mockProc = {
    exitCode: undefined,
    on(event, handler) { events[event] = handler },
    off(event) { delete events[event] },
  }
  const guard = shutdownGuard({ process: mockProc })
  events.SIGTERM('SIGTERM')
  guard.dispose()
  assert.equal(guard.abortSignal.aborted, true, 'abortSignal must remain aborted after dispose')
  assert.equal(guard.signal, 'SIGTERM')
})

test('runCommand does not spawn child when signal is already aborted', async () => {
  const controller = new AbortController()
  controller.abort()
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'monrad-nospawn-'))
  const marker = path.join(tmpDir, 'marker')

  await assert.rejects(
    runCommand('node', ['-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, '')`], { signal: controller.signal }),
    /was cancelled/,
    'runCommand must reject without spawning when signal is pre-aborted',
  )

  assert.equal(fs.existsSync(marker), false, 'no child process should have been spawned')
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

test('runCommand rejects and kills child when signal fires during execution', async () => {
  const controller = new AbortController()

  const promise = runCommand('node', ['-e', 'setTimeout(() => process.exit(0), 30000)'], { signal: controller.signal })
  // Give it a moment to spawn
  await new Promise(resolve => setTimeout(resolve, 100))
  controller.abort()

  const start = Date.now()
  await assert.rejects(promise, /was cancelled/, 'runCommand must reject with cancellation error on abort')
  // Must reject promptly, not wait for the 30s timeout
  assert.ok(Date.now() - start < 5000, 'runCommand must reject promptly on abort')
})

test('runCommand without signal behaves normally on non-zero exit', async () => {
  await assert.rejects(
    runCommand('node', ['-e', 'process.exit(42)']),
    /failed with exit code 42/,
  )
})

test('runCommand without signal resolves on zero exit', async () => {
  const result = await runCommand('node', ['-e', 'process.exit(0)'])
  assert.equal(result, '')
})

// ── Cancellation and bounded-operation tests ────────────────────────────

test('preparePrisma does not run when signal is already aborted', async () => {
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(
    preparePrisma({
      root: process.cwd(),
      env: { DATABASE_URL: 'postgresql://u:p@localhost/db' },
      signal: controller.signal,
    }),
    /was cancelled/,
  )
})


test('stopDockerPostgres uses independent bounded cleanup (not passed signal)', async () => {
  const passedSignal = new AbortController().signal
  let usedSignal = null
  await stopDockerPostgres(
    { name: 'test-container', dockerEnv: {} },
    {
      signal: passedSignal,
      run: async (_cmd, _args, opts) => { usedSignal = opts.signal },
    },
  )
  assert.notEqual(usedSignal, passedSignal, 'stopDockerPostgres must NOT reuse the passed signal')
  assert.ok(usedSignal, 'stopDockerPostgres must pass an independent signal')
  // The independent signal uses AbortSignal.timeout(30_000)
  assert.equal(usedSignal?.reason?.message ?? usedSignal?.reason, undefined, 'cleanup signal should not be aborted initially')
})


// ── runCommand: abort termination paths ──────────────────────────────────────

test('runCommand on POSIX kills child via process group termination on abort', async () => {
  if (process.platform === 'win32') return

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'monrad-posix-pg-'))
  const pidFile = path.join(tmpDir, 'child.pid')
  const escaped = JSON.stringify(pidFile)
  const controller = new AbortController()

  const promise = runCommand('node', ['-e', `
    require('fs').writeFileSync(${escaped}, String(process.pid));
    setTimeout(() => {}, 60000);
  `], { signal: controller.signal, graceMs: 500 })

  await new Promise(r => setTimeout(r, 300))

  const childPid = parseInt(fs.readFileSync(pidFile, 'utf-8').trim(), 10)
  assert.ok(childPid > 0, 'child PID must be valid')

  controller.abort()
  await assert.rejects(promise, /was cancelled/, 'must reject on abort')

  // Wait for OS to reap the child process
  for (let i = 0; i < 20; i++) {
    try { process.kill(childPid, 0); await new Promise(r => setTimeout(r, 100)) }
    catch (e) { if (e.code === 'ESRCH') break }
  }

  assert.throws(() => process.kill(childPid, 0), { code: 'ESRCH' }, 'child must be killed')
  fs.rmSync(tmpDir, { recursive: true, force: true })
})


test('runCommand resolves normally when child exits successfully before abort signal arrives', async () => {
  const controller = new AbortController()
  const result = await runCommand('node', ['-e', 'process.exit(0)'], { signal: controller.signal })
  assert.equal(result, '')
  controller.abort()
})

test('runCommand preserves non-zero exit error when child exits before abort signal arrives', async () => {
  const controller = new AbortController()
  await assert.rejects(
    runCommand('node', ['-e', 'process.exit(42)'], { signal: controller.signal }),
    /failed with exit code 42/,
  )
  controller.abort()
})

test('runCommand on Windows uses injected terminateWindows', async () => {
  const controller = new AbortController()
  let terminateCalled = false
  let terminateChild = null
  const promise = runCommand('node', ['-e', 'setTimeout(() => {}, 30000)'], {
    signal: controller.signal,
    platform: 'win32',
    terminateWindows: (child) => {
      terminateCalled = true
      terminateChild = child
      child.kill()
      return Promise.resolve()
    },
  })
  await new Promise(r => setTimeout(r, 100))

  const start = Date.now()
  controller.abort()
  await assert.rejects(promise, /was cancelled/, 'must reject on abort')
  assert.ok(Date.now() - start < 5000, 'rejection must be prompt')
  assert.ok(terminateCalled, 'Windows termination callback must be invoked')
  assert.ok(terminateChild, 'termination must receive the child process')
})

test('runCommand waits for termination before rejecting on abort', async () => {
  if (process.platform === 'win32') return

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'monrad-wait-term-'))
  const pidFile = path.join(tmpDir, 'child.pid')
  const cleanupFile = path.join(tmpDir, 'cleaned')
  const escaped = JSON.stringify(pidFile)
  const escapedCleanup = JSON.stringify(cleanupFile)
  const controller = new AbortController()

  // Spawn a child that will stay alive after abort.
  // Verify that the cleanup marker is NOT written until the promise settles.
  // Then after settle, the child should be gone.
  const promise = runCommand('node', ['-e', `
    const fs = require('fs');
    fs.writeFileSync(${escaped}, String(process.pid));
    setTimeout(() => {}, 60000);
  `], { signal: controller.signal, graceMs: 500 })

  await new Promise(r => setTimeout(r, 200))

  const childPid = parseInt(fs.readFileSync(pidFile, 'utf-8').trim(), 10)
  assert.ok(childPid > 0, 'child PID must be valid')

  controller.abort()

  // Assert child is NOT yet cleaned (promise hasn't settled)
  // Wait a tiny bit for the OS to act, then check child is gone
  // We can't reliably check that cleanup hasn't started, but we can
  // check that when the promise settles, the child is gone.
  await promise.catch(() => {}) // wait for settle

  // After settle, child must be gone
  try {
    process.kill(childPid, 0)
    assert.fail('child should have been terminated')
  } catch (e) {
    assert.equal(e.code, 'ESRCH', 'child process must be killed before promise settles')
  }
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

test('runCommand termination failure surfaces to caller via injected terminateWindows', async () => {
  const controller = new AbortController()
  const promise = runCommand('node', ['-e', 'setTimeout(() => {}, 30000)'], {
    signal: controller.signal,
    platform: 'win32',
    terminateWindows: () => Promise.reject(new Error('mock termination failure')),
    graceMs: 500,
  })
  await new Promise(r => setTimeout(r, 100))
  controller.abort()

  // Must reject with cancellation error even though termination failed
  await assert.rejects(promise, /was cancelled/, 'must reject even if termination fails')
})

test('late abort after normal exit has no effect', async () => {
  const controller = new AbortController()
  const result = await runCommand('node', ['-e', 'process.exit(0)'], { signal: controller.signal })
  assert.equal(result, '')
  // Late abort should be a no-op — no error
  controller.abort()
})

test('abort after non-zero exit retains exit error', async () => {
  const controller = new AbortController()
  await assert.rejects(
    runCommand('node', ['-e', 'process.exit(1)'], { signal: controller.signal }),
    /failed with exit code 1/,
  )
  controller.abort()
})

// ── Cancellation tests ──────────────────────────────────────────────────────────

test('withIsolatedTestDatabase Docker-first mode: cancellation before startup creates no container', async () => {
  const controller = new AbortController()
  controller.abort()
  let dockerStarted = false
  await assert.rejects(
    withIsolatedTestDatabase({
      root: process.cwd(),
      environment: { DATABASE_URL: 'postgresql://u:p@localhost/db' },
      signal: controller.signal,
      startDocker: async () => { dockerStarted = true; return { name: 'test-pg', databaseUrl: 'postgresql://u:p@localhost:5432/postgres' } },
    }, async () => {}),
    /was cancelled/,
  )
  assert.equal(dockerStarted, false, 'no container should be created after pre-abort')
})

test('withIsolatedTestDatabase Docker-first mode: cancellation during prepare still cleans up container', async () => {
  const controller = new AbortController()
  const signal = controller.signal
  let dockerStopped = false
  await assert.rejects(
    withIsolatedTestDatabase({
      root: process.cwd(),
      environment: { DATABASE_URL: 'postgresql://u:p@localhost/db' },
      startDocker: async () => ({ name: 'test-pg', databaseUrl: 'postgresql://u:p@localhost:5432/postgres' }),
      stopDocker: async () => { dockerStopped = true },
      prepare: async () => { controller.abort() },
      signal,
    }, async () => {}),
    /was cancelled/,
  )
  assert.equal(dockerStopped, true, 'Docker container must be cleaned up even after prepare cancellation')
})

test('withIsolatedTestDatabase external mode: cancellation before prepare rejects without preparing', async () => {
  const controller = new AbortController()
  controller.abort()
  let prepared = false
  await assert.rejects(
    withIsolatedTestDatabase({
      root: process.cwd(),
      environment: {
        DATABASE_URL: 'postgresql://u:p@localhost/persistent',
        MONRAD_TEST_DATABASE_URL: 'postgresql://u:p@localhost/external_test',
        MONRAD_ALLOW_EXTERNAL_TEST_DATABASE: '1',
      },
      prepare: async () => { prepared = true },
      signal: controller.signal,
    }, async () => {}),
    /was cancelled/,
  )
  assert.equal(prepared, false, 'must not prepare after pre-abort')
})

// ── Readiness failure preservation and cancellation ────────────────────

test('readiness query failure plus shutdown failure preserves both', async () => {
  let endCalled = false
  let queryResolve = null
  const queryPromise = new Promise(resolve => { queryResolve = resolve })
  const secret = 'super-secret'
  const urlSecret = 'another-secret'
  const shutdownError = `shutdown failed for postgresql://tester:${secret}@localhost/db?password=${urlSecret}`

  const fakeClient = {
    connect: async () => {},
    query: async () => {
      await queryPromise
      throw new Error('query timeout')
    },
    end: async () => { endCalled = true; throw new Error(shutdownError) },
    _ending: false,
  }

  const stubClientFactory = () => fakeClient
  const readied = waitForPostgres('postgresql://u:p@localhost/db', stubClientFactory, 3_000)

  // Let query start then resolve it (failing).
  await new Promise(resolve => setTimeout(resolve, 5))
  queryResolve()

  await assert.rejects(readied, /query timeout/)
  const err = await readied.catch(e => e)
  assert.ok(err.message.includes('query timeout'), `primary missing: "${err.message}"`)
  assert.ok(err.message.includes('shutdown failed'), `secondary missing: "${err.message}"`)
  assert.ok(err.message.includes('secondary'), `secondary marker missing: "${err.message}"`)
  assert.ok(!err.message.includes(secret), `password in URL must be redacted: "${err.message}"`)
  assert.ok(!err.message.includes(urlSecret), `query password must be redacted: "${err.message}"`)
  assert.ok(err.message.includes('***'), 'redacted markers must be present')
  assert.ok(!err.message.includes('u:p'), 'credentials must be redacted')
  assert.ok(endCalled, 'client.end() was called')
})

test('readiness connect failure plus shutdown failure preserves both', async () => {
  let endCalled = false
  const secret = 'super-secret'
  const urlSecret = 'another-secret'
  const shutdownError = `shutdown failed for postgresql://tester:${secret}@localhost/db?password=${urlSecret}`
  const fakeClient = {
    connect: async () => { throw new Error('connection refused') },
    query: async () => { throw new Error('should not reach') },
    end: async () => { endCalled = true; throw new Error(shutdownError) },
    _ending: false,
  }

  const stubClientFactory = () => fakeClient
  const readied = waitForPostgres('postgresql://u:p@localhost/db', stubClientFactory, 3_000)

  await assert.rejects(readied, /connection refused/)
  const err = await readied.catch(e => e)
  assert.ok(err.message.includes('connection refused'), `primary missing: "${err.message}"`)
  assert.ok(err.message.includes('shutdown failed'), `secondary missing: "${err.message}"`)
  assert.ok(!err.message.includes(secret), `password in URL must be redacted: "${err.message}"`)
  assert.ok(!err.message.includes(urlSecret), `query password must be redacted: "${err.message}"`)
  assert.ok(err.message.includes('***'), 'redacted markers must be present')
  assert.ok(endCalled, 'client.end() was called')
})
test('successful readiness query plus shutdown failure fails', async () => {
  let endCalled = false
  const secret = 'super-secret'
  const urlSecret = 'another-secret'
  const shutdownError = `shutdown failed for postgresql://tester:${secret}@localhost/db?password=${urlSecret}`
  const fakeClient = {
    connect: async () => {},
    query: async () => {},
    end: async () => { endCalled = true; throw new Error(shutdownError) },
    _ending: false,
  }

  const stubClientFactory = () => fakeClient
  const readied = waitForPostgres('postgresql://u:p@localhost/db', stubClientFactory, 3_000)
  await assert.rejects(readied, /shutdown failed/)
  const err = await readied.catch(e => e)
  assert.ok(!err.message.includes(secret), `password in URL must be redacted: "${err.message}"`)
  assert.ok(!err.message.includes(urlSecret), `query password must be redacted: "${err.message}"`)
  assert.ok(err.message.includes('***'), 'redacted markers must be present')
  assert.ok(endCalled, 'client.end() was called')
})

test('cancellation during pending readiness query calls end and rejects', async () => {
  const ctrl = new AbortController()
  let endCalled = false
  let queryReject = null
  const queryPromise = new Promise((_, reject) => { queryReject = reject })

  const fakeClient = {
    connect: async () => {},
    query: async () => {
      await queryPromise
      // If we reach here, shutdown already happened.
      throw new Error('read_query: Connection terminated')
    },
    end: async () => { endCalled = true },
    _ending: false,
  }

  const stubClientFactory = () => fakeClient
  const readied = waitForPostgres('postgresql://u:p@localhost/db', stubClientFactory, 60_000, ctrl.signal)

  // Let query start.
  await new Promise(resolve => setTimeout(resolve, 5))

  // Abort while query is pending.
  ctrl.abort()

  // Assert client.end() was initiated by abort handler BEFORE settling the query.
  assert.ok(endCalled, 'client.end() must be called by abort handler before query settles')

  // Reject the query as the shut-down client would.
  queryReject(new Error('Connection terminated'))

  await assert.rejects(readied, /cancelled|terminated/)
})