/**
 * preflightRollback.spec.ts — Focused unit tests for
 * profile-first preflight and snapshot rollback fixes in PR #374.
 *
 * Tests:
 *  1. conflictPreflightCheck — existing NAMED_PERSON is protected and never
 *     blocks planner growth; shortfalls are filled with placeholders.
 *  2. restoreSnapshotCommonState — post-snapshot named resources are
 *     deleted during rollback; snapshot named resources survive.
 *  3. findOrCreatePlannedResources — NAMED_PERSON resources are excluded
 *     from the planner-eligible pool via isPlannerManaged.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  conflictPreflightCheck,
  findOrCreatePlannedResources,
} from '../lib/squadPlannerProfileWriter.js'
import { restoreSnapshotCommonState } from '../lib/projectSnapshotService.js'

beforeEach(() => {
  vi.clearAllMocks()
})

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeTx(overrides: Record<string, unknown> = {}) {
  const base = {
    capacityProfile: {
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn().mockResolvedValue(null),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      create: vi.fn().mockResolvedValue({}),
      update: vi.fn().mockResolvedValue({}),
    },
    namedResource: {
      findMany: vi.fn().mockResolvedValue([]),
      createMany: vi.fn().mockResolvedValue({ count: 0 }),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      update: vi.fn().mockResolvedValue({}),
      upsert: vi.fn().mockResolvedValue({}),
      count: vi.fn().mockResolvedValue(0),
    },
    resourceType: {
      findUnique: vi.fn().mockResolvedValue({ id: 'rt-dev', name: 'Developer', projectId: 'proj-1' }),
      findMany: vi.fn().mockResolvedValue([]),
      upsert: vi.fn().mockResolvedValue({}),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    capacityPlan: {
      findFirst: vi.fn().mockResolvedValue(null),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    capacitySegment: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
    epic: { findMany: vi.fn().mockResolvedValue([]), deleteMany: vi.fn().mockResolvedValue({ count: 0 }), create: vi.fn() },
    feature: { create: vi.fn() },
    userStory: { create: vi.fn() },
    task: { create: vi.fn() },
    project: { findUnique: vi.fn().mockResolvedValue(null), update: vi.fn() },
    timelineEntry: { findMany: vi.fn().mockResolvedValue([]), deleteMany: vi.fn().mockResolvedValue({ count: 0 }), createMany: vi.fn() },
    storyTimelineEntry: { findMany: vi.fn().mockResolvedValue([]), deleteMany: vi.fn().mockResolvedValue({ count: 0 }), createMany: vi.fn() },
    epicDependency: { findMany: vi.fn().mockResolvedValue([]), deleteMany: vi.fn().mockResolvedValue({ count: 0 }), createMany: vi.fn() },
    featureDependency: { findMany: vi.fn().mockResolvedValue([]), deleteMany: vi.fn().mockResolvedValue({ count: 0 }), createMany: vi.fn() },
    projectOverhead: { findMany: vi.fn().mockResolvedValue([]), deleteMany: vi.fn().mockResolvedValue({ count: 0 }), createMany: vi.fn() },
    backlogSnapshot: { create: vi.fn(), findMany: vi.fn().mockResolvedValue([]), deleteMany: vi.fn() },
    $queryRaw: vi.fn().mockResolvedValue([]),
  }
  return { ...base, ...overrides }
}

// ═════════════════════════════════════════════════════════════════════════════
// 1. conflictPreflightCheck — NAMED_PERSON + new planned resource succeeds
// ═════════════════════════════════════════════════════════════════════════════

describe('conflictPreflightCheck', () => {
  it('passes when NAMED_PERSON exists but enough other resources fill all trajectories', async () => {
    const tx = makeTx({
      capacityProfile: {
        findMany: vi.fn()
          .mockResolvedValueOnce([
            { id: 'cp-1', projectId: 'proj-1', resourceTypeId: null, namedResourceId: 'nr-alice', ownerKind: 'NAMED_PERSON', source: 'MANUAL', planningBasis: 'AVAILABILITY_WINDOW' },
            { id: 'cp-2', projectId: 'proj-1', resourceTypeId: null, namedResourceId: 'nr-bob', ownerKind: 'PLANNED_RESOURCE', source: 'SQUAD_PLANNER', planningBasis: 'CAPACITY_PROFILE' },
            { id: 'cp-3', projectId: 'proj-1', resourceTypeId: null, namedResourceId: 'nr-carol', ownerKind: 'PLANNED_RESOURCE', source: 'SQUAD_PLANNER', planningBasis: 'CAPACITY_PROFILE' },
          ])
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([
            { namedResourceId: 'nr-alice', ownerKind: 'NAMED_PERSON', source: 'MANUAL', planningBasis: 'AVAILABILITY_WINDOW' },
            { namedResourceId: 'nr-bob', ownerKind: 'PLANNED_RESOURCE', source: 'SQUAD_PLANNER', planningBasis: 'CAPACITY_PROFILE' },
            { namedResourceId: 'nr-carol', ownerKind: 'PLANNED_RESOURCE', source: 'SQUAD_PLANNER', planningBasis: 'CAPACITY_PROFILE' },
          ]),
      },
      namedResource: {
        findMany: vi.fn().mockResolvedValue([
          { id: 'nr-alice', name: 'Alice', allocationMode: 'CAPACITY_PLAN' },
          { id: 'nr-bob', name: 'Bob', allocationMode: 'CAPACITY_PLAN' },
          { id: 'nr-carol', name: 'Carol', allocationMode: 'CAPACITY_PLAN' },
        ]),
      },
    })

    const result = await conflictPreflightCheck(tx as never, 'proj-1', [{
      periodIndex: 0,
      startWeek: 0,
      endWeek: 4,
      entries: [{ resourceTypeId: 'rt-dev', headcount: 2 }],
    }])

    expect(result).toBeUndefined()
  })

  it('passes when NAMED_PERSON exists and placeholders must fill remaining trajectories', async () => {
    const tx = makeTx({
      capacityProfile: {
        findMany: vi.fn()
          .mockResolvedValueOnce([
            { id: 'cp-1', projectId: 'proj-1', resourceTypeId: null, namedResourceId: 'nr-alice', ownerKind: 'NAMED_PERSON', source: 'MANUAL', planningBasis: 'AVAILABILITY_WINDOW' },
            { id: 'cp-2', projectId: 'proj-1', resourceTypeId: null, namedResourceId: 'nr-bob', ownerKind: 'PLANNED_RESOURCE', source: 'SQUAD_PLANNER', planningBasis: 'CAPACITY_PROFILE' },
          ])
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([
            { namedResourceId: 'nr-alice', ownerKind: 'NAMED_PERSON', source: 'MANUAL', planningBasis: 'AVAILABILITY_WINDOW' },
            { namedResourceId: 'nr-bob', ownerKind: 'PLANNED_RESOURCE', source: 'SQUAD_PLANNER', planningBasis: 'CAPACITY_PROFILE' },
          ]),
      },
      namedResource: {
        findMany: vi.fn().mockResolvedValue([
          { id: 'nr-alice', name: 'Alice', allocationMode: 'CAPACITY_PLAN' },
          { id: 'nr-bob', name: 'Bob', allocationMode: 'CAPACITY_PLAN' },
        ]),
      },
    })

    const result = await conflictPreflightCheck(tx as never, 'proj-1', [{
      periodIndex: 0,
      startWeek: 0,
      endWeek: 8,
      entries: [{ resourceTypeId: 'rt-dev', headcount: 3 }],
    }])

    expect(result).toBeUndefined()
  })

  it('fails on duplicate ROLE profiles', async () => {
    const tx = makeTx({
      capacityProfile: {
        findMany: vi.fn()
          .mockResolvedValueOnce([
            { id: 'cp-1', projectId: 'proj-1', resourceTypeId: 'rt-dev', namedResourceId: null, ownerKind: 'ROLE', source: 'SQUAD_PLANNER', planningBasis: 'CAPACITY_PROFILE' },
            { id: 'cp-2', projectId: 'proj-1', resourceTypeId: 'rt-dev', namedResourceId: null, ownerKind: 'ROLE', source: 'MANUAL', planningBasis: 'CAPACITY_PROFILE' },
          ])
          .mockResolvedValueOnce([{ id: 'cp-1' }, { id: 'cp-2' }])
          .mockResolvedValueOnce([]),
      },
      namedResource: {
        findMany: vi.fn().mockResolvedValue([]),
      },
    })

    const result = await conflictPreflightCheck(tx as never, 'proj-1', [{
      periodIndex: 0,
      startWeek: 0,
      endWeek: 4,
      entries: [{ resourceTypeId: 'rt-dev', headcount: 1 }],
    }])

    expect(result).toBeDefined()
    expect(result!.hasConflict).toBe(true)
    expect(result!.duplicateOwnerProfiles).toHaveLength(2)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// 2. findOrCreatePlannedResources — NAMED_PERSON excluded via isPlannerManaged
// ═════════════════════════════════════════════════════════════════════════════

describe('findOrCreatePlannedResources', () => {
  it('excludes NAMED_PERSON and returns planner-managed resources', async () => {
    const tx = {
      namedResource: {
        findMany: vi.fn()
          .mockResolvedValueOnce([
            { id: 'nr-alice', name: 'Alice', createdAt: new Date('2026-01-01'), allocationMode: 'CAPACITY_PLAN' },
            { id: 'nr-bob', name: 'Bob', createdAt: new Date('2026-01-02'), allocationMode: 'CAPACITY_PLAN' },
            { id: 'nr-carol', name: 'Carol', createdAt: new Date('2026-01-03'), allocationMode: 'CAPACITY_PLAN' },
          ])
          .mockResolvedValueOnce([
            { id: 'nr-alice', name: 'Alice', createdAt: new Date('2026-01-01'), allocationMode: 'CAPACITY_PLAN' },
            { id: 'nr-bob', name: 'Bob', createdAt: new Date('2026-01-02'), allocationMode: 'CAPACITY_PLAN' },
            { id: 'nr-carol', name: 'Carol', createdAt: new Date('2026-01-03'), allocationMode: 'CAPACITY_PLAN' },
            { id: 'nr-dev-4', name: 'Developer 4', createdAt: new Date('2026-07-01'), allocationMode: 'CAPACITY_PLAN' },
          ]),
        createMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      capacityProfile: {
        findMany: vi.fn()
          .mockResolvedValueOnce([
            { namedResourceId: 'nr-alice', ownerKind: 'NAMED_PERSON', source: 'MANUAL', planningBasis: 'AVAILABILITY_WINDOW' },
            { namedResourceId: 'nr-bob', ownerKind: 'PLANNED_RESOURCE', source: 'SQUAD_PLANNER', planningBasis: 'CAPACITY_PROFILE' },
            { namedResourceId: 'nr-carol', ownerKind: 'PLANNED_RESOURCE', source: 'SQUAD_PLANNER', planningBasis: 'CAPACITY_PROFILE' },
          ])
          .mockResolvedValueOnce([
            { namedResourceId: 'nr-alice', ownerKind: 'NAMED_PERSON', source: 'MANUAL', planningBasis: 'AVAILABILITY_WINDOW' },
            { namedResourceId: 'nr-bob', ownerKind: 'PLANNED_RESOURCE', source: 'SQUAD_PLANNER', planningBasis: 'CAPACITY_PROFILE' },
            { namedResourceId: 'nr-carol', ownerKind: 'PLANNED_RESOURCE', source: 'SQUAD_PLANNER', planningBasis: 'CAPACITY_PROFILE' },
            { namedResourceId: 'nr-dev-4', ownerKind: 'PLANNED_RESOURCE', source: 'SQUAD_PLANNER', planningBasis: 'CAPACITY_PROFILE' },
          ]),
      },
    }

    // Require 3 trajectories — only 2 planner resources (Bob, Carol)
    // → 1 new resource created
    const result = await findOrCreatePlannedResources(
      tx as never,
      'rt-dev',
      'Developer',
      3,
    )

    expect(result.namedResources).toHaveLength(3)
    expect(result.namedResources.map(nr => nr.name)).toEqual(['Bob', 'Carol', 'Developer 4'])
    expect(result.created).toBe(1)
  })

  it('returns only planner-managed resources when count is sufficient', async () => {
    const tx = {
      namedResource: {
        findMany: vi.fn()
          .mockResolvedValueOnce([
            { id: 'nr-alice', name: 'Alice', createdAt: new Date('2026-01-01'), allocationMode: 'TIMELINE' },
            { id: 'nr-bob', name: 'Bob', createdAt: new Date('2026-01-02'), allocationMode: 'TIMELINE' },
            { id: 'nr-carol', name: 'Carol', createdAt: new Date('2026-01-03'), allocationMode: 'CAPACITY_PLAN' },
          ])
          .mockResolvedValueOnce([
            { id: 'nr-alice', name: 'Alice', createdAt: new Date('2026-01-01'), allocationMode: 'TIMELINE' },
            { id: 'nr-bob', name: 'Bob', createdAt: new Date('2026-01-02'), allocationMode: 'TIMELINE' },
            { id: 'nr-carol', name: 'Carol', createdAt: new Date('2026-01-03'), allocationMode: 'CAPACITY_PLAN' },
          ]),
        createMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      capacityProfile: {
        findMany: vi.fn()
          .mockResolvedValueOnce([
            { namedResourceId: 'nr-alice', ownerKind: 'NAMED_PERSON', source: 'MANUAL', planningBasis: 'AVAILABILITY_WINDOW' },
            { namedResourceId: 'nr-bob', ownerKind: 'NAMED_PERSON', source: 'MANUAL', planningBasis: 'AVAILABILITY_WINDOW' },
            { namedResourceId: 'nr-carol', ownerKind: 'NAMED_PERSON', source: 'SQUAD_PLANNER', planningBasis: 'CAPACITY_PROFILE' },
          ])
          .mockResolvedValueOnce([
            { namedResourceId: 'nr-alice', ownerKind: 'NAMED_PERSON', source: 'MANUAL', planningBasis: 'AVAILABILITY_WINDOW' },
            { namedResourceId: 'nr-bob', ownerKind: 'NAMED_PERSON', source: 'MANUAL', planningBasis: 'AVAILABILITY_WINDOW' },
            { namedResourceId: 'nr-carol', ownerKind: 'NAMED_PERSON', source: 'SQUAD_PLANNER', planningBasis: 'CAPACITY_PROFILE' },
          ]),
      },
    }

    // Carol has an evidence-backed legacy planner profile and is adoptable.
    const result = await findOrCreatePlannedResources(
      tx as never,
      'rt-dev',
      'Developer',
      1,
    )

    expect(result.namedResources).toHaveLength(1)
    expect(result.namedResources[0].name).toBe('Carol')
    expect(result.created).toBe(0)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// 3. restoreSnapshotCommonState — orphan NR cleanup
// ═════════════════════════════════════════════════════════════════════════════

describe('restoreSnapshotCommonState', () => {
  it('deletes post-snapshot named resources while preserving snapshot NRs', async () => {
    const deleteMany = vi.fn().mockResolvedValue({ count: 2 })
    const findMany = vi.fn()
      .mockResolvedValueOnce([
        { id: 'nr-snap-1' },
        { id: 'nr-snap-2' },
        { id: 'nr-post-1' },
        { id: 'nr-post-2' },
      ])

    const tx = makeTx({
      namedResource: {
        findMany,
        deleteMany,
        upsert: vi.fn().mockResolvedValue({}),
      },
      resourceType: {
        findMany: vi.fn().mockResolvedValue([]),
        upsert: vi.fn().mockResolvedValue({}),
      },
    })

    const snapshotData: any = {
      resourceTypes: [],
      namedResources: [
        { id: 'nr-snap-1', name: 'Snapshot 1', resourceTypeId: 'rt-dev', startWeek: 0, endWeek: 10, allocationPct: 100, allocationMode: 'CAPACITY_PLAN', allocationPercent: 100, allocationStartWeek: null, allocationEndWeek: null, pricingModel: null },
        { id: 'nr-snap-2', name: 'Snapshot 2', resourceTypeId: 'rt-dev', startWeek: 0, endWeek: 10, allocationPct: 100, allocationMode: 'CAPACITY_PLAN', allocationPercent: 100, allocationStartWeek: null, allocationEndWeek: null, pricingModel: null },
      ],
      capacityPlans: [] as never[],
      capacityProfiles: [],
      epics: [],
      timelineEntries: [],
      storyTimelineEntries: [],
      epicDependencies: [],
      featureDependencies: [],
      overheadItems: [],
      project: null,
      discounts: [],
    }

    await restoreSnapshotCommonState(
      tx as never,
      'proj-1',
      snapshotData,
    )

    expect(findMany).toHaveBeenCalledWith({
      where: { resourceType: { projectId: 'proj-1' } },
      select: { id: true },
    })
    expect(deleteMany).toHaveBeenCalledTimes(1)
    expect(deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ['nr-post-1', 'nr-post-2'] } },
    })
    expect(tx.namedResource.upsert).toHaveBeenCalledTimes(2)
  })

  it('deletes all current named resources when snapshot has none', async () => {
    const deleteMany = vi.fn().mockResolvedValue({ count: 2 })
    const findMany = vi.fn().mockResolvedValue([
      { id: 'nr-post-1' },
      { id: 'nr-post-2' },
    ])
    const tx: Record<string, unknown> = makeTx({
      namedResource: {
        findMany,
        deleteMany,
        upsert: vi.fn().mockResolvedValue({}),
      },
      resourceType: {
        findMany: vi.fn().mockResolvedValue([]),
        upsert: vi.fn().mockResolvedValue({}),
      },
    })

    await restoreSnapshotCommonState(
      tx as never,
      'proj-1',
      {
        resourceTypes: [],
        namedResources: [],
        capacityPlans: [] as never[],
        capacityProfiles: [],
        epics: [],
        timelineEntries: [],
        storyTimelineEntries: [],
        epicDependencies: [],
        featureDependencies: [],
        overheadItems: [],
        project: null,
        discounts: [],
      } as never,
    )

    expect(findMany).toHaveBeenCalledWith({
      where: { resourceType: { projectId: 'proj-1' } },
      select: { id: true },
    })
    expect(deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ['nr-post-1', 'nr-post-2'] } },
    })
  })
})
