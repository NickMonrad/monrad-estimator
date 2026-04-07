import { describe, it, expect, vi, beforeEach } from 'vitest'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { app } from '../index.js'
import { prisma } from '../lib/prisma.js'

process.env.JWT_SECRET = 'test-secret'

const userId = 'user-1'
const token = jwt.sign({ userId }, 'test-secret')
const authHeader = `Bearer ${token}`

// Minimal source project returned by findFirst (includes all nested relations the clone route accesses)
const mockSource = {
  id: 'proj-1',
  ownerId: userId,
  name: 'Original Project',
  description: null,
  customerId: null,
  orgId: null,
  status: 'ACTIVE',
  hoursPerDay: 8,
  bufferWeeks: 0,
  startDate: null,
  taxRate: null,
  taxLabel: null,
  resourceTypes: [],
  overheads: [],
  discounts: [],
  epics: [],
}

const mockClonedProject = {
  id: 'proj-clone-1',
  ownerId: userId,
  name: 'Copy of Original Project',
  resourceTypes: [],
  _count: { epics: 0 },
}

beforeEach(() => vi.clearAllMocks())

describe('POST /api/projects/:id/clone', () => {
  it('returns 201 with the cloned project on success', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue(mockSource as any)
    vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) => {
      // Provide a tx object that satisfies what the clone route creates
      const tx = {
        project: { create: vi.fn().mockResolvedValue({ id: 'proj-clone-1', name: 'Copy of Original Project' }), findFirst: vi.fn().mockResolvedValue(mockClonedProject) },
        resourceType: { create: vi.fn() },
        namedResource: { create: vi.fn() },
        projectOverhead: { create: vi.fn() },
        projectDiscount: { create: vi.fn() },
        epic: { create: vi.fn() },
        feature: { create: vi.fn() },
        userStory: { create: vi.fn() },
        task: { create: vi.fn() },
      }
      return fn(tx)
    })

    const res = await request(app)
      .post('/api/projects/proj-1/clone')
      .set('Authorization', authHeader)

    expect(res.status).toBe(201)
    expect(res.body.name).toBe('Copy of Original Project')
  })

  it('returns 404 when the source project does not exist or is not owned', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue(null)

    const res = await request(app)
      .post('/api/projects/nonexistent/clone')
      .set('Authorization', authHeader)

    expect(res.status).toBe(404)
  })

  it('returns 401 without an auth token', async () => {
    const res = await request(app).post('/api/projects/proj-1/clone')
    expect(res.status).toBe(401)
  })

  it('returns 500 and does NOT leave a partial project when the transaction throws', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue(mockSource as any)
    vi.mocked(prisma.$transaction).mockRejectedValue(new Error('DB failure mid-clone'))

    const res = await request(app)
      .post('/api/projects/proj-1/clone')
      .set('Authorization', authHeader)

    expect(res.status).toBe(500)

    // The transaction threw before committing — confirm no project.create was called outside the tx
    expect(vi.mocked(prisma.project.create)).not.toHaveBeenCalled()
  })

  it('passes timeout:30000 to $transaction', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue(mockSource as any)
    vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) => {
      const tx = {
        project: { create: vi.fn().mockResolvedValue({ id: 'proj-clone-1' }), findFirst: vi.fn().mockResolvedValue(mockClonedProject) },
        resourceType: { create: vi.fn() },
        namedResource: { create: vi.fn() },
        projectOverhead: { create: vi.fn() },
        projectDiscount: { create: vi.fn() },
        epic: { create: vi.fn() },
        feature: { create: vi.fn() },
        userStory: { create: vi.fn() },
        task: { create: vi.fn() },
      }
      return fn(tx)
    })

    await request(app)
      .post('/api/projects/proj-1/clone')
      .set('Authorization', authHeader)

    expect(vi.mocked(prisma.$transaction)).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({ timeout: 30000 }),
    )
  })
})
