#!/usr/bin/env node
import { fileURLToPath } from 'node:url'
import { redactError, runCommand, shutdownGuard, withIsolatedTestDatabase } from './local-postgres.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const guard = shutdownGuard()

try {
  await withIsolatedTestDatabase({ root }, async environment => {
    for (const script of ['test:snapshot-integration', 'test:clone-integration', 'test:squadplan-integration']) {
      if (guard.triggered) break
      await runCommand('npm', ['run', script, '--workspace=server'], { cwd: root, env: environment, signal: guard.abortSignal })
    }
  })
} catch (error) {
  console.error(`[integration-local] ${redactError(error).message}`)
  process.exitCode = 1
} finally {
  guard.dispose()
  if (guard.triggered) process.exit(guard.signalExitCode)
}
