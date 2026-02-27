import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../../lib/api'

interface TemplateTask {
  id: string
  name: string
  hoursSmall: number
  hoursMedium: number
  hoursLarge: number
  hoursExtraLarge: number
  resourceTypeName: string
}

interface FeatureTemplate {
  id: string
  name: string
  category: string | null
  description: string | null
  tasks: TemplateTask[]
}

type Complexity = 'SMALL' | 'MEDIUM' | 'LARGE' | 'EXTRA_LARGE'

const COMPLEXITY_LABELS: Record<Complexity, string> = {
  SMALL: 'S',
  MEDIUM: 'M',
  LARGE: 'L',
  EXTRA_LARGE: 'XL',
}

interface Props {
  featureId: string
  projectId: string
  onClose: () => void
}

export default function ApplyTemplateModal({ featureId, projectId, onClose }: Props) {
  const qc = useQueryClient()
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>('')
  const [complexity, setComplexity] = useState<Complexity>('MEDIUM')

  const { data: templates = [] } = useQuery<FeatureTemplate[]>({
    queryKey: ['templates'],
    queryFn: () => api.get('/templates').then(r => r.data),
  })

  const apply = useMutation({
    mutationFn: () => api.post(`/features/${featureId}/apply-template`, {
      templateId: selectedTemplateId,
      complexity,
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['backlog', projectId] })
      onClose()
    },
  })

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50" onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-md p-6">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">Apply template</h2>

        <div className="space-y-4">
          <div>
            <label className="text-sm font-medium text-gray-700 block mb-1">Template</label>
            <select
              value={selectedTemplateId}
              onChange={e => setSelectedTemplateId(e.target.value)}
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-red-400"
            >
              <option value="">Select a template…</option>
              {templates.map(tpl => (
                <option key={tpl.id} value={tpl.id}>
                  {tpl.name}{tpl.category ? ` (${tpl.category})` : ''}
                </option>
              ))}
            </select>
          </div>

          {selectedTemplateId && (
            <div>
              <p className="text-xs text-gray-500 mb-2">
                {templates.find(t => t.id === selectedTemplateId)?.tasks.length ?? 0} tasks will be created
              </p>
            </div>
          )}

          <div>
            <label className="text-sm font-medium text-gray-700 block mb-2">Complexity</label>
            <div className="flex gap-2">
              {(Object.keys(COMPLEXITY_LABELS) as Complexity[]).map(c => (
                <button
                  key={c}
                  onClick={() => setComplexity(c)}
                  className={`flex-1 py-2 rounded-lg text-sm font-medium transition-colors ${
                    complexity === c
                      ? 'bg-red-600 text-white'
                      : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                  }`}
                >
                  {COMPLEXITY_LABELS[c]}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="flex gap-2 mt-6">
          <button
            onClick={() => apply.mutate()}
            disabled={!selectedTemplateId || apply.isPending}
            className="flex-1 bg-red-600 text-white py-2 rounded-lg text-sm font-medium hover:bg-red-700 disabled:opacity-50 transition-colors"
          >
            {apply.isPending ? 'Applying…' : 'Apply template'}
          </button>
          <button onClick={onClose} className="px-4 py-2 rounded-lg text-sm text-gray-500 hover:bg-gray-100">
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}
