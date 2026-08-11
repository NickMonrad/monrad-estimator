import { resolveSchedulerCapacity } from './schedulerCapacityResolver.js'
import {
  CapacityProfileProvenance,
  isLegacyMapperProfile,
  isOptimiserDerivedProfile as isSharedOptimiserDerivedProfile,
} from './capacityProfileProvenance.js'

/**
 * Profile-first Resource Optimiser apply orchestration.
 *
 * The optimiser owns only scalar named-person availability profiles carrying
 * the RESOURCE_OPTIMISER provenance marker. Explicit, segmented, ambiguous,
 * and Squad-Planner-managed capacity fails closed.
 */

import { Prisma, type PrismaClient } from '@prisma/client'
import { prisma } from './prisma.js'
import { buildSnapshot } from './projectSnapshotService.js'
import { pruneSnapshots } from './snapshotUtils.js'
import {
  runScheduler,
  type SchedulerInput,
  type SchedulerOutput,
  type SchedulerResourceType,
} from './scheduler.js'
import { runSAPlanner } from './sa-planner.js'

export type PrismaTransactionClient = Parameters<Parameters<PrismaClient['$transaction']>[0]>[0]
type OptimiserApplyPlanDb = Pick<PrismaClient,
  'resourceType' | 'namedResource' | 'capacityPlan' | 'capacityProfile'>

export interface ApplyCandidateResourceType {
  resourceTypeId: string
  count: number
  suggestedStartWeek: number
}

export interface PersistedOptimiserProfile {
  id: string
  ownerKind: string
  planningBasis: string
  source: string
  namedResourceId: string | null
  resourceTypeId: string | null
  defaultPercent: number | null
  startWeek: number | null
  endWeek: number | null
  provenance: string | null
  segments: Array<{ id: string }>
}

export interface OptimiserNamedResourceState {
  id: string
  name: string
  resourceTypeId: string
}

export interface OptimiserResourceTypeState {
  id: string
  name: string
  count: number
}

export type OptimiserRampUpClassification =
  | { outcome: 'MISSING_PROFILE'; profileId: null }
  | { outcome: 'LEGACY_MAPPER_SCALAR'; profileId: string }
  | { outcome: 'OPTIMISER_DERIVED_SCALAR'; profileId: string }
  | { outcome: 'EXPLICIT_SCALAR_PROTECTED' }
  | { outcome: 'SEGMENTED_PROTECTED' }
  | { outcome: 'CAPACITY_PROFILE_PROTECTED' }
  | { outcome: 'PLANNER_MANAGED_PROTECTED' }
  | { outcome: 'AMBIGUOUS_OR_DUPLICATE' }
  | { outcome: 'MALFORMED_SCALAR_STATE' }

type OptimiserWritableRampUpClassification = Extract<OptimiserRampUpClassification,
  { outcome: 'LEGACY_MAPPER_SCALAR' | 'OPTIMISER_DERIVED_SCALAR' }>

export interface RampUpProfileWrite {
  profileId: string | null
  namedResourceId: string
  resourceTypeId: string
  startWeek: number
  endWeek: number | null
  defaultPercent: number
}

export type OptimiserMutationIntent =
  | { kind: 'count'; resourceTypeId: string; count: number }
  | { kind: 'rampUp'; write: RampUpProfileWrite }

export interface ProtectedConflictInfo {
  resourceTypeId: string
  resourceTypeName: string
  namedResourceName?: string
  code: string
  message: string
}

export interface OptimiserApplyPlan {
  intents: OptimiserMutationIntent[]
}

export interface ApplyOptimiserCandidateParams {
  projectId: string
  userId: string
  candidate: readonly ApplyCandidateResourceType[]
  /** Resource-type IDs from the validated countRanges scope. */
  optimiserScopeResourceTypeIds: readonly string[]
  staggerEpics?: boolean
}

export interface ApplyOptimiserResult {
  message: string
  snapshotId: string
  levellingResult?: {
    epicStartWeeks: Record<string, number>
    totalDeliveryWeeks: number
    peakUtilisationPct: number
  }
}

export class OptimiserApplyConflictError extends Error {
  readonly code = 'OPTIMISER_APPLY_CONFLICT'

  constructor(readonly conflicts: ProtectedConflictInfo[]) {
    super(conflicts.map(conflict => conflict.message).join('; '))
    this.name = 'OptimiserApplyConflictError'
  }
}

/**
 * Recognises service conflicts across duplicate module instances in test and
 * runtime loaders. The route deliberately maps only this fixed error shape.
 */
export function isOptimiserApplyConflictError(error: unknown): error is OptimiserApplyConflictError {
  if (error instanceof OptimiserApplyConflictError) return true
  if (!(error instanceof Error) || error.name !== 'OptimiserApplyConflictError') return false
  if (!isRecord(error) || error.code !== 'OPTIMISER_APPLY_CONFLICT') return false
  return Array.isArray(error.conflicts)
}

/** Explicit provenance value written onto every optimiser-created scalar profile. */
export const RESOURCE_OPTIMISER_PROFILE_PROVENANCE = CapacityProfileProvenance.RESOURCE_OPTIMISER

/**
 * Validate the optimiser scope sent with an apply request.
 *
 * Requirements (review #360, finding 1):
 * - scope is present;
 * - contains only string resource-type IDs;
 * - contains no duplicates;
 * - every candidate entry with suggestedStartWeek > 0 belongs to scope.
 *
 * The scope MAY contain resource types whose suggestedStartWeek is zero.
 * Candidate count entries MAY include all project resource types.
 * Callers must also verify that each scoped ID references a real resource
 * type belonging to the current project.
 */
export function isValidOptimiserScopeForApply(
  candidate: readonly ApplyCandidateResourceType[],
  optimiserScopeResourceTypeIds: readonly string[],
): boolean {
  if (!Array.isArray(optimiserScopeResourceTypeIds)) return false
  if (optimiserScopeResourceTypeIds.some(id => typeof id !== 'string')) return false
  if (new Set(optimiserScopeResourceTypeIds).size !== optimiserScopeResourceTypeIds.length) return false
  if (optimiserScopeResourceTypeIds.length === 0) {
    return candidate.every(entry => entry.suggestedStartWeek <= 0)
  }

  const scopeSet = new Set(optimiserScopeResourceTypeIds)
  return candidate.every(entry => entry.suggestedStartWeek <= 0 || scopeSet.has(entry.resourceTypeId))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Proves that a scalar NAMED_PERSON profile carries the strict mapper-derived
 * provenance (issue #405): explicit LEGACY_MAPPER provenance plus the
 * authoritative mapper shape (owner kind, FKs, mapper source/basis pair,
 * valid availability window). Candidate NamedResource columns are never
 * consulted and the removed legacy payload is never read.
 */
export function isValidNamedResourceMapperProvenance(
  profile: PersistedOptimiserProfile,
): boolean {
  return isLegacyMapperProfile(profile)
}

function isOptimiserDerivedProfile(profile: PersistedOptimiserProfile): boolean {
  return isSharedOptimiserDerivedProfile(profile)
}

/**
 * Classify an owner for optimiser ramp-up.
 *
 * Missing profile state fails closed (issue #418): a named resource without a
 * persisted profile is an integrity violation — the optimiser never promotes
 * historical mapper state into a profile.
 */
export function classifyOptimiserRampUpOwner(
  profiles: readonly PersistedOptimiserProfile[],
  namedResource: OptimiserNamedResourceState,
): OptimiserRampUpClassification {
  if (profiles.length === 0) {
    return { outcome: 'MISSING_PROFILE', profileId: null }
  }
  if (profiles.length !== 1) return { outcome: 'AMBIGUOUS_OR_DUPLICATE' }

  const profile = profiles[0]
  if (profile.namedResourceId !== namedResource.id
      || profile.resourceTypeId != null
      || !['NAMED_PERSON', 'PLANNED_RESOURCE'].includes(profile.ownerKind)) {
    return { outcome: 'AMBIGUOUS_OR_DUPLICATE' }
  }
  if (profile.ownerKind === 'PLANNED_RESOURCE' || profile.source === 'SQUAD_PLANNER') {
    return { outcome: 'PLANNER_MANAGED_PROTECTED' }
  }
  if (profile.planningBasis === 'CAPACITY_PROFILE') {
    return { outcome: 'CAPACITY_PROFILE_PROTECTED' }
  }
  if (profile.segments.length > 0) return { outcome: 'SEGMENTED_PROTECTED' }
  if (isValidNamedResourceMapperProvenance(profile)) {
    return { outcome: 'LEGACY_MAPPER_SCALAR', profileId: profile.id }
  }
  if (isOptimiserDerivedProfile(profile)) {
    return { outcome: 'OPTIMISER_DERIVED_SCALAR', profileId: profile.id }
  }
  return { outcome: 'EXPLICIT_SCALAR_PROTECTED' }
}

function isOptimiserWritableRampUpClassification(
  classification: OptimiserRampUpClassification,
): classification is OptimiserWritableRampUpClassification {
  return classification.outcome === 'LEGACY_MAPPER_SCALAR'
    || classification.outcome === 'OPTIMISER_DERIVED_SCALAR'
}

function effectiveCurrentStart(
  classification: OptimiserRampUpClassification,
  profile: PersistedOptimiserProfile | undefined,
): number | null | undefined {
  if (classification.outcome === 'AMBIGUOUS_OR_DUPLICATE') return undefined
  return profile?.startWeek ?? null
}

function effectiveScalarPercent(
  profile: PersistedOptimiserProfile | undefined,
): number {
  // Issue #405: the legacy allocationMode EFFORT special case is gone — the
  // persisted defaultPercent is the single authoritative percent. Strict
  // mapper EFFORT profiles persisted defaultPercent 100 (allocationPercent
  // ?? allocationPct ?? 100), so this is equivalent for every recognised
  // LEGACY_MAPPER row.
  return profile?.defaultPercent ?? 100
}

function effectiveScalarEnd(
  profile: PersistedOptimiserProfile | undefined,
): number | null {
  return profile?.endWeek ?? null
}

export function buildOptimiserRampUpProfileWrite(
  classification: OptimiserWritableRampUpClassification,
  namedResource: OptimiserNamedResourceState,
  profile: PersistedOptimiserProfile | undefined,
  suggestedStartWeek: number,
): RampUpProfileWrite {
  const endWeek = effectiveScalarEnd(profile)
  if (endWeek != null && suggestedStartWeek > endWeek) {
    throw new OptimiserApplyConflictError([{
      resourceTypeId: namedResource.resourceTypeId,
      resourceTypeName: '',
      namedResourceName: namedResource.name,
      code: 'INVALID_SCALAR_WINDOW',
      message: `Ramp-up week ${suggestedStartWeek} is after ${namedResource.name}'s end week ${endWeek}.`,
    }])
  }

  const defaultPercent = effectiveScalarPercent(profile)

  return {
    profileId: classification.profileId,
    namedResourceId: namedResource.id,
    resourceTypeId: namedResource.resourceTypeId,
    startWeek: suggestedStartWeek,
    endWeek,
    defaultPercent,
  }
}

function conflictForClassification(
  classification: OptimiserRampUpClassification,
  resourceType: OptimiserResourceTypeState,
  namedResource: OptimiserNamedResourceState,
): ProtectedConflictInfo {
  const prefix = `${resourceType.name} / ${namedResource.name}`
  switch (classification.outcome) {
    case 'MISSING_PROFILE':
      return { resourceTypeId: resourceType.id, resourceTypeName: resourceType.name, namedResourceName: namedResource.name, code: classification.outcome, message: `${prefix} has no persisted capacity profile. Run the capacity profile backfill/repair workflow before retrying.` }
    case 'SEGMENTED_PROTECTED':
      return { resourceTypeId: resourceType.id, resourceTypeName: resourceType.name, namedResourceName: namedResource.name, code: classification.outcome, message: `${prefix} has segmented capacity and cannot be flattened by Resource Optimiser.` }
    case 'CAPACITY_PROFILE_PROTECTED':
      return { resourceTypeId: resourceType.id, resourceTypeName: resourceType.name, namedResourceName: namedResource.name, code: classification.outcome, message: `${prefix} uses a capacity profile and cannot be flattened by Resource Optimiser.` }
    case 'PLANNER_MANAGED_PROTECTED':
      return { resourceTypeId: resourceType.id, resourceTypeName: resourceType.name, namedResourceName: namedResource.name, code: classification.outcome, message: `${prefix} is managed by Squad Planner. Refine in Squad Planner instead.` }
    case 'AMBIGUOUS_OR_DUPLICATE':
      return { resourceTypeId: resourceType.id, resourceTypeName: resourceType.name, namedResourceName: namedResource.name, code: classification.outcome, message: `${prefix} has ambiguous or duplicate capacity ownership and must be repaired before apply.` }
    case 'MALFORMED_SCALAR_STATE':
      return { resourceTypeId: resourceType.id, resourceTypeName: resourceType.name, namedResourceName: namedResource.name, code: classification.outcome, message: `${prefix} has malformed or contradictory scalar state that must be corrected before apply.` }
    default:
      return { resourceTypeId: resourceType.id, resourceTypeName: resourceType.name, namedResourceName: namedResource.name, code: 'EXPLICIT_SCALAR_PROTECTED', message: `${prefix} has explicit capacity that Resource Optimiser cannot replace.` }
  }
}

/** Pure mutation-plan derivation from persisted state. */
export function buildOptimiserMutationIntent(input: {
  candidate: readonly ApplyCandidateResourceType[]
  optimiserScopeResourceTypeIds: ReadonlySet<string>
  resourceTypes: readonly OptimiserResourceTypeState[]
  namedResources: readonly OptimiserNamedResourceState[]
  profilesByNamedResourceId: ReadonlyMap<string, readonly PersistedOptimiserProfile[]>
  plannerManagedResourceTypeIds: ReadonlySet<string>
}): OptimiserApplyPlan {
  const resourceTypeById = new Map(input.resourceTypes.map(resourceType => [resourceType.id, resourceType]))
  const namedResourcesByType = new Map<string, OptimiserNamedResourceState[]>()
  for (const namedResource of input.namedResources) {
    const list = namedResourcesByType.get(namedResource.resourceTypeId) ?? []
    list.push(namedResource)
    namedResourcesByType.set(namedResource.resourceTypeId, list)
  }

  const intents: OptimiserMutationIntent[] = []
  const conflicts: ProtectedConflictInfo[] = []

  for (const candidateEntry of input.candidate) {
    const resourceType = resourceTypeById.get(candidateEntry.resourceTypeId)
    if (!resourceType) {
      conflicts.push({
        resourceTypeId: candidateEntry.resourceTypeId,
        resourceTypeName: '',
        code: 'FOREIGN_RESOURCE_TYPE',
        message: 'All candidate resource types must belong to this project.',
      })
      continue
    }

    const countChanges = candidateEntry.count !== resourceType.count
    const rampWrites: RampUpProfileWrite[] = []
    if (candidateEntry.suggestedStartWeek > 0 && input.optimiserScopeResourceTypeIds.has(resourceType.id)) {
      for (const namedResource of namedResourcesByType.get(resourceType.id) ?? []) {
        const profiles = input.profilesByNamedResourceId.get(namedResource.id) ?? []
        const profile = profiles.length === 1 ? profiles[0] : undefined
        const classification = classifyOptimiserRampUpOwner(profiles, namedResource)
        const currentStart = effectiveCurrentStart(classification, profile)

        if (currentStart === candidateEntry.suggestedStartWeek) continue
        if (!isOptimiserWritableRampUpClassification(classification)) {
          conflicts.push(conflictForClassification(classification, resourceType, namedResource))
          continue
        }

        rampWrites.push(buildOptimiserRampUpProfileWrite(
          classification,
          namedResource,
          profile,
          candidateEntry.suggestedStartWeek,
        ))
      }
    }

    if (input.plannerManagedResourceTypeIds.has(resourceType.id)
        && (countChanges || rampWrites.length > 0)) {
      conflicts.push({
        resourceTypeId: resourceType.id,
        resourceTypeName: resourceType.name,
        code: 'PLANNER_MANAGED_PROTECTED',
        message: `${resourceType.name} is managed by Squad Planner. Refine in Squad Planner instead.`,
      })
      continue
    }

    if (countChanges) intents.push({ kind: 'count', resourceTypeId: resourceType.id, count: candidateEntry.count })
    for (const write of rampWrites) intents.push({ kind: 'rampUp', write })
  }

  if (conflicts.length > 0) throw new OptimiserApplyConflictError(conflicts)
  return { intents }
}

async function loadOptimiserApplyPlan(
  db: OptimiserApplyPlanDb,
  projectId: string,
  candidate: readonly ApplyCandidateResourceType[],
  optimiserScopeResourceTypeIds: ReadonlySet<string>,
): Promise<OptimiserApplyPlan> {
  const candidateIds = candidate.map(entry => entry.resourceTypeId)
  const [resourceTypes, namedResources, activePlan, rolePlannerProfiles] = await Promise.all([
    db.resourceType.findMany({
      where: { projectId, id: { in: candidateIds } },
      select: { id: true, name: true, count: true },
    }),
    db.namedResource.findMany({
      where: { resourceType: { projectId }, resourceTypeId: { in: candidateIds } },
      select: {
        id: true,
        name: true,
        resourceTypeId: true,
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    }),
    db.capacityPlan.findFirst({
      where: { projectId, isActive: true },
      select: {
        periods: {
          select: { entries: { select: { resourceTypeId: true } } },
        },
      },
    }),
    db.capacityProfile.findMany({
      where: {
        projectId,
        resourceTypeId: { in: candidateIds },
        ownerKind: 'ROLE',
        source: 'SQUAD_PLANNER',
        planningBasis: 'CAPACITY_PROFILE',
      },
      select: { resourceTypeId: true },
    }),
  ])

  const namedResourceIds = namedResources.map(resource => resource.id)
  const profiles = await db.capacityProfile.findMany({
    where: { projectId, namedResourceId: { in: namedResourceIds } },
    select: {
      id: true,
      ownerKind: true,
      planningBasis: true,
      source: true,
      namedResourceId: true,
      resourceTypeId: true,
      defaultPercent: true,
      startWeek: true,
      endWeek: true,
      provenance: true,
      segments: { select: { id: true } },
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  })

  const profilesByNamedResourceId = new Map<string, PersistedOptimiserProfile[]>()
  for (const profile of profiles) {
    if (!profile.namedResourceId) continue
    const list = profilesByNamedResourceId.get(profile.namedResourceId) ?? []
    list.push(profile)
    profilesByNamedResourceId.set(profile.namedResourceId, list)
  }

  const plannerManagedResourceTypeIds = new Set<string>()
  for (const period of activePlan?.periods ?? []) {
    for (const entry of period.entries) plannerManagedResourceTypeIds.add(entry.resourceTypeId)
  }
  for (const profile of rolePlannerProfiles) {
    if (profile.resourceTypeId) plannerManagedResourceTypeIds.add(profile.resourceTypeId)
  }
  for (const namedResource of namedResources) {
    if ((profilesByNamedResourceId.get(namedResource.id) ?? []).some(profile =>
      profile.ownerKind === 'PLANNED_RESOURCE' || profile.source === 'SQUAD_PLANNER')) {
      plannerManagedResourceTypeIds.add(namedResource.resourceTypeId)
    }
  }

  return buildOptimiserMutationIntent({
    candidate,
    optimiserScopeResourceTypeIds,
    resourceTypes,
    namedResources,
    profilesByNamedResourceId,
    plannerManagedResourceTypeIds,
  })
}
async function loadSchedulerInput(
  db: PrismaTransactionClient,
  projectId: string,
  hoursPerDay: number,
): Promise<SchedulerInput> {
  const [allEpics, resolved, manualFeatures, manualStories, epicDeps] = await Promise.all([
    db.epic.findMany({
      where: { projectId },
      orderBy: { order: 'asc' },
      include: {
        features: {
          orderBy: { order: 'asc' },
          include: {
            userStories: {
              orderBy: { order: 'asc' },
              include: {
                tasks: { include: { resourceType: true } },
                dependencies: true,
              },
            },
            dependencies: true,
          },
        },
      },
    }),
    resolveSchedulerCapacity(db, projectId),
    db.timelineEntry.findMany({ where: { projectId, isManual: true } }),
    db.storyTimelineEntry.findMany({ where: { projectId, isManual: true } }),
    db.epicDependency.findMany({
      where: { epic: { projectId } },
      select: { epicId: true, dependsOnId: true },
    }),
  ])

  return {
    project: { hoursPerDay },
    epics: allEpics
      .filter(epic => epic.isActive !== false)
      .map(epic => ({ ...epic, features: epic.features.filter(feature => feature.isActive !== false) })),
    resourceTypes: resolved.resourceTypes as SchedulerResourceType[],
    epicDeps,
    manualFeatureEntries: manualFeatures.map(entry => ({
      featureId: entry.featureId,
      startWeek: entry.startWeek,
      durationWeeks: entry.durationWeeks,
    })),
    manualStoryEntries: manualStories.map(entry => ({ storyId: entry.storyId, startWeek: entry.startWeek })),
    resourceLevel: false,
  }
}

async function writeRampUpProfile(
  tx: PrismaTransactionClient,
  projectId: string,
  write: RampUpProfileWrite,
): Promise<void> {
  const data = {
    ownerKind: 'NAMED_PERSON' as const,
    planningBasis: 'AVAILABILITY_WINDOW' as const,
    source: 'DERIVED' as const,
    resourceTypeId: null,
    namedResourceId: write.namedResourceId,
    defaultPercent: write.defaultPercent,
    startWeek: write.startWeek,
    endWeek: write.endWeek,
    provenance: RESOURCE_OPTIMISER_PROFILE_PROVENANCE,
  }

  if (write.profileId) {
    await tx.capacityProfile.update({ where: { id: write.profileId }, data })
  } else {
    await tx.capacityProfile.create({ data: { projectId, ...data } })
  }
}

let preTransactionSeam: (() => void | Promise<void>) | null = null

export function __setOptimiserPreTransactionSeam(
  seam: (() => void | Promise<void>) | null,
): void {
  preTransactionSeam = seam
}

export type OptimiserApplyFailureStage = 'profile' | 'timeline' | 'cache'
let failureSeam: ((stage: OptimiserApplyFailureStage) => void | Promise<void>) | null = null

export function __setOptimiserApplyFailureSeam(
  seam: ((stage: OptimiserApplyFailureStage) => void | Promise<void>) | null,
): void {
  failureSeam = seam
}

async function persistSchedule(
  tx: PrismaTransactionClient,
  projectId: string,
  featureSchedule: SchedulerOutput['featureSchedule'],
  storySchedule: SchedulerOutput['storySchedule'],
): Promise<void> {
  await tx.timelineEntry.deleteMany({ where: { projectId, isManual: false } })
  const featureRows = featureSchedule.filter(entry => !entry.isManual).map(entry => ({
    projectId,
    featureId: entry.featureId,
    startWeek: entry.startWeek,
    durationWeeks: entry.durationWeeks,
    isManual: false,
  }))
  if (featureRows.length > 0) await tx.timelineEntry.createMany({ data: featureRows, skipDuplicates: true })

  await tx.storyTimelineEntry.deleteMany({ where: { projectId, isManual: false } })
  const storyRows = storySchedule.filter(entry => !entry.isManual).map(entry => ({
    projectId,
    storyId: entry.storyId,
    startWeek: entry.startWeek,
    durationWeeks: entry.durationWeeks,
    isManual: false,
  }))
  if (storyRows.length > 0) await tx.storyTimelineEntry.createMany({ data: storyRows, skipDuplicates: true })
}

export async function applyOptimiserCandidate(
  params: ApplyOptimiserCandidateParams,
): Promise<ApplyOptimiserResult> {
  const {
    projectId,
    userId,
    candidate,
    optimiserScopeResourceTypeIds,
    staggerEpics = false,
  } = params
  const optimiserScope = new Set(optimiserScopeResourceTypeIds)
  // Preflight must complete before entering the mutation transaction.
  await loadOptimiserApplyPlan(prisma, projectId, candidate, optimiserScope)
  await preTransactionSeam?.()

  const dateStr = new Date().toISOString().slice(0, 10)
  const transactionResult = await prisma.$transaction(async tx => {
    // Fresh state inside Serializable transaction closes the preflight race.
    const plan = await loadOptimiserApplyPlan(tx, projectId, candidate, optimiserScope)
    const snapshotData = await buildSnapshot(projectId, tx)
    const snapshot = await tx.backlogSnapshot.create({
      data: {
        projectId,
        label: `Auto-saved before optimiser apply — ${dateStr}`,
        trigger: 'optimiser_apply',
        snapshot: snapshotData as unknown as Prisma.InputJsonValue,
        createdById: userId,
      },
      select: { id: true },
    })

    for (const intent of plan.intents) {
      if (intent.kind === 'count') {
        await tx.resourceType.update({
          where: { id: intent.resourceTypeId },
          data: { count: intent.count },
        })
      } else {
        await writeRampUpProfile(tx, projectId, intent.write)
        await failureSeam?.('profile')
      }
    }

    const project = await tx.project.findUnique({
      where: { id: projectId },
      select: { hoursPerDay: true },
    })
    if (!project) throw new Error('Project not found during optimiser apply')

    const schedulerInput = await loadSchedulerInput(tx, projectId, project.hoursPerDay)
    let finalInput = schedulerInput
    let levellingResult: ApplyOptimiserResult['levellingResult']

    if (staggerEpics) {
      const levelled = runSAPlanner(schedulerInput, {
        targetDurationWeeks: schedulerInput.epics.length * 13,
        maxParallelismPerFeature: 2,
      })
      for (const [epicId, startWeek] of levelled.epicStartWeeks) {
        await tx.epic.update({ where: { id: epicId }, data: { timelineStartWeek: startWeek } })
      }
      finalInput = {
        ...schedulerInput,
        epics: schedulerInput.epics.map(epic => ({
          ...epic,
          timelineStartWeek: levelled.epicStartWeeks.get(epic.id) ?? epic.timelineStartWeek,
        })),
      }
      levellingResult = {
        epicStartWeeks: Object.fromEntries(levelled.epicStartWeeks),
        totalDeliveryWeeks: levelled.totalDeliveryWeeks,
        peakUtilisationPct: levelled.peakUtilisationPct,
      }
    }

    const schedule = runScheduler(finalInput)
    await failureSeam?.('timeline')
    await persistSchedule(tx, projectId, schedule.featureSchedule, schedule.storySchedule)
    await failureSeam?.('cache')
    await tx.project.update({ where: { id: projectId }, data: { weeklyDemandCache: {} } })
    await pruneSnapshots(tx, projectId)

    return { snapshotId: snapshot.id, levellingResult }
  }, {
    isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    timeout: 30_000,
    maxWait: 5_000,
  })


  return {
    message: 'Optimiser scenario applied successfully',
    snapshotId: transactionResult.snapshotId,
    ...(transactionResult.levellingResult
      ? { levellingResult: transactionResult.levellingResult }
      : {}),
  }
}
