/**
 * resolveRTPatchState.test.ts — Integration tests for the pre-mutation state
 * loader that drives the PATCH count route for ResourceTypes.
 *
 * These tests confirm that role profiles take precedence over stale RT
 * compatibility fields, and that the NR classification respects the
 * authoritative role default (not the legacy fallback).
 *
 * @see resolveRTPatchState.ts
 * @see classifyNRsForRoleUpdate.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveRTPatchState } from '../lib/resolveRTPatchState.js'

// ─── Fixture helpers ──────────────────────────────────────────────────────────

function makeRT(overrides: Record<string, any> = {}) {
  return {
    id: 'rt-1',
    projectId: 'proj-1',
    allocationMode: 'TIMELINE',
    allocationPercent: 100,
    allocationStartWeek: null,
    allocationEndWeek: null,
    name: 'Engineer',
    ...overrides,
  }
}

function makeNR(id: string, overrides: Record<string, any> = {}) {
  return {
    id,
    resourceTypeId: 'rt-1',
    allocationMode: 'TIMELINE',
    allocationPercent: 100,
    allocationPct: 100,
    allocationStartWeek: null,
    allocationEndWeek: null,
    startWeek: null,
    endWeek: null,
    createdAt: new Date('2026-01-01'),
    ...overrides,
  }
}

function makeProfile(id: string, overrides: Record<string, any> = {}) {
  return {
    id,
    projectId: 'proj-1',
    resourceTypeId: 'rt-1',
    namedResourceId: null,
    ownerKind: 'ROLE' as const,
    planningBasis: 'DEMAND_FOLLOWING',
    source: 'FIXED',
    defaultPercent: 70,
    startWeek: null,
    endWeek: null,
    segments: [],
    ...overrides,
  }
}

function makeNRProfile(id: string, nrId: string, overrides: Record<string, any> = {}) {
  return {
    id,
    projectId: 'proj-1',
    resourceTypeId: null,
    namedResourceId: nrId,
    ownerKind: 'NAMED_PERSON' as const,
    planningBasis: 'DEMAND_FOLLOWING',
    source: 'FIXED',
    defaultPercent: 70,
    startWeek: null,
    endWeek: null,
    segments: [],
    ...overrides,
  }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('resolveRTPatchState', () => {
  let tx: any

  // Helper: override tx.capacityProfile.findMany for role-profile and/or NR-profile queries
  const setRoleProfiles = (profiles: any[]) => {
    tx._roleProfiles = profiles
    tx.capacityProfile.findMany = vi.fn().mockImplementation((args: any) => {
      const where = args?.where ?? {}
      if (where.resourceTypeId && where.namedResourceId === null && !where.namedResourceId?.in) {
        return Promise.resolve(tx._roleProfiles)
      }
      // NR profile query: namedResourceId is an explicit string or { in: [...] }
      if (where.namedResourceId?.in) {
        const ids = where.namedResourceId.in
        return Promise.resolve((tx._nrProfiles ?? []).filter((p: any) => ids.includes(p.namedResourceId)))
      }
      if (where.namedResourceId && typeof where.namedResourceId === 'string') {
        return Promise.resolve((tx._nrProfiles ?? []).filter((p: any) => p.namedResourceId === where.namedResourceId))
      }
      return Promise.resolve([])
    })
  }

  const setNRProfiles = (profiles: any[]) => {
    tx._nrProfiles = profiles
    tx.capacityProfile.findMany = vi.fn().mockImplementation((args: any) => {
      const where = args?.where ?? {}
      if (where.resourceTypeId && where.namedResourceId === null && !where.namedResourceId?.in) {
        return Promise.resolve(tx._roleProfiles ?? [])
      }
      if (where.namedResourceId?.in) {
        const ids = where.namedResourceId.in
        return Promise.resolve(profiles.filter((p: any) => ids.includes(p.namedResourceId)))
      }
      if (where.namedResourceId && typeof where.namedResourceId === 'string') {
        return Promise.resolve(profiles.filter((p: any) => p.namedResourceId === where.namedResourceId))
      }
      return Promise.resolve([])
    })
  }

  beforeEach(() => {
    tx = {
      namedResource: {
        findMany: vi.fn().mockResolvedValue([]),
      },
      capacityProfile: {
        findMany: vi.fn().mockResolvedValue([]),
      },
    }
    tx._roleProfiles = []
    tx._nrProfiles = []
  })

  describe('role profile takes precedence over RT compatibility fields', () => {
    it('role DEMAND_FOLLOWING/70 beats RT TIMELINE/100 in classification', async () => {
      setNRProfiles([
        makeNRProfile('cp-nr-1', 'nr-1', {
          planningBasis: 'AVAILABILITY_WINDOW',
          defaultPercent: 100,
          startWeek: null,
          endWeek: null,
          provenance: null,
        }),
        makeNRProfile('cp-nr-2', 'nr-2', {
          planningBasis: 'DEMAND_FOLLOWING',
          defaultPercent: 70,
          startWeek: null,
          endWeek: null,
          provenance: 'LEGACY_MAPPER',
        }),
      ])
      setRoleProfiles([
        makeProfile('cp-role', { planningBasis: 'DEMAND_FOLLOWING', defaultPercent: 70 }),
      ])
      tx.namedResource.findMany = vi.fn().mockResolvedValue([
        makeNR('nr-1', { allocationMode: 'TIMELINE', allocationPercent: 100 }),
        makeNR('nr-2', { allocationMode: 'EFFORT', allocationPercent: 70 }),
      ])
      const state = await resolveRTPatchState(tx, 'rt-1', makeRT(), 'proj-1')
      expect(state.roleDefault.source).toBe('PROFILE')
      expect(state.roleDefault.allocationMode).toBe('EFFORT')
      expect(state.roleDefault.allocationPercent).toBe(70)
      expect(state.classification.inheritedNRIds).not.toContain('nr-1')
      expect(state.classification.explicitNRIds).toContain('nr-1')
      expect(state.classification.inheritedNRIds).toContain('nr-2')
      expect(state.classification.explicitNRIds).not.toContain('nr-2')
    })
  })

  describe('NR matching stale RT fields but not role default is protected', () => {
    it('NR TIMELINE/100 is protected when role default is EFFORT/70', async () => {
      setRoleProfiles([
        makeProfile('cp-role', { planningBasis: 'DEMAND_FOLLOWING', defaultPercent: 70 }),
      ])
      setNRProfiles([
        makeNRProfile('cp-nr-1', 'nr-1', {
          planningBasis: 'AVAILABILITY_WINDOW',
          defaultPercent: 100,
          startWeek: null,
          endWeek: null,
          provenance: null,
        }),
      ])
      tx.namedResource.findMany = vi.fn().mockResolvedValue([
        makeNR('nr-1', { allocationMode: 'TIMELINE', allocationPercent: 100 }),
      ])
      const state = await resolveRTPatchState(tx, 'rt-1', makeRT(), 'proj-1')
      expect(state.classification.explicitNRIds).toContain('nr-1')
      expect(state.classification.inheritedNRIds).not.toContain('nr-1')
    })
  })

  describe('segmented NR is protected', () => {
    it('NR with segmented CAPACITY_PROFILE profile is explicit', async () => {
      setRoleProfiles([
        makeProfile('cp-role', { planningBasis: 'DEMAND_FOLLOWING', defaultPercent: 70 }),
      ])
      setNRProfiles([
        makeNRProfile('cp-nr-1', 'nr-1', {
          planningBasis: 'CAPACITY_PROFILE',
          defaultPercent: 90,
          startWeek: null,
          endWeek: null,
          segments: [{ id: 'seg-1', capacityProfileId: 'cp-nr-1', startWeek: 3, endWeek: 8, capacityPercent: 90, source: 'MANUAL' }],
        }),
      ])
      tx.namedResource.findMany = vi.fn().mockResolvedValue([
        makeNR('nr-1', { allocationMode: 'EFFORT', allocationPercent: 70 }),
      ])
      const state = await resolveRTPatchState(tx, 'rt-1', makeRT(), 'proj-1')
      expect(state.classification.explicitNRIds).toContain('nr-1')
    })
  })

  describe('profile-first NR with null legacy fields is protected', () => {
    it('NR with null legacy fields is protected', async () => {
      setRoleProfiles([
        makeProfile('cp-role', { planningBasis: 'DEMAND_FOLLOWING', defaultPercent: 70 }),
      ])
      setNRProfiles([
        makeNRProfile('cp-nr-2', 'nr-2', {
          planningBasis: 'AVAILABILITY_WINDOW',
          defaultPercent: 80,
          segments: [],
        }),
      ])
      tx.namedResource.findMany = vi.fn().mockResolvedValue([
        makeNR('nr-2', {
          allocationMode: null,
          allocationPercent: null,
          allocationPct: null,
          allocationStartWeek: null,
          allocationEndWeek: null,
          startWeek: null,
          endWeek: null,
        }),
      ])
      const state = await resolveRTPatchState(tx, 'rt-1', makeRT(), 'proj-1')
      expect(state.classification.explicitNRIds).toContain('nr-2')
    })
  })

  describe('PLANNED_RESOURCE NR is protected', () => {
    it('NR with PLANNED_RESOURCE profile is explicit', async () => {
      setRoleProfiles([
        makeProfile('cp-role', { planningBasis: 'DEMAND_FOLLOWING', defaultPercent: 70 }),
      ])
      setNRProfiles([
        makeNRProfile('cp-nr-3', 'nr-3', {
          ownerKind: 'PLANNED_RESOURCE',
          planningBasis: 'AVAILABILITY_WINDOW',
          source: 'MANUAL',
          defaultPercent: null,
          startWeek: null,
          endWeek: null,
          segments: [],
        }),
      ])
      tx.namedResource.findMany = vi.fn().mockResolvedValue([
        makeNR('nr-3', { allocationMode: 'TIMELINE', allocationPercent: 25 }),
      ])
      const state = await resolveRTPatchState(tx, 'rt-1', makeRT(), 'proj-1')
      expect(state.classification.explicitNRIds).toContain('nr-3')
    })
  })

  describe('NR with matching profile is inherited', () => {
    it('NR EFFORT/70 with matching profile is inherited', async () => {
      setRoleProfiles([
        makeProfile('cp-role', { planningBasis: 'DEMAND_FOLLOWING', defaultPercent: 70 }),
      ])
      setNRProfiles([
        makeNRProfile('cp-nr-1', 'nr-1', {
          planningBasis: 'DEMAND_FOLLOWING',
          defaultPercent: 70,
          startWeek: null,
          endWeek: null,
          provenance: 'LEGACY_MAPPER',
        }),
      ])
      tx.namedResource.findMany = vi.fn().mockResolvedValue([
        makeNR('nr-1', { allocationMode: 'EFFORT', allocationPercent: 70 }),
      ])
      const state = await resolveRTPatchState(tx, 'rt-1', makeRT(), 'proj-1')
      expect(state.classification.inheritedNRIds).toContain('nr-1')
      expect(state.classification.explicitNRIds).not.toContain('nr-1')
    })
  })

  describe('NR with differing profile is protected', () => {
    it('NR TIMELINE/100 with differing profile is protected', async () => {
      setRoleProfiles([
        makeProfile('cp-role', { planningBasis: 'DEMAND_FOLLOWING', defaultPercent: 70 }),
      ])
      setNRProfiles([
        makeNRProfile('cp-nr-1', 'nr-1', {
          planningBasis: 'AVAILABILITY_WINDOW',
          defaultPercent: 100,
          startWeek: null,
          endWeek: null,
          provenance: null,
        }),
      ])
      tx.namedResource.findMany = vi.fn().mockResolvedValue([
        makeNR('nr-1', { allocationMode: 'TIMELINE', allocationPercent: 100 }),
      ])
      const state = await resolveRTPatchState(tx, 'rt-1', makeRT(), 'proj-1')
      expect(state.classification.explicitNRIds).toContain('nr-1')
      expect(state.classification.inheritedNRIds).not.toContain('nr-1')
    })
  })
})
