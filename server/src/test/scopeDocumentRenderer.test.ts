import { describe, it, expect, vi } from 'vitest'

// The global test setup mocks this module to avoid pulling in heavy
// rendering deps in unrelated tests; here we want the real implementation.
vi.unmock('../lib/scopeDocumentRenderer.js')

const { renderScopeDocumentHtml } = await vi.importActual<typeof import('../lib/scopeDocumentRenderer.js')>(
  '../lib/scopeDocumentRenderer.js'
)

interface GanttFixtureEntry {
  featureId: string
  featureName: string
  epicId: string
  epicName: string
  epicOrder: number
  featureOrder: number
  startWeek: number
  durationWeeks: number
  timelineColour: string | null
}

function buildEntries(epicCount: number, featuresPerEpic: number): GanttFixtureEntry[] {
  const entries: GanttFixtureEntry[] = []
  for (let e = 0; e < epicCount; e++) {
    for (let f = 0; f < featuresPerEpic; f++) {
      entries.push({
        featureId: `e${e}-f${f}`,
        featureName: `Feature ${e}.${f}`,
        epicId: `epic-${e}`,
        epicName: `Epic ${e}`,
        epicOrder: e,
        featureOrder: f,
        startWeek: f,
        durationWeeks: 2,
        timelineColour: '#3b82f6',
      })
    }
  }
  return entries
}

function buildProps(entries: GanttFixtureEntry[]) {
  return {
    project: {
      name: 'Test Project',
      customer: null,
      description: null,
      startDate: '2025-01-01',
      endDate: null,
    },
    sections: {
      cover: false,
      scope: false,
      effort: false,
      timeline: false,
      resourceProfile: false,
      assumptions: false,
      ganttChart: true,
    },
    effortData: null,
    timelineData: {
      startDate: '2025-01-01',
      projectedEndDate: null,
      entries,
      bufferWeeks: 0,
      onboardingWeeks: 0,
    },
    resourceProfileData: null,
    epics: [],
    generatedBy: 'tester',
    documentLabel: 'doc',
  }
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0
  let idx = 0
  while ((idx = haystack.indexOf(needle, idx)) !== -1) {
    count++
    idx += needle.length
  }
  return count
}

const PAGE_DIV = '<div class="gantt-page-section">'

describe('renderScopeDocumentHtml — Gantt chart pagination', () => {
  it('renders a single page when all rows fit', () => {
    const html = renderScopeDocumentHtml(buildProps(buildEntries(2, 3)))
    expect(countOccurrences(html, PAGE_DIV)).toBe(1)
    // Project Timeline heading appears exactly once (no continued)
    expect(countOccurrences(html, 'Project Timeline</div>')).toBe(1)
    expect(html).not.toContain('(continued)')
  })

  it('splits the chart across multiple pages when there are many features', () => {
    // 30 epics × 10 features = 300 rows — far exceeds a single A4 landscape page
    const html = renderScopeDocumentHtml(buildProps(buildEntries(30, 10)))
    const pageSections = countOccurrences(html, PAGE_DIV)
    expect(pageSections).toBeGreaterThan(1)
    // Continuation heading appears on every page after the first
    expect(countOccurrences(html, 'Project Timeline (continued)')).toBe(pageSections - 1)
    // Every epic name shows up in the rendered output (none are dropped)
    for (let e = 0; e < 30; e++) {
      expect(html).toContain(`Epic ${e}`)
    }
    // Every feature name shows up in the rendered output (none are dropped)
    for (let e = 0; e < 30; e++) {
      for (let f = 0; f < 10; f++) {
        expect(html).toContain(`Feature ${e}.${f}`)
      }
    }
  })

  it('flags an epic split across pages with "(continued)"', () => {
    // One epic with enough features to overflow a single page
    const html = renderScopeDocumentHtml(buildProps(buildEntries(1, 200)))
    expect(countOccurrences(html, PAGE_DIV)).toBeGreaterThan(1)
    // "(continued)" appears on the epic header for split pages, alongside the
    // section heading continuation marker
    expect(html).toContain('Epic 0 (continued)')
  })

  it('returns a single page section when the chart is empty', () => {
    const html = renderScopeDocumentHtml(buildProps([]))
    // Empty entries → no Gantt rendered at all
    expect(html).not.toContain(PAGE_DIV)
  })
})
