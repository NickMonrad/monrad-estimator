import { describe, it, expect, vi, beforeEach } from 'vitest'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { app } from '../index.js'
import { prisma } from '../lib/prisma.js'

process.env.JWT_SECRET = 'test-secret'

const userId = 'user-1'
const token = jwt.sign({ userId }, 'test-secret')
const authHeader = `Bearer ${token}`

const mockProject = {
  id: 'proj-1', name: 'Test Project', description: null, customer: null,
  status: 'DRAFT', hoursPerDay: 7.6, ownerId: userId, createdAt: new Date(), updatedAt: new Date(),
}

beforeEach(() => vi.clearAllMocks())

describe('PUT /api/projects/:id', () => {
  it('updates project name and hoursPerDay', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue(mockProject as any)
    vi.mocked(prisma.project.update).mockResolvedValue({ ...mockProject, name: 'Updated', hoursPerDay: 8 } as any)

    const res = await request(app)
      .put('/api/projects/proj-1')
      .set('Authorization', authHeader)
      .send({ name: 'Updated', hoursPerDay: 8 })

    expect(res.status).toBe(200)
    expect(res.body.name).toBe('Updated')
    expect(res.body.hoursPerDay).toBe(8)
  })

  it('updates project status', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue(mockProject as any)
    vi.mocked(prisma.project.update).mockResolvedValue({ ...mockProject, status: 'ACTIVE' } as any)

    const res = await request(app)
      .put('/api/projects/proj-1')
      .set('Authorization', authHeader)
      .send({ status: 'ACTIVE' })

    expect(res.status).toBe(200)
    expect(res.body.status).toBe('ACTIVE')
  })

  it('returns 404 for non-owned project', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue(null)

    const res = await request(app)
      .put('/api/projects/proj-1')
      .set('Authorization', authHeader)
      .send({ name: 'X' })

    expect(res.status).toBe(404)
  })
})
