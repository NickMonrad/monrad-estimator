import React from 'react'

interface TimelineTooltipProps {
  x: number
  y: number
  visible: boolean
  content: string | React.ReactNode
}

/**
 * Dark-pill custom tooltip — same style used in GanttChart.
 * Renders fixed-positioned near the cursor; caller provides x/y from
 * mousemove clientX/clientY.
 */
export default function TimelineTooltip({ x, y, visible, content }: TimelineTooltipProps) {
  if (!visible) return null
  return (
    <div
      className="fixed z-50 pointer-events-none bg-gray-900 dark:bg-gray-700 text-white rounded-lg shadow-xl px-3 py-2 text-sm whitespace-pre-wrap break-words max-w-xs"
      style={{ left: x + 12, top: y + 12 }}
    >
      {content}
    </div>
  )
}
