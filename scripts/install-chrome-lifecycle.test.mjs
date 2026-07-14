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

import { spawnSync } from 'node:child_process'
import { describe, it, before } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

// Module-level references populated once in before()
/** @type {import('./install-chrome.mjs').resolveBinEntry} */
let resolveBinEntry
/** @type {import('./install-chrome.mjs').parseInstallOutput} */
let parseInstallOutput
/** @type {import('./install-chrome.mjs').installChrome} */
let installChrome

before(async () => {
  const mod = await import('./install-chrome.mjs')
  resolveBinEntry = mod.resolveBinEntry
  parseInstallOutput = mod.parseInstallOutput
  installChrome = mod.installChrome
})

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
  const cwd = join(dirname(fileURLToPath(import.meta.url)), '..')
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
    try {
      const result = runScript('scripts/install-chrome.mjs', {
        PUPPETEER_CACHE_DIR: cacheFile,
      })

      assert.notEqual(result.status, 'ok', 'CLI must fail when installation is impossible')
      assert.equal(result.code, 1, 'Exit code should be 1')
      const combined = result.stderr + result.stdout
      assert.ok(/chrome/i.test(combined), 'Error output should mention Chrome')
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})

describe('postinstall lifecycle', { concurrency: false }, () => {
  it('handles Chrome installation failure without failing the script', () => {
    const { tmpDir, cacheFile } = createCacheFile()
    try {
      const result = runScript('scripts/postinstall.mjs', {
        PUPPETEER_CACHE_DIR: cacheFile,
      })

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
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})

// ── Pure helper tests (no Chrome download needed) ──────────────────

describe('resolveBinEntry', { concurrency: false }, () => {
  it('accepts a string form bin field', () => {
    assert.equal(resolveBinEntry('./lib/cli.js'), './lib/cli.js')
  })

  it('prefers puppeteer key in object form', () => {
    assert.equal(
      resolveBinEntry({ puppeteer: 'lib/cli.js', foo: 'other.js' }),
      'lib/cli.js',
    )
  })

  it('falls back to first key when no puppeteer key', () => {
    assert.equal(resolveBinEntry({ foo: 'first.js', bar: 'second.js' }), 'first.js')
  })

  it('throws on null/undefined bin', () => {
    assert.throws(() => resolveBinEntry(null), /bin metadata/)
    assert.throws(() => resolveBinEntry(undefined), /bin metadata/)
  })

  it('throws on empty string bin', () => {
    assert.throws(() => resolveBinEntry(''), /bin metadata/)
  })

  it('throws on empty object bin', () => {
    assert.throws(() => resolveBinEntry({}), /bin metadata/)
  })
})

describe('parseInstallOutput', { concurrency: false }, () => {
  it('parses normal chrome output', () => {
    const { buildId, executablePath } = parseInstallOutput(
      'chrome@150.0.7871.24 /home/u/.cache/puppeteer/chrome/linux-150.0.7871.24/chrome-linux64/chrome',
    )
    assert.equal(buildId, '150.0.7871.24')
    assert.ok(executablePath.endsWith('/chrome-linux64/chrome'))
  })

  it('handles paths with spaces (Windows)', () => {
    const { buildId, executablePath } = parseInstallOutput(
      'chrome@150.0.7871.24 C:\\Program Files\\Puppeteer\\chrome\\win64-150.0.7871.24\\chrome.exe',
    )
    assert.equal(buildId, '150.0.7871.24')
    assert.ok(executablePath.includes('Program Files'))
    assert.ok(executablePath.endsWith('chrome.exe'))
  })

  it('ignores extra lines before the result line', () => {
    const { buildId, executablePath } = parseInstallOutput(
      '[puppeteer] Downloading Chrome... 0%\n' +
      '[puppeteer] Downloading Chrome... 100%\n' +
      'chrome@150.0.7871.24 /usr/bin/chrome\n',
    )
    assert.equal(buildId, '150.0.7871.24')
    assert.equal(executablePath, '/usr/bin/chrome')
  })

  it('throws on empty output', () => {
    assert.throws(() => parseInstallOutput(''), /Unexpected/)
  })

  it('throws on non-matching output', () => {
    assert.throws(() => parseInstallOutput('HEAD / 500\nError: something broke'), /Unexpected/)
  })
})

describe('installChrome return contract', { concurrency: false }, () => {
  it('resolves CLI from package.json bin metadata (not hardcoded path)', async () => {
    const mod = await import('./install-chrome.mjs')
    const require = (await import('module')).createRequire(import.meta.url)
    const pkgPath = require.resolve('puppeteer/package.json')
    const pkg = JSON.parse((await import('fs')).readFileSync(pkgPath, 'utf-8'))

    const binRelative = mod.resolveBinEntry(pkg.bin)

    // Verify the bin entry was read from package.json metadata, not hardcoded
    assert.ok(binRelative, 'bin entry is non-empty')
    assert.ok(binRelative.endsWith('.js') || binRelative.endsWith('.mjs'), 'bin entry is a script file')

    // Confirm the resolved path exists on disk
    const { resolve, dirname } = await import('path')
    const pkgDir = dirname(pkgPath)
    const cliPath = resolve(pkgDir, binRelative)
    assert.ok((await import('fs')).existsSync(cliPath), 'resolved CLI path exists on disk: ' + cliPath)
  })

  it('returns { buildId, executablePath } from cached install', async () => {
    const result = await installChrome()

    assert.ok(typeof result === 'object' && result !== null, 'result is an object')
    assert.ok(typeof result.buildId === 'string' && result.buildId.length > 0,
      'buildId is a non-empty string')
    assert.match(result.buildId, /^\d/, 'buildId starts with a digit')
    assert.ok(typeof result.executablePath === 'string' && result.executablePath.length > 0,
      'executablePath is a non-empty string')
    assert.ok((await import('fs')).existsSync(result.executablePath), 'executablePath exists on disk')
  })
})
