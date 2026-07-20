import assert from 'node:assert/strict'
import { spawnSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const repositoryRoot = path.resolve(import.meta.dirname, '..')
const script = path.join(repositoryRoot, 'scripts', 'db-backup.mjs')
const controlledEnvironment = [
  'DATABASE_URL',
  'MONRAD_ENV_FILE',
  'MONRAD_DB_MODE',
  'MONRAD_DB_CONTAINER',
  'MONRAD_DOCKER_COMMAND',
  'MONRAD_DOCKER_ARGS',
  'MONRAD_PG_DUMP_COMMAND',
  'MONRAD_PG_DUMP_ARGS',
  'MONRAD_BACKUP_DIR',
]
function createTempDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'monrad-db-backup-'))
}
function writeFixture(directory, name, source) {
  const file = path.join(directory, `${name}.js`)
  fs.writeFileSync(file, source)
  return file
}

function pgDumpEnv(fixture) {
  return {
    MONRAD_PG_DUMP_COMMAND: process.execPath,
    MONRAD_PG_DUMP_ARGS: JSON.stringify([fixture]),
  }
}

function sanitizedDatabaseUrl(databaseUrl) {
  const parsed = new URL(databaseUrl)
  parsed.password = ''
  const fragmentIndex = databaseUrl.indexOf('#')
  const withoutFragment = fragmentIndex >= 0 ? databaseUrl.slice(0, fragmentIndex) : databaseUrl
  const queryIndex = withoutFragment.indexOf('?')
  const rawQuery = queryIndex >= 0 ? withoutFragment.slice(queryIndex + 1) : ''
  const retainedQuery = rawQuery.split('&').filter(component => {
    const separatorIndex = component.indexOf('=')
    const rawKey = separatorIndex >= 0 ? component.slice(0, separatorIndex) : component
    return decodeURIComponent(rawKey) !== 'password'
  })
  const queryOrFragmentIndex = [parsed.href.indexOf('?'), parsed.href.indexOf('#')]
    .filter(index => index >= 0)
    .sort((a, b) => a - b)[0]
  const base = queryOrFragmentIndex === undefined ? parsed.href : parsed.href.slice(0, queryOrFragmentIndex)
  const rawFragment = fragmentIndex >= 0 ? databaseUrl.slice(fragmentIndex) : ''
  return `${base}${retainedQuery.length ? `?${retainedQuery.join('&')}` : ''}${rawFragment}`
}

function credentialPgDump(directory, expectedUrl, expectedPassword, output = 'credential dump') {
  const fixture = writeFixture(directory, 'credential-pg-dump', `
    const args = process.argv.slice(2)
    if (args[args.indexOf('--dbname') + 1] !== ${JSON.stringify(expectedUrl)}) process.exit(11)
    if (process.env.PGPASSWORD !== ${JSON.stringify(expectedPassword)}) process.exit(13)
    const fileIndex = args.indexOf('--file')
    require('node:fs').writeFileSync(args[fileIndex + 1], Buffer.from(${JSON.stringify(output)}))
  `)
  return pgDumpEnv(fixture)
}

function dockerEnv(fixture) {
  return {
    MONRAD_DOCKER_COMMAND: process.execPath,
    MONRAD_DOCKER_ARGS: JSON.stringify([fixture]),
  }
}

function markerPgDump(directory, marker) {
  const fixture = writeFixture(directory, 'marker-pg-dump', `
    require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'invoked')
    process.exit(0)
  `)
  return pgDumpEnv(fixture)
}

function runBackup(env) {
  return spawnSync(process.execPath, [script], {
    cwd: repositoryRoot,
    env: (() => {
      const merged = { ...process.env, ...env }
      for (const key of controlledEnvironment) {
        if (!(key in env)) delete merged[key]
      }
      return merged
    })(),
    encoding: 'utf8',
  })
}
function buildBackupEnv(env) {
  const merged = { ...process.env, ...env }
  for (const key of controlledEnvironment) {
    if (!(key in env)) delete merged[key]
  }
  return merged
}

function runBackupAsync(env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script], {
      cwd: repositoryRoot,
      env: buildBackupEnv(env),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => { stdout += d })
    child.stderr.on('data', (d) => { stderr += d })
    child.on('close', (status) => resolve({ status, stdout, stderr }))
  })
}

// ── host mode ────────────────────────────────────────────────────────────

test('backs up the configured host database with pg_dump and verifies the dump', (t) => {
  const directory = createTempDirectory()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const backupDir = path.join(directory, 'backups')
  const configuredUrl = 'postgresql://configured:secret@db.example.test:5432/configured_db'
  const sanitizedUrl = new URL(configuredUrl)
  sanitizedUrl.password = ''
  const pgDump = writeFixture(directory, 'fake-pg-dump', `
    const args = process.argv.slice(2)
    const dbname = args[args.indexOf('--dbname') + 1]
    if (dbname !== ${JSON.stringify(sanitizedUrl.href)}) process.exit(11)
    if (process.env.PGPASSWORD !== 'secret') process.exit(13)
    const fileIndex = args.indexOf('--file')
    require('node:fs').writeFileSync(args[fileIndex + 1], Buffer.from('valid dump'))
  `)

  const result = runBackup({
    DATABASE_URL: configuredUrl,
    MONRAD_DB_MODE: 'host',
    ...pgDumpEnv(pgDump),
    MONRAD_BACKUP_DIR: backupDir,
  })

  assert.equal(result.status, 0, result.stderr)
  const files = fs.readdirSync(backupDir)
  assert.equal(files.length, 1)
  assert.match(files[0], /^backup-\d{8}-\d{6}-\d+-[a-f0-9-]+\.dump$/)
  assert.deepEqual(fs.readFileSync(path.join(backupDir, files[0])), Buffer.from('valid dump'))
})
test('loads DATABASE_URL from MONRAD_ENV_FILE without touching server/.env', (t) => {
  const directory = createTempDirectory()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const backupDir = path.join(directory, 'backups')
  const envUrl = 'postgresql://env-user:env-secret@localhost:5432/env_db'
  const sanitizedUrl = new URL(envUrl)
  sanitizedUrl.password = ''
  const pgDump = writeFixture(directory, 'fake-pg-dump', `
    const args = process.argv.slice(2)
    const dbname = args[args.indexOf('--dbname') + 1]
    if (dbname !== ${JSON.stringify(sanitizedUrl.href)}) process.exit(11)
    if (process.env.PGPASSWORD !== 'env-secret') process.exit(13)
    const fileIndex = args.indexOf('--file')
    require('node:fs').writeFileSync(args[fileIndex + 1], Buffer.from('env-config dump'))
  `)
  const envFile = path.join(directory, 'test.env')
  fs.writeFileSync(envFile, 'DATABASE_URL="postgresql://env-user:env-secret@localhost:5432/env_db"\n')

  const result = runBackup({
    MONRAD_ENV_FILE: envFile,
    MONRAD_DB_MODE: 'host',
    ...pgDumpEnv(pgDump),
    MONRAD_BACKUP_DIR: backupDir,
  })

  assert.equal(result.status, 0, result.stderr)
  assert.equal(fs.readdirSync(backupDir).length, 1)
})

test('fails without leaving a dump when pg_dump fails', (t) => {
  const directory = createTempDirectory()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const backupDir = path.join(directory, 'backups')
  const pgDump = writeFixture(directory, 'failing-pg-dump', 'process.exit(7)')

  const result = runBackup({
    DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/monrad_estimator',
    MONRAD_DB_MODE: 'host',
    ...pgDumpEnv(pgDump),
    MONRAD_BACKUP_DIR: backupDir,
  })

  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /failed with exit code 7/)
  assert.equal(fs.existsSync(backupDir) ? fs.readdirSync(backupDir).length : 0, 0)
})

test('rejects empty dump output', (t) => {
  const directory = createTempDirectory()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const backupDir = path.join(directory, 'backups')
  const pgDump = writeFixture(directory, 'empty-pg-dump', `
    const fileIndex = process.argv.indexOf('--file')
    require('node:fs').writeFileSync(process.argv[fileIndex + 1], Buffer.alloc(0))
  `)
  const result = runBackup({
    DATABASE_URL: 'postgresql://empty:test@localhost:5432/empty_db',
    MONRAD_DB_MODE: 'host',
    ...pgDumpEnv(pgDump),
    MONRAD_BACKUP_DIR: backupDir,
  })

  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /empty/)
  assert.equal(fs.existsSync(backupDir) ? fs.readdirSync(backupDir).length : 0, 0)
})

test('fails clearly when the host pg_dump executable is unavailable', (t) => {
  const directory = createTempDirectory()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const result = runBackup({
    DATABASE_URL: 'postgresql://postgres@localhost:5432/missing_command_db',
    MONRAD_DB_MODE: 'host',
    MONRAD_PG_DUMP_COMMAND: path.join(directory, 'missing-pg-dump'),
    MONRAD_BACKUP_DIR: path.join(directory, 'backups'),
  })

  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /host backup command .* is unavailable/)
})

test('rejects a successful host command that creates no dump', (t) => {
  const directory = createTempDirectory()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const pgDump = writeFixture(directory, 'no-output-pg-dump', 'process.exit(0)')
  const backupDir = path.join(directory, 'backups')
  const result = runBackup({
    DATABASE_URL: 'postgresql://postgres@localhost:5432/no_output_db',
    MONRAD_DB_MODE: 'host',
    ...pgDumpEnv(pgDump),
    MONRAD_BACKUP_DIR: backupDir,
  })

  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /did not create a dump/)
  assert.equal(fs.existsSync(backupDir) ? fs.readdirSync(backupDir).length : 0, 0)
})

// ── Docker mode ──────────────────────────────────────────────────────────

test('backs up through explicit Docker container and cleans remote dump', (t) => {
  const directory = createTempDirectory()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const backupDir = path.join(directory, 'backups')
  const invocationLog = path.join(directory, 'docker-invocations.json')
  const docker = writeFixture(directory, 'fake-docker', `
    const fs = require('node:fs')
    const path = require('node:path')
    const args = process.argv.slice(2)
    const invocationLog = ${JSON.stringify(invocationLog)}
    const invocations = fs.existsSync(invocationLog) ? JSON.parse(fs.readFileSync(invocationLog, 'utf8')) : []
    invocations.push(args)
    fs.writeFileSync(invocationLog, JSON.stringify(invocations))
    const remoteFile = (value) => path.join(${JSON.stringify(directory)}, path.posix.basename(value))
    if (args[0] === 'exec' && args[1] !== 'custom-postgres') process.exit(10)
    if (args[0] === 'exec' && args.includes('pg_dump')) {
      fs.writeFileSync(remoteFile(args.at(-1)), Buffer.from('docker dump'))
      process.exit(0)
    }
    if (args[0] === 'cp') {
      if (!args[1].startsWith('custom-postgres:')) process.exit(10)
      fs.copyFileSync(remoteFile(args[1].split(':').slice(1).join(':')), args[2])
      process.exit(0)
    }
    if (args[0] === 'exec' && args[2] === 'rm') {
      try { fs.rmSync(remoteFile(args.at(-1)), { force: true }) } catch {}
      process.exit(0)
    }
    process.exit(12)
  `)

  const result = runBackup({
    DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/monrad_estimator',
    MONRAD_DB_CONTAINER: 'custom-postgres',
    MONRAD_DB_MODE: 'docker',
    ...dockerEnv(docker),
    MONRAD_BACKUP_DIR: backupDir,
  })

  assert.equal(result.status, 0, result.stderr)
  const files = fs.readdirSync(backupDir)
  assert.equal(files.length, 1)
  assert.deepEqual(fs.readFileSync(path.join(backupDir, files[0])), Buffer.from('docker dump'))
  const invocations = JSON.parse(fs.readFileSync(invocationLog, 'utf8'))
  assert.deepEqual(invocations.map(args => args[0]), ['exec', 'cp', 'exec'])
  for (const args of invocations) {
    if (args[0] === 'cp') assert.match(args[1], /^custom-postgres:/)
    else assert.equal(args[1], 'custom-postgres')
  }
})
test('container override alone keeps the conservative host mode', (t) => {
  const directory = createTempDirectory()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const backupDir = path.join(directory, 'backups')
  const dockerMarker = path.join(directory, 'docker.marker')
  const docker = writeFixture(directory, 'unexpected-docker', `
    require('node:fs').writeFileSync(${JSON.stringify(dockerMarker)}, 'invoked')
    process.exit(1)
  `)
  const pgDump = writeFixture(directory, 'host-pg-dump', `
    require('node:fs').writeFileSync(process.argv[process.argv.indexOf('--file') + 1], Buffer.from('host fixture'))
  `)

  const result = runBackup({
    DATABASE_URL: 'postgresql://postgres@localhost:5432/host_default_db',
    MONRAD_DB_CONTAINER: 'custom-postgres',
    ...dockerEnv(docker),
    ...pgDumpEnv(pgDump),
    MONRAD_BACKUP_DIR: backupDir,
  })

  assert.equal(result.status, 0, result.stderr)
  const files = fs.readdirSync(backupDir)
  assert.equal(files.length, 1)
  assert.deepEqual(fs.readFileSync(path.join(backupDir, files[0])), Buffer.from('host fixture'))
  assert.equal(fs.existsSync(dockerMarker), false)
})

test('explicit host mode ignores the Docker container override', (t) => {
  const directory = createTempDirectory()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const backupDir = path.join(directory, 'backups')
  const dockerMarker = path.join(directory, 'docker.marker')
  const docker = writeFixture(directory, 'unexpected-docker', `
    require('node:fs').writeFileSync(${JSON.stringify(dockerMarker)}, 'invoked')
    process.exit(1)
  `)
  const pgDump = writeFixture(directory, 'host-pg-dump', `
    require('node:fs').writeFileSync(process.argv[process.argv.indexOf('--file') + 1], Buffer.from('explicit host fixture'))
  `)

  const result = runBackup({
    DATABASE_URL: 'postgresql://postgres@localhost:5432/host_explicit_db',
    MONRAD_DB_MODE: 'host',
    MONRAD_DB_CONTAINER: 'custom-postgres',
    ...dockerEnv(docker),
    ...pgDumpEnv(pgDump),
    MONRAD_BACKUP_DIR: backupDir,
  })

  assert.equal(result.status, 0, result.stderr)
  const files = fs.readdirSync(backupDir)
  assert.equal(files.length, 1)
  assert.deepEqual(fs.readFileSync(path.join(backupDir, files[0])), Buffer.from('explicit host fixture'))
  assert.equal(fs.existsSync(dockerMarker), false)
})


test('failed Docker backup removes the local dump and attempts remote cleanup', (t) => {
  const directory = createTempDirectory()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const backupDir = path.join(directory, 'backups')
  const cleanupMarker = path.join(directory, 'cleanup.marker')
  const docker = writeFixture(directory, 'failing-docker', `
    const fs = require('node:fs')
    const path = require('node:path')
    const args = process.argv.slice(2)
    const remoteFile = (value) => path.join(${JSON.stringify(directory)}, path.posix.basename(value))
    if (args[0] === 'exec' && args.includes('pg_dump')) {
      fs.writeFileSync(remoteFile(args.at(-1)), Buffer.from('remote dump'))
      process.exit(0)
    }
    if (args[0] === 'cp') process.exit(31)
    if (args[0] === 'exec' && args[2] === 'rm') {
      fs.writeFileSync(${JSON.stringify(cleanupMarker)}, args.at(-1))
      fs.rmSync(remoteFile(args.at(-1)), { force: true })
      process.exit(0)
    }
    process.exit(12)
  `)

  const result = runBackup({
    DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/monrad_estimator',
    MONRAD_DB_CONTAINER: 'monrad-pg',
    MONRAD_DB_MODE: 'docker',
    ...dockerEnv(docker),
    MONRAD_BACKUP_DIR: backupDir,
  })

  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /Docker backup command .*failed with exit code 31/)
  assert.deepEqual(fs.existsSync(backupDir) ? fs.readdirSync(backupDir) : [], [])
  assert.ok(fs.existsSync(cleanupMarker))
  assert.equal(fs.existsSync(fs.readFileSync(cleanupMarker, 'utf8')), false)
})

test('fails safely when the Docker executable is unavailable', (t) => {
  const directory = createTempDirectory()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const backupDir = path.join(directory, 'backups')
  const databaseUrl = 'postgresql://postgres:missing-docker-secret@localhost:5432/docker_missing_db'
  const result = runBackup({
    DATABASE_URL: databaseUrl,
    MONRAD_DB_CONTAINER: 'monrad-pg',
    MONRAD_DB_MODE: 'docker',
    MONRAD_DOCKER_COMMAND: path.join(directory, 'missing-docker'),
    MONRAD_BACKUP_DIR: backupDir,
  })

  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /Docker backup command .* is unavailable/)
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, new RegExp(databaseUrl))
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /missing-docker-secret/)
  assert.deepEqual(fs.existsSync(backupDir) ? fs.readdirSync(backupDir) : [], [])
})

test('Docker pg_dump failure skips copy, cleans remotely, and leaves no local dump', (t) => {
  const directory = createTempDirectory()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const backupDir = path.join(directory, 'backups')
  const invocationLog = path.join(directory, 'docker-invocations.json')
  const dumpMarker = path.join(directory, 'dump.marker')
  const copyMarker = path.join(directory, 'copy.marker')
  const cleanupMarker = path.join(directory, 'cleanup.marker')
  const docker = writeFixture(directory, 'docker-pg-dump-failure', `
    const fs = require('node:fs')
    const path = require('node:path')
    const args = process.argv.slice(2)
    const invocationLog = ${JSON.stringify(invocationLog)}
    const invocations = fs.existsSync(invocationLog) ? JSON.parse(fs.readFileSync(invocationLog, 'utf8')) : []
    invocations.push(args)
    fs.writeFileSync(invocationLog, JSON.stringify(invocations))
    const remoteFile = (value) => path.join(${JSON.stringify(directory)}, path.posix.basename(value))
    if (args[0] === 'exec' && args.includes('pg_dump')) {
      fs.writeFileSync(${JSON.stringify(dumpMarker)}, 'invoked')
      fs.writeFileSync(remoteFile(args.at(-1)), Buffer.from('partial remote dump'))
      process.exit(29)
    }
    if (args[0] === 'cp') {
      fs.writeFileSync(${JSON.stringify(copyMarker)}, 'invoked')
      process.exit(0)
    }
    if (args[0] === 'exec' && args[2] === 'rm') {
      fs.writeFileSync(${JSON.stringify(cleanupMarker)}, args.at(-1))
      fs.rmSync(remoteFile(args.at(-1)), { force: true })
      process.exit(0)
    }
    process.exit(12)
  `)
  const databaseUrl = 'postgresql://postgres:docker-secret@localhost:5432/docker_failure_db'
  const result = runBackup({
    DATABASE_URL: databaseUrl,
    MONRAD_DB_CONTAINER: 'custom-postgres',
    MONRAD_DB_MODE: 'docker',
    ...dockerEnv(docker),
    MONRAD_BACKUP_DIR: backupDir,
  })

  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /Docker backup command .*failed with exit code 29/)
  assert.equal(fs.existsSync(dumpMarker), true)
  assert.equal(fs.existsSync(copyMarker), false)
  assert.equal(fs.existsSync(cleanupMarker), true)
  const invocations = JSON.parse(fs.readFileSync(invocationLog, 'utf8'))
  assert.deepEqual(invocations.map(args => args[0]), ['exec', 'exec'])
  assert.ok(invocations[0].includes('pg_dump'))
  assert.equal(invocations[1][2], 'rm')
  assert.deepEqual(fs.existsSync(backupDir) ? fs.readdirSync(backupDir) : [], [])
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, new RegExp(databaseUrl))
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /docker-secret/)
})

// ── validation ───────────────────────────────────────────────────────────

test('fails when DATABASE_URL is not set', (t) => {
  const directory = createTempDirectory()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))

  const result = runBackup({
    MONRAD_ENV_FILE: path.join(directory, 'missing.env'),
    MONRAD_DB_MODE: 'host',
  })

  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /DATABASE_URL is required/)
})

test('fails with invalid DATABASE_URL', (t) => {
  const directory = createTempDirectory()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))

  const result = runBackup({
    DATABASE_URL: 'not-a-valid-url',
    MONRAD_DB_MODE: 'host',
  })

  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /not a valid PostgreSQL connection URL/)
})

test('fails with invalid MONRAD_DB_MODE', (t) => {
  const directory = createTempDirectory()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))

  const result = runBackup({
    DATABASE_URL: 'postgresql://test:test@localhost:5432/test_db',
    MONRAD_DB_MODE: 'invalid',
  })

  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /must be either docker or host/)
})

// ── credential safety ────────────────────────────────────────────────────

test('does not expose database password in error output', (t) => {
  const directory = createTempDirectory()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const password = 'sentinel-password-never-print'
  const pgDump = writeFixture(directory, 'failing-pg-dump', 'process.exit(23)')

  const result = runBackup({
    DATABASE_URL: `postgresql://leaker:${password}@localhost:5432/leak_db`,
    MONRAD_DB_MODE: 'host',
    ...pgDumpEnv(pgDump),
    MONRAD_BACKUP_DIR: path.join(directory, 'backups'),
  })

  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /host backup command .*failed with exit code 23/)
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, new RegExp(password))
})

// ── automatic mode ───────────────────────────────────────────────────────

test('does not invoke Docker in automatic mode even when docker is on PATH', (t) => {
  const directory = createTempDirectory()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const backupDir = path.join(directory, 'backups')

  // Fake pg_dump that succeeds — host mode should use this.
  // No fake docker is needed: automatic mode defaults to host and never
  // invokes docker through resolveCommand('DOCKER', 'docker') when no
  // MONRAD_DOCKER_COMMAND or MONRAD_DOCKER_ARGS are set.
  const pgDump = writeFixture(directory, 'fake-pg-dump', `
    const fileIndex = process.argv.indexOf('--file')
    require('node:fs').writeFileSync(process.argv[fileIndex + 1], Buffer.from('auto-dump'))
  `)

  const result = spawnSync(process.execPath, [script], {
    cwd: repositoryRoot,
    env: (() => {
      // Build env from scratch for this test: start with clean slate,
      // strip all MONRAD_*, then set only what we need.
      const merged = { ...process.env }
      for (const key of Object.keys(merged)) {
        if (key.startsWith('MONRAD_')) delete merged[key]
      }
      merged.DATABASE_URL = 'postgresql://auto:detect@db.internal:5432/auto_db'
      merged.MONRAD_PG_DUMP_COMMAND = process.execPath
      merged.MONRAD_PG_DUMP_ARGS = JSON.stringify([pgDump])
      merged.MONRAD_BACKUP_DIR = backupDir
      return merged
    })(),
    encoding: 'utf8',
  })

  assert.equal(result.status, 0, result.stderr)
  assert.equal(fs.readdirSync(backupDir).length, 1)
})
test('automatic mode does not select a container for a different local URL port', (t) => {
  const directory = createTempDirectory()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const backupDir = path.join(directory, 'backups')
  const dockerMarker = path.join(directory, 'docker.marker')
  const docker = writeFixture(directory, 'fake-docker', `
    require('node:fs').writeFileSync(${JSON.stringify(dockerMarker)}, 'invoked')
    process.exit(0)
  `)
  const pgDump = writeFixture(directory, 'fake-pg-dump', `
    require('node:fs').writeFileSync(process.argv[process.argv.indexOf('--file') + 1], Buffer.from('host dump'))
  `)

  for (const databaseUrl of [
    'postgresql://postgres:postgres@localhost:55432/monrad_estimator',
    'postgresql://postgres:postgres@127.0.0.1:5432/monrad_estimator',
  ]) {
    const result = runBackup({
      DATABASE_URL: databaseUrl,
      ...dockerEnv(docker),
      ...pgDumpEnv(pgDump),
      MONRAD_BACKUP_DIR: backupDir,
    })
    assert.equal(result.status, 0, result.stderr)
  }

  assert.equal(fs.existsSync(dockerMarker), false)
  assert.equal(fs.readdirSync(backupDir).length, 2)
})

test('automatic mode does not select a stopped container', (t) => {
  const directory = createTempDirectory()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const backupDir = path.join(directory, 'backups')
  const dockerMarker = path.join(directory, 'docker.marker')
  const docker = writeFixture(directory, 'stopped-docker', `
    require('node:fs').writeFileSync(${JSON.stringify(dockerMarker)}, 'invoked')
    process.exit(1)
  `)
  const pgDump = writeFixture(directory, 'fake-pg-dump', `
    require('node:fs').writeFileSync(process.argv[process.argv.indexOf('--file') + 1], Buffer.from('host dump'))
  `)

  const result = runBackup({
    DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/monrad_estimator',
    ...dockerEnv(docker),
    ...pgDumpEnv(pgDump),
    MONRAD_BACKUP_DIR: backupDir,
  })

  assert.equal(result.status, 0, result.stderr)
  assert.equal(fs.existsSync(dockerMarker), false)
  assert.equal(fs.readdirSync(backupDir).length, 1)
})


// ── naming ───────────────────────────────────────────────────────────────

test('does not overwrite an existing backup file', (t) => {
  const directory = createTempDirectory()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const backupDir = path.join(directory, 'backups')
  const pgDump = writeFixture(directory, 'fake-pg-dump', `
    const fileIndex = process.argv.indexOf('--file')
    require('node:fs').writeFileSync(process.argv[fileIndex + 1], Buffer.from('dump'))
  `)

  const result1 = runBackup({
    DATABASE_URL: 'postgresql://dup:test@localhost:5432/dup_db',
    MONRAD_DB_MODE: 'host',
    ...pgDumpEnv(pgDump),
    MONRAD_BACKUP_DIR: backupDir,
  })
  assert.equal(result1.status, 0, result1.stderr)
  const result2 = runBackup({
    DATABASE_URL: 'postgresql://dup:test@localhost:5432/dup_db',
    MONRAD_DB_MODE: 'host',
    ...pgDumpEnv(pgDump),
    MONRAD_BACKUP_DIR: backupDir,
  })
  assert.equal(result2.status, 0, result2.stderr)

  const files = fs.readdirSync(backupDir)
  assert.equal(files.length, 2)
  assert.notEqual(files[0], files[1])
})

test('concurrent backups both succeed and produce intact files', async (t) => {
  const directory = createTempDirectory()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const backupDir = path.join(directory, 'backups')
  const pgDump = writeFixture(directory, 'fake-pg-dump', `
    const fileIndex = process.argv.indexOf('--file')
    require('node:fs').writeFileSync(process.argv[fileIndex + 1], Buffer.from(process.env.BACKUP_MARKER))
  `)

  const env = {
    DATABASE_URL: 'postgresql://concurrent:test@localhost:5432/concurrent_db',
    MONRAD_DB_MODE: 'host',
    ...pgDumpEnv(pgDump),
    MONRAD_BACKUP_DIR: backupDir,
  }

  const [r1, r2] = await Promise.all([
    runBackupAsync({ ...env, BACKUP_MARKER: 'first dump' }),
    runBackupAsync({ ...env, BACKUP_MARKER: 'second dump' }),
  ])

  assert.equal(r1.status, 0, r1.stderr)
  assert.equal(r2.status, 0, r2.stderr)

  const files = fs.readdirSync(backupDir)
  const dumpFiles = files.filter((f) => f.endsWith('.dump'))
  assert.equal(dumpFiles.length, 2, `expected 2 dump files, got: ${dumpFiles.join(', ')}`)
  assert.notEqual(dumpFiles[0], dumpFiles[1])

  const contents = dumpFiles.map((file) => fs.readFileSync(path.join(backupDir, file), 'utf8')).sort()
  assert.deepEqual(contents, ['first dump', 'second dump'])
  assert.equal(files.some((file) => file.includes('.tmp-')), false, `temporary files remain: ${files.join(', ')}`)
})

// ── credential portability ───────────────────────────────────────────────

test('handles URL-encoded credentials and decodes password for PGPASSWORD', (t) => {
  const directory = createTempDirectory()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const backupDir = path.join(directory, 'backups')
  const encodedUrl = 'postgresql://user%40domain:pass%23word@localhost:5432/encoded_db'
  const sanitizedUrl = new URL(encodedUrl)
  sanitizedUrl.password = ''
  const pgDump = writeFixture(directory, 'fake-pg-dump', `
    const args = process.argv.slice(2)
    const dbname = args[args.indexOf('--dbname') + 1]
    if (dbname !== ${JSON.stringify(sanitizedUrl.href)}) process.exit(11)
    if (process.env.PGPASSWORD !== 'pass#word') process.exit(13)
    const fileIndex = args.indexOf('--file')
    require('node:fs').writeFileSync(args[fileIndex + 1], Buffer.from('encoded dump'))
  `)

  const result = runBackup({
    DATABASE_URL: encodedUrl,
    MONRAD_DB_MODE: 'host',
    ...pgDumpEnv(pgDump),
    MONRAD_BACKUP_DIR: backupDir,
  })

  assert.equal(result.status, 0, result.stderr)
  assert.equal(fs.readdirSync(backupDir).length, 1)
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /pass%23word|pass#word/)
})

test('preserves raw non-password query components while removing query passwords', (t) => {
  const directory = createTempDirectory()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const cases = [
    ['password=secret&options=-c%20search_path%3Dfoo', 'options=-c%20search_path%3Dfoo'],
    ['application_name=a+b&password=secret', 'application_name=a+b'],
    ['application_name=a%2Bb&password=secret', 'application_name=a%2Bb'],
    ['value=~&password=secret', 'value=~'],
    ['password=secret&sslmode=require&connect_timeout=10', 'sslmode=require&connect_timeout=10'],
    ['one=1&password=secret&one=2', 'one=1&one=2'],
    ['empty=&password=secret&flag', 'empty=&flag'],
  ]

  for (const [index, [rawQuery, expectedQuery]] of cases.entries()) {
    const backupDir = path.join(directory, `backups-${index}`)
    const databaseUrl = `postgresql://qry:secret@db.example.test:5432/qry_db?${rawQuery}`
    const expectedUrl = `postgresql://qry@db.example.test:5432/qry_db?${expectedQuery}`
    const result = runBackup({
      DATABASE_URL: databaseUrl,
      MONRAD_DB_MODE: 'host',
      ...credentialPgDump(directory, expectedUrl, 'secret', `raw query dump ${index}`),
      MONRAD_BACKUP_DIR: backupDir,
    })

    assert.equal(result.status, 0, `${rawQuery}: ${result.stderr}`)
    const files = fs.readdirSync(backupDir)
    assert.equal(files.length, 1, rawQuery)
    assert.deepEqual(fs.readFileSync(path.join(backupDir, files[0])), Buffer.from(`raw query dump ${index}`))
  }
})

test('takes a query-string password out of argv and passes it through PGPASSWORD', (t) => {
  const directory = createTempDirectory()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const backupDir = path.join(directory, 'backups')
  const databaseUrl = 'postgresql://query-user@db.example.test:5432/query_db?password=query-secret&sslmode=require'
  const result = runBackup({
    DATABASE_URL: databaseUrl,
    MONRAD_DB_MODE: 'host',
    ...credentialPgDump(directory, sanitizedDatabaseUrl(databaseUrl), 'query-secret'),
    MONRAD_BACKUP_DIR: backupDir,
  })

  assert.equal(result.status, 0, result.stderr)
  assert.equal(fs.readdirSync(backupDir).length, 1)
})

test('decodes a URL-encoded query-string password for PGPASSWORD', (t) => {
  const directory = createTempDirectory()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const backupDir = path.join(directory, 'backups')
  const databaseUrl = 'postgresql://query-user@localhost:5432/query_db?password=pass%23word'
  const result = runBackup({
    DATABASE_URL: databaseUrl,
    MONRAD_DB_MODE: 'host',
    ...credentialPgDump(directory, sanitizedDatabaseUrl(databaseUrl), 'pass#word'),
    MONRAD_BACKUP_DIR: backupDir,
  })

  assert.equal(result.status, 0, result.stderr)
  assert.equal(fs.readdirSync(backupDir).length, 1)
})

test('preserves a literal plus in a query-string password', (t) => {
  const directory = createTempDirectory()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const backupDir = path.join(directory, 'backups')
  const databaseUrl = 'postgresql://query-user@localhost:5432/query_db?password=a+b'
  const result = runBackup({
    DATABASE_URL: databaseUrl,
    MONRAD_DB_MODE: 'host',
    ...credentialPgDump(directory, sanitizedDatabaseUrl(databaseUrl), 'a+b'),
    MONRAD_BACKUP_DIR: backupDir,
  })

  assert.equal(result.status, 0, result.stderr)
  assert.equal(fs.readdirSync(backupDir).length, 1)
})

test('accepts matching authority and query-string passwords', (t) => {
  const directory = createTempDirectory()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const backupDir = path.join(directory, 'backups')
  const databaseUrl = 'postgresql://query-user:shared-secret@localhost:5432/query_db?password=shared-secret'
  const result = runBackup({
    DATABASE_URL: databaseUrl,
    MONRAD_DB_MODE: 'host',
    ...credentialPgDump(directory, sanitizedDatabaseUrl(databaseUrl), 'shared-secret'),
    MONRAD_BACKUP_DIR: backupDir,
  })

  assert.equal(result.status, 0, result.stderr)
  assert.equal(fs.readdirSync(backupDir).length, 1)
})

test('rejects conflicting authority and query-string passwords before invoking pg_dump', (t) => {
  const directory = createTempDirectory()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const backupDir = path.join(directory, 'backups')
  const marker = path.join(directory, 'pg-dump.marker')
  const databaseUrl = 'postgresql://query-user:authority%23secret@localhost:5432/query_db?password=query%2Bsecret'
  const result = runBackup({
    DATABASE_URL: databaseUrl,
    MONRAD_DB_MODE: 'host',
    ...markerPgDump(directory, marker),
    MONRAD_BACKUP_DIR: backupDir,
  })
  const output = `${result.stdout}\n${result.stderr}`

  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /authority and query passwords conflict/)
  assert.equal(fs.existsSync(marker), false)
  assert.deepEqual(fs.existsSync(backupDir) ? fs.readdirSync(backupDir) : [], [])
  for (const value of ['authority%23secret', 'authority#secret', 'query%2Bsecret', 'query+secret', databaseUrl]) {
    assert.equal(output.includes(value), false, `credential leaked: ${value}`)
  }
})

test('rejects multiple query-string passwords before invoking pg_dump', (t) => {
  const directory = createTempDirectory()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const backupDir = path.join(directory, 'backups')
  const marker = path.join(directory, 'pg-dump.marker')
  const databaseUrl = 'postgresql://query-user@localhost:5432/query_db?password=one%23&password=two%2B'
  const result = runBackup({
    DATABASE_URL: databaseUrl,
    MONRAD_DB_MODE: 'host',
    ...markerPgDump(directory, marker),
    MONRAD_BACKUP_DIR: backupDir,
  })
  const output = `${result.stdout}\n${result.stderr}`

  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /at most one password query parameter/)
  assert.equal(fs.existsSync(marker), false)
  assert.deepEqual(fs.existsSync(backupDir) ? fs.readdirSync(backupDir) : [], [])
  for (const value of ['one%23', 'one#', 'two%2B', 'two+', databaseUrl]) {
    assert.equal(output.includes(value), false, `credential leaked: ${value}`)
  }
})

test('does not set PGPASSWORD when URL has no password', (t) => {
  const directory = createTempDirectory()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const backupDir = path.join(directory, 'backups')
  const noPassUrl = 'postgresql://nopass@localhost:5432/nopass_db'
  const sanitizedUrl = new URL(noPassUrl)
  sanitizedUrl.password = ''
  const pgDump = writeFixture(directory, 'fake-pg-dump', `
    const args = process.argv.slice(2)
    const dbname = args[args.indexOf('--dbname') + 1]
    if (dbname !== ${JSON.stringify(sanitizedUrl.href)}) process.exit(11)
    if ('PGPASSWORD' in process.env) process.exit(14)
    const fileIndex = args.indexOf('--file')
    require('node:fs').writeFileSync(args[fileIndex + 1], Buffer.from('nopass dump'))
  `)

  const env = (() => {
    const merged = { ...process.env }
    for (const key of Object.keys(merged)) {
      if (key.startsWith('MONRAD_')) delete merged[key]
    }
    merged.PGPASSWORD = 'inherited-secret'
    merged.DATABASE_URL = noPassUrl
    merged.MONRAD_PG_DUMP_COMMAND = process.execPath
    merged.MONRAD_PG_DUMP_ARGS = JSON.stringify([pgDump])
    merged.MONRAD_BACKUP_DIR = backupDir
    return merged
  })()
  const result = spawnSync(process.execPath, [script], { cwd: repositoryRoot, env, encoding: 'utf8' })

  assert.equal(result.status, 0, result.stderr)
  assert.equal(fs.readdirSync(backupDir).length, 1)
})

test('does not mutate parent process.env with PGPASSWORD', (t) => {
  const before = process.env.PGPASSWORD
  const directory = createTempDirectory()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const backupDir = path.join(directory, 'backups')
  const pgDump = writeFixture(directory, 'fake-pg-dump', `
    const fs = require('node:fs')
    const fileIndex = process.argv.indexOf('--file')
    fs.writeFileSync(process.argv[fileIndex + 1], Buffer.from('immutable'))
  `)
  const result = runBackup({
    DATABASE_URL: 'postgresql://immutable:secret@localhost:5432/immutable_db',
    MONRAD_DB_MODE: 'host',
    ...pgDumpEnv(pgDump),
    MONRAD_BACKUP_DIR: backupDir,
  })

  assert.equal(result.status, 0, result.stderr)
  assert.equal(process.env.PGPASSWORD, before)
  assert.equal(fs.readdirSync(backupDir).length, 1)
})
