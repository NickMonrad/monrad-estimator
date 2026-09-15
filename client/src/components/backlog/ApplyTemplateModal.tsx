import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { ComplexityPicker, TemplateSelect } from './TemplateFields'
import { useFeatureTemplates, type Complexity } from '../../lib/featureTemplates'

interface Props {
  featureId: string
  projectId: string
  onClose: () => void
}

export default function ApplyTemplateModal({ featureId, projectId, onClose }: Props) {
  const qc = useQueryClient()
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>('')
  const [complexity, setComplexity] = useState<Complexity>('MEDIUM')
  const [storyName, setStoryName] = useState<string>('')

  const { data: templates = [] } = useFeatureTemplates()

  const apply = useMutation({
    mutationFn: () => api.post(`/features/${featureId}/apply-template`, {
      templateId: selectedTemplateId,
      complexity,
      storyName: storyName.trim() || undefined,
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['backlog', projectId] })
      onClose()
    },
  })

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50" onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-xl w-full max-w-md p-6">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">Apply template</h2>

        <div className="space-y-4">
          <div>
            <label className="text-sm font-medium text-gray-700 dark:text-gray-300 block mb-1">Template</label>
            <TemplateSelect
              templates={templates}
              value={selectedTemplateId}
              onChange={setSelectedTemplateId}
            />
          </div>

          {selectedTemplateId && (
            <div>
              <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">
                {templates.find(t => t.id === selectedTemplateId)?.tasks.length ?? 0} tasks will be created
              </p>
            </div>
          )}

          <div>
            <label className="text-sm font-medium text-gray-700 dark:text-gray-300 block mb-2">Complexity</label>
            <ComplexityPicker value={complexity} onChange={setComplexity} />
          </div>

          {selectedTemplateId && (
            <div>
              <label className="text-sm font-medium text-gray-700 dark:text-gray-300 block mb-1">Story name</label>
              <input
                type="text"
                value={storyName}
                onChange={e => setStoryName(e.target.value)}
                placeholder="Enter story name…"
                className="w-full border border-gray-200 dark:border-gray-600 rounded-lg px-3 py-2 text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-lab3-blue"
              />
            </div>
          )}
        </div>

        <div className="flex gap-2 mt-6">
          <button
            onClick={() => apply.mutate()}
            disabled={!selectedTemplateId || !storyName.trim() || apply.isPending}
            className="flex-1 bg-lab3-navy text-white py-2 rounded-lg text-sm font-medium hover:bg-lab3-blue disabled:opacity-50 transition-colors"
          >
            {apply.isPending ? 'Applying…' : 'Apply template'}
          </button>
          <button onClick={onClose} className="px-4 py-2 rounded-lg text-sm text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700">
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}
