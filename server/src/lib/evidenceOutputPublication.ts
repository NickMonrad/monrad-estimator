/**
 * evidenceOutputPublication.ts — Issue #432: all-or-nothing, no-clobber
 * publication of the two evidence output files.
 *
 * Guarantees:
 *   - both complete strings are staged into exclusive temporary files
 *     (mode 0600) inside the corresponding output directories;
 *   - the final publication step itself refuses an existing destination:
 *     each final path is created as a hard link to the staged file
 *     (fs.linkSync fails with EEXIST when the destination already exists —
 *     never a check-then-rename sequence, so a destination created by
 *     another process between preflight and publication cannot be
 *     overwritten);
 *   - temporary files are removed only after BOTH final paths have been
 *     published;
 *   - on any staging or publication failure every temporary file created by
 *     this run and every final file created by this run (tracked by inode)
 *     are removed; destinations that existed before or appeared
 *     independently are never touched;
 *   - on success both finals exist, are distinct files with mode 0600 on
 *     POSIX, contain the intended complete content, and no temporary files
 *     remain.
 *
 * The optional `hooks` parameter is a test-only failure injection seam (the
 * production CLI never passes it).
 */

import { closeSync, linkSync, openSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import path from 'node:path'

/** Test-only failure injection phases; the production CLI never uses hooks. */
export type EvidencePublishPhase =
  | 'stage-json'
  | 'stage-markdown'
  | 'publish-json'
  | 'publish-markdown'

export interface EvidencePublishHooks {
  failOn?: (phase: EvidencePublishPhase) => void
}

export interface PublishedEvidenceOutputs {
  jsonPath: string
  markdownPath: string
}

/**
 * Publish the JSON and Markdown evidence outputs atomically as a set with
 * no-clobber final steps. Throws on any failure after cleaning up every file
 * created by this run (see module docs).
 */
export function publishEvidenceOutputs(
  jsonPath: string,
  markdownPath: string,
  jsonContent: string,
  markdownContent: string,
  hooks?: EvidencePublishHooks,
): PublishedEvidenceOutputs {
  const tempPaths: string[] = []
  /** Finals created by THIS run, tracked by (path, inode) for safe cleanup. */
  const ownedFinals: Array<{ finalPath: string; ino: number }> = []
  const fail = (phase: EvidencePublishPhase): void => {
    if (hooks?.failOn) hooks.failOn(phase)
  }
  const cleanup = (): void => {
    for (const temp of tempPaths) {
      try { rmSync(temp, { force: true }) } catch { /* best-effort */ }
    }
    for (const owned of ownedFinals) {
      try {
        // Only remove the final when it is still the inode this run created;
        // a destination that appeared independently is never deleted.
        const current = statSync(owned.finalPath)
        if (current.ino === owned.ino) unlinkSync(owned.finalPath)
      } catch { /* already gone or unreadable — nothing owned to remove */ }
    }
  }
  const tempPathFor = (finalPath: string): string => {
    const dir = path.dirname(finalPath)
    const base = path.basename(finalPath)
    return path.join(dir, `.${base}.evidence-${randomBytes(8).toString('hex')}.tmp`)
  }
  const stage = (finalPath: string, content: string, phase: EvidencePublishPhase): string => {
    const temp = tempPathFor(finalPath)
    tempPaths.push(temp)
    const fd = openSync(temp, 'wx', 0o600)
    try {
      writeFileSync(fd, content, 'utf8')
    } finally {
      closeSync(fd)
    }
    fail(phase)
    return temp
  }
  /** No-clobber publish: hard link fails with EEXIST if the destination exists. */
  const publish = (temp: string, finalPath: string, phase: EvidencePublishPhase): void => {
    linkSync(temp, finalPath)
    ownedFinals.push({ finalPath, ino: statSync(finalPath).ino })
    fail(phase)
  }

  try {
    const jsonTemp = stage(jsonPath, jsonContent, 'stage-json')
    const markdownTemp = stage(markdownPath, markdownContent, 'stage-markdown')
    publish(jsonTemp, jsonPath, 'publish-json')
    publish(markdownTemp, markdownPath, 'publish-markdown')
    // Both finals are published; only now remove the staged temporaries.
    for (const temp of tempPaths) {
      try { rmSync(temp, { force: true }) } catch { /* best-effort */ }
    }
    tempPaths.length = 0
    return { jsonPath, markdownPath }
  } catch (error) {
    cleanup()
    throw error
  }
}
