import React, { useMemo } from 'react'

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------
interface WeeklyDemandItem {
  week: number
  resourceTypeName: string
  demandDays: number
  capacityDays: number
}

interface Props {
  weeklyDemand: WeeklyDemandItem[]
  totalWeeks: number
  colW: number
  labelW: number
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
  totalWeeks,
  colW,
  labelW,
  scrollContainerRef,
  onScroll,
}: Props) {
  // Derive unique resource types and their max demand/capacity
  const resourceTypes = useMemo(() => {
    const map = new Map<string, { maxDemand: number; capacityDays: number }>()
    for (const item of weeklyDemand) {
      const existing = map.get(item.resourceTypeName)
      if (!existing) {
        map.set(item.resourceTypeName, { maxDemand: item.demandDays, capacityDays: item.capacityDays })
      } else {
        if (item.demandDays > existing.maxDemand) existing.maxDemand = item.demandDays
        // capacityDays is constant per resource type — take max for safety
        if (item.capacityDays > existing.capacityDays) existing.capacityDays = item.capacityDays
      }
    }
    return Array.from(map.entries()).map(([name, { maxDemand, capacityDays }]) => ({
      name,
      maxDemand,
      capacityDays,
    })).sort((a, b) => a.name.localeCompare(b.name))
  }, [weeklyDemand])

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
    <div className="border-t border-gray-200 flex overflow-hidden">
      {/* Left label panel — sticky */}
      <div
        style={{ width: labelW, flexShrink: 0 }}
        className="relative bg-white border-r border-gray-100 z-10"
      >
        {/* Header */}
        <div
          style={{ height: HEADER_H }}
          className="border-b border-gray-100 flex items-center px-3"
        >
          <span className="text-xs font-medium text-gray-500">Resource Demand</span>
        </div>

        {/* Resource type rows */}
        {resourceTypes.map(rt => {
          const engLabel = `${rt.maxDemand.toFixed(1)}d max / ${rt.capacityDays}d cap`
          return (
            <div
              key={rt.name}
              style={{ height: ROW_H }}
              className="border-b border-gray-50 flex flex-col justify-center px-3"
            >
              <span className="text-xs font-medium text-gray-700 truncate">{rt.name}</span>
              <span className="text-xs text-gray-400 mt-0.5">{engLabel}</span>
            </div>
          )
        })}
      </div>

      {/* Right SVG area — shares scroll with Gantt via ref */}
      <div
        className="overflow-x-auto flex-1"
        ref={scrollContainerRef}
        onScroll={onScroll}
      >
        <svg
          width={svgW}
          height={totalH}
          style={{ display: 'block' }}
        >
          {/* Background */}
          <rect x={0} y={0} width={svgW} height={totalH} fill="#fafafa" style={{ pointerEvents: 'none' }} />

          {/* Column grid lines */}
          {Array.from({ length: totalWeeks + 1 }).map((_, i) => (
            <line
              key={i}
              x1={i * colW}
              y1={0}
              x2={i * colW}
              y2={totalH}
              stroke="#f3f4f6"
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
                fill="#9ca3af"
              >
                W{i}
              </text>
            )
          })}

          {/* Resource type rows */}
          {resourceTypes.map((rt, rowIdx) => {
            const rowY = HEADER_H + rowIdx * ROW_H
            const capacityDays = rt.capacityDays
            // Scale: capacity maps to BAR_MAX_H pixels, but cap bar height at BAR_MAX_H
            // Even if demand > capacity, bar height capped at BAR_MAX_H + overflow indicator
            const scale = capacityDays > 0 ? BAR_MAX_H / capacityDays : 1
            // Capacity line Y (relative to row bottom)
            const capacityLineY = rowY + ROW_H - 6 - BAR_MAX_H

            return (
              <g key={rt.name}>
                {/* Row separator */}
                <line
                  x1={0}
                  y1={rowY + ROW_H}
                  x2={svgW}
                  y2={rowY + ROW_H}
                  stroke="#f3f4f6"
                  strokeWidth={1}
                />

                {/* Capacity dotted line */}
                <line
                  x1={0}
                  y1={capacityLineY}
                  x2={svgW}
                  y2={capacityLineY}
                  stroke="#9ca3af"
                  strokeWidth={1}
                  strokeDasharray="4 3"
                  opacity={0.6}
                />

                {/* Weekly bars */}
                {Array.from({ length: totalWeeks }).map((_, w) => {
                  const demand = demandLookup.get(`${w}|${rt.name}`) ?? 0
                  if (demand <= 0) return null

                  const barH = Math.min(demand * scale, BAR_MAX_H + 6) // allow slight overflow for over-cap
                  const barX = w * colW + 4
                  const barW = colW - 8
                  const barY = rowY + ROW_H - 6 - barH
                  const fill = barColour(demand, capacityDays)

                  return (
                    <g key={w}>
                      <title>{`W${w}: ${demand.toFixed(1)}d demand / ${capacityDays}d capacity`}</title>
                      <rect
                        x={barX}
                        y={barY}
                        width={barW}
                        height={barH}
                        fill={fill}
                        rx={2}
                        opacity={0.8}
                      />
                    </g>
                  )
                })}
              </g>
            )
          })}
        </svg>
      </div>
    </div>
  )
}
