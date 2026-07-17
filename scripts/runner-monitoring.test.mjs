/**
 * Lifecycle tests for the E2E runner's continuous child-process monitoring.
 */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { runE2eLocal } from './run-e2e-local.mjs'

function mockEnvLoader() {
  return {
    JWT_SECRET: 'test-jwt-secret-at-least-32-characters-long!!',
    DATABASE_URL: 'postgresql://test:test@localhost/test_db',
  }
}

function mockDbLifecycle(opts, action) {
  return action({
    DATABASE_URL: 'postgresql://mock:mock@localhost/mock_test',
    JWT_SECRET: 'x'.repeat(32),
  })
}

const noop = async () => {}

/**
 * Yield to the event loop so process.nextTick (and thus the child 'exit'
 * handler) can fire before the await resolves.
 */
const yieldToEventLoop = () => new Promise(r => setTimeout(r, 5))

/**
 * Return a spawn that creates an EventEmitter and schedules its 'exit'
 * event via process.nextTick.
 */
function mockSpawn(exitCode) {
  return () => {
    const child = new EventEmitter()
    child.pid = 12345
    child.stdout = Object.assign(new EventEmitter(), { destroy: () => {} })
    child.stderr = Object.assign(new EventEmitter(), { destroy: () => {} })
    child.kill = () => {}
    process.nextTick(() => child.emit('exit', exitCode))
    return child
  }
}

/**
 * Return a spawn that creates an EventEmitter and schedules its 'error'
 * event via process.nextTick.
 */
function mockErrorSpawn(errorMsg) {
  return () => {
    const child = new EventEmitter()
    child.pid = 12345
    child.stdout = Object.assign(new EventEmitter(), { destroy: () => {} })
    child.stderr = Object.assign(new EventEmitter(), { destroy: () => {} })
    child.kill = () => {}
    process.nextTick(() => child.emit('error', new Error(errorMsg)))
    return child
  }
}

test('API failure before readiness sets primaryChildFailure', async () => {
  // Use yieldToEventLoop for the wait overrides so nextTick fires
  // before the race resolves.
  const result = await runE2eLocal({
    loadLocalEnvironment: mockEnvLoader,
    spawn: mockSpawn(1),
    runCommand: noop,
    withIsolatedTestDatabase: mockDbLifecycle,
    waitForMonradApi: yieldToEventLoop,
    waitForClient: yieldToEventLoop,
    waitForProxy: yieldToEventLoop,
  })
  assert.ok(result.primaryChildFailure, 'primaryChildFailure must be set')
  assert.match(result.primaryChildFailure.message, /code 1/, 'error mentions exit code')
  assert.equal(result.exitCode, 1, 'exit code is 1')
})

test('Exit code 0 is unexpected for children', async () => {
  const result = await runE2eLocal({
    loadLocalEnvironment: mockEnvLoader,
    spawn: mockSpawn(0),
    runCommand: noop,
    withIsolatedTestDatabase: mockDbLifecycle,
    waitForMonradApi: yieldToEventLoop,
    waitForClient: yieldToEventLoop,
    waitForProxy: yieldToEventLoop,
  })
  assert.ok(result.primaryChildFailure, 'exit code 0 is a failure')
  assert.match(result.primaryChildFailure.message, /code 0/, 'message mentions code 0')
})

test('Error event triggers primaryChildFailure', async () => {
  const result = await runE2eLocal({
    loadLocalEnvironment: mockEnvLoader,
    spawn: mockErrorSpawn('EADDRINUSE'),
    runCommand: noop,
    withIsolatedTestDatabase: mockDbLifecycle,
    waitForMonradApi: yieldToEventLoop,
    waitForClient: yieldToEventLoop,
    waitForProxy: yieldToEventLoop,
  })
  assert.ok(result.primaryChildFailure, 'primaryChildFailure must be set')
  assert.match(result.primaryChildFailure.message, /EADDRINUSE/, 'error contains original message')
})

test('First child failure remains primary when both children fail', async () => {
  let callCount = 0
  let apiChild = null

  const spawn = () => {
    callCount++
    const child = new EventEmitter()
    child.pid = 12345
    child.stdout = Object.assign(new EventEmitter(), { destroy: () => {} })
    child.stderr = Object.assign(new EventEmitter(), { destroy: () => {} })
    child.kill = () => {}
    if (callCount === 1) {
      apiChild = child
    } else {
      // De-synchronize so monitorChild handlers attach before exit fires.
      setTimeout(() => apiChild.emit('exit', 1), 0)
      setTimeout(() => child.emit('error', new Error('vite failed')), 0)
    }
    return child
  }

  const result = await runE2eLocal({
    loadLocalEnvironment: mockEnvLoader,
    spawn,
    runCommand: noop,
    withIsolatedTestDatabase: mockDbLifecycle,
    waitForMonradApi: yieldToEventLoop,
    waitForClient: yieldToEventLoop,
    waitForProxy: yieldToEventLoop,
  })
  assert.equal(callCount, 2, 'both API and Vite must be spawned')
  assert.ok(result.primaryChildFailure, 'primaryChildFailure must be set')
  assert.match(result.primaryChildFailure.message, /code 1/, 'API exit failure is primary')
  assert.doesNotMatch(result.primaryChildFailure.message, /vite/, 'vite error is not primary')
})

// ── Deferred promise helper ───────────────────────────────────────
function deferred() {
  let resolve, reject
  const p = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise: p, resolve, reject }
}

// ── Controllable child factory ────────────────────────────────────
function controllableChild() {
  const child = new EventEmitter()
  child.pid = 12345
  child.stdout = Object.assign(new EventEmitter(), { destroy: () => {} })
  child.stderr = Object.assign(new EventEmitter(), { destroy: () => {} })
  child.kill = () => {}
  return child
}

// ── Post-readiness monitoring tests ───────────────────────────────

test('API fails during proxy check (after readiness)', async () => {
  let apiChild, viteChild
  const spawn = () => {
    if (!apiChild) {
      apiChild = controllableChild()
      return apiChild
    }
    if (!viteChild) {
      viteChild = controllableChild()
      return viteChild
    }
    throw new Error('unexpected third spawn')
  }

  const proxyDeferred = deferred()

  const result = await runE2eLocal({
    loadLocalEnvironment: mockEnvLoader,
    spawn,
    runCommand: noop,
    withIsolatedTestDatabase: mockDbLifecycle,
    waitForMonradApi: async () => {},
    waitForClient: async () => {},
    waitForProxy: async () => {
      // Trigger API exit during proxy check
      apiChild.emit('exit', 1)
      // Don't resolve — the child failure path must win
      return proxyDeferred.promise
    },
  })

  assert.ok(result.primaryChildFailure, 'primaryChildFailure must be set')
  assert.match(result.primaryChildFailure.message, /api.*exit.*code 1/i, 'API failure is primary')
  assert.equal(result.exitCode, 1, 'must exit non-zero')
})

test('Vite fails during proxy check (after readiness)', async () => {
  let apiChild, viteChild
  const spawn = () => {
    if (!apiChild) {
      apiChild = controllableChild()
      return apiChild
    }
    if (!viteChild) {
      viteChild = controllableChild()
      return viteChild
    }
    throw new Error('unexpected third spawn')
  }

  const proxyDeferred = deferred()

  const result = await runE2eLocal({
    loadLocalEnvironment: mockEnvLoader,
    spawn,
    runCommand: noop,
    withIsolatedTestDatabase: mockDbLifecycle,
    waitForMonradApi: async () => {},
    waitForClient: async () => {},
    waitForProxy: async () => {
      viteChild.emit('exit', 42)
      return proxyDeferred.promise
    },
  })

  assert.ok(result.primaryChildFailure, 'primaryChildFailure must be set')
  assert.match(result.primaryChildFailure.message, /vite.*exit.*code 42/i, 'Vite failure is primary')
  assert.equal(result.exitCode, 1, 'must exit non-zero')
})

test('API fails while Playwright is pending', async () => {
  let apiChild, viteChild
  const spawn = () => {
    if (!apiChild) {
      apiChild = controllableChild()
      return apiChild
    }
    if (!viteChild) {
      viteChild = controllableChild()
      return viteChild
    }
    throw new Error('unexpected third spawn')
  }

  const result = await runE2eLocal({
    loadLocalEnvironment: mockEnvLoader,
    spawn,
    withIsolatedTestDatabase: mockDbLifecycle,
    waitForMonradApi: async () => {},
    waitForClient: async () => {},
    waitForProxy: async () => {},
    runCommand: (_cmd, args, { signal } = {}) => {
      if (args?.some(a => a.includes('playwright'))) {
        apiChild.emit('exit', 1)
        // De-synchronize so child-failure race settles before playwrightPromise.
        return new Promise(resolve => {
          if (signal?.aborted) { setTimeout(() => resolve('cancelled'), 0); return }
          signal?.addEventListener('abort', () => resolve('cancelled'), { once: true })
        })
      }
      return Promise.resolve('')
    },
  })

  assert.ok(result.primaryChildFailure, 'primaryChildFailure must be set')
  assert.match(result.primaryChildFailure.message, /api.*exit.*code 1/i, 'API failure is primary')
  assert.equal(result.exitCode, 1, 'must exit non-zero')
})
test('Vite fails while Playwright is pending', async () => {
  let apiChild, viteChild
  const spawn = () => {
    if (!apiChild) {
      apiChild = controllableChild()
      return apiChild
    }
    if (!viteChild) {
      viteChild = controllableChild()
      return viteChild
    }
    throw new Error('unexpected third spawn')
  }

  const result = await runE2eLocal({
    loadLocalEnvironment: mockEnvLoader,
    spawn,
    withIsolatedTestDatabase: mockDbLifecycle,
    waitForMonradApi: async () => {},
    waitForClient: async () => {},
    waitForProxy: async () => {},
    runCommand: (_cmd, args, { signal } = {}) => {
      if (args?.some(a => a.includes('playwright'))) {
        viteChild.emit('exit', 42)
        return new Promise(resolve => {
          if (signal?.aborted) { Promise.resolve().then(() => resolve('cancelled')); return }
          signal?.addEventListener('abort', () => resolve('cancelled'), { once: true })
        })
      }
      return Promise.resolve('')
    },
  })

  assert.ok(result.primaryChildFailure, 'primaryChildFailure must be set')
  assert.match(result.primaryChildFailure.message, /vite.*exit.*code 42/i, 'Vite failure is primary')
  assert.equal(result.exitCode, 1, 'must exit non-zero')
})
test('Playwright termination failure is retained as secondary', async () => {
  let callCount = 0
  const spawn = () => {
    callCount++
    const child = Object.assign(new EventEmitter(), {
      pid: 12345, kill: () => {},
      stdout: Object.assign(new EventEmitter(), { destroy: () => {} }),
      stderr: Object.assign(new EventEmitter(), { destroy: () => {} }),
    })
    if (callCount === 1) process.nextTick(() => child.emit('exit', 1))
    return child
  }

  const result = await runE2eLocal({
    loadLocalEnvironment: mockEnvLoader,
    spawn,
    runCommand: noop,
    withIsolatedTestDatabase: mockDbLifecycle,
    waitForMonradApi: yieldToEventLoop,
    waitForClient: yieldToEventLoop,
    waitForProxy: yieldToEventLoop,
    // Inject a termination function that always fails.
    terminateChild: async () => { throw new Error('process-tree termination failed: mock failure') },
  })

  assert.ok(result.primaryChildFailure, 'primaryChildFailure must be set')
  assert.ok(result.aggregatedError, 'aggregatedError must be set')
  assert.equal(result.exitCode, 1, 'must exit non-zero')
  // Verify aggregatedError includes the termination failure
  assert.match(result.aggregatedError.message, /process-tree termination/i, 'aggregated message contains termination failure')
  // Verify cleanupErrors contains the termination failure
  const hasTermination = result.cleanupErrors.some(
    e => e.type === 'process termination' || e.type === 'child-process termination'
  )
  assert.ok(hasTermination, 'termination failure must be in cleanupErrors')
})

test('Expected shutdown does not create false child failures', async () => {
  let apiChild, viteChild
  const spawn = () => {
    if (!apiChild) {
      apiChild = controllableChild()
      return apiChild
    }
    if (!viteChild) {
      viteChild = controllableChild()
      return viteChild
    }
    throw new Error('unexpected third spawn')
  }

  // Simulate a full successful run: all readiness passes, Playwright completes
  const result = await runE2eLocal({
    loadLocalEnvironment: mockEnvLoader,
    spawn,
    withIsolatedTestDatabase: mockDbLifecycle,
    waitForMonradApi: async () => {},
    waitForClient: async () => {},
    waitForProxy: async () => {},
    runCommand: async () => 'playwright success',
  })

  // Exit code 0 means no failures — expected shutdown does not create false positives
  assert.equal(result.exitCode, 0, 'expected shutdown must not create false failures')
  assert.equal(result.primaryChildFailure, null, 'no primary failure expected')
})

test('Docker cleanup failure is retained alongside primary child failure', async () => {
  let apiChild
  const spawn = () => {
    apiChild = controllableChild()
    process.nextTick(() => apiChild.emit('exit', 1))
    return apiChild
  }

  // Inject a withIsolatedTestDatabase that fails Docker cleanup
  const result = await runE2eLocal({
    loadLocalEnvironment: mockEnvLoader,
    spawn,
    runCommand: noop,
    waitForMonradApi: yieldToEventLoop,
    waitForClient: yieldToEventLoop,
    waitForProxy: yieldToEventLoop,
    withIsolatedTestDatabase: async (_opts, action) => {
      try {
        await action({ DATABASE_URL: 'postgresql://test@localhost/test', INTEGRATION_TEST: 'true' })
      } finally {
        throw new Error('Docker cleanup failed: container removal error')
      }
    },
  })

  assert.ok(result.primaryChildFailure, 'primaryChildFailure must be set')
  const hasCleanupError = result.cleanupErrors.some(
    e => (e.error?.message ?? '').includes('Docker cleanup') || (e.error?.message ?? '').includes('docker cleanup')
  )
  assert.ok(hasCleanupError, 'Docker cleanup failure must be retained')
  assert.equal(result.exitCode, 1, 'must exit non-zero')
})

test('Shutdown guard listeners are disposed after child failure', async () => {
  // Use a mock process to verify guard dispose removes listeners.
  let listenerCount = 0
  let disposed = false
  const mockProcess = {
    on: () => { listenerCount++ },
    removeListener: () => { listenerCount--; disposed = true },
    off: () => { listenerCount--; disposed = true },
    exit: () => {},
    pid: 12345,
  }

  // Create a guard factory that uses the mock process
  const mockGuard = await import('./local-postgres.mjs').then(m => m.shutdownGuard({ process: mockProcess, forceExit: () => {} }))
  assert.equal(listenerCount, 2, 'SIGINT + SIGTERM listeners attached')

  // Run with a guard factory that returns our mock guard
  const result = await runE2eLocal({
    loadLocalEnvironment: mockEnvLoader,
    spawn: () => {
      const child = Object.assign(new EventEmitter(), {
        pid: 54321, kill: () => {},
        stdout: Object.assign(new EventEmitter(), { destroy: () => {} }),
        stderr: Object.assign(new EventEmitter(), { destroy: () => {} }),
      })
      process.nextTick(() => child.emit('exit', 1))
      return child
    },
    runCommand: noop,
    withIsolatedTestDatabase: mockDbLifecycle,
    waitForMonradApi: yieldToEventLoop,
    waitForClient: yieldToEventLoop,
    waitForProxy: yieldToEventLoop,
    guardFactory: () => mockGuard,
  })

  // After runE2eLocal finishes, guard.dispose() should have been called
  assert.ok(disposed, 'guard.dispose() was called after child failure')
  assert.ok(result.primaryChildFailure, 'primaryChildFailure must be set')
  assert.equal(result.exitCode, 1, 'must exit non-zero')
})
test('Child failure plus termination failure plus cleanup failure all remain visible in aggregated error', async () => {
  let apiChild, viteChild
  const spawn = () => {
    if (!apiChild) {
      apiChild = controllableChild()
      process.nextTick(() => apiChild.emit('exit', 1))
      return apiChild
    }
    viteChild = controllableChild()
    return viteChild
  }

  const result = await runE2eLocal({
    loadLocalEnvironment: mockEnvLoader,
    spawn,
    runCommand: noop,
    waitForMonradApi: yieldToEventLoop,
    waitForClient: yieldToEventLoop,
    waitForProxy: yieldToEventLoop,
    // Inject termination failure
    terminateChild: async () => { throw new Error('process-tree termination failed: mock') },
    withIsolatedTestDatabase: async (_opts, action) => {
      try {
        await action({ DATABASE_URL: 'postgresql://test@localhost/test', INTEGRATION_TEST: 'true' })
      } finally {
        // Simulate Docker cleanup failure
        throw new Error('Docker cleanup failed: process timeout')
      }
    },
  })

  assert.ok(result.primaryChildFailure, 'primaryChildFailure must be set')
  assert.ok(result.aggregatedError, 'aggregatedError must be present')

  // aggregatedError.message should contain all three: primary + termination + cleanup
  const msg = result.aggregatedError.message
  assert.match(msg, /api.*exit/i, 'aggregated message must contain primary failure')
  assert.match(msg, /process-tree termination/i, 'aggregated message must contain termination failure')
  assert.match(msg, /cleanup/i, 'aggregated message must contain cleanup failure')

  // Verify cleanupErrors contains both termination and docker failure
  const hasTermination = result.cleanupErrors.some(
    e => e.type === 'process termination' || e.type === 'child-process termination'
  )
  assert.ok(hasTermination, 'termination failure in cleanupErrors')
  const hasDockerError = result.cleanupErrors.some(
    e => (e.error?.message ?? '').includes('Docker')
  )
  assert.ok(hasDockerError, 'Docker cleanup failure in cleanupErrors')

  assert.equal(result.exitCode, 1, 'must exit non-zero')
})

test('No unhandled promise rejection on child failure during Playwright', async () => {
  let apiChild, viteChild
  const spawn = () => {
    if (!apiChild) {
      apiChild = controllableChild()
      return apiChild
    }
    if (!viteChild) {
      viteChild = controllableChild()
      return viteChild
    }
    throw new Error('unexpected third spawn')
  }

  // Track unhandled rejections
  const unhandled = []
  const handler = (reason) => { unhandled.push(reason?.message ?? String(reason)) }
  process.on('unhandledRejection', handler)

  const result = await runE2eLocal({
    loadLocalEnvironment: mockEnvLoader,
    spawn,
    withIsolatedTestDatabase: mockDbLifecycle,
    waitForMonradApi: async () => {},
    waitForClient: async () => {},
    waitForProxy: async () => {},
    runCommand: (_cmd, args, { signal } = {}) => {
      if (args?.some(a => a.includes('playwright'))) {
        apiChild.emit('exit', 1)
        return new Promise(resolve => {
          if (signal?.aborted) { Promise.resolve().then(() => resolve('cancelled')); return }
          signal?.addEventListener('abort', () => resolve('cancelled'), { once: true })
        })
      }
      return Promise.resolve('')
    },
  })

  process.off('unhandledRejection', handler)
  assert.equal(unhandled.length, 0, 'no unhandled promise rejections expected')
  assert.ok(result.primaryChildFailure, 'primaryChildFailure must be set')
  assert.equal(result.exitCode, 1, 'must exit non-zero')
})
