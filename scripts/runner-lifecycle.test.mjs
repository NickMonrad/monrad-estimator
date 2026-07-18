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

import { checkProcessGroupExists, terminateProcess, waitForProcessGroupGone, buildWindowsTerminateArgs } from './terminate-process.mjs'

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
  /**
   * Create a fake checkGroup that reports the fake group is still alive,
   * and changes to "gone" when `releaseGroup()` is called.
   */
  function controlledGroup() {
    let gone = false
    return {
      checkGroup: () => ({ exists: !gone }),
      releaseGroup: () => { gone = true },
    }
  }

  it('clean process-group shutdown — SIGTERM then pipe close', async () => {
    const child = mockChild()
    const group = controlledGroup()

    const promise = terminateProcess(child, 200, { useProcessGroup: true, checkGroup: group.checkGroup })

    assert.equal(child.killed, false, 'must not call child.kill')
    assert.equal(child._capturedSignal(), null, 'must not send signal via child.kill')

    // Group goes away and descendants release inherited FDs.
    group.releaseGroup()
    child._closePipes()
    await promise

    assert.ok(child.stdout._destroyed, 'stdout stream must be destroyed')
    assert.ok(child.stderr._destroyed, 'stderr stream must be destroyed')
    assert.ok(child.stdin._ended, 'stdin must be ended')
  })

  it('falls back to child.kill when useProcessGroup is false (default)', async () => {
    const child = mockChild()

    const promise = terminateProcess(child, 50)
    assert.equal(child._capturedSignal(), 'SIGTERM', 'must use child.kill by default')

    child._exitNow(0)
    await promise
  })

  it('signals group even if wrapper child already exited', async () => {
    const child = mockChild({ exitCode: 0 })
    const group = controlledGroup()

    const promise = terminateProcess(child, 50, { useProcessGroup: true, checkGroup: group.checkGroup })

    assert.equal(child.killed, false, 'must use process.kill, not child.kill')

    // Descendant exits and group gone + pipes close.
    group.releaseGroup()
    child._closePipes()
    await promise

    assert.equal(child.exitCode, 0, 'wrapper exit code preserved')
    assert.ok(child.stdout._destroyed, 'stdout cleaned after group signal')
    assert.ok(child.stderr._destroyed, 'stderr cleaned after group signal')
    assert.ok(child.stdin._ended, 'stdin ended after group signal')
  })

  it('leader-exit-with-live-descendant regression — signals group and awaits pipe close', async () => {
    const child = mockChild({ exitCode: 0 })
    const group = controlledGroup()

    const promise = terminateProcess(child, 200, { useProcessGroup: true, checkGroup: group.checkGroup })

    assert.equal(child.killed, false, 'must use process.kill(-pid), not child.kill')

    // Wait briefly — group still exists and pipes still open, so termination
    // must still be waiting.
    await new Promise(resolve => setTimeout(resolve, 30))
    assert.equal(child.stdout._destroyed, false, 'pipes not yet destroyed — still waiting')
    assert.equal(child.stderr._destroyed, false, 'pipes not yet destroyed — still waiting')

    // Now release the group and close pipes.
    group.releaseGroup()
    child._closePipes()
    await promise

    assert.equal(child.exitCode, 0, 'wrapper exit code preserved')
    assert.ok(child.stdout._destroyed, 'stdout cleaned after pipe close')
    assert.ok(child.stderr._destroyed, 'stderr cleaned after pipe close')
    assert.ok(child.stdin._ended, 'stdin ended after pipe close')
  })

  it('escalates to SIGKILL for stuck process group', async () => {
    // When the process group doesn't respond to SIGTERM within the
    // grace window, the group gets SIGKILL. Resolution waits for the
    // group to disappear even after escalation.
    const child = mockChild()
    const graceMs = 50
    let groupExists = true
    const checkGroup = () => ({ exists: groupExists })

    const promise = terminateProcess(child, graceMs, { useProcessGroup: true, checkGroup })

    assert.equal(child.killed, false, 'child.kill not used for group signaling')

    // After grace, escalation will happen. Then release group.
    setTimeout(() => { groupExists = false }, graceMs + 80)
    await promise

    assert.equal(child.killed, false, 'child.kill must still not be called')
    assert.ok(child.stdout._destroyed, 'streams cleaned after escalation')
    assert.ok(child.stderr._destroyed, 'stderr cleaned after escalation')
  })

  // ── Additional group-mode edge cases ─────────────────────────────

  it('wrapper exit alone does not resolve — waits for pipe close in group mode', async () => {
    // Regression: in process-group mode the wrapper child's 'exit' event
    // must NOT trigger resolution.  Only the group going away or pipe
    // closure (descendants releasing inherited FDs) may resolve the wait.
    const child = mockChild()
    const group = controlledGroup()

    const promise = terminateProcess(child, 200, { useProcessGroup: true, checkGroup: group.checkGroup })

    // Wrapper exits — but group still exists and pipes remain open.
    child._exitNow(0)

    await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(child.stdout._destroyed, false,
      'must not resolve on wrapper exit alone — pipes still open')
    assert.equal(child.stderr._destroyed, false,
      'must not resolve on wrapper exit alone — pipes still open')

    // Release group and close pipes.
    group.releaseGroup()
    child._closePipes()
    await promise

    assert.ok(child.stdout._destroyed, 'resolved after pipe close')
    assert.ok(child.stderr._destroyed, 'resolved after pipe close')
    assert.ok(child.stdin._ended, 'stdin ended after group termination')
  })

  it('returns early when useProcessGroup is true but child has no pid', async () => {
    const child = mockChild()
    child.pid = null

    await terminateProcess(child, 50, { useProcessGroup: true })

    assert.equal(child.killed, false, 'must not attempt any signal')
    assert.equal(child.stdout._destroyed, false, 'must not touch streams')
    assert.equal(child.stderr._destroyed, false, 'must not touch streams')
    assert.equal(child.stdin._ended, false, 'must not touch stdin')
  })

  it('non-group mode resolves on exit event before pipe close', async () => {
    const child = mockChild()

    const promise = terminateProcess(child, 200)

    assert.equal(child._capturedSignal(), 'SIGTERM', 'must use child.kill')

    child._exitNow(0)
    await promise

    assert.equal(child.exitCode, 0)
    assert.ok(child.stdout._destroyed, 'streams cleaned after exit')
    assert.ok(child.stderr._destroyed, 'streams cleaned after exit')
    assert.ok(child.stdin._ended, 'stdin ended after exit')
  })
})

// ── checkProcessGroupExists ───────────────────────────────────────

describe('checkProcessGroupExists', () => {
  it('returns { exists: true } for a PID that is a group leader', () => {
    if (process.platform === 'win32') return  // process group -1 is not meaningful on Windows
    // The init process (PID 1) is always a group leader on POSIX.
    // If we can't reach it (e.g. container without permission), skip.
    const result = checkProcessGroupExists(1)
    if (result.error) {
      // Permission denied is also valid evidence the group exists.
      assert.ok(result.error.code === 'EPERM' || result.error.code === 'EACCES',
        'unexpected error: ' + (result.error?.code ?? result.error))
    } else {
      assert.equal(result.exists, true)
    }
  })
  it('returns { exists: false } for a non-existent group', () => {
    const result = checkProcessGroupExists(999_999_999)
    assert.equal(result.exists, false)
  })
})

// ── waitForProcessGroupGone ────────────────────────────────────────

describe('waitForProcessGroupGone — injectable checkGroup', () => {
  it('returns true when checkGroup reports group is gone immediately', async () => {
    const result = await waitForProcessGroupGone(42_001, 100, () => ({ exists: false }))
    assert.equal(result, true, 'must return true immediately when group is gone')
  })

  it('polls until checkGroup reports gone', async () => {
    let callCount = 0
    const checkGroup = () => {
      callCount++
      return { exists: callCount < 3 }
    }
    const result = await waitForProcessGroupGone(42_001, 500, checkGroup)
    assert.equal(result, true, 'must return true when group eventually goes away')
    assert.ok(callCount >= 3, 'must have polled multiple times')
  })

  it('returns false when group still exists after timeout', async () => {
    const result = await waitForProcessGroupGone(42_001, 30, () => ({ exists: true }))
    assert.equal(result, false, 'must return false when group persists past timeout')
  })

  it('rethrows checkGroup error immediately', async () => {
    await assert.rejects(
      waitForProcessGroupGone(42_001, 100, () => { throw new Error('boom') }),
      /boom/,
    )
  })
})

// ── buildWindowsTerminateArgs ──────────────────────────────────────

describe('buildWindowsTerminateArgs', () => {
  it('returns taskkill with PID /T /F for a given PID', () => {
    const args = buildWindowsTerminateArgs(42_001)
    assert.deepEqual(args, ['taskkill', '/PID', '42001', '/T', '/F'])
  })

  it('returns expected structure for PID 1', () => {
    const args = buildWindowsTerminateArgs(1)
    assert.deepEqual(args, ['taskkill', '/PID', '1', '/T', '/F'])
  })
})

// ── Inherited-stdio process group ───────────────────────────────────

describe('terminateProcess — inherited stdio (null streams)', () => {
  /**
   * Create a mock child with null stdout/stderr, simulating inherited stdio.
   */
  function mockInheritedChild({ exitCode = null } = {}) {
    const emitter = new EventEmitter()
    const stdinEmitter = new EventEmitter()
    stdinEmitter._ended = false
    stdinEmitter.end = function () { this._ended = true }

    const child = {
      pid: 42_002,
      exitCode,
      signalCode: null,
      killed: false,
      stdout: null,
      stderr: null,
      stdin: stdinEmitter,
      once(event, listener) { emitter.once(event, listener); return this },
      kill(signal) { child.killed = true; return true },
    }
    return child
  }

  it('group-mode does not resolve immediately when group still exists — poll via checkGroup', async () => {
    // Simulate a check function that reports "exists" for a while.
    let groupGone = false
    const checkGroup = () => ({ exists: !groupGone })

    const child = mockInheritedChild()
    const promise = terminateProcess(child, 200, { useProcessGroup: true, checkGroup })

    // Give event loop a tick — termination should NOT be complete because
    // group still exists and there are no pipe streams to short-circuit.
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(child.stdin._ended ?? false, false, 'must not complete while group still exists')

    // Now release the group.
    groupGone = true
    await promise
    assert.ok(child.stdin._ended, 'stdin ended after group terminated')
  })

  it('process group with no pipes eventually receives SIGKILL when stuck', async () => {
    // Group never goes away — even after SIGKILL the process tree persists.
    const child = mockInheritedChild()
    const graceMs = 30

    const promise = terminateProcess(child, graceMs, {
      useProcessGroup: true,
      checkGroup: () => ({ exists: true }),
    })

    await assert.rejects(
      promise,
      new RegExp(
        `Process group ${child.pid} survived SIGTERM \\(${graceMs}ms\\) then SIGKILL \\(500ms\\)`
      ),
    )
  })
})
