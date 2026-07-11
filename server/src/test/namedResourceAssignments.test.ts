import { describe, expect, it } from 'vitest'
import { materializeCapacityPlanResources } from '../lib/capacityPlanMaterialisation.js';
import { deriveNamedResourceAssignments } from '../lib/namedResourceAssignments.js'

describe('deriveNamedResourceAssignments', () => {
  it('keeps TIMELINE named resources available across all demand weeks when allocation window is omitted', () => {
    const assignments = deriveNamedResourceAssignments({
      resourceTypes: [
        {
          id: 'rt-dev',
          name: 'Developer',
          count: 1,
          allocationMode: 'TIMELINE',
          namedResources: [
            {
              id: 'nr-dev-1',
              name: 'Dev 1',
              startWeek: null,
              endWeek: null,
              allocationMode: 'TIMELINE',
              allocationPercent: 100,
              allocationStartWeek: null,
              allocationEndWeek: null,
            },
          ],
        },
      ],
      weeklyDemand: [
        { week: 3, resourceTypeName: 'Developer', demandDays: 5 },
        { week: 4, resourceTypeName: 'Developer', demandDays: 5 },
        { week: 7, resourceTypeName: 'Developer', demandDays: 2 },
      ],
    })

    expect(assignments.get('rt-dev')).toEqual(
      expect.objectContaining({
        actualAllocatedDays: 12,
        unallocatedDays: 0,
        namedResources: [
          expect.objectContaining({
            id: 'nr-dev-1',
            actualAllocatedDays: 12,
            actualAllocationStartWeek: 3,
            actualAllocationEndWeek: 7,
            actualAllocatedWeeks: [
              { week: 3, days: 5, capacityDays: 5 },
              { week: 4, days: 5, capacityDays: 5 },
              { week: 7, days: 2, capacityDays: 5 },
            ],
          }),
        ],
      }),
    )
  })

  it('still applies named-resource start/end gating when TIMELINE allocation window is omitted', () => {
    const assignments = deriveNamedResourceAssignments({
      resourceTypes: [
        {
          id: 'rt-dev',
          name: 'Developer',
          count: 1,
          allocationMode: 'TIMELINE',
          namedResources: [
            {
              id: 'nr-dev-1',
              name: 'Dev 1',
              startWeek: 4,
              endWeek: 5,
              allocationMode: 'TIMELINE',
              allocationPercent: 100,
              allocationStartWeek: null,
              allocationEndWeek: null,
            },
          ],
        },
      ],
      weeklyDemand: [
        { week: 3, resourceTypeName: 'Developer', demandDays: 5 },
        { week: 4, resourceTypeName: 'Developer', demandDays: 5 },
        { week: 5, resourceTypeName: 'Developer', demandDays: 5 },
        { week: 6, resourceTypeName: 'Developer', demandDays: 5 },
      ],
    })

    expect(assignments.get('rt-dev')).toEqual(
      expect.objectContaining({
        actualAllocatedDays: 10,
        unallocatedDays: 10,
        namedResources: [
          expect.objectContaining({
            id: 'nr-dev-1',
            actualAllocatedWeeks: [
              { week: 4, days: 5, capacityDays: 5 },
              { week: 5, days: 5, capacityDays: 5 },
            ],
          }),
        ],
      }),
    )
  })

  it('keeps explicit TIMELINE allocationStartWeek open-ended when allocationEndWeek is omitted', () => {
    const assignments = deriveNamedResourceAssignments({
      resourceTypes: [
        {
          id: 'rt-dev',
          name: 'Developer',
          count: 1,
          allocationMode: 'TIMELINE',
          namedResources: [
            {
              id: 'nr-dev-1',
              name: 'Dev 1',
              startWeek: null,
              endWeek: null,
              allocationMode: 'TIMELINE',
              allocationPercent: 100,
              allocationStartWeek: 4,
              allocationEndWeek: null,
            },
          ],
        },
      ],
      weeklyDemand: [
        { week: 3, resourceTypeName: 'Developer', demandDays: 5 },
        { week: 4, resourceTypeName: 'Developer', demandDays: 5 },
        { week: 5, resourceTypeName: 'Developer', demandDays: 5 },
      ],
    })

    expect(assignments.get('rt-dev')).toEqual(
      expect.objectContaining({
        actualAllocatedDays: 10,
        unallocatedDays: 5,
        namedResources: [
          expect.objectContaining({
            id: 'nr-dev-1',
            actualAllocatedWeeks: [
              { week: 4, days: 5, capacityDays: 5 },
              { week: 5, days: 5, capacityDays: 5 },
            ],
          }),
        ],
      }),
    )
  })

  it('CAPACITY_PLAN changing capacity assigns correct weekly limits', () => {
    const rtId = 'rt-cp'
    const periods = [
      { periodIndex: 0, startWeek: 0, endWeek: 4, entries: [{ resourceTypeId: rtId, headcount: 1.0 }] },
      { periodIndex: 1, startWeek: 4, endWeek: 8, entries: [{ resourceTypeId: rtId, headcount: 0.5 }] },
    ]
    const capacityPlanByRt = materializeCapacityPlanResources(periods)

    const assignments = deriveNamedResourceAssignments({
      resourceTypes: [{
        id: rtId,
        name: 'Changing RT',
        allocationMode: 'CAPACITY_PLAN',
        count: 0,
        namedResources: [],
      }],
      weeklyDemand: Array.from({ length: 8 }, (_, w) => ({
        week: w,
        resourceTypeName: 'Changing RT',
        demandDays: 5,
        capacityDays: [0,1,2,3].includes(w) ? 5 : 2.5,
      })),
      capacityPlanByRt,
    })

    const rtAssign = assignments.get(rtId)!
    const nr = rtAssign.namedResources[0]

    // W1-W4 (indices 0-3): 5 days cap; W5-W8 (indices 4-7): 2.5 days cap
    expect(nr.actualAllocatedDays).toBeCloseTo(30, 5) // 4×5 + 4×2.5 = 20+10 = 30

    // Check per-week assignment
    const w0 = nr.actualAllocatedWeeks.find(w => w.week === 0)
    const w4 = nr.actualAllocatedWeeks.find(w => w.week === 4)
    if (w0) expect(w0.capacityDays).toBe(5)
    if (w4) expect(w4.capacityDays).toBe(2.5)
  })

  it('CAPACITY_PLAN discontinuous capacity has gap weeks with zero assigned days', () => {
    const rtId = 'rt-dc'
    const periods = [
      { periodIndex: 0, startWeek: 0, endWeek: 4, entries: [{ resourceTypeId: rtId, headcount: 1.0 }] },
      // Gap weeks 4-7
      { periodIndex: 1, startWeek: 8, endWeek: 12, entries: [{ resourceTypeId: rtId, headcount: 1.0 }] },
    ]
    const capacityPlanByRt = materializeCapacityPlanResources(periods)

    const assignments = deriveNamedResourceAssignments({
      resourceTypes: [{
        id: rtId,
        name: 'Disc RT',
        allocationMode: 'CAPACITY_PLAN',
        count: 0,
        namedResources: [],
      }],
      weeklyDemand: Array.from({ length: 12 }, (_, w) => ({
        week: w,
        resourceTypeName: 'Disc RT',
        demandDays: 5,
        capacityDays: w >= 4 && w < 8 ? 0 : 5,
      })),
      capacityPlanByRt,
    })

    const rtAssign = assignments.get(rtId)!
    const nr = rtAssign.namedResources[0]

    // W1-W4 (indices 0-3): 4×5 = 20; W9-W12 (indices 8-11): 4×5 = 20; gap: 0
    expect(nr.actualAllocatedDays).toBeCloseTo(40, 5)

    // Gap week has zero assigned days
    const gapWeek = nr.actualAllocatedWeeks.find(w => w.week === 5)
    if (gapWeek) expect(gapWeek.days).toBe(0)
    else {
      // If gap week isn't in allocated weeks, that's also correct
      const allWeeks = nr.actualAllocatedWeeks.map(w => w.week)
      expect(allWeeks).not.toContain(5)
    }
  })

  it('CAPACITY_PLAN 1.5 FTE produces correct aggregate and per-resource capacity', () => {
    const rtId = 'rt-15'
    const periods = [
      { periodIndex: 0, startWeek: 0, endWeek: 8, entries: [{ resourceTypeId: rtId, headcount: 1.5 }] },
    ]
    const capacityPlanByRt = materializeCapacityPlanResources(periods)

    const assignments = deriveNamedResourceAssignments({
      resourceTypes: [{
        id: rtId,
        name: 'Big RT',
        allocationMode: 'CAPACITY_PLAN',
        count: 0,
        namedResources: [],
      }],
      weeklyDemand: Array.from({ length: 8 }, (_, w) => ({
        week: w,
        resourceTypeName: 'Big RT',
        demandDays: 10,
        capacityDays: 7.5,
      })),
      capacityPlanByRt,
    })

    const rtAssign = assignments.get(rtId)!
    expect(rtAssign.namedResources).toHaveLength(2)
    const nr0 = rtAssign.namedResources[0]
    const nr1 = rtAssign.namedResources[1]

    expect(nr0.actualAllocatedDays).toBeCloseTo(40, 5) // 8×5 = 40
    expect(nr1.actualAllocatedDays).toBeCloseTo(20, 5) // 8×2.5 = 20
    expect(rtAssign.actualAllocatedDays).toBeCloseTo(60, 5)
  })

  it('CAPACITY_PLAN one existing NR plus one generated residual trajectory', () => {
    const rtId = 'rt-res'
    const nrExistingId = 'nr-existing'
    const periods = [
      { periodIndex: 0, startWeek: 0, endWeek: 8, entries: [{ resourceTypeId: rtId, headcount: 1.5 }] },
    ]
    const capacityPlanByRt = materializeCapacityPlanResources(periods)

    const assignments = deriveNamedResourceAssignments({
      resourceTypes: [{
        id: rtId,
        name: 'Res RT',
        allocationMode: 'CAPACITY_PLAN',
        count: 0,
        namedResources: [{
          id: nrExistingId,
          name: 'Existing',
          startWeek: null,
          endWeek: null,
          allocationMode: 'CAPACITY_PLAN',
          allocationPercent: 100,
          allocationStartWeek: null,
          allocationEndWeek: null,
          pricingModel: 'ACTUAL_DAYS',
        }],
      }],
      weeklyDemand: Array.from({ length: 8 }, (_, w) => ({
        week: w,
        resourceTypeName: 'Res RT',
        demandDays: 10,
        capacityDays: 7.5,
      })),
      capacityPlanByRt,
    })

    const rtAssign = assignments.get(rtId)!
    expect(rtAssign.namedResources).toHaveLength(2)

    // First resource is existing NR
    expect(rtAssign.namedResources[0].id).toBe(nrExistingId)
    expect(rtAssign.namedResources[0].synthetic).toBe(false)

    // Second is generated
    expect(rtAssign.namedResources[1].id).not.toBe(nrExistingId)
    expect(rtAssign.namedResources[1].id).toContain('capacity-plan')
    expect(rtAssign.namedResources[1].synthetic).toBe(true)

    expect(rtAssign.actualAllocatedDays).toBeCloseTo(60, 5)
  })
})
