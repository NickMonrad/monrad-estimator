// Shared epic colour palette — used in BacklogPage and GanttChart
// Each entry provides Tailwind classes for bars, backgrounds, borders, and text,
// plus hex values for SVG rendering in the Gantt chart.
export interface EpicColour {
  bar: string        // Tailwind: bar/badge background  e.g. 'bg-blue-400'
  light: string      // Tailwind: very light background  e.g. 'bg-blue-50'
  lighter: string    // Tailwind: even lighter (stories)  e.g. 'bg-blue-50/50'
  darkLight: string  // Tailwind dark mode equivalent    e.g. 'dark:bg-blue-950'
  darkLighter: string // Tailwind dark mode lighter      e.g. 'dark:bg-blue-950/60'
  border: string     // Tailwind: left border colour      e.g. 'border-blue-400'
  text: string       // Tailwind: text colour             e.g. 'text-blue-700'
  darkText: string   // Tailwind dark mode text           e.g. 'dark:text-blue-300'
  hex: string        // Hex for SVG fill                  e.g. '#60a5fa'
  hexLight: string   // Hex for SVG light background      e.g. '#eff6ff'
}

export const EPIC_COLOURS: EpicColour[] = [
  { bar: 'bg-blue-400',   light: 'bg-blue-50',   lighter: 'bg-blue-50/50',   darkLight: 'dark:bg-blue-950',   darkLighter: 'dark:bg-blue-950/60',   border: 'border-blue-400',   text: 'text-blue-700',   darkText: 'dark:text-blue-300',   hex: '#60a5fa', hexLight: '#eff6ff' },
  { bar: 'bg-purple-400', light: 'bg-purple-50', lighter: 'bg-purple-50/50', darkLight: 'dark:bg-purple-950', darkLighter: 'dark:bg-purple-950/60', border: 'border-purple-400', text: 'text-purple-700', darkText: 'dark:text-purple-300', hex: '#c084fc', hexLight: '#faf5ff' },
  { bar: 'bg-green-400',  light: 'bg-green-50',  lighter: 'bg-green-50/50',  darkLight: 'dark:bg-green-950',  darkLighter: 'dark:bg-green-950/60',  border: 'border-green-400',  text: 'text-green-700',  darkText: 'dark:text-green-300',  hex: '#4ade80', hexLight: '#f0fdf4' },
  { bar: 'bg-orange-400', light: 'bg-orange-50', lighter: 'bg-orange-50/50', darkLight: 'dark:bg-orange-950', darkLighter: 'dark:bg-orange-950/60', border: 'border-orange-400', text: 'text-orange-700', darkText: 'dark:text-orange-300', hex: '#fb923c', hexLight: '#fff7ed' },
  { bar: 'bg-pink-400',   light: 'bg-pink-50',   lighter: 'bg-pink-50/50',   darkLight: 'dark:bg-pink-950',   darkLighter: 'dark:bg-pink-950/60',   border: 'border-pink-400',   text: 'text-pink-700',   darkText: 'dark:text-pink-300',   hex: '#f472b6', hexLight: '#fdf2f8' },
  { bar: 'bg-teal-400',   light: 'bg-teal-50',   lighter: 'bg-teal-50/50',   darkLight: 'dark:bg-teal-950',   darkLighter: 'dark:bg-teal-950/60',   border: 'border-teal-400',   text: 'text-teal-700',   darkText: 'dark:text-teal-300',   hex: '#2dd4bf', hexLight: '#f0fdfa' },
  { bar: 'bg-indigo-400', light: 'bg-indigo-50', lighter: 'bg-indigo-50/50', darkLight: 'dark:bg-indigo-950', darkLighter: 'dark:bg-indigo-950/60', border: 'border-indigo-400', text: 'text-indigo-700', darkText: 'dark:text-indigo-300', hex: '#818cf8', hexLight: '#eef2ff' },
  { bar: 'bg-rose-400',   light: 'bg-rose-50',   lighter: 'bg-rose-50/50',   darkLight: 'dark:bg-rose-950',   darkLighter: 'dark:bg-rose-950/60',   border: 'border-rose-400',   text: 'text-rose-700',   darkText: 'dark:text-rose-300',   hex: '#fb7185', hexLight: '#fff1f2' },
]

export function getEpicColour(epicIndex: number): EpicColour {
  return EPIC_COLOURS[epicIndex % EPIC_COLOURS.length]
}
