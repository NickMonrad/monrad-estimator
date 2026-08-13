/**
 * capacityProfileReplaceRoute.test.ts — Server route tests for the
 * capacity-profile PUT replace endpoint.
 *
 * Tests project scoping, owner lookup, conflict detection, and
 * successful create/update with mocked Prisma and service.
 *
 * Endpoint: PUT /api/projects/:projectId/capacity-profiles/:ownerKind/:ownerId
 *   ownerKind: "ROLE" | "NAMED_PERSON"
 *
 * @see issue #363 — Capacity profile segment editor
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { app } from '../index.js'

process.env.JWT_SECRET = 'test-secret'

const userId = 'user-1'
const token = jwt.sign({ userId }, 'test-secret')
const authHeader = `Bearer ${token}`

// Mock the replace service to isolate route behaviour
vi.mock('../lib/capacityProfileReplaceService.js', () => {
  class ServiceError extends Error {
    status: number
    constructor(status: number, message: string) {
      super(message)
      this.name = 'ServiceError'
      this.status = status
    }
  }
  return {
    replaceCapacityProfile: vi.fn(),
    ServiceError,
  }
})

// Import after vi.mock
import { prisma } from '../lib/prisma.js'
import { replaceCapacityProfile, ServiceError } from '../lib/capacityProfileReplaceService.js'

const mockReplace = vi.mocked(replaceCapacityProfile)

beforeEach(() => vi.clearAllMocks())

const validRoleBody = { planningBasis: 'DEMAND_FOLLOWING', defaultPercent: 100 }
const validPersonBody = { planningBasis: 'AVAILABILITY_WINDOW', defaultPercent: 75, startWeek: 2, endWeek: 10 }
const segmentedBody = {
  planningBasis: 'CAPACITY_PROFILE',
  startWeek: null as number | null,
  endWeek: null as number | null,
  segments: [
    { startWeek: 0, endWeek: 4, capacityPercent: 100 },
    { startWeek: 5, endWeek: 8, capacityPercent: 50 },
  ],
}

describe('PUT /api/projects/:projectId/capacity-profiles/:ownerKind/:ownerId', () => {
  beforeEach(() => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue({
      id: 'proj-1', ownerId: userId,
    } as never)
    mockReplace.mockResolvedValue({
      id: 'cp-1',
      projectId: 'proj-1',
      owner: { kind: 'role' as const, id: 'rt-1', name: 'Engineer' },
      planningBasis: 'demandFollowing' as const,
      defaultPercent: 100,
      startWeek: null,
      endWeek: null,
      segments: [],
      provenance: null,
    } as never)
  })

  it('returns 401 without auth token', async () => {
    const res = await request(app)
      .put('/api/projects/proj-1/capacity-profiles/ROLE/rt-1')
      .send(validRoleBody)
    expect(res.status).toBe(401)
  })

  it('returns 404 when project is not found', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue(null)
    const res = await request(app)
      .put('/api/projects/nonexistent/capacity-profiles/ROLE/rt-1')
      .set('Authorization', authHeader)
      .send(validRoleBody)
    expect(res.status).toBe(404)
    expect(res.body.error).toMatch(/project not found/i)
  })

  it('returns 400 for invalid ownerKind', async () => {
    const res = await request(app)
      .put('/api/projects/proj-1/capacity-profiles/FOO/rt-1')
      .set('Authorization', authHeader)
      .send(validRoleBody)
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/ownerKind must be/i)
  })

  it('returns 400 for invalid planningBasis', async () => {
    const res = await request(app)
      .put('/api/projects/proj-1/capacity-profiles/ROLE/rt-1')
      .set('Authorization', authHeader)
      .send({ planningBasis: 'INVALID' })
    expect(res.status).toBe(400)
  })

  it('returns 400 when CAPACITY_PROFILE has no segments', async () => {
    const res = await request(app)
      .put('/api/projects/proj-1/capacity-profiles/ROLE/rt-1')
      .set('Authorization', authHeader)
      .send({ planningBasis: 'CAPACITY_PROFILE', segments: [] })
    expect(res.status).toBe(400)
    expect(res.body).toHaveProperty('error')
  })

  it('returns 400 when DEMAND_FOLLOWING has segments', async () => {
    const res = await request(app)
      .put('/api/projects/proj-1/capacity-profiles/ROLE/rt-1')
      .set('Authorization', authHeader)
      .send({
        planningBasis: 'DEMAND_FOLLOWING',
        segments: [{ startWeek: 0, endWeek: 4, capacityPercent: 100 }],
      })
    expect(res.status).toBe(400)
    expect(res.body).toHaveProperty('error')
  })

  it.each([
    ['string', 'invalid'],
    ['object', { startWeek: 0 }],
    ['number', 42],
  ])('returns 400 for malformed scalar segments shaped as %s', async (_shape, segments) => {
    const res = await request(app)
      .put('/api/projects/proj-1/capacity-profiles/ROLE/rt-1')
      .set('Authorization', authHeader)
      .send({ ...validRoleBody, segments })
    expect(res.status).toBe(400)
    expect(res.body.details).toEqual(expect.arrayContaining([
      expect.stringMatching(/must not have segments/i),
    ]))
    expect(mockReplace).not.toHaveBeenCalled()
  })

  it('maps only the expected CapacityProfile owner uniqueness P2002 to 409', async () => {
    mockReplace.mockRejectedValue({
      code: 'P2002',
      meta: { modelName: 'CapacityProfile', target: ['resourceTypeId'] },
    })
    const res = await request(app)
      .put('/api/projects/proj-1/capacity-profiles/ROLE/rt-1')
      .set('Authorization', authHeader)
      .send(validRoleBody)
    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/already exists for this owner/i)
  })

  it.each([
    ['another model', { modelName: 'ResourceType', target: ['resourceTypeId'] }],
    ['another target', { modelName: 'CapacityProfile', target: ['projectId'] }],
    ['compound target', { modelName: 'CapacityProfile', target: ['resourceTypeId', 'projectId'] }],
  ])('does not map unrelated P2002 from %s to the owner conflict', async (_case, meta) => {
    mockReplace.mockRejectedValue({ code: 'P2002', meta })
    const res = await request(app)
      .put('/api/projects/proj-1/capacity-profiles/ROLE/rt-1')
      .set('Authorization', authHeader)
      .send(validRoleBody)
    expect(res.status).toBe(500)
    expect(res.body.error).not.toBe('A capacity profile already exists for this owner')
  })

  it('returns 409 when service throws ServiceError(409)', async () => {
    mockReplace.mockRejectedValue(new ServiceError(409, 'Cannot replace a PLANNED_RESOURCE profile manually'))
    const res = await request(app)
      .put('/api/projects/proj-1/capacity-profiles/ROLE/rt-1')
      .set('Authorization', authHeader)
      .send(validRoleBody)
    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/PLANNED_RESOURCE/i)
  })

  it('returns 409 for SQUAD_PLANNER conflict', async () => {
    mockReplace.mockRejectedValue(new ServiceError(409, 'Cannot overwrite a SQUAD_PLANNER profile manually'))
    const res = await request(app)
      .put('/api/projects/proj-1/capacity-profiles/ROLE/rt-1')
      .set('Authorization', authHeader)
      .send(segmentedBody)
    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/SQUAD_PLANNER/i)
  })

  it('returns 404 when service throws ServiceError(404)', async () => {
    mockReplace.mockRejectedValue(new ServiceError(404, 'ResourceType "rt-1" not found in project'))
    const res = await request(app)
      .put('/api/projects/proj-1/capacity-profiles/ROLE/rt-1')
      .set('Authorization', authHeader)
      .send(validRoleBody)
    expect(res.status).toBe(404)
  })

  it('creates a new ROLE profile successfully', async () => {
    mockReplace.mockResolvedValue({
      id: 'cp-new',
      projectId: 'proj-1',
      owner: { kind: 'role' as const, id: 'rt-1', name: 'Engineer' },
      planningBasis: 'demandFollowing' as const,
      defaultPercent: 100,
      startWeek: null,
      endWeek: null,
      segments: [],
      provenance: null,
    } as never)
    const res = await request(app)
      .put('/api/projects/proj-1/capacity-profiles/ROLE/rt-1')
      .set('Authorization', authHeader)
      .send(validRoleBody)
    expect(res.status).toBe(200)
    expect(res.body.capacityProfile).toBeDefined()
    expect(res.body.capacityProfile.id).toBe('cp-new')
    expect(mockReplace).toHaveBeenCalledWith(
      expect.anything(), 'proj-1', 'ROLE', 'rt-1',
      expect.objectContaining({ planningBasis: 'DEMAND_FOLLOWING' }),
      expect.any(String),
    )
  })

  it('creates a new NAMED_PERSON profile successfully', async () => {
    mockReplace.mockResolvedValue({
      id: 'cp-new-nr',
      projectId: 'proj-1',
      owner: { kind: 'namedPerson' as const, id: 'nr-1', name: 'Alice', roleId: 'rt-1' },
      planningBasis: 'availabilityWindow' as const,
      defaultPercent: 75,
      startWeek: 2,
      endWeek: 10,
      segments: [],
      provenance: null,
    } as never)
    const res = await request(app)
      .put('/api/projects/proj-1/capacity-profiles/NAMED_PERSON/nr-1')
      .set('Authorization', authHeader)
      .send(validPersonBody)
    expect(res.status).toBe(200)
    expect(res.body.capacityProfile).toBeDefined()
    expect(res.body.capacityProfile.owner.kind).toBe('namedPerson')
    expect(mockReplace).toHaveBeenCalledWith(
      expect.anything(), 'proj-1', 'NAMED_PERSON', 'nr-1',
      expect.objectContaining({ planningBasis: 'AVAILABILITY_WINDOW' }),
      expect.any(String),
    )
  })

  it('returns 500 for non-ServiceError exceptions from service', async () => {
    mockReplace.mockRejectedValue(new Error('Database connection failed'))
    const res = await request(app)
      .put('/api/projects/proj-1/capacity-profiles/ROLE/rt-1')
      .set('Authorization', authHeader)
      .send(validRoleBody)
    expect(res.status).toBe(500)
  })

  it('returns 400 when NAMED_PERSON defaultPercent > 100', async () => {
    const res = await request(app)
      .put('/api/projects/proj-1/capacity-profiles/NAMED_PERSON/nr-1')
      .set('Authorization', authHeader)
      .send({ planningBasis: 'DEMAND_FOLLOWING', defaultPercent: 150 })
    expect(res.status).toBe(400)
  })
})
