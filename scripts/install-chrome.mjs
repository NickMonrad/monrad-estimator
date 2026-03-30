#!/usr/bin/env node
/**
 * Downloads the Puppeteer-managed Chromium browser used for server-side PDF generation.
 * Runs automatically as part of `npm install` via the `postinstall` hook.
 *
 * Safe to re-run: skips download if Chrome is already cached at ~/.cache/puppeteer.
 */

import { install } from '@puppeteer/browsers'
import { existsSync, readdirSync } from 'fs'
import { join } from 'path'
import { createRequire } from 'module'
import os from 'os'

const require = createRequire(import.meta.url)
const CACHE_DIR = join(os.homedir(), '.cache', 'puppeteer')
const BROWSER = 'chrome'

// Use the exact build ID that the installed puppeteer package expects
function getPuppeteerBuildId() {
  try {
    const puppeteerPkg = require('puppeteer/package.json')
    // puppeteer stores its pinned revision in the nested puppeteer.chrome config
    if (puppeteerPkg?.puppeteer?.chrome) return puppeteerPkg.puppeteer.chrome
    // Fallback: launch puppeteer and read executablePath to extract version
    const p = require('puppeteer')
    const exePath = p.executablePath()
    const match = exePath.match(/mac_arm-([^/]+)|linux-([^/]+)|win64-([^/]+)/)
    if (match) return match[1] || match[2] || match[3]
  } catch {}
  return null
}

async function main() {
  const buildId = getPuppeteerBuildId()
  if (!buildId) {
    console.warn('[puppeteer] Could not determine required Chrome version — skipping download.')
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
