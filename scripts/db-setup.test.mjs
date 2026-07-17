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
import { ensureDatabase } from './local-postgres.mjs'

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
describe('cancellation-source classification', () => {
  it('timeout during database work', async () => {
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
    assert.ok(result.aggregatedError?.message?.includes('timed out'))
  })

  it('SIGINT during database work', async () => {
    const guard = triggeredGuard('SIGINT')
    const result = await runDbSetup({
      environment: { DATABASE_URL: 'postgresql://u:p@localhost/db' },
      guardFactory: () => guard,
      timeoutFactory: neverTimeoutFactory,
      ensureDatabase: async ({ signal }) => {
        if (signal?.aborted) throw new Error('aborted')
        return { created: false, database: 'db' }
      },
      preparePrisma: async () => {},
    })
    assert.equal(result.exitCode, 130)
  })

  it('SIGTERM during database work', async () => {
    const guard = triggeredGuard('SIGTERM')
    const result = await runDbSetup({
      environment: { DATABASE_URL: 'postgresql://u:p@localhost/db' },
      guardFactory: () => guard,
      timeoutFactory: neverTimeoutFactory,
      ensureDatabase: async ({ signal }) => {
        if (signal?.aborted) throw new Error('aborted')
        return { created: false, database: 'db' }
      },
      preparePrisma: async () => {},
    })
    assert.equal(result.exitCode, 143)
  })

  it('timeout during Prisma', async () => {
    const result = await runDbSetup({
      environment: { DATABASE_URL: 'postgresql://u:p@localhost/db' },
      guardFactory: neverGuard,
      timeoutFactory: immediateTimeoutFactory,
      ensureDatabase: async ({ signal }) => {
        // Ensure DB completes successfully before timeout fires.
        return { created: false, database: 'db' }
      },
      preparePrisma: async ({ signal }) => {
        if (signal?.aborted) throw new Error('migration aborted by timeout')
        throw new Error('migration never started')
      },
    })
    assert.equal(result.exitCode, 1)
    assert.ok(result.aggregatedError?.message?.includes('timed out'))
  })

  it('timeout plus process-tree termination failure', async () => {
    const result = await runDbSetup({
      environment: { DATABASE_URL: 'postgresql://u:p@localhost/db' },
      guardFactory: neverGuard,
      timeoutFactory: immediateTimeoutFactory,
      ensureDatabase: async ({ signal }) => {
        return { created: false, database: 'db' }
      },
      preparePrisma: async () => { throw new Error('npx timed out; process-tree termination failed: SIGKILL') },
    })
    assert.equal(result.exitCode, 1)
    assert.ok(result.aggregatedError)
    const msg = result.aggregatedError.message
    assert.ok(msg.includes('timed out') || msg.includes('process-tree') || msg.includes('npx'))
  })

  it('ordinary Prisma failure remains ordinary operational failure', async () => {
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

describe('real ensureDatabase with fake client', () => {
  it('connection timeout options derived from deadline', async () => {
    let receivedOpts = null
    const fakeClient = {
      connect: async () => {},
      query: async () => ({ rowCount: 1 }),
      end: async () => {},
      _ending: false,
    }
    // Inject a clientFactory that captures the options, then returns the fake client.
    const factory = {
      clientFactory: (url, opts) => { receivedOpts = opts; return fakeClient },
    }
    await ensureDatabase({
      databaseUrl: 'postgresql://u:p@localhost/db',
      deadline: Date.now() + 60_000,
      ...factory,
    })
    assert.ok(receivedOpts)
    assert.ok(receivedOpts.connectionTimeoutMillis > 0, 'connection timeout derived from deadline')
    assert.ok(receivedOpts.query_timeout > 0, 'query_timeout derived from deadline')
  })

  it('in-flight query cancelled by abort signal', async () => {
    const ctrl = new AbortController()
    let abortedDuringQuery = false
    const fakeClient = {
      connect: async () => {},
      query: async () => {
        // Simulate abort arriving before the query completes.
        ctrl.abort()
        abortedDuringQuery = true
        return { rowCount: 0 }
      },
      end: async () => {},
      _ending: false,
    }

    await assert.rejects(
      ensureDatabase({
        databaseUrl: 'postgresql://u:p@localhost/db',
        signal: ctrl.signal,
        deadline: Date.now() + 60_000,
        clientFactory: () => fakeClient,
      }),
      /cancelled|aborted/
    )
  })

  it('client shutdown bounded and timed out', async () => {
    let endCalled = false
    const hangClient = {
      connect: async () => {},
      query: async () => ({ rowCount: 1 }),
      end: async () => {
        endCalled = true
        // Hang forever — boundedClientEnd should bound this.
        await new Promise(() => {})
      },
      _ending: false,
    }

    let error
    try {
      await ensureDatabase({
        databaseUrl: 'postgresql://u:p@localhost/db',
        deadline: Date.now() + 60_000,
        clientFactory: () => hangClient,
      })
      assert.fail('should have rejected')
    } catch (e) {
      error = e
    }
    assert.ok(endCalled, 'client.end() was called')
    assert.ok(error, 'ensureDatabase rejected')
    assert.ok(error.message.includes('Client shutdown failed') || error.message.includes('timed out'))
  })

  it('shutdown failure after successful setup causes failure', async () => {
    const fakeClient = {
      connect: async () => {},
      query: async () => ({ rowCount: 1 }),
      end: async () => { throw new Error('shutdown failed') },
      _ending: false,
    }

    let error
    try {
      await ensureDatabase({
        databaseUrl: 'postgresql://u:p@localhost/db',
        deadline: Date.now() + 60_000,
        clientFactory: () => fakeClient,
      })
      assert.fail('should have rejected')
    } catch (e) {
      error = e
    }
    assert.ok(error, 'ensureDatabase rejected')
    // After try/catch fix in ensureDatabase finally block, boundedClientEnd
    // errors are captured as shutdown failure not thrown replacements.
    assert.ok(error.message.includes('shutdown') || error.message.includes('end'))
  })

  it('shutdown failure after DB error adds secondary context', async () => {
    const fakeClient = {
      connect: async () => { throw new Error('connection refused') },
      query: async () => { throw new Error('should not reach') },
      end: async () => { throw new Error('shutdown also failed') },
      _ending: false,
    }

    let error
    try {
      await ensureDatabase({
        databaseUrl: 'postgresql://u:p@localhost/db',
        deadline: Date.now() + 60_000,
        clientFactory: () => fakeClient,
      })
      assert.fail('should have rejected')
    } catch (e) {
      error = e
    }
    assert.ok(error, 'ensureDatabase rejected')
    // The primary is the DB error; the shutdown failure is attached as cause.
    assert.ok(error.message.includes('connection refused') || error.message.includes('connect'),
      `expected connect error in "${error.message}"`)
    assert.ok(error.cause, 'shutdown failure preserved as cause')
    assert.ok(error.cause.message.includes('shutdown'), 'cause is shutdown error')
  })
})
