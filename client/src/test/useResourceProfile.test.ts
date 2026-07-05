import { describe, expect, it } from 'vitest'
import { buildProfileCsv } from '@/hooks/useResourceProfile'
import type { ResourceProfile } from '@/types/backlog'

describe('buildProfileCsv', () => {
  const BASE: ResourceProfile = {
    projectId: 'p1', hoursPerDay: 8, projectDurationWeeks: 12,
    bufferWeeks: 0, onboardingWeeks: 0,
    resourceRows: [], overheadRows: [],
    summary: { totalHours: 0, totalDays: 0, totalCost: 0, hasCost: false },
  }

  const OLD_TERMS = [
    'SyntheticSlot', 'NamedResource', 'PricingModel', 'AllocatedDays',
    'ActualAllocatedDays', 'HoursPerDay', 'EffortDays', 'DayRate',
    'WindowStart', 'WindowEnd', 'ActualStart', 'ActualEnd',
    'Capacity Plan', 'Timeline allocation', 'Full Project',
  ]

  it('exports plain-English headers', () => {
    const csv = buildProfileCsv(BASE)
    const headers = csv.split('\n')[0]
    expect(headers).toContain('Section')
    expect(headers).toContain('Role')
    expect(headers).toContain('Resource name')
    expect(headers).toContain('Resource identity')
    expect(headers).toContain('Category')
    expect(headers).toContain('Resource count')
    expect(headers).toContain('Hours per day')
    expect(headers).toContain('Effort days')
    expect(headers).toContain('Assigned days')
    expect(headers).toContain('Billable days')
    expect(headers).toContain('Day rate')
    expect(headers).toContain('Subtotal')
    expect(headers).toContain('Availability window start')
    expect(headers).toContain('Availability window end')
    expect(headers).toContain('Assigned start')
    expect(headers).toContain('Assigned end')
    expect(headers).toContain('Capacity profile')
    expect(headers).toContain('Assignment segments')
    expect(headers).toContain('Assigned weeks')
    expect(headers).toContain('Billing basis')
    expect(headers).toContain('Handover notes')
  })

  it('rejects old/internal header terms', () => {
    const csv = buildProfileCsv(BASE)
    for (const term of OLD_TERMS) {
      expect(csv).not.toContain(term)
    }
  })

  it('exports named person identity correctly', () => {
    const csv = buildProfileCsv({ ...BASE, resourceRows: [{ resourceTypeId: 'rt1', name: 'Dev', category: 'ENG', count: 1, hoursPerDay: 8, dayRate: 800, totalHours: 40, totalDays: 5, effortDays: 5, allocatedDays: 5, allocationMode: 'EFFORT', allocationPercent: 100, allocationStartWeek: null, allocationEndWeek: null, derivedStartWeek: 2, derivedEndWeek: 3, estimatedCost: 4000, epics: [], namedResources: [{ id: 'nr1', name: 'Alice', allocationMode: 'EFFORT', allocationPercent: 100, allocationStartWeek: null, allocationEndWeek: null, startWeek: null, endWeek: null, allocatedDays: 5, derivedStartWeek: 2, derivedEndWeek: 3, actualAllocatedDays: 5, actualAllocationStartWeek: 2, actualAllocationEndWeek: 3, actualAllocatedWeeks: [{ week: 2, days: 5, capacityDays: 5 }], actualAllocationSegments: [{ startWeek: 2, endWeek: 3, days: 5 }], synthetic: false }] }] })
    expect(csv).toContain('Named person')
    expect(csv).not.toContain('Planned resource')
  })

  it('exports planned resource identity correctly', () => {
    const csv = buildProfileCsv({ ...BASE, resourceRows: [{ resourceTypeId: 'rt1', name: 'Dev', category: 'ENG', count: 1, hoursPerDay: 8, dayRate: 800, totalHours: 40, totalDays: 5, effortDays: 5, allocatedDays: 5, allocationMode: 'EFFORT', allocationPercent: 100, allocationStartWeek: null, allocationEndWeek: null, derivedStartWeek: 2, derivedEndWeek: 3, estimatedCost: 4000, epics: [], namedResources: [{ id: 'nr1', name: 'Planned Dev', allocationMode: 'EFFORT', allocationPercent: 100, allocationStartWeek: null, allocationEndWeek: null, startWeek: null, endWeek: null, allocatedDays: 5, derivedStartWeek: 2, derivedEndWeek: 3, actualAllocatedDays: 5, actualAllocationStartWeek: 2, actualAllocationEndWeek: 3, actualAllocatedWeeks: [{ week: 2, days: 5, capacityDays: 5 }], actualAllocationSegments: [{ startWeek: 2, endWeek: 3, days: 5 }], synthetic: true }] }] })
    expect(csv).toContain('Planned resource')
    expect(csv).not.toContain('Named person')
  })

  it('exports role-level capacity rows', () => {
    const csv = buildProfileCsv({ ...BASE, resourceRows: [{ resourceTypeId: 'rt1', name: 'Dev', category: 'ENG', count: 2, hoursPerDay: 8, dayRate: 800, totalHours: 80, totalDays: 10, effortDays: 10, allocatedDays: 10, allocationMode: 'EFFORT', allocationPercent: 100, allocationStartWeek: null, allocationEndWeek: null, derivedStartWeek: 0, derivedEndWeek: 4, estimatedCost: 8000, epics: [], namedResources: [] }] })
    expect(csv).toContain('Role-level capacity')
  })

  it('exports billing basis as plain English', () => {
    const csv = buildProfileCsv({ ...BASE, resourceRows: [{ resourceTypeId: 'rt1', name: 'Dev', category: 'ENG', count: 1, hoursPerDay: 8, dayRate: 800, totalHours: 40, totalDays: 5, effortDays: 5, allocatedDays: 5, allocationMode: 'EFFORT', allocationPercent: 100, allocationStartWeek: null, allocationEndWeek: null, derivedStartWeek: 2, derivedEndWeek: 3, estimatedCost: 4000, epics: [], namedResources: [{ id: 'nrA', name: 'Alice', allocationMode: 'EFFORT', allocationPercent: 100, allocationStartWeek: null, allocationEndWeek: null, startWeek: null, endWeek: null, allocatedDays: 5, derivedStartWeek: 2, derivedEndWeek: 3, actualAllocatedDays: 5, actualAllocationStartWeek: 2, actualAllocationEndWeek: 3, actualAllocatedWeeks: [{ week: 2, days: 5, capacityDays: 5 }], actualAllocationSegments: [{ startWeek: 2, endWeek: 3, days: 5 }], synthetic: false, pricingModel: 'PRO_RATA' }, { id: 'nrB', name: 'Bob', allocationMode: 'EFFORT', allocationPercent: 100, allocationStartWeek: null, allocationEndWeek: null, startWeek: null, endWeek: null, allocatedDays: 5, derivedStartWeek: 2, derivedEndWeek: 3, actualAllocatedDays: 5, actualAllocationStartWeek: 2, actualAllocationEndWeek: 3, actualAllocatedWeeks: [{ week: 2, days: 5, capacityDays: 5 }], actualAllocationSegments: [{ startWeek: 2, endWeek: 3, days: 5 }], synthetic: false, pricingModel: 'ACTUAL_DAYS' }] }] })
    expect(csv).toContain('Bill planned allocation')
    expect(csv).toContain('Bill actual scheduled days')
  })

  it('exports named-resource rows with week allocations using ASCII-safe labels', () => {
    const csv = buildProfileCsv({
      ...BASE,
      summary: { totalHours: 40, totalDays: 10, totalCost: 12000, hasCost: true },
      resourceRows: [{
        resourceTypeId: 'rt-s', name: 'Security Consultant', category: 'GOVERNANCE',
        count: 1, hoursPerDay: 8, dayRate: 1200, totalHours: 40, totalDays: 10,
        effortDays: 10, allocatedDays: 10, allocationMode: 'EFFORT', allocationPercent: 100,
        allocationStartWeek: null, allocationEndWeek: null, derivedStartWeek: 2, derivedEndWeek: 3,
        estimatedCost: 12000, epics: [],
        namedResources: [{
          id: 'nr1', name: 'Alex \u2014 Security',
          allocationMode: 'EFFORT', allocationPercent: 100,
          allocationStartWeek: null, allocationEndWeek: null, startWeek: null, endWeek: null,
          allocatedDays: 10, derivedStartWeek: 2, derivedEndWeek: 3,
          actualAllocatedDays: 2.5, actualAllocationStartWeek: 2, actualAllocationEndWeek: 3,
          actualAllocatedWeeks: [{ week: 2, days: 1.5, capacityDays: 5 }, { week: 3, days: 1, capacityDays: 5 }],
          actualAllocationSegments: [{ startWeek: 2, endWeek: 3, days: 2.5 }],
          synthetic: false,
        }],
      }],
    })
    expect(csv).toContain('Section,Role,Resource name')
    expect(csv).toContain('Resource,Security Consultant,Alex - Security,Named person')
    expect(csv).toContain('W3-W4 (2.50d)')
    expect(csv).toContain('W3=1.50; W4=1.00')
    expect(csv).not.toContain('\u2014')
    expect(csv).not.toContain('\u00d7')
  })

  it('every row has same column count as header', () => {
    const profile: ResourceProfile = {
      ...BASE,
      resourceRows: [
        {
          resourceTypeId: 'rt-named', name: 'Developer', category: 'ENG',
          count: 1, hoursPerDay: 8, dayRate: 800, totalHours: 40, totalDays: 5,
          effortDays: 5, allocatedDays: 5, allocationMode: 'EFFORT',
          allocationPercent: 100, allocationStartWeek: null, allocationEndWeek: null,
          derivedStartWeek: 2, derivedEndWeek: 3, estimatedCost: 4000, epics: [],
          namedResources: [{
            id: 'nr1', name: 'Alice', allocationMode: 'EFFORT',
            allocationPercent: 100, allocationStartWeek: null, allocationEndWeek: null,
            startWeek: null, endWeek: null, allocatedDays: 5,
            derivedStartWeek: 2, derivedEndWeek: 3,
            actualAllocatedDays: 5, actualAllocationStartWeek: 2, actualAllocationEndWeek: 3,
            actualAllocatedWeeks: [], actualAllocationSegments: [],
            pricingModel: 'PRO_RATA', synthetic: false,
          }],
        },
        {
          resourceTypeId: 'rt-plan', name: 'Tech Lead', category: 'ENG',
          count: 1, hoursPerDay: 8, dayRate: 1000, totalHours: 40, totalDays: 5,
          effortDays: 5, allocatedDays: 5, allocationMode: 'EFFORT',
          allocationPercent: 100, allocationStartWeek: null, allocationEndWeek: null,
          derivedStartWeek: 2, derivedEndWeek: 3, estimatedCost: 5000, epics: [],
          namedResources: [],
        },
        {
          resourceTypeId: 'rt-planned', name: 'Security Consultant', category: 'GOV',
          count: 1, hoursPerDay: 8, dayRate: 1200, totalHours: 40, totalDays: 5,
          effortDays: 5, allocatedDays: 5, allocationMode: 'EFFORT',
          allocationPercent: 100, allocationStartWeek: null, allocationEndWeek: null,
          derivedStartWeek: 2, derivedEndWeek: 3, estimatedCost: 6000, epics: [],
          namedResources: [{
            id: 'nr2', name: 'Planned Security', allocationMode: 'EFFORT',
            allocationPercent: 100, allocationStartWeek: null, allocationEndWeek: null,
            startWeek: null, endWeek: null, allocatedDays: 5,
            derivedStartWeek: 2, derivedEndWeek: 3,
            actualAllocatedDays: 5, actualAllocationStartWeek: 2, actualAllocationEndWeek: 3,
            actualAllocatedWeeks: [], actualAllocationSegments: [],
            pricingModel: 'PRO_RATA', synthetic: true,
          }],
        },
      ],
      overheadRows: [
        { name: 'Travel', computedDays: 10, estimatedCost: 5000, resourceTypeName: 'Travel' },
      ],
    }

    const csv = buildProfileCsv(profile)
    const lines = csv.split('\n').filter(l => l.length > 0)
    const headerCols = lines[0].split(',').length
    expect(headerCols).toBe(21)
    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(',').length
      expect(cols, `row ${i} has ${cols} columns, expected ${headerCols}`).toBe(headerCols)
    }
  })

  it('capacity profile column contains segments for named-resource rows with capacityProfile', () => {
    const csv = buildProfileCsv({
      ...BASE,
      resourceRows: [{
        resourceTypeId: 'rt1', name: 'Engineer', category: 'ENG',
        count: 1, hoursPerDay: 8, dayRate: 800, totalHours: 40, totalDays: 5,
        effortDays: 5, allocatedDays: 5, allocationMode: 'EFFORT',
        allocationPercent: 100, allocationStartWeek: null, allocationEndWeek: null,
        derivedStartWeek: 2, derivedEndWeek: 3, estimatedCost: 4000, epics: [],
        namedResources: [{
          id: 'nr1', name: 'Alice', allocationMode: 'EFFORT',
          allocationPercent: 100, allocationStartWeek: null, allocationEndWeek: null,
          startWeek: null, endWeek: null, allocatedDays: 5,
          derivedStartWeek: 2, derivedEndWeek: 3,
          actualAllocatedDays: 5, actualAllocationStartWeek: 2, actualAllocationEndWeek: 3,
          actualAllocatedWeeks: [], actualAllocationSegments: [],
          synthetic: false, capacityProfile: {
            planningBasis: 'availabilityWindow',
            source: 'availabilityWindow',
            segments: [
              { startWeek: 0, endWeek: 3, capacityPercent: 50 },
              { startWeek: 4, endWeek: 7, capacityPercent: 100 },
            ],
          },
        }],
      }],
    })
    const lines = csv.split('\n').filter(l => l.length > 0)
    const header = lines[0].split(',')
    const capacityProfileIdx = header.indexOf('Capacity profile')
    const assignmentSegmentsIdx = header.indexOf('Assignment segments')
    const assignedWeeksIdx = header.indexOf('Assigned weeks')
    expect(capacityProfileIdx).toBeGreaterThanOrEqual(0)
    expect(assignmentSegmentsIdx).toBeGreaterThanOrEqual(0)

    // Find the data row (second line, after header)
    const dataRow = lines[1].split(',')
    expect(dataRow[capacityProfileIdx]).toBe('W1-W4 50%; W5-W8 100%')
    // Assignment segments and assigned weeks remain independent
    expect(dataRow[assignmentSegmentsIdx]).toBe('')  // empty in this fixture
    expect(dataRow[assignedWeeksIdx]).toBe('')       // empty in this fixture
  })

  it('capacity profile lands in correct column for role-level row', () => {
    const csv = buildProfileCsv({
      ...BASE,
      resourceRows: [{
        resourceTypeId: 'rt1', name: 'Engineer', category: 'ENG',
        count: 2, hoursPerDay: 8, dayRate: 800, totalHours: 80, totalDays: 10,
        effortDays: 10, allocatedDays: 10, allocationMode: 'TIMELINE',
        allocationPercent: 75, allocationStartWeek: 0, allocationEndWeek: 7,
        derivedStartWeek: 0, derivedEndWeek: 7, estimatedCost: 8000, epics: [],
        namedResources: [],
        capacityProfile: {
          planningBasis: 'availabilityWindow',
          source: 'availabilityWindow',
          segments: [{ startWeek: 0, endWeek: 7, capacityPercent: 75 }],
        },
      }],
    })
    const lines = csv.split('\n').filter(l => l.length > 0)
    const header = lines[0].split(',')
    const capacityProfileIdx = header.indexOf('Capacity profile')
    const assignedStartIdx = header.indexOf('Assigned start')
    expect(capacityProfileIdx).toBeGreaterThan(assignedStartIdx)

    const row = lines[1].split(',')
    // Capacity profile value at correct column, not earlier
    expect(row[capacityProfileIdx]).toBe('W1-W8 75%')
    expect(row[assignedStartIdx]).toBe('')
  })

  it('billing basis exports plain English regardless of capacity profile', () => {
    const csv = buildProfileCsv({
      ...BASE,
      resourceRows: [{
        resourceTypeId: 'rt1', name: 'Dev', category: 'ENG',
        count: 1, hoursPerDay: 8, dayRate: 800, totalHours: 40, totalDays: 5,
        effortDays: 5, allocatedDays: 5, allocationMode: 'EFFORT',
        allocationPercent: 100, allocationStartWeek: null, allocationEndWeek: null,
        derivedStartWeek: 2, derivedEndWeek: 3, estimatedCost: 4000, epics: [],
        namedResources: [{
          id: 'nrA', name: 'Alice', allocationMode: 'EFFORT',
          allocationPercent: 100, allocationStartWeek: null, allocationEndWeek: null,
          startWeek: null, endWeek: null, allocatedDays: 5,
          derivedStartWeek: 2, derivedEndWeek: 3,
          actualAllocatedDays: 5, actualAllocationStartWeek: 2, actualAllocationEndWeek: 3,
          actualAllocatedWeeks: [], actualAllocationSegments: [],
          pricingModel: 'PRO_RATA', synthetic: false,
        }, {
          id: 'nrB', name: 'Bob', allocationMode: 'EFFORT',
          allocationPercent: 100, allocationStartWeek: null, allocationEndWeek: null,
          startWeek: null, endWeek: null, allocatedDays: 5,
          derivedStartWeek: 2, derivedEndWeek: 3,
          actualAllocatedDays: 5, actualAllocationStartWeek: 2, actualAllocationEndWeek: 3,
          actualAllocatedWeeks: [], actualAllocationSegments: [],
          synthetic: false,
        }],
      }],
    })
    expect(csv).toContain('Bill planned allocation')
    expect(csv).toContain('Bill actual scheduled days')
  })
})
