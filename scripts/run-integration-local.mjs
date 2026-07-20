#!/usr/bin/env node
import { fileURLToPath } from 'node:url'
import { redactError, runCommand, shutdownGuard, withIsolatedTestDatabase } from './local-postgres.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const guard = shutdownGuard()
let cleanupErrors = []

try {
  await withIsolatedTestDatabase({ root, signal: guard.abortSignal }, async environment => {
    // The #361 migration adds CHECK constraints and partial unique indexes
    // that existing integration test suites (snapshot, clone, squadplan, etc.)
    // were written to run without. Drop them before running legacy suites.
    // The ownership-invariants suite re-applies them at the start.
    await runCommand('npx', ['tsx', '-e', `
      import { PrismaClient } from '@prisma/client'
      const prisma = new PrismaClient()
      try {
        await prisma.\$executeRawUnsafe('ALTER TABLE "CapacityProfile" DROP CONSTRAINT IF EXISTS "chk_CapacityProfile_exactly_one_owner"')
        await prisma.\$executeRawUnsafe('ALTER TABLE "CapacityProfile" DROP CONSTRAINT IF EXISTS "chk_CapacityProfile_owner_kind_fk"')
        await prisma.\$executeRawUnsafe('DROP INDEX IF EXISTS "CapacityProfile_resourceTypeId_key"')
        await prisma.\$executeRawUnsafe('DROP INDEX IF EXISTS "CapacityProfile_namedResourceId_key"')
        await prisma.\$executeRawUnsafe('CREATE INDEX IF NOT EXISTS "CapacityProfile_resourceTypeId_idx" ON "CapacityProfile"("resourceTypeId")')
        await prisma.\$executeRawUnsafe('CREATE INDEX IF NOT EXISTS "CapacityProfile_namedResourceId_idx" ON "CapacityProfile"("namedResourceId")')
        console.log('[integration-local] Dropped #361 constraints for legacy suite compatibility')
      } finally {
        await prisma.\$disconnect()
      }
    `], { cwd: root, env: environment, signal: guard.abortSignal })

    for (const script of [
      'test:snapshot-integration',
      'test:clone-integration',
      'test:squadplan-integration',
      'test:named-resource-guard-integration',
      'test:optimiser-apply-integration',
      'test:ownership-invariants-integration',
    ]) {
      if (guard.triggered) break
      await runCommand('npm', ['run', script, '--workspace=server'], { cwd: root, env: environment, signal: guard.abortSignal })
    }
  })
} catch (error) {
  cleanupErrors.push({ type: 'runner', error: redactError(error).message })
} finally {
  guard.dispose()
}

// Report cleanup errors — never suppress database/Docker/process failures.
for (const ce of cleanupErrors) {
  if (guard.triggered && ce.type === 'runner' && ce.error.endsWith('was cancelled')) continue
  console.error(`[integration-local] ${ce.type}: ${ce.error}`)
}

if (guard.triggered) {
  process.exitCode = guard.signalExitCode
} else if (cleanupErrors.length > 0) {
  process.exitCode = 1
}
