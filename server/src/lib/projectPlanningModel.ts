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
import {
  getWeeklyCapacity,
  computeParallelWarnings,
  type ParallelWarning,
  type SchedulerNamedResource,
} from './scheduler.js'
import {
  materializeCapacityPlanResources,
  type MaterializedCapacityPlanResource,
} from './capacityPlanMaterialisation.js'
import { deriveNamedResourceAssignments } from './namedResourceAssignments.js'
import { effectiveDays } from '../utils/round.js'

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
      const days = effectiveDays(task.durationDays, task.hoursEffort, hpd)
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
    if (hasCached) {
      const rtMaxWeek = cachedMaxWeekByRt.get(row.resourceTypeName)
      if (rtMaxWeek != null && row.week <= rtMaxWeek) continue
    }
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
      if ((rt.allocationMode as string | null) === 'CAPACITY_PLAN') {
        const materialized = capacityPlanByRt.get(rt.id)
        capDays = materialized ? (materialized.weeklyHeadcount.get(w) ?? 0) * 5 : 0
      } else {
        const hpd = rt.hoursPerDay ?? hoursPerDay
        capDays = getWeeklyCapacity(rt, w, hoursPerDay) / hpd
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
  // ── 1. Load project with ownership check ───────────────────────────────
  const project = await prisma.project.findFirst({
    where: { id: projectId, ownerId: userId },
  })

  if (!project) {
    throw new NotFoundError('Project not found')
  }

  // ── 2. Load resource types ─────────────────────────────────────────────
  const resourceTypes = await prisma.resourceType.findMany({
    where: { projectId },
    include: {
      namedResources: { orderBy: { createdAt: 'asc' } },
    },
  })
  // ── 2. Load timeline entries ──────────────────────────────────────────
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

  // ── 3. Filter active entries ──────────────────────────────────────────
  const activeEntries = timelineEntries.filter(
    e => e.feature.isActive !== false && e.feature.epic.isActive !== false,
  )
  const activeFeatureIds = activeEntries.map(e => e.featureId)
  const activeFeatureIdSet = new Set(activeFeatureIds)
  const activeStoryIds = storyTimelineEntries
    .filter(e => activeFeatureIdSet.has(e.story.featureId))
    .map(e => e.storyId)
  const activeStoryEntries = storyTimelineEntries.filter(e =>
    activeFeatureIdSet.has(e.story.featureId),
  )

  // ── 4. Load dependencies (active-only) ────────────────────────────────
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

  // ── 5. Load active capacity plan ─────────────────────────────────────
  const activeCapacityPlan = await prisma.capacityPlan.findFirst({
    where: { projectId, isActive: true },
    include: {
      periods: {
        include: { entries: true },
        orderBy: { periodIndex: 'asc' },
      },
    },
  })
  const capacityPlanByRt = materializeCapacityPlanResources(activeCapacityPlan?.periods ?? [])

  // ── 6. Resolved entries (with display metadata) ──────────────────────
  const resolvedEntries: FeatureEntryDetail[] = activeEntries.map(e => ({
    featureId: e.featureId,
    featureName: e.feature.name,
    epicId: e.feature.epic.id,
    epicName: e.feature.epic.name,
    startWeek: e.startWeek,
    durationWeeks: e.durationWeeks,
    isManual: e.isManual,
  }))

  const resolvedStoryEntries: StoryEntryDetail[] = activeStoryEntries.map(e => ({
    storyId: e.storyId,
    storyName: e.story.name,
    featureId: e.story.featureId,
    startWeek: e.startWeek,
    durationWeeks: e.durationWeeks,
    isManual: e.isManual,
  }))

  // ── 7. Build resource type planning facts ────────────────────────────
  const resourceTypeFacts: ResourceTypePlanningFact[] = resourceTypes.map(rt => ({
    id: rt.id,
    name: rt.name,
    category: rt.category,
    count: rt.count,
    hoursPerDay: rt.hoursPerDay,
    dayRate: rt.dayRate,
    allocationMode: rt.allocationMode,
    allocationPercent: rt.allocationPercent,
    allocationStartWeek: rt.allocationStartWeek,
    allocationEndWeek: rt.allocationEndWeek,
    namedResources: (rt.namedResources ?? []).map(nr => ({
      id: nr.id,
      name: nr.name,
      startWeek: nr.startWeek,
      endWeek: nr.endWeek,
      allocationMode: nr.allocationMode,
      allocationPercent: nr.allocationPercent,
      allocationStartWeek: nr.allocationStartWeek,
      allocationEndWeek: nr.allocationEndWeek,
      pricingModel: nr.pricingModel,
      synthetic: false,
    })),
    capacityPlanMaterialized: capacityPlanByRt.get(rt.id),
  }))

  // Apply capacity plan fallback for CAPACITY_PLAN RTs with no named resources
  const enrichedFacts = applyCapacityPlanFallback(resourceTypeFacts, capacityPlanByRt)

  // ── 8. Compute planning window ───────────────────────────────────────
  const planningWindow = computePlanningWindow(
    activeEntries,
    project.startDate,
    project.bufferWeeks ?? 0,
    project.onboardingWeeks ?? 0,
  )

  // ── 9. Compute weekly demand ─────────────────────────────────────────
  const simulatedDemand = convertWeeklyDemandCache(
    project.weeklyDemandCache as Record<string, number> | null,
    resourceTypes,
  )

  const fallbackDemand = buildFallbackWeeklyDemand(
    activeEntries,
    resourceTypes.map(rt => ({
      name: rt.name,
      id: rt.id,
      hoursPerDay: rt.hoursPerDay,
      allocationMode: rt.allocationMode,
      count: rt.count,
      namedResources: (rt.namedResources ?? []) as unknown as SchedulerNamedResource[],
    })),
    capacityPlanByRt,
    project.hoursPerDay,
  )

  const weeklyDemand =
    simulatedDemand && simulatedDemand.size > 0
      ? mergeWeeklyDemand(fallbackDemand, simulatedDemand)
      : fallbackDemand

  // ── 10. Compute weekly capacity ──────────────────────────────────────
  const maxDemandWeek =
    weeklyDemand.length > 0 ? Math.max(...weeklyDemand.map(d => d.week)) : 0
  const capacityEndWeek = Math.max(
    planningWindow.maxWeek != null ? Math.ceil(planningWindow.maxWeek) : 0,
    maxDemandWeek + 1,
  )

  const rtNamesWithDemand = new Set(weeklyDemand.map(d => d.resourceTypeName))
  const capacityRelevantRTs = resourceTypes.filter(rt =>
    rtNamesWithDemand.has(rt.name),
  )

  const weeklyCapacity = computeWeeklyCapacity(
    capacityRelevantRTs,
    project.hoursPerDay,
    capacityEndWeek,
    capacityPlanByRt,
  )

  // ── 11. Reconcile capacity on demand rows ────────────────────────────
  // Some demand rows from mergeWeeklyDemand have capacityDays=0 when they come
  // from simulated demand. Fill in the correct capacity from weeklyCapacity.
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

  // ── 12. Derive named resource assignments ────────────────────────────
  const namedResourceAssignments = deriveNamedResourceAssignments({
    resourceTypes: resourceTypes as unknown as Parameters<typeof deriveNamedResourceAssignments>[0]['resourceTypes'],
    weeklyDemand,
    capacityPlanByRt,
  })

  // ── 13. Compute parallel warnings ────────────────────────────────────
  const activeFeatures = activeEntries.map(e => e.feature)

  // Apply capacity-plan fallback to resource types for parallel warnings
  // (same logic as timeline.ts buildWarningResourceTypes)
  const warningResourceTypes = resourceTypes.map(rt => {
    if (rt.allocationMode !== 'CAPACITY_PLAN') return rt
    const materialized = capacityPlanByRt.get(rt.id)
    if (!materialized) return rt
    // Only fall back when the RT has no named resources
    if ((rt.namedResources ?? []).length > 0) return rt
    return {
      ...rt,
      namedResources: materialized.slotWindows.map((window, idx) => ({
        id: `${rt.id}-capacity-plan-${idx + 1}`,
        name: `${rt.name ?? ''} ${idx + 1}`,
        endWeek: window.endWeek,
        allocationMode: 'CAPACITY_PLAN',
        allocationPercent: window.allocationPercent,
        allocationStartWeek: null,
        allocationEndWeek: null,
        pricingModel: undefined,
      })),
    }
  }) as Array<typeof resourceTypes[number]>

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
    featureDependencies: featureDeps,
    storyDependencies: storyDeps,
    epicDependencies: epicDeps,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Private helpers
// ─────────────────────────────────────────────────────────────────────────────

class NotFoundError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NotFoundError'
  }
}
