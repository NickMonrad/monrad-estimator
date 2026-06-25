import { describe, expect, it } from 'vitest'
import {
  getPlannerResourceTypeVisibility,
  getSquadPlannerSeedSettings,
  getStartingTeamFinderDefaultRange,
  getTimelineRecommendation,
} from '@/components/timeline/timelineUx'

describe('getTimelineRecommendation', () => {
  it('recommends update timeline for a simple first-pass project', () => {
    const recommendation = getTimelineRecommendation({
      hasEntries: false,
      scheduleStale: false,
      parallelWarningCount: 0,
      demandBearingResourceTypeCount: 2,
      scheduledFeatureCount: 0,
      storyCount: 0,
      hasManualOverrides: false,
    })

    expect(recommendation.recommendedAction).toBe('quick-schedule')
    expect(recommendation.title).toContain('Update timeline')
    expect(recommendation.secondarySummary).toContain('Squad Planner')
    expect(recommendation.secondarySummary).toContain('Starting Team Finder')
  })

  it('recommends squad planner when warnings and complexity stack up', () => {
    const recommendation = getTimelineRecommendation({
      hasEntries: true,
      scheduleStale: true,
      parallelWarningCount: 2,
      demandBearingResourceTypeCount: 5,
      scheduledFeatureCount: 14,
      storyCount: 28,
      hasManualOverrides: true,
    })

    expect(recommendation.recommendedAction).toBe('squad-planner')
    expect(recommendation.title).toContain('capacity planning')
    expect(recommendation.secondarySummary).toContain('Generate or review a capacity profile for larger programmes')
    expect(recommendation.secondarySummary).toContain('Update timeline remains the scheduling action')
    expect(recommendation.secondarySummary).toContain('Find a sensible starting squad size to use with Squad Planner')
    expect(recommendation.rationale).toEqual(
      expect.arrayContaining([
        expect.stringContaining('parallel warnings'),
        expect.stringContaining('demand-bearing resource types'),
      ]),
    )
  })
})

describe('getPlannerResourceTypeVisibility', () => {
  const resourceTypes = [
    { id: 'rt-dev', name: 'Developer' },
    { id: 'rt-ba', name: 'Business Analyst' },
    { id: 'rt-pm', name: 'Project Manager' },
  ]

  it('hides zero-demand resource types by default once the plan identifies active roles', () => {
    const visibility = getPlannerResourceTypeVisibility(resourceTypes, ['rt-dev', 'rt-pm'], false)

    expect(visibility.visibleResourceTypes.map(rt => rt.id)).toEqual(['rt-dev', 'rt-pm'])
    expect(visibility.hiddenResourceTypes.map(rt => rt.id)).toEqual(['rt-ba'])
    expect(visibility.isFiltered).toBe(true)
  })

  it('shows all resource types when the user expands the full list', () => {
    const visibility = getPlannerResourceTypeVisibility(resourceTypes, ['rt-dev'], true)

    expect(visibility.visibleResourceTypes.map(rt => rt.id)).toEqual(['rt-dev', 'rt-ba', 'rt-pm'])
    expect(visibility.hiddenResourceTypes).toEqual([])
  })

  it('shows all resource types when no planned ids are available yet', () => {
    const visibility = getPlannerResourceTypeVisibility(resourceTypes, undefined, false)

    expect(visibility.visibleResourceTypes.map(rt => rt.id)).toEqual(['rt-dev', 'rt-ba', 'rt-pm'])
    expect(visibility.hiddenResourceTypes).toEqual([])
    expect(visibility.isFiltered).toBe(false)
  })
})

describe('getStartingTeamFinderDefaultRange', () => {
  it('starts at one and searches broadly around the current count', () => {
    expect(getStartingTeamFinderDefaultRange(1)).toEqual({ min: 1, max: 6 })
    expect(getStartingTeamFinderDefaultRange(3)).toEqual({ min: 1, max: 7 })
    expect(getStartingTeamFinderDefaultRange(5)).toEqual({ min: 1, max: 10 })
  })

  it('caps the search range at twelve people', () => {
    expect(getStartingTeamFinderDefaultRange(8)).toEqual({ min: 1, max: 12 })
    expect(getStartingTeamFinderDefaultRange(20)).toEqual({ min: 1, max: 12 })
  })
})

describe('getSquadPlannerSeedSettings', () => {
  const candidateResourceTypes = [
    { resourceTypeId: 'rt-dev', count: 4, suggestedStartWeek: 0 },
    { resourceTypeId: 'rt-ba', count: 2, suggestedStartWeek: 3 },
    { resourceTypeId: 'rt-pm', count: 1, suggestedStartWeek: 0 },
  ]

  it('locks seeded counts unless ramp-up is explicitly allowed later', () => {
    const seed = getSquadPlannerSeedSettings(candidateResourceTypes, {
      allowRampUp: false,
      seedResourceTypeIds: ['rt-dev', 'rt-ba'],
    })

    expect(seed.minFloor).toEqual({
      'rt-dev': 4,
      'rt-ba': 2,
    })
    expect(seed.maxCap).toEqual({
      'rt-dev': 4,
      'rt-ba': 2,
    })
    expect(seed.seededResourceTypeIds).toEqual(['rt-dev', 'rt-ba'])
  })

  it('uses zero floors for later ramp-up candidates and leaves unseeded RTs alone', () => {
    const seed = getSquadPlannerSeedSettings(candidateResourceTypes, {
      allowRampUp: true,
      seedResourceTypeIds: ['rt-ba', 'rt-pm'],
    })

    expect(seed.minFloor).toEqual({
      'rt-ba': 0,
      'rt-pm': 1,
    })
    expect(seed.maxCap).toEqual({
      'rt-ba': 2,
      'rt-pm': 1,
    })
    expect(seed.seededResourceTypeIds).toEqual(['rt-ba', 'rt-pm'])
  })
})
