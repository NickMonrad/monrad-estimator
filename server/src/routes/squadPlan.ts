import { resolveSchedulerCapacity } from '../lib/schedulerCapacityResolver.js'
import { CapacityIntegrityError } from '../lib/capacityIntegrityError.js'

/**
 * squadPlan.ts — Express routes for the Capacity Planner (squad sizing).
 *
 * POST /:projectId/squad-plan          Generate a capacity plan
 * POST /:projectId/squad-plan/apply    Save and activate a plan
 * GET  /:projectId/squad-plans         List plans for a project
 */

import { Router, Response } from 'express'
import { Prisma } from '@prisma/client'
import { prisma } from '../lib/prisma.js'
import { asyncHandler } from '../lib/asyncHandler.js'
import { authenticate, AuthRequest } from '../middleware/auth.js'
import { effortDays, scheduleDurationDays } from '../utils/round.js'
import { ownedProject } from '../lib/ownership.js'
import { buildSnapshot } from './snapshots.js'
import { pruneSnapshots } from '../lib/snapshotUtils.js'
import {
  getWeeklyCapacity,
  runScheduler,
  type SchedulerInput,
  type SchedulerResourceType,
} from '../lib/scheduler.js'
import { levelEpicStarts } from '../lib/leveller.js'
import { runSAPlanner, SAPlannerInfeasibleError } from '../lib/sa-planner.js'
import {
  computeJointPlan,
  type CapacityPlanConfig,
  type DraftPlanConstraints,
  type JointPlanResult,
} from '../lib/capacity-planner.js'
import {
  canonicalFingerprint,
  signSquadPlanProof,
  verifySquadPlanProof,
} from '../lib/squadPlanDraft.js'
import {
  materializeCapacityPlanResources,
  materializeResourceTrajectories,
  type CapacityPlanSlotWindow,
  type CapacityPlanPeriodInput,
} from '../lib/capacityPlanMaterialisation.js'
import {
  conflictPreflightCheck,
  findOrCreatePlannedResources,
  writePlannerProfiles,
  materializeProfilesForResourceType,
  clearOmittedPlannerCapacity,
  revalidatePlannerPlan,
  capturePlannerAuthority,
  PlannerConflictError,
  runPreValidationConflictSeam,
  runPreWriteConflictSeam,
  __applyFailureSeam,
  type PrismaTransactionClient,
  type PriorPlannerAuthority,
} from '../lib/squadPlannerProfileWriter.js'

type DraftCapacityEdit = DraftPlanConstraints['capacityEdits'][number]
type DraftFeatureEntry = DraftPlanConstraints['manualFeatureEntries'][number]
type DraftStoryEntry = DraftPlanConstraints['manualStoryEntries'][number]

type SquadPlanDraft = DraftPlanConstraints

type ApplyPeriodEntry = {
  resourceTypeId: string
  headcount: number
  demandFTE: number
  utilisationPct: number
}

type ApplyPeriod = {
  periodIndex: number
  startWeek: number
  endWeek: number
  entries: ApplyPeriodEntry[]
}

type SlotWindow = {
  startWeek: number
  endWeek: number
}

type PlannerInputLoadOptions = {
  includeCapacityPlanMaterialization?: boolean
  /**
   * Squad Planner apply precomputes the timeline BEFORE the plan's profiles
   * are written. Pre-apply state legitimately contains unprofiled owners the
   * planner is about to adopt, which the fail-closed resolver (issue #418)
   * rejects. With this flag the precompute tolerates CapacityIntegrityError
   * and falls back to legacy-shaped DTOs from the raw rows — the persisted
   * state is never read through this path afterwards. All other consumers
   * (timeline GET, resource profile, optimiser) stay fail-closed.
   */
  permissivePreApply?: boolean
}

type PlannerInputResourceType = SchedulerResourceType & {
  allocationMode?: string | null
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function validateDraftShape(
  value: unknown,
  resourceTypeIds: Set<string>,
  featureIds: Set<string>,
  storyIds: Set<string>,
): { draft?: SquadPlanDraft; error?: string } {
  if (!isPlainObject(value)) return { error: 'draft must be an object' }
  const allowedKeys = new Set(['capacityEdits', 'manualFeatureEntries', 'manualStoryEntries'])
  if (Object.keys(value).some(key => !allowedKeys.has(key))) {
    return { error: 'draft contains unsupported fields' }
  }
  const capacityEdits = value.capacityEdits
  const manualFeatureEntries = value.manualFeatureEntries
  const manualStoryEntries = value.manualStoryEntries
  if (!Array.isArray(capacityEdits) || !Array.isArray(manualFeatureEntries) || !Array.isArray(manualStoryEntries)) {
    return { error: 'draft requires capacityEdits, manualFeatureEntries, and manualStoryEntries arrays' }
  }

  const acceptedCapacityEdits: DraftCapacityEdit[] = []
  for (const [index, edit] of capacityEdits.entries()) {
    if (!isPlainObject(edit)
      || typeof edit.resourceTypeId !== 'string'
      || !resourceTypeIds.has(edit.resourceTypeId)
      || !isFiniteNumber(edit.startWeek)
      || !Number.isInteger(edit.startWeek)
      || !isFiniteNumber(edit.endWeek)
      || !Number.isInteger(edit.endWeek)
      || edit.startWeek < 0
      || edit.endWeek <= edit.startWeek
      || !isNonNegativeFiniteNumber(edit.headcount)
      || typeof edit.locked !== 'boolean') {
      return { error: `draft.capacityEdits[${index}] has an invalid resourceTypeId, range, headcount, or locked flag` }
    }
    acceptedCapacityEdits.push({
      resourceTypeId: edit.resourceTypeId,
      startWeek: edit.startWeek,
      endWeek: edit.endWeek,
      headcount: edit.headcount,
      locked: edit.locked,
    })
  }
  const byResourceType = new Map<string, DraftCapacityEdit[]>()
  for (const edit of acceptedCapacityEdits) {
    const edits = byResourceType.get(edit.resourceTypeId) ?? []
    edits.push(edit)
    byResourceType.set(edit.resourceTypeId, edits)
  }
  for (const [resourceTypeId, edits] of byResourceType) {
    edits.sort((left, right) => left.startWeek - right.startWeek || left.endWeek - right.endWeek)
    for (let index = 1; index < edits.length; index++) {
      if (edits[index].startWeek < edits[index - 1].endWeek) {
        return { error: `draft.capacityEdits overlap for resourceTypeId ${resourceTypeId}` }
      }
    }
  }

  const acceptedFeatureEntries: DraftFeatureEntry[] = []
  const featureSeen = new Set<string>()
  for (const [index, entry] of manualFeatureEntries.entries()) {
    if (!isPlainObject(entry)
      || typeof entry.featureId !== 'string'
      || !featureIds.has(entry.featureId)
      || featureSeen.has(entry.featureId)
      || !isNonNegativeFiniteNumber(entry.startWeek)
      || !isFiniteNumber(entry.durationWeeks)
      || entry.durationWeeks <= 0) {
      return { error: `draft.manualFeatureEntries[${index}] has an invalid or non-owned feature pin` }
    }
    featureSeen.add(entry.featureId)
    acceptedFeatureEntries.push({
      featureId: entry.featureId,
      startWeek: entry.startWeek,
      durationWeeks: entry.durationWeeks,
    })
  }

  const acceptedStoryEntries: DraftStoryEntry[] = []
  const storySeen = new Set<string>()
  for (const [index, entry] of manualStoryEntries.entries()) {
    if (!isPlainObject(entry)
      || typeof entry.storyId !== 'string'
      || !storyIds.has(entry.storyId)
      || storySeen.has(entry.storyId)
      || !isNonNegativeFiniteNumber(entry.startWeek)) {
      return { error: `draft.manualStoryEntries[${index}] has an invalid or non-owned story pin` }
    }
    storySeen.add(entry.storyId)
    acceptedStoryEntries.push({ storyId: entry.storyId, startWeek: entry.startWeek })
  }

  acceptedCapacityEdits.sort((left, right) =>
    left.resourceTypeId.localeCompare(right.resourceTypeId)
    || left.startWeek - right.startWeek
    || left.endWeek - right.endWeek)
  acceptedFeatureEntries.sort((left, right) => left.featureId.localeCompare(right.featureId))
  acceptedStoryEntries.sort((left, right) => left.storyId.localeCompare(right.storyId))
  return {
    draft: {
      capacityEdits: acceptedCapacityEdits,
      manualFeatureEntries: acceptedFeatureEntries,
      manualStoryEntries: acceptedStoryEntries,
    },
  }
}

function extractPlanIds(schedulerInput: SchedulerInput): {
  featureIds: Set<string>
  storyIds: Set<string>
} {
  const featureIds = new Set<string>()
  const storyIds = new Set<string>()
  for (const epic of schedulerInput.epics) {
    for (const feature of epic.features) {
      featureIds.add(feature.id)
      for (const story of feature.userStories) storyIds.add(story.id)
    }
  }
  return { featureIds, storyIds }
}

function capacityEditsFromAppliedPeriods(value: unknown): DraftCapacityEdit[] {
  if (!Array.isArray(value)) return []
  const edits: DraftCapacityEdit[] = []
  for (const period of value) {
    if (!isPlainObject(period)
      || !isFiniteNumber(period.startWeek)
      || !Number.isInteger(period.startWeek)
      || !isFiniteNumber(period.endWeek)
      || !Number.isInteger(period.endWeek)
      || period.startWeek < 0
      || period.endWeek <= period.startWeek
      || !Array.isArray(period.entries)) {
      return []
    }
    for (const entry of period.entries) {
      if (!isPlainObject(entry)
        || typeof entry.resourceTypeId !== 'string'
        || !isNonNegativeFiniteNumber(entry.headcount)) {
        return []
      }
      edits.push({
        resourceTypeId: entry.resourceTypeId,
        startWeek: period.startWeek,
        endWeek: period.endWeek,
        headcount: entry.headcount,
        // Existing applied periods are editable seeds when the planner is
        // reopened; only an explicit draft lock is a hard constraint.
        locked: false,
      })
    }
  }
  return edits
}

async function loadAppliedCapacityPlanPeriods(projectId: string): Promise<unknown[]> {
  const plan = await prisma.capacityPlan.findFirst({
    where: { projectId, isActive: true },
    select: {
      periods: {
        select: {
          startWeek: true,
          endWeek: true,
          entries: {
            select: { resourceTypeId: true, headcount: true },
          },
        },
        orderBy: { periodIndex: 'asc' },
      },
    },
  })
  return isPlainObject(plan) && Array.isArray(plan.periods) ? plan.periods : []
}


function canonicalDraftFromInput(
  schedulerInput: SchedulerInput,
  draftValue: unknown,
  resourceTypeIds: Set<string>,
  appliedPeriods: unknown[] = [],
): { draft?: SquadPlanDraft; error?: string } {
  const { featureIds, storyIds } = extractPlanIds(schedulerInput)
  const value = draftValue == null
    ? {
        capacityEdits: capacityEditsFromAppliedPeriods(appliedPeriods),
        manualFeatureEntries: schedulerInput.manualFeatureEntries,
        manualStoryEntries: schedulerInput.manualStoryEntries,
      }
    : draftValue
  return validateDraftShape(value, resourceTypeIds, featureIds, storyIds)
}

function scheduleForWire(result: JointPlanResult): JointPlanResult['schedule'] {
  return result.schedule ?? { features: [], stories: [] }
}

function proofPeriodShape(periods: Array<Record<string, unknown>>): ApplyPeriod[] {
  return periods.map(period => ({
    periodIndex: Number(period.periodIndex),
    startWeek: Number(period.startWeek),
    endWeek: Number(period.endWeek),
    entries: (Array.isArray(period.entries) ? period.entries : Array.isArray(period.resources) ? period.resources : []).map(entry => {
      const value = entry as Record<string, unknown>
      return {
        resourceTypeId: String(value.resourceTypeId),
        headcount: Number(value.headcount),
        demandFTE: Number(value.demandFTE ?? value.avgDemandFTE ?? 0),
        utilisationPct: Number(value.utilisationPct ?? 0),
      }
    }),
  }))
}

type ReviewedSchedule = {
  features: Array<{ featureId: string; name: string; startWeek: number; durationWeeks: number }>
  stories: Array<{ storyId: string; featureId: string; name: string; startWeek: number; durationWeeks: number }>
}

function normalizeReviewedSchedule(value: unknown): { schedule?: ReviewedSchedule; error?: string } {
  if (!isPlainObject(value) || !Array.isArray(value.features) || !Array.isArray(value.stories)) {
    return { error: 'schedule must contain features and stories arrays' }
  }
  const features: ReviewedSchedule['features'] = []
  for (const entry of value.features) {
    if (!isPlainObject(entry)
      || typeof entry.featureId !== 'string'
      || typeof entry.name !== 'string'
      || !isNonNegativeFiniteNumber(entry.startWeek)
      || !isFiniteNumber(entry.durationWeeks)
      || entry.durationWeeks <= 0) return { error: 'schedule contains an invalid feature entry' }
    features.push({
      featureId: entry.featureId,
      name: entry.name,
      startWeek: entry.startWeek,
      durationWeeks: entry.durationWeeks,
    })
  }
  const stories: ReviewedSchedule['stories'] = []
  for (const entry of value.stories) {
    if (!isPlainObject(entry)
      || typeof entry.storyId !== 'string'
      || typeof entry.featureId !== 'string'
      || typeof entry.name !== 'string'
      || !isNonNegativeFiniteNumber(entry.startWeek)
      || !isFiniteNumber(entry.durationWeeks)
      || entry.durationWeeks <= 0) return { error: 'schedule contains an invalid story entry' }
    stories.push({
      storyId: entry.storyId,
      featureId: entry.featureId,
      name: entry.name,
      startWeek: entry.startWeek,
      durationWeeks: entry.durationWeeks,
    })
  }
  features.sort((left, right) => left.featureId.localeCompare(right.featureId))
  stories.sort((left, right) => left.storyId.localeCompare(right.storyId))
  return { schedule: { features, stories } }
}
type ReviewedPlanConfig = {
  targetDurationWeeks: number
  periodWeeks: 4 | 13
  maxDeltaPerPeriod: number
  smoothingMode: 'smooth' | 'tight' | 'exact'
  minFloor: Record<string, number>
  maxCap: Record<string, number> | null
  maxBudget: number | null
  maxAllocationBufferPct: number | null
  maxParallelismPerFeature: number | null
  maxConcurrentEpics: number | null
}

function sortedNumberRecord(values: Map<string, number> | Record<string, number> | undefined): Record<string, number> {
  const entries = values instanceof Map ? [...values.entries()] : Object.entries(values ?? {})
  return Object.fromEntries(entries.sort(([left], [right]) => left.localeCompare(right)))
}

function reviewedPlanConfig(input: {
  targetDurationWeeks: number
  periodWeeks: 4 | 13
  maxDeltaPerPeriod: number
  smoothingMode?: 'smooth' | 'tight' | 'exact'
  minFloor?: Map<string, number> | Record<string, number>
  maxCap?: Map<string, number> | Record<string, number>
  maxBudget?: number
  maxAllocationBufferPct?: number
  maxParallelismPerFeature?: number
  maxConcurrentEpics?: number
}): ReviewedPlanConfig {
  const maxCap = sortedNumberRecord(input.maxCap)
  return {
    targetDurationWeeks: input.targetDurationWeeks,
    periodWeeks: input.periodWeeks,
    maxDeltaPerPeriod: input.maxDeltaPerPeriod,
    smoothingMode: input.smoothingMode ?? 'smooth',
    minFloor: sortedNumberRecord(input.minFloor),
    maxCap: Object.keys(maxCap).length > 0 ? maxCap : null,
    maxBudget: input.maxBudget ?? null,
    maxAllocationBufferPct: input.maxAllocationBufferPct ?? null,
    maxParallelismPerFeature: input.maxParallelismPerFeature ?? null,
    maxConcurrentEpics: input.maxConcurrentEpics ?? null,
  }
}

function withoutVolatileSnapshotFields(value: unknown): unknown {
  if (value instanceof Date) return value
  if (Array.isArray(value)) {
    return value
      .map(withoutVolatileSnapshotFields)
      .map(entry => ({ key: JSON.stringify(entry), entry }))
      .sort((left, right) => left.key.localeCompare(right.key))
      .map(({ entry }) => entry)
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => key !== 'createdAt')
        .map(([key, entry]) => [key, withoutVolatileSnapshotFields(entry)]),
    )
  }
  return value
}

async function planningStateFingerprint(
  projectId: string,
  db?: PrismaTransactionClient,
): Promise<string> {
  const snapshot = await buildSnapshot(projectId, db as never)
  return canonicalFingerprint(withoutVolatileSnapshotFields(snapshot))
}

function normalizeAppliedConfig(
  value: unknown,
  resourceTypeIds: Set<string>,
): { config?: ReviewedPlanConfig; error?: string } {
  if (!isPlainObject(value)) return { error: 'config must be an object' }
  const targetDurationWeeks = value.targetDurationWeeks
  const periodWeeks = value.periodWeeks
  const maxDeltaPerPeriod = value.maxDeltaPerPeriod
  const smoothingMode = value.smoothingMode
  if (!isFiniteNumber(targetDurationWeeks) || targetDurationWeeks <= 0
    || (periodWeeks !== 4 && periodWeeks !== 13)
    || !isFiniteNumber(maxDeltaPerPeriod)
    || !Number.isInteger(maxDeltaPerPeriod) || maxDeltaPerPeriod < 1
    || (smoothingMode !== 'smooth' && smoothingMode !== 'tight' && smoothingMode !== 'exact')) {
    return { error: 'config contains invalid target, period, delta, or smoothing settings' }
  }
  const parseRecord = (raw: unknown, field: string): { value?: Record<string, number>; error?: string } => {
    if (raw == null) return { value: {} }
    if (!isPlainObject(raw)) return { error: `${field} must be an object` }
    const result: Record<string, number> = {}
    for (const [resourceTypeId, entry] of Object.entries(raw)) {
      if (!resourceTypeIds.has(resourceTypeId) || !isNonNegativeFiniteNumber(entry)) {
        return { error: `${field} contains an invalid resource type or value` }
      }
      result[resourceTypeId] = entry
    }
    return { value: result }
  }
  const minFloor = parseRecord(value.minFloor, 'minFloor')
  if (minFloor.error) return { error: minFloor.error }
  const maxCap = parseRecord(value.maxCap, 'maxCap')
  if (maxCap.error) return { error: maxCap.error }
  for (const [resourceTypeId, cap] of Object.entries(maxCap.value ?? {})) {
    if (cap < (minFloor.value?.[resourceTypeId] ?? 0)) {
      return { error: `maxCap for ${resourceTypeId} must be >= minFloor` }
    }
  }
  const maxBudget = value.maxBudget
  const maxAllocationBufferPct = value.maxAllocationBufferPct
  if (maxBudget != null && !isNonNegativeFiniteNumber(maxBudget)) {
    return { error: 'maxBudget must be a finite number >= 0' }
  }
  if (maxAllocationBufferPct != null && !isNonNegativeFiniteNumber(maxAllocationBufferPct)) {
    return { error: 'maxAllocationBufferPct must be a finite number >= 0' }
  }
  const integerOption = (entry: unknown, field: string): number | undefined => {
    if (entry == null) return undefined
    if (!isFiniteNumber(entry) || !Number.isInteger(entry) || entry < 1) {
      throw new Error(`${field} must be an integer >= 1`)
    }
    return entry
  }
  try {
    return {
      config: reviewedPlanConfig({
        targetDurationWeeks: targetDurationWeeks as number,
        periodWeeks: periodWeeks as 4 | 13,
        maxDeltaPerPeriod: maxDeltaPerPeriod as number,
        smoothingMode: smoothingMode as 'smooth' | 'tight' | 'exact',
        minFloor: minFloor.value,
        maxCap: maxCap.value,
        maxBudget: maxBudget as number | undefined,
        maxAllocationBufferPct: maxAllocationBufferPct as number | undefined,
        maxParallelismPerFeature: integerOption(value.maxParallelismPerFeature, 'maxParallelismPerFeature'),
        maxConcurrentEpics: integerOption(value.maxConcurrentEpics, 'maxConcurrentEpics'),
      }),
    }
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'config contains invalid integer settings' }
  }
}

function scheduleMatchesDraft(
  schedule: ReviewedSchedule,
  draft: SquadPlanDraft,
): boolean {
  const featureById = new Map(schedule.features.map(entry => [entry.featureId, entry]))
  const storyById = new Map(schedule.stories.map(entry => [entry.storyId, entry]))
  return draft.manualFeatureEntries.every(entry => {
    const reviewed = featureById.get(entry.featureId)
    return reviewed?.startWeek === entry.startWeek && reviewed.durationWeeks === entry.durationWeeks
  }) && draft.manualStoryEntries.every(entry => {
    const reviewed = storyById.get(entry.storyId)
    return reviewed?.startWeek === entry.startWeek && reviewed.durationWeeks > 0
  })
}


const router = Router({ mergeParams: true })

class DraftProofConflictError extends Error {}
router.use(authenticate)

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value)

const isNonNegativeFiniteNumber = (value: unknown): value is number =>
  isFiniteNumber(value) && value >= 0
const MAX_SERIALIZATION_RETRIES = 2

function isSerializationConflict(err: unknown): boolean {
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2034') {
    return true
  }
  if (typeof err !== 'object' || err === null) return false
  const cause = (err as { cause?: unknown }).cause
  return typeof cause === 'object'
    && cause !== null
    && (cause as { originalCode?: unknown }).originalCode === '40001'
}

/**
 * Check whether a Prisma P2002 error matches one of the #361 physical-owner
 * unique constraints on CapacityProfile (namedResourceId or resourceTypeId).
 * Only these two targets are expected planner-race violations under #361.
 * Unrelated P2002 errors (primary key, other model) propagate as 500.
 *
 * With adapter-pg (Prisma 7), P2002 meta has no `target` field. Instead the
 * constraint identity is in `driverAdapterError.cause.originalMessage` which
 * contains the PostgreSQL constraint name.
 */
function isCapacityProfileOwnerUniquenessConflict(err: unknown): boolean {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError)) return false
  if (err.code !== 'P2002') return false
  const meta = err.meta as Record<string, unknown> | null | undefined
  if (!meta) return false
  if (meta.modelName !== 'CapacityProfile') return false
  // With adapter-pg the constraint name is in driverAdapterError.cause.originalMessage.
  const adapterErr = meta.driverAdapterError as Record<string, unknown> | undefined
  const cause = adapterErr?.cause as Record<string, unknown> | undefined
  if (cause && typeof cause.originalMessage === 'string') {
    if (cause.originalMessage.includes('CapacityProfile_namedResourceId_key')) return true
    if (cause.originalMessage.includes('CapacityProfile_resourceTypeId_key')) return true
  }
  return false
}
export function deriveFeatureSpanFromWeeklyAllocations(
  weeklyAllocations: Map<number, Map<string, number>> | undefined,
  fallbackStartWeek: number,
): { startWeek: number; durationWeeks: number } {
  const allocatedWeeks: number[] = []
  if (weeklyAllocations) {
    for (const [week, byRt] of weeklyAllocations.entries()) {
      let totalAllocation = 0
      for (const allocation of byRt.values()) {
        if (Number.isFinite(allocation)) totalAllocation += allocation
      }
      if (totalAllocation > 0) allocatedWeeks.push(week)
    }
  }

  if (allocatedWeeks.length === 0) {
    return { startWeek: fallbackStartWeek, durationWeeks: 1 }
  }

  const startWeek = Math.min(...allocatedWeeks)
  const endWeek = Math.max(...allocatedWeeks)
  return { startWeek, durationWeeks: Math.max(1, endWeek - startWeek + 1) }
}

// ─────────────────────────────────────────────────────────────────────────────
// Data loader — same pattern as optimiser.ts
// ─────────────────────────────────────────────────────────────────────────────

export function stripCapacityPlanMaterialization(
  resourceTypes: PlannerInputResourceType[],
): SchedulerResourceType[] {
  return resourceTypes.map(resourceType => ({
    ...resourceType,
    namedResources: (resourceType.namedResources ?? []).filter(
      namedResource => namedResource.allocationMode !== 'CAPACITY_PLAN',
    ),
  }))
}

function buildWeeklyDemandCacheFromPlannerResult(
  weeklyDemandByResourceType: Map<string, number[]>,
): Record<string, number> {
  const weeklyDemandCache: Record<string, number> = {}

  for (const [resourceTypeId, weeklyDemand] of weeklyDemandByResourceType.entries()) {
    for (let week = 0; week < weeklyDemand.length; week++) {
      const demandDays = weeklyDemand[week]
      if (!Number.isFinite(demandDays) || demandDays <= 0) continue
      weeklyDemandCache[`${resourceTypeId}|${week}`] = demandDays
    }
  }

  return weeklyDemandCache
}

/** Pre-apply fallback: legacy-shaped scheduler DTOs from raw rows. */
async function loadPermissivePreApplyCapacity(projectId: string): Promise<ReturnType<typeof resolveSchedulerCapacity>> {
  const resourceTypes = (await prisma.resourceType.findMany({
    where: { projectId },
    orderBy: { name: 'asc' },
    include: { namedResources: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] } },
  })) as Array<Record<string, any>>
  return {
    resourceTypes: resourceTypes.map(rt => ({
      id: rt.id,
      name: rt.name,
      count: rt.count,
      hoursPerDay: rt.hoursPerDay ?? null,
      allocationMode: rt.allocationMode ?? 'EFFORT',
      namedResources: (rt.namedResources ?? []).map((nr: Record<string, any>) => ({
        id: nr.id,
        name: nr.name,
        startWeek: nr.startWeek ?? null,
        endWeek: nr.endWeek ?? null,
        allocationPct: nr.allocationPct ?? 100,
        allocationMode: nr.allocationMode ?? 'EFFORT',
        allocationPercent: nr.allocationPercent ?? 100,
        allocationStartWeek: nr.allocationStartWeek ?? null,
        allocationEndWeek: nr.allocationEndWeek ?? null,
        pricingModel: nr.pricingModel ?? undefined,
      })),
    })) as SchedulerResourceType[],
    meta: {
      profileBackedCount: 0,
      legacyCount: 0,
      profileBackedNamedResourceIds: [],
      roleProfileRTIds: [],
    },
    capacityPlanByRt: new Map(),
  }
}

export function buildReplayPlannerResourceTypes(
  resourceTypes: SchedulerResourceType[],
  slotWindowsByRt: Map<string, CapacityPlanSlotWindow[]>,
  maxHeadcountByRt: Map<string, number>,
): SchedulerResourceType[] {
  return resourceTypes.map(resourceType => {
    const slotWindows = slotWindowsByRt.get(resourceType.id)
    const maxHeadcount = maxHeadcountByRt.get(resourceType.id)

    if (!slotWindows || maxHeadcount == null) return resourceType

    const existingNamedResources = resourceType.namedResources ?? []
    const hoursPerDay = resourceType.hoursPerDay ?? 8
    const namedOnlyResourceType: SchedulerResourceType = {
      ...resourceType,
      count: existingNamedResources.length,
      roleSegments: undefined,
      namedResources: existingNamedResources,
    }

    // The generated envelope is aggregate capacity. Keep protected/manual
    // named resources untouched and add only the shortfall as synthetic
    // CAPACITY_PLAN slots. This prevents replay from inventing availability
    // outside a named person's actual window.
    const requiredFteByWeek = new Map<number, number>()
    for (const window of slotWindows) {
      for (let week = window.startWeek; week <= window.endWeek; week++) {
        requiredFteByWeek.set(
          week,
          (requiredFteByWeek.get(week) ?? 0) + window.allocationPercent / 100,
        )
      }
    }

    const existingFteByWeek = new Map<number, number>()
    for (const week of requiredFteByWeek.keys()) {
      existingFteByWeek.set(
        week,
        getWeeklyCapacity(namedOnlyResourceType, week, hoursPerDay) / (hoursPerDay * 5),
      )
    }

    const syntheticWindows: CapacityPlanSlotWindow[] = []
    const openWindows: Array<CapacityPlanSlotWindow | null> = []
    const requiredWeeks = [...requiredFteByWeek.keys()].sort((a, b) => a - b)
    for (const week of requiredWeeks) {
      const required = requiredFteByWeek.get(week) ?? 0
      const existing = existingFteByWeek.get(week) ?? 0
      let remainingPercent = Math.max(0, required - existing) * 100
      const slotPercents: number[] = []
      while (remainingPercent > 0.000001) {
        const slotPercent = Math.min(100, remainingPercent)
        slotPercents.push(slotPercent)
        remainingPercent -= slotPercent
      }

      const slotCount = Math.max(openWindows.length, slotPercents.length)
      for (let slot = 0; slot < slotCount; slot++) {
        const allocationPercent = slotPercents[slot] ?? 0
        const openWindow = openWindows[slot]
        if (allocationPercent <= 0) {
          if (openWindow) syntheticWindows.push(openWindow)
          openWindows[slot] = null
          continue
        }

        if (
          openWindow &&
          openWindow.endWeek + 1 === week &&
          openWindow.allocationPercent === allocationPercent
        ) {
          openWindow.endWeek = week
          continue
        }

        if (openWindow) syntheticWindows.push(openWindow)
        openWindows[slot] = {
          startWeek: week,
          endWeek: week,
          allocationPercent,
        }
      }
    }
    for (const openWindow of openWindows) {
      if (openWindow) syntheticWindows.push(openWindow)
    }

    const syntheticNamedResources = syntheticWindows.map((window, index) => ({
      id: `capacity-plan-${resourceType.id}-${index}`,
      name: `${resourceType.name} ${existingNamedResources.length + index + 1}`,
      startWeek: window.startWeek,
      endWeek: window.endWeek,
      allocationPct: window.allocationPercent,
      allocationMode: 'CAPACITY_PLAN',
      allocationPercent: window.allocationPercent,
      allocationStartWeek: null,
      allocationEndWeek: null,
    }))

    return {
      ...resourceType,
      count: maxHeadcount,
      // An explicit empty role profile suppresses the old aggregate role or
      // phantom-slot fallback. Capacity is now exactly existing names plus
      // the synthetic shortfall windows above.
      roleSegments: [],
      namedResources: [...existingNamedResources, ...syntheticNamedResources],
    }
  })
}
async function loadSchedulerInput(
  projectId: string,
  hoursPerDay: number,
  options: PlannerInputLoadOptions = {},
): Promise<SchedulerInput> {
  const { includeCapacityPlanMaterialization = true, permissivePreApply = false } = options
  const [allEpics, resolved, manualFeatures, manualStories, epicDeps] = await Promise.all([
    prisma.epic.findMany({
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
    resolveSchedulerCapacity(prisma, projectId).catch(error => {
      // Pre-apply timeline precompute tolerance (see permissivePreApply).
      if (!permissivePreApply || !(error instanceof CapacityIntegrityError)) throw error
      return loadPermissivePreApplyCapacity(projectId)
    }),
    prisma.timelineEntry.findMany({
      where: { projectId, isManual: true },
    }),
    prisma.storyTimelineEntry.findMany({
      where: { projectId, isManual: true },
    }),
    prisma.epicDependency.findMany({
      where: { epic: { projectId } },
      select: { epicId: true, dependsOnId: true },
    }),
  ])

  const resourceTypes = resolved.resourceTypes

  const epics = allEpics
    .filter(e => e.isActive !== false)
    .map(e => ({ ...e, features: e.features.filter(f => f.isActive !== false) }))

  // When capacity plan materialization is excluded, strip plan-based allocationMode
  const plannerResourceTypes = includeCapacityPlanMaterialization
    ? resourceTypes as SchedulerResourceType[]
    : stripCapacityPlanMaterialization(resourceTypes as PlannerInputResourceType[])

  return {
    project: { hoursPerDay },
    epics,
    resourceTypes: plannerResourceTypes,
    epicDeps,
    manualFeatureEntries: manualFeatures.map(e => ({
      featureId: e.featureId,
      startWeek: e.startWeek,
      durationWeeks: e.durationWeeks,
    })),
    manualStoryEntries: manualStories.map(e => ({
      storyId: e.storyId,
      startWeek: e.startWeek,
    })),
    resourceLevel: false,
  }
}

export type SlotSegment = {
  slotIndex: number
  segmentIndex: number
  startWeek: number
  endWeek: number
}

export function deriveSlotSegments(
  periods: Array<{ periodIndex: number; startWeek: number; endWeek: number; headcount: number }>,
): SlotSegment[] {
  const sortedPeriods = [...periods].sort((a, b) => a.periodIndex - b.periodIndex)
  const maxSlots = Math.max(0, ...sortedPeriods.map(period => period.headcount))
  const segments: SlotSegment[] = []

  for (let slot = 1; slot <= maxSlots; slot++) {
    let currentWindow: SlotWindow | null = null
    let segmentIndex = 0

    for (const period of sortedPeriods) {
      const isActive = period.headcount >= slot

      if (!isActive) {
        if (currentWindow) {
          segments.push({
            slotIndex: slot,
            segmentIndex,
            startWeek: currentWindow.startWeek,
            endWeek: currentWindow.endWeek,
          })
          currentWindow = null
          segmentIndex += 1
        }
        continue
      }

      if (!currentWindow) {
        currentWindow = { startWeek: period.startWeek, endWeek: period.endWeek }
        continue
      }

      if (period.startWeek <= currentWindow.endWeek + 1) {
        currentWindow.endWeek = period.endWeek
        continue
      }

      segments.push({
        slotIndex: slot,
        segmentIndex,
        startWeek: currentWindow.startWeek,
        endWeek: currentWindow.endWeek,
      })
      segmentIndex += 1
      currentWindow = { startWeek: period.startWeek, endWeek: period.endWeek }
    }

    if (currentWindow) {
      segments.push({
        slotIndex: slot,
        segmentIndex,
        startWeek: currentWindow.startWeek,
        endWeek: currentWindow.endWeek,
      })
    }
  }

  return segments
}

/**
 * Derive slot windows per resource type using the shared fractional-aware
 * materialisation library.  Each window carries { startWeek, endWeek,
 * allocationPercent } so that 0.25 HC produces one window at 25%, 1.25 HC
 * produces a 100% window plus a 25% window, etc.
 *
 * This replaces deriveSlotSegmentsByResourceType in the apply path.
 */
export function deriveSlotWindowsByResourceType(periods: ApplyPeriod[]): Map<string, CapacityPlanSlotWindow[]> {
  // ApplyPeriod is a superset of CapacityPlanPeriodInput — extra entry fields
  // (demandFTE, utilisationPct) are simply ignored by the materialisation lib.
  const materialized = materializeCapacityPlanResources(periods as unknown as CapacityPlanPeriodInput[])
  const result = new Map<string, CapacityPlanSlotWindow[]>()
  for (const [rtId, mat] of materialized) {
    result.set(rtId, mat.slotWindows)
  }
  return result
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /:projectId/squad-plan/apply
// Register BEFORE the root POST to avoid path ambiguity.
// ─────────────────────────────────────────────────────────────────────────────

router.post('/apply', asyncHandler(async (req: AuthRequest, res: Response) => {
  const projectId = req.params.projectId as string
  const project = await ownedProject(projectId, req.userId!)
  if (!project) { res.status(404).json({ error: 'Project not found' }); return }

  const {
    name,
    targetWeeks: requestedTargetWeeks,
    periodWeeks: requestedPeriodWeeks,
    maxDelta: requestedMaxDelta,
    periods,
    totalCost,
    deliveryWeeks,
    setActive,
    levellingResult: clientLevellingResult,
    maxParallelismPerFeature: requestedMaxParallelism,
    maxConcurrentEpics: requestedMaxConcurrentEpics,
    schedule: requestedSchedule,
    draft: requestedDraft,
    draftToken,
    config: requestedConfig,
  } = req.body as {
    name: string
    targetWeeks?: number
    periodWeeks?: number
    maxDelta?: number
    periods: ApplyPeriod[]
    totalCost?: number
    deliveryWeeks?: number
    setActive?: boolean
    draft?: unknown
    draftToken?: string
    config?: unknown
    levellingResult?: {
      epicStartWeeks: Record<string, number>
      featureStartWeeks: Record<string, number>
      totalDeliveryWeeks: number
      peakUtilisationPct: number
    }
    maxParallelismPerFeature?: number
    schedule?: unknown
    maxConcurrentEpics?: number
  }

  const requestedConfigRecord = isPlainObject(requestedConfig) ? requestedConfig : undefined
  const configTargetDurationWeeks = requestedConfigRecord?.targetDurationWeeks
  const configPeriodWeeks = requestedConfigRecord?.periodWeeks
  const configMaxDelta = requestedConfigRecord?.maxDeltaPerPeriod
  const configMaxParallelism = requestedConfigRecord?.maxParallelismPerFeature
  const configMaxConcurrentEpics = requestedConfigRecord?.maxConcurrentEpics
  const targetWeeks = requestedTargetWeeks ?? (
    isFiniteNumber(configTargetDurationWeeks) ? configTargetDurationWeeks : undefined
  )
  const periodWeeks = requestedPeriodWeeks ?? (
    configPeriodWeeks === 4 || configPeriodWeeks === 13 ? configPeriodWeeks : undefined
  )
  const maxDelta = requestedMaxDelta ?? (
    isFiniteNumber(configMaxDelta) && Number.isInteger(configMaxDelta) ? configMaxDelta : undefined
  )
  const clientMaxParallelism = requestedMaxParallelism ?? (
    isFiniteNumber(configMaxParallelism) && Number.isInteger(configMaxParallelism)
      ? configMaxParallelism
      : undefined
  )
  const clientMaxConcurrentEpics = requestedMaxConcurrentEpics ?? (
    isFiniteNumber(configMaxConcurrentEpics) && Number.isInteger(configMaxConcurrentEpics)
      ? configMaxConcurrentEpics
      : undefined
  )

  // ── Validation ──────────────────────────────────────────────────────────
  if (!name || typeof name !== 'string') {
    res.status(400).json({ error: 'name is required' }); return
  }
  if (!isFiniteNumber(targetWeeks) || !Number.isInteger(targetWeeks) || targetWeeks <= 0) {
    res.status(400).json({ error: 'targetWeeks must be a positive integer' }); return
  }
  if (periodWeeks !== 4 && periodWeeks !== 13) {
    res.status(400).json({ error: 'periodWeeks must be 4 or 13' }); return
  }
  if (!isFiniteNumber(maxDelta) || !Number.isInteger(maxDelta) || maxDelta < 1) {
    res.status(400).json({ error: 'maxDelta must be an integer >= 1' }); return
  }
  if (!Array.isArray(periods) || periods.length === 0) {
    res.status(400).json({ error: 'periods array is required' }); return
  }
  if (totalCost != null && !isNonNegativeFiniteNumber(totalCost)) {
    res.status(400).json({ error: 'totalCost must be a finite number >= 0' }); return
  }
  if (deliveryWeeks != null && !isNonNegativeFiniteNumber(deliveryWeeks)) {
    res.status(400).json({ error: 'deliveryWeeks must be a finite number >= 0' }); return
  }
  if (clientMaxParallelism != null && (!Number.isInteger(clientMaxParallelism) || clientMaxParallelism < 1)) {
    res.status(400).json({ error: 'maxParallelismPerFeature must be an integer >= 1' }); return
  }
  if (clientMaxConcurrentEpics != null && (!Number.isInteger(clientMaxConcurrentEpics) || clientMaxConcurrentEpics < 1)) {
    res.status(400).json({ error: 'maxConcurrentEpics must be an integer >= 1' }); return
  }

  const projectResourceTypes = await prisma.resourceType.findMany({
    where: { projectId },
    select: { id: true, name: true },
  })
  const projectResourceTypeIds = new Set(projectResourceTypes.map(rt => rt.id))

  const normalisedPeriods = [...periods].sort((a, b) => a.periodIndex - b.periodIndex)
  let previousEndWeek = -Infinity
  for (let idx = 0; idx < normalisedPeriods.length; idx++) {
    const period = normalisedPeriods[idx]
    if (!Number.isInteger(period.periodIndex) || period.periodIndex !== idx) {
      res.status(400).json({ error: 'periods must have contiguous integer periodIndex values starting at 0' }); return
    }
    if (!Number.isInteger(period.startWeek) || !Number.isInteger(period.endWeek)) {
      res.status(400).json({ error: 'period startWeek and endWeek must be integers' }); return
    }
    if (period.startWeek < 0 || period.endWeek <= period.startWeek) {
      res.status(400).json({ error: 'period ranges must be non-negative with endWeek > startWeek' }); return
    }
    if (period.startWeek < previousEndWeek) {
      res.status(400).json({ error: 'period ranges must be ordered and non-overlapping' }); return
    }
    previousEndWeek = period.endWeek
    if (!Array.isArray(period.entries)) {
      res.status(400).json({ error: 'period entries are required' }); return
    }

    for (const entry of period.entries) {
      if (!entry?.resourceTypeId || typeof entry.resourceTypeId !== 'string') {
        res.status(400).json({ error: 'period entry resourceTypeId is required' }); return
      }
      if (!projectResourceTypeIds.has(entry.resourceTypeId)) {
        res.status(400).json({ error: `Unknown resourceTypeId in periods: ${entry.resourceTypeId}` }); return
      }
      if (!isNonNegativeFiniteNumber(entry.headcount)) {
        res.status(400).json({ error: 'period entry headcount must be a finite number >= 0' }); return
      }
      if (!isNonNegativeFiniteNumber(entry.demandFTE)) {
        res.status(400).json({ error: 'period entry demandFTE must be a finite number >= 0' }); return
      }


      if (!isNonNegativeFiniteNumber(entry.utilisationPct)) {
        res.status(400).json({ error: 'period entry utilisationPct must be a finite number >= 0' }); return
      }
    }
  }

  let acceptedApplyConfig: ReviewedPlanConfig | undefined
  if (draftToken !== undefined) {
    if (!requestedConfig) {
      res.status(409).json({ error: 'Reviewed squad-plan config is required for apply; regenerate the draft.' }); return
    }
    const parsedConfig = normalizeAppliedConfig(requestedConfig, projectResourceTypeIds)
    if (parsedConfig.error || !parsedConfig.config) {
      res.status(400).json({ error: parsedConfig.error ?? 'Invalid config' }); return
    }
    acceptedApplyConfig = parsedConfig.config
    if (
      (requestedTargetWeeks != null && requestedTargetWeeks !== parsedConfig.config.targetDurationWeeks)
      || (requestedPeriodWeeks != null && requestedPeriodWeeks !== parsedConfig.config.periodWeeks)
      || (requestedMaxDelta != null && requestedMaxDelta !== parsedConfig.config.maxDeltaPerPeriod)
      || (requestedMaxParallelism != null && requestedMaxParallelism !== parsedConfig.config.maxParallelismPerFeature)
      || (requestedMaxConcurrentEpics != null && requestedMaxConcurrentEpics !== parsedConfig.config.maxConcurrentEpics)
    ) {
      res.status(409).json({ error: 'Reviewed squad-plan config does not match legacy apply fields; regenerate the draft.' }); return
    }
  }
  // A reviewed schedule is only meaningful with the complete signed review bundle.
  // Reject unsigned or partial submissions before loading draft entities or entering
  // any snapshot/transaction write path; legacy applies omit all reviewed fields.
  if (requestedSchedule !== undefined && (
    requestedDraft === undefined
    || typeof draftToken !== 'string'
    || requestedConfig === undefined
  )) {
    res.status(409).json({ error: 'Reviewed squad-plan apply requires draft, draftToken, config, and schedule.' }); return
  }

  const applyFeatureIds = new Set<string>()
  const applyStoryIds = new Set<string>()
  const applyStoryFeatureIds = new Map<string, string>()
  let acceptedApplyDraft: SquadPlanDraft | undefined
  if (requestedDraft !== undefined || draftToken !== undefined || requestedSchedule !== undefined) {
    if (requestedDraft === undefined || typeof draftToken !== 'string') {
      if (requestedDraft !== undefined || draftToken !== undefined) {
        res.status(400).json({ error: 'draft and draftToken must be supplied together' }); return
      }
    }
    const draftEntities = await prisma.epic.findMany({
      where: { projectId },
      select: { features: { select: { id: true, userStories: { select: { id: true } } } } },
    })
    for (const epic of draftEntities) {
      for (const feature of epic.features) {
        applyFeatureIds.add(feature.id)
        for (const story of feature.userStories) {
          applyStoryIds.add(story.id)
          applyStoryFeatureIds.set(story.id, feature.id)
        }
      }
    }
    if (requestedDraft !== undefined) {
      const parsedDraft = validateDraftShape(
        requestedDraft,
        projectResourceTypeIds,
        applyFeatureIds,
        applyStoryIds,
      )
      if (parsedDraft.error || !parsedDraft.draft) {
        res.status(400).json({ error: parsedDraft.error ?? 'Invalid draft' }); return
      }
      acceptedApplyDraft = parsedDraft.draft
    }
  }
  let acceptedApplySchedule: ReviewedSchedule | undefined
  if (requestedSchedule !== undefined || draftToken !== undefined) {
    if (requestedSchedule === undefined) {
      res.status(409).json({ error: 'Reviewed squad-plan schedule is required for apply; regenerate the draft.' }); return
    }
    const parsedSchedule = normalizeReviewedSchedule(requestedSchedule)
    if (parsedSchedule.error || !parsedSchedule.schedule) {
      res.status(400).json({ error: parsedSchedule.error ?? 'Invalid schedule' }); return
    }
    acceptedApplySchedule = parsedSchedule.schedule
    const seenFeatures = new Set<string>()
    const seenStories = new Set<string>()
    for (const feature of acceptedApplySchedule.features) {
      if (!applyFeatureIds.has(feature.featureId) || seenFeatures.has(feature.featureId)) {
        res.status(400).json({ error: 'schedule contains a non-owned or duplicate feature' }); return
      }
      seenFeatures.add(feature.featureId)
    }
    for (const story of acceptedApplySchedule.stories) {
      if (!applyStoryIds.has(story.storyId)
        || seenStories.has(story.storyId)
        || applyStoryFeatureIds.get(story.storyId) !== story.featureId) {
        res.status(400).json({ error: 'schedule contains a non-owned, duplicate, or mismatched story' }); return
      }
      seenStories.add(story.storyId)
    }
  }

  const proof = draftToken === undefined ? null : verifySquadPlanProof(draftToken)
  if (acceptedApplyDraft && !proof) {
    res.status(409).json({ error: 'Draft apply requires a valid reviewed draftToken and schedule.' }); return
  }
  if (proof && (
    proof.projectId !== projectId
    || proof.userId !== req.userId
    || !acceptedApplyDraft
    || !acceptedApplySchedule
    || !acceptedApplyConfig
    || totalCost == null
    || deliveryWeeks == null
    || !clientLevellingResult
  )) {
    res.status(409).json({ error: 'Reviewed squad-plan apply is missing proof-bound config, schedule, metrics, or ownership.' }); return
  }
  if (proof && acceptedApplyDraft && acceptedApplySchedule && acceptedApplyConfig) {
    if (!scheduleMatchesDraft(acceptedApplySchedule, acceptedApplyDraft)) {
      res.status(409).json({ error: 'Reviewed schedule does not preserve the submitted draft pins; regenerate the draft.' }); return
    }
    const requestInputFingerprint = canonicalFingerprint({
      config: acceptedApplyConfig,
      draft: acceptedApplyDraft,
    })
    const requestResultFingerprint = canonicalFingerprint({
      periods: proofPeriodShape(normalisedPeriods as unknown as Array<Record<string, unknown>>),
      levellingResult: clientLevellingResult,
      totalCost,
      deliveryWeeks,
      schedule: acceptedApplySchedule,
    })
    if (proof.inputFingerprint !== requestInputFingerprint || proof.resultFingerprint !== requestResultFingerprint) {
      res.status(409).json({ error: 'Reviewed squad-plan result does not match the submitted draft, config, schedule, or periods; regenerate the draft.' }); return
    }
    const currentStateFingerprint = await planningStateFingerprint(projectId)
    if (proof.stateFingerprint !== currentStateFingerprint) {
      res.status(409).json({ error: 'Project planning state changed since this draft was reviewed; regenerate the draft.' }); return
    }
  }
  if (acceptedApplyDraft && acceptedApplySchedule) {
    const scheduleStoryIds = new Set(acceptedApplySchedule.stories.map(story => story.storyId))
    if (acceptedApplyDraft.manualStoryEntries.some(entry => !scheduleStoryIds.has(entry.storyId))) {
      res.status(409).json({ error: 'Reviewed schedule is missing a pinned story; regenerate the draft.' }); return
    }
  }


  const shouldActivate = setActive ?? true

  // ── Capture preflight planner authority before conflict check and snapshot ──
  // This immutable evidence is used by the preflight conflict check only.
  // A fresh, transaction-local authority is captured inside the transaction
  // to avoid stale evidence from concurrent plan mutations.
  const preflightAuthority: PriorPlannerAuthority | null = shouldActivate
    ? await capturePlannerAuthority(prisma as unknown as PrismaTransactionClient, projectId)
    : null

  // ── 1a. Conflict preflight (before snapshot) ─────────────────────────────
  if (shouldActivate) {
    const conflictResult = await conflictPreflightCheck(
      prisma as unknown as PrismaTransactionClient,
      projectId,
      normalisedPeriods as unknown as CapacityPlanPeriodInput[],
      preflightAuthority ?? undefined,
    )
    if (conflictResult?.hasConflict) {
      const messages: string[] = []
      if (conflictResult.duplicateOwnerProfiles.length > 0) {
        messages.push('Duplicate owner profiles exist for one or more affected resources. Repair required before applying.')
      }
      if (conflictResult.protectedNamedPersonProfiles.length > 0) {
        for (const p of conflictResult.protectedNamedPersonProfiles) {
          const label = p.namedResourceName ?? p.resourceTypeName
          messages.push(`"${label}" has an explicit named-person profile and cannot be replaced by the planner.`)
        }
      }
      res.status(409).json({ error: messages.join('; ') })
      return
    }
  }

  // ── 1. Create pre-apply snapshot for undo (track ID for on-conflict cleanup) ──
  let newSnapshotId: string | null = null
  if (shouldActivate) {
    const snapshotData = await buildSnapshot(projectId)
    const dateStr = new Date().toISOString().slice(0, 10)
    const snapshot = await prisma.backlogSnapshot.create({
      data: {
        projectId,
        label: `Auto-saved before squad plan apply — ${dateStr}`,
        trigger: 'optimiser_apply',
        snapshot: snapshotData as unknown as object,
        createdById: req.userId!,
      },
    })
    newSnapshotId = snapshot.id
    // pruneSnapshots is deferred to after a successful transaction
  }


  // ── 2. Compute planner-derived values from request data (no DB) ──────────
  let maxHeadcountByRt: Map<string, number> | undefined
  let slotWindowsByRt: Map<string, CapacityPlanSlotWindow[]> | undefined
  if (shouldActivate) {
    maxHeadcountByRt = new Map<string, number>()
    for (const p of normalisedPeriods) {
      for (const e of p.entries) {
        const current = maxHeadcountByRt.get(e.resourceTypeId) ?? 0
        maxHeadcountByRt.set(e.resourceTypeId, Math.max(current, e.headcount))
      }
    }
    slotWindowsByRt = deriveSlotWindowsByResourceType(normalisedPeriods)
  }

  // ── 2b. Precompute timeline/cache data (before transaction) ────────────────
  let timelinePrecomputed: {
    epicStartWeeks: Map<string, number>
    featureRows: Array<{ projectId: string; featureId: string; startWeek: number; durationWeeks: number; isManual: false }>
    storyRows: Array<{ projectId: string; storyId: string; startWeek: number; durationWeeks: number; isManual: false }>
    weeklyDemandCache: Record<string, number>
  } | undefined

  if (shouldActivate && maxHeadcountByRt && slotWindowsByRt) {
    let refreshedWeeklyDemandCache: Record<string, number>
    let pfFeatureRows: Array<{ projectId: string; featureId: string; startWeek: number; durationWeeks: number; isManual: false }> = []
    let pfStoryRows: Array<{ projectId: string; storyId: string; startWeek: number; durationWeeks: number; isManual: false }> = []
    let epicStartWeeks: Map<string, number>

    if (clientLevellingResult?.featureStartWeeks && Object.keys(clientLevellingResult.featureStartWeeks).length > 0) {
      // ── Direct persistence path: derive spans from planner allocations ───
      const maxParallelism = clientMaxParallelism ?? 2
      const schedulerInput = await loadSchedulerInput(projectId, project.hoursPerDay, {
        includeCapacityPlanMaterialization: false,
        permissivePreApply: true,
      })
      if (acceptedApplyDraft) {
        schedulerInput.manualFeatureEntries = acceptedApplyDraft.manualFeatureEntries
        schedulerInput.manualStoryEntries = acceptedApplyDraft.manualStoryEntries
      }
      const replayResourceTypes = buildReplayPlannerResourceTypes(
        schedulerInput.resourceTypes,
        slotWindowsByRt,
        maxHeadcountByRt,
      )
      const plannerResult = runSAPlanner({
        ...schedulerInput,
        resourceTypes: replayResourceTypes,
      }, {
        targetDurationWeeks: targetWeeks,
        maxParallelismPerFeature: maxParallelism,
        maxConcurrentEpics: clientMaxConcurrentEpics,
      })
      refreshedWeeklyDemandCache = buildWeeklyDemandCacheFromPlannerResult(
        plannerResult.weeklyDemandByResourceType,
      )

      epicStartWeeks = new Map(
        Object.entries(clientLevellingResult.epicStartWeeks).map(([k, v]) => [k, Number(v)])
      )

      const manualFeatureIds = new Set(schedulerInput.manualFeatureEntries.map(entry => entry.featureId))
      const manualStoryIds = new Set(schedulerInput.manualStoryEntries.map(entry => entry.storyId))
      if (acceptedApplySchedule) {
        pfFeatureRows = acceptedApplySchedule.features
          .filter(entry => !manualFeatureIds.has(entry.featureId))
          .map(entry => ({
            projectId,
            featureId: entry.featureId,
            startWeek: entry.startWeek,
            durationWeeks: entry.durationWeeks,
            isManual: false as const,
          }))
        pfStoryRows = acceptedApplySchedule.stories
          .filter(entry => !manualStoryIds.has(entry.storyId))
          .map(entry => ({
            projectId,
            storyId: entry.storyId,
            startWeek: entry.startWeek,
            durationWeeks: entry.durationWeeks,
            isManual: false as const,
          }))
      } else {
        // Load features with stories/tasks to compute durations for legacy applies.
        const allEpics = await prisma.epic.findMany({
          where: { projectId },
          include: {
            features: {
              include: {
                userStories: {
                  include: { tasks: { include: { resourceType: true } } },
                },
              },
            },
          },
        })

        const hpd = project.hoursPerDay
        const featureStartWeeks = clientLevellingResult.featureStartWeeks
        for (const epic of allEpics) {
          for (const feature of epic.features) {
            if (feature.isActive === false) continue
            const fallbackStartWeek = Number(
              featureStartWeeks[feature.id]
                ?? plannerResult.featureStartWeeks.get(feature.id)
                ?? 0,
            )
            const span = deriveFeatureSpanFromWeeklyAllocations(
              plannerResult.weeklyAllocationsByFeature.get(feature.id),
              fallbackStartWeek,
            )
            if (!manualFeatureIds.has(feature.id)) {
              pfFeatureRows.push({
                projectId,
                featureId: feature.id,
                startWeek: span.startWeek,
                durationWeeks: span.durationWeeks,
                isManual: false as const,
              })
            }

            const activeStories = feature.userStories.filter(
              story => story.isActive !== false && !manualStoryIds.has(story.id),
            )
            const storyScheduleDays = new Map<string, number>()
            for (const story of activeStories) {
              let days = 0
              for (const task of story.tasks) {
                if (!task.resourceTypeId) continue
                const rtHpd = task.resourceType?.hoursPerDay ?? hpd
                days += scheduleDurationDays(task.durationDays, task.hoursEffort, rtHpd)
              }
              storyScheduleDays.set(story.id, days)
            }
            const totalStoryScheduleDays = Array.from(storyScheduleDays.values()).reduce((sum, d) => sum + d, 0)
            for (const story of activeStories) {
              const storyDays = storyScheduleDays.get(story.id) ?? 0
              const proportion = totalStoryScheduleDays > 0 ? storyDays / totalStoryScheduleDays : 0
              const storyDuration = Math.max(1, Math.ceil(span.durationWeeks * proportion))
              pfStoryRows.push({
                projectId,
                storyId: story.id,
                startWeek: span.startWeek,
                durationWeeks: storyDuration,
                isManual: false as const,
              })
            }
          }
        }
      }
    } else {
      // ── Legacy fallback: re-run scheduler ──────────────────────────────
      const schedulerInput = await loadSchedulerInput(projectId, project.hoursPerDay, {
        permissivePreApply: true,
      })
      if (acceptedApplyDraft) {
        schedulerInput.manualFeatureEntries = acceptedApplyDraft.manualFeatureEntries
        schedulerInput.manualStoryEntries = acceptedApplyDraft.manualStoryEntries
      }

      if (clientLevellingResult?.epicStartWeeks) {
        epicStartWeeks = new Map(Object.entries(clientLevellingResult.epicStartWeeks).map(([k, v]) => [k, Number(v)]))
      } else {
        const levelResult = levelEpicStarts(schedulerInput)
        epicStartWeeks = levelResult.epicStartWeeks
      }

      const levelledEpics = schedulerInput.epics.map(e => ({
        ...e,
        timelineStartWeek: epicStartWeeks.get(e.id) ?? e.timelineStartWeek,
      }))

      const { featureSchedule, storySchedule, weeklyConsumptionMap } = runScheduler({
        ...schedulerInput,
        epics: levelledEpics,
      })
      refreshedWeeklyDemandCache = Object.fromEntries(weeklyConsumptionMap)

      if (acceptedApplySchedule) {
        const manualFeatureIds = new Set(schedulerInput.manualFeatureEntries.map(entry => entry.featureId))
        const manualStoryIds = new Set(schedulerInput.manualStoryEntries.map(entry => entry.storyId))
        pfFeatureRows = acceptedApplySchedule.features
          .filter(entry => !manualFeatureIds.has(entry.featureId))
          .map(entry => ({
            projectId,
            featureId: entry.featureId,
            startWeek: entry.startWeek,
            durationWeeks: entry.durationWeeks,
            isManual: false as const,
          }))
        pfStoryRows = acceptedApplySchedule.stories
          .filter(entry => !manualStoryIds.has(entry.storyId))
          .map(entry => ({
            projectId,
            storyId: entry.storyId,
            startWeek: entry.startWeek,
            durationWeeks: entry.durationWeeks,
            isManual: false as const,
          }))
      } else {
        pfFeatureRows = featureSchedule
          .filter(e => !e.isManual)
          .map(e => ({
            projectId,
            featureId: e.featureId,
            startWeek: e.startWeek,
            durationWeeks: e.durationWeeks,
            isManual: false as const,
          }))

        pfStoryRows = storySchedule
          .filter(e => !e.isManual)
          .map(e => ({
            projectId,
            storyId: e.storyId,
            startWeek: e.startWeek,
            durationWeeks: e.durationWeeks,
            isManual: false as const,
          }))
      }
    }

    timelinePrecomputed = {
      epicStartWeeks,
      featureRows: pfFeatureRows,
      storyRows: pfStoryRows,
      weeklyDemandCache: refreshedWeeklyDemandCache,
    }


}

  // ── 3. Single transaction: revalidate → deactivate → plan → profile → timeline + cache ──
  let plan: unknown
  try {
    let transactionAttempts = 0
    while (true) {
      try {
    plan = await prisma.$transaction(async (tx: PrismaTransactionClient) => {

      // A deterministic test seam can commit a concurrent profile mutation
      // before the authority snapshot and ownership validation reads.
      if (shouldActivate) {
        await runPreValidationConflictSeam()
      }
      if (proof && acceptedApplyDraft) {
        const transactionStateFingerprint = await planningStateFingerprint(projectId, tx)
        if (proof.stateFingerprint !== transactionStateFingerprint) {
          throw new DraftProofConflictError(
            'Project planning state changed while applying this reviewed draft; regenerate the draft.',
          )
        }
      }

      // ── Capture transaction-local planner authority after pre-validation seam ──
      // This fresh capture runs inside the Serializable transaction, after any
      // concurrent mutations the pre-validation seam may have introduced, so that
      // ownership evidence for revalidation, profile writes, and omitted cleanup
      // is consistent and immune to preflight-to-transaction races.
      const transactionAuthority: PriorPlannerAuthority | null = shouldActivate
        ? await capturePlannerAuthority(tx, projectId)
        : null

      if (shouldActivate) {
        await revalidatePlannerPlan(
          tx,
          projectId,
          normalisedPeriods as unknown as CapacityPlanPeriodInput[],
          transactionAuthority ?? undefined,
        )

        // ── Pre-write conflict test seam ─────────────────────────────────
        // Integration tests inject a profile mutation here to test preflight/apply race.
        runPreWriteConflictSeam()
      }

      // Deactivate existing active plans
      if (shouldActivate) {
        await tx.capacityPlan.updateMany({
          where: { projectId, isActive: true },
          data: { isActive: false },
        })
      }

      // Create the new plan with nested periods & entries
      const createdPlan = await tx.capacityPlan.create({
        data: {
          projectId,
          name,
          targetWeeks,
          periodWeeks,
          maxDelta,
          isActive: shouldActivate,
          totalCost,
          deliveryWeeks,
          periods: {
            create: normalisedPeriods.map(p => ({
              periodIndex: p.periodIndex,
              startWeek: p.startWeek,
              endWeek: p.endWeek,
              entries: {
                create: p.entries.map(e => ({
                  resourceTypeId: e.resourceTypeId,
                  headcount: e.headcount,
                  demandFTE: e.demandFTE,
                  utilisationPct: e.utilisationPct,
                })),
              },
            })),
          },
        },
        include: { periods: { include: { entries: true } } },
      })

      // ── Profile-first: write authoritative profiles directly ────────────
      if (shouldActivate && maxHeadcountByRt) {
        // Update RT counts for demand RTs
        for (const [rtId, count] of maxHeadcountByRt) {
          await tx.resourceType.update({
            where: { id: rtId },
            data: { count: Math.max(1, Math.ceil(count)) },
          })
        }

        // Reuse the validated project resource types for materialisation
        const rtNameById = new Map(projectResourceTypes.map(rt => [rt.id, rt.name]))

        // Write authoritative profiles per resource type
        for (const [rtId] of maxHeadcountByRt) {
          const rtName = rtNameById.get(rtId) ?? 'Resource'

          // Compute trajectories to know required count and provide data
          const rtPeriods = normalisedPeriods.map(p => ({
            periodIndex: p.periodIndex,
            startWeek: p.startWeek,
            endWeek: p.endWeek,
            headcount: p.entries.find(e => e.resourceTypeId === rtId)?.headcount ?? 0,
          }))
          const trajectories = materializeResourceTrajectories(rtPeriods)

          // Find/create named resources with stable ordering (createdAt, id)
          const { allNamedResources } = await findOrCreatePlannedResources(
            tx,
            rtId,
            rtName,
            trajectories.length,
            projectId,
            transactionAuthority ?? undefined,
          )
          const materialized = materializeProfilesForResourceType(
            rtId,
            rtName,
            normalisedPeriods as unknown as CapacityPlanPeriodInput[],
            allNamedResources,
          )
          // Authoritative profile + segment persistence
          await writePlannerProfiles(
            tx,
            projectId,
            [materialized.roleProfile],
            materialized.plannedProfiles,
            materialized.surplusResources,
            undefined,
            transactionAuthority ?? undefined,
          )
        }
        await clearOmittedPlannerCapacity(tx, projectId, new Set(maxHeadcountByRt.keys()), transactionAuthority!)
      }

      // ── Timeline + cache persistence using precomputed data ────────────
      if (shouldActivate && timelinePrecomputed) {
        // Persist epic start weeks
        for (const [epicId, startWeek] of timelinePrecomputed.epicStartWeeks) {
          await tx.epic.update({ where: { id: epicId }, data: { timelineStartWeek: startWeek } })
        }

        // Persist timeline entries
        await tx.timelineEntry.deleteMany({ where: { projectId, ...(acceptedApplyDraft ? {} : { isManual: false }) } })
        if (timelinePrecomputed.featureRows.length > 0) {
          await tx.timelineEntry.createMany({ data: timelinePrecomputed.featureRows, skipDuplicates: true })
        }

        // Persist story timeline entries
        await tx.storyTimelineEntry.deleteMany({ where: { projectId, ...(acceptedApplyDraft ? {} : { isManual: false }) } })
        if (timelinePrecomputed.storyRows.length > 0) {
          await tx.storyTimelineEntry.createMany({ data: timelinePrecomputed.storyRows, skipDuplicates: true })
        }
        if (acceptedApplyDraft) {
          if (acceptedApplyDraft.manualFeatureEntries.length > 0) {
            await tx.timelineEntry.createMany({
              data: acceptedApplyDraft.manualFeatureEntries.map(entry => {
                const reviewed = acceptedApplySchedule?.features.find(feature => feature.featureId === entry.featureId)
                if (!reviewed) {
                  throw new DraftProofConflictError('Reviewed schedule is missing a pinned feature; regenerate the draft.')
                }
                return {
                  projectId,
                  featureId: entry.featureId,
                  startWeek: reviewed.startWeek,
                  durationWeeks: reviewed.durationWeeks,
                  isManual: true as const,
                }
              }),
              skipDuplicates: true,
            })
          }
          if (acceptedApplyDraft.manualStoryEntries.length > 0) {
            await tx.storyTimelineEntry.createMany({
              data: acceptedApplyDraft.manualStoryEntries.map(entry => {
                const reviewed = acceptedApplySchedule?.stories.find(story => story.storyId === entry.storyId)
                if (!reviewed) {
                  throw new DraftProofConflictError('Reviewed schedule is missing a pinned story; regenerate the draft.')
                }
                return {
                  projectId,
                  storyId: entry.storyId,
                  startWeek: reviewed.startWeek,
                  durationWeeks: reviewed.durationWeeks,
                  isManual: true as const,
                }
              }),
              skipDuplicates: true,
            })
          }
        }

        // Update weekly demand cache
        await tx.project.update({
          where: { id: projectId },
          data: { weeklyDemandCache: timelinePrecomputed.weeklyDemandCache },
        })

        // ── Test failure seam (after timeline/cache) ─────────────────────────
        // Production: no-op. Integration tests inject a throwing function to
        // verify the transaction rolls back timeline and cache mutations too.
        if (__applyFailureSeam) {
          __applyFailureSeam()
        }
      }

      return createdPlan
    }, { isolationLevel: 'Serializable' })
        break
      } catch (err) {
        if (!isSerializationConflict(err) || transactionAttempts >= MAX_SERIALIZATION_RETRIES) {
          throw err
        }
        transactionAttempts += 1
      }
    }
  } catch (err: unknown) {
    if (err instanceof DraftProofConflictError) {
      if (newSnapshotId) {
        await prisma.backlogSnapshot.delete({ where: { id: newSnapshotId } }).catch(() => {})
      }
      res.status(409).json({ error: err.message })
      return
    }

    if (err instanceof PlannerConflictError) {
      // Transaction-time conflict: abort before active-plan deactivation.
      // Delete only the new snapshot (created before the transaction) and return 409.
      if (newSnapshotId) {
        await prisma.backlogSnapshot.delete({ where: { id: newSnapshotId } }).catch(() => {
          // Snapshot may already be deleted by another path; ignore deletion failure
        })
      }
      res.status(409).json({ error: err.message })
      return
    }
    if (isSerializationConflict(err)) {
      if (newSnapshotId) {
        await prisma.backlogSnapshot.delete({ where: { id: newSnapshotId } }).catch(() => {
          // Snapshot may already be deleted by another path; ignore deletion failure
        })
      }
      res.status(409).json({ error: 'Concurrent planner apply detected; retry the operation.' })
      return
    }
    // Under #361 constraints, a concurrent insert for the same physical owner
    // (resourceTypeId or namedResourceId) raises a unique-constraint violation.
    // Treat ONLY the two #361 owner-uniqueness targets as planner conflicts.
    // Unrelated P2002 errors (primary key, other model) must propagate as 500.
    if (isCapacityProfileOwnerUniquenessConflict(err)) {
      if (newSnapshotId) {
        await prisma.backlogSnapshot.delete({ where: { id: newSnapshotId } }).catch(() => {})
      }
      res.status(409).json({ error: 'Concurrent planner apply detected; retry the operation.' })
      return
    }
    throw err // Unexpected errors propagate as 500
  }

  // Prune snapshots only after a successful transaction
  if (newSnapshotId) {
    await pruneSnapshots(prisma, projectId)
  }

  res.status(201).json(plan)

}))

// ─────────────────────────────────────────────────────────────────────────────
// POST /:projectId/squad-plan — Generate a capacity plan
// ─────────────────────────────────────────────────────────────────────────────

router.post('/', asyncHandler(async (req: AuthRequest, res: Response) => {
  const projectId = req.params.projectId as string
  const project = await ownedProject(projectId, req.userId!)
  if (!project) { res.status(404).json({ error: 'Project not found' }); return }

  const body = req.body as {
    targetDurationWeeks?: number
    periodWeeks?: number
    maxDeltaPerPeriod?: number
    smoothingMode?: 'smooth' | 'tight' | 'exact'
    minFloor?: Record<string, number>
    maxCap?: Record<string, number>
    maxBudget?: number
    maxAllocationBufferPct?: number
    maxParallelismPerFeature?: number
    maxConcurrentEpics?: number
    draft?: unknown
  }

  // ── Validation ──────────────────────────────────────────────────────────
  const targetDurationWeeks = body.targetDurationWeeks
  if (!isFiniteNumber(targetDurationWeeks) || targetDurationWeeks <= 0) {
    res.status(400).json({ error: 'targetDurationWeeks is required and must be > 0' }); return
  }

  const periodWeeks = body.periodWeeks
  if (periodWeeks !== 4 && periodWeeks !== 13) {
    res.status(400).json({ error: 'periodWeeks is required and must be 4 or 13' }); return
  }

  const maxDeltaPerPeriod = body.maxDeltaPerPeriod ?? 1
  if (!Number.isInteger(maxDeltaPerPeriod) || maxDeltaPerPeriod < 1) {
    res.status(400).json({ error: 'maxDeltaPerPeriod must be an integer >= 1' }); return
  }

  const smoothingMode = body.smoothingMode ?? 'smooth'
  if (smoothingMode !== 'smooth' && smoothingMode !== 'tight' && smoothingMode !== 'exact') {
    res.status(400).json({ error: 'smoothingMode must be smooth, tight, or exact' }); return
  }
  if (body.maxBudget != null && !isNonNegativeFiniteNumber(body.maxBudget)) {
    res.status(400).json({ error: 'maxBudget must be a finite number >= 0' }); return
  }
  if (body.maxAllocationBufferPct != null && (!isFiniteNumber(body.maxAllocationBufferPct) || body.maxAllocationBufferPct < 0)) {
    res.status(400).json({ error: 'maxAllocationBufferPct must be a finite number >= 0' }); return
  }
  if (body.maxParallelismPerFeature != null && (!Number.isInteger(body.maxParallelismPerFeature) || body.maxParallelismPerFeature < 1)) {
    res.status(400).json({ error: 'maxParallelismPerFeature must be an integer >= 1' }); return
  }
  if (body.maxConcurrentEpics != null && (!Number.isInteger(body.maxConcurrentEpics) || body.maxConcurrentEpics < 1)) {
    res.status(400).json({ error: 'maxConcurrentEpics must be an integer >= 1' }); return
  }

  const generationStateFingerprint = await planningStateFingerprint(projectId)


  // ── Load scheduler input ────────────────────────────────────────────────
  const schedulerInput = await loadSchedulerInput(projectId, project.hoursPerDay, {
    includeCapacityPlanMaterialization: false,
  })
  const projectRtIds = new Set(schedulerInput.resourceTypes.map(rt => rt.id))
  // Convert only the explicit empty overlap marker (roleSegments: []) back to
  // undefined so the SA planner uses count-based phantom-slot capacity.
  // A Squad Planner apply sets roleSegments=[] to suppress aggregate ROLE
  // capacity when PLANNED_RESOURCE profiles already represent the trajectories.
  // Non-empty ROLE profiles are preserved unchanged — they must continue to
  // constrain planner capacity under profile-first authority.
  for (const rt of schedulerInput.resourceTypes) {
    if (Array.isArray(rt.roleSegments) && rt.roleSegments.length === 0) {
      rt.roleSegments = undefined
    }
  }

  const appliedPeriods = body.draft == null
    ? await loadAppliedCapacityPlanPeriods(projectId)
    : []
  const draftResult = canonicalDraftFromInput(
    schedulerInput,
    body.draft,
    projectRtIds,
    appliedPeriods,
  )
  if (draftResult.error || !draftResult.draft) {
    res.status(400).json({ error: draftResult.error ?? 'Invalid draft' }); return
  }
  const acceptedDraft = draftResult.draft
  schedulerInput.manualFeatureEntries = acceptedDraft.manualFeatureEntries
  schedulerInput.manualStoryEntries = acceptedDraft.manualStoryEntries
  // - When maxCap is explicit, it IS the hard cap for this planning run.
  // - When maxCap is absent (unrestricted), derive a finite planning-bound from
  //   the actual problem so the planner can evaluate capacity above the current
  //   count without using an arbitrary fixed ceiling.
  // - Non-empty roleSegments remain hard constraints (profile windows).
  const targetWeeks = body.targetDurationWeeks ?? 78
  const hoursPerDay = schedulerInput.project.hoursPerDay || 8
  const daysPerWeek = hoursPerDay > 0 ? Math.min(7, 40 / hoursPerDay) : 5
  for (const rt of schedulerInput.resourceTypes) {
    const originalCount = rt.count
    const explicitCap = body.maxCap?.[rt.id]
    if (isNonNegativeFiniteNumber(explicitCap) && explicitCap > rt.count) {
      // Explicit cap from Starting Team Finder or user — use it
      rt.count = explicitCap
    } else if (explicitCap == null) {
      // No explicit cap — derive planning bound from total demand for this RT.
      // Sum days demanded across all features for this RT.
      let totalDemandDays = 0
      for (const epic of schedulerInput.epics) {
        for (const feature of epic.features) {
          for (const story of feature.userStories) {
            for (const task of story.tasks) {
              if (task.resourceTypeId === rt.id) {
                totalDemandDays += effortDays(task.hoursEffort, hoursPerDay)
              }
            }
          }
        }
      }
      // Minimum FTEs needed to complete all demand within target duration
      const minFtesForTarget = daysPerWeek > 0
        ? Math.ceil(totalDemandDays / (targetWeeks * daysPerWeek))
        : 1
      // Bound is the minimum FTEs needed, with a 2× safety margin so the
      // planner can evaluate whether the target is achievable. Never below
      // the current count — phantom slots must at least cover current state.
      const planningBound = Math.max(rt.count, Math.ceil(minFtesForTarget * 2))
      rt.count = planningBound
    }
    // else: explicit cap <= count — keep current count (cap is below, no boost needed)

    // When the planning run boosted count above canonical state, the effective
    // planning capacity inside profile windows must scale to the boosted count.
    // Non-empty finite windows remain authoritative — capacity stays zero outside
    // them. Empty [] stays undefined (phantom-slot path). Undefined stays undefined.
    if (rt.count > originalCount && Array.isArray(rt.roleSegments) && rt.roleSegments.length > 0) {
      // allocationPercent is aggregate role capacity (100% = 1 FTE), NOT relative
      // to ResourceType.count. Set it directly to the candidate count so the
      // planner sees the intended FTE capacity. This also avoids division by zero
      // when canonical count is 0. Profile window boundaries are preserved.
      rt.roleSegments = rt.roleSegments.map(seg => ({
        ...seg,
        allocationPercent: rt.count * 100,
      }))
    } else if (rt.count > originalCount && Array.isArray(rt.roleSegments) && rt.roleSegments.length === 0) {
      // Empty overlap marker -> allow phantom slots for boosted count
      rt.roleSegments = undefined
    }
  }

  // ── Build minFloor map ──────────────────────────────────────────────────
  const minFloor = new Map<string, number>()
  if (body.minFloor) {
    for (const [rtId, floor] of Object.entries(body.minFloor)) {
      if (!projectRtIds.has(rtId)) {
        res.status(400).json({ error: `Unknown resourceTypeId in minFloor: ${rtId}` }); return
      }
      if (!isNonNegativeFiniteNumber(floor)) {
        res.status(400).json({ error: `minFloor for ${rtId} must be a finite number >= 0` }); return
      }
      minFloor.set(rtId, floor)
    }
  }
  // Default floor of 0 for all resource types not explicitly set
  // (users set explicit floors via the UI if they want minimum presence)
  for (const rt of schedulerInput.resourceTypes) {
    if (!minFloor.has(rt.id)) {
      minFloor.set(rt.id, 0)
    }
  }

  const maxCap = new Map<string, number>()
  if (body.maxCap) {
    for (const [rtId, cap] of Object.entries(body.maxCap)) {
      if (!projectRtIds.has(rtId)) {
        res.status(400).json({ error: `Unknown resourceTypeId in maxCap: ${rtId}` }); return
      }
      if (!isNonNegativeFiniteNumber(cap)) {
        res.status(400).json({ error: `maxCap for ${rtId} must be a finite number >= 0` }); return
      }
      const floor = minFloor.get(rtId) ?? 0
      if (cap < floor) {
        res.status(400).json({ error: `maxCap for ${rtId} must be >= minFloor` }); return
      }
      maxCap.set(rtId, cap)
    }
  }

  const configForProof = reviewedPlanConfig({
    targetDurationWeeks,
    periodWeeks,
    maxDeltaPerPeriod,
    smoothingMode,
    minFloor,
    maxCap,
    maxBudget: body.maxBudget,
    maxAllocationBufferPct: body.maxAllocationBufferPct,
    maxParallelismPerFeature: body.maxParallelismPerFeature,
    maxConcurrentEpics: body.maxConcurrentEpics,
  })

  // ── Build day rates from resource types ─────────────────────────────────
  const dayRates = new Map<string, number>()
  const rtsWithRates = await prisma.resourceType.findMany({
    where: { projectId, dayRate: { not: null } },
    select: { id: true, dayRate: true },
  })
  for (const rt of rtsWithRates) {
    if (rt.dayRate != null && rt.dayRate > 0) {
      dayRates.set(rt.id, rt.dayRate)
    }
  }

  // ── Build config & run planner ──────────────────────────────────────────
  const config: CapacityPlanConfig = {
    targetDurationWeeks,
    periodWeeks,
    maxDeltaPerPeriod,
    smoothingMode,
    minFloor,
    maxCap: maxCap.size > 0 ? maxCap : undefined,
    dayRates,
    maxBudget: body.maxBudget,
    maxAllocationBufferPct: body.maxAllocationBufferPct,
    maxParallelismPerFeature: body.maxParallelismPerFeature,
    draft: acceptedDraft,
    maxConcurrentEpics: body.maxConcurrentEpics,
  }

  let result: JointPlanResult
  try {
    result = computeJointPlan(schedulerInput, config)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    const isGenerationFailure =
      error instanceof SAPlannerInfeasibleError
      || (error instanceof Error && detail.includes('Fractional planner could not finish feature'))

    if (isGenerationFailure) {
      const diagnostics = error instanceof SAPlannerInfeasibleError
        ? error.diagnostics
        : undefined

      res.status(400).json({
        error:
          'No feasible squad plan found under the current constraints. ' +
          (diagnostics && diagnostics.length > 0
            ? ''
            : 'Try resetting RT max caps, increasing max parallelism, or clearing saved planner settings. ') +
          `Details: ${detail}`,
        diagnostics,
        config: configForProof,
        draft: acceptedDraft,
        schedule: { features: [], stories: [] },
        deliveryWeeks: null,
        targetAchieved: false,
      })
      return
    }

    throw error
  }

  const wireLevellingResult = {
    ...result.levellingResult,
    epicStartWeeks: Object.fromEntries(result.levellingResult.epicStartWeeks),
    featureStartWeeks: Object.fromEntries(result.levellingResult.featureStartWeeks),
  }
  const responseSchedule = scheduleForWire(result)
  const parsedResponseSchedule = normalizeReviewedSchedule(responseSchedule)
  if (!parsedResponseSchedule.schedule) {
    res.status(500).json({ error: 'Planner returned an invalid reviewed schedule.' }); return
  }
  const currentGenerationStateFingerprint = await planningStateFingerprint(projectId)
  if (currentGenerationStateFingerprint !== generationStateFingerprint) {
    res.status(409).json({ error: 'Project planning state changed during generation; regenerate the draft.' }); return
  }
  const responseDraft = result.draft ?? acceptedDraft
  if (Number.isFinite(result.deliveryWeeks) && !scheduleMatchesDraft(parsedResponseSchedule.schedule, responseDraft)) {
    res.status(500).json({ error: 'Planner returned a schedule that does not preserve the validated draft pins.' }); return
  }
  const staffedFteWeeks = result.periods.reduce(
    (total, period) => total + period.resources.reduce(
      (periodTotal, resource) => periodTotal + resource.headcount * (period.endWeek - period.startWeek),
      0,
    ),
    0,
  )
  const draftToken = Number.isFinite(result.deliveryWeeks)
    ? signSquadPlanProof({
        version: 1,
        purpose: 'squad-plan-reviewed-result',
        projectId,
        userId: req.userId!,
        stateFingerprint: generationStateFingerprint,
        inputFingerprint: canonicalFingerprint({
          config: configForProof,
          draft: responseDraft,
        }),
        resultFingerprint: canonicalFingerprint({
          periods: proofPeriodShape(result.periods as unknown as Array<Record<string, unknown>>),
          levellingResult: wireLevellingResult,
          totalCost: result.totalCost ?? null,
          deliveryWeeks: result.deliveryWeeks ?? null,
          schedule: parsedResponseSchedule.schedule,
        }),
      })
    : undefined
  res.json({
    ...result,
    config: configForProof,
    draft: responseDraft,
    schedule: parsedResponseSchedule.schedule,
    ...(draftToken ? { draftToken } : {}),
    staffedFteWeeks,
    levellingResult: wireLevellingResult,
    diagnostics: result.diagnostics,
  })
}))

// ─────────────────────────────────────────────────────────────────────────────
// GET /:projectId/squad-plans — List plans
// ─────────────────────────────────────────────────────────────────────────────

router.get('/', asyncHandler(async (req: AuthRequest, res: Response) => {
  const projectId = req.params.projectId as string
  const project = await ownedProject(projectId, req.userId!)
  if (!project) { res.status(404).json({ error: 'Project not found' }); return }

  const plans = await prisma.capacityPlan.findMany({
    where: { projectId },
    include: {
      periods: {
        include: { entries: true },
        orderBy: { periodIndex: 'asc' },
      },
    },
    orderBy: { createdAt: 'desc' },
  })

  res.json({ plans })
}))

export default router
