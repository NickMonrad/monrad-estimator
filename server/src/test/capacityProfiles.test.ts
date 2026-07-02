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
              endWeek: 8,
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
              endWeek: 8,
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
