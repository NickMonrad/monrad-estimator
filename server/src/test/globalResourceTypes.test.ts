import { describe, it, expect, vi, beforeEach } from 'vitest'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { app } from '../index.js'
import { prisma } from '../lib/prisma.js'

process.env.JWT_SECRET = 'test-secret'

const userId = 'user-1'
const token = jwt.sign({ userId }, 'test-secret')
const authHeader = `Bearer ${token}`

// Admin token for routes requiring ADMIN role
const adminToken = jwt.sign({ userId, role: 'ADMIN' }, 'test-secret')
const adminHeader = `Bearer ${adminToken}`

const mockGRT = {
  id: 'grt-1',
  name: 'Developer',
  category: 'ENGINEERING' as const,
  description: null,
  defaultHoursPerDay: null,
  defaultDayRate: null,
  isDefault: true,
  createdAt: new Date(),
  updatedAt: new Date(),
}

beforeEach(() => vi.clearAllMocks())

describe('GET /api/global-resource-types', () => {
  it('returns array with auth', async () => {
    vi.mocked(prisma.globalResourceType.findMany).mockResolvedValue([mockGRT])
    const res = await request(app).get('/api/global-resource-types').set('Authorization', authHeader)
    expect(res.status).toBe(200)
    expect(res.body).toHaveLength(1)
    expect(res.body[0].name).toBe('Developer')
  })

  it('returns 401 without auth', async () => {
    const res = await request(app).get('/api/global-resource-types')
    expect(res.status).toBe(401)
  })
})

describe('POST /api/global-resource-types', () => {
  it('creates a global resource type and seeds into existing projects', async () => {
    vi.mocked(prisma.globalResourceType.create).mockResolvedValue(mockGRT)
    vi.mocked(prisma.project.findMany).mockResolvedValue([{ id: 'proj-1' }] as any)
    vi.mocked(prisma.resourceType.createMany).mockResolvedValue({ count: 1 })
    const res = await request(app)
      .post('/api/global-resource-types')
      .set('Authorization', adminHeader)
      .send({ name: 'Developer', category: 'ENGINEERING' })
    expect(res.status).toBe(201)
    expect(res.body.name).toBe('Developer')
    expect(prisma.resourceType.createMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.arrayContaining([expect.objectContaining({ projectId: 'proj-1', globalTypeId: 'grt-1' })]) })
    )
  })

  it('returns 401 without auth', async () => {
    const res = await request(app)
      .post('/api/global-resource-types')
      .send({ name: 'Developer', category: 'ENGINEERING' })
    expect(res.status).toBe(401)
  })

  it('returns 403 for non-admin user', async () => {
    const res = await request(app)
      .post('/api/global-resource-types')
      .set('Authorization', authHeader)
      .send({ name: 'Developer', category: 'ENGINEERING' })
    expect(res.status).toBe(403)
  })

  it('returns 400 when name is missing', async () => {
    const res = await request(app)
      .post('/api/global-resource-types')
      .set('Authorization', adminHeader)
      .send({ category: 'ENGINEERING' })
    expect(res.status).toBe(400)
  })
})

describe('PUT /api/global-resource-types/:id', () => {
  it('returns 401 without auth', async () => {
    const res = await request(app)
      .put('/api/global-resource-types/grt-1')
      .send({ name: 'Dev', category: 'ENGINEERING' })
    expect(res.status).toBe(401)
  })

  it('returns 403 for non-admin user', async () => {
    const res = await request(app)
      .put('/api/global-resource-types/grt-1')
      .set('Authorization', authHeader)
      .send({ name: 'Dev', category: 'ENGINEERING' })
    expect(res.status).toBe(403)
  })

  it('updates global type and syncs to all linked project resource types', async () => {
    const updated = { ...mockGRT, name: 'Senior Developer' }
    vi.mocked(prisma.globalResourceType.findFirst).mockResolvedValue(mockGRT)
    vi.mocked(prisma.globalResourceType.update).mockResolvedValue(updated)
    vi.mocked(prisma.resourceType.updateMany).mockResolvedValue({ count: 2 })
    const res = await request(app)
      .put('/api/global-resource-types/grt-1')
      .set('Authorization', adminHeader)
      .send({ name: 'Senior Developer', category: 'ENGINEERING' })
    expect(res.status).toBe(200)
    expect(res.body.name).toBe('Senior Developer')
    expect(prisma.resourceType.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { globalTypeId: 'grt-1' }, data: { name: 'Senior Developer', category: 'ENGINEERING' } })
    )
  })

  it('returns 400 if name is missing', async () => {
    const res = await request(app)
      .put('/api/global-resource-types/grt-1')
      .set('Authorization', adminHeader)
      .send({ category: 'ENGINEERING' })
    expect(res.status).toBe(400)
  })
})

describe('DELETE /api/global-resource-types/:id', () => {
  it('returns 401 without auth', async () => {
    const res = await request(app)
      .delete('/api/global-resource-types/grt-1')
    expect(res.status).toBe(401)
  })

  it('returns 403 for non-admin user', async () => {
    const res = await request(app)
      .delete('/api/global-resource-types/grt-1')
      .set('Authorization', authHeader)
    expect(res.status).toBe(403)
  })

  it('removes a resource type and returns 204', async () => {
    const nonDefault = { ...mockGRT, id: 'grt-2', isDefault: false }
    vi.mocked(prisma.globalResourceType.findFirst).mockResolvedValue(nonDefault)
    vi.mocked(prisma.task.findFirst).mockResolvedValue(null)
    vi.mocked(prisma.resourceType.updateMany).mockResolvedValue({ count: 0 })
    vi.mocked(prisma.globalResourceType.delete).mockResolvedValue(nonDefault)
    const res = await request(app)
      .delete('/api/global-resource-types/grt-2')
      .set('Authorization', adminHeader)
    expect(res.status).toBe(204)
  })

  it('returns 409 when resource type is in use by tasks', async () => {
    const nonDefault = { ...mockGRT, id: 'grt-2', isDefault: false }
    vi.mocked(prisma.globalResourceType.findFirst).mockResolvedValue(nonDefault)
    vi.mocked(prisma.task.findFirst).mockResolvedValue({ id: 'task-1' } as any)
    const res = await request(app)
      .delete('/api/global-resource-types/grt-2')
      .set('Authorization', adminHeader)
    expect(res.status).toBe(409)
  })

  it('returns 404 for non-existent resource type', async () => {
    vi.mocked(prisma.globalResourceType.findFirst).mockResolvedValue(null)
    const res = await request(app)
      .delete('/api/global-resource-types/nonexistent')
      .set('Authorization', adminHeader)
    expect(res.status).toBe(404)
  })
})
