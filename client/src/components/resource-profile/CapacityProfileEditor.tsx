/**
 * CapacityProfileEditor.tsx — Reusable capacity profile editor for the
 * Resource Profile page.
 *
 * Supports all four planning basis modes (demandFollowing,
 * wholeProjectAllocation, availabilityWindow, capacityProfile) as well as
 * read-only and squad-planner-managed views.
 *
 * @see issue #363 — Capacity profile segment editor
 */

import { useState, type FormEvent } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { invalidateProjectResourceProfile } from '../../lib/projectInvalidation'
import { formatPlanningBasis } from '../../lib/capacityProfileFormatting'
import type { CapacityProfilePlanningBasis } from '../../types/backlog'
import type { AxiosError } from 'axios'

/** Map client PlanningBasis values to server UPPER_SNAKE_CASE contract. */
const PLANNING_BASIS_TO_SERVER: Record<string, string> = {
  demandFollowing: 'DEMAND_FOLLOWING',
  wholeProjectAllocation: 'WHOLE_PROJECT_ALLOCATION',
  availabilityWindow: 'AVAILABILITY_WINDOW',
  capacityProfile: 'CAPACITY_PROFILE',
}

interface SegmentInput {
  startWeek: number
  endWeek: number
  capacityPercent: number
}

interface EditorProfile {
  planningBasis: CapacityProfilePlanningBasis
  defaultPercent: number | null
  startWeek: number | null
  endWeek: number | null
  segments: SegmentInput[]
  source?: string
}

// ─── Props ──────────────────────────────────────────────────────────────────

export interface CapacityProfileEditorProps {
  /** Existing profile data; null/undefined means create mode (defaults to demandFollowing). */
  initialProfile?: EditorProfile | null
  ownerKind: 'ROLE' | 'NAMED_PERSON'
  ownerId: string
  projectId: string
  onSaved: () => void
  onCancel: () => void
  readOnly?: boolean
  plannerSquadLink?: string
}

// ─── Planning basis options ─────────────────────────────────────────────────

const PLANNING_BASIS_OPTIONS: Array<{ value: CapacityProfilePlanningBasis; label: string }> = [
  { value: 'demandFollowing', label: 'As needed' },
  { value: 'wholeProjectAllocation', label: 'Fixed for whole project' },
  { value: 'availabilityWindow', label: 'Fixed for selected weeks' },
  { value: 'capacityProfile', label: 'Varies by week' },
]

// ─── Helpers ────────────────────────────────────────────────────────────────

function emptySegment(): SegmentInput {
  return { startWeek: 0, endWeek: 0, capacityPercent: 100 }
}

interface CapacityProfileValidationDraft {
  planningBasis: CapacityProfilePlanningBasis
  defaultPercent: number | null
  startWeek: number | null
  endWeek: number | null
  segments: SegmentInput[]
}

function validatePercentage(value: number | null, label: string, ownerKind: 'ROLE' | 'NAMED_PERSON') {
  if (value === null || !Number.isFinite(value) || value < 0) {
    return `${label} must be a finite non-negative number`
  }
  if (ownerKind === 'NAMED_PERSON' && value > 100) {
    return `${label} must be between 0 and 100`
  }
  return null
}

function validateWeek(value: number | null, label: string) {
  if (value === null || !Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
    return `${label} must be a finite non-negative integer`
  }
  return null
}

export function validateCapacityProfileDraft(
  draft: CapacityProfileValidationDraft,
  ownerKind: 'ROLE' | 'NAMED_PERSON',
): string | null {
  if (draft.planningBasis !== 'capacityProfile') {
    const percentageError = validatePercentage(draft.defaultPercent, 'Default percent', ownerKind)
    if (percentageError) return percentageError

    if (draft.planningBasis === 'availabilityWindow') {
      const startError = validateWeek(draft.startWeek, 'Start week')
      if (startError) return startError
      const endError = validateWeek(draft.endWeek, 'End week')
      if (endError) return endError
      if ((draft.startWeek as number) > (draft.endWeek as number)) {
        return 'Start week must be less than or equal to end week'
      }
    }
    return null
  }

  if (draft.segments.length === 0) return 'At least one segment is required'

  for (const [index, segment] of draft.segments.entries()) {
    const prefix = `Segment ${index + 1}`
    const startError = validateWeek(segment.startWeek, `${prefix} start week`)
    if (startError) return startError
    const endError = validateWeek(segment.endWeek, `${prefix} end week`)
    if (endError) return endError
    if (segment.startWeek > segment.endWeek) {
      return `${prefix}: start week must be ≤ end week`
    }
    const percentageError = validatePercentage(segment.capacityPercent, `${prefix} capacity percent`, ownerKind)
    if (percentageError) return percentageError
  }

  const ranges = new Set<string>()
  for (const segment of draft.segments) {
    const range = `${segment.startWeek}:${segment.endWeek}`
    if (ranges.has(range)) return 'Segment ranges must not be duplicated'
    ranges.add(range)
  }

  const ordered = [...draft.segments].sort((a, b) => a.startWeek - b.startWeek || a.endWeek - b.endWeek)
  for (let index = 1; index < ordered.length; index += 1) {
    if (ordered[index].startWeek <= ordered[index - 1].endWeek) {
      return 'Segment ranges must not overlap'
    }
  }

  return null
}

// ─── Component ──────────────────────────────────────────────────────────────

export default function CapacityProfileEditor({
  initialProfile,
  ownerKind,
  ownerId,
  projectId,
  onSaved,
  onCancel,
  readOnly = false,
  plannerSquadLink,
}: CapacityProfileEditorProps) {
  const qc = useQueryClient()

  const [planningBasis, setPlanningBasis] = useState<CapacityProfilePlanningBasis>(
    initialProfile?.planningBasis ?? 'demandFollowing',
  )
  const [defaultPercent, setDefaultPercent] = useState<number | null>(
    initialProfile?.defaultPercent ?? 100,
  )
  const [startWeek, setStartWeek] = useState<number | null>(
    initialProfile?.startWeek ?? null,
  )
  const [endWeek, setEndWeek] = useState<number | null>(
    initialProfile?.endWeek ?? null,
  )
  const [segments, setSegments] = useState<SegmentInput[]>(
    initialProfile?.segments && initialProfile.segments.length > 0
      ? initialProfile.segments.map(s => ({ ...s }))
      : [emptySegment()],
  )
  const [error, setError] = useState<string | null>(null)

  const saveMutation = useMutation({
    mutationFn: () =>
      api.put(
        `/projects/${projectId}/capacity-profiles/${ownerKind}/${ownerId}`,
        {
          planningBasis: PLANNING_BASIS_TO_SERVER[planningBasis] as string,
          defaultPercent: planningBasis === 'capacityProfile' ? null : defaultPercent,
          startWeek: planningBasis === 'availabilityWindow' ? startWeek : null,
          endWeek: planningBasis === 'availabilityWindow' ? endWeek : null,
          segments: planningBasis === 'capacityProfile' ? segments : undefined,
        },
      ),
    onSuccess: () => {
      invalidateProjectResourceProfile(qc, projectId)
      qc.invalidateQueries({ queryKey: ['capacity-profiles', projectId] })
      qc.invalidateQueries({ queryKey: ['timeline', projectId] })
      qc.invalidateQueries({ queryKey: ['commercial', projectId] })
      onSaved()
    },
    onError: (err: unknown) => {
      const axiosError = err as AxiosError<{ error?: string; details?: string[] }>
      const responseData = axiosError?.response?.data
      const serverMsg = responseData?.error ?? 'Failed to save capacity profile'
      const serverDetails = responseData?.details
      if (serverDetails && serverDetails.length > 0) {
        setError(serverMsg + ': ' + serverDetails.join('; '))
      } else {
        setError(serverMsg)
      }
    },
  })

  // ── Read-only / planner-managed display ──────────────────────────────

  if (readOnly || plannerSquadLink) {
    return (
      <div className="space-y-3 p-4">
        <div className="flex items-center gap-2 flex-wrap">
          {plannerSquadLink ? (
            <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-purple-100 dark:bg-purple-900 text-purple-700 dark:text-purple-300">
              Managed by Squad Planner
            </span>
          ) : initialProfile ? (
            <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-green-100 dark:bg-green-900 text-green-700 dark:text-green-300">
              {formatPlanningBasis(initialProfile.planningBasis)}
            </span>
          ) : null}
          {initialProfile?.source && (
            <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400 uppercase tracking-wide">
              {initialProfile.source}
            </span>
          )}
        </div>

        {initialProfile && initialProfile.planningBasis !== 'capacityProfile' && initialProfile.defaultPercent != null && (
          <div className="text-sm text-gray-700 dark:text-gray-300">
            <span className="font-medium text-gray-900 dark:text-white">{initialProfile.defaultPercent}%</span> availability
          </div>
        )}

        {initialProfile && initialProfile.planningBasis === 'availabilityWindow' && initialProfile.startWeek != null && initialProfile.endWeek != null && (
          <div className="text-sm text-gray-700 dark:text-gray-300">
            Window: <span className="font-medium">W{initialProfile.startWeek + 1} → W{initialProfile.endWeek + 1}</span>
          </div>
        )}

        {initialProfile && initialProfile.planningBasis === 'capacityProfile' && initialProfile.segments.length > 0 && (
          <div className="text-sm text-gray-700 dark:text-gray-300">
            <div className="font-medium mb-1 text-gray-900 dark:text-white">Weekly segments:</div>
            {initialProfile.segments.map((seg, i) => (
              <div key={i} className="text-xs text-gray-500 dark:text-gray-400 ml-2">
                W{seg.startWeek + 1} - W{seg.endWeek + 1}: {seg.capacityPercent}%
              </div>
            ))}
          </div>
        )}

        {plannerSquadLink && (
          <a
            href={plannerSquadLink}
            className="mt-2 inline-flex items-center rounded-lg bg-lab3-navy px-3 py-1 text-xs font-medium text-white hover:bg-lab3-blue"
          >
            Open Squad Planner ↗
          </a>
        )}
      </div>
    )
  }

  // ── Form ─────────────────────────────────────────────────────────────

  const hasSegments = planningBasis === 'capacityProfile'

  function handleSegmentChange(index: number, field: keyof SegmentInput, value: string) {
    const parsed = value === '' ? 0 : Number(value)
    setSegments(prev => {
      const next = prev.map((s, i) => (i === index ? { ...s, [field]: parsed } : s))
      return next
    })
  }

  function addSegment() {
    setSegments(prev => [...prev, emptySegment()])
  }

  function removeSegment(index: number) {
    setSegments(prev => prev.filter((_, i) => i !== index))
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)

    const validationError = validateCapacityProfileDraft({
      planningBasis,
      defaultPercent,
      startWeek,
      endWeek,
      segments,
    }, ownerKind)
    if (validationError) {
      setError(validationError)
      return
    }

    saveMutation.mutate()
  }

  return (
    <form noValidate onSubmit={handleSubmit} className="space-y-4" data-testid="capacity-profile-editor">
      {/* Planning basis */}
      <div>
        <label className="block text-xs font-medium text-gray-600 dark:text-gray-300 mb-1" htmlFor="cp-planning-basis">
          Planning Basis
        </label>
        <select
          id="cp-planning-basis"
          value={planningBasis}
          onChange={e => setPlanningBasis(e.target.value as CapacityProfilePlanningBasis)}
          className="w-full border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-1.5 text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
          data-testid="cp-planning-basis-select"
        >
          {PLANNING_BASIS_OPTIONS.map(opt => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
      </div>

      {/* Non-segment inputs */}
      {!hasSegments && (
        <>
          {/* Default percent */}
          <div>
            <label className="block text-xs font-medium text-gray-600 dark:text-gray-300 mb-1" htmlFor="cp-default-pct">
              Default availability %
            </label>
            <input
              id="cp-default-pct"
              type="number"
              min={0}
              max={ownerKind === 'NAMED_PERSON' ? 100 : undefined}
              step="any"
              value={defaultPercent ?? 100}
              onChange={e => setDefaultPercent(e.target.value === '' ? null : Number(e.target.value))}
              className="w-24 border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-1.5 text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
              data-testid="cp-default-pct-input"
            />
          </div>

          {/* Window inputs for availabilityWindow */}
          {planningBasis === 'availabilityWindow' && (
            <div className="flex gap-4">
              <div>
                <label className="block text-xs font-medium text-gray-600 dark:text-gray-300 mb-1" htmlFor="cp-start-week">
                  Start Week
                </label>
                <input
                  id="cp-start-week"
                  type="number"
                  min={0}
                  step={1}
                  value={startWeek ?? ''}
                  onChange={e => setStartWeek(e.target.value === '' ? null : Number(e.target.value))}
                  placeholder="0"
                  className="w-24 border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-1.5 text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                  data-testid="cp-start-week-input"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 dark:text-gray-300 mb-1" htmlFor="cp-end-week">
                  End Week
                </label>
                <input
                  id="cp-end-week"
                  type="number"
                  min={0}
                  step={1}
                  value={endWeek ?? ''}
                  onChange={e => setEndWeek(e.target.value === '' ? null : Number(e.target.value))}
                  placeholder="0"
                  className="w-24 border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-1.5 text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                  data-testid="cp-end-week-input"
                />
              </div>
            </div>
          )}
        </>
      )}

      {/* Segments table for capacityProfile */}
      {hasSegments && (
        <div data-testid="cp-segments-section">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-medium text-gray-600 dark:text-gray-300">Weekly Segments</span>
            <button
              type="button"
              onClick={addSegment}
              className="text-xs text-lab3-blue hover:text-lab3-navy font-medium"
              data-testid="cp-add-segment"
            >
              + Add segment
            </button>
          </div>
          <div className="space-y-2">
            {segments.map((seg, i) => (
              <div key={i} className="flex items-center gap-2" data-testid={`cp-segment-row-${i}`}>
                <div>
                  <label className="block text-[10px] text-gray-500 dark:text-gray-400">Start Wk</label>
                  <input
                    type="number"
                    min={0}
                    step={1}
                    value={seg.startWeek}
                    onChange={e => handleSegmentChange(i, 'startWeek', e.target.value)}
                    className="w-16 border border-gray-300 dark:border-gray-600 rounded px-2 py-1 text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:outline-none focus:ring-1 focus:ring-blue-500"
                    data-testid={`cp-seg-start-${i}`}
                  />
                </div>
                <div>
                  <label className="block text-[10px] text-gray-500 dark:text-gray-400">End Wk</label>
                  <input
                    type="number"
                    min={0}
                    step={1}
                    value={seg.endWeek}
                    onChange={e => handleSegmentChange(i, 'endWeek', e.target.value)}
                    className="w-16 border border-gray-300 dark:border-gray-600 rounded px-2 py-1 text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:outline-none focus:ring-1 focus:ring-blue-500"
                    data-testid={`cp-seg-end-${i}`}
                  />
                </div>
                <div>
                  <label className="block text-[10px] text-gray-500 dark:text-gray-400">Cap %</label>
                  <input
                    type="number"
                    min={0}
                    max={ownerKind === 'NAMED_PERSON' ? 100 : undefined}
                    value={seg.capacityPercent}
                    step="any"
                    className="w-16 border border-gray-300 dark:border-gray-600 rounded px-2 py-1 text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:outline-none focus:ring-1 focus:ring-blue-500"
                    data-testid={`cp-seg-pct-${i}`}
                    onChange={e => handleSegmentChange(i, 'capacityPercent', e.target.value)}
                  />
                </div>
                <button
                  type="button"
                  onClick={() => removeSegment(i)}
                  disabled={segments.length <= 1}
                  className="mt-4 text-gray-400 dark:text-gray-500 hover:text-red-600 disabled:opacity-30 text-lg leading-none"
                  title="Remove segment"
                  data-testid={`cp-seg-remove-${i}`}
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Error display */}
      {error && (
        <div className="text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950/30 rounded-lg px-3 py-2" role="alert" data-testid="cp-error">
          {error}
        </div>
      )}

      {/* Actions */}
      <div className="flex gap-3 pt-2">
        <button
          type="submit"
          disabled={saveMutation.isPending}
          className="bg-lab3-navy text-white px-4 py-1.5 rounded-lg text-sm font-medium hover:bg-lab3-blue disabled:opacity-50"
          data-testid="cp-save-btn"
        >
          {saveMutation.isPending ? 'Saving…' : 'Save'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="px-4 py-1.5 rounded-lg text-sm text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700"
          data-testid="cp-cancel-btn"
        >
          Cancel
        </button>
      </div>
    </form>
  )
}
