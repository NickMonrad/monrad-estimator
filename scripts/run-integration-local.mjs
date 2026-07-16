#!/usr/bin/env node
import { fileURLToPath } from 'node:url'
import { redactError, runCommand, withIsolatedTestDatabase } from './local-postgres.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))

try {
  await withIsolatedTestDatabase({ root }, async environment => {
    for (const script of ['test:snapshot-integration', 'test:clone-integration', 'test:squadplan-integration']) {
      await runCommand('npm', ['run', script, '--workspace=server'], { cwd: root, env: environment })
    }
  })
} catch (error) {
  console.error(`[integration-local] ${redactError(error).message}`)
  process.exitCode = 1
}
