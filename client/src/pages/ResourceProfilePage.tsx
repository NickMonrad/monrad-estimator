import { useRef, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import AppLayout from '../components/layout/AppLayout'
import { useResourceProfile, formatNumber } from '../hooks/useResourceProfile'
import ResourceProfileTab from '../components/resource-profile/ResourceProfileTab'
import CommercialTab from '../components/resource-profile/CommercialTab'
import PlanningNeedsAttentionBanner from '../components/shared/PlanningNeedsAttentionBanner'
import { resetProjectPlanning, apiErrorMessage } from '../lib/api'
import { invalidateProjectAll } from '../lib/projectInvalidation'

export default function ResourceProfilePage() {
  const state = useResourceProfile()
  const {
    projectId, project, profile,
    activeTab, setActiveTab,
    handleExportProfile, handleExportFull,
  } = state
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [resetConfirmOpen, setResetConfirmOpen] = useState(false)
  const [resetFeedback, setResetFeedback] = useState<string | null>(null)

  const needsReplan = profile?.planningState === 'NEEDS_REPLAN' || project?.planningState === 'NEEDS_REPLAN'

  const resetMutation = useMutation({
    mutationFn: () => resetProjectPlanning(projectId!),
    onSuccess: () => {
      setResetConfirmOpen(false)
      setResetFeedback('Planning reset — the project now needs replanning. Build the new plan from the existing backlog.')
      invalidateProjectAll(qc, projectId)
    },
    onError: (err: unknown) => {
      setResetConfirmOpen(false)
      setResetFeedback(apiErrorMessage(err, 'Reset planning failed'))
    },
  })

  if (!projectId) return null

  return (
    <AppLayout
      breadcrumb={
        <>
          <span>/</span>
          <button onClick={() => navigate(`/projects/${projectId}`)} className="hover:text-lab3-navy dark:hover:text-lab3-blue transition-colors">
            {project?.name ?? '…'}
          </button>
          <span>/</span>
          <span className="text-gray-700 dark:text-gray-300">Resource Profile</span>
        </>
      }
    >
      <main className="max-w-6xl mx-auto px-6 py-8 space-y-6">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <h1 className="text-xl font-semibold text-gray-900 dark:text-white">Resource Profile</h1>
            {profile && (
              <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
                Total {formatNumber(profile.summary.totalHours)}h · {formatNumber(profile.summary.totalDays)} days
                {profile.summary.totalCost != null && ` · $${formatNumber(profile.summary.totalCost, 0)}`}
              </p>
            )}
            {(project?.bufferWeeks ?? 0) > 0 && (
              <p className="text-xs text-amber-600 font-medium mt-1">
                + {project!.bufferWeeks} buffer week{project!.bufferWeeks !== 1 ? 's' : ''} applied
              </p>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            {!needsReplan && (
              <button
                onClick={() => setResetConfirmOpen(true)}
                className="border border-red-300 text-red-700 dark:text-red-300 dark:border-red-800 px-4 py-2 rounded-lg text-sm font-medium hover:bg-red-50 dark:hover:bg-red-950 transition-colors"
              >
                Reset planning…
              </button>
            )}
            <button
              onClick={handleExportProfile}
              disabled={!profile}
              className="border border-gray-300 text-gray-700 dark:text-gray-300 px-4 py-2 rounded-lg text-sm font-medium hover:bg-gray-100 dark:hover:bg-gray-700 disabled:opacity-50"
            >
              ⬇ Export Resource Profile
            </button>
            <button
              onClick={handleExportFull}
              disabled={!profile}
              className="bg-lab3-navy text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-lab3-blue disabled:opacity-50"
            >
              ⬇ Export Full Project
            </button>
          </div>
        </div>

        {resetFeedback && (
          <div className="rounded-xl border border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-950/30 px-4 py-3 text-sm text-blue-800 dark:text-blue-300" role="status" data-testid="reset-feedback">
            {resetFeedback}
          </div>
        )}

        {needsReplan && <PlanningNeedsAttentionBanner projectId={projectId} />}

        {/* ── Tab bar ── */}
        <div className="border-b border-gray-200 dark:border-gray-700">
          <nav className="flex gap-6">
            <button
              onClick={() => setActiveTab('profile')}
              className={`pb-2 text-sm font-medium transition-colors ${
                activeTab === 'profile'
                  ? 'border-b-2 border-lab3-navy text-lab3-navy dark:border-lab3-blue dark:text-lab3-blue'
                  : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'
              }`}
            >
              Resource Profile
            </button>
            <button
              onClick={() => setActiveTab('commercial')}
              className={`pb-2 text-sm font-medium transition-colors ${
                activeTab === 'commercial'
                  ? 'border-b-2 border-lab3-navy text-lab3-navy dark:border-lab3-blue dark:text-lab3-blue'
                  : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'
              }`}
            >
              Commercial
            </button>
          </nav>
        </div>

        {activeTab === 'profile' && <ResourceProfileTab {...state} projectId={projectId} />}
        {activeTab === 'commercial' && (needsReplan
          ? (
            <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-8 text-center">
              <h2 className="text-base font-semibold text-gray-900 dark:text-white mb-2">Commercial totals need a current plan</h2>
              <p className="text-sm text-gray-500 dark:text-gray-400 max-w-md mx-auto">
                This project&apos;s resource planning is no longer current. Replan from the
                existing backlog first; commercial totals will be calculated once the project
                is current again.
              </p>
            </div>
          )
          : <CommercialTab {...state} projectId={projectId} />)}

        {resetConfirmOpen && (
          <ResetPlanningConfirmDialog
            isPending={resetMutation.isPending}
            error={resetMutation.isError ? apiErrorMessage(resetMutation.error, 'Reset planning failed') : null}
            onConfirm={() => resetMutation.mutate()}
            onCancel={() => { if (!resetMutation.isPending) setResetConfirmOpen(false) }}
          />
        )}
      </main>
    </AppLayout>
  )
}

// ─── Reset Planning confirmation dialog (full focus/keyboard lifecycle) ────

interface ResetPlanningConfirmDialogProps {
  isPending: boolean
  error: string | null
  onConfirm: () => void
  onCancel: () => void
}

function ResetPlanningConfirmDialog({
  isPending,
  error,
  onConfirm,
  onCancel,
}: ResetPlanningConfirmDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null)
  const confirmRef = useRef<HTMLButtonElement>(null)
  const previouslyFocused = useRef<HTMLElement | null>(null)

  useEffect(() => {
    previouslyFocused.current = document.activeElement as HTMLElement | null
    confirmRef.current?.focus()
  }, [])

  useEffect(() => {
    return () => {
      previouslyFocused.current?.focus()
    }
  }, [])

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Escape' && !isPending) {
      onCancel()
      return
    }
    if (e.key === 'Tab') {
      const dialog = dialogRef.current
      if (!dialog) return
      const focusable = dialog.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      )
      const firstFocusable = focusable[0]
      const lastFocusable = focusable[focusable.length - 1]
      if (e.shiftKey) {
        if (document.activeElement === firstFocusable) {
          e.preventDefault()
          lastFocusable?.focus()
        }
      } else {
        if (document.activeElement === lastFocusable) {
          e.preventDefault()
          firstFocusable?.focus()
        }
      }
    }
  }

  function handleBackdropClick(e: React.MouseEvent) {
    if (isPending) return
    if (e.target === e.currentTarget) {
      onCancel()
    }
  }

  return (
    <div
      ref={dialogRef}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={handleBackdropClick}
      onKeyDown={handleKeyDown}
      role="dialog"
      aria-modal="true"
      aria-labelledby="reset-planning-dialog-title"
    >
      <div className="bg-white dark:bg-gray-800 rounded-xl shadow-xl border border-gray-200 dark:border-gray-700 w-full max-w-md mx-4 p-6">
        <h3 id="reset-planning-dialog-title" className="text-base font-semibold text-gray-900 dark:text-white mb-2">
          Reset planning?
        </h3>
        <div className="text-sm text-gray-600 dark:text-gray-400 space-y-2">
          <p>
            Reset planning discards this project&apos;s current resource/capacity planning and
            generated schedule.
          </p>
          <ul className="list-disc pl-5 space-y-1">
            <li>The project, backlog, effort estimates and dependencies are kept.</li>
            <li>Business and commercial data — rates, discounts, tax, billing basis — are kept.</li>
            <li>Capacity profiles, capacity plans, planned resources and schedule output are removed.</li>
            <li>The project must then be replanned from the existing backlog.</li>
          </ul>
        </div>
        <div className="flex items-center justify-end gap-3 mt-6">
          <button
            onClick={onCancel}
            disabled={isPending}
            className="px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 bg-gray-100 dark:bg-gray-700 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            ref={confirmRef}
            onClick={onConfirm}
            disabled={isPending}
            className="px-4 py-2 text-sm font-medium text-white bg-red-600 rounded-lg hover:bg-red-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isPending ? 'Resetting…' : 'Reset planning'}
          </button>
        </div>
        {error && (
          <p className="mt-3 text-sm text-red-600 dark:text-red-400" role="alert">
            Error: {error}
          </p>
        )}
      </div>
    </div>
  )
}
