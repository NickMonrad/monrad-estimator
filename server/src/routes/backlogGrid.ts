import { Router } from 'express'
import type { Response } from 'express'
import { asyncHandler } from '../lib/asyncHandler.js'
import { authenticate, type AuthRequest } from '../middleware/auth.js'
import { ownedProject } from '../lib/ownership.js'
import {
  BacklogGridValidationError,
  commitBacklogGrid,
  type BacklogGridRowInput,
} from '../lib/backlogGrid.js'

const router = Router({ mergeParams: true })
router.use(authenticate)

router.post('/grid-commit', asyncHandler(async (req: AuthRequest, res: Response) => {
  const projectId = req.params.projectId as string
  const project = await ownedProject(projectId, req.userId!)
  if (!project) {
    res.status(404).json({ error: 'Project not found' })
    return
  }
  const rows = req.body?.rows as BacklogGridRowInput[] | undefined
  if (!Array.isArray(rows) || rows.length === 0) {
    res.status(400).json({ error: 'rows array is required' })
    return
  }
  try {
    const result = await commitBacklogGrid(projectId, req.userId!, rows)
    res.json({ message: 'Grid entry committed', ...result })
  } catch (error) {
    if (error instanceof BacklogGridValidationError) {
      res.status(400).json({ error: error.message, fieldErrors: error.fieldErrors })
      return
    }
    throw error
  }
}))

export default router
