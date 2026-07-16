/**
 * Lifecycle tests for the local E2E runner's child-process termination.
 *
 * Tests the bounded-escalation pattern in `terminateProcess`: SIGTERM,
 * wait for actual exit, escalate to SIGKILL on timeout, then clean up
 * pipe streams so the event loop can exit naturally.
 */

import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { describe, it } from 'node:test'

import { terminateProcess } from './terminate-process.mjs'

// ── Mock helpers ─────────────────────────────────────────────────

/**
 * Create a minimal ChildProcess-like mock.
 *
 * `_exitNow(code, signal)` synchronously fires the 'exit' event and
 * updates the mock's exitCode/signalCode — use it to simulate an
 * in-test process exiting after a signal is received.
 */
function mockChild({ exitCode = null, signalCode = null } = {}) {
  const emitter = new EventEmitter()
  const stdoutEmitter = new EventEmitter()
  const stderrEmitter = new EventEmitter()
  let capturedSignal = null

  stdoutEmitter._destroyed = false
  stdoutEmitter.destroy = function () { this._destroyed = true }
  stderrEmitter._destroyed = false
  stderrEmitter.destroy = function () { this._destroyed = true }

  const stdinEmitter = new EventEmitter()
  stdinEmitter._ended = false
  stdinEmitter.end = function () { this._ended = true }

  const child = {
    pid: 42_001,
    exitCode,
    signalCode,
    killed: false,

    stdout: stdoutEmitter,
    stderr: stderrEmitter,
    stdin: stdinEmitter,

    once(event, listener) {
      emitter.once(event, listener)
      return this
    },

    kill(signal) {
      child.killed = true
      capturedSignal = signal
      return true
    },

    /** Simulate the OS delivering the exit event. */
    _exitNow(code = 0, sig = null) {
      child.exitCode = code
      child.signalCode = sig
      emitter.emit('exit', code, sig)
    },

    /** Return the most recent signal passed to `kill`. */
    _capturedSignal() {
      return capturedSignal
    },

    /** Close both pipe streams — simulates descendant FD release. */
    _closePipes() {
      stdoutEmitter.emit('close')
      stderrEmitter.emit('close')
    },
  }
  return child
}

// ── Already-terminated ───────────────────────────────────────────

describe('terminateProcess — already terminated', () => {
  it('returns immediately when exitCode is set', async () => {
    const child = mockChild({ exitCode: 0 })
    await terminateProcess(child, 100)
    assert.equal(child.killed, false, 'must not call kill')
    assert.equal(child.stdout._destroyed, false, 'must not touch streams')
    assert.equal(child.stderr._destroyed, false, 'must not touch streams')
    assert.equal(child.stdin._ended, false, 'must not touch stdin')
  })

  it('returns immediately when signalCode is set', async () => {
    const child = mockChild({ signalCode: 'SIGTERM' })
    await terminateProcess(child, 100)
    assert.equal(child.killed, false)
  })

  it('returns immediately for a killed+reaped child', async () => {
    const child = mockChild({ exitCode: 143, signalCode: null })
    child.killed = true
    await terminateProcess(child, 100)
    assert.equal(child._capturedSignal(), null, 'must not send any signal')
  })
})

// ── Clean exit on SIGTERM ───────────────────────────────────────

describe('terminateProcess — clean exit on SIGTERM', () => {
  it('sends SIGTERM and waits for exit event', async () => {
    const child = mockChild()

    // Start termination — sends SIGTERM, begins waiting for exit.
    const promise = terminateProcess(child, 200)

    assert.equal(child._capturedSignal(), 'SIGTERM', 'must send SIGTERM immediately')
    assert.equal(child.exitCode, null, 'must not set exitCode before exit event')

    // Simulate the process exiting gracefully.
    child._exitNow(0)
    await promise

    assert.equal(child.exitCode, 0)
    assert.ok(child.stdout._destroyed, 'stdout stream must be destroyed')
    assert.ok(child.stderr._destroyed, 'stderr stream must be destroyed')
    assert.ok(child.stdin._ended, 'stdin must be ended')
  })

  it('does not escalate to SIGKILL on a timely exit', async () => {
    const child = mockChild()

    const promise = terminateProcess(child, 100)
    child._exitNow(0)
    await promise

    // The second captured signal should still be the first/only signal.
    assert.equal(child._capturedSignal(), 'SIGTERM', 'must not call kill after exit')
  })
})

// ── Escalation to SIGKILL ────────────────────────────────────────

describe('terminateProcess — escalation to SIGKILL', () => {
  it('escalates to SIGKILL when SIGTERM produces no exit within graceMs', async () => {
    const child = mockChild()
    const graceMs = 50

    // Start termination with a short grace window.
    const promise = terminateProcess(child, graceMs)
    assert.equal(child._capturedSignal(), 'SIGTERM')

    // Do NOT fire the exit event — simulate a stuck process.
    // After graceMs the timeout triggers and sends SIGKILL.
    // Only then simulate the process dying.
    setTimeout(() => child._exitNow(9, 'SIGKILL'), graceMs + 20)
    await promise

    assert.equal(child._capturedSignal(), 'SIGKILL',
      'must escalate to SIGKILL after grace period')
    assert.equal(child.exitCode, 9)
    assert.equal(child.signalCode, 'SIGKILL')
  })

  it('idempotent — kill after exit event is harmless', async () => {
    // Edge case: the exit event fires between Promise.race settling and
    // the SIGKILL call.  SIGKILL on an already-dead process is safe.
    const child = mockChild()
    const graceMs = 50

    const promise = terminateProcess(child, graceMs)
    assert.equal(child._capturedSignal(), 'SIGTERM')

    // Let the process exit naturally just after the timeout fires.
    setTimeout(() => child._exitNow(0), graceMs + 5)
    await promise

    // Either SIGTERM or SIGKILL may have been sent — the key contract
    // is that the function resolves cleanly and streams are cleaned.
    assert.ok(child.stdout._destroyed, 'stdout must be cleaned after death')
    assert.ok(child.stderr._destroyed, 'stderr must be cleaned after death')
  })
})

// ── Pipe stream cleanup ─────────────────────────────────────────

describe('terminateProcess — pipe stream cleanup', () => {
  it('handles children that have no stdio streams gracefully', async () => {
    // A child created with `stdio: 'inherit'` has null streams.
    const child = mockChild()
    child.stdout = null
    child.stderr = null
    child.stdin = null

    const promise = terminateProcess(child, 50)
    child._exitNow(0)
    await promise  // must not throw on null streams
  })
})

// ── Process group signaling ───────────────────────────────────────

describe('terminateProcess — process group signaling', () => {
  it('clean process-group shutdown — SIGTERM then pipe close', async () => {
    // When useProcessGroup is true, signals are sent to the process group
    // via process.kill(-child.pid). In this test ESRCH is swallowed.
    // Resolution waits for pipe closure (descendants release FDs).
    const child = mockChild()

    const promise = terminateProcess(child, 200, { useProcessGroup: true })

    assert.equal(child.killed, false, 'must not call child.kill')
    assert.equal(child._capturedSignal(), null, 'must not send signal via child.kill')

    // Descendants release inherited FDs.
    child._closePipes()
    await promise

    assert.ok(child.stdout._destroyed, 'stdout stream must be destroyed')
    assert.ok(child.stderr._destroyed, 'stderr stream must be destroyed')
    assert.ok(child.stdin._ended, 'stdin must be ended')
  })

  it('falls back to child.kill when useProcessGroup is false (default)', async () => {
    // The default pathway must still call child.kill — existing
    // callers (e.g. abort-signal handlers in `run()`) depend on it.
    const child = mockChild()

    const promise = terminateProcess(child, 50)
    assert.equal(child._capturedSignal(), 'SIGTERM', 'must use child.kill by default')

    child._exitNow(0)
    await promise
  })

  it('signals group even if wrapper child already exited', async () => {
    // The wrapper (e.g. npx) has exited but the descendant tool may
    // still be running with inherited pipe FDs in the process group.
    const child = mockChild({ exitCode: 0 })

    const promise = terminateProcess(child, 50, { useProcessGroup: true })

    assert.equal(child.killed, false, 'must use process.kill, not child.kill')

    // Simulate descendant exiting and releasing inherited FDs.
    child._closePipes()
    await promise

    assert.equal(child.exitCode, 0, 'wrapper exit code preserved')
    assert.ok(child.stdout._destroyed, 'stdout cleaned after group signal')
    assert.ok(child.stderr._destroyed, 'stderr cleaned after group signal')
    assert.ok(child.stdin._ended, 'stdin ended after group signal')
  })

  it('leader-exit-with-live-descendant regression — signals group and awaits pipe close', async () => {
    // Regression test for the hang scenario:
    // npx wrapper exited → child.exitCode set, but the actual tool
    // (tsx, Vite) continues in the same process group with inherited
    // pipe FDs.  terminateProcess must still signal the group and wait
    // for pipe closure, not short-circuit because the wrapper is dead.
    const child = mockChild({ exitCode: 0 })

    // Pipes are deliberately NOT closed — simulates inherited FDs.
    const promise = terminateProcess(child, 200, { useProcessGroup: true })

    assert.equal(child.killed, false, 'must use process.kill(-pid), not child.kill')

    // Wait briefly to prove the function hasn't raced ahead and
    // returned without waiting — it must be blocked on pipe close.
    await new Promise(resolve => setTimeout(resolve, 30))
    assert.equal(child.stdout._destroyed, false, 'pipes not yet destroyed — still waiting')
    assert.equal(child.stderr._destroyed, false, 'pipes not yet destroyed — still waiting')

    // Now simulate the descendant dying and closing inherited FDs.
    child._closePipes()
    await promise

    assert.equal(child.exitCode, 0, 'wrapper exit code preserved')
    assert.ok(child.stdout._destroyed, 'stdout cleaned after pipe close')
    assert.ok(child.stderr._destroyed, 'stderr cleaned after pipe close')
    assert.ok(child.stdin._ended, 'stdin ended after pipe close')
  })

  it('escalates to SIGKILL for stuck process group', async () => {
    // When the process group doesn't respond to SIGTERM within the
    // grace window, the group gets SIGKILL. Resolution waits for pipe
    // closure even after escalation.
    const child = mockChild()
    const graceMs = 50

    const promise = terminateProcess(child, graceMs, { useProcessGroup: true })

    assert.equal(child.killed, false, 'child.kill not used for group signaling')

    // After SIGKILL, descendants finally release FDs.
    setTimeout(() => child._closePipes(), graceMs + 30)
    await promise

    assert.equal(child.killed, false, 'child.kill must still not be called')
    assert.ok(child.stdout._destroyed, 'streams cleaned after escalation')
    assert.ok(child.stderr._destroyed, 'stderr cleaned after escalation')
  })

  // ── Additional group-mode edge cases ─────────────────────────────

  it('wrapper exit alone does not resolve — waits for pipe close in group mode', async () => {
    // Regression: in process-group mode the wrapper child's 'exit' event
    // must NOT trigger resolution.  Only pipe closure (descendants
    // releasing inherited FDs) or escalation may resolve the wait.
    const child = mockChild()

    const promise = terminateProcess(child, 200, { useProcessGroup: true })

    // Wrapper exits — but pipes remain open (descendants hold FDs).
    child._exitNow(0)

    // Give event loop a tick so the exit event would propagate if
    // it were a resolution trigger.
    await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(child.stdout._destroyed, false,
      'must not resolve on wrapper exit alone — pipes still open')
    assert.equal(child.stderr._destroyed, false,
      'must not resolve on wrapper exit alone — pipes still open')

    // Descendants release inherited FDs.
    child._closePipes()
    await promise

    assert.ok(child.stdout._destroyed, 'resolved after pipe close')
    assert.ok(child.stderr._destroyed, 'resolved after pipe close')
    assert.ok(child.stdin._ended, 'stdin ended after group termination')
  })

  it('returns early when useProcessGroup is true but child has no pid', async () => {
    // No-PID handling: without a PID we cannot reference a process
    // group, so termination is a no-op.
    const child = mockChild()
    child.pid = null

    await terminateProcess(child, 50, { useProcessGroup: true })

    assert.equal(child.killed, false, 'must not attempt any signal')
    assert.equal(child.stdout._destroyed, false, 'must not touch streams')
    assert.equal(child.stderr._destroyed, false, 'must not touch streams')
    assert.equal(child.stdin._ended, false, 'must not touch stdin')
  })

  it('non-group mode resolves on exit event before pipe close', async () => {
    // Contrast regression: in default (non-group) mode the exit event
    // IS the completion signal.  This test must keep passing.
    const child = mockChild()

    const promise = terminateProcess(child, 200)

    assert.equal(child._capturedSignal(), 'SIGTERM', 'must use child.kill')

    // Child exits — pipes are still open, but non-group mode resolves
    // on exit event alone.
    child._exitNow(0)
    await promise

    assert.equal(child.exitCode, 0)
    assert.ok(child.stdout._destroyed, 'streams cleaned after exit')
    assert.ok(child.stderr._destroyed, 'streams cleaned after exit')
    assert.ok(child.stdin._ended, 'stdin ended after exit')
  })
})
