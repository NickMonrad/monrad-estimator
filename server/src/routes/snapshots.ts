import { Router, Response } from 'express'
import { prisma } from '../lib/prisma.js'
import { asyncHandler } from '../lib/asyncHandler.js'
import { authenticate, AuthRequest } from '../middleware/auth.js'
import { ownedProject } from '../lib/ownership.js'
import {
  rollbackProjectSnapshot,
  buildSnapshot,
  SnapshotNotFoundError,
  RollbackPreflightError,
} from '../lib/projectSnapshotService.js'
import {
  parseSnapshotData,
  isLegacyV1Snapshot,
  SnapshotSchemaError,
  type SnapshotData,
  type SnapshotEpic,
} from '../lib/projectSnapshotTypes.js'
import {
  SnapshotValidationError,
} from '../lib/projectSnapshotValidation.js'
import { pruneSnapshots } from '../lib/snapshotUtils.js'

const router = Router({ mergeParams: true })
router.use(authenticate)

// ---------------------------------------------------------------------------
// Schema versions: 1 (bare epic array), 2 (full state), 3 (v2 + capacityProfiles)
// Documented trigger values:
//   'manual'           — user-initiated from the UI
//   'csv_import'       — auto-saved before a CSV import
//   'template_apply'   — auto-saved before applying a template
//   'optimiser_apply'  — auto-saved before the optimiser applies a scenario (Phase 2+)
//   'pre_rollback'     — auto-saved before rolling back to a prior snapshot (reversible rollback)
// ---------------------------------------------------------------------------

// GET /api/projects/:projectId/snapshots
router.get('/', asyncHandler(async (req: AuthRequest, res: Response) => {
  const projectId = req.params.projectId as string
  const project = await ownedProject(projectId, req.userId!)
  if (!project) { res.status(404).json({ error: 'Project not found' }); return }

  const snapshots = await prisma.backlogSnapshot.findMany({
    where: { projectId },
    orderBy: { createdAt: 'desc' },
    select: { id: true, label: true, trigger: true, createdAt: true, createdById: true },
  })
  res.json(snapshots)
}))

// POST /api/projects/:projectId/snapshots — manual snapshot
router.post('/', asyncHandler(async (req: AuthRequest, res: Response) => {
  const projectId = req.params.projectId as string
  const project = await ownedProject(projectId, req.userId!)
  if (!project) { res.status(404).json({ error: 'Project not found' }); return }

  const { label } = req.body as { label?: string }
  const snapshotData = await buildSnapshot(projectId)
  const snap = await prisma.backlogSnapshot.create({
    data: {
      projectId,
      label: label ?? null,
      trigger: 'manual',
      snapshot: snapshotData as unknown as object,
      createdById: req.userId!,
    },
    select: { id: true, label: true, trigger: true, createdAt: true },
  })
  // #177: enforce retention policy — keep the 20 most-recent snapshots per project
  await pruneSnapshots(prisma, projectId)
  res.status(201).json(snap)
}))

// GET /api/projects/:projectId/snapshots/:snapshotId
router.get('/:snapshotId', asyncHandler(async (req: AuthRequest, res: Response) => {
  const { projectId, snapshotId } = req.params as { projectId: string; snapshotId: string }
  const project = await ownedProject(projectId, req.userId!)
  if (!project) { res.status(404).json({ error: 'Project not found' }); return }

  const snap = await prisma.backlogSnapshot.findFirst({ where: { id: snapshotId, projectId } })
  if (!snap) { res.status(404).json({ error: 'Snapshot not found' }); return }
  res.json(snap)
}))

// GET /api/projects/:projectId/snapshots/:snapshotId/diff
router.get('/:snapshotId/diff', asyncHandler(async (req: AuthRequest, res: Response) => {
  const { projectId, snapshotId } = req.params as { projectId: string; snapshotId: string }
  const project = await ownedProject(projectId, req.userId!)
  if (!project) { res.status(404).json({ error: 'Project not found' }); return }

  const snap = await prisma.backlogSnapshot.findFirst({ where: { id: snapshotId, projectId } })
  if (!snap) { res.status(404).json({ error: 'Snapshot not found' }); return }

  let parsed: SnapshotData
  try {
    parsed = parseSnapshotData(snap.snapshot)
  } catch (e) {
    if (e instanceof SnapshotSchemaError) {
      res.status(400).json({ error: e.message })
      return
    }
    throw e
  }

  const currentSnapshot = await buildSnapshot(projectId)

  // Produce a simple flat diff of epic/feature/story/task names
  const flatten = (epics: SnapshotEpic[]) => {
    const items: string[] = []
    for (const e of epics) {
      items.push(`Epic: ${e.name}`)
      for (const f of e.features) {
        items.push(`  Feature: ${f.name}`)
        for (const s of f.userStories) {
          items.push(`    Story: ${s.name}`)
          for (const t of s.tasks) {
            items.push(`      Task: ${t.name} (${t.hoursEffort}h)`)
          }
        }
      }
    }
    return items
  }

  const snapEpics = isLegacyV1Snapshot(parsed) ? parsed : parsed.epics
  const currentEpics = currentSnapshot.epics
  const snapItems = flatten(snapEpics)
  const currentItems = flatten(currentEpics)
  const snapSet = new Set(snapItems)
  const currentSet = new Set(currentItems)

  res.json({
    added: currentItems.filter(i => !snapSet.has(i)),
    removed: snapItems.filter(i => !currentSet.has(i)),
    snapshotAt: snap.createdAt,
  })
}))

// POST /api/projects/:projectId/snapshots/:snapshotId/rollback
router.post('/:snapshotId/rollback', asyncHandler(async (req: AuthRequest, res: Response) => {
  const { projectId, snapshotId } = req.params as { projectId: string; snapshotId: string }
  const project = await ownedProject(projectId, req.userId!)
  if (!project) { res.status(404).json({ error: 'Project not found' }); return }

  try {
    await rollbackProjectSnapshot({
      projectId,
      snapshotId,
      userId: req.userId!,
    })
    res.json({ message: 'Rollback complete' })
  } catch (e) {
    if (e instanceof SnapshotNotFoundError) {
      res.status(404).json({ error: e.message }); return
    }
    if (e instanceof SnapshotSchemaError) {
      res.status(400).json({ error: e.message }); return
    }
    if (e instanceof SnapshotValidationError) {
      res.status(400).json({ error: e.message }); return
    }
    if (e instanceof RollbackPreflightError) {
      res.status(400).json({ error: e.message }); return
    }
    throw e
  }
}))


export default router

// Export the buildSnapshot helper for use in other routes
export { buildSnapshot }
