/**
 * Regression test for PR #445 review — root `capacity-profiles:purge-pre-v4-snapshots`
 * must forward every user-supplied argument exactly once and in order to the
 * server workspace command, so the documented destructive invocation
 * (`npm run capacity-profiles:purge-pre-v4-snapshots -- --apply`) actually
 * reaches the purge leaf with `--apply` instead of silently degrading to a
 * dry run.
 *
 * Mirrors the Issue #424 remediation and Issue #432 evidence forwarding
 * regressions: exercises the ACTUAL root package-script string through the
 * real npm forwarding layers, intercepting only the innermost executable
 * (the server leaf script) with a harmless fixture that records
 * `process.argv`. It does not inspect forwarding behaviour from a string.
 *
 * Safety: the fixture replaces the real `tsx src/scripts/purgePreV4Snapshots.ts`
 * invocation, so the purge command never runs, nothing connects to
 * PostgreSQL, and no deletion is possible. Only the recorded argv file
 * (under the OS temp directory) is written.
 */

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const repositoryRoot = path.resolve(import.meta.dirname, '..')
const rootPackageJson = JSON.parse(
  readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8'),
)
const serverPackageJson = JSON.parse(
  readFileSync(path.join(repositoryRoot, 'server', 'package.json'), 'utf8'),
)

const rootPurgeScript =
  rootPackageJson.scripts['capacity-profiles:purge-pre-v4-snapshots']
const serverPurgeScript =
  serverPackageJson.scripts['capacity-profiles:purge-pre-v4-snapshots']

// The fixture may only stand in for the real server leaf command; if the
// server command itself is renamed, the interception seam changes and this
// test must be revisited rather than silently pass.
const serverLeafIsTsx = () => {
  assert.equal(
    serverPurgeScript,
    'tsx src/scripts/purgePreV4Snapshots.ts',
    'server leaf command changed; the forwarding fixture seam must be updated',
  )
}

// Retained guard: the root script must declare the forwarding separator so
// the inner npm layer does not consume the purge flags as its own
// configuration. The executable assertions below prove the actual behaviour.
const rootScriptDeclaresSeparator = () => {
  assert.match(
    rootPurgeScript,
    /--workspace=server\s+--\s*$/,
    `root script must end with the npm forwarding separator: ${rootPurgeScript}`,
  )
}

// ── Helpers ─────────────────────────────────────────────────────────────

function npmInvocation() {
  // Under `npm run`/`npm test` the npm CLI path is provided in the
  // environment; fall back to PATH resolution for direct `node --test` runs.
  if (process.env.npm_execpath) {
    return [process.execPath, process.env.npm_execpath]
  }
  return [process.platform === 'win32' ? 'npm.cmd' : 'npm']
}

function runNpm(args, { cwd, env }) {
  const [command, ...prefix] = npmInvocation()
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...prefix, ...args], {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`npm timed out for: npm ${args.join(' ')}\n${stderr}`))
    }, 60_000)
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      resolve({ code, signal, stdout, stderr })
    })
  })
}

/**
 * Mirror the repository root script string in a disposable workspace and
 * invoke it through real npm, with the server leaf replaced by an argv
 * recorder. Returns the recorded argument array.
 */
async function runRootScriptWithFixture(userArgs) {
  const fixtureRoot = mkdtempSync(path.join(os.tmpdir(), 'monrad-purge-fwd-'))
  const recordPath = path.join(fixtureRoot, 'recorded-argv.json')
  try {
    writeFileSync(
      path.join(fixtureRoot, 'package.json'),
      JSON.stringify(
        {
          name: 'monrad-purge-forwarding-fixture',
          private: true,
          workspaces: ['server'],
          scripts: {
            // The exact string from the repository root package.json — the
            // artifact under test.
            'capacity-profiles:purge-pre-v4-snapshots': rootPurgeScript,
          },
        },
        null,
        2,
      ),
    )
    mkdirSync(path.join(fixtureRoot, 'server'))
    writeFileSync(
      path.join(fixtureRoot, 'server', 'package.json'),
      JSON.stringify(
        {
          name: 'monrad-purge-forwarding-fixture-server',
          private: true,
          scripts: {
            // Harmless argv recorder in place of the real tsx invocation.
            'capacity-profiles:purge-pre-v4-snapshots': 'node record-argv.mjs',
          },
        },
        null,
        2,
      ),
    )
    writeFileSync(
      path.join(fixtureRoot, 'server', 'record-argv.mjs'),
      `import { writeFileSync } from 'node:fs'
writeFileSync(process.env.RECORD_ARGV_OUT, JSON.stringify(process.argv.slice(2)))
`,
    )
    writeFileSync(recordPath, '')

    const result = await runNpm(
      ['run', 'capacity-profiles:purge-pre-v4-snapshots', '--', ...userArgs],
      {
        cwd: fixtureRoot,
        env: {
          ...process.env,
          RECORD_ARGV_OUT: recordPath,
          npm_config_cache: path.join(fixtureRoot, 'npm-cache'),
        },
      },
    )
    assert.equal(
      result.code,
      0,
      `root script exited ${result.code ?? `signal ${result.signal}`}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    )
    const recorded = readFileSync(recordPath, 'utf8')
    assert.notEqual(
      recorded,
      '',
      'argv recorder never ran — the inner npm layer consumed the arguments\n' +
        `stderr:\n${result.stderr}`,
    )
    return JSON.parse(recorded)
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true })
  }
}

// ── Static guards ───────────────────────────────────────────────────────

test('root script declares the npm forwarding separator after --workspace=server', () => {
  rootScriptDeclaresSeparator()
})

test('server leaf command is still the real tsx purge invocation', () => {
  serverLeafIsTsx()
})

// ── Forwarding vectors ──────────────────────────────────────────────────

// The documented production apply invocation. Deep equality proves the
// argument arrives exactly once, in the original order, unmodified.
const vectors = [
  {
    name: 'destructive apply',
    args: ['--apply'],
  },
]

for (const { name, args } of vectors) {
  test(`root command forwards arguments exactly once and in order — ${name}`, async () => {
    const recorded = await runRootScriptWithFixture(args)
    assert.deepEqual(recorded, args)
  })
}

test('root command without arguments forwards none (leaf stays dry-run)', async () => {
  const recorded = await runRootScriptWithFixture([])
  assert.deepEqual(recorded, [])
})
