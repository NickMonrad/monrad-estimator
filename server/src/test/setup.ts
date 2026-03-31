import { vi } from 'vitest'

// Mock Puppeteer-based PDF generator so tests don't need a real browser
vi.mock('../lib/pdfRenderer.js', () => ({
  generatePdfFromHtml: vi.fn().mockResolvedValue(Buffer.from('mock-pdf')),
}))

// Mock scope document renderer so tests don't need react-dom/server
vi.mock('../lib/scopeDocumentRenderer.js', () => ({
  renderScopeDocumentHtml: vi.fn().mockReturnValue('<html><body>mock</body></html>'),
}))

// Mock Prisma globally so tests don't need a real DB
vi.mock('../lib/prisma.js', () => ({
  prisma: {
    user: { findUnique: vi.fn(), create: vi.fn() },
    project: { findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn(), updateMany: vi.fn(), delete: vi.fn() },
    epic: { findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn(), count: vi.fn() },
    feature: { findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn(), count: vi.fn() },
    userStory: { findMany: vi.fn(), findFirst: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn(), count: vi.fn() },
    task: { findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn(), count: vi.fn() },
    resourceType: { findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn(), createMany: vi.fn(), update: vi.fn(), updateMany: vi.fn(), delete: vi.fn() },
    globalResourceType: { findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
    featureTemplate: { findMany: vi.fn(), findFirst: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
    templateTask: { findMany: vi.fn(), findFirst: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn(), deleteMany: vi.fn(), count: vi.fn() },
    templateSnapshot: { findMany: vi.fn(), findUnique: vi.fn(), create: vi.fn() },
    projectOverhead: { findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn(), deleteMany: vi.fn() },
    timelineEntry: { findFirst: vi.fn(), findMany: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn(), upsert: vi.fn(), delete: vi.fn(), deleteMany: vi.fn() },
    featureDependency: { findMany: vi.fn().mockResolvedValue([]), create: vi.fn(), delete: vi.fn() },
    storyDependency: { findMany: vi.fn().mockResolvedValue([]), create: vi.fn(), upsert: vi.fn().mockResolvedValue({}), delete: vi.fn(), deleteMany: vi.fn() },
    storyTimelineEntry: { findMany: vi.fn().mockResolvedValue([]), findFirst: vi.fn(), upsert: vi.fn().mockResolvedValue({}), deleteMany: vi.fn() },
    backlogSnapshot: { findFirst: vi.fn(), findMany: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
    namedResource: { findMany: vi.fn(), findFirst: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn(), deleteMany: vi.fn(), count: vi.fn() },
    rateCard: { findMany: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn(), deleteMany: vi.fn() },
    rateCardEntry: { findMany: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn(), deleteMany: vi.fn() },
    projectDiscount: { findMany: vi.fn(), findFirst: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn(), deleteMany: vi.fn() },
    documentTemplate: { findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn(), deleteMany: vi.fn() },
    generatedDocument: { findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn(), deleteMany: vi.fn() },
    passwordResetToken: {
      findUnique: vi.fn(),
      create: vi.fn(),
      deleteMany: vi.fn(),
      update: vi.fn(),
    },
    organisation: { findMany: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
    organisationMember: { findMany: vi.fn(), findUnique: vi.fn(), create: vi.fn(), delete: vi.fn(), update: vi.fn(), upsert: vi.fn(), count: vi.fn() },
    organisationInvite: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn(), deleteMany: vi.fn() },
    customer: { findMany: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn(), updateMany: vi.fn() },
    $transaction: vi.fn((fn: unknown) => typeof fn === 'function' ? (fn as (tx: unknown) => unknown)({
      rateCard: { findMany: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn(), updateMany: vi.fn() },
      rateCardEntry: { deleteMany: vi.fn() },
    }) : Promise.resolve(fn)),
  },
}))
