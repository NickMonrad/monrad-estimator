import { Router } from 'express'
import type { Response } from 'express'
import { asyncHandler } from '../lib/asyncHandler.js'
import { BacklogDuplicationError, duplicateBacklogItem, type BacklogItemType } from '../lib/backlogDuplication.js'
import { ownedProject } from '../lib/ownership.js'
import { authenticate } from '../middleware/auth.js'
import type { AuthRequest } from '../middleware/auth.js'

const router = Router({ mergeParams: true })
router.use(authenticate)

function isBacklogItemType(value: unknown): value is BacklogItemType {
  return value === 'epic' || value === 'feature' || value === 'story' || value === 'task'
}

// POST /api/projects/:projectId/backlog/duplicate
router.post('/duplicate', asyncHandler(async (req: AuthRequest, res: Response) => {
  const projectId = req.params.projectId as string
  const { type, id } = req.body ?? {}
  if (!isBacklogItemType(type) || typeof id !== 'string' || id.length === 0) {
    res.status(400).json({ error: 'type and id are required' })
    return
  }

  const project = await ownedProject(projectId, req.userId!)
  if (!project) {
    res.status(404).json({ error: 'Project not found' })
    return
  }

  try {
    const duplicate = await duplicateBacklogItem(project.id, type, id)
    if (!duplicate) {
      res.status(404).json({ error: 'Backlog item not found' })
      return
    }
    res.status(201).json(duplicate)
  } catch (error) {
    if (error instanceof BacklogDuplicationError) {
      res.status(error.status).json({ error: error.message })
      return
    }
    throw error
  }
}))

export default router
