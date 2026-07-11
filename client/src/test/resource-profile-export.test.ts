import { describe, expect, it } from 'vitest'
import { buildProfileCsv } from '@/hooks/useResourceProfileExport'
import type { ResourceProfile } from '@/types/backlog'

function makeProfile(overrides: Partial<ResourceProfile> = {}): ResourceProfile {
  return {
    projectId: 'project-1',
    hoursPerDay: 8,
    projectDurationWeeks: 12,
    bufferWeeks: 0,
    onboardingWeeks: 0,
    resourceRows: [],
    overheadRows: [],
    summary: { totalHours: 0, totalDays: 0, totalCost: null, hasCost: false },
    ...overrides,
  }
}

function parseCsv(csv: string): { headers: string[]; rows: string[][] } {
  const lines = csv.trim().split('\n')
  const headers = lines[0].split(',').map(h => h.replace(/^"|"$/g, ''))
  const rows = lines.slice(1).map(line => {
    // Simple CSV parser — handles quoted fields with commas
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

describe('ResourceProfile CSV Export — authoritative profile columns', () => {
  it('includes Planning basis, Profile source, Default capacity %, Profile start, Profile end headers', () => {
    const profile = makeProfile({
      resourceRows: [
        {
          resourceTypeId: 'rt-dev',
          name: 'Developer',
          category: 'ENGINEERING',
          count: 1,
          hoursPerDay: 8,
          dayRate: 800,
          totalHours: 80,
          totalDays: 10,
          effortDays: 10,
          allocatedDays: 10,
          allocationMode: 'EFFORT',
          allocationPercent: 100,
          allocationStartWeek: null,
          allocationEndWeek: null,
          derivedStartWeek: null,
          derivedEndWeek: null,
          estimatedCost: 8000,
          epics: [],
          capacityProfile: {
            planningBasis: 'demandFollowing',
            source: 'squadPlanner',
            defaultPercent: 50,
            startWeek: 0,
            endWeek: 11,
            segments: [],
            resolutionSource: 'PROFILE',
          },
        },
      ],
    })

    const csv = buildProfileCsv(profile)
    const { headers } = parseCsv(csv)

    expect(headers).toContain('Planning basis')
    expect(headers).toContain('Profile source')
    expect(headers).toContain('Default capacity %')
    expect(headers).toContain('Profile start')
    expect(headers).toContain('Profile end')
  })

  it('uses profile data for availability window when capacityProfile exists', () => {
    const profile = makeProfile({
      resourceRows: [
        {
          resourceTypeId: 'rt-dev',
          name: 'Developer',
          category: 'ENGINEERING',
          count: 1,
          hoursPerDay: 8,
          dayRate: 800,
          totalHours: 80,
          totalDays: 10,
          effortDays: 10,
          allocatedDays: 10,
          allocationMode: 'TIMELINE',
          allocationPercent: 100,
          allocationStartWeek: null,
          allocationEndWeek: null,
          derivedStartWeek: 0,
          derivedEndWeek: 10,
          estimatedCost: null,
          epics: [],
          namedResources: [
            {
              id: 'nr-1',
              name: 'Dev',
              allocationMode: 'TIMELINE',
              allocationPercent: 100,
              allocationStartWeek: null,
              allocationEndWeek: null,
              startWeek: null,
              endWeek: null,
              allocatedDays: 10,
              derivedStartWeek: null,
              derivedEndWeek: null,
              actualAllocatedDays: 0,
              actualAllocationStartWeek: null,
              actualAllocationEndWeek: null,
              actualAllocatedWeeks: [],
              actualAllocationSegments: [],
              synthetic: false,
              capacityProfile: {
                planningBasis: 'availabilityWindow',
                source: 'fixed',
                defaultPercent: 100,
                startWeek: 2,
                endWeek: 9,
                segments: [],
                resolutionSource: 'PROFILE',
              },
            },
          ],
        },
      ],
    })

    const csv = buildProfileCsv(profile)
    const { rows } = parseCsv(csv)

    expect(rows.length).toBe(1)
    const row = rows[0]
    // Column indices: 0=Section, 1=Role, 2=Resource name, 3=Resource identity, 4=Category,
    // 5=Resource count, 6=Hours per day, 7=Effort days, 8=Assigned days, 9=Billable days,
    // 10=Day rate, 11=Subtotal, 12=Planning basis, 13=Profile source, 14=Default capacity %,
    // 15=Profile start, 16=Profile end, 17=Availability window start, 18=Availability window end,
    // 19=Assigned start, 20=Assigned end, 21=Capacity profile segments, 22=Assignment segments,
    // 23=Assigned weeks, 24=Billing basis, 25=Handover notes
    expect(row[12]).toBe('Availability window')  // Planning basis
    expect(row[13]).toBe('fixed')                 // Profile source
    expect(row[14]).toBe('100')                   // Default capacity %
    expect(row[15]).toBe('W3')                    // Profile start (0-indexed → W3)
    expect(row[16]).toBe('W10')                   // Profile end (0-indexed → W10)
    // Availability window uses profile start/end (from named resource's capacityProfile)
    expect(row[17]).toBe('W3')                    // Availability window start
    expect(row[18]).toBe('W10')                   // Availability window end
  })

  it('falls back to legacy fields when no capacityProfile exists', () => {
    const profile = makeProfile({
      resourceRows: [
        {
          resourceTypeId: 'rt-dev',
          name: 'Developer',
          category: 'ENGINEERING',
          count: 1,
          hoursPerDay: 8,
          dayRate: 800,
          totalHours: 80,
          totalDays: 10,
          effortDays: 10,
          allocatedDays: 10,
          allocationMode: 'TIMELINE',
          allocationPercent: 100,
          allocationStartWeek: null,
          allocationEndWeek: null,
          derivedStartWeek: 0,
          derivedEndWeek: 10,
          estimatedCost: null,
          epics: [],
          // No capacityProfile — legacy fallback path
        },
      ],
    })

    const csv = buildProfileCsv(profile)
    const { rows } = parseCsv(csv)

    expect(rows.length).toBe(1)
    const row = rows[0]
    // Planning basis should fall back to allocationMode
    expect(row[12]).toBe('Availability window')  // from allocationMode='TIMELINE'
    expect(row[13]).toBe('')                      // Profile source empty
    expect(row[14]).toBe('')                      // Default capacity % empty
    expect(row[15]).toBe('')                      // Profile start empty
    expect(row[16]).toBe('')                      // Profile end empty
    // Availability window columns empty for role-level (no startWeek/endWeek on row directly)
    expect(row[17]).toBe('')
    expect(row[18]).toBe('')
  })

  it('does not duplicate a named resource per segment — one row per person', () => {
    const profile = makeProfile({
      resourceRows: [
        {
          resourceTypeId: 'rt-dev',
          name: 'Developer',
          category: 'ENGINEERING',
          count: 1,
          hoursPerDay: 8,
          dayRate: 800,
          totalHours: 80,
          totalDays: 10,
          effortDays: 10,
          allocatedDays: 10,
          allocationMode: 'EFFORT',
          allocationPercent: 100,
          allocationStartWeek: null,
          allocationEndWeek: null,
          derivedStartWeek: null,
          derivedEndWeek: null,
          estimatedCost: null,
          epics: [],
          namedResources: [
            {
              id: 'nr-1',
              name: 'Alice',
              allocationMode: 'EFFORT',
              allocationPercent: 100,
              allocationStartWeek: null,
              allocationEndWeek: null,
              startWeek: null,
              endWeek: null,
              allocatedDays: 5,
              derivedStartWeek: null,
              derivedEndWeek: null,
              actualAllocatedDays: 3,
              actualAllocationStartWeek: 2,
              actualAllocationEndWeek: 4,
              actualAllocatedWeeks: [
                { week: 2, days: 1.5, capacityDays: 5 },
                { week: 3, days: 1, capacityDays: 5 },
                { week: 4, days: 0.5, capacityDays: 5 },
              ],
              actualAllocationSegments: [
                { startWeek: 2, endWeek: 4, days: 3 },
              ],
              synthetic: false,
              capacityProfile: {
                planningBasis: 'demandFollowing',
                source: 'squadPlanner',
                defaultPercent: 50,
                startWeek: 0,
                endWeek: 11,
                segments: [
                  { startWeek: 0, endWeek: 5, capacityPercent: 50 },
                  { startWeek: 6, endWeek: 11, capacityPercent: 75 },
                ],
                resolutionSource: 'PROFILE',
              },
            },
          ],
        },
      ],
    })

    const csv = buildProfileCsv(profile)
    const { rows, headers } = parseCsv(csv)

    // One named resource → one data row
    const resourceRows = rows.filter(r => r[0] === 'Resource')
    expect(resourceRows.length).toBe(1)

    const row = resourceRows[0]
    const nameCol = headers.indexOf('Resource name')
    expect(row[nameCol]).toBe('Alice')
  })

  it('includes actual assignment data separately in CSV columns', () => {
    const profile = makeProfile({
      resourceRows: [
        {
          resourceTypeId: 'rt-dev',
          name: 'Developer',
          category: 'ENGINEERING',
          count: 1,
          hoursPerDay: 8,
          dayRate: 800,
          totalHours: 80,
          totalDays: 10,
          effortDays: 10,
          allocatedDays: 10,
          allocationMode: 'EFFORT',
          allocationPercent: 100,
          allocationStartWeek: null,
          allocationEndWeek: null,
          derivedStartWeek: null,
          derivedEndWeek: null,
          estimatedCost: null,
          epics: [],
          namedResources: [
            {
              id: 'nr-1',
              name: 'Bob',
              allocationMode: 'EFFORT',
              allocationPercent: 100,
              allocationStartWeek: null,
              allocationEndWeek: null,
              startWeek: null,
              endWeek: null,
              allocatedDays: 5,
              derivedStartWeek: null,
              derivedEndWeek: null,
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
              capacityProfile: {
                planningBasis: 'demandFollowing',
                source: 'squadPlanner',
                defaultPercent: 50,
                startWeek: 0,
                endWeek: 11,
                segments: [
                  { startWeek: 0, endWeek: 5, capacityPercent: 50 },
                  { startWeek: 6, endWeek: 11, capacityPercent: 75 },
                ],
                resolutionSource: 'PROFILE',
              },
            },
          ],
        },
      ],
    })

    const csv = buildProfileCsv(profile)
    const { rows, headers } = parseCsv(csv)
    const row = rows[0]

    const assignedStartIdx = headers.indexOf('Assigned start')
    const assignedEndIdx = headers.indexOf('Assigned end')
    const capSegmentsIdx = headers.indexOf('Capacity profile segments')
    const assignSegmentsIdx = headers.indexOf('Assignment segments')
    const assignedWeeksIdx = headers.indexOf('Assigned weeks')

    // Assigned start/end from actualAllocation
    expect(row[assignedStartIdx]).toBe('W3')
    expect(row[assignedEndIdx]).toBe('W4')

    // Capacity profile segments (ASCII-safe — dashes replaced)
    expect(row[capSegmentsIdx]).toContain('W1-W6 50%')
    expect(row[capSegmentsIdx]).toContain('W7-W12 75%')

    // Assignment segments
    expect(row[assignSegmentsIdx]).toContain('W3-W4')

    // Assigned weeks detail
    expect(row[assignedWeeksIdx]).toContain('W3=1.50')
    expect(row[assignedWeeksIdx]).toContain('W4=1.00')
  })

  it('escapes non-ASCII characters in capacity profile segments', () => {
    const profile = makeProfile({
      resourceRows: [
        {
          resourceTypeId: 'rt-dev',
          name: 'Developer',
          category: 'ENGINEERING',
          count: 1,
          hoursPerDay: 8,
          dayRate: 800,
          totalHours: 80,
          totalDays: 10,
          effortDays: 10,
          allocatedDays: 10,
          allocationMode: 'EFFORT',
          allocationPercent: 100,
          allocationStartWeek: null,
          allocationEndWeek: null,
          derivedStartWeek: null,
          derivedEndWeek: null,
          estimatedCost: null,
          epics: [],
          capacityProfile: {
            planningBasis: 'demandFollowing',
            source: 'squadPlanner',
            defaultPercent: null,
            startWeek: null,
            endWeek: null,
            segments: [
              { startWeek: 0, endWeek: 3, capacityPercent: 50 },
            ],
            resolutionSource: 'PROFILE',
          },
        },
      ],
    })

    const csv = buildProfileCsv(profile)
    // The CSV should be plain ASCII-safe
    expect(() => Buffer.from(csv, 'utf-8')).not.toThrow()
    // All characters should be under 0x80 (ASCII range)
    for (let i = 0; i < csv.length; i++) {
      expect(csv.charCodeAt(i)).toBeLessThan(0x80)
    }
  })
})
