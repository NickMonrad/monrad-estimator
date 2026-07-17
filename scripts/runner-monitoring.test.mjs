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
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
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
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
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
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
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
