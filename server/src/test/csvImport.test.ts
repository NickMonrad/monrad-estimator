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

process.env.JWT_SECRET = 'test-secret'

const userId = 'user-csv-1'
const token = jwt.sign({ userId }, 'test-secret')
const authHeader = `Bearer ${token}`
const projectId = 'proj-csv-1'
const mockProject = { id: projectId, ownerId: userId, hoursPerDay: 8 }

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
