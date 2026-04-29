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
    projectOverhead: { findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn(), deleteMany: vi.fn(), createMany: vi.fn() },
    timelineEntry: { findFirst: vi.fn(), findMany: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn(), upsert: vi.fn(), delete: vi.fn(), deleteMany: vi.fn(), createMany: vi.fn() },
    epicDependency: { findMany: vi.fn().mockResolvedValue([]), findUnique: vi.fn().mockResolvedValue(null), create: vi.fn(), delete: vi.fn(), deleteMany: vi.fn(), createMany: vi.fn() },
    featureDependency: { findMany: vi.fn().mockResolvedValue([]), create: vi.fn(), delete: vi.fn(), deleteMany: vi.fn(), createMany: vi.fn() },
    storyDependency: { findMany: vi.fn().mockResolvedValue([]), create: vi.fn(), upsert: vi.fn().mockResolvedValue({}), delete: vi.fn(), deleteMany: vi.fn() },
    storyTimelineEntry: { findMany: vi.fn().mockResolvedValue([]), findFirst: vi.fn(), upsert: vi.fn().mockResolvedValue({}), deleteMany: vi.fn(), createMany: vi.fn() },
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
      epic: { deleteMany: vi.fn(), create: vi.fn().mockResolvedValue({ id: 'epic-id' }) },
      feature: { create: vi.fn().mockResolvedValue({ id: 'feature-id' }) },
      userStory: { create: vi.fn().mockResolvedValue({ id: 'story-id' }) },
      task: { create: vi.fn() },
      project: { update: vi.fn() },
      resourceType: { findUnique: vi.fn().mockResolvedValue(null), update: vi.fn(), create: vi.fn(), upsert: vi.fn() },
      namedResource: { findUnique: vi.fn().mockResolvedValue(null), update: vi.fn(), updateMany: vi.fn(), create: vi.fn(), upsert: vi.fn() },
      timelineEntry: { deleteMany: vi.fn(), createMany: vi.fn() },
      storyTimelineEntry: { deleteMany: vi.fn(), createMany: vi.fn() },
      epicDependency: { deleteMany: vi.fn(), createMany: vi.fn() },
      featureDependency: { deleteMany: vi.fn(), createMany: vi.fn() },
      projectOverhead: { deleteMany: vi.fn(), createMany: vi.fn() },
    }) : Promise.resolve(fn)),
  },
}))
