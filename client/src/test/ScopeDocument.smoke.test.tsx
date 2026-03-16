/**
 * Smoke test: exercises @react-pdf/renderer against ScopeDocument to catch
 * layout crashes (e.g. "unsupported number" from pdfkit coordinate overflow).
 *
 * Uses the Node.js pdfkit build (react-pdf.js) via vitest — same yoga layout
 * engine as the browser build, so coordinate-overflow bugs surface here too.
 */
import { describe, it, expect } from 'vitest'
import React from 'react'
import { pdf } from '@react-pdf/renderer'
import ScopeDocument, { type ScopeDocumentProps } from '@/components/documents/ScopeDocument'

const minimalProps: ScopeDocumentProps = {
  project: {
    name: 'Acme Platform',
    customer: 'Acme Corp',
    description: 'A test project for PDF smoke testing.',
    startDate: '2025-01-01',
    endDate: '2025-06-30',
  },
  sections: {
    cover: true,
    scope: true,
    effort: true,
    timeline: true,
    resourceProfile: true,
    assumptions: true,
  },
  effortData: { totalHours: 40, totalDays: 5 },
  timelineData: {
    startDate: '2025-01-01',
    projectedEndDate: '2025-06-30',
    entries: [
      { featureName: 'Auth', epicName: 'Core', startDate: '2025-01-06', endDate: '2025-01-17', durationWeeks: 2 },
    ],
  },
  resourceProfileData: {
    resourceRows: [
      {
        name: 'Senior Developer',
        category: 'Engineering',
        totalHours: 40,
        totalDays: 5,
        estimatedCost: 8000,
        epics: [
          {
            epicId: 'e1',
            epicName: 'Core',
            features: [
              { featureId: 'f1', featureName: 'Auth', hours: 40, days: 5 },
            ],
          },
        ],
      },
    ],
    overheadRows: [
      { name: 'PM', type: 'PERCENTAGE', value: 10, computedDays: 0.5, estimatedCost: null },
    ],
    summary: { hasCost: true, totalHours: 40, totalDays: 5.5, totalCost: 8000 },
  },
  epics: [
    {
      id: 'e1',
      name: 'Core',
      description: 'Core platform features',
      assumptions: 'Assumes cloud hosting.',
      isActive: true,
      features: [
        {
          id: 'f1',
          name: 'Auth',
          description: 'User authentication',
          assumptions: 'OAuth 2.0 provider in place.',
          isActive: true,
          userStories: [
            { id: 's1', name: 'As a user I can log in', description: null, assumptions: null, isActive: true },
          ],
        },
        {
          id: 'f2',
          name: 'Reporting (deferred)',
          description: 'Advanced reports',
          assumptions: null,
          isActive: false,
          userStories: [],
        },
      ],
    },
    {
      id: 'e2',
      name: 'Integrations (out of scope)',
      description: 'Third-party integrations',
      assumptions: null,
      isActive: false,
      features: [],
    },
  ],
  generatedBy: 'Test Runner',
  documentLabel: 'v1.0-test',
}

const longText = (label: string, repeat = 18) =>
  Array.from({ length: repeat }, (_, index) => `${label} segment ${index + 1} with extended narrative for wrapping coverage.`).join(' ')

const longScopeProps: ScopeDocumentProps = {
  ...minimalProps,
  sections: {
    cover: false,
    scope: true,
    effort: false,
    timeline: false,
    resourceProfile: false,
    assumptions: false,
  },
  epics: [
    {
      id: 'long-epic-1',
      name: 'Large Scope Epic',
      description: longText('Epic description', 20),
      assumptions: longText('Epic assumption', 16),
      isActive: true,
      features: Array.from({ length: 5 }, (_, featureIndex) => ({
        id: `long-feature-${featureIndex + 1}`,
        name: `Feature ${featureIndex + 1}`,
        description: longText(`Feature ${featureIndex + 1} description`, 22),
        assumptions: longText(`Feature ${featureIndex + 1} assumption`, 18),
        isActive: true,
        userStories: Array.from({ length: 6 }, (_, storyIndex) => ({
          id: `long-story-${featureIndex + 1}-${storyIndex + 1}`,
          name: longText(`Feature ${featureIndex + 1} story ${storyIndex + 1}`, 8),
          description: null,
          assumptions: null,
          isActive: true,
        })),
      })),
    },
    {
      id: 'long-epic-2',
      name: 'Deferred Scope Epic',
      description: longText('Deferred epic description', 18),
      assumptions: null,
      isActive: false,
      features: [
        {
          id: 'deferred-feature-1',
          name: 'Deferred Feature',
          description: longText('Deferred feature description', 20),
          assumptions: longText('Deferred feature assumption', 18),
          isActive: false,
          userStories: Array.from({ length: 4 }, (_, storyIndex) => ({
            id: `deferred-story-${storyIndex + 1}`,
            name: longText(`Deferred story ${storyIndex + 1}`, 7),
            description: null,
            assumptions: null,
            isActive: false,
          })),
        },
      ],
    },
  ],
}

describe('ScopeDocument PDF smoke test', () => {
  it(
    'renders to a non-empty PDF buffer without throwing (all sections enabled)',
    async () => {
      const instance = pdf(React.createElement(ScopeDocument, minimalProps))
      const blob = await instance.toBlob()
      // A minimal single-page PDF is at least a few KB
      expect(blob.size).toBeGreaterThan(1000)
    },
    30_000, // 30 s — PDF generation can be slow in CI
  )

  it(
    'renders cover-only document without throwing',
    async () => {
      const props: ScopeDocumentProps = {
        ...minimalProps,
        sections: { cover: true, scope: false, effort: false, timeline: false, resourceProfile: false, assumptions: false },
      }
      const instance = pdf(React.createElement(ScopeDocument, props))
      const blob = await instance.toBlob()
      expect(blob.size).toBeGreaterThan(1000)
    },
    30_000,
  )

  it(
    'renders with empty epics / null data without throwing',
    async () => {
      const props: ScopeDocumentProps = {
        ...minimalProps,
        epics: [],
        effortData: { totalHours: 0, totalDays: 0 },
        timelineData: { startDate: null, projectedEndDate: null, entries: [] },
        resourceProfileData: { resourceRows: [], overheadRows: [], summary: { hasCost: false, totalHours: 0, totalDays: 0, totalCost: null } },
      }
      const instance = pdf(React.createElement(ScopeDocument, props))
      const blob = await instance.toBlob()
      expect(blob.size).toBeGreaterThan(1000)
    },
    30_000,
  )

  it(
    'renders scope-only document with very long wrapped scope content without throwing',
    async () => {
      const instance = pdf(React.createElement(ScopeDocument, longScopeProps))
      const blob = await instance.toBlob()
      expect(blob.size).toBeGreaterThan(1000)
    },
    30_000,
  )
})
