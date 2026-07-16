/**
 * capacityProfileFormatting.ts
 *
 * Shared typed unions and display-formatters for capacity profile enums.
 * Single source of truth — no raw server enum values reach the UI or CSV.
 *
 * Also provides consistent label/description formatters for named-resource
 * allocation modes (EFFORT / FULL_PROJECT / TIMELINE / CAPACITY_PLAN) so
 * every UI surface uses the same user-facing terminology.
 *
 * Type unions mirror server `CapacityProfilePlanningBasis`,
 * `CapacityProfileSource`, `CapacityProfileResolutionSource`,
 * and named-resource `allocationMode`.
 */

import type {
  CapacityProfilePlanningBasis,
  CapacityProfileResolutionSource,
  CapacityProfileSource,
} from '../types/backlog'

// ─── Typed aliases ──────────────────────────────────────────────────────────

export type PlanningBasis = CapacityProfilePlanningBasis
export type ResolutionSource = CapacityProfileResolutionSource

// ─── Display labels — CapacityProfilePlanningBasis ─────────────────────────

const PLANNING_BASIS_LABELS: Record<PlanningBasis, string> = {
  demandFollowing: 'As needed',
  availabilityWindow: 'Fixed for selected weeks',
  wholeProjectAllocation: 'Fixed for whole project',
  capacityProfile: 'Varies by week',
}

// ─── Display labels — Named-resource allocationMode (EFFORT/etc.) ─────────

export type AllocationMode = 'EFFORT' | 'FULL_PROJECT' | 'TIMELINE' | 'CAPACITY_PLAN'

const ALLOCATION_MODE_LABELS: Record<AllocationMode, string> = {
  EFFORT: 'As needed',
  FULL_PROJECT: 'Fixed for whole project',
  TIMELINE: 'Fixed for selected weeks',
  CAPACITY_PLAN: 'Varies by week',
}

const ALLOCATION_MODE_DESCRIPTIONS: Record<AllocationMode, string> = {
  EFFORT: 'Assigned only when scheduled work requires this resource.',
  FULL_PROJECT:
    'Available at the selected percentage from the beginning to the end of the project. Work is assigned only when demand exists.',
  TIMELINE:
    'Available at the selected percentage only between the selected start and end weeks. Work is assigned only when demand exists.',
  CAPACITY_PLAN:
    'Availability varies by week. Open the Resource Profile tab to review or configure the weekly pattern.',
}

/**
 * Option definition for rendering dropdown <option> elements or iterating
 * over the four allocation modes in a predictable order.
 */
export interface AllocationModeOption {
  value: AllocationMode
  label: string
  description: string
  showPct: boolean
  showStartEnd: boolean
}

/** Ordered list of all four allocation-mode options for dropdown rendering. */
export const ALLOCATION_MODE_OPTIONS: AllocationModeOption[] = [
  { value: 'EFFORT', label: ALLOCATION_MODE_LABELS.EFFORT, description: ALLOCATION_MODE_DESCRIPTIONS.EFFORT, showPct: false, showStartEnd: false },
  { value: 'FULL_PROJECT', label: ALLOCATION_MODE_LABELS.FULL_PROJECT, description: ALLOCATION_MODE_DESCRIPTIONS.FULL_PROJECT, showPct: true, showStartEnd: false },
  { value: 'TIMELINE', label: ALLOCATION_MODE_LABELS.TIMELINE, description: ALLOCATION_MODE_DESCRIPTIONS.TIMELINE, showPct: true, showStartEnd: true },
  { value: 'CAPACITY_PLAN', label: ALLOCATION_MODE_LABELS.CAPACITY_PLAN, description: ALLOCATION_MODE_DESCRIPTIONS.CAPACITY_PLAN, showPct: false, showStartEnd: false },
]

const CAPACITY_SOURCE_LABELS: Record<CapacityProfileSource, string> = {
  squadPlanner: 'Squad Planner',
  fixed: 'Fixed',
  manual: 'Manual',
  availabilityWindow: 'Availability pattern',
  imported: 'Imported',
  derived: 'Derived',
  legacy: 'Legacy fallback',
}

const RESOLUTION_SOURCE_LABELS: Record<ResolutionSource, string> = {
  PROFILE: 'Profile',
  LEGACY: 'Legacy',
  ACTIVE_CAPACITY_PLAN: 'Active capacity plan',
}

// ─── Format helpers ────────────────────────────────────────────────────────

/** Format a planning-basis enum value to its display label. */
export function formatPlanningBasis(basis: PlanningBasis): string {
  return PLANNING_BASIS_LABELS[basis]
}

/** Format a named-resource allocation-mode value to its display label. */
export function formatAllocationMode(mode: string): string {
  return ALLOCATION_MODE_LABELS[mode as AllocationMode] ?? mode
}

/**
 * Return the contextual description for a named-resource allocation mode.
 * Returns empty string for unrecognised modes.
 */
export function formatAllocationModeDescription(mode: string): string {
  return ALLOCATION_MODE_DESCRIPTIONS[mode as AllocationMode] ?? ''
}

/** Format a capacity-profile source enum value to its display label. */
export function formatCapacityProfileSource(source: CapacityProfileSource): string {
  return CAPACITY_SOURCE_LABELS[source]
}

/** Format a resolution-source enum value to its display label. */
export function formatResolutionSource(source: ResolutionSource): string {
  return RESOLUTION_SOURCE_LABELS[source]
}

/** Check whether a value is a recognised capacity-profile planning basis. */
export function isPlanningBasis(value: string): value is PlanningBasis {
  return value in PLANNING_BASIS_LABELS
}

/** Check whether a value is a recognised capacity profile source. */
export function isCapacityProfileSource(value: string): value is CapacityProfileSource {
  return value in CAPACITY_SOURCE_LABELS
}

/** Check whether a value is a recognised resolution source. */
export function isResolutionSource(value: string): value is ResolutionSource {
  return value in RESOLUTION_SOURCE_LABELS
}


// ─── Effective availability state ──────────────────────────────────────────

export interface EffectiveAvailabilityState {
  /** The effective allocation mode derived from authoritative profile first, then legacy state. */
  effectiveMode: AllocationMode
  /** Whether this resource is managed through the weekly capacity profile editor.
   *  When true, the generic scalar editor (availability select, Available %, Save)
   *  must NOT render. */
  isProfileManaged: boolean
  /** Whether the capacity profile has authoritative resolution (PROFILE or ACTIVE_CAPACITY_PLAN). */
  hasAuthoritativeProfile: boolean
  /** Whether the persisted profile contains at least one weekly segment. */
  hasMeaningfulSegments: boolean
  /** The resolution source that determined the effective state, if authoritative. */
  resolutionSource?: 'PROFILE' | 'ACTIVE_CAPACITY_PLAN'
}


/**
 * Map a capacity-profile planning basis to the most appropriate scalar
 * allocation mode for editing, used when an authoritative profile has no
 * segments and is therefore safely representable by scalar controls.
 *
 * | PlanningBasis                | Mapped mode     | Rationale                         |
 * |------------------------------|-----------------|-----------------------------------|
 * | demandFollowing              | EFFORT          | Follows demand, no date window    |
 * | availabilityWindow           | TIMELINE        | Has start/end window              |
 * | wholeProjectAllocation       | FULL_PROJECT    | Fixed for whole project           |
 * | capacityProfile              | CAPACITY_PLAN   | Weekly profile (managed)          |
 */
function planningBasisToEditableMode(basis: string | null | undefined): AllocationMode {
  switch (basis) {
    case 'demandFollowing': return 'EFFORT'
    case 'availabilityWindow': return 'TIMELINE'
    case 'wholeProjectAllocation': return 'FULL_PROJECT'
    case 'capacityProfile': return 'CAPACITY_PLAN'
    default: return 'EFFORT'
  }
}

/**
 * Derive the effective availability state for a resource row.
 *
 * Priority order:
 * 1. `resolutionSource === 'ACTIVE_CAPACITY_PLAN'` → profile-managed (any segments state)
 * 2. `resolutionSource === 'PROFILE'` with meaningful segments → profile-managed (any planning basis)
 * 3. `resolutionSource === 'PROFILE'` with `capacityProfile` planning basis → profile-managed
 * 4. `resolutionSource === 'PROFILE'` with no segments + scalar-safe planning basis → editable
 * 5. Legacy `allocationMode` fallback
 *
 * A profile-managed row MUST NOT show the generic scalar editor (select, inputs, Save).
 * An authoritative segmented profile has weekly shape that the scalar writer (`upsertRTProfileAndProjectLegacy`)
 * would destroy by deleting existing segments. The `isProfileManaged` gate is the only
 * client-side protection against flattening segmented profiles.
 *
 * For authoritative but scalar profiles without segments, the planning basis is safely
 * representable by the scalar controls and editing is allowed. The `planningBasisToEditableMode`
 * mapping selects the appropriate allocation mode.
 */
export type EffectiveAvailabilityInput = {
  allocationMode?: string | null
  allocationPercent?: number | null
  allocationStartWeek?: number | null
  allocationEndWeek?: number | null
  startWeek?: number | null
  endWeek?: number | null
  derivedStartWeek?: number | null
  derivedEndWeek?: number | null
  capacityProfile?: {
    resolutionSource?: string | null
    planningBasis?: string | null
    defaultPercent?: number | null
    startWeek?: number | null
    endWeek?: number | null
    segments?: Array<{ startWeek: number; endWeek: number; capacityPercent: number }>
  } | null
}

export interface EffectiveAvailabilityDisplay extends EffectiveAvailabilityState {
  /** Scalar percentage from the authoritative profile, or legacy data when no profile resolves. */
  percentage: number | null
  /** Availability window from the authoritative profile, or legacy data when no profile resolves. */
  startWeek: number | null
  endWeek: number | null
  /** Profile-managed capacity has a weekly pattern rather than one fixed period. */
  periodLabel: 'Varies by week' | null
}

export function deriveEffectiveAvailabilityState(row: EffectiveAvailabilityInput): EffectiveAvailabilityState {
  const resolutionSource = row.capacityProfile?.resolutionSource as ('PROFILE' | 'ACTIVE_CAPACITY_PLAN' | null | undefined)
  const planningBasis = row.capacityProfile?.planningBasis
  const segments = row.capacityProfile?.segments ?? []
  const hasSegments = segments.length > 0

  // 1. ACTIVE_CAPACITY_PLAN → always profile-managed
  if (resolutionSource === 'ACTIVE_CAPACITY_PLAN') {
    return {
      effectiveMode: 'CAPACITY_PLAN',
      isProfileManaged: true,
      hasAuthoritativeProfile: true,
      hasMeaningfulSegments: hasSegments,
      resolutionSource: 'ACTIVE_CAPACITY_PLAN',
    }
  }

  const isAuthoritative = resolutionSource === 'PROFILE'

  if (isAuthoritative) {
    // 2. PROFILE with meaningful segments → profile-managed (any planning basis)
    if (hasSegments) {
      return {
        effectiveMode: 'CAPACITY_PLAN',
        isProfileManaged: true,
        hasAuthoritativeProfile: true,
        hasMeaningfulSegments: true,
        resolutionSource: 'PROFILE',
      }
    }

    // 3. PROFILE + capacityProfile → profile-managed even without segments
    if (planningBasis === 'capacityProfile') {
      return {
        effectiveMode: 'CAPACITY_PLAN',
        isProfileManaged: true,
        hasAuthoritativeProfile: true,
        hasMeaningfulSegments: false,
        resolutionSource: 'PROFILE',
      }
    }

    // 4. PROFILE, no segments, scalar-safe planning basis → editable
    return {
      effectiveMode: planningBasisToEditableMode(planningBasis),
      isProfileManaged: false,
      hasAuthoritativeProfile: true,
      hasMeaningfulSegments: false,
      resolutionSource: 'PROFILE',
    }
  }

  // 5. Legacy fallback
  return {
    effectiveMode: (row.allocationMode as AllocationMode) ?? 'EFFORT',
    isProfileManaged: false,
    hasAuthoritativeProfile: false,
    hasMeaningfulSegments: false,
  }
}

/**
 * Resolve one availability presentation state for every UI surface.
 *
 * A PROFILE or ACTIVE_CAPACITY_PLAN owns all profile fields, including a
 * deliberate null start/end window. Legacy compatibility values are consulted
 * only when no authoritative profile resolved.
 */
export function getEffectiveAvailabilityDisplay(row: EffectiveAvailabilityInput): EffectiveAvailabilityDisplay {
  const state = deriveEffectiveAvailabilityState(row)
  const profile = row.capacityProfile

  return {
    ...state,
    percentage: state.hasAuthoritativeProfile
      ? profile?.defaultPercent ?? null
      : row.allocationPercent ?? 100,
    startWeek: state.hasAuthoritativeProfile
      ? profile?.startWeek ?? null
      : row.allocationStartWeek ?? row.startWeek ?? row.derivedStartWeek ?? null,
    endWeek: state.hasAuthoritativeProfile
      ? profile?.endWeek ?? null
      : row.allocationEndWeek ?? row.endWeek ?? row.derivedEndWeek ?? null,
    periodLabel: state.isProfileManaged ? 'Varies by week' : null,
  }
}


export interface EffectiveAvailabilityBadge {
  label: string
  color: string
  sub: string | null
}

/** Build the shared badge text used by Resource Profile and Commercial. */
export function getEffectiveAvailabilityBadge(
  availability: EffectiveAvailabilityDisplay,
  projectDurationWeeks?: number | null,
): EffectiveAvailabilityBadge {
  if (availability.isProfileManaged) {
    return { label: 'Varies by week', color: 'bg-green-100 text-green-700', sub: null }
  }

  const mode = availability.effectiveMode
  if (mode === 'CAPACITY_PLAN') {
    return { label: 'Varies by week', color: 'bg-green-100 text-green-700', sub: null }
  }
  const label = formatAllocationMode(mode)
  if (mode === 'EFFORT') {
    return { label, color: 'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-400', sub: null }
  }

  const percentLabel = availability.percentage != null ? `${label} · ${availability.percentage}%` : label
  if (mode === 'TIMELINE') {
    const sub = availability.startWeek != null && availability.endWeek != null
      ? `Wk ${Math.floor(availability.startWeek)} → Wk ${Math.floor(availability.endWeek)}`
      : null
    return { label: percentLabel, color: 'bg-blue-100 text-blue-700', sub }
  }

  const sub = availability.hasAuthoritativeProfile
    ? availability.startWeek != null && availability.endWeek != null
      ? `Wk ${Math.floor(availability.startWeek)} → Wk ${Math.floor(availability.endWeek)}`
      : null
    : projectDurationWeeks != null ? `Wk 0 → Wk ${Math.floor(projectDurationWeeks)}` : null
  return { label: percentLabel, color: 'bg-purple-100 text-purple-700', sub }
}
