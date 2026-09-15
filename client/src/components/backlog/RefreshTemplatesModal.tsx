import { useState } from 'react'
import { api, apiErrorMessage } from '../../lib/api'

/** A template-backed Story targeted by the project-level refresh (issue #237). */
export interface TemplateRefreshTarget {
  featureId: string
  storyId: string
  storyName: string
  featureName: string
  epicName: string
  /** The story's recorded template complexity, or null for pre-existing stories. */
  complexity: string | null
}

const COMPLEXITY_OPTIONS = [
  { value: 'EXTRA_SMALL', label: 'XS' },
  { value: 'SMALL', label: 'S' },
  { value: 'MEDIUM', label: 'M' },
  { value: 'LARGE', label: 'L' },
  { value: 'EXTRA_LARGE', label: 'XL' },
] as const

const COMPLEXITY_LABEL: Record<string, string> = Object.fromEntries(
  COMPLEXITY_OPTIONS.map(option => [option.value, option.label]),
)

interface Props {
  targets: TemplateRefreshTarget[]
  onClose: () => void
  /** Called once after the batch settles so project data refreshes a single time. */
  onCompleted: () => void
}

export default function RefreshTemplatesModal({ targets, onClose, onCompleted }: Props) {
  const [selections, setSelections] = useState<Record<string, string>>({})
  const [pending, setPending] = useState(false)
  const [result, setResult] = useState<{
    refreshed: number
    failures: Array<{ name: string; message: string }>
  } | null>(null)

  const missingComplexity = targets.filter(t => !t.complexity && !selections[t.storyId])
  const canStart = !pending && targets.length > 0 && missingComplexity.length === 0

  /**
   * Refresh every target through the existing single-story endpoint, one story
   * at a time. A failure keeps the remaining stories going and is reported.
   */
  const refreshAll = async () => {
    setPending(true)
    setResult(null)
    const failures: Array<{ name: string; message: string }> = []
    let refreshed = 0

    for (const target of targets) {
      const complexity = target.complexity ?? selections[target.storyId]
      try {
        await api.post(`/features/${target.featureId}/refresh-template/${target.storyId}`, { complexity })
        refreshed++
      } catch (error) {
        failures.push({ name: target.storyName, message: apiErrorMessage(error, 'Refresh failed') })
      }
    }

    setPending(false)
    setResult({ refreshed, failures })
    onCompleted()
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="refresh-templates-heading"
        className="bg-white dark:bg-gray-800 rounded-2xl shadow-xl w-full max-w-2xl max-h-[85vh] flex flex-col"
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100 dark:border-gray-700">
          <h2 id="refresh-templates-heading" className="text-lg font-semibold text-gray-900 dark:text-white">
            Refresh templates
          </h2>
          <button
            onClick={onClose}
            disabled={pending}
            aria-label="Close refresh templates"
            className="text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 text-xl disabled:opacity-40"
          >
            ✕
          </button>
        </div>

        <div className="flex-1 overflow-auto px-6 py-4 space-y-4">
          <p className="text-sm text-gray-700 dark:text-gray-300">
            {targets.length} template-backed {targets.length === 1 ? 'story' : 'stories'} will be refreshed from
            {targets.length === 1 ? ' its' : ' their'} templates.
          </p>

          <ul className="text-sm text-gray-500 dark:text-gray-400 list-disc pl-5 space-y-1">
            <li>Story description and assumptions are refreshed from the current template.</li>
            <li>Template-owned task descriptions, estimates and resource assignments are updated.</li>
            <li>Each story refreshes at its own recorded complexity.</li>
            <li>Tasks that are not in the template are kept.</li>
          </ul>

          {missingComplexity.length > 0 && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 dark:border-amber-900 dark:bg-amber-950/40 px-3 py-2 text-sm text-amber-800 dark:text-amber-200">
              {missingComplexity.length} template-backed {missingComplexity.length === 1 ? 'story has' : 'stories have'} no
              recorded complexity. Choose one for each before refreshing — the complexity is never guessed.
            </div>
          )}

          <ul className="divide-y divide-gray-100 dark:divide-gray-700 border border-gray-200 dark:border-gray-700 rounded-lg">
            {targets.map(target => (
              <li key={target.storyId} className="flex items-center justify-between gap-3 px-3 py-2">
                <div className="min-w-0">
                  <p className="text-sm text-gray-800 dark:text-gray-200 truncate">{target.storyName}</p>
                  <p className="text-xs text-gray-400 dark:text-gray-500 truncate">
                    {target.epicName} › {target.featureName}
                  </p>
                </div>
                {target.complexity ? (
                  <span className="text-xs font-medium text-gray-500 dark:text-gray-400 bg-gray-100 dark:bg-gray-700 px-2 py-0.5 rounded">
                    {COMPLEXITY_LABEL[target.complexity] ?? target.complexity}
                  </span>
                ) : (
                  <select
                    aria-label={`Complexity for ${target.storyName}`}
                    value={selections[target.storyId] ?? ''}
                    disabled={pending}
                    onChange={e => setSelections(prev => ({ ...prev, [target.storyId]: e.target.value }))}
                    className="border border-gray-200 dark:border-gray-600 rounded px-2 py-1 text-xs bg-white dark:bg-gray-700 text-gray-900 dark:text-white disabled:opacity-50"
                  >
                    <option value="">Select…</option>
                    {COMPLEXITY_OPTIONS.map(option => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                )}
              </li>
            ))}
          </ul>

          {result && (
            <div
              role="status"
              aria-live="polite"
              className={result.failures.length > 0
                ? 'rounded-lg border border-red-200 bg-red-50 dark:border-red-900 dark:bg-red-950/40 px-3 py-2 text-sm text-red-700 dark:text-red-300'
                : 'rounded-lg border border-green-200 bg-green-50 dark:border-green-900 dark:bg-green-950/40 px-3 py-2 text-sm text-green-700 dark:text-green-300'}
            >
              <p className="font-medium">
                Refreshed {result.refreshed} of {targets.length} {targets.length === 1 ? 'story' : 'stories'}.
              </p>
              {result.failures.length > 0 && (
                <>
                  <p className="mt-1">
                    {result.failures.length} {result.failures.length === 1 ? 'story' : 'stories'} could not be refreshed:
                  </p>
                  <ul className="list-disc pl-5 mt-1 space-y-0.5 text-xs">
                    {result.failures.map(failure => (
                      <li key={failure.name}>{failure.name} — {failure.message}</li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          )}
        </div>

        <div className="px-6 py-4 border-t border-gray-100 dark:border-gray-700 flex items-center justify-between gap-3">
          <p className="text-xs text-gray-400 dark:text-gray-500">
            {missingComplexity.length > 0
              ? `Choose a complexity for ${missingComplexity.length} ${missingComplexity.length === 1 ? 'story' : 'stories'} to continue.`
              : 'Stories refresh one at a time.'}
          </p>
          <div className="flex gap-2">
            <button
              onClick={onClose}
              disabled={pending}
              className="px-3 py-2 text-sm text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 disabled:opacity-40"
            >
              Cancel
            </button>
            <button
              onClick={refreshAll}
              disabled={!canStart}
              className="bg-lab3-navy text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-lab3-blue disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              {pending ? 'Refreshing…' : `Refresh ${targets.length} ${targets.length === 1 ? 'story' : 'stories'}`}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
