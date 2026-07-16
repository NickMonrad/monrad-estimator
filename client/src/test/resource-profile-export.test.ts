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
  it('includes Availability pattern, Profile source, Default capacity %, Profile start, Profile end headers', () => {
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

    expect(headers).toContain('Availability pattern')
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
    // 10=Day rate, 11=Subtotal, 12=Availability pattern, 13=Profile source, 14=Default capacity %,
    // 15=Profile start, 16=Profile end, 17=Available from, 18=Available to,
    // 19=Assigned start, 20=Assigned end, 21=Capacity profile segments, 22=Assignment segments,
    // 23=Assigned weeks, 24=Billing basis, 25=Handover notes
    expect(row[12]).toBe('Fixed for selected weeks')  // Availability pattern
    expect(row[13]).toBe('Fixed')                 // Profile source
    expect(row[14]).toBe('100')                   // Default capacity %
    expect(row[15]).toBe('W3')                    // Profile start (0-indexed → W3)
    expect(row[16]).toBe('W10')                   // Profile end (0-indexed → W10)
    // Availability window uses profile start/end (from named resource's capacityProfile)
    expect(row[17]).toBe('W3')                    // Available from
    expect(row[18]).toBe('W10')                   // Available to
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
    expect(row[12]).toBe('Fixed for selected weeks')  // from allocationMode='TIMELINE'
    expect(row[13]).toBe('')                      // Profile source empty
    expect(row[14]).toBe('')                      // Default capacity % empty
    expect(row[15]).toBe('')                      // Profile start empty
    expect(row[16]).toBe('')                      // Profile end empty
    // Legacy availability fields are exported only when no profile resolves.
    expect(row[17]).toBe('W1')
    expect(row[18]).toBe('W11')
  })

  it('authoritative no-window profile produces empty profile and availability-window CSV fields despite stale legacy windows', () => {
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
          allocationStartWeek: 2,
          allocationEndWeek: 9,
          derivedStartWeek: 0,
          derivedEndWeek: 10,
          estimatedCost: null,
          epics: [],
          namedResources: [
            {
              id: 'nr-dev',
              name: 'Dev',
              allocationMode: 'TIMELINE',
              allocationPercent: 100,
              allocationStartWeek: 2,
              allocationEndWeek: 9,
              startWeek: 2,
              endWeek: 9,
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
                source: 'availabilityWindow',
                defaultPercent: null,
                startWeek: null,
                endWeek: null,
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
    // Planning basis from profile
    expect(row[12]).toBe('Fixed for selected weeks')
    // Provenance stays source-oriented; it must not reuse the planning-basis label.
    expect(row[13]).toBe('Availability window')
    // Default capacity % is null in profile
    expect(row[14]).toBe('')
    // Profile start/end are null → empty
    expect(row[15]).toBe('')
    expect(row[16]).toBe('')
    // Availability window columns empty — profile has no window, legacy fields ignored
    expect(row[17]).toBe('')
    expect(row[18]).toBe('')
  })

  it.each([
    ['start-only', 2, null, 'W3', ''],
    ['end-only', null, 9, '', 'W10'],
  ] as const)('exports authoritative %s boundaries without legacy fallback', (_case, startWeek, endWeek, expectedStart, expectedEnd) => {
    const profile = makeProfile({
      resourceRows: [{
        resourceTypeId: 'rt-dev', name: 'Developer', category: 'ENGINEERING', count: 1,
        hoursPerDay: 8, dayRate: 800, totalHours: 80, totalDays: 10, effortDays: 10, allocatedDays: 10,
        allocationMode: 'TIMELINE', allocationPercent: 100,
        allocationStartWeek: 3, allocationEndWeek: 7, derivedStartWeek: 4, derivedEndWeek: 8,
        estimatedCost: null, epics: [], namedResources: [],
        capacityProfile: {
          planningBasis: 'availabilityWindow', source: 'availabilityWindow', defaultPercent: 75,
          startWeek, endWeek, segments: [], resolutionSource: 'PROFILE',
        },
      }],
    })

    const { rows } = parseCsv(buildProfileCsv(profile))
    expect(rows[0][17]).toBe(expectedStart)
    expect(rows[0][18]).toBe(expectedEnd)
    expect(rows[0][13]).toBe('Availability window')
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

describe('capacity profile CSV export — trajectory tests', () => {
  it('exports constant partial capacity (50%) trajectory', () => {
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
          allocationPercent: 50,
          allocationStartWeek: null,
          allocationEndWeek: null,
          derivedStartWeek: 0,
          derivedEndWeek: 9,
          estimatedCost: null,
          epics: [],
          namedResources: [
            {
              id: 'nr-const',
              name: 'Dev',
              allocationMode: 'TIMELINE',
              allocationPercent: 50,
              allocationStartWeek: null,
              allocationEndWeek: null,
              startWeek: 0,
              endWeek: 7,
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
                planningBasis: 'capacityProfile',
                source: 'squadPlanner',
                defaultPercent: 50,
                startWeek: 0,
                endWeek: 7,
                segments: [
                  { startWeek: 0, endWeek: 7, capacityPercent: 50 },
                ],
                resolutionSource: 'PROFILE',
              },
            },
          ],
        },
      ],
    })

    const csv = buildProfileCsv(profile)
    const { rows } = parseCsv(csv)

    // One resource row
    const resourceRows = rows.filter(r => r[0] === 'Resource')
    expect(resourceRows.length).toBe(1)
    const row = resourceRows[0]

    // Default capacity is 50%
    expect(row[14]).toBe('50')
    // Capacity profile segments show 50%, not 100%
    expect(row[21]).toBe('W1-W8 50%')
  })

  it('exports changing capacity (100%→50%) trajectory', () => {
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
          derivedStartWeek: 0,
          derivedEndWeek: 9,
          estimatedCost: null,
          epics: [],
          namedResources: [
            {
              id: 'nr-change',
              name: 'Dev',
              allocationMode: 'TIMELINE',
              allocationPercent: 100,
              allocationStartWeek: null,
              allocationEndWeek: null,
              startWeek: 0,
              endWeek: 7,
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
                planningBasis: 'capacityProfile',
                source: 'squadPlanner',
                defaultPercent: null,
                startWeek: 0,
                endWeek: 7,
                segments: [
                  { startWeek: 0, endWeek: 3, capacityPercent: 100 },
                  { startWeek: 4, endWeek: 7, capacityPercent: 50 },
                ],
                resolutionSource: 'PROFILE',
              },
            },
          ],
        },
      ],
    })

    const csv = buildProfileCsv(profile)
    const { rows } = parseCsv(csv)

    const resourceRows = rows.filter(r => r[0] === 'Resource')
    // One resource row (one trajectory, not two)
    expect(resourceRows.length).toBe(1)
    const row = resourceRows[0]

    // Default capacity is blank (null defaultPercent)
    expect(row[14]).toBe('')
    // Two segments exported: 100% and 50%
    expect(row[21]).toBe('W1-W4 100%; W5-W8 50%')
  })

  it('exports discontinuous capacity trajectory', () => {
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
          derivedStartWeek: 0,
          derivedEndWeek: 11,
          estimatedCost: null,
          epics: [],
          namedResources: [
            {
              id: 'nr-disc',
              name: 'Dev',
              allocationMode: 'TIMELINE',
              allocationPercent: 100,
              allocationStartWeek: null,
              allocationEndWeek: null,
              startWeek: 0,
              endWeek: 11,
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
                planningBasis: 'capacityProfile',
                source: 'squadPlanner',
                defaultPercent: null,
                startWeek: 0,
                endWeek: 11,
                segments: [
                  { startWeek: 0, endWeek: 3, capacityPercent: 100 },
                  { startWeek: 8, endWeek: 11, capacityPercent: 100 },
                ],
                resolutionSource: 'PROFILE',
              },
            },
          ],
        },
      ],
    })

    const csv = buildProfileCsv(profile)
    const { rows } = parseCsv(csv)

    const resourceRows = rows.filter(r => r[0] === 'Resource')
    // One resource row (not two rows for two segments)
    expect(resourceRows.length).toBe(1)
    const row = resourceRows[0]

    // Two separated segments — gap (W5-W8) not filled
    expect(row[21]).toBe('W1-W4 100%; W9-W12 100%')
    // No segment covering the gap
    expect(row[21]).not.toMatch(/W5/i)
    expect(row[21]).not.toMatch(/W6/i)
    expect(row[21]).not.toMatch(/W7/i)
    expect(row[21]).not.toMatch(/W8/i)
  })

  it('exports 1.5 FTE as two rows', () => {
    const profile = makeProfile({
      resourceRows: [
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
          allocationPercent: 150,
          allocationStartWeek: null,
          allocationEndWeek: null,
          derivedStartWeek: 0,
          derivedEndWeek: 9,
          estimatedCost: null,
          epics: [],
          namedResources: [
            {
              id: 'nr-100',
              name: 'Resource 1',
              allocationMode: 'TIMELINE',
              allocationPercent: 100,
              allocationStartWeek: null,
              allocationEndWeek: null,
              startWeek: 0,
              endWeek: 7,
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
                planningBasis: 'capacityProfile',
                source: 'squadPlanner',
                defaultPercent: 100,
                startWeek: 0,
                endWeek: 7,
                segments: [
                  { startWeek: 0, endWeek: 7, capacityPercent: 100 },
                ],
                resolutionSource: 'PROFILE',
              },
            },
            {
              id: 'nr-50',
              name: 'Resource 2',
              allocationMode: 'TIMELINE',
              allocationPercent: 50,
              allocationStartWeek: null,
              allocationEndWeek: null,
              startWeek: 0,
              endWeek: 7,
              allocatedDays: 5,
              derivedStartWeek: null,
              derivedEndWeek: null,
              actualAllocatedDays: 0,
              actualAllocationStartWeek: null,
              actualAllocationEndWeek: null,
              actualAllocatedWeeks: [],
              actualAllocationSegments: [],
              synthetic: false,
              capacityProfile: {
                planningBasis: 'capacityProfile',
                source: 'squadPlanner',
                defaultPercent: 50,
                startWeek: 0,
                endWeek: 7,
                segments: [
                  { startWeek: 0, endWeek: 7, capacityPercent: 50 },
                ],
                resolutionSource: 'PROFILE',
              },
            },
          ],
        },
      ],
    })

    const csv = buildProfileCsv(profile)
    const { rows } = parseCsv(csv)

    const resourceRows = rows.filter(r => r[0] === 'Resource')
    // Two rows for 1.5 FTE (100% + 50%)
    expect(resourceRows.length).toBe(2)

    // First row: 100% capacity
    expect(resourceRows[0][2]).toBe('Resource 1')
    expect(resourceRows[0][14]).toBe('100')
    expect(resourceRows[0][21]).toContain('100%')
    // Second row: 50% capacity (not 100%)
    expect(resourceRows[1][2]).toBe('Resource 2')
    expect(resourceRows[1][14]).toBe('50')
    expect(resourceRows[1][21]).toContain('50%')
  })

  it('exports planned resource with identity', () => {
    const profile = makeProfile({
      resourceRows: [
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
          allocationPercent: 200,
          allocationStartWeek: null,
          allocationEndWeek: null,
          derivedStartWeek: 0,
          derivedEndWeek: 9,
          estimatedCost: null,
          epics: [],
          namedResources: [
            {
              id: 'nr-planned',
              name: 'Planned Resource',
              allocationMode: 'TIMELINE',
              allocationPercent: 100,
              allocationStartWeek: null,
              allocationEndWeek: null,
              startWeek: 0,
              endWeek: 7,
              allocatedDays: 10,
              derivedStartWeek: null,
              derivedEndWeek: null,
              actualAllocatedDays: 0,
              actualAllocationStartWeek: null,
              actualAllocationEndWeek: null,
              actualAllocatedWeeks: [],
              actualAllocationSegments: [],
              synthetic: true,
              capacityProfile: {
                planningBasis: 'capacityProfile',
                source: 'squadPlanner',
                defaultPercent: 100,
                startWeek: 0,
                endWeek: 7,
                segments: [
                  { startWeek: 0, endWeek: 7, capacityPercent: 100 },
                ],
                resolutionSource: 'PROFILE',
              },
            },
            {
              id: 'nr-named',
              name: 'Named Person',
              allocationMode: 'TIMELINE',
              allocationPercent: 100,
              allocationStartWeek: null,
              allocationEndWeek: null,
              startWeek: 0,
              endWeek: 7,
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
                planningBasis: 'capacityProfile',
                source: 'squadPlanner',
                defaultPercent: 100,
                startWeek: 0,
                endWeek: 7,
                segments: [
                  { startWeek: 0, endWeek: 7, capacityPercent: 100 },
                ],
                resolutionSource: 'PROFILE',
              },
            },
          ],
        },
      ],
    })

    const csv = buildProfileCsv(profile)
    const { rows } = parseCsv(csv)

    const resourceRows = rows.filter(r => r[0] === 'Resource')
    expect(resourceRows.length).toBe(2)

    // Resource identity column (index 3)
    const plannedRow = resourceRows.find(r => r[2] === 'Planned Resource')
    const namedRow = resourceRows.find(r => r[2] === 'Named Person')
    expect(plannedRow).toBeDefined()
    expect(namedRow).toBeDefined()

    // Planned resource shows 'Planned resource'
    expect(plannedRow![3]).toBe('Planned resource')
    // Named person shows 'Named person'
    expect(namedRow![3]).toBe('Named person')
  })
})

describe('regression: restored scenario A profile data produces identical export', () => {
  it('produces identical CSV from restored scenario A, B differs, no duplicates', () => {
    // Scenario A — canonical data with two resource roles, three named resources
    // (one planned resource), capacity profiles with segments, and overhead.
    const scenarioA: ResourceProfile = {
      projectId: 'project-1',
      hoursPerDay: 8,
      projectDurationWeeks: 12,
      bufferWeeks: 1,
      onboardingWeeks: 0,
      summary: { totalHours: 240, totalDays: 33, totalCost: null, hasCost: false },
      resourceRows: [
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
          allocationPercent: 200,
          allocationStartWeek: null,
          allocationEndWeek: null,
          derivedStartWeek: 0,
          derivedEndWeek: 9,
          estimatedCost: null,
          epics: [],
          capacityProfile: undefined,
          namedResources: [
            {
              id: 'nr-alice',
              name: 'Alice',
              pricingModel: 'ACTUAL_DAYS',
              allocationMode: 'CAPACITY_PLAN',
              allocationPercent: 75,
              allocationStartWeek: null,
              allocationEndWeek: null,
              startWeek: 0,
              endWeek: 7,
              allocatedDays: 10,
              derivedStartWeek: null,
              derivedEndWeek: null,
              actualAllocatedDays: 0,
              actualAllocationStartWeek: null,
              actualAllocationEndWeek: null,
              actualAllocatedWeeks: [],
              actualAllocationSegments: [],
              synthetic: false,
              resourceIdentity: 'NAMED_PERSON',
              capacityProfile: {
                planningBasis: 'capacityProfile',
                source: 'squadPlanner',
                defaultPercent: 75,
                startWeek: 0,
                endWeek: 7,
                segments: [
                  { startWeek: 0, endWeek: 7, capacityPercent: 75 },
                ],
              },
            },
            {
              id: 'nr-planned',
              name: 'New Starter',
              pricingModel: 'PRO_RATA',
              allocationMode: 'CAPACITY_PLAN',
              allocationPercent: 50,
              allocationStartWeek: null,
              allocationEndWeek: null,
              startWeek: 2,
              endWeek: 9,
              allocatedDays: 5,
              derivedStartWeek: null,
              derivedEndWeek: null,
              actualAllocatedDays: 0,
              actualAllocationStartWeek: null,
              actualAllocationEndWeek: null,
              actualAllocatedWeeks: [],
              actualAllocationSegments: [],
              synthetic: true,
              resourceIdentity: 'PLANNED_RESOURCE',
              capacityProfile: {
                planningBasis: 'capacityProfile',
                source: 'squadPlanner',
                defaultPercent: 50,
                startWeek: 2,
                endWeek: 9,
                segments: [
                  { startWeek: 2, endWeek: 9, capacityPercent: 50 },
                ],
                resolutionSource: 'PROFILE',
              },
            },
          ],
        },
        {
          resourceTypeId: 'rt-design',
          name: 'Designer',
          category: 'DESIGN',
          count: 1,
          hoursPerDay: 8,
          dayRate: 700,
          totalHours: 80,
          totalDays: 10,
          effortDays: 10,
          allocatedDays: 10,
          allocationMode: 'EFFORT',
          allocationPercent: 100,
          allocationStartWeek: null,
          allocationEndWeek: null,
          derivedStartWeek: 0,
          derivedEndWeek: 9,
          estimatedCost: null,
          epics: [],
          capacityProfile: undefined,
          namedResources: [
            {
              id: 'nr-bob',
              name: 'Bob',
              pricingModel: 'ACTUAL_DAYS',
              allocationMode: 'CAPACITY_PLAN',
              allocationPercent: 100,
              allocationStartWeek: null,
              allocationEndWeek: null,
              startWeek: 0,
              endWeek: 9,
              allocatedDays: 10,
              derivedStartWeek: null,
              derivedEndWeek: null,
              actualAllocatedDays: 0,
              actualAllocationStartWeek: null,
              actualAllocationEndWeek: null,
              actualAllocatedWeeks: [],
              actualAllocationSegments: [],
              synthetic: false,
              resourceIdentity: 'NAMED_PERSON',
              capacityProfile: {
                planningBasis: 'capacityProfile',
                source: 'squadPlanner',
                defaultPercent: 100,
                startWeek: 0,
                endWeek: 9,
                segments: [
                  { startWeek: 0, endWeek: 9, capacityPercent: 100 },
                ],
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
          dayRate: null,
          type: 'PERCENTAGE',
          value: 10,
          computedDays: 3,
          estimatedCost: null,
          requiredFTE: 0.05,
          currentCount: null,
        },
      ],
    }

    // --- Phase 1: canonical A export ---
    const canonicalA = JSON.parse(JSON.stringify(scenarioA)) as ResourceProfile
    const csvA = buildProfileCsv(canonicalA)
    const { headers: headersA, rows: rowsA } = parseCsv(csvA)
    const identityIdx = headersA.indexOf('Resource identity')
    const segmentsIdx = headersA.indexOf('Capacity profile segments')
    const billingBasisIdx = headersA.indexOf('Billing basis')

    const resourceRowsA = rowsA.filter(r => r[0] === 'Resource')

    // Exactly 3 resource rows (Alice, New Starter, Bob) — no duplicates
    expect(resourceRowsA.length).toBe(3)

    // Planned resource identity column (index 3)
    const aliceRowA = resourceRowsA.find(r => r[2] === 'Alice')
    const plannedRowA = resourceRowsA.find(r => r[2] === 'New Starter')
    const bobRowA = resourceRowsA.find(r => r[2] === 'Bob')
    expect(aliceRowA).toBeDefined()
    expect(plannedRowA).toBeDefined()
    expect(bobRowA).toBeDefined()
    expect(aliceRowA![identityIdx]).toBe('Named person')
    expect(plannedRowA![identityIdx]).toBe('Planned resource')
    expect(bobRowA![identityIdx]).toBe('Named person')

    // Alice: 75% weeks 0-7
    expect(aliceRowA![segmentsIdx]).toBe('W1-W8 75%')
    // New Starter: constant 50% segment
    expect(plannedRowA![segmentsIdx]).toBe('W3-W10 50%')
    // Bob: constant 100% segment
    expect(bobRowA![segmentsIdx]).toBe('W1-W10 100%')
    // Billing basis column — pricing model survives export
    expect(aliceRowA![billingBasisIdx]).toBe('Bill actual scheduled days')
    expect(plannedRowA![billingBasisIdx]).toBe('Bill planned allocation')
    expect(bobRowA![billingBasisIdx]).toBe('Bill actual scheduled days')


    // --- Phase 2: mutate to state B ---
    const stateB = JSON.parse(JSON.stringify(canonicalA)) as ResourceProfile

    // Alice → constant 100%
    const aliceB = stateB.resourceRows[0].namedResources![0]
    aliceB.capacityProfile = {
      ...aliceB.capacityProfile!,
      defaultPercent: 100,
      segments: [{ startWeek: 0, endWeek: 7, capacityPercent: 100 }],
    }

    // New Starter → named person with 100% segment
    const nsB = stateB.resourceRows[0].namedResources![1]
    nsB.synthetic = false
    nsB.resourceIdentity = 'NAMED_PERSON'
    nsB.capacityProfile = {
      ...nsB.capacityProfile!,
      defaultPercent: 100,
      segments: [{ startWeek: 2, endWeek: 9, capacityPercent: 100 }],
    }

    // Bob → constant 75%
    const bobB = stateB.resourceRows[1].namedResources![0]
    bobB.capacityProfile = {
      ...bobB.capacityProfile!,
      defaultPercent: 75,
      segments: [{ startWeek: 0, endWeek: 9, capacityPercent: 75 }],
    }

    const csvB = buildProfileCsv(stateB)
    const { headers: headersB, rows: rowsB } = parseCsv(csvB)
    const identityIdxB = headersB.indexOf('Resource identity')
    const segmentsIdxB = headersB.indexOf('Capacity profile segments')
    const resourceRowsB = rowsB.filter(r => r[0] === 'Resource')

    // Still 3 rows — no extra rows introduced by mutation
    expect(resourceRowsB.length).toBe(3)

    // Verify B actually differs from A
    expect(csvB).not.toBe(csvA)

    // Verify B's mutated values
    const aliceRowB = resourceRowsB.find(r => r[2] === 'Alice')
    expect(aliceRowB![segmentsIdxB]).toBe('W1-W8 100%')
    const nsRowB = resourceRowsB.find(r => r[2] === 'New Starter')
    expect(nsRowB![identityIdxB]).toBe('Named person')
    expect(nsRowB![segmentsIdxB]).toBe('W3-W10 100%')
    const bobRowB = resourceRowsB.find(r => r[2] === 'Bob')
    expect(bobRowB![segmentsIdxB]).toBe('W1-W10 75%')

    // --- Phase 3: restore to Scenario A ---
    const restoredA = JSON.parse(JSON.stringify(canonicalA)) as ResourceProfile
    const csvRestored = buildProfileCsv(restoredA)
    const { headers: headersRestored, rows: rowsRestored } = parseCsv(csvRestored)
    const identityIdxR = headersRestored.indexOf('Resource identity')
    const segmentsIdxR = headersRestored.indexOf('Capacity profile segments')
    const billingBasisIdxR = headersRestored.indexOf('Billing basis')

    const resourceRowsRestored = rowsRestored.filter(r => r[0] === 'Resource')

    // Exact string match against canonical A
    expect(csvRestored).toBe(csvA)

    // No duplicates — same cardinality as canonical A
    expect(resourceRowsRestored.length).toBe(3)

    // Restored segments match canonical A
    const aliceRestored = resourceRowsRestored.find(r => r[2] === 'Alice')
    const plannedRestored = resourceRowsRestored.find(r => r[2] === 'New Starter')
    const bobRestored = resourceRowsRestored.find(r => r[2] === 'Bob')
    expect(aliceRestored![segmentsIdxR]).toBe('W1-W8 75%')
    expect(plannedRestored![segmentsIdxR]).toBe('W3-W10 50%')
    expect(bobRestored![segmentsIdxR]).toBe('W1-W10 100%')
    // Billing basis column restored — pricing model survives rollback
    expect(aliceRestored![billingBasisIdxR]).toBe('Bill actual scheduled days')
    expect(plannedRestored![billingBasisIdxR]).toBe('Bill planned allocation')
    expect(bobRestored![billingBasisIdxR]).toBe('Bill actual scheduled days')


    // Planned resource identity restored
    expect(plannedRestored![identityIdxR]).toBe('Planned resource')

    // State-B values absent from restored output
    expect(aliceRestored![segmentsIdxR]).not.toContain('100%')
    expect(plannedRestored![identityIdxR]).not.toBe('Named person')
    expect(bobRestored![segmentsIdxR]).not.toContain('75%')
  })
})
})
