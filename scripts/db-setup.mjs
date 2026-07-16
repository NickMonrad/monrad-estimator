#!/usr/bin/env node
import { fileURLToPath } from 'node:url'
import { ensureDatabase, loadLocalEnvironment, preparePrisma, redactError } from './local-postgres.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))

try {
  const environment = loadLocalEnvironment(root)
  if (!environment.DATABASE_URL) throw new Error('DATABASE_URL is required; configure server/.env, MONRAD_ENV_FILE, or the shell environment')
  const result = await ensureDatabase({ databaseUrl: environment.DATABASE_URL })
  await preparePrisma({ root, env: environment })
  console.log(`[db:setup] Development database ${result.created ? 'created' : 'already exists'}; migrations and Prisma client are current.`)
} catch (error) {
  console.error(`[db:setup] ${redactError(error).message}`)
  process.exitCode = 1
}
