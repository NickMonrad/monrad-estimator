import type { OptimiserCandidateRT } from '../../lib/api'
import type { ResourceType } from '../../types/backlog'

export interface TimelineRecommendationSignals {
  hasEntries: boolean
  scheduleStale: boolean
  parallelWarningCount: number
  demandBearingResourceTypeCount: number
  scheduledFeatureCount: number
  storyCount: number
  hasManualOverrides: boolean
}

export interface TimelineRecommendation {
  recommendedAction: 'quick-schedule' | 'squad-planner'
  badge: string
  title: string
  summary: string
  rationale: string[]
  secondarySummary: string
}

export interface StartingTeamFinderDefaultRange {
  min: number
  max: number
}

export interface SquadPlannerSeedSettings {
  minFloor: Record<string, number>
  maxCap: Record<string, number>
  seededResourceTypeIds: string[]
}

export function getTimelineRecommendation(
  signals: TimelineRecommendationSignals,
): TimelineRecommendation {
  const rationale: string[] = []
  let complexityScore = 0

  if (!signals.hasEntries) {
    rationale.push('No timeline exists yet, so a fast first pass is useful.')
  }

  if (signals.scheduleStale) {
    rationale.push('Inputs changed since the current timeline was generated.')
    complexityScore += 1
  }

  if (signals.parallelWarningCount > 0) {
    rationale.push(
      `${signals.parallelWarningCount} parallel warning${signals.parallelWarningCount === 1 ? '' : 's'} already need team trade-offs.`,
    )
    complexityScore += 2
  }

  if (signals.demandBearingResourceTypeCount >= 4) {
    rationale.push(
      `${signals.demandBearingResourceTypeCount} demand-bearing resource types need coordinating.`,
    )
    complexityScore += 1
  } else if (signals.demandBearingResourceTypeCount > 0) {
    rationale.push(
      `${signals.demandBearingResourceTypeCount} demand-bearing resource type${signals.demandBearingResourceTypeCount === 1 ? '' : 's'} are active.`,
    )
  }

  if (signals.scheduledFeatureCount >= 10 || signals.storyCount >= 20) {
    rationale.push(
      `${signals.scheduledFeatureCount} scheduled features make the plan broad enough to warrant deliberate squad shaping.`,
    )
    complexityScore += 1
  } else if (signals.scheduledFeatureCount > 0) {
    rationale.push(`${signals.scheduledFeatureCount} scheduled features are currently in play.`)
  }

  if (signals.hasManualOverrides) {
    rationale.push('Manual overrides are already in play, so the team shape should be reviewed deliberately.')
    complexityScore += 1
  }

  const recommendSquadPlanner = complexityScore >= 3

  return recommendSquadPlanner
    ? {
        recommendedAction: 'squad-planner',
        badge: 'Recommended flow',
        title: 'Use Squad Planner as the main workflow',
        summary:
          'This timeline has enough moving parts that it is better to shape the team first, then apply the plan.',
        rationale,
        secondarySummary:
          'Quick schedule is still available for a fast baseline. Starting Team Finder can help you choose an initial squad first.',
      }
    : {
        recommendedAction: 'quick-schedule',
        badge: 'Recommended flow',
        title: 'Start with Quick schedule',
        summary:
          'This project looks simple enough for a quick baseline schedule before you use the heavier planning tools.',
        rationale,
        secondarySummary:
          'If the baseline exposes resourcing trade-offs, move into Starting Team Finder or Squad Planner next.',
      }
}

export function getPlannerResourceTypeVisibility<T extends Pick<ResourceType, 'id' | 'name'>>(
  resourceTypes: T[],
  effectivePlannedResourceTypeIds: string[] | undefined,
  showAllResourceTypes: boolean,
) {
  if (
    !effectivePlannedResourceTypeIds ||
    effectivePlannedResourceTypeIds.length === 0 ||
    showAllResourceTypes
  ) {
    return {
      visibleResourceTypes: resourceTypes,
      hiddenResourceTypes: [] as T[],
      isFiltered: false,
    }
  }

  const plannedIds = new Set(effectivePlannedResourceTypeIds)
  const visibleResourceTypes = resourceTypes.filter(rt => plannedIds.has(rt.id))
  const hiddenResourceTypes = resourceTypes.filter(rt => !plannedIds.has(rt.id))

  return {
    visibleResourceTypes,
    hiddenResourceTypes,
    isFiltered: hiddenResourceTypes.length > 0,
  }
}

export function getStartingTeamFinderDefaultRange(currentCount: number): StartingTeamFinderDefaultRange {
  const safeCurrentCount = Number.isFinite(currentCount) ? Math.max(0, Math.floor(currentCount)) : 0

  return {
    min: 0,
    max: Math.min(12, Math.max(6, safeCurrentCount + 4, Math.ceil(safeCurrentCount * 2))),
  }
}

export function getSquadPlannerSeedSettings(
  candidateResourceTypes: OptimiserCandidateRT[],
  options: {
    allowRampUp: boolean
    seedResourceTypeIds?: string[]
  },
): SquadPlannerSeedSettings {
  const allowedIds =
    options.seedResourceTypeIds && options.seedResourceTypeIds.length > 0
      ? new Set(options.seedResourceTypeIds)
      : null

  const minFloor: Record<string, number> = {}
  const maxCap: Record<string, number> = {}
  const seededResourceTypeIds: string[] = []

  for (const resourceType of candidateResourceTypes) {
    if (allowedIds && !allowedIds.has(resourceType.resourceTypeId)) continue

    const count = Math.max(0, Math.floor(resourceType.count))
    const resourceTypeId = resourceType.resourceTypeId

    if (options.allowRampUp && resourceType.suggestedStartWeek > 0) {
      minFloor[resourceTypeId] = 0
      maxCap[resourceTypeId] = count
    } else {
      minFloor[resourceTypeId] = count
      maxCap[resourceTypeId] = count
    }

    seededResourceTypeIds.push(resourceTypeId)
  }

  return {
    minFloor,
    maxCap,
    seededResourceTypeIds,
  }
}
