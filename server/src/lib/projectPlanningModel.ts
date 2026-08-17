/**
 * projectPlanningModel.ts — Shared project planning read model.
 *
 * Extracts duplicated planning derivation logic from timeline.ts, resourceProfile.ts,
 * and export paths into one module. Owns planning/capacity-derived facts only:
 * delivery effort comes from Backlog/Estimation inputs; commercial pricing rules
 * are out of scope.
 *
 * Two entry points:
 *   1. Pure computation functions (testable without a DB)
 *   2. buildProjectPlanningModel() — thin data-loading wrapper
 *
 * Phase 5 extraction: issue #264 / PR #272
 */

import { prisma } from './prisma.js'
import { resolveSchedulerCapacity } from './schedulerCapacityResolver.js'

import {
  getWeeklyCapacity,
  computeParallelWarnings,
  type ParallelWarning,
  type SchedulerNamedResource,
  type SchedulerCapacitySegment,
  type SchedulerResourceType,
} from './scheduler.js'
import {
  shouldFallbackToActiveCapacityPlan,
  type MaterializedCapacityPlanResource,
} from './capacityPlanMaterialisation.js'
import { deriveNamedResourceAssignments } from './namedResourceAssignments.js'
import { effortDays } from '../utils/round.js'

// ─────────────────────────────────────────────────────────────────────────────
// Cache key resolution (backward-compatible: tries ID then legacy name)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Backward-compatible cache key resolver.
 * Tries key prefix as a resourceTypeId first; if no match, tries as a legacy
 * resourceTypeName. Falls back to 'Unknown resource' when neither matches.
 */
export function resolveCacheKeyResourceTypeName(
  prefix: string,
  resourceTypes: Array<{ id: string; name: string }>,
): string {
  const byId = new Map(resourceTypes.map(rt => [rt.id, rt.name]))
  const byName = new Map(resourceTypes.map(rt => [rt.name.toLowerCase(), rt.name]))

  const nameFromId = byId.get(prefix)
  if (nameFromId) return nameFromId

  const nameFromLegacy = byName.get(prefix.toLowerCase())
  if (nameFromLegacy) return nameFromLegacy

  return 'Unknown resource'
}

/**
 * Convert a raw weeklyDemandCache (Record<string, number>) whose keys may be
 * in either modern (resourceTypeId|week) or legacy (resourceTypeName|week)
 * format into a Map whose keys are always resourceTypeName|week.
 *
 * This is the single canonical entry point for reading the weeklyDemandCache.
 * All cache readers should use this function.
 */
export function convertWeeklyDemandCache(
  cache: Record<string, number> | null | undefined,
  resourceTypes: Array<{ id: string; name: string }>,
): Map<string, number> {
  if (!cache) return new Map()
  const result = new Map<string, number>()
  for (const [key, value] of Object.entries(cache)) {
    const sep = key.lastIndexOf('|')
    if (sep < 0) continue
    const prefix = key.substring(0, sep)
    const week = key.substring(sep + 1)
    const rtName = resolveCacheKeyResourceTypeName(prefix, resourceTypes)
    result.set(`${rtName}|${week}`, value)
  }
  return result
}

// ─────────────────────────────────────────────────────────────────────────────
// Public Types

export interface PlanningWindow {
  /** Last occupied week (max entry end week + buffer + onboarding) */
  maxWeek: number | null
  /** Projected end date as ISO string, or null */
  projectedEndDate: string | null
  /** Buffer weeks configured on the project */
  bufferWeeks: number
  /** Onboarding weeks configured on the project */
  onboardingWeeks: number
}

export interface WeeklyDemandRow {
  week: number
  resourceTypeName: string
  demandDays: number
  capacityDays: number
}

export interface WeeklyCapacityRow {
  week: number
  resourceTypeName: string
  capacityDays: number
}

/** Per-resource-type planning facts derived from resource type + capacity plan */
export interface ResourceTypePlanningFact {
  id: string
  name: string
  category: string
  count: number
  hoursPerDay: number | null
  dayRate: number | null
  allocationMode: string | null
  allocationPercent: number | null
  allocationStartWeek: number | null
  allocationEndWeek: number | null
  namedResources: PlanningNamedResource[]
  /** True when valid persisted named-resource profiles own availability. */
  capacityProfileBacked?: boolean
  /** Materialized capacity plan data for this RT (undefined if no active plan) */
  capacityPlanMaterialized: MaterializedCapacityPlanResource | undefined
}

/** Named resource record with resolved source-record metadata */
export interface PlanningNamedResource {
  id: string
  name: string
  startWeek: number | null
  endWeek: number | null
  allocationMode: string | null
  allocationPercent: number | null
  allocationStartWeek: number | null
  allocationEndWeek: number | null
  pricingModel: string | null
  synthetic: boolean
  /** Segment-aware capacity data from trajectory materialization (CAPACITY_PLAN only). */
  capacitySegments?: { startWeek: number; endWeek: number; allocationPercent: number }[]
}

/** A resolved feature timeline entry with display metadata */
export interface FeatureEntryDetail {
  featureId: string
  featureName: string
  epicId: string
  epicName: string
  startWeek: number
  durationWeeks: number
  isManual: boolean
  /** Epic presentation metadata */
  epicOrder: number | null
  epicFeatureMode: string | null
  epicScheduleMode: string | null
  epicTimelineStartWeek: number | null
  /** Feature presentation metadata */
  featureOrder: number | null
  timelineColour: string | null
  /** Per-resource-type effort breakdown for the feature */
  resourceBreakdown: Array<{ name: string; days: number }>
  /** Engineer-equivalent presentation rows */
  effectiveEngineers: Array<{
    name: string
    engineerEquivalent: number
    totalEngineers: number
  }>
  /** Entry dates shifted by onboarding weeks */
  startDate: string | null
  endDate: string | null
}

/** A resolved story timeline entry with display metadata */
export interface StoryEntryDetail {
  storyId: string
  storyName: string
  featureId: string
  startWeek: number
  durationWeeks: number
  isManual: boolean
}

export interface ProjectPlanningModel {
  /** Project identity */
  projectId: string
  startDate: string | null
  hoursPerDay: number

  /** Planning window derived from entries + buffer/onboarding weeks */
  planningWindow: PlanningWindow

  /** Weekly demand (cached scheduler demand merged with fallback) */
  weeklyDemand: WeeklyDemandRow[]
  /** Weekly capacity for every resource type and week with demand */
  weeklyCapacity: WeeklyCapacityRow[]

  /** Resource types enriched with capacity-plan facts */
  resourceTypeFacts: ResourceTypePlanningFact[]
  /** Materialized capacity plan map (rtId → materialized data) */
  capacityPlanByRt: Map<string, MaterializedCapacityPlanResource>

  /** Named resource assignments derived from demand + capacity plan */
  namedResourceAssignments: ReturnType<typeof deriveNamedResourceAssignments>

  /** Planning warnings (e.g. parallel feature conflicts) */
  parallelWarnings: ParallelWarning[]

  /** Feature timeline entries (active only, with resolved metadata) */
  entries: FeatureEntryDetail[]
  /** Story timeline entries (active only, with resolved metadata) */
  storyEntries: StoryEntryDetail[]

  /** Feature-level dependency edges */
  featureDependencies: Array<{ featureId: string; dependsOnId: string }>
  /** Story-level dependency edges */
  storyDependencies: Array<{ storyId: string; dependsOnId: string }>
  /** Epic-level dependency edges */
  epicDependencies: Array<{ epicId: string; dependsOnId: string }>
}

// ─────────────────────────────────────────────────────────────────────────────
// Planning input types (pure structural shapes — no Prisma dependency)
// ─────────────────────────────────────────────────────────────────────────────

export interface PlanningInputTask {
  resourceTypeId: string | null
  hoursEffort: number
  durationDays: number | null
  resourceType: {
    id: string
    name: string
    hoursPerDay: number | null
  } | null
}

export interface PlanningInputStory {
  id: string
  isActive: boolean | null
  tasks: PlanningInputTask[]
}

/** A feature with full scheduling/effort metadata (as loaded from the backlog) */
export interface PlanningInputFeature {
  id: string
  name: string
  order: number | null
  isActive: boolean | null
  timelineColour: string | null
  epic: {
    id: string
    name: string
    order: number | null
    isActive: boolean | null
    featureMode: string | null
    scheduleMode: string | null
    timelineStartWeek: number | null
  }
  userStories: PlanningInputStory[]
}

/** A persisted feature timeline entry with its feature loaded */
export interface PlanningInputFeatureEntry {
  featureId: string
  startWeek: number
  durationWeeks: number
  isManual: boolean
  feature: PlanningInputFeature
}

/** A persisted story timeline entry with its story loaded */
export interface PlanningInputStoryEntry {
  storyId: string
  startWeek: number
  durationWeeks: number
  isManual: boolean
  story: { name: string; featureId: string }
}

/** A resource type with named resources (display metadata; capacity fields
 * come from the resolved scheduler DTOs, not legacy columns — issue #418) */
export interface PlanningInputResourceType {
  id: string
  name: string
  category: string
  count: number
  hoursPerDay: number | null
  dayRate: number | null
  namedResources: Array<{
    id: string
    name: string
    pricingModel: string | null
  }>
}

/** All inputs the pure planning derivation needs (loaded by loadProjectPlanningInputs). */
export interface ProjectPlanningInputs {
  project: {
    id: string
    startDate: Date | null
    hoursPerDay: number
    bufferWeeks: number | null
    onboardingWeeks: number | null
    weeklyDemandCache: Record<string, number> | null
  }
  /** Prisma resource types with named resources (display metadata) */
  resourceTypes: PlanningInputResourceType[]
  /** Profile-first resolved scheduler capacity DTOs (authoritative availability) */
  capacityResourceTypes: SchedulerResourceType[]
  /** Materialised capacity plan map (rtId → materialised data) */
  capacityPlanByRt: Map<string, MaterializedCapacityPlanResource>
  /** Named resources whose capacity resolved from a valid persisted profile */
  profileBackedNamedResourceIds: string[]
  /** Feature timeline entries with full feature metadata */
  timelineEntries: PlanningInputFeatureEntry[]
  /** Story timeline entries with story metadata */
  storyTimelineEntries: PlanningInputStoryEntry[]
  featureDependencies: Array<{ featureId: string; dependsOnId: string }>
  storyDependencies: Array<{ storyId: string; dependsOnId: string }>
  epicDependencies: Array<{ epicId: string; dependsOnId: string }>
}

/** Explicit not-found error for a missing/unauthorised project (maps to HTTP 404). */
export class ProjectNotFoundError extends Error {
  readonly status = 404
  readonly userMessage = 'Project not found'

  constructor() {
    super('Project not found')
    this.name = 'ProjectNotFoundError'
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure computation helpers
// ─────────────────────────────────────────────────────────────────────────────

const weeklyDemandKey = (week: number, resourceTypeName: string) => `${week}|${resourceTypeName}`

/**
 * Compute the planning window — the span of weeks covered by the project
 * from timeline entries, extended by buffer and onboarding weeks.
 */
export function computePlanningWindow(
  entries: Array<{ startWeek: number; durationWeeks: number }>,
  startDate: Date | null,
  bufferWeeks: number,
  onboardingWeeks: number,
): PlanningWindow {
  const rawMaxWeek =
    entries.length > 0
      ? Math.max(...entries.map(e => e.startWeek + e.durationWeeks))
      : null
  const maxWeek =
    rawMaxWeek != null ? rawMaxWeek + bufferWeeks + onboardingWeeks : null
  const projectedEndDate =
    startDate && maxWeek != null
      ? (() => {
          const d = new Date(startDate)
          d.setDate(d.getDate() + maxWeek * 7)
          return d.toISOString()
        })()
      : null
  return { maxWeek, projectedEndDate, bufferWeeks, onboardingWeeks }
}

/**
 * Compute per-feature resource breakdown (name → days).
 * Duplicates the same logic previously in timeline.ts computeResourceBreakdown.
 */
export function computeResourceBreakdown(
  feature: {
    userStories: Array<{
      isActive: boolean | null
      tasks: Array<{
        resourceTypeId: string | null
        hoursEffort: number
        durationDays: number | null
        resourceType: {
          name: string
          hoursPerDay: number | null
        } | null
      }>
    }>
  },
  fallbackHpd: number,
): Array<{ name: string; days: number }> {
  const byRt = new Map<
    string,
    { name: string; days: number }
  >()
  for (const story of feature.userStories) {
    if (story.isActive === false) continue
    for (const task of story.tasks) {
      const key = task.resourceTypeId ?? '_unassigned'
      const name = task.resourceType?.name ?? 'Unassigned'
      const hpd = task.resourceType?.hoursPerDay ?? fallbackHpd
      const days = effortDays(task.hoursEffort, hpd)
      const existing = byRt.get(key) ?? { name, days: 0 }
      byRt.set(key, { name, days: existing.days + days })
    }
  }
  return Array.from(byRt.values()).map(r => ({
    name: r.name,
    days: Math.round(r.days * 10) / 10,
  }))
}

/**
 * Apply capacity-plan fallback for resource types with CAPACITY_PLAN
 * allocation mode — virtual named resources replace real ones when
 * the RT has no named resources and the capacity plan slots apply.
 * Same logic as timeline.ts buildWarningResourceTypes / resourceProfile.ts
 * capacity-plan fallback.
 */
export function applyCapacityPlanFallback(
  resourceTypes: ResourceTypePlanningFact[],
  capacityPlanByRt: Map<string, MaterializedCapacityPlanResource>,
): ResourceTypePlanningFact[] {
  return resourceTypes.map(rt => {
    if (rt.allocationMode !== 'CAPACITY_PLAN') return rt

    const materialized = capacityPlanByRt.get(rt.id)
    const shouldFallback =
      materialized != null &&
      rt.namedResources.length === 0

    if (!shouldFallback || !materialized) return rt

    return {
      ...rt,
      namedResources: materialized.resourceTrajectories.map((trajectory) => {
        const firstSeg = trajectory.segments[0]
        const lastSeg = trajectory.segments.length > 0 ? trajectory.segments[trajectory.segments.length - 1] : null
        return {
          id: `${rt.id}-capacity-plan-${trajectory.trajectoryIndex + 1}`,
          name: `${rt.name} ${trajectory.trajectoryIndex + 1}`,
          startWeek: firstSeg?.startWeek ?? null,
          endWeek: lastSeg?.endWeek ?? null,
          allocationMode: 'CAPACITY_PLAN',
          allocationPercent: firstSeg?.allocationPercent ?? 100,
          allocationStartWeek: null,
          allocationEndWeek: null,
          pricingModel: 'ACTUAL_DAYS',
          synthetic: true,
          capacitySegments: trajectory.segments.map(s => ({
            startWeek: s.startWeek,
            endWeek: s.endWeek,
            allocationPercent: s.allocationPercent,
          })),
        }
      }),
    }
  })
}
/**
 * Build fallback weekly demand from timeline entries by uniform spread.
 * Same logic as timeline.ts buildFallbackWeeklyDemand / resourceProfile.ts
 * fallback weekly demand generation.
 */
export function buildFallbackWeeklyDemand(
  entries: Array<{
    startWeek: number
    durationWeeks: number
    feature: {
      userStories: Array<{
        isActive: boolean | null
        tasks: Array<{
          resourceTypeId: string | null
          hoursEffort: number
          durationDays: number | null
          resourceType: {
            name: string
            hoursPerDay: number | null
          } | null
        }>
      }>
    }
  }>,
  resourceTypes: Array<{ name: string; id: string; hoursPerDay: number | null; allocationMode: string | null; count: number; namedResources: SchedulerNamedResource[] }>,
  capacityPlanByRt: Map<string, MaterializedCapacityPlanResource>,
  hoursPerDay: number,
): WeeklyDemandRow[] {
  const rtByName = new Map(resourceTypes.map(rt => [rt.name, rt]))
  const weeklyDemandMap = new Map<string, { demandDays: number; capacityDays: number }>()

  for (const e of entries) {
    if (e.durationWeeks <= 0) continue
    const featureStart = e.startWeek
    const featureEnd = e.startWeek + e.durationWeeks
    const breakdown = computeResourceBreakdown(e.feature, hoursPerDay)
    for (const { name, days } of breakdown) {
      const startW = Math.floor(featureStart)
      const endW = Math.ceil(featureEnd)
      const rt = rtByName.get(name)
      for (let w = startW; w < endW; w++) {
        const overlap = Math.min(w + 1, featureEnd) - Math.max(w, featureStart)
        if (overlap <= 0) continue
        const key = weeklyDemandKey(w, name)
        let capDays = 5
        if (rt) {
          const isCp = (rt.allocationMode as string | null) === 'CAPACITY_PLAN'
          if (isCp) {
            const materialized = capacityPlanByRt.get(rt.id)
            if (materialized) {
              capDays = (materialized.weeklyHeadcount.get(w) ?? 0) * 5
            }
          } else {
            const hpd = rt.hoursPerDay ?? hoursPerDay
            capDays = getWeeklyCapacity(rt, w, hoursPerDay) / hpd
          }
        }
        const keyDemand = days * (overlap / e.durationWeeks)
        const existing = weeklyDemandMap.get(key) ?? { demandDays: 0, capacityDays: capDays }
        existing.demandDays += keyDemand
        existing.capacityDays = capDays
        weeklyDemandMap.set(key, existing)
      }
    }
  }

  return Array.from(weeklyDemandMap.entries())
    .map(([key, { demandDays, capacityDays }]) => {
      const [weekStr, ...nameParts] = key.split('|')
      return {
        week: parseInt(weekStr, 10),
        resourceTypeName: nameParts.join('|'),
        demandDays: Math.round(demandDays * 10) / 10,
        capacityDays,
      }
    })
    .sort((a, b) => a.week - b.week || a.resourceTypeName.localeCompare(b.resourceTypeName))
}

/**
 * Merge simulated (cached) demand with fallback demand.
 * For cached resource types, fallback demand is suppressed for weeks
 * up to and including the cached horizon. Cached values win for those weeks.
 * Same logic as timeline.ts lines 202-248 and resourceProfile.ts lines 259-295.
 */
export function mergeWeeklyDemand(
  fallbackDemand: WeeklyDemandRow[],
  simulatedDemand: Map<string, number>,
): WeeklyDemandRow[] {
  const cachedResourceTypes = new Set<string>()
  const cachedMaxWeekByRt = new Map<string, number>()

  for (const key of simulatedDemand.keys()) {
    const separatorIdx = key.lastIndexOf('|')
    const resourceTypeName = key.substring(0, separatorIdx)
    const week = parseInt(key.substring(separatorIdx + 1), 10)
    cachedResourceTypes.add(resourceTypeName)
    const prev = cachedMaxWeekByRt.get(resourceTypeName) ?? Number.NEGATIVE_INFINITY
    cachedMaxWeekByRt.set(resourceTypeName, Math.max(prev, week))
  }

  const mergedDemand = new Map<string, WeeklyDemandRow>()

  for (const row of fallbackDemand) {
    const hasCached = cachedResourceTypes.has(row.resourceTypeName)
    // If a resource type has any cached scheduler demand, suppress every
    // fallback row for that resource type across the entire horizon.
    // This prevents duplicated demand from fallback rows after the final
    // cached week.
    if (hasCached) continue
    mergedDemand.set(weeklyDemandKey(row.week, row.resourceTypeName), row)
  }

  for (const [key, days] of simulatedDemand.entries()) {
    const separatorIdx = key.lastIndexOf('|')
    const resourceTypeName = key.substring(0, separatorIdx)
    const week = parseInt(key.substring(separatorIdx + 1), 10)
    mergedDemand.set(weeklyDemandKey(week, resourceTypeName), {
      week,
      resourceTypeName,
      demandDays: Math.round(days * 100) / 100,
      capacityDays: 0, // will be resolved by caller
    })
  }

  return Array.from(mergedDemand.values())
    .filter(d => d.demandDays > 0)
    .sort((a, b) => a.week - b.week || a.resourceTypeName.localeCompare(b.resourceTypeName))
}

/**
 * Compute weekly capacity for every resource type for weeks 0..endWeek.
 * Capacity for CAPACITY_PLAN RTs comes from the materialized plan; for others
 * it comes from getWeeklyCapacity.
 */
export function computeWeeklyCapacity(
  resourceTypes: Array<{
    id: string
    name: string
    hoursPerDay: number | null
    allocationMode: string | null
    count: number
    namedResources: SchedulerNamedResource[]
    roleSegments?: SchedulerCapacitySegment[]
  }>,
  hoursPerDay: number,
  endWeek: number,
  capacityPlanByRt: Map<string, MaterializedCapacityPlanResource>,
): WeeklyCapacityRow[] {
  const result: WeeklyCapacityRow[] = []
  if (endWeek <= 0) return result

  for (const rt of resourceTypes) {
    for (let w = 0; w < endWeek; w++) {
      let capDays: number

      // Profile-authoritative: capacitySegments or roleSegments override legacy fallback
      const hasProfileAuthority = (rt.namedResources ?? []).some(
        nr => nr.capacitySegments && nr.capacitySegments.length > 0,
      ) || (rt.roleSegments && rt.roleSegments.length > 0)

      if (hasProfileAuthority) {
        const hpd = rt.hoursPerDay ?? hoursPerDay
        capDays = getWeeklyCapacity(rt as SchedulerResourceType, w, hoursPerDay) / hpd
      } else if ((rt.allocationMode as string | null) === 'CAPACITY_PLAN') {
        const materialized = capacityPlanByRt.get(rt.id)
        capDays = materialized ? (materialized.weeklyHeadcount.get(w) ?? 0) * 5 : 0
      } else {
        const hpd = rt.hoursPerDay ?? hoursPerDay
        capDays = getWeeklyCapacity(rt as SchedulerResourceType, w, hoursPerDay) / hpd
      }

      result.push({
        week: w,
        resourceTypeName: rt.name,
        capacityDays: Math.round(capDays * 10) / 10,
      })
    }
  }
  return result
}


// ─────────────────────────────────────────────────────────────────────────────
// Pure planning derivation
// ─────────────────────────────────────────────────────────────────────────────

function addWeeksToDate(startDate: Date | null, offsetWeeks: number): string | null {
  if (!startDate) return null
  const d = new Date(startDate)
  d.setDate(d.getDate() + offsetWeeks * 7)
  return d.toISOString()
}

/**
 * Derive the shared planning read model from loaded inputs.
 *
 * Pure: performs no I/O and imports no Prisma or Express. All database
 * loading happens in {@link loadProjectPlanningInputs};
 * {@link buildProjectPlanningModel} composes the two.
 */
export function deriveProjectPlanningModel(
  inputs: ProjectPlanningInputs,
): ProjectPlanningModel {
  const {
    project,
    resourceTypes: prismaResourceTypes,
    capacityResourceTypes,
    capacityPlanByRt,
    profileBackedNamedResourceIds,
    timelineEntries,
    storyTimelineEntries,
    featureDependencies,
    storyDependencies,
    epicDependencies,
  } = inputs

  // ── 1. Filter active entries ───────────────────────────────────────────
  const activeEntries = timelineEntries.filter(
    e => e.feature.isActive !== false && e.feature.epic.isActive !== false,
  )
  const activeFeatureIds = activeEntries.map(e => e.featureId)
  const activeFeatureIdSet = new Set(activeFeatureIds)
  const activeStoryEntries = storyTimelineEntries.filter(e =>
    activeFeatureIdSet.has(e.story.featureId),
  )

  // ── 2. Resolved entries (display metadata + presentation) ──────────────
  const onboardingWeeks = project.onboardingWeeks ?? 0
  const rtCountByName = new Map(capacityResourceTypes.map(rt => [rt.name, rt.count]))

  const resolvedEntries: FeatureEntryDetail[] = activeEntries.map(e => {
    const breakdown = computeResourceBreakdown(e.feature, project.hoursPerDay)
    const durationWeeksActual = Math.max(e.durationWeeks, 0.01)
    const effectiveEngineers = breakdown.map(({ name, days }) => ({
      name,
      engineerEquivalent: Math.round((days / (durationWeeksActual * 5)) * 100) / 100,
      totalEngineers: rtCountByName.get(name) ?? 1,
    }))
    return {
      featureId: e.featureId,
      featureName: e.feature.name,
      epicId: e.feature.epic.id,
      epicName: e.feature.epic.name,
      startWeek: e.startWeek,
      durationWeeks: e.durationWeeks,
      isManual: e.isManual,
      epicOrder: e.feature.epic.order ?? null,
      epicFeatureMode: e.feature.epic.featureMode ?? null,
      epicScheduleMode: e.feature.epic.scheduleMode ?? null,
      epicTimelineStartWeek: e.feature.epic.timelineStartWeek ?? null,
      featureOrder: e.feature.order ?? null,
      timelineColour: e.feature.timelineColour ?? null,
      resourceBreakdown: breakdown,
      effectiveEngineers,
      startDate: addWeeksToDate(project.startDate, e.startWeek + onboardingWeeks),
      endDate: addWeeksToDate(project.startDate, e.startWeek + e.durationWeeks + onboardingWeeks),
    }
  })

  const resolvedStoryEntries: StoryEntryDetail[] = activeStoryEntries.map(e => ({
    storyId: e.storyId,
    storyName: e.story.name,
    featureId: e.story.featureId,
    startWeek: e.startWeek,
    durationWeeks: e.durationWeeks,
    isManual: e.isManual,
  }))

  // ── 3. Resource type planning facts ────────────────────────────────────
  const profileBackedNamedResourceIdSet = new Set(profileBackedNamedResourceIds)
  const capacityProfileBackedResourceTypeIds = new Set(
    prismaResourceTypes
      .filter(
        rt =>
          (rt.namedResources ?? []).length > 0 &&
          rt.namedResources.every(nr => profileBackedNamedResourceIdSet.has(nr.id)),
      )
      .map(rt => rt.id),
  )

  // Capacity-bearing fact fields (allocationMode/allocationPercent/windows and
  // per-NR availability) come from the profile-derived scheduler DTOs, never
  // from ResourceType/NamedResource candidate columns (issue #418).
  const resolvedRTById = new Map(capacityResourceTypes.map(rt => [rt.id, rt]))
  const resourceTypeFacts: ResourceTypePlanningFact[] = prismaResourceTypes.map(rt => {
    const resolvedRT = resolvedRTById.get(rt.id)
    const resolvedNRs = resolvedRT?.namedResources ?? []
    const resolvedNRById = new Map(resolvedNRs.map(nr => [nr.id, nr]))
    return {
      id: rt.id,
      name: rt.name,
      category: rt.category,
      count: rt.count,
      hoursPerDay: rt.hoursPerDay,
      dayRate: rt.dayRate,
      allocationMode: resolvedRT?.allocationMode ?? 'EFFORT',
      allocationPercent: null,
      allocationStartWeek: null,
      allocationEndWeek: null,
      namedResources: (rt.namedResources ?? []).map(nr => {
        const resolvedNR = resolvedNRById.get(nr.id)
        return {
          id: nr.id,
          name: nr.name,
          startWeek: resolvedNR?.startWeek ?? null,
          endWeek: resolvedNR?.endWeek ?? null,
          allocationMode: resolvedNR?.allocationMode ?? 'EFFORT',
          allocationPercent: resolvedNR?.allocationPercent ?? 100,
          allocationStartWeek: resolvedNR?.allocationStartWeek ?? null,
          allocationEndWeek: resolvedNR?.allocationEndWeek ?? null,
          pricingModel: nr.pricingModel,
          synthetic: false,
          capacitySegments: resolvedNR?.capacitySegments,
        }
      }),
      capacityProfileBacked: capacityProfileBackedResourceTypeIds.has(rt.id),
      capacityPlanMaterialized: capacityPlanByRt.get(rt.id),
    }
  })

  // Apply capacity plan fallback for CAPACITY_PLAN RTs with no named resources
  const enrichedFacts = applyCapacityPlanFallback(resourceTypeFacts, capacityPlanByRt)

  // ── 4. Planning window ─────────────────────────────────────────────────
  const planningWindow = computePlanningWindow(
    activeEntries,
    project.startDate,
    project.bufferWeeks ?? 0,
    onboardingWeeks,
  )

  // ── 5. Weekly demand (feature-granularity fallback + cached merge) ─────
  const simulatedDemand = convertWeeklyDemandCache(
    project.weeklyDemandCache,
    prismaResourceTypes,
  )

  const fallbackDemand = buildFallbackWeeklyDemand(
    activeEntries,
    capacityResourceTypes as Array<{
      name: string; id: string; hoursPerDay: number | null;
      allocationMode: string | null; count: number;
      namedResources: SchedulerNamedResource[]
    }>,
    capacityPlanByRt,
    project.hoursPerDay,
  )

  const weeklyDemand =
    simulatedDemand.size > 0
      ? mergeWeeklyDemand(fallbackDemand, simulatedDemand)
      : fallbackDemand

  // ── 6. Weekly capacity ─────────────────────────────────────────────────
  const maxDemandWeek =
    weeklyDemand.length > 0 ? Math.max(...weeklyDemand.map(d => d.week)) : 0
  const capacityEndWeek = Math.max(
    planningWindow.maxWeek != null ? Math.ceil(planningWindow.maxWeek) : 0,
    maxDemandWeek + 1,
  )

  const rtNamesWithDemand = new Set(weeklyDemand.map(d => d.resourceTypeName))
  const capacityRelevantRTs = capacityResourceTypes.filter(rt =>
    rtNamesWithDemand.has(rt.name),
  )

  const weeklyCapacity = computeWeeklyCapacity(
    capacityRelevantRTs as Array<{
      id: string; name: string; hoursPerDay: number | null;
      allocationMode: string | null; count: number;
      namedResources: SchedulerNamedResource[]
    }>,
    project.hoursPerDay,
    capacityEndWeek,
    capacityPlanByRt,
  )

  // ── 7. Reconcile capacity on demand rows ───────────────────────────────
  const capMap = new Map<string, number>()
  for (const cap of weeklyCapacity) {
    capMap.set(weeklyDemandKey(cap.week, cap.resourceTypeName), cap.capacityDays)
  }
  for (const d of weeklyDemand) {
    const key = weeklyDemandKey(d.week, d.resourceTypeName)
    if (capMap.has(key)) {
      d.capacityDays = capMap.get(key)!
    }
  }

  // ── 8. Named resource assignments ──────────────────────────────────────
  const namedResourceAssignments = deriveNamedResourceAssignments({
    resourceTypes: capacityResourceTypes,
    weeklyDemand,
  })

  // ── 9. Parallel warnings (profile-aware) ───────────────────────────────
  const activeFeatures = activeEntries.map(e => e.feature)

  const warningResourceTypes = capacityResourceTypes.map(rt => {
    if (rt.allocationMode !== 'CAPACITY_PLAN') return rt

    // Profile-backed NRs or role segments are already authoritative — skip fallback
    const hasAnyProfileAuthority = (rt.namedResources ?? []).some(
      nr => nr.capacitySegments && nr.capacitySegments.length > 0,
    ) || (rt.roleSegments && rt.roleSegments.length > 0)
    if (hasAnyProfileAuthority) return rt

    const materialized = capacityPlanByRt.get(rt.id)
    const useCapacityPlanFallback = shouldFallbackToActiveCapacityPlan(
      rt.namedResources ?? [],
      materialized,
    )
    if (!useCapacityPlanFallback || !materialized) return rt

    return {
      ...rt,
      namedResources: (materialized.slotWindows ?? []).map((window, idx) => ({
        id: `${rt.id}-capacity-plan-${idx + 1}`,
        name: `${rt.name ?? ''} ${idx + 1}`,
        endWeek: window.endWeek,
        allocationMode: 'CAPACITY_PLAN',
        allocationPercent: window.allocationPercent,
        allocationStartWeek: null,
        allocationEndWeek: null,
        startWeek: window.startWeek,
        allocationPct: window.allocationPercent,
        pricingModel: undefined,
      })),
    }
  }) as typeof capacityResourceTypes

  const parallelWarnings = computeParallelWarnings(
    project.hoursPerDay,
    activeEntries,
    activeFeatures,
    warningResourceTypes,
  )

  return {
    projectId: project.id,
    startDate: project.startDate?.toISOString() ?? null,
    hoursPerDay: project.hoursPerDay,
    planningWindow,
    weeklyDemand,
    weeklyCapacity,
    resourceTypeFacts: enrichedFacts,
    capacityPlanByRt,
    namedResourceAssignments,
    parallelWarnings,
    entries: resolvedEntries,
    storyEntries: resolvedStoryEntries,
    featureDependencies,
    storyDependencies,
    epicDependencies,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Data loading
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Load every input the pure planning derivation needs, with ownership check.
 * Loading and derivation are separate so the derivation stays pure and
 * testable without Prisma or Express.
 */
export async function loadProjectPlanningInputs(
  projectId: string,
  userId: string,
): Promise<ProjectPlanningInputs> {
  // ── 1. Load project with ownership check ───────────────────────────────
  const project = await prisma.project.findFirst({
    where: { id: projectId, ownerId: userId },
  })

  if (!project) {
    throw new ProjectNotFoundError()
  }

  // ── 2. Load Prisma resource types (for display fields) ────────────────
  const prismaResourceTypes = await prisma.resourceType.findMany({
    where: { projectId },
    include: {
      namedResources: { orderBy: { createdAt: 'asc' } },
    },
  })

  // ── 3. Resolve scheduler capacity (profile-first) ─────────────────────
  const resolved = await resolveSchedulerCapacity(prisma, projectId)

  // ── 4. Load timeline entries and story entries ──────────────────────
  const [timelineEntries, storyTimelineEntries] = await Promise.all([
    prisma.timelineEntry.findMany({
      where: { projectId },
      include: {
        feature: {
          include: {
            epic: true,
            userStories: {
              include: {
                tasks: { include: { resourceType: true } },
              },
            },
          },
        },
      },
      orderBy: { startWeek: 'asc' },
    }),
    prisma.storyTimelineEntry.findMany({
      where: { projectId },
      include: { story: { select: { name: true, featureId: true } } },
    }),
  ])

  // ── 5. Load dependencies (active-only) ─────────────────────────────────
  const activeFeatureIds = timelineEntries
    .filter(e => e.feature.isActive !== false && e.feature.epic.isActive !== false)
    .map(e => e.featureId)
  const activeFeatureIdSet = new Set(activeFeatureIds)
  const activeStoryIds = storyTimelineEntries
    .filter(e => activeFeatureIdSet.has(e.story.featureId))
    .map(e => e.storyId)

  const [featureDeps, storyDeps, epicDeps] = await Promise.all([
    prisma.featureDependency.findMany({
      where: { featureId: { in: activeFeatureIds } },
      select: { featureId: true, dependsOnId: true },
    }),
    prisma.storyDependency.findMany({
      where: { storyId: { in: activeStoryIds } },
      select: { storyId: true, dependsOnId: true },
    }),
    prisma.epicDependency.findMany({
      where: { epic: { projectId } },
      select: { epicId: true, dependsOnId: true },
    }),
  ])

  return {
    project: {
      id: project.id,
      startDate: project.startDate,
      hoursPerDay: project.hoursPerDay,
      bufferWeeks: project.bufferWeeks,
      onboardingWeeks: project.onboardingWeeks,
      weeklyDemandCache: project.weeklyDemandCache as Record<string, number> | null,
    },
    resourceTypes: prismaResourceTypes as unknown as PlanningInputResourceType[],
    capacityResourceTypes: resolved.resourceTypes,
    capacityPlanByRt: resolved.capacityPlanByRt,
    profileBackedNamedResourceIds: resolved.meta.profileBackedNamedResourceIds,
    timelineEntries: timelineEntries as unknown as PlanningInputFeatureEntry[],
    storyTimelineEntries: storyTimelineEntries as unknown as PlanningInputStoryEntry[],
    featureDependencies: featureDeps,
    storyDependencies: storyDeps,
    epicDependencies: epicDeps,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Data-loading wrapper
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Load project planning data from the database and compute the shared
 * planning read model. This is the main entry point for routes that
 * need planning-derived facts.
 */
export async function buildProjectPlanningModel(
  projectId: string,
  userId: string,
): Promise<ProjectPlanningModel> {
  const inputs = await loadProjectPlanningInputs(projectId, userId)
  return deriveProjectPlanningModel(inputs)
}
