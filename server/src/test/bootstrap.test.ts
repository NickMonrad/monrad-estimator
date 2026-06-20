import { describe, it, expect, vi, beforeEach } from 'vitest'
import request from 'supertest'
import { app } from '../index.js'
import { prisma } from '../lib/prisma.js'

process.env.JWT_SECRET = 'test-secret'

const mockAdminUser = {
  id: 'admin-1',
  email: 'admin@example.com',
  name: 'Admin User',
  password: 'hashed-password',
  role: 'ADMIN' as const,
  createdAt: new Date(),
  updatedAt: new Date(),
}

beforeEach(() => {
  vi.clearAllMocks()
  // Default: no admin exists → bootstrap is available
  vi.mocked(prisma.user.count).mockResolvedValue(0)
  // Default: email not taken
  vi.mocked(prisma.user.findUnique).mockResolvedValue(null)
  // Default: create returns admin user
  vi.mocked(prisma.user.create).mockResolvedValue(mockAdminUser)
})

describe('POST /api/bootstrap/admin', () => {
  it('creates the first admin on a fresh DB (201)', async () => {
    const res = await request(app)
      .post('/api/bootstrap/admin')
      .send({ name: 'Admin User', email: 'admin@example.com', password: 'securePassword123!' })

    expect(res.status).toBe(201)
    expect(res.body).toHaveProperty('token')
    expect(res.body).toHaveProperty('user')
    expect(res.body.user).toMatchObject({
      email: 'admin@example.com',
      name: 'Admin User',
      role: 'ADMIN',
    })
  })

  it('stores the user with role ADMIN', async () => {
    await request(app)
      .post('/api/bootstrap/admin')
      .send({ name: 'Admin User', email: 'admin@example.com', password: 'securePassword123!' })

    expect(prisma.user.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          email: 'admin@example.com',
          name: 'Admin User',
          role: 'ADMIN',
        }),
      }),
    )
  })

  it('returns 409 when an admin already exists', async () => {
    vi.mocked(prisma.user.count).mockResolvedValueOnce(1)

    const res = await request(app)
      .post('/api/bootstrap/admin')
      .send({ name: 'Another Admin', email: 'admin2@example.com', password: 'securePassword123!' })

    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/admin already exists/i)
    expect(prisma.user.create).not.toHaveBeenCalled()
  })

  it('returns 409 when the email is already taken by a regular user', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({
      id: 'user-1',
      email: 'admin@example.com',
      role: 'USER',
    } as any)

    const res = await request(app)
      .post('/api/bootstrap/admin')
      .send({ name: 'Admin User', email: 'admin@example.com', password: 'securePassword123!' })

    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/email already exists/i)
    expect(prisma.user.create).not.toHaveBeenCalled()
  })

  it('returns 400 when password is too short', async () => {
    const res = await request(app)
      .post('/api/bootstrap/admin')
      .send({ name: 'Admin', email: 'admin@example.com', password: 'short' })

    expect(res.status).toBe(400)
  })

  it('returns 400 when name is missing', async () => {
    const res = await request(app)
      .post('/api/bootstrap/admin')
      .send({ email: 'admin@example.com', password: 'securePassword123!' })

    expect(res.status).toBe(400)
  })

  it('returns 400 when email is invalid', async () => {
    const res = await request(app)
      .post('/api/bootstrap/admin')
      .send({ name: 'Admin', email: 'not-an-email', password: 'securePassword123!' })

    expect(res.status).toBe(400)
  })
})
