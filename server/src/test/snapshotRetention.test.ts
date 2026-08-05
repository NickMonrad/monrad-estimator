/**
 * snapshotRetention.test.ts — Retention protection for derived-quarantined
 * historical snapshots (issue #428, policy #426 Section 7).
 *
 * pruneSnapshots may delete ONLY snapshots positively classified as
 * restorable; the newest-20 cap applies to the restorable subset, so a
 * project may hold its normal retained restorable snapshots plus protected
 * quarantined or defective historical records. Classification failure keeps
 * the record (fail closed). Retention never rewrites snapshot content.
 */
import { describe, expect, it, vi } from 'vitest'
import { pruneSnapshots, type SnapshotDbLike } from '../lib/snapshotUtils.js'
import { QUARANTINE_CLASS_A_REASON } from '../lib/snapshotRestorability.js'

// ─── Fixtures ───────────────────────────────────────────────────────────────

/**
 * A windowless CAPACITY_PLAN snapshot that REMAINS quarantined (Class A):
 * issue #438 made only the EXACT all-windowless-100% shape restorable, so
 * this fixture uses a non-100 percentage — outside the approved predicate,
 * still quarantined (fail closed), still retention-protected.
 */
function v2WindowlessCapacityPlan(id: string) {
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
      allocationPercent: 80,
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

/**
 * The exact approved Class A snapshot shape (issue #438): every captured
 * entry windowless CAPACITY_PLAN at 100/100 with explicit modes — the
 * classifier verdicts it restorable, so retention may prune it like any
 * other restorable snapshot.
 */
function v2ExactClassASnapshot(id: string) {
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

const quarantined = (id: string) => record(id, v2WindowlessCapacityPlan(id))
const restorable = (id: string) => record(id, v4RestorableSnapshot(id))
const malformed = (id: string) => record(id, { schemaVersion: 99, epics: [] })

describe('pruneSnapshots — retention protection (issue #428)', () => {
  it('creating additional snapshots never deletes a quarantined historical snapshot', async () => {
    const records = [
      quarantined('q-1'),
      ...Array.from({ length: 25 }, (_, i) => restorable(`r-${String(i).padStart(2, '0')}`)),
    ]
    const { db, deleteMany } = makeDb(records)
    await pruneSnapshots(db, 'proj-1')
    const deletedIds = deleteMany.mock.calls[0]?.[0].where.id.in as string[]
    expect(deletedIds).toHaveLength(5) // 25 restorable − 20 cap
    expect(deletedIds).not.toContain('q-1')
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
    const records = [quarantined('q-1'), ...Array.from({ length: 22 }, (_, i) => restorable(`r-${i}`))]
    const { db, deleteMany } = makeDb(records)
    await pruneSnapshots(db, 'proj-1')
    // The only write-capable call is deleteMany; no update/upsert exists on the
    // minimal interface, and the payloads passed to findMany are untouched.
    expect(deleteMany).toHaveBeenCalledTimes(1)
    expect(records[0]!.snapshot).toEqual(v2WindowlessCapacityPlan('q-1'))
  })

  it('mixed restorable/quarantined ordering neither consumes nor bypasses the restorable cap', async () => {
    // Quarantined records are NEWER than the restorable ones: they must not
    // consume the 20-restorable cap, and the cap must still hold.
    const records = [
      quarantined('q-new-1'),
      quarantined('q-new-2'),
      ...Array.from({ length: 25 }, (_, i) => restorable(`r-${String(i).padStart(2, '0')}`)),
    ]
    const { db, deleteMany } = makeDb(records)
    await pruneSnapshots(db, 'proj-1')
    const deletedIds = deleteMany.mock.calls[0]?.[0].where.id.in as string[]
    expect(deletedIds).toHaveLength(5) // 25 restorable − 20 cap
    for (const id of deletedIds) expect(id.startsWith('r-')).toBe(true)
  })

  it('a project under the cap keeps everything', async () => {
    const records = [quarantined('q-1'), restorable('r-1'), restorable('r-2')]
    const { db, deleteMany } = makeDb(records)
    await pruneSnapshots(db, 'proj-1')
    expect(deleteMany).not.toHaveBeenCalled()
  })

  it('quarantined-only projects are never pruned', async () => {
    const records = Array.from({ length: 30 }, (_, i) => quarantined(`q-${i}`))
    const { db, deleteMany } = makeDb(records)
    await pruneSnapshots(db, 'proj-1')
    expect(deleteMany).not.toHaveBeenCalled()
  })

  it('exact Class A snapshots return to normal retention eligibility (issue #438)', async () => {
    // The EXACT all-windowless-100% shape is restorable now, so retention
    // prunes it like any other restorable snapshot — the amendment changes
    // eligibility only for the newly restorable shape.
    const records = [
      ...Array.from({ length: 25 }, (_, i) => restorable(`r-${String(i).padStart(2, '0')}`)),
      record('class-a-1', v2ExactClassASnapshot('class-a-1')),
    ]
    const { db, deleteMany } = makeDb(records)
    await pruneSnapshots(db, 'proj-1')
    const deletedIds = deleteMany.mock.calls[0]?.[0].where.id.in as string[]
    expect(deletedIds).toHaveLength(6) // 26 restorable − 20 cap
    expect(deletedIds).toContain('class-a-1')
  })

  it('the stable quarantine reason is exposed by the classifier used by retention', () => {
    // Guards the reason constant used in listing/rollback/readiness/remediation.
    expect(QUARANTINE_CLASS_A_REASON).toContain('non-restorable')
    expect(QUARANTINE_CLASS_A_REASON).toContain('Class A')
  })
})
