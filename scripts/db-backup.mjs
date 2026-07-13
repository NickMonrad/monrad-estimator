#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const backupDir = process.env.MONRAD_BACKUP_DIR ?? path.join(root, 'backups')
const container = process.env.MONRAD_DB_CONTAINER ?? 'monrad-pg'
const timestamp = formatTimestamp(new Date())
const destination = nextDestination(path.join(backupDir, `backup-${timestamp}.dump`))
const temporaryDestination = `${destination}.tmp-${process.pid}`
const containerPath = `/tmp/monrad-backup-${timestamp}-${process.pid}.dump`
let mode = 'host'

try {
  const config = resolveConfig(root)
  mode = resolveMode(config, container)
  fs.mkdirSync(backupDir, { recursive: true })

  if (mode === 'docker') {
    createDockerBackup(config, container, containerPath, temporaryDestination)
  } else {
    createHostBackup(config, temporaryDestination)
  }

  verifyDump(temporaryDestination)
  fs.renameSync(temporaryDestination, destination)
  console.log(`Backup saved to ${destination}`)
} catch (error) {
  removeIfPresent(temporaryDestination)
  const message = error instanceof Error ? error.message : String(error)
  console.error(`Database backup failed: ${message}`)
  process.exitCode = 1
} finally {
  if (mode === 'docker') runDockerCleanup(container, containerPath)
}

function resolveConfig(repositoryRoot) {
  const fileValues = readEnvFile(path.join(repositoryRoot, 'server', '.env'))
  const databaseUrl = process.env.DATABASE_URL ?? fileValues.DATABASE_URL
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required; configure server/.env or the DATABASE_URL environment variable')
  }

  let parsed
  try {
    parsed = new URL(databaseUrl)
  } catch {
    throw new Error('DATABASE_URL is not a valid PostgreSQL connection URL')
  }

  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
    throw new Error(`DATABASE_URL must use postgres:// or postgresql://, received ${parsed.protocol}`)
  }

  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ''))
  if (!database) throw new Error('DATABASE_URL must include a database name')

  return {
    databaseUrl,
    database,
    user: decodeURIComponent(parsed.username) || process.env.POSTGRES_USER || fileValues.POSTGRES_USER || 'postgres',
    host: parsed.hostname,
  }
}

function readEnvFile(filename) {
  if (!fs.existsSync(filename)) return {}
  const values = {}
  for (const rawLine of fs.readFileSync(filename, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/)
    if (!match) continue
    let value = match[2].trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    values[match[1]] = value
  }
  return values
}

function resolveMode(databaseConfig, containerName) {
  const requested = process.env.MONRAD_DB_MODE?.toLowerCase()
  if (requested && requested !== 'docker' && requested !== 'host') {
    throw new Error('MONRAD_DB_MODE must be either docker or host')
  }
  if (requested) return requested
  if (process.env.MONRAD_DB_CONTAINER) return 'docker'

  const localHost = ['localhost', '127.0.0.1', '::1'].includes(databaseConfig.host)
  if (!localHost) return 'host'

  const docker = process.env.MONRAD_DOCKER_COMMAND ?? 'docker'
  const result = spawnSync(docker, ['inspect', '--type', 'container', containerName], { stdio: 'ignore', shell: false })
  return result.error || result.status !== 0 ? 'host' : 'docker'
}

function createDockerBackup(databaseConfig, containerName, remotePath, localPath) {
  const docker = process.env.MONRAD_DOCKER_COMMAND ?? 'docker'
  run(docker, [
    'exec',
    containerName,
    'pg_dump',
    '-U',
    databaseConfig.user,
    '-d',
    databaseConfig.database,
    '--format=custom',
    '-f',
    remotePath,
  ])
  run(docker, ['cp', `${containerName}:${remotePath}`, localPath])
}

function createHostBackup(databaseConfig, localPath) {
  const pgDump = process.env.MONRAD_PG_DUMP_COMMAND ?? 'pg_dump'
  run(pgDump, ['--format=custom', '--file', localPath, '--dbname', databaseConfig.databaseUrl])
}

function runDockerCleanup(containerName, remotePath) {
  const docker = process.env.MONRAD_DOCKER_COMMAND ?? 'docker'
  run(docker, ['exec', containerName, 'rm', '-f', remotePath], { allowFailure: true, stdio: 'ignore' })
}

function run(command, args, { allowFailure = false, stdio = 'inherit' } = {}) {
  const result = spawnSync(command, args, { cwd: root, stdio, shell: false })
  if (result.error) {
    if (allowFailure) return
    throw new Error(`${command} is unavailable: ${result.error.message}`)
  }
  if (result.status !== 0 && !allowFailure) {
    throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status}`)
  }
}

function verifyDump(filename) {
  let stat
  try {
    stat = fs.statSync(filename)
  } catch {
    throw new Error(`backup command did not create a dump: ${filename}`)
  }
  if (!stat.isFile() || stat.size === 0) throw new Error(`backup dump is empty: ${filename}`)
}

function nextDestination(filename) {
  if (!fs.existsSync(filename)) return filename
  const extension = path.extname(filename)
  const stem = filename.slice(0, -extension.length)
  let index = 1
  while (fs.existsSync(`${stem}-${index}${extension}`)) index += 1
  return `${stem}-${index}${extension}`
}

function removeIfPresent(filename) {
  try { fs.rmSync(filename, { force: true }) } catch { /* best-effort cleanup */ }
}

function formatTimestamp(date) {
  const pad = value => String(value).padStart(2, '0')
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    '-',
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join('')
}
