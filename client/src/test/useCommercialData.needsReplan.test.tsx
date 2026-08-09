/**
 * useCommercialData.needsReplan.test.tsx — The zero-demand role row filter
 * (issue #449):
 *
 *   - while NEEDS_REPLAN every preserved role row stays visible, including
 *     zero-demand rows, so the user can create its profile before
 *     completing replanning;
 *   - normal CURRENT filtering is unchanged (zero-demand rows without an
 *     overhead link stay hidden).
 */

import React from 'react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import { useCommercialData } from '@/hooks/useCommercialData'
import type { ResourceProfile, Project } from '@/types'

vi.mock('@/lib/api', () => ({
  api: { get: vi.fn().mockResolvedValue({ data: [] }) },
}))

const BASE_PROFILE: ResourceProfile = {
  projectId: 'project-1',
  planningState: 'CURRENT',
  hoursPerDay: 8,
  projectDurationWeeks: 12,
  bufferWeeks: 0,
  onboardingWeeks: 0,
  resourceRows: [],
  overheadRows: [],
  summary: { totalHours: 0, totalDays: 0, totalCost: null, hasCost: false },
}

const PROJECT: Project = { id: 'project-1', name: 'Alpha', planningState: 'CURRENT' } as Project

const zeroDemandRow = {
  resourceTypeId: 'rt-2',
  name: 'Designer',
  category: 'DESIGN',
  count: 1,
  hoursPerDay: 7.6,
  dayRate: 400,
  totalHours: 0,
  effortDays: 0,
  totalDays: 0,
  allocatedDays: 0,
  allocationMode: 'EFFORT',
  allocationPercent: 100,
  allocationStartWeek: null,
  allocationEndWeek: null,
  derivedStartWeek: null,
  derivedEndWeek: null,
  estimatedCost: null,
  epics: [],
  namedResources: [],
} as ResourceProfile['resourceRows'][number]

const demandRow = {
  resourceTypeId: 'rt-1',
  name: 'Engineer',
  category: 'ENGINEERING',
  count: 2,
  hoursPerDay: 7.6,
  dayRate: 500,
  totalHours: 16,
  effortDays: 2,
  totalDays: 0,
  allocatedDays: 0,
  allocationMode: 'EFFORT',
  allocationPercent: 100,
  allocationStartWeek: null,
  allocationEndWeek: null,
  derivedStartWeek: null,
  derivedEndWeek: null,
  estimatedCost: null,
  epics: [],
  namedResources: [],
} as ResourceProfile['resourceRows'][number]

function renderFilter(profile: ResourceProfile) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return renderHook(
    () => useCommercialData('project-1', 'profile', profile, PROJECT),
    { wrapper: ({ children }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider> },
  )
}

beforeEach(() => vi.clearAllMocks())

describe('useCommercialData filteredResourceRows', () => {
  it('keeps every preserved row visible while NEEDS_REPLAN, including zero-demand roles', async () => {
    const { result } = renderFilter({
      ...BASE_PROFILE,
      planningState: 'NEEDS_REPLAN',
      resourceRows: [demandRow, zeroDemandRow],
    })
    await waitFor(() => expect(result.current.filteredResourceRows).toHaveLength(2))
    expect(result.current.filteredResourceRows.map(r => r.resourceTypeId)).toEqual(['rt-1', 'rt-2'])
  })

  it('hides zero-demand rows for CURRENT projects (unchanged behaviour)', async () => {
    const { result } = renderFilter({
      ...BASE_PROFILE,
      planningState: 'CURRENT',
      resourceRows: [demandRow, zeroDemandRow],
    })
    await waitFor(() => expect(result.current.filteredResourceRows).toHaveLength(1))
    expect(result.current.filteredResourceRows[0].resourceTypeId).toBe('rt-1')
  })
})
