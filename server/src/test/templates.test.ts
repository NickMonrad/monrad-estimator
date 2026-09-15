import { describe, it, expect, vi, beforeEach } from 'vitest'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { app } from '../index.js'
import { prisma } from '../lib/prisma.js'
import { TEMPLATE_CSV_HEADERS, parseTemplateCsv, serializeCsv } from '../lib/csvFormat.js'
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
  it('returns empty array with auth', async () => {
    vi.mocked(prisma.featureTemplate.findMany).mockResolvedValue([])

    const res = await request(app).get('/api/templates').set('Authorization', authHeader)

    expect(res.status).toBe(200)
    expect(res.body).toEqual([])
  })

  it('returns 401 without auth', async () => {
    const res = await request(app).get('/api/templates')
    expect(res.status).toBe(401)
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
    vi.mocked(prisma.templateTask.count).mockResolvedValue(2)
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


describe('POST /api/templates/import-csv/preview', () => {
  it('returns newTemplates from valid CSV', async () => {
    const csv = serializeCsv([...TEMPLATE_CSV_HEADERS] as string[], [
      ['API', 'Engineering', 'Auth', 'Developer', '1', '2', '4', '8', '16', '', '', '', ''],
    ])

    const res = await request(app)
      .post('/api/templates/import-csv/preview')
      .set('Authorization', authHeader)
      .send({ csv })

    expect(res.status).toBe(200)
    expect(res.body.newTemplates).toHaveLength(1)
    expect(res.body.updatedTemplates).toHaveLength(0)
  })

  it('returns 400 on malformed CSV', async () => {
    const res = await request(app)
      .post('/api/templates/import-csv/preview')
      .set('Authorization', authHeader)
      .send({ csv: 'A,B\n1,2,3' })

    expect(res.status).toBe(400)
    expect(res.body.error).toContain('Failed to parse CSV')
  })
})

// ---------------------------------------------------------------------------
// Template metadata fields
// ---------------------------------------------------------------------------

const TEMPLATE_DESCRIPTION = '<p>Delivers login, registration and MFA</p>'
const TEMPLATE_ASSUMPTIONS = '<p>Identity provider available</p>'
const TASK_DESCRIPTION = '<p>Build endpoint, wire to IdP</p>'
const TASK_ASSUMPTIONS = '<p>Test tenant provisioned</p>'

describe('template metadata persistence', () => {
  it('persists description and assumptions when creating a template', async () => {
    vi.mocked(prisma.featureTemplate.findUnique).mockResolvedValue(null)
    vi.mocked(prisma.featureTemplate.create).mockResolvedValue(mockTemplate as never)

    const res = await request(app)
      .post('/api/templates')
      .set('Authorization', authHeader)
      .send({ name: 'Auth Feature', category: 'Security', description: TEMPLATE_DESCRIPTION, assumptions: TEMPLATE_ASSUMPTIONS })

    expect(res.status).toBe(201)
    expect(prisma.featureTemplate.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ description: TEMPLATE_DESCRIPTION, assumptions: TEMPLATE_ASSUMPTIONS }),
    }))
  })

  it('persists description and assumptions when updating a template', async () => {
    vi.mocked(prisma.featureTemplate.findUnique).mockResolvedValue(mockTemplate as never)
    vi.mocked(prisma.templateSnapshot.create).mockResolvedValue({} as never)
    vi.mocked(prisma.featureTemplate.update).mockResolvedValue(mockTemplate as never)

    const res = await request(app)
      .put('/api/templates/tpl-1')
      .set('Authorization', authHeader)
      .send({ name: 'Auth Feature', description: TEMPLATE_DESCRIPTION, assumptions: TEMPLATE_ASSUMPTIONS })

    expect(res.status).toBe(200)
    expect(prisma.featureTemplate.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ description: TEMPLATE_DESCRIPTION, assumptions: TEMPLATE_ASSUMPTIONS }),
    }))
  })

  it('persists description and assumptions when creating a template task', async () => {
    vi.mocked(prisma.templateTask.count).mockResolvedValue(0)
    vi.mocked(prisma.templateTask.create).mockResolvedValue(mockTask as never)

    const res = await request(app)
      .post('/api/templates/tpl-1/tasks')
      .set('Authorization', authHeader)
      .send({ name: 'Backend Auth', resourceTypeName: 'Developer', description: TASK_DESCRIPTION, assumptions: TASK_ASSUMPTIONS })

    expect(res.status).toBe(201)
    expect(prisma.templateTask.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ description: TASK_DESCRIPTION, assumptions: TASK_ASSUMPTIONS }),
    }))
  })

  it('persists description and assumptions when updating a template task', async () => {
    vi.mocked(prisma.templateTask.update).mockResolvedValue(mockTask as never)

    const res = await request(app)
      .put('/api/templates/tpl-1/tasks/ttask-1')
      .set('Authorization', authHeader)
      .send({ name: 'Backend Auth', resourceTypeName: 'Developer', description: TASK_DESCRIPTION, assumptions: TASK_ASSUMPTIONS })

    expect(res.status).toBe(200)
    expect(prisma.templateTask.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ description: TASK_DESCRIPTION, assumptions: TASK_ASSUMPTIONS }),
    }))
  })
})

// ---------------------------------------------------------------------------
// Apply-template propagation
// ---------------------------------------------------------------------------

const metadataTemplate = {
  ...mockTemplate,
  description: TEMPLATE_DESCRIPTION,
  assumptions: TEMPLATE_ASSUMPTIONS,
  tasks: [
    { ...mockTask, order: 0, description: TASK_DESCRIPTION, assumptions: TASK_ASSUMPTIONS },
  ],
}

function mockApplySuccess() {
  vi.mocked(prisma.feature.findFirst).mockResolvedValue({
    ...mockFeature,
    epic: { ...mockEpic, project: mockProject },
  } as never)
  vi.mocked(prisma.featureTemplate.findUnique).mockResolvedValue(metadataTemplate as never)
  vi.mocked(prisma.resourceType.findMany).mockResolvedValue([mockResourceType] as never)
  vi.mocked(prisma.userStory.findMany).mockResolvedValue([])
  vi.mocked(prisma.userStory.create).mockResolvedValue(mockStory as never)
  vi.mocked(prisma.task.create).mockResolvedValue({ id: 'task-new' } as never)
  vi.mocked(prisma.userStory.findUnique).mockResolvedValue({ ...mockStory, tasks: [] } as never)
}

describe('POST /api/features/:featureId/apply-template metadata propagation', () => {
  it('copies template metadata onto the generated story', async () => {
    mockApplySuccess()

    const res = await request(app)
      .post('/api/features/feat-1/apply-template')
      .set('Authorization', authHeader)
      .send({ templateId: 'tpl-1', complexity: 'SMALL' })

    expect(res.status).toBe(201)
    expect(prisma.userStory.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ description: TEMPLATE_DESCRIPTION, assumptions: TEMPLATE_ASSUMPTIONS }),
    }))
  })

  it('copies template task metadata onto the generated tasks', async () => {
    mockApplySuccess()

    await request(app)
      .post('/api/features/feat-1/apply-template')
      .set('Authorization', authHeader)
      .send({ templateId: 'tpl-1', complexity: 'SMALL' })

    expect(prisma.task.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ description: TASK_DESCRIPTION, assumptions: TASK_ASSUMPTIONS }),
    }))
  })

  it('does not mutate the parent feature metadata', async () => {
    mockApplySuccess()

    await request(app)
      .post('/api/features/feat-1/apply-template')
      .set('Authorization', authHeader)
      .send({ templateId: 'tpl-1', complexity: 'SMALL' })

    expect(prisma.feature.update).not.toHaveBeenCalled()
  })

  it('records the selected complexity on the generated story', async () => {
    mockApplySuccess()

    await request(app)
      .post('/api/features/feat-1/apply-template')
      .set('Authorization', authHeader)
      .send({ templateId: 'tpl-1', complexity: 'LARGE' })

    expect(prisma.userStory.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ appliedTemplateId: 'tpl-1', appliedTemplateComplexity: 'LARGE' }),
    }))
  })

  it('rejects a complexity outside the supported tiers', async () => {
    mockApplySuccess()

    const res = await request(app)
      .post('/api/features/feat-1/apply-template')
      .set('Authorization', authHeader)
      .send({ templateId: 'tpl-1', complexity: 'HUGE' })

    expect(res.status).toBe(400)
    expect(prisma.userStory.create).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Refresh propagation
// ---------------------------------------------------------------------------

const storyTask = { id: 'st-1', name: 'Backend Auth', hoursEffort: 4, durationDays: 1, resourceTypeId: 'rt-1' }
const manualTask = { id: 'st-manual', name: 'Manual hardening', hoursEffort: 6, durationDays: 1, resourceTypeId: 'rt-1' }

function mockRefreshSuccess() {
  vi.mocked(prisma.userStory.findFirst).mockResolvedValue({
    ...mockStory,
    appliedTemplateId: 'tpl-1',
    tasks: [storyTask, manualTask],
  } as never)
  vi.mocked(prisma.featureTemplate.findUnique).mockResolvedValue({
    ...metadataTemplate,
    tasks: [
      { ...mockTask, order: 0, description: TASK_DESCRIPTION, assumptions: TASK_ASSUMPTIONS },
      { ...mockTask, id: 'ttask-2', name: 'Add MFA', order: 1, description: '<p>New task description</p>', assumptions: null },
    ],
  } as never)
  vi.mocked(prisma.feature.findUnique).mockResolvedValue({
    ...mockFeature,
    epic: { ...mockEpic, project: mockProject },
  } as never)
  vi.mocked(prisma.resourceType.findMany).mockResolvedValue([mockResourceType] as never)
  vi.mocked(prisma.userStory.update).mockResolvedValue(mockStory as never)
  vi.mocked(prisma.task.update).mockResolvedValue({} as never)
  vi.mocked(prisma.task.create).mockResolvedValue({} as never)
  vi.mocked(prisma.userStory.findUnique).mockResolvedValue({ ...mockStory, tasks: [] } as never)
}

describe('POST /api/features/:featureId/refresh-template/:storyId metadata propagation', () => {
  it('refreshes story metadata from the current template', async () => {
    mockRefreshSuccess()

    const res = await request(app)
      .post('/api/features/feat-1/refresh-template/story-new')
      .set('Authorization', authHeader)
      .send({ complexity: 'SMALL' })

    expect(res.status).toBe(200)
    expect(prisma.userStory.update).toHaveBeenCalledWith({
      where: { id: 'story-new' },
      data: { description: TEMPLATE_DESCRIPTION, assumptions: TEMPLATE_ASSUMPTIONS, appliedTemplateComplexity: 'SMALL' },
    })
  })

  it('refreshes metadata on name-matched tasks', async () => {
    mockRefreshSuccess()

    await request(app)
      .post('/api/features/feat-1/refresh-template/story-new')
      .set('Authorization', authHeader)
      .send({ complexity: 'SMALL' })

    expect(prisma.task.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: storyTask.id },
      data: expect.objectContaining({ description: TASK_DESCRIPTION, assumptions: TASK_ASSUMPTIONS }),
    }))
  })

  it('populates metadata on newly added template tasks', async () => {
    mockRefreshSuccess()

    const res = await request(app)
      .post('/api/features/feat-1/refresh-template/story-new')
      .set('Authorization', authHeader)
      .send({ complexity: 'SMALL' })

    expect(res.body.added).toBe(1)
    expect(prisma.task.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        name: 'Add MFA',
        description: '<p>New task description</p>',
        assumptions: null,
      }),
    }))
  })

  it('leaves manual tasks untouched', async () => {
    mockRefreshSuccess()

    const res = await request(app)
      .post('/api/features/feat-1/refresh-template/story-new')
      .set('Authorization', authHeader)
      .send({ complexity: 'SMALL' })

    expect(res.body.updated).toBe(1)
    expect(prisma.task.delete).not.toHaveBeenCalled()
    expect(prisma.task.update).not.toHaveBeenCalledWith(expect.objectContaining({ where: { id: manualTask.id } }))
  })

  it('persists the complexity chosen for the refresh', async () => {
    mockRefreshSuccess()

    await request(app)
      .post('/api/features/feat-1/refresh-template/story-new')
      .set('Authorization', authHeader)
      .send({ complexity: 'EXTRA_LARGE' })

    expect(prisma.userStory.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ appliedTemplateComplexity: 'EXTRA_LARGE' }),
    }))
  })

  it('rejects a complexity outside the supported tiers without writing', async () => {
    mockRefreshSuccess()

    const res = await request(app)
      .post('/api/features/feat-1/refresh-template/story-new')
      .set('Authorization', authHeader)
      .send({ complexity: 'medium' })

    expect(res.status).toBe(400)
    expect(prisma.userStory.update).not.toHaveBeenCalled()
    expect(prisma.task.update).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Snapshots
// ---------------------------------------------------------------------------

describe('POST /api/templates/:id/snapshots/:snapshotId/restore metadata', () => {
  beforeEach(() => {
    vi.mocked(prisma.featureTemplate.findUnique)
      .mockResolvedValueOnce(mockTemplate as never)   // captureSnapshot (before restore)
      .mockResolvedValueOnce(mockTemplate as never)   // final read
    vi.mocked(prisma.templateSnapshot.create).mockResolvedValue({} as never)
    vi.mocked(prisma.featureTemplate.update).mockResolvedValue(mockTemplate as never)
    vi.mocked(prisma.templateTask.deleteMany).mockResolvedValue({ count: 0 } as never)
    vi.mocked(prisma.templateTask.create).mockResolvedValue(mockTask as never)
  })

  const baseSnapshot = {
    name: 'Auth Feature',
    category: 'Security',
    tasks: [{ name: 'Backend Auth', order: 0, hoursExtraSmall: 0, hoursSmall: 4, hoursMedium: 8, hoursLarge: 16, hoursExtraLarge: 24, resourceTypeName: 'Developer' }],
  }

  it('round-trips template and task metadata', async () => {
    vi.mocked(prisma.templateSnapshot.findUnique).mockResolvedValue({
      id: 'snap-1',
      snapshot: {
        ...baseSnapshot,
        description: TEMPLATE_DESCRIPTION,
        assumptions: TEMPLATE_ASSUMPTIONS,
        tasks: [{ ...baseSnapshot.tasks[0], description: TASK_DESCRIPTION, assumptions: TASK_ASSUMPTIONS }],
      },
    } as never)

    const res = await request(app)
      .post('/api/templates/tpl-1/snapshots/snap-1/restore')
      .set('Authorization', authHeader)

    expect(res.status).toBe(200)
    expect(prisma.featureTemplate.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ assumptions: TEMPLATE_ASSUMPTIONS }),
    }))
    expect(prisma.templateTask.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ description: TASK_DESCRIPTION, assumptions: TASK_ASSUMPTIONS }),
    }))
  })

  it('restores a pre-metadata snapshot without failing and clears stale metadata', async () => {
    vi.mocked(prisma.templateSnapshot.findUnique).mockResolvedValue({
      id: 'snap-old',
      snapshot: { ...baseSnapshot, description: null },
    } as never)

    const res = await request(app)
      .post('/api/templates/tpl-1/snapshots/snap-old/restore')
      .set('Authorization', authHeader)

    expect(res.status).toBe(200)
    expect(prisma.featureTemplate.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ assumptions: null }),
    }))
    expect(prisma.templateTask.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ description: null, assumptions: null }),
    }))
  })
})

// ---------------------------------------------------------------------------
// CSV metadata
// ---------------------------------------------------------------------------

const METADATA_HEADERS = ['TemplateDescription', 'TemplateAssumptions', 'TaskDescription', 'TaskAssumptions']

describe('template CSV metadata', () => {
  it('includes the four metadata columns in the global export header', async () => {
    vi.mocked(prisma.featureTemplate.findMany).mockResolvedValue([])

    const res = await request(app)
      .get('/api/templates/export-csv')
      .set('Authorization', authHeader)

    const header = (res.text.split('\n')[0] ?? '').trim()
    for (const column of METADATA_HEADERS) {
      expect(header.split(',').includes(column)).toBe(true)
    }
  })

  it('exports template metadata for a template with no tasks', async () => {
    vi.mocked(prisma.featureTemplate.findMany).mockResolvedValue([{
      ...mockTemplate,
      description: TEMPLATE_DESCRIPTION,
      assumptions: TEMPLATE_ASSUMPTIONS,
      tasks: [],
    }] as never)

    const res = await request(app)
      .get('/api/templates/export-csv')
      .set('Authorization', authHeader)

    const parsed = parseTemplateCsv(res.text)
    expect(parsed).toHaveLength(1)
    expect(parsed[0].TemplateName).toBe('Auth Feature')
    expect(parsed[0].TemplateDescription).toBe(TEMPLATE_DESCRIPTION)
    expect(parsed[0].TemplateAssumptions).toBe(TEMPLATE_ASSUMPTIONS)
  })

  it('round-trips rich-text metadata containing commas and newlines', async () => {
    const richDescription = '<p>Scope, effort and risk</p>\n<p>Second, line</p>'
    vi.mocked(prisma.featureTemplate.findMany).mockResolvedValue([{
      ...mockTemplate,
      description: richDescription,
      assumptions: TEMPLATE_ASSUMPTIONS,
      tasks: [{ ...mockTask, description: richDescription, assumptions: TASK_ASSUMPTIONS }],
    }] as never)

    const res = await request(app)
      .get('/api/templates/export-csv')
      .set('Authorization', authHeader)

    const parsed = parseTemplateCsv(res.text)
    expect(parsed[0].TemplateDescription).toBe(richDescription)
    expect(parsed[0].TaskDescription).toBe(richDescription)
  })

  it('exports metadata on a single-template export', async () => {
    vi.mocked(prisma.featureTemplate.findUnique).mockResolvedValue({
      ...mockTemplate,
      description: TEMPLATE_DESCRIPTION,
      assumptions: TEMPLATE_ASSUMPTIONS,
      tasks: [{ ...mockTask, description: TASK_DESCRIPTION, assumptions: TASK_ASSUMPTIONS }],
    } as never)

    const res = await request(app)
      .get('/api/templates/tpl-1/export-csv')
      .set('Authorization', authHeader)

    const parsed = parseTemplateCsv(res.text)
    expect(parsed[0]).toMatchObject({
      TemplateDescription: TEMPLATE_DESCRIPTION,
      TemplateAssumptions: TEMPLATE_ASSUMPTIONS,
      TaskDescription: TASK_DESCRIPTION,
      TaskAssumptions: TASK_ASSUMPTIONS,
    })
  })

  it('imports metadata from the first row of each template', async () => {
    vi.mocked(prisma.featureTemplate.findMany).mockResolvedValue([])
    vi.mocked(prisma.featureTemplate.create).mockResolvedValue({ id: 'tpl-new' } as never)
    vi.mocked(prisma.templateTask.create).mockResolvedValue(mockTask as never)

    const csv = [
      serializeCsv([...TEMPLATE_CSV_HEADERS] as string[], [
        ['API', 'Engineering', 'Auth', 'Developer', '1', '2', '4', '8', '16', TEMPLATE_DESCRIPTION, TEMPLATE_ASSUMPTIONS, TASK_DESCRIPTION, TASK_ASSUMPTIONS],
        ['API', 'Engineering', 'MFA', 'Developer', '1', '2', '4', '8', '16', '<p>ignored</p>', '<p>ignored</p>', '', ''],
      ]),
    ].join('')

    const res = await request(app)
      .post('/api/templates/import-csv')
      .set('Authorization', authHeader)
      .send({ csv })

    expect(res.status).toBe(201)
    expect(prisma.featureTemplate.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ description: TEMPLATE_DESCRIPTION, assumptions: TEMPLATE_ASSUMPTIONS }),
    })
    expect(prisma.templateTask.create).toHaveBeenCalledTimes(2)
    expect(prisma.templateTask.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ name: 'Auth', description: TASK_DESCRIPTION, assumptions: TASK_ASSUMPTIONS }),
    }))
  })

  it('imports a metadata-only template with no tasks', async () => {
    vi.mocked(prisma.featureTemplate.findMany).mockResolvedValue([])
    vi.mocked(prisma.featureTemplate.create).mockResolvedValue({ id: 'tpl-new' } as never)

    const csv = serializeCsv([...TEMPLATE_CSV_HEADERS] as string[], [
      ['API', 'Engineering', '', '', '', '', '', '', '', TEMPLATE_DESCRIPTION, TEMPLATE_ASSUMPTIONS, '', ''],
    ])

    const res = await request(app)
      .post('/api/templates/import-csv')
      .set('Authorization', authHeader)
      .send({ csv })

    expect(res.status).toBe(201)
    expect(res.body.templatesCreated).toBe(1)
    expect(prisma.templateTask.create).not.toHaveBeenCalled()
    expect(prisma.featureTemplate.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ description: TEMPLATE_DESCRIPTION, assumptions: TEMPLATE_ASSUMPTIONS }),
    })
  })

  it('accepts a legacy 9-column template CSV and leaves metadata null', async () => {
    vi.mocked(prisma.featureTemplate.findMany).mockResolvedValue([])
    vi.mocked(prisma.featureTemplate.create).mockResolvedValue({ id: 'tpl-new' } as never)
    vi.mocked(prisma.templateTask.create).mockResolvedValue(mockTask as never)

    const legacyCsv = [
      'TemplateName,Category,TaskName,ResourceTypeName,HoursExtraSmall,HoursSmall,HoursMedium,HoursLarge,HoursExtraLarge',
      'API,Engineering,Auth,Developer,1,2,4,8,16',
    ].join('\n')

    const res = await request(app)
      .post('/api/templates/import-csv')
      .set('Authorization', authHeader)
      .send({ csv: legacyCsv })

    expect(res.status).toBe(201)
    expect(prisma.featureTemplate.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ description: null, assumptions: null }),
    })
    expect(prisma.templateTask.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ description: null, assumptions: null }),
    }))
  })
})
