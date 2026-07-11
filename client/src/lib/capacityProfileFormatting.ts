/**
 * capacityProfileFormatting.ts
 *
 * Shared typed unions and display-formatters for capacity profile enums.
 * Single source of truth — no raw server enum values reach the UI or CSV.
 *
 * Type unions mirror server `CapacityProfilePlanningBasis`,
 * `CapacityProfileSource`, and `CapacityProfileResolutionSource`.
 */

import type {
  CapacityProfilePlanningBasis,
  CapacityProfileResolutionSource,
  CapacityProfileSource,
} from '../types/backlog'

// ─── Typed aliases ──────────────────────────────────────────────────────────

export type PlanningBasis = CapacityProfilePlanningBasis
export type ResolutionSource = CapacityProfileResolutionSource

// ─── Display labels ───────────────────────────────────────────────────────

const PLANNING_BASIS_LABELS: Record<PlanningBasis, string> = {
  demandFollowing: 'Demand-following',
  availabilityWindow: 'Availability window',
  wholeProjectAllocation: 'Whole-project allocation',
  capacityProfile: 'Capacity profile',
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

/** Format a capacity-profile source enum value to its display label. */
export function formatCapacityProfileSource(source: CapacityProfileSource): string {
  return CAPACITY_SOURCE_LABELS[source]
}

/** Format a resolution-source enum value to its display label. */
export function formatResolutionSource(source: ResolutionSource): string {
  return RESOLUTION_SOURCE_LABELS[source]
}

// ─── Type guards (used internally; exported for tests) ─────────────────────

export function isPlanningBasis(value: string): value is PlanningBasis {
  return value in PLANNING_BASIS_LABELS
}

export function isCapacityProfileSource(value: string): value is CapacityProfileSource {
  return value in CAPACITY_SOURCE_LABELS
}

export function isResolutionSource(value: string): value is ResolutionSource {
  return value in RESOLUTION_SOURCE_LABELS
}
