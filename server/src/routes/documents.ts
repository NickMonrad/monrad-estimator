import { Router, Response } from 'express'
import { asyncHandler } from '../lib/asyncHandler.js'
import { authenticate, AuthRequest } from '../middleware/auth.js'
import { prisma } from '../lib/prisma.js'
import { renderScopeDocumentHtml } from '../lib/scopeDocumentRenderer.js'
import { generatePdfFromHtml } from '../lib/pdfRenderer.js'
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

function formatExportTimestamp(tz?: string): string {
  const now = new Date()
  try {
    const parts = new Intl.DateTimeFormat('en-AU', {
      timeZone: tz || 'UTC',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(now)
    const get = (type: string) => parts.find(p => p.type === type)?.value ?? '00'
    return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}-${get('minute')}`
  } catch {
    return now.toISOString().slice(0, 16).replace('T', ' ').replace(':', '-').replace(':', '-')
  }
}

type CurrentEpic = {
  id: string
  name: string
  features: Array<{ id: string; name: string }>
}

type DocumentEntry = Record<string, unknown> & {
  epicId?: string
  epicName?: string
  featureId?: string
  featureName?: string
  features?: DocumentEntry[]
}

type DocumentData = Record<string, unknown> & {
  timelineData?: Record<string, unknown> & { entries?: DocumentEntry[] }
  resourceProfileData?: Record<string, unknown> & {
    resourceRows?: Array<Record<string, unknown> & { epics?: DocumentEntry[] }>
  }
}

function canonicalizeDocumentHierarchyNames(documentData: DocumentData, currentEpics: CurrentEpic[]): DocumentData {
  const epicNames = new Map(currentEpics.map(epic => [epic.id, epic.name]))
  const featureNames = new Map(currentEpics.flatMap(epic => epic.features.map(feature => [feature.id, feature.name] as const)))

  const withCurrentNames = (entry: DocumentEntry): DocumentEntry => {
    const canonicalEntry = { ...entry }
    if (entry.epicId && epicNames.has(entry.epicId)) canonicalEntry.epicName = epicNames.get(entry.epicId)
    if (entry.featureId && featureNames.has(entry.featureId)) canonicalEntry.featureName = featureNames.get(entry.featureId)
    return canonicalEntry
  }

  const timelineData = documentData.timelineData?.entries
    ? { ...documentData.timelineData, entries: documentData.timelineData.entries.map(withCurrentNames) }
    : documentData.timelineData
  const resourceProfileData = documentData.resourceProfileData?.resourceRows
    ? {
        ...documentData.resourceProfileData,
        resourceRows: documentData.resourceProfileData.resourceRows.map(row => ({
          ...row,
          epics: row.epics?.map(epic => ({
            ...withCurrentNames(epic),
            features: epic.features?.map(withCurrentNames),
          })),
        })),
      }
    : documentData.resourceProfileData

  return { ...documentData, timelineData, resourceProfileData }
}

// POST /api/projects/:projectId/documents/generate
// Body: { type: string, format: string, label: string, tz?: string, documentData: ScopeDocumentProps }
// Server renders HTML via React renderToStaticMarkup, then generates PDF via Puppeteer.
router.post('/generate', asyncHandler(async (req: AuthRequest, res: Response) => {
  const projectId = req.params.projectId as string
  const project = await ownedProject(projectId, req.userId!)
  if (!project) { res.status(404).json({ error: 'Project not found' }); return }

  const { type, format, label, tz, documentData } = req.body
  if (!type || !format || !label || !documentData) {
    res.status(400).json({ error: 'type, format, label and documentData are required' }); return
  }

  // #171: validate format against allowlist to prevent path traversal via extension
  const ALLOWED_FORMATS = ['pdf', 'docx']
  if (!ALLOWED_FORMATS.includes(format)) {
    res.status(400).json({ error: 'Invalid format' }); return
  }

  // Resolve hierarchy names from persistence at generation time rather than
  // trusting a potentially stale Documents-page query cache.
  const currentEpics = await prisma.epic.findMany({
    where: { projectId },
    orderBy: { order: 'asc' },
    include: {
      features: {
        orderBy: { order: 'asc' },
        include: { userStories: { orderBy: { order: 'asc' } } },
      },
    },
  })

  // Render HTML and generate PDF
  const canonicalDocumentData = canonicalizeDocumentHierarchyNames(documentData, currentEpics)
  const html = renderScopeDocumentHtml({ ...canonicalDocumentData, epics: currentEpics, tz } as unknown as Parameters<typeof renderScopeDocumentHtml>[0])
  const buffer = await generatePdfFromHtml(html)

  // Ensure output directory exists
  fs.mkdirSync(GENERATED_DIR, { recursive: true })

  const ts = formatExportTimestamp(tz)
  const filename = `${projectId}-${ts}.${format}`
  const filePath = path.join(GENERATED_DIR, filename)

  // #171: assert resolved path is within GENERATED_DIR to prevent path traversal
  if (!path.resolve(filePath).startsWith(path.resolve(GENERATED_DIR))) {
    res.status(400).json({ error: 'Invalid file path' }); return
  }

  // #176: wrap file write + DB insert so orphaned files are cleaned up on failure
  let writtenFilePath: string | null = null
  try {
    fs.writeFileSync(filePath, buffer)
    writtenFilePath = filePath

    const doc = await prisma.generatedDocument.create({
      data: {
        projectId,
        type,
        format,
        label,
        filePath: filename, // store relative filename only
        sections: documentData.sections ?? null,
        generatedById: req.userId!,
      },
    })

    res.status(201).json(doc)
  } catch (err) {
    // Clean up orphaned file if DB insert failed after write
    if (writtenFilePath && fs.existsSync(writtenFilePath)) {
      fs.unlinkSync(writtenFilePath)
    }
    throw err  // re-throw so asyncHandler/errorHandler catches it
  }
}))

// GET /api/projects/:projectId/documents
router.get('/', asyncHandler(async (req: AuthRequest, res: Response) => {
  const projectId = req.params.projectId as string
  const project = await ownedProject(projectId, req.userId!)
  if (!project) { res.status(404).json({ error: 'Project not found' }); return }

  const docs = await prisma.generatedDocument.findMany({
    where: { projectId },
    orderBy: { createdAt: 'desc' },
    include: { generatedBy: { select: { email: true } } },
  })
  res.json(docs)
}))

// GET /api/projects/:projectId/documents/:docId/download
router.get('/:docId/download', asyncHandler(async (req: AuthRequest, res: Response) => {
  const projectId = req.params.projectId as string
  const project = await ownedProject(projectId, req.userId!)
  if (!project) { res.status(404).json({ error: 'Project not found' }); return }

  const doc = await prisma.generatedDocument.findFirst({
    where: { id: req.params.docId as string, projectId },
  })
  if (!doc) { res.status(404).json({ error: 'Document not found' }); return }

  const filePath = path.join(GENERATED_DIR, doc.filePath)

  // #171: assert resolved path is within GENERATED_DIR to prevent path traversal via DB value
  if (!path.resolve(filePath).startsWith(path.resolve(GENERATED_DIR))) {
    res.status(400).json({ error: 'Invalid file path' }); return
  }

  if (!fs.existsSync(filePath)) { res.status(404).json({ error: 'File not found on disk' }); return }

  const contentTypes: Record<string, string> = {
    pdf: 'application/pdf',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  }
  const safeProject = project.name.replace(/[^a-z0-9\-_\s]/gi, '').trim()
  const safeLabel = doc.label.replace(/[^a-z0-9\-_\s]/gi, '').trim() || 'document'
  const downloadName = safeProject ? `${safeProject} - ${safeLabel}` : safeLabel
  res.setHeader('Content-Type', contentTypes[doc.format] ?? 'application/octet-stream')
  res.setHeader('Content-Disposition', `attachment; filename="${downloadName}.${doc.format}"`)
  res.sendFile(filePath)
}))

// DELETE /api/projects/:projectId/documents/:docId
router.delete('/:docId', asyncHandler(async (req: AuthRequest, res: Response) => {
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
}))

export default router
