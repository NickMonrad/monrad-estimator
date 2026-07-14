/**
 * capacityProfiles.test.ts — Integration tests for the read-only
 * capacity-profile API endpoint.
 *
 * Tests that the endpoint correctly derives CapacityProfileDTOs from
 * existing persisted fields using the mapper from PR #331.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { app } from '../index.js'
import { prisma } from '../lib/prisma.js'
import { mapPersistedProfilesToDTOs } from '../lib/capacityProfileMapping.js'

process.env.JWT_SECRET = 'test-secret'

const userId = 'user-1'
const token = jwt.sign({ userId }, 'test-secret')
const authHeader = `Bearer ${token}`

beforeEach(() => vi.clearAllMocks())

// ─── Helper: build a minimal project mock ──────────────────────────────────

function mockProject(overrides: Record<string, unknown>) {
  return {
    id: 'proj-1',
    ownerId: userId,
    resourceTypes: [],
    capacityPlans: [],
    ...overrides,
  } as any
}

// ─── Helper: build a minimal resource type for mocks ────────────────────────

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
  }
}

// ─── Helper: build a minimal named resource for mocks ───────────────────────

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
  }
}

// ─── Helper: build a mock persisted capacity profile ────────────────────────

function mockPersistedProfile(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    projectId: 'proj-1',
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

// ─── Helper: build a mock persisted segment ─────────────────────────────────

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

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('GET /api/projects/:projectId/capacity-profiles', () => {
  it('rejects unauthenticated request', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue(null)

    const res = await request(app)
      .get('/api/projects/proj-1/capacity-profiles')
      // No auth header

    expect(res.status).toBe(401)
  })

  it('returns 404 for missing or inaccessible project', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue(null)

    const res = await request(app)
      .get('/api/projects/proj-missing/capacity-profiles')
      .set('Authorization', authHeader)

    expect(res.status).toBe(404)
    expect(res.body.error).toBe('Project not found')
  })

  it('returns demandFollowing role profile for EFFORT resource type', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue(mockProject({
      resourceTypes: [mockRt('rt-1', 'Engineer', { allocationMode: 'EFFORT' })],
    }))

    const res = await request(app)
      .get('/api/projects/proj-1/capacity-profiles')
      .set('Authorization', authHeader)

    expect(res.status).toBe(200)
    expect(res.body.capacityProfiles).toHaveLength(1)
    expect(res.body.capacityProfiles[0]).toMatchObject({
      owner: { kind: 'role', id: 'rt-1', name: 'Engineer' },
      planningBasis: 'demandFollowing',
      defaultPercent: 100,
      source: 'fixed',
      segments: [],
    })
  })

  it('preserves TIMELINE percent/start/end with availabilityWindow', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue(mockProject({
      resourceTypes: [mockRt('rt-1', 'Dev', {
        allocationMode: 'TIMELINE',
        allocationPercent: 75,
        allocationStartWeek: 2,
        allocationEndWeek: 10,
      })],
    }))

    const res = await request(app)
      .get('/api/projects/proj-1/capacity-profiles')
      .set('Authorization', authHeader)

    expect(res.status).toBe(200)
    expect(res.body.capacityProfiles[0]).toMatchObject({
      planningBasis: 'availabilityWindow',
      defaultPercent: 75,
      startWeek: 2,
      endWeek: 10,
      source: 'availabilityWindow',
      segments: [],
    })
  })

  it('returns wholeProjectAllocation for FULL_PROJECT resource', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue(mockProject({
      resourceTypes: [mockRt('rt-1', 'PM', { allocationMode: 'FULL_PROJECT' })],
    }))

    const res = await request(app)
      .get('/api/projects/proj-1/capacity-profiles')
      .set('Authorization', authHeader)

    expect(res.status).toBe(200)
    expect(res.body.capacityProfiles[0]).toMatchObject({
      planningBasis: 'wholeProjectAllocation',
      source: 'fixed',
    })
  })

  it('returns namedPerson owner kind for persisted named resource', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue(mockProject({
      resourceTypes: [mockRt('rt-1', 'Engineer', {
        allocationMode: 'EFFORT',
        namedResources: [mockNr('nr-1', 'Alice')],
      })],
    }))

    const res = await request(app)
      .get('/api/projects/proj-1/capacity-profiles')
      .set('Authorization', authHeader)

    expect(res.status).toBe(200)
    expect(res.body.capacityProfiles).toHaveLength(1)
    expect(res.body.capacityProfiles[0]).toMatchObject({
      owner: { kind: 'namedPerson', id: 'nr-1', name: 'Alice', roleId: 'rt-1' },
    })
  })

  it('returns capacityProfile with squadPlanner segments for CAPACITY_PLAN with active plan', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue(mockProject({
      resourceTypes: [mockRt('rt-1', 'Engineer', { allocationMode: 'CAPACITY_PLAN' })],
      capacityPlans: [
        {
          id: 'plan-1',
          isActive: true,
          periods: [
            {
              periodIndex: 0,
              startWeek: 0,
              endWeek: 7,
              entries: [{ resourceTypeId: 'rt-1', headcount: 1 }],
            },
          ],
        },
      ],
    }))

    const res = await request(app)
      .get('/api/projects/proj-1/capacity-profiles')
      .set('Authorization', authHeader)

    expect(res.status).toBe(200)
    expect(res.body.capacityProfiles[0]).toMatchObject({
      planningBasis: 'capacityProfile',
      source: 'squadPlanner',
    })
    expect(res.body.capacityProfiles[0].segments.length).toBeGreaterThan(0)
    expect(res.body.capacityProfiles[0].segments[0]).toMatchObject({
      source: 'squadPlanner',
      capacityPercent: 100,
    })
  })

  it('does not derive segments for non-CAPACITY_PLAN resource even with active plan', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue(mockProject({
      resourceTypes: [mockRt('rt-1', 'Engineer', { allocationMode: 'EFFORT' })],
      capacityPlans: [
        {
          id: 'plan-1',
          isActive: true,
          periods: [
            {
              periodIndex: 0,
              startWeek: 0,
              endWeek: 7,
              entries: [{ resourceTypeId: 'rt-1', headcount: 1 }],
            },
          ],
        },
      ],
    }))

    const res = await request(app)
      .get('/api/projects/proj-1/capacity-profiles')
      .set('Authorization', authHeader)

    expect(res.status).toBe(200)
    expect(res.body.capacityProfiles[0]).toMatchObject({
      planningBasis: 'demandFollowing',
      source: 'fixed',
    })
    expect(res.body.capacityProfiles[0].segments).toEqual([])
  })

  it('performs no database writes', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue(mockProject({
      resourceTypes: [mockRt('rt-1', 'Engineer', { allocationMode: 'EFFORT' })],
    }))

    await request(app)
      .get('/api/projects/proj-1/capacity-profiles')
      .set('Authorization', authHeader)

    expect(prisma.project.create).not.toHaveBeenCalled()
    expect(prisma.project.update).not.toHaveBeenCalled()
    expect(prisma.project.updateMany).not.toHaveBeenCalled()
    expect(prisma.project.delete).not.toHaveBeenCalled()
  })
})

// ─── Persisted-read tests ────────────────────────────────────────────────────

describe('persisted profiles', () => {
  it('returns persisted DTOs when persisted profiles are reconciled', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue(mockProject({
      resourceTypes: [mockRt('rt-1', 'Engineer', { allocationMode: 'EFFORT' })],
      capacityProfiles: [mockPersistedProfile('cp-1', {
        resourceTypeId: 'rt-1',
        ownerKind: 'ROLE',
        planningBasis: 'DEMAND_FOLLOWING',
        source: 'FIXED',
        defaultPercent: 100,
      })],
    }))

    const res = await request(app)
      .get('/api/projects/proj-1/capacity-profiles')
      .set('Authorization', authHeader)

    expect(res.status).toBe(200)
    expect(res.body.capacityProfiles).toHaveLength(1)
    expect(res.body.capacityProfiles[0].projectId).toBe('proj-1')
    // Should have the persisted profile's id, not the resource type's id
    expect(res.body.capacityProfiles[0].id).toBe('cp-1')
    expect(res.body.capacityProfiles[0].owner).toMatchObject({
      kind: 'role',
      id: 'rt-1',
      name: 'Engineer',
    })
    expect(res.body.capacityProfiles[0].planningBasis).toBe('demandFollowing')
    expect(res.body.capacityProfiles[0].defaultPercent).toBe(100)
  })

  it('maps persisted role profile correctly', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue(mockProject({
      resourceTypes: [mockRt('rt-1', 'Engineer', { allocationMode: 'TIMELINE', allocationPercent: 75, allocationStartWeek: 2, allocationEndWeek: 10 })],
      capacityProfiles: [mockPersistedProfile('cp-1', {
        resourceTypeId: 'rt-1',
        ownerKind: 'ROLE',
        planningBasis: 'AVAILABILITY_WINDOW',
        source: 'AVAILABILITY_WINDOW',
        defaultPercent: 75,
        startWeek: 2,
        endWeek: 10,
      })],
    }))

    const res = await request(app)
      .get('/api/projects/proj-1/capacity-profiles')
      .set('Authorization', authHeader)

    expect(res.status).toBe(200)
    expect(res.body.capacityProfiles[0]).toMatchObject({
      owner: { kind: 'role', id: 'rt-1', name: 'Engineer' },
      planningBasis: 'availabilityWindow',
      defaultPercent: 75,
      startWeek: 2,
      endWeek: 10,
    })
  })

  it('maps persisted named-person profile correctly', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue(mockProject({
      resourceTypes: [mockRt('rt-1', 'Engineer', {
        allocationMode: 'EFFORT',
        namedResources: [mockNr('nr-1', 'Alice')],
      })],
      capacityProfiles: [mockPersistedProfile('cp-1', {
        namedResourceId: 'nr-1',
        ownerKind: 'NAMED_PERSON',
        planningBasis: 'DEMAND_FOLLOWING',
        source: 'FIXED',
        defaultPercent: 100,
      })],
    }))

    const res = await request(app)
      .get('/api/projects/proj-1/capacity-profiles')
      .set('Authorization', authHeader)

    expect(res.status).toBe(200)
    expect(res.body.capacityProfiles[0]).toMatchObject({
      owner: { kind: 'namedPerson', id: 'nr-1', name: 'Alice', roleId: 'rt-1' },
      planningBasis: 'demandFollowing',
    })
  })

  it('maps persisted capacity profile segments correctly', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue(mockProject({
      resourceTypes: [mockRt('rt-1', 'Engineer', { allocationMode: 'CAPACITY_PLAN' })],
      capacityPlans: [{
        id: 'plan-1',
        isActive: true,
        periods: [{
          periodIndex: 0,
          startWeek: 0,
          endWeek: 8,
          entries: [{ resourceTypeId: 'rt-1', headcount: 1 }],
        }],
      }],
      capacityProfiles: [mockPersistedProfile('cp-1', {
        resourceTypeId: 'rt-1',
        ownerKind: 'ROLE',
        planningBasis: 'CAPACITY_PROFILE',
        source: 'SQUAD_PLANNER',
        defaultPercent: 100,
        segments: [
          mockPersistedSegment({ id: 'seg-capacity-1', endWeek: 7 }),
        ],
      })],
    }))

    const res = await request(app)
      .get('/api/projects/proj-1/capacity-profiles')
      .set('Authorization', authHeader)

    expect(res.status).toBe(200)
    expect(res.body.capacityProfiles[0].id).toBe('cp-1')
    expect(res.body.capacityProfiles[0]).toMatchObject({
      planningBasis: 'capacityProfile',
      source: 'squadPlanner',
    })
    expect(res.body.capacityProfiles[0].segments).toHaveLength(1)
    expect(res.body.capacityProfiles[0].segments[0]).toMatchObject({
      id: 'seg-capacity-1',
      startWeek: 0,
      endWeek: 7,
      capacityPercent: 100,
      source: 'squadPlanner',
    })
  })

  it('returns persisted profile even when planningBasis differs from legacy mapper', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue(mockProject({
      resourceTypes: [mockRt('rt-1', 'Engineer', { allocationMode: 'EFFORT' })],
      capacityProfiles: [mockPersistedProfile('cp-1', {
        resourceTypeId: 'rt-1',
        ownerKind: 'ROLE',
        planningBasis: 'AVAILABILITY_WINDOW',
        source: 'AVAILABILITY_WINDOW',
        defaultPercent: 100,
      })],
    }))

    const res = await request(app)
      .get('/api/projects/proj-1/capacity-profiles')
      .set('Authorization', authHeader)

    // Persisted profile IS structurally valid (exactly-one owner FK, valid enums,
    // owner references existing RT) → returned as-authority, no fallback.
    expect(res.status).toBe(200)
    expect(res.body.capacityProfiles[0].id).toBe('cp-1')
    expect(res.body.capacityProfiles[0].planningBasis).toBe('availabilityWindow')
  })

  it('falls back to legacy when persisted data has no profile for a resource type', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue(mockProject({
      resourceTypes: [
        mockRt('rt-1', 'Engineer', { allocationMode: 'EFFORT' }),
        mockRt('rt-2', 'Designer', { allocationMode: 'EFFORT' }),
      ],
      capacityProfiles: [mockPersistedProfile('cp-1', {
        resourceTypeId: 'rt-1',
        ownerKind: 'ROLE',
        planningBasis: 'DEMAND_FOLLOWING',
        source: 'FIXED',
        defaultPercent: 100,
      })],
      // No persisted profile for rt-2 → incomplete coverage → fallback
    }))

    const res = await request(app)
      .get('/api/projects/proj-1/capacity-profiles')
      .set('Authorization', authHeader)

    // rt-2 has no persisted profile → completeness check fails → legacy fallback
    expect(res.status).toBe(200)
    expect(res.body.capacityProfiles).toHaveLength(2)
    const ids = res.body.capacityProfiles.map((p: any) => p.id)
    expect(ids).not.toContain('cp-1')
  })

  // Falls back to legacy — duplicate owner keys fail structural validation
  it('falls back to legacy when duplicate persisted owner rows exist', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue(mockProject({
      resourceTypes: [mockRt('rt-1', 'Engineer', { allocationMode: 'EFFORT' })],
      capacityProfiles: [
        mockPersistedProfile('cp-1', {
          resourceTypeId: 'rt-1',
          ownerKind: 'ROLE',
          planningBasis: 'DEMAND_FOLLOWING',
          source: 'FIXED',
          defaultPercent: 100,
        }),
        mockPersistedProfile('cp-2', {
          resourceTypeId: 'rt-1',
          ownerKind: 'ROLE',
          planningBasis: 'DEMAND_FOLLOWING',
          source: 'FIXED',
          defaultPercent: 100,
        }),
      ],
    }))

    const res = await request(app)
      .get('/api/projects/proj-1/capacity-profiles')
      .set('Authorization', authHeader)

    // Falls back to legacy — duplicate means reconciliation fails
    expect(res.status).toBe(200)
    expect(res.body.capacityProfiles[0].id).toBe('rt-1')
  })

  it('falls back to legacy when persisted profile references non-existent resource type', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue(mockProject({
      resourceTypes: [mockRt('rt-1', 'Engineer', { allocationMode: 'EFFORT' })],
      capacityProfiles: [mockPersistedProfile('cp-1', {
        resourceTypeId: 'rt-missing', // orphan owner — no such RT
        ownerKind: 'ROLE',
        planningBasis: 'DEMAND_FOLLOWING',
        source: 'FIXED',
        defaultPercent: 100,
      })],
    }))

    const res = await request(app)
      .get('/api/projects/proj-1/capacity-profiles')
      .set('Authorization', authHeader)

    expect(res.status).toBe(200)
    expect(res.body.capacityProfiles[0].id).toBe('rt-1')
  })

  it('falls back to legacy when persisted profile has both resourceTypeId and namedResourceId', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue(mockProject({
      resourceTypes: [mockRt('rt-1', 'Engineer', {
        allocationMode: 'EFFORT',
        namedResources: [mockNr('nr-1', 'Alice')],
      })],
      capacityProfiles: [mockPersistedProfile('cp-1', {
        resourceTypeId: 'rt-1',
        namedResourceId: 'nr-1', // exactly-one FK violation: both set
        ownerKind: 'NAMED_PERSON',
        planningBasis: 'DEMAND_FOLLOWING',
        source: 'FIXED',
        defaultPercent: 100,
      })],
    }))

    const res = await request(app)
      .get('/api/projects/proj-1/capacity-profiles')
      .set('Authorization', authHeader)

    expect(res.status).toBe(200)
    // RT has named resource → legacy fallback returns named-person profile
    expect(res.body.capacityProfiles[0].owner.kind).toBe('namedPerson')
    expect(res.body.capacityProfiles[0].owner.id).toBe('nr-1')
    // Corrupt persisted profile id is NOT exposed
    const ids = res.body.capacityProfiles.map((p: any) => p.id)
    expect(ids).not.toContain('cp-1')
  })

  it('falls back to legacy when persisted profile has invalid source enum', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue(mockProject({
      resourceTypes: [mockRt('rt-1', 'Engineer', { allocationMode: 'EFFORT' })],
      capacityProfiles: [mockPersistedProfile('cp-1', {
        resourceTypeId: 'rt-1',
        ownerKind: 'ROLE',
        planningBasis: 'DEMAND_FOLLOWING',
        source: 'BOGUS', // invalid enum
        defaultPercent: 100,
      })],
    }))

    const res = await request(app)
      .get('/api/projects/proj-1/capacity-profiles')
      .set('Authorization', authHeader)

    expect(res.status).toBe(200)
    expect(res.body.capacityProfiles[0].id).toBe('rt-1')
  })

  it('falls back to legacy when ROLE profile is missing resourceTypeId', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue(mockProject({
      resourceTypes: [mockRt('rt-1', 'Engineer', { allocationMode: 'EFFORT' })],
      capacityProfiles: [mockPersistedProfile('cp-1', {
        resourceTypeId: null, // owner-kind shape violation: ROLE requires RT
        namedResourceId: 'nr-missing',
        ownerKind: 'ROLE',
        planningBasis: 'DEMAND_FOLLOWING',
        source: 'FIXED',
        defaultPercent: 100,
      })],
    }))

    const res = await request(app)
      .get('/api/projects/proj-1/capacity-profiles')
      .set('Authorization', authHeader)

    expect(res.status).toBe(200)
    expect(res.body.capacityProfiles[0].id).toBe('rt-1')
  })

  it('falls back to legacy when segment ranges overlap', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue(mockProject({
      resourceTypes: [mockRt('rt-1', 'Engineer', { allocationMode: 'CAPACITY_PLAN' })],
      capacityPlans: [{
        id: 'plan-1',
        isActive: true,
        periods: [{
          periodIndex: 0,
          startWeek: 0,
          endWeek: 8,
          entries: [{ resourceTypeId: 'rt-1', headcount: 1 }],
        }],
      }],
      capacityProfiles: [mockPersistedProfile('cp-1', {
        resourceTypeId: 'rt-1',
        ownerKind: 'ROLE',
        planningBasis: 'CAPACITY_PROFILE',
        source: 'SQUAD_PLANNER',
        defaultPercent: 100,
        segments: [
          { id: 'seg-1', capacityProfileId: 'cp-1', startWeek: 0, endWeek: 6, capacityPercent: 100, source: 'SQUAD_PLANNER' },
          { id: 'seg-2', capacityProfileId: 'cp-1', startWeek: 4, endWeek: 8, capacityPercent: 50, source: 'SQUAD_PLANNER' },
        ],
      })],
    }))

    const res = await request(app)
      .get('/api/projects/proj-1/capacity-profiles')
      .set('Authorization', authHeader)

    // Overlapping segments fail structural validation → fallback
    expect(res.status).toBe(200)
    expect(res.body.capacityProfiles[0].id).toBe('rt-1')
  })

  it('falls back to legacy when segment has duplicate week range', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue(mockProject({
      resourceTypes: [mockRt('rt-1', 'Engineer', { allocationMode: 'CAPACITY_PLAN' })],
      capacityPlans: [{
        id: 'plan-1',
        isActive: true,
        periods: [{
          periodIndex: 0,
          startWeek: 0,
          endWeek: 8,
          entries: [{ resourceTypeId: 'rt-1', headcount: 1 }],
        }],
      }],
      capacityProfiles: [mockPersistedProfile('cp-1', {
        resourceTypeId: 'rt-1',
        ownerKind: 'ROLE',
        planningBasis: 'CAPACITY_PROFILE',
        source: 'SQUAD_PLANNER',
        defaultPercent: 100,
        segments: [
          { id: 'seg-1', startWeek: 0, endWeek: 6, capacityPercent: 100, source: 'SQUAD_PLANNER' },
          { id: 'seg-2', startWeek: 0, endWeek: 6, capacityPercent: 50, source: 'SQUAD_PLANNER' },
        ],
      })],
    }))

    const res = await request(app)
      .get('/api/projects/proj-1/capacity-profiles')
      .set('Authorization', authHeader)

    // Duplicate week range fails structural validation → fallback
    expect(res.status).toBe(200)
    expect(res.body.capacityProfiles[0].id).toBe('rt-1')
  })

  it('performs no database writes on persisted-read path', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue(mockProject({
      resourceTypes: [mockRt('rt-1', 'Engineer', { allocationMode: 'EFFORT' })],
      capacityProfiles: [mockPersistedProfile('cp-1', {
        resourceTypeId: 'rt-1',
        ownerKind: 'ROLE',
        planningBasis: 'DEMAND_FOLLOWING',
        source: 'FIXED',
        defaultPercent: 100,
      })],
    }))

    await request(app)
      .get('/api/projects/proj-1/capacity-profiles')
      .set('Authorization', authHeader)

    expect(prisma.capacityProfile.create).not.toHaveBeenCalled()
    expect(prisma.capacityProfile.update).not.toHaveBeenCalled()
    expect(prisma.capacityProfile.delete).not.toHaveBeenCalled()
    expect(prisma.capacityProfile.deleteMany).not.toHaveBeenCalled()
    expect(prisma.capacitySegment.create).not.toHaveBeenCalled()
    expect(prisma.capacitySegment.update).not.toHaveBeenCalled()
    expect(prisma.capacitySegment.delete).not.toHaveBeenCalled()
    expect(prisma.capacitySegment.deleteMany).not.toHaveBeenCalled()
  })

  it('mapPersistedProfilesToDTOs sorts persisted segments by startWeek then endWeek', () => {
    const resourceTypeById = new Map([['rt-1', { id: 'rt-1', name: 'Engineer' }]])
    const namedResourceById = new Map()

    const profiles = [{
      id: 'cp-1',
      projectId: 'proj-1',
      resourceTypeId: 'rt-1' as const,
      namedResourceId: null,
      ownerKind: 'ROLE',
      planningBasis: 'DEMAND_FOLLOWING',
      source: 'FIXED',
      defaultPercent: 100,
      startWeek: null,
      endWeek: null,
      segments: [
        { id: 'seg-week-3', startWeek: 3, endWeek: 4, capacityPercent: 100, source: 'SQUAD_PLANNER' },
        { id: 'seg-week-1b', startWeek: 1, endWeek: 3, capacityPercent: 100, source: 'SQUAD_PLANNER' },
        { id: 'seg-week-1a', startWeek: 1, endWeek: 2, capacityPercent: 100, source: 'SQUAD_PLANNER' },
      ],
    }]

    const dtos = mapPersistedProfilesToDTOs(
      profiles as any,
      resourceTypeById,
      namedResourceById,
    )

    expect(dtos[0].segments.map(s => s.id)).toEqual([
      'seg-week-1a',
      'seg-week-1b',
      'seg-week-3',
    ])
  })


  it('falls back to legacy when one of two named resources is missing a profile', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue(mockProject({
      resourceTypes: [mockRt('rt-1', 'Engineer', {
        allocationMode: 'EFFORT',
        namedResources: [
          mockNr('nr-1', 'Alice'),
          mockNr('nr-2', 'Bob'),
        ],
      })],
      capacityProfiles: [mockPersistedProfile('cp-1', {
        namedResourceId: 'nr-1',
        ownerKind: 'NAMED_PERSON',
        planningBasis: 'DEMAND_FOLLOWING',
        source: 'FIXED',
        defaultPercent: 100,
      })],
      // nr-2 (Bob) has no persisted profile → incomplete
    }))

    const res = await request(app)
      .get('/api/projects/proj-1/capacity-profiles')
      .set('Authorization', authHeader)

    // Incomplete named-resource coverage → legacy fallback
    expect(res.status).toBe(200)
    expect(res.body.capacityProfiles).toHaveLength(2)
    expect(res.body.capacityProfiles[0].owner.kind).toBe('namedPerson')
    expect(res.body.capacityProfiles[1].owner.kind).toBe('namedPerson')
    const ids = res.body.capacityProfiles.map((p: any) => p.id)
    expect(ids).not.toContain('cp-1')
  })

  it('returns complete ROLE + named/planned hybrid persisted profiles', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue(mockProject({
      resourceTypes: [
        mockRt('rt-1', 'Engineer', {
          allocationMode: 'EFFORT',
          namedResources: [mockNr('nr-1', 'Alice')],
        }),
        mockRt('rt-2', 'Designer', { allocationMode: 'EFFORT' }),
      ],
      capacityProfiles: [
        mockPersistedProfile('cp-role', {
          resourceTypeId: 'rt-1',
          ownerKind: 'ROLE',
          planningBasis: 'CAPACITY_PROFILE',
          source: 'SQUAD_PLANNER',
          defaultPercent: 100,
          segments: [mockPersistedSegment({ id: 'seg-rt1', endWeek: 7 })],
        }),
        mockPersistedProfile('cp-alice', {
          namedResourceId: 'nr-1',
          ownerKind: 'NAMED_PERSON',
          planningBasis: 'DEMAND_FOLLOWING',
          source: 'FIXED',
          defaultPercent: 100,
        }),
        mockPersistedProfile('cp-designer', {
          resourceTypeId: 'rt-2',
          ownerKind: 'ROLE',
          planningBasis: 'DEMAND_FOLLOWING',
          source: 'FIXED',
          defaultPercent: 100,
        }),
      ],
    }))

    const res = await request(app)
      .get('/api/projects/proj-1/capacity-profiles')
      .set('Authorization', authHeader)

    // Complete coverage: RT-1 has ROLE + NR profile, RT-2 has ROLE profile
    expect(res.status).toBe(200)
    expect(res.body.capacityProfiles).toHaveLength(3)
    // mapPersistedProfilesToDTOs sorts: role profiles first (by owner id), then namedPerson
    expect(res.body.capacityProfiles[0].id).toBe('cp-role')
    expect(res.body.capacityProfiles[1].id).toBe('cp-designer')
    expect(res.body.capacityProfiles[2].id).toBe('cp-alice')
    // Persisted IDs and trajectories preserved
    expect(res.body.capacityProfiles[0].segments[0].id).toBe('seg-rt1')
  })

  it('preserves all owners in legacy fallback when persisted data is incomplete', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue(mockProject({
      resourceTypes: [
        mockRt('rt-1', 'Engineer', {
          allocationMode: 'EFFORT',
          namedResources: [
            mockNr('nr-1', 'Alice'),
            mockNr('nr-2', 'Bob'),
          ],
        }),
        mockRt('rt-2', 'Designer', { allocationMode: 'EFFORT' }),
      ],
      capacityProfiles: [mockPersistedProfile('cp-1', {
        namedResourceId: 'nr-1',
        ownerKind: 'NAMED_PERSON',
        planningBasis: 'DEMAND_FOLLOWING',
        source: 'FIXED',
        defaultPercent: 100,
      })],
      // Only nr-1 profile exists; nr-2 and rt-2 have none → incomplete
    }))

    const res = await request(app)
      .get('/api/projects/proj-1/capacity-profiles')
      .set('Authorization', authHeader)

    // Legacy fallback must include all owners
    expect(res.status).toBe(200)
    expect(res.body.capacityProfiles).toHaveLength(3)
    const ownerKinds = res.body.capacityProfiles.map((p: any) => p.owner.kind)
    const ownerIds = res.body.capacityProfiles.map((p: any) => p.owner.id)
    // Alice and Bob as namedPerson owners
    expect(ownerKinds.filter((k: string) => k === 'namedPerson')).toHaveLength(2)
    // Designer as role owner
    expect(ownerKinds.filter((k: string) => k === 'role')).toHaveLength(1)
    expect(ownerIds).toContain('nr-1')
    expect(ownerIds).toContain('nr-2')
    expect(ownerIds).toContain('rt-2')
  })

})
