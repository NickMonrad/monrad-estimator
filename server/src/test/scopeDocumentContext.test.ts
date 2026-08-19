import { describe, expect, it } from 'vitest'
import { buildScopeDocumentContext, deduplicateAssumptions } from '../lib/scopeDocumentContext.js'

describe('deduplicateAssumptions', () => {
  it('keeps the first wording for exact, case and whitespace duplicates', () => {
    expect(deduplicateAssumptions([
      { label: 'Epic One', value: 'Client will provide API access.' },
      { label: 'Feature One', value: ' client   WILL provide API access. ' },
    ])).toEqual([{ label: 'Epic One', text: 'Client will provide API access.' }])
  })

  it('deduplicates Unicode-normalised equivalents and rich-text/plain-text equivalents', () => {
    expect(deduplicateAssumptions([
      { label: 'Epic One', value: '<p>Cafe\u0301 access</p>' },
      { label: 'Feature One', value: 'Café access' },
    ])).toEqual([{ label: 'Epic One', text: '<p>Cafe\u0301 access</p>' }])
  })

  it('keeps similar but materially different assumptions', () => {
    expect(deduplicateAssumptions([
      { label: 'Epic One', value: 'Client will provide API access.' },
      { label: 'Feature One', value: 'Client will provide production API access.' },
    ])).toHaveLength(2)
  })

  it('ignores null and empty values and preserves deterministic order', () => {
    expect(deduplicateAssumptions([
      { label: 'Empty', value: null },
      { label: 'First', value: 'First assumption' },
      { label: 'Blank', value: '   ' },
      { label: 'Second', value: 'Second assumption' },
    ])).toEqual([
      { label: 'First', text: 'First assumption' },
      { label: 'Second', text: 'Second assumption' },
    ])
  })

  it('splits safely recognisable paragraphs and list items', () => {
    expect(deduplicateAssumptions([
      { label: 'Epic One', value: '<p>First assumption</p><p>Second assumption</p>' },
      { label: 'Feature One', value: '<ul><li>Second assumption</li><li>Third assumption</li></ul>' },
    ])).toEqual([
      { label: 'Epic One', text: '<p>First assumption</p>' },
      { label: 'Epic One', text: '<p>Second assumption</p>' },
      { label: 'Feature One', text: '<li>Third assumption</li>' },
    ])
  })

  it('treats an unrecognised rich-text field as one assumption', () => {
    const value = '<div><p>First</p><p>Second</p></div>'
    expect(deduplicateAssumptions([{ label: 'Epic One', value }])).toEqual([{ label: 'Epic One', text: value }])
  })
})

describe('buildScopeDocumentContext', () => {
  it('uses active Epic, Feature and Story assumptions in hierarchy order', () => {
    const context = buildScopeDocumentContext([
      {
        name: 'Inactive Epic', isActive: false, assumptions: 'Ignored', features: [],
      },
      {
        name: 'Epic One', isActive: true, assumptions: 'Epic assumption', features: [{
          name: 'Feature One', isActive: true, assumptions: 'Feature assumption', userStories: [{
            name: 'Story One', isActive: true, assumptions: 'Story assumption',
          }],
        }],
      },
    ], [
      { description: 'Dependency one' },
      { description: 'Dependency two' },
    ], [
      { description: 'Risk one', mitigation: null },
      { description: 'Risk two', mitigation: 'Respond early' },
    ])

    expect(context).toEqual({
      assumptions: [
        { label: 'Epic One', text: 'Epic assumption' },
        { label: 'Epic One › Feature One', text: 'Feature assumption' },
        { label: 'Feature One › Story One', text: 'Story assumption' },
      ],
      dependencies: [{ description: 'Dependency one' }, { description: 'Dependency two' }],
      risks: [{ description: 'Risk one', mitigation: null }, { description: 'Risk two', mitigation: 'Respond early' }],
    })
  })
})
