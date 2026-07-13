#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import crypto from 'node:crypto'

const root = fileURLToPath(new URL('..', import.meta.url))
const backupDir = process.env.MONRAD_BACKUP_DIR ?? path.join(root, 'backups')
const container = process.env.MONRAD_DB_CONTAINER ?? 'monrad-pg'
const timestamp = formatTimestamp(new Date())
let destination = path.join(backupDir, `backup-${timestamp}-${process.pid}-${crypto.randomUUID()}.dump`)
const temporaryDestination = `${destination}.tmp-${process.pid}`
const containerPath = `/tmp/monrad-backup-${timestamp}-${process.pid}.dump`
let mode = 'host'

try {
  const config = resolveConfig(root)
  mode = resolveMode()
  fs.mkdirSync(backupDir, { recursive: true })

  if (mode === 'docker') {
    createDockerBackup(config, container, containerPath, temporaryDestination)
  } else {
    createHostBackup(config, temporaryDestination)
  }

  verifyDump(temporaryDestination)
  destination = finalizeDump(temporaryDestination, destination)
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
  const envFile = process.env.MONRAD_ENV_FILE ?? path.join(repositoryRoot, 'server', '.env')
  const fileValues = readEnvFile(envFile)
  const databaseUrl = process.env.DATABASE_URL ?? fileValues.DATABASE_URL
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required; configure server/.env (or MONRAD_ENV_FILE), or set the DATABASE_URL environment variable')
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

  let database
  let authorityPassword
  let queryPassword
  let sanitizedUrl
  try {
    database = decodeURIComponent(parsed.pathname.replace(/^\//, ''))
    authorityPassword = parsed.password ? decodeURIComponent(parsed.password) : null
    const query = extractPasswordQueryParameters(databaseUrl)
    queryPassword = query.password
    sanitizedUrl = sanitizeConnectionUrl(databaseUrl, parsed, query.rawQuery)
  } catch (error) {
    if (error instanceof Error && error.message === 'DATABASE_URL must include at most one password query parameter') {
      throw error
    }
    throw new Error('DATABASE_URL contains malformed percent-encoding')
  }

  if (!database) throw new Error('DATABASE_URL must include a database name')
  if (authorityPassword !== null && queryPassword !== null && authorityPassword !== queryPassword) {
    throw new Error('DATABASE_URL authority and query passwords conflict')
  }

  return {
    databaseUrl: sanitizedUrl,
    database,
    user: decodeURIComponent(parsed.username) || process.env.POSTGRES_USER || fileValues.POSTGRES_USER || 'postgres',
    host: parsed.hostname,
    password: authorityPassword ?? queryPassword,
  }
}

function extractPasswordQueryParameters(databaseUrl) {
  const fragmentIndex = databaseUrl.indexOf('#')
  const withoutFragment = fragmentIndex >= 0 ? databaseUrl.slice(0, fragmentIndex) : databaseUrl
  const queryIndex = withoutFragment.indexOf('?')
  if (queryIndex < 0) return { password: null, rawQuery: '' }

  const rawQuery = withoutFragment.slice(queryIndex + 1)
  const retained = []
  let password = null
  let passwordCount = 0

  for (const component of rawQuery.split('&')) {
    const separatorIndex = component.indexOf('=')
    const rawKey = separatorIndex >= 0 ? component.slice(0, separatorIndex) : component
    let decodedKey
    try {
      decodedKey = decodeURIComponent(rawKey)
    } catch {
      throw new Error('malformed query parameter encoding')
    }

    if (decodedKey !== 'password') {
      retained.push(component)
      continue
    }

    passwordCount += 1
    if (passwordCount > 1) {
      throw new Error('DATABASE_URL must include at most one password query parameter')
    }
    const rawValue = separatorIndex >= 0 ? component.slice(separatorIndex + 1) : ''
    try {
      password = decodeURIComponent(rawValue)
    } catch {
      throw new Error('malformed password query encoding')
    }
  }

  return { password, rawQuery: retained.join('&') }
}

function sanitizeConnectionUrl(databaseUrl, parsed, rawQuery) {
  const fragmentIndex = databaseUrl.indexOf('#')
  const rawFragment = fragmentIndex >= 0 ? databaseUrl.slice(fragmentIndex) : ''
  const sanitized = new URL(parsed)
  sanitized.password = ''
  const queryOrFragmentIndex = [sanitized.href.indexOf('?'), sanitized.href.indexOf('#')]
    .filter(index => index >= 0)
    .sort((a, b) => a - b)[0]
  const base = queryOrFragmentIndex === undefined ? sanitized.href : sanitized.href.slice(0, queryOrFragmentIndex)
  return `${base}${rawQuery ? `?${rawQuery}` : ''}${rawFragment}`
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

function resolveCommand(name, defaultCommand) {
  const command = process.env[`MONRAD_${name}_COMMAND`] ?? defaultCommand
  let prefixArgs = []
  const raw = process.env[`MONRAD_${name}_ARGS`]
  if (raw != null) {
    try {
      const parsed = JSON.parse(raw)
      if (!Array.isArray(parsed)) throw new Error('must be a JSON array')
      prefixArgs = parsed
    } catch (err) {
      throw new Error(`MONRAD_${name}_ARGS configuration error: ${err.message}`)
    }
  }
  return { command, prefixArgs }
}
/**
 * Resolves the backup mode from the environment.
 *
 * | MONRAD_DB_MODE | MONRAD_DB_CONTAINER | Result |
 * |----------------|---------------------|--------|
 * | `"docker"`     | —                   | docker |
 * | `"host"`       | —                   | host   |
 * | *(unset)*      | set or unset       | host   |
 * | other value    | —                   | error  |
 *
 * MONRAD_DB_CONTAINER only overrides the container name after Docker mode
 * has been selected explicitly with MONRAD_DB_MODE=docker.
 */
function resolveMode() {
  const requested = process.env.MONRAD_DB_MODE?.toLowerCase()
  if (requested && requested !== 'docker' && requested !== 'host') {
    throw new Error('MONRAD_DB_MODE must be either docker or host')
  }
  return requested ?? 'host'
}

function createDockerBackup(databaseConfig, containerName, remotePath, localPath) {
  const { command, prefixArgs } = resolveCommand('DOCKER', 'docker')
  run(command, [
    ...prefixArgs,
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
  ], { context: 'Docker backup' })
  run(command, [...prefixArgs, 'cp', `${containerName}:${remotePath}`, localPath], { context: 'Docker backup' })
}

function createHostBackup(databaseConfig, localPath) {
  const { command, prefixArgs } = resolveCommand('PG_DUMP', 'pg_dump')
  const options = {
    context: 'host backup',
    env: { PGPASSWORD: databaseConfig.password ?? undefined },
  }
  run(command, [...prefixArgs, '--format=custom', '--file', localPath, '--dbname', databaseConfig.databaseUrl], options)
}

function runDockerCleanup(containerName, remotePath) {
  const { command, prefixArgs } = resolveCommand('DOCKER', 'docker')
  run(command, [...prefixArgs, 'exec', containerName, 'rm', '-f', remotePath], { allowFailure: true, stdio: 'ignore', context: 'Docker cleanup' })
}

function run(command, args, { allowFailure = false, stdio = 'inherit', context = 'backup', env } = {}) {
  const spawnOptions = { cwd: root, stdio, shell: false }
  if (env) spawnOptions.env = { ...process.env, ...env }
  const result = spawnSync(command, args, spawnOptions)
  if (result.error) {
    if (allowFailure) return
    throw new Error(`${context} command ${command} is unavailable: ${result.error.message}`)
  }
  if (result.status !== 0 && !allowFailure) {
    throw new Error(`${context} command ${command} failed with exit code ${result.status}`)
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

function finalizeDump(filename, initialDestination) {
  let candidate = initialDestination
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      fs.linkSync(filename, candidate)
      fs.rmSync(filename, { force: true })
      return candidate
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      candidate = path.join(backupDir, `backup-${timestamp}-${process.pid}-${crypto.randomUUID()}.dump`)
    }
  }
  throw new Error('backup finalization failed: could not reserve a unique destination')
}
