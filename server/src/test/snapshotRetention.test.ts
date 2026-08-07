/**
 * snapshotRetention.test.ts — Retention protection under the issue #444
 * V4-minimum policy.
 *
 * pruneSnapshots may delete ONLY snapshots positively classified as
 * restorable (structurally valid V4); the newest-20 cap applies to the
 * restorable subset only. Every pre-V4 (V1/V2/V3) snapshot and every
 * malformed/unclassifiable record is protected from automatic retention —
 * deliberate removal happens exclusively through the reviewed pre-V4 purge
 * command (issue #444). Retention never rewrites snapshot content.
 */
import { describe, expect, it, vi } from 'vitest'
import { pruneSnapshots, type SnapshotDbLike } from '../lib/snapshotUtils.js'
import { RETIREMENT_REASON } from '../lib/snapshotRestorability.js'

// ─── Fixtures ───────────────────────────────────────────────────────────────

/** A V2 snapshot — whatever its historical shape, it is retired and must
 * never be deleted by automatic retention (purge-only removal). */
function v2LegacySnapshot(id: string) {
  return {
    schemaVersion: 2,
    epics: [],
    project: null,
    resourceTypes: [{
      id: `rt-${id}`,
      name: `Role ${id}`,
      category: 'ENGINEERING',
      count: 1,
      hoursPerDay: null,
      dayRate: null,
      globalTypeId: null,
      allocationMode: 'CAPACITY_PLAN',
      allocationPercent: 100,
      allocationStartWeek: null,
      allocationEndWeek: null,
    }],
    namedResources: [],
    timelineEntries: [],
    storyTimelineEntries: [],
    epicDependencies: [],
    featureDependencies: [],
    overheadItems: [],
  }
}

function v4RestorableSnapshot(id: string) {
  return {
    schemaVersion: 4,
    epics: [],
    project: null,
    resourceTypes: [{
      id: `rt-${id}`,
      name: `Role ${id}`,
      category: 'ENGINEERING',
      count: 1,
      hoursPerDay: null,
      dayRate: null,
      globalTypeId: null,
    }],
    namedResources: [],
    timelineEntries: [],
    storyTimelineEntries: [],
    epicDependencies: [],
    featureDependencies: [],
    overheadItems: [],
    capacityProfiles: [],
    capacityPlans: [],
  }
}

function makeDb(records: Array<{ id: string; snapshot: unknown }>) {
  const deleteMany = vi.fn().mockResolvedValue({ count: 0 })
  const db: SnapshotDbLike = {
    backlogSnapshot: {
      findMany: vi.fn().mockResolvedValue(records),
      deleteMany,
    },
  }
  return { db, deleteMany }
}

function record(id: string, snapshot: unknown) {
  return { id, snapshot }
}

const legacy = (id: string) => record(id, v2LegacySnapshot(id))
const restorable = (id: string) => record(id, v4RestorableSnapshot(id))
const malformed = (id: string) => record(id, { schemaVersion: 99, epics: [] })

describe('pruneSnapshots — retention protection (issue #444)', () => {
  it('creating additional snapshots never deletes a pre-V4 historical snapshot', async () => {
    const records = [
      legacy('legacy-1'),
      ...Array.from({ length: 25 }, (_, i) => restorable(`r-${String(i).padStart(2, '0')}`)),
    ]
    const { db, deleteMany } = makeDb(records)
    await pruneSnapshots(db, 'proj-1')
    const deletedIds = deleteMany.mock.calls[0]?.[0].where.id.in as string[]
    expect(deletedIds).toHaveLength(5) // 25 restorable − 20 cap
    expect(deletedIds).not.toContain('legacy-1')
    // The raw record was never rewritten: only a deleteMany is issued.
    expect(deleteMany).toHaveBeenCalledTimes(1)
  })

  it('ordinary restorable-snapshot retention still keeps the newest 20', async () => {
    const records = Array.from({ length: 23 }, (_, i) => restorable(`r-${String(i).padStart(2, '0')}`))
    const { db, deleteMany } = makeDb(records)
    await pruneSnapshots(db, 'proj-1')
    const deletedIds = deleteMany.mock.calls[0]?.[0].where.id.in as string[]
    expect(deletedIds).toHaveLength(3)
    // Newest first: the three oldest (r-20, r-21, r-22) are deleted.
    expect(deletedIds).toEqual(['r-20', 'r-21', 'r-22'])
  })

  it('a malformed or unclassifiable snapshot is preserved (fail closed)', async () => {
    const records = [
      malformed('bad-1'),
      ...Array.from({ length: 25 }, (_, i) => restorable(`r-${String(i).padStart(2, '0')}`)),
    ]
    const { db, deleteMany } = makeDb(records)
    await pruneSnapshots(db, 'proj-1')
    const deletedIds = deleteMany.mock.calls[0]?.[0].where.id.in as string[]
    expect(deletedIds).toHaveLength(5)
    expect(deletedIds).not.toContain('bad-1')
  })

  it('pruning never rewrites snapshot content (findMany reads, deleteMany deletes, nothing else)', async () => {
    const records = [legacy('legacy-1'), ...Array.from({ length: 22 }, (_, i) => restorable(`r-${i}`))]
    const { db, deleteMany } = makeDb(records)
    await pruneSnapshots(db, 'proj-1')
    // The only write-capable call is deleteMany; no update/upsert exists on the
    // minimal interface, and the payloads passed to findMany are untouched.
    expect(deleteMany).toHaveBeenCalledTimes(1)
    expect(records[0]!.snapshot).toEqual(v2LegacySnapshot('legacy-1'))
  })

  it('mixed restorable/legacy ordering neither consumes nor bypasses the restorable cap', async () => {
    // Pre-V4 records are NEWER than the restorable ones: they must not
    // consume the 20-restorable cap, and the cap must still hold.
    const records = [
      legacy('legacy-new-1'),
      legacy('legacy-new-2'),
      ...Array.from({ length: 25 }, (_, i) => restorable(`r-${String(i).padStart(2, '0')}`)),
    ]
    const { db, deleteMany } = makeDb(records)
    await pruneSnapshots(db, 'proj-1')
    const deletedIds = deleteMany.mock.calls[0]?.[0].where.id.in as string[]
    expect(deletedIds).toHaveLength(5) // 25 restorable − 20 cap
    for (const id of deletedIds) expect(id.startsWith('r-')).toBe(true)
  })

  it('a project under the cap keeps everything', async () => {
    const records = [legacy('legacy-1'), restorable('r-1'), restorable('r-2')]
    const { db, deleteMany } = makeDb(records)
    await pruneSnapshots(db, 'proj-1')
    expect(deleteMany).not.toHaveBeenCalled()
  })

  it('legacy-only projects are never pruned', async () => {
    const records = Array.from({ length: 30 }, (_, i) => legacy(`legacy-${i}`))
    const { db, deleteMany } = makeDb(records)
    await pruneSnapshots(db, 'proj-1')
    expect(deleteMany).not.toHaveBeenCalled()
  })

  it('every pre-V4 version (v1/v2/v3) is retention-protected', async () => {
    const records = [
      record('v1-1', [{ id: 'e1', name: 'Epic', features: [] }]),
      record('v3-1', { schemaVersion: 3, epics: [], project: null, resourceTypes: [], namedResources: [], timelineEntries: [], storyTimelineEntries: [], epicDependencies: [], featureDependencies: [], overheadItems: [], capacityProfiles: [] }),
      ...Array.from({ length: 25 }, (_, i) => restorable(`r-${String(i).padStart(2, '0')}`)),
    ]
    const { db, deleteMany } = makeDb(records)
    await pruneSnapshots(db, 'proj-1')
    const deletedIds = deleteMany.mock.calls[0]?.[0].where.id.in as string[]
    expect(deletedIds).toHaveLength(5)
    expect(deletedIds).not.toContain('v1-1')
    expect(deletedIds).not.toContain('v3-1')
  })

  it('the stable retirement reason is exposed by the classifier used by retention', () => {
    // Guards the reason constant used in listing/rollback/readiness.
    expect(RETIREMENT_REASON).toContain('no longer restorable')
    expect(RETIREMENT_REASON).toContain('V4 is the minimum supported snapshot version')
  })
})
