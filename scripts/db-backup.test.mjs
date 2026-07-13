import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'

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

// ── helpers ───────────────────────────────────────────────────────────────

function createTempDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'monrad-db-backup-'))
}

/** Create a cross-platform test helper executable.
 *
 * Writes a JavaScript implementation file.  The backup runner invokes .mjs
 * helpers through process.execPath, so this works on Windows without relying
 * on Unix shebangs, chmod, or shell wrappers.
 */
function createTestHelper(directory, name, source) {
  const mjsPath = path.join(directory, `${name}.mjs`)
  fs.writeFileSync(mjsPath, source)
  return mjsPath
}

function buildEnv(env) {
  const merged = { ...process.env, ...env }
  for (const key of controlledEnvironment) {
    if (!(key in env)) delete merged[key]
  }
  return merged
}

function runBackup(env) {
  return spawnSync(process.execPath, [script], {
    cwd: repositoryRoot,
    env: buildEnv(env),
    encoding: 'utf8',
  })
}

function collectProcess(child) {
  let stdout = '', stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', d => { stdout += d })
  child.stderr.on('data', d => { stderr += d })
  return new Promise((resolve, reject) => {
    child.on('close', code => resolve({ status: code, stdout, stderr }))
    child.on('error', reject)
  })
}

// ── host mode ────────────────────────────────────────────────────────────

test('backs up the configured host database with pg_dump and verifies the dump', (t) => {
  const directory = createTempDirectory()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const backupDir = path.join(directory, 'backups')
  const sanitizedUrl = 'postgresql://configured@db.example.test:5432/configured_db'
  const pgDump = createTestHelper(directory, 'fake-pg-dump', `
import fs from 'node:fs'
const args = process.argv.slice(2)
const dbnameIndex = args.indexOf('--dbname')
if (args[dbnameIndex + 1] !== ${JSON.stringify(sanitizedUrl)}) process.exit(11)
const fileIndex = args.indexOf('--file')
fs.writeFileSync(args[fileIndex + 1], Buffer.from('valid dump'))
  `)

  const result = runBackup({
    DATABASE_URL: 'postgresql://configured:secret@db.example.test:5432/configured_db',
    MONRAD_DB_MODE: 'host',
    MONRAD_PG_DUMP_COMMAND: pgDump,
    MONRAD_BACKUP_DIR: backupDir,
  })

  assert.equal(result.status, 0, result.stderr)
  const files = fs.readdirSync(backupDir)
  assert.equal(files.length, 1)
  assert.match(files[0], /^backup-\d{8}-\d{6}-[\da-f]{8}\.dump$/)
  assert.deepEqual(fs.readFileSync(path.join(backupDir, files[0])), Buffer.from('valid dump'))
})

test('loads DATABASE_URL from MONRAD_ENV_FILE without touching server/.env', (t) => {
  const directory = createTempDirectory()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const backupDir = path.join(directory, 'backups')
  const sanitizedUrl = 'postgresql://env-user@localhost:5432/env_db'
  const pgDump = createTestHelper(directory, 'env-file-pg-dump', `
import fs from 'node:fs'
const args = process.argv.slice(2)
const dbnameIndex = args.indexOf('--dbname')
if (args[dbnameIndex + 1] !== ${JSON.stringify(sanitizedUrl)}) process.exit(11)
const fileIndex = args.indexOf('--file')
fs.writeFileSync(args[fileIndex + 1], Buffer.from('env-config dump'))
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
  const pgDump = createTestHelper(directory, 'failing-pg-dump', 'process.exit(7)')

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
  const pgDump = createTestHelper(directory, 'empty-pg-dump', `
import fs from 'node:fs'
const fileIndex = process.argv.indexOf('--file')
fs.writeFileSync(process.argv[fileIndex + 1], Buffer.alloc(0))
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
  const docker = createTestHelper(directory, 'fake-docker', `
import fs from 'node:fs'
import path from 'node:path'
const args = process.argv.slice(2)
const localRemotePath = () => path.join(${JSON.stringify(directory)}, path.basename(args.at(-1)))
if (args[0] === 'exec' && args.includes('pg_dump')) {
  fs.writeFileSync(localRemotePath(), Buffer.from('docker dump'))
  process.exit(0)
}
if (args[0] === 'cp') {
  const remotePath = path.join(${JSON.stringify(directory)}, path.basename(args[1].split(':').slice(1).join(':')))
  fs.copyFileSync(remotePath, args[2])
  process.exit(0)
}
if (args[0] === 'exec' && args[2] === 'rm') {
  try { fs.rmSync(localRemotePath(), { force: true }) } catch {}
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
  const docker = createTestHelper(directory, 'failing-docker', `
import fs from 'node:fs'
import path from 'node:path'
const args = process.argv.slice(2)
const localRemotePath = () => path.join(${JSON.stringify(directory)}, path.basename(args.at(-1)))
if (args[0] === 'exec' && args.includes('pg_dump')) {
  fs.writeFileSync(localRemotePath(), Buffer.from('remote dump'))
  process.exit(0)
}
if (args[0] === 'cp') process.exit(31)
if (args[0] === 'exec' && args[2] === 'rm') {
  fs.writeFileSync(${JSON.stringify(cleanupMarker)}, localRemotePath())
  fs.rmSync(localRemotePath(), { force: true })
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

test('does not pass database password in pg_dump argv', (t) => {
  const directory = createTempDirectory()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const backupDir = path.join(directory, 'backups')
  const argvFile = path.join(directory, 'argv.json')
  const password = 'p@$$w0rd!'

  const pgDump = createTestHelper(directory, 'argv-pg-dump', `
import fs from 'node:fs'
const dbnameIndex = process.argv.indexOf('--dbname')
fs.writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify({ argv: process.argv, url: process.argv[dbnameIndex + 1] || '' }))
const fileIndex = process.argv.indexOf('--file')
fs.writeFileSync(process.argv[fileIndex + 1], Buffer.from('dump'))
  `)

  const result = runBackup({
    DATABASE_URL: `postgresql://user:${password}@localhost:5432/testdb`,
    MONRAD_DB_MODE: 'host',
    MONRAD_PG_DUMP_COMMAND: pgDump,
    MONRAD_BACKUP_DIR: backupDir,
  })

  assert.equal(result.status, 0, result.stderr)
  const recorded = JSON.parse(fs.readFileSync(argvFile, 'utf8'))
  for (const arg of recorded.argv) {
    assert.ok(!arg.includes(password), `argv contains password in: ${JSON.stringify(arg)}`)
  }
  assert.ok(!recorded.url.includes(password), '--dbname URL contains password')
})

test('sets PGPASSWORD for the pg_dump child process', (t) => {
  const directory = createTempDirectory()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const backupDir = path.join(directory, 'backups')
  const envFile = path.join(directory, 'env.json')
  const password = 'secret-password'

  const pgDump = createTestHelper(directory, 'env-pg-dump', `
import fs from 'node:fs'
fs.writeFileSync(${JSON.stringify(envFile)}, JSON.stringify({ PGPASSWORD: process.env.PGPASSWORD || null }))
const fileIndex = process.argv.indexOf('--file')
fs.writeFileSync(process.argv[fileIndex + 1], Buffer.from('dump'))
  `)

  const result = runBackup({
    DATABASE_URL: `postgresql://user:${password}@localhost:5432/testdb`,
    MONRAD_DB_MODE: 'host',
    MONRAD_PG_DUMP_COMMAND: pgDump,
    MONRAD_BACKUP_DIR: backupDir,
  })

  assert.equal(result.status, 0, result.stderr)
  const recorded = JSON.parse(fs.readFileSync(envFile, 'utf8'))
  assert.equal(recorded.PGPASSWORD, password)
})

test('does not set PGPASSWORD when URL has no password', (t) => {
  const directory = createTempDirectory()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const backupDir = path.join(directory, 'backups')
  const envFile = path.join(directory, 'env.json')

  const pgDump = createTestHelper(directory, 'no-pw-pg-dump', `
import fs from 'node:fs'
fs.writeFileSync(${JSON.stringify(envFile)}, JSON.stringify({ PGPASSWORD: process.env.PGPASSWORD || null }))
const fileIndex = process.argv.indexOf('--file')
fs.writeFileSync(process.argv[fileIndex + 1], Buffer.from('dump'))
  `)

  const result = runBackup({
    DATABASE_URL: 'postgresql://nopw@localhost:5432/nopw_db',
    MONRAD_DB_MODE: 'host',
    MONRAD_PG_DUMP_COMMAND: pgDump,
    MONRAD_BACKUP_DIR: backupDir,
  })

  assert.equal(result.status, 0, result.stderr)
  const recorded = JSON.parse(fs.readFileSync(envFile, 'utf8'))
  assert.equal(recorded.PGPASSWORD, null)
})

test('parent process.env.PGPASSWORD remains unchanged while child receives decoded password', (t) => {
  const directory = createTempDirectory()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const backupDir = path.join(directory, 'backups')
  const envFile = path.join(directory, 'env.json')
  const parentSentinel = 'parent-sentinel-pw'
  const urlDecodedPassword = 'p@ss'

  const pgDump = createTestHelper(directory, 'parent-env-pg-dump', `
import fs from 'node:fs'
const dbnameIndex = process.argv.indexOf('--dbname')
const url = dbnameIndex !== -1 ? process.argv[dbnameIndex + 1] : ''
fs.writeFileSync(${JSON.stringify(envFile)}, JSON.stringify({ url, PGPASSWORD: process.env.PGPASSWORD || null }))
const fileIndex = process.argv.indexOf('--file')
if (fileIndex !== -1) fs.writeFileSync(process.argv[fileIndex + 1], Buffer.from('dump'))
  `)

  const originalPgPassword = process.env.PGPASSWORD
  process.env.PGPASSWORD = parentSentinel
  t.after(() => {
    if (originalPgPassword === undefined) {
      delete process.env.PGPASSWORD
    } else {
      process.env.PGPASSWORD = originalPgPassword
    }
  })

  const result = runBackup({
    DATABASE_URL: `postgresql://user:${encodeURIComponent(urlDecodedPassword)}@localhost:5432/sentinel_db`,
    MONRAD_DB_MODE: 'host',
    MONRAD_PG_DUMP_COMMAND: pgDump,
    MONRAD_BACKUP_DIR: backupDir,
  })

  assert.equal(result.status, 0, result.stderr)

  // Parent's process.env.PGPASSWORD must still be the sentinel
  assert.equal(process.env.PGPASSWORD, parentSentinel,
    'parent process.env.PGPASSWORD was modified by child')

  const recorded = JSON.parse(fs.readFileSync(envFile, 'utf8'))

  // Child must receive the decoded URL password, not the parent sentinel
  assert.equal(recorded.PGPASSWORD, urlDecodedPassword,
    'child should receive decoded password from URL')
  assert.notEqual(recorded.PGPASSWORD, parentSentinel,
    'child must not inherit parent PGPASSWORD sentinel')

  // Sanitized --dbname URL must not contain the password in any form
  assert.ok(!recorded.url.includes(urlDecodedPassword),
    'sanitized --dbname URL leaks decoded password')
  assert.ok(!recorded.url.includes(encodeURIComponent(urlDecodedPassword)),
    'sanitized --dbname URL leaks percent-encoded password')
})

test('redacts URL/args from error output', (t) => {
  const directory = createTempDirectory()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const backupDir = path.join(directory, 'backups')
  const password = 'sentinel-password-never-print'

  // Unavailable command (not found on PATH) — error must not contain args or URL
  const result = runBackup({
    DATABASE_URL: `postgresql://leaker:${password}@localhost:5432/leak_db`,
    MONRAD_DB_MODE: 'host',
    MONRAD_PG_DUMP_COMMAND: path.join(directory, 'nonexistent-command'),
    MONRAD_BACKUP_DIR: backupDir,
  })

  assert.notEqual(result.status, 0)
  const combined = `${result.stdout}\n${result.stderr}`
  assert.doesNotMatch(combined, new RegExp(password.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.doesNotMatch(combined, /leak_db/)
})

// ── sanitized URL construction ──────────────────────────────────────────

const urlConstructionCases = [
  ['postgres protocol',     'postgres://user:pass@host:5432/db',                                'postgres://user@host:5432/db',                                                   'pass'],
  ['postgresql protocol',   'postgresql://user:pass@host:5432/db',                              'postgresql://user@host:5432/db',                                                 'pass'],
  ['encoded username',      'postgresql://user%40name:p%40ss@host:5432/db',                     'postgresql://user%40name@host:5432/db',                                           'p@ss'],
  ['encoded password chars','postgresql://user:p%40%24%25@host:5432/db',                        'postgresql://user@host:5432/db',                                                 'p@$%'],
  ['explicit default port', 'postgresql://user:pass@host:5432/db',                              'postgresql://user@host:5432/db',                                                 'pass'],
  ['no port (default)',     'postgresql://user:pass@host/db',                                   'postgresql://user@host/db',                                                      'pass'],
  ['IPv4 address',          'postgresql://user:pass@192.168.1.1:5432/db',                       'postgresql://user@192.168.1.1:5432/db',                                          'pass'],
  ['IPv6 address',          'postgresql://user:pass@[::1]:5432/db',                             'postgresql://user@[::1]:5432/db',                                               'pass'],
  ['encoded database name', 'postgresql://user:pass@host:5432/db%20name',                       'postgresql://user@host:5432/db%20name',                                          'pass'],
  ['query parameters',      'postgresql://user:pass@host:5432/db?sslmode=require',              'postgresql://user@host:5432/db?sslmode=require',                                 'pass'],
  ['hostname with dots',    'postgresql://user:pass@db.example.internal:5432/db',               'postgresql://user@db.example.internal:5432/db',                                  'pass'],
  ['no password in URL',    'postgresql://user@host:5432/db',                                   'postgresql://user@host:5432/db',                                                 null],
]

for (const [label, inputUrl, expectedUrl, expectedPassword] of urlConstructionCases) {
  test(`sanitized URL: ${label}`, (t) => {
    const directory = createTempDirectory()
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
    const backupDir = path.join(directory, 'backups')
    const urlFile = path.join(directory, 'url.json')

    const pgDump = createTestHelper(directory, label.replace(/\s+/g, '-'), `
import fs from 'node:fs'
const dbnameIndex = process.argv.indexOf('--dbname')
const url = dbnameIndex !== -1 ? process.argv[dbnameIndex + 1] : ''
fs.writeFileSync(${JSON.stringify(urlFile)}, JSON.stringify({ url, PGPASSWORD: process.env.PGPASSWORD || null }))
const fileIndex = process.argv.indexOf('--file')
if (fileIndex !== -1) fs.writeFileSync(process.argv[fileIndex + 1], Buffer.from('dump'))
    `)

    const result = runBackup({
      DATABASE_URL: inputUrl,
      MONRAD_DB_MODE: 'host',
      MONRAD_PG_DUMP_COMMAND: pgDump,
      MONRAD_BACKUP_DIR: backupDir,
    })

    assert.equal(result.status, 0, `${label}: ${result.stderr}`)
    const recorded = JSON.parse(fs.readFileSync(urlFile, 'utf8'))
    assert.equal(recorded.url, expectedUrl, `sanitized URL mismatch for ${inputUrl}`)
    if (expectedPassword === null) {
      assert.equal(recorded.PGPASSWORD, null, `expected no PGPASSWORD for ${inputUrl}`)
    } else {
      assert.equal(recorded.PGPASSWORD, expectedPassword, `PGPASSWORD mismatch for ${inputUrl}`)
    }
  })
}

// ── host default mode ─────────────────────────────────────────────────────

test('defaults to host mode when MONRAD_DB_MODE is unset', (t) => {
  const directory = createTempDirectory()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const backupDir = path.join(directory, 'backups')

  const pgDump = createTestHelper(directory, 'default-host-pg-dump', `
import fs from 'node:fs'
const fileIndex = process.argv.indexOf('--file')
fs.writeFileSync(process.argv[fileIndex + 1], Buffer.from('default-dump'))
  `)

  // With no MONRAD_DB_MODE and no MONRAD_DB_CONTAINER, script must default to host
  const result = runBackup({
    DATABASE_URL: 'postgresql://default:host@localhost:5432/default_db',
    MONRAD_PG_DUMP_COMMAND: pgDump,
    MONRAD_BACKUP_DIR: backupDir,
  })

  assert.equal(result.status, 0, result.stderr)
  assert.equal(fs.readdirSync(backupDir).length, 1)
})

// ── finalization ──────────────────────────────────────────────────────────

test('does not overwrite an existing backup file', (t) => {
  const directory = createTempDirectory()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const backupDir = path.join(directory, 'backups')
  const pgDump = createTestHelper(directory, 'non-overwrite-pg-dump', `
import fs from 'node:fs'
const fileIndex = process.argv.indexOf('--file')
fs.writeFileSync(process.argv[fileIndex + 1], Buffer.from('dump'))
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

test('concurrent backups produce unique files', async (t) => {
  const directory = createTempDirectory()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const backupDir = path.join(directory, 'backups')
  const pgDump = createTestHelper(directory, 'conc-pg-dump', `
import fs from 'node:fs'
const fileIndex = process.argv.indexOf('--file')
fs.writeFileSync(process.argv[fileIndex + 1], Buffer.from('conc-dump'))
  `)

  const env = buildEnv({
    DATABASE_URL: 'postgresql://conc:test@localhost:5432/conc_db',
    MONRAD_DB_MODE: 'host',
    MONRAD_PG_DUMP_COMMAND: pgDump,
    MONRAD_BACKUP_DIR: backupDir,
  })

  const child1 = spawn(process.execPath, [script], { cwd: repositoryRoot, env, encoding: 'utf8' })
  const child2 = spawn(process.execPath, [script], { cwd: repositoryRoot, env, encoding: 'utf8' })

  const [r1, r2] = await Promise.all([collectProcess(child1), collectProcess(child2)])

  assert.equal(r1.status, 0, r1.stderr)
  assert.equal(r2.status, 0, r2.stderr)

  const files = fs.readdirSync(backupDir)
  assert.equal(files.length, 2)
  assert.notEqual(files[0], files[1])
})

// ── env precedence ────────────────────────────────────────────────────────

test('environment variable takes precedence over MONRAD_ENV_FILE', (t) => {
  const directory = createTempDirectory()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const backupDir = path.join(directory, 'backups')
  const sanitizedUrl = 'postgresql://winner@localhost:5432/winner_db'
  const pgDump = createTestHelper(directory, 'precedence-pg-dump', `
import fs from 'node:fs'
const args = process.argv.slice(2)
const dbnameIndex = args.indexOf('--dbname')
if (args[dbnameIndex + 1] !== ${JSON.stringify(sanitizedUrl)}) process.exit(11)
const fileIndex = args.indexOf('--file')
fs.writeFileSync(args[fileIndex + 1], Buffer.from('precedence dump'))
  `)
  const envFile = path.join(directory, 'override.env')
  // This URL in the env file must NOT be used — DATABASE_URL env var should win
  fs.writeFileSync(envFile, 'DATABASE_URL="postgresql://loser:lost@localhost:5432/loser_db"\n')

  const result = runBackup({
    DATABASE_URL: 'postgresql://winner:win@localhost:5432/winner_db',
    MONRAD_ENV_FILE: envFile,
    MONRAD_DB_MODE: 'host',
    MONRAD_PG_DUMP_COMMAND: pgDump,
    MONRAD_BACKUP_DIR: backupDir,
  })

  assert.equal(result.status, 0, result.stderr)
  assert.equal(fs.readdirSync(backupDir).length, 1)
})

test('reads DATABASE_URL from MONRAD_ENV_FILE when no env var is set', (t) => {
  const directory = createTempDirectory()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const backupDir = path.join(directory, 'backups')
  const sanitizedUrl = 'postgresql://fileonly@localhost:5432/fileonly_db'
  const pgDump = createTestHelper(directory, 'fileonly-pg-dump', `
import fs from 'node:fs'
const args = process.argv.slice(2)
const dbnameIndex = args.indexOf('--dbname')
if (args[dbnameIndex + 1] !== ${JSON.stringify(sanitizedUrl)}) process.exit(11)
const fileIndex = args.indexOf('--file')
fs.writeFileSync(args[fileIndex + 1], Buffer.from('fileonly dump'))
  `)
  const envFile = path.join(directory, 'fileonly.env')
  fs.writeFileSync(envFile, 'DATABASE_URL="postgresql://fileonly:test@localhost:5432/fileonly_db"\n')

  const result = runBackup({
    MONRAD_ENV_FILE: envFile,
    MONRAD_DB_MODE: 'host',
    MONRAD_PG_DUMP_COMMAND: pgDump,
    MONRAD_BACKUP_DIR: backupDir,
  })

  assert.equal(result.status, 0, result.stderr)
  assert.equal(fs.readdirSync(backupDir).length, 1)
})
