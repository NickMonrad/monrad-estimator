/**
 * planning.ts — Project planning-state routes (issue #449).
 *
 * POST /api/projects/:projectId/planning/reset    — Reset Planning (discard)
 * POST /api/projects/:projectId/planning/complete — Complete replanning
 *
 * Reset discards planning state and marks the project NEEDS_REPLAN; it never
 * creates replacement capacity. Replanning is built through the existing
 * planning surfaces (Resource Profile profiles, Squad Planner), and
 * completion only flips the state back to CURRENT when canonical validation
 * passes. The two operations are deliberately NOT merged into one endpoint.
 */

import { Router, Response } from 'express'

import { prisma } from '../lib/prisma.js'
import { asyncHandler } from '../lib/asyncHandler.js'
import { authenticate, AuthRequest } from '../middleware/auth.js'
import { ownedProject } from '../lib/ownership.js'
import { resetProjectPlanning } from '../lib/resetProjectPlanning.js'
import { completeReplanning, ReplanIncompleteError } from '../lib/completeReplanning.js'

const router = Router({ mergeParams: true })
router.use(authenticate)

/**
 * POST /api/projects/:projectId/planning/reset
 *
 * Explicit destructive intent is required: the request body must carry
 * `{ confirm: true }`. The response returns the resulting planning state
 * (NEEDS_REPLAN); no replacement capacity profile is ever created here.
 */
router.post('/reset', asyncHandler(async (req: AuthRequest, res: Response) => {
  const projectId = req.params.projectId as string
  const project = await ownedProject(projectId, req.userId!)
  if (!project) {
    res.status(404).json({ error: 'Project not found' })
    return
  }
  if (req.body?.confirm !== true) {
    res.status(400).json({
      error: 'Reset planning requires explicit confirmation: send { confirm: true }.',
    })
    return
  }

  const result = await resetProjectPlanning(prisma, projectId)
  res.json(result)
}))

/**
 * POST /api/projects/:projectId/planning/complete
 *
 * Validates canonical project planning state and atomically marks the
 * project CURRENT only when valid. Incomplete plans fail with actionable
 * validation findings (422 REPLAN_INCOMPLETE) and leave NEEDS_REPLAN intact.
 */
router.post('/complete', asyncHandler(async (req: AuthRequest, res: Response) => {
  const projectId = req.params.projectId as string
  const project = await ownedProject(projectId, req.userId!)
  if (!project) {
    res.status(404).json({ error: 'Project not found' })
    return
  }

  try {
    const planningState = await completeReplanning(prisma, projectId)
    res.json({ projectId, planningState })
  } catch (error) {
    if (error instanceof ReplanIncompleteError) {
      res.status(error.status).json({
        error: error.message,
        code: error.code,
        findings: error.findings,
      })
      return
    }
    throw error
  }
}))

export default router
