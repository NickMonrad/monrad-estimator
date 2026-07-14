import { beforeEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import jwt from 'jsonwebtoken'

vi.mock('../routes/snapshots.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../routes/snapshots.js')>()
  return {
    ...actual,
    buildSnapshot: vi.fn().mockResolvedValue({}),
  }
})

vi.mock('../lib/snapshotUtils.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../lib/snapshotUtils.js')>()
  return {
    ...actual,
    pruneSnapshots: vi.fn().mockResolvedValue(undefined),
  }
})

import { app } from '../index.js'
import { prisma } from '../lib/prisma.js'
import { buildSnapshot } from '../routes/snapshots.js'

import { BACKLOG_CSV_HEADERS } from '../lib/csvFormat.js'

process.env.JWT_SECRET = 'test-secret'

const userId = 'user-csv-1'
const token = jwt.sign({ userId }, 'test-secret')
const projectId = 'proj-csv-1'
const mockProject = { id: projectId, ownerId: userId, hoursPerDay: 8, name: 'Test Project', customer: null }
const authHeader = `Bearer ${token}`

beforeEach(() => {
  vi.clearAllMocks()
})

describe('POST /api/projects/:projectId/backlog/import-csv', () => {
  beforeEach(() => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue(mockProject as never)
    // Provide at least one existing epic so the auto-snapshot branch is taken
    vi.mocked(prisma.epic.findMany).mockResolvedValue([{ id: 'epic-1' }] as never)
    // Provide a matching resource type by name
    vi.mocked(prisma.resourceType.findMany).mockResolvedValue([
      { id: 'rt-dev', name: 'Developer', hoursPerDay: 8 },
    ] as never)
  })

  it('returns 500 when buildSnapshot rejects, preventing snapshot persistence and mutation', async () => {
    vi.mocked(buildSnapshot).mockRejectedValueOnce(new Error('Snapshot null-state rejection'))

    const res = await request(app)
      .post(`/api/projects/${projectId}/backlog/import-csv`)
      .set('Authorization', authHeader)
      .send({
        rows: [
          {
            rowIndex: 0,
            type: 'Epic',
            epic: 'Test Epic',
            feature: '',
            story: '',
            task: '',
            epicStatus: true,
            featureStatus: false,
            storyStatus: false,
            epicMode: 'parallel',
            featureMode: '',
            epicDependsOn: [],
            featureDependsOn: [],
            template: '',
            templateSize: '',
            resourceType: '',
            hoursExtraSmall: 0,
            hoursSmall: 0,
            hoursMedium: 0,
            hoursLarge: 0,
            hoursExtraLarge: 0,
            hoursEffort: 0,
            durationDays: 0,
            description: '',
            assumptions: '',
            errors: [],
            warnings: [],
          },
        ],
      })

    expect(res.status).toBe(500)
    expect(prisma.backlogSnapshot.create).not.toHaveBeenCalled()
    expect(prisma.$transaction).not.toHaveBeenCalled()
  })
})

describe('POST /api/projects/:projectId/backlog/stage-csv', () => {
  beforeEach(() => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue(mockProject as never)
  })

  it('returns 400 with "Failed to parse CSV" on malformed CSV', async () => {
    const res = await request(app)
      .post(`/api/projects/${projectId}/backlog/stage-csv`)
      .set('Authorization', authHeader)
      .send({ csv: 'A,B,C\n1,2\n3,4,5,6' }) // ragged

    expect(res.status).toBe(400)
    expect(res.body.error).toContain('Failed to parse CSV')
  })

  it('returns 400 when csv field is missing', async () => {
    const res = await request(app)
      .post(`/api/projects/${projectId}/backlog/stage-csv`)
      .set('Authorization', authHeader)
      .send({})

    expect(res.status).toBe(400)
    expect(res.body.error).toBe('csv field is required')
  })
})

describe('GET /api/projects/:projectId/backlog/export-csv', () => {
  beforeEach(() => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue(mockProject as never)
    vi.mocked(prisma.epic.findMany).mockResolvedValue([])
    vi.mocked(prisma.epicDependency.findMany).mockResolvedValue([])
    vi.mocked(prisma.featureDependency.findMany).mockResolvedValue([])
  })

  it('responds with text/csv content type', async () => {
    const res = await request(app)
      .get(`/api/projects/${projectId}/backlog/export-csv`)
      .set('Authorization', authHeader)

    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toContain('text/csv')
  })

  it('outputs the application header row (first line)', async () => {
    const res = await request(app)
      .get(`/api/projects/${projectId}/backlog/export-csv`)
      .set('Authorization', authHeader)

    const firstLine = res.text.split('\n')[0]
    expect(firstLine).toBe(BACKLOG_CSV_HEADERS.join(','))
  })

  it('sanitises dangerous epic names in output', async () => {
    vi.mocked(prisma.epic.findMany).mockResolvedValue([
      {
        id: 'epic-1', projectId, name: '=HYPERLINK("http://evil")',
        description: null, assumptions: null, status: true,
        mode: 'parallel', order: 1, createdAt: new Date(), updatedAt: new Date(),
        features: [],
      },
    ] as never)

    const res = await request(app)
      .get(`/api/projects/${projectId}/backlog/export-csv`)
      .set('Authorization', authHeader)

    // Parse the CSV output to get the actual cell value (CSV may quote/escape)
    const lines = res.text.split('\n').filter(Boolean) as string[]
    const header = BACKLOG_CSV_HEADERS
    const epicIdx = header.indexOf('Epic')
    expect(epicIdx).toBeGreaterThanOrEqual(0)

    // Parse the CSV via csv-parse to handle quoting correctly
    const { parse } = await import('csv-parse/sync')
    const parsed = parse(res.text, { columns: true, skip_empty_lines: true, trim: true }) as Record<string, string>[]
    expect(parsed).toHaveLength(1)
    expect(parsed[0].Epic).toBe("'=HYPERLINK(\"http://evil\")")
  })
})
