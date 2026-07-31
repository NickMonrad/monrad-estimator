import { getEffectiveAvailabilityBadge, getEffectiveAvailabilityDisplay } from '../lib/capacityProfileFormatting'
import type { ResourceProfile } from '../types/backlog'
import type { CommercialRow } from '../utils/financialCalculations'

export interface AllocationEditingState {
  getAllocationBadge: (row: CommercialRow, profile: ResourceProfile | undefined) => { label: string; color: string; sub: string | null }
}

/**
 * Availability badge derivation for the Commercial tab.
 *
 * Issue #403 removed the legacy allocation-mutation state
 * (updateAllocationMutation / updateNrAllocationMutation / scalar draft
 * editing) from this hook — Resource Profile and Timeline now submit the
 * first-class owner-scoped capacity-profile endpoint directly.
 */
export function useAllocationEditing() {
  const getAllocationBadge = (row: CommercialRow, profile: ResourceProfile | undefined) => {
    if (row.allocationMode === 'AGGREGATE') {
      return { label: 'Named resources: mixed modes', color: 'bg-gray-100 text-gray-400', sub: null as string | null }
    }
    return getEffectiveAvailabilityBadge(
      getEffectiveAvailabilityDisplay(row),
      profile?.projectDurationWeeks,
    )
  }

  return {
    getAllocationBadge,
  }
}
