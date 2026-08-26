import { beforeEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import jwt from 'jsonwebtoken'

import { app } from '../index.js'
import { prisma } from '../lib/prisma.js'

process.env.JWT_SECRET = 'test-secret'
const userId = 'grid-user'
const projectId = 'grid-project'
const authHeader = `Bearer ${jwt.sign({ userId }, 'test-secret')}`
const project = { id: projectId, ownerId: userId, hoursPerDay: 8, name: 'Grid project' }

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(prisma.project.findFirst).mockResolvedValue(project as never)
  vi.mocked(prisma.project.findUnique).mockResolvedValue({ hoursPerDay: 8 } as never)
  vi.mocked(prisma.epic.findMany).mockResolvedValue([] as never)
  vi.mocked(prisma.resourceType.findMany).mockResolvedValue([{ id: 'rt-dev', name: 'Developer' }] as never)
})

describe('POST /api/projects/:projectId/backlog/grid-commit', () => {
  it('requires project ownership', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue(null)
    const response = await request(app)
      .post(`/api/projects/${projectId}/backlog/grid-commit`)
      .set('Authorization', authHeader)
      .send({ rows: [{ type: 'epic', name: 'Hidden' }] })

    expect(response.status).toBe(404)
    expect(response.body.error).toBe('Project not found')
  })

  it('rejects an unresolved resource type before opening a transaction', async () => {
    const response = await request(app)
      .post(`/api/projects/${projectId}/backlog/grid-commit`)
      .set('Authorization', authHeader)
      .send({ rows: [{ type: 'task', epicName: 'E', featureName: 'F', storyName: 'S', name: 'T', resourceTypeName: 'Typo', hoursEffort: 4 }] })

    expect(response.status).toBe(400)
    expect(response.body.fieldErrors).toEqual(expect.arrayContaining([expect.objectContaining({ field: 'resourceType', message: expect.stringContaining('resolve') })]))
    expect(prisma.$transaction).not.toHaveBeenCalled()
  })

  it('creates an epic, feature, story and task in one explicit commit', async () => {
    vi.mocked(prisma.$transaction).mockImplementationOnce(async callback => callback({
      epic: { create: vi.fn().mockResolvedValue({ id: 'epic-id' }), update: vi.fn() },
      feature: { create: vi.fn().mockResolvedValue({ id: 'feature-id' }), update: vi.fn() },
      userStory: { create: vi.fn().mockResolvedValue({ id: 'story-id' }), update: vi.fn() },
      task: { create: vi.fn().mockResolvedValue({ id: 'task-id' }), update: vi.fn() },
      project: { update: vi.fn() },
      backlogSnapshot: { create: vi.fn(), findMany: vi.fn().mockResolvedValue([]), deleteMany: vi.fn() },
    } as never) as never)

    const response = await request(app)
      .post(`/api/projects/${projectId}/backlog/grid-commit`)
      .set('Authorization', authHeader)
      .send({ rows: [
        { type: 'task', epicName: 'E', featureName: 'F', storyName: 'S', name: 'T', resourceTypeId: 'rt-dev', hoursEffort: 8 },
        { type: 'story', epicName: 'E', featureName: 'F', name: 'S' },
        { type: 'feature', epicName: 'E', name: 'F' },
        { type: 'epic', name: 'E' },
      ] })

    expect(response.status).toBe(200)
    expect(response.body.message).toBe('Grid entry committed')
    expect(prisma.$transaction).toHaveBeenCalledTimes(1)
  })
})
