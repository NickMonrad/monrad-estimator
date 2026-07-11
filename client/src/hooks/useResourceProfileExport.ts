import { api } from '../lib/api'
import type { ResourceProfile, Project } from '../types/backlog'
import JSZip from 'jszip'
import {
  formatPlanningBasis as fmtPlanningBasis,
  formatCapacityProfileSource as fmtCapSource,
} from '../lib/capacityProfileFormatting'

/**
 * CSV export helpers and handlers for the Resource Profile domain.
 */

export const formatNumber = (value: number, fractionDigits = 2) =>
  value.toLocaleString(undefined, { minimumFractionDigits: fractionDigits, maximumFractionDigits: fractionDigits })

const asciiSafe = (value: string) => value
  .replace(/[–—]/g, '-')
  .replace(/×/g, 'x')

export const toCsvValue = (value: string | number | null | undefined) => {
  if (value == null) return ''
  const str = asciiSafe(String(value))
  if (/[,"\n\r]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`
  }
  return str
}

function formatWeekLabel(week: number) {
  return `W${week + 1}`
}

function formatNamedResourceSegments(
  namedResource: NonNullable<ResourceProfile['resourceRows'][number]['namedResources']>[number],
) {
  const segments = namedResource.actualAllocationSegments ?? []
  if (segments.length === 0) return ''
  return segments
    .map(segment => {
      const start = formatWeekLabel(segment.startWeek)
      if (segment.startWeek === segment.endWeek) return `${start} (${segment.days.toFixed(2)}d)`
      const end = formatWeekLabel(segment.endWeek)
      return `${start}-${end} (${segment.days.toFixed(2)}d)`
    })
    .join('; ')
}

function formatNamedResourceWeeks(
  namedResource: NonNullable<ResourceProfile['resourceRows'][number]['namedResources']>[number],
) {
  const weeks = namedResource.actualAllocatedWeeks ?? []
  return weeks
    .map(w => `${formatWeekLabel(w.week)}=${w.days.toFixed(2)}`)
    .join('; ')
}

function formatCapacityProfileSegments(
  capacityProfile: { segments: Array<{ startWeek: number; endWeek: number; capacityPercent: number }> } | undefined,
) {
  if (!capacityProfile || capacityProfile.segments.length === 0) return ''
  return capacityProfile.segments
    .map(s => {
      const start = formatWeekLabel(s.startWeek)
      if (s.startWeek === s.endWeek) return `${start} ${s.capacityPercent}%`
      const end = formatWeekLabel(s.endWeek)
      return `${start}-${end} ${s.capacityPercent}%`
    })
    .join('; ')
}

/** Format a profile basis when available; otherwise map the legacy allocation mode. */
function formatPlanningBasis(
  capacityProfile: NonNullable<ResourceProfile['resourceRows'][number]['capacityProfile']> | undefined,
  allocationMode: string,
): string {
  if (capacityProfile) return fmtPlanningBasis(capacityProfile.planningBasis)
  // Legacy fallback — map allocationMode to display label
  switch (allocationMode) {
    case 'EFFORT': return 'Demand-following'
    case 'TIMELINE': return 'Availability window'
    case 'FULL_PROJECT': return 'Whole-project allocation'
    case 'CAPACITY_PLAN': return 'Capacity profile'
    default: return allocationMode
  }
}

export const buildProfileCsv = (profileData: ResourceProfile) => {
  const rows: string[][] = [
    [
      'Section', 'Role', 'Resource name', 'Resource identity', 'Category',
      'Resource count', 'Hours per day', 'Effort days', 'Assigned days', 'Billable days',
      'Day rate', 'Subtotal',
      'Planning basis', 'Profile source', 'Default capacity %', 'Profile start', 'Profile end',
      'Availability window start', 'Availability window end',
      'Assigned start', 'Assigned end', 'Capacity profile segments', 'Assignment segments', 'Assigned weeks',
      'Billing basis', 'Handover notes',
    ],
  ]

  profileData.resourceRows.forEach(row => {
    if (row.namedResources && row.namedResources.length > 0) {
      row.namedResources.forEach(nr => {
        const capProfile = nr.capacityProfile
        const profileStart = capProfile?.startWeek != null ? formatWeekLabel(capProfile.startWeek) : ''
        const profileEnd = capProfile?.endWeek != null ? formatWeekLabel(capProfile.endWeek) : ''
        // A resolved profile owns its window even when the authoritative value is null.
        const availStart = capProfile
          ? (capProfile.startWeek != null ? formatWeekLabel(capProfile.startWeek) : '')
          : (nr.startWeek != null ? formatWeekLabel(nr.startWeek) : '')
        const availEnd = capProfile
          ? (capProfile.endWeek != null ? formatWeekLabel(capProfile.endWeek) : '')
          : (nr.endWeek != null ? formatWeekLabel(nr.endWeek) : '')
        rows.push([
          'Resource', row.name, nr.name, nr.synthetic ? 'Planned resource' : 'Named person',
          row.category, String(row.count), String(row.hoursPerDay),
          String(row.effortDays), String(nr.allocatedDays), String(nr.actualAllocatedDays),
          row.dayRate != null ? String(row.dayRate) : '',
          row.dayRate != null ? (nr.actualAllocatedDays * row.dayRate).toFixed(2) : '',
          formatPlanningBasis(capProfile, nr.allocationMode),
          capProfile?.source ? fmtCapSource(capProfile.source) : '',
          capProfile?.defaultPercent != null ? String(capProfile.defaultPercent) : '',
          profileStart,
          profileEnd,
          availStart,
          availEnd,
          nr.actualAllocationStartWeek != null ? formatWeekLabel(nr.actualAllocationStartWeek) : '',
          nr.actualAllocationEndWeek != null ? formatWeekLabel(nr.actualAllocationEndWeek) : '',
          formatCapacityProfileSegments(capProfile),
          formatNamedResourceSegments(nr),
          formatNamedResourceWeeks(nr),
          nr.pricingModel === 'PRO_RATA' ? 'Bill planned allocation' : 'Bill actual scheduled days',
          '',
        ])
      })
      return
    }
    const capProfile = row.capacityProfile
    const profileStart = capProfile?.startWeek != null ? formatWeekLabel(capProfile.startWeek) : ''
    const profileEnd = capProfile?.endWeek != null ? formatWeekLabel(capProfile.endWeek) : ''
    rows.push([
      'Resource', row.name, '', 'Role-level capacity', row.category,
      String(row.count), String(row.hoursPerDay), String(row.effortDays),
      String(row.totalDays), '',
      row.dayRate != null ? String(row.dayRate) : '',
      row.dayRate != null && row.totalDays != null ? (row.totalDays * row.dayRate).toFixed(2) : '',
      formatPlanningBasis(capProfile, row.allocationMode),
      capProfile?.source ? fmtCapSource(capProfile.source) : '',
      capProfile?.defaultPercent != null ? String(capProfile.defaultPercent) : '',
      profileStart,
      profileEnd,
      '',   // Availability window start
      '',   // Availability window end
      '',   // Assigned start
      '',   // Assigned end
      formatCapacityProfileSegments(capProfile), // Capacity profile segments
      '',   // Assignment segments
      '',   // Assigned weeks
      '',   // Billing basis
      '',   // Handover notes
    ])
  })

  profileData.overheadRows.forEach(row => {
    rows.push([
      'Overhead', row.name, '', '', '',
      '', '', '', String(row.computedDays), '',
      '', row.estimatedCost != null ? String(row.estimatedCost) : '',
      '',   // Planning basis
      '',   // Profile source
      '',   // Default capacity %
      '',   // Profile start
      '',   // Profile end
      '',   // Availability window start
      '',   // Availability window end
      '',   // Assigned start
      '',   // Assigned end
      '',   // Capacity profile segments
      '',   // Assignment segments
      '',   // Assigned weeks
      '',   // Billing basis
      row.resourceTypeName ?? '',  // Handover notes
    ])
  })

  return rows.map(r => r.map(toCsvValue).join(',')).join('\n')
}

const slugify = (text: string) =>
  (text || 'project')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'project'

const createCsvBlob = (csv: string) => new Blob([csv], { type: 'text/csv;charset=utf-8' })

const downloadBlob = (blob: Blob, filename: string) => {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

export interface ExportHandlers {
  weekToDate: (weekNum: number | null | undefined) => Date | null
  fmtDate: (d: Date | null) => string
  handleExportProfile: () => void
  handleExportFull: () => Promise<void>
  slugify: (text: string) => string
  toCsvValue: (value: string | number | null | undefined) => string
  buildProfileCsv: (profileData: ResourceProfile) => string
  formatNumber: (value: number, fractionDigits?: number) => string
}

export function useResourceProfileExport(
  projectId: string | undefined,
  project: Project | undefined,
  profile: ResourceProfile | undefined,
) {
  const weekToDate = (weekNum: number | null | undefined): Date | null => {
    if (weekNum == null || !project?.startDate) return null
    const d = new Date(project.startDate)
    d.setDate(d.getDate() + Math.round(weekNum * 7))
    return d
  }

  const fmtDate = (d: Date | null): string => {
    if (!d) return ''
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
  }

  const handleExportProfile = () => {
    if (!profile) return
    const csv = buildProfileCsv(profile)
    const blob = createCsvBlob(csv)
    const safeName = slugify(project?.name ?? 'project')
    downloadBlob(blob, `${safeName}-resource-profile.csv`)
  }

  const handleExportFull = async () => {
    if (!profile || !projectId) return
    try {
      const csv = buildProfileCsv(profile)
      const safeName = slugify(project?.name ?? 'project')
      const zip = new JSZip()
      zip.file(`${safeName}-resource-profile.csv`, csv)
      const [backlogRes, timelineRes] = await Promise.all([
        api.get(`/projects/${projectId}/backlog/export-csv`, { responseType: 'blob' }),
        api.get(`/projects/${projectId}/timeline/export/csv`, { responseType: 'blob' }),
      ])
      zip.file(`${safeName}-backlog.csv`, backlogRes.data)
      zip.file(`${safeName}-timeline.csv`, timelineRes.data)
      const blob = await zip.generateAsync({ type: 'blob' })
      downloadBlob(blob, `${safeName}-project-export.zip`)
    } catch (err) {
      console.error(err)
      alert('Failed to export project data. Please try again.')
    }
  }

  return {
    weekToDate,
    fmtDate,
    handleExportProfile,
    handleExportFull,
    slugify,
    toCsvValue,
    buildProfileCsv,
    formatNumber,
  }
}
