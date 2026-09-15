import { useState } from 'react'
import { api, apiErrorMessage } from '../../lib/api'
import { ComplexityPicker, TemplateSelect } from './TemplateFields'
import { useFeatureTemplates, type Complexity } from '../../lib/featureTemplates'

interface Props {
  epicId: string
  onClose: () => void
  /**
   * Called once after the workflow settles, so project data refreshes a single
   * time. A non-null id means the Feature and its template Story/Tasks were
   * created; `null` means the caller should stay on the error the dialog shows.
   */
  onSettled: (createdFeatureId: string | null) => void
}

/**
 * Issue #295 — create a Feature together with the Story and Tasks generated
 * from a template, instead of creating an empty Feature first and applying the
 * template to it afterwards.
 *
 * The template semantics stay owned by `POST /api/features/:featureId/apply-template`;
 * this flow only orchestrates the two existing endpoints.
 */
export default function AddFeatureFromTemplateModal({ epicId, onClose, onSettled }: Props) {
  const { data: templates = [] } = useFeatureTemplates()
  const [featureName, setFeatureName] = useState('')
  const [selectedTemplateId, setSelectedTemplateId] = useState('')
  const [complexity, setComplexity] = useState<Complexity>('MEDIUM')
  const [storyName, setStoryName] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const canSubmit = Boolean(featureName.trim() && selectedTemplateId && storyName.trim()) && !pending

  const submit = async () => {
    setPending(true)
    setError(null)

    let featureId: string
    try {
      const created = await api.post(`/epics/${epicId}/features`, { name: featureName.trim() })
      featureId = created.data.id
    } catch (createError) {
      setPending(false)
      setError(apiErrorMessage(createError, 'Failed to create feature'))
      return
    }

    try {
      await api.post(`/features/${featureId}/apply-template`, {
        templateId: selectedTemplateId,
        complexity,
        storyName: storyName.trim(),
      })
    } catch (applyError) {
      const message = apiErrorMessage(applyError, 'Failed to apply template')
      // Best effort: a failed apply must not strand the empty Feature it created.
      const removed = await api
        .delete(`/epics/${epicId}/features/${featureId}`)
        .then(() => true, () => false)
      setPending(false)
      setError(removed ? message : `${message} The empty feature could not be removed.`)
      onSettled(null)
      return
    }

    onSettled(featureId)
  }

  return (
    <div
      className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4"
      onClick={e => { if (e.target === e.currentTarget && !pending) onClose() }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-from-template-heading"
        className="bg-white dark:bg-gray-800 rounded-2xl shadow-xl w-full max-w-md p-6"
      >
        <div className="flex items-start justify-between gap-4 mb-4">
          <h2 id="add-from-template-heading" className="text-lg font-semibold text-gray-900 dark:text-white">
            Add feature from template
          </h2>
          <button
            onClick={onClose}
            disabled={pending}
            aria-label="Close add feature from template"
            className="text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 text-xl leading-none disabled:opacity-40"
          >
            ✕
          </button>
        </div>

        <p className="text-xs text-gray-500 dark:text-gray-400 mb-4">
          Creates the feature, a story built from the template, and one task per template task.
        </p>

        <div className="space-y-4">
          <div>
            <label htmlFor="add-from-template-feature-name" className="text-sm font-medium text-gray-700 dark:text-gray-300 block mb-1">
              Feature name
            </label>
            <input
              id="add-from-template-feature-name"
              type="text"
              value={featureName}
              disabled={pending}
              onChange={e => setFeatureName(e.target.value)}
              placeholder="Feature name *"
              className="w-full border border-gray-200 dark:border-gray-600 rounded-lg px-3 py-2 text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-lab3-blue disabled:opacity-50"
            />
          </div>

          <div>
            <label htmlFor="add-from-template-template" className="text-sm font-medium text-gray-700 dark:text-gray-300 block mb-1">
              Template
            </label>
            <TemplateSelect
              id="add-from-template-template"
              templates={templates}
              value={selectedTemplateId}
              onChange={setSelectedTemplateId}
              disabled={pending}
            />
          </div>

          {selectedTemplateId && (
            <p className="text-xs text-gray-500 dark:text-gray-400">
              {templates.find(t => t.id === selectedTemplateId)?.tasks.length ?? 0} tasks will be created
            </p>
          )}

          <div>
            <span className="text-sm font-medium text-gray-700 dark:text-gray-300 block mb-2">Complexity</span>
            <ComplexityPicker value={complexity} onChange={setComplexity} disabled={pending} />
          </div>

          <div>
            <label htmlFor="add-from-template-story-name" className="text-sm font-medium text-gray-700 dark:text-gray-300 block mb-1">
              Story name
            </label>
            <input
              id="add-from-template-story-name"
              type="text"
              value={storyName}
              disabled={pending}
              onChange={e => setStoryName(e.target.value)}
              placeholder="Enter story name…"
              className="w-full border border-gray-200 dark:border-gray-600 rounded-lg px-3 py-2 text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-lab3-blue disabled:opacity-50"
            />
          </div>

          {error && (
            <div role="alert" className="rounded-lg border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/40 px-3 py-2 text-sm text-red-700 dark:text-red-300">
              {error}
            </div>
          )}
        </div>

        <div className="flex gap-2 mt-6">
          <button
            onClick={submit}
            disabled={!canSubmit}
            className="flex-1 bg-lab3-navy text-white py-2 rounded-lg text-sm font-medium hover:bg-lab3-blue disabled:opacity-50 transition-colors"
          >
            {pending ? 'Creating…' : 'Create feature'}
          </button>
          <button
            onClick={onClose}
            disabled={pending}
            className="px-4 py-2 rounded-lg text-sm text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 disabled:opacity-40"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}
