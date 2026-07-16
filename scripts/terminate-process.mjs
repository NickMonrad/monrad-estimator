/**
 * Bounded-escalation child-process termination.
 *
 * Sends SIGTERM, waits for the process to actually exit, escalates to
 * SIGKILL if the grace window expires, then tears down pipe streams
 * to release event-loop references.
 *
 * When `useProcessGroup` is true, signals are sent to the child's
 * process group (`-child.pid`) instead of the individual child PID.
 * This ensures spawned wrappers (e.g. `npx`) that exec or fork the
 * real tool don't orphan descendants — the entire group gets the
 * signal.
 */

/**
 * Send a signal to a child process or its process group.
 *
 * @param {import('node:child_process').ChildProcess} child
 * @param {string} signal
 * @param {boolean} useProcessGroup
 */
function sendSignal(child, signal, useProcessGroup) {
  if (useProcessGroup && child.pid) {
    // Signal the entire process group (negative PID = pgid on POSIX).
    // The child owns the group because it was spawned with `detached: true`.
    try {
      process.kill(-child.pid, signal)
    } catch (err) {
      // ESRCH: process group doesn't exist — already gone.
      if (err.code !== 'ESRCH') throw err
    }
  } else {
    child.kill(signal)
  }
}

/**
 * Terminate a child process with bounded escalation.
 *
 * 1. Send SIGTERM (to child or its process group).
 * 2. Wait for completion up to `graceMs` milliseconds —
 *    completion is the child 'exit' event (if still alive) OR closure
 *    of both pipe streams (descendants release inherited FDs).
 * 3. If no completion by then, send SIGKILL and wait again.
 * 4. Destroy stdio streams so the event loop can exit.
 *
 * When `useProcessGroup` is true, the wrapper-exit early-return is
 * skipped: even if the wrapper (e.g. npx) has already exited, the
 * group leader PID (`-child.pid`) is still valid for signaling the
 * entire group, and pipe closure is awaited to ensure descendants
 * that inherited the pipe FDs have terminated.
 *
 * @param {import('node:child_process').ChildProcess} child
 * @param {number} [graceMs=4000]
 * @param {{ useProcessGroup?: boolean }} [options]
 */
export async function terminateProcess(child, graceMs = 4_000, { useProcessGroup = false } = {}) {
  // Without process groups, the early-return for an already-reaped child
  // is safe because child.kill on a terminated PID is a no-op.
  if (!useProcessGroup && (child.exitCode !== null || child.signalCode !== null)) return

  // Without a PID we cannot reference any process group.
  if (useProcessGroup && !child.pid) return

  // ── Completion signals ──────────────────────────────────────────────

  // Child exit event — only works if the child hasn't already exited.
  const exited = child.exitCode === null && child.signalCode === null
    ? new Promise(resolve => child.once('exit', () => resolve(true)))
    : new Promise(() => {}) // never settles — child already reaped

  // Pipe closure — for detached groups where descendants inherited the
  // stdio FDs, the parent-end pipe streams won't emit 'close' until
  // those descendants release their FDs.
  const pipesClosed = new Promise(resolve => {
    let pending = 0
    const dec = () => { if (--pending <= 0) resolve(true) }
    if (child.stdout) { pending++; child.stdout.once('close', dec) }
    if (child.stderr) { pending++; child.stderr.once('close', dec) }
    if (pending === 0) resolve(true) // no pipe streams at all
  })

  // ── Signal ──────────────────────────────────────────────────────────

  sendSignal(child, 'SIGTERM', useProcessGroup)

  // ── Bounded wait ────────────────────────────────────────────────────

  const cleanExit = await Promise.race([
    Promise.race([exited, pipesClosed]),
    new Promise(resolve => setTimeout(() => resolve(false), graceMs)),
  ])

  if (!cleanExit) {
    sendSignal(child, 'SIGKILL', useProcessGroup)
    // After escalation, bounded drain before stream teardown.
    await Promise.race([
      exited,
      pipesClosed,
      new Promise(resolve => setTimeout(resolve, 500)),
    ])
  }

  // Destroy pipe streams to release event loop references.
  child.stdout?.destroy()
  child.stderr?.destroy()
  child.stdin?.end()
}
