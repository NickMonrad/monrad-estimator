import { describe, it, expect, vi, beforeEach } from 'vitest'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { app } from '../index.js'
import { prisma } from '../lib/prisma.js'
import { round2, calcDurationDays } from '../utils/round.js'
import { asyncHandler } from '../lib/asyncHandler.js'
import type { Request, Response, NextFunction } from 'express'

process.env.JWT_SECRET = 'test-secret'

const userId = 'user-1'
const token = jwt.sign({ userId }, 'test-secret')
const authHeader = `Bearer ${token}`

const mockProject = { id: 'proj-1', ownerId: userId, name: 'Test Project' }
const mockEpic = { id: 'epic-1', projectId: 'proj-1', name: 'Epic 1', order: 0, project: { ownerId: userId } }
const mockFeature = { id: 'feat-1', epicId: 'epic-1', name: 'Feature 1', order: 0, epic: { project: { ownerId: userId } } }
const mockStory = { id: 'story-1', featureId: 'feat-1', name: 'Story 1', order: 0 }

beforeEach(() => vi.clearAllMocks())

// ─── 1. Shared ownership helpers ─────────────────────────────────────────────

describe('Ownership helpers — project boundary', () => {
  it('GET /api/projects/:id/epics returns 404 for unowned project', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue(null)
    const res = await request(app)
      .get('/api/projects/other-proj/epics')
      .set('Authorization', authHeader)
    expect(res.status).toBe(404)
  })

  it('GET /api/projects/:id/epics returns 200 for owned project', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue(mockProject as any)
    vi.mocked(prisma.epic.findMany).mockResolvedValue([])
    const res = await request(app)
      .get('/api/projects/proj-1/epics')
      .set('Authorization', authHeader)
    expect(res.status).toBe(200)
  })
})

describe('Ownership helpers — epic boundary', () => {
  it('GET /api/epics/:id/features returns 404 when epic not found', async () => {
    vi.mocked(prisma.epic.findFirst).mockResolvedValue(null)
    const res = await request(app)
      .get('/api/epics/other-epic/features')
      .set('Authorization', authHeader)
    expect(res.status).toBe(404)
  })

  it('GET /api/epics/:id/features returns 200 for owned epic', async () => {
    vi.mocked(prisma.epic.findFirst).mockResolvedValue(mockEpic as any)
    vi.mocked(prisma.feature.findMany).mockResolvedValue([])
    const res = await request(app)
      .get('/api/epics/epic-1/features')
      .set('Authorization', authHeader)
    expect(res.status).toBe(200)
  })
})

describe('Ownership helpers — feature boundary', () => {
  it('GET /api/features/:id/stories returns 404 when feature not found', async () => {
    vi.mocked(prisma.feature.findFirst).mockResolvedValue(null)
    const res = await request(app)
      .get('/api/features/other-feat/stories')
      .set('Authorization', authHeader)
    expect(res.status).toBe(404)
  })

  it('GET /api/features/:id/stories returns 200 for owned feature', async () => {
    vi.mocked(prisma.feature.findFirst).mockResolvedValue(mockFeature as any)
    vi.mocked(prisma.userStory.findMany).mockResolvedValue([])
    const res = await request(app)
      .get('/api/features/feat-1/stories')
      .set('Authorization', authHeader)
    expect(res.status).toBe(200)
  })
})

describe('Ownership helpers — resource types boundary', () => {
  it('GET /api/projects/:id/resource-types returns 404 for unowned project', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue(null)
    const res = await request(app)
      .get('/api/projects/other-proj/resource-types')
      .set('Authorization', authHeader)
    expect(res.status).toBe(404)
  })

  it('GET /api/projects/:id/resource-types returns 200 for owned project', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue(mockProject as any)
    vi.mocked(prisma.resourceType.findMany).mockResolvedValue([])
    const res = await request(app)
      .get('/api/projects/proj-1/resource-types')
      .set('Authorization', authHeader)
    expect(res.status).toBe(200)
  })
})

// ─── 2. count() ordering ─────────────────────────────────────────────────────

describe('count() ordering — epics', () => {
  it('POST epic uses prisma.epic.count for ordering', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue(mockProject as any)
    vi.mocked(prisma.epic.count).mockResolvedValue(3)
    vi.mocked(prisma.epic.create).mockResolvedValue({ ...mockEpic, name: 'New Epic', order: 3 } as any)

    const res = await request(app)
      .post('/api/projects/proj-1/epics')
      .set('Authorization', authHeader)
      .send({ name: 'New Epic' })

    expect(res.status).toBe(201)
    expect(prisma.epic.count).toHaveBeenCalledTimes(1)
    expect(res.body.order).toBe(3)
  })
})

describe('count() ordering — features', () => {
  it('POST feature uses prisma.feature.count for ordering', async () => {
    vi.mocked(prisma.epic.findFirst).mockResolvedValue(mockEpic as any)
    vi.mocked(prisma.feature.count).mockResolvedValue(2)
    vi.mocked(prisma.feature.create).mockResolvedValue({ ...mockFeature, name: 'New Feature', order: 2 } as any)

    const res = await request(app)
      .post('/api/epics/epic-1/features')
      .set('Authorization', authHeader)
      .send({ name: 'New Feature' })

    expect(res.status).toBe(201)
    expect(prisma.feature.count).toHaveBeenCalledTimes(1)
    expect(res.body.order).toBe(2)
  })
})

describe('count() ordering — stories', () => {
  it('POST story uses prisma.userStory.count for ordering', async () => {
    vi.mocked(prisma.feature.findFirst).mockResolvedValue(mockFeature as any)
    vi.mocked(prisma.userStory.count).mockResolvedValue(5)
    vi.mocked(prisma.userStory.create).mockResolvedValue({ ...mockStory, name: 'New Story', order: 5 } as any)

    const res = await request(app)
      .post('/api/features/feat-1/stories')
      .set('Authorization', authHeader)
      .send({ name: 'New Story' })

    expect(res.status).toBe(201)
    expect(prisma.userStory.count).toHaveBeenCalledTimes(1)
    expect(res.body.order).toBe(5)
  })
})

describe('count() ordering — tasks', () => {
  it('POST task uses prisma.task.count for ordering', async () => {
    const mockTask = { id: 'task-1', userStoryId: 'story-1', name: 'New Task', order: 4 }
    vi.mocked(prisma.userStory.findFirst).mockResolvedValue({
      ...mockStory,
      feature: { epic: { project: { ownerId: userId, hoursPerDay: 7.6 } } },
    } as any)
    vi.mocked(prisma.task.count).mockResolvedValue(4)
    vi.mocked(prisma.task.create).mockResolvedValue(mockTask as any)

    const res = await request(app)
      .post('/api/stories/story-1/tasks')
      .set('Authorization', authHeader)
      .send({ name: 'New Task', resourceTypeId: 'rt-1' })

    expect(res.status).toBe(201)
    expect(prisma.task.count).toHaveBeenCalledTimes(1)
    expect(res.body.order).toBe(4)
  })
})

// ─── 3. round2 utility ───────────────────────────────────────────────────────

describe('round2 utility', () => {
  it('rounds to 2 decimal places', () => {
    expect(round2(1.234)).toBe(1.23)
    expect(round2(1.235)).toBe(1.24)
  })

  it('handles IEEE 754 float imprecision', () => {
    expect(round2(0.1 + 0.2)).toBe(0.3)
  })

  it('handles negatives', () => {
    expect(round2(-1.234)).toBe(-1.23)
  })

  it('calcDurationDays divides hours by hoursPerDay', () => {
    expect(calcDurationDays(7.6, 7.6)).toBe(1)
    expect(calcDurationDays(15.2, 7.6)).toBe(2)
  })
})

// ─── 4. Auth middleware ──────────────────────────────────────────────────────

describe('Auth middleware', () => {
  it('returns 401 with no Authorization header', async () => {
    const res = await request(app).get('/api/projects/proj-1/epics')
    expect(res.status).toBe(401)
  })

  it('returns 401 with invalid token', async () => {
    const res = await request(app)
      .get('/api/projects/proj-1/epics')
      .set('Authorization', 'Bearer invalid-token-here')
    expect(res.status).toBe(401)
  })
})

// ─── 5. asyncHandler utility ─────────────────────────────────────────────────

describe('asyncHandler utility', () => {
  it('passes through successful async handler', async () => {
    const handler = asyncHandler(async (_req, res) => {
      res.json({ ok: true })
    })
    const req = {} as Request
    const res = { json: vi.fn() } as unknown as Response
    const next = vi.fn() as NextFunction

    await handler(req, res, next)

    expect(res.json).toHaveBeenCalledWith({ ok: true })
    expect(next).not.toHaveBeenCalledWith(expect.any(Error))
  })

  it('forwards errors to next on rejection', async () => {
    const err = new Error('boom')
    const handler = asyncHandler(async () => {
      throw err
    })
    const req = {} as Request
    const res = {} as Response
    const next = vi.fn() as NextFunction

    await handler(req, res, next)

    expect(next).toHaveBeenCalledWith(err)
  })
})
