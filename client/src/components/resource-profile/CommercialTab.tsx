import { Fragment } from 'react'
import type { UseResourceProfileReturn } from '../../hooks/useResourceProfile'

interface Props extends UseResourceProfileReturn {
  projectId: string
}

export default function CommercialTab({
  profile, project, rateCards, commercialData,
  showDiscountForm, setShowDiscountForm,
  discountForm, setDiscountForm, discountFormError,
  selectedRateCardId, setSelectedRateCardId, rateCardResult,
  editingTaxLabel, setEditingTaxLabel, taxLabelDraft, setTaxLabelDraft,
  editingTaxRate, setEditingTaxRate, taxRateDraft, setTaxRateDraft,
  editingAllocation, setEditingAllocation, allocationDraft, setAllocationDraft,
  bufferWeeks, setBufferWeeks, onboardingWeeks, setOnboardingWeeks,
  createDiscount, deleteDiscount, updateTax, applyRateCard,
  updateAllocationMutation, updateNrAllocationMutation,
  handleDiscountSubmit, handleApplyRateCard, startEditAllocation, getAllocationBadge,
  weekToDate, fmtDate, formatNumber, saveBufferOnboarding,
  filteredResourceRows,
}: Props) {
  return (
    <>
    {/* ── Apply Rate Card ── */}
    <section className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-6 space-y-4">
      <div>
        <h2 className="text-base font-semibold text-gray-900 dark:text-white">Apply Rate Card</h2>
        <p className="text-sm text-gray-500 dark:text-gray-400">Select a rate card to bulk-apply day rates to matching resource types.</p>
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex-1 min-w-[200px]">
          <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Rate Card</label>
          <select value={selectedRateCardId} onChange={e => { setSelectedRateCardId(e.target.value); }}
            className="w-full border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-lab3-blue">
            <option value="">Select a rate card…</option>
            {rateCards.map(rc => <option key={rc.id} value={rc.id}>{rc.name} (v{rc.version})</option>)}
          </select>
        </div>
        <button onClick={handleApplyRateCard} disabled={!selectedRateCardId || applyRateCard.isPending}
          className="bg-lab3-navy text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-lab3-blue disabled:opacity-50">
          {applyRateCard.isPending ? 'Applying…' : 'Apply'}
        </button>
      </div>
      {rateCardResult && (
        <p className="text-sm text-green-700 bg-green-50 border border-green-200 rounded-lg px-4 py-2">
          ✓ {rateCardResult.updated} rate{rateCardResult.updated !== 1 ? 's' : ''} updated
          {rateCardResult.skipped > 0 && `, ${rateCardResult.skipped} skipped`}
        </p>
      )}
    </section>

    {/* ── Project Duration ── */}
    <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-4 mb-4">
      <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-3">Project Duration</h3>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="text-xs text-gray-500 dark:text-gray-400 block mb-1">Onboarding Weeks</label>
          <input type="number" min={0} value={onboardingWeeks} onChange={e => setOnboardingWeeks(Number(e.target.value))}
            className="w-full border border-gray-200 dark:border-gray-600 rounded px-2 py-1 text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100" />
          <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">Weeks at project start for team onboarding (added to period)</p>
        </div>
        <div>
          <label className="text-xs text-gray-500 dark:text-gray-400 block mb-1">Buffer Weeks</label>
          <input type="number" min={0} value={bufferWeeks} onChange={e => setBufferWeeks(Number(e.target.value))}
            className="w-full border border-gray-200 dark:border-gray-600 rounded px-2 py-1 text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100" />
          <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">Extra weeks added to project end date for contingency</p>
        </div>
      </div>
      <div className="mt-3 flex justify-end">
        <button onClick={saveBufferOnboarding} className="bg-lab3-navy text-white px-4 py-1.5 rounded-lg text-sm font-medium hover:bg-lab3-blue">Save</button>
      </div>
    </div>

    {/* ── Unrated resources warning ── */}
    {(() => {
      const unratedResources = filteredResourceRows.filter(r => r.dayRate == null)
      const unratedOverhead = (profile?.overheadRows ?? []).filter(r => r.dayRate == null && r.computedDays > 0)
      const unratedOverheadNames = unratedOverhead
        .map(r => r.resourceTypeName ?? r.name)
        .filter(name => !unratedResources.some(r => r.name === name))
      const allUnratedNames = [
        ...unratedResources.map(r => r.name),
        ...unratedOverheadNames,
      ]
      if (allUnratedNames.length === 0) return null
      return (
        <div className="mb-4 bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-lg p-3 flex items-start gap-2">
          <span className="text-yellow-500 mt-0.5">⚠️</span>
          <div>
            <p className="text-sm font-medium text-yellow-800 dark:text-yellow-300">
              {allUnratedNames.length} resource type{allUnratedNames.length !== 1 ? 's' : ''} have no rate applied and are excluded from cost calculations.
            </p>
            <p className="text-xs text-yellow-700 dark:text-yellow-400 mt-0.5">
              Missing rates: {allUnratedNames.join(', ')}
            </p>
          </div>
        </div>
      )
    })()}

    {/* ── Cost Summary Table ── */}
    <section className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700">
      <header className="px-6 py-4 border-b border-gray-100 dark:border-gray-700">
        <h2 className="text-base font-semibold text-gray-900 dark:text-white">Cost Summary</h2>
        <p className="text-sm text-gray-500 dark:text-gray-400">Breakdown by resource type with day rates and discounts</p>
      </header>
      {!commercialData || commercialData.rows.length === 0 ? (
        <div className="py-12 text-center text-gray-400 dark:text-gray-500">
          <p className="text-lg mb-1">No costed resources.</p>
          <p className="text-sm">Assign day rates to resource types to see the cost summary.</p>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="bg-gray-50 dark:bg-gray-700 text-gray-600 dark:text-gray-400 border-b border-gray-200 dark:border-gray-700">
                <th className="text-left px-6 py-3 font-medium">Resource Type</th>
                <th className="text-center px-4 py-3 font-medium">Count</th>
                <th className="text-right px-4 py-3 font-medium">Effort Days</th>
                <th className="text-left px-4 py-3 font-medium">Allocation</th>
                <th className="text-left px-4 py-3 font-medium">Period</th>
                <th className="text-right px-4 py-3 font-medium">Allocated Days</th>
                <th className="text-right px-4 py-3 font-medium">Day Rate</th>
                <th className="text-right px-6 py-3 font-medium">Subtotal</th>
              </tr>
            </thead>
            <tbody>
              {commercialData.rows.map(row => (
                <Fragment key={row.id}>
                  <tr className={`border-b border-gray-100 dark:border-gray-700 ${row.kind === 'named-resource' ? 'bg-gray-50 dark:bg-gray-900' : ''}`}>
                    <td className="px-6 py-3 text-gray-900 dark:text-white font-medium">
                      {row.name}
                      {row.kind === 'overhead' && <span className="text-xs text-amber-600 ml-2">(overhead)</span>}
                      {row.kind === 'named-resource' && <span className="text-xs text-blue-500 ml-2">(person)</span>}
                    </td>
                    <td className="text-center px-4 py-3 text-gray-800 dark:text-gray-100">{row.count}</td>
                    <td className="text-right px-4 py-3 text-gray-500 dark:text-gray-400">{formatNumber(row.effortDays)}</td>
                    <td className="px-4 py-3">
                      {(row.kind === 'resource' || row.kind === 'named-resource') ? (() => {
                        const badge = getAllocationBadge(row)
                        const isAggregate = row.allocationMode === 'AGGREGATE'
                        if (isAggregate) return <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${badge.color}`}>{badge.label}</span>
                        return (
                          <div>
                            <button onClick={() => editingAllocation === row.id ? setEditingAllocation(null) : startEditAllocation(row)}
                              className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${badge.color} hover:opacity-80 transition-opacity`} title="Click to edit allocation">
                              {badge.label}
                            </button>
                            {badge.sub && <div className="text-xs text-gray-400 dark:text-gray-500 mt-0.5">{badge.sub}</div>}
                          </div>
                        )
                      })() : <span className="text-gray-400 dark:text-gray-500 text-xs">—</span>}
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-500 dark:text-gray-400 whitespace-nowrap">
                      {(row.kind === 'resource' || row.kind === 'named-resource') && row.allocationMode !== 'AGGREGATE' ? (() => {
                        let startWk: number | null
                        let endWk: number | null
                        if (row.allocationMode === 'FULL_PROJECT') { startWk = 0; endWk = profile?.projectDurationWeeks ?? null }
                        else { startWk = row.allocationStartWeek ?? row.derivedStartWeek; endWk = row.allocationEndWeek ?? row.derivedEndWeek }
                        const start = weekToDate(startWk); const end = weekToDate(endWk)
                        if (start && end) return `${fmtDate(start)} – ${fmtDate(end)}`
                        if (startWk != null && endWk != null) return `Wk ${Math.floor(startWk)} – Wk ${Math.floor(endWk)}`
                        return '—'
                      })() : '—'}
                    </td>
                    <td className="text-right px-4 py-3 text-gray-900 dark:text-white font-medium">{formatNumber(row.allocatedDays)}</td>
                    <td className="text-right px-4 py-3 text-gray-800 dark:text-gray-100">${formatNumber(row.dayRate, 0)}</td>
                    <td className="text-right px-6 py-3 text-gray-900 dark:text-white">${formatNumber(row.subtotal, 0)}</td>
                  </tr>
                  {editingAllocation === row.id && allocationDraft && (row.kind === 'resource' || row.kind === 'named-resource') && row.allocationMode !== 'AGGREGATE' && (
                    <tr className="border-b border-blue-100 dark:border-blue-900 bg-blue-50 dark:bg-blue-950/30">
                      <td colSpan={8} className="px-6 py-4">
                        <div className="flex flex-wrap items-end gap-4">
                          <div>
                            <label className="block text-xs font-medium text-gray-600 dark:text-gray-300 mb-1">Allocation Mode</label>
                            <select value={allocationDraft.allocationMode} onChange={e => setAllocationDraft(d => d ? { ...d, allocationMode: e.target.value } : d)}
                              className="border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-1.5 text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500">
                              <option value="EFFORT">T&M (effort only)</option>
                              <option value="TIMELINE">Timeline window</option>
                              <option value="FULL_PROJECT">Full project</option>
                              <option value="CAPACITY_PLAN">Capacity Plan</option>
                            </select>
                          </div>
                          <div>
                            <label className="block text-xs font-medium text-gray-600 dark:text-gray-300 mb-1">FTE %</label>
                            <input type="number" min={1} max={100} step={5} value={allocationDraft.allocationPercent}
                              onChange={e => setAllocationDraft(d => d ? { ...d, allocationPercent: Number(e.target.value) } : d)}
                              className="w-20 border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-1.5 text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500" />
                          </div>
                          {allocationDraft.allocationMode === 'TIMELINE' && (
                            <>
                              <div>
                                <label className="block text-xs font-medium text-gray-600 dark:text-gray-300 mb-1">
                                  Start Week override
                                  {row.derivedStartWeek != null && <span className="text-gray-400 dark:text-gray-500 ml-1">(auto: Wk {Math.floor(row.derivedStartWeek)})</span>}
                                </label>
                                <input type="number" min={0} step={0.5} value={allocationDraft.allocationStartWeek ?? ''} placeholder="auto"
                                  onChange={e => setAllocationDraft(d => d ? { ...d, allocationStartWeek: e.target.value === '' ? null : Number(e.target.value) } : d)}
                                  className="w-24 border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-1.5 text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500" />
                              </div>
                              <div>
                                <label className="block text-xs font-medium text-gray-600 dark:text-gray-300 mb-1">
                                  End Week override
                                  {row.derivedEndWeek != null && <span className="text-gray-400 dark:text-gray-500 ml-1">(auto: Wk {Math.floor(row.derivedEndWeek)})</span>}
                                </label>
                                <input type="number" min={0} step={0.5} value={allocationDraft.allocationEndWeek ?? ''} placeholder="auto"
                                  onChange={e => setAllocationDraft(d => d ? { ...d, allocationEndWeek: e.target.value === '' ? null : Number(e.target.value) } : d)}
                                  className="w-24 border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-1.5 text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500" />
                              </div>
                            </>
                          )}
                          <div className="flex gap-2 ml-auto">
                            <button onClick={() => {
                              if (row.kind === 'named-resource') {
                                updateNrAllocationMutation.mutate({ rtId: row.resourceTypeId, nrId: row.id, data: { allocationMode: allocationDraft.allocationMode, allocationPercent: allocationDraft.allocationPercent, allocationStartWeek: allocationDraft.allocationStartWeek, allocationEndWeek: allocationDraft.allocationEndWeek } })
                              } else {
                                updateAllocationMutation.mutate({ rtId: row.id, data: { allocationMode: allocationDraft.allocationMode, allocationPercent: allocationDraft.allocationPercent, allocationStartWeek: allocationDraft.allocationStartWeek, allocationEndWeek: allocationDraft.allocationEndWeek } })
                              }
                            }} disabled={updateAllocationMutation.isPending || updateNrAllocationMutation.isPending}
                              className="bg-blue-600 text-white px-4 py-1.5 rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50" data-testid="allocation-save">
                              {(updateAllocationMutation.isPending || updateNrAllocationMutation.isPending) ? 'Saving…' : 'Save'}
                            </button>
                            <button onClick={() => { setEditingAllocation(null); setAllocationDraft(null) }}
                              className="px-4 py-1.5 rounded-lg text-sm text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700" data-testid="allocation-cancel">
                              Cancel
                            </button>
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}
                  {row.appliedDiscounts.map(d => (
                    <tr key={d.id} className="border-b border-gray-50 bg-gray-50 dark:bg-gray-700">
                      <td className="px-6 py-2 pl-10 text-gray-500 dark:text-gray-400 italic text-xs" colSpan={7}>
                        ↳ {d.label} ({d.type === 'PERCENTAGE' ? `${d.value}%` : `$${formatNumber(d.value, 0)}`})
                      </td>
                      <td className="text-right px-6 py-2 text-red-600 text-xs italic">−${formatNumber(d.calculatedAmount, 0)}</td>
                    </tr>
                  ))}
                  {row.appliedDiscounts.length > 0 && (
                    <tr className="border-b border-gray-100 dark:border-gray-700 bg-gray-50 dark:bg-gray-700">
                      <td className="px-6 py-2 pl-10 text-gray-600 dark:text-gray-400 text-xs font-medium" colSpan={7}>Net subtotal</td>
                      <td className="text-right px-6 py-2 text-gray-900 dark:text-white text-xs font-medium">${formatNumber(row.netSubtotal, 0)}</td>
                    </tr>
                  )}
                </Fragment>
              ))}
              <tr className="bg-gray-900 text-white font-semibold">
                <td className="px-6 py-3 uppercase tracking-wide" colSpan={7}>Subtotal</td>
                <td className="text-right px-6 py-3">${formatNumber(commercialData.subtotal, 0)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </section>

    {/* ── Project Discounts ── */}
    <section className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-6 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold text-gray-900 dark:text-white">Project Discounts</h2>
          <p className="text-sm text-gray-500 dark:text-gray-400">Discounts applied to the overall project subtotal</p>
        </div>
      </div>
      {commercialData && commercialData.projectDiscounts.length === 0 && !showDiscountForm && (
        <p className="text-sm text-gray-500 dark:text-gray-400">No project-level discounts yet.</p>
      )}
      {commercialData && commercialData.projectDiscounts.length > 0 && (
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="bg-gray-50 dark:bg-gray-700 text-gray-600 dark:text-gray-400 border-b border-gray-200 dark:border-gray-700">
                <th className="text-left px-4 py-2 font-medium">Label</th>
                <th className="text-left px-4 py-2 font-medium">Type</th>
                <th className="text-right px-4 py-2 font-medium">Value</th>
                <th className="text-right px-4 py-2 font-medium">Amount</th>
                <th className="px-4 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {commercialData.projectDiscounts.map(d => (
                <tr key={d.id} className="border-b border-gray-100 dark:border-gray-700">
                  <td className="px-4 py-2 text-gray-900 dark:text-white">{d.label}</td>
                  <td className="px-4 py-2 text-gray-600 dark:text-gray-400">{d.type === 'PERCENTAGE' ? 'Percentage' : 'Fixed Amount'}</td>
                  <td className="text-right px-4 py-2 text-gray-800 dark:text-gray-100">{d.type === 'PERCENTAGE' ? `${d.value}%` : `$${formatNumber(d.value, 0)}`}</td>
                  <td className="text-right px-4 py-2 text-red-600 font-medium">−${formatNumber(d.calculatedAmount, 0)}</td>
                  <td className="px-4 py-2 text-right">
                    <button onClick={() => { if (confirm('Delete this discount?')) deleteDiscount.mutate(d.id) }}
                      className="text-red-600 hover:text-red-800 text-xs font-medium">Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {showDiscountForm ? (
        <div className="border border-dashed border-gray-300 rounded-lg p-4 space-y-3">
          <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Add project discount</h3>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Label</label>
              <input type="text" value={discountForm.label} onChange={e => setDiscountForm(f => ({ ...f, label: e.target.value }))} placeholder="e.g. Early bird"
                className="w-full border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-lab3-blue" />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Type</label>
              <select value={discountForm.type} onChange={e => setDiscountForm(f => ({ ...f, type: e.target.value as 'PERCENTAGE' | 'FIXED_AMOUNT' }))}
                className="w-full border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-lab3-blue">
                <option value="PERCENTAGE">Percentage</option>
                <option value="FIXED_AMOUNT">Fixed Amount</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">{discountForm.type === 'PERCENTAGE' ? 'Percentage (%)' : 'Amount ($)'}</label>
              <input type="number" min={0} step={discountForm.type === 'PERCENTAGE' ? 0.5 : 1} value={discountForm.value}
                onChange={e => setDiscountForm(f => ({ ...f, value: e.target.value }))}
                className="w-full border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-lab3-blue" />
            </div>
          </div>
          {discountFormError && <p className="text-sm text-red-600">{discountFormError}</p>}
          <div className="flex gap-2">
            <button onClick={handleDiscountSubmit} disabled={createDiscount.isPending}
              className="bg-lab3-navy text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-lab3-blue disabled:opacity-50">
              {createDiscount.isPending ? 'Adding…' : 'Add discount'}
            </button>
            <button onClick={() => { setShowDiscountForm(false); }}
              className="px-4 py-2 rounded-lg text-sm text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700">Cancel</button>
          </div>
        </div>
      ) : (
        <button onClick={() => setShowDiscountForm(true)} className="text-sm text-red-600 hover:text-red-800 font-medium">+ Add Discount</button>
      )}
    </section>

    {/* ── Tax ── */}
    <section className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-6 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold text-gray-900 dark:text-white">Tax</h2>
          <p className="text-sm text-gray-500 dark:text-gray-400">Apply tax to the after-discount total</p>
        </div>
        <label className="flex items-center gap-2 cursor-pointer">
          <input type="checkbox" checked={commercialData?.taxEnabled ?? false}
            onChange={e => { if (e.target.checked) updateTax.mutate({ taxRate: 10, taxLabel: project?.taxLabel ?? 'GST' }); else updateTax.mutate({ taxRate: null }) }}
            className="h-4 w-4 rounded border-gray-300 dark:border-gray-600 text-lab3-navy focus:ring-lab3-blue dark:bg-gray-700 dark:text-white" />
          <span className="text-sm text-gray-600 dark:text-gray-400">Enable tax</span>
        </label>
      </div>
      {commercialData?.taxEnabled && (
        <div className="flex flex-wrap items-center gap-6 border border-gray-100 dark:border-gray-700 rounded-lg px-4 py-3">
          <div className="flex items-center gap-2">
            <span className="text-sm text-gray-500 dark:text-gray-400">Label:</span>
            {editingTaxLabel ? (
              <div className="flex items-center gap-1">
                <input type="text" value={taxLabelDraft} onChange={e => setTaxLabelDraft(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') { updateTax.mutate({ taxLabel: taxLabelDraft.trim() || 'GST' }); setEditingTaxLabel(false) } }}
                  className="border border-gray-300 dark:border-gray-600 rounded px-2 py-1 text-sm w-24 bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:outline-none focus:ring-1 focus:ring-lab3-blue" autoFocus />
                <button onClick={() => { updateTax.mutate({ taxLabel: taxLabelDraft.trim() || 'GST' }); setEditingTaxLabel(false) }} className="text-xs text-red-600 hover:text-red-800 font-medium">Save</button>
                <button onClick={() => setEditingTaxLabel(false)} className="text-xs text-gray-500 dark:text-gray-400 hover:text-gray-700">Cancel</button>
              </div>
            ) : (
              <button onClick={() => { setTaxLabelDraft(commercialData.taxLabel); setEditingTaxLabel(true) }}
                className="text-sm font-medium text-gray-900 dark:text-white hover:text-lab3-navy transition-colors">{commercialData.taxLabel}</button>
            )}
          </div>
          <div className="flex items-center gap-2">
            <span className="text-sm text-gray-500 dark:text-gray-400">Rate:</span>
            {editingTaxRate ? (
              <div className="flex items-center gap-1">
                <input type="number" min={0} step={0.5} value={taxRateDraft} onChange={e => setTaxRateDraft(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') { const val = parseFloat(taxRateDraft); if (!Number.isNaN(val) && val >= 0) { updateTax.mutate({ taxRate: val }); setEditingTaxRate(false) } } }}
                  className="border border-gray-300 dark:border-gray-600 rounded px-2 py-1 text-sm w-20 bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:outline-none focus:ring-1 focus:ring-lab3-blue" autoFocus />
                <span className="text-sm text-gray-500 dark:text-gray-400">%</span>
                <button onClick={() => { const val = parseFloat(taxRateDraft); if (!Number.isNaN(val) && val >= 0) { updateTax.mutate({ taxRate: val }); setEditingTaxRate(false) } }} className="text-xs text-red-600 hover:text-red-800 font-medium">Save</button>
                <button onClick={() => setEditingTaxRate(false)} className="text-xs text-gray-500 dark:text-gray-400 hover:text-gray-700">Cancel</button>
              </div>
            ) : (
              <button onClick={() => { setTaxRateDraft(String(commercialData.taxRate ?? 10)); setEditingTaxRate(true) }}
                className="text-sm font-medium text-gray-900 dark:text-white hover:text-lab3-navy transition-colors">{commercialData.taxRate}%</button>
            )}
          </div>
          <div className="flex items-center gap-2 ml-auto">
            <span className="text-sm text-gray-500 dark:text-gray-400">Tax amount:</span>
            <span className="text-sm font-medium text-gray-900 dark:text-white">${formatNumber(commercialData.taxAmount, 0)}</span>
          </div>
        </div>
      )}
    </section>

    {/* ── Grand Total ── */}
    {commercialData && commercialData.rows.length > 0 && (
      <section className="bg-gray-900 rounded-xl p-6">
        <div className="flex items-center justify-between flex-wrap gap-4">
          <div className="space-y-1">
            <div className="text-sm text-gray-400 dark:text-gray-500">
              Subtotal: ${formatNumber(commercialData.subtotal, 0)}
              {commercialData.totalProjectDiscount > 0 && <span> − Discounts: ${formatNumber(commercialData.totalProjectDiscount, 0)}</span>}
              {commercialData.taxEnabled && <span> + {commercialData.taxLabel}: ${formatNumber(commercialData.taxAmount, 0)}</span>}
            </div>
          </div>
          <div className="text-right">
            <p className="text-sm text-gray-400 dark:text-gray-500 uppercase tracking-wide">Grand Total</p>
            <p className="text-3xl font-bold text-white">${formatNumber(commercialData.grandTotal, 0)}</p>
          </div>
        </div>
      </section>
    )}
    </>
  )
}
