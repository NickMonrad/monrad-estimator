/**
 * reconcileCapacityProfiles.test.ts — Tests for the reconciliation/parity helper.
 *
 * Validates that the reconciliation report correctly detects mismatches between
 * mapper-derived profiles and persisted CapacityProfile/CapacitySegment rows.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { prisma } from '../lib/prisma.js'

import {
  reconcileCapacityProfiles,
  formatReconciliationReport,
} from '../lib/reconcileCapacityProfiles.js'

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
  synthetic: boolean | null
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

interface PersistedProfileMock {
  id: string
  projectId: string
  resourceTypeId: string | null
  namedResourceId: string | null
  ownerKind: string
  planningBasis: string
  source: string
  defaultPercent: number | null
  startWeek: number | null
  endWeek: number | null
  segments: PersistedSegmentMock[]
}

interface PersistedSegmentMock {
  id: string
  startWeek: number
  endWeek: number
  capacityPercent: number
  source: string
}

function makeProject(
  id: string,
  resourceTypes: RtMock[],
  capacityPlans: PlanMock[] = [],
  capacityProfiles: PersistedProfileMock[] = [],
) {
  return { id, resourceTypes, capacityPlans, capacityProfiles }
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
    synthetic: null,
    ...overrides,
  }
}

function makePersistedProfile(
  id: string,
  projectId: string,
  ownerKind: string,
  ownerId: string,
  overrides: Partial<PersistedProfileMock> = {},
): PersistedProfileMock {
  return {
    id,
    projectId,
    resourceTypeId: ownerKind === 'ROLE' ? ownerId : null,
    namedResourceId: ownerKind === 'ROLE' ? null : ownerId,
    ownerKind,
    planningBasis: 'DEMAND_FOLLOWING',
    source: 'FIXED',
    defaultPercent: null,
    startWeek: null,
    endWeek: null,
    segments: [],
    ...overrides,
  }
}

function makePersistedSegment(
  id: string,
  startWeek: number,
  endWeek: number,
  capacityPercent: number,
  source: string,
): PersistedSegmentMock {
  return { id, startWeek, endWeek, capacityPercent, source }
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('reconcileCapacityProfiles', () => {
  it('passes when persisted profiles match mapper-derived profiles', async () => {
    vi.mocked(prisma.project.findMany).mockResolvedValue([
      makeProject(
        'proj-1',
        [makeRt('rt-1', 'Engineer', { allocationMode: 'EFFORT' })],
        [],
        [makePersistedProfile('cp-1', 'proj-1', 'ROLE', 'rt-1', {
          planningBasis: 'DEMAND_FOLLOWING',
          source: 'FIXED',
          defaultPercent: 100,
        })],
      ),
    ] as any)

    const report = await reconcileCapacityProfiles(prisma as any)

    expect(report.projectsChecked).toBe(1)
    expect(report.expectedProfiles).toBe(1)
    expect(report.actualProfiles).toBe(1)
    expect(report.matchedProfiles).toBe(1)
    expect(report.mismatches).toHaveLength(0)
  })

  it('detects missing persisted profile', async () => {
    vi.mocked(prisma.project.findMany).mockResolvedValue([
      makeProject(
        'proj-1',
        [makeRt('rt-1', 'Engineer', { allocationMode: 'EFFORT' })],
        [],
        [], // no persisted profiles
      ),
    ] as any)

    const report = await reconcileCapacityProfiles(prisma as any)

    expect(report.mismatches).toHaveLength(1)
    expect(report.mismatches[0].type).toBe('missingPersistedProfile')
    expect(report.mismatches[0].message).toContain('rt-1')
  })

  it('detects extra persisted profile', async () => {
    vi.mocked(prisma.project.findMany).mockResolvedValue([
      makeProject(
        'proj-1',
        [], // no resource types → no expected profiles
        [],
        [makePersistedProfile('cp-1', 'proj-1', 'ROLE', 'rt-ghost', {
          planningBasis: 'DEMAND_FOLLOWING',
          source: 'FIXED',
        })],
      ),
    ] as any)

    const report = await reconcileCapacityProfiles(prisma as any)

    expect(report.mismatches).toHaveLength(1)
    expect(report.mismatches[0].type).toBe('extraPersistedProfile')
    expect(report.mismatches[0].message).toContain('rt-ghost')
  })

  it('detects planning basis mismatch', async () => {
    vi.mocked(prisma.project.findMany).mockResolvedValue([
      makeProject(
        'proj-1',
        [makeRt('rt-1', 'Engineer', { allocationMode: 'EFFORT' })],
        [],
        [makePersistedProfile('cp-1', 'proj-1', 'ROLE', 'rt-1', {
          planningBasis: 'AVAILABILITY_WINDOW', // wrong — should be DEMAND_FOLLOWING
          source: 'FIXED',
        })],
      ),
    ] as any)

    const report = await reconcileCapacityProfiles(prisma as any)

    const planningBasisMismatch = report.mismatches.find(
      (m) => m.type === 'profileFieldMismatch' && m.message.includes('planningBasis'),
    )
    expect(planningBasisMismatch).toBeDefined()
    expect(planningBasisMismatch!.expected).toBe('demandFollowing')
    expect(planningBasisMismatch!.actual).toBe('availabilityWindow')
  })

  it('detects default percent/start/end mismatch', async () => {
    vi.mocked(prisma.project.findMany).mockResolvedValue([
      makeProject(
        'proj-1',
        [makeRt('rt-1', 'Dev', {
          allocationMode: 'TIMELINE',
          allocationPercent: 75,
          allocationStartWeek: 2,
          allocationEndWeek: 10,
        })],
        [],
        [makePersistedProfile('cp-1', 'proj-1', 'ROLE', 'rt-1', {
          planningBasis: 'AVAILABILITY_WINDOW',
          source: 'AVAILABILITY_WINDOW',
          defaultPercent: 50, // wrong — should be 75
          startWeek: 3,      // wrong — should be 2
          endWeek: 10,       // correct
        })],
      ),
    ] as any)

    const report = await reconcileCapacityProfiles(prisma as any)

    const pctMismatch = report.mismatches.find(
      (m) => m.type === 'profileFieldMismatch' && m.message.includes('defaultPercent'),
    )
    expect(pctMismatch).toBeDefined()
    expect(pctMismatch!.expected).toBe(75)
    expect(pctMismatch!.actual).toBe(50)

    const startMismatch = report.mismatches.find(
      (m) => m.type === 'profileFieldMismatch' && m.message.includes('startWeek'),
    )
    expect(startMismatch).toBeDefined()
    expect(startMismatch!.expected).toBe(2)
    expect(startMismatch!.actual).toBe(3)
  })

  it('detects missing segment', async () => {
    vi.mocked(prisma.project.findMany).mockResolvedValue([
      makeProject(
        'proj-1',
        [makeRt('rt-1', 'Engineer', { allocationMode: 'CAPACITY_PLAN' })],
        [
          {
            id: 'plan-1',
            isActive: true,
            periods: [
              { periodIndex: 0, startWeek: 0, endWeek: 8, entries: [{ resourceTypeId: 'rt-1', headcount: 1 }] },
            ],
          },
        ],
        [
          makePersistedProfile('cp-1', 'proj-1', 'ROLE', 'rt-1', {
            planningBasis: 'CAPACITY_PROFILE',
            source: 'SQUAD_PLANNER',
            segments: [], // missing segments — should have 1
          }),
        ],
      ),
    ] as any)

    const report = await reconcileCapacityProfiles(prisma as any)

    const segMismatch = report.mismatches.find(
      (m) => m.type === 'segmentMismatch' && m.message.includes('Segment count'),
    )
    expect(segMismatch).toBeDefined()
    expect(segMismatch!.expected).toBe(1)
    expect(segMismatch!.actual).toBe(0)
  })

  it('detects extra segment', async () => {
    vi.mocked(prisma.project.findMany).mockResolvedValue([
      makeProject(
        'proj-1',
        [makeRt('rt-1', 'Engineer', { allocationMode: 'EFFORT' })],
        [],
        [
          makePersistedProfile('cp-1', 'proj-1', 'ROLE', 'rt-1', {
            planningBasis: 'DEMAND_FOLLOWING',
            source: 'FIXED',
            segments: [
              makePersistedSegment('seg-1', 0, 7, 100, 'FIXED'),
            ],
          }),
        ],
      ),
    ] as any)

    const report = await reconcileCapacityProfiles(prisma as any)

    const segMismatch = report.mismatches.find(
      (m) => m.type === 'segmentMismatch' && m.message.includes('Segment count'),
    )
    expect(segMismatch).toBeDefined()
    expect(segMismatch!.expected).toBe(0)
    expect(segMismatch!.actual).toBe(1)
  })

  it('detects segment percent/source mismatch', async () => {
    vi.mocked(prisma.project.findMany).mockResolvedValue([
      makeProject(
        'proj-1',
        [makeRt('rt-1', 'Engineer', { allocationMode: 'CAPACITY_PLAN' })],
        [
          {
            id: 'plan-1',
            isActive: true,
            periods: [
              { periodIndex: 0, startWeek: 0, endWeek: 8, entries: [{ resourceTypeId: 'rt-1', headcount: 1 }] },
            ],
          },
        ],
        [
          makePersistedProfile('cp-1', 'proj-1', 'ROLE', 'rt-1', {
            planningBasis: 'CAPACITY_PROFILE',
            source: 'SQUAD_PLANNER',
            segments: [
              makePersistedSegment('seg-1', 0, 7, 75, 'FIXED'), // wrong percent and source
            ],
          }),
        ],
      ),
    ] as any)

    const report = await reconcileCapacityProfiles(prisma as any)

    const pctMismatch = report.mismatches.find(
      (m) => m.type === 'profileFieldMismatch' && m.message.includes('capacityPercent'),
    )
    expect(pctMismatch).toBeDefined()
    expect(pctMismatch!.expected).toBe(100)
    expect(pctMismatch!.actual).toBe(75)

    const srcMismatch = report.mismatches.find(
      (m) => m.type === 'profileFieldMismatch' && m.message.includes('segment[0].source'),
    )
    expect(srcMismatch).toBeDefined()
    expect(srcMismatch!.expected).toBe('squadPlanner')
    expect(srcMismatch!.actual).toBe('fixed')
  })

  it('handles projects with no resource types safely', async () => {
    vi.mocked(prisma.project.findMany).mockResolvedValue([
      makeProject('proj-1', [], [], []),
    ] as any)

    const report = await reconcileCapacityProfiles(prisma as any)

    expect(report.projectsChecked).toBe(1)
    expect(report.expectedProfiles).toBe(0)
    expect(report.actualProfiles).toBe(0)
    expect(report.mismatches).toHaveLength(0)
  })

  it('handles missing active capacity plan safely', async () => {
    vi.mocked(prisma.project.findMany).mockResolvedValue([
      makeProject(
        'proj-1',
        [makeRt('rt-1', 'Engineer', { allocationMode: 'EFFORT' })],
        [], // no capacity plan
        [makePersistedProfile('cp-1', 'proj-1', 'ROLE', 'rt-1', {
          planningBasis: 'DEMAND_FOLLOWING',
          source: 'FIXED',
          defaultPercent: 100,
        })],
      ),
    ] as any)

    const report = await reconcileCapacityProfiles(prisma as any)

    expect(report.projectsChecked).toBe(1)
    expect(report.mismatches).toHaveLength(0)
  })

  it('confirms non-CAPACITY_PLAN resources do not require persisted segments even with active plan', async () => {
    vi.mocked(prisma.project.findMany).mockResolvedValue([
      makeProject(
        'proj-1',
        [makeRt('rt-1', 'Engineer', { allocationMode: 'EFFORT' })],
        [
          {
            id: 'plan-1',
            isActive: true,
            periods: [
              { periodIndex: 0, startWeek: 0, endWeek: 8, entries: [{ resourceTypeId: 'rt-1', headcount: 1 }] },
            ],
          },
        ],
        [makePersistedProfile('cp-1', 'proj-1', 'ROLE', 'rt-1', {
          planningBasis: 'DEMAND_FOLLOWING',
          source: 'FIXED',
          defaultPercent: 100,
          segments: [], // no segments — correct for non-CAPACITY_PLAN
        })],
      ),
    ] as any)

    const report = await reconcileCapacityProfiles(prisma as any)

    expect(report.mismatches).toHaveLength(0)
  })

  it('confirms CAPACITY_PLAN resources require persisted segments when mapper derives them', async () => {
    vi.mocked(prisma.project.findMany).mockResolvedValue([
      makeProject(
        'proj-1',
        [makeRt('rt-1', 'Engineer', { allocationMode: 'CAPACITY_PLAN' })],
        [
          {
            id: 'plan-1',
            isActive: true,
            periods: [
              { periodIndex: 0, startWeek: 0, endWeek: 8, entries: [{ resourceTypeId: 'rt-1', headcount: 1 }] },
            ],
          },
        ],
        [makePersistedProfile('cp-1', 'proj-1', 'ROLE', 'rt-1', {
          planningBasis: 'CAPACITY_PROFILE',
          source: 'SQUAD_PLANNER',
          defaultPercent: 100,
          segments: [
            makePersistedSegment('seg-1', 0, 7, 100, 'SQUAD_PLANNER'),
          ],
        })],
      ),
    ] as any)

    const report = await reconcileCapacityProfiles(prisma as any)

    expect(report.mismatches).toHaveLength(0)
    expect(report.matchedProfiles).toBe(1)
  })

  it('handles named resource profiles', async () => {
    vi.mocked(prisma.project.findMany).mockResolvedValue([
      makeProject(
        'proj-1',
        [makeRt('rt-1', 'Engineer', {
          allocationMode: 'TIMELINE',
          allocationPercent: 100,
          namedResources: [
            makeNr('nr-1', 'Alice', {
              allocationMode: 'TIMELINE',
              allocationPercent: 50,
              allocationStartWeek: 1,
              allocationEndWeek: 8,
            }),
          ],
        })],
        [],
        [makePersistedProfile('cp-1', 'proj-1', 'NAMED_PERSON', 'nr-1', {
          planningBasis: 'AVAILABILITY_WINDOW',
          source: 'AVAILABILITY_WINDOW',
          defaultPercent: 50,
          startWeek: 1,
          endWeek: 8,
        })],
      ),
    ] as any)

    const report = await reconcileCapacityProfiles(prisma as any)

    expect(report.mismatches).toHaveLength(0)
    expect(report.matchedProfiles).toBe(1)
  })
})

describe('formatReconciliationReport', () => {
  it('formats a passing report', () => {
    const report = {
      projectsChecked: 5,
      expectedProfiles: 12,
      actualProfiles: 12,
      matchedProfiles: 12,
      mismatches: [],
    }

    const formatted = formatReconciliationReport(report)

    expect(formatted).toContain('Projects checked:     5')
    expect(formatted).toContain('Expected profiles:    12')
    expect(formatted).toContain('Actual profiles:      12')
    expect(formatted).toContain('Matched profiles:     12')
    expect(formatted).toContain('Mismatches:           0')
    expect(formatted).not.toMatch(/\nMismatches:\n/)
  })

  it('formats a failing report with mismatches', () => {
    const report = {
      projectsChecked: 1,
      expectedProfiles: 2,
      actualProfiles: 1,
      matchedProfiles: 1,
      mismatches: [
        {
          projectId: 'proj-1',
          ownerKind: 'role',
          ownerId: 'rt-1',
          type: 'missingPersistedProfile' as const,
          message: 'No persisted profile found for role owner rt-1',
          expected: { ownerKind: 'role', ownerId: 'rt-1' },
        },
      ],
    }

    const formatted = formatReconciliationReport(report)

    expect(formatted).toContain('Mismatches:           1')
    expect(formatted).toContain('Mismatches:')
    expect(formatted).toContain('[missingPersistedProfile]')
    expect(formatted).toContain('expected:')
  })
})
