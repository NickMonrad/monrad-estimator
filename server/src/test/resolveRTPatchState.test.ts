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
      // If querying by namedResourceId.in → NR profiles
      if (args?.where?.namedResourceId?.in) {
        return Promise.resolve(tx._nrProfiles ?? [])
      }
      // Otherwise → role profiles (resourceTypeId match, namedResourceId null)
      return Promise.resolve(tx._roleProfiles)
    })
  }

  const setNRProfiles = (profiles: any[]) => {
    tx._nrProfiles = profiles
    tx.capacityProfile.findMany = vi.fn().mockImplementation((args: any) => {
      if (args?.where?.namedResourceId?.in) {
        return Promise.resolve(tx._nrProfiles)
      }
      return Promise.resolve(tx._roleProfiles ?? [])
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
      setNRProfiles([])
      setRoleProfiles([
        makeProfile('cp-role', { planningBasis: 'DEMAND_FOLLOWING', defaultPercent: 70 }),
      ])
      tx.namedResource.findMany = vi.fn().mockResolvedValue([
        makeNR('nr-1', { allocationMode: 'TIMELINE', allocationPercent: 100 }),
        makeNR('nr-2', { allocationMode: 'EFFORT', allocationPercent: 70 }),
      ])

      const state = await resolveRTPatchState(tx, 'rt-1', makeRT(), 'proj-1')

      // Role default is PROFILE → EFFORT/70/null/null
      expect(state.roleDefault.source).toBe('PROFILE')
      expect(state.roleDefault.allocationMode).toBe('EFFORT')
      expect(state.roleDefault.allocationPercent).toBe(70)

      // nr-1: TIMELINE/100 does NOT match EFFORT/70 → explicit/protected
      expect(state.classification.inheritedNRIds).not.toContain('nr-1')
      expect(state.classification.explicitNRIds).toContain('nr-1')

      // nr-2: EFFORT/70 matches role default → inherited
      expect(state.classification.inheritedNRIds).toContain('nr-2')
      expect(state.classification.explicitNRIds).not.toContain('nr-2')
    })
  })

  describe('NR matching stale RT fields but not role default is protected', () => {
    it('NR TIMELINE/100 is protected when role default is EFFORT/70', async () => {
      setRoleProfiles([
        makeProfile('cp-role', { planningBasis: 'DEMAND_FOLLOWING', defaultPercent: 70 }),
      ])
      tx.namedResource.findMany = vi.fn().mockResolvedValue([
        makeNR('nr-1', { allocationMode: 'TIMELINE', allocationPercent: 100 }),
      ])

      const state = await resolveRTPatchState(tx, 'rt-1', makeRT(), 'proj-1')

      // nr-1 matches RT legacy (TIMELINE/100) but NOT role default (EFFORT/70)
      expect(state.classification.explicitNRIds).toContain('nr-1')
      expect(state.classification.inheritedNRIds).not.toContain('nr-1')
    })
  })

  describe('segmented NR is protected', () => {
    it('NR with segmented profile is explicit even when legacy fields match role default', async () => {
      setRoleProfiles([
        makeProfile('cp-role', { planningBasis: 'DEMAND_FOLLOWING', defaultPercent: 70 }),
      ])
      setNRProfiles([
        makeNRProfile('cp-nr-1', 'nr-1', {
          planningBasis: 'AVAILABILITY_WINDOW',
          defaultPercent: 90,
          startWeek: 3,
          endWeek: 8,
          segments: [{ id: 'seg-1', capacityProfileId: 'cp-nr-1', startWeek: 3, endWeek: 8, capacityPercent: 90, source: 'AVAILABILITY_WINDOW' }],
        }),
      ])
      tx.namedResource.findMany = vi.fn().mockResolvedValue([
        makeNR('nr-1', { allocationMode: 'EFFORT', allocationPercent: 70 }),
      ])

      const state = await resolveRTPatchState(tx, 'rt-1', makeRT(), 'proj-1')

      // Has explicit NR profile (segments non-empty) → protected
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

      // Has profile-first profile → protected
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
          planningBasis: 'CAPACITY_PLAN',
          source: 'SQUAD_PLANNER',
          defaultPercent: null,
        }),
      ])
      tx.namedResource.findMany = vi.fn().mockResolvedValue([
        makeNR('nr-3', { allocationMode: 'CAPACITY_PLAN', allocationPercent: 25 }),
      ])

      const state = await resolveRTPatchState(tx, 'rt-1', makeRT(), 'proj-1')

      // PLANNED_RESOURCE → protected
      expect(state.classification.explicitNRIds).toContain('nr-3')
    })
  })

  describe('no-profile NR matching authoritative default is inherited', () => {
    it('NR EFFORT/70 with no profile matches role default → inherited', async () => {
      setRoleProfiles([
        makeProfile('cp-role', { planningBasis: 'DEMAND_FOLLOWING', defaultPercent: 70 }),
      ])
      tx.namedResource.findMany = vi.fn().mockResolvedValue([
        makeNR('nr-1', { allocationMode: 'EFFORT', allocationPercent: 70 }),
      ])

      const state = await resolveRTPatchState(tx, 'rt-1', makeRT(), 'proj-1')

      expect(state.classification.inheritedNRIds).toContain('nr-1')
      expect(state.classification.explicitNRIds).not.toContain('nr-1')
    })
  })

  describe('no-profile NR differing from authoritative default is protected', () => {
    it('NR TIMELINE/100 with no profile differs from EFFORT/70 → protected', async () => {
      setRoleProfiles([
        makeProfile('cp-role', { planningBasis: 'DEMAND_FOLLOWING', defaultPercent: 70 }),
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
