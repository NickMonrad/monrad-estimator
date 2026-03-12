import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../../lib/api'

interface TemplateTask { name: string; resourceTypeName: string; hoursMedium: number }
interface Snapshot {
  id: string
  label: string | null
  trigger: string
  createdAt: string
  snapshot: { name: string; tasks: TemplateTask[] }
}

interface Props {
  templateId: string
  templateName: string
  onRestored: () => void
}

const triggerLabel: Record<string, string> = {
  manual: 'Manual snapshot',
  csv_import: 'Before CSV import',
  manual_edit: 'Before edit / restore',
}

export default function TemplateHistoryPanel({ templateId, templateName, onRestored }: Props) {
  const qc = useQueryClient()
  const [labelInput, setLabelInput] = useState('')
  const [expanded, setExpanded] = useState<string | null>(null)

  const { data: snapshots = [], isLoading } = useQuery<Snapshot[]>({
    queryKey: ['template-snapshots', templateId],
    queryFn: () => api.get(`/templates/${templateId}/snapshots`).then(r => r.data),
  })

  const createSnapshot = useMutation({
    mutationFn: (label: string) => api.post(`/templates/${templateId}/snapshots`, { label: label || null }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['template-snapshots', templateId] })
      setLabelInput('')
    },
  })

  const restore = useMutation({
    mutationFn: (snapshotId: string) => api.post(`/templates/${templateId}/snapshots/${snapshotId}/restore`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['templates'] })
      qc.invalidateQueries({ queryKey: ['template-snapshots', templateId] })
      onRestored()
    },
  })

  return (
    <div className="border-t dark:border-gray-700 pt-4 mt-4">
      <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-3">History — {templateName}</h3>

      {/* Manual snapshot */}
      <div className="flex gap-2 mb-4">
        <input
          type="text"
          placeholder="Snapshot label (optional)"
          value={labelInput}
          onChange={e => setLabelInput(e.target.value)}
          className="flex-1 border border-gray-300 dark:border-gray-600 rounded px-2 py-1 text-xs bg-white dark:bg-gray-700 text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-400 focus:outline-none focus:ring-1 focus:ring-lab3-blue"
        />
        <button
          onClick={() => createSnapshot.mutate(labelInput)}
          disabled={createSnapshot.isPending}
          className="bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 text-xs px-3 py-1 rounded hover:bg-gray-200 dark:hover:bg-gray-600 disabled:opacity-50 whitespace-nowrap"
        >
          {createSnapshot.isPending ? 'Saving…' : '📷 Save snapshot'}
        </button>
      </div>

      {/* Snapshot list */}
      {isLoading ? (
        <p className="text-xs text-gray-400 dark:text-gray-500">Loading…</p>
      ) : snapshots.length === 0 ? (
        <p className="text-xs text-gray-400 dark:text-gray-500">No snapshots yet.</p>
      ) : (
        <div className="space-y-2 max-h-72 overflow-y-auto">
          {snapshots.map(snap => (
            <div key={snap.id} className="border border-gray-200 dark:border-gray-700 rounded-lg text-xs">
              <div className="flex items-center justify-between px-3 py-2 bg-gray-50 dark:bg-gray-700 rounded-t-lg">
                <div>
                  <span className="font-medium text-gray-700 dark:text-gray-300">{snap.label ?? triggerLabel[snap.trigger] ?? snap.trigger}</span>
                  <span className="ml-2 text-gray-400 dark:text-gray-500">{new Date(snap.createdAt).toLocaleString()}</span>
                  <span className="ml-2 text-gray-400 dark:text-gray-500">· {snap.snapshot?.tasks?.length ?? 0} tasks</span>
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={() => setExpanded(expanded === snap.id ? null : snap.id)}
                    className="text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300"
                  >
                    {expanded === snap.id ? '▲' : '▼'}
                  </button>
                  <button
                    onClick={() => { if (window.confirm(`Restore "${snap.label ?? 'this snapshot'}"? Current state will be auto-saved first.`)) restore.mutate(snap.id) }}
                    disabled={restore.isPending}
                    className="text-lab3-blue hover:text-lab3-navy font-medium disabled:opacity-50"
                  >
                    Restore
                  </button>
                </div>
              </div>
              {expanded === snap.id && (
                <div className="px-3 py-2 bg-white dark:bg-gray-800 rounded-b-lg border-t border-gray-100 dark:border-gray-700">
                  {snap.snapshot?.tasks?.length === 0 ? (
                    <p className="text-gray-400 dark:text-gray-500 italic">No tasks in this snapshot</p>
                  ) : (
                    <table className="w-full">
                      <thead>
                        <tr className="text-gray-500 dark:text-gray-400">
                          <th className="text-left font-medium pb-1">Task</th>
                          <th className="text-left font-medium pb-1">Resource</th>
                          <th className="text-right font-medium pb-1">M hrs</th>
                        </tr>
                      </thead>
                      <tbody>
                        {snap.snapshot?.tasks?.map((t, i) => (
                          <tr key={i} className="text-gray-600 dark:text-gray-400">
                            <td className="py-0.5">{t.name}</td>
                            <td className="py-0.5">{t.resourceTypeName}</td>
                            <td className="py-0.5 text-right">{t.hoursMedium}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
