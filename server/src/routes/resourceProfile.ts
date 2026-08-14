import { Router, Response } from 'express'
import { ResourceCategory } from '@prisma/client'
import { prisma } from '../lib/prisma.js'
import { asyncHandler } from '../lib/asyncHandler.js'
import { authenticate, AuthRequest } from '../middleware/auth.js'
import { effectiveDays } from '../utils/round.js'
import {
  materializeCapacityPlanResources,
} from '../lib/capacityPlanMaterialisation.js'
import { buildResourceCapacityProfileMap } from '../lib/capacityProfileResourceAdapter.js'
import { resolveSchedulerCapacity } from '../lib/schedulerCapacityResolver.js'
import { deriveNamedResourceAssignments, type WeeklyDemandLike } from '../lib/namedResourceAssignments.js'
import { buildFallbackWeeklyDemand, mergeWeeklyDemand, computePlanningWindow, convertWeeklyDemandCache } from '../lib/projectPlanningModel.js'
import type { SchedulerNamedResource } from '../lib/scheduler.js'
import { projectCapacityProfileToLegacyAllocation } from '../lib/capacityProfileLegacyProjection.js'
type AllocationMode = 'EFFORT' | 'TIMELINE' | 'FULL_PROJECT' | 'CAPACITY_PLAN'

const router = Router({ mergeParams: true })
router.use(authenticate)

const CATEGORY_ORDER: ResourceCategory[] = ['ENGINEERING', 'GOVERNANCE', 'PROJECT_MANAGEMENT']
const round2 = (value: number) => Math.round(value * 100) / 100

router.get('/', asyncHandler(async (req: AuthRequest, res: Response) => {
  const projectId = req.params.projectId as string
  const project = await prisma.project.findFirst({
    where: { id: projectId, ownerId: req.userId },
    include: {
      resourceTypes: {
        include: {
          globalType: true,
          namedResources: { orderBy: { createdAt: 'asc' } }
        }
      },
      epics: {
        orderBy: { order: 'asc' },
        include: {
          features: {
            orderBy: { order: 'asc' },
            include: {
              userStories: {
                orderBy: { order: 'asc' },
                include: {
                  tasks: {
                    orderBy: { order: 'asc' },
                    include: { resourceType: true },
                  },
                },
              },
            },
          },
        },
      },
      overheads: {
        include: { resourceType: { include: { globalType: true } } },
        orderBy: [{ order: 'asc' }, { createdAt: 'asc' }],
      },
      timelineEntries: true,
      storyTimelineEntries: { select: { storyId: true, startWeek: true, durationWeeks: true } },
      capacityPlans: {
        where: { isActive: true },
        take: 1,
        include: { periods: { include: { entries: true }, orderBy: { periodIndex: 'asc' } } },
      },
      capacityProfiles: {
        include: {
          segments: {
            orderBy: [
              { startWeek: 'asc' },
              { endWeek: 'asc' },
            ],
          },
        },
      },
    },
  })

  if (!project) {
    res.status(404).json({ error: 'Project not found' })
    return
  }

  const fallbackHoursPerDay = project.hoursPerDay
  const resourceTypeById = new Map(project.resourceTypes.map(rt => [rt.id, rt]))

  // ── Effort aggregation (backlog-owned; runs before any planning-derived
  // computation so the NEEDS_REPLAN branch below can serve effort/inputs
  // without touching the capacity model). ──────────────────────────────────

  // Build lookup maps for timeline entries
  const featureEntryMap = new Map(project.timelineEntries.map(e => [e.featureId, e]))
  const storyEntryMap = new Map(project.storyTimelineEntries.map(e => [e.storyId, e]))

  // Track min start week / max end week per resource type (for TIMELINE allocation)
  const rtWeeks = new Map<string, { starts: number[]; ends: number[] }>()

  type StoryAgg = { storyId: string; storyName: string; order: number; hours: number; days: number }
  type FeatureAgg = {
    featureId: string
    featureName: string
    order: number
    hours: number
    days: number
    stories: Map<string, StoryAgg>
  }
  type EpicAgg = {
    epicId: string
    epicName: string
    order: number
    hours: number
    days: number
    features: Map<string, FeatureAgg>
  }
  type ResourceAgg = {
    resourceTypeId: string
    hoursPerDay: number
    totalHours: number
    totalDays: number
    epics: Map<string, EpicAgg>
  }

  const resourceAgg = new Map<string, ResourceAgg>()

  for (const epic of project.epics) {
    if (epic.isActive === false) continue
    for (const feature of epic.features) {
      if (feature.isActive === false) continue
      for (const story of feature.userStories) {
        if (story.isActive === false) continue
        for (const task of story.tasks) {
          if (!task.resourceTypeId) continue
          const resourceType = resourceTypeById.get(task.resourceTypeId)
          if (!resourceType) continue
          const effectiveHoursPerDay =
            resourceType.hoursPerDay && resourceType.hoursPerDay > 0 ? resourceType.hoursPerDay : fallbackHoursPerDay
          if (!effectiveHoursPerDay) continue

          const hours = task.hoursEffort ?? 0
          const days = effectiveDays(task.durationDays, hours, effectiveHoursPerDay)
          if (!resourceAgg.has(resourceType.id)) {
            resourceAgg.set(resourceType.id, {
              resourceTypeId: resourceType.id,
              hoursPerDay: effectiveHoursPerDay,
              totalHours: 0,
              totalDays: 0,
              epics: new Map(),
            })
          }
          const agg = resourceAgg.get(resourceType.id)!
          agg.totalHours += hours
          agg.totalDays += days

          // Collect week ranges for TIMELINE allocation mode
          const storyEntry = storyEntryMap.get(story.id)
          const featureEntry = featureEntryMap.get(feature.id)
          const entry = storyEntry ?? featureEntry
          if (entry) {
            if (!rtWeeks.has(resourceType.id)) {
              rtWeeks.set(resourceType.id, { starts: [], ends: [] })
            }
            rtWeeks.get(resourceType.id)!.starts.push(entry.startWeek)
            rtWeeks.get(resourceType.id)!.ends.push(entry.startWeek + entry.durationWeeks)
          }

          const epicAgg =
            agg.epics.get(epic.id) ??
            {
              epicId: epic.id,
              epicName: epic.name,
              order: epic.order ?? 0,
              hours: 0,
              days: 0,
              features: new Map<string, FeatureAgg>(),
            }
          epicAgg.hours += hours
          epicAgg.days += days
          agg.epics.set(epic.id, epicAgg)

          const featureAgg =
            epicAgg.features.get(feature.id) ??
            {
              featureId: feature.id,
              featureName: feature.name,
              order: feature.order ?? 0,
              hours: 0,
              days: 0,
              stories: new Map<string, StoryAgg>(),
            }
          featureAgg.hours += hours
          featureAgg.days += days
          epicAgg.features.set(feature.id, featureAgg)

          const storyAgg =
            featureAgg.stories.get(story.id) ??
            {
              storyId: story.id,
              storyName: story.name,
              order: story.order ?? 0,
              hours: 0,
              days: 0,
            }
          storyAgg.hours += hours
          storyAgg.days += days
          featureAgg.stories.set(story.id, storyAgg)
        }
      }
    }
  }

  if (project.planningState === 'NEEDS_REPLAN') {
    // ── Persisted ROLE profile + missing-profile markers (issue #456) ──
    // While NEEDS_REPLAN a role row must show whether the canonical ROLE
    // profile required for completion is persisted, instead of presenting
    // the effective draft as if it were canonical state. A role requires a
    // ROLE profile when it has no named resources, or when any of its
    // profiles are planner-owned (PLANNED_RESOURCE / SQUAD_PLANNER) — the
    // same boundary checkPersistedCompleteness enforces.
    const profileByRtId = new Map<string, (typeof project.capacityProfiles)[number]>()
    const plannerOwnedRtIds = new Set<string>()
    const rtIdByNamedResourceId = new Map<string, string>()
    for (const rt of project.resourceTypes) {
      for (const nr of rt.namedResources) rtIdByNamedResourceId.set(nr.id, rt.id)
    }
    for (const profile of project.capacityProfiles) {
      if (profile.ownerKind === 'ROLE' && profile.resourceTypeId) {
        profileByRtId.set(profile.resourceTypeId, profile)
      }
      if (profile.ownerKind === 'PLANNED_RESOURCE' || profile.source === 'SQUAD_PLANNER') {
        const rtId = profile.resourceTypeId
          ?? (profile.namedResourceId ? rtIdByNamedResourceId.get(profile.namedResourceId) : undefined)
        if (rtId) plannerOwnedRtIds.add(rtId)
      }
    }
    // Mirror capacityProfileMapping.toCamel so the emitted profile shape
    // matches the camelCase contract the client types and badge logic use.
    const toCamel = (value: string) =>
      value.toLowerCase().replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())

    // Reset Planning discarded the capacity model. Serve the estimation and
    // business inputs the user needs to replan — roles, counts, rates, effort
    // rollups, named-resource identity — with NO planning-derived values:
    // no capacity-plan materialisation, no profile/legacy projection, no
    // scheduler resolution, no assignments, no commercial totals. The client
    // shows the explicit "Planning needs attention" state instead of treating
    // any of this as current planning.
    const resourceRows = Array.from(resourceAgg.values())
      .map(agg => {
        const resourceType = resourceTypeById.get(agg.resourceTypeId)!
        const dayRate = resourceType.dayRate ?? resourceType.globalType?.defaultDayRate ?? null
        const persistedRoleProfile = profileByRtId.get(resourceType.id)
        const requiresRoleProfile =
          resourceType.namedResources.length === 0 || plannerOwnedRtIds.has(resourceType.id)
        return {
          resourceTypeId: resourceType.id,
          name: resourceType.name,
          category: resourceType.category,
          count: resourceType.count,
          hoursPerDay: agg.hoursPerDay,
          dayRate,
          totalHours: round2(agg.totalHours),
          effortDays: round2(agg.totalDays),
          totalDays: 0,
          allocatedDays: 0,
          // Display-only default matching the pre-existing no-profile row
          // shape, so the capacity editor opens with the same 100% "As
          // needed" draft a normal project gets. Nothing is persisted or
          // fabricated: allocatedDays/totalDays/cost stay zero and the
          // explicit planningState marker keeps the UI in quarantine.
          allocationMode: 'EFFORT',
          allocationPercent: 100,
          allocationStartWeek: null,
          allocationEndWeek: null,
          derivedStartWeek: null,
          derivedEndWeek: null,
          estimatedCost: null,
          epics: [],
          capacityProfile: persistedRoleProfile ? {
            planningBasis: toCamel(String(persistedRoleProfile.planningBasis)),
            source: toCamel(String(persistedRoleProfile.source)),
            defaultPercent: persistedRoleProfile.defaultPercent,
            startWeek: persistedRoleProfile.startWeek,
            endWeek: persistedRoleProfile.endWeek,
            segments: persistedRoleProfile.segments.map(segment => ({
              startWeek: segment.startWeek,
              endWeek: segment.endWeek,
              capacityPercent: segment.capacityPercent,
            })),
            resolutionSource: 'PROFILE' as const,
          } : undefined,
          missingCapacityProfile: requiresRoleProfile && !persistedRoleProfile,
          namedResources: resourceType.namedResources.map(nr => ({
            id: nr.id,
            name: nr.name,
            resourceTypeId: nr.resourceTypeId,
            pricingModel: nr.pricingModel === 'PRO_RATA' ? 'PRO_RATA' : 'ACTUAL_DAYS',
            allocationMode: 'EFFORT',
            allocationPercent: 100,
            allocationPct: 100,
            allocationStartWeek: null,
            allocationEndWeek: null,
            startWeek: null,
            endWeek: null,
            allocatedDays: 0,
            derivedStartWeek: null,
            derivedEndWeek: null,
            actualAllocatedDays: 0,
            actualAllocationStartWeek: null,
            actualAllocationEndWeek: null,
            actualAllocatedWeeks: [],
            actualAllocationSegments: [],
            synthetic: false,
            resourceIdentity: 'NAMED_PERSON' as const,
          })),
        }
      })

    // Preserved zero-demand roles: Reset Planning keeps every ResourceType,
    // and canonical completion requires a profile for each role without
    // named-resource coverage. While NEEDS_REPLAN, every preserved role must
    // therefore be visible in the replanning surface — including roles with
    // no active task demand — so the user can create their chosen profile
    // through the normal capacity editor. Identity and non-planning metadata
    // are kept; effort/demand are zero and no capacity is fabricated.
    for (const resourceType of project.resourceTypes) {
      if (resourceAgg.has(resourceType.id)) continue
      const persistedRoleProfile = profileByRtId.get(resourceType.id)
      const requiresRoleProfile =
        resourceType.namedResources.length === 0 || plannerOwnedRtIds.has(resourceType.id)
      resourceRows.push({
        resourceTypeId: resourceType.id,
        name: resourceType.name,
        category: resourceType.category,
        count: resourceType.count,
        hoursPerDay: resourceType.hoursPerDay ?? fallbackHoursPerDay,
        dayRate: resourceType.dayRate ?? resourceType.globalType?.defaultDayRate ?? null,
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
        capacityProfile: persistedRoleProfile ? {
          planningBasis: toCamel(String(persistedRoleProfile.planningBasis)),
          source: toCamel(String(persistedRoleProfile.source)),
          defaultPercent: persistedRoleProfile.defaultPercent,
          startWeek: persistedRoleProfile.startWeek,
          endWeek: persistedRoleProfile.endWeek,
          segments: persistedRoleProfile.segments.map(segment => ({
            startWeek: segment.startWeek,
            endWeek: segment.endWeek,
            capacityPercent: segment.capacityPercent,
          })),
          resolutionSource: 'PROFILE' as const,
        } : undefined,
        missingCapacityProfile: requiresRoleProfile && !persistedRoleProfile,
        namedResources: resourceType.namedResources.map(nr => ({
          id: nr.id,
          name: nr.name,
          resourceTypeId: nr.resourceTypeId,
          pricingModel: nr.pricingModel === 'PRO_RATA' ? 'PRO_RATA' : 'ACTUAL_DAYS',
          allocationMode: 'EFFORT',
          allocationPercent: 100,
          allocationPct: 100,
          allocationStartWeek: null,
          allocationEndWeek: null,
          startWeek: null,
          endWeek: null,
          allocatedDays: 0,
          derivedStartWeek: null,
          derivedEndWeek: null,
          actualAllocatedDays: 0,
          actualAllocationStartWeek: null,
          actualAllocationEndWeek: null,
          actualAllocatedWeeks: [],
          actualAllocationSegments: [],
          synthetic: false,
          resourceIdentity: 'NAMED_PERSON' as const,
        })),
      })
    }

    resourceRows.sort((a, b) => {
        const indexOf = (cat: string) => {
          const idx = CATEGORY_ORDER.indexOf(cat as ResourceCategory)
          return idx === -1 ? CATEGORY_ORDER.length : idx
        }
        const catDiff = indexOf(a.category) - indexOf(b.category)
        if (catDiff !== 0) return catDiff
        return a.name.localeCompare(b.name)
      })

    const totalResourceHours = round2(resourceRows.reduce((sum, row) => sum + row.totalHours, 0))

    res.json({
      projectId,
      planningState: 'NEEDS_REPLAN',
      hoursPerDay: fallbackHoursPerDay,
      projectDurationWeeks: 0,
      bufferWeeks: project.bufferWeeks ?? 0,
      onboardingWeeks: project.onboardingWeeks ?? 0,
      resourceRows,
      overheadRows: project.overheads.map(overhead => ({
        overheadId: overhead.id,
        name: overhead.name,
        resourceTypeId: overhead.resourceTypeId,
        resourceTypeName: overhead.resourceType?.name ?? null,
        dayRate: overhead.resourceType?.dayRate ?? overhead.resourceType?.globalType?.defaultDayRate ?? null,
        type: overhead.type,
        value: overhead.value,
        computedDays: 0,
        estimatedCost: null,
        requiredFTE: 0,
        currentCount: overhead.resourceType?.count ?? null,
      })),
      summary: {
        totalHours: totalResourceHours,
        totalDays: 0,
        totalCost: null,
        hasCost: false,
      },
    })
    return
  }

  // Materialize capacity plan for shared model consumption
  const capacityPlanByRt = materializeCapacityPlanResources(
    (project.capacityPlans?.[0] ?? null)?.periods ?? [],
  )
  // Build capacity-profile enrichment map (profile-first, fail-closed)
  const { roleProfiles, namedResourceProfiles } = buildResourceCapacityProfileMap(
    project as unknown as Parameters<typeof buildResourceCapacityProfileMap>[0],
  )
  // Resolve profile-first scheduler capacity — the single source for
  // per-resource availability (legacy-shaped display fields are projected
  // from authoritative profiles, never read from candidate columns).
  const resolvedCapacity = await resolveSchedulerCapacity(prisma, projectId)

  // Project duration in weeks
  const planningWindow = computePlanningWindow(
    project.timelineEntries,
    project.startDate,
    project.bufferWeeks ?? 0,
    project.onboardingWeeks ?? 0,
  )
  const projectDurationWeeks = planningWindow.maxWeek ?? 0

  // ── Fallback weekly demand from shared model ──────────────────────
  // Build entries at story-level granularity to preserve story-level scheduling semantics.
  // Stories with a story timeline entry get their own timing; remaining active stories
  // without a story entry are grouped under their feature-level timeline entry.
  const fallbackEntries: Array<{
    startWeek: number
    durationWeeks: number
    feature: {
      userStories: Array<{
        isActive: boolean | null
        tasks: Array<{
          resourceTypeId: string | null
          hoursEffort: number
          durationDays: number | null
          resourceType: { name: string; hoursPerDay: number | null } | null
        }>
      }>
    }
  }> = []
  const storyTimedIds = new Set<string>()
  for (const epic of project.epics) {
    if (epic.isActive === false) continue
    for (const feature of epic.features) {
      if (feature.isActive === false) continue
      for (const story of feature.userStories) {
        if (story.isActive === false) continue
        const storyEntry = storyEntryMap.get(story.id)
        if (storyEntry) {
          fallbackEntries.push({
            startWeek: storyEntry.startWeek,
            durationWeeks: storyEntry.durationWeeks,
            feature: { userStories: [story] },
          })
          storyTimedIds.add(story.id)
        }
      }
    }
  }
  for (const epic of project.epics) {
    if (epic.isActive === false) continue
    for (const feature of epic.features) {
      if (feature.isActive === false) continue
      const featureEntry = featureEntryMap.get(feature.id)
      if (!featureEntry) continue
      const remaining = feature.userStories.filter(
        story => story.isActive !== false && !storyTimedIds.has(story.id),
      )
      if (remaining.length > 0) {
        fallbackEntries.push({
          startWeek: featureEntry.startWeek,
          durationWeeks: featureEntry.durationWeeks,
          feature: { userStories: remaining },
        })
      }
    }
  }

  // Profile-derived scheduler DTOs are authoritative (issue #418): the
  // fallback demand builder consumes the projected compatibility fields
  // (allocationMode etc.) from the resolved capacity model, never the removed
  // legacy ResourceType/NamedResource columns.
  const fallbackDemand = buildFallbackWeeklyDemand(
    fallbackEntries,
    resolvedCapacity.resourceTypes as Array<{
      name: string; id: string; hoursPerDay: number | null;
      allocationMode: string | null; count: number;
      namedResources: SchedulerNamedResource[]
    }>,
    capacityPlanByRt,
    project.hoursPerDay,
  )

  const weeklyDemandCache = project.weeklyDemandCache as Record<string, number> | null
  let weeklyDemand: WeeklyDemandLike[]

  if (weeklyDemandCache && Object.keys(weeklyDemandCache).length > 0) {
    const simulatedDemand = convertWeeklyDemandCache(
      weeklyDemandCache,
      project.resourceTypes as Array<{ id: string; name: string }>,
    )
    const merged = mergeWeeklyDemand(fallbackDemand, simulatedDemand)
    weeklyDemand = merged.map(r => ({ week: r.week, resourceTypeName: r.resourceTypeName, demandDays: r.demandDays }))
  } else {
    weeklyDemand = fallbackDemand.map(r => ({ week: r.week, resourceTypeName: r.resourceTypeName, demandDays: r.demandDays }))
  }

  weeklyDemand = weeklyDemand.filter(row => row.demandDays > 0)
  // Assignment inputs are the profile-derived scheduler DTOs (issue #418):
  // every named resource carries authoritative capacity segments and
  // profile-projected compatibility fields.
  const namedResourceAssignments = deriveNamedResourceAssignments({
    resourceTypes: resolvedCapacity.resourceTypes,
    weeklyDemand,
  })

  const categoryIndex = (category: ResourceCategory) => {
    const idx = CATEGORY_ORDER.indexOf(category)
    return idx === -1 ? CATEGORY_ORDER.length : idx
  }

  const resourceRows = Array.from(resourceAgg.values())
    .map(agg => {
      const resourceType = resourceTypeById.get(agg.resourceTypeId)!
      const epics = Array.from(agg.epics.values())
        .sort((a, b) => a.order - b.order || a.epicName.localeCompare(b.epicName))
        .map(epic => ({
          epicId: epic.epicId,
          epicName: epic.epicName,
          hours: round2(epic.hours),
          days: round2(epic.days),
          features: Array.from(epic.features.values())
            .sort((a, b) => a.order - b.order || a.featureName.localeCompare(b.featureName))
            .map(feature => ({
              featureId: feature.featureId,
              featureName: feature.featureName,
              hours: round2(feature.hours),
              days: round2(feature.days),
              stories: Array.from(feature.stories.values())
                .sort((a, b) => a.order - b.order || a.storyName.localeCompare(b.storyName))
                .map(story => ({
                  storyId: story.storyId,
                  storyName: story.storyName,
                  hours: round2(story.hours),
                  days: round2(story.days),
                })),
            })),
        }))

      const dayRate = resourceType.dayRate ?? resourceType.globalType?.defaultDayRate ?? null
      const totalDays = round2(agg.totalDays)
      const totalHours = round2(agg.totalHours)

      // Profile-first allocation shape: the ROLE profile projection is the only
      // source for mode/percent/windows (issue #418). Explicit-only roles
      // (no ROLE profile — every NR carries a NAMED_PERSON profile) present
      // as demand-following aggregates.
      const capacityProfileData = roleProfiles.get(resourceType.id) ?? undefined
      const profileProjection = capacityProfileData
        ? projectCapacityProfileToLegacyAllocation({
            planningBasis: capacityProfileData.planningBasis,
            source: capacityProfileData.source,
            defaultPercent: capacityProfileData.defaultPercent,
            startWeek: capacityProfileData.startWeek,
            endWeek: capacityProfileData.endWeek,
            segments: capacityProfileData.segments,
          })
        : null
      const mode = (profileProjection?.allocationMode as AllocationMode | undefined) ?? 'EFFORT'
      const percent = profileProjection?.allocationPercent ?? 100
      const count = resourceType.count
      const capacityPlanMaterialized = capacityPlanByRt.get(resourceType.id)

      const weeks = rtWeeks.get(resourceType.id)
      const demandDerivedStartWeek = weeks && weeks.starts.length > 0 ? Math.min(...weeks.starts) : null
      const demandDerivedEndWeek = weeks && weeks.ends.length > 0 ? Math.max(...weeks.ends) : null
      const derivedStartWeek =
        mode === 'CAPACITY_PLAN' && capacityPlanMaterialized?.startWeek != null
          ? capacityPlanMaterialized.startWeek
          : demandDerivedStartWeek
      const derivedEndWeek =
        mode === 'CAPACITY_PLAN' && capacityPlanMaterialized?.endWeek != null
          ? capacityPlanMaterialized.endWeek + 1
          : demandDerivedEndWeek

      const effectiveStartWeek = profileProjection?.allocationStartWeek ?? derivedStartWeek
      const effectiveEndWeek = profileProjection?.allocationEndWeek ?? derivedEndWeek

      // Named resources are the profile-derived scheduler DTOs: every field is
      // projected from the authoritative profile, never read from candidate columns.
      const namedResourcesSource = resolvedCapacity.resourceTypes
        .find(resolvedRT => resolvedRT.id === resourceType.id)?.namedResources ?? []
      const actualNamedResourceAssignment = namedResourceAssignments.get(resourceType.id)
      const actualNamedResourcesForType = actualNamedResourceAssignment?.namedResources ?? []
      const actualNamedResourceStartWeeks = actualNamedResourcesForType
        .map(namedResource => namedResource.actualAllocationStartWeek)
        .filter((week): week is number => week != null)
      const actualNamedResourceEndWeeks = actualNamedResourcesForType
        .map(namedResource => namedResource.actualAllocationEndWeek)
        .filter((week): week is number => week != null)
      const actualDerivedStartWeek = actualNamedResourceStartWeeks.length > 0
        ? Math.min(...actualNamedResourceStartWeeks)
        : null
      const actualDerivedEndWeek = actualNamedResourceEndWeeks.length > 0
        ? Math.max(...actualNamedResourceEndWeeks)
        : null

      // If named resources exist, compute per-NR allocatedDays
      const hasNamedResources = namedResourcesSource.length > 0

      let allocatedDays: number
      let rowDerivedStartWeek = derivedStartWeek
      let rowDerivedEndWeek = derivedEndWeek
      let namedResourcesOutput: Array<{
        id: string
        name: string
        allocationMode: string
        allocationPercent: number
        allocationPct: number
        allocationStartWeek: number | null
        allocationEndWeek: number | null
        pricingModel: 'ACTUAL_DAYS' | 'PRO_RATA'
        startWeek: number | null
        endWeek: number | null
        allocatedDays: number
        derivedStartWeek: number | null
        derivedEndWeek: number | null
        actualAllocatedDays: number
        actualAllocationStartWeek: number | null
        actualAllocationEndWeek: number | null
        actualAllocatedWeeks: Array<{ week: number; days: number; capacityDays: number }>
        actualAllocationSegments: Array<{ startWeek: number; endWeek: number; days: number }>
        synthetic: boolean
        capacityProfile?: {
          planningBasis: string
          source: string
          segments: Array<{ startWeek: number; endWeek: number; capacityPercent: number }>
        }
        resourceIdentity?: 'NAMED_PERSON' | 'PLANNED_RESOURCE'
      }>

      if (hasNamedResources) {
        // Compute per-NR allocated days. namedResourcesSource carries the
        // profile-derived scheduler DTOs, so every allocation field is already
        // projected from the authoritative profile (issue #418).
        namedResourcesOutput = namedResourcesSource.map(nr => {
          const actualNamedResource = actualNamedResourcesForType
            .find(actual => actual.id === nr.id)
          const nrMode = (nr.allocationMode as AllocationMode) ?? 'EFFORT'
          const nrPercent = nr.allocationPercent ?? 100
          let nrAllocatedDays: number
          if (nrMode === 'CAPACITY_PLAN') {
            if (actualNamedResource?.capacitySegments && actualNamedResource.capacitySegments.length > 0) {
              // Calculate from actual capacity segments. Open-ended zero
              // segments (endWeek Infinity — the transfer-to-manual zero
              // marker) must not produce Infinity × 0 = NaN days.
              nrAllocatedDays = round2(
                actualNamedResource.capacitySegments.reduce((sum, seg) => {
                  if (!Number.isFinite(seg.endWeek)) return sum
                  const weeks = Math.max(0, seg.endWeek - seg.startWeek + 1)
                  return sum + weeks * 5 * (seg.allocationPercent / 100)
                }, 0)
              )
            } else {
              const startWeek = nr.startWeek
              const endWeek = nr.endWeek
              const allocationRatio = (nrPercent ?? 100) / 100
              nrAllocatedDays = startWeek != null && endWeek != null
                ? round2(Math.max(0, endWeek - startWeek + 1) * 5 * allocationRatio)
                : 0
            }
          } else if (nrMode === 'EFFORT') {
            // Split effort equally across named resources
            nrAllocatedDays = round2(totalDays / namedResourcesSource.length)
          } else if (nrMode === 'TIMELINE') {
            const effectiveStart = nr.allocationStartWeek ?? derivedStartWeek ?? 0
            const effectiveEnd = nr.allocationEndWeek ?? derivedEndWeek ?? effectiveStart
            nrAllocatedDays = round2(Math.max(0, effectiveEnd - effectiveStart) * 5 * (nrPercent / 100))
          } else {
            // FULL_PROJECT
            nrAllocatedDays = round2(projectDurationWeeks * 5 * (nrPercent / 100))
          }
          const nrProfileData = namedResourceProfiles.get(nr.id) ?? undefined
          return {
            id: nr.id,
            name: nr.name,
            // Display fields are the profile-derived compatibility projection.
            allocationMode: nr.allocationMode,
            allocationPercent: nr.allocationPercent,
            allocationPct: nr.allocationPct,
            allocationStartWeek: nr.allocationStartWeek,
            allocationEndWeek: nr.allocationEndWeek,
            pricingModel: nr.pricingModel === 'PRO_RATA' ? 'PRO_RATA' : 'ACTUAL_DAYS',
            startWeek: nr.startWeek,
            endWeek: nr.endWeek,
            allocatedDays: nrAllocatedDays,
            derivedStartWeek,
            derivedEndWeek,
            actualAllocatedDays: actualNamedResource?.actualAllocatedDays ?? 0,
            actualAllocationStartWeek: actualNamedResource?.actualAllocationStartWeek ?? null,
            actualAllocationEndWeek: actualNamedResource?.actualAllocationEndWeek ?? null,
            actualAllocatedWeeks: actualNamedResource?.actualAllocatedWeeks ?? [],
            resourceIdentity: nrProfileData?.resourceIdentity ?? (actualNamedResource?.synthetic ? 'PLANNED_RESOURCE' : 'NAMED_PERSON'),
            actualAllocationSegments: actualNamedResource?.actualAllocationSegments ?? [],
            synthetic: actualNamedResource?.synthetic ?? !resourceType.namedResources.some(persisted => persisted.id === nr.id),
            capacityProfile: nrProfileData ? {
              planningBasis: nrProfileData.planningBasis,
              source: nrProfileData.source,
              defaultPercent: nrProfileData.defaultPercent,
              startWeek: nrProfileData.startWeek,
              endWeek: nrProfileData.endWeek,
              segments: nrProfileData.segments,
              resolutionSource: nrProfileData.resolutionSource,
            } : undefined,
          }
        })
        const existingIds = new Set(namedResourcesOutput.map(nr => nr.id))
        const syntheticAssignments = actualNamedResourcesForType
          .filter(actual => !existingIds.has(actual.id))
        namedResourcesOutput.push(...syntheticAssignments.map(actual => {
          const synthNrProfileData = namedResourceProfiles.get(actual.id) ?? undefined
          return {
            id: actual.id,
            name: actual.name,
            // Synthetic assignment rows (role aggregate, phantom slots) carry
            // profile-derived values when a profile exists; otherwise their
            // system-generated defaults are identity display only.
            allocationMode: actual.allocationMode,
            allocationPercent: actual.allocationPercent,
            allocationPct: Math.round(actual.allocationPercent ?? 0),
            allocationStartWeek: actual.allocationStartWeek,
            allocationEndWeek: actual.allocationEndWeek,
            pricingModel: actual.pricingModel,
            startWeek: actual.startWeek,
            endWeek: actual.endWeek,
            allocatedDays: actual.actualAllocatedDays,
            derivedStartWeek,
            derivedEndWeek,
            actualAllocatedDays: actual.actualAllocatedDays,
            actualAllocationStartWeek: actual.actualAllocationStartWeek,
            actualAllocationEndWeek: actual.actualAllocationEndWeek,
            actualAllocatedWeeks: actual.actualAllocatedWeeks,
            actualAllocationSegments: actual.actualAllocationSegments,
            synthetic: actual.synthetic,
            resourceIdentity: synthNrProfileData?.resourceIdentity ?? (actual.synthetic ? 'PLANNED_RESOURCE' : 'NAMED_PERSON'),
            capacityProfile: synthNrProfileData ? {
              planningBasis: synthNrProfileData.planningBasis,
              source: synthNrProfileData.source,
              defaultPercent: synthNrProfileData.defaultPercent,
              startWeek: synthNrProfileData.startWeek,
              endWeek: synthNrProfileData.endWeek,
              segments: synthNrProfileData.segments,
              resolutionSource: synthNrProfileData.resolutionSource,
            } : undefined,
          }
        }))
        const plannedAllocatedDays = round2(namedResourcesOutput.reduce((sum, nr) => sum + nr.allocatedDays, 0))
        const actualAllocatedDays = round2(actualNamedResourceAssignment?.actualAllocatedDays ?? 0)
        const shouldUseActualAssignmentWindow =
          actualDerivedStartWeek != null &&
          actualDerivedEndWeek != null &&
          (
            derivedStartWeek == null ||
            actualDerivedStartWeek < derivedStartWeek ||
            derivedEndWeek == null ||
            actualDerivedEndWeek > derivedEndWeek
          )

        allocatedDays = round2(Math.max(plannedAllocatedDays, actualAllocatedDays))
        if (shouldUseActualAssignmentWindow) {
          rowDerivedStartWeek = actualDerivedStartWeek
          rowDerivedEndWeek = actualDerivedEndWeek
        }
      } else {
        namedResourcesOutput = []
        if (mode === 'CAPACITY_PLAN') {
          allocatedDays = capacityPlanByRt.get(resourceType.id)?.totalDays ?? totalDays
        } else if (mode === 'EFFORT') {
          allocatedDays = totalDays
        } else if (mode === 'TIMELINE') {
          if (effectiveStartWeek != null && effectiveEndWeek != null) {
            // Issue #438: a null-window LEGACY ROLE profile (the deterministic
            // historical translations — Class A full capacity and the
            // never-active zero) carries an AGGREGATE percent, not a per-slot
            // percent, so count-scaling it would double-count the headcount
            // (e.g. a restored count-3 role at 300% would display 900%).
            // Per-slot TIMELINE profiles (any window or non-LEGACY source)
            // keep the existing count scaling.
            const aggregateRolePercent =
              capacityProfileData?.planningBasis === 'availabilityWindow' &&
              capacityProfileData?.source === 'legacy' &&
              capacityProfileData?.startWeek == null &&
              capacityProfileData?.endWeek == null
            allocatedDays = round2(
              (effectiveEndWeek - effectiveStartWeek) * 5 * (aggregateRolePercent ? 1 : count) * (percent / 100),
            )
          } else {
            allocatedDays = totalDays
          }
        } else {
          // FULL_PROJECT
          allocatedDays = round2(projectDurationWeeks * 5 * count * (percent / 100))
        }
      }

      const allocatedCost = dayRate != null ? round2(allocatedDays * dayRate) : null
      const estimatedCost = allocatedCost

      return {
        resourceTypeId: resourceType.id,
        name: resourceType.name,
        category: resourceType.category,
        count: resourceType.count,
        hoursPerDay: agg.hoursPerDay,
        dayRate,
        totalHours,
        effortDays: totalDays,
        totalDays: allocatedDays,   // keep totalDays = allocatedDays so existing UI subtotal works
        allocatedDays,
        // Display fields are the profile-derived compatibility projection.
        allocationMode: profileProjection?.allocationMode ?? mode,
        allocationPercent: profileProjection?.allocationPercent ?? percent,
        allocationStartWeek: profileProjection?.allocationStartWeek ?? null,
        allocationEndWeek: profileProjection?.allocationEndWeek ?? null,
        derivedStartWeek: rowDerivedStartWeek,
        derivedEndWeek: rowDerivedEndWeek,
        estimatedCost,
        epics,
        namedResources: namedResourcesOutput,
        capacityProfile: capacityProfileData ? {
          planningBasis: capacityProfileData.planningBasis,
          source: capacityProfileData.source,
          defaultPercent: capacityProfileData.defaultPercent,
          startWeek: capacityProfileData.startWeek,
          endWeek: capacityProfileData.endWeek,
          segments: capacityProfileData.segments,
          resolutionSource: capacityProfileData.resolutionSource,
        } : undefined,
      }
    })
    .sort((a, b) => {
      const catDiff = categoryIndex(a.category as ResourceCategory) - categoryIndex(b.category as ResourceCategory)
      if (catDiff !== 0) return catDiff
      return a.name.localeCompare(b.name)
    })

  const totalResourceDays = round2(resourceRows.reduce((sum, row) => sum + row.totalDays, 0))
  const totalEffortDays = round2(resourceRows.reduce((sum, row) => sum + row.effortDays, 0))
  const totalResourceHours = round2(resourceRows.reduce((sum, row) => sum + row.totalHours, 0))

  const overheadRows = project.overheads.map(overhead => {
    const dayRate = overhead.resourceType?.dayRate ?? overhead.resourceType?.globalType?.defaultDayRate ?? null
    const resourceTypeName = overhead.resourceType?.name ?? null
    const currentCount = overhead.resourceType?.count ?? null
    const computedDays =
      overhead.type === 'PERCENTAGE'
        ? round2((overhead.value / 100) * totalEffortDays)
        : overhead.type === 'DAYS_PER_WEEK'
          ? round2(overhead.value * projectDurationWeeks)
          : round2(overhead.value)
    const estimatedCost = dayRate != null ? round2(computedDays * dayRate) : null
    // Compute the effective FTE this overhead workload represents.
    // requiredFTE = computedDays / (projectDurationWeeks * 5 working days/week).
    const requiredFTE = projectDurationWeeks > 0
      ? round2(computedDays / (projectDurationWeeks * 5))
      : 0
    return {
      overheadId: overhead.id,
      name: overhead.name,
      resourceTypeId: overhead.resourceTypeId,
      resourceTypeName,
      dayRate,
      type: overhead.type,
      value: overhead.value,
      computedDays,
      estimatedCost,
      requiredFTE,
      currentCount,
    }
  })

  const totalOverheadDays = round2(overheadRows.reduce((sum, row) => sum + row.computedDays, 0))
  const hasCost =
    resourceRows.some(row => row.dayRate !== null) || overheadRows.some(row => row.dayRate !== null)
  const totalCost = hasCost
    ? round2(
        resourceRows.reduce((sum, row) => sum + (row.estimatedCost ?? 0), 0) +
          overheadRows.reduce((sum, row) => sum + (row.estimatedCost ?? 0), 0),
      )
    : null

  res.json({
    projectId,
    hoursPerDay: fallbackHoursPerDay,
    projectDurationWeeks,
    bufferWeeks: project.bufferWeeks ?? 0,
    onboardingWeeks: project.onboardingWeeks ?? 0,
    resourceRows,
    overheadRows,
    summary: {
      totalHours: totalResourceHours,
      totalDays: round2(totalResourceDays + totalOverheadDays),
      totalCost,
      hasCost,
    },
  })
}))

export default router
