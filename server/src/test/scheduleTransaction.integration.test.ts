/**
 * scheduleTransaction.integration.test.ts — Real PostgreSQL integration tests
 * for the focused transactional scheduling command (issue #387).
 *
 * Proves against the actual schema:
 *
 *   - A successful schedule writes the complete intended schedule and demand
 *     cache through the canonical command path.
 *   - An injected mid-transaction failure rolls back EVERY schedule-owned
 *     write: feature entries, story entries, weeklyDemandCache and the
 *     applicable project start-date change stay exactly as they were.
 *   - Manual feature/story overrides retain their pinned values and
 *     isManual flag across re-scheduling.
 *
 * All tests are skipped unless INTEGRATION_TEST=true. Follows the isolation
 * and cleanup pattern of planningReset.integration.test.ts.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '@prisma/client'

import { app } from '../app.js'
import { scheduleProject } from '../lib/scheduleProject.js'
// Override the global prisma mock so route handlers use real PostgreSQL.
vi.mock('../lib/prisma.js', async importOriginal => await importOriginal())

const runIntegration = process.env.INTEGRATION_TEST === 'true'
const describeIf = runIntegration ? describe : describe.skip

let prisma: PrismaClient
let userId: string
let token: string
let authHeader: string

beforeAll(async () => {
  if (!runIntegration) return
  prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
  })
  await prisma.$connect()

  const user = await prisma.user.create({
    data: {
      email: `schedule-tx-${Date.now()}@example.com`,
      name: 'Schedule Transaction Integration Test',
      password: '$2b$10$placeholder',
    },
  })
  userId = user.id
  token = jwt.sign({ userId, role: 'USER' }, process.env.JWT_SECRET!)
  authHeader = `Bearer ${token}`
})

afterAll(async () => {
  if (!runIntegration) return
  await prisma.storyTimelineEntry.deleteMany({ where: { project: { ownerId: userId } } })
  await prisma.timelineEntry.deleteMany({ where: { project: { ownerId: userId } } })
  await prisma.storyDependency.deleteMany({ where: { story: { feature: { epic: { project: { ownerId: userId } } } } } })
  await prisma.featureDependency.deleteMany({ where: { feature: { epic: { project: { ownerId: userId } } } } })
  await prisma.epicDependency.deleteMany({ where: { epic: { project: { ownerId: userId } } } })
  await prisma.task.deleteMany({ where: { userStory: { feature: { epic: { project: { ownerId: userId } } } } } })
  await prisma.userStory.deleteMany({ where: { feature: { epic: { project: { ownerId: userId } } } } })
  await prisma.feature.deleteMany({ where: { epic: { project: { ownerId: userId } } } })
  await prisma.epic.deleteMany({ where: { project: { ownerId: userId } } })
  await prisma.capacitySegment.deleteMany({ where: { capacityProfile: { project: { ownerId: userId } } } })
  await prisma.capacityProfile.deleteMany({ where: { project: { ownerId: userId } } })
  await prisma.namedResource.deleteMany({ where: { resourceType: { project: { ownerId: userId } } } })
  await prisma.resourceType.deleteMany({ where: { project: { ownerId: userId } } })
  await prisma.project.deleteMany({ where: { ownerId: userId } })
  await prisma.$disconnect()
})

// ─── Fixture builder ────────────────────────────────────────────────────────

interface ScheduleFixture {
  projectId: string
  rtId: string
  epicId: string
  featureId: string
  storyId: string
}

async function createSchedulableProject(): Promise<ScheduleFixture> {
  const project = await prisma.project.create({
    data: {
      name: `Schedule Tx ${Date.now()}`,
      hoursPerDay: 8,
      ownerId: userId,
      bufferWeeks: 0,
      onboardingWeeks: 0,
      startDate: new Date('2026-01-05T00:00:00.000Z'),
    },
  })
  const rt = await prisma.resourceType.create({
    data: { name: 'Developer', category: 'ENGINEERING', count: 1, hoursPerDay: 8, projectId: project.id },
  })
  // Profile-first capacity resolution (issue #418): a role without a
  // persisted profile fails closed, so the fixture carries one.
  await prisma.capacityProfile.create({
    data: {
      projectId: project.id,
      resourceTypeId: rt.id,
      namedResourceId: null,
      ownerKind: 'ROLE',
      planningBasis: 'DEMAND_FOLLOWING',
      source: 'FIXED',
      defaultPercent: 100,
    },
  })
  const epic = await prisma.epic.create({
    data: { name: 'Platform', projectId: project.id, order: 0 },
  })
  const feature = await prisma.feature.create({
    data: { name: 'Feature A', epicId: epic.id, order: 0 },
  })
  const story = await prisma.userStory.create({
    data: { name: 'Story A', featureId: feature.id, order: 0 },
  })
  await prisma.task.create({
    data: { name: 'Task A', userStoryId: story.id, hoursEffort: 40, resourceTypeId: rt.id },
  })
  return {
    projectId: project.id,
    rtId: rt.id,
    epicId: epic.id,
    featureId: feature.id,
    storyId: story.id,
  }
}

async function captureScheduleState(projectId: string) {
  const project = await prisma.project.findUniqueOrThrow({ where: { id: projectId } })
  const featureEntries = await prisma.timelineEntry.findMany({ where: { projectId }, orderBy: { featureId: 'asc' } })
  const storyEntries = await prisma.storyTimelineEntry.findMany({ where: { projectId }, orderBy: { storyId: 'asc' } })
  return {
    startDate: project.startDate,
    weeklyDemandCache: project.weeklyDemandCache as Record<string, number> | null,
    featureEntries,
    storyEntries,
  }
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describeIf('transactional scheduling command (issue #387)', () => {
  it('successfully schedules and writes the complete intended schedule and cache', async () => {
    const f = await createSchedulableProject()

    const res = await request(app)
      .post(`/api/projects/${f.projectId}/timeline/schedule`)
      .set('Authorization', authHeader)
      .send({ startDate: '2026-03-01T00:00:00.000Z', resourceLevel: true })

    expect(res.status).toBe(200)
    expect(res.body.entries).toHaveLength(1)
    expect(res.body.entries[0].featureId).toBe(f.featureId)

    const state = await captureScheduleState(f.projectId)
    // Feature + story entries persisted
    expect(state.featureEntries).toHaveLength(1)
    expect(state.featureEntries[0].featureId).toBe(f.featureId)
    expect(state.storyEntries).toHaveLength(1)
    expect(state.storyEntries[0].storyId).toBe(f.storyId)
    // Levelled run writes a non-empty weekly demand cache
    expect(state.weeklyDemandCache).not.toBeNull()
    expect(Object.keys(state.weeklyDemandCache ?? {}).length).toBeGreaterThan(0)
    // Applicable project start-date change persisted
    expect(state.startDate).toEqual(new Date('2026-03-01T00:00:00.000Z'))
  })

  it('rolls back every schedule write when persistence fails mid-transaction', async () => {
    const f = await createSchedulableProject()
    // Seed a prior persisted schedule (startWeek 5 for the feature).
    await prisma.timelineEntry.create({
      data: { projectId: f.projectId, featureId: f.featureId, startWeek: 5, durationWeeks: 3, isManual: false },
    })
    await prisma.storyTimelineEntry.create({
      data: { projectId: f.projectId, storyId: f.storyId, startWeek: 5, durationWeeks: 2, isManual: false },
    })
    await prisma.project.update({
      where: { id: f.projectId },
      data: { weeklyDemandCache: { [`${f.rtId}|0`]: 9 }, startDate: new Date('2026-02-01T00:00:00.000Z') },
    })
    const before = await captureScheduleState(f.projectId)

    await expect(
      scheduleProject(
        { projectId: f.projectId, userId, startDate: '2026-04-01T00:00:00.000Z', resourceLevel: false },
        { afterWrites: async () => { throw new Error('injected mid-transaction failure') } },
      ),
    ).rejects.toThrow('injected mid-transaction failure')

    const after = await captureScheduleState(f.projectId)
    // Zero partial schedule update: every schedule-owned write is intact.
    expect(after.featureEntries).toEqual(before.featureEntries)
    expect(after.storyEntries).toEqual(before.storyEntries)
    expect(after.weeklyDemandCache).toEqual(before.weeklyDemandCache)
    expect(after.startDate).toEqual(before.startDate)
  })

  it('preserves manual feature overrides across re-scheduling', async () => {
    const f = await createSchedulableProject()
    // User pinned the feature to week 5 manually.
    await prisma.timelineEntry.create({
      data: { projectId: f.projectId, featureId: f.featureId, startWeek: 5, durationWeeks: 2, isManual: true },
    })
    await prisma.storyTimelineEntry.create({
      data: { projectId: f.projectId, storyId: f.storyId, startWeek: 5, durationWeeks: 1, isManual: true },
    })

    const res = await request(app)
      .post(`/api/projects/${f.projectId}/timeline/schedule`)
      .set('Authorization', authHeader)
      .send({})

    expect(res.status).toBe(200)
    const entry = res.body.entries.find((e: { featureId: string }) => e.featureId === f.featureId)
    expect(entry).toBeDefined()
    // The manual pin survives with its pinned values and isManual=true.
    expect(entry.startWeek).toBe(5)
    expect(entry.isManual).toBe(true)

    const state = await captureScheduleState(f.projectId)
    const persisted = state.featureEntries.find(e => e.featureId === f.featureId)
    expect(persisted?.startWeek).toBe(5)
    expect(persisted?.isManual).toBe(true)
    const persistedStory = state.storyEntries.find(e => e.storyId === f.storyId)
    expect(persistedStory?.startWeek).toBe(5)
    expect(persistedStory?.isManual).toBe(true)
  })
})
