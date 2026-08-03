/**
 * Regression test for Issue #424 — root `capacity-profiles:remediate-readiness`
 * must forward every user-supplied argument exactly once and in order to the
 * server workspace command.
 *
 * The production dry-run proved the double-nested wrapper consumed the flags:
 * the inner `npm run … --workspace=server` layer parsed `--dry-run`/`--json`
 * as its own configuration and dropped or reordered the remediation
 * arguments. This test exercises the ACTUAL root package-script string through
 * the real npm forwarding layers, intercepting only the innermost executable
 * (the server leaf script) with a harmless fixture that records
 * `process.argv`. It does not inspect forwarding behaviour from a string.
 *
 * Safety: the fixture replaces the real `tsx src/scripts/remediateProductionReadiness.ts`
 * invocation, so the remediation planner never runs, nothing connects to
 * PostgreSQL, and no plan, manifest or database write is possible. Only the
 * recorded argv file (under the OS temp directory) is written.
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

const rootRemediationScript =
  rootPackageJson.scripts['capacity-profiles:remediate-readiness']
const serverRemediationScript =
  serverPackageJson.scripts['capacity-profiles:remediate-readiness']

// The fixture may only stand in for the real server leaf command; if the
// server command itself is renamed, the interception seam changes and this
// test must be revisited rather than silently pass.
const serverLeafIsTsx = () => {
  assert.equal(
    serverRemediationScript,
    'tsx src/scripts/remediateProductionReadiness.ts',
    'server leaf command changed; the forwarding fixture seam must be updated',
  )
}

// Retained guard: the root script must declare the forwarding separator so
// the inner npm layer does not consume the remediation flags as its own
// configuration. The executable assertions below prove the actual behaviour.
const rootScriptDeclaresSeparator = () => {
  assert.match(
    rootRemediationScript,
    /--workspace=server\s+--\s*$/,
    `root script must end with the npm forwarding separator: ${rootRemediationScript}`,
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
  const fixtureRoot = mkdtempSync(path.join(os.tmpdir(), 'monrad-fwd-'))
  const recordPath = path.join(fixtureRoot, 'recorded-argv.json')
  try {
    writeFileSync(
      path.join(fixtureRoot, 'package.json'),
      JSON.stringify(
        {
          name: 'monrad-forwarding-fixture',
          private: true,
          workspaces: ['server'],
          scripts: {
            // The exact string from the repository root package.json — the
            // artifact under test.
            'capacity-profiles:remediate-readiness': rootRemediationScript,
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
          name: 'monrad-forwarding-fixture-server',
          private: true,
          scripts: {
            // Harmless argv recorder in place of the real tsx invocation.
            'capacity-profiles:remediate-readiness': 'node record-argv.mjs',
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
      ['run', 'capacity-profiles:remediate-readiness', '--', ...userArgs],
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

test('server leaf command is still the real tsx remediation invocation', () => {
  serverLeafIsTsx()
})

// ── Forwarding vectors ──────────────────────────────────────────────────

// Representative dry-run and apply invocations from the documented root
// command, including values containing spaces. Deep equality proves the
// arguments arrive exactly once, in the original order, unmodified.
const vectors = [
  {
    name: 'dry-run with json output path',
    args: ['--dry-run', '--json', '/tmp/plan.json'],
  },
  {
    name: 'dry-run with spaces in the json path and a manifest',
    args: [
      '--dry-run',
      '--json',
      '/tmp/plan with spaces.json',
      '--manifest',
      '/tmp/decisions.json',
    ],
  },
  {
    name: 'apply with reviewed plan',
    args: ['--apply', '--plan', '/tmp/plan.json'],
  },
  {
    name: 'apply with reviewed plan and a manifest containing spaces',
    args: [
      '--apply',
      '--plan',
      '/tmp/plan.json',
      '--manifest',
      '/tmp/decisions with spaces.json',
    ],
  },
]

for (const { name, args } of vectors) {
  test(`root command forwards arguments exactly once and in order — ${name}`, async () => {
    const recorded = await runRootScriptWithFixture(args)
    assert.deepEqual(recorded, args)
  })
}

test('root command without arguments forwards none', async () => {
  const recorded = await runRootScriptWithFixture([])
  assert.deepEqual(recorded, [])
})
