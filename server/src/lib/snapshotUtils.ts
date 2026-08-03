/**
 * Minimal client interface compatible with both PrismaClient and transaction client.
 * Covers only the backlogSnapshot methods pruneSnapshots needs — including the
 * raw `snapshot` payload, which retention must classify (issue #428).
 */
import { classifySnapshotRestorability } from './snapshotRestorability.js'
export interface SnapshotDbLike {
  backlogSnapshot: {
    findMany(args: {
      where: { projectId: string }
      orderBy: { createdAt: 'desc' }
      select: { id: true; snapshot: true }
    }): Promise<Array<{ id: string; snapshot: unknown }>>
    deleteMany(args: { where: { id: { in: string[] } } }): Promise<{ count: number }>
  }
}

/**
 * #177: Snapshot retention — keep only the `keep` most-recent snapshots per project.
 * Call after every backlogSnapshot.create() to prevent unbounded growth.
 *
 * Issue #428: automatic retention may delete ONLY snapshots positively
 * classified as restorable. Derived-quarantined historical snapshots and any
 * snapshot whose classification fails (fail closed) are preserved; the
 * newest-`keep` cap applies to the restorable subset, so a project may hold
 * its normal retained restorable snapshots plus protected quarantined or
 * defective historical records. Retention never rewrites snapshot content.
 */
export async function pruneSnapshots(
  prisma: SnapshotDbLike,
  projectId: string,
  keep = 20,
): Promise<void> {
  const records = await prisma.backlogSnapshot.findMany({
    where: { projectId },
    orderBy: { createdAt: 'desc' },
    select: { id: true, snapshot: true },
  })
  const restorable: Array<{ id: string }> = []
  for (const record of records) {
    if (classifySnapshotRestorability(record.snapshot, projectId).kind === 'restorable') {
      restorable.push(record)
    }
  }
  const toDelete = restorable.slice(keep)
  if (toDelete.length > 0) {
    await prisma.backlogSnapshot.deleteMany({ where: { id: { in: toDelete.map(s => s.id) } } })
  }
}
