/**
 * namedResourceCapacityProfileWrites.test.ts — Unit tests for the
 * profile-first write helper.
 *
 * These tests verify that upsertNRProfileAndProjectLegacy correctly converts
 * legacy payloads to capacity profiles, projects back to legacy fields, and
 * handles multi-segment and edge cases.
 *
 * @see server/src/lib/namedResourceCapacityProfileWrites.ts
 */

import { describe, expect, it, vi } from 'vitest'
import { upsertNRProfileAndProjectLegacy } from '../lib/namedResourceCapacityProfileWrites.js'

// ─── Helpers ─────────────────────────────────────────────────────────────────

function mockTx() {
  const store: {
    capacityProfiles: any[]
    capacitySegments: any[]
  } = {
    capacityProfiles: [],
    capacitySegments: [],
  }

  const tx = {
    capacityProfile: {
      deleteMany: vi.fn(async (args: any) => {
        if (args?.where?.namedResourceId) {
          store.capacityProfiles = store.capacityProfiles.filter(
            (p: any) => p.namedResourceId !== args.where.namedResourceId,
          )
        } else if (args?.where?.projectId) {
          store.capacityProfiles = store.capacityProfiles.filter(
            (p: any) => p.projectId !== args.where.projectId,
          )
        } else {
          store.capacityProfiles = []
        }
        return { count: 0 }
      }),
      create: vi.fn(async (args: any) => {
        const data = args.data ?? args
        const record = { id: `cp-${store.capacityProfiles.length + 1}`, ...data }
        store.capacityProfiles.push(record)
        return { ...record }
      }),
    },
    capacitySegment: {
      deleteMany: vi.fn(async (args: any) => {
        if (args?.where?.capacityProfile?.namedResourceId) {
          store.capacitySegments = store.capacitySegments.filter(
            (s: any) => s.capacityProfileId !==
              store.capacityProfiles.find(
                (p: any) => p.namedResourceId === args.where.capacityProfile.namedResourceId,
              )?.id,
          )
        } else if (args?.where?.capacityProfileId) {
          store.capacitySegments = store.capacitySegments.filter(
            (s: any) => s.capacityProfileId !== args.where.capacityProfileId,
          )
        } else {
          store.capacitySegments = []
        }
        return { count: 0 }
      }),
      create: vi.fn(async (args: any) => {
        const data = args.data ?? args
        const record = { id: `seg-${store.capacitySegments.length + 1}`, ...data }
        store.capacitySegments.push(record)
        return { ...record }
      }),
    },
    _store: store,
  }

  return tx
}

const projectId = 'proj-1'
const nrId = 'nr-1'
const rtId = 'rt-1'

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('upsertNRProfileAndProjectLegacy', () => {
  it('converts EFFORT payload to DEMAND_FOLLOWING profile and projects back to EFFORT', async () => {
    const tx = mockTx() as any

    const result = await upsertNRProfileAndProjectLegacy(tx, projectId, nrId, rtId, {
      allocationMode: 'EFFORT',
      allocationPercent: 100,
    })

    // Projected legacy fields
    expect(result.allocationMode).toBe('EFFORT')
    expect(result.allocationPercent).toBe(100)
    expect(result.allocationStartWeek).toBeNull()
    expect(result.allocationEndWeek).toBeNull()
    expect(result.lossy).toBe(false)

    // Persisted profile
    expect(tx._store.capacityProfiles).toHaveLength(1)
    const cp = tx._store.capacityProfiles[0]
    expect(cp.namedResourceId).toBe(nrId)
    expect(cp.resourceTypeId).toBeNull()
    expect(cp.ownerKind).toBe('NAMED_PERSON')
    expect(cp.planningBasis).toBe('DEMAND_FOLLOWING')
    expect(cp.source).toBe('FIXED')
    expect(cp.defaultPercent).toBe(100)

    // No segments for EFFORT
    expect(cp.segments).toBeUndefined()
    expect(tx._store.capacitySegments).toHaveLength(0)
  })

  it('converts TIMELINE payload with availability window', async () => {
    const tx = mockTx() as any

    const result = await upsertNRProfileAndProjectLegacy(tx, projectId, nrId, rtId, {
      allocationMode: 'TIMELINE',
      allocationPercent: 75,
      allocationStartWeek: 2,
      allocationEndWeek: 10,
    })

    // Projected legacy fields
    expect(result.allocationMode).toBe('TIMELINE')
    expect(result.allocationPercent).toBe(75)
    expect(result.allocationStartWeek).toBe(2)
    expect(result.allocationEndWeek).toBe(10)
    expect(result.lossy).toBe(false)

    // Persisted profile
    const cp = tx._store.capacityProfiles[0]
    expect(cp.planningBasis).toBe('AVAILABILITY_WINDOW')
    expect(cp.source).toBe('AVAILABILITY_WINDOW')
    expect(cp.defaultPercent).toBe(75)
    expect(cp.startWeek).toBe(2)
    expect(cp.endWeek).toBe(10)
  })

  it('uses allocationPct as fallback for percent', async () => {
    const tx = mockTx() as any

    const result = await upsertNRProfileAndProjectLegacy(tx, projectId, nrId, rtId, {
      allocationMode: 'EFFORT',
      allocationPct: 50,
    })

    expect(result.allocationPercent).toBe(50)
    expect(tx._store.capacityProfiles[0].defaultPercent).toBe(50)
  })

  it('defaults to EFFORT/100 when no payload fields provided', async () => {
    const tx = mockTx() as any

    const result = await upsertNRProfileAndProjectLegacy(tx, projectId, nrId, rtId, {})

    expect(result.allocationMode).toBe('EFFORT')
    expect(result.allocationPercent).toBe(100)
    expect(result.allocationStartWeek).toBeNull()
    expect(result.allocationEndWeek).toBeNull()
  })

  it('replaces existing profile on subsequent writes (transactional cleanup)', async () => {
    const tx = mockTx() as any

    // First write: TIMELINE with window
    await upsertNRProfileAndProjectLegacy(tx, projectId, nrId, rtId, {
      allocationMode: 'TIMELINE',
      allocationPercent: 75,
      allocationStartWeek: 2,
      allocationEndWeek: 10,
    })

    expect(tx._store.capacityProfiles).toHaveLength(1)

    // Second write: EFFORT (no window, no segments)
    const result = await upsertNRProfileAndProjectLegacy(tx, projectId, nrId, rtId, {
      allocationMode: 'EFFORT',
      allocationPercent: 100,
    })

    expect(result.allocationMode).toBe('EFFORT')
    expect(result.allocationStartWeek).toBeNull()
    expect(result.allocationEndWeek).toBeNull()

    // Old profile was replaced (delete + create) — new profile matches new mode
    expect(tx._store.capacityProfiles).toHaveLength(1)
    expect(tx._store.capacityProfiles[0].planningBasis).toBe('DEMAND_FOLLOWING')

    // No stale segments
    expect(tx._store.capacitySegments).toHaveLength(0)
  })

  it('converts FULL_PROJECT payload', async () => {
    const tx = mockTx() as any

    const result = await upsertNRProfileAndProjectLegacy(tx, projectId, nrId, rtId, {
      allocationMode: 'FULL_PROJECT',
      allocationPercent: 100,
    })

    expect(result.allocationMode).toBe('FULL_PROJECT')
    expect(result.lossy).toBe(false)

    const cp = tx._store.capacityProfiles[0]
    expect(cp.planningBasis).toBe('WHOLE_PROJECT_ALLOCATION')
    expect(cp.source).toBe('FIXED')
  })

  it('converts CAPACITY_PLAN payload', async () => {
    const tx = mockTx() as any

    const result = await upsertNRProfileAndProjectLegacy(tx, projectId, nrId, rtId, {
      allocationMode: 'CAPACITY_PLAN',
      allocationPercent: 100,
    })

    expect(result.allocationMode).toBe('CAPACITY_PLAN')
    expect(result.lossy).toBe(false)

    const cp = tx._store.capacityProfiles[0]
    expect(cp.planningBasis).toBe('CAPACITY_PROFILE')
    expect(cp.source).toBe('SQUAD_PLANNER')
  })

  it('does not mutate the input payload object', async () => {
    const tx = mockTx() as any
    const payload = { allocationMode: 'TIMELINE', allocationPercent: 50 }

    await upsertNRProfileAndProjectLegacy(tx, projectId, nrId, rtId, payload)

    expect(payload).toEqual({ allocationMode: 'TIMELINE', allocationPercent: 50 })
  })

  it('uses synthetic true → PLANNED_RESOURCE owner kind', async () => {
    const tx = mockTx() as any

    await upsertNRProfileAndProjectLegacy(tx, projectId, nrId, rtId, {}, { synthetic: true })

    expect(tx._store.capacityProfiles).toHaveLength(1)
    expect(tx._store.capacityProfiles[0].ownerKind).toBe('PLANNED_RESOURCE')
  })

  it('uses synthetic false/null/undefined → NAMED_PERSON owner kind', async () => {
    const tx1 = mockTx() as any
    await upsertNRProfileAndProjectLegacy(tx1, projectId, nrId, rtId, {}, { synthetic: false })
    expect(tx1._store.capacityProfiles[0].ownerKind).toBe('NAMED_PERSON')

    const tx2 = mockTx() as any
    await upsertNRProfileAndProjectLegacy(tx2, projectId, `${nrId}-2`, rtId, {}, { synthetic: null })
    expect(tx2._store.capacityProfiles[0].ownerKind).toBe('NAMED_PERSON')

    const tx3 = mockTx() as any
    await upsertNRProfileAndProjectLegacy(tx3, projectId, `${nrId}-3`, rtId, {}, {})
    expect(tx3._store.capacityProfiles[0].ownerKind).toBe('NAMED_PERSON')

    const tx4 = mockTx() as any
    await upsertNRProfileAndProjectLegacy(tx4, projectId, `${nrId}-4`, rtId, {})
    expect(tx4._store.capacityProfiles[0].ownerKind).toBe('NAMED_PERSON')
  })
})
