import { describe, it, expect, vi, beforeEach } from 'vitest'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { app } from '../index.js'
import { prisma } from '../lib/prisma.js'
import { round2, calcDurationDays } from '../utils/round.js'
import { asyncHandler } from '../lib/asyncHandler.js'
import {
  DEFAULT_HOURS_PER_DAY,
  DAYS_PER_WEEK,
  JWT_EXPIRY,
  PASSWORD_RESET_EXPIRY_MS,
  MAX_UPLOAD_SIZE_BYTES,
  ALLOWED_DOC_FORMATS,
  CATEGORY_ORDER,
  VALID_ALLOCATION_MODES,
  VALID_DISCOUNT_TYPES,
  VALID_PRICING_MODELS,
} from '../lib/constants.js'

process.env.JWT_SECRET = 'test-secret'

const userId = 'user-1'
const token = jwt.sign({ userId }, 'test-secret')
const authHeader = `Bearer ${token}`

const mockProject = { id: 'proj-1', ownerId: userId, name: 'Test Project' }

beforeEach(() => vi.clearAllMocks())

// ────────────────────────────────────────────────────────────
// 1. Constants module
// ────────────────────────────────────────────────────────────
describe('Constants module', () => {
  it('exports DEFAULT_HOURS_PER_DAY as 7.6', () => {
    expect(DEFAULT_HOURS_PER_DAY).toBe(7.6)
  })

  it('exports DAYS_PER_WEEK as 5', () => {
    expect(DAYS_PER_WEEK).toBe(5)
  })

  it('exports JWT_EXPIRY as 7d', () => {
    expect(JWT_EXPIRY).toBe('7d')
  })

  it('exports PASSWORD_RESET_EXPIRY_MS as 1 hour in ms', () => {
    expect(PASSWORD_RESET_EXPIRY_MS).toBe(3_600_000)
  })

  it('exports MAX_UPLOAD_SIZE_BYTES as 50 MB', () => {
    expect(MAX_UPLOAD_SIZE_BYTES).toBe(50 * 1024 * 1024)
  })

  it('exports ALLOWED_DOC_FORMATS', () => {
    expect(ALLOWED_DOC_FORMATS).toEqual(['pdf', 'docx', 'pptx'])
  })

  it('exports CATEGORY_ORDER in correct order', () => {
    expect(CATEGORY_ORDER).toEqual(['ENGINEERING', 'GOVERNANCE', 'PROJECT_MANAGEMENT'])
  })

  it('exports VALID_ALLOCATION_MODES', () => {
    expect(VALID_ALLOCATION_MODES).toEqual(['EFFORT', 'TIMELINE', 'FULL_PROJECT'])
  })

  it('exports VALID_DISCOUNT_TYPES', () => {
    expect(VALID_DISCOUNT_TYPES).toEqual(['PERCENTAGE', 'FIXED_AMOUNT'])
  })

  it('exports VALID_PRICING_MODELS', () => {
    expect(VALID_PRICING_MODELS).toEqual(['ACTUAL_DAYS', 'PRO_RATA'])
  })
})

// ────────────────────────────────────────────────────────────
// 2. Shared ownership helpers (regression)
// ────────────────────────────────────────────────────────────
describe('Shared ownership helpers (regression)', () => {
  describe('ownedProject — used by epics, resourceTypes, snapshots, discounts, overhead, reorder, namedResources, featureDependencies, documents', () => {
    it('epics route returns 404 when project not owned', async () => {
      vi.mocked(prisma.project.findFirst).mockResolvedValue(null)
      const res = await request(app)
        .get('/api/projects/unknown-proj/epics')
        .set('Authorization', authHeader)
      expect(res.status).toBe(404)
      expect(res.body.error).toBe('Project not found')
    })

    it('epics route succeeds when project is owned', async () => {
      vi.mocked(prisma.project.findFirst).mockResolvedValue(mockProject as any)
      vi.mocked(prisma.epic.findMany).mockResolvedValue([])
      const res = await request(app)
        .get('/api/projects/proj-1/epics')
        .set('Authorization', authHeader)
      expect(res.status).toBe(200)
    })

    it('resource-types route returns 404 when project not owned', async () => {
      vi.mocked(prisma.project.findFirst).mockResolvedValue(null)
      const res = await request(app)
        .get('/api/projects/unknown-proj/resource-types')
        .set('Authorization', authHeader)
      expect(res.status).toBe(404)
      expect(res.body.error).toBe('Project not found')
    })

    it('snapshots route returns 404 when project not owned', async () => {
      vi.mocked(prisma.project.findFirst).mockResolvedValue(null)
      const res = await request(app)
        .get('/api/projects/unknown-proj/snapshots')
        .set('Authorization', authHeader)
      expect(res.status).toBe(404)
      expect(res.body.error).toBe('Project not found')
    })

    it('discounts route returns 404 when project not owned', async () => {
      vi.mocked(prisma.project.findFirst).mockResolvedValue(null)
      const res = await request(app)
        .get('/api/projects/unknown-proj/discounts')
        .set('Authorization', authHeader)
      expect(res.status).toBe(404)
      expect(res.body.error).toBe('Project not found')
    })

    it('overhead route returns 404 when project not owned', async () => {
      vi.mocked(prisma.project.findFirst).mockResolvedValue(null)
      const res = await request(app)
        .get('/api/projects/unknown-proj/overhead')
        .set('Authorization', authHeader)
      expect(res.status).toBe(404)
      expect(res.body.error).toBe('Project not found')
    })
  })

  describe('ownedEpic — used by features route', () => {
    it('features route returns 404 when epic not owned', async () => {
      vi.mocked(prisma.epic.findFirst).mockResolvedValue(null)
      const res = await request(app)
        .get('/api/epics/unknown-epic/features')
        .set('Authorization', authHeader)
      expect(res.status).toBe(404)
      expect(res.body.error).toBe('Epic not found')
    })

    it('features route succeeds when epic is owned', async () => {
      vi.mocked(prisma.epic.findFirst).mockResolvedValue({ id: 'epic-1' } as any)
      vi.mocked(prisma.feature.findMany).mockResolvedValue([])
      const res = await request(app)
        .get('/api/epics/epic-1/features')
        .set('Authorization', authHeader)
      expect(res.status).toBe(200)
    })
  })

  describe('ownedFeature — used by stories route', () => {
    it('stories route returns 404 when feature not owned', async () => {
      vi.mocked(prisma.feature.findFirst).mockResolvedValue(null)
      const res = await request(app)
        .get('/api/features/unknown-feat/stories')
        .set('Authorization', authHeader)
      expect(res.status).toBe(404)
      expect(res.body.error).toBe('Feature not found')
    })

    it('stories route succeeds when feature is owned', async () => {
      vi.mocked(prisma.feature.findFirst).mockResolvedValue({ id: 'feat-1' } as any)
      vi.mocked(prisma.userStory.findMany).mockResolvedValue([])
      const res = await request(app)
        .get('/api/features/feat-1/stories')
        .set('Authorization', authHeader)
      expect(res.status).toBe(200)
    })
  })
})

// ────────────────────────────────────────────────────────────
// 3. count() usage for ordering (regression)
// ────────────────────────────────────────────────────────────
describe('count() usage for ordering (regression)', () => {
  it('epic creation uses count for order value', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue(mockProject as any)
    vi.mocked(prisma.epic.count).mockResolvedValue(3)
    vi.mocked(prisma.epic.create).mockResolvedValue({
      id: 'new-epic', projectId: 'proj-1', name: 'New Epic', order: 3,
    } as any)

    const res = await request(app)
      .post('/api/projects/proj-1/epics')
      .set('Authorization', authHeader)
      .send({ name: 'New Epic' })

    expect(res.status).toBe(201)
    expect(prisma.epic.count).toHaveBeenCalledWith({ where: { projectId: 'proj-1' } })
    expect(prisma.epic.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ order: 3 }) })
    )
  })

  it('feature creation uses count for order value', async () => {
    vi.mocked(prisma.epic.findFirst).mockResolvedValue({ id: 'epic-1' } as any)
    vi.mocked(prisma.feature.count).mockResolvedValue(2)
    vi.mocked(prisma.feature.create).mockResolvedValue({
      id: 'new-feat', epicId: 'epic-1', name: 'New Feature', order: 2,
    } as any)

    const res = await request(app)
      .post('/api/epics/epic-1/features')
      .set('Authorization', authHeader)
      .send({ name: 'New Feature' })

    expect(res.status).toBe(201)
    expect(prisma.feature.count).toHaveBeenCalledWith({ where: { epicId: 'epic-1' } })
    expect(prisma.feature.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ order: 2 }) })
    )
  })

  it('story creation uses count for order value', async () => {
    vi.mocked(prisma.feature.findFirst).mockResolvedValue({ id: 'feat-1' } as any)
    vi.mocked(prisma.userStory.count).mockResolvedValue(5)
    vi.mocked(prisma.userStory.create).mockResolvedValue({
      id: 'new-story', featureId: 'feat-1', name: 'New Story', order: 5,
    } as any)

    const res = await request(app)
      .post('/api/features/feat-1/stories')
      .set('Authorization', authHeader)
      .send({ name: 'New Story' })

    expect(res.status).toBe(201)
    expect(prisma.userStory.count).toHaveBeenCalledWith({ where: { featureId: 'feat-1' } })
    expect(prisma.userStory.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ order: 5 }) })
    )
  })
})

// ────────────────────────────────────────────────────────────
// 4. round2 utility (regression)
// ────────────────────────────────────────────────────────────
describe('round2 utility (regression)', () => {
  it('rounds to 2 decimal places', () => {
    expect(round2(10 / 3)).toBe(3.33)
    expect(round2(2 / 3)).toBe(0.67)
  })

  it('handles whole numbers', () => {
    expect(round2(5)).toBe(5)
    expect(round2(0)).toBe(0)
  })

  it('handles negative numbers', () => {
    expect(round2(-10 / 3)).toBe(-3.33)
  })

  it('calcDurationDays uses round2 internally', () => {
    expect(calcDurationDays(16, 8)).toBe(2)
    expect(calcDurationDays(10, DEFAULT_HOURS_PER_DAY)).toBe(1.32)
    expect(calcDurationDays(1, 3)).toBe(0.33)
  })
})

// ────────────────────────────────────────────────────────────
// 5. Auth middleware return statement (regression)
// ────────────────────────────────────────────────────────────
describe('Auth middleware return statement (regression)', () => {
  it('returns 401 for invalid token', async () => {
    const res = await request(app)
      .get('/api/projects/proj-1/epics')
      .set('Authorization', 'Bearer bad-token')
    expect(res.status).toBe(401)
    expect(res.body.error).toBe('Invalid token')
  })

  it('returns 401 when no auth header provided', async () => {
    const res = await request(app).get('/api/projects/proj-1/epics')
    expect(res.status).toBe(401)
    expect(res.body.error).toBe('Unauthorized')
  })
})

// ────────────────────────────────────────────────────────────
// 6. asyncHandler utility (regression)
// ────────────────────────────────────────────────────────────
describe('asyncHandler utility (regression)', () => {
  it('calls the wrapped async function normally on success', async () => {
    const handler = vi.fn(async (_req: any, res: any) => { res.status(200).json({ ok: true }) })
    const wrapped = asyncHandler(handler)
    const req = {} as any
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() } as any
    const next = vi.fn()

    await wrapped(req, res, next)

    expect(handler).toHaveBeenCalledWith(req, res, next)
    expect(next).not.toHaveBeenCalled()
  })

  it('forwards rejected promises to next()', async () => {
    const error = new Error('async boom')
    const handler = vi.fn(async () => { throw error })
    const wrapped = asyncHandler(handler)
    const req = {} as any
    const res = {} as any
    const next = vi.fn()

    wrapped(req, res, next)
    // The wrapper uses fire-and-forget Promise.catch(next); allow microtask to settle
    await new Promise(resolve => setImmediate(resolve))

    expect(next).toHaveBeenCalledWith(error)
  })
})

// ────────────────────────────────────────────────────────────
// 7. Global error handler (regression)
// ────────────────────────────────────────────────────────────
describe('Global error handler (regression)', () => {
  it('returns 500 for unhandled errors that bubble up', async () => {
    // Force a route to throw by mocking findFirst to reject
    vi.mocked(prisma.project.findFirst).mockRejectedValue(new Error('DB connection lost'))
    const res = await request(app)
      .get('/api/projects/proj-1/effort')
      .set('Authorization', authHeader)
    expect(res.status).toBe(500)
    expect(res.body.error).toBe('Internal server error')
  })
})
