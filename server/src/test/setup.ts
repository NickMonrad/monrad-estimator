import { vi } from 'vitest'

// Mock Prisma globally so tests don't need a real DB
vi.mock('../lib/prisma.js', () => ({
  prisma: {
    user: { findUnique: vi.fn(), create: vi.fn() },
    project: { findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
    epic: { findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn(), count: vi.fn() },
    feature: { findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
    userStory: { findMany: vi.fn(), findFirst: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
    task: { findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
    resourceType: { findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn(), createMany: vi.fn(), update: vi.fn(), updateMany: vi.fn(), delete: vi.fn() },
    globalResourceType: { findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
    featureTemplate: { findMany: vi.fn(), findFirst: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
    templateTask: { findMany: vi.fn(), findFirst: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn(), count: vi.fn() },
    timelineEntry: { findFirst: vi.fn(), findMany: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn(), upsert: vi.fn(), delete: vi.fn(), deleteMany: vi.fn() },
    featureDependency: { findMany: vi.fn().mockResolvedValue([]), create: vi.fn(), delete: vi.fn() },
    storyDependency: { findMany: vi.fn().mockResolvedValue([]), create: vi.fn(), upsert: vi.fn().mockResolvedValue({}), delete: vi.fn(), deleteMany: vi.fn() },
    storyTimelineEntry: { findMany: vi.fn().mockResolvedValue([]), findFirst: vi.fn(), upsert: vi.fn().mockResolvedValue({}), deleteMany: vi.fn() },
    backlogSnapshot: { findFirst: vi.fn(), findMany: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
  },
}))
