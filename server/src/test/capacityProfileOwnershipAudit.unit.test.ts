/**
 * capacityProfileOwnershipAudit.unit.test.ts — Pure unit tests for the
 * ownership-integrity audit and repair modules.
 *
 * Tests owner-key construction, shape classification, deterministic ordering,
 * exact legacy-state equality, segment equality, survivor selection,
 * identical v/s conflicting classification, and report formatting.
 */

import { describe, it, expect } from 'vitest'
import {
  buildOwnerKey,
  compareProfiles,
  compareSegments,
  legacyStatusEqual,
  profilesAreSemanticEqual,
  selectSurvivor,
  formatAuditReport,
  auditReportToJson,
  deepEqual,
  type AuditedProfile,
  type AuditReport,
  type LegacyNullStatus,
} from '../lib/capacityProfileOwnershipAudit.js'

// ─── Fixture helpers ─────────────────────────────────────────────────────────

function makeProfile(overrides: Partial<AuditedProfile> = {}): AuditedProfile {
  return {
    id: 'p-1',
    projectId: 'proj-1',
    resourceTypeId: 'rt-1',
    namedResourceId: null,
    ownerKind: 'ROLE',
    planningBasis: 'DEMAND_FOLLOWING',
    source: 'FIXED',
    defaultPercent: 100,
    startWeek: 0,
    endWeek: 10,
    legacyStatus: 'DB_NULL' as LegacyNullStatus,
    legacyValue: undefined,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    segments: [],
    ...overrides,
  }
}

// ─── Owner-key construction ──────────────────────────────────────────────────

describe('buildOwnerKey', () => {
  it('uses resourceTypeId when set', () => {
    expect(buildOwnerKey('rt-1', null)).toBe('resourceTypeId::rt-1')
  })

  it('uses namedResourceId when set', () => {
    expect(buildOwnerKey(null, 'nr-1')).toBe('namedResourceId::nr-1')
  })

  it('returns empty when both are null', () => {
    expect(buildOwnerKey(null, null)).toBe('')
  })

  it('prefers resourceTypeId when both are set', () => {
    expect(buildOwnerKey('rt-1', 'nr-1')).toBe('resourceTypeId::rt-1')
  })
})

// ─── Legacy status equality ─────────────────────────────────────────────────

describe('legacyStatusEqual', () => {
  it('equal statuses are equal', () => {
    expect(legacyStatusEqual('DB_NULL', 'DB_NULL')).toBe(true)
    expect(legacyStatusEqual('JSON_NULL', 'JSON_NULL')).toBe(true)
    expect(legacyStatusEqual('VALUE', 'VALUE')).toBe(true)
  })

  it('different statuses are not equal', () => {
    expect(legacyStatusEqual('DB_NULL', 'JSON_NULL')).toBe(false)
    expect(legacyStatusEqual('DB_NULL', 'VALUE')).toBe(false)
    expect(legacyStatusEqual('JSON_NULL', 'VALUE')).toBe(false)
  })
})

// ─── Segment comparison ─────────────────────────────────────────────────────

describe('compareSegments', () => {
  it('sorts by startWeek, endWeek, capacityPercent, source', () => {
    const segs = [
      { startWeek: 5, endWeek: 10, capacityPercent: 50, source: 'FIXED' },
      { startWeek: 0, endWeek: 4, capacityPercent: 100, source: 'FIXED' },
      { startWeek: 5, endWeek: 10, capacityPercent: 75, source: 'FIXED' },
      { startWeek: 5, endWeek: 10, capacityPercent: 50, source: 'MANUAL' },
    ]
    const sorted = [...segs].sort(compareSegments)
    expect(sorted[0].startWeek).toBe(0)
    expect(sorted[1].capacityPercent).toBe(50)
    expect(sorted[1].source).toBe('FIXED')
    expect(sorted[2].source).toBe('MANUAL')
    expect(sorted[3].capacityPercent).toBe(75)
  })
})

// ─── Profile comparison ordering ────────────────────────────────────────────

describe('compareProfiles', () => {
  it('orders by ownerKind, then resourceTypeId, then namedResourceId', () => {
    const a = makeProfile({ ownerKind: 'NAMED_PERSON', namedResourceId: 'nr-b', resourceTypeId: null })
    const b = makeProfile({ ownerKind: 'NAMED_PERSON', namedResourceId: 'nr-a', resourceTypeId: null })
    const c = makeProfile({ ownerKind: 'ROLE', resourceTypeId: 'rt-a', namedResourceId: null })
    const d = makeProfile({ ownerKind: 'ROLE', resourceTypeId: 'rt-b', namedResourceId: null })

    const sorted = [a, b, c, d].sort(compareProfiles)
    expect(sorted[0].ownerKind).toBe('NAMED_PERSON' as const)
    expect(sorted[0].namedResourceId).toBe('nr-a')
    expect(sorted[1].namedResourceId).toBe('nr-b')
    expect(sorted[2].resourceTypeId).toBe('rt-a')
    expect(sorted[3].resourceTypeId).toBe('rt-b')
  })
})

// ─── Semantic equality ──────────────────────────────────────────────────────

describe('profilesAreSemanticEqual', () => {
  it('identical profiles are equal', () => {
    const a = makeProfile()
    const b = makeProfile({ id: 'p-2', createdAt: new Date('2026-02-01T00:00:00Z') })
    expect(profilesAreSemanticEqual(a, b)).toBe(true)
  })

  it('different projectId is not equal', () => {
    expect(profilesAreSemanticEqual(
      makeProfile({ projectId: 'proj-1' }),
      makeProfile({ projectId: 'proj-2' }),
    )).toBe(false)
  })

  it('different resourceTypeId is not equal', () => {
    expect(profilesAreSemanticEqual(
      makeProfile({ resourceTypeId: 'rt-1' }),
      makeProfile({ resourceTypeId: 'rt-2' }),
    )).toBe(false)
  })

  it('different ownerKind is not equal', () => {
    expect(profilesAreSemanticEqual(
      makeProfile({ ownerKind: 'ROLE' }),
      makeProfile({ ownerKind: 'NAMED_PERSON', resourceTypeId: null, namedResourceId: 'nr-1' }),
    )).toBe(false)
  })

  it('different planningBasis is not equal', () => {
    expect(profilesAreSemanticEqual(
      makeProfile({ planningBasis: 'DEMAND_FOLLOWING' }),
      makeProfile({ planningBasis: 'AVAILABILITY_WINDOW' }),
    )).toBe(false)
  })

  it('different source is not equal', () => {
    expect(profilesAreSemanticEqual(
      makeProfile({ source: 'FIXED' }),
      makeProfile({ source: 'MANUAL' }),
    )).toBe(false)
  })

  it('different defaultPercent is not equal', () => {
    expect(profilesAreSemanticEqual(
      makeProfile({ defaultPercent: 100 }),
      makeProfile({ defaultPercent: 50 }),
    )).toBe(false)
  })

  it('different legacyStatus is not equal', () => {
    expect(profilesAreSemanticEqual(
      makeProfile({ legacyStatus: 'DB_NULL' }),
      makeProfile({ legacyStatus: 'JSON_NULL' }),
    )).toBe(false)
  })

  it('different segments are not equal', () => {
    expect(profilesAreSemanticEqual(
      makeProfile({ segments: [{ startWeek: 0, endWeek: 4, capacityPercent: 100, source: 'FIXED' }] }),
      makeProfile({ segments: [{ startWeek: 0, endWeek: 4, capacityPercent: 50, source: 'FIXED' }] }),
    )).toBe(false)
  })

  it('ignores id differences', () => {
    expect(profilesAreSemanticEqual(
      makeProfile({ id: 'p-1' }),
      makeProfile({ id: 'p-2' }),
    )).toBe(true)
  })

  it('ignores createdAt differences', () => {
    expect(profilesAreSemanticEqual(
      makeProfile({ createdAt: new Date('2026-01-01') }),
      makeProfile({ createdAt: new Date('2026-06-01') }),
    )).toBe(true)
  })
})

describe('deepEqual', () => {
  it('identical primitives are equal', () => {
    expect(deepEqual(1, 1)).toBe(true)
    expect(deepEqual('a', 'a')).toBe(true)
    expect(deepEqual(true, true)).toBe(true)
    expect(deepEqual(null, null)).toBe(true)
  })

  it('different primitives are not equal', () => {
    expect(deepEqual(1, 2)).toBe(false)
    expect(deepEqual('a', 'b')).toBe(false)
    expect(deepEqual(true, false)).toBe(false)
    expect(deepEqual(null, undefined)).toBe(false)
  })

  it('identical objects are equal', () => {
    expect(deepEqual({ a: 1, b: { c: 2 } }, { a: 1, b: { c: 2 } })).toBe(true)
    expect(deepEqual({ a: null }, { a: null })).toBe(true)
  })

  it('different objects are not equal', () => {
    expect(deepEqual({ a: 1 }, { a: 2 })).toBe(false)
    expect(deepEqual({ a: 1 }, { b: 1 })).toBe(false)
    expect(deepEqual({ a: { b: 1 } }, { a: { b: 2 } })).toBe(false)
  })

  it('identical arrays are equal', () => {
    expect(deepEqual([1, 2, 3], [1, 2, 3])).toBe(true)
    expect(deepEqual([], [])).toBe(true)
  })

  it('different arrays are not equal', () => {
    expect(deepEqual([1, 2], [1, 2, 3])).toBe(false)
    expect(deepEqual([1, 2], [2, 1])).toBe(false)
  })
})

describe('Profiles with legacy JSON VALUE differences', () => {
  it('different JSON legacy values are conflicting duplicates', () => {
    const a = makeProfile({
      legacyStatus: 'VALUE' as LegacyNullStatus,
      legacyValue: { allocationMode: 'TIMELINE', allocationPercent: 80 },
    })
    const b = makeProfile({
      id: 'p-2',
      legacyStatus: 'VALUE' as LegacyNullStatus,
      legacyValue: { allocationMode: 'FULL_PROJECT', allocationPercent: 100 },
    })
    expect(profilesAreSemanticEqual(a, b)).toBe(false)
  })

  it('equivalent JSON legacy values are repairable', () => {
    const a = makeProfile({
      legacyStatus: 'VALUE' as LegacyNullStatus,
      legacyValue: { allocationMode: 'TIMELINE', allocationPercent: 80 },
    })
    const b = makeProfile({
      id: 'p-2',
      legacyStatus: 'VALUE' as LegacyNullStatus,
      legacyValue: { allocationMode: 'TIMELINE', allocationPercent: 80 },
    })
    expect(profilesAreSemanticEqual(a, b)).toBe(true)
  })

  it('equivalent deeply nested JSON is equal', () => {
    const a = makeProfile({
      legacyStatus: 'VALUE' as LegacyNullStatus,
      legacyValue: { nested: { deep: { value: 42, items: [1, 2] } } },
    })
    const b = makeProfile({
      id: 'p-2',
      legacyStatus: 'VALUE' as LegacyNullStatus,
      legacyValue: { nested: { deep: { value: 42, items: [1, 2] } } },
    })
    expect(profilesAreSemanticEqual(a, b)).toBe(true)
  })

  it('SQL null and JSON null are not equal', () => {
    const a = makeProfile({
      legacyStatus: 'DB_NULL' as LegacyNullStatus,
    })
    const b = makeProfile({
      id: 'p-2',
      legacyStatus: 'JSON_NULL' as LegacyNullStatus,
    })
    expect(profilesAreSemanticEqual(a, b)).toBe(false)
  })
})
// ─── Survivor selection ─────────────────────────────────────────────────────

describe('selectSurvivor', () => {
  it('selects earliest createdAt', () => {
    const profiles = [
      makeProfile({ id: 'p-late', createdAt: new Date('2026-06-01T00:00:00Z') }),
      makeProfile({ id: 'p-early', createdAt: new Date('2026-01-01T00:00:00Z') }),
      makeProfile({ id: 'p-mid', createdAt: new Date('2026-03-01T00:00:00Z') }),
    ]
    const survivor = selectSurvivor(profiles)
    expect(survivor.id).toBe('p-early')
  })

  it('uses lexical id tie-breaker when createdAt matches', () => {
    const date = new Date('2026-01-01T00:00:00Z')
    const profiles = [
      makeProfile({ id: 'p-z', createdAt: date }),
      makeProfile({ id: 'p-a', createdAt: date }),
      makeProfile({ id: 'p-m', createdAt: date }),
    ]
    const survivor = selectSurvivor(profiles)
    expect(survivor.id).toBe('p-a')
  })
})

// ─── Identical vs conflicting classification ─────────────────────────────────

describe('formatAuditReport', () => {
  it('produces clean report when no findings', () => {
    const report: AuditReport = {
      totalProfiles: 5,
      findings: [],
      repairableGroups: [],
      conflictingGroups: [],
      validSingletons: 5,
      isClean: true,
    }
    const output = formatAuditReport(report)
    expect(output).toContain('clean')
    expect(output).toContain('No findings')
  })

  it('includes error findings', () => {
    const report: AuditReport = {
      totalProfiles: 1,
      findings: [{
        type: 'both_owner_fks_set',
        severity: 'error',
        message: 'both FKs set',
        profileIds: ['p-1'],
      }],
      repairableGroups: [],
      conflictingGroups: [],
      validSingletons: 0,
      isClean: false,
    }
    const output = formatAuditReport(report)
    expect(output).toContain('both_owner_fks_set')
    expect(output).toContain('NOT clean')
  })

  it('includes repairable groups', () => {
    const report: AuditReport = {
      totalProfiles: 2,
      findings: [{
        type: 'identical_duplicate_group',
        severity: 'warning',
        message: 'Identical duplicate group',
        profileIds: ['p-1', 'p-2'],
      }],
      repairableGroups: [{
        profiles: [
          makeProfile({ id: 'p-1', createdAt: new Date('2026-01-01') }),
          makeProfile({ id: 'p-2', createdAt: new Date('2026-02-01') }),
        ],
        isIdentical: true,
        note: 'Identical duplicates',
      }],
      conflictingGroups: [],
      validSingletons: 0,
      isClean: false,
    }
    const output = formatAuditReport(report)
    expect(output).toContain('Repairable groups')
    expect(output).toContain('Survivor: p-1')
    expect(output).toContain('Redundant: p-2')
  })
})

describe('auditReportToJson', () => {
  it('produces valid JSON with expected shape', () => {
    const report: AuditReport = {
      totalProfiles: 1,
      findings: [{
        type: 'both_owner_fks_set',
        severity: 'error',
        message: 'test',
        profileIds: ['p-1'],
      }],
      repairableGroups: [],
      conflictingGroups: [],
      validSingletons: 0,
      isClean: false,
    }
    const json = auditReportToJson(report)
    const parsed = JSON.parse(json)
    expect(parsed.totalProfiles).toBe(1)
    expect(parsed.isClean).toBe(false)
    expect(parsed.findings).toHaveLength(1)
    expect(parsed.findings[0].type).toBe('both_owner_fks_set')
    expect(parsed.repairableGroups).toHaveLength(0)
  })
})
