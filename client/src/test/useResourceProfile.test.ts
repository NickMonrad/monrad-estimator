import { describe, expect, it } from 'vitest'
import { buildProfileCsv } from '@/hooks/useResourceProfile'
import type { ResourceProfile } from '@/types/backlog'

describe('buildProfileCsv', () => {
  it('exports named-resource rows with week allocations using ASCII-safe labels', () => {
    const profile: ResourceProfile = {
      projectId: 'project-1',
      hoursPerDay: 8,
      projectDurationWeeks: 12,
      bufferWeeks: 0,
      onboardingWeeks: 0,
      resourceRows: [
        {
          resourceTypeId: 'rt-security',
          name: 'Security Consultant',
          category: 'GOVERNANCE',
          count: 1,
          hoursPerDay: 8,
          dayRate: 1200,
          totalHours: 40,
          totalDays: 10,
          effortDays: 10,
          allocatedDays: 10,
          allocationMode: 'EFFORT',
          allocationPercent: 100,
          allocationStartWeek: null,
          allocationEndWeek: null,
          derivedStartWeek: 2,
          derivedEndWeek: 3,
          estimatedCost: 12000,
          epics: [],
          namedResources: [
            {
              id: 'nr-1',
              name: 'Alex — Security',
              allocationMode: 'EFFORT',
              allocationPercent: 100,
              allocationStartWeek: null,
              allocationEndWeek: null,
              startWeek: null,
              endWeek: null,
              allocatedDays: 10,
              derivedStartWeek: 2,
              derivedEndWeek: 3,
              actualAllocatedDays: 2.5,
              actualAllocationStartWeek: 2,
              actualAllocationEndWeek: 3,
              actualAllocatedWeeks: [
                { week: 2, days: 1.5, capacityDays: 5 },
                { week: 3, days: 1, capacityDays: 5 },
              ],
              actualAllocationSegments: [
                { startWeek: 2, endWeek: 3, days: 2.5 },
              ],
              synthetic: false,
            },
          ],
        },
      ],
      overheadRows: [],
      summary: {
        totalHours: 40,
        totalDays: 10,
        totalCost: 12000,
        hasCost: true,
      },
    }

    const csv = buildProfileCsv(profile)

    expect(csv).toContain('Section,Role,NamedResource')
    expect(csv).toContain('Resource,Security Consultant,Alex - Security,No')
    expect(csv).toContain('W3-W4 (2.50d)')
    expect(csv).toContain('W3=1.50; W4=1.00')
    expect(csv).not.toContain('—')
    expect(csv).not.toContain('×')
  })
})
