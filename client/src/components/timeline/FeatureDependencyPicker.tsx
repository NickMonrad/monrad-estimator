import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import type { TimelineEntry } from '../../types/backlog'
interface FeatureDependencyPickerProps {
  currentFeatureId: string
  entries: TimelineEntry[]
  featureDependencies: Array<{ featureId: string; dependsOnId: string }>
  onAddDependency: (featureId: string, dependsOnId: string) => void
  onOpen?: () => void
  error?: string | null
  isAdding?: boolean
}

type IndexedTimelineEntry = TimelineEntry & { inputIndex: number }

function compareFeatureOrder(a: IndexedTimelineEntry, b: IndexedTimelineEntry) {
  const featureOrder = (a.featureOrder ?? 0) - (b.featureOrder ?? 0)
  return featureOrder !== 0 ? featureOrder : a.inputIndex - b.inputIndex
}


export default function FeatureDependencyPicker({
  currentFeatureId,
  entries,
  featureDependencies,
  onAddDependency,
  onOpen,
  error = null,
  isAdding = false,
}: FeatureDependencyPickerProps) {
  const [isOpen, setIsOpen] = useState(false)
  const [searchTerm, setSearchTerm] = useState('')
  const [activeIndex, setActiveIndex] = useState(-1)
  const searchRef = useRef<HTMLInputElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const listboxId = `feature-dependency-options-${useId().replace(/:/g, '')}`

  const candidates = useMemo(() => {
    const existingDependencyIds = new Set(
      featureDependencies
        .filter(dependency => dependency.featureId === currentFeatureId)
        .map(dependency => dependency.dependsOnId),
    )

    const indexedCandidates = entries
      .map((entry, inputIndex) => ({ ...entry, inputIndex }))
      .filter(entry => entry.featureId !== currentFeatureId && !existingDependencyIds.has(entry.featureId))

    const groups = new Map<string, {
      epicOrder: number
      firstInputIndex: number
      entries: IndexedTimelineEntry[]
    }>()

    for (const candidate of indexedCandidates) {
      let group = groups.get(candidate.epicId)
      if (!group) {
        group = {
          epicOrder: candidate.epicOrder ?? 0,
          firstInputIndex: candidate.inputIndex,
          entries: [],
        }
        groups.set(candidate.epicId, group)
      }
      group.entries.push(candidate)
    }

    return Array.from(groups.values())
      .sort((a, b) => {
        const epicOrder = a.epicOrder - b.epicOrder
        return epicOrder !== 0 ? epicOrder : a.firstInputIndex - b.firstInputIndex
      })
      .flatMap(group => group.entries.sort(compareFeatureOrder))
  }, [currentFeatureId, entries, featureDependencies])

  const filteredCandidates = useMemo(() => {
    const query = searchTerm.trim().toLowerCase()
    if (!query) return candidates

    return candidates.filter(entry =>
      `${entry.epicName} / ${entry.featureName}`.toLowerCase().includes(query),
    )
  }, [candidates, searchTerm])

  useEffect(() => {
    if (isOpen) searchRef.current?.focus()
  }, [isOpen])


  const close = () => {
    setIsOpen(false)
    setSearchTerm('')
    setActiveIndex(-1)
    triggerRef.current?.focus()
  }

  const open = () => {
    onOpen?.()
    setSearchTerm('')
    setActiveIndex(-1)
    setIsOpen(true)
  }

  const selectCandidate = (dependsOnId: string) => {
    onAddDependency(currentFeatureId, dependsOnId)
    close()
  }

  const handleSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      close()
      return
    }

    if (event.key === 'ArrowDown' && filteredCandidates.length > 0) {
      event.preventDefault()
      setActiveIndex(current => current < filteredCandidates.length - 1 ? current + 1 : 0)
      return
    }

    if (event.key === 'ArrowUp' && filteredCandidates.length > 0) {
      event.preventDefault()
      setActiveIndex(current => current <= 0 ? filteredCandidates.length - 1 : current - 1)
      return
    }

    if (event.key === 'Enter' && activeIndex >= 0 && filteredCandidates[activeIndex]) {
      event.preventDefault()
      selectCandidate(filteredCandidates[activeIndex].featureId)
    }
  }

  const hasCandidates = candidates.length > 0

  return (
    <div className="space-y-1">
      <button
        ref={triggerRef}
        type="button"
        aria-label="Add dependency"
        aria-expanded={isOpen}
        aria-controls={isOpen ? listboxId : undefined}
        disabled={!hasCandidates || isAdding}
        onClick={open}
        className="border border-gray-200 dark:border-gray-600 rounded px-2 py-0.5 text-xs text-gray-700 bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:outline-none focus:ring-1 focus:ring-blue-400 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {isAdding ? 'Adding dependency…' : '+ Add dependency…'}
      </button>

      {!hasCandidates && (
        <p className="text-xs text-gray-400 dark:text-gray-500">No available dependencies</p>
      )}

      {isOpen && (
        <div className="mt-1 w-full max-w-md rounded border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800 p-2 shadow-sm">
          <label htmlFor={`${listboxId}-search`} className="sr-only">Search dependencies</label>
          <input
            id={`${listboxId}-search`}
            ref={searchRef}
            role="combobox"
            aria-label="Search dependencies"
            aria-autocomplete="list"
            aria-controls={listboxId}
            aria-expanded="true"
            aria-activedescendant={activeIndex >= 0 ? `${listboxId}-${filteredCandidates[activeIndex]?.featureId}` : undefined}
            value={searchTerm}
            onChange={event => {
              setSearchTerm(event.target.value)
              setActiveIndex(-1)
            }}
            onKeyDown={handleSearchKeyDown}
            placeholder="Search dependencies…"
            className="w-full border border-gray-200 dark:border-gray-600 rounded px-2 py-1 text-xs bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:outline-none focus:ring-1 focus:ring-blue-400"
          />

          {filteredCandidates.length > 0 ? (
            <div id={listboxId} role="listbox" aria-label="Dependency candidates" className="mt-1 max-h-48 overflow-y-auto">
              {filteredCandidates.map((candidate, index) => {
                const label = `${candidate.epicName} / ${candidate.featureName}`
                return (
                  <div
                    key={candidate.featureId}
                    id={`${listboxId}-${candidate.featureId}`}
                    role="option"
                    aria-selected={activeIndex === index}
                    onMouseEnter={() => setActiveIndex(index)}
                    onMouseDown={event => event.preventDefault()}
                    onClick={() => selectCandidate(candidate.featureId)}
                    className={`cursor-pointer rounded px-2 py-1 text-xs text-gray-700 dark:text-gray-200 ${activeIndex === index ? 'bg-blue-100 dark:bg-blue-900/50' : 'hover:bg-gray-50 dark:hover:bg-gray-700'}`}
                  >
                    {label}
                  </div>
                )
              })}
            </div>
          ) : (
            <p role="status" className="mt-1 px-2 py-1 text-xs text-gray-500 dark:text-gray-400">No matching features</p>
          )}
        </div>
      )}

      {error && <p role="alert" className="text-xs text-red-700 dark:text-red-400">{error}</p>}
    </div>
  )
}
