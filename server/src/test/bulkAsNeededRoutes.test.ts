/**
 * bulkAsNeededRoutes.test.ts — Route tests for the bulk
 * "Use role counts as As needed" endpoint (issue #456):
 * POST /api/projects/:projectId/capacity-profiles/bulk-as-needed.
 *
 * Proves authentication, success mapping, and the stable guard-error codes
 * surfaced by the endpoint. Service semantics are covered by
 * bulkAsNeededProfiles.test.ts and the PostgreSQL integration suite.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import request from 'supertest'
import jwt from 'jsonwebtoken'

import { app } from '../index.js'

const userId = 'user-1'
process.env.JWT_SECRET = 'test-secret'
const token = jwt.sign({ userId }, 'test-secret')
const authHeader = `Bearer ${token}`

const { applyRoleCountsAsNeeded, BulkAsNeededError } = vi.hoisted(() => {
  class BulkAsNeededError extends Error {
    status: number
    code: string
    constructor(status: number, code: string, message: string) {
      super(message)
      this.status = status
      this.code = code
    }
  }
  return { applyRoleCountsAsNeeded: vi.fn(), BulkAsNeededError }
})

vi.mock('../lib/bulkAsNeededProfiles.js', () => ({
  applyRoleCountsAsNeeded,
  BulkAsNeededError,
}))

beforeEach(() => vi.clearAllMocks())

describe('POST /api/projects/:projectId/capacity-profiles/bulk-as-needed', () => {
  it('rejects unauthenticated request', async () => {
    const res = await request(app).post('/api/projects/proj-1/capacity-profiles/bulk-as-needed')
    expect(res.status).toBe(401)
    expect(applyRoleCountsAsNeeded).not.toHaveBeenCalled()
  })

  it('creates profiles for eligible missing roles and reports remaining findings', async () => {
    applyRoleCountsAsNeeded.mockResolvedValue({
      projectId: 'proj-1',
      planningState: 'NEEDS_REPLAN',
      created: 3,
      remainingFindings: ['Named resource "Alice" lacks persisted profile (named resource nr-1, resource type rt-3)'],
    })

    const res = await request(app)
      .post('/api/projects/proj-1/capacity-profiles/bulk-as-needed')
      .set('Authorization', authHeader)

    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      projectId: 'proj-1',
      planningState: 'NEEDS_REPLAN',
      created: 3,
      remainingFindings: ['Named resource "Alice" lacks persisted profile (named resource nr-1, resource type rt-3)'],
    })
    expect(applyRoleCountsAsNeeded).toHaveBeenCalledWith(expect.anything(), 'proj-1', userId)
  })

  it('surfaces the NEEDS_REPLAN-only guard with its stable 409 code', async () => {
    applyRoleCountsAsNeeded.mockRejectedValue(
      new BulkAsNeededError(
        409,
        'REPLAN_ACTION_UNAVAILABLE',
        'This action is only available while the project needs replanning. ' +
          'Complete or reset the plan before retrying.',
      ),
    )

    const res = await request(app)
      .post('/api/projects/proj-1/capacity-profiles/bulk-as-needed')
      .set('Authorization', authHeader)

    expect(res.status).toBe(409)
    expect(res.body.code).toBe('REPLAN_ACTION_UNAVAILABLE')
  })

  it('surfaces 404 for a missing project', async () => {
    applyRoleCountsAsNeeded.mockRejectedValue(
      new BulkAsNeededError(404, 'PROJECT_NOT_FOUND', 'Project not found or access denied'),
    )

    const res = await request(app)
      .post('/api/projects/proj-missing/capacity-profiles/bulk-as-needed')
      .set('Authorization', authHeader)

    expect(res.status).toBe(404)
    expect(res.body.code).toBe('PROJECT_NOT_FOUND')
  })
})
