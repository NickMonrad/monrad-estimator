import { describe, it, expect, vi, beforeEach } from 'vitest'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import fs from 'fs'
import { app } from '../index.js'
import { prisma } from '../lib/prisma.js'
import { renderScopeDocumentHtml } from '../lib/scopeDocumentRenderer.js'

process.env.JWT_SECRET = 'test-secret'

const userId = 'user-1'
const token = jwt.sign({ userId }, 'test-secret')
const authHeader = `Bearer ${token}`

const mockProject = { id: 'proj-1', ownerId: userId, name: 'Test Project' }

const generateBody = {
  type: 'scope',
  format: 'pdf',
  label: 'Scope Document v1',
  documentData: { sections: [] },
}

const mockDoc = {
  id: 'doc-1',
  projectId: 'proj-1',
  type: 'scope',
  format: 'pdf',
  label: 'Scope Document v1',
  filePath: 'proj-1-2025-01-01 00-00.pdf',
  sections: null,
  generatedById: userId,
  createdAt: new Date().toISOString(),
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(prisma.epic.findMany).mockResolvedValue([])
  vi.mocked(prisma.projectDependency.findMany).mockResolvedValue([])
  vi.mocked(prisma.projectRisk.findMany).mockResolvedValue([])
})

describe('POST /api/projects/:projectId/documents/generate', () => {
  it('returns 201 with the created document record on success', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue(mockProject as any)
    vi.mocked(prisma.generatedDocument.create).mockResolvedValue(mockDoc as any)

    // Stub the real fs calls so we don't touch the filesystem
    vi.spyOn(fs, 'mkdirSync').mockReturnValue(undefined as any)
    vi.spyOn(fs, 'writeFileSync').mockReturnValue(undefined)
    vi.spyOn(fs, 'existsSync').mockReturnValue(false)

    const res = await request(app)
      .post('/api/projects/proj-1/documents/generate')
      .set('Authorization', authHeader)
      .send(generateBody)

    expect(res.status).toBe(201)
    expect(res.body.id).toBe('doc-1')
    expect(res.body.label).toBe('Scope Document v1')
  })

  it.each([true, false])('renders persisted feature names when the parent epic is %s', async (isActive) => {
    const currentEpics = [{
      id: 'epic-1',
      name: 'Epic 1',
      isActive,
      features: [{
        id: 'feature-1',
        name: 'Renamed Feature',
        isActive: true,
        userStories: [],
      }],
    }]
    vi.mocked(prisma.project.findFirst).mockResolvedValue(mockProject as unknown as Awaited<ReturnType<typeof prisma.project.findFirst>>)
    vi.mocked(prisma.epic.findMany).mockResolvedValue(currentEpics as unknown as Awaited<ReturnType<typeof prisma.epic.findMany>>)
    vi.mocked(prisma.generatedDocument.create).mockResolvedValue(mockDoc as unknown as Awaited<ReturnType<typeof prisma.generatedDocument.create>>)
    vi.spyOn(fs, 'mkdirSync').mockImplementation(() => undefined)
    vi.spyOn(fs, 'writeFileSync').mockReturnValue(undefined)
    vi.spyOn(fs, 'existsSync').mockReturnValue(false)

    const res = await request(app)
      .post('/api/projects/proj-1/documents/generate')
      .set('Authorization', authHeader)
      .send({
        ...generateBody,
        documentData: {
          ...generateBody.documentData,
          epics: [{ id: 'epic-1', name: 'Epic 1', isActive, features: [{ id: 'feature-1', name: 'Old Feature', isActive: true, userStories: [] }] }],
        },
      })

    expect(res.status).toBe(201)
    const rendered = vi.mocked(renderScopeDocumentHtml).mock.calls[0][0]
    expect(rendered.epics[0].isActive).toBe(isActive)
    expect(rendered.epics[0].features[0].name).toBe('Renamed Feature')
  })
  it('canonicalizes stale hierarchy names in derived document data without changing values', async () => {
    const currentEpics = [{
      id: 'epic-1',
      name: 'Renamed Epic',
      isActive: true,
      features: [{ id: 'feature-1', name: 'Renamed Feature', isActive: true, userStories: [] }],
    }]
    const timelineEntry = {
      featureId: 'feature-1',
      featureName: 'Old Feature',
      epicId: 'epic-1',
      epicName: 'Old Epic',
      epicOrder: 0,
      featureOrder: 0,
      startWeek: 2,
      durationWeeks: 3,
      startDate: '2025-01-15T00:00:00.000Z',
      endDate: '2025-02-05T00:00:00.000Z',
      timelineColour: '#3b82f6',
    }
    const resourceFeature = {
      featureId: 'feature-1',
      featureName: 'Old Feature',
      hours: 8,
      days: 1,
      stories: [{ storyId: 'story-1', storyName: 'Story', hours: 8, days: 1 }],
    }
    const resourceEpic = {
      epicId: 'epic-1',
      epicName: 'Old Epic',
      hours: 8,
      days: 1,
      features: [resourceFeature],
    }
    const resourceRow = {
      resourceTypeId: 'rt-1',
      name: 'Developer',
      category: 'Engineering',
      totalHours: 8,
      totalDays: 1,
      epics: [resourceEpic],
      namedResources: [],
    }

    vi.mocked(prisma.project.findFirst).mockResolvedValue(mockProject as unknown as Awaited<ReturnType<typeof prisma.project.findFirst>>)
    vi.mocked(prisma.epic.findMany).mockResolvedValue(currentEpics as unknown as Awaited<ReturnType<typeof prisma.epic.findMany>>)
    vi.mocked(prisma.generatedDocument.create).mockResolvedValue(mockDoc as unknown as Awaited<ReturnType<typeof prisma.generatedDocument.create>>)
    vi.spyOn(fs, 'mkdirSync').mockImplementation(() => undefined)
    vi.spyOn(fs, 'writeFileSync').mockReturnValue(undefined)
    vi.spyOn(fs, 'existsSync').mockReturnValue(false)

    const res = await request(app)
      .post('/api/projects/proj-1/documents/generate')
      .set('Authorization', authHeader)
      .send({
        ...generateBody,
        documentData: {
          ...generateBody.documentData,
          epics: [{ id: 'epic-1', name: 'Old Epic', isActive: true, features: [{ id: 'feature-1', name: 'Old Feature', isActive: true, userStories: [] }] }],
          timelineData: {
            startDate: '2025-01-01',
            projectedEndDate: '2025-02-05',
            entries: [timelineEntry],
            bufferWeeks: 1,
            onboardingWeeks: 2,
          },
          resourceProfileData: {
            resourceRows: [resourceRow],
            overheadRows: [],
            summary: { totalHours: 8, totalDays: 1, hasCost: false },
          },
        },
      })

    expect(res.status).toBe(201)
    const rendered = vi.mocked(renderScopeDocumentHtml).mock.calls[0][0]
    expect(rendered.epics[0].name).toBe('Renamed Epic')
    expect(rendered.epics[0].features[0].name).toBe('Renamed Feature')
    expect(rendered.timelineData.entries).toEqual([{
      ...timelineEntry,
      epicName: 'Renamed Epic',
      featureName: 'Renamed Feature',
    }])
    expect(rendered.resourceProfileData.resourceRows).toEqual([{
      ...resourceRow,
      epics: [{
        ...resourceEpic,
        epicName: 'Renamed Epic',
        features: [{ ...resourceFeature, featureName: 'Renamed Feature' }],
      }],
    }])
    expect(JSON.stringify(rendered.timelineData)).not.toContain('Old Feature')
    expect(JSON.stringify(rendered.resourceProfileData)).not.toContain('Old Feature')
  })

  it('assembles persisted project dependencies, risks and active backlog assumptions for a new document', async () => {
    const currentEpics = [{
      id: 'epic-1',
      name: 'Active Epic',
      isActive: true,
      order: 0,
      assumptions: '<p>Client will provide API access.</p>',
      features: [{
        id: 'feature-1',
        name: 'Current Feature',
        isActive: true,
        order: 0,
        assumptions: '<p>client will provide   API access.</p><p>Feature-specific assumption.</p>',
        userStories: [],
      }],
    }, {
      id: 'epic-2',
      name: 'Out of scope Epic',
      isActive: false,
      order: 1,
      assumptions: '<p>Must not appear.</p>',
      features: [{
        id: 'feature-2',
        name: 'Out of scope Feature',
        isActive: true,
        order: 0,
        assumptions: '<p>Must not appear.</p>',
        userStories: [],
      }],
    }]
    vi.mocked(prisma.project.findFirst).mockResolvedValue(mockProject as unknown as Awaited<ReturnType<typeof prisma.project.findFirst>>)
    vi.mocked(prisma.epic.findMany).mockResolvedValue(currentEpics as unknown as Awaited<ReturnType<typeof prisma.epic.findMany>>)
    vi.mocked(prisma.projectDependency.findMany).mockResolvedValue([
      { id: 'dependency-1', projectId: 'proj-1', description: '<p>Dependency</p>', order: 0 },
    ] as unknown as Awaited<ReturnType<typeof prisma.projectDependency.findMany>>)
    vi.mocked(prisma.projectRisk.findMany).mockResolvedValue([
      { id: 'risk-1', projectId: 'proj-1', description: '<p>Risk</p>', mitigation: '<p>Response</p>', order: 0 },
    ] as unknown as Awaited<ReturnType<typeof prisma.projectRisk.findMany>>)
    vi.mocked(prisma.generatedDocument.create).mockResolvedValue(mockDoc as unknown as Awaited<ReturnType<typeof prisma.generatedDocument.create>>)
    vi.spyOn(fs, 'mkdirSync').mockImplementation(() => undefined)
    vi.spyOn(fs, 'writeFileSync').mockReturnValue(undefined)
    vi.spyOn(fs, 'existsSync').mockReturnValue(false)

    const res = await request(app)
      .post('/api/projects/proj-1/documents/generate')
      .set('Authorization', authHeader)
      .send({ ...generateBody, documentData: { ...generateBody.documentData, sections: { assumptions: true, dependencies: true, risks: true } } })

    expect(res.status).toBe(201)
    const rendered = vi.mocked(renderScopeDocumentHtml).mock.calls[0][0]
    expect(rendered.assumptions).toEqual([
      { label: 'Active Epic', text: '<p>Client will provide API access.</p>' },
      { label: 'Active Epic › Current Feature', text: '<p>Feature-specific assumption.</p>' },
    ])
    expect(rendered.dependencies).toEqual([{ id: 'dependency-1', projectId: 'proj-1', description: '<p>Dependency</p>', order: 0 }])
    expect(rendered.risks).toEqual([{ id: 'risk-1', projectId: 'proj-1', description: '<p>Risk</p>', mitigation: '<p>Response</p>', order: 0 }])
    expect(JSON.stringify({ assumptions: rendered.assumptions, dependencies: rendered.dependencies, risks: rendered.risks })).not.toContain('Must not appear')
  })

  it('creates a new document without mutating historical generated documents', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue(mockProject as unknown as Awaited<ReturnType<typeof prisma.project.findFirst>>)
    vi.mocked(prisma.generatedDocument.create).mockResolvedValue(mockDoc as unknown as Awaited<ReturnType<typeof prisma.generatedDocument.create>>)
    vi.spyOn(fs, 'mkdirSync').mockImplementation(() => undefined)
    vi.spyOn(fs, 'writeFileSync').mockReturnValue(undefined)
    vi.spyOn(fs, 'existsSync').mockReturnValue(false)

    const res = await request(app)
      .post('/api/projects/proj-1/documents/generate')
      .set('Authorization', authHeader)
      .send(generateBody)

    expect(res.status).toBe(201)
    expect(prisma.generatedDocument.create).toHaveBeenCalledOnce()
    expect(prisma.generatedDocument.update).not.toHaveBeenCalled()
    expect(prisma.generatedDocument.delete).not.toHaveBeenCalled()
  })

  it('returns 404 when the project does not exist or is not owned', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue(null)

    const res = await request(app)
      .post('/api/projects/proj-1/documents/generate')
      .set('Authorization', authHeader)
      .send(generateBody)

    expect(res.status).toBe(404)
  })

  it('returns 401 without an auth token', async () => {
    const res = await request(app)
      .post('/api/projects/proj-1/documents/generate')
      .send(generateBody)

    expect(res.status).toBe(401)
  })

  it('returns 400 when required fields are missing', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue(mockProject as any)

    const res = await request(app)
      .post('/api/projects/proj-1/documents/generate')
      .set('Authorization', authHeader)
      .send({ type: 'scope' }) // missing format, label, documentData

    expect(res.status).toBe(400)
  })

  it('returns 400 for an invalid format', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue(mockProject as any)

    const res = await request(app)
      .post('/api/projects/proj-1/documents/generate')
      .set('Authorization', authHeader)
      .send({ ...generateBody, format: 'exe' })

    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/invalid format/i)
  })

  describe('orphan file cleanup on DB failure', () => {
    it('calls fs.unlinkSync to remove the written file when prisma.generatedDocument.create throws', async () => {
      vi.mocked(prisma.project.findFirst).mockResolvedValue(mockProject as any)
      vi.mocked(prisma.generatedDocument.create).mockRejectedValue(new Error('DB insert failed'))

      const mkdirSpy = vi.spyOn(fs, 'mkdirSync').mockReturnValue(undefined as any)
      const writeSpy = vi.spyOn(fs, 'writeFileSync').mockReturnValue(undefined)
      // existsSync must return true so the cleanup branch is entered
      const existsSpy = vi.spyOn(fs, 'existsSync').mockReturnValue(true)
      const unlinkSpy = vi.spyOn(fs, 'unlinkSync').mockReturnValue(undefined)

      const res = await request(app)
        .post('/api/projects/proj-1/documents/generate')
        .set('Authorization', authHeader)
        .send(generateBody)

      // The route re-throws after cleanup, so the error handler returns 500
      expect(res.status).toBe(500)

      // File was written…
      expect(writeSpy).toHaveBeenCalledOnce()
      // …then existence was checked…
      expect(existsSpy).toHaveBeenCalledOnce()
      // …and the orphaned file was deleted
      expect(unlinkSpy).toHaveBeenCalledOnce()

      // The path passed to unlinkSync must match the path passed to writeFileSync
      const writtenPath = writeSpy.mock.calls[0][0] as string
      const unlinkedPath = unlinkSpy.mock.calls[0][0] as string
      expect(unlinkedPath).toBe(writtenPath)

      // Sanity: path should be scoped to the uploads directory and have a .pdf extension
      expect(unlinkedPath).toMatch(/proj-1.*\.pdf$/)

      mkdirSpy.mockRestore()
      writeSpy.mockRestore()
      existsSpy.mockRestore()
      unlinkSpy.mockRestore()
    })

    it('does NOT call fs.unlinkSync when the file was never written', async () => {
      vi.mocked(prisma.project.findFirst).mockResolvedValue(mockProject as any)

      // Make writeFileSync throw so writtenFilePath stays null
      vi.spyOn(fs, 'mkdirSync').mockReturnValue(undefined as any)
      vi.spyOn(fs, 'writeFileSync').mockImplementation(() => { throw new Error('disk full') })
      vi.spyOn(fs, 'existsSync').mockReturnValue(false)
      const unlinkSpy = vi.spyOn(fs, 'unlinkSync').mockReturnValue(undefined)

      const res = await request(app)
        .post('/api/projects/proj-1/documents/generate')
        .set('Authorization', authHeader)
        .send(generateBody)

      expect(res.status).toBe(500)
      expect(unlinkSpy).not.toHaveBeenCalled()

      vi.restoreAllMocks()
    })

    it('does NOT call fs.unlinkSync when existsSync returns false (file missing)', async () => {
      vi.mocked(prisma.project.findFirst).mockResolvedValue(mockProject as any)
      vi.mocked(prisma.generatedDocument.create).mockRejectedValue(new Error('DB insert failed'))

      vi.spyOn(fs, 'mkdirSync').mockReturnValue(undefined as any)
      vi.spyOn(fs, 'writeFileSync').mockReturnValue(undefined)
      // existsSync returns false → unlink should be skipped
      vi.spyOn(fs, 'existsSync').mockReturnValue(false)
      const unlinkSpy = vi.spyOn(fs, 'unlinkSync').mockReturnValue(undefined)

      const res = await request(app)
        .post('/api/projects/proj-1/documents/generate')
        .set('Authorization', authHeader)
        .send(generateBody)

      expect(res.status).toBe(500)
      expect(unlinkSpy).not.toHaveBeenCalled()

      vi.restoreAllMocks()
    })
  })
})

describe('GET /api/projects/:projectId/documents', () => {
  it('returns the list of documents for an owned project', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue(mockProject as any)
    vi.mocked(prisma.generatedDocument.findMany).mockResolvedValue([mockDoc] as any)

    const res = await request(app)
      .get('/api/projects/proj-1/documents')
      .set('Authorization', authHeader)

    expect(res.status).toBe(200)
    expect(res.body).toHaveLength(1)
    expect(res.body[0].id).toBe('doc-1')
  })

  it('returns 404 for an unowned project', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue(null)

    const res = await request(app)
      .get('/api/projects/proj-1/documents')
      .set('Authorization', authHeader)

    expect(res.status).toBe(404)
  })

  it('returns 401 without a token', async () => {
    const res = await request(app).get('/api/projects/proj-1/documents')
    expect(res.status).toBe(401)
  })
})
