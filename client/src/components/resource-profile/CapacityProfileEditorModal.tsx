/**
 * CapacityProfileEditorModal.tsx — Simple modal wrapper around
 * CapacityProfileEditor.
 *
 * @see issue #363 — Capacity profile segment editor
 */

import { useEffect, useRef } from 'react'
import CapacityProfileEditor, {
  type CapacityProfileEditorProps,
} from './CapacityProfileEditor'

export interface CapacityProfileEditorModalProps extends CapacityProfileEditorProps {
  isOpen: boolean
  onClose: () => void
  isPersisted?: boolean
}

export default function CapacityProfileEditorModal({
  isOpen,
  onClose,
  isPersisted,
  ...editorProps
}: CapacityProfileEditorModalProps) {
  const overlayRef = useRef<HTMLDivElement>(null)

  // Close on Escape
  useEffect(() => {
    if (!isOpen) return
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [isOpen, onClose])

  if (!isOpen) return null

  return (
    <div
      ref={overlayRef}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={e => {
        if (e.target === overlayRef.current) onClose()
      }}
      role="dialog"
      aria-modal="true"
      aria-label="Edit capacity profile"
    >
      <div className="bg-white dark:bg-gray-800 rounded-xl shadow-xl border border-gray-200 dark:border-gray-700 w-full max-w-lg mx-4 max-h-[90vh] overflow-y-auto p-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-base font-semibold text-gray-900 dark:text-white">
            {isPersisted ?? Boolean(editorProps.initialProfile) ? 'Edit' : 'Create'} Capacity Profile
          </h3>
          <button
            onClick={onClose}
            className="text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 text-lg leading-none"
            aria-label="Close"
          >
            ✕
          </button>
        </div>
        <CapacityProfileEditor
          {...editorProps}
          onSaved={() => {
            editorProps.onSaved()
            onClose()
          }}
          onCancel={onClose}
        />
      </div>
    </div>
  )
}
