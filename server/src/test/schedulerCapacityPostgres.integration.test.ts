/**
 * schedulerCapacityPostgres.integration.test.ts — Real PostgreSQL integration tests
 * for issue #362 profile-first scheduler capacity resolution.
 *
 * Tests that database-loaded persisted profiles drive scheduler capacity correctly,
 * that stale legacy windows do not truncate profile-backed scheduling, and that
 * role-level profiles affect weekly scheduler capacity.
 *
 * Skipped unless INTEGRATION_TEST=true.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '@prisma/client'
import { app } from '../app.js'

vi.mock('../lib/prisma.js', async (importOriginal) => {
  return await importOriginal()
})

const runIntegration = process.env.INTEGRATION_TEST === 'true'
const describeIf = runIntegration ? describe : describe.skip

let prisma: PrismaClient
let userId: string
let token: string
let authHeader: string

const USER_EMAIL = 'scheduler-capacity-362-integration@example.com'
const PROJ_NAME = 'Scheduler Capacity Integration #362'

let projectId: string
let rtLegacyId: string
let rtProfileFixedId: string
let rtProfileSegmentedId: string
let rtRoleId: string
let rtCapPlanWithProfileId: string
let rtCapPlanOnlyId: string
let rtSquadPlannerId: string
beforeAll(async () => {
  if (!runIntegration) return
  prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
  })
  await prisma.$connect()

  const user = await prisma.user.upsert({
    where: { email: USER_EMAIL },
    create: { email: USER_EMAIL, name: 'SC Integration', password: '$2b$10$placeholder' },
    update: {},
  })
  userId = user.id
  token = jwt.sign({ userId, role: 'USER' }, process.env.JWT_SECRET!)
  authHeader = `Bearer ${token}`

  const project = await prisma.project.create({
    data: { name: PROJ_NAME, hoursPerDay: 8, ownerId: userId },
  })
  projectId = project.id

  // ── Legacy-only resource type (no profile, count=2) ───────────────────
  const rtLegacy = await prisma.resourceType.create({
    data: { name: 'LegacyRole', category: 'ENGINEERING', count: 2, hoursPerDay: 8, allocationMode: 'EFFORT', projectId },
  })
  rtLegacyId = rtLegacy.id

  // ── Profile-backed fixed NR with stale legacy window ──────────────────
  const rtFixed = await prisma.resourceType.create({
    data: { name: 'ProfileFixed', category: 'ENGINEERING', count: 1, hoursPerDay: 8, allocationMode: 'FULL_PROJECT', allocationPercent: 100, allocationStartWeek: 5, allocationEndWeek: 10, projectId },
  })
  rtProfileFixedId = rtFixed.id
  const nrStale = await prisma.namedResource.create({
    data: { resourceTypeId: rtFixed.id, name: 'StaleLegacy', startWeek: 5, endWeek: 10, allocationPct: 100, allocationMode: 'FULL_PROJECT', allocationPercent: 100, allocationStartWeek: 5, allocationEndWeek: 10 },
  })
  await prisma.capacityProfile.create({
    data: { projectId, resourceTypeId: null, namedResourceId: nrStale.id, ownerKind: 'NAMED_PERSON', planningBasis: 'WHOLE_PROJECT_ALLOCATION', source: 'FIXED', defaultPercent: 100 },
  })

  // ── Profile-backed segmented NR ───────────────────────────────────────
  const rtSeg = await prisma.resourceType.create({
    data: { name: 'ProfileSegmented', category: 'ENGINEERING', count: 1, hoursPerDay: 8, allocationMode: 'EFFORT', projectId },
  })
  rtProfileSegmentedId = rtSeg.id
  const nrSeg = await prisma.namedResource.create({
    data: { resourceTypeId: rtSeg.id, name: 'SegmentedNR', allocationPct: 100, allocationMode: 'EFFORT', allocationPercent: 100 },
  })
  await prisma.capacityProfile.create({
    data: { projectId, resourceTypeId: null, namedResourceId: nrSeg.id, ownerKind: 'NAMED_PERSON', planningBasis: 'CAPACITY_PROFILE', source: 'MANUAL', segments: { create: [{ startWeek: 0, endWeek: 2, capacityPercent: 100, source: 'MANUAL' }, { startWeek: 5, endWeek: 7, capacityPercent: 50, source: 'MANUAL' }] } },
  })

  // ── Role-level profile (count=3, profile says 50% weeks 2-6) ──────────
  const rtRole = await prisma.resourceType.create({
    data: { name: 'RoleProfile', category: 'ENGINEERING', count: 3, hoursPerDay: 8, allocationMode: 'EFFORT', projectId },
  })
  rtRoleId = rtRole.id
  await prisma.capacityProfile.create({
    data: { projectId, resourceTypeId: rtRole.id, namedResourceId: null, ownerKind: 'ROLE', planningBasis: 'AVAILABILITY_WINDOW', source: 'MANUAL', defaultPercent: 50, startWeek: 2, endWeek: 6 },
  })

  // ── CAPACITY_PLAN RT with profile + conflicting active plan ───────────
  const rtCapPlan = await prisma.resourceType.create({
    data: { name: 'CapPlanWithProfile', category: 'ENGINEERING', count: 5, hoursPerDay: 8, allocationMode: 'CAPACITY_PLAN', projectId },
  })
  rtCapPlanWithProfileId = rtCapPlan.id
  const nrCapPlan = await prisma.namedResource.create({
    data: { resourceTypeId: rtCapPlan.id, name: 'CapPlanNR', allocationPct: 100, allocationMode: 'CAPACITY_PLAN', allocationPercent: 100 },
  })
  await prisma.capacityProfile.create({
    data: { projectId, resourceTypeId: null, namedResourceId: nrCapPlan.id, ownerKind: 'NAMED_PERSON', planningBasis: 'WHOLE_PROJECT_ALLOCATION', source: 'FIXED', defaultPercent: 25 },
  })
  await prisma.capacityPlan.create({
    data: { projectId, name: 'Conflicting Plan', targetWeeks: 10, periodWeeks: 4, isActive: true, periods: { create: [{ periodIndex: 0, startWeek: 0, endWeek: 9, entries: { create: [{ resourceTypeId: rtCapPlan.id, headcount: 1, demandFTE: 1, utilisationPct: 100 }] } }] } },
  })

  // ── CAPACITY_PLAN RT without profile (plan fallback applies) ──────────
  const rtCapPlanOnly = await prisma.resourceType.create({
    data: { name: 'CapPlanOnly', category: 'ENGINEERING', count: 1, hoursPerDay: 8, allocationMode: 'CAPACITY_PLAN', projectId },
  })
  rtCapPlanOnlyId = rtCapPlanOnly.id

  // ── Squad Planner composition fixture ────────────────────────────
  const rtSquad = await prisma.resourceType.create({
    data: { name: 'SquadPlannerRole', category: 'ENGINEERING', count: 3, hoursPerDay: 8, allocationMode: 'EFFORT', projectId },
  })
  rtSquadPlannerId = rtSquad.id
  // Two planned-resource NRs
  const nrSP1 = await prisma.namedResource.create({
    data: { resourceTypeId: rtSquad.id, name: 'SP Planned 1', allocationPct: 100, allocationMode: 'EFFORT', allocationPercent: 100 },
  })
  const nrSP2 = await prisma.namedResource.create({
    data: { resourceTypeId: rtSquad.id, name: 'SP Planned 2', allocationPct: 100, allocationMode: 'EFFORT', allocationPercent: 50 },
  })
  // Aggregate ROLE profile (SQUAD_PLANNER source)
  await prisma.capacityProfile.create({
    data: { projectId, resourceTypeId: rtSquad.id, namedResourceId: null, ownerKind: 'ROLE', planningBasis: 'CAPACITY_PROFILE', source: 'SQUAD_PLANNER', defaultPercent: 150 },
  })
  await prisma.capacityProfile.create({
    data: { projectId, resourceTypeId: null, namedResourceId: nrSP1.id, ownerKind: 'PLANNED_RESOURCE', planningBasis: 'CAPACITY_PROFILE', source: 'SQUAD_PLANNER', defaultPercent: 100, segments: { create: [{ startWeek: 0, endWeek: 10, capacityPercent: 100, source: 'SQUAD_PLANNER' }] } },
  })
  // PLANNED_RESOURCE profile 2 (SQUAD_PLANNER source)
  await prisma.capacityProfile.create({
    data: { projectId, resourceTypeId: null, namedResourceId: nrSP2.id, ownerKind: 'PLANNED_RESOURCE', planningBasis: 'CAPACITY_PROFILE', source: 'SQUAD_PLANNER', defaultPercent: 50, segments: { create: [{ startWeek: 0, endWeek: 10, capacityPercent: 50, source: 'SQUAD_PLANNER' }] } },
  })
  // ── /Squad Planner fixture ──────────────────────────────────────────────

  // ── Timeline fixture ──────────────────────────────────────────────────
  const epic = await prisma.epic.create({ data: { name: 'Test Epic', projectId, order: 0 } })
  const feature = await prisma.feature.create({ data: { name: 'Test Feature', epicId: epic.id, order: 0 } })
  await prisma.timelineEntry.create({ data: { projectId, featureId: feature.id, startWeek: 0, durationWeeks: 1, isManual: false } })
})
afterAll(async () => {
  if (!runIntegration) return
  await prisma.capacitySegment.deleteMany({ where: { capacityProfile: { projectId } } })
  await prisma.capacityProfile.deleteMany({ where: { projectId } })
  await prisma.namedResource.deleteMany({ where: { resourceType: { projectId } } })
  await prisma.resourceType.deleteMany({ where: { projectId } })
  await prisma.timelineEntry.deleteMany({ where: { projectId } })
  await prisma.feature.deleteMany({ where: { epic: { projectId } } })
  await prisma.epic.deleteMany({ where: { projectId } })
  await prisma.project.delete({ where: { id: projectId } })
  await prisma.user.delete({ where: { id: userId } })
  await prisma.$disconnect()
})

describeIf('Scheduler capacity PostgreSQL integration', () => {
  it('1. profile overrides stale legacy window', async () => {
    const { getWeeklyCapacity } = await import('../lib/scheduler.js')
    const { resolveSchedulerCapacity } = await import('../lib/schedulerCapacityResolver.js')
    const resolved = await resolveSchedulerCapacity(prisma, projectId, 8)
    const rt = resolved.resourceTypes.find(r => r.id === rtProfileFixedId)!
    expect(rt).toBeDefined()
    expect(rt.namedResources).toHaveLength(1)
    const nr = rt.namedResources[0]
    expect(nr.capacitySegments).toBeDefined()
    expect(nr.capacitySegments!.length).toBe(1)
    // Whole-project profile → segment covers week 0, not legacy 5
    expect(nr.capacitySegments![0].startWeek).toBe(0)
    expect(getWeeklyCapacity(rt, 0, 8)).toBe(40) // week 0, not truncated
    expect(getWeeklyCapacity(rt, 3, 8)).toBe(40) // mid, not truncated
  })

  it('2. segmented profile with zero gap is preserved', async () => {
    const { getWeeklyCapacity } = await import('../lib/scheduler.js')
    const { resolveSchedulerCapacity } = await import('../lib/schedulerCapacityResolver.js')
    const resolved = await resolveSchedulerCapacity(prisma, projectId, 8)
    const rt = resolved.resourceTypes.find(r => r.id === rtProfileSegmentedId)!
    const nr = rt.namedResources[0]
    expect(nr.capacitySegments).toHaveLength(2)
    expect(getWeeklyCapacity(rt, 1, 8)).toBe(40)  // 100% segment
    expect(getWeeklyCapacity(rt, 3, 8)).toBe(0)   // gap
    expect(getWeeklyCapacity(rt, 6, 8)).toBe(20)  // 50% segment
  })

  it('3. role profile populates roleSegments and drives capacity', async () => {
    const { getWeeklyCapacity } = await import('../lib/scheduler.js')
    const { resolveSchedulerCapacity } = await import('../lib/schedulerCapacityResolver.js')
    const resolved = await resolveSchedulerCapacity(prisma, projectId, 8)
    const rt = resolved.resourceTypes.find(r => r.id === rtRoleId)!
    expect(rt.roleSegments).toBeDefined()
    expect(rt.roleSegments!.length).toBe(1)
    expect(rt.roleSegments![0]).toEqual({ startWeek: 2, endWeek: 6, allocationPercent: 50 })
    // 50% × 8 × 5 = 20 (replaces 3 phantom × 40 = 120)
    expect(getWeeklyCapacity(rt, 3, 8)).toBe(20)
    expect(getWeeklyCapacity(rt, 1, 8)).toBe(0) // before window
    expect(getWeeklyCapacity(rt, 7, 8)).toBe(0) // after window
  })

  it('4. legacy-only RT retains phantom slots', async () => {
    const { getWeeklyCapacity } = await import('../lib/scheduler.js')
    const { resolveSchedulerCapacity } = await import('../lib/schedulerCapacityResolver.js')
    const resolved = await resolveSchedulerCapacity(prisma, projectId, 8)
    const rt = resolved.resourceTypes.find(r => r.id === rtLegacyId)!
    expect(rt.roleSegments).toBeUndefined()
    expect(getWeeklyCapacity(rt, 0, 8)).toBe(80) // 2 phantom × 40
  })
  it('5. profile suppresses conflicting active Capacity Plan — profile NR keeps 25%, no extra synthetics from 1-trajectory plan', async () => {
    const { getWeeklyCapacity } = await import('../lib/scheduler.js')
    const { resolveSchedulerCapacity } = await import('../lib/schedulerCapacityResolver.js')
    const resolved = await resolveSchedulerCapacity(prisma, projectId, 8)
    const rt = resolved.resourceTypes.find(r => r.id === rtCapPlanWithProfileId)!
    expect(rt).toBeDefined()
    // The plan has 1 trajectory at headcount=1. The single profiled NR keeps
    // its 25% without being overridden. No extra synthetics since there's
    // only 1 trajectory.
    expect(rt.namedResources).toHaveLength(1)
    expect(rt.namedResources[0].capacitySegments).toBeDefined()
    expect(rt.namedResources[0].capacitySegments![0].allocationPercent).toBe(25)
    // 25% × 8 × 5 = 10h/week (not the plan's 100% × 40 = 40h/week)
    expect(getWeeklyCapacity(rt, 0, 8)).toBe(10)
    expect(rt.capacityPlanResolved).toBe(true)
  })

  it('6. CAPACITY_PLAN without profile uses plan fallback', async () => {
    const { getWeeklyCapacity } = await import('../lib/scheduler.js')
    const { resolveSchedulerCapacity } = await import('../lib/schedulerCapacityResolver.js')
    const resolved = await resolveSchedulerCapacity(prisma, projectId, 8)
    const rt = resolved.resourceTypes.find(r => r.id === rtCapPlanOnlyId)!
    expect(rt).toBeDefined()
    // No profile, so capacity plan fallback should apply
    expect(getWeeklyCapacity(rt, 0, 8)).toBe(40)
  })

  it('7. Timeline schedule and GET return consistent weekly capacity with parity assertions', async () => {
    const { resolveSchedulerCapacity } = await import('../lib/schedulerCapacityResolver.js')
    const resolved = await resolveSchedulerCapacity(prisma, projectId, 8)

    const rtProfile = resolved.resourceTypes.find(r => r.id === rtProfileFixedId)!
    const rtRole = resolved.resourceTypes.find(r => r.id === rtRoleId)!
    const rtSquad = resolved.resourceTypes.find(r => r.id === rtSquadPlannerId)!
    expect(rtProfile).toBeDefined()
    expect(rtRole).toBeDefined()
    expect(rtSquad).toBeDefined()

    // Squad Planner overlap assertions (must be satisfied)
    expect(rtSquad.roleSegments).toEqual([])

    const scheduleRes = await request(app)
      .post(`/api/projects/${projectId}/timeline/schedule`)
      .set('Authorization', authHeader)
      .send({ resourceLevel: false })
    expect(scheduleRes.status).toBe(200)

    const timelineRes = await request(app)
      .get(`/api/projects/${projectId}/timeline`)
      .set('Authorization', authHeader)
    expect(timelineRes.status).toBe(200)

    // Verify weeklyCapacity contains actual capacity values for known RTs
    expect(timelineRes.body.weeklyCapacity).toBeDefined()
    expect(Array.isArray(timelineRes.body.weeklyCapacity)).toBe(true)
    expect(timelineRes.body.weeklyCapacity.length).toBeGreaterThan(0)

    // ProfileFixed RT: must be present with exact capacity (required assertion)
    const profileFixedCap = timelineRes.body.weeklyCapacity.find(
      (c: any) => c.resourceTypeName === 'ProfileFixed' && c.week === 0,
    )
    expect(profileFixedCap).toBeDefined()
    expect(profileFixedCap.capacityDays).toBe(5) // 40h / 8h = 5 days

    // RoleProfile RT at week 3: must be present with exact capacity
    const roleProfileCap = timelineRes.body.weeklyCapacity.find(
      (c: any) => c.resourceTypeName === 'RoleProfile' && c.week === 3,
    )
    expect(roleProfileCap).toBeDefined()
    expect(roleProfileCap.capacityDays).toBe(2.5) // 50% × 8 × 5 / 8 = 2.5 days

    // Squad Planner RT: capacity = 60h (100% + 50%), not 120h
    const squadCap = timelineRes.body.weeklyCapacity.find(
      (c: any) => c.resourceTypeName === 'SquadPlannerRole' && c.week === 0,
    )
    expect(squadCap).toBeDefined()
    expect(squadCap.capacityDays).toBe(7.5) // 60h / 8h = 7.5 days

    // Named-resource assignment parity: PR1 (100%) + PR2 (50%) = 1.5 FTE
    const { getWeeklyCapacity } = await import('../lib/scheduler.js')
    expect(getWeeklyCapacity(rtSquad, 0, 8)).toBe(60) // 100% + 50%

    // Deterministic
    const resolved2 = await resolveSchedulerCapacity(prisma, projectId, 8)
    expect(resolved.resourceTypes).toEqual(resolved2.resourceTypes)
  })

  it('8. Squad Planner 1.5 FTE composition: postgres fixture parity', async () => {
    const { getWeeklyCapacity } = await import('../lib/scheduler.js')
    const { resolveSchedulerCapacity } = await import('../lib/schedulerCapacityResolver.js')
    const { deriveNamedResourceAssignments } = await import('../lib/namedResourceAssignments.js')
    const { materializeCapacityPlanResources } = await import('../lib/capacityPlanMaterialisation.js')

    // Verify persisted profiles have correct sources
    const profiles = await prisma.capacityProfile.findMany({ where: { projectId, resourceTypeId: rtSquadPlannerId } })
    expect(profiles.length).toBeGreaterThanOrEqual(1)
    for (const p of profiles) {
      // Raw persisted sources must be SQUAD_PLANNER (the Prisma enum)
      if (p.ownerKind === 'ROLE') {
        expect(p.source).toBe('SQUAD_PLANNER')
      }
    }

    // Check planned-resource profiles
    const nrProfiles = await prisma.capacityProfile.findMany({
      where: { projectId, namedResourceId: { not: null }, ownerKind: 'PLANNED_RESOURCE' },
    })
    for (const p of nrProfiles) {
      expect(p.source).toBe('SQUAD_PLANNER')
    }

    // Resolve
    const resolved = await resolveSchedulerCapacity(prisma, projectId, 8)
    const rt = resolved.resourceTypes.find(r => r.id === rtSquadPlannerId)!

    // Resolver returns empty roleSegments (suppressed Squad Planner overlap)
    expect(rt.roleSegments).toEqual([])
    expect(rt.namedResources).toHaveLength(2)

    // Exact deterministic identity
    expect(rt.namedResources[0].id).toBeDefined()
    expect(rt.namedResources[1].id).toBeDefined()

    // 100% + 50% = 60h (not 150% role + 100% + 50% = 120h)
    expect(getWeeklyCapacity(rt, 0, 8)).toBe(60)

    // Named-resource assignment parity
    const capacityPlanByRt = materializeCapacityPlanResources([])
    const assignments = deriveNamedResourceAssignments({
      resourceTypes: [rt],
      weeklyDemand: Array.from({ length: 8 }, (_, w) => ({
        week: w,
        resourceTypeName: 'SquadPlannerRole',
        demandDays: 10,
      })),
      capacityPlanByRt,
    })
    const rtAssign = assignments.get(rtSquadPlannerId)!
    // PR1: 100% → 5d/wk, PR2: 50% → 2.5d/wk, total 7.5d/wk × 8 = 60d
    expect(rtAssign.actualAllocatedDays).toBeCloseTo(60, 5)
    expect(rtAssign.unallocatedDays).toBeCloseTo(20, 5) // 10d demand - 7.5d capacity = 2.5d/wk × 8

    // Deterministic
    const resolved2 = await resolveSchedulerCapacity(prisma, projectId, 8)
    expect(resolved.resourceTypes).toEqual(resolved2.resourceTypes)
  })
})
