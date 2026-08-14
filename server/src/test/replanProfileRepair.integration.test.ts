/**
 * replanProfileRepair.integration.test.ts — Real PostgreSQL integration tests
 * for issue #456: making a NEEDS_REPLAN Resource Profile actionable when ROLE
 * profiles are missing.
 *
 * Proves against real PostgreSQL:
 *   - the original defect shape: NEEDS_REPLAN project with several preserved
 *     role-only ResourceTypes and zero ROLE profiles;
 *   - GET /resource-profile marks missing persisted ROLE profiles
 *     (missingCapacityProfile) instead of presenting the draft as canonical;
 *   - completion returns REPLAN_INCOMPLETE with human-readable role names;
 *   - the bulk "Use role counts as As needed" action creates exactly one
 *     canonical ROLE profile per eligible role-only type, never overwrites
 *     existing profiles, never guesses named-resource ownership, is
 *     idempotent, is atomic on injected failure, and never transitions the
 *     project state;
 *   - after all profiles exist the existing completion returns the project
 *     to CURRENT and Timeline scheduling resumes; CURRENT rows carry no
 *     missing markers.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '@prisma/client'

import { app } from '../app.js'
import { applyRoleCountsAsNeeded } from '../lib/bulkAsNeededProfiles.js'
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
      email: `replan-repair-${Date.now()}@example.com`,
      name: 'Replan Profile Repair Integration Test',
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

beforeEach(() => vi.clearAllMocks())

// ─── Fixture ────────────────────────────────────────────────────────────────

interface ReplanFixture {
  projectId: string
  /** Role-only resource types (Engineer / Business Analyst / Data Scientist). */
  roleOnlyRtIds: string[]
  /** Resource type with a preserved user-authored named resource. */
  namedRtId: string
  namedResourceId: string
  /** Resource type with task demand. */
  demandedRtId: string
}

/**
 * Create a project with several preserved role-only ResourceTypes, one role
 * with a user-authored named resource, and one role with task demand — then
 * reset planning so every profile is discarded (the #456 defect shape).
 */
async function createNeedsReplanFixture(): Promise<ReplanFixture> {
  const project = await prisma.project.create({
    data: {
      name: `Replan repair fixture ${Date.now()}`,
      status: 'ACTIVE',
      hoursPerDay: 7.6,
      ownerId: userId,
      resourceTypes: {
        create: [
          { name: 'Engineer', category: 'ENGINEERING', count: 2 },
          { name: 'Business Analyst', category: 'PROJECT_MANAGEMENT', count: 1 },
          { name: 'Data Scientist', category: 'ENGINEERING', count: 1 },
          { name: 'Security Consultant', category: 'GOVERNANCE', count: 1 },
        ],
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
                    create: [{ name: 'Task 1', hoursEffort: 16, durationDays: 2 }],
                  },
                }],
              },
            }],
          },
        }],
      },
    },
    include: {
      resourceTypes: true,
      epics: { include: { features: { include: { userStories: { include: { tasks: true } } } } } },
    },
  })

  const rts = project.resourceTypes
  const roleOnlyRtIds = rts
    .filter(rt => rt.name !== 'Security Consultant')
    .map(rt => rt.id)
  const namedRt = rts.find(rt => rt.name === 'Security Consultant')!
  const demandedRt = rts.find(rt => rt.name === 'Engineer')!

  const task = project.epics[0]!.features[0]!.userStories[0]!.tasks[0]!
  await prisma.task.update({ where: { id: task.id }, data: { resourceTypeId: demandedRt.id } })

  // User-authored named resource — preserved by reset, profile discarded.
  const namedResource = await prisma.namedResource.create({
    data: { resourceTypeId: namedRt.id, name: 'Alice Example', pricingModel: 'PRO_RATA' },
  })
  await prisma.capacityProfile.create({
    data: {
      projectId: project.id,
      namedResourceId: namedResource.id,
      ownerKind: 'NAMED_PERSON',
      planningBasis: 'DEMAND_FOLLOWING',
      source: 'MANUAL',
      defaultPercent: 100,
    },
  })

  await request(app)
    .post(`/api/projects/${project.id}/planning/reset`)
    .set('Authorization', authHeader)
    .send({ confirm: true })

  return {
    projectId: project.id,
    roleOnlyRtIds,
    namedRtId: namedRt.id,
    namedResourceId: namedResource.id,
    demandedRtId: demandedRt.id,
  }
}

async function profileCount(projectId: string): Promise<number> {
  return prisma.capacityProfile.count({ where: { projectId } })
}

async function roleProfiles(projectId: string) {
  return prisma.capacityProfile.findMany({
    where: { projectId, ownerKind: 'ROLE' },
    orderBy: { resourceTypeId: 'asc' },
  })
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describeIf('NEEDS_REPLAN Resource Profile — missing ROLE profiles (issue #456)', () => {
  it('reproduces the defect shape: role-only types with no persisted ROLE profiles are marked missing', async () => {
    const f = await createNeedsReplanFixture()

    const res = await request(app)
      .get(`/api/projects/${f.projectId}/resource-profile`)
      .set('Authorization', authHeader)
    expect(res.status).toBe(200)
    expect(res.body.planningState).toBe('NEEDS_REPLAN')

    interface ProfileRowShape {
      resourceTypeId: string
      missingCapacityProfile?: boolean
      capacityProfile?: unknown
    }

    const byId = new Map<string, ProfileRowShape>(
      (res.body.resourceRows as ProfileRowShape[]).map(row => [row.resourceTypeId, row] as const),
    )
    // Zero persisted profiles anywhere.
    expect(await profileCount(f.projectId)).toBe(0)

    for (const rtId of f.roleOnlyRtIds) {
      const row = byId.get(rtId)
      expect(row, `row for ${rtId}`).toBeDefined()
      // The visible defect: the row must not present a persisted profile as
      // canonical state — it is marked as needing one.
      expect(row!.missingCapacityProfile).toBe(true)
      expect(row!.capacityProfile).toBeUndefined()
    }

    // The role with a preserved named resource is not role-only: its row is
    // not marked as needing a ROLE profile (the named-resource finding is
    // separate and manual).
    const namedRow = byId.get(f.namedRtId)
    expect(namedRow!.missingCapacityProfile).toBe(false)

    // Completion fails closed with the existing stable code…
    const incomplete = await request(app)
      .post(`/api/projects/${f.projectId}/planning/complete`)
      .set('Authorization', authHeader)
    expect(incomplete.status).toBe(422)
    expect(incomplete.body.code).toBe('REPLAN_INCOMPLETE')

    // …and the findings identify resources by their human-readable names.
    const joined = incomplete.body.findings.join(' | ')
    expect(joined).toContain('Engineer')
    expect(joined).toContain('Business Analyst')
    expect(joined).toContain('Data Scientist')
    expect(joined).toContain('Alice Example')
    expect(joined).not.toMatch(/lacks exactly one persisted ROLE profile \(resource type rt-/) // names, not bare ids

    const state = await prisma.project.findUnique({ where: { id: f.projectId } })
    expect(state!.planningState).toBe('NEEDS_REPLAN')
  })

  it('bulk As-needed creates exactly one canonical ROLE profile per eligible role-only type', async () => {
    const f = await createNeedsReplanFixture()

    const res = await request(app)
      .post(`/api/projects/${f.projectId}/capacity-profiles/bulk-as-needed`)
      .set('Authorization', authHeader)

    expect(res.status).toBe(200)
    expect(res.body.created).toBe(3)
    expect(res.body.planningState).toBe('NEEDS_REPLAN')

    const profiles = await roleProfiles(f.projectId)
    expect(profiles).toHaveLength(3)
    const byRt = new Map(profiles.map(p => [p.resourceTypeId, p]))
    for (const rtId of f.roleOnlyRtIds) {
      const profile = byRt.get(rtId)
      expect(profile, `profile for ${rtId}`).toBeDefined()
      expect(profile!.planningBasis).toBe('DEMAND_FOLLOWING')
      expect(profile!.source).toBe('MANUAL')
      expect(profile!.defaultPercent).toBe(100)
      expect(profile!.startWeek).toBeNull()
      expect(profile!.endWeek).toBeNull()
      expect(profile!.provenance).toBeNull()
    }
    // The named-resource role is NOT guessed: no ROLE profile was created.
    expect(byRt.has(f.namedRtId)).toBe(false)

    // The remaining named-resource finding stays visible by name.
    expect(res.body.remainingFindings.join(' | ')).toContain('Alice Example')

    // Project state untouched — completion owns the transition.
    const state = await prisma.project.findUnique({ where: { id: f.projectId } })
    expect(state!.planningState).toBe('NEEDS_REPLAN')
  })

  it('bulk As-needed is idempotent and never overwrites an existing persisted profile', async () => {
    const f = await createNeedsReplanFixture()

    // Give Engineer a profile through the normal editor first.
    const put = await request(app)
      .put(`/api/projects/${f.projectId}/capacity-profiles/ROLE/${f.demandedRtId}`)
      .set('Authorization', authHeader)
      .send({ planningBasis: 'DEMAND_FOLLOWING', defaultPercent: 100 })
    expect(put.status).toBe(200)

    const before = await roleProfiles(f.projectId)
    const engineerProfile = before.find(p => p.resourceTypeId === f.demandedRtId)!

    const first = await request(app)
      .post(`/api/projects/${f.projectId}/capacity-profiles/bulk-as-needed`)
      .set('Authorization', authHeader)
    expect(first.status).toBe(200)
    // Only the two still-missing role-only types are created.
    expect(first.body.created).toBe(2)

    const afterFirst = await roleProfiles(f.projectId)
    expect(afterFirst).toHaveLength(3)
    const engineerAfter = afterFirst.find(p => p.resourceTypeId === f.demandedRtId)!
    // The pre-existing profile was not replaced — same id, same semantics.
    expect(engineerAfter.id).toBe(engineerProfile.id)
    expect(engineerAfter.planningBasis).toBe('DEMAND_FOLLOWING')

    // Repeating the bulk action creates nothing (no duplicates).
    const second = await request(app)
      .post(`/api/projects/${f.projectId}/capacity-profiles/bulk-as-needed`)
      .set('Authorization', authHeader)
    expect(second.status).toBe(200)
    expect(second.body.created).toBe(0)
    expect(await roleProfiles(f.projectId)).toHaveLength(3)
  })

  it('an injected mid-batch failure rolls the whole bulk action back atomically', async () => {
    const f = await createNeedsReplanFixture()

    // First eligible role writes normally; the second fails.
    let injected = false
    await expect(
      applyRoleCountsAsNeeded(prisma, f.projectId, userId, {
        afterCreate: async () => {
          if (!injected) {
            injected = true
            throw new Error('injected mid-batch failure')
          }
        },
      }),
    ).rejects.toThrow('injected mid-batch failure')

    // Zero partial state: no profiles were committed and the project remains
    // NEEDS_REPLAN.
    expect(await profileCount(f.projectId)).toBe(0)
    const state = await prisma.project.findUnique({ where: { id: f.projectId } })
    expect(state!.planningState).toBe('NEEDS_REPLAN')
  })

  it('a ROLE profile created concurrently mid-batch is never overwritten by the bulk action', async () => {
    const f = await createNeedsReplanFixture()
    // Eligibility order follows creation order: Engineer (demanded),
    // Business Analyst, Data Scientist — all eligible and role-only.
    const [firstEligibleRoleId, secondEligibleRoleId] = f.roleOnlyRtIds
    expect(firstEligibleRoleId).toBe(f.demandedRtId)

    // A second real PostgreSQL connection commits a valid persisted ROLE
    // profile for the SECOND eligible role while the bulk batch is open
    // (after the first role's create). The profile uses deliberately
    // different semantics (AVAILABILITY_WINDOW / 75% / W2-W8) so any
    // overwrite by the bulk would be unmistakable.
    const concurrentClient = new PrismaClient({
      adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
    })
    await concurrentClient.$connect()
    let concurrentProfileId: string | null = null
    try {
      const result = await applyRoleCountsAsNeeded(prisma, f.projectId, userId, {
        afterCreate: async roleId => {
          if (roleId !== firstEligibleRoleId || concurrentProfileId) return
          const created = await concurrentClient.capacityProfile.create({
            data: {
              projectId: f.projectId,
              ownerKind: 'ROLE',
              resourceTypeId: secondEligibleRoleId,
              namedResourceId: null,
              planningBasis: 'AVAILABILITY_WINDOW',
              source: 'MANUAL',
              defaultPercent: 75,
              startWeek: 2,
              endWeek: 8,
            },
            select: { id: true },
          })
          concurrentProfileId = created.id
        },
      })

      // The bulk created the first and third eligible roles only; the second
      // role (whose profile appeared mid-batch) was skipped.
      expect(result.created).toBe(2)

      const profiles = await prisma.capacityProfile.findMany({
        where: { projectId: f.projectId },
        orderBy: { resourceTypeId: 'asc' },
      })
      const byRt = new Map(profiles.map(p => [p.resourceTypeId, p]))

      // The concurrently created profile survived COMPLETELY unchanged:
      // same id, same planning semantics, same source, no provenance.
      const concurrent = byRt.get(secondEligibleRoleId)!
      expect(concurrent.id).toBe(concurrentProfileId)
      expect(concurrent.planningBasis).toBe('AVAILABILITY_WINDOW')
      expect(concurrent.defaultPercent).toBe(75)
      expect(concurrent.startWeek).toBe(2)
      expect(concurrent.endWeek).toBe(8)
      expect(concurrent.source).toBe('MANUAL')
      expect(concurrent.provenance).toBeNull()

      // The other eligible roles received the canonical As-needed profile.
      for (const rtId of f.roleOnlyRtIds.filter(id => id !== secondEligibleRoleId)) {
        const profile = byRt.get(rtId)
        expect(profile!.planningBasis).toBe('DEMAND_FOLLOWING')
        expect(profile!.defaultPercent).toBe(100)
        expect(profile!.source).toBe('MANUAL')
      }

      // The skipped role no longer appears among remaining findings and the
      // project stays quarantined (completion owns the transition).
      expect(result.remainingFindings.join(' | ')).not.toContain('Business Analyst')
      const state = await prisma.project.findUnique({ where: { id: f.projectId } })
      expect(state!.planningState).toBe('NEEDS_REPLAN')
    } finally {
      await concurrentClient.$disconnect()
    }
  })

  it('the existing completion returns the project to CURRENT and Timeline resumes', async () => {
    const f = await createNeedsReplanFixture()

    // Bulk As-needed covers the role-only types.
    const bulk = await request(app)
      .post(`/api/projects/${f.projectId}/capacity-profiles/bulk-as-needed`)
      .set('Authorization', authHeader)
    expect(bulk.status).toBe(200)
    expect(bulk.body.created).toBe(3)

    // Still quarantined — the named-resource finding blocks completion.
    const stillIncomplete = await request(app)
      .post(`/api/projects/${f.projectId}/planning/complete`)
      .set('Authorization', authHeader)
    expect(stillIncomplete.status).toBe(422)
    expect(stillIncomplete.body.code).toBe('REPLAN_INCOMPLETE')
    expect(stillIncomplete.body.findings.join(' | ')).toContain('Alice Example')

    // Resolve the named resource through the normal editor path.
    const namedPut = await request(app)
      .put(`/api/projects/${f.projectId}/capacity-profiles/NAMED_PERSON/${f.namedResourceId}`)
      .set('Authorization', authHeader)
      .send({ planningBasis: 'DEMAND_FOLLOWING', defaultPercent: 100 })
    expect(namedPut.status).toBe(200)

    // Completion now passes and transitions the state.
    const complete = await request(app)
      .post(`/api/projects/${f.projectId}/planning/complete`)
      .set('Authorization', authHeader)
    expect(complete.status).toBe(200)
    expect(complete.body.planningState).toBe('CURRENT')

    // Timeline scheduling resumes against the canonical plan.
    const schedule = await request(app)
      .post(`/api/projects/${f.projectId}/timeline/schedule`)
      .set('Authorization', authHeader)
      .send({})
    expect(schedule.status).toBe(200)
    expect(schedule.body.entries.length).toBeGreaterThan(0)

    // CURRENT Resource Profile behaviour: no missing markers are emitted and
    // the response keeps the pre-existing shape (planningState is only
    // emitted by the NEEDS_REPLAN branch).
    const profile = await request(app)
      .get(`/api/projects/${f.projectId}/resource-profile`)
      .set('Authorization', authHeader)
    expect(profile.status).toBe(200)
    expect(profile.body.planningState).toBeUndefined()
    for (const row of profile.body.resourceRows as Array<{ missingCapacityProfile?: boolean }>) {
      expect(row.missingCapacityProfile).toBeUndefined()
    }
  })

  it('refuses the bulk action for a CURRENT project with the stable guard code', async () => {
    const project = await prisma.project.create({
      data: { name: `CURRENT guard ${Date.now()}`, status: 'ACTIVE', ownerId: userId },
    })

    const res = await request(app)
      .post(`/api/projects/${project.id}/capacity-profiles/bulk-as-needed`)
      .set('Authorization', authHeader)
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('REPLAN_ACTION_UNAVAILABLE')

    await prisma.project.delete({ where: { id: project.id } })
  })
})
