/**
 * Unit tests for closeBrowser() idempotency.
 *
 * Verifies that closeBrowser():
 *   - safely handles null/no-browser state
 *   - resets the singleton before awaiting close
 *   - is idempotent (second call does not throw)
 *
 * Run:   node --import tsx --test server/src/test/pdf-cleanup.test.mjs
 */

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'

let closeBrowser
let generatePdfFromHtml

before(async () => {
  const mod = await import('../lib/pdfRenderer.js')
  closeBrowser = mod.closeBrowser
  generatePdfFromHtml = mod.generatePdfFromHtml
})

after(async () => {
  if (closeBrowser) {
    try { await closeBrowser() } catch { /* final cleanup */ }
  }
})

describe('closeBrowser', { concurrency: false }, () => {
  it('handles null/no-browser state without error', async () => {
    await closeBrowser()
  })

  it('closes a launched browser and is idempotent', async () => {
    const html = '<html><body><p>Test</p></body></html>'
    const pdf = await generatePdfFromHtml(html)
    assert.ok(Buffer.from(pdf).length > 0, 'PDF generated successfully')

    // First close succeeds
    await closeBrowser()

    // Second close is a no-op — singleton was reset
    await closeBrowser()
  })
})
