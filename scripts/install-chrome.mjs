#!/usr/bin/env node
/**
 * Downloads the Puppeteer-managed Chromium browser used for server-side PDF generation.
 * Runs automatically as part of `npm install` via the `postinstall` hook.
 *
 * Safe to re-run: skips download if Chrome is already cached at ~/.cache/puppeteer.
 */

import { install, resolveBuildId, canDownload } from '@puppeteer/browsers'
import { existsSync } from 'fs'
import { join } from 'path'
import os from 'os'

const CACHE_DIR = join(os.homedir(), '.cache', 'puppeteer')
const BROWSER = 'chrome'
const PLATFORM = (() => {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
  if (process.platform === 'darwin') return `mac-${arch}`
  if (process.platform === 'win32') return arch === 'arm64' ? 'win64' : 'win64'
  return arch === 'arm64' ? 'linux' : 'linux'
})()

async function main() {
  let buildId
  try {
    buildId = await resolveBuildId(BROWSER, PLATFORM, 'stable')
  } catch (e) {
    console.warn(`[puppeteer] Could not resolve Chrome build ID (offline?): ${e.message}`)
    console.warn('[puppeteer] Skipping Chrome download — PDF generation will not work until Chrome is available.')
    process.exit(0)
  }

  const cacheEntries = existsSync(join(CACHE_DIR, BROWSER))
    ? (await import('fs')).default.readdirSync(join(CACHE_DIR, BROWSER))
    : []
  const alreadyCached = cacheEntries.some(entry => entry.includes(buildId))
  if (alreadyCached) {
    console.log(`[puppeteer] Chrome ${buildId} already cached — skipping download.`)
    return
  }

  console.log(`[puppeteer] Downloading Chrome ${buildId} for PDF generation...`)

  try {
    const result = await install({
      browser: BROWSER,
      buildId,
      cacheDir: CACHE_DIR,
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
    console.warn(`[puppeteer] Chrome download failed: ${e.message}`)
    console.warn('[puppeteer] PDF generation will not work. Run `npm run install:chrome` to retry.')
    process.exit(0) // non-fatal — don't block npm install
  }
}

main()
