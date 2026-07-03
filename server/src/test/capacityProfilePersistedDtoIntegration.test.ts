/**
 * capacityProfilePersistedDtoIntegration.test.ts — Integration tests for
 * persisted capacity-profile DTO behaviour.
 *
 * These tests exercise the full #326 runtime path:
 *   legacy write → syncCapacityProfilesForProject → persisted rows
 *   → GET /capacity-profiles returns persisted DTOs
 *   → fallback only when persisted rows are inconsistent
 *
 * Prisma is globally mocked (setup.ts), but syncCapacityProfilesForProject
 * is NOT mocked in this file — tests run the real sync helper with
 * per-test tx mock setup.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import jwt from 'jsonwebtoken'

// Override global sync mock with the real implementation
vi.mock('../lib/syncCapacityProfiles.js', async (importOriginal: () => Promise<any>) => {
  return await importOriginal()
})

vi.mock('../routes/snapshots.js', async (importOriginal: () => Promise<any>) => {
  const actual = await importOriginal()
  return {
    ...actual,
    buildSnapshot: vi.fn().mockResolvedValue({}),
  }
})
vi.mock('../lib/snapshotUtils.js', () => ({
  pruneSnapshots: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../lib/reconcileCapacityProfiles.js', () => ({
  compareCapacityProfiles: vi.fn(),
}))

import { app } from '../index.js'
import { prisma } from '../lib/prisma.js'
import { compareCapacityProfiles } from '../lib/reconcileCapacityProfiles.js'

process.env.JWT_SECRET = 'test-secret'

const userId = 'user-1'
const token = jwt.sign({ userId }, 'test-secret')
const authHeader = `Bearer ${token}`
const projectId = 'proj-1'
const rtId = 'rt-1'
const userName = 'Engineer'

beforeEach(() => {
  vi.clearAllMocks()
})

// ─── Mock helpers ────────────────────────────────────────────────────────────

function mockProject(overrides: Record<string, unknown> = {}) {
  return {
    id: projectId,
    ownerId: userId,
    resourceTypes: [],
    capacityPlans: [],
    ...overrides,
  } as never
}

function mockRt(id: string, name: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    name,
    count: 1,
    allocationMode: 'EFFORT',
    allocationPercent: 100,
    allocationStartWeek: null,
    allocationEndWeek: null,
    namedResources: [],
    ...overrides,
  } as never
}

function mockNr(id: string, name: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    name,
    startWeek: null,
    endWeek: null,
    allocationPct: 100,
    allocationMode: 'EFFORT',
    allocationPercent: 100,
    allocationStartWeek: null,
    allocationEndWeek: null,
    pricingModel: 'ACTUAL_DAYS',
    ...overrides,
  } as never
}

function mockPersistedProfile(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    projectId,
    resourceTypeId: null,
    namedResourceId: null,
    ownerKind: 'ROLE',
    planningBasis: 'DEMAND_FOLLOWING',
    source: 'FIXED',
    defaultPercent: null,
    startWeek: null,
    endWeek: null,
    segments: [],
    ...overrides,
  }
}

function mockPersistedSegment(overrides: Record<string, unknown> = {}) {
  return {
    id: 'seg-1',
    startWeek: 0,
    endWeek: 8,
    capacityPercent: 100,
    source: 'SQUAD_PLANNER',
    ...overrides,
  }
}

/**
 * Make compareCapacityProfiles return "reconciled" — no mismatches.
 * Used for tests where the persisted path should succeed.
 */
function setSyncReconciled(): void {
  vi.mocked(compareCapacityProfiles).mockReturnValue({
    mismatches: [],
    expectedProfiles: 2,
    actualProfiles: 2,
    matchedProfiles: 2,
  })
}

/**
 * Make compareCapacityProfiles return mismatches — used for fallback tests.
 */
function setSyncMismatched(): void {
  vi.mocked(compareCapacityProfiles).mockReturnValue({
    mismatches: [
      {
        projectId,
        ownerKind: 'role',
        ownerId: rtId,
        type: 'profileFieldMismatch',
        message: 'planningBasis mismatch: expected demandFollowing, got availabilityWindow',
        expected: 'demandFollowing',
        actual: 'availabilityWindow',
      },
    ],
    expectedProfiles: 1,
    actualProfiles: 1,
    matchedProfiles: 0,
  })
}

/**
 * Build a minimal tx object for a sync-invoking write route.
 * The tx provides all methods the route and syncCapacityProfilesForProject need.
 */
function buildSyncTx(opts: {
  existingProfiles?: any[]
  postSyncProfiles?: any[]
  existingNrs?: any[]
  rt?: any
}) {
  const {
    existingProfiles = [],
    postSyncProfiles = [],
    existingNrs = [],
    rt = mockRt(rtId, userName),
  } = opts

  const capacityProfileMocks = {
    findMany: vi.fn()
      // First call (existing) → configured existing profiles (usually [])
      .mockResolvedValueOnce(existingProfiles)
      // Second call (post-sync) → configured post-sync profiles
      .mockResolvedValueOnce(postSyncProfiles),
    create: vi.fn().mockResolvedValue({ id: 'cp-created' }),
    update: vi.fn(),
    delete: vi.fn(),
    deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
  }

  const capacitySegmentMocks = {
    deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    create: vi.fn().mockResolvedValue({ id: 'seg-new' }),
  }

  return {
    capacityProfile: capacityProfileMocks,
    capacitySegment: capacitySegmentMocks,
    // For sync helper fetching the project
    project: {
      findFirst: vi.fn().mockResolvedValue(
        mockProject({
          resourceTypes: [
            {
              ...rt,
              namedResources: existingNrs.map((nr: any) => ({
                ...nr,
                resourceTypeId: rt.id,
              })),
            },
          ],
          capacityPlans: [],
        }),
      ),
      update: vi.fn(),
    },
    resourceType: {
      update: vi.fn().mockResolvedValue({ id: rtId }),
      findUnique: vi.fn().mockResolvedValue({ name: userName }),
      updateMany: vi.fn(),
    },
    namedResource: {
      findMany: vi.fn().mockResolvedValue(existingNrs),
      update: vi.fn(),
      create: vi.fn().mockResolvedValue({ id: 'nr-new' }),
      updateMany: vi.fn(),
      delete: vi.fn(),
      count: vi.fn().mockResolvedValue(existingNrs.length + 1),
    },
    capacityPlan: {
      updateMany: vi.fn(),
    },
    timelineEntry: { deleteMany: vi.fn(), createMany: vi.fn() },
    storyTimelineEntry: { deleteMany: vi.fn(), createMany: vi.fn() },
    epic: { update: vi.fn(), findMany: vi.fn() },
    epicDependency: { findMany: vi.fn() },
    storyDependency: { findMany: vi.fn() },
  }
}

/**
 * Call the GET /capacity-profiles endpoint and return the response.
 */
async function getCapacityProfiles() {
  return request(app)
    .get(`/api/projects/${projectId}/capacity-profiles`)
    .set('Authorization', authHeader)
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('persisted capacity-profile DTO integration', () => {
  describe('1. ResourceType write persists profiles and endpoint uses persisted DTOs', () => {
    it('PATCH resource-type count triggers sync; GET returns persisted DTOs', async () => {
      setSyncReconciled()

      // ── Write: PATCH resource-type count ────────────────────────────────
      vi.mocked(prisma.project.findFirst).mockResolvedValueOnce(
        mockProject({ resourceTypes: [mockRt(rtId, userName)] }),
      )
      vi.mocked(prisma.resourceType.findFirst).mockResolvedValueOnce(
        mockRt(rtId, userName),
      )

      const tx = buildSyncTx({
        existingNrs: [{ id: 'nr-1', name: 'Engineer 1' }],
      })
      vi.mocked(prisma.$transaction).mockImplementationOnce(async (fn: any) => fn(tx))

      const patchRes = await request(app)
        .patch(`/api/projects/${projectId}/resource-types/${rtId}`)
        .set('Authorization', authHeader)
        .send({ count: 2 })

      expect(patchRes.status).toBe(200)

      // ── Read: GET /capacity-profiles ───────────────────────────────────
      // Now mock the GET endpoint's project.fetch with persisted profiles
      // that match the mapper output (EFFORT mode → demandFollowing/ROLE).
      const persistedProfile = mockPersistedProfile('cp-1', {
        resourceTypeId: rtId,
        ownerKind: 'ROLE',
        planningBasis: 'DEMAND_FOLLOWING',
        source: 'FIXED',
        defaultPercent: 100,
        startWeek: null,
        endWeek: null,
      })

      vi.mocked(prisma.project.findFirst).mockResolvedValue(
        mockProject({
          resourceTypes: [mockRt(rtId, userName, { count: 2 })],
          capacityProfiles: [persistedProfile],
        }),
      )

      const getRes = await getCapacityProfiles()

      expect(getRes.status).toBe(200)
      expect(getRes.body.capacityProfiles).toHaveLength(1)
      // Persisted id (not rt id) tells us the persisted path was used
      expect(getRes.body.capacityProfiles[0].id).toBe('cp-1')
      expect(getRes.body.capacityProfiles[0].owner).toMatchObject({
        kind: 'role',
        id: rtId,
        name: userName,
      })
      expect(getRes.body.capacityProfiles[0].planningBasis).toBe('demandFollowing')
    })
  })

  describe('2. NamedResource write persists named-person profile DTOs', () => {
    it('PUT named-resource triggers sync; GET returns named-person DTO', async () => {
      setSyncReconciled()

      const nrAlice = mockNr('nr-alice', 'Alice')

      // ── Write: PUT named-resource ─────────────────────────────────────
      vi.mocked(prisma.project.findFirst).mockResolvedValueOnce(
        mockProject({ resourceTypes: [mockRt(rtId, userName)] }),
      )
      vi.mocked(prisma.resourceType.findFirst).mockResolvedValueOnce(
        mockRt(rtId, userName),
      )
      vi.mocked(prisma.namedResource.findFirst).mockResolvedValueOnce(nrAlice)

      const tx = buildSyncTx({
        existingNrs: [nrAlice],
        rt: mockRt(rtId, userName, { namedResources: [nrAlice] }),
      })
      vi.mocked(prisma.$transaction).mockImplementationOnce(async (fn: any) => fn(tx))

      const putRes = await request(app)
        .put(`/api/projects/${projectId}/resource-types/${rtId}/named-resources/nr-alice`)
        .set('Authorization', authHeader)
        .send({ name: 'Alice Updated' })

      expect(putRes.status).toBe(200)

      // ── Read: GET /capacity-profiles ──────────────────────────────────
      const persistedProfile = mockPersistedProfile('cp-nr', {
        namedResourceId: 'nr-alice',
        ownerKind: 'NAMED_PERSON',
        planningBasis: 'DEMAND_FOLLOWING',
        source: 'FIXED',
        defaultPercent: 100,
      })

      vi.mocked(prisma.project.findFirst).mockResolvedValue(
        mockProject({
          resourceTypes: [
            mockRt(rtId, userName, {
              namedResources: [{ id: 'nr-alice', name: 'Alice Updated' }],
            }),
          ],
          capacityProfiles: [persistedProfile],
        }),
      )

      const getRes = await getCapacityProfiles()

      expect(getRes.status).toBe(200)
      expect(getRes.body.capacityProfiles).toHaveLength(1)
      const dto = getRes.body.capacityProfiles[0]
      expect(dto.owner.kind).toBe('namedPerson')
      expect(dto.owner.id).toBe('nr-alice')
      expect(dto.owner.name).toBe('Alice Updated')
      expect(dto.owner.roleId).toBe(rtId)
      expect(dto.owner.roleName).toBe(userName)
      expect(dto.id).toBe('cp-nr')
    })

    it('PATCH named-resource allocation triggers sync; GET returns updated DTO', async () => {
      setSyncReconciled()

      const nrBob = mockNr('nr-bob', 'Bob', {
        allocationMode: 'TIMELINE',
        allocationPercent: 50,
        allocationStartWeek: 2,
        allocationEndWeek: 10,
      })

      // Write: PATCH named-resource allocation
      vi.mocked(prisma.project.findFirst).mockResolvedValueOnce(
        mockProject({ resourceTypes: [mockRt(rtId, userName)] }),
      )
      vi.mocked(prisma.resourceType.findFirst).mockResolvedValueOnce(
        mockRt(rtId, userName),
      )
      vi.mocked(prisma.namedResource.findFirst).mockResolvedValueOnce(nrBob)

      const tx = buildSyncTx({
        existingNrs: [nrBob],
        rt: mockRt(rtId, userName, { namedResources: [nrBob] }),
      })
      vi.mocked(prisma.$transaction).mockImplementationOnce(async (fn: any) => fn(tx))

      const patchRes = await request(app)
        .patch(`/api/projects/${projectId}/resource-types/${rtId}/named-resources/nr-bob`)
        .set('Authorization', authHeader)
        .send({ allocationPercent: 75 })

      expect(patchRes.status).toBe(200)

      // Read: GET should show persisted profile with correct fields
      const persistedProfile = mockPersistedProfile('cp-nr2', {
        namedResourceId: 'nr-bob',
        ownerKind: 'NAMED_PERSON',
        planningBasis: 'AVAILABILITY_WINDOW',
        source: 'AVAILABILITY_WINDOW',
        defaultPercent: 75,
        startWeek: 2,
        endWeek: 10,
      })

      vi.mocked(prisma.project.findFirst).mockResolvedValue(
        mockProject({
          resourceTypes: [
            mockRt(rtId, userName, {
              namedResources: [{
                id: 'nr-bob',
                name: 'Bob',
                startWeek: null,
                endWeek: null,
                allocationPct: 100,
                allocationMode: 'TIMELINE',
                allocationPercent: 75,
                allocationStartWeek: 2,
                allocationEndWeek: 10,
                pricingModel: 'ACTUAL_DAYS',
              }],
            }),
          ],
          capacityProfiles: [persistedProfile],
        }),
      )

      const getRes = await getCapacityProfiles()
      expect(getRes.status).toBe(200)
      const dto = getRes.body.capacityProfiles[0]
      expect(dto.owner.kind).toBe('namedPerson')
      expect(dto.owner.id).toBe('nr-bob')
      expect(dto.defaultPercent).toBe(75)
      expect(dto.startWeek).toBe(2)
      expect(dto.endWeek).toBe(10)
    })
  })

  describe('3. NamedResource delete removes stale persisted profiles', () => {
    it('DELETE named-resource removes profile; GET does not include deleted NR', async () => {
      setSyncReconciled()

      const nrDelete = mockNr('nr-delete', 'ToDelete')

      // Write: DELETE named-resource
      vi.mocked(prisma.project.findFirst).mockResolvedValueOnce(
        mockProject({
          resourceTypes: [mockRt(rtId, userName, {
            namedResources: [nrDelete],
            count: 1,
          })],
        }),
      )
      vi.mocked(prisma.resourceType.findFirst).mockResolvedValueOnce(
        mockRt(rtId, userName, { namedResources: [nrDelete], count: 1 }),
      )
      vi.mocked(prisma.namedResource.findFirst).mockResolvedValueOnce(nrDelete)

      const tx = buildSyncTx({
        existingNrs: [nrDelete],
        rt: mockRt(rtId, userName, { namedResources: [nrDelete], count: 1 }),
      })
      // After delete, count returns 0
      tx.namedResource.count = vi.fn().mockResolvedValue(0)
      vi.mocked(prisma.$transaction).mockImplementationOnce(async (fn: any) => fn(tx))

      const delRes = await request(app)
        .delete(`/api/projects/${projectId}/resource-types/${rtId}/named-resources/nr-delete`)
        .set('Authorization', authHeader)

      expect(delRes.status).toBe(204)

      // Read: GET should return role-level profile only (no named resource)
      const persistedProfile = mockPersistedProfile('cp-role', {
        resourceTypeId: rtId,
        ownerKind: 'ROLE',
        planningBasis: 'DEMAND_FOLLOWING',
        source: 'FIXED',
        defaultPercent: 100,
      })

      vi.mocked(prisma.project.findFirst).mockResolvedValue(
        mockProject({
          resourceTypes: [mockRt(rtId, userName, { count: 0, namedResources: [] })],
          capacityProfiles: [persistedProfile],
        }),
      )

      const getRes = await getCapacityProfiles()
      expect(getRes.status).toBe(200)
      // Only the role-level profile, no named-person profile
      expect(getRes.body.capacityProfiles).toHaveLength(1)
      expect(getRes.body.capacityProfiles[0].owner.kind).toBe('role')
    })
  })

  describe('4. Squad Planner apply persists capacity-profile segments', () => {
    it('POST squad-plan/apply creates profiles with segments; GET returns them', async () => {
      setSyncReconciled()

      const mockPlanId = 'plan-1'

      vi.mocked(prisma.project.findFirst).mockResolvedValue({
        id: projectId,
        ownerId: userId,
        name: 'Test',
        hoursPerDay: 8,
        startDate: new Date('2026-03-01'),
      } as never)

      vi.mocked(prisma.resourceType.findMany)
        .mockResolvedValueOnce([{ id: rtId }] as never)
        .mockResolvedValueOnce([mockRt(rtId, userName)] as never)

      vi.mocked(prisma.epic.findMany).mockResolvedValue([] as never)
      vi.mocked(prisma.timelineEntry.findMany).mockResolvedValue([] as never)
      vi.mocked(prisma.storyTimelineEntry.findMany).mockResolvedValue([] as never)
      vi.mocked(prisma.epicDependency.findMany).mockResolvedValue([] as never)
      vi.mocked(prisma.backlogSnapshot.create).mockResolvedValue({ id: 'snap-1' } as never)
      vi.mocked(prisma.project.update).mockResolvedValue({} as never)

      const applyTx = {
        capacityPlan: {
          updateMany: vi.fn().mockResolvedValue({ count: 0 }),
          create: vi.fn().mockResolvedValue({
            id: mockPlanId,
            projectId,
            isActive: true,
            periods: [{
              id: 'period-1',
              periodIndex: 0,
              startWeek: 0,
              endWeek: 8,
              entries: [{ resourceTypeId: rtId, headcount: 1, demandFTE: 0.5, utilisationPct: 50 }],
            }],
          }),
        },
        resourceType: {
          update: vi.fn().mockResolvedValue({}),
          updateMany: vi.fn().mockResolvedValue({ count: 0 }),
          findUnique: vi.fn().mockResolvedValue({ name: userName }),
        },
        namedResource: {
          updateMany: vi.fn().mockResolvedValue({ count: 1 }),
          findMany: vi.fn().mockResolvedValue([{ id: 'nr-1' }]),
          createMany: vi.fn().mockResolvedValue({ count: 0 }),
          update: vi.fn().mockResolvedValue({}),
          delete: vi.fn(),
          count: vi.fn().mockResolvedValue(0),
        },
        capacityProfile: {
          findMany: vi.fn()
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([mockPersistedProfile('cp-sp', {
              resourceTypeId: rtId,
              ownerKind: 'ROLE',
              planningBasis: 'CAPACITY_PROFILE',
              source: 'SQUAD_PLANNER',
              defaultPercent: 100,
              startWeek: 0,
              endWeek: 8,
              segments: [mockPersistedSegment({ id: 'seg-sp', startWeek: 0, endWeek: 8 })],
            })]),
          create: vi.fn().mockResolvedValue({ id: 'cp-sp' }),
          update: vi.fn(),
          deleteMany: vi.fn(),
        },
        capacitySegment: {
          deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
          create: vi.fn().mockResolvedValue({ id: 'seg-sp' }),
        },
        project: {
          findFirst: vi.fn().mockResolvedValue(
            mockProject({
              resourceTypes: [mockRt(rtId, userName)],
              capacityPlans: [{
                id: mockPlanId,
                isActive: true,
                periods: [{
                  periodIndex: 0,
                  startWeek: 0,
                  endWeek: 8,
                  entries: [{ resourceTypeId: rtId, headcount: 1 }],
                }],
              }],
            }),
          ),
          update: vi.fn(),
        },
        timelineEntry: { deleteMany: vi.fn(), createMany: vi.fn() },
        storyTimelineEntry: { deleteMany: vi.fn(), createMany: vi.fn() },
        epic: { update: vi.fn(), findMany: vi.fn() },
        epicDependency: { findMany: vi.fn() },
        storyDependency: { findMany: vi.fn() },
      }
      vi.mocked(prisma.$transaction)
        .mockImplementationOnce(async (fn: any) => fn(applyTx))
        .mockImplementation(async (fn: any) => fn(applyTx))

      vi.mocked(prisma.project.findFirst)
        .mockResolvedValueOnce({
          id: projectId,
          ownerId: userId,
          name: 'Test',
          hoursPerDay: 8,
          startDate: new Date('2026-03-01'),
          resourceTypes: [mockRt(rtId, userName)],
          capacityPlans: [{
            id: mockPlanId,
            isActive: true,
            periods: [{
              periodIndex: 0,
              startWeek: 0,
              endWeek: 8,
              entries: [{ resourceTypeId: rtId, headcount: 1 }],
            }],
          }],
        } as never)

      const applyRes = await request(app)
        .post(`/api/projects/${projectId}/squad-plan/apply`)
        .set('Authorization', authHeader)
        .send({
          name: 'Test Plan',
          targetWeeks: 8,
          periodWeeks: 4,
          maxDelta: 1,
          setActive: true,
          periods: [{
            periodIndex: 0,
            startWeek: 0,
            endWeek: 8,
            entries: [{ resourceTypeId: rtId, headcount: 1, demandFTE: 0.5, utilisationPct: 50 }],
          }],
        })

      expect(applyRes.status).toBe(201)

      vi.mocked(prisma.project.findFirst).mockResolvedValue(
        mockProject({
          resourceTypes: [mockRt(rtId, userName, { allocationMode: 'CAPACITY_PLAN' })],
          capacityPlans: [{
            id: mockPlanId,
            isActive: true,
            periods: [{ periodIndex: 0, startWeek: 0, endWeek: 8, entries: [] }],
          }],
          capacityProfiles: [mockPersistedProfile('cp-sp', {
            resourceTypeId: rtId,
            ownerKind: 'ROLE',
            planningBasis: 'CAPACITY_PROFILE',
            source: 'SQUAD_PLANNER',
            defaultPercent: 100,
            startWeek: 0,
            endWeek: 8,
            segments: [mockPersistedSegment({ id: 'seg-sp', startWeek: 0, endWeek: 8 })],
          })],
        }),
      )

      const getRes = await getCapacityProfiles()
      expect(getRes.status).toBe(200)
      expect(getRes.body.capacityProfiles).toHaveLength(1)
      const dto = getRes.body.capacityProfiles[0]
      expect(dto.planningBasis).toBe('capacityProfile')
      expect(dto.source).toBe('squadPlanner')
      expect(dto.segments).toHaveLength(1)
      expect(dto.segments[0]).toMatchObject({
        startWeek: 0,
        endWeek: 8,
        capacityPercent: 100,
      })
    })
  })

  describe('5. Endpoint falls back when persisted rows are inconsistent', () => {
    it('returns legacy-derived DTOs when persisted profiles do not reconcile', async () => {
      setSyncMismatched()

      // Persisted profile has wrong planningBasis for this RT
      vi.mocked(prisma.project.findFirst).mockResolvedValue(
        mockProject({
          resourceTypes: [mockRt(rtId, userName, { allocationMode: 'EFFORT' })],
          capacityProfiles: [mockPersistedProfile('cp-bad', {
            resourceTypeId: rtId,
            ownerKind: 'ROLE',
            planningBasis: 'AVAILABILITY_WINDOW', // wrong — EFFORT → demandFollowing
            source: 'FIXED',
            defaultPercent: 100,
          })],
        }),
      )

      const getRes = await getCapacityProfiles()

      expect(getRes.status).toBe(200)

      // Fallback → uses the resource type id as profile id (not persisted id)
      const dto = getRes.body.capacityProfiles[0]
      expect(dto.id).toBe(rtId)
      expect(dto.planningBasis).toBe('demandFollowing')
      // Legacy field preserved
      expect(dto.legacy).toMatchObject({ allocationMode: 'EFFORT' })
    })

    it('returns legacy-derived DTOs when persisted profiles are empty (fallback path)', async () => {
      // No capacityProfiles in the project response → skip persisted check
      setSyncMismatched() // Won't be called since no profiles exist

      vi.mocked(prisma.project.findFirst).mockResolvedValue(
        mockProject({
          resourceTypes: [mockRt(rtId, userName)],
          capacityProfiles: [],
        }),
      )

      const getRes = await getCapacityProfiles()

      expect(getRes.status).toBe(200)
      expect(getRes.body.capacityProfiles).toHaveLength(1)
      // Fallback uses rt id, not a profile id
      expect(getRes.body.capacityProfiles[0].id).toBe(rtId)
    })
  })

  describe('6. Endpoint returns persisted DTOs again after sync repairs inconsistency', () => {
    it('repairs via write route; GET returns persisted path after fix', async () => {
      // Phase 1: Start with inconsistent persisted state
      setSyncMismatched()

      vi.mocked(prisma.project.findFirst).mockResolvedValue(
        mockProject({
          resourceTypes: [mockRt(rtId, userName)],
          capacityProfiles: [mockPersistedProfile('cp-bad', {
            resourceTypeId: rtId,
            ownerKind: 'ROLE',
            planningBasis: 'AVAILABILITY_WINDOW',
            source: 'FIXED',
            defaultPercent: 100,
          })],
        }),
      )

      const getBefore = await getCapacityProfiles()
      expect(getBefore.status).toBe(200)
      // Fallback: uses rt id
      expect(getBefore.body.capacityProfiles[0].id).toBe(rtId)

      // Phase 2: Trigger a write route that syncs (repairs)
      // For PATCH, compareCapacityProfiles will be called by the sync helper
      setSyncReconciled()

      vi.mocked(prisma.project.findFirst).mockResolvedValueOnce(
        mockProject({ resourceTypes: [mockRt(rtId, userName)] }),
      )
      vi.mocked(prisma.resourceType.findFirst).mockResolvedValueOnce(
        mockRt(rtId, userName),
      )

      const tx = buildSyncTx({
        existingNrs: [{ id: 'nr-1', name: 'Engineer 1' }],
      })
      vi.mocked(prisma.$transaction).mockImplementationOnce(async (fn: any) => fn(tx))

      const patchRes = await request(app)
        .patch(`/api/projects/${projectId}/resource-types/${rtId}`)
        .set('Authorization', authHeader)
        .send({ count: 2 })

      expect(patchRes.status).toBe(200)

      // Phase 3: After sync, persisted profiles are consistent again
      // compareCapacityProfiles still returns reconciled (from setSyncReconciled above)
      vi.mocked(prisma.project.findFirst).mockResolvedValue(
        mockProject({
          resourceTypes: [mockRt(rtId, userName, { count: 2 })],
          capacityProfiles: [mockPersistedProfile('cp-repaired', {
            resourceTypeId: rtId,
            ownerKind: 'ROLE',
            planningBasis: 'DEMAND_FOLLOWING',
            source: 'FIXED',
            defaultPercent: 100,
          })],
        }),
      )

      const getAfter = await getCapacityProfiles()
      expect(getAfter.status).toBe(200)
      // Now using persisted path: profile id, not rt id
      expect(getAfter.body.capacityProfiles[0].id).toBe('cp-repaired')
      expect(getAfter.body.capacityProfiles[0].planningBasis).toBe('demandFollowing')
    })
  })
})
