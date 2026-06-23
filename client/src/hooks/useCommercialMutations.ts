import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/api'
import {
  invalidateProjectCommercial,
  invalidateProjectResourceProfile,
} from '../lib/projectInvalidation'

/**
 * Commercial mutations and state: discounts, tax, rate cards.
 */
export interface CommercialMutationsState {
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
  createDiscount: ReturnType<typeof useMutation>
  deleteDiscount: ReturnType<typeof useMutation>
  updateTax: ReturnType<typeof useMutation>
  applyRateCard: ReturnType<typeof useMutation>
  handleDiscountSubmit: () => void
  handleApplyRateCard: () => void
}

export function useCommercialMutations(projectId: string | undefined) {
  const qc = useQueryClient()
  const [showDiscountForm, setShowDiscountForm] = useState(false)
  const [discountForm, setDiscountForm] = useState({ label: '', type: 'PERCENTAGE' as 'PERCENTAGE' | 'FIXED_AMOUNT', value: '' })
  const [discountFormError, setDiscountFormError] = useState<string | null>(null)
  const [selectedRateCardId, setSelectedRateCardId] = useState('')
  const [rateCardResult, setRateCardResult] = useState<{ updated: number; skipped: number } | null>(null)
  const [editingTaxLabel, setEditingTaxLabel] = useState(false)
  const [taxLabelDraft, setTaxLabelDraft] = useState('')
  const [editingTaxRate, setEditingTaxRate] = useState(false)
  const [taxRateDraft, setTaxRateDraft] = useState('')

  const createDiscount = useMutation({
    mutationFn: (data: { label: string; type: string; value: number }) =>
      api.post(`/projects/${projectId}/discounts`, data).then(r => r.data),
    onSuccess: () => {
      invalidateProjectCommercial(qc, projectId)
      setShowDiscountForm(false)
      setDiscountForm({ label: '', type: 'PERCENTAGE', value: '' })
      setDiscountFormError(null)
    },
  })

  const deleteDiscount = useMutation({
    mutationFn: (id: string) => api.delete(`/projects/${projectId}/discounts/${id}`),
    onSuccess: () => invalidateProjectCommercial(qc, projectId),
  })

  const updateTax = useMutation({
    mutationFn: (data: { taxRate?: number | null; taxLabel?: string }) =>
      api.patch(`/projects/${projectId}/tax`, data).then(r => r.data),
    onSuccess: () => {
      invalidateProjectCommercial(qc, projectId)
    },
  })

  const applyRateCard = useMutation({
    mutationFn: (rateCardId: string) =>
      api.post(`/projects/${projectId}/apply-rate-card`, { rateCardId }).then(r => r.data),
    onSuccess: (data: { updated: number; skipped: number }) => {
      setRateCardResult(data)
      invalidateProjectResourceProfile(qc, projectId)
    },
  })

  const handleDiscountSubmit = () => {
    if (!discountForm.label.trim()) {
      setDiscountFormError('Label is required')
      return
    }
    const numericValue = parseFloat(discountForm.value)
    if (Number.isNaN(numericValue) || numericValue <= 0) {
      setDiscountFormError('Value must be a positive number')
      return
    }
    setDiscountFormError(null)
    createDiscount.mutate({ label: discountForm.label.trim(), type: discountForm.type, value: numericValue })
  }

  const handleApplyRateCard = () => {
    if (!selectedRateCardId) return
    if (!confirm('Apply this rate card? Existing day rates will be overwritten for matching resource types.')) return
    setRateCardResult(null)
    applyRateCard.mutate(selectedRateCardId)
  }

  return {
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
  }
}
