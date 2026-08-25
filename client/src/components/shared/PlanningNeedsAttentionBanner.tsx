/**
 * PlanningNeedsAttentionBanner.tsx — Explicit NEEDS_REPLAN state (issue #449).
 *
 * Shown on planning surfaces when the project's planning state is
 * NEEDS_REPLAN. Explains that the resource planning is no longer current and
 * offers the single obvious **Replan project** action:
 *
 *   - the server validates the canonical planning state (complete replanning);
 *   - when valid, the project atomically returns to CURRENT and the banner
 *     disappears;
 *   - when incomplete, the server's actionable findings are shown inline and
 *     the user is routed into the existing Resource Profile surface to build
 *     the new plan (no wizard, no automatic defaults).
 *
 * The banner never fabricates capacity or clears the flag by itself — only
 * the server-side canonical validation completes replanning.
 */

import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useMutation, useQueryClient } from '@tanstack/react-query'

import {
  completeReplanning,
  apiErrorMessage,
  type ReplanIncompleteResponse,
} from '../../lib/api'
import { invalidateProjectPlanning } from '../../lib/projectInvalidation'

interface PlanningNeedsAttentionBannerProps {
  projectId: string
}

export default function PlanningNeedsAttentionBanner({ projectId }: PlanningNeedsAttentionBannerProps) {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [findings, setFindings] = useState<string[] | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  const completeMutation = useMutation({
    mutationFn: () => completeReplanning(projectId),
    onSuccess: () => {
      setFindings(null)
      setActionError(null)
      invalidateProjectPlanning(qc, projectId)
    },
    onError: (err: unknown) => {
      const data = (err as { response?: { data?: ReplanIncompleteResponse } })?.response?.data
      if (data?.code === 'REPLAN_INCOMPLETE') {
        setFindings(data.findings)
        setActionError(null)
      } else {
        setFindings(null)
        setActionError(apiErrorMessage(err, 'Could not complete replanning'))
      }
    },
  })

  return (
    <div
      className="rounded-xl border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/30 px-5 py-4"
      data-testid="planning-needs-attention"
    >
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="space-y-1.5">
          <h2 className="text-base font-semibold text-amber-900 dark:text-amber-200">
            Planning needs attention
          </h2>
          <p className="text-sm text-amber-800 dark:text-amber-300">
            This project&apos;s resource planning is no longer current. Review the resource
            inputs and replan from the existing backlog. The project and backlog remain fully
            accessible; planning actions are paused until replanning is complete.
          </p>
        </div>
        <button
          onClick={() => completeMutation.mutate()}
          disabled={completeMutation.isPending}
          className="shrink-0 bg-lab3-navy text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-lab3-blue transition-colors disabled:opacity-50"
          data-testid="replan-project-button"
        >
          {completeMutation.isPending ? 'Checking plan…' : 'Complete replan'}
        </button>
      </div>

      {findings && findings.length > 0 && (
        <div className="mt-3 rounded-lg bg-white dark:bg-gray-800 border border-amber-200 dark:border-amber-800 px-4 py-3 space-y-2" data-testid="replan-incomplete-summary">
          <p className="text-sm font-medium text-amber-900 dark:text-amber-200">
            Replanning is not complete yet. This action validates the configured resource planning and returns the project to normal planning when all required inputs are ready.
          </p>
          <p className="text-xs text-amber-800 dark:text-amber-300">
            {findings.filter(finding => finding.startsWith('Named resource "')).length > 0
              ? `${findings.filter(finding => finding.startsWith('Named resource "')).length} named resource${findings.filter(finding => finding.startsWith('Named resource "')).length === 1 ? '' : 's'} still need availability.`
              : `${findings.length} planning input${findings.length === 1 ? '' : 's'} still need attention.`}
          </p>
          <button
            onClick={() => navigate(`/projects/${projectId}/resource-profile`)}
            className="text-xs font-medium text-lab3-navy dark:text-lab3-blue underline hover:text-lab3-blue dark:hover:text-lab3-blue"
          >
            Review recovery actions in Resource Profile
          </button>
        </div>
      )}

      {actionError && (
        <p role="alert" className="mt-3 text-sm text-red-700 dark:text-red-400">
          {actionError}
        </p>
      )}
    </div>
  )
}
