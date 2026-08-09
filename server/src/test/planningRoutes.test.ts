/**
 * planningRoutes.test.ts — Route tests for the project planning-state API
 * (issue #449): POST /planning/reset and POST /planning/complete.
 *
 * Covers authentication/ownership, explicit destructive confirmation,
 * CURRENT → NEEDS_REPLAN, and the canonical-validation-gated completion
 * (422 REPLAN_INCOMPLETE with actionable findings).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import request from 'supertest'
import jwt from 'jsonwebtoken'

import { app } from '../index.js'
import { prisma } from '../lib/prisma.js'

const userId = 'user-1'
process.env.JWT_SECRET = 'test-secret'
const token = jwt.sign({ userId }, 'test-secret')
const authHeader = `Bearer ${token}`

beforeEach(() => vi.clearAllMocks())

describe('POST /api/projects/:projectId/planning/reset', () => {
  it('rejects unauthenticated request', async () => {
    const res = await request(app).post('/api/projects/proj-1/planning/reset').send({ confirm: true })
    expect(res.status).toBe(401)
  })

  it('returns 404 for missing or inaccessible project', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue(null)
    const res = await request(app)
      .post('/api/projects/proj-missing/planning/reset')
      .set('Authorization', authHeader)
      .send({ confirm: true })
    expect(res.status).toBe(404)
    expect(prisma.$transaction).not.toHaveBeenCalled()
  })

  it('requires explicit confirmation', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue({ id: 'proj-1', ownerId: userId } as never)
    const res = await request(app)
      .post('/api/projects/proj-1/planning/reset')
      .set('Authorization', authHeader)
      .send({})
    expect(res.status).toBe(400)
    expect(res.body.error).toContain('explicit confirmation')
    expect(prisma.$transaction).not.toHaveBeenCalled()
  })

  it('resets planning and returns the NEEDS_REPLAN state', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue({ id: 'proj-1', ownerId: userId } as never)
    vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) => {
      const tx = {
        project: {
          findUnique: vi.fn().mockResolvedValue({ id: 'proj-1', planningState: 'CURRENT' }),
          update: vi.fn(),
        },
        capacityProfile: { findMany: vi.fn().mockResolvedValue([]), deleteMany: vi.fn() },
        capacityPlan: { deleteMany: vi.fn() },
        timelineEntry: { deleteMany: vi.fn() },
        storyTimelineEntry: { deleteMany: vi.fn() },
        namedResource: { deleteMany: vi.fn() },
      }
      return fn(tx)
    })

    const res = await request(app)
      .post('/api/projects/proj-1/planning/reset')
      .set('Authorization', authHeader)
      .send({ confirm: true })

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ projectId: 'proj-1', planningState: 'NEEDS_REPLAN' })
  })
})

describe('POST /api/projects/:projectId/planning/complete', () => {
  it('rejects unauthenticated request', async () => {
    const res = await request(app).post('/api/projects/proj-1/planning/complete')
    expect(res.status).toBe(401)
  })

  it('returns 404 for missing or inaccessible project', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue(null)
    const res = await request(app)
      .post('/api/projects/proj-missing/planning/complete')
      .set('Authorization', authHeader)
    expect(res.status).toBe(404)
  })

  it('fails with actionable findings when planning is incomplete (no profiles)', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue({ id: 'proj-1', ownerId: userId } as never)
    const txUpdate = vi.fn()
    vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) => {
      const tx = {
        project: {
          findUnique: vi.fn()
            .mockResolvedValueOnce({ id: 'proj-1', planningState: 'NEEDS_REPLAN' })
            .mockResolvedValueOnce({
              id: 'proj-1',
              resourceTypes: [{ id: 'rt-1', name: 'Engineer', namedResources: [] }],
              capacityProfiles: [],
            }),
          update: txUpdate,
        },
      }
      return fn(tx)
    })

    const res = await request(app)
      .post('/api/projects/proj-1/planning/complete')
      .set('Authorization', authHeader)

    expect(res.status).toBe(422)
    expect(res.body.code).toBe('REPLAN_INCOMPLETE')
    expect(res.body.findings.length).toBeGreaterThan(0)
    expect(res.body.error).toContain('Replanning is incomplete')
    // The state must NOT have been flipped.
    expect(txUpdate).not.toHaveBeenCalled()
  })

  it('atomically flips NEEDS_REPLAN to CURRENT when canonical validation passes', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue({ id: 'proj-1', ownerId: userId } as never)
    let updated = false
    vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) => {
      const tx = {
        project: {
          findUnique: vi.fn()
            .mockResolvedValueOnce({ id: 'proj-1', planningState: 'NEEDS_REPLAN' })
            .mockResolvedValueOnce({
              id: 'proj-1',
              resourceTypes: [{ id: 'rt-1', name: 'Engineer', namedResources: [] }],
              capacityProfiles: [{
                id: 'cp-1',
                projectId: 'proj-1',
                resourceTypeId: 'rt-1',
                namedResourceId: null,
                ownerKind: 'ROLE',
                source: 'MANUAL',
                planningBasis: 'DEMAND_FOLLOWING',
                defaultPercent: 100,
                startWeek: null,
                endWeek: null,
                segments: [],
              }],
            }),
          update: vi.fn(async args => { updated = true; return args }),
        },
      }
      return fn(tx)
    })

    const res = await request(app)
      .post('/api/projects/proj-1/planning/complete')
      .set('Authorization', authHeader)

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ projectId: 'proj-1', planningState: 'CURRENT' })
    expect(updated).toBe(true)
  })

  it('is a no-op success for an already CURRENT project', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue({ id: 'proj-1', ownerId: userId } as never)
    const txUpdate = vi.fn()
    vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) => {
      const tx = {
        project: { findUnique: vi.fn().mockResolvedValue({ id: 'proj-1', planningState: 'CURRENT' }), update: txUpdate },
      }
      return fn(tx)
    })

    const res = await request(app)
      .post('/api/projects/proj-1/planning/complete')
      .set('Authorization', authHeader)

    expect(res.status).toBe(200)
    expect(res.body.planningState).toBe('CURRENT')
    expect(txUpdate).not.toHaveBeenCalled()
  })
})
