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
})
