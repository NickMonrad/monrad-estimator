import { describe, it, expect, vi, beforeEach } from 'vitest'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { app } from '../index.js'
import { prisma } from '../lib/prisma.js'

process.env.JWT_SECRET = 'test-secret'

const userId = 'user-1'
const token = jwt.sign({ userId }, 'test-secret')
const authHeader = `Bearer ${token}`

const mockProject = { id: 'proj-1', ownerId: userId, name: 'Test Project' }
const mockEpic = { id: 'epic-1', projectId: 'proj-1', name: 'Epic 1', order: 0 }

beforeEach(() => vi.clearAllMocks())

describe('GET /api/projects/:projectId/epics', () => {
  it('returns epics for owned project', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue(mockProject as any)
    vi.mocked(prisma.epic.findMany).mockResolvedValue([mockEpic] as any)

    const res = await request(app)
      .get('/api/projects/proj-1/epics')
      .set('Authorization', authHeader)

    expect(res.status).toBe(200)
    expect(res.body).toHaveLength(1)
    expect(res.body[0].name).toBe('Epic 1')
  })

  it('returns 404 for unowned project', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue(null)

    const res = await request(app)
      .get('/api/projects/other-proj/epics')
      .set('Authorization', authHeader)

    expect(res.status).toBe(404)
  })

  it('returns 401 without token', async () => {
    const res = await request(app).get('/api/projects/proj-1/epics')
    expect(res.status).toBe(401)
  })
})

describe('POST /api/projects/:projectId/epics', () => {
  it('creates an epic', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue(mockProject as any)
    vi.mocked(prisma.epic.findMany).mockResolvedValue([])
    vi.mocked(prisma.epic.create).mockResolvedValue({ ...mockEpic, name: 'New Epic' } as any)

    const res = await request(app)
      .post('/api/projects/proj-1/epics')
      .set('Authorization', authHeader)
      .send({ name: 'New Epic' })

    expect(res.status).toBe(201)
    expect(res.body.name).toBe('New Epic')
  })

  it('returns 400 when name is missing', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue(mockProject as any)

    const res = await request(app)
      .post('/api/projects/proj-1/epics')
      .set('Authorization', authHeader)
      .send({})

    expect(res.status).toBe(400)
  })
})

describe('DELETE /api/projects/:projectId/epics/:id', () => {
  it('deletes an epic', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue(mockProject as any)
    vi.mocked(prisma.epic.delete).mockResolvedValue(mockEpic as any)

    const res = await request(app)
      .delete('/api/projects/proj-1/epics/epic-1')
      .set('Authorization', authHeader)

    expect(res.status).toBe(200)
    expect(res.body.message).toBe('Deleted')
  })
})
