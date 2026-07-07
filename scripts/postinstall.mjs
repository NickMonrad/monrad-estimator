#!/usr/bin/env node
/**
 * Post-install script — creates required directories, verifies native bindings,
 * and sets up external dependencies. Runs automatically after `npm install`.
 */
import { mkdirSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import os from 'os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')

// ── logs/ directory ──────────────────────────────────────────────
const logsDir = join(ROOT, 'logs')
if (!existsSync(logsDir)) {
  mkdirSync(logsDir, { recursive: true })
  console.log('[postinstall] Created logs/ directory.')
}

// ── Windows native binding check ─────────────────────────────────
// npm has a known bug (https://github.com/npm/cli/issues/4828) where
// optionalDependencies with native binaries may not be installed on
// Windows. Verify they're present and warn if not.
if (os.platform() === 'win32') {
  const winBindings = [
    '@esbuild/win32-x64',
    '@rolldown/binding-win32-x64-msvc',
    '@tailwindcss/oxide-win32-x64-msvc',
    'lightningcss-win32-x64-msvc',
  ]
  const missing = winBindings.filter(name => !existsSync(join(ROOT, 'node_modules', name)))
  if (missing.length > 0) {
    console.warn('[postinstall] Warning: Windows native bindings missing:')
    for (const name of missing) {
      console.warn(`  - ${name}`)
    }
    console.warn('[postinstall] Run `npm install` again to retry, or install individually:')
    console.warn(`[postinstall]   npm install ${missing.join(' ')}`)
  }
}

// ── Puppeteer Chrome (PDF generation) ────────────────────────────
import('./install-chrome.mjs').catch(() => {
  // install-chrome.mjs handles its own errors and logs; silence
  // the unhandled rejection since it's a non-fatal postinstall step.
})
