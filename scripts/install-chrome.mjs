#!/usr/bin/env node
/**
 * Downloads the Puppeteer-managed Chromium browser used for server-side PDF generation.
 *
 * Exports `installChrome()` for use by other modules (e.g. postinstall).
 * When executed directly, sets exit code 1 on failure.
 *
 * Safe to re-run: detects existing installation via computeExecutablePath + existsSync,
 * skips download if Chrome is already cached.
 */

import { install, computeExecutablePath } from '@puppeteer/browsers'
import { existsSync } from 'fs'
import { join, resolve } from 'path'
import { fileURLToPath } from 'url'
import os from 'os'

const BROWSER = 'chrome'

async function getPuppeteerBuildId() {
  try {
    const { PUPPETEER_REVISIONS } = await import('puppeteer')
    if (PUPPETEER_REVISIONS?.chrome) return PUPPETEER_REVISIONS.chrome
  } catch {}
  throw new Error('Could not determine required Chrome version from puppeteer')
}

/**
 * Install (or verify) the Chrome browser required by the installed puppeteer version.
 * Throws on failure — does not call process.exit.
 * @returns {{ buildId: string, executablePath: string, installed: boolean }}
 */
export async function installChrome() {
  const buildId = await getPuppeteerBuildId()
  const cacheDir = process.env.PUPPETEER_CACHE_DIR || join(os.homedir(), '.cache', 'puppeteer')

  try {
    const executablePath = computeExecutablePath({ browser: BROWSER, buildId, cacheDir })
    if (existsSync(executablePath)) {
      console.log(`[puppeteer] Chrome ${buildId} already installed at ${executablePath} — skipping download.`)
      return { buildId, executablePath, installed: true }
    }
  } catch {
    // computeExecutablePath may throw if the browser/buildId combo isn't recognised;
    // that's fine — we'll attempt the install below.
  }

  console.log(`[puppeteer] Downloading Chrome ${buildId}...`)

  const result = await install({
    browser: BROWSER,
    buildId,
    cacheDir,
    downloadProgressCallback: (downloaded, total) => {
      if (total) {
        const pct = Math.round((downloaded / total) * 100)
        process.stdout.write(`\r[puppeteer] Downloading Chrome... ${pct}%  `)
      }
    },
  })

  process.stdout.write('\n')

  if (!existsSync(result.executablePath)) {
    throw new Error(`Chrome installation completed but executable not found at ${result.executablePath}`)
  }

  console.log(`[puppeteer] Chrome ready at: ${result.executablePath}`)
  return { buildId, executablePath: result.executablePath, installed: false }
}

// ── Direct execution ──────────────────────────────────────────────
// When run via `node scripts/install-chrome.mjs` or `npm run install:chrome`
const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  installChrome().catch(err => {
    console.error(`[puppeteer] ${err.message}`)
    process.exitCode = 1
  })
}
