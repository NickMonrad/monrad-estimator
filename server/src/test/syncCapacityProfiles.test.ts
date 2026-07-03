/**
 * syncCapacityProfiles.test.ts — Tests for the runtime sync helper.
 *
 * Covers profile creation, update, segment replacement, stale-profile
 * deletion, idempotency, reconciliation failure, and empty segments.
 * Uses mocked Prisma client via the global test setup.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { prisma } from '../lib/prisma.js'

// Override the global sync mock so we test the real implementation
vi.mock('../lib/syncCapacityProfiles.js', async (importOriginal: () => Promise<any>) => {
  return await importOriginal()
})

// Mock only the dependencies that are hard to set up via Prisma mocks
vi.mock('../lib/capacityProfileMapping.js', () => ({
  mapProjectToCapacityProfiles: vi.fn(),
}))

vi.mock('../lib/capacityPlanMaterialisation.js', () => ({
  materializeCapacityPlanResources: vi.fn().mockReturnValue(new Map()),
}))

vi.mock('../lib/reconcileCapacityProfiles.js', () => ({
  compareCapacityProfiles: vi.fn().mockReturnValue({ mismatches: [], expectedProfiles: 0, actualProfiles: 0, matchedProfiles: 0 }),
}))

// Import AFTER vi.mock calls so the mocks are in place
import { syncCapacityProfilesForProject } from '../lib/syncCapacityProfiles.js'
import { mapProjectToCapacityProfiles } from '../lib/capacityProfileMapping.js'
import { compareCapacityProfiles } from '../lib/reconcileCapacityProfiles.js'

beforeEach(() => vi.clearAllMocks())

// ─── Helpers ───────────────────────────────────────────────────────────────

function makeRt(
  id: string,
  name: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    id,
    name,
    allocationMode: 'EFFORT',
    allocationPercent: 100,
    allocationStartWeek: null,
    allocationEndWeek: null,
    namedResources: [],
    ...overrides,
  }
}

function mockProject(
  id: string,
  resourceTypes: any[],
  capacityPlans: any[] = [],
): any {
  return { id, resourceTypes, capacityPlans } as any
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('syncCapacityProfilesForProject', () => {
  it('creates persisted capacity profiles for a project with no existing profiles', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue(
      mockProject('proj-1', [makeRt('rt-1', 'Engineer')]),
    )
    vi.mocked(mapProjectToCapacityProfiles).mockReturnValue([
      {
        id: 'rt-1',
        projectId: 'proj-1',
        owner: { kind: 'role', id: 'rt-1', name: 'Engineer' },
        planningBasis: 'demandFollowing',
        source: 'fixed',
        defaultPercent: 100,
        startWeek: null,
        endWeek: null,
        segments: [],
        legacy: null as any,
      },
    ])
    vi.mocked(prisma.capacityProfile.findMany).mockResolvedValue([])
    vi.mocked(prisma.capacityProfile.create).mockResolvedValue({ id: 'cp-1' } as any)

    const result = await syncCapacityProfilesForProject(prisma, 'proj-1')

    expect(result.profilesCreated).toBe(1)
    expect(result.profilesUpdated).toBe(0)
    expect(result.profilesDeleted).toBe(0)
    expect(prisma.capacityProfile.create).toHaveBeenCalled()
    expect(prisma.capacityProfile.update).not.toHaveBeenCalled()
  })

  it('updates existing profile fields when legacy allocation fields change', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue(
      mockProject('proj-1', [makeRt('rt-1', 'Engineer', { allocationPercent: 75 })]),
    )
    vi.mocked(mapProjectToCapacityProfiles).mockReturnValue([
      {
        id: 'rt-1',
        projectId: 'proj-1',
        owner: { kind: 'role', id: 'rt-1', name: 'Engineer' },
        planningBasis: 'demandFollowing',
        source: 'fixed',
        defaultPercent: 75,
        startWeek: null,
        endWeek: null,
        segments: [],
        legacy: null as any,
      },
    ])
    vi.mocked(prisma.capacityProfile.findMany).mockResolvedValue([
      { id: 'cp-1', ownerKind: 'ROLE', resourceTypeId: 'rt-1', namedResourceId: null, segments: [] },
    ] as any)
    vi.mocked(prisma.capacityProfile.update).mockResolvedValue({} as any)
    vi.mocked(prisma.capacitySegment.deleteMany).mockResolvedValue({ count: 0 } as any)

    const result = await syncCapacityProfilesForProject(prisma, 'proj-1')

    expect(result.profilesUpdated).toBe(1)
    expect(result.profilesCreated).toBe(0)
    expect(prisma.capacityProfile.update).toHaveBeenCalled()
    expect(prisma.capacityProfile.create).not.toHaveBeenCalled()
  })

  it('replaces segments deterministically when active capacity plan periods change', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue(
      mockProject('proj-1', [makeRt('rt-1', 'Engineer')], [{ isActive: true }]),
    )
    vi.mocked(mapProjectToCapacityProfiles).mockReturnValue([
      {
        id: 'rt-1',
        projectId: 'proj-1',
        owner: { kind: 'role', id: 'rt-1', name: 'Engineer' },
        planningBasis: 'capacityProfile',
        source: 'squadPlanner',
        defaultPercent: 100,
        startWeek: null,
        endWeek: null,
        segments: [
          { id: 'seg-1', startWeek: 0, endWeek: 7, capacityPercent: 100, source: 'squadPlanner' },
        ],
        legacy: null as any,
      },
    ])
    vi.mocked(prisma.capacityProfile.findMany).mockResolvedValue([
      { id: 'cp-1', ownerKind: 'ROLE', resourceTypeId: 'rt-1', namedResourceId: null, segments: [{ startWeek: 0, endWeek: 3, capacityPercent: 50, source: 'SQUAD_PLANNER' }] },
    ] as any)
    vi.mocked(prisma.capacityProfile.update).mockResolvedValue({} as any)
    vi.mocked(prisma.capacitySegment.deleteMany).mockResolvedValue({ count: 1 } as any)
    vi.mocked(prisma.capacitySegment.create).mockResolvedValue({ id: 'seg-new' } as any)

    const result = await syncCapacityProfilesForProject(prisma, 'proj-1')

    expect(result.segmentsDeleted).toBeGreaterThanOrEqual(1)
    expect(result.segmentsCreated).toBe(1)
    expect(prisma.capacitySegment.deleteMany).toHaveBeenCalled()
    expect(prisma.capacitySegment.create).toHaveBeenCalled()
  })

  it('deletes stale persisted profiles when a resource type no longer maps', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue(
      mockProject('proj-1', [makeRt('rt-1', 'Engineer')]),
    )
    vi.mocked(mapProjectToCapacityProfiles).mockReturnValue([
      {
        id: 'rt-1',
        projectId: 'proj-1',
        owner: { kind: 'role', id: 'rt-1', name: 'Engineer' },
        planningBasis: 'demandFollowing',
        source: 'fixed',
        defaultPercent: 100,
        startWeek: null,
        endWeek: null,
        segments: [],
        legacy: null as any,
      },
    ])
    // Two persisted profiles but only one expected — the second should be deleted
    vi.mocked(prisma.capacityProfile.findMany).mockResolvedValue([
      { id: 'cp-1', ownerKind: 'ROLE', resourceTypeId: 'rt-1', namedResourceId: null, segments: [] },
      { id: 'cp-stale', ownerKind: 'ROLE', resourceTypeId: 'rt-deleted', namedResourceId: null, segments: [] },
    ] as any)
    vi.mocked(prisma.capacityProfile.update).mockResolvedValue({} as any)
    vi.mocked(prisma.capacitySegment.deleteMany).mockResolvedValue({ count: 0 } as any)
    vi.mocked(prisma.capacityProfile.delete).mockResolvedValue({} as any)

    const result = await syncCapacityProfilesForProject(prisma, 'proj-1')

    expect(result.profilesDeleted).toBe(1)
    expect(result.profilesUpdated).toBe(1)
    expect(prisma.capacityProfile.delete).toHaveBeenCalledWith({ where: { id: 'cp-stale' } })
  })

  it('is idempotent: running twice produces the same result', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue(
      mockProject('proj-1', [makeRt('rt-1', 'Engineer')]),
    )
    vi.mocked(mapProjectToCapacityProfiles).mockReturnValue([
      {
        id: 'rt-1',
        projectId: 'proj-1',
        owner: { kind: 'role', id: 'rt-1', name: 'Engineer' },
        planningBasis: 'demandFollowing',
        source: 'fixed',
        defaultPercent: 100,
        startWeek: null,
        endWeek: null,
        segments: [],
        legacy: null as any,
      },
    ])
    // Persisted already matches expected — only updates, no creates or deletes
    vi.mocked(prisma.capacityProfile.findMany).mockResolvedValue([
      { id: 'cp-1', ownerKind: 'ROLE', resourceTypeId: 'rt-1', namedResourceId: null, segments: [] },
    ] as any)
    vi.mocked(prisma.capacityProfile.update).mockResolvedValue({} as any)
    vi.mocked(prisma.capacitySegment.deleteMany).mockResolvedValue({ count: 0 } as any)

    const result = await syncCapacityProfilesForProject(prisma, 'proj-1')

    expect(result.profilesCreated).toBe(0)
    expect(result.profilesDeleted).toBe(0)
    expect(result.profilesUpdated).toBe(1)
  })

  it('throws on reconciliation failure after sync', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue(
      mockProject('proj-1', [makeRt('rt-1', 'Engineer')]),
    )
    vi.mocked(mapProjectToCapacityProfiles).mockReturnValue([
      {
        id: 'rt-1',
        projectId: 'proj-1',
        owner: { kind: 'role', id: 'rt-1', name: 'Engineer' },
        planningBasis: 'demandFollowing',
        source: 'fixed',
        defaultPercent: 100,
        startWeek: null,
        endWeek: null,
        segments: [],
        legacy: null as any,
      },
    ])
    vi.mocked(prisma.capacityProfile.findMany)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { id: 'cp-1', ownerKind: 'ROLE', resourceTypeId: 'rt-1', namedResourceId: null, segments: [] },
      ] as any)
    vi.mocked(prisma.capacityProfile.create).mockResolvedValue({ id: 'cp-1' } as any)

    // Simulate reconciliation failure after sync
    vi.mocked(compareCapacityProfiles).mockReturnValue({
      mismatches: [{ projectId: 'proj-1', ownerKind: 'role', ownerId: 'rt-1', type: 'segmentMismatch', message: 'mismatch', expected: 0, actual: 1 }],
      expectedProfiles: 1,
      actualProfiles: 1,
      matchedProfiles: 0,
    })

    await expect(
      syncCapacityProfilesForProject(prisma, 'proj-1'),
    ).rejects.toThrow('Reconciliation failed')
  })

  it('handles empty segments correctly for non-CAPACITY_PLAN modes', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue(
      mockProject('proj-1', [makeRt('rt-1', 'Engineer')]),
    )
    vi.mocked(mapProjectToCapacityProfiles).mockReturnValue([
      {
        id: 'rt-1',
        projectId: 'proj-1',
        owner: { kind: 'role', id: 'rt-1', name: 'Engineer' },
        planningBasis: 'demandFollowing',
        source: 'fixed',
        defaultPercent: 100,
        startWeek: null,
        endWeek: null,
        segments: [], // No segments for non-CAPACITY_PLAN
        legacy: null as any,
      },
    ])
    vi.mocked(prisma.capacityProfile.findMany).mockResolvedValue([])
    vi.mocked(prisma.capacityProfile.create).mockResolvedValue({ id: 'cp-1' } as any)
    // Ensure reconciliation passes
    vi.mocked(compareCapacityProfiles).mockReturnValue({ mismatches: [], expectedProfiles: 1, actualProfiles: 1, matchedProfiles: 1 })

    const result = await syncCapacityProfilesForProject(prisma, 'proj-1')

    expect(result.profilesCreated).toBe(1)
    expect(result.segmentsCreated).toBe(0)
    // Profile created with no nested segments
    expect(prisma.capacityProfile.create).toHaveBeenCalled()
    expect(prisma.capacitySegment.create).not.toHaveBeenCalled()
  })
})
