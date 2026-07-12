/**
 * Minimal client interface compatible with both PrismaClient and transaction client.
 * Covers only the backlogSnapshot methods pruneSnapshots needs.
 */
export interface SnapshotDbLike {
  backlogSnapshot: {
    findMany(args: {
      where: { projectId: string }
      orderBy: { createdAt: 'desc' }
      skip: number
      select: { id: true }
    }): Promise<Array<{ id: string }>>
    deleteMany(args: { where: { id: { in: string[] } } }): Promise<{ count: number }>
  }
}

/**
 * #177: Snapshot retention — keep only the `keep` most-recent snapshots per project.
 * Call after every backlogSnapshot.create() to prevent unbounded growth.
 */
export async function pruneSnapshots(
  prisma: SnapshotDbLike,
  projectId: string,
  keep = 20,
): Promise<void> {
  const old = await prisma.backlogSnapshot.findMany({
    where: { projectId },
    orderBy: { createdAt: 'desc' },
    skip: keep,
    select: { id: true },
  })
  if (old.length > 0) {
    await prisma.backlogSnapshot.deleteMany({ where: { id: { in: old.map(s => s.id) } } })
  }
}
