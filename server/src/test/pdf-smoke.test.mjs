/**
 * PDF Smoke Test — real-browser PDF generation
 *
 * This test verifies that Puppeteer can launch a real browser, render HTML,
 * and produce a valid PDF. It is NOT part of the vitest suite (which mocks
 * the PDF renderer) — it runs standalone via `node --test`.
 *
 * Run:   npm run test:pdf-smoke  (from repo root)
 * Or:    node --import tsx --test server/src/test/pdf-smoke.test.mjs
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer';

// We start a fresh browser for the direct test and reuse it for the app
// function test. A fresh page is created for each test.

let browser;
let page;

before(async () => {
  browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu'],
  });
  page = await browser.newPage();
});

after(async () => {
  // Close the direct test page and browser
  await page.close();
  await browser.close();
});

describe('PDF smoke test', { concurrency: false }, () => {
  it('produces a non-empty PDF buffer with %PDF header via direct puppeteer API', async () => {
    const html = '<!DOCTYPE html><html><head><meta charset="utf-8"/></head><body><h1>Hello PDF</h1></body></html>';
    await page.setContent(html, { waitUntil: 'load', timeout: 30_000 });
    const pdfBuffer = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '40px', bottom: '40px', left: '48px', right: '48px' },
      timeout: 30_000,
    });
    const buf = Buffer.from(pdfBuffer);
    assert.ok(buf.length > 0, 'PDF buffer must not be empty');
    assert.equal(buf.toString('utf-8', 0, 4), '%PDF', 'PDF must start with %PDF signature');
  });

  it('produces a valid PDF via the application generatePdfFromHtml function', async () => {
    // This import uses tsx to transpile the TypeScript source on-the-fly.
    // The vitest mock is NOT active since we bypass the vitest test runner.
    const { generatePdfFromHtml, closeBrowser } = await import('../lib/pdfRenderer.js');

    const html = '<!DOCTYPE html><html><head><meta charset="utf-8"/></head><body><h1>App PDF</h1><p>Generated via generatePdfFromHtml</p></body></html>';
    const pdfBuffer = await generatePdfFromHtml(html);
    const buf = Buffer.from(pdfBuffer);
    assert.ok(buf.length > 0, 'App-generated PDF buffer must not be empty');
    assert.equal(buf.toString('utf-8', 0, 4), '%PDF', 'App-generated PDF must start with %PDF signature');

    // Clean up the singleton browser instance
    await closeBrowser();
  });
});
