#!/usr/bin/env node
import { fileURLToPath } from 'node:url'
import { redactError, runCommand, shutdownGuard, withIsolatedTestDatabase } from './local-postgres.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const guard = shutdownGuard()
let cleanupErrors = []

try {
  await withIsolatedTestDatabase({ root }, async environment => {
    for (const script of ['test:snapshot-integration', 'test:clone-integration', 'test:squadplan-integration']) {
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
