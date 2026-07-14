/**
 * PDF Smoke Test — real-browser PDF generation through the application path.
 *
 * Launches the Puppeteer-managed browser via generatePdfFromHtml, validates
 * the PDF output, and ensures guaranteed cleanup of the browser instance.
 *
 * Run:   npm run test:pdf-smoke  (from repo root)
 * Or:    node --import tsx --test server/src/test/pdf-smoke.test.mjs
 */

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'

let generatePdfFromHtml
let closeBrowser

describe('PDF smoke test', { concurrency: false }, () => {
  // Lazy-import the app module once (tsx-transpiled)
  before(async () => {
    const mod = await import('../lib/pdfRenderer.js')
    generatePdfFromHtml = mod.generatePdfFromHtml
    closeBrowser = mod.closeBrowser
  })

  after(async () => {
    // Guard: if before() failed before assigning closeBrowser, skip cleanly
    if (closeBrowser) {
      // Allow cleanup errors to propagate — a close failure should fail the test
      await closeBrowser()
    }
  })

  it('generates a valid PDF via the application generatePdfFromHtml function', async () => {
    const html = '<!DOCTYPE html><html><head><meta charset="utf-8"/></head><body><h1>App PDF</h1><p>Generated via generatePdfFromHtml</p></body></html>'
    const pdfBuffer = await generatePdfFromHtml(html)
    const buf = Buffer.from(pdfBuffer)
    assert.ok(buf.length > 0, 'App-generated PDF buffer must not be empty')
    assert.equal(buf.toString('utf-8', 0, 4), '%PDF', 'App-generated PDF must start with %PDF signature')
  })
})
