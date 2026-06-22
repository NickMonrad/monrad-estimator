import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../lib/api'
import type { Project, ResourceProfile, ProjectDiscount, RateCard } from '../types/backlog'
import { computeCommercialData, type CommercialRow } from '../utils/financialCalculations'

/**
 * Commercial data queries and derived computations.
 * Owns discount/rate-card queries, chart data, filtered rows, and cost calculations.
 */
export interface CommercialDataState {
  discounts: ProjectDiscount[]
  rateCards: RateCard[]
  hasCost: boolean
  columnCount: number
  chartData: Array<{ name: string; taskDays: number; overheadDays: number }>
  filteredResourceRows: ResourceProfile['resourceRows']
  commercialData: ReturnType<typeof computeCommercialData>
}

export function useCommercialData(
  projectId: string | undefined,
  activeTab: string,
  profile: ResourceProfile | undefined,
  project: Project | undefined,
) {
  const { data: discounts = [] } = useQuery<ProjectDiscount[]>({
    queryKey: ['discounts', projectId],
    queryFn: () => api.get(`/projects/${projectId}/discounts`).then(r => r.data),
    enabled: !!projectId && activeTab === 'commercial',
  })

  const { data: rateCards = [] } = useQuery<RateCard[]>({
    queryKey: ['rate-cards'],
    queryFn: () => api.get('/rate-cards').then(r => r.data),
    enabled: activeTab === 'commercial',
  })

  const hasCost = profile?.summary.hasCost ?? false
  const columnCount = hasCost ? 9 : 8

  const chartData = useMemo(() => {
    if (!profile) return []
    const data: Array<{ name: string; taskDays: number; overheadDays: number }> = [
      ...profile.resourceRows.map(row => ({
        name: row.name,
        taskDays: row.totalDays,
        overheadDays: 0,
      })),
      ...profile.overheadRows.map(row => ({
        name: row.name,
        taskDays: 0,
        overheadDays: row.computedDays,
      })),
    ]
    return data
  }, [profile])

  const filteredResourceRows = useMemo(() => {
    if (!profile) return []
    const overheadLinkedRtIds = new Set(
      profile.overheadRows
        .filter(r => r.resourceTypeId)
        .map(r => r.resourceTypeId!)
    )
    return profile.resourceRows.filter(
      row => row.totalHours > 0 || row.totalDays > 0 || overheadLinkedRtIds.has(row.resourceTypeId)
    )
  }, [profile])

  const commercialData = useMemo(() => {
    return computeCommercialData(profile, discounts, project)
  }, [profile, discounts, project])

  return {
    discounts,
    rateCards,
    hasCost,
    columnCount,
    chartData,
    filteredResourceRows,
    commercialData,
  }
}

export type { CommercialRow }
