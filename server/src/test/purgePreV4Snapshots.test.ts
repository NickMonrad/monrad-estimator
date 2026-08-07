/**
 * purgePreV4Snapshots.test.ts — Unit tests for the issue #444 pre-V4
 * BacklogSnapshot purge module (no database; mock client).
 *
 * Coverage:
 *   - dry-run reports V1/V2/V3/V4/malformed counts and performs zero writes;
 *   - apply deletes ONLY positively-classified V1/V2/V3 rows;
 *   - apply preserves every V4 snapshot;
 *   - malformed/unsupported input aborts the entire apply with zero deletion;
 *   - empty database is a no-op;
 *   - the rendered report is aggregate-only (no identifiers or payloads).
 */
import { describe, expect, it, vi } from 'vitest'
import {
  purgePreV4Snapshots,
  formatPurgeReport,
  type PreV4PurgeReport,
  type PurgeSnapshotDb,
} from '../lib/purgePreV4Snapshots.js'

// ─── Fixtures ───────────────────────────────────────────────────────────────

const v1 = (id: string) => ({ id, snapshot: [{ id: 'e1', name: 'Epic', features: [] }] })
const v2 = (id: string) => ({
  id,
  snapshot: {
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
  },
})
const v3 = (id: string) => ({
  id,
  snapshot: {
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
  },
})
const v4 = (id: string) => ({
  id,
  snapshot: {
    schemaVersion: 4,
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
  },
})
const malformed = (id: string) => ({ id, snapshot: { schemaVersion: 99, epics: [] } })

function makeDb(records: Array<{ id: string; snapshot: unknown }>) {
  const deleteMany = vi.fn().mockResolvedValue({ count: 0 })
  const db: PurgeSnapshotDb = {
    backlogSnapshot: {
      findMany: vi.fn().mockResolvedValue(records),
      deleteMany,
    },
  }
  return { db, deleteMany }
}

function countsOf(report: PreV4PurgeReport) {
  return report.before
}

// ─── Dry run ────────────────────────────────────────────────────────────────

describe('purgePreV4Snapshots — dry run', () => {
  it('reports V1/V2/V3/V4 counts correctly and performs zero deletes', async () => {
    const records = [v1('s-1'), v2('s-2'), v3('s-3'), v4('s-4'), v4('s-5')]
    const { db, deleteMany } = makeDb(records)
    const report = await purgePreV4Snapshots(db, { apply: false })

    expect(report.dryRun).toBe(true)
    expect(report.deletedCount).toBe(0)
    expect(report.aborted).toBe(false)
    expect(countsOf(report)).toEqual({ v1: 1, v2: 1, v3: 1, v4: 2, malformed: 0 })
    expect(report.after).toEqual(report.before)
    expect(deleteMany).not.toHaveBeenCalled()
  })

  it('counts malformed rows separately', async () => {
    const records = [v2('s-1'), malformed('s-bad')]
    const { db, deleteMany } = makeDb(records)
    const report = await purgePreV4Snapshots(db, { apply: false })
    expect(countsOf(report)).toEqual({ v1: 0, v2: 1, v3: 0, v4: 0, malformed: 1 })
    expect(deleteMany).not.toHaveBeenCalled()
  })

  it('an empty database reports all-zero counts without writes', async () => {
    const { db, deleteMany } = makeDb([])
    const report = await purgePreV4Snapshots(db, { apply: false })
    expect(countsOf(report)).toEqual({ v1: 0, v2: 0, v3: 0, v4: 0, malformed: 0 })
    expect(deleteMany).not.toHaveBeenCalled()
  })

  it('the dry-run report renders aggregate counts only (no identifiers, payloads or credentials)', async () => {
    const records = [
      { id: 'snap-secret-id-1', snapshot: { schemaVersion: 2, epics: [], project: null, resourceTypes: [], namedResources: [], timelineEntries: [], storyTimelineEntries: [], epicDependencies: [], featureDependencies: [], overheadItems: [] } },
      { id: 'snap-secret-id-2', snapshot: { schemaVersion: 4, epics: [], project: null, resourceTypes: [], namedResources: [], timelineEntries: [], storyTimelineEntries: [], epicDependencies: [], featureDependencies: [], overheadItems: [], capacityProfiles: [] } },
    ]
    const { db } = makeDb(records)
    const report = await purgePreV4Snapshots(db, { apply: false })
    const text = formatPurgeReport(report)
    expect(text).toContain('V1 BacklogSnapshots: 0')
    expect(text).toContain('V2 BacklogSnapshots: 1')
    expect(text).toContain('V4 BacklogSnapshots: 1')
    expect(text).not.toContain('snap-secret-id-1')
    expect(text).not.toContain('snap-secret-id-2')
    expect(text).not.toContain('schemaVersion')
    expect(text).not.toContain('postgres')
  })
})

// ─── Apply ──────────────────────────────────────────────────────────────────

describe('purgePreV4Snapshots — apply', () => {
  it('deletes V1/V2/V3 only and preserves every V4 snapshot', async () => {
    const records = [v1('s-v1'), v2('s-v2'), v3('s-v3'), v4('s-v4a'), v4('s-v4b')]
    const { db, deleteMany } = makeDb(records)
    deleteMany.mockResolvedValue({ count: 3 })
    const report = await purgePreV4Snapshots(db, { apply: true })

    expect(report.dryRun).toBe(false)
    expect(report.aborted).toBe(false)
    expect(report.deletedCount).toBe(3)
    expect(report.before).toEqual({ v1: 1, v2: 1, v3: 1, v4: 2, malformed: 0 })
    expect(report.after).toEqual({ v1: 0, v2: 0, v3: 0, v4: 2, malformed: 0 })
    // Only the positively-classified V1/V2/V3 ids were addressed.
    const deletedIds = deleteMany.mock.calls[0]?.[0].where.id.in as string[]
    expect([...deletedIds].sort()).toEqual(['s-v1', 's-v2', 's-v3'].sort())
    expect(deleteMany).toHaveBeenCalledTimes(1)
  })

  it('never deletes V4 — a V4-only database is a no-op delete', async () => {
    const records = [v4('s-v4a'), v4('s-v4b')]
    const { db, deleteMany } = makeDb(records)
    const report = await purgePreV4Snapshots(db, { apply: true })
    expect(report.deletedCount).toBe(0)
    expect(report.after.v4).toBe(2)
    expect(deleteMany).not.toHaveBeenCalled()
  })

  it('malformed/unsupported input aborts the entire apply with zero deletion', async () => {
    const records = [v2('s-ok'), v4('s-v4'), malformed('s-bad')]
    const { db, deleteMany } = makeDb(records)
    const report = await purgePreV4Snapshots(db, { apply: true })

    expect(report.aborted).toBe(true)
    expect(report.deletedCount).toBe(0)
    expect(report.after).toEqual(report.before)
    expect(report.abortReason).toContain('malformed/unsupported')
    expect(deleteMany).not.toHaveBeenCalled()
  })

  it('a valid apply report renders before/after counts without identifiers', async () => {
    const records = [v1('s-1'), v2('s-2'), v4('s-4')]
    const { db, deleteMany } = makeDb(records)
    deleteMany.mockResolvedValue({ count: 2 })
    const report = await purgePreV4Snapshots(db, { apply: true })
    const text = formatPurgeReport(report)
    expect(text).toContain('Deleted V1/V2/V3 BacklogSnapshots: 2')
    expect(text).toContain('V1 BacklogSnapshots: 0')
    expect(text).toContain('V4 BacklogSnapshots: 1')
    expect(text).not.toContain('s-1')
    expect(text).not.toContain('s-2')
    expect(text).not.toContain('s-4')
  })

  it('an aborted apply renders the failure without identifiers', async () => {
    const records = [v2('s-1'), malformed('s-bad')]
    const { db } = makeDb(records)
    const report = await purgePreV4Snapshots(db, { apply: true })
    const text = formatPurgeReport(report)
    expect(text).toContain('ABORTED')
    expect(text).toContain('Deleted: 0')
    expect(text).not.toContain('s-bad')
    expect(text).not.toContain('s-1')
  })
})
