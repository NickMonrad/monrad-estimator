/**
 * Lifecycle tests for the Chrome installer and postinstall wrapper.
 *
 * Tests that:
 *   1. Direct CLI (`install-chrome.mjs`) fails with non-zero exit and
 *      error output when Chrome cannot be installed.
 *   2. Postinstall (`postinstall.mjs`) handles the same failure without
 *      failing the overall script, and logs a warning with retry instruction.
 *
 * Both tests simulate failure by setting PUPPETEER_CACHE_DIR to a regular
 * file, which causes @puppeteer/browsers install() to fail (ENOTDIR/EEXIST).
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

/**
 * Create a temporary file to use as a fake cache directory.
 * @puppeteer/browsers install() will fail when it tries to create
 * subdirectories inside a regular file.
 */
function createCacheFile() {
  const tmpDir = mkdtempSync(join(tmpdir(), 'chr-test-'))
  const cacheFile = join(tmpDir, 'cache-marker')
  writeFileSync(cacheFile, '', 'utf-8')
  return { tmpDir, cacheFile }
}

/** Run a script as a child process, returning status info. Captures both stdout and stderr. */
function runScript(scriptPath, env) {
  const cwd = new URL('..', import.meta.url).pathname
  const result = spawnSync(process.execPath, [scriptPath], {
    cwd,
    env: { ...process.env, ...env },
    timeout: 30_000,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  const code = result.status
  const signal = result.signal
  const isError = code !== 0 || signal

  return {
    status: isError ? 'failed' : 'ok',
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    code,
    signal,
  }
}
describe('install-chrome CLI lifecycle', { concurrency: false }, () => {
  it('fails with non-zero exit when Chrome cannot be installed', () => {
    const { tmpDir, cacheFile } = createCacheFile()
    const result = runScript('scripts/install-chrome.mjs', {
      PUPPETEER_CACHE_DIR: cacheFile,
    })
    rmSync(tmpDir, { recursive: true, force: true })

    assert.notEqual(result.status, 'ok', 'CLI must fail when installation is impossible')
    assert.equal(result.code, 1, 'Exit code should be 1')
    const combined = result.stderr + result.stdout
    assert.ok(/chrome/i.test(combined), 'Error output should mention Chrome')
  })
})

describe('postinstall lifecycle', { concurrency: false }, () => {
  it('handles Chrome installation failure without failing the script', () => {
    const { tmpDir, cacheFile } = createCacheFile()
    const result = runScript('scripts/postinstall.mjs', {
      PUPPETEER_CACHE_DIR: cacheFile,
    })
    rmSync(tmpDir, { recursive: true, force: true })

    // Script must succeed (non-fatal)
    assert.equal(result.status, 'ok', 'Postinstall must not fail when Chrome installation fails')
    // Must contain warning about PDF generation
    const combined = result.stdout + result.stderr
    assert.ok(
      combined.includes('PDF generation may be unavailable'),
      'Output should warn about PDF unavailability'
    )

    // Must contain retry instruction
    assert.ok(
      combined.includes('npm run install:chrome'),
      'Output should include retry command'
    )
  })
})
