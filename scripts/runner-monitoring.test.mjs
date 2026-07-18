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
      // Yield to let the child-failure path settle, then resolve.
      await new Promise(resolve => setTimeout(resolve, 5))
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

  const result = await runE2eLocal({
    loadLocalEnvironment: mockEnvLoader,
    spawn,
    runCommand: noop,
    withIsolatedTestDatabase: mockDbLifecycle,
    waitForMonradApi: async () => {},
    waitForClient: async () => {},
    waitForProxy: async () => {
      viteChild.emit('exit', 42)
      await new Promise(resolve => setTimeout(resolve, 5))
    },
  })

  assert.ok(result.primaryChildFailure, 'primaryChildFailure must be set')
  assert.match(result.primaryChildFailure.message, /vite.*exit.*code 42/i, 'Vite failure is primary')
  assert.equal(result.exitCode, 1, 'must exit non-zero')
})

test('Proxy cancellation settles before child cleanup', async () => {
  let apiChild, viteChild
  const events = []
  let proxyResolved = false

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
    runCommand: noop,
    withIsolatedTestDatabase: mockDbLifecycle,
    waitForMonradApi: async () => {},
    waitForClient: async () => {},
    waitForProxy: async () => {
      events.push('proxy-start')
      apiChild.emit('exit', 1)
      await new Promise(resolve => setTimeout(resolve, 5))
      events.push('proxy-settled')
      proxyResolved = true
    },
  })

  assert.ok(result.primaryChildFailure, 'primaryChildFailure must be set')
  assert.match(result.primaryChildFailure.message, /api.*exit.*code 1/i, 'API failure is primary')
  assert.equal(result.exitCode, 1, 'must exit non-zero')

  // Proxy must have settled (awaited after child failure) before we return.
  assert.ok(proxyResolved, 'proxy operation must settle')
  assert.ok(events.includes('proxy-start'), 'proxy must start')
  assert.ok(events.includes('proxy-settled'), 'proxy must settle')
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
test('Playwright runCommand termination failure is retained as secondary', async () => {
  const events = []
  let apiChild, viteChild

  const spawn = () => {
    if (!apiChild) {
      apiChild = controllableChild()
      return apiChild
    }
    viteChild = controllableChild()
    return viteChild
  }

  const result = await runE2eLocal({
    loadLocalEnvironment: mockEnvLoader,
    spawn,
    withIsolatedTestDatabase: mockDbLifecycle,
    waitForMonradApi: async () => {},
    waitForClient: async () => {},
    waitForProxy: async () => {},
    runCommand: (_cmd, args, opts = {}) => {
      if (args?.some(a => a.includes('playwright'))) {
        events.push('playwright-start')
        /* Trigger API failure during Playwright, then reject the
           playwrightPromise with a termination error when the combined
           signal aborts.  This exercises the real Playwright termination
           path: child failure → internalAbort → combinedSignal → abort
           listener → termination rejection. */
        setTimeout(() => apiChild.emit('exit', 1), 0)
        return new Promise((_resolve, reject) => {
          opts.signal?.addEventListener('abort', () => {
            events.push('playwright-abort-observed')
            reject(new Error('process-tree termination failed: mock'))
          }, { once: true })
        })
      }
      return Promise.resolve('')
    },
  })

  assert.ok(result.primaryChildFailure, 'primaryChildFailure must be set')
  assert.ok(result.aggregatedError, 'aggregatedError must be set')
  assert.equal(result.exitCode, 1, 'must exit non-zero')

  // The termination failure must be retained with type 'playwright termination'
  const hasPwTermination = result.cleanupErrors.some(
    e => e.type === 'playwright termination'
  )
  assert.ok(hasPwTermination, 'playwright termination must be in cleanupErrors')

  // Verify ordering: playwright started before child failure before abort
  assert.ok(events.includes('playwright-start'), 'playwright must start')
  assert.ok(events.includes('playwright-abort-observed'), 'playwright abort observed')
  const pwStartIdx = events.indexOf('playwright-start')
  const pwAbortIdx = events.indexOf('playwright-abort-observed')
  assert.ok(pwAbortIdx > pwStartIdx, 'abort observed after playwright start')
})
test('App-child terminateChild failure is retained as secondary', async () => {
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
    // Inject a terminateChild that always fails — this exercises the
    // API/Vite child-process termination failure path (stopChildren).
    terminateChild: async () => { throw new Error('process-tree termination failed: mock failure') },
  })

  assert.ok(result.primaryChildFailure, 'primaryChildFailure must be set')
  assert.ok(result.aggregatedError, 'aggregatedError must be set')
  assert.equal(result.exitCode, 1, 'must exit non-zero')
  assert.match(result.aggregatedError.message, /process-tree termination/i, 'aggregated message contains termination failure')
  const hasTermination = result.cleanupErrors.some(
    e => e.type === 'process termination' || e.type === 'child-process termination'
  )
  assert.ok(hasTermination, 'app-child termination must be in cleanupErrors')
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

test('Shutdown guard is not created when JWT validation fails (early return)', async () => {
  let guardCreated = false
  const guardFactory = () => {
    guardCreated = true
    return { dispose: () => {}, abortSignal: new AbortController().signal, triggered: false, signalExitCode: 0 }
  }

  const envLoader = () => ({ JWT_SECRET: 'too-short' })

  const result = await runE2eLocal({
    loadLocalEnvironment: envLoader,
    spawn: () => { throw new Error('should not spawn') },
    withIsolatedTestDatabase: mockDbLifecycle,
    guardFactory,
  })
  assert.equal(guardCreated, false, 'guard must not be created on JWT failure')
  assert.equal(result.exitCode, 1, 'must exit non-zero')
  assert.equal(result.primaryChildFailure, null, 'no child failure')
})
test('Child failure + playwright termination + docker cleanup all visible in aggregated error', async () => {
  const events = []
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
    withIsolatedTestDatabase: async (_opts, action) => {
      try {
        await action({ DATABASE_URL: 'postgresql://test@localhost/test', INTEGRATION_TEST: 'true' })
      } finally {
        events.push('docker-cleanup-failed')
        throw new Error('Docker cleanup failed: process timeout')
      }
    },
    waitForMonradApi: async () => {},
    waitForClient: async () => {},
    waitForProxy: async () => {},
    runCommand: (_cmd, args, opts = {}) => {
      if (args?.some(a => a.includes('playwright'))) {
        events.push('playwright-start')
        /* Trigger API failure during Playwright, then reject with a
           termination error — this exercises the Playwright runCommand
           termination path. */
        setTimeout(() => apiChild.emit('exit', 1), 0)
        return new Promise((_resolve, reject) => {
          opts.signal?.addEventListener('abort', () => {
            events.push('playwright-aborted')
            reject(new Error('process-tree termination failed: mock'))
          }, { once: true })
        })
      }
      return Promise.resolve('')
    },
  })

  assert.ok(result.primaryChildFailure, 'primaryChildFailure must be set')
  assert.ok(result.aggregatedError, 'aggregatedError must be present')

  // aggregatedError.message should contain all three: primary + termination + cleanup
  const msg = result.aggregatedError.message
  assert.match(msg, /api.*exit/i, 'aggregated message must contain primary failure')
  assert.match(msg, /process-tree termination/i, 'aggregated message must contain termination failure')
  assert.match(msg, /cleanup/i, 'aggregated message must contain cleanup failure')

  // Verify cleanupErrors contains both playwright termination and docker failure
  const hasPwTermination = result.cleanupErrors.some(
    e => e.type === 'playwright termination'
  )
  assert.ok(hasPwTermination, 'playwright termination in cleanupErrors')
  const hasDockerError = result.cleanupErrors.some(
    e => (e.error?.message ?? '').includes('Docker')
  )
  assert.ok(hasDockerError, 'Docker cleanup failure in cleanupErrors')

  assert.equal(result.exitCode, 1, 'must exit non-zero')
  assert.ok(events.includes('playwright-start'), 'playwright must start')
  assert.ok(events.includes('playwright-aborted'), 'playwright must be aborted')
  assert.ok(events.includes('docker-cleanup-failed'), 'docker cleanup must run')
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

test('Active operation succeeds normally when neither child fails', async () => {
  let callCount = 0
  const events = []
  const spawn = () => {
    callCount++
    const child = controllableChild()
    return child
  }

  const orderedRunCommand = (_cmd, args, opts = {}) => {
    if (args?.some(a => a.includes('playwright'))) {
      events.push('playwright-start')
      return new Promise(resolve => {
        opts.signal?.addEventListener('abort', () => { events.push('playwright-aborted'); resolve('') }, { once: true })
        setTimeout(() => { events.push('playwright-done'); resolve('') }, 0)
      })
    }
    if (args?.some(a => a.includes('e2e-cleanup'))) return Promise.resolve('')
    if (args?.some(a => a.includes('seed'))) return Promise.resolve('')
    return Promise.resolve('')
  }

  const result = await runE2eLocal({
    loadLocalEnvironment: mockEnvLoader,
    spawn,
    runCommand: orderedRunCommand,
    withIsolatedTestDatabase: mockDbLifecycle,
    waitForMonradApi: async () => {},
    waitForClient: async () => {},
    waitForProxy: async () => {},
  })

  assert.equal(result.exitCode, 0, 'must exit zero on success')
  assert.equal(result.primaryChildFailure, null, 'no primary child failure')
  assert.equal(callCount, 2, 'both API and Vite must be spawned')
  assert.ok(events.includes('playwright-start'), 'playwright must start')
  assert.ok(events.includes('playwright-done'), 'playwright must complete')
  assert.ok(!events.includes('playwright-aborted'), 'playwright must not be aborted')
})

test('Child failure stops Playwright before Docker cleanup', async () => {
  const events = []
  let apiChild, viteChild

  const spawn = () => {
    if (!apiChild) {
      apiChild = controllableChild()
      return apiChild
    }
    viteChild = controllableChild()
    return viteChild
  }

  const orderedRunCommand = (_cmd, args, opts = {}) => {
    if (args?.some(a => a.includes('playwright'))) {
      events.push('playwright-start')
      // Trigger child failure DURING Playwright execution.
      setTimeout(() => apiChild.emit('exit', 1), 0)
      return new Promise(resolve => {
        opts.signal?.addEventListener('abort', () => {
          events.push('playwright-aborted')
          resolve('')
        }, { once: true })
        // Also resolve if playwright completes without abort
        setTimeout(() => {
          if (!opts.signal?.aborted) {
            events.push('playwright-done')
            resolve('')
          }
        }, 100)
      })
    }
    if (args?.some(a => a.includes('e2e-cleanup'))) return Promise.resolve('')
    if (args?.some(a => a.includes('seed'))) return Promise.resolve('')
    return Promise.resolve('')
  }

  const result = await runE2eLocal({
    loadLocalEnvironment: mockEnvLoader,
    spawn,
    runCommand: orderedRunCommand,
    withIsolatedTestDatabase: async (opts, action) => {
      try {
        await action({ DATABASE_URL: 'postgresql://test@localhost/test', INTEGRATION_TEST: 'true' })
      } finally {
        events.push('docker-cleanup')
      }
    },
    waitForMonradApi: async () => {},
    waitForClient: async () => {},
    waitForProxy: async () => {},
  })

  assert.ok(result.primaryChildFailure, 'primaryChildFailure must be set')
  assert.equal(result.exitCode, 1, 'must exit non-zero')

  // Verify ordering: Playwright started → child failure → Playwright aborted → Docker cleanup
  const pwStart = events.indexOf('playwright-start')
  const pwAbort = events.indexOf('playwright-aborted')
  const dcCleanup = events.indexOf('docker-cleanup')

  assert.ok(pwStart >= 0, 'playwright must start')
  assert.ok(pwAbort >= 0, 'playwright must be aborted')
  assert.ok(pwAbort > pwStart, `playwright abort (${pwAbort}) must occur after start (${pwStart})`)
  if (dcCleanup >= 0) {
    assert.ok(dcCleanup > pwAbort, `Docker cleanup (${dcCleanup}) must occur after Playwright abort (${pwAbort})`)
  }
})

test('Runner secondary-error type is set correctly', async () => {
  // The outer catch of runE2eLocal uses failures.addError(error, { primaryType: 'runner' }).
  // For a plain Error caught after the primary is set, the secondary must have type 'runner'.
  let apiChild, viteChild
  let cleanupCalled = false

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

  // Make the proxy throw a non-primary, non-AggregatedError that reaches
  // the outer catch after the primary is already set.
  const result = await runE2eLocal({
    loadLocalEnvironment: mockEnvLoader,
    spawn,
    runCommand: noop,
    withIsolatedTestDatabase: async (opts, action) => {
      try {
        await action({ DATABASE_URL: 'postgresql://test@localhost/test', INTEGRATION_TEST: 'true' })
      } finally {
        cleanupCalled = true
        // Throw a non-standard error from Docker cleanup so it reaches the outer catch
        // as a plain Error (not an AggregatedError), after the primary is set.
        throw new Error('Unexpected cleanup error: network timeout')
      }
    },
    waitForMonradApi: async () => {},
    waitForClient: async () => {},
    waitForProxy: async () => {
      apiChild.emit('exit', 1)
      // Yield briefly so raceAgainstChildren can settle the proxy promise.
      await new Promise(resolve => setTimeout(resolve, 5))
    },
  })

  assert.ok(result.primaryChildFailure, 'primaryChildFailure must be set')
  assert.ok(result.aggregatedError, 'aggregatedError must be set')
  assert.equal(result.exitCode, 1, 'must exit non-zero')
  assert.ok(cleanupCalled, 'cleanup must have been called')

  // The Docker cleanup error from the finally block is a plain Error caught
  // by runE2eLocal's outer catch.  It should be recorded as type 'runner'.
  const runnerErrors = result.cleanupErrors.filter(e => e.type === 'runner')
  assert.equal(runnerErrors.length, 1, 'must have exactly one runner-type secondary')
  assert.match(
    (runnerErrors[0]?.error?.message ?? ''),
    /cleanup error|network timeout/i,
    'runner error message matches caught error'
  )
})
