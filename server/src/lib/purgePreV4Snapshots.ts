/**
 * purgePreV4Snapshots.ts — Deliberate pre-V4 BacklogSnapshot purge (issue #444).
 *
 * One explicit maintenance operation: identify and remove every stored
 * BacklogSnapshot whose payload is positively classified V1/V2/V3. It never
 * touches V4 snapshots, never touches project/backlog/resource/profile/
 * timeline tables, and never synthesises snapshots.
 *
 * Safety contract:
 *   - default DRY RUN performs zero writes;
 *   - APPLY deletes ONLY rows positively classified V1/V2/V3;
 *   - APPLY aborts before any deletion (and reports the aggregate count) when
 *     ANY malformed/unsupported snapshot exists — unexpected data is never
 *     "worked around";
 *   - the report is aggregate-only: no project IDs, snapshot IDs, payloads,
 *     user data, or credentials.
 *
 * The version authority is `classifySnapshotVersion` (parseSnapshotData +
 * the existing version guards); no second parser exists.
 */

import { classifySnapshotVersion } from './snapshotVersionClassification.js'

// ─── Report types ────────────────────────────────────────────────────────────

export interface SnapshotVersionCounts {
  v1: number
  v2: number
  v3: number
  v4: number
  malformed: number
}

export interface PreV4PurgeReport {
  dryRun: boolean
  before: SnapshotVersionCounts
  after: SnapshotVersionCounts
  deletedCount: number
  aborted: boolean
  abortReason: string | null
}

/** Minimal client interface compatible with PrismaClient and transaction
 * clients — covers only the BacklogSnapshot reads/writes the purge needs. */
export interface PurgeSnapshotDb {
  backlogSnapshot: {
    findMany(args: {
      select: { id: true; snapshot: true }
    }): Promise<Array<{ id: string; snapshot: unknown }>>
    deleteMany(args: { where: { id: { in: string[] } } }): Promise<{ count: number }>
  }
}

// ─── Purge ───────────────────────────────────────────────────────────────────

function emptyCounts(): SnapshotVersionCounts {
  return { v1: 0, v2: 0, v3: 0, v4: 0, malformed: 0 }
}

/**
 * Read every BacklogSnapshot payload, classify each by version, and (in
 * apply mode) delete exactly the positively-classified V1/V2/V3 rows.
 *
 * @param db Connected PrismaClient-compatible client (never disconnected here).
 * @param options.apply Explicit destructive opt-in. Without it the command is
 *   a read-only dry run that performs zero writes.
 */
export async function purgePreV4Snapshots(
  db: PurgeSnapshotDb,
  options: { apply: boolean },
): Promise<PreV4PurgeReport> {
  const rows = await db.backlogSnapshot.findMany({ select: { id: true, snapshot: true } })

  const before = emptyCounts()
  const preV4Ids: string[] = []
  for (const row of rows) {
    const version = classifySnapshotVersion(row.snapshot)
    switch (version.kind) {
      case 'v1':
        before.v1++
        preV4Ids.push(row.id)
        break
      case 'v2':
        before.v2++
        preV4Ids.push(row.id)
        break
      case 'v3':
        before.v3++
        preV4Ids.push(row.id)
        break
      case 'v4':
        before.v4++
        break
      case 'malformed':
        before.malformed++
        break
    }
  }

  if (!options.apply) {
    return {
      dryRun: true,
      before,
      after: { ...before },
      deletedCount: 0,
      aborted: false,
      abortReason: null,
    }
  }

  // Fail closed: unexpected malformed/unsupported data aborts the entire
  // apply with zero deletions and an aggregate reason.
  if (before.malformed > 0) {
    return {
      dryRun: false,
      before,
      after: { ...before },
      deletedCount: 0,
      aborted: true,
      abortReason:
        `aborted before any deletion: ${before.malformed} malformed/unsupported ` +
        'BacklogSnapshot(s) present — resolve or remove them first',
    }
  }

  const deleted = preV4Ids.length > 0
    ? await db.backlogSnapshot.deleteMany({ where: { id: { in: preV4Ids } } })
    : { count: 0 }

  return {
    dryRun: false,
    before,
    after: { ...before, v1: 0, v2: 0, v3: 0 },
    deletedCount: deleted.count,
    aborted: false,
    abortReason: null,
  }
}

// ─── Rendering ───────────────────────────────────────────────────────────────

function renderCounts(counts: SnapshotVersionCounts): string {
  return [
    `  V1 BacklogSnapshots: ${counts.v1}`,
    `  V2 BacklogSnapshots: ${counts.v2}`,
    `  V3 BacklogSnapshots: ${counts.v3}`,
    `  V4 BacklogSnapshots: ${counts.v4}`,
    `  malformed/unsupported BacklogSnapshots: ${counts.malformed}`,
    `  total BacklogSnapshots: ${counts.v1 + counts.v2 + counts.v3 + counts.v4 + counts.malformed}`,
  ].join('\n')
}

/** Render a sanitized, aggregate-only human-readable report. Never prints
 * project names, project IDs, snapshot IDs, payloads, user data, or
 * database connection details. */
export function formatPurgeReport(report: PreV4PurgeReport): string {
  const lines: string[] = []
  lines.push('═══ Pre-V4 BacklogSnapshot Purge ═══')
  lines.push('')
  lines.push(report.dryRun
    ? 'Mode: DRY RUN — no writes were performed.'
    : report.aborted
      ? 'Mode: APPLY — ABORTED before any deletion.'
      : 'Mode: APPLY')
  lines.push('')
  lines.push('Before:')
  lines.push(renderCounts(report.before))
  lines.push('')
  if (report.aborted) {
    lines.push(`ABORTED: ${report.abortReason ?? 'unknown abort reason'}`)
    lines.push('Deleted: 0')
    lines.push('')
    lines.push('❌ PURGE ABORTED — nothing was deleted.')
    return lines.join('\n')
  }
  if (report.dryRun) {
    const preV4 = report.before.v1 + report.before.v2 + report.before.v3
    lines.push(`Pre-V4 rows that WOULD be deleted: ${preV4}`)
    lines.push('')
    lines.push('Dry run complete — zero writes performed. Re-run with --apply to delete.')
    return lines.join('\n')
  }
  lines.push(`Deleted V1/V2/V3 BacklogSnapshots: ${report.deletedCount}`)
  lines.push('')
  lines.push('After:')
  lines.push(renderCounts(report.after))
  lines.push('')
  const remainingPreV4 = report.after.v1 + report.after.v2 + report.after.v3
  lines.push(remainingPreV4 === 0
    ? '✅ PURGE COMPLETE — no pre-V4 BacklogSnapshots remain. V4 snapshots and all current project data are untouched.'
    : `⚠️ PURGE COMPLETE — ${remainingPreV4} pre-V4 BacklogSnapshot(s) remain.`)
  return lines.join('\n')
}
