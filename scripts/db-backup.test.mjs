import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
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
  'MONRAD_PG_DUMP_COMMAND',
  'MONRAD_BACKUP_DIR',
]
function createTempDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'monrad-db-backup-'))
}

function createExecutable(directory, name, source) {
  const filename = path.join(directory, name)
  fs.writeFileSync(filename, `#!/usr/bin/env node\n${source}`)
  fs.chmodSync(filename, 0o755)
  return filename
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

// ── host mode ────────────────────────────────────────────────────────────

test('backs up the configured host database with pg_dump and verifies the dump', (t) => {
  const directory = createTempDirectory()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const backupDir = path.join(directory, 'backups')
  const configuredUrl = 'postgresql://configured:secret@db.example.test:5432/configured_db'
  const pgDump = createExecutable(directory, 'fake-pg-dump', `
    const args = process.argv.slice(2)
    if (args[args.indexOf('--dbname') + 1] !== ${JSON.stringify(configuredUrl)}) process.exit(11)
    const fileIndex = args.indexOf('--file')
    require('node:fs').writeFileSync(args[fileIndex + 1], Buffer.from('valid dump'))
  `)

  const result = runBackup({
    DATABASE_URL: configuredUrl,
    MONRAD_DB_MODE: 'host',
    MONRAD_PG_DUMP_COMMAND: pgDump,
    MONRAD_BACKUP_DIR: backupDir,
  })

  assert.equal(result.status, 0, result.stderr)
  const files = fs.readdirSync(backupDir)
  assert.equal(files.length, 1)
  assert.match(files[0], /^backup-\d{8}-\d{6}\.dump$/)
  assert.deepEqual(fs.readFileSync(path.join(backupDir, files[0])), Buffer.from('valid dump'))
})

test('loads DATABASE_URL from MONRAD_ENV_FILE without touching server/.env', (t) => {
  const directory = createTempDirectory()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const backupDir = path.join(directory, 'backups')
  const pgDump = createExecutable(directory, 'fake-pg-dump', `
    const args = process.argv.slice(2)
    if (!args.includes('postgresql://env-user:env-secret@localhost:5432/env_db')) process.exit(11)
    const fileIndex = args.indexOf('--file')
    require('node:fs').writeFileSync(args[fileIndex + 1], Buffer.from('env-config dump'))
  `)
  const envFile = path.join(directory, 'test.env')
  fs.writeFileSync(envFile, 'DATABASE_URL="postgresql://env-user:env-secret@localhost:5432/env_db"\n')

  const result = runBackup({
    MONRAD_ENV_FILE: envFile,
    MONRAD_DB_MODE: 'host',
    MONRAD_PG_DUMP_COMMAND: pgDump,
    MONRAD_BACKUP_DIR: backupDir,
  })

  assert.equal(result.status, 0, result.stderr)
  assert.equal(fs.readdirSync(backupDir).length, 1)
})

test('fails without leaving a dump when pg_dump fails', (t) => {
  const directory = createTempDirectory()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const backupDir = path.join(directory, 'backups')
  const pgDump = createExecutable(directory, 'failing-pg-dump', 'process.exit(7)')

  const result = runBackup({
    DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/monrad_estimator',
    MONRAD_DB_MODE: 'host',
    MONRAD_PG_DUMP_COMMAND: pgDump,
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
  const pgDump = createExecutable(directory, 'empty-pg-dump', `
    const fileIndex = process.argv.indexOf('--file')
    require('node:fs').writeFileSync(process.argv[fileIndex + 1], Buffer.alloc(0))
  `)

  const result = runBackup({
    DATABASE_URL: 'postgresql://empty:test@localhost:5432/empty_db',
    MONRAD_DB_MODE: 'host',
    MONRAD_PG_DUMP_COMMAND: pgDump,
    MONRAD_BACKUP_DIR: backupDir,
  })

  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /empty/)
  assert.equal(fs.existsSync(backupDir) ? fs.readdirSync(backupDir).length : 0, 0)
})

// ── Docker mode ──────────────────────────────────────────────────────────

test('backs up through explicit Docker container and cleans remote dump', (t) => {
  const directory = createTempDirectory()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const backupDir = path.join(directory, 'backups')
  const docker = createExecutable(directory, 'fake-docker', `
    const fs = require('node:fs')
    const args = process.argv.slice(2)
    if (args[0] === 'exec' && args.includes('pg_dump')) {
      fs.writeFileSync(args.at(-1), Buffer.from('docker dump'))
      process.exit(0)
    }
    if (args[0] === 'cp') {
      fs.copyFileSync(args[1].split(':').slice(1).join(':'), args[2])
      process.exit(0)
    }
    if (args[0] === 'exec' && args[2] === 'rm') {
      try { fs.rmSync(args.at(-1), { force: true }) } catch {}
      process.exit(0)
    }
    process.exit(12)
  `)

  const result = runBackup({
    DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/monrad_estimator',
    MONRAD_DB_CONTAINER: 'monrad-pg',
    MONRAD_DB_MODE: 'docker',
    MONRAD_DOCKER_COMMAND: docker,
    MONRAD_BACKUP_DIR: backupDir,
  })

  assert.equal(result.status, 0, result.stderr)
  const files = fs.readdirSync(backupDir)
  assert.equal(files.length, 1)
  assert.deepEqual(fs.readFileSync(path.join(backupDir, files[0])), Buffer.from('docker dump'))
})

test('failed Docker backup removes the local dump and attempts remote cleanup', (t) => {
  const directory = createTempDirectory()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const backupDir = path.join(directory, 'backups')
  const cleanupMarker = path.join(directory, 'cleanup.marker')
  const docker = createExecutable(directory, 'failing-docker', `
    const fs = require('node:fs')
    const args = process.argv.slice(2)
    if (args[0] === 'exec' && args.includes('pg_dump')) {
      fs.writeFileSync(args.at(-1), Buffer.from('remote dump'))
      process.exit(0)
    }
    if (args[0] === 'cp') process.exit(31)
    if (args[0] === 'exec' && args[2] === 'rm') {
      fs.writeFileSync(${JSON.stringify(cleanupMarker)}, args.at(-1))
      fs.rmSync(args.at(-1), { force: true })
      process.exit(0)
    }
    process.exit(12)
  `)

  const result = runBackup({
    DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/monrad_estimator',
    MONRAD_DB_CONTAINER: 'monrad-pg',
    MONRAD_DB_MODE: 'docker',
    MONRAD_DOCKER_COMMAND: docker,
    MONRAD_BACKUP_DIR: backupDir,
  })

  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /Docker backup command .*failed with exit code 31/)
  assert.deepEqual(fs.existsSync(backupDir) ? fs.readdirSync(backupDir) : [], [])
  assert.ok(fs.existsSync(cleanupMarker))
  assert.equal(fs.existsSync(fs.readFileSync(cleanupMarker, 'utf8')), false)
})

// ── validation ───────────────────────────────────────────────────────────

test('fails when DATABASE_URL is not set', (t) => {
  const directory = createTempDirectory()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))

  const result = runBackup({
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
  const pgDump = createExecutable(directory, 'failing-pg-dump', 'process.exit(1)')

  const result = runBackup({
    DATABASE_URL: 'postgresql://leaker:s3kr3t-p@ss@localhost:5432/leak_db',
    MONRAD_DB_MODE: 'host',
    MONRAD_PG_DUMP_COMMAND: pgDump,
    MONRAD_BACKUP_DIR: path.join(directory, 'backups'),
  })

  assert.notEqual(result.status, 0)
  // The password must never appear in stderr (or anywhere in output)
  assert.doesNotMatch(result.stderr, /s3kr3t-p@ss/)
  assert.doesNotMatch(result.stdout, /s3kr3t-p@ss/)
})

// ── automatic mode ───────────────────────────────────────────────────────

test('does not invoke Docker in automatic mode even when docker is on PATH', (t) => {
  const directory = createTempDirectory()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const backupDir = path.join(directory, 'backups')

  // Fake pg_dump that succeeds — host mode should use this.
  const pgDump = createExecutable(directory, 'fake-pg-dump', `
    const fileIndex = process.argv.indexOf('--file')
    require('node:fs').writeFileSync(process.argv[fileIndex + 1], Buffer.from('auto-dump'))
  `)

  // Fake docker that exits non-zero if ever invoked — automatic mode must
  // NOT call it (no MONRAD_DB_MODE, no MONRAD_DB_CONTAINER).
  createExecutable(directory, 'docker', 'process.exit(99)')

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
      merged.MONRAD_PG_DUMP_COMMAND = pgDump
      merged.MONRAD_BACKUP_DIR = backupDir
      // Prepend temp dir so our fake docker shadows any system docker.
      merged.PATH = `${directory}:${merged.PATH}`
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
  const docker = createExecutable(directory, 'fake-docker', `
    require('node:fs').writeFileSync(${JSON.stringify(dockerMarker)}, 'invoked')
    process.exit(0)
  `)
  const pgDump = createExecutable(directory, 'fake-pg-dump', `
    require('node:fs').writeFileSync(process.argv[process.argv.indexOf('--file') + 1], Buffer.from('host dump'))
  `)

  for (const databaseUrl of [
    'postgresql://postgres:postgres@localhost:55432/monrad_estimator',
    'postgresql://postgres:postgres@127.0.0.1:5432/monrad_estimator',
  ]) {
    const result = runBackup({
      DATABASE_URL: databaseUrl,
      MONRAD_DOCKER_COMMAND: docker,
      MONRAD_PG_DUMP_COMMAND: pgDump,
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
  const docker = createExecutable(directory, 'stopped-docker', `
    require('node:fs').writeFileSync(${JSON.stringify(dockerMarker)}, 'invoked')
    process.exit(1)
  `)
  const pgDump = createExecutable(directory, 'fake-pg-dump', `
    require('node:fs').writeFileSync(process.argv[process.argv.indexOf('--file') + 1], Buffer.from('host dump'))
  `)

  const result = runBackup({
    DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/monrad_estimator',
    MONRAD_DOCKER_COMMAND: docker,
    MONRAD_PG_DUMP_COMMAND: pgDump,
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
  const pgDump = createExecutable(directory, 'fake-pg-dump', `
    const fileIndex = process.argv.indexOf('--file')
    require('node:fs').writeFileSync(process.argv[fileIndex + 1], Buffer.from('dump'))
  `)

  const result1 = runBackup({
    DATABASE_URL: 'postgresql://dup:test@localhost:5432/dup_db',
    MONRAD_DB_MODE: 'host',
    MONRAD_PG_DUMP_COMMAND: pgDump,
    MONRAD_BACKUP_DIR: backupDir,
  })
  assert.equal(result1.status, 0, result1.stderr)

  const result2 = runBackup({
    DATABASE_URL: 'postgresql://dup:test@localhost:5432/dup_db',
    MONRAD_DB_MODE: 'host',
    MONRAD_PG_DUMP_COMMAND: pgDump,
    MONRAD_BACKUP_DIR: backupDir,
  })
  assert.equal(result2.status, 0, result2.stderr)

  const files = fs.readdirSync(backupDir)
  assert.equal(files.length, 2)
  assert.notEqual(files[0], files[1])
})
