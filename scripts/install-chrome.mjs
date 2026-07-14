#!/usr/bin/env node
/**
 * Downloads the Puppeteer-managed Chromium browser used for server-side PDF generation.
 *
 * Uses puppeteer's documented CLI (`puppeteer browsers install chrome`) to
 * download the pinned Chromium version expected by the installed puppeteer
 * package. This is the supported browser installation mechanism — see
 * https://pptr.dev/guides/browsers/#installing-browsers.
 *
 * Exports `installChrome()` for use by other modules (e.g. postinstall).
 * When executed directly, sets exit code 1 on failure.
 *
 * Safe to re-run: the CLI is idempotent and skips download if Chrome is
 * already cached under PUPPETEER_CACHE_DIR.
 */

import { execFileSync } from 'child_process'
import { createRequire } from 'module'
import { resolve } from 'path'
import { fileURLToPath } from 'url'
import os from 'os'

/**
 * Resolve the puppeteer CLI entrypoint using Node's module resolution.
 * puppeteer documents its CLI at `lib/puppeteer/node/cli.js`.
 */
function resolvePuppeteerCli() {
  const require = createRequire(import.meta.url)
  return require.resolve('puppeteer/lib/puppeteer/node/cli.js')
}

/**
 * Install (or verify) the Chrome browser required by the installed puppeteer version.
 * Uses the documented `puppeteer browsers install chrome` CLI.
 * Throws on failure — does not call process.exit.
 * @returns {{ buildId: string, executablePath: string }}
 */
export async function installChrome() {
  const cacheDir = process.env.PUPPETEER_CACHE_DIR || os.homedir() + '/.cache/puppeteer'
  const cliPath = resolvePuppeteerCli()

  // The CLI is idempotent: it downloads on first run and prints the same
  // output line on cache-hit, so we don't need a separate pre-check.
  try {
    const stdout = execFileSync(process.execPath, [cliPath, 'browsers', 'install', 'chrome'], {
      env: { ...process.env, PUPPETEER_CACHE_DIR: cacheDir },
      encoding: 'utf-8',
      timeout: 120_000,
    })

    // Parse output: "chrome@<buildId> <executablePath>"
    // Example: "chrome@150.0.7871.24 /home/u/.cache/puppeteer/chrome/linux-150.0.7871.24/chrome-linux64/chrome"
    const output = stdout.trim()
    const spaceIdx = output.indexOf(' ')
    if (spaceIdx === -1) {
      throw new Error(`Unexpected CLI output: ${output}`)
    }
    const buildId = output.slice(0, spaceIdx).split('@')[1] || 'unknown'
    const executablePath = output.slice(spaceIdx + 1)

    console.log(`[puppeteer] Chrome ${buildId} ready at: ${executablePath}`)
  } catch (err) {
    // execFileSync throws on non-zero exit; extract the concise error from stderr
    const stderr = (err.stderr || err.stdout || '').toString()
    // The CLI prints the help/usage text followed by "Error: ..." — extract just the error line
    const errorMatch = stderr.match(/^Error:.*$/m)
    const detail = errorMatch ? errorMatch[0] : (stderr.trim().split('\n').pop() || err.message)
    throw new Error(`Failed to install Chrome: ${detail}`)
  }
}

// ── Direct execution ──────────────────────────────────────────────
// Run via `node scripts/install-chrome.mjs` or `npm run install:chrome`
const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  installChrome().catch(err => {
    console.error(`[puppeteer] ${err.message}`)
    process.exitCode = 1
  })
}
