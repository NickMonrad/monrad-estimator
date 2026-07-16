/**
 * Bounded-escalation child-process termination with process-group support.
 *
 * On POSIX, process-group termination uses `process.kill(-pid, signal)` to
 * signal the entire detached process group.  Completion is confirmed by
 * polling `process.kill(-pid, 0)` (ESRCH = group gone) rather than relying
 * on pipe-stream closure, so inherited stdio is handled correctly.
 *
 * On Windows, `buildWindowsTerminateArgs(pid)` constructs the arguments for
 * `taskkill /PID <pid> /T /F` in a deterministically testable way.
 *
 * Exports
 * -------
 * terminateProcess(child, graceMs?, options?): Promise<void>
 *   Terminate a child (or its process group) with bounded escalation.
 *
 * buildWindowsTerminateArgs(pid): string[]
 *   Return `['taskkill', '/PID', String(pid), '/T', '/F']`.
 *
 * windowsTerminateProcess(child): Promise<void>
 *   Spawn taskkill with the constructed args and await completion.
 */

import { spawn } from 'node:child_process'

// ── Process-group existence check ──────────────────────────────────────

/**
 * Check whether a POSIX process group identified by `pid` (the group
 * leader's PID) still exists.
 *
 * On success (kill returned without error) the group may still exist.
 * On ESRCH the group is gone.
 *
 * @param {number} pid  Group leader PID (positive integer).
 * @returns {{ exists: boolean, error?: Error }}
 */
export function checkProcessGroupExists(pid) {
  try {
    process.kill(-pid, 0)
    return { exists: true }
  } catch (err) {
    if (err.code === 'ESRCH') return { exists: false }
    return { exists: false, error: err }
  }
}

/**
 * Poll `checkGroup(pid)` until the group is gone or `timeoutMs` elapses.
 *
 * @param {number} pid
 * @param {number} timeoutMs
 * @param {(pid: number) => { exists: boolean, error?: Error }} checkGroup
 * @returns {Promise<boolean>}  `true` if group confirmed gone, `false` if still present.
 */
export async function waitForProcessGroupGone(pid, timeoutMs, checkGroup = checkProcessGroupExists) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const { exists, error } = checkGroup(pid)
    if (error) throw error
    if (!exists) return true
    await new Promise(r => setTimeout(r, 50))
  }
  // One final check at the deadline.
  const { exists, error } = checkGroup(pid)
  if (error) throw error
  return !exists
}

// ── Signal sending ─────────────────────────────────────────────────────

function sendSignal(child, signal, useProcessGroup) {
  if (useProcessGroup && child.pid) {
    try {
      process.kill(-child.pid, signal)
    } catch (err) {
      if (err.code !== 'ESRCH') throw err
    }
  } else {
    child.kill(signal)
  }
}

// ── Windows process-tree termination ───────────────────────────────────

/**
 * Build the argument list for `taskkill /T /F`.
 *
 * Deterministically testable on any platform.
 *
 * @param {number} pid
 * @returns {string[]}
 */
export function buildWindowsTerminateArgs(pid) {
  return ['taskkill', '/PID', String(pid), '/T', '/F']
}

/**
 * Spawn `taskkill /PID <pid> /T /F` and wait for it to complete.
 *
 * Tolerates an already-exited process.  If `taskkill` is not available
 * (ENOENT — not Windows), falls back to `child.kill('SIGTERM')` so that
 * tests using `platform: 'win32'` on POSIX still make progress.
 *
 * @param {{ pid?: number, kill?: Function }} child
 * @param {{ env?: Record<string, string> }} [options]
 * @returns {Promise<void>}
 */
export async function windowsTerminateProcess(child, { env: environment } = {}) {
  if (!child.pid) return
  const args = buildWindowsTerminateArgs(child.pid)
  return new Promise((resolve, reject) => {
    const proc = spawn('taskkill', args.slice(1), {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...environment, LANG: 'C' },
    })
    let stderr = ''
    proc.stderr.on('data', chunk => { stderr += chunk.toString() })
    proc.on('error', err => {
      // taskkill not available (not Windows). Fall back to normal kill.
      if (err.code === 'ENOENT') {
        if (typeof child.kill === 'function') child.kill('SIGTERM')
        return resolve()
      }
      reject(err)
    })
    proc.on('exit', code => {
      if (code === 0) return resolve()
      const stderrLower = stderr.toLowerCase()
      if (code === 128 || stderrLower.includes('not found') || stderrLower.includes('no running instance')) {
        return resolve()
      }
      reject(new Error(`taskkill /PID ${child.pid} /T /F failed with exit code ${code}: ${stderr.slice(0, 200)}`))
    })
  })
}

// ── terminateProcess ──────────────────────────────────────────────────

/**
 * Terminate a child process with bounded escalation.
 *
 * **Non-group mode** (default):
 *   Send SIGTERM, wait for the child 'exit' event or pipe-stream closure,
 *   escalate to SIGKILL on timeout, destroy streams.
 *
 * **Process-group mode** (useProcessGroup: true):
 *   Send SIGTERM to the group (`-child.pid`).  Poll for the group to
 *   disappear via `checkGroup(pid)` — this is independent of pipe-stream
 *   state, so inherited stdio is handled correctly.  Pipe closure is an
 *   *additional* signal when pipe streams exist.  Escalate to SIGKILL
 *   on timeout, continue bounded polling.
 *
 * @param {import('node:child_process').ChildProcess} child
 * @param {number} [graceMs=4000]
 * @param {{ useProcessGroup?: boolean, checkGroup?: (pid: number) => { exists: boolean, error?: Error } }} [options]
 */
export async function terminateProcess(
  child,
  graceMs = 4_000,
  { useProcessGroup = false, checkGroup = checkProcessGroupExists } = {},
) {
  // Without process groups, already-reaped children are safe to skip.
  if (!useProcessGroup && (child.exitCode !== null || child.signalCode !== null)) return
  // Without a PID we cannot reference any process group.
  if (useProcessGroup && !child.pid) return

  // ── Completion signals ──────────────────────────────────────────────

  // Child exit event — only works if the child hasn't already exited.
  const exited = child.exitCode === null && child.signalCode === null
    ? new Promise(resolve => child.once('exit', () => resolve(true)))
    : new Promise(() => {}) // never settles — child already reaped

  // Pipe closure — for descendants that inherited stdio FDs.
  const pipesClosed = new Promise(resolve => {
    let pending = 0
    const dec = () => { if (--pending <= 0) resolve(true) }
    if (child.stdout) { pending++; child.stdout.once('close', dec) }
    if (child.stderr) { pending++; child.stderr.once('close', dec) }
    if (pending === 0) resolve(true) // no pipe streams at all
  })

  // ── Process-group mode ──────────────────────────────────────────────

  if (useProcessGroup) {
    sendSignal(child, 'SIGTERM', true)

    // Primary = group-gone polling; secondary = pipe closure if pipes exist.
    const completed = await Promise.race([
      waitForProcessGroupGone(child.pid, graceMs, checkGroup),
      ...(child.stdout || child.stderr ? [pipesClosed] : []),
    ])

    if (completed) {
      child.stdout?.destroy()
      child.stderr?.destroy()
      child.stdin?.end()
      return
    }

    // Escalate to SIGKILL.
    sendSignal(child, 'SIGKILL', true)
    await waitForProcessGroupGone(child.pid, 500, checkGroup)

    child.stdout?.destroy()
    child.stderr?.destroy()
    child.stdin?.end()
    return
  }

  // ── Non-group mode (pipe/exit based logic) ──────────────────────────

  sendSignal(child, 'SIGTERM', false)

  const cleanExit = await Promise.race([
    Promise.race([exited, pipesClosed]),
    new Promise(resolve => setTimeout(() => resolve(false), graceMs)),
  ])

  if (!cleanExit) {
    sendSignal(child, 'SIGKILL', false)
    await Promise.race([
      Promise.race([exited, pipesClosed]),
      new Promise(resolve => setTimeout(resolve, 500)),
    ])
  }

  child.stdout?.destroy()
  child.stderr?.destroy()
  child.stdin?.end()
}
