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
vi.mock('../lib/prisma.js', () => {
  const capacityProfileMocks = { findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn(), deleteMany: vi.fn() }
  const capacitySegmentMocks = { findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn(), deleteMany: vi.fn() }
  return {
    prisma: {
      user: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn(), count: vi.fn() },
      project: { findMany: vi.fn(), findFirst: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn(), updateMany: vi.fn(), delete: vi.fn() },
      epic: { findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn(), count: vi.fn() },
      feature: { findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn(), count: vi.fn() },
      userStory: { findMany: vi.fn(), findFirst: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn(), count: vi.fn() },
      task: { findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn(), count: vi.fn() },
      resourceType: { findUnique: vi.fn(), findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn(), createMany: vi.fn(), update: vi.fn(), updateMany: vi.fn(), delete: vi.fn(), deleteMany: vi.fn() },
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
      backlogSnapshot: { findFirst: vi.fn(), findMany: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn(), deleteMany: vi.fn() },
      namedResource: { findMany: vi.fn(), findFirst: vi.fn(), findUnique: vi.fn(), create: vi.fn(), createMany: vi.fn(), update: vi.fn(), updateMany: vi.fn(), delete: vi.fn(), deleteMany: vi.fn(), count: vi.fn() },
      rateCard: { findMany: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn(), deleteMany: vi.fn() },
      rateCardEntry: { findMany: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn(), deleteMany: vi.fn() },
      projectDiscount: { findMany: vi.fn(), findFirst: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn(), deleteMany: vi.fn() },
      projectDependency: { findMany: vi.fn(), findFirst: vi.fn(), count: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
      projectRisk: { findMany: vi.fn(), findFirst: vi.fn(), count: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
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
      capacityPlan: { findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn(), updateMany: vi.fn() },
      capacityPlanPeriod: { findMany: vi.fn(), create: vi.fn(), deleteMany: vi.fn() },
      capacityPlanEntry: { findMany: vi.fn(), create: vi.fn(), deleteMany: vi.fn() },
      capacityProfile: capacityProfileMocks,
      capacitySegment: capacitySegmentMocks,
      $transaction: vi.fn((fn: unknown) => typeof fn === 'function' ? (fn as (tx: unknown) => unknown)({
        $queryRawUnsafe: vi.fn().mockResolvedValue([{ pg_advisory_xact_lock: null }]),
        user: { count: vi.fn(), findUnique: vi.fn(), create: vi.fn() },
        rateCard: { findMany: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn(), updateMany: vi.fn() },
        rateCardEntry: { deleteMany: vi.fn() },
        epic: { findFirst: vi.fn(), updateMany: vi.fn(), deleteMany: vi.fn(), create: vi.fn().mockResolvedValue({ id: 'epic-id' }) },
        feature: { findFirst: vi.fn(), updateMany: vi.fn(), create: vi.fn().mockResolvedValue({ id: 'feature-id' }) },
        userStory: { findFirst: vi.fn(), updateMany: vi.fn(), create: vi.fn().mockResolvedValue({ id: 'story-id' }) },
        task: { findFirst: vi.fn(), updateMany: vi.fn(), create: vi.fn() },
        project: { update: vi.fn() },
        resourceType: { findUnique: vi.fn().mockResolvedValue(null), findMany: vi.fn().mockResolvedValue([]), update: vi.fn(), create: vi.fn(), upsert: vi.fn() },
        namedResource: { findUnique: vi.fn().mockResolvedValue(null), findMany: vi.fn(), update: vi.fn(), updateMany: vi.fn(), create: vi.fn(), upsert: vi.fn(), delete: vi.fn(), count: vi.fn() },
        timelineEntry: { deleteMany: vi.fn(), createMany: vi.fn(), upsert: vi.fn() },
        storyTimelineEntry: { deleteMany: vi.fn(), createMany: vi.fn(), upsert: vi.fn() },
        epicDependency: { deleteMany: vi.fn(), createMany: vi.fn() },
        featureDependency: { deleteMany: vi.fn(), createMany: vi.fn() },
        projectOverhead: { deleteMany: vi.fn(), createMany: vi.fn() },
        projectDependency: { update: vi.fn() },
        projectRisk: { update: vi.fn() },
        backlogSnapshot: { create: vi.fn(), findMany: vi.fn(), deleteMany: vi.fn() },
        capacityProfile: capacityProfileMocks,
        capacitySegment: capacitySegmentMocks,
      }) : Promise.resolve(fn)),
    },
  }
})

