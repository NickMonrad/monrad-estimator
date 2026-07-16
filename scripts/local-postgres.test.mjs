import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  createTestDatabaseName,
  ensureDatabase,
  loadLocalEnvironment,
  maintenanceDatabaseUrl,
  parseDatabaseUrl,
  redactDatabaseUrl,
  resolveCommand,
  startDockerPostgres,
  stopDockerPostgres,
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
  assert.deepEqual(calls[0].args.slice(0, 7), ['run', '--detach', '--name', container.name, '--env', 'POSTGRES_PASSWORD', '--env'])
  assert.ok(calls[0].args.includes('127.0.0.1::5432'))
  await stopDockerPostgres(container, { run })
  assert.deepEqual(calls.at(-1).args, ['rm', '--force', container.name])
})

test('cleans a disposable database after success and terminates connections before drop', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'monrad-life-'))
  const queries = []
  let prepared = false
  await withIsolatedTestDatabase({
    root,
    environment: { DATABASE_URL: developmentUrl },
    clientFactory: fakeClientFactory(queries),
    prepare: async () => { prepared = true },
  }, async env => {
    assert.notEqual(env.DATABASE_URL, developmentUrl)
  })
  assert.equal(prepared, true)
  assert.ok(queries.some(query => query.sql.startsWith('CREATE DATABASE')))
  const terminate = queries.findIndex(query => query.sql.startsWith('SELECT pg_terminate_backend'))
  const drop = queries.findIndex(query => query.sql.startsWith('DROP DATABASE'))
  assert.ok(terminate >= 0 && drop > terminate)
  assert.ok(!queries.some(query => query.sql.includes('development_db') && query.sql.startsWith('DROP DATABASE')))
  fs.rmSync(root, { recursive: true, force: true })
})

test('cleans a disposable database after child failure', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'monrad-life-'))
  const queries = []
  await assert.rejects(withIsolatedTestDatabase({
    root,
    environment: { DATABASE_URL: developmentUrl },
    clientFactory: fakeClientFactory(queries),
    prepare: async () => {},
  }, async () => { throw new Error('child failed') }), /child failed/)
  assert.ok(queries.some(query => query.sql.startsWith('DROP DATABASE')))
  fs.rmSync(root, { recursive: true, force: true })
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

test('falls back to a unique Docker database when host PostgreSQL is unavailable', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'monrad-fallback-'))
  const queries = []
  let attempts = 0
  let dockerStarted = false
  let dockerStopped = false
  const clientFactory = async () => {
    attempts += 1
    return {
      async connect() {
        if (attempts === 1) throw new Error('host unavailable')
      },
      async query(sql, values) {
        queries.push({ sql, values })
        return { rowCount: 1 }
      },
      async end() {},
    }
  }
  await withIsolatedTestDatabase({
    root,
    environment: { DATABASE_URL: developmentUrl },
    clientFactory,
    startDocker: async () => {
      dockerStarted = true
      return { name: 'monrad_pg_test', databaseUrl: 'postgresql://postgres:secret@127.0.0.1:49152/postgres' }
    },
    stopDocker: async () => { dockerStopped = true },
    prepare: async () => {},
  }, async (_env, metadata) => assert.equal(metadata.docker, true))
  assert.equal(dockerStarted, true)
  assert.equal(dockerStopped, true)
  assert.ok(queries.some(query => query.sql.startsWith('CREATE DATABASE')))
  assert.ok(queries.some(query => query.sql.startsWith('DROP DATABASE')))
  fs.rmSync(root, { recursive: true, force: true })
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

test('throws cleanup error when database cleanup fails after successful action', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'monrad-clnp-'))
  let dropAttempted = false
  const clientFactory = async () => ({
    async connect() {},
    async query(sql, values) {
      if (sql.startsWith('DROP DATABASE')) {
        dropAttempted = true
        throw new Error('drop failed: postgresql://user:realpass@localhost/db')
      }
      return { rowCount: 1 }
    },
    async end() {},
  })
  let err
  try {
    await withIsolatedTestDatabase({
      root,
      environment: { DATABASE_URL: 'postgresql://user:realpass@localhost:5432/my_db' },
      clientFactory,
      prepare: async () => {},
    }, async () => 'ok')
    assert.fail('expected rejection')
  } catch (e) {
    err = e
  }
  assert.ok(err instanceof Error, 'rejection is an Error')
  assert.ok(err.message.includes('Cleanup failed'), 'cleanup error is primary when action succeeds')
  assert.match(err.message, /\*\*\*@/, 'password is redacted in cleanup error')
  assert.equal(dropAttempted, true)
  fs.rmSync(root, { recursive: true, force: true })
})

test('surfaces cleanup failure alongside primary action failure', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'monrad-clna-'))
  let dropAttempted = false
  const clientFactory = async () => ({
    async connect() {},
    async query(sql, values) {
      if (sql.startsWith('DROP DATABASE')) {
        dropAttempted = true
        throw new Error('cleanup failed')
      }
      return { rowCount: 1 }
    },
    async end() {},
  })
  let err
  try {
    await withIsolatedTestDatabase({
      root,
      environment: { DATABASE_URL: developmentUrl },
      clientFactory,
      prepare: async () => {},
    }, async () => { throw new Error('action failed') })
    assert.fail('expected rejection')
  } catch (e) {
    err = e
  }
  assert.ok(err instanceof Error, 'rejection is an Error')
  assert.ok(err.message.includes('action failed'), 'primary action failure is present')
  assert.ok(err.message.includes('cleanup'), 'cleanup failure is surfaced alongside action failure')
  assert.equal(dropAttempted, true)
  fs.rmSync(root, { recursive: true, force: true })
})

test('surfaces cleanup failure after non-Error action rejection', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'monrad-clnp-'))
  let dropAttempted = false
  const clientFactory = async () => ({
    async connect() {},
    async query(sql, values) {
      if (sql.startsWith('DROP DATABASE')) {
        dropAttempted = true
        throw new Error('cleanup choked')
      }
      return { rowCount: 1 }
    },
    async end() {},
  })
  let err
  try {
    await withIsolatedTestDatabase({
      root,
      environment: { DATABASE_URL: developmentUrl },
      clientFactory,
      prepare: async () => {},
    }, async () => { throw 'urgent failure' })
    assert.fail('expected rejection')
  } catch (e) {
    err = e
  }
  assert.ok(err instanceof Error, 'non-Error rejection is normalized to Error')
  assert.ok(err.message.includes('urgent failure'), 'original failure meaning is retained')
  assert.ok(err.message.includes('cleanup'), 'cleanup failure is surfaced')
  assert.equal(dropAttempted, true, 'cleanup was attempted')
  fs.rmSync(root, { recursive: true, force: true })
})


test('attempts both database and Docker cleanup when both are present', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'monrad-both-'))
  const queries = []
  let dockerCleanupCalled = false
  let attempts = 0
  const clientFactory = async () => {
    attempts += 1
    return {
      async connect() {
        if (attempts === 1) throw new Error('host unavailable')
      },
      async query(sql, values) {
        queries.push({ sql, values })
        return { rowCount: 1 }
      },
      async end() {},
    }
  }
  await withIsolatedTestDatabase({
    root,
    environment: { DATABASE_URL: developmentUrl },
    clientFactory,
    startDocker: async () => {
      return { name: 'monrad_pg_both', databaseUrl: 'postgresql://postgres:pw@127.0.0.1:49152/postgres' }
    },
    stopDocker: async () => { dockerCleanupCalled = true },
    prepare: async () => {},
  }, async (_env, metadata) => {
    assert.ok(metadata.docker)
  })
  assert.ok(queries.some(q => q.sql.startsWith('CREATE DATABASE')), 'test database was created')
  assert.ok(queries.some(q => q.sql.startsWith('DROP DATABASE')), 'test database was dropped')
  assert.ok(dockerCleanupCalled, 'Docker container was cleaned up')
  fs.rmSync(root, { recursive: true, force: true })
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

test('shutdownGuard idempotent on repeated signal', () => {
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
  assert.equal(mockProc.exitCode, 130)

  // Second signal must not change state
  events.SIGTERM('SIGTERM')
  assert.equal(guard.triggered, true, 'triggered must remain true')
  assert.equal(guard.signal, 'SIGINT', 'signal must not be overwritten')
  assert.equal(guard.signalExitCode, 130, 'exit code must not be overwritten')
  assert.equal(mockProc.exitCode, 130, 'mock exitCode must not change')
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