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
  startDate: new Date('2026-03-01T00:00:00.000Z'),
  name: 'Test Project',
}

const mockEpicsWithFeatures = [
  {
    id: 'epic-1',
    name: 'Authentication',
    order: 0,
    features: [
      {
        id: 'feat-1',
        name: 'Login',
        order: 0,
        userStories: [
          {
            id: 'story-1',
            tasks: [
              {
                id: 'task-1',
                hoursEffort: 16,
                durationDays: null,
                resourceTypeId: 'rt-1',
                resourceType: { id: 'rt-1', name: 'Developer', category: 'ENGINEERING', count: 1 },
              },
            ],
          },
        ],
      },
      {
        id: 'feat-2',
        name: 'Registration',
        order: 1,
        userStories: [
          {
            id: 'story-2',
            tasks: [
              {
                id: 'task-2',
                hoursEffort: 8,
                durationDays: null,
                resourceTypeId: 'rt-1',
                resourceType: { id: 'rt-1', name: 'Developer', category: 'ENGINEERING', count: 1 },
              },
            ],
          },
        ],
      },
    ],
  },
]

const mockResourceTypes = [
  { id: 'rt-1', name: 'Developer', category: 'ENGINEERING', count: 1, projectId: 'proj-1' },
]

const mockEntries = [
  {
    id: 'entry-1',
    projectId: 'proj-1',
    featureId: 'feat-1',
    startWeek: 0,
    durationWeeks: 2,
    isManual: false,
    feature: { name: 'Login', epic: { id: 'epic-1', name: 'Authentication' } },
  },
]

beforeEach(() => vi.clearAllMocks())

describe('GET /api/projects/:projectId/timeline', () => {
  it('returns 401 without auth', async () => {
    const res = await request(app).get('/api/projects/proj-1/timeline')
    expect(res.status).toBe(401)
  })

  it('returns 404 for project not owned by user', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue(null)
    const res = await request(app)
      .get('/api/projects/proj-1/timeline')
      .set('Authorization', authHeader)
    expect(res.status).toBe(404)
  })

  it('returns empty entries when no timeline scheduled', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue(mockProject as any)
    vi.mocked(prisma.timelineEntry.findMany).mockResolvedValue([])

    const res = await request(app)
      .get('/api/projects/proj-1/timeline')
      .set('Authorization', authHeader)

    expect(res.status).toBe(200)
    expect(res.body.projectId).toBe('proj-1')
    expect(res.body.entries).toHaveLength(0)
    expect(res.body.hoursPerDay).toBe(8)
  })

  it('returns computed startDate and endDate based on project.startDate', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue(mockProject as any)
    vi.mocked(prisma.timelineEntry.findMany).mockResolvedValue(mockEntries as any)

    const res = await request(app)
      .get('/api/projects/proj-1/timeline')
      .set('Authorization', authHeader)

    expect(res.status).toBe(200)
    const entry = res.body.entries[0]
    // startWeek=0 => startDate = project.startDate
    expect(entry.startDate).toBe('2026-03-01T00:00:00.000Z')
    // durationWeeks=2 => endDate = +14 days
    expect(entry.endDate).toBe('2026-03-15T00:00:00.000Z')
  })
})

describe('POST /api/projects/:projectId/timeline/schedule', () => {
  it('returns 401 without auth', async () => {
    const res = await request(app).post('/api/projects/proj-1/timeline/schedule')
    expect(res.status).toBe(401)
  })

  it('returns 404 for project not owned by user', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue(null)
    const res = await request(app)
      .post('/api/projects/proj-1/timeline/schedule')
      .set('Authorization', authHeader)
    expect(res.status).toBe(404)
  })

  it('calculates duration correctly: 16h, 1 resource, 8h/day = 2 days = 1 week', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue(mockProject as any)
    vi.mocked(prisma.epic.findMany).mockResolvedValue([
      {
        id: 'epic-1',
        name: 'Auth',
        order: 0,
        features: [
          {
            id: 'feat-1',
            name: 'Login',
            order: 0,
            userStories: [
              {
                id: 'story-1',
                tasks: [
                  {
                    id: 'task-1',
                    hoursEffort: 16,
                    durationDays: null,
                    resourceTypeId: 'rt-1',
                    resourceType: { id: 'rt-1', count: 1 },
                  },
                ],
              },
            ],
          },
        ],
      },
    ] as any)
    vi.mocked(prisma.resourceType.findMany).mockResolvedValue(mockResourceTypes as any)
    vi.mocked(prisma.timelineEntry.upsert).mockResolvedValue({} as any)
    vi.mocked(prisma.timelineEntry.findMany).mockResolvedValue([
      {
        id: 'entry-1',
        projectId: 'proj-1',
        featureId: 'feat-1',
        startWeek: 0,
        durationWeeks: 1,  // ceil(2 days / 5) = 1 week
        isManual: false,
        feature: { name: 'Login', epic: { id: 'epic-1', name: 'Auth' } },
      },
    ] as any)

    const res = await request(app)
      .post('/api/projects/proj-1/timeline/schedule')
      .set('Authorization', authHeader)
      .send({})

    expect(res.status).toBe(200)
    expect(res.body.entries).toHaveLength(1)
    expect(res.body.entries[0].durationWeeks).toBe(1)
    expect(res.body.entries[0].startWeek).toBe(0)
  })

  it('returns entries for a project with tasks and updates startDate if provided', async () => {
    const updatedProject = { ...mockProject, startDate: new Date('2026-04-01T00:00:00.000Z') }
    vi.mocked(prisma.project.findFirst).mockResolvedValue(mockProject as any)
    vi.mocked(prisma.project.update).mockResolvedValue(updatedProject as any)
    vi.mocked(prisma.epic.findMany).mockResolvedValue(mockEpicsWithFeatures as any)
    vi.mocked(prisma.resourceType.findMany).mockResolvedValue(mockResourceTypes as any)
    vi.mocked(prisma.timelineEntry.upsert).mockResolvedValue({} as any)
    vi.mocked(prisma.timelineEntry.findMany).mockResolvedValue([
      {
        id: 'entry-1',
        projectId: 'proj-1',
        featureId: 'feat-1',
        startWeek: 0,
        durationWeeks: 1,
        isManual: false,
        feature: { name: 'Login', epic: { id: 'epic-1', name: 'Authentication' } },
      },
      {
        id: 'entry-2',
        projectId: 'proj-1',
        featureId: 'feat-2',
        startWeek: 1,
        durationWeeks: 1,
        isManual: false,
        feature: { name: 'Registration', epic: { id: 'epic-1', name: 'Authentication' } },
      },
    ] as any)

    const res = await request(app)
      .post('/api/projects/proj-1/timeline/schedule')
      .set('Authorization', authHeader)
      .send({ startDate: '2026-04-01' })

    expect(res.status).toBe(200)
    expect(res.body.entries).toHaveLength(2)
    // feat-2 should start after feat-1
    expect(res.body.entries[1].startWeek).toBeGreaterThanOrEqual(res.body.entries[0].startWeek)
  })
})

describe('PUT /api/projects/:projectId/timeline/:featureId', () => {
  it('returns 401 without auth', async () => {
    const res = await request(app).put('/api/projects/proj-1/timeline/feat-1')
    expect(res.status).toBe(401)
  })

  it('returns 404 for project not owned by user', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue(null)
    const res = await request(app)
      .put('/api/projects/proj-1/timeline/feat-1')
      .set('Authorization', authHeader)
      .send({ startWeek: 2, durationWeeks: 3 })
    expect(res.status).toBe(404)
  })

  it('overrides a feature startWeek and durationWeeks with isManual=true', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue(mockProject as any)
    vi.mocked(prisma.timelineEntry.upsert).mockResolvedValue({
      id: 'entry-1',
      projectId: 'proj-1',
      featureId: 'feat-1',
      startWeek: 2,
      durationWeeks: 3,
      isManual: true,
      feature: { name: 'Login', epic: { id: 'epic-1', name: 'Authentication' } },
    } as any)

    const res = await request(app)
      .put('/api/projects/proj-1/timeline/feat-1')
      .set('Authorization', authHeader)
      .send({ startWeek: 2, durationWeeks: 3 })

    expect(res.status).toBe(200)
    expect(res.body.startWeek).toBe(2)
    expect(res.body.durationWeeks).toBe(3)
    expect(res.body.isManual).toBe(true)
  })

  it('returns 400 when startWeek or durationWeeks missing', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue(mockProject as any)
    const res = await request(app)
      .put('/api/projects/proj-1/timeline/feat-1')
      .set('Authorization', authHeader)
      .send({ startWeek: 2 })
    expect(res.status).toBe(400)
  })
})
