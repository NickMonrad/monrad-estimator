/**
 * Tests for closeBrowser() rejection handling and idempotency.
 *
 * Verifies that closeBrowser():
 *   - handles null/no-browser state without error
 *   - closes a launched browser correctly
 *   - is idempotent (second call does not throw)
 *   - rejects when browser.close() throws, clearing the singleton first
 *   - allows a fresh browser to be created after a failed close
 *
 * Run:   node --import tsx --test server/src/test/pdf-cleanup.test.mjs
 */

import { describe, it, before, after, mock } from 'node:test'
import assert from 'node:assert/strict'

let pdfRenderer

before(async () => {
  pdfRenderer = await import('../lib/pdfRenderer.js')
})

after(async () => {
  if (pdfRenderer?.closeBrowser) {
    try { await pdfRenderer.closeBrowser() } catch { /* final cleanup */ }
  }
})

describe('closeBrowser', { concurrency: false }, () => {
  it('handles null/no-browser state without error', async () => {
    await pdfRenderer.closeBrowser()
  })

  it('closes a launched browser and is idempotent', async () => {
    const html = '<html><body><p>Test</p></body></html>'
    const pdf = await pdfRenderer.generatePdfFromHtml(html)
    assert.ok(Buffer.from(pdf).length > 0, 'PDF generated successfully')

    await pdfRenderer.closeBrowser()
    await pdfRenderer.closeBrowser()
  })

  it('propagates browser.close() rejection and clears the singleton', async () => {
    const closeError = new Error('browser close failed')
    const mockBrowser = {
      connected: true,
      close: mock.fn(() => Promise.reject(closeError)),
    }

    pdfRenderer.__setBrowserInstance(mockBrowser)

    await assert.rejects(
      () => pdfRenderer.closeBrowser(),
      (err) => {
        assert.ok(err instanceof Error, 'error should be an Error')
        assert.equal(err.message, closeError.message, 'error message should propagate')
        return true
      },
    )

    assert.equal(mockBrowser.close.mock.callCount(), 1, 'browser.close() was called once')
  })

  it('does not call close on a failed browser after rejection', async () => {
    const closeError = new Error('browser close failed')
    const mockBrowser = {
      connected: true,
      close: mock.fn(() => Promise.reject(closeError)),
    }

    pdfRenderer.__setBrowserInstance(mockBrowser)

    // First call — rejected
    await assert.rejects(() => pdfRenderer.closeBrowser())
    assert.equal(mockBrowser.close.mock.callCount(), 1, 'close called once on first attempt')

    // Second call — singleton is null, should be a no-op
    await pdfRenderer.closeBrowser()
    assert.equal(mockBrowser.close.mock.callCount(), 1, 'close not called again on second attempt')
  })

  it('allows fresh PDF generation after a failed close', async () => {
    // Start with a clean slate (close any stale browser)
    await pdfRenderer.closeBrowser()

    const html = '<html><body><p>Fresh start</p></body></html>'
    const pdf = await pdfRenderer.generatePdfFromHtml(html)
    assert.ok(Buffer.from(pdf).length > 0, 'PDF generated successfully after error')

    await pdfRenderer.closeBrowser()
  })
})
