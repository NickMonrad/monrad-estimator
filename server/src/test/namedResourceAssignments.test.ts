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
    // Profile-derived resolver output (issue #418): the ROLE profile segments
    // are the sole capacity source — no active-plan fallback exists.
    const assignments = deriveNamedResourceAssignments({
      resourceTypes: [{
        id: rtId,
        name: 'Changing RT',
        allocationMode: 'CAPACITY_PLAN',
        count: 0,
        namedResources: [],
        roleSegments: [
          { startWeek: 0, endWeek: 3, allocationPercent: 100 },
          { startWeek: 4, endWeek: 7, allocationPercent: 50 },
        ],
      }],
      weeklyDemand: Array.from({ length: 8 }, (_, w) => ({
        week: w,
        resourceTypeName: 'Changing RT',
        demandDays: 5,
        capacityDays: [0,1,2,3].includes(w) ? 5 : 2.5,
      })),
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
    // Profile-derived role segments with a capacity gap (issue #418).
    const assignments = deriveNamedResourceAssignments({
      resourceTypes: [{
        id: rtId,
        name: 'Disc RT',
        allocationMode: 'CAPACITY_PLAN',
        count: 0,
        namedResources: [],
        roleSegments: [
          { startWeek: 0, endWeek: 3, allocationPercent: 100 },
          { startWeek: 8, endWeek: 11, allocationPercent: 100 },
        ],
      }],
      weeklyDemand: Array.from({ length: 12 }, (_, w) => ({
        week: w,
        resourceTypeName: 'Disc RT',
        demandDays: 5,
        capacityDays: w >= 4 && w < 8 ? 0 : 5,
      })),
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
    // Profile-derived planned resources: a 100% trajectory and a 50% residual.
    const assignments = deriveNamedResourceAssignments({
      resourceTypes: [{
        id: rtId,
        name: 'Big RT',
        allocationMode: 'CAPACITY_PLAN',
        count: 2,
        namedResources: [
          {
            id: 'nr-full', name: 'Full',
            startWeek: 0, endWeek: 7,
            allocationMode: 'CAPACITY_PLAN',
            allocationPercent: 100,
            allocationStartWeek: null,
            allocationEndWeek: null,
            capacitySegments: [{ startWeek: 0, endWeek: 7, allocationPercent: 100 }],
          },
          {
            id: 'nr-half', name: 'Half',
            startWeek: 0, endWeek: 7,
            allocationMode: 'CAPACITY_PLAN',
            allocationPercent: 50,
            allocationStartWeek: null,
            allocationEndWeek: null,
            capacitySegments: [{ startWeek: 0, endWeek: 7, allocationPercent: 50 }],
          },
        ],
      }],
      weeklyDemand: Array.from({ length: 8 }, (_, w) => ({
        week: w,
        resourceTypeName: 'Big RT',
        demandDays: 10,
        capacityDays: 7.5,
      })),
    })

    const rtAssign = assignments.get(rtId)!
    expect(rtAssign.namedResources).toHaveLength(2)
    const nr0 = rtAssign.namedResources[0]
    const nr1 = rtAssign.namedResources[1]

    expect(nr0.actualAllocatedDays).toBeCloseTo(40, 5) // 8×5 = 40
    expect(nr1.actualAllocatedDays).toBeCloseTo(20, 5) // 8×2.5 = 20
    expect(rtAssign.actualAllocatedDays).toBeCloseTo(60, 5)
  })

  it('CAPACITY_PLAN one existing NR plus one residual planned resource', () => {
    const rtId = 'rt-res'
    const nrExistingId = 'nr-existing'
    // Profile-derived: the residual 0.5 FTE is a persisted planned resource
    // with its own authoritative segments (issue #418 — no synthetic
    // trajectories are generated in the assignment layer).
    const assignments = deriveNamedResourceAssignments({
      resourceTypes: [{
        id: rtId,
        name: 'Res RT',
        allocationMode: 'CAPACITY_PLAN',
        count: 2,
        namedResources: [
          {
            id: nrExistingId,
            name: 'Existing',
            startWeek: 0,
            endWeek: 7,
            allocationMode: 'CAPACITY_PLAN',
            allocationPercent: 100,
            allocationStartWeek: null,
            allocationEndWeek: null,
            pricingModel: 'ACTUAL_DAYS',
            capacitySegments: [{ startWeek: 0, endWeek: 7, allocationPercent: 100 }],
          },
          {
            id: 'nr-residual',
            name: 'Residual',
            startWeek: 0,
            endWeek: 7,
            allocationMode: 'CAPACITY_PLAN',
            allocationPercent: 50,
            allocationStartWeek: null,
            allocationEndWeek: null,
            pricingModel: 'ACTUAL_DAYS',
            capacitySegments: [{ startWeek: 0, endWeek: 7, allocationPercent: 50 }],
          },
        ],
      }],
      weeklyDemand: Array.from({ length: 8 }, (_, w) => ({
        week: w,
        resourceTypeName: 'Res RT',
        demandDays: 10,
        capacityDays: 7.5,
      })),
    })

    const rtAssign = assignments.get(rtId)!
    expect(rtAssign.namedResources).toHaveLength(2)

    // First resource is existing NR
    expect(rtAssign.namedResources[0].id).toBe(nrExistingId)
    expect(rtAssign.namedResources[0].synthetic).toBe(false)

    // Second is the persisted residual planned resource (identity preserved)
    expect(rtAssign.namedResources[1].id).toBe('nr-residual')
    expect(rtAssign.namedResources[1].synthetic).toBe(false)

    expect(rtAssign.actualAllocatedDays).toBeCloseTo(60, 5)
  })
})

describe('roleSegments limit named-resource assignment (fix 1)', () => {
  it('fixed role profile limits named-resource assignment when no NRs exist', () => {
    const assignments = deriveNamedResourceAssignments({
      resourceTypes: [
        {
          id: 'rt-role',
          name: 'Role-Dev',
          count: 2,
          allocationMode: 'EFFORT',
          namedResources: [],
          roleSegments: [
            { startWeek: 0, endWeek: 10, allocationPercent: 50 },
          ],
        },
      ],
      weeklyDemand: Array.from({ length: 8 }, (_, w) => ({
        week: w,
        resourceTypeName: 'Role-Dev',
        demandDays: 5,
      })),
    })

    const rtAssign = assignments.get('rt-role')!
    // Role profile at 50% = 2.5 days/week (not 2 × 5 = 10 from count)
    expect(rtAssign.namedResources).toHaveLength(1)
    expect(rtAssign.namedResources[0].synthetic).toBe(true)
    expect(rtAssign.namedResources[0].id).toBe('rt-role-role')
    // Each week: min(5 demand, 2.5 capacity) = 2.5 days × 8 weeks
    expect(rtAssign.actualAllocatedDays).toBeCloseTo(20, 5)
    expect(rtAssign.unallocatedDays).toBeCloseTo(20, 5)
  })

  it('segmented role profile changes assignment capacity by week', () => {
    const assignments = deriveNamedResourceAssignments({
      resourceTypes: [
        {
          id: 'rt-seg',
          name: 'Segmented',
          count: 3,
          allocationMode: 'EFFORT',
          namedResources: [],
          roleSegments: [
            { startWeek: 0, endWeek: 3, allocationPercent: 100 },
            { startWeek: 6, endWeek: 9, allocationPercent: 50 },
          ],
        },
      ],
      weeklyDemand: Array.from({ length: 10 }, (_, w) => ({
        week: w,
        resourceTypeName: 'Segmented',
        demandDays: 10,
      })),
    })

    const rtAssign = assignments.get('rt-seg')!
    expect(rtAssign.namedResources).toHaveLength(1)
    const roleNR = rtAssign.namedResources[0]

    // Weeks 0-3: 100% → 5 days/week, demand 10 → only 5 allocated
    const w0 = roleNR.actualAllocatedWeeks.find(w => w.week === 0)
    expect(w0?.capacityDays).toBe(5)

    // Weeks 4-5: gap (zero capacity) → nothing allocated
    const w4 = roleNR.actualAllocatedWeeks.find(w => w.week === 4)
    expect(w4).toBeUndefined()

    // Weeks 6-9: 50% → 2.5 days/week, demand 10 → only 2.5 allocated
    const w6 = roleNR.actualAllocatedWeeks.find(w => w.week === 6)
    expect(w6?.capacityDays).toBe(2.5)

    expect(rtAssign.actualAllocatedDays).toBeCloseTo(4 * 5 + 4 * 2.5, 5) // 20 + 10 = 30
  })

  it('gap between role segments produces zero assignment capacity', () => {
    const assignments = deriveNamedResourceAssignments({
      resourceTypes: [
        {
          id: 'rt-gap',
          name: 'Gapped',
          count: 2,
          allocationMode: 'EFFORT',
          namedResources: [],
          roleSegments: [
            { startWeek: 0, endWeek: 2, allocationPercent: 100 },
            { startWeek: 6, endWeek: 8, allocationPercent: 100 },
          ],
        },
      ],
      weeklyDemand: Array.from({ length: 9 }, (_, w) => ({
        week: w,
        resourceTypeName: 'Gapped',
        demandDays: 10,
      })),
    })

    const rtAssign = assignments.get('rt-gap')!
    expect(rtAssign.namedResources).toHaveLength(1)
    const roleNR = rtAssign.namedResources[0]

    // Weeks 0-2: 5 days/week
    expect(roleNR.actualAllocatedWeeks.filter(w => w.week <= 2).length).toBe(3)
    // Weeks 3-5: gap → nothing
    expect(roleNR.actualAllocatedWeeks.find(w => w.week === 3)).toBeUndefined()
    expect(roleNR.actualAllocatedWeeks.find(w => w.week === 4)).toBeUndefined()
    expect(roleNR.actualAllocatedWeeks.find(w => w.week === 5)).toBeUndefined()
    // Weeks 6-8: 5 days/week
    expect(roleNR.actualAllocatedWeeks.filter(w => w.week >= 6).length).toBe(3)
  })

  it('valid role profile on CAPACITY_PLAN resource type suppresses active-plan fallback', () => {
    const periods = [
      { periodIndex: 0, startWeek: 0, endWeek: 8, entries: [{ resourceTypeId: 'rt-cp', headcount: 3 }] },
    ]
    void materializeCapacityPlanResources(periods)

    // Even though the RT has CAPACITY_PLAN mode and a plan exists, the role
    // profile should suppress plan fallback: assignment uses roleSegments.
    const assignments = deriveNamedResourceAssignments({
      resourceTypes: [
        {
          id: 'rt-cp',
          name: 'Plan-Dev',
          count: 3,
          allocationMode: 'CAPACITY_PLAN',
          namedResources: [],
          roleSegments: [
            { startWeek: 0, endWeek: 8, allocationPercent: 50 },
          ],
        },
      ],
      weeklyDemand: Array.from({ length: 8 }, (_, w) => ({
        week: w,
        resourceTypeName: 'Plan-Dev',
        demandDays: 10,
      })),
    })

    const rtAssign = assignments.get('rt-cp')!
    // Role profile at 50% = 2.5 days/week (not 3 × 5 from plan or 3 × 5 from count)
    expect(rtAssign.namedResources).toHaveLength(1)
    expect(rtAssign.namedResources[0].id).toBe('rt-cp-role')
    expect(rtAssign.actualAllocatedDays).toBeCloseTo(8 * 2.5, 5) // 20
  })

  it('role profile with existing named resources produces correct combined assignment', () => {
    const assignments = deriveNamedResourceAssignments({
      resourceTypes: [
        {
          id: 'rt-comb',
          name: 'Combined',
          count: 3,
          allocationMode: 'EFFORT',
          namedResources: [
            {
              id: 'nr-alice',
              name: 'Alice',
              startWeek: null,
              endWeek: null,
              allocationMode: 'EFFORT',
              allocationPercent: 100,
              allocationStartWeek: null,
              allocationEndWeek: null,
            },
          ],
          roleSegments: [
            { startWeek: 0, endWeek: 10, allocationPercent: 100 },
          ],
        },
      ],
      weeklyDemand: Array.from({ length: 8 }, (_, w) => ({
        week: w,
        resourceTypeName: 'Combined',
        demandDays: 15, // More than total capacity (5 + 5 = 10)
      })),
    })

    const rtAssign = assignments.get('rt-comb')!
    // Alice (5 days/week) + role (5 days/week) = 10 total
    expect(rtAssign.namedResources).toHaveLength(2)

    const alice = rtAssign.namedResources.find(nr => nr.id === 'nr-alice')
    expect(alice!.actualAllocatedDays).toBeCloseTo(40, 5) // 5 × 8 = 40

    const roleNR = rtAssign.namedResources.find(nr => nr.id === 'rt-comb-role')
    expect(roleNR).toBeDefined()
    expect(roleNR!.actualAllocatedDays).toBeCloseTo(40, 5) // 5 × 8 = 40

    expect(rtAssign.actualAllocatedDays).toBeCloseTo(80, 5) // 10 × 8 = 80
    expect(rtAssign.unallocatedDays).toBeCloseTo(40, 5) // (15 - 10) × 8 = 40
  })
})

describe('consumer parity: resolver output drives assignments (remediation)', () => {
  it('resolver output with capacityPlanResolved prevents plan rematerialization in assignments', () => {
    // Simulate resolver output: A(100% trajectory), B(50% profile)
    const rtId = 'rt-parity'
    const periods = [
      { periodIndex: 0, startWeek: 0, endWeek: 8,
        entries: [{ resourceTypeId: rtId, headcount: 2 }] },
    ]
    void materializeCapacityPlanResources(periods)

    const assignments = deriveNamedResourceAssignments({
      resourceTypes: [{
        id: rtId,
        name: 'Parity',
        count: 2,
        allocationMode: 'CAPACITY_PLAN',
        // This is the resolver output: already resolved, don't rematerialize
        namedResources: [
          {
            id: 'nr-a', name: 'Resource A',
            startWeek: 0, endWeek: 7,
            allocationMode: 'CAPACITY_PLAN',
            allocationPercent: 100,
            allocationStartWeek: null,
            allocationEndWeek: null,
            capacitySegments: [
              { startWeek: 0, endWeek: 7, allocationPercent: 100 },
            ],
          },
          {
            id: 'nr-b', name: 'Resource B',
            startWeek: 0, endWeek: 7,
            allocationMode: 'CAPACITY_PLAN',
            allocationPercent: 50,
            allocationStartWeek: null,
            allocationEndWeek: null,
            capacitySegments: [
              { startWeek: 0, endWeek: 7, allocationPercent: 50 },
            ],
          },
        ],
      }],
      weeklyDemand: Array.from({ length: 8 }, (_, w) => ({
        week: w,
        resourceTypeName: 'Parity',
        demandDays: 10,
      })),
    })

    const rtAssign = assignments.get(rtId)!
    // Must have exactly the 2 NRs from resolver (not rematerialized)
    expect(rtAssign.namedResources).toHaveLength(2)
    expect(rtAssign.namedResources[0].id).toBe('nr-a')
    expect(rtAssign.namedResources[1].id).toBe('nr-b')

    // A: 100% → 5d/wk × 8 = 40d
    // B: 50% → 2.5d/wk × 8 = 20d
    // Total: 60d, demand 80d → 20d unallocated
    expect(rtAssign.actualAllocatedDays).toBeCloseTo(60, 5)
    expect(rtAssign.unallocatedDays).toBeCloseTo(20, 5)

    // Verify no synthetic resources were added
    const synthetics = rtAssign.namedResources.filter(nr => nr.synthetic)
    expect(synthetics).toHaveLength(0)
  })

  it('profile-derived input without any plan fallback produces the expected assignment', () => {
    // The active-plan fallback was removed (issue #418): the assignment layer
    // consumes the resolver's profile-derived DTOs only.
    const rtId = 'rt-nr'
    const assignments = deriveNamedResourceAssignments({
      resourceTypes: [{
        id: rtId,
        name: 'NoResolve',
        count: 1,
        allocationMode: 'CAPACITY_PLAN',
        namedResources: [
          {
            id: 'nr-a', name: 'Resource A',
            startWeek: 0, endWeek: 7,
            allocationMode: 'CAPACITY_PLAN',
            allocationPercent: 100,
            allocationStartWeek: null,
            allocationEndWeek: null,
            capacitySegments: [{ startWeek: 0, endWeek: 7, allocationPercent: 100 }],
          },
        ],
      }],
      weeklyDemand: Array.from({ length: 8 }, (_, w) => ({
        week: w,
        resourceTypeName: 'NoResolve',
        demandDays: 10,
      })),
    })

    const rtAssign = assignments.get(rtId)!
    expect(rtAssign.namedResources).toHaveLength(1)
    expect(rtAssign.namedResources[0].id).toBe('nr-a')
    expect(rtAssign.actualAllocatedDays).toBeCloseTo(40, 5) // 5d/wk × 8
    expect(rtAssign.unallocatedDays).toBeCloseTo(40, 5)
  })
})
