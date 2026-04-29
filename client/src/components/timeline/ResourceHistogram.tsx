import React, { useMemo, useState } from 'react'
import { useIsDark } from '../../hooks/useIsDark'
import TimelineTooltip from './TimelineTooltip'

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------
interface WeeklyDemandItem {
  week: number
  resourceTypeName: string
  demandDays: number
  capacityDays: number
}

interface WeeklyCapacityItem {
  week: number
  resourceTypeName: string
  capacityDays: number
}

interface Props {
  weeklyDemand: WeeklyDemandItem[]
  weeklyCapacity?: WeeklyCapacityItem[]
  totalWeeks: number
  colW: number
  labelW: number
  weekOffset?: number
  scrollContainerRef?: React.RefObject<HTMLDivElement | null>
  onScroll?: React.UIEventHandler<HTMLDivElement>
}

// ---------------------------------------------------------------------------
// Layout constants (must match GanttChart)
// ---------------------------------------------------------------------------
const ROW_H = 60
const BAR_MAX_H = 48
const HEADER_H = 24

// ---------------------------------------------------------------------------
// Colour helpers
// ---------------------------------------------------------------------------
function barColour(demand: number, capacity: number): string {
  if (capacity <= 0) return '#6b7280'
  const ratio = demand / capacity
  if (ratio > 1) return '#dc2626'       // red — over capacity
  if (ratio >= 0.75) return '#d97706'   // amber — 75–100%
  return '#16a34a'                      // green — healthy
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------
export default function ResourceHistogram({
  weeklyDemand,
  weeklyCapacity,
  totalWeeks,
  colW,
  labelW,
  weekOffset = 0,
  scrollContainerRef,
  onScroll,
}: Props) {

  const isDark = useIsDark()

  // Tooltip state
  const [tooltip, setTooltip] = useState<{ x: number; y: number; content: string } | null>(null)
  

  const svgColors = {
    bg:       isDark ? '#111827' : '#fafafa',
    gridLine: isDark ? '#374151' : '#f3f4f6',
    text:     isDark ? '#6b7280' : '#9ca3af',
    capLine:  isDark ? '#6b7280' : '#9ca3af',
  }

  // Build capacity lookup: week|rtName → capacityDays
  const capacityLookup = useMemo(() => {
    const m = new Map<string, number>()
    if (weeklyCapacity) {
      for (const item of weeklyCapacity) {
        m.set(`${item.week}|${item.resourceTypeName}`, item.capacityDays)
      }
    }
    return m
  }, [weeklyCapacity])

  // Derive unique resource types and their max demand + max capacity across weeks
  const resourceTypes = useMemo(() => {
    const map = new Map<string, { maxDemand: number; maxCapacity: number; totalDays: number }>()
    for (const item of weeklyDemand) {
      const existing = map.get(item.resourceTypeName)
      if (!existing) {
        map.set(item.resourceTypeName, { maxDemand: item.demandDays, maxCapacity: 0, totalDays: item.demandDays })
      } else {
        if (item.demandDays > existing.maxDemand) existing.maxDemand = item.demandDays
        existing.totalDays += item.demandDays
      }
    }
    // Incorporate weeklyCapacity maximums
    if (weeklyCapacity) {
      for (const item of weeklyCapacity) {
        const existing = map.get(item.resourceTypeName)
        if (existing) {
          if (item.capacityDays > existing.maxCapacity) existing.maxCapacity = item.capacityDays
        } else {
          map.set(item.resourceTypeName, { maxDemand: 0, maxCapacity: item.capacityDays, totalDays: 0 })
        }
      }
    }
    return Array.from(map.entries()).map(([name, { maxDemand, maxCapacity, totalDays }]) => ({
      name,
      maxDemand,
      maxCapacity,
      totalDays,
      // Scale reference is the greater of maxDemand and maxCapacity
      scaleRef: Math.max(maxDemand, maxCapacity, 0.1),
    }))
    .filter(rt => rt.totalDays > 0 || rt.maxCapacity > 0)
    .sort((a, b) => a.name.localeCompare(b.name))
  }, [weeklyDemand, weeklyCapacity])

  // Build lookup: week+name → demandDays
  const demandLookup = useMemo(() => {
    const m = new Map<string, number>()
    for (const item of weeklyDemand) {
      m.set(`${item.week}|${item.resourceTypeName}`, item.demandDays)
    }
    return m
  }, [weeklyDemand])

  if (resourceTypes.length === 0) return null

  const totalH = HEADER_H + resourceTypes.length * ROW_H
  const svgW = totalWeeks * colW

  return (
    <div className="border-t border-gray-200 dark:border-gray-700 flex overflow-hidden">
      {/* Left label panel — sticky */}
      <div
        style={{ width: labelW, flexShrink: 0 }}
        className="relative bg-white dark:bg-gray-800 border-r border-gray-100 dark:border-gray-700 z-10"
      >
        {/* Header */}
        <div
          style={{ height: HEADER_H }}
          className="border-b border-gray-100 dark:border-gray-700 flex items-center px-3"
        >
          <span className="text-xs font-medium text-gray-500 dark:text-gray-400">Resource Demand</span>
        </div>

        {/* Resource type rows */}
        {resourceTypes.map(rt => {
          const avgCap = rt.maxCapacity > 0 ? `≤${rt.maxCapacity.toFixed(1)}d/w cap` : 'no cap'
          const engLabel = `${rt.totalDays.toFixed(1)}d total · ${avgCap}`
          return (
            <div
              key={rt.name}
              style={{ height: ROW_H }}
              className="border-b border-gray-50 dark:border-gray-700 flex flex-col justify-center px-3"
            >
              <span className="text-xs font-medium text-gray-700 dark:text-gray-300 truncate">{rt.name}</span>
              <span className="text-xs text-gray-400 dark:text-gray-500 mt-0.5">{engLabel}</span>
            </div>
          )
        })}
      </div>

      {/* Right SVG area — shares scroll with Gantt via ref */}
      <div
        className="overflow-x-auto flex-1"
        ref={scrollContainerRef}
        onMouseLeave={() => setTooltip(null)}
        style={{ position: 'relative' }}
        onScroll={onScroll}
      >
        <svg
          width={svgW}
          height={totalH}
          style={{ display: 'block' }}
        >
          {/* Background */}
          <rect x={0} y={0} width={svgW} height={totalH} fill={svgColors.bg} style={{ pointerEvents: 'none' }} />

          {/* Column grid lines */}
          {Array.from({ length: totalWeeks + 1 }).map((_, i) => (
            <line
              key={i}
              x1={i * colW}
              y1={0}
              x2={i * colW}
              y2={totalH}
              stroke={svgColors.gridLine}
              strokeWidth={1}
            />
          ))}

          {/* Header: week numbers every 4 weeks */}
          {Array.from({ length: totalWeeks }).map((_, i) => {
            if (i % 4 !== 0) return null
            return (
              <text
                key={i}
                x={i * colW + colW / 2}
                y={HEADER_H - 6}
                textAnchor="middle"
                fontSize={9}
                fill={svgColors.text}
              >
                W{i + 1}
              </text>
            )
          })}

          {/* Resource type rows */}
          {resourceTypes.map((rt, rowIdx) => {
            const rowY = HEADER_H + rowIdx * ROW_H
            const scale = BAR_MAX_H / rt.scaleRef

            return (
              <g key={rt.name}>
                {/* Row separator */}
                <line
                  x1={0}
                  y1={rowY + ROW_H}
                  x2={svgW}
                  y2={rowY + ROW_H}
                  stroke={svgColors.gridLine}
                  strokeWidth={1}
                />

                {/* Per-week capacity dotted line (variable) */}
                {Array.from({ length: totalWeeks }).map((_, w) => {
                  const capKey = `${w}|${rt.name}`
                  const cap = capacityLookup.get(capKey)
                  if (cap == null || cap <= 0) return null
                  const capY = rowY + ROW_H - 6 - Math.min(cap * scale, BAR_MAX_H)
                  // Draw a horizontal dotted segment for this week
                  return (
                    <line
                      key={`cap-${w}`}
                      x1={(w + weekOffset) * colW}
                      y1={capY}
                      x2={(w + weekOffset + 1) * colW}
                      y2={capY}
                      stroke={svgColors.capLine}
                      strokeWidth={1}
                      strokeDasharray="4 3"
                      opacity={0.6}
                    />
                  )
                })}

                {/* Weekly bars */}
                {Array.from({ length: totalWeeks }).map((_, w) => {
                  const demand = demandLookup.get(`${w}|${rt.name}`) ?? 0
                  if (demand <= 0) return null

                  const cap = capacityLookup.get(`${w}|${rt.name}`) ?? 0
                  const barH = Math.min(demand * scale, BAR_MAX_H + 6)
                  const inset = Math.min(4, Math.max(1, Math.floor(colW / 4)))
                  const barX = (w + weekOffset) * colW + inset
                  const barW = Math.max(1, colW - inset * 2)
                  const barY = rowY + ROW_H - 6 - barH
                  const fill = barColour(demand, cap)

                  return (
                    <g key={w}>
                      <rect
                        x={barX}
                        y={barY}
                        width={barW}
                        height={barH}
                        fill={fill}
                        rx={2}
                        opacity={0.8}
                        style={{ cursor: 'default' }}
                        onMouseEnter={(e) => {
                          const pct = cap > 0 ? ` (${Math.round((demand / cap) * 100)}%)` : ''
                          setTooltip({
                            x: e.clientX,
                            y: e.clientY,
                            content: `Week ${w} · ${rt.name}: ${demand.toFixed(1)} / ${cap.toFixed(1)} days${pct}`,
                          })
                        }}
                        onMouseMove={(e) => {
                          setTooltip(prev => prev ? { ...prev, x: e.clientX, y: e.clientY } : prev)
                        }}
                        onMouseLeave={() => setTooltip(null)}
                      />
                    </g>
                  )
                })}
              </g>
            )
          })}
        </svg>
      </div>
      <TimelineTooltip
        x={tooltip?.x ?? 0}
        y={tooltip?.y ?? 0}
        visible={tooltip !== null}
        content={tooltip?.content ?? ''}
      />
    </div>
  )
}
