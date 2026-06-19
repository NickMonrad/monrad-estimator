import { describe, expect, it } from 'vitest'
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
})
