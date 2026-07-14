/**
 * Regression tests covering csv-parse/sync and csv-stringify/sync usage patterns
 * that match production code paths in csv.ts and templates.ts.
 *
 * These tests validate that the csv-parse 7 API contract is maintained for
 * all real-world CSV shapes the application produces and consumes.
 */

import { describe, expect, it } from 'vitest'
import { parse } from 'csv-parse/sync'
import { stringify } from 'csv-stringify/sync'

function parseRows(input: string, options?: Record<string, unknown>): Record<string, string>[] {
  return parse(input, options as never) as Record<string, string>[]
}

// ---------------------------------------------------------------------------
// Production header constants (mirrored from csv.ts, templates.ts)
// ---------------------------------------------------------------------------
const BACKLOG_HEADERS = [
  'Type', 'Epic', 'Feature', 'Story', 'Task',
  'Template', 'TemplateSize', 'ResourceType',
  'HoursEffort', 'DurationDays',
  'Description', 'Assumptions',
  'EpicStatus', 'FeatureStatus', 'StoryStatus',
  'EpicMode', 'FeatureMode',
  'EpicDependsOn', 'FeatureDependsOn',
] as const

type BacklogField = (typeof BACKLOG_HEADERS)[number]

const TEMPLATE_HEADERS = [
  'TemplateName', 'Category', 'TaskName', 'ResourceTypeName',
  'HoursExtraSmall', 'HoursSmall', 'HoursMedium', 'HoursLarge', 'HoursExtraLarge',
] as const

/** Build a backlog CSV row with exactly the right number of fields.
 *  Properly quotes values containing commas, double-quotes, or newlines. */
function backlogRow(fields: Partial<Record<BacklogField, string>>): string {
  return BACKLOG_HEADERS.map(h => {
    const v = fields[h] ?? ''
    if (/[",\n]/.test(v)) return '"' + v.replace(/"/g, '""') + '"'
    return v
  }).join(',')
}

/** Build a backlog CSV row as a string array (for stringify input).
 *  Unlike backlogRow(), returns a String[] with unquoted field values. */
function backlogRowArray(fields: Partial<Record<BacklogField, string>>): string[] {
  return BACKLOG_HEADERS.map(h => fields[h] ?? '')
}

/** Build a template CSV data row with exactly 9 fields */
function templateRow(
  name: string, category: string, taskName: string,
  resourceType: string, hxs: string, hs: string,
  hm: string, hl: string, hxl: string,
): string {
  return [name, category, taskName, resourceType, hxs, hs, hm, hl, hxl].join(',')
}

// ---------------------------------------------------------------------------
// csv-parse/sync regression tests
// ---------------------------------------------------------------------------
describe('csv-parse/sync', () => {
  // 1. Backlog CSV parsing
  describe('backlog CSV', () => {
    it('parses a full backlog CSV with headers into objects', () => {
      const csv = [
        BACKLOG_HEADERS.join(','),
        backlogRow({ Type: 'Epic', Epic: 'Platform Setup', Description: 'Core infra', EpicStatus: 'active', EpicMode: 'sequential' }),
        backlogRow({ Type: 'Feature', Epic: 'Platform Setup', Feature: 'Authentication', Description: 'Login and registration', FeatureStatus: 'active', FeatureMode: 'sequential' }),
        backlogRow({ Type: 'Story', Epic: 'Platform Setup', Feature: 'Authentication', Story: 'User can log in', Description: 'As a user…', StoryStatus: 'active' }),
      ].join('\n')

      const rows = parseRows(csv, { columns: true, skip_empty_lines: true, trim: true })

      expect(rows).toHaveLength(3)
      expect(rows[0]).toMatchObject({
        Type: 'Epic',
        Epic: 'Platform Setup',
        EpicStatus: 'active',
        EpicMode: 'sequential',
      })
      expect(rows[1]).toMatchObject({
        Type: 'Feature',
        Epic: 'Platform Setup',
        Feature: 'Authentication',
        FeatureStatus: 'active',
        FeatureMode: 'sequential',
      })
      expect(rows[2]).toMatchObject({
        Type: 'Story',
        Epic: 'Platform Setup',
        Feature: 'Authentication',
        Story: 'User can log in',
        Description: 'As a user…',
      })
    })
  })

  // 2. Template CSV parsing
  describe('template CSV', () => {
    it('parses a valid template CSV with headers into objects', () => {
      const csv = [
        TEMPLATE_HEADERS.join(','),
        templateRow('Backend API', 'Engineering', 'Auth endpoint', 'Developer', '1', '2', '4', '8', '16'),
        templateRow('Backend API', 'Engineering', 'Database setup', 'DBA', '2', '4', '8', '16', '32'),
        templateRow('Frontend App', 'UI', 'Login page', 'Designer', '1', '1', '2', '4', '8'),
      ].join('\n')

      const rows = parseRows(csv, { columns: true, skip_empty_lines: true, trim: true })

      expect(rows).toHaveLength(3)
      expect(rows[0]).toMatchObject({
        TemplateName: 'Backend API',
        Category: 'Engineering',
        TaskName: 'Auth endpoint',
        ResourceTypeName: 'Developer',
        HoursExtraSmall: '1',
        HoursSmall: '2',
        HoursMedium: '4',
        HoursLarge: '8',
        HoursExtraLarge: '16',
      })
      expect(rows[2]).toMatchObject({
        TemplateName: 'Frontend App',
        Category: 'UI',
        TaskName: 'Login page',
        ResourceTypeName: 'Designer',
        HoursExtraLarge: '8',
      })
    })
  })

  // 3. columns: true
  describe('columns: true', () => {
    it('maps header row to object keys', () => {
      const csv = 'Name,Role,Level\nAlice,Developer,Senior\nBob,Designer,Junior'

      const rows = parseRows(csv, { columns: true, skip_empty_lines: true, trim: true })

      expect(rows).toHaveLength(2)
      expect(rows[0]).toEqual({ Name: 'Alice', Role: 'Developer', Level: 'Senior' })
      expect(rows[1]).toEqual({ Name: 'Bob', Role: 'Designer', Level: 'Junior' })
    })

    it('preserves column order from headers', () => {
      const csv = 'ColA,ColB,ColC\nx,y,z'

      const rows = parseRows(csv, { columns: true, skip_empty_lines: true, trim: true })

      expect(Object.keys(rows[0])).toEqual(['ColA', 'ColB', 'ColC'])
    })
  })

  // 4. Trimming and empty-cell behaviour
  describe('trimming and empty cells', () => {
    it('trims leading and trailing whitespace when trim: true', () => {
      const csv = 'Name,Role\n  Alice  ,  Developer  \n Bob , Designer '

      const rows = parseRows(csv, { columns: true, skip_empty_lines: true, trim: true })

      expect(rows[0]).toEqual({ Name: 'Alice', Role: 'Developer' })
      expect(rows[1]).toEqual({ Name: 'Bob', Role: 'Designer' })
    })

    it('returns empty strings for empty cells', () => {
      const csv = 'A,B\n1,\n,2'

      const rows = parseRows(csv, { columns: true, skip_empty_lines: true, trim: true })

      expect(rows[0]).toEqual({ A: '1', B: '' })
      expect(rows[1]).toEqual({ A: '', B: '2' })
    })

    it('skips entirely blank lines with skip_empty_lines: true', () => {
      const csv = 'A,B\n1,2\n\n\n3,4\n\n5,6'

      const rows = parseRows(csv, { columns: true, skip_empty_lines: true, trim: true })

      expect(rows).toHaveLength(3)
      expect(rows[2]).toEqual({ A: '5', B: '6' })
    })
  })

  // 5. Quoted commas
  describe('quoted commas', () => {
    it('parses quoted values containing commas as a single field', () => {
      const csv = 'Item,Description,Price\n1,"Food, drinks, snacks",25.50'

      const rows = parseRows(csv, { columns: true, skip_empty_lines: true, trim: true })

      expect(rows[0]).toEqual({
        Item: '1',
        Description: 'Food, drinks, snacks',
        Price: '25.50',
      })
    })

    it('parses Description and Assumptions fields that may contain commas', () => {
      const headers = BACKLOG_HEADERS.join(',')
      const row = backlogRow({
        Type: 'Epic', Epic: 'Setup',
        Description: 'Infra, DevOps, and tooling',
        Assumptions: 'Assumptions: team, budget',
      })
      const csv = [headers, row].join('\n')

      const rows = parseRows(csv, { columns: true, skip_empty_lines: true, trim: true })

      expect(rows[0].Description).toBe('Infra, DevOps, and tooling')
      expect(rows[0].Assumptions).toBe('Assumptions: team, budget')
    })
  })

  // 6. Quoted multiline values
  describe('quoted multiline values', () => {
    it('parses multiline quoted values as a single field', () => {
      const csv = 'Note,Content\n1,"Line one\nLine two\nLine three"'

      const rows = parseRows(csv, { columns: true, skip_empty_lines: true, trim: true })

      expect(rows).toHaveLength(1)
      expect(rows[0].Content).toBe('Line one\nLine two\nLine three')
    })

    it('parses multiline Description field as used in backlog CSV', () => {
      const headers = BACKLOG_HEADERS.join(',')
      const row = backlogRow({
        Type: 'Epic', Epic: 'Platform Setup',
        Description: 'Rich text\nwith\nmultiple\nlines',
      })
      const csv = [headers, row].join('\n')

      const rows = parseRows(csv, { columns: true, skip_empty_lines: true, trim: true })

      expect(rows[0].Description).toBe('Rich text\nwith\nmultiple\nlines')
    })
  })

  // 7. Malformed CSV
  describe('malformed CSV error handling', () => {
    it('returns empty array for empty input (v6 behaviour, documents current state)', () => {
      const rows = parseRows('', { columns: true, skip_empty_lines: true, trim: true })
      expect(rows).toEqual([])
    })

    it('throws on inconsistent column counts (ragged rows)', () => {
      expect(() => {
        parseRows('A,B,C\n1,2\n3,4,5,6', { columns: true, skip_empty_lines: true, trim: true })
      }).toThrow()
    })

    it('returns empty array for header-only input', () => {
      const rows = parseRows('A,B,C\n', { columns: true, skip_empty_lines: true, trim: true })
      expect(rows).toHaveLength(0)
    })

    it('header-only without trailing newline returns empty array', () => {
      const rows = parseRows('A,B,C', { columns: true, skip_empty_lines: true, trim: true })
      expect(rows).toHaveLength(0)
    })
  })

  // 8. Formula injection
  describe('formula injection values', () => {
    it('passes through = prefixed values as plain strings', () => {
      const csv = 'Note,Value\nformula,"=SUM(A1:A10)"\nother,plain'

      const rows = parseRows(csv, { columns: true, skip_empty_lines: true, trim: true })

      expect(rows[0].Value).toBe('=SUM(A1:A10)')
      expect(rows[1].Value).toBe('plain')
    })

    it('passes through + prefixed values as plain strings', () => {
      const csv = 'Note,Value\nplus,"+D1+E1"'
      const rows = parseRows(csv, { columns: true, skip_empty_lines: true, trim: true })
      expect(rows[0].Value).toBe('+D1+E1')
    })

    it('passes through - prefixed values as plain strings', () => {
      const csv = 'Note,Value\ndash,"-1+2"'
      const rows = parseRows(csv, { columns: true, skip_empty_lines: true, trim: true })
      expect(rows[0].Value).toBe('-1+2')
    })

    it('passes through @ prefixed values as plain strings', () => {
      const csv = 'Note,Value\nat,"@COMMAND"'
      const rows = parseRows(csv, { columns: true, skip_empty_lines: true, trim: true })
      expect(rows[0].Value).toBe('@COMMAND')
    })

    it('passes through tab-prefixed values as plain strings', () => {
      const csv = 'Note,Value\ntab,"\t=cmd"'
      const rows = parseRows(csv, { columns: true, skip_empty_lines: true, trim: true })
      expect(rows[0].Value).toBe('\t=cmd')
    })

    it('preserves formula-prefixed values in backlog Description and Assumptions', () => {
      const headers = BACKLOG_HEADERS.join(',')
      const row = backlogRow({
        Type: 'Task', Epic: 'EpicA', Feature: 'FeatureA',
        Story: 'StoryA', Task: 'API Import',
        Description: '=SUM(A1)', Assumptions: '+CONCAT(B1,C1)',
      })
      const csv = [headers, row].join('\n')

      const rows = parseRows(csv, { columns: true, skip_empty_lines: true, trim: true })

      expect(rows[0].Description).toBe('=SUM(A1)')
      expect(rows[0].Assumptions).toBe('+CONCAT(B1,C1)')
    })
  })

  describe('edge cases', () => {
    it('rejects ragged rows from unquoted value with extra commas', () => {
      const csv = 'A,B\n"valid",invalid,extra'

      expect(() => {
        parseRows(csv, { columns: true, skip_empty_lines: true, trim: true })
      }).toThrow()
    })

    it('handles BOM character gracefully', () => {
      const csv = '\uFEFFA,B\n1,2'

      const rows = parseRows(csv, { columns: true, skip_empty_lines: true, trim: true })

      expect(rows).toHaveLength(1)
      const keys = Object.keys(rows[0])
      expect(keys.length).toBeGreaterThanOrEqual(2)
    })
  })
})

// ---------------------------------------------------------------------------
// csv-stringify/sync regression tests
// ---------------------------------------------------------------------------
describe('csv-stringify/sync', () => {
  describe('round-trip consistency', () => {
    it('stringify then parse produces the same data', () => {
      const original = 'a,b,c\n1,2,3\n4,5,6'

      const parsed = parseRows(original, { columns: true, skip_empty_lines: true, trim: true })

      const headers = Object.keys(parsed[0])
      const rows: string[][] = [headers]
      for (const row of parsed) {
        rows.push(headers.map(h => String((row as Record<string, unknown>)[h] ?? '')))
      }

      const csv = stringify(rows)
      const reparsed = parseRows(csv, { columns: true, skip_empty_lines: true, trim: true })

      expect(reparsed).toEqual(parsed)
    })
  })

  describe('backlog dependency round-trip', () => {
    it('stringifies EpicDependsOn with comma-separated names', () => {
      const headers = [...BACKLOG_HEADERS]
      const rows: string[][] = [
        headers,
        backlogRowArray({ Type: 'Epic', Epic: 'Platform Setup' }),
        backlogRowArray({ Type: 'Epic', Epic: 'Mobile App' }),
        backlogRowArray({ Type: 'Epic', Epic: 'Notifications', EpicDependsOn: 'Platform Setup, Mobile App' }),
      ]

      const csv = stringify(rows)
      const reparsed = parseRows(csv, { columns: true, skip_empty_lines: true, trim: true })

      expect(reparsed).toHaveLength(3)
      expect(reparsed[2].EpicDependsOn).toBe('Platform Setup, Mobile App')
    })

    it('stringifies cross-epic qualified FeatureDependsOn names', () => {
      const headers = [...BACKLOG_HEADERS]
      const rows: string[][] = [
        headers,
        backlogRowArray({ Type: 'Feature', Epic: 'Mobile App', Feature: 'Login Screen', FeatureDependsOn: 'Platform Setup: Authentication' }),
      ]

      const csv = stringify(rows)
      const reparsed = parseRows(csv, { columns: true, skip_empty_lines: true, trim: true })

      expect(reparsed).toHaveLength(1)
      expect(reparsed[0].FeatureDependsOn).toBe('Platform Setup: Authentication')
    })

    it('round-trips a mixed backlog with epics, features, stories, and tasks', () => {
      const headers = [...BACKLOG_HEADERS]
      const rows: string[][] = [
        headers,
        backlogRowArray({ Type: 'Epic', Epic: 'Platform Setup', Description: 'Core infra', EpicStatus: 'active', EpicMode: 'sequential' }),
        backlogRowArray({ Type: 'Task', Epic: 'Platform Setup', Feature: 'Authentication', Story: 'User can log in', Task: 'Backend API', ResourceType: 'Developer', HoursEffort: '8' }),
      ]

      const csv = stringify(rows)
      const reparsed = parseRows(csv, { columns: true, skip_empty_lines: true, trim: true })

      expect(reparsed).toHaveLength(2)
      expect(reparsed[1].Task).toBe('Backend API')
      expect(reparsed[1].HoursEffort).toBe('8')
    })
  })

  describe('template CSV stringify', () => {
    it('stringifies template rows with integer hour values', () => {
      const headers = [...TEMPLATE_HEADERS]
      const rows: string[][] = [
        headers,
        templateRow('Backend API', 'Engineering', 'Auth endpoint', 'Developer', '1', '2', '4', '8', '16').split(','),
        templateRow('Frontend', 'UI', 'Login page', 'Designer', '1', '1', '2', '4', '8').split(','),
      ]

      const csv = stringify(rows)
      const reparsed = parseRows(csv, { columns: true, skip_empty_lines: true, trim: true })

      expect(reparsed).toHaveLength(2)
      expect(reparsed[0]).toEqual({
        TemplateName: 'Backend API',
        Category: 'Engineering',
        TaskName: 'Auth endpoint',
        ResourceTypeName: 'Developer',
        HoursExtraSmall: '1',
        HoursSmall: '2',
        HoursMedium: '4',
        HoursLarge: '8',
        HoursExtraLarge: '16',
      })
    })

    it('stringifies empty-template rows (template without tasks)', () => {
      const headers = [...TEMPLATE_HEADERS]
      const emptyRow = ['Empty Template', 'Misc', '', '', '', '', '', '', '']
      const rows: string[][] = [headers, emptyRow]

      const csv = stringify(rows)
      const reparsed = parseRows(csv, { columns: true, skip_empty_lines: true, trim: true })

      expect(reparsed).toHaveLength(1)
      expect(reparsed[0].TemplateName).toBe('Empty Template')
      expect(reparsed[0].Category).toBe('Misc')
      expect(reparsed[0].TaskName).toBe('')
      expect(reparsed[0].HoursExtraSmall).toBe('')
      expect(reparsed[0].HoursExtraLarge).toBe('')
    })
  })
})

// ---------------------------------------------------------------------------
// Production pattern integration
// ---------------------------------------------------------------------------
describe('production pattern integration', () => {
  it('replicates the stage-csv parsing pattern with realistic data', () => {
    const csvText = [
      BACKLOG_HEADERS.join(','),
      backlogRow({ Type: 'Epic', Epic: 'Setup', Description: 'Core infra', EpicStatus: 'active', EpicMode: 'sequential' }),
      backlogRow({ Type: 'Feature', Epic: 'Setup', Feature: 'Auth', Description: 'Login' }),
      backlogRow({ Type: 'Story', Epic: 'Setup', Feature: 'Auth', Story: 'Login flow', Template: 'Login Template', TemplateSize: 'Medium' }),
      backlogRow({ Type: 'Task', Epic: 'Setup', Feature: 'Auth', Story: 'Login flow', Task: 'Build API', ResourceType: 'Developer', HoursEffort: '8', DurationDays: '2' }),
    ].join('\n')

    const rawRows = parseRows(csvText, { columns: true, skip_empty_lines: true, trim: true })

    expect(rawRows).toHaveLength(4)
    expect(rawRows[0].Type).toBe('Epic')
    expect(rawRows[0].Epic).toBe('Setup')
    expect(rawRows[1].Type).toBe('Feature')
    expect(rawRows[1].Epic).toBe('Setup')
    expect(rawRows[1].Feature).toBe('Auth')
    expect(rawRows[2].Type).toBe('Story')
    expect(rawRows[2].Template).toBe('Login Template')
    expect(rawRows[2].TemplateSize).toBe('Medium')
    expect(rawRows[3].Type).toBe('Task')
    expect(rawRows[3].Task).toBe('Build API')
    expect(rawRows[3].ResourceType).toBe('Developer')
    expect(rawRows[3].HoursEffort).toBe('8')
    expect(rawRows[3].DurationDays).toBe('2')
  })

  it('replicates the template import preview parsing pattern', () => {
    const csvText = [
      TEMPLATE_HEADERS.join(','),
      templateRow('Backend API', 'Engineering', 'Auth endpoint', 'Developer', '1', '2', '4', '8', '16'),
      templateRow('Frontend', 'UI', 'Login page', 'Designer', '1', '1', '2', '4', '8'),
    ].join('\n')

    const rows = parseRows(csvText, { columns: true, skip_empty_lines: true, trim: true })

    expect(rows).toHaveLength(2)
    expect((rows[0] as Record<string, string>).TemplateName).toBe('Backend API')
    expect((rows[0] as Record<string, string>).HoursExtraLarge).toBe('16')
  })

  it('replicates the backlog export-csv stringify pattern with sanitized values', () => {
    const description = "'=SUM(A1:A10)"
    const headers = [...BACKLOG_HEADERS]
    const rows: string[][] = [
      headers,
      backlogRowArray({ Type: 'Epic', Epic: 'Setup', Description: description }),
    ]

    const csv = stringify(rows)
    const reparsed = parseRows(csv, { columns: true, skip_empty_lines: true, trim: true })

    expect(reparsed[0].Description).toBe(description)
  })
})
