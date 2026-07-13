import React from 'react'
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import CommercialTab from '@/components/resource-profile/CommercialTab'
import type { CommercialData } from '@/utils/financialCalculations'

function createMockCommercialData(overrides: Partial<CommercialData> = {}): CommercialData {
  return {
    rows: [],
    subtotal: 0,
    projectDiscounts: [],
    totalProjectDiscount: 0,
    afterDiscounts: 0,
    taxRate: null,
    taxLabel: '',
    taxEnabled: false,
    taxAmount: 0,
    grandTotal: 0,
    ...overrides,
  }
}

function renderTab(commercialData: CommercialData) {
  return render(
    <CommercialTab
      projectId="project-1"
      profile={{
        projectId: 'project-1',
        hoursPerDay: 8,
        projectDurationWeeks: 10,
        bufferWeeks: 0,
        onboardingWeeks: 0,
        resourceRows: [],
        overheadRows: [],
        summary: { totalHours: 0, totalDays: 0, totalCost: null, hasCost: false },
      }}
      project={{ id: 'project-1', name: 'Test Project', taxRate: null, taxLabel: '' } as any}
      rateCards={[]}
      commercialData={commercialData}
      showDiscountForm={false}
      setShowDiscountForm={vi.fn()}
      discountForm={null}
      setDiscountForm={vi.fn()}
      discountFormError={null}
      selectedRateCardId={null}
      setSelectedRateCardId={vi.fn()}
      rateCardResult={null}
      editingTaxLabel={false}
      setEditingTaxLabel={vi.fn()}
      taxLabelDraft=""
      setTaxLabelDraft={vi.fn()}
      editingTaxRate={false}
      setEditingTaxRate={vi.fn()}
      taxRateDraft=""
      setTaxRateDraft={vi.fn()}
      bufferWeeks={0}
      onboardingWeeks={0}
      createDiscount={{ mutate: vi.fn() } as any}
      deleteDiscount={{ mutate: vi.fn() } as any}
      updateTax={{ mutate: vi.fn() } as any}
      applyRateCard={{ mutate: vi.fn() } as any}
      handleDiscountSubmit={vi.fn()}
      handleApplyRateCard={vi.fn()}
      getAllocationBadge={() => ({ label: 'T&M', color: 'bg-gray-100 text-gray-600', sub: null })}
      weekToDate={vi.fn(() => null)}
      fmtDate={vi.fn(() => '')}
      formatNumber={(value: number, fractionDigits = 2) => value.toFixed(fractionDigits)}
      filteredResourceRows={[]}
    />,
  )
}

describe('CommercialTab billing basis indicator', () => {
  it('shows actual scheduled days indicator for ACTUAL_DAYS named resources', () => {
    const data = createMockCommercialData({
      rows: [
        {
          id: 'nr-1',
          name: 'Developer',
          count: 1,
          effortDays: 10,
          allocatedDays: 8,
          totalDays: 8,
          dayRate: 500,
          subtotal: 4000,
          allocationMode: 'EFFORT',
          allocationPercent: 100,
          allocationStartWeek: 0,
          allocationEndWeek: 9,
          derivedStartWeek: 0,
          derivedEndWeek: 9,
          kind: 'named-resource',
          pricingModel: 'ACTUAL_DAYS',
          resourceTypeId: 'rt-1',
          appliedDiscounts: [],
          netSubtotal: 4000,
        },
      ],
      subtotal: 4000,
    })

    renderTab(data)
    expect(screen.getByText('(named person · bill actual scheduled days)')).toBeInTheDocument()
  })

  it('shows planned allocation indicator for PRO_RATA named resources', () => {
    const data = createMockCommercialData({
      rows: [
        {
          id: 'nr-2',
          name: 'Designer',
          count: 1,
          effortDays: 10,
          allocatedDays: 10,
          totalDays: 10,
          dayRate: 600,
          subtotal: 6000,
          allocationMode: 'EFFORT',
          allocationPercent: 100,
          allocationStartWeek: 0,
          allocationEndWeek: 9,
          derivedStartWeek: 0,
          derivedEndWeek: 9,
          kind: 'named-resource',
          pricingModel: 'PRO_RATA',
          resourceTypeId: 'rt-2',
          appliedDiscounts: [],
          netSubtotal: 6000,
        },
      ],
      subtotal: 6000,
    })

    renderTab(data)
    expect(screen.getByText('(named person · bill planned allocation)')).toBeInTheDocument()
  })

  it('does not show billing basis indicator for resource (non-named) rows', () => {
    const data = createMockCommercialData({
      rows: [
        {
          id: 'rt-1',
          name: 'Security Consultant',
          count: 1,
          effortDays: 5,
          allocatedDays: 5,
          totalDays: 5,
          dayRate: 1200,
          subtotal: 6000,
          allocationMode: 'EFFORT',
          allocationPercent: 100,
          allocationStartWeek: null,
          allocationEndWeek: null,
          derivedStartWeek: null,
          derivedEndWeek: null,
          kind: 'resource',
          pricingModel: null,
          resourceTypeId: 'rt-1',
          appliedDiscounts: [],
          netSubtotal: 6000,
        },
      ],
      subtotal: 6000,
    })

    renderTab(data)
    expect(screen.queryByText(/person ·/)).not.toBeInTheDocument()
  })

  it('does not show billing basis indicator for overhead rows', () => {
    const data = createMockCommercialData({
      rows: [
        {
          id: 'oh-1',
          name: 'Travel',
          count: 1,
          effortDays: 0,
          allocatedDays: 0,
          totalDays: 0,
          dayRate: 0,
          subtotal: 5000,
          allocationMode: 'FULL_PROJECT',
          allocationPercent: 100,
          allocationStartWeek: null,
          allocationEndWeek: null,
          derivedStartWeek: null,
          derivedEndWeek: null,
          kind: 'overhead',
          pricingModel: null,
          resourceTypeId: 'oh-1',
          appliedDiscounts: [],
          netSubtotal: 5000,
        },
      ],
      subtotal: 5000,
    })

    renderTab(data)
    expect(screen.queryByText(/person ·/)).not.toBeInTheDocument()
  })

  it('indicator is display-only, no editable controls from #276', () => {
    const data = createMockCommercialData({
      rows: [
        {
          id: 'nr-1',
          name: 'Developer',
          count: 1,
          effortDays: 10,
          allocatedDays: 8,
          totalDays: 8,
          dayRate: 500,
          subtotal: 4000,
          allocationMode: 'EFFORT',
          allocationPercent: 100,
          allocationStartWeek: 0,
          allocationEndWeek: 9,
          derivedStartWeek: 0,
          derivedEndWeek: 9,
          kind: 'named-resource',
          pricingModel: 'ACTUAL_DAYS',
          resourceTypeId: 'rt-1',
          appliedDiscounts: [],
          netSubtotal: 4000,
        },
      ],
      subtotal: 4000,
    })

    renderTab(data)

    // The billing basis indicator is a <span> — not a <select>, <input>, or <button>
    const indicator = screen.getByText('(named person · bill actual scheduled days)')
    expect(indicator.tagName).toBe('SPAN')

    // Verify no allocation-mode editing controls from #276 are present
    // (allocation mode editing lives in Resource Profile, not Commercial)
    // The cost summary may still display allocation badge text (e.g. "T&M") as read-only info
    expect(screen.queryByRole('combobox', { name: /allocation mode/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /edit allocation/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('combobox', { name: /timeline|effort|capacity plan|full project/i })).not.toBeInTheDocument()
  })
})

describe('CommercialTab Planning Context', () => {
  it('shows Planning Context heading with read-only values', () => {
    renderTab(createMockCommercialData())

    expect(screen.getByText('Planning Context')).toBeInTheDocument()
    // Default bufferWeeks=0, onboardingWeeks=0
    expect(screen.getAllByText('0').length).toBeGreaterThanOrEqual(1)
    expect(screen.getAllByText('Set in Timeline → Planning Settings')).toHaveLength(2)
  })

  it('shows actual onboarding and buffer weeks as read-only values', () => {
    render(
      <CommercialTab
        projectId="project-1"
        profile={{
          projectId: 'project-1',
          hoursPerDay: 8,
          projectDurationWeeks: 12,
          bufferWeeks: 2,
          onboardingWeeks: 3,
          resourceRows: [],
          overheadRows: [],
          summary: { totalHours: 0, totalDays: 0, totalCost: null, hasCost: false },
        } as any}
        project={{ id: 'project-1', name: 'Test', taxRate: null, taxLabel: '' } as any}
        rateCards={[]}
        commercialData={createMockCommercialData()}
        showDiscountForm={false}
        setShowDiscountForm={vi.fn()}
        discountForm={null}
        setDiscountForm={vi.fn()}
        discountFormError={null}
        selectedRateCardId={null}
        setSelectedRateCardId={vi.fn()}
        rateCardResult={null}
        editingTaxLabel={false}
        setEditingTaxLabel={vi.fn()}
        taxLabelDraft=""
        setTaxLabelDraft={vi.fn()}
        editingTaxRate={false}
        setEditingTaxRate={vi.fn()}
        taxRateDraft=""
        setTaxRateDraft={vi.fn()}
        bufferWeeks={2}
        onboardingWeeks={3}
        createDiscount={{ mutate: vi.fn() } as any}
        deleteDiscount={{ mutate: vi.fn() } as any}
        updateTax={{ mutate: vi.fn() } as any}
        applyRateCard={{ mutate: vi.fn() } as any}
        handleDiscountSubmit={vi.fn()}
        handleApplyRateCard={vi.fn()}
        getAllocationBadge={() => ({ label: 'T&M', color: 'bg-gray-100 text-gray-600', sub: null })}
        weekToDate={vi.fn(() => null)}
        fmtDate={vi.fn(() => '')}
        formatNumber={(value: number, fractionDigits = 2) => value.toFixed(fractionDigits)}
        filteredResourceRows={[]}
      />,
    )

    expect(screen.getByText('3')).toBeInTheDocument()
    expect(screen.getByText('2')).toBeInTheDocument()
    expect(screen.getByText('Planning Context')).toBeInTheDocument()
  })

  it('does not show editable Project Duration section with inputs and save', () => {
    renderTab(createMockCommercialData())

    expect(screen.queryByText('Project Duration')).not.toBeInTheDocument()
    expect(screen.queryByText('Weeks at project start for team onboarding (added to period)')).not.toBeInTheDocument()
    expect(screen.queryByText('Extra weeks added to project end date for contingency')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument()
  })
})
