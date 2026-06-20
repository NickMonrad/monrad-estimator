import { describe, it, expect, vi, beforeEach } from 'vitest'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { app } from '../index.js'
import { prisma } from '../lib/prisma.js'

process.env.JWT_SECRET = 'test-secret'

const userId = 'user-1'
const token = jwt.sign({ userId }, 'test-secret')
const authHeader = `Bearer ${token}`

const mockStory = { id: 'story-1', featureId: 'feat-1', name: 'Story 1', order: 0, feature: { epic: { project: { hoursPerDay: 8 } } } }
const mockTask = { id: 'task-1', userStoryId: 'story-1', name: 'Task 1', hoursEffort: 4, resourceTypeId: 'rt-1', order: 0 }

beforeEach(() => vi.clearAllMocks())

describe('POST /api/stories/:storyId/tasks', () => {
  it('creates a task', async () => {
    vi.mocked(prisma.userStory.findFirst).mockResolvedValue(mockStory as any)
    vi.mocked(prisma.task.findMany).mockResolvedValue([])
    vi.mocked(prisma.task.create).mockResolvedValue({ ...mockTask, resourceType: { name: 'Developer' } } as any)

    const res = await request(app)
      .post('/api/stories/story-1/tasks')
      .set('Authorization', authHeader)
      .send({ name: 'Task 1', hoursEffort: 4, resourceTypeId: 'rt-1' })

    expect(res.status).toBe(201)
    expect(res.body.hoursEffort).toBe(4)
    expect(res.body.resourceType.name).toBe('Developer')
  })

  it('returns 400 when resourceTypeId is missing', async () => {
    vi.mocked(prisma.userStory.findFirst).mockResolvedValue(mockStory as any)

    const res = await request(app)
      .post('/api/stories/story-1/tasks')
      .set('Authorization', authHeader)
      .send({ name: 'Task 1' })

    expect(res.status).toBe(400)
  })
})

describe('PUT /api/stories/:storyId/tasks/:id', () => {
  it('updates task hours', async () => {
    vi.mocked(prisma.userStory.findFirst).mockResolvedValue(mockStory as any)
    vi.mocked(prisma.task.update).mockResolvedValue({ ...mockTask, hoursEffort: 8, resourceType: { name: 'Developer' } } as any)

    const res = await request(app)
      .put('/api/stories/story-1/tasks/task-1')
      .set('Authorization', authHeader)
      .send({ hoursEffort: 8 })

    expect(res.status).toBe(200)
    expect(res.body.hoursEffort).toBe(8)
  })
})

describe('PUT /api/stories/:storyId/tasks/:id — durationDays validation', () => {
  it('rejects durationDays = 0', async () => {
    vi.mocked(prisma.userStory.findFirst).mockResolvedValue(mockStory as any)
    const res = await request(app)
      .put('/api/stories/story-1/tasks/task-1')
      .set('Authorization', authHeader)
      .send({ durationDays: 0 })
    expect(res.status).toBe(400)
    expect(res.body.error).toContain('positive')
  })

  it('rejects negative durationDays', async () => {
    vi.mocked(prisma.userStory.findFirst).mockResolvedValue(mockStory as any)
    const res = await request(app)
      .put('/api/stories/story-1/tasks/task-1')
      .set('Authorization', authHeader)
      .send({ durationDays: -1 })
    expect(res.status).toBe(400)
    expect(res.body.error).toContain('positive')
  })

  it('rejects NaN durationDays', async () => {
    vi.mocked(prisma.userStory.findFirst).mockResolvedValue(mockStory as any)
    const res = await request(app)
      .put('/api/stories/story-1/tasks/task-1')
      .set('Authorization', authHeader)
      .send({ durationDays: 'abc' })
    expect(res.status).toBe(400)
  })

  it('accepts null durationDays as valid (auto-compute)', async () => {
    vi.mocked(prisma.userStory.findFirst).mockResolvedValue(mockStory as any)
    vi.mocked(prisma.task.update).mockResolvedValue({ ...mockTask, hoursEffort: 4, durationDays: null, resourceType: { name: 'Developer' } } as any)
    const res = await request(app)
      .put('/api/stories/story-1/tasks/task-1')
      .set('Authorization', authHeader)
      .send({ durationDays: null })
    expect(res.status).toBe(200)
    expect(res.body.durationDays).toBeNull()
  })

  it('accepts positive durationDays', async () => {
    vi.mocked(prisma.userStory.findFirst).mockResolvedValue(mockStory as any)
    vi.mocked(prisma.task.update).mockResolvedValue({ ...mockTask, hoursEffort: 4, durationDays: 5, resourceType: { name: 'Developer' } } as any)
    const res = await request(app)
      .put('/api/stories/story-1/tasks/task-1')
      .set('Authorization', authHeader)
      .send({ durationDays: 5 })
    expect(res.status).toBe(200)
    expect(res.body.durationDays).toBe(5)
  })
})
