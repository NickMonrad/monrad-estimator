/**
 * snapshots.test.ts — Server tests for snapshot creation and rollback.
 *
 * Tests v3 buildSnapshot, pure v3 helpers, and the rollback route's
 * v1/v2/v3 paths including pre-flight validation, cross-project checks,
 * and atomic transaction rollback.
 *
 * Covers:
 *  - Pure parser tests (parseSnapshotData, type guards)
 *  - Pure validation tests (validateSnapshotV3, sort helpers)
 *  - buildSnapshot v3 creation with mock db parameter (returns schemaVersion 3)
 *  - V1/V2/V3 route rollback
 *  - Pre-flight validation: invalid v3, unknown schema, cross-project IDs
 *  - Transaction atomicity (failure rejects with 500)
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { app } from '../index.js'
import { prisma } from '../lib/prisma.js'
import {
  parseSnapshotData,
  SnapshotSchemaError,
  isSnapshotV2,
  isSnapshotV3,
  type SnapshotV2,
  type SnapshotV3,
} from '../lib/projectSnapshotTypes.js'
import {
  validateSnapshotV3,
  SnapshotValidationError,
  sortSnapshotProfiles,
  sortSnapshotSegments,
} from '../lib/projectSnapshotValidation.js'
import { buildSnapshot } from '../routes/snapshots.js'
process.env.JWT_SECRET = 'test-secret'

const userId = 'user-1'
const token = jwt.sign({ userId }, 'test-secret')
const authHeader = `Bearer ${token}`
const projId = 'proj-1'

beforeEach(() => {
  vi.clearAllMocks()
})

// ═══════════════════════════════════════════════════════════════════════════
// 1. Pure parser tests (from projectSnapshotTypes.ts)
// ═══════════════════════════════════════════════════════════════════════════

describe('parseSnapshotData', () => {
  it('parses a bare array as V1', () => {
    const data = parseSnapshotData([{ id: 'e1', name: 'Epic 1', features: [] }])
    expect(Array.isArray(data)).toBe(true)
  })

  it('parses schemaVersion 2 explicitly', () => {
    const v2: SnapshotV2 = {
      schemaVersion: 2,
      epics: [],
      project: null,
      resourceTypes: [],
      namedResources: [],
      timelineEntries: [],
      storyTimelineEntries: [],
      epicDependencies: [],
      featureDependencies: [],
      overheadItems: [],
    }
    const result = parseSnapshotData(v2 as unknown as Record<string, unknown>)
    expect((result as SnapshotV2).schemaVersion).toBe(2)
    expect(isSnapshotV2(result)).toBe(true)
  })

  it('parses schemaVersion 3 explicitly', () => {
    const v3: SnapshotV3 = {
      schemaVersion: 3,
      epics: [],
      project: null,
      resourceTypes: [],
      namedResources: [],
      timelineEntries: [],
      storyTimelineEntries: [],
      epicDependencies: [],
      featureDependencies: [],
      overheadItems: [],
      capacityProfiles: [],
    }
    const result = parseSnapshotData(v3 as unknown as Record<string, unknown>)
    expect(isSnapshotV3(result)).toBe(true)
    if (isSnapshotV3(result)) {
      expect(result.schemaVersion).toBe(3)
      expect(Array.isArray(result.capacityProfiles)).toBe(true)
    }
  })

  it('throws SnapshotSchemaError for unknown schemaVersion 99', () => {
    expect(() =>
      parseSnapshotData({ schemaVersion: 99, epics: [], resourceTypes: [], namedResources: [], timelineEntries: [], storyTimelineEntries: [], epicDependencies: [], featureDependencies: [], overheadItems: [] }),
    ).toThrow(SnapshotSchemaError)
  })

  it('throws SnapshotSchemaError for null input', () => {
    expect(() => parseSnapshotData(null)).toThrow(SnapshotSchemaError)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 2. Pure validation tests (from projectSnapshotValidation.ts)
// ═══════════════════════════════════════════════════════════════════════════

describe('validateSnapshotV3', () => {
  /** Minimal valid V3 fixture for tests that mutate a copy. */
  function makeBaseV3(): SnapshotV3 {
    return {
      schemaVersion: 3,
      epics: [],
      project: null,
      resourceTypes: [
        {
          id: 'rt-dev', name: 'Developer', category: 'role', count: 2,
          hoursPerDay: 8, dayRate: 500, globalTypeId: null,
          allocationMode: 'TIMELINE', allocationPercent: 100,
          allocationStartWeek: 0, allocationEndWeek: 10,
        },
      ],
      namedResources: [
        {
          id: 'nr-alice', resourceTypeId: 'rt-dev', name: 'Alice',
          startWeek: null, endWeek: null, allocationPct: 100,
          allocationMode: 'EFFORT', allocationPercent: 100,
          allocationStartWeek: null, allocationEndWeek: null,
          pricingModel: 'ACTUAL_DAYS',
        },
      ],
      timelineEntries: [],
      storyTimelineEntries: [],
      epicDependencies: [],
      featureDependencies: [],
      overheadItems: [],
      capacityProfiles: [
        {
          id: 'cp-1',
          ownerKind: 'ROLE',
          resourceTypeId: 'rt-dev',
          namedResourceId: null,
          planningBasis: 'DEMAND_FOLLOWING',
          source: 'FIXED',
          defaultPercent: null,
          startWeek: null,
          endWeek: null,
          legacy: null,
          segments: [],
        },
        {
          id: 'cp-2',
          ownerKind: 'NAMED_PERSON',
          resourceTypeId: null,
          namedResourceId: 'nr-alice',
          planningBasis: 'AVAILABILITY_WINDOW',
          source: 'SQUAD_PLANNER',
          defaultPercent: 100,
          startWeek: 0,
          endWeek: 10,
          legacy: { allocationMode: 'EFFORT' },
          segments: [
            { id: 'seg-1', startWeek: 0, endWeek: 4, capacityPercent: 100, source: 'SQUAD_PLANNER' },
          ],
        },
      ],
    }
  }

  it('rejects missing ROLE resourceTypeId', () => {
    const snap = makeBaseV3()
    snap.capacityProfiles[0].resourceTypeId = null
    expect(() => validateSnapshotV3(snap)).toThrow(SnapshotValidationError)
  })

  it('rejects missing NAMED_PERSON namedResourceId', () => {
    const snap = makeBaseV3()
    snap.capacityProfiles[1].namedResourceId = null
    expect(() => validateSnapshotV3(snap)).toThrow(SnapshotValidationError)
  })

  it('rejects ROLE with non-null namedResourceId', () => {
    const snap = makeBaseV3()
    snap.capacityProfiles[0].namedResourceId = 'nr-alice'
    expect(() => validateSnapshotV3(snap)).toThrow(SnapshotValidationError)
  })

  it('rejects unsupported planningBasis enum', () => {
    const snap = makeBaseV3()
    ;(snap.capacityProfiles[1] as Record<string, unknown>).planningBasis = 'UNSUPPORTED_BASIS'
    expect(() => validateSnapshotV3(snap)).toThrow(SnapshotValidationError)
  })

  it('rejects invalid segment range (endWeek < startWeek)', () => {
    const snap = makeBaseV3()
    snap.capacityProfiles[1].segments[0].endWeek = -1
    expect(() => validateSnapshotV3(snap)).toThrow(SnapshotValidationError)
  })

  it('rejects duplicate profile ID', () => {
    const snap = makeBaseV3()
    snap.capacityProfiles.push({ ...snap.capacityProfiles[0], id: 'cp-1', segments: [] })
    expect(() => validateSnapshotV3(snap)).toThrow(/duplicate profile id/)
  })

  it('rejects duplicate segment ID', () => {
    const snap = makeBaseV3()
    const segs = snap.capacityProfiles[1].segments
    segs.push({
      id: segs[0].id,
      startWeek: 10,
      endWeek: 12,
      capacityPercent: 50,
      source: 'MANUAL',
    })
    expect(() => validateSnapshotV3(snap)).toThrow(/duplicate segment id/)
  })

  it('accepts duplicate owner identities', () => {
    const snap = makeBaseV3()
    snap.capacityProfiles.push({
      id: 'cp-3',
      ownerKind: 'ROLE',
      resourceTypeId: 'rt-dev',
      namedResourceId: null,
      planningBasis: 'AVAILABILITY_WINDOW',
      source: 'MANUAL',
      defaultPercent: 50,
      startWeek: 2,
      endWeek: 6,
      legacy: null,
      segments: [],
    })
    // Two ROLE profiles with same resourceTypeId — allowed
    expect(() => validateSnapshotV3(snap)).not.toThrow()
  })

  it('accepts discontinuous / overlapping segments', () => {
    const snap = makeBaseV3()
    snap.capacityProfiles[1].segments = [
      { id: 's1', startWeek: 0, endWeek: 4, capacityPercent: 100, source: 'SQUAD_PLANNER' },
      { id: 's2', startWeek: 8, endWeek: 12, capacityPercent: 80, source: 'SQUAD_PLANNER' },  // gap
      { id: 's3', startWeek: 3, endWeek: 6, capacityPercent: 50, source: 'SQUAD_PLANNER' },  // overlap
    ]
    expect(() => validateSnapshotV3(snap)).not.toThrow()
  })

  it('accepts >100% capacity in segments', () => {
    const snap = makeBaseV3()
    snap.capacityProfiles[1].segments[0].capacityPercent = 150
    expect(() => validateSnapshotV3(snap)).not.toThrow()
  })

  it('accepts null legacy field', () => {
    const snap = makeBaseV3()
    snap.capacityProfiles[0].legacy = null
    expect(() => validateSnapshotV3(snap)).not.toThrow()
  })

  it('accepts fractional profile/segment weeks', () => {
    const snap = makeBaseV3()
    const cp = snap.capacityProfiles[1]
    cp.startWeek = 1.5
    cp.endWeek = 8.75
    cp.segments = [
      { id: 'seg-frac', startWeek: 2.5, endWeek: 7.25, capacityPercent: 100, source: 'SQUAD_PLANNER' },
    ]
    expect(() => validateSnapshotV3(snap)).not.toThrow()
  })

  it('rejects empty resourceType id', () => {
    const snap = makeBaseV3()
    snap.resourceTypes[0].id = ''
    expect(() => validateSnapshotV3(snap)).toThrow(SnapshotValidationError)
  })

  it('rejects duplicate resourceType id', () => {
    const snap = makeBaseV3()
    snap.resourceTypes.push({ ...snap.resourceTypes[0], id: 'rt-dev', name: 'Duplicate' })
    expect(() => validateSnapshotV3(snap)).toThrow(/duplicate resourceType id/)
  })

  it('rejects empty namedResource id', () => {
    const snap = makeBaseV3()
    snap.namedResources[0].id = ''
    expect(() => validateSnapshotV3(snap)).toThrow(SnapshotValidationError)
  })

  it('rejects duplicate namedResource id', () => {
    const snap = makeBaseV3()
    snap.namedResources.push({ ...snap.namedResources[0], id: 'nr-alice', resourceTypeId: 'rt-dev', name: 'Duplicate' })
    expect(() => validateSnapshotV3(snap)).toThrow(/duplicate namedResource id/)
  })

  it('rejects namedResource referencing missing resourceTypeId', () => {
    const snap = makeBaseV3()
    snap.namedResources[0].resourceTypeId = 'rt-nonexistent'
    expect(() => validateSnapshotV3(snap)).toThrow(/not found in snapshot.resourceTypes/)
  })

  it('rejects overhead item referencing missing resourceTypeId', () => {
    const snap = makeBaseV3()
    snap.overheadItems.push({
      name: 'PM', type: 'percent', value: 10, resourceTypeId: 'rt-nonexistent', order: 1,
    })
    expect(() => validateSnapshotV3(snap)).toThrow(/not found in snapshot.resourceTypes/)
  })

  it('accepts overhead item with null resourceTypeId', () => {
    const snap = makeBaseV3()
    snap.overheadItems.push({
      name: 'Fixed', type: 'fixed', value: 1000, resourceTypeId: null, order: 1,
    })
    expect(() => validateSnapshotV3(snap)).not.toThrow()
  })


  it('rejects null entry in overheadItems (malformed row)', () => {
    const snap = makeBaseV3()
    snap.overheadItems.push(null as never)
    expect(() => validateSnapshotV3(snap)).toThrow(SnapshotValidationError)
  })

  it('rejects null entry in resourceTypes (malformed row)', () => {
    const snap = makeBaseV3()
    snap.resourceTypes.push(null as never)
    expect(() => validateSnapshotV3(snap)).toThrow(SnapshotValidationError)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 3. Pure sort helpers
// ═══════════════════════════════════════════════════════════════════════════

describe('sort helpers', () => {
  it('sortSnapshotProfiles: sorts by ownerKind, owner identity, profile ID', () => {
    const unsorted = [
      { id: 'z', ownerKind: 'PLANNED_RESOURCE', resourceTypeId: null, namedResourceId: 'a' },
      { id: 'b', ownerKind: 'ROLE', resourceTypeId: 'rt-1', namedResourceId: null },
      { id: 'a', ownerKind: 'ROLE', resourceTypeId: 'rt-1', namedResourceId: null },
      { id: 'c', ownerKind: 'NAMED_PERSON', resourceTypeId: null, namedResourceId: 'b' },
      { id: 'd', ownerKind: 'NAMED_PERSON', resourceTypeId: null, namedResourceId: 'a' },
    ] as Parameters<typeof sortSnapshotProfiles>[0]

    const sorted = sortSnapshotProfiles(unsorted)

    // order: NAMED_PERSON < PLANNED_RESOURCE < ROLE (alphabetical)
    const kinds = sorted.map(p => p.ownerKind)
    expect(kinds).toEqual(['NAMED_PERSON', 'NAMED_PERSON', 'PLANNED_RESOURCE', 'ROLE', 'ROLE'])
    // NAMED_PERSON sorted by namedResourceId: 'a' (d) < 'b' (c)
    expect(sorted[0].id).toBe('d')
    expect(sorted[1].id).toBe('c')
    // PLANNED_RESOURCE
    expect(sorted[2].id).toBe('z')
    // ROLE sorted by resourceTypeId then id: 'a' < 'b'
    expect(sorted[3].id).toBe('a')
    expect(sorted[4].id).toBe('b')
  })

  it('sortSnapshotSegments: sorts by startWeek, endWeek, segment ID', () => {
    const unsorted = [
      { id: 'b', startWeek: 0, endWeek: 4, capacityPercent: 100, source: 'FIXED' as const },
      { id: 'c', startWeek: 0, endWeek: 2, capacityPercent: 50, source: 'FIXED' as const },
      { id: 'a', startWeek: 0, endWeek: 2, capacityPercent: 80, source: 'FIXED' as const },
    ]
    const sorted = sortSnapshotSegments(unsorted)
    expect(sorted.map(s => s.id)).toEqual(['a', 'c', 'b'])
    // All same startWeek (0). a: endWeek=2 < c: endWeek=2 (a<c by id), b: endWeek=4
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 4. buildSnapshot v3 creation (uses db parameter, returns schemaVersion 3)
// ═══════════════════════════════════════════════════════════════════════════

describe('buildSnapshot', () => {
  it('captures capacity profiles with ordering and field preservation', async () => {
    // Unsorted profiles/segments to verify stable ordering
    const rawProfiles = [
      {
        id: 'cp-3', ownerKind: 'PLANNED_RESOURCE',
        resourceTypeId: null, namedResourceId: 'nr-bob',
        planningBasis: 'WHOLE_PROJECT_ALLOCATION', source: 'MANUAL',
        defaultPercent: null, startWeek: null, endWeek: null,
        legacy: { oldField: 'value' },
        segments: [
          { id: 'seg-3b', startWeek: 0, endWeek: 2, capacityPercent: 100, source: 'MANUAL' },
          { id: 'seg-3a', startWeek: 0, endWeek: 2, capacityPercent: 50, source: 'MANUAL' },
        ],
      },
      {
        id: 'cp-1', ownerKind: 'ROLE',
        resourceTypeId: 'rt-dev', namedResourceId: null,
        planningBasis: 'DEMAND_FOLLOWING', source: 'FIXED',
        defaultPercent: null, startWeek: null, endWeek: null, legacy: null,
        segments: [],
      },
      {
        id: 'cp-2', ownerKind: 'NAMED_PERSON',
        resourceTypeId: null, namedResourceId: 'nr-alice',
        planningBasis: 'AVAILABILITY_WINDOW', source: 'SQUAD_PLANNER',
        defaultPercent: 100, startWeek: 0, endWeek: 10,
        legacy: { allocationMode: 'EFFORT' },
        segments: [
          { id: 'seg-2c', startWeek: 8, endWeek: 12, capacityPercent: 80, source: 'SQUAD_PLANNER' },
          { id: 'seg-2a', startWeek: 0, endWeek: 4, capacityPercent: 100, source: 'SQUAD_PLANNER' },
          { id: 'seg-2b', startWeek: 4, endWeek: 8, capacityPercent: 100, source: 'SQUAD_PLANNER' },
        ],
      },
    ]

    const db = {
      epic: { findMany: vi.fn().mockResolvedValue([]) },
      project: {
        findUnique: vi.fn().mockResolvedValue({
          startDate: new Date('2025-01-15'),
          onboardingWeeks: 1, bufferWeeks: 2, hoursPerDay: 8,
        }),
      },
      resourceType: {
        findMany: vi.fn().mockResolvedValue([
          { id: 'rt-dev', name: 'Developer', category: 'role', count: 2,
            hoursPerDay: 8, dayRate: 500, globalTypeId: null,
            allocationMode: 'TIMELINE', allocationPercent: 100,
            allocationStartWeek: 0, allocationEndWeek: 10 },
          { id: 'rt-des', name: 'Designer', category: 'role', count: 1,
            hoursPerDay: 8, dayRate: 450, globalTypeId: null,
            allocationMode: 'EFFORT', allocationPercent: 100,
            allocationStartWeek: null, allocationEndWeek: null },
        ]),
      },
      namedResource: {
        findMany: vi.fn().mockResolvedValue([
          { id: 'nr-alice', resourceTypeId: 'rt-dev', name: 'Alice',
            startWeek: null, endWeek: null, allocationPct: 100,
            allocationMode: 'EFFORT', allocationPercent: 100,
            allocationStartWeek: null, allocationEndWeek: null,
            pricingModel: 'ACTUAL_DAYS' },
          { id: 'nr-bob', resourceTypeId: 'rt-dev', name: 'Bob',
            startWeek: 2, endWeek: 8, allocationPct: 50,
            allocationMode: 'TIMELINE', allocationPercent: 50,
            allocationStartWeek: 2, allocationEndWeek: 8,
            pricingModel: 'ACTUAL_DAYS' },
        ]),
      },
      timelineEntry: { findMany: vi.fn().mockResolvedValue([]) },
      storyTimelineEntry: { findMany: vi.fn().mockResolvedValue([]) },
      epicDependency: { findMany: vi.fn().mockResolvedValue([]) },
      featureDependency: { findMany: vi.fn().mockResolvedValue([]) },
      projectOverhead: { findMany: vi.fn().mockResolvedValue([]) },
      capacityProfile: { findMany: vi.fn().mockResolvedValue(rawProfiles) },
    }

    const result = await buildSnapshot(projId, db as never)
    // schemaVersion 3
    expect(result.schemaVersion).toBe(3)

    // Project startDate converted to ISO string
    expect(result.project).not.toBeNull()
    expect(result.project?.startDate).toBe('2025-01-15T00:00:00.000Z')
    // Profiles sorted: NAMED_PERSON < PLANNED_RESOURCE < ROLE (alphabetical by ownerKind)
    const profileKinds = result.capacityProfiles.map(p => p.ownerKind)
    expect(profileKinds).toEqual(['NAMED_PERSON', 'PLANNED_RESOURCE', 'ROLE'])
    expect(result.capacityProfiles.map(p => p.id)).toEqual(['cp-2', 'cp-3', 'cp-1'])

    // cp-2 (index 0): NAMED_PERSON, object legacy, segments sorted by startWeek/endWeek/id
    const cp2 = result.capacityProfiles[0]
    expect(cp2.ownerKind).toBe('NAMED_PERSON')
    expect(cp2.namedResourceId).toBe('nr-alice')
    expect(cp2.planningBasis).toBe('AVAILABILITY_WINDOW')
    expect(cp2.source).toBe('SQUAD_PLANNER')
    expect(cp2.defaultPercent).toBe(100)
    expect(cp2.startWeek).toBe(0)
    expect(cp2.endWeek).toBe(10)
    expect(cp2.legacy).toEqual({ allocationMode: 'EFFORT' })
    expect(cp2.segments.map(s => s.id)).toEqual(['seg-2a', 'seg-2b', 'seg-2c'])
    expect(cp2.segments[0]).toEqual({ id: 'seg-2a', startWeek: 0, endWeek: 4, capacityPercent: 100, source: 'SQUAD_PLANNER' })
    expect(cp2.segments[1].startWeek).toBe(4)
    expect(cp2.segments[2].startWeek).toBe(8)

    // cp-3 (index 1): PLANNED_RESOURCE, object legacy, segments sorted
    const cp3 = result.capacityProfiles[1]
    expect(cp3.ownerKind).toBe('PLANNED_RESOURCE')
    expect(cp3.namedResourceId).toBe('nr-bob')
    expect(cp3.planningBasis).toBe('WHOLE_PROJECT_ALLOCATION')
    expect(cp3.source).toBe('MANUAL')
    expect(cp3.legacy).toEqual({ oldField: 'value' })
    expect(cp3.segments.map(s => s.id)).toEqual(['seg-3a', 'seg-3b'])
    expect(cp3.segments[0].capacityPercent).toBe(50)
    expect(cp3.segments[1].capacityPercent).toBe(100)

    // cp-1 (index 2): ROLE, null legacy, no segments
    const cp1 = result.capacityProfiles[2]
    expect(cp1.ownerKind).toBe('ROLE')
    expect(cp1.resourceTypeId).toBe('rt-dev')
    expect(cp1.namedResourceId).toBeNull()
    expect(cp1.planningBasis).toBe('DEMAND_FOLLOWING')
    expect(cp1.source).toBe('FIXED')
    expect(cp1.defaultPercent).toBeNull()
    expect(cp1.startWeek).toBeNull()
    expect(cp1.endWeek).toBeNull()
    expect(cp1.legacy).toBeNull()
    expect(cp1.segments).toEqual([])
  })
})
// ═══════════════════════════════════════════════════════════════════════════
// 5. Route — V1/V2/V3 rollback
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Build a mock transaction client with all delegates needed by buildSnapshot,
 * restoreSnapshotCommonState, recreateV2/V3CapacityProfiles, and pruneSnapshots.
 */
function makeRouteTx(overrides: Record<string, unknown> = {}) {
  const base = {
    epic: { findMany: vi.fn().mockResolvedValue([]), deleteMany: vi.fn().mockResolvedValue({ count: 0 }), create: vi.fn().mockResolvedValue({ id: 'new-epic' }) },
    project: { findUnique: vi.fn().mockResolvedValue({ startDate: new Date(), onboardingWeeks: null, bufferWeeks: null, hoursPerDay: null }), update: vi.fn().mockResolvedValue({}) },
    resourceType: { findMany: vi.fn().mockResolvedValue([]), upsert: vi.fn().mockResolvedValue({}) },
    namedResource: { findMany: vi.fn().mockResolvedValue([]), upsert: vi.fn().mockResolvedValue({}) },
    timelineEntry: { findMany: vi.fn().mockResolvedValue([]), deleteMany: vi.fn().mockResolvedValue({ count: 0 }), createMany: vi.fn().mockResolvedValue({ count: 0 }) },
    storyTimelineEntry: { findMany: vi.fn().mockResolvedValue([]), deleteMany: vi.fn().mockResolvedValue({ count: 0 }), createMany: vi.fn().mockResolvedValue({ count: 0 }) },
    epicDependency: { findMany: vi.fn().mockResolvedValue([]), deleteMany: vi.fn().mockResolvedValue({ count: 0 }), createMany: vi.fn().mockResolvedValue({ count: 0 }) },
    featureDependency: { findMany: vi.fn().mockResolvedValue([]), deleteMany: vi.fn().mockResolvedValue({ count: 0 }), createMany: vi.fn().mockResolvedValue({ count: 0 }) },
    projectOverhead: { findMany: vi.fn().mockResolvedValue([]), deleteMany: vi.fn().mockResolvedValue({ count: 0 }), createMany: vi.fn().mockResolvedValue({ count: 0 }) },
    capacityProfile: { findMany: vi.fn().mockResolvedValue([]), deleteMany: vi.fn().mockResolvedValue({ count: 999 }), create: vi.fn().mockResolvedValue({}) },
    capacitySegment: { deleteMany: vi.fn().mockResolvedValue({ count: 999 }), create: vi.fn().mockResolvedValue({}) },
    feature: { create: vi.fn().mockResolvedValue({ id: 'new-feature' }) },
    userStory: { create: vi.fn().mockResolvedValue({ id: 'new-story' }) },
    task: { create: vi.fn() },
    backlogSnapshot: { create: vi.fn().mockResolvedValue({}), findMany: vi.fn().mockResolvedValue([]), deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
  }
  return { ...base, ...overrides }
}

describe('POST /api/projects/:projectId/snapshots/:snapshotId/rollback', () => {
  it('V1: bare epic array restores epics, no capacity operations', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue({ id: projId, ownerId: userId } as never)
    vi.mocked(prisma.backlogSnapshot.findFirst).mockResolvedValue({
      id: 'snap-v1', projectId: projId, label: 'Legacy V1',
      trigger: 'manual',
      snapshot: [{ id: 'e1', name: 'Epic', description: null, assumptions: null, order: 0,
        featureMode: 'FIFO', scheduleMode: 'ASAP', timelineStartWeek: null,
        isActive: true, projectId: projId, features: [] }],
      createdById: userId, createdAt: new Date(),
    } as never)

    const cpDelete = vi.fn().mockResolvedValue({ count: 0 })
    const cpCreate = vi.fn().mockResolvedValue({})
    const epicDel = vi.fn().mockResolvedValue({ count: 0 })

    vi.mocked(prisma.$transaction).mockImplementation(async (fn: unknown) => {
      const tx = makeRouteTx({
        capacityProfile: { findMany: vi.fn().mockResolvedValue([]), deleteMany: cpDelete, create: cpCreate },
        epic: { findMany: vi.fn().mockResolvedValue([]), deleteMany: epicDel, create: vi.fn().mockResolvedValue({ id: 'new-e1' }) },
      })
      return typeof fn === 'function'
        ? (fn as (t: unknown) => Promise<unknown>)(tx)
        : Promise.resolve(fn)
    })

    const res = await request(app)
      .post(`/api/projects/${projId}/snapshots/snap-v1/rollback`)
      .set('Authorization', authHeader)

    expect(res.status).toBe(200)
    expect(vi.mocked(prisma.$transaction)).toHaveBeenCalledTimes(1)
    expect(cpDelete.mock.calls.length).toBe(0)
    expect(cpCreate.mock.calls.length).toBe(0)
    expect(epicDel.mock.calls.length).toBeGreaterThanOrEqual(1)
  })

  it('V2: full-state restore via transaction, legacy-compatible profiles', async () => {
    const v2Data = {
      schemaVersion: 2, epics: [], project: null,
      resourceTypes: [{
        id: 'rt-1', name: 'Developer', category: 'role', count: 1,
        hoursPerDay: null, dayRate: null, globalTypeId: null,
        allocationMode: 'TIMELINE', allocationPercent: 60,
        allocationStartWeek: 2, allocationEndWeek: 6,
      }],
      namedResources: [],
      timelineEntries: [], storyTimelineEntries: [],
      epicDependencies: [], featureDependencies: [], overheadItems: [],
    }

    vi.mocked(prisma.project.findFirst).mockResolvedValue({ id: projId, ownerId: userId } as never)
    vi.mocked(prisma.backlogSnapshot.findFirst).mockResolvedValue({
      id: 'snap-v2', projectId: projId, label: 'V2 full',
      trigger: 'manual', snapshot: v2Data,
      createdById: userId, createdAt: new Date(),
    } as never)

    const cpDelete = vi.fn().mockResolvedValue({ count: 999 })
    const segDelete = vi.fn().mockResolvedValue({ count: 999 })
    const cpCreate = vi.fn().mockResolvedValue({})

    vi.mocked(prisma.$transaction).mockImplementation(async (fn: unknown) => {
      const tx = makeRouteTx({
        capacityProfile: { findMany: vi.fn().mockResolvedValue([]), deleteMany: cpDelete, create: cpCreate },
        capacitySegment: { deleteMany: segDelete, create: vi.fn().mockResolvedValue({}) },
      })
      return typeof fn === 'function'
        ? (fn as (t: unknown) => Promise<unknown>)(tx)
        : Promise.resolve(fn)
    })

    const res = await request(app)
      .post(`/api/projects/${projId}/snapshots/snap-v2/rollback`)
      .set('Authorization', authHeader)

    expect(res.status).toBe(200)
    expect(vi.mocked(prisma.$transaction)).toHaveBeenCalledTimes(1)
    expect(cpDelete.mock.calls.length).toBeGreaterThanOrEqual(1)
    expect(segDelete.mock.calls.length).toBeGreaterThanOrEqual(1)
    expect(cpCreate.mock.calls.length).toBe(1)

    const created = cpCreate.mock.calls[0][0]?.data as Record<string, unknown>
    expect(created.id).toBe('snapshot-v2-role-rt-1')
    expect(created.projectId).toBe(projId)
    expect(created.ownerKind).toBe('ROLE')
    expect(created.planningBasis).toBe('AVAILABILITY_WINDOW')
    expect(created.source).toBe('AVAILABILITY_WINDOW')
    expect(created.defaultPercent).toBe(60)
    expect(created.startWeek).toBe(2)
    expect(created.endWeek).toBe(6)
  })

  it('V3: exact profile/segment replacement in transaction', async () => {
    const v3Target: SnapshotV3 = {
      schemaVersion: 3, epics: [], project: null,
      resourceTypes: [
        { id: 'rt-dev', name: 'Developer', category: 'role', count: 2,
          hoursPerDay: 8, dayRate: 500, globalTypeId: null,
          allocationMode: 'TIMELINE', allocationPercent: 100,
          allocationStartWeek: 0, allocationEndWeek: 10 },
      ],
      namedResources: [
        { id: 'nr-alice', resourceTypeId: 'rt-dev', name: 'Alice',
          startWeek: null, endWeek: null, allocationPct: 100,
          allocationMode: 'EFFORT', allocationPercent: 100,
          allocationStartWeek: null, allocationEndWeek: null,
          pricingModel: 'ACTUAL_DAYS' },
      ],
      timelineEntries: [], storyTimelineEntries: [],
      epicDependencies: [], featureDependencies: [], overheadItems: [],
      capacityProfiles: [
        {
          id: 'cp-1', ownerKind: 'ROLE', resourceTypeId: 'rt-dev', namedResourceId: null,
          planningBasis: 'DEMAND_FOLLOWING', source: 'FIXED', defaultPercent: null,
          startWeek: null, endWeek: null, legacy: null, segments: [],
        },
        {
          id: 'cp-2', ownerKind: 'NAMED_PERSON', resourceTypeId: null, namedResourceId: 'nr-alice',
          planningBasis: 'AVAILABILITY_WINDOW', source: 'SQUAD_PLANNER', defaultPercent: 100,
          startWeek: 0, endWeek: 10, legacy: { mode: 'EFFORT' },
          segments: [
            { id: 'seg-a', startWeek: 0, endWeek: 4, capacityPercent: 100, source: 'SQUAD_PLANNER' },
          ],
        },
      ],
    }

    vi.mocked(prisma.project.findFirst).mockResolvedValue({ id: projId, ownerId: userId } as never)
    vi.mocked(prisma.backlogSnapshot.findFirst).mockResolvedValue({
      id: 'snap-v3', projectId: projId, label: 'test-v3',
      trigger: 'manual', snapshot: v3Target as unknown as never,
      createdById: userId, createdAt: new Date(),
    } as never)
    vi.mocked(prisma.resourceType.findMany).mockResolvedValue([
      { id: 'rt-dev', projectId: projId },
    ] as never)
    vi.mocked(prisma.namedResource.findMany).mockResolvedValue([
      { id: 'nr-alice', resourceType: { projectId: projId } },
    ] as never)

    const cpDelete = vi.fn().mockResolvedValue({ count: 999 })
    const segDelete = vi.fn().mockResolvedValue({ count: 999 })
    const cpCreate = vi.fn().mockResolvedValue({})
    const segCreate = vi.fn().mockResolvedValue({})
    const bsCreate = vi.fn().mockResolvedValue({})

    vi.mocked(prisma.$transaction).mockImplementation(async (fn: unknown) => {
      const tx = makeRouteTx({
        capacityProfile: { findMany: vi.fn().mockResolvedValue([]), deleteMany: cpDelete, create: cpCreate },
        capacitySegment: { deleteMany: segDelete, create: segCreate },
        backlogSnapshot: { create: bsCreate, findMany: vi.fn().mockResolvedValue([]), deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
      })
      return typeof fn === 'function'
        ? (fn as (t: unknown) => Promise<unknown>)(tx)
        : Promise.resolve(fn)
    })

    const res = await request(app)
      .post(`/api/projects/${projId}/snapshots/snap-v3/rollback`)
      .set('Authorization', authHeader)

    expect(res.status).toBe(200)
    expect(vi.mocked(prisma.$transaction)).toHaveBeenCalledTimes(1)
    // Pre-rollback snapshot created inside transaction (tx mock, not global prisma)
    expect(bsCreate.mock.calls.length).toBeGreaterThanOrEqual(1)

    // Existing profiles/segments deleted
    expect(cpDelete.mock.calls.length).toBeGreaterThanOrEqual(1)
    expect(segDelete.mock.calls.length).toBeGreaterThanOrEqual(1)

    // Target profiles recreated with exact IDs and fields
    expect(cpCreate.mock.calls.length).toBe(2)

    const cp1 = cpCreate.mock.calls[0][0]?.data as Record<string, unknown>
    expect(cp1.id).toBe('cp-1')
    expect(cp1.projectId).toBe(projId)
    expect(cp1.ownerKind).toBe('ROLE')
    expect(cp1.resourceTypeId).toBe('rt-dev')
    expect(cp1.namedResourceId).toBeNull()
    expect(cp1.legacy).toBeNull()
    expect(cp1.planningBasis).toBe('DEMAND_FOLLOWING')
    expect(cp1.source).toBe('FIXED')
    expect(cp1.defaultPercent).toBeNull()
    expect(cp1.startWeek).toBeNull()
    expect(cp1.endWeek).toBeNull()

    const cp2 = cpCreate.mock.calls[1][0]?.data as Record<string, unknown>
    expect(cp2.id).toBe('cp-2')
    expect(cp2.projectId).toBe(projId)
    expect(cp2.ownerKind).toBe('NAMED_PERSON')
    expect(cp2.namedResourceId).toBe('nr-alice')
    expect(cp2.legacy).toEqual({ mode: 'EFFORT' })
    expect(cp2.planningBasis).toBe('AVAILABILITY_WINDOW')
    expect(cp2.source).toBe('SQUAD_PLANNER')
    expect(cp2.defaultPercent).toBe(100)
    expect(cp2.startWeek).toBe(0)
    expect(cp2.endWeek).toBe(10)

    // Segments recreated with exact IDs and values
    expect(segCreate.mock.calls.length).toBe(1)
    const seg1 = segCreate.mock.calls[0][0]?.data as Record<string, unknown>
    expect(seg1.id).toBe('seg-a')
    expect(seg1.capacityProfileId).toBe('cp-2')
    expect(seg1.startWeek).toBe(0)
    expect(seg1.endWeek).toBe(4)
    expect(seg1.capacityPercent).toBe(100)
    expect(seg1.source).toBe('SQUAD_PLANNER')
  })

  // ═════════════════════════════════════════════════════════════════════════
  // 6. Pre-flight validation (before transaction)
  // ═════════════════════════════════════════════════════════════════════════

  it('V3: invalid profile data returns 400 before transaction', async () => {
    const invalidV3 = {
      schemaVersion: 3, epics: [], project: null,
      resourceTypes: [{ id: 'rt-dev', name: 'Dev', category: 'role', count: 1,
        hoursPerDay: 8, dayRate: 500, globalTypeId: null,
        allocationMode: 'TIMELINE', allocationPercent: 100,
        allocationStartWeek: 0, allocationEndWeek: 10 }],
      namedResources: [{ id: 'nr-alice', resourceTypeId: 'rt-dev', name: 'Alice',
        startWeek: null, endWeek: null, allocationPct: 100,
        allocationMode: 'EFFORT', allocationPercent: 100,
        allocationStartWeek: null, allocationEndWeek: null, pricingModel: 'ACTUAL_DAYS' }],
      timelineEntries: [], storyTimelineEntries: [],
      epicDependencies: [], featureDependencies: [], overheadItems: [],
      capacityProfiles: [
        { id: 'cp-1', ownerKind: 'ROLE', resourceTypeId: null, namedResourceId: null,
          planningBasis: 'DEMAND_FOLLOWING', source: 'FIXED', defaultPercent: null,
          startWeek: null, endWeek: null, legacy: null, segments: [] },
      ],
    }

    vi.mocked(prisma.project.findFirst).mockResolvedValue({ id: projId, ownerId: userId } as never)
    vi.mocked(prisma.backlogSnapshot.findFirst).mockResolvedValue({
      id: 'snap-bad', projectId: projId, label: 'bad',
      trigger: 'manual', snapshot: invalidV3,
      createdById: userId, createdAt: new Date(),
    } as never)

    const txSpy = vi.mocked(prisma.$transaction)

    const res = await request(app)
      .post(`/api/projects/${projId}/snapshots/snap-bad/rollback`)
      .set('Authorization', authHeader)

    expect(res.status).toBe(400)
    expect(txSpy).not.toHaveBeenCalled()
  })

  it('unknown schema version returns 400 before transaction', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue({ id: projId, ownerId: userId } as never)
    vi.mocked(prisma.backlogSnapshot.findFirst).mockResolvedValue({
      id: 'snap-future', projectId: projId, label: 'future',
      trigger: 'manual',
      snapshot: { schemaVersion: 99, epics: [], resourceTypes: [], namedResources: [],
        timelineEntries: [], storyTimelineEntries: [], epicDependencies: [],
        featureDependencies: [], overheadItems: [], capacityProfiles: [] },
      createdById: userId, createdAt: new Date(),
    } as never)

    const txSpy = vi.mocked(prisma.$transaction)

    const res = await request(app)
      .post(`/api/projects/${projId}/snapshots/snap-future/rollback`)
      .set('Authorization', authHeader)

    expect(res.status).toBe(400)
    expect(txSpy).not.toHaveBeenCalled()
  })

  it('cross-project ID collision returns 400 before transaction', async () => {
    const v3Target: SnapshotV3 = {
      schemaVersion: 3, epics: [], project: null,
      resourceTypes: [{ id: 'rt-dev', name: 'Dev', category: 'role', count: 1,
        hoursPerDay: 8, dayRate: 500, globalTypeId: null,
        allocationMode: 'TIMELINE', allocationPercent: 100,
        allocationStartWeek: 0, allocationEndWeek: 10 }],
      namedResources: [],
      timelineEntries: [], storyTimelineEntries: [],
      epicDependencies: [], featureDependencies: [], overheadItems: [],
      capacityProfiles: [
        { id: 'cp-1', ownerKind: 'ROLE', resourceTypeId: 'rt-dev', namedResourceId: null,
          planningBasis: 'DEMAND_FOLLOWING', source: 'FIXED', defaultPercent: null,
          startWeek: null, endWeek: null, legacy: null, segments: [] },
      ],
    }

    vi.mocked(prisma.project.findFirst).mockResolvedValue({ id: projId, ownerId: userId } as never)
    vi.mocked(prisma.backlogSnapshot.findFirst).mockResolvedValue({
      id: 'snap-cross', projectId: projId, label: 'cross',
      trigger: 'manual', snapshot: v3Target as unknown as never,
      createdById: userId, createdAt: new Date(),
    } as never)
    vi.mocked(prisma.resourceType.findMany).mockResolvedValue([
      { id: 'rt-dev', projectId: 'other-proj' },
    ] as never)

    const txSpy = vi.mocked(prisma.$transaction)

    const res = await request(app)
      .post(`/api/projects/${projId}/snapshots/snap-cross/rollback`)
      .set('Authorization', authHeader)

    expect(res.status).toBe(400)
    expect(txSpy).not.toHaveBeenCalled()
  })


  it('V3: foreign resourceType from snapshot.resourceTypes rejected before transaction', async () => {
    const v3Target: SnapshotV3 = {
      schemaVersion: 3, epics: [], project: null,
      resourceTypes: [{ id: 'rt-foreign', name: 'OtherTeam', category: 'role', count: 1,
        hoursPerDay: 8, dayRate: 500, globalTypeId: null,
        allocationMode: 'TIMELINE', allocationPercent: 100,
        allocationStartWeek: 0, allocationEndWeek: 10 }],
      namedResources: [],
      timelineEntries: [], storyTimelineEntries: [],
      epicDependencies: [], featureDependencies: [], overheadItems: [],
      capacityProfiles: [],
    }

    vi.mocked(prisma.project.findFirst).mockResolvedValue({ id: projId, ownerId: userId } as never)
    vi.mocked(prisma.backlogSnapshot.findFirst).mockResolvedValue({
      id: 'snap-rt-foreign', projectId: projId, label: 'foreign-rt',
      trigger: 'manual', snapshot: v3Target as unknown as never,
      createdById: userId, createdAt: new Date(),
    } as never)
    vi.mocked(prisma.resourceType.findMany).mockResolvedValue([
      { id: 'rt-foreign', projectId: 'other-proj' },
    ] as never)

    const txSpy = vi.mocked(prisma.$transaction)

    const res = await request(app)
      .post(`/api/projects/${projId}/snapshots/snap-rt-foreign/rollback`)
      .set('Authorization', authHeader)

    expect(res.status).toBe(400)
    expect(txSpy).not.toHaveBeenCalled()
  })

  it('V3: foreign namedResource from snapshot.namedResources rejected before transaction', async () => {
    const v3Target: SnapshotV3 = {
      schemaVersion: 3, epics: [], project: null,
      resourceTypes: [{ id: 'rt-dev', name: 'Dev', category: 'role', count: 1,
        hoursPerDay: 8, dayRate: 500, globalTypeId: null,
        allocationMode: 'TIMELINE', allocationPercent: 100,
        allocationStartWeek: 0, allocationEndWeek: 10 }],
      namedResources: [{ id: 'nr-foreign', resourceTypeId: 'rt-dev', name: 'Bob',
        startWeek: null, endWeek: null, allocationPct: 100,
        allocationMode: 'EFFORT', allocationPercent: 100,
        allocationStartWeek: null, allocationEndWeek: null, pricingModel: 'ACTUAL_DAYS' }],
      timelineEntries: [], storyTimelineEntries: [],
      epicDependencies: [], featureDependencies: [], overheadItems: [],
      capacityProfiles: [],
    }

    vi.mocked(prisma.project.findFirst).mockResolvedValue({ id: projId, ownerId: userId } as never)
    vi.mocked(prisma.backlogSnapshot.findFirst).mockResolvedValue({
      id: 'snap-nr-foreign', projectId: projId, label: 'foreign-nr',
      trigger: 'manual', snapshot: v3Target as unknown as never,
      createdById: userId, createdAt: new Date(),
    } as never)
    // resourceType ID is new (doesn't exist in DB) — allowed
    vi.mocked(prisma.resourceType.findMany).mockResolvedValue([] as never)
    vi.mocked(prisma.namedResource.findMany).mockResolvedValue([
      { id: 'nr-foreign', resourceType: { projectId: 'other-proj' } },
    ] as never)

    const txSpy = vi.mocked(prisma.$transaction)

    const res = await request(app)
      .post(`/api/projects/${projId}/snapshots/snap-nr-foreign/rollback`)
      .set('Authorization', authHeader)

    expect(res.status).toBe(400)
    expect(txSpy).not.toHaveBeenCalled()
  })

  it('V3: foreign overhead resourceType rejected before transaction', async () => {
    const v3Target: SnapshotV3 = {
      schemaVersion: 3, epics: [], project: null,
      resourceTypes: [
        { id: 'rt-dev', name: 'Dev', category: 'role', count: 1,
          hoursPerDay: 8, dayRate: 500, globalTypeId: null,
          allocationMode: 'TIMELINE', allocationPercent: 100,
          allocationStartWeek: 0, allocationEndWeek: 10 },
        { id: 'rt-foreign', name: 'Other', category: 'role', count: 1,
          hoursPerDay: 8, dayRate: 500, globalTypeId: null,
          allocationMode: 'TIMELINE', allocationPercent: 100,
          allocationStartWeek: 0, allocationEndWeek: 10 },
      ],
      namedResources: [],
      timelineEntries: [], storyTimelineEntries: [],
      epicDependencies: [], featureDependencies: [],
      overheadItems: [{ name: 'PM', type: 'percent', value: 10, resourceTypeId: 'rt-foreign', order: 1 }],
      capacityProfiles: [],
    }

    vi.mocked(prisma.project.findFirst).mockResolvedValue({ id: projId, ownerId: userId } as never)
    vi.mocked(prisma.backlogSnapshot.findFirst).mockResolvedValue({
      id: 'snap-oh-foreign', projectId: projId, label: 'foreign-oh',
      trigger: 'manual', snapshot: v3Target as unknown as never,
      createdById: userId, createdAt: new Date(),
    } as never)
    // 'rt-dev' is a new ID (fine); 'rt-foreign' already exists in another project
    vi.mocked(prisma.resourceType.findMany).mockResolvedValue([
      { id: 'rt-foreign', projectId: 'other-proj' },
    ] as never)

    const txSpy = vi.mocked(prisma.$transaction)

    const res = await request(app)
      .post(`/api/projects/${projId}/snapshots/snap-oh-foreign/rollback`)
      .set('Authorization', authHeader)

    expect(res.status).toBe(400)
    expect(txSpy).not.toHaveBeenCalled()
  })

  it('V3: new IDs not in DB are allowed (valid rollback)', async () => {
    const v3Target: SnapshotV3 = {
      schemaVersion: 3, epics: [], project: null,
      resourceTypes: [{ id: 'rt-new', name: 'NewRole', category: 'role', count: 1,
        hoursPerDay: 8, dayRate: 500, globalTypeId: null,
        allocationMode: 'TIMELINE', allocationPercent: 100,
        allocationStartWeek: 0, allocationEndWeek: 10 }],
      namedResources: [{ id: 'nr-new', resourceTypeId: 'rt-new', name: 'NewPerson',
        startWeek: null, endWeek: null, allocationPct: 100,
        allocationMode: 'EFFORT', allocationPercent: 100,
        allocationStartWeek: null, allocationEndWeek: null, pricingModel: 'ACTUAL_DAYS' }],
      timelineEntries: [], storyTimelineEntries: [],
      epicDependencies: [], featureDependencies: [], overheadItems: [],
      capacityProfiles: [
        { id: 'cp-new', ownerKind: 'ROLE', resourceTypeId: 'rt-new', namedResourceId: null,
          planningBasis: 'DEMAND_FOLLOWING', source: 'FIXED', defaultPercent: null,
          startWeek: null, endWeek: null, legacy: null, segments: [] },
      ],
    }

    vi.mocked(prisma.project.findFirst).mockResolvedValue({ id: projId, ownerId: userId } as never)
    vi.mocked(prisma.backlogSnapshot.findFirst).mockResolvedValue({
      id: 'snap-newids', projectId: projId, label: 'new-ids',
      trigger: 'manual', snapshot: v3Target as unknown as never,
      createdById: userId, createdAt: new Date(),
    } as never)
    vi.mocked(prisma.resourceType.findMany).mockResolvedValue([] as never)
    vi.mocked(prisma.namedResource.findMany).mockResolvedValue([] as never)

    const cpDelete = vi.fn().mockResolvedValue({ count: 0 })
    const segDelete = vi.fn().mockResolvedValue({ count: 0 })
    const cpCreate = vi.fn().mockResolvedValue({})
    const segCreate = vi.fn().mockResolvedValue({})
    const bsCreate = vi.fn().mockResolvedValue({})

    vi.mocked(prisma.$transaction).mockImplementation(async (fn: unknown) => {
      const tx = makeRouteTx({
        capacityProfile: { findMany: vi.fn().mockResolvedValue([]), deleteMany: cpDelete, create: cpCreate },
        capacitySegment: { deleteMany: segDelete, create: segCreate },
        backlogSnapshot: { create: bsCreate, findMany: vi.fn().mockResolvedValue([]), deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
      })
      return typeof fn === 'function'
        ? (fn as (t: unknown) => Promise<unknown>)(tx)
        : Promise.resolve(fn)
    })

    const txSpy = vi.mocked(prisma.$transaction)

    const res = await request(app)
      .post(`/api/projects/${projId}/snapshots/snap-newids/rollback`)
      .set('Authorization', authHeader)

    // No DB rows for these IDs, so cross-project checks pass → reaches transaction
    expect(txSpy).toHaveBeenCalled()
    expect(res.status).toBe(200)
  })
  // ═════════════════════════════════════════════════════════════════════════
  // 7. 404 and transaction atomicity
  // ═════════════════════════════════════════════════════════════════════════

  it('returns 404 when snapshot is not found', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue({ id: projId, ownerId: userId } as never)
    vi.mocked(prisma.backlogSnapshot.findFirst).mockResolvedValue(null as never)

    const res = await request(app)
      .post(`/api/projects/${projId}/snapshots/nonexistent/rollback`)
      .set('Authorization', authHeader)

    expect(res.status).toBe(404)
  })

  it('returns 404 when project is not found / not owned', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue(null as never)

    const res = await request(app)
      .post(`/api/projects/${projId}/snapshots/snap-1/rollback`)
      .set('Authorization', authHeader)

    expect(res.status).toBe(404)
  })

  it('$transaction rejection returns 500 with no external cleanup', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue({ id: projId, ownerId: userId } as never)
    vi.mocked(prisma.backlogSnapshot.findFirst).mockResolvedValue({
      id: 'snap-fail', projectId: projId, label: 'fail',
      trigger: 'manual',
      snapshot: [{ id: 'e1', name: 'E', features: [] }],
      createdById: userId, createdAt: new Date(),
    } as never)

    vi.mocked(prisma.$transaction).mockRejectedValue(new Error('DB timeout'))
    const bsDeleteSpy = vi.mocked(prisma.backlogSnapshot.delete)

    const res = await request(app)
      .post(`/api/projects/${projId}/snapshots/snap-fail/rollback`)
      .set('Authorization', authHeader)

    expect(res.status).toBe(500)
    // Transaction is the atomic boundary — no external cleanup
    expect(bsDeleteSpy).not.toHaveBeenCalled()
  })

  it('V3 tx callback failure rejects with 500 (restore/write error)', async () => {
    const v3Target: SnapshotV3 = {
      schemaVersion: 3, epics: [], project: null,
      resourceTypes: [{ id: 'rt-dev', name: 'Dev', category: 'role', count: 1,
        hoursPerDay: 8, dayRate: 500, globalTypeId: null,
        allocationMode: 'TIMELINE', allocationPercent: 100,
        allocationStartWeek: 0, allocationEndWeek: 10 }],
      namedResources: [],
      timelineEntries: [], storyTimelineEntries: [],
      epicDependencies: [], featureDependencies: [], overheadItems: [],
      capacityProfiles: [
        { id: 'cp-1', ownerKind: 'ROLE', resourceTypeId: 'rt-dev', namedResourceId: null,
          planningBasis: 'DEMAND_FOLLOWING', source: 'FIXED', defaultPercent: null,
          startWeek: null, endWeek: null, legacy: null, segments: [] },
      ],
    }

    vi.mocked(prisma.project.findFirst).mockResolvedValue({ id: projId, ownerId: userId } as never)
    vi.mocked(prisma.backlogSnapshot.findFirst).mockResolvedValue({
      id: 'snap-failwrite', projectId: projId, label: 'failwrite',
      trigger: 'manual', snapshot: v3Target as unknown as never,
      createdById: userId, createdAt: new Date(),
    } as never)
    vi.mocked(prisma.resourceType.findMany).mockResolvedValue([
      { id: 'rt-dev', projectId: projId },
    ] as never)

    // Make capacityProfile.create throw inside the callback
    const cpCreate = vi.fn().mockRejectedValue(new Error('Write failure'))

    vi.mocked(prisma.$transaction).mockImplementation(async (fn: unknown) => {
      const tx = makeRouteTx({
        capacityProfile: { findMany: vi.fn().mockResolvedValue([]), deleteMany: vi.fn().mockResolvedValue({ count: 0 }), create: cpCreate },
      })
      return typeof fn === 'function'
        ? (fn as (t: unknown) => Promise<unknown>)(tx)
        : Promise.resolve(fn)
    })

    const bsDeleteSpy = vi.mocked(prisma.backlogSnapshot.delete)

    const res = await request(app)
      .post(`/api/projects/${projId}/snapshots/snap-failwrite/rollback`)
      .set('Authorization', authHeader)

    expect(res.status).toBe(500)
    // The callback threw, so it was attempted
    expect(cpCreate.mock.calls.length).toBeGreaterThanOrEqual(1)
    // No external cleanup — DB transaction provides atomicity
    expect(bsDeleteSpy).not.toHaveBeenCalled()
  })
})
