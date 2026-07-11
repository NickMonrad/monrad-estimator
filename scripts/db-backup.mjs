#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const backupDir = path.join(root, 'backups')
const container = process.env.MONRAD_DB_CONTAINER ?? 'monrad-pg'
const database = process.env.POSTGRES_DB ?? 'monrad_estimator'
const user = process.env.POSTGRES_USER ?? 'postgres'
const timestamp = formatTimestamp(new Date())
const filename = `backup-${timestamp}.dump`
const destination = path.join(backupDir, filename)
const containerPath = `/tmp/monrad-backup-${timestamp}.dump`

fs.mkdirSync(backupDir, { recursive: true })

try {
  run('docker', [
    'exec',
    container,
    'pg_dump',
    '-U',
    user,
    '-d',
    database,
    '--format=custom',
    '-f',
    containerPath,
  ])

  run('docker', ['cp', `${container}:${containerPath}`, destination])

  const stat = fs.statSync(destination)
  if (!stat.isFile() || stat.size === 0) {
    throw new Error(`Backup file was not created correctly: ${destination}`)
  }

  console.log(`Backup saved to ${destination}`)
} finally {
  run('docker', ['exec', container, 'rm', '-f', containerPath], { allowFailure: true })
}

function run(command, args, { allowFailure = false } = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: 'inherit',
    shell: false,
  })

  if (result.error) {
    if (allowFailure) return
    throw result.error
  }

  if (result.status !== 0 && !allowFailure) {
    throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status}`)
  }
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
