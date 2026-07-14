#!/usr/bin/env node
/**
 * Downloads the Puppeteer-managed Chromium browser used for server-side PDF generation.
 *
 * Uses puppeteer's documented CLI (`puppeteer browsers install chrome`) to
 * download the pinned Chromium version expected by the installed puppeteer
 * package. The CLI entry is resolved from the standard npm `bin` field in
 * `puppeteer/package.json` — no hardcoded internal package paths.
 *
 * Exports `installChrome()` for use by other modules (e.g. postinstall).
 * Also exports `resolveBinEntry()` and `parseInstallOutput()` for
 * deterministic unit testing without downloading Chrome.
 *
 * When executed directly, sets exit code 1 on failure.
 *
 * Safe to re-run: the CLI is idempotent and skips download if Chrome is
 * already cached under PUPPETEER_CACHE_DIR.
 */

import { execFileSync } from 'child_process'
import { readFileSync, existsSync } from 'fs'
import { createRequire } from 'module'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import os from 'os'

/**
 * Extract the CLI entry path from the standard npm `bin` field.
 *
 * Supports both valid forms:
 *   "bin": "path/to/cli.js"
 *   "bin": { "puppeteer": "path/to/cli.js" }
 *
 * For the object form, the "puppeteer" key is preferred; otherwise the
 * first entry is used.
 *
 * @param {string | Record<string, string> | undefined | null} bin - value of package.json "bin"
 * @returns {string} relative CLI entry path
 */
export function resolveBinEntry(bin) {
  if (typeof bin === 'string' && bin.length > 0) return bin

  if (typeof bin === 'object' && bin !== null) {
    if (typeof bin.puppeteer === 'string' && bin.puppeteer.length > 0) return bin.puppeteer
    const keys = Object.keys(bin)
    if (keys.length > 0) return bin[keys[0]]
  }

  throw new Error('Unable to resolve Puppeteer CLI from package bin metadata')
}

/**
 * Parse the installation output from `puppeteer browsers install chrome`.
 *
 * Expected format:
 *   chrome@<buildId> <executablePath>
 *
 * Extra lines (warnings, progress) before the result line are tolerated.
 * Paths may contain spaces — the first space separates the `chrome@<buildId>`
 * prefix from the executable path.
 *
 * @param {string} stdout - raw CLI output
 * @returns {{ buildId: string, executablePath: string }}
 */
export function parseInstallOutput(stdout) {
  const lines = stdout.trim().split('\n')

  // Pick the last line matching the expected browser@buildId format
  let resultLine = ''
  for (const line of lines) {
    const trimmed = line.trim()
    if (/^chrome@\d/.test(trimmed) || /^chromium@\d/.test(trimmed) || /^firefox@\d/.test(trimmed)) {
      resultLine = trimmed
    }
  }

  if (!resultLine) {
    const preview = stdout.trim().split('\n')[0] || ''
    throw new Error(`Unexpected CLI output: ${preview.slice(0, 120)}`)
  }

  const spaceIdx = resultLine.indexOf(' ')
  if (spaceIdx === -1) {
    throw new Error(`Unexpected CLI output: ${resultLine.slice(0, 120)}`)
  }

  const browserPart = resultLine.slice(0, spaceIdx)
  const buildId = browserPart.split('@')[1]
  const executablePath = resultLine.slice(spaceIdx + 1)

  if (!buildId || !executablePath) {
    throw new Error(`Unexpected CLI output: ${resultLine.slice(0, 120)}`)
  }

  return { buildId, executablePath }
}

/** Resolve the puppeteer CLI entrypoint from installed package metadata. */
function resolvePuppeteerCli() {
  const require = createRequire(import.meta.url)
  const pkgJsonPath = require.resolve('puppeteer/package.json')
  const pkgDir = dirname(pkgJsonPath)
  const { bin } = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'))
  const binRelative = resolveBinEntry(bin)
  const cliPath = resolve(pkgDir, binRelative)

  if (!existsSync(cliPath)) {
    throw new Error(`Puppeteer CLI not found at ${cliPath} (resolved from package.json bin: ${binRelative})`)
  }

  return cliPath
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

  try {
    const stdout = execFileSync(process.execPath, [cliPath, 'browsers', 'install', 'chrome'], {
      env: { ...process.env, PUPPETEER_CACHE_DIR: cacheDir },
      encoding: 'utf-8',
      timeout: 120_000,
    })

    const { buildId, executablePath } = parseInstallOutput(stdout)

    console.log(`[puppeteer] Chrome ${buildId} ready at: ${executablePath}`)
    return { buildId, executablePath }
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
const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  installChrome().catch(err => {
    console.error(`[puppeteer] ${err.message}`)
    process.exitCode = 1
  })
}
