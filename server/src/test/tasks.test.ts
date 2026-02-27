import { describe, it, expect, vi, beforeEach } from 'vitest'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { app } from '../index.js'
import { prisma } from '../lib/prisma.js'

process.env.JWT_SECRET = 'test-secret'

const userId = 'user-1'
const token = jwt.sign({ userId }, 'test-secret')
const authHeader = `Bearer ${token}`

const mockStory = { id: 'story-1', featureId: 'feat-1', name: 'Story 1', order: 0 }
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
