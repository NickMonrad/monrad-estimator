import { PrismaClient } from '@prisma/client'

/**
 * #177: Snapshot retention — keep only the `keep` most-recent snapshots per project.
 * Call after every backlogSnapshot.create() to prevent unbounded growth.
 */
export async function pruneSnapshots(
  prisma: PrismaClient,
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
