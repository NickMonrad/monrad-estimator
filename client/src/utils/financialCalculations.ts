import type { ResourceProfile, ProjectDiscount } from '../types/backlog'

export type CommercialRow = {
  id: string
  name: string
  count: number
  effortDays: number
  allocatedDays: number
  totalDays: number
  dayRate: number
  subtotal: number
  allocationMode: string
  allocationPercent: number
  allocationStartWeek: number | null
  allocationEndWeek: number | null
  derivedStartWeek: number | null
  derivedEndWeek: number | null
  kind: 'resource' | 'named-resource' | 'overhead'
  /** For mutations — NR rows need their RT id for the PATCH URL */
  resourceTypeId: string
  appliedDiscounts: Array<{
    id: string
    label: string
    type: string
    value: number
    calculatedAmount: number
    resourceTypeId: string | null
  }>
  netSubtotal: number
}

export type CommercialData = {
  rows: CommercialRow[]
  subtotal: number
  projectDiscounts: Array<ProjectDiscount & { calculatedAmount: number }>
  totalProjectDiscount: number
  afterDiscounts: number
  taxRate: number | null
  taxLabel: string
  taxEnabled: boolean
  taxAmount: number
  grandTotal: number
}

/**
 * Pure function that computes the commercial cost breakdown from profile + discounts + project tax config.
 * Extracted from the commercialData useMemo in ResourceProfilePage.
 */
export function computeCommercialData(
  profile: ResourceProfile | undefined,
  discounts: ProjectDiscount[],
  project: { taxRate?: number | null; taxLabel?: string | null } | undefined,
): CommercialData | null {
  if (!profile) return null

  // All rows (resource + overhead) with day rates
  const costRows = [
    ...profile.resourceRows.filter(r => r.dayRate != null).flatMap((r): Array<{
      id: string; name: string; count: number; effortDays: number; allocatedDays: number;
      totalDays: number; dayRate: number; subtotal: number; allocationMode: string;
      allocationPercent: number; allocationStartWeek: number | null; allocationEndWeek: number | null;
      derivedStartWeek: number | null; derivedEndWeek: number | null;
      kind: 'named-resource' | 'resource'; resourceTypeId: string;
    }> => {
      if (r.namedResources && r.namedResources.length > 0) {
        // Per-NR rows only — no aggregate row in commercial tab
        const nrRows = r.namedResources.map(nr => ({
          id: nr.id,
          name: nr.name,
          count: 1,
          effortDays: nr.allocatedDays,
          allocatedDays: nr.allocatedDays,
          totalDays: nr.allocatedDays,
          dayRate: r.dayRate!,
          subtotal: nr.allocatedDays * r.dayRate!,
          allocationMode: nr.allocationMode,
          allocationPercent: nr.allocationPercent,
          allocationStartWeek: nr.allocationStartWeek ?? null,
          allocationEndWeek: nr.allocationEndWeek ?? null,
          derivedStartWeek: nr.derivedStartWeek ?? r.derivedStartWeek ?? null,
          derivedEndWeek: nr.derivedEndWeek ?? r.derivedEndWeek ?? null,
          kind: 'named-resource' as const,
          resourceTypeId: r.resourceTypeId,
        }))
        return nrRows
      }
      // No NRs — RT-level row as before
      return [{
        id: r.resourceTypeId,
        name: r.name,
        count: r.count,
        effortDays: r.effortDays ?? r.totalDays,
        allocatedDays: r.allocatedDays ?? r.totalDays,
        totalDays: r.totalDays,
        dayRate: r.dayRate!,
        subtotal: r.totalDays * r.dayRate!,
        allocationMode: r.allocationMode ?? 'EFFORT',
        allocationPercent: r.allocationPercent ?? 100,
        allocationStartWeek: r.allocationStartWeek ?? null,
        allocationEndWeek: r.allocationEndWeek ?? null,
        derivedStartWeek: r.derivedStartWeek ?? null,
        derivedEndWeek: r.derivedEndWeek ?? null,
        kind: 'resource' as const,
        resourceTypeId: r.resourceTypeId,
      }]
    }),
    ...profile.overheadRows.filter(r => r.dayRate != null).map(r => ({
      id: r.overheadId,
      name: r.name,
      count: 1,
      effortDays: r.computedDays,
      allocatedDays: r.computedDays,
      totalDays: r.computedDays,
      dayRate: r.dayRate!,
      subtotal: r.computedDays * r.dayRate!,
      allocationMode: 'EFFORT' as string,
      allocationPercent: 100,
      allocationStartWeek: null as number | null,
      allocationEndWeek: null as number | null,
      derivedStartWeek: null as number | null,
      derivedEndWeek: null as number | null,
      kind: 'overhead' as const,
      resourceTypeId: r.overheadId,
    })),
  ]

  // Per-resource-type discounts
  const rtDiscounts = discounts.filter(d => d.resourceTypeId != null)
  const projectDiscounts = discounts.filter(d => d.resourceTypeId == null)

  // Build net subtotals per row (applying RT-level discounts)
  const rowsWithDiscounts = costRows.map(row => {
    const appliedDiscounts = rtDiscounts
      .filter(d => d.resourceTypeId === row.resourceTypeId)
      .map(d => ({
        ...d,
        calculatedAmount: d.type === 'PERCENTAGE' ? (d.value / 100) * row.subtotal : d.value,
      }))
    // For aggregate rows (AGGREGATE mode), don't double-count discounts — NR rows handle their own
    const skipDiscounts = row.allocationMode === 'AGGREGATE'
    const effectiveDiscounts = skipDiscounts ? [] : appliedDiscounts
    const totalDiscount = effectiveDiscounts.reduce((sum, d) => sum + d.calculatedAmount, 0)
    return { ...row, appliedDiscounts: effectiveDiscounts, netSubtotal: row.subtotal - totalDiscount }
  })

  const subtotal = rowsWithDiscounts.reduce((sum, r) => sum + r.netSubtotal, 0)

  // Project-level discounts
  const projectDiscountsWithCalc = projectDiscounts.map(d => ({
    ...d,
    calculatedAmount: d.type === 'PERCENTAGE' ? (d.value / 100) * subtotal : d.value,
  }))
  const totalProjectDiscount = projectDiscountsWithCalc.reduce((sum, d) => sum + d.calculatedAmount, 0)
  const afterDiscounts = subtotal - totalProjectDiscount

  // Tax
  const taxRate = project?.taxRate ?? null
  const taxLabel = project?.taxLabel ?? 'GST'
  const taxEnabled = taxRate != null
  const taxAmount = taxEnabled ? (taxRate / 100) * afterDiscounts : 0

  const grandTotal = afterDiscounts + taxAmount

  return {
    rows: rowsWithDiscounts,
    subtotal,
    projectDiscounts: projectDiscountsWithCalc,
    totalProjectDiscount,
    afterDiscounts,
    taxRate,
    taxLabel,
    taxEnabled,
    taxAmount,
    grandTotal,
  }
}
