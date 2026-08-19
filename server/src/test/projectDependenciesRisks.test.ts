import { beforeEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { app } from '../app.js'
import { prisma } from '../lib/prisma.js'

process.env.JWT_SECRET = 'test-secret'

const userId = 'user-1'
const projectId = 'project-1'
const authHeader = `Bearer ${jwt.sign({ userId }, 'test-secret')}`
const project = { id: projectId, ownerId: userId } as unknown as Awaited<ReturnType<typeof prisma.project.findFirst>>

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(prisma.project.findFirst).mockResolvedValue(project)
})

describe('project dependencies', () => {
  it('creates, lists, updates and deletes dependencies', async () => {
    vi.mocked(prisma.projectDependency.count).mockResolvedValue(0)
    vi.mocked(prisma.projectDependency.create).mockResolvedValue({ id: 'dependency-1', projectId, description: 'API access', order: 0 } as unknown as Awaited<ReturnType<typeof prisma.projectDependency.create>>)
    vi.mocked(prisma.projectDependency.findMany).mockResolvedValue([{ id: 'dependency-1', projectId, description: 'API access', order: 0 }] as unknown as Awaited<ReturnType<typeof prisma.projectDependency.findMany>>)
    vi.mocked(prisma.projectDependency.findFirst).mockResolvedValue({ id: 'dependency-1', projectId, description: 'API access', order: 0 } as unknown as Awaited<ReturnType<typeof prisma.projectDependency.findFirst>>)
    vi.mocked(prisma.projectDependency.update).mockResolvedValue({ id: 'dependency-1', projectId, description: 'Updated API access', order: 0 } as unknown as Awaited<ReturnType<typeof prisma.projectDependency.update>>)

    const created = await request(app)
      .post(`/api/projects/${projectId}/dependencies`)
      .set('Authorization', authHeader)
      .send({ description: 'API access' })
    expect(created.status).toBe(201)
    expect(prisma.projectDependency.create).toHaveBeenCalledWith({ data: { projectId, description: 'API access', order: 0 } })

    const listed = await request(app).get(`/api/projects/${projectId}/dependencies`).set('Authorization', authHeader)
    expect(listed.status).toBe(200)
    expect(listed.body).toHaveLength(1)

    const updated = await request(app)
      .put(`/api/projects/${projectId}/dependencies/dependency-1`)
      .set('Authorization', authHeader)
      .send({ description: 'Updated API access' })
    expect(updated.status).toBe(200)
    expect(prisma.projectDependency.update).toHaveBeenCalledWith({ where: { id: 'dependency-1' }, data: { description: 'Updated API access' } })

    const deleted = await request(app).delete(`/api/projects/${projectId}/dependencies/dependency-1`).set('Authorization', authHeader)
    expect(deleted.status).toBe(200)
    expect(prisma.projectDependency.delete).toHaveBeenCalledWith({ where: { id: 'dependency-1' } })
  })

  it('reorders every dependency atomically and rejects incomplete payloads', async () => {
    vi.mocked(prisma.projectDependency.findMany).mockResolvedValue([{ id: 'dependency-1' }, { id: 'dependency-2' }] as unknown as Awaited<ReturnType<typeof prisma.projectDependency.findMany>>)

    const reordered = await request(app)
      .patch(`/api/projects/${projectId}/dependencies/reorder`)
      .set('Authorization', authHeader)
      .send({ items: [{ id: 'dependency-2', order: 0 }, { id: 'dependency-1', order: 1 }] })
    expect(reordered.status).toBe(200)
    expect(prisma.$transaction).toHaveBeenCalled()

    vi.mocked(prisma.projectDependency.update).mockClear()
    const invalid = await request(app)
      .patch(`/api/projects/${projectId}/dependencies/reorder`)
      .set('Authorization', authHeader)
      .send({ items: [{ id: 'dependency-1', order: 0 }] })
    expect(invalid.status).toBe(400)
    expect(prisma.projectDependency.update).not.toHaveBeenCalled()
  })

  it('rejects access to a foreign project', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue(null)
    const response = await request(app).get(`/api/projects/${projectId}/dependencies`).set('Authorization', authHeader)
    expect(response.status).toBe(404)
    expect(prisma.projectDependency.findMany).not.toHaveBeenCalled()
  })
})

describe('project risks', () => {
  it('creates, lists, updates mitigation and deletes risks', async () => {
    vi.mocked(prisma.projectRisk.count).mockResolvedValue(0)
    vi.mocked(prisma.projectRisk.create).mockResolvedValue({ id: 'risk-1', projectId, description: 'Vendor delay', mitigation: 'Weekly escalation', order: 0 } as unknown as Awaited<ReturnType<typeof prisma.projectRisk.create>>)
    vi.mocked(prisma.projectRisk.findMany).mockResolvedValue([{ id: 'risk-1', projectId, description: 'Vendor delay', mitigation: 'Weekly escalation', order: 0 }] as unknown as Awaited<ReturnType<typeof prisma.projectRisk.findMany>>)
    vi.mocked(prisma.projectRisk.findFirst).mockResolvedValue({ id: 'risk-1', projectId, description: 'Vendor delay', mitigation: null, order: 0 } as unknown as Awaited<ReturnType<typeof prisma.projectRisk.findFirst>>)
    vi.mocked(prisma.projectRisk.update).mockResolvedValue({ id: 'risk-1', projectId, description: 'Vendor delay', mitigation: 'Weekly escalation', order: 0 } as unknown as Awaited<ReturnType<typeof prisma.projectRisk.update>>)

    const created = await request(app)
      .post(`/api/projects/${projectId}/risks`)
      .set('Authorization', authHeader)
      .send({ description: 'Vendor delay', mitigation: 'Weekly escalation' })
    expect(created.status).toBe(201)
    expect(prisma.projectRisk.create).toHaveBeenCalledWith({ data: { projectId, description: 'Vendor delay', mitigation: 'Weekly escalation', order: 0 } })

    const listed = await request(app).get(`/api/projects/${projectId}/risks`).set('Authorization', authHeader)
    expect(listed.status).toBe(200)
    expect(listed.body).toHaveLength(1)

    const updated = await request(app)
      .put(`/api/projects/${projectId}/risks/risk-1`)
      .set('Authorization', authHeader)
      .send({ description: 'Vendor delay', mitigation: 'Updated response' })
    expect(updated.status).toBe(200)
    expect(prisma.projectRisk.update).toHaveBeenCalledWith({ where: { id: 'risk-1' }, data: { description: 'Vendor delay', mitigation: 'Updated response' } })

    const deleted = await request(app).delete(`/api/projects/${projectId}/risks/risk-1`).set('Authorization', authHeader)
    expect(deleted.status).toBe(200)
    expect(prisma.projectRisk.delete).toHaveBeenCalledWith({ where: { id: 'risk-1' } })
  })

  it('reorders risks and rejects invalid orders without writing', async () => {
    vi.mocked(prisma.projectRisk.findMany).mockResolvedValue([{ id: 'risk-1' }, { id: 'risk-2' }] as unknown as Awaited<ReturnType<typeof prisma.projectRisk.findMany>>)
    const reordered = await request(app)
      .patch(`/api/projects/${projectId}/risks/reorder`)
      .set('Authorization', authHeader)
      .send({ items: [{ id: 'risk-2', order: 0 }, { id: 'risk-1', order: 1 }] })
    expect(reordered.status).toBe(200)

    vi.mocked(prisma.projectRisk.update).mockClear()
    const invalid = await request(app)
      .patch(`/api/projects/${projectId}/risks/reorder`)
      .set('Authorization', authHeader)
      .send({ items: [{ id: 'risk-1', order: -1 }, { id: 'risk-2', order: 0 }] })
    expect(invalid.status).toBe(400)
    expect(prisma.projectRisk.update).not.toHaveBeenCalled()
  })

  it('rejects foreign risk IDs', async () => {
    vi.mocked(prisma.projectRisk.findFirst).mockResolvedValue(null)
    const response = await request(app)
      .put(`/api/projects/${projectId}/risks/foreign-risk`)
      .set('Authorization', authHeader)
      .send({ description: 'No access' })
    expect(response.status).toBe(404)
    expect(prisma.projectRisk.update).not.toHaveBeenCalled()
  })
})
