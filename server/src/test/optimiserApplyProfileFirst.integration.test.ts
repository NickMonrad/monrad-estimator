/**
 * Real PostgreSQL coverage for profile-first Resource Optimiser apply (#360).
 * Skipped unless the disposable integration lifecycle sets INTEGRATION_TEST=true.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '@prisma/client'
import { app } from '../app.js'
import {
  RESOURCE_OPTIMISER_PROFILE_PROVENANCE,
  __setOptimiserApplyFailureSeam,
  __setOptimiserPreTransactionSeam,
} from '../lib/optimiserApplyService.js'

vi.mock('../lib/prisma.js', async importOriginal => importOriginal())

const runIntegration = process.env.INTEGRATION_TEST === 'true'
const describeIf = runIntegration ? describe : describe.skip

let prisma: PrismaClient
let userId: string
let authHeader: string

beforeAll(async () => {
  if (!runIntegration) return
  prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
  })
  await prisma.$connect()
  const user = await prisma.user.create({
    data: {
      email: `optimiser-apply-360-${Date.now()}@example.com`,
      name: 'Optimiser Apply Integration',
      password: '$2b$10$placeholder',
    },
  })
  userId = user.id
  authHeader = `Bearer ${jwt.sign({ userId, role: 'USER' }, process.env.JWT_SECRET!)}`
})

afterAll(async () => {
  if (!runIntegration) return
  __setOptimiserApplyFailureSeam(null)
  __setOptimiserPreTransactionSeam(null)
  await prisma.project.deleteMany({ where: { ownerId: userId } })
  await prisma.user.delete({ where: { id: userId } })
  await prisma.$disconnect()
})

interface Scenario {
  projectId: string
  resourceTypeId: string
  namedResourceId: string
}

async function createScenario(
  label: string,
  options: {
    count?: number
    startWeek?: number | null
    endWeek?: number | null
    allocationMode?: 'EFFORT' | 'TIMELINE' | 'FULL_PROJECT' | 'CAPACITY_PLAN'
    allocationPercent?: number
    withBacklog?: boolean
  } = {},
): Promise<Scenario> {
  const project = await prisma.project.create({
    data: {
      name: `Optimiser ${label} ${Date.now()}`,
      ownerId: userId,
      weeklyDemandCache: { sentinel: 42.5 },
    },
  })
  const resourceType = await prisma.resourceType.create({
    data: {
      projectId: project.id,
      name: `${label} Engineer`,
      category: 'ENGINEERING',
      count: options.count ?? 2,
      hoursPerDay: 7.6,
      allocationMode: 'TIMELINE',
      allocationPercent: 100,
    },
  })
  const namedResource = await prisma.namedResource.create({
    data: {
      resourceTypeId: resourceType.id,
      name: `${label} Alice`,
      startWeek: options.startWeek ?? 1,
      endWeek: options.endWeek ?? 12,
      allocationPct: options.allocationPercent ?? 80,
      allocationMode: options.allocationMode ?? 'TIMELINE',
      allocationPercent: options.allocationPercent ?? 80,
      allocationStartWeek: options.startWeek ?? 1,
      allocationEndWeek: options.endWeek ?? 12,
      pricingModel: 'ACTUAL_DAYS',
    },
  })

  if (options.withBacklog) {
    const epic = await prisma.epic.create({
      data: { projectId: project.id, name: `${label} Epic`, order: 0 },
    })
    const feature = await prisma.feature.create({
      data: { epicId: epic.id, name: `${label} Feature`, order: 0 },
    })
    const story = await prisma.userStory.create({
      data: { featureId: feature.id, name: `${label} Story`, order: 0 },
    })
    await prisma.task.create({
      data: {
        userStoryId: story.id,
        resourceTypeId: resourceType.id,
        name: `${label} Task`,
        order: 0,
        hoursEffort: 38,
      },
    })
    await prisma.timelineEntry.create({
      data: {
        projectId: project.id,
        featureId: feature.id,
        startWeek: 99,
        durationWeeks: 7,
        isManual: false,
      },
    })
    await prisma.storyTimelineEntry.create({
      data: {
        projectId: project.id,
        storyId: story.id,
        startWeek: 99,
        durationWeeks: 7,
        isManual: false,
      },
    })
  }

  return {
    projectId: project.id,
    resourceTypeId: resourceType.id,
    namedResourceId: namedResource.id,
  }
}

async function applyScenario(
  scenario: Scenario,
  count: number,
  suggestedStartWeek: number,
) {
  return request(app)
    .post(`/api/projects/${scenario.projectId}/optimise/apply`)
    .set('Authorization', authHeader)
    .send({
      resourceTypes: [{
        resourceTypeId: scenario.resourceTypeId,
        count,
        suggestedStartWeek,
      }],
      optimiserScopeResourceTypeIds: [scenario.resourceTypeId],
    })
}

describeIf('Resource Optimiser profile-first apply — PostgreSQL', () => {
  it('writes authoritative scalar capacity, projects compatibility, and snapshots exact pre-state', async () => {
    const scenario = await createScenario('success')

    const first = await applyScenario(scenario, 3, 4)
    expect(first.status).toBe(200)
    expect(first.body.message).toBe('Optimiser scenario applied successfully')

    const [resourceType, namedResource, profiles, snapshot, project] = await Promise.all([
      prisma.resourceType.findUniqueOrThrow({ where: { id: scenario.resourceTypeId } }),
      prisma.namedResource.findUniqueOrThrow({ where: { id: scenario.namedResourceId } }),
      prisma.capacityProfile.findMany({
        where: { namedResourceId: scenario.namedResourceId },
        include: { segments: true },
      }),
      prisma.backlogSnapshot.findUniqueOrThrow({ where: { id: first.body.snapshotId } }),
      prisma.project.findUniqueOrThrow({ where: { id: scenario.projectId } }),
    ])

    expect(resourceType.count).toBe(3)
    expect(profiles).toHaveLength(1)
    expect(profiles[0]).toMatchObject({
      projectId: scenario.projectId,
      resourceTypeId: null,
      namedResourceId: scenario.namedResourceId,
      ownerKind: 'NAMED_PERSON',
      planningBasis: 'AVAILABILITY_WINDOW',
      source: 'DERIVED',
      defaultPercent: 80,
      startWeek: 4,
      endWeek: 12,
      legacy: RESOURCE_OPTIMISER_PROFILE_PROVENANCE,
      segments: [],
    })
    expect(namedResource).toMatchObject({
      startWeek: 4,
      endWeek: 12,
      allocationPct: 80,
      allocationMode: 'TIMELINE',
      allocationPercent: 80,
      allocationStartWeek: 4,
      allocationEndWeek: 12,
    })
    expect(project.weeklyDemandCache).toEqual({})

    const snapshotData = snapshot.snapshot as Record<string, unknown>
    const snapResourceTypes = snapshotData.resourceTypes as Array<Record<string, unknown>>
    const snapNamedResources = snapshotData.namedResources as Array<Record<string, unknown>>
    expect(snapshotData.schemaVersion).toBe(3)
    expect(snapResourceTypes.find(row => row.id === scenario.resourceTypeId)?.count).toBe(2)
    expect(snapNamedResources.find(row => row.id === scenario.namedResourceId)?.startWeek).toBe(1)
    expect(snapshotData.capacityProfiles).toEqual([])
    expect((snapshotData.project as Record<string, unknown>).weeklyDemandCache).toEqual({ sentinel: 42.5 })

    const firstProfileId = profiles[0]!.id
    const second = await applyScenario(scenario, 3, 6)
    expect(second.status).toBe(200)
    const reappliedProfiles = await prisma.capacityProfile.findMany({
      where: { namedResourceId: scenario.namedResourceId },
      include: { segments: true },
    })
    expect(reappliedProfiles).toHaveLength(1)
    expect(reappliedProfiles[0]).toMatchObject({
      id: firstProfileId,
      startWeek: 6,
      endWeek: 12,
      legacy: RESOURCE_OPTIMISER_PROFILE_PROVENANCE,
      segments: [],
    })
  })

  it('rejects segmented explicit ownership before snapshot or mutation', async () => {
    const scenario = await createScenario('segmented')
    const profile = await prisma.capacityProfile.create({
      data: {
        projectId: scenario.projectId,
        resourceTypeId: null,
        namedResourceId: scenario.namedResourceId,
        ownerKind: 'NAMED_PERSON',
        planningBasis: 'AVAILABILITY_WINDOW',
        source: 'MANUAL',
        defaultPercent: 80,
        startWeek: 1,
        endWeek: 12,
      },
    })
    const segment = await prisma.capacitySegment.create({
      data: {
        capacityProfileId: profile.id,
        startWeek: 1,
        endWeek: 6,
        capacityPercent: 50,
        source: 'MANUAL',
      },
    })

    const before = await prisma.capacityProfile.findUniqueOrThrow({
      where: { id: profile.id },
      include: { segments: true },
    })
    const response = await applyScenario(scenario, 3, 4)
    const after = await prisma.capacityProfile.findUniqueOrThrow({
      where: { id: profile.id },
      include: { segments: true },
    })

    expect(response.status).toBe(409)
    expect(response.body).toMatchObject({
      code: 'OPTIMISER_APPLY_CONFLICT',
      conflicts: [{
        code: 'SEGMENTED_PROTECTED',
        resourceTypeName: 'segmented Engineer',
        namedResourceName: 'segmented Alice',
      }],
    })
    expect(after).toEqual(before)
    expect(after.segments).toEqual([expect.objectContaining({ id: segment.id })])
    expect(await prisma.backlogSnapshot.count({ where: { projectId: scenario.projectId } })).toBe(0)
    expect((await prisma.resourceType.findUniqueOrThrow({ where: { id: scenario.resourceTypeId } })).count).toBe(2)
    expect((await prisma.project.findUniqueOrThrow({ where: { id: scenario.projectId } })).weeklyDemandCache).toEqual({ sentinel: 42.5 })
  })

  it('rejects changed active-plan roles with stable conflict guidance', async () => {
    const scenario = await createScenario('planner')
    const plan = await prisma.capacityPlan.create({
      data: {
        projectId: scenario.projectId,
        name: 'Active planner authority',
        targetWeeks: 13,
        periodWeeks: 13,
        isActive: true,
      },
    })
    const period = await prisma.capacityPlanPeriod.create({
      data: { planId: plan.id, periodIndex: 0, startWeek: 0, endWeek: 12 },
    })
    await prisma.capacityPlanEntry.create({
      data: {
        periodId: period.id,
        resourceTypeId: scenario.resourceTypeId,
        headcount: 2,
        demandFTE: 1,
        utilisationPct: 50,
      },
    })

    const response = await applyScenario(scenario, 3, 1)

    expect(response.status).toBe(409)
    expect(response.body.code).toBe('OPTIMISER_APPLY_CONFLICT')
    expect(response.body.conflicts[0]).toMatchObject({
      code: 'PLANNER_MANAGED_PROTECTED',
      resourceTypeName: 'planner Engineer',
    })
    expect(response.body.error).toContain('Refine in Squad Planner')
    expect(await prisma.backlogSnapshot.count({ where: { projectId: scenario.projectId } })).toBe(0)
    expect((await prisma.resourceType.findUniqueOrThrow({ where: { id: scenario.resourceTypeId } })).count).toBe(2)
  })

  it('revalidates ownership in-transaction and preserves a concurrent explicit profile', async () => {
    const scenario = await createScenario('race')
    let concurrentProfileId = ''
    __setOptimiserPreTransactionSeam(async () => {
      const concurrent = await prisma.capacityProfile.create({
        data: {
          projectId: scenario.projectId,
          resourceTypeId: null,
          namedResourceId: scenario.namedResourceId,
          ownerKind: 'NAMED_PERSON',
          planningBasis: 'AVAILABILITY_WINDOW',
          source: 'MANUAL',
          defaultPercent: 70,
          startWeek: 1,
          endWeek: 12,
        },
      })
      concurrentProfileId = concurrent.id
    })

    try {
      const response = await applyScenario(scenario, 3, 4)
      expect(response.status).toBe(409)
      expect(response.body.conflicts[0].code).toBe('EXPLICIT_SCALAR_PROTECTED')
    } finally {
      __setOptimiserPreTransactionSeam(null)
    }

    expect(await prisma.capacityProfile.findUnique({ where: { id: concurrentProfileId } })).not.toBeNull()
    expect(await prisma.backlogSnapshot.count({ where: { projectId: scenario.projectId } })).toBe(0)
    expect((await prisma.resourceType.findUniqueOrThrow({ where: { id: scenario.resourceTypeId } })).count).toBe(2)
  })

  it('rolls back snapshot, profile, count, schedule, and cache on a late failure', async () => {
    const scenario = await createScenario('rollback', { withBacklog: true })
    __setOptimiserApplyFailureSeam(stage => {
      if (stage === 'cache') throw new Error('forced optimiser apply failure')
    })

    try {
      const response = await applyScenario(scenario, 3, 4)
      expect(response.status).toBe(500)
    } finally {
      __setOptimiserApplyFailureSeam(null)
    }

    const [resourceType, namedResource, profiles, project, timelines, storyTimelines, snapshots] = await Promise.all([
      prisma.resourceType.findUniqueOrThrow({ where: { id: scenario.resourceTypeId } }),
      prisma.namedResource.findUniqueOrThrow({ where: { id: scenario.namedResourceId } }),
      prisma.capacityProfile.findMany({ where: { namedResourceId: scenario.namedResourceId } }),
      prisma.project.findUniqueOrThrow({ where: { id: scenario.projectId } }),
      prisma.timelineEntry.findMany({ where: { projectId: scenario.projectId } }),
      prisma.storyTimelineEntry.findMany({ where: { projectId: scenario.projectId } }),
      prisma.backlogSnapshot.findMany({ where: { projectId: scenario.projectId } }),
    ])

    expect(resourceType.count).toBe(2)
    expect(namedResource).toMatchObject({
      startWeek: 1,
      allocationStartWeek: 1,
      allocationPercent: 80,
    })
    expect(profiles).toEqual([])
    expect(project.weeklyDemandCache).toEqual({ sentinel: 42.5 })
    expect(timelines).toEqual([expect.objectContaining({ startWeek: 99, durationWeeks: 7 })])
    expect(storyTimelines).toEqual([expect.objectContaining({ startWeek: 99, durationWeeks: 7 })])
    expect(snapshots).toEqual([])
  })
})
