#!/usr/bin/env node
/**
 * Downloads the Puppeteer-managed Chromium browser used for server-side PDF generation.
 * Runs automatically as part of `npm install` via the `postinstall` hook.
 *
 * Safe to re-run: detects existing installation via computeExecutablePath + existsSync,
 * skips download if Chrome is already cached.
 */

import { install, computeExecutablePath } from '@puppeteer/browsers'
import { existsSync } from 'fs'
import { join } from 'path'
import os from 'os'

const BROWSER = 'chrome'

async function getPuppeteerBuildId() {
  try {
    const { PUPPETEER_REVISIONS } = await import('puppeteer')
    if (PUPPETEER_REVISIONS?.chrome) return PUPPETEER_REVISIONS.chrome
  } catch {}
  return null
}

async function main() {
  const buildId = await getPuppeteerBuildId()
  if (!buildId) {
    console.warn('[puppeteer] Could not determine required Chrome version.')
    process.exit(1)
  }

  const cacheDir = process.env.PUPPETEER_CACHE_DIR || join(os.homedir(), '.cache', 'puppeteer')

  try {
    const executablePath = computeExecutablePath({ browser: BROWSER, buildId, cacheDir })
    if (existsSync(executablePath)) {
      console.log(`[puppeteer] Chrome ${buildId} already installed at ${executablePath} — skipping download.`)
      return
    }
  } catch {
    // computeExecutablePath may throw if the browser/buildId combo isn't recognised;
    // that's fine — we'll attempt the install below.
  }

  console.log(`[puppeteer] Downloading Chrome ${buildId}...`)

  try {
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
    console.log(`[puppeteer] Chrome ready at: ${result.executablePath}`)
  } catch (e) {
    process.stdout.write('\n')
    console.error(`[puppeteer] Chrome download failed: ${e.message}`)
    process.exit(1)
  }
}

main()
