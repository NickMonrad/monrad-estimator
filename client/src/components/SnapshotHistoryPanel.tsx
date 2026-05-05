import React, { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/api'

interface Snapshot { id: string; label: string | null; trigger: string; createdAt: string }
interface Diff { added: string[]; removed: string[]; snapshotAt: string }

interface SnapshotHistoryPanelProps {
  projectId: string
}

export default function SnapshotHistoryPanel({ projectId }: SnapshotHistoryPanelProps) {
  const queryClient = useQueryClient()
  const [snapshotLabel, setSnapshotLabel] = useState('')
  const [diffId, setDiffId] = useState<string | null>(null)

  const { data: snapshots = [], refetch: refetchSnapshots } = useQuery<Snapshot[]>({
    queryKey: ['snapshots', projectId],
    queryFn: () => api.get(`/projects/${projectId}/snapshots`).then(r => r.data),
  })

  const { data: diffData } = useQuery<Diff>({
    queryKey: ['snapshot-diff', projectId, diffId],
    queryFn: () => api.get(`/projects/${projectId}/snapshots/${diffId}/diff`).then(r => r.data),
    enabled: !!diffId,
  })

  const saveSnapshot = useMutation({
    mutationFn: (label: string) => api.post(`/projects/${projectId}/snapshots`, { label }),
    onSuccess: () => { setSnapshotLabel(''); refetchSnapshots() },
  })

  const rollback = useMutation({
    mutationFn: (snapshotId: string) => api.post(`/projects/${projectId}/snapshots/${snapshotId}/rollback`, {}),
    onSuccess: () => { queryClient.invalidateQueries(); refetchSnapshots() },
  })

  return (
    <div className="mt-6 bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-5">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-sm font-semibold text-gray-800 dark:text-gray-100">Snapshot History</h2>
        <div className="flex gap-2">
          <input
            placeholder="Snapshot label (optional)"
            value={snapshotLabel}
            onChange={e => setSnapshotLabel(e.target.value)}
            className="border border-gray-200 dark:border-gray-600 rounded px-2 py-1 text-xs bg-white dark:bg-gray-700 text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-400 focus:outline-none focus:ring-1 focus:ring-lab3-blue w-48"
          />
          <button
            onClick={() => saveSnapshot.mutate(snapshotLabel)}
            disabled={saveSnapshot.isPending}
            className="bg-lab3-navy text-white px-3 py-1 rounded text-xs font-medium hover:bg-lab3-blue disabled:opacity-50">
            {saveSnapshot.isPending ? 'Saving…' : 'Save snapshot'}
          </button>
        </div>
      </div>
      {snapshots.length === 0 ? (
        <p className="text-sm text-gray-400 dark:text-gray-500 text-center py-4">No snapshots yet</p>
      ) : (
        <table className="w-full text-xs">
          <thead>
            <tr className="text-gray-400 dark:text-gray-500 border-b border-gray-100 dark:border-gray-700">
              <th className="text-left pb-2 font-medium">Label</th>
              <th className="text-left pb-2 font-medium">Trigger</th>
              <th className="text-left pb-2 font-medium">Saved</th>
              <th className="pb-2"></th>
            </tr>
          </thead>
          <tbody>
            {snapshots.map(snap => (
              <React.Fragment key={snap.id}>
                <tr className="border-b border-gray-50 dark:border-gray-700 last:border-0">
                  <td className="py-2 pr-4 text-gray-700 dark:text-gray-300">{snap.label ?? <span className="text-gray-400 dark:text-gray-500 italic">unlabelled</span>}</td>
                  <td className="py-2 pr-4"><span className="bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400 px-1.5 py-0.5 rounded">{snap.trigger}</span></td>
                  <td className="py-2 pr-4 text-gray-500 dark:text-gray-400">{new Date(snap.createdAt).toLocaleString()}</td>
                  <td className="py-2">
                    <div className="flex gap-2">
                      <button onClick={() => setDiffId(d => d === snap.id ? null : snap.id)} className="text-blue-500 hover:text-blue-700">
                        {diffId === snap.id ? 'Hide diff' : 'Diff'}
                      </button>
                      <button
                        onClick={() => { if (confirm('Roll back to this snapshot? Current state will be auto-saved first.')) rollback.mutate(snap.id) }}
                        disabled={rollback.isPending}
                        className="text-red-500 hover:text-red-700 disabled:opacity-50">
                        Rollback
                      </button>
                    </div>
                  </td>
                </tr>
                {diffId === snap.id && diffData && (
                  <tr key={`diff-${snap.id}`}>
                    <td colSpan={4} className="pb-3 pt-1">
                      <div className="bg-gray-50 dark:bg-gray-700 rounded-lg p-3 text-xs font-mono space-y-1">
                        <p className="text-gray-500 dark:text-gray-400 mb-2">Comparing snapshot ({new Date(diffData.snapshotAt).toLocaleString()}) to current:</p>
                        {diffData.added.map((line, i) => <div key={i} className="text-green-700 dark:text-green-400">+ {line}</div>)}
                        {diffData.removed.map((line, i) => <div key={i} className="text-red-600 dark:text-red-400">- {line}</div>)}
                        {diffData.added.length === 0 && diffData.removed.length === 0 && (
                          <div className="text-gray-400 dark:text-gray-500">No differences</div>
                        )}
                      </div>
                    </td>
                  </tr>
                )}
              </React.Fragment>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
