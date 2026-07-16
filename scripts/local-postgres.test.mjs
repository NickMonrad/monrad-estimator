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
