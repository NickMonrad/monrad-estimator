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
    'Availability follows the saved capacity profile. Work is assigned only when demand exists.',
}

const CAPACITY_SOURCE_LABELS: Record<CapacityProfileSource, string> = {
  squadPlanner: 'Squad Planner',
  fixed: 'Fixed',
  manual: 'Manual',
  availabilityWindow: 'Availability window',
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

