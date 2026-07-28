/**
 * ownerProfileLoader.unit.test.ts — Unit tests for the strict profile
 * loader used by runtime routes.
 *
 * Tests exact owner-kind enforcement, CAPACITY_PROFILE segment
 * requirement, and segment validation rules.
 *
 * @see ownerProfileLoader.ts
 */
import { describe, it, expect, vi } from 'vitest'
import { loadAndValidateOwnerProfile } from '../lib/ownerProfileLoader.js'

function makeValidProfile(overrides: Record<string, any> = {}) {
  return {
    id: 'cp-1',
    projectId: 'proj-1',
    resourceTypeId: null,
    namedResourceId: 'nr-1',
    ownerKind: 'NAMED_PERSON',
    planningBasis: 'DEMAND_FOLLOWING',
    source: 'FIXED',
    defaultPercent: 100,
    startWeek: null,
    endWeek: null,
    segments: [],
    ...overrides,
  }
}

function makeTx(profiles: any[]) {
  return {
    capacityProfile: {
      findMany: vi.fn().mockImplementation((args: any) => {
        const where = args?.where ?? {}
        const nrId = where.namedResourceId
        // ROLE query
        if (where.resourceTypeId && where.namedResourceId === null) {
          return Promise.resolve(profiles.filter((p: any) => p.namedResourceId === null))
        }
        // NR query by string
        if (nrId && typeof nrId === 'string') {
          return Promise.resolve(profiles.filter((p: any) => p.namedResourceId === nrId))
        }
        // NR query by in
        if (nrId?.in) {
          return Promise.resolve(profiles.filter((p: any) => nrId.in.includes(p.namedResourceId)))
        }
        return Promise.resolve([])
      }),
    },
  }
}

describe('loadAndValidateOwnerProfile', () => {
  describe('exact owner-kind enforcement', () => {
    it('accepts NAMED_PERSON when expected', async () => {
      const tx = makeTx([makeValidProfile()])
      const result = await loadAndValidateOwnerProfile({
        tx, projectId: 'proj-1', ownerKind: 'NAMED_PERSON', ownerId: 'nr-1',
      })
      expect(result.ownerKind).toBe('NAMED_PERSON')
      expect(result.id).toBe('cp-1')
    })

    it('accepts PLANNED_RESOURCE when expected', async () => {
      const tx = makeTx([makeValidProfile({ ownerKind: 'PLANNED_RESOURCE' })])
      const result = await loadAndValidateOwnerProfile({
        tx, projectId: 'proj-1', ownerKind: 'PLANNED_RESOURCE', ownerId: 'nr-1',
      })
      expect(result.ownerKind).toBe('PLANNED_RESOURCE')
    })

    it('accepts ROLE when expected', async () => {
      const profile = makeValidProfile({
        resourceTypeId: 'rt-1', namedResourceId: null, ownerKind: 'ROLE',
      })
      const tx = makeTx([profile])
      await expect(loadAndValidateOwnerProfile({
        tx, projectId: 'proj-1', ownerKind: 'ROLE', ownerId: 'rt-1',
      })).resolves.toBeDefined()
    })

    it('rejects PLANNED_RESOURCE when expected NAMED_PERSON', async () => {
      const tx = makeTx([makeValidProfile({ ownerKind: 'PLANNED_RESOURCE' })])
      await expect(loadAndValidateOwnerProfile({
        tx, projectId: 'proj-1', ownerKind: 'NAMED_PERSON', ownerId: 'nr-1',
      })).rejects.toThrow(/Expected NAMED_PERSON.*found.*PLANNED_RESOURCE/)
    })

    it('rejects NAMED_PERSON when expected PLANNED_RESOURCE', async () => {
      const tx = makeTx([makeValidProfile({ ownerKind: 'NAMED_PERSON' })])
      await expect(loadAndValidateOwnerProfile({
        tx, projectId: 'proj-1', ownerKind: 'PLANNED_RESOURCE', ownerId: 'nr-1',
      })).rejects.toThrow(/Expected PLANNED_RESOURCE.*found.*NAMED_PERSON/)
    })
  })

  describe('CAPACITY_PROFILE segment requirements', () => {
    it('rejects segmentless CAPACITY_PROFILE', async () => {
      const tx = makeTx([makeValidProfile({
        planningBasis: 'CAPACITY_PROFILE',
        source: 'SQUAD_PLANNER',
        defaultPercent: null,
        segments: [],
      })])
      await expect(loadAndValidateOwnerProfile({
        tx, projectId: 'proj-1', ownerKind: 'NAMED_PERSON', ownerId: 'nr-1',
      })).rejects.toThrow(/no segments but segments are required/)
    })

    it('accepts CAPACITY_PROFILE with valid segments', async () => {
      const tx = makeTx([makeValidProfile({
        planningBasis: 'CAPACITY_PROFILE',
        source: 'SQUAD_PLANNER',
        defaultPercent: null,
        segments: [{ id: 'seg-1', capacityProfileId: 'cp-1', startWeek: 0, endWeek: 10, capacityPercent: 50, source: 'SQUAD_PLANNER' }],
      })])
      const result = await loadAndValidateOwnerProfile({
        tx, projectId: 'proj-1', ownerKind: 'NAMED_PERSON', ownerId: 'nr-1',
      })
      expect(result.segments.length).toBe(1)
    })

    it('accepts 0% capacity segment', async () => {
      const tx = makeTx([makeValidProfile({
        planningBasis: 'CAPACITY_PROFILE',
        source: 'SQUAD_PLANNER',
        defaultPercent: null,
        segments: [{ id: 'seg-0', capacityProfileId: 'cp-1', startWeek: 0, endWeek: 5, capacityPercent: 0, source: 'MANUAL' }],
      })])
      const result = await loadAndValidateOwnerProfile({
        tx, projectId: 'proj-1', ownerKind: 'NAMED_PERSON', ownerId: 'nr-1',
      })
      expect(result.segments[0].capacityPercent).toBe(0)
    })
  })

  describe('segment structural validation', () => {
    it('rejects overlapping segments', async () => {
      const tx = makeTx([makeValidProfile({
        planningBasis: 'CAPACITY_PROFILE',
        defaultPercent: null,
        segments: [
          { id: 'seg-1', capacityProfileId: 'cp-1', startWeek: 0, endWeek: 5, capacityPercent: 100, source: 'MANUAL' },
          { id: 'seg-2', capacityProfileId: 'cp-1', startWeek: 3, endWeek: 8, capacityPercent: 50, source: 'MANUAL' },
        ],
      })])
      await expect(loadAndValidateOwnerProfile({
        tx, projectId: 'proj-1', ownerKind: 'NAMED_PERSON', ownerId: 'nr-1',
      })).rejects.toThrow(/overlap/)
    })

    it('rejects duplicate segment ranges', async () => {
      const tx = makeTx([makeValidProfile({
        planningBasis: 'CAPACITY_PROFILE',
        defaultPercent: null,
        segments: [
          { id: 'seg-1', capacityProfileId: 'cp-1', startWeek: 0, endWeek: 5, capacityPercent: 100, source: 'MANUAL' },
          { id: 'seg-2', capacityProfileId: 'cp-1', startWeek: 0, endWeek: 5, capacityPercent: 50, source: 'MANUAL' },
        ],
      })])
      await expect(loadAndValidateOwnerProfile({
        tx, projectId: 'proj-1', ownerKind: 'NAMED_PERSON', ownerId: 'nr-1',
      })).rejects.toThrow(/duplicate range/)
    })
  })

  describe('window validation', () => {
    it('rejects startWeek after endWeek', async () => {
      const tx = makeTx([makeValidProfile({
        planningBasis: 'AVAILABILITY_WINDOW',
        startWeek: 10, endWeek: 5,
      })])
      await expect(loadAndValidateOwnerProfile({
        tx, projectId: 'proj-1', ownerKind: 'NAMED_PERSON', ownerId: 'nr-1',
      })).rejects.toThrow(/startWeek.*after endWeek/)
    })
  })
})
