import { useState, useEffect } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { type UseMutationResult } from '@tanstack/react-query'
import { useQueryClient } from '@tanstack/react-query'

import { useResourceProfileData } from './useResourceProfileData'
import { useResourceProfileMutations, TYPE_OPTIONS } from './useResourceProfileMutations'
import { useAllocationEditing } from './useAllocationEditing'
import { useCommercialData } from './useCommercialData'
import { useCommercialMutations } from './useCommercialMutations'
import { useResourceProfileExport, formatNumber, buildProfileCsv, toCsvValue } from './useResourceProfileExport'
import { computeCommercialData, type CommercialRow } from '../utils/financialCalculations'
import type {
  Project,
  ResourceProfile,
  ResourceType,
  OverheadItem,
  ProjectDiscount,
  RateCard,
} from '../types/backlog'

export { TYPE_OPTIONS, formatNumber, buildProfileCsv, toCsvValue }
export type { CommercialRow }
export type { OverheadType } from './useResourceProfileMutations'

// ─── Concrete return type ───────────────────────────────────────────────────

export interface ResourceProfileState {
  projectId: string | undefined
  navigate: ReturnType<typeof useNavigate>
  qc: ReturnType<typeof useQueryClient>
  project: Project | undefined
  profile: ResourceProfile | undefined
  profileLoading: boolean
  overheadItems: OverheadItem[]
  resourceTypes: ResourceType[]
  discounts: ProjectDiscount[]
  rateCards: RateCard[]
  expandedRows: Set<string>
  setExpandedRows: React.Dispatch<React.SetStateAction<Set<string>>>
  expandedNamedResources: Set<string>
  setExpandedNamedResources: React.Dispatch<React.SetStateAction<Set<string>>>
  editingId: string | null
  setEditingId: React.Dispatch<React.SetStateAction<string | null>>
  formError: string | null
  setFormError: React.Dispatch<React.SetStateAction<string | null>>
  profileMutationError: string | null
  clearProfileMutationError: () => void
  form: { name: string; resourceTypeId: string; type: 'PERCENTAGE' | 'FIXED_DAYS' | 'DAYS_PER_WEEK'; value: string }
  setForm: React.Dispatch<React.SetStateAction<{ name: string; resourceTypeId: string; type: 'PERCENTAGE' | 'FIXED_DAYS' | 'DAYS_PER_WEEK'; value: string }>>
  bufferWeeks: number
  onboardingWeeks: number
  activeTab: 'profile' | 'commercial'
  setActiveTab: React.Dispatch<React.SetStateAction<'profile' | 'commercial'>>
  showDiscountForm: boolean
  setShowDiscountForm: React.Dispatch<React.SetStateAction<boolean>>
  discountForm: { label: string; type: 'PERCENTAGE' | 'FIXED_AMOUNT'; value: string }
  setDiscountForm: React.Dispatch<React.SetStateAction<{ label: string; type: 'PERCENTAGE' | 'FIXED_AMOUNT'; value: string }>>
  discountFormError: string | null
  setDiscountFormError: React.Dispatch<React.SetStateAction<string | null>>
  selectedRateCardId: string
  setSelectedRateCardId: React.Dispatch<React.SetStateAction<string>>
  rateCardResult: { updated: number; skipped: number } | null
  editingTaxLabel: boolean
  setEditingTaxLabel: React.Dispatch<React.SetStateAction<boolean>>
  taxLabelDraft: string
  setTaxLabelDraft: React.Dispatch<React.SetStateAction<string>>
  editingTaxRate: boolean
  setEditingTaxRate: React.Dispatch<React.SetStateAction<boolean>>
  taxRateDraft: string
  setTaxRateDraft: React.Dispatch<React.SetStateAction<string>>
  hasCost: boolean
  columnCount: number
  chartData: Array<{ name: string; taskDays: number; overheadDays: number }>
  filteredResourceRows: ResourceProfile['resourceRows']
  commercialData: ReturnType<typeof computeCommercialData>
  createDiscount: UseMutationResult<any, any, any, any>
  deleteDiscount: UseMutationResult<any, any, any, any>
  updateTax: UseMutationResult<any, any, any, any>
  applyRateCard: UseMutationResult<any, any, any, any>
  updateResourceType: UseMutationResult<any, any, any, any>
  addPerson: UseMutationResult<any, any, any, any>
  removeLastPerson: UseMutationResult<any, any, any, any>
  createOverhead: UseMutationResult<any, any, any, any>
  updateOverhead: UseMutationResult<any, any, any, any>
  deleteOverhead: UseMutationResult<any, any, any, any>
  handleFormSubmit: () => void
  handleEdit: (item: OverheadItem) => void
  handleDelete: (id: string) => void
  resetForm: () => void
  slugify: (text: string) => string
  toCsvValue: (value: string | number | null | undefined) => string
  buildProfileCsv: (profileData: ResourceProfile) => string
  createCsvBlob: (csv: string) => Blob
  downloadBlob: (blob: Blob, filename: string) => void
  handleExportProfile: () => void
  handleExportFull: () => Promise<void>
  handleDiscountSubmit: () => void
  handleApplyRateCard: () => void
  getAllocationBadge: (row: CommercialRow) => { label: string; color: string; sub: string | null }
  toggleRow: (rtId: string) => void
  toggleNamedResources: (rtId: string) => void
  weekToDate: (weekNum: number | null | undefined) => Date | null
  fmtDate: (d: Date | null) => string
  formatNumber: (value: number, fractionDigits?: number) => string
}

export type UseResourceProfileReturn = ResourceProfileState

// ─── Facade hook ────────────────────────────────────────────────────────────

/**
 * Resource Profile page hook.
 *
 * Behaviour-preserving facade composing focused sub-modules:
 * - Data fetching (useResourceProfileData)
 * - Resource mutations + form state (useResourceProfileMutations)
 * - Allocation editing (useAllocationEditing)
 * - Commercial queries + derived data (useCommercialData)
 * - Commercial mutations (useCommercialMutations)
 * - CSV export (useResourceProfileExport)
 *
 * All mutations use central projectInvalidation helpers (#267).
 */
export function useResourceProfile(): ResourceProfileState {
  const { id: projectId } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const qc = useQueryClient()

  // ── Data fetching ──
  const { project, profile, profileLoading, overheadItems, resourceTypes } = useResourceProfileData(projectId)

  // ── Resource Profile mutations + form state ──
  const {
    expandedRows, setExpandedRows,
    expandedNamedResources, setExpandedNamedResources,
    editingId, setEditingId,
    formError, setFormError,
    profileMutationError, clearProfileMutationError,
    form, setForm,
    toggleRow, toggleNamedResources,
    resetForm,
    updateResourceType,
    addPerson, removeLastPerson,
    createOverhead, updateOverhead, deleteOverhead,
    handleFormSubmit, handleEdit, handleDelete,
  } = useResourceProfileMutations(projectId)

  // ── Allocation badge ──
  const { getAllocationBadge } = useAllocationEditing()
  const getAllocationBadgeForRow = (row: CommercialRow) => getAllocationBadge(row, profile)

  // ── Buffer / onboarding weeks ──
  const [bufferWeeks, setBufferWeeks] = useState(0)
  const [onboardingWeeks, setOnboardingWeeks] = useState(0)
  useEffect(() => {
    if (profile != null) {
      setBufferWeeks(profile.bufferWeeks ?? 0)
      setOnboardingWeeks(profile.onboardingWeeks ?? 0)
    }
  }, [profile?.bufferWeeks, profile?.onboardingWeeks])

  // ── Tab state ──
  type TabKey = 'profile' | 'commercial'
  const [activeTab, setActiveTab] = useState<TabKey>('profile')

  // ── Commercial data ──
  const {
    discounts, rateCards,
    hasCost, columnCount,
    chartData, filteredResourceRows,
    commercialData,
  } = useCommercialData(projectId, activeTab, profile, project)

  // ── Commercial mutations ──
  const {
    showDiscountForm, setShowDiscountForm,
    discountForm, setDiscountForm,
    discountFormError, setDiscountFormError,
    selectedRateCardId, setSelectedRateCardId,
    rateCardResult,
    editingTaxLabel, setEditingTaxLabel,
    taxLabelDraft, setTaxLabelDraft,
    editingTaxRate, setEditingTaxRate,
    taxRateDraft, setTaxRateDraft,
    createDiscount, deleteDiscount, updateTax, applyRateCard,
    handleDiscountSubmit, handleApplyRateCard,
  } = useCommercialMutations(projectId)

  // ── CSV export ──
  const {
    weekToDate, fmtDate,
    handleExportProfile, handleExportFull,
    slugify,
  } = useResourceProfileExport(projectId, project, profile)

  const createCsvBlob = (csv: string) => new Blob([csv], { type: 'text/csv;charset=utf-8' })

  const downloadBlob = (blob: Blob, filename: string) => {
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    a.click()
    URL.revokeObjectURL(url)
  }

  return {
    projectId, navigate, qc,
    project, profile, profileLoading, overheadItems, resourceTypes,
    discounts, rateCards,
    expandedRows, setExpandedRows,
    expandedNamedResources, setExpandedNamedResources,
    editingId, setEditingId,
    formError, setFormError,
    profileMutationError, clearProfileMutationError,
    form, setForm,
    bufferWeeks, onboardingWeeks,
    activeTab, setActiveTab,
    showDiscountForm, setShowDiscountForm,
    discountForm, setDiscountForm,
    discountFormError, setDiscountFormError,
    selectedRateCardId, setSelectedRateCardId,
    rateCardResult,
    editingTaxLabel, setEditingTaxLabel,
    taxLabelDraft, setTaxLabelDraft,
    editingTaxRate, setEditingTaxRate,
    taxRateDraft, setTaxRateDraft,
    hasCost, columnCount, chartData, filteredResourceRows, commercialData,
    createDiscount, deleteDiscount, updateTax, applyRateCard,
    updateResourceType,
    addPerson, removeLastPerson,
    createOverhead, updateOverhead, deleteOverhead,
    handleFormSubmit, handleEdit, handleDelete,
    resetForm,
    slugify, toCsvValue, buildProfileCsv, createCsvBlob, downloadBlob,
    handleExportProfile, handleExportFull,
    handleDiscountSubmit, handleApplyRateCard,
    getAllocationBadge: getAllocationBadgeForRow,
    toggleRow, toggleNamedResources,
    weekToDate, fmtDate, formatNumber,
  }
}
