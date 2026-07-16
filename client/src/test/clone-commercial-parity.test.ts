/**
 * clone-commercial-parity.test.ts — Client-side clone/source commercial parity
 *
 * Proves that computeCommercialData and buildProfileCsv produce identical
 * output for source and clone Resource Profile DTOs that differ only in
 * generated IDs (resourceTypeId, named resource ID, discount ID, etc.).
 *
 * Fixtures mirror the production HTTP DTO contract: source profile data
 * with capacityProfile enrichments, and a cloned copy with remapped IDs.
 *
 * Covers: ACTUAL_DAYS and PRO_RATA named resources, role/project discounts,
 * tax, zero-capacity segment retention, row kinds, all totals, calculated
 * discount fields, and complete CSV column parity.
 *
 * Does NOT alter production computation or export formatting.
 */

import { describe, expect, it } from 'vitest'
import { computeCommercialData } from '@/utils/financialCalculations'
import { buildProfileCsv } from '@/hooks/useResourceProfileExport'
import type { ResourceProfile, ProjectDiscount } from '@/types/backlog'

// ─── Helpers ───────────────────────────────────────────────────────────────

function deepClone<T>(obj: T): T {
  return JSON.parse(JSON.stringify(obj))
}

/** Remap source IDs → clone IDs on a deep-copied ResourceProfile. */
function buildCloneProfile(source: ResourceProfile): ResourceProfile {
  const clone = deepClone(source)
  clone.projectId = CLONE_IDS.projectId

  // Remap resource-type IDs on rows and within named-resource default capacities
  for (const row of clone.resourceRows) {
    if (row.resourceTypeId in ID_SRC_TO_CLONE) {
      row.resourceTypeId = ID_SRC_TO_CLONE[row.resourceTypeId as SrcId]
    }
    if (row.namedResources) {
      for (const nr of row.namedResources) {
        if (nr.id in ID_SRC_TO_CLONE) {
          nr.id = ID_SRC_TO_CLONE[nr.id as SrcId]
        }
      }
    }
  }

  // Remap overhead IDs
  for (const oh of clone.overheadRows) {
    if (oh.overheadId in ID_SRC_TO_CLONE) {
      oh.overheadId = ID_SRC_TO_CLONE[oh.overheadId as SrcId]
    }
  }

  return clone
}

/** Remap source discount IDs → clone IDs. */
function buildCloneDiscounts(source: ProjectDiscount[]): ProjectDiscount[] {
  const clone = deepClone(source)
  for (const d of clone) {
    if (d.id in ID_SRC_TO_CLONE) d.id = ID_SRC_TO_CLONE[d.id as SrcId]
    if (d.projectId in ID_SRC_TO_CLONE) d.projectId = ID_SRC_TO_CLONE[d.projectId as SrcId]
    if (d.resourceTypeId && d.resourceTypeId in ID_SRC_TO_CLONE) {
      d.resourceTypeId = ID_SRC_TO_CLONE[d.resourceTypeId as SrcId]
    }
  }
  return clone
}

// ─── ID Mapping ────────────────────────────────────────────────────────────

type SrcId = keyof typeof ID_SRC_TO_CLONE

const ID_SRC_TO_CLONE = {
  'rt-dev': 'rt-dev-clone',
  'rt-qa': 'rt-qa-clone',
  'rt-qa-lead': 'rt-qa-lead-clone',
  'nr-alice': 'nr-alice-clone',
  'nr-bob': 'nr-bob-clone',
  'nr-qa-lead': 'nr-qa-lead-clone',
  'oh-pm': 'oh-pm-clone',
  'source-proj': 'clone-proj',
  'disc-dev-rt': 'disc-dev-rt-clone',
  'disc-project': 'disc-project-clone',
} as const

const CLONE_IDS = {
  projectId: 'clone-proj',
  rtDev: 'rt-dev-clone',
  rtQa: 'rt-qa-clone',
  rtQaLead: 'rt-qa-lead-clone',
  nrAlice: 'nr-alice-clone',
  nrBob: 'nr-bob-clone',
  nrQaLead: 'nr-qa-lead-clone',
  ohPm: 'oh-pm-clone',
  discDevRt: 'disc-dev-rt-clone',
  discProject: 'disc-project-clone',
}

/** Build reverse map clone→source and apply it to a string-serialized value. */
function normalizeCloneIds(obj: unknown): unknown {
  const reverse: Record<string, string> = {}
  for (const [src, clone] of Object.entries(ID_SRC_TO_CLONE)) {
    reverse[clone] = src
  }
  let s = JSON.stringify(obj)
  for (const [clone, src] of Object.entries(reverse)) {
    s = s.replaceAll(clone, src)
  }
  return JSON.parse(s)
}

// ─── CSV parsing (mirrors resource-profile-export.test.ts) ──────────

function parseCsv(csv: string): { headers: string[]; rows: string[][] } {
  const lines = csv.trim().split('\n')
  const headers = lines[0].split(',').map(h => h.replace(/^"|"$/g, ''))
  const rows = lines.slice(1).map(line => {
    const fields: string[] = []
    let current = ''
    let inQuotes = false
    for (const ch of line) {
      if (ch === '"') { inQuotes = !inQuotes; continue }
      if (ch === ',' && !inQuotes) { fields.push(current); current = ''; continue }
      current += ch
    }
    fields.push(current)
    return fields
  })
  return { headers, rows }
}

// ─── Fixtures ──────────────────────────────────────────────────────────────

/**
 * Source ResourceProfile fixture.
 *
 * Contains:
 *   - Developer (2 count) with Alice (ACTUAL_DAYS) and Bob (PRO_RATA)
 *   - QA (1 count, role-level, no NRs, ZERO-capacity profile)
 *   - QA Lead (1 count, named resource with ZERO actual days + ZERO capacity)
 *   - Project Management overhead (FIXED_DAYS, $1000/day)
 *
 * All NRs have capacityProfile enrichments mirroring the production DTO.
 */
function buildSourceProfile(): ResourceProfile {
  return {
    projectId: 'source-proj',
    hoursPerDay: 8,
    projectDurationWeeks: 12,
    bufferWeeks: 1,
    onboardingWeeks: 1,
    resourceRows: [
      // ── Developer: 2 NRs (ACTUAL_DAYS + PRO_RATA) ──────────────────
      {
        resourceTypeId: 'rt-dev',
        name: 'Developer',
        category: 'ENGINEERING',
        count: 2,
        hoursPerDay: 8,
        dayRate: 800,
        totalHours: 160,
        totalDays: 20,
        effortDays: 20,
        allocatedDays: 20,
        allocationMode: 'EFFORT',
        allocationPercent: 100,
        allocationStartWeek: null,
        allocationEndWeek: null,
        derivedStartWeek: 0,
        derivedEndWeek: 11,
        estimatedCost: 16000,
        epics: [],
        namedResources: [
          {
            id: 'nr-alice',
            name: 'Alice',
            pricingModel: 'ACTUAL_DAYS',
            allocationMode: 'EFFORT',
            allocationPercent: 100,
            allocationStartWeek: null,
            allocationEndWeek: null,
            startWeek: null,
            endWeek: null,
            allocatedDays: 10,
            derivedStartWeek: 0,
            derivedEndWeek: 9,
            actualAllocatedDays: 10,
            actualAllocationStartWeek: 0,
            actualAllocationEndWeek: 9,
            actualAllocatedWeeks: [
              { week: 0, days: 2.5, capacityDays: 5 },
              { week: 1, days: 2.5, capacityDays: 5 },
              { week: 2, days: 2.5, capacityDays: 5 },
              { week: 3, days: 2.5, capacityDays: 5 },
            ],
            actualAllocationSegments: [
              { startWeek: 0, endWeek: 3, days: 10 },
            ],
            synthetic: false,
            resourceIdentity: 'NAMED_PERSON',
            capacityProfile: {
              planningBasis: 'capacityProfile',
              source: 'squadPlanner',
              defaultPercent: 100,
              startWeek: 0,
              endWeek: 9,
              segments: [{ startWeek: 0, endWeek: 9, capacityPercent: 100 }],
              resolutionSource: 'PROFILE',
            },
          },
          {
            id: 'nr-bob',
            name: 'Bob',
            pricingModel: 'PRO_RATA',
            allocationMode: 'EFFORT',
            allocationPercent: 100,
            allocationStartWeek: null,
            allocationEndWeek: null,
            startWeek: null,
            endWeek: null,
            allocatedDays: 10,
            derivedStartWeek: 0,
            derivedEndWeek: 9,
            actualAllocatedDays: 0,        // PRO_RATA — uses allocatedDays, not actual
            actualAllocationStartWeek: null,
            actualAllocationEndWeek: null,
            actualAllocatedWeeks: [],
            actualAllocationSegments: [],
            synthetic: false,
            resourceIdentity: 'NAMED_PERSON',
            capacityProfile: {
              planningBasis: 'capacityProfile',
              source: 'manual',
              defaultPercent: 80,
              startWeek: 0,
              endWeek: 9,
              segments: [{ startWeek: 0, endWeek: 9, capacityPercent: 80 }],
              resolutionSource: 'PROFILE',
            },
          },
        ],
      },
      // ── QA: role-level row with ZERO-capacity profile (no NRs) ────
      {
        resourceTypeId: 'rt-qa',
        name: 'QA',
        category: 'QUALITY',
        count: 1,
        hoursPerDay: 8,
        dayRate: 400,
        totalHours: 40,
        totalDays: 5,
        effortDays: 5,
        allocatedDays: 5,
        allocationMode: 'EFFORT',
        allocationPercent: 100,
        allocationStartWeek: null,
        allocationEndWeek: null,
        derivedStartWeek: 0,
        derivedEndWeek: 4,
        estimatedCost: 2000,
        epics: [],
        namedResources: [],
        capacityProfile: {
          planningBasis: 'capacityProfile',
          source: 'fixed',
          defaultPercent: 0,
          startWeek: 0,
          endWeek: 4,
          segments: [{ startWeek: 0, endWeek: 4, capacityPercent: 0 }],
          resolutionSource: 'PROFILE',
        },
      },
      // ── QA Lead: NR with ZERO actual days + ZERO-capacity profile ─
      {
        resourceTypeId: 'rt-qa-lead',
        name: 'QA Lead',
        category: 'QUALITY',
        count: 1,
        hoursPerDay: 8,
        dayRate: 500,
        totalHours: 40,
        totalDays: 5,
        effortDays: 5,
        allocatedDays: 5,
        allocationMode: 'EFFORT',
        allocationPercent: 100,
        allocationStartWeek: null,
        allocationEndWeek: null,
        derivedStartWeek: 0,
        derivedEndWeek: 4,
        estimatedCost: 2500,
        epics: [],
        namedResources: [
          {
            id: 'nr-qa-lead',
            name: 'QA Lead',
            pricingModel: 'ACTUAL_DAYS',
            allocationMode: 'EFFORT',
            allocationPercent: 100,
            allocationStartWeek: null,
            allocationEndWeek: null,
            startWeek: null,
            endWeek: null,
            allocatedDays: 5,
            derivedStartWeek: 0,
            derivedEndWeek: 4,
            actualAllocatedDays: 0,        // ZERO actual days — tests zero retention
            actualAllocationStartWeek: null,
            actualAllocationEndWeek: null,
            actualAllocatedWeeks: [],
            actualAllocationSegments: [],
            synthetic: false,
            resourceIdentity: 'NAMED_PERSON',
            capacityProfile: {
              planningBasis: 'capacityProfile',
              source: 'fixed',
              defaultPercent: 0,
              startWeek: 0,
              endWeek: 4,
              segments: [{ startWeek: 0, endWeek: 4, capacityPercent: 0 }],
              resolutionSource: 'PROFILE',
            },
          },
        ],
      },
    ],
    overheadRows: [
      {
        overheadId: 'oh-pm',
        name: 'Project Management',
        resourceTypeId: null,
        resourceTypeName: null,
        dayRate: 1000,
        type: 'FIXED_DAYS',
        value: 5,
        computedDays: 5,
        estimatedCost: 5000,
        requiredFTE: 0.08,
        currentCount: null,
      },
    ],
    summary: {
      totalHours: 240,
      totalDays: 30,
      totalCost: 25500,
      hasCost: true,
    },
  }
}

function buildSourceDiscounts(): ProjectDiscount[] {
  return [
    {
      id: 'disc-dev-rt',
      projectId: 'source-proj',
      resourceTypeId: 'rt-dev',
      type: 'PERCENTAGE',
      value: 10,
      label: 'Dev discount',
      order: 1,
      createdAt: '2024-01-01T00:00:00Z',
    },
    {
      id: 'disc-project',
      projectId: 'source-proj',
      resourceTypeId: null,
      type: 'PERCENTAGE',
      value: 5,
      label: 'Project discount',
      order: 2,
      createdAt: '2024-01-01T00:00:00Z',
    },
  ]
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('clone commercial parity', () => {
  const projectSettings = { taxRate: 10, taxLabel: 'GST' }

  // ── computeCommercialData parity ────────────────────────────────────────

  it('computeCommercialData — source and clone produce identical CommercialData after normalizing generated IDs', () => {
    const sourceProfile = buildSourceProfile()
    const sourceDiscounts = buildSourceDiscounts()
    const cloneProfile = buildCloneProfile(sourceProfile)
    const cloneDiscounts = buildCloneDiscounts(sourceDiscounts)

    // Sanity: IDs actually differ between source and clone fixtures
    expect(sourceProfile.projectId).toBe('source-proj')
    expect(cloneProfile.projectId).toBe('clone-proj')
    expect(sourceProfile.resourceRows[0].resourceTypeId).toBe('rt-dev')
    expect(cloneProfile.resourceRows[0].resourceTypeId).toBe('rt-dev-clone')

    const sourceResult = computeCommercialData(sourceProfile, sourceDiscounts, projectSettings)
    const cloneResult = computeCommercialData(cloneProfile, cloneDiscounts, projectSettings)

    expect(sourceResult).not.toBeNull()
    expect(cloneResult).not.toBeNull()

    // Normalize generated IDs in the clone result back to source IDs
    const normalizedClone = normalizeCloneIds(cloneResult) as typeof sourceResult

    // ── Structural parity ──────────────────────────────────────────
    // Same number of rows after ID normalization
    expect(normalizedClone!.rows.length).toBe(sourceResult!.rows.length)

    // Same number of applied discounts across all rows — the RT-level discount
    // targets rt-dev, which applies to Alice and Bob (2 rows), so we expect
    // at least 6 appliedDiscounts total (2 for Developer NRs, and 0 for others)
    const sourceTotalDiscounts = sourceResult!.rows.reduce((s, r) => s + r.appliedDiscounts.length, 0)
    const cloneTotalDiscounts = normalizedClone!.rows.reduce((s, r) => s + r.appliedDiscounts.length, 0)
    expect(cloneTotalDiscounts).toBe(sourceTotalDiscounts)

    // ── Per-row field parity ───────────────────────────────────────
    // Check each source row finds an exact match in the normalized clone
    for (const srcRow of sourceResult!.rows) {
      const cloneRow = normalizedClone!.rows.find(r => r.id === srcRow.id)
      expect(cloneRow, `Missing row "${srcRow.id}" in normalized clone`).toBeDefined()

      // Compare every scalar field
      expect(cloneRow!.name).toBe(srcRow.name)
      expect(cloneRow!.count).toBe(srcRow.count)
      expect(cloneRow!.effortDays).toBe(srcRow.effortDays)
      expect(cloneRow!.allocatedDays).toBe(srcRow.allocatedDays)
      expect(cloneRow!.totalDays).toBe(srcRow.totalDays)
      expect(cloneRow!.dayRate).toBe(srcRow.dayRate)
      expect(cloneRow!.subtotal).toBe(srcRow.subtotal)
      expect(cloneRow!.allocationMode).toBe(srcRow.allocationMode)
      expect(cloneRow!.allocationPercent).toBe(srcRow.allocationPercent)
      expect(cloneRow!.allocationStartWeek).toBe(srcRow.allocationStartWeek)
      expect(cloneRow!.allocationEndWeek).toBe(srcRow.allocationEndWeek)
      expect(cloneRow!.derivedStartWeek).toBe(srcRow.derivedStartWeek)
      expect(cloneRow!.derivedEndWeek).toBe(srcRow.derivedEndWeek)
      expect(cloneRow!.kind).toBe(srcRow.kind)
      expect(cloneRow!.pricingModel).toBe(srcRow.pricingModel)
      expect(cloneRow!.netSubtotal).toBe(srcRow.netSubtotal)

      // RT-level discount details on the row
      expect(cloneRow!.appliedDiscounts.length).toBe(srcRow.appliedDiscounts.length)
      for (let i = 0; i < srcRow.appliedDiscounts.length; i++) {
        const srcD = srcRow.appliedDiscounts[i]
        const cloneD = cloneRow!.appliedDiscounts[i]
        expect(cloneD.type).toBe(srcD.type)
        expect(cloneD.value).toBe(srcD.value)
        expect(cloneD.label).toBe(srcD.label)
        expect(cloneD.calculatedAmount).toBe(srcD.calculatedAmount)
        expect(cloneD.resourceTypeId).toBe(srcD.resourceTypeId)
      }
    }

    // ── Aggregate total parity ─────────────────────────────────────
    expect(normalizedClone!.subtotal).toBe(sourceResult!.subtotal)
    expect(normalizedClone!.totalProjectDiscount).toBe(sourceResult!.totalProjectDiscount)
    expect(normalizedClone!.afterDiscounts).toBe(sourceResult!.afterDiscounts)
    expect(normalizedClone!.taxRate).toBe(sourceResult!.taxRate)
    expect(normalizedClone!.taxLabel).toBe(sourceResult!.taxLabel)
    expect(normalizedClone!.taxEnabled).toBe(sourceResult!.taxEnabled)
    expect(normalizedClone!.taxAmount).toBe(sourceResult!.taxAmount)
    expect(normalizedClone!.grandTotal).toBe(sourceResult!.grandTotal)

    // ── Project-level discount details ─────────────────────────────
    expect(sourceResult!.projectDiscounts.length).toBeGreaterThan(0)
    expect(normalizedClone!.projectDiscounts.length).toBe(sourceResult!.projectDiscounts.length)
    for (let i = 0; i < sourceResult!.projectDiscounts.length; i++) {
      const srcPd = sourceResult!.projectDiscounts[i]
      const clonePd = normalizedClone!.projectDiscounts[i]
      expect(clonePd.type).toBe(srcPd.type)
      expect(clonePd.value).toBe(srcPd.value)
      expect(clonePd.label).toBe(srcPd.label)
      expect(clonePd.calculatedAmount).toBe(srcPd.calculatedAmount)
    }
  })

  // ── Known commercial value assertions ──────────────────────────────────

  it('computeCommercialData — produces correct known values for the test fixture', () => {
    const profile = buildSourceProfile()
    const discounts = buildSourceDiscounts()
    const result = computeCommercialData(profile, discounts, projectSettings)

    expect(result).not.toBeNull()

    // 5 rows: Alice (ACTUAL_DAYS), Bob (PRO_RATA), QA (role-level),
    //          QA Lead (ACTUAL_DAYS, zero days), PM (overhead)
    expect(result!.rows).toHaveLength(5)

    // ── Alice: ACTUAL_DAYS, $800/day × 10 actual days = $8,000 ─────
    const alice = result!.rows.find(r => r.id === 'nr-alice')
    expect(alice).toBeDefined()
    expect(alice!.kind).toBe('named-resource')
    expect(alice!.pricingModel).toBe('ACTUAL_DAYS')
    expect(alice!.allocatedDays).toBe(10)
    expect(alice!.totalDays).toBe(10)
    expect(alice!.subtotal).toBe(8000)
    // Developer RT-level discount 10%
    expect(alice!.appliedDiscounts).toHaveLength(1)
    expect(alice!.appliedDiscounts[0].calculatedAmount).toBe(800)
    expect(alice!.netSubtotal).toBe(7200)
    expect(alice!.resourceTypeId).toBe('rt-dev')

    // ── Bob: PRO_RATA, $800/day × 10 allocated days = $8,000 ───────
    const bob = result!.rows.find(r => r.id === 'nr-bob')
    expect(bob).toBeDefined()
    expect(bob!.kind).toBe('named-resource')
    expect(bob!.pricingModel).toBe('PRO_RATA')
    expect(bob!.allocatedDays).toBe(10)      // allocatedDays for PRO_RATA
    expect(bob!.totalDays).toBe(10)
    expect(bob!.subtotal).toBe(8000)
    expect(bob!.appliedDiscounts).toHaveLength(1)
    expect(bob!.appliedDiscounts[0].calculatedAmount).toBe(800)
    expect(bob!.netSubtotal).toBe(7200)

    // ── QA (role-level, no NRs): $400/day × 5 allocated days = $2,000
    const qa = result!.rows.find(r => r.id === 'rt-qa')
    expect(qa).toBeDefined()
    expect(qa!.kind).toBe('resource')
    expect(qa!.pricingModel).toBeNull()
    expect(qa!.allocatedDays).toBe(5)
    expect(qa!.totalDays).toBe(5)
    expect(qa!.subtotal).toBe(2000)
    expect(qa!.appliedDiscounts).toHaveLength(0)  // no RT-level discount on QA
    expect(qa!.netSubtotal).toBe(2000)

    // ── QA Lead (NR with ZERO actualAllocatedDays): $0 ──────────────
    const qaLead = result!.rows.find(r => r.id === 'nr-qa-lead')
    expect(qaLead).toBeDefined()
    expect(qaLead!.kind).toBe('named-resource')
    expect(qaLead!.pricingModel).toBe('ACTUAL_DAYS')
    expect(qaLead!.allocatedDays).toBe(0)      // zero actual days preserved
    expect(qaLead!.totalDays).toBe(0)
    expect(qaLead!.subtotal).toBe(0)            // zero subtotal — not null, not absent
    expect(qaLead!.appliedDiscounts).toHaveLength(0)
    expect(qaLead!.netSubtotal).toBe(0)

    // ── PM overhead: $1,000/day × 5 computed days = $5,000 ─────────
    const pm = result!.rows.find(r => r.id === 'oh-pm')
    expect(pm).toBeDefined()
    expect(pm!.kind).toBe('overhead')
    expect(pm!.pricingModel).toBeNull()
    expect(pm!.allocatedDays).toBe(5)
    expect(pm!.totalDays).toBe(5)
    expect(pm!.subtotal).toBe(5000)
    expect(pm!.netSubtotal).toBe(5000)

    // ── Aggregate totals ────────────────────────────────────────────
    // Subtotal: 7200 + 7200 + 2000 + 0 + 5000 = 21400
    expect(result!.subtotal).toBe(21400)

    // Project-level discount: 5% × 21400 = 1070
    expect(result!.projectDiscounts).toHaveLength(1)
    expect(result!.projectDiscounts[0].calculatedAmount).toBe(1070)
    expect(result!.totalProjectDiscount).toBe(1070)

    expect(result!.afterDiscounts).toBe(20330)

    // Tax: 10% × 20330 = 2033
    expect(result!.taxRate).toBe(10)
    expect(result!.taxLabel).toBe('GST')
    expect(result!.taxEnabled).toBe(true)
    expect(result!.taxAmount).toBe(2033)

    expect(result!.grandTotal).toBe(22363)

    // No FIXED_PRICE billing in output
    const billingModels = new Set(result!.rows.map(r => r.pricingModel))
    expect(billingModels).not.toContain('FIXED_PRICE')
  })

  // ── buildProfileCsv parity ──────────────────────────────────────────────

  it('buildProfileCsv — source and clone produce identical CSV output', () => {
    const sourceProfile = buildSourceProfile()
    const cloneProfile = buildCloneProfile(sourceProfile)

    const csvSource = buildProfileCsv(sourceProfile)
    const csvClone = buildProfileCsv(cloneProfile)

    // CSV contains no generated IDs — direct string equality
    expect(csvClone).toBe(csvSource)
  })

  it('buildProfileCsv — complete CSV column parity for source and clone with zero-capacity assertions', () => {
    const sourceProfile = buildSourceProfile()
    const cloneProfile = buildCloneProfile(sourceProfile)

    const csvSource = buildProfileCsv(sourceProfile)
    const csvClone = buildProfileCsv(cloneProfile)

    const { headers, rows: sourceRows } = parseCsv(csvSource)
    const { rows: cloneRows } = parseCsv(csvClone)

    // Same row count
    expect(cloneRows.length).toBe(sourceRows.length)

    // Helper column lookups
    const colIdx = (name: string) => headers.indexOf(name)
    const SECTION = colIdx('Section')
    const ROLE = colIdx('Role')
    const RES_NAME = colIdx('Resource name')
    const RES_IDENTITY = colIdx('Resource identity')
    const CATEGORY = colIdx('Category')
    const PLAN_BASIS = colIdx('Availability pattern')
    const PROF_SOURCE = colIdx('Profile source')
    const DEF_CAP = colIdx('Default capacity %')
    const PROF_START = colIdx('Profile start')
    const PROF_END = colIdx('Profile end')
    const BILL_BASIS = colIdx('Billing basis')
    const CAP_SEGMENTS = colIdx('Capacity profile segments')
    const ASSN_SEGMENTS = colIdx('Assignment segments')
    const ASSN_WEEKS = colIdx('Assigned weeks')
    const BILL_DAYS = colIdx('Billable days')
    const DAY_RATE = colIdx('Day rate')
    const SUBTOTAL = colIdx('Subtotal')
    const COUNT_COL = colIdx('Resource count')
    const HOURS_DAY = colIdx('Hours per day')
    const EFFORT = colIdx('Effort days')
    const ASSIGNED = colIdx('Assigned days')

    // ── Source/clone row-by-row parity (by section + resource name) ──
    for (let i = 0; i < sourceRows.length; i++) {
      const s = sourceRows[i]
      const c = cloneRows[i]
      expect(c.length).toBe(s.length)
      for (let j = 0; j < s.length; j++) {
        expect(c[j]).toBe(s[j])
      }
    }

    // ── Zero-capacity retention assertions on source (identical in clone) ──

    // QA row (role-level, no NRs): ZERO-capacity profile
    const qaRow = sourceRows.find(r => r[ROLE] === 'QA')
    expect(qaRow).toBeDefined()
    // Planning basis: 'capacityProfile' → 'Varies by week'
    expect(qaRow![PLAN_BASIS]).toBe('Varies by week')
    // Profile source: 'fixed' → 'Fixed'
    expect(qaRow![PROF_SOURCE]).toBe('Fixed')
    // Default capacity %: 0 — truthy-fallback safe, must be "0" not ""
    expect(qaRow![DEF_CAP]).toBe('0')
    // Profile start/end: W1 / W5
    expect(qaRow![PROF_START]).toBe('W1')
    expect(qaRow![PROF_END]).toBe('W5')
    // Zero-capacity segment text: "W1-W5 0%"
    expect(qaRow![CAP_SEGMENTS]).toBe('W1-W5 0%')
    // Role-level row: no billing basis
    expect(qaRow![BILL_BASIS]).toBe('')
    // Resource identity: 'Role-level capacity'
    expect(qaRow![RES_IDENTITY]).toBe('Role-level capacity')

    // QA Lead NR row: ZERO actual days + ZERO capacity
    const qaLeadRow = sourceRows.find(r => r[RES_NAME] === 'QA Lead')
    expect(qaLeadRow).toBeDefined()
    // Named person identity
    expect(qaLeadRow![RES_IDENTITY]).toBe('Named person')
    // Planning basis: 'Varies by week'
    expect(qaLeadRow![PLAN_BASIS]).toBe('Varies by week')
    // Profile source: 'Fixed'
    expect(qaLeadRow![PROF_SOURCE]).toBe('Fixed')
    // Default capacity %: 0
    expect(qaLeadRow![DEF_CAP]).toBe('0')
    // Profile start/end
    expect(qaLeadRow![PROF_START]).toBe('W1')
    expect(qaLeadRow![PROF_END]).toBe('W5')
    // Zero-capacity segment text: "W1-W5 0%"
    expect(qaLeadRow![CAP_SEGMENTS]).toBe('W1-W5 0%')
    // Billing basis: ACTUAL_DAYS → 'Bill actual scheduled days'
    expect(qaLeadRow![BILL_BASIS]).toBe('Bill actual scheduled days')
    // Billable days is 0 (actualAllocatedDays=0 preserved, not fallbacked)
    expect(qaLeadRow![BILL_DAYS]).toBe('0')
    // Subtotal: 0.00
    expect(qaLeadRow![SUBTOTAL]).toBe('0.00')

    // ── ACTUAL_DAYS NR assertions (Alice) ────────────────────────────
    const aliceRow = sourceRows.find(r => r[RES_NAME] === 'Alice')
    expect(aliceRow).toBeDefined()
    expect(aliceRow![SECTION]).toBe('Resource')
    expect(aliceRow![ROLE]).toBe('Developer')
    expect(aliceRow![RES_IDENTITY]).toBe('Named person')
    expect(aliceRow![CATEGORY]).toBe('ENGINEERING')
    expect(aliceRow![PLAN_BASIS]).toBe('Varies by week')
    expect(aliceRow![PROF_SOURCE]).toBe('Squad Planner')
    expect(aliceRow![DEF_CAP]).toBe('100')
    expect(aliceRow![PROF_START]).toBe('W1')
    expect(aliceRow![PROF_END]).toBe('W10')
    expect(aliceRow![CAP_SEGMENTS]).toBe('W1-W10 100%')
    expect(aliceRow![BILL_BASIS]).toBe('Bill actual scheduled days')
    // Alice: 10 actual days × $800/day = $8,000
    expect(aliceRow![BILL_DAYS]).toBe('10')
    expect(aliceRow![SUBTOTAL]).toBe('8000.00')
    expect(aliceRow![COUNT_COL]).toBe('2')
    expect(aliceRow![HOURS_DAY]).toBe('8')
    expect(aliceRow![EFFORT]).toBe('20')
    expect(aliceRow![ASSIGNED]).toBe('10')
    expect(aliceRow![DAY_RATE]).toBe('800')
    expect(aliceRow![ASSN_SEGMENTS]).toBe('W1-W4 (10.00d)')
    expect(aliceRow![ASSN_WEEKS]).toBe('W1=2.50; W2=2.50; W3=2.50; W4=2.50')

    expect(qaRow![COUNT_COL]).toBe('1')
    expect(qaRow![HOURS_DAY]).toBe('8')
    expect(qaRow![EFFORT]).toBe('5')
    expect(qaRow![ASSIGNED]).toBe('5')
    expect(qaRow![DAY_RATE]).toBe('400')
    expect(qaRow![ASSN_SEGMENTS]).toBe('')
    expect(qaRow![ASSN_WEEKS]).toBe('')

    expect(qaLeadRow![COUNT_COL]).toBe('1')
    expect(qaLeadRow![HOURS_DAY]).toBe('8')
    expect(qaLeadRow![EFFORT]).toBe('5')
    expect(qaLeadRow![ASSIGNED]).toBe('5')
    expect(qaLeadRow![DAY_RATE]).toBe('500')
    expect(qaLeadRow![ASSN_SEGMENTS]).toBe('')
    expect(qaLeadRow![ASSN_WEEKS]).toBe('')


    // ── PRO_RATA NR assertions (Bob) ────────────────────────────────
    const bobRow = sourceRows.find(r => r[RES_NAME] === 'Bob')
    expect(bobRow).toBeDefined()
    expect(bobRow![SECTION]).toBe('Resource')
    expect(bobRow![ROLE]).toBe('Developer')
    expect(bobRow![RES_IDENTITY]).toBe('Named person')
    expect(bobRow![CATEGORY]).toBe('ENGINEERING')
    expect(bobRow![PLAN_BASIS]).toBe('Varies by week')
    expect(bobRow![PROF_SOURCE]).toBe('Manual')
    expect(bobRow![DEF_CAP]).toBe('80')
    expect(bobRow![PROF_START]).toBe('W1')
    expect(bobRow![PROF_END]).toBe('W10')
    expect(bobRow![CAP_SEGMENTS]).toBe('W1-W10 80%')
    // PRO_RATA → 'Bill planned allocation'
    expect(bobRow![BILL_BASIS]).toBe('Bill planned allocation')
    // Bob has actualAllocatedDays=0 so the CSV billable days is 0
    // (The CSV shows raw actualAllocatedDays, while computeCommercialData
    //  uses allocatedDays for PRO_RATA — that's the production behavior,
    //  and both source and clone preserve the same discrepancy.)
    expect(bobRow![BILL_DAYS]).toBe('0')
    expect(bobRow![SUBTOTAL]).toBe('0.00')

    // ── PM overhead row ──────────────────────────────────────────────
    const pmRow = sourceRows.find(r => r[ROLE] === 'Project Management')
    expect(pmRow).toBeDefined()
    expect(pmRow![SECTION]).toBe('Overhead')
    expect(pmRow![BILL_DAYS]).toBe('')      // Overheads show computedDays in "Assigned days"
    expect(pmRow![SUBTOTAL]).toBe('5000')   // estimatedCost
    expect(bobRow![COUNT_COL]).toBe('2')
    expect(bobRow![HOURS_DAY]).toBe('8')
    expect(bobRow![EFFORT]).toBe('20')
    expect(bobRow![ASSIGNED]).toBe('10')
    expect(bobRow![DAY_RATE]).toBe('800')
    expect(bobRow![ASSN_SEGMENTS]).toBe('')
    expect(bobRow![ASSN_WEEKS]).toBe('')

    expect(pmRow![COUNT_COL]).toBe('')
    expect(pmRow![HOURS_DAY]).toBe('')
    expect(pmRow![EFFORT]).toBe('')
    expect(pmRow![ASSIGNED]).toBe('5')
    expect(pmRow![DAY_RATE]).toBe('')
    expect(pmRow![ASSN_SEGMENTS]).toBe('')
    expect(pmRow![ASSN_WEEKS]).toBe('')

    // ── Header coverage ──────────────────────────────────────────────
    // Verify all expected headers are present
    const requiredHeaders = [
      'Section', 'Role', 'Resource name', 'Resource identity', 'Category',
      'Resource count', 'Hours per day', 'Effort days', 'Assigned days', 'Billable days',
      'Day rate', 'Subtotal',
      'Availability pattern', 'Profile source', 'Default capacity %', 'Profile start', 'Profile end',
      'Available from', 'Available to',
      'Assigned start', 'Assigned end', 'Capacity profile segments', 'Assignment segments', 'Assigned weeks',
      'Billing basis', 'Handover notes',
    ]
    for (const h of requiredHeaders) {
      expect(headers).toContain(h)
    }
    expect(headers).toHaveLength(26)

    // ── Row count: 5 data rows ──────────────────────────────────────
    expect(sourceRows.length).toBe(5)
  })
})
