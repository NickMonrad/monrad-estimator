import { Router, Response } from 'express'
import { authenticate, AuthRequest } from '../middleware/auth.js'
import { prisma } from '../lib/prisma.js'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const GENERATED_DIR = path.join(__dirname, '../../uploads/generated')

const router = Router({ mergeParams: true })
router.use(authenticate)

async function ownedProject(projectId: string, userId: string) {
  return prisma.project.findFirst({ where: { id: projectId, ownerId: userId } })
}

// POST /api/projects/:projectId/documents/generate
// Body: { type: 'SCOPE_DOC', format: 'pdf', label: string, sections: string[], pdfBase64: string }
// The client renders the PDF via @react-pdf/renderer and sends the base64-encoded PDF bytes.
// Server saves to disk and records in DB.
router.post('/generate', async (req: AuthRequest, res: Response) => {
  const projectId = req.params.projectId as string
  const project = await ownedProject(projectId, req.userId!)
  if (!project) { res.status(404).json({ error: 'Project not found' }); return }

  const { type, format, label, pdfBase64 } = req.body
  if (!type || !format || !label || !pdfBase64) {
    res.status(400).json({ error: 'type, format, label and pdfBase64 are required' }); return
  }

  // Ensure output directory exists
  fs.mkdirSync(GENERATED_DIR, { recursive: true })

  const filename = `${projectId}-${Date.now()}.${format}`
  const filePath = path.join(GENERATED_DIR, filename)
  const buffer = Buffer.from(pdfBase64, 'base64')
  fs.writeFileSync(filePath, buffer)

  const doc = await prisma.generatedDocument.create({
    data: {
      projectId,
      type,
      format,
      label,
      filePath: filename, // store relative filename only
      generatedById: req.userId!,
    },
  })

  res.status(201).json(doc)
})

// GET /api/projects/:projectId/documents
router.get('/', async (req: AuthRequest, res: Response) => {
  const projectId = req.params.projectId as string
  const project = await ownedProject(projectId, req.userId!)
  if (!project) { res.status(404).json({ error: 'Project not found' }); return }

  const docs = await prisma.generatedDocument.findMany({
    where: { projectId },
    orderBy: { createdAt: 'desc' },
    include: { generatedBy: { select: { email: true } } },
  })
  res.json(docs)
})

// GET /api/projects/:projectId/documents/:docId/download
router.get('/:docId/download', async (req: AuthRequest, res: Response) => {
  const projectId = req.params.projectId as string
  const project = await ownedProject(projectId, req.userId!)
  if (!project) { res.status(404).json({ error: 'Project not found' }); return }

  const doc = await prisma.generatedDocument.findFirst({
    where: { id: req.params.docId as string, projectId },
  })
  if (!doc) { res.status(404).json({ error: 'Document not found' }); return }

  const filePath = path.join(GENERATED_DIR, doc.filePath)
  if (!fs.existsSync(filePath)) { res.status(404).json({ error: 'File not found on disk' }); return }

  const contentTypes: Record<string, string> = {
    pdf: 'application/pdf',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  }
  const safeLabel = doc.label.replace(/[^a-z0-9\-_\s]/gi, '').trim() || 'document'
  res.setHeader('Content-Type', contentTypes[doc.format] ?? 'application/octet-stream')
  res.setHeader('Content-Disposition', `attachment; filename="${safeLabel}.${doc.format}"`)
  res.sendFile(filePath)
})

// DELETE /api/projects/:projectId/documents/:docId
router.delete('/:docId', async (req: AuthRequest, res: Response) => {
  const projectId = req.params.projectId as string
  const project = await ownedProject(projectId, req.userId!)
  if (!project) { res.status(404).json({ error: 'Project not found' }); return }

  const doc = await prisma.generatedDocument.findFirst({ where: { id: req.params.docId as string, projectId } })
  if (!doc) { res.status(404).json({ error: 'Document not found' }); return }

  // Delete file from disk
  const filePath = path.join(GENERATED_DIR, doc.filePath)
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath)

  await prisma.generatedDocument.delete({ where: { id: doc.id } })
  res.json({ success: true })
})

export default router
