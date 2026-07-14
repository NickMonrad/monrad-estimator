/**
 * Shared CSV format helpers for backlog and template import/export.
 *
 * This module is the single source of truth for CSV header definitions,
 * parse options, and serialisation. Both route handlers and tests should
 * use these functions so they cannot silently diverge.
 */

import { parse } from 'csv-parse/sync'
import { stringify } from 'csv-stringify/sync'

// ── Parse options (matches all application usage) ────────────────────────

export const CSV_PARSE_OPTIONS = {
  columns: true as const,
  skip_empty_lines: true as const,
  trim: true as const,
}

// ── Backlog CSV headers ─────────────────────────────────────────────────

export const BACKLOG_CSV_HEADERS = [
  'Type', 'Epic', 'Feature', 'Story', 'Task',
  'Template', 'TemplateSize', 'ResourceType',
  'HoursEffort', 'DurationDays',
  'Description', 'Assumptions',
  'EpicStatus', 'FeatureStatus', 'StoryStatus',
  'EpicMode', 'FeatureMode',
  'EpicDependsOn', 'FeatureDependsOn',
] as const

export type BacklogCsvField = (typeof BACKLOG_CSV_HEADERS)[number]

/** Parse backlog CSV text using the application's real parsing options. */
export function parseBacklogCsv(csvText: string): Record<string, string>[] {
  return parse(csvText, CSV_PARSE_OPTIONS) as Record<string, string>[]
}

/** Serialise backlog rows (header-data arrays) into CSV text. */
export function serializeBacklogCsv(rows: string[][]): string {
  return stringify([[...BACKLOG_CSV_HEADERS] as unknown as string[], ...rows])
}

// ── Template CSV headers ────────────────────────────────────────────────

export const TEMPLATE_CSV_HEADERS = [
  'TemplateName', 'Category', 'TaskName', 'ResourceTypeName',
  'HoursExtraSmall', 'HoursSmall', 'HoursMedium', 'HoursLarge', 'HoursExtraLarge',
] as const

export type TemplateCsvField = (typeof TEMPLATE_CSV_HEADERS)[number]

/** Parse template CSV text using the application's real parsing options. */
export function parseTemplateCsv(csvText: string): Record<string, string>[] {
  return parse(csvText, CSV_PARSE_OPTIONS) as Record<string, string>[]
}

/** Serialise template rows (header-data arrays) into CSV text. */
export function serializeTemplateCsv(rows: string[][]): string {
  return stringify([[...TEMPLATE_CSV_HEADERS] as unknown as string[], ...rows])
}

// ── Generic CSV utilities ───────────────────────────────────────────────

/** Serialise any header–rows pair to CSV text. */
export function serializeCsv(headers: string[], rows: string[][]): string {
  return stringify([headers, ...rows])
}
