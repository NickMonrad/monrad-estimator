/**
 * projectSnapshotTypes.ts — Pure snapshot version types and type guards.
 *
 * Schema version history:
 *   v1 — Epic-tree array (legacy; no schemaVersion wrapper)
 *   v2 — Full project state with schemaVersion: 2
 *   v3 — V2 + capacityProfiles + optional exact capacityPlans/weeklyDemandCache
 *   v4 — V3 without the candidate ResourceType/NamedResource legacy capacity
 *        fields (issue #418). New snapshots are v4; v1/v2/v3 remain readable
 *        historical input. Capacity state lives exclusively in
 *        capacityProfiles/capacitySegments.
 *
 * All types mirror the shapes produced by buildSnapshot() selects and consumed
 * by the rollback restore code.
 *
 * @module projectSnapshotTypes
 */

import { Prisma } from '@prisma/client'
import type { $Enums } from '@prisma/client'

// ─── JSON value discriminator for nullable Prisma JSON fields ────────────────
// Prisma reads both database NULL (Prisma.DbNull) and JSON null (Prisma.JsonNull)
// as JavaScript `null`. This discriminator preserves the distinction across
// snapshot serialisation/deserialisation.

export type SnapshotJsonValue =
  | { kind: 'DB_NULL' }
  | { kind: 'JSON_NULL' }
  | { kind: 'VALUE'; value: Record<string, unknown> | unknown[] | string | number | boolean }

/**
 * Convert a SnapshotJsonValue to the Prisma sentinel or value used for writes.
 * DB_NULL → Prisma.DbNull
 * JSON_NULL → Prisma.JsonNull
 * VALUE → the contained value
 */
export function snapshotJsonValueToPrisma(sjv: SnapshotJsonValue): Prisma.NullableJsonNullValueInput | Prisma.InputJsonValue {
  switch (sjv.kind) {
    case 'DB_NULL': return Prisma.DbNull
    case 'JSON_NULL': return Prisma.JsonNull
    case 'VALUE': return sjv.value as Prisma.InputJsonValue
  }
}

/**
 * Serialise a SnapshotJsonValue to a JSON-safe plain object for storage in
 * the snapshot JSON column. The `kind` discriminator survives JSON.parse.
 */
export function snapshotJsonValueToPlain(sjv: SnapshotJsonValue): Record<string, unknown> {
  if (sjv.kind === 'VALUE') {
    return { kind: 'VALUE', value: sjv.value as unknown }
  }
  return { kind: sjv.kind }
}

// ─── Capacity-profile enum string literal unions ─────────────────────────────
// These mirror the Prisma-generated $Enums.* types exactly.
// When the Prisma client is regenerated, update these to match.

export type CapacityProfileOwnerKindEnum =
  | 'ROLE'
  | 'NAMED_PERSON'
  | 'PLANNED_RESOURCE'

export type CapacityProfilePlanningBasisEnum =
  | 'DEMAND_FOLLOWING'
  | 'AVAILABILITY_WINDOW'
  | 'WHOLE_PROJECT_ALLOCATION'
  | 'CAPACITY_PROFILE'

export type CapacityProfileSourceEnum =
  | 'FIXED'
  | 'MANUAL'
  | 'AVAILABILITY_WINDOW'
  | 'SQUAD_PLANNER'
  | 'IMPORTED'
  | 'DERIVED'
  | 'LEGACY'

// ─── Epic tree types (v1/v2/v3) ──────────────────────────────────────────────

export type SnapshotTaskResourceType = {
  id: string
  name: string
  hoursPerDay: number | null
} | null

export type SnapshotTask = {
  id: string
  name: string
  description: string | null
  assumptions: string | null
  hoursEffort: number
  durationDays: number | null
  order: number
  resourceTypeId: string | null
  resourceType: SnapshotTaskResourceType
}

export type SnapshotUserStory = {
  id: string
  name: string
  description: string | null
  assumptions: string | null
  order: number
  isActive: boolean | null
  appliedTemplateId: string | null
  featureId: string
  tasks: SnapshotTask[]
}

export type SnapshotFeature = {
  id: string
  name: string
  description: string | null
  assumptions: string | null
  order: number
  featureMode: string
  isActive: boolean
  timelineColour: string | null
  timelineStartWeek: number | null
  epicId: string
  userStories: SnapshotUserStory[]
}

export type SnapshotEpic = {
  id: string
  name: string
  description: string | null
  assumptions: string | null
  order: number
  featureMode: string
  scheduleMode: string
  timelineStartWeek: number | null
  isActive: boolean
  projectId: string
  features: SnapshotFeature[]
}

// ─── V2 common field types ───────────────────────────────────────────────────

export type SnapshotProjectFields = {
  startDate: string | null
  onboardingWeeks: number | null
  bufferWeeks: number | null
  hoursPerDay: number | null
  /** Optional cache field added after v3 snapshots were introduced. */
  weeklyDemandCache?: Record<string, number> | null
  /**
   * Optional project planning state (issue #449). Absent on snapshots
   * created before the field existed; those restores leave the project's
   * planning state untouched so a pre-feature snapshot can never flip a
   * quarantined project to CURRENT (or vice versa) implicitly.
   */
  planningState?: 'CURRENT' | 'NEEDS_REPLAN'
}

export type SnapshotResourceType = {
  id: string
  name: string
  category: $Enums.ResourceCategory
  count: number
  hoursPerDay: number | null
  dayRate: number | null
  allocationMode: $Enums.AllocationMode
  globalTypeId: string | null
  allocationPercent: number
  allocationStartWeek: number | null
  allocationEndWeek: number | null
}

export type SnapshotNamedResource = {
  id: string
  resourceTypeId: string
  name: string
  startWeek: number | null
  endWeek: number | null
  allocationPct: number
  allocationMode: $Enums.AllocationMode
  allocationPercent: number
  allocationStartWeek: number | null
  allocationEndWeek: number | null
  pricingModel: string
}

export type SnapshotTimelineEntry = {
  featureId: string
  startWeek: number
  durationWeeks: number
  isManual: boolean
}

export type SnapshotStoryTimelineEntry = {
  storyId: string
  startWeek: number
  durationWeeks: number
  isManual: boolean
}

export type SnapshotEpicDependency = {
  epicId: string
  dependsOnId: string
}

export type SnapshotFeatureDependency = {
  featureId: string
  dependsOnId: string
}

export type SnapshotOverheadItem = {
  name: string
  type: $Enums.OverheadType
  value: number
  resourceTypeId: string | null
  order: number
}

// ─── V3 capacity profile types ───────────────────────────────────────────────

export type SnapshotCapacitySegment = {
  id: string
  startWeek: number
  endWeek: number
  capacityPercent: number
  source: CapacityProfileSourceEnum
}

export type SnapshotCapacityProfile = {
  id: string
  ownerKind: CapacityProfileOwnerKindEnum
  resourceTypeId: string | null
  namedResourceId: string | null
  planningBasis: CapacityProfilePlanningBasisEnum
  source: CapacityProfileSourceEnum
  defaultPercent: number | null
  startWeek: number | null
  endWeek: number | null
  /** Original legacy field values; SnapshotJsonValue preserves DB_NULL vs JSON_NULL. */
  legacy: SnapshotJsonValue
  segments: SnapshotCapacitySegment[]
}
export type SnapshotCapacityPlanEntry = {
  id: string
  resourceTypeId: string
  headcount: number
  demandFTE: number
  utilisationPct: number
}

export type SnapshotCapacityPlanPeriod = {
  id: string
  periodIndex: number
  startWeek: number
  endWeek: number
  entries: SnapshotCapacityPlanEntry[]
}

export type SnapshotCapacityPlan = {
  id: string
  name: string
  targetWeeks: number
  periodWeeks: number
  maxDelta: number
  isActive: boolean
  totalCost: number | null
  deliveryWeeks: number | null
  createdAt: string
  periods: SnapshotCapacityPlanPeriod[]
}


// ─── V4 types — profile-only capacity state (issue #418) ────────────────────

/**
 * V4 ResourceType snapshot row: the candidate legacy capacity columns are
 * omitted. Independent metadata (count, hoursPerDay, dayRate, identity) and
 * capacity state in capacityProfiles remain.
 */
export type SnapshotResourceTypeV4 = Omit<
  SnapshotResourceType,
  'allocationMode' | 'allocationPercent' | 'allocationStartWeek' | 'allocationEndWeek'
>

/**
 * V4 NamedResource snapshot row: the candidate legacy capacity columns are
 * omitted. Identity and pricingModel remain.
 */
export type SnapshotNamedResourceV4 = Omit<
  SnapshotNamedResource,
  'startWeek' | 'endWeek' | 'allocationPct' | 'allocationMode' | 'allocationPercent' | 'allocationStartWeek' | 'allocationEndWeek'
>

// ─── Version-specific shapes ─────────────────────────────────────────────────

/** V1 is epic-tree-only: either a bare array (historical) or a wrapper resolved
 *  by parseSnapshotData. */
export type SnapshotV1 = SnapshotEpic[]

export type SnapshotV2 = {
  schemaVersion: 2
  epics: SnapshotEpic[]
  project: SnapshotProjectFields | null
  resourceTypes: SnapshotResourceType[]
  namedResources: SnapshotNamedResource[]
  timelineEntries: SnapshotTimelineEntry[]
  storyTimelineEntries: SnapshotStoryTimelineEntry[]
  epicDependencies: SnapshotEpicDependency[]
  featureDependencies: SnapshotFeatureDependency[]
  overheadItems: SnapshotOverheadItem[]
}

export type SnapshotV3 = Omit<SnapshotV2, 'schemaVersion'> & {
  schemaVersion: 3
  capacityProfiles: SnapshotCapacityProfile[]
  /** Optional for backward compatibility with v3 snapshots created before plan capture. */
  capacityPlans?: SnapshotCapacityPlan[]
}

export type SnapshotV4 = Omit<SnapshotV3, 'schemaVersion' | 'resourceTypes' | 'namedResources'> & {
  schemaVersion: 4
  resourceTypes: SnapshotResourceTypeV4[]
  namedResources: SnapshotNamedResourceV4[]
}

export type SnapshotData = SnapshotV1 | SnapshotV2 | SnapshotV3 | SnapshotV4

// ─── Error class ─────────────────────────────────────────────────────────────

export class SnapshotSchemaError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SnapshotSchemaError'
  }
}

// ─── Type guards ─────────────────────────────────────────────────────────────

/**
 * Returns true when `value` is a legacy V1 snapshot (bare epic array or
 * plain object with `epics` array and no `schemaVersion`).
 *
 * The object-with-epics form is accepted for backward compatibility with old
 * stored snapshots, but parseSnapshotData normalises it to the array form.
 */
export function isLegacyV1Snapshot(value: unknown): value is SnapshotV1 {
  if (Array.isArray(value)) return true
  if (typeof value !== 'object' || value === null) return false
  const obj = value as Record<string, unknown>
  if ('schemaVersion' in obj) return false
  return Array.isArray(obj.epics)
}

export function isSnapshotV2(value: unknown): value is SnapshotV2 {
  if (typeof value !== 'object' || value === null) return false
  const obj = value as Record<string, unknown>
  if (obj.schemaVersion !== 2) return false
  return (
    Array.isArray(obj.epics) &&
    (obj.project === null || typeof obj.project === 'object') &&
    Array.isArray(obj.resourceTypes) &&
    Array.isArray(obj.namedResources) &&
    Array.isArray(obj.timelineEntries) &&
    Array.isArray(obj.storyTimelineEntries) &&
    Array.isArray(obj.epicDependencies) &&
    Array.isArray(obj.featureDependencies) &&
    Array.isArray(obj.overheadItems)
  )
}

export function isSnapshotV3(value: unknown): value is SnapshotV3 {
  if (typeof value !== 'object' || value === null) return false
  const obj = value as Record<string, unknown>
  if (obj.schemaVersion !== 3) return false
  return (
    Array.isArray(obj.epics) &&
    (obj.project === null || typeof obj.project === 'object') &&
    Array.isArray(obj.resourceTypes) &&
    Array.isArray(obj.namedResources) &&
    Array.isArray(obj.timelineEntries) &&
    Array.isArray(obj.storyTimelineEntries) &&
    Array.isArray(obj.epicDependencies) &&
    Array.isArray(obj.featureDependencies) &&
    Array.isArray(obj.overheadItems) &&
    Array.isArray(obj.capacityProfiles)
  )
}

export function isSnapshotV4(value: unknown): value is SnapshotV4 {
  if (typeof value !== 'object' || value === null) return false
  const obj = value as Record<string, unknown>
  if (obj.schemaVersion !== 4) return false
  return (
    Array.isArray(obj.epics) &&
    (obj.project === null || typeof obj.project === 'object') &&
    Array.isArray(obj.resourceTypes) &&
    Array.isArray(obj.namedResources) &&
    Array.isArray(obj.timelineEntries) &&
    Array.isArray(obj.storyTimelineEntries) &&
    Array.isArray(obj.epicDependencies) &&
    Array.isArray(obj.featureDependencies) &&
    Array.isArray(obj.overheadItems) &&
    Array.isArray(obj.capacityProfiles)
  )
}

// ─── Parsing ─────────────────────────────────────────────────────────────────

/**
 * Parse raw snapshot JSON into a typed SnapshotData.
 *
 * - Legacy V1 array → returned as-is.
 * - Object without schemaVersion + with epics → normalised to V1 array.
 * - schemaVersion 2 → SnapshotV2.
 * - schemaVersion 3 → SnapshotV3.
 * - schemaVersion 4 → SnapshotV4.
 * - Unknown schemaVersion → SnapshotSchemaError.
 * - Malformed → SnapshotSchemaError.
 *
 * Structural checks are deliberately conservative to accept real stored data
 * without deep-field validation (that is the caller's responsibility).
 */
export function parseSnapshotData(value: unknown): SnapshotData {
  // V1: bare epic array
  if (Array.isArray(value)) {
    return value as SnapshotV1
  }

  if (typeof value !== 'object' || value === null) {
    throw new SnapshotSchemaError('Snapshot data must be a non-null object or an array')
  }

  const obj = value as Record<string, unknown>

  // Legacy object with epics but no schemaVersion → treat as V1, return array
  if (!('schemaVersion' in obj)) {
    if (Array.isArray(obj.epics)) {
      return obj.epics as unknown as SnapshotV1
    }
    throw new SnapshotSchemaError(
      'Snapshot object without schemaVersion must have an "epics" array',
    )
  }

  const sv = obj.schemaVersion

  if (sv === 4) {
    if (isSnapshotV4(value)) return value as SnapshotV4
    throw new SnapshotSchemaError('Data has schemaVersion 4 but structure is invalid')
  }

  if (sv === 3) {
    if (isSnapshotV3(value)) return value as SnapshotV3
    throw new SnapshotSchemaError('Data has schemaVersion 3 but structure is invalid')
  }

  if (sv === 2) {
    if (isSnapshotV2(value)) return value as SnapshotV2
    throw new SnapshotSchemaError('Data has schemaVersion 2 but structure is invalid')
  }

  // Unknown or future schema version — never fall through to v2
  throw new SnapshotSchemaError(`Unsupported schema version: ${String(sv)}`)
}
