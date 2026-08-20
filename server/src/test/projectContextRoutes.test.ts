import { beforeEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { app } from '../index.js'
import { prisma } from '../lib/prisma.js'

process.env.JWT_SECRET = 'test-secret'

const userId = 'user-1'
const authHeader = `Bearer ${jwt.sign({ userId }, 'test-secret')}`
const project = { id: 'project-1', ownerId: userId, name: 'Project' }

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(prisma.project.findFirst).mockResolvedValue(project as any)
})

describe('project dependencies', () => {
  it('lists dependencies in persisted order', async () => {
    const dependencies = [
      { id: 'dependency-1', projectId: project.id, description: 'First', order: 0 },
      { id: 'dependency-2', projectId: project.id, description: 'Second', order: 1 },
    ]
    vi.mocked(prisma.projectDependency.findMany).mockResolvedValue(dependencies as any)

    const res = await request(app).get(`/api/projects/${project.id}/dependencies`).set('Authorization', authHeader)

    expect(res.status).toBe(200)
    expect(res.body).toEqual(dependencies)
    expect(prisma.projectDependency.findMany).toHaveBeenCalledWith({
      where: { projectId: project.id },
      orderBy: [{ order: 'asc' }, { id: 'asc' }],
    })
  })

  it('does not expose dependencies for a project the user does not own', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue(null)

    const res = await request(app)
      .get('/api/projects/foreign-project/dependencies')
      .set('Authorization', authHeader)

    expect(res.status).toBe(404)
    expect(prisma.projectDependency.findMany).not.toHaveBeenCalled()
  })

  it('creates and reorders dependencies', async () => {
    vi.mocked(prisma.projectDependency.findFirst).mockResolvedValue({ order: 0 } as any)
    vi.mocked(prisma.projectDependency.create).mockResolvedValue({ id: 'dependency-2', projectId: project.id, description: '<p>Second</p>', order: 1 } as any)
    vi.mocked(prisma.projectDependency.findMany)
      .mockResolvedValueOnce([{ id: 'dependency-1' }, { id: 'dependency-2' }] as any)
      .mockResolvedValueOnce([{ id: 'dependency-2', order: 0 }, { id: 'dependency-1', order: 1 }] as any)

    const created = await request(app)
      .post(`/api/projects/${project.id}/dependencies`)
      .set('Authorization', authHeader)
      .send({ description: '<p>Second</p>' })
    const reordered = await request(app)
      .patch(`/api/projects/${project.id}/dependencies/reorder`)
      .set('Authorization', authHeader)
      .send({ items: [{ id: 'dependency-2', order: 0 }, { id: 'dependency-1', order: 1 }] })

    expect(created.status).toBe(201)
    expect(reordered.status).toBe(200)
    expect(prisma.projectDependency.update).toHaveBeenCalledWith({ where: { id: 'dependency-2' }, data: { order: 0 } })
  })
  it('updates and deletes dependencies and rejects invalid or cross-project mutations', async () => {
    vi.mocked(prisma.projectDependency.findFirst).mockResolvedValue({ id: 'dependency-1', projectId: project.id } as any)
    vi.mocked(prisma.projectDependency.update).mockResolvedValue({ id: 'dependency-1', projectId: project.id, description: 'Updated', order: 0 } as any)

    const updated = await request(app)
      .put(`/api/projects/${project.id}/dependencies/dependency-1`)
      .set('Authorization', authHeader)
      .send({ description: 'Updated' })
    const deleted = await request(app)
      .delete(`/api/projects/${project.id}/dependencies/dependency-1`)
      .set('Authorization', authHeader)
    const invalidReorder = await request(app)
      .patch(`/api/projects/${project.id}/dependencies/reorder`)
      .set('Authorization', authHeader)
      .send({ items: [{ id: 'dependency-1', order: -1 }] })
    vi.mocked(prisma.project.findFirst).mockResolvedValue(null)
    const foreign = await request(app)
      .delete('/api/projects/foreign-project/dependencies/dependency-1')
      .set('Authorization', authHeader)

    expect(updated.status).toBe(200)
    expect(deleted.status).toBe(204)
    expect(invalidReorder.status).toBe(400)
    expect(foreign.status).toBe(404)
  })
})

describe('project risks', () => {
  it('rejects an empty risk and preserves mitigation on update', async () => {
    const invalid = await request(app)
      .post(`/api/projects/${project.id}/risks`)
      .set('Authorization', authHeader)
      .send({ description: '<p></p>' })
    vi.mocked(prisma.projectRisk.findFirst).mockResolvedValue({ id: 'risk-1', projectId: project.id } as any)
    vi.mocked(prisma.projectRisk.update).mockResolvedValue({ id: 'risk-1', projectId: project.id, description: '<p>Risk</p>', mitigation: '<p>Response</p>', order: 0 } as any)
    const updated = await request(app)
      .put(`/api/projects/${project.id}/risks/risk-1`)
      .set('Authorization', authHeader)
      .send({ description: '<p>Risk</p>', mitigation: '<p>Response</p>' })

    expect(invalid.status).toBe(400)
    expect(updated.status).toBe(200)
    expect(prisma.projectRisk.update).toHaveBeenCalledWith({
      where: { id: 'risk-1' },
      data: { description: '<p>Risk</p>', mitigation: '<p>Response</p>' },
    })
  })
  it('lists risks in deterministic order and hides foreign projects', async () => {
    const risks = [
      { id: 'risk-1', projectId: project.id, description: 'First', mitigation: null, order: 0 },
      { id: 'risk-2', projectId: project.id, description: 'Second', mitigation: 'Response', order: 1 },
    ]
    vi.mocked(prisma.projectRisk.findMany).mockResolvedValue(risks as any)

    const listed = await request(app).get(`/api/projects/${project.id}/risks`).set('Authorization', authHeader)
    vi.mocked(prisma.project.findFirst).mockResolvedValue(null)
    const foreign = await request(app).get('/api/projects/foreign-project/risks').set('Authorization', authHeader)

    expect(listed.status).toBe(200)
    expect(listed.body).toEqual(risks)
    expect(prisma.projectRisk.findMany).toHaveBeenCalledWith({
      where: { projectId: project.id },
      orderBy: [{ order: 'asc' }, { id: 'asc' }],
    })
    expect(foreign.status).toBe(404)
  })

  it('creates risks with mitigation, reorders, deletes and rejects invalid access', async () => {
    vi.mocked(prisma.projectRisk.findFirst).mockResolvedValue({ id: 'risk-1', projectId: project.id, order: 0 } as any)
    vi.mocked(prisma.projectRisk.create).mockResolvedValue({ id: 'risk-2', projectId: project.id, description: 'Second', mitigation: 'Response', order: 1 } as any)
    vi.mocked(prisma.projectRisk.findMany)
      .mockResolvedValueOnce([{ id: 'risk-1' }, { id: 'risk-2' }] as any)
      .mockResolvedValueOnce([{ id: 'risk-2', order: 0 }, { id: 'risk-1', order: 1 }] as any)
    vi.mocked(prisma.projectRisk.delete).mockResolvedValue({ id: 'risk-2' } as any)

    const created = await request(app)
      .post(`/api/projects/${project.id}/risks`)
      .set('Authorization', authHeader)
      .send({ description: 'Second', mitigation: 'Response' })
    const reordered = await request(app)
      .patch(`/api/projects/${project.id}/risks/reorder`)
      .set('Authorization', authHeader)
      .send({ items: [{ id: 'risk-2', order: 0 }, { id: 'risk-1', order: 1 }] })
    vi.mocked(prisma.projectRisk.findFirst).mockResolvedValue({ id: 'risk-2', projectId: project.id } as any)
    const deleted = await request(app)
      .delete(`/api/projects/${project.id}/risks/risk-2`)
      .set('Authorization', authHeader)
    vi.mocked(prisma.projectRisk.findFirst).mockResolvedValue(null)
    const invalid = await request(app)
      .put(`/api/projects/${project.id}/risks/missing-risk`)
      .set('Authorization', authHeader)
      .send({ description: 'Updated' })

    expect(created.status).toBe(201)
    expect(reordered.status).toBe(200)
    expect(deleted.status).toBe(204)
    expect(invalid.status).toBe(404)
    expect(prisma.projectRisk.update).toHaveBeenCalledWith({ where: { id: 'risk-2' }, data: { order: 0 } })
  })
 })
