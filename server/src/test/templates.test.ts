import { describe, it, expect, vi, beforeEach } from 'vitest'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { app } from '../index.js'
import { prisma } from '../lib/prisma.js'

process.env.JWT_SECRET = 'test-secret'

const userId = 'user-1'
const token = jwt.sign({ userId }, 'test-secret')
const authHeader = `Bearer ${token}`

const mockTemplate = {
  id: 'tpl-1',
  name: 'Auth Feature',
  category: 'Security',
  description: null,
  tasks: [],
  createdAt: new Date(),
  updatedAt: new Date(),
}

const mockTask = {
  id: 'ttask-1',
  templateId: 'tpl-1',
  name: 'Backend Auth',
  hoursSmall: 4,
  hoursMedium: 8,
  hoursLarge: 16,
  hoursExtraLarge: 24,
  resourceTypeName: 'Developer',
  resourceTypeId: null,
}

const mockEpic = { id: 'epic-1', projectId: 'proj-1' }
const mockFeature = { id: 'feat-1', epicId: 'epic-1', name: 'Feature 1' }
const mockProject = { id: 'proj-1', ownerId: userId }
const mockResourceType = { id: 'rt-1', name: 'Developer', projectId: 'proj-1' }
const mockStory = { id: 'story-new', featureId: 'feat-1', name: 'Auth Feature \u2014 SMALL', order: 0 }

beforeEach(() => vi.clearAllMocks())

describe('GET /api/templates', () => {
  it('returns empty array', async () => {
    vi.mocked(prisma.featureTemplate.findMany).mockResolvedValue([])

    const res = await request(app).get('/api/templates')

    expect(res.status).toBe(200)
    expect(res.body).toEqual([])
  })
})

describe('POST /api/templates', () => {
  it('creates template with auth', async () => {
    vi.mocked(prisma.featureTemplate.create).mockResolvedValue(mockTemplate as any)

    const res = await request(app)
      .post('/api/templates')
      .set('Authorization', authHeader)
      .send({ name: 'Auth Feature', category: 'Security' })

    expect(res.status).toBe(201)
    expect(res.body.name).toBe('Auth Feature')
  })

  it('returns 401 without auth', async () => {
    const res = await request(app).post('/api/templates').send({ name: 'Test' })
    expect(res.status).toBe(401)
  })
})

describe('POST /api/templates/:id/tasks', () => {
  it('adds a task to template', async () => {
    vi.mocked(prisma.templateTask.create).mockResolvedValue(mockTask as any)

    const res = await request(app)
      .post('/api/templates/tpl-1/tasks')
      .set('Authorization', authHeader)
      .send({
        name: 'Backend Auth',
        hoursSmall: 4,
        hoursMedium: 8,
        hoursLarge: 16,
        hoursExtraLarge: 24,
        resourceTypeName: 'Developer',
      })

    expect(res.status).toBe(201)
    expect(res.body.name).toBe('Backend Auth')
    expect(res.body.hoursSmall).toBe(4)
  })
})

describe('POST /api/features/:featureId/apply-template', () => {
  it('creates story and tasks from template', async () => {
    vi.mocked(prisma.feature.findFirst).mockResolvedValue({
      ...mockFeature,
      epic: { ...mockEpic, project: mockProject },
    } as any)
    vi.mocked(prisma.featureTemplate.findUnique).mockResolvedValue({
      ...mockTemplate,
      tasks: [mockTask],
    } as any)
    vi.mocked(prisma.resourceType.findMany).mockResolvedValue([mockResourceType] as any)
    vi.mocked(prisma.userStory.findMany).mockResolvedValue([])
    vi.mocked(prisma.userStory.create).mockResolvedValue(mockStory as any)
    vi.mocked(prisma.task.create).mockResolvedValue({
      id: 'task-new',
      name: 'Backend Auth',
      hoursEffort: 4,
      resourceTypeId: 'rt-1',
      userStoryId: 'story-new',
      order: 0,
    } as any)
    vi.mocked(prisma.userStory.findUnique).mockResolvedValue({
      ...mockStory,
      tasks: [{ id: 'task-new', name: 'Backend Auth', hoursEffort: 4 }],
    } as any)

    const res = await request(app)
      .post('/api/features/feat-1/apply-template')
      .set('Authorization', authHeader)
      .send({ templateId: 'tpl-1', complexity: 'SMALL' })

    expect(res.status).toBe(201)
    expect(res.body.name).toBe('Auth Feature \u2014 SMALL')
  })
})
