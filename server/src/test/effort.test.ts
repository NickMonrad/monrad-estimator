import { describe, it, expect, vi, beforeEach } from 'vitest'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { app } from '../index.js'
import { prisma } from '../lib/prisma.js'

process.env.JWT_SECRET = 'test-secret'

const userId = 'user-1'
const token = jwt.sign({ userId }, 'test-secret')
const authHeader = `Bearer ${token}`

const mockProject = {
  id: 'proj-1',
  ownerId: userId,
  hoursPerDay: 8,
  epics: [
    {
      id: 'epic-1',
      name: 'Authentication',
      features: [
        {
          id: 'feat-1',
          name: 'Login Feature',
          userStories: [
            {
              id: 'story-1',
              name: 'As a user I can log in',
              tasks: [
                {
                  id: 'task-1',
                  name: 'Build login form',
                  hoursEffort: 16,
                  resourceTypeId: 'rt-1',
                  resourceType: { id: 'rt-1', name: 'Developer', category: 'ENGINEERING', count: 2, proposedName: null },
                },
              ],
            },
          ],
        },
      ],
    },
  ],
  resourceTypes: [
    { id: 'rt-1', name: 'Developer', category: 'ENGINEERING', count: 2, proposedName: null },
    { id: 'rt-2', name: 'Project Manager', category: 'PROJECT_MANAGEMENT', count: 1, proposedName: 'PM Lead' },
  ],
}

beforeEach(() => vi.clearAllMocks())

describe('GET /api/projects/:projectId/effort', () => {
  it('returns 401 without auth', async () => {
    const res = await request(app).get('/api/projects/proj-1/effort')
    expect(res.status).toBe(401)
  })

  it('returns 404 when project not found', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue(null)
    const res = await request(app)
      .get('/api/projects/proj-1/effort')
      .set('Authorization', authHeader)
    expect(res.status).toBe(404)
  })

  it('returns effort summary with correct structure', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue(mockProject as any)

    const res = await request(app)
      .get('/api/projects/proj-1/effort')
      .set('Authorization', authHeader)

    expect(res.status).toBe(200)
    expect(res.body.projectId).toBe('proj-1')
    expect(res.body.hoursPerDay).toBe(8)
    expect(res.body.totalHours).toBe(16)
    expect(res.body.totalDays).toBe(2)
    expect(res.body.byCategory).toHaveLength(2)
  })

  it('calculates totals correctly using hoursPerDay', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue(mockProject as any)

    const res = await request(app)
      .get('/api/projects/proj-1/effort')
      .set('Authorization', authHeader)

    const engCategory = res.body.byCategory.find((c: any) => c.category === 'ENGINEERING')
    expect(engCategory).toBeDefined()
    expect(engCategory.totalHours).toBe(16)
    expect(engCategory.totalDays).toBe(2) // 16 / 8

    const devRt = engCategory.resourceTypes[0]
    expect(devRt.name).toBe('Developer')
    expect(devRt.count).toBe(2)
    expect(devRt.totalHours).toBe(16)
    expect(devRt.totalDays).toBe(2)

    expect(devRt.tasks).toHaveLength(1)
    expect(devRt.tasks[0].taskName).toBe('Build login form')
    expect(devRt.tasks[0].epicName).toBe('Authentication')
    expect(devRt.tasks[0].featureName).toBe('Login Feature')
    expect(devRt.tasks[0].storyName).toBe('As a user I can log in')
    expect(devRt.tasks[0].hoursEffort).toBe(16)
    expect(devRt.tasks[0].daysEffort).toBe(2)
  })

  it('sorts categories ENGINEERING first, then PROJECT_MANAGEMENT', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue(mockProject as any)

    const res = await request(app)
      .get('/api/projects/proj-1/effort')
      .set('Authorization', authHeader)

    expect(res.body.byCategory[0].category).toBe('ENGINEERING')
    expect(res.body.byCategory[1].category).toBe('PROJECT_MANAGEMENT')
  })

  it('returns empty byCategory when project has no tasks', async () => {
    const emptyProject = {
      ...mockProject,
      epics: [],
      resourceTypes: [],
    }
    vi.mocked(prisma.project.findFirst).mockResolvedValue(emptyProject as any)

    const res = await request(app)
      .get('/api/projects/proj-1/effort')
      .set('Authorization', authHeader)

    expect(res.status).toBe(200)
    expect(res.body.totalHours).toBe(0)
    expect(res.body.totalDays).toBe(0)
    expect(res.body.byCategory).toHaveLength(0)
  })

  it('includes proposedName when set', async () => {
    const projectWithTasks = {
      ...mockProject,
      epics: [
        {
          id: 'epic-2',
          name: 'Planning',
          features: [
            {
              id: 'feat-2',
              name: 'Project Setup',
              userStories: [
                {
                  id: 'story-2',
                  name: 'As PM I can track progress',
                  tasks: [
                    {
                      id: 'task-2',
                      name: 'Create project plan',
                      hoursEffort: 8,
                      resourceTypeId: 'rt-2',
                      resourceType: { id: 'rt-2', name: 'Project Manager', category: 'PROJECT_MANAGEMENT', count: 1, proposedName: 'PM Lead' },
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    }
    vi.mocked(prisma.project.findFirst).mockResolvedValue(projectWithTasks as any)

    const res = await request(app)
      .get('/api/projects/proj-1/effort')
      .set('Authorization', authHeader)

    const pmCategory = res.body.byCategory.find((c: any) => c.category === 'PROJECT_MANAGEMENT')
    expect(pmCategory).toBeDefined()
    expect(pmCategory.resourceTypes[0].proposedName).toBe('PM Lead')
  })
})
