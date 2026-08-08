/**
 * planningReset.integration.test.ts — Real PostgreSQL integration tests for
 * the Reset Planning / Replan project workflow (issue #449).
 *
 * Proves against the actual schema:
 *
 *   - The atomic reset clears exactly the planning allow-list (profiles,
 *     segments, capacity plans, timeline output, caches, proven planner
 *     placeholders) and preserves every estimation/business input.
 *   - An injected mid-transaction failure rolls the entire reset back.
 *   - A CURRENT project with intentionally absent planning state still fails
 *     closed; a NEEDS_REPLAN project does not fail for that same absence.
 *   - Planning-dependent operations return 409 REPLAN_REQUIRED while
 *     quarantined; Squad Planner apply stays available as a replanning path.
 *   - Unrelated ownership corruption still fails even when NEEDS_REPLAN.
 *   - Replanning through the normal profile surface, and through Squad
 *     Planner, returns the project to CURRENT only via canonical validation;
 *     Timeline scheduling then works.
 *   - Readiness treats NEEDS_REPLAN as an explicit quarantine without masking
 *     ownership defects.
 *   - The reviewed production maintenance command (dry-run then apply)
 *     classifies an explicit project set via the same reset transaction.
 *
 * All tests are skipped unless INTEGRATION_TEST=true. Follows the isolation
 * and cleanup pattern of squadPlanProfileFirst.integration.test.ts.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '@prisma/client'

import { app } from '../app.js'
import { resetProjectPlanning } from '../lib/resetProjectPlanning.js'
import { runProductionMigrationReadiness, formatReadinessReport } from '../lib/productionMigrationReadiness.js'
import { classifyNeedsReplan, parseClassifyManifest } from '../lib/classifyNeedsReplan.js'
// Override the global prisma mock so route handlers use real PostgreSQL.
vi.mock('../lib/prisma.js', async importOriginal => await importOriginal())

// ─── Guard ──────────────────────────────────────────────────────────────────

const runIntegration = process.env.INTEGRATION_TEST === 'true'
const describeIf = runIntegration ? describe : describe.skip

// ─── Shared state ───────────────────────────────────────────────────────────

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
      email: `planning-reset-${Date.now()}@example.com`,
      name: 'Planning Reset Integration Test',
      password: '$2b$10$placeholder',
    },
  })
  userId = user.id
  token = jwt.sign({ userId, role: 'USER' }, process.env.JWT_SECRET!)
  authHeader = `Bearer ${token}`
})

afterAll(async () => {
  if (!runIntegration) return
  await prisma.backlogSnapshot.deleteMany({ where: { project: { ownerId: userId } } })
  await prisma.capacitySegment.deleteMany({ where: { capacityProfile: { project: { ownerId: userId } } } })
  await prisma.capacityProfile.deleteMany({ where: { project: { ownerId: userId } } })
  await prisma.capacityPlanEntry.deleteMany({ where: { period: { plan: { project: { ownerId: userId } } } } })
  await prisma.capacityPlanPeriod.deleteMany({ where: { plan: { project: { ownerId: userId } } } })
  await prisma.capacityPlan.deleteMany({ where: { project: { ownerId: userId } } })
  await prisma.projectDiscount.deleteMany({ where: { project: { ownerId: userId } } })
  await prisma.projectOverhead.deleteMany({ where: { project: { ownerId: userId } } })
  await prisma.storyTimelineEntry.deleteMany({ where: { project: { ownerId: userId } } })
  await prisma.timelineEntry.deleteMany({ where: { project: { ownerId: userId } } })
  await prisma.storyDependency.deleteMany({ where: { story: { feature: { epic: { project: { ownerId: userId } } } } } })
  await prisma.featureDependency.deleteMany({ where: { feature: { epic: { project: { ownerId: userId } } } } })
  await prisma.epicDependency.deleteMany({ where: { epic: { project: { ownerId: userId } } } })
  await prisma.task.deleteMany({ where: { userStory: { feature: { epic: { project: { ownerId: userId } } } } } })
  await prisma.userStory.deleteMany({ where: { feature: { epic: { project: { ownerId: userId } } } } })
  await prisma.feature.deleteMany({ where: { epic: { project: { ownerId: userId } } } })
  await prisma.epic.deleteMany({ where: { project: { ownerId: userId } } })
  await prisma.namedResource.deleteMany({ where: { resourceType: { project: { ownerId: userId } } } })
  await prisma.resourceType.deleteMany({ where: { project: { ownerId: userId } } })
  await prisma.project.deleteMany({ where: { ownerId: userId } })
  await prisma.$disconnect()
})

// ─── Fixture builder ────────────────────────────────────────────────────────

interface PlannedProject {
  projectId: string
  rtId: string
  userNrId: string
  plannedNrId: string
  epicId: string
  featureId: string
  storyId: string
  taskId: string
  planId: string
}

/**
 * Create a fully planned project: backlog + dependency + roles + genuine
 * user-authored named resource + Commercial metadata + CapacityPlan +
 * ROLE/NAMED_PERSON/PLANNED_RESOURCE profiles + timeline output + cache.
 */
async function createFullyPlannedProject(): Promise<PlannedProject> {
  const project = await prisma.project.create({
    data: {
      name: `Reset fixture ${Date.now()}`,
      description: 'boundary fixture',
      status: 'ACTIVE',
      hoursPerDay: 7.6,
      bufferWeeks: 2,
      onboardingWeeks: 1,
      startDate: new Date('2026-09-01'),
      taxRate: 10,
      taxLabel: 'GST',
      ownerId: userId,
      weeklyDemandCache: { 'rt-1|1': 5 },
      resourceTypes: {
        create: [{
          name: 'Engineer',
          category: 'ENGINEERING',
          count: 2,
          hoursPerDay: 7.6,
          dayRate: 500,
        }],
      },
      epics: {
        create: [{
          name: 'Epic 1',
          features: {
            create: [{
              name: 'Feature 1',
              userStories: {
                create: [{
                  name: 'Story 1',
                  tasks: {
                    create: [{
                      name: 'Task 1',
                      hoursEffort: 16,
                      durationDays: 2,
                    }],
                  },
                }],
              },
            }],
          },
        }],
      },
      overheads: { create: [{ name: 'Travel', type: 'FIXED_DAYS', value: 3, order: 0 }] },
      discounts: { create: [{ type: 'PERCENTAGE', value: 5, label: 'Loyalty', order: 0 }] },
    },
    include: {
      resourceTypes: { include: { namedResources: true } },
      epics: { include: { features: { include: { userStories: { include: { tasks: true } } } } } },
    },
  })

  const rt = project.resourceTypes[0]!
  const epic = project.epics[0]!
  const feature = epic.features[0]!
  const story = feature.userStories[0]!
  const task = story.tasks[0]!
  await prisma.task.update({ where: { id: task.id }, data: { resourceTypeId: rt.id } })

  // User-authored named resource (NAMED_PERSON provenance).
  const userNr = await prisma.namedResource.create({
    data: { resourceTypeId: rt.id, name: 'Alice', pricingModel: 'PRO_RATA' },
  })
  await prisma.capacityProfile.create({
    data: {
      projectId: project.id,
      namedResourceId: userNr.id,
      ownerKind: 'NAMED_PERSON',
      planningBasis: 'WHOLE_PROJECT_ALLOCATION',
      source: 'MANUAL',
      defaultPercent: 100,
    },
  })

  // Planner-generated placeholder (PLANNED_RESOURCE provenance, as the Squad
  // Planner apply path writes them).
  const plannedNr = await prisma.namedResource.create({
    data: { resourceTypeId: rt.id, name: 'Engineer 2' },
  })
  const plannedProfile = await prisma.capacityProfile.create({
    data: {
      projectId: project.id,
      namedResourceId: plannedNr.id,
      ownerKind: 'PLANNED_RESOURCE',
      planningBasis: 'CAPACITY_PROFILE',
      source: 'SQUAD_PLANNER',
      defaultPercent: 100,
      startWeek: 0,
      endWeek: 10,
    },
  })
  await prisma.capacitySegment.create({
    data: {
      capacityProfileId: plannedProfile.id,
      startWeek: 0,
      endWeek: 10,
      capacityPercent: 100,
      source: 'SQUAD_PLANNER',
    },
  })

  // Role profile with segments.
  const roleProfile = await prisma.capacityProfile.create({
    data: {
      projectId: project.id,
      resourceTypeId: rt.id,
      ownerKind: 'ROLE',
      planningBasis: 'CAPACITY_PROFILE',
      source: 'MANUAL',
      defaultPercent: 100,
    },
  })
  await prisma.capacitySegment.createMany({
    data: [
      { capacityProfileId: roleProfile.id, startWeek: 0, endWeek: 4, capacityPercent: 100, source: 'MANUAL' },
      { capacityProfileId: roleProfile.id, startWeek: 5, endWeek: 10, capacityPercent: 80, source: 'MANUAL' },
    ],
  })

  // Capacity plan with periods/entries.
  const plan = await prisma.capacityPlan.create({
    data: {
      projectId: project.id,
      name: 'Plan 1',
      targetWeeks: 12,
      periodWeeks: 4,
      isActive: true,
      totalCost: 12000,
      deliveryWeeks: 12,
      periods: {
        create: [{
          periodIndex: 0,
          startWeek: 0,
          endWeek: 4,
          entries: { create: [{ resourceTypeId: rt.id, headcount: 2, demandFTE: 1.5, utilisationPct: 75 }] },
        }],
      },
    },
  })

  // Generated schedule output (feature + story) with a manual override.
  await prisma.timelineEntry.create({ data: { projectId: project.id, featureId: feature.id, startWeek: 0, durationWeeks: 6, isManual: true } })
  await prisma.storyTimelineEntry.create({ data: { projectId: project.id, storyId: story.id, startWeek: 0, durationWeeks: 6, isManual: false } })

  // Dependency.
  await prisma.featureDependency.create({ data: { featureId: feature.id, dependsOnId: feature.id } })

  return {
    projectId: project.id,
    rtId: rt.id,
    userNrId: userNr.id,
    plannedNrId: plannedNr.id,
    epicId: epic.id,
    featureId: feature.id,
    storyId: story.id,
    taskId: task.id,
    planId: plan.id,
  }
}

/** Snapshot a project's full planning + business state for byte-level comparison. */
async function captureProjectState(projectId: string) {
  const [project, profiles, segments, plans, periods, entries, timeline, storyTimeline, nr, rt, epicCount, taskCount, deps, discounts, overheads] = await Promise.all([
    prisma.project.findUnique({ where: { id: projectId } }),
    prisma.capacityProfile.findMany({ where: { projectId } }),
    prisma.capacitySegment.findMany({ where: { capacityProfile: { projectId } } }),
    prisma.capacityPlan.findMany({ where: { projectId } }),
    prisma.capacityPlanPeriod.findMany({ where: { plan: { projectId } } }),
    prisma.capacityPlanEntry.findMany({ where: { period: { plan: { projectId } } } }),
    prisma.timelineEntry.findMany({ where: { projectId } }),
    prisma.storyTimelineEntry.findMany({ where: { projectId } }),
    prisma.namedResource.findMany({ where: { resourceType: { projectId } } }),
    prisma.resourceType.findMany({ where: { projectId } }),
    prisma.epic.count({ where: { projectId } }),
    prisma.task.count({ where: { userStory: { feature: { epic: { projectId } } } } }),
    prisma.featureDependency.count({ where: { feature: { epic: { projectId } } } }),
    prisma.projectDiscount.findMany({ where: { projectId } }),
    prisma.projectOverhead.findMany({ where: { projectId } }),
  ])
  return { project, profiles, segments, plans, periods, entries, timeline, storyTimeline, nr, rt, epicCount, taskCount, deps, discounts, overheads }
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describeIf('Reset Planning — full boundary (issue #449)', () => {
  it('clears the planning allow-list and preserves every business input', async () => {
    const f = await createFullyPlannedProject()
    const before = await captureProjectState(f.projectId)

    // Pre-conditions: everything exists.
    expect(before.profiles.length).toBe(3)
    expect(before.segments.length).toBe(3)
    expect(before.plans.length).toBe(1)
    expect(before.periods.length).toBe(1)
    expect(before.entries.length).toBe(1)
    expect(before.timeline.length).toBe(1)
    expect(before.storyTimeline.length).toBe(1)
    expect(before.nr.some(n => n.id === f.userNrId)).toBe(true)
    expect(before.nr.some(n => n.id === f.plannedNrId)).toBe(true)
    expect(before.project!.weeklyDemandCache).not.toBeNull()
    expect(before.project!.planningState).toBe('CURRENT')

    const res = await request(app)
      .post(`/api/projects/${f.projectId}/planning/reset`)
      .set('Authorization', authHeader)
      .send({ confirm: true })

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ projectId: f.projectId, planningState: 'NEEDS_REPLAN' })

    const after = await captureProjectState(f.projectId)

    // ── Cleared: planning-owned state ──
    expect(after.profiles).toHaveLength(0)
    expect(after.segments).toHaveLength(0)
    expect(after.plans).toHaveLength(0)
    expect(after.periods).toHaveLength(0)
    expect(after.entries).toHaveLength(0)
    expect(after.timeline).toHaveLength(0)
    expect(after.storyTimeline).toHaveLength(0)
    expect(after.project!.weeklyDemandCache).toBeNull()
    expect(after.project!.planningState).toBe('NEEDS_REPLAN')
    // Proven planner-generated placeholder removed…
    expect(after.nr.some(n => n.id === f.plannedNrId)).toBe(false)

    // ── Preserved: estimation/business state, byte/value-equivalent ──
    expect(after.nr.some(n => n.id === f.userNrId)).toBe(true)
    const preservedUserNr = after.nr.find(n => n.id === f.userNrId)!
    const beforeUserNr = before.nr.find(n => n.id === f.userNrId)!
    expect(preservedUserNr.name).toBe(beforeUserNr.name)
    expect(preservedUserNr.pricingModel).toBe(beforeUserNr.pricingModel)
    expect(preservedUserNr.resourceTypeId).toBe(beforeUserNr.resourceTypeId)

    const rtAfter = after.rt[0]!
    const rtBefore = before.rt[0]!
    expect(rtAfter.name).toBe(rtBefore.name)
    expect(rtAfter.count).toBe(rtBefore.count)
    expect(rtAfter.hoursPerDay).toBe(rtBefore.hoursPerDay)
    expect(rtAfter.dayRate).toBe(rtBefore.dayRate)
    expect(rtAfter.category).toBe(rtBefore.category)

    expect(after.epicCount).toBe(before.epicCount)
    expect(after.taskCount).toBe(before.taskCount)
    expect(after.deps).toBe(before.deps)
    expect(after.discounts).toHaveLength(1)
    expect(after.overheads).toHaveLength(1)

    const p = after.project!
    expect(p.name).toBe(before.project!.name)
    expect(p.description).toBe(before.project!.description)
    expect(p.status).toBe(before.project!.status)
    expect(p.hoursPerDay).toBe(before.project!.hoursPerDay)
    expect(p.bufferWeeks).toBe(before.project!.bufferWeeks)
    expect(p.onboardingWeeks).toBe(before.project!.onboardingWeeks)
    expect(p.startDate?.toISOString()).toBe(before.project!.startDate?.toISOString())
    expect(p.taxRate).toBe(before.project!.taxRate)
    expect(p.taxLabel).toBe(before.project!.taxLabel)
  })

  it('requires explicit confirmation and rejects foreign projects', async () => {
    const f = await createFullyPlannedProject()

    // Missing confirmation → 400, nothing changes.
    const res400 = await request(app)
      .post(`/api/projects/${f.projectId}/planning/reset`)
      .set('Authorization', authHeader)
      .send({})
    expect(res400.status).toBe(400)

    // Another user's project → 404.
    const other = await prisma.user.create({
      data: { email: `other-${Date.now()}@example.com`, name: 'Other', password: 'x' },
    })
    const foreignProject = await prisma.project.create({
      data: { name: 'Foreign', ownerId: other.id },
    })
    const resForeign = await request(app)
      .post(`/api/projects/${foreignProject.id}/planning/reset`)
      .set('Authorization', authHeader)
      .send({ confirm: true })
    expect(resForeign.status).toBe(404)

    const state = await captureProjectState(f.projectId)
    expect(state.project!.planningState).toBe('CURRENT')
    expect(state.profiles.length).toBeGreaterThan(0)
  })

  it('rolls the entire reset back when a mid-transaction failure is injected', async () => {
    const f = await createFullyPlannedProject()
    const before = await captureProjectState(f.projectId)

    await expect(
      resetProjectPlanning(prisma, f.projectId, {
        afterWrites: async () => { throw new Error('injected mid-transaction failure') },
      }),
    ).rejects.toThrow('injected mid-transaction failure')

    const after = await captureProjectState(f.projectId)
    // Zero partial reset: every planning row and the state flag are intact.
    expect(after.project!.planningState).toBe('CURRENT')
    expect(after.profiles.length).toBe(before.profiles.length)
    expect(after.segments.length).toBe(before.segments.length)
    expect(after.plans.length).toBe(before.plans.length)
    expect(after.timeline.length).toBe(before.timeline.length)
    expect(after.storyTimeline.length).toBe(before.storyTimeline.length)
    expect(after.nr.length).toBe(before.nr.length)
    expect(after.project!.weeklyDemandCache).toEqual(before.project!.weeklyDemandCache)
  })
})

describeIf('NEEDS_REPLAN quarantine (issue #449)', () => {
  it('a CURRENT project still fails closed on absent planning state', async () => {
    const f = await createFullyPlannedProject()
    // Simulate a CURRENT project with missing profiles: delete only profiles.
    await prisma.capacityProfile.deleteMany({ where: { projectId: f.projectId } })

    const res = await request(app)
      .get(`/api/projects/${f.projectId}/capacity-profiles`)
      .set('Authorization', authHeader)
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('CAPACITY_INTEGRITY_ERROR')

    // Quarantine the intentionally-broken project so later global readiness
    // assertions are stable (the quarantine is exactly what reset is for).
    await request(app)
      .post(`/api/projects/${f.projectId}/planning/reset`)
      .set('Authorization', authHeader)
      .send({ confirm: true })
  })

  it('NEEDS_REPLAN projects stay accessible with expected missing planning state', async () => {
    const f = await createFullyPlannedProject()
    await request(app)
      .post(`/api/projects/${f.projectId}/planning/reset`)
      .set('Authorization', authHeader)
      .send({ confirm: true })

    // Profile surface serves the empty persisted set (expected absence).
    const cp = await request(app)
      .get(`/api/projects/${f.projectId}/capacity-profiles`)
      .set('Authorization', authHeader)
    expect(cp.status).toBe(200)
    expect(cp.body.capacityProfiles).toEqual([])

    // Resource Profile serves effort/inputs with the explicit marker.
    const rp = await request(app)
      .get(`/api/projects/${f.projectId}/resource-profile`)
      .set('Authorization', authHeader)
    expect(rp.status).toBe(200)
    expect(rp.body.planningState).toBe('NEEDS_REPLAN')
    expect(rp.body.resourceRows[0].totalHours).toBe(16)
    expect(rp.body.summary.totalCost).toBeNull()
    expect(rp.body.resourceRows[0].namedResources).toHaveLength(1) // Alice preserved

    // Timeline is explicitly empty, never derived from stale state.
    const tl = await request(app)
      .get(`/api/projects/${f.projectId}/timeline`)
      .set('Authorization', authHeader)
    expect(tl.status).toBe(200)
    expect(tl.body.planningState).toBe('NEEDS_REPLAN')
    expect(tl.body.entries).toEqual([])
  })

  it('planning-dependent operations return actionable REPLAN_REQUIRED', async () => {
    const f = await createFullyPlannedProject()
    await request(app)
      .post(`/api/projects/${f.projectId}/planning/reset`)
      .set('Authorization', authHeader)
      .send({ confirm: true })

    const schedule = await request(app)
      .post(`/api/projects/${f.projectId}/timeline/schedule`)
      .set('Authorization', authHeader)
      .send({})
    expect(schedule.status).toBe(409)
    expect(schedule.body.code).toBe('REPLAN_REQUIRED')
    expect(schedule.body.error).toContain('needs replanning')

    const optimise = await request(app)
      .post(`/api/projects/${f.projectId}/optimise`)
      .set('Authorization', authHeader)
      .send({})
    expect(optimise.status).toBe(409)
    expect(optimise.body.code).toBe('REPLAN_REQUIRED')

    // Backlog editing stays available.
    const epics = await request(app)
      .get(`/api/projects/${f.projectId}/epics`)
      .set('Authorization', authHeader)
    expect(epics.status).toBe(200)
  })

  it('unrelated ownership corruption still fails even when NEEDS_REPLAN', async () => {
    const f = await createFullyPlannedProject()
    await request(app)
      .post(`/api/projects/${f.projectId}/planning/reset`)
      .set('Authorization', authHeader)
      .send({ confirm: true })

    // Corrupt the quarantined project with a cross-project profile row.
    const otherProject = await prisma.project.create({
      data: { name: 'Corruption host', ownerId: userId },
    })
    const foreignRt = await prisma.resourceType.create({
      data: { name: 'Foreign', category: 'ENGINEERING', projectId: otherProject.id },
    })
    await prisma.capacityProfile.create({
      data: {
        projectId: f.projectId,
        resourceTypeId: foreignRt.id,
        ownerKind: 'ROLE',
        planningBasis: 'DEMAND_FOLLOWING',
        source: 'MANUAL',
      },
    })

    // Structural validation still rejects the cross-project owner.
    const cp = await request(app)
      .get(`/api/projects/${f.projectId}/capacity-profiles`)
      .set('Authorization', authHeader)
    expect(cp.status).toBe(409)
    expect(cp.body.code).toBe('CAPACITY_INTEGRITY_ERROR')

    // Readiness still fails on the unrelated ownership defect.
    const readiness = await runProductionMigrationReadiness(prisma)
    expect(readiness.passed).toBe(false)

    // Clean up the corruption so later global readiness assertions are stable.
    await prisma.capacityProfile.deleteMany({ where: { projectId: f.projectId, resourceTypeId: foreignRt.id } })
    await prisma.resourceType.deleteMany({ where: { id: foreignRt.id } })
    await prisma.project.deleteMany({ where: { id: otherProject.id } })
  })
})

describeIf('Replanning completion (issue #449)', () => {
  it('cannot complete while canonical planning state is missing, and replanning restores CURRENT', async () => {
    const f = await createFullyPlannedProject()
    await request(app)
      .post(`/api/projects/${f.projectId}/planning/reset`)
      .set('Authorization', authHeader)
      .send({ confirm: true })

    // Completion without any plan → actionable findings, state unchanged.
    const incomplete = await request(app)
      .post(`/api/projects/${f.projectId}/planning/complete`)
      .set('Authorization', authHeader)
    expect(incomplete.status).toBe(422)
    expect(incomplete.body.code).toBe('REPLAN_INCOMPLETE')
    expect(incomplete.body.findings.length).toBeGreaterThan(0)
    const still = await prisma.project.findUnique({ where: { id: f.projectId } })
    expect(still!.planningState).toBe('NEEDS_REPLAN')

    // Build the new plan through the normal supported surface: "As needed /
    // demand-following" ROLE profile for the role…
    const roleProfile = await request(app)
      .put(`/api/projects/${f.projectId}/capacity-profiles/ROLE/${f.rtId}`)
      .set('Authorization', authHeader)
      .send({ planningBasis: 'DEMAND_FOLLOWING', defaultPercent: 100 })
    expect(roleProfile.status).toBe(200)

    // …and a NAMED_PERSON profile for the preserved user-authored resource.
    const namedProfile = await request(app)
      .put(`/api/projects/${f.projectId}/capacity-profiles/NAMED_PERSON/${f.userNrId}`)
      .set('Authorization', authHeader)
      .send({ planningBasis: 'DEMAND_FOLLOWING', defaultPercent: 100 })
    expect(namedProfile.status).toBe(200)

    // Still not complete: the planner placeholder was removed, but the role
    // profile exists → completeness passes now. Completion flips to CURRENT.
    const complete = await request(app)
      .post(`/api/projects/${f.projectId}/planning/complete`)
      .set('Authorization', authHeader)
    expect(complete.status).toBe(200)
    expect(complete.body.planningState).toBe('CURRENT')

    // Timeline scheduling now works against the new plan.
    const schedule = await request(app)
      .post(`/api/projects/${f.projectId}/timeline/schedule`)
      .set('Authorization', authHeader)
      .send({})
    expect(schedule.status).toBe(200)
    expect(schedule.body.entries.length).toBeGreaterThan(0)

    const timeline = await request(app)
      .get(`/api/projects/${f.projectId}/timeline`)
      .set('Authorization', authHeader)
    expect(timeline.status).toBe(200)
    expect(timeline.body.entries.length).toBeGreaterThan(0)
  })

  it('Squad Planner apply works after reset as a replanning path, then completes', async () => {
    // Squad Planner replanning: roles only, no user-authored named resources.
    const project = await prisma.project.create({
      data: {
        name: `Squad replan ${Date.now()}`,
        status: 'ACTIVE',
        ownerId: userId,
        resourceTypes: { create: [{ name: 'Engineer', category: 'ENGINEERING', count: 2 }] },
      },
      include: { resourceTypes: true },
    })
    const rtId = project.resourceTypes[0]!.id

    await request(app)
      .post(`/api/projects/${project.id}/planning/reset`)
      .set('Authorization', authHeader)
      .send({ confirm: true })

    // Apply a squad plan (the supported Squad Planner replanning path).
    const apply = await request(app)
      .post(`/api/projects/${project.id}/squad-plan/apply`)
      .set('Authorization', authHeader)
      .send({
        name: 'Squad plan',
        targetWeeks: 8,
        periodWeeks: 4,
        maxDelta: 1,
        periods: [{
          periodIndex: 0,
          startWeek: 0,
          endWeek: 4,
          entries: [{ resourceTypeId: rtId, headcount: 2, demandFTE: 1, utilisationPct: 50 }],
        }],
      })
    expect(apply.status).toBe(201)

    // Canonical validation passes after apply → completion returns CURRENT.
    const complete = await request(app)
      .post(`/api/projects/${project.id}/planning/complete`)
      .set('Authorization', authHeader)
    expect(complete.status).toBe(200)
    expect(complete.body.planningState).toBe('CURRENT')

    const state = await prisma.project.findUnique({ where: { id: project.id } })
    expect(state!.planningState).toBe('CURRENT')
  })
})

describeIf('Readiness with NEEDS_REPLAN (issue #449)', () => {
  it('allows expected quarantine while still requiring canonical CURRENT projects', async () => {
    // CURRENT project with missing profiles → readiness fails.
    const broken = await createFullyPlannedProject()
    await prisma.capacityProfile.deleteMany({ where: { projectId: broken.projectId } })
    const before = await runProductionMigrationReadiness(prisma)
    expect(before.passed).toBe(false)

    // Same project quarantined via the product reset → per-project section passes.
    await request(app)
      .post(`/api/projects/${broken.projectId}/planning/reset`)
      .set('Authorization', authHeader)
      .send({ confirm: true })
    const after = await runProductionMigrationReadiness(prisma)
    expect(after.passed).toBe(true)
    expect(formatReadinessReport(after)).toContain('NEEDS_REPLAN')
  })
})

describeIf('Reviewed production maintenance classification (issue #449 / #404)', () => {  it('dry-run reports, apply classifies via the same reset transaction', async () => {
    const f = await createFullyPlannedProject()
    const manifest = parseClassifyManifest({ projectIds: [f.projectId] })

    // Dry run: zero writes.
    const dry = await classifyNeedsReplan(prisma, manifest)
    expect(dry.classifiedCount).toBe(1)
    const afterDry = await prisma.project.findUnique({ where: { id: f.projectId } })
    expect(afterDry!.planningState).toBe('CURRENT')
    expect(await prisma.capacityProfile.count({ where: { projectId: f.projectId } })).toBeGreaterThan(0)

    // Apply: classifies via the atomic reset (planning cleared, business kept).
    const applied = await classifyNeedsReplan(prisma, manifest, { apply: true })
    expect(applied.classifiedCount).toBe(1)
    const afterApply = await prisma.project.findUnique({ where: { id: f.projectId } })
    expect(afterApply!.planningState).toBe('NEEDS_REPLAN')
    expect(await prisma.capacityProfile.count({ where: { projectId: f.projectId } })).toBe(0)
    expect(await prisma.task.count({ where: { userStory: { feature: { epic: { projectId: f.projectId } } } } })).toBeGreaterThan(0)

    // Idempotent re-run: already NEEDS_REPLAN is skipped.
    const again = await classifyNeedsReplan(prisma, manifest, { apply: true })
    expect(again.alreadyCount).toBe(1)
    expect(again.classifiedCount).toBe(0)

    // Fails closed for a missing project.
    const badManifest = parseClassifyManifest({ projectIds: [f.projectId, 'does-not-exist'] })
    await expect(classifyNeedsReplan(prisma, badManifest, { apply: true })).rejects.toThrow('no longer exist')
  })
})
