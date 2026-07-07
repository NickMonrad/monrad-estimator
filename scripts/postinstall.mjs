#!/usr/bin/env node
/**
 * Post-install script — creates required directories and sets up external dependencies.
 * Runs automatically after `npm install`.
 */
import { mkdirSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')

// Ensure logs/ directory exists
const logsDir = join(ROOT, 'logs')
if (!existsSync(logsDir)) {
  mkdirSync(logsDir, { recursive: true })
  console.log('[postinstall] Created logs/ directory.')
} else {
  console.log('[postinstall] logs/ already exists.')
}

// Run Chrome download (postinstall hook for puppeteer PDF generation)
import('./install-chrome.mjs').catch(e => {
  console.warn('[postinstall] Chrome download failed — PDF generation will not work:', e.message)
})
