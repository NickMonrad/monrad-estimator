import { beforeEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { app } from '../index.js'
import { prisma } from '../lib/prisma.js'

process.env.JWT_SECRET = 'test-secret'

const userId = 'user-1'
const authHeader = `Bearer ${jwt.sign({ userId }, 'test-secret')}`
const project = { id: 'project-1', ownerId: userId }

function makeTx() {
  return {
    resourceType: { findMany: vi.fn().mockResolvedValue([{ id: 'rt-1' }]) },
    epic: {
      findFirst: vi.fn(),
      updateMany: vi.fn(),
      create: vi.fn(({ data }: { data: { id?: string; name: string } }) => ({ id: data.id ?? 'epic-copy', name: data.name })),
    },
    feature: {
      findFirst: vi.fn(),
      updateMany: vi.fn(),
      create: vi.fn(({ data }: { data: { id?: string; name: string } }) => ({ id: data.id ?? 'feature-copy', name: data.name })),
    },
    userStory: {
      findFirst: vi.fn(),
      updateMany: vi.fn(),
      create: vi.fn(({ data }: { data: { id?: string; name: string } }) => ({ id: data.id ?? 'story-copy', name: data.name })),
    },
    task: {
      findFirst: vi.fn(),
      updateMany: vi.fn(),
      create: vi.fn(({ data }: { data: { id?: string; name: string } }) => ({ id: data.id ?? `task-copy-${data.name}`, name: data.name })),
    },
    epicDependency: { create: vi.fn() },
    featureDependency: { create: vi.fn() },
    storyDependency: { create: vi.fn() },
  }
}

function useTx(tx: object) {
  vi.mocked(prisma.project.findFirst).mockResolvedValue(project as never)
  vi.mocked(prisma.$transaction).mockImplementation(async callback =>
    (callback as unknown as (transaction: object) => Promise<unknown>)(tx),
  )
}

beforeEach(() => vi.clearAllMocks())

describe('POST /api/projects/:projectId/backlog/duplicate', () => {
  it('duplicates a Task with exact nullable and retained fields and adjacent ordering', async () => {
    const tx = makeTx()
    tx.task.findFirst.mockResolvedValue({
      id: 'task-1', name: 'Source task', description: '<p>desc</p>', assumptions: 'assume',
      hoursEffort: 12.5, durationDays: null, order: 1, userStoryId: 'story-1', resourceTypeId: 'rt-1',
    })
    useTx(tx)

    const response = await request(app)
      .post('/api/projects/project-1/backlog/duplicate')
      .set('Authorization', authHeader)
      .send({ type: 'task', id: 'task-1' })

    expect(response.status).toBe(201)
    expect(response.body).toMatchObject({ type: 'task', id: expect.any(String), name: 'Copy of Source task', parentId: 'story-1' })
    expect(tx.task.updateMany).toHaveBeenCalledWith({
      where: { userStoryId: 'story-1', order: { gt: 1 } },
      data: { order: { increment: 1 } },
    })
    expect(tx.task.create).toHaveBeenCalledWith({ data: {
      name: 'Copy of Source task', description: '<p>desc</p>', assumptions: 'assume', hoursEffort: 12.5,
      durationDays: null, resourceTypeId: 'rt-1', userStoryId: 'story-1', order: 2,
    } })
    expect(tx.epicDependency.create).not.toHaveBeenCalled()
    expect(tx.featureDependency.create).not.toHaveBeenCalled()
    expect(tx.storyDependency.create).not.toHaveBeenCalled()
  })

  it('duplicates a Story and deep-copies Tasks under the new Story', async () => {
    const tx = makeTx()
    tx.userStory.findFirst.mockResolvedValue({
      id: 'story-1', name: 'Source story', description: 'desc', assumptions: 'assume', order: 2,
      isActive: false, appliedTemplateId: 'template-1', featureId: 'feature-1',
      tasks: [
        { id: 'task-1', name: 'Task one', description: null, assumptions: null, hoursEffort: 4, durationDays: 1.5, order: 0, userStoryId: 'story-1', resourceTypeId: 'rt-1' },
        { id: 'task-2', name: 'Task two', description: 'two', assumptions: 'two', hoursEffort: 0, durationDays: null, order: 1, userStoryId: 'story-1', resourceTypeId: null },
      ],
    })
    useTx(tx)

    const response = await request(app)
      .post('/api/projects/project-1/backlog/duplicate')
      .set('Authorization', authHeader)
      .send({ type: 'story', id: 'story-1' })

    expect(response.status).toBe(201)
    expect(tx.userStory.updateMany).toHaveBeenCalledWith({ where: { featureId: 'feature-1', order: { gt: 2 } }, data: { order: { increment: 1 } } })
    expect(tx.userStory.create).toHaveBeenCalledWith({ data: {
      name: 'Copy of Source story', description: 'desc', assumptions: 'assume', isActive: false,
      appliedTemplateId: 'template-1', featureId: 'feature-1', order: 3,
    } })
    expect(tx.task.create).toHaveBeenNthCalledWith(1, { data: expect.objectContaining({ name: 'Task one', userStoryId: 'story-copy', durationDays: 1.5, resourceTypeId: 'rt-1' }) })
    expect(tx.task.create).toHaveBeenNthCalledWith(2, { data: expect.objectContaining({ name: 'Task two', userStoryId: 'story-copy', durationDays: null, resourceTypeId: null }) })
  })

  it('duplicates a Feature with feature metadata and copied descendants', async () => {
    const tx = makeTx()
    tx.feature.findFirst.mockResolvedValue({
      id: 'feature-1', name: 'Source feature', description: 'desc', assumptions: 'assume', order: 1,
      featureMode: 'parallel', isActive: false, timelineColour: '#123456', timelineStartWeek: 9, epicId: 'epic-1',
      userStories: [{
        id: 'story-1', name: 'Story', description: null, assumptions: null, order: 0, isActive: true,
        appliedTemplateId: null, featureId: 'feature-1', tasks: [],
      }],
    })
    useTx(tx)

    const response = await request(app)
      .post('/api/projects/project-1/backlog/duplicate')
      .set('Authorization', authHeader)
      .send({ type: 'feature', id: 'feature-1' })

    expect(response.status).toBe(201)
    expect(tx.feature.create).toHaveBeenCalledWith({ data: {
      name: 'Copy of Source feature', description: 'desc', assumptions: 'assume', featureMode: 'parallel',
      timelineColour: '#123456', isActive: false, epicId: 'epic-1', order: 2,
    } })
    expect(tx.userStory.create).toHaveBeenCalledWith({ data: expect.objectContaining({ name: 'Story', featureId: 'feature-copy' }) })
    expect(tx.feature.updateMany).toHaveBeenCalledWith({ where: { epicId: 'epic-1', order: { gt: 1 } }, data: { order: { increment: 1 } } })
  })

  it('duplicates an Epic with complete descendants and excludes timeline fields', async () => {
    const tx = makeTx()
    tx.epic.findFirst.mockResolvedValue({
      id: 'epic-1', name: 'Source epic', description: 'desc', assumptions: 'assume', order: 0,
      featureMode: 'parallel', scheduleMode: 'parallel', timelineStartWeek: 7, isActive: false, projectId: 'project-1',
      features: [{
        id: 'feature-1', name: 'Feature', description: null, assumptions: null, order: 0, featureMode: 'sequential',
        isActive: true, timelineColour: '#abcdef', timelineStartWeek: 3, epicId: 'epic-1',
        userStories: [{
          id: 'story-1', name: 'Story', description: null, assumptions: null, order: 0, isActive: true,
          appliedTemplateId: 'template-1', featureId: 'feature-1',
          tasks: [{ id: 'task-1', name: 'Task', description: null, assumptions: null, hoursEffort: 8, durationDays: 2, order: 0, userStoryId: 'story-1', resourceTypeId: 'rt-1' }],
        }],
      }],
    })
    useTx(tx)

    const response = await request(app)
      .post('/api/projects/project-1/backlog/duplicate')
      .set('Authorization', authHeader)
      .send({ type: 'epic', id: 'epic-1' })

    expect(response.status).toBe(201)
    expect(tx.epic.create).toHaveBeenCalledWith({ data: {
      name: 'Copy of Source epic', description: 'desc', assumptions: 'assume', featureMode: 'parallel',
      scheduleMode: 'parallel', isActive: false, projectId: 'project-1', order: 1,
    } })
    expect(tx.feature.create).toHaveBeenCalledWith({ data: expect.objectContaining({ name: 'Feature', epicId: 'epic-copy', timelineColour: '#abcdef' }) })
    expect(tx.userStory.create).toHaveBeenCalledWith({ data: expect.objectContaining({ name: 'Story', featureId: 'feature-copy', appliedTemplateId: 'template-1' }) })
    expect(tx.task.create).toHaveBeenCalledWith({ data: expect.objectContaining({ name: 'Task', userStoryId: 'story-copy', durationDays: 2, resourceTypeId: 'rt-1' }) })
    expect(tx.epic.create.mock.calls[0][0].data).not.toHaveProperty('timelineStartWeek')
    expect(tx.feature.create.mock.calls[0][0].data).not.toHaveProperty('timelineStartWeek')
  })

  it('fails before writes when a retained ResourceType is foreign to the project', async () => {
    const tx = makeTx()
    tx.resourceType.findMany.mockResolvedValue([])
    tx.task.findFirst.mockResolvedValue({
      id: 'task-1', name: 'Task', description: null, assumptions: null, hoursEffort: 1, durationDays: 1,
      order: 0, userStoryId: 'story-1', resourceTypeId: 'foreign-rt',
    })
    useTx(tx)

    const response = await request(app)
      .post('/api/projects/project-1/backlog/duplicate')
      .set('Authorization', authHeader)
      .send({ type: 'task', id: 'task-1' })

    expect(response.status).toBe(422)
    expect(response.body.error).toMatch(/not part of this project/)
    expect(tx.task.updateMany).not.toHaveBeenCalled()
    expect(tx.task.create).not.toHaveBeenCalled()
  })

  it('rolls back the transaction when descendant creation fails', async () => {
    const tx = makeTx()
    tx.epic.findFirst.mockResolvedValue({
      id: 'epic-1', name: 'Epic', description: null, assumptions: null, order: 0,
      featureMode: 'sequential', scheduleMode: 'sequential', isActive: true, projectId: 'project-1',
      features: [{
        id: 'feature-1', name: 'Feature', description: null, assumptions: null, order: 0, featureMode: 'sequential',
        isActive: true, timelineColour: null, epicId: 'epic-1',
        userStories: [{ id: 'story-1', name: 'Story', description: null, assumptions: null, order: 0, isActive: true, appliedTemplateId: null, featureId: 'feature-1', tasks: [] }],
      }],
    })
    tx.feature.create.mockRejectedValue(new Error('injected create failure'))
    useTx(tx)

    const response = await request(app)
      .post('/api/projects/project-1/backlog/duplicate')
      .set('Authorization', authHeader)
      .send({ type: 'epic', id: 'epic-1' })

    expect(response.status).toBe(500)
    expect(tx.epic.updateMany).toHaveBeenCalled()
    expect(tx.feature.create).toHaveBeenCalled()
    expect(response.body.error).toContain('injected create failure')
    expect(vi.mocked(prisma.$transaction)).toHaveBeenCalledWith(expect.any(Function), expect.objectContaining({ timeout: 30000, isolationLevel: 'RepeatableRead' }))
  })

  it('requires authentication and project ownership', async () => {
    const unauthenticated = await request(app).post('/api/projects/project-1/backlog/duplicate').send({ type: 'task', id: 'task-1' })
    expect(unauthenticated.status).toBe(401)

    vi.mocked(prisma.project.findFirst).mockResolvedValue(null)
    const unauthorized = await request(app)
      .post('/api/projects/project-1/backlog/duplicate')
      .set('Authorization', authHeader)
      .send({ type: 'task', id: 'task-1' })
    expect(unauthorized.status).toBe(404)
  })
})
