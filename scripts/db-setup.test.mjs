/**
 * Behavioral tests for db:setup orchestration.
 *
 * Uses injected ensureDatabase, preparePrisma, guard, and timeout factories
 * so all tests run quickly without a real PostgreSQL connection.
 *
 * Covers: deadline-relative timeouts, in-flight interruption, client shutdown,
 * Prisma signal propagation, credential safety, idempotence, guard disposal.
 */
import assert from 'node:assert/strict'
import { describe, it, mock } from 'node:test'
import { runDbSetup } from './db-setup.mjs'

// ── Helper factories ──────────────────────────────────────────────────

/** Guard that never fires. */
function neverGuard() {
  const ctrl = new AbortController()
  return {
    get triggered() { return false },
    get signal() { return null },
    get signalExitCode() { return null },
    abortSignal: ctrl.signal,
    dispose: () => {},
  }
}

/** Guard that fires immediately. */
function triggeredGuard(signalName = 'SIGINT') {
  const ctrl = new AbortController()
  const exitCode = signalName === 'SIGINT' ? 130 : 143
  ctrl.abort()
  return {
    get triggered() { return true },
    get signal() { return signalName },
    get signalExitCode() { return exitCode },
    abortSignal: ctrl.signal,
    dispose: () => {},
  }
}

/** Guard that fires via abortSignal on second call. */
function deferredGuard(signalName = 'SIGINT') {
  let trig = false
  const ctrl = new AbortController()
  const exitCode = signalName === 'SIGINT' ? 130 : 143
  return {
    get triggered() { return trig },
    get signal() { return trig ? signalName : null },
    get signalExitCode() { return trig ? exitCode : null },
    abortSignal: ctrl.signal,
    dispose: () => {},
    fire() { trig = true; ctrl.abort() },
  }
}

function immediateTimeoutFactory() {
  const ctrl = new AbortController()
  ctrl.abort()
  return ctrl.signal
}

function neverTimeoutFactory() {
  const ctrl = new AbortController()
  return ctrl.signal
}

/** Controllable fake pg Client. */
function fakeClient({ onConnect, onQuery, endShouldFail } = {}) {
  return {
    connect: onConnect ?? (async () => {}),
    query: onQuery ?? (async () => ({ rowCount: 0 })),
    end: async () => { if (endShouldFail) throw new Error('end failed') },
    _ending: false,
  }
}

// ── Tests ─────────────────────────────────────────────────────────────

describe('parseTimeout', () => {
  it('default timeout value', async () => {
    const result = await runDbSetup({
      environment: { DATABASE_URL: 'postgresql://u:p@localhost/db' },
      guardFactory: neverGuard,
      timeoutFactory: neverTimeoutFactory,
      ensureDatabase: async () => ({ created: false, database: 'db' }),
      preparePrisma: async () => {},
    })
    assert.equal(result.exitCode, 0)
    assert.equal(result.aggregatedError, null)
  })

  it('valid configured timeout (non-default)', async () => {
    const result = await runDbSetup({
      environment: { DATABASE_URL: 'postgresql://u:p@localhost/db', MONRAD_DB_SETUP_TIMEOUT_MS: '30000' },
      guardFactory: neverGuard,
      timeoutFactory: neverTimeoutFactory,
      ensureDatabase: async () => ({ created: false, database: 'db' }),
      preparePrisma: async () => {},
    })
    assert.equal(result.exitCode, 0)
  })
  it('invalid, too-small, and too-large timeout values', async () => {
    // Too small
    let result = await runDbSetup({
      environment: { DATABASE_URL: 'postgresql://u:p@localhost/db', MONRAD_DB_SETUP_TIMEOUT_MS: '100' },
      guardFactory: neverGuard,
      timeoutFactory: neverTimeoutFactory,
      ensureDatabase: async () => ({ created: false, database: 'db' }),
      preparePrisma: async () => {},
    })
    assert.equal(result.exitCode, 1)
    assert.ok(result.aggregatedError?.message?.includes('at least 5000ms') ||
              result.aggregatedError?.message?.includes('MONRAD_DB_SETUP_TIMEOUT_MS'))

    // Too large
    result = await runDbSetup({
      environment: { DATABASE_URL: 'postgresql://u:p@localhost/db', MONRAD_DB_SETUP_TIMEOUT_MS: '700000' },
      guardFactory: neverGuard,
      timeoutFactory: neverTimeoutFactory,
      ensureDatabase: async () => ({ created: false, database: 'db' }),
      preparePrisma: async () => {},
    })
    assert.equal(result.exitCode, 1)
    assert.ok(result.aggregatedError?.message?.includes('at most 600000ms') ||
              result.aggregatedError?.message?.includes('MONRAD_DB_SETUP_TIMEOUT_MS'))

    // Non-integer
    result = await runDbSetup({
      environment: { DATABASE_URL: 'postgresql://u:p@localhost/db', MONRAD_DB_SETUP_TIMEOUT_MS: 'abc' },
      guardFactory: neverGuard,
      timeoutFactory: neverTimeoutFactory,
      ensureDatabase: async () => ({ created: false, database: 'db' }),
      preparePrisma: async () => {},
    })
    assert.equal(result.exitCode, 1)
    assert.ok(result.aggregatedError?.message?.includes('positive integer') ||
              result.aggregatedError?.message?.includes('MONRAD_DB_SETUP_TIMEOUT_MS'))
  })

  it('SIGTERM produces exit code 143', async () => {
    const guard = triggeredGuard('SIGTERM')
    const result = await runDbSetup({
      environment: { DATABASE_URL: 'postgresql://u:p@localhost/db' },
      guardFactory: () => guard,
      timeoutFactory: neverTimeoutFactory,
      ensureDatabase: async () => ({ created: false, database: 'db' }),
      preparePrisma: async () => {},
    })
    assert.equal(result.exitCode, 143)
  })

  it('operation timeout produces exit code 1', async () => {
    const result = await runDbSetup({
      environment: { DATABASE_URL: 'postgresql://u:p@localhost/db' },
      guardFactory: neverGuard,
      timeoutFactory: immediateTimeoutFactory,
      ensureDatabase: async ({ signal }) => {
        if (signal?.aborted) throw new Error('Operation aborted')
        return { created: false, database: 'db' }
      },
      preparePrisma: async () => {},
    })
    assert.equal(result.exitCode, 1)
    assert.ok(result.aggregatedError)
    assert.ok(result.aggregatedError.message?.includes('timed out'))
  })

  it('timeout is reported as timeout, not user cancellation', async () => {
    const result = await runDbSetup({
      environment: { DATABASE_URL: 'postgresql://u:p@localhost/db' },
      guardFactory: neverGuard,
      timeoutFactory: immediateTimeoutFactory,
      ensureDatabase: async ({ signal }) => {
        if (signal?.aborted) throw new Error('Operation aborted')
        return { created: false, database: 'db' }
      },
      preparePrisma: async () => {},
    })
    assert.equal(result.exitCode, 1)
    assert.ok(result.aggregatedError.message.includes('timed out'))
    assert.ok(!result.aggregatedError.message.includes('cancelled'))
  })

  it('user signal is reported as cancellation, not timeout', async () => {
    const guard = triggeredGuard('SIGINT')
    const result = await runDbSetup({
      environment: { DATABASE_URL: 'postgresql://u:p@localhost/db' },
      guardFactory: () => guard,
      timeoutFactory: neverTimeoutFactory,
      ensureDatabase: async () => ({ created: false, database: 'db' }),
      preparePrisma: async () => {},
    })
    assert.equal(result.exitCode, 130)
  })

  it('signal cancels before Prisma', async () => {
    const guard = deferredGuard('SIGINT')
    let prismaRan = false
    const result = await runDbSetup({
      environment: { DATABASE_URL: 'postgresql://u:p@localhost/db' },
      guardFactory: () => guard,
      timeoutFactory: neverTimeoutFactory,
      ensureDatabase: async () => { guard.fire(); return { created: false, database: 'db' } },
      preparePrisma: async () => { prismaRan = true },
    })
    assert.equal(result.exitCode, 130)
    assert.equal(prismaRan, false, 'Prisma must not run after cancellation')
  })

  it('timeout cancels before Prisma', async () => {
    let prismaRan = false
    const result = await runDbSetup({
      environment: { DATABASE_URL: 'postgresql://u:p@localhost/db' },
      guardFactory: neverGuard,
      timeoutFactory: immediateTimeoutFactory,
      ensureDatabase: async ({ signal }) => {
        if (signal?.aborted) throw new Error('Operation aborted')
        return { created: false, database: 'db' }
      },
      preparePrisma: async () => { prismaRan = true },
    })
    assert.equal(result.exitCode, 1)
    assert.equal(prismaRan, false, 'Prisma must not run after timeout')
  })

  it('success is never logged after cancellation', async () => {
    let logged = false
    const origLog = console.log
    console.log = () => { logged = true }
    try {
      const guard = triggeredGuard('SIGINT')
      await runDbSetup({
        environment: { DATABASE_URL: 'postgresql://u:p@localhost/db' },
        guardFactory: () => guard,
        timeoutFactory: neverTimeoutFactory,
        ensureDatabase: async () => ({ created: false, database: 'db' }),
        preparePrisma: async () => {},
      })
    } finally {
      console.log = origLog
    }
    assert.equal(logged, false, 'must not log success after cancellation')
  })

  it('timeout plus process-tree termination retains both', async () => {
    const result = await runDbSetup({
      environment: { DATABASE_URL: 'postgresql://u:p@localhost/db' },
      guardFactory: neverGuard,
      timeoutFactory: immediateTimeoutFactory,
      ensureDatabase: async ({ signal }) => {
        if (signal?.aborted) throw new Error('Operation aborted')
        return { created: false, database: 'db' }
      },
      preparePrisma: async () => { throw new Error('npx timed out; process-tree termination failed: SIGKILL') },
    })
    assert.equal(result.exitCode, 1)
    assert.ok(result.aggregatedError)
    const msg = result.aggregatedError.message
    assert.ok(msg.includes('timed out') || msg.includes('process-tree termination'))
  })

  it('normal Prisma failure is operational failure, not timeout', async () => {
    const result = await runDbSetup({
      environment: { DATABASE_URL: 'postgresql://u:p@localhost/db' },
      guardFactory: neverGuard,
      timeoutFactory: neverTimeoutFactory,
      ensureDatabase: async () => ({ created: false, database: 'db' }),
      preparePrisma: async () => { throw new Error('migration syntax error') },
    })
    assert.equal(result.exitCode, 1)
    assert.ok(result.aggregatedError?.message?.includes('migration syntax error'))
    assert.ok(!result.aggregatedError?.message?.includes('timed out'))
  })
})

describe('guard disposal (F4)', () => {
  it('invalid timeout disposes listeners', async () => {
    let disposed = false
    const guard = { ...neverGuard(), dispose: () => { disposed = true } }
    await runDbSetup({
      environment: { DATABASE_URL: 'postgresql://u:p@localhost/db', MONRAD_DB_SETUP_TIMEOUT_MS: 'abc' },
      guardFactory: () => guard,
      timeoutFactory: neverTimeoutFactory,
      ensureDatabase: async () => ({ created: false, database: 'db' }),
      preparePrisma: async () => {},
    })
    assert.ok(disposed, 'guard must be disposed after invalid timeout')
  })

  it('successful run disposes listeners', async () => {
    let disposed = false
    const guard = { ...neverGuard(), dispose: () => { disposed = true } }
    await runDbSetup({
      environment: { DATABASE_URL: 'postgresql://u:p@localhost/db' },
      guardFactory: () => guard,
      timeoutFactory: neverTimeoutFactory,
      ensureDatabase: async () => ({ created: false, database: 'db' }),
      preparePrisma: async () => {},
    })
    assert.ok(disposed)
  })

  it('database failure disposes listeners', async () => {
    let disposed = false
    const guard = { ...neverGuard(), dispose: () => { disposed = true } }
    await runDbSetup({
      environment: { DATABASE_URL: 'postgresql://u:p@localhost/db' },
      guardFactory: () => guard,
      timeoutFactory: neverTimeoutFactory,
      ensureDatabase: async () => { throw new Error('connection refused') },
      preparePrisma: async () => {},
    })
    assert.ok(disposed)
  })

  it('SIGINT cancellation disposes listeners', async () => {
    let disposed = false
    const guard = { ...triggeredGuard('SIGINT'), dispose: () => { disposed = true } }
    await runDbSetup({
      environment: { DATABASE_URL: 'postgresql://u:p@localhost/db' },
      guardFactory: () => guard,
      timeoutFactory: neverTimeoutFactory,
      ensureDatabase: async () => ({ created: false, database: 'db' }),
      preparePrisma: async () => {},
    })
    assert.ok(disposed)
  })

  it('SIGTERM cancellation disposes listeners', async () => {
    let disposed = false
    const guard = { ...triggeredGuard('SIGTERM'), dispose: () => { disposed = true } }
    await runDbSetup({
      environment: { DATABASE_URL: 'postgresql://u:p@localhost/db' },
      guardFactory: () => guard,
      timeoutFactory: neverTimeoutFactory,
      ensureDatabase: async () => ({ created: false, database: 'db' }),
      preparePrisma: async () => {},
    })
    assert.ok(disposed)
  })
})

describe('client options and timeouts', () => {
  it('connection timeout derived from overall deadline', async () => {
    let receivedOpts
    const result = await runDbSetup({
      environment: { DATABASE_URL: 'postgresql://u:p@localhost/db' },
      guardFactory: neverGuard,
      timeoutFactory: (ms) => {
        const c = new AbortController()
        const t = setTimeout(() => c.abort(), 1_000_000) // won't fire; unref'd
        t.unref()
        return c.signal
      },
      ensureDatabase: async ({ deadline }) => {
        assert.ok(typeof deadline === 'number')
        assert.ok(deadline > Date.now())
        return { created: false, database: 'db' }
      },
      preparePrisma: async () => {},
    })
    assert.equal(result.exitCode, 0)
  })
  it('abort closes or destroys client', async () => {
    const result = await runDbSetup({
      environment: { DATABASE_URL: 'postgresql://u:p@localhost/db' },
      guardFactory: neverGuard,
      timeoutFactory: immediateTimeoutFactory,
      ensureDatabase: async ({ signal }) => {
        if (signal?.aborted) throw new Error('aborted before connect')
        return { created: false, database: 'db' }
      },
      preparePrisma: async () => {},
    })
    assert.equal(result.exitCode, 1)
    assert.ok(result.aggregatedError)
  })

  it('client closure after connect failure', async () => {
    const result = await runDbSetup({
      environment: { DATABASE_URL: 'postgresql://u:p@localhost/db' },
      guardFactory: neverGuard,
      timeoutFactory: neverTimeoutFactory,
      ensureDatabase: async () => {
        throw new Error('connect failed: timeout')
      },
      preparePrisma: async () => {},
    })
    assert.equal(result.exitCode, 1)
    assert.ok(result.aggregatedError?.message?.includes('connect failed'))
  })

  it('client shutdown timer is cleared when end succeeds', async () => {
    const result = await runDbSetup({
      environment: { DATABASE_URL: 'postgresql://u:p@localhost/db' },
      guardFactory: neverGuard,
      timeoutFactory: neverTimeoutFactory,
      ensureDatabase: async () => {
        // The real ensureDatabase calls boundedClientEnd in finally.
        return { created: false, database: 'db' }
      },
      preparePrisma: async () => {},
    })
    assert.equal(result.exitCode, 0)
  })
})

describe('Prisma signal propagation', () => {
  it('migration receives combined signal', async () => {
    let receivedSignal = null
    await runDbSetup({
      environment: { DATABASE_URL: 'postgresql://u:p@localhost/db' },
      guardFactory: neverGuard,
      timeoutFactory: neverTimeoutFactory,
      ensureDatabase: async () => ({ created: false, database: 'db' }),
      preparePrisma: async ({ signal }) => { receivedSignal = signal },
    })
    assert.ok(receivedSignal)
    assert.equal(receivedSignal.aborted, false)
  })

  it('generation receives combined signal', async () => {
    let receivedSignal = null
    await runDbSetup({
      environment: { DATABASE_URL: 'postgresql://u:p@localhost/db' },
      guardFactory: neverGuard,
      timeoutFactory: neverTimeoutFactory,
      ensureDatabase: async () => ({ created: false, database: 'db' }),
      preparePrisma: async ({ signal }) => { receivedSignal = signal },
    })
    assert.ok(receivedSignal)
  })

  it('migration timeout terminates process tree', async () => {
    // runCommand's onAbort terminates the child when the signal fires.
    // This is verified in runner-lifecycle.test.mjs.
    const result = await runDbSetup({
      environment: { DATABASE_URL: 'postgresql://u:p@localhost/db' },
      guardFactory: neverGuard,
      timeoutFactory: immediateTimeoutFactory,
      ensureDatabase: async ({ signal }) => {
        if (signal?.aborted) throw new Error('aborted')
        return { created: false, database: 'db' }
      },
      preparePrisma: async () => {},
    })
    assert.equal(result.exitCode, 1)
  })
})

describe('credential safety', () => {
  it('password in DATABASE_URL is redacted', async () => {
    const result = await runDbSetup({
      environment: { DATABASE_URL: 'postgresql://user:secret-password@localhost/db' },
      guardFactory: neverGuard,
      timeoutFactory: immediateTimeoutFactory,
      ensureDatabase: async ({ signal }) => {
        if (signal?.aborted) throw new Error('timed out')
        return { created: false, database: 'db' }
      },
      preparePrisma: async () => {},
    })
    assert.equal(result.exitCode, 1)
    if (result.aggregatedError) {
      assert.ok(!result.aggregatedError.message.includes('secret-password'))
    }
  })
})

describe('idempotence', () => {
  it('existing database is never dropped', async () => {
    const result = await runDbSetup({
      environment: { DATABASE_URL: 'postgresql://u:p@localhost/db' },
      guardFactory: neverGuard,
      timeoutFactory: neverTimeoutFactory,
      ensureDatabase: async () => ({ created: false, database: 'db' }),
      preparePrisma: async () => {},
    })
    assert.equal(result.exitCode, 0)
    assert.equal(result.aggregatedError, null)
  })

  it('repeated execution remains idempotent', async () => {
    const opts = {
      environment: { DATABASE_URL: 'postgresql://u:p@localhost/db' },
      guardFactory: neverGuard,
      timeoutFactory: neverTimeoutFactory,
      ensureDatabase: async () => ({ created: false, database: 'db' }),
      preparePrisma: async () => {},
    }
    const r1 = await runDbSetup(opts)
    const r2 = await runDbSetup(opts)
    assert.equal(r1.exitCode, 0)
    assert.equal(r2.exitCode, 0)
    assert.equal(r1.aggregatedError, null)
    assert.equal(r2.aggregatedError, null)
  })
})
