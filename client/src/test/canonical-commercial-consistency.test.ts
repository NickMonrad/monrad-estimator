/**
 * canonical-commercial-consistency.test.ts — Client-side commercial regression
 * fixture proving computeCommercialData uses the same scheduled-day facts as
 * the server-side Timeline/Resource Profile surfaces.
 *
 * The fixture shape mirrors server/src/test/canonical-consistency.test.ts
 * so that Timeline NR days, Resource Profile NR days, and Commercial
 * billable days are all derived from the same underlying data.
 */

import { describe, expect, it } from 'vitest'
import { computeCommercialData } from '../utils/financialCalculations'
import type { ResourceProfile } from '../types/backlog'

/**
 * Build a minimal ResourceProfile that mirrors the canonical server fixture:
 *   1 resource type (Developer, dayRate 500)
 *   2 named resources (Alice ACTUAL_DAYS, Bob PRO_RATA)
 *   Cached weekly demand produces 20 allocated days / 20 actual allocated days
 */
function buildCanonicalProfile(): ResourceProfile {
  return {
    projectId: 'proj-1',
    hoursPerDay: 8,
    projectDurationWeeks: 7,
    bufferWeeks: 2,
    onboardingWeeks: 1,
    resourceRows: [
      {
        resourceTypeId: 'rt-dev',
        name: 'Developer',
        category: 'ENGINEERING',
        count: 2,
        hoursPerDay: 8,
        dayRate: 500,
        totalHours: 160,
        totalDays: 20,
        effortDays: 20,
        allocatedDays: 20,
        estimatedCost: 10000,
        allocationMode: 'EFFORT',
        allocationPercent: 100,
        allocationStartWeek: null,
        allocationEndWeek: null,
        derivedStartWeek: 0,
        derivedEndWeek: 4,
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
            derivedEndWeek: 4,
            actualAllocatedDays: 10,
            actualAllocationStartWeek: 0,
            actualAllocationEndWeek: 4,
            actualAllocatedWeeks: [
              { week: 0, days: 2.5, capacityDays: 5 },
              { week: 1, days: 2.5, capacityDays: 5 },
              { week: 2, days: 2.5, capacityDays: 5 },
              { week: 3, days: 2.5, capacityDays: 5 },
            ],
            actualAllocationSegments: [
              { startWeek: 0, endWeek: 4, days: 10 },
            ],
            synthetic: false,
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
            derivedEndWeek: 4,
            actualAllocatedDays: 0,
            actualAllocationStartWeek: null,
            actualAllocationEndWeek: null,
            actualAllocatedWeeks: [],
            actualAllocationSegments: [],
            synthetic: false,
          },
        ],
      },
    ],
    overheadRows: [],
    summary: {
      totalHours: 160,
      totalDays: 20,
      totalCost: 10000,
      hasCost: true,
    },
  }
}

/**
 * Build a realistic Resource Profile DTO shaped exactly like restored Scenario A
 * data (as would come from a PostgreSQL snapshot rollback). Contains:
 *   2 resource types (Developer $500/day, Designer $400/day)
 *   3 named resources across both pricing models
 *   1 overhead item (Governance $600/day, 2 fixed days)
 */
function buildScenarioAProfile(): ResourceProfile {
  return {
    projectId: 'proj-parity',
    hoursPerDay: 8,
    projectDurationWeeks: 6,
    bufferWeeks: 1,
    onboardingWeeks: 1,
    resourceRows: [
      {
        resourceTypeId: 'rt-dev',
        name: 'Developer',
        category: 'ENGINEERING',
        count: 2,
        hoursPerDay: 8,
        dayRate: 500,
        totalHours: 144,
        totalDays: 18,
        effortDays: 18,
        allocatedDays: 18,
        estimatedCost: 9000,
        allocationMode: 'EFFORT',
        allocationPercent: 100,
        allocationStartWeek: null,
        allocationEndWeek: null,
        derivedStartWeek: 0,
        derivedEndWeek: 5,
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
            allocatedDays: 9,
            derivedStartWeek: 0,
            derivedEndWeek: 5,
            actualAllocatedDays: 10,
            actualAllocationStartWeek: 0,
            actualAllocationEndWeek: 4,
            actualAllocatedWeeks: [
              { week: 0, days: 2.5, capacityDays: 5 },
              { week: 1, days: 2.5, capacityDays: 5 },
              { week: 2, days: 2.5, capacityDays: 5 },
              { week: 3, days: 2.5, capacityDays: 5 },
            ],
            actualAllocationSegments: [
              { startWeek: 0, endWeek: 4, days: 10 },
            ],
            synthetic: false,
          },
          {
            id: 'nr-charlie',
            name: 'Charlie',
            pricingModel: 'ACTUAL_DAYS',
            allocationMode: 'EFFORT',
            allocationPercent: 100,
            allocationStartWeek: null,
            allocationEndWeek: null,
            startWeek: null,
            endWeek: null,
            allocatedDays: 9,
            derivedStartWeek: 0,
            derivedEndWeek: 4,
            actualAllocatedDays: 8,
            actualAllocationStartWeek: 0,
            actualAllocationEndWeek: 3,
            actualAllocatedWeeks: [
              { week: 0, days: 2, capacityDays: 5 },
              { week: 1, days: 2, capacityDays: 5 },
              { week: 2, days: 2, capacityDays: 5 },
              { week: 3, days: 2, capacityDays: 5 },
            ],
            actualAllocationSegments: [
              { startWeek: 0, endWeek: 4, days: 8 },
            ],
            synthetic: false,
          },
        ],
      },
      {
        resourceTypeId: 'rt-des',
        name: 'Designer',
        category: 'ENGINEERING',
        count: 1,
        hoursPerDay: 8,
        dayRate: 400,
        totalHours: 96,
        totalDays: 12,
        effortDays: 12,
        allocatedDays: 12,
        estimatedCost: 4800,
        allocationMode: 'EFFORT',
        allocationPercent: 100,
        allocationStartWeek: null,
        allocationEndWeek: null,
        derivedStartWeek: 1,
        derivedEndWeek: 4,
        epics: [],
        namedResources: [
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
            allocatedDays: 12,
            derivedStartWeek: 1,
            derivedEndWeek: 4,
            actualAllocatedDays: 0,
            actualAllocationStartWeek: null,
            actualAllocationEndWeek: null,
            actualAllocatedWeeks: [],
            actualAllocationSegments: [],
            synthetic: false,
          },
        ],
      },
    ],
    overheadRows: [
      {
        overheadId: 'oh-gov',
        name: 'Governance',
        resourceTypeId: null,
        resourceTypeName: null,
        dayRate: 600,
        type: 'FIXED_DAYS',
        value: 2,
        computedDays: 2,
        estimatedCost: 1200,
        requiredFTE: 0.07,
        currentCount: null,
      },
    ],
    summary: {
      totalHours: 240,
      totalDays: 32,
      totalCost: 15000,
      hasCost: true,
    },
  }
}

describe('canonical commercial consistency', () => {
  it('ACTUAL_DAYS named resource: billable days match actual scheduled days', () => {
    const profile = buildCanonicalProfile()
    const result = computeCommercialData(profile, [], { taxRate: null, taxLabel: 'GST' })

    expect(result).not.toBeNull()
    const aliceRow = result!.rows.find(r => r.id === 'nr-alice')
    expect(aliceRow).toBeDefined()
    expect(aliceRow!.kind).toBe('named-resource')

    // For ACTUAL_DAYS, billable days = actualAllocatedDays
    expect(aliceRow!.allocatedDays).toBe(10)
    expect(aliceRow!.totalDays).toBe(10)
    expect(aliceRow!.subtotal).toBe(10 * 500) // 5000
    expect(aliceRow!.pricingModel).toBe('ACTUAL_DAYS')
  })

  it('PRO_RATA named resource: billable days use allocatedDays (planned)', () => {
    const profile = buildCanonicalProfile()
    const result = computeCommercialData(profile, [], { taxRate: null, taxLabel: 'GST' })

    expect(result).not.toBeNull()
    const bobRow = result!.rows.find(r => r.id === 'nr-bob')
    expect(bobRow).toBeDefined()
    expect(bobRow!.kind).toBe('named-resource')

    // For PRO_RATA, billable days = allocatedDays (planned allocation)
    expect(bobRow!.allocatedDays).toBe(10)
    expect(bobRow!.totalDays).toBe(10)
    expect(bobRow!.subtotal).toBe(10 * 500) // 5000
    expect(bobRow!.pricingModel).toBe('PRO_RATA')
  })

  it('commercial subtotal equals sum of NR billable days * day rate', () => {
    const profile = buildCanonicalProfile()
    const result = computeCommercialData(profile, [], { taxRate: null, taxLabel: 'GST' })

    expect(result).not.toBeNull()
    // Alice: 10 actual days x $500 = $5,000
    // Bob: 10 allocated days x $500 = $5,000
    // Total: $10,000
    expect(result!.subtotal).toBe(10000)
  })

  it('grand total includes tax when taxRate is set', () => {
    const profile = buildCanonicalProfile()
    const result = computeCommercialData(profile, [], { taxRate: 10, taxLabel: 'GST' })

    expect(result).not.toBeNull()
    // Subtotal: $10,000
    // No discounts
    // Tax 10%: $1,000
    // Grand total: $11,000
    expect(result!.subtotal).toBe(10000)
    expect(result!.taxRate).toBe(10)
    expect(result!.taxLabel).toBe('GST')
    expect(result!.taxEnabled).toBe(true)
    expect(result!.taxAmount).toBe(1000)
    expect(result!.grandTotal).toBe(11000)
  })

  it('commercial rows preserve resource type metadata', () => {
    const profile = buildCanonicalProfile()
    const result = computeCommercialData(profile, [], { taxRate: null, taxLabel: 'GST' })

    expect(result).not.toBeNull()
    for (const row of result!.rows) {
      expect(row.dayRate).toBe(500)
      expect(row.resourceTypeId).toBe('rt-dev')
      expect(typeof row.subtotal).toBe('number')
      expect(row.subtotal).toBeGreaterThan(0)
    }
  })

  it('adding capacityProfile enrichment does not change commercial totals', () => {
    const base = buildCanonicalProfile()
    const baseResult = computeCommercialData(base, [], { taxRate: null, taxLabel: 'GST' })

    // Add capacityProfile enrichment to the same profile
    const enriched: ResourceProfile = {
      ...base,
      resourceRows: base.resourceRows.map(row => ({
        ...row,
        capacityProfile: {
          planningBasis: 'capacityProfile',
          source: 'squadPlanner',
          segments: [{ startWeek: 0, endWeek: 4, capacityPercent: 100 }],
        },
        namedResources: row.namedResources.map(nr => ({
          ...nr,
          capacityProfile: {
            planningBasis: 'capacityProfile',
            source: 'squadPlanner',
            segments: [{ startWeek: 0, endWeek: 4, capacityPercent: 100 }],
          },
        })),
      })),
    }
    const enrichedResult = computeCommercialData(enriched, [], { taxRate: null, taxLabel: 'GST' })

    expect(enrichedResult).not.toBeNull()
    expect(baseResult).not.toBeNull()

    // Commercial totals are identical
    expect(enrichedResult!.subtotal).toBe(baseResult!.subtotal)
    expect(enrichedResult!.grandTotal).toBe(baseResult!.grandTotal)
    expect(enrichedResult!.taxAmount).toBe(baseResult!.taxAmount)

    // Per-row billable days and subtotals unchanged
    for (let i = 0; i < enrichedResult!.rows.length; i++) {
      expect(enrichedResult!.rows[i].billableDays).toBe(baseResult!.rows[i].billableDays)
      expect(enrichedResult!.rows[i].subtotal).toBe(baseResult!.rows[i].subtotal)
      expect(enrichedResult!.rows[i].pricingModel).toBe(baseResult!.rows[i].pricingModel)
    }
  })

  it('rollback parity: restored Scenario A DTO produces identical commercial totals before and after mutation', () => {
    // ── State A: restored snapshot DTO ──────────────────────────────
    const profileA = buildScenarioAProfile()
    const discounts = [
      { id: 'd-proj', label: 'Loyalty', type: 'PERCENTAGE' as const, value: 10, resourceTypeId: null },
    ]
    const projectSettings = { taxRate: 10, taxLabel: 'GST' }

    const resultA = computeCommercialData(profileA, discounts, projectSettings)
    expect(resultA).not.toBeNull()
    // No duplicate commercial row IDs after initial computation
    const rowIdsA = resultA!.rows.map(r => r.id)
    expect(new Set(rowIdsA).size).toBe(rowIdsA.length)

    // ── State A known totals ────────────────────────────────────────
    // Alice ACTUAL_DAYS: 10 actual days × $500 = $5,000
    // Charlie ACTUAL_DAYS: 8 actual days × $500 = $4,000
    // Bob PRO_RATA: 12 allocated days × $400 = $4,800
    // Subtotal (NR rows): $13,800
    // Governance overhead: 2 days × $600 = $1,200
    // Subtotal (all rows): $15,000
    // Project discount 10%: $1,500
    // After discounts: $13,500
    // Tax 10%: $1,350
    // Grand total: $14,850
    const aliceA = resultA!.rows.find(r => r.id === 'nr-alice')
    expect(aliceA).toBeDefined()
    expect(aliceA!.allocatedDays).toBe(10)
    expect(aliceA!.totalDays).toBe(10)
    expect(aliceA!.subtotal).toBe(5000)
    expect(aliceA!.pricingModel).toBe('ACTUAL_DAYS')

    const charlieA = resultA!.rows.find(r => r.id === 'nr-charlie')
    expect(charlieA).toBeDefined()
    expect(charlieA!.allocatedDays).toBe(8)
    expect(charlieA!.subtotal).toBe(4000)
    expect(charlieA!.pricingModel).toBe('ACTUAL_DAYS')

    const bobA = resultA!.rows.find(r => r.id === 'nr-bob')
    expect(bobA).toBeDefined()
    expect(bobA!.allocatedDays).toBe(12)
    expect(bobA!.subtotal).toBe(4800)
    expect(bobA!.pricingModel).toBe('PRO_RATA')

    const govA = resultA!.rows.find(r => r.id === 'oh-gov')
    expect(govA).toBeDefined()
    expect(govA!.kind).toBe('overhead')
    expect(govA!.allocatedDays).toBe(2)
    expect(govA!.subtotal).toBe(1200)

    expect(resultA!.subtotal).toBe(15000)
    expect(resultA!.totalProjectDiscount).toBe(1500)
    expect(resultA!.afterDiscounts).toBe(13500)
    expect(resultA!.taxAmount).toBe(1350)
    expect(resultA!.grandTotal).toBe(14850)

    // ── State B: mutated day rates (different billing amounts) ──────
    const profileB: ResourceProfile = {
      ...profileA,
      resourceRows: profileA.resourceRows.map(row => {
        if (row.resourceTypeId === 'rt-dev') return { ...row, dayRate: 600, estimatedCost: 10800 }
        if (row.resourceTypeId === 'rt-des') return { ...row, dayRate: 500, estimatedCost: 6000 }
        return row
      }),
    }

    const resultB = computeCommercialData(profileB, discounts, projectSettings)
    expect(resultB).not.toBeNull()

    // State B totals must differ from State A
    // Developer $600: Alice 10×600=6000, Charlie 8×600=4800
    // Designer $500: Bob 12×500=6000
    // Overhead unchanged: 1200
    // Subtotal: 6000+4800+6000+1200 = 18000
    // Discount 10%: 1800, after: 16200, tax 10%: 1620, grand: 17820
    expect(resultB!.subtotal).toBe(18000)
    expect(resultB!.grandTotal).toBe(17820)
    expect(resultB!.subtotal).not.toBe(resultA!.subtotal)
    expect(resultB!.grandTotal).not.toBe(resultA!.grandTotal)

    // ── Restore A DTO → recompute ───────────────────────────────────
    const resultRestored = computeCommercialData(profileA, discounts, projectSettings)
    expect(resultRestored).not.toBeNull()
    // No duplicate commercial row IDs after restoring A
    const rowIdsR = resultRestored!.rows.map(r => r.id)
    expect(new Set(rowIdsR).size).toBe(rowIdsR.length)

    // ── Exact commercial parity between initial and post-restore ─────
    expect(resultRestored!.subtotal).toBe(resultA!.subtotal)
    expect(resultRestored!.totalProjectDiscount).toBe(resultA!.totalProjectDiscount)
    expect(resultRestored!.afterDiscounts).toBe(resultA!.afterDiscounts)
    expect(resultRestored!.taxRate).toBe(resultA!.taxRate)
    expect(resultRestored!.taxAmount).toBe(resultA!.taxAmount)
    expect(resultRestored!.grandTotal).toBe(resultA!.grandTotal)

    // All rows present with same count
    expect(resultRestored!.rows).toHaveLength(resultA!.rows.length)

    // Per-row billable days, subtotals, and pricing models unchanged
    for (const rowA of resultA!.rows) {
      const rowR = resultRestored!.rows.find(r => r.id === rowA.id)
      expect(rowR).toBeDefined()
      expect(rowR!.allocatedDays).toBe(rowA.allocatedDays)
      expect(rowR!.totalDays).toBe(rowA.totalDays)
      expect(rowR!.subtotal).toBe(rowA.subtotal)
      expect(rowR!.pricingModel).toBe(rowA.pricingModel)
      expect(rowR!.dayRate).toBe(rowA.dayRate)
    }

    // Overhead row identity preserved
    const govRestored = resultRestored!.rows.find(r => r.id === 'oh-gov')
    expect(govRestored).toBeDefined()
    expect(govRestored!.kind).toBe('overhead')
    expect(govRestored!.allocatedDays).toBe(2)
    expect(govRestored!.subtotal).toBe(1200)
  })
})
