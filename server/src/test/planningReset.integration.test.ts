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
import { classifyNeedsReplan, parseClassifyManifest, computeClassificationFingerprint, ClassifyAbortError, type ClassificationReport } from '../lib/classifyNeedsReplan.js'
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

  it('removes proven legacy Squad Planner placeholders and preserves ambiguous ones', async () => {
    const f = await createFullyPlannedProject()

    // A proven legacy planner placeholder: NAMED_PERSON profile with the
    // SQUAD_PLANNER + CAPACITY_PROFILE markers (isLegacyPlannerProfile).
    const legacyRt = await prisma.resourceType.create({
      data: {
        projectId: f.projectId,
        name: 'Legacy Planner Role',
        category: 'ENGINEERING',
        count: 1,
        hoursPerDay: 7.6,
      },
    })
    const legacyNr = await prisma.namedResource.create({
      data: { resourceTypeId: legacyRt.id, name: 'Legacy Planner Person', pricingModel: 'ACTUAL_DAYS' },
    })
    const legacyProfile = await prisma.capacityProfile.create({
      data: {
        projectId: f.projectId,
        resourceTypeId: null,
        namedResourceId: legacyNr.id,
        ownerKind: 'NAMED_PERSON',
        source: 'SQUAD_PLANNER',
        planningBasis: 'CAPACITY_PROFILE',
        defaultPercent: 100,
        startWeek: 0,
        endWeek: 10,
      },
    })
    await prisma.capacitySegment.create({
      data: {
        capacityProfileId: legacyProfile.id,
        startWeek: 0,
        endWeek: 10,
        capacityPercent: 100,
        source: 'SQUAD_PLANNER',
      },
    })

    // An ambiguous row that must be preserved: a NAMED_PERSON profile that
    // does NOT satisfy the safe planner-provenance rule (MANUAL source), i.e.
    // a real user-authored resource.
    const ambiguousRt = await prisma.resourceType.create({
      data: {
        projectId: f.projectId,
        name: 'Ambiguous Role',
        category: 'ENGINEERING',
        count: 1,
        hoursPerDay: 7.6,
      },
    })
    const ambiguousNr = await prisma.namedResource.create({
      data: { resourceTypeId: ambiguousRt.id, name: 'Bob', pricingModel: 'PRO_RATA' },
    })
    await prisma.capacityProfile.create({
      data: {
        projectId: f.projectId,
        namedResourceId: ambiguousNr.id,
        ownerKind: 'NAMED_PERSON',
        source: 'MANUAL',
        planningBasis: 'WHOLE_PROJECT_ALLOCATION',
        defaultPercent: 100,
      },
    })

    await resetProjectPlanning(prisma, f.projectId)

    const nr = await prisma.namedResource.findMany({ where: { resourceType: { projectId: f.projectId } } })
    const nrIds = nr.map(n => n.id)
    // PLANNED_RESOURCE placeholder removed (existing behaviour)…
    expect(nrIds).not.toContain(f.plannedNrId)
    // …and the proven LEGACY planner placeholder is removed too.
    expect(nrIds).not.toContain(legacyNr.id)
    // Real user-authored NAMED_PERSON resources survive with identity intact,
    // including the ambiguous row and the fixture's ordinary resource.
    const preserved = [f.userNrId, ambiguousNr.id]
    for (const id of preserved) {
      const row = nr.find(n => n.id === id)
      expect(row).toBeDefined()
    }
    const alice = nr.find(n => n.id === f.userNrId)!
    expect(alice.pricingModel).toBe('PRO_RATA')
    const bob = nr.find(n => n.id === ambiguousNr.id)!
    expect(bob.pricingModel).toBe('PRO_RATA')
    expect(bob.resourceTypeId).toBe(ambiguousRt.id)
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
    // A preserved role with NO task demand: the replanning surface must still
    // expose it so its profile can be created before completion.
    const zeroDemandRt = await prisma.resourceType.create({
      data: {
        projectId: f.projectId,
        name: 'Designer',
        category: 'ENGINEERING',
        count: 1,
        hoursPerDay: 7.6,
        dayRate: 400,
      },
    })
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
    const demandRow = rp.body.resourceRows.find((r: { resourceTypeId: string }) => r.resourceTypeId === f.rtId)
    expect(demandRow.totalHours).toBe(16)
    expect(rp.body.summary.totalCost).toBeNull()
    expect(demandRow.namedResources).toHaveLength(1) // Alice preserved

    // Every preserved role is visible, including the zero-demand one.
    const rowIds = rp.body.resourceRows.map((r: { resourceTypeId: string }) => r.resourceTypeId)
    expect(rowIds).toContain(f.rtId)
    expect(rowIds).toContain(zeroDemandRt.id)
    const zeroRow = rp.body.resourceRows.find((r: { resourceTypeId: string }) => r.resourceTypeId === zeroDemandRt.id)
    // Real identity, zero demand, no fabricated capacity.
    expect(zeroRow.name).toBe('Designer')
    expect(zeroRow.count).toBe(1)
    expect(zeroRow.dayRate).toBe(400)
    expect(zeroRow.totalHours).toBe(0)
    expect(zeroRow.effortDays).toBe(0)
    expect(zeroRow.totalDays).toBe(0)
    expect(zeroRow.allocatedDays).toBe(0)
    expect(zeroRow.estimatedCost).toBeNull()

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

describeIf('Reviewed production maintenance classification (issue #449 / #404)', () => {
  it('dry-run emits the reviewed fingerprint; apply with it classifies via the reset body', async () => {
    const f = await createFullyPlannedProject()
    const manifest = parseClassifyManifest({ projectIds: [f.projectId] })

    // Dry run: zero writes, emits the deterministic reviewed-state fingerprint.
    const dry = await classifyNeedsReplan(prisma, manifest)
    expect(dry.classifiedCount).toBe(1)
    expect(dry.stateFingerprint).toMatch(/^[0-9a-f]{64}$/)
    const afterDry = await prisma.project.findUnique({ where: { id: f.projectId } })
    expect(afterDry!.planningState).toBe('CURRENT')
    expect(await prisma.capacityProfile.count({ where: { projectId: f.projectId } })).toBeGreaterThan(0)

    // Apply with the exact reviewed fingerprint: atomic classification
    // (planning cleared, business kept).
    const applied = await classifyNeedsReplan(prisma, manifest, {
      apply: true,
      expectedFingerprint: dry.stateFingerprint,
    })
    expect(applied.classifiedCount).toBe(1)
    expect(applied.stateFingerprint).toBe(dry.stateFingerprint)
    const afterApply = await prisma.project.findUnique({ where: { id: f.projectId } })
    expect(afterApply!.planningState).toBe('NEEDS_REPLAN')
    expect(await prisma.capacityProfile.count({ where: { projectId: f.projectId } })).toBe(0)
    expect(await prisma.task.count({ where: { userStory: { feature: { epic: { projectId: f.projectId } } } } })).toBeGreaterThan(0)

    // Idempotent re-run with the NEW reviewed state: already NEEDS_REPLAN is
    // skipped — but only with a fingerprint matching the new state.
    const freshDry = await classifyNeedsReplan(prisma, manifest)
    expect(freshDry.stateFingerprint).not.toBe(dry.stateFingerprint)
    const again = await classifyNeedsReplan(prisma, manifest, {
      apply: true,
      expectedFingerprint: freshDry.stateFingerprint,
    })
    expect(again.alreadyCount).toBe(1)
    expect(again.classifiedCount).toBe(0)

    // The stale (pre-apply) fingerprint now REFUSES — idempotence never
    // weakens drift detection.
    await expect(
      classifyNeedsReplan(prisma, manifest, { apply: true, expectedFingerprint: dry.stateFingerprint }),
    ).rejects.toThrow(/does not match the reviewed fingerprint/)

    // Fails closed for a missing project: the stale reviewed fingerprint no
    // longer matches (existence drift) and nothing is written.
    const badManifest = parseClassifyManifest({ projectIds: [f.projectId, 'does-not-exist'] })
    await expect(
      classifyNeedsReplan(prisma, badManifest, { apply: true, expectedFingerprint: dry.stateFingerprint }),
    ).rejects.toThrow(ClassifyAbortError)
  })

  it('refuses apply on reset-relevant drift with zero changes to any project', async () => {
    const f = await createFullyPlannedProject()
    const manifest = parseClassifyManifest({ projectIds: [f.projectId] })

    const dry = await classifyNeedsReplan(prisma, manifest)

    // One reset-relevant field changes after review: the weekly demand cache.
    await prisma.project.update({
      where: { id: f.projectId },
      data: { weeklyDemandCache: { 'rt-changed|3': 7 } },
    })

    await expect(
      classifyNeedsReplan(prisma, manifest, { apply: true, expectedFingerprint: dry.stateFingerprint }),
    ).rejects.toThrow(/does not match the reviewed fingerprint/)

    // Zero writes: the project and all planning state remain untouched.
    const state = await prisma.project.findUnique({ where: { id: f.projectId } })
    expect(state!.planningState).toBe('CURRENT')
    expect(state!.weeklyDemandCache).toEqual({ 'rt-changed|3': 7 })
    expect(await prisma.capacityProfile.count({ where: { projectId: f.projectId } })).toBe(3)
    expect(await prisma.capacityPlan.count({ where: { projectId: f.projectId } })).toBe(1)
    expect(await prisma.timelineEntry.count({ where: { projectId: f.projectId } })).toBe(1)
  })

  it('rolls the whole batch back when a later project fails (no partial classification)', async () => {
    const f1 = await createFullyPlannedProject()
    const f2 = await createFullyPlannedProject()
    const manifest = parseClassifyManifest({ projectIds: [f1.projectId, f2.projectId] })

    const dry = await classifyNeedsReplan(prisma, manifest)
    expect(dry.classifiedCount).toBe(2)

    // Inject a failure while resetting the SECOND project.
    let resets = 0
    await expect(
      classifyNeedsReplan(prisma, manifest, {
        apply: true,
        expectedFingerprint: dry.stateFingerprint,
        afterProjectReset: async (_tx, projectId) => {
          resets++
          if (projectId === f2.projectId) {
            throw new Error('injected batch failure')
          }
        },
      }),
    ).rejects.toThrow('injected batch failure')
    expect(resets).toBe(2)

    // The whole batch rolled back: the FIRST project was not left quarantined
    // and its planning data is intact.
    const state1 = await prisma.project.findUnique({ where: { id: f1.projectId } })
    expect(state1!.planningState).toBe('CURRENT')
    expect(await prisma.capacityProfile.count({ where: { projectId: f1.projectId } })).toBe(3)
    expect(await prisma.capacityPlan.count({ where: { projectId: f1.projectId } })).toBe(1)
    expect(await prisma.timelineEntry.count({ where: { projectId: f1.projectId } })).toBe(1)

    const state2 = await prisma.project.findUnique({ where: { id: f2.projectId } })
    expect(state2!.planningState).toBe('CURRENT')
  })

  it('applies a multi-project manifest atomically on unchanged state', async () => {
    const f1 = await createFullyPlannedProject()
    const f2 = await createFullyPlannedProject()
    const manifest = parseClassifyManifest({ projectIds: [f1.projectId, f2.projectId] })

    const dry = await classifyNeedsReplan(prisma, manifest)
    const applied = await classifyNeedsReplan(prisma, manifest, {
      apply: true,
      expectedFingerprint: dry.stateFingerprint,
    })

    expect(applied.classifiedCount).toBe(2)
    for (const f of [f1, f2]) {
      const state = await prisma.project.findUnique({ where: { id: f.projectId } })
      expect(state!.planningState).toBe('NEEDS_REPLAN')
      expect(await prisma.capacityProfile.count({ where: { projectId: f.projectId } })).toBe(0)
      // Preserved business data remains intact.
      expect(await prisma.task.count({ where: { userStory: { feature: { epic: { projectId: f.projectId } } } } })).toBeGreaterThan(0)
      expect(await prisma.projectDiscount.count({ where: { projectId: f.projectId } })).toBe(1)
    }
  })

  it('dry-run report and fingerprint come from one consistent snapshot', async () => {
    const f = await createFullyPlannedProject()
    const manifest = parseClassifyManifest({ projectIds: [f.projectId] })

    // The project is already NEEDS_REPLAN: the dry run's classification must
    // describe that state.
    await prisma.project.update({
      where: { id: f.projectId },
      data: { planningState: 'NEEDS_REPLAN' },
    })

    // A second real connection flips reset-relevant state to CURRENT while
    // the dry-run transaction is open, between the classification read and
    // the fingerprint read. Without one consistent snapshot the fingerprint
    // would describe the NEW state while the report describes the OLD one.
    const prisma2 = new PrismaClient({
      adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
    })
    await prisma2.$connect()

    let seamReached: () => void = () => {}
    const seamReachedPromise = new Promise<void>(resolve => { seamReached = resolve })
    let release: () => void = () => {}
    const gate = new Promise<void>(resolve => { release = resolve })

    const promise = classifyNeedsReplan(prisma, manifest, {
      afterPlanRead: async () => {
        seamReached()
        await gate
      },
    })
    await seamReachedPromise
    await prisma2.project.update({
      where: { id: f.projectId },
      data: { planningState: 'CURRENT' },
    })
    release()

    let report: ClassificationReport
    try {
      report = await promise
    } finally {
      await prisma2.$disconnect()
    }

    // The report saw NEEDS_REPLAN (snapshot taken before the concurrent flip).
    expect(report.alreadyCount).toBe(1)
    expect(report.stateFingerprint).toMatch(/^[0-9a-f]{64}$/)
    // Zero writes: the flip is the ONLY state change.
    expect((await prisma.project.findUnique({ where: { id: f.projectId } }))!.planningState).toBe('CURRENT')

    // The fingerprint describes the SAME snapshot as the report: it matches a
    // fingerprint over the state as read (NEEDS_REPLAN), and differs from the
    // post-commit state (CURRENT).
    const freshNow = await computeClassificationFingerprint(prisma, manifest)
    expect(report.stateFingerprint).not.toBe(freshNow)
    await prisma.project.update({
      where: { id: f.projectId },
      data: { planningState: 'NEEDS_REPLAN' },
    })
    const snapshotStateFingerprint = await computeClassificationFingerprint(prisma, manifest)
    expect(report.stateFingerprint).toBe(snapshotStateFingerprint)
  })

  it('Serializable isolation rolls the whole batch back when reset-relevant state changes concurrently', async () => {
    const f1 = await createFullyPlannedProject()
    const f2 = await createFullyPlannedProject()
    const manifest = parseClassifyManifest({ projectIds: [f1.projectId, f2.projectId] })

    const dry = await classifyNeedsReplan(prisma, manifest)

    // A second real connection mutates state while the apply is in flight.
    const prisma2 = new PrismaClient({
      adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
    })
    await prisma2.$connect()

    // Narrow test seam: hold the batch AFTER the fingerprint reads and the
    // FIRST project's (uncommitted) reset, BEFORE the second project's
    // destructive writes. No production synchronization code is involved.
    let seamReached: () => void = () => {}
    const seamReachedPromise = new Promise<void>(resolve => { seamReached = resolve })
    let release: () => void = () => {}
    const gate = new Promise<void>(resolve => { release = resolve })

    let applyPromise: Promise<ClassificationReport> | null = null
    try {
      applyPromise = classifyNeedsReplan(prisma, manifest, {
        apply: true,
        expectedFingerprint: dry.stateFingerprint,
        afterProjectReset: async (_tx, projectId) => {
          if (projectId === f1.projectId) {
            seamReached()
            await gate
          }
        },
      })

      // Wait for the apply to be paused at the seam, then commit a concurrent
      // change to reset-relevant state of the SECOND project (a segment row
      // the reviewed fingerprint covered).
      await seamReachedPromise
      const seg = await prisma2.capacitySegment.findFirst({
        where: { capacityProfile: { projectId: f2.projectId } },
      })
      expect(seg).not.toBeNull()
      await prisma2.capacitySegment.update({
        where: { id: seg!.id },
        data: { capacityPercent: 77 },
      })
    } finally {
      release()
      if (applyPromise) {
        // The apply must fail with the serialization-conflict mapping, not
        // commit the stale review: the concurrent write was never part of the
        // reviewed fingerprint and must not be destroyed.
        await expect(applyPromise).rejects.toThrow(/changed concurrently/)
      }
      await prisma2.$disconnect()
    }

    // Whole batch rolled back: neither project became NEEDS_REPLAN…
    const state1 = await prisma.project.findUnique({ where: { id: f1.projectId } })
    expect(state1!.planningState).toBe('CURRENT')
    const state2 = await prisma.project.findUnique({ where: { id: f2.projectId } })
    expect(state2!.planningState).toBe('CURRENT')

    // …no partial deletion of prior planning state…
    expect(await prisma.capacityProfile.count({ where: { projectId: f1.projectId } })).toBe(3)
    expect(await prisma.capacityPlan.count({ where: { projectId: f1.projectId } })).toBe(1)
    expect(await prisma.capacityProfile.count({ where: { projectId: f2.projectId } })).toBe(3)

    // …and the concurrently committed mutation survived.
    const segAfter = await prisma.capacitySegment.findFirst({
      where: { capacityProfile: { projectId: f2.projectId } },
    })
    expect(segAfter!.capacityPercent).toBe(77)
  })
})
