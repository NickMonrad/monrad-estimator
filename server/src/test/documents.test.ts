import { describe, it, expect, vi, beforeEach } from 'vitest'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import fs from 'fs'
import { app } from '../index.js'
import { prisma } from '../lib/prisma.js'

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

beforeEach(() => vi.clearAllMocks())

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
