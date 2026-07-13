import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const repositoryRoot = path.resolve(import.meta.dirname, '..')
const script = path.join(repositoryRoot, 'scripts', 'db-backup.mjs')

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
    env: (() => { const merged = { ...process.env, ...env }; if (env.DATABASE_URL === undefined) delete merged.DATABASE_URL; return merged })(),
    encoding: 'utf8',
  })
}

test('backs up the configured host database with pg_dump and verifies the dump', () => {
  const directory = createTempDirectory()
  const backupDir = path.join(directory, 'backups')
  const pgDump = createExecutable(directory, 'fake-pg-dump', `
    const fileIndex = process.argv.indexOf('--file')
    require('node:fs').writeFileSync(process.argv[fileIndex + 1], Buffer.from('valid dump'))
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
  assert.match(files[0], /^backup-\d{8}-\d{6}\.dump$/)
  assert.deepEqual(fs.readFileSync(path.join(backupDir, files[0])), Buffer.from('valid dump'))
})

test('uses server/.env when DATABASE_URL is not in the process environment', () => {
  const directory = createTempDirectory()
  const backupDir = path.join(directory, 'backups')
  const pgDump = createExecutable(directory, 'fake-pg-dump', `
    const args = process.argv.slice(2)
    if (!args.includes('postgresql://file-user:file-secret@localhost:5432/file_db')) process.exit(11)
    const fileIndex = args.indexOf('--file')
    require('node:fs').writeFileSync(args[fileIndex + 1], Buffer.from('file-config dump'))
  `)
  const envPath = path.join(repositoryRoot, 'server', '.env')
  const existing = fs.existsSync(envPath) ? fs.readFileSync(envPath) : null
  try {
    fs.writeFileSync(envPath, 'DATABASE_URL="postgresql://file-user:file-secret@localhost:5432/file_db"\n')
    const result = runBackup({
      MONRAD_DB_MODE: 'host',
      MONRAD_PG_DUMP_COMMAND: pgDump,
      MONRAD_BACKUP_DIR: backupDir,
    })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(fs.readdirSync(backupDir).length, 1)
  } finally {
    if (existing === null) fs.rmSync(envPath, { force: true })
    else fs.writeFileSync(envPath, existing)
  }
})

test('fails without leaving a dump when pg_dump fails', () => {
  const directory = createTempDirectory()
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

test('backs up through the default Docker container and cleans the remote dump', () => {
  const directory = createTempDirectory()
  const backupDir = path.join(directory, 'backups')
  const remoteDump = path.join(directory, 'remote.dump')
  const docker = createExecutable(directory, 'fake-docker', `
    const fs = require('node:fs')
    const args = process.argv.slice(2)
    if (args[0] === 'inspect') process.exit(0)
    if (args[0] === 'exec' && args.includes('pg_dump')) {
      fs.writeFileSync(args.at(-1), Buffer.from('docker dump'))
      process.exit(0)
    }
    if (args[0] === 'cp') {
      fs.copyFileSync(args[1].split(':').slice(1).join(':'), args[2])
      process.exit(0)
    }
    if (args[0] === 'exec' && args[2] === 'rm') {
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
    FAKE_REMOTE_DUMP: remoteDump,
  })

  assert.equal(result.status, 0, result.stderr)
  const files = fs.readdirSync(backupDir)
  assert.equal(files.length, 1)
  assert.deepEqual(fs.readFileSync(path.join(backupDir, files[0])), Buffer.from('docker dump'))
  assert.equal(fs.existsSync(remoteDump), false)
})
