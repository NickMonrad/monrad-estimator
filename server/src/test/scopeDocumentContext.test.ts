import { describe, expect, it } from 'vitest'
import {
  assumptionComparisonKey,
  buildScopeDocumentContext,
  deduplicateAssumptions,
  extractAssumptionEntries,
} from '../lib/scopeDocumentContext.js'

describe('scope document context aggregation', () => {
  it('extracts rich-text paragraphs and list items in document order', () => {
    expect(extractAssumptionEntries('<p>First</p><ul><li>Second</li><li><p>Third</p></li></ul>')).toEqual([
      '<p>First</p>',
      '<li>Second</li>',
      '<li><p>Third</p></li>',
    ])
  })

  it('deduplicates equivalent assumptions while preserving the first source label', () => {
    const entries = [
      { label: 'Epic A', text: '<p>Client will provide API access.</p>' },
      { label: 'Feature B', text: '<p> client will provide   API access. </p>' },
      { label: 'Story C', text: '<p>Production access remains separate.</p>' },
    ]

    expect(deduplicateAssumptions(entries)).toEqual([entries[0], entries[2]])
    expect(assumptionComparisonKey('<p>Client will provide API access.</p>')).toBe('client will provide api access.')
  })

  it('keeps only active hierarchy items and returns deterministic context order', () => {
    const context = buildScopeDocumentContext(
      [{
        id: 'epic-2', name: 'Second Epic', order: 2, isActive: true, assumptions: '<p>Second</p>',
        features: [{ id: 'feature-2', name: 'Feature', order: 0, isActive: true, assumptions: '<p>Feature</p>', userStories: [] }],
      }, {
        id: 'epic-1', name: 'First Epic', order: 1, isActive: true, assumptions: '<p>First</p>',
        features: [{ id: 'feature-inactive', name: 'Inactive', order: 0, isActive: false, assumptions: '<p>Ignore</p>', userStories: [] }],
      }, {
        id: 'epic-3', name: 'Out of scope Epic', order: 3, isActive: false, assumptions: '<p>Ignore</p>', features: [],
      }],
      [
        { id: 'dependency-2', description: 'Second dependency', order: 2 },
        { id: 'dependency-1', description: 'First dependency', order: 1 },
      ],
      [
        { id: 'risk-2', description: 'Second risk', mitigation: null, order: 2 },
        { id: 'risk-1', description: 'First risk', mitigation: null, order: 1 },
      ],
    )

    expect(context.assumptions.map(item => item.label)).toEqual(['First Epic', 'Second Epic', 'Second Epic › Feature'])
    expect(context.assumptions.map(item => item.text)).not.toContain('<p>Ignore</p>')
    expect(context.dependencies.map(item => item.id)).toEqual(['dependency-1', 'dependency-2'])
    expect(context.risks.map(item => item.id)).toEqual(['risk-1', 'risk-2'])
  })
})
