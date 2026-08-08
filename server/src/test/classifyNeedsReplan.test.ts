/**
 * classifyNeedsReplan.test.ts — Unit tests for the reviewed production
 * maintenance path (issue #449 / #404): classifying an explicitly supplied
 * project set as NEEDS_REPLAN via the same atomic reset transaction.
 *
 * Covers manifest parsing (fail closed), dry-run planning, apply, idempotent
 * already-NEEDS_REPLAN skipping, and abort-on-missing-project.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

import {
  parseClassifyManifest,
  planClassification,
  classifyNeedsReplan,
  ClassifyManifestError,
  ClassifyAbortError,
  type ClassifyManifest,
} from '../lib/classifyNeedsReplan.js'
import { resetProjectPlanning } from '../lib/resetProjectPlanning.js'

vi.mock('../lib/resetProjectPlanning.js', () => ({
  resetProjectPlanning: vi.fn().mockResolvedValue({ projectId: 'x', planningState: 'NEEDS_REPLAN' }),
}))

beforeEach(() => vi.clearAllMocks())

describe('parseClassifyManifest', () => {
  it('accepts a valid reviewed manifest', () => {
    expect(parseClassifyManifest({ projectIds: ['p1', 'p2'] })).toEqual({ projectIds: ['p1', 'p2'] })
  })

  it.each([
    [null, 'object'],
    ['nope', 'object'],
    [{}, 'projectIds'],
    [{ projectIds: 'p1' }, 'projectIds'],
    [{ projectIds: [] }, 'not be empty'],
    [{ projectIds: ['p1', 42] }, 'non-empty string'],
    [{ projectIds: ['p1', 'p1'] }, 'duplicate'],
  ])('fails closed on malformed manifest %#', (raw, expected) => {
    expect(() => parseClassifyManifest(raw)).toThrow(ClassifyManifestError)
    expect(() => parseClassifyManifest(raw)).toThrow(expected)
  })
})

function mockPrisma(projects: Array<{ id: string; planningState: string }>) {
  return {
    project: {
      findMany: vi.fn().mockResolvedValue(projects),
    },
  } as never
}

describe('planClassification', () => {
  it('classifies CURRENT projects as to-classify and NEEDS_REPLAN ones as already', async () => {
    const report = await planClassification(mockPrisma([
      { id: 'p1', planningState: 'CURRENT' },
      { id: 'p2', planningState: 'NEEDS_REPLAN' },
    ]), { projectIds: ['p1', 'p2'] })

    expect(report.completed).toBe(true)
    expect(report.classifiedCount).toBe(1)
    expect(report.alreadyCount).toBe(1)
    expect(report.entries).toEqual([
      { projectId: 'p1', status: 'to-classify' },
      { projectId: 'p2', status: 'already-needs-replan' },
    ])
  })

  it('reports not-found projects (fail closed)', async () => {
    const report = await planClassification(mockPrisma([{ id: 'p1', planningState: 'CURRENT' }]), {
      projectIds: ['p1', 'p-missing'],
    })

    expect(report.completed).toBe(false)
    expect(report.notFoundCount).toBe(1)
    expect(report.entries.find(e => e.projectId === 'p-missing')?.status).toBe('not-found')
  })
})

describe('classifyNeedsReplan', () => {
  const manifest: ClassifyManifest = { projectIds: ['p1', 'p2'] }

  it('is a read-only dry run by default', async () => {
    const report = await classifyNeedsReplan(mockPrisma([
      { id: 'p1', planningState: 'CURRENT' },
      { id: 'p2', planningState: 'CURRENT' },
    ]), manifest)

    expect(report.classifiedCount).toBe(2)
    expect(resetProjectPlanning).not.toHaveBeenCalled()
  })

  it('applies the atomic reset transaction for each to-classify project', async () => {
    const report = await classifyNeedsReplan(mockPrisma([
      { id: 'p1', planningState: 'CURRENT' },
      { id: 'p2', planningState: 'NEEDS_REPLAN' },
    ]), manifest, { apply: true })

    expect(report.classifiedCount).toBe(1)
    expect(resetProjectPlanning).toHaveBeenCalledTimes(1)
    // Only p1 was reset; p2 was already quarantined (idempotent skip).
    expect(vi.mocked(resetProjectPlanning).mock.calls[0][1]).toBe('p1')
  })

  it('aborts apply when a manifest project no longer exists', async () => {
    await expect(
      classifyNeedsReplan(mockPrisma([{ id: 'p1', planningState: 'CURRENT' }]), {
        projectIds: ['p1', 'p-gone'],
      }, { apply: true }),
    ).rejects.toThrow(ClassifyAbortError)
    expect(resetProjectPlanning).not.toHaveBeenCalled()
  })

  it('aborts dry run planning when a manifest project no longer exists', async () => {
    await expect(
      classifyNeedsReplan(mockPrisma([]), { projectIds: ['p-gone'] }),
    ).rejects.toThrow(ClassifyAbortError)
  })
})
