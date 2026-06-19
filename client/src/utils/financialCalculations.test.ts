import { describe, expect, it } from 'vitest'
import { computeCommercialData } from './financialCalculations'
import type { ResourceProfile } from '../types/backlog'

function baseProfile(overrides: Partial<ResourceProfile>): ResourceProfile {
  return {
    projectId: 'proj-1',
    hoursPerDay: 8,
    projectDurationWeeks: 12,
    bufferWeeks: 0,
    onboardingWeeks: 0,
    resourceRows: [],
    overheadRows: [],
    summary: {
      totalHours: 0,
      totalDays: 0,
      totalCost: null,
      hasCost: true,
    },
    ...overrides,
  }
}

describe('computeCommercialData', () => {
  it('uses actual named-resource assignment days by default', () => {
    const profile = baseProfile({
      resourceRows: [
        {
          resourceTypeId: 'rt-data',
          name: 'Data, AI & IoT',
          category: 'ENGINEERING',
          count: 1,
          hoursPerDay: 8,
          dayRate: 1000,
          totalHours: 488,
          totalDays: 61,
          effortDays: 61,
          allocatedDays: 61,
          allocationMode: 'TIMELINE',
          allocationPercent: 100,
          allocationStartWeek: null,
          allocationEndWeek: null,
          derivedStartWeek: 0,
          derivedEndWeek: 12,
          estimatedCost: 61000,
          epics: [],
          namedResources: [
            {
              id: 'nr-data',
              name: 'Senior Engineer - Data, AI & IoT',
              allocationMode: 'TIMELINE',
              allocationPercent: 100,
              allocationStartWeek: null,
              allocationEndWeek: null,
              startWeek: null,
              endWeek: null,
              allocatedDays: 40.36,
              derivedStartWeek: 4.32,
              derivedEndWeek: 12.4,
              actualAllocatedDays: 61,
              actualAllocationStartWeek: 0,
              actualAllocationEndWeek: 12,
              actualAllocatedWeeks: [],
              actualAllocationSegments: [],
              synthetic: false,
            },
          ],
        },
      ],
    })

    const result = computeCommercialData(profile, [], null)

    expect(result?.rows).toHaveLength(1)
    expect(result?.rows[0]).toMatchObject({
      kind: 'named-resource',
      allocatedDays: 61,
      totalDays: 61,
      subtotal: 61000,
      pricingModel: 'ACTUAL_DAYS',
    })
    expect(result?.subtotal).toBe(61000)
  })

  it('uses planned/pro-rata named-resource days when pricingModel is PRO_RATA', () => {
    const profile = baseProfile({
      resourceRows: [
        {
          resourceTypeId: 'rt-data',
          name: 'Data, AI & IoT',
          category: 'ENGINEERING',
          count: 1,
          hoursPerDay: 8,
          dayRate: 1000,
          totalHours: 488,
          totalDays: 61,
          effortDays: 61,
          allocatedDays: 61,
          allocationMode: 'TIMELINE',
          allocationPercent: 100,
          allocationStartWeek: null,
          allocationEndWeek: null,
          derivedStartWeek: 0,
          derivedEndWeek: 12,
          estimatedCost: 61000,
          epics: [],
          namedResources: [
            {
              id: 'nr-data',
              name: 'Senior Engineer - Data, AI & IoT',
              allocationMode: 'TIMELINE',
              allocationPercent: 100,
              allocationStartWeek: null,
              allocationEndWeek: null,
              startWeek: null,
              endWeek: null,
              allocatedDays: 40.36,
              derivedStartWeek: 4.32,
              derivedEndWeek: 12.4,
              actualAllocatedDays: 61,
              actualAllocationStartWeek: 0,
              actualAllocationEndWeek: 12,
              actualAllocatedWeeks: [],
              actualAllocationSegments: [],
              synthetic: false,
              pricingModel: 'PRO_RATA',
            } as NonNullable<ResourceProfile['resourceRows'][number]['namedResources']>[number] & { pricingModel: 'PRO_RATA' },
          ],
        },
      ],
    })

    const result = computeCommercialData(profile, [], null)

    expect(result?.rows).toHaveLength(1)
    expect(result?.rows[0]).toMatchObject({
      kind: 'named-resource',
      allocatedDays: 40.36,
      totalDays: 40.36,
      subtotal: 40360,
      pricingModel: 'PRO_RATA',
    })
    expect(result?.subtotal).toBe(40360)
  })

  it('calculates aggregate resource subtotal from the displayed allocated days', () => {
    const profile = baseProfile({
      resourceRows: [
        {
          resourceTypeId: 'rt-pm',
          name: 'Project Manager',
          category: 'PROJECT_MANAGEMENT',
          count: 1,
          hoursPerDay: 8,
          dayRate: 1200,
          totalHours: 200,
          totalDays: 25,
          effortDays: 25,
          allocatedDays: 40,
          allocationMode: 'FULL_PROJECT',
          allocationPercent: 100,
          allocationStartWeek: null,
          allocationEndWeek: null,
          derivedStartWeek: null,
          derivedEndWeek: null,
          estimatedCost: 48000,
          epics: [],
          namedResources: [],
        },
      ],
    })

    const result = computeCommercialData(profile, [], null)

    expect(result?.rows).toHaveLength(1)
    expect(result?.rows[0]).toMatchObject({
      kind: 'resource',
      allocatedDays: 40,
      totalDays: 40,
      subtotal: 48000,
    })
    expect(result?.subtotal).toBe(48000)
  })
})
