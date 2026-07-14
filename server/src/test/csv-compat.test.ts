/**
 * Compatibility and regression tests for CSV helpers used by the application.
 *
 * Tests exercise the same functions called by route handlers so they cannot
 * silently diverge from production behaviour.
 */

import { describe, expect, it } from 'vitest'
import {
  parseBacklogCsv,
  parseTemplateCsv,
  serializeBacklogCsv,
  serializeTemplateCsv,
  serializeCsv,
  BACKLOG_CSV_HEADERS,
  TEMPLATE_CSV_HEADERS,
} from '../lib/csvFormat.js'
import { sanitizeCsvCell } from '../routes/csv.js'

// ── Helpers ─────────────────────────────────────────────────────────────

/** Build a backlog row array with exactly 19 fields matching BACKLOG_CSV_HEADERS. */
function backlogData(fields: Partial<Record<string, string>>): string[] {
  return BACKLOG_CSV_HEADERS.map(h => fields[h] ?? '') as unknown as string[]
}

/** Build a backlog CSV data row string from a partial fields object, properly quoting commas/newlines. */
function backlogCsvLine(fields: Partial<Record<string, string>>): string {
  return backlogData(fields).map(v => /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v).join(',')
}

/** Build a template row array with exactly 9 fields. */
function templateData(overrides: Partial<Record<string, string>>): string[] {
  return TEMPLATE_CSV_HEADERS.map(h => overrides[h] ?? '') as unknown as string[]
}

// ---------------------------------------------------------------------------
// Backlog CSV parsing (production options: columns:true, skip_empty_lines, trim)
// ---------------------------------------------------------------------------

describe('parseBacklogCsv', () => {
  it('parses a valid backlog CSV into header-mapped objects', () => {
    const csv = [
      [...BACKLOG_CSV_HEADERS].join(','),
      backlogCsvLine({ Type: 'Epic', Epic: 'Platform Setup', Description: 'Core infra', EpicStatus: 'active', EpicMode: 'sequential' }),
      backlogCsvLine({ Type: 'Feature', Epic: 'Platform Setup', Feature: 'Authentication', Description: 'Login and registration', FeatureStatus: 'active', FeatureMode: 'sequential' }),
    ].join('\n')

    const rows = parseBacklogCsv(csv)
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ Type: 'Epic', Epic: 'Platform Setup', EpicStatus: 'active', EpicMode: 'sequential' })
    expect(rows[1]).toMatchObject({ Type: 'Feature', Feature: 'Authentication', Epic: 'Platform Setup' })
  })

  it('handles quoted commas in Description and Assumptions', () => {
    const csv = [
      [...BACKLOG_CSV_HEADERS].join(','),
      backlogCsvLine({ Type: 'Epic', Epic: 'Setup', Description: 'Infra, DevOps, tooling', Assumptions: 'Assumptions: team, budget', EpicStatus: 'active', EpicMode: 'sequential' }),
    ].join('\n')

    const rows = parseBacklogCsv(csv)
    expect(rows[0].Description).toBe('Infra, DevOps, tooling')
    expect(rows[0].Assumptions).toBe('Assumptions: team, budget')
  })

  it('handles multiline Description values', () => {
    const csv = [
      [...BACKLOG_CSV_HEADERS].join(','),
      backlogCsvLine({ Type: 'Epic', Epic: 'Setup', Description: 'Line one\nLine two', EpicStatus: 'active' }),
    ].join('\n')

    const rows = parseBacklogCsv(csv)
    expect(rows[0].Description).toBe('Line one\nLine two')
  })

  it('returns empty strings for empty cells', () => {
    const csv = [
      [...BACKLOG_CSV_HEADERS].join(','),
      backlogCsvLine({ Type: 'Task', Epic: 'EpicA', Feature: 'FeatureA', Story: 'StoryA', Task: 'TaskA' }),
    ].join('\n')

    const rows = parseBacklogCsv(csv)
    expect(rows[0].Description).toBe('')
    expect(rows[0].Assumptions).toBe('')
    expect(rows[0].EpicDependsOn).toBe('')
  })

  it('skips blank lines with skip_empty_lines: true', () => {
    const csv = [
      [...BACKLOG_CSV_HEADERS].join(','),
      backlogCsvLine({ Type: 'Epic', Epic: 'A' }),
      '',
      '',
      backlogCsvLine({ Type: 'Epic', Epic: 'B' }),
    ].join('\n')

    const rows = parseBacklogCsv(csv)
    expect(rows).toHaveLength(2)
  })

  it('accepts header-only input as empty result', () => {
    const rows = parseBacklogCsv([...BACKLOG_CSV_HEADERS].join(',') + '\n')
    expect(rows).toHaveLength(0)
  })

  it('throws on ragged/malformed input (extra unquoted value)', () => {
    expect(() => { parseBacklogCsv('A,B\n1,2,3') }).toThrow()
  })

  it('handles BOM character gracefully', () => {
    const csv = '\uFEFF' + ['A', 'B'].join(',') + '\n1,2'
    const rows = parseBacklogCsv(csv)
    expect(rows).toHaveLength(1)
  })

  it('parses backlog dependency columns', () => {
    const csv = [
      [...BACKLOG_CSV_HEADERS].join(','),
      backlogCsvLine({ Type: 'Epic', Epic: 'Platform', EpicDependsOn: 'Platform A, Platform B', EpicStatus: 'active' }),
    ].join('\n')

    const rows = parseBacklogCsv(csv)
    expect(rows[0].EpicDependsOn).toBe('Platform A, Platform B')
  })

  it('parses cross-epic qualified FeatureDependsOn', () => {
    const csv = [
      [...BACKLOG_CSV_HEADERS].join(','),
      backlogCsvLine({ Type: 'Feature', Epic: 'Platform', Feature: 'Auth', FeatureDependsOn: 'Platform Setup: Authentication' }),
    ].join('\n')

    const rows = parseBacklogCsv(csv)
    expect(rows[0].FeatureDependsOn).toBe('Platform Setup: Authentication')
  })

  it('parses template and sizing fields', () => {
    const csv = [
      [...BACKLOG_CSV_HEADERS].join(','),
      backlogCsvLine({ Type: 'Story', Epic: 'Platform', Feature: 'Auth', Story: 'Login flow', Template: 'Login Template', TemplateSize: 'Medium' }),
    ].join('\n')

    const rows = parseBacklogCsv(csv)
    expect(rows[0].Template).toBe('Login Template')
    expect(rows[0].TemplateSize).toBe('Medium')
  })

  it('parses task hours and duration fields', () => {
    const csv = [
      [...BACKLOG_CSV_HEADERS].join(','),
      backlogCsvLine({ Type: 'Task', Epic: 'Platform', Feature: 'Auth', Story: 'Login', Task: 'API', ResourceType: 'Developer', HoursEffort: '8', DurationDays: '2' }),
    ].join('\n')

    const rows = parseBacklogCsv(csv)
    expect(rows[0].HoursEffort).toBe('8')
    expect(rows[0].DurationDays).toBe('2')
    expect(rows[0].ResourceType).toBe('Developer')
  })
})

// ---------------------------------------------------------------------------
// Template CSV parsing
// ---------------------------------------------------------------------------

describe('parseTemplateCsv', () => {
  it('parses a valid template CSV with multiple tasks', () => {
    const csv = [
      [...TEMPLATE_CSV_HEADERS].join(','),
      templateData({ TemplateName: 'Backend API', Category: 'Engineering', TaskName: 'Auth endpoint', ResourceTypeName: 'Developer', HoursExtraSmall: '1', HoursSmall: '2', HoursMedium: '4', HoursLarge: '8', HoursExtraLarge: '16' }).join(','),
      templateData({ TemplateName: 'Frontend', Category: 'UI', TaskName: 'Login page', ResourceTypeName: 'Designer', HoursExtraSmall: '1', HoursSmall: '1', HoursMedium: '2', HoursLarge: '4', HoursExtraLarge: '8' }).join(','),
    ].join('\n')

    const rows = parseTemplateCsv(csv)
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ TemplateName: 'Backend API', Category: 'Engineering', TaskName: 'Auth endpoint', ResourceTypeName: 'Developer', HoursExtraSmall: '1', HoursSmall: '2', HoursMedium: '4', HoursLarge: '8', HoursExtraLarge: '16' })
  })

  it('handles empty task cells (template without tasks)', () => {
    const csv = [
      [...TEMPLATE_CSV_HEADERS].join(','),
      templateData({ TemplateName: 'Empty Tpl', Category: 'Misc' }).join(','),
    ].join('\n')

    const rows = parseTemplateCsv(csv)
    expect(rows).toHaveLength(1)
    expect(rows[0].TaskName).toBe('')
    expect(rows[0].HoursExtraSmall).toBe('')
    expect(rows[0].HoursExtraLarge).toBe('')
  })

  it('throws on malformed input', () => {
    expect(() => { parseTemplateCsv('TemplateName,TaskName\nOnlyName') }).toThrow()
  })
})

// ---------------------------------------------------------------------------
// sanitizeCsvCell (formula-injection protection)
// ---------------------------------------------------------------------------

describe('sanitizeCsvCell', () => {
  const dangerousPrefixes = ['=', '+', '-', '@', '\t', '\r']

  for (const prefix of dangerousPrefixes) {
    it(`prefixes "${prefix}" with single quote`, () => {
      expect(sanitizeCsvCell(`${prefix}SUM(A1:A10)`)).toBe(`'${prefix}SUM(A1:A10)`)
    })
  }

  it('does not prefix safe values', () => {
    expect(sanitizeCsvCell('Normal text')).toBe('Normal text')
    expect(sanitizeCsvCell('plain')).toBe('plain')
    expect(sanitizeCsvCell('')).toBe('')
  })
})

// ---------------------------------------------------------------------------
// Serialisation and round-trip
// ---------------------------------------------------------------------------

describe('serialize helpers', () => {
  it('serializeBacklogCsv produces parsable output with correct headers', () => {
    const data = [backlogData({ Type: 'Epic', Epic: 'Setup', Description: 'desc', EpicStatus: 'active', EpicMode: 'sequential' })]
    const csv = serializeBacklogCsv(data)
    const reparsed = parseBacklogCsv(csv)
    expect(reparsed).toHaveLength(1)
    expect(reparsed[0].Type).toBe('Epic')
    expect(reparsed[0].Epic).toBe('Setup')
    expect(reparsed[0].Description).toBe('desc')
  })

  it('serializeBacklogCsv + parseBacklogCsv round-trips backlog fields', () => {
    const data = [
      backlogData({ Type: 'Epic', Epic: 'Platform', Description: 'Core infra', EpicStatus: 'active', EpicMode: 'sequential' }),
      backlogData({ Type: 'Task', Epic: 'Platform', Feature: 'Auth', Story: 'Login', Task: 'API', ResourceType: 'Developer', HoursEffort: '8', DurationDays: '2' }),
    ]
    const csv = serializeBacklogCsv(data)
    const reparsed = parseBacklogCsv(csv)
    expect(reparsed).toHaveLength(2)
    expect(reparsed[0].Epic).toBe('Platform')
    expect(reparsed[1].Task).toBe('API')
    expect(reparsed[1].HoursEffort).toBe('8')
    expect(reparsed[1].DurationDays).toBe('2')
  })

  it('serializeTemplateCsv + parseTemplateCsv round-trips', () => {
    const data = [
      templateData({ TemplateName: 'API', Category: 'Engineering', TaskName: 'Auth', ResourceTypeName: 'Developer', HoursExtraSmall: '1', HoursSmall: '2', HoursMedium: '4', HoursLarge: '8', HoursExtraLarge: '16' }),
      templateData({ TemplateName: 'UI', Category: 'Design', TaskName: 'Login', ResourceTypeName: 'Designer', HoursExtraSmall: '1', HoursSmall: '1', HoursMedium: '2', HoursLarge: '4', HoursExtraLarge: '8' }),
    ]
    const csv = serializeTemplateCsv(data)
    const reparsed = parseTemplateCsv(csv)
    expect(reparsed).toHaveLength(2)
    expect(reparsed[0].TemplateName).toBe('API')
    expect(reparsed[0].HoursExtraLarge).toBe('16')
    expect(reparsed[1].HoursExtraLarge).toBe('8')
  })

  it('serializeCsv handles arbitrary headers and rows', () => {
    const csv = serializeCsv(['X', 'Y'], [['1', '2'], ['3', '4']])
    const reparsed = parseBacklogCsv(csv)
    expect(reparsed).toHaveLength(2)
    expect(reparsed[0]).toEqual({ X: '1', Y: '2' })
  })
})

// ---------------------------------------------------------------------------
// Round-trip with special values
// ---------------------------------------------------------------------------

describe('round-trip', () => {
  it('comma-containing dependency fields round-trip', () => {
    const data = [backlogData({ Type: 'Epic', Epic: 'Setup', EpicDependsOn: 'Epic A, Epic B', EpicStatus: 'active' })]
    const csv = serializeBacklogCsv(data)
    const reparsed = parseBacklogCsv(csv)
    expect(reparsed[0].EpicDependsOn).toBe('Epic A, Epic B')
  })

  it('multiline description round-trips', () => {
    const data = [backlogData({ Type: 'Epic', Epic: 'Setup', Description: 'Line1\nLine2\nLine3', EpicStatus: 'active' })]
    const csv = serializeBacklogCsv(data)
    const reparsed = parseBacklogCsv(csv)
    expect(reparsed[0].Description).toBe('Line1\nLine2\nLine3')
  })

  it('empty-template rows round-trip', () => {
    const data = [templateData({ TemplateName: 'Empty', Category: '' })]
    const csv = serializeTemplateCsv(data)
    const reparsed = parseTemplateCsv(csv)
    expect(reparsed[0].TemplateName).toBe('Empty')
    expect(reparsed[0].HoursExtraSmall).toBe('')
  })
})

// ---------------------------------------------------------------------------
// Formula injection via production sanitisation path
// ---------------------------------------------------------------------------

describe('formula-injection protection', () => {
  it('sanitizeCsvCell prefixes all dangerous start characters', () => {
    const dangerous = ['=cmd', '+formula', '-value', '@command', '\tcmd', '\rcmd']
    for (const v of dangerous) {
      expect(sanitizeCsvCell(v).charAt(0)).toBe("'")
    }
  })

  it('sanitized values round-trip to the safe (prefixed) value', () => {
    const epicName = sanitizeCsvCell('=HYPERLINK("http://evil")')
    const description = sanitizeCsvCell('+DDE("cmd";"arg")')
    const data = [backlogData({ Type: 'Epic', Epic: epicName, Description: description, EpicStatus: 'active' })]
    const csv = serializeBacklogCsv(data)
    const reparsed = parseBacklogCsv(csv)
    expect(reparsed[0].Epic).toBe("'=HYPERLINK(\"http://evil\")")
    expect(reparsed[0].Description).toBe("'+DDE(\"cmd\";\"arg\")")
  })
})
