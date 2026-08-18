import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '@prisma/client'
import { app } from '../app.js'

vi.mock('../lib/prisma.js', async importOriginal => importOriginal())

const runIntegration = process.env.INTEGRATION_TEST === 'true'
const describeIf = runIntegration ? describe : describe.skip

interface Fixture {
  projectId: string
  resourceTypeId: string
  templateId: string
  epicId: string
  siblingEpicId: string
  featureId: string
  siblingFeatureId: string
  storyId: string
  siblingStoryId: string
  taskId: string
  siblingTaskId: string
}

type ExcludedCounts = {
  timeline: number
  storyTimeline: number
  epicDependencies: number
  featureDependencies: number
  storyDependencies: number
  snapshots: number
  overheads: number
  discounts: number
  capacityPlans: number
}

let prisma: PrismaClient
let userId: string
let authHeader: string
let templateId: string
const projectIds: string[] = []

beforeAll(async () => {
  if (!runIntegration) return
  prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) })
  await prisma.$connect()
  const user = await prisma.user.create({
    data: {
      email: `backlog-duplication-${Date.now()}@example.com`,
      name: 'Backlog duplication integration',
      password: '$2b$10$placeholder',
    },
  })
  userId = user.id
  authHeader = `Bearer ${jwt.sign({ userId, role: 'USER' }, process.env.JWT_SECRET!)}`
  const template = await prisma.featureTemplate.create({ data: { name: `Duplication template ${Date.now()}` } })
  templateId = template.id
})

afterAll(async () => {
  if (!runIntegration) return
  await prisma.project.deleteMany({ where: { id: { in: projectIds } } })
  if (templateId) await prisma.featureTemplate.delete({ where: { id: templateId } })
  if (userId) await prisma.user.delete({ where: { id: userId } })
  await prisma.$disconnect()
})

async function createFixture(): Promise<Fixture> {
  const project = await prisma.project.create({
    data: { name: `Duplication project ${Date.now()}-${Math.random()}`, ownerId: userId, weeklyDemandCache: { before: true } },
  })
  projectIds.push(project.id)

  const resourceType = await prisma.resourceType.create({
    data: { name: 'Developer', category: 'ENGINEERING', projectId: project.id, count: 1 },
  })
  const epic = await prisma.epic.create({
    data: {
      name: 'Source epic', description: 'epic description', assumptions: 'epic assumptions', order: 0,
      featureMode: 'parallel', scheduleMode: 'parallel', timelineStartWeek: 4, isActive: false, projectId: project.id,
    },
  })
  const siblingEpic = await prisma.epic.create({ data: { name: 'Unrelated epic', order: 1, projectId: project.id } })
  const feature = await prisma.feature.create({
    data: {
      name: 'Source feature', description: 'feature description', assumptions: 'feature assumptions', order: 0,
      featureMode: 'parallel', timelineColour: '#123456', timelineStartWeek: 3, isActive: false, epicId: epic.id,
    },
  })
  const siblingFeature = await prisma.feature.create({ data: { name: 'Unrelated feature', order: 1, epicId: epic.id } })
  const story = await prisma.userStory.create({
    data: {
      name: 'Source story', description: 'story description', assumptions: 'story assumptions', order: 0,
      isActive: false, appliedTemplateId: templateId, featureId: feature.id,
    },
  })
  const siblingStory = await prisma.userStory.create({ data: { name: 'Unrelated story', order: 1, featureId: feature.id } })
  const task = await prisma.task.create({
    data: {
      name: 'Source task', description: 'task description', assumptions: 'task assumptions', hoursEffort: 12.5,
      durationDays: null, order: 0, resourceTypeId: resourceType.id, userStoryId: story.id,
    },
  })
  const siblingTask = await prisma.task.create({
    data: { name: 'Unrelated task', hoursEffort: 2, durationDays: 1, order: 1, resourceTypeId: null, userStoryId: story.id },
  })

  await prisma.timelineEntry.create({ data: { projectId: project.id, featureId: feature.id, startWeek: 2, durationWeeks: 4, isManual: true } })
  await prisma.storyTimelineEntry.create({ data: { projectId: project.id, storyId: story.id, startWeek: 1, durationWeeks: 2, isManual: true } })
  await prisma.epicDependency.create({ data: { epicId: epic.id, dependsOnId: siblingEpic.id } })
  await prisma.featureDependency.create({ data: { featureId: feature.id, dependsOnId: siblingFeature.id } })
  await prisma.storyDependency.create({ data: { storyId: story.id, dependsOnId: siblingStory.id } })
  await prisma.projectOverhead.create({ data: { projectId: project.id, name: 'Governance', type: 'FIXED_DAYS', value: 1, order: 0, resourceTypeId: resourceType.id } })
  await prisma.projectDiscount.create({ data: { projectId: project.id, type: 'PERCENTAGE', value: 5, label: 'Integration discount', order: 0, resourceTypeId: resourceType.id } })
  await prisma.backlogSnapshot.create({ data: { projectId: project.id, createdById: userId, trigger: 'manual', snapshot: { source: true } } })
  await prisma.capacityPlan.create({ data: { projectId: project.id, name: 'Unrelated capacity plan', targetWeeks: 12, periodWeeks: 4 } })

  return {
    projectId: project.id,
    resourceTypeId: resourceType.id,
    templateId,
    epicId: epic.id,
    siblingEpicId: siblingEpic.id,
    featureId: feature.id,
    siblingFeatureId: siblingFeature.id,
    storyId: story.id,
    siblingStoryId: siblingStory.id,
    taskId: task.id,
    siblingTaskId: siblingTask.id,
  }
}

async function excludedCounts(projectId: string): Promise<ExcludedCounts> {
  const [timeline, storyTimeline, epicDependencies, featureDependencies, storyDependencies, snapshots, overheads, discounts, capacityPlans] = await Promise.all([
    prisma.timelineEntry.count({ where: { projectId } }),
    prisma.storyTimelineEntry.count({ where: { projectId } }),
    prisma.epicDependency.count({ where: { epic: { projectId } } }),
    prisma.featureDependency.count({ where: { feature: { epic: { projectId } } } }),
    prisma.storyDependency.count({ where: { story: { feature: { epic: { projectId } } } } }),
    prisma.backlogSnapshot.count({ where: { projectId } }),
    prisma.projectOverhead.count({ where: { projectId } }),
    prisma.projectDiscount.count({ where: { projectId } }),
    prisma.capacityPlan.count({ where: { projectId } }),
  ])
  return { timeline, storyTimeline, epicDependencies, featureDependencies, storyDependencies, snapshots, overheads, discounts, capacityPlans }
}

async function duplicate(projectId: string, type: 'epic' | 'feature' | 'story' | 'task', id: string) {
  return request(app)
    .post(`/api/projects/${projectId}/backlog/duplicate`)
    .set('Authorization', authHeader)
    .send({ type, id })
}

describeIf('backlog subtree duplication PostgreSQL integration', () => {
  it('persists all four duplicate levels with independent descendants and no excluded state', async () => {
    const fixture = await createFixture()
    const countsBefore = await excludedCounts(fixture.projectId)
    const sourceEpicBefore = await prisma.epic.findUnique({ where: { id: fixture.epicId } })
    const sourceFeatureBefore = await prisma.feature.findUnique({ where: { id: fixture.featureId } })
    const sourceStoryBefore = await prisma.userStory.findUnique({ where: { id: fixture.storyId } })
    const sourceTaskBefore = await prisma.task.findUnique({ where: { id: fixture.taskId } })
    const projectBefore = await prisma.project.findUnique({ where: { id: fixture.projectId } })

    const taskResponse = await duplicate(fixture.projectId, 'task', fixture.taskId)
    expect(taskResponse.status).toBe(201)
    const taskCopyId = taskResponse.body.id as string
    const taskCopy = await prisma.task.findUnique({ where: { id: taskCopyId } })
    expect(taskCopy).toMatchObject({ name: 'Copy of Source task', userStoryId: fixture.storyId, resourceTypeId: fixture.resourceTypeId, hoursEffort: 12.5, durationDays: null })
    expect(taskCopy?.id).not.toBe(fixture.taskId)

    const storyResponse = await duplicate(fixture.projectId, 'story', fixture.storyId)
    expect(storyResponse.status).toBe(201)
    const storyCopy = await prisma.userStory.findUnique({ where: { id: storyResponse.body.id }, include: { tasks: true } })
    expect(storyCopy).toMatchObject({ name: 'Copy of Source story', featureId: fixture.featureId, description: 'story description', assumptions: 'story assumptions', isActive: false, appliedTemplateId: fixture.templateId })
    expect(storyCopy?.tasks).toHaveLength(3)
    expect(storyCopy?.tasks.every(task => task.userStoryId === storyCopy.id)).toBe(true)
    expect(storyCopy?.tasks.some(task => task.id === fixture.taskId)).toBe(false)

    const featureResponse = await duplicate(fixture.projectId, 'feature', fixture.featureId)
    expect(featureResponse.status).toBe(201)
    const featureCopy = await prisma.feature.findUnique({ where: { id: featureResponse.body.id }, include: { userStories: { include: { tasks: true } } } })
    expect(featureCopy).toMatchObject({ name: 'Copy of Source feature', epicId: fixture.epicId, description: 'feature description', assumptions: 'feature assumptions', featureMode: 'parallel', timelineColour: '#123456', isActive: false })
    expect(featureCopy?.timelineStartWeek).toBeNull()
    expect(featureCopy?.userStories.every(story => story.featureId === featureCopy.id)).toBe(true)

    const epicResponse = await duplicate(fixture.projectId, 'epic', fixture.epicId)
    expect(epicResponse.status).toBe(201)
    const epicCopy = await prisma.epic.findUnique({ where: { id: epicResponse.body.id }, include: { features: { include: { userStories: { include: { tasks: true } } } } } })
    expect(epicCopy).toMatchObject({ name: 'Copy of Source epic', projectId: fixture.projectId, description: 'epic description', assumptions: 'epic assumptions', featureMode: 'parallel', scheduleMode: 'parallel', isActive: false })
    expect(epicCopy?.timelineStartWeek).toBeNull()
    expect(epicCopy?.features).toHaveLength(3)
    expect(epicCopy?.features.every(feature => feature.epicId === epicCopy.id)).toBe(true)
    expect(epicCopy?.features.flatMap(feature => feature.userStories).every(story => story.featureId !== fixture.featureId)).toBe(true)
    expect(epicCopy?.features.flatMap(feature => feature.userStories).flatMap(story => story.tasks).every(task => task.resourceTypeId === fixture.resourceTypeId || task.resourceTypeId === null)).toBe(true)

    const countsAfter = await excludedCounts(fixture.projectId)
    expect(countsAfter).toEqual(countsBefore)
    const projectAfter = await prisma.project.findUnique({ where: { id: fixture.projectId } })
    expect(projectAfter?.weeklyDemandCache).toEqual(projectBefore?.weeklyDemandCache)
    expect(await prisma.epic.findUnique({ where: { id: fixture.epicId } })).toMatchObject({
      name: sourceEpicBefore?.name, description: sourceEpicBefore?.description, assumptions: sourceEpicBefore?.assumptions,
      order: sourceEpicBefore?.order, featureMode: sourceEpicBefore?.featureMode, scheduleMode: sourceEpicBefore?.scheduleMode,
      timelineStartWeek: sourceEpicBefore?.timelineStartWeek, isActive: sourceEpicBefore?.isActive,
    })
    expect(await prisma.feature.findUnique({ where: { id: fixture.featureId } })).toMatchObject({
      name: sourceFeatureBefore?.name, description: sourceFeatureBefore?.description, assumptions: sourceFeatureBefore?.assumptions,
      order: sourceFeatureBefore?.order, featureMode: sourceFeatureBefore?.featureMode, timelineColour: sourceFeatureBefore?.timelineColour,
      timelineStartWeek: sourceFeatureBefore?.timelineStartWeek, isActive: sourceFeatureBefore?.isActive,
    })
    expect(await prisma.userStory.findUnique({ where: { id: fixture.storyId } })).toMatchObject({
      name: sourceStoryBefore?.name, description: sourceStoryBefore?.description, assumptions: sourceStoryBefore?.assumptions,
      order: sourceStoryBefore?.order, isActive: sourceStoryBefore?.isActive, appliedTemplateId: sourceStoryBefore?.appliedTemplateId,
    })
    expect(await prisma.task.findUnique({ where: { id: fixture.taskId } })).toMatchObject({
      name: sourceTaskBefore?.name, description: sourceTaskBefore?.description, assumptions: sourceTaskBefore?.assumptions,
      order: sourceTaskBefore?.order, hoursEffort: sourceTaskBefore?.hoursEffort, durationDays: sourceTaskBefore?.durationDays,
      resourceTypeId: sourceTaskBefore?.resourceTypeId,
    })

    const edited = await request(app)
      .put(`/api/stories/${storyCopy?.id}/tasks/${storyCopy?.tasks[0]?.id}`)
      .set('Authorization', authHeader)
      .send({ name: 'Edited duplicate task', description: 'edited', assumptions: 'edited', hoursEffort: 99, durationDays: 5, resourceTypeId: fixture.resourceTypeId })
    expect(edited.status).toBe(200)
    const sourceTaskAfterEdit = await prisma.task.findUnique({ where: { id: fixture.taskId } })
    expect(sourceTaskAfterEdit).toMatchObject({ name: 'Source task', description: 'task description', hoursEffort: 12.5, durationDays: null })
  })

  it('rolls back root ordering and copied rows when a descendant insert fails', async () => {
    const fixture = await createFixture()
    const before = {
      epics: await prisma.epic.findMany({ where: { projectId: fixture.projectId }, orderBy: { order: 'asc' }, select: { id: true, name: true, order: true } }),
      features: await prisma.feature.findMany({ where: { epic: { projectId: fixture.projectId } }, orderBy: { order: 'asc' }, select: { id: true, name: true, order: true } }),
      stories: await prisma.userStory.findMany({ where: { feature: { epic: { projectId: fixture.projectId } } }, orderBy: { order: 'asc' }, select: { id: true, name: true, order: true } }),
      tasks: await prisma.task.findMany({ where: { userStory: { feature: { epic: { projectId: fixture.projectId } } } }, orderBy: { order: 'asc' }, select: { id: true, name: true, order: true } }),
    }

    await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS "test_fail_backlog_duplication_feature_trigger" ON "Feature"')
    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION "test_fail_backlog_duplication_feature"()
      RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW."name" = 'Source feature' THEN
          RAISE EXCEPTION 'injected descendant create failure';
        END IF;
        RETURN NEW;
      END;
      $$;
    `)
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER "test_fail_backlog_duplication_feature_trigger"
      BEFORE INSERT ON "Feature"
      FOR EACH ROW EXECUTE FUNCTION "test_fail_backlog_duplication_feature"()
    `)

    let response: Awaited<ReturnType<typeof duplicate>>
    try {
      response = await duplicate(fixture.projectId, 'epic', fixture.epicId)
    } finally {
      await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS "test_fail_backlog_duplication_feature_trigger" ON "Feature"')
      await prisma.$executeRawUnsafe('DROP FUNCTION IF EXISTS "test_fail_backlog_duplication_feature"()')
    }

    expect(response.status).toBe(500)
    expect({
      epics: await prisma.epic.findMany({ where: { projectId: fixture.projectId }, orderBy: { order: 'asc' }, select: { id: true, name: true, order: true } }),
      features: await prisma.feature.findMany({ where: { epic: { projectId: fixture.projectId } }, orderBy: { order: 'asc' }, select: { id: true, name: true, order: true } }),
      stories: await prisma.userStory.findMany({ where: { feature: { epic: { projectId: fixture.projectId } } }, orderBy: { order: 'asc' }, select: { id: true, name: true, order: true } }),
      tasks: await prisma.task.findMany({ where: { userStory: { feature: { epic: { projectId: fixture.projectId } } } }, orderBy: { order: 'asc' }, select: { id: true, name: true, order: true } }),
    }).toEqual(before)
  })

  it('keeps adjacent sibling ordering and fails closed for a foreign ResourceType', async () => {
    const fixture = await createFixture()
    const taskResponse = await duplicate(fixture.projectId, 'task', fixture.taskId)
    expect(taskResponse.status).toBe(201)
    const orderedTasks = await prisma.task.findMany({ where: { userStoryId: fixture.storyId }, orderBy: { order: 'asc' } })
    expect(orderedTasks.map(task => task.name)).toEqual(['Source task', 'Copy of Source task', 'Unrelated task'])

    const orderedFeaturesBefore = await prisma.feature.findMany({ where: { epicId: fixture.epicId }, orderBy: { order: 'asc' } })
    const featureResponse = await duplicate(fixture.projectId, 'feature', fixture.featureId)
    expect(featureResponse.status).toBe(201)
    const orderedFeatures = await prisma.feature.findMany({ where: { epicId: fixture.epicId }, orderBy: { order: 'asc' } })
    expect(orderedFeatures.map(feature => feature.name)).toEqual(['Source feature', 'Copy of Source feature', 'Unrelated feature'])
    expect(orderedFeaturesBefore.map(feature => feature.name)).toEqual(['Source feature', 'Unrelated feature'])

    const foreignProject = await prisma.project.create({ data: { name: `Foreign ${Date.now()}`, ownerId: userId } })
    projectIds.push(foreignProject.id)
    const foreignResourceType = await prisma.resourceType.create({ data: { name: 'Foreign developer', category: 'ENGINEERING', projectId: foreignProject.id } })
    const invalidTask = await prisma.task.create({ data: { name: 'Invalid assignment', hoursEffort: 1, order: 2, userStoryId: fixture.storyId, resourceTypeId: foreignResourceType.id } })
    const countBefore = await prisma.task.count({ where: { userStoryId: fixture.storyId } })
    const invalidResponse = await duplicate(fixture.projectId, 'task', invalidTask.id)
    expect(invalidResponse.status).toBe(422)
    expect(await prisma.task.count({ where: { userStoryId: fixture.storyId } })).toBe(countBefore)
    expect((await prisma.task.findUnique({ where: { id: invalidTask.id } }))?.order).toBe(2)
  })
})
