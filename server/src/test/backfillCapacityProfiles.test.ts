/**
 * backfillCapacityProfiles.test.ts — Tests for the idempotent backfill helper.
 *
 * Covers mapping rules, idempotency, validation, and edge cases.
 * Uses mocked Prisma client via the global test setup.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { prisma } from '../lib/prisma.js'
import {
  backfillCapacityProfiles,
  CapacityProfileValidationError,
} from '../lib/backfillCapacityProfiles.js'

beforeEach(() => vi.clearAllMocks())

// ─── Helpers ───────────────────────────────────────────────────────────────

interface RtMock {
  id: string
  name: string
  count: number
  allocationMode: string
  allocationPercent: number
  allocationStartWeek: number | null
  allocationEndWeek: number | null
  namedResources: NrMock[]
}

interface NrMock {
  id: string
  name: string
  startWeek: number | null
  endWeek: number | null
  allocationPct: number
  allocationMode: string
  allocationPercent: number
  allocationStartWeek: number | null
  allocationEndWeek: number | null
  pricingModel: string
}

interface PlanMock {
  id: string
  isActive: boolean
  periods: PeriodMock[]
}

interface PeriodMock {
  periodIndex: number
  startWeek: number
  endWeek: number
  entries: Array<{ resourceTypeId: string; headcount: number }>
}

function makeProject(
  id: string,
  resourceTypes: RtMock[],
  capacityPlans: PlanMock[] = [],
) {
  return { id, resourceTypes, capacityPlans }
}

function makeRt(
  id: string,
  name: string,
  overrides: Partial<RtMock> = {},
): RtMock {
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

function makeNr(
  id: string,
  name: string,
  overrides: Partial<NrMock> = {},
): NrMock {
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

describe('backfillCapacityProfiles', () => {
  it('creates a role-owned profile from a ResourceType with EFFORT → DEMAND_FOLLOWING', async () => {
    vi.mocked(prisma.project.findMany).mockResolvedValue([
      makeProject('proj-1', [makeRt('rt-1', 'Engineer', { allocationMode: 'EFFORT' })]),
    ] as any)
    vi.mocked(prisma.capacityProfile.findFirst).mockResolvedValue(null)
    vi.mocked(prisma.capacityProfile.create).mockResolvedValue({ id: 'cp-1' } as any)

    const result = await backfillCapacityProfiles(prisma as any)

    expect(result.profilesCreated).toBe(1)
    expect(result.segmentsCreated).toBe(0)

    const createCall = vi.mocked(prisma.capacityProfile.create).mock.calls[0][0]
    expect(createCall.data.ownerKind).toBe('ROLE')
    expect(createCall.data.planningBasis).toBe('DEMAND_FOLLOWING')
    expect(createCall.data.source).toBe('FIXED')
    expect(createCall.data.resourceTypeId).toBe('rt-1')
    expect(createCall.data.namedResourceId).toBeNull()
  })

  it('maps TIMELINE → AVAILABILITY_WINDOW preserving percent/start/end', async () => {
    vi.mocked(prisma.project.findMany).mockResolvedValue([
      makeProject('proj-1', [
        makeRt('rt-1', 'Dev', {
          allocationMode: 'TIMELINE',
          allocationPercent: 75,
          allocationStartWeek: 2,
          allocationEndWeek: 10,
        }),
      ]),
    ] as any)
    vi.mocked(prisma.capacityProfile.findFirst).mockResolvedValue(null)
    vi.mocked(prisma.capacityProfile.create).mockResolvedValue({ id: 'cp-1' } as any)

    await backfillCapacityProfiles(prisma as any)

    const createCall = vi.mocked(prisma.capacityProfile.create).mock.calls[0][0]
    expect(createCall.data.ownerKind).toBe('ROLE')
    expect(createCall.data.planningBasis).toBe('AVAILABILITY_WINDOW')
    expect(createCall.data.source).toBe('AVAILABILITY_WINDOW')
    expect(createCall.data.defaultPercent).toBe(75)
    expect(createCall.data.startWeek).toBe(2)
    expect(createCall.data.endWeek).toBe(10)
  })

  it('maps FULL_PROJECT → WHOLE_PROJECT_ALLOCATION', async () => {
    vi.mocked(prisma.project.findMany).mockResolvedValue([
      makeProject('proj-1', [makeRt('rt-1', 'PM', { allocationMode: 'FULL_PROJECT' })]),
    ] as any)
    vi.mocked(prisma.capacityProfile.findFirst).mockResolvedValue(null)
    vi.mocked(prisma.capacityProfile.create).mockResolvedValue({ id: 'cp-1' } as any)

    await backfillCapacityProfiles(prisma as any)

    const createCall = vi.mocked(prisma.capacityProfile.create).mock.calls[0][0]
    expect(createCall.data.planningBasis).toBe('WHOLE_PROJECT_ALLOCATION')
    expect(createCall.data.source).toBe('FIXED')
  })

  it('maps CAPACITY_PLAN → CAPACITY_PROFILE with segments', async () => {
    vi.mocked(prisma.project.findMany).mockResolvedValue([
      makeProject('proj-1', [makeRt('rt-1', 'Engineer', { allocationMode: 'CAPACITY_PLAN' })], [
        {
          id: 'plan-1',
          isActive: true,
          periods: [
            { periodIndex: 0, startWeek: 0, endWeek: 8, entries: [{ resourceTypeId: 'rt-1', headcount: 1 }] },
          ],
        },
      ]),
    ] as any)
    vi.mocked(prisma.capacityProfile.findFirst).mockResolvedValue(null)
    vi.mocked(prisma.capacityProfile.create).mockResolvedValue({ id: 'cp-1' } as any)

    await backfillCapacityProfiles(prisma as any)

    const createCall = vi.mocked(prisma.capacityProfile.create).mock.calls[0][0]
    expect(createCall.data.planningBasis).toBe('CAPACITY_PROFILE')
    expect(createCall.data.source).toBe('SQUAD_PLANNER')
    expect(createCall.data.segments.create).toHaveLength(1)
    expect(createCall.data.segments.create[0]).toMatchObject({
      startWeek: 0,
      endWeek: 7,
      capacityPercent: 100,
      source: 'SQUAD_PLANNER',
    })
  })

  it('does not create segments for non-CAPACITY_PLAN mode even with active plan', async () => {
    vi.mocked(prisma.project.findMany).mockResolvedValue([
      makeProject('proj-1', [makeRt('rt-1', 'Engineer', { allocationMode: 'EFFORT' })], [
        {
          id: 'plan-1',
          isActive: true,
          periods: [
            { periodIndex: 0, startWeek: 0, endWeek: 8, entries: [{ resourceTypeId: 'rt-1', headcount: 1 }] },
          ],
        },
      ]),
    ] as any)
    vi.mocked(prisma.capacityProfile.findFirst).mockResolvedValue(null)
    vi.mocked(prisma.capacityProfile.create).mockResolvedValue({ id: 'cp-1' } as any)

    await backfillCapacityProfiles(prisma as any)

    const createCall = vi.mocked(prisma.capacityProfile.create).mock.calls[0][0]
    expect(createCall.data.planningBasis).toBe('DEMAND_FOLLOWING')
    expect(createCall.data.source).toBe('FIXED')
    expect(createCall.data.segments.create).toHaveLength(0)
  })

  it('creates named-person profile from a persisted NamedResource', async () => {
    vi.mocked(prisma.project.findMany).mockResolvedValue([
      makeProject('proj-1', [
        makeRt('rt-1', 'Engineer', {
          allocationMode: 'EFFORT',
          namedResources: [makeNr('nr-1', 'Alice')],
        }),
      ]),
    ] as any)
    vi.mocked(prisma.capacityProfile.findFirst).mockResolvedValue(null)
    vi.mocked(prisma.capacityProfile.create).mockResolvedValue({ id: 'cp-1' } as any)

    await backfillCapacityProfiles(prisma as any)

    const createCall = vi.mocked(prisma.capacityProfile.create).mock.calls[0][0]
    expect(createCall.data.ownerKind).toBe('NAMED_PERSON')
    expect(createCall.data.namedResourceId).toBe('nr-1')
    expect(createCall.data.resourceTypeId).toBeNull()
  })

  it('does not create fake named-person profiles from role count', async () => {
    // A role with count=3 and no named resources should produce ONE role profile
    vi.mocked(prisma.project.findMany).mockResolvedValue([
      makeProject('proj-1', [makeRt('rt-1', 'Engineer', { count: 3, allocationMode: 'EFFORT', namedResources: [] })]),
    ] as any)
    vi.mocked(prisma.capacityProfile.findFirst).mockResolvedValue(null)
    vi.mocked(prisma.capacityProfile.create).mockResolvedValue({ id: 'cp-1' } as any)

    await backfillCapacityProfiles(prisma as any)

    expect(vi.mocked(prisma.capacityProfile.create).mock.calls.length).toBe(1)
    const createCall = vi.mocked(prisma.capacityProfile.create).mock.calls[0][0]
    expect(createCall.data.ownerKind).toBe('ROLE')
  })

  it('handles missing/inactive capacity plans safely', async () => {
    vi.mocked(prisma.project.findMany).mockResolvedValue([
      makeProject('proj-1', [makeRt('rt-1', 'Engineer', { allocationMode: 'EFFORT' })], []),
    ] as any)
    vi.mocked(prisma.capacityProfile.findFirst).mockResolvedValue(null)
    vi.mocked(prisma.capacityProfile.create).mockResolvedValue({ id: 'cp-1' } as any)

    const result = await backfillCapacityProfiles(prisma as any)

    expect(result.profilesCreated).toBe(1)
    expect(result.segmentsCreated).toBe(0)
  })

  it('running twice does not duplicate profiles (idempotent update)', async () => {
    // First call: no existing profile → create
    vi.mocked(prisma.project.findMany).mockResolvedValue([
      makeProject('proj-1', [makeRt('rt-1', 'Engineer', { allocationMode: 'EFFORT' })]),
    ] as any)
    vi.mocked(prisma.capacityProfile.findFirst)
      .mockResolvedValueOnce(null) // first call: no existing
      .mockResolvedValueOnce({ id: 'cp-1' } as any) // second call: found
    vi.mocked(prisma.capacityProfile.create).mockResolvedValue({ id: 'cp-1' } as any)
    vi.mocked(prisma.capacityProfile.update).mockResolvedValue({ id: 'cp-1' } as any)
    vi.mocked(prisma.capacitySegment.deleteMany).mockResolvedValue({ count: 0 })

    // Run twice
    await backfillCapacityProfiles(prisma as any)
    await backfillCapacityProfiles(prisma as any)

    // Should have created once and updated once
    expect(vi.mocked(prisma.capacityProfile.create).mock.calls.length).toBe(1)
    expect(vi.mocked(prisma.capacityProfile.update).mock.calls.length).toBe(1)
  })

  it('does not modify legacy fields on existing records', async () => {
    vi.mocked(prisma.project.findMany).mockResolvedValue([
      makeProject('proj-1', [makeRt('rt-1', 'Engineer', { allocationMode: 'EFFORT' })]),
    ] as any)
    vi.mocked(prisma.capacityProfile.findFirst).mockResolvedValue({ id: 'cp-1' } as any)
    vi.mocked(prisma.capacityProfile.update).mockResolvedValue({ id: 'cp-1' } as any)
    vi.mocked(prisma.capacitySegment.deleteMany).mockResolvedValue({ count: 0 })

    await backfillCapacityProfiles(prisma as any)

    const updateCall = vi.mocked(prisma.capacityProfile.update).mock.calls[0][0]
    expect(updateCall.data.legacy).toBeDefined()
    expect(updateCall.data.legacy).toHaveProperty('allocationMode')
  })

  it('preserves legacy fields in the legacy JSON', async () => {
    vi.mocked(prisma.project.findMany).mockResolvedValue([
      makeProject('proj-1', [
        makeRt('rt-1', 'Engineer', {
          allocationMode: 'TIMELINE',
          allocationPercent: 80,
          allocationStartWeek: 1,
          allocationEndWeek: 8,
        }),
      ]),
    ] as any)
    vi.mocked(prisma.capacityProfile.findFirst).mockResolvedValue(null)
    vi.mocked(prisma.capacityProfile.create).mockResolvedValue({ id: 'cp-1' } as any)

    await backfillCapacityProfiles(prisma as any)

    const createCall = vi.mocked(prisma.capacityProfile.create).mock.calls[0][0]
    const legacy = createCall.data.legacy as Record<string, unknown>
    expect(legacy.allocationMode).toBe('TIMELINE')
    expect(legacy.allocationPercent).toBe(80)
    expect(legacy.allocationStartWeek).toBe(1)
    expect(legacy.allocationEndWeek).toBe(8)
  })
})

describe('CapacityProfileValidationError', () => {
  it('has the correct name', () => {
    const err = new CapacityProfileValidationError('test')
    expect(err.name).toBe('CapacityProfileValidationError')
    expect(err.message).toBe('test')
  })
})
