import { describe, it, expect, vi, beforeEach } from 'vitest'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { app } from '../index.js'
import { prisma } from '../lib/prisma.js'

process.env.JWT_SECRET = 'test-secret'

const userId = 'user-1'
const token = jwt.sign({ userId }, 'test-secret')
const authHeader = `Bearer ${token}`

const mockGRT = { id: 'grt-1', name: 'Developer', category: 'ENGINEERING' as const, description: null, isDefault: true, createdAt: new Date(), updatedAt: new Date() }

beforeEach(() => vi.clearAllMocks())

describe('GET /api/global-resource-types', () => {
  it('returns array without auth', async () => {
    vi.mocked(prisma.globalResourceType.findMany).mockResolvedValue([mockGRT])
    const res = await request(app).get('/api/global-resource-types')
    expect(res.status).toBe(200)
    expect(res.body).toHaveLength(1)
    expect(res.body[0].name).toBe('Developer')
  })
})

describe('POST /api/global-resource-types', () => {
  it('creates a global resource type when authenticated', async () => {
    vi.mocked(prisma.globalResourceType.create).mockResolvedValue(mockGRT)
    const res = await request(app)
      .post('/api/global-resource-types')
      .set('Authorization', authHeader)
      .send({ name: 'Developer', category: 'ENGINEERING' })
    expect(res.status).toBe(201)
    expect(res.body.name).toBe('Developer')
  })

  it('returns 401 without auth', async () => {
    const res = await request(app)
      .post('/api/global-resource-types')
      .send({ name: 'Developer', category: 'ENGINEERING' })
    expect(res.status).toBe(401)
  })

  it('returns 400 when name is missing', async () => {
    const res = await request(app)
      .post('/api/global-resource-types')
      .set('Authorization', authHeader)
      .send({ category: 'ENGINEERING' })
    expect(res.status).toBe(400)
  })
})
